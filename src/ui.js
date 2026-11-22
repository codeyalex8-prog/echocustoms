// All Components V2 panels live here.
const {
  ContainerBuilder, TextDisplayBuilder, SectionBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, FileBuilder, MessageFlags,
} = require('discord.js');
const cfg = require('./config');
const { db, svcState } = require('./db');
const { E, tag } = require('./emojis');

const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const NO_PING = { parse: [] }; // shows mentions but never notifies (ghost ping)

const text = s => new TextDisplayBuilder().setContent(String(s).slice(0, 3900));
const sep = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const gallery = url => new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(url));

function base() {
  const c = new ContainerBuilder();
  if (cfg.banners.top) { c.addMediaGalleryComponents(gallery(cfg.banners.top)); c.addSeparatorComponents(sep()); }
  return c;
}
function foot(c) {
  if (cfg.banners.bottom) c.addMediaGalleryComponents(gallery(cfg.banners.bottom));
  return c;
}
const brandBtn = () => new ButtonBuilder().setCustomId('brand').setLabel(cfg.brand).setEmoji(E.logo)
  .setStyle(ButtonStyle.Secondary).setDisabled(true);
const msg = (c, extra = {}) => ({ components: [c], flags: V2, allowedMentions: NO_PING, ...extra });
const eph = (c, extra = {}) => msg(c, { flags: V2 | EPH, ...extra });

// ---------------- DASHBOARD ----------------
function founderLine() {
  if (!cfg.ownerIds.length) return '';
  const who = cfg.ownerIds.map(id => `<@${id}>`).join(' and ');
  return `\n\n-# ${tag(E.crown)} Founded${cfg.founded ? ` on ${cfg.founded}` : ''} by ${who}`;
}
const linkBtn = url => url ? [new ButtonBuilder().setLabel('Services').setEmoji(E.share).setStyle(ButtonStyle.Link).setURL(url)] : [];

function dashboardPanel() {
  const c = base();
  c.addTextDisplayComponents(text(
    `Welcome to ${tag(E.logo)} **${cfg.brand}**, where development is built to your standards. We specialize exclusively in **Discord development, bot development and ERLC development**, creating professional work built to match your server and vision.${founderLine()}`));
  c.addActionRowComponents(row(
    new StringSelectMenuBuilder().setCustomId('dash_select').setPlaceholder('Guidelines')
      .addOptions({ label: 'Guidelines', value: 'guidelines', emoji: E.thumbsup, description: 'Read the server rules' })));
  c.addActionRowComponents(row(
    new ButtonBuilder().setCustomId('ticket_support').setLabel('Get Assistance').setEmoji(E.bell).setStyle(ButtonStyle.Secondary),
    ...linkBtn(cfg.urls.services)));
  return foot(c);
}

function guidelinesMessage() {
  const c = base();
  c.addTextDisplayComponents(text(
`**Respect**
Show respect to all members and value their perspectives. Harassment, discrimination, or offensive behavior has no place here.

**Safe for Work**
Ensure all content is appropriate for all users by avoiding explicit or offensive material. Refrain from sharing suspicious links or unsafe content.

**Maintain Relevance**
Keep discussions relevant to the development community and its' objectives. Utilize designated channels for specific topics to ensure clarity and organization.

**Common Sense**
You reserve the right to be moderated under any occasion, regardless if listed here or not. Exercise good judgement, think before speaking, and maintain a considerate attitude.

**Auto-Moderation**
Swearing and inappropriate language earns you a **strike**. Posting links in text channels is not allowed and is removed and logged.
> **3 strikes:** 30 minute timeout
> **6 strikes:** 24 hour timeout
> **9 strikes:** kick
> **12 strikes:** temporary ban
> **15 strikes:** permanent ban

-# Ensure you are following Discord's Terms of Service at all times to avoid moderation.`));
  return foot(c);
}

// ---------------- SERVICES ----------------
function servicesPanel() {
  const c = base();
  c.addTextDisplayComponents(text(
    `## ${tag(E.money)} Services\n> You can place your high-quality commission right here! We tailor our products to your standards, the right way. Below you can see the availability of the current service.`));
  c.addSeparatorComponents(sep());
  for (const s of Object.values(cfg.services)) {
    const st = svcState(s.key);
    const btn = new ButtonBuilder().setCustomId(`svc_state_${s.key}`).setDisabled(true);
    if (st === 'open') btn.setLabel('Open').setStyle(ButtonStyle.Success);
    else if (st === 'delayed') btn.setLabel('Delayed').setEmoji('🟡').setStyle(ButtonStyle.Secondary); // Discord has no yellow button
    else btn.setLabel('Closed').setStyle(ButtonStyle.Danger);
    c.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(text(`${tag(E[s.emoji])} **${s.label}**`))
      .setButtonAccessory(btn));
  }
  c.addSeparatorComponents(sep());
  c.addActionRowComponents(row(
    new ButtonBuilder().setCustomId('order_begin').setLabel('Begin Order').setStyle(ButtonStyle.Secondary), brandBtn()));
  return foot(c);
}

function orderSelect() {
  const open = Object.values(cfg.services).filter(s => svcState(s.key) !== 'closed');
  if (!open.length) return null;
  return row(new StringSelectMenuBuilder().setCustomId('order_select').setPlaceholder('What are you ordering?')
    .addOptions(open.map(s => ({ label: s.label, value: s.key, emoji: E[s.emoji],
      description: svcState(s.key) === 'delayed' ? 'Delayed: expect a longer wait' : undefined }))));
}

// ---------------- WELCOME ----------------
function welcomePanel(member) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(
    `## 👋 Welcome, <@${member.id}>\n> We welcome you to ${tag(E.logo)} **${cfg.brand}**, we are glad you have joined us. A couple tips, ensure to read our ${cfg.urls.dashboard ? `[dashboard](${cfg.urls.dashboard})` : 'dashboard'} for our goals and guidelines.`));
  c.addActionRowComponents(row(
    new ButtonBuilder().setCustomId('member_count').setLabel(String(member.guild.memberCount)).setEmoji(E.person)
      .setStyle(ButtonStyle.Secondary).setDisabled(true),
    ...linkBtn(cfg.urls.dashboard)));
  return foot(c);
}

// ---------------- TICKETS ----------------
const closeRow = aiOff => row(new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Danger), brandBtn());

function supportTicketPanel(userId, roles, inquiry, aiOff = false) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(`📎 ${roles.map(r => `<@&${r}>`).join(' ')} <@${userId}>`.trim()));
  if (cfg.banners.top) c.addMediaGalleryComponents(gallery(cfg.banners.top));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(
    `## We're here to help!\nOur team here at ${tag(E.logo)} **${cfg.brand}** will be with you shortly. Please ensure to attach any remaining details you have left out or any images. We kindly ask you **refrain** from pinging our team.\n\n${tag(E.bell)} **Inquiry:** "${inquiry}"`));
  c.addActionRowComponents(closeRow(aiOff));
  return foot(c);
}

const STATES = ['Not started', 'In progress', 'Testing', 'Delivered'];
const bar = i => '▰'.repeat(i + 1) + '▱'.repeat(3 - i);

function orderTicketPanel(userId, roles, svc, t) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(`📎 ${roles.map(r => `<@&${r}>`).join(' ')} <@${userId}>`.trim()));
  if (cfg.banners.top) c.addMediaGalleryComponents(gallery(cfg.banners.top));
  c.addSeparatorComponents(sep());
  const q = t.quote ? `${t.quote.price} (${t.quote.status})` : 'awaiting quote';
  const due = t.due ? `\n**Due:** <t:${Math.floor(t.due / 1000)}:D> (<t:${Math.floor(t.due / 1000)}:R>)` : '';
  c.addTextDisplayComponents(text(
    `## ${tag(E.money)} Order received!\nThanks for ordering with ${tag(E.logo)} **${cfg.brand}**. Our team will be with you shortly. Your references and description are in the **references** thread below. We kindly ask you **refrain** from pinging our team.\n\n**Service:** ${svc.label}\n**Budget:** ${t.budget}\n**Quote:** ${q}${t.priority && t.priority !== 'normal' ? `\n**Priority:** ${t.priority.toUpperCase()}` : ''}\n**Progress:** ${STATES[t.progress || 0]} ${bar(t.progress || 0)}${due}${t.delayed ? '\n⚠️ **This service is currently delayed**, expect a longer turnaround than usual.' : ''}`));
  c.addActionRowComponents(row(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('queue_pos').setLabel(t.pos ? `Queue: #${t.pos}` : 'Queue: -').setEmoji(E.person)
      .setStyle(ButtonStyle.Secondary).setDisabled(true),
    brandBtn()));
  return foot(c);
}

function referencesPanel(userId, description) {
  const c = base();
  c.addTextDisplayComponents(text(
    `## References\n<@${userId}>, post your **reference links and images** in this thread. Only safe links are allowed (Discord, Imgur, Roblox, YouTube, Pinterest, GitHub, Google Drive, etc.). Anything unsafe is removed automatically.\n\n**Commission description:**\n${description}`));
  return foot(c);
}

function claimedPanel(userId) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(`${tag(E.thumbsup)} This ticket has been claimed by <@${userId}>.`));
  return c;
}

function closeConfirm() {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(`## Was this order successful?\nThis decides whether the success message is posted and the client role is given.`));
  c.addActionRowComponents(row(
    new ButtonBuilder().setCustomId('close_yes').setLabel('Yes').setEmoji(E.thumbsup).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('close_no').setLabel('No').setStyle(ButtonStyle.Danger)));
  return c;
}

function ticketClosedDM({ type, closedBy, reason, fname, isOrder }) {
  const c = base();
  c.addTextDisplayComponents(text(`## ${tag(E.punishment)} Your ticket was closed`));
  c.addTextDisplayComponents(text(`> **Type:** ${type}\n> **Closed by:** <@${closedBy}>\n> **Reason:** ${reason}`));
  c.addTextDisplayComponents(text(isOrder
    ? 'Thank you for choosing us! A copy of the conversation is attached below. We would love to hear your feedback.'
    : 'Thank you for contacting us! A copy of the conversation is attached below.'));
  c.addFileComponents(new FileBuilder().setURL(`attachment://${fname}`));
  return c;
}
function ticketClosedDMFull(o, ticketName) {
  const c = ticketClosedDM(o);
  if (o.isOrder) {
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(new ButtonBuilder().setCustomId(`review_open:${ticketName}`).setLabel('Leave a Review')
      .setEmoji(E.star).setStyle(ButtonStyle.Success)));
  }
  return foot(c);
}

function transcriptLog({ ticketName, type, ownerId, closedBy, reason, fname, success, summary }) {
  const c = base();
  c.addTextDisplayComponents(text(
    `## ${tag(E.punishment)} Ticket closed: ${ticketName}\n> **Type:** ${type}\n> **Opened by:** <@${ownerId}>\n> **Closed by:** <@${closedBy}>\n> **Reason:** ${reason}${success === null ? '' : `\n> **Order successful:** ${success ? 'Yes' : 'No'}`}`));
  c.addFileComponents(new FileBuilder().setURL(`attachment://${fname}`));
  if (summary) { c.addSeparatorComponents(sep()); c.addTextDisplayComponents(text(String(summary).slice(0, 1800))); }
  return foot(c);
}

function thanksPurchase(userId, what) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(
    `## ${tag(E.gift)} Thanks for your purchase!\nWe extend our heartfelt gratitude to <@${userId}> for purchasing **${what}**! Your purchase significantly aids us in various aspects. It contributes to funding thrilling giveaways and enhancing server functionalities.`));
  return c;
}

// ---------------- REVIEWS ----------------
function reviewPost(userId, rating, feedback) {
  const c = base();
  const stars = Array(rating).fill(tag(E.star)).join(' ');
  c.addTextDisplayComponents(text(
    `## New review!\n**Submitted by:** <@${userId}>\n**Rating** ${stars} (${rating} Star${rating === 1 ? '' : 's'})\n**Feedback:** ${feedback}`));
  c.addActionRowComponents(row(brandBtn()));
  return foot(c);
}

// ---------------- PACKAGES ----------------
function packagePost(p) {
  const c = base();
  c.addTextDisplayComponents(text(
    `## ${p.name}\n**Price:** ${p.price} Robux\n**Packer:** <@${p.packerId}>\n**Total Sales:** ${p.sales}`));
  c.addTextDisplayComponents(text(`**Package contents:**\n${p.contents.map(x => `- ${x}`).join('\n')}`));
  c.addActionRowComponents(row(
    new ButtonBuilder().setCustomId(`pkg_claim:${p.id}`).setLabel('Claim Package').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`pkg_buy:${p.id}`).setLabel('Purchase').setStyle(ButtonStyle.Secondary)));
  return foot(c);
}
function paymentPanel(p) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(
    `## ${tag(E.money)} Package Payment\nPay **${p.price} Robux** for **${p.name}** on Roblox by buying the Game Pass.\n\nAfter paying, return to the package post and click **Claim Package**. Only a purchase from your linked Roblox account made after you clicked Purchase will count.`));
  c.addActionRowComponents(row(new ButtonBuilder().setLabel('Pay on Roblox').setStyle(ButtonStyle.Link)
    .setURL(`https://www.roblox.com/game-pass/${p.gamepassId}`)));
  return c;
}

// ---------------- ANNOUNCE ----------------
function updatePanel(title, summary, added, removed) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(`## ${title}\n**summary:** ${summary}`));
  c.addSeparatorComponents(sep());
  const lines = [...added.map(x => `+ ${x}`), ...(removed.length ? ['', ...removed.map(x => `- ${x}`)] : [])];
  c.addTextDisplayComponents(text('```diff\n' + lines.join('\n') + '\n```'));
  return c;
}


function quotePanel(q, status) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(
    `## ${tag(E.money)} Quote\n**Price:** ${q.price}${q.details ? `\n**Details:** ${q.details}` : ''}\n**Status:** ${status === 'pending' ? 'Waiting for the client to respond' : status === 'accepted' ? '✅ Accepted' : '❌ Declined'}`));
  if (status === 'pending') {
    c.addActionRowComponents(row(
      new ButtonBuilder().setCustomId('quote_accept').setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('quote_decline').setLabel('Decline').setStyle(ButtonStyle.Danger)));
  }
  return c;
}

function progressNotice(state, by) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(`${tag(E.bell)} **Order update:** ${STATES[state]} ${bar(state)}\n-# Updated by <@${by}>`));
  return c;
}

function portfolioPanel(items, category) {
  const c = base();
  c.addTextDisplayComponents(text(`## ${tag(E.pc)} Portfolio${category ? `: ${category}` : ''}\n> A showcase of our past work.`));
  for (const it of items.slice(0, 8)) {
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(text(`**${it.title}** · ${it.category}\n${it.description}${it.link ? `\n[View project](${it.link})` : ''}`));
    if (it.image) c.addMediaGalleryComponents(gallery(it.image));
  }
  return foot(c);
}

function statsPanel(lines) {
  const c = base();
  c.addTextDisplayComponents(text(`## ${tag(E.logo)} ${cfg.brand} Stats\n${lines.join('\n')}`));
  return foot(c);
}

function reviewsSummary(avg, count) {
  const c = base();
  const full = Math.round(avg);
  c.addTextDisplayComponents(text(
    `## ${tag(E.star)} Reviews\n${Array(Math.max(full, 0)).fill(tag(E.star)).join(' ') || 'No reviews yet'}\n**Average:** ${count ? avg.toFixed(2) : '-'} / 5 from **${count}** review${count === 1 ? '' : 's'}`));
  return foot(c);
}

const STATE_ICON = { open: '🟢 Open', delayed: '🟡 Delayed', closed: '🔴 Closed' };
function livePanel() {
  const s = db.stats;
  const avg = s.ratingCount ? (s.ratingSum / s.ratingCount).toFixed(2) : '-';
  const c = base();
  c.addTextDisplayComponents(text(
    `## ${tag(E.money)} Live Sales Stats\n-# Updates every 20 seconds · last updated <t:${Math.floor(Date.now() / 1000)}:T>`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(
    `${tag(E.share)} **Packages sold:** ${s.packageSales || 0}\n${tag(E.money)} **Robux earned:** ${(s.robuxEarned || 0).toLocaleString('en-US')} R$\n${tag(E.thumbsup)} **Orders completed:** ${s.ordersSuccessful || 0}\n${tag(E.person)} **Orders in queue:** ${db.queue.length}\n${tag(E.bell)} **Orders opened (all time):** ${s.ordersOpened || 0}\n${tag(E.star)} **Average rating:** ${avg} (${s.ratingCount || 0} reviews)`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(
    '**Availability**\n' + Object.values(cfg.services).map(v => `${tag(E[v.emoji])} ${v.label}: ${STATE_ICON[svcState(v.key)]}`).join('\n')));
  return foot(c);
}

function submissionPanel(sub, status) {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(text(
    `## ${tag(E.share)} Package submission #${sub.id}\n**Name:** ${sub.name}\n**Price:** ${sub.price} Robux\n**Game Pass ID:** ${sub.gamepassId}\n**Submitted by:** <@${sub.submitterId}>\n**Status:** ${status === 'pending' ? 'Waiting for review' : status === 'approved' ? '✅ Approved' : '❌ Rejected'}`));
  c.addTextDisplayComponents(text(`**Contents:**\n${sub.contents.map(x => `- ${x}`).join('\n')}\n\n**Delivery:** ${sub.delivery}`));
  if (status === 'pending') {
    c.addActionRowComponents(row(
      new ButtonBuilder().setCustomId(`sub_approve:${sub.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`sub_reject:${sub.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger)));
  }
  return c;
}

function helpPanel() {
  const c = base();
  c.addTextDisplayComponents(text(
`## ${tag(E.logo)} ${cfg.brand} Commands
-# Members: commands only work in the **#commands** channel. Staff can use them anywhere.\n-# Every command works with \`/\` and with the \`${cfg.prefix}\` prefix, e.g. \`${cfg.prefix}claim\`, \`${cfg.prefix}close reason\`, \`${cfg.prefix}kick @user reason\`

**Everyone**
\`/myorder\` \`/queue view\` \`/review\` \`/link\` \`/unlink\` \`/suggest\` \`/remindme\` \`/userinfo\` \`/serverinfo\` \`/help\` \`/ping\`

**Staff (tickets and orders)**
\`/sticker\` \`/ticketclaim\` \`/ticketrename\` \`/ticketadd\` \`/ticketremove\` \`/ticketlock\` \`/ticketpriority\` \`/ticketinfo\` \`/tickets\` \`/close\` \`/transcript\` \`/remindclient\` \`/ai summarize|reply|quote|scope|update\`
\`/quote\` \`/invoice\` \`/progress\` \`/deadline\` \`/queue list|move\` \`/clientinfo\` \`/note add|view\` \`/submitpackage\`

**Moderation** (needs the matching staff role)
\`/warn\` \`/warnings\` \`/history\` \`/timeout\` \`/untimeout\` \`/kick\` \`/ban\` (proof required) \`/unban\` \`/jail\` \`/unjail\` \`/strikes\` \`/purge\` \`/slowmode\` \`/lockdown\`

**Admin** (Manage Server)
\`/setup roles|channels\` \`/status\` \`/package list|delete\` \`/portfolio add|remove\` \`/blacklist\` \`/stats\` \`/refund\` \`/faq add|remove\` \`/giveaway end|reroll\`

**Owner only**
\`/ownerpanel\` \`/setupsecurity\` \`/addword\` \`/removeword\`
Panels & embeds: \`/market post\` \`/setup dashboard|services\` \`/setupserver\` \`/staffinfo\` \`/announce\` \`/say\` \`/portfolio show\` \`/faq post\` \`/livestats\` \`/reviews\` \`/giveaway start\` \`/package create\``));
  return foot(c);
}

// plain helper for small ephemeral replies / simple panels
function note(s) { const c = new ContainerBuilder(); c.addTextDisplayComponents(text(s)); return c; }

module.exports = {
  base, foot, sep, gallery,
  V2, EPH, NO_PING, msg, eph, note, row, text, brandBtn,
  dashboardPanel, guidelinesMessage, servicesPanel, orderSelect, welcomePanel,
  supportTicketPanel, orderTicketPanel, referencesPanel, claimedPanel, closeConfirm,
  ticketClosedDM: ticketClosedDMFull, transcriptLog, thanksPurchase, reviewPost,
  packagePost, paymentPanel, updatePanel,
  STATES, quotePanel, progressNotice, portfolioPanel, statsPanel, reviewsSummary, livePanel, submissionPanel, helpPanel,
};
