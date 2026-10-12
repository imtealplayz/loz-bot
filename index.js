const {
  Client, GatewayIntentBits, PermissionsBitField, REST, Routes,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags,
} = require("discord.js");
const express = require("express");

const database = require("./database.js"); // MongoDB
const state    = require("./state.js");
const { setState: setHelperState } = require("./helpers.js");
const { setState: setFightState }   = require("./fights.js");
const { setState: setCommandState, setClient, handleCommand, handleButton, handleSelectMenu, maybePromptForUpdates, commands } = require("./commands.js");
const { disintegrationMessages } = require("./constants.js");
const questSystem = require("./quest-system.js");

// ==================== CONSTANTS ====================
const ownerId     = "926063716057894953";
const secondGodId = "1445387368830992455";
const TOKEN = (process.env.TOKEN || process.env.DISCORD_TOKEN || "").trim();
const prefix      = "'";

// Attach owner IDs to state so helpers/commands can read them
state.ownerId     = ownerId;
state.secondGodId = secondGodId;

let databaseReady = false;

// ==================== HEALTH + TOP.GG WEBHOOK ====================
const crypto = require("node:crypto");
const webhookApp = express();
const topggSecret = (process.env.TOPGG_WEBHOOK_SECRET || "").trim();
let topggWebhookEnabled = false;

webhookApp.get("/health", (_req, res) => res.status(databaseReady ? 200 : 503).json({
  status: databaseReady ? "ok" : "starting",
  service: "loz-bot",
  voteWebhookEnabled: topggWebhookEnabled,
}));

function safeTextEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Top.gg v1 signs "<unix timestamp>.<raw request body>" with HMAC-SHA256
// and sends the result in X-Topgg-Signature. Keep the bytes intact until
// signature verification completes.
function verifyTopggRequest(req) {
  if (!Buffer.isBuffer(req.body)) {
    return { ok:false, status:400, error:"Expected a raw JSON request body." };
  }

  const signatureHeader = req.get("x-topgg-signature");
  if (signatureHeader) {
    const timestampMatch = signatureHeader.match(/(?:^|,)\s*t=(\d+)\s*(?:,|$)/i);
    const signatureMatch = signatureHeader.match(/(?:^|,)\s*v1=([a-f0-9]+)\s*(?:,|$)/i);
    if (!timestampMatch || !signatureMatch) {
      return { ok:false, status:401, error:"Malformed Top.gg signature." };
    }

    const timestamp = Number(timestampMatch[1]);
    if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) {
      return { ok:false, status:401, error:"Top.gg signature timestamp is outside the allowed window." };
    }

    const expected = crypto.createHmac("sha256", topggSecret)
      .update(String(timestamp))
      .update(".")
      .update(req.body)
      .digest();
    const received = Buffer.from(signatureMatch[1], "hex");
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      return { ok:false, status:401, error:"Invalid Top.gg signature." };
    }
    return { ok:true, version:"v1" };
  }

  // Preserve support for older v0 endpoints using a custom Authorization
  // secret. A generated v1 whs_ secret must never fall back to unsigned auth.
  if (topggSecret.startsWith("whs_")) {
    return { ok:false, status:401, error:"Missing Top.gg v1 signature." };
  }
  if (!safeTextEqual(req.get("authorization"), topggSecret)) {
    return { ok:false, status:401, error:"Invalid legacy Top.gg authorization." };
  }
  return { ok:true, version:"v0" };
}

function getIdentifier(value) {
  if (value && typeof value === "object") {
    return value.id ?? value.userId ?? value.discordId ?? "";
  }
  return value ?? "";
}

function normalizeTopggPayload(payload) {
  // Top.gg has sent both flat legacy payloads and wrapped event payloads.
  // Walk known envelope keys from the innermost event outward so a wrapper
  // event label cannot hide the actual vote/test type or voter identifiers.
  const objects = [];
  const seen = new Set();
  function collect(value, depth=0) {
    if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(value) || depth > 5) return;
    seen.add(value);
    for (const key of ["vote", "data", "event", "payload", "details"]) {
      if (value[key] && typeof value[key] === "object") collect(value[key], depth+1);
    }
    objects.push(value);
  }
  collect(payload);

  const typeValues = [];
  for (const item of objects) {
    for (const key of ["type", "eventType", "event"]) {
      if (typeof item[key] === "string" && item[key].trim()) {
        typeValues.push(item[key].trim().toLowerCase());
      }
    }
  }
  const testTypes = new Set(["test", "webhook.test", "vote.test", "testvote", "vote.tested"]);
  const isTest = objects.some(item => item.isTest === true) || typeValues.some(type => testTypes.has(type));
  if (isTest) return { isTest:true, type:"test" };

  const upvoteTypes = new Set(["vote.create", "vote.created", "vote", "upvote", "vote.received"]);
  const recognizedType = typeValues.find(type => upvoteTypes.has(type));
  const type = recognizedType || typeValues[0] || "";
  const normalizedType = recognizedType ? "upvote" : (!type ? "upvote" : type);

  const userKeys = ["user", "userId", "voterId", "voter", "discordUserId"];
  const botKeys = ["bot", "botId", "receiverId", "projectId", "entityId"];
  function firstIdentifier(keys) {
    for (const item of objects) {
      for (const key of keys) {
        if (item[key] !== undefined && item[key] !== null && item[key] !== "") {
          const identifier = getIdentifier(item[key]);
          if (identifier !== "") return String(identifier);
        }
      }
    }
    return "";
  }

  return {
    user:firstIdentifier(userKeys),
    bot:firstIdentifier(botKeys),
    type:normalizedType,
    isWeekend:objects.some(item => item.isWeekend === true),
  };
}

async function startHttpServer() {
  if (topggSecret) {
    // express.raw preserves exact bytes required by Top.gg v1 signature checks.
    webhookApp.post("/topgg/webhook", express.raw({ type:"application/json", limit:"100kb" }), async (req, res) => {
      const verification = verifyTopggRequest(req);
      if (!verification.ok) {
        console.warn("[Top.gg] Rejected webhook request:", verification.error);
        return res.status(verification.status).json({ error:verification.error });
      }

      let payload;
      try {
        payload = JSON.parse(req.body.toString("utf8"));
      } catch (_) {
        return res.status(400).json({ error:"Invalid JSON webhook payload." });
      }

      const vote = normalizeTopggPayload(payload);
      console.info("[Top.gg] Verified webhook received:", JSON.stringify({
        version:verification.version,
        type:vote.type || "unknown",
        isTest:vote.isTest === true,
        hasUserId:/^\d{17,20}$/.test(String(vote.user || "")),
        hasBotId:Boolean(vote.bot),
      }));
      if (vote.isTest) {
        console.log("[Top.gg] Test webhook acknowledged; no reward was granted.");
        return res.status(204).end();
      }

      if (!databaseReady) {
        console.warn("[Top.gg] Vote received before database startup completed; asking Top.gg to retry.");
        return res.status(503).json({ error:"LOZ is still starting up. Retry this webhook." });
      }

      try {
        const result = await questSystem.handleTopggVote(vote);
        if (result && result.accepted === true) {
          console.log("[Top.gg] Reward handler accepted vote for user " + String(vote.user) + ".");
        } else {
          console.warn("[Top.gg] Webhook acknowledged without a reward:", String(result && result.reason || "unreported_reason"));
        }
        return res.status(204).end();
      } catch (error) {
        console.error("[Top.gg] Vote processing failed; asking Top.gg to retry:", error);
        return res.status(500).json({ error:"LOZ could not process this vote yet." });
      }
    });

    topggWebhookEnabled = true;
    questSystem.setVoteWebhookEnabled(true);
    console.log("[Top.gg] Vote webhook initialized (signed v1 with legacy v0 compatibility).");
  } else {
    questSystem.setVoteWebhookEnabled(false);
    webhookApp.post("/topgg/webhook", (_req, res) => res.status(503).json({ error:"TOPGG_WEBHOOK_SECRET is not configured" }));
    console.warn("[Top.gg] Vote rewards are disabled until TOPGG_WEBHOOK_SECRET is configured in Railway.");
  }

  const httpServer = webhookApp.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () => {
    console.log("[HTTP] LOZ health and Top.gg webhook service is listening.");
  });
  httpServer.on("error", error => console.error("[HTTP] Health/webhook server error:", error));
}

startHttpServer();

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
questSystem.setState(state);
questSystem.setClient(client);

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
    const localOwner = commands.find(command => command.name === "owner");
    console.log(`🔄 Registering ${commands.length} global slash commands...`);
    console.log("🔎 Local /owner subcommands:", (localOwner?.options ?? []).map(option => option.name).join(", ") || "(none)");

    const registered = await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    const remoteOwner = registered.find(command => command.name === "owner");
    const remoteSubcommands = (remoteOwner?.options ?? []).map(option => option.name);
    console.log(`✅ Discord accepted ${registered.length} global slash commands.`);
    console.log("🔎 Discord returned /owner subcommands:", remoteSubcommands.join(", ") || "(none)");

    if (remoteSubcommands.includes("repair-user-db")) {
      console.log("✅ Verified /owner repair-user-db in Discord's registered command response.");
    } else {
      console.error("❌ Discord's registration response is missing /owner repair-user-db.");
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
  const questBoardsLoaded = await database.loadAllQuestBoards(state.questBoards);
  if (!questBoardsLoaded) {
    console.error("❌ LOZ cannot start without loading persistent quest-board data. Refusing to serve state-changing interactions.");
    process.exit(1);
    return;
  }
  questSystem.startScheduler();

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
      if (message.author.id !== ownerId) return message.reply("❌ Only the bot owner can use this command!");
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
      state.fightCooldowns.set(message.author.id, Date.now()+30000);
      state.fightCooldowns.set(opponentId, Date.now()+30000);
      const fightMsg = state.fightMessages.get(fightId);
      if (fightMsg) await fightMsg.edit({ content:"💀 Fight ended by divine intervention.", components:[] }).catch(() => {});
      state.activeFights.delete(fightId);
      state.activeRequests.delete(message.author.id);
      state.activeRequests.delete(opponentId);
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
    } else if (interaction.isButton()) {
      const questHandled = await questSystem.handleButton(interaction);
      if (!questHandled) await handleButton(interaction);
    } else if (interaction.isStringSelectMenu()) await handleSelectMenu(interaction);
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
