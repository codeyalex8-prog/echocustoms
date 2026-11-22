// /setupserver  -> roles + channels (with matching permissions) + posts the dashboard and services panels
// /setup channels -> channels only (needs the roles first)
// /redoroles, /redochannels, /redoserver -> remove only what the setup commands created
const {
  PermissionFlagsBits: P, MessageFlags, ChannelType, OverwriteType, ButtonBuilder, ButtonStyle, ContainerBuilder,
} = require('discord.js');
const { db, save } = require('./db');
const ui = require('./ui');
const { add, sc } = require('./commands');
const R = require('./roles');

const EPH = MessageFlags.Ephemeral;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ================= channel template =================
// Role groups used for permissions. Executives are automatically added to every locked channel.
const EXEC = ['Owner', 'Executive', 'Co-Executive', 'Assistant Executive'];
const LEAD = ['Management', 'Manager'];
const MODS = ['Discord Moderators'];
const STAFF = ['Staff', 'Management', 'Manager', 'Discord Moderators', 'Quality Assurance'];
const ALL = 'everyone';
const LINE = '-'.repeat(19); // divider channel name

// viewers = who can see it, posters = who can type (or create posts in a forum) / connect (voice)
const text  = (name, o = {}) => ({ name, type: 'text',  viewers: ALL, posters: ALL, ...o });
const read  = (name, posters = STAFF, o = {}) => text(name, { posters, ...o });          // read-only for members
const voice = (name, o = {}) => ({ name, type: 'voice', viewers: ALL, posters: ALL, ...o });
const forum = (name, o = {}) => ({ name, type: 'forum', viewers: ALL, posters: LEAD, ...o });
const line  = (o = {}) => text(LINE, { posters: [], divider: true, ...o });
const team  = { viewers: STAFF, posters: STAFF };

const TEMPLATE = [
  { name: '👋 Verification', viewers: ALL, channels: [
    read('verification', LEAD),
    text('honeypot', { topic: 'Do not post in this channel.' }),
  ] },
  { name: '📍 Important', viewers: ALL, channels: [
    read('echo-customs', STAFF, { panel: 'dashboard' }),
    read('welcome', STAFF, { key: 'welcome' }),
    read('news'),
    read('server-updates', STAFF, { key: 'updates' }),
    read('supporters'),
    read('faq'),
  ] },
  { name: '🛒 Services', viewers: ALL, channels: [
    read('order', STAFF, { panel: 'services' }),
    read('reviews', STAFF, { key: 'reviews' }),
    read('package-news'),
    read('portfolio'),
  ] },
  { name: '📫 Packages', viewers: ALL, channels: [
    forum('discord-development'),
    forum('erlc-bot-development'),
    forum('bot-development'),
  ] },
  { name: '💬 Community', viewers: ALL, channels: [
    text('general'),
    text('commands'),
    read('suggestions', STAFF, { key: 'suggestions' }),
    line(),
    voice('lounge-1'),
    voice('lounge-2'),
    voice('echo-studio'),
  ] },
  { name: '🛡️ Staff', viewers: STAFF, channels: [
    read('staff-information', LEAD, { viewers: STAFF }),
    read('movements', LEAD, { viewers: STAFF }),
    line({ viewers: STAFF }),
    text('staff-chat', team),
    text('staff-commands', team),
    line({ viewers: STAFF }),
    voice('staff-lounge-1', team),
    voice('staff-lounge-2', team),
  ] },
  { name: '🔒 Underground', viewers: STAFF, channels: [
    read('purchases', [], { key: ['purchases', 'success'] }),                    // public thank-you wall (bot posts)
    read('moderations', [], { key: 'moderations', viewers: [...MODS, ...LEAD] }),
    read('transcripts', [], { key: 'transcripts', viewers: [...MODS, ...LEAD] }),
    text('sandbox', team),
    line({ viewers: STAFF }),
    text('package-submit', { key: 'packageSubmit', ...team }),
    text('package-upload', { viewers: LEAD, posters: LEAD }),
    read('sales-logs', [], { key: 'saleLogs', viewers: LEAD }),
    text('owner-only', { viewers: ['Owner'], posters: ['Owner'], strict: true }),
  ] },
  // empty categories the bot puts new tickets in
  { name: 'bot orders',                  viewers: STAFF, key: 'botOrderCat',     channels: [] },
  { name: 'discord development orders',  viewers: STAFF, key: 'discordOrderCat', channels: [] },
  { name: 'erlc dev orders',             viewers: STAFF, key: 'erlcOrderCat',    channels: [] },
  { name: 'tickets',                     viewers: STAFF, key: 'supportCat',      channels: [] },
];

// ================= permission overwrites =================
const V = P.ViewChannel, H = P.ReadMessageHistory;
const SEND = [P.SendMessages, P.SendMessagesInThreads];
const POST = [...SEND, P.CreatePublicThreads, P.CreatePrivateThreads];
const TALK = [P.Connect, P.Speak];

function buildOverwrites(g, me, spec, kind) {
  const roleId = n => db.setupRoles?.byName?.[n];
  const resolve = names => [...new Set(names.map(roleId).filter(Boolean))];
  const extra = spec.strict ? [] : EXEC;
  const map = new Map();
  const slot = id => { if (!map.has(id)) map.set(id, { allow: new Set(), deny: new Set(), type: OverwriteType.Role }); return map.get(id); };
  const allow = (id, bits) => bits.forEach(b => slot(id).allow.add(b));
  const deny = (id, bits) => bits.forEach(b => slot(id).deny.add(b));
  const everyone = g.id;

  // who can see it
  const seeBits = kind === 'voice' ? [V] : [V, H];
  if (spec.viewers === ALL) allow(everyone, seeBits);
  else { deny(everyone, [V]); for (const id of resolve([...spec.viewers, ...extra])) allow(id, seeBits); }

  // who can post / talk (categories have none)
  if (kind !== 'category') {
    const bits = kind === 'voice' ? TALK : kind === 'forum' ? SEND : POST;
    if (spec.posters === ALL) allow(everyone, bits);
    else { deny(everyone, bits); for (const id of resolve([...spec.posters, ...extra])) allow(id, bits); }
  }

  // the bot itself always keeps access (only with permissions it actually has)
  const botBits = [V, H, ...POST, P.EmbedLinks, P.AttachFiles, P.UseExternalEmojis, P.AddReactions, P.Connect, P.Speak]
    .filter(b => me.permissions.has(b));
  slot(me.id).type = OverwriteType.Member;
  allow(me.id, botBits);

  // a role that is both allowed and denied the same bit keeps the allow
  return [...map].map(([id, o]) => ({
    id, type: o.type, allow: [...o.allow], deny: [...o.deny].filter(b => !o.allow.has(b)),
  }));
}

const TYPE = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, forum: ChannelType.GuildForum };

// ================= build channels =================
async function ensureChannels(g, who) {
  const me = g.members.me;
  await g.channels.fetch();
  const state = db.setupChannels || { ids: {}, created: [] };
  const ids = { ...state.ids };
  const created = [...state.created];
  const made = [], skipped = [], failed = [];
  const fresh = {}; // panel -> channel, only for channels created this run
  const wire = (def, id) => { for (const k of [].concat(def.key || [])) ids[k] = id; };

  for (const cat of TEMPLATE) {
    let parent = g.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === cat.name);
    if (parent) { skipped.push(cat.name); }
    else {
      try {
        parent = await g.channels.create({
          name: cat.name, type: ChannelType.GuildCategory,
          permissionOverwrites: buildOverwrites(g, me, cat, 'category'), reason: `Setup by ${who}`,
        });
        created.push(parent.id); made.push(cat.name); await sleep(400);
      } catch (err) { console.error('category', cat.name, err.message); failed.push(cat.name); continue; }
    }
    wire(cat, parent.id);

    const seen = {}; // duplicate names (the divider lines) are matched in order
    for (const def of cat.channels) {
      const n = seen[def.name] = (seen[def.name] || 0) + 1;
      const existing = g.channels.cache.filter(c => c.parentId === parent.id && c.name === def.name).sort((a, b) => a.position - b.position).at(n - 1);
      if (existing) { skipped.push(def.name); wire(def, existing.id); continue; }
      const base = {
        name: def.name, parent: parent.id, topic: def.topic,
        permissionOverwrites: buildOverwrites(g, me, def, def.type), reason: `Setup by ${who}`,
      };
      try {
        let ch;
        try { ch = await g.channels.create({ ...base, type: TYPE[def.type] }); }
        catch (err) {
          if (def.type !== 'forum') throw err;           // forums need the Community feature; fall back to text
          ch = await g.channels.create({ ...base, type: ChannelType.GuildText });
        }
        created.push(ch.id); made.push(def.name); wire(def, ch.id);
        if (def.panel) fresh[def.panel] = ch;
        await sleep(400);
      } catch (err) { console.error('channel', def.name, err.message); failed.push(def.name); }
    }
  }

  db.setupChannels = { ids, created, by: who, at: Date.now() };
  save();

  // post the panels (services first so the dashboard can link to it)
  const posted = [];
  for (const k of ['services', 'dashboard']) {
    const ch = fresh[k];
    if (!ch?.send) continue;
    try {
      const m = await ch.send(ui.msg(k === 'services' ? ui.servicesPanel() : ui.dashboardPanel()));
      db.panels[k] = { channelId: ch.id, messageId: m.id }; posted.push(k);
    } catch (err) { console.error('panel', k, err.message); }
  }
  save();
  return { made, skipped, failed, posted };
}

async function removeChannels(g, who) {
  await g.channels.fetch();
  const ids = db.setupChannels?.created || [];
  const all = ids.map(id => g.channels.cache.get(id)).filter(Boolean);
  const gone = ids.length - all.length;
  const ordered = [...all.filter(c => c.type !== ChannelType.GuildCategory), ...all.filter(c => c.type === ChannelType.GuildCategory)];
  let removed = 0; const failed = []; const failedIds = [];
  for (const c of ordered) {
    try {
      await c.delete(`Redo by ${who}`); removed++;
      for (const k of ['dashboard', 'services']) if (db.panels[k]?.channelId === c.id) delete db.panels[k];
      await sleep(400);
    } catch (err) { console.error('channel delete', c.name, err.message); failed.push(c.name); failedIds.push(c.id); }
  }
  if (failedIds.length) db.setupChannels = { ...db.setupChannels, created: failedIds }; else delete db.setupChannels;
  save();
  return { removed, gone, failed };
}

// ================= commands =================
const noPerm = i => i.reply({ content: "You don't have permission to do that.", flags: EPH });
const needPerms = (i, ...bits) => !bits.every(b => i.guild.members.me.permissions.has(b));
const NEED = 'I need **Manage Roles** and **Manage Channels** (Administrator is easiest), and my role must be at the **top** of the role list. Fix that and run it again.';

function channelSummary(c) {
  const out = [
    '## ✅ Channels set up',
    `**Created:** ${c.made.length}${c.skipped.length ? ` · **Already existed:** ${c.skipped.length}` : ''}${c.failed.length ? ` · **Failed:** ${c.failed.length}` : ''}`,
    c.posted.length ? `Posted the **${c.posted.join('** and **')}** panel${c.posted.length > 1 ? 's' : ''} for you.` : '',
    'Log channels, ticket categories, welcome, reviews and suggestions are wired into the bot automatically (anything in `.env` still wins).',
  ];
  if (c.failed.length) out.push(`⚠️ Couldn't create: ${c.failed.join(', ')}`);
  return out.filter(Boolean).join('\n');
}

async function setupChannels(i) {
  if (!R.canManage(i)) return noPerm(i);
  if (!db.setupRoles) return i.reply(ui.eph(ui.note('Run `/setupserver` (roles + channels together) or `/setup roles` first, so the channel permissions have roles to use.')));
  if (needPerms(i, P.ManageChannels, P.ManageRoles)) return i.reply(ui.eph(ui.note(NEED)));
  await i.deferReply({ flags: EPH });
  const c = await ensureChannels(i.guild, i.user.tag);
  return i.editReply(ui.msg(ui.note(channelSummary(c))));
}

add(sc('setupserver').setDescription('Build the whole server: roles, channels and permissions together')
  .setDefaultMemberPermissions(P.ManageGuild),
async i => {
  if (!R.canManage(i)) return noPerm(i);
  if (needPerms(i, P.ManageChannels, P.ManageRoles)) return i.reply(ui.eph(ui.note(NEED)));
  await i.deferReply({ flags: EPH });
  const r = await R.ensureRoles(i.guild, i.user.tag);
  const c = await ensureChannels(i.guild, i.user.tag);
  const text = `${R.roleSummary(r)}\n\n${channelSummary(c)}\n\n-# Don't like it? \`/redoserver\` removes everything this made (or \`/redoroles\` / \`/redochannels\` for just one half).`;
  return i.editReply(ui.msg(ui.note(text)));
});

// ---------- redo commands (all ask for confirmation) ----------
const SCOPES = {
  roles:    { label: 'roles',    count: () => db.setupRoles?.created?.length || 0 },
  channels: { label: 'channels and categories', count: () => db.setupChannels?.created?.length || 0 },
  server:   { label: 'roles, channels and categories', count: () => (db.setupRoles?.created?.length || 0) + (db.setupChannels?.created?.length || 0) },
};
for (const [scope, name, desc] of [
  ['roles', 'redoroles', 'Remove every role that /setup roles or /setupserver created'],
  ['channels', 'redochannels', 'Remove every channel and category that /setup channels or /setupserver created'],
  ['server', 'redoserver', 'Remove everything /setupserver created (channels first, then roles)'],
]) {
  add(sc(name).setDescription(desc).setDefaultMemberPermissions(P.ManageGuild), async i => {
    if (!R.canManage(i)) return noPerm(i);
    const n = SCOPES[scope].count();
    if (!n) return i.reply(ui.eph(ui.note('There is nothing from the setup commands to remove.')));
    const c = new ContainerBuilder();
    c.addTextDisplayComponents(ui.text(
      `## ⚠️ Remove ${n} ${SCOPES[scope].label}?\nThis deletes **everything the setup commands created** (${SCOPES[scope].label}). Deleted channels lose their messages, and deleted roles come off everyone who has them. Anything that already existed, or that you made yourself, is **not** touched.`));
    c.addActionRowComponents(ui.row(
      new ButtonBuilder().setCustomId(`redo_yes:${scope}:${i.user.id}`).setLabel('Yes, remove them').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`redo_no:${scope}:${i.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)));
    return i.reply(ui.eph(c));
  });
}

async function onButton(i) {
  const [id, scope, owner] = i.customId.split(':');
  if (id !== 'redo_yes' && id !== 'redo_no') return false;
  if (i.user.id !== owner) { await i.reply({ content: 'Only the person who ran the command can answer this.', flags: EPH }); return true; }
  if (id === 'redo_no') { await i.update(ui.eph(ui.note('Cancelled. Nothing was removed.'))); return true; }
  if (!R.canManage(i)) { await noPerm(i); return true; }

  await i.update(ui.eph(ui.note('Removing... this can take a little while.')));
  const lines = [];
  if (scope === 'channels' || scope === 'server') {
    const c = await removeChannels(i.guild, i.user.tag);
    lines.push(`**Channels deleted:** ${c.removed}${c.gone ? ` · already gone: ${c.gone}` : ''}`);
    if (c.failed.length) lines.push(`⚠️ Couldn't delete: ${c.failed.join(', ')}`);
  }
  if (scope === 'roles' || scope === 'server') {
    const r = await R.removeRoles(i.guild, i.user.tag);
    lines.push(`**Roles deleted:** ${r.removed}${r.gone ? ` · already gone: ${r.gone}` : ''}`);
    if (r.failed.length) lines.push(`⚠️ Couldn't delete: ${r.failed.join(', ')} (move my bot role above them, then run it again)`);
  }
  lines.push('', 'Run `/setupserver` whenever you want a fresh set.');
  await i.editReply(ui.msg(ui.note(`## 🧹 Removed\n${lines.join('\n')}`)));
  return true;
}

module.exports = { setupChannels, onButton, TEMPLATE };
