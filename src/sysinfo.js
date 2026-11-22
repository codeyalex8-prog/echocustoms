// Diagnostics for the owner panel: uptime, memory, latency, recent errors, db size.
const fs = require('fs');
const path = require('path');
const { db, save } = require('./db');
const AI = require('./ai');

// keep the last 20 console.error lines so the owner panel can show them
const errors = [];
const orig = console.error.bind(console);
console.error = (...a) => {
  try {
    errors.push({ at: Date.now(), msg: a.map(x => (x instanceof Error ? (x.stack || x.message) : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ').replace(/\s+/g, ' ').slice(0, 280) });
    if (errors.length > 20) errors.shift();
  } catch { /* never break logging */ }
  orig(...a);
};
const clearErrors = () => { errors.length = 0; };

const mb = n => `${(n / 1048576).toFixed(1)} MB`;
function dbSize() { try { return fs.statSync(path.join(__dirname, '..', 'data', 'db.json')).size; } catch { return 0; } }
function uptimeText(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d ? d + 'd ' : ''}${h}h ${m}m`;
}
function text(client) {
  const mem = process.memoryUsage();
  const a = AI.state();
  let djs = '?'; try { djs = require('discord.js').version; } catch { /* ignore */ }
  const g = client.guilds.cache.get(require('./config').guildId);
  return [
    `**Uptime:** ${uptimeText(process.uptime())} · **Ping:** ${Math.round(client.ws.ping)}ms · **Node:** ${process.version} · **discord.js:** ${djs}`,
    `**Memory:** ${mb(mem.rss)} used (heap ${mb(mem.heapUsed)}) · **Database:** ${mb(dbSize())}`,
    `**Server:** ${g ? `${g.memberCount} members · ${g.channels.cache.size} channels · ${g.roles.cache.size} roles` : 'not cached'}`,
    `**AI today:** ${a.calls}/${a.limit} calls · ${(a.tokensIn + a.tokensOut).toLocaleString('en-US')} tokens · ${a.errors} errors · key ${AI.hasKey() ? 'set' : '**missing**'}`,
    `**Errors since start:** ${errors.length}${errors.length ? ` (last <t:${Math.floor(errors[errors.length - 1].at / 1000)}:R>)` : ''}`,
  ].join('\n');
}
module.exports = { errors, clearErrors, text, dbSize, uptimeText, save, db };
