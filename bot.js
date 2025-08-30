// bot.js
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { runAutomation, shutdownBrowser } = require('./automation');

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

// --- Runtime controls ---
const MODE = (process.env.BOT_MODE || 'polling').toLowerCase();
const PACE_MS = Math.max(0, parseInt(process.env.PACE_MS || '300', 10)); // delay between entries
const CHUNK_SIZE = Math.max(1, parseInt(process.env.CHUNK_SIZE || '60', 10)); // process in chunks for huge pastes
const ZIP_CHUNK_COUNT = Math.max(1, parseInt(process.env.ZIP_CHUNK_COUNT || '40', 10)); // screenshots per zip

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: MODE === 'polling' }); // keep filepath default (true)

// Graceful shutdown so Telegram releases polling and browser closes
async function stopBot() {
  try { await bot.stopPolling(); } catch {}
  try { await shutdownBrowser?.(); } catch {}
  process.exit(0);
}
process.on('SIGINT', stopBot);
process.on('SIGTERM', stopBot);

// De-dup & per-chat lock
const seenMessageIds = new Set();
const processingChats = new Set();

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

// Ensure screenshots dir exists
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

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

// Small helper: normalize DOB like 12-31-1990 -> 12/31/1990
const normalizeDob = (s) => {
  const t = String(s || '').trim();
  if (/^\d{2}-\d{2}-\d{4}$/.test(t)) return t.replace(/-/g, '/');
  return t;
};

// Helper: zip & send files in chunks, streaming each zip
async function zipAndSend(botInst, chatId, files, namePrefix) {
  if (!files.length) return;

  // split into chunks to keep each zip smaller
  const chunks = [];
  for (let i = 0; i < files.length; i += ZIP_CHUNK_COUNT) {
    chunks.push(files.slice(i, i + ZIP_CHUNK_COUNT));
  }

  let idx = 1;
  for (const chunk of chunks) {
    const zipPath = path.join(__dirname, `${namePrefix}_${Date.now()}_${idx}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      for (const f of chunk) archive.file(f.abs, { name: f.name });
      archive.finalize();
    });

    try {
      const size = fs.statSync(zipPath).size;
      console.log(`Sending ZIP part ${idx}/${chunks.length} (${Math.round(size/1024/1024)}MB): ${path.basename(zipPath)}`);
      await botInst.sendDocument(chatId, { source: fs.createReadStream(zipPath), filename: path.basename(zipPath) });
    } catch (e) {
      console.error('sendDocument failed:', e?.message || e);
      await botInst.sendMessage(chatId, `❌ Failed to send ${path.basename(zipPath)}.`);
    } finally {
      try { fs.unlinkSync(zipPath); } catch {}
    }

    idx++;
  }
}

// =========================
// Progress-enabled handler
// =========================
bot.on('message', async (msg) => {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const ok = isApproved(chatId);

  // Skip commands; they have their own handlers
  if (!text || text.startsWith('/')) return;

  // De-dup: ignore retries of same Telegram message
  if (seenMessageIds.has(msg.message_id)) return;
  seenMessageIds.add(msg.message_id);

  // Per-chat lock: avoid overlapping batches in same chat
  if (processingChats.has(chatId)) {
    return bot.sendMessage(chatId, '⏳ Still processing your previous batch. Please wait.');
  }
  processingChats.add(chatId);

  console.log(`🔧 MSG from ${chatId} approved=${ok} text=${JSON.stringify(text.slice(0, 60))}`);
  if (!ok) {
    processingChats.delete(chatId);
    return bot.sendMessage(chatId, '🚫 Access Denied: You are not an approved user.');
  }

  // Parse lines
  const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (rawLines.length === 0) {
    processingChats.delete(chatId);
    return;
  }

  const lines = rawLines;
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

  // Ensure screenshots dir exists (again)
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // Process in chunks to control memory spikes on huge pastes
  const chunks = [];
  for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
    chunks.push(lines.slice(i, i + CHUNK_SIZE));
  }

  try {
    for (const chunk of chunks) {
      for (const line of chunk) {
        const parts = line.split(',').map(p => p.trim());
        if (parts.length < 3) {
          results.push({ line, status: 'invalid' });
          done++; await maybeUpdateProgress(done);
          continue;
        }

        const [ssn, dobRaw, zip] = parts;
        const dob = normalizeDob(dobRaw);

        const filename = `${ssn}_${Date.now()}.png`;
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

        // Gentle pacing to reduce rate limits & RAM churn
        if (PACE_MS) await new Promise(r => setTimeout(r, PACE_MS));
      }
    }
  } finally {
    // Continue to packaging and summary even if some entries threw
  }

  // --- Gather ALL screenshots that exist ---
  const allFiles = [];
  for (const r of results) {
    if (!r.screenshot) continue;
    const abs = path.join(SCREENSHOT_DIR, r.screenshot);
    if (fs.existsSync(abs)) allFiles.push({ abs, name: r.screenshot });
  }

  // Final progress update to 100%
  await bot.editMessageText(
    `✅ Done processing. Preparing files to send...`,
    { chat_id: chatId, message_id: progressMsg.message_id }
  ).catch(() => {});

  // Send all screenshots in chunked ZIPs (streamed)
  await zipAndSend(bot, chatId, allFiles, 'screenshots');

  // ===== Send "valid-only" CSV and ZIPs =====
  try {
    const validResults = results.filter(r => r.status === 'valid');
    if (validResults.length) {
      // CSV of valid lines
      const csvPath = path.join(__dirname, `valid_${Date.now()}.csv`);
      const csvHeader = 'ssn,dob,zip\n';
      const csvBody = validResults.map(v => v.line).join('\n');
      fs.writeFileSync(csvPath, csvHeader + csvBody);
      try {
        await bot.sendDocument(
          chatId,
          { source: fs.createReadStream(csvPath), filename: path.basename(csvPath) }
        );
      } catch (err) {
        console.error('send valid.csv failed:', err?.message || err);
        await bot.sendMessage(chatId, '❌ Failed to send valid.csv');
      } finally {
        try { fs.unlinkSync(csvPath); } catch {}
      }

      // ZIPs of valid screenshots only (chunked, streamed)
      const validFiles = [];
      for (const r of validResults) {
        if (!r.screenshot) continue;
        const abs = path.join(SCREENSHOT_DIR, r.screenshot);
        if (fs.existsSync(abs)) validFiles.push({ abs, name: r.screenshot });
      }
      await zipAndSend(bot, chatId, validFiles, 'valid_screenshots');
    } else {
      await bot.sendMessage(chatId, 'ℹ️ No valid entries detected in this batch.');
    }
  } catch (e) {
    console.error('valid export failed:', e?.message || e);
  }

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

  await bot.sendMessage(chatId, summary).catch(() => {});
  processingChats.delete(chatId);
});

// (Keep your /export and /clean handlers if you had them)