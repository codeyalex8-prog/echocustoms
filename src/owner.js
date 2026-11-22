// Owner-only control center: /ownerpanel
// One posted message with a page menu at the top (Discord allows at most 40 components per message, so it is split into pages):
//   Home · Bot · Security & prison · Protection · AI · AI engine · Tickets · Setup check · Digest · Profile · System
// Only the OWNER_ID account(s) can press anything. The posted panel refreshes itself every minute.
const {
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, AttachmentBuilder, MessageFlags, PermissionFlagsBits: P,
} = require('discord.js');
const cfg = require('./config');
const { db, save, svcState } = require('./db');
const ui = require('./ui');
const T = require('./tickets');
const AI = require('./ai');
const PR = require('./presence');
const DG = require('./digest');
const SM = require('./smartmod');
const AIT = require('./aitools');
const SEC = require('./security');
const SYS = require('./sysinfo');
const { add, sc } = require('./commands');
const { E, tag } = require('./emojis');

const EPH = MessageFlags.Ephemeral;
const ICON = { open: '🟢 Open', delayed: '🟡 Delayed', closed: '🔴 Closed' };
const isOwner = i => cfg.ownerIds.includes(i.user.id);
const btn = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const onoff = v => (v ? 'ON' : 'OFF');
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

// runtime switches (stored in db.toggles, they beat .env)
const TOGGLES = {
  AUTOMOD_ENABLED: ['Auto-mod', true], AUTOMOD_BLOCK_LINKS: ['Link block', true], AUTOMOD_ANTISPAM: ['Anti-spam', true], RAID_ENABLED: ['Anti-raid', true],
  SMARTMOD_ENABLED: ['Smart-mod', true], SMARTMOD_TEXT_AI: ['AI text', true], SMARTMOD_IMAGES: ['Image scan', true], SMARTMOD_IMPERSONATION: ['Impersonation', true],
  DIGEST_ENABLED: ['Weekly digest', true],
  AIT_SUMMARY: ['Ticket summaries', true],
  RAID_DM_OWNERS: ['DM owners on raid', true],
};
const flag = k => cfg.flag(k, TOGGLES[k][1]);
const tog = k => btn(`own_tog:${k}`, `${TOGGLES[k][0]}: ${onoff(flag(k))}`, flag(k) ? ButtonStyle.Success : ButtonStyle.Danger);

// one-tap bot visibility (online / idle / do not disturb / invisible) + custom status text
function statusRow() {
  const cur = PR.effectiveStatus();
  const b = (v, label) => btn(`own_ps:${v}`, label, cur === v ? ButtonStyle.Success : ButtonStyle.Secondary);
  return ui.row(b('online', '🟢 Online'), b('idle', '🌙 Idle'), b('dnd', '⛔ Do Not Disturb'), b('invisible', '⚫ Invisible'), btn('own_pres_custom', '💬 Custom status', ButtonStyle.Primary));
}

const PAGES = [
  { v: 'home', label: 'Home', e: 'logo', d: 'Overview, services, queue, quick actions' },
  { v: 'presence', label: 'Bot', e: 'bell', d: 'Visibility (online/idle/dnd/invisible), status, activity, profile, info' },
  { v: 'security', label: 'Security & prison', e: 'moderator', d: 'Immune list, jailed, release, anti-raid, security check' },
  { v: 'protect', label: 'Protection & auto-mod', e: 'moderator', d: 'Auto-mod, links, spam, maintenance, commands on/off' },
  { v: 'ai', label: 'AI (auto-mod + summaries)', e: 'superstar', d: 'Smart-mod AI, image scan, ticket summaries' },
  { v: 'engine', label: 'AI engine', e: 'superstar', d: 'Providers (Groq / Grok / Gemini), speed test, limits' },
  { v: 'tickets', label: 'Tickets', e: 'schedule', d: 'Open tickets, latest summaries, queue' },
  { v: 'config', label: 'Setup check', e: 'spec', d: 'Every channel, role and category: found or missing' },
  { v: 'digest', label: 'Weekly digest', e: 'schedule', d: 'Report schedule and channel' },
  { v: 'profile', label: 'Bot profile', e: 'person', d: 'Name, avatar, banner, nickname, about me' },
  { v: 'system', label: 'System', e: 'spec', d: 'Diagnostics, backups, restart' },
];
const page = () => (PAGES.some(p => p.v === db.panels.owner?.page) ? db.panels.owner.page : 'home');

// ---------------- panel pages ----------------
function header(c, cur, sub) {
  c.addTextDisplayComponents(ui.text(`## ${tag(E[PAGES.find(p => p.v === cur).e])} Owner Panel · ${PAGES.find(p => p.v === cur).label}\n-# ${sub || 'Only the owners can use this'} · refreshed <t:${Math.floor(Date.now() / 1000)}:T>`));
  c.addActionRowComponents(ui.row(new StringSelectMenuBuilder().setCustomId('own_nav').setPlaceholder('Go to page...').addOptions(
    PAGES.map(p => ({ label: p.label, value: p.v, emoji: E[p.e], description: p.d, default: p.v === cur })))));
  c.addSeparatorComponents(ui.sep());
}

function pageHome(c) {
  const s = db.stats;
  c.addTextDisplayComponents(ui.text(
    `### Today at a glance\n**Security:** ${flag('RAID_ENABLED') ? '🟢 anti-raid ON' : '🔴 anti-raid OFF'} · **Jailed:** ${Object.keys(db.jailed).length} · **Auto-mod:** ${flag('AUTOMOD_ENABLED') ? '🟢' : '🔴'} · **AI:** ${AI.available() ? '🟢 ready' : '🔴 off'}\n\n### Services\n` + Object.values(cfg.services).map(v => `${tag(E[v.emoji])} ${v.label}: ${ICON[svcState(v.key)]}`).join('\n') +
    `\n\n**Open tickets:** ${Object.keys(db.tickets).length} · **Queue:** ${db.queue.length} · **Blacklisted:** ${Object.keys(db.blacklist).length}` +
    `\n**Packages:** ${Object.keys(db.packages).length} · **Sold:** ${s.packageSales || 0} · **Robux:** ${(s.robuxEarned || 0).toLocaleString('en-US')} R$` +
    `\n**Pending submissions:** ${Object.keys(db.submissions).length} · **Orders done:** ${s.ordersSuccessful || 0}` +
    (db.maintenance?.on ? `\n\n${tag(E.spec)} **Maintenance mode is ON**`+' (only owners can use the bot).' : '')));
  c.addSeparatorComponents(ui.sep());
  const statusOpts = [];
  for (const v of [...Object.values(cfg.services), { key: 'all', label: 'ALL services' }])
    for (const st of ['open', 'delayed', 'closed']) statusOpts.push({ label: `${v.label}: ${st}`, value: `${v.key}:${st}` });
  c.addActionRowComponents(ui.row(new StringSelectMenuBuilder().setCustomId('own_status').setPlaceholder('Set service status').addOptions(statusOpts)));
  c.addActionRowComponents(ui.row(new StringSelectMenuBuilder().setCustomId('own_action').setPlaceholder('Quick actions').addOptions(
    { label: 'Post dashboard here', value: 'dash' }, { label: 'Post services panel here', value: 'services' }, { label: 'Post live stats here', value: 'live' },
    { label: 'Post reviews summary here', value: 'reviews' }, { label: 'Clear pending package submissions', value: 'clearsubs' }, { label: 'Clear queue of dead channels', value: 'fixqueue' })));
  c.addActionRowComponents(ui.row(btn('own_refresh', 'Refresh', ButtonStyle.Primary), btn('own_all:open', 'Open All', ButtonStyle.Success),
    btn('own_all:delayed', 'Delay All'), btn('own_all:closed', 'Close All', ButtonStyle.Danger), btn('own_backup', 'Backup DB')));
  c.addActionRowComponents(ui.row(btn('own_say', 'Say'), btn('own_bl', 'Blacklist'), btn('own_ubl', 'Unblacklist'), btn('own_pkgs', 'Packages'), btn('own_queue', 'Queue')));
}

function botInfo(client) {
  const g = client.guilds.cache.get(cfg.guildId);
  const mem = Math.round(process.memoryUsage().rss / 1048576);
  return `**Bot:** ${client.user.tag} · **Ping:** ${Math.round(client.ws.ping)}ms · **Uptime:** ${SYS.uptimeText(process.uptime())}\n` +
    `**Servers:** ${client.guilds.cache.size} · **Members:** ${(g?.memberCount || 0).toLocaleString('en-US')} · **Memory:** ${mem} MB · **Maintenance:** ${db.maintenance?.on ? 'ON' : 'off'}\n` +
    `**Open tickets:** ${Object.keys(db.tickets).length} · **Services:** ${Object.values(cfg.services).map(v => `${v.label} ${svcState(v.key)}`).join(' · ')}\n\n`;
}

function pagePresence(c, client) {
  c.addTextDisplayComponents(ui.text(botInfo(client) + PR.describe(client)));
  c.addSeparatorComponents(ui.sep());
  const cur = PR.P();
  c.addActionRowComponents(statusRow());
  c.addActionRowComponents(ui.row(new StringSelectMenuBuilder().setCustomId('own_pres_type').setPlaceholder('Activity type').addOptions(
    Object.entries(PR.TYPE_LABEL).map(([v, l]) => ({ label: l, value: v, default: cur.type === v })))));
  c.addActionRowComponents(ui.row(new StringSelectMenuBuilder().setCustomId('own_pres_preset').setPlaceholder('Quick presets').addOptions(
    Object.entries(PR.PRESETS).map(([v, p]) => ({ label: p.label, value: v })))));
  c.addActionRowComponents(ui.row(
    btn('own_pres_text', 'Set activity text', ButtonStyle.Primary),
    btn('own_pres_rot', `Rotation: ${onoff(cur.rotate.on)}`, cur.rotate.on ? ButtonStyle.Success : ButtonStyle.Secondary),
    btn('own_pres_rotedit', 'Edit rotation list'),
    btn('own_pres_auto', `Auto status: ${onoff(cur.auto)}`, cur.auto ? ButtonStyle.Success : ButtonStyle.Secondary),
    btn('own_pres_reset', 'Reset', ButtonStyle.Danger)));
  c.addActionRowComponents(ui.row(btn('own_prof_name', 'Username'), btn('own_prof_avatar', 'Avatar'), btn('own_prof_banner', 'Banner'),
    btn('own_prof_nick', 'Server nickname'), btn('own_prof_about', 'About me')));
  c.addActionRowComponents(ui.row(btn('own_maint', `Maintenance: ${onoff(db.maintenance?.on)}`, db.maintenance?.on ? ButtonStyle.Danger : ButtonStyle.Secondary),
    btn('own_all:open', 'Open all services', ButtonStyle.Success), btn('own_all:closed', 'Close all services', ButtonStyle.Danger),
    btn('own_backup', 'Backup DB'), btn('own_refresh', 'Refresh', ButtonStyle.Primary)));
}

function pageProfile(c, client) {
  const u = client.user;
  c.addTextDisplayComponents(ui.text(
    `**Name:** ${u.username} · **Server nickname:** ${client.guilds.cache.get(cfg.guildId)?.members.me?.nickname || '*none*'}\n` +
    `**Avatar:** ${u.avatar ? '[current](' + u.displayAvatarURL({ size: 512 }) + ')' : 'default'} · **Banner:** ${u.banner ? 'set' : 'none'}\n` +
    `-# Discord limits username changes (about 2 per hour). Avatar and banner need a direct https image link (png, jpg, gif or webp).`));
  c.addSeparatorComponents(ui.sep());
  c.addActionRowComponents(ui.row(btn('own_prof_name', 'Username'), btn('own_prof_avatar', 'Avatar'), btn('own_prof_banner', 'Banner'),
    btn('own_prof_nick', 'Server nickname'), btn('own_prof_about', 'About me')));
  c.addActionRowComponents(ui.row(btn('own_prof_nickreset', 'Reset nickname')));
}

function pageProtect(c) {
  const sec = db.security?.level || 'medium';
  const off = Object.keys(db.disabledCmds || {});
  c.addTextDisplayComponents(ui.text(
    `**Auto-mod:** ${onoff(flag('AUTOMOD_ENABLED'))} · **Links:** ${onoff(flag('AUTOMOD_BLOCK_LINKS'))} · **Anti-spam:** ${onoff(flag('AUTOMOD_ANTISPAM'))} · **Anti-raid:** ${onoff(flag('RAID_ENABLED'))} (level **${sec}**)\n` +
    `**Maintenance mode:** ${db.maintenance?.on ? `${tag(E.spec)} ON, only owners can use the bot` : 'off'}\n` +
    `**Disabled commands:** ${off.length ? off.map(x => `\`/${x}\``).join(' ') : 'none'}\n` +
    `**Custom banned words:** ${db.automod?.words?.length || 0} · **Members with strikes:** ${Object.keys(db.strikes).length} · **Jailed:** ${Object.keys(db.jailed).length} · **Temp bans:** ${Object.keys(db.tempbans).length}\n` +
    `-# Switches here beat the .env file and are remembered after a restart.`));
  c.addSeparatorComponents(ui.sep());
  c.addActionRowComponents(ui.row(tog('AUTOMOD_ENABLED'), tog('AUTOMOD_BLOCK_LINKS'), tog('AUTOMOD_ANTISPAM'), tog('RAID_ENABLED'),
    btn('own_maint', `Maintenance: ${onoff(db.maintenance?.on)}`, db.maintenance?.on ? ButtonStyle.Danger : ButtonStyle.Secondary)));
  c.addActionRowComponents(ui.row(new StringSelectMenuBuilder().setCustomId('own_sec_level').setPlaceholder('Anti-raid strictness').addOptions(
    ['low', 'medium', 'high'].map(v => ({ label: `Security level: ${v}`, value: v, default: v === sec })))));
  c.addActionRowComponents(ui.row(btn('own_word_add', 'Add banned word'), btn('own_word_rm', 'Remove word'), btn('own_strike_clear', 'Clear user strikes'),
    btn('own_cmd_off', 'Disable a command'), btn('own_cmd_on', 'Enable a command')));
}

function pageAI(c) {
  const a = AI.state(); const s = SM.S();
  c.addTextDisplayComponents(ui.text(
    `**AI:** ${AI.available() ? '🟢 ready' : `🔴 ${AI.why()}`} · **Today:** ${a.calls}/${a.limit} calls · ${(a.tokensIn + a.tokensOut).toLocaleString('en-US')} tokens\n` +
    `**Models:** fast \`${AI.MODELS.fast}\` · smart \`${AI.MODELS.smart}\`${a.lastError ? `\n**Last AI error:** ${clip(a.lastError, 120)}` : ''}\n\n` +
    SM.statusText().replace(/^## .*\n/, '') +
    `\n-# Sensitivity: low = only very sure catches, high = catches more but may need more false-positive fixes. AI scope: suspicious = only messages that look odd (cheapest), newmembers = also anything from new accounts, all = every message (expensive).`));
  c.addSeparatorComponents(ui.sep());
  c.addActionRowComponents(ui.row(
    btn('own_ai_master', `AI: ${onoff(a.enabled)}`, a.enabled ? ButtonStyle.Success : ButtonStyle.Danger),
    tog('SMARTMOD_ENABLED'), tog('SMARTMOD_TEXT_AI'), tog('SMARTMOD_IMAGES'), tog('SMARTMOD_IMPERSONATION')));
  c.addActionRowComponents(ui.row(tog('AIT_SUMMARY')));
  const choose = (id, ph, cur, opts) => ui.row(new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(ph).addOptions(opts.map(([v, l]) => ({ label: l, value: v, default: v === cur }))));
  c.addActionRowComponents(choose('own_sm_sens', 'Sensitivity', s.sensitivity, [['low', 'Sensitivity: low (safest)'], ['medium', 'Sensitivity: medium'], ['high', 'Sensitivity: high (strict)']]));
  c.addActionRowComponents(choose('own_sm_scope', 'What the AI looks at', s.scope, [['suspicious', 'AI scope: suspicious messages only'], ['newmembers', 'AI scope: + new members'], ['all', 'AI scope: every message']]));
  c.addActionRowComponents(choose('own_sm_scam', 'Scam / phishing punishment', s.scamAction, [['log', 'Scam: delete + log only'], ['timeout', 'Scam: delete + 24h timeout'], ['strike', 'Scam: delete + strike'], ['ban', 'Scam: delete + ban when very sure']]));
  c.addActionRowComponents(choose('own_sm_imp', 'Impersonation punishment', s.impAction, [['alert', 'Impersonator: alert staff only'], ['rename', 'Impersonator: rename + alert'], ['jail', 'Impersonator: jail + alert']]));
  c.addActionRowComponents(ui.row(btn('own_ai_test', 'Test AI'), btn('own_sm_test', 'Test a message'), btn('own_sm_scan', 'Scan members'), btn('own_sm_trust', 'Trust user'), btn('own_ai_limit', 'Daily AI limit')));
}

function pageEngine(c) {
  const a = AI.state(); const k = AI.keys();
  const prov = { auto: 'Auto (Groq first, then Grok, then Gemini)', groq: 'Groq only', xai: 'Grok (xAI) only', gemini: 'Gemini only' }[a.provider];
  c.addTextDisplayComponents(ui.text(
    `**AI:** ${AI.available() ? '🟢 ready' : `🔴 ${AI.why()}`} · **Provider mode:** ${prov}\n` +
    `**Groq** (free, fastest): ${k.groq ? '🟢 key set' : '⚪ no key (add `GROQ_API_KEY`, free at console.groq.com/keys)'} · models in order: ${AI.MODELS.groq.map(m => `\`${m}\``).join(' → ')}\n` +
    `**Grok (xAI)** (fast, paid credits): ${k.xai ? '🟢 key set' : '⚪ no key (add `XAI_API_KEY`)'} · models: ${AI.MODELS.xai.map(m => `\`${m}\``).join(' → ')}\n` +
    `**Gemini** (free, backup): ${k.gemini ? '🟢 key set' : '⚪ no key'} · \`${AI.MODELS.GEM.fast}\`\n` +
    `**Last used:** ${a.lastModel ? `\`${a.lastModel}\`${a.lastMs ? ` (${a.lastMs}ms)` : ''}` : 'nothing yet'}${a.lastError ? `\n**Last error:** ${clip(a.lastError, 160)}` : ''}\n` +
    `**Today:** ${a.calls}/${a.limit} calls · ${(a.tokensIn + a.tokensOut).toLocaleString('en-US')} tokens · ${a.errors} errors · **All time:** ${a.total.calls.toLocaleString('en-US')} calls\n` +
    `-# If one model hits its free limit the bot hops to the next one by itself. Press Speed test to see which is fastest right now. The AI is only used for support assistance (ticket assistant, /ask, ticket summaries).`));
  c.addSeparatorComponents(ui.sep());
  c.addActionRowComponents(ui.row(btn('own_ai_master', `AI: ${onoff(a.enabled)}`, a.enabled ? ButtonStyle.Success : ButtonStyle.Danger), btn('own_eng_speed', 'Speed test', ButtonStyle.Primary),
    btn('own_ai_test', 'Test AI'), btn('own_ai_limit', 'Daily AI limit'), btn('own_eng_reset', 'Retry all models')));
  c.addActionRowComponents(ui.row(new StringSelectMenuBuilder().setCustomId('own_ai_provider').setPlaceholder('Which provider to use').addOptions(
    [['auto', 'Auto: Groq first, then Grok, then Gemini'], ['groq', 'Groq only (free + fastest)'], ['xai', 'Grok (xAI) only'], ['gemini', 'Gemini only']].map(([v, l]) => ({ label: l, value: v, default: a.provider === v })))));
}

function pageTickets(c) {
  const all = Object.values(db.tickets || {});
  const by = t => all.filter(x => x.type === t).length;
  const oldest = all.reduce((m, t) => Math.min(m, t.openedAt || Date.now()), Date.now());
  const sums = AIT.A().summaries.slice(-4).reverse();
  c.addTextDisplayComponents(ui.text(
    `### Open now\n**Total:** ${all.length} · **Support:** ${by('support')} · **Orders:** ${by('order')} · **Market:** ${by('market')} · **Other:** ${all.length - by('support') - by('order') - by('market')}\n` +
    `**Oldest open:** ${all.length ? `<t:${Math.floor(oldest / 1000)}:R>` : '-'} · **Queue:** ${db.queue.length} · **Closed all-time:** ${db.stats.ticketsClosed || 0} · **Blacklisted:** ${Object.keys(db.blacklist).length}\n\n` +
    `### Latest AI summaries (${flag('AIT_SUMMARY') ? 'ON' : 'OFF'})\n` +
    (sums.length ? sums.map(x => `• **${clip(x.topic || x.name, 40)}** (${x.outcome || '?'}): ${clip(x.summary, 120)}`).join('\n') : '*None yet. A summary is written at the bottom of every transcript when a ticket closes.*')));
  c.addSeparatorComponents(ui.sep());
  c.addActionRowComponents(ui.row(btn('own_tk_list', 'List open tickets', ButtonStyle.Primary), tog('AIT_SUMMARY'), btn('own_queue', 'View queue'), btn('own_bl', 'Blacklist'), btn('own_refresh', 'Refresh')));
}

function pageSecurity(c, client) {
  const g = client.guilds.cache.get(cfg.guildId);
  const jailed = Object.entries(db.jailed || {});
  const imm = SEC.immuneIds();
  const role = g && SEC.getRole(g);
  c.addTextDisplayComponents(ui.text(
    `### Status\n**Anti-raid:** ${flag('RAID_ENABLED') ? '🟢 ON' : '🔴 OFF'} · **Level:** ${db.security?.level || 'medium'} · **Prisoner role:** ${role ? `<@&${role.id}>` : '⚪ not created yet'} · **Appeal channel:** ${db.security?.prisonChannelId ? `<#${db.security.prisonChannelId}>` : '⚪ not set'}\n` +
    `### Immune (only you control this, with /immune or the button below)\n${cfg.ownerIds.map(o => `<@${o}>`).join(' ')} *(owner)*${imm.length ? ' · ' + imm.map(x => `<@${x}>`).join(' ') : ''}\n` +
    `### Jailed (${jailed.length})\n${jailed.length ? jailed.slice(0, 8).map(([id, r]) => `<@${id}> · ${clip(r.reason, 60)} · <t:${Math.floor((r.at || Date.now()) / 1000)}:R>`).join('\n') + (jailed.length > 8 ? `\n*...and ${jailed.length - 8} more*` : '') : '*Nobody is in prison.*'}\n` +
    `-# Only owners can release prisoners or change who is immune.`));
  c.addSeparatorComponents(ui.sep());
  c.addActionRowComponents(ui.row(tog('RAID_ENABLED'), tog('RAID_DM_OWNERS'), btn('own_seccheck', 'Run security check', ButtonStyle.Primary), btn('own_secsetup', 'Create / lock Prisoner role'), btn('own_refresh', 'Refresh')));
  c.addActionRowComponents(ui.row(new StringSelectMenuBuilder().setCustomId('own_sec_level').setPlaceholder('Anti-raid strictness').addOptions(
    ['low', 'medium', 'high'].map(v => ({ label: `Security level: ${v}`, value: v, default: v === (db.security?.level || 'medium') })))));
  c.addActionRowComponents(ui.row(btn('own_imm', 'Add / remove immune', ButtonStyle.Success), btn('own_immlist', 'Immune list'), btn('own_jail', 'Jail user', ButtonStyle.Danger), btn('own_rel', 'Release user', ButtonStyle.Success), btn('own_jailed', 'Jailed list')));
}

function pageConfig(c, client) {
  const g = client.guilds.cache.get(cfg.guildId);
  const chk = (id, kind) => (!id ? '⚪ not set' : (kind === 'role' ? g?.roles.cache.has(id) : g?.channels.cache.has(id)) ? (kind === 'role' ? `✅ <@&${id}>` : `✅ <#${id}>`) : `❌ \`${id}\` not found`);
  const chans = Object.keys(cfg.channels).map(k => `**${k}:** ${chk(cfg.channels[k], 'ch')}`);
  const logs = ['staff', 'ban', 'automod', 'security'].map(k => `**${k} logs:** ${chk(cfg.logs[k], 'ch')}`);
  const roles = ['staff', 'client', 'member'].map(k => `**${k}:** ${chk(cfg.roles[k], 'role')}`).concat(['support', 'order'].map(k => `**${k} ping:** ${chk(cfg.pings[k], 'role')}`));
  const svcs = Object.values(cfg.services).map(v => `**${v.label}:** category ${chk(v.category, 'ch')} · ping ${chk(v.ping, 'role')}`);
  c.addTextDisplayComponents(ui.text(`### Channels\n${chans.join(' · ')}\n### Logs\n${logs.join(' · ')}\n### Roles\n${roles.join(' · ')}\n### Services\n${svcs.join('\n')}\n-# Missing items: run /setup roles and /setup channels, or fill them in .env and restart.`));
  c.addSeparatorComponents(ui.sep());
  c.addActionRowComponents(ui.row(btn('own_refresh', 'Re-check', ButtonStyle.Primary), btn('own_sys_cmds', 'Re-register commands'), btn('own_seccheck', 'Run security check')));
}

function pageDigest(c) {
  const s = DG.settings();
  c.addTextDisplayComponents(ui.text(`${DG.statusText().replace(/^## .*\n/, '')}\n\n-# Every number in the digest is counted by the bot. The digest is a plain template report (no AI).`));
  c.addSeparatorComponents(ui.sep());
  c.addActionRowComponents(ui.row(tog('DIGEST_ENABLED'),
    btn('own_dg_prev', 'Post preview now', ButtonStyle.Primary), btn('own_dg_post', 'Post now + new week'), btn('own_dg_sched', 'Set schedule')));
  c.addActionRowComponents(ui.row(btn('own_dg_here', 'Use this channel for digests')));
}

function pageSystem(c, client) {
  c.addTextDisplayComponents(ui.text(SYS.text(client)));
  c.addSeparatorComponents(ui.sep());
  c.addActionRowComponents(ui.row(btn('own_refresh', 'Refresh', ButtonStyle.Primary), btn('own_backup', 'Backup DB'), btn('own_sys_cmds', 'Re-register commands'),
    btn('own_sys_emoji', 'Reload emojis'), btn('own_sys_save', 'Force save')));
  c.addActionRowComponents(ui.row(btn('own_sys_dm', 'DM a user'), btn('own_sys_errors', 'Recent errors'), btn('own_sys_clearerr', 'Clear error list'),
    btn('own_sys_restart', 'Restart bot', ButtonStyle.Danger), btn('own_sys_shutdown', 'Shut down', ButtonStyle.Danger)));
}

function panel(client) {
  const cur = page();
  const c = ui.base();
  header(c, cur);
  ({ home: pageHome, presence: pagePresence, profile: pageProfile, protect: pageProtect, ai: pageAI, engine: pageEngine, tickets: pageTickets, digest: pageDigest, system: pageSystem, security: pageSecurity, config: pageConfig })[cur](c, client);
  return ui.foot(c);
}
const redraw = i => i.update({ components: [panel(i.client)], flags: ui.V2, allowedMentions: ui.NO_PING });
const say = (i, content) => i.followUp({ content, flags: EPH });

// refresh the posted panel (used after a modal, where there is no message to update)
async function refreshPosted(client) {
  const p = db.panels.owner; if (!p) return;
  try {
    const ch = await client.channels.fetch(p.channelId);
    await ch.messages.edit(p.messageId, { components: [panel(client)], flags: ui.V2, allowedMentions: ui.NO_PING });
  } catch (e) { if (e.code === 10008 || e.code === 10003) { delete db.panels.owner; save(); } }
}

async function setStatus(i, svc, state) {
  for (const k of svc === 'all' ? Object.keys(cfg.services) : [svc]) db.status[k] = state;
  save();
  await T.refreshServicesPanel(i.client);
  PR.apply(i.client).catch(() => {});
  T.log(i.client, `🚦 <@${i.user.id}> (owner panel) set **${svc}** to **${state.toUpperCase()}**.`);
}
const audit = (i, text) => T.log(i.client, `🎛️ <@${i.user.id}> (owner panel) ${text}`);

add(sc('ownerpanel').setDescription('Owner only: post the live control panel here').setDefaultMemberPermissions(P.Administrator),
  async i => {
    if (!isOwner(i)) return i.reply({ content: 'Owner only.', flags: EPH });
    const old = db.panels.owner;
    if (old) {
      const oc = await i.client.channels.fetch(old.channelId).catch(() => null);
      await oc?.messages.delete(old.messageId).catch(() => {});
    }
    const m = await i.channel.send(ui.msg(panel(i.client)));
    db.panels.owner = { channelId: i.channelId, messageId: m.id, page: 'home' }; save();
    await i.reply({ content: 'Owner panel posted. It refreshes every minute and has pages (use the menu at the top). Post it in a private channel.', flags: EPH });
  });

async function tick(client) { return refreshPosted(client); }

// ---------------- selects ----------------
async function onSelect(i) {
  if (!i.customId.startsWith('own_')) return false;
  if (!isOwner(i)) { await i.reply({ content: 'Owner only.', flags: EPH }); return true; }
  const v = i.values[0];
  const done = async () => { await redraw(i); };
  switch (i.customId) {
    case 'own_nav':
      db.panels.owner = { ...(db.panels.owner || { channelId: i.channelId, messageId: i.message.id }), page: v }; save(); await done(); return true;
    case 'own_status': { const [svc, st] = v.split(':'); await setStatus(i, svc, st); await done(); await say(i, `**${svc}** is now **${st.toUpperCase()}**.`); return true; }
    case 'own_pres_status': await PR.setStatus(i.client, v); audit(i, `set the bot status to **${v}**.`); await done(); return true;
    case 'own_pres_type': await PR.setType(i.client, v); await done(); return true;
    case 'own_pres_preset': await PR.applyPreset(i.client, v); audit(i, `applied the presence preset **${v}**.`); await done(); return true;
    case 'own_sec_level': db.security = db.security || {}; db.security.level = v; save(); audit(i, `set the anti-raid level to **${v}**.`); await done(); return true;
    case 'own_sm_sens': SM.S().sensitivity = v; save(); audit(i, `set smart-mod sensitivity to **${v}**.`); await done(); return true;
    case 'own_sm_scope': SM.S().scope = v; save(); await done(); return true;
    case 'own_sm_scam': SM.S().scamAction = v; save(); audit(i, `set the scam action to **${v}**.`); await done(); return true;
    case 'own_ai_provider': AI.state().provider = v; AI.resetCooldowns(); save(); audit(i, `set the AI provider mode to **${v}**.`); await done(); return true;
    case 'own_sm_imp': SM.S().impAction = v; save(); audit(i, `set the impersonation action to **${v}**.`); await done(); return true;
    case 'own_action': break;
    default: return true;
  }
  let msg = 'Done.';
  if (v === 'dash') { const m = await i.channel.send(ui.msg(ui.dashboardPanel())); db.panels.dashboard = { channelId: i.channelId, messageId: m.id }; save(); }
  else if (v === 'services') { const m = await i.channel.send(ui.msg(ui.servicesPanel())); db.panels.services = { channelId: i.channelId, messageId: m.id }; save(); }
  else if (v === 'live') { const m = await i.channel.send(ui.msg(ui.livePanel())); (db.panels.live = db.panels.live || []).push({ channelId: i.channelId, messageId: m.id }); save(); }
  else if (v === 'reviews') { const s = db.stats; await i.channel.send(ui.msg(ui.reviewsSummary(s.ratingCount ? s.ratingSum / s.ratingCount : 0, s.ratingCount))); }
  else if (v === 'clearsubs') { db.submissions = {}; save(); msg = 'Pending submissions cleared.'; }
  else if (v === 'fixqueue') {
    const keep = []; for (const id of db.queue) if (await i.client.channels.fetch(id).catch(() => null)) keep.push(id);
    msg = `Removed ${db.queue.length - keep.length} dead entries.`; db.queue = keep; save();
  }
  await redraw(i); await say(i, msg); return true;
}

// ---------------- buttons ----------------
const ROW = (id, label, style, max, req = true, ph = '', value = '') => ({ id, label, style: style || TextInputStyle.Short, max: max || 300, req, ph, value });
function showModal(i, cid, title, fields) {
  return i.showModal(new ModalBuilder().setCustomId(cid).setTitle(title).addComponents(...fields.map(f => {
    const t = new TextInputBuilder().setCustomId(f.id).setLabel(f.label).setStyle(f.style).setRequired(f.req).setMaxLength(f.max);
    if (f.ph) t.setPlaceholder(f.ph.slice(0, 100));
    if (f.value) t.setValue(String(f.value).slice(0, f.max));
    return new ActionRowBuilder().addComponents(t);
  })));
}
const P_ = TextInputStyle.Paragraph;

async function onButton(i) {
  if (!i.customId.startsWith('own_')) return false;
  if (!isOwner(i)) { await i.reply({ content: 'Owner only.', flags: EPH }); return true; }
  const [id, arg] = i.customId.split(':');
  const m = (cid, title, ...f) => showModal(i, cid, title, f);
  switch (id) {
    // ----- home (unchanged) -----
    case 'own_refresh': await redraw(i); return true;
    case 'own_all': await setStatus(i, 'all', arg); await redraw(i); await say(i, `All services set to **${arg.toUpperCase()}**.`); return true;
    case 'own_backup': await i.reply({ files: [new AttachmentBuilder(Buffer.from(JSON.stringify(db, null, 2)), { name: 'db-backup.json' })], flags: EPH }); return true;
    case 'own_say': await m('own_say_modal', 'Say something', ROW('text', 'Message', P_, 1800)); return true;
    case 'own_bl': await m('own_bl_modal', 'Blacklist a user', ROW('uid', 'User ID'), ROW('reason', 'Reason')); return true;
    case 'own_ubl': await m('own_ubl_modal', 'Unblacklist a user', ROW('uid', 'User ID')); return true;
    case 'own_pkgs': {
      const l = Object.values(db.packages).slice(-20).map(p => `**#${p.id}** ${p.name} · ${p.price} R$ · ${p.sales || 0} sold · <#${p.channelId}>`);
      await i.reply({ content: l.join('\n') || 'No packages yet.', flags: EPH, allowedMentions: { parse: [] } }); return true;
    }
    case 'own_queue': {
      const l = db.queue.slice(0, 25).map((c, n) => `**${n + 1}.** <#${c}>`);
      await i.reply({ content: l.join('\n') || 'Queue is empty.', flags: EPH, allowedMentions: { parse: [] } }); return true;
    }

    // ----- generic on/off switches -----
    case 'own_tog': {
      if (!TOGGLES[arg]) return true;
      db.toggles[arg] = !flag(arg); save(); audit(i, `switched **${TOGGLES[arg][0]}** ${onoff(db.toggles[arg])}.`); await redraw(i); return true;
    }
    case 'own_maint':
      db.maintenance = { on: !db.maintenance?.on, since: Date.now(), by: i.user.id }; save();
      audit(i, `turned maintenance mode ${onoff(db.maintenance.on)}.`);
      if (db.maintenance.on) { PR.P().status = 'dnd'; PR.P().auto = false; PR.P().type = 'custom'; PR.P().text = '🔧 Maintenance, back soon'; save(); PR.apply(i.client, true).catch(() => {}); }
      await redraw(i); return true;

    // ----- presence: visibility -----
    case 'own_ps': await PR.setStatus(i.client, arg); audit(i, `set the bot status to **${arg}**.`); await redraw(i); return true;
    case 'own_pres_custom': await m('own_pres_custom_modal', 'Custom status', ROW('text', 'Status text (shown under the bot name)', 0, 128, true, 'e.g. Taking orders ({queue} in queue)', PR.P().type === 'custom' ? PR.P().text : '')); return true;

    // ----- presence -----
    case 'own_pres_text': await m('own_pres_text_modal', 'Activity text', ROW('text', 'Text (use {members} {queue} {tickets} ...)', 0, 128, true, 'e.g. {queue} orders in the queue', PR.P().text), ROW('url', 'Stream link (only for Streaming)', 0, 200, false, 'https://twitch.tv/yourname', PR.P().url)); return true;
    case 'own_pres_rot': {
      const r = PR.P().rotate;
      if (!r.on && !r.items.length) { await i.reply({ content: 'Add rotation items first (Edit rotation list).', flags: EPH }); return true; }
      await PR.setRotation(i.client, { on: !r.on }); await redraw(i); return true;
    }
    case 'own_pres_rotedit': await m('own_pres_rotedit_modal', 'Rotation list', ROW('list', 'One per line: type: text', P_, 1200, true, 'watching: {queue} orders in the queue\nplaying: building your orders\ncustom: {open}', PR.P().rotate.items.map(x => `${x.type}: ${x.text}`).join('\n')), ROW('every', 'Change every (seconds, min 30)', 0, 5, true, '60', String(PR.P().rotate.interval))); return true;
    case 'own_pres_auto': await PR.setAuto(i.client, !PR.P().auto); await redraw(i); return true;
    case 'own_pres_reset': await PR.reset(i.client); audit(i, 'reset the bot presence.'); await redraw(i); return true;

    // ----- profile -----
    case 'own_prof_name': await m('own_prof_name_modal', 'Bot username', ROW('v', 'New username (2-32 chars)', 0, 32)); return true;
    case 'own_prof_avatar': await m('own_prof_avatar_modal', 'Bot avatar', ROW('v', 'Direct https image link', 0, 400)); return true;
    case 'own_prof_banner': await m('own_prof_banner_modal', 'Bot banner', ROW('v', 'Direct https image link', 0, 400)); return true;
    case 'own_prof_nick': await m('own_prof_nick_modal', 'Server nickname', ROW('v', 'Nickname in this server', 0, 32)); return true;
    case 'own_prof_about': await m('own_prof_about_modal', 'About me', ROW('v', 'Bot description (max 400)', P_, 400)); return true;
    case 'own_prof_nickreset': await i.deferUpdate(); await PR.setNickname(i.client, null).catch(e => i.followUp({ content: `Failed: ${e.message}`, flags: EPH })); await refreshPosted(i.client); return true;

    // ----- protection -----
    case 'own_word_add': await m('own_word_add_modal', 'Add banned word', ROW('v', 'Word', 0, 40)); return true;
    case 'own_word_rm': await m('own_word_rm_modal', 'Remove banned word', ROW('v', 'Word (only ones you added)', 0, 40)); return true;
    case 'own_strike_clear': await m('own_strike_clear_modal', 'Clear strikes', ROW('uid', 'User ID')); return true;
    case 'own_cmd_off': await m('own_cmd_off_modal', 'Disable a command', ROW('v', 'Command name (no slash)', 0, 32, true, 'e.g. giveaway')); return true;
    case 'own_cmd_on': await m('own_cmd_on_modal', 'Enable a command', ROW('v', 'Command name, or "all"', 0, 32, true, 'e.g. giveaway')); return true;

    // ----- AI + smart-mod -----
    case 'own_ai_master': { const a = AI.state(); a.enabled = !a.enabled; save(); audit(i, `switched AI ${onoff(a.enabled)}.`); await redraw(i); return true; }
    case 'own_ai_test': {
      await i.deferReply({ flags: EPH });
      const t0 = Date.now();
      const r = await AI.ask({ system: 'Answer with the single word: pong', user: 'ping', model: 'fast', maxTokens: 10, use: 'summary' });
      await i.editReply(r ? `${tag(E.thumbsup)} AI works: \`${clip(r, 30)}\` in ${Date.now() - t0}ms (model \`${AI.MODELS.fast}\`).` : `${tag(E.rekt)} No answer. ${AI.available() ? `Last error: ${AI.state().lastError || 'unknown, see console'}` : AI.why()}`);
      return true;
    }
    case 'own_sm_test': await m('own_sm_test_modal', 'Test a message', ROW('v', 'Message to run through smart-mod', P_, 1000)); return true;
    case 'own_sm_scan': {
      await i.deferReply({ flags: EPH });
      const r = await SM.scanAll(i.client);
      await i.editReply({ content: r.length ? `Found **${r.length}** possible impersonator(s):\n${r.slice(0, 20).map(x => `• <@${x.id}> (${clip(x.name, 30)}): ${x.hit.why}`).join('\n')}` : 'No impersonators found.', allowedMentions: { parse: [] } });
      return true;
    }
    case 'own_sm_trust': await m('own_sm_trust_modal', 'Trust a user', ROW('uid', 'User ID (smart-mod will ignore them)')); return true;
    case 'own_ai_limit': await m('own_ai_limit_modal', 'Daily AI call limit', ROW('v', 'Max AI calls per day', 0, 7, true, '1500', String(AI.state().limit))); return true;

    // ----- AI tools -----
    // ----- security -----
    case 'own_imm': await m('own_imm_modal', 'Add / remove immune', ROW('uid', 'User ID (adds them, or removes them if already immune)')); return true;
    case 'own_immlist': { const l = SEC.immuneIds(); await i.reply({ content: `**Always immune:** ${cfg.ownerIds.map(o => `<@${o}>`).join(' ')} (owner), the server owner and this bot.\n**Immune by you (${l.length}):** ${l.length ? l.map(x => `<@${x}>`).join(' ') : 'nobody'}`, flags: EPH, allowedMentions: { parse: [] } }); return true; }
    case 'own_jail': await m('own_jail_modal', 'Jail a user', ROW('uid', 'User ID'), ROW('reason', 'Reason', 0, 300)); return true;
    case 'own_rel': await m('own_rel_modal', 'Release a user', ROW('uid', 'User ID'), ROW('reason', 'Reason', 0, 300, false)); return true;
    case 'own_jailed': {
      const l = Object.entries(db.jailed || {}).slice(0, 25).map(([uid, r]) => `<@${uid}> · ${clip(r.reason, 80)} · by ${r.source === 'raid' ? 'anti-raid' : r.by ? `<@${r.by}>` : '?'} · <t:${Math.floor((r.at || Date.now()) / 1000)}:R>`);
      await i.reply({ content: l.join('\n') || 'Nobody is jailed.', flags: EPH, allowedMentions: { parse: [] } }); return true;
    }
    case 'own_seccheck': { await i.deferReply({ flags: EPH }); const g = await i.client.guilds.fetch(cfg.guildId); await g.channels.fetch().catch(() => {}); await g.roles.fetch().catch(() => {}); await i.editReply(`## 🔎 Security check\n${SEC.checkText(i.client, g)}`.slice(0, 1990)); return true; }
    case 'own_secsetup': {
      await i.deferReply({ flags: EPH });
      const g = await i.client.guilds.fetch(cfg.guildId);
      const { role, created } = await SEC.ensureRole(g, i.user.tag);
      const r = await SEC.lockAll(g, role); db.security.locked = true; save();
      await i.editReply(`Prisoner role ${created ? 'created' : 'already existed'} (<@&${role.id}>). Locked **${r.locked}** channels, **${r.skipped}** were already locked${r.failed ? `, **${r.failed}** failed (check my permissions)` : ''}.`); return true;
    }
    case 'own_tk_list': {
      const l = Object.entries(db.tickets || {}).sort((x, y) => (x[1].openedAt || 0) - (y[1].openedAt || 0)).slice(0, 25)
        .map(([cid, t]) => `<#${cid}> · ${t.type}${t.service ? ` (${t.service})` : ''} · opened <t:${Math.floor((t.openedAt || Date.now()) / 1000)}:R>`);
      await i.reply({ content: l.join('\n') || 'No open tickets.', flags: EPH, allowedMentions: { parse: [] } }); return true;
    }
    case 'own_eng_speed': {
      await i.deferReply({ flags: EPH });
      const r = (await AI.speedTest()).sort((x, y) => (y.ok - x.ok) || (x.ms - y.ms));
      await i.editReply(r.length ? `**Speed test** (one tiny request per model)\n${r.map(x => `${x.ok ? '🟢' : '🔴'} \`${x.p}/${x.m}\`: ${x.ok ? `${x.ms}ms` : clip(x.err || 'failed', 70)}`).join('\n')}` : 'No API key set. Add GROQ_API_KEY (free) or GEMINI_API_KEY to .env.');
      return true;
    }
    case 'own_eng_reset': AI.resetCooldowns(); await i.reply({ content: 'Cleared the "skip this model for a while" list. Every model will be tried again.', flags: EPH }); return true;

    // ----- digest -----
    case 'own_dg_prev': case 'own_dg_post': {
      await i.deferReply({ flags: EPH });
      const r = await DG.post(i.client, { preview: id === 'own_dg_prev' });
      await i.editReply(r.ok ? `Digest posted in <#${r.channelId}>${r.ai ? ' (AI narrative).' : ' (template version, AI not used).'}` : `Could not post: ${r.why}`);
      return true;
    }
    case 'own_dg_sched': { const s = DG.settings(); await m('own_dg_sched_modal', 'Digest schedule', ROW('day', 'Day (0=Sunday ... 6=Saturday, or a name)', 0, 12, true, 'sunday', ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][s.day]), ROW('hour', 'Hour (0-23)', 0, 2, true, '18', String(s.hour)), ROW('tz', 'Timezone', 0, 40, true, 'Europe/London', s.tz)); return true; }
    case 'own_dg_here': DG.D().settings.channelId = i.channelId; save(); audit(i, `set the digest channel to <#${i.channelId}>.`); await redraw(i); return true;

    // ----- system -----
    case 'own_sys_cmds': {
      await i.deferReply({ flags: EPH });
      const { defs } = require('./commands'); const PERMS = require('./perms');
      const g = await i.client.guilds.fetch(cfg.guildId);
      await g.commands.set(defs.map(d => PERMS.registrationJSON(d)));
      await i.editReply(`Re-registered **${defs.length}** commands.`); return true;
    }
    case 'own_sys_emoji': { await i.deferReply({ flags: EPH }); const lost = await require('./emojis').resolve(i.client, cfg.guildId); await i.editReply(lost.length ? `Reloaded. Not found: ${lost.join(', ')}` : 'Reloaded. All custom emojis found.'); return true; }
    case 'own_sys_save': save(); await i.reply({ content: 'Database saved to disk.', flags: EPH }); return true;
    case 'own_sys_dm': await m('own_sys_dm_modal', 'DM a user', ROW('uid', 'User ID'), ROW('text', 'Message', P_, 1500)); return true;
    case 'own_sys_errors': {
      const l = SYS.errors.slice(-8).reverse().map(e => `<t:${Math.floor(e.at / 1000)}:T> ${e.msg.slice(0, 220)}`).join('\n\n');
      await i.reply({ content: l ? `**Recent errors**\n${l}`.slice(0, 1900) : 'No errors since the bot started. 🎉', flags: EPH }); return true;
    }
    case 'own_sys_clearerr': SYS.clearErrors(); await redraw(i); return true;
    case 'own_sys_restart': case 'own_sys_shutdown': {
      const kind = id === 'own_sys_restart' ? 'restart' : 'shutdown';
      await i.reply({
        content: kind === 'restart'
          ? `${tag(E.punishment)} **Restart the bot?** The process exits, so your host (pm2, Docker restart policy, hosting panel auto-restart) must start it again.`
          : `${tag(E.punishment)} **Shut the bot down?** It stays offline until you start it again on your host.`,
        components: [new ActionRowBuilder().addComponents(btn(`own_confirm:${kind}`, `Yes, ${kind}`, ButtonStyle.Danger), btn('own_cancel', 'Cancel'))], flags: EPH,
      }); return true;
    }
    case 'own_confirm': {
      save(); audit(i, `${arg === 'restart' ? 'restarted' : 'shut down'} the bot.`);
      await i.update({ content: arg === 'restart' ? '♻️ Restarting...' : '🔌 Shutting down...', components: [] });
      setTimeout(() => process.exit(0), 800); return true;
    }
    case 'own_cancel': await i.update({ content: 'Cancelled.', components: [] }); return true;
  }
  return true;
}

// ---------------- modals ----------------
async function onModal(i) {
  if (!i.customId.startsWith('own_')) return false;
  if (!isOwner(i)) { await i.reply({ content: 'Owner only.', flags: EPH }); return true; }
  await handleModal(i);
  return true;
}
async function handleModal(i) {
  const f = k => { try { return i.fields.getTextInputValue(k).trim(); } catch { return ''; } };
  const reply = async (content, refresh = true) => { await i.reply({ content, flags: EPH, allowedMentions: { parse: [] } }); if (refresh) refreshPosted(i.client).catch(() => {}); };
  const uidOf = () => f('uid').replace(/\D/g, '');
  switch (i.customId) {
    case 'own_say_modal': await i.channel.send(ui.msg(ui.note(f('text')))); return !!(await i.reply({ content: 'Sent.', flags: EPH }));
    case 'own_bl_modal': {
      const uid = uidOf(); if (!uid) return !!(await i.reply({ content: 'Invalid user ID.', flags: EPH }));
      db.blacklist[uid] = { reason: f('reason'), by: i.user.id, at: Date.now() }; save();
      T.log(i.client, `⛔ <@${i.user.id}> blacklisted <@${uid}>: ${f('reason')}`);
      return !!(await reply(`Blacklisted <@${uid}>.`));
    }
    case 'own_ubl_modal': { const uid = uidOf(); const had = !!db.blacklist[uid]; delete db.blacklist[uid]; save(); return !!(await reply(had ? `Removed <@${uid}> from the blacklist.` : 'That user is not blacklisted.')); }

    case 'own_pres_text_modal': await PR.setText(i.client, f('text'), f('url')); audit(i, `set the bot activity text to \`${clip(f('text'), 60)}\`.`); return !!(await reply('Activity updated.'));
    case 'own_pres_rotedit_modal': {
      const items = PR.parseRotation(f('list')); const every = parseInt(f('every'), 10) || 60;
      if (!items.length) return !!(await i.reply({ content: 'Add at least one line like `watching: {queue} orders in the queue`.', flags: EPH }));
      await PR.setRotation(i.client, { items, interval: every }); return !!(await reply(`Saved **${items.length}** rotation item(s), every **${Math.max(30, every)}s**. Press **Rotation: OFF** to start it.`));
    }

    case 'own_prof_name_modal': try { await PR.setUsername(i.client, f('v')); audit(i, `changed the bot username to **${clip(f('v'), 32)}**.`); return !!(await reply('Username changed.')); } catch (e) { return !!(await i.reply({ content: `Failed: ${e.message}`, flags: EPH })); }
    case 'own_prof_avatar_modal': await i.deferReply({ flags: EPH }); try { await PR.setAvatar(i.client, f('v')); await i.editReply('Avatar changed.'); } catch (e) { await i.editReply(`Failed: ${e.message}`); } refreshPosted(i.client); return true;
    case 'own_prof_banner_modal': await i.deferReply({ flags: EPH }); try { await PR.setBanner(i.client, f('v')); await i.editReply('Banner changed.'); } catch (e) { await i.editReply(`Failed: ${e.message}`); } refreshPosted(i.client); return true;
    case 'own_prof_nick_modal': try { await PR.setNickname(i.client, f('v')); return !!(await reply('Nickname changed.')); } catch (e) { return !!(await i.reply({ content: `Failed: ${e.message}`, flags: EPH })); }
    case 'own_prof_about_modal': try { await PR.setAbout(i.client, f('v')); return !!(await reply('About me updated.')); } catch (e) { return !!(await i.reply({ content: `Failed: ${e.message}`, flags: EPH })); }

    case 'own_word_add_modal': {
      const w = f('v').toLowerCase().replace(/[^a-z0-9]/g, ''); if (!w) return !!(await i.reply({ content: 'Invalid word.', flags: EPH }));
      if (!db.automod.words.includes(w)) db.automod.words.push(w); save(); audit(i, 'added a word to the auto-mod list.'); return !!(await reply(`Added **${w}**.`));
    }
    case 'own_word_rm_modal': { const w = f('v').toLowerCase(); const had = db.automod.words.includes(w); db.automod.words = db.automod.words.filter(x => x !== w); save(); return !!(await reply(had ? `Removed **${w}**.` : 'That word is not in your custom list (built-in words cannot be removed).')); }
    case 'own_strike_clear_modal': { const uid = uidOf(); const had = !!db.strikes[uid]; delete db.strikes[uid]; save(); audit(i, `cleared the strikes of <@${uid}>.`); return !!(await reply(had ? `Cleared strikes for <@${uid}>.` : 'That user has no strikes.')); }
    case 'own_cmd_off_modal': {
      const n = f('v').toLowerCase().replace(/^\//, '');
      const { defs } = require('./commands');
      if (n === 'ownerpanel') return !!(await i.reply({ content: "You can't disable the owner panel.", flags: EPH }));
      if (!defs.some(d => d.name === n)) return !!(await i.reply({ content: `No command called \`/${n}\`.`, flags: EPH }));
      db.disabledCmds[n] = true; save(); audit(i, `disabled \`/${n}\`.`); return !!(await reply(`\`/${n}\` is now disabled for everyone except owners.`));
    }
    case 'own_cmd_on_modal': {
      const n = f('v').toLowerCase().replace(/^\//, '');
      if (n === 'all') db.disabledCmds = {}; else delete db.disabledCmds[n];
      save(); audit(i, `enabled ${n === 'all' ? 'all commands' : '`/' + n + '`'}.`); return !!(await reply(n === 'all' ? 'All commands enabled.' : `\`/${n}\` enabled.`));
    }

    case 'own_pres_custom_modal': {
      const t = f('text'); PR.P().rotate.on = false; save();
      await PR.setType(i.client, 'custom'); await PR.setText(i.client, t);
      audit(i, `set the bot custom status to \`${clip(t, 60)}\`.`); return !!(await reply('Custom status updated.'));
    }
    case 'own_imm_modal': {
      const uid = uidOf(); if (!uid) return !!(await i.reply({ content: 'Invalid user ID.', flags: EPH }));
      if (cfg.isOwner(uid)) return !!(await i.reply({ content: 'Owners are always immune.', flags: EPH }));
      db.security.immune = db.security.immune || {};
      const had = !!db.security.immune[uid];
      if (had) delete db.security.immune[uid]; else db.security.immune[uid] = { by: i.user.id, at: Date.now() };
      save(); audit(i, `${had ? 'removed' : 'added'} <@${uid}> ${had ? 'from' : 'to'} the immune list.`);
      return !!(await reply(had ? `<@${uid}> is **no longer immune**.` : `🛡️ <@${uid}> is now **immune** to prison and anti-raid.`));
    }
    case 'own_jail_modal': {
      const uid = uidOf(); const g = await i.client.guilds.fetch(cfg.guildId); const mem = uid && await g.members.fetch(uid).catch(() => null);
      if (!mem) return !!(await i.reply({ content: 'Member not found in the server.', flags: EPH }));
      await i.deferReply({ flags: EPH });
      const r = await SEC.imprison(i.client, g, mem, { by: i.user.id, reason: f('reason'), source: 'manual', details: [`• Jailed from the owner panel by <@${i.user.id}>.`, `• Reason given: ${f('reason')}`] });
      await i.editReply(r.ok ? `Jailed <@${uid}>${r.kase ? ` (case #${r.kase.id})` : ''}.` : `Could not jail them (${r.why}).`); refreshPosted(i.client).catch(() => {}); return true;
    }
    case 'own_rel_modal': {
      const uid = uidOf(); const g = await i.client.guilds.fetch(cfg.guildId); const mem = uid && await g.members.fetch(uid).catch(() => null);
      if (!mem) return !!(await i.reply({ content: 'Member not found in the server.', flags: EPH }));
      if (!db.jailed[uid]) return !!(await i.reply({ content: 'That member is not jailed.', flags: EPH }));
      await i.deferReply({ flags: EPH });
      const k = await SEC.release(i.client, g, mem, { by: i.user.id, reason: f('reason') || 'Released from the owner panel' });
      await i.editReply(`Released <@${uid}> and gave their roles back (case #${k.id}).`); refreshPosted(i.client).catch(() => {}); return true;
    }
    case 'own_sm_trust_modal': { const uid = uidOf(); if (!uid) return !!(await i.reply({ content: 'Invalid user ID.', flags: EPH })); SM.S().trusted[uid] = { by: i.user.id, at: Date.now() }; save(); return !!(await reply(`Smart-mod will ignore <@${uid}>. (Remove with \`/smartmod untrust\`.)`)); }
    case 'own_ai_limit_modal': { const n = parseInt(f('v'), 10); if (!n || n < 10 || n > 100000) return !!(await i.reply({ content: 'Pick a number between 10 and 100000.', flags: EPH })); AI.state().limit = n; save(); return !!(await reply(`Daily AI limit is now **${n}** calls.`)); }
    case 'own_sm_test_modal': {
      await i.deferReply({ flags: EPH });
      const r = await SM.dryRun(f('v'));
      await i.editReply({ content: [
        `**De-obfuscated:** \`${r.deob.replace(/`/g, "'") || '(empty)'}\``,
        `**Local rules:** ${r.local.kind ? `${r.local.kind} (score ${r.local.score}, acts at ${r.act}+)` : 'nothing matched'} · **Swear bypass:** ${r.bypass || 'none'} · **Disguise score:** ${r.obf}`,
        `**AI verdict:** ${r.ai ? `${r.ai.category} (${Math.round(r.ai.confidence * 100)}%): ${r.ai.reason}` : `not run (${r.aiWhy || 'no answer'})`}`,
      ].join('\n'), allowedMentions: { parse: [] } });
      return true;
    }

    case 'own_dg_sched_modal': {
      const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const dayRaw = f('day').toLowerCase(); const day = names.findIndex(n => n.startsWith(dayRaw)) >= 0 && isNaN(+dayRaw) ? names.findIndex(n => n.startsWith(dayRaw)) : parseInt(dayRaw, 10);
      const hour = parseInt(f('hour'), 10); const tz = f('tz');
      let tzOk = true; try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); } catch { tzOk = false; }
      if (!(day >= 0 && day <= 6) || !(hour >= 0 && hour <= 23) || !tzOk) return !!(await i.reply({ content: 'Check the values: day 0-6 (or a name), hour 0-23, timezone like `Europe/London`.', flags: EPH }));
      Object.assign(DG.D().settings, { day, hour, tz }); save(); audit(i, `set the digest schedule to ${DG.nextRunText()}.`);
      return !!(await reply(`Digest schedule: **${DG.nextRunText()}**.`));
    }

    case 'own_sys_dm_modal': {
      const uid = uidOf(); const u = uid && await i.client.users.fetch(uid).catch(() => null);
      if (!u) return !!(await i.reply({ content: 'User not found.', flags: EPH }));
      const ok = await u.send(ui.msg(ui.note(f('text')))).then(() => true).catch(() => false);
      return !!(await reply(ok ? `DM sent to **${u.tag}**.` : 'Could not DM them (DMs closed).', false));
    }
  }
}

module.exports = { onSelect, onButton, onModal, tick, panel };
