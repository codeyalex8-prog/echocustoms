# Codey's Customs Manager

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in
3. Discord Developer Portal -> Bot: enable **Server Members Intent** and **Message Content Intent**
4. Invite with `bot` + `applications.commands` scopes (Administrator is easiest)
5. `npm start` (slash commands register automatically)
6. In Discord: `/setupserver` (builds roles, channels and permissions, posts the panels), then `/status` to open/close.

Banners are local files: assets/top.png and assets/bottom.png (no links). Packages post in whatever channel you run the command in.

The bot must be in the server that owns your custom emojis for them to render.

## Commands
Owner: /ownerpanel (buttons + dropdowns for status, panels, blacklist, backup, say)
Setup/admin: /setupserver /setup (dashboard|services|roles|channels) /redoserver /redoroles /redochannels /status /package /announce /blacklist /stats /reviews /portfolio
Tickets: /ticketrename /ticketadd /ticketremove /ticketclaim /close /transcript
Orders: /queue (view|list|move) /progress /quote /deadline
Clients: /review /link

Idle support tickets get a warning after 48h and auto-close 24h later. Orders with a /deadline ping staff 24h before and when overdue.

## v3 additions
- Service status is now open (green) / delayed (yellow) / closed (red). Closed blocks orders, delayed allows them with a warning.
- /livestats posts a public sales panel that refreshes every 20 seconds.
- /submitpackage -> #package-submit with Approve/Reject -> posts to #package-upload.
- New: /help /ping /myorder /tickets /ticketinfo /clientinfo /note /say

## v4: 20 more commands
/ticketlock /ticketpriority /invoice /refund /remindclient /giveaway /suggest /warn /warnings /timeout /kick /ban /purge /slowmode /lockdown /userinfo /serverinfo /unlink /faq /remindme
New env: SUGGESTIONS_CHANNEL_ID. Moderation actions log to MODERATIONS_CHANNEL_ID.

## Server setup: /setupserver (roles + channels + permissions)
`/setupserver` builds everything in one go, then posts the dashboard (#echo-customs) and services (#order) panels. Run it as someone with Manage Server, with the bot's role at the **top** of the role list and Administrator (or at least Manage Roles + Manage Channels).
You can also run the halves separately: `/setup roles`, then `/setup channels`.

**Roles** (top to bottom, with a spacer between each group)
- Executive: Owner, Executive, Co-Executive, Assistant Executive (give Owner to both owners)
- Staff Team: Staff (the base role the bot checks)
- Management: Management, Manager
- Moderation: Discord Moderators
- Quality Assurance: Quality Assurance
- Ranks: Senior, Junior, Trial (stack these on a team role, e.g. Discord Moderators + Senior)
- Members: VIP, Client, Partner, Friend, Member
- Pings: Free Release, Announcement, Update, Order Status, Giveaway, Package
- Staff Pings: Support, Order, Bot Order, Discord Order, ERLC Order (the bot uses these in tickets)

Permissions come from the team role (Discord Moderators = timeout/kick/manage messages, Management adds ban + audit log, Manager adds @everyone mentions). Senior/Junior/Trial are display ranks with no permissions. Nobody gets Administrator.

**Channels** follow your template: Verification, Important, Services, Packages (forums, or text if Community isn't enabled), Community, Staff (staff only), Underground (logs, locked down), plus the four ticket categories.
- Public info channels are read-only for members. Staff channels are hidden from everyone but staff. #sales-logs and #package-upload are Management + Executives only. #moderations and #transcripts are Moderators + Management + Executives. #owner-only is the Owner role only. #purchases is a public read-only thank-you wall.
- Channels, log channels and ticket categories are wired into the bot automatically (values in `.env` still win).

**Undo:** `/redoserver` (everything), `/redochannels`, `/redoroles`. Each asks you to confirm and only deletes what the setup created. Anything that already existed or that you made yourself is never touched. Running setup twice is safe, it skips what exists.
To change names or permissions, edit `ROLES` in `src/roles.js` and `TEMPLATE` in `src/server.js`.

## Owners and emojis
- Two owners: `OWNER_ID=111111111111111111,222222222222222222`. Both can use `/ownerpanel` and `/setup roles`/`/redoroles`.
- Emojis are found by name in your server (donationicon, pcicon, likeicon, etc.). The bot logs any it can't find and shows a normal emoji instead.


## v5: prefix commands, staff logs, proof bans, auto-mod, security

**New .env keys** (all in `.env.example`, restart the bot after editing): `STAFF_LOGS_CHANNEL_ID`, `BAN_LOGS_CHANNEL_ID`, `AUTOMOD_LOGS_CHANNEL_ID`,
`WARN_ROLE_IDS`, `KICK_ROLE_IDS`, `BAN_ROLE_IDS`, `NOTE_ROLE_IDS`, `TIMEOUT_ROLE_IDS`, `JAIL_ROLE_IDS`, `STRIKE_ROLE_IDS`, `PROOF_REQUIRED_FOR`, `PANEL_USER_IDS`, `PANEL_ROLE_IDS`, `AUTOMOD_*`, `PREFIX`, `BRAND_NAME`.

**Prefix commands.** Every slash command also works with `-` (change it with `PREFIX`):
`-claim` `-close reason` `-kick @user reason` `-ban @user reason <proof link>` (or attach an image) `-warn @user reason` `-timeout @user 30m reason`
`-note add @user text` `-queue list` `-progress testing` `-lock` / `-unlock` `-jail @user reason` `-strikes view @user`. Missing something? The bot replies with the usage.
Short names: claim, rename, add, remove, lock, unlock, priority, tinfo, remind, q, prog, due, ci, w, warns, mute, unmute, b, k, bl, notes, cases.

**Staff logs.** Every warn / kick / ban / unban / timeout / note / jail / auto-mod action becomes a numbered case in the staff logs channel (bans in `BAN_LOGS_CHANNEL_ID` if set). Proof is re-uploaded into the log so it never expires. `/history @user` shows a person's cases.

**Roles + proof.** Set the role IDs in `.env` to choose who can warn / kick / ban / note / timeout / jail. Owner(s) in `OWNER_ID` bypass everything. A **ban needs proof** (attachment or link) unless you are an owner; add more actions with `PROOF_REQUIRED_FOR=ban,kick`.

**Panels and embeds are owner only** (`/setup dashboard|services`, `/setupserver`, `/staffinfo`, `/announce`, `/say`, `/portfolio show`, `/faq post`, `/livestats`, `/reviews`, `/giveaway start`, `/package create`). `PANEL_USER_IDS` / `PANEL_ROLE_IDS` can extend that.

**Auto-moderation.** Links are deleted and logged. Swearing = 1 strike (the message is deleted):
3 strikes 30m timeout · 6 strikes 24h timeout · 9 kick · 12 temp ban (`TEMPBAN_DAYS`) · 15 permanent ban. Also anti-spam and mass-mention protection. The ladder is shown in the dashboard Guidelines. Extra words: `/addword`, `/removeword` (owner). Staff are exempt from the link rule, the owner from everything.

**Security.** `-setupsecurity` (owner) creates the **Prisoner** role and denies it view/send in every channel, and in every channel or category created later. `-jail @user reason` strips their roles (saved) and gives Prisoner, `-unjail @user` gives them back. Leaving and rejoining does not free a prisoner. Put the bot's role **above** Prisoner. Raid protection is not built yet.

**Staff Information panel.** `/staffinfo` (owner) posts the dropdown panel: Staff Guidelines, Staff Expectations, Staff Commands, Owner Commands, Everyone Commands. Edit the text in `src/staffinfo.js`.

**Banners.** Replace `assets/top.png` and `assets/bottom.png` with your Codey's Customs images (same file names). The bot needs the Ban Members, Kick Members, Moderate Members, Manage Roles, Manage Messages and Manage Channels permissions (Administrator is easiest).

## Anti-raid + prison
- Bot needs **Administrator** (or View Audit Log + Manage Roles/Channels + Ban/Kick) and its role must be at the very top. Enable the **Server Members Intent**.
- `/setupsecurity` creates the Prisoner role and locks it out of every channel. `/channelpannelsetup` builds the prison category, the prisoner-only appeal channel and the panel (top/bottom banners).
- Fill in the `ANTI-RAID + PRISON` block of `.env` (immune roles, who may give Administrator, who may remove Prisoner, prison staff roles).
- Appeal tickets show exactly what the prisoner did. Staff can **Release** (roles come back automatically) or **Close**.

## Anti-raid + prison
- Bot needs Administrator (or View Audit Log + Manage Roles/Channels + Ban/Kick) and its role must be at the very top. Enable the Server Members Intent.
- /setupsecurity creates the Prisoner role and locks it out of every channel. /channelpannelsetup builds the prison category, the prisoner-only appeal channel and the panel (top/bottom banners).
- Fill in the ANTI-RAID + PRISON block of .env (immune roles, who may give Administrator, who may remove Prisoner, prison staff roles).
- Appeal tickets show exactly what the prisoner did. Staff can Release (roles come back automatically) or Close.
- `/security level low|medium|high` sets how strict the anti-raid is (`/security status` shows it). Medium is the default.

## Marketplace + sticky messages
- **Items:** `src/market.items.js` holds your 8 game passes in 3 dropdown categories (Paid Ads, Roles, Post Times). Edit it and restart; the posted panel refreshes itself.
- **`/market post`** (owner, also `-market post`) posts the panel: dropdown, **Claim Purchase**, **View Queue**, **Marketplace TOS**.
- **Dropdown:** picking a category shows every pass in it with a **Buy** link button (the real Roblox game-pass link and the live price), plus **Link Roblox / Unlink**, **Claim Purchase** and **View Queue**.
- **Automatic pick-up:** after someone opens a category, the bot checks their linked Roblox inventory every 30s for 45 minutes. When the pass appears it opens a `market-0001` ticket (or adds to their open one), posts "Thanks for your purchase!" in `MARKET_THANKS_CHANNEL_ID` (default: `SUCCESS_CHANNEL_ID`), logs it in sale-logs and gives the VIP role for the VIP pass. **Claim Purchase** does the same on demand. A pass can only be claimed once per Roblox account.
- **Queue:** Instant Post first, then Priority Post, then everyone else (oldest first). Closing the ticket removes the entry.
- `.env` (all optional): `MARKET_CATEGORY_ID`, `MARKET_PING_ROLE_ID`, `MARKET_THANKS_CHANNEL_ID`, `MARKET_VIP_ROLE_ID`. Roblox inventories must be public.
- **`/sticker message <text>`** (staff, also `-sticker message text`) keeps a message at the bottom of the channel. `/sticker remove` and `/sticker list` manage them. Type `\n` for a new line.

## AI, smart auto-mod, weekly digest, owner control center (added)
Set `GEMINI_API_KEY` in `.env` (see the new block at the bottom of `.env.example`). No key = the AI parts switch themselves off and the rest keeps working.

**Smart auto-mod** (`src/smartmod.js`, on top of the normal auto-mod and strike ladder)
- Disguised swearing: look-alike letters (Cyrillic/Greek), fullwidth text, zero-width characters, leetspeak, spaced letters, vowel-less swears.
- Scams, phishing, malware tricks and fake staff (free Robux/Nitro, overpayment scams, "paste this in PowerShell", cookie/token theft, fake QR login, "I'm staff, DM me"), plus look-alike domains (`dlscord.com`, `rob1ox-free.com`).
- Clear-cut cases are handled instantly by free local rules. Grey-zone messages go to Gemini for a verdict (only suspicious ones are sent, so cost stays low). Hard daily cap: `AI_DAILY_CALL_LIMIT`.
- Images (Gemini vision): NSFW, gore, fake giveaway/payment screenshots, scam QR codes. Flagged images are deleted and **never re-uploaded** to the logs. Limit: the AI cannot always decode a QR code, so QR links are only checked when it can read them.
- Impersonation guard: usernames, nicknames and avatars that copy your staff, owners or the brand are renamed/jailed/alerted on join, on name change, on first message and every 30 minutes.
- Every serious catch posts a review card in the auto-mod log with **Ban / Kick / Jail / False positive / Trust user**. False positive undoes the timeout, strike or rename.
- A flagged **staff** account is never punished automatically: the message is deleted and the owners are alerted (probably hacked).
- `/smartmod test <text>` shows exactly how a message would be judged without deleting anything. `/smartmod status | trust | untrust | scanmembers`.

**Weekly digest** (`src/digest.js`)
- Sunday 18:00 (Europe/London by default) in `DIGEST_CHANNEL_ID`: sales, queue health, staff performance, moderation + smart-mod catches, member growth, 8-week trends, suggested actions.
- All numbers are counted by the bot, Gemini only writes the commentary. AI off = template report.
- The first run only starts counting; the first real report comes at the next slot. `/digest preview` (does not reset counters), `/digest post` (resets), `/digest status`.

**Owner control center** (`/ownerpanel`) is now a paged panel (menu at the top):
Home · Status & activity · Bot profile · Protection · AI & smart-mod · Weekly digest · System.
- Status: online / idle / do not disturb / invisible, activity type + text, `{members} {tickets} {queue} {orders} {robux} {open} {ping} {uptime}` live variables, rotating activities, presets, auto status that follows your open/delayed/closed services. Also `/presence set|reset|show`.
- Profile: username, avatar, banner, server nickname, about me.
- Protection: live on/off for auto-mod, links, anti-spam, anti-raid, **maintenance mode** (only owners can use the bot), anti-raid level, banned words, clear strikes, **disable/enable any command**.
- AI & smart-mod: master switches, sensitivity, AI scope, scam and impersonation punishments, test the AI, test a message, scan members, trust users, daily AI limit.
- System: diagnostics, DB backup, re-register commands, reload emojis, DM a user, recent errors, restart / shut down (with confirmation).
- Switches are saved in the database and beat `.env`. Every change is logged to your moderations channel.

## AI tools for tickets and staff (added)
All optional, all in **Owner panel > AI tools**. Needs `GEMINI_API_KEY`. The AI only knows your FAQ, packages, portfolio, services and the knowledge base you give it with `/ai kb_add`.
- **Order brief:** a new order gets a short summary and a few questions for the client in the ticket, and a staff-only card (complexity 1-5, red flags, suggested quote range) in `AI_BRIEF_CHANNEL_ID`. Quote ranges are computed from your own past closed orders (needs 3+ per service), never invented.
- **Support assistant:** answers clients by itself in support tickets and order tickets, no approval step. It knows how this server and bot work (it links the real order channel, explains Begin Order, the quote, the queue, marketplace, rules), the live status of the client's own order, your FAQ and knowledge base. It stays quiet while staff are talking in the ticket, only says "a team member will help" once in a while, and never invents prices. Every ticket and order has a **Stop AI** button (ticket owner or staff) that turns it off there and back on.
- **Mood alerts:** an angry or frustrated client pings your staff channel once per ticket per 6 hours.
- **Summaries:** every closed ticket gets an AI summary under its transcript, and its price is saved for quote ranges.
- **Reference notes:** images clients upload in an order get style tags, approximate palette and text notes.
- **`/ai` (staff):** `summarize` (brief whoever takes over), `quote`, `translate`, `refs`, `modcase` (advice on a member's record), `status`. **Owner:** `suggestfaq` (new FAQ entries from recent tickets, one-click add), `kb_add`, `kb_list`, `kb_remove`.


## v5: support-ticket AI, fast and free
- **AI only in support tickets.** Order tickets have no AI at all (no briefs, no assistant, no reference notes, no Stop AI button).
- A new support ticket gets "Hello, how may I help you?" instantly (editable in the owner panel), then the AI answers what the client typed in the form and every message after, with real links ("you can order here: #order").
- **Stop AI**: button on the ticket panel (it becomes "Turn AI on"), or `/stopai` and `/startai` inside the ticket. The AI also stays quiet while a team member is replying.
- **Free + fast:** put a free key from https://console.groq.com/keys in `GROQ_API_KEY`. Gemini stays as a backup, and the bot hops between models by itself when one hits its free limit.
- New: `/ask` (any member), `/ai reply` (draft a reply), `/ai polish` (rewrite announcements), escalation notes for staff when the AI cannot help.
- **Owner panel** has new pages: *AI support assistant*, *AI engine* (provider, speed test), *Tickets*, and *Status & visibility* (online / idle / do not disturb / invisible + custom status). The one-tap status row is also on the Home page.


## Update: white emojis, #commands channel, more AI

**Emojis.** Every message, button, dropdown, DM and AI reply now goes through one filter (`src/emojis.js`). Unicode emojis are swapped for your white server icons (map in `UNI`), and any emoji with no white icon is removed. Run `/emojis` (owner) to see which icons were found; if one is missing, rename the server emoji to match or add its name in `emojis.js`. Channel and category names can't hold custom emojis, so those are unchanged.

**Commands channel.** Members can only use commands in the text channel named `commands` (override with `COMMANDS_CHANNEL_ID`). Elsewhere, slash commands get a private refusal and `-` commands are deleted. Staff, mods and owners can use commands anywhere. If no `commands` channel exists, member commands are paused.

**Permissions.** Every command is classified in `src/perms.js` (PUBLIC / STAFF / ADMIN / PERM / PANEL / OWNER_ONLY / mod roles). A command not listed anywhere is owner-only. When you add a command, add it to one of those lists.

**New AI.** `/ai quote` (price + timeline helper), `/ai scope` (milestone plan), `/ai update` (client progress draft) for staff in order tickets; `/brief` for members. Switch `/brief` off with `AIT_BRIEFHELP=false`.


## v8 changes
- AI in tickets is gone (no greeting, auto-replies, Stop AI, /ask, /ai). AI is only used for smart auto-mod and ticket / appeal summaries.
- Immunity is no longer in .env: only OWNER_ID, the server owner and the bot are immune. The owner adds others with `/immune @user` (run again to remove), `/immunelist`.
- Only the owner can release prisoners (appeal button, `/unjail`, owner panel).
- `/securitycheck` (owner) shows exactly what is missing for prison + anti-raid.
- Owner panel: new Security & prison, Setup check pages; Bot page holds visibility/status/profile.
