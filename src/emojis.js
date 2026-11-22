// ============================================================================================================
//  EMOJIS: only YOUR white icons are ever shown. No random unicode emojis anywhere.
// ============================================================================================================
//  1. Your server's emojis are looked up BY NAME when the bot starts (no IDs to copy). The number prefix Discord
//     shows (e.g. 195368membericon) is ignored, so renaming / re-uploading never breaks anything.
//  2. Every message the bot sends (panels, mod logs, DMs, buttons, dropdowns, AI replies, ...) passes through ONE
//     filter (install() below). Any unicode emoji in it is swapped for the matching white icon from UNI, and
//     anything that has no white icon is removed. So an emoji can't sneak in from old code or from the AI.
//  3. Want a different icon for something? Move the unicode emoji to another key in UNI (nothing else to edit).
//  4. Run /emojis (owner) to see which icons were found in your server and which names it looked for.
// E.<key> objects must contain ONLY name/id/animated (Discord's builders reject anything else),
// so the lookup names and fallbacks live in separate tables.
// ============================================================================================================
const META = {};
const mk = (fallback, ...names) => ({ fallback, names });
const def = o => Object.fromEntries(Object.entries(o).map(([k, v]) => { META[k] = v; return [k, { name: v.fallback }]; }));

// key -> the names it may have in your server (first match wins; "icon" at the end of a name is optional)
const E = def({
  logo:       mk('✨', 'download4', 'codey', 'codeys', 'codeylogo', 'echo', 'echologo', 'logo'),
  money:      mk('💰', 'donationicon', 'moneyicon', 'money'),
  person:     mk('👤', 'membericon', 'personicon', 'member'),
  pc:         mk('🖥️', 'pcicon', 'computericon', 'pc'),
  thumbsup:   mk('👍', 'likeicon', 'thumbsupicon', 'like'),
  bell:       mk('🔔', 'notificationicon', 'bellicon', 'notification'),
  megaphone:  mk('📣', 'announcementicon', 'megaphoneicon', 'announcement'),
  share:      mk('🔗', 'shareicon', 'linkicon', 'share'),
  punishment: mk('⚖️', 'punishmenticon', 'punishment', 'banicon', 'jailicon', 'ruleicon'),
  star:       mk('⭐', 'subscribericon', 'staricon', 'subscriber'),
  crown:      mk('👑', 'crownicon', 'crown'),
  gift:       mk('🎁', 'gifticon', 'gift'),
  follow:     mk('➕', 'followicon', 'follow'),
  merch:      mk('👕', 'merchicon', 'merch'),
  train:      mk('🚂', 'trainicon', 'train'),
  superstar:  mk('🌟', 'supersubscribericon', 'superstaricon'),
  socials:    mk('🌐', 'socialsicon', 'socialicon', 'socials'),
  twitter:    mk('🐦', 'twittericon', 'twitter'),
  moderator:  mk('⚔️', 'moderatoricon', 'modicon', 'moderator'),
  rekt:       mk('💀', 'rekticon', 'rekt'),
  spec:       mk('⚙️', 'specicon', 'settingsicon', 'spec'),
  schedule:   mk('📅', 'scheduleicon', 'schedule', 'clockicon'),
  superchat:  mk('💬', 'superchaticon', 'chaticon', 'superchat'),
  supporter:  mk('💖', 'supportericon', 'supporter'),
  rule:       mk('📜', 'ruleicon', 'rulesicon', 'rule'),
});

// ------------------------------------------------------------------------------------------------------------
// unicode emoji -> which white icon replaces it. Anything NOT listed here is simply removed from messages.
// (The coloured status dots are not listed on purpose: their words, like "Online" or "Closed", already say it.)
// ------------------------------------------------------------------------------------------------------------
const UNI = {
  logo:       '✨🤖',
  money:      '💰💵💸💳🪙↩️',
  person:     '👤👥🙂👋',
  pc:         '🖥️💻🏓🖼️🖱️',
  thumbsup:   '👍✅✔️☑️🆗',
  bell:       '🔔🔕⚠️🚨🚩❗❕',
  megaphone:  '📣📢📍📌',
  share:      '🔗📎📤',
  punishment: '⚖️⛔🚫🛑⛓️🔨🚔',
  star:       '⭐🍀📈🏅',
  crown:      '👑🏆',
  gift:       '🎁🎉🎊📦',
  follow:     '➕🆕',
  merch:      '👕🛒🛍️',
  train:      '🚂🚆',
  superstar:  '🌟💫',
  socials:    '🌐🌍',
  twitter:    '🐦',
  moderator:  '⚔️🛡️👢🔰🔒🔓🔐',
  rekt:       '💀❌👎☠️',
  spec:       '⚙️🛠️🔧🎛️🔌🚦🧹♻️🔄',
  schedule:   '📅📆⏰⏳⌛🕐',
  superchat:  '💬🗨️📨📬📫📩🎫💡',
  supporter:  '💖❤️🕊️🤝',
  rule:       '📜📋📝📄🧾📚',
};

// ---------------- finding the emojis in your server ----------------
const bare = n => String(n).toLowerCase().replace(/^[\d_\-\s]+/, '').replace(/[^a-z0-9]/g, '');   // "195368_Member-Icon" -> "membericon"
const core = n => bare(n).replace(/icon$/, '');                                                  // "membericon" -> "member"
const same = (a, b) => bare(a) === bare(b) || core(a) === core(b);

let last = { found: [], missing: [], seen: [] };

// Look through your server first, then every other server the bot is in, then the bot's own app emojis.
async function resolve(client, guildId) {
  const pool = [];
  const home = client.guilds.cache.get(guildId);
  if (home) pool.push(...home.emojis.cache.values());
  pool.push(...client.emojis.cache.values());
  try { pool.push(...(await client.application.emojis.fetch()).values()); } catch {}

  const found = [], missing = [];
  for (const [key, o] of Object.entries(E)) {
    delete o.id; delete o.animated;
    let hit = null;
    for (const w of META[key].names) { hit = pool.find(em => same(em.name, w)); if (hit) break; }   // names in priority order
    if (hit) { o.name = hit.name; o.id = hit.id; if (hit.animated) o.animated = true; found.push(`${key} = :${hit.name}:`); }
    else { o.name = META[key].fallback; missing.push(key); }
  }
  last = { found, missing, seen: [...new Set(pool.map(e => e.name))].sort() };
  return missing;
}

const tag = e => (e.id ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : e.name);

// ---------------- the filter ----------------
// one emoji (including skin tones, flags, keycaps and joined emoji); (c) (r) (tm) and !! are left alone
const EMOJI = '(?![\\u00A9\\u00AE\\u2122\\u203C\\u2049])(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3)(?:\\uFE0F|\\p{Emoji_Modifier})*(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})*)*';
const ONE = new RegExp(EMOJI, 'gu');
const LEAD = new RegExp(`^\\s*(${EMOJI})\\s*`, 'u');

const TABLE = new Map();                                                    // "⚠" (no variation selector) -> key
for (const [key, chars] of Object.entries(UNI)) for (const m of chars.matchAll(ONE)) TABLE.set(m[0].replace(/\uFE0F/g, ''), key);
const keyOf = u => TABLE.get(String(u).replace(/\uFE0F/g, '')) || null;

// the white icon for a unicode emoji, or null when your server doesn't have it (then the emoji is dropped)
const iconFor = u => { const k = keyOf(u); return k && E[k]?.id ? E[k] : null; };

// text: unicode emoji -> white icon (or nothing)
function whiten(s) {
  if (typeof s !== 'string' || !s) return s;
  return s.replace(new RegExp(`(${EMOJI})( ?)`, 'gu'), (_m, u, sp) => { const e = iconFor(u); return e ? tag(e) + sp : ''; });
}
// plain text where custom emojis can't be shown (bot status, nicknames, channel names): just remove every emoji
function strip(s) {
  if (typeof s !== 'string' || !s) return s;
  return s.replace(new RegExp(`${EMOJI} ?`, 'gu'), '').replace(/\s{2,}/g, ' ').trim();
}

// Where custom emoji markup renders: message text only. Button labels, dropdown placeholders / descriptions and
// embed footers are plain text, so there the icon is moved into the component's emoji slot or simply removed.
const icon = e => ({ name: e.name, id: e.id, ...(e.animated ? { animated: true } : {}) });
function fixNode(n) {
  if (n.emoji && typeof n.emoji === 'object' && n.emoji.name && !n.emoji.id) {            // button / option emoji given as unicode
    const e = iconFor(n.emoji.name);
    if (e) n.emoji = icon(e); else delete n.emoji;
  }
  if (typeof n.label === 'string') {
    if (!n.emoji) {                                                                       // "👍 3" as a label -> icon + "3"
      const m = LEAD.exec(n.label);
      if (m) { const e = iconFor(m[1]); n.label = n.label.slice(m[0].length); if (e) n.emoji = icon(e); }
    }
    n.label = strip(n.label);                                                             // any other emoji inside a label
    if (!n.label) { if (n.type === 2 && n.emoji) delete n.label; else if (n.type !== 2) n.label = '\u200b'; else n.label = 'Open'; }
  }
  for (const k of ['description', 'placeholder']) if (typeof n[k] === 'string') { n[k] = strip(n[k]); if (!n[k]) delete n[k]; }
}
function walk(n) {
  if (Array.isArray(n)) { n.forEach(walk); return; }
  if (!n || typeof n !== 'object') return;
  fixNode(n);
  for (const [k, v] of Object.entries(n)) {
    if (k === 'emoji') continue;
    if (typeof v === 'string') { if (k === 'content') n[k] = whiten(v); }
    else walk(v);
  }
}
// embeds use "name"/"value" inside fields and author; handled here so file names and ids are never touched
function body(b) {
  if (!b || typeof b !== 'object') return;
  if (typeof b.content === 'string') b.content = whiten(b.content);
  walk(b.components);
  for (const e of b.embeds || []) {
    if (!e) continue;
    for (const k of ['title', 'description']) if (typeof e[k] === 'string') e[k] = whiten(e[k]);
    if (e.footer?.text) e.footer.text = strip(e.footer.text);
    if (e.author?.name) e.author.name = strip(e.author.name);
    for (const f of e.fields || []) { f.name = whiten(f.name); f.value = whiten(f.value); }
  }
}

// Hook the filter into discord.js ONCE. Everything the bot sends or edits goes through MessagePayload.resolveBody.
function install() {
  const { MessagePayload } = require('discord.js');
  const proto = MessagePayload?.prototype;
  if (!proto?.resolveBody) { console.warn('Emoji filter NOT installed (discord.js changed). Messages may show unicode emojis.'); return false; }
  if (proto.__whiteEmojis) return true;
  const orig = proto.resolveBody;
  proto.resolveBody = function (...args) {
    const out = orig.apply(this, args);
    try { body(this.body); } catch (e) { console.error('emoji filter:', e.message); }
    return out;
  };
  proto.__whiteEmojis = true;
  return true;
}

const report = () => last;
const names = k => META[k]?.names;
module.exports = { E, UNI, names, tag, resolve, install, whiten, strip, iconFor, report };
