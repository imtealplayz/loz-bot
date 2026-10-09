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
  userId:          { type:String, required:true },
  // Legacy duplicate documents are retained for recovery but excluded from active player reads.
  archivedForRepair: { type:Boolean, default:false },
  duplicateOf:     { type:mongoose.Schema.Types.ObjectId, default:null },
  archivedAt:      { type:Date, default:null },
  species:         { type:Object, default:null },
  originalSpecies: { type:Object, default:null },
  questSpecies:    { type:Object, default:{} },
  rolls:           { type:Number, default:0 },
  speciesTokens:   { type:Number, default:0 },
  requestsEnabled: { type:Boolean, default:true },
  lastSwitch:      { type:Number, default:0 },
  awakening:       { type:Object, default:{} },
  badges:          { type:Array,  default:[] },
}, { minimize:false });

// Explicit opt-in for major-update DMs; separate collection avoids modifying player records.
const notificationPreferenceSchema = new mongoose.Schema({
  userId:        { type:String, required:true, unique:true },
  broadcastOptIn:{ type:Boolean, default:false },
  updatedAt:     { type:Date, default:Date.now },
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
const NotificationPreference = mongoose.model("NotificationPreference", notificationPreferenceSchema);
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

// User records may contain legacy duplicate userId documents. Update all matching
// copies so a stale duplicate cannot bring back old species/roll values next boot.
let userRepairPromise = null;

async function upsertUser(userId, data) {
  try {
    // Keep writes queued while the owner-triggered archive-and-dedupe operation runs.
    if (userRepairPromise) await userRepairPromise;
    if (!await connect()) return false;
    await User.updateMany(
      { userId, archivedForRepair: { $ne:true } },
      { $set: { userId, archivedForRepair:false, ...data } },
      { upsert:true }
    );
    return true;
  } catch(e) {
    console.error("❌ DB upsert error (User):", e.message);
    return false;
  }
}

// ==================== SAVE FUNCTIONS ====================
async function saveUserSpecies(userId, data) {
  return await upsertUser(userId, data);
}

// Update only the intended fields so a partial/stale in-memory user object
// cannot overwrite unrelated persisted player data.
async function saveUserRolls(userId, rolls) {
  return await upsertUser(userId, { rolls });
}

async function addSpeciesTokens(userId, amount) {
  try {
    if (userRepairPromise) await userRepairPromise;
    if (!await connect()) return { ok:false, error:true };
    // Update every active copy so a later duplicate repair cannot discard a grant.
    await User.updateMany(
      { userId, archivedForRepair:{ $ne:true } },
      { $inc:{ speciesTokens:amount }, $set:{ userId, archivedForRepair:false } },
      { upsert:true }
    );
    const records = await User.find({ userId, archivedForRepair:{ $ne:true } })
      .select({ speciesTokens:1 }).lean();
    if (!records.length) return { ok:false, error:true };
    return { ok:true, speciesTokens:Math.max(0, ...records.map(record => Number(record.speciesTokens)||0)) };
  } catch(e) {
    console.error("❌ Species token grant error:", e.message);
    return { ok:false, error:true };
  }
}

async function redeemSpeciesToken(userId, species) {
  try {
    if (userRepairPromise) await userRepairPromise;
    if (!await connect()) return { ok:false, error:true };
    // Requiring the species to differ makes repeated confirmation clicks idempotent
    // for a single active player record, even when the user owns multiple tokens.
    const result = await User.updateMany(
      {
        userId,
        archivedForRepair:{ $ne:true },
        speciesTokens:{ $gt:0 },
        "species.name":{ $ne:species.name },
      },
      { $inc:{ speciesTokens:-1 }, $set:{ species, originalSpecies:species } }
    );
    if (!result.modifiedCount) {
      const current = await User.findOne({ userId, archivedForRepair:{ $ne:true } })
        .select({ species:1, speciesTokens:1 }).lean();
      if (!current || (Number(current.speciesTokens)||0) < 1) {
        return { ok:false, noTokens:true, speciesTokens:Number(current?.speciesTokens)||0 };
      }
      if (current.species?.name === species.name) {
        return { ok:false, sameSpecies:true, speciesTokens:Number(current.speciesTokens)||0 };
      }
      return { ok:false, error:true };
    }
    const records = await User.find({ userId, archivedForRepair:{ $ne:true } })
      .select({ speciesTokens:1 }).lean();
    return {
      ok:true,
      speciesTokens:Math.max(0, ...records.map(record => Number(record.speciesTokens)||0)),
    };
  } catch(e) {
    console.error("❌ Species token redemption error:", e.message);
    return { ok:false, error:true };
  }
}

async function saveUserSpeciesFields(userId, species, originalSpecies) {
  return await upsertUser(userId, { species, originalSpecies });
}

// Users receive major-update DMs only after explicitly opting in.
async function setBroadcastOptIn(userId, enabled) {
  try {
    if (!await connect()) return false;
    await NotificationPreference.findOneAndUpdate(
      { userId },
      { $set: { userId, broadcastOptIn:Boolean(enabled), updatedAt:new Date() } },
      { upsert:true, new:true, runValidators:true }
    );
    return true;
  } catch(e) {
    console.error("❌ Broadcast preference save error:", e.message);
    return false;
  }
}

async function getBroadcastOptIn(userId) {
  try {
    if (!await connect()) return null;
    const preference = await NotificationPreference.findOne({ userId }).select({ broadcastOptIn:1 }).lean();
    return Boolean(preference?.broadcastOptIn);
  } catch(e) {
    console.error("❌ Broadcast preference read error:", e.message);
    return null;
  }
}

async function getBroadcastSubscribers() {
  try {
    if (!await connect()) return null;
    const userIds = await NotificationPreference.distinct("userId", { broadcastOptIn:true });
    return userIds.filter(userId => typeof userId === "string" && /^\d{17,20}$/.test(userId));
  } catch(e) {
    console.error("❌ Broadcast subscriber lookup error:", e.message);
    return null;
  }
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

// Prefer the most complete player record when legacy duplicate userId documents exist.
// This only affects the in-memory startup cache; it never deletes or edits MongoDB records.
function playerRecordScore(obj) {
  if (!obj) return -1;
  return (obj.species?.name ? 1000 : 0)
    + (obj.originalSpecies?.name ? 400 : 0)
    + ((Number(obj.rolls) || 0) > 0 ? 100 : 0)
    + (Object.keys(obj.questSpecies || {}).length ? 20 : 0)
    + (Object.keys(obj.awakening || {}).length ? 10 : 0)
    + (Array.isArray(obj.badges) && obj.badges.length ? 5 : 0)
    + (obj.lastSwitch ? 1 : 0);
}

function chooseBestPlayerRecord(records) {
  return [...records].sort((a, b) => {
    const scoreDifference = playerRecordScore(b) - playerRecordScore(a);
    if (scoreDifference !== 0) return scoreDifference;
    // Deterministic tie-breaker: prefer the newest ObjectId timestamp.
    return String(b._id || "").localeCompare(String(a._id || ""));
  })[0] || null;
}

function isPlainPlayerObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId);
}

// Merge nested progress conservatively: keep any completed/unlocked flag, retain
// the highest numeric progress, and union arrays. All original documents are
// archived before a repaired canonical record is written or any copy is deleted.
function mergePlayerProgress(values) {
  const present = values.filter(value => value !== undefined && value !== null);
  if (!present.length) return {};
  if (present.every(Array.isArray)) {
    const out = [], seen = new Set();
    for (const arr of present) {
      for (const item of arr) {
        const key = JSON.stringify(item);
        if (!seen.has(key)) { seen.add(key); out.push(item); }
      }
    }
    return out;
  }
  if (present.every(value => typeof value === "number" && Number.isFinite(value))) {
    return Math.max(...present);
  }
  if (present.every(value => typeof value === "boolean")) {
    return present.some(Boolean);
  }
  if (present.every(isPlainPlayerObject)) {
    const keys = [...new Set(present.flatMap(value => Object.keys(value)))];
    const out = {};
    for (const key of keys) out[key] = mergePlayerProgress(present.map(value => value[key]));
    return out;
  }
  return present.find(value => value !== "" && value !== false) ?? present[0];
}

function mergeDuplicatePlayerRecords(records) {
  const base = chooseBestPlayerRecord(records);
  const ordered = [base, ...records.filter(record => String(record._id) !== String(base._id))
    .sort((a, b) => playerRecordScore(b) - playerRecordScore(a))];
  const firstValid = field => ordered.find(record => record[field]?.name)?.[field] || null;
  const baseRolls = Number(base.rolls) || 0;
  const maxRolls = Math.max(0, ...ordered.map(record => Number(record.rolls) || 0));

  return {
    species: firstValid("species"),
    originalSpecies: firstValid("originalSpecies") || firstValid("species"),
    questSpecies: mergePlayerProgress(ordered.map(record => record.questSpecies || {})),
    // Do not replace a non-zero balance on the best record with a stale copy.
    rolls: baseRolls > 0 ? baseRolls : maxRolls,
    requestsEnabled: typeof base.requestsEnabled === "boolean" ? base.requestsEnabled : true,
    lastSwitch: Number(base.lastSwitch) || Math.max(0, ...ordered.map(record => Number(record.lastSwitch) || 0)),
    awakening: mergePlayerProgress(ordered.map(record => record.awakening || {})),
    badges: mergePlayerProgress(ordered.map(record => record.badges || [])),
    // Token balances are not additive across duplicates; retain the highest known balance.
    speciesTokens: Math.max(0, ...ordered.map(record => Number(record.speciesTokens)||0)),
  };
}

function hasActiveUniqueUserIdIndex(indexes) {
  return indexes.some(index =>
    index.unique === true
    && Object.keys(index.key || {}).length === 1
    && index.key.userId === 1
    && index.partialFilterExpression?.archivedForRepair === false
  );
}

// ==================== LOAD FUNCTIONS ====================
async function loadAllData(userSpecies, leaderboard, fightLeaderboard, fightStats, dailyClaims, botStats) {
  try {
    if (!await connect()) {
      console.error("⚠️ Skipping MongoDB data load because the database is unavailable.");
      return false;
    }
    console.log(`📂 Loading data from MongoDB — host=${mongoose.connection.host || "unknown"}, database=${mongoose.connection.name || "unknown"}, usersCollection=${User.collection.name}`);

    const users = await User.find({ archivedForRepair: { $ne:true } });
    // Multiple MongoDB documents with the same userId collapse to one Map key.
    // Never let a later blank/default duplicate overwrite a complete saved profile.
    const recordsByUserId = new Map();
    let recordsWithoutUserId = 0;
    for (const userDoc of users) {
      const obj = userDoc.toObject();
      if (!obj.userId) { recordsWithoutUserId++; continue; }
      const existing = recordsByUserId.get(obj.userId) || [];
      existing.push(obj);
      recordsByUserId.set(obj.userId, existing);
    }

    let withSpecies = 0, withRolls = 0, duplicateExtraDocs = 0;
    for (const [uid, records] of recordsByUserId.entries()) {
      if (records.length > 1) duplicateExtraDocs += records.length - 1;
      const obj = chooseBestPlayerRecord(records);
      const d = {
        species:         obj.species         || null,
        originalSpecies: obj.originalSpecies || null,
        questSpecies:    obj.questSpecies    || {},
        rolls:           obj.rolls           || 0,
        speciesTokens:   Math.max(0, ...records.map(record => Number(record.speciesTokens)||0)),
        requestsEnabled: obj.requestsEnabled !== false,
        lastSwitch:      obj.lastSwitch      || 0,
        awakening:       obj.awakening       || {},
        badges:          obj.badges          || [],
      };
      userSpecies.set(uid, d);
      if (d.species && d.species.name) withSpecies++;
      if (d.rolls > 0) withRolls++;
    }

    console.log(`✅ Loaded ${recordsByUserId.size} unique players from ${users.length} MongoDB documents — ${withSpecies} have species, ${withRolls} have rolls`);
    if (duplicateExtraDocs > 0 || recordsWithoutUserId > 0) {
      console.error(`🚨 Player data integrity warning: ${duplicateExtraDocs} extra duplicate user documents, ${recordsWithoutUserId} documents missing userId. Loader chose the most complete record per userId in memory; no MongoDB documents were deleted.`);
    }

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

// Safely archive and mark duplicate player documents as inactive; no user documents
// are deleted. Original snapshots are retained in user_duplicate_archive.
async function repairUserRecords() {
  if (userRepairPromise) return userRepairPromise;

  const task = (async () => {
    if (!await connect()) return { ok:false, error:"MongoDB connection failed." };
    const docs = await User.find({ archivedForRepair: { $ne:true } }).lean();
    const groups = new Map();
    const invalidDocs = [];

    for (const doc of docs) {
      if (typeof doc.userId !== "string" || !doc.userId.length) {
        invalidDocs.push(doc);
        continue;
      }
      const group = groups.get(doc.userId) || [];
      group.push(doc);
      groups.set(doc.userId, group);
    }
    if (invalidDocs.length) {
      return { ok:false, error:`Found ${invalidDocs.length} active player documents without a valid userId. No records were changed.` };
    }

    const duplicateGroups = [...groups.entries()].filter(([, records]) => records.length > 1);
    const duplicateDocuments = duplicateGroups.flatMap(([, records]) => records);
    const db = mongoose.connection.db;
    if (!db) return { ok:false, error:"MongoDB database handle is unavailable." };
    const archive = db.collection("user_duplicate_archive");

    if (duplicateDocuments.length) {
      const now = new Date();
      await archive.bulkWrite(duplicateDocuments.map(doc => ({
        updateOne: {
          filter: { _id: doc._id },
          update: { $setOnInsert: {
            sourceCollection: User.collection.name,
            userId: doc.userId,
            archivedAt: now,
            originalDocument: doc,
          } },
          upsert: true,
        },
      })), { ordered:true });

      const archivedCount = await archive.countDocuments({
        _id: { $in: duplicateDocuments.map(doc => doc._id) },
        originalDocument: { $exists:true },
      });
      if (archivedCount !== duplicateDocuments.length) {
        return {
          ok:false,
          error:`Archive verification failed (${archivedCount}/${duplicateDocuments.length}). No player documents were changed.`,
          archivedDocuments: archivedCount,
          expectedArchiveCount: duplicateDocuments.length,
        };
      }
    }

    let groupsRepaired = 0, extraDocumentsMarked = 0;
    for (const [userId, records] of duplicateGroups) {
      const canonical = chooseBestPlayerRecord(records);
      const merged = mergeDuplicatePlayerRecords(records);
      const extras = records.filter(record => String(record._id) !== String(canonical._id));

      // Mark extras inactive first so the partial unique index can be created or
      // already be present without ever having two active documents for a user.
      if (extras.length) {
        const markResult = await User.collection.updateMany(
          { userId, _id: { $in: extras.map(record => record._id) } },
          { $set: { archivedForRepair:true, duplicateOf:canonical._id, archivedAt:new Date() } }
        );
        if (markResult.matchedCount !== extras.length) {
          return {
            ok:false,
            error:`Could not mark all duplicate copies for a player. Original documents remain archived for recovery; rerun repair.`,
            groupsRepaired,
            extraDocumentsMarked,
            archivedDocuments: duplicateDocuments.length,
          };
        }
        extraDocumentsMarked += markResult.modifiedCount;
      }

      const updateResult = await User.collection.updateOne(
        { _id: canonical._id, userId },
        { $set: { ...merged, archivedForRepair:false, duplicateOf:null, archivedAt:null } }
      );
      if (updateResult.matchedCount !== 1) {
        return {
          ok:false,
          error:`Could not safely update the active document for a player. All originals are archived; rerun repair.`,
          groupsRepaired,
          extraDocumentsMarked,
          archivedDocuments: duplicateDocuments.length,
        };
      }
      groupsRepaired++;
    }

    // Every non-duplicate legacy document becomes an active record too.
    await User.collection.updateMany(
      { archivedForRepair: { $exists:false } },
      { $set: { archivedForRepair:false, duplicateOf:null, archivedAt:null } }
    );

    const activeGroups = await User.aggregate([
      { $match: { archivedForRepair: { $ne:true } } },
      { $group: { _id:"$userId", count:{ $sum:1 } } },
      { $match: { _id:{ $ne:null }, count:{ $gt:1 } } },
      { $count:"groups" },
    ]);
    const duplicatesLeft = activeGroups[0]?.groups || 0;
    if (duplicatesLeft) {
      return {
        ok:false,
        error:`Still found ${duplicatesLeft} duplicate active userId groups. No player documents were deleted; originals are archived.`,
        groupsRepaired,
        extraDocumentsMarked,
        archivedDocuments: duplicateDocuments.length,
        remainingDuplicateUserIdGroups:duplicatesLeft,
      };
    }

    let indexes = await User.collection.indexes();
    let activeUniqueIndex = hasActiveUniqueUserIdIndex(indexes);
    if (!activeUniqueIndex) {
      // Remove only simple userId indexes whose key pattern conflicts with the
      // partial active-record index. This changes indexes, not player documents.
      const simpleUserIdIndexes = indexes.filter(index =>
        Object.keys(index.key || {}).length === 1
        && index.key.userId === 1
        && index.name !== "userId_active_unique"
      );
      for (const index of simpleUserIdIndexes) {
        if (index.name && index.name !== "_id_") await User.collection.dropIndex(index.name);
      }
      await User.collection.createIndex(
        { userId:1 },
        { unique:true, name:"userId_active_unique", partialFilterExpression:{ archivedForRepair:false } }
      );
      indexes = await User.collection.indexes();
      activeUniqueIndex = hasActiveUniqueUserIdIndex(indexes);
    }

    if (!activeUniqueIndex) {
      return {
        ok:false,
        error:"Duplicates have been marked inactive, but MongoDB did not confirm the active-user unique index. No player documents were deleted.",
        groupsRepaired,
        extraDocumentsMarked,
        archivedDocuments: duplicateDocuments.length,
      };
    }

    return {
      ok:true,
      groupsRepaired,
      extraDocumentsMarked,
      archivedDocuments: duplicateDocuments.length,
      archiveCollection:"user_duplicate_archive",
      uniqueUserIdIndex:true,
      activePlayerDocuments:await User.countDocuments({ archivedForRepair:{ $ne:true } }),
      archivedPlayerDocuments:await User.countDocuments({ archivedForRepair:true }),
      remainingDuplicateUserIdGroups:0,
    };
  })();

  userRepairPromise = task;
  try {
    return await task;
  } catch (e) {
    console.error("repairUserRecords error:", e);
    return { ok:false, error:e?.message || String(e) };
  } finally {
    if (userRepairPromise === task) userRepairPromise = null;
  }
}

// ==================== UTILITY ====================
// Used by /god debug-db to show collection counts
async function listAllKeys(debugUserId) {
  try {
    if (!await connect()) return { error: "MongoDB connection failed. Check Railway logs for the connection error." };

    // Run independent reads concurrently so the diagnostic can reply quickly.
    const [
      debugUserDocs, users, archivedUserDocs, usersWithSpecies, usersWithRolls,
      duplicateStats, userIndexes, allUserIds,
      leaderboard, fightLeaderboard, fightStats, botStats,
      dailyClaims, quests, duelChannels,
    ] = await Promise.all([
      debugUserId
        ? User.find({ userId: debugUserId, archivedForRepair: { $ne:true } }).select({ _id:1, userId:1, species:1, originalSpecies:1, rolls:1, questSpecies:1, awakening:1, badges:1, lastSwitch:1 }).lean()
        : Promise.resolve([]),
      User.countDocuments({ archivedForRepair: { $ne:true } }),
      User.countDocuments({ archivedForRepair:true }),
      User.countDocuments({ archivedForRepair: { $ne:true }, "species.name": { $exists:true, $ne:null } }),
      User.countDocuments({ archivedForRepair: { $ne:true }, rolls: { $gt:0 } }),
      User.aggregate([
        { $match: { archivedForRepair: { $ne:true } } },
        { $group: { _id:"$userId", count:{ $sum:1 } } },
        { $match: { _id:{ $ne:null }, count:{ $gt:1 } } },
        { $group: { _id:null, duplicateUserIdGroups:{ $sum:1 }, extraDuplicateUserDocs:{ $sum:{ $subtract:["$count",1] } } } },
      ]),
      User.collection.indexes().catch(() => []),
      User.distinct("userId", { archivedForRepair: { $ne:true } }),
      Leaderboard.countDocuments(),
      FightLeaderboard.countDocuments(),
      FightStats.countDocuments(),
      BotStats.countDocuments(),
      Daily.countDocuments(),
      Quest.countDocuments(),
      DuelChannel.countDocuments(),
    ]);

    const sortedDebugDocs = (debugUserDocs || [])
      .sort((a, b) => playerRecordScore(b) - playerRecordScore(a)
        || String(b._id || "").localeCompare(String(a._id || "")));
    const debugUser = chooseBestPlayerRecord(sortedDebugDocs);
    const duplicateInfo = duplicateStats[0] || { duplicateUserIdGroups:0, extraDuplicateUserDocs:0 };
    const hasUniqueUserIdIndex = hasActiveUniqueUserIdIndex(userIndexes);
    const userIdIndexDefinitions = userIndexes.filter(index => index.key?.userId === 1).map(index => ({
      name: index.name || "unnamed",
      key: Object.entries(index.key || {}).map(([field, direction]) => `${field}:${direction}`).join(", "),
      unique: index.unique === true,
      sparse: index.sparse === true,
      partial: Boolean(index.partialFilterExpression),
    }));
    const uniqueUserIds = (allUserIds || []).filter(id => typeof id === "string" && id.length > 0).length;
    const usersWithoutUserId = Math.max(0, users - uniqueUserIds - (duplicateInfo.extraDuplicateUserDocs || 0));

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
      debugUserRecordCount: debugUserDocs.length,
      debugUserRecords: sortedDebugDocs.map(record => ({
        documentId: String(record._id || "").slice(-8),
        species: record.species?.name || null,
        originalSpecies: record.originalSpecies?.name || null,
        rolls: Number(record.rolls) || 0,
        score: playerRecordScore(record),
      })),
      duplicateUserIdGroups: duplicateInfo.duplicateUserIdGroups || 0,
      extraDuplicateUserDocs: duplicateInfo.extraDuplicateUserDocs || 0,
      hasUniqueUserIdIndex, userIdIndexDefinitions, uniqueUserIds, usersWithoutUserId,
      users, archivedUserDocs, usersWithSpecies, usersWithRolls,
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
  saveUserSpecies, saveUserRolls, saveUserSpeciesFields, addSpeciesTokens, redeemSpeciesToken, repairUserRecords,
  saveLeaderboard, saveFightLeaderboard,
  saveFightStats, saveBotStats, saveDailyClaim,
  saveQuestProgress, saveDuelChannel,
  loadAllData, loadAllQuestProgress, loadDuelChannel,
  listAllKeys, deleteUser,
  setBroadcastOptIn, getBroadcastOptIn, getBroadcastSubscribers,
};
