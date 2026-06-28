# 🌑 EVENTIDE OMEGA — Full Command Plan

## Current status: ✅ = Built, 🔲 = To Build

---

## 👑 OWNER MENU (Power commands — owner only)

### Mode & Control
| Command | Description | Status |
|---|---|---|
| `.mode private/public` | Who the bot responds to | ✅ |
| `.kill` | Emergency halt — freeze everything instantly | ✅ |
| `.broadcast <msg>` | Send to all open groups (skips admin-only & community channels) | ✅ |
| `.stopbroadcast` | Cancel an ongoing broadcast | 🔲 |

### Dominion (User management)
| Command | Description | Status |
|---|---|---|
| `.block <number>` | Block a user on WhatsApp | ✅ |
| `.unblock <number>` | Unblock a user | ✅ |
| `.blocklist` | Show all blocked users | ✅ |
| `.ban @user` | Soft-ban — bot ignores this user everywhere | 🔲 |
| `.unban @user` | Remove soft-ban | 🔲 |
| `.banlist` | Show all soft-banned users | 🔲 |

### Territory (Group navigation)
| Command | Description | Status |
|---|---|---|
| `.join <link>` | Join a group via invite link | ✅ |
| `.leave` | Leave current group | ✅ |
| `.groups` | List all groups the bot is in | ✅ |

### Surveillance (Info extraction)
| Command | Description | Status |
|---|---|---|
| `.getpp <@tag/number>` | Get someone's profile picture | ✅ |
| `.getgpp` / `.getgpp <link>` | Get group profile picture | ✅ |
| `.chatinfo` | Info about current chat/group | ✅ |

### Tools
| Command | Description | Status |
|---|---|---|
| `.vv` | Open view-once messages | ✅ |
| `.forward <number>` | Forward replied message to a number | 🔲 |
| `.save` | Save replied message to bot's self-chat | 🔲 |
| `.clear` | Delete all bot messages in current chat | 🔲 |

**Owner Menu Total: 20 commands (15 built, 5 to build)**

---

## 👥 GROUP MENU (Group management — admin commands)

### Member Management
| Command | Description | Status |
|---|---|---|
| `.kick @user` | Remove someone from group | 🔲 |
| `.add <number>` | Add someone to group | 🔲 |
| `.promote @user` | Make someone admin | 🔲 |
| `.demote @user` | Remove admin from someone | 🔲 |

### Group Settings
| Command | Description | Status |
|---|---|---|
| `.setgname <name>` | Change group name | 🔲 |
| `.setgdesc <text>` | Change group description | 🔲 |
| `.setgpp` | Change group profile pic (reply to image) | 🔲 |
| `.lock` | Only admins can send (close group) | 🔲 |
| `.unlock` | Everyone can send (open group) | 🔲 |
| `.link` | Get group invite link | 🔲 |
| `.revoke` | Revoke group invite link | 🔲 |

### Tagging
| Command | Description | Status |
|---|---|---|
| `.tagall` | Tag all group members | 🔲 |
| `.everyone` / `.all` | Same as tagall with message | 🔲 |
| `.hidetag <msg>` | Send message that secretly tags everyone | 🔲 |
| `.membercount` | Show member count breakdown | 🔲 |

### Protection
| Command | Description | Status |
|---|---|---|
| `.antilink on/off` | Auto-delete messages with links | 🔲 |
| `.antispam on/off` | Rate-limit spammers | 🔲 |
| `.antimention on/off` | Block mass-mentions | 🔲 |
| `.antidelete on/off` | Re-send deleted messages | 🔲 |
| `.antibot on/off` | Block other bots | 🔲 |
| `.antibug on/off` | Block crash/bug messages | 🔲 |

### Warnings
| Command | Description | Status |
|---|---|---|
| `.warn @user` | Warn a user (3 warns = auto-kick) | 🔲 |
| `.warnlist` | Show all warned users | 🔲 |
| `.resetwarn @user` | Reset warnings for a user | 🔲 |

### Welcome/Goodbye
| Command | Description | Status |
|---|---|---|
| `.welcome on/off` | Auto-welcome new members | 🔲 |
| `.setwelcome <text>` | Set custom welcome message | 🔲 |
| `.goodbye on/off` | Auto-goodbye leaving members | 🔲 |
| `.setgoodbye <text>` | Set custom goodbye message | 🔲 |

### Scheduling
| Command | Description | Status |
|---|---|---|
| `.schedule HH:MM <msg>` | Schedule a message | 🔲 |
| `.unschedule HH:MM` | Remove a scheduled message | 🔲 |
| `.schedules` | List all schedules | 🔲 |

**Group Menu Total: 31 commands (0 built)**

---

## ⚙️ CONFIG MENU (Settings & personalization — per-session)

### Identity
| Command | Description | Status |
|---|---|---|
| `.setname <name>` | Change bot display name | ✅ |
| `.setbio <text>` | Change bot bio/about | ✅ |
| `.setpp` | Change bot profile pic | ✅ |

### Aliases
| Command | Description | Status |
|---|---|---|
| `.setalias <cmd> <new>` | Rename a command (per-session) | ✅ |
| `.delalias <cmd>` | Remove an alias | ✅ |
| `.aliaslist` | Show all aliases | ✅ |

### Persona
| Command | Description | Status |
|---|---|---|
| `.persona eclipse/astraea` | Switch bot personality | ✅ |

### Automation
| Command | Description | Status |
|---|---|---|
| `.prefix <char>` | Change command prefix | ✅ |
| `.autoreact on/off/add/clear` | Auto-react system | ✅ |
| `.autoreply add <trigger> <response>` | Auto-reply to specific words | 🔲 |
| `.autoreply remove <trigger>` | Remove an auto-reply | 🔲 |
| `.autoreply list` | List all auto-replies | 🔲 |

**Config Menu Total: 14 commands (9 built, 3 to build)**

---

## 📊 SYSTEM MENU (Diagnostics & info)

### Vitals
| Command | Description | Status |
|---|---|---|
| `.uptime` | Bot uptime + memory stats | ✅ |
| `.ping` | Latency test | ✅ |
| `.status` | Full system health report | ✅ |
| `.speed` | Message round-trip speed test | 🔲 |

### Identity
| Command | Description | Status |
|---|---|---|
| `.owner` | Show owner info | ✅ |
| `.acccheck` | Business vs Normal account check | ✅ |

### Control
| Command | Description | Status |
|---|---|---|
| `.restart` | Restart bot connection | ✅ |
| `.pair <number>` | Pair a new device | ✅ |
| `.relink` | Clear session and restart | ✅ |

**System Menu Total: 9 commands (8 built, 1 to build)**

---

## 🎮 FUN MENU (Games, jokes & entertainment)

### Social Fun
| Command | Description | Status |
|---|---|---|
| `.joke` | Random joke | 🔲 |
| `.fact` | Random fun fact | 🔲 |
| `.quote` | Motivational/random quote | 🔲 |
| `.roast @user` | Roast someone | 🔲 |
| `.compliment @user` | Compliment someone | 🔲 |
| `.ship @user1 @user2` | Love compatibility % | 🔲 |
| `.rate @user` | Rate someone (random %) | 🔲 |
| `.vibe @user` | Vibe check | 🔲 |

### Games
| Command | Description | Status |
|---|---|---|
| `.8ball <question>` | Magic 8-ball | 🔲 |
| `.flip` | Coin flip | 🔲 |
| `.roll` | Dice roll (1-6) | 🔲 |
| `.dare` | Random dare | 🔲 |
| `.truth` | Random truth question | 🔲 |
| `.guessflag` | Flag guessing game | 🔲 |
| `.typingtest` | Typing speed test | 🔲 |
| `.tictactoe @user` | Tic-tac-toe | 🔲 |
| `.connect4 @user` | Connect 4 game | 🔲 |
| `.trivia` | Trivia quiz | 🔲 |
| `.math` | Math challenge | 🔲 |

### Media
| Command | Description | Status |
|---|---|---|
| `.sticker` | Convert image/video to sticker | 🔲 |
| `.toimg` | Convert sticker to image | 🔲 |
| `.tts <text>` | Text to speech/voice note | 🔲 |
| `.qr <text>` | Generate QR code | 🔲 |

**Fun Menu Total: 23 commands (0 built)**

---

## 🐞 BUG/TOOLS MENU (Reports & utilities)

### Reports
| Command | Description | Status |
|---|---|---|
| `.report <text>` | Report a bug to the developer | 🔲 |

### Downloaders
| Command | Description | Status |
|---|---|---|
| `.dl <url>` | Universal media downloader | 🔲 |
| `.yt <url>` | YouTube video download | 🔲 |
| `.ytmp3 <url>` | YouTube to MP3 | 🔲 |
| `.tiktok <url>` | TikTok video download | 🔲 |
| `.ig <url>` | Instagram media download | 🔲 |
| `.fb <url>` | Facebook video download | 🔲 |
| `.x <url>` | X/Twitter media download | 🔲 |
| `.pin <url>` | Pinterest download | 🔲 |

### Utilities
| Command | Description | Status |
|---|---|---|
| `.translate <lang> <text>` | Translate text | 🔲 |
| `.weather <city>` | Weather info | 🔲 |
| `.calc <expression>` | Calculator | 🔲 |
| `.genpwd` | Generate random password | 🔲 |
| `.base64 <text>` | Base64 encode/decode | 🔲 |
| `.removebg` | Remove image background | 🔲 |

### Image Editing
| Command | Description | Status |
|---|---|---|
| `.blur` | Blur an image (reply) | 🔲 |
| `.invert` | Invert colors | 🔲 |
| `.grayscale` | Convert to grayscale | 🔲 |
| `.brighten` | Brighten image | 🔲 |
| `.sharpen` | Sharpen image | 🔲 |
| `.pixelate` | Pixelate image | 🔲 |

**Bug/Tools Menu Total: 22 commands (0 built)**

---

## 🔴 ARCHITECT MENU (Dev only)

| Command | Description | Status |
|---|---|---|
| `.eval <code>` | Execute JavaScript | 🔲 |
| `.shell <cmd>` | Execute shell command | 🔲 |
| `.debug on/off` | Toggle verbose logging | 🔲 |
| `.flush` | Clear all caches | 🔲 |

**Architect Menu Total: 4 commands (0 built)**

---

## 📊 GRAND TOTAL

| Menu | Built | To Build | Total |
|---|---|---|---|
| 👑 Owner | 15 | 5 | 20 |
| 👥 Group | 0 | 31 | 31 |
| ⚙️ Config | 9 | 3 | 14* |
| 📊 System | 8 | 1 | 9 |
| 🎮 Fun | 0 | 23 | 23 |
| 🐞 Bug/Tools | 0 | 22 | 22 |
| 🔴 Architect | 0 | 4 | 4 |
| **TOTAL** | **32** | **89** | **123** |

*Config counts `.autoreply` as 3 subcommands

---

## Build Priority (suggested order):

1. **Group Menu** — most requested, essential for any WA bot
2. **Fun Menu** — easy wins, makes the bot entertaining  
3. **Bug/Tools Menu** — downloaders are killer features
4. **Architect Menu** — dev convenience
5. **Remaining Owner/Config/System** — finishing touches
