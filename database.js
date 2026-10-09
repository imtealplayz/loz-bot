const mongoose = require("mongoose");

// ==================== CONNECT ====================
mongoose.set("bufferCommands", false);

let connected = false;
let connectionPromise = null;
let authenticationFailed = false;

async function connect() {
  if (connected && mongoose.connection.readyState === 1) return true;
  if (authenticationFailed) return false;
  if (connectionPromise) return connectionPromise;

  const uri = (process.env.MONGODB_URI || "").trim();
  if (!uri) {
    console.error("❌ MongoDB connection failed: MONGODB_URI is missing.");
    authenticationFailed = true;
    return false;
  }

  connectionPromise = mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 })
    .then(() => {
      connected = true;
      console.log("✅ MongoDB connected!");
      return true;
    })
    .catch(e => {
      connected = false;
      console.error("❌ MongoDB connection failed:", e.message);
      if (/bad auth|authentication failed/i.test(e.message)) authenticationFailed = true;
      return false;
    })
    .finally(() => {
      connectionPromise = null;
    });

  return connectionPromise;
}

// Connection is established on first database operation.

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema({
  userId:          { type:String, required:true, unique:true },
  species:         { type:Object, default:null },
  originalSpecies: { type:Object, default:null },
  questSpecies:    { type:Object, default:{} },
  rolls:           { type:Number, default:0 },
  requestsEnabled: { type:Boolean, default:true },
  lastSwitch:      { type:Number, default:0 },
  awakening:       { type:Object, default:{} },
  badges:          { type:Array,  default:[] },
}, { minimize:false });

const leaderboardSchema = new mongoose.Schema({
  userId: { type:String, required:true, unique:true },
  wins:   { type:Number, default:0 },
});

const fightStatsSchema = new mongoose.Schema({
  userId:  { type:String, required:true, unique:true },
  wins:    { type:Number, default:0 },
  losses:  { type:Number, default:0 },
  streak:  { type:Number, default:0 },
  history: { type:Array,  default:[] },
});

const botStatsSchema = new mongoose.Schema({
  userId:     { type:String, required:true, unique:true },
  easy:       { type:Object, default:{ wins:0, losses:0 } },
  medium:     { type:Object, default:{ wins:0, losses:0 } },
  hard:       { type:Object, default:{ wins:0, losses:0 } },
  impossible: { type:Object, default:{ wins:0, losses:0 } },
  brutal:     { type:Object, default:{ wins:0, losses:0 } },
}, { minimize:false });

const dailySchema = new mongoose.Schema({
  userId:    { type:String, required:true, unique:true },
  lastClaim: { type:Number, default:0 },
  streak:    { type:Number, default:0 },
});

const questSchema = new mongoose.Schema({
  userId:    { type:String, required:true },
  questName: { type:String, required:true },
  data:      { type:Object, default:{} },
}, { minimize:false });
questSchema.index({ userId:1, questName:1 }, { unique:true });

const duelChannelSchema = new mongoose.Schema({
  guildId:   { type:String, required:true, unique:true },
  channelId: { type:String, required:true },
});

const fightLeaderboardSchema = new mongoose.Schema({
  userId: { type:String, required:true, unique:true },
  wins:   { type:Number, default:0 },
});

// ==================== MODELS ====================
const User             = mongoose.model("User",             userSchema);
const Leaderboard      = mongoose.model("Leaderboard",      leaderboardSchema);
const FightStats       = mongoose.model("FightStats",       fightStatsSchema);
const BotStats         = mongoose.model("BotStats",         botStatsSchema);
const Daily            = mongoose.model("Daily",            dailySchema);
const Quest            = mongoose.model("Quest",            questSchema);
const DuelChannel      = mongoose.model("DuelChannel",      duelChannelSchema);
const FightLeaderboard = mongoose.model("FightLeaderboard", fightLeaderboardSchema);

// ==================== HELPERS ====================
async function upsert(Model, filter, data) {
  try {
    if (!await connect()) return false;
    await Model.findOneAndUpdate(filter, { $set:data }, { upsert:true, new:true });
    return true;
  } catch(e) {
    console.error("❌ DB upsert error (" + Model.modelName + "):", e.message);
    return false;
  }
}

// ==================== SAVE FUNCTIONS ====================
async function saveUserSpecies(userId, data) {
  return await upsert(User, { userId }, { userId, ...data });
}

// Update only the intended fields so a partial/stale in-memory user object
// cannot overwrite unrelated persisted player data.
async function saveUserRolls(userId, rolls) {
  return await upsert(User, { userId }, { userId, rolls });
}

async function saveUserSpeciesFields(userId, species, originalSpecies) {
  return await upsert(User, { userId }, { userId, species, originalSpecies });
}

async function saveLeaderboard(userId, data) {
  await upsert(Leaderboard, { userId }, { userId, wins:data.wins||0 });
}

async function saveFightLeaderboard(userId, data) {
  await upsert(FightLeaderboard, { userId }, { userId, wins:data.wins||0 });
}

async function saveFightStats(userId, data) {
  const toSave = { ...data };
  if (toSave.history && toSave.history.length > 20) toSave.history = toSave.history.slice(0,20);
  await upsert(FightStats, { userId }, { userId, ...toSave });
}

async function saveBotStats(userId, data) {
  await upsert(BotStats, { userId }, { userId, ...data });
}

async function saveDailyClaim(userId, data) {
  await upsert(Daily, { userId }, { userId, ...data });
}

async function saveQuestProgress(userId, questName, data) {
  if (!data) {
    await Quest.deleteOne({ userId, questName }).catch(()=>{});
    return;
  }
  await upsert(Quest, { userId, questName }, { userId, questName, data });
}

async function saveDuelChannel(guildId, channelId) {
  await upsert(DuelChannel, { guildId }, { guildId, channelId });
}

// ==================== LOAD FUNCTIONS ====================
async function loadAllData(userSpecies, leaderboard, fightLeaderboard, fightStats, dailyClaims, botStats) {
  try {
    if (!await connect()) {
      console.error("⚠️ Skipping MongoDB data load because the database is unavailable.");
      return false;
    }
    console.log(`📂 Loading data from MongoDB — host=${mongoose.connection.host || "unknown"}, database=${mongoose.connection.name || "unknown"}, usersCollection=${User.collection.name}`);

    const users = await User.find({});
    let withSpecies = 0, withRolls = 0;
    for (const u of users) {
      const obj = u.toObject();
      const uid = obj.userId;
      const d = {
        species:         obj.species         || null,
        originalSpecies: obj.originalSpecies || null,
        questSpecies:    obj.questSpecies    || {},
        rolls:           obj.rolls           || 0,
        requestsEnabled: obj.requestsEnabled !== false,
        lastSwitch:      obj.lastSwitch      || 0,
        awakening:       obj.awakening       || {},
        badges:          obj.badges          || [],
      };
      userSpecies.set(uid, d);
      if (d.species && d.species.name) withSpecies++;
      if (d.rolls > 0) withRolls++;
    }
    console.log(`✅ Loaded ${users.length} users — ${withSpecies} have species, ${withRolls} have rolls`);

    const lb = await Leaderboard.find({});
    for (const l of lb) leaderboard.set(l.userId, { wins:l.wins });
    console.log(`✅ Loaded ${lb.length} leaderboard entries`);

    const flb = await FightLeaderboard.find({});
    for (const f of flb) fightLeaderboard.set(f.userId, { wins:f.wins });
    console.log(`✅ Loaded ${flb.length} fight leaderboard entries`);

    const fs = await FightStats.find({});
    for (const f of fs) {
      const d = f.toObject(); delete d._id; delete d.__v; delete d.userId;
      fightStats.set(f.userId, d);
    }
    console.log(`✅ Loaded ${fs.length} fight stats`);

    const dc = await Daily.find({});
    for (const d of dc) dailyClaims.set(d.userId, { lastClaim:d.lastClaim, streak:d.streak });
    console.log(`✅ Loaded ${dc.length} daily claims`);

    const bs = await BotStats.find({});
    for (const b of bs) {
      const d = b.toObject(); delete d._id; delete d.__v; delete d.userId;
      botStats.set(b.userId, d);
    }
    console.log(`✅ Loaded ${bs.length} bot stat entries`);

    // Protect against silently starting from an empty/wrong users collection.
    // Fight history is durable data; if it exists but every player species is
    // missing, keep LOZ offline rather than accepting mutations on suspect data.
    const hasRelatedHistory = lb.length > 0 || flb.length > 0 || fs.length > 0 || bs.length > 0;
    if (hasRelatedHistory && (users.length === 0 || withSpecies === 0)) {
      console.error(`🚨 SAFETY STOP: MongoDB host=${mongoose.connection.host || "unknown"}, database=${mongoose.connection.name || "unknown"}, collection=${User.collection.name}; users=${users.length}, usersWithSpecies=${withSpecies}, usersWithRolls=${withRolls}, fightLeaderboard=${flb.length}, fightStats=${fs.length}. Persistent fight data exists but user species data appears missing. Refusing startup to avoid overwriting from a suspicious database state.`);
      return false;
    }

    return true;
  } catch(e) {
    console.error("❌ loadAllData error:", e.message);
    return false;
  }
}

async function loadAllQuestProgress(questProgress, userSpecies) {
  try {
    if (!await connect()) return false;
    const quests = await Quest.find({});
    for (const q of quests) {
      const existing = questProgress.get(q.userId) || {};
      existing[q.questName] = q.data;
      questProgress.set(q.userId, existing);
    }
    console.log(`✅ Loaded quest progress for ${questProgress.size} users`);
    // Sync completed reaper quest back to userSpecies so /switch works
    if (userSpecies) {
      for (const [uid, qp] of questProgress.entries()) {
        const ud = userSpecies.get(uid);
        if (!ud) continue;
        if (!ud.questSpecies) ud.questSpecies = {};
        if (qp.reaper?.completed && qp.reaper?.claimed) {
          if (!ud.questSpecies.reaper?.unlocked) {
            ud.questSpecies.reaper = { unlocked:true, equipped:false };
            userSpecies.set(uid, ud);
          }
        }
      }
    }
    return true;
  } catch(e) {
    console.error("❌ loadAllQuestProgress error:", e.message);
    return false;
  }
}

async function loadDuelChannel(guildId) {
  try {
    if (!await connect()) return null;
    const doc = await DuelChannel.findOne({ guildId });
    return doc ? doc.channelId : null;
  } catch(e) {
    console.error("loadDuelChannel error:", e.message);
    return null;
  }
}

// ==================== UTILITY ====================
// Used by /god debug-db to show collection counts
async function listAllKeys(debugUserId) {
  try {
    if (!await connect()) return { error: "MongoDB connection failed. Check Railway logs for the connection error." };

    // Run independent reads concurrently so the diagnostic can reply quickly.
    const [
      debugUser, users, usersWithSpecies, usersWithRolls,
      leaderboard, fightLeaderboard, fightStats, botStats,
      dailyClaims, quests, duelChannels,
    ] = await Promise.all([
      debugUserId
        ? User.findOne({ userId: debugUserId }).select({ userId:1, species:1, originalSpecies:1, rolls:1 }).lean()
        : Promise.resolve(null),
      User.countDocuments(),
      User.countDocuments({ "species.name": { $exists:true, $ne:null } }),
      User.countDocuments({ rolls: { $gt:0 } }),
      Leaderboard.countDocuments(),
      FightLeaderboard.countDocuments(),
      FightStats.countDocuments(),
      BotStats.countDocuments(),
      Daily.countDocuments(),
      Quest.countDocuments(),
      DuelChannel.countDocuments(),
    ]);

    return {
      databaseName: mongoose.connection.name || "unknown",
      databaseHost: mongoose.connection.host || "unknown",
      usersCollection: User.collection.name,
      debugUser: debugUser ? {
        found: true,
        species: debugUser.species?.name || null,
        originalSpecies: debugUser.originalSpecies?.name || null,
        rolls: Number(debugUser.rolls) || 0,
      } : (debugUserId ? { found:false } : null),
      users, usersWithSpecies, usersWithRolls,
      leaderboard, fightLeaderboard, fightStats, botStats,
      dailyClaims, quests, duelChannels,
    };
  } catch(e) {
    console.error("listAllKeys error:", e);
    return { error: e?.message || String(e) };
  }
}

async function deleteUser(userId) {
  if (!await connect()) return false;
  await User.deleteOne({ userId });
  await Leaderboard.deleteOne({ userId });
  await FightLeaderboard.deleteOne({ userId });
  await FightStats.deleteOne({ userId });
  await BotStats.deleteOne({ userId });
  await Daily.deleteOne({ userId });
  await Quest.deleteMany({ userId });
  console.log(`🗑️ Deleted all data for user ${userId}`);
  return true;
}

// ==================== EXPORTS ====================
module.exports = {
  saveUserSpecies, saveUserRolls, saveUserSpeciesFields,
  saveLeaderboard, saveFightLeaderboard,
  saveFightStats, saveBotStats, saveDailyClaim,
  saveQuestProgress, saveDuelChannel,
  loadAllData, loadAllQuestProgress, loadDuelChannel,
  listAllKeys, deleteUser,
};
