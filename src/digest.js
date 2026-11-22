// Weekly server digest.
//  * The bot compares today's stats with a snapshot from the last digest, so the numbers are "this week".
//  * Every number you see is computed by the bot. Gemini only writes the narrative around them (and the bot falls back to a
//    plain template if the AI is off), so the report can never contain invented figures.
//  * Posted automatically once a week (default Sunday 18:00 Europe/London) in DIGEST_CHANNEL_ID (default: staff logs).
//  * History of the last 8 weeks is kept so each report can show trends.
const { ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { db, save, svcState } = require('./db');
const AI = require('./ai');
const { add, sc } = require('./commands');
const ui = require('./ui');
const { E, tag } = require('./emojis');

const EPH = MessageFlags.Ephemeral;
const DAY = 86400e3;
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAYNAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const num = n => Number(n || 0).toLocaleString('en-US');
const clone = o => JSON.parse(JSON.stringify(o || {}));

// ---------------- settings (db.digest.settings > .env > defaults) ----------------
function D() {
  const d = (db.digest = db.digest || {});
  d.settings ||= {}; d.history ||= []; d.week ||= { joins: 0, leaves: 0 };
  return d;
}
const enabled = () => cfg.flag('DIGEST_ENABLED', true);
function settings() {
  const s = D().settings;
  const day = Number.isInteger(s.day) ? s.day : cfg.num('DIGEST_DAY', 0);
  const hour = Number.isInteger(s.hour) ? s.hour : cfg.num('DIGEST_HOUR', 18);
  let tz = s.tz || (process.env.DIGEST_TZ || '').trim() || 'Europe/London';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); } catch { tz = 'UTC'; }
  return {
    day: Math.min(6, Math.max(0, day)), hour: Math.min(23, Math.max(0, hour)), tz,
    channel: s.channelId || (process.env.DIGEST_CHANNEL_ID || '').trim() || cfg.logs.staff,
    ai: s.ai !== undefined ? s.ai : true,
  };
}

// ---------------- schedule maths ----------------
function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = {}; for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { weekday: o.weekday, year: +o.year, month: +o.month, day: +o.day, hour: +o.hour % 24, minute: +o.minute };
}
// the most recent scheduled slot that has already passed -> its date is the key
function slotKey(now = new Date()) {
  const { day, hour, tz } = settings();
  const p = localParts(now, tz);
  let back = (WD[p.weekday] - day + 7) % 7;
  if (back === 0 && p.hour < hour) back = 7;
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - back * DAY).toISOString().slice(0, 10);
}
function nextRunText() {
  const { day, hour, tz } = settings();
  return `${DAYNAME[day]} ${String(hour).padStart(2, '0')}:00 (${tz})`;
}

// ---------------- numbers ----------------
function snapshot() {
  return { at: Date.now(), stats: clone(db.stats), smart: clone(db.smartmod?.stats) };
}
const pct = (cur, prev) => (!prev ? (cur ? 'new' : 'flat') : `${cur >= prev ? '+' : ''}${Math.round(((cur - prev) / prev) * 100)}%`);
const arrow = (cur, prev) => (cur > prev ? '▲' : cur < prev ? '▼' : '▬');

function collect() {
  const d = D(); const now = Date.now();
  const snap = d.snap;
  const from = snap?.at || null;
  const st = db.stats; const ps = snap?.stats || {};
  const dl = k => Math.max(0, (st[k] || 0) - (ps[k] || 0));
  const fromTs = from || 0;

  // sales
  const rc = dl('ratingCount'); const rs = Math.max(0, (st.ratingSum || 0) - (ps.ratingSum || 0));
  const sales = {
    packagesSold: dl('packageSales'), robux: dl('robuxEarned'), ordersOpened: dl('ordersOpened'), ordersClosed: dl('ordersClosed'),
    ordersCompleted: dl('ordersSuccessful'), reviews: rc, avgRating: rc ? +(rs / rc).toFixed(2) : null,
    avgRatingAllTime: st.ratingCount ? +(st.ratingSum / st.ratingCount).toFixed(2) : null,
  };

  // queue health (live state, not a weekly delta)
  const tickets = Object.values(db.tickets || {});
  const orders = tickets.filter(t => t.type === 'order'); const support = tickets.filter(t => t.type !== 'order');
  const age = t => (now - (t.openedAt || now)) / DAY;
  const byService = {}; for (const o of orders) byService[o.service] = (byService[o.service] || 0) + 1;
  const queue = {
    inQueue: db.queue.length, openOrders: orders.length, openSupport: support.length,
    oldestOrderDays: orders.length ? +Math.max(...orders.map(age)).toFixed(1) : 0,
    oldestSupportDays: support.length ? +Math.max(...support.map(age)).toFixed(1) : 0,
    overdue: orders.filter(o => o.due && o.due < now).length,
    dueNext48h: orders.filter(o => o.due && o.due > now && o.due - now < 2 * DAY).length,
    unquoted: orders.filter(o => !o.quote).length,
    notStartedOver3Days: orders.filter(o => !o.progress && age(o) > 3).length,
    olderThan14Days: orders.filter(o => age(o) > 14).length,
    byService, serviceStatus: Object.fromEntries(Object.keys(cfg.services).map(k => [k, svcState(k)])),
  };

  // staff
  const staffMap = {};
  const row = id => (staffMap[id] ||= { id, mention: `<@${id}>`, ticketsClosed: 0, modActions: 0 });
  for (const [id, n] of Object.entries(st.byStaff || {})) { const x = Math.max(0, n - ((ps.byStaff || {})[id] || 0)); if (x) row(id).ticketsClosed = x; }
  const cases = Object.values(db.cases || {}).filter(c => c.at >= fromTs);
  for (const c of cases) if (c.modId) row(c.modId).modActions++;
  const staff = Object.values(staffMap).sort((a, b) => (b.ticketsClosed + b.modActions) - (a.ticketsClosed + a.modActions)).slice(0, 6);

  // moderation
  const byAction = {}; for (const c of cases) byAction[c.action] = (byAction[c.action] || 0) + 1;
  const strikesGiven = Object.values(db.strikes || {}).reduce((a, s) => a + (s.history || []).filter(h => h.at >= fromTs).length, 0);
  const sm = db.smartmod?.stats || {}; const ps2 = snap?.smart || {};
  const sd = k => Math.max(0, (sm[k] || 0) - (ps2[k] || 0));
  const moderation = {
    cases: cases.length, byAction, automodCases: cases.filter(c => !c.modId).length, humanCases: cases.filter(c => c.modId).length, strikesGiven,
    jailedNow: Object.keys(db.jailed || {}).length, tempbansActive: Object.keys(db.tempbans || {}).length,
    smartmod: { scanned: sd('scanned'), caughtByRules: sd('local'), caughtByAI: sd('ai'), imageFlags: sd('imageFlags'), impersonation: sd('impersonation'), falsePositives: sd('falsePositives') },
  };
  const members = { joined: d.week.joins || 0, left: d.week.leaves || 0, net: (d.week.joins || 0) - (d.week.leaves || 0) };

  // trends
  const h = d.history; const prev = h[h.length - 1] || null;
  const last4 = h.slice(-4);
  const avg = k => (last4.length ? +(last4.reduce((a, x) => a + (x[k] || 0), 0) / last4.length).toFixed(1) : null);
  const flat = { packagesSold: sales.packagesSold, robux: sales.robux, ordersOpened: sales.ordersOpened, ordersCompleted: sales.ordersCompleted, avgRating: sales.avgRating || 0, cases: moderation.cases, joined: members.joined, left: members.left, inQueue: queue.inQueue };
  return {
    period: { from, to: now, days: from ? +((now - from) / DAY).toFixed(1) : null, note: from ? '' : 'No earlier snapshot, so these are all-time totals.' },
    sales, queue, staff, moderation, members,
    previousWeek: prev && { packagesSold: prev.packagesSold, robux: prev.robux, ordersOpened: prev.ordersOpened, ordersCompleted: prev.ordersCompleted, avgRating: prev.avgRating, cases: prev.cases, joined: prev.joined, left: prev.left, inQueue: prev.inQueue },
    fourWeekAverage: last4.length ? { packagesSold: avg('packagesSold'), robux: avg('robux'), ordersOpened: avg('ordersOpened'), ordersCompleted: avg('ordersCompleted'), cases: avg('cases'), joined: avg('joined'), inQueue: avg('inQueue') } : null,
    _flat: flat,
  };
}

// ---------------- narrative ----------------
const SYSTEM = () => `You write the weekly management digest for the owners of "${cfg.brand}", a Roblox/Discord development and design studio (bots, Discord servers, ERLC work, a Robux marketplace). You receive a JSON object of numbers computed by the bot.
Rules:
- Use ONLY numbers that appear in the data. Never invent figures, names, causes or events. If a value is 0, null or missing, say so plainly.
- Where previousWeek or fourWeekAverage exist, describe the direction of change in words (up, down, flat). If they are null, say there is no history yet.
- Mention staff only with their exact "mention" string.
- Be concrete and brief. No greetings, no filler, no emojis.
Return JSON: {"headline":"one sentence, max 160 chars","sales":"2-3 sentences","queue":"2-4 sentences naming concrete risks (overdue, oldest order, unquoted or not-started orders, service status)","staff":"2-3 sentences","moderation":"2-3 sentences incl. what the smart auto-mod caught","trends":"2-3 sentences comparing with last week and the 4-week average","actions":["2 to 4 short imperative recommendations grounded in the data"]}`;

function fallbackNarrative(m) {
  const s = m.sales, q = m.queue, mo = m.moderation, p = m.previousWeek;
  const cmp = (cur, prev, what) => (prev == null ? '' : ` (${arrow(cur, prev)} ${pct(cur, prev)} vs last week)`) + (what || '');
  const top = m.staff[0];
  const actions = [];
  if (q.overdue) actions.push(`Check the ${q.overdue} overdue order(s) first.`);
  if (q.unquoted) actions.push(`Send quotes for the ${q.unquoted} order(s) without one.`);
  if (q.notStartedOver3Days) actions.push(`${q.notStartedOver3Days} order(s) have shown no progress for 3+ days. Update or reassign them.`);
  if (!actions.length) actions.push('Nothing urgent. Keep the queue moving.');
  return {
    headline: `${s.ordersCompleted} order(s) completed, ${s.packagesSold} package(s) sold, ${q.inQueue} in the queue.`,
    sales: `${s.packagesSold} package(s) sold${cmp(s.packagesSold, p?.packagesSold)} earning ${num(s.robux)} R$. ${s.ordersOpened} order(s) opened and ${s.ordersCompleted} completed. ${s.reviews ? `${s.reviews} review(s) averaging ${s.avgRating}/5.` : 'No new reviews.'}`,
    queue: `${q.inQueue} order(s) are queued, the oldest open order is ${q.oldestOrderDays} day(s) old. ${q.overdue} overdue, ${q.dueNext48h} due in the next 48 hours, ${q.unquoted} not quoted yet, ${q.notStartedOver3Days} not started after 3 days.`,
    staff: top ? `${top.mention} was the most active (${top.ticketsClosed} ticket(s) closed, ${top.modActions} moderation action(s)).${m.staff.length > 1 ? ` ${m.staff.length - 1} other staff member(s) were active.` : ''}` : 'No staff activity was recorded this period.',
    moderation: `${mo.cases} moderation case(s), ${mo.automodCases} from auto-mod and ${mo.humanCases} from staff; ${mo.strikesGiven} strike(s) given. Smart auto-mod caught ${mo.smartmod.caughtByRules + mo.smartmod.caughtByAI + mo.smartmod.imageFlags} message(s)/image(s) and ${mo.smartmod.impersonation} impersonator(s).`,
    trends: p ? `Orders opened ${arrow(s.ordersOpened, p.ordersOpened)} ${pct(s.ordersOpened, p.ordersOpened)}, Robux ${arrow(s.robux, p.robux)} ${pct(s.robux, p.robux)}, new members ${arrow(m.members.joined, p.joined)} ${pct(m.members.joined, p.joined)} compared with last week.` : 'No previous week is stored yet, so there are no trends. They appear from next week.',
    actions,
  };
}

async function narrative(m, useAI) {
  const fb = fallbackNarrative(m);
  if (!useAI || !false) return { n: fb, ai: false };
  const { _flat, ...data } = m;
  data.period = { ...data.period, from: data.period.from && new Date(data.period.from).toISOString(), to: new Date(data.period.to).toISOString() };
  const j = await AI.askJSON({ system: SYSTEM(), user: `<data>\n${JSON.stringify(data)}\n</data>`, model: 'smart', maxTokens: 1100, temperature: 0.3 });
  if (!j) return { n: fb, ai: false };
  const str = (v, d) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 900) : d);
  return {
    ai: true,
    n: {
      headline: str(j.headline, fb.headline).slice(0, 200), sales: str(j.sales, fb.sales), queue: str(j.queue, fb.queue), staff: str(j.staff, fb.staff),
      moderation: str(j.moderation, fb.moderation), trends: str(j.trends, fb.trends),
      actions: Array.isArray(j.actions) && j.actions.length ? j.actions.filter(a => typeof a === 'string').slice(0, 5).map(a => a.slice(0, 200)) : fb.actions,
    },
  };
}

// ---------------- rendering ----------------
const t = s => new TextDisplayBuilder().setContent(String(s).slice(0, 3900));
const sep = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

function render(m, n, meta) {
  const s = m.sales, q = m.queue, mo = m.moderation, p = m.previousWeek;
  const d = (cur, prev) => (p && prev != null ? ` ${arrow(cur, prev)}` : '');
  const from = m.period.from ? `<t:${Math.floor(m.period.from / 1000)}:D>` : 'the beginning';
  const c = ui.base();
  c.addTextDisplayComponents(t(`## ${tag(E.schedule)} ${meta.preview ? 'Digest preview' : 'Weekly digest'} · ${cfg.brand}\n-# ${from} to <t:${Math.floor(m.period.to / 1000)}:D>${m.period.note ? ` · ${m.period.note}` : ''}\n\n**${n.headline}**`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(t(
    `### ${tag(E.money)} Sales\n**Packages sold:** ${s.packagesSold}${d(s.packagesSold, p?.packagesSold)} · **Robux:** ${num(s.robux)} R$${d(s.robux, p?.robux)}\n**Orders opened:** ${s.ordersOpened}${d(s.ordersOpened, p?.ordersOpened)} · **Completed:** ${s.ordersCompleted}${d(s.ordersCompleted, p?.ordersCompleted)} · **Reviews:** ${s.reviews}${s.avgRating ? ` (avg ${s.avgRating})` : ''}\n${n.sales}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(t(
    `### ${tag(E.pc)} Queue health\n**In queue:** ${q.inQueue}${d(q.inQueue, p?.inQueue)} · **Open orders:** ${q.openOrders} · **Open support tickets:** ${q.openSupport}\n**Overdue:** ${q.overdue} · **Due in 48h:** ${q.dueNext48h} · **Unquoted:** ${q.unquoted} · **Oldest order:** ${q.oldestOrderDays}d\n${n.queue}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(t(
    `### ${tag(E.person)} Staff\n${m.staff.length ? m.staff.map((x, k) => `${k + 1}. ${x.mention}: ${x.ticketsClosed} ticket(s) closed · ${x.modActions} mod action(s)`).join('\n') : '*No staff activity recorded.*'}\n${n.staff}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(t(
    `### ${tag(E.moderator)} Moderation\n**Cases:** ${mo.cases}${d(mo.cases, p?.cases)} (${mo.automodCases} auto, ${mo.humanCases} staff) · **Strikes:** ${mo.strikesGiven} · **Jailed now:** ${mo.jailedNow}\n**Smart-mod:** ${mo.smartmod.caughtByRules} rules · ${mo.smartmod.caughtByAI} AI · ${mo.smartmod.imageFlags} images · ${mo.smartmod.impersonation} impersonators · ${mo.smartmod.falsePositives} false positives\n**Members:** +${m.members.joined} joined · -${m.members.left} left (net ${m.members.net >= 0 ? '+' : ''}${m.members.net})\n${n.moderation}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(t(`### ${tag(E.superstar)} Trends\n${n.trends}\n\n### ${tag(E.thumbsup)} Suggested actions\n${n.actions.map(a => `• ${a}`).join('\n')}`));
  c.addTextDisplayComponents(t(`-# ${meta.ai ? `Written by AI (${AI.MODELS.smart}) from numbers the bot counted itself.` : 'Template report (AI unavailable or switched off). All numbers are counted by the bot.'}${meta.preview ? ' Preview: the weekly counters were not reset.' : ''}`));
  return ui.foot(c);
}

// ---------------- posting ----------------
let busy = false;
// opts: { preview: true -> does not reset the weekly counters, to: channel (override) }
async function post(client, opts = {}) {
  if (busy) return { ok: false, why: 'A digest is already being generated.' };
  busy = true;
  try {
    const set = settings(); const d = D();
    const chId = opts.channelId || set.channel;
    if (!chId) return { ok: false, why: 'No channel: set DIGEST_CHANNEL_ID (or STAFF_LOGS_CHANNEL_ID).' };
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch) return { ok: false, why: 'I cannot see that digest channel.' };
    if (!d.snap) d.snap = null;
    const m = collect();
    const { n, ai } = await narrative(m, set.ai);
    await ch.send({ components: [render(m, n, { preview: !!opts.preview, ai })], flags: ui.V2, allowedMentions: { parse: [] } });
    if (!opts.preview) {
      const f = m._flat;
      d.history.push({ at: Date.now(), ...f }); d.history = d.history.slice(-8);
      d.snap = snapshot(); d.week = { joins: 0, leaves: 0 }; d.lastSentAt = Date.now();
    }
    save();
    return { ok: true, ai, channelId: chId };
  } catch (e) {
    console.error('digest', e);
    return { ok: false, why: e.message };
  } finally { busy = false; }
}

async function tick(client) {
  if (!enabled()) return;
  const d = D();
  const key = slotKey();
  if (!d.snap) { d.snap = snapshot(); d.lastKey = key; save(); return; }      // first run: start counting, first report at the next slot
  if (d.lastKey === key) return;
  d.lastKey = key; save();
  const r = await post(client, {});
  if (!r.ok) console.error('weekly digest failed:', r.why);
}

const onJoin = () => { D().week.joins++; save(); };
const onLeave = () => { D().week.leaves++; save(); };

function statusText() {
  const d = D(); const s = settings();
  return `## ${tag(E.schedule)} Weekly digest\n**Status:** ${enabled() ? 'ON' : 'OFF'} · **Schedule:** ${nextRunText()}\n**Channel:** ${s.channel ? `<#${s.channel}>` : 'not set'} · **AI narrative:** ${s.ai ? (false ? 'on' : `on, but AI unavailable (${AI.why()})`) : 'off (template)'}\n**Last sent:** ${d.lastSentAt ? `<t:${Math.floor(d.lastSentAt / 1000)}:R>` : 'never'} · **Counting since:** ${d.snap ? `<t:${Math.floor(d.snap.at / 1000)}:R>` : 'not started'} · **Weeks stored:** ${d.history.length}`;
}

// ---------------- command ----------------
add(sc('digest').setDescription('Owner: weekly AI server digest')
  .addSubcommand(x => x.setName('preview').setDescription('Post a preview now (does not reset the weekly counters)')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post (default: the digest channel)')))
  .addSubcommand(x => x.setName('post').setDescription('Post the digest now and start a new week'))
  .addSubcommand(x => x.setName('status').setDescription('Show the schedule and settings')),
async i => {
  const sub = i.options.getSubcommand();
  if (sub === 'status') return i.reply(ui.eph(ui.note(statusText())));
  await i.deferReply({ flags: EPH });
  const ch = sub === 'preview' ? i.options.getChannel('channel') : null;
  const r = await post(i.client, { preview: sub === 'preview', channelId: ch?.id });
  return i.editReply(r.ok ? `Digest posted in <#${r.channelId}>${r.ai ? ' (AI narrative).' : ' (template, the AI was not used).'}` : `Could not post the digest: ${r.why}`);
});

module.exports = { tick, post, onJoin, onLeave, statusText, settings, D, enabled, nextRunText, slotKey, collect, render, fallbackNarrative, snapshot };
