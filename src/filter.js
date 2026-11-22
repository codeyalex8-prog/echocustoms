// Pure text helpers for auto-moderation (no Discord code in here, so it is easy to test).
// Profanity is matched on whole words after undoing common tricks (f.u.c.k, fuuuck, f*ck, 5h1t, accents).

const SWEARS = [
  'fuck', 'shit', 'bitch', 'bastard', 'asshole', 'ass', 'arse', 'arsehole', 'dick', 'dickhead', 'cock', 'cocksucker',
  'cunt', 'pussy', 'whore', 'slut', 'twat', 'wanker', 'bollocks', 'prick', 'douche', 'douchebag', 'jackass',
  'dumbass', 'dipshit', 'shithead', 'bullshit', 'motherfucker', 'fucker', 'piss', 'kys',
];
const SLURS = [
  'nigger', 'nigga', 'faggot', 'fag', 'tranny', 'retard', 'spic', 'chink', 'kike', 'gook', 'wetback', 'beaner',
];
const PHRASES = ['kill yourself', 'go die'];
// Always bad, even glued inside a longer word ("motherfucker", "fuckyou").
const CONTAINS = ['fuck', 'nigger', 'nigga', 'faggot', 'bitch', 'bullshit', 'shithead', 'asshole', 'dickhead', 'motherf'];

const LEET = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g', '€': 'e', '£': 'l' };

function normalize(s) {
  return String(s).toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[01!|34@5$7+89€£]/g, c => LEET[c])
    .replace(/[*#%^~`_]/g, '');           // f*ck -> fck is handled by the "stars as vowels" pass below
}

// letters repeated n times in the word must appear >= n times (so "ass" does not match "as", "fuuuck" still matches "fuck")
const rx = w => new RegExp('^' + w.replace(/(.)\1*/g, (m, c) => `${c}{${m.length},}`) + '(?:s|es|ed|er|ers|ing|in|y|ie|ies|z)?$');

let cache = { key: '', list: [] };
function compiled(extra = []) {
  const key = extra.join('|');
  if (cache.key !== key || !cache.list.length) {
    const words = [...SWEARS, ...SLURS, ...extra.map(w => String(w).toLowerCase().trim()).filter(Boolean)];
    cache = { key, list: [...new Set(words)].map(w => ({ w, re: rx(w) })) };
  }
  return cache.list;
}

// Returns the bad word that was matched, or null.
function findBadWord(text, extra = []) {
  if (!text) return null;
  const list = compiled(extra);
  const raw = String(text).toLowerCase();
  // f*ck / sh*t style masking: treat a star between letters as a wildcard vowel
  const starred = [];
  for (const tok of raw.split(/[^a-z0-9*@$!|+]+/).filter(t => t.includes('*') && t.length > 2))
    for (const v of 'aeiou') starred.push(tok.replace(/\*/g, v));
  const n = normalize(raw);

  const tokens = [...n.split(/[^a-z]+/).filter(Boolean), ...starred.map(normalize).flatMap(t => t.split(/[^a-z]+/))];
  for (const t of tokens) {
    for (const { w, re } of list) if (re.test(t)) return w;
    for (const c of CONTAINS) if (t.includes(c)) return c;
  }
  // spaced letters: "f u c k", "f.u.c.k", "f-u-c-k" (also when other single letters come first, e.g. "a f u c k")
  for (const run of n.match(/(?:\b[a-z][\s._\-,]+){2,}[a-z]\b/g) || []) {
    const letters = run.replace(/[^a-z]/g, '').split('');
    for (let a = 0; a < letters.length; a++)
      for (let b = a + 3; b <= Math.min(letters.length, a + 14); b++) {
        const joined = letters.slice(a, b).join('');
        for (const { w, re } of list) if (re.test(joined)) return w;
      }
  }
  const flat = n.replace(/\s+/g, ' ');
  for (const p of PHRASES) if (flat.includes(p)) return p;
  return null;
}

// ---------- links ----------
const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>()]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|gg|io|xyz|co|me|tv|ly|app|dev|link|ru|cc|club|shop|store|site|online|info|biz|us|uk|to|ws|tk|ml|ga|cf|gq|fun|live|pro|top|vip|lol|icu)\b(?:\/[^\s<>()]*)?/gi;

function findLinks(text) {
  if (!text) return [];
  // strip code that only looks like a link, e.g. discord markdown <@123>
  return (String(text).match(LINK_RE) || []).map(l => l.replace(/[.,!?;:]+$/, ''));
}
function hostOf(link) {
  try { return new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}
function linkAllowed(link, allowed = []) {
  const h = hostOf(link);
  return !!h && allowed.some(d => h === d || h.endsWith(`.${d}`));
}

module.exports = { findBadWord, findLinks, linkAllowed, hostOf, normalize };
