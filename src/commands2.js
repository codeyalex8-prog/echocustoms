// 20 extra commands: ticket tools, invoices, giveaways, suggestions, moderation, FAQ, utilities
const {
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType, PermissionFlagsBits: P, MessageFlags,
} = require('discord.js');
const cfg = require('./config');
const { db, save } = require('./db');
const ui = require('./ui');
const T = require('./tickets');
const { add, sc, needTicket } = require('./commands');
const { E, tag } = require('./emojis');

const EPH = MessageFlags.Ephemeral;
const next = k => (db.counters[k] = (db.counters[k] || 0) + 1);
const ts = ms => Math.floor(ms / 1000);
const can = (i, flag) => i.memberPermissions?.has(flag) || (flag === P.ManageGuild && require('./perms').canPost(i.member, i.user.id));
const noPerm = i => i.reply({ content: "You don't have permission to do that.", flags: EPH });

function parseDur(str) {
  const m = /^(\d+)\s*([smhd])$/i.exec((str || '').trim());
  if (!m) return null;
  return Number(m[1]) * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2].toLowerCase()];
}
const DUR_HELP = 'Use a duration like `30m`, `2h` or `3d`.';

// =============== 1. /ticketlock ===============
add(sc('ticketlock').setDescription('Lock or unlock the client from sending messages (staff)')
  .addStringOption(o => o.setName('state').setDescription('Lock or unlock').setRequired(true)
    .addChoices({ name: 'Lock', value: 'lock' }, { name: 'Unlock', value: 'unlock' })),
async i => {
  const t = await needTicket(i); if (!t) return;
  const lock = i.options.getString('state') === 'lock';
  await i.channel.permissionOverwrites.edit(t.ownerId, { SendMessages: lock ? false : true });
  await i.reply(ui.msg(ui.note(`${lock ? '🔒 This ticket has been **locked** by' : '🔓 This ticket has been **unlocked** by'} <@${i.user.id}>.`)));
});

// =============== 2. /ticketpriority ===============
add(sc('ticketpriority').setDescription('Set the priority of this ticket (staff)')
  .addStringOption(o => o.setName('level').setDescription('Priority').setRequired(true)
    .addChoices({ name: 'Low', value: 'low' }, { name: 'Normal', value: 'normal' }, { name: 'High', value: 'high' }, { name: 'Urgent', value: 'urgent' })),
async i => {
  if (!await needTicket(i)) return;
  const rec = db.tickets[i.channelId];
  if (!rec) return i.reply({ content: 'No record for this ticket.', flags: EPH });
  rec.priority = i.options.getString('level'); save();
  await i.reply(ui.msg(ui.note(`${tag(E.bell)} Priority set to **${rec.priority.toUpperCase()}** by <@${i.user.id}>.`)));
  T.refreshOrderPanel(i.client, i.channelId);
  T.log(i.client, `🚩 <#${i.channelId}> priority set to **${rec.priority}** by <@${i.user.id}>.`);
});

// =============== 3. /invoice ===============
const invoicePanel = inv => {
  const c = ui.base();
  c.addTextDisplayComponents(ui.text(
    `## ${tag(E.money)} Invoice\n**Amount:** ${inv.amount}\n**Payment method:** ${inv.method}\n${inv.note ? `**Note:** ${inv.note}\n` : ''}**Status:** ${inv.status === 'paid' ? '✅ Paid' : '⏳ Awaiting payment'}`));
  if (inv.status !== 'paid')
    c.addActionRowComponents(ui.row(new ButtonBuilder().setCustomId('inv_paid').setLabel('Mark as Paid (staff)').setStyle(ButtonStyle.Success)));
  return ui.foot(c);
};
add(sc('invoice').setDescription('Send a payment invoice in this order (staff)')
  .addStringOption(o => o.setName('amount').setDescription('e.g. $25 or 4000 R$').setRequired(true).setMaxLength(60))
  .addStringOption(o => o.setName('method').setDescription('e.g. Robux gamepass, PayPal').setRequired(true).setMaxLength(100))
  .addStringOption(o => o.setName('note').setDescription('Extra instructions').setMaxLength(500)),
async i => {
  if (!await needTicket(i)) return;
  const rec = db.tickets[i.channelId];
  if (!rec) return i.reply({ content: 'No record for this ticket.', flags: EPH });
  const inv = { amount: i.options.getString('amount'), method: i.options.getString('method'), note: i.options.getString('note') || '', status: 'unpaid' };
  await i.reply(ui.msg(invoicePanel(inv)));
  inv.messageId = (await i.fetchReply()).id;
  rec.invoice = inv; save();
  T.log(i.client, `🧾 <@${i.user.id}> sent an invoice of **${inv.amount}** in <#${i.channelId}>.`);
});

// =============== 4. /refund ===============
add(sc('refund').setDescription('Log a refund to #sale-logs (admin)').setDefaultMemberPermissions(P.ManageGuild)
  .addUserOption(o => o.setName('user').setDescription('Client').setRequired(true))
  .addStringOption(o => o.setName('amount').setDescription('Amount refunded').setRequired(true).setMaxLength(60))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(300)),
async i => {
  if (!can(i, P.ManageGuild)) return noPerm(i);
  const u = i.options.getUser('user');
  T.saleLog(i.client, `↩️ **Refund:** ${i.options.getString('amount')} to <@${u.id}> by <@${i.user.id}>. Reason: ${i.options.getString('reason')}`);
  await i.reply({ content: 'Refund logged.', flags: EPH });
});

// =============== 5. /remindclient ===============
add(sc('remindclient').setDescription('Ping the client in this ticket and DM them (staff)')
  .addStringOption(o => o.setName('message').setDescription('What to remind them of').setRequired(true).setMaxLength(500)),
async i => {
  const t = await needTicket(i); if (!t) return;
  const msg = i.options.getString('message');
  await i.reply({ ...ui.msg(ui.note(`${tag(E.bell)} <@${t.ownerId}> **Reminder:** ${msg}`)), allowedMentions: { users: [t.ownerId] } });
  const u = await i.client.users.fetch(t.ownerId).catch(() => null);
  await u?.send(ui.msg(ui.note(`${tag(E.bell)} **Reminder from ${cfg.brand}:** ${msg}\n-# Ticket: ${i.channel.name}`))).catch(() => {});
});

// =============== 6. /giveaway ===============
const gwPanel = g => {
  const c = ui.base();
  c.addTextDisplayComponents(ui.text(g.ended
    ? `## 🎉 Giveaway ended: ${g.prize}\n**Winners:** ${g.winnerIds.length ? g.winnerIds.map(u => `<@${u}>`).join(', ') : 'no valid entries'}\n**Hosted by:** <@${g.host}>\n**Entries:** ${g.entries.length}`
    : `## 🎉 Giveaway: ${g.prize}\nClick **Enter** to join!\n**Ends:** <t:${ts(g.endsAt)}:R>\n**Winners:** ${g.winners}\n**Hosted by:** <@${g.host}>\n**Entries:** ${g.entries.length}`));
  if (!g.ended) c.addActionRowComponents(ui.row(new ButtonBuilder().setCustomId(`gw_enter:${g.id}`).setLabel('Enter').setEmoji(E.star).setStyle(ButtonStyle.Success)));
  return ui.foot(c);
};
async function pickWinners(client, g, announceText) {
  const pool = [...g.entries]; const winners = [];
  while (winners.length < g.winners && pool.length) winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  g.ended = true; g.winnerIds = winners; save();
  const ch = await client.channels.fetch(g.channelId).catch(() => null);
  if (!ch) return winners;
  await ch.messages.edit(g.messageId, { components: [gwPanel(g)], flags: ui.V2, allowedMentions: ui.NO_PING }).catch(() => {});
  await ch.send({
    content: winners.length ? `🎉 ${announceText} ${winners.map(u => `<@${u}>`).join(', ')} won **${g.prize}**!` : `No valid entries for **${g.prize}**.`,
    allowedMentions: { users: winners },
  }).catch(() => {});
  return winners;
}
add(sc('giveaway').setDescription('Giveaways').setDefaultMemberPermissions(P.ManageGuild)
  .addSubcommand(s => s.setName('start').setDescription('Start a giveaway')
    .addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true).setMaxLength(100))
    .addStringOption(o => o.setName('duration').setDescription('e.g. 30m, 2h, 3d').setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(10))
    .addChannelOption(o => o.setName('channel').setDescription('Default: here').addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s => s.setName('end').setDescription('End a giveaway now')
    .addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true)))
  .addSubcommand(s => s.setName('reroll').setDescription('Pick new winners')
    .addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true))),
async i => {
  if (!can(i, P.ManageGuild)) return noPerm(i);
  const sub = i.options.getSubcommand();
  if (sub === 'start') {
    const ms = parseDur(i.options.getString('duration'));
    if (!ms || ms < 10e3 || ms > 30 * 86400e3) return i.reply({ content: `Invalid duration. ${DUR_HELP} (10s to 30d)`, flags: EPH });
    const ch = i.options.getChannel('channel') || i.channel;
    const g = { id: next('giveaway'), channelId: ch.id, prize: i.options.getString('prize'), endsAt: Date.now() + ms,
      winners: i.options.getInteger('winners') || 1, host: i.user.id, entries: [], ended: false, winnerIds: [] };
    const m = await ch.send(ui.msg(gwPanel(g)));
    g.messageId = m.id; db.giveaways[g.id] = g; save();
    return i.reply({ content: `Giveaway **#${g.id}** started in ${ch}.`, flags: EPH });
  }
  const g = db.giveaways[i.options.getInteger('id')];
  if (!g) return i.reply({ content: 'No giveaway with that ID.', flags: EPH });
  if (sub === 'end') {
    if (g.ended) return i.reply({ content: 'That giveaway already ended.', flags: EPH });
    await pickWinners(i.client, g, 'Congratulations');
    return i.reply({ content: 'Ended.', flags: EPH });
  }
  if (!g.ended) return i.reply({ content: 'End it first.', flags: EPH });
  await pickWinners(i.client, g, 'New winner(s):');
  await i.reply({ content: 'Rerolled.', flags: EPH });
});

// =============== 7. /suggest ===============
const sgPanel = s => {
  const c = ui.base();
  c.addTextDisplayComponents(ui.text(`## 💡 Suggestion #${s.id}\n${s.text}\n\n-# Suggested by <@${s.userId}>`));
  c.addActionRowComponents(ui.row(
    new ButtonBuilder().setCustomId(`sg:up:${s.id}`).setLabel(`👍 ${s.up.length}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sg:down:${s.id}`).setLabel(`👎 ${s.down.length}`).setStyle(ButtonStyle.Secondary)));
  return ui.foot(c);
};
add(sc('suggest').setDescription('Suggest something for the server')
  .addStringOption(o => o.setName('idea').setDescription('Your suggestion').setRequired(true).setMaxLength(1000)),
async i => {
  if (T.isBlacklisted(i.user.id)) return i.reply({ content: 'You are blacklisted.', flags: EPH });
  if (!cfg.channels.suggestions) return i.reply({ content: 'Suggestions are not set up yet.', flags: EPH });
  const ch = await i.client.channels.fetch(cfg.channels.suggestions).catch(() => null);
  if (!ch) return i.reply({ content: 'Suggestions channel not found.', flags: EPH });
  const s = { id: next('suggestion'), userId: i.user.id, text: i.options.getString('idea'), up: [], down: [], channelId: ch.id };
  const m = await ch.send(ui.msg(sgPanel(s)));
  s.messageId = m.id; db.suggestions[s.id] = s; save();
  await i.reply({ content: `Suggestion posted in ${ch}.`, flags: EPH });
});

// =============== moderation ===============
const modLog = (i, txt) => require('./modlog').line(i.client, txt);
const dm = (u, txt) => u.send(ui.msg(ui.note(txt))).catch(() => {});

// 8-12. /warn /warnings /timeout /kick /ban (+ /unban /untimeout /history) now live in modcmds.js (roles + proof + staff logs)

// 13. /purge
add(sc('purge').setDescription('Bulk delete recent messages').setDefaultMemberPermissions(P.ManageMessages)
  .addIntegerOption(o => o.setName('amount').setDescription('1 to 100').setRequired(true).setMinValue(1).setMaxValue(100))
  .addUserOption(o => o.setName('user').setDescription('Only this user\'s messages')),
async i => {
  if (!can(i, P.ManageMessages)) return noPerm(i);
  await i.deferReply({ flags: EPH });
  const amount = i.options.getInteger('amount'); const u = i.options.getUser('user');
  let msgs = await i.channel.messages.fetch({ limit: 100 });
  if (u) msgs = msgs.filter(m => m.author.id === u.id);
  const del = await i.channel.bulkDelete([...msgs.values()].slice(0, amount), true);
  modLog(i, `<@${i.user.id}> purged **${del.size}** messages in <#${i.channelId}>${u ? ` from <@${u.id}>` : ''}.`);
  await i.editReply(`Deleted **${del.size}** messages. (Messages older than 14 days can't be bulk deleted.)`);
});

// 14. /slowmode
add(sc('slowmode').setDescription('Set channel slowmode').setDefaultMemberPermissions(P.ManageChannels)
  .addIntegerOption(o => o.setName('seconds').setDescription('0 to turn off (max 21600)').setRequired(true).setMinValue(0).setMaxValue(21600)),
async i => {
  if (!can(i, P.ManageChannels)) return noPerm(i);
  const n = i.options.getInteger('seconds');
  await i.channel.setRateLimitPerUser(n);
  modLog(i, `<@${i.user.id}> set slowmode in <#${i.channelId}> to **${n}s**.`);
  await i.reply({ content: n ? `Slowmode set to **${n}s**.` : 'Slowmode turned off.', flags: EPH });
});

// 15. /lockdown
add(sc('lockdown').setDescription('Lock or unlock a channel for @everyone').setDefaultMemberPermissions(P.ManageChannels)
  .addStringOption(o => o.setName('state').setDescription('Lock or unlock').setRequired(true)
    .addChoices({ name: 'Lock', value: 'lock' }, { name: 'Unlock', value: 'unlock' }))
  .addChannelOption(o => o.setName('channel').setDescription('Default: here').addChannelTypes(ChannelType.GuildText)),
async i => {
  if (!can(i, P.ManageChannels)) return noPerm(i);
  const ch = i.options.getChannel('channel') || i.channel; const lock = i.options.getString('state') === 'lock';
  await ch.permissionOverwrites.edit(i.guild.id, { SendMessages: lock ? false : null });
  await ch.send(ui.msg(ui.note(lock ? '🔒 This channel has been **locked**.' : '🔓 This channel has been **unlocked**.')));
  modLog(i, `<@${i.user.id}> ${lock ? 'locked' : 'unlocked'} <#${ch.id}>.`);
  await i.reply({ content: 'Done.', flags: EPH });
});

// =============== utilities ===============
// 16. /userinfo
add(sc('userinfo').setDescription('Info about a user')
  .addUserOption(o => o.setName('user').setDescription('Default: you')),
async i => {
  const u = i.options.getUser('user') || i.user;
  const m = await i.guild.members.fetch(u.id).catch(() => null);
  const roles = m ? m.roles.cache.filter(r => r.id !== i.guild.id).map(r => `<@&${r.id}>`).slice(0, 15).join(' ') || 'none' : 'n/a';
  await i.reply({ ...ui.msg(ui.note(
    `## ${u.tag}\n**ID:** ${u.id}\n**Account created:** <t:${ts(u.createdTimestamp)}:D> (<t:${ts(u.createdTimestamp)}:R>)\n${m ? `**Joined server:** <t:${ts(m.joinedTimestamp)}:D>\n` : ''}**Roles:** ${roles}\n**Bot:** ${u.bot ? 'yes' : 'no'}`)) });
});

// 17. /serverinfo
add(sc('serverinfo').setDescription('Info about this server'), async i => {
  const g = i.guild; const owner = await g.fetchOwner().catch(() => null);
  await i.reply(ui.msg(ui.note(
    `## ${tag(E.logo)} ${g.name}\n**Owner:** ${owner ? `<@${owner.id}>` : 'unknown'}\n**Members:** ${g.memberCount}\n**Channels:** ${g.channels.cache.size}\n**Roles:** ${g.roles.cache.size}\n**Boosts:** ${g.premiumSubscriptionCount || 0} (tier ${g.premiumTier})\n**Created:** <t:${ts(g.createdTimestamp)}:D>\n**Founded (brand):** ${cfg.founded}`)));
});

// 18. /unlink
add(sc('unlink').setDescription('Unlink your Roblox account'), async i => {
  if (!db.links[i.user.id]) return i.reply({ content: 'You have no linked Roblox account.', flags: EPH });
  const old = db.links[i.user.id];
  delete db.links[i.user.id]; save();
  // give the nickname back (only if it is still the Roblox name we set)
  if (i.member?.nickname && i.member.nickname.toLowerCase() === String(old.name).toLowerCase())
    await i.member.setNickname(null, 'Unlinked Roblox account').catch(() => {});
  await i.reply({ content: 'Your Roblox account has been unlinked and your nickname was reset.', flags: EPH });
});

// 19. /faq
add(sc('faq').setDescription('Manage and post the FAQ panel').setDefaultMemberPermissions(P.ManageGuild)
  .addSubcommand(s => s.setName('add').setDescription('Add a question')
    .addStringOption(o => o.setName('question').setDescription('Question').setRequired(true).setMaxLength(100))
    .addStringOption(o => o.setName('answer').setDescription('Answer').setRequired(true).setMaxLength(1500)))
  .addSubcommand(s => s.setName('remove').setDescription('Remove a question')
    .addIntegerOption(o => o.setName('id').setDescription('Question ID').setRequired(true)))
  .addSubcommand(s => s.setName('list').setDescription('List questions with IDs'))
  .addSubcommand(s => s.setName('post').setDescription('Post the FAQ panel')
    .addChannelOption(o => o.setName('channel').setDescription('Default: here').addChannelTypes(ChannelType.GuildText))),
async i => {
  if (!can(i, P.ManageGuild)) return noPerm(i);
  const sub = i.options.getSubcommand();
  if (sub === 'add') {
    if (db.faq.length >= 25) return i.reply({ content: 'Max 25 questions.', flags: EPH });
    const f = { id: next('faq'), q: i.options.getString('question'), a: i.options.getString('answer') };
    db.faq.push(f); save();
    return i.reply({ content: `Added **#${f.id}**. Re-post the panel with \`/faq post\` to update it.`, flags: EPH });
  }
  if (sub === 'remove') {
    const n = db.faq.length; db.faq = db.faq.filter(f => f.id !== i.options.getInteger('id')); save();
    return i.reply({ content: db.faq.length < n ? 'Removed.' : 'No question with that ID.', flags: EPH });
  }
  if (sub === 'list') return i.reply({ content: db.faq.map(f => `**#${f.id}** ${f.q}`).join('\n') || 'No questions yet.', flags: EPH });
  if (!db.faq.length) return i.reply({ content: 'Add questions first with `/faq add`.', flags: EPH });
  const ch = i.options.getChannel('channel') || i.channel;
  const c = ui.base();
  c.addTextDisplayComponents(ui.text(`## ${tag(E.bell)} Frequently Asked Questions\n> Pick a question below to see the answer.`));
  c.addActionRowComponents(ui.row(new StringSelectMenuBuilder().setCustomId('faq_select').setPlaceholder('Choose a question')
    .addOptions(db.faq.map(f => ({ label: f.q.slice(0, 100), value: String(f.id) })))));
  await ch.send(ui.msg(ui.foot(c)));
  await i.reply({ content: `FAQ posted in ${ch}.`, flags: EPH });
});

// 20. /remindme
add(sc('remindme').setDescription('Get a DM reminder later')
  .addStringOption(o => o.setName('in').setDescription('e.g. 30m, 2h, 3d').setRequired(true))
  .addStringOption(o => o.setName('text').setDescription('What to remind you of').setRequired(true).setMaxLength(300)),
async i => {
  const ms = parseDur(i.options.getString('in'));
  if (!ms || ms < 60e3 || ms > 30 * 86400e3) return i.reply({ content: `Invalid time. ${DUR_HELP} (1m to 30d)`, flags: EPH });
  if (db.reminders.filter(r => r.userId === i.user.id).length >= 10) return i.reply({ content: 'You can have at most 10 active reminders.', flags: EPH });
  db.reminders.push({ userId: i.user.id, channelId: i.channelId, at: Date.now() + ms, text: i.options.getString('text') }); save();
  await i.reply({ content: `I'll remind you <t:${ts(Date.now() + ms)}:R>.`, flags: EPH });
});

// =============== component handlers + background tick ===============
async function onButton(i) {
  const [id, a, b] = i.customId.split(':');

  if (id === 'gw_enter') {
    const g = db.giveaways[a];
    if (!g || g.ended) { await i.reply({ content: 'This giveaway has ended.', flags: EPH }); return true; }
    const k = g.entries.indexOf(i.user.id);
    if (k >= 0) g.entries.splice(k, 1); else g.entries.push(i.user.id);
    save();
    await i.update({ components: [gwPanel(g)], flags: ui.V2, allowedMentions: ui.NO_PING });
    await i.followUp({ content: k >= 0 ? 'You left the giveaway.' : "You're in! Good luck 🍀", flags: EPH });
    return true;
  }

  if (id === 'sg') {
    const s = db.suggestions[b];
    if (!s) { await i.reply({ content: 'This suggestion no longer exists.', flags: EPH }); return true; }
    const mine = a === 'up' ? s.up : s.down, other = a === 'up' ? s.down : s.up;
    const k = mine.indexOf(i.user.id);
    if (k >= 0) mine.splice(k, 1); else { mine.push(i.user.id); const o = other.indexOf(i.user.id); if (o >= 0) other.splice(o, 1); }
    save();
    await i.update({ components: [sgPanel(s)], flags: ui.V2, allowedMentions: ui.NO_PING });
    return true;
  }

  if (id === 'inv_paid') {
    if (!T.isStaff(i.member)) { await i.reply({ content: 'Only staff can mark invoices as paid.', flags: EPH }); return true; }
    const rec = db.tickets[i.channelId];
    if (!rec?.invoice) { await i.reply({ content: 'No active invoice.', flags: EPH }); return true; }
    rec.invoice.status = 'paid'; save();
    await i.update({ components: [invoicePanel(rec.invoice)], flags: ui.V2, allowedMentions: ui.NO_PING });
    T.saleLog(i.client, `🧾 **Invoice paid:** ${rec.invoice.amount} via ${rec.invoice.method} from <@${rec.ownerId}> (<#${i.channelId}>), confirmed by <@${i.user.id}>.`);
    return true;
  }
  return false;
}

async function onSelect(i) {
  if (i.customId !== 'faq_select') return false;
  const f = db.faq.find(x => String(x.id) === i.values[0]);
  if (!f) { await i.reply({ content: 'That question no longer exists.', flags: EPH }); return true; }
  await i.reply(ui.eph(ui.note(`**${f.q}**\n${f.a}`)));
  return true;
}

async function tick(client) {
  const now = Date.now();
  for (const g of Object.values(db.giveaways)) if (!g.ended && g.endsAt <= now) await pickWinners(client, g, 'Congratulations');
  const due = db.reminders.filter(r => r.at <= now);
  if (!due.length) return;
  db.reminders = db.reminders.filter(r => r.at > now); save();
  for (const r of due) {
    const u = await client.users.fetch(r.userId).catch(() => null);
    const body = `⏰ **Reminder:** ${r.text}`;
    const ok = u ? await u.send(ui.msg(ui.note(body))).then(() => true).catch(() => false) : false;
    if (!ok) await T.sendTo(client, r.channelId, { content: `<@${r.userId}> ${body}`, allowedMentions: { users: [r.userId] } });
  }
}

module.exports = { onButton, onSelect, tick };
