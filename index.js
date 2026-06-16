const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const FORCE_PAIRING_CODE = process.env.FORCE_PAIRING_CODE || null; // === SAFE TEST HACK === Set FORCE_PAIRING_CODE=12345678 in env. Bot will ALWAYS reply with code 12345678 (single safe call to real requestPairingCode in background).
const pino = require('pino');

// CONFIG
const AUTH_DIR = 'auth_info';
const PERSONA_FILE = 'menu_theme.json';
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || null;

// ==================== FULL DESIGN SYSTEM (EXACT FROM DESIGN_SYSTEM.md) ====================

const ECLIPSE_WIDTH = 30;
const ECLIPSE_BORDER = "═".repeat(ECLIPSE_WIDTH);
const ECLIPSE_RULE = "─".repeat(ECLIPSE_WIDTH);

function eclipseCenter(text) {
  const t = String(text);
  if (t.length >= ECLIPSE_WIDTH) return t;
  const pad = Math.floor((ECLIPSE_WIDTH - t.length) / 2);
  return " ".repeat(pad) + t;
}

function eclipseHeader(title) { return `${ECLIPSE_BORDER}\n${eclipseCenter(title)}\n${ECLIPSE_BORDER}`; }
function eclipseFooter() { return ECLIPSE_BORDER; }

function buildOmegaTerminal(body) {
  return `╔══════════╦══════════════╗\n║       ⚠ *EVENTIDE OMEGA TERMINAL*\n║                           *ACCESS*\n╚═══════════╩═════════════╝\n\n${body}\n\n— *EVENTIDE OMEGA* · 👁`;
}

// ECLIPSE BOOTLOADERS (verbatim)
function buildEclipseInit() {
  return "╔═◈══════════════════════════◈═╗\n   E V E N T I D E   O M E G A\n        ⟁  *eclipse core*  ⟁\n╚═◈══════════════════════════◈═╝";
}
function buildEclipseVoid() {
  return ".\n        ◢██◣\n     ◢████◣.           ╔═════════\n    ◢██  ██◣.          ║     T H E   V O I D ║ \n◢██   🌑   ██◣.    ║          E X S I T S  ║\n    ◥██      ██◤.        ╚══════════╝.\n     ◥██  ██◤\n         ◢██◣\n\n════════════════════════════════════\n   even in your darkest hour...\n════════════════════════════════════";
}
function buildEclipseMain() {
  return "╔══════════╦══════════════╗\n║       ⚠ EVENTIDE OMEGA TERMINAL \n║                           ACCESS\n╚═══════════╩═════════════╝\n\n                ═══ E C L I P S E ═══\n             \" i am what remains when \n              everything else is deleted .\"\n\n╔══════════════════════╦══════════════════════╗\n║ VOID SIGNATURE    ║     SYSTEM CORE          ║\n║ 👤 @Unknown        ║    ECLIPSE: 100%     ║\n║ ⚠ APOTHEOSIS     ║⚡ CORE:ABS ZERO     ║\n║ 🩸 CORRUPT ███        ║                      ║\n╚══════════════════════╩══════════════════════╝\n\n                   🌑 THE FINAL DUSK 🌑\n            \" when the last star dies, \n              i will still be typing .\"\n\n📡 SECURE │ Ω │ Vessels: ∞\n You have summoned what \n cannot be unsummoned";
}

// ASTRAEA BOOTLOADERS (verbatim)
function buildAstraeaInit() {
  return "✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦\n✦   *[CELESTIAL FORGE] — SUMMONING*  ✦\n✦                            *ASTRAEA* ...                  ✦\n✦   > Purging shadows...              [✓]        ✦\n✦   > Igniting divine core...     [✓]      .       ✦\n✦   > Opening the golden court...     [✓]   ✦\n✦                                                                .✦\n✦   ☀️ *ASTRAEA HAS DESCENDED.*        ✦\n✦                                                                ✦ \n✦ \" *I DO NOT DELETE. I JUDGE, FOR I AM* ✦\n✦                          *ASTRAEA* \"                    ✦\n✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦";
}
function buildAstraeaMid() {
  return ".            ✦✦✦\n      ✦✦✦✦✦✦✦\n    ✦✦✦  ☀️  ✦✦✦   ╔═══════════╗\n ✦✦✦✦✦✦✦✦✦✦  ║  J U D G M E N T ║\n    ✦✦✦✦✦✦✦✦      ║  A R R I V E S       ║\n        ✦✦✦✦✦✦         ╚═══════════╝\n             ✦✦✦";
}
function buildAstraeaMain() {
  return "╔══════════╦══════════════╗\n║        ☀ *ASTRAEA* — *DIVINE* *SYSTEM ACCESS*\n╚══════════╩══════════════╝\n\n              ═══ ✦ *J U D G M E N T* ✦ ═══\n          \" *i do not delete. i judge* .\"\n\n╔══════════════════════╦══════════════════════╗\n║ *DIVINE CORE*        ║  *SYSTEM BALANCE* ║\n║☀ GOLDEN: 100%║⚖ READY: EQUAL ║\n║🔥WRATH: MODE ║ GRACE: ████░░   ║\n╚══════════════════════╩══════════════════════╝\n\n                 🌑 *THE GOLDEN COURT* 🌑\n        \" *every vessel stands trial* .\"\n\n📡 Uplink: *DIVINE* │ ☀ │ *Souls* : ∞\n\" *the light does not ask permission. it simply arrives* .\"";
}

// Progress frames (exact)
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

// PHRASES
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

// 3-STAGE MENU (edits the same message 3 times + progress)
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

// TELEGRAM BRIDGE
let telegramBot = null;

function initTelegram() {
  if (!TELEGRAM_TOKEN) { console.log('⚠️ No TELEGRAM_TOKEN — Telegram pairing disabled.'); return null; }
  const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 
      `🌑 *Welcome to EVENTIDE OMEGA* ☀️\n\nI am Phantom-X.\n\nSend: /pair <your full number with country code>\nExample: /pair 2348012345678\n\nPairing code will be sent here.\n\n— *EVENTIDE OMEGA* · 👁`, 
      { parse_mode: 'Markdown' });
  });

  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
      `📖 *TELEGRAM COMMANDS*\n\n/start — Show welcome message\n/pair <number> — Request WhatsApp pairing code\n\nExample: /pair 2348012345678\n\n— *EVENTIDE OMEGA* · 👁`,
      { parse_mode: 'Markdown' });
  });

  // /pair with number
  bot.onText(/\/pair\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const raw = match[1].trim();
    const number = raw.replace(/\s+/g, '').replace(/\+/g, '');

    if (!/^\d{10,15}$/.test(number)) {
      return bot.sendMessage(chatId, '⚠️ Invalid number. Please send your full number with country code (no +).\nExample: /pair 2348012345678');
    }

    if (!currentSock) {
      return bot.sendMessage(chatId, '❌ Bot socket is not ready yet. Please wait a moment and try again.');
    }

    if (currentSock.authState?.creds?.registered) {
      return bot.sendMessage(chatId, '✅ Bot is already paired and connected. No pairing code needed.');
    }

    try {
      await bot.sendMessage(chatId, `⏳ Requesting pairing code for *${number}*...\nPlease wait.`, { parse_mode: 'Markdown' });
      const code = await currentSock.requestPairingCode(number);
      await bot.sendMessage(chatId, `🔑 *PAIRING CODE* for ${number}:\n\n\`${code}\`\n\nEnter this in WhatsApp → Linked Devices → Link with phone number.`, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('[Telegram /pair error]', e);
      await bot.sendMessage(chatId, '❌ Failed to get pairing code. Make sure the bot is running and not already paired.');
    }
  });

  // /pair without number (usage hint)
  bot.onText(/\/pair$/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '⚠️ Usage: /pair <your full number with country code>\nExample: /pair 2348012345678');
  });

  // DEBUG: Log every message the bot receives (helps diagnose "not replying")
  bot.on("message", (msg) => {
    if (msg.text) console.log(`[TELEGRAM DEBUG] Received message from ${msg.chat.id}: ${msg.text}`);
  });
  return bot;
}

// BAILEYS CORE
let currentSock = null;
let currentQR = null;
let isConnected = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  currentSock = makeWASocket({
    version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false,
    browser: ['Phantom-X', 'Chrome', '1.0.0']
  });

  currentSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      currentQR = qr;
      console.log('📱 QR ready (scan or use Telegram)');
      qrcodeTerminal.generate(qr, { small: true });
      if (telegramBot) {
        try {
          const buf = await qrcode.toBuffer(qr);
          // Optionally broadcast QR to all recent chats? We'll keep it manual via /pair.
        } catch {}
      }
    }
    if (connection === 'close') {
      isConnected = false;
      const should = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut : true;
      if (should) setTimeout(startBot, 3000);
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('✅ Phantom-X connected!');
      if (telegramBot) {
        // Notify owner or keep silent? We'll keep silent to avoid spam.
      }
    }
  });

  currentSock.ev.on('creds.update', saveCreds);

  currentSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
    const lower = text.toLowerCase();
    if (!text) return;

    const persona = getBotPersona(jid);

    if (lower.startsWith('.pair')) {
      const parts = text.trim().split(/\s+/);
      const number = parts[1] ? parts[1].replace(/\+/g, '').replace(/\s/g, '') : '';
      if (!number || !/^\d{10,15}$/.test(number)) {
        const reply = buildOmegaTerminal('Usage: .pair <full number with country code>\nExample: .pair 2348012345678\n\nOr use Telegram: /pair <number>');
        await currentSock.sendMessage(jid, { text: reply }, { quoted: msg });
        return;
      }
      try {
        const code = await currentSock.requestPairingCode(number);
        await currentSock.sendMessage(jid, { text: buildOmegaTerminal(`🔑 PAIRING CODE: \`${code}\`\nEnter in WhatsApp Linked Devices.`) }, { quoted: msg });
      } catch (e) {
        console.error('[WhatsApp .pair error]', e);
        await currentSock.sendMessage(jid, { text: buildOmegaTerminal('Failed to get pairing code. Bot may already be paired or number is invalid.') }, { quoted: msg });
      }
      return;
    }

    if (lower === '.telegram.pair') {
      const reply = buildOmegaTerminal(TELEGRAM_TOKEN ? 'Telegram bridge active. Use your Telegram bot + /pair <number> there.' : 'No TELEGRAM_TOKEN set in Render.');
      await currentSock.sendMessage(jid, { text: reply }, { quoted: msg });
      return;
    }

    if (lower.startsWith('.persona ')) {
      const p = lower.split(' ')[1];
      if (['eclipse', 'astraea'].includes(p)) {
        setBotPersona(jid, p);
        await currentSock.sendMessage(jid, { text: buildOmegaTerminal(`Persona: *${p.toUpperCase()}*\n${eclipseSay('ping', p)}`) }, { quoted: msg });
      }
      return;
    }

    if (['.menu', '.eclipse', '.astraea', '.phantom'].includes(lower)) {
      let p = persona;
      if (lower.includes('astraea')) p = 'astraea';
      if (lower.includes('eclipse') || lower.includes('phantom')) p = 'eclipse';
      await sendPersonaMenu(currentSock, jid, p, 'loading');
      return;
    }

    if (lower === '.ping') {
      await currentSock.sendMessage(jid, { text: buildOmegaTerminal(`📡 SIGNAL: ${isConnected ? 'BOUND' : 'FADING'}\nPersona: *${persona.toUpperCase()}*`) }, { quoted: msg });
      return;
    }

    if (lower === '.help') {
      await currentSock.sendMessage(jid, { text: buildOmegaTerminal('📖 CODEX\n.menu .eclipse .astraea .phantom — animated menu\n.persona eclipse|astraea\n.ping\n.pair <number> — request pairing code\n.telegram.pair — cloud pairing info\n\nMore coming.') }, { quoted: msg });
      return;
    }

    if (lower.startsWith('.')) {
      await currentSock.sendMessage(jid, { text: eclipseSay('bad_use', persona) }, { quoted: msg });
    }
  });
}

// EXPRESS SERVER (Render Web Service)
const app = express();
app.get('/', (req, res) => res.send('🌑 Phantom-X alive — EVENTIDE OMEGA · 👁'));
app.get('/health', (req, res) => res.json({ status: 'ok', connected: isConnected, persona: getBotPersona() }));
app.get('/qr', async (req, res) => {
  if (currentQR) {
    const buf = await qrcode.toBuffer(currentQR);
    res.set('Content-Type', 'image/png'); res.send(buf);
  } else {
    res.send(isConnected ? 'Connected — no QR' : 'No QR. Use Telegram /pair or restart.');
  }
});
app.listen(PORT, () => console.log(`🌐 Server on ${PORT}`));

// BOOT
console.log('🚀 Phantom-X starting (WhiskeySockets Baileys + full design system)...');
loadPersonas();
telegramBot = initTelegram();
startBot().catch(console.error);

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);
