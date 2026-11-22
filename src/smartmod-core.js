// Pure text logic for the smart auto-mod (no Discord code, no network), so it is quick to run and easy to test.
//  * undoes obfuscation: homoglyphs (Cyrillic/Greek lookalikes), fullwidth/styled letters, zero-width chars, leetspeak,
//    spaced letters, "(dot)" style link hiding
//  * scores scam / phishing / malware / fake-staff messages with weighted patterns
//  * finds lookalike domains (dlscord.com, roblox-free.com, discord-nitro.gift ...)
//  * compares usernames to staff / brand names (impersonation)
const F = require('./filter');

// ---------- normalising ----------
const HOMO = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'с': 'c', 'ԁ': 'd', 'е': 'e', 'һ': 'h', 'і': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p',
  'ѕ': 's', 'т': 't', 'у': 'y', 'х': 'x', 'ѡ': 'w', 'ɡ': 'g', 'ӏ': 'l', 'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ɢ': 'g',
  'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ʀ': 'r', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ᴢ': 'z',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'γ': 'y', 'η': 'n', 'ω': 'w',
  // misc lookalikes
  'ł': 'l', 'ø': 'o', 'đ': 'd', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ı': 'i', 'ƒ': 'f', 'ɑ': 'a', 'ɛ': 'e',
};
const ZERO = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\u3164\ufe00-\ufe0f\ufeff]/g;
const LEET = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g', '€': 'e', '£': 'l', '¡': 'i' };

// Step 1: look-alike letters -> plain letters (keeps spaces and punctuation, so word boundaries survive)
function fold(s) {
  let t = String(s || '').normalize('NFKD').replace(ZERO, '').toLowerCase();
  t = t.replace(/[\u0300-\u036f]/g, '');
  return [...t].map(c => HOMO[c] || c).join('');
}
// Step 2: fold + leet + hide-tricks undone. Used for matching, never shown to people.
function deobfuscate(s) {
  let t = fold(s)
    .replace(/\s*[\[({<]\s*(?:dot|d0t|\.)\s*[\])}>]\s*/g, '.')
    .replace(/\s+(?:dot|d0t)\s+/g, '.')
    .replace(/\bh[xt]{2}ps?(?:\[?:\]?|:)\/\//g, 'https://')
    .replace(/\[\.\]|\(\.\)|\{\.\}/g, '.');
  t = t.replace(/[01!|34@5$7+89€£¡]/g, c => LEET[c] || c);
  // spaced letters ("s w e a r", "f.r.e.e") -> joined, only for runs of 3+ single characters
  t = t.replace(/(?:^|(?<=[^a-z]))((?:[a-z][\s._\-*,]+){2,}[a-z])(?=$|[^a-z])/g, m => m.replace(/[^a-z]/g, ''));
  t = t.replace(/([a-z])\1{2,}/g, '$1$1');             // freeeee -> free (keeps double letters)
  return t;
}
const letters = s => deobfuscate(s).replace(/[^a-z0-9]/g, '');

// How "disguised" a message is (0 = normal). Used to decide whether the AI should take a look.
function obfuscationScore(text) {
  const raw = String(text || '');
  let n = 0;
  if (ZERO.test(raw)) { n += 2; ZERO.lastIndex = 0; }
  const homo = [...raw.toLowerCase()].filter(c => HOMO[c]).length;
  if (homo >= 1 && /[a-z]/i.test(raw)) n += homo >= 3 ? 3 : 2;
  for (const tok of raw.toLowerCase().split(/\s+/)) {
    if (/^[a-z]+$/.test(tok) || tok.length < 3) continue;
    if (/[a-z][01345789@$!|][a-z]|[a-z][*#%^~_.\-][a-z]/.test(tok) && !/^https?:|\.[a-z]{2,}$/.test(tok)) n++;   // sh1t, f*ck, f.ck
  }
  if (/(?:\b[a-z][\s._\-*,]+){3,}[a-z]\b/i.test(raw)) n += 2;                                               // s w e a r
  return n;
}

// ---------- profanity bypass (on top of filter.js) ----------
// Tokens that are swears with the vowels left out. Whole-token match only, so normal words are safe.
const SKELETONS = new Set(['fck', 'fuk', 'fuq', 'fvck', 'fvk', 'fcuk', 'fukk', 'sht', 'shyt', 'shiit', 'btch', 'biatch', 'bytch', 'cnt', 'dck', 'dik', 'phuck', 'phuk', 'azz', 'a55', 'kys', 'wtfuck']);
function profanityBypass(text, extra = []) {
  const raw = String(text || '');
  if (!raw) return null;
  const folded = fold(raw);
  const hit = F.findBadWord(folded, extra) || F.findBadWord(deobfuscate(raw), extra);
  if (hit) return hit;
  for (const tok of deobfuscate(raw).split(/[^a-z0-9]+/)) if (SKELETONS.has(tok)) return tok;
  return null;
}

// ---------- scams / phishing / malware / fake staff ----------
// [kind, weight, regex]  (matched against the de-obfuscated, lowercased text)
const PATTERNS = [
  // free stuff / giveaways
  ['scam', 3, /\b(?:free|claim|get|win|won|giveaway|gifts?)\b[^.\n]{0,40}\b(?:robux|rbx|nitro|nitr0|v-?bucks|steam|skins?|gift ?cards?|limiteds?)\b/],
  ['scam', 3, /\b(?:robux|rbx|nitro)\b[^.\n]{0,30}\b(?:free|generator|giveaway|claim|gift)\b/],
  ['scam', 2, /\b(?:you(?:'| a)?ve won|you have won|congratulations?[^.\n]{0,30}(?:won|selected|chosen))\b/],
  ['scam', 2, /\b(?:limited|exclusive)\b[^.\n]{0,30}\b(?:giveaway|offer|airdrop)\b/],
  ['scam', 3, /\b(?:airdrop|free (?:crypto|bitcoin|eth|nft|tokens?))\b/],
  ['scam', 2, /\b(?:crypto|bitcoin|btc|forex|invest(?:ment|ing)?|trading signals?)\b[^.\n]{0,50}\b(?:profit|returns?|guaranteed|earn|passive income|double)\b/],
  ['scam', 2, /\b(?:dm|message|text|pm) me\b[^.\n]{0,40}\b(?:robux|nitro|gift|invest|crypto|earn|profit|free)\b/],
  ['scam', 3, /\b(?:send|give)\b[^.\n]{0,20}\b(?:me|us)\b[^.\n]{0,25}\b(?:\d+\s*(?:robux|rbx)|your (?:items?|limiteds?|pets?))\b[^.\n]{0,30}\b(?:first|double|triple)\b/],
  ['scam', 3, /\b(?:trade|send) (?:me )?first\b/],
  // commission / payment scams (very common against designers and developers)
  ['scam', 3, /\b(?:overpa(?:y|id|yment)|send (?:me )?(?:back )?the (?:difference|extra|rest)|refund (?:me )?the (?:difference|extra))\b/],
  ['scam', 2, /\b(?:cash ?app|zelle|venmo|western union|gift ?cards?)\b[^.\n]{0,50}\b(?:pay|payment|send|upfront|first)\b/],
  ['scam', 2, /\bpaypal\b[^.\n]{0,25}\b(?:friends? (?:and|&) family|f&f|ff)\b/],
  // phishing / account theft
  ['phishing', 3, /\b(?:verify|confirm|secure|restore|re-?activate)\b[^.\n]{0,30}\b(?:your )?(?:account|discord|roblox|login|identity)\b/],
  ['phishing', 3, /\byour (?:account|discord|roblox)\b[^.\n]{0,40}\b(?:(?:has been|will be|is being|got|was)\s+)?(?:disabled|banned|suspended|terminated|compromised|hacked|reported|flagged|locked|deleted)\b/],
  ['phishing', 3, /\b(?:log ?in|sign ?in|login)\b[^.\n]{0,25}\b(?:with|using|via|through)\b[^.\n]{0,15}\bqr\b/],
  ['phishing', 3, /\b(?:scan|use)\b[^.\n]{0,20}\bqr(?: ?code)?\b[^.\n]{0,40}\b(?:claim|verify|login|log in|free|nitro|robux|gift|reward)\b/],
  ['phishing', 5, /\b(?:roblosecurity|\.roblosecurity|roblox cookie|your cookie|cookie logger|token grabber|discord token)\b/],
  ['phishing', 3, /\b(?:enter|send|give|type|share|tell)\b[^.\n]{0,20}\b(?:me )?(?:your )?(?:password|passcode|2fa (?:code)?|verification code|login code|backup codes?)\b/],
  ['phishing', 2, /\b(?:security alert|urgent|immediately|within 24 hours|final warning)\b[^.\n]{0,40}\b(?:account|login|verify|click)\b/],
  // malware / "run this" tricks
  ['malware', 5, /\b(?:powershell|cmd|command prompt|terminal|console|inspect element|f12)\b[^.\n]{0,40}\b(?:paste|run|execute|type|copy)\b/],
  ['malware', 5, /\b(?:paste|run|execute)\b[^.\n]{0,30}\b(?:in|into)\b[^.\n]{0,15}\b(?:powershell|cmd|command prompt|terminal|console)\b/],
  ['malware', 3, /\b(?:download|install|run|open)\b[^.\n]{0,30}\b[a-z0-9_-]+\.(?:exe|scr|bat|msi|jar|apk|ps1|vbs|lnk)\b/],
  ['malware', 3, /\b(?:curl|wget|iex|invoke-expression|invoke-webrequest)\b/],
  ['malware', 3, /\b(?:test|try|playtest|check out)\b[^.\n]{0,25}\b(?:my|our) (?:new )?(?:game|bot|project|map|build)\b[^.\n]{0,30}\b(?:download|\.exe|\.zip|\.rar|link)\b/],
  // fake staff / fake support
  ['impersonation', 3, /\b(?:i am|i'm|im|this is|we are|we're|i work (?:as|for|with)|i'm from)\b[^.\n]{0,25}\b(?:a |an |the |your )?(?:staff|admin|administrator|mod|moderator|owner|support team|support staff|official|management|manager|discord (?:team|staff|support|moderator)|roblox (?:team|staff|support|admin))\b[^.\n]{0,60}\b(?:dm|message|contact|send|click|verify|add me|open a ticket)\b/],
  ['impersonation', 2, /\b(?:official|verified)\b[^.\n]{0,15}\b(?:support|staff|admin|moderator|team)\b/],
  ['impersonation', 2, /\b(?:support|staff|admin|moderator)\b[^.\n]{0,20}\b(?:will|is going to|are going to)\b[^.\n]{0,15}\b(?:dm|message|contact)\b/],
  ['impersonation', 3, /\b(?:dm|message|contact) (?:me|us)\b[^.\n]{0,20}\b(?:support|help with your (?:order|ticket|account|purchase))\b/],
];
// words that make a "grey" result more suspicious
const BAIT = /\b(?:free|claim|giveaway|nitro|robux|gift|verify|urgent|limited|winner|airdrop|invest|crypto|password|cookie|qr)\b/;

const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 'cutt.ly', 'is.gd', 't.ly', 'rb.gy', 'shorturl.at', 'tiny.cc', 'ow.ly', 'rebrand.ly', 'buff.ly', 'lnkd.in', 'goo.gl', 'v.gd', 'soo.gd', 'clck.ru', 'shorte.st', 'adf.ly', 'bc.vc']);
const BAD_TLDS = new Set(['xyz', 'tk', 'ml', 'ga', 'cf', 'gq', 'top', 'icu', 'click', 'zip', 'mov', 'work', 'support', 'rest', 'monster', 'cyou', 'buzz', 'sbs']);
// [brand label, real registered domains]
const BRANDS = [
  ['discord', ['discord.com', 'discord.gg', 'discordapp.com', 'discord.media', 'discordapp.net', 'discord.gift', 'discordstatus.com', 'discord.new', 'discord.design', 'discord.dev']],
  ['discordapp', ['discordapp.com', 'discordapp.net']],
  ['roblox', ['roblox.com', 'rbxcdn.com', 'roblox.qq.com', 'robloxlabs.com']],
  ['steamcommunity', ['steamcommunity.com']],
  ['steampowered', ['steampowered.com']],
  ['paypal', ['paypal.com', 'paypal.me']],
  ['youtube', ['youtube.com', 'youtu.be']],
  ['twitter', ['twitter.com', 'x.com', 't.co']],
  ['github', ['github.com', 'github.io', 'githubusercontent.com']],
  ['epicgames', ['epicgames.com']],
  ['nitro', []],
];
const TWO_PART = /\.(?:co|com|org|net|gov|ac)\.[a-z]{2}$/;
function registered(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const p = h.split('.');
  if (p.length <= 2) return h;
  return TWO_PART.test(h) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Look at one link. Returns { weight, why } (weight 0 = nothing odd).
function linkRisk(link, trustedDomains = []) {
  const host = F.hostOf(link);
  if (!host) return { weight: 0, why: '' };
  const reg = registered(host);
  if (trustedDomains.some(d => host === d || host.endsWith(`.${d}`))) return { weight: 0, why: '' };
  for (const [, real] of BRANDS) if (real.some(d => host === d || host.endsWith(`.${d}`))) return { weight: 0, why: '' };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { weight: 2, why: 'link to a raw IP address' };
  if (host.includes('xn--')) return { weight: 3, why: 'punycode (look-alike characters) in the domain' };
  const label = reg.split('.')[0];
  // i/l/1 and rn/m style swaps all look the same to a human, so compare "skeletons"
  const skel = x => deobfuscate(x).replace(/[^a-z]/g, '').replace(/l/g, 'i').replace(/rn/g, 'm').replace(/vv/g, 'w');
  const parts = [label, ...label.split(/[-_]/)].filter(Boolean);
  for (const [brand, real] of BRANDS) {
    if (real.includes(reg) || brand.length < 5) {
      if (brand === 'nitro' && /nitro/.test(deobfuscate(label))) return { weight: 3, why: `"nitro" domain (${reg})` };
      continue;
    }
    const sb = skel(brand);
    for (const p of parts) {
      const sp = skel(p);
      if (sp === sb) return { weight: 5, why: `look-alike of ${brand} (${reg})` };
      if (sp.includes(sb)) return { weight: /gift|nitro|free|claim|login|verify|support|promo|reward|drop|robux|steam|security/.test(deobfuscate(label)) || BAD_TLDS.has(reg.split('.').pop()) ? 5 : 4, why: `look-alike of ${brand} (${reg})` };
      if (Math.abs(sp.length - sb.length) <= 1 && levenshtein(sp, sb) === 1) return { weight: 5, why: `look-alike of ${brand} (${reg})` };
    }
  }
  if (SHORTENERS.has(reg)) return { weight: 1, why: `shortened link (${reg})` };
  const tld = reg.split('.').pop();
  if (BAD_TLDS.has(tld)) return { weight: 1, why: `high-risk .${tld} domain` };
  return { weight: 0, why: '' };
}

// Main text scorer. Returns { kind, score, hits:[strings], links:[...] } (kind null when nothing matched).
function scoreText(text, { trusted = [] } = {}) {
  const raw = String(text || '');
  const d = deobfuscate(raw).replace(/\s+/g, ' ');
  const byKind = {}; const hits = [];
  for (const [kind, w, re] of PATTERNS) {
    const m = re.exec(d);
    if (m) { byKind[kind] = (byKind[kind] || 0) + w; hits.push(`${kind}: "${m[0].slice(0, 60)}"`); }
  }
  const links = F.findLinks(d);
  const linkInfo = [];
  for (const l of links) {
    const r = linkRisk(l, trusted);
    if (r.weight) { linkInfo.push(r.why); byKind.phishing = (byKind.phishing || 0) + r.weight; hits.push(`link: ${r.why}`); }
  }
  if (/@everyone|@here/.test(raw) && links.length) { byKind.scam = (byKind.scam || 0) + 1; hits.push('@everyone with a link'); }
  let kind = null, score = 0;
  for (const [k, v] of Object.entries(byKind)) if (v > score) { kind = k; score = v; }
  // several kinds at once makes it worse
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  return { kind, score: Math.max(score, Math.min(total, score + 2)), hits, links, bait: BAIT.test(d) };
}

// ---------- impersonation of staff / brand ----------
const ROLE_WORDS = ['staff', 'admin', 'administrator', 'moderator', 'mod', 'owner', 'support', 'official', 'management', 'manager', 'founder', 'ceo', 'helper', 'supportteam', 'staffteam', 'modteam', 'adminteam', 'officialsupport'];
const ROLE_SUFFIX = /(?:staff|admin|mod|moderator|support|official|owner|team|manager|helper|ceo|founder)/;
const ONLY_NAME = s => letters(s);

// names: array of the member's names (username, display name, nickname, global name)
// targets: [{ name, kind: 'staff'|'owner'|'brand', id }]
function impersonates(names, targets) {
  for (const raw of names.filter(Boolean)) {
    const n = ONLY_NAME(raw);
    if (n.length < 3) continue;
    if (ROLE_WORDS.includes(n)) return { why: 'uses a staff/role word as their name', target: n, kind: 'role' };
    for (const t of targets) {
      const tn = ONLY_NAME(t.name);
      if (tn.length < 3) continue;
      if (n === tn) return { why: `same name as ${t.kind} "${t.name}"`, target: t.name, kind: t.kind, id: t.id, exact: true };
      if (tn.length >= 5 && levenshtein(n, tn) <= (tn.length >= 9 ? 2 : 1)) return { why: `near-identical to ${t.kind} "${t.name}"`, target: t.name, kind: t.kind, id: t.id };
      if (tn.length >= 5 && n.includes(tn) && ROLE_SUFFIX.test(n.replace(tn, ''))) return { why: `"${t.name}" plus a staff word`, target: t.name, kind: t.kind, id: t.id };
    }
  }
  return null;
}

// ---------- should the AI look at this? ----------
// Local result + context -> true when an AI call is worth the money.
function worthAsking(local, ctx = {}) {
  const { text = '', newAccount = false, scope = 'suspicious' } = ctx;
  if (scope === 'all') return text.length >= 4;
  if (local.score >= 1) return true;                                       // something matched, but not certain
  if (obfuscationScore(text) >= 2) return true;                            // looks disguised
  if (scope === 'newmembers' && newAccount && text.length >= 6) return true;
  if (local.bait && (local.links.length || newAccount)) return true;
  if (newAccount && local.links.length) return true;
  return false;
}

module.exports = {
  fold, deobfuscate, letters, obfuscationScore, profanityBypass, scoreText, linkRisk, impersonates, worthAsking,
  levenshtein, registered, ROLE_WORDS,
};
