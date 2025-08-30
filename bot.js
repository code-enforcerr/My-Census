// bot.js
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
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
  .filter(Boolean);

console.log('🔧 ENV DEBUG → APPROVED_USERS (raw):', JSON.stringify(rawApproved));
console.log('🔧 ENV DEBUG → approvedUsers (parsed):', approvedUsers);

function isApproved(id) {
  return approvedUsers.includes(String(id).trim());
}

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

bot.setMyCommands([
  { command: '/start',   description: 'Start the bot' },
  { command: '/export',  description: 'Download all screenshots as ZIP' },
  { command: '/clean',   description: 'Clear all saved results' },
  { command: '/whoami',  description: 'Show your chat id' }
]);

// --- Helper: safe file sending ---
async function sendFile(botInst, chatId, absPath) {
  let p = absPath;
  if (!fs.existsSync(p)) {
    if (p.toLowerCase().endsWith('.png')) {
      const alt = p.slice(0, -4) + '.jpg';
      if (fs.existsSync(alt)) p = alt;
    }
  }

  if (!fs.existsSync(p)) {
    console.error('sendFile: not found', absPath);
    await botInst.sendMessage(chatId, `❌ File not found: ${path.basename(absPath)}`);
    return;
  }

  try {
    const size = fs.statSync(p).size;
    console.log(`sendFile: ${path.basename(p)} (${Math.round(size/1024/1024)} MB)`);
  } catch {}

  await botInst.sendChatAction(chatId, 'upload_document').catch(()=>{});
  await botInst.sendDocument(chatId, {
    source: fs.createReadStream(p),
    filename: path.basename(p),
  });
}

// Ensure screenshots dir exists
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Always allow /whoami
bot.onText(/^\/whoami$/, (msg) => {
  const cid = String(msg.chat.id);
  const uname = msg.from?.username ? '@' + msg.from.username : '';
  bot.sendMessage(cid, `chat_id: ${cid} ${uname}`);
});

// /start
bot.onText(/^\/start$/, (msg) => {
  const chatId = String(msg.chat.id);
  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');

  bot.sendMessage(chatId, `👋 Send data in this format:
SSN,DOB (MM/DD/YYYY),ZIPCODE

📦 Use multiple lines for bulk. Then send /export to download results.`);
});

// Progress-enabled handler
bot.on('message', async (msg) => {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return;

  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return;

  const total = lines.length;
  const progressMsg = await bot.sendMessage(chatId, `⏳ Processing ${total} entries... 0/${total}`);

  let done = 0;
  const results = [];

  for (const line of lines) {
    const parts = line.split(',').map(p => p.trim());
    if (parts.length < 3) {
      results.push({ line, status: 'invalid' });
      done++;
      continue;
    }

    const [ssn, dob, zip] = parts;
    // ✅ Save files with .jpg extension
    const filename = `${ssn}_${Date.now()}.jpg`;
    const screenshotPath = path.join(SCREENSHOT_DIR, filename);

    try {
      const { status } = await runAutomation(ssn, dob, zip, screenshotPath);
      results.push({ line, status, screenshot: filename });
    } catch (err) {
      results.push({ line, status: 'error', screenshot: filename });
    }

    done++;
    const barLen = 20, filled = Math.round((done/total)*barLen);
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    await bot.editMessageText(
      `⏳ Processing ${total} entries...\n${bar} ${done}/${total}`,
      { chat_id: chatId, message_id: progressMsg.message_id }
    ).catch(()=>{});
  }

  // Zip and send results
  const zipPath = path.join(__dirname, `screenshots_${Date.now()}.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  output.on('close', async () => {
    try {
      await sendFile(bot, chatId, zipPath); // ✅ robust send
    } catch (e) {
      await bot.sendMessage(chatId, '❌ Failed to send ZIP archive.');
    } finally {
      try { fs.unlinkSync(zipPath); } catch {}
    }

    // Summary
    const counts = { valid: 0, incorrect: 0, unknown: 0, error: 0, invalid: 0 };
    for (const r of results) {
      if (r.status === 'valid') counts.valid++;
      else if (r.status === 'incorrect') counts.incorrect++;
      else if (r.status === 'unknown') counts.unknown++;
      else if (r.status === 'invalid') counts.invalid++;
      else counts.error++;
    }

    let summary = `Processed ${total} entries:
✅ Valid: ${counts.valid}
❌ Incorrect: ${counts.incorrect}
❓ Unknown: ${counts.unknown}
⚠ Errors: ${counts.error}
🚫 Invalid Format: ${counts.invalid}`;

    await bot.sendMessage(chatId, summary);
  });

  archive.pipe(output);
  for (const r of results) {
    if (r.screenshot) {
      const p = path.join(SCREENSHOT_DIR, r.screenshot);
      if (fs.existsSync(p)) archive.file(p, { name: r.screenshot });
    }
  }
  archive.finalize();
});