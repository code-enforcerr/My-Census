// // bot.js
// require('dotenv').config();

// const TelegramBot = require('node-telegram-bot-api');
// const fs = require('fs');
// const fsp = fs.promises;
// const path = require('path');
// const archiver = require('archiver');
// // NOTE: express removed (not needed in polling mode)
// const { runAutomation } = require('./automation');

// // ----- Helpers -----
// function parseEntryLine(raw) {
//   if (!raw) return null;
//   let s = raw.normalize('NFKC')
//     .replace(/\u00A0/g, ' ')        // NBSP -> space
//     .replace(/[，、]/g, ',')         // CJK commas -> comma
//     .replace(/\s+/g, ' ')            // collapse spaces
//     .trim();

//   // Accept comma or pipe
//   const m = s.match(/^\s*([0-9]{3,9})\s*[,|]\s*([0-1]?\d[\/\-][0-3]?\d[\/\-]\d{2,4})\s*[,|]\s*(\d{5}(?:-\d{4})?)\s*$/);
//   if (!m) return null;

//   const ssn = m[1];
//   const [a,b,c] = m[2].split(/[\/\-]/);
//   const yyyy = c.length === 2 ? (Number(c) > 30 ? '19'+c : '20'+c) : c;
//   const dob = `${String(a).padStart(2,'0')}/${String(b).padStart(2,'0')}/${yyyy}`;
//   const zip = m[3];
//   return { ssn, dob, zip, raw: s };
// }

// // --- Fail fast if token is missing ---
// const TOKEN = process.env.TELEGRAM_TOKEN;
// if (!TOKEN) {
//   console.error('❌ TELEGRAM_TOKEN is not set. On Render, add it in Settings → Environment and Restart.');
//   process.exit(1);
// }

// // --- Approved users from env (strings) ---
// const rawApproved = (process.env.APPROVED_USERS || '').trim();
// const approvedUsers = rawApproved.split(',').map(s => s.trim()).filter(Boolean);
// console.log('🔧 ENV DEBUG → APPROVED_USERS (raw):', JSON.stringify(rawApproved));
// console.log('🔧 ENV DEBUG → approvedUsers (parsed):', approvedUsers);
// const isApproved = (id) => approvedUsers.includes(String(id).trim());

// // ---- Writable locations (Render/Vercel) ----
// const TMP_DIR = process.env.TMPDIR || '/tmp';
// const SCREENSHOT_DIR = path.join(TMP_DIR, 'screenshots');
// (async () => { await fsp.mkdir(SCREENSHOT_DIR, { recursive: true }).catch(() => {}); })();

// // ---- Create bot & safe polling (prevents 409 conflicts) ----
// const bot = new TelegramBot(TOKEN, { polling: false });

// // Prevent double-start
// let __botStarted = false;

// async function startPollingSafe() {
//   if (__botStarted) {
//     console.log('⚠️ Polling already started; skipping.');
//     return;
//   }
//   __botStarted = true;

//   try {
//     await bot.stopPolling().catch(() => {});

//     try {
//       const infoBefore = await bot.getWebHookInfo();
//       if (infoBefore && infoBefore.url) {
//         console.log('🔗 Webhook detected, deleting →', infoBefore.url);
//         await bot.deleteWebHook({ drop_pending_updates: true });
//         for (let i = 0; i < 6; i++) {
//           const info = await bot.getWebHookInfo();
//           if (!info.url) break;
//           await new Promise(r => setTimeout(r, 500));
//         }
//       }
//     } catch (e) {
//       console.log('getWebHookInfo/deleteWebHook warning:', e?.message || e);
//     }

//     await bot.startPolling({
//       params: { allowed_updates: ['message'] },
//     });
//     console.log('🤖 Bot polling started.');
//   } catch (e) {
//     console.error('Failed to start polling:', e?.message || e);
//   }
// }
// startPollingSafe();

// // Clean shutdown
// async function stopPollingSafe() {
//   try { await bot.stopPolling(); } catch {}
// }
// process.once('SIGTERM', async () => { console.log('🛑 SIGTERM'); await stopPollingSafe(); process.exit(0); });
// process.once('SIGINT',  async () => { console.log('🛑 SIGINT');  await stopPollingSafe(); process.exit(0); });

// // Auto-recover from 409
// bot.on('polling_error', async (err) => {
//   const msg = err?.response?.body || err?.message || String(err);
//   console.error('error: [polling_error]', msg);
//   if (err?.code === 'ETELEGRAM' && /409/.test(msg)) {
//     console.log('🔁 409 detected: attempting recovery…');
//     try {
//       await bot.stopPolling().catch(() => {});
//       await bot.deleteWebHook({ drop_pending_updates: false }).catch(() => {});
//       await new Promise(r => setTimeout(r, 1500));
//       await bot.startPolling({ params: { allowed_updates: ['message'] } });
//       console.log('✅ Recovered from 409; polling restarted.');
//     } catch (e) {
//       console.error('❌ 409 recovery failed:', e?.message || e);
//     }
//   }
// });

// // ---- Commands ----
// bot.setMyCommands([
//   { command: '/start',   description: 'Start the bot' },
//   { command: '/export',  description: 'Download all screenshots as ZIP' },
//   { command: '/clean',   description: 'Clear all saved results' },
//   { command: '/whoami',  description: 'Show your chat id' },
//   { command: '/status',  description: 'Service status & counters' }
// ]);

// bot.onText(/^\/whoami$/, (msg) => {
//   const cid = String(msg.chat.id);
//   const uname = msg.from?.username ? '@' + msg.from.username : '';
//   console.log('🔧 /whoami →', cid, uname);
//   bot.sendMessage(cid, `chat_id: ${cid} ${uname}`);
// });

// bot.onText(/^\/start$/, (msg) => {
//   const chatId = String(msg.chat.id);
//   if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied: You are not an approved user.');
//   bot.sendMessage(chatId, `👋 *Welcome!*

// 📌 Send your data in this format:
// \`SSN,DOB (MM/DD/YYYY),ZIPCODE\`

// 📦 Use multiple lines for bulk.

// ⚠️ *Important:*
// - Send a maximum of *30 entries per section*.
// - Always run /clean before starting a new section.

// Then send /export to download results.`,
//     { parse_mode: 'Markdown' }
//   );
// });

// bot.onText(/^\/clean$/, async (msg) => {
//   const chatId = String(msg.chat.id);
//   if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');
//   try {
//     const items = await fsp.readdir(SCREENSHOT_DIR);
//     await Promise.all(items.map(i => fsp.unlink(path.join(SCREENSHOT_DIR, i)).catch(() => {})));
//     await bot.sendMessage(chatId, '🧹 Cleaned stored screenshots.');
//   } catch (e) {
//     console.error('clean error', e);
//     await bot.sendMessage(chatId, '⚠️ Could not clean screenshots.');
//   }
// });

// bot.onText(/^\/export$/, async (msg) => {
//   const chatId = String(msg.chat.id);
//   if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');
//   const files = (await fsp.readdir(SCREENSHOT_DIR).catch(() => []))
//     .map(n => path.join(SCREENSHOT_DIR, n))
//     .filter(fp => (fp.endsWith('.jpg') || fp.endsWith('.png')) && fs.existsSync(fp));
//   await sendZipArchive(bot, chatId, files, 'screenshots');
// });

// // ---- /status ----
// function formatBytes(n) {
//   if (!Number.isFinite(n)) return `${n}`;
//   const units = ['B','KB','MB','GB','TB'];
//   let i = 0;
//   while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
//   return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
// }
// function formatUptime(seconds) {
//   const h = Math.floor(seconds / 3600);
//   const m = Math.floor((seconds % 3600) / 60);
//   const s = Math.floor(seconds % 60);
//   return `${h}h ${m}m ${s}s`;
// }
// bot.onText(/^\/status$/, async (msg) => {
//   const chatId = String(msg.chat.id);
//   if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');

//   try {
//     const names = await fsp.readdir(SCREENSHOT_DIR).catch(() => []);
//     const images = names.filter(n => /\.(jpe?g|png)$/i.test(n));
//     const notes  = names.filter(n => /\.txt$/i.test(n));

//     let totalSize = 0;
//     for (const n of images) {
//       try { const st = await fsp.stat(path.join(SCREENSHOT_DIR, n)); totalSize += st.size; } catch {}
//     }

//     const mem = process.memoryUsage();
//     const targetUrlSet = !!(process.env.TARGET_URL && /^https?:\/\//i.test(process.env.TARGET_URL));

//     const report =
// `🩺 *Service Status*
// • Uptime: ${formatUptime(process.uptime())}
// • Memory (RSS): ${formatBytes(mem.rss)}  (Heap: ${formatBytes(mem.heapUsed)}/${formatBytes(mem.heapTotal)})

// 🗂 *Storage*
// • Screenshots: ${images.length} file${images.length===1?'':'s'} (${formatBytes(totalSize)})
// • Error notes: ${notes.length} file${notes.length===1?'':'s'}
// • TMP_DIR: \`${TMP_DIR}\`
// • SCREENSHOT_DIR: \`${SCREENSHOT_DIR}\`

// 🔧 *Config*
// • APPROVED_USERS: ${approvedUsers.length}
// • TARGET_URL set: ${targetUrlSet ? '✅' : '❌'}
// `;

//     await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
//   } catch (e) {
//     console.error('/status error', e);
//     await bot.sendMessage(chatId, '⚠️ Failed to gather status.');
//   }
// });

// // ---- Message handler (bulk processing with progress) ----
// bot.on('message', async (msg) => {
//   const chatId = String(msg.chat.id);
//   const text = (msg.text || '').trim();
//   if (!text || text.startsWith('/')) return; // commands handled elsewhere
//   if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied: You are not an approved user.');

//   console.log(`🔧 MSG from ${chatId} text=${JSON.stringify(text.slice(0, 80))}`);

//   const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
//   const batchId = Date.now().toString();
//   const lines = [];
//   const invalidLines = [];

//   for (const raw of rawLines) {
//     const parsed = parseEntryLine(raw);
//     if (parsed) lines.push(parsed);
//     else invalidLines.push(raw);
//   }
//   if (lines.length === 0) {
//     return bot.sendMessage(chatId, '⚠️ No valid lines found. Expected: SSN,DOB(MM/DD/YYYY),ZIP.');
//   }

//   if (lines.length > 30) {
//     return bot.sendMessage(chatId, `🚫 You submitted *${lines.length} entries*.

// ⚠️ Maximum allowed is *30 entries per section*.
// 🧹 Please run /clean, then resend your data in smaller chunks.`,
//       { parse_mode: 'Markdown' }
//     );
//   }

//   const total = lines.length;
//   const startedAt = Date.now();

//   const progressMsg = await bot.sendMessage(chatId, `⏳ Processing ${total} entries... 0/${total}`);

//   let lastEdit = 0;
//   const maybeUpdateProgress = async (done) => {
//     const now = Date.now();
//     if (done === total || now - lastEdit >= 1200) {
//       const elapsed = Math.round((now - startedAt) / 1000);
//       const barLen = 20;
//       const filled = Math.max(0, Math.min(barLen, Math.round((done / total) * barLen)));
//       const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
//       await bot.editMessageText(
//         `⏳ Processing ${total} entries...\n${bar} ${done}/${total}\n⏱️ ${elapsed}s elapsed`,
//         { chat_id: chatId, message_id: progressMsg.message_id }
//       ).catch(() => {});
//       lastEdit = now;
//     }
//   };

//   const results = [];
//   let done = 0;

//   await fsp.mkdir(SCREENSHOT_DIR, { recursive: true }).catch(() => {});

//   for (const { ssn, dob, zip, raw } of lines) {
//     const requested = path.join(SCREENSHOT_DIR, `${batchId}_${ssn}.jpg`);

//     try {
//       const { status, screenshotPath: realPath } = await runAutomation(ssn, dob, zip, requested);
//       results.push({ line: raw, status, path: realPath, name: path.basename(realPath) });
//     } catch (err) {
//       console.error('runAutomation error for', raw, err?.message || err);
//       results.push({ line: raw, status: 'error', path: requested, name: path.basename(requested) });
//     }

//     done++;
//     await maybeUpdateProgress(done);
//   }

//   await bot.editMessageText(
//     `Processing ${total} entries...  ${total}/${total}`,
//     { chat_id: chatId, message_id: progressMsg.message_id }
//   ).catch(() => {});

//   const groups = {
//     valid:     results.filter(r => r.status === 'valid'),
//     incorrect: results.filter(r => r.status === 'incorrect'),
//     unknown:   results.filter(r => r.status === 'unknown'),
//     error:     results.filter(r => r.status === 'error'),
//   };
//   for (const [label, arr] of Object.entries(groups)) {
//     const files = arr
//       .map(r => r.path)
//       .filter(fp => fp && fs.existsSync(fp));
//     if (files.length) await sendZipArchive(bot, chatId, files, `screenshots-${label}`);
//   }

//   const counts = { valid: 0, incorrect: 0, unknown: 0, error: 0, invalid: invalidLines.length };
//   for (const r of results) {
//     if (r.status === 'valid') counts.valid++;
//     else if (r.status === 'incorrect') counts.incorrect++;
//     else if (r.status === 'unknown') counts.unknown++;
//     else counts.error++;
//   }

//   let summary =
// `Processed ${total} entries:
// ✅ Valid: ${counts.valid}
// ❌ Incorrect: ${counts.incorrect}
// ❓ Unknown: ${counts.unknown}
// ⚠ Errors: ${counts.error}
// 🚫 Invalid Format: ${counts.invalid}`;
//   if (counts.invalid > 0) {
//     summary += `

// Skipped lines:
// • ${invalidLines.slice(0, 5).join('\n• ')}${invalidLines.length > 5 ? '\n• …' : ''}

// ℹ Expected format (comma or pipe):
// SSN,DOB (MM/DD/YYYY),ZIPCODE`;
//   }
//   await bot.sendMessage(chatId,
//   summary + `

// ⚠️ *Reminder:*
// - Maximum of 30 entries per section
// - Run /clean before starting a new section`,
//   { parse_mode: 'Markdown' }
// );
// });

// // ---- ZIP utility ----
// async function sendZipArchive(bot, chatId, filePaths, baseName = 'screenshots') {
//   if (!filePaths.length) {
//     await bot.sendMessage(chatId, `ℹ️ No files to export for ${baseName}.`);
//     return;
//   }
//   const ts = new Date().toISOString().replace(/[:.]/g, '-');
//   const zipPath = path.join(TMP_DIR, `${baseName}-${ts}.zip`);

//   await new Promise((resolve, reject) => {
//     const output = fs.createWriteStream(zipPath);
//     const archive = archiver('zip', { zlib: { level: 9 } });

//     output.on('close', resolve);
//     output.on('error', reject);
//     archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
//     archive.on('error', reject);

//     archive.pipe(output);

//     for (const fp of filePaths) {
//       if (fs.existsSync(fp)) {
//         archive.file(fp, { name: path.basename(fp) });
//         const note = fp.replace(/\.(png|jpg|jpeg)$/i, '.txt');
//         if (fs.existsSync(note)) {
//           archive.file(note, { name: path.basename(note) });
//         }
//       }
//     }

//     archive.finalize();
//   });

//   const { size } = await fsp.stat(zipPath);
//   if (size >= 49 * 1024 * 1024) {
//     try { await fsp.unlink(zipPath); } catch {}
//     await bot.sendMessage(chatId, '❌ ZIP is too large for Telegram. Try fewer entries.');
//     return;
//   }

//   try {
//     await bot.sendDocument(
//       chatId,
//       fs.createReadStream(zipPath),
//       { caption: `Export (${filePaths.length} file${filePaths.length === 1 ? '' : 's'})` },
//       { filename: path.basename(zipPath), contentType: 'application/zip' }
//     );
//   } catch (e) {
//     console.error('sendDocument failed:', e?.message || e);
//     await bot.sendMessage(chatId, '❌ Failed to send ZIP archive.');
//   } finally {
//     try { await fsp.unlink(zipPath); } catch {}
//   }
// }






// bot.js
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const archiver = require('archiver');
const { runAutomation } = require('./automation');

// ================== Config knobs ==================
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);                // parallel entries
const ENTRY_TIMEOUT_MS = parseInt(process.env.ENTRY_TIMEOUT_MS || '80000', 10);  // per entry timeout
const RETRY_ERRORS = parseInt(process.env.RETRY_ERRORS || '1', 10);              // retry passes
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || '2000', 10);       // delay before retry pass
const MAX_ENTRIES = parseInt(process.env.MAX_ENTRIES || '70', 10);               // per-batch cap
// =================================================

// ---------- Helpers ----------
function parseEntryLine(raw) {
  if (!raw) return null;
  let s = raw.normalize('NFKC')
    .replace(/\u00A0/g, ' ')
    .replace(/[，、]/g, ',')
    .replace(/\s+/g, ' ')
    .trim();

  const m = s.match(/^\s*([0-9]{3,9})\s*[,|]\s*([0-1]?\d[\/\-][0-3]?\d[\/\-]\d{2,4})\s*[,|]\s*(\d{5}(?:-\d{4})?)\s*$/);
  if (!m) return null;

  const ssn = m[1];
  const [a,b,c] = m[2].split(/[\/\-]/);
  const yyyy = c.length === 2 ? (Number(c) > 30 ? '19'+c : '20'+c) : c;
  const dob = `${String(a).padStart(2,'0')}/${String(b).padStart(2,'0')}/${yyyy}`;
  const zip = m[3];
  return { ssn, dob, zip, raw: s };
}

function pLimit(n) {
  const queue = [];
  let active = 0;
  const next = () => { active--; if (queue.length) queue.shift()(); };
  return fn => new Promise((resolve, reject) => {
    const run = () => fn().then(resolve, reject).finally(next);
    if (active < n) { active++; run(); } else { queue.push(run); }
  });
}

function withTimeout(promise, ms, label = 'task') {
  let t;
  const timer = new Promise((_, rej) => t = setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms));
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Fail fast if token is missing ---
const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) {
  console.error('❌ TELEGRAM_TOKEN is not set.');
  process.exit(1);
}

// --- Approved users ---
const rawApproved = (process.env.APPROVED_USERS || '').trim();
const approvedUsers = rawApproved.split(',').map(s => s.trim()).filter(Boolean);
console.log('🔧 ENV DEBUG → approvedUsers:', approvedUsers);
const isApproved = (id) => approvedUsers.includes(String(id).trim());

// ---- Writable dirs (global root) ----
const TMP_DIR = process.env.TMPDIR || '/tmp';
const SCREENSHOT_ROOT = path.join(TMP_DIR, 'screenshots');
(async () => { await fsp.mkdir(SCREENSHOT_ROOT, { recursive: true }).catch(() => {}); })();

// ---- Per-chat & per-batch helpers ----
function chatDir(chatId) {
  return path.join(SCREENSHOT_ROOT, `chat_${chatId}`);
}
async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true }).catch(() => {});
}
async function makeBatchDir(chatId, batchId) {
  const dir = path.join(chatDir(chatId), `batch_${batchId}`);
  await ensureDir(dir);
  return dir;
}
async function listBatches(chatId) {
  const dir = chatDir(chatId);
  const names = await fsp.readdir(dir).catch(() => []);
  const items = await Promise.all(names.map(async n => {
    const p = path.join(dir, n);
    const st = await fsp.stat(p).catch(() => null);
    return st?.isDirectory() ? { name: n, path: p, mtime: st.mtimeMs } : null;
  }));
  return items.filter(Boolean).sort((a,b)=>b.mtime - a.mtime);
}
async function listAllImagesForChat(chatId) {
  const batches = await listBatches(chatId);
  let count = 0;
  for (const b of batches) {
    const files = await fsp.readdir(b.path).catch(() => []);
    count += files.filter(n => /\.(jpe?g|png)$/i.test(n)).length;
  }
  return count;
}

// ---- Bot setup ----
const bot = new TelegramBot(TOKEN, { polling: false });
let __botStarted = false;

async function startPollingSafe() {
  if (__botStarted) return;
  __botStarted = true;
  try {
    await bot.stopPolling().catch(() => {});
    await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
    await bot.startPolling({ params: { allowed_updates: ['message'] } });
    console.log('🤖 Bot polling started.');
  } catch (e) { console.error('Polling failed:', e?.message || e); }
}
startPollingSafe();

process.once('SIGTERM', async () => { await bot.stopPolling(); process.exit(0); });
process.once('SIGINT',  async () => { await bot.stopPolling(); process.exit(0); });

bot.on('polling_error', async (err) => {
  const msg = err?.response?.body || err?.message || String(err);
  if (err?.code === 'ETELEGRAM' && /409/.test(msg)) {
    console.log('🔁 409 conflict, retrying polling…');
    await bot.stopPolling().catch(() => {});
    await bot.deleteWebHook({ drop_pending_updates: false }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    await bot.startPolling({ params: { allowed_updates: ['message'] } });
  }
});

// ---- Commands ----
bot.setMyCommands([
  { command: '/start', description: 'Start the bot' },
  { command: '/export', description: 'Download latest batch (this chat only)' },
  { command: '/clean', description: 'Clear your saved results' },
  { command: '/whoami', description: 'Show your chat id' },
  { command: '/status', description: 'Service status & counters' }
]);

bot.onText(/^\/whoami$/, (msg) => {
  const cid = String(msg.chat.id);
  bot.sendMessage(cid, `chat_id: ${cid}`);
});

bot.onText(/^\/start$/, (msg) => {
  const chatId = String(msg.chat.id);
  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');
  bot.sendMessage(
    chatId,
    `👋 Welcome! Send data in format:
\`SSN,DOB (MM/DD/YYYY),ZIPCODE\`
(max ${MAX_ENTRIES} entries). Use /export to download the latest batch.`,
    { parse_mode: 'Markdown' }
  );
});

// Clean ONLY this chat’s files
bot.onText(/^\/clean$/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');
  const dir = chatDir(chatId);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await bot.sendMessage(chatId, '🧹 Cleaned your screenshots.');
});

// Export ONLY the latest batch for this chat
bot.onText(/^\/export$/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');

  const batches = await listBatches(chatId);
  if (!batches.length) return bot.sendMessage(chatId, 'ℹ️ No batches to export.');

  const latest = batches[0].path;
  const files = (await fsp.readdir(latest).catch(() => []))
    .map(n => path.join(latest, n))
    .filter(fp => /\.(jpe?g|png|txt)$/i.test(fp) && fs.existsSync(fp));

  await sendZipArchive(bot, chatId, files, path.basename(latest));
});

// ---- Status ----
function formatBytes(n) {
  const units = ['B','KB','MB','GB']; let i=0;
  while (n>=1024 && i<units.length-1) { n/=1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}
function formatUptime(sec) {
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=Math.floor(sec%60);
  return `${h}h ${m}m ${s}s`;
}
bot.onText(/^\/status$/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');
  const imagesCount = await listAllImagesForChat(chatId).catch(() => 0);
  const mem = process.memoryUsage();
  await bot.sendMessage(chatId,
`🩺 Status
• Uptime: ${formatUptime(process.uptime())}
• Memory (RSS): ${formatBytes(mem.rss)}
• Your screenshots: ${imagesCount}
• Concurrency: ${CONCURRENCY}, Timeout: ${ENTRY_TIMEOUT_MS/1000}s, Retries: ${RETRY_ERRORS}
• Max entries per batch: ${MAX_ENTRIES}`);
});

// ---- Message handler (main batch processing) ----
bot.on('message', async (msg) => {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return;
  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');

  const rawLines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const batchId = Date.now().toString();
  const lines = [], invalid=[];
  for (const raw of rawLines) {
    const p=parseEntryLine(raw); if(p) lines.push(p); else invalid.push(raw);
  }
  if (!lines.length) return bot.sendMessage(chatId,'⚠️ No valid lines found.');
  if (lines.length > MAX_ENTRIES) {
    return bot.sendMessage(chatId, `🚫 Too many entries (${lines.length}), max ${MAX_ENTRIES}.`);
  }

  // Create per-batch directory (isolates exports)
  const batchDir = await makeBatchDir(chatId, batchId);
  const filesThisRun = [];

  const total = lines.length;
  const progressMsg = await bot.sendMessage(chatId,`⏳ Processing ${total} entries...`);

  let done=0, lastEdit=0;
  const maybeUpdate = async ()=> {
    const now=Date.now();
    if(done===total || now-lastEdit>=1200){
      await bot.editMessageText(`⏳ ${done}/${total} done`,{chat_id:chatId,message_id:progressMsg.message_id}).catch(()=>{});
      lastEdit=now;
    }
  };

  const results = Array(total);
  const limit=pLimit(CONCURRENCY);

  // ---- First pass ----
  const tasks = lines.map(({ssn,dob,zip,raw},i)=>limit(async()=>{
    const requested = path.join(batchDir, `${ssn}.jpg`);
    try{
      const {status,screenshotPath:real} =
        await withTimeout(runAutomation(ssn,dob,zip,requested),ENTRY_TIMEOUT_MS,`runAutomation(${ssn})`);
      results[i] = { line: raw, status, path: real, name: path.basename(real), attempt: 1 };
      if (real && fs.existsSync(real)) filesThisRun.push(real);
    }catch(e){
      results[i] = { line: raw, status:'error', path: requested, name: path.basename(requested), attempt: 1 };
      // No file pushed on error unless runAutomation wrote one.
      if (fs.existsSync(requested)) filesThisRun.push(requested);
    }finally{ done++; await maybeUpdate(); }
  }));
  await Promise.allSettled(tasks);

  // ---- Retry passes ----
  for(let pass=1; pass<=RETRY_ERRORS; pass++){
    const toRetry = results.map((r,i)=>(r && r.status==='error' ? i : -1)).filter(i=>i>=0);
    if(!toRetry.length) break;
    await bot.sendMessage(chatId,`🔁 Retrying ${toRetry.length} failed entr${toRetry.length===1?'y':'ies'} (pass ${pass})...`);
    await sleep(RETRY_DELAY_MS);

    const retryTasks = toRetry.map(i=>limit(async()=>{
      const { ssn, dob, zip, raw } = lines[i];
      const requested = path.join(batchDir, `${ssn}_retry${pass}.jpg`);
      try{
        const { status, screenshotPath: real } =
          await withTimeout(runAutomation(ssn,dob,zip,requested),ENTRY_TIMEOUT_MS,`retry(${ssn})`);
        results[i] = { line: raw, status, path: real, name: path.basename(real), attempt: pass+1, retried: true };
        if (real && fs.existsSync(real)) filesThisRun.push(real);
      }catch(e){
        // Keep previous error result; add attempt count
        results[i] = { ...results[i], attempt: pass+1, retried: true };
        if (fs.existsSync(requested)) filesThisRun.push(requested);
      }
    }));
    await Promise.allSettled(retryTasks);
  }

  // ---- Summary ----
  const counts={valid:0,incorrect:0,unknown:0,error:0,invalid:invalid.length};
  for(const r of results){
    if(r.status==='valid') counts.valid++;
    else if(r.status==='incorrect') counts.incorrect++;
    else if(r.status==='unknown') counts.unknown++;
    else if(r.status==='error') counts.error++;
  }
  await bot.sendMessage(chatId,
`✅ Valid: ${counts.valid}
❌ Incorrect: ${counts.incorrect}
❓ Unknown: ${counts.unknown}
⚠️ Errors: ${counts.error}
🚫 Invalid: ${counts.invalid}`);

  // ---- Auto-export ONLY this run (optional; keep it) ----
  const exportList = filesThisRun.filter(fp => fs.existsSync(fp));
  if (exportList.length) {
    await sendZipArchive(bot, chatId, exportList, `screenshots-${batchId}`);
  }
});

// ---- ZIP utility ----
async function sendZipArchive(bot, chatId, filePaths, baseName='screenshots'){
  if(!filePaths.length) return bot.sendMessage(chatId,`ℹ️ No files to export.`);
  const ts=new Date().toISOString().replace(/[:.]/g,'-');
  const zipPath=path.join(TMP_DIR,`${baseName}-${ts}.zip`);
  await new Promise((res,rej)=>{
    const output=fs.createWriteStream(zipPath);
    const archive=archiver('zip',{zlib:{level:9}});
    output.on('close',res); output.on('error',rej);
    archive.on('error',rej);
    archive.pipe(output);
    for(const fp of filePaths) if(fs.existsSync(fp)) archive.file(fp,{name:path.basename(fp)});
    archive.finalize();
  });
  const {size}=await fsp.stat(zipPath);
  if(size>=49*1024*1024){await fsp.unlink(zipPath).catch(()=>{}); return bot.sendMessage(chatId,'❌ ZIP too large.');}
  await bot.sendDocument(chatId,fs.createReadStream(zipPath),{caption:`Export (${filePaths.length} files)`},{filename:path.basename(zipPath),contentType:'application/zip'});
  await fsp.unlink(zipPath).catch(()=>{});
}