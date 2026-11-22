// ============================================================================
//  /sticker message <text>   (-sticker message your text here)
//  Keeps a message at the very bottom of a channel. Every time people talk, the bot waits a couple of
//  seconds, deletes its old sticky and posts it again underneath.
//    /sticker message text:<text> [channel]   set / replace the sticky (use \n for a new line)
//    /sticker remove [channel]                remove it
//    /sticker list                            channels that have one
//  Who can use it: owner, staff role, or anyone with Manage Messages.
// ============================================================================
const { ChannelType, PermissionFlagsBits: P, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { db, save } = require('./db');
const ui = require('./ui');
const T = require('./tickets');
const { E, tag } = require('./emojis');
const { add, sc } = require('./commands');

const EPH = MessageFlags.Ephemeral;
const DELAY = 3000;         // wait this long after the last message before re-posting
const timers = new Map();   // channelId -> timeout
const posting = new Set();  // channelIds being re-posted right now

const render = s => ui.msg(ui.note(`${s.text}\n\n-# ${tag(E.megaphone)} Stickied message`));

async function repost(client, channelId) {
  const s = db.stickies[channelId];
  if (!s || posting.has(channelId)) return;
  posting.add(channelId);
  try {
    const ch = await client.channels.fetch(channelId).catch(e => { if (e.code === 10003) { delete db.stickies[channelId]; save(); } return null; });
    if (!ch) return;
    const old = s.messageId;
    s.postedAt = Date.now();                       // set BEFORE sending so our own message never re-triggers us
    const sent = await ch.send(render(s));
    s.messageId = sent.id; s.postedAt = Date.now(); save();
    if (old) ch.messages.delete(old).catch(() => {});
  } catch (e) {
    console.error('sticky', e.message);
  } finally { posting.delete(channelId); }
}

// called for every message
function onMessage(client, m) {
  if (!m.guild) return;
  const s = db.stickies[m.channelId];
  if (!s || m.id === s.messageId) return;
  if (m.author?.id === client.user.id && (posting.has(m.channelId) || Date.now() - (s.postedAt || 0) < 6000)) return;
  if (timers.has(m.channelId)) return;             // already queued: at most one re-post per DELAY
  timers.set(m.channelId, setTimeout(() => { timers.delete(m.channelId); repost(client, m.channelId); }, DELAY));
}

const canUse = i => cfg.isOwner(i.user.id) || T.isStaff(i.member) || i.memberPermissions?.has(P.ManageMessages);
const chanOpt = o => o.setName('channel').setDescription('Default: this channel').addChannelTypes(ChannelType.GuildText);

add(sc('sticker').setDescription('Keep a message stuck at the bottom of a channel')
  .addSubcommand(s => s.setName('message').setDescription('Set the sticky message for a channel')
    .addStringOption(o => o.setName('text').setDescription('The message (type \\n for a new line)').setRequired(true).setMaxLength(1800))
    .addChannelOption(chanOpt))
  .addSubcommand(s => s.setName('remove').setDescription('Remove the sticky message from a channel').addChannelOption(chanOpt))
  .addSubcommand(s => s.setName('list').setDescription('List the channels that have a sticky message')),
async i => {
  if (!canUse(i)) return i.reply({ content: "You don't have permission to do that.", flags: EPH });
  const sub = i.options.getSubcommand();

  if (sub === 'list') {
    const l = Object.entries(db.stickies).map(([id, s]) => `<#${id}>: ${s.text.replace(/\n/g, ' ').slice(0, 80)}`).join('\n');
    return i.reply({ content: l || 'No sticky messages yet.', flags: EPH, allowedMentions: { parse: [] } });
  }

  const ch = i.options.getChannel('channel') || i.channel;
  if (sub === 'remove') {
    const s = db.stickies[ch.id];
    if (!s) return i.reply({ content: `There is no sticky message in ${ch}.`, flags: EPH });
    delete db.stickies[ch.id]; save();
    clearTimeout(timers.get(ch.id)); timers.delete(ch.id);
    if (s.messageId) await ch.messages.delete(s.messageId).catch(() => {});
    return i.reply({ content: `Sticky message removed from ${ch}.`, flags: EPH });
  }

  const text = i.options.getString('text').replace(/\\n/g, '\n').trim();
  if (!text) return i.reply({ content: 'The message cannot be empty.', flags: EPH });
  const prev = db.stickies[ch.id];
  db.stickies[ch.id] = { text, messageId: prev?.messageId || null, by: i.user.id, at: Date.now(), postedAt: 0 };
  save();
  await repost(i.client, ch.id);                   // post it now and remove the old one
  await i.reply({ content: `Sticky message set in ${ch}. It will stay at the bottom.`, flags: EPH });
});

module.exports = { onMessage };
