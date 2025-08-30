// automation.js
// Use only on sites you have permission to automate.
const { chromium } = require('playwright');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function normalizeDOB(input) {
  if (!input) return '';
  const s = String(input).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s; // MM/DD/YYYY
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return `${m[2]}/${m[3]}/${m[1]}`; // YYYY-MM-DD
  if ((m = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(s))) return `${m[2]}/${m[1]}/${m[3]}`; // DD/MM/YYYY
  const d = new Date(s);
  if (!isNaN(d)) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = String(d.getFullYear());
    return `${mm}/${dd}/${yy}`;
  }
  return s;
}

async function ensureWritablePath(requestedPath, base = 'shot') {
  try {
    await fsp.mkdir(path.dirname(requestedPath), { recursive: true });
    return requestedPath;
  } catch {
    const tmpDir = process.env.TMPDIR || '/tmp';
    await fsp.mkdir(tmpDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(tmpDir, `${base}-${ts}.jpg`);
  }
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

  // Narrow viewport so element screenshots are compact
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36',
    viewport: { width: 900, height: 1000 },
  });

  const page = await context.newPage();
  let status = 'error';
  let shotPath = await ensureWritablePath(
    screenshotPath || path.join(process.env.TMPDIR || '/tmp', 'shot.jpg'),
    'shot'
  );

  // Text rules — tuned so the red banner counts as INCORRECT
   const SUCCESS_RULES = [
    /create your username/i,
    /verify your identity/i,
    /security questions/i,
    /confirmation sent/i,
    // 👇 new explicit matches for your screenshot
    /Let's Set Up Your Account/i,
    /Setup Your Online Account/i,
    /Username/i,
    /Password/i,
    /Identity.*Account.*Email.*Security.*Review/i,  // progress bar text
  ];

  const INCORRECT_RULES = [
    /could not find/i,
    /unable to find/i,
    /do not have an account/i,
    /not recognized/i,
    /incorrect/i,
    /no match/i,
    // 👇 your screenshot's red banner
    /Web access for your plan is currently unavailable/i,
    /contact your employer/i,
  ];

  try {
    const url = process.env.TARGET_URL || 'https://myaccount.ascensus.com/rplink/account/Setup/Identity';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    try { await page.locator('form').first().waitFor({ state: 'visible', timeout: 8000 }); } catch {}

    // Fill helpers
    const dobNorm = normalizeDOB(dob);
    const tryFill = async (selectors, value) => {
      for (const sel of selectors) {
        try {
          const loc = page.locator(sel).first();
          await loc.waitFor({ state: 'visible', timeout: 2000 });
          await loc.fill(value);
          return true;
        } catch {}
      }
      return false;
    };

    const okSSN = await tryFill([
      'label:has-text("Social Security Number") ~ input',
      'label:has-text("SSN") ~ input',
      'input[placeholder*="SSN" i]',
      'input[name*="ssn" i]',
      'input[id*="ssn" i]',
      'input[type="password"]',
    ], String(ssn).trim());

    const okDOB = await tryFill([
      'label:has-text("Date of Birth") ~ input',
      'input[placeholder*="Date of Birth" i]',
      'input[placeholder*="DOB" i]',
      'input[name*="dob" i]',
      'input[id*="dob" i]',
    ], dobNorm);

    const okZIP = await tryFill([
      'label:has-text("Zip") ~ input',
      'input[placeholder*="ZIP" i]',
      'input[name*="zip" i]',
      'input[id*="zip" i]',
      'input[name*="postal" i]',
    ], String(zip).trim());

    if (!okSSN || !okDOB || !okZIP) {
      throw new Error(`Could not locate all fields: ssn:${okSSN} dob:${okDOB} zip:${okZIP}`);
    }

    // Submit
    const clicked = await (async () => {
      const buttons = [
        'button:has-text("Next")',
        'button:has-text("Continue")',
        'button:has-text("Submit")',
        'button[type="submit"]',
        'input[type="submit"]',
        '[role="button"]:has-text("Next")',
      ];
      for (const b of buttons) {
        try {
          const loc = page.locator(b).first();
          await loc.waitFor({ state: 'visible', timeout: 2000 });
          await loc.click({ timeout: 2000 });
          return true;
        } catch {}
      }
      return false;
    })();

    if (!clicked) throw new Error('Submit button not found');

    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    await page.waitForTimeout(2500);

    // Classify
    const html = await page.content().catch(() => '');
    if (SUCCESS_RULES.some(r => r.test(html))) {
      status = 'valid';
    } else if (INCORRECT_RULES.some(r => r.test(html))) {
      status = 'incorrect';
    } else {
      const hasError = await page.locator('[role="alert"], .error, .validation, .alert').first().isVisible().catch(() => false);
      status = hasError ? 'incorrect' : 'unknown';
    }

    // Small screenshot: crop around the form + heading; save as JPEG to reduce size
    try {
      const form = page.locator('form').first();
      const box = await form.boundingBox();
      if (box) {
        const padX = 40, padTop = 160, padBottom = 120;
        const x = Math.max(0, box.x - padX);
        const y = Math.max(0, box.y - padTop);
        const width = Math.max(1, Math.min(context.viewportSize().width - x, box.width + padX * 2));
        const height = Math.max(1, Math.min(context.viewportSize().height - y, box.height + padTop + padBottom));
        await page.screenshot({ path: shotPath, type: 'jpeg', quality: 60, clip: { x, y, width, height } });
      } else {
        await page.screenshot({ path: shotPath, type: 'jpeg', quality: 60, fullPage: false });
      }
    } catch {
      await page.screenshot({ path: shotPath, type: 'jpeg', quality: 60, fullPage: false });
    }

    return { status, screenshotPath: shotPath };
  } catch (err) {
    console.error('❌ Error in runAutomation:', err?.message || err);
    try {
      shotPath = await ensureWritablePath(shotPath, 'shot-error');
      await page.screenshot({ path: shotPath, type: 'jpeg', quality: 60, fullPage: true });
    } catch {}
    return { status: 'error', screenshotPath: shotPath };
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

module.exports = { runAutomation };