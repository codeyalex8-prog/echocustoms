// Everything about how the bot LOOKS on Discord, controlled from the owner panel (or /presence).
//   status:    online · idle (away) · dnd (do not disturb) · invisible
//   activity:  Playing / Watching / Listening to / Competing in / Streaming / Custom status text
//   variables: {members} {tickets} {queue} {orders} {robux} {open} {ping} {uptime} {servers}
//   rotation:  cycle through a list of activities every N seconds
//   auto:      status colour follows your services (all closed = do not disturb, any delayed/closed = idle, else online)
// Everything is saved in db.presence and re-applied when the bot starts.
const { ActivityType, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { db, save, svcState } = require('./db');
const ui = require('./ui');
const { E, tag } = require('./emojis');
const { add, sc } = require('./commands');

const EPH = MessageFlags.Ephemeral;
const TYPES = {
  playing: ActivityType.Playing, watching: ActivityType.Watching, listening: ActivityType.Listening,
  competing: ActivityType.Competing, streaming: ActivityType.Streaming, custom: ActivityType.Custom,
};
const TYPE_LABEL = { playing: 'Playing', watching: 'Watching', listening: 'Listening to', competing: 'Competing in', streaming: 'Streaming', custom: 'Custom status', none: 'No activity' };
const STATUS_LABEL = { online: '🟢 Online', idle: '🌙 Idle (away)', dnd: '⛔ Do Not Disturb', invisible: '⚫ Invisible' };

const PRESETS = {
  open:        { label: 'Orders: show queue size', status: 'online', type: 'watching', text: '{queue} orders in the queue' },
  tickets:     { label: 'Watching open tickets', status: 'online', type: 'watching', text: '{tickets} open tickets' },
  members:     { label: 'Watching the members', status: 'online', type: 'watching', text: '{members} members' },
  building:    { label: 'Playing: building your orders', status: 'online', type: 'playing', text: 'building your orders 🛠️' },
  ideas:       { label: 'Listening to your ideas', status: 'online', type: 'listening', text: 'your ideas 💡' },
  competing:   { label: 'Competing in ERLC builds', status: 'online', type: 'competing', text: 'ERLC builds' },
  busy:        { label: 'Busy (do not disturb)', status: 'dnd', type: 'custom', text: '🔥 Busy, check the queue' },
  away:        { label: 'Away (idle)', status: 'idle', type: 'custom', text: '😴 Away for a bit' },
  maintenance: { label: 'Maintenance (do not disturb)', status: 'dnd', type: 'custom', text: '🔧 Maintenance, back soon' },
  stealth:     { label: 'Stealth (invisible)', status: 'invisible', type: 'none', text: '' },
};

function P() {
  const p = (db.presence = db.presence || {});
  p.status ||= 'online';
  p.type ||= 'watching';
  if (p.text === undefined) p.text = '{queue} orders in the queue';
  p.url ||= '';
  p.auto ??= false;
  p.rotate ||= { on: false, interval: 60, items: [], idx: 0, last: 0 };
  return p;
}

// ---------------- variables ----------------
const startedAt = Date.now();
function uptime() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function vars(client) {
  const g = client.guilds?.cache.get(cfg.guildId);
  const states = Object.keys(cfg.services).map(k => svcState(k));
  return {
    members: g?.memberCount ?? 0, tickets: Object.keys(db.tickets || {}).length, queue: db.queue?.length ?? 0,
    orders: db.stats?.ordersSuccessful ?? 0, robux: (db.stats?.robuxEarned ?? 0).toLocaleString('en-US'),
    open: states.every(s => s === 'closed') ? 'Orders closed' : states.some(s => s === 'delayed') ? 'Orders delayed' : 'Orders open',
    ping: Math.round(client.ws?.ping ?? 0), uptime: uptime(), servers: client.guilds?.cache.size ?? 1,
  };
}
const renderText = (client, text) => require('./emojis').strip(String(text || '')).replace(/\{(\w+)\}/g, (m, k) => { const v = vars(client)[k]; return v === undefined ? m : v; });   // a status line can't show custom emoji, so none are used

function autoStatus() {
  const st = Object.keys(cfg.services).map(k => svcState(k));
  if (st.every(s => s === 'closed')) return 'dnd';
  if (st.some(s => s !== 'open')) return 'idle';
  return 'online';
}
const currentItem = () => { const p = P(); return p.rotate.on && p.rotate.items.length ? p.rotate.items[p.rotate.idx % p.rotate.items.length] : { type: p.type, text: p.text, url: p.url }; };
const effectiveStatus = () => (P().auto ? autoStatus() : P().status);

// ---------------- applying ----------------
let lastSig = '';
async function apply(client, force = false) {
  if (!client?.user) return;
  const item = currentItem();
  const status = effectiveStatus();
  const activities = [];
  if (item.type && item.type !== 'none' && item.text) {
    const text = renderText(client, item.text).slice(0, 128);
    if (text) {
      const a = { name: text, type: TYPES[item.type] ?? ActivityType.Watching };
      if (item.type === 'custom') { a.name = 'Custom Status'; a.state = text; }
      if (item.type === 'streaming') a.url = /^https:\/\/(www\.)?(twitch\.tv|youtube\.com)\//i.test(item.url || '') ? item.url : 'https://www.twitch.tv/discord';
      activities.push(a);
    }
  }
  const sig = JSON.stringify({ status, activities });
  if (!force && sig === lastSig) return;
  lastSig = sig;
  client.user.setPresence({ status, activities });
}

// runs every 15 seconds: rotation + live variables + auto status
async function tick(client) {
  const p = P(); const now = Date.now();
  if (p.rotate.on && p.rotate.items.length && now - (p.rotate.last || 0) >= Math.max(30, p.rotate.interval) * 1000) {
    p.rotate.idx = ((p.rotate.idx || 0) + 1) % p.rotate.items.length; p.rotate.last = now; save();
    return apply(client, true);
  }
  if (now - (tick.last || 0) >= 60e3) { tick.last = now; return apply(client); }     // refresh {variables} / auto status once a minute
}

// ---------------- setters (used by the owner panel and /presence) ----------------
function setStatus(client, status) { P().status = status; P().auto = false; save(); return apply(client, true); }
function setAuto(client, on) { P().auto = !!on; save(); return apply(client, true); }
function setType(client, type) { P().type = type; if (type === 'none') P().text = ''; save(); return apply(client, true); }
function setText(client, text, url) { const p = P(); p.text = String(text || '').slice(0, 128); if (url !== undefined) p.url = url; if (p.type === 'none' && p.text) p.type = 'playing'; save(); return apply(client, true); }
function setRotation(client, { on, interval, items }) {
  const r = P().rotate;
  if (on !== undefined) r.on = !!on;
  if (interval) r.interval = Math.min(3600, Math.max(30, Math.floor(interval)));
  if (items) { r.items = items; r.idx = 0; }
  r.last = 0; save(); return apply(client, true);
}
function applyPreset(client, key) {
  const pr = PRESETS[key]; if (!pr) return;
  const p = P(); p.status = pr.status; p.type = pr.type; p.text = pr.text; p.auto = false; p.rotate.on = false; save();
  return apply(client, true);
}
function reset(client) {
  db.presence = undefined; P(); save(); return apply(client, true);
}
// "watching: 3 tickets open" per line; first word is the type
function parseRotation(raw) {
  const items = [];
  for (const line of String(raw || '').split('\n').map(l => l.trim()).filter(Boolean)) {
    const m = /^(playing|watching|listening|competing|streaming|custom)\s*[:\-]\s*(.+)$/i.exec(line);
    items.push(m ? { type: m[1].toLowerCase(), text: m[2].slice(0, 128) } : { type: 'watching', text: line.slice(0, 128) });
  }
  return items.slice(0, 12);
}

// ---------------- profile (name, picture, banner, nickname, about me) ----------------
const okUrl = u => /^https:\/\/\S+$/i.test(String(u || '').trim());
async function setUsername(client, name) { await client.user.setUsername(String(name).trim().slice(0, 32)); }          // Discord allows ~2 changes per hour
async function setAvatar(client, url) { if (!okUrl(url)) throw new Error('Use a direct https image link (png, jpg, gif or webp).'); await client.user.setAvatar(url.trim()); }
async function setBanner(client, url) { if (!okUrl(url)) throw new Error('Use a direct https image link.'); await client.user.setBanner(url.trim()); }
async function setNickname(client, nick) { const g = await client.guilds.fetch(cfg.guildId); await g.members.me.setNickname(nick ? String(nick).slice(0, 32) : null); }
async function setAbout(client, text) { await client.application.edit({ description: String(text).slice(0, 400) }); }

// ---------------- display ----------------
function describe(client) {
  const p = P(); const item = currentItem();
  const shown = item.type && item.type !== 'none' && item.text ? `${TYPE_LABEL[item.type]} **${renderText(client, item.text)}**` : '*no activity*';
  const st = effectiveStatus();
  return [
    `**Status:** ${STATUS_LABEL[st]}${p.auto ? ' *(automatic, follows your services)*' : ''}`,
    `**Activity:** ${shown}${item.type === 'streaming' ? `\n**Stream link:** ${item.url || '(default twitch)'}` : ''}`,
    `**Rotation:** ${p.rotate.on ? `ON every ${p.rotate.interval}s · ${p.rotate.items.length} item(s)` : `off${p.rotate.items.length ? ` (${p.rotate.items.length} saved)` : ''}`}`,
    st === 'invisible' ? '-# Invisible: the bot looks offline but still works normally.' : '-# Variables: {members} {tickets} {queue} {orders} {robux} {open} {ping} {uptime} {servers}',
  ].join('\n');
}

// ---------------- /presence ----------------
add(sc('presence').setDescription('Owner: change how the bot looks (status + activity)')
  .addSubcommand(x => x.setName('set').setDescription('Set status and/or activity')
    .addStringOption(o => o.setName('status').setDescription('Online / idle / dnd / invisible').addChoices(
      { name: 'Online', value: 'online' }, { name: 'Idle (away)', value: 'idle' }, { name: 'Do Not Disturb', value: 'dnd' }, { name: 'Invisible', value: 'invisible' }))
    .addStringOption(o => o.setName('type').setDescription('Activity type').addChoices(
      { name: 'Playing', value: 'playing' }, { name: 'Watching', value: 'watching' }, { name: 'Listening to', value: 'listening' },
      { name: 'Competing in', value: 'competing' }, { name: 'Streaming', value: 'streaming' }, { name: 'Custom status', value: 'custom' }, { name: 'None', value: 'none' }))
    .addStringOption(o => o.setName('text').setDescription('Activity text (supports {members} {queue} {tickets} ...)').setMaxLength(128))
    .addStringOption(o => o.setName('url').setDescription('Stream link (twitch/youtube) for Streaming')))
  .addSubcommand(x => x.setName('reset').setDescription('Back to the default presence'))
  .addSubcommand(x => x.setName('show').setDescription('Show the current presence')),
async i => {
  const sub = i.options.getSubcommand();
  if (sub === 'reset') { await reset(i.client); return i.reply({ content: 'Presence reset.', flags: EPH }); }
  if (sub === 'set') {
    const st = i.options.getString('status'), ty = i.options.getString('type'), tx = i.options.getString('text'), url = i.options.getString('url');
    if (st) { P().status = st; P().auto = false; }
    if (ty) P().type = ty;
    if (tx !== null) { P().text = tx; if (P().type === 'none') P().type = 'playing'; }
    if (url) P().url = url;
    save(); await apply(i.client, true);
  }
  return i.reply(ui.eph(ui.note(`## ${tag(E.bell)} Bot presence\n${describe(i.client)}`)));
});

module.exports = {
  P, apply, tick, setStatus, setAuto, setType, setText, setRotation, applyPreset, reset, parseRotation, describe, renderText,
  setUsername, setAvatar, setBanner, setNickname, setAbout, PRESETS, TYPE_LABEL, STATUS_LABEL, effectiveStatus, uptime,
};
