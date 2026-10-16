"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PermissionsBitField } = require("discord.js");
const fs = require("node:fs");
const path = require("node:path");

const constants = require("../constants.js");
const helpers = require("../helpers.js");
const combat = require("../combat.js");
const questSystem = require("../quest-system.js");
const achievements = require("../achievements.js");
const { commands, setState: setCommandState, handleCommand } = require("../commands.js");

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

test("player ultimates are buffered until a fight resolves, then update Glory counters", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "commands.js"), "utf8");
  const progressSource = fs.readFileSync(path.join(__dirname, "..", "fight-progress.js"), "utf8");
  assert.ok(source.includes('addFightProgress(fight,user.id,"ults",1)'),
    "bot-fight ultimate uses should be buffered until the outcome is known");
  assert.ok(source.includes('addFightProgress(fight,player.id,"ults",1)'),
    "PvP ultimate uses should be buffered until the outcome is known");
  assert.ok(progressSource.includes("achievementSystem.recordUltimate(userId,species,ults)"),
    "resolved ultimate uses must still update the achievement profile");
  assert.ok(!source.includes("achievementSystem.recordUltimate(user.id,fight.playerSpecies)"));
  assert.ok(!source.includes("achievementSystem.recordUltimate(player.id,player.species)"));
});


test("owner species-change success replies are ephemeral", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "commands.js"), "utf8");
  const start = source.indexOf('if (sub==="species-change")');
  const end = source.indexOf('if (sub==="species-reset")', start);
  assert.ok(start >= 0 && end > start, "owner species-change handler should exist");
  const handler = source.slice(start, end);
  assert.match(handler, /createSuccessEmbed\(`Changed .* saved it to MongoDB!`\)\],flags:64\}\)/,
    "successful owner species changes must only be visible to the command user");
  assert.match(handler, /flags:64/, "validation and persistence errors should remain ephemeral too");
});

test("elemental Dragon awakening status exposes the three trials and True Dragon progress", () => {
  const userId = "123456789012345678";
  const userData = { awakening: { trueDragon: { variants: {
    fire: { awakened: true }, thunder: { awakened: true }, ice: { awakened: true }, earth: { awakened: false },
  } } } };
  const state = { userSpecies: new Map([[userId, userData]]) };
  const profile = {
    speciesCounters: {
      "Fire Dragon": { battles: 5, wins: 3, ults: 2 },
      "Thunder Dragon": { battles: 2, wins: 1, ults: 0 },
    },
    dragonClaims: { fire: { "0": true, "1": true, "2": true }, thunder: { "0": true } },
    dragonAwakened: { fire: true, thunder: true, ice: true },
  };
  const fire = achievements.buildDragonAwakeningStatus(userId, state, profile, "Fire");
  assert.equal(fire.ok, true);
  assert.equal(fire.speciesName, "Fire Dragon");
  assert.equal(fire.awakened, true);
  assert.equal(fire.allTrialsClaimed, true);
  assert.equal(fire.trials.length, 3);
  assert.deepEqual(fire.trials.map((trial) => [trial.value, trial.claimed]), [[5, true], [3, true], [2, true]]);
  assert.equal(fire.awakenedCount, 3);
  assert.equal(fire.allAwakened, false);
  assert.equal(fire.trueDragonUnlocked, false);

  const thunder = achievements.buildDragonAwakeningStatus(userId, state, profile, "Thunder");
  assert.equal(thunder.awakened, true);
  assert.equal(thunder.trials[0].value, 2);
  assert.equal(thunder.trials[0].claimed, true);
  assert.equal(thunder.trials[1].ready, false);
  assert.equal(thunder.awakenedCount, 3);

  const allAwakenedProfile = Object.assign({}, profile, { dragonAwakened: { fire: true, thunder: true, ice: true, earth: true } });
  const earth = achievements.buildDragonAwakeningStatus(userId, state, allAwakenedProfile, "Earth");
  assert.equal(earth.awakenedCount, 4);
  assert.equal(earth.allAwakened, true);
  assert.equal(earth.trueDragonUnlocked, true);
});

test("/awakening provides the elemental Dragon path instead of the unsupported-species message", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "commands.js"), "utf8");
  assert.ok(source.includes('const dragonType=["Fire","Thunder","Ice","Earth"].find'));
  assert.ok(source.includes("achievementSystem.getDragonAwakeningStatus(user.id,_state,dragonType)"));
  assert.ok(source.includes('Use /achievements to claim elemental trials and the awakening reward.'));
});

test("Glory leaderboard rows use proper Discord mentions and explicitly label the Glory total", () => {
  const row = achievements.formatLeaderboardRow({
    userId: "123456789012345678",
    glory: 1234,
  }, 4);
  assert.equal(
    row,
    "**#04** 🏅 **<@123456789012345678>** · <:Glory:1559650326011711579> **1,234 Glory**"
  );

  const invalidIdRow = achievements.formatLeaderboardRow({ userId: "not-a-discord-id", glory: 7 }, 11);
  assert.match(invalidIdRow, /Unknown Player/);
  assert.match(invalidIdRow, /7 Glory/);
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

test("6.1 patch notes describe safe progression and the community species event", () => {
  const latest = constants.patchNotes[0];
  assert.equal(latest.version, "6.1");
  const latestText = latest.changes.join("\n").toLowerCase();
  assert.ok(latestText.includes("forfeited pvp fights"));
  assert.ok(latestText.includes("damage dealt"));
  assert.ok(latestText.includes("build your own species"));
  assert.ok(latestText.includes("/owner species-unlock"));
  assert.ok(constants.patchNotes.some((entry) => entry.version === "6.0"),
    "older 6.0 patch notes must remain available");

  const commandsSource = fs.readFileSync(path.join(__dirname, "..", "commands.js"), "utf8");
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const fightsSource = fs.readFileSync(path.join(__dirname, "..", "fights.js"), "utf8");
  const achievementsSource = fs.readFileSync(path.join(__dirname, "..", "achievements.js"), "utf8");
  assert.ok(commandsSource.includes("Build Your Own Species"));
  assert.ok(commandsSource.includes('id:"switch_chaos_creator"'));
  assert.ok(commandsSource.includes('customId==="switch_chaos_creator"'));
  assert.ok(commandsSource.includes('{name:"Chaos Creator 🌀",value:"Chaos Creator"}'));
  assert.ok(commandsSource.includes("**Quick Access:**"));
  assert.ok(indexSource.includes("setRegisteredCommandIds(registered)"));
  assert.ok(!commandsSource.includes("at most once every 24 hours"));
  assert.ok(fightsSource.includes('if (reason!=="forfeit")'));
  assert.ok(fightsSource.includes("commitFightProgress(fight,fight.player1Id"));
  for (const key of ["battles","wins","damage","pvp-battles","bot-battles","ultimates"]) {
    assert.ok(achievementsSource.includes('key:"' + key + '"'), "missing species trial: " + key);
  }
});


test("legacy update subscriptions are removed while developer alerts remain", () => {
  const commandsSource = fs.readFileSync(path.join(__dirname, "..", "commands.js"), "utf8");
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.ok(!commandsSource.includes("maybePromptForUpdates"));
  assert.ok(!indexSource.includes("maybePromptForUpdates"));
  assert.ok(indexSource.includes("maybePromptForDeveloperAlert"),
    "the private developer alert flow must remain connected");
  assert.ok(commandsSource.includes("setRegisteredCommandIds"),
    "clickable slash-command mentions should use IDs from Discord registration");
  assert.ok(!commandsSource.includes("at most once every 24 hours"),
    "the reminder must not announce a 24-hour recurrence");
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


test("achievement claim buttons have unique IDs even when claimed or locked", () => {
  const buttons = [
    achievements.makeClaimButton("ach:claim-normal:123:daily-streak:0:0", false, true, 1),
    achievements.makeClaimButton("ach:claim-normal:123:total-wins:0:0", false, true, 1),
    achievements.makeClaimButton("ach:claim-species:123:human:0", false, false, 2),
    achievements.makeClaimButton("ach:claim-species:123:slime-lord:0", false, false, 3),
  ];
  const ids = buttons.map((button) => button.data.custom_id);
  assert.equal(new Set(ids).size, ids.length, "all component custom IDs must be unique");
  assert.ok(ids[0].startsWith("ach:claimed:"), "claimed buttons must retain the claimed routing prefix");
  assert.ok(ids[1].startsWith("ach:claimed:"), "each claimed button gets a unique routing ID");
  assert.ok(ids[2].startsWith("ach:locked:"), "locked buttons must retain the locked routing prefix");
  assert.ok(ids[3].startsWith("ach:locked:"), "each locked button gets a unique routing ID");
});


test("legacy prefix commands have slash replacements and LOZ no longer requests privileged intents", () => {
  const definitions = new Map(commands.map((command) => [command.name, command]));
  for (const name of ["disable-all", "enable-all", "disintegrate"]) {
    assert.ok(definitions.has(name), name + " must be registered as a slash command");
  }
  assert.ok(definitions.get("disable-all").default_member_permissions, "/disable-all must be administrator-only by default");
  assert.ok(definitions.get("enable-all").default_member_permissions, "/enable-all must be administrator-only by default");

  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const commandSource = fs.readFileSync(path.join(__dirname, "..", "commands.js"), "utf8");
  assert.doesNotMatch(indexSource, /GatewayIntentBits\.(?:MessageContent|GuildMembers)/, "Message Content and Guild Members intents should no longer be requested");
  assert.doesNotMatch(indexSource, /message\.content/, "message handlers must not read incoming message text");
  assert.match(indexSource, /message\.mentions\.users\.has\(client\.user\.id\)/, "mention-based help should still work without Message Content");
  assert.match(indexSource, /channelToggleCommand/, "disabled channels must allow /enable-all recovery");
  assert.match(commandSource, /title:"Server & Owner Tools"/, "the replacement commands should appear in /help");
});

test("/disable-all and /enable-all update channel state and reject non-administrators", async () => {
  const disabledChannels = new Set();
  setCommandState({
    disabledChannels,
    ownerId: "primary-owner",
    secondGodId: "secondary-owner",
    activeFights: new Map(),
    fightMessages: new Map(),
  });
  const responses = [];
  function makeInteraction(commandName, { channelId = "channel-1", isAdmin = true, userId = "server-admin" } = {}) {
    return {
      commandName,
      options: {},
      user: { id: userId },
      guild: { id: "guild-1" },
      channel: { id: channelId },
      inGuild: () => true,
      memberPermissions: {
        has: (permission) => isAdmin && permission === PermissionsBitField.Flags.Administrator,
      },
      isRepliable: () => true,
      reply: async (payload) => {
        responses.push(payload);
        return payload;
      },
    };
  }

  await handleCommand(makeInteraction("disable-all"));
  assert.equal(disabledChannels.has("channel-1"), true, "/disable-all must disable the current channel");
  assert.match(responses.at(-1).content, /disabled in/);

  await handleCommand(makeInteraction("enable-all"));
  assert.equal(disabledChannels.has("channel-1"), false, "/enable-all must restore a disabled channel");
  assert.match(responses.at(-1).content, /enabled in/);

  await handleCommand(makeInteraction("disable-all", { channelId: "channel-2", isAdmin: false }));
  assert.equal(disabledChannels.has("channel-2"), false, "non-administrators must not change channel state");
  assert.match(responses.at(-1).content, /server administrators/i);
  assert.equal(responses.at(-1).flags, 64, "permission failures should be private");
});

test("/disintegrate stays restricted to the primary owner and handles missing fights privately", async () => {
  setCommandState({
    disabledChannels: new Set(),
    ownerId: "primary-owner",
    secondGodId: "secondary-owner",
    activeFights: new Map(),
    fightMessages: new Map(),
  });
  let response;
  function makeInteraction(userId) {
    return {
      commandName: "disintegrate",
      options: {},
      user: { id: userId },
      guild: { id: "guild-1" },
      channel: { id: "channel-1" },
      inGuild: () => true,
      isRepliable: () => true,
      reply: async (payload) => { response = payload; return payload; },
    };
  }

  await handleCommand(makeInteraction("secondary-owner"));
  assert.match(response.content, /Only the bot owner/);
  assert.equal(response.flags, 64);

  await handleCommand(makeInteraction("primary-owner"));
  assert.match(response.content, /not in an active player fight/);
  assert.equal(response.flags, 64);
});


test("Human remains playable but is excluded from Species Achievements", () => {
  const achievementRoster = achievements.getSpeciesRoster();
  assert.ok(constants.humanSpecies, "Human must remain defined as the default playable species");
  assert.ok(!achievementRoster.some((entry) => entry.name === "Human"), "Human should not have a Species Achievement entry");
  assert.ok(achievementRoster.some((entry) => entry.category === "Rarity" && entry.name !== "Human"), "normal species achievements should remain available");
  assert.ok(achievementRoster.some((entry) => entry.name === "True Dragon"), "secret and awakening species achievements should remain available");
});
