// Central permission rules.
//  * Owner(s) (OWNER_ID in .env) get every exception: no role needed, no proof needed, never auto-moderated.
//  * COMMANDS CHANNEL: members (everyone who is not staff) can only run commands inside the channel named "commands".
//    Anywhere else (general, media, tickets...) the command is refused with a private reply (slash) or the message is
//    removed (prefix), and nothing is shown. Staff, mods and owners can use commands anywhere.
//  * EVERY command is classified below (PUBLIC / STAFF / ADMIN / PERM / PANEL / OWNER_ONLY / mod roles). A command that is
//    not listed anywhere is OWNER ONLY, so a new command can never be opened to everyone by accident.
//  * warn / kick / ban / note / timeout / jail / strikes need one of the roles listed in .env for that action.
//    (If the list is empty the bot falls back to the matching Discord permission, so nothing breaks.)
//  * Posting panels and embeds (/setup dashboard, /announce, /say, /staffinfo, ...) is owner only,
//    plus anyone listed in PANEL_USER_IDS / PANEL_ROLE_IDS.
const { PermissionFlagsBits: P, MessageFlags, ChannelType } = require('discord.js');
const cfg = require('./config');
const { db } = require('./db');

const EPH = MessageFlags.Ephemeral;
const isOwner = id => cfg.isOwner(id);
const hasAny = (member, ids) => !!member && ids.some(r => member.roles?.cache?.has(r));

const GATES = {
  warn:    { env: 'WARN_ROLE_IDS',    perm: P.ModerateMembers, label: 'warn' },
  kick:    { env: 'KICK_ROLE_IDS',    perm: P.KickMembers,     label: 'kick' },
  ban:     { env: 'BAN_ROLE_IDS',     perm: P.BanMembers,      label: 'ban' },
  note:    { env: 'NOTE_ROLE_IDS',    perm: P.ModerateMembers, label: 'use staff notes' },
  timeout: { env: 'TIMEOUT_ROLE_IDS', perm: P.ModerateMembers, label: 'timeout' },
  jail:    { env: 'JAIL_ROLE_IDS',    perm: P.ModerateMembers, label: 'jail' },
  strikes: { env: 'STRIKE_ROLE_IDS',  perm: P.ModerateMembers, label: 'manage strikes' },
};

// command (or command:subcommand) -> gate
const CMD_GATES = {
  warn: 'warn', warnings: 'warn', history: 'warn',
  kick: 'kick',
  ban: 'ban', unban: 'ban',
  timeout: 'timeout', untimeout: 'timeout',
  jail: 'jail', unjail: 'jail',
  'note:add': 'note', 'note:view': 'note',
  strikes: 'strikes',
};
// commands that post panels / embeds
const PANEL = new Set([
  'setup:dashboard', 'setup:services', 'setupserver', 'announce', 'say', 'portfolio:show', 'faq:post',
  'livestats', 'reviews', 'giveaway:start', 'package:create', 'staffinfo', 'market:post',
]);
const OWNER_ONLY = new Set(['immune', 'immunelist', 'securitycheck', 'unjail', 'digest', 'smartmod', 'presence', 'setupsecurity', 'channelpannelsetup', 'channelpanelsetup', 'security', 'addword', 'removeword', 'ownerpanel']);

OWNER_ONLY.add('emojis');

// ---- who may run what (command or command:subcommand) ----
// PUBLIC: any member, but only inside the #commands channel.
const PUBLIC = new Set(['help', 'ping', 'myorder', 'queue:view', 'review', 'link', 'unlink', 'suggest', 'remindme', 'userinfo', 'serverinfo']);
// STAFF: the Staff role (STAFF_ROLE_ID) or Manage Server. Ticket and order tools.
const STAFF = new Set(['ticketclaim', 'ticketrename', 'ticketadd', 'ticketremove', 'ticketlock', 'ticketpriority', 'ticketinfo', 'tickets', 'close', 'transcript',
  'remindclient', 'quote', 'invoice', 'progress', 'deadline', 'queue:list', 'queue:move', 'clientinfo', 'submitpackage',
  'portfolio:add', 'portfolio:remove', 'portfolio:list']);
// STAFFISH: staff, or a mod with a moderation role / Discord moderation permission.
const STAFFISH = new Set(['sticker']);
// ADMIN: Manage Server (or the panel users / roles in .env). Money, blacklist, setup.
const ADMIN = new Set(['setup:roles', 'setup:channels', 'status', 'package:list', 'package:delete', 'blacklist', 'stats', 'refund', 'giveaway:end', 'giveaway:reroll',
  'faq:add', 'faq:remove', 'faq:list', 'redoroles', 'redochannels', 'redoserver']);
// PERM: needs the matching Discord permission (the bot checks it itself, so a changed Integrations setting can't open it up).
const PERM = { purge: P.ManageMessages, slowmode: P.ManageChannels, lockdown: P.ManageChannels };

// Commands whose permission is fully decided by this file (so Discord's own default permission must not hide them).
const FULLY_GATED = new Set(['digest', 'smartmod', 'presence', 'warn', 'warnings', 'history', 'kick', 'ban', 'unban', 'timeout', 'untimeout', 'jail', 'unjail', 'note',
  'strikes', 'staffinfo', 'market', 'sticker', 'announce', 'say', 'livestats', 'reviews', 'setupsecurity', 'channelpannelsetup', 'channelpanelsetup', 'security', 'addword', 'removeword']);

function allowed(member, userId, gateName) {
  if (isOwner(userId)) return true;
  const g = GATES[gateName];
  const ids = cfg.ids(g.env);
  if (ids.length) return hasAny(member, ids);
  return !!member?.permissions?.has(g.perm);
}
const canPost = (member, userId) =>
  isOwner(userId) || cfg.ids('PANEL_USER_IDS').includes(userId) || hasAny(member, cfg.ids('PANEL_ROLE_IDS'));

const keyOf = i => {
  const sub = i.options?.getSubcommand?.(false);
  return sub ? `${i.commandName}:${sub}` : i.commandName;
};
const deny = (i, text) => i.reply({ content: text, flags: EPH }).then(() => false);

// ---------- staff checks (same rule as tickets.isStaff, written here so this file needs nothing from tickets.js) ----------
const isStaff = member => !!member && !!((cfg.roles.staff && member.roles?.cache?.has(cfg.roles.staff)) || member.permissions?.has(P.ManageGuild));
const MOD_PERMS = [P.ManageMessages, P.ModerateMembers, P.KickMembers, P.BanMembers];
const isStaffish = (member, userId) => isOwner(userId) || isStaff(member) || canPost(member, userId)
  || Object.values(GATES).some(g => hasAny(member, cfg.ids(g.env)))
  || MOD_PERMS.some(b => !!member?.permissions?.has(b));

// ---------- the #commands channel ----------
const norm = n => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// The text channel called "commands" (exact name first, then names that only add decoration like "💻・commands").
// COMMANDS_CHANNEL_ID in .env overrides this. Ticket channels are never picked.
function commandsChannel(guild) {
  const id = cfg.ids('COMMANDS_CHANNEL_ID')[0];
  if (id && guild?.channels?.cache?.get(id)) return guild.channels.cache.get(id);
  const text = [...(guild?.channels?.cache?.values() || [])].filter(c => c.type === ChannelType.GuildText && !db.tickets?.[c.id]);
  return text.find(c => c.name === 'commands') || text.find(c => norm(c.name) === 'commands') || null;
}
// null when the person may use commands here, otherwise the text to tell them
function placeProblem(i) {
  if (isStaffish(i.member, i.user.id)) return null;
  const home = commandsChannel(i.guild);
  if (!home) return "I can't find the **#commands** channel, so commands are paused for members until staff create it.";
  const here = i.channel?.isThread?.() ? i.channel.parentId : i.channelId;
  return here === home.id ? null : `Commands only work in <#${home.id}>. Run it there instead.`;
}

// Returns true when the person may run this command. Replies with the reason when not.
async function guard(i) {
  const key = keyOf(i);
  const name = i.commandName;
  const owner = isOwner(i.user.id);

  const wrong = placeProblem(i);                                // 1. members: only in #commands
  if (wrong) return deny(i, wrong);

  if (!owner) {                                                  // 2. owner panel switches
    if (db.maintenance?.on) return deny(i, `${cfg.brand} bot is in maintenance mode. Please try again later.`);
    if (db.disabledCmds?.[name]) return deny(i, 'That command is switched off right now.');
  }
  if (OWNER_ONLY.has(key) || OWNER_ONLY.has(name))              // 3. owner only
    return owner ? true : deny(i, '**Owner only.**');
  if (PANEL.has(key))
    return canPost(i.member, i.user.id) ? true : deny(i, 'Only the **owner** can post panels and embeds.');
  const gate = CMD_GATES[key] || CMD_GATES[name];               // 4. moderation roles from .env
  if (gate) {
    if (allowed(i.member, i.user.id, gate)) return true;
    const g = GATES[gate];
    const ids = cfg.ids(g.env);
    return deny(i, ids.length
      ? `You need one of these roles to ${g.label}: ${ids.map(r => `<@&${r}>`).join(' ')}`
      : `You don't have permission to ${g.label}.`);
  }

  if (owner) return true;                                       // 5. everything else, by tier
  if (PUBLIC.has(key) || PUBLIC.has(name)) return true;
  if (STAFF.has(key) || STAFF.has(name)) return isStaff(i.member) ? true : deny(i, '**Staff only.**');
  if (STAFFISH.has(name)) return isStaffish(i.member, i.user.id) ? true : deny(i, '**Staff only.**');
  if (ADMIN.has(key) || ADMIN.has(name))
    return canPost(i.member, i.user.id) || i.member?.permissions?.has(P.ManageGuild) ? true : deny(i, '**Admins only.** You need the Manage Server permission.');
  if (PERM[name]) return i.member?.permissions?.has(PERM[name]) ? true : deny(i, "You don't have permission to do that.");
  return deny(i, "You can't use that command.");               // not listed anywhere: owner only
}

// Can `i.member` act on `target` (a GuildMember)? Returns an error string or null.
function targetError(i, target) {
  if (!target) return null;
  if (target.id === i.user.id) return "You can't do that to yourself.";
  if (isOwner(target.id) || i.guild.ownerId === target.id) return "You can't do that to an owner.";
  if (target.user?.bot && !isOwner(i.user.id)) return "You can't do that to a bot.";
  if (isOwner(i.user.id) || !target.roles) return null;
  if (target.roles.highest.position >= i.member.roles.highest.position) return 'That member is the same rank or higher than you.';
  return null;
}

// Which actions need proof (PROOF_REQUIRED_FOR=ban,kick ...). Default: ban only. Owners never need proof.
const proofRequired = action => {
  const raw = process.env.PROOF_REQUIRED_FOR;
  const list = (raw === undefined || raw.trim() === '' ? 'ban' : raw).toLowerCase().split(/[\s,]+/).filter(Boolean);
  return list.includes(action);
};

// Slash default permissions are removed for the commands guard() controls, otherwise Discord would hide them
// from staff who have the right *role* but not the matching Discord permission.
function registrationJSON(builder) {
  const j = builder.toJSON();
  if (FULLY_GATED.has(j.name)) j.default_member_permissions = null;
  return j;
}

module.exports = { isOwner, allowed, canPost, guard, isStaff, isStaffish, commandsChannel, placeProblem, PUBLIC, STAFF, STAFFISH, ADMIN, PERM, PANEL, OWNER_ONLY, CMD_GATES, targetError, proofRequired, registrationJSON, FULLY_GATED, GATES, keyOf, hasAny };
