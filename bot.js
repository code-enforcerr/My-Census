// bot.js
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const archiver = require('archiver');
// NOTE: express removed (not needed in polling mode)
const { runAutomation } = require('./automation');

// ----- Helpers -----
function parseEntryLine(raw) {
  if (!raw) return null;
  let s = raw.normalize('NFKC')
    .replace(/\u00A0/g, ' ')        // NBSP -> space
    .replace(/[，、]/g, ',')         // CJK commas -> comma
    .replace(/\s+/g, ' ')            // collapse spaces
    .trim();

  // Accept comma or pipe
  const m = s.match(/^\s*([0-9]{3,9})\s*[,|]\s*([0-1]?\d[\/\-][0-3]?\d[\/\-]\d{2,4})\s*[,|]\s*(\d{5}(?:-\d{4})?)\s*$/);
  if (!m) return null;

  const ssn = m[1];
  const [a,b,c] = m[2].split(/[\/\-]/);
  const yyyy = c.length === 2 ? (Number(c) > 30 ? '19'+c : '20'+c) : c;
  const dob = `${String(a).padStart(2,'0')}/${String(b).padStart(2,'0')}/${yyyy}`;
  const zip = m[3];
  return { ssn, dob, zip, raw: s };
}

// --- Fail fast if token is missing ---
const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) {
  console.error('❌ TELEGRAM_TOKEN is not set. On Render, add it in Settings → Environment and Restart.');
  process.exit(1);
}

// --- Approved users from env (strings) ---
const rawApproved = (process.env.APPROVED_USERS || '').trim();
const approvedUsers = rawApproved.split(',').map(s => s.trim()).filter(Boolean);
console.log('🔧 ENV DEBUG → APPROVED_USERS (raw):', JSON.stringify(rawApproved));
console.log('🔧 ENV DEBUG → approvedUsers (parsed):', approvedUsers);
const isApproved = (id) => approvedUsers.includes(String(id).trim());

// ---- Writable locations (Render/Vercel) ----
const TMP_DIR = process.env.TMPDIR || '/tmp';
const SCREENSHOT_DIR = path.join(TMP_DIR, 'screenshots');
(async () => { await fsp.mkdir(SCREENSHOT_DIR, { recursive: true }).catch(() => {}); })();

// ---- Create bot (start polling explicitly to avoid 409 conflicts) ----
const bot = new TelegramBot(TOKEN, { polling: false });

(async () => {
  try {
    // Remove any webhook & drop pending updates; then start polling
    await bot.deleteWebHook({ drop_pending_updates: true });
    await bot.startPolling({ params: { allowed_updates: ['message'] } });
    console.log('🤖 Bot polling started.');
  } catch (e) {
    console.error('Failed to start polling:', e);
  }
})();

// ---- Commands ----
bot.setMyCommands([
  { command: '/start',   description: 'Start the bot' },
  { command: '/export',  description: 'Download all screenshots as ZIP' },
  { command: '/clean',   description: 'Clear all saved results' },
  { command: '/whoami',  description: 'Show your chat id' }
]);

bot.onText(/^\/whoami$/, (msg) => {
  const cid = String(msg.chat.id);
  const uname = msg.from?.username ? '@' + msg.from.username : '';
  console.log('🔧 /whoami →', cid, uname);
  bot.sendMessage(cid, `chat_id: ${cid} ${uname}`);
});

bot.onText(/^\/start$/, (msg) => {
  const chatId = String(msg.chat.id);
  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied: You are not an approved user.');
  bot.sendMessage(chatId, `👋 Send data in this format:
SSN,DOB (MM/DD/YYYY),ZIPCODE

📦 Use multiple lines for bulk. Then send /export to download results.`);
});

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

bot.onText(/^\/export$/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');
  const files = (await fsp.readdir(SCREENSHOT_DIR).catch(() => []))
    .map(n => path.join(SCREENSHOT_DIR, n))
    .filter(fp => (fp.endsWith('.jpg') || fp.endsWith('.png')) && fs.existsSync(fp));
  await sendZipArchive(bot, chatId, files, 'screenshots');
});

// ---- Message handler (bulk processing with progress) ----
bot.on('message', async (msg) => {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return; // commands handled elsewhere
  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied: You are not an approved user.');

  console.log(`🔧 MSG from ${chatId} text=${JSON.stringify(text.slice(0, 80))}`);

  // Normalize & split lines; only keep valid ones
  const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const batchId = Date.now().toString();
  const lines = [];
  const invalidLines = [];

  for (const raw of rawLines) {
    const parsed = parseEntryLine(raw);
    if (parsed) lines.push(parsed);
    else invalidLines.push(raw);
  }
  if (lines.length === 0) {
    return bot.sendMessage(chatId, '⚠️ No valid lines found. Expected: SSN,DOB(MM/DD/YYYY),ZIP.');
  }

  const total = lines.length;
  const startedAt = Date.now();

  const progressMsg = await bot.sendMessage(chatId, `⏳ Processing ${total} entries... 0/${total}`);

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

  for (const { ssn, dob, zip, raw } of lines) {
    const filename = `${batchId}_${ssn}.jpg`;           // avoid cross-run collisions
    const screenshotPath = path.join(SCREENSHOT_DIR, filename);

    try {
      const { status } = await runAutomation(ssn, dob, zip, screenshotPath);
      results.push({ line: raw, status, screenshot: filename });
    } catch (err) {
      console.error('runAutomation error for', raw, err?.message || err);
      results.push({ line: raw, status: 'error', screenshot: filename });
    }

    done++;
    await maybeUpdateProgress(done);
  }

  await bot.editMessageText(
    `Processing ${total} entries...  ${total}/${total}`,
    { chat_id: chatId, message_id: progressMsg.message_id }
  ).catch(() => {});

  // (We no longer send a big batch ZIP to avoid duplicates)

  // Per-category archives
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
    if (files.length) await sendZipArchive(bot, chatId, files, `screenshots-${label}`);
  }

  // Summary
  const counts = { valid: 0, incorrect: 0, unknown: 0, error: 0, invalid: invalidLines.length };
  for (const r of results) {
    if (r.status === 'valid') counts.valid++;
    else if (r.status === 'incorrect') counts.incorrect++;
    else if (r.status === 'unknown') counts.unknown++;
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

Skipped lines:
• ${invalidLines.slice(0, 5).join('\n• ')}${invalidLines.length > 5 ? '\n• …' : ''}

ℹ Expected format (comma or pipe):
SSN,DOB (MM/DD/YYYY),ZIPCODE`;
  }
  await bot.sendMessage(chatId, summary);
});

// ---- ZIP utility ----
async function sendZipArchive(bot, chatId, filePaths, baseName = 'screenshots') {
  if (!filePaths.length) {
    await bot.sendMessage(chatId, `ℹ️ No files to export for ${baseName}.`);
    return;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const zipPath = path.join(TMP_DIR, `${baseName}-${ts}.zip`);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
    archive.on('error', reject);

    archive.pipe(output);

    for (const fp of filePaths) {
      if (fs.existsSync(fp)) {
        // include image
        archive.file(fp, { name: path.basename(fp) });
        // include optional error note next to image, if present
        const note = fp.replace(/\.(png|jpg|jpeg)$/i, '.txt');
        if (fs.existsSync(note)) {
          archive.file(note, { name: path.basename(note) });
        }
      }
    }

    archive.finalize();
  });

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