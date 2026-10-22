"use strict";

const { EmbedBuilder } = require("discord.js");
const database = require("./database.js");

const MAX_LEVEL = 500;
const XP_PER_LEVEL = 100;
const CANDIES_EMOJI = "<:Candies:1562536882561224734>";
const HALLOWEEN_END = Date.parse("2026-11-01T00:00:00+05:30");
const LEVEL_UP_MESSAGES = [
  "Look at you go! You're getting stronger with every milestone.",
  "Are you an AI? Because that progress is unreal.",
  "The Rift has noticed your determination.",
  "Another step toward becoming a legend.",
  "You're making the impossible look routine.",
  "Your journey is turning into a story worth telling.",
  "The grind is paying off. Keep going.",
  "You're not just surviving the Rift anymore. You're mastering it.",
  "That dedication deserves a place in the chronicles.",
  "Your rivals should probably start paying attention.",
  "A new milestone, and plenty more ahead.",
  "You're proving that consistency beats luck.",
  "Power grows, but so does your reputation.",
  "The Rift gets a little less mysterious with every level.",
  "You're building a legacy one battle at a time."
];

function normalizeLevelData(data = {}) {
  const level = Math.max(1, Math.min(MAX_LEVEL, Math.floor(Number(data.level) || 1)));
  return { level, xp: level >= MAX_LEVEL ? 0 : Math.max(0, Math.min(XP_PER_LEVEL - 1, Math.floor(Number(data.xp) || 0))) };
}
function progressBar(current, total = XP_PER_LEVEL, width = 12) {
  const max = Math.max(1, Number(total) || 1);
  const value = Math.max(0, Math.min(max, Number(current) || 0));
  const filled = Math.round(value / max * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}
function getProgressText(data = {}) {
  const progress = normalizeLevelData(data);
  if (progress.level >= MAX_LEVEL) return "⭐ **Level 500 · MAX LEVEL**\n" + progressBar(1, 1) + " **MAX**";
  return "⭐ **Level " + progress.level + "**\n" + progressBar(progress.xp, XP_PER_LEVEL) + " **" + progress.xp + "/" + XP_PER_LEVEL + " XP**";
}
function getLevelCard(data = {}) {
  const progress = normalizeLevelData(data);
  const embed = new EmbedBuilder().setColor(0xf97316).setTitle("LOZ · Level Progress");
  embed.setDescription(progress.level >= MAX_LEVEL
    ? "## ⭐ Level 500\nYou have reached the current level cap. Further battles won't increase your level."
    : "## ⭐ Level " + progress.level + "\n" + progressBar(progress.xp, XP_PER_LEVEL) + "\n**" + progress.xp + " / " + XP_PER_LEVEL + " XP** toward Level " + (progress.level + 1) + ".");
  embed.addFields(
    { name: CANDIES_EMOJI + " Candies", value: String(Math.max(0, Number(data.candies) || 0)), inline: true },
    { name: "Species Rolls", value: String(Math.max(0, Number(data.rolls) || 0)), inline: true },
    { name: "Species Tokens", value: String(Math.max(0, Number(data.speciesTokens) || 0)), inline: true }
  );
  if (Date.now() < HALLOWEEN_END) embed.setFooter({ text: "Halloween event · Candies are available until Nov 1, 2026 at 12:00 AM IST" });
  return { embeds: [embed], allowedMentions: { parse: [] } };
}
function calculateBattleReward({ mode = "bot", difficulty = "easy", won = false, rounds = 1, boss = false } = {}) {
  const winXP = { easy: 10, medium: 18, hard: 28, impossible: 40, brutal: 50 };
  const lossXP = { easy: 3, medium: 6, hard: 9, impossible: 12, brutal: 16 };
  const winCandies = { easy: 4, medium: 9, hard: 16, impossible: 25, brutal: 35 };
  const lossCandies = { easy: 1, medium: 2, hard: 4, impossible: 6, brutal: 9 };
  const isPvP = mode === "pvp";
  const roundCount = Math.max(1, Math.floor(Number(rounds) || 1));
  const xpBase = isPvP ? (won ? 28 : 10) : (won ? (winXP[difficulty] || 10) : (lossXP[difficulty] || 3));
  const candyBase = isPvP ? (won ? 16 : 5) : (won ? (winCandies[difficulty] || 4) : (lossCandies[difficulty] || 1));
  return {
    xp: Math.max(1, xpBase + Math.min(22, Math.max(0, roundCount - 1) * 2) + (boss ? 8 : 0)),
    candies: Math.max(0, candyBase + Math.min(12, Math.max(0, roundCount - 1)) + (boss ? 8 : 0))
  };
}
async function notifyLevelUp(state, channel, userId, fromLevel, toLevel, rewards) {
  const message = LEVEL_UP_MESSAGES[(toLevel - 2) % LEVEL_UP_MESSAGES.length];
  const rows = [];
  if (rewards.candies > 0) rows.push("• " + CANDIES_EMOJI + " " + rewards.candies + " Candies");
  if (rewards.rolls > 0) rows.push("• <:reroll_dice:1558042108965822515> " + rewards.rolls + " Species Roll(s)");
  if (rewards.tokens > 0) rows.push("• <:species_token:1558181624296771634> " + rewards.tokens + " Species Token(s)");
  const embed = new EmbedBuilder()
    .setColor(0xf97316)
    .setTitle("Level up!")
    .setDescription("**" + message + "**\n\n<@" + userId + "> leveled up from level **" + fromLevel + "** to **" + toLevel + "**.\n\n**Rewards**\n" + (rows.length ? rows.join("\n") : "• New level reached"))
    .setFooter({ text: "LOZ · Legends of the Rift" });
  const payload = { embeds: [embed], allowedMentions: { users: [String(userId)] } };
  try {
    const client = channel && channel.client;
    const target = client && client.users ? await client.users.fetch(String(userId)).catch(() => null) : null;
    if (target) {
      await target.send(payload);
      return true;
    }
  } catch (_) {}
  try {
    if (channel && typeof channel.send === "function") {
      await channel.send(payload);
      return true;
    }
  } catch (error) {
    console.warn("[Leveling] Could not deliver level-up message by DM or channel:", error && (error.message || String(error)));
  }
  return false;
}
async function awardFightProgress({ state, channel, fight, userId, mode = "bot", difficulty = "easy", won = false, reason = "normal", boss = false, pvpEligible = true } = {}) {
  try {
    const uid = String(userId || "");
    if (!state || !state.userSpecies || !fight || !uid) return { ok: false, status: "invalid" };
    if (["forfeit", "timeout", "disintegration", "judge", "divine-intervention", "chaos-disintegrate"].includes(String(reason))) return { ok: false, status: "ineligible" };
    if (mode === "pvp" && !pvpEligible) return { ok: false, status: "pvp-limit" };
    if (!Array.isArray(fight.progressionAwardKeys)) fight.progressionAwardKeys = [];
    const rewardKey = String(fight.fightId || fight.id || "fight") + ":" + mode + ":" + uid;
    if (fight.progressionAwardKeys.includes(rewardKey)) return { ok: false, status: "duplicate-local" };
    fight.progressionAwardKeys.push(rewardKey);
    const data = state.userSpecies.get(uid) || { species: null, originalSpecies: null, questSpecies: {}, rolls: 0, speciesTokens: 0, candies: 0, level: 1, xp: 0 };
    const reward = calculateBattleReward({ mode, difficulty, won, rounds: Math.max(1, Number(fight.round) || 1), boss });
    const halloweenActive = Date.now() < HALLOWEEN_END;
    const saved = await database.applyBattleLevelingReward(uid, rewardKey, {
      xpDelta: reward.xp,
      candiesDelta: halloweenActive ? reward.candies : 0,
      candyPerLevel: halloweenActive ? 5 : 0
    });
    if (!saved || !saved.ok || saved.duplicate) return { ok: Boolean(saved && saved.ok), status: saved && saved.duplicate ? "duplicate" : "save-failed" };
    const updated = Object.assign({}, data, {
      level: saved.user.level, xp: saved.user.xp, candies: saved.user.candies,
      rolls: saved.user.rolls, speciesTokens: saved.user.speciesTokens
    });
    state.userSpecies.set(uid, updated);
    for (let level = saved.user.previousLevel + 1; level <= saved.user.level; level++) {
      await notifyLevelUp(state, channel, uid, level - 1, level, {
        candies: halloweenActive ? 5 : 0,
        rolls: level % 5 === 0 ? 1 : 0,
        tokens: level % 25 === 0 ? 1 : 0
      });
    }
    return { ok: true, xp: reward.xp, candies: saved.user.candiesDelta, levelsGained: saved.user.levelsGained, level: saved.user.level, xpProgress: saved.user.xp, rolls: saved.user.rollsDelta, tokens: saved.user.tokensDelta };
  } catch (error) {
    console.error("[Leveling] Fight progression failed safely:", error && (error.stack || error));
    return { ok: false, status: "error" };
  }
}

module.exports = { MAX_LEVEL, XP_PER_LEVEL, HALLOWEEN_END, normalizeLevelData, progressBar, getProgressText, getLevelCard, calculateBattleReward, notifyLevelUp, awardFightProgress };
