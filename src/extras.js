// Small owner tools.
//  /emojis : shows which of your white server emojis the bot found, which are missing (and the names it looked for),
//            and every emoji name it can see, so a wrong name is easy to spot.
const { MessageFlags } = require('discord.js');
const cfg = require('./config');
const ui = require('./ui');
const EM = require('./emojis');
const { add, sc } = require('./commands');

const EPH = MessageFlags.Ephemeral;

add(sc('emojis').setDescription('Owner: check which white server emojis the bot found'), async i => {
  if (!cfg.isOwner(i.user.id)) return i.reply({ content: 'Owner only.', flags: EPH });
  await EM.resolve(i.client, cfg.guildId).catch(() => {});
  const r = EM.report();
  const missing = r.missing.map(k => `\`${k}\` (looks for: ${EM.names?.(k)?.join(', ') || k + 'icon'})`);
  const text = [
    '### Emoji check',
    `**Found (${r.found.length}):** ${r.found.map(x => `\`${x}\``).join(' ') || 'none'}`,
    `**Missing (${r.missing.length}):** ${missing.join(', ') || 'none'}`,
    `**Emoji names I can see:** ${r.seen.map(n => `\`${n}\``).join(' ').slice(0, 1200) || 'none'}`,
    '-# A missing icon simply shows nothing until an emoji with a matching name exists. Rename it in Server Settings > Emoji, or add the name in `src/emojis.js`.',
  ].join('\n');
  return i.reply(ui.eph(ui.note(text.slice(0, 3800))));
});
