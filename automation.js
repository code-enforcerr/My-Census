// automation.js
const { chromium } = require('playwright');

let browserPromise = null; // singleton

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        // a bit less memory hungry
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-background-networking',
        '--disable-default-apps',
        '--mute-audio'
      ]
    });
  }
  return browserPromise;
}

// optional: allow bot.js to close browser on shutdown
async function shutdownBrowser() {
  try {
    const b = await browserPromise;
    if (b) await b.close();
  } catch {}
  browserPromise = null;
}

async function runAutomation(ssn, dob, zip, screenshotPath) {
  const browser = await getBrowser();

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    acceptDownloads: false,
  });

  // Block heavy resources to save RAM/CPU
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  let status = 'error';
  try {
    const url = process.env.TARGET_URL || 'https://myaccount.ascensus.com/rplink/account/Setup/Identity';
    if (!/^https?:\/\//i.test(url)) throw new Error('TARGET_URL is missing or invalid.');
    console.log('Navigating to:', url);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Fill form
    await page.getByLabel(/Social Security Number|SSN|ID/i).fill(ssn);
    await page.getByLabel(/Date of Birth/i).fill(dob);
    await page.getByLabel(/Zip Code|ZIP/i).fill(zip);

    // Submit
    await page.getByRole('button', { name: /Next|Continue|Submit/i }).click();
    await page.waitForTimeout(4000);

    // Classify
    const html = await page.content();
    if (/Create your username|Let's Set Up Your Account/i.test(html)) {
      status = 'valid';
    } else if (/could not find|do not have an account|unable to find|incorrect|not recognized/i.test(html)) {
      status = 'incorrect';
    } else {
      status = 'unknown';
    }

    // Screenshot
    try {
      const form = page.locator('form').first();
      const box = await form.boundingBox();
      if (box) {
        await page.screenshot({
          path: screenshotPath,
          clip: { x: box.x, y: box.y, width: Math.max(1, box.width), height: Math.max(1, box.height + 120) },
        });
      } else {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }
    } catch {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    return { status, screenshotPath };
  } catch (err) {
    console.error('❌ Error in runAutomation:', err?.message || err);
    try { await page.screenshot({ path: screenshotPath, fullPage: true }); } catch {}
    return { status: 'error', screenshotPath };
  } finally {
    try { await context.close(); } catch {}
    // DO NOT close the browser here; it is reused.
  }
}

module.exports = { runAutomation, shutdownBrowser };