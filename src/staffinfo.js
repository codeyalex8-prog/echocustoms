// /staffinfo (-staffinfo): posts the "Staff Information" panel with a topic dropdown. Owner only (see perms.js).
// Picking a topic shows it privately (only the person who clicked sees it).
const { StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { db, save } = require('./db');
const ui = require('./ui');
const T = require('./tickets');
const { add, sc } = require('./commands');
const { E, tag } = require('./emojis');

const EPH = MessageFlags.Ephemeral;
const P = cfg.prefix;

// ---------- the topics (edit the text here) ----------
const TOPICS = {
  guidelines: {
    label: 'Staff Guidelines', description: 'The rules every staff member follows', emoji: () => E.thumbsup,
    title: () => `${tag(E.thumbsup)} Staff Guidelines`,
    body: () => [
      'Be professional and respectful with clients and with each other.',
      'Claim a ticket before you help (Claim button or **/ticketclaim**). Do not answer tickets another staff member has claimed.',
      'Never share client information, files or source code outside the ticket. Never ask for passwords or tokens.',
      'Send a **/quote** and wait for the client to accept before starting work. Use **/invoice** for payment.',
      'Keep **/progress** updated and set a **/deadline** on every order.',
      'Use **/ticketpriority** for urgent tickets instead of pinging the team.',
      'Never promise refunds, discounts or turnaround times without owner approval.',
      'Close tickets with a clear reason. Only mark an order successful once it is delivered and the client is happy.',
      'Use **/note** to leave context about a client for the rest of the team.',
      'Report abuse or anything unusual to the owner straight away.',
      '**Warn, kick, ban and note** need the matching staff role. **A ban always needs proof** (screenshot, file or link). The proof is posted in the staff logs.',
      'The auto-moderator hands out **strikes** for swearing: 3 strikes = 30m timeout, 6 = 24h timeout, 9 = kick, 12 = temp ban, 15 = permanent ban. Do not remove strikes without a reason.',
      'Use **/jail** for someone who is out of control. Do not abuse it.',
    ],
  },
  expectations: {
    label: 'Staff Expectations', description: 'What we expect from you', emoji: () => E.star,
    title: () => `${tag(E.star)} Staff Expectations`,
    body: () => [
      'Reply to new tickets as quickly as you can (aim for within 12 hours).',
      'Stay active. If you will be away, tell the owner beforehand.',
      'Quality assurance: test everything and compare it against the client\'s references before moving an order to **Testing**, then **Delivered**.',
      "Follow the client's description and references. Ask in the ticket if something is unclear.",
      'Meet your deadlines, and if one is at risk tell the client early.',
      'Keep tickets clean and calm. No arguing, no drama in front of clients.',
      'Help newer staff and share what you learn.',
      'Represent the studio well everywhere in the server.',
    ],
  },
  staffcmds: {
    label: 'Staff Commands', description: 'Staff and quality assurance (ticket team)', emoji: () => E.pc,
    title: () => `${tag(E.pc)} Staff & Quality Assurance Commands`,
    raw: () =>
`**Tickets**
• **/ticketclaim**, **/ticketrename**, **/ticketadd**, **/ticketremove**
• **/ticketlock**, **/ticketpriority**, **/ticketinfo**, **/tickets**
• **/close**, **/transcript**, **/remindclient**
• **/sticker message|remove|list**: keep a message at the bottom of a channel

**Orders**
• **/quote**, **/invoice**, **/progress**, **/deadline**
• **/queue list**, **/queue move**
• **/clientinfo**, **/note add**, **/note view**, **/submitpackage**

**Moderation** (needs the matching staff role)
• **/warn**, **/warnings**, **/history**, **/timeout**, **/untimeout**, **/kick**
• **/ban** and **/unban** (a ban needs **proof**: attach an image or add a link)
• **/jail**, **/unjail**, **/strikes view|add|remove|clear**
• **/purge**, **/slowmode**, **/lockdown**

**Short commands:** every command also works with the \`${P}\` prefix, for example \`${P}claim\`, \`${P}close reason\`, \`${P}kick @user reason\`, \`${P}ban @user reason <proof link or image>\`, \`${P}warn @user reason\`, \`${P}jail @user reason\`.`,
  },
  ownercmds: {
    label: 'Owner Commands', description: 'Owner and admin only', emoji: () => E.logo,
    title: () => `${tag(E.logo)} Owner & Admin Commands`,
    raw: () =>
`**Owner only**
• **/ownerpanel**: live control panel (locked to the owner ID)
• **/setupsecurity**: creates the Prisoner role and locks it out of every channel
• **/addword**, **/removeword**: edit the auto-mod swear list

**Panels & embeds** (owner only)
• **/market post**, **/setup dashboard|services**, **/setupserver**, **/staffinfo**
• **/announce**, **/say**, **/portfolio show**, **/faq post**
• **/livestats**, **/reviews**, **/giveaway start**, **/package create**

**Admin** (needs Manage Server)
• **/setup roles|channels**, **/status**
• **/package list|delete**, **/portfolio add|remove**
• **/blacklist**, **/stats**, **/refund**, **/faq add|remove**, **/giveaway end|reroll**`,
  },
  everyone: {
    label: 'Everyone Commands', description: 'Commands any member can use', emoji: () => E.person,
    title: () => `${tag(E.person)} Everyone Commands`,
    raw: () =>
`• **/myorder**: your open orders, queue position and progress
• **/queue view**: your spot in the queue (inside your order)
• **/review**: leave a review (clients)
• **/link** and **/unlink**: your Roblox account
• **/suggest**, **/remindme**
• **/userinfo**, **/serverinfo**, **/help**, **/ping**

-# Every command also works with the \`${P}\` prefix, for example \`${P}myorder\`, \`${P}ping\`, \`${P}help\`.`,
  },
};

const bullets = arr => arr.map(x => `• ${x}`).join('\n');

function panel() {
  const c = ui.base();
  c.addTextDisplayComponents(ui.text(
    `## ${tag(E.logo)} Staff Information\n> Pick a topic from the dropdown to read it. Everything here is for **${cfg.brand}** staff.\n\n-# ${tag(E.megaphone)} Questions? Ask the owner.`));
  c.addActionRowComponents(ui.row(new StringSelectMenuBuilder().setCustomId('staffinfo_select').setPlaceholder('Select a topic')
    .addOptions(Object.entries(TOPICS).map(([value, t]) => ({ label: t.label, value, description: t.description, emoji: t.emoji() })))));
  return ui.foot(c);
}

function topicMessage(key) {
  const t = TOPICS[key];
  const c = ui.base();
  c.addTextDisplayComponents(ui.text(`## ${t.title()}\n${t.body ? bullets(t.body()) : t.raw()}`));
  return ui.foot(c);
}

add(sc('staffinfo').setDescription('Owner: post the Staff Information panel here'), async i => {
  const m = await i.channel.send(ui.msg(panel()));
  db.panels.staffinfo = { channelId: i.channelId, messageId: m.id }; save();
  if (i.isPrefix) return i.message.delete().catch(() => {});
  await i.reply({ content: 'Staff Information panel posted.', flags: EPH });
});

async function onSelect(i) {
  if (i.customId !== 'staffinfo_select') return false;
  const ok = cfg.isOwner(i.user.id) || !cfg.roles.staff || T.isStaff(i.member);
  if (!ok) { await i.reply({ content: 'This is for staff only.', flags: EPH }); return true; }
  const key = i.values[0];
  if (!TOPICS[key]) { await i.reply({ content: 'Unknown topic.', flags: EPH }); return true; }
  await i.reply(ui.eph(topicMessage(key)));
  return true;
}

module.exports = { onSelect, panel };
