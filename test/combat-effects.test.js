"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const constants = require("../constants.js");
const combat = require("../combat.js");

test("True Dragon suppression does not overwrite Slime Lord's active ULT", () => {
  const slimeLord = combat.makeCombatant("slime", constants.slimeLordSpecies);
  const trueDragon = combat.makeCombatant("dragon", constants.trueDragonSpecies);

  combat.applyUltEffect(slimeLord, trueDragon);
  assert.equal(slimeLord.ultBuff?.type, "slimeAssimilation");

  combat.applyUltEffect(trueDragon, slimeLord);
  assert.equal(slimeLord.ultBuff?.type, "slimeAssimilation");
  assert.equal(slimeLord.ultDebuffs.length, 1);
  assert.equal(slimeLord.ultDebuffs[0].type, "trueDragonSuppression");

  const suppressedAttack = combat.calculateDamage(slimeLord, trueDragon);
  assert.ok(suppressedAttack.specialLines.some(line => line.includes("Dragon Spirit Suppression -20%")));
  assert.equal(slimeLord.ultBuff?.type, "slimeAssimilation");
  assert.equal(slimeLord.ultDebuffs.length, 0);

  const absorbedHit = combat.calculateDamage(trueDragon, slimeLord);
  assert.equal(absorbedHit.absorbed, true);
});

test("rematch button is shown for eligible regular bot results but never for boss results", () => {
  const regularFight = {
    playerId: "123456789012345678",
    playerSpecies: constants.slimeLordSpecies,
    playerHp: 50,
    playerMaxHp: constants.slimeLordSpecies.hp,
    playerUltCooldown: 0,
    playerHealCooldown: 0,
    botSpecies: constants.botSpecies.bot,
    botHp: 0,
    botMaxHp: constants.botSpecies.bot.hp,
    difficulty: "brutal",
    round: 4,
    allowRematch: true,
  };
  assert.equal(combat.buildBotFightMessagePayload(regularFight, [], "ended").components.length, 3);
  assert.equal(combat.buildBotFightMessagePayload({...regularFight, isEventBoss:true}, [], "ended").components.length, 2);
  assert.equal(combat.buildBotFightMessagePayload({...regularFight, allowRematch:false}, [], "ended").components.length, 2);
});
