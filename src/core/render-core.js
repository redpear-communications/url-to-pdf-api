const puppeteer = require('puppeteer');
const _ = require('lodash');
const config = require('../config');
const logger = require('../util/logger')(__filename);

async function createBrowser(opts) {
  const browserOpts = {
    acceptInsecureCerts: opts.ignoreHttpsErrors,
    slowMo: config.DEBUG_MODE ? 250 : undefined,
  };
  if (config.BROWSER_WS_ENDPOINT) {
    browserOpts.browserWSEndpoint = config.BROWSER_WS_ENDPOINT;
    return puppeteer.connect(browserOpts);
  }
  if (config.BROWSER_EXECUTABLE_PATH) {
    browserOpts.executablePath = config.BROWSER_EXECUTABLE_PATH;
  }
  browserOpts.headless = !config.DEBUG_MODE;
  browserOpts.args = ['--no-sandbox', '--disable-setuid-sandbox'];
  if (!opts.enableGPU) {
    browserOpts.args.push('--disable-gpu');
  }
  return puppeteer.launch(browserOpts);
}

async function getFullPageHeight(page) {
  const height = await page.evaluate(() => {
    const { body, documentElement } = document;
    return Math.max(
      body.scrollHeight,
      body.offsetHeight,
      documentElement.clientHeight,
      documentElement.scrollHeight,
      documentElement.offsetHeight,
    );
  });
  return height;
}

async function waitForStylesAndFonts(page, timeoutMs = 10000) {
  await page.evaluate(async (maxWaitMs) => {
    const waitWithTimeout = (promise) => Promise.race([
      promise,
      new Promise((resolve) => {
        setTimeout(resolve, maxWaitMs);
      }),
    ]);

    const stylesheetLinks = Array.from(
      document.querySelectorAll('link[rel="stylesheet"]'),
    );

    await waitWithTimeout(
      Promise.all(
        stylesheetLinks.map((linkEl) => {
          if (linkEl.sheet) {
            return Promise.resolve();
          }

          return new Promise((resolve) => {
            linkEl.addEventListener('load', resolve, { once: true });
            linkEl.addEventListener('error', resolve, { once: true });
          });
        }),
      ),
    );

    if (document.fonts && document.fonts.ready) {
      await waitWithTimeout(document.fonts.ready.catch(() => null));
    }
  }, timeoutMs);
}

async function render(_opts = {}) {
  const opts = _.merge(
    {
      cookies: [],
      scrollPage: false,
      emulateScreenMedia: true,
      ignoreHttpsErrors: false,
      html: null,
      viewport: {
        width: 1600,
        height: 1200,
      },
      goto: {
        waitUntil: 'networkidle0',
        timeout: 60000,
      },
      setContent: {
        waitUntil: 'networkidle2',
        timeout: 60000,
      },
      output: 'pdf',
      pdf: {
        format: 'A4',
        printBackground: true,
      },
      screenshot: {
        type: 'png',
        fullPage: true,
      },
      failEarly: false,
    },
    _opts,
  );

  if (
    (_.get(_opts, 'pdf.width') && _.get(_opts, 'pdf.height'))
    || _.get(opts, 'pdf.fullPage')
  ) {
    // pdf.format always overrides width and height, so we must delete it
    // when user explicitly wants to set width and height
    opts.pdf.format = undefined;
  }

  logOpts(opts);

  const browser = await createBrowser(opts);
  const page = await browser.newPage();

  page.on('console', (msg) => logger.info(`PAGE LOG: ${msg.text()}`));

  page.on('error', (err) => {
    logger.error(`Error event emitted: ${err}`);
    logger.error(err.stack);
    browser.close();
  });

  const failedResponses = [];
  let mainUrlResponse = null;

  page.on('requestfailed', (request) => {
    failedResponses.push(request);
    if (request.url() === opts.url) {
      mainUrlResponse = request;
    }
  });

  page.on('response', (response) => {
    if (response.status() >= 400) {
      failedResponses.push(response);
    }

    if (response.url() === opts.url) {
      mainUrlResponse = response;
    }
  });

  let data;
  try {
    logger.info('Set browser viewport..');
    await page.setViewport(opts.viewport);
    if (opts.emulateScreenMedia) {
      logger.info('Emulate @media screen..');
      await page.emulateMediaType('screen');
    }

    if (opts.cookies && opts.cookies.length > 0) {
      logger.info('Setting cookies..');
      await browser.setCookie(...opts.cookies);
    }

    if (_.isString(opts.html)) {
      logger.info('Set HTML ..');
      try {
        await page.setContent(opts.html, opts.setContent);
      } catch (err) {
        if (
          err.name === 'TimeoutError'
          && opts.setContent
          && opts.setContent.waitUntil !== 'domcontentloaded'
        ) {
          logger.warn('setContent timed out. Retrying with domcontentloaded.');
          const fallbackSetContentOpts = _.merge({}, opts.setContent, {
            waitUntil: 'domcontentloaded',
          });
          await page.setContent(opts.html, fallbackSetContentOpts);
        } else {
          throw err;
        }
      }

      await waitForStylesAndFonts(
        page,
        Math.min(_.get(opts, 'setContent.timeout', 10000), 15000),
      );
    } else {
      logger.info(`Goto url ${opts.url} ..`);
      await page.goto(opts.url, opts.goto);
    }

    if (_.isNumber(opts.waitFor)) {
      logger.info(`Wait for ${opts.waitFor} ms ..`);
      await new Promise((resolve) => setTimeout(resolve, opts.waitFor));
    } else if (_.isString(opts.waitFor)) {
      logger.info(`Wait for selector ${opts.waitFor} ..`);
      await page.waitForSelector(opts.waitFor);
    }

    if (opts.scrollPage) {
      logger.info('Scroll page ..');
      await scrollPage(page);
    }

    if (failedResponses.length) {
      logger.warn(`Number of failed requests: ${failedResponses.length}`);
      failedResponses.forEach((response) => {
        const url = typeof response.url === 'function' ? response.url() : response.url;
        const status = typeof response.status === 'function' ? response.status() : 'N/A';
        logger.warn(`${status} ${url}`);
      });

      if (opts.failEarly === 'all') {
        const err = new Error(
          `${failedResponses.length} requests have failed. See server log for more details.`,
        );
        err.status = 412;
        throw err;
      }
    }
    if (opts.failEarly === 'page' && mainUrlResponse) {
      const mainStatus = typeof mainUrlResponse.status === 'function'
        ? mainUrlResponse.status()
        : mainUrlResponse.status;
      if (mainStatus !== 200) {
        const msg = `Request for ${opts.url} did not directly succeed and returned status ${mainStatus}`;
        const err = new Error(msg);
        err.status = 412;
        throw err;
      }
    }

    logger.info('Rendering ..');
    if (config.DEBUG_MODE) {
      const msg = `\n\n---------------------------------\n
        Chrome does not support rendering in "headed" mode.
        See this issue: https://github.com/GoogleChrome/puppeteer/issues/576
        \n---------------------------------\n\n
      `;
      throw new Error(msg);
    }

    if (opts.output === 'pdf') {
      if (opts.pdf.fullPage) {
        const height = await getFullPageHeight(page);
        opts.pdf.height = height;
      }
      data = Buffer.from(await page.pdf(opts.pdf));
    } else if (opts.output === 'html') {
      data = await page.evaluate(() => document.documentElement.innerHTML);
    } else {
      // This is done because puppeteer throws an error if fullPage and clip is used at the same
      // time even though clip is just empty object {}
      const screenshotOpts = _.cloneDeep(_.omit(opts.screenshot, ['clip']));
      const clipContainsSomething = _.some(
        opts.screenshot.clip,
        (val) => !_.isUndefined(val),
      );
      if (clipContainsSomething) {
        screenshotOpts.clip = opts.screenshot.clip;
      }
      if (_.isNil(opts.screenshot.selector)) {
        data = Buffer.from(await page.screenshot(screenshotOpts));
      } else {
        const selElement = await page.$(opts.screenshot.selector);
        const selectorScreenOpts = _.cloneDeep(
          _.omit(screenshotOpts, ['selector', 'fullPage']),
        );
        if (!_.isNull(selElement)) {
          data = Buffer.from(await selElement.screenshot(selectorScreenOpts));
        }
      }
    }
  } catch (err) {
    logger.error(`Error when rendering page: ${err}`);
    logger.error(err.stack);
    throw err;
  } finally {
    logger.info('Closing browser..');
    if (!config.DEBUG_MODE) {
      await browser.close();
    }
  }

  return data;
}

async function scrollPage(page) {
  // Scroll to page end to trigger lazy loading elements
  await page.evaluate(() => {
    const scrollInterval = 100;
    const scrollStep = Math.floor(window.innerHeight / 2);
    const bottomThreshold = 400;

    function bottomPos() {
      return window.pageYOffset + window.innerHeight;
    }

    return new Promise((resolve, reject) => {
      function scrollDown() {
        window.scrollBy(0, scrollStep);

        if (document.body.scrollHeight - bottomPos() < bottomThreshold) {
          window.scrollTo(0, 0);
          setTimeout(resolve, 500);
          return;
        }

        setTimeout(scrollDown, scrollInterval);
      }

      setTimeout(reject, 30000);
      scrollDown();
    });
  });
}

function logOpts(opts) {
  const supressedOpts = _.cloneDeep(opts);
  if (opts.html) {
    supressedOpts.html = '...';
  }

  logger.info(`Rendering with opts: ${JSON.stringify(supressedOpts, null, 2)}`);
}

module.exports = {
  render,
};
