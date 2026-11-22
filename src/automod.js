// Auto-moderation (Wick style).
//  * Links in text are deleted and logged.
//  * Swearing = 1 strike. 3 strikes: 30m timeout · 6: 24h timeout · 9: kick · 12: temp ban · 15: permanent ban.
//  * Basic anti-spam and mass-mention protection.
// Owners are never touched. Staff are exempt from the link rule only. Extra exempt roles: AUTOMOD_EXEMPT_ROLE_IDS.
const { PermissionFlagsBits: P, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { db, save } = require('./db');
const ui = require('./ui');
const T = require('./tickets');
const ML = require('./modlog');
const F = require('./filter');
const { add, sc } = require('./commands');
const PERMS = require('./perms');
const SMART = require('./smartmod');          // smart layer: disguised swearing, scams, phishing, fake staff, images

const EPH = MessageFlags.Ephemeral;
const HOUR = 3600e3;
const LADDER = [
  { at: 3,  label: '30 minute timeout' },
  { at: 6,  label: '24 hour timeout' },
  { at: 9,  label: 'kick' },
  { at: 12, label: 'temporary ban' },
  { at: 15, label: 'permanent ban' },
];
const nextStep = n => LADDER.find(l => l.at > n);

const enabled = () => cfg.flag('AUTOMOD_ENABLED', true);
const extraWords = () => db.automod.words || [];
const allowedDomains = () => cfg.words('AUTOMOD_ALLOWED_LINK_DOMAINS').map(d => d.toLowerCase());
const exemptRole = m => cfg.ids('AUTOMOD_EXEMPT_ROLE_IDS').some(r => m.roles.cache.has(r));
const inTicket = ch => !!(T.parseTopic(ch) || (ch.isThread?.() && T.parseTopic(ch.parent)));

const flash = async (ch, text, ms = 8000) => {
  const w = await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => null);
  if (w) setTimeout(() => w.delete().catch(() => {}), ms);
};

// ---------------- strikes ----------------
async function applyStrike(client, member, { reason, kind, content, channel }) {
  const s = (db.strikes[member.id] = db.strikes[member.id] || { count: 0, history: [] });
  s.count++;
  s.history.push({ at: Date.now(), reason, kind, content: (content || '').slice(0, 200) });
  if (s.history.length > 25) s.history.shift();
  save();
  const n = s.count;
  const hit = LADDER.find(l => l.at === n) || (n > 15 ? LADDER[4] : null);
  const nxt = nextStep(n);
  let outcome = 'No punishment yet.';

  try {
    if (hit?.at === 3 || hit?.at === 6) {
      const ms = hit.at === 3 ? 30 * 60e3 : 24 * HOUR;
      if (member.moderatable) { await member.timeout(ms, `Auto-mod: ${n} strikes`); outcome = `**${hit.label}** applied.`; }
      else outcome = `Wanted to apply a ${hit.label} but I can't moderate this member (role hierarchy).`;
    } else if (hit?.at === 9) {
      await dmUser(member.user, `👢 You were **kicked** from **${cfg.brand}** for reaching **${n} auto-moderation strikes**.`);
      if (member.kickable) { await member.kick(`Auto-mod: ${n} strikes`); outcome = '**Kicked.**'; }
      else outcome = "Wanted to kick but I can't (role hierarchy).";
    } else if (hit?.at === 12) {
      const days = cfg.num('TEMPBAN_DAYS', 7);
      await dmUser(member.user, `🔨 You were **temporarily banned** from **${cfg.brand}** for **${days} day(s)** (${n} auto-moderation strikes).`);
      if (member.bannable) {
        await member.guild.members.ban(member.id, { reason: `Auto-mod: ${n} strikes (temp ban ${days}d)` });
        db.tempbans[member.id] = { until: Date.now() + days * 86400e3 }; save();
        outcome = `**Temp banned for ${days} day(s).**`;
      } else outcome = "Wanted to temp ban but I can't (role hierarchy).";
    } else if (hit?.at === 15) {
      await dmUser(member.user, `⛔ You were **permanently banned** from **${cfg.brand}** (${n} auto-moderation strikes).`);
      if (member.bannable) {
        await member.guild.members.ban(member.id, { reason: `Auto-mod: ${n} strikes (permanent)` });
        delete db.tempbans[member.id]; save();
        outcome = '**Permanently banned.**';
      } else outcome = "Wanted to ban but I can't (role hierarchy).";
    }
  } catch (e) { outcome = `Punishment failed: ${e.message}`; }

  if (hit && (hit.at === 3 || hit.at === 6) && outcome.includes('applied'))
    await dmUser(member.user, `⏳ You reached **${n} auto-moderation strikes** in **${cfg.brand}** and received a **${hit.label}**.${nxt ? `\nAt **${nxt.at} strikes** you get a **${nxt.label}**.` : ''}`);
  if (!hit) await dmUser(member.user,
    `🚫 **Strike ${n}/15** in **${cfg.brand}**: ${reason}.\n${nxt ? `At **${nxt.at} strikes** you get a **${nxt.label}**.` : ''}\nPlease follow the server guidelines.`);
  await ML.record(client, {
    action: 'automod', modId: null, user: member.user, reason: `${reason} (strike ${n}/15)`,
    extra: { text: `**Where:** <#${channel.id}>\n**Message:** ${content ? '||' + content.replace(/\|/g, '\\|').slice(0, 300) + '||' : '*(none)*'}\n**Outcome:** ${outcome}` },
  });
  return { n, outcome, hit };
}
const dmUser = (u, text) => u.send(ui.msg(ui.note(text))).catch(() => {});

// ---------------- anti spam ----------------
const recent = new Map(); // userId -> [{ t, c, id }]
function spamCheck(m) {
  const now = Date.now();
  const arr = (recent.get(m.author.id) || []).filter(x => now - x.t < 15000);
  arr.push({ t: now, c: m.content.toLowerCase(), id: m.id, ch: m.channel.id });
  recent.set(m.author.id, arr);
  if (arr.filter(x => now - x.t < 6000).length >= 6) return 'sending messages too fast';
  if (m.content.length > 5 && arr.filter(x => x.c === m.content.toLowerCase()).length >= 3) return 'repeating the same message';
  return null;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of recent) if (!v.some(x => n - x.t < 15000)) recent.delete(k); }, 60000).unref?.();

// ---------------- main message hook ----------------
// returns true when it acted on the message
async function onMessage(client, m) {
  if (!enabled() || !m.guild || m.author.bot || m.webhookId || !m.member) return false;
  if (cfg.isOwner(m.author.id) || exemptRole(m.member)) return false;
  const content = m.content || '';
  if (!content) return m.attachments.size ? await SMART.onMessage(client, m, { staff: T.isStaff(m.member) }) : false;   // image-only message
  const staff = T.isStaff(m.member) || ['warn', 'kick', 'ban', 'timeout'].some(g => PERMS.allowed(m.member, m.author.id, g));
  // a staff member typing a prefix command (e.g. "-warn @user said <swear>") is not auto-moderated
  if (staff && content.startsWith(cfg.prefix)) return false;

  // 1. links
  if (!staff && cfg.flag('AUTOMOD_BLOCK_LINKS', true) && !inTicket(m.channel) && !cfg.ids('AUTOMOD_LINK_CHANNEL_IDS').includes(m.channelId)) {
    const bad = F.findLinks(content).filter(l => !F.linkAllowed(l, allowedDomains()));
    if (bad.length) {
      await m.delete().catch(() => {});
      flash(m.channel, `🔗 <@${m.author.id}> links aren't allowed here.`);
      await ML.record(client, {
        action: 'automod', modId: null, user: m.author, reason: 'Posted a link',
        extra: { text: `**Where:** <#${m.channelId}>\n**Link(s):** ${bad.slice(0, 3).map(l => `\`${l.replace(/`/g, '').slice(0, 100)}\``).join(', ')}\n**Message:** ||${content.replace(/\|/g, '\\|').slice(0, 300)}||` },
      });
      if (cfg.flag('AUTOMOD_LINK_STRIKES', false)) await applyStrike(client, m.member, { reason: 'Posted a link', kind: 'link', content, channel: m.channel });
      return true;
    }
  }

  // 2. swearing -> strike
  const word = F.findBadWord(content, extraWords());
  if (word) {
    await m.delete().catch(() => {});
    const { n } = await applyStrike(client, m.member, { reason: 'Inappropriate language', kind: 'swear', content, channel: m.channel });
    flash(m.channel, `🚫 <@${m.author.id}> watch your language. **Strike ${n}/15.**`);
    return true;
  }

  // 2b. smart layer (see smartmod.js)
  if (await SMART.onMessage(client, m, { staff })) return true;

  // 3. mass mentions + spam (timeout 10 minutes)
  if (cfg.flag('AUTOMOD_ANTISPAM', true) && !staff) {
    const mentions = m.mentions.users.size + m.mentions.roles.size;
    const why = mentions >= 5 ? 'mass mentioning' : spamCheck(m);
    if (why) {
      await m.delete().catch(() => {});
      for (const x of recent.get(m.author.id) || []) if (x.id !== m.id) m.channel.messages.delete(x.id).catch(() => {});
      recent.delete(m.author.id);
      if (m.member.moderatable) await m.member.timeout(10 * 60e3, `Auto-mod: ${why}`).catch(() => {});
      flash(m.channel, `⏳ <@${m.author.id}> was timed out for 10 minutes: ${why}.`);
      await ML.record(client, { action: 'automod', modId: null, user: m.author, reason: `Spam: ${why}`, extra: { text: `**Where:** <#${m.channelId}>\n**Outcome:** 10 minute timeout.` } });
      return true;
    }
  }
  return false;
}

// ---------------- temp bans ----------------
async function tick(client) {
  const now = Date.now();
  for (const [id, b] of Object.entries(db.tempbans)) {
    if (b.until > now) continue;
    delete db.tempbans[id]; save();
    const g = await client.guilds.fetch(cfg.guildId).catch(() => null);
    await g?.members.unban(id, 'Auto-mod temp ban expired').catch(() => {});
    const u = await client.users.fetch(id).catch(() => ({ id, tag: id }));
    await ML.record(client, { action: 'unban', modId: null, user: u, reason: 'Temp ban expired (auto-mod)' });
  }
}

// ---------------- commands ----------------
add(sc('strikes').setDescription('Auto-moderation strikes')
  .addSubcommand(s => s.setName('view').setDescription('See a member\'s strikes')
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
  .addSubcommand(s => s.setName('add').setDescription('Give a manual strike')
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(200)))
  .addSubcommand(s => s.setName('remove').setDescription('Remove one strike')
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
  .addSubcommand(s => s.setName('clear').setDescription('Clear all strikes')
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))),
async i => {
  const u = i.options.getUser('user'); const sub = i.options.getSubcommand();
  const s = db.strikes[u.id];
  if (sub === 'view') {
    const n = s?.count || 0; const nxt = nextStep(n);
    const h = (s?.history || []).slice(-8).reverse().map(x => `• <t:${Math.floor(x.at / 1000)}:d> ${x.reason}`).join('\n');
    return i.reply({ flags: EPH, allowedMentions: { parse: [] }, content: `**${u.tag}** has **${n}/15** strikes.${nxt ? ` Next: **${nxt.label}** at ${nxt.at}.` : ''}\n${h || 'No strikes.'}` });
  }
  if (sub === 'add') {
    const m = await i.guild.members.fetch(u.id).catch(() => null);
    if (!m) return i.reply({ content: 'Member not found.', flags: EPH });
    if (cfg.isOwner(u.id)) return i.reply({ content: "You can't strike an owner.", flags: EPH });
    const r = await applyStrike(i.client, m, { reason: `Manual strike by ${i.user.tag}: ${i.options.getString('reason')}`, kind: 'manual', content: '', channel: i.channel });
    return i.reply({ content: `Strike added. **${u.tag}** now has **${r.n}/15**. ${r.outcome}`, flags: EPH });
  }
  if (sub === 'remove') {
    if (!s?.count) return i.reply({ content: 'They have no strikes.', flags: EPH });
    s.count--; s.history.pop(); save();
    await ML.line(i.client, `<@${i.user.id}> removed a strike from <@${u.id}> (now ${s.count}).`);
    return i.reply({ content: `Removed a strike. **${u.tag}** now has **${s.count}/15**.`, flags: EPH });
  }
  delete db.strikes[u.id]; save();
  await ML.line(i.client, `<@${i.user.id}> cleared all strikes for <@${u.id}>.`);
  i.reply({ content: `Cleared strikes for **${u.tag}**.`, flags: EPH });
});

add(sc('addword').setDescription('Owner: add a word to the auto-mod swear list')
  .addStringOption(o => o.setName('word').setDescription('Word').setRequired(true).setMaxLength(40)),
async i => {
  const w = i.options.getString('word').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  if (!w) return i.reply({ content: 'Invalid word.', flags: EPH });
  if (!db.automod.words.includes(w)) db.automod.words.push(w); save();
  i.reply({ content: `Added **${w}** to the swear list.`, flags: EPH });
});
add(sc('removeword').setDescription('Owner: remove a word you added to the swear list')
  .addStringOption(o => o.setName('word').setDescription('Word').setRequired(true).setMaxLength(40)),
async i => {
  const w = i.options.getString('word').toLowerCase().trim();
  const had = db.automod.words.includes(w); db.automod.words = db.automod.words.filter(x => x !== w); save();
  i.reply({ content: had ? `Removed **${w}**.` : 'That word is not in your custom list (built-in words cannot be removed).', flags: EPH });
});

module.exports = { onMessage, tick, applyStrike, LADDER };
