// ============================================================================
//  MARKETPLACE
//  /market post  (-market post)  posts the marketplace panel (owner only, see perms.js)
//
//  Panel = top image, text, "Browse our market!" dropdown (items come from market.items.js),
//  and three buttons:
//    Claim Purchase    checks the buyer's LINKED Roblox account (/link) for the market game passes,
//                      and if it finds a new one it opens a ticket saying what was claimed
//    View Queue        shows the open purchase tickets in order + your own position
//    Marketplace TOS   shows our own terms (edit TOS_TEXT below)
// ============================================================================
const {
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ContainerBuilder, SectionBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  PermissionFlagsBits: P, MessageFlags,
} = require('discord.js');
const cfg = require('./config');
const { db, save } = require('./db');
const ui = require('./ui');
const T = require('./tickets');
const { add, sc, linkRoblox } = require('./commands');
const { E, tag } = require('./emojis');
const RAW_ITEMS = require('./market.items');

const EPH = MessageFlags.Ephemeral;
const fmt = n => Number(n).toLocaleString('en-US');
const ts = ms => Math.floor(ms / 1000);

// ---------------------------------------------------------------- items + categories
const GROUPS = [
  { id: 'ads',   label: 'Paid Ads',   emoji: E.megaphone, blurb: 'Get your giveaway, ad or channel in front of the whole server.' },
  { id: 'roles', label: 'Roles',      emoji: E.crown,     blurb: 'Stand out with a VIP or custom role.' },
  { id: 'times', label: 'Post Times', emoji: E.schedule,  blurb: 'Choose how fast your post goes live. These stack with any ad.' },
];
const TIER_RANK = { instant: 0, priority: 1 };
const TIER_NAME = { instant: 'Instant', priority: 'Priority' };

const validPass = v => { const s = String(v ?? '').replace(/\D/g, ''); return s && s !== '0' ? s : ''; };
function items() {
  const seen = new Set();
  return (Array.isArray(RAW_ITEMS) ? RAW_ITEMS : [])
    .filter(it => it && it.id && it.label && !seen.has(String(it.id)) && seen.add(String(it.id)))
    .slice(0, 25)
    .map(it => ({ ...it, id: String(it.id), group: it.group || 'ads', gamepassId: validPass(it.gamepassId) }))
    .filter(it => it.gamepassId);
}
const findItem = id => items().find(x => x.id === id);
const inGroup = g => items().filter(x => x.group === g);
const passUrl = it => `https://www.roblox.com/game-pass/${it.gamepassId}`;

// the real price, read from Roblox (cached 10 min) unless you hard-coded `price` in market.items.js
const infoCache = new Map();
async function passInfo(it) {
  const hit = infoCache.get(it.gamepassId);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.v;
  let v = null;
  for (const url of [
    `https://economy.roblox.com/v1/game-pass/${it.gamepassId}/game-pass-product-info`,
    `https://apis.roblox.com/game-passes/v1/game-passes/${it.gamepassId}/product-info`,
  ]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const j = await r.json();
      const price = j.PriceInRobux ?? j.priceInRobux ?? null;
      v = { price, forSale: j.IsForSale ?? j.isForSale ?? true };
      break;
    } catch { /* try the next one */ }
  }
  infoCache.set(it.gamepassId, { at: Date.now(), v });
  return v;
}
async function priceOf(it) {
  if (it.price != null && it.price !== '') return Number(it.price);
  const i = await passInfo(it);
  return i?.price != null ? Number(i.price) : null;
}

// ---------------------------------------------------------------- panel
function panel() {
  const c = ui.base();
  c.addTextDisplayComponents(ui.text(
    `## ${tag(E.money)} ${cfg.brand} Marketplace\n> Hey there! Before purchasing anything, please note that we do **not** offer refunds, nor do we advertise servers that violate Discord's Terms of Service. Pick a category below, buy the Game Pass with your **linked** Roblox account, and I will pick the purchase up automatically. You can also press **Claim Purchase** yourself.\n-# **DISCLAIMER:** We do not accept any payments other than Robux.`));
  c.addTextDisplayComponents(ui.text(`### ${tag(E.share)} On Sale Items`));
  c.addActionRowComponents(ui.row(
    new StringSelectMenuBuilder().setCustomId('market_select').setPlaceholder('Browse our market!')
      .addOptions(GROUPS.map(g => ({ label: g.label, value: g.id, description: g.blurb.slice(0, 100), emoji: g.emoji })))));
  c.addActionRowComponents(ui.row(
    new ButtonBuilder().setCustomId('market_claim').setLabel('Claim Purchase').setEmoji(E.gift).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('market_queue').setLabel('View Queue').setEmoji(E.schedule).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('market_tos').setLabel('Marketplace TOS').setEmoji(E.rule).setStyle(ButtonStyle.Secondary)));
  return ui.foot(c);
}

// keep the posted panel up to date after you edit market.items.js and restart
async function refresh(client) {
  const p = db.panels.market;
  if (!p) return false;
  try {
    const ch = await client.channels.fetch(p.channelId);
    const m = await ch.messages.fetch(p.messageId);
    await m.edit({ components: [panel()], flags: ui.V2, allowedMentions: ui.NO_PING });
    return true;
  } catch { return false; }
}

add(sc('market').setDescription('Owner: post the Marketplace panel')
  .addSubcommand(s => s.setName('post').setDescription('Post the marketplace panel')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post (default: here)').addChannelTypes(ChannelType.GuildText))),
async i => {
  const ch = i.options.getChannel('channel') || i.channel;
  const m = await ch.send(ui.msg(panel()));
  db.panels.market = { channelId: ch.id, messageId: m.id }; save();
  await i.reply({ content: `Marketplace posted in ${ch}.`, flags: EPH });
});

// ---------------------------------------------------------------- category view (what the buyer sees after the dropdown)
async function groupView(g, userId) {
  const list = inGroup(g.id);
  const prices = await Promise.all(list.map(priceOf));
  const link = db.links[userId];
  const c = ui.base();
  c.addTextDisplayComponents(ui.text(`## ${tag(g.emoji)} ${g.label}\n> ${g.blurb}`));
  list.forEach((it, k) => {
    c.addSeparatorComponents(ui.sep());
    const price = prices[k] != null ? `**R$ ${fmt(prices[k])}**` : '';
    c.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(ui.text(`**${it.label}**${price ? ` · ${price}` : ''}\n${it.description || ''}${it.tier ? `\n-# ${TIER_NAME[it.tier]} queue spot` : ''}`))
      .setButtonAccessory(new ButtonBuilder().setLabel('Buy').setStyle(ButtonStyle.Link).setURL(passUrl(it))));
  });
  c.addSeparatorComponents(ui.sep());
  c.addTextDisplayComponents(ui.text(link
    ? `${tag(E.person)} **Linked Roblox account:** [${link.name}](https://www.roblox.com/users/${link.robloxId}/profile)\n-# Buy with **this** account. I check automatically for the next 45 minutes, or press **Claim Purchase**.`
    : `${tag(E.bell)} **You have not linked a Roblox account yet.** Press **Link Roblox** first so I can find your purchase.`));
  c.addActionRowComponents(ui.row(
    new ButtonBuilder().setCustomId('market_claim').setLabel('Claim Purchase').setEmoji(E.gift).setStyle(ButtonStyle.Primary),
    link
      ? new ButtonBuilder().setCustomId('market_unlink').setLabel('Unlink').setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder().setCustomId('market_link').setLabel('Link Roblox').setEmoji(E.share).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('market_queue').setLabel('View Queue').setEmoji(E.schedule).setStyle(ButtonStyle.Secondary)));
  return ui.eph(ui.foot(c));
}

// ---------------------------------------------------------------- Roblox
const sleep = ms => new Promise(r => setTimeout(r, ms));
// true = owns it, false = does not, null = could not check (private inventory / Roblox error)
async function ownsPass(robloxId, passId) {
  for (let a = 0; a < 2; a++) {
    try {
      const r = await fetch(`https://inventory.roblox.com/v1/users/${robloxId}/items/GamePass/${passId}/is-owned`, { signal: AbortSignal.timeout(8000) });
      if (r.status === 429 && a === 0) { await sleep(1500); continue; }
      if (!r.ok) return null;
      return (await r.text()).trim() === 'true';
    } catch { /* try once more */ }
  }
  return null;
}
async function pool(arr, n, fn) {
  const out = new Array(arr.length); let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
    while (k < arr.length) { const j = k++; out[j] = await fn(arr[j]); }
  }));
  return out;
}

// ---------------------------------------------------------------- queue
// Instant posts go first, then Priority, then everyone else. Inside each tier it is first come, first served.
const isQueued = t => t.type === 'market' && t.kind === 'claim' && (t.items || []).some(x => x.queue);
const tierOf = t => Math.min(2, ...(t.items || []).map(x => TIER_RANK[x.tier] ?? 2));
const tierName = t => ['Instant', 'Priority', null][tierOf(t)];
const queueList = () => Object.values(db.tickets).filter(isQueued)
  .sort((a, b) => tierOf(a) - tierOf(b) || a.openedAt - b.openedAt);

// ---------------------------------------------------------------- tickets
function ticketPanel(userId, roles, rec) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(ui.text(`${tag(E.share)} ${roles.map(r => `<@&${r}>`).join(' ')} <@${userId}>`.trim()));
  if (cfg.banners.top) c.addMediaGalleryComponents(ui.gallery(cfg.banners.top));
  c.addSeparatorComponents(ui.sep());
  const lines = rec.items.map(x => `• **${x.label}**${x.price != null && x.price !== '' ? `: R$ ${fmt(x.price)}` : ''}`).join('\n');
  const tn = tierName(rec);
  c.addTextDisplayComponents(ui.text(
    `## ${tag(E.gift)} Purchase claimed!\nThanks for shopping with ${tag(E.logo)} **${cfg.brand}**! Please send us what you want posted (text, links, images) and our team will handle the rest. We kindly ask you **refrain** from pinging our team.\n\n**Purchased:**\n${lines}${tn ? `\n\n**Queue spot:** ${tn}` : ''}\n\n**Roblox account:** [${rec.robloxName}](https://www.roblox.com/users/${rec.robloxId}/profile)\n**Claimed:** <t:${ts(rec.openedAt)}:R>`));
  c.addActionRowComponents(ui.row(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Danger), ui.brandBtn()));
  return ui.foot(c);
}

// opens the private ticket channel
async function openTicket(client, guild, user, rec) {
  const n = ++db.counters.market; save();
  const name = `market-${String(n).padStart(4, '0')}`;
  const allow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.SendMessagesInThreads];
  const overwrites = [
    { id: guild.id, deny: [P.ViewChannel] },
    { id: user.id, allow },
    { id: client.user.id, allow: [...allow, P.ManageChannels, P.ManageMessages, P.ManageThreads] },
  ];
  if (cfg.roles.staff) overwrites.push({ id: cfg.roles.staff, allow: [...allow, P.ManageMessages] });

  const channel = await guild.channels.create({
    name, type: ChannelType.GuildText, parent: cfg.market.category || cfg.categories.support || undefined,
    topic: `ticket:${user.id}:market:-`, permissionOverwrites: overwrites,
  });
  const roles = [cfg.market.ping || cfg.pings.support].filter(Boolean);
  const full = { ...rec, id: channel.id, ownerId: user.id, type: 'market', service: null, roles, openedAt: Date.now() };
  const sent = await channel.send({ components: [ticketPanel(user.id, roles, full)], flags: ui.V2, allowedMentions: { roles, users: [user.id] } });
  full.panelId = sent.id;
  db.tickets[channel.id] = full; save();
  T.log(client, `${tag(E.bell)} **${name}** opened by <@${user.id}> (market purchase).`);
  return channel;
}

// the buyer already has an open purchase ticket? then new purchases are added to it instead of opening a second one
async function addToTicket(client, rec, fresh) {
  rec.items.push(...fresh);
  save();
  const ch = await client.channels.fetch(rec.id).catch(() => null);
  if (!ch) return null;
  try {
    const m = await ch.messages.fetch(rec.panelId);
    await m.edit({ components: [ticketPanel(rec.ownerId, rec.roles, rec)], flags: ui.V2, allowedMentions: ui.NO_PING });
  } catch { /* panel was deleted, the note below still tells everyone */ }
  await ch.send({ content: `${tag(E.gift)} <@${rec.ownerId}> added: ${fresh.map(x => `**${x.label}**`).join(', ')}`, allowedMentions: { parse: [] } }).catch(() => {});
  return ch;
}

const niceList = a => a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
const key = (link, it) => `${link.robloxId}:${it.id}`;

// ---------------------------------------------------------------- one place that handles a found purchase
// Used by the Claim Purchase button AND by the automatic watcher. `fresh` = items the account owns that were not claimed yet.
async function processPurchase(client, guild, user, link, fresh) {
  // reserve right away (no awaits in between) so a double click / watcher race can never claim twice
  const at = Date.now();
  for (const it of fresh) db.marketClaims[key(link, it)] = { discordId: user.id, robloxName: link.name, at };
  save();

  const prices = await Promise.all(fresh.map(priceOf));
  const rows = fresh.map((it, k) => ({ id: it.id, label: it.label, price: prices[k], tier: it.tier || null, queue: !!it.queue, group: it.group }));

  let ch;
  try {
    const existing = Object.values(db.tickets).find(t => t.type === 'market' && t.kind === 'claim' && t.ownerId === user.id);
    ch = existing && await addToTicket(client, existing, rows);
    if (!ch) ch = await openTicket(client, guild, user, { kind: 'claim', robloxId: link.robloxId, robloxName: link.name, items: rows });
  } catch (e) {
    console.error('market ticket', e);
    for (const it of fresh) delete db.marketClaims[key(link, it)];
    save();
    throw e;
  }
  for (const it of fresh) db.marketClaims[key(link, it)].channelId = ch.id;

  const robux = rows.reduce((n, x) => n + (Number(x.price) || 0), 0);
  db.stats.robuxEarned += robux; save();
  const names = fresh.map(x => x.label);

  // 1) public "Thanks for your purchase!" (the panel from your screenshot)
  T.sendTo(client, cfg.market.thanks, ui.msg(ui.thanksPurchase(user.id, niceList(names))));
  // 2) staff sale log
  T.saleLog(client, `${tag(E.money)} **Market purchase:** ${names.join(', ')}${robux ? ` (${fmt(robux)} R$)` : ''} by <@${user.id}> (Roblox: ${link.name}) in <#${ch.id}>.`);
  // 3) automatic delivery for roles the bot can hand out itself (VIP)
  for (const it of fresh) {
    if (it.grantRole === 'vip' && cfg.market.vipRole) {
      const m = await guild.members.fetch(user.id).catch(() => null);
      await m?.roles.add(cfg.market.vipRole, 'Marketplace: VIP purchase').catch(e => console.error('vip role', e.message));
    }
  }
  return { channel: ch, names, robux };
}

// ---------------------------------------------------------------- dropdown
async function onSelect(i) {
  if (i.customId !== 'market_select') return false;
  const g = GROUPS.find(x => x.id === i.values[0]);
  // Re-draw the panel so the dropdown resets and the same category can be picked again, then answer privately.
  let acked = false;
  try { await i.update(ui.msg(panel())); acked = true; } catch { /* fall back to a normal reply */ }
  const out = p => (acked ? i.followUp(p) : i.reply(p));
  if (!g) { await out({ content: 'That category is not available right now.', flags: EPH }); return true; }

  // start watching this buyer for this category's passes, so the purchase is picked up without pressing anything
  if (db.links[i.user.id]) {
    const prev = db.marketWatch[i.user.id];
    const ids = new Set([...(prev && prev.until > Date.now() ? prev.items : []), ...inGroup(g.id).map(x => x.id)]);
    db.marketWatch[i.user.id] = { items: [...ids], until: Date.now() + WATCH_MS }; save();
  }
  await out(await groupView(g, i.user.id));
  return true;
}

// ---------------------------------------------------------------- Link / Unlink buttons
async function onModal(i) {
  if (i.customId !== 'market_link_modal') return false;
  await i.deferReply({ flags: EPH });
  await linkRoblox(i, i.fields.getTextInputValue('username').trim());
  return true;
}
const linkModal = () => new ModalBuilder().setCustomId('market_link_modal').setTitle('Link your Roblox account')
  .addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('username').setLabel('Roblox username').setStyle(TextInputStyle.Short)
      .setRequired(true).setMinLength(3).setMaxLength(20).setPlaceholder('Your exact Roblox username')));

async function unlink(i) {
  const old = db.links[i.user.id];
  if (!old) return i.reply({ content: 'You have no linked Roblox account.', flags: EPH });
  delete db.links[i.user.id]; delete db.marketWatch[i.user.id]; save();
  if (i.member?.nickname && i.member.nickname.toLowerCase() === String(old.name).toLowerCase())
    await i.member.setNickname(null, 'Unlinked Roblox account').catch(() => {});
  return i.reply({ content: `**${old.name}** was unlinked. Press **Link Roblox** to link the right account.`, flags: EPH });
}

// ---------------------------------------------------------------- Claim Purchase
const WATCH_MS = 45 * 60e3;
const busy = new Set();
const NOT_LINKED = "**We don't see a linked Roblox account on your profile.**\nPick a category in the dropdown and press **Link Roblox**, or use `/link` with your Roblox username, then press **Claim Purchase** again.\n-# Linked the wrong account? Use `/unlink`, then `/link` again.";

// which of `list` does this linked account own and not claim yet?
async function scan(link, list) {
  const res = await pool(list, 4, it => ownsPass(link.robloxId, it.gamepassId));
  const owned = list.filter((_, k) => res[k] === true);
  return {
    owned, unknown: res.filter(r => r === null).length,
    fresh: owned.filter(it => !db.marketClaims[key(link, it)]),
    already: owned.filter(it => db.marketClaims[key(link, it)]),
  };
}

async function claim(i) {
  const b = T.isBlacklisted(i.user.id);
  if (b) return i.reply({ content: `You are blacklisted from opening tickets and orders.\n**Reason:** ${b.reason}`, flags: EPH });
  const link = db.links[i.user.id];
  if (!link) return i.reply({ content: NOT_LINKED, flags: EPH });
  const list = items();
  if (!list.length) return i.reply({ content: 'There is nothing on sale yet, so there is nothing to claim.', flags: EPH });
  if (busy.has(i.user.id)) return i.reply({ content: 'I am already checking your purchases. Give me a moment.', flags: EPH });

  busy.add(i.user.id);
  try {
    await i.deferReply({ flags: EPH });
    const { unknown, fresh, already } = await scan(link, list);

    if (!fresh.length) {
      if (already.length)
        return i.editReply(`You have already claimed: ${already.map(x => `**${x.label}**`).join(', ')}.\nThere is nothing new to claim on **${link.name}**.`);
      if (unknown === list.length)
        return i.editReply(`I could not look at the inventory of **${link.name}**. Make sure it is public:\n**Settings ➜ Privacy ➜ Inventory visibility ➜ Everyone**, then try again.`);
      return i.editReply(
        `I could not find a market purchase on **${link.name}**.\n• Just bought it? Roblox can take a minute to show up. Wait a moment and try again.\n• Make sure you bought it with **${link.name}**. Linked the wrong account? Use **Unlink**, then **Link Roblox** with the right username.\n• Your Roblox inventory must be public: **Settings ➜ Privacy ➜ Inventory visibility ➜ Everyone**.${unknown ? '\n• I could not check some items, so try again in a minute.' : ''}`);
    }

    let r;
    try { r = await processPurchase(i.client, i.guild, i.user, link, fresh); }
    catch { return i.editReply('Your purchase was found, but I could not open the ticket. Nothing was claimed, so please press **Claim Purchase** again or contact staff.'); }
    delete db.marketWatch[i.user.id]; save();
    return i.editReply(`${tag(E.thumbsup)} Found **${r.names.join(', ')}** on **${link.name}**!\nYour ticket: ${r.channel}`);
  } catch (e) {
    console.error('market claim', e);
    if (i.deferred || i.replied) return i.editReply('Something went wrong. Please try again.');
    return i.reply({ content: 'Something went wrong. Please try again.', flags: EPH });
  } finally { busy.delete(i.user.id); }
}

// ---------------------------------------------------------------- automatic pick-up
// Everyone who opened a category (and is linked) is checked every 30s for 45 minutes.
// The moment the Game Pass shows up in their inventory the purchase is claimed: ticket, queue, thank-you post, sale log.
let ticking = false;
async function tick(client) {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const [uid, w] of Object.entries(db.marketWatch)) {
      const link = db.links[uid];
      const list = (w.items || []).map(findItem).filter(Boolean).filter(it => link && !db.marketClaims[key(link, it)]);
      if (!link || w.until < now || !list.length) { delete db.marketWatch[uid]; save(); continue; }
      if (busy.has(uid)) continue;
      busy.add(uid);
      try {
        const { fresh } = await scan(link, list);
        if (!fresh.length) continue;
        const guild = await client.guilds.fetch(cfg.guildId);
        const user = await client.users.fetch(uid);
        const r = await processPurchase(client, guild, user, link, fresh);
        delete db.marketWatch[uid]; save();
        user.send(ui.msg(ui.note(`${tag(E.thumbsup)} I found your purchase of **${r.names.join(', ')}**! Your ticket: ${r.channel}`))).catch(() => {});
      } catch (e) { console.error('market watch', uid, e.message); }
      finally { busy.delete(uid); }
      await sleep(400);
    }
  } finally { ticking = false; }
}

// ---------------------------------------------------------------- View Queue
function queueMessage(userId) {
  const q = queueList();
  const mine = q.findIndex(t => t.ownerId === userId);
  const shown = q.slice(0, 10).map((t, n) => {
    const tn = tierName(t);
    return `**#${n + 1}** ${t.ownerId === userId ? `${tag(E.person)} ` : ''}${t.items.filter(x => x.queue).map(x => x.label).join(', ').slice(0, 70)}${tn ? ` · **${tn}**` : ''} · <@${t.ownerId}> · <t:${ts(t.openedAt)}:R>`;
  });
  const c = ui.base();
  c.addTextDisplayComponents(ui.text(
    `## ${tag(E.schedule)} Marketplace Queue\n-# Posts waiting to go out. Instant first, then Priority, then everyone else (oldest first).\n\n${shown.join('\n') || 'The queue is empty right now.'}${q.length > 10 ? `\n…and ${q.length - 10} more.` : ''}\n\n${mine >= 0 ? `**Your position:** #${mine + 1} of ${q.length}` : "You don't have a post in the queue."}`));
  return ui.eph(ui.foot(c));
}

// ---------------------------------------------------------------- Marketplace TOS (edit the text here)
const TOS_TEXT = () =>
`## ${tag(E.rule)} Marketplace Terms of Service
By buying anything from the ${cfg.brand} Marketplace you agree to the terms below.

**1. Payments**
We only accept **Robux**, paid by buying the matching Game Pass on Roblox. We never accept any other form of payment (no PayPal, gift cards, trades or "pay you later").

**2. Linking your account**
Your Roblox account must be linked with \`/link\` before you can claim. Linked the wrong one? Use \`/unlink\`, then \`/link\` again. Your Roblox inventory must be **public** so we can verify your purchase.

**3. Claiming**
After you pay, I check your linked account automatically (or press **Claim Purchase**). We check that the Game Pass is in the inventory of your linked account and open a ticket for you. Each Game Pass can only be claimed **once per Roblox account**.

**4. No refunds**
All sales are final. We do not offer refunds, exchanges or chargebacks, so please read the item description before you buy.

**5. Advertising and giveaways**
Everything we post must follow the Discord Terms of Service, Discord Community Guidelines and the Roblox Terms of Use. We do not advertise servers, groups or links that break them (NSFW, scams, exploits, raids, account selling and so on). We may refuse or remove any content at any time, and content removed for breaking the rules is not refundable.

**6. Abuse**
Claiming with an account that is not yours, using alts to get around limits, or any kind of fraud will get you blacklisted from the marketplace and tickets, with no refund.

**7. Changes**
Items, prices and these terms can change at any time. Staff decisions are final.

-# Questions? Open a ticket before you buy.`;
const tosMessage = () => { const c = ui.base(); c.addTextDisplayComponents(ui.text(TOS_TEXT())); return ui.eph(ui.foot(c)); };

// ---------------------------------------------------------------- buttons
async function onButton(i) {
  switch (i.customId) {
    case 'market_claim': await claim(i); return true;
    case 'market_queue': await i.reply(queueMessage(i.user.id)); return true;
    case 'market_tos': await i.reply(tosMessage()); return true;
    case 'market_link': {
      const b = T.isBlacklisted(i.user.id);
      if (b) { await i.reply({ content: `You are blacklisted from opening tickets and orders.\n**Reason:** ${b.reason}`, flags: EPH }); return true; }
      await i.showModal(linkModal()); return true;
    }
    case 'market_unlink': await unlink(i); return true;
    default: return false;
  }
}

module.exports = { onSelect, onButton, onModal, tick, refresh, panel };
