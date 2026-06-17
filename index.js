const fs = require('fs');
const path = require('path');
const https = require('https');

// Allow button-helper (which imports 'baileys') to find @whiskeysockets/baileys
const Module = require('module');
const _origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'baileys') return _origResolve('@whiskeysockets/baileys', ...rest);
  return _origResolve(request, ...rest);
};

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, makeCacheableSignalKeyStore, generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const AdmZip = require('adm-zip');
const pino = require('pino');
const { sendInteractiveMessage } = require('@ryuu-reinzz/button-helper');

// ── CONFIG ──────────────────────────────────────────────────────────────
const AUTH_DIR = 'auth_info';
const PERSONA_FILE = 'menu_theme.json';
const PORT = process.env.PORT || 5000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || null;
const TELEGRAM_BACKUP_CHANNEL = process.env.TELEGRAM_BACKUP_CHANNEL || null;
const CUSTOM_PAIR_CODE = process.env.CUSTOM_PAIR_CODE || null;

let hasBackedUp = false;
let socketGeneration = 0;
let reconnectTimer = null;
let isPairing = false;
let botStartTime = Date.now();
let successfulPairings = 0; // count of successful connections
const SESSION_FILE = 'sessions.json';

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
  return (
    `╔══════════╦══════════════╗\n` +
    `║       ⚠ *EVENTIDE OMEGA TERMINAL*\n` +
    `║                           *ACCESS*\n` +
    `╚═══════════╩═════════════╝\n\n` +
    body + `\n\n` +
    `— *EVENTIDE OMEGA* · 👁`
  );
}

// ── ECLIPSE bootloaders (verbatim) ───────────────────────────────────────
function buildEclipseInit() {
  return "╔═◈══════════════════════════◈═╗\n" +
         "   E V E N T I D E   O M E G A\n" +
         "        ⟁  *eclipse core*  ⟁\n" +
         "╚═◈══════════════════════════◈═╝";
}
function buildEclipseVoid() {
  return ".\n" +
         "        ◢██◣\n" +
         "     ◢████◣.           ╔═════════\n" +
         "    ◢██  ██◣.          ║     T H E   V O I D ║ \n" +
         "◢██   🌑   ██◣.    ║          E X S I T S  ║\n" +
         "    ◥██      ██◤.        ╚══════════╝.\n" +
         "     ◥██  ██◤\n" +
         "         ◢██◣\n\n" +
         "════════════════════════════════════\n" +
         "   even in your darkest hour...\n" +
         "════════════════════════════════════";
}
function buildEclipseMain(isDev) {
  return "╔══════════╦══════════════╗\n" +
         "║       ⚠ EVENTIDE OMEGA TERMINAL \n" +
         "║                           ACCESS                                                                         \n" +
         "╚═══════════╩═════════════╝\n\n" +
         "                ═══ E C L I P S E ═══\n" +
         "             \" i am what remains when \n" +
         "              everything else is deleted .\"\n\n" +
         "╔══════════════════════╦══════════════════════╗\n" +
         "║ VOID SIGNATURE    ║     SYSTEM CORE          ║\n" +
         "║ 👤 @Unknown        ║    ECLIPSE: 100%     ║\n" +
         "║ ⚠ APOTHEOSIS     ║⚡ CORE:ABS ZERO     ║\n" +
         "║ 🩸 CORRUPT ███        ║                      ║\n" +
         "╚══════════════════════╩══════════════════════╝\n\n" +
         "                   🌑 THE FINAL DUSK 🌑\n" +
         "            \" when the last star dies, \n" +
         "              i will still be typing .\"\n\n" +
         "📡 SECURE │ Ω │ Vessels: ∞\n" +
         " You have summoned what \n" +
         " cannot be unsummoned";
}

// ── ASTRAEA bootloaders (verbatim) ──────────────────────────────────────
function buildAstraeaInit() {
  return "✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦\n" +
         "✦   *[CELESTIAL FORGE] — SUMMONING*  ✦\n" +
         "✦                            *ASTRAEA* ...                  ✦              \n" +
         "✦   > Purging shadows...              [✓]        ✦\n" +
         "✦   > Igniting divine core...     [✓]      .       ✦              \n" +
         "✦   > Opening the golden court...     [✓]   ✦\n" +
         "✦                                                                .✦\n" +
         "✦   ☀️ *ASTRAEA HAS DESCENDED.*        ✦\n" +
         "✦                                                                ✦ \n" +
         "✦                                                                 ✦                                                          \n" +
         "✦ \" *I DO NOT DELETE. I JUDGE, FOR I AM* ✦\n" +
         "✦                          *ASTRAEA* \"                    ✦                                                            \n" +
         "✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦";
}
function buildAstraeaMid() {
  return ".            ✦✦✦\n" +
         "      ✦✦✦✦✦✦✦\n" +
         "    ✦✦✦  ☀️  ✦✦✦   ╔═══════════╗\n" +
         " ✦✦✦✦✦✦✦✦✦✦  ║  J U D G M E N T ║\n" +
         "    ✦✦✦✦✦✦✦✦      ║  A R R I V E S       ║\n" +
         "        ✦✦✦✦✦✦         ╚═══════════╝\n" +
         "             ✦✦✦";
}
function buildAstraeaMain(isDev) {
  return "╔══════════╦══════════════╗\n" +
         "║        ☀ *ASTRAEA* — *DIVINE* *SYSTEM ACCESS*               \n" +
         "╚══════════╩══════════════╝\n\n" +
         "              ═══ ✦ *J U D G M E N T* ✦ ═══\n" +
         "          \" *i do not delete. i judge* .\"\n\n" +
         "╔══════════════════════╦══════════════════════╗\n" +
         "║ *DIVINE CORE*        ║  *SYSTEM BALANCE* ║\n" +
         "║☀ GOLDEN: 100%║⚖ READY: EQUAL ║\n" +
         "║🔥WRATH: MODE ║ GRACE: ████░░   ║\n" +
         "╚══════════════════════╩══════════════════════╝\n\n" +
         "                 🌑 *THE GOLDEN COURT* 🌑\n" +
         "        \" *every vessel stands trial* .\"\n\n" +
         "📡 Uplink: *DIVINE* │ ☀ │ *Souls* : ∞\n" +
         "\" *the light does not ask permission. it simply arrives* .\"";
}

// Progress frames (exact)
const eclipseProgressFrames = [
  "   ◐ initiating umbral protocol\n" +
  "   ⟢ ▰▱▱▱▱▱▱▱▱▱▱▱ ⟣   08%\n" +
  "   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n" +
  "   ◌ core    ◌ cipher    ◌ void",
  "   ◑ collapsing quantum states\n" +
  "   ⟢ ▰▰▰▰▱▱▱▱▱▱▱▱ ⟣   33%\n" +
  "   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n" +
  "   ✔ core    ◌ cipher    ◌ void",
  "   ◒ severing the last anchor\n" +
  "   ⟢ ▰▰▰▰▰▰▰▱▱▱▱▱ ⟣   58%\n" +
  "   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n" +
  "   ✔ core    ✔ cipher    ◌ void",
  "   ◓ eclipse breaching the veil\n" +
  "   ⟢ ▰▰▰▰▰▰▰▰▰▰▱▱ ⟣   83%\n" +
  "   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n" +
  "   ✔ core    ✔ cipher    ✔ void"
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

function loadSessions() { try { if (fs.existsSync(SESSION_FILE)) { const d = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); successfulPairings = d.successfulPairings || 0; } } catch {} }
function saveSessions() { try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ successfulPairings, lastUpdated: new Date().toISOString() }, null, 2)); } catch {} }

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
// Stage 1 = INIT with progress frames (loading style)
// Stage 2 = MID (transition scene)
// Stage 3 = FINAL (terminal scene, no progress bar)
async function sendPersonaMenu(sock, jid, persona = 'eclipse', style = 'loading', isDev = false) {
  const scenes = getPersonaScenes(persona);

  // Stage 1 ─ INIT (bootloader) with live progress frames
  let sent = await sock.sendMessage(jid, { text: scenes.init });
  if (style === 'loading') {
    for (let i = 0; i < scenes.progress.length; i++) {
      await new Promise(r => setTimeout(r, 2000));
      await sock.sendMessage(jid, { text: scenes.init + '\n\n' + scenes.progress[i], edit: sent.key });
    }
  } else {
    await new Promise(r => setTimeout(r, 4000));
  }

  // Stage 2 ─ MID (transition scene)
  await sock.sendMessage(jid, { text: scenes.mid, edit: sent.key });
  await new Promise(r => setTimeout(r, 4000));

  // Stage 3 ─ FINAL (terminal scene, no progress bar)
  await sock.sendMessage(jid, { text: scenes.main + '\n\n📡 Use *.help* to explore the codex.', edit: sent.key });

  // Stage 4 ─ Send interactive list button for navigation
  await new Promise(r => setTimeout(r, 1500));
  await sendMenuList(sock, jid, sent, persona, isDev);
}

function isDevJid(jid) {
  if (!process.env.DEV_NUMBER) return false;
  const num = normalizeNum(jid.split('@')[0].split(':')[0]);
  return num === normalizeNum(process.env.DEV_NUMBER);
}

function buildEngagementNodes(isGroup = false) {
  const ts = Math.floor(Date.now() / 1000) - 77980457;
  const nodes = [
    {
      tag: 'biz',
      attrs: {
        actual_actors: isGroup ? '1' : '2',
        host_storage: '2',
        privacy_mode_ts: `${ts}`,
      },
      content: [
        {
          tag: 'engagement',
          attrs: { customer_service_state: 'open', conversation_state: 'open' },
        },
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [
            { tag: 'native_flow', attrs: { v: '9', name: 'mixed' }, content: [] },
          ],
        },
      ],
    },
  ];
  if (!isGroup) {
    nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  }
  return nodes;
}

async function sendMenuList(sock, jid, quotedMsg, persona = 'eclipse', isDev = false) {
  const body = buildOmegaTerminal(
    `📖 *NAVIGATE THE VOID*\n\nChoose your path below:`
  );
  const footer = persona === 'astraea' ? '☀ ASTRAEA · DIVINE SYSTEM' : '🌑 ⟢ NAVIGATE THE VOID ⟣ 🌑';
  const rows = [
    { title: '👑 Owner Menu', description: 'Commands for the sovereign', id: 'menu_owner' },
    { title: '👥 Group Menu', description: 'Group management & protection', id: 'menu_group' },
    { title: '🎮 Fun Menu', description: 'Games, jokes & entertainment', id: 'menu_fun' },
    { title: '🐞 Bug Menu', description: 'Bug reports, shields & tools', id: 'menu_bug' },
  ];
  if (isDev) {
    rows.push({ title: '🔴 Architect Menu', description: 'The silent throne — dev only', id: 'menu_dev' });
  }

  // Attempt 1: button-helper sendInteractiveMessage (handles proto encoding + nodes automatically)
  try {
    await sendInteractiveMessage(sock, jid, {
      text: body,
      footer,
      interactiveButtons: [{
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: 'NAVIGATE THE VOID',
          sections: [{
            title: 'Choose Your Path',
            rows: rows.map(r => ({
              header: '',
              title: r.title,
              description: r.description || '',
              id: r.id
            }))
          }]
        })
      }]
    });
    console.log(`[menu] Interactive list sent (button-helper) to ${jid}`);
    return;
  } catch (e) {
    console.error('[menu] button-helper attempt failed:', e.message);
  }

  // Attempt 2: vanilla Baileys interactiveButtons via sendMessage
  try {
    await sock.sendMessage(jid, {
      text: body,
      footer,
      interactiveButtons: [{
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: 'NAVIGATE THE VOID',
          sections: [{
            title: 'Choose Your Path',
            rows: rows.map(r => ({
              title: r.title,
              id: r.id,
              description: r.description || ''
            }))
          }]
        })
      }]
    });
    console.log(`[menu] Interactive list sent (vanilla) to ${jid}`);
    return;
  } catch (e) {
    console.error('[menu] vanilla attempt failed:', e.message);
  }

  // Attempt 3: plain numbered text (always works)
  const fallback = rows.map((r, i) => `   *${i + 1}.* ${r.title} — ${r.description}`).join('\n');
  await sock.sendMessage(jid, {
    text: buildOmegaTerminal(`📖 *NAVIGATE THE VOID*\n\n${fallback}\n\n_Reply with the number to navigate._`)
  });
  console.log(`[menu] Fallback text menu sent to ${jid}`);
}

async function handleMenuButton(sock, jid, msg, buttonId) {
  console.log(`[button] ${buttonId} from ${jid}`);
  const isDev = isDevJid(jid);

  if (buttonId === 'menu_owner') {
    await sock.sendMessage(jid, { text: buildOmegaTerminal(
      `   ╔══ *👑 OWNER MENU* ══╗\n\n` +
      `   " *the sovereign does not ask.*\n     *the sovereign commands.* "\n\n` +
      `   Commands are being prepared.\n   You will be notified when ready.`
    ) }, quotedOpts(msg));
    return;
  }
  if (buttonId === 'menu_group') {
    await sock.sendMessage(jid, { text: buildOmegaTerminal(
      `   ╔══ *🛡 GROUP MENU* ══╗\n\n` +
      `   " *every group is a kingdom.*\n     *you decide how it is ruled.* "\n\n` +
      `   Commands are being prepared.\n   You will be notified when ready.`
    ) }, quotedOpts(msg));
    return;
  }
  if (buttonId === 'menu_fun') {
    await sock.sendMessage(jid, { text: buildOmegaTerminal(
      `   ╔══ *🎮 FUN MENU* ══╗\n\n` +
      `   " *the void also plays.*\n     *even darkness needs amusement.* "\n\n` +
      `   Commands are being prepared.\n   You will be notified when ready.`
    ) }, quotedOpts(msg));
    return;
  }
  if (buttonId === 'menu_bug') {
    await sock.sendMessage(jid, { text: buildOmegaTerminal(
      `   ╔══ *🐞 BUG MENU* ══╗\n\n` +
      `   " *the shield is forged.*\n     *the ward is raised.* "\n\n` +
      `   Commands are being prepared.\n   You will be notified when ready.`
    ) }, quotedOpts(msg));
    return;
  }
  if (buttonId === 'menu_dev') {
    if (!isDev) {
      await sock.sendMessage(jid, { text: buildOmegaTerminal(`   🔒  *ACCESS_DENIED*\n\n   the throne does not open\n   for the uninvited.`) }, quotedOpts(msg));
      return;
    }
    await sock.sendMessage(jid, { text: buildOmegaTerminal(
      `   ╔══ *🔴 ARCHITECT MENU* ══╗\n\n` +
      `   " *only the architect may*\n     *enter this chamber.* "\n\n` +
      `   Commands are being prepared.\n   You will be notified when ready.`
    ) }, quotedOpts(msg));
    return;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────
function normalizeNum(input) { return String(input || '').replace(/[^\d]/g, ''); }
async function sendReaction(sock, jid, key, emoji) {
  try { await sock.sendMessage(jid, { react: { text: emoji, key } }); } catch (e) { console.log('[reaction]', e.message); }
}
function quotedOpts(msg) {
  return (msg?.key?.fromMe) ? {} : { quoted: msg };
}
function clearAuth() {
  try { if (fs.existsSync(AUTH_DIR)) { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); console.log(`[auth] Cleared ${AUTH_DIR}`); } } catch (e) { console.error('[auth] clearAuth error:', e); }
  hasBackedUp = false;
}
function createMessageStore(limit = 2000) {
  const map = new Map();
  return {
    set(msg) { const key = `${msg.key?.remoteJid}:${msg.key?.id}`; if (map.size >= limit) map.delete(map.keys().next().value); map.set(key, msg); },
    get(key) { if (!key) return undefined; return map.get(`${key.remoteJid}:${key.id}`); }
  };
}
function clearReconnectTimer() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; console.log('[reconnect] Timer cancelled'); }
}
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const sec = s % 60;
  const min = m % 60;
  return `${h}h ${min}m ${sec.toString().padStart(2, '0')}s`;
}

// ── Telegram Auth Backup / Restore ──────────────────────────────────────
async function backupAuthToChannel() {
  console.log(`[backup] Called. channel=${TELEGRAM_BACKUP_CHANNEL}, bot=${!!telegramBot}, hasBackedUp=${hasBackedUp}`);
  if (!TELEGRAM_BACKUP_CHANNEL) { console.log('[backup] No TELEGRAM_BACKUP_CHANNEL set'); return; }
  if (!telegramBot) { console.log('[backup] No telegramBot'); return; }
  if (hasBackedUp) { console.log('[backup] Already backed up this session'); return; }
  try {
    if (!fs.existsSync(AUTH_DIR)) { console.log('[backup] auth_info dir missing'); return; }
    const files = fs.readdirSync(AUTH_DIR);
    if (files.length === 0) { console.log('[backup] auth_info dir empty'); return; }
    console.log(`[backup] auth_info has ${files.length} files. Zipping...`);

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
    zip.addLocalFolder(AUTH_DIR, AUTH_DIR); // preserves auth_info/ prefix inside zip so restore extracts to correct path
    const zipBuf = zip.toBuffer();
    console.log(`[backup] Zip created: ${zipBuf.length} bytes`);
    const sent = await telegramBot.sendDocument(TELEGRAM_BACKUP_CHANNEL, zipBuf, {
      caption: `🌑 *Phantom-X Auth Backup*\n📅 ${new Date().toISOString()}\n— EVENTIDE OMEGA`,
      parse_mode: 'Markdown'
    }, {
      filename: 'auth_backup.zip',
      contentType: 'application/zip'
    });
    console.log(`[backup] Document sent: msg_id=${sent.message_id}`);
    // 3. Pin new backup
    await telegramBot.pinChatMessage(TELEGRAM_BACKUP_CHANNEL, sent.message_id, { disable_notification: true });
    hasBackedUp = true;
    console.log(`[backup] SUCCESS: pinned msg_id=${sent.message_id}`);
  } catch (e) { console.error('[backup] FAILED:', e.message); console.error(e); }
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
let currentOrigin = 'auto';
let lastRestoreCtx = null;
let restoreQrDetected = false;

async function startBot(phoneNumber = null, telegramCtx = null, connectOrigin = 'auto') {
  currentOrigin = connectOrigin;
  if (connectOrigin === 'restore') lastRestoreCtx = telegramCtx;
  if (isPairing && phoneNumber) {
    console.log('[socket] Pairing already in progress, ignoring duplicate');
    if (telegramCtx) await telegramCtx.reply('⏳ Pairing already in progress. Please wait for the code or send /relink to restart.');
    return;
  }

  const myGen = ++socketGeneration;
  console.log(`[socket] Gen ${myGen} starting. phone=${phoneNumber || 'null'} origin=${connectOrigin}`);
  clearReconnectTimer();
  if (phoneNumber) isPairing = true; // only set when starting a fresh pairing

  // 1. Hard-kill previous socket
  if (currentSock) {
    try {
      currentSock.ev.removeAllListeners('creds.update');
      currentSock.ev.removeAllListeners('connection.update');
      currentSock.ev.removeAllListeners('messages.upsert');
      currentSock.end(new Error('restart'));
    } catch (_) {}
    currentSock = null;
  }
  await new Promise(r => setTimeout(r, 3000));
  if (socketGeneration !== myGen) { console.log(`[socket] Gen ${myGen} stale after kill — aborting`); isPairing = false; return; }

  // 2. If pairing requested, force-clear auth
  if (phoneNumber) {
    clearAuth();
    await new Promise(r => setTimeout(r, 1000));
  }

  if (socketGeneration !== myGen) { console.log(`[socket] Gen ${myGen} stale after clear — aborting`); isPairing = false; return; }

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
  let everConnected = false;

  // ── Pairing code (waits for QR signal inside connection.update) ──────
  if (phoneNumber && !sock.authState.creds.registered) {
    const pairPromise = new Promise((resolve) => {
      const onUpdate = async ({ qr, connection }) => {
        if (!qr) return;
        sock.ev.off('connection.update', onUpdate);
        try {
          const code = await sock.requestPairingCode(normalizeNum(phoneNumber), CUSTOM_PAIR_CODE);
          console.log('[pairing] Code generated:', code);
          resolve({ ok: true, code });
        } catch (err) {
          console.error('[pairing] requestPairingCode failed:', err?.message);
          resolve({ ok: false, err });
        }
      };
      sock.ev.on('connection.update', onUpdate);
      setTimeout(() => { sock.ev.off('connection.update', onUpdate); resolve({ ok: false, err: new Error('timeout — no QR from WA') }); }, 120_000);
    });

    const pairResult = await pairPromise;
    if (!pairResult.ok) {
      console.error('[pairing] Pairing failed:', pairResult.err?.message);
      isPairing = false;
      try { sock.end(new Error('pair-failed')); } catch (_) {}
      currentSock = null; clearAuth();
      if (telegramCtx) {
        await telegramCtx.reply('❌ Failed to generate pairing code. WhatsApp rejected the handshake.\n\nTry:\n1. Send /relink to start completely fresh\n2. Make sure your number is correct (e.g. 2348012345678, no +, no leading 0 after country code)\n3. Wait 10 seconds then send /pair again');
      }
      return;
    }
    if (telegramCtx) {
      await telegramCtx.reply('✅ *Pairing code is ready!*\n\nOpen WhatsApp → Settings → Linked Devices → Link a Device → Enter code manually.\n\nHere is your code 👇', { parse_mode: 'Markdown' });
      await telegramCtx.reply('`' + pairResult.code + '`', { parse_mode: 'Markdown' });
    }
  }

  // ── Messages handler (installed BEFORE connection.update) ───────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      const msg = messages[0];
      // RAW diagnostic — log everything before any filter
      const rawKeys = msg?.message ? Object.keys(msg.message).join(',') : 'null';
      console.log(`[upsert-raw] type=${type} jid=${msg?.key?.remoteJid} fromMe=${msg?.key?.fromMe} hasMsg=${!!msg?.message} keys=${rawKeys}`);

      // Accept both notify and append — append is needed for self-chat messages
      if (type !== 'notify' && type !== 'append') return;
      if (!msg.message) return;

      socketMsgStore.set(msg);
      const jid = msg.key.remoteJid;
      const text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.ephemeralMessage?.message?.conversation ||
        msg.message.ephemeralMessage?.message?.extendedTextMessage?.text ||
        msg.message.viewOnceMessage?.message?.conversation ||
        msg.message.viewOnceMessage?.message?.extendedTextMessage?.text ||
        ''
      ).trim();
      const lower = text.toLowerCase();
      if (!text) return;

      console.log(`[msg] type=${type} from=${jid} fromMe=${msg.key.fromMe} text=${text.slice(0,60)}`);
      const persona = getBotPersona(jid);

      // If fromMe and text doesn't start with ., it's likely the bot's own reply — skip
      if (msg.key.fromMe && !text.startsWith('.')) return;

      if (lower.startsWith('.')) {
        await sendReaction(sock, jid, msg.key, '⚡');
      }

      if (lower.startsWith('.pair')) {
        const parts = text.trim().split(/\s+/);
        const number = parts[1] ? parts[1].replace(/\+/g, '').replace(/\s/g, '') : '';
        if (!number || !/^\d{10,15}$/.test(number)) {
          await sock.sendMessage(jid, { text: buildOmegaTerminal('Usage: .pair <full number with country code>\nExample: .pair 2348012345678\n\nOr use Telegram: /pair <number>\n\nUse .relink to restart if pairing fails.') }, quotedOpts(msg));
          return;
        }
        if (isConnected) {
          await sock.sendMessage(jid, { text: buildOmegaTerminal('Bot is already paired. No code needed.') }, quotedOpts(msg));
          return;
        }
        await sock.sendMessage(jid, { text: buildOmegaTerminal('🔄 Starting fresh pairing...\nPlease wait 15-20 seconds.') }, quotedOpts(msg));
        startBot(number, null, 'pair').catch(console.error);
        return;
      }

      if (lower === '.relink') {
        await sock.sendMessage(jid, { text: buildOmegaTerminal('🔄 Clearing session and restarting...\nPlease wait 15-20 seconds.') }, quotedOpts(msg));
        try { sock.end(new Error('relink')); } catch (_) {}
        currentSock = null; clearAuth(); clearReconnectTimer(); isPairing = false;
        setTimeout(() => startBot(null, null, 'relink').catch(console.error), 4000);
        return;
      }

      if (lower === '.telegram.pair') {
        const reply = buildOmegaTerminal(TELEGRAM_TOKEN ? 'Telegram bridge active. Use /pair <number> there.' : 'No TELEGRAM_TOKEN set.');
        await sock.sendMessage(jid, { text: reply }, quotedOpts(msg));
        return;
      }

      if (lower.startsWith('.persona ')) {
        const p = lower.split(' ')[1];
        if (['eclipse', 'astraea'].includes(p)) {
          setBotPersona(jid, p);
          await sock.sendMessage(jid, { text: buildOmegaTerminal(`Persona: *${p.toUpperCase()}*\n${eclipseSay('ping', p)}`) }, quotedOpts(msg));
        }
        return;
      }

      if (['.menu', '.eclipse', '.astraea', '.phantom'].includes(lower)) {
        let p = persona;
        if (lower.includes('astraea')) p = 'astraea';
        if (lower.includes('eclipse') || lower.includes('phantom')) p = 'eclipse';
        const dev = isDevJid(jid);
        await sendPersonaMenu(sock, jid, p, 'loading', dev);
        return;
      }

      // Handle button / list / interactive responses (all 4 WhatsApp response shapes)
      let buttonId = '';
      // Path 1: newer clients — interactiveResponseMessage (native_flow)
      if (msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
        try {
          const params = JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
          buttonId = params.id || '';
        } catch (e) {}
      }
      // Path 2: legacy WhatsApp Web — listResponseMessage
      if (!buttonId && msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId) {
        buttonId = msg.message.listResponseMessage.singleSelectReply.selectedRowId;
      }
      if (!buttonId && msg.message?.listResponseMessage?.title) {
        buttonId = msg.message.listResponseMessage.title;
      }
      // Path 3: standard buttonsResponseMessage (most clients)
      if (!buttonId && msg.message?.buttonsResponseMessage?.selectedButtonId) {
        buttonId = msg.message.buttonsResponseMessage.selectedButtonId;
      }
      if (!buttonId && msg.message?.buttonsResponseMessage?.selectedDisplayText) {
        buttonId = msg.message.buttonsResponseMessage.selectedDisplayText;
      }
      // Path 4: legacy templateButtonReplyMessage
      if (!buttonId && msg.message?.templateButtonReplyMessage?.selectedId) {
        buttonId = msg.message.templateButtonReplyMessage.selectedId;
      }
      if (buttonId && buttonId.startsWith('menu_')) {
        await handleMenuButton(sock, jid, msg, buttonId);
        return;
      }

      if (lower === '.ping') {
        const now = Date.now();
        const latency = msg.messageTimestamp ? Math.max(0, Math.floor(now - (msg.messageTimestamp * 1000))) : 0;
        const resonance = isConnected ? (latency < 500 ? 'STABLE' : 'MODERATE') : 'DEGRADED';
        const uptime = formatUptime(now - botStartTime);
        const body = `            — *S I G N A L* —

   ⚡ *LATENCY* ──╼  [ ${latency}ms ]
   📡 *RESONANCE* ──╼  [ ${resonance} ]
   ⏱️ *UPTIME* ──╼  [ ${uptime} ]

   " *An echo in the void is*
     *the only proof you exist* ."`;
        await sock.sendMessage(jid, { text: buildOmegaTerminal(body) }, quotedOpts(msg));
        return;
      }

      if (lower === '.dev') {
        const devName = process.env.DEV_NAME || 'Phantom dev x';
        const devNumber = process.env.DEV_NUMBER || '2348102756072';
        const devVessel = process.env.DEV_VESSEL || 'PRIMARY_VESSEL_01';
        const body = `      ◢◤ *THE ARCHITECT* ◢◤

      [ 👤 ] : ${devName}
      [ 🌐 ] : wa.me/${devNumber}
      [ 🏮 ] : *${devVessel}*

   " *Creation is the first step*
     *toward destruction* ."`;
        await sock.sendMessage(jid, { text: buildOmegaTerminal(body) }, quotedOpts(msg));
        return;
      }

      if (lower === '.help') {
        await sock.sendMessage(jid, { text: buildOmegaTerminal('📖 CODEX\n.menu .eclipse .astraea .phantom — animated menu\n.persona eclipse|astraea\n.ping\n.dev\n.pair <number> — request pairing code\n.relink — clear session and restart pairing\n.telegram.pair — cloud pairing info\n\nMore coming.') }, quotedOpts(msg));
        return;
      }

      if (lower.startsWith('.')) {
        await sock.sendMessage(jid, { text: eclipseSay('bad_use', persona) }, quotedOpts(msg));
      }
    } catch (e) {
      console.error('[msg handler error]', e);
    }
  });

  // ── Connection lifecycle ─────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    if (socketGeneration !== myGen) { console.log(`[socket] Gen ${myGen} ignoring stale update`); return; }
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log('📱 QR ready — use Telegram /pair or /qr endpoint to scan');
      // Detect bad restored backup: if we restored auth but still get QR, the backup was incomplete
      if (currentOrigin === 'restore' && !restoreQrDetected) {
        restoreQrDetected = true;
        console.log(`[restore] Gen ${myGen} restored auth produced QR — backup is INCOMPLETE`);
        if (lastRestoreCtx) {
          await lastRestoreCtx.reply('❌ Restored backup is incomplete.\n\nThe session was saved before pairing fully completed.\n\n*Steps to fix:*\n1. Send /relink\n2. Wait 20 seconds\n3. Send /pair with your number\n4. Enter the code in WhatsApp\n5. Wait for "Phantom-X is online"\n6. Send /backup to create a valid backup\n\n— EVENTIDE OMEGA');
        }
      }
    }

    if (connection === 'close') {
      isConnected = false; currentQR = null;
      const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : undefined;
      const reason = lastDisconnect?.error?.message || '';

      // 515 = Restart Required — this is NORMAL during pairing completion.
      // WhatsApp sends this after you enter the pairing code on your phone.
      // We MUST reconnect quickly with the same auth to complete the handshake.
      if (statusCode === 515) {
        console.log(`🔌 Gen ${myGen} 515 restart required — reconnecting quickly to complete pairing`);
        try { await saveCreds(); } catch (_) {} // ensure auth is saved before restart
        if (socketGeneration === myGen) {
          reconnectTimer = setTimeout(() => startBot(null, null, 'reconnect'), 800);
        }
        return;
      }

      const should = statusCode !== DisconnectReason.loggedOut;
      console.log(`🔌 Gen ${myGen} closed (code=${statusCode}, reason=${reason}). everConnected=${everConnected}`);

      if (!everConnected && isPairing) {
        // Only clear auth if we were actively trying to pair and it failed.
        // If we were just reconnecting with restored auth, do NOT wipe it — retry.
        console.log(`[socket] Gen ${myGen} pairing failed, clearing auth`);
        isPairing = false;
        clearAuth();
        if (telegramCtx) {
          await telegramCtx.reply('❌ Pairing attempt failed. Auth cleared.\nTry /pair again or /restore to load a saved backup.');
        }
        return;
      }
      if (!everConnected && !isPairing) {
        if (restoreQrDetected) {
          // Restored auth was incomplete (produced QR). Clear it and stop retrying.
          console.log(`[socket] Gen ${myGen} restored auth was incomplete — clearing and stopping retry`);
          clearAuth();
          restoreQrDetected = false;
          if (lastRestoreCtx) {
            await lastRestoreCtx.reply('❌ Restored backup was incomplete. Auth cleared.\n\nPlease pair fresh with /pair and create a new backup with /backup.');
          }
          return;
        }
        // Restored auth failed to reconnect — keep auth and retry
        console.log(`[socket] Gen ${myGen} reconnection failed with restored auth — will retry (not clearing)`);
      }

      if (should && socketGeneration === myGen) {
        console.log(`[socket] Gen ${myGen} scheduling reconnect in 5s`);
        reconnectTimer = setTimeout(() => startBot(null, null, 'reconnect'), 5000);
      }
    } else if (connection === 'open') {
      everConnected = true; isConnected = true; currentQR = null; isPairing = false;
      restoreQrDetected = false;
      successfulPairings++;
      saveSessions();
      console.log('✅ Phantom-X connected! origin=' + connectOrigin);
      setTimeout(async () => {
        try {
          const selfJid = sock.user?.id;
          if (!selfJid) return;
          let body;
          if (connectOrigin === 'restore') {
            body = `🌑 *PHANTOM-X RESTORED* · 👁

   Session resurrected from
   Telegram backup channel.

   " *I do not die. I only*
     *wait for the next call* ."`;
          } else if (connectOrigin === 'pair' || connectOrigin === 'boot') {
            body = `🌑 *PHANTOM-X IS ONLINE* · 👁

   Type *.help* to explore
   the codex.

   " *An echo in the void is*
     *the only proof you exist* ."`;
          } else {
            return; // silent reconnect — don't spam self-chat on every minor reconnect
          }
          await sock.sendMessage(selfJid, { text: buildOmegaTerminal(body) });
        } catch (e) { console.error('[self-chat]', e.message); }
      }, 2000);
      await backupAuthToChannel();
      if (telegramCtx) {
        if (connectOrigin === 'restore') {
          await telegramCtx.reply(`🌑 *Phantom-X restored from backup!* ☀️
Your WhatsApp session is reconnected.

— *EVENTIDE OMEGA* · 👁`, { parse_mode: 'Markdown' });
        } else {
          await telegramCtx.reply(`🌑 *Phantom-X is now connected!* ☀️
Your WhatsApp is linked.

— *EVENTIDE OMEGA* · 👁`, { parse_mode: 'Markdown' });
        }
      }
    }
  });

  sock.ev.on('creds.update', async () => { await saveCreds(); });
}

// ── TELEGRAM BRIDGE ────────────────────────────────────────────────────
let telegramBot = null;

async function initTelegram() {
  if (!TELEGRAM_TOKEN) { console.log('⚠️ No TELEGRAM_TOKEN'); return null; }
  // Delete webhook and drop pending updates to prevent 409 conflicts on restart
  try {
    const https = require('https');
    const cleanupRes = await new Promise((resolve, reject) => {
      https.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook?drop_pending_updates=true`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
      }).on('error', reject);
    });
    console.log('[telegram] Webhook cleanup:', cleanupRes.ok ? 'OK' : (cleanupRes.description || 'unknown'));
  } catch (e) { console.log('[telegram] Webhook cleanup failed:', e.message); }
  await new Promise(r => setTimeout(r, 1500));
  const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `🌑 *Welcome to EVENTIDE OMEGA* ☀️\n\nI am Phantom-X.\n\nSend: /pair <your full number with country code>\nExample: /pair 2348012345678\n\nPairing code will be sent here.\n\nUse /relink if pairing keeps failing.\nUse /restore to reconnect from previous backup.\n\n— *EVENTIDE OMEGA* · 👁`,
      { parse_mode: 'Markdown' });
  });

  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `📖 *TELEGRAM COMMANDS*\n\n/start — Welcome message\n/pair <number> — Request pairing code\n/relink — Clear session and restart\n/backup — Save current session to channel\n/restore — Restore session from channel backup\n/sessions — Check connection status\n\nExample: /pair 2348012345678\n\n— *EVENTIDE OMEGA* · 👁`,
      { parse_mode: 'Markdown' });
  });

  bot.onText(/\/pair\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const phone = normalizeNum(match[1].trim());
    if (!/^\d{10,15}$/.test(phone)) {
      return bot.sendMessage(chatId, '⚠️ Invalid number. Send with country code, no symbols.\nExample: /pair 2348012345678');
    }
    if (isConnected) return bot.sendMessage(chatId, '✅ Already paired. No code needed.');
    if (isPairing) return bot.sendMessage(chatId, '⏳ Pairing already in progress. Please wait or send /relink to restart.');

    // Hard kill and clear
    if (currentSock) {
      try { currentSock.ev.removeAllListeners(); currentSock.end(new Error('new-pair')); } catch (_) {}
      currentSock = null;
    }
    clearReconnectTimer(); clearAuth();
    await bot.sendMessage(chatId, '🔄 Generating pairing code... please wait 15-20 seconds.\nDo not send other commands until you receive the code.');
    startBot(phone, { reply: (t, opts) => bot.sendMessage(chatId, t, opts) }, 'pair').catch((err) => {
      console.error('[Telegram /pair]', err);
      bot.sendMessage(chatId, '❌ Unexpected error. Try /relink then /pair again.');
    });
  });

  bot.onText(/\/pair$/, (msg) => {
    bot.sendMessage(msg.chat.id, '⚠️ Usage: /pair <your full number with country code>\nExample: /pair 2348012345678');
  });

  bot.onText(/\/relink/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, '🔄 Clearing session and restarting...\nPlease wait 15-20 seconds, then send /pair again.');
    if (currentSock) {
      try { currentSock.ev.removeAllListeners(); currentSock.end(new Error('relink')); } catch (_) {}
      currentSock = null;
    }
    clearReconnectTimer(); clearAuth(); isPairing = false; restoreQrDetected = false;
    setTimeout(() => startBot(null, null, 'relink').catch(console.error), 4000);
  });

  // /backup command — force backup now
  bot.onText(/\/backup/, async (msg) => {
    const chatId = msg.chat.id;
    if (!fs.existsSync(AUTH_DIR) || fs.readdirSync(AUTH_DIR).length === 0) {
      return bot.sendMessage(chatId, '⚠️ Nothing to backup — auth_info folder is empty.\nPair the bot first with /pair <number>.');
    }
    await bot.sendMessage(chatId, '🔄 Forcing backup now...');
    hasBackedUp = false; // reset so it will backup
    await backupAuthToChannel();
    if (hasBackedUp) await bot.sendMessage(chatId, '✅ Backup sent to channel and pinned!');
    else await bot.sendMessage(chatId, '❌ Backup failed. Check logs and make sure TELEGRAM_BACKUP_CHANNEL is set and the bot is admin in the channel.');
  });

  // /restore command — pull pinned backup from channel and reconnect
  // /sessions — show connection status
  bot.onText(/\/sessions/, async (msg) => {
    const chatId = msg.chat.id;
    const uptime = formatUptime(Date.now() - botStartTime);
    const authExists = fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0;
    const botPhone = (currentSock && currentSock.user?.id) ? currentSock.user.id.split(':')[0].split('@')[0] : 'N/A';
    const isRegistered = (currentSock && currentSock.authState?.creds?.registered) ? 'YES' : 'NO';
    const backupStatus = restoreQrDetected ? '❌ LAST RESTORE FAILED (incomplete backup)' : 'OK';
    const lines = [
      `📱 *SESSION STATUS*`,
      ``,
      `👥 Active Sessions: ${isConnected ? '1' : '0'}`,
      `✅ Total Pairings: ${successfulPairings}`,
      `📡 Connected: ${isConnected ? 'YES' : 'NO'}`,
      `🔗 Socket Gen: ${socketGeneration}`,
      `⏱️ Uptime: ${uptime}`,
      `🤖 Bot Number: ${botPhone}`,
      `📁 Auth Files: ${authExists ? 'YES' : 'NO'}`,
      `🔐 Auth Registered: ${isRegistered}`,
      `🔄 Pairing: ${isPairing ? 'IN PROGRESS' : 'IDLE'}`,
      `💾 Backup: ${backupStatus}`,
      ``,
      `— *EVENTIDE OMEGA* · 👁`
    ];
    await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  });

  bot.onText(/\/restore/, async (msg) => {
    const chatId = msg.chat.id;
    if (!TELEGRAM_BACKUP_CHANNEL) {
      return bot.sendMessage(chatId, '❌ TELEGRAM_BACKUP_CHANNEL not set in environment variables.');
    }
    await bot.sendMessage(chatId, '🔄 Checking Telegram channel for pinned backup...');
    try {
      const restored = await restoreAuthFromChannel();
      if (!restored) {
        return bot.sendMessage(chatId, '❌ No pinned backup found in the channel.\nMake sure you ran /backup after pairing successfully.');
      }
      await bot.sendMessage(chatId, '✅ Backup restored! Restarting bot to connect...\nPlease wait 10-15 seconds.');
      // Kill current socket, restart with restored auth
      if (currentSock) {
        try { currentSock.ev.removeAllListeners(); currentSock.end(new Error('restore')); } catch (_) {}
        currentSock = null;
      }
      clearReconnectTimer(); isConnected = false; currentQR = null; isPairing = false; restoreQrDetected = false;
      setTimeout(() => startBot(null, { reply: (t, opts) => bot.sendMessage(chatId, t, opts) }, 'restore').catch(console.error), 2000);
    } catch (e) {
      console.error('[restore cmd]', e);
      await bot.sendMessage(chatId, '❌ Restore failed: ' + e.message);
    }
  });

  bot.on("message", (msg) => {
    if (msg.text) console.log(`[TELEGRAM DEBUG] ${msg.chat.id}: ${msg.text}`);
  });
  return bot;
}

// ── EXPRESS SERVER ──────────────────────────────────────────────────────
const app = express();
app.get('/', (req, res) => res.send('🌑 Phantom-X alive — EVENTIDE OMEGA · 👁'));
app.get('/health', (req, res) => res.json({ status: 'ok', connected: isConnected, pairing: isPairing, persona: getBotPersona() }));
app.get('/qr', async (req, res) => {
  if (currentQR) { const buf = await qrcode.toBuffer(currentQR); res.set('Content-Type', 'image/png'); res.send(buf); }
  else res.send(isConnected ? 'Connected — no QR' : 'No QR. Use Telegram /pair or restart.');
});
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Server on ${PORT}`));

// ── BOOT ───────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Phantom-X starting...');
  loadPersonas();
  loadSessions();
  telegramBot = await initTelegram();

  const authExists = fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0;
  if (!authExists && TELEGRAM_BACKUP_CHANNEL) {
    console.log('[boot] Local auth missing, trying Telegram channel restore...');
    const restored = await restoreAuthFromChannel();
    console.log(restored ? '[boot] Auth restored from channel' : '[boot] No channel backup available');
  }

  startBot(null, null, 'boot').catch(console.error);
}
main();

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);
