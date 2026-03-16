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

  await database.loadAllQuestProgress(state.questProgress);

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

    // Reversed users
    if (state.reversedUsers.has(message.author.id)) {
      const rd = state.reversedUsers.get(message.author.id);
      if (rd.messagesLeft > 0 && message.channel.id === rd.channelId) {
        try {
          const rev = message.content.split("").reverse().join("");
          await message.delete();
          await message.channel.send(`🔁 **<@${message.author.id}>:** ${rev}`);
          rd.messagesLeft--;
          if (rd.messagesLeft <= 0) { state.reversedUsers.delete(message.author.id); await message.channel.send(`✅ <@${message.author.id}> is back to normal!`); }
        } catch(e) {}
      }
    }

    if (!message.content.startsWith(prefix)) return;
    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // ── 'pass ────────────────────────────────────────────────────
    if (command === "pass") {
      if (!state.bombGames.has(message.channel.id)) return;
      const game = state.bombGames.get(message.channel.id);
      if (game.status !== "playing" || !game.roundActive) { await message.react("❌"); return; }
      if (game.mode === "bot") {
        if (message.author.id !== game.currentBombHolder) { await message.react("❌"); return; }
        const timeLeft = Math.max(0, Math.ceil((game.bombEndTime - Date.now()) / 1000));
        if (Math.random() < game.botFailRate) {
          await message.react("❌"); await message.channel.send(`😵 **PASS FAILED!** You fumbled the bomb! ⏰ **${timeLeft}s left**`);
        } else {
          game.currentBombHolder = "BOT"; await message.react("✅");
          await message.channel.send(`✅ <@${message.author.id}> passed to the bot! ⏰ **${timeLeft}s left**`);
          const { handleBotPass } = require("./fights.js");
          setTimeout(() => { if(game.status==="playing"&&game.currentBombHolder==="BOT"&&game.roundActive) handleBotPass(message.channel, game); }, game.botReactionDelay);
        }
        return;
      }
      if (message.author.id !== game.currentBombHolder) { await message.react("❌"); return; }
      const targetUser = message.mentions.users.first();
      if (!targetUser || !game.players.has(targetUser.id) || targetUser.id === message.author.id || game.eliminated.includes(targetUser.id)) { await message.react("❌"); return; }
      const failChance = game.mode === "duel" ? Math.random() < 0.35 : Math.random() < 0.1;
      const tl = Math.max(0, Math.ceil((game.bombEndTime - Date.now()) / 1000));
      if (failChance) { await message.react("❌"); await message.channel.send(`😵 **PASS FAILED!** You still have the bomb! ⏰ **${tl}s left**`); }
      else { game.currentBombHolder = targetUser.id; await message.react("✅"); await message.channel.send(`✅ <@${message.author.id}> passed to <@${targetUser.id}>! ⏰ **${tl}s left**`); }
    }

    // ── 'judge ────────────────────────────────────────────────────
    if (command === "judge") {
      if (message.author.id !== ownerId) return message.reply("❌ Only God can use this command!");
      const targetUser = message.mentions.users.first();
      if (!targetUser) return message.reply("❌ Mention a user to judge!");
      if (!state.bombGames.has(message.channel.id)) return message.reply("❌ No bomb game in this channel!");
      const game = state.bombGames.get(message.channel.id);
      if (game.judgeUsed) return message.reply("❌ Judge already used this game!");
      game.judgeUsed = true;
      const opponentId = Array.from(game.players).find(id => id !== message.author.id) || targetUser.id;
      const shuffled = [...disintegrationMessages].sort(() => 0.5 - Math.random()).slice(0, 6);
      for (const m of shuffled) {
        await message.channel.send(m.replace(/%attacker%/g, message.author.id).replace(/%defender%/g, opponentId));
        await new Promise(r => setTimeout(r, 800));
      }
      await message.channel.send("🏆 **GOD WINS BY DIVINE JUDGMENT!**");
      state.bombGames.delete(message.channel.id);
    }

    // ── 'revive ───────────────────────────────────────────────────
    if (command === "revive") {
      if (message.author.id !== ownerId) return message.reply("❌ Only God can use this command!");
      const targetUser = message.mentions.users.first();
      if (!targetUser) return message.reply("❌ Mention a user to revive!");
      if (!state.bombGames.has(message.channel.id)) return message.reply("❌ No bomb game in this channel!");
      const game = state.bombGames.get(message.channel.id);
      if (game.mode === "duel" || game.mode === "bot") return message.reply("❌ Revive only works in normal bomb tag!");
      if (!game.eliminated.includes(targetUser.id)) return message.reply("❌ That user is not eliminated!");
      if (game.reviveUsed) return message.reply("❌ Revive already used this game!");
      game.reviveUsed = true;
      game.eliminated = game.eliminated.filter(id => id !== targetUser.id);
      game.players.add(targetUser.id);
      if (game.gameType === "locked") {
        await message.channel.permissionOverwrites.edit(targetUser.id, { SendMessages: true }).catch(() => {});
      }
      const msgs = [
        "✨ *A gentle light begins to glow...*",
        "🌙 The moon dims as divine energy gathers...",
        "💫 Golden particles swirl together, forming a shape...",
        `👁️ **THE EYE OF CREATION OPENS** 👁️\nIt gazes upon the void where <@${targetUser.id}> once stood.`,
        "💞 A heartbeat echoes through the heavens...",
        `💫 **DIVINE MERCY** 💫\n<@${message.author.id}> speaks: "Rise, my child. Your purpose is not yet fulfilled."\n\n<@${targetUser.id}> reforms from pure light!\n✅ <@${targetUser.id}> has been revived!`,
      ];
      for (const m of msgs) { await message.channel.send(m); await new Promise(r => setTimeout(r, 800)); }
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
