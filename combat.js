const { ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { typeAdvantages, critRates } = require("./constants.js");
const { updateCyborgProgress } = require("./helpers.js");

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

  // ── Miss + Counter chance ────────────────────────────────────────
  const { failChances } = require('./constants.js');
  const missRate = failChances[attacker.species.name] || 0.05;
  if (Math.random() < missRate) {
    // 30% chance defender counter-strikes on miss
    if (Math.random() < 0.3) {
      const avgAtk = Math.floor((defender.species.atkMin + defender.species.atkMax) / 2);
      const ctr = Math.floor(avgAtk * 0.6);
      attackerMutations.hpDelta -= ctr;
      return { damage:0, baseDamage:0, specialLines:[`💨 **MISS!** ${defender.species.emoji} **${defender.species.name}** counter-strikes for **${ctr}**!`], attackerMutations, missedAttack:true };
    }
    return { damage:0, baseDamage:0, specialLines:[`💨 **MISS!** The attack whiffed!`], attackerMutations, missedAttack:true };
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
  if (attacker.species.name==="Orc Lord") { const d=Math.floor(defender.maxHp*0.075); finalDamage+=d; specialLines.push(`👑 Despair +${d}`); }
  if (attacker.species.name==="Mechangel") {
    attacker.attackCounter=(attacker.attackCounter||0)+1;
    if (attacker.attackCounter%2===0) { multiplier*=1.4; specialLines.push("⚡ Quantum Processing ×1.4"); }
  }

  // ULT buff consumption
  if (attacker.ultBuff) {
    const ub = attacker.ultBuff;
    // ── Reaper instant kill — own branch, NOT inside nextAttack ──────
    if (ub.type==="reaperKill") {
      if (defender.currentHp<defender.maxHp*0.2) {
        // Below 20% — instant kill
        const killDmg=defender.currentHp;
        defender.currentHp=0;
        specialLines.push("💀 **DEATH'S JUDGMENT — INSTANT KILL!**");
        attacker.ultBuff=null;
        const lifeSteal=Math.floor(killDmg*0.5);
        attacker.currentHp=Math.min(attacker.maxHp,attacker.currentHp+lifeSteal);
        return { damage:killDmg, baseDamage, specialLines, attackerMutations:{hpDelta:0}, instantKill:true };
      } else {
        // Above 20% — 1.7× damage attack + 50% life steal
        multiplier*=1.7;
        ub._reaperUltHeal=true;
        ub.type="nextAttack"; // convert to nextAttack so it processes below
        specialLines.push("🌑 Reaper ULT ×1.7 + 50% life steal");
      }
    }
    if (ub.type==="nextAttack" && ub.multiplier) {
      multiplier*=ub.multiplier; specialLines.push(`✨ ULT ×${ub.multiplier}`);
      if (attacker.species.name==="Orc"&&ub.recoil) { const r=Math.floor(finalDamage*multiplier*ub.recoil); attackerMutations.hpDelta-=r; specialLines.push(`💥 Recoil -${r}`); }
      if (attacker.species.name==="Bot"&&ub.recoil) { const r=Math.floor(finalDamage*multiplier*ub.recoil); attackerMutations.hpDelta-=r; specialLines.push(`🤖 Overheat -${r}`); }
      if (attacker.species.name==="Angel"&&ub.angelHeal) { const h=Math.floor(attacker.currentHp*0.35); attackerMutations.hpDelta+=h; specialLines.push(`👼 Divine Blessing +${h}`); }
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
      // Copy opponent's species ULT directly — no waiting, no fallback
      // Temporarily spoof attacker species to cast defender's ULT
      const originalSpecies = attacker.species;
      attacker.species = defender.species;
      const copied = applyUltEffect(attacker, defender);
      attacker.species = originalSpecies;
      // Keep Chimera's own cooldown (set by caller), override any cooldown set inside
      msg = `🎭 **MIRROR REALM!**\nCopied **${defender.species.name}**'s ULT!\n${copied.message}`;
      // If copied ULT requires a choice, pass that through
      requiresChoice = copied.requiresChoice;
      choiceType = copied.choiceType;
      break;
    }
    default: msg="✨ **ULTIMATE!**";
  }

  if (sp!=="Chimera")
    attacker.lastUltUsed={name:sp.toUpperCase().replace(/ /g,"_"), buff:attacker.ultBuff?{...attacker.ultBuff}:null};

  return { message:msg, requiresChoice, choiceType };
}

// ==================== FIGHT MESSAGE COMPONENTS ====================
const INLINE = String.fromCharCode(96);
function inlineCode(value) { return INLINE + value + INLINE; }

function formatFightHealth(current, max) {
  const safeMax = Math.max(1, Number(max) || 1);
  const safeCurrent = Math.max(0, Math.min(safeMax, Number(current) || 0));
  const ratio = safeCurrent / safeMax;
  const filled = Math.round(ratio * 12);
  const bar = "▰".repeat(filled) + "▱".repeat(12 - filled);
  const percent = Math.round(ratio * 100);
  const state = ratio <= 0.2 ? "CRITICAL" : ratio <= 0.5 ? "WOUNDED" : ratio >= 0.8 ? "HEALTHY" : "STABLE";
  return bar + "  **" + percent + "%**  " + inlineCode(safeCurrent + "/" + safeMax) + "  ·  " + state;
}

function cleanFightLog(logLines = []) {
  return logLines
    .flatMap(line => String(line ?? "").split("\n"))
    .map(line => line
      .replace(/\\s*[—–]\\s*/g, ": ")
      .replace(/\\s{2,}/g, " ")
      .trim()
      .replace(/\\b(for|deals?|heals?|healed|damage|burn|curse|HP:?)\\s+(\\d+(?:\\.\\d+)?(?:\\/\\d+)?%?)/gi, (match, label, amount) => label + " " + inlineCode(amount))
      .replace(/\\bRound\\s+(\\d+)\\b/gi, (match, round) => "Round " + inlineCode(round)))
    .filter(Boolean)
    .map(line => {
      if (/ULT|ULTIMATE|DIVINE|EXECUTION|REAPER|MECHANGEL|ARCHDEMON|CRITICAL|COUNTER|MASSIVE BLOW|SMITE|PRAYER/i.test(line)) return "✦ " + line;
      if (/MISS|FAILED|CANNOT|CAN'T|COOLDOWN|BLOCKED|STUNNED|FORFEIT/i.test(line)) return "▸ " + line;
      if (/heal|healed|prayer|regeneration/i.test(line)) return "＋ " + line;
      if (/damage|attack|strike|burn|curse|hit|deals/i.test(line)) return "⚔ " + line;
      return "› " + line;
    });
}

function getBuffLine(p) {
  const parts = [];
  if (p.ultBuff)        parts.push("✦ Ultimate " + inlineCode(p.ultBuff.type));
  if (p.burn > 0)       parts.push("🔥 Burn " + inlineCode(p.burn + " × " + p.burnRounds));
  if (p.curse > 0)      parts.push("☠ Curse " + inlineCode(p.curse));
  if (p.blockHeal)      parts.push("⛔ Healing blocked");
  if (p.possession)     parts.push("🎭 Possessed");
  if (p.stunnedTurns>0) parts.push("⚡ Stunned " + inlineCode(p.stunnedTurns));
  return parts.length ? parts.join("  ·  ") : "No active effects";
}

function speciesLabel(species) {
  return ((species && species.emoji) ? species.emoji + " " : "⚔ ") + (species?.name || "Unknown");
}

function buildFightEmbed(fight, logLines = [], phase = "playing") {
  const p1 = fight.player1, p2 = fight.player2;
  const p1Turn = fight.currentTurn === fight.player1Id;
  const p2Turn = fight.currentTurn === fight.player2Id;
  const turnPlayer = p1Turn ? p1 : p2;
  const color = phase === "ended" ? 0x2ecc71 : (turnPlayer.species.color || 0xff4500);
  const logs = cleanFightLog(logLines);
  const p1Name = p1.displayName || ("Player " + (p1Turn ? "1" : "1"));
  const p2Name = p2.displayName || "Player 2";
  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## ⚔️ LOZ ARENA  ·  ROUND " + inlineCode(fight.round)))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      (p1Turn ? "🟢 **YOUR SIDE**  ·  " : "🔹 **CHALLENGER**  ·  ") + "**" + p1Name + "**\n" +
      "**" + speciesLabel(p1.species) + "**\n" + formatFightHealth(p1.currentHp, p1.maxHp) + "\n" + getBuffLine(p1)
    ))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      (p2Turn ? "🟢 **YOUR SIDE**  ·  " : "🔸 **CHALLENGER**  ·  ") + "**" + p2Name + "**\n" +
      "**" + speciesLabel(p2.species) + "**\n" + formatFightHealth(p2.currentHp, p2.maxHp) + "\n" + getBuffLine(p2)
    ))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "### 📜 Combat log\n" + (logs.length ? logs.join("\n") : "› The battle begins. Make your move.")
    ))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "### ✦ Ultimate status\n" + speciesLabel(p1.species) + " " + inlineCode(p1.ultCooldown) + " rounds  ·  " + speciesLabel(p2.species) + " " + inlineCode(p2.ultCooldown) + " rounds"
    ));
}

function buildFightRow(fightId, player, phase = "playing") {
  if (phase === "bot_thinking")
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("pvp_thinking_" + fightId).setLabel("Opponent is thinking...").setStyle(ButtonStyle.Secondary).setDisabled(true));
  if (phase === "choice_angel")
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("pvp_choice_angel_smite_" + fightId).setLabel("Smite (1.5× + 35% heal)").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("pvp_choice_angel_prayer_" + fightId).setLabel("Prayer (60% heal)").setStyle(ButtonStyle.Success));
  if (phase === "choice_ice_dragon")
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("pvp_choice_ice_attack_" + fightId).setLabel("Glacial Strike (1.9×)").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("pvp_choice_ice_heal_" + fightId).setLabel("Glacial Heal (+50%)").setStyle(ButtonStyle.Success));
  if (phase === "choice_earth_dragon")
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("pvp_choice_earth_attack_" + fightId).setLabel("Terra Strike (1.2×)").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("pvp_choice_earth_shield_" + fightId).setLabel("Terra Shield").setStyle(ButtonStyle.Primary));
  const healDisabled = player.healCooldown > 0 || player.currentHp >= player.maxHp * 0.8;
  const ultLabel = player.ultCooldown > 0 ? "Ultimate (" + player.ultCooldown + ")" : "Ultimate";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pvp_attack_" + fightId).setLabel("Attack").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("pvp_heal_" + fightId).setLabel("Heal").setStyle(ButtonStyle.Success).setDisabled(healDisabled),
    new ButtonBuilder().setCustomId("pvp_ult_" + fightId).setLabel(ultLabel).setStyle(ButtonStyle.Secondary).setDisabled(player.ultCooldown > 0),
    new ButtonBuilder().setCustomId("pvp_forfeit_" + fightId).setLabel("Forfeit").setStyle(ButtonStyle.Danger));
}

function buildBotFightEmbed(fight, logLines = [], phase = "playing") {
  const { botPersonalities } = require("./constants.js");
  const personality = botPersonalities[fight.difficulty];
  const color = phase === "ended" ? 0x2ecc71 : personality.color;
  const playerEffects = [];
  const botEffects = [];
  if (fight.playerUltBuff) playerEffects.push("✦ Ultimate " + inlineCode(fight.playerUltBuff.type));
  if ((fight.playerBurn || 0) > 0) playerEffects.push("🔥 Burn " + inlineCode(fight.playerBurn + " × " + fight.playerBurnRounds));
  if (fight.botUltBuff) botEffects.push("✦ Ultimate " + inlineCode(fight.botUltBuff.type));
  if ((fight.botBurn || 0) > 0) botEffects.push("🔥 Burn " + inlineCode(fight.botBurn + " × " + fight.botBurnRounds));
  const logs = cleanFightLog(logLines);
  const playerName = fight.playerName || "You";
  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## ⚔️ LOZ ARENA  ·  " + personality.emoji + " " + personality.name.toUpperCase() + "  ·  ROUND " + inlineCode(fight.round)))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "🟢 **YOUR SIDE**  ·  **" + playerName + "**\n" +
      "**" + speciesLabel(fight.playerSpecies) + "**\n" + formatFightHealth(fight.playerHp, fight.playerMaxHp) + "\n" + (playerEffects.length ? playerEffects.join("  ·  ") : "No active effects")
    ))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "🔻 **OPPONENT**  ·  **LOZ**\n" +
      "**" + speciesLabel(fight.botSpecies) + "**\n" + formatFightHealth(fight.botHp, fight.botMaxHp) + "\n" + (botEffects.length ? botEffects.join("  ·  ") : "No active effects")
    ))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "### 📜 Combat log\n" + (logs.length ? logs.join("\n") : "› The battle begins. Make your move.")
    ))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "### ✦ Your cooldowns\nUltimate " + inlineCode(fight.playerUltCooldown) + "  ·  Heal " + inlineCode(fight.playerHealCooldown)
    ));
}

function buildBotFightRow(fightId, fight, phase = "playing") {
  if (phase === "bot_thinking")
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("botfight_thinking_" + fightId).setLabel("LOZ is thinking...").setStyle(ButtonStyle.Secondary).setDisabled(true));
  if (phase === "choice_angel")
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("botfight_choice_angel_smite_" + fightId).setLabel("Smite (1.5× + 35% heal)").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("botfight_choice_angel_prayer_" + fightId).setLabel("Prayer (60% heal)").setStyle(ButtonStyle.Success));
  if (phase === "choice_ice_dragon")
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("botfight_choice_ice_attack_" + fightId).setLabel("Glacial Strike (1.9×)").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("botfight_choice_ice_heal_" + fightId).setLabel("Glacial Heal (+50%)").setStyle(ButtonStyle.Success));
  if (phase === "choice_earth_dragon")
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("botfight_choice_earth_attack_" + fightId).setLabel("Terra Strike (1.2×)").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("botfight_choice_earth_shield_" + fightId).setLabel("Terra Shield").setStyle(ButtonStyle.Primary));
  const healOk = fight.playerHealCooldown === 0 && fight.playerHp < fight.playerMaxHp * 0.8;
  const ultLabel = fight.playerUltCooldown > 0 ? "Ultimate (" + fight.playerUltCooldown + ")" : "Ultimate";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("botfight_attack_" + fightId).setLabel("Attack").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("botfight_heal_" + fightId).setLabel("Heal").setStyle(ButtonStyle.Success).setDisabled(!healOk),
    new ButtonBuilder().setCustomId("botfight_ult_" + fightId).setLabel(ultLabel).setStyle(ButtonStyle.Secondary).setDisabled(fight.playerUltCooldown > 0),
    new ButtonBuilder().setCustomId("botfight_forfeit_" + fightId).setLabel("Forfeit").setStyle(ButtonStyle.Danger));
}

function buildFightMessagePayload(fight, logLines = [], phase = "playing", rowPhase = phase) {
  const turnId = fight.currentTurn;
  const status = phase === "bot_thinking"
    ? "**🤖 LOZ is thinking...**"
    : phase === "choice"
      ? "**✦ <@" + turnId + ">, choose your ultimate.**"
      : phase === "ended"
        ? "**Fight over**"
        : "**⚔️ <@" + turnId + ">'s turn**";
  const turnPlayer = turnId === fight.player1Id ? fight.player1 : fight.player2;
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], users: phase === "bot_thinking" || phase === "ended" ? [] : [turnId] },
    components: [
      new TextDisplayBuilder().setContent(status),
      buildFightEmbed(fight, logLines, phase),
      buildFightRow(fight.fightId, turnPlayer, rowPhase),
    ],
  };
}

function buildBotFightMessagePayload(fight, logLines = [], phase = "playing", rowPhase = phase) {
  const status = phase === "bot_thinking"
    ? "**🤖 LOZ is thinking...**"
    : phase === "choice"
      ? "**✦ <@" + fight.playerId + ">, choose your ultimate.**"
      : phase === "ended"
        ? "**Fight over**"
        : "**⚔️ Your turn, <@" + fight.playerId + ">**";
  const components = [
    new TextDisplayBuilder().setContent(status),
    buildBotFightEmbed(fight, logLines, phase),
  ];
  if (phase !== "ended") components.push(buildBotFightRow(fight.fightId, fight, rowPhase));
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], users: phase === "bot_thinking" || phase === "ended" ? [] : [fight.playerId] },
    components,
  };
}

function buildFightResultPayload(header, body, color, mentionIds = []) {
  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], users: mentionIds },
    components: [new TextDisplayBuilder().setContent(header), container],
  };
}

module.exports = {
  makeCombatant, calculateDamage,
  processBurnTick, processCurseTick, tickCooldowns, tickBothUltCooldowns, applyOgreRegen,
  applyUltEffect,
  getBuffLine, buildFightEmbed, buildFightRow, buildFightMessagePayload,
  buildBotFightEmbed, buildBotFightRow, buildBotFightMessagePayload,
  buildFightResultPayload, formatFightHealth, cleanFightLog,
};
