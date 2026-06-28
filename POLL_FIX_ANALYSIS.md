# 🔍 Poll Vote Decryption Fix — Analysis & Solution (v2)

## The Problem

When users select an option in the `.menu` poll, the bot responds with:
> ⚠️ Received your vote, but couldn't verify the exact option due to WhatsApp end-to-end encryption.

### Specific symptoms observed:
1. **Group:** Bot's paired number votes → ❌ fails. Other group member votes → ✅ works.
2. **DM / Self-chat:** Anyone votes → ❌ always fails.

## Root Cause — The Voter JID Bug

The decryption uses `decryptPollVote()` which derives the AES-GCM key using both the **creator JID** and the **voter JID**. If either JID is wrong, the GCM authentication tag check fails and decryption throws "Unsupported state or unable to authenticate data".

### The old broken code (line ~1250):
```js
const voterJid = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
```

### Why this was wrong:

| Scenario | `msg.key.participant` | `msg.key.remoteJid` | What was used as voter | What it SHOULD be |
|---|---|---|---|---|
| **Group: other person votes** | `234xxx@s.whatsapp.net` ✅ | `120xxx@g.us` | Their JID ✅ | Their JID ✅ |
| **Group: bot's own number votes** | `undefined` ❌ | `120xxx@g.us` ❌ | **The group JID** ❌ | **Bot's own PN JID** |
| **DM: other person votes** | `undefined` | `234xxx@s.whatsapp.net` | Other person's JID ✅ | Other person's JID ✅ |
| **DM: bot's own number votes** | `undefined` | `234xxx@s.whatsapp.net` | **Other person's JID** ❌ | **Bot's own PN JID** |
| **Self-chat: bot votes** | `undefined` | bot's own JID | Bot's own JID ✅ | Bot's own JID ✅ |

In the ❌ cases, the voter JID was **completely wrong** — either a group JID or the wrong person's JID. The AES-GCM decryption cannot succeed with incorrect JIDs because they're baked into the encryption key derivation (HMAC-SHA256) and the GCM additional data.

### Additional issue — LID vs PN format:
Even when the JID *identity* was correct, WhatsApp uses:
- **Creator JID:** LID format (`xxxxx@lid`)
- **Voter JID:** PN format (`xxxxx@s.whatsapp.net`)

Using PN for the creator also causes GCM auth failure.

## The Fix

### 1. Voter JID brute-force (the critical fix):
```js
const voterJidCandidates = [];
if (msg.key.fromMe) {
  // Bot's own number voted → use bot's own JIDs
  if (meIdPN) voterJidCandidates.push(meIdPN);
  if (meIdLID) voterJidCandidates.push(meIdLID);
} else if (msg.key.participant) {
  // Group: other person voted
  voterJidCandidates.push(jidNormalizedUser(msg.key.participant));
} else {
  // DM: other person voted
  voterJidCandidates.push(jidNormalizedUser(msg.key.remoteJid));
}
```

### 2. Creator JID brute-force:
```js
const creatorJidCandidates = [];
if (pollCreationKey.fromMe) {
  if (meIdLID) creatorJidCandidates.push(meIdLID);  // LID first
  if (meIdPN) creatorJidCandidates.push(meIdPN);     // PN fallback
}
```

### 3. Cross-product try-all:
```js
for (const creatorJid of creatorJidCandidates) {
  for (const voterJid of voterJidCandidates) {
    try { decryptPollVote(...) } catch { continue; }
  }
}
```

This tries up to 4 combinations (LID×PN, LID×LID, PN×PN, PN×LID) until one works.

### 4. Other fixes:
- `getMessage()` callback now returns poll messages from `pollCreationCache`
- Added `messages.update` handler for official Baileys poll decryption path
- Stored `fullMessage` in poll cache for `getAggregateVotesInPollMessage()`
- Proper cleanup of `messages.update` listener on socket restart

## Expected log output after fix:
```
[poll-menu] 📊 Vote received — pollId=ABC123, fromMe=true, cached=true, secretLen=64, options=4
[poll-menu] 🔑 Trying decryption — creators=[12345@lid, 23490xxx@s.whatsapp.net] voters=[23490xxx@s.whatsapp.net, 12345@lid]
[poll-menu] ✅ Decryption succeeded with creator=12345@lid, voter=23490xxx@s.whatsapp.net
[poll-menu] ✅ Matched hash to option 0: ╰┈➤ [ 1. 👑 Owner Menu ] → menu_owner
```
