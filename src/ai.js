// Thin wrapper around TWO free AI providers (no extra dependencies, uses Node's fetch):
//   1. Groq   (very fast, free key: https://console.groq.com/keys)  -> used first when GROQ_API_KEY is set
//   2. Gemini (free key: https://aistudio.google.com/apikey)        -> backup, and the only one that can look at images
// If Groq is rate limited or down, the next model / provider is tried automatically.
//   .env: GROQ_API_KEY=gsk_...   AI_GROQ_MODELS=llama-3.3-70b-versatile,openai/gpt-oss-120b,llama-3.1-8b-instant   AI_PROVIDER=auto|groq|gemini
// Everything AI in this bot goes through here, so there is ONE place for the key, the models, the daily cap and the on/off switch.
//
//   .env: GEMINI_API_KEY=AIza...            (free key: https://aistudio.google.com/apikey)
//         AI_MODEL_FAST=gemini-3.8-flash    (auto-mod: quick)
//         AI_MODEL_SMART=gemini-3.8-flash   (weekly digest / staff tools: same model, a bit of thinking turned on)
//         AI_DAILY_CALL_LIMIT=1500          (hard cap per day, also editable in the owner panel)
//         AI_MODEL_FALLBACK=gemini-flash-latest,gemini-flash-lite-latest   (backups, comma separated; the bot also finds working models on its own)
//         AI_MAX_PARALLEL=4                 (optional: how many AI calls may run at the same time)
const cfg = require('./config');
const { db, save } = require('./db');

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const day = () => new Date().toISOString().slice(0, 10);
const GEM = {
  get fast() { return (process.env.AI_MODEL_FAST || '').trim() || 'gemini-3.8-flash'; },
  get smart() { return (process.env.AI_MODEL_SMART || '').trim() || 'gemini-3.8-flash'; },
  // tried in order when the main model is overloaded (503), slow (timeout) or gone (404). Comma separated.
  get fallbacks() { return (process.env.AI_MODEL_FALLBACK || 'gemini-flash-latest,gemini-flash-lite-latest').split(',').map(x => x.trim()).filter(Boolean); },
};
// what the owner panel shows as "the model": the first one that will be tried
const primary = () => { const p = state().provider; if (groqKey() && p !== 'gemini' && p !== 'xai') return groqModels()[0]; if (xaiKey() && p !== 'gemini') return xaiModels()[0]; return GEM.fast; };
const MODELS = { get fast() { return primary(); }, get smart() { return primary(); }, GEM, get groq() { return groqModels(); }, get xai() { return xaiModels(); } };
const apiKey = () => (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';
const XAI_BASE = 'https://api.x.ai/v1/chat/completions';
const xaiKey = () => (process.env.XAI_API_KEY || process.env.GROK_API_KEY || '').trim();
const xaiModels = () => (process.env.AI_XAI_MODELS || 'grok-4-fast-non-reasoning,grok-3-mini').split(',').map(x => x.trim()).filter(Boolean);
const groqKey = () => (process.env.GROQ_API_KEY || '').trim();
const groqModels = () => (process.env.AI_GROQ_MODELS || 'llama-3.3-70b-versatile,openai/gpt-oss-120b,llama-3.1-8b-instant').split(',').map(x => x.trim()).filter(Boolean);

function state() {
  const a = (db.ai = db.ai || {});
  if (a.enabled === undefined) a.enabled = true;
  if (!a.limit) a.limit = cfg.num('AI_DAILY_CALL_LIMIT', 1500);
  if (a.day !== day()) { a.day = day(); a.calls = 0; a.tokensIn = 0; a.tokensOut = 0; a.errors = 0; }
  a.total = a.total || { calls: 0, tokensIn: 0, tokensOut: 0 };
  if (!a.provider) a.provider = (process.env.AI_PROVIDER || 'auto').trim().toLowerCase();       // auto | groq | gemini
  if (!['auto', 'groq', 'xai', 'gemini'].includes(a.provider)) a.provider = 'auto';
  return a;
}

const hasKey = () => !!apiKey() || !!groqKey() || !!xaiKey();
// true when AI features may run right now
function available() { const a = state(); return hasKey() && a.enabled && a.calls < a.limit; }
function why() {
  const a = state();
  if (!hasKey()) return 'no AI key set: add GROQ_API_KEY (free, fastest), XAI_API_KEY (Grok) or GEMINI_API_KEY to .env';
  if (!a.enabled) return 'AI is switched off in the owner panel';
  if (a.calls >= a.limit) return `daily AI call limit reached (${a.limit})`;
  return 'ok';
}

// ---- speed: Node's fetch keeps the connection to Google open, and a small gate stops a message burst from hammering the free-tier rate limit
const MAX_PARALLEL = Math.max(1, cfg.num('AI_MAX_PARALLEL', 4));
let running = 0; const waiting = [];
const acquire = () => new Promise(res => { if (running < MAX_PARALLEL) { running++; res(); } else waiting.push(res); });
const release = () => { const n = waiting.shift(); if (n) n(); else running--; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// moderation needs the model to judge NSFW / scams / abuse, so Gemini's own content blocking is turned off for these calls
const SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map(category => ({ category, threshold: 'BLOCK_NONE' }));

// 2.5 models think by default (slow + eats the output budget). Fast = no thinking, smart = a small budget. Gemini 3 uses levels instead.
const NO_THINK = new Set();
function thinking(modelName, tier) {
  if (NO_THINK.has(modelName)) return undefined;
  if (/gemini-3/i.test(modelName)) return { thinkingLevel: 'low' };   // 'minimal' is rejected by some Gemini 3.x models
  if (/gemini-2\.5-pro/i.test(modelName)) return { thinkingBudget: 512 };   // 2.5 Pro cannot switch thinking off
  if (/gemini-2\.5/i.test(modelName)) return { thinkingBudget: tier === 'smart' ? 256 : 0 };
  return undefined;
}

// Download an image so it can be sent to the model (base64). Returns { media_type, data } or null.
async function fetchImage(url, maxBytes = 4.5 * 1024 * 1024) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const len = Number(r.headers.get('content-length') || 0);
    if (len && len > maxBytes) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) return null;
    let type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    // sniff when the CDN sends something generic
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) {
      if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') type = 'image/png';
      else if (buf.slice(0, 3).toString('hex') === 'ffd8ff') type = 'image/jpeg';
      else if (buf.slice(0, 3).toString() === 'GIF') type = 'image/gif';
      else if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') type = 'image/webp';
      else return null;
    }
    return { media_type: type, data: buf.toString('base64') };
  } catch { return null; }
}

// ---- model picking: remember what works, skip what just failed, and ask Google what this key can actually use
const cooldown = new Map();          // model -> time until we skip it (it was busy / slow / gone)
const good = {};                      // tier -> last model that answered
let found = { at: 0, list: [] };      // models discovered through Google's model list
const cool = (m, ms) => cooldown.set(m, Date.now() + ms);

async function discover() {
  if (Date.now() - found.at < 30 * 60e3) return found.list;
  found.at = Date.now();               // set first so a failure does not hammer Google
  try {
    const r = await fetch(`${BASE}?pageSize=200`, { headers: { 'x-goog-api-key': apiKey() }, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.models) return found.list;
    const ver = n => Number((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
    found.list = j.models
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name).replace(/^models\//, ''))
      .filter(n => /^gemini-.*flash/i.test(n) && !/image|tts|live|audio|embed|robot|computer|native|thinking|exp|vision|latest/i.test(n))
      .sort((x, y) => ver(y) - ver(x) || (/lite/i.test(x) ? 1 : 0) - (/lite/i.test(y) ? 1 : 0))
      .slice(0, 5);
    if (found.list.length) console.log('AI: models available to this key:', found.list.join(', '));
  } catch { /* keep the old list */ }
  return found.list;
}

// ---- one request to one model. Returns { ok:true, text, tin, tout } or { ok:false, status, msg, retry }
const NO_JSON = new Set();
async function callGroq(model, o, timeout, prov = 'groq') {
  const oss = prov === 'groq' && /gpt-oss/i.test(model);
  const body = {
    model, temperature: o.temperature,
    messages: [...(o.system ? [{ role: 'system', content: o.system }] : []), { role: 'user', content: o.user }],
  };
  if (oss) { body.max_completion_tokens = o.maxTokens + 400; body.reasoning_effort = 'low'; } else body.max_tokens = o.maxTokens;
  if (o.json && !NO_JSON.has(model)) body.response_format = { type: 'json_object' };
  const r = await fetch(prov === 'xai' ? XAI_BASE : GROQ_BASE, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${prov === 'xai' ? xaiKey() : groqKey()}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) {
    const msg = j?.error?.message || '';
    return { ok: false, status: r.status, msg, retry: Number(r.headers.get('retry-after')) || 0, code: j?.error?.code || '' };
  }
  const u = j.usage || {};
  const text = String(j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { ok: true, text, tin: u.prompt_tokens || 0, tout: u.completion_tokens || 0, why: j.choices?.[0]?.finish_reason };
}

async function callGemini(modelName, o, timeout) {
  const parts = [];
  for (const im of o.images || []) parts.push({ inlineData: { mimeType: im.media_type, data: im.data } });
  parts.push({ text: o.user });
  const generationConfig = { maxOutputTokens: o.maxTokens, temperature: o.temperature };
  if (o.json) generationConfig.responseMimeType = 'application/json';
  const th = thinking(modelName, o.tier);
  if (th) generationConfig.thinkingConfig = th;
  const body = JSON.stringify({
    ...(o.system ? { systemInstruction: { parts: [{ text: o.system }] } } : {}),
    contents: [{ role: 'user', parts }], generationConfig, safetySettings: SAFETY,
  });
  const r = await fetch(`${BASE}/${encodeURIComponent(modelName)}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() }, body, signal: AbortSignal.timeout(timeout),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) return { ok: false, status: r.status, msg: j?.error?.message || '', retry: 0, thinkBad: r.status === 400 && !!th && /think/i.test(j?.error?.message || '') };
  const u = j.usageMetadata || {};
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('\n').trim();
  return { ok: true, text, tin: u.promptTokenCount || 0, tout: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), why: j.promptFeedback?.blockReason || cand?.finishReason || 'no candidates' };
}

// which models to try, in order. Images can only go to Gemini.
function candidates(hasImages, tier) {
  const pref = state().provider;
  const out = [];
  const uniq = arr => [...new Set(arr.filter(Boolean))];
  const gem = () => uniq([good[`${tier}:gemini`], GEM[tier], ...GEM.fallbacks]).map(m => ({ p: 'gemini', m }));
  const grq = () => uniq([good[`${tier}:groq`], ...groqModels()]).map(m => ({ p: 'groq', m }));
  const xai = () => uniq([good[`${tier}:xai`], ...xaiModels()]).map(m => ({ p: 'xai', m }));
  if (!hasImages) {
    if (pref === 'xai') { if (xaiKey()) out.push(...xai()); }
    else if (pref !== 'gemini') { if (groqKey()) out.push(...grq()); if (xaiKey()) out.push(...xai()); }
  }
  if (apiKey() && pref !== 'groq' && pref !== 'xai' || (hasImages && apiKey())) out.push(...gem());
  if (!out.length && !hasImages) { if (groqKey()) out.push(...grq()); if (xaiKey()) out.push(...xai()); }
  if (!out.length && apiKey()) out.push(...gem());
  return out;
}
const label = c => `${c.p}/${c.m}`;

// ask({ system, user, images:[{media_type,data}], model:'fast'|'smart', maxTokens, temperature, json })
// Returns the text, or null when AI is unavailable / the call failed (callers always have a non-AI fallback).
// The AI is used for exactly TWO things: smart auto-mod (use:'automod') and ticket summaries (use:'summary'). Anything else gets null.
async function ask({ system, user, images = [], model = 'fast', maxTokens = 400, temperature = 0, json = false, use = '' }) {
  if (use !== 'automod' && use !== 'summary') return null;
  if (!available()) return null;
  const a = state(); const t0 = Date.now();
  a.calls++; a.total.calls++;
  const tier = model === 'smart' ? 'smart' : 'fast';
  const deadline = Date.now() + (tier === 'smart' ? 60000 : 20000);       // never stall the bot longer than this
  const perTry = tier === 'smart' ? 30000 : 9000;
  const BUSY = [429, 500, 502, 503, 504];
  const o = { system: `${system}\nNever use emoji or emoticons in anything you write (the server shows its own icons).`, user, images, maxTokens, temperature, json, tier };

  const all = candidates(images.length > 0, tier);
  const live = all.filter(c => (cooldown.get(label(c)) || 0) < Date.now() && (cooldown.get(`${c.p}:*`) || 0) < Date.now());
  const rounds = [live.length ? live : all.slice(0, 2)];
  const tried = new Set();
  const errs = [];

  await acquire();
  try {
    for (let round = 0; round < 2; round++) {
      let list = rounds[0];
      if (round === 1) list = apiKey() && state().provider !== 'groq' ? (await discover()).map(m => ({ p: 'gemini', m })).filter(c => !tried.has(label(c)) && (cooldown.get(label(c)) || 0) < Date.now()) : [];
      for (const c of list) {
        const key = label(c);
        if (tried.has(key)) continue;
        tried.add(key);
        for (let attempt = 0; attempt < 2; attempt++) {
          const left = deadline - Date.now();
          if (left < 1200) { errs.push(`out of time [${key}]`); break; }
          let res;
          try { res = c.p !== 'gemini' ? await callGroq(c.m, o, Math.min(perTry, left), c.p) : await callGemini(c.m, o, Math.min(perTry, left)); }
          catch (e) { res = { ok: false, status: 0, msg: String(e.message || e), net: true }; }

          if (res.ok) {
            a.tokensIn += res.tin; a.tokensOut += res.tout; a.total.tokensIn += res.tin; a.total.tokensOut += res.tout;
            if (!res.text) {
              errs.push(`empty answer (${res.why}) [${key}]`);
              if (c.p !== 'gemini') { cool(key, 20e3); break; }          // try the next model
              a.errors++; a.lastError = `empty answer (${res.why}) [${key}]`; save();
              console.error('AI call returned nothing:', a.lastError);
              return null;
            }
            if (a.lastModel !== key) console.log(`AI: now using ${key}`);
            good[`${tier}:${c.p}`] = c.m; a.lastModel = key; a.lastError = ''; a.lastMs = Date.now() - t0; save();
            return res.text;
          }
          errs.push(`${res.status || 'net'} ${String(res.msg).slice(0, 90)} [${key}]`);
          // model does not accept our JSON / thinking setting: drop it and retry straight away
          if (res.status === 400 && c.p !== 'gemini' && json && /json|response_format/i.test(res.msg) && !NO_JSON.has(c.m)) { NO_JSON.add(c.m); attempt--; continue; }
          if (res.thinkBad) { NO_THINK.add(c.m); attempt--; continue; }
          // the key itself is wrong: this provider is useless until it is fixed
          if (res.status === 401 || (c.p === 'gemini' && /api key|API_KEY|permission denied|unauthenticated/i.test(res.msg) && res.status !== 404)) {
            errs.push(`check ${c.p === 'groq' ? 'GROQ_API_KEY' : c.p === 'xai' ? 'XAI_API_KEY' : 'GEMINI_API_KEY'}`); cooldown.set(`${c.p}:*`, Date.now() + 10 * 60e3); break;
          }
          if (res.status === 404 || res.status === 403 || res.code === 'model_decommissioned' || res.code === 'model_not_found') { cool(key, 30 * 60e3); break; }
          if (res.status === 429) {                                                                // free-tier limit: hop to the next model right now
            const perDay = /per day|TPD|RPD/i.test(res.msg);
            cool(key, perDay ? 30 * 60e3 : Math.min(120e3, Math.max(8e3, (res.retry || 20) * 1000))); break;
          }
          if (BUSY.includes(res.status) || res.net) {
            if (attempt === 0 && tier === 'smart') { await sleep(500); continue; }
            cool(key, 45e3); break;                                                                // busy / slow: next model
          }
          break;                                                                                  // other error: next model
        }
        if (deadline - Date.now() < 1200) break;
      }
      if (deadline - Date.now() < 1200) break;
    }
    a.errors++; a.lastError = errs.join(' | ').slice(0, 200); save();
    console.error('AI call failed:', errs.join(' | '));
    return null;
  } finally { release(); }
}

// Same as ask() but the model must answer with one JSON object. Returns the parsed object or null.
async function askJSON(opts) {
  const t = await ask({ ...opts, json: true, system: `${opts.system}\n\nReply with ONE JSON object and nothing else (no markdown fences, no commentary).` });
  if (!t) return null;
  const m = t.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Owner panel: time every model once (in parallel, ignores the cooldown list) so you can see which one is fastest right now.
async function speedTest() {
  const o = { system: 'Answer with the single word: pong', user: 'ping', images: [], maxTokens: 10, temperature: 0, json: false, tier: 'fast' };
  const list = [];
  if (groqKey()) for (const m of groqModels()) list.push({ p: 'groq', m });
  if (xaiKey()) for (const m of xaiModels()) list.push({ p: 'xai', m });
  if (apiKey()) for (const m of [...new Set([GEM.fast, ...GEM.fallbacks])]) list.push({ p: 'gemini', m });
  return Promise.all(list.map(async c => {
    const t0 = Date.now();
    try { const r = c.p !== 'gemini' ? await callGroq(c.m, o, 12000, c.p) : await callGemini(c.m, o, 12000); return { ...c, ms: Date.now() - t0, ok: r.ok && !!r.text, err: r.ok ? '' : `${r.status} ${String(r.msg).slice(0, 80)}` }; }
    catch (e) { return { ...c, ms: Date.now() - t0, ok: false, err: String(e.message).slice(0, 80) }; }
  }));
}
const resetCooldowns = () => { cooldown.clear(); found.at = 0; };
const keys = () => ({ groq: !!groqKey(), xai: !!xaiKey(), gemini: !!apiKey() });

module.exports = { ask, askJSON, fetchImage, available, why, hasKey, state, MODELS, speedTest, resetCooldowns, keys };
