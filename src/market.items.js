// ============================================================================
//  MARKETPLACE ITEMS: everything people can buy. Each one is a Roblox Game Pass.
//  After editing, restart the bot (the posted panel refreshes itself on start-up).
//
//    id          unique short name, no spaces
//    group       which dropdown category it lives in: 'ads' | 'roles' | 'times'
//    label       name shown to the buyer
//    description one line shown under the name
//    gamepassId  the Roblox Game Pass ID (the buy link is built from it)
//    price       OPTIONAL. If left out the bot reads the real price from Roblox itself
//    queue       true = this goes into the posting queue when claimed
//    tier        'instant' | 'priority' = jumps the queue (instant first, then priority)
//    grantRole   'vip' = the bot gives the VIP role automatically on purchase
// ============================================================================
module.exports = [
  // ----- Paid Ads -----
  { id: 'giveaway', group: 'ads', label: 'Sponsored Giveaway', description: 'Your giveaway with an @everyone ping.', gamepassId: '2063024059', queue: true },
  { id: 'here',     group: 'ads', label: '@here Ping Ad',      description: 'Your advertisement with an @here ping.', gamepassId: '2062376169', queue: true },
  { id: 'everyone', group: 'ads', label: '@everyone Ping Ad',  description: 'Your advertisement with an @everyone ping.', gamepassId: '2058958024', queue: true },
  { id: 'channel',  group: 'ads', label: 'Paid Channel',       description: 'Your own channel for 30 days, with an @everyone ping.', gamepassId: '2060882972', queue: true },

  // ----- Roles -----
  { id: 'vip',    group: 'roles', label: 'VIP',         description: 'The VIP role, given to you automatically.', gamepassId: '2057775900', grantRole: 'vip' },
  { id: 'custom', group: 'roles', label: 'Custom Role', description: 'A role with your own name and colour.', gamepassId: '2060769217' },

  // ----- Post Times -----
  { id: 'priority', group: 'times', label: 'Priority Post', description: 'Your post goes ahead of normal posts in the queue.', gamepassId: '2061758505', queue: true, tier: 'priority' },
  { id: 'instant',  group: 'times', label: 'Instant Post',  description: 'Your post goes out first, straight away.', gamepassId: '2062100650', queue: true, tier: 'instant' },
];
