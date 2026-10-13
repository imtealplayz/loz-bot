"use strict";

const database = require("./database.js");

const TOP_LIMIT = 10;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const BADGE_PREFIX = "LB_";

const BADGE_LABELS = {
  LB_FIGHTS_1: "🥇 Fight Wins Leaderboard #1",
  LB_FIGHTS_2: "🥈 Fight Wins Leaderboard #2",
  LB_FIGHTS_3: "🥉 Fight Wins Leaderboard #3",
  LB_FIGHTS_TOP10: "🏅 Top 10 Fight Wins in the World",
  LB_ROLLS_1: "🥇 Species Rolls Leaderboard #1",
  LB_ROLLS_2: "🥈 Species Rolls Leaderboard #2",
  LB_ROLLS_3: "🥉 Species Rolls Leaderboard #3",
  LB_ROLLS_TOP10: "🏅 Top 10 Species Rolls in the World",
};

let started = false;
let running = false;
let previousSnapshot = null;
let snapshotLoaded = false;

function badgeToken(board, rank) {
  const prefix = board === "fights" ? "LB_FIGHTS" : "LB_ROLLS";
  return rank <= 3 ? prefix + "_" + rank : prefix + "_TOP10";
}

function boardName(board) {
  return board === "fights" ? "Fight Wins" : "Species Rolls";
}

function scoreLabel(board) {
  return board === "fights" ? "wins" : "Species Rolls";
}

function getRankings(state) {
  const fightsAll = Array.from(state.fightLeaderboard.entries())
    .map(([userId, data]) => ({
      userId: String(userId),
      score: Math.max(0, Number(data && data.wins) || 0),
    }))
    .sort((a, b) => (b.score - a.score) || a.userId.localeCompare(b.userId));

  const rollsAll = Array.from(state.userSpecies.entries())
    .map(([userId, data]) => ({
      userId: String(userId),
      score: Math.max(0, Number(data && data.rolls) || 0),
    }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => (b.score - a.score) || a.userId.localeCompare(b.userId));

  const buildBoard = entries => ({
    all: new Map(entries.map((entry, index) => [
      entry.userId,
      { rank: index + 1, score: entry.score },
    ])),
    top: Object.fromEntries(entries.slice(0, TOP_LIMIT).map((entry, index) => [
      entry.userId,
      { rank: index + 1, score: entry.score },
    ])),
  });

  return {
    fights: buildBoard(fightsAll),
    rolls: buildBoard(rollsAll),
  };
}

function createSnapshot(rankings) {
  return {
    initialized: true,
    updatedAt: Date.now(),
    boards: {
      fights: rankings.fights.top,
      rolls: rankings.rolls.top,
    },
  };
}

function currentScore(board, userId, state) {
  if (board === "fights") {
    return Math.max(0, Number(state.fightLeaderboard.get(userId)?.wins) || 0);
  }
  return Math.max(0, Number(state.userSpecies.get(userId)?.rolls) || 0);
}

function collectEvents(previous, next, rankings, state, isInitial) {
  const eventsByUser = new Map();
  const add = (userId, event) => {
    if (!eventsByUser.has(userId)) eventsByUser.set(userId, []);
    eventsByUser.get(userId).push(event);
  };

  for (const board of ["fights", "rolls"]) {
    const oldBoard = previous?.boards?.[board] || {};
    const newBoard = next.boards[board] || {};

    if (isInitial) {
      for (const [userId, entry] of Object.entries(newBoard)) {
        add(userId, {
          board,
          kind: "initial",
          oldRank: null,
          rank: entry.rank,
          score: entry.score,
        });
      }
      continue;
    }

    const userIds = new Set([
      ...Object.keys(oldBoard),
      ...Object.keys(newBoard),
    ]);

    for (const userId of userIds) {
      const oldRank = oldBoard[userId]?.rank || null;
      const topEntry = newBoard[userId] || null;
      const newTopRank = topEntry?.rank || null;

      if (oldRank === newTopRank) continue;

      let kind;
      if (oldRank === null && newTopRank !== null) {
        kind = "entered";
      } else if (oldRank !== null && newTopRank === null) {
        kind = "out";
      } else if (newTopRank < oldRank) {
        kind = "up";
      } else {
        kind = "down";
      }

      const currentEntry = rankings[board].all.get(userId) || null;
      add(userId, {
        board,
        kind,
        oldRank,
        rank: currentEntry?.rank || null,
        score: currentEntry ? currentEntry.score : currentScore(board, userId, state),
      });
    }
  }

  return eventsByUser;
}

async function syncProfileBadges(state, snapshot, previous) {
  const userIds = new Set([
    ...state.userSpecies.keys(),
    ...Object.keys(previous?.boards?.fights || {}),
    ...Object.keys(previous?.boards?.rolls || {}),
    ...Object.keys(snapshot.boards.fights || {}),
    ...Object.keys(snapshot.boards.rolls || {}),
  ]);

  for (const userId of userIds) {
    let data = state.userSpecies.get(userId);
    const nextRankBadges = [];
    for (const board of ["fights", "rolls"]) {
      const entry = snapshot.boards[board]?.[userId];
      if (entry) nextRankBadges.push(badgeToken(board, entry.rank));
    }

    const currentBadges = Array.isArray(data?.badges) ? data.badges : [];
    const retainedBadges = currentBadges.filter(
      badge => typeof badge !== "string" || !badge.startsWith(BADGE_PREFIX)
    );
    const nextBadges = Array.from(new Set([...retainedBadges, ...nextRankBadges]));

    if (!data && nextRankBadges.length === 0) continue;
    if (!data) {
      data = {
        species: null,
        originalSpecies: null,
        questSpecies: {},
        rolls: 0,
        speciesTokens: 0,
        requestsEnabled: true,
        badges: [],
      };
      state.userSpecies.set(userId, data);
    }

    if (JSON.stringify(currentBadges) === JSON.stringify(nextBadges)) continue;
    data.badges = nextBadges;
    const saved = await database.saveUserSpecies(userId, { badges: nextBadges });
    if (!saved) {
      console.warn("[Leaderboard Badges] Could not save profile badges for user " + userId);
    }
  }
}

function rankText(rank) {
  if (!rank) return "Unranked";
  return "#" + rank + (rank > TOP_LIMIT ? " (outside the Top 10)" : "");
}

function eventText(event) {
  const title = boardName(event.board);
  const countName = scoreLabel(event.board);
  const badge = event.rank && event.rank <= TOP_LIMIT
    ? BADGE_LABELS[badgeToken(event.board, event.rank)]
    : null;

  let status;
  if (event.kind === "initial") {
    status = "Badge unlocked: " + badge + ".";
  } else if (event.kind === "entered") {
    status = "You entered the Top 10 and unlocked a leaderboard badge.";
  } else if (event.kind === "up") {
    status = "Rank up: #" + event.oldRank + " → #" + event.rank + ".";
  } else if (event.kind === "down" && event.rank) {
    status = "Rank down: #" + event.oldRank + " → #" + event.rank + ".";
  } else {
    status = "You dropped out of the Top 10. Your previous leaderboard badge has been removed.";
  }

  let badgeUpdate;
  if (!badge) {
    badgeUpdate = "No active Top 10 badge";
  } else if (event.kind === "initial" || event.kind === "entered") {
    badgeUpdate = "Badge unlocked: " + badge;
  } else {
    badgeUpdate = "Current badge: " + badge;
  }

  let why;
  if (event.kind === "out") {
    why = "Your current standing is no longer within the Top 10.";
  } else if (event.rank && event.rank <= 3) {
    why = "You are currently ranked #" + event.rank + " worldwide for " + title.toLowerCase() + ".";
  } else if (event.rank && event.rank <= TOP_LIMIT) {
    why = "You are currently among the world's Top 10 for " + title.toLowerCase() + ".";
  } else if (event.rank) {
    why = "Your current standing is #" + event.rank + " worldwide, outside the Top 10.";
  } else {
    why = "You currently have no eligible standing on this leaderboard.";
  }

  let currentRank = rankText(event.rank);
  if (event.board === "rolls" && !event.rank && event.score === 0) {
    currentRank = "Unranked (0 unspent Species Rolls)";
  }

  return "**" + title + "**\n"
    + status + "\n"
    + "• **Current rank:** " + currentRank + "\n"
    + "• **Badge update:** " + badgeUpdate + "\n"
    + "• **Why:** " + why + "\n"
    + "• **Current total:** " + event.score + " " + countName;
}

function buildDM(events, isInitial) {
  const sections = events.map(eventText);
  const heading = isInitial
    ? "## 🏅 LOZ Leaderboard Badges Unlocked"
    : "## 🏆 LOZ Leaderboard Rank Update";

  return heading + "\n\n"
    + (isInitial
      ? "The leaderboard badge system is live, and you have earned the following badge(s):\n\n"
      : "Your leaderboard standing changed. Here is your latest rank and badge status:\n\n")
    + sections.join("\n\n")
    + "\n\nUse the /profile command to view your badges.";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendNotifications(client, eventsByUser, isInitial) {
  let delivered = 0;
  let failed = 0;

  for (const [userId, events] of eventsByUser.entries()) {
    try {
      const user = await client.users.fetch(userId);
      if (user.bot) continue;
      await user.send(buildDM(events, isInitial));
      delivered++;
    } catch (error) {
      failed++;
      console.warn(
        "[Leaderboard Badges] Could not DM " + userId + ": "
        + String(error?.message || error)
      );
    }
    await sleep(350);
  }

  console.log(
    "[Leaderboard Badges] Notification pass complete: "
    + delivered + " sent, " + failed + " failed."
  );
}

async function runCycle(client, state) {
  if (running) return;
  running = true;

  try {
    if (!snapshotLoaded) {
      const loaded = await database.getLeaderboardBadgeSnapshot();
      if (!loaded?.ok) {
        console.warn("[Leaderboard Badges] Snapshot could not be loaded; retrying next cycle.");
        return;
      }
      previousSnapshot = loaded.data || null;
      snapshotLoaded = true;
    }

    const rankings = getRankings(state);
    const nextSnapshot = createSnapshot(rankings);
    const isInitial = !previousSnapshot?.initialized;
    const eventsByUser = collectEvents(previousSnapshot, nextSnapshot, rankings, state, isInitial);

    await syncProfileBadges(state, nextSnapshot, previousSnapshot);

    const hasEvents = eventsByUser.size > 0;
    if (isInitial || hasEvents) {
      const saved = await database.saveLeaderboardBadgeSnapshot(nextSnapshot);
      if (!saved) {
        console.warn("[Leaderboard Badges] Snapshot could not be saved; notifications will retry next cycle.");
        return;
      }
      previousSnapshot = nextSnapshot;
    } else {
      previousSnapshot = nextSnapshot;
    }

    if (hasEvents) await sendNotifications(client, eventsByUser, isInitial);
  } catch (error) {
    console.error("[Leaderboard Badges] Scheduler error:", error);
  } finally {
    running = false;
  }
}

function startScheduler(client, state) {
  if (started) return Promise.resolve(false);
  started = true;

  void runCycle(client, state);
  const timer = setInterval(() => {
    void runCycle(client, state);
  }, CHECK_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();

  console.log("[Leaderboard Badges] Rank tracking enabled; checking every 5 minutes.");
  return Promise.resolve(true);
}

module.exports = {
  startScheduler,
  BADGE_LABELS,
};
