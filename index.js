const {
  Client, GatewayIntentBits, REST, Routes, AuditLogEvent,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags,
} = require("discord.js");
const express = require("express");

const database = require("./database.js"); // MongoDB
const state    = require("./state.js");
const { setState: setHelperState } = require("./helpers.js");
const { setState: setFightState }   = require("./fights.js");
const { setState: setCommandState, setClient, setRegisteredCommandIds, getCurrentDeveloperAlert, handleCommand, handleAutocomplete, handleButton, handleSelectMenu, maybePromptForDeveloperAlert, commands } = require("./commands.js");
const questSystem = require("./quest-system.js");
const chaosSystem = require("./chaos.js");
const leaderboardBadgeSystem = require("./leaderboard-badges.js");
const achievementSystem = require("./achievements.js");

// ==================== CONSTANTS ====================
const ownerId     = "926063716057894953";
const secondGodId = "1445387368830992455";
const TOKEN = (process.env.TOKEN || process.env.DISCORD_TOKEN || "").trim();

const SUPPORT_SERVER_INVITE = "https://discord.gg/TKBYpjqnPC";
// Bump only when intentionally queuing a one-time startup alert for a new release event.
const DEVELOPER_ALERT_STARTUP_CYCLE = "loz-6.2-code-alert-2026-10-17-v2";

function buildAccessNoticePayload({ unavailable=false, ephemeral=false }={}) {
  const card=new ContainerBuilder().setAccentColor(unavailable ? 0xe0a020 : 0xdc2626);
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    unavailable ? "## ⚠️ LOZ Access Check Unavailable" : "## ⛔ Banned from LOZ"
  ));
  card.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    unavailable
      ? "LOZ cannot verify your access right now. Please try again shortly."
      : "You're banned from using LOZ.\n\nJoin the [LOZ Support Server]("+SUPPORT_SERVER_INVITE+") and submit an appeal.\n\nThis notice will disappear in 7 seconds."
  ));
  return {
    components:[card],
    flags:MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
    allowedMentions:{parse:[]},
  };
}

function scheduleAccessNoticeDeletion(callback) {
  const timer=setTimeout(callback,7000);
  if (typeof timer.unref==="function") timer.unref();
}

async function denyBannedInteraction(interaction, unavailable=false) {
  if (interaction.isAutocomplete()) {
    await interaction.respond([]).catch(()=>{});
    return;
  }
  try {
    await interaction.reply(buildAccessNoticePayload({unavailable,ephemeral:true}));
    scheduleAccessNoticeDeletion(()=>interaction.deleteReply().catch(()=>{}));
  } catch(error) {
    if (error?.code!==10062 && !error?.message?.includes("Unknown interaction")) {
      console.warn("[LOZ Access Bans] Could not show access notice:", error?.message||error);
    }
  }
}

async function denyBannedMessage(message, unavailable=false) {
  try {
    const notice=await message.reply(buildAccessNoticePayload({unavailable,ephemeral:false}));
    scheduleAccessNoticeDeletion(()=>notice.delete().catch(()=>{}));
  } catch(error) {
    console.warn("[LOZ Access Bans] Could not show message access notice:", error?.message||error);
  }
}

function isAuthorizedLozOwner(userId) {
  return userId===ownerId || userId===secondGodId;
}

// Attach owner IDs to state so helpers/commands can read them
state.ownerId     = ownerId;
state.secondGodId = secondGodId;
chaosSystem.setState(state);

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
    // Top.gg v1 uses id for its own user/project ID and platform_id for the
    // linked Discord snowflake. Prefer platform_id so rewards target Discord users.
    return value.platform_id ?? value.platformId ?? value.discordId ?? value.discord_id
      ?? value.userId ?? value.id ?? "";
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
  const botKeys = ["bot", "botId", "receiverId", "projectId", "entityId", "project"];
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

  // Modern v1 vote.create events have a nested user/project shape. For these,
  // only use platform_id (the Discord snowflake), never Top.gg's own .id.
  if (typeValues.includes("vote.create")) {
    const eventData = objects.find(item =>
      item.user && typeof item.user === "object"
      && item.project && typeof item.project === "object"
    );
    return {
      user:String(eventData?.user?.platform_id ?? ""),
      bot:String(eventData?.project?.platform_id ?? ""),
      type:"upvote",
      isWeekend:objects.some(item => item.isWeekend === true),
    };
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

const blacklistEnforcementInProgress = new Set();

async function findRecentGuildJoinExecutor(guild) {
  try {
    const auditLogs=await guild.fetchAuditLogs({type:AuditLogEvent.BotAdd,limit:10});
    const now=Date.now();
    const entry=auditLogs.entries.find(item =>
      String(item.target?.id||"")===String(client.user?.id||"")
      && now-Number(item.createdTimestamp||0)>=0
      && now-Number(item.createdTimestamp||0)<=5*60*1000
      && item.executor?.id
    );
    return entry?.executor || null;
  } catch(error) {
    if (Number(error?.code)===50013 || Number(error?.status)===403) {
      console.warn("[Server Blacklist] Missing View Audit Log permission in server "+String(guild.id)+"; the inviter cannot be identified. Grant LOZ View Audit Log permission to DM the actual inviter.");
    } else {
      console.warn("[Server Blacklist] Could not identify who added LOZ in server "+String(guild.id)+": "+String(error?.message||error));
    }
    return null;
  }
}

function buildBlacklistNotice(guild, {inviterKnown=false, ownerFallback=false}={}) {
  const safeName=String(guild.name||"this server").replace(/[\\*_~|>]/g,"").slice(0,100)||"this server";
  const card=new ContainerBuilder().setAccentColor(0xdc2626);
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent("## ⛔ LOZ Has Left This Server"));
  card.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  let body;
  if (inviterKnown) {
    body="You added LOZ to **"+safeName+"**, but this server is on LOZ's server blacklist. LOZ has automatically left and will leave again if someone adds it while the server remains blacklisted.";
  } else {
    body="LOZ was added to **"+safeName+"**, but this server is on LOZ's server blacklist. LOZ has automatically left. "+(ownerFallback ? "We could not reliably identify who added LOZ, so this notice is being sent to the server owner." : "This server will remain blocked until the LOZ owner removes it from the blacklist.");
  }
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(body+"\n\n**Server ID:** "+String(guild.id)));
  return {components:[card],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}};
}

async function enforceBlacklistedGuild(guild, {joinEvent=false}={}) {
  if (!guild?.id || blacklistEnforcementInProgress.has(String(guild.id))) return {ok:false,reason:"already_processing"};
  blacklistEnforcementInProgress.add(String(guild.id));
  try {
    const lookup=await database.getBlacklistedGuild(guild.id);
    if (!lookup?.ok) {
      console.error("[Server Blacklist] Could not verify blacklist state for server "+String(guild.id)+". No automatic leave was attempted without a confirmed blacklist record.");
      return {ok:false,reason:"database_unavailable"};
    }
    if (!lookup.entry) return {ok:true,blacklisted:false};

    let inviter=null;
    let inviterUser=null;
    if (joinEvent) {
      inviter=await findRecentGuildJoinExecutor(guild);
      if (inviter && !inviter.bot) inviterUser=await client.users.fetch(inviter.id).catch(()=>null);
    }

    // Notify before leaving so the person who added LOZ gets the message while
    // the join event is still being handled. DM delivery is best-effort; never
    // remain in a blacklisted server just because the recipient blocks DMs.
    let dmSent=false;
    if (inviterUser) {
      try {
        await inviterUser.send(buildBlacklistNotice(guild,{inviterKnown:true}));
        dmSent=true;
        console.info("[Server Blacklist] DM sent to inviter "+String(inviterUser.id)+" for server "+String(guild.id)+".");
      } catch(error) {
        console.warn("[Server Blacklist] Could not DM the user who added LOZ to "+String(guild.id)+": "+String(error?.message||error));
      }
    } else if (joinEvent) {
      console.warn("[Server Blacklist] Inviter could not be identified for server "+String(guild.id)+". The bot needs View Audit Log permission to identify the user who added it.");
    }

    if (!dmSent && guild.ownerId && String(guild.ownerId)!==String(inviter?.id||"")) {
      try {
        const serverOwner=await client.users.fetch(guild.ownerId);
        await serverOwner.send(buildBlacklistNotice(guild,{inviterKnown:false,ownerFallback:true}));
        dmSent=true;
        console.info("[Server Blacklist] DM sent to server owner "+String(guild.ownerId)+" for server "+String(guild.id)+".");
      } catch(error) {
        console.warn("[Server Blacklist] Could not DM the owner of blacklisted server "+String(guild.id)+": "+String(error?.message||error));
      }
    }

    try {
      await guild.leave();
      console.warn("[Server Blacklist] LOZ left blacklisted server "+String(guild.id)+" ("+String(guild.name||"Unknown server")+").");
    } catch(error) {
      console.error("[Server Blacklist] Could not leave blacklisted server "+String(guild.id)+":",error?.stack||error);
      return {ok:false,reason:"leave_failed",dmSent};
    }

    if (!dmSent) console.warn("[Server Blacklist] LOZ left server "+String(guild.id)+" but no notification DM could be delivered.");
    return {ok:true,blacklisted:true,left:true,dmSent};
  } finally {
    blacklistEnforcementInProgress.delete(String(guild.id));
  }
}

async function enforceExistingBlacklistedGuilds() {
  const result=await database.listBlacklistedGuilds();
  if (!result?.ok) {
    console.error("[Server Blacklist] Could not check existing server memberships at startup.");
    return;
  }
  const ids=new Set((result.entries||[]).map(entry=>String(entry.guildId)));
  for (const guild of [...client.guilds.cache.values()]) {
    if (ids.has(String(guild.id))) await enforceBlacklistedGuild(guild,{joinEvent:false});
  }
}

client.on("guildCreate", guild => {
  updatePresence();
  void enforceBlacklistedGuild(guild,{joinEvent:true}).catch(error => {
    console.error("[Server Blacklist] Join enforcement failed:",error?.stack||error);
  });
});
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

    // Keep LOZ installed to servers, while also allowing its commands in a DM
    // with the LOZ bot account. User-installed/private-channel contexts stay disabled.
    // Channel administration must remain server-only because it changes a guild channel.
    const guildOnlyCommands = new Set(["disable-all", "enable-all"]);
    const globalCommandPayload = commands.map(command => ({
      ...(typeof command.toJSON === "function" ? command.toJSON() : command),
      integration_types: [0], // GUILD_INSTALL
      contexts: guildOnlyCommands.has(command.name) ? [0] : [0, 1], // GUILD + BOT_DM
    }));
    const registered = await rest.put(Routes.applicationCommands(client.user.id), { body: globalCommandPayload });
    setRegisteredCommandIds(registered);
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

  // Create UPDATE6.2 only once. A restart must never extend its original 24-hour expiry.
  const defaultCode = await database.ensureDefaultRedeemCode({
    code:"UPDATE6.2",
    rewardType:"rolls",
    amount:3,
    expiresMinutes:1440,
    maxClaims:1000,
    createdBy:ownerId,
  });
  if (defaultCode?.ok) {
    console.log("[Codes] UPDATE6.2 " + (defaultCode.created ? "created" : "already exists") + ".");
  } else {
    console.error("[Codes] Could not verify the UPDATE6.2 reward code.");
  }

  // Queue the current release alert for known players; it no longer contains the retired species-recovery notice.
  const startupAlert = getCurrentDeveloperAlert();
  const startupQueue = await database.queueDeveloperAlertPrompts(
    [...state.userSpecies.keys()],
    startupAlert.id,
    DEVELOPER_ALERT_STARTUP_CYCLE,
  );
  if (startupQueue?.ok) {
    console.log("[Developer Alert] Queued startup alert for " + startupQueue.queued
      + " players; " + startupQueue.alreadyQueued + " were already queued for this cycle.");
  } else {
    console.warn("[Developer Alert] Startup queue could not be fully saved; regular per-command alerts remain enabled.");
  }

  // Only allow state-changing interactions after persistent data is fully loaded.
  databaseReady = true;
  await registerCommands();

  // Sweep existing memberships after normal startup so blacklist lookup never delays readiness.
  void enforceExistingBlacklistedGuilds().catch(error => {
    console.error("[Server Blacklist] Startup membership check failed:",error?.stack||error);
  });

  console.log("✅ Database loaded");
  updatePresence();
  leaderboardBadgeSystem.startScheduler(client, state).catch(error => {
    console.error("[Leaderboard Badges] Could not start rank tracking:", error);
  });
  achievementSystem.startLeaderboardScheduler(client,state).catch(error => {
    console.error("[Glory] Could not start the Glory leaderboard:",error);
  });
  console.log(`🎉 Bot ready with ${state.userSpecies.size} users!`);
});

// ==================== MESSAGE CREATE (mention help only; no Message Content intent) ====================
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !message.mentions.users.has(client.user.id)) return;

    if (!isAuthorizedLozOwner(message.author.id)) {
      const access = await database.getActiveAccessBan(message.author.id);
      if (!access?.ok) {
        await denyBannedMessage(message, true);
        return;
      }
      if (access.ban) {
        await denyBannedMessage(message, false);
        return;
      }
    }

    const mentionCard = new ContainerBuilder().setAccentColor(0x0891b2);
    mentionCard.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "## Welcome to LOZ\nLegends of the Rift is a turn-based RPG where you roll species, complete quests, and battle players or bots."
    ));
    mentionCard.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    mentionCard.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "### Get Started\nRun **`/guide`** to learn the basics and earn your one-time tutorial roll."
    ));
    mentionCard.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    mentionCard.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "### Need More?\n[Open the full website guide](https://lozbot.vercel.app/)\nRun **`/help`** to browse all commands."
    ));
    const mentionReply = await message.reply({
      components: [mentionCard],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
    const mentionTimer = setTimeout(() => mentionReply.delete().catch(() => {}), 10_000);
    if (typeof mentionTimer.unref === "function") mentionTimer.unref();
  } catch (e) {
    console.error("messageCreate error:", e);
  }
});

// ==================== INTERACTION CREATE ====================
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.user && !isAuthorizedLozOwner(interaction.user.id)) {
        const access = await database.getActiveAccessBan(interaction.user.id);
        if (!access?.ok || access.ban) {
          await interaction.respond([]).catch(()=>{});
          return;
        }
      }
      await handleAutocomplete(interaction);
      return;
    }

    // Never let startup-time commands write fallback/default state over saved records.
    if (!databaseReady && (interaction.isCommand() || interaction.isButton() || interaction.isStringSelectMenu())) {
      return interaction.reply({
        content: "LOZ is loading saved player data after a restart. Please try again in a few seconds.",
        flags: 64,
      }).catch(() => {});
    }

    if ((interaction.isCommand() || interaction.isButton() || interaction.isStringSelectMenu())
      && interaction.user && !isAuthorizedLozOwner(interaction.user.id)) {
      const access = await database.getActiveAccessBan(interaction.user.id);
      if (!access?.ok) {
        await denyBannedInteraction(interaction, true);
        return;
      }
      if (access.ban) {
        await denyBannedInteraction(interaction, false);
        return;
      }
    }

    if (interaction.isButton() && String(interaction.customId || "").startsWith("chaosreact_")) {
      if (await chaosSystem.handleReactionButton(interaction)) return;
    }

    // Keep the channel recovery commands available after a channel has been disabled.
    const channelToggleCommand = interaction.isCommand()
      && ["disable-all", "enable-all"].includes(interaction.commandName);
    if (state.disabledChannels.has(interaction.channelId) && !channelToggleCommand) {
      if (interaction.isCommand() || interaction.isButton() || interaction.isStringSelectMenu()) {
        return interaction.reply({ content: "🔒 LOZ commands are disabled in this channel.", ephemeral: true }).catch(()=>{});
      }
    }
    if (interaction.isCommand()) {
      await handleCommand(interaction);
      // Show the current developer-alert reminder privately, at most once per day until viewed.
      await maybePromptForDeveloperAlert(interaction);
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
