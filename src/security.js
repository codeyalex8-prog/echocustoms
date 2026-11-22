// Security system (prison).
//  -setupsecurity (owner)       -> creates the "Prisoner" role and locks it out of every channel (also channels made later)
//  /channelpannelsetup (owner)  -> builds the prison category + appeal channel + panel (only Prisoner + prison staff can see it)
//  -jail / -unjail              -> manual prison. Roles are saved and ALWAYS given back on release.
//  antiraid.js                  -> the automatic raid detection; it calls imprison() / release() from this file.
const {
  PermissionFlagsBits: P, MessageFlags, ChannelType, ButtonBuilder, ButtonStyle, AttachmentBuilder,
} = require('discord.js');
const cfg = require('./config');
const { db, save } = require('./db');
const ui = require('./ui');
const ML = require('./modlog');
const T = require('./tickets');
const { E } = require('./emojis');
const { add, sc } = require('./commands');
const { targetError, proofRequired, isOwner, hasAny } = require('./perms');

const EPH = MessageFlags.Ephemeral;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROLE_NAME = 'Prisoner';
const ts = ms => Math.floor(ms / 1000);

// everything a prisoner must not be able to do in a channel
const DENY = {
  ViewChannel: false, SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false, CreatePrivateThreads: false,
  AddReactions: false, ReadMessageHistory: false, AttachFiles: false, EmbedLinks: false, UseApplicationCommands: false,
  Connect: false, Speak: false, Stream: false, RequestToSpeak: false,
};
db.security = db.security || {};
const S = () => (db.security = db.security || {});
const prisonerId = () => S().prisonerRoleId || '';
const getRole = g => g.roles.cache.get(prisonerId()) || null;
const validRoles = (g, ids) => ids.filter(id => g.roles.cache.has(id));

// ---------------- who is who ----------------
//  IMMUNE: only the OWNER_ID account(s), the server owner, this bot and the members the owner adds with /immune. Nothing in .env.
//  RELEASE: only the owner(s) can release a prisoner (button, /unjail, or by taking the role off by hand).
//  PRISON_STAFF_ROLE_IDS (optional, .env): these roles can SEE + get pinged in appeal tickets and close them. They cannot release.
const rolesOr = (key, ...fallbacks) => { const a = cfg.ids(key); if (a.length) return a; for (const f of fallbacks) if (f.length) return f; return []; };
const staffRoles = () => rolesOr('PRISON_STAFF_ROLE_IDS', cfg.ids('JAIL_ROLE_IDS'), cfg.roles.staff ? [cfg.roles.staff] : []);
const immuneIds = () => Object.keys(S().immune || {});

function isImmune(guild, userId, member) {
  if (userId === guild.client.user.id) return true;
  if (isOwner(userId) || guild.ownerId === userId) return true;
  return !!S().immune?.[userId];
}
const baseAllowed = (guild, userId) => isOwner(userId) || guild.ownerId === userId || userId === guild.client.user.id;
const mayGiveAdmin = (guild, userId, member) => isImmune(guild, userId, member);
const mayRemovePrisoner = (guild, userId) => baseAllowed(guild, userId);
function isPrisonStaff(member) {
  if (!member) return false;
  if (isOwner(member.id)) return true;
  const ids = staffRoles();
  return ids.length ? hasAny(member, ids) : member.permissions.has(P.ModerateMembers);
}

// ---------------- channel lock ----------------
function hasDeny(ch, roleId) {
  const o = ch.permissionOverwrites?.cache?.get(roleId);
  return !!o && o.deny.has(P.ViewChannel) && o.deny.has(P.SendMessages);
}
// the prison appeal space and tickets must stay visible to prisoners, so they are never locked
function isPrisonSpace(ch, roleId) {
  if (ch.topic?.startsWith('prison')) return true;
  if (ch.id === S().prisonChannelId || ch.id === S().prisonCategoryId || ch.parentId === S().prisonCategoryId && S().prisonCategoryId) return true;
  const o = ch.permissionOverwrites?.cache?.get(roleId);
  return !!o && o.allow.has(P.ViewChannel);   // someone deliberately opened it for the Prisoner role
}
async function lockChannel(ch, role) {
  if (!ch.permissionOverwrites || ch.isThread?.() || hasDeny(ch, role.id) || isPrisonSpace(ch, role.id)) return false;
  await ch.permissionOverwrites.edit(role, DENY, { reason: 'Security: Prisoner role locked out' });
  return true;
}
async function lockAll(guild, role) {
  const chans = await guild.channels.fetch();
  let locked = 0, skipped = 0, failed = 0;
  for (const ch of chans.values()) {
    if (!ch) continue;
    try { (await lockChannel(ch, role)) ? (locked++, await sleep(300)) : skipped++; } catch { failed++; }
  }
  return { locked, skipped, failed };
}

async function ensureRole(g, who) {
  await g.roles.fetch();
  let role = getRole(g) || g.roles.cache.find(r => r.name === ROLE_NAME);
  let created = false;
  if (!role) {
    role = await g.roles.create({ name: ROLE_NAME, color: 0x2b2b2b, permissions: [], hoist: false, mentionable: false, reason: `Security setup by ${who}` });
    created = true;
  }
  S().prisonerRoleId = role.id; save();
  return { role, created };
}

// ---------------- alerts ----------------
async function alertOwners(client, text) {
  if (cfg.logs.security && cfg.logs.security !== cfg.logs.staff) {
    const ch = await client.channels.fetch(cfg.logs.security).catch(() => null);
    await ch?.send({ components: [ui.note(`🚨 ${text}\n${cfg.ownerIds.map(o => `<@${o}>`).join(' ')}`)], flags: ui.V2, allowedMentions: { users: cfg.ownerIds } }).catch(() => {});
  }
  if (cfg.flag('RAID_DM_OWNERS', true)) {
    for (const id of cfg.ownerIds) {
      const u = await client.users.fetch(id).catch(() => null);
      await u?.send(ui.msg(ui.note(`🚨 **${cfg.brand} security**\n${text}`.slice(0, 3900)))).catch(() => {});
    }
  }
}

// ---------------- imprison / release (used by /jail, /unjail, the appeal ticket and the anti-raid system) ----------------
// opts: { by (userId|null), reason, details: [lines shown in the appeal ticket], source: 'manual'|'raid', drop: [roleIds NOT to give back], proof }
async function imprison(client, guild, member, opts) {
  const { by = null, reason, details = [], source = 'manual', drop = [], proof = {}, force = false } = opts;
  if (!force && isImmune(guild, member.id, member)) return { ok: false, why: 'immune' };
  const { role, created } = await ensureRole(guild, 'security');
  const me = guild.members.me;
  if (created || !S().locked) { S().locked = true; save(); lockAll(guild, role).then(() => applyPrisonSpace(guild, role)).catch(() => {}); }   // first use: lock every channel for the new role
  if (role.position >= me.roles.highest.position) return { ok: false, why: 'role-position' };

  const had = db.jailed[member.id];
  if (had) {                                   // already in prison: just add the new evidence
    had.details = [...(had.details || []), ...details].slice(-40); save();
    if (!member.roles.cache.has(role.id)) await member.roles.add(role, 'Still jailed').catch(() => {});
    return { ok: true, already: true };
  }
  const keep = member.roles.cache.filter(r => r.id !== guild.id && (r.managed || r.position >= me.roles.highest.position)); // can't be removed
  const saved = member.roles.cache.filter(r => r.id !== guild.id && !keep.has(r.id) && !drop.includes(r.id) && r.id !== role.id).map(r => r.id);
  db.jailed[member.id] = { roles: saved, by, reason, at: Date.now(), source, details: details.slice(-40), proofLink: proof.link || null }; save();

  let stripped = true;
  try { await member.roles.set([...keep.keys(), role.id], `Prison: ${reason}`.slice(0, 400)); }
  catch {
    stripped = false;
    try { await member.roles.add(role, `Prison: ${reason}`.slice(0, 400)); } catch { /* can't touch this member at all */ }
  }
  const has = (await guild.members.fetch(member.id).catch(() => null))?.roles.cache.has(role.id);
  if (!has) {                                  // could not jail them (they outrank the bot)
    delete db.jailed[member.id]; save();
    const fb = cfg.words('RAID_UNJAILABLE_ACTION')[0]?.toLowerCase() || 'none';
    let did = 'No fallback action is set (RAID_UNJAILABLE_ACTION).';
    if (source === 'raid' && fb === 'kick') did = (await member.kick('Anti-raid: could not be jailed').then(() => 'They were **kicked** instead.').catch(() => 'Kick failed too.'));
    if (source === 'raid' && fb === 'ban') did = (await guild.members.ban(member.id, { reason: 'Anti-raid: could not be jailed' }).then(() => 'They were **banned** instead.').catch(() => 'Ban failed too.'));
    await alertOwners(client, `I could **not** imprison <@${member.id}> (their top role is above mine). Move my bot role to the very top.\n${did}\n**Why I tried:** ${reason}`);
    return { ok: false, why: 'hierarchy' };
  }
  await member.voice?.disconnect('Jailed').catch(() => {});
  const panel = S().prisonChannelId;
  await member.send(ui.msg(ui.note(
    `🚔 You were **jailed** in **${cfg.brand}**.\n**Reason:** ${reason}` +
    (panel ? `\n\nYou can appeal in <#${panel}> by pressing **Open Appeal Ticket**.` : ''))))
    .catch(() => {});
  const k = await ML.record(client, {
    action: 'jail', modId: by, user: member.user, reason, proof,
    extra: { text: `**Source:** ${source === 'raid' ? '🛡️ Anti-raid (automatic)' : 'Staff'}${stripped ? '' : '\n⚠️ Could not strip all roles'}${details.length ? `\n**Evidence:**\n${details.slice(0, 12).join('\n')}` : ''}` },
  });
  return { ok: true, kase: k };
}

async function release(client, guild, member, { by = null, reason = 'No reason given' } = {}) {
  const rec = db.jailed[member.id];
  const role = getRole(guild);
  const me = guild.members.me;
  const back = (rec?.roles || []).filter(id => { const r = guild.roles.cache.get(id); return r && !r.managed && r.position < me.roles.highest.position; });
  const now = member.roles.cache.filter(r => r.id !== guild.id && r.id !== role?.id).map(r => r.id);
  await member.roles.set([...new Set([...now, ...back])], `Released${by ? ` by ${by}` : ''}`);   // roles come back automatically
  delete db.jailed[member.id]; save();
  await closeTicket(client, guild, member.id, { by, reason: `Released: ${reason}`, announce: true });
  await member.send(ui.msg(ui.note(`🕊️ You were **released** in **${cfg.brand}**. Your roles have been given back.`))).catch(() => {});
  return ML.record(client, { action: 'unjail', modId: by, user: member.user, reason, extra: { text: `**Roles given back:** ${back.length}` } });
}

// ---------------- appeal tickets ----------------
function evidenceText(userId, rec) {
  const lines = (rec?.details || []);
  const body = lines.length ? lines.join('\n') : '• No detailed log was saved for this jailing.';
  return (
    `**Imprisoned:** <t:${ts(rec?.at || Date.now())}:F> (<t:${ts(rec?.at || Date.now())}:R>)\n` +
    `**By:** ${rec?.source === 'raid' ? '🛡️ Anti-raid system (automatic)' : rec?.by ? `<@${rec.by}>` : 'Unknown'}\n` +
    `**Reason:** ${rec?.reason || 'Not recorded'}\n` +
    (rec?.proofLink ? `**Proof:** ${rec.proofLink}\n` : '') +
    `\n### 🧾 Exactly what happened\n${body}`
  ).slice(0, 3400);
}

function ticketPanel(userId, rec, pings) {
  const c = ui.base();
  c.addTextDisplayComponents(ui.text(
    `${pings.length ? pings.map(r => `<@&${r}>`).join(' ') + '\n' : ''}` +
    `## ${'⛓️'} Appeal ticket · <@${userId}>\n> You were placed in prison by **${cfg.brand}** security. Explain your side here. The owner will read what happened below and decide if you get released.\n\n${evidenceText(userId, rec)}`));
  c.addSeparatorComponents(ui.sep());
  c.addActionRowComponents(ui.row(
    new ButtonBuilder().setCustomId(`prison_release:${userId}`).setLabel('Release prisoner (owner)').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('prison_close').setLabel('Close ticket').setStyle(ButtonStyle.Danger)));
  return ui.foot(c);
}

async function openTicket(i) {
  const g = i.guild;
  const role = getRole(g);
  const rec = db.jailed[i.user.id];
  if (!rec && !(role && i.member.roles.cache.has(role.id))) return i.reply({ content: 'You are not in prison, so you have nothing to appeal.', flags: EPH });
  const old = S().tickets?.[i.user.id];
  const oldCh = old && (g.channels.cache.get(old.channelId) || await g.channels.fetch(old.channelId).catch(() => null));
  if (oldCh) return i.reply({ content: `You already have an appeal open: ${oldCh}`, flags: EPH });
  await i.deferReply({ flags: EPH });

  const me = g.members.me;
  const staff = validRoles(g, staffRoles());
  const base = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
  const overwrites = [
    { id: g.id, deny: [P.ViewChannel] },
    { id: i.user.id, allow: base },
    { id: me.id, allow: [...base, P.ManageChannels, P.ManageMessages] },
    ...staff.map(id => ({ id, allow: [...base, P.ManageMessages] })),
  ];
  const catId = S().prisonCategoryId;
  const name = `appeal-${i.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || i.user.id}`;
  const ch = await g.channels.create({
    name, type: ChannelType.GuildText, parent: catId && g.channels.cache.has(catId) ? catId : undefined,
    topic: `prison:${i.user.id}`, permissionOverwrites: overwrites, reason: `Appeal ticket for ${i.user.tag}`,
  });
  S().tickets = S().tickets || {};
  S().tickets[i.user.id] = { channelId: ch.id, at: Date.now() }; save();
  await ch.send({ components: [ticketPanel(i.user.id, rec, staff)], flags: ui.V2, allowedMentions: { roles: staff, users: [i.user.id] } });
  await i.editReply(`Your appeal ticket is open: ${ch}`);
  ML.line(i.client, `📨 Appeal ticket opened by <@${i.user.id}>: ${ch}`).catch(() => {});
}

async function closeTicket(client, guild, userId, { by = null, reason = 'Closed', announce = false } = {}) {
  const t = S().tickets?.[userId];
  if (!t) return;
  const ch = guild.channels.cache.get(t.channelId) || await guild.channels.fetch(t.channelId).catch(() => null);
  delete S().tickets[userId]; save();
  if (!ch) return;
  try {   // keep a transcript in the security logs: same embed + summary as normal tickets
    let text = await T.buildTranscript(ch, { type: 'prison', service: null, ownerId: userId }, reason, by || 'system');
    let sumMd = '';
    try { const S = await require('./aitools').summarize(ch, { type: 'prison', ownerId: userId }, null, reason, text, 'prison'); text += `\n\n${'='.repeat(50)}\n${S.text}\n`; sumMd = S.md; } catch (e) { console.error('appeal summary', e); }
    const fname = `appeal-${ch.name}.txt`;
    const logId = cfg.logs.security;
    const lc = logId && await client.channels.fetch(logId).catch(() => null);
    await lc?.send({
      components: [ui.transcriptLog({ ticketName: ch.name, type: 'Prison appeal', ownerId: userId, closedBy: by || client.user.id, reason, fname, success: null, summary: sumMd })],
      files: [new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: fname })], flags: ui.V2, allowedMentions: ui.NO_PING,
    });
  } catch (e) { console.error('appeal transcript', e.message); }
  if (announce) await ch.send(ui.msg(ui.note(`🕊️ ${reason}. This ticket will be deleted in 8 seconds.`))).catch(() => {});
  setTimeout(() => ch.delete('Appeal closed').catch(() => {}), announce ? 8000 : 4000);
}

async function onButton(i) {
  const [id, arg] = i.customId.split(':');
  if (id === 'prison_open') { await openTicket(i); return true; }
  if (id === 'prison_close') {
    if (!isPrisonStaff(i.member)) { await i.reply({ content: 'Only prison staff can close appeal tickets.', flags: EPH }); return true; }
    const uid = (i.channel.topic || '').split(':')[1];
    await i.reply({ content: 'Closing the appeal...', flags: EPH });
    await closeTicket(i.client, i.guild, uid, { by: i.user.id, reason: `Closed by ${i.user.tag}`, announce: true });
    return true;
  }
  if (id === 'prison_release') {
    if (!isOwner(i.user.id)) { await i.reply({ content: 'Only the **owner** can release prisoners.', flags: EPH }); return true; }
    await i.deferReply({ flags: EPH });
    const m = await i.guild.members.fetch(arg).catch(() => null);
    if (!m || !db.jailed[arg]) { await i.editReply('That member is not jailed (anymore).'); return true; }
    const k = await release(i.client, i.guild, m, { by: i.user.id, reason: `Released from the appeal ticket by ${i.user.tag}` });
    await i.editReply(`Released **${m.user.tag}**. Case **#${k.id}**.`);
    return true;
  }
  return false;
}

// ---------------- /setupsecurity ----------------
add(sc('setupsecurity').setDescription('Owner: create the Prisoner role and lock it out of every channel'),
async i => {
  const me = i.guild.members.me;
  if (!me.permissions.has(P.ManageRoles) || !me.permissions.has(P.ManageChannels))
    return i.reply(ui.eph(ui.note('I need **Manage Roles** and **Manage Channels** (or Administrator) to do this. Fix my permissions and run it again.')));
  await i.deferReply({ flags: EPH });
  const { role, created } = await ensureRole(i.guild, i.user.tag);
  const { locked, skipped, failed } = await lockAll(i.guild, role);
  S().locked = true; save();
  const above = role.position >= me.roles.highest.position;
  await i.editReply(ui.msg(ui.note(
    `## 🔒 Security set up\n**Role:** <@&${role.id}> ${created ? '(created)' : '(already existed)'}\n` +
    `**Channels locked:** ${locked} · **already locked:** ${skipped}${failed ? ` · **failed:** ${failed}` : ''}\n\n` +
    `A prisoner can't view or message in any channel. Channels and categories created later are locked automatically.\n` +
    (above ? '⚠️ Move **my bot role above Prisoner** so I can assign it.\n' : '') +
    (failed ? '⚠️ Some channels failed: check I have permission in them (my role must be high enough).\n' : '') +
    `-# Next: \`${cfg.prefix}channelpannelsetup\` builds the prison appeal channel. Use \`${cfg.prefix}jail @user reason\` and \`${cfg.prefix}unjail @user\`.`)));
  await ML.line(i.client, `🔒 <@${i.user.id}> ran security setup (${locked} channels locked).`);
});

// ---------------- /channelpannelsetup ----------------
function spaceOverwrites(g, role, forPanel) {
  const me = g.members.me;
  const staff = validRoles(g, staffRoles());
  const view = [P.ViewChannel, P.ReadMessageHistory];
  return [
    { id: g.id, deny: [P.ViewChannel] },
    forPanel
      ? { id: role.id, allow: view, deny: [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads] }
      : { id: role.id, allow: view, deny: [P.SendMessages] },
    { id: me.id, allow: [...view, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ManageChannels, P.ManageMessages, P.ManageRoles] },
    ...staff.map(id => ({ id, allow: [...view, P.SendMessages, P.ManageMessages] })),
  ];
}
function prisonPanel() {
  const c = ui.base();
  c.addTextDisplayComponents(ui.text(
    `## ⛓️ You are in prison\n> **${cfg.brand}** security has placed you in prison, so you can't see any other channel. If you think this is a mistake, or you want to explain what happened, open an **appeal ticket** with the button below.\n> The owner will see exactly what you did and decides if you are released. Don't spam the button, one ticket is enough.`));
  c.addSeparatorComponents(ui.sep());
  c.addActionRowComponents(ui.row(new ButtonBuilder().setCustomId('prison_open').setLabel('Open Appeal Ticket').setEmoji(E.punishment).setStyle(ButtonStyle.Secondary)));
  return ui.foot(c);
}
async function applyPrisonSpace(g, role) {   // (re)builds the permissions of the appeal category + channel
  const cat = S().prisonCategoryId && g.channels.cache.get(S().prisonCategoryId);
  const ch = S().prisonChannelId && g.channels.cache.get(S().prisonChannelId);
  if (cat) await cat.permissionOverwrites.set(spaceOverwrites(g, role, false), 'Prison space refreshed').catch(() => {});
  if (ch) await ch.permissionOverwrites.set(spaceOverwrites(g, role, true), 'Prison space refreshed').catch(() => {});
}

const setupPanel = async i => {
  const g = i.guild;
  const me = g.members.me;
  if (!me.permissions.has(P.ManageRoles) || !me.permissions.has(P.ManageChannels))
    return i.reply(ui.eph(ui.note('I need **Manage Roles** and **Manage Channels** (or Administrator) first.')));
  await i.deferReply({ flags: EPH });
  const { role } = await ensureRole(g, i.user.tag);

  let cat = S().prisonCategoryId && (g.channels.cache.get(S().prisonCategoryId) || await g.channels.fetch(S().prisonCategoryId).catch(() => null));
  if (!cat) {
    cat = await g.channels.create({ name: '⛓️ Prison', type: ChannelType.GuildCategory, permissionOverwrites: spaceOverwrites(g, role, false), reason: 'Prison setup' });
    S().prisonCategoryId = cat.id; save();
  }
  let ch = i.options.getChannel('channel');
  if (!ch) {
    ch = S().prisonChannelId && (g.channels.cache.get(S().prisonChannelId) || await g.channels.fetch(S().prisonChannelId).catch(() => null));
    if (!ch) ch = await g.channels.create({ name: 'prison-appeal', type: ChannelType.GuildText, parent: cat.id, topic: 'prison-panel: only prisoners and prison staff can see this', permissionOverwrites: spaceOverwrites(g, role, true), reason: 'Prison setup' });
  }
  S().prisonChannelId = ch.id; save();
  await ch.permissionOverwrites.set(spaceOverwrites(g, role, true), 'Prison setup').catch(() => {});
  if (ch.parentId !== cat.id) await ch.setParent(cat.id, { lockPermissions: false }).catch(() => {});
  // replace the old panel if there is one
  if (S().panelMessageId) await ch.messages.delete(S().panelMessageId).catch(() => {});
  const m = await ch.send(ui.msg(prisonPanel()));
  S().panelMessageId = m.id; save();

  const staff = validRoles(g, staffRoles());
  await i.editReply(ui.msg(ui.note(
    `## ⛓️ Prison panel ready\n**Channel:** ${ch}\n**Category:** ${cat}\n` +
    `**Who sees it:** the <@&${role.id}> role (read only) and ${staff.length ? staff.map(r => `<@&${r}>`).join(' ') : '**nobody yet**'}.\n` +
    (staff.length ? '' : '⚠️ Set `PRISON_STAFF_ROLE_IDS` in `.env` so staff can see and get pinged in appeal tickets, then run this again.\n') +
    `Appeal tickets open under the prison category and ping those roles.`)));
};
add(sc('channelpannelsetup').setDescription('Owner: build the prison appeal channel + panel (only prisoners and prison staff can see it)')
  .addChannelOption(o => o.setName('channel').setDescription('Use this text channel for the panel (default: create #prison-appeal)').addChannelTypes(ChannelType.GuildText)), setupPanel);
add(sc('channelpanelsetup').setDescription('Same as /channelpannelsetup')
  .addChannelOption(o => o.setName('channel').setDescription('Use this text channel for the panel').addChannelTypes(ChannelType.GuildText)), setupPanel);

// new / reset channels get locked too
async function onChannel(ch) {
  const role = ch.guild && getRole(ch.guild);
  if (!role || ch.isThread?.()) return;
  await lockChannel(ch, role).catch(() => {});
}

// ---------------- jail / unjail ----------------
add(sc('jail').setDescription('Put a member in the Prisoner role (they lose access to every channel)')
  .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(300))
  .addAttachmentOption(o => o.setName('proof').setDescription('Proof (optional)'))
  .addStringOption(o => o.setName('proof_link').setDescription('Proof link (optional)').setMaxLength(500)),
async i => {
  let role = getRole(i.guild);
  if (!role) { const r = await ensureRole(i.guild, 'auto-setup').catch(() => null); role = r?.role; S().locked = true; save(); if (role) lockAll(i.guild, role).catch(() => {}); }
  if (!role) return i.reply({ content: `I couldn't create the Prisoner role. Give me **Manage Roles** (or Administrator), or run \`${cfg.prefix}setupsecurity\`.`, flags: EPH });
  const m = await i.guild.members.fetch(i.options.getUser('user').id).catch(() => null);
  if (!m) return i.reply({ content: 'Member not found.', flags: EPH });
  const err = targetError(i, m); if (err) return i.reply({ content: err, flags: EPH });
  if (isImmune(i.guild, m.id, m)) return i.reply({ content: 'That member is **immune** to prison.', flags: EPH });
  if (m.roles.cache.has(role.id)) return i.reply({ content: 'They are already jailed.', flags: EPH });
  const att = i.options.getAttachment('proof') || null; const link = (i.options.getString('proof_link') || '').trim() || null;
  if (link && !/^https?:\/\/\S+$/i.test(link)) return i.reply({ content: 'The proof link must be a valid `https://` link.', flags: EPH });
  if (proofRequired('jail') && !isOwner(i.user.id) && !att && !link) return i.reply({ content: '🧾 Proof is required to jail.', flags: EPH });
  if (role.position >= i.guild.members.me.roles.highest.position) return i.reply({ content: 'Move my bot role above **Prisoner** first.', flags: EPH });

  await i.deferReply({ flags: EPH });
  const reason = i.options.getString('reason');
  const res = await imprison(i.client, i.guild, m, {
    by: i.user.id, reason, source: 'manual', proof: { att, link },
    details: [`• <t:${ts(Date.now())}:T> Jailed by <@${i.user.id}> with the jail command.`, `• Reason given: ${reason}`],
  });
  if (!res.ok) return i.editReply(`I couldn't jail them (${res.why}). Check my role is above theirs.`);
  await i.editReply(`Jailed **${m.user.tag}**. Case **#${res.kase.id}**.`);
});

add(sc('unjail').setDescription('Release a member from the Prisoner role and give their roles back')
  .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setMaxLength(300)),
async i => {
  const role = getRole(i.guild);
  const m = await i.guild.members.fetch(i.options.getUser('user').id).catch(() => null);
  if (!m) return i.reply({ content: 'Member not found.', flags: EPH });
  if (!db.jailed[m.id] && !(role && m.roles.cache.has(role.id))) return i.reply({ content: 'That member is not jailed.', flags: EPH });
  await i.deferReply({ flags: EPH });
  const k = await release(i.client, i.guild, m, { by: i.user.id, reason: i.options.getString('reason') || 'No reason given' });
  await i.editReply(`Released **${m.user.tag}** and gave their roles back. Case **#${k.id}**.`);
});

// leaving and rejoining does not free a prisoner
async function onJoin(member) {
  if (!db.jailed[member.id]) return;
  const role = getRole(member.guild);
  if (role) await member.roles.add(role, 'Still jailed').catch(() => {});
}

// ---------------- self-healing (runs every few minutes) ----------------
async function rebuildRole(client, guild, why) {      // the Prisoner role was deleted: make a new one and put everyone back
  S().prisonerRoleId = '';
  const { role } = await ensureRole(guild, 'self-heal');
  await lockAll(guild, role);
  await applyPrisonSpace(guild, role);
  for (const id of Object.keys(db.jailed)) {
    const m = await guild.members.fetch(id).catch(() => null);
    await m?.roles.add(role, 'Prisoner role rebuilt').catch(() => {});
  }
  await alertOwners(client, `The **Prisoner** role was rebuilt (${why}). All jailed members were put back in it.`);
  return role;
}
async function tick(client) {
  const g = client.guilds.cache.get(cfg.guildId);
  if (!g || !prisonerId()) return;
  await g.roles.fetch().catch(() => {});
  let role = getRole(g);
  if (!role) role = await rebuildRole(client, g, 'it was missing');
  if (role.permissions.bitfield !== 0n) await role.setPermissions([], 'Prisoner role must have no permissions').catch(() => {});
  for (const id of Object.keys(db.jailed)) {
    const m = g.members.cache.get(id) || await g.members.fetch(id).catch(() => null);
    if (m && !m.roles.cache.has(role.id)) await m.roles.add(role, 'Still jailed (self-heal)').catch(() => {});
  }
  for (const ch of g.channels.cache.values()) await onChannel(ch);
}


// ---------------- /immune (OWNER ONLY) ----------------
const imm = () => (S().immune = S().immune || {});
add(sc('immune').setDescription('Owner only: make a member immune to prison + anti-raid (run again on them to remove it)')
  .setDefaultMemberPermissions(P.Administrator)
  .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)),
async i => {
  if (!isOwner(i.user.id)) return i.reply({ content: '**Owner only.**', flags: EPH });
  const u = i.options.getUser('user');
  if (u.bot) return i.reply({ content: 'Bots are never jailed by me, nothing to set.', flags: EPH });
  if (isOwner(u.id)) return i.reply({ content: 'Owners are always immune.', flags: EPH });
  let now;
  if (imm()[u.id]) { delete imm()[u.id]; now = false; } else { imm()[u.id] = { by: i.user.id, at: Date.now() }; now = true; }
  save();
  await ML.line(i.client, `🛡️ <@${i.user.id}> ${now ? 'made' : 'removed'} <@${u.id}> ${now ? 'immune to' : 'from'} prison / anti-raid.`).catch(() => {});
  return i.reply({ content: now ? `🛡️ <@${u.id}> is now **immune**: they can't be jailed and anti-raid ignores them.` : `<@${u.id}> is **no longer immune**.`, flags: EPH, allowedMentions: { parse: [] } });
});
add(sc('immunelist').setDescription('Owner only: who is immune').setDefaultMemberPermissions(P.Administrator), async i => {
  if (!isOwner(i.user.id)) return i.reply({ content: '**Owner only.**', flags: EPH });
  const l = immuneIds();
  return i.reply({ content: `**Always immune:** the owner(s) ${cfg.ownerIds.map(o => `<@${o}>`).join(' ')}, the server owner and this bot.\n**Immune by /immune (${l.length}):** ${l.length ? l.map(x => `<@${x}>`).join(' ') : 'nobody'}`, flags: EPH, allowedMentions: { parse: [] } });
});

// ---------------- /securitycheck (OWNER ONLY): find out why something is not working ----------------
function checkText(client, guild) {
  const L = []; const ok = (c, good, bad) => L.push(c ? `✅ ${good}` : `❌ ${bad}`);
  const me = guild.members.me; const role = getRole(guild);
  ok(cfg.ownerIds.length > 0, `Owner(s): ${cfg.ownerIds.map(o => `<@${o}>`).join(' ')}`, '`OWNER_ID` is empty or not a number in `.env`');
  for (const [n, f] of [['Manage Roles', P.ManageRoles], ['Manage Channels', P.ManageChannels], ['View Audit Log (anti-raid needs it)', P.ViewAuditLog], ['Ban Members', P.BanMembers], ['Kick Members', P.KickMembers], ['Moderate Members', P.ModerateMembers]])
    ok(me.permissions.has(f), `Bot has **${n}**`, `Bot is missing **${n}** (easiest fix: give the bot role Administrator)`);
  ok(!!role, `Prisoner role exists: <@&${role?.id}>`, 'No Prisoner role yet: run `/setupsecurity` (or just jail someone, it is created automatically)');
  if (role) {
    ok(role.position < me.roles.highest.position, 'Bot role is **above** Prisoner', 'Bot role is **below** Prisoner: drag my role above it in Server Settings > Roles');
    ok(role.permissions.bitfield === 0n, 'Prisoner role has no permissions', 'Prisoner role has permissions (the bot clears them within 5 minutes)');
    ok(!!S().locked, 'Channels locked for Prisoner', 'Channels not locked yet: run `/setupsecurity`');
  }
  const pc = S().prisonChannelId && guild.channels.cache.get(S().prisonChannelId);
  ok(!!pc, `Appeal channel: ${pc}`, 'No appeal channel: run `/channelpannelsetup`');
  const lg = cfg.logs.security && guild.channels.cache.get(cfg.logs.security);
  ok(!!lg, `Security logs: ${lg}`, 'No security/staff logs channel found: set `SECURITY_LOGS_CHANNEL_ID` or `STAFF_LOGS_CHANNEL_ID`');
  if (lg) ok(lg.permissionsFor(me)?.has(P.SendMessages), 'Bot can write in the logs channel', 'Bot cannot write in the logs channel');
  const st = validRoles(guild, staffRoles());
  ok(st.length > 0, `Appeal ticket staff roles: ${st.map(r => `<@&${r}>`).join(' ')} (they see + close appeals, only you release)`, '`PRISON_STAFF_ROLE_IDS` / `JAIL_ROLE_IDS` / staff role not found: only you will see appeal tickets');
  ok(cfg.flag('RAID_ENABLED', true), `Anti-raid is ON (level **${db.security?.level || 'medium'}**)`, 'Anti-raid is OFF (owner panel > Security)');
  L.push(`ℹ️ Jailed now: **${Object.keys(db.jailed).length}** · Immune (via /immune): **${immuneIds().length}**`);
  return L.join('\n');
}
add(sc('securitycheck').setDescription('Owner only: check that prison, anti-raid and permissions are set up right').setDefaultMemberPermissions(P.Administrator), async i => {
  if (!isOwner(i.user.id)) return i.reply({ content: '**Owner only.**', flags: EPH });
  return i.reply(ui.eph(ui.note(`## 🔎 Security check\n${checkText(i.client, i.guild)}`)));
});

module.exports = {
  onChannel, onJoin, onButton, tick,
  imprison, release, ensureRole, getRole, prisonerId, rebuildRole, alertOwners,
  isImmune, mayGiveAdmin, mayRemovePrisoner, isPrisonStaff, immuneIds, checkText, lockAll, applyPrisonSpace,
};
