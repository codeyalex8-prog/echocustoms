// Role set for Echo Customs. Used by /setup roles and /setupserver (see server.js).
const { PermissionFlagsBits: P, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { db, save } = require('./db');
const ui = require('./ui');

const EPH = MessageFlags.Ephemeral;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- permission sets (nobody gets Administrator) ----------
// Team roles (Management / Discord Moderators / Quality Assurance) carry the permissions for that team.
// Senior / Junior / Trial are shared rank roles you stack on top of a team role; they only show seniority.
const NONE = [];
const CHAT = [P.AttachFiles, P.EmbedLinks, P.UseExternalEmojis];
const MOD = [P.ModerateMembers, P.ManageMessages, P.ManageThreads, P.ManageNicknames, P.KickMembers];
const MGMT = [...MOD, P.BanMembers, P.ViewAuditLog];
const MANAGER = [...MGMT, P.MentionEveryone, P.CreateInstantInvite];
const EXEC_LITE = [...MANAGER, P.ManageGuild, P.ManageChannels];
const EXEC = [...EXEC_LITE, P.ManageRoles, P.ManageWebhooks, P.ManageGuildExpressions];

const GOLD = [0xffd24a, 0xf2c744, 0xe6b93c, 0xd9ab33];
const RED = 0xe0524f, BLUE = 0x4a90e2, PURPLE = 0x9b6bdf, GREY = 0x9aa0a6;
const div = name => ({ name: `──── ${name} ────`, color: 0x2b2b2b, sep: true }); // spacer / divider role
const ping = (name, key) => ({ name, color: 0, mentionable: true, perms: NONE, key });

// Listed top -> bottom, which is exactly the order they get in the role list.
// `key` wires a role into the bot (see config.js).
const ROLES = [
  div('Executive'),
  { name: 'Owner',               color: GOLD[0], hoist: true, perms: EXEC },       // give it to both owners
  { name: 'Executive',           color: GOLD[1], hoist: true, perms: EXEC },
  { name: 'Co-Executive',        color: GOLD[2], hoist: true, perms: EXEC },
  { name: 'Assistant Executive', color: GOLD[3], hoist: true, perms: EXEC_LITE },

  div('Staff Team'),
  { name: 'Staff', color: GREY, perms: NONE, key: 'staff' },                          // base role for everyone on staff

  div('Management'),
  { name: 'Management', color: RED, hoist: true, perms: MGMT },
  { name: 'Manager',    color: RED, perms: MANAGER },

  div('Moderation'),
  { name: 'Discord Moderators', color: BLUE, hoist: true, perms: MOD },

  div('Quality Assurance'),
  { name: 'Quality Assurance', color: PURPLE, hoist: true, perms: [P.ManageMessages] },

  div('Ranks'),                                                                      // stack on top of a team role
  { name: 'Senior', color: 0xe8a07a, perms: NONE },
  { name: 'Junior', color: 0x7fd1ae, perms: NONE },
  { name: 'Trial',  color: 0xb5b9be, perms: NONE },

  div('Members'),
  { name: 'VIP',     color: 0xff73c8, hoist: true, perms: [...CHAT, P.ChangeNickname, P.CreateInstantInvite], key: 'vip' },
  { name: 'Client',  color: 0x43b581, hoist: true, perms: [...CHAT, P.ChangeNickname], key: 'client' },
  { name: 'Partner', color: 0xf0b232, hoist: true, perms: [...CHAT, P.CreateInstantInvite] },
  { name: 'Friend',  color: 0x5ac8fa, hoist: true, perms: CHAT },
  { name: 'Member',  color: 0x8e9297, perms: NONE, key: 'member' },

  div('Pings'),
  ping('Free Release Ping'),
  ping('Announcement Ping'),
  ping('Update Ping'),
  ping('Order Status Ping'),
  ping('Giveaway Ping'),
  ping('Package Ping'),

  div('Staff Pings'),                                                              // used by the bot to alert staff in tickets
  ping('Support Ping', 'supportPing'),
  ping('Order Ping', 'orderPing'),
  ping('Bot Order Ping', 'botOrderPing'),
  ping('Discord Order Ping', 'discordOrderPing'),
  ping('ERLC Order Ping', 'erlcOrderPing'),
];

const canManage = i => i.memberPermissions?.has(P.ManageGuild) || cfg.ownerIds.includes(i.user.id);

// ---------- create (or reuse) every role, in order ----------
async function ensureRoles(g, who) {
  const me = g.members.me;
  await g.roles.fetch();
  const state = db.setupRoles || { ids: {}, byName: {}, created: [] };
  const ids = { ...state.ids };
  const byName = { ...(state.byName || {}) };
  const created = [...state.created];
  const made = [], skipped = [], failed = [];

  for (const def of ROLES) {
    const prior = created.map(id => g.roles.cache.get(id)).find(r => r && r.name === def.name);
    if (prior) { skipped.push(def.name); byName[def.name] = prior.id; if (def.key) ids[def.key] = prior.id; continue; }
    // a role with this name already exists (not ours): reuse it, but never delete it later
    const existing = g.roles.cache.find(r => r.name === def.name && !r.managed);
    if (existing) { skipped.push(def.name); byName[def.name] = existing.id; if (def.key && !ids[def.key]) ids[def.key] = existing.id; continue; }
    try {
      const r = await g.roles.create({
        name: def.name, color: def.color || 0, hoist: !!def.hoist, mentionable: !!def.mentionable,
        permissions: def.perms || [], reason: `Setup by ${who}`,
      });
      created.push(r.id); made.push(def.name); byName[def.name] = r.id;
      if (def.key) ids[def.key] = r.id;
      await sleep(350); // stay well inside the role-create rate limit
    } catch (err) { console.error('role create', def.name, err.message); failed.push(def.name); }
  }

  // order them (top of ROLES = highest); can't place anything at/above my own role
  let ordered = true;
  try {
    const top = me.roles.highest.position - 1;
    const mine = ROLES.map(d => g.roles.cache.find(r => created.includes(r.id) && r.name === d.name)).filter(Boolean);
    if (top < mine.length) ordered = false;
    if (mine.length) await g.roles.setPositions(mine.map((role, n) => ({ role, position: Math.max(top - n, 1) })));
  } catch (err) { console.error('role order', err.message); ordered = false; }

  db.setupRoles = { ids, byName, created, by: who, at: Date.now() };
  save();
  return { made, skipped, failed, ordered, ids };
}

async function removeRoles(g, who) {
  await g.roles.fetch();
  const ids = db.setupRoles?.created || [];
  let removed = 0, gone = 0; const failed = [];
  const failedIds = [];
  for (const rid of ids) {
    const r = g.roles.cache.get(rid);
    if (!r) { gone++; continue; }
    try { await r.delete(`Redo by ${who}`); removed++; await sleep(350); }
    catch (err) { console.error('role delete', r.name, err.message); failed.push(r.name); failedIds.push(rid); }
  }
  if (failedIds.length) db.setupRoles = { ...db.setupRoles, created: failedIds }; else delete db.setupRoles;
  save();
  return { removed, gone, failed };
}

// ---------- /setup roles ----------
async function setupRoles(i) {
  if (!canManage(i)) return i.reply({ content: "You don't have permission to do that.", flags: EPH });
  if (!i.guild.members.me.permissions.has(P.ManageRoles))
    return i.reply(ui.eph(ui.note('I need the **Manage Roles** permission to create roles. Give my role that permission (or Administrator) and try again.')));
  await i.deferReply({ flags: EPH });
  const r = await ensureRoles(i.guild, i.user.tag);
  return i.editReply(ui.msg(ui.note(roleSummary(r))));
}

function roleSummary(r) {
  const lines = [
    '## ✅ Roles set up',
    `**Created:** ${r.made.length}${r.skipped.length ? ` · **Already existed:** ${r.skipped.length}` : ''}${r.failed.length ? ` · **Failed:** ${r.failed.length}` : ''}`,
    '',
    '**Next:** give each staff member **Staff**, their team role (Management / Discord Moderators / Quality Assurance) and a rank (Senior / Junior / Trial). Give both owners **Owner**. New members get **Member** automatically.',
  ];
  if (!r.ordered) lines.push('', '⚠️ I couldn\'t fully order the roles. Drag **my bot role** to the very top of Server Settings → Roles, then run `/redoroles` and `/setup roles` again for a clean order.');
  if (r.failed.length) lines.push('', `⚠️ Couldn't create: ${r.failed.join(', ')}`);
  return lines.join('\n');
}

// New members get the Member role (only when /setup roles or MEMBER_ROLE_ID provides one)
async function onJoin(member) {
  const rid = cfg.roles.member;
  if (!rid || member.user.bot || db.jailed?.[member.id]) return; // jailed members don't get the member role back
  await member.roles.add(rid, "Codey's Customs auto member role").catch(() => {});
}

module.exports = { ROLES, ensureRoles, removeRoles, setupRoles, roleSummary, onJoin, canManage };
