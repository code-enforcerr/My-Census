// bot.js
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const archiver = require('archiver');
const { runAutomation } = require('./automation');

// --- Fail fast if token is missing ---
if (!process.env.TELEGRAM_TOKEN) {
  console.error('❌ TELEGRAM_TOKEN is not set. On Render, add it in Settings → Environment and Restart.');
  process.exit(1);
}

// --- Parse approved users from env (as strings) ---
const rawApproved = (process.env.APPROVED_USERS || '').trim();
const approvedUsers = rawApproved
  .split(',')
  .map(s => s.trim())
  .filter(Boolean); // e.g. ["8134029062","123456789"]

console.log('🔧 ENV DEBUG → APPROVED_USERS (raw):', JSON.stringify(rawApproved));
console.log('🔧 ENV DEBUG → approvedUsers (parsed):', approvedUsers);

// Helper to check access consistently (works for DMs and groups)
function isApproved(id) {
  const idStr = String(id).trim();     // normalize to string
  return approvedUsers.includes(idStr);
}

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

bot.setMyCommands([
  { command: '/start',   description: 'Start the bot' },
  { command: '/export',  description: 'Download all screenshots as ZIP' },
  { command: '/clean',   description: 'Clear all saved results' },
  { command: '/whoami',  description: 'Show your chat id' }
]);

// Always allow /whoami so you can fetch your id even if not approved
bot.onText(/^\/whoami$/, (msg) => {
  const cid = String(msg.chat.id);
  const uname = msg.from?.username ? '@' + msg.from.username : '';
  console.log('🔧 /whoami →', cid, uname);
  bot.sendMessage(cid, `chat_id: ${cid} ${uname}`);
});

// ---- Writable locations (Render/Vercel) ----
const TMP_DIR = process.env.TMPDIR || '/tmp';
const SCREENSHOT_DIR = path.join(TMP_DIR, 'screenshots');

(async () => {
  await fsp.mkdir(SCREENSHOT_DIR, { recursive: true }).catch(() => {});
})();

// Utility: build + send a ZIP safely
async function sendZipArchive(bot, chatId, filePaths, baseName = 'screenshots') {
  if (!filePaths.length) {
    await bot.sendMessage(chatId, 'ℹ️ No files to export.');
    return;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const zipPath = path.join(TMP_DIR, `${baseName}-${ts}.zip`);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', (err) => {
      // ENOENT = file missing; skip it, otherwise fail
      if (err.code !== 'ENOENT') reject(err);
    });
    archive.on('error', reject);

    archive.pipe(output);

    for (const fp of filePaths) {
      if (fp && fs.existsSync(fp)) {
        archive.file(fp, { name: path.basename(fp) });
      }
    }

    archive.finalize();
  });

  // Size check: Telegram bot file limit ~50MB
  const { size } = await fsp.stat(zipPath);
  if (size >= 49 * 1024 * 1024) {
    try { await fsp.unlink(zipPath); } catch {}
    await bot.sendMessage(chatId, '❌ ZIP is too large for Telegram. Try fewer entries.');
    return;
  }

  try {
    await bot.sendDocument(
      chatId,
      fs.createReadStream(zipPath),
      { caption: `Export (${filePaths.length} file${filePaths.length === 1 ? '' : 's'})` },
      { filename: path.basename(zipPath), contentType: 'application/zip' }
    );
  } catch (e) {
    console.error('sendDocument failed:', e?.message || e);
    await bot.sendMessage(chatId, '❌ Failed to send ZIP archive.');
  } finally {
    try { await fsp.unlink(zipPath); } catch {}
  }
}

// Strict /start (exact command, no args)
bot.onText(/^\/start$/, (msg) => {
  const chatId = String(msg.chat.id);
  const ok = isApproved(chatId);
  console.log(`🔧 /start from ${chatId} approved=${ok}`);
  if (!ok) return bot.sendMessage(chatId, '🚫 Access Denied: You are not an approved user.');

  bot.sendMessage(chatId, `👋 Send data in this format:
SSN,DOB (MM/DD/YYYY),ZIPCODE

📦 Use multiple lines for bulk. Then send /export to download results.`);
});

// Optional: /clean (wipe /tmp/screenshots)
bot.onText(/^\/clean$/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');
  try {
    const items = await fsp.readdir(SCREENSHOT_DIR);
    await Promise.all(items.map(i => fsp.unlink(path.join(SCREENSHOT_DIR, i)).catch(() => {})));
    await bot.sendMessage(chatId, '🧹 Cleaned stored screenshots.');
  } catch (e) {
    console.error('clean error', e);
    await bot.sendMessage(chatId, '⚠️ Could not clean screenshots.');
  }
});

// Optional: /export (zip whatever is currently stored)
bot.onText(/^\/export$/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');

  const files = (await fsp.readdir(SCREENSHOT_DIR).catch(() => []))
    .map(n => path.join(SCREENSHOT_DIR, n))
    .filter(fp => (fp.endsWith('.png') || fp.endsWith('.jpg')) && fs.existsSync(fp)); // ← include JPGs

  await sendZipArchive(bot, chatId, files, 'screenshots');
});

// =========================
// Progress-enabled handler
// =========================
bot.on('message', async (msg) => {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const ok = isApproved(chatId);

  // skip commands here; they have their own handlers
  if (!text || text.startsWith('/')) return;

  console.log(`🔧 MSG from ${chatId} approved=${ok} text=${JSON.stringify(text.slice(0, 60))}`);
  if (!ok) return bot.sendMessage(chatId, '🚫 Access Denied: You are not an approved user.');

  // Parse lines
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return;

  const total = lines.length;
  const startedAt = Date.now();

  // Initial progress message
  const progressMsg = await bot.sendMessage(
    chatId,
    `⏳ Processing ${total} entries... 0/${total}`
  );

  // Throttle progress edits (max ~1 per 1.2s) and always on final
  let lastEdit = 0;
  const maybeUpdateProgress = async (done) => {
    const now = Date.now();
    if (done === total || now - lastEdit >= 1200) {
      const elapsed = Math.round((now - startedAt) / 1000);
      const barLen = 20;
      const filled = Math.max(0, Math.min(barLen, Math.round((done / total) * barLen)));
      const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
      await bot.editMessageText(
        `⏳ Processing ${total} entries...\n${bar} ${done}/${total}\n⏱️ ${elapsed}s elapsed`,
        { chat_id: chatId, message_id: progressMsg.message_id }
      ).catch(() => {});
      lastEdit = now;
    }
  };

  const results = [];
  let done = 0;

  await fsp.mkdir(SCREENSHOT_DIR, { recursive: true }).catch(() => {});

  for (const line of lines) {
    const parts = line.split(',').map(p => p.trim());
    if (parts.length < 3) {
      results.push({ line, status: 'invalid' });
      done++; await maybeUpdateProgress(done);
      continue;
    }

    const [ssn, dob, zip] = parts;
    const filename = `${ssn}_${Date.now()}.jpg`; // ← save as JPG to match automation
    const screenshotPath = path.join(SCREENSHOT_DIR, filename);

    try {
      const { status } = await runAutomation(ssn, dob, zip, screenshotPath);
      results.push({ line, status, screenshot: filename });
    } catch (err) {
      console.error('runAutomation error for', line, err.message || err);
      results.push({ line, status: 'error', screenshot: filename });
    }

    done++;
    await maybeUpdateProgress(done);
  }

  // Final progress update to 100% (before export)
  await bot.editMessageText(
    `Processing ${total} entries...  ${total}/${total}`,
    { chat_id: chatId, message_id: progressMsg.message_id }
  ).catch(() => {});

  // Build list of actual files and send ALL-in-one archive
  const filePaths = results
    .map(r => r.screenshot && path.join(SCREENSHOT_DIR, r.screenshot))
    .filter(fp => fp && fs.existsSync(fp));

  await sendZipArchive(bot, chatId, filePaths, 'screenshots-batch');

  // 👉 PER-CATEGORY ARCHIVES (Valid / Incorrect / Unknown / Error)
  const groups = {
    valid:     results.filter(r => r.status === 'valid'),
    incorrect: results.filter(r => r.status === 'incorrect'),
    unknown:   results.filter(r => r.status === 'unknown'),
    error:     results.filter(r => r.status === 'error'),
  };

  for (const [label, arr] of Object.entries(groups)) {
    const files = arr
      .map(r => r.screenshot && path.join(SCREENSHOT_DIR, r.screenshot))
      .filter(fp => fp && fs.existsSync(fp));

    if (files.length) {
      await sendZipArchive(bot, chatId, files, `screenshots-${label}`);
    }
  }
  // 👈 END per-category zips

  // Summaries
  const counts = { valid: 0, incorrect: 0, unknown: 0, error: 0, invalid: 0 };
  for (const r of results) {
    if (r.status === 'valid') counts.valid++;
    else if (r.status === 'incorrect') counts.incorrect++;
    else if (r.status === 'unknown') counts.unknown++;
    else if (r.status === 'invalid') counts.invalid++;
    else counts.error++;
  }

  let summary =
`Processed ${total} entries:
✅ Valid: ${counts.valid}
❌ Incorrect: ${counts.incorrect}
❓ Unknown: ${counts.unknown}
⚠ Errors: ${counts.error}
🚫 Invalid Format: ${counts.invalid}`;

  if (counts.invalid > 0) {
    summary += `

ℹ Expected format (3 fields, comma-separated):
SSN,DOB (MM/DD/YYYY),ZIPCODE`;
  }

  await bot.sendMessage(chatId, summary);
});