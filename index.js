const {
  Client, GatewayIntentBits, PermissionsBitField, REST, Routes,
} = require("discord.js");

const database = require("./database.js"); // MongoDB
const state    = require("./state.js");
const { setState: setHelperState, assignSpeciesRole } = require("./helpers.js");
const { setState: setFightState }   = require("./fights.js");
const { setState: setCommandState, setClient, handleCommand, handleButton, commands } = require("./commands.js");
const { disintegrationMessages } = require("./constants.js");

// ==================== CONSTANTS ====================
const ownerId     = "926063716057894953";
const secondGodId = "1445387368830992455";
const TOKEN       = process.env.TOKEN;
const CLIENT_ID   = process.env.CLIENT_ID;
const prefix      = "'";

// Attach owner IDs to state so helpers/commands can read them
state.ownerId     = ownerId;
state.secondGodId = secondGodId;

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

// ==================== READY EVENT ====================
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const success = await database.loadAllData(
    state.userSpecies, state.leaderboard, state.fightLeaderboard,
    state.fightStats, state.dailyClaims, state.botStats,
  );

  for (const guild of client.guilds.cache.values()) {
    const sc = await database.loadDuelChannel(guild.id);
    if (sc) { state.duelChannels.set(guild.id, sc); console.log(`📋 Loaded duel channel for ${guild.name}`); }
  }

  await database.loadAllQuestProgress(state.questProgress, state.userSpecies);

  console.log(success ? "✅ Database loaded" : "⚠️ Database loaded with issues");
  client.user.setPresence({ activities:[{name:"loz-bot | /help", type:2}], status:"dnd" });
  console.log(`🎉 Bot ready with ${state.userSpecies.size} users!`);
});

// ==================== MESSAGE CREATE (prefix commands) ====================
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // Bot mention response
    if (message.content.startsWith(`<@${client.user.id}>`) || message.content.startsWith(`<@!${client.user.id}>`))
      return message.reply(`👋 **${client.user.username}** here!\nUse \`/guide\` to learn how to play or \`/help\` for all commands. Start with \`/species-roll\`! 🎲`);

    if (!message.content.startsWith(prefix)) return;
    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

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
    if (interaction.isCommand()) await handleCommand(interaction);
    else if (interaction.isButton()) await handleButton(interaction);
  } catch (e) {
    if (e.code === 10062 || e.message?.includes("Unknown interaction")) return;
    console.error("Interaction error:", e);
    try {
      const { createErrorEmbed, safeReply } = require("./helpers.js");
      await safeReply(interaction, { embeds:[createErrorEmbed("An error occurred. Please try again.")], flags:64 });
    } catch(_) {}
  }
});

// ==================== GUILD MEMBER ADD ====================
client.on("guildMemberAdd", async (member) => {
  try {
    if (!member.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;
    const ud = state.userSpecies.get(member.id);
    if (ud?.species?.roleName) {
      const role = member.guild.roles.cache.find(r => r.name === ud.species.roleName);
      if (role && !member.roles.cache.has(role.id)) { await member.roles.add(role); console.log(`✅ Gave ${ud.species.name} role to ${member.user.tag}`); }
    }
  } catch(e) { console.error("guildMemberAdd error:", e.message); }
});

// ==================== REGISTER SLASH COMMANDS ====================
const rest = new REST({ version:"10" }).setToken(TOKEN);
(async () => {
  try {
    console.log("🔄 Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Commands registered!");
  } catch(e) { console.error("Command registration error:", e); }
})();

// ==================== LOGIN ====================
client.login(TOKEN);
