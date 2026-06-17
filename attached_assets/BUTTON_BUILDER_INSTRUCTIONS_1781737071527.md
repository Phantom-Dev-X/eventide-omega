# Build a WhatsApp Button System that Works on EVERY Client

> **Purpose of this file:** give an AI everything it needs to implement a WhatsApp button pipeline that delivers reliably on **normal WhatsApp**, **WhatsApp Business**, **WhatsApp Web**, **Android**, **iOS**, and **older builds** — no silent drops, no invisible buttons.
>
> **Source bot this was extracted from:** Phantom-X (production).
> **Stack this was verified against:** Node.js 20+ CommonJS, `@whiskeysockets/baileys@6.7.23`, `@zeppeliorg/wbails@1.0.8`, `@ryuu-reinzz/button-helper@2.2.3`.

---

## 0. TL;DR — the 3 rules

If you only remember three things:

1. **Always wrap the interactive message in `viewOnceMessage` and send with `sock.relayMessage`**, not `sock.sendMessage`. Otherwise the engagement nodes get stripped and WhatsApp silently drops the message on Business / Web / older clients.

2. **Always include the 3 engagement binary nodes** in `additionalNodes`:
   ```
   biz > engagement
   biz > interactive (type=native_flow, v=1)
     > native_flow (v=9, name=mixed)
   ```
   Skip these → buttons invisible or message dropped.

3. **Always have a fallback chain.** Use the helper first → fall back to vanilla Baileys `sendMessage` → fall back to legacy `listMessage` sections → fall back to plain numbered text. WhatsApp updates break button formats every few months; your bot must degrade gracefully.

The rest of this file is the full implementation.

---

## 1. Stack & versions (use exactly these)

```json
{
  "type": "commonjs",
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.23",
    "@zeppeliorg/wbails": "^1.0.8",
    "@ryuu-reinzz/button-helper": "^2.2.3"
  }
}
```

| Package | Version | Role |
|---|---|---|
| `@whiskeysockets/baileys` | `6.7.23` (pin exactly) | The WhatsApp socket library |
| `@zeppeliorg/wbails` | `^1.0.8` | **The patched fork that emits the engagement binary nodes vanilla Baileys silently strips** — this is what makes buttons render on ALL clients |
| `@ryuu-reinzz/button-helper` | `^2.2.3` | Alternative helper for the same purpose, slightly different API |

**Critical:** vanilla `@whiskeysockets/baileys` (without `wbails`) silently strips `biz > interactive > native_flow` binary nodes from outgoing messages, which means buttons either don't render or don't deliver on most clients. You **must** use either `wbails`'s `generateWAMessageFromContent` and its proto types, OR the `@ryuu-reinzz/button-helper` package, to construct the message payload.

---

## 2. The button pipeline (3 fallbacks)

```
┌─────────────────────────────────────────────────────────────┐
│  ATTEMPT 1: wbails interactive v4  (works on ALL clients)  │
│  → uses wbails' proto + engagement nodes                    │
│  → uses sock.relayMessage with additionalNodes              │
└─────────────────────────────────────────────────────────────┘
            ↓ on failure
┌─────────────────────────────────────────────────────────────┐
│  ATTEMPT 2: vanilla Baileys sendMessage (works on most)     │
│  → uses the "interactiveButtons" shorthand                 │
│  → may fail on Business / older builds                      │
└─────────────────────────────────────────────────────────────┘
            ↓ on failure
┌─────────────────────────────────────────────────────────────┐
│  ATTEMPT 3: legacy listMessage (works on WhatsApp Web)     │
│  → uses sections/rows/buttonText shorthand                 │
│  → no native_flow, no interactive wrapper                   │
└─────────────────────────────────────────────────────────────┘
            ↓ on failure
┌─────────────────────────────────────────────────────────────┐
│  ATTEMPT 4: plain numbered text (ALWAYS works)             │
│  → "1. Option A — desc\n2. Option B — desc"               │
│  → reply with a number to choose                           │
└─────────────────────────────────────────────────────────────┘
```

**Why 4 fallbacks?** Because WhatsApp breaks button formats silently with every client update. If you only support the "interactive v4" path and WhatsApp drops it next month, your bot is dead. With 4 fallbacks, your bot still works even when 3 of them break.

---

## 3. The 3 button types that work

### 3a. `quick_reply` — inline tap buttons (max ~3)

```javascript
{
    name: "quick_reply",
    buttonParamsJson: JSON.stringify({
        display_text: "Yes",      // text on the button
        id: "callback_yes"        // unique id returned when tapped
    })
}
```

- Renders 1-3 buttons inline at the bottom of the message
- Tapping sends a callback to your handler with the `id`
- Works on **all** WhatsApp clients (most compatible type)

### 3b. `single_select` — opens a bottom-sheet list (max ~10 rows)

```javascript
{
    name: "single_select",
    buttonParamsJson: JSON.stringify({
        title: "Open List",
        sections: [
            {
                title: "Choose One",
                rows: [
                    { title: "Owner",   description: "owner tools",    id: "opt_owner" },
                    { title: "Fun",     description: "games & fun",    id: "opt_fun"   },
                    { title: "Group",   description: "group tools",    id: "opt_group" }
                ]
            }
        ]
    })
}
```

- Renders ONE button that opens a list sheet
- Each row has a `title` (required), `description` (optional), `id` (the callback)
- **Best type for menus** — works on all clients
- Sections max: 10 rows per section, 10 sections per list

### 3c. `cta_url` / `cta_copy` / `cta_call` — action buttons

```javascript
// Open a URL
{ name: "cta_url",  buttonParamsJson: JSON.stringify({ display_text: "Open", url: "https://example.com", merchant_url: "https://example.com" }) }

// Copy a code to clipboard
{ name: "cta_copy", buttonParamsJson: JSON.stringify({ display_text: "Copy", id: "copy_x", copy_code: "MY-CODE-1234" }) }

// Phone call
{ name: "cta_call", buttonParamsJson: JSON.stringify({ display_text: "Call", id: "call_x" }) }
```

- `cta_url` works on **all** clients
- `cta_copy` / `cta_call` work on **most** clients (Business has issues)
- These don't send a callback to your handler (they perform the action directly)

---

## 4. The full payload structure (interactive v4)

This is the structure that works on EVERY client. Wrap it in `viewOnceMessage`, send via `relayMessage`, attach the engagement nodes.

```javascript
const payload = {
    viewOnceMessage: {
        message: {
            messageContextInfo: {
                deviceListMetadataVersion: 2,
                deviceListMetadata: {},
            },
            interactiveMessage: {
                body:    { text: "Body text shown above the buttons" },
                footer:  { text: "— Your Bot Footer" },
                header:  {
                    title: "Optional Title",
                    subtitle: "Optional Subtitle",
                    hasMediaAttachment: false,
                },
                nativeFlowMessage: {
                    buttons: [
                        // ← quick_reply, single_select, or cta_* buttons go here
                    ],
                },
            },
        },
    },
};
```

### The 3 engagement nodes (REQUIRED)

These binary nodes must be in `additionalNodes` when you call `sock.relayMessage`. Without them, WhatsApp Business / Web / older Android will silently drop the message.

```javascript
function buildEngagementNodes() {
    const ts = Math.floor(Date.now() / 1000) - 77980457;
    return [
        {
            tag: "biz",
            attrs: {
                actual_actors: "2",
                host_storage: "2",
                privacy_mode_ts: `${ts}`,
            },
            content: [
                {
                    tag: "engagement",
                    attrs: {
                        customer_service_state: "open",
                        conversation_state: "open",
                    },
                },
                {
                    tag: "interactive",
                    attrs: { type: "native_flow", v: "1" },
                    content: [
                        {
                            tag: "native_flow",
                            attrs: { v: "9", name: "mixed" },
                            content: [],
                        },
                    ],
                },
            ],
        },
    ];
}
```

### Sending the message

```javascript
const { generateWAMessageFromContent } = require("@zeppeliorg/wbails/lib/Utils");

async function sendInteractiveMessage(sock, jid, content, options = {}) {
    // 1. Build the nativeFlow button array based on content shape
    let nativeButtons = [];
    if (content.interactiveButtons) {
        // passthrough — raw nativeFlow buttons
        nativeButtons = content.interactiveButtons;
    } else if (content.buttons) {
        // quick_reply shorthand: { id, text }
        nativeButtons = content.buttons.map(b => ({
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
                display_text: b.text || b.label || "",
                id: b.id || b.label || "",
            }),
        }));
    } else if (content.sections) {
        // single_select shorthand
        nativeButtons = [{
            name: "single_select",
            buttonParamsJson: JSON.stringify({
                title: options.buttonText || "Open List",
                sections: content.sections.map(sec => ({
                    title: sec.title || "",
                    rows: (sec.rows || []).map(r => ({
                        header: r.header || "",
                        title: r.title || "",
                        description: r.description || r.desc || "",
                        id: r.id || r.rowId || "",
                    })),
                })),
            }),
        }];
    }

    // 2. Assemble the interactiveMessage
    const interactiveMessage = {
        body: { text: content.text || "" },
        footer: { text: content.footer || "— Your Bot Footer" },
        header: {
            title: content.title || "",
            subtitle: content.subtitle || "",
            hasMediaAttachment: false,
        },
        nativeFlowMessage: { buttons: nativeButtons },
    };

    // 3. Wrap in viewOnceMessage
    const payload = {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadataVersion: 2,
                    deviceListMetadata: {},
                },
                interactiveMessage,
            },
        },
    };

    // 4. Generate the WA message via wbails (NOT vanilla Baileys)
    const msg = generateWAMessageFromContent(jid, payload, {
        userJid: sock.user?.id,
        quoted: options.quoted || undefined,
    });

    // 5. Attach engagement nodes — REQUIRED for delivery on ALL clients
    const additionalNodes = buildEngagementNodes();

    // 6. Send via relayMessage (NOT sendMessage) — required for the nodes to attach
    await sock.relayMessage(jid, msg.message, {
        messageId: msg.key.id,
        additionalNodes,
    });

    return msg;
}
```

This is the entire v4 interactive pipeline. It works on normal WhatsApp, WhatsApp Business, Web, Android, iOS, and older builds.

---

## 5. The 3-fallback ladder — full implementation

```javascript
async function sendListSelect(sock, jid, quotedMsg, bodyText, buttonLabel, rows) {
    // ─── ATTEMPT 1: wbails interactive v4 ───────────────────────────────────
    try {
        const { sendInteractiveMessage } = require("@zeppeliorg/wbails");
        await sendInteractiveMessage(sock, jid, {
            text: bodyText,
            footer: "— Your Bot Footer",
            sections: [{
                title: "Available Options",
                rows: rows.map(r => ({
                    title: r.title,
                    id: r.id,
                    description: r.desc || "",
                })),
            }],
        }, { quoted: quotedMsg || undefined, buttonText: buttonLabel });
        return; // success
    } catch (e) {
        console.error("[buttons] v4 attempt failed:", e.message);
    }

    // ─── ATTEMPT 2: vanilla Baileys sendMessage (interactiveButtons) ────────
    try {
        await sock.sendMessage(jid, {
            text: bodyText,
            title: "Your Bot",
            footer: "— Your Bot Footer",
            interactiveButtons: [{
                name: "single_select",
                buttonParamsJson: JSON.stringify({
                    title: buttonLabel,
                    sections: [{
                        title: "Available Options",
                        rows: rows.map(r => ({
                            title: r.title,
                            id: r.id,
                            description: r.desc || "",
                        })),
                    }],
                }),
            }],
        }, { quoted: quotedMsg });
        return; // success
    } catch (e) {
        console.error("[buttons] vanilla attempt failed:", e.message);
    }

    // ─── ATTEMPT 3: legacy listMessage (works on WhatsApp Web) ──────────────
    try {
        await sock.sendMessage(jid, {
            text: bodyText,
            footer: "— Your Bot Footer",
            buttonText: buttonLabel,
            sections: [{
                title: "Available Options",
                rows: rows.map(r => ({
                    title: r.title,
                    rowId: r.id,
                    description: r.desc || "",
                })),
            }],
        }, { quoted: quotedMsg });
        return; // success
    } catch (e) {
        console.error("[buttons] legacy attempt failed:", e.message);
    }

    // ─── ATTEMPT 4: plain numbered text (ALWAYS works) ──────────────────────
    const numbered = rows.map((r, i) =>
        `*${i + 1}.* ${r.title}${r.desc ? " — " + r.desc : ""}`
    ).join("\n");
    await sock.sendMessage(jid, {
        text: `${bodyText}\n\n${numbered}\n\n_Reply with a number._`,
    }, { quoted: quotedMsg });
}
```

**The 4th fallback is critical.** It guarantees your bot never silently fails to communicate. A numbered text reply is ugly, but it's universal.

---

## 6. Receiving button taps (callback decoding)

When a user taps a button, WhatsApp sends a message back to your bot with the callback `id`. You have to decode it in your `handleMessage` function. **Different WhatsApp clients return different message shapes**, so check them all.

```javascript
function extractButtonId(msg) {
    const m = msg.message;
    if (!m) return null;

    // Path 1: standard buttonsResponseMessage (most clients)
    if (m.buttonsResponseMessage) {
        return m.buttonsResponseMessage.selectedButtonId
            || m.buttonsResponseMessage.selectedDisplayText
            || null;
    }

    // Path 2: interactiveResponseMessage (newer clients + single_select)
    if (m.interactiveResponseMessage) {
        const native = m.interactiveResponseMessage.nativeFlowResponseMessage;
        if (native && native.paramsJson) {
            try {
                const parsed = JSON.parse(native.paramsJson);
                return parsed.id || null;
            } catch (_) {
                return native.paramsJson; // fallback: raw string
            }
        }
    }

    // Path 3: listResponseMessage (legacy WhatsApp Web)
    if (m.listResponseMessage) {
        return m.listResponseMessage.singleSelectReply?.selectedRowId
            || m.listResponseMessage.title
            || null;
    }

    // Path 4: templateButtonReplyMessage (legacy)
    if (m.templateButtonReplyMessage) {
        return m.templateButtonReplyMessage.selectedId
            || m.templateButtonReplyMessage.selectedDisplayText
            || null;
    }

    return null;
}
```

Then in your main handler:

```javascript
async function handleMessage(sock, msg) {
    const buttonId = extractButtonId(msg);

    if (buttonId) {
        // Route the callback
        switch (true) {
            case buttonId === "menu_owner":
                await handleOwnerMenu(sock, msg);
                break;
            case buttonId === "opt_yes":
                await handleYes(sock, msg);
                break;
            case buttonId.startsWith("onoff_"):
                // .antilink_on / .antilink_off style toggles
                const cmd = buttonId.replace(/^onoff_/, "").replace(/_(on|off)$/, "");
                const state = buttonId.endsWith("_on") ? "on" : "off";
                await runToggleCommand(sock, msg, `.${cmd} ${state}`);
                break;
            default:
                await sock.sendMessage(msg.key.remoteJid, {
                    text: `You tapped: ${buttonId}`,
                }, { quoted: msg });
        }
        return;
    }

    // ... otherwise parse as text command
}
```

---

## 7. Common pitfalls & fixes

### Pitfall 1 — buttons render on YOUR phone but not on recipients'

**Cause:** you sent the message to yourself (DM) — `bot` node is attached in DMs but not in groups, and some clients only render if both are present.

**Fix:** always include both `biz > engagement` AND `bot` node for DMs:

```javascript
if (!isGroup) {
    additionalNodes.push({ tag: "bot", attrs: { biz_bot: "1" } });
}
```

### Pitfall 2 — `viewOnceMessage` causes silent drops on WhatsApp Business

**Cause:** WhatsApp Business has a stricter check on view-once wrappers.

**Fix:** if your audience is mostly Business users, use the `viewOnceV2` wrapper instead. Test both with `.btntest`.

```javascript
// variant A: viewOnceMessage (works on most)
const payload = { viewOnceMessage: { message: { ... } } };

// variant B: viewOnceV2 (works on Business)
const payload = { viewOnceV2: { message: { ... } } };

// variant C: no wrapper (works on Web, drops on some Androids)
const payload = { interactiveMessage: { ... } };
```

### Pitfall 3 — `JSON.stringify` of the `buttonParamsJson` field gets corrupted

**Cause:** if you include user input in the `display_text` or `id`, special characters break the JSON.

**Fix:** always sanitize. Escape `"` and `\` before stringifying:

```javascript
function safeButtonParams(obj) {
    const safe = JSON.stringify(obj)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
    return safe;
}
```

### Pitfall 4 — buttons work, but tapping them does nothing

**Cause:** your `extractButtonId` doesn't handle the client's response shape.

**Fix:** add more paths. WhatsApp has used **at least 4 different response shapes** over the years (`buttonsResponseMessage`, `interactiveResponseMessage.nativeFlowResponseMessage`, `listResponseMessage.singleSelectReply`, `templateButtonReplyMessage`). Check them all.

### Pitfall 5 — buttons work in the bot's own DM but not in groups

**Cause:** group messages need slightly different `additionalNodes` — the `bot` node must NOT be attached, and `biz.actual_actors` should be `"1"` (not `"2"`) for groups.

**Fix:** detect group vs DM and adjust:

```javascript
const isGroup = jid.endsWith("@g.us");
const additionalNodes = buildEngagementNodes(isGroup);  // pass through
if (!isGroup) {
    additionalNodes.push({ tag: "bot", attrs: { biz_bot: "1" } });
}
```

### Pitfall 6 — buttons stop working after a WhatsApp update

**Cause:** WhatsApp patches button formats silently.

**Fix:** the 4-fallback ladder above. When the v4 path breaks, attempt 2 or 3 still works. When those break, attempt 4 (plain text) always works.

---

## 8. Quick copy-paste starter (3 buttons + 1 list)

```javascript
const { generateWAMessageFromContent } = require("@zeppeliorg/wbails/lib/Utils");

function buildEngagementNodes() {
    const ts = Math.floor(Date.now() / 1000) - 77980457;
    return [{
        tag: "biz",
        attrs: { actual_actors: "2", host_storage: "2", privacy_mode_ts: `${ts}` },
        content: [
            { tag: "engagement", attrs: { customer_service_state: "open", conversation_state: "open" } },
            {
                tag: "interactive", attrs: { type: "native_flow", v: "1" },
                content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" }, content: [] }],
            },
        ],
    }];
}

async function sendButtons(sock, jid, quotedMsg, bodyText, buttons) {
    const nativeButtons = buttons.map(b => ({
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
            display_text: b.label,
            id: b.id,
        }),
    }));

    const payload = {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} },
                interactiveMessage: {
                    body:    { text: bodyText },
                    footer:  { text: "— My Bot" },
                    header:  { title: "", subtitle: "", hasMediaAttachment: false },
                    nativeFlowMessage: { buttons: nativeButtons },
                },
            },
        },
    };

    const msg = generateWAMessageFromContent(jid, payload, {
        userJid: sock.user?.id,
        quoted: quotedMsg,
    });

    await sock.relayMessage(jid, msg.message, {
        messageId: msg.key.id,
        additionalNodes: buildEngagementNodes(),
    });
}

async function sendListSelect(sock, jid, quotedMsg, bodyText, buttonLabel, rows) {
    const nativeButtons = [{
        name: "single_select",
        buttonParamsJson: JSON.stringify({
            title: buttonLabel,
            sections: [{
                title: "Options",
                rows: rows.map(r => ({
                    header: "",
                    title: r.title,
                    description: r.desc || "",
                    id: r.id,
                })),
            }],
        }),
    }];

    const payload = {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} },
                interactiveMessage: {
                    body:    { text: bodyText },
                    footer:  { text: "— My Bot" },
                    header:  { title: "", subtitle: "", hasMediaAttachment: false },
                    nativeFlowMessage: { buttons: nativeButtons },
                },
            },
        },
    };

    const msg = generateWAMessageFromContent(jid, payload, {
        userJid: sock.user?.id,
        quoted: quotedMsg,
    });

    await sock.relayMessage(jid, msg.message, {
        messageId: msg.key.id,
        additionalNodes: buildEngagementNodes(),
    });
}

// ─── Example usage ───────────────────────────────────────────────────
async function handlePing(sock, msg, jid) {
    // 3 inline buttons
    await sendButtons(sock, jid, msg, "Pong! Choose an action:", [
        { id: "btn_help",   label: "❓ Help"   },
        { id: "btn_status", label: "📊 Status" },
        { id: "btn_about",  label: "ℹ️ About"  },
    ]);
}

// Or open a list
async function handleMenu(sock, msg, jid) {
    await sendListSelect(sock, jid, msg,
        "Tap below to open the menu:",
        "🌐 Open Menu",
        [
            { id: "menu_owner", title: "👑 Owner Menu", desc: "dev commands" },
            { id: "menu_group", title: "👥 Group Menu", desc: "group tools"  },
            { id: "menu_fun",   title: "🎮 Fun Menu",   desc: "games & fun"  },
        ]
    );
}
```

This is a minimal, complete, working starter. Drop it into any new Baileys-based bot and the buttons will deliver to every WhatsApp client.

---

## 9. Verifying it works on every client

After deploying, type `.btntest` (or your equivalent). The bot should send 4 messages in sequence:

1. `quick_reply` — 3 inline buttons
2. `single_select` — 1 button that opens a list
3. `cta_url` + `cta_copy` + `cta_call` — 3 action buttons
4. Legacy `listMessage` sections — most-compatible

Tap each one and watch the `extractButtonId` paths in your logs. If any path returns the right `id`, that format works on your client. Repeat on **Android, iOS, Web, Business** — if all four paths return the right ids on all four clients, your bot is universal.

---

## 10. What this file does NOT cover

This is a button-pipeline-only reference. It does **not** cover:

- Full bot skeleton / connection setup (see Baileys docs)
- Message parsing for text commands
- Persistence / state files
- Rate limiting / anti-ban

It only covers the button subsystem. Combine with a normal Baileys message handler to make a full bot.

---

## 11. File summary (when implementing)

| File | Purpose |
|---|---|
| `wbails_helper.js` (or similar) | The v4 sendInteractiveMessage function + buildEngagementNodes |
| `index.js` | The main bot — requires the helper, calls `sendListSelect` / `sendButtons` from case handlers |
| `package.json` | `^6.7.23`, `@zeppeliorg/wbails ^1.0.8`, `@ryuu-reinzz/button-helper ^2.2.3` |
| The `handleMessage` function | Calls `extractButtonId(msg)` first; routes the result |

Drop these 4 files + a `node_modules/` install and you have a bot with buttons that work on **every** WhatsApp client.
