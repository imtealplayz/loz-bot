const {
  Client, GatewayIntentBits, PermissionsBitField, REST, Routes,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags,
} = require("discord.js");

const database = require("./database.js"); // MongoDB
const state    = require("./state.js");
const { setState: setHelperState } = require("./helpers.js");
const { setState: setFightState }   = require("./fights.js");
const { setState: setCommandState, setClient, handleCommand, handleButton, handleSelectMenu, maybePromptForUpdates, commands } = require("./commands.js");
const { disintegrationMessages } = require("./constants.js");

// ==================== CONSTANTS ====================
const ownerId     = "926063716057894953";
const secondGodId = "1445387368830992455";
const TOKEN = (process.env.TOKEN || process.env.DISCORD_TOKEN || "").trim();
const prefix      = "'";

// Attach owner IDs to state so helpers/commands can read them
state.ownerId     = ownerId;
state.secondGodId = secondGodId;

let databaseReady = false;

// ==================== CLIENT ====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// ==================== WIRE STATE INTO EVERY MODULE ====================
setHelperState(state);
setFightState(state);
setCommandState(state);
setClient(client);

// ==================== PROCESS HANDLERS ====================
process.on("unhandledRejection", e => console.error("Unhandled rejection:", e));
process.on("uncaughtException",  e => console.error("Uncaught exception:", e));

// ==================== PRESENCE ====================
function updatePresence() {
  client.user.setPresence({
    activities: [{
      name: "Custom Status",
      type: 4,
      state: `Serving ${client.guilds.cache.size} servers`,
    }],
    status: "online",
  });
}

client.on("guildCreate", updatePresence);
client.on("guildDelete", updatePresence);

// ==================== COMMAND REGISTRATION ====================
async function registerCommands() {
  try {
    if (!client.user?.id || !client.token) {
      console.error("❌ Cannot register slash commands: Discord client is not authenticated.");
      return;
    }

    const rest = new REST({ version:"10" }).setToken(client.token);
    const localGod = commands.find(command => command.name === "god");
    console.log(`🔄 Registering ${commands.length} global slash commands...`);
    console.log("🔎 Local /god subcommands:", (localGod?.options ?? []).map(option => option.name).join(", ") || "(none)");

    const registered = await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    const remoteGod = registered.find(command => command.name === "god");
    const remoteSubcommands = (remoteGod?.options ?? []).map(option => option.name);
    console.log(`✅ Discord accepted ${registered.length} global slash commands.`);
    console.log("🔎 Discord returned /god subcommands:", remoteSubcommands.join(", ") || "(none)");

    if (remoteSubcommands.includes("repair-user-db")) {
      console.log("✅ Verified /god repair-user-db in Discord's registered command response.");
    } else {
      console.error("❌ Discord's registration response is missing /god repair-user-db.");
    }
  } catch (e) {
    console.error("❌ Slash command registration failed:", e);
    console.error("Registration error details:", e?.rawError ?? e?.message ?? String(e));
  }
}

// ==================== READY EVENT ====================
client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const success = await database.loadAllData(
    state.userSpecies, state.leaderboard, state.fightLeaderboard,
    state.fightStats, state.dailyClaims, state.botStats,
  );

  if (!success) {
    console.error("❌ LOZ cannot start without MongoDB. Check MONGODB_URI in Railway and restart the service.");
    process.exit(1);
  }

  for (const guild of client.guilds.cache.values()) {
    const sc = await database.loadDuelChannel(guild.id);
    if (sc) { state.duelChannels.set(guild.id, sc); console.log(`📋 Loaded duel channel for ${guild.name}`); }
  }

  await database.loadAllQuestProgress(state.questProgress, state.userSpecies);

  // Only allow state-changing interactions after persistent data is fully loaded.
  databaseReady = true;
  await registerCommands();

  console.log("✅ Database loaded");
  updatePresence();
  console.log(`🎉 Bot ready with ${state.userSpecies.size} users!`);
});

// ==================== MESSAGE CREATE (prefix commands) ====================
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // Bot mention response
    if (
      message.content.startsWith(`<@${client.user.id}>`) ||
      message.content.startsWith(`<@!${client.user.id}>`)
    ) {
      const mentionCard = new ContainerBuilder().setAccentColor(0x0891b2);
      mentionCard.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `## Legends of the Rift | LOZ
I'm here! LOZ is a turn-based RPG where you collect species, learn their abilities, and challenge players or battle bots.`
      ));
      mentionCard.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
      mentionCard.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `### Start Your Journey
**\`/guide\`** — Learn how LOZ works and claim your one-time tutorial roll.
**\`/species-roll\`** — Roll for a species.
**\`/daily\`** — Claim your daily reward.`
      ));
      mentionCard.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
      mentionCard.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `### Explore & Get Help
**\`/species\`** — Browse species, stats, passives, and ultimates.
**\`/profile\`** — View your current species and progress.
**\`/help\`** — Browse LOZ's commands.

**New here?** Start with \`/guide\`.`
      ));
      return message.reply({
        components: [mentionCard],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
      });
    }

    if (!message.content.startsWith(prefix)) return;
    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // ── 'disable all ──────────────────────────────────────────────
    if (command === "disable" && args[0] === "all") {
      if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator))
        return message.reply("❌ You need Administrator permission to use this!");
      state.disabledChannels.add(message.channel.id);
      return message.reply(`🔒 **LOZ disabled in <#${message.channel.id}>.**
Users can no longer use LOZ commands here. Use \`'enable all\` to re-enable.`);
    }

    // ── 'enable all ───────────────────────────────────────────────
    if (command === "enable" && args[0] === "all") {
      if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator))
        return message.reply("❌ You need Administrator permission to use this!");
      state.disabledChannels.delete(message.channel.id);
      return message.reply(`🔓 **LOZ enabled in <#${message.channel.id}>.**
Users can use LOZ commands here again.`);
    }

    // ── 'disintegrate ─────────────────────────────────────────────
    if (command === "disintegrate") {
      if (message.author.id !== ownerId) return message.reply("❌ Only God can use this command!");
      let activeFight = null, fightId = null;
      for (const [id, fight] of state.activeFights.entries()) {
        if (fight.player1Id === message.author.id || fight.player2Id === message.author.id) { activeFight = fight; fightId = id; break; }
      }
      if (!activeFight) return message.reply("❌ You are not in a fight!");
      const opponentId = activeFight.player1Id === message.author.id ? activeFight.player2Id : activeFight.player1Id;
      if (activeFight.timeout) clearTimeout(activeFight.timeout);
      const shuffled = [...disintegrationMessages].sort(() => 0.5 - Math.random()).slice(0, 8);
      for (const m of shuffled) {
        await message.channel.send(m.replace(/%attacker%/g, message.author.id).replace(/%defender%/g, opponentId));
        await new Promise(r => setTimeout(r, 800));
      }
      await message.channel.send("🏆 **GOD WINS BY DIVINE INTERVENTION!**");
      const { updateFightStats } = require("./helpers.js");
      updateFightStats(message.author.id, true, opponentId, { opponentName:activeFight.player1Id===opponentId?activeFight.player1.species.name:activeFight.player2.species.name, hpLeft:999, special:"💀 disintegration" });
      updateFightStats(opponentId, false, message.author.id, { opponentName:activeFight.player1Id===message.author.id?activeFight.player1.species.name:activeFight.player2.species.name, hpLeft:0, special:"💀 disintegrated" });
      state.fightCooldowns.set(message.author.id, Date.now()+60000);
      state.fightCooldowns.set(opponentId, Date.now()+60000);
      const fightMsg = state.fightMessages.get(fightId);
      if (fightMsg) await fightMsg.edit({ content:"💀 Fight ended by divine intervention.", components:[] }).catch(() => {});
      state.activeFights.delete(fightId);
      state.fightMessages.delete(fightId);
    }

  } catch(e) { console.error("messageCreate error:", e); }
});

// ==================== INTERACTION CREATE ====================
client.on("interactionCreate", async (interaction) => {
  try {
    // Never let startup-time commands write fallback/default state over saved records.
    if (!databaseReady && (interaction.isCommand() || interaction.isButton() || interaction.isStringSelectMenu())) {
      return interaction.reply({
        content: "LOZ is loading saved player data after a restart. Please try again in a few seconds.",
        flags: 64,
      }).catch(() => {});
    }

    // Block commands in disabled channels
    if (state.disabledChannels.has(interaction.channelId)) {
      if (interaction.isCommand() || interaction.isButton() || interaction.isStringSelectMenu()) {
        return interaction.reply({ content: "🔒 LOZ commands are disabled in this channel.", ephemeral: true }).catch(()=>{});
      }
    }
    if (interaction.isCommand()) {
      await handleCommand(interaction);
      // The command's main response is sent first; subscription prompt is a separate ephemeral follow-up.
      await maybePromptForUpdates(interaction);
    } else if (interaction.isButton()) await handleButton(interaction);
    else if (interaction.isStringSelectMenu()) await handleSelectMenu(interaction);
  } catch (e) {
    if (e.code === 10062 || e.message?.includes("Unknown interaction")) return;
    console.error("Interaction error:", e);
    try {
      const { createErrorEmbed, safeReply } = require("./helpers.js");
      await safeReply(interaction, { embeds:[createErrorEmbed("An error occurred. Please try again.")], flags:64 });
    } catch(_) {}
  }
});

// ==================== LOGIN ====================
if (!TOKEN) {
  console.error("❌ Missing Discord bot token. Set TOKEN (or DISCORD_TOKEN) in Railway environment variables.");
  process.exit(1);
}

client.login(TOKEN).catch(e => {
  console.error("❌ Discord login failed:", e.message);
  process.exit(1);
});
