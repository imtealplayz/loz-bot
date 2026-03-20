const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

// ==================== CONNECT ====================
let connected = false;
let connectionPromise = null;

async function connect() {
  if (connected) return;
  if (connectionPromise) return connectionPromise;
  connectionPromise = mongoose.connect(process.env.MONGODB_URI)
    .then(() => { connected = true; console.log("✅ MongoDB connected!"); })
    .catch(e => { console.error("❌ MongoDB connection failed:", e.message); connectionPromise = null; });
  return connectionPromise;
}

// Always call this before any DB operation
async function ensureConnected() {
  if (connected) return;
  await connect();
  // Extra safety: wait until mongoose is actually ready
  let attempts = 0;
  while (mongoose.connection.readyState !== 1 && attempts < 50) {
    await new Promise(r => setTimeout(r, 200));
    attempts++;
  }
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB failed to connect after 10 seconds");
  }
}

connect();

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
    await Model.findOneAndUpdate(filter, { $set:data }, { upsert:true, new:true });
  } catch(e) {
    console.error(`❌ DB upsert error (${Model.modelName}):`, e.message);
  }
}

// ==================== SAVE FUNCTIONS ====================
async function saveUserSpecies(userId, data) {
  await upsert(User, { userId }, { userId, ...data });
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
    await ensureConnected();
    console.log("📂 Loading data from MongoDB...");

    const users = await User.find({});
    let loadedWithSpecies = 0, loadedWithRolls = 0;
    for (const u of users) {
      const obj = u.toObject();
      const uid = obj.userId;
      // Build clean data object explicitly
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
      if (d.species && d.species.name) loadedWithSpecies++;
      if (d.rolls > 0) loadedWithRolls++;
    }
    console.log(`✅ Loaded ${users.length} users — ${loadedWithSpecies} have species, ${loadedWithRolls} have rolls`);
    // Verify first user with species loaded correctly
    const sampleEntry = [...userSpecies.entries()].find(([,v]) => v.species && v.species.name);
    if (sampleEntry) {
      console.log(`🔍 Map check: id=${sampleEntry[0]} species=${sampleEntry[1].species.name} rolls=${sampleEntry[1].rolls}`);
    }


    const lb = await Leaderboard.find({});
    for (const l of lb) leaderboard.set(l.userId, { wins:l.wins });
    console.log(`✅ Loaded ${lb.length} leaderboard entries`);

    const flb = await FightLeaderboard.find({});
    for (const f of flb) fightLeaderboard.set(f.userId, { wins:f.wins });
    console.log(`✅ Loaded ${flb.length} fight leaderboard entries`);

    const fs = await FightStats.find({});
    for (const f of fs) {
      const obj = f.toObject();
      fightStats.set(obj.userId, { wins:obj.wins||0, losses:obj.losses||0, streak:obj.streak||0, history:obj.history||[] });
    }
    console.log(`✅ Loaded ${fs.length} fight stats`);

    const dc = await Daily.find({});
    for (const d of dc) dailyClaims.set(d.userId, { lastClaim:d.lastClaim, streak:d.streak });
    console.log(`✅ Loaded ${dc.length} daily claims`);

    const bs = await BotStats.find({});
    for (const b of bs) {
      const obj = b.toObject();
      const uid = obj.userId;
      delete obj._id; delete obj.__v; delete obj.userId;
      botStats.set(uid, obj);
    }
    console.log(`✅ Loaded ${bs.length} bot stat entries`);

    return true;
  } catch(e) {
    console.error("❌ loadAllData error:", e.message);
    return false;
  }
}

async function loadAllQuestProgress(questProgress, userSpecies) {
  try {
    const quests = await Quest.find({});
    for (const q of quests) {
      const existing = questProgress.get(q.userId) || {};
      existing[q.questName] = q.data;
      questProgress.set(q.userId, existing);
    }
    console.log(`✅ Loaded quest progress for ${questProgress.size} users`);

    // Sync completed quests back to userSpecies so switch works
    if (userSpecies) {
      for (const [uid, qp] of questProgress.entries()) {
        const ud = userSpecies.get(uid);
        if (!ud) continue;
        if (!ud.questSpecies) ud.questSpecies = {};
        // If reaper quest is completed and claimed, mark as unlocked
        if (qp.reaper?.completed && qp.reaper?.claimed) {
          ud.questSpecies.reaper = { unlocked: true, equipped: false };
        }
        userSpecies.set(uid, ud);
      }
      console.log("✅ Quest species synced to user data");
    }
    return true;
  } catch(e) {
    console.error("❌ loadAllQuestProgress error:", e.message);
    return false;
  }
}

async function loadDuelChannel(guildId) {
  try {
    const doc = await DuelChannel.findOne({ guildId });
    return doc ? doc.channelId : null;
  } catch(e) {
    console.error("loadDuelChannel error:", e.message);
    return null;
  }
}

// ==================== UTILITY ====================
// Used by /god debug-db to show collection counts
async function listAllKeys() {
  try {
    return {
      users:            await User.countDocuments(),
      leaderboard:      await Leaderboard.countDocuments(),
      fightLeaderboard: await FightLeaderboard.countDocuments(),
      fightStats:       await FightStats.countDocuments(),
      botStats:         await BotStats.countDocuments(),
      dailyClaims:      await Daily.countDocuments(),
      quests:           await Quest.countDocuments(),
      duelChannels:     await DuelChannel.countDocuments(),
    };
  } catch(e) {
    console.error("listAllKeys error:", e.message);
    return {};
  }
}

async function deleteUser(userId) {
  await User.deleteOne({ userId });
  await Leaderboard.deleteOne({ userId });
  await FightLeaderboard.deleteOne({ userId });
  await FightStats.deleteOne({ userId });
  await BotStats.deleteOne({ userId });
  await Daily.deleteOne({ userId });
  await Quest.deleteMany({ userId });
  console.log(`🗑️ Deleted all data for user ${userId}`);
}

// ==================== BACKUP SYSTEM ====================
const BACKUP_DIR = path.join(__dirname, "backups");

async function createBackup(userSpecies, fightStats, dailyClaims, botStats, questProgress) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = {
      timestamp,
      users: {},
      fightStats: {},
      dailyClaims: {},
      botStats: {},
      questProgress: {},
    };
    for (const [id, d] of userSpecies.entries()) backup.users[id] = d;
    for (const [id, d] of fightStats.entries()) backup.fightStats[id] = d;
    for (const [id, d] of dailyClaims.entries()) backup.dailyClaims[id] = d;
    for (const [id, d] of botStats.entries()) backup.botStats[id] = d;
    for (const [id, d] of questProgress.entries()) backup.questProgress[id] = d;

    const filename = path.join(BACKUP_DIR, `backup-${timestamp}.json`);
    fs.writeFileSync(filename, JSON.stringify(backup, null, 2));

    // Keep only last 5 backups
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith("backup-"))
      .sort();
    while (files.length > 5) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
    console.log(`✅ Backup saved: ${filename}`);
    return filename;
  } catch(e) {
    console.error("❌ Backup failed:", e.message);
    return null;
  }
}

// ==================== EXPORTS ====================
module.exports = {
  ensureConnected,
  saveUserSpecies, saveLeaderboard, saveFightLeaderboard,
  saveFightStats, saveBotStats, saveDailyClaim,
  saveQuestProgress, saveDuelChannel,
  loadAllData, loadAllQuestProgress, loadDuelChannel,
  listAllKeys, deleteUser, createBackup,
};
