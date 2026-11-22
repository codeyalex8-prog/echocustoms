require('./sysinfo');                          // keeps the last errors for the owner panel (must load first)
const {
  Client, GatewayIntentBits, Partials, ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, MessageFlags, ChannelType,
} = require('discord.js');
const cfg = require('./config');
const { db, save, svcState } = require('./db');
const ui = require('./ui');
const T = require('./tickets');
const { defs, handlers, postReview, makePackage } = require('./commands');
const C2 = require('./commands2');
const R = require('./roles');
const S = require('./server');
const EM = require('./emojis');
EM.install();                                  // every message the bot sends only ever shows YOUR white emojis (see emojis.js)
const PERMS = require('./perms');
require('./modcmds');                         // warn / kick / ban (proof) / timeout / history ...
const AUTO = require('./automod');            // links + swear strikes + spam
const SEC = require('./security');            // -setupsecurity, jail / unjail, Prisoner role, appeal tickets
const RAID = require('./antiraid');           // anti-raid: mass delete / ban / kick, admin role grants, Prisoner role protection
const SI = require('./staffinfo');            // Staff Information panel
const M = require('./market');                // /market post: marketplace panel, dropdown, claim purchase, queue, merch, TOS
const SM = require('./smartmod');             // smart auto-mod: AI + image scan + impersonation guard (hooked into automod.js)
const DG = require('./digest');               // weekly AI server digest
const PR = require('./presence');             // bot status / activity / profile (owner panel)
const STICKY = require('./sticky');           // /sticker: message that stays at the bottom of a channel
const PFX = require('./prefix');              // -commands
require('./attach');
require('./extras');                         // /emojis (owner)
const O = require('./owner');

const EPH = MessageFlags.Ephemeral;
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildModeration],
  partials: [Partials.Channel, Partials.Message],
});

const input = (id, label, style, extra = {}) => new ActionRowBuilder().addComponents(
  new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(true).setMaxLength(extra.max || 1000)
    .setPlaceholder(extra.ph || ''));
const modal = (id, title, ...rows) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...rows);

if (!cfg.token || !cfg.guildId) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const g = await client.guilds.fetch(cfg.guildId);
  if (!cfg.ownerIds.length) console.error('!! OWNER_ID is empty or not a number in .env: owner-only commands (/immune, /ownerpanel, /setupsecurity ...) will NOT work.');
  else console.log(`Owner(s): ${cfg.ownerIds.join(', ')}`);
  const lost = await EM.resolve(client, cfg.guildId);
  console.log(lost.length
    ? `Emojis not found in your server (those spots show no emoji until the name matches, run /emojis to see the names I looked for): ${lost.join(', ')}\nEmoji names I can see: ${EM.report().seen.join(', ') || '(none)'}`
    : 'All white emojis found.');
  for (const ev of ['emojiCreate', 'emojiUpdate', 'emojiDelete']) client.on(ev, () => EM.resolve(client, cfg.guildId).catch(() => {}));
  await g.commands.set(defs.map(d => PERMS.registrationJSON(d)));
  PFX.build(defs, handlers);
  console.log(`Registered ${defs.length} commands. Prefix commands use "${cfg.prefix}".`);
  M.refresh(client).catch(() => {});          // re-draw the marketplace panel (picks up edits to market.items.js)
  RAID.warm(client).catch(e => console.error('raid warm', e));
  PR.apply(client, true).catch(e => console.error('presence', e));           // restore the saved status + activity
  SM.warm(client).catch(e => console.error('smartmod warm', e));
  setInterval(() => PR.tick(client).catch(e => console.error('presence tick', e)), 15 * 1000);
  setInterval(() => DG.tick(client).catch(e => console.error('digest tick', e)), 60 * 1000);
  setInterval(() => SEC.tick(client).catch(e => console.error('security tick', e)), 5 * 60 * 1000);
  setInterval(() => AUTO.tick(client).catch(e => console.error('automod tick', e)), 60 * 1000);
  setInterval(() => C2.tick(client).catch(e => console.error('tick2', e)), 20 * 1000);
  setInterval(() => O.tick(client).catch(e => console.error('owner', e)), 60 * 1000);
  setInterval(() => T.refreshLive(client).catch(e => console.error('live', e)), 20 * 1000);
  setInterval(() => M.tick(client).catch(e => console.error('market tick', e)), 30 * 1000);   // auto-detect marketplace purchases
  setInterval(() => T.sweep(client).catch(e => console.error('sweep', e)), 30 * 60 * 1000);
});

// ---------- welcome ----------
client.on('guildMemberAdd', async member => {
  DG.onJoin(member);
  SM.onJoin(member);
  SEC.onJoin(member).catch(() => {});
  R.onJoin(member).catch(() => {});
  if (!cfg.channels.welcome) return;
  const ch = await client.channels.fetch(cfg.channels.welcome).catch(() => null);
  await ch?.send({ components: [ui.welcomePanel(member)], flags: ui.V2, allowedMentions: { users: [member.id] } });
});

client.on('guildMemberRemove', () => { try { DG.onLeave(); } catch {} });
client.on('guildMemberUpdate', (o, n) => { SM.onMemberUpdate(o, n).catch(() => {}); });
client.on('userUpdate', (o, n) => { SM.onUserUpdate(o, n, client).catch(() => {}); });

// ---------- safe links / files in the order "references" threads ----------
const BAD_EXT = /\.(exe|scr|bat|cmd|com|msi|jar|vbs|ps1|apk|dll|lnk|js|hta|reg)$/i;
function linkIsSafe(raw) {
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    if (u.protocol !== 'https:') return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.includes('xn--')) return false;
    return cfg.safeDomains.some(d => u.hostname === d || u.hostname.endsWith(`.${d}`));
  } catch { return false; }
}
// ---------- auto-moderation + prefix commands + security ----------
client.on('messageCreate', async m => {
  try {
    if (await AUTO.onMessage(client, m)) return;     // deleted/punished -> stop here
    await PFX.onMessage(client, m);
  } catch (e) { console.error('message hook', e); }
});
client.on('messageCreate', m => { try { STICKY.onMessage(client, m); } catch (e) { console.error('sticky hook', e); } });
client.on('messageUpdate', async (_old, m) => {
  try { if (m.partial) m = await m.fetch(); await AUTO.onMessage(client, m); } catch {}
});
client.on('channelCreate', ch => { RAID.snap(ch); SEC.onChannel(ch).catch(() => {}); });
client.on('channelUpdate', (_o, ch) => { RAID.snap(ch); SEC.onChannel(ch).catch(() => {}); });
// anti-raid listens to Discord's audit log (needs the bot to have View Audit Log, Administrator is easiest)
client.on('guildAuditLogEntryCreate', (entry, guild) => RAID.onAudit(client, entry, guild).catch(e => console.error('anti-raid', e)));

client.on('messageCreate', async m => {
  if (m.author.bot || !m.guild || !m.channel.isThread() || m.channel.name !== 'references') return;
  if (!T.parseTopic(m.channel.parent)) return;
  if (T.isStaff(m.member)) return;
  const links = m.content.match(/(?:https?:\/\/|www\.)[^\s<>)]+/gi) || [];
  const badLink = links.find(l => !linkIsSafe(l));
  const badFile = [...m.attachments.values()].find(a => BAD_EXT.test(a.name || ''));
  if (badLink || badFile) {
    await m.delete().catch(() => {});
    const w = await m.channel.send({ content: `<@${m.author.id}> that ${badFile ? 'file type' : 'link'} isn't allowed here for safety. Use images or links from trusted sites (Imgur, Discord, Roblox, YouTube, Pinterest, etc.).`, allowedMentions: { users: [m.author.id] } });
    setTimeout(() => w.delete().catch(() => {}), 8000);
  }
});

// ---------- interactions ----------
client.on('interactionCreate', async i => {
  try {
    if (db.maintenance?.on && !cfg.isOwner(i.user.id) && !i.isAutocomplete?.())          // owner panel: maintenance mode
      return await i.reply({ content: `🔧 **${cfg.brand} bot is in maintenance mode.** Please try again later.`, flags: EPH });
    if (i.isChatInputCommand()) { if (!(await PERMS.guard(i))) return; return await handlers[i.commandName]?.(i); }
    if (i.isButton()) return await onButton(i);
    if (i.isStringSelectMenu()) return await onSelect(i);
    if (i.isModalSubmit()) return await onModal(i);
  } catch (err) {
    console.error(err);
    const r = { content: 'Something went wrong. Please try again or contact staff.', flags: EPH };
    if (i.deferred || i.replied) i.followUp(r).catch(() => {}); else i.reply(r).catch(() => {});
  }
});

const blocked = async i => {
  const b = T.isBlacklisted(i.user.id);
  if (b) { await i.reply({ content: `You are blacklisted from opening tickets and orders.\n**Reason:** ${b.reason}`, flags: EPH }); return true; }
  return false;
};

async function onSelect(i) {
  if (await O.onSelect(i)) return;
  if (await SI.onSelect(i)) return;
  if (await C2.onSelect(i)) return;
  if (await M.onSelect(i)) return;
  if (i.customId === 'dash_select') return i.reply(ui.eph(ui.guidelinesMessage()));
  if (i.customId === 'order_select') {
    if (await blocked(i)) return;
    const key = i.values[0];
    if (svcState(key) === 'closed') return i.reply({ content: 'That service is **closed** right now. No orders can be placed.', flags: EPH });
    return i.showModal(modal(`order_modal:${key}`, 'Place an order',
      input('budget', 'What is your budget?', TextInputStyle.Short, { ph: 'e.g. 1500 R$ / $20', max: 100 }),
      input('desc', 'Commission Description', TextInputStyle.Paragraph, { ph: 'Describe what you want made.', max: 1500 })));
  }
}

async function onButton(i) {
  if (await SM.onButton(i)) return;
  if (await SEC.onButton(i)) return;
  if (await O.onButton(i)) return;
  if (await S.onButton(i)) return;
  if (await C2.onButton(i)) return;
  if (await M.onButton(i)) return;
  const [id, arg] = i.customId.split(':');
  switch (id) {
    case 'ticket_support':
      if (await blocked(i)) return;
      return i.showModal(modal('support_modal', 'Open a ticket', input('inquiry', 'Inquiry', TextInputStyle.Paragraph, { ph: 'What do you need help with?', max: 800 })));

    case 'order_begin': {
      if (await blocked(i)) return;
      const sel = ui.orderSelect();
      if (!sel) return i.reply({ content: '🔴 **CLOSED**: orders are currently closed. No one can place an order right now.', flags: EPH });
      return i.reply({ content: 'What would you like to order?', components: [sel], flags: EPH });
    }

    case 'ticket_close': {
      const t = T.parseTopic(i.channel);
      if (!t) return;
      if (!T.isStaff(i.member) && !(t.type === 'support' && i.user.id === t.ownerId))
        return i.reply({ content: 'You cannot close this ticket.', flags: EPH });
      return i.showModal(modal('close_modal', 'Close ticket', input('reason', 'Reason', TextInputStyle.Short, { ph: 'Why is this ticket being closed?', max: 300 })));
    }

    case 'close_yes':
    case 'close_no': {
      const p = T.pending.get(i.channelId);
      if (!p) return i.update({ content: 'This close request expired.', components: [] });
      if (i.user.id !== p.by) return i.reply({ content: 'Only the staff member closing can answer this.', flags: EPH });
      T.pending.delete(i.channelId);
      await i.update(ui.eph(ui.note(`Closing ticket... Order marked **${id === 'close_yes' ? 'successful' : 'unsuccessful'}**.`)));
      return T.finalizeClose(i.client, i.channel, T.parseTopic(i.channel), p.reason, i.user.id, id === 'close_yes', i);
    }

    case 'review_open':
      if (db.reviewed[arg]) return i.reply({ content: 'You already reviewed this order. Thank you!', flags: EPH });
      return i.showModal(modal(`review_modal:${arg}`, 'Leave a review',
        input('rating', 'Rating (1-5)', TextInputStyle.Short, { ph: '5', max: 1 }),
        input('feedback', 'Feedback', TextInputStyle.Paragraph, { ph: 'How was your experience?', max: 800 })));

    case 'quote_accept':
    case 'quote_decline': {
      const rec = db.tickets[i.channelId];
      if (!rec?.quote) return i.reply({ content: 'This quote is no longer active.', flags: EPH });
      if (i.user.id !== rec.ownerId) return i.reply({ content: 'Only the client can respond to this quote.', flags: EPH });
      rec.quote.status = id === 'quote_accept' ? 'accepted' : 'declined'; save();
      await i.update({ components: [ui.quotePanel(rec.quote, rec.quote.status)], flags: ui.V2, allowedMentions: ui.NO_PING });
      T.refreshOrderPanel(i.client, i.channelId);
      T.log(i.client, `${id === 'quote_accept' ? '✅' : '❌'} <@${i.user.id}> ${rec.quote.status} the quote (${rec.quote.price}) in <#${i.channelId}>.`);
      return i.followUp({ content: `Quote **${rec.quote.status}**. Staff have been notified.`, flags: EPH });
    }

    case 'sub_approve':
    case 'sub_reject': {
      if (!i.memberPermissions.has('ManageGuild')) return i.reply({ content: 'Only admins can review submissions.', flags: EPH });
      const sub = db.submissions[arg];
      if (!sub) return i.reply({ content: 'This submission no longer exists.', flags: EPH });
      const ok = id === 'sub_approve';
      if (ok) {
        const target = (sub.channelId && await client.channels.fetch(sub.channelId).catch(() => null)) || i.channel;
        const pkg = await makePackage(client, sub, target);
        T.sendTo(client, cfg.channels.moderations, ui.msg(ui.note(`📦 <@${i.user.id}> approved package **${pkg.name}** (#${pkg.id}) by <@${sub.submitterId}>.`)));
      }
      delete db.submissions[arg]; save();
      await i.update({ components: [ui.submissionPanel(sub, ok ? 'approved' : 'rejected')], flags: ui.V2, allowedMentions: ui.NO_PING });
      const u = await client.users.fetch(sub.submitterId).catch(() => null);
      return void u?.send(`Your package **${sub.name}** was ${ok ? 'approved and posted' : 'rejected'}.`).catch(() => {});
    }

    case 'pkg_buy': return pkgBuy(i, arg);
    case 'pkg_claim': return pkgClaim(i, arg);
  }
}

async function onModal(i) {
  if (await O.onModal(i)) return;
  if (await M.onModal(i)) return;
  const [id, arg] = i.customId.split(':');
  if (id === 'support_modal')
    return T.createTicket(i, { type: 'support', text: i.fields.getTextInputValue('inquiry') });
  if (id === 'order_modal')
    return T.createTicket(i, { type: 'order', service: arg, budget: i.fields.getTextInputValue('budget'), text: i.fields.getTextInputValue('desc') });
  if (id === 'close_modal')
    return T.startClose(i, i.fields.getTextInputValue('reason'));
  if (id === 'review_modal') {
    const rating = parseInt(i.fields.getTextInputValue('rating'), 10);
    if (!(rating >= 1 && rating <= 5)) return i.reply({ content: 'Rating must be a number from 1 to 5.', flags: EPH });
    if (db.reviewed[arg]) return i.reply({ content: 'You already reviewed this order.', flags: EPH });
    db.reviewed[arg] = true; save();
    await postReview(i.client, i.user.id, rating, i.fields.getTextInputValue('feedback'));
    return i.reply({ content: 'Thank you for your review! ⭐', flags: EPH });
  }
}

// ---------- packages ----------
async function pkgBuy(i, id) {
  const p = db.packages[id];
  if (!p) return i.reply({ content: 'This package no longer exists.', flags: EPH });
  if (!db.links[i.user.id]) return i.reply({ content: 'Link your Roblox account first with `/link`.', flags: EPH });
  db.clicks[`${i.user.id}:${id}`] = Date.now(); save();
  return i.reply(ui.eph(ui.paymentPanel(p)));
}
async function ownsPass(robloxId, passId) {
  const r = await fetch(`https://inventory.roblox.com/v1/users/${robloxId}/items/GamePass/${passId}/is-owned`).catch(() => null);
  if (!r || !r.ok) return null; // private inventory / error
  return (await r.text()).trim() === 'true';
}
async function pkgClaim(i, id) {
  const p = db.packages[id];
  if (!p) return i.reply({ content: 'This package no longer exists.', flags: EPH });
  if (!db.clicks[`${i.user.id}:${id}`]) return i.reply({ content: 'Click **Purchase** first so I know when to begin checking for your payment.', flags: EPH });
  const link = db.links[i.user.id];
  if (!link) return i.reply({ content: 'Link your Roblox account first with `/link`.', flags: EPH });
  await i.deferReply({ flags: EPH });
  const owns = await ownsPass(link.robloxId, p.gamepassId);
  if (!owns) {
    return i.editReply(`I could not find a new **${p.name}** purchase by **${link.name}** after you clicked Purchase. Roblox sales can take a minute to appear.\n\nIf you already paid, make sure your Roblox inventory is public:\n**Settings ➜ Privacy ➜ Inventory visibility ➜ Everyone**, then wait a minute and try again.`);
  }
  if (db.claimed?.[`${i.user.id}:${id}`]) return i.editReply('You already claimed this package.');
  db.claimed = db.claimed || {}; db.claimed[`${i.user.id}:${id}`] = true;
  p.sales++; db.stats.packageSales++; db.stats.robuxEarned += Number(p.price) || 0; save();
  T.saleLog(client, `📦 **Package sold:** ${p.name} (${p.price} R$) to <@${i.user.id}> (Roblox: ${link.name}). Total sales: ${p.sales}.`);
  if (p.roleId) await i.member.roles.add(p.roleId).catch(() => {});
  const dm = await i.user.send(`**${p.name}** — thanks for your purchase!\n${p.delivery}`).then(() => true).catch(() => false);
  await i.editReply(dm ? 'Package claimed! Check your DMs.' : `Package claimed! (Your DMs are off, so here it is)\n${p.delivery}`);
  try { // update total sales on the post
    const ch = await client.channels.fetch(p.channelId); const m = await ch.messages.fetch(p.messageId);
    await m.edit({ components: [ui.packagePost(p)], flags: ui.V2, allowedMentions: ui.NO_PING });
  } catch {}
  const tc = cfg.channels.purchases || cfg.channels.success;
  if (tc) (await client.channels.fetch(tc).catch(() => null))?.send(ui.msg(ui.thanksPurchase(i.user.id, p.name)));
}

process.on('unhandledRejection', e => console.error('Unhandled:', e));
client.login(cfg.token);
