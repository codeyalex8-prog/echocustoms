const { ChannelType, PermissionFlagsBits: P, AttachmentBuilder, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { db, save, svcState } = require('./db');
const ui = require('./ui');

const pending = new Map(); // channelId -> { reason, by }
const HOUR = 3600e3;

// topic format: ticket:<ownerId>:<type>:<service|->
function parseTopic(ch) {
  const t = ch?.topic;
  if (!t || !t.startsWith('ticket:')) return null;
  const [, ownerId, type, service] = t.split(':');
  return { ownerId, type, service: service === '-' ? null : service };
}
function isStaff(member) {
  if (!member) return false;
  return (cfg.roles.staff && member.roles.cache.has(cfg.roles.staff)) || member.permissions.has(P.ManageGuild);
}
const uniq = a => [...new Set(a.filter(Boolean))];
const isBlacklisted = id => db.blacklist[id] || null;

async function sendTo(client, id, payload) {
  if (!id) return;
  const ch = await client.channels.fetch(id).catch(() => null);
  await ch?.send(payload).catch(() => {});
}
const log = (client, s) => sendTo(client, cfg.channels.moderations, ui.msg(ui.note(s)));        // #moderations
const saleLog = (client, s) => sendTo(client, cfg.channels.saleLogs, ui.msg(ui.note(s)));        // #sale-logs

async function refreshLive(client) {
  for (const p of [...(db.panels.live || [])]) {
    try {
      const ch = await client.channels.fetch(p.channelId);
      await ch.messages.edit(p.messageId, { components: [ui.livePanel()], flags: ui.V2, allowedMentions: ui.NO_PING });
    } catch (e) {
      if (e.code === 10008 || e.code === 10003) { db.panels.live = db.panels.live.filter(x => x !== p); save(); }
    }
  }
}

async function refreshServicesPanel(client) {
  const p = db.panels.services;
  if (!p) return false;
  try {
    const ch = await client.channels.fetch(p.channelId);
    const m = await ch.messages.fetch(p.messageId);
    await m.edit({ components: [ui.servicesPanel()], flags: ui.V2, allowedMentions: ui.NO_PING });
    return true;
  } catch { return false; }
}

// ---------------- queue + order panel ----------------
const queuePos = id => db.queue.indexOf(id) + 1;

async function refreshOrderPanel(client, chId) {
  const rec = db.tickets[chId];
  if (!rec || rec.type !== 'order') return;
  try {
    const ch = await client.channels.fetch(chId);
    const m = await ch.messages.fetch(rec.panelId);
    await m.edit({
      components: [ui.orderTicketPanel(rec.ownerId, rec.roles, cfg.services[rec.service], { ...rec, pos: queuePos(chId) })],
      flags: ui.V2, allowedMentions: ui.NO_PING,
    });
  } catch {}
}
async function refreshAllQueue(client) {
  for (const id of [...db.queue]) {
    await refreshOrderPanel(client, id);
    const rec = db.tickets[id];
    if (rec && queuePos(id) === 1 && !rec.notifiedNext) {
      rec.notifiedNext = true; save();
      const u = await client.users.fetch(rec.ownerId).catch(() => null);
      await u?.send(ui.msg(ui.note(`${'📬'} Good news! Your order is **next in the queue** at **${cfg.brand}**.`))).catch(() => {});
    }
  }
}
function removeFromQueue(id) { const i = db.queue.indexOf(id); if (i >= 0) db.queue.splice(i, 1); save(); }

// ---------------- create ----------------
async function createTicket(interaction, { type, service, budget, text }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { guild, user } = interaction;
  const bl = isBlacklisted(user.id);
  if (bl) return interaction.editReply(`You are blacklisted from opening tickets and orders.\n**Reason:** ${bl.reason}`);
  const isOrder = type === 'order';
  const svc = isOrder ? cfg.services[service] : null;
  if (isOrder && svcState(service) === 'closed')
    return interaction.editReply('Sorry, that service is currently **closed**. No orders can be placed for it right now.');

  const n = ++db.counters[isOrder ? 'order' : 'support'];
  save();
  const num = String(n).padStart(4, '0');
  const name = isOrder ? `${service}-order-${num}` : `support-${num}`;
  const parent = (isOrder ? svc.category : cfg.categories.support) || undefined;

  const allow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.SendMessagesInThreads];
  const overwrites = [
    { id: guild.id, deny: [P.ViewChannel] },
    { id: user.id, allow },
    { id: guild.members.me.id, allow: [...allow, P.ManageChannels, P.ManageMessages, P.ManageThreads, P.CreatePublicThreads] },
  ];
  if (cfg.roles.staff) overwrites.push({ id: cfg.roles.staff, allow: [...allow, P.ManageMessages] });

  const channel = await guild.channels.create({
    name, type: ChannelType.GuildText, parent,
    topic: `ticket:${user.id}:${type}:${service || '-'}`,
    permissionOverwrites: overwrites,
  });

  const roles = uniq(isOrder ? [svc.ping, cfg.pings.order] : [cfg.pings.support]);
  const rec = { id: channel.id, ownerId: user.id, type, service: service || null, budget: budget || null, desc: text, roles,
    progress: 0, quote: null, due: null, openedAt: Date.now(), delayed: isOrder && svcState(service) === 'delayed' };
  db.clients[user.id] = db.clients[user.id] || { orders: 0, successful: 0 };
  if (isOrder) db.clients[user.id].orders++;

  if (isOrder) { db.queue.push(channel.id); db.stats.ordersOpened++; }
  const panel = isOrder
    ? ui.orderTicketPanel(user.id, roles, svc, { ...rec, pos: queuePos(channel.id) })
    : ui.supportTicketPanel(user.id, roles, text, false);
  const sent = await channel.send({ components: [panel], flags: ui.V2, allowedMentions: { roles, users: [user.id] } });
  rec.panelId = sent.id;
  db.tickets[channel.id] = rec; save();

  if (isOrder) {
    const thread = await channel.threads.create({
      name: 'references', type: ChannelType.PublicThread, autoArchiveDuration: 10080, reason: 'Order references',
    });
    await thread.members.add(user.id).catch(() => {});
    await thread.send({ components: [ui.referencesPanel(user.id, text)], flags: ui.V2, allowedMentions: { users: [user.id] } });
  }
  await interaction.editReply(`Your ${isOrder ? 'order' : 'ticket'} has been opened: ${channel}${isOrder ? `\nYour queue position: **#${queuePos(channel.id)}**` : ''}`);
  log(interaction.client, `🎫 **${name}** opened by <@${user.id}> (${isOrder ? svc.label : 'support'}).`);
}

// ---------------- close ----------------
async function startClose(interaction, reason) {
  const ch = interaction.channel;
  const t = parseTopic(ch);
  if (!t) return interaction.reply({ content: 'This is not a ticket channel.', flags: MessageFlags.Ephemeral });
  const staff = isStaff(interaction.member);
  if ((t.type === 'order' || t.type === 'market') && !staff) return interaction.reply({ content: `Only staff can close ${t.type} tickets.`, flags: MessageFlags.Ephemeral });
  if (!staff && interaction.user.id !== t.ownerId) return interaction.reply({ content: 'You cannot close this ticket.', flags: MessageFlags.Ephemeral });

  if (t.type === 'order') {
    pending.set(ch.id, { reason, by: interaction.user.id });
    return interaction.reply(ui.eph(ui.closeConfirm()));
  }
  await interaction.reply({ content: 'Closing ticket...', flags: MessageFlags.Ephemeral });
  await finalizeClose(interaction.client, ch, t, reason, interaction.user.id, null, interaction);
}

async function fetchAll(ch, cap = 2000) {
  const out = [];
  let before;
  while (out.length < cap) {
    const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || !batch.size) break;
    out.push(...batch.values());
    before = batch.last().id;
  }
  return out.reverse();
}
function extractText(comps, out = []) {
  for (const c of comps || []) {
    if (typeof c.content === 'string') out.push(c.content);
    if (c.components) extractText(c.components, out);
    if (c.accessory?.label) out.push(`[button: ${c.accessory.label}]`);
  }
  return out;
}
function formatMsgs(msgs) {
  return msgs.map(m => {
    let line = `[${m.createdAt.toISOString()}] ${m.author.tag} (${m.author.id}): ${m.content || ''}`;
    const extra = extractText(m.components);
    if (extra.length) line += '\n    ' + extra.join('\n').replace(/\n/g, '\n    ');
    for (const a of m.attachments.values()) line += `\n    [attachment] ${a.name}: ${a.url}`;
    return line;
  }).join('\n');
}
async function buildTranscript(ch, t, reason, closedBy) {
  const head = `Transcript for #${ch.name}\nType: ${t.type}${t.service ? ` (${t.service})` : ''}\nOpened by: ${t.ownerId}\nClosed by: ${closedBy}\nReason: ${reason}\nGenerated: ${new Date().toISOString()}\n${'='.repeat(50)}\n\n`;
  let body = formatMsgs(await fetchAll(ch));
  for (const th of ch.threads.cache.values()) body += `\n\n----- THREAD: ${th.name} -----\n` + formatMsgs(await fetchAll(th));
  return head + body;
}

async function finalizeClose(client, ch, t, reason, closedBy, success, interaction) {
  const isOrder = t.type === 'order';
  const fname = `transcript-${ch.name}.txt`;
  let transcript = await buildTranscript(ch, t, reason, closedBy);
  const file = () => new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: fname });
  const label = cfg.services[t.service]?.label || (t.type === 'market' ? 'Market purchase' : t.type);

  // queue + stats
  removeFromQueue(ch.id);
  const recSnap = db.tickets[ch.id];
  delete db.tickets[ch.id];
  db.stats.ticketsClosed++;
  if (isOrder) { db.stats.ordersClosed++; if (success) db.stats.ordersSuccessful++; }
  if (closedBy !== client.user.id) db.stats.byStaff[closedBy] = (db.stats.byStaff[closedBy] || 0) + 1;
  save();
  // ticket summary goes at the very bottom of the transcript file (and under the transcript log message)
  let sumMd = '';
  try { const S = await require('./aitools').summarize(ch, t, recSnap, reason, transcript, t.type); transcript += `\n\n${'='.repeat(50)}\n${S.text}\n`; sumMd = S.md; } catch (e) { console.error('ticket summary', e); }

  if (cfg.channels.transcripts) {
    const lc = await client.channels.fetch(cfg.channels.transcripts).catch(() => null);
    await lc?.send({
      components: [ui.transcriptLog({ ticketName: ch.name, type: label, ownerId: t.ownerId, closedBy, reason, fname, success, summary: sumMd })],
      files: [file()], flags: ui.V2, allowedMentions: ui.NO_PING,
    }).catch(e => console.error('transcript log failed', e.message));
  }

  let dmOk = true;
  const owner = await client.users.fetch(t.ownerId).catch(() => null);
  if (owner) {
    await owner.send({
      components: [ui.ticketClosedDM({ type: label, closedBy, reason, fname, isOrder }, ch.name)],
      files: [file()], flags: ui.V2, allowedMentions: ui.NO_PING,
    }).catch(() => { dmOk = false; });
  } else dmOk = false;

  if (isOrder && success) {
    db.clients[t.ownerId] = db.clients[t.ownerId] || { orders: 0, successful: 0 };
    db.clients[t.ownerId].successful++; save();
    saleLog(client, `💵 **Order completed:** ${label} for <@${t.ownerId}> (${ch.name}), closed by <@${closedBy}>.`);
    if (cfg.channels.success) {
      const sc = await client.channels.fetch(cfg.channels.success).catch(() => null);
      await sc?.send(ui.msg(ui.thanksPurchase(t.ownerId, label)));
    }
    if (cfg.roles.client) {
      const m = await ch.guild.members.fetch(t.ownerId).catch(() => null);
      await m?.roles.add(cfg.roles.client).catch(() => {});
    }
  }
  if (interaction && !dmOk) {
    await interaction.followUp({
      content: "I couldn't DM the transcript (their DMs are off). They can use `/review` manually once they have the client role.",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
  log(client, `🔒 **${ch.name}** closed by <@${closedBy}>. Reason: ${reason}${isOrder ? ` | Successful: ${success ? 'yes' : 'no'}` : ''}`);
  refreshAllQueue(client);
  await ch.send(ui.msg(ui.note('🔒 This ticket is being closed and will be deleted in 5 seconds.'))).catch(() => {});
  setTimeout(() => ch.delete('Ticket closed').catch(() => {}), 5000);
}

// ---------------- background sweep: idle support tickets + order deadlines ----------------
async function sweep(client) {
  const now = Date.now();
  for (const [id, rec] of Object.entries(db.tickets)) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch) { removeFromQueue(id); delete db.tickets[id]; save(); continue; }

    if (rec.type === 'support') {
      const last = (await ch.messages.fetch({ limit: 1 }).catch(() => null))?.first();
      if (!last) continue;
      if (rec.warnMsgId && last.id === rec.warnMsgId) {
        if (now - rec.warnedAt > 24 * HOUR)
          await finalizeClose(client, ch, parseTopic(ch) || rec, 'Closed for inactivity', client.user.id, null, null);
      } else {
        rec.warnMsgId = null;
        if (now - last.createdTimestamp > 48 * HOUR) {
          const w = await ch.send({ content: `<@${rec.ownerId}> this ticket has been inactive for 48 hours and will close in 24 hours unless you reply.`, allowedMentions: { users: [rec.ownerId] } });
          rec.warnMsgId = w.id; rec.warnedAt = now; save();
        }
      }
    } else if (rec.due) {
      const ping = { roles: rec.roles };
      if (rec.due < now && !rec.overdueSent) {
        rec.overdueSent = true; save();
        await ch.send({ content: `⚠️ ${rec.roles.map(r => `<@&${r}>`).join(' ')} this order is **overdue**.`, allowedMentions: ping });
      } else if (rec.due - now < 24 * HOUR && rec.due > now && !rec.dueSoonSent) {
        rec.dueSoonSent = true; save();
        await ch.send({ content: `⏰ ${rec.roles.map(r => `<@&${r}>`).join(' ')} this order is due <t:${Math.floor(rec.due / 1000)}:R>.`, allowedMentions: ping });
      }
    }
  }
}

module.exports = {
  pending, parseTopic, isStaff, isBlacklisted, log, createTicket, startClose, finalizeClose, buildTranscript,
  refreshServicesPanel, refreshOrderPanel, refreshLive, saleLog, sendTo, refreshAllQueue, removeFromQueue, queuePos, sweep,
};
