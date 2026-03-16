const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, REST, Routes, PermissionsBitField,
} = require("discord.js");
const {
  patchNotes, humanSpecies, reaperSpecies, archdemonSpecies,
  botSpecies, botSpeciesByDifficulty, botPersonalities,
  typeAdvantages, disintegrationMessages,
  getPassiveDescription, getActiveDescription,
} = require("./constants.js");
const database = require("./database.js");
const {
  hpBar, createErrorEmbed, createSuccessEmbed, safeReply,
  getSpeciesByName, getRandomSpecies, getDragonSubtype,
  isPlayerInGame, isPlayerInFight, isPlayerInBotFight, canFight,
  canSendRequest, assignSpeciesRole,
  updateLeaderboard, updateFightStats, updateCyborgProgress,
  isCyborgReadyForAwakening, updateReaperQuest,
} = require("./helpers.js");
const { buildBotFightEmbed, buildBotFightRow, buildFightEmbed, buildFightRow, makeCombatant, calculateDamage, applyUltEffect, tickCooldowns, tickBothUltCooldowns, applyOgreRegen, processCurseTick } = require("./combat.js");
const { startFight, endFight, doBotTurn, endBotFight, startDuelGame, startBombGame, handleBotPass, startBotRound } = require("./fights.js");

let _state = null;
let _client = null;
function setState(s) { _state = s; }
function setClient(c) { _client = c; }

// ==================== SLASH COMMAND HANDLER ====================
async function handleCommand(interaction) {
  const { commandName, options, user, guild, channel } = interaction;

  // ── HELP ──────────────────────────────────────────────────────
  if (commandName === "help") {
    const embed = new EmbedBuilder().setColor(0x0891b2).setTitle("📖 LOZ Commands").setDescription("Complete list of commands")
      .addFields(
        {name:"🎲 Species",  value:"`/species-roll` `/species` `/switch` `/daily`",inline:false},
        {name:"⚔️ Combat",   value:"`/fight @user` `/fightbot`",inline:false},
        {name:"💣 Bomb Tag", value:"`/bombtag1v1` `/bombtag1v1bot` `'pass @user`",inline:false},
        {name:"📊 Stats",    value:"`/fightstats` `/botstats` `/history` `/lb` `/fights`",inline:false},
        {name:"🌑 Quests",   value:"`/quest view` `/quest claim` `/awakening`",inline:false},
        {name:"📋 Info",     value:"`/patchnotes` `/guide` `/profile`",inline:false},
      ).setFooter({text:"Use /guide for a full tutorial"});
    return safeReply(interaction,{embeds:[embed]});
  }

  // ── GUIDE ─────────────────────────────────────────────────────
  if (commandName === "guide") {
    const steps=[
      {title:"Welcome to LOZ!",content:"LOZ is an RPG battle bot!\n\n**Step 1:** Use `/daily` for your first free roll.\n**Step 2:** Use `/species-roll` to get your species.\n**Step 3:** Use `/fight @user` to battle!"},
      {title:"Species System",content:"Each species has unique stats:\n• **HP** — Health points\n• **ATK** — Damage range\n• **HEAL** — Heal range\n• **ULT** — Ultimate ability cooldown\n\nRarer species are stronger!"},
      {title:"Combat",content:"Fights are turn-based:\n• ⚔️ **ATTACK** — Deal damage\n• 💚 **HEAL** — Recover HP (3-round cooldown)\n• ✨ **ULT** — Species unique ability\n• 🏃 **FORFEIT** — Give up\n\nWin fights for leaderboard points and rolls!"},
      {title:"Quests & Awakenings",content:"• **Reaper Quest** — Defeat bots and players to unlock Reaper\n• **Cyborg Awakening** — 25 wins, 500 damage, 15 ULTs → Mechangel!\n\nUse `/quest view` to track progress."},
      {title:"Bomb Tag",content:"Fun party game!\n• Use `/bombtag1v1` to challenge someone\n• Use `'pass @user` to pass the bomb\n• Don't be holding it when it explodes!\n\nCheck `/lb` for the bomb tag leaderboard!"},
    ];
    const embed=new EmbedBuilder().setColor(0x0891b2).setTitle(`📖 New Player Guide (1/${steps.length})`).setDescription(`**${steps[0].title}**\n\n${steps[0].content}`);
    const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("guide_next_0").setLabel("NEXT →").setStyle(ButtonStyle.Primary));
    return safeReply(interaction,{embeds:[embed],components:[row],flags:64});
  }

  // ── DAILY ─────────────────────────────────────────────────────
  if (commandName === "daily") {
    const now=Date.now(), ud=_state.dailyClaims.get(user.id);
    if (ud&&now-ud.lastClaim<86400000) {
      const tl=86400000-(now-ud.lastClaim), h=Math.floor(tl/3600000), m=Math.floor((tl%3600000)/60000);
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0xff8c00).setTitle("⏰ Daily Already Claimed").setDescription(`Come back in **${h}h ${m}m**!\n🔥 Streak: **${ud.streak||0} days**`)],flags:64});
    }
    let userData=_state.userSpecies.get(user.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0};
    const streak=ud?(ud.streak||0)+1:1;
    _state.dailyClaims.set(user.id,{lastClaim:now,streak});
    database.saveDailyClaim(user.id,{lastClaim:now,streak});
    userData.rolls=(userData.rolls||0)+1;
    if (streak===7) userData.rolls+=1;
    _state.userSpecies.set(user.id,userData); database.saveUserSpecies(user.id,userData);
    return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x00ff00).setTitle("📅 Daily Bonus Claimed!").setDescription(`+1 species roll! 🎲\nYou now have **${userData.rolls}** rolls.\n\n🔥 **${streak} Day Streak!**${streak===7?"\n🎉 **WEEK BONUS! +1 extra roll!**":""}`)]} );
  }

  // ── PATCHNOTES ────────────────────────────────────────────────
  if (commandName === "patchnotes") {
    const latest=patchNotes[0];
    return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x0891b2).setTitle(`📋 Patch Notes — v${latest.version}`).setDescription(`**Date:** ${latest.date}\n\n${latest.changes.map(c=>`• ${c}`).join("\n")}`).setFooter({text:`v${latest.version} is the latest`})]});
  }

  // ── SPECIES ───────────────────────────────────────────────────
  if (commandName === "species") {
    const spName = options.getString("species");

    // No argument — show full ranked species list
    if (!spName) {
      const { speciesList, dragonSpecies } = require("./constants.js");
      const ranked = [
        {name:"Demi God",emoji:"⚡",chance:"0.5%",tier:"Epic"},
        {name:"Demon Lord",emoji:"🔥",chance:"1.0%",tier:"Epic"},
        {name:"Demon King",emoji:"👑😈",chance:"1.5%",tier:"Epic"},
        {name:"Dragon",emoji:"🐉",chance:"2.0%",tier:"Epic",note:"Random element"},
        {name:"Chimera",emoji:"🎭",chance:"2.2%",tier:"Rare"},
        {name:"Angel",emoji:"👼",chance:"3.0%",tier:"Rare"},
        {name:"Demon",emoji:"😈",chance:"4.0%",tier:"Rare"},
        {name:"Oni",emoji:"👿",chance:"5.0%",tier:"Uncommon"},
        {name:"Orc Lord",emoji:"👑",chance:"6.0%",tier:"Uncommon"},
        {name:"Kijin",emoji:"🎭",chance:"7.0%",tier:"Uncommon"},
        {name:"Cyborg",emoji:"🤖",chance:"7.0%",tier:"Uncommon"},
        {name:"High Orc",emoji:"⚔️",chance:"9.0%",tier:"Uncommon"},
        {name:"Ogre",emoji:"👹",chance:"12.0%",tier:"Common"},
        {name:"Goblin",emoji:"👺",chance:"18.0%",tier:"Common"},
        {name:"Orc",emoji:"🟢",chance:"22.0%",tier:"Common"},
        {name:"Half-Blood",emoji:"🩸",chance:"26.0%",tier:"Common"},
      ];
      const tierColors = {Epic:"🟣",Rare:"🔵",Uncommon:"🟡",Common:"⚪"};
      let desc = "";
      ranked.forEach((s,i) => {
        const note = s.note ? ` *(${s.note})*` : "";
        desc += `\`#${String(i+1).padStart(2,"0")}\` ${s.emoji} **${s.name}** — ${s.chance}${note}
`;
      });
      desc += `
🌑 **Reaper** — Quest unlock only
👿 **Archdemon** — Special event only
⚡🤖 **Mechangel** — Cyborg awakening only`;
      const embed = new EmbedBuilder()
        .setColor(0x0891b2)
        .setTitle("🎲 All Species — Ranked by Rarity")
        .setDescription(desc)
        .setFooter({text:"Use /species species:<name> for detailed stats on any species"});
      return safeReply(interaction,{embeds:[embed]});
    }

    // Argument provided — show detailed species card
    const sp = getSpeciesByName(spName);
    if (!sp) return safeReply(interaction,{embeds:[createErrorEmbed("Unknown species! Check `/species` for the full list.")],flags:64});
    const adv = typeAdvantages[sp.name];
    return safeReply(interaction,{embeds:[new EmbedBuilder()
      .setColor(sp.color||0x808080)
      .setTitle(`${sp.emoji} ${sp.name}`)
      .addFields(
        {name:"💪 Stats",value:`HP: **${sp.hp}**\nATK: **${sp.atkMin}–${sp.atkMax}**\nHEAL: **${sp.healMin}–${sp.healMax}**\nULT CD: **${sp.ultCooldown||"—"}**`,inline:true},
        {name:"🎲 Roll Chance",value:sp.chance||"Special unlock",inline:true},
        {name:"🟢 Passive",value:getPassiveDescription(sp.name),inline:false},
        {name:"✨ Active ULT",value:getActiveDescription(sp.name),inline:false},
        {name:"⚖️ Type Matchup",value:adv?(adv.strongAgainst?`✅ Strong vs **${adv.strongAgainst}**\n`:"")+(adv.weakAgainst?`❌ Weak vs **${adv.weakAgainst}**`:"No weaknesses"):"No type advantages",inline:false},
      )]});
  }

  // ── PROFILE ───────────────────────────────────────────────────
  if (commandName === "profile") {
    const target=options.getUser("user")||user;
    const targetMember=await guild.members.fetch(target.id).catch(()=>null);
    if (target.bot) {
      if (target.id===_client.user.id) {
        return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(botSpecies.kitsune.color).setTitle(`👤 ${target.displayName}'s Profile`).setThumbnail(target.displayAvatarURL())
          .addFields(
            {name:"🧬 Species",value:"🦊 **Kitsune**",inline:true},{name:"❤️ HP",value:"1,000,000",inline:true},{name:"⚔️ Attack",value:"500-1,000",inline:true},
            {name:"💚 Heal",value:"200,000-500,000",inline:true},{name:"🎲 Rolls",value:"∞",inline:true},{name:"💣 Bomb Tag Wins",value:"∞",inline:true},
            {name:"🏅 Badges",value:"└ 💪 Omnipotent\n└ 🐛 Bug Creator",inline:false},
            {name:"✨ Passive",value:botSpecies.kitsune.passive,inline:false},{name:"⚡ Active",value:botSpecies.kitsune.active,inline:false},
            {name:"📊 Total Users",value:`${_state.userSpecies.size}`,inline:true},
            {name:"⏱️ Uptime",value:`<t:${Math.floor(Date.now()/1000-process.uptime())}:R>`,inline:true},
          ).setFooter({text:"Made by God"})]});
      }
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(botSpecies.bot.color).setTitle(`👤 ${target.displayName}'s Profile`).setThumbnail(target.displayAvatarURL())
        .addFields({name:"🧬 Species",value:"🤖 **Bot**",inline:true},{name:"❤️ HP",value:`${botSpecies.bot.hp}`,inline:true},{name:"⚔️ Attack",value:`${botSpecies.bot.atkMin}-${botSpecies.bot.atkMax}`,inline:true},{name:"✨ Passive",value:botSpecies.bot.passive,inline:false},{name:"⚡ Active",value:botSpecies.bot.active,inline:false})]});
    }
    const td=_state.userSpecies.get(target.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,badges:[]};
    const fd=_state.fightStats.get(target.id)||{wins:0,losses:0,streak:0};
    const bd=_state.leaderboard.get(target.id)||{wins:0};
    const sp=td.species||humanSpecies;
    const wr=fd.wins+fd.losses>0?((fd.wins/(fd.wins+fd.losses))*100).toFixed(1):"0.0";
    const embed=new EmbedBuilder().setColor(sp.color||0x9b59b6).setTitle(`👤 ${target.displayName}'s Profile`).setThumbnail(target.displayAvatarURL())
      .addFields(
        {name:"🧬 Species",value:`${sp.emoji} **${sp.name}**`,inline:true},
        {name:"🎲 Rolls",value:`${td.rolls||0}`,inline:true},
        {name:"⚔️ Fight Record",value:`${fd.wins}W - ${fd.losses}L (${wr}%)`,inline:true},
        {name:"💣 Bomb Tag Wins",value:`${bd.wins}`,inline:true},
        {name:"🔥 Streak",value:`${fd.streak||0} wins`,inline:true},
        {name:"🔘 Requests",value:td.requestsEnabled?"✅ Enabled":"❌ Disabled",inline:true},
      );
    const badges=[];
    if (td.badges?.includes("OG 50")) badges.push("└ 🎉 OG 50");
    if (target.id==="926063716057894953") { badges.push("└ 👑 Founder"); badges.push("└ ✨ The Creator"); }
    if (target.id==="1376978115171192922") { badges.push("└ 🤝 Co-Founder"); badges.push("└ 🧪 OG Tester"); badges.push("└ ⭐ Shion's Favourite"); }
    if (badges.length) embed.addFields({name:"🏅 Badges",value:badges.join("\n"),inline:false});
    embed.addFields(
      {name:"🟢 Passive",value:getPassiveDescription(sp.name),inline:false},
      {name:"✨ Active ULT",value:getActiveDescription(sp.name),inline:false},
      {name:"📅 Joined",value:`<t:${Math.floor((targetMember?.joinedTimestamp||Date.now())/1000)}:R>`,inline:true},
    ).setFooter({text:"Use /species-roll to reroll | /daily for free rolls"});
    return safeReply(interaction,{embeds:[embed]});
  }

  // ── SPECIES-ROLL ──────────────────────────────────────────────
  if (commandName === "species-roll") {
    let userData=_state.userSpecies.get(user.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0,badges:[]};
    if ((userData.rolls||0)<1) return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0xff0000).setTitle("❌ No Rolls Left").setDescription("Use `/daily` for a free roll, or win fights for a 30% chance!")],flags:64});
    const rollResult=getRandomSpecies();
    let newSpecies;
    if (rollResult.isDragon) {
      newSpecies=getDragonSubtype();
    } else { newSpecies=rollResult; }
    userData.species=newSpecies; userData.originalSpecies=newSpecies; userData.rolls=(userData.rolls||0)-1;
    _state.userSpecies.set(user.id,userData); await database.saveUserSpecies(user.id,userData);
    const member=await guild.members.fetch(user.id); await assignSpeciesRole(member,newSpecies);
    const isSame = userData.species?.name===newSpecies.name;
    const rollEmbed=new EmbedBuilder().setColor(newSpecies.color||0x808080)
      .setTitle(`${newSpecies.emoji} ${isSame?"Same species — bad luck!":"New species rolled!"}`)
      .setDescription(`**${user.displayName}** rolled ${newSpecies.emoji} **${newSpecies.name}**!\n\nChance: **${newSpecies.chance||"?"}** | HP: ${newSpecies.hp} | ATK: ${newSpecies.atkMin}–${newSpecies.atkMax} | HEAL: ${newSpecies.healMin}–${newSpecies.healMax}\n\n🎲 Rolls remaining: **${userData.rolls}**`);
    if (userData.rolls>0) {
      const row=new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`reroll_${user.id}`).setLabel("🔄 Reroll").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`cancel_${user.id}`).setLabel("❌ Stop rolling").setStyle(ButtonStyle.Danger));
      _state.activeRolls.set(user.id,{timestamp:Date.now()});
      await safeReply(interaction,{embeds:[rollEmbed],components:[row],flags:64});
    } else {
      await safeReply(interaction,{embeds:[rollEmbed.setFooter({text:"No rolls remaining. Use /daily for a free roll!"})],flags:64});
    }
    return;
  }

  // ── AWAKENING ─────────────────────────────────────────────────
  if (commandName === "awakening") {
    const { awakeningRequirements } = require("./constants.js");
    const userData=_state.userSpecies.get(user.id);
    if (!userData) return safeReply(interaction,{embeds:[createErrorEmbed("No species yet!")],flags:64});
    if (!userData.awakening) userData.awakening={};
    if (!userData.awakening.cyborg) userData.awakening.cyborg={wins:0,damageDealt:0,ultUses:0,awakened:false};
    if (userData.species.name!=="Cyborg") {
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x00ffff).setTitle("⚡ AWAKENING CHAMBER").setDescription("*You enter the chamber...*\n\n❌ No compatible cybernetic lifeform detected.\n❌ Requires a Cyborg host.\n\n*The screens power down.*").setFooter({text:"Only Cyborg can awaken to Mechangel"})],flags:64});
    }
    const prog=userData.awakening.cyborg, req=awakeningRequirements.cyborg;
    const wPct=Math.min(Math.floor((prog.wins/req.wins)*100),100);
    const dPct=Math.min(Math.floor((prog.damageDealt/req.damageDealt)*100),100);
    const uPct=Math.min(Math.floor((prog.ultUses/req.ultUses)*100),100);
    const bar=(p)=>{ const f=Math.floor(p/10); return "█".repeat(f)+"░".repeat(10-f); };
    const ready=prog.wins>=req.wins&&prog.damageDealt>=req.damageDealt&&prog.ultUses>=req.ultUses&&!prog.awakened;
    if (ready) {
      const embed=new EmbedBuilder().setColor(0x00ffff).setTitle("⚡ AWAKENING PROTOCOL - READY ⚡").setDescription(
        "`[████████████████░░] 90% - SYSTEM INTEGRATION COMPLETE`\n\n*Your cybernetic systems glow with ethereal light...*\n\n**» AWAKENING REQUIREMENTS MET «**\n"+
        "├ Neural Interface: ██████████ 100%\n├ Power Core: ██████████ 100%\n└ Angelic Matrix: ██████████ 100%\n\n"+
        "**Your Cyborg is ready to transcend to ⚡ Mechangel!**\n\nUpon awakening:\n├ +15 HP (140 total)\n├ +3-4 Attack (15-23)\n├ +2-4 Heal (10-18)\n"+
        "├ New Passive: Quantum Processing — every 2 attacks = 1.4×\n└ New ULT: System Restoration — heal 40% + 20% reduction 2 turns\n\n🎁 **Reward:** +5 Species Rolls");
      const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("awaken_cyborg").setLabel("⚡ INITIATE AWAKENING").setStyle(ButtonStyle.Success));
      return safeReply(interaction,{embeds:[embed],components:[row],flags:64});
    } else if (prog.awakened) {
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x00ffff).setTitle("⚡ MECHANGEL - AWAKENED ⚡").setDescription("`[██████████████████] 100% - DIVINE MACHINE ACTIVE`\n\n*Your form has already transcended.*\n\n**» CURRENT STATUS «**\n├ Form: ⚡ Mechangel\n└ Status: Fully Awakened\n\n*The machine spirit recognizes its ascended master.*").setFooter({text:"You have achieved your final form"})],flags:64});
    } else {
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x00ffff).setTitle("⚡ CYBORG AWAKENING PROTOCOL").setDescription(
        "`[SYSTEM BOOTING...]`\n\n**» AWAKENING REQUIREMENTS «**\n\n"+
        `⚔️ **Combat Data:** ${prog.wins}/${req.wins} wins\n└ ${bar(wPct)} ${wPct}%\n\n`+
        `💥 **Damage Output:** ${prog.damageDealt.toLocaleString()}/${req.damageDealt.toLocaleString()} damage\n└ ${bar(dPct)} ${dPct}%\n\n`+
        `⚡ **ULT Sync:** ${prog.ultUses}/${req.ultUses} ULT uses\n└ ${bar(uPct)} ${uPct}%\n\n`+
        "*Continue fighting to complete the awakening.*").setFooter({text:"25 wins • 500 damage • 15 ULTs required"})],flags:64});
    }
  }

  // ── FIGHT ─────────────────────────────────────────────────────
  if (commandName === "fight") {
    const target=options.getUser("user");
    if (target.id===user.id) return safeReply(interaction,{embeds:[createErrorEmbed("You cannot fight yourself!")],flags:64});
    if (target.bot) return safeReply(interaction,{embeds:[createErrorEmbed("Use `/fightbot` to fight bots!")],flags:64});
    if (!canFight(user.id)) { const cd=_state.fightCooldowns.get(user.id); return safeReply(interaction,{embeds:[createErrorEmbed(cd&&cd>Date.now()?`Wait **${((cd-Date.now())/1000).toFixed(1)}s**!`:"Already in a game!")],flags:64}); }
    if (!canFight(target.id)) return safeReply(interaction,{embeds:[createErrorEmbed("That user is already in a fight!")],flags:64});
    const cd=_state.userSpecies.get(user.id), od=_state.userSpecies.get(target.id);
    if (!cd?.species||cd.species.name==="Human") return safeReply(interaction,{embeds:[createErrorEmbed("You need a species! Use `/species-roll` first.")],flags:64});
    if (!od?.species||od.species.name==="Human") return safeReply(interaction,{embeds:[createErrorEmbed(`<@${target.id}> needs a species first!`)],flags:64});
    const rc=canSendRequest(user.id,target.id,user.id===_state.ownerId);
    if (!rc.allowed) return safeReply(interaction,{embeds:[createErrorEmbed(rc.reason)],flags:64});
    const challengeId=`${user.id}-${target.id}`;
    if (_state.fightChallenges.has(challengeId)) return safeReply(interaction,{embeds:[createErrorEmbed("A challenge already exists!")],flags:64});
    const row=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`fight_accept_${user.id}_${target.id}`).setLabel("✅ Accept").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`fight_reject_${user.id}_${target.id}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger));
    const embed=new EmbedBuilder().setColor(0xff4500).setTitle("⚔️ Fight Challenge!").setDescription(`${cd.species.emoji} **${cd.species.name}** <@${user.id}>\nvs\n${od.species.emoji} **${od.species.name}** <@${target.id}>\n\n<@${target.id}>, do you accept?`);
    await safeReply(interaction,{embeds:[embed],components:[row]});
    const msg=await interaction.fetchReply();
    _state.activeRequests.set(user.id,{type:"fight",targetId:target.id,timestamp:Date.now()});
    _state.activeRequests.set(target.id,{type:"fight",targetId:user.id,timestamp:Date.now()});
    _state.fightChallenges.set(challengeId,{challengerId:user.id,opponentId:target.id,messageId:msg.id,channelId:channel.id,timestamp:Date.now()});
    setTimeout(()=>{ if(_state.fightChallenges.has(challengeId)){ _state.fightChallenges.delete(challengeId); _state.activeRequests.delete(user.id); _state.activeRequests.delete(target.id); msg.edit({embeds:[new EmbedBuilder().setColor(0x808080).setDescription("⏰ Challenge expired.")],components:[]}).catch(()=>{}); } },60000);
    return;
  }

  // ── FIGHTBOT ──────────────────────────────────────────────────
  if (commandName === "fightbot") {
    const difficulty=options.getString("difficulty");
    if (isPlayerInFight(user.id)||_state.activeBotFights.has(user.id)) return safeReply(interaction,{embeds:[createErrorEmbed("Already in a fight!")],flags:64});
    const playerData=_state.userSpecies.get(user.id);
    if (!playerData?.species||playerData.species.name==="Human") return safeReply(interaction,{embeds:[createErrorEmbed("You need a species! Use `/species-roll` first.")],flags:64});
    const bsName=botSpeciesByDifficulty[difficulty][Math.floor(Math.random()*botSpeciesByDifficulty[difficulty].length)];
    const bSpecies=getSpeciesByName(bsName), personality=botPersonalities[difficulty];
    const fightId=`bot-${user.id}-${Date.now()}`;
    const fight={
      fightId, playerId:user.id, playerSpecies:playerData.species,
      playerHp:playerData.species.hp, playerMaxHp:playerData.species.hp,
      playerHealCooldown:0, playerUltCooldown:0, playerUltBuff:null,
      playerAdaptiveStacks:0, playerAttackCounter:0, playerBurn:0, playerBurnRounds:0,
      playerCurse:0, playerBlockHeal:false, playerPossession:false, playerStunnedTurns:0, playerLastUltUsed:null,
      botSpecies:bSpecies, botHp:bSpecies.hp, botMaxHp:bSpecies.hp,
      botHealCooldown:0, botUltCooldown:0, botUltBuff:null, botAdaptiveStacks:0, botAttackCounter:0,
      botBurn:0, botBurnRounds:0, botCurse:0, botBlockHeal:false, botStunnedTurns:0, botLastUltUsed:null,
      round:1, difficulty, botPersonality:personality, timeout:null, log:[],
    };
    _state.activeBotFights.set(fightId,fight); _state.activeBotFights.set(user.id,fightId);
    const embed=buildBotFightEmbed(fight,["⚔️ Fight started! Your turn!"],"playing");
    const row=buildBotFightRow(fightId,fight);
    const msg=await channel.send({embeds:[embed],components:[row]});
    _state.fightMessages.set(fightId,msg);
    fight.timeout=setTimeout(()=>{ if(_state.activeBotFights.has(fightId)) endBotFight(channel,fightId,"bot","player",difficulty); },120000);
    return safeReply(interaction,{embeds:[createSuccessEmbed("Fight started!")],flags:64});
  }

  // ── SWITCH ────────────────────────────────────────────────────
  if (commandName === "switch") {
    await interaction.deferReply({flags:64});
    const userData=_state.userSpecies.get(user.id);
    if (!userData) return interaction.editReply({embeds:[createErrorEmbed("No species yet! Use `/species-roll` first.")]});
    const now=Date.now(), threeH=3*60*60*1000;
    if (user.id!==_state.ownerId&&user.id!==_state.secondGodId&&userData.lastSwitch&&now-userData.lastSwitch<threeH) {
      const tl=threeH-(now-userData.lastSwitch), h=Math.floor(tl/3600000), m=Math.floor((tl%3600000)/60000);
      return interaction.editReply({embeds:[createErrorEmbed(`Switch available in **${h}h ${m}m**!`)]});
    }
    const row=new ActionRowBuilder();
    row.addComponents(new ButtonBuilder().setCustomId("switch_current").setLabel(`✅ ${userData.species.name} (Current)`).setStyle(ButtonStyle.Success).setDisabled(true));
    if (userData.originalSpecies?.name!==userData.species.name) row.addComponents(new ButtonBuilder().setCustomId("switch_original").setLabel(userData.originalSpecies.name).setStyle(ButtonStyle.Primary));
    if (userData.questSpecies?.reaper?.unlocked&&userData.species.name!=="Reaper") row.addComponents(new ButtonBuilder().setCustomId("switch_reaper").setLabel("🌑 Reaper").setStyle(ButtonStyle.Primary));
    if (userData.questSpecies?.archdemon?.unlocked&&userData.species.name!=="Archdemon") row.addComponents(new ButtonBuilder().setCustomId("switch_archdemon").setLabel("👿 Archdemon").setStyle(ButtonStyle.Danger));
    const embed=new EmbedBuilder().setColor(0x9b59b6).setTitle("🔄 Class Switch")
      .setDescription(`**Current:** ${userData.species.emoji} ${userData.species.name}\n**Original:** ${userData.originalSpecies?.emoji||"👤"} ${userData.originalSpecies?.name||"Human"}\n🌑 Reaper: ${userData.questSpecies?.reaper?.unlocked?"✅ Unlocked":"❌ Locked"}\n👿 Archdemon: ${userData.questSpecies?.archdemon?.unlocked?"✅ Unlocked":"❌ Locked"}\n\n⏰ Cooldown: 3 hours`);
    return interaction.editReply({embeds:[embed],components:[row]});
  }

  // ── FIGHTSTATS ────────────────────────────────────────────────
  if (commandName === "fightstats") {
    const target=options.getUser("user")||user;
    const stats=_state.fightStats.get(target.id);
    const sp=_state.userSpecies.get(target.id)?.species||humanSpecies;
    if (!stats||(stats.wins===0&&stats.losses===0)) return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x808080).setDescription(`📊 **${target.displayName}** hasn't fought yet!`)]});
    const wr=((stats.wins/(stats.wins+stats.losses))*100).toFixed(1);
    return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(sp.color||0xff4500).setTitle(`⚔️ ${target.displayName}'s Fight Stats`).setThumbnail(target.displayAvatarURL())
      .addFields({name:"🏆 Wins",value:`${stats.wins}`,inline:true},{name:"💔 Losses",value:`${stats.losses}`,inline:true},{name:"📊 Win Rate",value:`${wr}%`,inline:true},{name:"🔥 Streak",value:`${stats.streak||0} wins`,inline:true},{name:"🧬 Species",value:`${sp.emoji} ${sp.name}`,inline:true})]});
  }

  // ── HISTORY ───────────────────────────────────────────────────
  if (commandName === "history") {
    const target=options.getUser("user")||user;
    const stats=_state.fightStats.get(target.id);
    if (!stats?.history?.length) return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x808080).setDescription(`📜 **${target.displayName}** has no fight history!`)]});
    const tf=stats.wins+stats.losses, wr=tf>0?((stats.wins/tf)*100).toFixed(1):"0.0";
    const embed=new EmbedBuilder().setColor(0x9b59b6).setTitle(`📜 ${target.displayName}'s History`).setDescription(`Fights: **${tf}** | W: **${stats.wins}** | L: **${stats.losses}** | WR: **${wr}%**`).setThumbnail(target.displayAvatarURL());
    let txt="";
    for (let i=0;i<Math.min(stats.history.length,10);i++) {
      const f=stats.history[i], da=Math.floor((Date.now()-f.date)/86400000);
      const ta=da===0?"today":da===1?"yesterday":`${da}d ago`;
      txt+=`${f.won?"✅":"❌"} vs ${f.opponentSpecies?.emoji||"👤"} **${f.opponentName}** ${ta} — HP left: ${f.hpLeft}${f.special?` ${f.special}`:""}\n`;
    }
    embed.addFields({name:`Last ${Math.min(stats.history.length,10)} Fights`,value:txt});
    return safeReply(interaction,{embeds:[embed]});
  }

  // ── LB ────────────────────────────────────────────────────────
  if (commandName === "lb") {
    await interaction.deferReply();
    if (_state.leaderboard.size===0) return interaction.editReply({embeds:[new EmbedBuilder().setColor(0xffd700).setDescription("📊 No stats yet!")]});
    const sorted=Array.from(_state.leaderboard.entries()).sort((a,b)=>b[1].wins-a[1].wins).slice(0,10);
    let desc="";
    for (let i=0;i<sorted.length;i++) {
      const [uid,s]=sorted[i], m=await guild.members.fetch(uid).catch(()=>null), nm=m?m.displayName:"Unknown";
      const sp=_state.userSpecies.get(uid)?.species, medal=i===0?"🥇":i===1?"🥈":i===2?"🥉":"🎖️";
      desc+=`${medal} ${sp?.emoji||"👤"} **${nm}** — ${s.wins} wins\n`;
    }
    return interaction.editReply({embeds:[new EmbedBuilder().setColor(0xffd700).setTitle("🏆 Bomb Tag Leaderboard").setDescription(desc)]});
  }

  // ── FIGHTS ────────────────────────────────────────────────────
  if (commandName === "fights") {
    await interaction.deferReply();
    if (_state.fightLeaderboard.size===0) return interaction.editReply({embeds:[new EmbedBuilder().setColor(0xff4500).setDescription("⚔️ No fight stats yet!")]});
    const sorted=Array.from(_state.fightLeaderboard.entries()).sort((a,b)=>b[1].wins-a[1].wins).slice(0,10);
    let desc="";
    for (let i=0;i<sorted.length;i++) {
      const [uid,s]=sorted[i], m=await guild.members.fetch(uid).catch(()=>null), nm=m?m.displayName:"Unknown";
      const sp=_state.userSpecies.get(uid)?.species, medal=i===0?"🥇":i===1?"🥈":i===2?"🥉":"🎖️";
      desc+=`${medal} ${sp?.emoji||"⚔️"} **${nm}** — ${s.wins} wins\n`;
    }
    return interaction.editReply({embeds:[new EmbedBuilder().setColor(0xff4500).setTitle("⚔️ Fight Leaderboard").setDescription(desc)]});
  }

  // ── BOTSTATS ──────────────────────────────────────────────────
  if (commandName === "botstats") {
    const target=options.getUser("user")||user;
    const stats=_state.botStats.get(target.id);
    if (!stats) return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x808080).setDescription(`📊 **${target.displayName}** hasn't fought any bots!`)]});
    return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x9b59b6).setTitle(`🤖 ${target.displayName}'s Bot Stats`)
      .addFields(
        {name:"🧸 Easy",    value:`W:${stats.easy?.wins||0} L:${stats.easy?.losses||0}`,    inline:true},
        {name:"⚔️ Medium",  value:`W:${stats.medium?.wins||0} L:${stats.medium?.losses||0}`,inline:true},
        {name:"👹 Hard",    value:`W:${stats.hard?.wins||0} L:${stats.hard?.losses||0}`,    inline:true},
        {name:"💀 Impossible",value:`W:${stats.impossible?.wins||0} L:${stats.impossible?.losses||0}`,inline:true})]});
  }

  // ── QUEST ─────────────────────────────────────────────────────
  if (commandName === "quest") {
    const sub=options.getSubcommand();
    if (sub==="view") {
      const target=options.getUser("user")||user;
      const qd=_state.questProgress.get(target.id)||{};
      const r=qd.reaper||{easyBots:0,mediumBots:0,hardBots:0,impossibleBots:0,playerFights:0,completed:false,claimed:false};
      const bar=(c,m)=>{ const f=Math.round((c/m)*10); return "█".repeat(f)+"░".repeat(10-f)+` ${c}/${m}`; };
      const embed=new EmbedBuilder().setColor(0x9b59b6).setTitle(`📋 Quests — ${target.displayName}`).setDescription("Complete quests to unlock exclusive species!");
      const rs=r.claimed?"✅ CLAIMED":r.completed?"🎁 CLAIM READY":"🔄 In Progress";
      embed.addFields({name:`🌑 Reaper Quest — ${rs}`,value:r.completed&&r.claimed?"Reaper unlocked! Use `/switch`!":r.completed?"Use `/quest claim quest:reaper` to claim!":
        `🧸 Easy Bots: ${bar(r.easyBots,35)}\n⚔️ Medium Bots: ${bar(r.mediumBots,25)}\n👹 Hard Bots: ${bar(r.hardBots,15)}\n💀 Impossible: ${bar(r.impossibleBots,5)}\n👤 Player Fights: ${bar(r.playerFights,15)}`,inline:false});
      return safeReply(interaction,{embeds:[embed]});
    }
    if (sub==="claim") {
      const qn=options.getString("quest");
      if (qn==="reaper") {
        const qd=_state.questProgress.get(user.id)||{};
        const r=qd.reaper||{easyBots:0,mediumBots:0,hardBots:0,impossibleBots:0,playerFights:0,completed:false,claimed:false};
        if (r.claimed) return safeReply(interaction,{embeds:[createErrorEmbed("Already claimed! Use `/switch` to equip.")],flags:64});
        if (!r.completed) return safeReply(interaction,{embeds:[createErrorEmbed("Quest not complete yet! Check `/quest view`.")],flags:64});
        r.claimed=true; qd.reaper=r; _state.questProgress.set(user.id,qd); database.saveQuestProgress(user.id,"reaper",r);
        const ud=_state.userSpecies.get(user.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0};
        if (!ud.questSpecies) ud.questSpecies={};
        ud.questSpecies.reaper={unlocked:true,equipped:false};
        _state.userSpecies.set(user.id,ud); database.saveUserSpecies(user.id,ud);
        return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x2f4f4f).setTitle("🌑 Reaper Unlocked!").setDescription("Use `/switch` to equip Reaper!")]});
      }
    }
  }

  // ── TOGGLEREQUESTS ────────────────────────────────────────────
  if (commandName === "togglerequests") {
    const status=options.getString("status");
    const ud=_state.userSpecies.get(user.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0};
    ud.requestsEnabled=(status==="enable"); _state.userSpecies.set(user.id,ud); database.saveUserSpecies(user.id,ud);
    return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(ud.requestsEnabled?0x00ff00:0xff0000).setDescription(ud.requestsEnabled?"✅ You will now receive challenges!":"❌ You will NOT receive challenges.")],flags:64});
  }

  // ── BOMBTAG1V1 ────────────────────────────────────────────────
  if (commandName === "bombtag1v1") {
    const gdc=_state.duelChannels.get(guild.id);
    if (!gdc) return safeReply(interaction,{embeds:[createErrorEmbed("No duel channel set! God must use `/god setduel` first.")],flags:64});
    if (channel.id!==gdc) return safeReply(interaction,{embeds:[createErrorEmbed(`Go to <#${gdc}> to challenge someone.`)],flags:64});
    const target=options.getUser("user");
    if (target.id===user.id) return safeReply(interaction,{embeds:[createErrorEmbed("Can't challenge yourself!")],flags:64});
    if (target.bot) return safeReply(interaction,{embeds:[createErrorEmbed("Use `/bombtag1v1bot` to challenge a bot!")],flags:64});
    if (isPlayerInGame(user.id)) return safeReply(interaction,{embeds:[createErrorEmbed("Already in a game!")],flags:64});
    if (isPlayerInGame(target.id)) return safeReply(interaction,{embeds:[createErrorEmbed("That user is already in a game!")],flags:64});
    const rc=canSendRequest(user.id,target.id,user.id===_state.ownerId);
    if (!rc.allowed) return safeReply(interaction,{embeds:[createErrorEmbed(rc.reason)],flags:64});
    const cid=`${user.id}-${target.id}`;
    if (_state.challenges.has(cid)) return safeReply(interaction,{embeds:[createErrorEmbed("A challenge already exists!")],flags:64});
    const row=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("accept_duel").setLabel("✅ Accept").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("decline_duel").setLabel("🏃 Run Away").setStyle(ButtonStyle.Danger));
    await safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x9b59b6).setTitle("💣 Bomb Tag Challenge!").setDescription(`<@${user.id}> challenged <@${target.id}> to Bomb Tag!\nFirst to **3 rounds** wins!\n\n<@${target.id}>, do you accept?`)],components:[row]});
    const msg=await interaction.fetchReply();
    _state.activeRequests.set(user.id,{type:"bombtag",targetId:target.id,timestamp:Date.now()});
    _state.activeRequests.set(target.id,{type:"bombtag",targetId:user.id,timestamp:Date.now()});
    _state.challenges.set(cid,{challengerId:user.id,opponentId:target.id,messageId:msg.id,channelId:channel.id,timestamp:Date.now()});
    setTimeout(()=>{ if(_state.challenges.has(cid)){ _state.challenges.delete(cid); _state.activeRequests.delete(user.id); _state.activeRequests.delete(target.id); msg.edit({embeds:[new EmbedBuilder().setColor(0x808080).setDescription("⏰ Challenge expired.")],components:[]}).catch(()=>{}); } },60000);
    return;
  }

  // ── BOMBTAG1V1BOT ─────────────────────────────────────────────
  if (commandName === "bombtag1v1bot") {
    const gdc=_state.duelChannels.get(guild.id);
    if (!gdc) return safeReply(interaction,{embeds:[createErrorEmbed("No duel channel set!")],flags:64});
    if (channel.id!==gdc) return safeReply(interaction,{embeds:[createErrorEmbed(`Go to <#${gdc}> first.`)],flags:64});
    const row=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("bot_easy").setLabel("🧸 Easy").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("bot_medium").setLabel("⚔️ Medium").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("bot_hard").setLabel("👹 Hard").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("bot_impossible").setLabel("💀 Impossible").setStyle(ButtonStyle.Danger));
    return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0x9b59b6).setTitle("🤖 Challenge the Bot!").setDescription("Choose your difficulty:")
      .addFields({name:"🧸 Easy",value:"50% fail · 2s delay",inline:true},{name:"⚔️ Medium",value:"35% fail · 1.5s delay",inline:true},{name:"👹 Hard",value:"20% fail · 1s delay",inline:true},{name:"💀 Impossible",value:"5% fail · 0.5s delay",inline:true})],components:[row]});
  }

  // ── GAME ──────────────────────────────────────────────────────
  if (commandName === "game") {
    const action=options.getString("action");
    if (!_state.bombGames.has(channel.id)) return safeReply(interaction,{embeds:[createErrorEmbed("No game in this channel!")],flags:64});
    const game=_state.bombGames.get(channel.id);
    if (user.id!==game.hostId) return safeReply(interaction,{embeds:[createErrorEmbed("Only the host can do that!")],flags:64});
    if (action==="start") {
      if (game.status!=="waiting") return safeReply(interaction,{embeds:[createErrorEmbed("Game already started!")],flags:64});
      if (game.players.size<2) return safeReply(interaction,{embeds:[createErrorEmbed("Need at least 2 players!")],flags:64});
      clearTimeout(game.startTimeout); startBombGame(channel,game,"normal");
      return safeReply(interaction,{embeds:[createSuccessEmbed("Game starting!")],flags:64});
    }
    if (action==="cancel"||action==="end") {
      clearTimeout(game.startTimeout); if(game.bombTimer) clearTimeout(game.bombTimer);
      _state.bombGames.delete(channel.id); await channel.send("❌ Game ended by host.");
      return safeReply(interaction,{embeds:[createSuccessEmbed("Game ended!")],flags:64});
    }
  }

  // ── GOD COMMANDS ──────────────────────────────────────────────
  if (commandName === "god") {
    if (user.id!==_state.ownerId&&user.id!==_state.secondGodId) return safeReply(interaction,{embeds:[createErrorEmbed("Only God can use this!")],flags:64});
    const sub=options.getSubcommand();

    if (sub==="menu") {
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0xffd700).setTitle("👑 God Commands")
        .addFields(
          {name:"💀 Divine Powers",value:"`/god nuke @user` `/god rev @user` `/god species-change @user <species>` `/god species-reset @user` `/god rolls-reset @user` `/god quest-reset @user <quest>`",inline:false},
          {name:"💣 Bomb Tag",value:"`/god bombtag` — normal game\n`/god bombtag1` — locked game\n`/god setduel #channel` — set duel channel\n`/god listduels` — list saved channels",inline:false},
          {name:"🎲 Species",value:"`/god species-add @user <1-500>` — give rolls\n`/god debug-db` — check database",inline:false}
        ).setFooter({text:"Use /god menu to see this again"})]});
    }

    if (sub==="nuke") {
      const target=options.getUser("user");
      const targetMember=await guild.members.fetch(target.id).catch(()=>null);
      if (!targetMember) return safeReply(interaction,{embeds:[createErrorEmbed("That user is not in this server!")],flags:64});
      if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ModerateMembers))
        return safeReply(interaction,{embeds:[createErrorEmbed('I need "Timeout Members" permission!')],flags:64});
      await safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0xff0000).setDescription(`💣 **NUKE LAUNCHED** targeting ${target}!`)],flags:64});
      const secretNumber=Math.floor(Math.random()*20)+1;
      let hp=4, guessedNumbers=[];
      const startTime=Date.now();
      const getHearts=(n)=>{ let d=""; for(let i=0;i<4;i++) d+=i<n?"❤️":"💔"; return d; };
      await channel.send(`💣 **NUKE LAUNCHED**\n<@${target.id}> you've been targeted!\n**HP:** ${getHearts(hp)}\n⏰ **20 seconds** to guess a number between **1-20**\n💬 Each wrong guess costs 1 HP and gives a hint!`);
      _state.activeNukes.set(target.id,{channelId:channel.id,secretNumber,executorId:user.id,safe:false,hp,startTime,targetMember,executorTag:user.tag});
      const timeout=setTimeout(async()=>{
        const nd=_state.activeNukes.get(target.id);
        if (nd&&!nd.safe) {
          try { await targetMember.timeout(120000,"Nuked by "+user.tag); await channel.send(`💥 **BOOM!**\n<@${target.id}> got nuked by <@${user.id}>! 💀\nThe number was **${secretNumber}**`); _state.activeNukes.delete(target.id); } catch(e) {}
        }
      },20000);
      const collector=channel.createMessageCollector({filter:m=>m.author.id===target.id,time:20000,max:20});
      collector.on("collect",async(guessMsg)=>{
        try {
          const nd=_state.activeNukes.get(target.id); if(!nd||nd.safe) return;
          const guess=parseInt(guessMsg.content);
          if (isNaN(guess)||guess<1||guess>20) { await guessMsg.reply("❌ Guess a number between 1-20!"); return; }
          if (guessedNumbers.includes(guess)) { await guessMsg.reply(`❌ Already guessed ${guess}!`); return; }
          guessedNumbers.push(guess);
          if (guess===nd.secretNumber) {
            nd.safe=true; clearTimeout(timeout);
            await channel.send(`🎉 **MIRACLE!** <@${target.id}> guessed **${secretNumber}**! Safe... for now...`);
            _state.activeNukes.delete(target.id); collector.stop("safe");
          } else {
            nd.hp--; hp=nd.hp;
            const hint=guess<secretNumber?"📈 **Higher!**":"📉 **Lower!**";
            if (hp<=0) { clearTimeout(timeout); try { await targetMember.timeout(120000,"Nuked"); await channel.send(`💥 **BOOM!** <@${target.id}> ran out of HP! The number was **${secretNumber}**`); _state.activeNukes.delete(target.id); collector.stop("dead"); } catch(e){} }
            else { await guessMsg.reply(`❌ Wrong! ${hint}\n**HP:** ${getHearts(hp)}\nGuessed: ${guessedNumbers.join(", ")}`); }
          }
        } catch(e) {}
      });
      return;
    }

    if (sub==="rev") {
      const target=options.getUser("user");
      if (target.id===user.id) return safeReply(interaction,{embeds:[createErrorEmbed("Can't reverse yourself!")],flags:64});
      if (target.bot) return safeReply(interaction,{embeds:[createErrorEmbed("Can't reverse a bot!")],flags:64});
      if (_state.reversedUsers.has(target.id)) return safeReply(interaction,{embeds:[createErrorEmbed(`<@${target.id}> is already reversed!`)],flags:64});
      _state.reversedUsers.set(target.id,{channelId:channel.id,messagesLeft:3,executorId:user.id});
      await safeReply(interaction,{embeds:[createSuccessEmbed(`<@${target.id}>'s next 3 messages will be reversed!`)]});
      setTimeout(()=>{ if(_state.reversedUsers.has(target.id)) { _state.reversedUsers.delete(target.id); channel.send(`⌛ <@${target.id}>'s reverse has expired.`).catch(()=>{}); } },300000);
      return;
    }

    if (sub==="bombtag") {
      if (_state.bombGames.has(channel.id)) return safeReply(interaction,{embeds:[createErrorEmbed("A game is already in progress!")],flags:64});
      await safeReply(interaction,{embeds:[createSuccessEmbed("Bomb tag lobby created!")],flags:64});
      const joinMsg=await channel.send(`🧨 **BOMB TAG GAME** 🧨\n\nReact with 🎉 to join!\n⏰ Game starts in **2 minutes** or host types \`/game start\`\n\n**Players:** None yet`);
      await joinMsg.react("🎉");
      const gameData={channelId:channel.id,hostId:user.id,joinMessageId:joinMsg.id,players:new Set(),status:"waiting",currentBombHolder:null,eliminated:[],bombEndTime:null,bombTimer:null,passCollector:null,startTimeout:null,roundActive:false,gameType:"normal",judgeUsed:false,reviveUsed:false};
      _state.bombGames.set(channel.id,gameData);
      gameData.startTimeout=setTimeout(()=>{ const g=_state.bombGames.get(channel.id); if(g&&g.status==="waiting") startBombGame(channel,g,"normal"); },120000);
      const rc=joinMsg.createReactionCollector({filter:(rxn,u)=>rxn.emoji.name==="🎉"&&!u.bot&&rxn.message.id===joinMsg.id,dispose:true});
      rc.on("collect",(rxn,u)=>{ const g=_state.bombGames.get(channel.id); if(g&&g.status==="waiting"){g.players.add(u.id); joinMsg.edit(joinMsg.content.replace("None yet",Array.from(g.players).map(id=>`<@${id}>`).join("\n"))).catch(()=>{}); } });
      rc.on("remove",(rxn,u)=>{ const g=_state.bombGames.get(channel.id); if(g&&g.status==="waiting"){g.players.delete(u.id);} });
      return;
    }

    if (sub==="bombtag1") {
      if (_state.bombGames.has(channel.id)) return safeReply(interaction,{embeds:[createErrorEmbed("A game is already in progress!")],flags:64});
      await safeReply(interaction,{embeds:[createSuccessEmbed("Locked bomb tag lobby created!")],flags:64});
      try { await channel.permissionOverwrites.edit(guild.roles.everyone,{SendMessages:false}); await channel.permissionOverwrites.edit(user.id,{SendMessages:true}); await channel.permissionOverwrites.edit(_client.user.id,{SendMessages:true}); } catch(e){}
      const joinMsg=await channel.send(`🔒 **LOCKED BOMB TAG GAME** 🔒\n\nReact with 🎉 to join!\n⏰ Game starts in **2 minutes** or host types \`/game start\`\n\n**Players:** None yet\n\n*Channel is locked. Only players will speak when game starts.*`);
      await joinMsg.react("🎉");
      const gameData={channelId:channel.id,hostId:user.id,joinMessageId:joinMsg.id,players:new Set(),status:"waiting",currentBombHolder:null,eliminated:[],bombEndTime:null,bombTimer:null,passCollector:null,startTimeout:null,roundActive:false,gameType:"locked",judgeUsed:false,reviveUsed:false};
      _state.bombGames.set(channel.id,gameData);
      gameData.startTimeout=setTimeout(()=>{ const g=_state.bombGames.get(channel.id); if(g&&g.status==="waiting") startBombGame(channel,g,"normal"); },120000);
      const rc=joinMsg.createReactionCollector({filter:(rxn,u)=>rxn.emoji.name==="🎉"&&!u.bot&&rxn.message.id===joinMsg.id,dispose:true});
      rc.on("collect",async(rxn,u)=>{ const g=_state.bombGames.get(channel.id); if(g&&g.status==="waiting"){g.players.add(u.id); try{await channel.permissionOverwrites.edit(u.id,{SendMessages:true});}catch(e){} } });
      rc.on("remove",(rxn,u)=>{ const g=_state.bombGames.get(channel.id); if(g&&g.status==="waiting") g.players.delete(u.id); });
      return;
    }

    if (sub==="setduel") {
      const ch=options.getChannel("channel");
      _state.duelChannels.set(guild.id,ch.id); await database.saveDuelChannel(guild.id,ch.id);
      return safeReply(interaction,{embeds:[createSuccessEmbed(`Duel channel set to ${ch}!`)],flags:64});
    }

    if (sub==="listduels") {
      let desc="";
      for (const [gid,cid] of _state.duelChannels.entries()) { const g=_client.guilds.cache.get(gid); desc+=`📌 **${g?.name||gid}**: <#${cid}>\n`; }
      return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0xffd700).setTitle("📋 Saved Duel Channels").setDescription(desc||"None set.")],flags:64});
    }

    if (sub==="species-add") {
      const target=options.getUser("user"), amount=options.getInteger("amount");
      const ud=_state.userSpecies.get(target.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0,badges:[]};
      ud.rolls=(ud.rolls||0)+amount; _state.userSpecies.set(target.id,ud); database.saveUserSpecies(target.id,ud);
      return safeReply(interaction,{embeds:[createSuccessEmbed(`Gave **${amount}** rolls to <@${target.id}>! They now have **${ud.rolls}** rolls.`)],flags:64});
    }

    if (sub==="species-change") {
      const target=options.getUser("user"), spname=options.getString("species");
      if (spname==="Kitsune"&&target.id!==_client.user.id) return safeReply(interaction,{embeds:[createErrorEmbed("Kitsune is exclusive to Loz!")],flags:64});
      const newSp=getSpeciesByName(spname);
      if (!newSp) return safeReply(interaction,{embeds:[createErrorEmbed("Unknown species! Pick one from the dropdown.")],flags:64});
      const ud=_state.userSpecies.get(target.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0,badges:[]};
      // Only overwrite originalSpecies if currently Human
      if (!ud.originalSpecies||ud.originalSpecies.name==="Human") ud.originalSpecies=newSp;
      ud.species=newSp;
      _state.userSpecies.set(target.id,ud); database.saveUserSpecies(target.id,ud);
      const member=await guild.members.fetch(target.id).catch(()=>null);
      if (member) { const old=member.roles.cache.find(r=>r.name===ud.species?.roleName); if(old) await member.roles.remove(old).catch(()=>{}); await assignSpeciesRole(member,newSp); }
      return safeReply(interaction,{embeds:[createSuccessEmbed(`Changed <@${target.id}>'s species to ${newSp.emoji} **${newSp.name}**!`)]});
    }

    if (sub==="species-reset") {
      const target=options.getUser("user");
      const member=await guild.members.fetch(target.id).catch(()=>null);
      const ud=_state.userSpecies.get(target.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0,badges:[]};
      if (ud.species?.roleName&&member) { const old=member.roles.cache.find(r=>r.name===ud.species.roleName); if(old) await member.roles.remove(old).catch(()=>{}); }
      ud.species=humanSpecies; ud.originalSpecies=humanSpecies;
      _state.userSpecies.set(target.id,ud); database.saveUserSpecies(target.id,ud);
      return safeReply(interaction,{embeds:[createSuccessEmbed(`Reset <@${target.id}> to 👤 **Human**.`)]});
    }

    if (sub==="rolls-reset") {
      const target=options.getUser("user");
      const ud=_state.userSpecies.get(target.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0,badges:[]};
      const old=ud.rolls||0; ud.rolls=0; _state.userSpecies.set(target.id,ud); database.saveUserSpecies(target.id,ud);
      return safeReply(interaction,{embeds:[createSuccessEmbed(`Reset **${old}** rolls for <@${target.id}> to 0. Species stays **${ud.species.name}**.`)],flags:64});
    }

    if (sub==="quest-reset") {
      const target=options.getUser("user"), qn=options.getString("quest");
      const qd=_state.questProgress.get(target.id)||{};
      const blank={easyBots:0,mediumBots:0,hardBots:0,impossibleBots:0,playerFights:0,completed:false,claimed:false};
      if (qn==="reaper"||qn==="all") qd.reaper=blank;
      _state.questProgress.set(target.id,qd); database.saveQuestProgress(target.id,"reaper",qd.reaper);
      return safeReply(interaction,{embeds:[createSuccessEmbed(`Reset ${qn} quest for <@${target.id}>.`)],flags:64});
    }

    if (sub==="debug-db") {
      try {
        const counts = await database.listAllKeys();
        const lines = Object.entries(counts).map(([k,v])=>`• **${k}**: ${v} records`).join("\n");
        return safeReply(interaction,{embeds:[new EmbedBuilder().setColor(0xffd700).setTitle("📊 MongoDB Collections").setDescription(lines||"No data found.")],flags:64});
      } catch(e) { return safeReply(interaction,{embeds:[createErrorEmbed(`DB error: ${e.message}`)],flags:64}); }
    }
  }
}

// ==================== BUTTON HANDLER ====================
async function handleButton(interaction) {
  const { customId, user, guild, channel, message } = interaction;

  // ── GUIDE ─────────────────────────────────────────────────────
  if (customId.startsWith("guide_next_")) {
    const step=parseInt(customId.split("_")[2])+1;
    const steps=[
      {title:"Welcome to LOZ!",content:"Use `/daily` for a free roll, `/species-roll` to get your species, `/fight @user` to battle!"},
      {title:"Species System",content:"HP, ATK, HEAL, ULT cooldown — rarer = stronger! Check `/species`."},
      {title:"Combat",content:"⚔️ ATTACK, 💚 HEAL, ✨ ULT, 🏃 FORFEIT\n\nWin fights for points and rolls!"},
      {title:"Quests",content:"• Reaper Quest: defeat bots and players\n• Cyborg Awakening: 25 wins, 500 dmg, 15 ULTs\n\n`/quest view` to track progress!"},
      {title:"Bomb Tag",content:"💣 Use `/bombtag1v1` to challenge someone!\nUse `'pass @user` to pass the bomb.\nDon't get caught with it!"},
    ];
    const totalSteps=steps.length;
    const embed=new EmbedBuilder().setColor(0x0891b2).setTitle(`📖 Guide (${step+1}/${totalSteps})`).setDescription(`**${steps[step].title}**\n\n${steps[step].content}`);
    const row=new ActionRowBuilder();
    if (step<totalSteps-1) row.addComponents(new ButtonBuilder().setCustomId(`guide_next_${step}`).setLabel("NEXT →").setStyle(ButtonStyle.Primary));
    else row.addComponents(new ButtonBuilder().setCustomId("guide_finish").setLabel("✅ Finish").setStyle(ButtonStyle.Success));
    return interaction.update({embeds:[embed],components:[row],flags:64});
  }
  if (customId==="guide_finish") return interaction.update({content:"✅ Guide complete! Use `/help` for all commands.",embeds:[],components:[],flags:64});

  // ── REROLL ────────────────────────────────────────────────────
  if (customId.startsWith("reroll_")||customId.startsWith("cancel_")) {
    const uid=customId.split("_")[1];
    if (user.id!==uid) return safeReply(interaction,{embeds:[createErrorEmbed("This isn't your roll!")],flags:64});
    if (customId.startsWith("cancel_")) { _state.activeRolls.delete(user.id); return interaction.update({content:"✅ Reroll cancelled!",components:[]}); }
    const userData=_state.userSpecies.get(user.id)||{species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,requestsEnabled:true,lastSwitch:0};
    if ((userData.rolls||0)<1) return interaction.update({content:"❌ No rolls left!",components:[]});
    const rollResult=getRandomSpecies();
    const newSpecies=rollResult.isDragon?getDragonSubtype():rollResult;
    userData.species=newSpecies; userData.originalSpecies=newSpecies; userData.rolls=(userData.rolls||0)-1;
    _state.userSpecies.set(user.id,userData); await database.saveUserSpecies(user.id,userData);
    const member=await guild.members.fetch(user.id); await assignSpeciesRole(member,newSpecies);
    await channel.send({embeds:[new EmbedBuilder().setColor(newSpecies.color||0x808080).setTitle(`${newSpecies.emoji} Rolled: ${newSpecies.name}!`).setDescription(`HP: ${newSpecies.hp} | ATK: ${newSpecies.atkMin}–${newSpecies.atkMax} | Chance: ${newSpecies.chance||"?"}\n🎲 Rolls left: **${userData.rolls}**`)]});
    if (userData.rolls>0) {
      return interaction.update({content:"Roll again?",components:[new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`reroll_${user.id}`).setLabel("🔄 Reroll").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`cancel_${user.id}`).setLabel("❌ Stop").setStyle(ButtonStyle.Danger))]});
    } else { _state.activeRolls.delete(user.id); return interaction.update({content:"✅ All rolls used!",components:[]}); }
  }

  // ── SWITCH ────────────────────────────────────────────────────
  if (customId==="switch_original"||customId==="switch_reaper"||customId==="switch_archdemon") {
    const ud=_state.userSpecies.get(user.id);
    if (!ud) return interaction.update({content:"❌ No species data!",components:[]});
    const now=Date.now(), th=3*60*60*1000;
    if (user.id!==_state.ownerId&&user.id!==_state.secondGodId&&ud.lastSwitch&&now-ud.lastSwitch<th) {
      const tl=th-(now-ud.lastSwitch), h=Math.floor(tl/3600000), m=Math.floor((tl%3600000)/60000);
      return interaction.update({embeds:[createErrorEmbed(`Switch in **${h}h ${m}m**!`)],components:[]});
    }
    let newSp;
    if (customId==="switch_original") newSp=ud.originalSpecies;
    else if (customId==="switch_reaper") { if(!ud.questSpecies?.reaper?.unlocked) return interaction.update({content:"❌ Reaper not unlocked!",components:[]}); newSp=reaperSpecies; }
    else { if(!ud.questSpecies?.archdemon?.unlocked) return interaction.update({content:"❌ Archdemon not unlocked!",components:[]}); newSp=archdemonSpecies; }
    ud.species=newSp; ud.lastSwitch=Date.now();
    _state.userSpecies.set(user.id,ud); database.saveUserSpecies(user.id,ud);
    const member=await guild.members.fetch(user.id); await assignSpeciesRole(member,newSp);
    return interaction.update({embeds:[createSuccessEmbed(`Switched to ${newSp.emoji} **${newSp.name}**! Next switch in 3h.`)],components:[]});
  }

  // ── DUEL ACCEPT/DECLINE ───────────────────────────────────────
  if (customId==="accept_duel"||customId==="decline_duel") {
    let cid=null, cd=null;
    for (const [id,d] of _state.challenges.entries()) { if(d.messageId===message.id){cid=id;cd=d;break;} }
    if (!cd) return safeReply(interaction,{embeds:[createErrorEmbed("Challenge expired.")],flags:64});
    if (user.id!==cd.opponentId) return safeReply(interaction,{embeds:[createErrorEmbed("This isn't your challenge!")],flags:64});
    _state.challenges.delete(cid); _state.activeRequests.delete(cd.challengerId); _state.activeRequests.delete(cd.opponentId);
    if (customId==="decline_duel") {
      await message.edit({embeds:[new EmbedBuilder().setColor(0xff0000).setDescription(`🏃 <@${cd.opponentId}> ran away!`)],components:[]});
      return safeReply(interaction,{embeds:[createErrorEmbed("You ran away!")],flags:64});
    }
    await message.edit({embeds:[new EmbedBuilder().setColor(0x00ff00).setDescription(`✅ <@${cd.opponentId}> accepted! Starting...`)],components:[]});
    const { startDuelGame } = require("./fights.js");
    startDuelGame(channel,cd.challengerId,cd.opponentId);
    return safeReply(interaction,{content:"Match accepted!",flags:64});
  }

  // ── BOT DIFFICULTY ────────────────────────────────────────────
  if (customId.startsWith("bot_")) {
    const diff=customId.split("_")[1];
    if (isPlayerInGame(user.id)) return safeReply(interaction,{embeds:[createErrorEmbed("Already in a game!")],flags:64});
    const personality=botPersonalities[diff];
    const gd={channelId:channel.id,players:new Set([user.id,"BOT"]),status:"playing",currentBombHolder:null,eliminated:[],bombEndTime:null,bombTimer:null,passCollector:null,roundActive:false,gameType:"bot",mode:"bot",scores:{[user.id]:0,BOT:0},roundNumber:0,targetScore:3,botDifficulty:diff,botFailRate:personality.passFailRate,botReactionDelay:personality.reactionDelay,hostId:user.id,judgeUsed:false};
    _state.bombGames.set(channel.id,gd);
    await interaction.update({embeds:[new EmbedBuilder().setColor(personality.color).setTitle("💣 Bot Match Started!").setDescription(`<@${user.id}> vs ${personality.emoji} **${personality.name}**\nFirst to **3 rounds** wins!\n\n*${personality.description}*\n\nUse \`'pass\` to pass the bomb!`)],components:[]});
    setTimeout(()=>startBotRound(channel,gd),3000);
    return;
  }

  // ── FIGHT ACCEPT/REJECT ───────────────────────────────────────
  if (customId.startsWith("fight_accept_")||customId.startsWith("fight_reject_")) {
    const parts=customId.split("_"), action=parts[1], challengerId=parts[2], opponentId=parts[3];
    if (user.id!==opponentId) return safeReply(interaction,{embeds:[createErrorEmbed("This isn't your challenge!")],flags:64});
    const challengeId=`${challengerId}-${opponentId}`;
    if (!_state.fightChallenges.has(challengeId)) return safeReply(interaction,{embeds:[createErrorEmbed("Challenge expired.")],flags:64});
    _state.fightChallenges.delete(challengeId); _state.activeRequests.delete(challengerId); _state.activeRequests.delete(opponentId);
    if (action==="reject") {
      await message.edit({embeds:[new EmbedBuilder().setColor(0xff0000).setDescription(`❌ <@${opponentId}> rejected the fight.`)],components:[]});
      return safeReply(interaction,{embeds:[createErrorEmbed("Fight rejected.")],flags:64});
    }
    const cd2=_state.userSpecies.get(challengerId), od=_state.userSpecies.get(opponentId);
    if (!cd2?.species||cd2.species.name==="Human"||!od?.species||od.species.name==="Human") {
      await message.edit({embeds:[new EmbedBuilder().setColor(0xff0000).setDescription("❌ One player lost their species! Cancelled.")],components:[]});
      return safeReply(interaction,{embeds:[createErrorEmbed("Fight cancelled — species missing!")],flags:64});
    }
    await message.edit({embeds:[new EmbedBuilder().setColor(0x00ff00).setDescription(`✅ <@${opponentId}> accepted! Battle starting...`)],components:[]});
    safeReply(interaction,{content:"Fight accepted!",flags:64});
    startFight(channel,challengerId,opponentId);
    return;
  }

  // ── BOT FIGHT BUTTONS ─────────────────────────────────────────
  if (customId.startsWith("botfight_")) {
    const parts=customId.split("_"), action=parts[1];
    if (action==="choice") {
      const choiceType=parts[2], choice=parts[3], fightId=parts.slice(4).join("_");
      const fight=_state.activeBotFights.get(fightId);
      if (!fight||user.id!==fight.playerId) return interaction.deferUpdate();
      if (fight.timeout) clearTimeout(fight.timeout);
      const log=fight.log||[];
      if (choiceType==="angel") {
        if (choice==="smite") { fight.playerUltBuff={type:"nextAttack",multiplier:1.5,angelHeal:true}; log.push("👼 **DIVINE BLESSING — SMITE!** 1.5× + heal 35% HP!"); }
        else { const h=Math.floor(fight.playerHp*0.6); fight.playerHp=Math.min(fight.playerMaxHp,fight.playerHp+h); log.push(`👼 **DIVINE BLESSING — PRAYER!** Healed ${h} HP!`); }
      } else if (choiceType==="ice") {
        if (choice==="attack") { fight.playerUltBuff={type:"nextAttack",multiplier:1.9}; log.push("❄️ **GLACIAL SPIKE — ATTACK!** 1.9×!"); }
        else { fight.playerUltBuff={type:"iceHealBoost"}; log.push("❄️ **GLACIAL SPIKE — HEAL!** Next heal +50%!"); }
      } else if (choiceType==="earth") {
        if (choice==="attack") { fight.playerUltBuff={type:"nextAttack",multiplier:1.2,invincible:true}; log.push("🌍 **TERRA SHIELD — STRIKE!** 1.2× + invincible!"); }
        else { fight.playerUltBuff={type:"earthDamageReduction"}; log.push("🌍 **TERRA SHIELD — DEFENSE!** −60% dmg!"); }
      }
      fight.playerUltCooldown=fight.playerSpecies.ultCooldown; fight.log=log.slice(-3);
      const msg=_state.fightMessages.get(fightId);
      if (msg) await msg.edit({embeds:[buildBotFightEmbed(fight,fight.log,"bot_thinking")],components:[buildBotFightRow(fightId,fight,"bot_thinking")]}).catch(()=>{});
      setTimeout(()=>doBotTurn(channel,fightId),botPersonalities[fight.difficulty].reactionDelay);
      return interaction.deferUpdate();
    }

    const fightId=parts.slice(2).join("_");
    const fight=_state.activeBotFights.get(fightId);
    if (!fight) return safeReply(interaction,{embeds:[createErrorEmbed("Fight ended!")],flags:64});
    if (user.id!==fight.playerId) return safeReply(interaction,{embeds:[createErrorEmbed("This isn't your fight!")],flags:64});
    if (action==="thinking") return safeReply(interaction,{embeds:[createErrorEmbed("It's the bot's turn!")],flags:64});
    if (fight.timeout) clearTimeout(fight.timeout);
    await interaction.deferUpdate();
    const msg=_state.fightMessages.get(fightId);
    const log=fight.log||[];

    if (action==="forfeit") { await endBotFight(channel,fightId,"bot","player",fight.difficulty); return; }

    const playerC={id:fight.playerId,species:fight.playerSpecies,currentHp:fight.playerHp,maxHp:fight.playerMaxHp,ultBuff:fight.playerUltBuff,adaptiveStacks:fight.playerAdaptiveStacks||0,attackCounter:fight.playerAttackCounter||0,burn:fight.playerBurn||0,burnRounds:fight.playerBurnRounds||0,curse:fight.playerCurse||0,blockHeal:fight.playerBlockHeal||false,possession:false,stunnedTurns:fight.playerStunnedTurns||0,healCooldown:fight.playerHealCooldown,ultCooldown:fight.playerUltCooldown,lastUltUsed:fight.playerLastUltUsed};
    const botC={id:"BOT",species:fight.botSpecies,currentHp:fight.botHp,maxHp:fight.botMaxHp,ultBuff:fight.botUltBuff,adaptiveStacks:fight.botAdaptiveStacks||0,attackCounter:fight.botAttackCounter||0,burn:fight.botBurn||0,burnRounds:fight.botBurnRounds||0,curse:fight.botCurse||0,blockHeal:fight.botBlockHeal||false,possession:false,stunnedTurns:0,healCooldown:fight.botHealCooldown,ultCooldown:fight.botUltCooldown,lastUltUsed:fight.botLastUltUsed};

    if (action==="heal") {
      if (playerC.blockHeal) { playerC.blockHeal=false; log.push("🚫 **ROYAL COMMAND!** You can't heal!"); }
      else if (playerC.healCooldown>0) { log.push(`❌ Heal on cooldown for ${playerC.healCooldown} more rounds!`); }
      else if (playerC.currentHp>=playerC.maxHp*0.8) { log.push("❌ Already too healthy to heal!"); }
      else {
        let mult=1;
        if (playerC.ultBuff?.type==="iceHealBoost") { mult=1.5; playerC.ultBuff=null; log.push("❄️ Glacial Spike boosts heal!"); }
        const h=Math.floor((Math.floor(Math.random()*(playerC.species.healMax-playerC.species.healMin+1))+playerC.species.healMin)*mult);
        const actualH=playerC.curse>0?Math.floor(h*0.5):h;
        if (playerC.curse>0) log.push(`👿 Curse halves heal! ${h}→${actualH}`);
        playerC.currentHp=Math.min(playerC.maxHp,playerC.currentHp+actualH); playerC.healCooldown=3;
        log.push(`💚 You heal for **${actualH} HP**! (${playerC.currentHp}/${playerC.maxHp})`);
      }
    } else if (action==="ult") {
      if (playerC.ultCooldown>0) { log.push(`❌ ULT on cooldown for ${playerC.ultCooldown} more rounds!`); }
      else {
        const {message:um,requiresChoice,choiceType}=applyUltEffect(playerC,botC);
        fight.playerLastUltUsed=playerC.lastUltUsed;
        if (requiresChoice) {
          fight.playerUltBuff=playerC.ultBuff; fight.playerUltCooldown=playerC.species.ultCooldown;
          fight.botHp=botC.currentHp; fight.playerHp=playerC.currentHp; fight.log=log.slice(-3);
          if (msg) await msg.edit({embeds:[buildBotFightEmbed(fight,fight.log,"choice")],components:[buildBotFightRow(fightId,fight,`choice_${choiceType}`)]}).catch(()=>{});
          fight.timeout=setTimeout(()=>{ if(_state.activeBotFights.has(fightId)){fight.playerUltBuff={type:"nextAttack",multiplier:1.5}; doBotTurn(channel,fightId);} },30000);
          return;
        }
        fight.playerUltCooldown=playerC.species.ultCooldown;
        if (playerC.species.name==="Cyborg") await updateCyborgProgress(fight.playerId,"ult");
        if (playerC.species.name==="Ogre") botC.stunnedTurns=1;
        fight.playerHp=Math.max(0,playerC.currentHp); fight.botHp=Math.max(0,botC.currentHp); fight.botUltBuff=botC.ultBuff;
        log.push(`✨ **YOU USE ULT!**\n${um}`);
      }
    } else if (action==="attack") {
      const result=calculateDamage(playerC,botC);
      playerC.currentHp=Math.max(0,Math.min(playerC.maxHp,playerC.currentHp+result.attackerMutations.hpDelta));
      botC.currentHp=Math.max(0,botC.currentHp-result.damage);
      if (botC.species.name==="Chimera"&&result.damage>0) fight.botAdaptiveStacks=Math.min(3,(fight.botAdaptiveStacks||0)+1);
      if (botC.species.name==="God"&&result.missedAttack) { const gh=Math.floor(botC.currentHp*0.2); botC.currentHp=Math.min(botC.maxHp,botC.currentHp+gh); log.push(`👑 Bot **Divine Retribution** heals ${gh}!`); }
      fight.playerLastUltUsed=playerC.lastUltUsed;
      log.push(`⚔️ You deal **${result.damage}** damage!${result.specialLines.length?` (${result.specialLines.slice(0,2).join(", ")})`:""}`);
    }

    // Burn tick on bot
    if (botC.burn>0) { const bd=botC.burn; botC.currentHp=Math.max(0,botC.currentHp-bd); botC.burnRounds--; if(botC.burnRounds<=0){botC.burn=0;botC.burnRounds=0;} log.push(`🔥 Bot takes ${bd} burn!`); }
    // Ogre regen for player
    const or=applyOgreRegen(playerC); if(or) log.push(or);
    // FIX: tick BOTH players ULT cooldown every round
    tickBothUltCooldowns(playerC, botC);

    // Sync back
    fight.playerHp=Math.max(0,playerC.currentHp); fight.botHp=Math.max(0,botC.currentHp);
    fight.playerUltBuff=playerC.ultBuff; fight.playerHealCooldown=playerC.healCooldown; fight.playerUltCooldown=playerC.ultCooldown;
    fight.playerBurn=playerC.burn; fight.playerBurnRounds=playerC.burnRounds; fight.playerCurse=playerC.curse;
    fight.playerBlockHeal=playerC.blockHeal; fight.playerAdaptiveStacks=playerC.adaptiveStacks; fight.playerAttackCounter=playerC.attackCounter;
    fight.botUltBuff=botC.ultBuff; fight.botBurn=botC.burn; fight.botBurnRounds=botC.burnRounds;
    fight.botBlockHeal=botC.blockHeal; fight.botAdaptiveStacks=botC.adaptiveStacks; fight.botAttackCounter=botC.attackCounter; fight.botStunnedTurns=botC.stunnedTurns||0;
    fight.log=log.slice(-3);

    if (fight.botHp<=0) { await endBotFight(channel,fightId,"player","bot",fight.difficulty); return; }
    if (fight.playerHp<=0) { await endBotFight(channel,fightId,"bot","player",fight.difficulty); return; }

    if (msg) await msg.edit({embeds:[buildBotFightEmbed(fight,fight.log,"bot_thinking")],components:[buildBotFightRow(fightId,fight,"bot_thinking")]}).catch(()=>{});
    setTimeout(()=>doBotTurn(channel,fightId),botPersonalities[fight.difficulty].reactionDelay);
    return;
  }

  // ── PVP FIGHT BUTTONS ─────────────────────────────────────────
  if (customId.startsWith("pvp_")) {
    await interaction.deferUpdate();
    const parts=customId.split("_"), action=parts[1];

    if (action==="choice") {
      const choiceType=parts[2], choice=parts[3], fightId=parts.slice(4).join("_");
      const fight=_state.activeFights.get(fightId);
      if (!fight) return;
      const isP1=user.id===fight.player1Id;
      const player=isP1?fight.player1:fight.player2;
      const opponent=isP1?fight.player2:fight.player1;
      if (!player.ultChoicePending) return;
      player.ultChoicePending=false;
      const log=[];
      if (choiceType==="angel") {
        if (choice==="smite") { player.ultBuff={type:"nextAttack",multiplier:1.5,angelHeal:true}; log.push(`👼 <@${user.id}> chooses **SMITE** — 1.5× + 35% heal!`); }
        else { const h=Math.floor(player.currentHp*0.6); player.currentHp=Math.min(player.maxHp,player.currentHp+h); log.push(`👼 <@${user.id}> chooses **PRAYER** — healed ${h} HP!`); }
      } else if (choiceType==="ice") {
        if (choice==="attack") { player.ultBuff={type:"nextAttack",multiplier:1.9}; log.push(`❄️ <@${user.id}> chooses **GLACIAL STRIKE** — 1.9×!`); }
        else { player.ultBuff={type:"iceHealBoost"}; log.push(`❄️ <@${user.id}> chooses **GLACIAL HEAL** — next heal +50%!`); }
      } else if (choiceType==="earth") {
        if (choice==="attack") { player.ultBuff={type:"nextAttack",multiplier:1.2,invincible:true}; log.push(`🌍 <@${user.id}> chooses **TERRA STRIKE** — 1.2× + invincible!`); }
        else { player.ultBuff={type:"earthDamageReduction"}; log.push(`🌍 <@${user.id}> chooses **TERRA SHIELD** — −60% dmg!`); }
      }
      player.ultCooldown=player.species.ultCooldown; fight.currentTurn=opponent.id; fight.round++;
      const nextTurnPlayer=fight.currentTurn===fight.player1Id?fight.player1:fight.player2;
      const msg=_state.fightMessages.get(fightId);
      if (msg) await msg.edit({embeds:[buildFightEmbed(fight,log)],components:[buildFightRow(fightId,nextTurnPlayer)]}).catch(()=>{});
      if (fight.timeout) clearTimeout(fight.timeout);
      fight.timeout=setTimeout(()=>{ if(_state.activeFights.has(fightId)){const l=fight.currentTurn;const w=fight.player1Id===l?fight.player2Id:fight.player1Id;endFight(channel,fightId,w,l,"timeout");} },120000);
      return;
    }

    const fightId=parts.slice(2).join("_");
    const fight=_state.activeFights.get(fightId);
    if (!fight) return;
    const isP1=user.id===fight.player1Id, isP2=user.id===fight.player2Id;
    if (!isP1&&!isP2) return;
    if (user.id!==fight.currentTurn) return interaction.followUp({embeds:[createErrorEmbed("It's not your turn!")],flags:64});
    if (fight.timeout) clearTimeout(fight.timeout);
    const player=isP1?fight.player1:fight.player2;
    const opponent=isP1?fight.player2:fight.player1;
    const log=[];

    if (action==="forfeit") {
      if (Math.random()<0.35) { log.push(`😵 <@${user.id}> tried to forfeit but pride won't let them! Turn wasted.`); fight.currentTurn=opponent.id; fight.round++; }
      else { await endFight(channel,fightId,opponent.id,user.id,"forfeit"); return; }
    } else if (action==="ult") {
      if (player.ultCooldown>0) { log.push(`❌ <@${user.id}>'s ULT on cooldown for ${player.ultCooldown} more rounds!`); fight.currentTurn=opponent.id; fight.round++; }
      else {
        const {message:um,requiresChoice,choiceType}=applyUltEffect(player,opponent);
        if (requiresChoice) {
          player.ultChoicePending=true;
          const msg=_state.fightMessages.get(fightId);
          if (msg) await msg.edit({embeds:[buildFightEmbed(fight,[`✨ <@${user.id}> uses ULT! Choose your path:`],"choice")],components:[buildFightRow(fightId,player,`choice_${choiceType}`)]}).catch(()=>{});
          fight.timeout=setTimeout(()=>{
            if(_state.activeFights.has(fightId)&&player.ultChoicePending){
              player.ultChoicePending=false; player.ultCooldown=player.species.ultCooldown; player.ultBuff={type:"nextAttack",multiplier:1.5};
              fight.currentTurn=opponent.id; fight.round++;
              const msg2=_state.fightMessages.get(fightId);
              const tp=fight.currentTurn===fight.player1Id?fight.player1:fight.player2;
              if(msg2) msg2.edit({embeds:[buildFightEmbed(fight,["⏰ ULT choice timed out!"])],components:[buildFightRow(fightId,tp)]}).catch(()=>{});
            }
          },30000);
          return;
        }
        player.ultCooldown=player.species.ultCooldown;
        if (player.species.name==="Cyborg") await updateCyborgProgress(player.id,"ult");
        if (player.species.name==="Ogre") { opponent.stunnedTurns=1; log.push(`💥 **MASSIVE BLOW!** Opponent stunned! Extra turn!`); }
        log.push(`✨ <@${user.id}> uses ULT!\n${um}`);
        if (player.species.name==="Ogre") fight.currentTurn=user.id;
        else { fight.currentTurn=opponent.id; fight.round++; }
      }
    } else if (action==="heal") {
      if (player.blockHeal) { player.blockHeal=false; log.push(`🚫 <@${user.id}> **cannot heal** — Royal Command!`); fight.currentTurn=opponent.id; fight.round++; }
      else if (player.healCooldown>0) { log.push(`❌ <@${user.id}>'s heal on cooldown for ${player.healCooldown} more rounds!`); fight.currentTurn=opponent.id; fight.round++; }
      else if (player.currentHp>=player.maxHp*0.8) { log.push(`❌ <@${user.id}> too healthy to heal!`); fight.currentTurn=opponent.id; fight.round++; }
      else {
        let mult=1;
        if (player.ultBuff?.type==="iceHealBoost") { mult=1.5; player.ultBuff=null; }
        if (player.ultBuff?.type==="earthHealBoost") { mult*=1.2; player.ultBuff=null; }
        const h=Math.floor((Math.floor(Math.random()*(player.species.healMax-player.species.healMin+1))+player.species.healMin)*mult);
        const actualH=player.curse>0?Math.floor(h*0.5):h;
        if (player.curse>0) { processCurseTick(player); log.push(`👿 Curse halves heal! ${h}→${actualH}`); }
        player.currentHp=Math.min(player.maxHp,player.currentHp+actualH); player.healCooldown=3;
        log.push(`💚 <@${user.id}> heals for **${actualH} HP**! (${player.currentHp}/${player.maxHp})`);
        fight.currentTurn=opponent.id; fight.round++;
      }
    } else if (action==="attack") {
      if (player.possession) {
        player.possession=false;
        const selfHit=Math.floor(Math.random()*(player.species.atkMax-player.species.atkMin+1))+player.species.atkMin;
        player.currentHp=Math.max(0,player.currentHp-selfHit);
        log.push(`🎭 **POSSESSION!** <@${user.id}> attacks themselves for ${selfHit}!`);
        fight.currentTurn=opponent.id; fight.round++;
      } else {
        const result=calculateDamage(player,opponent);
        player.currentHp=Math.max(0,Math.min(player.maxHp,player.currentHp+result.attackerMutations.hpDelta));
        opponent.currentHp=Math.max(0,opponent.currentHp-result.damage);
        if (opponent.species.name==="Chimera"&&result.damage>0) opponent.adaptiveStacks=Math.min(3,(opponent.adaptiveStacks||0)+1);
        if (opponent.species.name==="God"&&result.missedAttack) { const gh=Math.floor(opponent.currentHp*0.2); opponent.currentHp=Math.min(opponent.maxHp,opponent.currentHp+gh); log.push(`👑 **Divine Retribution!** ${opponent.species.name} heals ${gh}!`); }
        log.push(`⚔️ <@${user.id}> deals **${result.damage}** damage!${result.specialLines.length?` (${result.specialLines.slice(0,2).join(", ")})`:""}`);
        fight.currentTurn=opponent.id; fight.round++;
      }
    }

    // Burn tick on opponent
    if (opponent.burn>0) { const bd=opponent.burn; opponent.currentHp=Math.max(0,opponent.currentHp-bd); opponent.burnRounds--; if(opponent.burnRounds<=0){opponent.burn=0;opponent.burnRounds=0;} log.push(`🔥 ${opponent.species.name} takes ${bd} burn!`); }
    const or=applyOgreRegen(player); if(or) log.push(or);
    // FIX: tick BOTH players ULT cooldown every round
    tickBothUltCooldowns(player, opponent);

    if (opponent.currentHp<=0) { await endFight(channel,fightId,user.id,opponent.id,"normal"); return; }
    if (player.currentHp<=0)   { await endFight(channel,fightId,opponent.id,user.id,"normal"); return; }

    const nextTurnPlayer=fight.currentTurn===fight.player1Id?fight.player1:fight.player2;
    const msg2=_state.fightMessages.get(fightId);
    if (msg2) await msg2.edit({embeds:[buildFightEmbed(fight,log)],components:[buildFightRow(fightId,nextTurnPlayer)]}).catch(()=>{});
    fight.timeout=setTimeout(()=>{ if(_state.activeFights.has(fightId)){const l=fight.currentTurn;const w=fight.player1Id===l?fight.player2Id:fight.player1Id;endFight(channel,fightId,w,l,"timeout");} },120000);
    return;
  }

  // ── AWAKENING BUTTON ──────────────────────────────────────────
  if (customId==="awaken_cyborg") {
    const ud=_state.userSpecies.get(user.id);
    if (!ud||ud.species.name!=="Cyborg") return interaction.update({content:"❌ Not a Cyborg!",components:[]});
    if (!isCyborgReadyForAwakening(ud)) return interaction.update({content:"❌ Requirements not met yet!",components:[]});
    const mech=getSpeciesByName("Mechangel");
    ud.species=mech; ud.originalSpecies=mech; ud.awakening.cyborg.awakened=true; ud.rolls=(ud.rolls||0)+5;
    _state.userSpecies.set(user.id,ud); await database.saveUserSpecies(user.id,ud);
    const member=await guild.members.fetch(user.id); await assignSpeciesRole(member,mech);
    return interaction.update({embeds:[new EmbedBuilder().setColor(0x00ffff).setTitle("⚡ MECHANGEL AWAKENING COMPLETE ⚡")
      .setDescription("🤖 **Cyborg → ⚡ Mechangel**\n\n+15 HP · New passive: Quantum Processing · New ULT: System Restoration\n\n🎁 +5 Species Rolls!\n\n*Machine and angel, fused as one.*")],components:[]});
  }
}

// ==================== SLASH COMMAND DEFINITIONS ====================
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("Show all commands"),
  new SlashCommandBuilder().setName("guide").setDescription("New player tutorial"),
  new SlashCommandBuilder().setName("daily").setDescription("Claim your daily species roll"),
  new SlashCommandBuilder().setName("species").setDescription("View species list or a specific species card").addStringOption(o=>o.setName("species").setDescription("Species name for detailed card (leave blank for full list)").addChoices({name:"Demi God ⚡",value:"Demi God"},{name:"Demon Lord 🔥",value:"Demon Lord"},{name:"Demon King 👑😈",value:"Demon King"},{name:"Chimera 🎭",value:"Chimera"},{name:"Angel 👼",value:"Angel"},{name:"Demon 😈",value:"Demon"},{name:"Oni 👿",value:"Oni"},{name:"Orc Lord 👑",value:"Orc Lord"},{name:"Kijin 🎭",value:"Kijin"},{name:"Cyborg 🤖",value:"Cyborg"},{name:"High Orc ⚔️",value:"High Orc"},{name:"Ogre 👹",value:"Ogre"},{name:"Goblin 👺",value:"Goblin"},{name:"Orc 🟢",value:"Orc"},{name:"Half-Blood 🩸",value:"Half-Blood"},{name:"Fire Dragon 🔥🐉",value:"Fire Dragon"},{name:"Thunder Dragon ⚡🐉",value:"Thunder Dragon"},{name:"Ice Dragon ❄️🐉",value:"Ice Dragon"},{name:"Earth Dragon 🌍🐉",value:"Earth Dragon"},{name:"Reaper 🌑",value:"Reaper"},{name:"Archdemon 👿",value:"Archdemon"},{name:"Mechangel ⚡🤖",value:"Mechangel"},{name:"God 👑✨",value:"God"},{name:"Human 👤",value:"Human"})),
  new SlashCommandBuilder().setName("profile").setDescription("View a full player profile").addUserOption(o=>o.setName("user").setDescription("User to check")),
  new SlashCommandBuilder().setName("species-roll").setDescription("Roll for a new species"),
  new SlashCommandBuilder().setName("switch").setDescription("Switch between your species (3h cooldown)"),
  new SlashCommandBuilder().setName("awakening").setDescription("Check your Cyborg awakening progress"),
  new SlashCommandBuilder().setName("fight").setDescription("Challenge a player to a fight").addUserOption(o=>o.setName("user").setDescription("Player to fight").setRequired(true)),
  new SlashCommandBuilder().setName("fightbot").setDescription("Fight a bot").addStringOption(o=>o.setName("difficulty").setDescription("Bot difficulty").setRequired(true).addChoices({name:"🧸 Easy",value:"easy"},{name:"⚔️ Medium",value:"medium"},{name:"👹 Hard",value:"hard"},{name:"💀 Impossible",value:"impossible"})),
  new SlashCommandBuilder().setName("fightstats").setDescription("View fight stats").addUserOption(o=>o.setName("user").setDescription("User to check")),
  new SlashCommandBuilder().setName("history").setDescription("View fight history").addUserOption(o=>o.setName("user").setDescription("User to check")),
  new SlashCommandBuilder().setName("botstats").setDescription("View bot fight stats").addUserOption(o=>o.setName("user").setDescription("User to check")),
  new SlashCommandBuilder().setName("lb").setDescription("Bomb tag leaderboard"),
  new SlashCommandBuilder().setName("fights").setDescription("Fight leaderboard"),
  new SlashCommandBuilder().setName("bombtag1v1").setDescription("Challenge a player to bomb tag").addUserOption(o=>o.setName("user").setDescription("Player to challenge").setRequired(true)),
  new SlashCommandBuilder().setName("bombtag1v1bot").setDescription("Challenge a bot to bomb tag"),
  new SlashCommandBuilder().setName("game").setDescription("Control a bomb tag game").addStringOption(o=>o.setName("action").setDescription("Action").setRequired(true).addChoices({name:"Start",value:"start"},{name:"Cancel",value:"cancel"},{name:"End",value:"end"})),
  new SlashCommandBuilder().setName("patchnotes").setDescription("View latest patch notes"),
  new SlashCommandBuilder().setName("togglerequests").setDescription("Toggle receiving challenge requests").addStringOption(o=>o.setName("status").setDescription("Enable or disable").setRequired(true).addChoices({name:"Enable",value:"enable"},{name:"Disable",value:"disable"})),
  new SlashCommandBuilder().setName("quest").setDescription("Quest system")
    .addSubcommand(s=>s.setName("view").setDescription("View your quests").addUserOption(o=>o.setName("user").setDescription("User to check")))
    .addSubcommand(s=>s.setName("claim").setDescription("Claim a quest reward").addStringOption(o=>o.setName("quest").setDescription("Quest to claim").setRequired(true).addChoices({name:"Reaper",value:"reaper"}))),
  new SlashCommandBuilder().setName("god").setDescription("God-only commands")
    .addSubcommand(s=>s.setName("menu").setDescription("Show god menu"))
    .addSubcommand(s=>s.setName("nuke").setDescription("Nuke a user").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)))
    .addSubcommand(s=>s.setName("rev").setDescription("Reverse a user's messages").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)))
    .addSubcommand(s=>s.setName("species-change").setDescription("Change a user's species").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)).addStringOption(o=>o.setName("species").setDescription("Species to set").setRequired(true).addChoices({name:"Demi God ⚡",value:"Demi God"},{name:"Demon Lord 🔥",value:"Demon Lord"},{name:"Demon King 👑😈",value:"Demon King"},{name:"Chimera 🎭",value:"Chimera"},{name:"Angel 👼",value:"Angel"},{name:"Demon 😈",value:"Demon"},{name:"Oni 👿",value:"Oni"},{name:"Orc Lord 👑",value:"Orc Lord"},{name:"Kijin 🎭",value:"Kijin"},{name:"Cyborg 🤖",value:"Cyborg"},{name:"High Orc ⚔️",value:"High Orc"},{name:"Ogre 👹",value:"Ogre"},{name:"Goblin 👺",value:"Goblin"},{name:"Orc 🟢",value:"Orc"},{name:"Half-Blood 🩸",value:"Half-Blood"},{name:"Fire Dragon 🔥🐉",value:"Fire Dragon"},{name:"Thunder Dragon ⚡🐉",value:"Thunder Dragon"},{name:"Ice Dragon ❄️🐉",value:"Ice Dragon"},{name:"Earth Dragon 🌍🐉",value:"Earth Dragon"},{name:"Reaper 🌑",value:"Reaper"},{name:"Archdemon 👿",value:"Archdemon"},{name:"Mechangel ⚡🤖",value:"Mechangel"},{name:"God 👑✨",value:"God"},{name:"Human 👤",value:"Human"})))
    .addSubcommand(s=>s.setName("species-reset").setDescription("Reset a user to Human").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)))
    .addSubcommand(s=>s.setName("species-add").setDescription("Give rolls to a user").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)).addIntegerOption(o=>o.setName("amount").setDescription("Amount of rolls").setRequired(true).setMinValue(1).setMaxValue(1000000)))
    .addSubcommand(s=>s.setName("rolls-reset").setDescription("Reset a user's rolls to 0").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)))
    .addSubcommand(s=>s.setName("quest-reset").setDescription("Reset a user's quest").addUserOption(o=>o.setName("user").setDescription("Target").setRequired(true)).addStringOption(o=>o.setName("quest").setDescription("Quest name").setRequired(true).addChoices({name:"Reaper",value:"reaper"},{name:"All",value:"all"})))
    .addSubcommand(s=>s.setName("setduel").setDescription("Set the duel channel").addChannelOption(o=>o.setName("channel").setDescription("Channel").setRequired(true)))
    .addSubcommand(s=>s.setName("listduels").setDescription("List all duel channels"))
    .addSubcommand(s=>s.setName("bombtag").setDescription("Start a normal bomb tag game"))
    .addSubcommand(s=>s.setName("bombtag1").setDescription("Start a locked bomb tag game"))
    .addSubcommand(s=>s.setName("debug-db").setDescription("Check database keys")),
].map(c=>c.toJSON());

module.exports = { setState, setClient, handleCommand, handleButton, commands };
