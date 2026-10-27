const { botPersonalities, humanSpecies, slimeLordSpecies, werewolfSpecies } = require("./constants.js");
const database = require("./database.js");
const questSystem = require("./quest-system.js");
const achievementSystem = require("./achievements.js");
const leveling = require("./leveling.js");
const { commitFightProgress } = require("./fight-progress.js");
const chaosSystem = require("./chaos.js");
const {
  updateFightStats, updateBotStats,
  updateReaperQuest, updateCyborgProgress, updateDemonAwakeningProgress, updateHalfBloodProgress,
} = require("./helpers.js");
const {
  makeCombatant, calculateDamage, applyUltEffect,
  tickCooldowns, applyOgreRegen, processCurseTick, processBleedTick,
  buildFightMessagePayload, buildBotFightMessagePayload, buildFightResultPayload, formatFightHealth,
} = require("./combat.js");

let _state = null;
function setState(s) { _state = s; }

const BOT_TURN_WATCHDOG_MS = 20000;
const BOT_TURN_STATE_FIELDS = [
  "playerHp", "botHp", "playerPossession", "botPossession",
  "playerStunnedTurns", "botStunnedTurns",
  "playerBloodMoonFrenzyUsed", "playerBloodMoonAttacks", "botBloodMoonFrenzyUsed", "botBloodMoonAttacks",
  "playerBurn", "playerBurnRounds", "botBurn", "botBurnRounds", "playerBleed", "playerBleedRounds", "botBleed", "botBleedRounds",
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
  if (!fight || fight.ending) return;
  fight.ending = true;
  try {
  if (fight.timeout) clearTimeout(fight.timeout);
  chaosSystem.cancelChaosReaction(fight);
  const winner=fight.player1Id===winnerId?fight.player1:fight.player2;
  const loser =fight.player1Id===loserId ?fight.player1:fight.player2;
  const progressionEligible=!["forfeit","timeout","disintegration","judge","divine-intervention","chaos-disintegrate"].includes(String(reason));
  const pvpRewardEligible=progressionEligible
    ? await database.claimPvpRewardWindow(fight.player1Id,fight.player2Id,fight.fightId)
    : false;
  const progressionResults=await Promise.all([
    leveling.awardFightProgress({
      state:_state,channel,fight,userId:fight.player1Id,mode:"pvp",won:winnerId===fight.player1Id,
      reason,pvpEligible:pvpRewardEligible
    }),
    leveling.awardFightProgress({
      state:_state,channel,fight,userId:fight.player2Id,mode:"pvp",won:winnerId===fight.player2Id,
      reason,pvpEligible:pvpRewardEligible
    })
  ]);

  // Forfeits still resolve ordinary W/L records and rewards, but never grant progression.
  if (reason!=="forfeit") {
    await Promise.all([
      achievementSystem.recordBattle(fight.player1Id,fight.player1.species,{won:winnerId===fight.player1Id,mode:"pvp"}),
      achievementSystem.recordBattle(fight.player2Id,fight.player2.species,{won:winnerId===fight.player2Id,mode:"pvp"}),
    ]);
    await Promise.all([
      questSystem.trackProgress(fight.player1Id,"battles",1),
      questSystem.trackProgress(fight.player2Id,"battles",1),
    ]);
    if (reason!=="timeout" && reason!=="disintegration" && reason!=="judge")
      await questSystem.trackProgress(winnerId,"playerWins",1);
    if (winner.species.name==="Cyborg") await updateCyborgProgress(winnerId,"win");
    if (fight.player1.species.name==="Half-Blood")
      await updateHalfBloodProgress(fight.player1Id,"fight",1,fight.player1.species.name);
    if (fight.player2.species.name==="Half-Blood")
      await updateHalfBloodProgress(fight.player2Id,"fight",1,fight.player2.species.name);
    await Promise.all([
      commitFightProgress(fight,fight.player1Id,fight.player1.species),
      commitFightProgress(fight,fight.player2Id,fight.player2.species),
    ]);
  }
  let winPoints=1, rollEarned=false, doubleWin=false;
  if (reason!=="disintegration"&&reason!=="judge") {
    if (Math.random()<0.05) { winPoints=2; doubleWin=true; }
    if (Math.random()<0.3)  { rollEarned=true; const ud=_state.userSpecies.get(winnerId); if(ud){ ud.rolls=(ud.rolls||0)+1; _state.userSpecies.set(winnerId,ud); database.saveUserSpecies(winnerId,ud); } }
  }
  // FIX: only update fightLeaderboard via updateFightStats, not bomb tag leaderboard
  updateFightStats(winnerId,true,loserId,{opponentName:loser.species.name,opponentSpecies:loser.species,hpLeft:winner.currentHp,special:reason==="forfeit"?"😵 forfeit":reason==="counter"?"💥 counter":reason==="chaos-disintegrate"?"🌀 Disintegrate":reason==="divine-intervention"?"💀 Divine intervention":"",doubleWin,rollEarned,leaderboardPoints:winPoints});
  updateFightStats(loserId,false,winnerId,{opponentName:winner.species.name,opponentSpecies:winner.species,hpLeft:loser.currentHp,special:reason==="forfeit"?"😵 forfeited":"",doubleWin:false,rollEarned:false});
  if (reason!=="forfeit") {
    updateReaperQuest(winnerId,"player");
    if (reason!=="disintegration" && reason!=="judge" && winner.species.name==="Demon")
      await updateDemonAwakeningProgress(winnerId,"playerWin");
  }
  _state.fightCooldowns.set(winnerId,Date.now()+30000);
  _state.fightCooldowns.set(loserId,Date.now()+30000);
  let desc = "**" + winner.species.name + "**: " + formatFightHealth(Math.max(0, winner.currentHp), winner.maxHp) + "\n";
  desc += "**" + loser.species.name + "**: " + formatFightHealth(0, loser.maxHp) + "\n\n";
  if (reason === "timeout") desc += "Opponent timed out.\n";
  if (reason === "forfeit") desc += "Opponent forfeited.\n";
  if (reason === "counter") desc += "Opponent was defeated by a counter-strike.\n";
  if (reason === "chaos-disintegrate") desc += "Disintegrated by Chaos Creator.\n";
  if (reason === "divine-intervention") desc += "Disintegrated by divine intervention.\n";
  desc += "⚔️ Leaderboard: +" + winPoints + "\n";
  if (rollEarned) desc += "<:reroll_dice:1558042108965822515> Species Rolls: +1\n";
  const p1Progress=progressionResults[0],p2Progress=progressionResults[1];
  if(p1Progress?.ok||p2Progress?.ok) {
    desc+="\n**Battle Progress**\n";
    if(p1Progress?.ok) desc+="<@"+fight.player1Id+"> · +"+p1Progress.xp+" XP"+(p1Progress.candies>0?" · <:Candies:1562536882561224734> +"+p1Progress.candies+" Candies":"")+"\n";
    if(p2Progress?.ok) desc+="<@"+fight.player2Id+"> · +"+p2Progress.xp+" XP"+(p2Progress.candies>0?" · <:Candies:1562536882561224734> +"+p2Progress.candies+" Candies":"")+"\n";
  }
  const resultPayload = buildFightResultPayload("<@" + winnerId + "> wins the fight", desc, 0x2ecc71, []);
  const msg = _state.fightMessages.get(fightId);
  if (msg) await msg.edit({ content: null, embeds: null, ...resultPayload }).catch(() => {});
  _state.activeFights.delete(fightId);
  _state.activeRequests.delete(fight.player1Id);
  _state.activeRequests.delete(fight.player2Id);
  _state.fightMessages.delete(fightId);
  } catch (error) {
    console.error("[PvP fight " + fightId + "] Fight resolution failed; releasing the fight lock:", error?.stack || error);
  } finally {
    if (fight.timeout) clearTimeout(fight.timeout);
    chaosSystem.cancelChaosReaction(fight);
    if (_state.activeFights.get(fightId) === fight) _state.activeFights.delete(fightId);
    _state.activeRequests.delete(fight.player1Id);
    _state.activeRequests.delete(fight.player2Id);
    _state.fightMessages.delete(fightId);
  }
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
    id:"BOT", species:fight.botSpecies, currentHp:fight.botHp, maxHp:fight.botMaxHp, isEventBoss:Boolean(fight.isEventBoss),
    ultBuff:fight.botUltBuff, adaptiveStacks:fight.botAdaptiveStacks||0, attackCounter:fight.botAttackCounter||0, slimeMissStacks:fight.botSlimeMissStacks||0,
    bloodMoonFrenzyUsed:fight.botBloodMoonFrenzyUsed||false, bloodMoonAttacks:fight.botBloodMoonAttacks||0,
    burn:fight.botBurn||0, burnRounds:fight.botBurnRounds||0, bleed:fight.botBleed||0, bleedRounds:fight.botBleedRounds||0, curse:fight.botCurse||0,
    blockHeal:fight.botBlockHeal||false, possession:fight.botPossession||false, stunnedTurns:fight.botStunnedTurns||0,
    healCooldown:fight.botHealCooldown, ultCooldown:fight.botUltCooldown, lastUltUsed:fight.botLastUltUsed,
  };
  const playerC = {
    id:fight.playerId, species:fight.playerSpecies, currentHp:fight.playerHp, maxHp:fight.playerMaxHp,
    ultBuff:fight.playerUltBuff, adaptiveStacks:fight.playerAdaptiveStacks||0, attackCounter:fight.playerAttackCounter||0, slimeMissStacks:fight.playerSlimeMissStacks||0,
    bloodMoonFrenzyUsed:fight.playerBloodMoonFrenzyUsed||false, bloodMoonAttacks:fight.playerBloodMoonAttacks||0,
    burn:fight.playerBurn||0, burnRounds:fight.playerBurnRounds||0, bleed:fight.playerBleed||0, bleedRounds:fight.playerBleedRounds||0, curse:fight.playerCurse||0,
    blockHeal:fight.playerBlockHeal||false, possession:fight.playerPossession||false, stunnedTurns:fight.playerStunnedTurns||0,
    healCooldown:fight.playerHealCooldown, ultCooldown:fight.playerUltCooldown, lastUltUsed:fight.playerLastUltUsed,
  };

  if(botC.stunnedTurns>0) {
    botC.stunnedTurns=Math.max(0,botC.stunnedTurns-1);
    log.push("⚡ **PARALYZED!** "+botC.species.name+" loses this turn.");
  } else if (botC.possession) {
    botC.possession=false;
    const selfMin=botC.species.name==="Werewolf"&&!botC.isEventBoss?30:botC.species.atkMin; const selfMax=botC.species.name==="Werewolf"&&!botC.isEventBoss?42:botC.species.atkMax; const selfHit=Math.floor(Math.random()*(selfMax-selfMin+1))+selfMin;
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
        const playableWerewolf=botC.species.name==="Werewolf"&&!botC.isEventBoss;
        const healMin=playableWerewolf?18:botC.species.healMin;
        const healMax=playableWerewolf?30:botC.species.healMax;
        let rawH=Math.floor(Math.random()*(healMax-healMin+1))+healMin;
        if(botC.species.name==="Werewolf") log.push(playableWerewolf?"🐺 Base healing roll: "+rawH+" HP (18–30 before status effects).":"🐺 Werewolf boss healing roll: "+rawH+" HP (difficulty-scaled).");
        // <15% desperation rule for bots too
        if (botC.currentHp<botC.maxHp*0.15) {
          if (Math.random()<0.75) { rawH=Math.floor(rawH*0.5); log.push("💔 Bot's desperate heal only 50%!"); }
          else { rawH=Math.floor(rawH*1.3); log.push("✨ Bot's miracle heal +30%!"); }
        }
        // FIX: update botC.currentHp then sync to fight.botHp
        const botHpBeforeHeal=botC.currentHp;
        botC.currentHp=Math.min(botC.maxHp,botC.currentHp+rawH);
        fight.botHp=botC.currentHp; fight.botHealCooldown=3;
        log.push(`💚 Bot heals for ${rawH} HP! (${fight.botHp}/${fight.botMaxHp})`);
        if (botC.currentHp>botHpBeforeHeal && chaosSystem.isChaosCreatorOwner(playerC)) {
          const decision=await chaosSystem.askChaosReaction({
            fight,channel,
            respondentId:playerC.id,
            question:"This individual named "+botC.species.name+" has healed. Do you want to undo the heal?",
            confirmedText:"Healing reversal confirmed.",
            declinedText:"Healing reversal declined.",
          });
          if (!isCurrentBotTurn(fightId,fight,turnToken)) return;
          if (decision.confirmed) {
            botC.currentHp=botHpBeforeHeal;
            fight.botHp=botC.currentHp;
            log.push("🌀 **Recovery Reversal!** The healing was undone.");
          }
        }
      }
    }
    if (botAction==="ult") {
      let chaosUltNullified=false;
      if (chaosSystem.isChaosCreatorOwner(playerC)) {
        const decision=await chaosSystem.askChaosReaction({
          fight,channel,
          respondentId:playerC.id,
          question:"This individual named "+botC.species.name+" has activated their ULT. Do you wish to nullify it?",
          confirmedText:"Ultimate nullification confirmed.",
          declinedText:"Ultimate nullification declined.",
        });
        if (!isCurrentBotTurn(fightId,fight,turnToken)) return;
        chaosUltNullified=decision.confirmed;
      }
      if (chaosUltNullified) {
        fight.botUltCooldown=botC.species.ultCooldown;
        botC.ultCooldown=fight.botUltCooldown;
        fight.botUltBuff=botC.ultBuff;
        log.push("🌀 **ABSOLUTE NULLIFICATION!** "+botC.species.name+"'s ultimate was nullified.");
      } else if (botC.species.name==="Chimera") {
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
          else if (botC.species.name==="Earth Dragon") { botC.ultBuff={type:"nextAttack",multiplier:1.4}; log.push("🌍 Bot TERRA STRIKE — 1.4×!"); }
        } else {
          log.push(`✨ Bot uses ULT! ${um}`);
          if (["God","Mechangel","Cyborg"].includes(botC.species.name)) { fight.botHp=botC.currentHp; fight.playerHp=playerC.currentHp; }
          if (botC.species.name==="Ogre") playerC.stunnedTurns=1;
        }
        fight.botUltCooldown=botC.species.ultCooldown; fight.botUltBuff=botC.ultBuff; fight.botLastUltUsed=botC.lastUltUsed;
      }
    }
    if (botAction==="attack") {
      const playerHpBeforeBotAttack=playerC.currentHp;
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
      const damageTaken=Math.max(0,playerHpBeforeBotAttack-playerC.currentHp);
      if (damageTaken>0 && chaosSystem.isChaosCreatorOwner(playerC)) {
        const decision=await chaosSystem.askChaosReaction({
          fight,channel,
          respondentId:playerC.id,
          question:"This individual named "+botC.species.name+" attacked you. Do you want to reverse the damage?",
          confirmedText:"Damage reversal confirmed.",
          declinedText:"Damage reversal declined.",
        });
        if (!isCurrentBotTurn(fightId,fight,turnToken)) return;
        if (decision.confirmed) {
          playerC.currentHp=Math.min(playerC.maxHp,playerC.currentHp+damageTaken);
          const damageReturned=Math.min(damageTaken,botC.currentHp);
          botC.currentHp=Math.max(0,botC.currentHp-damageReturned);
          log.push("🌀 **Causal Reversal!** Restored "+damageTaken+" HP and returned "+damageReturned+" damage.");
        }
      }
      fight.botHp=Math.max(0,botC.currentHp); fight.playerHp=Math.max(0,playerC.currentHp);
      fight.botUltBuff=botC.ultBuff; fight.botAdaptiveStacks=botC.adaptiveStacks; fight.botAttackCounter=botC.attackCounter;
    }
  }

  // Sync
  fight.botHp=Math.max(0,botC.currentHp); fight.playerHp=Math.max(0,playerC.currentHp);
  fight.playerBurn=playerC.burn; fight.playerBurnRounds=playerC.burnRounds;
  fight.playerBleed=playerC.bleed; fight.playerBleedRounds=playerC.bleedRounds;
  fight.botBurn=botC.burn; fight.botBurnRounds=botC.burnRounds;
  fight.botBleed=botC.bleed; fight.botBleedRounds=botC.bleedRounds;
  fight.playerBloodMoonFrenzyUsed=playerC.bloodMoonFrenzyUsed||false; fight.playerBloodMoonAttacks=playerC.bloodMoonAttacks||0;
  fight.botBloodMoonFrenzyUsed=botC.bloodMoonFrenzyUsed||false; fight.botBloodMoonAttacks=botC.bloodMoonAttacks||0;
  fight.playerBlockHeal=playerC.blockHeal; fight.playerCurse=playerC.curse;
  fight.playerPossession=playerC.possession; fight.playerStunnedTurns=playerC.stunnedTurns||0;
  fight.botPossession=botC.possession||false; fight.botCurse=botC.curse; fight.botStunnedTurns=botC.stunnedTurns||0;
  fight.playerUltBuff=playerC.ultBuff;
  fight.playerSlimeMissStacks=playerC.slimeMissStacks||0;
  fight.botSlimeMissStacks=botC.slimeMissStacks||0;

  // Burn tick on player
  if (fight.playerBurn>0) {
    const rawBurn=fight.playerBurn;
    const bd=playerC.species.name==="Chaos Creator"?Math.ceil(rawBurn*0.5):rawBurn;
    fight.playerHp=Math.max(0,fight.playerHp-bd);
    fight.playerBurnRounds--; if(fight.playerBurnRounds<=0){fight.playerBurn=0;fight.playerBurnRounds=0;}
    log.push(`🔥 Burn deals ${bd} to you!`);
    playerC.currentHp=fight.playerHp;
  }
  if(fight.playerBleed>0) {
    playerC.bleed=fight.playerBleed; playerC.bleedRounds=fight.playerBleedRounds;
    const bleed=processBleedTick(playerC);
    fight.playerHp=Math.max(0,playerC.currentHp);
    fight.playerBleed=playerC.bleed; fight.playerBleedRounds=playerC.bleedRounds;
    if(bleed.bled>0) log.push(...bleed.lines);
  }
  // Ogre regen for bot
  if (fight.botSpecies.name==="Ogre") { fight.botHp=Math.min(fight.botMaxHp,fight.botHp+5); log.push("👹 Bot Regeneration +5"); }

  const skipPlayerTurn=Number(playerC.stunnedTurns)>0;
  if(skipPlayerTurn) {
    playerC.stunnedTurns=Math.max(0,playerC.stunnedTurns-1);
    fight.playerStunnedTurns=playerC.stunnedTurns;
    log.push("⚡ **PARALYSIS!** You lose this turn.");
  }

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
  await updateBotFightMessage(channel, fightId, fight, skipPlayerTurn ? "bot_thinking" : "playing");
  if (!isCurrentBotTurn(fightId, fight, turnToken)) return;
  if(skipPlayerTurn) {
    setTimeout(()=>doBotTurn(channel,fightId),personality.reactionDelay);
    return;
  }
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

// Werewolf is tuned as the damage-focused event boss. It follows the same
// difficulty mapping as Slime Lord but has a separate stat curve and weaker sustain.
const WEREWOLF_BOSS_STATS = {
  easy:       { hp:115, atkMin:16, atkMax:23, healMin:4,  healMax:8,  ultCooldown:10 },
  medium:     { hp:135, atkMin:19, atkMax:27, healMin:5,  healMax:9,  ultCooldown:9 },
  hard:       { hp:160, atkMin:22, atkMax:31, healMin:6,  healMax:10, ultCooldown:8 },
  impossible: { hp:190, atkMin:25, atkMax:35, healMin:7,  healMax:11, ultCooldown:8 },
  brutal:     { hp:225, atkMin:29, atkMax:40, healMin:8,  healMax:12, ultCooldown:7 },
};

async function startSlimeLordBoss(channel, previousFight, bossType="slimeLord") {
  const playerId=String(previousFight.playerId);
  if (_state.activeBotFights.has(playerId)) return;
  const difficulty=previousFight.difficulty;
  const isWerewolf=bossType==="werewolf";
  const baseSpecies=isWerewolf?werewolfSpecies:slimeLordSpecies;
  const statsByDifficulty=isWerewolf?WEREWOLF_BOSS_STATS:SLIME_LORD_BOSS_STATS;
  const bossStats=statsByDifficulty[difficulty] || statsByDifficulty.medium;
  const bossSpecies={...baseSpecies,...bossStats};
  const playerSpecies=previousFight.playerSpecies || _state.userSpecies.get(playerId)?.species || humanSpecies;
  const playerMaxHp=playerSpecies.hp || humanSpecies.hp;
  const fightId=(isWerewolf?"werewolf-boss-":"slime-boss-")+playerId+"-"+Date.now();
  const fight={
    fightId,playerId,playerSpecies,playerHp:playerMaxHp,playerMaxHp,
    playerHealCooldown:0,playerUltCooldown:0,playerUltBuff:null,
    playerAdaptiveStacks:0,playerAttackCounter:0,playerSlimeMissStacks:0,
    playerBloodMoonFrenzyUsed:false,playerBloodMoonAttacks:0,
    playerBurn:0,playerBurnRounds:0,playerBleed:0,playerBleedRounds:0,playerCurse:0,playerCurseRounds:0,
    playerBlockHeal:false,playerPossession:false,playerStunnedTurns:0,playerLastUltUsed:null,
    botSpecies:bossSpecies,botHp:bossSpecies.hp,botMaxHp:bossSpecies.hp,
    botHealCooldown:0,botUltCooldown:0,botUltBuff:null,botAdaptiveStacks:0,botAttackCounter:0,botSlimeMissStacks:0,
    botBloodMoonFrenzyUsed:false,botBloodMoonAttacks:0,
    botBurn:0,botBurnRounds:0,botBleed:0,botBleedRounds:0,botCurse:0,botCurseRounds:0,
    botPossession:false,botBlockHeal:false,botStunnedTurns:0,botLastUltUsed:null,
    round:1,difficulty,botPersonality:botPersonalities[difficulty],timeout:null,
    log:[
      "A rare "+(isWerewolf?"Werewolf":"Slime Lord")+" has emerged after your "+difficulty.toUpperCase()+" victory.",
      "Boss stats scale to the difficulty of the battle that triggered this encounter.",
      "Your HP is fully restored and temporary combat effects are reset for this fresh battle."
    ],
    playerName:previousFight.playerName||"You",
    isSlimeBoss:!isWerewolf,isEventBoss:true,bossType:isWerewolf?"werewolf":"slimeLord",bossDifficulty:difficulty
  };
  // Reserve the player's slot before Discord I/O to prevent concurrent fights.
  _state.activeBotFights.set(fightId,fight);
  _state.activeBotFights.set(playerId,fightId);
  try {
    const msg=await channel.send(buildBotFightMessagePayload(fight,fight.log,"playing"));
    _state.fightMessages.set(fightId,msg);
    fight.timeout=setTimeout(()=>{
      if(_state.activeBotFights.get(fightId)===fight) {
        endBotFight(channel,fightId,"bot","player",difficulty,"timeout")
          .catch(error=>console.error("["+ (isWerewolf?"Werewolf":"Slime Lord") +" boss] Initial timeout resolution failed:",error?.stack||error));
      }
    },120000);
  } catch(error) {
    if(_state.activeBotFights.get(fightId)===fight) _state.activeBotFights.delete(fightId);
    if(_state.activeBotFights.get(playerId)===fightId) _state.activeBotFights.delete(playerId);
    console.error("["+ (isWerewolf?"Werewolf":"Slime Lord") +" boss] Failed to start encounter:",error?.stack||error);
  }
}

async function finishSlimeLordBoss(channel,fight,winner,reason) {
  const won=winner==="player";
  const isWerewolf=fight.bossType==="werewolf";
  const speciesKey=isWerewolf?"werewolf":"slimeLord";
  const label=isWerewolf?"Werewolf":"Slime Lord";
  const unlockChance=isWerewolf?0.05:0.092;
  const unlockEligible=won&&!["timeout","disintegration","judge","divine-intervention","chaos-disintegrate"].includes(String(reason));
  let unlocked=false,alreadyUnlocked=false,saveFailed=false,unlockMissed=false;
  if(unlockEligible) {
    const current=_state.userSpecies.get(fight.playerId)||{
      species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,speciesTokens:0,candies:0,
      level:1,xp:0,requestsEnabled:true,lastSwitch:0,awakening:{},badges:[]
    };
    alreadyUnlocked=current.questSpecies?.[speciesKey]?.unlocked===true||current.originalSpecies?.name===label;
    if(!alreadyUnlocked) {
      // The result of each eligible boss-drop roll is saved, including a miss, so retries cannot reroll the same victory.
      const roll=await database.rollBossSpeciesUnlock(fight.playerId,speciesKey,fight.fightId,unlockChance);
      if(!roll?.ok) saveFailed=true;
      else if(roll.unlocked) {
        current.questSpecies={...(current.questSpecies||{}),[speciesKey]:{...(current.questSpecies?.[speciesKey]||{}),unlocked:true,equipped:false,source:"boss"}};
        _state.userSpecies.set(fight.playerId,current);
        unlocked=true;
      } else unlockMissed=true;
    }
  }
  const playerMention="<@"+fight.playerId+">";
  const header=won?playerMention+" defeated the "+label+" boss!":playerMention+" was defeated by the "+label+" boss.";
  let desc="**Difficulty:** "+String(fight.difficulty).toUpperCase()+"\n";
  desc+="**Your HP:** "+formatFightHealth(won?fight.playerHp:0,fight.playerMaxHp)+"\n";
  desc+="**Boss HP:** "+formatFightHealth(won?0:fight.botHp,fight.botMaxHp)+"\n";
  if(fight.progressionResult?.ok) {
    desc+="**Progress:** Level "+fight.progressionResult.level+" · "+fight.progressionResult.xpProgress+"/100 XP (+"+fight.progressionResult.xp+" XP)\n";
    if(fight.progressionResult.candies>0) desc+="<:Candies:1562536882561224734> Candies: +"+fight.progressionResult.candies+"\n";
  }
  desc+="\n";
  if(unlocked) desc+=(isWerewolf?"🐺 **Werewolf permanently unlocked!**":"🫧 **Slime Lord permanently unlocked!**")+" Use /switch to equip it.\n";
  else if(alreadyUnlocked) desc+="You already have "+label+" permanently unlocked.\n";
  else if(saveFailed) desc+="LOZ could not verify the boss-drop result in MongoDB. Contact an owner before retrying; the result will not be rerolled automatically.\n";
  else if(unlockMissed) desc+="The "+label+" did not yield its essence this time. Unlock chance: **"+(unlockChance*100).toFixed(1)+"%**.\n";
  else if(won&&!unlockEligible) desc+="This result does not qualify for a species-unlock roll.\n";
  else if(!won) desc+="Defeat the boss to roll for its permanent species unlock.\n";
  const msg=_state.fightMessages.get(fight.fightId);
  if(msg) await msg.edit({content:null,embeds:null,...buildFightResultPayload(header,desc,won?(isWerewolf?0x7c3aed:0x2dd4bf):0x8b0000,[])}).catch(()=>{});
  _state.activeBotFights.delete(fight.fightId);
  _state.activeBotFights.delete(fight.playerId);
  _state.fightMessages.delete(fight.fightId);
}

// ==================== END BOT FIGHT ====================
async function endBotFight(channel, fightId, winner, loser, difficulty, reason='normal') {
  const fight = _state.activeBotFights.get(fightId);
  if (!fight || fight.ending) return;
  fight.ending = true;
  try {
  if (fight.timeout) clearTimeout(fight.timeout);
  chaosSystem.cancelChaosReaction(fight);
  // Count every completed Half-Blood bot fight, including losses and Slime Lord boss attempts.
  if (fight.playerSpecies?.name==="Half-Blood")
    await updateHalfBloodProgress(fight.playerId,"fight",1,fight.playerSpecies.name);
  if (winner==="player" && fight.playerSpecies?.name==="Cyborg")
    await updateCyborgProgress(fight.playerId,"win");
  // Bot fights cannot be forfeited; commit in-fight progress once the result is final.
  await commitFightProgress(fight,fight.playerId,fight.playerSpecies);
  // Count completed battles before the Slime Lord boss early-return as well.
  await questSystem.trackProgress(fight.playerId,"battles",1);
  await achievementSystem.recordBattle(fight.playerId,fight.playerSpecies,{won:winner==="player",mode:"bot",boss:Boolean(fight.isEventBoss)});
  const progressionResult=await leveling.awardFightProgress({state:_state,channel,fight,userId:fight.playerId,mode:"bot",difficulty,won:winner==="player",reason,boss:Boolean(fight.isEventBoss)});
  if (winner==="player" && reason!=="timeout") {
    await questSystem.trackProgress(fight.playerId,"botWins",1);
    if (difficulty==="brutal") await questSystem.trackProgress(fight.playerId,"brutalWins",1);
  }
  if (fight.isEventBoss) {
    fight.progressionResult=progressionResult;
    await finishSlimeLordBoss(channel,fight,winner,reason);
    return;
  }
  let winsEarned=0, rollEarned=false;
  if (winner==="player") {
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
  if (reason === "chaos-disintegrate") desc += "Disintegrated by Chaos Creator.\n";
  if (won) {
    desc += "⚔️ Leaderboard: +" + winsEarned + "\n";
    if (rollEarned) desc += "<:reroll_dice:1558042108965822515> Species Rolls: +1\n";
  } else {
    desc += reason==="timeout" ? "No progression rewards earned." : "Level progression and event rewards recorded.";
  }
  if(progressionResult?.ok) {
    desc += "\n⭐ Level "+progressionResult.level+" · "+progressionResult.xpProgress+"/100 XP (+"+progressionResult.xp+" XP)";
    if(progressionResult.candies>0) desc += "\n<:Candies:1562536882561224734> Candies: +"+progressionResult.candies;
  }
  const resultPayload = buildFightResultPayload(header, desc, won ? 0x2ecc71 : 0xe74c3c, []);
  const msg = _state.fightMessages.get(fightId);
  if (msg) await msg.edit({ content: null, embeds: null, ...resultPayload }).catch(() => {});
  _state.activeBotFights.delete(fightId);
  _state.activeBotFights.delete(fight.playerId);
  _state.fightMessages.delete(fightId);

  // Only genuine wins against regular bots can trigger the rare boss encounter.
  const bossSpawnEligibleReason=!["timeout","disintegration","judge","divine-intervention","chaos-disintegrate"].includes(String(reason));
  if (won && !fight.isEventBoss && bossSpawnEligibleReason && ["medium","hard","impossible","brutal"].includes(difficulty) && Math.random()<0.075) {
    const selectedBoss=Math.random()<0.6?"slimeLord":"werewolf";
    await startSlimeLordBoss(channel,fight,selectedBoss);
  }
  } catch (error) {
    console.error("[Bot fight " + fightId + "] Fight resolution failed; releasing the fight lock:", error?.stack || error);
  } finally {
    if (fight.timeout) clearTimeout(fight.timeout);
    chaosSystem.cancelChaosReaction(fight);
    if (_state.activeBotFights.get(fightId) === fight) _state.activeBotFights.delete(fightId);
    // Preserve a new boss encounter that may have replaced the player's lock.
    if (_state.activeBotFights.get(fight.playerId) === fightId) _state.activeBotFights.delete(fight.playerId);
    _state.fightMessages.delete(fightId);
  }
}

module.exports = {
  setState,
  startFight, endFight,
  doBotTurn, endBotFight,
};
