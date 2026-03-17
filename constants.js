// ==================== PATCH NOTES ====================
const patchNotes = [
  {
    version: "4.3", date: "2026-03-17",
    changes: [
      "⚔️ Miss + Counter system restored — attacks can miss, defenders have a 30% chance to counter-strike",
      "🎭 Chimera ULT overhauled — now copies opponent's species ULT directly, no waiting required",
      "🎁 New /gift command — send up to 2 rolls per day, receive up to 4 per day",
      "✨ Awakening Altar — /awakening is now a universal altar for all species awakenings",
      "🌑 Reaper Quest now has a deadline — quest expires 24 March 2026 at 6PM",
      "🔒 Cannot reroll species while in an active fight",
      "👑 God-given species now always becomes your original species",
      "🤖 Bot fights now show whose fight it is in the footer",
      "⏰ Bot fights auto-resolve in player's favour if bot is stuck for 60 seconds",
      "🐛 Fixed ULT cooldown — both players' ULT now ticks every round, spam no longer possible",
      "🗄️ Migrated to MongoDB — persistent data, no more resets on restart",
    ],
  },
  {
    version: "4.2", date: "2026-03-16",
    changes: [
      "🐛 Fixed all 17 combat bugs — passives, burns, possession, Chimera stacks, God retribution all working",
      "⚔️ Fight system overhauled — single embed with buttons attached, no more message spam",
      "🔄 Choice ULTs (Angel, Ice Dragon, Earth Dragon) now swap buttons inline",
      "📊 HP display now updates only after ALL effects fully resolve",
      "🤖 Bot turn shows Bot is thinking on the embed during AI delay",
      "🗄️ Migrated to MongoDB — persistent data, no more resets on bot restart",
      "📋 /species now shows full ranked species list with roll chances",
      "👑 /god species-add now supports up to 1,000,000 rolls",
    ],
  },
  {
    version: "4.1", date: "2026-02-27",
    changes: [
      "🐛 Reaper quest progress no longer resets",
      "⚙️ Constant healing bug fix in progress",
      "⚙️ ULT turn assignment bug fix in progress",
    ],
  },
  {
    version: "4.0", date: "2024-04-01",
    changes: [
      "✨ Added Chimera species (2.2%) — copies opponent's ULT",
      "⚖️ Complete species rarity overhaul",
      "⚖️ Dragon chance: 2.3% → 2.0% | Angel: 3.5% → 3.0%",
      "🐛 Fixed Chimera copying logic, turn order after ULT, counter damage instant kill",
    ],
  },
];

// ==================== SPECIES LISTS ====================
const speciesList = [
  { number:1,  name:"Demi God",   rarity:1,  emoji:"⚡",    chance:"0.5%",  roleName:"Demi-God",    color:0x00b0f0, hp:130, atkMin:22, atkMax:32, healMin:22, healMax:40, ultCooldown:12 },
  { number:2,  name:"Demon Lord", rarity:2,  emoji:"🔥",    chance:"1.0%",  roleName:"Demon-Lord",  color:0xff4500, hp:125, atkMin:20, atkMax:28, healMin:20, healMax:35, ultCooldown:10 },
  { number:3,  name:"Demon King", rarity:3,  emoji:"👑😈",  chance:"1.5%",  roleName:"Demon-King",  color:0xff6347, hp:120, atkMin:17, atkMax:25, healMin:18, healMax:30, ultCooldown:15 },
  { number:4,  name:"Demon",      rarity:8,  emoji:"😈",    chance:"4.0%",  roleName:"Demon",       color:0xff0000, hp:105, atkMin:14, atkMax:20, healMin:12, healMax:22, ultCooldown:4  },
  { number:5,  name:"Oni",        rarity:10, emoji:"👿",    chance:"5.0%",  roleName:"Oni",         color:0x8b0000, hp:110, atkMin:16, atkMax:24, healMin:15, healMax:25, ultCooldown:10 },
  { number:6,  name:"Orc Lord",   rarity:12, emoji:"👑",    chance:"6.0%",  roleName:"Orc-Lord",    color:0xffd700, hp:115, atkMin:15, atkMax:22, healMin:16, healMax:28, ultCooldown:7  },
  { number:7,  name:"Kijin",      rarity:14, emoji:"🎭",    chance:"7.0%",  roleName:"Kijin",       color:0x9b59b6, hp:100, atkMin:12, atkMax:18, healMin:10, healMax:20, ultCooldown:8  },
  { number:8,  name:"High Orc",   rarity:18, emoji:"⚔️",   chance:"9.0%",  roleName:"High-Orc",    color:0xc0c0c0, hp:105, atkMin:14, atkMax:20, healMin:14, healMax:24, ultCooldown:10 },
  { number:9,  name:"Ogre",       rarity:24, emoji:"👹",    chance:"12.0%", roleName:"Ogre",        color:0x8b4513, hp:110, atkMin:10, atkMax:16, healMin:18, healMax:30, ultCooldown:9  },
  { number:10, name:"Goblin",     rarity:36, emoji:"👺",    chance:"18.0%", roleName:"Goblin",      color:0x006400, hp:95,  atkMin:8,  atkMax:14, healMin:8,  healMax:16, ultCooldown:6  },
  { number:11, name:"Orc",        rarity:44, emoji:"🟢",    chance:"22.0%", roleName:"Orc",         color:0x00ff00, hp:100, atkMin:12, atkMax:18, healMin:12, healMax:20, ultCooldown:6  },
  { number:12, name:"Angel",      rarity:6,  emoji:"👼",    chance:"3.0%",  roleName:"Angel",       color:0xfff700, hp:100, atkMin:15, atkMax:23, healMin:15, healMax:32, ultCooldown:10 },
  { number:13, name:"Chimera",    rarity:4,  emoji:"🎭",    chance:"2.2%",  roleName:"Chimera",     color:0x9b59b6, hp:115, atkMin:16, atkMax:26, healMin:14, healMax:22, ultCooldown:15 },
  { number:14, name:"Cyborg",     rarity:14, emoji:"🤖",    chance:"7.0%",  roleName:"Cyborg",      color:0x00ffff, hp:125, atkMin:12, atkMax:19, healMin:8,  healMax:14, ultCooldown:7  },
  { number:15, name:"Half-Blood", rarity:52, emoji:"🩸",    chance:"26.0%", roleName:"Half-Blood",  color:0x8b4513, hp:90,  atkMin:10, atkMax:16, healMin:10, healMax:18, ultCooldown:7  },
  { number:16, name:"Mechangel",  rarity:0,  emoji:"⚡🤖",  chance:"—",     roleName:"Mechangel",   color:0x00ffff, hp:140, atkMin:15, atkMax:23, healMin:10, healMax:18, ultCooldown:6  },
];

const dragonSpecies = {
  base: { number:17, name:"Dragon", emoji:"🐉", chance:"2.0%", rolePrefix:"Dragon-" },
  types: [
    { type:"Fire",    emoji:"🔥", hp:125, atkMin:22, atkMax:32, healMin:8,  healMax:14, color:0xff4500, ultCooldown:11 },
    { type:"Thunder", emoji:"⚡", hp:115, atkMin:24, atkMax:34, healMin:6,  healMax:12, color:0xffd700, ultCooldown:12 },
    { type:"Ice",     emoji:"❄️", hp:120, atkMin:18, atkMax:28, healMin:16, healMax:24, color:0x1e90ff, ultCooldown:10 },
    { type:"Earth",   emoji:"🌍", hp:135, atkMin:16, atkMax:26, healMin:10, healMax:18, color:0x8b4513, ultCooldown:11 },
  ],
};

const botSpecies = {
  kitsune: { number:99, name:"Kitsune", emoji:"🦊", roleName:null, color:0xff8c00, hp:1000000, atkMin:500, atkMax:1000, healMin:200000, healMax:500000, ultCooldown:0,
    passive:"🛡️ 100% Damage Nullification", active:"👁️ Can erase existence | 🌌 Can create gods" },
  bot: { number:98, name:"Bot", emoji:"🤖", roleName:null, color:0x808080, hp:115, atkMin:15, atkMax:22, healMin:16, healMax:28, ultCooldown:8,
    passive:"🤖 Machine Learning - 10% chance to predict and counter attacks", active:"💻 System Overload - 2x damage | 🔥 25% recoil" },
};

const godSpecies       = { number:0,  name:"God",      emoji:"👑✨", roleName:"God",      color:0xffffff, hp:140, atkMin:25, atkMax:35, healMin:25, healMax:45, ultCooldown:12 };
const humanSpecies     = { number:99, name:"Human",    emoji:"👤",   roleName:null,       color:0x808080, hp:50,  atkMin:5,  atkMax:10, healMin:5,  healMax:10, ultCooldown:0  };
const reaperSpecies    = { number:18, name:"Reaper",   emoji:"🌑",   roleName:"Reaper",   color:0x2f4f4f, hp:110, atkMin:25, atkMax:38, healMin:8,  healMax:16, ultCooldown:12 };
const archdemonSpecies = { number:19, name:"Archdemon",emoji:"👿",   roleName:"Archdemon",color:0x4a0404, hp:150, atkMin:28, atkMax:40, healMin:15, healMax:25, ultCooldown:10 };

// ==================== BOT DIFFICULTY ====================
const botSpeciesByDifficulty = {
  easy:       ["Orc","Goblin","Ogre","Angel"],
  medium:     ["High Orc","Kijin","Orc Lord","Chimera"],
  hard:       ["Oni","Demon","Fire Dragon","Thunder Dragon"],
  impossible: ["Demon King","Demon Lord","Demi God","Ice Dragon","Earth Dragon","God"],
};

const botPersonalities = {
  easy:       { name:"Baby Bot",    emoji:"🧸", color:0x00ff00, healThreshold:0.2, ultChance:0.1,  passFailRate:0.5,  reactionDelay:2000, description:"Beep boop... where bomb go?" },
  medium:     { name:"Warrior Bot", emoji:"⚔️", color:0x808080, healThreshold:0.3, ultChance:0.3,  passFailRate:0.35, reactionDelay:1500, description:"Calculating... passing to you!" },
  hard:       { name:"Demon Bot",   emoji:"👹", color:0x0000ff, healThreshold:0.4, ultChance:0.6,  passFailRate:0.2,  reactionDelay:1000, description:"Your moves are predictable, human." },
  impossible: { name:"God Bot",     emoji:"💀", color:0xff0000, healThreshold:0.5, ultChance:0.9,  passFailRate:0.05, reactionDelay:500,  description:"I have already calculated the outcome. You lose." },
};

// ==================== TYPE ADVANTAGES ====================
const typeAdvantages = {
  Orc:            { strongAgainst:"Goblin",        weakAgainst:"Ogre" },
  Goblin:         { strongAgainst:"Ogre",           weakAgainst:"Orc" },
  Ogre:           { strongAgainst:"Orc",            weakAgainst:"Goblin" },
  "High Orc":     { strongAgainst:"Kijin",          weakAgainst:"Oni" },
  Kijin:          { strongAgainst:"Oni",            weakAgainst:"High Orc" },
  Oni:            { strongAgainst:"High Orc",       weakAgainst:"Kijin" },
  "Orc Lord":     { strongAgainst:"Demon",          weakAgainst:"Demon King" },
  Demon:          { strongAgainst:"Demon King",     weakAgainst:"Orc Lord" },
  "Demon King":   { strongAgainst:"Orc Lord",       weakAgainst:"Demon" },
  "Demon Lord":   { strongAgainst:"Demi God",       weakAgainst:"God" },
  "Demi God":     { strongAgainst:"God",            weakAgainst:"Demon Lord" },
  God:            { strongAgainst:null,             weakAgainst:null },
  Angel:          { strongAgainst:"Demon",          weakAgainst:"Demon Lord" },
  Chimera:        { strongAgainst:null,             weakAgainst:null },
  Reaper:         { strongAgainst:null,             weakAgainst:null },
  "Fire Dragon":  { strongAgainst:"Ice Dragon",     weakAgainst:"Earth Dragon" },
  "Thunder Dragon":{ strongAgainst:"Ice Dragon",    weakAgainst:"Earth Dragon" },
  "Ice Dragon":   { strongAgainst:"Earth Dragon",   weakAgainst:"Fire Dragon" },
  "Earth Dragon": { strongAgainst:"Thunder Dragon", weakAgainst:"Ice Dragon" },
};

const critRates = {
  Orc:{"chance":5,"multiplier":2.0}, Goblin:{"chance":7,"multiplier":1.9},
  Ogre:{"chance":6,"multiplier":1.85}, "High Orc":{"chance":10,"multiplier":2.0},
  Kijin:{"chance":9,"multiplier":1.7}, "Orc Lord":{"chance":10,"multiplier":1.65},
  Oni:{"chance":11,"multiplier":1.6}, Demon:{"chance":12,"multiplier":1.55},
  "Demon King":{"chance":13,"multiplier":1.5}, "Demon Lord":{"chance":14,"multiplier":1.45},
  "Demi God":{"chance":15,"multiplier":1.4}, God:{"chance":20,"multiplier":1.3},
  Angel:{"chance":12,"multiplier":1.6}, Chimera:{"chance":10,"multiplier":1.7},
  Reaper:{"chance":15,"multiplier":1.5}, "Fire Dragon":{"chance":10,"multiplier":1.7},
  "Thunder Dragon":{"chance":15,"multiplier":1.5}, "Ice Dragon":{"chance":8,"multiplier":1.8},
  "Earth Dragon":{"chance":5,"multiplier":2.0}, Cyborg:{"chance":10,"multiplier":1.6},
  "Half-Blood":{"chance":8,"multiplier":1.8}, Mechangel:{"chance":15,"multiplier":1.5},
  Archdemon:{"chance":18,"multiplier":1.6},
};

const failChances = {
  Orc:0.15, Goblin:0.14, Ogre:0.13, "High Orc":0.12, Kijin:0.11,
  "Orc Lord":0.10, Oni:0.09, Demon:0.08, "Demon King":0.07, "Demon Lord":0.06,
  "Demi God":0.05, God:0.04, Angel:0.08, Chimera:0.07, Reaper:0.06,
  "Fire Dragon":0.07, "Thunder Dragon":0.06, "Ice Dragon":0.08, "Earth Dragon":0.09,
  Cyborg:0.08, "Half-Blood":0.12, Mechangel:0.05, Archdemon:0.03,
};

// ==================== AWAKENING REQUIREMENTS ====================
const awakeningRequirements = {
  cyborg: { wins:25, damageDealt:500, ultUses:15, reward:"Mechangel", rewardRolls:5 }
};

// ==================== DISINTEGRATION MESSAGES ====================
const disintegrationMessages = [
  "✨ <@%attacker%>'s eyes begin to glow with celestial light...",
  "🌌 The air around <@%defender%> starts to crackle with divine energy...",
  "📜 Ancient runes appear in the sky, spelling out a forgotten prophecy...",
  "⚡ <@%defender%> tries to move but is frozen in place by an unseen force!",
  "💫 Their form begins to flicker, becoming translucent...",
  "✨ **DIVINE PUNISHMENT!** ✨\n<@%defender%> dissolves into golden light and fades from existence!",
  "🌑 Shadows deepen as <@%attacker%> raises a hand...",
  "🕳️ A rift in reality opens behind <@%defender%>...",
  "👁️ Countless eyes peer from the void...",
  "🌀 <@%defender%> is pulled backward, screaming silently...",
  "💫 They unravel into nothingness...",
  "⚫ **CONSUMED BY THE VOID!**",
  "⭐ Stars flicker and dim as <@%attacker%> focuses their will...",
  "📝 <@%defender%>'s name fades from the Book of Life...",
  "🕰️ Time itself stutters, uncertain...",
  "💨 <@%defender%> blinks out of existence like they never were...",
  "🌠 **ERASED FROM HISTORY!**",
  "⛈️ Storm clouds gather impossibly fast above...",
  "⚡ A bolt of pure white lightning strikes down...",
  "✨ <@%defender%> is illuminated from within...",
  "💥 They explode into a shower of sparks...",
  "🌩️ **STRUCK DOWN BY DIVINE WRATH!**",
  "🙏 <@%attacker%> whispers a single word in a forgotten tongue...",
  "🔔 A bell tolls once, twice, thrice...",
  "🕊️ <@%defender%>'s soul rises from their body...",
  "✨ It ascends to the heavens, leaving only dust...",
  "⛪ **JUDGMENT RENDERED!**",
  "☀️ The sun suddenly blazes brighter...",
  "🔥 Beams of light converge on <@%defender%>...",
  "💫 Their body superheats, glowing white-hot...",
  "💥 They detonate in a brilliant flash...",
  "🌅 **PURIFIED BY LIGHT!**",
  "⏰ Time freezes for everyone but <@%attacker%>...",
  "🔄 <@%attacker%> walks around frozen <@%defender%>...",
  "✂️ They snip a thread of fate...",
  "⏱️ Time resumes, but <@%defender%> is gone...",
  "⌛ **UNMADE FROM EXISTENCE!**",
  "🪞 A mirror appears before <@%defender%>...",
  "👤 They see every version of themselves...",
  "❌ One by one, the reflections shatter...",
  "💔 <@%defender%> cracks like glass and fades...",
  "🪦 **FACED THEMSELVES AND LOST!**",
  "🌌 <@%attacker%> snaps their fingers...",
  "✨ <@%defender%> freezes mid-motion...",
  "💫 They slowly break apart into stardust...",
  "🌠 The dust sparkles once, then dissipates...",
  "🌟 **RETURNED TO THE COSMOS!**",
  "📜 A parchment unrolls in the air...",
  "✍️ <@%defender%>'s life story is written...",
  "🔥 The parchment ignites with golden flame...",
  "📃 It burns to ash, and so does <@%defender%>...",
  "📖 **A STORY UNTOLD!**",
];

// ==================== ABILITY DESCRIPTIONS ====================
function getPassiveDescription(name) {
  const passives = {
    Orc:"**Berserker** — +5 damage below 30% HP",
    Goblin:"**Speed Dodge** — 10% chance to dodge",
    Ogre:"**Regeneration** — heal 5 HP at start of your turns",
    "High Orc":"**Critical Strike** — 10% crit chance → 2× damage",
    Kijin:"**Shadow Dance** — 15% to attack twice",
    "Orc Lord":"**Despair** — 15% of opponent's max HP added to every attack",
    Oni:"**Demonic Resilience** — take 10% less damage",
    Demon:"**Life Steal** — heal 20% of damage dealt",
    "Demon King":"**Fear Aura** — opponent deals 10% less damage",
    "Demon Lord":"**Burning Aura** — 5 burn every turn even on miss",
    "Demi God":"**Divine Shield** — 15% damage reduction always",
    God:"**Divine Retribution** — heal 20% HP when opponent misses",
    Human:"None — just a human",
    Angel:"**Holy Touch** — heal 10% of damage dealt",
    Chimera:"**Adaptive Evolution** — +2 dmg after taking damage (stacks 3×)",
    Reaper:"**Soul Reaper** — heal 30% dealt + 10% scaling dmg",
    "Fire Dragon":"**Burning Aura** — 4 burn every round",
    "Thunder Dragon":"**Paralyzing Shock** — 10% to nullify attack",
    "Ice Dragon":"**Frost Armor** — heal 10% of damage received",
    "Earth Dragon":"**Stone Skin** — 15% damage reduction",
    Cyborg:"**Overclock** — every 3 attacks = 1.3× surge",
    "Half-Blood":"**Scrappy** — +3 dmg below 25% HP",
    Mechangel:"**Quantum Processing** — every 2 attacks = 1.4×",
    Archdemon:"**Lord of Darkness** — +15% dmg and +5 flat all attacks",
  };
  return passives[name] || "Unknown passive";
}

function getActiveDescription(name) {
  const actives = {
    Orc:"**Berserker Rage** — 2× next attack, 20% recoil (CD: 6)",
    Goblin:"**Nimble Escape** — guaranteed dodge for 1 round (CD: 6)",
    Ogre:"**Massive Blow** — 1.5× + stun + extra turn (CD: 9)",
    "High Orc":"**War Cry** — +50% ATK for 2 attacks (CD: 10)",
    Kijin:"**Shadow Clone** — clone absorbs 1 hit (CD: 8)",
    "Orc Lord":"**Royal Command** — block enemy heal for 1 round (CD: 7)",
    Oni:"**Demonic Possession** — enemy attacks themselves next turn (CD: 10)",
    Demon:"**Soul Steal** — 2× next attack (CD: 4)",
    "Demon King":"**Infernal Domain** — +30% dmg for 3 turns (CD: 15)",
    "Demon Lord":"**Hellfire** — 2× + 7 burn for 2 rounds (CD: 10)",
    "Demi God":"**Divine Wrath** — 2.5× next attack (CD: 12)",
    God:"**Divine Judgment** — remove 50% enemy HP, heal 50% own HP (CD: 12)",
    Human:"None",
    Angel:"**Divine Blessing** — choose: 1.5× + 35% heal OR 60% heal (CD: 10)",
    Chimera:"**Mirror Realm** — copy opponent's last ULT (CD: 15)",
    Reaper:"**Death's Judgment** — below 20%: instant kill | above 20%: 1.7× + 50% life steal (CD: 12)",
    "Fire Dragon":"**Inferno Blast** — 1.7× + 10 burn 2 rounds (CD: 11)",
    "Thunder Dragon":"**Thunder Surge** — 1.4× + paralyze (CD: 12)",
    "Ice Dragon":"**Glacial Spike** — choose: 1.9× OR +50% heal (CD: 10)",
    "Earth Dragon":"**Terra Shield** — choose: 1.2× + invincible OR −60% dmg + 20% heal boost (CD: 11)",
    Cyborg:"**Self-Repair** — heal 30% max HP + 15% dmg reduction 2 turns (CD: 7)",
    "Half-Blood":"**Awakened Blood** — 1.4× + heal 10 HP (CD: 7)",
    Mechangel:"**System Restoration** — heal 40% + 20% reduction 2 turns (CD: 6)",
    Archdemon:"**Abyssal Gate** — 2× + 10 curse 3 turns (CD: 10)",
  };
  return actives[name] || "Unknown active";
}

module.exports = {
  patchNotes, speciesList, dragonSpecies, botSpecies,
  godSpecies, humanSpecies, reaperSpecies, archdemonSpecies,
  botSpeciesByDifficulty, botPersonalities,
  typeAdvantages, critRates, failChances, awakeningRequirements,
  disintegrationMessages, getPassiveDescription, getActiveDescription,
};
