import * as puppeteer from 'puppeteer';
import { IChromeServiceConfiguration } from './models/browserless-options.interface';
import { debug } from './utils';
import { ResourceMonitor } from './hardware-monitoring';
import { NodeVM } from 'vm2';
import { BrowserlessServer } from './browserless-server';
import * as _ from 'lodash';

const queue = require('queue');
const oneMinute = 60 * 1000


export class ChromeService {
  private config: IChromeServiceConfiguration;
  private chromeSwarm: Promise<puppeteer.Browser>[];
  private queue: any;
  private readonly resourceMonitor: ResourceMonitor;
  readonly server: BrowserlessServer;

  get queueSize() {
    return this.queue.length;
  }

  get queueConcurrency() {
    return this.queue.concurrency;
  }

  constructor(config: IChromeServiceConfiguration, server: BrowserlessServer, resourceMonitor: ResourceMonitor) {
    this.config = config;
    this.server = server;
    this.resourceMonitor = resourceMonitor;
    this.queue = queue({
      concurrency: this.config.maxConcurrentSessions,
      timeout: this.config.connectionTimeout,
      autostart: true
    });

    this.queue.on('success', this.onSessionComplete.bind(this));
    this.queue.on('error', this.onSessionFail.bind(this));
    this.queue.on('timeout', this.onTimedOut.bind(this));

    this.chromeSwarm = [];
    if (this.config.prebootChrome) {
      for (let i = 0; i < this.config.maxConcurrentSessions; i++) {
        this.chromeSwarm.push(this.launchChrome());
      }

      debug(`Prebooted chrome swarm: ${this.config.maxConcurrentSessions} chrome instances are ready`);
    }

    setTimeout(this.refreshChromeSwarm, this.config.chromeRefreshTime);
  }

  public getChrome(flags?: any): Promise<puppeteer.Browser> {
    const canUseChromeSwarm = !flags.length && !!this.chromeSwarm.length;
    const launchPromise = canUseChromeSwarm ? this.chromeSwarm.shift() : this.launchChrome(flags);

    return launchPromise as Promise<puppeteer.Browser>;
  }

  public addJob(job: any) {
    this.queue.push(job);
  }

  public autoUpdateQueue() {
    if (this.config.autoQueue && (this.queue.length < this.queue.concurrency)) {
      const isMachineStrained = this.resourceMonitor.isMachinedConstrained;
      this.queue.concurrency = isMachineStrained ? this.queue.length : this.config.maxConcurrentSessions;
    }
  }

  private refreshChromeSwarm(retries: number = 0) {
    if (retries > this.config.maxChromeRefreshRetries) {
      // forces refresh after max retries
      this.chromeSwarm.forEach(chromeInstance => this.refreshChromeInstance(chromeInstance));
    }

    if (this.queue.length > this.chromeSwarm.length) {
      // tries to refresh later if more jobs than there are available chromes
      setTimeout(this.refreshChromeSwarm(retries + 1), oneMinute);
    }

    this.chromeSwarm.forEach(chromeInstance => this.refreshChromeInstance(chromeInstance));

    // will refresh again in 30min
    setTimeout(this.refreshChromeSwarm, this.config.chromeRefreshTime);
  }

  private async refreshChromeInstance(instance: Promise<puppeteer.Browser>) {
    const chrome = await instance;
    chrome.close();

    if (this.config.keepAlive && (this.chromeSwarm.length >= this.config.maxConcurrentSessions)) {
      this.chromeSwarm.push(this.launchChrome());
    }
  }

  private addToChromeSwarm() {
    if (this.config.prebootChrome && (this.chromeSwarm.length < this.queue.concurrency)) {
      this.chromeSwarm.push(this.launchChrome());
      debug(`Added Chrome instance to swarm, ${this.chromeSwarm.length} online`);
    }
  }

  public onSessionComplete() {
    this.server.currentStat.successful++;
    this.addToChromeSwarm();
  }

  public onSessionFail() {
    this.server.currentStat.error++;
    this.addToChromeSwarm();
  }

  public onTimedOut(next, job) {
    debug(`Timeout hit for session, closing. ${this.queue.length} in queue.`);
    job.close('HTTP/1.1 408 Request has timed out\r\n');
    this.server.currentStat.timedout = this.server.currentStat.timedout + 1;
    this.server.timeoutHook();
    this.onSessionComplete();
    next();
  }

  public onQueued(req) {
    debug(`${req.url}: Concurrency limit hit, queueing`);
    this.server.currentStat.queued = this.server.currentStat.queued + 1;
    this.server.queueHook();
  }

  private async launchChrome(flags:string[] = [], retries:number = 1): Promise<puppeteer.Browser> {
    const start = Date.now();
    debug('Chrome Starting');
    return puppeteer.launch({
      args: flags.concat(['--no-sandbox', '--disable-dev-shm-usage']),
    })
      .then((chrome) => {
        debug(`Chrome launched ${Date.now() - start}ms`);
        return chrome;
      })
      .catch((error) => {

        if (retries > 0) {
          const nextRetries = retries - 1;
          console.error(error, `Issue launching Chrome, retrying ${retries} times.`);
          return this.launchChrome(flags, nextRetries);
        }

        console.error(error, `Issue launching Chrome, retries exhausted.`);
        throw error;
      });
  }

  public async reuseChromeInstance(instance: puppeteer.Browser) {
    const openPages = await instance.pages();
    openPages.forEach(page => page.close());
    this.chromeSwarm.push(Promise.resolve(instance));
  }

  public async runFunction({ code, context, req, res }) {
    const queueLength = this.queue.length;
    const isMachineStrained = this.resourceMonitor.isMachinedConstrained;

    if (queueLength >= this.config.maxQueueLength) {
      return this.server.rejectReq(req, res, `Too Many Requests`);
    }

    if (this.config.autoQueue && (this.queue.length < this.queue.concurrency)) {
      this.queue.concurrency = isMachineStrained ? this.queue.length : this.config.maxConcurrentSessions;
    }

    if (queueLength >= this.queue.concurrency) {
      this.onQueued(req);
    }

    const vm = new NodeVM();
    const handler: (any) => Promise<any> = vm.run(code);

    debug(`${req.url}: Inbound function execution: ${JSON.stringify({ code, context })}`);

    const job: any = async () => {
      const launchPromise = this.chromeSwarm.length > 0 ? 
      this.chromeSwarm.shift() :
      this.launchChrome();

      const browser = await launchPromise as puppeteer.Browser;
      const page = await browser.newPage();

      job.browser = browser;

      return handler({ page, context })
        .then(({ data, type }) => {
          debug(`${req.url}: Function complete, cleaning up.`);

          this.config.keepAlive ? 
            _.attempt(() => { page.close(); this.chromeSwarm.push(Promise.resolve(browser)) }) : 
            _.attempt(() => browser.close());
          

          res.type(type || 'text/plain');

          if (Buffer.isBuffer(data)) {
            return res.end(data, 'binary');
          }

          if (type.includes('json')) {
            return res.json(data);
          }

          return res.send(data);
        })
        .catch((error) => {
          res.status(500).send(error.message);
          debug(`${req.url}: Function errored, stopping Chrome`);
          _.attempt(() => browser.close());
        });
    };

    job.close = () => {
      if (job.browser) {
        this.config.keepAlive ? this.reuseChromeInstance(job.browser) : job.browser.close();
      }

      if (!res.headersSent) {
        res.status(408).send('browserless function has timed-out');
      }
    };

    req.on('close', () => {
      debug(`${req.url}: Request has terminated, cleaning up.`);
      if (job.browser) {
        this.config.keepAlive ? this.reuseChromeInstance(job.browser) : job.browser.close();
      }
    });

    this.queue.push(job);
  }
}