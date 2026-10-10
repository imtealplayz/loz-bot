const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  SlashCommandBuilder, REST, Routes,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
  SeparatorSpacingSize, MessageFlags, PermissionsBitField,
} = require("discord.js");
const {
  patchNotes, humanSpecies, reaperSpecies, archdemonSpecies,
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
} = require("./helpers.js");
const { buildFightMessagePayload, buildBotFightMessagePayload, makeCombatant, calculateDamage, applyUltEffect, tickCooldowns, tickBothUltCooldowns, applyOgreRegen, processCurseTick } = require("./combat.js");
const { startFight, endFight, doBotTurn, endBotFight } = require("./fights.js");

let _state = null;
let _client = null;
function setState(s) { _state = s; }
function setClient(c) { _client = c; }



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
  const title = isResult
    ? `${species.emoji} ${species.name} — Species Roll Result`
    : `<:reroll_dice:1558042108965822515> Species Roll`;
  const sections = isResult ? [
    { heading:"Roll Result", body:`**${userName}** rolled ${species.emoji} **${species.name}**.\n\n**Roll chance:** ${species.name.endsWith("Dragon") ? "2.0% (random element)" : (species.chance || "Special unlock")}` },
    { heading:"Species Stats", body:`❤️ **HP:** ${species.hp}\n⚔️ **ATK:** ${species.atkMin}–${species.atkMax}\n💚 **HEAL:** ${species.healMin}–${species.healMax}\n✨ **ULT cooldown:** ${species.ultCooldown || "—"} rounds` },
    { heading:"Remaining Rolls", body:`<:reroll_dice:1558042108965822515> **${rollsRemaining}**` },
  ] : [
    { heading:"Current Species", body:`${species.emoji} **${species.name}**` },
    { heading:"Available Rolls", body:`<:reroll_dice:1558042108965822515> **${rollsRemaining}**` },
    { heading:"How to Roll", body:"Your reroll controls are visible only to you in the private message below. Use **REROLL** to roll again or **CANCEL** to keep your current species." },
  ];
  const payload = buildStyledCardPayload(title, species.color || 0x0891b2, sections, false);
  return {
    ...payload,
    components:[new TextDisplayBuilder().setContent(`<@${userId}>'s Species Roll`),...payload.components],
    allowedMentions:{ parse:[], users:[userId] },
  };
}

function buildSpeciesRollControlsPayload(userId, rollsRemaining) {
  const container = new ContainerBuilder().setAccentColor(0x0891b2);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## Species Roll Controls\nYou have **${rollsRemaining}** species roll${rollsRemaining === 1 ? "" : "s"} remaining. These controls are private to you.`
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  if (rollsRemaining > 0) {
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`reroll_${userId}`).setLabel("REROLL").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cancel_${userId}`).setLabel("CANCEL").setStyle(ButtonStyle.Secondary)
    ));
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent("No rolls remain. Use `/daily` for your next free roll."));
  }
  return { components:[container], flags:MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions:{ parse:[] } };
}


const GUIDE_PAGES = [
  {
    title:"Welcome to Legends of the Rift",
    body:"LOZ is a turn-based RPG set in a world of powerful species, strange abilities, and awakenings. Your species determines your combat stats, passive trait, and ultimate ability.\n\nYour journey is about more than collecting a rare species: learn its strengths, build your battle record, challenge LOZ, and work toward special awakenings.\n\n**Your goal:** discover your playstyle, win battles, and grow stronger over time.",
  },
  {
    title:"Understand Species",
    body:"Every species has its own combat profile:\n\n❤️ **HP** is how much damage you can take.\n⚔️ **ATK** is your attack damage range.\n💚 **HEAL** is your potential recovery.\n✨ **ULT cooldown** is how many rounds you wait before your ultimate is ready again.\n\nSpecies also have a **passive** that may trigger automatically and an **active ultimate** with a special effect. Type matchups can matter, too.\n\nUse `/species` to browse the compendium, or `/species species:<name>` to inspect one species in detail. Rarity is exciting, but understanding your abilities is what helps you use them well.",
  },
  {
    title:"Rolls, Daily Rewards, and Your Profile",
    body:"Species rolls let you change your current species. `/daily` grants a daily roll, while `/species-roll` opens the roll controls and uses one roll each time you reroll. The result is posted publicly so everyone can see what you got; the controls stay private to you.\n\nYour `/profile` is your player card. It tracks your species, rolls, Species Tokens, fight record, streak, and abilities.\n\nA **Species Token** is a separate item that lets you choose an available species rather than relying on random odds. Use `/items use item:Species Token` and confirm the change only when you're sure.",
  },
  {
    title:"How Combat Works",
    body:"Challenge another player with `/fight player user:<player>`, or practice against LOZ with `/fight bot difficulty:<difficulty>`. Player challenges need the other player to accept before the battle starts.\n\nOn your turn:\n\n⚔️ **Attack** deals damage and can trigger combat effects.\n💚 **Heal** restores HP when it is available; it is disabled when you're above 80% HP or its cooldown is active.\n✨ **Ultimate** uses your species' special ability when its cooldown reaches zero. Some ultimates ask you to pick an effect.\n🏳️ **Forfeit** gives up the battle.\n\nWatch your HP, cooldowns, passives, and opponent's effects. An ultimate used at the right moment can matter more than simply attacking every turn.",
  },
  {
    title:"Practice, Rewards, and Rankings",
    body:"Bot fights have five difficulties: **Easy, Medium, Hard, Impossible, and Brutal**. Start with a level you can handle, then try tougher opponents as you learn your species. Brutal opponents include Reaper, Mechangel, and Archdemon and use stronger decisions. A Brutal victory grants **10 leaderboard points and 1 species roll**.\n\nUse `/fightstats` to review your player battle record, `/history` to revisit recent battles, `/botstats` to compare results by bot difficulty, and `/fights` to see the fight leaderboard. These commands help you track progress, not just individual wins.",
  },
  {
    title:"Awakenings and Long-Term Progress",
    body:"Some species can awaken into stronger forms. Use `/awakening` to check your progress and requirements.\n\n⚡🤖 **Cyborg → Mechangel:** requires 25 wins, 500 damage dealt, and 15 ultimate uses. Awakening grants **5 species rolls**.\n\n😈 **Demon → Archdemon:** requires 25 player-fight wins, 20 Demon bot victories, and 20 rolls to pay the awakening cost. The awakening is permanent; after rolling another species, `/switch` can return you to Archdemon.\n\nUse `/switch` to manage eligible original or awakened forms. Quest availability can change, so check `/quest view` for the currently displayed quest status before planning around it.",
  },
  {
    title:"Your LOZ Toolkit",
    body:"Here are a few useful commands to keep close:\n\n• `/daily` — collect your daily roll.\n• `/species-roll` — reroll your species.\n• `/profile` — inspect your player card.\n• `/species` — learn species stats and abilities.\n• `/fight player` and `/fight bot` — battle players or bots.\n• `/awakening` and `/quest view` — track special progression.\n• `/gift` — send rolls to another player within the limits.\n• `/patchnotes` — read the latest changes.\n• `/guide` — revisit this tutorial whenever you need a refresher.\n\nYou don't need to memorize everything now. Try a command, read the result panel, and use `/help` whenever you need a reminder.",
  },
  {
    title:"Ready to Enter the Rift?",
    body:"That's the foundation: understand your species, keep an eye on your resources, and learn when to attack, heal, or use your ultimate. LOZ tracks your progress so every battle helps tell your story.\n\nComplete this tutorial to claim your one-time welcome reward. The reward is saved to your player record, so finishing the guide again won't grant another roll.",
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
  const container = new ContainerBuilder().setAccentColor(0x0891b2);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🌑 LOZ IS BACK
**Legends of the Rift is back online!**

The Rift has grown. We've added new awakenings, a tougher combat challenge, better rewards, and a wave of bug fixes. Here's what's new.

Thanks to everyone who's played LOZ, tested updates, and helped make the game better.`
    )
  );

  const sections = [
    {
      title:"👿 New awakenings",
      body:[
        "- **Demon → Archdemon:** Complete 25 player wins, defeat 20 Demon bots, and spend 20 rolls. The awakening is permanent, and you can return to Archdemon after rerolling with \`/switch\`.",
        "- **Cyborg → Mechangel:** Complete the combat, damage, and ultimate trials to unlock a new form with its own passive and ultimate. Awakening also grants 5 rolls."
      ].join("\n")
    },
    {
      title:"💀 Brutal difficulty",
      body:[
        "- Face powerful opponents including Reaper, Mechangel, and Archdemon.",
        "- Brutal bots make more species-aware ultimate decisions.",
        "- A Brutal victory grants **10 leaderboard points and 1 species roll**."
      ].join("\n")
    },
    {
      title:"⚔️ Combat upgrades and fixes",
      body:[
        "- The miss and counter system is back.",
        "- Chimera copies the opponent's ultimate directly.",
        "- Fixed ultimate cooldown timing, passives, burns, possession, and other combat edge cases.",
        "- If a bot fight gets stuck for 60 seconds, the player wins instead of being left waiting.",
        "- Species rerolls are blocked during active fights."
      ].join("\n")
    },
    {
      title:"🎁 More ways to progress",
      body:[
        "- Use \`/gift\` to send up to 2 rolls per day, with a daily receive limit of 4.",
        "- Clearer fight results show leaderboard points and species-roll rewards.",
        "- Fixed Reaper quest progress and improved awakening progress tracking.",
        "- Custom reroll dice icons and updated patch notes make rewards easier to follow."
      ].join("\n")
    }
  ];

  for (const section of sections) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ${section.title}\n${section.body}`)
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### 🔔 Stay updated
Want more major updates from LOZ? Use \`/updates subscribe\` to opt in to future update DMs. You can unsubscribe at any time with \`/updates unsubscribe\`.

🌐 **Website:** [Visit LOZ](https://lozbot.vercel.app/)`
    )
  );

  return {
    components:[container],
    flags:MessageFlags.IsComponentsV2,
    allowedMentions:{ parse:[] },
  };
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

  // Temporarily disable all /fight subcommands while the fight system is being updated.
  if (commandName === "fight") {
    return safeReply(interaction, {
      embeds: [createErrorEmbed("Currently disabled due to updates to the fight system. Please try again later.")],
      flags: 64,
    });
  }

  // ── HELP ──────────────────────────────────────────────────────
  if (commandName === "help") {
    return safeReply(interaction, buildStyledCardPayload("LOZ Command Guide", 0x0891b2, [
      { heading:"Getting Started", body:"`/guide` — Learn the game and claim your one-time tutorial roll.\n`/profile` — View your species, resources, and progress." },
      { heading:"Species & Rewards", body:"`/species-roll` — Roll for a species.\n`/species` — Browse species, stats, passives, and ultimates.\n`/daily` — Claim your daily roll.\n`/switch` and `/items use` — Manage species and eligible items." },
      { heading:"Combat", body:"`/fight player user:<player>` — Challenge another player.\n`/fight bot difficulty:<difficulty>` — Battle an LOZ bot.\n`/togglerequests` — Control whether you receive player challenges." },
      { heading:"Records & Rankings", body:"`/fightstats`, `/history`, and `/botstats` — Review fight records.\n`/fights` and `/lb` — View leaderboards." },
      { heading:"Quests & Progression", body:"`/quest view`, `/quest claim`, and `/awakening` — Track quests and awakenings." },
      { heading:"Updates & Support", body:"`/patchnotes` — Read recent changes.\n`/updates` — Manage update DMs.\nNeed help or found a problem? Join the [LOZ Support Server](https://discord.gg/TKBYpjqnPC)." },
    ]));
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

    const subscriberCount = new Set(
      subscribers.filter(id => id !== _client?.user?.id)
    ).size;
    const embed = new EmbedBuilder()
      .setColor(0x0891b2)
      .setTitle("LOZ Update Subscribers")
      .setDescription("Current users who have opted in to receive major LOZ update announcements by DM.")
      .addFields(
        { name:"Active subscribers", value:"🔔 **" + subscriberCount.toLocaleString() + "**", inline:true },
        { name:"Counting rule", value:"Only unique Discord users whose update subscription is currently enabled are counted. Users who unsubscribe are excluded.", inline:false },
      )
      .setFooter({ text:"Live count · Read from MongoDB" });

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
      await user.send(buildMajorUpdatePayload());
      return interaction.editReply({ content:"✅ The current Components V2 update preview was sent to your DMs." });
    } catch(e) {
      console.error("broadtest DM failed:", e?.code || e?.message || e);
      return interaction.editReply({ content:"❌ Couldn't DM you the preview. Check that your DMs from LOZ are open, then try again." });
    }
  }

  // ── BROADCAST: OWNER-ONLY, OPTED-IN USERS ONLY ──────────────────
  if (commandName === "broadcast") {
    if (user.id !== _state.ownerId) {
      return safeReply(interaction, { content:"Only the LOZ owner can use this command.", flags:64 });
    }

    await interaction.deferReply({ flags:64 });
    const subscribers = await database.getBroadcastSubscribers();
    if (subscribers === null) {
      return interaction.editReply({
        content:"❌ Couldn't load the opt-in list from MongoDB. No DMs were attempted.\\n\\n**DMs sent:** 0\\n**DMs failed:** 0",
      });
    }

    const recipientIds = [...new Set(subscribers)].filter(id => id !== _client.user.id);
    if (!recipientIds.length) {
      return interaction.editReply({
        content:"No users have opted into update DMs yet. Users can subscribe with \`/updates subscribe\`. No DMs were sent.\\n\\n**DMs sent:** 0\\n**DMs failed:** 0",
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
          await target.send(buildMajorUpdatePayload());
          sent++;
        } catch(e) {
          failed++;
          console.warn(`Update broadcast DM failed (code ${e?.code || "unknown"}).`);
        }

        completed++;
        if (completed % 25 === 0) {
          await interaction.editReply({
            content:`📤 Broadcast in progress: ${completed}/${recipientIds.length} attempted · ${sent} sent · ${failed} failed.`,
          }).catch(() => {});
        }
      }
    };

    await Promise.all(
      Array.from({ length:Math.min(4, recipientIds.length) }, () => sendWorker())
    );

    return interaction.editReply({
      content:`✅ **LOZ update broadcast finished**\n\n**Opted-in recipients:** ${recipientIds.length}\n**DMs sent:** ${sent}\n**DMs failed:** ${failed}\n\nOnly users who opted in with \`/updates subscribe\` were contacted.`,
    });
  }


  // ── SPECIES ───────────────────────────────────────────────────
  if (commandName === "species") {
    const spName = options.getString("species");
    if (!spName) {
      const ranked = [
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
      const tierOrder = ["Epic","Rare","Uncommon","Common"];
      const sections = tierOrder.map(tier => ({
        heading:`${({Epic:"🟣",Rare:"🔵",Uncommon:"🟡",Common:"⚪"})[tier]} ${tier} Species`,
        body:ranked.filter(sp=>sp.tier===tier).map(sp =>
          `**${sp.emoji} ${sp.name}**  ·  ${sp.chance}${sp.note ? " · Random element" : ""}`
        ).join("\n"),
      }));
      sections.push({heading:"Special Unlocks",body:"🌑 **Reaper** · Quest unlock\n👿 **Archdemon** · Demon awakening\n⚡🤖 **Mechangel** · Cyborg awakening"});
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
          {heading:"Badges",body:"💪 Omnipotent\n🐛 Bug Creator"},
          {heading:"Passive",body:botSpecies.kitsune.passive},
          {heading:"Active",body:botSpecies.kitsune.active},
        ]));
      }
      return safeReply(interaction,buildStyledCardPayload(`🤖 ${target.displayName}'s Profile`,botSpecies.bot.color,[
        {heading:"Species",body:"🤖 **Bot**"},
        {heading:"Combat Stats",body:`❤️ **HP:** ${botSpecies.bot.hp}\n⚔️ **ATK:** ${botSpecies.bot.atkMin}–${botSpecies.bot.atkMax}\n💚 **HEAL:** ${botSpecies.bot.healMin}–${botSpecies.bot.healMax}`},
        {heading:"Passive",body:botSpecies.bot.passive},
        {heading:"Active",body:botSpecies.bot.active},
      ]));
    }
    const td=_state.userSpecies.get(target.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,speciesTokens:0,requestsEnabled:true,badges:[]};
    const fd=_state.fightStats.get(target.id)||{wins:0,losses:0,streak:0};
    const sp=td.species||humanSpecies;
    const totalFights=(fd.wins||0)+(fd.losses||0);
    const wr=totalFights>0?((fd.wins/totalFights)*100).toFixed(1):"0.0";
    const badges=[];
    if (td.badges?.includes("OG 50")) badges.push("🎉 OG 50");
    if (target.id==="926063716057894953") badges.push("👑 Founder","✨ The Creator");
    if (target.id==="1376978115171192922") badges.push("🤝 Co-Founder","🧪 OG Tester","⭐ Shion's Favourite");
    const sections=[
      {heading:"Current Species",body:`${sp.emoji} **${sp.name}**`},
      {heading:"Inventory & Settings",body:`<:reroll_dice:1558042108965822515> **Species rolls:** ${td.rolls||0}\n${SPECIES_TOKEN_EMOJI} **Species tokens:** ${Number(td.speciesTokens)||0}\n🔘 **Challenge requests:** ${td.requestsEnabled?"Enabled":"Disabled"}`},
      {heading:"Fight Record",body:`🏆 **Wins:** ${fd.wins||0}  ·  💔 **Losses:** ${fd.losses||0}\n📊 **Win rate:** ${wr}%\n🔥 **Win streak:** ${fd.streak||0}`},
      {heading:"Passive",body:getPassiveDescription(sp.name)},
      {heading:"Active Ultimate",body:getActiveDescription(sp.name)},
      {heading:"Member Since",body:`<t:${Math.floor((targetMember?.joinedTimestamp||Date.now())/1000)}:R>`},
    ];
    if(badges.length) sections.splice(3,0,{heading:"Badges",body:badges.join("\n")});
    return safeReply(interaction,buildStyledCardPayload(`👤 ${target.displayName}'s Profile`,sp.color||0x9b59b6,sections));
  }

  // ── SPECIES-ROLL ──────────────────────────────────────────────
  if (commandName === "species-roll") {
    if (isPlayerInFight(user.id)||isPlayerInBotFight(user.id))
      return safeReply(interaction,buildStyledCardPayload("Roll Unavailable",0xff0000,[{body:"You can't reroll during an active fight."}],true));
    let userData=_state.userSpecies.get(user.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:1,speciesTokens:0,requestsEnabled:true,lastSwitch:0,badges:[]};
    if ((userData.rolls||0)<1)
      return safeReply(interaction,buildStyledCardPayload("No Rolls Left",0xff0000,[{body:"Use `/daily` for a free roll or win fights for a chance to earn rolls."}],true));
    const currentSp=userData.species||humanSpecies;
    const pubMsg=await channel.send(buildSpeciesRollAnnouncement(user.id,user.displayName||user.username,currentSp,userData.rolls,false));
    _state.activeRolls.set(user.id,{channelId:channel.id,messageId:pubMsg.id,timestamp:Date.now()});
    return safeReply(interaction,buildSpeciesRollControlsPayload(user.id,userData.rolls));
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
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x00ffff).setTitle("✨ AWAKENING ALTAR")
        .setDescription(`*The altar awaits your worthiness. Prove yourself in battle.*\n\n**» YOUR PROGRESS «**\n\n⚔️ **Combat Trials:** ${prog.wins}/${req.wins} wins\n└ ${bar(wPct)} ${wPct}%\n\n💥 **Damage Output:** ${prog.damageDealt.toLocaleString()}/${req.damageDealt.toLocaleString()} dmg\n└ ${bar(dPct)} ${dPct}%\n\n⚡ **ULT Mastery:** ${prog.ultUses}/${req.ultUses} ULT uses\n└ ${bar(uPct)} ${uPct}%`)
        .setFooter({text:"25 wins • 500 damage • 15 ULTs to unlock your true form"})],flags:64});
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

      const costLine=rolls>=req.costRolls
        ? `✅ Reroll payment: ${rolls}/${req.costRolls} available`
        : `❌ Reroll payment: ${rolls}/${req.costRolls} available — need ${req.costRolls-rolls} more`;
      const detail=trialsReady
        ? `Combat trials complete. Get ${Math.max(0,req.costRolls-rolls)} more rolls, then return here to awaken.`
        : "Complete both combat requirements while using Demon, then pay the reroll cost.";
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x4a0404).setTitle("👿 AWAKENING ALTAR")
        .setDescription(`*Prove your strength as a Demon to awaken into Archdemon.*\n\n**» YOUR PROGRESS «**\n\n⚔️ **Player Fight Wins:** ${barFor(playerWins,req.playerWins)}\n\n👹 **Demon Bot Defeats:** ${barFor(demonBotWins,req.demonBotWins)}\n\n${costLine}\n\n${detail}`)
        .setFooter({text:"25 player wins • 20 Demon bot defeats • 20 rolls"})],flags:64});
    }

    // ── No awakening available for this species ─────────────────
    return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x2d2d2d).setTitle("✨ AWAKENING ALTAR")
      .setDescription(`*You approach the altar, but it remains silent.*\n\n${userData.species?.emoji||"👤"} **${sp||"Unknown"}** does not yet have an awakening path.\n\nAwakenings are rare transformations granted to species who have proven their worth through relentless battle.\n\n*Check back as new awakenings are discovered.*`)
      .setFooter({text:"Currently: Cyborg → Mechangel | Demon → Archdemon"})],flags:64});
  }

  // ── FIGHT ─────────────────────────────────────────────────────
  if (commandName === "fight" && options.getSubcommand() === "player") {
    const target=options.getUser("user");
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
  if (commandName === "fight" && options.getSubcommand() === "bot") {
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
      playerAdaptiveStacks:0, playerAttackCounter:0, playerBurn:0, playerBurnRounds:0,
      playerCurse:0, playerBlockHeal:false, playerPossession:false, playerStunnedTurns:0, playerLastUltUsed:null,
      botSpecies:bSpecies, botHp:bSpecies.hp, botMaxHp:bSpecies.hp,
      botHealCooldown:0, botUltCooldown:0, botUltBuff:null, botAdaptiveStacks:0, botAttackCounter:0,
      botBurn:0, botBurnRounds:0, botCurse:0, botPossession:false, botBlockHeal:false, botStunnedTurns:0, botLastUltUsed:null,
      round:1, difficulty, botPersonality:personality, timeout:null, log:[], playerName:user.displayName||user.username,
    };
    _state.activeBotFights.set(fightId,fight); _state.activeBotFights.set(user.id,fightId);
    const msg = await channel.send(buildBotFightMessagePayload(fight, ["Fight started. Your turn."], "playing"));
    _state.fightMessages.set(fightId,msg);
    fight.timeout=setTimeout(()=>{ if(_state.activeBotFights.has(fightId)) endBotFight(channel,fightId,"bot","player",difficulty); },120000);
    return safeReply(interaction,{embeds:[createSuccessEmbed("Fight started!")],flags:64});
  }

  // ── SWITCH ────────────────────────────────────────────────────
  if (commandName === "switch") {
    await interaction.deferReply({flags:64});
    const userData=_state.userSpecies.get(user.id);
    if (!userData||!userData.species) return interaction.editReply({embeds:[createErrorEmbed("No species yet! Use `/species-roll` first.")]});
    const now=Date.now(), threeH=3*60*60*1000;
    if (user.id!==_state.ownerId&&user.id!==_state.secondGodId&&userData.lastSwitch&&now-userData.lastSwitch<threeH) {
      const tl=threeH-(now-userData.lastSwitch), h=Math.floor(tl/3600000), m=Math.floor((tl%3600000)/60000);
      return interaction.editReply({embeds:[createErrorEmbed(`Switch available in **${h}h ${m}m**!`)]});
    }
    const sp=userData.species||humanSpecies;
    const row=new ActionRowBuilder();
    row.addComponents(new ButtonBuilder().setCustomId("switch_current").setLabel(`✅ ${sp.name} (Current)`).setStyle(ButtonStyle.Success).setDisabled(true));
    if (userData.originalSpecies?.name&&userData.originalSpecies.name!==sp.name) row.addComponents(new ButtonBuilder().setCustomId("switch_original").setLabel(userData.originalSpecies.name).setStyle(ButtonStyle.Primary));
    if (userData.questSpecies?.reaper?.unlocked&&sp.name!=="Reaper") row.addComponents(new ButtonBuilder().setCustomId("switch_reaper").setLabel("🌑 Reaper").setStyle(ButtonStyle.Primary));
    if (userData.awakening?.demon?.awakened===true&&sp.name!=="Archdemon") row.addComponents(new ButtonBuilder().setCustomId("switch_archdemon").setLabel("👿 Archdemon").setStyle(ButtonStyle.Danger));
    if (userData.awakening?.cyborg?.awakened===true&&sp.name!=="Mechangel") row.addComponents(new ButtonBuilder().setCustomId("switch_mechangel").setLabel("⚡ Mechangel").setStyle(ButtonStyle.Primary));
    const embed=new EmbedBuilder().setColor(0x9b59b6).setTitle("🔄 Class Switch")
      .setDescription(`**Current:** ${sp.emoji} ${sp.name}\n**Original:** ${userData.originalSpecies?.emoji||"👤"} ${userData.originalSpecies?.name||"Human"}\n🌑 Reaper: ${userData.questSpecies?.reaper?.unlocked?"✅ Unlocked":"❌ Locked"}\n👿 Archdemon: ${userData.awakening?.demon?.awakened?"✅ Awakened":"❌ Locked"}\n\n⏰ Cooldown: 3 hours`);
    return interaction.editReply({embeds:[embed],components:[row]});
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

  // ── FIGHTS ────────────────────────────────────────────────────
  if (commandName === "fights") {
    await interaction.deferReply({ flags:MessageFlags.IsComponentsV2 });
    if (_state.fightLeaderboard.size===0) return interaction.editReply(buildStyledCardPayload("⚔️ Fight Leaderboard",0xff4500,[{body:"No fight leaderboard entries yet. Start battling to claim the top spot."}]));
    const sorted=Array.from(_state.fightLeaderboard.entries()).sort((a,b)=>b[1].wins-a[1].wins).slice(0,10);
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
      const marker=n===0?"🥇":n===1?"🥈":n===2?"🥉":`**${n+1}.**`;
      rows.push(`${marker} ${species?.emoji||"⚔️"} **${name}**\n   ${score.wins} leaderboard wins`);
    }
    return interaction.editReply(buildStyledCardPayload("⚔️ Fight Leaderboard · Top 10",0xff4500,[
      {heading:"Rankings",body:rows.join("\n\n")},
      {body:"Ranked by leaderboard wins. Keep fighting to climb the board."},
    ]));
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

  // ── QUEST ─────────────────────────────────────────────────────
  if (commandName === "quest") {
    const sub=options.getSubcommand();
    if (sub==="view") {
      const target=options.getUser("user")||user;
      const qd=_state.questProgress.get(target.id)||{};
      const r=qd.reaper||{easyBots:0,mediumBots:0,hardBots:0,impossibleBots:0,playerFights:0,completed:false,claimed:false};
      const bar=(c,m)=>{ const f=Math.round((c/m)*10); return "█".repeat(f)+"░".repeat(10-f)+` ${c}/${m}`; };
      const now=Date.now();
      const REAPER_EXPIRY=1774355400000;
      const expired=now>=REAPER_EXPIRY&&!r.claimed;
      const embed=new EmbedBuilder().setColor(0x9b59b6).setTitle(`📋 Quests — ${target.displayName}`).setDescription("Complete quests to unlock exclusive species!");
      let rstatus, rvalue;
      if (r.claimed) { rstatus="✅ CLAIMED"; rvalue="Reaper unlocked! Use `/switch` to equip."; }
      else if (expired) { rstatus="⌛ EXPIRED"; rvalue=`The Reaper Quest has ended.\n\n*The Reaper has returned to the shadows.*\n\nDeadline was: **24 March 2026 at 6:00 PM**`; }
      else if (r.completed) { rstatus="🎁 CLAIM READY"; rvalue="Use `/quest claim quest:reaper` to claim!"; }
      else {
        rstatus="🔄 In Progress";
        rvalue=`⏰ **Quest ends:** <t:${Math.floor(REAPER_EXPIRY/1000)}:R>\n*(Deadline: **24 March 2026 at 6:00 PM**)*\n\n🧸 Easy Bots: ${bar(r.easyBots,35)}\n⚔️ Medium Bots: ${bar(r.mediumBots,25)}\n👹 Hard Bots: ${bar(r.hardBots,15)}\n💀 Impossible: ${bar(r.impossibleBots,5)}\n👤 Player Fights: ${bar(r.playerFights,15)}`;
      }
      embed.addFields({name:`🌑 Reaper Quest — ${rstatus}`,value:rvalue,inline:false});
      return safeReply(interaction,{embeds:[embed]});
    }
    if (sub==="claim") {
      const qn=options.getString("quest");
      if (qn==="reaper") {
        const qd=_state.questProgress.get(user.id)||{};
        const r=qd.reaper||{easyBots:0,mediumBots:0,hardBots:0,impossibleBots:0,playerFights:0,completed:false,claimed:false};
        if (r.claimed) return safeReply(interaction,{embeds:[createErrorEmbed("Already claimed! Use `/switch` to equip.")],flags:64});
        if (Date.now()>=1774355400000&&!r.claimed) return safeReply(interaction,{embeds:[createErrorEmbed("The Reaper Quest has expired. The window to claim has closed.")],flags:64});
        if (!r.completed) return safeReply(interaction,{embeds:[createErrorEmbed("Quest not complete yet! Check `/quest view`.")],flags:64});
        r.claimed=true; qd.reaper=r; _state.questProgress.set(user.id,qd); database.saveQuestProgress(user.id,"reaper",r);
        const ud=_state.userSpecies.get(user.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0};
        if (!ud.questSpecies) ud.questSpecies={};
        ud.questSpecies.reaper={unlocked:true,equipped:false};
        _state.userSpecies.set(user.id,ud); database.saveUserSpecies(user.id,ud);
        return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x2f4f4f).setTitle("🌑 Reaper Unlocked!").setDescription("Use `/switch` to equip Reaper!")]});
      }

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
    const senderRemaining = 2 - (senderData.giftSent.count||0);
    const receiverRemaining = 4 - (receiverData.giftReceived.count||0);

    if ((senderData.rolls||0)<5) return safeReply(interaction,{embeds:[createErrorEmbed(`You need at least **5 rolls** to gift. You only have **${senderData.rolls||0}**.`)],flags:64});
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
    if ((senderData.rolls||0)<amount) return safeReply(interaction,{embeds:[createErrorEmbed(`You only have **${senderData.rolls||0}** rolls. You can't gift more than you have.`)],flags:64});

    const actualAmount = Math.min(amount, senderRemaining, receiverRemaining);

    // Transfer rolls
    senderData.rolls=(senderData.rolls||0)-actualAmount;
    receiverData.rolls=(receiverData.rolls||0)+actualAmount;
    senderData.giftSent.count=(senderData.giftSent.count||0)+actualAmount;
    receiverData.giftReceived.count=(receiverData.giftReceived.count||0)+actualAmount;

    _state.userSpecies.set(user.id,senderData);
    _state.userSpecies.set(target.id,receiverData);
    database.saveUserSpecies(user.id,senderData).catch(()=>{});
    database.saveUserSpecies(target.id,receiverData).catch(()=>{});

    const embed = new EmbedBuilder().setColor(0x00ff99)
      .setTitle("🎁 Rolls Gifted!")
      .setDescription(`<@${user.id}> gifted **${actualAmount}** roll${actualAmount!==1?"s":""}  to <@${target.id}>!\n\n📊 **Your rolls remaining:** ${senderData.rolls}\n📤 **Gifts sent today:** ${senderData.giftSent.count}/2\n\n*Resets at midnight.*`);
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
        return safeReply(interaction, asEphemeralSpeciesTokenPayload(buildSpeciesTokenResultPayload("No Species Tokens", `You don't have any ${SPECIES_TOKEN_EMOJI} Species Tokens. A God can grant them to you.`, 0xff0000)));
      return safeReply(interaction, asEphemeralSpeciesTokenPayload(buildSpeciesTokenSelectionPayload(user.id, null, tokenCount)));
    }
  }

  // ── GOD COMMANDS ──────────────────────────────────────────────
  if (commandName === "god") {
    if (user.id!==_state.ownerId&&user.id!==_state.secondGodId) return safeReply(interaction,{embeds:[createErrorEmbed("Only God can use this!")],flags:64});
    const sub=options.getSubcommand();

    if (sub==="menu") {
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0xffd700).setTitle("👑 God Commands")
        .addFields(
          {name:"🧬 Species Management",value:"`/god species-change @user <species>`\n`/god species-reset @user`\n`/god species-add @user <rolls>`",inline:false},
          {name:"🎒 Items",value:"`/god add items @user species_token <quantity>`",inline:false},
          {name:"⚙️ Management",value:"`/god rolls-reset @user`\n`/god quest-reset @user <quest>`\n`/god debug-db`\n`/god repair-user-db`",inline:false}
        ).setFooter({text:"Use /god menu to see this again"})]});
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
      if (spname==="Kitsune"&&target.id!==_client.user.id) return safeReply(interaction,{embeds:[createErrorEmbed("Kitsune is exclusive to Loz!")],flags:64});
      const newSp=getSpeciesByName(spname);
      if (!newSp) return safeReply(interaction,{embeds:[createErrorEmbed("Unknown species! Pick one from the dropdown.")],flags:64});
      const ud=_state.userSpecies.get(target.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0,badges:[]};
      // Only overwrite originalSpecies if currently Human
      // God-given species always becomes the new original
      ud.originalSpecies=newSp;
      ud.species=newSp;
      _state.userSpecies.set(target.id,ud);
      if (!await database.saveUserSpeciesFields(target.id,ud.species,ud.originalSpecies)) return safeReply(interaction,{embeds:[createErrorEmbed("MongoDB save failed. This change is not confirmed as saved; check the database before redeploying.")],flags:64});
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
    const uid=customId.split("_")[1];
    if (user.id!==uid) return safeReply(interaction,{embeds:[createErrorEmbed("This isn't your roll!")],flags:64});
    if (customId.startsWith("cancel_")) {
      _state.activeRolls.delete(user.id);
      return interaction.update(buildStyledCardPayload("Species Roll Cancelled",0x808080,[{body:"You kept your current species. No additional roll was used."}],true));
    }
    const userData=_state.userSpecies.get(user.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:1,requestsEnabled:true,lastSwitch:0};
    if ((userData.rolls||0)<1) return interaction.update(buildStyledCardPayload("No Rolls Left",0xff0000,[{body:"Use `/daily` for a free roll."}],true));
    const rollResult=getRandomSpecies();
    const newSpecies=rollResult.isDragon?getDragonSubtype():rollResult;
    userData.species=newSpecies;
    userData.originalSpecies=newSpecies;
    userData.rolls=(userData.rolls||0)-1;
    const rollData=_state.activeRolls.get(user.id);
    const pubMsgId=rollData?.messageId;
    await interaction.update(buildSpeciesRollControlsPayload(user.id,userData.rolls));
    if(userData.rolls<1) _state.activeRolls.delete(user.id);
    if(pubMsgId) {
      const payload=buildSpeciesRollAnnouncement(user.id,user.displayName||user.username,newSpecies,userData.rolls,true);
      channel.messages.fetch(pubMsgId).then(pubMsg=>pubMsg.edit(payload)).catch(()=>{});
    }
    database.saveUserSpecies(user.id,userData).catch(console.error);
    return;
  }

  // ── SWITCH ────────────────────────────────────────────────────
  if (customId==="switch_original"||customId==="switch_reaper"||customId==="switch_archdemon"||customId==="switch_mechangel") {
    const ud=_state.userSpecies.get(user.id);
    if (!ud) return interaction.update({content:"❌ No species data!",components:[]});
    const now=Date.now(), th=3*60*60*1000;
    if (user.id!==_state.ownerId&&user.id!==_state.secondGodId&&ud.lastSwitch&&now-ud.lastSwitch<th) {
      const tl=th-(now-ud.lastSwitch), h=Math.floor(tl/3600000), m=Math.floor((tl%3600000)/60000);
      return interaction.update({embeds:[createErrorEmbed(`Switch in **${h}h ${m}m**!`)],components:[]});
    }
    let newSp;
    if (customId==="switch_original") newSp=ud.originalSpecies;
    else if (customId==="switch_reaper") { if(!ud.questSpecies?.reaper?.unlocked) return interaction.update({content:"❌ Reaper not unlocked!",components:[]}); newSp=reaperSpecies; }
    else if (customId==="switch_archdemon") { if(ud.awakening?.demon?.awakened!==true) return interaction.update({content:"❌ Archdemon is locked. Complete the Demon awakening first.",components:[]}); newSp=archdemonSpecies; }
    else {
      if (ud.awakening?.cyborg?.awakened!==true) return interaction.update({content:"❌ Mechangel is locked. Complete the Cyborg awakening first.",components:[]});
      newSp=getSpeciesByName("Mechangel");
    }
    if (!newSp) return interaction.update({content:"❌ That species is unavailable.",components:[]});
    ud.species=newSp; ud.lastSwitch=Date.now();
    _state.userSpecies.set(user.id,ud);
    await database.saveUserSpecies(user.id,ud);
    return interaction.update({embeds:[createSuccessEmbed(`Switched to ${newSp.emoji} **${newSp.name}**! Next switch in 3h.`)],components:[]});
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
        if (choice==="attack") { fight.playerUltBuff={type:"nextAttack",multiplier:1.2,invincible:true}; log.push("🌍 **TERRA SHIELD — STRIKE!** 1.2× + invincible!"); }
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
    if (action==="thinking") return safeReply(interaction,{embeds:[createErrorEmbed("It's the bot's turn!")],flags:64});
    if (fight.timeout) clearTimeout(fight.timeout);
    await interaction.deferUpdate();
    const msg=_state.fightMessages.get(fightId);
    const log=fight.log||[];

    if (action==="forfeit") { await endBotFight(channel,fightId,"bot","player",fight.difficulty); return; }

    const playerC={id:fight.playerId,species:fight.playerSpecies,currentHp:fight.playerHp,maxHp:fight.playerMaxHp,ultBuff:fight.playerUltBuff,adaptiveStacks:fight.playerAdaptiveStacks||0,attackCounter:fight.playerAttackCounter||0,burn:fight.playerBurn||0,burnRounds:fight.playerBurnRounds||0,curse:fight.playerCurse||0,blockHeal:fight.playerBlockHeal||false,possession:fight.playerPossession||false,stunnedTurns:fight.playerStunnedTurns||0,healCooldown:fight.playerHealCooldown,ultCooldown:fight.playerUltCooldown,lastUltUsed:fight.playerLastUltUsed};
    const botC={id:"BOT",species:fight.botSpecies,currentHp:fight.botHp,maxHp:fight.botMaxHp,ultBuff:fight.botUltBuff,adaptiveStacks:fight.botAdaptiveStacks||0,attackCounter:fight.botAttackCounter||0,burn:fight.botBurn||0,burnRounds:fight.botBurnRounds||0,curse:fight.botCurse||0,blockHeal:fight.botBlockHeal||false,possession:fight.botPossession||false,stunnedTurns:fight.botStunnedTurns||0,healCooldown:fight.botHealCooldown,ultCooldown:fight.botUltCooldown,lastUltUsed:fight.botLastUltUsed};

    // Oni possession consumes the target's next action.
    if (playerC.possession) action="possessed";

    if (action==="possessed") {
      playerC.possession=false;
      const selfHit=Math.floor(Math.random()*(playerC.species.atkMax-playerC.species.atkMin+1))+playerC.species.atkMin;
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
        const {message:um,requiresChoice,choiceType}=applyUltEffect(playerC,botC);
        fight.playerLastUltUsed=playerC.lastUltUsed;
        if (requiresChoice) {
          fight.playerUltBuff=playerC.ultBuff; fight.playerUltCooldown=playerC.species.ultCooldown;
          fight.botHp=botC.currentHp; fight.playerHp=playerC.currentHp; fight.log=log.slice(-3);
          if (msg) await msg.edit({ content: null, embeds: null, ...buildBotFightMessagePayload(fight, fight.log, "choice", "choice_" + choiceType) }).catch(() => {});
          fight.timeout=setTimeout(()=>{ if(_state.activeBotFights.has(fightId)){fight.playerUltBuff={type:"nextAttack",multiplier:1.5}; doBotTurn(channel,fightId);} },30000);
          return;
        }
        fight.playerUltCooldown=playerC.species.ultCooldown;
        if (playerC.species.name==="Cyborg") await updateCyborgProgress(fight.playerId,"ult");
        if (playerC.species.name==="Ogre") botC.stunnedTurns=1;
        fight.playerHp=Math.max(0,playerC.currentHp); fight.botHp=Math.max(0,botC.currentHp); fight.botUltBuff=botC.ultBuff;
        log.push(`✨ **YOU USE ULT!**\n${um}`);
      }
    } else if (action==="attack") {
      const result=calculateDamage(playerC,botC);
      playerC.currentHp=Math.max(0,Math.min(playerC.maxHp,playerC.currentHp+result.attackerMutations.hpDelta));
      if (result.instantKill) {
        botC.currentHp=0;
        log.push(`⚔️ ${result.specialLines.join(" ")}`);
      } else if (result.missedAttack) {
        // Miss — show clearly, check if counter-strike killed player
        log.push(`${result.specialLines[0]||"💨 **MISS!**"}`);
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
    fight.playerBlockHeal=playerC.blockHeal; fight.playerAdaptiveStacks=playerC.adaptiveStacks; fight.playerAttackCounter=playerC.attackCounter;
    fight.playerPossession=playerC.possession||false;
    // FIX: sync bot ULT cooldown after tick (was being lost)
    fight.botUltCooldown=botC.ultCooldown;
    fight.botUltBuff=botC.ultBuff; fight.botBurn=botC.burn; fight.botBurnRounds=botC.burnRounds;
    fight.botCurse=botC.curse; fight.botPossession=botC.possession||false;
    fight.botBlockHeal=botC.blockHeal; fight.botAdaptiveStacks=botC.adaptiveStacks; fight.botAttackCounter=botC.attackCounter; fight.botStunnedTurns=botC.stunnedTurns||0;
    fight.log=log.slice(-3);

    if (fight.botHp<=0) { await endBotFight(channel,fightId,"player","bot",fight.difficulty); return; }
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
        if (choice==="attack") { player.ultBuff={type:"nextAttack",multiplier:1.2,invincible:true}; log.push(`🌍 <@${user.id}> chooses **TERRA STRIKE** — 1.2× + invincible!`); }
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
    if (user.id!==fight.currentTurn) return interaction.followUp({embeds:[createErrorEmbed("It's not your turn!")],flags:64});
    if (fight.timeout) clearTimeout(fight.timeout);
    const player=isP1?fight.player1:fight.player2;
    const opponent=isP1?fight.player2:fight.player1;
    const log=[];

    if (action==="forfeit") {
      if (Math.random()<0.35) { log.push(`😵 <@${user.id}> tried to forfeit but pride won't let them! Turn wasted.`); fight.currentTurn=opponent.id; fight.round++; }
      else { await endFight(channel,fightId,opponent.id,user.id,"forfeit"); return; }
    } else if (action==="ult") {
      if (player.ultCooldown>0) { log.push(`❌ <@${user.id}>'s ULT on cooldown for ${player.ultCooldown} more rounds!`); fight.currentTurn=opponent.id; fight.round++; }
      else {
        const {message:um,requiresChoice,choiceType}=applyUltEffect(player,opponent);
        if (requiresChoice) {
          player.ultChoicePending=true;
          const msg=_state.fightMessages.get(fightId);
          if (msg) await msg.edit({ content: null, embeds: null, ...buildFightMessagePayload(fight, ["Ultimate activated. Choose an option."], "choice", "choice_" + choiceType) }).catch(() => {});
          fight.timeout=setTimeout(()=>{
            if(_state.activeFights.has(fightId)&&player.ultChoicePending){
              player.ultChoicePending=false; player.ultCooldown=player.species.ultCooldown; player.ultBuff={type:"nextAttack",multiplier:1.5};
              fight.currentTurn=opponent.id; fight.round++;
              const msg2=_state.fightMessages.get(fightId);
              const tp=fight.currentTurn===fight.player1Id?fight.player1:fight.player2;
              if (msg2) msg2.edit({ content: null, embeds: null, ...buildFightMessagePayload(fight, ["Ultimate choice timed out."], "playing") }).catch(() => {});
            }
          },30000);
          return;
        }
        player.ultCooldown=player.species.ultCooldown;
        if (player.species.name==="Cyborg") await updateCyborgProgress(player.id,"ult");
        if (player.species.name==="Ogre") { opponent.stunnedTurns=1; log.push(`💥 **MASSIVE BLOW!** Opponent stunned! Extra turn!`); }
        log.push(`✨ <@${user.id}> uses ULT!\n${um}`);
        if (player.species.name==="Ogre") fight.currentTurn=user.id;
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
        player.currentHp=Math.min(player.maxHp,player.currentHp+actualH); player.healCooldown=3;
        log.push(`💚 <@${user.id}> heals for **${actualH} HP**! (${player.currentHp}/${player.maxHp})`);
        fight.currentTurn=opponent.id; fight.round++;
      }
    } else if (action==="attack") {
      if (player.possession) {
        player.possession=false;
        const selfHit=Math.floor(Math.random()*(player.species.atkMax-player.species.atkMin+1))+player.species.atkMin;
        player.currentHp=Math.max(0,player.currentHp-selfHit);
        log.push(`🎭 **POSSESSION!** <@${user.id}> attacks themselves for ${selfHit}!`);
        fight.currentTurn=opponent.id; fight.round++;
      } else {
        const result=calculateDamage(player,opponent);
        player.currentHp=Math.max(0,Math.min(player.maxHp,player.currentHp+result.attackerMutations.hpDelta));
        if (result.instantKill) {
          opponent.currentHp=0;
          log.push(`⚔️ <@${user.id}> — ${result.specialLines.join(" ")}`);
        } else if (result.missedAttack) {
          // Miss — show clearly, handle counter-strike death
          log.push(`${result.specialLines[0]||"💨 **MISS!**"}`);
          if (opponent.species.name==="God") { const gh=Math.floor(opponent.currentHp*0.2); opponent.currentHp=Math.min(opponent.maxHp,opponent.currentHp+gh); log.push(`👑 **Divine Retribution!** Heals ${gh}!`); }
          // player.currentHp already reduced by counter in attackerMutations above — check death
          if (player.currentHp<=0) { await endFight(channel,fightId,opponent.id,user.id,"counter"); return; }
        } else {
          opponent.currentHp=Math.max(0,opponent.currentHp-result.damage);
          if (opponent.species.name==="Chimera"&&result.damage>0) opponent.adaptiveStacks=Math.min(3,(opponent.adaptiveStacks||0)+1);
          if (opponent.species.name==="God"&&result.missedAttack) { const gh=Math.floor(opponent.currentHp*0.2); opponent.currentHp=Math.min(opponent.maxHp,opponent.currentHp+gh); log.push(`👑 **Divine Retribution!** ${opponent.species.name} heals ${gh}!`); }
          log.push(`⚔️ <@${user.id}> deals **${result.damage}** damage!${result.specialLines.length?` (${result.specialLines.slice(0,2).join(", ")})`:""}`);
        }
        fight.currentTurn=opponent.id; fight.round++;
      }
    }

    // Burn tick on opponent
    if (opponent.burn>0) { const bd=opponent.burn; opponent.currentHp=Math.max(0,opponent.currentHp-bd); opponent.burnRounds--; if(opponent.burnRounds<=0){opponent.burn=0;opponent.burnRounds=0;} log.push(`🔥 ${opponent.species.name} takes ${bd} burn!`); }
    const or=applyOgreRegen(player); if(or) log.push(or);
    // FIX: tick BOTH players ULT cooldown every round
    tickBothUltCooldowns(player, opponent);
        // FIX: sync opponent ULT cooldown back to fight object
        if (isP1) fight.player2.ultCooldown=opponent.ultCooldown;
        else      fight.player1.ultCooldown=opponent.ultCooldown;

    if (opponent.currentHp<=0) { await endFight(channel,fightId,user.id,opponent.id,"normal"); return; }
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
  new SlashCommandBuilder().setName("species").setDescription("View species list or a specific species card").addStringOption(o=>o.setName("species").setDescription("Species name for detailed card (leave blank for full list)").addChoices({name:"Demi God ⚡",value:"Demi God"},{name:"Demon Lord 🔥",value:"Demon Lord"},{name:"Demon King 👑😈",value:"Demon King"},{name:"Chimera 🎭",value:"Chimera"},{name:"Angel 👼",value:"Angel"},{name:"Demon 😈",value:"Demon"},{name:"Oni 👿",value:"Oni"},{name:"Orc Lord 👑",value:"Orc Lord"},{name:"Kijin 🎭",value:"Kijin"},{name:"Cyborg 🤖",value:"Cyborg"},{name:"High Orc ⚔️",value:"High Orc"},{name:"Ogre 👹",value:"Ogre"},{name:"Goblin 👺",value:"Goblin"},{name:"Orc 🟢",value:"Orc"},{name:"Half-Blood 🩸",value:"Half-Blood"},{name:"Fire Dragon 🔥🐉",value:"Fire Dragon"},{name:"Thunder Dragon ⚡🐉",value:"Thunder Dragon"},{name:"Ice Dragon ❄️🐉",value:"Ice Dragon"},{name:"Earth Dragon 🌍🐉",value:"Earth Dragon"},{name:"Reaper 🌑",value:"Reaper"},{name:"Archdemon 👿",value:"Archdemon"},{name:"Mechangel ⚡🤖",value:"Mechangel"},{name:"God 👑✨",value:"God"},{name:"Human 👤",value:"Human"})),
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
  new SlashCommandBuilder().setName("fights").setDescription("Fight leaderboard"),
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
    .addIntegerOption(o=>o.setName("amount").setDescription("Number of rolls to gift").setRequired(true).setMinValue(1).setMaxValue(2)),
  new SlashCommandBuilder().setName("togglerequests").setDescription("Toggle receiving challenge requests").addStringOption(o=>o.setName("status").setDescription("Enable or disable").setRequired(true).addChoices({name:"Enable",value:"enable"},{name:"Disable",value:"disable"})),
  new SlashCommandBuilder().setName("quest").setDescription("Quest system")
    .addSubcommand(s=>s.setName("view").setDescription("View your quests").addUserOption(o=>o.setName("user").setDescription("User to check")))
    .addSubcommand(s=>s.setName("claim").setDescription("Claim a quest reward").addStringOption(o=>o.setName("quest").setDescription("Quest to claim").setRequired(true).addChoices({name:"Reaper",value:"reaper"},))),
  // default_member_permissions=0 hides these from normal members; handlers still enforce the exact allow-list.
  new SlashCommandBuilder().setName("god").setDescription("God-only commands")
    .addSubcommand(s=>s.setName("menu").setDescription("Show god menu"))
    .addSubcommandGroup(g=>g.setName("add").setDescription("Give items to a user")
      .addSubcommand(s=>s.setName("items").setDescription("Give inventory items to a user")
        .addUserOption(o=>o.setName("user").setDescription("User receiving the item").setRequired(true))
        .addStringOption(o=>o.setName("item").setDescription("Item to give").setRequired(true).addChoices({name:"Species Token",value:"species_token"}))
        .addIntegerOption(o=>o.setName("quantity").setDescription("Quantity to give").setRequired(true).setMinValue(1).setMaxValue(1000000))))
    .addSubcommand(s=>s.setName("species-change").setDescription("Change a user's species").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)).addStringOption(o=>o.setName("species").setDescription("Species to set").setRequired(true).addChoices({name:"Demi God ⚡",value:"Demi God"},{name:"Demon Lord 🔥",value:"Demon Lord"},{name:"Demon King 👑😈",value:"Demon King"},{name:"Chimera 🎭",value:"Chimera"},{name:"Angel 👼",value:"Angel"},{name:"Demon 😈",value:"Demon"},{name:"Oni 👿",value:"Oni"},{name:"Orc Lord 👑",value:"Orc Lord"},{name:"Kijin 🎭",value:"Kijin"},{name:"Cyborg 🤖",value:"Cyborg"},{name:"High Orc ⚔️",value:"High Orc"},{name:"Ogre 👹",value:"Ogre"},{name:"Goblin 👺",value:"Goblin"},{name:"Orc 🟢",value:"Orc"},{name:"Half-Blood 🩸",value:"Half-Blood"},{name:"Fire Dragon 🔥🐉",value:"Fire Dragon"},{name:"Thunder Dragon ⚡🐉",value:"Thunder Dragon"},{name:"Ice Dragon ❄️🐉",value:"Ice Dragon"},{name:"Earth Dragon 🌍🐉",value:"Earth Dragon"},{name:"Reaper 🌑",value:"Reaper"},{name:"Archdemon 👿",value:"Archdemon"},{name:"Mechangel ⚡🤖",value:"Mechangel"},{name:"God 👑✨",value:"God"},{name:"Human 👤",value:"Human"})))
    .addSubcommand(s=>s.setName("species-reset").setDescription("Reset a user to Human").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)))
    .addSubcommand(s=>s.setName("species-add").setDescription("Give rolls to a user").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)).addIntegerOption(o=>o.setName("amount").setDescription("Amount of rolls").setRequired(true).setMinValue(1).setMaxValue(1000000)))
    .addSubcommand(s=>s.setName("rolls-reset").setDescription("Reset a user's rolls to 0").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)))
    .addSubcommand(s=>s.setName("quest-reset").setDescription("Reset a user's quest").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)).addStringOption(o=>o.setName("quest").setDescription("Quest name").setRequired(true).addChoices({name:"Reaper",value:"reaper"},{name:"All",value:"all"})))
    .addSubcommand(s=>s.setName("debug-db").setDescription("Check database keys"))
    .addSubcommand(s=>s.setName("repair-user-db").setDescription("Archive and repair duplicate player records")),
].map(c=>c.toJSON());

module.exports = { setState, setClient, handleCommand, handleButton, handleSelectMenu, maybePromptForUpdates, commands };
