# Phantom-X — Eventide Omega

WhatsApp multi-session bot with a Telegram pairing bridge, session backup/restore via a private Telegram channel, and a cinematic web dashboard.

## Stack

- **Runtime**: Node.js 20
- **WhatsApp**: `@whiskeysockets/baileys` (Baileys 7.x)
- **Telegram bridge**: `node-telegram-bot-api`
- **Web server**: Express on port 5000
- **Media**: sharp, tesseract.js, ytdl-core

## How to run

```bash
npm install
node index.js
```

The server starts on port 5000. The web dashboard is available at `/`.

## Required secrets (set in Replit Secrets)

| Key | Description |
|-----|-------------|
| `TELEGRAM_TOKEN` | Bot token from @BotFather on Telegram |
| `TELEGRAM_BACKUP_CHANNEL` | Numeric ID of your private Telegram channel (e.g. `-1001234567890`) |

## Optional secrets

| Key | Description | Default |
|-----|-------------|---------|
| `ADMIN_EMAIL` | Web dashboard login email | — |
| `ADMIN_PASSWORD` | Web dashboard login password | — |
| `MAX_USERS` | Max WhatsApp sessions per instance (`0` = unlimited) | `15` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins | all |
| `GOOGLE_MAPS_API_KEY` | Improves `.weather` command | falls back to Nominatim |
| `NEWS_API_KEY` | Improves `.news` command | falls back to Google News RSS |
| `PORT` | HTTP port | `5000` |

## Without Telegram credentials

The bot starts and serves the web dashboard, but pairing via Telegram and session backup/restore won't work. It retries Telegram every 60 seconds in the background once a token is set.

## User preferences
