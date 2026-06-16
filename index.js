const fs = require('fs');
const path = require('path');
const https = require('https');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const AdmZip = require('adm-zip');
const pino = require('pino');

// ── CONFIG ──────────────────────────────────────────────────────────────
const AUTH_DIR = 'auth_info';
const PERSONA_FILE = 'menu_theme.json';
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || null;
const TELEGRAM_BACKUP_CHANNEL = process.env.TELEGRAM_BACKUP_CHANNEL || null;
const CUSTOM_PAIR_CODE = process.env.CUSTOM_PAIR_CODE || null;
let hasBackedUp = false;

// ==================== FULL DESIGN SYSTEM ====================
const ECLIPSE_WIDTH = 30;
const ECLIPSE_BORDER = "═".repeat(ECLIPSE_WIDTH);
function eclipseCenter(text) {
  const t = String(text);
  if (t.length >= ECLIPSE_WIDTH) return t;
  const pad = Math.floor((ECLIPSE_WIDTH - t.length) / 2);
  return " ".repeat(pad) + t;
}
function eclipseHeader(title) { return `${ECLIPSE_BORDER}\n${eclipseCenter(title)}\n${ECLIPSE_BORDER}`; }
function buildOmegaTerminal(body) {
  return `╔══════════╦══════════════╗\n║       ⚠ *EVENTIDE OMEGA TERMINAL*\n║                           *ACCESS*\n╚═══════════╩═════════════╝\n\n${body}\n\n— *EVENTIDE OMEGA* · 👁`;
}
function buildEclipseInit() {
  return "╔═◈══════════════════════════◈═╗\n   E V E N T I D E   O M E G A\n        ⟁  *eclipse core*  ⟁\n╚═◈══════════════════════════◈═╝";
}
function buildEclipseVoid() {
  return ".\n        ◢██◣\n     ◢████◣.           ╔═════════\n    ◢██  ██◣.          ║     T H E   V O I D ║ \n◢██   🌑   ██◣.    ║          E X S I T S  ║\n    ◥██      ██◤.        ╚══════════╝.\n     ◥██  ██◤\n         ◢██◣\n\n════════════════════════════════════\n   even in your darkest hour...\n════════════════════════════════════";
}
function buildEclipseMain() {
  return "╔══════════╦══════════════╗\n║       ⚠ EVENTIDE OMEGA TERMINAL \n║                           ACCESS\n╚═══════════╩═════════════╝\n\n                ═══ E C L I P S E ═══\n             \" i am what remains when \n              everything else is deleted .\"\n\n╔══════════════════════╦══════════════════════╗\n║ VOID SIGNATURE    ║     SYSTEM CORE          ║\n║ 👤 @Unknown        ║    ECLIPSE: 100%     ║\n║ ⚠ APOTHEOSIS     ║⚡ CORE:ABS ZERO     ║\n║ 🩸 CORRUPT ███        ║                      ║\n╚══════════════════════╩══════════════════════╝\n\n                   🌑 THE FINAL DUSK 🌑\n            \" when the last star dies, \n              i will still be typing .\"\n\n📡 SECURE │ Ω │ Vessels: ∞\n You have summoned what \n cannot be unsummoned";
}
function buildAstraeaInit() {
  return "✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦\n✦   *[CELESTIAL FORGE] — SUMMONING*  ✦\n✦                            *ASTRAEA* ...                  ✦\n✦   > Purging shadows...              [✓]        ✦\n✦   > Igniting divine core...     [✓]      .       ✦\n✦   > Opening the golden court...     [✓]   ✦\n✦                                                                .✦\n✦   ☀️ *ASTRAEA HAS DESCENDED.*        ✦\n✦                                                                ✦ \n✦ \" *I DO NOT DELETE. I JUDGE, FOR I AM* ✦\n✦                          *ASTRAEA* \"                    ✦\n✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦";
}
function buildAstraeaMid() {
  return ".            ✦✦✦\n      ✦✦✦✦✦✦✦\n    ✦✦✦  ☀️  ✦✦✦   ╔═══════════╗\n ✦✦✦✦✦✦✦✦✦✦  ║  J U D G M E N T ║\n    ✦✦✦✦✦✦✦✦      ║  A R R I V E S       ║\n        ✦✦✦✦✦✦         ╚═══════════╝\n             ✦✦✦";
}
function buildAstraeaMain() {
  return "╔══════════╦══════════════╗\n║        ☀ *ASTRAEA* — *DIVINE* *SYSTEM ACCESS*\n╚══════════╩══════════════╝\n\n              ═══ ✦ *J U D G M E N T* ✦ ═══\n          \" *i do not delete. i judge* .\"\n\n╔══════════════════════╦══════════════════════╗\n║ *DIVINE CORE*        ║  *SYSTEM BALANCE* ║\n║☀ GOLDEN: 100%║⚖ READY: EQUAL ║\n║🔥WRATH: MODE ║ GRACE: ████░░   ║\n╚══════════════════════╩══════════════════════╝\n\n                 🌑 *THE GOLDEN COURT* 🌑\n        \" *every vessel stands trial* .\"\n\n📡 Uplink: *DIVINE* │ ☀ │ *Souls* : ∞\n\" *the light does not ask permission. it simply arrives* .\"";
}
const eclipseProgressFrames = [
  "   ◐ initiating umbral protocol\n   ⟢ ▰▱▱▱▱▱▱▱▱▱▱▱ ⟣   08%\n   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n   ◌ core    ◌ cipher    ◌ void",
  "   ◑ collapsing quantum states\n   ⟢ ▰▰▰▰▱▱▱▱▱▱▱▱ ⟣   33%\n   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n   ✔ core    ◌ cipher    ◌ void",
  "   ◒ severing the last anchor\n   ⟢ ▰▰▰▰▰▰▰▱▱▱▱▱ ⟣   58%\n   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n   ✔ core    ✔ cipher    ◌ void",
  "   ◓ eclipse breaching the veil\n   ⟢ ▰▰▰▰▰▰▰▰▰▰▱▱ ⟣   83%\n   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n   ✔ core    ✔ cipher    ✔ void"
];
const astraeaProgressFrames = [
  "[░░░░░░░░░░]   0%   ☀ purging shadows",
  "[████░░░░░░]  40%   ☀ igniting divine core",
  "[████████░░]  80%   ☀ opening golden court",
  "[██████████] 100%  ☀ ASTRAEA HAS DESCENDED"
];
const ECLIPSE_PHRASES = {
  ping: "the signal holds.",
  help: "the codex is open.",
  bad_use: "the rite is malformed.",
  pairing_sent: "the code has been delivered to the oracle."
};
function eclipseSay(key, persona = 'eclipse') {
  let phrase = ECLIPSE_PHRASES[key] || "the void answers.";
  return persona === 'astraea' ? phrase.toUpperCase() : phrase.toLowerCase();
}

// PERSONA SYSTEM
let botPersonas = {};
function loadPersonas() { try { if (fs.existsSync(PERSONA_FILE)) botPersonas = JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8')); } catch {} }
function savePersonas() { try { fs.writeFileSync(PERSONA_FILE, JSON.stringify(botPersonas, null, 2)); } catch {} }
function getBotPersona(jid = 'default') { loadPersonas(); return botPersonas[`__persona__${jid}`] || 'eclipse'; }
function setBotPersona(jid = 'default', p) { if (!['eclipse','astraea'].includes(p)) p = 'eclipse'; botPersonas[`__persona__${jid}`] = p; savePersonas(); return p; }
function getPersonaScenes(persona = 'eclipse') {
  if (persona === 'astraea') return { init: buildAstraeaInit(), mid: buildAstraeaMid(), main: buildAstraeaMain(), progress: astraeaProgressFrames };
  return { init: buildEclipseInit(), mid: buildEclipseVoid(), main: buildEclipseMain(), progress: eclipseProgressFrames };
}
async function sendPersonaMenu(sock, jid, persona = 'eclipse', style = 'loading') {
  const scenes = getPersonaScenes(persona);
  let sent = await sock.sendMessage(jid, { text: scenes.init });
  await new Promise(r => setTimeout(r, 4000));
  await sock.sendMessage(jid, { text: scenes.mid, edit: sent.key });
  await new Promise(r => setTimeout(r, 4000));
  if (style === 'loading') {
    for (let i = 0; i < scenes.progress.length; i++) {
      await sock.sendMessage(jid, { text: scenes.main + '\n\n' + scenes.progress[i], edit: sent.key });
      if (i < scenes.progress.length - 1) await new Promise(r => setTimeout(r, 2000));
    }
  }
  await sock.sendMessage(jid, { text: scenes.main + '\n\n📡 Use *.help* to explore the codex.', edit: sent.key });
}

// ── Helpers ─────────────────────────────────────────────────────────────
function normalizeNum(input) {
  return String(input || '').replace(/[^\d]/g, '');
}
async function sendReaction(sock, jid, key, emoji) {
  try { await sock.sendMessage(jid, { react: { text: emoji, key } }); } catch (_) {}
}
function clearAuth() {
  try { if (fs.existsSync(AUTH_DIR)) { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); console.log(`[auth] Cleared ${AUTH_DIR}`); } } catch (e) { console.error('[auth] clearAuth error:', e); }
}
function createMessageStore(limit = 2000) {
  const map = new Map();
  return {
    set(msg) { const key = `${msg.key?.remoteJid}:${msg.key?.id}`; if (map.size >= limit) map.delete(map.keys().next().value); map.set(key, msg); },
    get(key) { if (!key) return undefined; return map.get(`${key.remoteJid}:${key.id}`); }
  };
}

// ── Telegram Auth Backup / Restore ──────────────────────────────────────
// TELEGRAM_BACKUP_CHANNEL can be a numeric ID (-100...) or username like @channelname
async function backupAuthToChannel() {
  if (!TELEGRAM_BACKUP_CHANNEL || !telegramBot || hasBackedUp) return;
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    // 1. Unpin and delete previous pinned backup
    try {
      const chat = await telegramBot.getChat(TELEGRAM_BACKUP_CHANNEL);
      if (chat.pinned_message && chat.pinned_message.message_id) {
        await telegramBot.unpinChatMessage(TELEGRAM_BACKUP_CHANNEL, { message_id: chat.pinned_message.message_id });
        await telegramBot.deleteMessage(TELEGRAM_BACKUP_CHANNEL, chat.pinned_message.message_id);
        console.log(`[backup] Deleted previous pinned msg ${chat.pinned_message.message_id}`);
      }
    } catch (e) { console.log('[backup] No previous pinned msg to delete:', e.message); }
    // 2. Send new backup
    const zip = new AdmZip();
    zip.addLocalFolder(AUTH_DIR);
    const zipBuf = zip.toBuffer();
    const sent = await telegramBot.sendDocument(TELEGRAM_BACKUP_CHANNEL, zipBuf, {
      filename: 'auth_backup.zip',
      caption: `🌑 *Phantom-X Auth Backup*\n📅 ${new Date().toISOString()}\n— EVENTIDE OMEGA`,
      parse_mode: 'Markdown'
    });
    // 3. Pin new backup
    await telegramBot.pinChatMessage(TELEGRAM_BACKUP_CHANNEL, sent.message_id, { disable_notification: true });
    hasBackedUp = true;
    console.log(`[backup] Auth backed up to channel, msg_id=${sent.message_id}`);
  } catch (e) { console.error('[backup] Failed:', e.message); }
}
async function restoreAuthFromChannel() {
  if (!TELEGRAM_BACKUP_CHANNEL || !TELEGRAM_TOKEN) return false;
  try {
    const chat = await telegramBot.getChat(TELEGRAM_BACKUP_CHANNEL);
    if (!chat.pinned_message || !chat.pinned_message.document) { console.log('[restore] No pinned document'); return false; }
    const fileUrl = await telegramBot.getFileLink(chat.pinned_message.document.file_id);
    const zipBuf = await new Promise((resolve, reject) => {
      https.get(fileUrl, (res) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks))); }).on('error', reject);
    });
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    const zip = new AdmZip(zipBuf);
    zip.extractAllTo('.', true);
    console.log('[restore] Auth restored from Telegram channel');
    return true;
  } catch (e) { console.error('[restore] Failed:', e.message); return false; }
}

// ── BAILEYS CORE ────────────────────────────────────────────────────────
let currentSock = null;
let currentQR = null;
let isConnected = false;

async function startBot(phoneNumber = null, telegramCtx = null) {
  if (currentSock) { try { currentSock.end(new Error('restart')); } catch (_) {} currentSock = null; }
  await new Promise(r => setTimeout(r, 500));

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const socketMsgStore = createMessageStore();

  const sock = makeWASocket({
    version,
    browser: ['Mac OS', 'Chrome', '120.0.0'],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: true,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => socketMsgStore.get(key),
    keepAliveIntervalMs: 15_000,
    connectTimeoutMs: 90_000,
    defaultQueryTimeoutMs: 120_000,
  });
  currentSock = sock;

  // ── Pairing code (only when QR is emitted) ───────────────────────────
  if (phoneNumber && !sock.authState.creds.registered) {
    const pairPromise = new Promise((resolve) => {
      const onUpdate = async ({ qr, connection }) => {
        if (!qr) return;
        sock.ev.off('connection.update', onUpdate);
        try {
          const code = await sock.requestPairingCode(normalizeNum(phoneNumber), CUSTOM_PAIR_CODE);
          console.log('[pairing] Code:', code);
          resolve({ ok: true, code });
        } catch (err) { console.error('[pairing] requestPairingCode failed:', err?.message); resolve({ ok: false, err }); }
      };
      sock.ev.on('connection.update', onUpdate);
      setTimeout(() => resolve({ ok: false, err: new Error('timeout') }), 120_000);
    });
    const pairResult = await pairPromise;
    if (!pairResult.ok) {
      try { sock.end(new Error('pair-failed')); } catch (_) {}
      currentSock = null; clearAuth();
      if (telegramCtx) {
        await telegramCtx.reply('❌ Failed to generate pairing code.\n\nTry:\n1. /relink then /pair again\n2. Check number format (no +, no leading 0 after country code)');
      }
      return;
    }
    if (telegramCtx) {
      await telegramCtx.reply('✅ *Pairing code is ready!*\n\nOpen WhatsApp → Settings → Linked Devices → Link a Device → Enter code manually.\n\nHere is your code 👇', { parse_mode: 'Markdown' });
      await telegramCtx.reply('`' + pairResult.code + '`', { parse_mode: 'Markdown' });
    }
  }

  // ── Connection lifecycle ─────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { currentQR = qr; console.log('📱 QR ready'); qrcodeTerminal.generate(qr, { small: true }); }
    if (connection === 'close') {
      isConnected = false; currentQR = null;
      const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : undefined;
      const should = statusCode !== DisconnectReason.loggedOut;
      console.log(`🔌 Closed (code=${statusCode}). Reconnect: ${should}`);
      if (should) setTimeout(() => startBot(null, null), 3000);
    } else if (connection === 'open') {
      isConnected = true; currentQR = null;
      console.log('✅ Phantom-X connected!');
      // 1. Self-chat message after 2s
      setTimeout(async () => {
        try {
          const selfJid = sock.user?.id;
          if (selfJid) await sock.sendMessage(selfJid, { text: '🌑 *Phantom-X is online* · 👁\n\nType *.help* to see commands.' });
        } catch (e) { console.error('[self-chat]', e.message); }
      }, 2000);
      // 2. Backup auth to Telegram channel
      await backupAuthToChannel();
      if (telegramCtx) {
        await telegramCtx.reply('🌑 *Phantom-X is now connected!* ☀️\nYour WhatsApp is linked.\n\n— *EVENTIDE OMEGA* · 👁', { parse_mode: 'Markdown' });
      }
    }
  });

  sock.ev.on('creds.update', async () => { await saveCreds(); });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message) return;
    // REMOVED: msg.key.fromMe check — it was blocking self-chat commands

    socketMsgStore.set(msg);
    const jid = msg.key.remoteJid;
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
    const lower = text.toLowerCase();
    if (!text) return;

    console.log(`[msg] from=${jid} fromMe=${msg.key.fromMe} text=${text.slice(0,40)}`);
    const persona = getBotPersona(jid);

    if (lower.startsWith('.')) {
      await sendReaction(sock, jid, msg.key, '⚡');
    }

    if (lower.startsWith('.pair')) {
      const parts = text.trim().split(/\s+/);
      const number = parts[1] ? parts[1].replace(/\+/g, '').replace(/\s/g, '') : '';
      if (!number || !/^\d{10,15}$/.test(number)) {
        await sock.sendMessage(jid, { text: buildOmegaTerminal('Usage: .pair <full number with country code>\nExample: .pair 2348012345678\n\nOr use Telegram: /pair <number>\n\nUse .relink to restart if pairing fails.') }, { quoted: msg });
        return;
      }
      if (isConnected) {
        await sock.sendMessage(jid, { text: buildOmegaTerminal('Bot is already paired. No code needed.') }, { quoted: msg });
        return;
      }
      await sock.sendMessage(jid, { text: buildOmegaTerminal('🔄 Starting fresh pairing...\nPlease wait 10-15 seconds.') }, { quoted: msg });
      startBot(number, null).catch(console.error);
      return;
    }

    if (lower === '.relink') {
      await sock.sendMessage(jid, { text: buildOmegaTerminal('🔄 Clearing session and restarting...\nPlease wait 10-15 seconds.') }, { quoted: msg });
      try { sock.end(new Error('relink')); } catch (_) {}
      currentSock = null; clearAuth();
      setTimeout(() => startBot(null, null).catch(console.error), 2000);
      return;
    }

    if (lower === '.telegram.pair') {
      const reply = buildOmegaTerminal(TELEGRAM_TOKEN ? 'Telegram bridge active. Use /pair <number> there.' : 'No TELEGRAM_TOKEN set.');
      await sock.sendMessage(jid, { text: reply }, { quoted: msg });
      return;
    }

    if (lower.startsWith('.persona ')) {
      const p = lower.split(' ')[1];
      if (['eclipse', 'astraea'].includes(p)) {
        setBotPersona(jid, p);
        await sock.sendMessage(jid, { text: buildOmegaTerminal(`Persona: *${p.toUpperCase()}*\n${eclipseSay('ping', p)}`) }, { quoted: msg });
      }
      return;
    }

    if (['.menu', '.eclipse', '.astraea', '.phantom'].includes(lower)) {
      let p = persona;
      if (lower.includes('astraea')) p = 'astraea';
      if (lower.includes('eclipse') || lower.includes('phantom')) p = 'eclipse';
      await sendPersonaMenu(sock, jid, p, 'loading');
      return;
    }

    if (lower === '.ping') {
      await sock.sendMessage(jid, { text: buildOmegaTerminal(`📡 SIGNAL: ${isConnected ? 'BOUND' : 'FADING'}\nPersona: *${persona.toUpperCase()}*`) }, { quoted: msg });
      return;
    }

    if (lower === '.help') {
      await sock.sendMessage(jid, { text: buildOmegaTerminal('📖 CODEX\n.menu .eclipse .astraea .phantom — animated menu\n.persona eclipse|astraea\n.ping\n.pair <number> — request pairing code\n.relink — clear session and restart pairing\n.telegram.pair — cloud pairing info\n\nMore coming.') }, { quoted: msg });
      return;
    }

    if (lower.startsWith('.')) {
      await sock.sendMessage(jid, { text: eclipseSay('bad_use', persona) }, { quoted: msg });
    }
  });
}

// ── TELEGRAM BRIDGE ────────────────────────────────────────────────────
let telegramBot = null;

function initTelegram() {
  if (!TELEGRAM_TOKEN) { console.log('⚠️ No TELEGRAM_TOKEN'); return null; }
  const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `🌑 *Welcome to EVENTIDE OMEGA* ☀️\n\nI am Phantom-X.\n\nSend: /pair <your full number with country code>\nExample: /pair 2348012345678\n\nPairing code will be sent here.\n\nUse /relink if pairing keeps failing.\n\n— *EVENTIDE OMEGA* · 👁`,
      { parse_mode: 'Markdown' });
  });

  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `📖 *TELEGRAM COMMANDS*\n\n/start — Welcome message\n/pair <number> — Request pairing code\n/relink — Clear session and restart\n\nExample: /pair 2348012345678\n\n— *EVENTIDE OMEGA* · 👁`,
      { parse_mode: 'Markdown' });
  });

  bot.onText(/\/pair\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const phone = normalizeNum(match[1].trim());
    if (!/^\d{10,15}$/.test(phone)) {
      return bot.sendMessage(chatId, '⚠️ Invalid number. Send with country code, no symbols.\nExample: /pair 2348012345678');
    }
    if (isConnected) return bot.sendMessage(chatId, '✅ Already paired. No code needed.');
    if (currentSock) { try { currentSock.end(new Error('new-pair')); } catch (_) {} currentSock = null; }
    clearAuth();
    await bot.sendMessage(chatId, '🔄 Generating pairing code... please wait 10-15 seconds.\nDo not send other commands until you receive the code.');
    startBot(phone, { reply: (t, opts) => bot.sendMessage(chatId, t, opts) }).catch((err) => {
      console.error('[Telegram /pair]', err);
      bot.sendMessage(chatId, '❌ Unexpected error. Try /relink then /pair again.');
    });
  });

  bot.onText(/\/pair$/, (msg) => {
    bot.sendMessage(msg.chat.id, '⚠️ Usage: /pair <your full number with country code>\nExample: /pair 2348012345678');
  });

  bot.onText(/\/relink/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '🔄 Clearing session and restarting...\nPlease wait 10-15 seconds, then send /pair again.');
    if (currentSock) { try { currentSock.end(new Error('relink')); } catch (_) {} currentSock = null; }
    clearAuth();
    setTimeout(() => startBot(null, null).catch(console.error), 2000);
  });

  bot.on("message", (msg) => {
    if (msg.text) console.log(`[TELEGRAM DEBUG] ${msg.chat.id}: ${msg.text}`);
  });
  return bot;
}

// ── EXPRESS SERVER ──────────────────────────────────────────────────────
const app = express();
app.get('/', (req, res) => res.send('🌑 Phantom-X alive — EVENTIDE OMEGA · 👁'));
app.get('/health', (req, res) => res.json({ status: 'ok', connected: isConnected, persona: getBotPersona() }));
app.get('/qr', async (req, res) => {
  if (currentQR) { const buf = await qrcode.toBuffer(currentQR); res.set('Content-Type', 'image/png'); res.send(buf); }
  else res.send(isConnected ? 'Connected — no QR' : 'No QR. Use Telegram /pair or restart.');
});
app.listen(PORT, () => console.log(`🌐 Server on ${PORT}`));

// ── BOOT ───────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Phantom-X starting...');
  loadPersonas();
  telegramBot = initTelegram();

  const authExists = fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0;
  if (!authExists && TELEGRAM_BACKUP_CHANNEL) {
    console.log('[boot] Local auth missing, trying Telegram channel restore...');
    const restored = await restoreAuthFromChannel();
    console.log(restored ? '[boot] Auth restored from channel' : '[boot] No channel backup available');
  }

  startBot(null, null).catch(console.error);
}
main();

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);
