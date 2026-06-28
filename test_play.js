const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Mock dependencies and environment
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function _ph_resolveFFmpegPath() {
    return '/usr/bin/ffmpeg';
}

async function _ph_tryYtDlpOnce(url, isAudio, env, hasFFmpeg) {
  return new Promise((resolve) => {
    let proc;
    try {
      const { spawn } = require('child_process');
      const args = [
        '--no-playlist', '--no-warnings', '--no-progress', '--no-update',
        '--max-filesize', '80M', '--socket-timeout', '30', '--retries', '1',
        '--no-check-certificates', '-o', '-'
      ];
      if (isAudio) {
        args.push('-x');
        if (hasFFmpeg) {
          args.push('--audio-format', 'mp3', '--audio-quality', '0');
        } else {
          args.push('-f', 'ba[ext=m4a]/ba/best', '--audio-format', 'best');
        }
      } else {
        args.push('-S', 'ext:mp4:m4a,res:720,size:80M,br');
      }
      args.push(url);
      proc = spawn('yt-dlp', args, { timeout: 180000, env });
      const chunks = [];
      let total = 0;
      proc.stdout.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_DOWNLOAD_BYTES) { proc.kill('SIGTERM'); return resolve(null); }
        chunks.push(chunk);
      });
      proc.on('close', (code) => {
        if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
        else resolve(null);
      });
      proc.on('error', () => resolve(null));
    } catch (e) { resolve(null); }
  });
}

async function _ph_tryYtDlp(url, isAudio) {
  const ffmpegPath = _ph_resolveFFmpegPath();
  const env = { ...process.env, PYTHONUNBUFFERED: '1', FFMPEG_PATH: ffmpegPath };
  const result = await _ph_tryYtDlpOnce(url, isAudio, env, ffmpegPath);
  return result;
}

async function test() {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    console.log(`[test] Testing yt-dlp for: ${url}`);
    const buffer = await _ph_tryYtDlp(url, true);
    if (buffer && buffer.length > 0) {
        console.log(`[test] ✅ Success! Buffer size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
        fs.writeFileSync('test_audio.mp3', buffer);
    } else {
        console.log('[test] ❌ Failed to download audio.');
    }
}

test();
