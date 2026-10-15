"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const constants = require("../constants.js");
const helpers = require("../helpers.js");
const combat = require("../combat.js");
const questSystem = require("../quest-system.js");
const achievements = require("../achievements.js");
const { commands } = require("../commands.js");

function uniqueByName(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item || !item.name || seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

const playableSpecies = uniqueByName([
  constants.humanSpecies,
  ...constants.speciesList,
  ...constants.dragonSpecies.types.map((entry) => helpers.getSpeciesByName(entry.type + " Dragon")),
  constants.godSpecies,
  constants.reaperSpecies,
  constants.archdemonSpecies,
  constants.slimeLordSpecies,
  constants.eclipsedSovereignSpecies,
  constants.chaosCreatorSpecies,
  constants.trueDragonSpecies,
]);
const combatRoster = uniqueByName([
  ...playableSpecies,
  constants.botSpecies.bot,
  constants.botSpecies.kitsune,
]);

// Combat can schedule awakening-progress updates; an empty state isolates tests
// from the live database and all production player records.
helpers.setState({ userSpecies: new Map() });

test("all playable and NPC species resolve to complete, valid combat stats", () => {
  assert.ok(playableSpecies.length >= 25, "the roster should cover the full playable species catalog");
  for (const species of combatRoster) {
    assert.ok(helpers.getSpeciesByName(species.name), species.name + " must resolve by name");
    for (const key of ["hp", "atkMin", "atkMax", "healMin", "healMax", "ultCooldown"]) {
      assert.ok(Number.isFinite(Number(species[key])), species.name + " must define numeric " + key);
    }
    assert.ok(species.hp > 0, species.name + " HP must be positive");
    assert.ok(species.atkMin >= 0 && species.atkMax >= species.atkMin, species.name + " attack range is invalid");
    assert.ok(species.healMin >= 0 && species.healMax >= species.healMin, species.name + " healing range is invalid");
    assert.ok(species.ultCooldown >= 0, species.name + " cooldown cannot be negative");
  }
});

test("every playable species has registered passive and ultimate descriptions", () => {
  for (const species of playableSpecies) {
    assert.notEqual(constants.getPassiveDescription(species.name), "Unknown passive", species.name + " passive description is missing");
    assert.notEqual(constants.getActiveDescription(species.name), "Unknown active", species.name + " ultimate description is missing");
  }
});

test("every species can cast its ultimate without throwing", () => {
  // Human is a safe target for all ultimate handlers, including Chimera's copied ultimate.
  for (const species of combatRoster) {
    const attacker = combat.makeCombatant("test-attacker", species);
    const defender = combat.makeCombatant("test-defender", constants.humanSpecies);
    const outcome = combat.applyUltEffect(attacker, defender);
    assert.equal(typeof outcome.message, "string", species.name + " ultimate should return a message");
    assert.ok(outcome.message.length > 0, species.name + " ultimate message must not be empty");
    assert.equal(typeof outcome.requiresChoice, "boolean", species.name + " choice flag must be boolean");
  }
});

test("all ordered species matchups produce finite, non-negative damage", () => {
  const originalRandom = Math.random;
  Math.random = () => 0.999999;
  try {
    for (const attackerSpecies of combatRoster) {
      for (const defenderSpecies of combatRoster) {
        const attacker = combat.makeCombatant("attacker", attackerSpecies);
        const defender = combat.makeCombatant("defender", defenderSpecies);
        const outcome = combat.calculateDamage(attacker, defender);
        assert.ok(Number.isFinite(outcome.damage), attackerSpecies.name + " vs " + defenderSpecies.name + " damage must be finite");
        assert.ok(outcome.damage >= 0, attackerSpecies.name + " vs " + defenderSpecies.name + " damage cannot be negative");
        assert.ok(Number.isFinite(attacker.currentHp) && Number.isFinite(defender.currentHp),
          attackerSpecies.name + " vs " + defenderSpecies.name + " must keep HP finite");
      }
    }
  } finally {
    Math.random = originalRandom;
  }
});

test("True Dragon stats, abilities, and Brutal-bot availability match the specification", () => {
  const dragon = helpers.getSpeciesByName("True Dragon");
  assert.deepEqual(
    [dragon.hp, dragon.atkMin, dragon.atkMax, dragon.healMin, dragon.healMax, dragon.ultCooldown],
    [200, 32, 42, 18, 28, 9]
  );
  assert.ok(constants.botSpeciesByDifficulty.brutal.includes("True Dragon"));
  assert.match(constants.getPassiveDescription("True Dragon"), /Dragon Spirit Haki/i);
  assert.match(constants.getPassiveDescription("True Dragon"), /Universal Perception/i);
  assert.match(constants.getActiveDescription("True Dragon"), /Fourfold Cataclysm/i);
});

test("True Dragon Haki reduces a normal incoming strike by 20 percent", () => {
  const originalRandom = Math.random;
  Math.random = () => 0.999999;
  try {
    const human = combat.makeCombatant("human", constants.humanSpecies);
    const dragon = combat.makeCombatant("dragon", constants.trueDragonSpecies);
    const outcome = combat.calculateDamage(human, dragon);
    assert.equal(outcome.damage, 8);
    assert.ok(outcome.specialLines.some((line) => /Dragon Spirit Haki/i.test(line)));
  } finally {
    Math.random = originalRandom;
  }
});

test("Universal Perception sees through a dodge effect", () => {
  const originalRandom = Math.random;
  Math.random = () => 0.999999;
  try {
    const dragon = combat.makeCombatant("dragon", constants.trueDragonSpecies);
    const defender = combat.makeCombatant("defender", constants.humanSpecies);
    defender.ultBuff = { type: "dodge", duration: 1 };
    const outcome = combat.calculateDamage(dragon, defender);
    assert.ok(outcome.damage > 0);
    assert.ok(outcome.specialLines.some((line) => /Universal Perception/i.test(line)));
  } finally {
    Math.random = originalRandom;
  }
});

test("Fourfold Cataclysm empowers one 2x strike and suppresses the opponent's next attack", () => {
  const originalRandom = Math.random;
  Math.random = () => 0.999999;
  try {
    const dragon = combat.makeCombatant("dragon", constants.trueDragonSpecies);
    const opponent = combat.makeCombatant("opponent", constants.humanSpecies);
    combat.applyUltEffect(dragon, opponent);
    const strike = combat.calculateDamage(dragon, opponent);
    assert.equal(strike.damage, 84);
    assert.equal(dragon.ultBuff, null);

    const victim = combat.makeCombatant("victim", constants.humanSpecies);
    const suppressed = combat.calculateDamage(opponent, victim);
    assert.equal(suppressed.damage, 8);
    assert.equal(opponent.ultBuff, null);
  } finally {
    Math.random = originalRandom;
  }
});

test("Fourfold Cataclysm bypasses 10 percent of the target's damage reduction", () => {
  const originalRandom = Math.random;
  Math.random = () => 0.999999;
  try {
    const dragon = combat.makeCombatant("dragon", constants.trueDragonSpecies);
    const earthDragon = combat.makeCombatant("earth", helpers.getSpeciesByName("Earth Dragon"));
    combat.applyUltEffect(dragon, earthDragon);
    const outcome = combat.calculateDamage(dragon, earthDragon);
    assert.equal(outcome.damage, 72,
      "42 max ATK × 2 damage × (1 - 15% Stone Skin × 90% after bypass) should floor to 72");
    assert.ok(outcome.specialLines.some((line) => /Stone Skin -15%/i.test(line)));
  } finally {
    Math.random = originalRandom;
  }
});

test("Mechangel cooldown and rotating-quest interval match 6.0, without changing vote cadence", () => {
  assert.equal(helpers.getSpeciesByName("Mechangel").ultCooldown, 9);
  assert.equal(questSystem.QUEST_INTERVAL_MS, 6 * 60 * 60 * 1000);
  assert.equal(questSystem.VOTE_INTERVAL_MS, 12 * 60 * 60 * 1000,
    "the Top.gg vote interval is separate from the rotating quest interval");
});

test("slash-command registration retains /quests and combined /fight stats, with no root /quest", () => {
  const roots = commands.map((command) => command.name);
  assert.ok(roots.includes("quests"));
  assert.ok(!roots.includes("quest"));
  assert.ok(!roots.includes("botstats"));
  assert.ok(!roots.includes("fightstats"));
  const fight = commands.find((command) => command.name === "fight");
  assert.ok(fight.options.some((option) => option.name === "stats"));
  assert.ok(fight.options.some((option) => option.name === "bot"));
});

test("True Dragon is present in owner unlock, owner species-change flow, and /switch", () => {
  const owner = commands.find((command) => command.name === "owner");
  const unlock = owner.options.find((option) => option.name === "species-unlock");
  const choices = unlock.options.find((option) => option.name === "species").choices;
  assert.ok(choices.some((choice) => choice.value === "True Dragon"));
  const change = owner.options.find((option) => option.name === "species-change");
  assert.equal(change.options.find((option) => option.name === "species").autocomplete, true);
  const source = fs.readFileSync(path.join(__dirname, "..", "commands.js"), "utf8");
  assert.ok(source.includes('id:"switch_true_dragon"'));
  assert.ok(source.includes('customId==="switch_true_dragon"'));
  assert.ok(source.includes('else if (spname==="True Dragon")'));
});

test("player ultimates feed Glory counters in PvP and bot fights", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "commands.js"), "utf8");
  assert.ok(source.includes("achievementSystem.recordUltimate(user.id,fight.playerSpecies)"),
    "player ultimate in bot fights must update the achievement profile");
  assert.ok(source.includes("achievementSystem.recordUltimate(player.id,player.species)"),
    "player ultimate in PvP must update the achievement profile");
});

test("Glory leaderboard never creates or assigns Discord roles and cleans up legacy roles", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "achievements.js"), "utf8");
  assert.ok(!source.includes("guild.roles.create"), "the leaderboard must not create Discord roles");
  assert.ok(!source.includes("member.roles.add"), "the leaderboard must not assign Discord roles");
  assert.ok(!source.includes("syncGloryRoles"), "the former recurring role-sync function must stay removed");
  assert.ok(source.includes("async function removeLegacyGloryRoles"),
    "startup should remove roles created by the retired feature");
  assert.ok(source.includes("role.delete(\"LOZ no longer uses Discord roles for the Glory leaderboard\")"));
  assert.ok(source.includes("/^LOZ Glory (#(?:[1-9]|10)|Top 25)$/"),
    "cleanup must be limited to role names produced by the old feature");
  assert.ok(!source.includes("Rank-specific roles go to the Top 10"));
});

test("6.0 broadcast includes the Halloween announcement without owner-command details", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "commands.js"), "utf8");
  const start = source.indexOf("function buildLoz60AnnouncementPayload()");
  assert.notEqual(start, -1);
  const end = source.indexOf("\n}\n", start);
  const broadcastPayload = source.slice(start, end + 2);
  assert.match(broadcastPayload, /Halloween update drops next week/i);
  assert.match(broadcastPayload, /tricks or treats/i);
  assert.ok(!broadcastPayload.includes("/owner"));
  assert.ok(!broadcastPayload.includes("/updates reward"));
  assert.ok(!broadcastPayload.includes("/broadcast"));
  const note = constants.patchNotes.find((entry) => entry.version === "6.0");
  assert.ok(note, "6.0 patch notes should exist");
  const noteText = JSON.stringify(note.changes).toLowerCase();
  assert.ok(!noteText.includes("/owner"));
  assert.ok(!noteText.includes("/updates reward"));
  assert.ok(!noteText.includes("/broadcast"));
  assert.ok(!noteText.includes("owner command"));
});


test("LOZ 6.0 registration prompt is never automatically posted after a slash command", () => {
  const commandsSource = fs.readFileSync(path.join(__dirname, "..", "commands.js"), "utf8");
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.ok(!commandsSource.includes("function maybePromptForLoz60Event"),
    "the dedicated per-user automatic event prompt must be removed");
  assert.ok(!commandsSource.includes("function buildLoz60EventPayload"),
    "the automatic registration-card builder must be removed");
  assert.ok(!indexSource.includes("maybePromptForLoz60Event"),
    "the interaction handler must not trigger the registration prompt");
  assert.ok(!commandsSource.includes('setLabel("Register for LOZ 6.0")'),
    "no new event registration prompt should be constructed");
  assert.ok(indexSource.includes("await maybePromptForUpdates(interaction)"),
    "the separate optional major-update subscription prompt remains intact");
});

test("legacy Glory Discord roles are deleted and the leaderboard never assigns roles again", async () => {
  const deleted = [];
  const roleNames = [
    "LOZ Glory #1",
    "LOZ Glory #10",
    "LOZ Glory Top 25",
    "LOZ Glory #11",
    "LOZ Fight Wins #1",
  ];
  const roles = roleNames.map((name) => ({
    name,
    delete: async (reason) => { deleted.push({ name, reason }); },
  }));
  const guild = {
    id: "test-guild",
    roles: {
      fetch: async () => new Map(roles.map((role, index) => [String(index), role])),
    },
  };
  const client = { guilds: { cache: new Map([["test-guild", guild]]) } };

  await achievements.removeLegacyGloryRoles(client);

  assert.deepEqual(
    deleted.map((entry) => entry.name).sort(),
    ["LOZ Glory #1", "LOZ Glory #10", "LOZ Glory Top 25"].sort(),
    "only the exact legacy Top 10 / Top 25 Glory roles should be deleted"
  );
  assert.ok(deleted.every((entry) => entry.reason.includes("no longer uses Discord roles")));

  const source = fs.readFileSync(path.join(__dirname, "..", "achievements.js"), "utf8");
  assert.ok(!source.includes("syncGloryRoles"), "role synchronization must stay removed");
  assert.ok(!source.includes("guild.roles.create"), "the Glory leaderboard must never create roles");
  assert.ok(!source.includes("member.roles.add"), "the Glory leaderboard must never assign roles");
  assert.ok(source.includes("GLORY_TOP25"), "profile leaderboard badges should remain available");
});


test("Normal and Species achievement pages support Claim All with detailed reward summaries", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "achievements.js"), "utf8");
  assert.ok(source.includes("ach:claim-all-normal:"), "normal achievement pages need a Claim All button action");
  assert.ok(source.includes("ach:claim-all-species:"), "species detail pages need a Claim All button action");
  assert.ok(source.includes('setLabel("Claim All")'), "both achievement sections should expose a Claim All button");
  assert.ok(source.includes("function formatClaimSummary"), "bulk claims should report each completed reward");
  assert.ok(source.includes('def.description+" Target: "+targetValue'), "normal reward details should include the reached milestone target");
  assert.ok(source.includes("function buildSpeciesTasks"), "species tasks should share eligibility logic for display and batch claims");
  assert.ok(source.includes("async function applyDragonAwakening"), "batch claiming must preserve dragon awakening side effects");
});

test("achievement claim summary shows each reward and a combined Glory total", () => {
  const summary = achievements.formatClaimSummary([
    { title: "Daily Devotion", detail: "Reach a 7-day streak", reward: 2 },
    { title: "Elemental Mastery", detail: "Use your ultimate twice", reward: 3 },
  ]);
  assert.match(summary, /Claimed 2 achievement rewards/);
  assert.match(summary, /\+5 Glory/);
  assert.match(summary, /Daily Devotion/);
  assert.match(summary, /Reach a 7-day streak/);
  assert.match(summary, /\+2 Glory/);
  assert.match(summary, /Elemental Mastery/);
  assert.match(summary, /Use your ultimate twice/);
  assert.match(summary, /\+3 Glory/);
});
