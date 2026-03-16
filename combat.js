const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { typeAdvantages, critRates } = require("./constants.js");
const { hpBar, updateCyborgProgress } = require("./helpers.js");

// ==================== MAKE COMBATANT ====================
function makeCombatant(id, species) {
  return {
    id, species,
    maxHp: species.hp, currentHp: species.hp,
    healCooldown: 0, ultCooldown: 0, ultBuff: null,
    adaptiveStacks: 0, attackCounter: 0,
    burn: 0, burnRounds: 0, curse: 0, curseRounds: 0,
    blockHeal: false, possession: false, stunnedTurns: 0,
    lastUltUsed: null, ultChoicePending: false,
  };
}

// ==================== CALCULATE DAMAGE ====================
function calculateDamage(attacker, defender) {
  const attackerMutations = { hpDelta: 0 };
  const specialLines = [];

  // Shadow Clone
  if (defender.ultBuff?.type === "clone" && defender.ultBuff.duration > 0) {
    defender.ultBuff.duration--;
    if (defender.ultBuff.duration <= 0) defender.ultBuff = null;
    return { damage:0, baseDamage:0, specialLines:["🛡️ **SHADOW CLONE!** The clone absorbs the hit!"], attackerMutations };
  }
  // Dodge buff
  if (defender.ultBuff?.type === "dodge") {
    defender.ultBuff = null;
    return { damage:0, baseDamage:0, specialLines:["💨 **NIMBLE ESCAPE!** Attack dodged!"], attackerMutations, missedAttack:true };
  }
  // Goblin passive dodge
  if (defender.species.name === "Goblin" && Math.random() < 0.1)
    return { damage:0, baseDamage:0, specialLines:["💨 **Speed Dodge!** Too slow!"], attackerMutations, missedAttack:true };
  // Thunder Dragon paralyze
  if (defender.species.name === "Thunder Dragon" && Math.random() < 0.1)
    return { damage:0, baseDamage:0, specialLines:["⚡ **Paralyzing Shock!** Attack fails!"], attackerMutations, missedAttack:true };
  // Earth Dragon invincible
  if (defender.ultBuff?.type === "invincible") {
    defender.ultBuff = null;
    return { damage:0, baseDamage:0, specialLines:["🌍 **TERRA SHIELD!** Invincible!"], attackerMutations, missedAttack:true };
  }
  // Bot counter
  if (defender.species.name === "Bot" && Math.random() < 0.1) {
    const ctr = Math.floor(Math.random()*(defender.species.atkMax-defender.species.atkMin+1))+defender.species.atkMin;
    attackerMutations.hpDelta -= ctr;
    return { damage:0, baseDamage:0, specialLines:[`🤖 **MACHINE LEARNING!** Bot counters for ${ctr}!`], attackerMutations, missedAttack:true };
  }

  const baseDamage = Math.floor(Math.random()*(attacker.species.atkMax-attacker.species.atkMin+1))+attacker.species.atkMin;
  let finalDamage = baseDamage, multiplier = 1;

  // Attacker passives
  if (attacker.species.name==="Orc" && attacker.currentHp<attacker.maxHp*0.3) { finalDamage+=5; specialLines.push("🟢 Berserker +5"); }
  if (attacker.species.name==="Half-Blood" && attacker.currentHp<attacker.maxHp*0.25) { finalDamage+=3; specialLines.push("🩸 Scrappy +3"); }
  if (attacker.species.name==="Chimera" && attacker.adaptiveStacks>0) {
    finalDamage+=attacker.adaptiveStacks*2; specialLines.push(`🎭 Adaptive Evolution +${attacker.adaptiveStacks*2}`); attacker.adaptiveStacks=0;
  }
  if (attacker.species.name==="Reaper") { multiplier*=1.1; specialLines.push("🌑 Soul Reaper +10%"); }
  if (attacker.species.name==="Archdemon") { multiplier*=1.15; finalDamage+=5; specialLines.push("👿 Lord of Darkness +15% +5"); }
  if (attacker.species.name==="Orc Lord") { const d=Math.floor(defender.maxHp*0.15); finalDamage+=d; specialLines.push(`👑 Despair +${d}`); }
  if (attacker.species.name==="Mechangel") {
    attacker.attackCounter=(attacker.attackCounter||0)+1;
    if (attacker.attackCounter%2===0) { multiplier*=1.4; specialLines.push("⚡ Quantum Processing ×1.4"); }
  }

  // ULT buff consumption
  if (attacker.ultBuff) {
    const ub = attacker.ultBuff;
    if (ub.type==="nextAttack" && ub.multiplier) {
      multiplier*=ub.multiplier; specialLines.push(`✨ ULT ×${ub.multiplier}`);
      if (attacker.species.name==="Orc"&&ub.recoil) { const r=Math.floor(finalDamage*multiplier*ub.recoil); attackerMutations.hpDelta-=r; specialLines.push(`💥 Recoil -${r}`); }
      if (attacker.species.name==="Bot"&&ub.recoil) { const r=Math.floor(finalDamage*multiplier*ub.recoil); attackerMutations.hpDelta-=r; specialLines.push(`🤖 Overheat -${r}`); }
      if (attacker.species.name==="Angel"&&ub.angelHeal) { const h=Math.floor(attacker.currentHp*0.35); attackerMutations.hpDelta+=h; specialLines.push(`👼 Divine Blessing +${h}`); }
      if (attacker.species.name==="Reaper"&&ub.type==="reaperKill") {
        if (defender.currentHp<defender.maxHp*0.2) {
          defender.currentHp=0; specialLines.push("💀 **DEATH'S JUDGMENT — INSTANT KILL!**"); attacker.ultBuff=null;
          attacker.currentHp=Math.max(1,Math.min(attacker.maxHp,attacker.currentHp+attackerMutations.hpDelta));
          return { damage:defender.maxHp, baseDamage, specialLines, attackerMutations:{hpDelta:0} };
        } else { multiplier*=1.7; ub._reaperUltHeal=true; specialLines.push("🌑 Reaper ULT ×1.7 + 50% life steal"); }
      }
      if (ub.healSelf&&ub.healAmount) { attackerMutations.hpDelta+=ub.healAmount; specialLines.push(`🩸 Heal +${ub.healAmount}`); }
      if (ub.curse&&ub.curseRounds) { defender.curse=(defender.curse||0)+ub.curse; defender.curseRounds=ub.curseRounds; specialLines.push(`👿 Curse applied`); }
      if (ub.burn&&ub.burnRounds) { defender.burn=(defender.burn||0)+ub.burn; defender.burnRounds=Math.max(defender.burnRounds||0,ub.burnRounds); specialLines.push(`🔥 Burn +${ub.burn}`); }
      attacker.ultBuff=null;
    } else if (ub.type==="buff"&&ub.attack) {
      multiplier*=ub.attack; specialLines.push(`💪 ULT Buff +${Math.round((ub.attack-1)*100)}%`);
      ub.duration--; if(ub.duration<=0) attacker.ultBuff=null;
    } else if (ub.type==="thunderActive") {
      multiplier*=1.4; specialLines.push("⚡ Thunder Surge ×1.4"); attacker.ultBuff=null;
    }
  }

  // Defender reductions
  const isArchdemon = attacker.species.name==="Archdemon";
  if (!isArchdemon) {
    if (defender.species.name==="Demon King")  { multiplier*=0.9;  specialLines.push("Fear Aura -10%"); }
    if (defender.species.name==="Oni")         { multiplier*=0.9;  specialLines.push("Demonic Resilience -10%"); }
    if (defender.species.name==="Demi God")    { multiplier*=0.85; specialLines.push("Divine Shield -15%"); }
    if (defender.species.name==="Earth Dragon"){ multiplier*=0.85; specialLines.push("Stone Skin -15%"); }
  }
  if (defender.ultBuff?.type==="cyborgArmor") {
    multiplier*=0.85; specialLines.push("🤖 Cyborg Armor -15%");
    defender.ultBuff.duration--; if(defender.ultBuff.duration<=0) defender.ultBuff=null;
  }
  if (defender.ultBuff?.type==="damageReduction") {
    multiplier*=(1-defender.ultBuff.amount); specialLines.push(`⚡ Shield -${defender.ultBuff.amount*100}%`);
    defender.ultBuff.duration--; if(defender.ultBuff.duration<=0) defender.ultBuff=null;
  }
  if (defender.ultBuff?.type==="earthDamageReduction") {
    multiplier*=0.4; specialLines.push("🌍 Terra Shield -60%"); defender.ultBuff=null;
  }

  // Type advantage
  const adv = typeAdvantages[attacker.species.name];
  if (adv && attacker.species.name!=="Archdemon") {
    if (adv.strongAgainst===defender.species.name) { multiplier*=1.2; specialLines.push("Type advantage +20%"); }
    else if (adv.weakAgainst===defender.species.name) { multiplier*=0.8; specialLines.push("Type disadvantage -20%"); }
  }

  // Crit (single system — no double)
  const crit = critRates[attacker.species.name];
  if (crit && Math.random()*100<crit.chance) { multiplier*=crit.multiplier; specialLines.push(`💥 CRITICAL ×${crit.multiplier}`); }

  // Kijin shadow dance
  if (attacker.species.name==="Kijin"&&Math.random()<0.15) {
    const s=Math.floor(Math.random()*(attacker.species.atkMax-attacker.species.atkMin+1))+attacker.species.atkMin;
    finalDamage+=s; specialLines.push(`🎭 Shadow Dance +${s}`);
  }

  finalDamage = Math.max(0, Math.floor(finalDamage*multiplier));

  // Post-damage attacker heals
  if (finalDamage>0) {
    if (attacker.species.name==="Reaper") { const h=Math.floor(finalDamage*0.3); attackerMutations.hpDelta+=h; specialLines.push(`🌑 Soul Reaper +${h}`); }
    if (attacker.species.name==="Demon")  { const h=Math.floor(finalDamage*0.2); attackerMutations.hpDelta+=h; specialLines.push(`😈 Life Steal +${h}`); }
    if (attacker.species.name==="Angel")  { const h=Math.floor(finalDamage*0.1); attackerMutations.hpDelta+=h; specialLines.push(`👼 Holy Touch +${h}`); }
    if (defender.species.name==="Ice Dragon") { const h=Math.floor(finalDamage*0.1); defender.currentHp=Math.min(defender.maxHp,defender.currentHp+h); specialLines.push(`❄️ Frost Armor +${h}`); }
  }

  // Passive burn ticks
  if (attacker.species.name==="Demon Lord") { defender.burn=(defender.burn||0)+5; defender.burnRounds=Math.max(defender.burnRounds||0,1); specialLines.push("🔥 Burning Aura +5"); }
  if (attacker.species.name==="Fire Dragon") { defender.burn=(defender.burn||0)+4; defender.burnRounds=Math.max(defender.burnRounds||0,1); specialLines.push("🔥 Fire Dragon burn +4"); }

  // Cyborg damage tracking
  if (attacker.species.name==="Cyborg"&&finalDamage>0&&attacker.id)
    setTimeout(()=>updateCyborgProgress(attacker.id,"damage",finalDamage),0);

  return { damage:finalDamage, baseDamage, specialLines, attackerMutations, missedAttack:false };
}

// ==================== PROCESS TICKS ====================
function processBurnTick(combatant) {
  if (!combatant.burn||combatant.burn<=0) return { burned:0, lines:[] };
  const dmg=combatant.burn;
  combatant.currentHp=Math.max(0,combatant.currentHp-dmg);
  combatant.burnRounds--;
  if (combatant.burnRounds<=0) { combatant.burn=0; combatant.burnRounds=0; }
  return { burned:dmg, lines:[`🔥 Burn deals ${dmg} damage`] };
}

function processCurseTick(combatant) {
  if (!combatant.curse||combatant.curse<=0) return;
  combatant.curseRounds=(combatant.curseRounds||0)-1;
  if (combatant.curseRounds<=0) combatant.curse=0;
}

function tickCooldowns(combatant) {
  if (combatant.healCooldown>0) combatant.healCooldown--;
  if (combatant.ultCooldown>0)  combatant.ultCooldown--;
  if (combatant.stunnedTurns>0) combatant.stunnedTurns--;
  processCurseTick(combatant);
}

// FIX: tick ULT cooldown on BOTH players every round
// active = the player who just acted, passive = the other player
function tickBothUltCooldowns(active, passive) {
  if (active.healCooldown>0)  active.healCooldown--;
  if (active.ultCooldown>0)   active.ultCooldown--;
  if (active.stunnedTurns>0)  active.stunnedTurns--;
  processCurseTick(active);
  // Opponent's ULT also ticks every round
  if (passive.ultCooldown>0)  passive.ultCooldown--;
}

// Tick BOTH players' cooldowns every round so ULT cooldown
// counts down at the correct speed regardless of whose turn it is
function tickBothCooldowns(attacker, defender) {
  tickCooldowns(attacker);
  tickCooldowns(defender);
}

function applyOgreRegen(combatant) {
  if (combatant.species.name==="Ogre") {
    combatant.currentHp=Math.min(combatant.maxHp,combatant.currentHp+5);
    return "👹 Regeneration +5 HP";
  }
  return null;
}

// ==================== APPLY ULT EFFECT ====================
function applyUltEffect(attacker, defender) {
  const sp = attacker.species.name;
  let msg="", requiresChoice=false, choiceType=null;

  switch(sp) {
    case "Orc":         attacker.ultBuff={type:"nextAttack",multiplier:2,recoil:0.2}; msg="⚡ **BERSERKER RAGE!**\n2× damage + 20% recoil!"; break;
    case "Goblin":      attacker.ultBuff={type:"dodge",duration:1}; msg="💨 **NIMBLE ESCAPE!**\nDodge next attack!"; break;
    case "Ogre":        attacker.ultBuff={type:"nextAttack",multiplier:1.5}; msg="💥 **MASSIVE BLOW!**\n1.5× + stun + EXTRA TURN!"; break;
    case "High Orc":    attacker.ultBuff={type:"buff",attack:1.5,duration:2}; msg="📢 **WAR CRY!**\n+50% ATK for 2 attacks!"; break;
    case "Kijin":       attacker.ultBuff={type:"clone",duration:1}; msg="👥 **SHADOW CLONE!**\nClone absorbs next hit!"; break;
    case "Orc Lord":    defender.blockHeal=true; msg="👑 **ROYAL COMMAND!**\nOpponent can't heal next turn!"; break;
    case "Oni":         defender.possession=true; msg="🎭 **DEMONIC POSSESSION!**\nOpponent attacks themselves next turn!"; break;
    case "Demon":       attacker.ultBuff={type:"nextAttack",multiplier:2}; msg="💀 **SOUL STEAL!**\n2× next attack!"; break;
    case "Demon King":  attacker.ultBuff={type:"buff",attack:1.3,duration:3}; msg="🔥 **INFERNAL DOMAIN!**\n+30% dmg for 3 turns!"; break;
    case "Demon Lord":  attacker.ultBuff={type:"nextAttack",multiplier:2,burn:7,burnRounds:2}; msg="🔥 **HELLFIRE!**\n2× + 7 burn 2 rounds!"; break;
    case "Demi God":    attacker.ultBuff={type:"nextAttack",multiplier:2.5}; msg="✨ **DIVINE WRATH!**\n2.5× next attack!"; break;
    case "God": {
      const dmg=Math.floor(defender.currentHp*0.5), heal=Math.floor(attacker.currentHp*0.5);
      defender.currentHp-=dmg; attacker.currentHp=Math.min(attacker.maxHp,attacker.currentHp+heal);
      msg=`⚖️ **DIVINE JUDGMENT!**\n-${dmg} to opponent | +${heal} to you!`; break;
    }
    case "Angel":       requiresChoice=true; choiceType="angel"; msg="👼 **DIVINE BLESSING!**\nChoose your path:"; break;
    case "Ice Dragon":  requiresChoice=true; choiceType="ice_dragon"; msg="❄️ **GLACIAL SPIKE!**\nChoose your path:"; break;
    case "Earth Dragon":requiresChoice=true; choiceType="earth_dragon"; msg="🌍 **TERRA SHIELD!**\nChoose your path:"; break;
    case "Reaper":      attacker.ultBuff={type:"reaperKill",multiplier:1.7}; msg="🌑 **DEATH'S JUDGMENT!**\nBelow 20%: Instant Kill | Above: 1.7×!"; break;
    case "Fire Dragon": attacker.ultBuff={type:"nextAttack",multiplier:1.7,burn:10,burnRounds:2}; msg="🔥 **INFERNO BLAST!**\n1.7× + 10 burn 2 rounds!"; break;
    case "Thunder Dragon": attacker.ultBuff={type:"thunderActive"}; msg="⚡ **THUNDER SURGE!**\n1.4× + paralyze!"; break;
    case "Bot":         attacker.ultBuff={type:"nextAttack",multiplier:2,recoil:0.25}; msg="💻 **SYSTEM OVERLOAD!**\n2× + 25% recoil!"; break;
    case "Cyborg": {
      const h=Math.floor(attacker.maxHp*0.3);
      attacker.currentHp=Math.min(attacker.maxHp,attacker.currentHp+h);
      attacker.ultBuff={type:"cyborgArmor",duration:2};
      msg=`🤖 **SELF-REPAIR!**\nHealed ${h} HP + 15% dmg reduction 2 turns!`; break;
    }
    case "Half-Blood":  attacker.ultBuff={type:"nextAttack",multiplier:1.4,healSelf:true,healAmount:10}; msg="🩸 **AWAKENED BLOOD!**\n1.4× + heal 10 HP!"; break;
    case "Mechangel": {
      const h=Math.floor(attacker.maxHp*0.4);
      attacker.currentHp=Math.min(attacker.maxHp,attacker.currentHp+h);
      attacker.ultBuff={type:"damageReduction",amount:0.2,duration:2};
      msg=`⚡ **SYSTEM RESTORATION!**\nHealed ${h} HP + 20% reduction 2 turns!`; break;
    }
    case "Archdemon":   attacker.ultBuff={type:"nextAttack",multiplier:2.0,curse:10,curseRounds:3}; msg="👿 **ABYSSAL GATE!**\n2× + 10 curse 3 turns!"; break;
    case "Chimera": {
      if (defender.lastUltUsed) {
        attacker.ultBuff=defender.lastUltUsed.buff?{...defender.lastUltUsed.buff}:{type:"nextAttack",multiplier:1.5};
        msg=`🎭 **MIRROR REALM!**\nCopied ${defender.lastUltUsed.name}!`;
      } else {
        attacker.ultBuff={type:"nextAttack",multiplier:1.5};
        msg="🎭 **MIRROR REALM!**\nNo ULT to copy — 1.5×!";
      }
      break;
    }
    default: msg="✨ **ULTIMATE!**";
  }

  if (sp!=="Chimera")
    attacker.lastUltUsed={name:sp.toUpperCase().replace(/ /g,"_"), buff:attacker.ultBuff?{...attacker.ultBuff}:null};

  return { message:msg, requiresChoice, choiceType };
}

// ==================== FIGHT EMBED & ROW BUILDERS ====================
function getBuffLine(p) {
  const parts=[];
  if (p.ultBuff)          parts.push(`✨ ${p.ultBuff.type}`);
  if (p.burn>0)           parts.push(`🔥 Burn ${p.burn}×${p.burnRounds}`);
  if (p.curse>0)          parts.push(`👿 Curse ${p.curse}`);
  if (p.blockHeal)        parts.push("🚫 Can't heal");
  if (p.possession)       parts.push("🎭 Possessed");
  if (p.stunnedTurns>0)   parts.push(`⚡ Stunned ${p.stunnedTurns}`);
  return parts.length?parts.join(" | "):"";
}

function buildFightEmbed(fight, logLines=[], phase="playing") {
  const p1=fight.player1, p2=fight.player2;
  const turnPlayer=fight.currentTurn===fight.player1Id?p1:p2;
  const color=phase==="ended"?0x2ecc71:turnPlayer.species.color||0xff4500;
  let statusLine="";
  if (phase==="bot_thinking") statusLine="\n🤖 **Bot is thinking...**";
  else if (phase==="choice")  statusLine="\n🎯 **Choose your path!**";
  else if (phase==="playing") statusLine=`\n🎲 **It's <@${fight.currentTurn}>'s turn!**`;
  else if (phase==="ended")   statusLine="\n🏆 **Fight Over!**";
  const p1Buffs=getBuffLine(p1), p2Buffs=getBuffLine(p2);
  const desc=
    `${p1.species.emoji} **${p1.species.name}** — <@${fight.player1Id}>\n`+
    `${hpBar(p1.currentHp,p1.maxHp)}${p1Buffs?`\n${p1Buffs}`:""}\n\n`+
    `${p2.species.emoji} **${p2.species.name}** — <@${fight.player2Id}>\n`+
    `${hpBar(p2.currentHp,p2.maxHp)}${p2Buffs?`\n${p2Buffs}`:""}\n`+
    statusLine+`\n\n📜 **Round ${fight.round}**\n`+
    (logLines.length?logLines.map(l=>`└ ${l}`).join("\n"):"└ Fight started!");
  return new EmbedBuilder().setColor(color).setTitle(`⚔️ LOZ FIGHT — Round ${fight.round}`).setDescription(desc)
    .setFooter({text:`ULT CDs — ${p1.species.name}: ${p1.ultCooldown} | ${p2.species.name}: ${p2.ultCooldown}`});
}

function buildFightRow(fightId, player, phase="playing") {
  if (phase==="bot_thinking")
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`pvp_thinking_${fightId}`).setLabel("🤖 Bot is thinking...").setStyle(ButtonStyle.Secondary).setDisabled(true));
  if (phase==="choice_angel")
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_choice_angel_smite_${fightId}`).setLabel("⚔️ Smite (1.5× + 35% heal)").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`pvp_choice_angel_prayer_${fightId}`).setLabel("💚 Prayer (60% heal)").setStyle(ButtonStyle.Success));
  if (phase==="choice_ice_dragon")
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_choice_ice_attack_${fightId}`).setLabel("⚔️ Glacial Strike (1.9×)").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`pvp_choice_ice_heal_${fightId}`).setLabel("💚 Glacial Heal (+50%)").setStyle(ButtonStyle.Success));
  if (phase==="choice_earth_dragon")
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_choice_earth_attack_${fightId}`).setLabel("⚔️ Terra Strike (1.2×)").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`pvp_choice_earth_shield_${fightId}`).setLabel("🛡️ Terra Shield").setStyle(ButtonStyle.Primary));
  const healDisabled=player.healCooldown>0||player.currentHp>=player.maxHp*0.8;
  const ultLabel=player.ultCooldown>0?`✨ ULT (${player.ultCooldown})`:"✨ ULT";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pvp_attack_${fightId}`).setLabel("⚔️ ATTACK").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`pvp_heal_${fightId}`).setLabel("💚 HEAL").setStyle(ButtonStyle.Success).setDisabled(healDisabled),
    new ButtonBuilder().setCustomId(`pvp_ult_${fightId}`).setLabel(ultLabel).setStyle(ButtonStyle.Secondary).setDisabled(player.ultCooldown>0),
    new ButtonBuilder().setCustomId(`pvp_forfeit_${fightId}`).setLabel("🏃 FORFEIT").setStyle(ButtonStyle.Danger));
}

function buildBotFightEmbed(fight, logLines=[], phase="playing") {
  const { botPersonalities } = require("./constants.js");
  const personality=botPersonalities[fight.difficulty];
  const color=phase==="ended"?0x2ecc71:personality.color;
  const pBuf=[], bBuf=[];
  if (fight.playerUltBuff)        pBuf.push(`✨ ${fight.playerUltBuff.type}`);
  if ((fight.playerBurn||0)>0)    pBuf.push(`🔥 Burn ${fight.playerBurn}×${fight.playerBurnRounds}`);
  if (fight.botUltBuff)           bBuf.push(`✨ ${fight.botUltBuff.type}`);
  if ((fight.botBurn||0)>0)       bBuf.push(`🔥 Burn ${fight.botBurn}×${fight.botBurnRounds}`);
  let statusLine=phase==="bot_thinking"?"\n🤖 **Bot is thinking...**":phase==="playing"?"\n🎲 **Your turn!**":phase==="choice"?"\n🎯 **Choose your path!**":"\n🏆 **Fight Over!**";
  const desc=
    `👤 **You** — ${fight.playerSpecies.emoji} ${fight.playerSpecies.name}\n`+
    `${hpBar(fight.playerHp,fight.playerMaxHp)}${pBuf.length?`\n${pBuf.join(" | ")}`:""}\n\n`+
    `🤖 **${personality.emoji} ${personality.name}** — ${fight.botSpecies.emoji} ${fight.botSpecies.name}\n`+
    `${hpBar(fight.botHp,fight.botMaxHp)}${bBuf.length?`\n${bBuf.join(" | ")}`:""}`+
    statusLine+`\n\n📜 **Round ${fight.round}**\n`+
    (logLines.length?logLines.map(l=>`└ ${l}`).join("\n"):"└ Fight started!");
  return new EmbedBuilder().setColor(color).setTitle(`🤖 BOT FIGHT — ${fight.difficulty.toUpperCase()}`).setDescription(desc)
    .setFooter({text:`ULT CD: ${fight.playerUltCooldown} | Heal CD: ${fight.playerHealCooldown}`});
}

function buildBotFightRow(fightId, fight, phase="playing") {
  if (phase==="bot_thinking")
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`botfight_thinking_${fightId}`).setLabel("🤖 Bot is thinking...").setStyle(ButtonStyle.Secondary).setDisabled(true));
  if (phase==="choice_angel")
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`botfight_choice_angel_smite_${fightId}`).setLabel("⚔️ Smite (1.5× + 35% heal)").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`botfight_choice_angel_prayer_${fightId}`).setLabel("💚 Prayer (60% heal)").setStyle(ButtonStyle.Success));
  if (phase==="choice_ice_dragon")
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`botfight_choice_ice_attack_${fightId}`).setLabel("⚔️ Glacial Strike (1.9×)").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`botfight_choice_ice_heal_${fightId}`).setLabel("💚 Glacial Heal (+50%)").setStyle(ButtonStyle.Success));
  if (phase==="choice_earth_dragon")
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`botfight_choice_earth_attack_${fightId}`).setLabel("⚔️ Terra Strike (1.2×)").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`botfight_choice_earth_shield_${fightId}`).setLabel("🛡️ Terra Shield").setStyle(ButtonStyle.Primary));
  const healOk=fight.playerHealCooldown===0&&fight.playerHp<fight.playerMaxHp*0.8;
  const ultLabel=fight.playerUltCooldown>0?`✨ ULT (${fight.playerUltCooldown})`:"✨ ULT";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`botfight_attack_${fightId}`).setLabel("⚔️ ATTACK").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`botfight_heal_${fightId}`).setLabel("💚 HEAL").setStyle(ButtonStyle.Success).setDisabled(!healOk),
    new ButtonBuilder().setCustomId(`botfight_ult_${fightId}`).setLabel(ultLabel).setStyle(ButtonStyle.Secondary).setDisabled(fight.playerUltCooldown>0),
    new ButtonBuilder().setCustomId(`botfight_forfeit_${fightId}`).setLabel("🏃 FORFEIT").setStyle(ButtonStyle.Danger));
}

module.exports = {
  makeCombatant, calculateDamage,
  processBurnTick, processCurseTick, tickCooldowns, tickBothUltCooldowns, applyOgreRegen,
  applyUltEffect,
  getBuffLine, buildFightEmbed, buildFightRow,
  buildBotFightEmbed, buildBotFightRow,
};
