const { EmbedBuilder } = require("discord.js");
const {
  speciesList, dragonSpecies, botSpecies,
  godSpecies, humanSpecies, reaperSpecies, archdemonSpecies,
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
    if (!interaction.replied && !interaction.deferred) return await interaction.reply(content);
    else return await interaction.followUp(content);
  } catch (e) { console.error("safeReply error:", e); }
}

// ==================== SPECIES LOOKUP ====================
function getSpeciesByName(name) {
  if (name === "God")       return godSpecies;
  if (name === "Human")     return humanSpecies;
  if (name === "Kitsune")   return botSpecies.kitsune;
  if (name === "Bot")       return botSpecies.bot;
  if (name === "Reaper")    return reaperSpecies;
  if (name === "Archdemon") return archdemonSpecies;
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
  for (const g of _state.bombGames.values())
    if (g.players?.has(id) && g.status === "playing") return true;
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
  const r = _state.activeRequests.get(id);
  if (!r) return false;
  if (Date.now() - r.timestamp > 60000) { _state.activeRequests.delete(id); return false; }
  return true;
}
function canSendRequest(sender, target, isGod = false) {
  if (isGod) return { allowed: true };
  if (hasActiveRequest(sender)) return { allowed:false, reason:"You already have a pending request!" };
  if (hasActiveRequest(target))  return { allowed:false, reason:"That user already has a pending request!" };
  const td = _state.userSpecies.get(target);
  if (td?.requestsEnabled === false) return { allowed:false, reason:"That user has disabled challenge requests!" };
  return { allowed: true };
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
    // FIX: update in-memory fightLeaderboard so /fights reflects wins immediately
    const lb = _state.fightLeaderboard.get(id) || { wins:0 };
    lb.wins = s.wins;
    _state.fightLeaderboard.set(id, lb);
    database.saveFightLeaderboard(id, { wins: s.wins });
  }
}

function updateBotStats(id, diff, won) {
  const s = _state.botStats.get(id) || { easy:{wins:0,losses:0}, medium:{wins:0,losses:0}, hard:{wins:0,losses:0}, impossible:{wins:0,losses:0} };
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

// ==================== ROLE ASSIGNMENT ====================
async function assignSpeciesRole(member, species) {
  if (!member || !species.roleName) return false;
  try {
    const guild = member.guild;
    let role = guild.roles.cache.find(r => r.name === species.roleName);
    if (!role) role = await guild.roles.create({ name:species.roleName, color:species.color, reason:`Species role for ${species.name}` });
    const allRoles = [
      "God","Demi-God","Demon-Lord","Demon-King","Demon","Oni","Orc-Lord","Kijin",
      "High-Orc","Ogre","Goblin","Orc","Angel","Chimera","Reaper","Cyborg",
      "Half-Blood","Mechangel","Archdemon","Dragon-Fire","Dragon-Thunder","Dragon-Ice","Dragon-Earth"
    ];
    for (const rn of allRoles) {
      const old = member.roles.cache.find(r => r.name === rn);
      if (old && old.name !== species.roleName) await member.roles.remove(old).catch(()=>{});
    }
    if (!member.roles.cache.has(role.id)) await member.roles.add(role);
    return true;
  } catch (e) { console.error("assignSpeciesRole error:", e); return false; }
}

module.exports = {
  setState,
  hpBar, createErrorEmbed, createSuccessEmbed, safeReply,
  getSpeciesByName, getRandomSpecies, getDragonSubtype,
  isPlayerInGame, isPlayerInFight, isPlayerInBotFight, canFight,
  hasActiveRequest, canSendRequest,
  updateLeaderboard, updateFightStats, updateBotStats,
  updateReaperQuest, initAwakeningData, updateCyborgProgress, isCyborgReadyForAwakening,
  assignSpeciesRole,
};
