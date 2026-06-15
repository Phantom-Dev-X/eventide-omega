# Phantom-X — Eventide Omega (Private Telegram Channel + Pin Auto-Backup & Auto-Restore)

**Exactly as requested:**

When a user pairs the bot (via Telegram), the bot **itself immediately** zips the session files and sends them to your **private Telegram channel** and **pins the message**.

On Render restart / redeploy / sleep, the bot **automatically** checks that private channel, downloads the **latest pinned zip**, extracts it, and reconnects — previous users **never need to re-pair**.

Uses canonical Mac OS Desktop pairing to avoid WhatsApp "non-canonical" rejections.

The full cinematic design system + 3-stage animated `.menu` (eclipse + astraea) is 100% preserved.

## Render Environment Variables (only these 3)

Add in Render → Environment as **secrets**:

1. `TELEGRAM_TOKEN`  
   Your Telegram bot token from @BotFather.

2. `TELEGRAM_BACKUP_CHANNEL_ID`  
   The **numeric ID** of your **private Telegram channel** (the one the bot will send to + pin, and read the pinned message from on restart).  
   **How to get it**:
   - Add the bot to the private channel as admin (needs post + pin permissions).
   - Send any message in the channel.
   - Forward that message to @userinfobot, or open this in a browser:  
     `https://api.telegram.org/bot<PUT_YOUR_TELEGRAM_TOKEN_HERE>/getUpdates`
   - Look for the line with `"chat":{"id":-1001234567890,...}`  
   - Copy the full number including the minus sign (e.g. `-1001234567890`).

   Your personal WhatsApp number as JID (for manual restore via WhatsApp document if ever needed).  
   Example: `2348012345678@s.whatsapp.net`

That's **all** the variables.

## How it works (no re-pair after first time)

1. First pairing (via Telegram):
   - User messages Telegram bot → `/start` → `.pair 2348012345678`
   - Gets pairing code, enters it in WhatsApp.
   - Bot connects → **immediately** zips `auth_info/` + persona file → sends the zip to the private Telegram channel → **pins** the message.

2. Every Render restart / redeploy:
   - At boot the bot (before even starting WhatsApp) fetches the latest pinned message from the channel.
   - If it finds a pinned `.zip`, downloads it, extracts to `auth_info/`, and auto-starts the connection with the saved session.
   - Users are back online with zero extra steps.

A fresh backup + pin also happens automatically on every successful connect.

## Render Deployment

Use the included `render.yaml`.

Free tier sleeps after inactivity — the pinned Telegram backup + auto-restore handles bringing the bot back without anyone re-pairing.

For production: upgrade plan + Persistent Disk (the Telegram pinned message remains the reliable backup source).

**Important**: Run only **one instance**.

## Commands

Same beautiful ones from your design system:
- `.menu` / `.eclipse` / `.astraea` / `.phantom` (3-stage animated bootloader with edits + progress bars)
- `.persona eclipse` | `.persona astraea`
- `.ping`
- `.help`
- `.telegram.pair` or `.pair` (triggers the Telegram instructions)

All replies use the exact Omega terminal, borders, short phrases, and persona styling.

## Security

- The bot only restores from the pinned message it controls.

Keep the channel private and the bot as admin.

## Local Test (when possible)

```bash
cd /home/user/phantom-x
npm install
export TELEGRAM_TOKEN=your_bot_token
export TELEGRAM_BACKUP_CHANNEL_ID=-1001234567890
node index.js
```

Pair via Telegram, watch the auto send + pin happen in the channel, then kill the process and restart it — it should pull the pinned zip and connect automatically.

Push the folder to GitHub (or connect directly), set the three secrets in Render, deploy, and enjoy persistent sessions with zero re-pairing.

Drop your `TELEGRAM_BACKUP_CHANNEL_ID` here if you want me to verify the format or make any final small change.

— *EVENTIDE OMEGA* · 👁
