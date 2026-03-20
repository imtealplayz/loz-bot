const { Collection } = require("discord.js");

// ==================== SHARED STATE ====================
const cooldowns       = new Collection();
const leaderboard     = new Collection();
const fightLeaderboard= new Collection();
const fightStats      = new Collection();
const userSpecies     = new Collection();
const botStats        = new Collection();
const activeFights    = new Map();
const fightChallenges = new Map();
const fightCooldowns  = new Collection();
const dailyClaims     = new Collection();
const activeBotFights = new Map();
const fightMessages   = new Map();
const questProgress   = new Collection();
const activeRequests  = new Map();

module.exports = {
  cooldowns, leaderboard, fightLeaderboard, fightStats,
  userSpecies, botStats, activeFights, fightChallenges,
  fightCooldowns, dailyClaims, activeBotFights, fightMessages,
  questProgress, activeRequests,
};
