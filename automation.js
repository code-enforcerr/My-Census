// automation.js
// ⚠️ Use only on pages where you have explicit permission. Do not automate PII entry on sites you don't own/operate.
// This keeps your original API: runAutomation(ssn, dob, zip, screenshotPath)
// and returns { status: 'valid'|'incorrect'|'unknown'|'error', screenshotPath }

const { chromium } = require('playwright');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function normalizeDOB(input) {
  if (!input) return '';
  const s = String(input).trim();

  // already MM/DD/YYYY?
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;

  // YYYY-MM-DD
  const mYMD = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (mYMD) return `${mYMD[2]}/${mYMD[3]}/${mYMD[1]}`;

  // YYYY/MM/DD
  const mYMD2 = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(s);
  if (mYMD2) return `${mYMD2[2]}/${mYMD2[3]}/${mYMD2[1]}`;

  // DD-MM-YYYY or DD/MM/YYYY
  const mDMY = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(s);
  if (mDMY) return `${mDMY[2]}/${mDMY[1]}/${mDMY[3]}`;

  // Last resort: Date(...)
  const d = new Date(s);
  if (!isNaN(d)) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = String(d.getFullYear());
    return `${mm}/${dd}/${yy}`;
  }
  return s; // let the site validator handle it
}

async function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
}

async function preferTmpIfReadonly(requestedPath, baseName = 'shot') {
  try {
    await ensureDirFor(requestedPath);
    return requestedPath;
  } catch {
    // Fall back to /tmp on serverless/containers
    const tmpDir = process.env.TMPDIR || '/tmp';
    await fsp.mkdir(tmpDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(tmpDir, `${baseName}-${ts}.png`);
  }
}

async function robustFill(page, patterns, value) {
  for (const p of patterns) {
    try {
      const loc = page.locator(p);
      await loc.first().waitFor({ state: 'visible', timeout: 2000 });
      await loc.first().fill(value);
      return true;
    } catch {}
  }
  return false;
}

async function clickFirst(page, patterns) {
  for (const p of patterns) {
    try {
      const loc = page.locator(p);
      await loc.first().waitFor({ state: 'visible', timeout: 2000 });
      await loc.first().click({ timeout: 2000 });
      return true;
    } catch {}
  }
  return false;
}

async function runAutomation(ssn, dob, zip, screenshotPath) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  const page = await context.newPage();
  let status = 'error';

  // 🔧 Adjust these patterns to match your authorized site.
  // Use either labels/placeholders or attributes for reliability.
  const SELECTORS = {
    ssn: [
      // by label text
      'label:has-text("Social Security Number") ~ input',
      'label:has-text("SSN") ~ input',
      // by placeholder/name/id
      'input[placeholder*="SSN" i]',
      'input[name*="ssn" i]',
      'input[id*="ssn" i]',
      // fallback: the first password-type masked field (many SSN inputs are "password")
      'input[type="password"]',
    ],
    dob: [
      'label:has-text("Date of Birth") ~ input',
      'input[placeholder*="Date of Birth" i]',
      'input[placeholder*="DOB" i]',
      'input[name*="dob" i]',
      'input[id*="dob" i]',
    ],
    zip: [
      'label:has-text("Zip") ~ input',
      'input[placeholder*="ZIP" i]',
      'input[name*="zip" i]',
      'input[id*="zip" i]',
      'input[name*="postal" i]',
    ],
    submit: [
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Submit")',
      'button[type="submit"]',
      'input[type="submit"]',
      '[role="button"]:has-text("Next")',
    ],
  };

  // Result rules – tune to the exact UI copy of your authorized site.
  const SUCCESS_RULES = [
    /create your username/i,
    /verify your identity/i,
    /security questions/i,
    /confirmation sent/i,
  ];

  const INCORRECT_RULES = [
    /could not find/i,
    /unable to find/i,
    /do not have an account/i,
    /not recognized/i,
    /incorrect/i,
    /no match/i,
  ];

  try {
    const url = process.env.TARGET_URL || 'https://myaccount.ascensus.com/rplink/account/Setup/Identity';
    console.log('Navigating to:', url);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for the form (best-effort; don’t crash if not found)
    try {
      await page.locator('form').first().waitFor({ state: 'visible', timeout: 8000 });
    } catch {}

    const dobNorm = normalizeDOB(dob);

    // Fill fields robustly
    const okSSN = await robustFill(page, SELECTORS.ssn, String(ssn).trim());
    const okDOB = await robustFill(page, SELECTORS.dob, dobNorm);
    const okZIP = await robustFill(page, SELECTORS.zip, String(zip).trim());

    if (!okSSN || !okDOB || !okZIP) {
      throw new Error(
        `Could not locate all fields: ssn:${okSSN} dob:${okDOB} zip:${okZIP}`
      );
    }

    // Submit
    const clicked = await clickFirst(page, SELECTORS.submit);
    if (!clicked) {
      throw new Error('Submit button not found');
    }

    // Let the page process; prefer network idle then content settle
    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {}
    await page.waitForTimeout(2500);

    // Determine status (prefer element existence; fallback to HTML test)
    let html = '';
    try { html = await page.content(); } catch {}

    const matches = (rules) => rules.some((r) => r.test(html));

    if (matches(SUCCESS_RULES)) {
      status = 'valid';
    } else if (matches(INCORRECT_RULES)) {
      status = 'incorrect';
    } else {
      // Try a few UI hints before giving up
      const hasError = await page.locator('[role="alert"], .error, .validation, .alert').first().isVisible().catch(() => false);
      status = hasError ? 'incorrect' : 'unknown';
    }

    // Screenshot (prefer form region; fallback to full page)
    const safePath = await preferTmpIfReadonly(
      screenshotPath || path.join((process.env.TMPDIR || '/tmp'), 'shot.png'),
      'shot'
    );

    try {
      const form = page.locator('form').first();
      const box = await form.boundingBox();
      if (box) {
        await page.screenshot({
          path: safePath,
          clip: {
            x: Math.max(0, box.x),
            y: Math.max(0, box.y),
            width: Math.max(1, box.width),
            height: Math.max(1, box.height + 120),
          },
        });
      } else {
        await page.screenshot({ path: safePath, fullPage: true });
      }
    } catch {
      await page.screenshot({ path: safePath, fullPage: true });
    }

    return { status, screenshotPath: safePath };
  } catch (err) {
    console.error('❌ Error in runAutomation:', err?.message || err);
    // Try to leave a screenshot even on error
    let safePath = screenshotPath;
    try {
      safePath = await preferTmpIfReadonly(
        screenshotPath || path.join((process.env.TMPDIR || '/tmp'), 'shot-error.png'),
        'shot-error'
      );
      await page.screenshot({ path: safePath, fullPage: true });
    } catch {}
    return { status: 'error', screenshotPath: safePath };
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

module.exports = { runAutomation };