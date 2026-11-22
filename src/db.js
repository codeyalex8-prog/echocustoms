const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'data', 'db.json');
const def = {
  counters: { support: 0, order: 0, package: 0, portfolio: 0, submission: 0, case: 0, market: 0 },
  status: { bot: 'open', discord: 'open', erlc: 'open' }, // 'open' | 'delayed' | 'closed'
  panels: {},
  packages: {},
  links: {},     // discordId -> { robloxId, name }
  clicks: {},    // `${userId}:${pkgId}` -> timestamp
  reviewed: {},  // ticketName -> true
  claimed: {},
  marketWatch: {},  // discordId -> { items: [itemId], until } users we are polling for a purchase
  marketClaims: {}, // `${robloxId}:${itemId}` -> { discordId, robloxName, at, channelId }
  stickies: {},     // channelId -> { text, messageId, by, at } (/sticker)
  tickets: {},   // channelId -> ticket record (panel id, progress, quote, due ...)
  queue: [],     // ordered list of open order channel ids
  blacklist: {}, // userId -> { reason, by, at }
  clients: {},   // userId -> { orders, successful }
  notes: {},     // userId -> [{ by, text, at }]
  submissions: {}, // pending package submissions
  warns: {},       // userId -> [{ by, reason, at }]
  cases: {},       // moderation case id -> { action, modId, userId, reason, proof ... }
  strikes: {},     // userId -> { count, history: [{ at, reason, kind, content }] }
  tempbans: {},    // userId -> { until }
  automod: { words: [] },        // extra banned words added with -addword
  security: {},    // { prisonerRoleId }
  jailed: {},      // userId -> { roles: [...], by, reason, at }
  toggles: {},     // runtime on/off overrides set in the owner panel: KEY -> true|false (beats .env)
  maintenance: { on: false },
  disabledCmds: {}, // command name -> true (disabled in the owner panel)
  giveaways: {},
  suggestions: {},
  faq: [],         // { id, q, a }
  reminders: [],   // { userId, channelId, at, text }
  portfolio: [], // { id, title, description, category, image, link }
  stats: { ordersOpened: 0, ordersClosed: 0, ordersSuccessful: 0, ticketsClosed: 0, ratingSum: 0, ratingCount: 0, packageSales: 0, robuxEarned: 0, byStaff: {} },
};
let data = { ...def };
try { data = { ...def, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
// migrate old saves
data.stats = { ...def.stats, ...(data.stats || {}) };
data.counters = { ...def.counters, ...(data.counters || {}) };
for (const k of ['cases', 'strikes', 'tempbans', 'security', 'jailed', 'toggles', 'disabledCmds']) data[k] = data[k] || {};
data.maintenance = { on: false, ...(data.maintenance || {}) };
data.automod = { words: [], ...(data.automod || {}) };
data.status = data.status || {};
for (const k of ['bot', 'discord', 'erlc']) {
  const v = data.status[k];
  data.status[k] = v === false ? 'closed' : (v === true || v === undefined) ? 'open' : v;
}
const svcState = k => data.status[k] || 'open';

function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
module.exports = { db: data, save, svcState };
