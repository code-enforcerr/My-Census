require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { runAutomation } = require('./automation');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

bot.setMyCommands([
  { command: '/start', description: 'Start the bot' },
  { command: '/export', description: 'Download all screenshots as ZIP' },
  { command: '/clean', description: 'Clear all saved results' }
]);

const approvedUsers = (process.env.APPROVED_USERS || '').split(',').map(id => id.trim());
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id.toString();

  if (!msg.entities || msg.entities[0].type !== 'bot_command' || msg.text !== '/start') return;
  if (!approvedUsers.includes(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied: You are not an approved user.');

  bot.sendMessage(chatId, `👋 Send data in this format:
SSN,DOB (MM/DD/YYYY),ZIPCODE

📦 Use multiple lines for bulk. Then send /export to download results.`);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  const text = msg.text ? msg.text.trim() : '';

  if (!text || text.startsWith('/')) return;
  if (!approvedUsers.includes(chatId)) return;

  const lines = text.split('\n').filter(Boolean);
  if (lines.length === 0) return;

  await bot.sendMessage(chatId, `⏳ Processing ${lines.length} entries... Please wait.`);

  let results = [];
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 3) {
      results.push({ line, status: 'invalid' });
      continue;
    }

    const [ssn, dob, zip] = parts.map(p => p.trim());
    const timestamp = Date.now();
    const filename = `${ssn}_${timestamp}.png`;
    const screenshotPath = path.join(SCREENSHOT_DIR, filename);

    try {
      const { status } = await runAutomation(ssn, dob, zip, screenshotPath);
      results.push({ line, status, screenshot: filename });
    } catch (err) {
      results.push({ line, status: 'error', screenshot: filename });
    }
  }

  // Create ZIP of this batch's screenshots
  const zipPath = path.join(__dirname, `screenshots_${Date.now()}.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  output.on('close', async () => {
    await bot.sendDocument(chatId, zipPath);

    // Delete ZIP after sending
    fs.unlinkSync(zipPath);

    // Prepare summary counts
    const counts = {
      valid: 0,
      incorrect: 0,
      unknown: 0,
      error: 0,
      invalid: 0
    };

    results.forEach(r => {
      if (r.status === 'valid') counts.valid++;
      else if (r.status === 'incorrect') counts.incorrect++;
      else if (r.status === 'unknown') counts.unknown++;
      else if (r.status === 'invalid') counts.invalid++;
      else counts.error++;
    });

    // Compose summary message (+ format reminder if invalid lines exist)
    let summary =
      `Processed ${lines.length} entries:
✅ Valid: ${counts.valid}
❌ Incorrect: ${counts.incorrect}
❓ Unknown: ${counts.unknown}
⚠ Errors: ${counts.error}
🚫 Invalid Format: ${counts.invalid}` +
      (counts.invalid > 0
        ? `

ℹ Expected format (3 fields, comma-separated):
SSN,DOB (MM/DD/YYYY),ZIPCODE`
        : '');

    await bot.sendMessage(chatId, summary);
  });

  archive.on('error', (err) => {
    console.error(err);
    bot.sendMessage(chatId, '❌ Failed to create ZIP archive.');
  });

  archive.pipe(output);

  // Add all screenshots of this batch only
  results.forEach(r => {
    if (r.screenshot) {
      archive.file(path.join(SCREENSHOT_DIR, r.screenshot), { name: r.screenshot });
    }
  });

  archive.finalize();
});

// Keep your other handlers (/export, /clean) as they are