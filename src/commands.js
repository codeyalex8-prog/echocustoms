const { SlashCommandBuilder, PermissionFlagsBits: P, MessageFlags, ChannelType } = require('discord.js');
const cfg = require('./config');
const { db, save, svcState } = require('./db');
const ui = require('./ui');
const T = require('./tickets');

const EPH = MessageFlags.Ephemeral;
const defs = [];
const handlers = {};
const add = (builder, fn) => { defs.push(builder); handlers[builder.name] = fn; };
const sc = n => new SlashCommandBuilder().setName(n);
const needTicket = async i => {
  const t = T.parseTopic(i.channel);
  if (!t) { await i.reply({ content: 'Use this inside a ticket channel.', flags: EPH }); return null; }
  if (!T.isStaff(i.member)) { await i.reply({ content: 'Staff only.', flags: EPH }); return null; }
  return t;
};

// ---------- /setup ----------
const chanOpt = o => o.setName('channel').setDescription('Where to post (default: here)').addChannelTypes(ChannelType.GuildText);
add(sc('setup').setDescription('Set up panels and server roles')
  .setDefaultMemberPermissions(P.ManageGuild)
  .addSubcommand(s => s.setName('dashboard').setDescription('Post the dashboard (guidelines + assistance)').addChannelOption(chanOpt))
  .addSubcommand(s => s.setName('services').setDescription('Post the services (order) panel').addChannelOption(chanOpt))
  .addSubcommand(s => s.setName('roles').setDescription('Create the full role set (staff, QA, mods, pings, members...)'))
  .addSubcommand(s => s.setName('channels').setDescription('Create the channels + permissions (run /setup roles first, or just use /setupserver)')),
async i => {
  const sub = i.options.getSubcommand();
  if (sub === 'roles') return require('./roles').setupRoles(i);
  if (sub === 'channels') return require('./server').setupChannels(i);
  const ch = i.options.getChannel('channel') || i.channel;
  if (sub === 'dashboard') {
    const m = await ch.send(ui.msg(ui.dashboardPanel()));
    db.panels.dashboard = { channelId: ch.id, messageId: m.id }; save();
  } else {
    const m = await ch.send(ui.msg(ui.servicesPanel()));
    db.panels.services = { channelId: ch.id, messageId: m.id }; save();
  }
  await i.reply({ content: `Panel posted in ${ch}.`, flags: EPH });
});

// ---------- /status (green/red + CLOSED blocks orders) ----------
add(sc('status').setDescription('Set service status: open (green), delayed (yellow), closed (red)')
  .setDefaultMemberPermissions(P.ManageGuild)
  .addStringOption(o => o.setName('service').setDescription('Service').setRequired(true).addChoices(
    { name: 'Bot Development', value: 'bot' }, { name: 'Discord Development', value: 'discord' },
    { name: 'ERLC Development', value: 'erlc' }, { name: 'ALL services', value: 'all' }))
  .addStringOption(o => o.setName('state').setDescription('Open or closed').setRequired(true)
    .addChoices({ name: 'Open (green)', value: 'open' }, { name: 'Delayed (yellow)', value: 'delayed' }, { name: 'Closed (red)', value: 'closed' })),
async i => {
  const s = i.options.getString('service'); const state = i.options.getString('state');
  for (const k of s === 'all' ? Object.keys(cfg.services) : [s]) db.status[k] = state;
  save();
  const ok = await T.refreshServicesPanel(i.client);
  T.log(i.client, `🚦 <@${i.user.id}> set **${s}** to **${state.toUpperCase()}**.`);
  await i.reply({ content: `**${s}** is now **${state.toUpperCase()}**.${ok ? '' : ' (Services panel not found, run `/setup services` first.)'}`, flags: EPH });
});

// ---------- /package ----------
add(sc('package').setDescription('Manage Roblox game pass packages')
  .setDefaultMemberPermissions(P.ManageGuild)
  .addSubcommand(s => s.setName('create').setDescription('Post a new package')
    .addStringOption(o => o.setName('name').setDescription('Package name').setRequired(true))
    .addIntegerOption(o => o.setName('price').setDescription('Price in Robux').setRequired(true))
    .addStringOption(o => o.setName('gamepass_id').setDescription('Roblox Game Pass ID').setRequired(true))
    .addStringOption(o => o.setName('contents').setDescription('Items separated by |  (e.g. Bot source | Setup guide)').setRequired(true))
    .addStringOption(o => o.setName('delivery').setDescription('Link/text DMed to buyers after claiming').setRequired(true))
    .addUserOption(o => o.setName('packer').setDescription('Who made it (default: you)'))
    .addRoleOption(o => o.setName('role').setDescription('Role given on claim (optional)'))
    .addChannelOption(o => o.setName('channel').setDescription('Where to post (default: here)').addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s => s.setName('list').setDescription('List packages'))
  .addSubcommand(s => s.setName('delete').setDescription('Delete a package')
    .addIntegerOption(o => o.setName('id').setDescription('Package ID').setRequired(true))),
async i => {
  const sub = i.options.getSubcommand();
  if (sub === 'list') {
    const l = Object.values(db.packages).map(p => `**#${p.id}** ${p.name}: ${p.price} R$ (${p.sales} sales)`).join('\n');
    return i.reply({ content: l || 'No packages yet.', flags: EPH });
  }
  if (sub === 'delete') {
    const id = i.options.getInteger('id'); const p = db.packages[id];
    if (!p) return i.reply({ content: 'No package with that ID.', flags: EPH });
    try { const ch = await i.client.channels.fetch(p.channelId); await (await ch.messages.fetch(p.messageId)).delete(); } catch {}
    delete db.packages[id]; save();
    return i.reply({ content: `Deleted package #${id}.`, flags: EPH });
  }
  const gp = i.options.getString('gamepass_id').replace(/\D/g, '');
  if (!gp) return i.reply({ content: 'Game Pass ID must be numeric.', flags: EPH });
  const id = ++db.counters.package;
  const p = {
    id, name: i.options.getString('name'), price: i.options.getInteger('price'), gamepassId: gp,
    packerId: (i.options.getUser('packer') || i.user).id,
    contents: i.options.getString('contents').split('|').map(x => x.trim()).filter(Boolean),
    delivery: i.options.getString('delivery'), roleId: i.options.getRole('role')?.id || null, sales: 0,
  };
  const ch = i.options.getChannel('channel') || i.channel;
  const m = await ch.send(ui.msg(ui.packagePost(p)));
  p.channelId = ch.id; p.messageId = m.id;
  db.packages[id] = p; save();
  await i.reply({ content: `Package **#${id}** posted in ${ch}.`, flags: EPH });
});

// ---------- /announce ----------
add(sc('announce').setDescription('Post an update/changelog')
  .setDefaultMemberPermissions(P.ManageGuild)
  .addStringOption(o => o.setName('title').setDescription('e.g. update v1.1').setRequired(true))
  .addStringOption(o => o.setName('summary').setDescription('Short summary').setRequired(true))
  .addStringOption(o => o.setName('added').setDescription('Added items separated by |').setRequired(true))
  .addStringOption(o => o.setName('removed').setDescription('Removed items separated by |'))
  .addChannelOption(o => o.setName('channel').setDescription('Default: updates channel').addChannelTypes(ChannelType.GuildText)),
async i => {
  const split = s => (s || '').split('|').map(x => x.trim()).filter(Boolean);
  const ch = i.options.getChannel('channel') || (cfg.channels.updates && await i.client.channels.fetch(cfg.channels.updates).catch(() => null)) || i.channel;
  await ch.send(ui.msg(ui.updatePanel(i.options.getString('title'), i.options.getString('summary'),
    split(i.options.getString('added')), split(i.options.getString('removed')))));
  await i.reply({ content: `Posted in ${ch}.`, flags: EPH });
});

// ---------- ticket commands ----------
add(sc('ticketrename').setDescription('Rename this ticket')
  .addStringOption(o => o.setName('name').setDescription('New channel name').setRequired(true)),
async i => {
  if (!await needTicket(i)) return;
  await i.deferReply({ flags: EPH });
  const n = i.options.getString('name').toLowerCase().replace(/[^a-z0-9-_ ]/g, '').trim().replace(/\s+/g, '-').slice(0, 90);
  if (!n) return i.editReply('Invalid name.');
  await i.channel.setName(n);
  await i.editReply(`Renamed to **${n}**. (Discord limits renames to 2 per 10 minutes.)`);
});

add(sc('ticketadd').setDescription('Add a user to this ticket')
  .addUserOption(o => o.setName('user').setDescription('User to add').setRequired(true)),
async i => {
  if (!await needTicket(i)) return;
  const u = i.options.getUser('user');
  await i.channel.permissionOverwrites.edit(u.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true });
  await i.reply(ui.msg(ui.note(`✅ Added <@${u.id}> to this ticket.`)));
});

add(sc('ticketremove').setDescription('Remove a user from this ticket')
  .addUserOption(o => o.setName('user').setDescription('User to remove').setRequired(true)),
async i => {
  const t = await needTicket(i); if (!t) return;
  const u = i.options.getUser('user');
  if (u.id === t.ownerId) return i.reply({ content: "You can't remove the ticket owner.", flags: EPH });
  await i.channel.permissionOverwrites.delete(u.id);
  await i.reply(ui.msg(ui.note(`✅ Removed <@${u.id}> from this ticket.`)));
});

add(sc('ticketclaim').setDescription('Claim this ticket'), async i => {
  if (!await needTicket(i)) return;
  await i.reply(ui.msg(ui.claimedPanel(i.user.id)));
});

add(sc('close').setDescription('Close this ticket')
  .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
async i => T.startClose(i, i.options.getString('reason')));

add(sc('transcript').setDescription('Generate a transcript of this ticket now'), async i => {
  const t = await needTicket(i); if (!t) return;
  await i.deferReply({ flags: EPH });
  const { AttachmentBuilder } = require('discord.js');
  const txt = await T.buildTranscript(i.channel, t, 'manual transcript', i.user.id);
  await i.editReply({ content: 'Here you go:', files: [new AttachmentBuilder(Buffer.from(txt), { name: `transcript-${i.channel.name}.txt` })] });
});

// ---------- /review (client role only) ----------
async function postReview(client, userId, rating, feedback) {
  db.stats.ratingSum += rating; db.stats.ratingCount++; save();
  const ch = await client.channels.fetch(cfg.channels.reviews);
  await ch.send(ui.msg(ui.reviewPost(userId, rating, feedback)));
}
add(sc('review').setDescription('Leave a review (clients only)')
  .addIntegerOption(o => o.setName('rating').setDescription('1 to 5 stars').setRequired(true).setMinValue(1).setMaxValue(5))
  .addStringOption(o => o.setName('feedback').setDescription('Your feedback').setRequired(true).setMaxLength(800)),
async i => {
  if (cfg.roles.client && !i.member.roles.cache.has(cfg.roles.client))
    return i.reply({ content: 'Only clients can leave reviews.', flags: EPH });
  await postReview(i.client, i.user.id, i.options.getInteger('rating'), i.options.getString('feedback'));
  await i.reply({ content: 'Thanks for your review!', flags: EPH });
});

// ---------- /link (Roblox) ----------
async function linkRoblox(i, username) {
  const r = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
  }).then(x => x.json()).catch(() => null);
  const u = r?.data?.[0];
  if (!u) return i.editReply('Could not find that Roblox user.');

  // 1) that Roblox account may only be linked to ONE Discord user
  const taken = Object.entries(db.links).find(([did, l]) => did !== i.user.id && String(l.robloxId) === String(u.id));
  if (taken) return i.editReply(`**${u.name}** is already linked to another Discord account, so it can't be linked again. If this is your account, open a support ticket.`);

  // 2) nobody else in the server may already be using that name as a nickname
  const want = u.name.toLowerCase();
  const found = await i.guild.members.fetch({ query: u.name, limit: 10 }).catch(() => null);
  const clash = found?.find(m => m.id !== i.user.id && (m.nickname || '').toLowerCase() === want);
  if (clash) return i.editReply(`Someone in this server is already using **${u.name}** as their nickname, so you can't link that account. If it's really yours, open a support ticket.`);

  db.links[i.user.id] = { robloxId: u.id, name: u.name }; save();
  // 3) your server nickname becomes your Roblox username
  const nick = await i.member.setNickname(u.name, 'Linked Roblox account').then(() => true).catch(() => false);
  return i.editReply(`Linked to Roblox account **${u.name}**.${nick ? ' Your server nickname was changed to match.' : " (I couldn't change your nickname, my role may be below yours. Please set it to your Roblox name yourself.)"}`);
}
add(sc('link').setDescription('Link your Roblox account (needed to claim packages)')
  .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
async i => {
  await i.deferReply({ flags: EPH });
  return linkRoblox(i, i.options.getString('username'));
});


// ================= NEW: order helpers =================
const needOrder = async i => {
  const t = await needTicket(i); if (!t) return null;
  const rec = db.tickets[i.channelId];
  if (t.type !== 'order' || !rec) { await i.reply({ content: 'This only works inside an order ticket.', flags: EPH }); return null; }
  return rec;
};

// ---------- /queue ----------
add(sc('queue').setDescription('Order queue')
  .addSubcommand(s => s.setName('view').setDescription('See your position in the order queue'))
  .addSubcommand(s => s.setName('list').setDescription('Staff: list the whole queue'))
  .addSubcommand(s => s.setName('move').setDescription('Staff: move this order to a position')
    .addIntegerOption(o => o.setName('position').setDescription('New position').setRequired(true).setMinValue(1))),
async i => {
  const sub = i.options.getSubcommand();
  if (sub === 'view') {
    const here = T.queuePos(i.channelId);                                       // inside an order ticket (staff can run it there)
    if (here) return i.reply({ content: `This order is **#${here}** of **${db.queue.length}** in the queue.`, flags: EPH });
    const mine = Object.values(db.tickets).filter(t => t.type === 'order' && t.ownerId === i.user.id && T.queuePos(t.id));   // from #commands: all of your orders
    if (!mine.length) return i.reply({ content: 'You have no orders in the queue.', flags: EPH });
    return i.reply({ content: mine.map(t => `<#${t.id}> is **#${T.queuePos(t.id)}** of **${db.queue.length}** in the queue.`).join('\n'), flags: EPH });
  }
  if (!T.isStaff(i.member)) return i.reply({ content: 'Staff only.', flags: EPH });
  if (sub === 'list') {
    const l = db.queue.map((id, n) => `**#${n + 1}** <#${id}> (<@${db.tickets[id]?.ownerId}>), ${cfg.services[db.tickets[id]?.service]?.label || '?'}`).join('\n');
    return i.reply({ content: l || 'The queue is empty.', flags: EPH, allowedMentions: { parse: [] } });
  }
  const rec = await needOrder(i); if (!rec) return;
  const pos = Math.min(i.options.getInteger('position'), db.queue.length);
  T.removeFromQueue(i.channelId);
  db.queue.splice(pos - 1, 0, i.channelId);
  rec.notifiedNext = false; save();
  await i.reply({ content: `Moved to **#${pos}**.`, flags: EPH });
  T.log(i.client, `📋 <@${i.user.id}> moved <#${i.channelId}> to queue position #${pos}.`);
  T.refreshAllQueue(i.client);
});

// ---------- /progress ----------
add(sc('progress').setDescription('Update the order progress')
  .addIntegerOption(o => o.setName('state').setDescription('New state').setRequired(true).addChoices(
    ...ui.STATES.map((n, v) => ({ name: n, value: v })))),
async i => {
  const rec = await needOrder(i); if (!rec) return;
  rec.progress = i.options.getInteger('state'); save();
  await i.reply(ui.msg(ui.progressNotice(rec.progress, i.user.id)));
  T.refreshOrderPanel(i.client, i.channelId);
  T.log(i.client, `📈 <#${i.channelId}> progress set to **${ui.STATES[rec.progress]}** by <@${i.user.id}>.`);
});

// ---------- /quote ----------
add(sc('quote').setDescription('Send the client a price quote (Accept / Decline)')
  .addStringOption(o => o.setName('price').setDescription('e.g. $25 or 4000 R$').setRequired(true).setMaxLength(60))
  .addStringOption(o => o.setName('details').setDescription('What the price includes').setMaxLength(600)),
async i => {
  const rec = await needOrder(i); if (!rec) return;
  const q = { price: i.options.getString('price'), details: i.options.getString('details') || '', status: 'pending' };
  await i.reply(ui.msg(ui.quotePanel(q, 'pending')));
  q.messageId = (await i.fetchReply()).id;
  rec.quote = q; save();
  T.refreshOrderPanel(i.client, i.channelId);
  T.log(i.client, `💰 <@${i.user.id}> sent a quote of **${q.price}** in <#${i.channelId}>.`);
});

// ---------- /deadline ----------
add(sc('deadline').setDescription('Set a due date for this order')
  .addIntegerOption(o => o.setName('days').setDescription('Days from now').setRequired(true).setMinValue(1).setMaxValue(365)),
async i => {
  const rec = await needOrder(i); if (!rec) return;
  rec.due = Date.now() + i.options.getInteger('days') * 86400e3;
  rec.dueSoonSent = false; rec.overdueSent = false; save();
  await i.reply({ content: `Due date set: <t:${Math.floor(rec.due / 1000)}:F>`, flags: EPH });
  T.refreshOrderPanel(i.client, i.channelId);
});

// ---------- /portfolio ----------
const httpsUrl = u => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };
add(sc('portfolio').setDescription('Portfolio showcase')
  .addSubcommand(s => s.setName('add').setDescription('Add a project (staff)')
    .addStringOption(o => o.setName('title').setDescription('Project title').setRequired(true).setMaxLength(80))
    .addStringOption(o => o.setName('category').setDescription('Category').setRequired(true).addChoices(
      { name: 'Bot Development', value: 'Bot Development' }, { name: 'Discord Development', value: 'Discord Development' }, { name: 'ERLC Development', value: 'ERLC Development' }))
    .addStringOption(o => o.setName('description').setDescription('Short description').setRequired(true).setMaxLength(300))
    .addStringOption(o => o.setName('image').setDescription('Image URL (https)'))
    .addStringOption(o => o.setName('link').setDescription('Project link (https)')))
  .addSubcommand(s => s.setName('remove').setDescription('Remove a project (staff)')
    .addIntegerOption(o => o.setName('id').setDescription('Project ID').setRequired(true)))
  .addSubcommand(s => s.setName('list').setDescription('List projects with IDs (staff)'))
  .addSubcommand(s => s.setName('show').setDescription('Post the showcase panel here (staff)')
    .addStringOption(o => o.setName('category').setDescription('Only this category').addChoices(
      { name: 'Bot Development', value: 'Bot Development' }, { name: 'Discord Development', value: 'Discord Development' }, { name: 'ERLC Development', value: 'ERLC Development' }))),
async i => {
  if (!T.isStaff(i.member)) return i.reply({ content: 'Staff only.', flags: EPH });
  const sub = i.options.getSubcommand();
  if (sub === 'add') {
    const image = i.options.getString('image'), link = i.options.getString('link');
    if ((image && !httpsUrl(image)) || (link && !httpsUrl(link))) return i.reply({ content: 'Image and link must be valid https URLs.', flags: EPH });
    const id = ++db.counters.portfolio;
    db.portfolio.push({ id, title: i.options.getString('title'), category: i.options.getString('category'), description: i.options.getString('description'), image, link });
    save();
    return i.reply({ content: `Added project **#${id}**.`, flags: EPH });
  }
  if (sub === 'remove') {
    const id = i.options.getInteger('id'); const n = db.portfolio.length;
    db.portfolio = db.portfolio.filter(x => x.id !== id); save();
    return i.reply({ content: db.portfolio.length < n ? `Removed #${id}.` : 'No project with that ID.', flags: EPH });
  }
  if (sub === 'list')
    return i.reply({ content: db.portfolio.map(x => `**#${x.id}** ${x.title} (${x.category})`).join('\n') || 'No projects yet.', flags: EPH });
  const cat = i.options.getString('category');
  const items = db.portfolio.filter(x => !cat || x.category === cat);
  if (!items.length) return i.reply({ content: 'No projects to show.', flags: EPH });
  await i.channel.send(ui.msg(ui.portfolioPanel(items, cat)));
  await i.reply({ content: items.length > 8 ? 'Posted (showing the first 8 projects).' : 'Posted.', flags: EPH });
});

// ---------- /blacklist ----------
add(sc('blacklist').setDescription('Block users from tickets and orders')
  .setDefaultMemberPermissions(P.ManageGuild)
  .addSubcommand(s => s.setName('add').setDescription('Blacklist a user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(300)))
  .addSubcommand(s => s.setName('remove').setDescription('Remove a user from the blacklist')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
  .addSubcommand(s => s.setName('list').setDescription('Show the blacklist')),
async i => {
  const sub = i.options.getSubcommand();
  if (sub === 'list') {
    const l = Object.entries(db.blacklist).map(([id, b]) => `<@${id}>: ${b.reason}`).join('\n');
    return i.reply({ content: l || 'Nobody is blacklisted.', flags: EPH, allowedMentions: { parse: [] } });
  }
  const u = i.options.getUser('user');
  if (sub === 'add') {
    db.blacklist[u.id] = { reason: i.options.getString('reason'), by: i.user.id, at: Date.now() }; save();
    T.log(i.client, `⛔ <@${i.user.id}> blacklisted <@${u.id}>: ${db.blacklist[u.id].reason}`);
    return i.reply({ content: `Blacklisted **${u.tag}**.`, flags: EPH });
  }
  delete db.blacklist[u.id]; save();
  T.log(i.client, `✅ <@${i.user.id}> removed <@${u.id}> from the blacklist.`);
  await i.reply({ content: `Removed **${u.tag}** from the blacklist.`, flags: EPH });
});

// ---------- /stats ----------
add(sc('stats').setDescription('Business stats (staff)').setDefaultMemberPermissions(P.ManageGuild), async i => {
  const s = db.stats;
  const avg = s.ratingCount ? (s.ratingSum / s.ratingCount).toFixed(2) : '-';
  const top = Object.entries(s.byStaff).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n], k) => `${k + 1}. <@${id}>: ${n}`).join('\n') || 'No data yet';
  await i.reply(ui.msg(ui.statsPanel([
    `**Orders in queue:** ${db.queue.length}`, `**Orders opened:** ${s.ordersOpened}`, `**Orders closed:** ${s.ordersClosed}`,
    `**Successful orders:** ${s.ordersSuccessful}`, `**Tickets closed:** ${s.ticketsClosed}`,
    `**Average rating:** ${avg} (${s.ratingCount} reviews)`, `\n**Top staff (tickets closed):**\n${top}`,
  ]), { flags: ui.V2 | EPH }));
});

// ---------- /reviews ----------
add(sc('reviews').setDescription('Post the average rating panel here').setDefaultMemberPermissions(P.ManageGuild), async i => {
  const s = db.stats;
  await i.channel.send(ui.msg(ui.reviewsSummary(s.ratingCount ? s.ratingSum / s.ratingCount : 0, s.ratingCount)));
  await i.reply({ content: 'Posted.', flags: EPH });
});

// ================= package helper (used by approvals) =================
async function makePackage(client, d, ch) {
  const id = ++db.counters.package;
  const p = { id, name: d.name, price: d.price, gamepassId: d.gamepassId, packerId: d.submitterId, contents: d.contents,
    delivery: d.delivery, roleId: d.roleId || null, sales: 0 };
  const m = await ch.send(ui.msg(ui.packagePost(p)));
  p.channelId = ch.id; p.messageId = m.id;
  db.packages[id] = p; save();
  return p;
}

// ---------- /submitpackage (packers) ----------
add(sc('submitpackage').setDescription('Submit a package for approval (staff)')
  .addStringOption(o => o.setName('name').setDescription('Package name').setRequired(true))
  .addIntegerOption(o => o.setName('price').setDescription('Price in Robux').setRequired(true))
  .addStringOption(o => o.setName('gamepass_id').setDescription('Roblox Game Pass ID').setRequired(true))
  .addStringOption(o => o.setName('contents').setDescription('Items separated by |').setRequired(true))
  .addStringOption(o => o.setName('delivery').setDescription('Link/text DMed to buyers after claiming').setRequired(true))
  .addRoleOption(o => o.setName('role').setDescription('Role given on claim (optional)')),
async i => {
  if (!T.isStaff(i.member)) return i.reply({ content: 'Staff only.', flags: EPH });
  if (!cfg.channels.packageSubmit) return i.reply({ content: 'PACKAGE_SUBMIT_CHANNEL_ID is not set.', flags: EPH });
  const gp = i.options.getString('gamepass_id').replace(/\D/g, '');
  if (!gp) return i.reply({ content: 'Game Pass ID must be numeric.', flags: EPH });
  const id = ++db.counters.submission;
  const sub = { id, name: i.options.getString('name'), price: i.options.getInteger('price'), gamepassId: gp,
    contents: i.options.getString('contents').split('|').map(x => x.trim()).filter(Boolean),
    delivery: i.options.getString('delivery'), roleId: i.options.getRole('role')?.id || null, submitterId: i.user.id, channelId: i.channelId };
  db.submissions[id] = sub; save();
  await T.sendTo(i.client, cfg.channels.packageSubmit, ui.msg(ui.submissionPanel(sub, 'pending')));
  await i.reply({ content: `Submitted as **#${id}**. You'll get a DM when it's reviewed.`, flags: EPH });
});

// ---------- /livestats (staff posts it, everyone sees it, auto-updates every 20s) ----------
add(sc('livestats').setDescription('Post the live sales stats panel (updates every 20 seconds)')
  .setDefaultMemberPermissions(P.ManageGuild),
async i => {
  db.panels.live = db.panels.live || [];
  const m = await i.channel.send(ui.msg(ui.livePanel()));
  db.panels.live.push({ channelId: i.channel.id, messageId: m.id });
  if (db.panels.live.length > 5) db.panels.live.shift();
  save();
  await i.reply({ content: 'Live stats panel posted. It refreshes every 20 seconds.', flags: EPH });
});

// ---------- /help, /ping ----------
add(sc('help').setDescription('Show all commands'), async i => i.reply(ui.eph(ui.helpPanel())));
add(sc('ping').setDescription('Bot latency'), async i =>
  i.reply({ content: `🏓 Pong! **${Math.round(i.client.ws.ping)}ms**`, flags: EPH }));

// ---------- /myorder (everyone) ----------
add(sc('myorder').setDescription('See your open orders, queue position and progress'), async i => {
  const mine = Object.values(db.tickets).filter(t => t.type === 'order' && t.ownerId === i.user.id);
  if (!mine.length) return i.reply({ content: 'You have no open orders.', flags: EPH });
  const lines = mine.map(t => `<#${t.id}> · ${cfg.services[t.service].label}\nQueue: **#${T.queuePos(t.id)}** of ${db.queue.length} · Progress: **${ui.STATES[t.progress || 0]}**${t.quote ? ` · Quote: ${t.quote.price} (${t.quote.status})` : ''}${t.due ? ` · Due <t:${Math.floor(t.due / 1000)}:R>` : ''}`);
  await i.reply({ content: lines.join('\n\n'), flags: EPH });
});

// ---------- /tickets, /ticketinfo (staff) ----------
add(sc('tickets').setDescription('List all open tickets (staff)'), async i => {
  if (!T.isStaff(i.member)) return i.reply({ content: 'Staff only.', flags: EPH });
  const l = Object.values(db.tickets).map(t => `<#${t.id}> · ${t.type}${t.service ? ` (${t.service})` : ''} · <@${t.ownerId}> · opened <t:${Math.floor(t.openedAt / 1000)}:R>`).join('\n');
  await i.reply({ content: l || 'No open tickets.', flags: EPH, allowedMentions: { parse: [] } });
});
add(sc('ticketinfo').setDescription('Details about this ticket (staff)'), async i => {
  const t = await needTicket(i); if (!t) return;
  const r = db.tickets[i.channelId];
  if (!r) return i.reply({ content: 'No record for this ticket.', flags: EPH });
  await i.reply({ flags: EPH, allowedMentions: { parse: [] }, content:
    `**Opened by:** <@${r.ownerId}>\n**Type:** ${r.type}${r.service ? ` (${r.service})` : ''}\n**Opened:** <t:${Math.floor(r.openedAt / 1000)}:R>` +
    (r.type === 'order' ? `\n**Budget:** ${r.budget}\n**Queue:** #${T.queuePos(r.id)}\n**Progress:** ${ui.STATES[r.progress || 0]}\n**Quote:** ${r.quote ? `${r.quote.price} (${r.quote.status})` : 'none'}\n**Due:** ${r.due ? `<t:${Math.floor(r.due / 1000)}:F>` : 'not set'}${r.delayed ? '\n**Service delayed:** yes' : ''}` : '') });
});

// ---------- /clientinfo, /note (staff) ----------
add(sc('clientinfo').setDescription('Info about a client (staff)')
  .addUserOption(o => o.setName('user').setDescription('Client').setRequired(true)),
async i => {
  if (!T.isStaff(i.member)) return i.reply({ content: 'Staff only.', flags: EPH });
  const u = i.options.getUser('user'); const c = db.clients[u.id] || { orders: 0, successful: 0 };
  const link = db.links[u.id]; const bl = db.blacklist[u.id];
  await i.reply({ flags: EPH, allowedMentions: { parse: [] }, content:
    `**Client:** <@${u.id}>\n**Orders placed:** ${c.orders}\n**Successful orders:** ${c.successful}\n**Roblox:** ${link ? link.name : 'not linked'}\n**Blacklisted:** ${bl ? `yes (${bl.reason})` : 'no'}\n**Staff notes:** ${(db.notes[u.id] || []).length}` });
});
add(sc('note').setDescription('Private staff notes on a user')
  .addSubcommand(s => s.setName('add').setDescription('Add a note')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('text').setDescription('Note').setRequired(true).setMaxLength(500)))
  .addSubcommand(s => s.setName('view').setDescription('View notes')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))),
async i => { // who may use it is decided by NOTE_ROLE_IDS in .env (see perms.js)
  const u = i.options.getUser('user');
  if (i.options.getSubcommand() === 'add') {
    const text = i.options.getString('text');
    (db.notes[u.id] = db.notes[u.id] || []).push({ by: i.user.id, text, at: Date.now() }); save();
    await require('./modlog').record(i.client, { action: 'note', modId: i.user.id, user: u, reason: text });
    return i.reply({ content: 'Note added.', flags: EPH });
  }
  const n = (db.notes[u.id] || []).map((x, k) => `**${k + 1}.** ${x.text} (by <@${x.by}>, <t:${Math.floor(x.at / 1000)}:d>)`).join('\n');
  await i.reply({ content: n || 'No notes for this user.', flags: EPH, allowedMentions: { parse: [] } });
});

// ---------- /say (admin) ----------
add(sc('say').setDescription('Post a message as the bot').setDefaultMemberPermissions(P.ManageGuild)
  .addStringOption(o => o.setName('text').setDescription('Message').setRequired(true).setMaxLength(1800))
  .addChannelOption(o => o.setName('channel').setDescription('Default: here').addChannelTypes(ChannelType.GuildText)),
async i => {
  const ch = i.options.getChannel('channel') || i.channel;
  await ch.send(ui.msg(ui.note(i.options.getString('text'))));
  await i.reply({ content: 'Sent.', flags: EPH });
});

module.exports = { defs, handlers, postReview, makePackage, add, sc, needTicket, linkRoblox };
