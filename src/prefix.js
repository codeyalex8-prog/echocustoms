// Prefix commands: every slash command also works as "-command args" (prefix set with PREFIX in .env).
//   -claim   -close reason   -kick @user reason   -ban @user reason <link or attached image>   -queue list   -note add @user text
// It reads the slash command definitions, parses the text into options, and runs the SAME handler through a
// small stand-in "interaction", so every command behaves identically and all permission checks still apply.
const { MessageFlags } = require('discord.js');
const cfg = require('./config');
const { guard, isOwner, FULLY_GATED, keyOf, placeProblem } = require('./perms');

const EPH = MessageFlags.Ephemeral;
const T = { SUB: 1, STRING: 3, INT: 4, BOOL: 5, USER: 6, CHANNEL: 7, ROLE: 8, NUMBER: 10, ATTACHMENT: 11 };

// short names -> real command (optionally with preset values)
const ALIAS = {
  claim: 'ticketclaim', rename: 'ticketrename', add: 'ticketadd', remove: 'ticketremove', adduser: 'ticketadd', removeuser: 'ticketremove',
  lock: ['ticketlock', { state: 'lock' }], unlock: ['ticketlock', { state: 'unlock' }],
  priority: 'ticketpriority', prio: 'ticketpriority', tinfo: 'ticketinfo', ticket: 'ticketinfo', t: 'tickets',
  remind: 'remindclient', q: 'queue', prog: 'progress', due: 'deadline', ci: 'clientinfo',
  w: 'warn', warns: ['warnings', { _sub: 'view' }], clearwarns: ['warnings', { _sub: 'clear' }],
  mute: 'timeout', to: 'timeout', unmute: 'untimeout', b: 'ban', k: 'kick', bl: 'blacklist',
  addnote: ['note', { _sub: 'add' }], notes: ['note', { _sub: 'view' }], viewnotes: ['note', { _sub: 'view' }],
  cases: 'history', hist: 'history', strike: 'strikes', clearstrikes: ['strikes', { _sub: 'clear' }],
  ui: 'userinfo', si: 'serverinfo', sp: 'submitpackage', setupsecurty: 'setupsecurity', setupsec: 'setupsecurity',
  lb: 'livestats', panel: 'ownerpanel', gw: 'giveaway', pf: 'portfolio', lockchannel: 'lockdown', sm: 'slowmode',
};

// ---------- parsing ----------
function tokenize(s) {
  const out = []; const re = /"([^"]*)"|(\S+)/g; let m;
  while ((m = re.exec(s))) out.push({ v: m[1] ?? m[2], start: m.index, end: re.lastIndex });
  return out;
}
const idOf = (tok, re) => { const m = re.exec(tok); return m ? m[1] : /^\d{15,25}$/.test(tok) ? tok : null; };
const pick = (opt, tok) => {
  const t = tok.toLowerCase();
  const hit = opt.choices.find(c => String(c.value).toLowerCase() === t || String(c.name).toLowerCase() === t)
    || opt.choices.find(c => String(c.name).toLowerCase().startsWith(t) || String(c.value).toLowerCase().startsWith(t));
  return hit ? hit.value : undefined;
};

function usage(name, sub, opts) {
  const parts = opts.map(o => {
    const n = o.type === T.ATTACHMENT ? 'attach-file' : o.name;
    return o.required ? `<${n}>` : `[${n}]`;
  });
  return `${cfg.prefix}${name}${sub ? ` ${sub}` : ''} ${parts.join(' ')}`.trim();
}

// ctx: { resolveUser(id) -> User|null, resolveMember(id), resolveChannel(id), resolveRole(tokenOrId) , attachments: [] }
async function parseArgs(optDefs, rawText, ctx, preset = {}) {
  const values = {}; const missing = []; const errors = [];
  let text = rawText.trim();

  // attachments given with the message fill the attachment option (e.g. ban proof)
  const attOpt = optDefs.find(o => o.type === T.ATTACHMENT);
  if (attOpt && ctx.attachments[0]) values[attOpt.name] = ctx.attachments[0];
  // a link anywhere in the text fills a "proof_link" style option
  const linkOpt = optDefs.find(o => o.type === T.STRING && /^proof/.test(o.name));
  if (linkOpt) {
    const m = /https?:\/\/\S+/i.exec(text);
    if (m) { values[linkOpt.name] = m[0]; text = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').trim(); }
  }
  const flow = optDefs.filter(o => o.type !== T.ATTACHMENT && !(linkOpt && o === linkOpt));
  const lastFree = [...flow].reverse().find(o => o.type === T.STRING && !o.choices?.length);
  const toks = tokenize(text);
  let k = 0;

  for (const opt of flow) {
    if (preset[opt.name] !== undefined) { values[opt.name] = preset[opt.name]; continue; }
    const tok = toks[k];
    if (!tok) { if (opt.required) missing.push(opt.name); continue; }
    const v = tok.v;
    switch (opt.type) {
      case T.USER: {
        const id = idOf(v, /^<@!?(\d+)>$/); const u = id && await ctx.resolveUser(id);
        if (u) { values[opt.name] = u; values[`${opt.name}__member`] = await ctx.resolveMember(id); k++; }
        else if (opt.required) errors.push(`I couldn't find the user \`${v}\`. Mention them or use their ID.`);
        break;
      }
      case T.CHANNEL: {
        const id = idOf(v, /^<#(\d+)>$/); const c = id && await ctx.resolveChannel(id);
        if (c) { values[opt.name] = c; k++; } else if (opt.required) errors.push(`I couldn't find the channel \`${v}\`.`);
        break;
      }
      case T.ROLE: {
        const r = await ctx.resolveRole(v);
        if (r) { values[opt.name] = r; k++; } else if (opt.required) errors.push(`I couldn't find the role \`${v}\`.`);
        break;
      }
      case T.INT: case T.NUMBER: {
        let n;
        if (opt.choices?.length) n = pick(opt, v);
        else if (/^-?\d+(\.\d+)?$/.test(v)) n = opt.type === T.INT ? parseInt(v, 10) : Number(v);
        if (n !== undefined && !Number.isNaN(n)) { values[opt.name] = n; k++; }
        else if (opt.required) errors.push(`\`${opt.name}\` must be ${opt.choices?.length ? 'one of: ' + opt.choices.map(c => c.name).join(', ') : 'a number'}.`);
        break;
      }
      case T.BOOL: values[opt.name] = /^(true|yes|y|on|1)$/i.test(v); k++; break;
      default: { // STRING
        if (opt.choices?.length) {
          const c = pick(opt, v);
          if (c !== undefined) { values[opt.name] = c; k++; }
          else if (opt.required) errors.push(`\`${opt.name}\` must be one of: ${opt.choices.map(c => c.name).join(', ')}.`);
        } else if (opt === lastFree) { values[opt.name] = text.slice(tok.start).trim().replace(/^"(.*)"$/s, '$1'); k = toks.length; }
        else { values[opt.name] = v; k++; }
      }
    }
  }
  return { values, missing, errors };
}

// ---------- the stand-in interaction ----------
class Opts {
  constructor(sub, vals) { this.sub = sub; this.v = vals; }
  getSubcommand(required = true) { return this.sub ?? (required ? null : null); }
  getString(n) { return this.v[n] ?? null; }
  getInteger(n) { return this.v[n] ?? null; }
  getNumber(n) { return this.v[n] ?? null; }
  getBoolean(n) { return this.v[n] ?? null; }
  getUser(n) { return this.v[n] ?? null; }
  getMember(n) { return this.v[`${n}__member`] ?? null; }
  getChannel(n) { return this.v[n] ?? null; }
  getRole(n) { return this.v[n] ?? null; }
  getAttachment(n) { return this.v[n] ?? null; }
}

class PrefixInteraction {
  constructor(message, name, opts) {
    this.isPrefix = true; this.message = message; this.client = message.client;
    this.user = message.author; this.member = message.member; this.guild = message.guild; this.guildId = message.guild.id;
    this.channel = message.channel; this.channelId = message.channel.id; this.commandName = name; this.options = opts;
    this.memberPermissions = message.member?.permissions; this.deferred = false; this.replied = false; this._msg = null;
  }
  isChatInputCommand() { return true; }
  isButton() { return false; }
  _prep(p) {
    p = typeof p === 'string' ? { content: p } : { ...p };
    let flags = p.flags === undefined ? 0 : Number(p.flags);
    const eph = !!(flags & EPH) || !!p.ephemeral;
    delete p.ephemeral; flags &= ~EPH;
    if (flags) p.flags = flags; else delete p.flags;
    if (!p.allowedMentions) p.allowedMentions = { parse: [], repliedUser: false };
    return [p, eph];
  }
  async _send(p, eph, asReply = true) {
    let m;
    try { m = await this.channel.send(asReply ? { ...p, reply: { messageReference: this.message.id, failIfNotExists: false } } : p); }
    catch { m = await this.channel.send(p); }
    // "private" replies can't be private here, so they clean themselves up
    if (eph && !(p.files && p.files.length)) setTimeout(() => m.delete().catch(() => {}), 45000);
    return m;
  }
  async reply(p) { const [q, e] = this._prep(p); this.replied = true; return (this._msg = await this._send(q, e)); }
  async deferReply() { this.deferred = true; this.channel.sendTyping?.().catch(() => {}); }
  async editReply(p) {
    const [q, e] = this._prep(p);
    if (this._msg) { try { return (this._msg = await this._msg.edit(q)); } catch {} }
    this.replied = true; return (this._msg = await this._send(q, e));
  }
  async followUp(p) { const [q, e] = this._prep(p); return this._send(q, e, false); }
  async fetchReply() { return this._msg; }
  async deleteReply() { await this._msg?.delete().catch(() => {}); }
  async showModal() { return this.reply({ content: 'That one needs the slash command version.' }); }
}

// ---------- wiring ----------
let table = null; // name -> { json, handler }
function build(defs, handlers) {
  table = {};
  for (const d of defs) { const json = d.toJSON(); table[json.name] = { json, handler: handlers[json.name] }; }
}

async function onMessage(client, m) {
  if (!table || m.author.bot || !m.guild || !m.member) return false;
  const p = cfg.prefix;
  if (!m.content.startsWith(p) || m.content.length === p.length) return false;
  const body = m.content.slice(p.length).trim();
  const first = /^(\S+)/.exec(body);
  if (!first) return false;
  let name = first[1].toLowerCase(); let preset = {};
  const al = ALIAS[name];
  if (al) [name, preset] = Array.isArray(al) ? al : [al, {}];
  const entry = table[name];
  if (!entry) return false;                      // not a command: just a normal message that starts with "-"

  // Members can only use commands in #commands. Anywhere else the message is removed and nothing else is shown
  // (no usage help, no output), so commands never clutter general chat, media or tickets.
  const wrong = placeProblem({ guild: m.guild, channel: m.channel, channelId: m.channel.id, member: m.member, user: m.author });
  if (wrong) {
    m.delete().catch(() => {});
    const w = await m.channel.send({ content: `<@${m.author.id}> ${wrong}`, allowedMentions: { users: [m.author.id] } }).catch(() => null);
    if (w) setTimeout(() => w.delete().catch(() => {}), 6000);
    return true;
  }
  let rest = body.slice(first[0].length).trim();

  // subcommand
  let optDefs = entry.json.options || []; let sub = null;
  if (optDefs[0]?.type === T.SUB) {
    const subs = optDefs; const toks = tokenize(rest);
    const want = preset._sub || toks[0]?.v?.toLowerCase();
    const s = subs.find(x => x.name === want);
    if (!s) { await m.reply({ content: `Usage:\n${subs.map(x => '`' + usage(name, x.name, x.options || []) + '`').join('\n')}`, allowedMentions: { repliedUser: false } }).catch(() => {}); return true; }
    sub = s.name; optDefs = s.options || [];
    if (!preset._sub) rest = rest.slice(toks[0].end).trim();
  }

  // Discord's own default-permission check does not apply to text commands, so apply it here
  const need = entry.json.default_member_permissions;
  if (need && !isOwner(m.author.id) && !FULLY_GATED.has(name) && !m.member.permissions.has(BigInt(need))) {
    await m.reply({ content: "You don't have permission to do that.", allowedMentions: { repliedUser: false } }).catch(() => {});
    return true;
  }

  const ctx = {
    attachments: [...m.attachments.values()],
    resolveUser: async id => m.mentions.users.get(id) || client.users.fetch(id).catch(() => null),
    resolveMember: async id => m.guild.members.fetch(id).catch(() => null),
    resolveChannel: async id => m.guild.channels.cache.get(id) || m.guild.channels.fetch(id).catch(() => null),
    resolveRole: async v => {
      const id = idOf(v, /^<@&(\d+)>$/);
      return (id && m.guild.roles.cache.get(id)) || m.guild.roles.cache.find(r => r.name.toLowerCase() === v.toLowerCase()) || null;
    },
  };
  const { values, missing, errors } = await parseArgs(optDefs, rest, ctx, preset);
  if (errors.length || missing.length) {
    await m.reply({ content: `${errors.join('\n')}${errors.length ? '\n' : ''}Usage: \`${usage(name, sub, optDefs)}\``, allowedMentions: { repliedUser: false } }).catch(() => {});
    return true;
  }
  const fake = new PrefixInteraction(m, name, new Opts(sub, values));
  try {
    if (!(await guard(fake))) return true;
    await entry.handler?.(fake);
  } catch (err) {
    console.error(`prefix ${name}:`, err);
    await m.reply({ content: 'Something went wrong. Please try again or contact staff.', allowedMentions: { repliedUser: false } }).catch(() => {});
  }
  return true;
}

module.exports = { build, onMessage, parseArgs, tokenize, ALIAS };
