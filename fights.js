const { botPersonalities, humanSpecies, slimeLordSpecies } = require("./constants.js");
const database = require("./database.js");
const {
  updateFightStats, updateBotStats,
  updateReaperQuest, updateCyborgProgress, updateDemonAwakeningProgress,
} = require("./helpers.js");
const {
  makeCombatant, calculateDamage, applyUltEffect,
  tickCooldowns, applyOgreRegen, processCurseTick,
  buildFightMessagePayload, buildBotFightMessagePayload, buildFightResultPayload, formatFightHealth,
} = require("./combat.js");

let _state = null;
function setState(s) { _state = s; }

const BOT_TURN_WATCHDOG_MS = 20000;
const BOT_TURN_STATE_FIELDS = [
  "playerHp", "botHp", "playerPossession", "botPossession",
  "playerStunnedTurns", "botStunnedTurns",
  "playerBurn", "playerBurnRounds", "botBurn", "botBurnRounds",
  "playerBlockHeal", "botBlockHeal", "playerCurse", "botCurse",
  "playerUltBuff", "botUltBuff", "botAdaptiveStacks", "botAttackCounter",
  "botLastUltUsed", "botHealCooldown", "botUltCooldown", "playerUltCooldown",
  "playerAdaptiveStacks", "playerSlimeMissStacks", "botSlimeMissStacks", "round", "log",
];

function cloneTurnValue(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function snapshotBotTurn(fight) {
  const snapshot = {};
  for (const key of BOT_TURN_STATE_FIELDS) snapshot[key] = cloneTurnValue(fight[key]);
  return snapshot;
}

function restoreBotTurn(fight, snapshot) {
  for (const key of BOT_TURN_STATE_FIELDS) fight[key] = cloneTurnValue(snapshot[key]);
}

function isCurrentBotTurn(fightId, fight, turnToken) {
  return _state.activeBotFights.get(fightId) === fight && fight.botTurnToken === turnToken;
}

async function updateBotFightMessage(channel, fightId, fight, phase) {
  const payload = buildBotFightMessagePayload(fight, fight.log || [], phase, phase === "bot_thinking" ? "bot_thinking" : "playing");
  const current = _state.fightMessages.get(fightId);
  if (current) {
    try {
      await current.edit({ content: null, embeds: null, ...payload });
      return true;
    } catch (error) {
      console.error(`[Bot fight ${fightId}] Failed to edit fight message during ${phase}:`, error?.stack || error);
    }
  }
  try {
    const replacement = await channel.send(payload);
    _state.fightMessages.set(fightId, replacement);
    return true;
  } catch (error) {
    console.error(`[Bot fight ${fightId}] Failed to send replacement message during ${phase}:`, error?.stack || error);
    return false;
  }
}

async function recoverBotTurn(channel, fightId, fight, turnToken, snapshot, error) {
  if (_state.activeBotFights.get(fightId) !== fight || fight.botTurnToken !== turnToken) return;
  console.error(`[Bot fight ${fightId}] Bot turn failed; restoring state and returning the turn to the player:`, error?.stack || error);

  if (fight.timeout) clearTimeout(fight.timeout);
  fight.timeout = null;
  restoreBotTurn(fight, snapshot);
  fight.botTurnToken = turnToken + 1;
  fight.botTurnRunning = false;
  fight.log = [
    ...(Array.isArray(fight.log) ? fight.log.slice(-2) : []),
    "The bot turn could not finish. Its action was skipped. Take your turn.",
  ].slice(-3);

  await updateBotFightMessage(channel, fightId, fight, "playing");
  if (_state.activeBotFights.get(fightId) !== fight || fight.botTurnToken !== turnToken + 1) return;
  fight.timeout = setTimeout(() => {
    if (_state.activeBotFights.get(fightId) === fight) {
      endBotFight(channel, fightId, "bot", "player", fight.difficulty, "timeout")
        .catch(error => console.error(`[Bot fight ${fightId}] Player timeout resolution failed:`, error?.stack || error));
    }
  }, 60000);
}

async function doBotTurn(channel, fightId) {
  const fight = _state.activeBotFights.get(fightId);
  if (!fight || fight.botTurnRunning) return;

  if (fight.timeout) clearTimeout(fight.timeout);
  fight.timeout = null;
  const turnToken = (Number(fight.botTurnToken) || 0) + 1;
  fight.botTurnToken = turnToken;
  fight.botTurnRunning = true;
  const snapshot = snapshotBotTurn(fight);
  const watchdog = setTimeout(() => {
    recoverBotTurn(
      channel, fightId, fight, turnToken, snapshot,
      new Error(`Bot turn exceeded ${BOT_TURN_WATCHDOG_MS}ms watchdog`)
    ).catch(error => console.error(`[Bot fight ${fightId}] Watchdog recovery failed:`, error?.stack || error));
  }, BOT_TURN_WATCHDOG_MS);

  try {
    await runBotTurn(channel, fightId, turnToken);
  } catch (error) {
    await recoverBotTurn(channel, fightId, fight, turnToken, snapshot, error);
  } finally {
    clearTimeout(watchdog);
    if (fight.botTurnToken === turnToken) fight.botTurnRunning = false;
  }
}

// ==================== START PVP FIGHT ====================
async function startFight(channel, player1Id, player2Id) {
  const p1d = _state.userSpecies.get(player1Id);
  const p2d = _state.userSpecies.get(player2Id);
  const player1 = makeCombatant(player1Id, p1d.species);
  const player2 = makeCombatant(player2Id, p2d.species);
  const member1 = channel.guild?.members?.cache?.get(player1Id);
  const member2 = channel.guild?.members?.cache?.get(player2Id);
  player1.displayName = member1?.displayName || member1?.user?.username || "Player 1";
  player2.displayName = member2?.displayName || member2?.user?.username || "Player 2";
  const firstTurn = Math.random()<0.5?player1Id:player2Id;
  const fightId = `${player1Id}-${player2Id}-${Date.now()}`;
  const fight = { fightId, player1Id, player2Id, player1, player2, currentTurn:firstTurn, round:1, lastActionTime:Date.now(), timeout:null };
  const msg = await channel.send(buildFightMessagePayload(fight, ["Fight started."], "playing"));
  _state.fightMessages.set(fightId, msg);
  _state.activeFights.set(fightId, fight);
  fight.timeout = setTimeout(()=>{
    if (_state.activeFights.has(fightId)) {
      const loser=fight.currentTurn, winner=fight.player1Id===loser?fight.player2Id:fight.player1Id;
      endFight(channel,fightId,winner,loser,"timeout");
    }
  },120000);
}

// ==================== END PVP FIGHT ====================
async function endFight(channel, fightId, winnerId, loserId, reason="normal") {
  const fight = _state.activeFights.get(fightId);
  if (!fight) return;
  if (fight.timeout) clearTimeout(fight.timeout);
  const winner=fight.player1Id===winnerId?fight.player1:fight.player2;
  const loser =fight.player1Id===loserId ?fight.player1:fight.player2;
  if (winner.species.name==="Cyborg") await updateCyborgProgress(winnerId,"win");
  let winPoints=1, rollEarned=false, doubleWin=false;
  if (reason!=="disintegration"&&reason!=="judge") {
    if (Math.random()<0.05) { winPoints=2; doubleWin=true; }
    if (Math.random()<0.3)  { rollEarned=true; const ud=_state.userSpecies.get(winnerId); if(ud){ ud.rolls=(ud.rolls||0)+1; _state.userSpecies.set(winnerId,ud); database.saveUserSpecies(winnerId,ud); } }
  }
  // FIX: only update fightLeaderboard via updateFightStats, not bomb tag leaderboard
  updateFightStats(winnerId,true,loserId,{opponentName:loser.species.name,opponentSpecies:loser.species,hpLeft:winner.currentHp,special:reason==="forfeit"?"😵 forfeit":reason==="counter"?"💥 counter":"",doubleWin,rollEarned,leaderboardPoints:winPoints});
  updateFightStats(loserId,false,winnerId,{opponentName:winner.species.name,opponentSpecies:winner.species,hpLeft:loser.currentHp,special:reason==="forfeit"?"😵 forfeited":"",doubleWin:false,rollEarned:false});
  updateReaperQuest(winnerId,"player");
  if (reason!=="disintegration" && reason!=="judge" && winner.species.name==="Demon")
    await updateDemonAwakeningProgress(winnerId,"playerWin");
  _state.fightCooldowns.set(winnerId,Date.now()+30000);
  _state.fightCooldowns.set(loserId,Date.now()+30000);
  let desc = "**" + winner.species.name + "**: " + formatFightHealth(Math.max(0, winner.currentHp), winner.maxHp) + "\n";
  desc += "**" + loser.species.name + "**: " + formatFightHealth(0, loser.maxHp) + "\n\n";
  if (reason === "timeout") desc += "Opponent timed out.\n";
  if (reason === "forfeit") desc += "Opponent forfeited.\n";
  if (reason === "counter") desc += "Opponent was defeated by a counter-strike.\n";
  desc += "⚔️ Leaderboard: +" + winPoints + "\n";
  if (rollEarned) desc += "<:reroll_dice:1558042108965822515> Species Rolls: +1\n";
  const resultPayload = buildFightResultPayload("<@" + winnerId + "> wins the fight", desc, 0x2ecc71, []);
  const msg = _state.fightMessages.get(fightId);
  if (msg) await msg.edit({ content: null, embeds: null, ...resultPayload }).catch(() => {});
  _state.activeFights.delete(fightId);
  _state.activeRequests.delete(fight.player1Id);
  _state.activeRequests.delete(fight.player2Id);
  _state.fightMessages.delete(fightId);
}

// ==================== BOT AI TURN ====================
async function runBotTurn(channel, fightId, turnToken) {
  const fight = _state.activeBotFights.get(fightId);
  if (!fight || fight.botTurnToken !== turnToken) return;
  const personality = botPersonalities[fight.difficulty];
  if (!personality) throw new Error(`Unknown bot difficulty: ${fight.difficulty}`);
  await updateBotFightMessage(channel, fightId, fight, "bot_thinking");
  if (!isCurrentBotTurn(fightId, fight, turnToken)) return;
  await new Promise(r=>setTimeout(r,personality.reactionDelay));
  if (!isCurrentBotTurn(fightId, fight, turnToken)) return;
  const log = fight.log || [];
  const botC = {
    id:"BOT", species:fight.botSpecies, currentHp:fight.botHp, maxHp:fight.botMaxHp,
    ultBuff:fight.botUltBuff, adaptiveStacks:fight.botAdaptiveStacks||0, attackCounter:fight.botAttackCounter||0, slimeMissStacks:fight.botSlimeMissStacks||0,
    burn:fight.botBurn||0, burnRounds:fight.botBurnRounds||0, curse:fight.botCurse||0,
    blockHeal:fight.botBlockHeal||false, possession:fight.botPossession||false, stunnedTurns:fight.botStunnedTurns||0,
    healCooldown:fight.botHealCooldown, ultCooldown:fight.botUltCooldown, lastUltUsed:fight.botLastUltUsed,
  };
  const playerC = {
    id:fight.playerId, species:fight.playerSpecies, currentHp:fight.playerHp, maxHp:fight.playerMaxHp,
    ultBuff:fight.playerUltBuff, adaptiveStacks:fight.playerAdaptiveStacks||0, attackCounter:fight.playerAttackCounter||0, slimeMissStacks:fight.playerSlimeMissStacks||0,
    burn:fight.playerBurn||0, burnRounds:fight.playerBurnRounds||0, curse:fight.playerCurse||0,
    blockHeal:fight.playerBlockHeal||false, possession:fight.playerPossession||false, stunnedTurns:fight.playerStunnedTurns||0,
    healCooldown:fight.playerHealCooldown, ultCooldown:fight.playerUltCooldown, lastUltUsed:fight.playerLastUltUsed,
  };

  if (botC.possession) {
    botC.possession=false;
    const selfHit=Math.floor(Math.random()*(botC.species.atkMax-botC.species.atkMin+1))+botC.species.atkMin;
    botC.currentHp=Math.max(0,botC.currentHp-selfHit);
    log.push(`🎭 **POSSESSION!** ${botC.species.name} attacks itself for ${selfHit}!`);
  } else {
    let botAction="attack";
    const botHpRatio=botC.currentHp/botC.maxHp;
    const playerHpRatio=playerC.currentHp/playerC.maxHp;
    const healAvailable=fight.botHealCooldown===0&&botC.currentHp<botC.maxHp*personality.healThreshold;
    const ultReady=fight.botUltCooldown===0&&!botC.ultBuff;

    if (fight.difficulty==="brutal") {
      const speciesName=botC.species.name;
      const hasQueuedAttackUlt=botC.ultBuff&&["nextAttack","reaperKill","buff","thunderActive"].includes(botC.ultBuff.type);
      const useStrategicUlt=ultReady&&(
        (speciesName==="Reaper"&&(playerHpRatio<=0.35||botHpRatio<=0.5))||
        (speciesName==="Mechangel"&&botHpRatio<=0.68)||
        (speciesName==="Archdemon"&&playerHpRatio>0.15)
      );
      if (hasQueuedAttackUlt) botAction="attack";
      else if (useStrategicUlt) botAction="ult";
      else if (healAvailable) botAction="heal";
      else botAction="attack";
    } else if (healAvailable) botAction="heal";
    else if (fight.botUltCooldown===0&&Math.random()<personality.ultChance) botAction="ult";

    if (botAction==="heal") {
      if (botC.blockHeal) { botC.blockHeal=false; log.push("👑 **ROYAL COMMAND!** Bot cannot heal!"); botAction="attack"; }
      else if (botC.currentHp>=botC.maxHp*0.8) { log.push("❌ Bot HP above 80% — too healthy!"); botAction="attack"; }
      else {
        let rawH=Math.floor(Math.random()*(botC.species.healMax-botC.species.healMin+1))+botC.species.healMin;
        // <15% desperation rule for bots too
        if (botC.currentHp<botC.maxHp*0.15) {
          if (Math.random()<0.75) { rawH=Math.floor(rawH*0.5); log.push("💔 Bot's desperate heal only 50%!"); }
          else { rawH=Math.floor(rawH*1.3); log.push("✨ Bot's miracle heal +30%!"); }
        }
        // FIX: update botC.currentHp then sync to fight.botHp
        botC.currentHp=Math.min(botC.maxHp,botC.currentHp+rawH);
        fight.botHp=botC.currentHp; fight.botHealCooldown=3;
        log.push(`💚 Bot heals for ${rawH} HP! (${fight.botHp}/${fight.botMaxHp})`);
      }
    }
    if (botAction==="ult") {
      // Chimera bot copies player's species ULT directly
      if (botC.species.name==="Chimera") {
        const savedSpecies=botC.species;
        botC.species=playerC.species;
        const copied=applyUltEffect(botC,playerC);
        botC.species=savedSpecies;
        // Chimera keeps its own cooldown (15)
        fight.botUltCooldown=15;
        fight.botUltBuff=botC.ultBuff;
        fight.botLastUltUsed=botC.lastUltUsed;
        log.push(`🎭 Bot Chimera copies **${playerC.species.name}**'s ULT!\n${copied.message}`);
        if (["God","Mechangel","Cyborg"].includes(playerC.species.name)) { fight.botHp=botC.currentHp; fight.playerHp=playerC.currentHp; }
        if (playerC.species.name==="Ogre") playerC.stunnedTurns=1;
      } else {
        const {message:um,requiresChoice}=applyUltEffect(botC,playerC);
        if (requiresChoice) {
          if (botC.species.name==="Angel") {
            if (botC.currentHp<botC.maxHp*0.4) { const h=Math.floor(playerC.currentHp*0.6); botC.currentHp=Math.min(botC.maxHp,botC.currentHp+h); fight.botHp=botC.currentHp; log.push(`👼 Bot PRAYER — heals ${h} HP!`); }
            else { botC.ultBuff={type:"nextAttack",multiplier:1.5,angelHeal:true}; log.push("👼 Bot SMITE — 1.5×!"); }
          } else if (botC.species.name==="Ice Dragon") { botC.ultBuff={type:"nextAttack",multiplier:1.9}; log.push("❄️ Bot GLACIAL SPIKE — 1.9×!"); }
          else if (botC.species.name==="Earth Dragon") { botC.ultBuff={type:"nextAttack",multiplier:1.2}; log.push("🌍 Bot TERRA STRIKE — 1.2×!"); }
        } else {
          log.push(`✨ Bot uses ULT! ${um}`);
          if (["God","Mechangel","Cyborg"].includes(botC.species.name)) { fight.botHp=botC.currentHp; fight.playerHp=playerC.currentHp; }
          if (botC.species.name==="Ogre") playerC.stunnedTurns=1;
        }
        fight.botUltCooldown=botC.species.ultCooldown; fight.botUltBuff=botC.ultBuff; fight.botLastUltUsed=botC.lastUltUsed;
      }
    }
    if (botAction==="attack") {
      const result=calculateDamage(botC,playerC);
      // Apply counter-strike damage to bot (attackerMutations.hpDelta is negative on counter)
      botC.currentHp=Math.max(0,Math.min(botC.maxHp,botC.currentHp+result.attackerMutations.hpDelta));
      if (result.missedAttack) {
        // Bot missed — show miss message clearly
        log.push(result.specialLines.length ? result.specialLines.join(" ") : "💨 **Bot MISSED!**");
        if (playerC.species.name==="God") { const gh=Math.floor(playerC.currentHp*0.2); playerC.currentHp=Math.min(playerC.maxHp,playerC.currentHp+gh); log.push(`👑 **DIVINE RETRIBUTION!** God heals ${gh}!`); }
        // Check if counter-strike killed the bot
        if (botC.currentHp<=0) {
          fight.botHp=0; fight.playerHp=playerC.currentHp; fight.log=log.slice(-3);
          await endBotFight(channel,fightId,"player","bot",fight.difficulty,"counter");
          return;
        }
      } else if (result.instantKill) {
        playerC.currentHp=0;
        log.push(`⚔️ ${result.specialLines.join(" ")}  Your HP: 0/${fight.playerMaxHp}`);
      } else {
        playerC.currentHp=Math.max(0,playerC.currentHp-result.damage);
        if (playerC.species.name==="Chimera"&&result.damage>0) fight.playerAdaptiveStacks=Math.min(3,(fight.playerAdaptiveStacks||0)+1);
        if (playerC.species.name==="God"&&result.missedAttack) { const gh=Math.floor(playerC.currentHp*0.2); playerC.currentHp=Math.min(playerC.maxHp,playerC.currentHp+gh); log.push(`👑 **DIVINE RETRIBUTION!** God heals ${gh}!`); }
        log.push(`⚔️ Bot deals **${result.damage}** damage!${result.specialLines.length?` (${result.specialLines.slice(0,2).join(", ")})`:""}  Your HP: ${Math.max(0,playerC.currentHp)}/${fight.playerMaxHp}`);
      }
      fight.botHp=Math.max(0,botC.currentHp); fight.playerHp=Math.max(0,playerC.currentHp);
      fight.botUltBuff=botC.ultBuff; fight.botAdaptiveStacks=botC.adaptiveStacks; fight.botAttackCounter=botC.attackCounter;
    }
  }

  // Sync
  fight.botHp=Math.max(0,botC.currentHp); fight.playerHp=Math.max(0,playerC.currentHp);
  fight.playerBurn=playerC.burn; fight.playerBurnRounds=playerC.burnRounds;
  fight.botBurn=botC.burn; fight.botBurnRounds=botC.burnRounds;
  fight.playerBlockHeal=playerC.blockHeal; fight.playerCurse=playerC.curse;
  fight.playerPossession=playerC.possession; fight.playerStunnedTurns=playerC.stunnedTurns||0;
  fight.botPossession=botC.possession||false; fight.botCurse=botC.curse;
  fight.playerUltBuff=playerC.ultBuff;
  fight.playerSlimeMissStacks=playerC.slimeMissStacks||0;
  fight.botSlimeMissStacks=botC.slimeMissStacks||0;

  // Burn tick on player
  if (fight.playerBurn>0) {
    const bd=fight.playerBurn; fight.playerHp=Math.max(0,fight.playerHp-bd);
    fight.playerBurnRounds--; if(fight.playerBurnRounds<=0){fight.playerBurn=0;fight.playerBurnRounds=0;}
    log.push(`🔥 Burn deals ${bd} to you!`);
  }
  // Ogre regen for bot
  if (fight.botSpecies.name==="Ogre") { fight.botHp=Math.min(fight.botMaxHp,fight.botHp+5); log.push("👹 Bot Regeneration +5"); }

  // Bot's turn: tick bot's full cooldowns + player's ULT only
  fight.botHealCooldown=Math.max(0,(fight.botHealCooldown||0)-1);
  fight.botUltCooldown=Math.max(0,(fight.botUltCooldown||0)-1);
  // Player ULT also ticks on bot's turn (every round rule)
  fight.playerUltCooldown=Math.max(0,(fight.playerUltCooldown||0)-1);
  // Player heal cooldown does NOT tick on bot's turn (only ticks when player acts)
  fight.round++; fight.log=log.slice(-3);

  if (fight.playerHp<=0) { await endBotFight(channel,fightId,"bot","player",fight.difficulty); return; }
  if (fight.botHp<=0)    { await endBotFight(channel,fightId,"player","bot",fight.difficulty); return; }

  if (!isCurrentBotTurn(fightId, fight, turnToken)) return;
  await updateBotFightMessage(channel, fightId, fight, "playing");
  if (!isCurrentBotTurn(fightId, fight, turnToken)) return;
  fight.timeout=setTimeout(()=>{
    if (_state.activeBotFights.get(fightId) === fight) {
      // The player owns this turn. Inactivity awards the bot, not the player.
      endBotFight(channel,fightId,"bot","player",fight.difficulty,"timeout")
        .catch(error => console.error(`[Bot fight ${fightId}] Player timeout resolution failed:`, error?.stack || error));
    }
  },60000);
}


const SLIME_LORD_BOSS_STATS = {
  easy:       { hp:120, atkMin:14, atkMax:20, healMin:10, healMax:16, ultCooldown:10 },
  medium:     { hp:140, atkMin:16, atkMax:23, healMin:12, healMax:18, ultCooldown:9 },
  hard:       { hp:160, atkMin:19, atkMax:27, healMin:14, healMax:21, ultCooldown:8 },
  impossible: { hp:185, atkMin:22, atkMax:31, healMin:16, healMax:24, ultCooldown:8 },
  brutal:     { hp:210, atkMin:25, atkMax:35, healMin:18, healMax:26, ultCooldown:7 },
};

async function startSlimeLordBoss(channel, previousFight) {
  const playerId=previousFight.playerId;
  if (_state.activeBotFights.has(playerId)) return;
  const difficulty=previousFight.difficulty;
  const bossStats=SLIME_LORD_BOSS_STATS[difficulty] || SLIME_LORD_BOSS_STATS.easy;
  const bossSpecies={ ...slimeLordSpecies, ...bossStats };
  const playerSpecies=previousFight.playerSpecies || _state.userSpecies.get(playerId)?.species || humanSpecies;
  const playerMaxHp=playerSpecies.hp || humanSpecies.hp;
  const fightId="slime-boss-" + playerId + "-" + Date.now();
  const fight={
    fightId, playerId, playerSpecies, playerHp:playerMaxHp, playerMaxHp,
    playerHealCooldown:0, playerUltCooldown:0, playerUltBuff:null,
    playerAdaptiveStacks:0, playerAttackCounter:0, playerSlimeMissStacks:0,
    playerBurn:0, playerBurnRounds:0, playerCurse:0, playerCurseRounds:0,
    playerBlockHeal:false, playerPossession:false, playerStunnedTurns:0, playerLastUltUsed:null,
    botSpecies:bossSpecies, botHp:bossSpecies.hp, botMaxHp:bossSpecies.hp,
    botHealCooldown:0, botUltCooldown:0, botUltBuff:null, botAdaptiveStacks:0, botAttackCounter:0, botSlimeMissStacks:0,
    botBurn:0, botBurnRounds:0, botCurse:0, botCurseRounds:0, botPossession:false, botBlockHeal:false, botStunnedTurns:0, botLastUltUsed:null,
    round:1, difficulty, botPersonality:botPersonalities[difficulty], timeout:null, log:[
      "A rare Slime Lord has emerged after your " + difficulty.toUpperCase() + " victory.",
      "Your HP is fully restored and all temporary combat effects are reset for this fresh battle.",
    ],
    playerName:previousFight.playerName || "You", isSlimeBoss:true, bossDifficulty:difficulty,
  };
  // Reserve the player slot before awaiting Discord so another fight cannot start concurrently.
  _state.activeBotFights.set(fightId,fight);
  _state.activeBotFights.set(playerId,fightId);
  try {
    const msg=await channel.send(buildBotFightMessagePayload(fight,fight.log,"playing"));
    _state.fightMessages.set(fightId,msg);
    fight.timeout=setTimeout(()=>{
      if (_state.activeBotFights.get(fightId)===fight) {
        endBotFight(channel,fightId,"bot","player",difficulty,"timeout")
          .catch(error=>console.error("[Slime Lord boss] Initial timeout resolution failed:",error?.stack||error));
      }
    },120000);
  } catch(error) {
    if (_state.activeBotFights.get(fightId)===fight) _state.activeBotFights.delete(fightId);
    if (_state.activeBotFights.get(playerId)===fightId) _state.activeBotFights.delete(playerId);
    console.error("[Slime Lord boss] Failed to start boss encounter:",error?.stack||error);
  }
}

async function finishSlimeLordBoss(channel, fight, winner, reason) {
  const won=winner==="player";
  let unlocked=false, alreadyUnlocked=false, saveFailed=false, unlockMissed=false;
  if (won && reason!=="timeout") {
    const current=_state.userSpecies.get(fight.playerId) || {
      species:humanSpecies, originalSpecies:humanSpecies, questSpecies:{}, rolls:0,
      requestsEnabled:true, lastSwitch:0, awakening:{}, badges:[],
    };
    alreadyUnlocked=current.questSpecies?.slimeLord?.unlocked===true;
    if (!alreadyUnlocked && Math.random()<0.092) {
      const updated={
        ...current,
        questSpecies:{
          ...(current.questSpecies||{}),
          slimeLord:{ ...(current.questSpecies?.slimeLord||{}), unlocked:true, equipped:false, source:"boss" },
        },
      };
      const saved=await database.saveUserSpecies(fight.playerId,updated);
      if (saved) {
        _state.userSpecies.set(fight.playerId,updated);
        unlocked=true;
      } else saveFailed=true;
    } else if (!alreadyUnlocked) unlockMissed=true;
  }

  const playerMention="<@" + fight.playerId + ">";
  const header=won ? playerMention + " defeated the Slime Lord boss!" : playerMention + " was defeated by the Slime Lord boss.";
  let desc="**Difficulty:** " + String(fight.difficulty).toUpperCase() + "\n";
  desc+="**Your HP:** " + formatFightHealth(won?fight.playerHp:0,fight.playerMaxHp) + "\n";
  desc+="**Boss HP:** " + formatFightHealth(won?0:fight.botHp,fight.botMaxHp) + "\n\n";
  if (reason==="timeout" && won) desc+="The encounter ended on a technical timeout, so no species-unlock roll was granted.\n";
  else if (unlocked) desc+="🫧 **Slime Lord permanently unlocked!** Use /switch to equip it.\n";
  else if (alreadyUnlocked) desc+="You already have Slime Lord permanently unlocked.\n";
  else if (saveFailed) desc+="The unlock roll succeeded, but MongoDB couldn't confirm the save. The species has not been reported as unlocked; please contact an owner to verify it.\n";
  else if (unlockMissed) desc+="The Slime Lord did not yield its essence this time. Unlock chance: **9.2%**.\n";
  else if (!won) desc+="Defeat the boss to roll for its permanent species unlock.\n";
  const msg=_state.fightMessages.get(fight.fightId);
  if (msg) await msg.edit({ content:null, embeds:null, ...buildFightResultPayload(header,desc,won?0x2dd4bf:0x8b0000,[]) }).catch(()=>{});
  _state.activeBotFights.delete(fight.fightId);
  _state.activeBotFights.delete(fight.playerId);
  _state.fightMessages.delete(fight.fightId);
}

// ==================== END BOT FIGHT ====================
async function endBotFight(channel, fightId, winner, loser, difficulty, reason='normal') {
  const fight = _state.activeBotFights.get(fightId);
  if (!fight) return;
  if (fight.timeout) clearTimeout(fight.timeout);
  if (fight.isSlimeBoss) {
    await finishSlimeLordBoss(channel,fight,winner,reason);
    return;
  }
  let winsEarned=0, rollEarned=false;
  if (winner==="player") {
    if (fight.playerSpecies.name==="Cyborg") await updateCyborgProgress(fight.playerId,"win");
    if (reason!=="timeout" && fight.playerSpecies.name==="Demon" && fight.botSpecies.name==="Demon")
      await updateDemonAwakeningProgress(fight.playerId,"demonBotWin");
    switch(difficulty) {
      case "easy":       winsEarned=1; break;
      case "medium":     winsEarned=2; if(Math.random()<0.2) rollEarned=true; break;
      case "hard":       winsEarned=3; if(Math.random()<0.5) rollEarned=true; break;
      case "impossible": winsEarned=5; if(Math.random()<0.9) rollEarned=true; break;
      case "brutal":     winsEarned=10; rollEarned=true; break;
    }
    if (rollEarned) { const ud=_state.userSpecies.get(fight.playerId); if(ud){ ud.rolls=(ud.rolls||0)+1; _state.userSpecies.set(fight.playerId,ud); database.saveUserSpecies(fight.playerId,ud); } }
    if (winsEarned>0) { updateFightStats(fight.playerId,true,"BOT",{opponentName:fight.botSpecies.name,opponentSpecies:fight.botSpecies,hpLeft:fight.playerHp,special:`🤖 ${difficulty} bot`,leaderboardPoints:winsEarned}); }
    updateBotStats(fight.playerId,difficulty,true);
  } else {
    updateBotStats(fight.playerId,difficulty,false);
    updateFightStats(fight.playerId,false,"BOT",{opponentName:fight.botSpecies.name,opponentSpecies:fight.botSpecies,hpLeft:0,special:`🤖 ${difficulty} loss`});
  }
  const personality = botPersonalities[difficulty], won = winner === "player";
  const playerMention = "<@" + fight.playerId + ">";
  const header = won ? playerMention + " wins against " + personality.name : playerMention + " lost to " + personality.name;
  let desc = "**" + fight.playerSpecies.name + "**: " + formatFightHealth(won ? fight.playerHp : 0, fight.playerMaxHp) + "\n";
  desc += "**" + fight.botSpecies.name + "**: " + formatFightHealth(won ? 0 : fight.botHp, fight.botMaxHp) + "\n\n";
  if (reason === "timeout") desc += won ? "LOZ took too long to respond. You win by default.\n" : "Your turn timed out. LOZ wins.\n";
  if (reason === "counter") desc += "LOZ was defeated by your counter-strike.\n";
  if (won) {
    desc += "⚔️ Leaderboard: +" + winsEarned + "\n";
    if (rollEarned) desc += "<:reroll_dice:1558042108965822515> Species Rolls: +1\n";
  } else {
    desc += "No rewards earned.";
  }
  const resultPayload = buildFightResultPayload(header, desc, won ? 0x2ecc71 : 0xe74c3c, []);
  const msg = _state.fightMessages.get(fightId);
  if (msg) await msg.edit({ content: null, embeds: null, ...resultPayload }).catch(() => {});
  _state.activeBotFights.delete(fightId);
  _state.activeBotFights.delete(fight.playerId);
  _state.fightMessages.delete(fightId);

  // Only genuine wins against regular bots can trigger the rare boss encounter.
  if (won && !fight.isSlimeBoss && reason!=="timeout" && Math.random()<0.075) {
    await startSlimeLordBoss(channel,fight);
  }
}

module.exports = {
  setState,
  startFight, endFight,
  doBotTurn, endBotFight,
};
