const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  SlashCommandBuilder, REST, Routes,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
  SeparatorSpacingSize, MessageFlags, PermissionsBitField,
} = require("discord.js");
const {
  patchNotes, speciesList, dragonSpecies, humanSpecies, godSpecies,
  reaperSpecies, archdemonSpecies, slimeLordSpecies, eclipsedSovereignSpecies, chaosCreatorSpecies,
  botSpecies, botSpeciesByDifficulty, botPersonalities,
  typeAdvantages, disintegrationMessages,
  getPassiveDescription, getActiveDescription,
} = require("./constants.js");
const database = require("./database.js");
const {
  hpBar, createErrorEmbed, createSuccessEmbed, safeReply,
  getSpeciesByName, getRandomSpecies, getDragonSubtype,
  isPlayerInFight, isPlayerInBotFight, canFight,
  canSendRequest,
  updateLeaderboard, updateFightStats, updateCyborgProgress,
  isCyborgReadyForAwakening, isDemonReadyForAwakening, updateReaperQuest,
  updateHalfBloodProgress, isHalfBloodReadyForAwakening,
} = require("./helpers.js");
const { buildFightMessagePayload, buildBotFightMessagePayload, makeCombatant, calculateDamage, applyUltEffect, tickCooldowns, tickBothUltCooldowns, applyOgreRegen, processCurseTick } = require("./combat.js");
const chaosSystem = require("./chaos.js");
const { startFight, endFight, doBotTurn, endBotFight } = require("./fights.js");
const questSystem = require("./quest-system.js");

let _state = null;
let _client = null;
function setState(s) { _state = s; }
function setClient(c) { _client = c; }

const SUPPORT_SERVER_INVITE = "https://discord.gg/TKBYpjqnPC";

function parseAccessBanDuration(rawValue) {
  const raw = String(rawValue || "").trim().toLowerCase();
  if (!raw) return { ok:true, expiresAt:null, label:"Permanent" };
  const match = raw.match(/^([1-9]\d*)(s|m|h|d|w|y)$/);
  if (!match) {
    return { ok:false, error:"Invalid duration. Use \`1s\`, \`1m\`, \`1h\`, \`1d\`, \`1w\`, or \`1y\` (for example \`12h\`). Leave the time empty for a permanent ban." };
  }
  const amount=Number(match[1]), unit=match[2];
  const unitMs={s:1000,m:60000,h:3600000,d:86400000,w:604800000,y:31536000000}[unit];
  const durationMs=amount*unitMs;
  const expiresAtMs=Date.now()+durationMs;
  if (!Number.isSafeInteger(amount)||!Number.isFinite(durationMs)||durationMs<=0
    ||!Number.isFinite(expiresAtMs)||expiresAtMs>8640000000000000) {
    return { ok:false, error:"That ban duration is too large to represent safely. Use a smaller value." };
  }
  const unitName={s:"second",m:"minute",h:"hour",d:"day",w:"week",y:"year"}[unit];
  return { ok:true, expiresAt:new Date(expiresAtMs), label:amount+" "+unitName+(amount===1?"":"s") };
}

const LEADERBOARD_BADGE_LABELS = {
  LB_FIGHTS_1: "🥇 Fight Wins Leaderboard #1",
  LB_FIGHTS_2: "🥈 Fight Wins Leaderboard #2",
  LB_FIGHTS_3: "🥉 Fight Wins Leaderboard #3",
  LB_FIGHTS_TOP10: "🏅 Top 10 Fight Wins in the World",
  LB_ROLLS_1: "🥇 Species Rolls Leaderboard #1",
  LB_ROLLS_2: "🥈 Species Rolls Leaderboard #2",
  LB_ROLLS_3: "🥉 Species Rolls Leaderboard #3",
  LB_ROLLS_TOP10: "🏅 Top 10 Species Rolls in the World",
};


function getSpeciesAutocompleteEntries(includeChaosCreator = false) {
  const entries = [
    ...speciesList,
    ...dragonSpecies.types.map(type => ({
      name: type.type + " Dragon",
      emoji: type.emoji + "🐉",
    })),
    godSpecies,
    reaperSpecies,
    archdemonSpecies,
    slimeLordSpecies,
    eclipsedSovereignSpecies,
    ...(includeChaosCreator ? [chaosCreatorSpecies] : []),
  ];
  const seen = new Set();
  return entries
    .filter(species => species?.name && !seen.has(species.name) && seen.add(species.name))
    .map(species => ({
      name: (String(species.emoji || "✨") + " " + species.name).slice(0, 100),
      value: species.name,
    }));
}

async function handleAutocomplete(interaction) {
  try {
    const focused = interaction.options.getFocused(true);
    const isSpeciesLookup = interaction.commandName === "species" && focused.name === "species";
    const isOwnerSpeciesChange = interaction.commandName === "owner"
      && interaction.options.getSubcommand(false) === "species-change"
      && focused.name === "species";
    if (!isSpeciesLookup && !isOwnerSpeciesChange) return interaction.respond([]);

    const query = String(focused.value || "").trim().toLocaleLowerCase();
    const includeChaosCreator = isOwnerSpeciesChange && interaction.user?.id === _state?.ownerId;
    const entries = getSpeciesAutocompleteEntries(includeChaosCreator)
      .filter(entry => !query || entry.value.toLocaleLowerCase().includes(query)
        || entry.name.toLocaleLowerCase().includes(query))
      .sort((a, b) => {
        const aStarts = a.value.toLocaleLowerCase().startsWith(query);
        const bStarts = b.value.toLocaleLowerCase().startsWith(query);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return a.value.localeCompare(b.value);
      })
      .slice(0, 25);

    return await interaction.respond(entries);
  } catch (error) {
    if (error?.code !== 10062 && !error?.message?.includes("Unknown interaction")) {
      console.error("[Species autocomplete] Failed to respond:", error?.stack || error);
    }
    return null;
  }
}

function buildStyledCardPayload(title, color, sections = [], ephemeral = false) {
  const container = new ContainerBuilder().setAccentColor(color || 0x0891b2);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}`));
  for (const section of sections) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    const sectionContent = section.heading ? `### ${section.heading}\n${section.body}` : section.body;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(String(sectionContent).slice(0, 3900)));
  }
  return {
    components:[container],
    flags:MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
    allowedMentions:{ parse:[] },
  };
}

function buildSpeciesSwitchPayload(userData, requestedPage=0) {
  const current=userData.species || humanSpecies;
  const specialForms=[
    {id:"switch_reaper",name:"Reaper",emoji:"🌑",unlocked:userData.questSpecies?.reaper?.unlocked===true,style:ButtonStyle.Primary},
    {id:"switch_archdemon",name:"Archdemon",emoji:"👿",unlocked:userData.awakening?.demon?.awakened===true,style:ButtonStyle.Danger},
    {id:"switch_mechangel",name:"Mechangel",emoji:"⚡🤖",unlocked:userData.awakening?.cyborg?.awakened===true,style:ButtonStyle.Primary},
    {id:"switch_slime_lord",name:"Slime Lord",emoji:"🫧",unlocked:userData.questSpecies?.slimeLord?.unlocked===true,style:ButtonStyle.Success},
    {id:"switch_eclipsed_sovereign",name:"Eclipsed Sovereign",emoji:"🌘",unlocked:userData.awakening?.halfBlood?.awakened===true,style:ButtonStyle.Primary},
  ];
  const specialNames=new Set(specialForms.map(form=>form.name));
  const forms=[];
  const original=userData.originalSpecies;
  if (original?.name && original.name!==current.name && !specialNames.has(original.name)) {
    forms.push({
      id:"switch_original",
      name:original.name,
      emoji:original.emoji || "👤",
      unlocked:true,
      style:ButtonStyle.Primary,
    });
  }
  for (const form of specialForms) {
    if (form.name===current.name) continue;
    // Older God species-change records may have the special species as the original
    // even if they predate the permanent unlock flag. Keep those switchable.
    if (original?.name===form.name) form.unlocked=true;
    forms.push(form);
  }

  const pageSize=3;
  const pageCount=Math.max(1,Math.ceil(forms.length/pageSize));
  const page=Math.max(0,Math.min(Number.isInteger(requestedPage)?requestedPage:0,pageCount-1));
  const container=new ContainerBuilder().setAccentColor(0x9b59b6);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    "## 🔄 Species Switch\n**Current species:** "+(current.emoji||"👤")+" **"+current.name+"**\n**Cooldown:** 3 hours"
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  const pageForms=forms.slice(page*pageSize,page*pageSize+pageSize);
  for (const form of pageForms) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent("### "+form.emoji+" "+form.name));
    const button=new ButtonBuilder().setCustomId(form.id);
    if (form.unlocked) {
      button.setLabel("Switch to "+form.name).setStyle(form.style);
    } else {
      button.setLabel("Locked").setStyle(ButtonStyle.Secondary).setDisabled(true);
    }
    container.addActionRowComponents(new ActionRowBuilder().addComponents(button));
  }

  if (pageCount>1) {
    const nav=[];
    nav.push(new ButtonBuilder().setCustomId("switch_page_"+Math.max(0,page-1))
      .setLabel("← Previous").setStyle(ButtonStyle.Secondary).setDisabled(page===0));
    nav.push(new ButtonBuilder().setCustomId("switch_page_"+Math.min(pageCount-1,page+1))
      .setLabel("Next →").setStyle(ButtonStyle.Secondary).setDisabled(page===pageCount-1));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent("Page "+(page+1)+" of "+pageCount+" · Each species has its own button directly below its name."));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(nav));
  } else {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent("Each species has its own button directly below its name. Locked forms are unavailable until unlocked."));
  }

  return {
    components:[container],
    flags:MessageFlags.IsComponentsV2,
    allowedMentions:{ parse:[] },
  };
}

function buildFightChallengePayload(challengerId, targetId, challengerSpecies, targetSpecies) {
  const container = new ContainerBuilder().setAccentColor(0xf97316);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    "## ⚔️ Player Fight Challenge\nA player has challenged you to a battle in Legends of the Rift."
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    "**CHALLENGER**\n" + challengerSpecies.emoji + " **" + challengerSpecies.name + "** · <@" + challengerId + ">\n\n" +
    "**CHALLENGED PLAYER**\n" + targetSpecies.emoji + " **" + targetSpecies.name + "** · <@" + targetId + ">"
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    "Accept to begin the battle. This request expires in **60 seconds**.\n\nDeclining or letting it expire frees both players to send or receive another challenge."
  ));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("fight_accept_" + challengerId + "_" + targetId).setLabel("Accept Fight").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("fight_reject_" + challengerId + "_" + targetId).setLabel("Decline").setStyle(ButtonStyle.Danger)
  ));
  return { components:[container], flags:MessageFlags.IsComponentsV2, allowedMentions:{ parse:[], users:[challengerId, targetId] } };
}

function buildFightChallengeStatusPayload(title, description, color = 0x0891b2, mentionIds = []) {
  const container = new ContainerBuilder().setAccentColor(color);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## " + title + "\n" + description));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  return { components:[container], flags:MessageFlags.IsComponentsV2, allowedMentions:{ parse:[], users:mentionIds } };
}

function clearFightRequestLocks(challengeId, ...userIds) {
  for (const userId of userIds) {
    const request = _state?.activeRequests?.get(userId);
    if (request?.challengeId === challengeId) _state.activeRequests.delete(userId);
  }
}

function buildSpeciesRollAnnouncement(userId, userName, species, rollsRemaining, isResult = false) {
  const title = `<:reroll_dice:1558042108965822515> Species Roll`;
  const sections = isResult ? [
    { heading:"Roll Result", body:`**${userName}** rolled ${species.emoji} **${species.name}**.\n\n**Roll chance:** ${species.name.endsWith("Dragon") ? "2.0% (random element)" : (species.chance || "Special unlock")}` },
    { heading:"Species Stats", body:`❤️ **HP:** ${species.hp}\n⚔️ **ATK:** ${species.atkMin}–${species.atkMax}\n💚 **HEAL:** ${species.healMin}–${species.healMax}\n✨ **ULT cooldown:** ${species.ultCooldown || "—"} rounds` },
    { heading:"Remaining Rolls", body:`<:reroll_dice:1558042108965822515> **${rollsRemaining}**` },
  ] : [
    { heading:"Current Species", body:`${species.emoji} **${species.name}**` },
    { heading:"Available Rolls", body:`<:reroll_dice:1558042108965822515> **${rollsRemaining}**` },
  ];
  const awakeningTargets = { "Cyborg":"Mechangel", "Demon":"Archdemon", "Half-Blood":"Eclipsed Sovereign" };
  const awakeningTarget = isResult ? awakeningTargets[species.name] : null;
  if (awakeningTarget) {
    sections.push({
      heading:"Awakening",
      body:`✨ This species can awaken into **${awakeningTarget}**. Use \`/awakening\` to track your requirements.`,
    });
  }
  const payload = buildStyledCardPayload(title, species.color || 0x0891b2, sections, false);
  const components = [
    new TextDisplayBuilder().setContent(`<@${userId}>'s Species Roll`),
    ...payload.components,
  ];

  if (rollsRemaining > 0) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`reroll_${userId}`).setLabel("Reroll").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cancel_${userId}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    ));
  }

  return {
    ...payload,
    components,
    allowedMentions:{ parse:[], users:[userId] },
  };
}


const HELP_PAGES = [
  {
    title:"Getting Started",
    intro:"Your first commands for getting set up in LOZ.",
    commands:[
      {usage:"/guide",name:"Start the tutorial",description:"Walk through the basics and claim a one-time +1 Species Roll reward."},
      {usage:"/daily",name:"Claim your daily reward",description:"Receive +1 Species Roll every 24 hours, with a bonus roll on a 7-day streak."},
      {usage:"/species-roll",name:"Roll a species",description:"Spend a roll to receive a species, then choose whether to reroll or keep it."},
      {usage:"/profile [user]",name:"View a player profile",description:"Check a player's current species, roll balance, and progression."},
    ],
  },
  {
    title:"Species & Progress",
    intro:"Browse abilities, manage forms, and track awakenings.",
    commands:[
      {usage:"/species [species]",name:"Browse species",description:"Open the species compendium or choose a species to view its stats and abilities."},
      {usage:"/awakening",name:"Check awakening progress",description:"See your current awakening requirements and which objectives remain."},
      {usage:"/switch",name:"Switch species forms",description:"Equip an unlocked form. A 3-hour cooldown normally applies."},
      {usage:"/items use item:Species Token",name:"Use a Species Token",description:"Choose an eligible species and spend one token to change into it."},
    ],
  },
  {
    title:"Battles",
    intro:"Challenge other players or train against an LOZ bot.",
    commands:[
      {usage:"/fight player user:@player",name:"Challenge a player",description:"Send a player a battle request. They must accept before the fight starts."},
      {usage:"/fight bot difficulty:Easy",name:"Fight a bot",description:"Start a bot battle. Select Easy, Medium, Hard, Impossible, or Brutal in Discord's options."},
      {usage:"/togglerequests status:Enable",name:"Manage incoming challenges",description:"Choose Enable or Disable to control whether other players can challenge you."},
    ],
  },
  {
    title:"Quests & Rewards",
    intro:"Earn extra rolls and keep track of your goals.",
    commands:[
      {usage:"/quest",name:"Learn about quests",description:"Open a quick explanation of the quest board."},
      {usage:"/quests",name:"View and claim quests",description:"Track quest progress, claim completed rewards, and open the verified Top.gg vote option."},
      {usage:"/gift user:@player amount:1",name:"Gift Species Rolls",description:"Give another player between 1 and 5 of your rolls."},
      {usage:"/daily",name:"Build your daily streak",description:"Claim a roll every 24 hours; the 7-day streak grants one extra roll."},
    ],
  },
  {
    title:"Battle Records & Rankings",
    intro:"Review past fights and compare player totals.",
    commands:[
      {usage:"/fightstats [user]",name:"View player fight stats",description:"Check a player's recorded PvP fight wins and losses."},
      {usage:"/history [user]",name:"View fight history",description:"Review recent battle results for yourself or another player."},
      {usage:"/botstats [user]",name:"View bot battle stats",description:"See a player's bot battle wins, losses, and win rates by difficulty."},
      {usage:"/leaderboard type:Fight Wins",name:"Rank fight wins",description:"Show the leaderboard for recorded player fight wins."},
      {usage:"/leaderboard type:Species Rolls",name:"Rank Species Rolls",description:"Show players ranked by their current unspent Species Rolls."},
    ],
  },
  {
    title:"Updates & Support",
    intro:"Control update DMs and find information about new releases.",
    commands:[
      {usage:"/updates subscribe",name:"Subscribe to update DMs",description:"Opt in to receive major LOZ update announcements by direct message."},
      {usage:"/updates unsubscribe",name:"Unsubscribe from update DMs",description:"Stop receiving major LOZ update announcement DMs."},
      {usage:"/updates status",name:"Check your preference",description:"See whether major update DMs are currently enabled for you."},
      {usage:"/patchnotes",name:"Read patch notes",description:"View the latest LOZ changes and fixes."},
      {usage:"/help",name:"Open this command guide",description:"Browse the command directory one category at a time."},
    ],
  },
];

function buildHelpPayload(pageIndex) {
  const safePage = Number.isInteger(pageIndex) ? pageIndex : 0;
  const page = HELP_PAGES[safePage];
  if (!page) throw new RangeError("Invalid help page");
  const container = new ContainerBuilder().setAccentColor(0x0891b2);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    "## LOZ Command Directory\n### " + page.title + " · Page " + (safePage + 1) + "/" + HELP_PAGES.length + "\n" + page.intro
  ));
  for (const command of page.commands) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "**\x60" + command.usage + "\x60 — " + command.name + "**\n• " + command.description
    ));
  }
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("help_page_" + Math.max(0,safePage - 1))
      .setLabel("<")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId("help_page_" + Math.min(HELP_PAGES.length - 1,safePage + 1))
      .setLabel(">")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage >= HELP_PAGES.length - 1),
    new ButtonBuilder()
      .setCustomId("help_close")
      .setLabel("Close")
      .setStyle(ButtonStyle.Danger)
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    "**Need help?** Join the [LOZ Support Server](https://discord.gg/TKBYpjqnPC) for support, questions, and community updates."
  ));
  return {components:[container],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}};
}

const GUIDE_PAGES = [
  {
    title:"Step 1: Get Your First Roll",
    body:"First, run \x60/daily\x60. You receive **+1 Species Roll** every 24 hours, with an extra roll on a 7-day streak.\n\nAlready claimed today? No problem. Continue with any rolls you already have. Then click **Next Page**.",
  },
  {
    title:"Step 2: Roll Your Species",
    body:"Run \x60/species-roll\x60. Your Species Roll message appears in the channel.\n\n- **Reroll** spends 1 roll and gives you a new species.\n- **Cancel** keeps your current species and spends nothing.\n\nIf you're out of rolls, return after your next daily reward. Then click **Next Page**.",
  },
  {
    title:"Step 3: Learn Your Species",
    body:"Run \x60/species\x60 to browse the species list, or select your species with \x60/species species:<name>\x60 to see its stats and abilities.\n\nCheck **HP**, **ATK**, **HEAL**, passive, and ultimate. Run \x60/profile\x60 to see your current species, rolls, and progress. Try it now, then click **Next Page**.",
  },
  {
    title:"Step 4: Fight Players or Bots",
    body:"Challenge a player with \x60/fight player user:@player\x60, or train with \x60/fight bot difficulty:Easy\x60. Choose a bot difficulty from the command options.\n\nUse **Attack**, **Heal**, and **ULT** when available. **Forfeit** ends the battle.\n\n**Rare boss:** a genuine bot victory has a **7.5% chance** to spawn the Slime Lord boss. Defeating that boss gives a separate **9.2% chance** to permanently unlock Slime Lord. Try a bot fight when you're ready, then click **Next Page**.",
  },
  {
    title:"Step 5: Quests & Awakenings",
    body:"Run \x60/quests\x60 to track objectives and claim completed quest rewards. Vote for LOZ on Top.gg through the quest board to earn **+2 Species Rolls** once every 12 hours after your vote is verified.\n\nCyborg, Demon, and Half-Blood have awakening paths. Run \x60/awakening\x60 to check requirements and \x60/switch\x60 to equip forms you've unlocked. A Species Token can be used with \x60/items use item:Species Token\x60. Explore these commands when you're ready, then click **Next Page**.",
  },
  {
    title:"Step 6: Find Any Command",
    body:"The command list is now organized into small, readable categories. Run \x60/help\x60 and use the **<** and **>** buttons to browse one category per page.\n\n**Getting started** — \x60/daily\x60, \x60/species-roll\x60, \x60/profile\x60\n**Species & progress** — \x60/species\x60, \x60/awakening\x60, \x60/switch\x60\n**Battles** — \x60/fight\x60, \x60/togglerequests\x60\n**Quests & rewards** — \x60/quests\x60, \x60/gift\x60\n**Records** — \x60/fightstats\x60, \x60/history\x60, \x60/leaderboard\x60\n\nEach command page explains the correct usage and what the command does. Click **Next Page** when you're ready to finish.",
  },

  {
    title:"Ready to Enter the Rift?",
    body:"You're ready! Start with a daily roll, learn your species, and jump into a battle. You can run \x60/guide\x60 again any time.\n\nPress **Complete Tutorial** below to claim your **one-time +1 Species Roll**. This reward can only be claimed once.",
  },
];

function buildGuidePayload(userId, userDisplayName, pageIndex) {
  const page = GUIDE_PAGES[pageIndex];
  if (!page) throw new RangeError("Invalid guide page");
  const container = new ContainerBuilder().setAccentColor(0x0891b2);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## 📖 LOZ FIELD GUIDE
### Page ${pageIndex + 1} of ${GUIDE_PAGES.length} · ${page.title}

${page.body}`
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  const buttons = [];
  if (pageIndex > 0) buttons.push(
    new ButtonBuilder()
      .setCustomId(`guide_page_${userId}_${pageIndex - 1}`)
      .setLabel("← Previous")
      .setStyle(ButtonStyle.Secondary)
  );
  if (pageIndex < GUIDE_PAGES.length - 1) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`guide_page_${userId}_${pageIndex + 1}`)
      .setLabel("Next Page →")
      .setStyle(ButtonStyle.Primary));
  } else {
    buttons.push(new ButtonBuilder()
      .setCustomId(`guide_complete_${userId}`)
      .setLabel("Complete Tutorial")
      .setStyle(ButtonStyle.Success));
  }
  container.addActionRowComponents(new ActionRowBuilder().addComponents(buttons));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("🎁 Complete the guide to get your reward."));
  return {
    components:[
      new TextDisplayBuilder().setContent(`<@${userId}>'s LOZ Guide`),
      container,
    ],
    flags:MessageFlags.IsComponentsV2,
    allowedMentions:{ parse:[], users:[userId] },
  };
}

function buildGuideCompletionPayload(userId, awarded, rolls) {
  const container = new ContainerBuilder().setAccentColor(awarded ? 0x00aa66 : 0x0891b2);
  const description = awarded
    ? `You're all done with the tutorial! Here's a free roll to help you get started!\n\n<:reroll_dice:1558042108965822515> **+1 Species Roll**\nYour new balance is **${rolls}**. The reward has been saved to your player record.`
    : `You're all done with the tutorial! You've already claimed the one-time guide reward, so no extra roll was added.\n\nCurrent roll balance: **${rolls}**.`;
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## ${awarded ? "🎁 Tutorial Complete!" : "✅ Tutorial Complete!"}\n${description}`
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("You're ready to explore LOZ. Use `/help` or run `/guide` again whenever you need a refresher."));
  return {
    components:[new TextDisplayBuilder().setContent(`<@${userId}>'s LOZ Guide`),container],
    flags:MessageFlags.IsComponentsV2,
    allowedMentions:{ parse:[], users:[userId] },
  };
}

function buildUpdateSubscriptionPromptPayload(userId) {
  const container = new ContainerBuilder().setAccentColor(0x0891b2);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## 🔔 Stay in the Loop with LOZ
Subscribe to major LOZ updates, special events, and announcements about update rewards and bonuses when available.

You'll receive major update announcements by DM. You can unsubscribe any time with \`/updates unsubscribe\`.

**Would you like to subscribe?**`
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`loz_updates_prompt_subscribe_${userId}`)
      .setLabel("Subscribe")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`loz_updates_prompt_later_${userId}`)
      .setLabel("Not now")
      .setStyle(ButtonStyle.Secondary)
  ));
  return {
    components:[container],
    flags:MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    allowedMentions:{ parse:[] },
  };
}

function buildUpdateSubscriptionResultPayload(title, description, color = 0x0891b2) {
  const container = new ContainerBuilder().setAccentColor(color);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}\n${description}`));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  return { components:[container], flags:MessageFlags.IsComponentsV2, allowedMentions:{ parse:[] } };
}

async function maybePromptForUpdates(interaction) {
  if (!interaction?.user?.id || (!interaction.replied && !interaction.deferred)) return false;
  const shouldPrompt = await database.claimUpdateSubscriptionPrompt(interaction.user.id);
  if (!shouldPrompt) return false;
  try {
    await interaction.followUp(buildUpdateSubscriptionPromptPayload(interaction.user.id));
    return true;
  } catch(e) {
    console.error("❌ Update subscription prompt delivery failed:", e?.message || String(e));
    return false;
  }
}

const SPECIES_TOKEN_EMOJI = "<:species_token:1558181624296771634>";
const SPECIES_TOKEN_SPECIES_NAMES = [
  "Demi God", "Demon Lord", "Demon King", "Demon", "Oni", "Orc Lord",
  "Kijin", "High Orc", "Ogre", "Goblin", "Orc", "Angel", "Chimera",
  "Cyborg", "Half-Blood", "Fire Dragon", "Thunder Dragon", "Ice Dragon",
  "Earth Dragon", "Human",
];
function isSpeciesTokenEligible(name) { return SPECIES_TOKEN_SPECIES_NAMES.includes(name); }
function parseSpeciesTokenCustomId(customId, action) {
  const rest = customId.slice(`species_token_${action}_`.length);
  const separator = rest.indexOf("_");
  if (separator <= 0) return null;
  try { return { userId:rest.slice(0, separator), speciesName:decodeURIComponent(rest.slice(separator + 1)) }; }
  catch { return null; }
}
function buildSpeciesTokenResultPayload(title, description, color = 0x0891b2) {
  const container = new ContainerBuilder().setAccentColor(color);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}\n${description}`));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  return { components:[container], flags:MessageFlags.IsComponentsV2, allowedMentions:{ parse:[] } };
}
function buildSpeciesTokenSelectionPayload(userId, selectedName = null, tokenCount = 0) {
  const selectedSpecies = selectedName ? getSpeciesByName(selectedName) : null;
  const currentSpecies = _state?.userSpecies?.get(userId)?.species || humanSpecies;
  const container = new ContainerBuilder().setAccentColor(selectedSpecies?.color || currentSpecies.color || 0x0891b2);
  const selectionNote = selectedSpecies
    ? (currentSpecies.name === selectedSpecies.name
      ? `\n⚠️ You're already ${selectedSpecies.emoji} **${selectedSpecies.name}**. Choose a different species.`
      : `\n**Selected:** ${selectedSpecies.emoji} **${selectedSpecies.name}**`)
    : "\n**Selected:** None";
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## ${SPECIES_TOKEN_EMOJI} Species Token\nSpend **1 token** to change your species. Reaper, Archdemon, Mechangel, and God are not available.\n\n**Current species:** ${currentSpecies.emoji} **${currentSpecies.name}**\n**Your balance:** ${SPECIES_TOKEN_EMOJI} **${tokenCount}**${selectionNote}`
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  const options = SPECIES_TOKEN_SPECIES_NAMES.map(name => {
    const species = getSpeciesByName(name);
    return {
      label:`${species.emoji} ${species.name}`.slice(0, 100),
      value:species.name,
      description:`HP ${species.hp} · ATK ${species.atkMin}-${species.atkMax}`.slice(0, 100),
      default:species.name === selectedName,
    };
  });
  const selector = new StringSelectMenuBuilder()
    .setCustomId(`species_token_pick_${userId}`)
    .setPlaceholder("Choose your new species")
    .setMinValues(1).setMaxValues(1).addOptions(options);
  container.addActionRowComponents(new ActionRowBuilder().addComponents(selector));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`species_token_review_${userId}_${selectedName ? encodeURIComponent(selectedName) : "none"}`)
      .setLabel("Select").setStyle(ButtonStyle.Primary)
      .setDisabled(!selectedSpecies || currentSpecies.name === selectedSpecies.name),
    new ButtonBuilder()
      .setCustomId(`species_token_cancel_${userId}`)
      .setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  ));
  return { components:[container], flags:MessageFlags.IsComponentsV2, allowedMentions:{ parse:[] } };
}
function buildSpeciesTokenConfirmPayload(userId, speciesName, tokenCount) {
  const species = getSpeciesByName(speciesName);
  const currentSpecies = _state?.userSpecies?.get(userId)?.species || humanSpecies;
  const container = new ContainerBuilder().setAccentColor(species?.color || 0x0891b2);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## Confirm Species Change\nYou're about to change from ${currentSpecies.emoji} **${currentSpecies.name}** to ${species.emoji} **${species.name}**.\n\nThis action costs **1** ${SPECIES_TOKEN_EMOJI}. Your balance is currently **${tokenCount}**.\n\nThe token will **only be deducted after you press Confirm**.`
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`species_token_confirm_${userId}_${encodeURIComponent(speciesName)}`).setLabel("Confirm").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`species_token_back_${userId}_${encodeURIComponent(speciesName)}`).setLabel("Go Back").setStyle(ButtonStyle.Secondary)
  ));
  return { components:[container], flags:MessageFlags.IsComponentsV2, allowedMentions:{ parse:[] } };
}

function asEphemeralSpeciesTokenPayload(payload) {
  return { ...payload, flags:MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
}

// Major-update DM payload built entirely with Components V2 and native separators.
function buildMajorUpdatePayload() {
  const container = new ContainerBuilder().setAccentColor(0x6f2da8);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "## 🌘 LOZ VERSION 5.2 — THE ECLIPSE WITHIN\n**The Rift has awakened something divided no longer.**\n\nBorn between two bloodlines, Half-Blood was told it would never fully belong to either. But the Rift does not remember only victories. It remembers every battle endured, every strike survived, and every power mastered. In Version 5.2, that resolve becomes a new form: **Eclipsed Sovereign**."
    )
  );

  const sections = [
    {
      title:"🌘 From Half-Blood to Eclipsed Sovereign",
      body:[
        "The old bloodlines no longer clash within. They answer as one, and an eclipse crowns the Half-Blood that refused to break.",
        "**Eclipsed Sovereign** — 115 HP, 15–22 attack, 14–22 healing, 7-round ultimate cooldown.",
        "**Hybrid Instinct:** below 50% HP, deal 20% more damage and take 10% less damage.",
        "**Bloodline Overdrive:** empower your next attack by **1.8×** and restore **15 HP**."
      ].join("\n")
    },
    {
      title:"📜 The three trials",
      body:[
        "**I. Endure the Rift:** complete **15 battles** as Half-Blood. Victories and defeats both count; the Rift tests endurance, not just the winner's banner.",
        "**II. Unite the Bloodlines:** deal **200 damage** while using Half-Blood.",
        "**III. Bloodline Mastery:** use the Half-Blood ultimate **10 times**.",
        "Only the current trial is shown. Existing saved progress carries forward, including progress recorded before this update. Complete the trials and confirm your awakening from /awakening."
      ].join("\n")
    },
    {
      title:"🔄 A clearer species switch",
      body:[
        "The /switch menu now lists each species name with its own button directly beneath it. The list is split into pages to fit Discord's component limits.",
        "Unlocked forms are selectable; locked forms are clearly marked **Locked**."
      ].join("\n")
    },
    {
      title:"👑 God can grant the new form",
      body:[
        "The God-only /god species-unlock command now includes **Eclipsed Sovereign**. /god species-change also supports **Eclipsed Sovereign** and **Slime Lord**.",
        "God-granted exclusive forms keep their permanent unlock flag, so they remain available through /switch after changing species."
      ].join("\n")
    }
  ];

  for (const section of sections) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("### " + section.title + "\n" + section.body)
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "### 🔔 Stay updated\nUse /updates subscribe to opt in to future major-update DMs. You can unsubscribe at any time with /updates unsubscribe.\n\n🌐 **Website:** [Visit LOZ](https://lozbot.vercel.app/)"
    )
  );

  return {
    components:[container],
    flags:MessageFlags.IsComponentsV2,
    allowedMentions:{ parse:[] },
  };
}


// LOZ 6.0 event announcement. The public copy remains available to other users;
// each person's confirmation is private and can disappear without deleting it.
function buildLoz60EventPayload() {
  const container = new ContainerBuilder().setAccentColor(0x6f2da8);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    "## 🌘 LOZ 6.0v Is Almost Here\nThe new update drops on **15 October 2026 at around 10 PM IST**.\n\nRegister to qualify for **free launch rewards** when the update goes live.\n\nDiscover the [Rift Lore on the LOZ website](https://lozbot.vercel.app/)."
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("loz60_event_interested").setLabel("Interested").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("loz60_event_not_interested").setLabel("Not Interested").setStyle(ButtonStyle.Secondary)
  ));
  return { components:[container], flags:MessageFlags.IsComponentsV2, allowedMentions:{ parse:[] } };
}

function buildLoz60EventResultPayload(title, description, color=0x0891b2, ephemeral=false) {
  const container = new ContainerBuilder().setAccentColor(color);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## " + title + "\n" + description));
  return {
    components:[container],
    flags:MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
    allowedMentions:{ parse:[] },
  };
}

function scheduleLoz60PromptDeletion(callback) {
  const timer = setTimeout(callback, 10_000);
  if (typeof timer.unref === "function") timer.unref();
}

// Find a server invite LOZ can share with its owner.
async function getServerInvite(guild) {
  if (guild.vanityURLCode) return "https://discord.gg/" + guild.vanityURLCode;
  const botMember = guild.members.me || await guild.members.fetch(_client.user.id).catch(() => null);
  if (!botMember) return null;
  const channels = guild.channels.cache;
  const candidates = [...channels.values()]
    .filter(channel => typeof channel.createInvite === "function" && channel.isTextBased && channel.isTextBased())
    .sort((a, b) => Number(b.id === guild.systemChannelId) - Number(a.id === guild.systemChannelId));
  for (const channel of candidates) {
    const permissions = channel.permissionsFor(botMember);
    if (!permissions || !permissions.has(PermissionsBitField.Flags.CreateInstantInvite)) continue;
    try {
      const invite = await channel.createInvite({
        maxAge:604800,
        maxUses:0,
        unique:false,
        reason:"LOZ owner used /servers to coordinate LOZ announcement setup.",
      });
      return invite.url;
    } catch(e) {
      console.warn("Could not create invite for server " + guild.id + " (code " + (e && e.code || "unknown") + ").");
    }
  }
  return null;
}

async function buildServersPagePayload(page, ownerId) {
  const servers = [..._client.guilds.cache.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity:"base" }));
  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(servers.length / pageSize));
  const safePage = Math.max(0, Math.min(Number.isInteger(page) ? page : 0, pageCount - 1));
  const pageServers = servers.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const embed = new EmbedBuilder()
    .setColor(0x0891b2)
    .setTitle("LOZ Server Directory")
    .setDescription(servers.length
      ? "LOZ is currently in " + servers.length + " servers. Use an invite to join a server and contact its owner about LOZ announcements. Generated invites last 7 days."
      : "LOZ isn't currently in any servers.");

  const details = await Promise.all(pageServers.map(async (guild, offset) => {
    const invite = await getServerInvite(guild);
    const name = String(guild.name || "Unknown server").replace(/[\r\n]/g, " ").slice(0, 100);
    const memberCount = Number.isFinite(guild.memberCount) ? guild.memberCount.toLocaleString() : "Unknown";
    const inviteText = invite ? "[Join server](" + invite + ")" : "Unavailable. LOZ lacks invite permission.";
    return {
      name: ("#" + (safePage * pageSize + offset + 1) + " · " + name).slice(0, 256),
      value: "Server ID: " + guild.id + "\nMembers: " + memberCount + "\nInvite: " + inviteText,
      inline:false,
    };
  }));
  if (details.length) embed.addFields(details);
  embed.setFooter({ text:"Page " + (safePage + 1) + "/" + pageCount + " · Sorted by server name" });

  const components = [];
  if (servers.length) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("servers_page_" + ownerId + "_" + Math.max(0, safePage - 1))
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage === 0),
      new ButtonBuilder()
        .setCustomId("servers_page_" + ownerId + "_" + Math.min(pageCount - 1, safePage + 1))
        .setLabel("Next")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(safePage >= pageCount - 1),
    ));
  }
  return { embeds:[embed], components, flags:64, allowedMentions:{ parse:[] } };
}

// ==================== SLASH COMMAND HANDLER ====================
async function handleCommand(interaction) {
  const { commandName, options, user, guild, channel } = interaction;

  // Older guild-scoped /fight registrations may still send a root-level player option.
  // Read the subcommand optionally so those interactions cannot throw before handling.
  const fightSubcommand = commandName === "fight" ? options.getSubcommand(false) : null;
  const legacyFightTarget = commandName === "fight" && !fightSubcommand
    ? (options.getUser("player", false) || options.getUser("user", false) || options.getUser("target", false))
    : null;

  // ── HELP ──────────────────────────────────────────────────────
  if (commandName === "help") {
    return safeReply(interaction, buildHelpPayload(0));
  }

  // ── GUIDE ─────────────────────────────────────────────────────
  if (commandName === "guide") {
    return safeReply(interaction, buildGuidePayload(user.id, user.displayName || user.username, 0));
  }

  // ── DAILY ─────────────────────────────────────────────────────
  if (commandName === "daily") {
    const now=Date.now(), ud=_state.dailyClaims.get(user.id);
    if (ud&&now-ud.lastClaim<86400000) {
      const tl=86400000-(now-ud.lastClaim), h=Math.floor(tl/3600000), m=Math.floor((tl%3600000)/60000);
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0xff8c00).setTitle("⏰ Daily Already Claimed").setDescription(`Come back in **${h}h ${m}m**!\n🔥 Streak: **${ud.streak||0} days**`)],flags:64});
    }
    const existingUser = _state.userSpecies.get(user.id);
    let userData = existingUser || {species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0};
    const streak=ud?(ud.streak||0)+1:1;
    _state.dailyClaims.set(user.id,{lastClaim:now,streak});
    database.saveDailyClaim(user.id,{lastClaim:now,streak});
    userData.rolls=(userData.rolls||0)+1;
    if (streak===7) userData.rolls+=1;
    // Only save if user already had data OR species map is populated (bot fully loaded)
    if (existingUser || _state.userSpecies.size > 0) {
      _state.userSpecies.set(user.id,userData); database.saveUserSpecies(user.id,userData);
    }
    return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x00ff00).setTitle("📅 Daily Bonus Claimed!").setDescription(`+1 species roll! <:reroll_dice:1558042108965822515>\nYou now have **${userData.rolls}** rolls.\n\n🔥 **${streak} Day Streak!**${streak===7?"\n🎉 **WEEK BONUS! +1 extra roll!**":""}`)]} );
  }

  // ── PATCHNOTES ────────────────────────────────────────────────
  if (commandName === "patchnotes") {
    const visibleNotes=patchNotes.slice(0,2);
    const container=new ContainerBuilder().setAccentColor(0x0891b2);

    visibleNotes.forEach((note,index)=>{
      if (index>0) {
        container.addSeparatorComponents(
          new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
        );
      }
      const heading=index===0?"## LOZ Patch Notes\n\n":"";
      const changes=note.changes.map(change=>`- ${change}`).join("\n");
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`${heading}### Version ${note.version} | ${note.date}\n${changes}`)
      );
    });

    return interaction.reply({components:[container],flags:MessageFlags.IsComponentsV2});
  }


  // ── UPDATE DM PREFERENCES ─────────────────────────────────────
  if (commandName === "servers") {
    if (user.id !== _state.ownerId) return safeReply(interaction, { content:"Owner only.", flags:64 });
    await interaction.deferReply({ flags:64 });
    return interaction.editReply(await buildServersPagePayload(0, user.id));
  }

  if (commandName === "view") {
    const sub = options.getSubcommand();
    if (sub !== "subscribers") return;

    const isLozOwner = [_state.ownerId, _state.secondGodId].includes(user.id);
    const isServerAdmin = Boolean(
      interaction.inGuild()
      && interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
    );
    if (!isLozOwner && !isServerAdmin) {
      return safeReply(interaction, {
        content:"Only LOZ's owners and server administrators can use this command.",
        flags:64,
      });
    }

    await interaction.deferReply({ flags:64 });
    const subscribers = await database.getBroadcastSubscribers();
    if (subscribers === null) {
      return interaction.editReply({
        content:"Couldn't load the subscriber count from MongoDB. No count is being reported; please try again later.",
        allowedMentions:{ parse:[] },
      });
    }

    const registeredUserIds = await database.getLoz60EventRegisteredUserIds();
    if (registeredUserIds === null) {
      return interaction.editReply({
        content:"Couldn't load the LOZ 6.0 event registration count from MongoDB. Please try again later.",
        allowedMentions:{ parse:[] },
      });
    }

    const subscriberCount = new Set(
      subscribers.filter(id => id !== _client?.user?.id)
    ).size;
    const eventRegistrationCount = new Set(
      registeredUserIds.filter(id => id !== _client?.user?.id)
    ).size;
    const embed = new EmbedBuilder()
      .setColor(0x0891b2)
      .setTitle("LOZ Update Subscribers")
      .setDescription("Current major-update DM subscribers and LOZ 6.0 event registrations.")
      .addFields(
        { name:"Active update subscribers", value:"🔔 **" + subscriberCount.toLocaleString() + "**", inline:true },
        { name:"LOZ 6.0 interested", value:"🌘 **" + eventRegistrationCount.toLocaleString() + "**", inline:true },
        { name:"Counting rule", value:"Each number counts unique Discord users separately. Event registrations include users who clicked Interested for LOZ 6.0, even if they aren't subscribed to general update DMs.", inline:false },
      )
      .setFooter({ text:"Live counts · Read from MongoDB" });

    return interaction.editReply({ embeds:[embed], allowedMentions:{ parse:[] } });
  }

  if (commandName === "updates") {
    const sub = options.getSubcommand();

    if (sub === "subscribe") {
      const saved = await database.setBroadcastOptIn(user.id, true);
      if (!saved) return safeReply(interaction, { embeds:[createErrorEmbed("Couldn't save your notification preference. Please try again later.")], flags:64 });
      return safeReply(interaction, {
        embeds:[new EmbedBuilder().setColor(0x0891b2).setTitle("LOZ Update DMs Enabled")
          .setDescription("You're subscribed to major LOZ update announcements by DM. You can opt out any time with \`/updates unsubscribe\`.")],
        flags:64,
      });
    }

    if (sub === "unsubscribe") {
      const saved = await database.setBroadcastOptIn(user.id, false);
      if (!saved) return safeReply(interaction, { embeds:[createErrorEmbed("Couldn't save your notification preference. Please try again later.")], flags:64 });
      return safeReply(interaction, {
        embeds:[new EmbedBuilder().setColor(0x0891b2).setTitle("LOZ Update DMs Disabled")
          .setDescription("You won't receive future major-update DMs. You can subscribe again with \`/updates subscribe\`.")],
        flags:64,
      });
    }

    if (sub === "status") {
      const optedIn = await database.getBroadcastOptIn(user.id);
      if (optedIn === null) return safeReply(interaction, { embeds:[createErrorEmbed("Couldn't read your notification preference. Please try again later.")], flags:64 });
      return safeReply(interaction, {
        embeds:[new EmbedBuilder().setColor(0x0891b2).setTitle("LOZ Update DM Preference")
          .setDescription(optedIn ? "✅ You're subscribed to major update DMs." : "You're not subscribed to major update DMs. Use \`/updates subscribe\` to opt in.")],
        flags:64,
      });
    }
  }

  // ── BROADTEST: OWNER-ONLY PREVIEW ──────────────────────────────
  if (commandName === "broadtest") {
    if (user.id !== _state.ownerId) {
      return safeReply(interaction, { content:"Only the LOZ owner can use this command.", flags:64 });
    }

    await interaction.deferReply({ flags:64 });
    try {
      await user.send(buildLoz60EventPayload());
      return interaction.editReply({ content:"✅ The LOZ 6.0 event-registration preview was sent to your DMs." });
    } catch(e) {
      console.error("broadtest DM failed:", e?.code || e?.message || e);
      return interaction.editReply({ content:"❌ Couldn't DM you the preview. Check that your DMs from LOZ are open, then try again." });
    }
  }

  // ── BROADCAST: LOZ 6.0 EVENT REGISTRATION ───────────────────────
  if (commandName === "broadcast") {
    if (user.id !== _state.ownerId) {
      return safeReply(interaction, { content:"Only the LOZ owner can use this command.", flags:64 });
    }

    await interaction.deferReply({ flags:64 });
    const subscribers = await database.getBroadcastSubscribers();
    if (subscribers === null) {
      return interaction.editReply({
        content:"❌ Couldn't load the update subscription list from MongoDB. No DMs or public prompt were attempted.\n\n**DMs sent:** 0\n**DMs failed:** 0",
      });
    }

    const respondedIds = await database.getLoz60EventRespondedUserIds();
    if (respondedIds === null) {
      return interaction.editReply({
        content:"❌ Couldn't load LOZ 6.0 registration responses from MongoDB. No DMs or public prompt were attempted.\n\n**DMs sent:** 0\n**DMs failed:** 0",
      });
    }

    // Post one shared card where /broadcast was run so non-subscribers can
    // register too. Keep this shared message so one response won't hide it
    // from everyone else in the channel.
    let publicPromptPosted = false;
    let publicPromptFailed = false;
    if (guild && channel && typeof channel.send === "function") {
      try {
        await channel.send(buildLoz60EventPayload());
        publicPromptPosted = true;
      } catch(e) {
        publicPromptFailed = true;
        console.warn("LOZ 6.0 public event prompt failed:", e?.code || e?.message || e);
      }
    }

    const respondedSet = new Set(respondedIds);
    const recipientIds = [...new Set(subscribers)]
      .filter(id => id !== _client.user.id && !respondedSet.has(id));

    if (!recipientIds.length) {
      return interaction.editReply({
        content:"✅ **LOZ 6.0 event announcement processed**\n\n" +
          "**Public prompt:** " + (publicPromptPosted ? "posted in this channel" : (publicPromptFailed ? "failed to post; check channel permissions" : "not posted (run /broadcast in a server text channel to publish it)")) +
          "\n**Subscribed users still awaiting a response:** 0\n**DMs sent:** 0\n**DMs failed:** 0",
      });
    }

    let nextIndex = 0;
    let sent = 0;
    let failed = 0;
    let completed = 0;

    const sendWorker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= recipientIds.length) return;
        const targetId = recipientIds[index];

        try {
          const target = await _client.users.fetch(targetId);
          await target.send(buildLoz60EventPayload());
          sent++;
        } catch(e) {
          failed++;
          console.warn(`LOZ 6.0 event DM failed (code ${e?.code || "unknown"}).`);
        }

        completed++;
        if (completed % 25 === 0) {
          await interaction.editReply({
            content:`📤 LOZ 6.0 event prompt in progress: ${completed}/${recipientIds.length} attempted · ${sent} sent · ${failed} failed.`,
          }).catch(() => {});
        }
      }
    };

    await Promise.all(
      Array.from({ length:Math.min(4, recipientIds.length) }, () => sendWorker())
    );

    return interaction.editReply({
      content:`✅ **LOZ 6.0 event announcement finished**\n\n**Public prompt:** ${publicPromptPosted ? "posted in this channel" : (publicPromptFailed ? "failed to post; check channel permissions" : "not posted (run /broadcast in a server text channel)") }\n**Subscribed users awaiting a response:** ${recipientIds.length}\n**DMs sent:** ${sent}\n**DMs failed:** ${failed}\n\nRegistered users and users who chose “Not Interested” are skipped in future event DMs.`,
    });
  }


  // ── SPECIES ───────────────────────────────────────────────────
  if (commandName === "species") {
    const spName = options.getString("species");
    if (spName === "Chaos Creator" && user.id !== _state.ownerId) {
      return safeReply(interaction, buildStyledCardPayload("Species Restricted", 0x991b1b, [
        { body:"🌀 Chaos Creator is exclusive to the primary LOZ owner." },
      ], true));
    }
    if (!spName) {
      const ranked = [
        {name:"God",emoji:"👑✨",chance:"0.2%",tier:"Divine"},
        {name:"Demi God",emoji:"⚡",chance:"0.5%",tier:"Epic"},
        {name:"Demon Lord",emoji:"🔥",chance:"1.0%",tier:"Epic"},
        {name:"Demon King",emoji:"👑😈",chance:"1.5%",tier:"Epic"},
        {name:"Dragon",emoji:"🐉",chance:"2.0%",tier:"Epic",note:"Random element"},
        {name:"Chimera",emoji:"🎭",chance:"2.2%",tier:"Rare"},
        {name:"Angel",emoji:"👼",chance:"3.0%",tier:"Rare"},
        {name:"Demon",emoji:"😈",chance:"4.0%",tier:"Rare"},
        {name:"Oni",emoji:"👿",chance:"5.0%",tier:"Uncommon"},
        {name:"Orc Lord",emoji:"👑",chance:"6.0%",tier:"Uncommon"},
        {name:"Kijin",emoji:"🎭",chance:"7.0%",tier:"Uncommon"},
        {name:"Cyborg",emoji:"🤖",chance:"7.0%",tier:"Uncommon"},
        {name:"High Orc",emoji:"⚔️",chance:"9.0%",tier:"Uncommon"},
        {name:"Ogre",emoji:"👹",chance:"12.0%",tier:"Common"},
        {name:"Goblin",emoji:"👺",chance:"18.0%",tier:"Common"},
        {name:"Orc",emoji:"🟢",chance:"22.0%",tier:"Common"},
        {name:"Half-Blood",emoji:"🩸",chance:"26.0%",tier:"Common"},
      ];
      const tierOrder = ["Divine","Epic","Rare","Uncommon","Common"];
      const sections = tierOrder.map(tier => ({
        heading:`${({Divine:"👑",Epic:"🟣",Rare:"🔵",Uncommon:"🟡",Common:"⚪"})[tier]} ${tier} Species`,
        body:ranked.filter(sp=>sp.tier===tier).map(sp =>
          `**${sp.emoji} ${sp.name}**  ·  ${sp.chance}${sp.note ? " · Random element" : ""}`
        ).join("\n"),
      }));
      sections.push({heading:"Special Unlocks",body:"🌑 **Reaper** · Quest unlock\n👿 **Archdemon** · Demon awakening\n⚡🤖 **Mechangel** · Cyborg awakening\n🫧 **Slime Lord** · 9.2% unlock chance after defeating its rare boss\n🌘 **Eclipsed Sovereign** · Half-Blood awakening"});
      sections.push({heading:"Species Details",body:"Use `/species species:<name>` to view HP, attack, healing, ultimate cooldown, passive, ultimate, and type matchups."});
      return safeReply(interaction,buildStyledCardPayload("<:reroll_dice:1558042108965822515> Species Compendium",0x0891b2,sections));
    }

    const sp = getSpeciesByName(spName);
    if (!sp) return safeReply(interaction,buildStyledCardPayload("Species Not Found",0xff0000,[{body:"That species couldn't be found. Use `/species` to view the compendium."}],true));
    const adv = typeAdvantages[sp.name];
    const matchup = adv
      ? [adv.strongAgainst ? `✅ **Strong against:** ${adv.strongAgainst}` : null,adv.weakAgainst ? `❌ **Weak against:** ${adv.weakAgainst}` : null].filter(Boolean).join("\n") || "No special type advantages."
      : "No special type advantages.";
    return safeReply(interaction,buildStyledCardPayload(`${sp.emoji} ${sp.name}`,sp.color||0x808080,[
      {heading:"Combat Stats",body:`❤️ **HP:** ${sp.hp}\n⚔️ **ATK:** ${sp.atkMin}–${sp.atkMax}\n💚 **HEAL:** ${sp.healMin}–${sp.healMax}\n✨ **ULT cooldown:** ${sp.ultCooldown||"—"} rounds`},
      {heading:"Rarity",body:sp.chance||"Special unlock"},
      {heading:"Passive",body:getPassiveDescription(sp.name)},
      {heading:"Active Ultimate",body:getActiveDescription(sp.name)},
      {heading:"Type Matchup",body:matchup},
    ]));
  }

  // ── PROFILE ───────────────────────────────────────────────────
  if (commandName === "profile") {
    const target=options.getUser("user")||user;
    const targetMember=guild ? await guild.members.fetch(target.id).catch(()=>null) : null;
    if (target.bot) {
      if (target.id===_client.user.id) {
        return safeReply(interaction,buildStyledCardPayload(`🦊 ${target.displayName}'s Profile`,botSpecies.kitsune.color,[
          {heading:"Species",body:"🦊 **Kitsune**"},
          {heading:"Combat Stats",body:"❤️ **HP:** 1,000,000\n⚔️ **ATK:** 500–1,000\n💚 **HEAL:** 200,000–500,000"},
          {heading:"Progression",body:`<:reroll_dice:1558042108965822515> **Rolls:** ∞\n📊 **Total players:** ${_state.userSpecies.size}\n⏱️ **Uptime:** <t:${Math.floor(Date.now()/1000-process.uptime())}:R>`},
          {heading:"Badges",body:"ᯓ★ 💪 Omnipotent\nᯓ★ 🐛 Bug Creator"},
        ]));
      }
      return safeReply(interaction,buildStyledCardPayload(`🤖 ${target.displayName}'s Profile`,botSpecies.bot.color,[
        {heading:"Species",body:"🤖 **Bot**"},
        {heading:"Combat Stats",body:`❤️ **HP:** ${botSpecies.bot.hp}\n⚔️ **ATK:** ${botSpecies.bot.atkMin}–${botSpecies.bot.atkMax}\n💚 **HEAL:** ${botSpecies.bot.healMin}–${botSpecies.bot.healMax}`},
      ]));
    }
    const td=_state.userSpecies.get(target.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,speciesTokens:0,requestsEnabled:true,badges:[]};
    const fd=_state.fightStats.get(target.id)||{wins:0,losses:0,streak:0};
    const sp=td.species||humanSpecies;
    const totalFights=(fd.wins||0)+(fd.losses||0);
    const wr=totalFights>0?((fd.wins/totalFights)*100).toFixed(1):"0.0";
    const badges=[];
    // Personal and legacy badges appear before leaderboard rank badges.
    if (td.badges?.includes("OG 50")) badges.push("ᯓ★ 🎉 OG 50");
    if (target.id==="926063716057894953") badges.push("ᯓ★ 👑 Founder","ᯓ★ ✨ The Creator");
    if (target.id==="1376978115171192922") badges.push("ᯓ★ 🤝 Co-Founder","ᯓ★ 🧪 OG Tester","ᯓ★ ⭐ Shion's Favourite");
    for (const badge of td.badges || []) {
      const badgeLabel = LEADERBOARD_BADGE_LABELS[badge];
      const displayBadge = badgeLabel ? "ᯓ★ " + badgeLabel : null;
      if (displayBadge && !badges.includes(displayBadge)) badges.push(displayBadge);
    }
    const sections=[
      {heading:"Current Species",body:`${sp.emoji} **${sp.name}**`},
      {heading:"Inventory & Settings",body:`<:reroll_dice:1558042108965822515> **Species rolls:** ${td.rolls||0}\n${SPECIES_TOKEN_EMOJI} **Species tokens:** ${Number(td.speciesTokens)||0}\n🔘 **Challenge requests:** ${td.requestsEnabled?"Enabled":"Disabled"}`},
      {heading:"Fight Record",body:`🏆 **Wins:** ${fd.wins||0}  ·  💔 **Losses:** ${fd.losses||0}\n📊 **Win rate:** ${wr}%\n🔥 **Win streak:** ${fd.streak||0}`},
      {heading:"Member Since",body:`<t:${Math.floor((targetMember?.joinedTimestamp||Date.now())/1000)}:R>`},
    ];
    if(badges.length) sections.splice(3,0,{heading:"Badges",body:badges.join("\n")});
    return safeReply(interaction,buildStyledCardPayload(`👤 ${target.displayName}'s Profile`,sp.color||0x9b59b6,sections));
  }

  // ── SPECIES-ROLL ──────────────────────────────────────────────
  if (commandName === "species-roll") {
    if (isPlayerInFight(user.id)||isPlayerInBotFight(user.id))
      return safeReply(interaction,buildStyledCardPayload("Roll Unavailable",0xff0000,[{body:"You can't reroll during an active fight."}],true));

    const userData=_state.userSpecies.get(user.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:1,speciesTokens:0,requestsEnabled:true,badges:[]};
    if ((userData.rolls||0)<1)
      return safeReply(interaction,buildStyledCardPayload("No Rolls Left",0xff0000,[{body:"Use /daily for a free roll or win fights for a chance to earn rolls."}],true));

    const now=Date.now();
    const cooldownUntil=_state.rerollCooldowns.get(user.id)||0;
    if (cooldownUntil>now) {
      const remaining=Math.max(1,Math.ceil((cooldownUntil-now)/1000));
      return safeReply(interaction,{content:"Please wait **"+remaining+"s** before opening another Species Roll. Your current roll panel remains usable.",flags:MessageFlags.Ephemeral});
    }

    const previousRoll=_state.activeRolls.get(user.id)||null;
    // Reserve cooldown before async work to prevent overlapping /species-roll commands.
    _state.rerollCooldowns.set(user.id,now+10000);
    const currentSp=userData.species||humanSpecies;
    let pubMsg;
    try {
      pubMsg=await channel.send(buildSpeciesRollAnnouncement(user.id,user.displayName||user.username,currentSp,userData.rolls,false));
    } catch(error) {
      if (_state.rerollCooldowns.get(user.id)===now+10000) _state.rerollCooldowns.delete(user.id);
      console.error("[Species Roll] Failed to post the roll panel:",error?.stack||error);
      return safeReply(interaction,buildStyledCardPayload("Roll Unavailable",0xff0000,[{body:"LOZ couldn't post the Species Roll message. Your roll was not used; please try again."}],true));
    }

    // Opening/replacing a panel does not spend a roll; the Reroll button does that.
    _state.activeRolls.set(user.id,{channelId:channel.id,messageId:pubMsg.id,timestamp:now});

    // Acknowledge before fetching/editing the older message, which may exceed Discord's interaction window.
    const panelResponse=await safeReply(interaction,{
      content:"Use the Reroll or Cancel button on the newest Species Roll message above. You can open another panel after 10 seconds.",
      flags:MessageFlags.Ephemeral,
    });

    // Expire the old panel only once the replacement is posted successfully.
    if (previousRoll && previousRoll.messageId!==pubMsg.id) {
      try {
        const previousChannel=previousRoll.channelId===channel.id
          ? channel
          : await _client.channels.fetch(previousRoll.channelId).catch(()=>null);
        const previousMessage=previousChannel?.messages
          ? await previousChannel.messages.fetch(previousRoll.messageId).catch(()=>null)
          : null;
        if (previousMessage) {
          await previousMessage.edit(buildStyledCardPayload("Species Roll Replaced",0x808080,[
            {body:"A newer Species Roll panel was opened. Use the newest panel to reroll. Replacing this panel did not spend a roll."},
          ],false));
        }
      } catch(error) {
        console.warn("[Species Roll] Could not expire previous panel:",error?.message||error);
      }
    }

    return panelResponse;
  }

  // ── AWAKENING ─────────────────────────────────────────────────
  if (commandName === "awakening") {
    const { awakeningRequirements } = require("./constants.js");
    const userData=_state.userSpecies.get(user.id);
    if (!userData) return safeReply(interaction,{embeds:[createErrorEmbed("You need a species first! Use `/species-roll`.")],flags:64});
    if (!userData.awakening) userData.awakening={};

    const sp = userData.species?.name;
    const bar=(p)=>{ const f=Math.floor(p/10); return "█".repeat(f)+"░".repeat(10-f); };

    // ── Cyborg / Mechangel ──────────────────────────────────────
    if (sp==="Cyborg"||sp==="Mechangel") {
      if (!userData.awakening.cyborg) userData.awakening.cyborg={wins:0,damageDealt:0,ultUses:0,awakened:false};
      const prog=userData.awakening.cyborg, req=awakeningRequirements.cyborg;
      const wPct=Math.min(Math.floor((prog.wins/req.wins)*100),100);
      const dPct=Math.min(Math.floor((prog.damageDealt/req.damageDealt)*100),100);
      const uPct=Math.min(Math.floor((prog.ultUses/req.ultUses)*100),100);
      if (prog.awakened) {
        return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x00ffff).setTitle("✨ AWAKENING ALTAR — TRANSCENDED")
          .setDescription("*You stand before the altar, your form already reborn.*\n\n**Current Form:** ⚡ Mechangel\n**Status:** ✅ Fully Awakened\n\n*The altar hums in recognition of its ascended champion.*")
          .setFooter({text:"You have reached your final form"})],flags:64});
      }
      const ready=prog.wins>=req.wins&&prog.damageDealt>=req.damageDealt&&prog.ultUses>=req.ultUses;
      if (ready) {
        const embed=new EmbedBuilder().setColor(0x00ffff).setTitle("✨ AWAKENING ALTAR — READY")
          .setDescription("*The altar pulses with blinding light. Your trials are complete.*\n\n**» ALL REQUIREMENTS MET «**\n├ ✅ Combat Trials: Complete\n├ ✅ Damage Output: Complete\n└ ✅ ULT Mastery: Complete\n\n**Upon awakening to ⚡ Mechangel:**\n├ +15 HP (140 total)\n├ +3-4 Attack (15-23)\n├ New Passive: Quantum Processing\n└ New ULT: System Restoration\n\n🎁 **Reward:** +5 Species Rolls");
        const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("awaken_cyborg").setLabel("✨ STEP INTO THE ALTAR").setStyle(ButtonStyle.Success));
        return safeReply(interaction,{embeds:[embed],components:[row],flags:64});
      }
      let step=1, title="Combat Trials", detail="Win battles while using Cyborg.", value=Number(prog.wins)||0, max=req.wins;
      if (value>=req.wins) { step=2; title="Damage Output"; detail="Deal damage in battle while using Cyborg."; value=Number(prog.damageDealt)||0; max=req.damageDealt; }
      if ((Number(prog.wins)||0)>=req.wins && (Number(prog.damageDealt)||0)>=req.damageDealt) { step=3; title="ULT Mastery"; detail="Use your ultimate while using Cyborg."; value=Number(prog.ultUses)||0; max=req.ultUses; }
      const pct=Math.min(100,Math.floor(value/max*100));
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x00ffff).setTitle(`✨ AWAKENING ALTAR — QUEST ${step}/3`)
        .setDescription(`*The altar reveals only the trial before you.*\n\n**${title}**\n${detail}\n\n**Progress:** ${value.toLocaleString()}/${max.toLocaleString()}\n${bar(pct)} ${pct}%`)
        .setFooter({text:"Complete each trial in order. Your existing progress remains saved."})],flags:64});
    }


    // ── Demon → Archdemon ─────────────────────────────────────────
    if (sp==="Demon" || sp==="Archdemon") {
      const prog=userData.awakening.demon || {playerWins:0,demonBotWins:0,awakened:false};
      userData.awakening.demon=prog;
      const req=awakeningRequirements.demon;
      const playerWins=Math.min(prog.playerWins||0,req.playerWins);
      const demonBotWins=Math.min(prog.demonBotWins||0,req.demonBotWins);
      const rolls=userData.rolls||0;
      const trialsReady=playerWins>=req.playerWins && demonBotWins>=req.demonBotWins;
      const barFor=(v,m)=>{const f=Math.min(10,Math.floor(v/m*10));return "█".repeat(f)+"░".repeat(10-f)+` ${v}/${m}`;};

      if (prog.awakened) {
        return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x4a0404).setTitle("👿 ARCHDEMON AWAKENING — COMPLETE")
          .setDescription(`**Current Form:** ${userData.species?.emoji||"👿"} ${userData.species?.name||"Archdemon"}\n**Status:** Permanently Awakened\n\nYour Demon awakening is permanent. After rolling another species, use \`/switch\` to return to Archdemon. Switching has a 3-hour cooldown.`)
          .setFooter({text:"Demon → Archdemon"})],flags:64});
      }

      if (trialsReady && rolls>=req.costRolls) {
        const embed=new EmbedBuilder().setColor(0x4a0404).setTitle("👿 AWAKENING ALTAR — READY")
          .setDescription(`*The darkness answers your call. Your trials are complete.*\n\n**» ALL REQUIREMENTS MET «**\n├ ✅ Player fight wins: ${playerWins}/${req.playerWins}\n├ ✅ Demon bot defeats: ${demonBotWins}/${req.demonBotWins}\n└ ✅ Reroll payment: ${req.costRolls} available\n\n**Upon awakening to 👿 Archdemon:**\n├ Your species becomes Archdemon\n├ The awakening is permanent\n└ ${req.costRolls} rolls will be consumed`);
        const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("awaken_archdemon").setLabel("AWAKEN AS ARCHDEMON").setStyle(ButtonStyle.Danger));
        return safeReply(interaction,{embeds:[embed],components:[row],flags:64});
      }

      let step=1, title="Player Fight Trials", detail="Win player battles while using Demon.", value=playerWins, max=req.playerWins;
      if (playerWins>=req.playerWins) { step=2; title="Demon Hunt"; detail="Defeat Demon opponents in bot battles while using Demon."; value=demonBotWins; max=req.demonBotWins; }
      if (playerWins>=req.playerWins && demonBotWins>=req.demonBotWins) { step=3; title="Reroll Tribute"; detail="Have 20 rolls available. They are only spent when you awaken."; value=rolls; max=req.costRolls; }
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x4a0404).setTitle(`👿 AWAKENING ALTAR — QUEST ${step}/3`)
        .setDescription(`*The darkness reveals only the trial before you.*\n\n**${title}**\n${detail}\n\n${barFor(value,max)}`)
        .setFooter({text:"Complete each trial in order. Your existing progress remains saved."})],flags:64});
    }

    // ── Half-Blood → Eclipsed Sovereign ─────────────────────────
    if (sp==="Half-Blood" || sp==="Eclipsed Sovereign") {
      const req=awakeningRequirements.halfBlood;
      if (!userData.awakening.halfBlood) userData.awakening.halfBlood={fights:0,wins:0,damageDealt:0,ultUses:0,awakened:false};
      const prog=userData.awakening.halfBlood;
      // v5.1 stored capped wins, so treat those as known completed fights when migrating.
      const fights=Math.min(Math.max(Number(prog.fights)||0,Number(prog.wins)||0),req.fights);
      const damage=Math.min(Number(prog.damageDealt)||0,req.damageDealt);
      const ults=Math.min(Number(prog.ultUses)||0,req.ultUses);
      if (prog.awakened) {
        return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x6f2da8).setTitle("🌘 ECLIPSED SOVEREIGN — AWAKENING COMPLETE")
          .setDescription(`**Unlocked Form:** 🌘 Eclipsed Sovereign\n**Status:** Permanently Awakened\n\n*The Half-Blood no longer fights against its divided nature. Both lineages answer as one, and the shadow of the eclipse crowns its new sovereign.*\n\nUse \`/switch\` to equip Eclipsed Sovereign after changing species.`)
          .setFooter({text:"Half-Blood → Eclipsed Sovereign"})],flags:64});
      }
      if (fights>=req.fights && damage>=req.damageDealt && ults>=req.ultUses && sp==="Half-Blood") {
        const readyEmbed=new EmbedBuilder().setColor(0x6f2da8).setTitle("🌘 AWAKENING ALTAR — READY")
          .setDescription("*The two bloodlines finally resonate. The eclipse answers.*\n\n**All three trials are complete.**\n\n**Eclipsed Sovereign**\n├ 115 HP\n├ 15–22 ATK\n├ Passive: Hybrid Instinct\n└ Ultimate: Bloodline Overdrive");
        const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("awaken_eclipsed_sovereign").setLabel("🌘 AWAKEN AS ECLIPSED SOVEREIGN").setStyle(ButtonStyle.Primary));
        return safeReply(interaction,{embeds:[readyEmbed],components:[row],flags:64});
      }
      let step=1, title="Endure the Rift", detail="Complete 15 battles while using Half-Blood. Wins and losses both count.", value=fights, max=req.fights;
      if (fights>=req.fights) { step=2; title="Unite the Bloodlines"; detail="Deal 200 damage while using Half-Blood."; value=damage; max=req.damageDealt; }
      if (fights>=req.fights && damage>=req.damageDealt) { step=3; title="Bloodline Mastery"; detail="Use your ultimate 10 times while using Half-Blood."; value=ults; max=req.ultUses; }
      const pct=Math.min(100,Math.floor(value/max*100));
      const equipNote=sp==="Half-Blood" ? "" : "\n\nEquip Half-Blood to continue this trial.";
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x6f2da8).setTitle(`🌘 AWAKENING ALTAR — QUEST ${step}/3`)
        .setDescription(`*The Rift remembers every blow endured, not only the victories claimed.*\n\n**${title}**\n${detail}\n\n**Progress:** ${value.toLocaleString()}/${max.toLocaleString()}\n${bar(pct)} ${pct}%${equipNote}`)
        .setFooter({text:"Your progress is permanent. The next trial appears after this one is complete."})],flags:64});
    }

    // ── No awakening available for this species ─────────────────
    return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x2d2d2d).setTitle("✨ AWAKENING ALTAR")
      .setDescription(`*You approach the altar, but it remains silent.*\n\n${userData.species?.emoji||"👤"} **${sp||"Unknown"}** does not yet have an awakening path.\n\nAwakenings are rare transformations granted to species who have proven their worth through relentless battle.\n\n*Check back as new awakenings are discovered.*`)
      .setFooter({text:"Currently: Cyborg → Mechangel | Demon → Archdemon"})],flags:64});
  }

  // ── FIGHT ─────────────────────────────────────────────────────
  if (commandName === "fight" && (fightSubcommand === "player" || legacyFightTarget)) {
    const target = fightSubcommand === "player" ? options.getUser("user") : legacyFightTarget;
    if (target.id===user.id) return safeReply(interaction,{embeds:[createErrorEmbed("You cannot fight yourself!")],flags:64});
    if (target.bot) return safeReply(interaction,{embeds:[createErrorEmbed("Use `/fight bot` to fight bots!")],flags:64});
    if (!canFight(user.id)) { const cd=_state.fightCooldowns.get(user.id); return safeReply(interaction,{embeds:[createErrorEmbed(cd&&cd>Date.now()?`Wait **${((cd-Date.now())/1000).toFixed(1)}s**!`:"Already in a game!")],flags:64}); }
    if (!canFight(target.id)) return safeReply(interaction,{embeds:[createErrorEmbed("That user is already in a fight!")],flags:64});
    const cd=_state.userSpecies.get(user.id), od=_state.userSpecies.get(target.id);
    if (!cd?.species||cd.species.name==="Human") return safeReply(interaction,{embeds:[createErrorEmbed("You need a species! Use `/species-roll` first.")],flags:64});
    if (!od?.species||od.species.name==="Human") return safeReply(interaction,{embeds:[createErrorEmbed(`<@${target.id}> needs a species first!`)],flags:64});
    const rc=canSendRequest(user.id,target.id);
    if (!rc.allowed) return safeReply(interaction,{embeds:[createErrorEmbed(rc.reason)],flags:64});
    const challengeId=user.id + "-" + target.id;
    const cdSp=cd.species||humanSpecies, odSp=od.species||humanSpecies;
    const timestamp=Date.now();
    const challenge={challengerId:user.id,opponentId:target.id,messageId:null,channelId:channel.id,timestamp};
    // Reserve both players synchronously so simultaneous requests cannot race past the check.
    _state.activeRequests.set(user.id,{type:"fight",targetId:target.id,timestamp,challengeId});
    _state.activeRequests.set(target.id,{type:"fight",targetId:user.id,timestamp,challengeId});
    _state.fightChallenges.set(challengeId,challenge);
    try {
      await safeReply(interaction,buildFightChallengePayload(user.id,target.id,cdSp,odSp));
      const msg=await interaction.fetchReply();
      challenge.messageId=msg.id;
      setTimeout(()=>{
        if (_state.fightChallenges.get(challengeId)!==challenge) return;
        _state.fightChallenges.delete(challengeId);
        clearFightRequestLocks(challengeId,user.id,target.id);
        msg.edit(buildFightChallengeStatusPayload(
          "Challenge Expired",
          "This request expired after 60 seconds. No battle was started.",
          0x808080
        )).catch(()=>{});
      },60000);
    } catch(error) {
      if (_state.fightChallenges.get(challengeId)===challenge) _state.fightChallenges.delete(challengeId);
      clearFightRequestLocks(challengeId,user.id,target.id);
      throw error;
    }
    return;
  }

  // ── FIGHT: BOT BATTLE ──────────────────────────────────────────
  if (commandName === "fight" && (fightSubcommand === "bot" || (!fightSubcommand && options.getString("difficulty", false)))) {
    const difficulty=options.getString("difficulty");
    if (_state.activeRequests.has(user.id)) return safeReply(interaction,{embeds:[createErrorEmbed("You have a pending player challenge. Accept, decline, or wait for it to expire before starting another fight.")],flags:64});
    if (isPlayerInFight(user.id)||_state.activeBotFights.has(user.id)) return safeReply(interaction,{embeds:[createErrorEmbed("Already in a fight!")],flags:64});
    const playerData=_state.userSpecies.get(user.id);
    if (!playerData?.species||playerData.species.name==="Human") return safeReply(interaction,{embeds:[createErrorEmbed("You need a species! Use `/species-roll` first.")],flags:64});
    const bsName=botSpeciesByDifficulty[difficulty][Math.floor(Math.random()*botSpeciesByDifficulty[difficulty].length)];
    const bSpecies=getSpeciesByName(bsName), personality=botPersonalities[difficulty];
    const fightId=`bot-${user.id}-${Date.now()}`;
    const fight={
      fightId, playerId:user.id, playerSpecies:playerData.species,
      playerHp:(playerData.species||humanSpecies).hp, playerMaxHp:(playerData.species||humanSpecies).hp,
      playerHealCooldown:0, playerUltCooldown:0, playerUltBuff:null,
      playerAdaptiveStacks:0, playerAttackCounter:0, playerSlimeMissStacks:0, playerBurn:0, playerBurnRounds:0,
      playerCurse:0, playerBlockHeal:false, playerPossession:false, playerStunnedTurns:0, playerLastUltUsed:null,
      botSpecies:bSpecies, botHp:bSpecies.hp, botMaxHp:bSpecies.hp,
      botHealCooldown:0, botUltCooldown:0, botUltBuff:null, botAdaptiveStacks:0, botAttackCounter:0, botSlimeMissStacks:0,
      botBurn:0, botBurnRounds:0, botCurse:0, botPossession:false, botBlockHeal:false, botStunnedTurns:0, botLastUltUsed:null,
      round:1, difficulty, botPersonality:personality, timeout:null, log:[], playerName:user.displayName||user.username,
    };
    _state.activeBotFights.set(fightId,fight); _state.activeBotFights.set(user.id,fightId);
    let msg;
    try {
      msg = await channel.send(buildBotFightMessagePayload(fight, ["Fight started. Your turn."], "playing"));
    } catch(error) {
      if (_state.activeBotFights.get(fightId)===fight) _state.activeBotFights.delete(fightId);
      if (_state.activeBotFights.get(user.id)===fightId) _state.activeBotFights.delete(user.id);
      console.error("[Bot fight "+fightId+"] Failed to post the initial fight message:",error?.stack||error);
      return safeReply(interaction,{embeds:[createErrorEmbed("LOZ couldn't post the battle message, so the fight was cancelled. Please try again.")],flags:64});
    }
    _state.fightMessages.set(fightId,msg);
    fight.timeout=setTimeout(()=>{ if(_state.activeBotFights.get(fightId)===fight) endBotFight(channel,fightId,"bot","player",difficulty,"timeout").catch(error=>console.error("[Bot fight "+fightId+"] Timeout resolution failed:",error?.stack||error)); },120000);
    return safeReply(interaction,{embeds:[createSuccessEmbed("Fight started!")],flags:64});
  }

  if (commandName === "fight" && !fightSubcommand) {
    return safeReply(interaction, {
      embeds:[createErrorEmbed("This /fight command is using an outdated layout. Refresh Discord’s command list, then use /fight player user:@player or /fight bot difficulty:<difficulty>.")],
      flags:64,
    });
  }

  // ── SWITCH ────────────────────────────────────────────────────
  if (commandName === "switch") {
    await interaction.deferReply({flags:MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral});
    const userData=_state.userSpecies.get(user.id);
    if (!userData||!userData.species) return interaction.editReply(buildStyledCardPayload("No Species Yet",0xff0000,[{body:"Use `/species-roll` to begin your adventure."}]));
    const now=Date.now(), threeH=3*60*60*1000;
    if (user.id!==_state.ownerId&&user.id!==_state.secondGodId&&userData.lastSwitch&&now-userData.lastSwitch<threeH) {
      const tl=threeH-(now-userData.lastSwitch), h=Math.floor(tl/3600000), m=Math.floor((tl%3600000)/60000);
      return interaction.editReply(buildStyledCardPayload("Switch Cooldown",0x808080,[{body:`You can switch species again in **${h}h ${m}m**.`}]));
    }
    return interaction.editReply(buildSpeciesSwitchPayload(userData,0));
  }

  // ── FIGHTSTATS ────────────────────────────────────────────────
  if (commandName === "fightstats") {
    const target=options.getUser("user")||user;
    const stats=_state.fightStats.get(target.id);
    const sp=_state.userSpecies.get(target.id)?.species||humanSpecies;
    if (!stats||(stats.wins===0&&stats.losses===0)) return safeReply(interaction,buildStyledCardPayload(`⚔️ ${target.displayName}'s Fight Stats`,0x808080,[{body:"No completed fights recorded yet."}]));
    const total=(stats.wins||0)+(stats.losses||0);
    const wr=total>0?((stats.wins/total)*100).toFixed(1):"0.0";
    return safeReply(interaction,buildStyledCardPayload(`⚔️ ${target.displayName}'s Fight Stats`,sp.color||0xff4500,[
      {heading:"Record",body:`🏆 **Wins:** ${stats.wins||0}\n💔 **Losses:** ${stats.losses||0}\n⚔️ **Total fights:** ${total}`},
      {heading:"Performance",body:`📊 **Win rate:** ${wr}%\n🔥 **Current win streak:** ${stats.streak||0}`},
      {heading:"Current Species",body:`${sp.emoji} **${sp.name}**`},
    ]));
  }

  // ── HISTORY ───────────────────────────────────────────────────
  if (commandName === "history") {
    const target=options.getUser("user")||user;
    const stats=_state.fightStats.get(target.id);
    if (!stats?.history?.length) return safeReply(interaction,buildStyledCardPayload(`📜 ${target.displayName}'s Fight History`,0x808080,[{body:"No fight history recorded yet."}]));
    const total=(stats.wins||0)+(stats.losses||0);
    const wr=total>0?((stats.wins/total)*100).toFixed(1):"0.0";
    let txt="";
    for (let n=0;n<Math.min(stats.history.length,10);n++) {
      const fight=stats.history[n], days=Math.floor((Date.now()-fight.date)/86400000);
      const ago=days===0?"Today":days===1?"Yesterday":`${days} days ago`;
      txt+=`${fight.won?"✅":"❌"} **vs ${fight.opponentName}** · ${ago}\n`;
      txt+=`Opponent: ${fight.opponentSpecies?.emoji||"👤"} ${fight.opponentSpecies?.name||"Unknown"} · HP remaining: **${fight.hpLeft}**${fight.special?` · ${fight.special}`:""}\n\n`;
    }
    return safeReply(interaction,buildStyledCardPayload(`📜 ${target.displayName}'s Fight History`,0x9b59b6,[
      {heading:"Career Summary",body:`**Fights:** ${total}  ·  **Wins:** ${stats.wins||0}  ·  **Losses:** ${stats.losses||0}  ·  **Win rate:** ${wr}%`},
      {heading:`Recent Battles · ${Math.min(stats.history.length,10)}`,body:txt.trim()},
    ]));
  }

  // ── LEADERBOARD ────────────────────────────────────────────────
  if (commandName === "leaderboard") {
    const leaderboardType = options.getString("type", true);
    await interaction.deferReply({ flags:MessageFlags.IsComponentsV2 });

    if (leaderboardType === "fights") {
      const sorted=Array.from(_state.fightLeaderboard.entries())
        .sort((a,b)=>((Number(b[1]?.wins)||0)-(Number(a[1]?.wins)||0))||String(a[0]).localeCompare(String(b[0])))
        .slice(0,10);
      const rows=[];
      for(let n=0;n<sorted.length;n++) {
        const [uid,score]=sorted[n];
        let name="Unknown";
        try {
          const member=guild ? await guild.members.fetch(uid).catch(()=>null) : null;
          if(member) name=member.displayName;
          else { const fetched=await _client.users.fetch(uid).catch(()=>null); if(fetched) name=fetched.username; }
        } catch(_){}
        const species=_state.userSpecies.get(uid)?.species;
        const rank=n===0?"🥇":n===1?"🥈":n===2?"🥉":`**${String(n+1).padStart(2,"0")}.**`;
        rows.push(`${rank} ${species?.emoji||"⚔️"} **${name}**  ·  \`${Number(score?.wins)||0} wins\``);
      }
      return interaction.editReply(buildStyledCardPayload("🏆 LOZ Leaderboard",0xff4500,[
        {heading:"⚔️ Fight Wins",body:rows.length ? `*Top ${rows.length} players · Ranked by wins*\n\n${rows.join("\n")}\n\n*Fight to climb the ranks.*` : "No fight records yet. Start battling to appear here."},
      ]));
    }

    if (leaderboardType === "rolls") {
      const sorted=Array.from(_state.userSpecies.entries())
        .map(([uid,data])=>({uid,data,rolls:Math.max(0,Number(data?.rolls)||0)}))
        .filter(entry=>entry.rolls>0)
        .sort((a,b)=>(b.rolls-a.rolls)||a.uid.localeCompare(b.uid))
        .slice(0,10);
      const rows=[];
      for(let n=0;n<sorted.length;n++) {
        const {uid,data,rolls}=sorted[n];
        let name="Unknown";
        try {
          const member=guild ? await guild.members.fetch(uid).catch(()=>null) : null;
          if(member) name=member.displayName;
          else { const fetched=await _client.users.fetch(uid).catch(()=>null); if(fetched) name=fetched.username; }
        } catch(_){}
        const rank=n===0?"🥇":n===1?"🥈":n===2?"🥉":`**${String(n+1).padStart(2,"0")}.**`;
        rows.push(`${rank} ${data?.species?.emoji||"🎲"} **${name}**  ·  <:reroll_dice:1558042108965822515> **${rolls}**`);
      }
      return interaction.editReply(buildStyledCardPayload("🏆 LOZ Leaderboard",0x0891b2,[
        {heading:"🎲 Species Rolls",body:rows.length ? `*Top ${rows.length} players · Ranked by current rolls*\n\n${rows.join("\n")}\n\n*Earn rolls with \`/daily\` and verified votes.*` : "No unspent rolls to rank yet. Use `/daily` to earn Species Rolls."},
      ]));
    }
  }

  // ── BOTSTATS ──────────────────────────────────────────────────
  if (commandName === "botstats") {
    const target=options.getUser("user")||user;
    const stats=_state.botStats.get(target.id);
    if (!stats) return safeReply(interaction,buildStyledCardPayload(`🤖 ${target.displayName}'s Bot Battle Stats`,0x808080,[{body:"No bot fights recorded yet. Challenge LOZ with `/fight bot` to start."}]));
    const difficulties=[
      {key:"easy",name:"Easy",icon:"🧸"},
      {key:"medium",name:"Medium",icon:"⚔️"},
      {key:"hard",name:"Hard",icon:"👹"},
      {key:"impossible",name:"Impossible",icon:"💀"},
      {key:"brutal",name:"Brutal",icon:"☠️"},
    ];
    let totalWins=0,totalLosses=0;
    const rows=difficulties.map(level=>{
      const wins=stats[level.key]?.wins||0, losses=stats[level.key]?.losses||0;
      totalWins+=wins; totalLosses+=losses;
      const count=wins+losses, rate=count?((wins/count)*100).toFixed(1):"0.0";
      return `${level.icon} **${level.name}**\n🏆 Wins: ${wins} · 💔 Losses: ${losses} · WR: ${rate}%`;
    });
    return safeReply(interaction,buildStyledCardPayload(`🤖 ${target.displayName}'s Bot Battle Stats`,0x9b59b6,[
      {heading:"Overall Record",body:`🏆 **Wins:** ${totalWins}  ·  💔 **Losses:** ${totalLosses}\n📊 **Win rate:** ${totalWins+totalLosses?((totalWins/(totalWins+totalLosses))*100).toFixed(1):"0.0"}%`},
      {heading:"By Difficulty",body:rows.join("\n\n")},
    ]));
  }

  // ── QUEST BOARD ───────────────────────────────────────────────
  if (commandName === "quest") {
    return safeReply(interaction, buildStyledCardPayload("Quest Board", 0x0891b2, [
      { body:"Use /quests to open your quest board, track rotating quests, claim rewards, and vote for LOZ to earn Species Rolls. New quests are added every 12 hours; active quests keep their progress." },
    ], true));
  }
  if (commandName === "quests") {
    try {
      // Loading/creating the persistent board can involve MongoDB I/O.
      await interaction.deferReply({ flags:MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
      return safeReply(interaction, await questSystem.openBoard(user.id, interaction));
    } catch (error) {
      console.error("[Quest board] Could not open board:", error && (error.stack || error));
      return safeReply(interaction, buildStyledCardPayload("Quest Board Unavailable", 0xff0000, [
        { body:"LOZ could not load your saved quest board from MongoDB. No reward was changed. Please retry in a moment." },
      ], true));
    }
  }

  // ── GIFT ──────────────────────────────────────────────────────
  if (commandName === "gift") {
    const target = options.getUser("user");
    const amount = options.getInteger("amount");
    if (target.id===user.id) return safeReply(interaction,{embeds:[createErrorEmbed("You can't gift rolls to yourself!")],flags:64});
    if (target.bot) return safeReply(interaction,{embeds:[createErrorEmbed("You can't gift rolls to a bot!")],flags:64});

    // Reset time: midnight IST = 18:30 UTC previous day
    const now = Date.now();
    function getMidnightISTToday() {
      const d = new Date();
      // IST is UTC+5:30, midnight IST = 18:30 UTC previous day
      d.setUTCHours(18,30,0,0);
      if (Date.now() < d.getTime()) d.setUTCDate(d.getUTCDate()-1);
      return d.getTime();
    }
    const resetTime = getMidnightISTToday();

    const senderData = _state.userSpecies.get(user.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:1,requestsEnabled:true,lastSwitch:0};
    const receiverData = _state.userSpecies.get(target.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:1,requestsEnabled:true,lastSwitch:0};

    // Init gift tracking
    if (!senderData.giftSent) senderData.giftSent={count:0,resetAt:resetTime};
    if (!receiverData.giftReceived) receiverData.giftReceived={count:0,resetAt:resetTime};

    // Reset if past reset time
    if (senderData.giftSent.resetAt < resetTime) senderData.giftSent={count:0,resetAt:resetTime};
    if (receiverData.giftReceived.resetAt < resetTime) receiverData.giftReceived={count:0,resetAt:resetTime};

    // Check limits
    const senderRemaining = 5 - (senderData.giftSent.count||0);
    const receiverRemaining = 5 - (receiverData.giftReceived.count||0);

    if ((senderData.rolls||0)<10) return safeReply(interaction,{embeds:[createErrorEmbed(`You need at least **10 rolls** before gifting. You currently have **${senderData.rolls||0}**. This lets you gift 5 rolls while keeping 5 for yourself.`)],flags:64});
    if (senderRemaining<=0) {
      // Calculate time until next reset (midnight IST = 18:30 UTC)
      const nextReset = resetTime + 86400000;
      const msLeft = nextReset - now;
      const hLeft = Math.floor(msLeft/3600000);
      const mLeft = Math.floor((msLeft%3600000)/60000);
      return safeReply(interaction,{embeds:[createErrorEmbed(`You've used all your gift rolls for today! Resets in **${hLeft}h ${mLeft}m**.`)],flags:64});
    }
    if (receiverRemaining<=0) {
      const nextReset2 = (receiverData.giftReceived.resetAt||resetTime) + 86400000;
      const msLeft2 = nextReset2 - now;
      const hLeft2 = Math.floor(msLeft2/3600000);
      const mLeft2 = Math.floor((msLeft2%3600000)/60000);
      return safeReply(interaction,{embeds:[createErrorEmbed(`<@${target.id}> has already received the maximum rolls they can receive today. Resets in **${hLeft2}h ${mLeft2}m**.`)],flags:64});
    }
    if (amount>senderRemaining) return safeReply(interaction,{embeds:[createErrorEmbed(`You can send **${senderRemaining}** more roll${senderRemaining===1?"":"s"} today. The daily limit is 5.`)],flags:64});
    if (amount>receiverRemaining) return safeReply(interaction,{embeds:[createErrorEmbed(`<@${target.id}> can receive **${receiverRemaining}** more roll${receiverRemaining===1?"":"s"} today. The daily limit is 5.`)],flags:64});
    if ((senderData.rolls||0)<amount) return safeReply(interaction,{embeds:[createErrorEmbed(`You only have **${senderData.rolls||0}** rolls. You cannot gift more than you have.`)],flags:64});
    const actualAmount = amount;

    // Transfer rolls
    senderData.rolls=(senderData.rolls||0)-actualAmount;
    receiverData.rolls=(receiverData.rolls||0)+actualAmount;
    senderData.giftSent.count=(senderData.giftSent.count||0)+actualAmount;
    receiverData.giftReceived.count=(receiverData.giftReceived.count||0)+actualAmount;

    _state.userSpecies.set(user.id,senderData);
    _state.userSpecies.set(target.id,receiverData);
    await Promise.all([database.saveUserSpecies(user.id,senderData),database.saveUserSpecies(target.id,receiverData)]);

    const embed = new EmbedBuilder().setColor(0x6f2da8)
      .setTitle("🎁 A Gift Across the Rift")
      .setDescription(`<@${user.id}> has sent <@${target.id}> **${actualAmount} species roll${actualAmount===1?"":"s"}**.\n\n*Every new roll is another chance to discover a different power.*`)
      .addFields(
        {name:"Your Balance",value:`**${senderData.rolls} rolls** remaining`,inline:true},
        {name:"Recipient Balance",value:`**${receiverData.rolls} rolls** total`,inline:true},
        {name:"Daily Gift Quota",value:`Sent: **${senderData.giftSent.count}/5** rolls\nReceived: **${receiverData.giftReceived.count}/5** rolls`,inline:false}
      )
      .setFooter({text:"Gift limits reset at midnight IST · Minimum pre-gift balance: 10 rolls"})
      .setTimestamp(new Date());
    return safeReply(interaction,{embeds:[embed]});
  }

  // ── TOGGLEREQUESTS ────────────────────────────────────────────
  if (commandName === "togglerequests") {
    const status=options.getString("status");
    const ud=_state.userSpecies.get(user.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0};
    ud.requestsEnabled=(status==="enable"); _state.userSpecies.set(user.id,ud); database.saveUserSpecies(user.id,ud);
    return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(ud.requestsEnabled?0x00ff00:0xff0000).setDescription(ud.requestsEnabled?"✅ You will now receive challenges!":"❌ You will NOT receive challenges.")],flags:64});
  }


  // ── INVENTORY ITEMS ───────────────────────────────────────────
  if (commandName === "items") {
    if (options.getSubcommand() === "use") {
      const item = options.getString("item");
      if (item !== "species_token") {
        return safeReply(interaction, asEphemeralSpeciesTokenPayload(buildSpeciesTokenResultPayload(
          "Item Not Available",
          "That item is not supported yet. Choose an available item from the item dropdown.",
          0xff0000
        )));
      }
      if (isPlayerInFight(user.id) || isPlayerInBotFight(user.id))
        return safeReply(interaction, asEphemeralSpeciesTokenPayload(buildSpeciesTokenResultPayload("Can't Use Items During a Fight", "Finish your active fight before using a Species Token.", 0xff0000)));
      const ud = _state.userSpecies.get(user.id) || { species:humanSpecies, originalSpecies:humanSpecies, questSpecies:{}, rolls:0, speciesTokens:0, requestsEnabled:true, lastSwitch:0, badges:[] };
      const tokenCount = Number(ud.speciesTokens) || 0;
      if (tokenCount < 1)
        return safeReply(interaction, asEphemeralSpeciesTokenPayload(buildSpeciesTokenResultPayload("No Species Tokens", `You don't have any ${SPECIES_TOKEN_EMOJI} Species Tokens. The bot owner can grant them to you.`, 0xff0000)));
      return safeReply(interaction, asEphemeralSpeciesTokenPayload(buildSpeciesTokenSelectionPayload(user.id, null, tokenCount)));
    }
  }

  // ── OWNER COMMANDS ────────────────────────────────────────────
  if (commandName === "owner") {
    if (user.id!==_state.ownerId&&user.id!==_state.secondGodId) return safeReply(interaction,{embeds:[createErrorEmbed("Only an authorized LOZ owner can use this command.")],flags:64});
    const sub=options.getSubcommand();

    if (sub==="ban") {
      const target=options.getUser("user");
      const duration=parseAccessBanDuration(options.getString("time"));
      if (!duration.ok) return safeReply(interaction,{embeds:[createErrorEmbed(duration.error)],flags:64});
      if (target.id===_state.ownerId || target.id===_state.secondGodId || target.id===_client.user.id) {
        return safeReply(interaction,{embeds:[createErrorEmbed("Owner accounts and LOZ itself are protected from access bans.")],flags:64});
      }
      const result=await database.setAccessBan(target.id,{bannedBy:user.id,expiresAt:duration.expiresAt});
      if (!result?.ok) {
        return safeReply(interaction,{embeds:[createErrorEmbed("MongoDB could not confirm this access ban. No success is being reported; check the database before retrying.")],flags:64});
      }
      let dmDelivered=true;
      try {
        const banCard=new ContainerBuilder().setAccentColor(0xdc2626);
        banCard.addTextDisplayComponents(new TextDisplayBuilder().setContent(
          "## ⛔ LOZ Access Ban\nYou have been banned from using **Legends of the Rift (LOZ)**."
        ));
        banCard.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        const expiryText=duration.expiresAt
          ? "**Duration:** "+duration.label+"\n**Expires:** <t:"+Math.floor(duration.expiresAt.getTime()/1000)+":F> (<t:"+Math.floor(duration.expiresAt.getTime()/1000)+":R>)"
          : "**Duration:** Permanent";
        banCard.addTextDisplayComponents(new TextDisplayBuilder().setContent(
          expiryText+"\n\n**Want to appeal?** Join the [LOZ Support Server]("+SUPPORT_SERVER_INVITE+") and submit an appeal."
        ));
        await target.send({components:[banCard],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}});
      } catch(error) {
        dmDelivered=false;
        console.warn("[LOZ Access Bans] Could not DM banned user "+target.id+": "+String(error?.message||error));
      }
      const expiryResult=duration.expiresAt
        ? "\n**Expires:** <t:"+Math.floor(duration.expiresAt.getTime()/1000)+":F>"
        : "\n**Expires:** Never (permanent)";
      const dmResult=dmDelivered ? "The user was notified by DM." : "The ban is active, but Discord did not allow the DM to be delivered.";
      return safeReply(interaction,{embeds:[createSuccessEmbed(
        "Banned <@"+target.id+"> from using LOZ.\n**Duration:** "+duration.label+expiryResult+"\n"+dmResult
      )],flags:64});
    }

    if (sub==="unban") {
      const target=options.getUser("user");
      const result=await database.removeAccessBan(target.id,user.id);
      if (!result?.ok) {
        return safeReply(interaction,{embeds:[createErrorEmbed("MongoDB could not confirm this unban. Please check the database before retrying.")],flags:64});
      }
      if (!result.found) {
        return safeReply(interaction,{embeds:[createErrorEmbed(result.expired
          ? "<@"+target.id+">'s ban has already expired."
          : "<@"+target.id+"> does not currently have an active LOZ access ban.")],flags:64});
      }
      let dmDelivered=true;
      try {
        const unbanCard=new ContainerBuilder().setAccentColor(0x16a34a);
        unbanCard.addTextDisplayComponents(new TextDisplayBuilder().setContent(
          "## ✅ LOZ Access Restored\nYour ban from using **Legends of the Rift (LOZ)** has been lifted. You can use LOZ commands again."
        ));
        unbanCard.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        unbanCard.addTextDisplayComponents(new TextDisplayBuilder().setContent(
          "Your LOZ access has been restored. Welcome back!\n\n[LOZ Support Server]("+SUPPORT_SERVER_INVITE+")"
        ));
        await target.send({components:[unbanCard],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}});
      } catch(error) {
        dmDelivered=false;
        console.warn("[LOZ Access Bans] Could not DM unbanned user "+target.id+": "+String(error?.message||error));
      }
      return safeReply(interaction,{embeds:[createSuccessEmbed(
        "Unbanned <@"+target.id+"> from LOZ."+ (dmDelivered ? " They were notified by DM." : " The unban succeeded, but Discord did not allow the DM to be delivered.")
      )],flags:64});
    }

    if (sub==="clear-fight") {
      const target=options.getUser("user");
      let pvpCleared=0, botCleared=0, challengesCleared=0;

      for (const [fightId,fight] of _state.activeFights.entries()) {
        if (fight?.player1Id!==target.id && fight?.player2Id!==target.id) continue;
        if (fight.timeout) clearTimeout(fight.timeout);
        chaosSystem.cancelChaosReaction(fight);
        const message=_state.fightMessages.get(fightId);
        if (message) await message.edit({
          content:null, embeds:null,
          ...buildStyledCardPayload("Fight Cleared by Owner",0x808080,[
            {body:"An owner cleared this stuck battle. No result or rewards were recorded."},
          ]),
        }).catch(()=>{});
        _state.activeFights.delete(fightId);
        _state.activeRequests.delete(fight.player1Id);
        _state.activeRequests.delete(fight.player2Id);
        _state.fightMessages.delete(fightId);
        pvpCleared++;
      }

      // This map stores both fightId -> fight and playerId -> fightId.
      const botFightRecords=new Map();
      for (const [key,value] of _state.activeBotFights.entries()) {
        const fight=value && typeof value==="object"
          ? value
          : (typeof value==="string" ? _state.activeBotFights.get(value) : null);
        if (fight?.playerId===target.id && fight.fightId) botFightRecords.set(fight.fightId,fight);
      }
      for (const [fightId,fight] of botFightRecords.entries()) {
        if (fight.timeout) clearTimeout(fight.timeout);
        chaosSystem.cancelChaosReaction(fight);
        const message=_state.fightMessages.get(fightId);
        if (message) await message.edit({
          content:null, embeds:null,
          ...buildStyledCardPayload("Fight Cleared by Owner",0x808080,[
            {body:"An owner cleared this stuck battle. No result or rewards were recorded."},
          ]),
        }).catch(()=>{});
        for (const [key,value] of _state.activeBotFights.entries()) {
          if (key===fightId || key===target.id || value===fightId || value===fight) {
            _state.activeBotFights.delete(key);
          }
        }
        _state.fightMessages.delete(fightId);
        botCleared++;
      }

      for (const [challengeId] of _state.fightChallenges.entries()) {
        const [challengerId,opponentId]=challengeId.split("-");
        if (challengerId!==target.id && opponentId!==target.id) continue;
        _state.fightChallenges.delete(challengeId);
        clearFightRequestLocks(challengeId,challengerId,opponentId);
        _state.activeRequests.delete(challengerId);
        _state.activeRequests.delete(opponentId);
        challengesCleared++;
      }
      _state.activeRequests.delete(target.id);
      _state.fightCooldowns.delete(target.id);

      return safeReply(interaction,{embeds:[createSuccessEmbed(
        "Cleared stuck fight state for <@"+target.id+">.\n**PvP fights cleared:** "+pvpCleared
        +"\n**Bot fights cleared:** "+botCleared+"\n**Pending challenges cleared:** "+challengesCleared
        +"\nNo fight wins, losses, or rewards were added."
      )],flags:64});
    }

    if (sub==="species-unlock") {
      const target=options.getUser("user"), speciesName=options.getString("species");
      const current=_state.userSpecies.get(target.id)||{
        species:humanSpecies, originalSpecies:humanSpecies, questSpecies:{}, rolls:0, speciesTokens:0,
        requestsEnabled:true, lastSwitch:0, awakening:{}, badges:[],
      };
      // Work on a copy so a failed MongoDB write cannot leave a grant active in memory.
      const ud={...current,questSpecies:{...(current.questSpecies||{})},awakening:{...(current.awakening||{})}};
      let unlockLabel="";
      if (speciesName==="Reaper") {
        ud.questSpecies.reaper={...(ud.questSpecies.reaper||{}),unlocked:true,equipped:false,godGranted:true};
        unlockLabel="Reaper";
      } else if (speciesName==="Archdemon") {
        ud.awakening.demon={...(ud.awakening.demon||{}),awakened:true};
        unlockLabel="Archdemon";
      } else if (speciesName==="Mechangel") {
        ud.awakening.cyborg={...(ud.awakening.cyborg||{}),awakened:true};
        unlockLabel="Mechangel";
      } else if (speciesName==="Slime Lord") {
        ud.questSpecies.slimeLord={...(ud.questSpecies.slimeLord||{}),unlocked:true,equipped:false,godGranted:true};
        unlockLabel="Slime Lord";
      } else if (speciesName==="Eclipsed Sovereign") {
        ud.awakening.halfBlood={...(ud.awakening.halfBlood||{}),awakened:true};
        unlockLabel="Eclipsed Sovereign";
      } else {
        return safeReply(interaction,{embeds:[createErrorEmbed("That exclusive species cannot be unlocked with this command.")],flags:64});
      }
      const saved=await database.saveUserSpecies(target.id,ud);
      if (!saved) return safeReply(interaction,{embeds:[createErrorEmbed("MongoDB could not confirm this permanent unlock. No success is being reported; check the player's record before retrying.")],flags:64});
      _state.userSpecies.set(target.id,ud);
      return safeReply(interaction,{embeds:[createSuccessEmbed("Permanently unlocked " + unlockLabel + " for <@" + target.id + "> without quest or awakening requirements. Use /switch to equip it.")],flags:64});
    }

    if (sub==="menu") {
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0xffd700).setTitle("👑 Owner Commands")
        .addFields(
          {name:"🧬 Species Management",value:"`/owner species-change @user <species>`\n`/owner species-unlock @user <species>`\n`/owner species-reset @user`\n`/owner species-add @user <rolls>`",inline:false},
          {name:"🎒 Items",value:"`/owner add items @user species_token <quantity>`",inline:false},
          {name:"🛡️ Access & Management",value:"`/owner ban @user [time]`\n`/owner unban @user`\n`/owner clear-fight @user`\n`/owner rolls-reset @user`\n`/owner quest-reset @user <quest>`\n`/owner debug-db`\n`/owner repair-user-db`",inline:false}
        ).setFooter({text:"Use /owner menu to see this again"})]});
    }


    if (options.getSubcommandGroup() === "add" && sub === "items") {
      const target = options.getUser("user");
      const item = options.getString("item");
      const amount = options.getInteger("quantity");
      if (item !== "species_token") return safeReply(interaction, { embeds:[createErrorEmbed("Unknown item. No inventory changes were made.")], flags:64 });
      const result = await database.addSpeciesTokens(target.id, amount);
      if (!result?.ok) return safeReply(interaction, { embeds:[createErrorEmbed("MongoDB could not confirm the token grant. No success is being reported; check the database before retrying.")], flags:64 });
      const ud = _state.userSpecies.get(target.id) || { species:humanSpecies, originalSpecies:humanSpecies, questSpecies:{}, rolls:0, requestsEnabled:true, lastSwitch:0, awakening:{}, badges:[] };
      ud.speciesTokens = result.speciesTokens;
      _state.userSpecies.set(target.id, ud);
      return safeReply(interaction, { embeds:[createSuccessEmbed(`Gave **${amount}** ${SPECIES_TOKEN_EMOJI} Species Token(s) to <@${target.id}>. New balance: **${ud.speciesTokens}**. Saved to MongoDB.`)], flags:64 });
    }

    if (sub==="species-add") {
      const target=options.getUser("user"), amount=options.getInteger("amount");
      const ud=_state.userSpecies.get(target.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0,badges:[]};
      ud.rolls=(ud.rolls||0)+amount; _state.userSpecies.set(target.id,ud);
      if (!await database.saveUserRolls(target.id,ud.rolls)) return safeReply(interaction,{embeds:[createErrorEmbed("MongoDB save failed. This change is not confirmed as saved; check the database before redeploying.")],flags:64});
      return safeReply(interaction,{embeds:[createSuccessEmbed(`Gave **${amount}** rolls to <@${target.id}>! They now have **${ud.rolls}** rolls, saved to MongoDB.`)],flags:64});
    }

    if (sub==="species-change") {
      const target=options.getUser("user"), spname=options.getString("species");
      if (spname==="Chaos Creator" && (user.id!==_state.ownerId || target.id!==_state.ownerId)) {
        return safeReply(interaction,{embeds:[createErrorEmbed("Chaos Creator can only be assigned by the primary owner, to the primary owner account.")],flags:64});
      }
      if (spname==="Kitsune"&&target.id!==_client.user.id) return safeReply(interaction,{embeds:[createErrorEmbed("Kitsune is exclusive to Loz!")],flags:64});
      const newSp=getSpeciesByName(spname);
      if (!newSp) return safeReply(interaction,{embeds:[createErrorEmbed("Unknown species! Pick one from the dropdown.")],flags:64});
      const ud=_state.userSpecies.get(target.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,speciesTokens:0,awakening:{},requestsEnabled:true,lastSwitch:0,badges:[]};
      ud.questSpecies={...(ud.questSpecies||{})};
      ud.awakening={...(ud.awakening||{})};
      // God-given exclusive forms must also set their permanent unlock flags so /switch can equip them later.
      if (spname==="Reaper") ud.questSpecies.reaper={...(ud.questSpecies.reaper||{}),unlocked:true,equipped:false,godGranted:true};
      else if (spname==="Archdemon") ud.awakening.demon={...(ud.awakening.demon||{}),awakened:true};
      else if (spname==="Mechangel") ud.awakening.cyborg={...(ud.awakening.cyborg||{}),awakened:true};
      else if (spname==="Slime Lord") ud.questSpecies.slimeLord={...(ud.questSpecies.slimeLord||{}),unlocked:true,equipped:false,godGranted:true};
      else if (spname==="Eclipsed Sovereign") ud.awakening.halfBlood={...(ud.awakening.halfBlood||{}),awakened:true};
      // God-given species becomes the new original species.
      ud.originalSpecies=newSp;
      ud.species=newSp;
      const isExclusive=["Reaper","Archdemon","Mechangel","Slime Lord","Eclipsed Sovereign","Chaos Creator"].includes(spname);
      const saved=isExclusive
        ? await database.saveUserSpecies(target.id,ud)
        : await database.saveUserSpeciesFields(target.id,ud.species,ud.originalSpecies);
      if (!saved) return safeReply(interaction,{embeds:[createErrorEmbed("MongoDB save failed. This change is not confirmed as saved; check the database before redeploying.")],flags:64});
      _state.userSpecies.set(target.id,ud);
      return safeReply(interaction,{embeds:[createSuccessEmbed(`Changed <@${target.id}>'s species to ${newSp.emoji} **${newSp.name}** and saved it to MongoDB!`)]});
    }

    if (sub==="species-reset") {
      const target=options.getUser("user");
      const ud=_state.userSpecies.get(target.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0,badges:[]};
      ud.species=humanSpecies; ud.originalSpecies=humanSpecies;
      _state.userSpecies.set(target.id,ud);
      if (!await database.saveUserSpeciesFields(target.id,ud.species,ud.originalSpecies)) return safeReply(interaction,{embeds:[createErrorEmbed("MongoDB save failed. This change is not confirmed as saved; check the database before redeploying.")],flags:64});
      return safeReply(interaction,{embeds:[createSuccessEmbed(`Reset <@${target.id}> to 👤 **Human** and saved it to MongoDB.`)]});
    }

    if (sub==="rolls-reset") {
      const target=options.getUser("user");
      const ud=_state.userSpecies.get(target.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0,badges:[]};
      const old=ud.rolls||0; ud.rolls=0; _state.userSpecies.set(target.id,ud);
      if (!await database.saveUserRolls(target.id,ud.rolls)) return safeReply(interaction,{embeds:[createErrorEmbed("MongoDB save failed. This change is not confirmed as saved; check the database before redeploying.")],flags:64});
      return safeReply(interaction,{embeds:[createSuccessEmbed(`Reset **${old}** rolls for <@${target.id}> to 0. Species stays **${ud.species?.name||"Human"}**. Saved to MongoDB.`)],flags:64});
    }

    if (sub==="quest-reset") {
      const target=options.getUser("user"), qn=options.getString("quest");
      const qd=_state.questProgress.get(target.id)||{};
      const blank={easyBots:0,mediumBots:0,hardBots:0,impossibleBots:0,playerFights:0,completed:false,claimed:false};
      if (qn==="reaper"||qn==="all") qd.reaper=blank;
      _state.questProgress.set(target.id,qd); database.saveQuestProgress(target.id,"reaper",qd.reaper);
      return safeReply(interaction,{embeds:[createSuccessEmbed(`Reset ${qn} quest for <@${target.id}>.`)],flags:64});
    }

    if (sub==="repair-user-db") {
      // Explicit owner-invoked maintenance. Database code archives duplicate
      // documents and verifies the archive before marking copies inactive.
      try {
        await interaction.deferReply({ flags:64 });
      } catch(e) {
        console.error("repair-user-db deferReply error:", e);
        return null;
      }

      const result = await database.repairUserRecords();
      if (!result.ok) {
        const details = [
          result.error,
          result.archivedDocuments !== undefined ? `Original documents archived: ${result.archivedDocuments}` : null,
          result.extraDocumentsMarked !== undefined ? `Copies marked inactive: ${result.extraDocumentsMarked}` : null,
          result.groupsRepaired !== undefined ? `Duplicate groups repaired: ${result.groupsRepaired}` : null,
        ].filter(Boolean).join("\n");
        return safeReply(interaction,{embeds:[createErrorEmbed(`Player database repair did not fully complete.\n\n${details}\n\nNo player documents are deleted by this repair.`)],flags:64});
      }

      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x00aa66).setTitle("✅ Player Database Repair Complete").setDescription(
        `**Duplicate groups repaired:** ${result.groupsRepaired}\n**Copies marked inactive:** ${result.extraDocumentsMarked}\n**Original documents archived:** ${result.archivedDocuments}\n**Archive collection:** \`${result.archiveCollection}\`\n**Remaining active duplicate IDs:** ${result.remainingDuplicateUserIdGroups}\n**Active player records:** ${result.activePlayerDocuments}\n**Archived duplicate records retained:** ${result.archivedPlayerDocuments}\n**Active userId unique index:** confirmed\n\nEvery affected original document was copied to the archive collection before duplicate copies were marked inactive. No player documents were deleted.`
      )],flags:64});
    }

    if (sub==="debug-db") {
      // Acknowledge immediately: MongoDB can take longer than Discord's 3-second initial response window.
      try {
        await interaction.deferReply({ flags:64 });
      } catch(e) {
        console.error("debug-db deferReply error:", e);
        return null;
      }

      try {
        const counts = await database.listAllKeys(user.id);
        if (counts.error) {
          return safeReply(interaction,{embeds:[createErrorEmbed(`MongoDB diagnostic failed: ${counts.error}`)],flags:64});
        }
        // Compare persistent MongoDB values with the exact cache /profile reads.
        const liveUser = _state.userSpecies.get(user.id);
        const liveUserState = liveUser ? {
          found: true,
          species: liveUser.species?.name || null,
          originalSpecies: liveUser.originalSpecies?.name || null,
          rolls: Number(liveUser.rolls) || 0,
        } : { found: false };
        const databaseName = counts.databaseName || "unknown";
        const databaseHost = counts.databaseHost || "unknown";
        const usersCollection = counts.usersCollection || "unknown";
        const {
          databaseName:_dbName, databaseHost:_dbHost, usersCollection:_collection,
          debugUser, debugUserRecords=[], debugUserRecordCount=0,
          duplicateUserIdGroups=0, extraDuplicateUserDocs=0,
          hasUniqueUserIdIndex=false, userIdIndexDefinitions=[], uniqueUserIds=0, usersWithoutUserId=0,
          ...recordCounts
        } = counts;
        const lines = Object.entries(recordCounts).map(([k,v])=>`• **${k}**: ${v} records`).join("\n");
        const storedUser = !debugUser?.found
          ? "**MongoDB record:** NOT FOUND"
          : `**MongoDB record (best candidate):** found\n**Stored species:** ${debugUser.species || "none"}\n**Stored original species:** ${debugUser.originalSpecies || "none"}\n**Stored rolls:** ${debugUser.rolls}`;
        const liveUserText = !liveUserState.found
          ? "**LOZ live player state:** NOT LOADED"
          : `**LOZ live player state:** found\n**Live species:** ${liveUserState.species || "none"}\n**Live original species:** ${liveUserState.originalSpecies || "none"}\n**Live rolls:** ${liveUserState.rolls}`;
        const indexText = userIdIndexDefinitions.length
          ? userIdIndexDefinitions.map(index => `${index.name}: \`${index.key}\` (unique=${index.unique}, sparse=${index.sparse}, partial=${index.partial})`).join("\n")
          : "No index containing userId";
        const integrityText = `**Unique active user IDs:** ${uniqueUserIds}\n**Duplicate active userId groups:** ${duplicateUserIdGroups}\n**Extra active duplicate documents:** ${extraDuplicateUserDocs}\n**Active documents without userId:** ${usersWithoutUserId}\n**Active userId unique index:** ${hasUniqueUserIdIndex ? "confirmed" : "MISSING"}\n**userId index definitions:**\n${indexText}`;
        const duplicateDocsText = debugUserRecords.length
          ? `**MongoDB documents for your user (${debugUserRecordCount}):**\n${debugUserRecords.map((r,i)=>`${i+1}. ID \`${r.documentId}\` — species: ${r.species || "none"}, original: ${r.originalSpecies || "none"}, rolls: ${r.rolls} (score ${r.score})`).join("\n")}`
          : "**MongoDB documents for your user:** none";
        return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0xffd700).setTitle("📊 MongoDB Persistence Check").setDescription(`**Database:** \`${databaseName}\`\n**MongoDB host:** \`${databaseHost}\`\n**Users collection:** \`${usersCollection}\`\n**Players in live cache:** ${_state.userSpecies.size}\n\n${storedUser}\n\n${liveUserText}\n\n${integrityText}\n\n${duplicateDocsText}\n\n${lines||"No data found."}\n\nDuplicate records can cause later blank documents to overwrite complete profiles during loading. No records are deleted by this diagnostic.`)],flags:64});
      } catch(e) {
        console.error("debug-db command error:", e);
        return safeReply(interaction,{embeds:[createErrorEmbed(`DB diagnostic error: ${e?.message || String(e)}`)],flags:64});
      }
    }
  }
}

// ==================== BUTTON HANDLER ====================
async function handleButton(interaction) {
  const { customId, user, guild, channel, message } = interaction;

  if (customId.startsWith("switch_page_")) {
    const ud=_state.userSpecies.get(user.id);
    if (!ud || !ud.species)
      return interaction.update(buildStyledCardPayload("Species Data Unavailable",0xff0000,[{body:"No species data was found. Use /species-roll to begin."}]));
    const page=Number(customId.slice("switch_page_".length));
    return interaction.update(buildSpeciesSwitchPayload(ud,Number.isInteger(page)?page:0));
  }

  // ── LOZ 6.0 EVENT REGISTRATION ─────────────────────────────────
  if (customId === "loz60_event_interested" || customId === "loz60_event_not_interested") {
    const interested = customId === "loz60_event_interested";
    const saved = await database.recordLoz60EventResponse(user.id, interested);
    if (!saved) {
      return safeReply(interaction, { content:"Couldn't save your LOZ 6.0 event response. Please try again.", flags:64 });
    }

    const statusText = interested
      ? (saved.alreadySelected
          ? "You're already registered for LOZ 6.0. Your launch-reward eligibility is saved."
          : "You've registered for the LOZ 6.0 update. Your launch rewards will be available when the update drops.")
      : (saved.alreadySelected
          ? "Your choice is already saved. You're not registered for LOZ 6.0 launch rewards."
          : "No problem. You're not registered for LOZ 6.0 launch rewards. You can still read the Rift Lore on the website.");

    const title = interested
      ? (saved.alreadySelected ? "Already Registered" : "You're Registered!")
      : "Not Interested";
    const color = interested ? 0x00aa66 : 0x64748b;

    if (guild) {
      // The public event post stays up for other members; only this user's
      // ephemeral acknowledgement is removed after 10 seconds.
      await interaction.reply(buildLoz60EventResultPayload(title, statusText, color, true));
      scheduleLoz60PromptDeletion(() => interaction.deleteReply().catch(() => {}));
      return;
    }

    // DMs are personal: replace the prompt with the user's result, then remove
    // that DM message after 10 seconds.
    await interaction.update(buildLoz60EventResultPayload(title, statusText, color, false));
    scheduleLoz60PromptDeletion(() => message.delete().catch(() => {}));
    return;
  }

  // ── UPDATE SUBSCRIPTION PROMPT ─────────────────────────────────
  if (customId.startsWith("loz_updates_prompt_subscribe_")) {
    const expectedUserId = customId.slice("loz_updates_prompt_subscribe_".length);
    if (user.id !== expectedUserId) return safeReply(interaction, { content:"This subscription prompt belongs to another user.", flags:64 });
    const saved = await database.setBroadcastOptIn(user.id, true);
    if (!saved) return interaction.update(buildUpdateSubscriptionResultPayload(
      "Subscription Not Saved",
      "MongoDB couldn't save your preference. Please try again with `/updates subscribe`.",
      0xff0000
    ));
    return interaction.update(buildUpdateSubscriptionResultPayload(
      "You're Subscribed!",
      "You'll receive major LOZ update announcements by DM, including news about events and update rewards when available. You can unsubscribe any time with `/updates unsubscribe`.",
      0x00aa66
    ));
  }

  if (customId.startsWith("loz_updates_prompt_later_")) {
    const expectedUserId = customId.slice("loz_updates_prompt_later_".length);
    if (user.id !== expectedUserId) return safeReply(interaction, { content:"This subscription prompt belongs to another user.", flags:64 });
    const saved = await database.dismissUpdateSubscriptionPrompt(user.id);
    if (!saved) return interaction.update(buildUpdateSubscriptionResultPayload(
      "Couldn't Save Your Choice",
      "Your choice couldn't be saved. Use `/updates subscribe` whenever you'd like to opt in.",
      0xff0000
    ));
    return interaction.update(buildUpdateSubscriptionResultPayload(
      "No Problem",
      "You aren't subscribed. We may ask again occasionally, and you can subscribe any time with `/updates subscribe`."
    ));
  }

  // ── SPECIES TOKEN FLOW ─────────────────────────────────────────
  if (customId.startsWith("species_token_cancel_")) {
    const expectedUserId = customId.slice("species_token_cancel_".length);
    if (user.id !== expectedUserId) return safeReply(interaction, { content:"This token menu belongs to another player.", flags:64 });
    return interaction.update(buildSpeciesTokenResultPayload("Selection Cancelled", "No Species Token was used. Your species has not changed."));
  }
  if (customId.startsWith("species_token_review_")) {
    const parsed = parseSpeciesTokenCustomId(customId, "review");
    if (!parsed || parsed.userId !== user.id) return safeReply(interaction, { content:"This token menu belongs to another player.", flags:64 });
    if (!isSpeciesTokenEligible(parsed.speciesName)) return interaction.update(buildSpeciesTokenResultPayload("Invalid Species", "Choose an available species from the dropdown.", 0xff0000));
    if (isPlayerInFight(user.id) || isPlayerInBotFight(user.id)) return interaction.update(buildSpeciesTokenResultPayload("Can't Change Species During a Fight", "Finish your active fight first.", 0xff0000));
    const ud = _state.userSpecies.get(user.id);
    const tokenCount = Number(ud?.speciesTokens) || 0;
    if (tokenCount < 1) return interaction.update(buildSpeciesTokenResultPayload("No Species Tokens", "Your balance is empty. No token was used.", 0xff0000));
    return interaction.update(buildSpeciesTokenConfirmPayload(user.id, parsed.speciesName, tokenCount));
  }
  if (customId.startsWith("species_token_back_")) {
    const parsed = parseSpeciesTokenCustomId(customId, "back");
    if (!parsed || parsed.userId !== user.id) return safeReply(interaction, { content:"This token menu belongs to another player.", flags:64 });
    return interaction.update(buildSpeciesTokenSelectionPayload(user.id,
      isSpeciesTokenEligible(parsed.speciesName) ? parsed.speciesName : null,
      Number(_state.userSpecies.get(user.id)?.speciesTokens)||0));
  }
  if (customId.startsWith("species_token_confirm_")) {
    const parsed = parseSpeciesTokenCustomId(customId, "confirm");
    if (!parsed || parsed.userId !== user.id) return safeReply(interaction, { content:"This token menu belongs to another player.", flags:64 });
    if (!isSpeciesTokenEligible(parsed.speciesName)) return interaction.update(buildSpeciesTokenResultPayload("Invalid Species", "This species cannot be selected with a Species Token.", 0xff0000));
    if (isPlayerInFight(user.id) || isPlayerInBotFight(user.id)) return interaction.update(buildSpeciesTokenResultPayload("Can't Change Species During a Fight", "Finish your active fight first. No token was used.", 0xff0000));
    const ud = _state.userSpecies.get(user.id);
    if ((Number(ud?.speciesTokens)||0) < 1) return interaction.update(buildSpeciesTokenResultPayload("No Species Tokens", "Your balance is empty. No token was used.", 0xff0000));
    const selectedSpecies = getSpeciesByName(parsed.speciesName);
    if (ud?.species?.name === selectedSpecies.name) return interaction.update(buildSpeciesTokenSelectionPayload(user.id, parsed.speciesName, Number(ud.speciesTokens)||0));
    const redemption = await database.redeemSpeciesToken(user.id, selectedSpecies);
    if (redemption?.sameSpecies) {
      const alreadyUpdated = ud || { species:humanSpecies, originalSpecies:humanSpecies, questSpecies:{}, rolls:0, requestsEnabled:true, lastSwitch:0, awakening:{}, badges:[] };
      alreadyUpdated.species = selectedSpecies;
      alreadyUpdated.originalSpecies = selectedSpecies;
      alreadyUpdated.speciesTokens = redemption.speciesTokens;
      _state.userSpecies.set(user.id, alreadyUpdated);
      return interaction.update(buildSpeciesTokenResultPayload(
        "Species Already Changed",
        `Your species is already ${selectedSpecies.emoji} **${selectedSpecies.name}**. This confirmation did not consume an extra token. Current balance: **${redemption.speciesTokens}**.`,
        selectedSpecies.color || 0x0891b2
      ));
    }
    if (!redemption?.ok) {
      const explanation = redemption?.noTokens
        ? "MongoDB reports that no Species Tokens remain. No additional species change was made."
        : "MongoDB could not confirm the species change. No local change was applied; check the database before retrying.";
      return interaction.update(buildSpeciesTokenResultPayload("Species Change Not Applied", explanation, 0xff0000));
    }
    const updated = ud || { species:humanSpecies, originalSpecies:humanSpecies, questSpecies:{}, rolls:0, requestsEnabled:true, lastSwitch:0, awakening:{}, badges:[] };
    updated.species = selectedSpecies;
    updated.originalSpecies = selectedSpecies;
    updated.speciesTokens = redemption.speciesTokens;
    _state.userSpecies.set(user.id, updated);
    return interaction.update(buildSpeciesTokenResultPayload("Species Changed",
      `Your species is now ${selectedSpecies.emoji} **${selectedSpecies.name}**.\n\nUsed **1** ${SPECIES_TOKEN_EMOJI}. Remaining balance: **${redemption.speciesTokens}**.\n\nThe species change and token deduction have been saved to MongoDB.`,
      selectedSpecies.color || 0x0891b2));
  }

  if (customId.startsWith("servers_page_")) {
    const parts = customId.slice("servers_page_".length).split("_");
    const expectedOwnerId = parts[0];
    const targetPage = Number.parseInt(parts[1], 10);
    if (user.id !== _state.ownerId || expectedOwnerId !== _state.ownerId) {
      return safeReply(interaction, { content:"Owner only.", flags:64 });
    }
    if (!Number.isInteger(targetPage) || targetPage < 0) {
      return safeReply(interaction, { content:"Invalid page.", flags:64 });
    }
    await interaction.deferUpdate();
    return interaction.editReply(await buildServersPagePayload(targetPage, user.id));
  }

  // ── CLOSE HELP DIRECTORY ───────────────────────────────────────
  if (customId === "help_close") {
    await interaction.deferUpdate();
    return message.delete().catch(() => {});
  }

  // ── PAGINATED HELP DIRECTORY ───────────────────────────────────
  if (customId.startsWith("help_page_")) {
    const pageIndex = Number.parseInt(customId.slice("help_page_".length), 10);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= HELP_PAGES.length) {
      return safeReply(interaction,{content:"That help page is unavailable. Run /help to reopen the command directory.",flags:64});
    }
    return interaction.update(buildHelpPayload(pageIndex));
  }

  // ── GUIDE NAVIGATION AND ONE-TIME COMPLETION REWARD ─────────────
  if (customId.startsWith("guide_page_")) {
    const parts=customId.slice("guide_page_".length).split("_");
    const expectedUserId=parts[0];
    const pageIndex=Number.parseInt(parts[1],10);
    if (user.id!==expectedUserId) return safeReply(interaction,{content:"This guide belongs to another player. Run `/guide` to start your own.",flags:64});
    if (!Number.isInteger(pageIndex)||pageIndex<0||pageIndex>=GUIDE_PAGES.length)
      return safeReply(interaction,{content:"That guide page is unavailable. Run `/guide` to reopen the guide.",flags:64});
    return interaction.update(buildGuidePayload(user.id,user.displayName||user.username,pageIndex));
  }

  if (customId.startsWith("guide_complete_")) {
    const expectedUserId=customId.slice("guide_complete_".length);
    if (user.id!==expectedUserId) return safeReply(interaction,{content:"This guide belongs to another player.",flags:64});
    await interaction.deferUpdate();
    const reward=await database.awardGuideCompletionRoll(user.id);
    if (!reward?.ok) {
      const failure = buildStyledCardPayload(
        "Tutorial Completed, Reward Unconfirmed",
        0xff0000,
        [{body:"The tutorial is complete, but MongoDB couldn't confirm your reward. Your roll balance has not been changed in the local cache. Please contact the LOZ team before retrying."}]
      );
      return interaction.editReply({
        components:[new TextDisplayBuilder().setContent(`<@${user.id}>'s LOZ Guide`),...failure.components],
        flags:MessageFlags.IsComponentsV2,
        allowedMentions:{parse:[]},
      });
    }

    const userData=_state.userSpecies.get(user.id)||{
      species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},
      rolls:0,speciesTokens:0,requestsEnabled:true,lastSwitch:0,
      awakening:{},badges:[],guideRewardClaimed:false,
    };
    userData.rolls=reward.rolls;
    userData.guideRewardClaimed=true;
    _state.userSpecies.set(user.id,userData);
    return interaction.editReply(buildGuideCompletionPayload(user.id,reward.awarded,reward.rolls));
  }


  // ── REROLL ────────────────────────────────────────────────────
  if (customId.startsWith("reroll_")||customId.startsWith("cancel_")) {
    const uid=customId.slice(customId.indexOf("_")+1);
    if (user.id!==uid) return safeReply(interaction,{content:"This isn't your Species Roll.",flags:MessageFlags.Ephemeral});
    const rollData=_state.activeRolls.get(user.id);
    if (!rollData || rollData.messageId!==interaction.message.id)
      return interaction.update(buildStyledCardPayload("Species Roll Expired",0x808080,[{body:"Run `/species-roll` to start a new roll."}],false));
    if (customId.startsWith("cancel_")) {
      _state.activeRolls.delete(user.id);
      return interaction.update(buildStyledCardPayload("Species Roll Cancelled",0x808080,[{body:"You kept your current species. No roll was used."}],false));
    }
    const userData=_state.userSpecies.get(user.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:1,requestsEnabled:true,lastSwitch:0};
    if ((userData.rolls||0)<1) {
      _state.activeRolls.delete(user.id);
      return interaction.update(buildStyledCardPayload("No Rolls Left",0xff0000,[{body:"Use `/daily` for a free roll."}],false));
    }
    const rollResult=getRandomSpecies();
    const newSpecies=rollResult.isDragon?getDragonSubtype():rollResult;
    userData.species=newSpecies;
    userData.originalSpecies=newSpecies;
    userData.rolls=(userData.rolls||0)-1;
    _state.userSpecies.set(user.id,userData);
    if(userData.rolls<1) _state.activeRolls.delete(user.id);
    database.saveUserSpecies(user.id,userData).catch(console.error);
    return interaction.update(buildSpeciesRollAnnouncement(user.id,user.displayName||user.username,newSpecies,userData.rolls,true));
  }

  // ── SWITCH ────────────────────────────────────────────────────
  if (customId==="switch_original"||customId==="switch_reaper"||customId==="switch_archdemon"||customId==="switch_mechangel"||customId==="switch_slime_lord"||customId==="switch_eclipsed_sovereign") {
    const ud=_state.userSpecies.get(user.id);
    if (!ud) return interaction.update(buildStyledCardPayload("Switch Failed",0xff0000,[{body:"No species data was found."}]));
    const now=Date.now(), th=3*60*60*1000;
    if (user.id!==_state.ownerId&&user.id!==_state.secondGodId&&ud.lastSwitch&&now-ud.lastSwitch<th) {
      const tl=th-(now-ud.lastSwitch), h=Math.floor(tl/3600000), m=Math.floor((tl%3600000)/60000);
      return interaction.update(buildStyledCardPayload("Switch Cooldown",0x808080,[{body:`You can switch again in **${h}h ${m}m**.`}]));
    }
    let newSp;
    if (customId==="switch_original") newSp=ud.originalSpecies;
    else if (customId==="switch_reaper") { if(!ud.questSpecies?.reaper?.unlocked && ud.originalSpecies?.name!=="Reaper") return interaction.update(buildStyledCardPayload("Species Locked",0x808080,[{body:"Reaper has not been unlocked for your account."}])); newSp=reaperSpecies; }
    else if (customId==="switch_archdemon") { if(ud.awakening?.demon?.awakened!==true && ud.originalSpecies?.name!=="Archdemon") return interaction.update(buildStyledCardPayload("Species Locked",0x808080,[{body:"Complete the Demon awakening before equipping Archdemon."}])); newSp=archdemonSpecies; }
    else if (customId==="switch_slime_lord") { if(ud.questSpecies?.slimeLord?.unlocked!==true && ud.originalSpecies?.name!=="Slime Lord") return interaction.update(buildStyledCardPayload("Species Locked",0x808080,[{body:"Defeat the rare Slime Lord boss or ask God to permanently unlock this species."}])); newSp=getSpeciesByName("Slime Lord"); }
    else if (customId==="switch_eclipsed_sovereign") { if(ud.awakening?.halfBlood?.awakened!==true && ud.originalSpecies?.name!=="Eclipsed Sovereign") return interaction.update(buildStyledCardPayload("Species Locked",0x808080,[{body:"Complete the Half-Blood awakening or ask God to permanently unlock this species."}])); newSp=getSpeciesByName("Eclipsed Sovereign"); }
    else {
      if (ud.awakening?.cyborg?.awakened!==true && ud.originalSpecies?.name!=="Mechangel") return interaction.update(buildStyledCardPayload("Species Locked",0x808080,[{body:"Complete the Cyborg awakening before equipping Mechangel."}]));
      newSp=getSpeciesByName("Mechangel");
    }
    if (!newSp) return interaction.update(buildStyledCardPayload("Switch Failed",0xff0000,[{body:"That species is unavailable."}]));
    ud.species=newSp; ud.lastSwitch=Date.now();
    _state.userSpecies.set(user.id,ud);
    await database.saveUserSpecies(user.id,ud);
    return interaction.update(buildStyledCardPayload("Species Switched",newSp.color||0x9b59b6,[{body:`Your species is now ${newSp.emoji} **${newSp.name}**. Your next switch is available in 3 hours.`}]));
  }

  // ── DUEL ACCEPT/DECLINE ───────────────────────────────────────
  if (customId==="accept_duel"||customId==="decline_duel") {
    let cid=null, cd=null;
    for (const [id,d] of _state.challenges.entries()) { if(d.messageId===message.id){cid=id;cd=d;break;} }
    if (!cd) return safeReply(interaction,{embeds:[createErrorEmbed("Challenge expired.")],flags:64});
    if (user.id!==cd.opponentId) return safeReply(interaction,{embeds:[createErrorEmbed("This isn't your challenge!")],flags:64});
    _state.challenges.delete(cid); _state.activeRequests.delete(cd.challengerId); _state.activeRequests.delete(cd.opponentId);
    if (customId==="decline_duel") {
      await message.edit({embeds:[new EmbedBuilder().setColor(0xff0000).setDescription(`🏃 <@${cd.opponentId}> ran away!`)],components:[]});
      return safeReply(interaction,{embeds:[createErrorEmbed("You ran away!")],flags:64});
    }
    await message.edit({embeds:[new EmbedBuilder().setColor(0x00ff00).setDescription(`✅ <@${cd.opponentId}> accepted! Starting...`)],components:[]});
    // Duel game removed
    return safeReply(interaction,{content:"Match accepted!",flags:64});
  }

  // ── BOT DIFFICULTY ────────────────────────────────────────────


  // ── FIGHT ACCEPT/REJECT ───────────────────────────────────────
  if (customId.startsWith("fight_accept_")||customId.startsWith("fight_reject_")) {
    const parts=customId.split("_"), action=parts[1], challengerId=parts[2], opponentId=parts[3];
    if (user.id!==opponentId) return safeReply(interaction,{embeds:[createErrorEmbed("This challenge does not belong to you.")],flags:64});
    const challengeId=challengerId + "-" + opponentId;
    const challenge=_state.fightChallenges.get(challengeId);
    if (!challenge) return safeReply(interaction,{embeds:[createErrorEmbed("Challenge expired.")],flags:64});
    if (action==="reject") {
      _state.fightChallenges.delete(challengeId);
      clearFightRequestLocks(challengeId,challengerId,opponentId);
      await message.edit(buildFightChallengeStatusPayload(
        "Fight Challenge Declined",
        "<@" + opponentId + "> declined the challenge. Both players can send or receive another challenge now.",
        0xdc2626,
        [opponentId]
      ));
      return safeReply(interaction,{embeds:[createErrorEmbed("Fight rejected.")],flags:64});
    }
    const cd2=_state.userSpecies.get(challengerId), od=_state.userSpecies.get(opponentId);
    if (!cd2?.species||cd2.species.name==="Human"||!od?.species||od.species.name==="Human") {
      _state.fightChallenges.delete(challengeId);
      clearFightRequestLocks(challengeId,challengerId,opponentId);
      await message.edit(buildFightChallengeStatusPayload(
        "Fight Cancelled",
        "One player no longer has an eligible species. The challenge has been cancelled.",
        0xdc2626
      ));
      return safeReply(interaction,{embeds:[createErrorEmbed("Fight cancelled — species missing!")],flags:64});
    }
    _state.fightChallenges.delete(challengeId);
    try {
      await message.edit(buildFightChallengeStatusPayload(
        "Challenge Accepted",
        "<@" + opponentId + "> accepted. The battle is starting now. Both players stay locked to this match until it ends.",
        0x16a34a,
        [opponentId]
      )).catch(()=>{});
      await safeReply(interaction,{content:"Fight accepted!",flags:64});
      await startFight(channel,challengerId,opponentId);
    } catch(error) {
      clearFightRequestLocks(challengeId,challengerId,opponentId);
      await message.edit(buildFightChallengeStatusPayload(
        "Fight Cancelled",
        "LOZ could not start this battle. Both players have been released from the challenge lock.",
        0xdc2626
      )).catch(()=>{});
      throw error;
    }
    return;
  }

  // ── BOT FIGHT BUTTONS ─────────────────────────────────────────
  if (customId.startsWith("botfight_")) {
    const parts=customId.split("_");
    let action=parts[1];
    if (action==="choice") {
      const choiceType=parts[2], choice=parts[3], fightId=parts.slice(4).join("_");
      const fight=_state.activeBotFights.get(fightId);
      if (!fight||user.id!==fight.playerId) return interaction.deferUpdate();
      if (fight.timeout) clearTimeout(fight.timeout);
      const log=fight.log||[];
      if (choiceType==="angel") {
        if (choice==="smite") { fight.playerUltBuff={type:"nextAttack",multiplier:1.5,angelHeal:true}; log.push("👼 **DIVINE BLESSING — SMITE!** 1.5× + heal 35% HP!"); }
        else { const h=Math.floor(fight.playerHp*0.6); fight.playerHp=Math.min(fight.playerMaxHp,fight.playerHp+h); log.push(`👼 **DIVINE BLESSING — PRAYER!** Healed ${h} HP!`); }
      } else if (choiceType==="ice") {
        if (choice==="attack") { fight.playerUltBuff={type:"nextAttack",multiplier:1.9}; log.push("❄️ **GLACIAL SPIKE — ATTACK!** 1.9×!"); }
        else { fight.playerUltBuff={type:"iceHealBoost"}; log.push("❄️ **GLACIAL SPIKE — HEAL!** Next heal +50%!"); }
      } else if (choiceType==="earth") {
        if (choice==="attack") { fight.playerUltBuff={type:"nextAttack",multiplier:1.2}; log.push("🌍 **TERRA STRIKE!** 1.2× next attack!"); }
        else { fight.playerUltBuff={type:"earthDamageReduction"}; log.push("🌍 **TERRA SHIELD — DEFENSE!** −60% dmg!"); }
      }
      fight.playerUltCooldown=fight.playerSpecies.ultCooldown; fight.log=log.slice(-3);
      const msg=_state.fightMessages.get(fightId);
      if (msg) await msg.edit({ content: null, embeds: null, ...buildBotFightMessagePayload(fight, fight.log, "bot_thinking", "bot_thinking") }).catch(() => {});
      setTimeout(()=>doBotTurn(channel,fightId),botPersonalities[fight.difficulty].reactionDelay);
      return interaction.deferUpdate();
    }

    const fightId=parts.slice(2).join("_");
    const fight=_state.activeBotFights.get(fightId);
    if (!fight) return safeReply(interaction,{embeds:[createErrorEmbed("Fight ended!")],flags:64});
    if (user.id!==fight.playerId) return safeReply(interaction,{embeds:[createErrorEmbed("This isn't your fight!")],flags:64});
    if (fight.pendingChaosReaction) return safeReply(interaction,{content:"A Chaos Creator reaction is awaiting the primary owner's decision.",flags:64});
    if (action==="thinking") return safeReply(interaction,{embeds:[createErrorEmbed("It's the bot's turn!")],flags:64});
    if (fight.timeout) clearTimeout(fight.timeout);
    await interaction.deferUpdate();
    const msg=_state.fightMessages.get(fightId);
    const log=fight.log||[];

    if (action==="forfeit") { await endBotFight(channel,fightId,"bot","player",fight.difficulty); return; }

    const playerC={id:fight.playerId,species:fight.playerSpecies,currentHp:fight.playerHp,maxHp:fight.playerMaxHp,ultBuff:fight.playerUltBuff,adaptiveStacks:fight.playerAdaptiveStacks||0,attackCounter:fight.playerAttackCounter||0,slimeMissStacks:fight.playerSlimeMissStacks||0,burn:fight.playerBurn||0,burnRounds:fight.playerBurnRounds||0,curse:fight.playerCurse||0,blockHeal:fight.playerBlockHeal||false,possession:fight.playerPossession||false,stunnedTurns:fight.playerStunnedTurns||0,healCooldown:fight.playerHealCooldown,ultCooldown:fight.playerUltCooldown,lastUltUsed:fight.playerLastUltUsed};
    const botC={id:"BOT",species:fight.botSpecies,currentHp:fight.botHp,maxHp:fight.botMaxHp,ultBuff:fight.botUltBuff,adaptiveStacks:fight.botAdaptiveStacks||0,attackCounter:fight.botAttackCounter||0,slimeMissStacks:fight.botSlimeMissStacks||0,burn:fight.botBurn||0,burnRounds:fight.botBurnRounds||0,curse:fight.botCurse||0,blockHeal:fight.botBlockHeal||false,possession:fight.botPossession||false,stunnedTurns:fight.botStunnedTurns||0,healCooldown:fight.botHealCooldown,ultCooldown:fight.botUltCooldown,lastUltUsed:fight.botLastUltUsed};

    // Oni possession consumes the target's next action.
    if (playerC.possession) action="possessed";

    let chaosDisintegrateConfirmed = false;
    if (action==="ult" && user.id===chaosSystem.PRIMARY_OWNER_ID
      && playerC.species.name==="Chaos Creator" && playerC.ultCooldown<=0) {
      const targetName = fight.botSpecies?.name || "opponent";
      const decision = await chaosSystem.askChaosReaction({
        fight, channel,
        question:"Do you want to disintegrate this individual named " + targetName + "?",
        confirmedText:"Disintegrating this individual named " + targetName + ".",
        declinedText:"Disintegration cancelled.",
      });
      if (!_state.activeBotFights.has(fightId)) return;
      if (!decision.confirmed) {
        fight.timeout = setTimeout(() => {
          if (_state.activeBotFights.get(fightId) === fight) {
            endBotFight(channel,fightId,"bot","player",fight.difficulty,"timeout")
              .catch(error => console.error("[Chaos Creator] Bot fight timeout failed:",error?.stack||error));
          }
        },60000);
        return;
      }
      chaosDisintegrateConfirmed = true;
      fight.chaosDisintegrated = true;
    }

    if (action==="possessed") {
      playerC.possession=false;
      const rawSelfHit=Math.floor(Math.random()*(playerC.species.atkMax-playerC.species.atkMin+1))+playerC.species.atkMin;
      const selfHit=playerC.species.name==="Chaos Creator"?Math.ceil(rawSelfHit*0.5):rawSelfHit;
      playerC.currentHp=Math.max(0,playerC.currentHp-selfHit);
      log.push(`🎭 **POSSESSION!** You are forced to attack yourself for ${selfHit}!`);
    } else if (action==="heal") {
      if (playerC.blockHeal) { playerC.blockHeal=false; log.push("🚫 **ROYAL COMMAND!** You can't heal!"); }
      else if (playerC.healCooldown>0) { log.push(`❌ Heal on cooldown for ${playerC.healCooldown} more rounds!`); }
      else if (playerC.currentHp>=playerC.maxHp*0.8) { log.push("❌ HP above 80% — too healthy to heal!"); }
      else {
        let mult=1;
        if (playerC.ultBuff?.type==="iceHealBoost") { mult=1.5; playerC.ultBuff=null; log.push("❄️ Glacial Spike boosts heal!"); }
        let rawH=Math.floor((Math.floor(Math.random()*(playerC.species.healMax-playerC.species.healMin+1))+playerC.species.healMin)*mult);
        // Low HP desperation rule: <15% HP
        if (playerC.currentHp<playerC.maxHp*0.15) {
          if (Math.random()<0.75) { rawH=Math.floor(rawH*0.5); log.push("💔 **Shaking hands!** Desperate heal only 50% effective!"); }
          else { rawH=Math.floor(rawH*1.3); log.push("✨ **Miracle heal!** +30% bonus from desperation!"); }
        }
        const actualH=playerC.curse>0?Math.floor(rawH*0.5):rawH;
        if (playerC.curse>0) log.push(`👿 Curse halves heal! ${rawH}→${actualH}`);
        playerC.currentHp=Math.min(playerC.maxHp,playerC.currentHp+actualH); playerC.healCooldown=3;
        log.push(`💚 You heal for **${actualH} HP**! (${playerC.currentHp}/${playerC.maxHp})`);
      }
    } else if (action==="ult") {
      if (playerC.ultCooldown>0) { log.push(`❌ ULT on cooldown for ${playerC.ultCooldown} more rounds!`); }
      else {
        let um, requiresChoice=false, choiceType=null;
        if (chaosDisintegrateConfirmed) {
          um = "Disintegrating this individual named " + (fight.botSpecies?.name || "opponent") + ".";
          botC.currentHp = 0;
        } else {
          ({message:um,requiresChoice,choiceType}=applyUltEffect(playerC,botC));
        }
        fight.playerUltBuff=playerC.ultBuff;
        fight.playerLastUltUsed=playerC.lastUltUsed;
        await questSystem.trackProgress(user.id,"ults",1);
        if (requiresChoice) {
          fight.playerUltBuff=playerC.ultBuff; fight.playerUltCooldown=playerC.species.ultCooldown;
          fight.botHp=botC.currentHp; fight.playerHp=playerC.currentHp; fight.log=log.slice(-3);
          if (msg) await msg.edit({ content: null, embeds: null, ...buildBotFightMessagePayload(fight, fight.log, "choice", "choice_" + choiceType) }).catch(() => {});
          fight.timeout=setTimeout(()=>{ if(_state.activeBotFights.has(fightId)){fight.playerUltBuff={type:"nextAttack",multiplier:1.5}; doBotTurn(channel,fightId);} },30000);
          return;
        }
        fight.playerUltCooldown=playerC.species.ultCooldown;
        if (playerC.species.name==="Cyborg") await updateCyborgProgress(fight.playerId,"ult");
        if (playerC.species.name==="Half-Blood") await updateHalfBloodProgress(fight.playerId,"ult",1,playerC.species.name);
        if (playerC.species.name==="Ogre") botC.stunnedTurns=1;
        fight.playerHp=Math.max(0,playerC.currentHp); fight.botHp=Math.max(0,botC.currentHp); fight.botUltBuff=botC.ultBuff;
        log.push(`✨ **YOU USE ULT!**\n${um}`);
      }
    } else if (action==="attack") {
      const result=calculateDamage(playerC,botC);
      if (result.damage > 0) await questSystem.trackProgress(user.id,"damage",result.damage);
      playerC.currentHp=Math.max(0,Math.min(playerC.maxHp,playerC.currentHp+result.attackerMutations.hpDelta));
      if (result.instantKill) {
        botC.currentHp=0;
        log.push(`⚔️ ${result.specialLines.join(" ")}`);
      } else if (result.missedAttack) {
        // Miss — show clearly, check if counter-strike killed player
        log.push(result.specialLines.length ? result.specialLines.join(" ") : "💨 **MISS!**");
        if (botC.species.name==="God") { const gh=Math.floor(botC.currentHp*0.2); botC.currentHp=Math.min(botC.maxHp,botC.currentHp+gh); log.push(`👑 Bot **Divine Retribution** heals ${gh}!`); }
        // playerC.currentHp already reduced by counter in attackerMutations above
        if (playerC.currentHp<=0) {
          fight.playerHp=0; fight.botHp=botC.currentHp; fight.log=log.slice(-3);
          await endBotFight(channel,fightId,"bot","player",fight.difficulty); return;
        }
      } else {
        botC.currentHp=Math.max(0,botC.currentHp-result.damage);
        if (botC.species.name==="Chimera"&&result.damage>0) fight.botAdaptiveStacks=Math.min(3,(fight.botAdaptiveStacks||0)+1);
        if (botC.species.name==="God"&&result.missedAttack) { const gh=Math.floor(botC.currentHp*0.2); botC.currentHp=Math.min(botC.maxHp,botC.currentHp+gh); log.push(`👑 Bot **Divine Retribution** heals ${gh}!`); }
        log.push(`⚔️ You deal **${result.damage}** damage!${result.specialLines.length?` (${result.specialLines.slice(0,2).join(", ")})`:""}`);
      }
      fight.playerLastUltUsed=playerC.lastUltUsed;
    }

    // Burn tick on bot
    if (botC.burn>0) { const bd=botC.burn; botC.currentHp=Math.max(0,botC.currentHp-bd); botC.burnRounds--; if(botC.burnRounds<=0){botC.burn=0;botC.burnRounds=0;} log.push(`🔥 Bot takes ${bd} burn!`); }
    // Ogre regen for player
    const or=applyOgreRegen(playerC); if(or) log.push(or);
    // Sync freshly-set cooldown back to combatant object BEFORE ticking
    // (ULT sets fight.playerUltCooldown directly, but playerC was built before that)
    playerC.ultCooldown = fight.playerUltCooldown;
    botC.ultCooldown    = fight.botUltCooldown;
    botC.healCooldown   = fight.botHealCooldown;
    // Player turn: tick player full + bot ULT only
    playerC.healCooldown = Math.max(0, playerC.healCooldown - 1);
    playerC.ultCooldown  = Math.max(0, playerC.ultCooldown  - 1);
    botC.ultCooldown     = Math.max(0, botC.ultCooldown     - 1);

    // Sync back — including BOTH cooldowns after tickBothUltCooldowns
    fight.playerHp=Math.max(0,playerC.currentHp); fight.botHp=Math.max(0,botC.currentHp);
    fight.playerUltBuff=playerC.ultBuff; fight.playerHealCooldown=playerC.healCooldown; fight.playerUltCooldown=playerC.ultCooldown;
    fight.playerBurn=playerC.burn; fight.playerBurnRounds=playerC.burnRounds; fight.playerCurse=playerC.curse;
    fight.playerUltBuff=playerC.ultBuff;
    fight.playerBlockHeal=playerC.blockHeal; fight.playerAdaptiveStacks=playerC.adaptiveStacks; fight.playerAttackCounter=playerC.attackCounter;
    fight.playerPossession=playerC.possession||false;
    // FIX: sync bot ULT cooldown after tick (was being lost)
    fight.botUltCooldown=botC.ultCooldown;
    fight.botUltBuff=botC.ultBuff; fight.botBurn=botC.burn; fight.botBurnRounds=botC.burnRounds;
    fight.botCurse=botC.curse; fight.botPossession=botC.possession||false;
    fight.botBlockHeal=botC.blockHeal; fight.botAdaptiveStacks=botC.adaptiveStacks; fight.botAttackCounter=botC.attackCounter; fight.botSlimeMissStacks=botC.slimeMissStacks||0; fight.playerSlimeMissStacks=playerC.slimeMissStacks||0; fight.botStunnedTurns=botC.stunnedTurns||0;
    fight.log=log.slice(-3);

    if (fight.botHp<=0) { await endBotFight(channel,fightId,"player","bot",fight.difficulty,fight.chaosDisintegrated?"chaos-disintegrate":"normal"); return; }
    if (fight.playerHp<=0) { await endBotFight(channel,fightId,"bot","player",fight.difficulty); return; }

    if (msg) await msg.edit({ content: null, embeds: null, ...buildBotFightMessagePayload(fight, fight.log, "bot_thinking", "bot_thinking") }).catch(() => {});
    setTimeout(()=>doBotTurn(channel,fightId),botPersonalities[fight.difficulty].reactionDelay);
    return;
  }

  // ── PVP FIGHT BUTTONS ─────────────────────────────────────────
  if (customId.startsWith("pvp_")) {
    await interaction.deferUpdate();
    const parts=customId.split("_"), action=parts[1];

    if (action==="choice") {
      const choiceType=parts[2], choice=parts[3], fightId=parts.slice(4).join("_");
      const fight=_state.activeFights.get(fightId);
      if (!fight) return;
      const isP1=user.id===fight.player1Id;
      const player=isP1?fight.player1:fight.player2;
      const opponent=isP1?fight.player2:fight.player1;
      if (!player.ultChoicePending) return;
      player.ultChoicePending=false;
      const log=[];
      if (choiceType==="angel") {
        if (choice==="smite") { player.ultBuff={type:"nextAttack",multiplier:1.5,angelHeal:true}; log.push(`👼 <@${user.id}> chooses **SMITE** — 1.5× + 35% heal!`); }
        else { const h=Math.floor(player.currentHp*0.6); player.currentHp=Math.min(player.maxHp,player.currentHp+h); log.push(`👼 <@${user.id}> chooses **PRAYER** — healed ${h} HP!`); }
      } else if (choiceType==="ice") {
        if (choice==="attack") { player.ultBuff={type:"nextAttack",multiplier:1.9}; log.push(`❄️ <@${user.id}> chooses **GLACIAL STRIKE** — 1.9×!`); }
        else { player.ultBuff={type:"iceHealBoost"}; log.push(`❄️ <@${user.id}> chooses **GLACIAL HEAL** — next heal +50%!`); }
      } else if (choiceType==="earth") {
        if (choice==="attack") { player.ultBuff={type:"nextAttack",multiplier:1.2}; log.push(`🌍 <@${user.id}> chooses **TERRA STRIKE** — 1.2× next attack!`); }
        else { player.ultBuff={type:"earthDamageReduction"}; log.push(`🌍 <@${user.id}> chooses **TERRA SHIELD** — −60% dmg!`); }
      }
      player.ultCooldown=player.species.ultCooldown; fight.currentTurn=opponent.id; fight.round++;
      const nextTurnPlayer=fight.currentTurn===fight.player1Id?fight.player1:fight.player2;
      const msg=_state.fightMessages.get(fightId);
      if (msg) await msg.edit({ content: null, embeds: null, ...buildFightMessagePayload(fight, log, "playing") }).catch(() => {});
      if (fight.timeout) clearTimeout(fight.timeout);
      fight.timeout=setTimeout(()=>{ if(_state.activeFights.has(fightId)){const l=fight.currentTurn;const w=fight.player1Id===l?fight.player2Id:fight.player1Id;endFight(channel,fightId,w,l,"timeout");} },120000);
      return;
    }

    const fightId=parts.slice(2).join("_");
    const fight=_state.activeFights.get(fightId);
    if (!fight) return;
    const isP1=user.id===fight.player1Id, isP2=user.id===fight.player2Id;
    if (!isP1&&!isP2) return;
    if (fight.pendingChaosReaction) return interaction.followUp({content:"A Chaos Creator reaction is awaiting the primary owner's decision.",flags:64});
    if (user.id!==fight.currentTurn) return interaction.followUp({embeds:[createErrorEmbed("It's not your turn!")],flags:64});
    if (fight.timeout) clearTimeout(fight.timeout);
    const player=isP1?fight.player1:fight.player2;
    const opponent=isP1?fight.player2:fight.player1;
    const log=[];
    let finishReason="normal";
    let pendingHealReversal=null;
    let pendingAttackReversal=null;

    if (action==="forfeit") {
      if (Math.random()<0.35) { log.push(`😵 <@${user.id}> tried to forfeit but pride won't let them! Turn wasted.`); fight.currentTurn=opponent.id; fight.round++; }
      else { await endFight(channel,fightId,opponent.id,user.id,"forfeit"); return; }
    } else if (action==="ult") {
      if (player.ultCooldown>0) { log.push(`❌ <@${user.id}>'s ULT on cooldown for ${player.ultCooldown} more rounds!`); fight.currentTurn=opponent.id; fight.round++; }
      else {
        let chaosDisintegrateConfirmed=false;
        let chaosUltNullified=false;
        const targetName=opponent.displayName||opponent.species.name;

        if (player.id===chaosSystem.PRIMARY_OWNER_ID && player.species.name==="Chaos Creator") {
          const decision=await chaosSystem.askChaosReaction({
            fight,channel,
            question:"Do you want to disintegrate this individual named "+targetName+"?",
            confirmedText:"Disintegrating this individual named "+targetName+".",
            declinedText:"Disintegration cancelled.",
          });
          if (!_state.activeFights.has(fightId)) return;
          if (!decision.confirmed) {
            fight.timeout=setTimeout(()=>{ if(_state.activeFights.has(fightId)){const l=fight.currentTurn;const w=fight.player1Id===l?fight.player2Id:fight.player1Id;endFight(channel,fightId,w,l,"timeout");} },120000);
            return;
          }
          chaosDisintegrateConfirmed=true;
          finishReason="chaos-disintegrate";
        } else if (opponent.id===chaosSystem.PRIMARY_OWNER_ID && opponent.species.name==="Chaos Creator") {
          const decision=await chaosSystem.askChaosReaction({
            fight,channel,
            question:"This individual named "+(player.displayName||player.species.name)+" has activated their ULT. Do you wish to nullify it?",
            confirmedText:"Ultimate nullification confirmed.",
            declinedText:"Ultimate nullification declined.",
          });
          if (!_state.activeFights.has(fightId)) return;
          chaosUltNullified=decision.confirmed;
        }

        let um="",requiresChoice=false,choiceType=null;
        if (chaosDisintegrateConfirmed) {
          opponent.currentHp=0;
          um="Disintegrating this individual named "+targetName+".";
        } else if (chaosUltNullified) {
          um="🌀 **ABSOLUTE NULLIFICATION!** "+player.species.name+"'s ultimate was nullified.";
        } else {
          ({message:um,requiresChoice,choiceType}=applyUltEffect(player,opponent));
        }
        await questSystem.trackProgress(player.id,"ults",1);
        if (requiresChoice) {
          player.ultChoicePending=true;
          const msg=_state.fightMessages.get(fightId);
          if (msg) await msg.edit({ content: null, embeds: null, ...buildFightMessagePayload(fight, ["Ultimate activated. Choose an option."], "choice", "choice_" + choiceType) }).catch(() => {});
          fight.timeout=setTimeout(()=>{
            if(_state.activeFights.has(fightId)&&player.ultChoicePending){
              player.ultChoicePending=false; player.ultCooldown=player.species.ultCooldown; player.ultBuff={type:"nextAttack",multiplier:1.5};
              fight.currentTurn=opponent.id; fight.round++;
              const msg2=_state.fightMessages.get(fightId);
              if (msg2) msg2.edit({ content: null, embeds: null, ...buildFightMessagePayload(fight, ["Ultimate choice timed out."], "playing") }).catch(() => {});
            }
          },30000);
          return;
        }
        player.ultCooldown=player.species.ultCooldown;
        if (player.species.name==="Cyborg") await updateCyborgProgress(player.id,"ult");
        if (player.species.name==="Half-Blood") await updateHalfBloodProgress(player.id,"ult",1,player.species.name);
        if (player.species.name==="Ogre" && !chaosUltNullified) { opponent.stunnedTurns=1; log.push(`💥 **MASSIVE BLOW!** Opponent stunned! Extra turn!`); }
        log.push(`✨ <@${user.id}> uses ULT!\n${um}`);
        if (player.species.name==="Ogre" && !chaosUltNullified) fight.currentTurn=user.id;
        else { fight.currentTurn=opponent.id; fight.round++; }
      }
    } else if (action==="heal") {
      if (player.blockHeal) { player.blockHeal=false; log.push(`🚫 <@${user.id}> **cannot heal** — Royal Command!`); fight.currentTurn=opponent.id; fight.round++; }
      else if (player.healCooldown>0) { log.push(`❌ <@${user.id}>'s heal on cooldown for ${player.healCooldown} more rounds!`); fight.currentTurn=opponent.id; fight.round++; }
      else if (player.currentHp>=player.maxHp*0.8) { log.push(`❌ <@${user.id}> HP above 80% — too healthy to heal!`); fight.currentTurn=opponent.id; fight.round++; }
      else {
        let mult=1;
        if (player.ultBuff?.type==="iceHealBoost") { mult=1.5; player.ultBuff=null; }
        if (player.ultBuff?.type==="earthHealBoost") { mult*=1.2; player.ultBuff=null; }
        let rawH=Math.floor((Math.floor(Math.random()*(player.species.healMax-player.species.healMin+1))+player.species.healMin)*mult);
        if (player.currentHp<player.maxHp*0.15) {
          if (Math.random()<0.75) { rawH=Math.floor(rawH*0.5); log.push(`💔 **Shaking hands!** <@${user.id}>'s desperate heal only 50%!`); }
          else { rawH=Math.floor(rawH*1.3); log.push(`✨ **Miracle heal!** <@${user.id}> gets +30% bonus!`); }
        }
        const actualH=player.curse>0?Math.floor(rawH*0.5):rawH;
        if (player.curse>0) { processCurseTick(player); log.push(`👿 Curse halves heal! ${rawH}→${actualH}`); }
        const hpBeforeHeal=player.currentHp;
        player.currentHp=Math.min(player.maxHp,player.currentHp+actualH); player.healCooldown=3;
        if (opponent.id===chaosSystem.PRIMARY_OWNER_ID && opponent.species.name==="Chaos Creator" && player.currentHp>hpBeforeHeal) {
          pendingHealReversal={healer:player,hpBefore:hpBeforeHeal};
        }
        log.push(`💚 <@${user.id}> heals for **${actualH} HP**! (${player.currentHp}/${player.maxHp})`);
        fight.currentTurn=opponent.id; fight.round++;
      }
    } else if (action==="attack") {
      if (player.possession) {
        player.possession=false;
        const rawSelfHit=Math.floor(Math.random()*(player.species.atkMax-player.species.atkMin+1))+player.species.atkMin;
        const selfHit=player.species.name==="Chaos Creator"?Math.ceil(rawSelfHit*0.5):rawSelfHit;
        player.currentHp=Math.max(0,player.currentHp-selfHit);
        log.push(`🎭 **POSSESSION!** <@${user.id}> attacks themselves for ${selfHit}!`);
        fight.currentTurn=opponent.id; fight.round++;
      } else {
        const targetHpBeforeAttack=opponent.currentHp;
        const result=calculateDamage(player,opponent);
        if (result.damage > 0) await questSystem.trackProgress(player.id,"damage",result.damage);
        player.currentHp=Math.max(0,Math.min(player.maxHp,player.currentHp+result.attackerMutations.hpDelta));
        if (result.instantKill) {
          opponent.currentHp=0;
          log.push(`⚔️ <@${user.id}> — ${result.specialLines.join(" ")}`);
        } else if (result.missedAttack) {
          // Miss — show clearly, handle counter-strike death
          log.push(result.specialLines.length ? result.specialLines.join(" ") : "💨 **MISS!**");
          if (opponent.species.name==="God") { const gh=Math.floor(opponent.currentHp*0.2); opponent.currentHp=Math.min(opponent.maxHp,opponent.currentHp+gh); log.push(`👑 **Divine Retribution!** Heals ${gh}!`); }
          // player.currentHp already reduced by counter in attackerMutations above — check death
          if (player.currentHp<=0) { await endFight(channel,fightId,opponent.id,user.id,"counter"); return; }
        } else {
          opponent.currentHp=Math.max(0,opponent.currentHp-result.damage);
          if (opponent.species.name==="Chimera"&&result.damage>0) opponent.adaptiveStacks=Math.min(3,(opponent.adaptiveStacks||0)+1);
          if (opponent.species.name==="God"&&result.missedAttack) { const gh=Math.floor(opponent.currentHp*0.2); opponent.currentHp=Math.min(opponent.maxHp,opponent.currentHp+gh); log.push(`👑 **Divine Retribution!** ${opponent.species.name} heals ${gh}!`); }
          log.push(`⚔️ <@${user.id}> deals **${result.damage}** damage!${result.specialLines.length?` (${result.specialLines.slice(0,2).join(", ")})`:""}`);
        }
        if (opponent.id===chaosSystem.PRIMARY_OWNER_ID && opponent.species.name==="Chaos Creator" && opponent.currentHp<targetHpBeforeAttack) {
          pendingAttackReversal={victim:opponent,attacker:player,hpBefore:targetHpBeforeAttack};
        }
        fight.currentTurn=opponent.id; fight.round++;
      }
    }

    if (pendingHealReversal) {
      const decision=await chaosSystem.askChaosReaction({
        fight,channel,
        question:"This individual named "+(player.displayName||player.species.name)+" has healed. Do you want to undo the heal?",
        confirmedText:"Healing reversal confirmed.",
        declinedText:"Healing reversal declined.",
      });
      if (!_state.activeFights.has(fightId)) return;
      if (decision.confirmed) {
        pendingHealReversal.healer.currentHp=pendingHealReversal.hpBefore;
        log.push("🌀 **Recovery Reversal!** The healing was undone.");
      }
    }
    if (pendingAttackReversal) {
      const decision=await chaosSystem.askChaosReaction({
        fight,channel,
        question:"This individual named "+(player.displayName||player.species.name)+" attacked you. Do you want to reverse the damage?",
        confirmedText:"Damage reversal confirmed.",
        declinedText:"Damage reversal declined.",
      });
      if (!_state.activeFights.has(fightId)) return;
      if (decision.confirmed) {
        const damageTaken=Math.max(0,pendingAttackReversal.hpBefore-pendingAttackReversal.victim.currentHp);
        if (damageTaken>0) {
          pendingAttackReversal.victim.currentHp=Math.min(pendingAttackReversal.victim.maxHp,pendingAttackReversal.victim.currentHp+damageTaken);
          const damageReturned=Math.min(damageTaken,pendingAttackReversal.attacker.currentHp);
          pendingAttackReversal.attacker.currentHp=Math.max(0,pendingAttackReversal.attacker.currentHp-damageReturned);
          log.push("🌀 **Causal Reversal!** Restored "+damageTaken+" HP and returned "+damageReturned+" damage.");
        }
      }
    }

    // Burn tick on opponent
    if (opponent.burn>0) { const rawBurn=opponent.burn; const bd=opponent.species.name==="Chaos Creator"?Math.ceil(rawBurn*0.5):rawBurn; opponent.currentHp=Math.max(0,opponent.currentHp-bd); opponent.burnRounds--; if(opponent.burnRounds<=0){opponent.burn=0;opponent.burnRounds=0;} log.push(`🔥 ${opponent.species.name} takes ${bd} burn!`); }
    const or=applyOgreRegen(player); if(or) log.push(or);
    // FIX: tick BOTH players ULT cooldown every round
    tickBothUltCooldowns(player, opponent);
        // FIX: sync opponent ULT cooldown back to fight object
        if (isP1) fight.player2.ultCooldown=opponent.ultCooldown;
        else      fight.player1.ultCooldown=opponent.ultCooldown;

    if (opponent.currentHp<=0) { await endFight(channel,fightId,user.id,opponent.id,finishReason); return; }
    if (player.currentHp<=0)   { await endFight(channel,fightId,opponent.id,user.id,"normal"); return; }

    const nextTurnPlayer=fight.currentTurn===fight.player1Id?fight.player1:fight.player2;
    const msg2=_state.fightMessages.get(fightId);
    if (msg2) await msg2.edit({ content: null, embeds: null, ...buildFightMessagePayload(fight, log, "playing") }).catch(() => {});
    fight.timeout=setTimeout(()=>{ if(_state.activeFights.has(fightId)){const l=fight.currentTurn;const w=fight.player1Id===l?fight.player2Id:fight.player1Id;endFight(channel,fightId,w,l,"timeout");} },120000);
    return;
  }

  // ── AWAKENING BUTTON ──────────────────────────────────────────
  if (customId==="awaken_cyborg") {
    const ud=_state.userSpecies.get(user.id);
    if (!ud||!ud.species||ud.species.name!=="Cyborg") return interaction.update({content:"❌ Not a Cyborg!",components:[]});
    if (!isCyborgReadyForAwakening(ud)) return interaction.update({content:"❌ Requirements not met yet!",components:[]});
    const mech=getSpeciesByName("Mechangel");
    ud.species=mech; ud.originalSpecies=mech; ud.awakening.cyborg.awakened=true; ud.rolls=(ud.rolls||0)+5;
    _state.userSpecies.set(user.id,ud); await database.saveUserSpecies(user.id,ud);
    return interaction.update({embeds:[new EmbedBuilder().setColor(0x00ffff).setTitle("⚡ MECHANGEL AWAKENING COMPLETE ⚡")
      .setDescription("🤖 **Cyborg → ⚡ Mechangel**\n\n+15 HP · New passive: Quantum Processing · New ULT: System Restoration\n\n🎁 +5 Species Rolls!\n\n*Machine and angel, fused as one.*")],components:[]});

  }

  if (customId==="awaken_eclipsed_sovereign") {
    const ud=_state.userSpecies.get(user.id);
    if (!ud || ud.species?.name!=="Half-Blood") return interaction.update({content:"❌ You must currently be Half-Blood to awaken.",components:[]});
    if (!isHalfBloodReadyForAwakening(ud)) return interaction.update({content:"❌ The three trials are not complete yet. Check /awakening.",components:[]});
    const awakened=require("./constants.js").eclipsedSovereignSpecies;
    if (!ud.awakening) ud.awakening={};
    if (!ud.awakening.halfBlood) ud.awakening.halfBlood={wins:0,damageDealt:0,ultUses:0,awakened:false};
    ud.awakening.halfBlood.awakened=true;
    ud.species=awakened;
    ud.originalSpecies=awakened;
    _state.userSpecies.set(user.id,ud);
    await database.saveUserSpecies(user.id,ud);
    return interaction.update({embeds:[new EmbedBuilder().setColor(0x6f2da8).setTitle("🌘 ECLIPSED SOVEREIGN AWAKENING COMPLETE")
      .setDescription("🩸 **Half-Blood → 🌘 Eclipsed Sovereign**\n\n**115 HP · 15–22 ATK · 14–22 HEAL**\n\n**Hybrid Instinct:** below 50% HP, deal 20% more damage and take 10% less damage.\n**Bloodline Overdrive:** empower your next attack by 1.8× and heal 15 HP.\n\n*At last, neither bloodline must silence the other. The eclipse crowns a power born from both.*")],components:[]});
  }

  if (customId==="awaken_archdemon") {
    const ud=_state.userSpecies.get(user.id);
    if (!ud || ud.species?.name!=="Demon") return interaction.update({content:"❌ You must currently be Demon to awaken.",components:[]});
    if (!isDemonReadyForAwakening(ud)) return interaction.update({content:"❌ Requirements or the 20-roll payment are not ready. Check `/awakening`.",components:[]});
    const req=require("./constants.js").awakeningRequirements.demon;
    if ((ud.rolls||0)<req.costRolls) return interaction.update({content:`❌ You need ${req.costRolls} rolls to awaken.`,components:[]});
    if (!ud.awakening) ud.awakening={};
    if (!ud.awakening.demon) ud.awakening.demon={playerWins:0,demonBotWins:0,awakened:false};
    ud.rolls-=req.costRolls;
    ud.awakening.demon.awakened=true;
    ud.species=archdemonSpecies; ud.originalSpecies=archdemonSpecies;
    _state.userSpecies.set(user.id,ud); await database.saveUserSpecies(user.id,ud);
    return interaction.update({embeds:[new EmbedBuilder().setColor(0x4a0404).setTitle("👿 ARCHDEMON AWAKENING COMPLETE")
      .setDescription(`😈 **Demon → 👿 Archdemon**\n\n⚔️ 25 player wins and 👹 20 Demon bot defeats completed.\n\n<:reroll_dice:1558042108965822515> Paid: ${req.costRolls} rolls. Remaining: ${ud.rolls}.\n\nYour awakening is permanent. After rolling another species, use \`/switch\` to return to Archdemon (3-hour cooldown).`)],components:[]});
  }
}


async function handleSelectMenu(interaction) {
  const { customId, user } = interaction;
  if (!customId.startsWith("species_token_pick_")) return;
  const expectedUserId = customId.slice("species_token_pick_".length);
  if (user.id !== expectedUserId) return safeReply(interaction, { content:"This token menu belongs to another player.", flags:64 });
  if (isPlayerInFight(user.id) || isPlayerInBotFight(user.id))
    return interaction.update(buildSpeciesTokenResultPayload("Can't Change Species During a Fight", "Finish your active fight first. No token was used.", 0xff0000));
  const selectedName = interaction.values?.[0];
  if (!isSpeciesTokenEligible(selectedName))
    return interaction.update(buildSpeciesTokenResultPayload("Invalid Species", "Choose an available species from the dropdown.", 0xff0000));
  const tokenCount = Number(_state.userSpecies.get(user.id)?.speciesTokens) || 0;
  if (tokenCount < 1) return interaction.update(buildSpeciesTokenResultPayload("No Species Tokens", "Your balance is empty. No token was used.", 0xff0000));
  return interaction.update(buildSpeciesTokenSelectionPayload(user.id, selectedName, tokenCount));
}

// ==================== SLASH COMMAND DEFINITIONS ====================
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("Show all commands"),
  new SlashCommandBuilder().setName("guide").setDescription("New player tutorial"),
  new SlashCommandBuilder().setName("daily").setDescription("Claim your daily species roll"),
  new SlashCommandBuilder().setName("species").setDescription("View species list or a specific species card").addStringOption(o=>o.setName("species").setDescription("Species name for detailed card (leave blank for full list)").setAutocomplete(true)),
  new SlashCommandBuilder().setName("profile").setDescription("View a full player profile").addUserOption(o=>o.setName("user").setDescription("User to check")),
  new SlashCommandBuilder().setName("items").setDescription("View and use inventory items")
    .addSubcommand(s=>s.setName("use").setDescription("Use an inventory item")
      .addStringOption(o=>o.setName("item").setDescription("Item to use").setRequired(true)
        .addChoices({name:"Species Token",value:"species_token"}))),
  new SlashCommandBuilder().setName("species-roll").setDescription("Roll for a new species"),
  new SlashCommandBuilder().setName("switch").setDescription("Switch between your species (3h cooldown)"),
  new SlashCommandBuilder().setName("awakening").setDescription("Check your species awakening progress"),
  new SlashCommandBuilder().setName("fight").setDescription("Challenge a player or fight an LOZ bot")
    .addSubcommand(s=>s.setName("player").setDescription("Challenge another player")
      .addUserOption(o=>o.setName("user").setDescription("Player to challenge").setRequired(true)))
    .addSubcommand(s=>s.setName("bot").setDescription("Fight an LOZ bot")
      .addStringOption(o=>o.setName("difficulty").setDescription("Bot difficulty").setRequired(true).addChoices({name:"🧸 Easy",value:"easy"},{name:"⚔️ Medium",value:"medium"},{name:"👹 Hard",value:"hard"},{name:"💀 Impossible",value:"impossible"},{name:"Brutal",value:"brutal"}))),
  new SlashCommandBuilder().setName("fightstats").setDescription("View fight stats").addUserOption(o=>o.setName("user").setDescription("User to check")),
  new SlashCommandBuilder().setName("history").setDescription("View fight history").addUserOption(o=>o.setName("user").setDescription("User to check")),
  new SlashCommandBuilder().setName("botstats").setDescription("View bot fight stats").addUserOption(o=>o.setName("user").setDescription("User to check")),
  new SlashCommandBuilder().setName("leaderboard").setDescription("View a player leaderboard")
    .addStringOption(o=>o.setName("type").setDescription("Choose a leaderboard").setRequired(true)
      .addChoices(
        {name:"Fight Wins",value:"fights"},
        {name:"Species Rolls",value:"rolls"},
      )),
  new SlashCommandBuilder().setName("patchnotes").setDescription("View latest patch notes"),
  new SlashCommandBuilder().setName("updates").setDescription("Manage major-update DM notifications")
    .addSubcommand(s=>s.setName("subscribe").setDescription("Opt in to major LOZ update DMs"))
    .addSubcommand(s=>s.setName("unsubscribe").setDescription("Opt out of major LOZ update DMs"))
    .addSubcommand(s=>s.setName("status").setDescription("Check your update DM preference")),
  new SlashCommandBuilder().setName("broadcast").setDescription("DM the major update to users who opted in").setDefaultMemberPermissions(0n),
  new SlashCommandBuilder().setName("broadtest").setDescription("Send the update DM preview to yourself").setDefaultMemberPermissions(0n),
  new SlashCommandBuilder().setName("servers").setDescription("List LOZ servers with invite links").setDefaultMemberPermissions(0n),
  new SlashCommandBuilder().setName("view").setDescription("View restricted LOZ information")
    .addSubcommand(s=>s.setName("subscribers").setDescription("View the number of active update subscribers"))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder().setName("gift").setDescription("Gift species rolls to another player")
    .addUserOption(o=>o.setName("user").setDescription("Player to gift rolls to").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("Number of rolls to gift (maximum 5)").setRequired(true).setMinValue(1).setMaxValue(5)),
  new SlashCommandBuilder().setName("togglerequests").setDescription("Toggle receiving challenge requests").addStringOption(o=>o.setName("status").setDescription("Enable or disable").setRequired(true).addChoices({name:"Enable",value:"enable"},{name:"Disable",value:"disable"})),
  new SlashCommandBuilder().setName("quest").setDescription("Learn how to open the quest board"),
  new SlashCommandBuilder().setName("quests").setDescription("View quests, track progress, and claim rewards"),
  // Keep /owner visible in every server; the handler below enforces the exact owner-ID allow-list.
  new SlashCommandBuilder().setName("owner").setDescription("Owner-only commands")
    .addSubcommand(s=>s.setName("menu").setDescription("Show owner command menu"))
    .addSubcommand(s=>s.setName("ban").setDescription("Ban a user from using LOZ without deleting their data").addUserOption(o=>o.setName("user").setDescription("User to ban").setRequired(true)).addStringOption(o=>o.setName("time").setDescription("Duration: 1s, 1m, 1h, 1d, 1w, or 1y; omit for permanent").setRequired(false).setMaxLength(16)))
    .addSubcommand(s=>s.setName("unban").setDescription("Restore a user's access to LOZ").addUserOption(o=>o.setName("user").setDescription("User to unban").setRequired(true)))
    .addSubcommand(s=>s.setName("clear-fight").setDescription("Clear stuck fight locks without awarding a result").addUserOption(o=>o.setName("user").setDescription("User whose stuck fight should be cleared").setRequired(true)))
    .addSubcommand(s=>s.setName("species-unlock").setDescription("Permanently unlock an exclusive species for a user").addUserOption(o=>o.setName("user").setDescription("Target user, including yourself").setRequired(true)).addStringOption(o=>o.setName("species").setDescription("Exclusive species to unlock").setRequired(true).addChoices({name:"Reaper 🌑",value:"Reaper"},{name:"Archdemon 👿",value:"Archdemon"},{name:"Mechangel ⚡🤖",value:"Mechangel"},{name:"Slime Lord 🫧",value:"Slime Lord"},{name:"Eclipsed Sovereign 🌘",value:"Eclipsed Sovereign"})))
    .addSubcommandGroup(g=>g.setName("add").setDescription("Give items to a user")
      .addSubcommand(s=>s.setName("items").setDescription("Give inventory items to a user")
        .addUserOption(o=>o.setName("user").setDescription("User receiving the item").setRequired(true))
        .addStringOption(o=>o.setName("item").setDescription("Item to give").setRequired(true).addChoices({name:"Species Token",value:"species_token"}))
        .addIntegerOption(o=>o.setName("quantity").setDescription("Quantity to give").setRequired(true).setMinValue(1).setMaxValue(1000000))))
    .addSubcommand(s=>s.setName("species-change").setDescription("Change a user's species").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)).addStringOption(o=>o.setName("species").setDescription("Species to set").setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName("species-reset").setDescription("Reset a user to Human").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)))
    .addSubcommand(s=>s.setName("species-add").setDescription("Give rolls to a user").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)).addIntegerOption(o=>o.setName("amount").setDescription("Amount of rolls").setRequired(true).setMinValue(1).setMaxValue(1000000)))
    .addSubcommand(s=>s.setName("rolls-reset").setDescription("Reset a user's rolls to 0").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)))
    .addSubcommand(s=>s.setName("quest-reset").setDescription("Reset a user's quest").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)).addStringOption(o=>o.setName("quest").setDescription("Quest name").setRequired(true).addChoices({name:"Reaper",value:"reaper"},{name:"All",value:"all"})))
    .addSubcommand(s=>s.setName("debug-db").setDescription("Check database keys"))
    .addSubcommand(s=>s.setName("repair-user-db").setDescription("Archive and repair duplicate player records")),
].map(c=>c.toJSON());

module.exports = { setState, setClient, handleCommand, handleAutocomplete, handleButton, handleSelectMenu, maybePromptForUpdates, commands };
