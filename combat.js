const { ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { typeAdvantages, critRates } = require("./constants.js");
const { updateCyborgProgress, updateHalfBloodProgress } = require("./helpers.js");

// ==================== MAKE COMBATANT ====================
function makeCombatant(id, species) {
  return {
    id, species,
    maxHp: species.hp, currentHp: species.hp,
    healCooldown: 0, ultCooldown: 0, ultBuff: null, ultDebuffs: [],
    adaptiveStacks: 0, attackCounter: 0, slimeMissStacks: 0,
    bloodMoonFrenzyUsed:false, bloodMoonAttacks:0,
    burn: 0, burnRounds: 0, bleed:0, bleedRounds:0, curse: 0, curseRounds: 0,
    blockHeal: false, possession: false, stunnedTurns: 0,
    lastUltUsed: null, ultChoicePending: false,
  };
}

// ==================== CALCULATE DAMAGE ====================

function recordSlimeLordMiss(attacker, specialLines) {
  if (attacker?.species?.name !== "Slime Lord") return;
  attacker.slimeMissStacks = Math.min(5, Math.max(0, Number(attacker.slimeMissStacks) || 0) + 1);
  const nextMultiplier = 1 + 0.2 * attacker.slimeMissStacks;
  specialLines.push("🫧 Adaptive Momentum builds to ×" + nextMultiplier.toFixed(1));
}

function absorbSlimeLordDamage(attacker, defender, incomingDamage, specialLines) {
  if (defender?.species?.name !== "Slime Lord"
    || defender.ultBuff?.type !== "slimeAssimilation"
    || !(incomingDamage > 0)) return null;

  const missingHp = Math.max(0, defender.maxHp - defender.currentHp);
  const healing = Math.min(missingHp, incomingDamage);
  const reflected = Math.max(0, incomingDamage - healing);
  defender.currentHp = Math.min(defender.maxHp, defender.currentHp + healing);
  if (reflected > 0) attacker.currentHp = Math.max(0, attacker.currentHp - reflected);
  defender.ultBuff = null;

  specialLines.push("🫧 Predatory Assimilation converts " + incomingDamage + " damage into " + healing + " HP"
    + (reflected > 0 ? " and reflects " + reflected + " overflow damage!" : "!"));
  return { healing, reflected };
}

function speciesAttackBounds(species,isEventBoss=false) {
  if(species?.name==="Werewolf"&&!isEventBoss) return {min:30,max:42};
  const min=Math.max(1,Math.floor(Number(species?.atkMin)||1));
  const max=Math.max(min,Math.floor(Number(species?.atkMax)||min));
  return {min,max};
}

function calculateDamage(attacker, defender) {
  const attackerMutations = { hpDelta: 0 };
  const specialLines = [];
  // A one-shot ultimate is consumed by the next attack action even if it is dodged or misses.
  const consumeMissedAttackUltimate = lines => {
    const buff=attacker.ultBuff;
    if(!buff || !["nextAttack","reaperKill","thunderActive"].includes(buff.type)) return;
    attacker.ultBuff=null;
    if(buff.type==="reaperKill") lines.push("🌑 Death's Judgment was consumed by the missed attack.");
    else if(buff.bleed) lines.push("🐺 Lunar Rend missed; its empowered attack and Bleed were consumed.");
    else lines.push("✨ The empowered attack was consumed by the miss.");
  };
  if(attacker.species.name==="Werewolf" && !attacker.bloodMoonFrenzyUsed && attacker.currentHp<=attacker.maxHp*0.75) {
    attacker.bloodMoonFrenzyUsed=true;
    attacker.bloodMoonAttacks=2;
    specialLines.push("🐺 **BLOOD MOON FRENZY!** Werewolf has entered a frenzy.");
  }
  const bloodMoonActive=attacker.species.name==="Werewolf" && Number(attacker.bloodMoonAttacks)>0;
  if(bloodMoonActive) {
    attacker.bloodMoonAttacks=Math.max(0,Number(attacker.bloodMoonAttacks)-1);
    specialLines.push("🐺 Blood Moon Frenzy ×1.3 · "+attacker.bloodMoonAttacks+" empowered attack(s) remain.");
  }

  // Shadow Clone
  if (defender.ultBuff?.type === "clone" && defender.ultBuff.duration > 0) {
    defender.ultBuff.duration--;
    if (defender.ultBuff.duration <= 0) defender.ultBuff = null;
    const lines=["🛡️ **SHADOW CLONE!** The clone absorbs the hit!"];
    consumeMissedAttackUltimate(lines);
    return { damage:0, baseDamage:0, specialLines:lines, attackerMutations, missedAttack:true };
  }
  // Dodge buff
  if (defender.ultBuff?.type === "dodge" && attacker.species.name === "True Dragon") {
    defender.ultBuff = null;
    specialLines.push("👁️ Universal Perception sees through the opponent’s evasion.");
  }
  if (defender.ultBuff?.type === "dodge" && attacker.species.name !== "Chaos Creator" && attacker.species.name !== "True Dragon") {
    defender.ultBuff = null;
    const lines=["💨 **NIMBLE ESCAPE!** Attack dodged!"];
    recordSlimeLordMiss(attacker, lines);
    consumeMissedAttackUltimate(lines);
    return { damage:0, baseDamage:0, specialLines:lines, attackerMutations, missedAttack:true };
  }
  // Goblin passive dodge
  if (defender.species.name === "Goblin" && attacker.species.name !== "Chaos Creator" && attacker.species.name !== "True Dragon" && Math.random() < 0.1) {
    const lines=["💨 **Speed Dodge!** Too slow!"];
    recordSlimeLordMiss(attacker, lines);
    consumeMissedAttackUltimate(lines);
    return { damage:0, baseDamage:0, specialLines:lines, attackerMutations, missedAttack:true };
  }
  // Thunder Dragon paralyze
  if (defender.species.name === "Thunder Dragon" && attacker.species.name !== "Chaos Creator" && attacker.species.name !== "True Dragon" && Math.random() < 0.1) {
    const lines=["⚡ **Paralyzing Shock!** Attack fails!"];
    recordSlimeLordMiss(attacker, lines);
    consumeMissedAttackUltimate(lines);
    return { damage:0, baseDamage:0, specialLines:lines, attackerMutations, missedAttack:true };
  }
  // Bot counter
  if (defender.species.name === "Bot" && Math.random() < 0.1) {
    if (attacker.species.name === "Chaos Creator") {
      specialLines.push("🌀 The enemy tried to counter, but got counter-countered.");
    } else {
      const counterRange=speciesAttackBounds(defender.species,defender.isEventBoss===true);
      const ctr = Math.floor(Math.random()*(counterRange.max-counterRange.min+1))+counterRange.min;
      attackerMutations.hpDelta -= ctr;
      const lines=[`🤖 **MACHINE LEARNING!** Bot counters for ${ctr}!`];
      recordSlimeLordMiss(attacker, lines);
      consumeMissedAttackUltimate(lines);
      return { damage:0, baseDamage:0, specialLines:lines, attackerMutations, missedAttack:true };
    }
  }

  // ── Miss + Counter chance ────────────────────────────────────────
  const { failChances } = require('./constants.js');
  const missRate = failChances[attacker.species.name] || 0.05;
  if (attacker.species.name !== "Chaos Creator" && Math.random() < missRate) {
    // 30% chance defender counter-strikes on miss
    if (Math.random() < 0.3) {
      const defenderRange=speciesAttackBounds(defender.species,defender.isEventBoss===true);
      const avgAtk = Math.floor((defenderRange.min + defenderRange.max) / 2);
      const ctr = Math.floor(avgAtk * 0.6);
      attackerMutations.hpDelta -= ctr;
      const lines=[`💨 **MISS!** ${defender.species.emoji} **${defender.species.name}** counter-strikes for **${ctr}**!`];
      recordSlimeLordMiss(attacker, lines);
      consumeMissedAttackUltimate(lines);
      return { damage:0, baseDamage:0, specialLines:lines, attackerMutations, missedAttack:true };
    }
    const lines=[`💨 **MISS!** The attack whiffed!`];
    recordSlimeLordMiss(attacker, lines);
    consumeMissedAttackUltimate(lines);
    return { damage:0, baseDamage:0, specialLines:lines, attackerMutations, missedAttack:true };
  }

  const attackRange=speciesAttackBounds(attacker.species,attacker.isEventBoss===true);
  const baseDamage = Math.floor(Math.random()*(attackRange.max-attackRange.min+1))+attackRange.min;
  if(attacker.species.name==="Werewolf") specialLines.push("🐺 Base attack roll: "+baseDamage+(attacker.isEventBoss?" (difficulty-scaled boss roll before enemy defenses).":" (30–42 before enemy defenses)."));
  let finalDamage = baseDamage, multiplier = bloodMoonActive?1.3:1, ignoreReduction = 0;
  let reaperUltHeal=false, ultimateLifeSteal=0;

  // Attacker passives
  if (attacker.species.name==="Orc" && attacker.currentHp<attacker.maxHp*0.3) { finalDamage+=5; specialLines.push("🟢 Berserker +5"); }
  if (attacker.species.name==="Half-Blood" && attacker.currentHp<attacker.maxHp*0.25) { finalDamage+=3; specialLines.push("🩸 Scrappy +3"); }
  if (attacker.species.name==="Eclipsed Sovereign" && attacker.currentHp<attacker.maxHp*0.5) { multiplier*=1.2; specialLines.push("🌘 Hybrid Instinct +20%"); }
  if (attacker.species.name==="Chimera" && attacker.adaptiveStacks>0) {
    finalDamage+=attacker.adaptiveStacks*2; specialLines.push(`🎭 Adaptive Evolution +${attacker.adaptiveStacks*2}`); attacker.adaptiveStacks=0;
  }
  if (attacker.species.name==="Reaper") { multiplier*=1.1; specialLines.push("🌑 Soul Reaper +10%"); }
  if (attacker.species.name==="Slime Lord" && (attacker.slimeMissStacks||0)>0) {
    const stacks=Math.min(5,Math.max(0,Number(attacker.slimeMissStacks)||0));
    multiplier*=1+0.2*stacks;
    specialLines.push("🫧 Adaptive Momentum ×" + (1+0.2*stacks).toFixed(1));
    attacker.slimeMissStacks=0;
  }
  if (attacker.species.name==="Archdemon") { multiplier*=1.15; finalDamage+=5; specialLines.push("👿 Lord of Darkness +15% +5"); }
  if (attacker.species.name==="Orc Lord") { const d=Math.floor(defender.maxHp*0.075); finalDamage+=d; specialLines.push(`👑 Despair +${d}`); }
  if (attacker.species.name==="Cyborg") {
    attacker.attackCounter=(attacker.attackCounter||0)+1;
    if (attacker.attackCounter%3===0) { multiplier*=1.3; specialLines.push("🤖 Overclock ×1.3"); }
  }
  if (attacker.species.name==="Mechangel") {
    attacker.attackCounter=(attacker.attackCounter||0)+1;
    if (attacker.attackCounter%2===0) { multiplier*=1.4; specialLines.push("⚡ Quantum Processing ×1.4"); }
  }

  // ULT buff consumption
  if (attacker.ultBuff) {
    const ub = attacker.ultBuff;
    // ── Reaper instant kill — own branch, NOT inside nextAttack ──────
    if (ub.type==="reaperKill") {
      if (defender.currentHp<=defender.maxHp*0.2) {
        // Chaos Creator's passive prevents instant-kill damage from bypassing its reduction.
        if (defender.species.name === "Chaos Creator") {
          const reducedDamage = Math.ceil(defender.currentHp * 0.5);
          attacker.ultBuff = null;
          attackerMutations.hpDelta += Math.floor(reducedDamage * 0.5);
          specialLines.push("🌀 **ABSOLUTE AUTHORITY!** Death's Judgment damage reduced by 50%.");
          return { damage:reducedDamage, baseDamage, specialLines, attackerMutations, instantKill:false };
        }
        // Below 20% — instant kill
        const killDmg=defender.currentHp;
        const assimilation=absorbSlimeLordDamage(attacker, defender, killDmg, specialLines);
        if (assimilation) {
          // Predatory Assimilation blocks the execution and consumes Death's Judgment.
          attacker.ultBuff=null;
          specialLines.push("🌑 **DEATH'S JUDGMENT ABSORBED!** Predatory Assimilation prevents the execution.");
          return { damage:0, baseDamage, specialLines, attackerMutations:{hpDelta:0}, missedAttack:false, absorbed:true };
        }
        defender.currentHp=0;
        specialLines.push("💀 **DEATH'S JUDGMENT — INSTANT KILL!**");
        attacker.ultBuff=null;
        const lifeSteal=Math.floor(killDmg*0.5);
        attacker.currentHp=Math.min(attacker.maxHp,attacker.currentHp+lifeSteal);
        return { damage:killDmg, baseDamage, specialLines, attackerMutations:{hpDelta:0}, instantKill:true };
      } else {
        // Above 20% — the shared nextAttack path applies ×1.7 exactly once.
        reaperUltHeal=true;
        ub.type="nextAttack";
        ub.multiplier=1.7; // The shared nextAttack consumer applies the multiplier exactly once.
        specialLines.push("🌑 Reaper ULT ×1.7 + 50% life steal");
      }
    }
    if (ub.type==="nextAttack" && ub.multiplier) {
      multiplier*=ub.multiplier; ignoreReduction=Math.max(0,Math.min(0.5,Number(ub.ignoreReduction)||0)); specialLines.push(`✨ ULT ×${ub.multiplier}`);
      if (attacker.species.name==="Orc"&&ub.recoil) { const r=Math.floor(finalDamage*multiplier*ub.recoil); attackerMutations.hpDelta-=r; specialLines.push(`💥 Recoil -${r}`); }
      if (attacker.species.name==="Bot"&&ub.recoil) { const r=Math.floor(finalDamage*multiplier*ub.recoil); attackerMutations.hpDelta-=r; specialLines.push(`🤖 Overheat -${r}`); }
      if (attacker.species.name==="Angel"&&ub.angelHeal) { const h=Math.floor(attacker.currentHp*0.35); attackerMutations.hpDelta+=h; specialLines.push(`👼 Divine Blessing +${h}`); }
      if (ub.healSelf&&ub.healAmount) { attackerMutations.hpDelta+=ub.healAmount; specialLines.push(`🩸 Heal +${ub.healAmount}`); }
      if (ub.curse&&ub.curseRounds) { defender.curse=(defender.curse||0)+ub.curse; defender.curseRounds=ub.curseRounds; specialLines.push(`👿 Curse applied`); }
      if (ub.burn&&ub.burnRounds) { defender.burn=(defender.burn||0)+ub.burn; defender.burnRounds=Math.max(defender.burnRounds||0,ub.burnRounds); specialLines.push(`🔥 Burn +${ub.burn}`); }
      if (ub.bleed&&ub.bleedRounds) { defender.bleed=Math.max(Number(defender.bleed)||0,Number(ub.bleed)||0); defender.bleedRounds=Math.max(Number(defender.bleedRounds)||0,Number(ub.bleedRounds)||0); specialLines.push(`🩸 Bleed +${ub.bleed} for ${ub.bleedRounds} ticks`); }
      ultimateLifeSteal=Math.max(0,Math.min(1,Number(ub.lifeSteal)||0));
      attacker.ultBuff=null;
    } else if (ub.type==="buff"&&ub.attack) {
      multiplier*=ub.attack; specialLines.push(`💪 ULT Buff +${Math.round((ub.attack-1)*100)}%`);
      ub.duration--; if(ub.duration<=0) attacker.ultBuff=null;
    } else if (ub.type==="thunderActive") {
      specialLines.push("⚡ Thunder Surge: paralysis is active; no damage multiplier."); attacker.ultBuff=null;
    } else if (ub.type==="trueDragonSuppression") {
      multiplier*=0.8; specialLines.push("🐉 Dragon Spirit Suppression -20% attack");
      ub.duration--; if(ub.duration<=0) attacker.ultBuff=null;
    }
  }

  // Opponent-applied ULT effects are tracked separately from the combatant's own ULT buff,
  // so effects such as True Dragon suppression can coexist with Slime Lord assimilation.
  if (Array.isArray(attacker.ultDebuffs) && attacker.ultDebuffs.length) {
    for (const effect of attacker.ultDebuffs) {
      if (effect?.type === "trueDragonSuppression" && Number(effect.duration) > 0) {
        multiplier *= 0.8;
        specialLines.push("🐉 Dragon Spirit Suppression -20% attack");
        effect.duration = Math.max(0, Number(effect.duration) - 1);
      }
    }
    attacker.ultDebuffs = attacker.ultDebuffs.filter(effect => effect && Number(effect.duration) > 0);
  }

  // Defender reductions
  const isArchdemon = attacker.species.name==="Archdemon";
  if (!isArchdemon) {
    if (defender.species.name==="Demon King")  { multiplier*=1-(0.1*(1-ignoreReduction));  specialLines.push("Fear Aura -10%"); }
    if (defender.species.name==="Oni")         { multiplier*=1-(0.1*(1-ignoreReduction));  specialLines.push("Demonic Resilience -10%"); }
    if (defender.species.name==="Demi God")    { multiplier*=1-(0.15*(1-ignoreReduction)); specialLines.push("Divine Shield -15%"); }
    if (defender.species.name==="Earth Dragon"){ multiplier*=1-(0.15*(1-ignoreReduction)); specialLines.push("Stone Skin -15%"); }
  }
  if (defender.species.name==="True Dragon") { multiplier*=1-(0.2*(1-ignoreReduction)); specialLines.push("🐉 Dragon Spirit Haki -20% incoming damage"); }
  if (defender.species.name==="Eclipsed Sovereign" && defender.currentHp<defender.maxHp*0.5) { multiplier*=1-(0.1*(1-ignoreReduction)); specialLines.push("🌘 Hybrid Instinct -10%"); }
  if (defender.ultBuff?.type==="cyborgArmor") {
    multiplier*=1-(0.15*(1-ignoreReduction)); specialLines.push("🤖 Cyborg Armor -15%");
    defender.ultBuff.duration--; if(defender.ultBuff.duration<=0) defender.ultBuff=null;
  }
  if (defender.ultBuff?.type==="damageReduction") {
    multiplier*=1-(Math.max(0,Math.min(1,Number(defender.ultBuff.amount)||0))*(1-ignoreReduction)); specialLines.push(`⚡ Shield -${defender.ultBuff.amount*100}%`);
    defender.ultBuff.duration--; if(defender.ultBuff.duration<=0) defender.ultBuff=null;
  }
  if (defender.ultBuff?.type==="earthDamageReduction") {
    multiplier*=1-(0.9*(1-ignoreReduction)); specialLines.push("🌍 Terra Shield -90%"); defender.ultBuff=null;
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
    const shadowRange=speciesAttackBounds(attacker.species,attacker.isEventBoss===true);
    const s=Math.floor(Math.random()*(shadowRange.max-shadowRange.min+1))+shadowRange.min;
    finalDamage+=s; specialLines.push(`🎭 Shadow Dance +${s}`);
  }

  finalDamage = Math.max(0, Math.floor(finalDamage*multiplier));
  if (defender.species.name === "Chaos Creator" && finalDamage > 0) {
    finalDamage = Math.ceil(finalDamage * (0.5+0.5*ignoreReduction));
    specialLines.push("🌀 **ABSOLUTE AUTHORITY!** Incoming damage reduced by 50%.");
  }

  // Slime Lord converts the fully modified incoming hit into healing and reflects overflow.
  const assimilation=absorbSlimeLordDamage(attacker, defender, finalDamage, specialLines);
  if (assimilation) return { damage:0, baseDamage, specialLines, attackerMutations, missedAttack:false, absorbed:true };

  // Post-damage attacker heals
  if (finalDamage>0) {
    if (attacker.species.name==="Reaper") {
      const passiveHeal=Math.floor(finalDamage*0.3);
      const ultimateHeal=reaperUltHeal?Math.floor(finalDamage*0.5):0;
      attackerMutations.hpDelta+=passiveHeal+ultimateHeal;
      specialLines.push(`🌑 Soul Reaper +${passiveHeal}`);
      if(ultimateHeal>0) specialLines.push(`🌑 Death Judgment lifesteal +${ultimateHeal}`);
    }
    if(ultimateLifeSteal>0) {
      const leech=Math.floor(finalDamage*ultimateLifeSteal);
      attackerMutations.hpDelta+=leech;
      specialLines.push(`🐺 Lunar Rend life leech +${leech} HP (${Math.round(ultimateLifeSteal*100)}% of damage).`);
    }
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
  if (attacker.species.name==="Half-Blood"&&finalDamage>0&&attacker.id)
    setTimeout(()=>updateHalfBloodProgress(attacker.id,"damage",finalDamage),0);

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

function processBleedTick(combatant) {
  if(!combatant.bleed||combatant.bleed<=0||!combatant.bleedRounds||combatant.bleedRounds<=0) return {bled:0,lines:[]};
  const rawDamage=Math.max(0,Number(combatant.bleed)||0);
  const damage=combatant.species?.name==="Chaos Creator"?Math.ceil(rawDamage*0.5):rawDamage;
  combatant.currentHp=Math.max(0,combatant.currentHp-damage);
  combatant.bleedRounds=Math.max(0,Number(combatant.bleedRounds)-1);
  if(combatant.bleedRounds<=0) combatant.bleed=0;
  return {bled:damage,lines:["🩸 Bleed deals "+damage+" damage"]};
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
      const rawDamage=Math.floor(defender.maxHp*0.5);
      const dmg=defender.species.name==="Chaos Creator" ? Math.ceil(rawDamage*0.5) : rawDamage;
      const heal=Math.floor(attacker.maxHp*0.5);
      attacker.currentHp=Math.min(attacker.maxHp,attacker.currentHp+heal);
      const assimilationLines=[];
      const assimilation=absorbSlimeLordDamage(attacker,defender,dmg,assimilationLines);
      if (assimilation) {
        msg="⚖️ **DIVINE JUDGMENT!** God heals +" + heal + " HP. " + assimilationLines.join(" ");
      } else {
        defender.currentHp-=dmg;
        msg=`⚖️ **DIVINE JUDGMENT!**\n-${dmg} to opponent | +${heal} to you!`;
      }
      break;
    }
    case "Angel":       requiresChoice=true; choiceType="angel"; msg="👼 **DIVINE BLESSING!**\nChoose your path:"; break;
    case "Ice Dragon":  requiresChoice=true; choiceType="ice_dragon"; msg="❄️ **GLACIAL SPIKE!**\nChoose your path:"; break;
    case "Earth Dragon":requiresChoice=true; choiceType="earth_dragon"; msg="🌍 **TERRA SHIELD!**\nChoose Terra Strike (1.4× next attack) or Terra Shield (90% damage reduction for the next hit):"; break;
    case "Reaper": {
      if(defender.currentHp<=defender.maxHp*0.2) {
        const killDamage=Math.max(0,Number(defender.currentHp)||0);
        if(defender.species.name==="Chaos Creator") {
          const reducedDamage=Math.ceil(killDamage*0.5);
          defender.currentHp=Math.max(0,defender.currentHp-reducedDamage);
          const lifeSteal=Math.floor(reducedDamage*0.5);
          attacker.currentHp=Math.min(attacker.maxHp,attacker.currentHp+lifeSteal);
          msg="🌀 **ABSOLUTE AUTHORITY!** Death's Judgment is reduced by 50% against Chaos Creator. -" + reducedDamage + " HP; +" + lifeSteal + " life steal.";
        } else {
          const assimilationLines=[],assimilation=absorbSlimeLordDamage(attacker,defender,killDamage,assimilationLines);
          if(assimilation) msg="🌑 **DEATH'S JUDGMENT ABSORBED!** " + assimilationLines.join(" ");
          else {
            defender.currentHp=0;
            const lifeSteal=Math.floor(killDamage*0.5);
            attacker.currentHp=Math.min(attacker.maxHp,attacker.currentHp+lifeSteal);
            msg="💀 **DEATH'S JUDGMENT — INSTANT KILL!** The target was at or below 20% HP and was executed immediately. +" + lifeSteal + " HP.";
          }
        }
        attacker.ultBuff=null;
      } else {
        attacker.ultBuff={type:"reaperKill",multiplier:1.7};
        msg="🌑 **DEATH'S JUDGMENT!**\nAbove 20% HP: 1.7× damage on your next attack.";
      }
      break;
    }
    case "Fire Dragon": attacker.ultBuff={type:"nextAttack",multiplier:1.7,burn:10,burnRounds:2}; msg="🔥 **INFERNO BLAST!**\n1.7× + 10 burn 2 rounds!"; break;
    case "Thunder Dragon": attacker.ultBuff={type:"thunderActive"}; defender.stunnedTurns=Math.max(2,Number(defender.stunnedTurns)||0); msg="⚡ **THUNDER SURGE!**\nparalyzes the opponent for 2 turns, granting you two extra turns!"; break;
    case "Bot":         attacker.ultBuff={type:"nextAttack",multiplier:2,recoil:0.25}; msg="💻 **SYSTEM OVERLOAD!**\n2× + 25% recoil!"; break;
    case "Cyborg": {
      const h=Math.floor(attacker.maxHp*0.3);
      attacker.currentHp=Math.min(attacker.maxHp,attacker.currentHp+h);
      attacker.ultBuff={type:"cyborgArmor",duration:2};
      msg=`🤖 **SELF-REPAIR!**\nHealed ${h} HP + 15% dmg reduction 2 turns!`; break;
    }
    case "Half-Blood":  attacker.ultBuff={type:"nextAttack",multiplier:1.4,healSelf:true,healAmount:10}; msg="🩸 **AWAKENED BLOOD!**\n1.4× + heal 10 HP!"; break;
    case "Eclipsed Sovereign": attacker.ultBuff={type:"nextAttack",multiplier:1.8,healSelf:true,healAmount:15}; msg="🌘 **BLOODLINE OVERDRIVE!**\n1.8× next attack + heal 15 HP!"; break;
    case "Mechangel": {
      const h=Math.floor(attacker.maxHp*0.4);
      attacker.currentHp=Math.min(attacker.maxHp,attacker.currentHp+h);
      attacker.ultBuff={type:"damageReduction",amount:0.2,duration:2};
      msg=`⚡ **SYSTEM RESTORATION!**\nHealed ${h} HP + 20% reduction 2 turns!`; break;
    }
    case "Archdemon":   attacker.ultBuff={type:"nextAttack",multiplier:2.0,curse:10,curseRounds:3}; msg="👿 **ABYSSAL GATE!**\n2× + 10 curse 3 turns!"; break;
    case "Slime Lord":  attacker.ultBuff={type:"slimeAssimilation"}; msg="🫧 **PREDATORY ASSIMILATION!**\nConvert the next incoming hit into HP; reflect any overflow beyond max HP."; break;
    case "Werewolf": attacker.ultBuff={type:"nextAttack",multiplier:2,bleed:12,bleedRounds:3,lifeSteal:0.6}; msg="🐺 **LUNAR REND!**\n×2 next attack + 12 Bleed damage for 3 ticks + 60% life leech!"; break;
    case "True Dragon":
      attacker.ultBuff={type:"nextAttack",multiplier:2,ignoreReduction:0.1};
      if (!Array.isArray(defender.ultDebuffs)) defender.ultDebuffs = [];
      const existingSuppression = defender.ultDebuffs.find(effect => effect?.type === "trueDragonSuppression");
      if (existingSuppression) existingSuppression.duration = Math.max(Number(existingSuppression.duration) || 0, 1);
      else defender.ultDebuffs.push({type:"trueDragonSuppression",duration:1});
      msg="🐉 **FOURFOLD CATACLYSM!**\nYour next attack deals 2× damage and bypasses 10% of enemy damage reduction. The opponent’s next attack is suppressed by 20%.";
      break;
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
      .replace(/\s*[—–]\s*/g, ": ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/\b(for|deals?|heals?|healed|damage|burn|curse|HP:?)\s+(\d+(?:\.\d+)?(?:\/\d+)?%?)/gi, (match, label, amount) => label + " " + inlineCode(amount))
      .replace(/\bRound\s+(\d+)\b/gi, (match, round) => "Round " + inlineCode(round)))
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
  for (const effect of Array.isArray(p.ultDebuffs) ? p.ultDebuffs : []) {
    if (effect?.type === "trueDragonSuppression" && Number(effect.duration) > 0)
      parts.push("🐉 Attack suppressed " + inlineCode("-20% × " + effect.duration));
  }
  if (p.burn > 0)       parts.push("🔥 Burn " + inlineCode(p.burn + " × " + p.burnRounds));
  if (p.bleed > 0)      parts.push("🩸 Bleed " + inlineCode(p.bleed + " × " + p.bleedRounds));
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
  const p1Name = p1.displayName || "Player 1";
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
      new ButtonBuilder().setCustomId("pvp_choice_earth_attack_" + fightId).setLabel("Terra Strike (1.4×)").setStyle(ButtonStyle.Danger),
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
  for (const effect of Array.isArray(fight.playerUltDebuffs) ? fight.playerUltDebuffs : []) {
    if (effect?.type === "trueDragonSuppression" && Number(effect.duration) > 0) playerEffects.push("🐉 Attack suppressed (-20%)");
  }
  if ((fight.playerBurn || 0) > 0) playerEffects.push("🔥 Burn " + inlineCode(fight.playerBurn + " × " + fight.playerBurnRounds));
  if ((fight.playerBleed || 0) > 0) playerEffects.push("🩸 Bleed " + inlineCode(fight.playerBleed + " × " + fight.playerBleedRounds));
  if (fight.botUltBuff) botEffects.push("✦ Ultimate " + inlineCode(fight.botUltBuff.type));
  for (const effect of Array.isArray(fight.botUltDebuffs) ? fight.botUltDebuffs : []) {
    if (effect?.type === "trueDragonSuppression" && Number(effect.duration) > 0) botEffects.push("🐉 Attack suppressed (-20%)");
  }
  if ((fight.botBurn || 0) > 0) botEffects.push("🔥 Burn " + inlineCode(fight.botBurn + " × " + fight.botBurnRounds));
  if ((fight.botBleed || 0) > 0) botEffects.push("🩸 Bleed " + inlineCode(fight.botBleed + " × " + fight.botBleedRounds));
  const logs = cleanFightLog(logLines);
  const playerName = fight.playerName || "You";
  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## ⚔️ LOZ ARENA  ·  " + (fight.isSlimeBoss ? "🫧 SLIME LORD BOSS" : (personality.emoji ? personality.emoji + " " : "☠️ ") + personality.name.toUpperCase()) + "  ·  ROUND " + inlineCode(fight.round)))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "🟢 **YOUR SIDE**  ·  **" + playerName + "**\n" +
      "**" + speciesLabel(fight.playerSpecies) + "**\n" + formatFightHealth(fight.playerHp, fight.playerMaxHp) + "\n" + (playerEffects.length ? playerEffects.join("  ·  ") : "No active effects")
    ))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "🔻 **OPPONENT**  ·  **" + (fight.isSlimeBoss ? "SLIME LORD BOSS" : "LOZ") + "**\n" +
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
      new ButtonBuilder().setCustomId("botfight_choice_earth_attack_" + fightId).setLabel("Terra Strike (1.4×)").setStyle(ButtonStyle.Danger),
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
  else {
    const rematchRow = buildBotFightRematchRow(fight);
    if (rematchRow) components.push(rematchRow);
  }
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], users: phase === "bot_thinking" || phase === "ended" ? [] : [fight.playerId] },
    components,
  };
}

function buildBotFightRematchRow(fight) {
  if (!fight?.allowRematch || fight.isEventBoss) return null;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("botfight_again_" + fight.playerId + "_" + fight.difficulty)
      .setLabel("Fight Again")
      .setStyle(ButtonStyle.Primary)
  );
}

function buildFightResultPayload(header, body, color, mentionIds = [], extraComponents = []) {
  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], users: mentionIds },
    components: [
      new TextDisplayBuilder().setContent(header),
      container,
      ...(Array.isArray(extraComponents) ? extraComponents.filter(Boolean) : []),
    ],
  };
}

module.exports = {
  makeCombatant, calculateDamage,
  processBurnTick, processBleedTick, processCurseTick, tickCooldowns, tickBothUltCooldowns, applyOgreRegen,
  applyUltEffect,
  getBuffLine, buildFightEmbed, buildFightRow, buildFightMessagePayload,
  buildBotFightEmbed, buildBotFightRow, buildBotFightMessagePayload, buildBotFightRematchRow,
  buildFightResultPayload, formatFightHealth, cleanFightLog,
};
