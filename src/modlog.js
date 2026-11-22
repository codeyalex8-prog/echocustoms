// Staff logs: every warn / kick / ban / timeout / note / jail / automod action becomes a numbered case
// and is posted to the staff logs channel (bans go to BAN_LOGS_CHANNEL_ID if set). Proof is shown in the log.
const { ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MediaGalleryBuilder, MediaGalleryItemBuilder,
  FileBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { db, save } = require('./db');

const ICON = { warn: '⚠️', kick: '👢', ban: '🔨', unban: '🔓', timeout: '⏳', untimeout: '✅', note: '📝', jail: '🚔', unjail: '🕊️', automod: '🤖', strike: '🚫' };
const TITLE = { warn: 'Warn', kick: 'Kick', ban: 'Ban', unban: 'Unban', timeout: 'Timeout', untimeout: 'Timeout removed', note: 'Staff note', jail: 'Jailed', unjail: 'Released', automod: 'Auto-moderation', strike: 'Strike' };
const IMG = /\.(png|jpe?g|gif|webp)(\?|$)/i;
const t = s => new TextDisplayBuilder().setContent(String(s).slice(0, 3900));

async function download(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length <= 24 * 1024 * 1024 ? buf : null;
  } catch { return null; }
}

// info: { action, modId (null = bot), user (User or {id, tag}), reason, proof: { att, link }, extra }
async function record(client, info) {
  const id = (db.counters.case = (db.counters.case || 0) + 1);
  const { action, modId, user, reason, extra } = info;
  const proof = info.proof || {};
  const kase = {
    id, action, modId: modId || null, userId: user.id, userTag: user.tag || user.username || String(user.id),
    reason: reason || 'No reason given', at: Date.now(), proofLink: proof.link || null, extra: extra || null,
  };

  // Re-upload the proof so it never expires with the original message.
  const files = [];
  let proofLine = '';
  let media = null;
  if (proof.att) {
    const buf = await download(proof.att.url);
    const ext = (proof.att.name || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const name = `proof-case-${id}.${ext}`;
    if (buf) {
      files.push(new AttachmentBuilder(buf, { name }));
      media = IMG.test(name) ? 'image' : 'file';
      kase.proofName = name;
      proofLine = media === 'image' ? '**Proof:** attached below' : `**Proof:** file \`${name}\` attached below`;
    } else {
      proofLine = `**Proof:** ${proof.att.url}`;
      kase.proofLink = kase.proofLink || proof.att.url;
    }
    var attName = name;
  }
  if (proof.link) proofLine += `${proofLine ? '\n' : ''}**Proof link:** ${proof.link}`;
  if (!proofLine) proofLine = '**Proof:** none';

  const c = new ContainerBuilder();
  const who = modId ? `<@${modId}>` : '**Auto-moderation**';
  c.addTextDisplayComponents(t(
    `## ${ICON[action] || '🛡️'} ${TITLE[action] || action} · Case #${id}\n` +
    `**User:** <@${user.id}> (\`${kase.userTag}\` · ${user.id})\n**Moderator:** ${who}\n**Reason:** ${kase.reason}` +
    (extra?.text ? `\n${extra.text}` : '') + `\n${proofLine}\n-# <t:${Math.floor(kase.at / 1000)}:F>`));
  if (media === 'image') c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${attName}`)));
  else if (media === 'file') c.addFileComponents(new FileBuilder().setURL(`attachment://${attName}`));

  const chId = (action === 'ban' || action === 'unban') ? cfg.logs.ban : action === 'automod' || action === 'strike' ? cfg.logs.automod : cfg.logs.staff;
  let sent = null;
  if (chId) {
    const ch = await client.channels.fetch(chId).catch(() => null);
    sent = await ch?.send({ components: [c], files, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } })
      .catch(e => { console.error('staff log failed:', e.message); return null; });
    if (sent) { kase.logUrl = sent.url; kase.proofUrl = sent.attachments.first()?.url || null; }
  }
  db.cases[id] = kase;
  const ids = Object.keys(db.cases); // keep the file small: last 2000 cases
  if (ids.length > 2000) delete db.cases[ids[0]];
  save();
  return kase;
}

const casesFor = userId => Object.values(db.cases).filter(c => c.userId === userId);

// Plain one-line log (purge, slowmode, lockdown...) to the staff logs channel.
async function line(client, text) {
  if (!cfg.logs.staff) return;
  const ch = await client.channels.fetch(cfg.logs.staff).catch(() => null);
  const c = new ContainerBuilder().addTextDisplayComponents(t(`🛡️ ${text}`));
  await ch?.send({ components: [c], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }).catch(() => {});
}

module.exports = { record, casesFor, line };
