// automation.js
const { chromium } = require('playwright');

async function runAutomation(ssn, dob, zip, screenshotPath) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36',
  });

  const page = await context.newPage();
  let status = 'error'; // default fallback

  try {
    // ⬇️ Put your permitted/staging URL here
    await page.goto('https://myaccount.ascensus.com/rplink/account/Setup/Identity', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Wait for fields, then fill
    await page.getByLabel(/Social Security Number|SSN|ID/i).waitFor({ timeout: 30000 });
    await page.getByLabel(/Social Security Number|SSN|ID/i).fill(ssn);
    await page.getByLabel(/Date of Birth/i).fill(dob);
    await page.getByLabel(/Zip Code|ZIP/i).fill(zip);

    // Click the "Next" button (case-insensitive)
    await page.getByRole('button', { name: /Next/i }).click();

    // Allow the next view/response to render
    await page.waitForTimeout(3500);

    // --- Result classification (adjust the patterns to your permitted page) ---
    const content = await page.content();

    if (content.includes('Create your username')) {
      status = 'valid';
    } else if (
      content.match(
        /could not find a match|do not have an account|unable to find your information|please try again|incorrect|not recognized|either incorrect/i
      )
    ) {
      status = 'incorrect';
    } else {
      status = 'unknown';
    }

    // --- Screenshot (clip if a form exists; else full page) ---
    let box = null;
    try {
      const form = page.locator('form').first();
      box = await form.boundingBox();
    } catch (_) {}

    if (box) {
      await page.screenshot({
        path: screenshotPath,
        clip: {
          x: box.x,
          y: box.y,
          width: Math.max(1, box.width),
          height: Math.max(1, box.height + 120),
        },
      });
    } else {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    return { status, screenshotPath };
  } catch (err) {
    console.error('❌ Error in runAutomation:', err.message);
    return { status: 'error', screenshotPath };
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

module.exports = { runAutomation };