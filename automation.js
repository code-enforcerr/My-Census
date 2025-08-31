const { chromium } = require('playwright');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ---------- Image size knob (env-tunable) ----------
const JPEG_QUALITY = Math.min(95, Math.max(20, parseInt(process.env.JPEG_QUALITY || '30', 10))); // default 30

// ---------- Helpers ----------
function normalizeDOB(input) {
  if (!input) return '';
  const s = String(input).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;                // MM/DD/YYYY
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

// ---------- Unique filename helpers ----------
function normalizeSSN(s) { return String(s || '').replace(/\D/g, '').slice(0, 9); }
function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function sanitize(s = '') { return s.replace(/[^a-z0-9._-]/gi, '_'); }
async function uniqueShotPath(ssn, zip) {
  const dir = process.env.SHOT_DIR || path.resolve('screenshots');
  await fsp.mkdir(dir, { recursive: true });
  const name = `${sanitize(normalizeSSN(ssn) || 'ssn')}_${sanitize(String(zip) || 'zip')}_${ts()}.jpg`;
  return path.join(dir, name);
}
function withUniqueSuffix(p) {
  const parsed = path.parse(p);
  const ext = parsed.ext && /\.(jpe?g|png)$/i.test(parsed.ext) ? parsed.ext : '.jpg';
  return path.join(parsed.dir || process.cwd(), `${parsed.name || 'shot'}_${ts()}${ext}`);
}

// ---------- Browser singleton ----------
let _browserSingleton = null;
async function getBrowser() {
  if (_browserSingleton && _browserSingleton.isConnected()) return _browserSingleton;
  _browserSingleton = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--mute-audio',
      '--disable-gpu',
      '--renderer-process-limit=1',
    ],
  });
  return _browserSingleton;
}

// ---------- Main ----------
async function runAutomation(ssn, dob, zip, screenshotPath) {
  const browser = await getBrowser();

  // Smaller viewport for smaller screenshots
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36',
    viewport: { width: 680, height: 760 },  // reduced from 820x900
    deviceScaleFactor: 1,
  });

  // Block heavy resources
  await context.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  let status = 'error';

  // Unique file path
  let shotPath;
  if (screenshotPath) {
    const ensured = await ensureWritablePath(screenshotPath, 'shot');
    shotPath = withUniqueSuffix(ensured);
  } else {
    shotPath = await uniqueShotPath(ssn, zip);
  }

  try {
    // --- URL guard ---
    const url = process.env.TARGET_URL || '';
    if (!/^https?:\/\//i.test(url) || /YOUR_AUTHORIZED_URL_HERE|dommy/i.test(url)) {
      throw new Error('TARGET_URL is not set to a real authorized https URL');
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for form
    try {
      await page.locator('form').first().waitFor({ state: 'visible', timeout: 8000 });
    } catch {}

    // Fill fields helper
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

    // Wait for response
    try {
      await Promise.race([
        page.waitForLoadState('networkidle', { timeout: 12000 }),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 })
      ]);
    } catch {}
    await page.waitForTimeout(1500);

    // --- Classification ---
    const redBanner = await page.getByText(/web access .* currently unavailable/i).first().isVisible().catch(() => false);
    const identityHeading = await page.getByRole('heading', { name: /let(?:'|’|`)?s make sure it'?s you/i }).isVisible().catch(() => false);
    const anyAlert = await page.locator('[role="alert"], .alert, .validation, .error, .error-message, .message--error').first().isVisible().catch(() => false);
    const setupHeading = await page.getByRole('heading', { name: /let(?:'|’|`)?s set up your account|setup your online account/i }).isVisible().catch(() => false);
    const usernameVisible = await page.getByLabel(/username/i).isVisible().catch(() => false);

    if (redBanner || identityHeading || anyAlert) {
      status = 'incorrect';
    } else if (setupHeading && usernameVisible) {
      status = 'valid';
    } else {
      const html = await page.content().catch(() => '');
      if (/could not find|unable to find|do not have an account|not recognized|incorrect|no match/i.test(html)) {
        status = 'incorrect';
      } else if (/create your username|security questions|confirmation sent|identity.*account.*email.*security.*review/i.test(html)) {
        status = 'valid';
      } else {
        status = 'unknown';
      }
    }

    // --- Screenshot (smaller, JPEG) ---
    try {
      const form = page.locator('form').first();
      const box = await form.boundingBox();
      if (box) {
        const padX = 20, padTop = 100, padBottom = 60;
        const vp = context.viewportSize();
        const x = Math.max(0, box.x - padX);
        const y = Math.max(0, box.y - padTop);
        const width = Math.max(1, Math.min(vp.width - x, box.width + padX * 2));
        const height = Math.max(1, Math.min(vp.height - y, box.height + padTop + padBottom));
        await page.screenshot({
          path: shotPath,
          type: 'jpeg',
          quality: JPEG_QUALITY,
          clip: { x, y, width, height },
        });
      } else {
        await page.screenshot({ path: shotPath, type: 'jpeg', quality: JPEG_QUALITY, fullPage: false });
      }
    } catch {
      await page.screenshot({ path: shotPath, type: 'jpeg', quality: JPEG_QUALITY, fullPage: false });
    }

    return { status, screenshotPath: shotPath };
  } catch (err) {
    const reason = (err && (err.message || String(err))) || 'unknown error';
    console.error('❌ Error in runAutomation:', reason);

    try {
      await fsp.mkdir(path.dirname(shotPath), { recursive: true });
      await page.screenshot({ path: shotPath, type: 'jpeg', quality: JPEG_QUALITY, fullPage: true });
      const notePath = shotPath.replace(/\.jpe?g$/i, '.txt');
      await fsp.writeFile(notePath, `Error: ${reason}\nURL: ${await page.url().catch(()=>'?')}\n`, 'utf8');
    } catch {}

    return { status: 'error', screenshotPath: shotPath };
  } finally {
    try { await context.close(); } catch {}
  }
}

module.exports = { runAutomation };