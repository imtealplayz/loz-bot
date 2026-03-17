const { EmbedBuilder } = require("discord.js");
const { botPersonalities } = require("./constants.js");
const { humanSpecies } = require("./constants.js");
const database = require("./database.js");
const {
  hpBar, updateFightStats, updateBotStats,
  updateReaperQuest, updateCyborgProgress, assignSpeciesRole,
} = require("./helpers.js");
const {
  makeCombatant, calculateDamage, applyUltEffect,
  tickCooldowns, applyOgreRegen, processCurseTick,
  buildFightEmbed, buildFightRow, buildBotFightEmbed, buildBotFightRow,
} = require("./combat.js");

let _state = null;
function setState(s) { _state = s; }

// ==================== START PVP FIGHT ====================
async function startFight(channel, player1Id, player2Id) {
  const p1d = _state.userSpecies.get(player1Id);
  const p2d = _state.userSpecies.get(player2Id);
  const player1 = makeCombatant(player1Id, p1d.species);
  const player2 = makeCombatant(player2Id, p2d.species);
  const firstTurn = Math.random()<0.5?player1Id:player2Id;
  const fightId = `${player1Id}-${player2Id}-${Date.now()}`;
  const fight = { fightId, player1Id, player2Id, player1, player2, currentTurn:firstTurn, round:1, lastActionTime:Date.now(), timeout:null };
  const turnPlayer = firstTurn===player1Id?player1:player2;
  const embed = buildFightEmbed(fight,[`⚔️ Fight started! <@${firstTurn}> goes first!`]);
  const row   = buildFightRow(fightId, turnPlayer);
  const msg   = await channel.send({ embeds:[embed], components:[row] });
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
    if (Math.random()<0.3)  { rollEarned=true; const ud=_state.userSpecies.get(winnerId)||{species:humanSpecies,rolls:0}; ud.rolls=(ud.rolls||0)+1; _state.userSpecies.set(winnerId,ud); database.saveUserSpecies(winnerId,ud); }
  }
  // FIX: only update fightLeaderboard via updateFightStats, not bomb tag leaderboard
  updateFightStats(winnerId,true,loserId,{opponentName:loser.species.name,opponentSpecies:loser.species,hpLeft:winner.currentHp,special:reason==="forfeit"?"😵 forfeit":reason==="counter"?"💥 counter":"",doubleWin,rollEarned});
  updateFightStats(loserId,false,winnerId,{opponentName:winner.species.name,opponentSpecies:winner.species,hpLeft:loser.currentHp,special:reason==="forfeit"?"😵 forfeited":"",doubleWin:false,rollEarned:false});
  updateReaperQuest(winnerId,"player");
  _state.fightCooldowns.set(winnerId,Date.now()+60000);
  _state.fightCooldowns.set(loserId,Date.now()+60000);
  let desc=`🏆 **<@${winnerId}> WINS!**\n\n`;
  desc+=`${winner.species.emoji} ${winner.species.name} — ${hpBar(Math.max(0,winner.currentHp),winner.maxHp)}\n`;
  desc+=`${loser.species.emoji}  ${loser.species.name}  — ${hpBar(0,loser.maxHp)}\n\n`;
  if (reason==="timeout")  desc+="⏰ Opponent timed out!\n";
  if (reason==="forfeit")  desc+="😵 Opponent forfeited!\n";
  if (doubleWin)           desc+="✨ **DOUBLE WIN!** +2 points!\n";
  if (rollEarned)          desc+="🎲 **+1 Species Roll!**\n";
  const endEmbed=new EmbedBuilder().setColor(0x2ecc71).setTitle("⚔️ FIGHT OVER").setDescription(desc);
  const msg=_state.fightMessages.get(fightId);
  if (msg) await msg.edit({embeds:[endEmbed],components:[]}).catch(()=>{});
  _state.activeFights.delete(fightId);
  _state.fightMessages.delete(fightId);
}

// ==================== BOT AI TURN ====================
async function doBotTurn(channel, fightId) {
  const fight = _state.activeBotFights.get(fightId);
  if (!fight) return;
  const personality = botPersonalities[fight.difficulty];
  const msg = _state.fightMessages.get(fightId);
  if (msg) await msg.edit({embeds:[buildBotFightEmbed(fight,fight.log||[],"bot_thinking")],components:[buildBotFightRow(fightId,fight,"bot_thinking")]}).catch(()=>{});
  await new Promise(r=>setTimeout(r,personality.reactionDelay));
  if (!_state.activeBotFights.has(fightId)) return;
  const log = fight.log || [];
  const botC = {
    id:"BOT", species:fight.botSpecies, currentHp:fight.botHp, maxHp:fight.botMaxHp,
    ultBuff:fight.botUltBuff, adaptiveStacks:fight.botAdaptiveStacks||0, attackCounter:fight.botAttackCounter||0,
    burn:fight.botBurn||0, burnRounds:fight.botBurnRounds||0, curse:fight.botCurse||0,
    blockHeal:fight.botBlockHeal||false, possession:false, stunnedTurns:fight.botStunnedTurns||0,
    healCooldown:fight.botHealCooldown, ultCooldown:fight.botUltCooldown, lastUltUsed:fight.botLastUltUsed,
  };
  const playerC = {
    id:fight.playerId, species:fight.playerSpecies, currentHp:fight.playerHp, maxHp:fight.playerMaxHp,
    ultBuff:fight.playerUltBuff, adaptiveStacks:fight.playerAdaptiveStacks||0, attackCounter:fight.playerAttackCounter||0,
    burn:fight.playerBurn||0, burnRounds:fight.playerBurnRounds||0, curse:fight.playerCurse||0,
    blockHeal:fight.playerBlockHeal||false, possession:fight.playerPossession||false, stunnedTurns:fight.playerStunnedTurns||0,
    healCooldown:fight.playerHealCooldown, ultCooldown:fight.playerUltCooldown, lastUltUsed:fight.playerLastUltUsed,
  };

  if (playerC.possession) {
    playerC.possession=false;
    const selfHit=Math.floor(Math.random()*(playerC.species.atkMax-playerC.species.atkMin+1))+playerC.species.atkMin;
    fight.playerHp=Math.max(0,fight.playerHp-selfHit);
    log.push(`🎭 **POSSESSION!** <@${fight.playerId}> attacks themselves for ${selfHit}!`);
  } else {
    let botAction="attack";
    if (fight.botHealCooldown===0&&fight.botHp<fight.botMaxHp*personality.healThreshold) botAction="heal";
    else if (fight.botUltCooldown===0&&Math.random()<personality.ultChance) botAction="ult";

    if (botAction==="heal") {
      if (botC.blockHeal) { botC.blockHeal=false; log.push("👑 **ROYAL COMMAND!** Bot cannot heal!"); botAction="attack"; }
      else {
        const h=Math.floor(Math.random()*(botC.species.healMax-botC.species.healMin+1))+botC.species.healMin;
        fight.botHp=Math.min(fight.botMaxHp,fight.botHp+h); fight.botHealCooldown=3;
        log.push(`💚 Bot heals for ${h} HP! (${fight.botHp}/${fight.botMaxHp})`);
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
      botC.currentHp=Math.max(0,Math.min(botC.maxHp,botC.currentHp+result.attackerMutations.hpDelta));
      playerC.currentHp=Math.max(0,playerC.currentHp-result.damage);
      fight.botHp=botC.currentHp; fight.playerHp=playerC.currentHp;
      if (playerC.species.name==="Chimera"&&result.damage>0) fight.playerAdaptiveStacks=Math.min(3,(fight.playerAdaptiveStacks||0)+1);
      if (playerC.species.name==="God"&&result.missedAttack) { const gh=Math.floor(playerC.currentHp*0.2); fight.playerHp=Math.min(fight.playerMaxHp,fight.playerHp+gh); log.push(`👑 **DIVINE RETRIBUTION!** God heals ${gh}!`); }
      fight.botUltBuff=botC.ultBuff; fight.botAdaptiveStacks=botC.adaptiveStacks; fight.botAttackCounter=botC.attackCounter;
      log.push(`⚔️ Bot deals **${result.damage}** damage!${result.specialLines.length?` (${result.specialLines.slice(0,2).join(", ")})`:""}  Your HP: ${fight.playerHp}/${fight.playerMaxHp}`);
    }
  }

  // Sync
  fight.botHp=Math.max(0,botC.currentHp); fight.playerHp=Math.max(0,playerC.currentHp);
  fight.playerBurn=playerC.burn; fight.playerBurnRounds=playerC.burnRounds;
  fight.botBurn=botC.burn; fight.botBurnRounds=botC.burnRounds;
  fight.playerBlockHeal=playerC.blockHeal; fight.playerCurse=playerC.curse;
  fight.playerPossession=playerC.possession; fight.playerStunnedTurns=playerC.stunnedTurns||0;
  fight.playerUltBuff=playerC.ultBuff;

  // Burn tick on player
  if (fight.playerBurn>0) {
    const bd=fight.playerBurn; fight.playerHp=Math.max(0,fight.playerHp-bd);
    fight.playerBurnRounds--; if(fight.playerBurnRounds<=0){fight.playerBurn=0;fight.playerBurnRounds=0;}
    log.push(`🔥 Burn deals ${bd} to you!`);
  }
  // Ogre regen for bot
  if (fight.botSpecies.name==="Ogre") { fight.botHp=Math.min(fight.botMaxHp,fight.botHp+5); log.push("👹 Bot Regeneration +5"); }

  fight.botHealCooldown=Math.max(0,(fight.botHealCooldown||0)-1);
  fight.botUltCooldown=Math.max(0,(fight.botUltCooldown||0)-1);
  fight.playerHealCooldown=Math.max(0,(fight.playerHealCooldown||0)-1);
  fight.playerUltCooldown=Math.max(0,(fight.playerUltCooldown||0)-1);
  fight.round++; fight.log=log.slice(-3);

  if (fight.playerHp<=0) { await endBotFight(channel,fightId,"bot","player",fight.difficulty); return; }
  if (fight.botHp<=0)    { await endBotFight(channel,fightId,"player","bot",fight.difficulty); return; }

  if (msg) await msg.edit({embeds:[buildBotFightEmbed(fight,fight.log||[],"playing")],components:[buildBotFightRow(fightId,fight)]}).catch(()=>{});
  fight.timeout=setTimeout(()=>{ if(_state.activeBotFights.has(fightId)) endBotFight(channel,fightId,"player","bot",fight.difficulty,"timeout"); },60000);
}

// ==================== END BOT FIGHT ====================
async function endBotFight(channel, fightId, winner, loser, difficulty, reason='normal') {
  const fight = _state.activeBotFights.get(fightId);
  if (!fight) return;
  if (fight.timeout) clearTimeout(fight.timeout);
  let winsEarned=0, rollEarned=false;
  if (winner==="player") {
    if (fight.playerSpecies.name==="Cyborg") await updateCyborgProgress(fight.playerId,"win");
    switch(difficulty) {
      case "easy":       winsEarned=1; break;
      case "medium":     winsEarned=2; if(Math.random()<0.2) rollEarned=true; break;
      case "hard":       winsEarned=3; if(Math.random()<0.5) rollEarned=true; break;
      case "impossible": winsEarned=5; if(Math.random()<0.9) rollEarned=true; break;
    }
    if (rollEarned) { const ud=_state.userSpecies.get(fight.playerId)||{species:humanSpecies,rolls:0}; ud.rolls=(ud.rolls||0)+1; _state.userSpecies.set(fight.playerId,ud); database.saveUserSpecies(fight.playerId,ud); }
    if (winsEarned>0) { updateFightStats(fight.playerId,true,"BOT",{opponentName:fight.botSpecies.name,opponentSpecies:fight.botSpecies,hpLeft:fight.playerHp,special:`🤖 ${difficulty} bot`}); }
    updateBotStats(fight.playerId,difficulty,true);
  } else {
    updateBotStats(fight.playerId,difficulty,false);
    updateFightStats(fight.playerId,false,"BOT",{opponentName:fight.botSpecies.name,opponentSpecies:fight.botSpecies,hpLeft:0,special:`🤖 ${difficulty} loss`});
  }
  const personality=botPersonalities[difficulty], won=winner==="player";
  const timeoutMsg=reason==="timeout"?"\n⏰ The bot took too long to respond — you win by default!":"";
  const desc=won
    ?`🏆 **YOU WIN!**${timeoutMsg}\n\n${fight.playerSpecies.emoji} You — ${hpBar(fight.playerHp,fight.playerMaxHp)}\n${fight.botSpecies.emoji} Bot — ${hpBar(0,fight.botMaxHp)}\n\n+${winsEarned} win${winsEarned!==1?"s":""}!${rollEarned?" 🎲 +1 Roll!":""}`
    :`💀 **DEFEAT!**\n\n${fight.playerSpecies.emoji} You — ${hpBar(0,fight.playerMaxHp)}\n${fight.botSpecies.emoji} Bot — ${hpBar(fight.botHp,fight.botMaxHp)}\n\nNo rewards.`;
  const embed=new EmbedBuilder().setColor(won?0x2ecc71:0xe74c3c).setTitle(`🤖 BOT FIGHT — ${difficulty.toUpperCase()}`).setDescription(desc);
  const msg=_state.fightMessages.get(fightId);
  if (msg) await msg.edit({embeds:[embed],components:[]}).catch(()=>{});
  _state.activeBotFights.delete(fightId);
  _state.activeBotFights.delete(fight.playerId);
  _state.fightMessages.delete(fightId);
}

// ==================== BOMB TAG FUNCTIONS ====================
async function startDuelGame(channel, p1Id, p2Id) {
  const gd={channelId:channel.id,players:new Set([p1Id,p2Id]),status:"playing",currentBombHolder:null,eliminated:[],bombEndTime:null,bombTimer:null,passCollector:null,roundActive:false,gameType:"duel",mode:"duel",scores:{[p1Id]:0,[p2Id]:0},roundNumber:0,targetScore:3,hostId:p1Id,judgeUsed:false,reviveUsed:false};
  _state.bombGames.set(channel.id,gd);
  await channel.send({embeds:[new EmbedBuilder().setColor(0x9b59b6).setTitle("💣 Bomb Tag Duel!").setDescription(`<@${p1Id}> vs <@${p2Id}>\nFirst to **3 rounds** wins!\n\nStarting in 5 seconds...`)]});
  setTimeout(()=>startDuelRound(channel,gd),5000);
}

async function startDuelRound(channel, game) {
  if (game.status!=="playing") return;
  game.roundNumber++; game.roundActive=true;
  const players=Array.from(game.players);
  game.currentBombHolder=players[Math.floor(Math.random()*players.length)];
  game.bombEndTime=Date.now()+10000;
  const embed=new EmbedBuilder().setColor(0x9b59b6).setTitle(`💣 Round ${game.roundNumber}`).setDescription(`<@${game.currentBombHolder}> has the bomb!\n⏰ **10 seconds** to pass with \`'pass @user\`\n\n**Score:** <@${players[0]}> ${game.scores[players[0]]} - ${game.scores[players[1]]} <@${players[1]}>`);
  await channel.send({embeds:[embed]});
  startBombTimer(channel,game);
}

function startBombTimer(channel, game) {
  game.bombTimer=setTimeout(async()=>{
    try {
      if (game.status!=="playing") return;
      game.roundActive=false;
      const exploded=game.currentBombHolder;
      if (game.mode==="duel") {
        const players=Array.from(game.players), winner=players.find(p=>p!==exploded);
        game.scores[winner]++;
        const embed=new EmbedBuilder().setColor(0xff0000).setTitle("💥 BOOM!").setDescription(`<@${exploded}> had the bomb!\n\n**Score:** <@${players[0]}> ${game.scores[players[0]]} - ${game.scores[players[1]]} <@${players[1]}>`);
        await channel.send({embeds:[embed]});
        if (game.scores[winner]>=game.targetScore) {
          await channel.send({embeds:[new EmbedBuilder().setColor(0x2ecc71).setTitle("🏆 Match Winner!").setDescription(`<@${winner}> wins!`)]});
          updateLeaderboard(winner,1); _state.bombGames.delete(channel.id); return;
        }
        await channel.send("⏰ Next round in **10 seconds**...");
        setTimeout(()=>{ if(game.status==="playing") startDuelRound(channel,game); },10000);
      } else if (game.mode==="bot") {
        const playerId=Array.from(game.players).find(id=>id!=="BOT");
        const bp=botPersonalities[game.botDifficulty], winner=exploded==="BOT"?playerId:"BOT";
        game.scores[winner]++;
        const embed=new EmbedBuilder().setColor(0xff0000).setTitle("💥 BOOM!").setDescription(`${exploded==="BOT"?`${bp.emoji} **${bp.name}**`:`<@${exploded}>`} had the bomb!\n\n**Score:** <@${playerId}> ${game.scores[playerId]} - ${game.scores.BOT} ${bp.emoji}`);
        await channel.send({embeds:[embed]});
        if (game.scores[winner]>=game.targetScore) {
          await channel.send({embeds:[new EmbedBuilder().setColor(winner===playerId?0x2ecc71:0xff0000).setTitle("🏆 Game Over!").setDescription(winner===playerId?`<@${playerId}> wins!`:`${bp.emoji} **${bp.name}** wins!`)]});
          if (winner!=="BOT") updateLeaderboard(winner,1);
          _state.bombGames.delete(channel.id); return;
        }
        await channel.send("⏰ Next round in **10 seconds**...");
        setTimeout(()=>{ if(game.status==="playing") startBotRound(channel,game); },10000);
      } else {
        game.eliminated.push(exploded); game.players.delete(exploded);
        await channel.send({embeds:[new EmbedBuilder().setColor(0xff0000).setTitle("💥 ELIMINATED!").setDescription(`<@${exploded}> had the bomb!`)]});
        if (game.players.size===1) {
          const winner=Array.from(game.players)[0];
          await channel.send({embeds:[new EmbedBuilder().setColor(0x2ecc71).setTitle("🏆 Game Over!").setDescription(`<@${winner}> wins!`)]});
          updateLeaderboard(winner,3); _state.bombGames.delete(channel.id); return;
        }
        if (game.players.size===0) { await channel.send("💥 Everyone exploded!"); _state.bombGames.delete(channel.id); return; }
        await channel.send(`⏰ Next round in **15 seconds**...\nSurvivors: ${Array.from(game.players).map(id=>`<@${id}>`).join(", ")}`);
        setTimeout(()=>{
          if (game.status!=="playing") return;
          game.roundActive=true;
          const rem=Array.from(game.players);
          game.currentBombHolder=rem[Math.floor(Math.random()*rem.length)];
          game.bombEndTime=Date.now()+10000;
          channel.send({embeds:[new EmbedBuilder().setColor(0x9b59b6).setTitle("💣 New Round!").setDescription(`<@${game.currentBombHolder}> has the bomb! ⏰ 10s to pass!`)]});
          startBombTimer(channel,game);
        },15000);
      }
    } catch(e) { console.error("Bomb timer error:", e); }
  }, game.bombEndTime-Date.now());
}

async function handleBotPass(channel, game) {
  if (game.status!=="playing"||game.currentBombHolder!=="BOT"||!game.roundActive) return;
  const playerId=Array.from(game.players).find(id=>id!=="BOT");
  const bp=botPersonalities[game.botDifficulty];
  const tl=Math.max(0,Math.ceil((game.bombEndTime-Date.now())/1000));
  if (Math.random()<game.botFailRate) {
    await channel.send(`😵 **BOT PASS FAILED!** ${bp.emoji} **${bp.name}** fumbled! ⏰ **${tl}s left**`);
    if (game.roundActive) setTimeout(()=>{ if(game.status==="playing"&&game.currentBombHolder==="BOT"&&game.roundActive) handleBotPass(channel,game); },game.botReactionDelay);
  } else {
    game.currentBombHolder=playerId;
    await channel.send(`✅ ${bp.emoji} **${bp.name}** passed to <@${playerId}>! ⏰ **${tl}s left**`);
  }
}

async function startBotRound(channel, game) {
  if (game.status!=="playing") return;
  game.roundNumber++; game.roundActive=true;
  const playerId=Array.from(game.players).find(id=>id!=="BOT");
  const bp=botPersonalities[game.botDifficulty];
  game.currentBombHolder=Math.random()<0.5?playerId:"BOT";
  game.bombEndTime=Date.now()+10000;
  const embed=new EmbedBuilder().setColor(bp.color).setTitle(`💣 Round ${game.roundNumber}`).setDescription(`${game.currentBombHolder==="BOT"?`${bp.emoji} **${bp.name}**`:`<@${playerId}>`} has the bomb! ⏰ **10 seconds** · Use \`'pass\` to pass\n\n**Score:** <@${playerId}> ${game.scores[playerId]} - ${game.scores.BOT} ${bp.emoji}`);
  await channel.send({embeds:[embed]});
  if (game.currentBombHolder==="BOT") setTimeout(()=>{ if(game.status==="playing"&&game.currentBombHolder==="BOT"&&game.roundActive) handleBotPass(channel,game); },game.botReactionDelay);
  startBombTimer(channel,game);
}

async function startBombGame(channel, game, mode="normal") {
  if (game.players.size<2) { await channel.send("❌ Not enough players! Game cancelled."); _state.bombGames.delete(channel.id); return; }
  await channel.send("🎮 Game starting in 5 seconds...");
  await new Promise(r=>setTimeout(r,5000));
  game.status="playing"; game.eliminated=[]; game.roundActive=true; game.mode=mode;
  const arr=Array.from(game.players);
  game.currentBombHolder=arr[Math.floor(Math.random()*arr.length)];
  game.bombEndTime=Date.now()+10000;
  const embed=new EmbedBuilder().setColor(0x9b59b6).setTitle("💣 BOMB TAG!").setDescription(`<@${game.currentBombHolder}> has the bomb!\n⏰ **10 seconds** to pass with \`'pass @user\`\n\nSurvivors: ${arr.map(id=>`<@${id}>`).join(", ")}`);
  await channel.send({embeds:[embed]});
  startBombTimer(channel,game);
}

async function updateJoinMessage(joinMsg, game) {
  const playerCount=game.players.size;
  const playerList=Array.from(game.players).map(id=>`<@${id}>`).join("\n")||"None yet";
  const message=game.gameType==="locked"
    ?`🔒 **LOCKED BOMB TAG GAME** 🔒\n\nReact with 🎉 to join!\n⏰ Game starts in **2 minutes** or host types \`/game start\`\n\n**Players (${playerCount}):**\n${playerList}`
    :`🧨 **BOMB TAG GAME** 🧨\n\nReact with 🎉 to join!\n⏰ Game starts in **2 minutes** or host types \`/game start\`\n\n**Players (${playerCount}):**\n${playerList}`;
  await joinMsg.edit(message).catch(()=>{});
}

module.exports = {
  setState,
  startFight, endFight,
  doBotTurn, endBotFight,
  startDuelGame, startDuelRound, startBombTimer,
  handleBotPass, startBotRound, startBombGame, updateJoinMessage,
};
