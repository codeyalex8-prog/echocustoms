// Moderation commands: warn, warnings, history, timeout, untimeout, kick, ban, unban.
//  * Who may use each one is set in .env (WARN_ROLE_IDS, KICK_ROLE_IDS, BAN_ROLE_IDS, TIMEOUT_ROLE_IDS). Owners always can.
//  * Bans need PROOF (attachment or link) unless you are an owner. The proof is shown in the staff/ban logs.
//  * Every action is logged as a numbered case (see modlog.js).
const { MessageFlags } = require('discord.js');
const cfg = require('./config');
const { db, save } = require('./db');
const ui = require('./ui');
const { add, sc } = require('./commands');
const { targetError, proofRequired, isOwner } = require('./perms');
const ML = require('./modlog');

const EPH = MessageFlags.Ephemeral;
const ts = ms => Math.floor(ms / 1000);
const dm = (u, txt) => u.send(ui.msg(ui.note(txt))).catch(() => {});
const urlOk = s => /^https?:\/\/\S+$/i.test(s);

function parseDur(str) {
  const m = /^(\d+)\s*([smhd])$/i.exec((str || '').trim());
  return m ? Number(m[1]) * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2].toLowerCase()] : null;
}

// optional proof options (attachment OR link). Put them after the required options.
const withProof = (b, text = 'Proof screenshot/file') => b
  .addAttachmentOption(o => o.setName('proof').setDescription(text))
  .addStringOption(o => o.setName('proof_link').setDescription('Proof link (https://...)').setMaxLength(500));

// { att, link } or { error }
function getProof(i, action) {
  const att = i.options.getAttachment('proof') || null;
  const link = (i.options.getString('proof_link') || '').trim() || null;
  if (link && !urlOk(link)) return { error: 'The proof link must be a valid `https://` link.' };
  if (proofRequired(action) && !isOwner(i.user.id) && !att && !link)
    return { error: `🧾 **Proof is required to ${action}.** Attach a screenshot/file, or add a proof link.\nExample: \`${cfg.prefix}${action} @user reason https://link\` (or attach an image to the message).` };
  return { att, link };
}
const reply = (i, text) => i.reply({ content: text, flags: EPH });
const getMember = (i, u) => i.guild.members.fetch(u.id).catch(() => null);

// ---------------- /warn ----------------
add(withProof(sc('warn').setDescription('Warn a member')
  .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(400)), 'Proof (optional)'),
async i => {
  const u = i.options.getUser('user'); const reason = i.options.getString('reason');
  if (u.bot) return reply(i, "You can't warn bots.");
  const m = await getMember(i, u);
  const err = targetError(i, m); if (err) return reply(i, err);
  const pr = getProof(i, 'warn'); if (pr.error) return reply(i, pr.error);
  (db.warns[u.id] = db.warns[u.id] || []).push({ by: i.user.id, reason, at: Date.now() }); save();
  await dm(u, `⚠️ You were **warned** in **${cfg.brand}**.\n**Reason:** ${reason}`);
  const k = await ML.record(i.client, { action: 'warn', modId: i.user.id, user: u, reason, proof: pr, extra: { text: `**Total warnings:** ${db.warns[u.id].length}` } });
  await reply(i, `Warned **${u.tag}** (${db.warns[u.id].length} total). Case **#${k.id}**.`);
});

// ---------------- /warnings ----------------
add(sc('warnings').setDescription('View or clear warnings')
  .addSubcommand(s => s.setName('view').setDescription('View warnings')
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
  .addSubcommand(s => s.setName('clear').setDescription('Clear all warnings')
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))),
async i => {
  const u = i.options.getUser('user');
  if (i.options.getSubcommand() === 'clear') {
    delete db.warns[u.id]; save();
    await ML.line(i.client, `<@${i.user.id}> cleared warnings for <@${u.id}>.`);
    return reply(i, `Cleared warnings for **${u.tag}**.`);
  }
  const l = (db.warns[u.id] || []).map((w, k) => `**${k + 1}.** ${w.reason} (by <@${w.by}>, <t:${ts(w.at)}:d>)`).join('\n');
  await i.reply({ content: l || 'No warnings.', flags: EPH, allowedMentions: { parse: [] } });
});

// ---------------- /history (all cases for a user) ----------------
add(sc('history').setDescription('Moderation history of a user: cases, warnings and strikes')
  .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
async i => {
  const u = i.options.getUser('user');
  const cases = ML.casesFor(u.id).slice(-12).reverse();
  const strikes = db.strikes[u.id]?.count || 0;
  const lines = cases.map(c => `**#${c.id}** ${c.action.toUpperCase()} · ${c.reason.slice(0, 80)} · <t:${ts(c.at)}:d>${c.logUrl ? ` · [log](${c.logUrl})` : ''}${c.proofLink || c.proofName ? ' · 🧾 proof' : ''}`);
  await i.reply({ flags: EPH, allowedMentions: { parse: [] }, content:
    `**${u.tag}** · Warnings: **${(db.warns[u.id] || []).length}** · Auto-mod strikes: **${strikes}/15**${db.jailed[u.id] ? ' · 🚔 **jailed**' : ''}\n${lines.join('\n') || 'No cases.'}` });
});

// ---------------- /timeout, /untimeout ----------------
add(withProof(sc('timeout').setDescription('Timeout a member')
  .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
  .addStringOption(o => o.setName('duration').setDescription('e.g. 10m, 2h, 1d (max 28d)').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setMaxLength(300)), 'Proof (optional)'),
async i => {
  const dur = i.options.getString('duration'); const ms = parseDur(dur);
  if (!ms || ms > 28 * 86400e3) return reply(i, 'Invalid duration. Use `30m`, `2h` or `3d` (max 28d).');
  const m = await getMember(i, i.options.getUser('user'));
  if (!m) return reply(i, 'Member not found.');
  const err = targetError(i, m); if (err) return reply(i, err);
  if (!m.moderatable) return reply(i, "I can't timeout that member (role hierarchy).");
  const pr = getProof(i, 'timeout'); if (pr.error) return reply(i, pr.error);
  const reason = i.options.getString('reason') || 'No reason given';
  await m.timeout(ms, `${reason} (by ${i.user.tag})`);
  await dm(m.user, `⏳ You were **timed out** in **${cfg.brand}** until <t:${ts(Date.now() + ms)}:F>.\n**Reason:** ${reason}`);
  const k = await ML.record(i.client, { action: 'timeout', modId: i.user.id, user: m.user, reason, proof: pr, extra: { text: `**Duration:** ${dur}` } });
  await reply(i, `Timed out **${m.user.tag}** for ${dur}. Case **#${k.id}**.`);
});

add(sc('untimeout').setDescription('Remove a timeout')
  .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setMaxLength(300)),
async i => {
  const m = await getMember(i, i.options.getUser('user'));
  if (!m) return reply(i, 'Member not found.');
  if (!m.communicationDisabledUntilTimestamp) return reply(i, 'That member is not timed out.');
  const reason = i.options.getString('reason') || 'No reason given';
  await m.timeout(null, `${reason} (by ${i.user.tag})`);
  await ML.record(i.client, { action: 'untimeout', modId: i.user.id, user: m.user, reason });
  await reply(i, `Removed the timeout from **${m.user.tag}**.`);
});

// ---------------- /kick ----------------
add(withProof(sc('kick').setDescription('Kick a member')
  .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(300)), 'Proof (optional)'),
async i => {
  const m = await getMember(i, i.options.getUser('user'));
  if (!m) return reply(i, 'Member not found.');
  const err = targetError(i, m); if (err) return reply(i, err);
  if (!m.kickable) return reply(i, "I can't kick that member (role hierarchy).");
  const pr = getProof(i, 'kick'); if (pr.error) return reply(i, pr.error);
  const reason = i.options.getString('reason');
  await dm(m.user, `👢 You were **kicked** from **${cfg.brand}**.\n**Reason:** ${reason}`);
  await m.kick(`${reason} (by ${i.user.tag})`);
  const k = await ML.record(i.client, { action: 'kick', modId: i.user.id, user: m.user, reason, proof: pr });
  await reply(i, `Kicked **${m.user.tag}**. Case **#${k.id}**.`);
});

// ---------------- /ban (PROOF REQUIRED unless owner) ----------------
add(withProof(sc('ban').setDescription('Ban a user (proof required)')
  .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(300)), 'Proof screenshot/file (required unless owner)')
  .addIntegerOption(o => o.setName('delete_days').setDescription('Delete their messages from the last N days').setMinValue(0).setMaxValue(7)),
async i => {
  const u = i.options.getUser('user');
  const m = await getMember(i, u);
  const err = targetError(i, m || { id: u.id, user: u, roles: null });
  if (err) return reply(i, err);
  if (m && !m.bannable) return reply(i, "I can't ban that member (role hierarchy).");
  const pr = getProof(i, 'ban'); if (pr.error) return reply(i, pr.error);
  const reason = i.options.getString('reason');
  if (m) await dm(u, `🔨 You were **banned** from **${cfg.brand}**.\n**Reason:** ${reason}`);
  await i.guild.members.ban(u.id, { reason: `${reason} (by ${i.user.tag})`, deleteMessageSeconds: (i.options.getInteger('delete_days') || 0) * 86400 });
  delete db.tempbans[u.id]; save();
  const k = await ML.record(i.client, { action: 'ban', modId: i.user.id, user: u, reason, proof: pr });
  await reply(i, `Banned **${u.tag}**. Case **#${k.id}**${pr.att || pr.link ? ' (proof logged)' : ''}.`);
});

// ---------------- /unban ----------------
add(sc('unban').setDescription('Unban a user (use their ID)')
  .addUserOption(o => o.setName('user').setDescription('User (or paste their ID in the prefix command)').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setMaxLength(300)),
async i => {
  const u = i.options.getUser('user');
  const banned = await i.guild.bans.fetch(u.id).catch(() => null);
  if (!banned) return reply(i, 'That user is not banned.');
  const reason = i.options.getString('reason') || 'No reason given';
  await i.guild.members.unban(u.id, `${reason} (by ${i.user.tag})`);
  delete db.tempbans[u.id]; save();
  const k = await ML.record(i.client, { action: 'unban', modId: i.user.id, user: u, reason });
  await reply(i, `Unbanned **${u.tag}**. Case **#${k.id}**.`);
});

module.exports = { parseDur };
