const { Collection } = require("discord.js");

// ==================== SHARED STATE ====================
// All maps and collections live here and are passed to every module
// so every file shares the exact same object references

const activeNukes     = new Map();
const reversedUsers   = new Map();
const bombGames       = new Map();
const cooldowns       = new Collection();
const challenges      = new Map();
const leaderboard     = new Collection();
const fightLeaderboard= new Collection();
const fightStats      = new Collection();
const duelCooldowns   = new Collection();
const userSpecies     = new Collection();
const botStats        = new Collection();
const activeRolls     = new Map();
const activeFights    = new Map();
const fightChallenges = new Map();
const fightCooldowns  = new Collection();
const dailyClaims     = new Collection();
const activeBotFights = new Map();
const fightMessages   = new Map();
const questProgress   = new Collection();
const activeRequests  = new Map();
const duelChannels    = new Collection();

module.exports = {
  activeNukes, reversedUsers, bombGames, cooldowns, challenges,
  leaderboard, fightLeaderboard, fightStats, duelCooldowns,
  userSpecies, botStats, activeRolls, activeFights, fightChallenges,
  fightCooldowns, dailyClaims, activeBotFights, fightMessages,
  questProgress, activeRequests, duelChannels,
};
