// Banners are local files (/assets/top.png, /assets/bottom.png). This adds them as attachments
// to any outgoing message whose components reference attachment://top.png or bottom.png.
const D = require('discord.js');
const path = require('path');
const dir = path.join(__dirname, '..', 'assets');
const NAMES = ['top.png', 'bottom.png'];

function inject(p) {
  if (!p || typeof p !== 'object' || !p.components) return p;
  let s; try { s = JSON.stringify(p.components); } catch { return p; }
  const files = [...(p.files || [])];
  for (const n of NAMES) {
    if (s.includes(`attachment://${n}`) && !files.some(f => f?.name === n))
      files.push(new D.AttachmentBuilder(path.join(dir, n), { name: n }));
  }
  return files.length === (p.files || []).length ? p : { ...p, files };
}
const wrap = (cls, m) => {
  const orig = cls?.prototype?.[m];
  if (!orig) return;
  cls.prototype[m] = function (p, ...r) { return orig.call(this, inject(p), ...r); };
};
for (const c of [D.TextChannel, D.NewsChannel, D.ThreadChannel, D.VoiceChannel, D.User]) wrap(c, 'send');
for (const c of [D.CommandInteraction, D.MessageComponentInteraction, D.ModalSubmitInteraction])
  for (const m of ['reply', 'followUp', 'editReply']) wrap(c, m);
