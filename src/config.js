require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('./db');

const ban = n => fs.existsSync(path.join(__dirname, '..', 'assets', n)) ? `attachment://${n}` : '';
// Forgiving .env reading: quotes / spaces / <@&123> / <#123> pasted by mistake in any *_ID or *_IDS value still work.
const e = (k, d = '') => {
  let v = (process.env[k] || '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (/_IDS?$/.test(k) && v) { const n = v.match(/\d{15,22}/g); v = n ? (k.endsWith('_IDS') || k === 'OWNER_ID' ? n.join(',') : n[0]) : ''; }
  return v || d;
};
const list = s => s.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

// Roles created by `/setup roles` are used automatically when the matching .env value is empty.
// Anything you put in .env always wins.
const auto = k => db.setupRoles?.ids?.[k] || '';
const role = (envKey, autoKey) => e(envKey) || auto(autoKey);

// Link to a panel the bot posted itself (used when DASHBOARD_URL / SERVICES_URL are empty).
const panelUrl = k => {
  const p = db.panels?.[k];
  const g = e('GUILD_ID');
  return p?.channelId && g ? `https://discord.com/channels/${g}/${p.channelId}/${p.messageId || ''}`.replace(/\/$/, '') : '';
};

const cfg = {
  token: e('DISCORD_TOKEN'),
  clientId: e('CLIENT_ID'),
  guildId: e('GUILD_ID'),
  brand: e('BRAND_NAME', "Codey's Customs"),
  prefix: e('PREFIX', '-'),
  ownerIds: e('OWNER_ID').split(/[\s,]+/).filter(Boolean), // OWNER_ID=111,222 -> two owners
  get ownerId() { return this.ownerIds[0] || ''; },
  founded: e('FOUNDED_DATE'), // optional, e.g. 16/11/2026
  banners: { top: ban('top.png'), bottom: ban('bottom.png') }, // local files in /assets
  safeDomains: list(e('SAFE_LINK_DOMAINS', 'imgur.com,cdn.discordapp.com,media.discordapp.net,discord.com,roblox.com,youtube.com,youtu.be')),
};

// Channels/categories: .env wins, otherwise the ones /setupserver (or /setup channels) created.
const autoCh = k => db.setupChannels?.ids?.[k] || '';
const chan = (envKey, autoKey) => e(envKey) || autoCh(autoKey);
const CH = {
  reviews: ['REVIEWS_CHANNEL_ID', 'reviews'],
  welcome: ['WELCOME_CHANNEL_ID', 'welcome'],
  updates: ['UPDATES_CHANNEL_ID', 'updates'],
  success: ['SUCCESS_CHANNEL_ID', 'success'],             // "Thanks for your purchase!" after a successful order
  purchases: ['PURCHASES_CHANNEL_ID', 'purchases'],       // package purchase thank-yous
  saleLogs: ['SALE_LOGS_CHANNEL_ID', 'saleLogs'],         // detailed staff log of every sale
  transcripts: ['TRANSCRIPT_CHANNEL_ID', 'transcripts'],  // every closed ticket
  moderations: ['MODERATIONS_CHANNEL_ID', 'moderations'], // staff actions
  suggestions: ['SUGGESTIONS_CHANNEL_ID', 'suggestions'],
  packageSubmit: ['PACKAGE_SUBMIT_CHANNEL_ID', 'packageSubmit'],
};
cfg.channels = {};
for (const [k, [envKey, autoKey]] of Object.entries(CH))
  Object.defineProperty(cfg.channels, k, { enumerable: true, get: () => chan(envKey, autoKey) });
// ---- staff / ban / automod / security logs (each falls back to the one before it) ----
cfg.logs = {
  get staff() { return e('STAFF_LOGS_CHANNEL_ID') || cfg.channels.moderations; },
  get ban() { return e('BAN_LOGS_CHANNEL_ID') || this.staff; },
  get automod() { return e('AUTOMOD_LOGS_CHANNEL_ID') || this.staff; },
  get security() { return e('SECURITY_LOGS_CHANNEL_ID') || this.staff; },
};
// ---- env helpers for roles / users / toggles (read live so .env edits only need a restart) ----
cfg.ids = k => e(k).split(/[\s,]+/).filter(Boolean);
cfg.words = k => (process.env[k] || '').split(/[\s,]+/).map(x => x.replace(/^["']+|["']+$/g, '').trim()).filter(Boolean);
cfg.flag = (k, d = false) => {
  const o = db.toggles?.[k];                       // set from the owner panel: beats .env
  if (typeof o === 'boolean') return o;
  const v = e(k).toLowerCase(); return v ? ['1', 'true', 'yes', 'on'].includes(v) : d;
};
cfg.num = (k, d) => { const n = Number(e(k)); return Number.isFinite(n) && e(k) !== '' ? n : d; };
cfg.isOwner = id => cfg.ownerIds.includes(id);
// Marketplace (all optional): ticket category + ping role for purchase tickets
cfg.market = {
  get category() { return chan('MARKET_CATEGORY_ID', 'marketCat'); },
  get ping() { return e('MARKET_PING_ROLE_ID'); },
  // "Thanks for your purchase!" goes here (default: your SUCCESS channel)
  get thanks() { return e('MARKET_THANKS_CHANNEL_ID') || e('SUCCESS_CHANNEL_ID') || chan('SUCCESS_CHANNEL_ID', 'success') || '1571995577150083246'; },
  get vipRole() { return e('MARKET_VIP_ROLE_ID') || auto('vip'); },
};
cfg.categories = { get support() { return chan('SUPPORT_CATEGORY_ID', 'supportCat'); } };

// Live getters so roles/links created at runtime (/setup roles, /setup dashboard) are picked up without a restart.
cfg.urls = {
  get dashboard() { return e('DASHBOARD_URL') || panelUrl('dashboard'); },
  get services() { return e('SERVICES_URL') || panelUrl('services') || panelUrl('dashboard'); },
};
cfg.roles = {
  get staff() { return role('STAFF_ROLE_ID', 'staff'); },
  get client() { return role('CLIENT_ROLE_ID', 'client'); },
  get member() { return role('MEMBER_ROLE_ID', 'member'); },
};
cfg.pings = {
  get support() { return role('SUPPORT_PING_ROLE_ID', 'supportPing'); },
  get order() { return role('ORDER_PING_ROLE_ID', 'orderPing'); },
};
const svc = (key, label, emoji, envPrefix, autoKey, catKey) => ({
  key, label, emoji,
  get category() { return chan(`${envPrefix}_ORDER_CATEGORY_ID`, catKey); },
  get ping() { return role(`${envPrefix}_ORDER_PING_ROLE_ID`, autoKey); },
});
cfg.services = {
  bot:     svc('bot',     'Bot Development',     'pc',        'BOT',     'botOrderPing', 'botOrderCat'),
  discord: svc('discord', 'Discord Development', 'megaphone', 'DISCORD', 'discordOrderPing', 'discordOrderCat'),
  erlc:    svc('erlc',    'ERLC Development',    'bell',      'ERLC',    'erlcOrderPing', 'erlcOrderCat'),
};

module.exports = cfg;
