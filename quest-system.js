"use strict";
const { ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SectionBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SeparatorSpacingSize } = require("discord.js");
const database = require("./database.js");
const { humanSpecies } = require("./constants.js");

const VOTE_INTERVAL_MS = 12 * 60 * 60 * 1000;
const QUEST_INTERVAL_MS = 12 * 60 * 60 * 1000;
const CLAIMED_VISIBLE_MS = 5 * 60 * 1000;
const MAX_ROTATING_QUESTS = 3;
const VOTE_ROLL_REWARD = 2;
let _state = null;
let _client = null;
let _scheduler = null;
const userLocks = new Map();
const activeBoardViews = new Map();

const QUEST_TEMPLATES = [
  { rarity:"Common", weight:45, emoji:"⚪", title:"Rift Patrol", description:"Complete 3 battles. Wins and losses count.", objectives:[{type:"battles",target:3,label:"Complete battles"}], reward:{rolls:1,speciesTokens:0} },
  { rarity:"Uncommon", weight:27, emoji:"🟢", title:"Sustained Assault", description:"Deal 180 damage across your battles.", objectives:[{type:"damage",target:180,label:"Damage dealt"}], reward:{rolls:2,speciesTokens:0} },
  { rarity:"Rare", weight:15, emoji:"🔵", title:"Bot Breaker", description:"Win 3 bot battles. Bot timeouts do not count as wins.", objectives:[{type:"botWins",target:3,label:"Bot victories"}], reward:{rolls:3,speciesTokens:0} },
  { rarity:"Epic", weight:8, emoji:"🟣", title:"Duelist's Oath", description:"Win 3 player-versus-player battles.", objectives:[{type:"playerWins",target:3,label:"Player battle victories"}], reward:{rolls:5,speciesTokens:0} },
  { rarity:"Legendary", weight:4, emoji:"🟠", title:"Apex Pursuit", description:"Prove your strength: deal 1,000 damage and use 8 ultimates.", objectives:[{type:"damage",target:1000,label:"Damage dealt"},{type:"ults",target:8,label:"ULT uses"}], reward:{rolls:8,speciesTokens:0} },
  { rarity:"Mythic", weight:1, emoji:"🔴", title:"Trial of the Rift", description:"Endure 15 battles, defeat 5 Brutal bots, deal 1,500 damage, and use 10 ultimates. This trial does not expire.", objectives:[{type:"battles",target:15,label:"Battles completed"},{type:"brutalWins",target:5,label:"Brutal bot victories"},{type:"damage",target:1500,label:"Damage dealt"},{type:"ults",target:10,label:"ULT uses"}], reward:{rolls:0,speciesTokens:1} },
];

function setState(state) { _state = state; }
function setClient(client) { _client = client; }

async function withUserLock(userId, task) {
  const previous = userLocks.get(userId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  userLocks.set(userId, current);
  await previous.catch(() => {});
  try { return await task(); }
  finally {
    release();
    if (userLocks.get(userId) === current) userLocks.delete(userId);
  }
}

function topggVoteUrl() {
  const botId = _client && _client.user && _client.user.id;
  return botId ? "https://top.gg/bot/" + botId + "/vote" : "https://top.gg/";
}

function chooseQuestTemplate() {
  const total = QUEST_TEMPLATES.reduce((sum, quest) => sum + quest.weight, 0);
  let roll = Math.random() * total;
  for (const quest of QUEST_TEMPLATES) {
    if (roll < quest.weight) return quest;
    roll -= quest.weight;
  }
  return QUEST_TEMPLATES[0];
}

function createQuest(now = Date.now()) {
  const template = chooseQuestTemplate();
  return {
    id:require("node:crypto").randomUUID(), rarity:template.rarity, emoji:template.emoji,
    title:template.title, description:template.description,
    objectives:template.objectives.map(objective => ({...objective,progress:0})),
    reward:{...template.reward}, status:"active", createdAt:now, claimedAt:0,
  };
}

function createBoard(now = Date.now()) {
  return {
    vote:{lastVoteAt:0,nextVoteAt:0,totalVotes:0,remindersEnabled:true,lastReminderAt:0},
    quests:[createQuest(now)], nextQuestAt:now+QUEST_INTERVAL_MS, createdAt:now,
  };
}

function isQuestComplete(quest) {
  return Array.isArray(quest && quest.objectives) && quest.objectives.length > 0
    && quest.objectives.every(objective => (Number(objective.progress)||0)>=(Number(objective.target)||0));
}

async function saveBoard(userId, board) {
  const saved = await database.saveQuestBoard(userId, board);
  if (!saved) throw new Error("MongoDB could not save the quest board.");
  _state.questBoards.set(userId, board);
}

async function ensureBoardLocked(userId) {
  const now = Date.now();
  let board = _state.questBoards.get(userId);
  let changed = false;
  if (!board || typeof board !== "object") {
    board = createBoard(now);
    await saveBoard(userId, board);
    return board;
  }
  if (!board.vote || typeof board.vote !== "object") {
    board.vote = {lastVoteAt:0,nextVoteAt:0,totalVotes:0,remindersEnabled:true,lastReminderAt:0};
    changed = true;
  }
  if (!Array.isArray(board.quests)) { board.quests = []; changed = true; }
  if (!Number.isFinite(Number(board.nextQuestAt)) || Number(board.nextQuestAt)<=0) { board.nextQuestAt=now+QUEST_INTERVAL_MS; changed=true; }
  if (typeof board.vote.remindersEnabled !== "boolean") { board.vote.remindersEnabled=true; changed=true; }
  if (!Number.isFinite(Number(board.vote.lastVoteAt))) { board.vote.lastVoteAt=0; changed=true; }
  if (!Number.isFinite(Number(board.vote.nextVoteAt))) { board.vote.nextVoteAt=0; changed=true; }
  if (!Number.isFinite(Number(board.vote.lastReminderAt))) { board.vote.lastReminderAt=0; changed=true; }
  if (!Number.isFinite(Number(board.vote.totalVotes))) { board.vote.totalVotes=0; changed=true; }

  const retained = board.quests.filter(quest => quest.status!=="claimed" || now-(Number(quest.claimedAt)||0)<CLAIMED_VISIBLE_MS);
  if (retained.length !== board.quests.length) { board.quests=retained; changed=true; }
  // Active quests and progress never reset. New entries fill an available slot every 12 hours.
  if (now >= board.nextQuestAt && board.quests.length < MAX_ROTATING_QUESTS) {
    board.quests.push(createQuest(now));
    board.nextQuestAt=now+QUEST_INTERVAL_MS;
    changed=true;
  }
  if (changed) await saveBoard(userId, board);
  return board;
}

async function openBoard(userId, interaction=null) {
  if (!_state || !_state.questBoards) throw new Error("Quest board state is not ready.");
  if (interaction && interaction.webhook) rememberBoardView(userId, interaction.webhook);
  return withUserLock(userId, async () => buildBoardPayload(userId, await ensureBoardLocked(userId)));
}


function rememberBoardView(userId, webhook) {
  if (!webhook || typeof webhook.editMessage !== "function") return;
  const id=String(userId);
  const now=Date.now();
  const existing=(activeBoardViews.get(id)||[]).filter(view=>view.expiresAt>now);
  // A new component interaction supplies a fresh token for the same board message.
  existing.push({ webhook, expiresAt:now+14*60*1000 });
  activeBoardViews.set(id,existing.slice(-5));
}

async function refreshBoardViews(userId, board) {
  const id=String(userId);
  const now=Date.now();
  const views=(activeBoardViews.get(id)||[]).filter(view=>view.expiresAt>now);
  const remaining=[];
  for (const view of views) {
    try {
      await view.webhook.editMessage("@original",buildBoardPayload(id,board,"",false));
      remaining.push(view);
    } catch(error) {
      // Expired interaction tokens/messages are expected; discard the stale editor.
      if (error?.code!==10015 && error?.code!==10062 && error?.status!==404) {
        console.warn("[Quests] Could not refresh active quest board for "+id+":",error.message);
      }
    }
  }
  if (remaining.length) activeBoardViews.set(id,remaining);
  else activeBoardViews.delete(id);
}

function progressBar(progress, target, width=8) {
  const max=Math.max(1,Number(target)||1);
  const value=Math.max(0,Math.min(max,Number(progress)||0));
  const filled=Math.round(value/max*width);
  return "▰".repeat(filled)+"▱".repeat(width-filled)+" "+value.toLocaleString()+"/"+max.toLocaleString();
}

function formatReward(reward={}) {
  const parts=[];
  if (Number(reward.rolls)>0) parts.push("<:reroll_dice:1558042108965822515> **+"+reward.rolls+" Species Roll"+(reward.rolls===1?"":"s")+"**");
  if (Number(reward.speciesTokens)>0) parts.push("🔑 **+"+reward.speciesTokens+" Species Token"+(reward.speciesTokens===1?"":"s")+"**");
  return parts.length?parts.join(" · "):"No reward";
}

function makeQuestSection(userId, quest) {
  const ready=isQuestComplete(quest), claimed=quest.status==="claimed";
  const details=(quest.objectives||[]).map(objective=>"- "+objective.label+": "+progressBar(objective.progress,objective.target)).join("\n");
  const body="### "+quest.emoji+" "+quest.title+" · "+quest.rarity.toUpperCase()
    +"\n- "+quest.description+(details?"\n\n"+details:"")+"\n\n**Reward:** "+formatReward(quest.reward);
  const button=new ButtonBuilder();
  if (claimed) button.setCustomId("quest_claimed:"+userId+":"+quest.id).setLabel("Claimed").setStyle(ButtonStyle.Success).setDisabled(true);
  else if (ready) button.setCustomId("quest_claim:"+userId+":"+quest.id).setLabel("Claim Reward").setEmoji({name:"🟡"}).setStyle(ButtonStyle.Primary);
  else button.setCustomId("quest_progress:"+userId+":"+quest.id).setLabel("In Progress").setStyle(ButtonStyle.Secondary).setDisabled(true);
  return new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(body)).setButtonAccessory(button);
}

function buildBoardPayload(userId, board, notice="", ephemeral=true) {
  const now=Date.now(), vote=board.vote||{}, nextVoteAt=Number(vote.nextVoteAt)||0, voteReady=nextVoteAt<=now;
  const voteStatus=!vote.lastVoteAt?"Available now — vote once every 12 hours."
    : voteReady?"✅ Your next vote is available now.":"⏰ Next vote: <t:"+Math.floor(nextVoteAt/1000)+":R>.";
  const voteText="### 🗳️ Permanent Quest — Vote for LOZ\n- Vote on Top.gg every 12 hours to earn **+2 Species Rolls**.\n**Status:** "+voteStatus
    +"\n**Verified votes credited:** "+(Number(vote.totalVotes)||0)
    +"\n**Reward delivery:** automatically added after Top.gg verifies your vote.";
  const container=new ContainerBuilder().setAccentColor(0x0891b2);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## 📜 QUEST BOARD\nComplete objectives to earn rewards. Active quests keep their progress and do not expire.\nYou can have up to **3 rotating quests**, plus the permanent vote quest."));
  if (notice) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent("✅ "+notice));
  }
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  const voteButton=new ButtonBuilder().setLabel(voteReady?"Vote on Top.gg":"Vote Cooldown");
  if (voteReady) voteButton.setStyle(ButtonStyle.Link).setURL(topggVoteUrl());
  else voteButton.setStyle(ButtonStyle.Secondary).setDisabled(true);
  container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(voteText)).setButtonAccessory(voteButton));
  for (const quest of board.quests||[]) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addSectionComponents(makeQuestSection(userId,quest));
  }
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  const nextQuestAt=Number(board.nextQuestAt)||now;
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("### Quest Rotation\nNew quests are added every 12 hours when a slot is available. Claimed quests stay visible for 5 minutes, then disappear.\n**Next scheduled addition:** <t:"+Math.floor(nextQuestAt/1000)+":R>\n**Vote reminders:** "+(vote.remindersEnabled===false?"Off":"On")));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("quest_reminders:"+userId).setLabel(vote.remindersEnabled===false?"Enable Vote Reminders":"Disable Vote Reminders").setStyle(vote.remindersEnabled===false?ButtonStyle.Success:ButtonStyle.Secondary)));
  return {components:[container],flags:MessageFlags.IsComponentsV2|(ephemeral?MessageFlags.Ephemeral:0),allowedMentions:{parse:[]}};
}

function buildVoteDmPayload(title, body, userId, canDisable=true) {
  const container=new ContainerBuilder().setAccentColor(0x0891b2);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## "+title+"\n"+body));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  const buttons=[new ButtonBuilder().setLabel("Vote on Top.gg").setStyle(ButtonStyle.Link).setURL(topggVoteUrl())];
  buttons.push(new ButtonBuilder().setCustomId((canDisable?"quest_reminders_off:":"quest_reminders_on:")+userId).setLabel(canDisable?"Turn Off Reminders":"Turn On Reminders").setStyle(canDisable?ButtonStyle.Secondary:ButtonStyle.Success));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(buttons));
  return {components:[container],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}};
}

async function sendVoteConfirmation(userId,nextVoteAt) {
  try {
    const target=await _client.users.fetch(userId);
    await target.send(buildVoteDmPayload("✅ Vote Done!","Top.gg verified your vote. **+2 Species Rolls have been added automatically** to your LOZ balance.\n\nYou can vote again <t:"+Math.floor(nextVoteAt/1000)+":R>. Run /quests any time to check your rewards and quest progress.",userId,true));
  } catch(e) { console.warn("[Top.gg] Vote was saved, but a confirmation DM could not be delivered to "+userId+": "+e.message); }
}

async function sendVoteReminder(userId) {
  try {
    const target=await _client.users.fetch(userId);
    await target.send(buildVoteDmPayload("🗳️ LOZ Vote Reminder","Your 12-hour vote cooldown has ended. Vote for LOZ on Top.gg to earn **+2 Species Rolls**. Your reward is added automatically after the vote is verified.\n\nVote reminders repeat every 12 hours until you vote again or turn them off.",userId,true));
  } catch(e) { console.warn("[Top.gg] Vote reminder could not be delivered to "+userId+": "+e.message); }
}

function syncRewardBalance(userId,rolls,speciesTokens) {
  if (!_state || !_state.userSpecies) return;
  let data=_state.userSpecies.get(userId);
  if (!data) data={species:humanSpecies,originalSpecies:humanSpecies,questSpecies:{},rolls:0,speciesTokens:0,requestsEnabled:true,lastSwitch:0,awakening:{},badges:[],guideRewardClaimed:false};
  data.rolls=Math.max(0,Number(rolls)||0);
  data.speciesTokens=Math.max(0,Number(speciesTokens)||0);
  _state.userSpecies.set(userId,data);
}

async function handleTopggVote(vote) {
  if (!_state || !_state.questBoards || !_client || !_client.user || !_client.user.id) throw new Error("LOZ is not ready to process votes.");
  const userId=String((vote&&vote.user)||"");
  if (!/^\d{17,20}$/.test(userId)) { console.warn("[Top.gg] Ignored vote payload with invalid user ID."); return {accepted:false,reason:"invalid_user"}; }
  if (vote&&vote.bot&&String(vote.bot)!==String(_client.user.id)) { console.warn("[Top.gg] Ignored a vote event addressed to a different bot."); return {accepted:false,reason:"wrong_bot"}; }
  const type=String((vote&&vote.type)||"upvote").toLowerCase();
  if (type==="test"||(vote&&vote.isTest===true)) { console.log("[Top.gg] Test webhook received; no reward was granted."); return {accepted:false,reason:"test"}; }
  if (type!=="upvote") { console.warn("[Top.gg] Ignored unsupported webhook type: "+type); return {accepted:false,reason:"unsupported_type"}; }
  return withUserLock(userId,async()=>{
    const board=await ensureBoardLocked(userId);
    const result=await database.awardTopggVote(userId,Date.now(),VOTE_INTERVAL_MS,VOTE_ROLL_REWARD);
    if (!result||!result.ok) throw new Error("MongoDB could not verify and record the Top.gg vote.");
    if (!result.accepted) { console.log("[Top.gg] Vote from "+userId+" was ignored because the 12-hour reward window is still active."); return {accepted:false,reason:"cooldown"}; }
    _state.questBoards.set(userId,result.boardData||board);
    syncRewardBalance(userId,result.rolls,result.speciesTokens);
    await sendVoteConfirmation(userId,result.nextVoteAt);
    console.log("[Top.gg] Verified vote credited to "+userId+"; +2 rolls.");
    return {accepted:true,nextVoteAt:result.nextVoteAt};
  });
}

async function trackProgress(userId,type,amount=1) {
  if (!userId||!_state||!_state.questBoards) return false;
  const id=String(userId);
  if (!_state.questBoards.has(id)) return false;
  try {
    return await withUserLock(id,async()=>{
      const currentBoard=_state.questBoards.get(id);
      if (!currentBoard||!Array.isArray(currentBoard.quests)) return false;
      // Work on a copy so a failed write cannot silently alter in-memory progress.
      const board=JSON.parse(JSON.stringify(currentBoard));
      const increment=Math.max(0,Number(amount)||0);
      if (!increment) return false;
      let changed=false;
      for (const quest of board.quests) {
        if (quest.status!=="active") continue;
        for (const objective of quest.objectives||[]) {
          if (objective.type!==type) continue;
          const target=Math.max(0,Number(objective.target)||0);
          const current=Math.max(0,Number(objective.progress)||0);
          if (current>=target) continue;
          objective.progress=Math.min(target,current+increment);
          changed=true;
        }
      }
      if (changed) await saveBoard(id,board);
      return changed;
    });
  } catch(error) {
    // Quest storage failures must never cancel a player's battle turn or outcome.
    console.error("[Quests] Could not record "+type+" progress for "+id+":",error.message);
    return false;
  }
}

async function claimQuest(userId,questId) {
  const id=String(userId);
  return withUserLock(id,async()=>{
    const board=await ensureBoardLocked(id);
    const quest=(board.quests||[]).find(item=>item.id===questId);
    if (!quest) return {ok:false,reason:"not_found",board};
    if (quest.status==="claimed") return {ok:false,reason:"claimed",board};
    if (!isQuestComplete(quest)) return {ok:false,reason:"not_ready",board};
    const result=await database.claimQuestReward(id,questId,Date.now());
    if (!result||!result.ok) return {ok:false,reason:(result&&result.reason)||"database",board};
    _state.questBoards.set(id,result.boardData||board);
    syncRewardBalance(id,result.rolls,result.speciesTokens);
    return {ok:true,board:result.boardData||board,reward:result.reward,questTitle:result.questTitle};
  });
}

async function setReminders(userId,enabled) {
  const id=String(userId);
  return withUserLock(id,async()=>{
    const board=await ensureBoardLocked(id);
    board.vote.remindersEnabled=Boolean(enabled);
    await saveBoard(id,board);
    return board;
  });
}

async function handleButton(interaction) {
  const customId=interaction.customId,user=interaction.user;
  if (customId.startsWith("quest_") && interaction.webhook) rememberBoardView(user.id,interaction.webhook);
  if (customId.startsWith("quest_claim:")) {
    const parts=customId.split(":");
    const ownerId=parts[1],questId=parts.slice(2).join(":");
    if (user.id!==ownerId) { await interaction.reply({content:"This quest board belongs to another player. Run /quests to open your own.",flags:MessageFlags.Ephemeral}); return true; }
    await interaction.deferUpdate();
    const result=await claimQuest(user.id,questId);
    let notice;
    if (result.ok) notice="Claimed "+result.questTitle+". Reward delivered: "+formatReward(result.reward)+".";
    else if (result.reason==="not_ready") notice="That quest is not complete yet. Keep progressing; no reward was granted.";
    else if (result.reason==="claimed") notice="That quest has already been claimed. It will disappear after 5 minutes.";
    else if (result.reason==="not_found") notice="That quest is no longer on your board. Reopen /quests to refresh the display.";
    else notice="MongoDB could not confirm the reward, so no local balance was changed. Please retry in a moment.";
    return interaction.editReply(await renderBoardWithNotice(user.id,notice));
  }
  if (customId.startsWith("quest_progress:")||customId.startsWith("quest_claimed:")) {
    await interaction.reply({content:"This quest action is no longer available. Run /quests to refresh your board.",flags:MessageFlags.Ephemeral});
    return true;
  }
  if (customId.startsWith("quest_reminders:")) {
    const expectedUserId=customId.slice("quest_reminders:".length);
    if (user.id!==expectedUserId) { await interaction.reply({content:"These reminder settings belong to another player.",flags:MessageFlags.Ephemeral}); return true; }
    const existing=_state.questBoards.get(user.id);
    const enable=!!(existing&&existing.vote&&existing.vote.remindersEnabled===false);
    await interaction.deferUpdate();
    const board=await setReminders(user.id,enable);
    return interaction.editReply(buildBoardPayload(user.id,board,"Vote reminders are now "+(enable?"on":"off")+".",false));
  }
  if (customId.startsWith("quest_reminders_off:")||customId.startsWith("quest_reminders_on:")) {
    const off=customId.startsWith("quest_reminders_off:");
    const expectedUserId=customId.slice(off?"quest_reminders_off:".length:"quest_reminders_on:".length);
    if (user.id!==expectedUserId) { await interaction.reply({content:"These reminder settings belong to another player.",flags:MessageFlags.Ephemeral}); return true; }
    await interaction.deferUpdate();
    await setReminders(user.id,!off);
    const payload=buildVoteDmPayload("Vote Reminders Updated","Vote reminders are now **"+(off?"disabled":"enabled")+"**. You can change this any time with /quests.",user.id,!off);
    return interaction.editReply({components:payload.components,flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}});
  }
  return false;
}

async function renderBoardWithNotice(userId,notice) {
  return withUserLock(String(userId),async()=>{
    const board=await ensureBoardLocked(String(userId));
    return buildBoardPayload(String(userId),board,notice||"",false);
  });
}

async function tickUser(userId) {
  await withUserLock(userId,async()=>{
    const board=_state.questBoards.get(userId);
    if (!board) return;
    const now=Date.now();
    let changed=false;
    const retained=(board.quests||[]).filter(quest=>quest.status!=="claimed"||now-(Number(quest.claimedAt)||0)<CLAIMED_VISIBLE_MS);
    if (retained.length!==(board.quests||[]).length) { board.quests=retained; changed=true; }
    if (now>=(Number(board.nextQuestAt)||0)&&board.quests.length<MAX_ROTATING_QUESTS) {
      board.quests.push(createQuest(now));
      board.nextQuestAt=now+QUEST_INTERVAL_MS;
      changed=true;
    }
    if (changed) {
      await saveBoard(userId,board);
      await refreshBoardViews(userId,board);
    }
    const vote=board.vote||{},lastVoteAt=Number(vote.lastVoteAt)||0;
    if (lastVoteAt>0&&vote.remindersEnabled!==false) {
      const nextVoteAt=Number(vote.nextVoteAt)||lastVoteAt+VOTE_INTERVAL_MS;
      const lastReminderAt=Number(vote.lastReminderAt)||lastVoteAt;
      const reminderAt=Math.max(nextVoteAt,lastReminderAt+VOTE_INTERVAL_MS);
      if (now>=reminderAt) {
        vote.lastReminderAt=now;
        board.vote=vote;
        await saveBoard(userId,board);
        await sendVoteReminder(userId);
      }
    }
  });
}

async function tick() {
  if (!_state||!_state.questBoards||!_client||!_client.user) return;
  for (const userId of _state.questBoards.keys()) {
    try { await tickUser(userId); }
    catch(e) { console.error("[Quests] Scheduled board update failed for "+userId+":",e.message); }
  }
}

function startScheduler() {
  if (_scheduler) return;
  _scheduler=setInterval(()=>{ tick().catch(error=>console.error("[Quests] Scheduler error:",error.message)); },30*1000);
  if (_scheduler.unref) _scheduler.unref();
}

module.exports={setState,setClient,openBoard,handleTopggVote,trackProgress,claimQuest,handleButton,startScheduler};
