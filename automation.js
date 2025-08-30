// automation.js
const { chromium } = require('playwright');

async function runAutomation(ssn, dob, zip, screenshotPath) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36'
  });

  const page = await context.newPage();
  let status = 'error'; // fallback

  try {
    // 🔑 Replace with your own authorized/staging URL
    const url = process.env.TARGET_URL || 'https://myaccount.ascensus.com/rplink/account/Setup/Identity';
    console.log('Navigating to:', url);

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // --- Fill out the form (adjust labels to match the page) ---
    await page.getByLabel(/Social Security Number|SSN|ID/i).fill(ssn);
    await page.getByLabel(/Date of Birth/i).fill(dob);
    await page.getByLabel(/Zip Code|ZIP/i).fill(zip);

    // Submit (adjust if button text differs)
    await page.getByRole('button', { name: /Next|Continue|Submit/i }).click();

    // Give the page time to respond
    await page.waitForTimeout(4000);

    // --- Result classification (adjust text patterns to your site) ---
    const html = await page.content();

    if (/Create your username/i.test(html)) {
      status = 'valid';
    } else if (/could not find|do not have an account|unable to find|incorrect|not recognized/i.test(html)) {
      status = 'incorrect';
    } else {
      status = 'unknown';
    }

    // --- Screenshot (clip to form if possible, else full page) ---
    try {
      const form = page.locator('form').first();
      const box = await form.boundingBox();
      if (box) {
        await page.screenshot({
          path: screenshotPath,
          type: 'jpeg',     // ✅ save as JPEG
          quality: 60,      // ✅ compress
          clip: {
            x: box.x,
            y: box.y,
            width: Math.max(1, box.width),
            height: Math.max(1, box.height + 120),
          },
        });
      } else {
        await page.screenshot({
          path: screenshotPath,
          type: 'jpeg',     // ✅ save as JPEG
          quality: 60,      // ✅ compress
          fullPage: true
        });
      }
    } catch {
      await page.screenshot({
        path: screenshotPath,
        type: 'jpeg',       // ✅ save as JPEG
        quality: 60,        // ✅ compress
        fullPage: true
      });
    }

    return { status, screenshotPath };
  } catch (err) {
    console.error('❌ Error in runAutomation:', err?.message || err);
    return { status: 'error', screenshotPath };
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

module.exports = { runAutomation };