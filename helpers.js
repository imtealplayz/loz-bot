const { EmbedBuilder } = require("discord.js");
const {
  speciesList, dragonSpecies, botSpecies,
  godSpecies, humanSpecies, reaperSpecies, archdemonSpecies, slimeLordSpecies,
  awakeningRequirements,
} = require("./constants.js");
const database = require("./database.js");

// ==================== SHARED STATE (imported from index via state.js) ====================
let _state = null;
function setState(s) { _state = s; }

// ==================== EMBED HELPERS ====================
function hpBar(current, max) {
  const pct = Math.max(0, Math.min(1, current / max));
  const filled = Math.round(pct * 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const color = pct > 0.5 ? "🟢" : pct > 0.25 ? "🟡" : "🔴";
  return `${color} ${bar} ${Math.max(0, current)}/${max}`;
}

function createErrorEmbed(msg) {
  return new EmbedBuilder().setColor(0xff0000).setDescription(`❌ ${msg}`);
}

function createSuccessEmbed(msg) {
  return new EmbedBuilder().setColor(0x00ff00).setDescription(`✅ ${msg}`);
}

async function safeReply(interaction, content) {
  try {
    if (!interaction?.isRepliable?.()) return null;
    if (interaction.deferred) return await interaction.editReply(content);
    if (interaction.replied) return await interaction.followUp(content);
    return await interaction.reply(content);
  } catch (e) {
    if (e.code !== 10062 && e.code !== 40060 && !e.message?.includes("Unknown interaction")) {
      console.error("safeReply error:", e);
    }
    return null;
  }
}

// ==================== SPECIES LOOKUP ====================
function getSpeciesByName(name) {
  if (name === "God")       return godSpecies;
  if (name === "Human")     return humanSpecies;
  if (name === "Kitsune")   return botSpecies.kitsune;
  if (name === "Bot")       return botSpecies.bot;
  if (name === "Reaper")    return reaperSpecies;
  if (name === "Archdemon") return archdemonSpecies;
  if (name === "Slime Lord") return slimeLordSpecies;
  const s = speciesList.find(x => x.name === name);
  if (s) return s;
  for (const t of dragonSpecies.types) {
    if (name === `${t.type} Dragon`) {
      return {
        number:17, name:`${t.type} Dragon`, emoji:`${t.emoji}🐉`,
        roleName:`Dragon-${t.type}`, color:t.color,
        hp:t.hp, atkMin:t.atkMin, atkMax:t.atkMax,
        healMin:t.healMin, healMax:t.healMax, ultCooldown:t.ultCooldown,
      };
    }
  }
  return null;
}

function getRandomSpecies() {
  if (Math.random() * 100 < 2) return { isDragon: true };
  const rollable = speciesList.filter(s => s.rarity && s.rarity > 0);
  const total = rollable.reduce((s, x) => s + x.rarity, 0);
  let r = Math.random() * total;
  for (const sp of rollable) { if (r < sp.rarity) return sp; r -= sp.rarity; }
  return speciesList.find(s => s.name === "Orc");
}

function getDragonSubtype() {
  const t = dragonSpecies.types[Math.floor(Math.random() * dragonSpecies.types.length)];
  return {
    number:17, name:`${t.type} Dragon`, emoji:`${t.emoji}🐉`,
    roleName:`Dragon-${t.type}`, color:t.color,
    hp:t.hp, atkMin:t.atkMin, atkMax:t.atkMax,
    healMin:t.healMin, healMax:t.healMax, ultCooldown:t.ultCooldown,
  };
}

// ==================== GAME STATE CHECKS ====================
function isPlayerInGame(id) {
  // Bomb tag removed — always returns false
  return false;
}
function isPlayerInFight(id) {
  for (const f of _state.activeFights.values())
    if (f.player1Id === id || f.player2Id === id) return true;
  return false;
}
function isPlayerInBotFight(id) { return _state.activeBotFights.has(id); }
function canFight(id) {
  const cd = _state.fightCooldowns.get(id);
  if (cd && cd > Date.now()) return false;
  return !isPlayerInFight(id) && !isPlayerInGame(id) && !isPlayerInBotFight(id);
}

function hasActiveRequest(id) {
  // Request locks are released only by decline, expiry, cancellation, or fight completion.
  // Do not expire them here: accepted challenges must remain locked for the full battle.
  return _state.activeRequests.has(id);
}
function canSendRequest(sender, target) {
  if (hasActiveRequest(sender)) return { allowed:false, reason:"You already have an incoming or outgoing fight request, or an active player battle." };
  if (hasActiveRequest(target)) return { allowed:false, reason:"That user already has an incoming or outgoing fight request, or an active player battle." };
  const td = _state.userSpecies.get(target);
  if (td?.requestsEnabled === false) return { allowed:false, reason:"That user has disabled challenge requests!" };
  return { allowed:true };
}

// ==================== STATS ====================
function updateLeaderboard(id, pts) {
  const s = _state.leaderboard.get(id) || { wins:0 };
  s.wins += pts;
  _state.leaderboard.set(id, s);
  database.saveLeaderboard(id, s);
}

function updateFightStats(id, won, oppId, data={}) {
  const s = _state.fightStats.get(id) || { wins:0, losses:0, streak:0, history:[] };
  if (won) { s.wins++; s.streak = (s.streak||0)+1; } else { s.losses++; s.streak=0; }
  s.history = [
    { opponentId:oppId, opponentName:data.opponentName||"Unknown", opponentSpecies:data.opponentSpecies, won, date:Date.now(), hpLeft:data.hpLeft||0, special:data.special||"" },
    ...(s.history||[])
  ].slice(0,20);
  _state.fightStats.set(id, s);
  database.saveFightStats(id, s);
  if (won) {
    const points = Number.isInteger(data.leaderboardPoints) && data.leaderboardPoints > 0
      ? data.leaderboardPoints
      : 1;
    const lb = _state.fightLeaderboard.get(id) || { wins:0 };
    lb.wins += points;
    _state.fightLeaderboard.set(id, lb);
    database.saveFightLeaderboard(id, { wins: lb.wins });
  }
}

function updateBotStats(id, diff, won) {
  const s = _state.botStats.get(id) || { easy:{wins:0,losses:0}, medium:{wins:0,losses:0}, hard:{wins:0,losses:0}, impossible:{wins:0,losses:0}, brutal:{wins:0,losses:0} };
  if (!s[diff]) s[diff] = { wins:0, losses:0 };
  if (won) { s[diff].wins++; updateReaperQuest(id, diff); } else s[diff].losses++;
  _state.botStats.set(id, s);
  database.saveBotStats(id, s);
}

// ==================== QUEST ====================
const REAPER_EXPIRY = 1774355400000; // 24 March 2026 6PM IST

function updateReaperQuest(id, type) {
  // Stop counting progress after quest deadline
  if (Date.now() >= REAPER_EXPIRY) return;
  const uq = _state.questProgress.get(id) || {};
  const q = uq.reaper || { easyBots:0, mediumBots:0, hardBots:0, impossibleBots:0, playerFights:0, completed:false, claimed:false };
  if (q.completed) return;
  if (type==="easy")            q.easyBots       = Math.min(q.easyBots+1,35);
  else if (type==="medium")     q.mediumBots     = Math.min(q.mediumBots+1,25);
  else if (type==="hard")       q.hardBots       = Math.min(q.hardBots+1,15);
  else if (type==="impossible") q.impossibleBots = Math.min(q.impossibleBots+1,5);
  else if (type==="player")     q.playerFights   = Math.min(q.playerFights+1,15);
  if (q.easyBots>=35 && q.mediumBots>=25 && q.hardBots>=15 && q.impossibleBots>=5 && q.playerFights>=15)
    q.completed = true;
  uq.reaper = q;
  _state.questProgress.set(id, uq);
  database.saveQuestProgress(id, "reaper", q);
}

// ==================== AWAKENING ====================
function initAwakeningData(ud) {
  if (!ud.awakening) ud.awakening = {};
  if (!ud.awakening.cyborg) ud.awakening.cyborg = { wins:0, damageDealt:0, ultUses:0, awakened:false };
  return ud.awakening.cyborg;
}

async function updateCyborgProgress(id, type, val=1) {
  const ud = _state.userSpecies.get(id);
  if (!ud || ud.species.name !== "Cyborg") return false;
  initAwakeningData(ud);
  const p = ud.awakening.cyborg;
  const req = awakeningRequirements.cyborg;
  if (type==="win")    p.wins        = Math.min(p.wins+val,        req.wins);
  if (type==="damage") p.damageDealt = Math.min(p.damageDealt+val, req.damageDealt);
  if (type==="ult")    p.ultUses     = Math.min(p.ultUses+val,     req.ultUses);
  _state.userSpecies.set(id, ud);
  await database.saveUserSpecies(id, ud);
  return true;
}

function isCyborgReadyForAwakening(ud) {
  if (!ud.awakening?.cyborg) return false;
  const p = ud.awakening.cyborg, req = awakeningRequirements.cyborg;
  return p.wins>=req.wins && p.damageDealt>=req.damageDealt && p.ultUses>=req.ultUses && !p.awakened;
}

function initDemonAwakeningData(ud) {
  if (!ud.awakening) ud.awakening = {};
  if (!ud.awakening.demon) ud.awakening.demon = { playerWins:0, demonBotWins:0, awakened:false };
  return ud.awakening.demon;
}

async function updateDemonAwakeningProgress(id, type, val=1) {
  const ud = _state.userSpecies.get(id);
  if (!ud || ud.species?.name !== "Demon") return false;
  const p = initDemonAwakeningData(ud);
  if (p.awakened) return false;
  const req = awakeningRequirements.demon;
  if (type === "playerWin") p.playerWins = Math.min((p.playerWins || 0) + val, req.playerWins);
  else if (type === "demonBotWin") p.demonBotWins = Math.min((p.demonBotWins || 0) + val, req.demonBotWins);
  else return false;
  _state.userSpecies.set(id, ud);
  await database.saveUserSpecies(id, ud);
  return true;
}

function isDemonReadyForAwakening(ud) {
  const p = ud?.awakening?.demon, req = awakeningRequirements.demon;
  return !!p && !p.awakened
    && (p.playerWins || 0) >= req.playerWins
    && (p.demonBotWins || 0) >= req.demonBotWins
    && (ud.rolls || 0) >= req.costRolls;
}

module.exports = {
  setState,
  hpBar, createErrorEmbed, createSuccessEmbed, safeReply,
  getSpeciesByName, getRandomSpecies, getDragonSubtype,
  isPlayerInGame, isPlayerInFight, isPlayerInBotFight, canFight,
  hasActiveRequest, canSendRequest,
  updateLeaderboard, updateFightStats, updateBotStats,
  updateReaperQuest, initAwakeningData, updateCyborgProgress, isCyborgReadyForAwakening,
  initDemonAwakeningData, updateDemonAwakeningProgress, isDemonReadyForAwakening,
};
