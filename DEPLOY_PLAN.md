# 🛰️ Eventide Omega — Deployment Plan
## Vercel (web) + Render (free bot) + Panels (scaled bots) → 100 users

---

## 🧠 First: What This Repo Actually Is

Before we deploy, make sure you understand what's inside `eventide-omega`:

```
eventide-omega/
├── public/          ← Static website (login, pair, dashboard…)
│   ├── index.html
│   ├── login.html
│   ├── signup.html
│   ├── pair.html       ← already has ?bot= URL param!
│   ├── dashboard.html
│   └── …
├── index.js         ← ONE Node process that does EVERYTHING:
│                      - Serves static files (if no Vercel)
│                      - Express API (/api/auth/*, /api/pair, /api/s/*)
│                      - Runs the WhatsApp bot (Baileys)
│                      - Runs the Telegram backup bot
│                      - Enforces MAX_USERS cap
├── auth_info_*/     ← WhatsApp session folders (1 per paired number)
├── web_users.json   ← Web signups (email/password)
├── render.yaml      ← Render blueprint (already pre-configured!)
├── vercel.json      ← Vercel config (already routes /public/**)
└── package.json
```

### The clever part already built in

Look at `public/pair.html` lines 189–197:
```js
const BOT_URL = (() => {
  const p = new URLSearchParams(location.search).get('bot') || '';
  return p.replace(/\/$/, '');
})();
function api(path) { return BOT_URL + path; }
```

This means a user opens:
```
https://your-site.vercel.app/pair.html?bot=https://bot1.onrender.com
```
…and the static Vercel site will call **bot1.onrender.com** for the API. That's the whole point — Vercel serves only the UI, your bot hosts do the actual work. ✨

### The Telegram backup system

`index.js` has two functions:
- `backupAuthToChannel()` — zips `auth_info*` + `web_auth_*` + `web_users.json` and sends to a private Telegram channel, **pins** it.
- `restoreAuthFromChannel()` — on startup, finds the pinned zip, downloads it, extracts, restores sessions.

This is **only needed for hosts with ephemeral disk** (Render free). Hosts with **persistent disk** (your 4GB/100%CPU panels) can skip it.

### The MAX_USERS cap

`index.js` line 8905:
```js
const MAX_USERS = parseInt(process.env.MAX_USERS || '0') || 0;
```
And `/api/pair` line 9111:
```js
if (MAX_USERS > 0 && getLinkedCount() >= MAX_USERS) {
  return res.json({ ok: false, error: `This server is full (max ${MAX_USERS} users)…` });
}
```

`getLinkedCount()` counts **paired WhatsApp sessions only** — not web signups. So you can have thousands of signups, but only N active pairings. This is exactly your "max 15 per instance" plan, **already implemented**. No code change needed.

---

## ❓ Answer To Your Main Question: Do I Need Two Repos?

**No. One repo is enough.** Here's why:

| Concern | Reality |
|---|---|
| Bot needs Telegram backup on Render (ephemeral disk) | Yes, but it's controlled by **env vars**, not code |
| Bot doesn't need Telegram on panel (persistent disk) | Yes, but it's controlled by **env vars**, not code |
| Different PORT (Render=10000, panel=5000) | Same — env var |
| Different MAX_USERS | Same — env var |
| Different CORS allowed origins | Same — env var |

So you just deploy the **same** repo everywhere, with different env vars. No fork, no second repo.

### ⚠️ The only real change you need

Vercel's `vercel.json` already routes `public/**` to static hosting, so the Vercel side is done. ✅

For Render, `render.yaml` already has `MAX_USERS=15`, `PORT=10000`, etc. ✅

For your **panels**, there is no `render.yaml` to read — you just need to know:
- Run `npm install` (and the buildcommand in render.yaml if you want Python deps too)
- Run `node index.js` (or `npm start`)
- Set env vars in your panel's process manager

That's it.

---

## 🚀 The Deployment (3 Platforms, Same Code)

### 🟦 Step 1 — Deploy the WEB UI to Vercel

This is the easiest part because the repo already has `vercel.json`.

**Option A: Vercel CLI**
```bash
cd eventide-omega
npm i -g vercel
vercel login
vercel --prod
```
That's literally it. Vercel will:
1. See `vercel.json`
2. Build `public/**` as static assets
3. Route `/login.html`, `/pair.html`, `/dashboard.html` etc.
4. Give you a URL like `https://eventide-omega.vercel.app`

**Option B: Vercel Dashboard**
1. Go to https://vercel.com → **New Project**
2. Import `phantom-dev-x/eventide-omega` from GitHub
3. Framework preset: **Other** (it's just static)
4. Root directory: leave blank (Vercel reads `vercel.json` from root)
5. Click **Deploy**

After deploy, test it: open `https://your-site.vercel.app/login.html` — it should load (it won't actually log in until you point it at a bot, but the UI works).

---

### 🟩 Step 2 — Deploy BOT #1 to Render (Free Tier)

This is your "Render instance" — 15 users max, with Telegram backup.

#### 2a. Create the Telegram backup channel first

1. Open Telegram → create a **new private channel** (e.g. `@phantom_x_render_backup`)
2. Create a bot via **@BotFather** → `/newbot` → save the token
3. Add the bot to your channel as **Admin** (needs Post + Pin permissions)
4. Get the channel ID:
   - Forward any message from the channel to **@userinfobot**
   - OR open: `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Look for `"chat":{"id":-100xxxxxxxxxx"`
   - Copy the full number **including the minus sign**

#### 2b. Push to a Render-friendly branch

The repo's `render.yaml` lives at the root, so Render will pick it up automatically if you connect the GitHub repo. But you have secrets in there — let's just use the Render dashboard for env vars instead.

#### 2c. Create the Render Web Service

1. Go to https://render.com → **New +** → **Web Service**
2. Connect `phantom-dev-x/eventide-omega`
3. Settings:
   - **Name**: `phantom-r1` (or whatever you want)
   - **Region**: Oregon (or nearest)
   - **Branch**: `main`
   - **Runtime**: Node
   - **Build Command**:
     ```
     python3 -m pip install --quiet --upgrade yt-dlp imageio-ffmpeg bgutil-ytdlp-pot-provider && npm install
     ```
     (This installs yt-dlp and ffmpeg that some commands need)
   - **Start Command**: `npm start`
   - **Plan**: Free
4. **Environment Variables** (click "Advanced" → "Add Environment Variable"):
   | Key | Value |
   |---|---|
   | `NODE_VERSION` | `20.20.2` |
   | `NODE_ENV` | `production` |
   | `PORT` | `10000` |
   | `TELEGRAM_TOKEN` | *(your bot token)* |
   | `TELEGRAM_BACKUP_CHANNEL` | *(e.g. `-1001234567890`)* |
   | `ADMIN_EMAIL` | *(your admin email)* |
   | `ADMIN_PASSWORD` | *(strong password)* |
   | `MAX_USERS` | `15` |
   | `ALLOWED_ORIGINS` | `https://your-site.vercel.app` |

5. Click **Create Web Service**. Wait ~5 min for first deploy.

After deploy, Render gives you a URL: `https://phantom-r1.onrender.com`. Visit `/health` to confirm it's up.

> 💡 **Free tier sleeps after 15 min of inactivity.** That's OK — the Telegram backup ensures users don't need to re-pair when it wakes up. If you want 24/7, upgrade Render to $7/mo (still cheaper than a panel).

---

### 🟥 Step 3 — Deploy BOT #2, #3, … on Panels (4GB / 100% CPU)

These are your scaled-out instances. **Each gets MAX_USERS=15, each uses persistent disk, NO Telegram needed.**

#### What kind of panel?

I'm assuming a **Pterodactyl**-style VPS panel (or any Node-capable VPS — Hetzner, Contabo, OVH, etc.) where:
- You can SSH in (or use a panel UI)
- You get a Linux box with persistent storage
- You can run `node` 20+

If your panel is **Pterodactyl**, create an "Egg" with Node 20 and these env vars. If it's plain VPS, follow the SSH steps below.

#### SSH method (works for any VPS)

For each panel instance:

```bash
# 1. SSH in
ssh root@panel1.yourhost.com

# 2. Install Node 20 (if not already)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs python3-pip ffmpeg

# 3. Clone the repo
cd /opt
git clone https://github.com/phantom-dev-x/eventide-omega.git phantom-p1
cd phantom-p1

# 4. Install deps (same build command as Render)
pip3 install --quiet --upgrade yt-dlp imageio-ffmpeg bgutil-ytdlp-pot-provider
npm install

# 5. Create .env file (NOT git-committed)
cat > .env << 'EOF'
PORT=5000
NODE_ENV=production
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=supersecretpassword
MAX_USERS=15
ALLOWED_ORIGINS=https://your-site.vercel.app
# NO TELEGRAM_TOKEN, NO TELEGRAM_BACKUP_CHANNEL — disk is persistent!
EOF

# 6. Run it (use pm2 so it auto-restarts)
npm i -g pm2
pm2 start index.js --name phantom-p1
pm2 save
pm2 startup    # follow the instructions it prints

# 7. Open firewall for port 5000
ufw allow 5000/tcp
```

For **each subsequent panel** (p2, p3, …):
- Clone to a different folder (`phantom-p2`, `phantom-p3`, …)
- Use the same `.env` content
- Change `MAX_USERS=15` stays the same
- Pick a different port (or expose each via different subdomains)

#### Subdomain routing (so each panel has its own URL)

If your panel provider gives you a domain, point a subdomain at each:
- `bot1.yourdomain.com` → panel 1 (port 5000)
- `bot2.yourdomain.com` → panel 2 (port 5000)
- `bot3.yourdomain.com` → panel 3 (port 5000)

Or use nginx as a reverse proxy on one VPS:
```nginx
server {
  server_name bot1.yourdomain.com;
  location / { proxy_pass http://localhost:5000; }
}
server {
  server_name bot2.yourdomain.com;
  location / { proxy_pass http://localhost:5001; }
}
```

Each bot is just `node index.js` on a different port. Sessions are in different folders, so they're isolated. ✅

---

## 📈 Scaling Plan: How To Reach 100 Users

| # | Host | MAX_USERS | Telegram backup? | Persistent disk? |
|---|---|---|---|---|
| 1 | Render free (`phantom-r1`) | 15 | ✅ Yes (mandatory) | ❌ No |
| 2 | Panel 1 (`phantom-p1`) | 15 | ❌ No | ✅ Yes |
| 3 | Panel 2 (`phantom-p2`) | 15 | ❌ No | ✅ Yes |
| 4 | Panel 3 (`phantom-p3`) | 15 | ❌ No | ✅ Yes |
| 5 | Panel 4 (`phantom-p4`) | 15 | ❌ No | ✅ Yes |
| 6 | Panel 5 (`phantom-p5`) | 15 | ❌ No | ✅ Yes |
| 7 | Panel 6 (`phantom-p6`) | 15 | ❌ No | ✅ Yes |
| **Total capacity** | | **105 users** | | |

That's 7 instances, 105 user slots, 100 target met. 🎯

### How users get routed to the right instance

When someone wants to pair, you (the admin) send them a link like:

```
https://your-site.vercel.app/pair.html?bot=https://phantom-r1.onrender.com
https://your-site.vercel.app/pair.html?bot=https://bot1.yourdomain.com
https://your-site.vercel.app/pair.html?bot=https://bot2.yourdomain.com
```

The static Vercel site uses `?bot=` to know which backend to call. Each user signs up + pairs on the specific instance you assign them. When that instance fills up (15 users), the next user gets the next instance URL.

**You can make this nicer** by adding a small "Available servers" dropdown to `index.html` on Vercel, but for now the manual URL approach works perfectly.

---

## 🧪 After Deployment — How To Test

### Test 1: Vercel UI
Visit `https://your-site.vercel.app/login.html` — page should load with full Omega design.

### Test 2: Bot health
Visit `https://phantom-r1.onrender.com/health` — should return:
```json
{"status":"ok","connected":false,"pairing":false,"users":0}
```

### Test 3: Pair through Vercel → Render
1. Open `https://your-site.vercel.app/pair.html?bot=https://phantom-r1.onrender.com`
2. Sign up with any email
3. Login
4. Enter your WhatsApp number → get pairing code
5. Pair in WhatsApp
6. Verify in your Telegram channel: the zip backup should be pinned

### Test 4: Render restart resilience
1. Manually trigger a redeploy on Render
2. After restart, your previously-paired session should auto-reconnect (no re-pair needed)
3. Telegram channel should show the pinned zip being read

### Test 5: MAX_USERS cap
1. Pair 15 sessions on an instance
2. Try to pair a 16th
3. Should get: `"This server is full (max 15 users). Please use another Eventide Omega instance."`

---

## 🛠️ Optional Improvements (If You Want To Go Further)

### A. Auto-routing across instances

Add a tiny `api/servers.json` file in `public/`:
```json
[
  { "name": "Render Free", "url": "https://phantom-r1.onrender.com", "max": 15 },
  { "name": "Panel 1", "url": "https://bot1.yourdomain.com", "max": 15 },
  …
]
```
And a small JS in `pair.html` that fetches `/api/status` from each and auto-selects the one with space. ~30 lines of code. Tell me if you want me to add this.

### B. Admin dashboard on Vercel

A single `/admin.html` page that:
- Lists all your bot instance URLs
- Pings each `/health` endpoint
- Shows current user count vs MAX_USERS
- Generates the right `pair.html?bot=…` link for the next free slot

### C. Telegram backup for panels too

Even though panels have persistent disk, you can still set the Telegram vars. Belt + suspenders. If the panel's disk dies, you can restore from Telegram. Costs you nothing extra.

---

## 📁 Files This Plan Touches

- ✅ `vercel.json` — already perfect, no change
- ✅ `render.yaml` — already perfect, no change
- ✅ `index.js` — no change needed, env vars control everything
- 🆕 `.env.render.example` — Render-specific env template (see below)
- 🆕 `.env.panel.example` — Panel-specific env template (see below)

---

## ✅ TL;DR Action List

1. **Vercel**: `vercel --prod` from `eventide-omega/`. Done in 2 min.
2. **Render**: Create Web Service from GitHub, set the 8 env vars above, deploy. Done in 5 min.
3. **Panel 1 (VPS)**: SSH, clone, npm install, write `.env`, `pm2 start`. Done in 10 min.
4. **Repeat panel step** for panels 2–6.
5. **Tell your users**: "Go to `https://your-site.vercel.app/pair.html?bot=<their-server-url>`"
6. **When a server fills up** (15 users), deploy a new panel and give new users the new URL.

That's the whole thing. Same code, 3 platforms, scales to 100 users. 🚀
