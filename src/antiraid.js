// Anti-raid. Watches Discord's audit log (so it catches the bot AND Discord's own buttons) and sends offenders to prison.
//  * mass channel / role delete, mass ban, mass kick (default 4 in 20 seconds), mass channel / role / webhook creation
//  * giving someone an Administrator role without permission  -> giver AND receiver are jailed, roles stripped, the role is not given back
//  * making a role Administrator (editing or creating one) without permission -> reverted + jailed
//  * removing the Prisoner role by hand without permission -> role goes straight back + the remover is jailed
//  * deleting / editing the Prisoner role -> rebuilt + the person is jailed
//  * adding a bot without permission -> bot is kicked + the adder is jailed
//  * rollback: deleted channels are re-created, mass bans are undone
// Everything is configured in .env (see .env.example). Owners, the bot itself and anyone the owner added with /immune are never punished.
const { AuditLogEvent: A, ChannelType, PermissionFlagsBits: P, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { db, save } = require('./db');
const ui = require('./ui');
const ML = require('./modlog');
const { add, sc } = require('./commands');
const SEC = require('./security');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = ms => Math.floor(ms / 1000);
// ---------------- security levels (/security level low|medium|high) ----------------
const PRESETS = {
  low:    { label: '🟢 Low',    window: 20, chDel: 6, roleDel: 6, ban: 6, kick: 6, chNew: 10, roleNew: 10, hook: 5, botAdd: false,
            watch: ['Administrator'] },
  medium: { label: '🟡 Medium', window: 20, chDel: 4, roleDel: 4, ban: 4, kick: 4, chNew: 6, roleNew: 6, hook: 3, botAdd: true,
            watch: ['Administrator'] },
  high:   { label: '🔴 High',   window: 30, chDel: 2, roleDel: 2, ban: 2, kick: 2, chNew: 3, roleNew: 3, hook: 2, botAdd: true,
            watch: ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks', 'BanMembers', 'KickMembers'] },
};
const levelName = () => (PRESETS[db.security?.level] ? db.security.level : 'medium');
const preset = () => PRESETS[levelName()];
const WINDOW = () => preset().window * 1000;
const LIMITS = {
  chDel:   () => preset().chDel,
  roleDel: () => preset().roleDel,
  ban:     () => preset().ban,
  kick:    () => preset().kick,
  chNew:   () => preset().chNew,
  roleNew: () => preset().roleNew,
  hook:    () => preset().hook,
};
const NAMES = {
  chDel: 'deleted channels', roleDel: 'deleted roles', ban: 'banned members', kick: 'kicked members',
  chNew: 'created channels', roleNew: 'created roles', hook: 'created webhooks',
};
const on = () => cfg.flag('RAID_ENABLED', true);

// permissions that count as "dangerous" when handed out: depends on the level (+ anything extra in RAID_WATCH_PERMS)
function watchBits() {
  let bits = 0n;
  const names = [...preset().watch, ...(process.env.RAID_WATCH_PERMS || '').split(/[\s,]+/).filter(Boolean)];
  for (const n of names) if (P[n]) bits |= P[n];
  return bits;
}
const dangerous = perms => (BigInt(perms.bitfield ?? perms) & watchBits()) !== 0n;

// ---------------- counters ----------------
const hits = new Map();       // `${kind}:${userId}` -> [{ at, id, label }]
const tripped = new Map();    // `${kind}:${userId}` -> when it fired (so one raid = one punishment)
const punished = new Map();   // userId -> when (anything they still do in the next minute is rolled back too)
function count(kind, userId, item) {
  const k = `${kind}:${userId}`;
  const now = Date.now();
  const list = (hits.get(k) || []).filter(h => now - h.at < WINDOW());
  list.push({ at: now, ...item });
  hits.set(k, list);
  return list;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, l] of hits) if (!l.some(h => now - h.at < 120000)) hits.delete(k);
  for (const [k, t] of tripped) if (now - t > 120000) tripped.delete(k);
  for (const [k, t] of punished) if (now - t > 120000) punished.delete(k);
}, 60000).unref?.();

// ---------------- channel snapshots (so deleted channels can be put back) ----------------
const snaps = new Map();
function snap(ch) {
  if (!ch || ch.isThread?.() || !ch.guild || ch.guildId !== cfg.guildId) return;
  if (ch.topic?.startsWith('ticket:') || ch.topic?.startsWith('prison:')) return;   // temporary ticket channels
  snaps.set(ch.id, {
    id: ch.id, name: ch.name, type: ch.type, parentId: ch.parentId || null, position: ch.rawPosition ?? 0,
    topic: ch.topic ?? null, nsfw: ch.nsfw ?? false, rateLimitPerUser: ch.rateLimitPerUser ?? 0,
    bitrate: ch.bitrate ?? null, userLimit: ch.userLimit ?? null,
    overwrites: [...(ch.permissionOverwrites?.cache.values() || [])].map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield })),
  });
  if (snaps.size > 3000) snaps.delete(snaps.keys().next().value);
}
async function warm(client) {
  const g = client.guilds.cache.get(cfg.guildId) || await client.guilds.fetch(cfg.guildId).catch(() => null);
  if (!g) return;
  const chans = await g.channels.fetch().catch(() => null);
  for (const ch of chans?.values() || []) snap(ch);
  await g.roles.fetch().catch(() => {});
}
async function restoreChannels(guild, ids, who) {
  const list = ids.map(id => snaps.get(id)).filter(Boolean).filter(s => !guild.channels.cache.has(s.id));
  list.sort((a, b) => (a.type === ChannelType.GuildCategory ? 0 : 1) - (b.type === ChannelType.GuildCategory ? 0 : 1) || a.position - b.position);
  const map = new Map();
  const made = [];
  for (const s of list) {
    const parent = s.parentId ? (map.get(s.parentId) || (guild.channels.cache.has(s.parentId) ? s.parentId : null)) : null;
    const ow = s.overwrites.filter(o => o.type === 0 ? (o.id === guild.id || guild.roles.cache.has(o.id)) : true)
      .map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
    const opts = { name: s.name, type: s.type, parent, position: s.position, reason: `Anti-raid rollback (deleted by ${who})` };
    if (s.type !== ChannelType.GuildCategory) {
      if (s.topic) opts.topic = s.topic;
      if (s.nsfw) opts.nsfw = true;
      if (s.rateLimitPerUser) opts.rateLimitPerUser = s.rateLimitPerUser;
      if (s.bitrate && [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(s.type)) opts.bitrate = Math.min(s.bitrate, guild.maximumBitrate || 96000);
      if (s.userLimit) opts.userLimit = s.userLimit;
    }
    let c = await guild.channels.create({ ...opts, permissionOverwrites: ow }).catch(() => null);
    if (!c) c = await guild.channels.create(opts).catch(() => null);     // retry without permissions
    if (c) { map.set(s.id, c.id); made.push(c.name); snap(c); await sleep(400); }
  }
  return made;
}

// ---------------- punish ----------------
const fmt = h => `<t:${ts(h.at)}:T> ${h.label}`;
async function member(guild, id) { return guild.members.cache.get(id) || guild.members.fetch(id).catch(() => null); }

// Jails `who` (and optionally others) with an evidence list for the appeal ticket.
async function punish(client, guild, whoId, reason, details, extra = {}) {
  punished.set(whoId, Date.now());
  const m = await member(guild, whoId);
  if (!m) { await SEC.alertOwners(client, `**${reason}**\n<@${whoId}> already left the server, so I couldn't jail them.\n${details.slice(0, 8).join('\n')}`); return null; }
  const res = await SEC.imprison(client, guild, m, { by: null, reason: `Anti-raid: ${reason}`, details, source: 'raid', drop: extra.drop || [] });
  if (res.ok && !res.already) {
    await SEC.alertOwners(client, `**Anti-raid:** <@${whoId}> was jailed.\n**Why:** ${reason}\n${details.slice(0, 10).join('\n')}${extra.note ? `\n${extra.note}` : ''}`.slice(0, 1800));
  }
  // a rogue BOT is removed completely
  if (m.user.bot && res.ok && cfg.flag('RAID_KICK_ROGUE_BOTS', true)) await m.kick('Anti-raid: bot caused a raid').catch(() => {});
  return res;
}

async function trip(client, guild, kind, userId, list) {
  const key = `${kind}:${userId}`;
  if (tripped.has(key)) return;
  tripped.set(key, Date.now());
  const secs = Math.round(WINDOW() / 1000);
  const details = [`• **${list.length} ${NAMES[kind]} in ${Math.max(1, Math.round((list[list.length - 1].at - list[0].at) / 1000))}s** (limit is ${LIMITS[kind]()} per ${secs}s)`, ...list.slice(0, 15).map(h => `• ${fmt(h)}`)];
  const notes = [];

  const res = await punish(client, guild, userId, `${list.length} ${NAMES[kind]} within ${secs} seconds`, details);

  // rollback
  if (kind === 'chDel' && cfg.flag('RAID_RESTORE_CHANNELS', true)) {
    const made = await restoreChannels(guild, list.map(h => h.id), userId);
    if (made.length) notes.push(`♻️ Restored ${made.length} deleted channel(s): ${made.slice(0, 10).map(n => `#${n}`).join(', ')}`);
  }
  if (kind === 'ban' && cfg.flag('RAID_UNDO_BANS', true)) {
    let n = 0;
    for (const h of list) if (await guild.members.unban(h.id, 'Anti-raid rollback').then(() => true).catch(() => false)) n++;
    if (n) notes.push(`♻️ Un-banned ${n} member(s) banned during the raid.`);
  }
  if (kind === 'hook') {
    for (const wh of (await guild.fetchWebhooks().catch(() => [])).values?.() || []) if (list.some(h => h.id === wh.id)) await wh.delete('Anti-raid').catch(() => {});
  }
  if (kind === 'chNew') for (const h of list) await guild.channels.delete(h.id, 'Anti-raid: mass channel creation').catch(() => {});
  if (kind === 'roleNew') for (const h of list) await guild.roles.delete(h.id, 'Anti-raid: mass role creation').catch(() => {});
  if (notes.length) await SEC.alertOwners(client, notes.join('\n'));
  return res;
}

// For bans done through THIS bot's /ban the audit log says "the bot did it ... (by Tag)". Find the real person.
async function realActor(client, guild, entry) {
  if (entry.executorId !== client.user.id) return entry.executorId;
  if (entry.action !== A.MemberBanAdd && entry.action !== A.MemberKick) return null;
  const m = /\(by ([^)]+)\)\s*$/.exec(entry.reason || '');
  if (!m) return null;
  const q = m[1].trim();
  const found = await guild.members.search({ query: q.split('#')[0], limit: 5 }).catch(() => null);
  return found?.find(x => x.user.tag === q || x.user.username === q)?.id || null;
}

// ---------------- the audit log listener ----------------
async function onAudit(client, entry, guild) {
  if (!on() || guild.id !== cfg.guildId || !entry.executorId) return;
  let who = await realActor(client, guild, entry);
  if (!who) return;
  const exec = await member(guild, who);
  if (SEC.isImmune(guild, who, exec)) return;
  const role = SEC.getRole(guild);
  const ch = k => (entry.changes || []).find(c => c.key === k);
  const tag = `<@${who}>`;

  switch (entry.action) {
    // ----- mass actions -----
    case A.ChannelDelete: {
      const name = ch('name')?.old || entry.targetId;
      if (punished.has(who) && cfg.flag('RAID_RESTORE_CHANNELS', true)) { await restoreChannels(guild, [entry.targetId], who); return; }
      const l = count('chDel', who, { id: entry.targetId, label: `Deleted channel **#${name}**` });
      if (l.length >= LIMITS.chDel()) await trip(client, guild, 'chDel', who, l);
      return;
    }
    case A.RoleDelete: {
      const name = ch('name')?.old || entry.targetId;
      if (entry.targetId === SEC.prisonerId()) {                       // someone deleted the Prisoner role
        await SEC.rebuildRole(client, guild, `deleted by <@${who}>`);
        await punish(client, guild, who, 'deleted the Prisoner role', [`• <t:${ts(Date.now())}:T> Deleted the **Prisoner** role`]);
        return;
      }
      const l = count('roleDel', who, { id: entry.targetId, label: `Deleted role **${name}**` });
      if (l.length >= LIMITS.roleDel()) await trip(client, guild, 'roleDel', who, l);
      return;
    }
    case A.MemberBanAdd: {
      const l = count('ban', who, { id: entry.targetId, label: `Banned <@${entry.targetId}> (${entry.targetId})` });
      if (l.length >= LIMITS.ban()) await trip(client, guild, 'ban', who, l);
      return;
    }
    case A.MemberKick: {
      const l = count('kick', who, { id: entry.targetId, label: `Kicked <@${entry.targetId}> (${entry.targetId})` });
      if (l.length >= LIMITS.kick()) await trip(client, guild, 'kick', who, l);
      return;
    }
    case A.MemberPrune: {
      const n = Number(entry.extra?.removed || 0);
      if (n >= LIMITS.kick()) await punish(client, guild, who, `pruned ${n} members`, [`• <t:${ts(Date.now())}:T> Pruned **${n}** members`]);
      return;
    }
    case A.ChannelCreate: {
      const l = count('chNew', who, { id: entry.targetId, label: `Created channel **#${ch('name')?.new || entry.targetId}**` });
      if (l.length >= LIMITS.chNew()) await trip(client, guild, 'chNew', who, l);
      return;
    }
    case A.WebhookCreate: {
      const l = count('hook', who, { id: entry.targetId, label: `Created webhook **${ch('name')?.new || entry.targetId}**` });
      if (l.length >= LIMITS.hook()) await trip(client, guild, 'hook', who, l);
      return;
    }

    // ----- roles -----
    case A.RoleCreate: {
      const r = guild.roles.cache.get(entry.targetId);
      if (r && dangerous(r.permissions)) {
        await r.delete('Anti-raid: dangerous role created without permission').catch(() => {});
        await punish(client, guild, who, 'created a role with dangerous permissions', [`• <t:${ts(Date.now())}:T> Created the role **${r.name}** with watched permissions (Administrator). I deleted it.`]);
        return;
      }
      const l = count('roleNew', who, { id: entry.targetId, label: `Created role **${ch('name')?.new || entry.targetId}**` });
      if (l.length >= LIMITS.roleNew()) await trip(client, guild, 'roleNew', who, l);
      return;
    }
    case A.RoleUpdate: {
      const r = guild.roles.cache.get(entry.targetId);
      if (!r) return;
      const p = ch('permissions');
      if (role && r.id === role.id) {                                  // someone edited the Prisoner role
        if (r.permissions.bitfield !== 0n) await r.setPermissions([], 'Anti-raid: Prisoner role must have no permissions').catch(() => {});
        if (p) await punish(client, guild, who, 'edited the Prisoner role', [`• <t:${ts(Date.now())}:T> Changed the permissions of the **Prisoner** role (reverted)`]);
        return;
      }
      if (p && !SEC.mayGiveAdmin(guild, who, exec)) {
        const was = BigInt(p.old ?? 0), now = BigInt(p.new ?? 0);
        if (dangerous(now) && !dangerous(was)) {
          await r.setPermissions(was, 'Anti-raid: dangerous permission added without permission').catch(() => {});
          await punish(client, guild, who, `gave the role ${r.name} dangerous permissions`, [`• <t:${ts(Date.now())}:T> Edited **${r.name}** to give it Administrator / watched permissions. I reverted it.`]);
        }
      }
      return;
    }

    // ----- giving / removing roles on members -----
    case A.MemberRoleUpdate: {
      const added = (ch('$add')?.new || []).map(r => r.id);
      const removed = (ch('$remove')?.new || []).map(r => r.id);
      const target = entry.targetId;

      // 1) Prisoner role removed by hand
      if (role && removed.includes(role.id) && db.jailed[target]) {
        if (SEC.mayRemovePrisoner(guild, who, exec)) {                // allowed: treat it as a release, roles come back
          const tm = await member(guild, target);
          if (tm) await SEC.release(client, guild, tm, { by: who, reason: 'Prisoner role removed by an allowed person' }).catch(() => {});
        } else {
          const tm = await member(guild, target);
          await tm?.roles.add(role, 'Anti-raid: the Prisoner role cannot be removed').catch(() => {});
          await punish(client, guild, who, 'removed the Prisoner role from someone', [`• <t:${ts(Date.now())}:T> Removed the **Prisoner** role from <@${target}>. I put it back.`]);
        }
        return;
      }

      // 2) dangerous (Administrator) role handed out
      if (!added.length) return;
      const bad = added.map(id => guild.roles.cache.get(id)).filter(r => r && r.id !== role?.id && dangerous(r.permissions));
      if (!bad.length || SEC.mayGiveAdmin(guild, who, exec)) return;
      const names = bad.map(r => `**${r.name}**`).join(', ');
      const when = `<t:${ts(Date.now())}:T>`;
      const tm = await member(guild, target);
      // the receiver loses everything too and does NOT get the dangerous role back
      if (tm && target !== who && !SEC.isImmune(guild, target, tm))
        await SEC.imprison(client, guild, tm, {
          by: null, reason: 'Anti-raid: received an Administrator role from someone who is not allowed to give it', source: 'raid',
          drop: bad.map(r => r.id), details: [`• ${when} Was given ${names} by ${tag}, who is not allowed to hand out Administrator roles.`, '• The role was taken away and will not be given back automatically.'],
        });
      await punish(client, guild, who, 'gave someone an Administrator role without permission',
        [`• ${when} Gave ${names} to <@${target}>`], { note: `<@${target}> was jailed too and lost the role.` });
      return;
    }

    // ----- bots -----
    case A.BotAdd: {
      if (!preset().botAdd) return;
      if (hasAnyRole(exec, cfg.ids('BOT_ADD_ROLE_IDS'))) return;
      const bm = await member(guild, entry.targetId);
      await bm?.kick('Anti-raid: bots can only be added by allowed people').catch(() => {});
      await punish(client, guild, who, 'added a bot without permission', [`• <t:${ts(Date.now())}:T> Added the bot <@${entry.targetId}> (kicked again)`]);
      return;
    }
  }
}
const hasAnyRole = (m, ids) => !!m && ids.some(r => m.roles.cache.has(r));


// ---------------- /security level ----------------
function describe(name) {
  const p = PRESETS[name];
  return `**${p.label}**\n` +
    `• Mass **delete channels / roles, ban, kick**: **${p.chDel}** within **${p.window}s** = jailed\n` +
    `• Mass **create channels / roles**: **${p.chNew}**, **webhooks**: **${p.hook}** within ${p.window}s\n` +
    `• Watched permissions when handed out: ${p.watch.join(', ')}\n` +
    `• Bots added without permission: **${p.botAdd ? 'kicked + adder jailed' : 'allowed'}**`;
}
add(sc('security').setDescription('Owner: anti-raid security level')
  .addSubcommand(s => s.setName('level').setDescription('Set the security level').addStringOption(o => o.setName('level').setDescription('How strict the anti-raid is').setRequired(true)
    .addChoices({ name: 'Low', value: 'low' }, { name: 'Medium', value: 'medium' }, { name: 'High', value: 'high' })))
  .addSubcommand(s => s.setName('status').setDescription('Show the current level and what it does')),
async i => {
  const sub = i.options.getSubcommand();
  if (sub === 'level') {
    const lv = i.options.getString('level');
    db.security = db.security || {}; db.security.level = lv; save();
    await ML.line(i.client, `🛡️ <@${i.user.id}> set the security level to **${lv.toUpperCase()}**.`);
    return i.reply(ui.eph(ui.note(`## 🛡️ Security level changed\n${describe(lv)}${lv === 'high' ? '\n\n⚠️ On **High**, handing out roles with Manage Roles / Ban / Kick etc. counts as dangerous. Put the roles allowed to manage staff in `ADMIN_GIVE_ROLE_IDS` or `SECURITY_IMMUNE_ROLE_IDS` so they don\'t get jailed.' : ''}`)));
  }
  return i.reply(ui.eph(ui.note(`## 🛡️ Current security level\n${describe(levelName())}\n\n-# Change it with \`/security level\`. Anti-raid is ${on() ? '**ON**' : '**OFF** (RAID_ENABLED=false)'}.`)));
});

module.exports = { onAudit, snap, warm };
