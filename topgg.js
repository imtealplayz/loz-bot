const express = require("express");
const crypto = require("crypto");
const { EmbedBuilder } = require("discord.js");

const TOPGG_ROLLS_PER_VOTE = Math.max(
  1,
  Number.parseInt(process.env.TOPGG_ROLLS_PER_VOTE || "1", 10) || 1,
);
const TOPGG_WEBHOOK_PATH = "/topgg/webhook";

function isValidDiscordId(value) {
  return /^\d{17,20}$/.test(String(value || ""));
}

function verifyTopggSignature(req, secret) {
  const header = req.get("x-topgg-signature") || "";
  const parts = Object.fromEntries(header.split(",").map(part => {
    const separator = part.indexOf("=");
    return separator < 0
      ? [part.trim(), ""]
      : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }));
  const timestamp = parts.t;
  const signature = parts.v1;
  const timestampNumber = Number(timestamp);

  if (!timestamp || !signature || !Number.isFinite(timestampNumber) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return { ok:false, status:401, error:"Missing or malformed Top.gg signature." };
  }
  if (Math.abs(Date.now() / 1000 - timestampNumber) > 300) {
    return { ok:false, status:401, error:"Top.gg signature timestamp is stale." };
  }

  const expected = crypto.createHmac("sha256", secret)
    .update(String(timestamp) + "." + (req.rawBody || ""))
    .digest("hex");
  const suppliedBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return { ok:false, status:401, error:"Invalid Top.gg signature." };
  }
  return { ok:true };
}

function startTopggWebhookServer({ client, state, database, isDatabaseReady }) {
  const app = express();
  app.use(express.json({
    limit:"100kb",
    verify:(req, _res, buffer) => { req.rawBody = buffer.toString("utf8"); },
  }));
  app.get("/health", (_req, res) => res.status(200).send("LOZ webhook service is online."));
  app.post(TOPGG_WEBHOOK_PATH, async (req, res) => {
    const secret = (process.env.TOPGG_WEBHOOK_SECRET || "").trim();
    if (!secret) {
      console.error("❌ Top.gg webhook received but TOPGG_WEBHOOK_SECRET is not configured.");
      return res.status(503).json({ ok:false, error:"Top.gg webhook is not configured." });
    }

    const verification = verifyTopggSignature(req, secret);
    if (!verification.ok) return res.status(verification.status).json({ ok:false, error:verification.error });

    const event = req.body && typeof req.body === "object" ? req.body : {};
    const data = event.data && typeof event.data === "object" ? event.data : event;
    const eventType = String(event.type || data.type || "").toLowerCase();

    if (eventType.includes("test") || event.test === true || data.test === true) {
      console.log("🧪 Received a signed Top.gg test webhook; no reward granted.");
      return res.status(200).json({ ok:true, test:true, rewarded:false });
    }
    if (!eventType.includes("vote") && !eventType.includes("upvote")) {
      console.log("ℹ️ Ignored signed Top.gg event:", eventType || "(no type)");
      return res.status(200).json({ ok:true, ignored:true });
    }

    const rawUser = data.userId ?? data.user_id ?? data.voterId ?? data.voter_id ?? data.user;
    const userId = typeof rawUser === "string"
      ? rawUser
      : (rawUser && typeof rawUser === "object" && rawUser.id ? String(rawUser.id) : "");
    if (!isValidDiscordId(userId)) {
      console.error("❌ Top.gg vote payload has no valid Discord user ID.");
      return res.status(400).json({ ok:false, error:"Invalid voter ID." });
    }
    if (!isDatabaseReady()) {
      return res.status(503).json({ ok:false, error:"LOZ player database is still loading." });
    }

    const weekendValue = data.isWeekend ?? data.is_weekend ?? data.weekend ?? false;
    const isWeekend = weekendValue === true || weekendValue === "true";
    const rollsAwarded = TOPGG_ROLLS_PER_VOTE * (isWeekend ? 2 : 1);

    try {
      const result = await database.recordTopggVote(userId, rollsAwarded);
      if (!result.ok) {
        console.error("❌ Could not persist Top.gg vote reward:", result.error);
        return res.status(500).json({ ok:false, error:"Could not persist vote reward." });
      }
      if (!result.awarded) {
        console.log("↩️ Duplicate/early Top.gg vote ignored for user " + userId + ".");
        return res.status(200).json({ ok:true, rewarded:false, reason:"duplicate_or_cooldown" });
      }

      const persisted = result.player || {};
      const cached = state.userSpecies.get(userId);
      if (cached) {
        cached.rolls = result.rollsTotal;
      } else {
        state.userSpecies.set(userId, {
          species:persisted.species || null,
          originalSpecies:persisted.originalSpecies || null,
          questSpecies:persisted.questSpecies || {},
          rolls:result.rollsTotal,
          requestsEnabled:persisted.requestsEnabled !== false,
          lastSwitch:Number(persisted.lastSwitch) || 0,
          awakening:persisted.awakening || {},
          badges:persisted.badges || [],
        });
      }

      console.log("✅ Top.gg vote rewarded user " + userId + ": +" + rollsAwarded + " rolls (total " + result.rollsTotal + ").");
      const voter = await client.users.fetch(userId).catch(() => null);
      if (voter) {
        const voteUrl = "https://top.gg/bot/" + client.user.id + "/vote";
        const plural = rollsAwarded === 1 ? "" : "s";
        const embed = new EmbedBuilder()
          .setColor(0x0891b2)
          .setTitle("Thanks for voting for LOZ!")
          .setDescription("Your Top.gg vote was verified and you received **+" + rollsAwarded + " species roll" + plural + "**.\n\nYou now have **" + result.rollsTotal + " rolls**.\n\nYou can vote again in about 12 hours.")
          .setURL(voteUrl)
          .setFooter({ text:"Vote rewards are added automatically." });
        await voter.send({ embeds:[embed] }).catch(() => {});
      }

      return res.status(200).json({ ok:true, rewarded:true, rollsAwarded });
    } catch (error) {
      console.error("❌ Top.gg vote handler failed:", error);
      return res.status(500).json({ ok:false, error:"Internal vote reward error." });
    }
  });

  const port = Number.parseInt(process.env.PORT || "3000", 10);
  app.listen(port, "0.0.0.0", () => {
    console.log("🌐 Top.gg webhook listener online on port " + port + " at " + TOPGG_WEBHOOK_PATH + ".");
    if (!process.env.TOPGG_WEBHOOK_SECRET) {
      console.warn("⚠️ Set TOPGG_WEBHOOK_SECRET in Railway and configure a Top.gg Webhooks V2 endpoint before votes can grant rewards.");
    }
  });
}

module.exports = { startTopggWebhookServer };
