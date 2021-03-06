/*
 Squidwarc  Copyright (C) 2017-present  John Berlin <n0tan3rd@gmail.com>

 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.

 Squidwarc is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU General Public License for more details.

 You should have received a copy of the GNU General Public License
 along with this Squidwarc.  If not, see <http://www.gnu.org/licenses/>
 */
const EventEmitter = require('eventemitter3')
const { Browser } = require('puppeteer/lib/Browser')
const { TimeoutError } = require('puppeteer/lib/Errors')
const autobind = require('class-autobind')
const PuppeteerCDPRequestCapturer = require('../../node-warc/lib/requestCapturers/puppeteerCDP')
const PuppeteerCDPWARCGenerator = require('../../node-warc/lib/writers/puppeteerCDP')
const InjectManager = require('../injectManager')
const launch = require('../launcher/puppeteer')
const NetIdle = require('./netIdleWatcher')
const cp = require('../utils/colorPrinters')
const { configureURLNormalizer } = require('../utils/urlUtils')

/**
 * @desc Function for normalizing URLs
 * @type {(function(string): string)}
 */
const urlNormalizer = configureURLNormalizer({ stripFragment: true, stripWWW: true })

/**
 * @desc Crawler based on puppeteer
 * @extends {EventEmitter}
 */
class PuppeteerCrawler extends EventEmitter {
  /**
   * @desc Create a new PuppeteerCrawler instance. For a description of the expected options see the
   * JSDoc CrawlConfig typedef {@link CrawlConfig}
   * @param {CrawlConfig} options - The crawl config for this crawl
   */
  constructor (options) {
    super()

    /**
     * @desc An instance of puppeteer Browser
     * @type {?Browser}
     */
    this._browser = null

    /**
     * @desc An instance of puppeteer Page
     * @type {?Page}
     */
    this._page = null

    /**
     * @desc An instance of puppeteer CDPSession used to
     * @type {CDPSession}
     * @private
     */
    this._client = null

    /**
     * @desc The UserAgent string of the browser
     * @type {string}
     * @private
     */
    this._ua = ''

    /**
     * @desc The current url the crawler is visiting
     * @type {?string}
     */
    this._currentUrl = null

    /**
     * @desc Crawl configuration options
     * @type {CrawlConfig}
     */
    this.options = options

    /**
     * @type {?PuppeteerCDPRequestCapturer}
     */
    this.requestCapturer = null

    /**
     * @type {PuppeteerCDPWARCGenerator}
     * @private
     */
    this._warcGenerator = new PuppeteerCDPWARCGenerator()

    /**
     * @desc Default wait time for page.goto
     * @type {{waitUntil: string, timeout: number}}
     */
    this.defaultWait = { waitUntil: 'networkidle0', timeout: 60000 }
    autobind.default(this, PuppeteerCrawler.prototype)
  }

  /**
   * @desc CB used to emit the disconnected event
   * @private
   */
  _onDisconnected () {
    this.emit('disconnected')
  }

  /**
   * @desc Setup the crawler
   */
  async init () {
    this._browser = await launch(this.options.chrome)
    this._browser.on(Browser.Events.Disconnected, this._onDisconnected)
    this._page = await this._browser.newPage()
    this._client = this._page._client

    await this._client.send('Animation.setPlaybackRate', { playbackRate: 1000 })
    await this._client.send('Network.setBypassServiceWorker', { bypass: true })
    await this._client.send(
      'Page.addScriptToEvaluateOnNewDocument',
      InjectManager.getNoNaughtyJsInject()
    )
    // so much noise
    this._client.removeAllListeners('Performance.metrics')
    this._client.removeAllListeners('Log.entryAdded')
    this._client.removeAllListeners('Runtime.consoleAPICalled')
    this._client.removeAllListeners('Runtime.exceptionThrown')

    this.requestCapturer = new PuppeteerCDPRequestCapturer()
    this.requestCapturer.attach(this._client)
    this._warcGenerator.on('finished', this._onWARCGenFinished)
    this._warcGenerator.on('error', this._onWARCGenError)
    this._ua = await this.getUserAgent()
  }

  /**
   * @desc Navigate the browser to the URL of the page to be crawled
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  async navigate (url) {
    this._currentUrl = url
    this.requestCapturer.startCapturing()
    try {
      await this._page.goto(url, this.defaultWait)
    } catch (e) {
      if (e instanceof TimeoutError) {
        const mainFrame = this._page.mainFrame()
        if (
          urlNormalizer(url) ===
          urlNormalizer(mainFrame._navigationURL || mainFrame.url())
        ) {
          // we did navigate to the page but no all frame network idle was had in the waiting time
          return true
        }
      }
      cp.error('Crawler encountered a navigation error', e)
      return false
    }
    return true
  }

  /**
   * @desc If the user supplied a script that scrip is executed or if non was supplied just scroll the page
   * @return {Promise<void>}
   */
  async runUserScript () {
    if (this.options.script) {
      cp.cyan(`Running user script`)
      try {
        await this.options.script(this._page)
      } catch (e) {
        cp.error('An exception was thrown while running the user script', e)
      }
    } else {
      await this._page.evaluate(InjectManager.rawScoll())
    }
    await NetIdle.idlePromise(this._page, this.options.crawlControl)
  }

  /**
   * @desc Equivalent to hitting the refresh button when it is an X
   * @return {!Promise<?Object>}
   */
  stopPageLoading () {
    return this._client.send('Page.stopLoading')
  }

  /**
   * @desc Stop capturing the current web pages network requests
   */
  stopCapturingNetwork () {
    this.requestCapturer.stopCapturing()
  }

  /**
   * @desc Stop the page loading and stop capturing requests
   * @return {!Promise<?Object>}
   */
  stop () {
    this.requestCapturer.stopCapturing()
    return this._client.send('Page.stopLoading')
  }

  /**
   * @desc Stop crawling and exit
   * @return {Promise<void>}
   */
  async shutdown () {
    this.requestCapturer.stopCapturing()
    await this._browser.close()
  }

  /**
   * @desc Initialize the WARC writter for writting a new WARC
   * @param {string} warcPath           - the path to the new WARC
   * @param {boolean} [appending=false] - append to an already existing WARC file
   * @return {Promise<void>} A Promise that resolves once the `warc-gen-finished` event is emitted
   */
  initWARC (warcPath, appending = false) {
    this._warcGenerator.initWARC(warcPath, appending)
    return new Promise(resolve => {
      this.on('warc-gen-finished', resolve)
    })
  }

  /**
   * @desc Alias for {@link genWarc}
   * @param {Object} warcInfo    - WARC record information
   * @property {!string} outlinks - Pre-formatted string containing the pages outlinks tobe used by the WARC metadata record
   * @property {?Object} info     - Information for the WARC info record
   * @return {Promise<void, Error>}
   */
  genWARC (warcInfo) {
    return this.genWarc(warcInfo)
  }

  /**
   * @desc Generate the WARC file
   * @param {Object} warcInfo          - WARC record information
   * @property {!string} outlinks - Pre-formatted string containing the pages outlinks tobe used by the WARC metadata record
   * @property {?Object} info     - Information for the WARC info record
   * @return {Promise<void, Error>}
   */
  async genWarc ({ outlinks, info }) {
    info = info || {}
    info.isPartOfV = info.isPartOfV || this.options.versionInfo.isPartOfV
    info.warcInfoDescription =
      info.warcInfoDescription || this.options.versionInfo.warcInfoDescription
    await this._warcGenerator.writeWarcInfoRecord(
      info.isPartOfV,
      info.warcInfoDescription,
      this._ua
    )
    await this._warcGenerator.writeWarcMetadataOutlinks(this._currentUrl, outlinks)
    this.requestCapturer.stopCapturing()
    for (let nreq of this.requestCapturer.iterateRequests()) {
      try {
        await this._warcGenerator.generateWarcEntry(nreq, this._client)
      } catch (error) {
        console.error(error)
      }
    }
    this._warcGenerator.end()
  }

  /**
   * @desc Generate the WARC Info and Metadata records
   * @param {Object} warcInfo    - WARC record information
   * @property {!string} outlinks - Pre-formatted string containing the pages outlinks tobe used by the WARC metadata record
   * @property {?Object} info     - Information for the WARC info record
   * @return {!Promise<void>}
   */
  async genInfoMetaDataRecord ({ info, outlinks }) {
    info = info || {}
    info.v = info.v || this.options.versionInfo.v
    info.isPartOfV = info.isPartOfV || this.options.versionInfo.isPartOfV
    info.warcInfoDescription =
      info.warcInfoDescription || this.options.versionInfo.warcInfoDescription
    await this._warcGenerator.writeWarcInfoRecord(
      info.isPartOfV,
      info.warcInfoDescription,
      this._ua
    )
    await this._warcGenerator.writeWarcMetadataOutlinks(this._currentUrl, outlinks)
  }

  /**
   * @desc Retrieve the page's meta information
   * @return {Promise<{outlinks: string, links: Array<{href: string, pathname: string, host: string}>, location: string}, Error>}
   */
  async getOutLinks () {
    const frames = this._page.frames()
    let i = frames.length
    let frame
    const discoveredLinks = {
      outlinks: '',
      links: [],
      location: this._page.url()
    }
    const outlinksFN = InjectManager.rawOutLinks()
    while (i--) {
      frame = frames[i]
      try {
        const { outlinks, links } = await frame.evaluate(outlinksFN)
        discoveredLinks.outlinks += outlinks
        discoveredLinks.links = discoveredLinks.links.concat(links)
      } catch (e) {}
    }
    return discoveredLinks
  }

  /**
   * @desc Retrieve the browsers user-agent string
   * @return {!Promise<string>}
   */
  async getUserAgent () {
    let ua = await this._browser.userAgent()
    if (ua.indexOf('HeadlessChrome/') !== -1) {
      // We are not a robot, pinkie promise!
      ua = ua.replace('HeadlessChrome/', 'Chrome/')
      await this._page.setUserAgent(ua)
    }
    return ua
  }

  /**
   * @desc Iterate over the captured network requests for the current web page
   * @return {Iterator<CapturedRequest>}
   */
  [Symbol.iterator] () {
    return this.requestCapturer.values()
  }

  /**
   * @desc Listener for warc generator error
   * @param {Error} err - The error to emit
   * @private
   */
  _onWARCGenError (err) {
    this.emit('error', { type: 'warc-gen', err })
  }

  /**
   * @desc Listener for warc generator finished
   * @private
   */
  _onWARCGenFinished () {
    this.emit('warc-gen-finished')
  }
}

/**
 * @type {PuppeteerCrawler}
 */
module.exports = PuppeteerCrawler
