const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const PRIMARY_OWNER_ID = "926063716057894953";
let _state = null;

function setState(state) {
  _state = state;
}

function isChaosCreatorOwner(combatant) {
  return Boolean(
    combatant
    && /^\d{17,20}$/.test(String(combatant.id || ""))
    && combatant.species?.name === "Chaos Creator"
  );
}

function findFight(fightId) {
  return _state?.activeFights?.get(fightId)
    || _state?.activeBotFights?.get(fightId)
    || null;
}

async function askChaosReaction({
  fight,
  channel,
  question,
  confirmedText,
  declinedText,
  timeoutMs = 15000,
  respondentId = null,
}) {
  if (!fight || !channel || fight.pendingChaosReaction) {
    return { confirmed: false, timedOut: true, cancelled: false };
  }
  respondentId = String(respondentId || fight.playerId || fight.player1Id || fight.player2Id || "");
  if (!/^\d{17,20}$/.test(respondentId)) {
    return { confirmed:false, timedOut:true, cancelled:false };
  }

  let resolveResult;
  const resultPromise = new Promise(resolve => { resolveResult = resolve; });
  const pending = {
    message: null,
    timer: null,
    resolved: false,
    finish: null,
    respondentId,
  };
  fight.pendingChaosReaction = pending;

  pending.finish = async (confirmed, { timedOut = false, cancelled = false } = {}) => {
    if (pending.resolved) return;
    pending.resolved = true;
    if (pending.timer) clearTimeout(pending.timer);
    if (fight.pendingChaosReaction === pending) delete fight.pendingChaosReaction;
    if (pending.message) await pending.message.delete().catch(() => {});

    if (!timedOut && !cancelled) {
      const content = confirmed ? confirmedText : declinedText;
      if (content) {
        try {
          const confirmation = await channel.send({
            content,
            allowedMentions: { parse: [] },
          });
          setTimeout(() => confirmation.delete().catch(() => {}), 3000);
        } catch (error) {
          console.error("[Chaos Creator] Failed to send reaction confirmation:", error?.message || error);
        }
      }
    }
    resolveResult({ confirmed: Boolean(confirmed), timedOut, cancelled });
  };

  try {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("chaosreact_yes_" + fight.fightId)
        .setLabel("Yes")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("chaosreact_no_" + fight.fightId)
        .setLabel("No")
        .setStyle(ButtonStyle.Secondary),
    );
    pending.message = await channel.send({
      content: "<@" + respondentId + "> " + question,
      components: [row],
      allowedMentions: { parse: [], users: [respondentId] },
    });
    if (pending.resolved) {
      await pending.message.delete().catch(() => {});
    } else {
      pending.timer = setTimeout(() => {
        pending.finish(false, { timedOut: true }).catch(error =>
          console.error("[Chaos Creator] Reaction timeout cleanup failed:", error?.message || error)
        );
      }, timeoutMs);
    }
  } catch (error) {
    console.error("[Chaos Creator] Failed to send reaction prompt:", error?.message || error);
    await pending.finish(false, { timedOut: true, cancelled: true });
  }

  return resultPromise;
}

async function handleReactionButton(interaction) {
  const parts = String(interaction.customId || "").split("_");
  if (parts[0] !== "chaosreact" || !["yes", "no"].includes(parts[1])) return false;
  const fightId = parts.slice(2).join("_");
  const fight = findFight(fightId);
  const pending = fight?.pendingChaosReaction;
  if (!pending) {
    await interaction.deferUpdate().catch(() => {});
    return true;
  }
  if (interaction.user?.id !== pending.respondentId) {
    await interaction.reply({
      content: "Only the player whose Chaos Creator triggered this prompt can respond.",
      flags: 64,
    }).catch(() => {});
    return true;
  }

  await interaction.deferUpdate();
  await pending.finish(parts[1] === "yes");
  return true;
}

function cancelChaosReaction(fight) {
  const pending = fight?.pendingChaosReaction;
  if (pending?.finish) {
    pending.finish(false, { timedOut: true, cancelled: true }).catch(error =>
      console.error("[Chaos Creator] Prompt cancellation failed:", error?.message || error)
    );
  }
}

module.exports = {
  PRIMARY_OWNER_ID,
  setState,
  isChaosCreatorOwner,
  askChaosReaction,
  handleReactionButton,
  cancelChaosReaction,
};
