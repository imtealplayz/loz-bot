"use strict";

const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SectionBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SeparatorSpacingSize,
} = require("discord.js");
const database = require("./database.js");
const {
  speciesList, dragonSpecies, humanSpecies, godSpecies, reaperSpecies,
  archdemonSpecies, slimeLordSpecies, eclipsedSovereignSpecies, chaosCreatorSpecies,
  trueDragonSpecies,
} = require("./constants.js");

const GLORY = "<:Glory:1559650326011711579>";
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DRAGON_KEYS = ["Fire", "Thunder", "Ice", "Earth"];
const BOT_LEVELS = ["easy", "medium", "hard", "impossible", "brutal"];
const NORMAL_ACHIEVEMENTS = [
  {key:"daily-streak",title:"Daily Devotion",metric:"dailyStreak",milestones:[7,14,30,50,100,250,500,1000],rewards:[1,1,2,2,3,5,8,12],description:"Build your consecutive daily-claim streak."},
  {key:"total-wins",title:"Battle-Hardened",metric:"totalWins",milestones:[10,25,50,100,250,500],rewards:[1,2,2,3,5,8],description:"Win battles against players or LOZ bots."},
  {key:"total-battles",title:"Veteran of the Rift",metric:"totalBattles",milestones:[25,50,100,250,500,1000],rewards:[1,2,3,4,6,9],description:"Complete battles. Both wins and losses count."},
  {key:"pvp-wins",title:"Duelist",metric:"pvpWins",milestones:[5,10,25,50,100,250],rewards:[1,2,3,4,6,9],description:"Win player-versus-player battles."},
  {key:"pvp-battles",title:"Arena Regular",metric:"pvpBattles",milestones:[10,25,50,100,250,500],rewards:[1,2,3,4,6,8],description:"Complete player-versus-player battles. Both wins and losses count."},
  {key:"bot-wins",title:"Bot Breaker",metric:"botWins",milestones:[5,10,25,50,100,250],rewards:[1,2,3,4,6,9],description:"Defeat LOZ bots at any difficulty."},
  {key:"bot-battles",title:"Trial by Machine",metric:"botBattles",milestones:[10,25,50,100,250,500],rewards:[1,2,3,4,6,8],description:"Complete battles against LOZ bots. Wins and losses count."},
  {key:"rolls-held",title:"Stockpiler",metric:"rollsHeld",milestones:[5,10,25,50,100],rewards:[1,1,2,3,5],description:"Keep this many unspent Species Rolls in your balance."},
  {key:"rolls-used",title:"Rift Spinner",metric:"rollsUsed",milestones:[10,25,50,100,250,500],rewards:[1,2,2,3,5,8],description:"Spend Species Rolls through the reroll panel. Tracking starts with this update."},
  {key:"daily-claims",title:"Ritual Regular",metric:"dailyClaims",milestones:[7,30,100,250,500],rewards:[1,2,3,5,8],description:"Claim daily rewards. Tracking starts with this update."},
  {key:"slime-lord",title:"Apex Hunter",metric:"slimeLordBossWins",milestones:[1,3,5,10],rewards:[2,3,5,8],description:"Defeat the Slime Lord boss."},
  {key:"ultimates",title:"Ultimate Mastery",metric:"ultimates",milestones:[10,25,50,100,250],rewards:[1,2,3,5,8],description:"Use your species ultimate in battle."},
];
const AWAKENING_SPECIES = {
  "Cyborg":{path:"cyborg",target:"Mechangel",description:"Complete the existing Cyborg awakening."},
  "Demon":{path:"demon",target:"Archdemon",description:"Complete the existing Demon awakening."},
  "Half-Blood":{path:"halfBlood",target:"Eclipsed Sovereign",description:"Complete the existing Half-Blood awakening."},
};

function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
}
function normaliseProfile(data) {
  data = data && typeof data === "object" ? data : {};
  data.glory = Math.max(0,Number(data.glory)||0);
  data.counters = Object.assign({dailyClaims:0,rollsUsed:0,ultimates:0,slimeLordBossWins:0,slimeLordBossBattles:0},data.counters||{});
  data.speciesCounters = data.speciesCounters && typeof data.speciesCounters === "object" ? data.speciesCounters : {};
  data.claimed = data.claimed && typeof data.claimed === "object" ? data.claimed : {};
  data.dragonClaims = data.dragonClaims && typeof data.dragonClaims === "object" ? data.dragonClaims : {};
  data.dragonAwakened = data.dragonAwakened && typeof data.dragonAwakened === "object" ? data.dragonAwakened : {};
  return data;
}
const profileCache = new Map();
const userLocks = new Map();
async function withUserLock(userId,task) {
  const id=String(userId), previous=userLocks.get(id)||Promise.resolve();
  const running=previous.catch(function(){}).then(task);
  userLocks.set(id,running);
  try { return await running; }
  finally { if(userLocks.get(id)===running) userLocks.delete(id); }
}
async function loadProfile(userId,bypassCache=false) {
  const id=String(userId);
  if(!bypassCache && profileCache.has(id)) return {ok:true,data:normaliseProfile(JSON.parse(JSON.stringify(profileCache.get(id))))};
  const result=await database.getAchievementProfile(id);
  if(!result || !result.ok) return {ok:false,data:null};
  const data=normaliseProfile(result.data||{});
  profileCache.set(id,JSON.parse(JSON.stringify(data)));
  return {ok:true,data:JSON.parse(JSON.stringify(data))};
}
async function saveProfile(userId,data) {
  const clean=normaliseProfile(data);
  const ok=await database.saveAchievementProfile(String(userId),clean);
  if(ok) profileCache.set(String(userId),JSON.parse(JSON.stringify(clean)));
  return ok;
}
async function mutateProfile(userId,mutate) {
  return withUserLock(userId,async function(){
    const loaded=await loadProfile(userId,true);
    if(!loaded.ok) return {ok:false};
    const data=loaded.data;
    const outcome=await mutate(data);
    if(outcome && outcome.abort) return {ok:true,data,outcome};
    data.updatedAt=Date.now();
    const saved=await saveProfile(userId,data);
    return {ok:saved,data,outcome};
  });
}
function getSpeciesRoster() {
  const normal=speciesList.filter(function(s){return Number(s.rarity)>0;})
    .slice().sort(function(a,b){return Number(b.rarity)-Number(a.rarity)||a.name.localeCompare(b.name);});
  const awakeningForms=speciesList.filter(function(s){return Number(s.rarity)===0;});
  const dragons=dragonSpecies.types.map(function(t){
    return {name:t.type+" Dragon",emoji:t.emoji+"🐉",rarity:0,category:"Dragon Awakening"};
  });
  const secret=[godSpecies,reaperSpecies,archdemonSpecies,slimeLordSpecies,eclipsedSovereignSpecies,chaosCreatorSpecies,trueDragonSpecies];
  const result=[], seen=new Set();
  function add(species,category) {
    if(!species||!species.name||seen.has(species.name)) return;
    seen.add(species.name);
    result.push({name:species.name,emoji:species.emoji||"✨",rarity:Number(species.rarity)||0,category:category,species:species});
  }
  add(humanSpecies,"Common");
  normal.forEach(function(s){add(s,"Rarity");});
  dragons.forEach(function(s){add(s,"Dragon Awakening");});
  awakeningForms.forEach(function(s){add(s,"Awakening Form");});
  secret.forEach(function(s){add(s,s.name==="Human"?"Common":s.name==="True Dragon"?"Secret Awakening":"Quest / Secret");});
  return result;
}
const SPECIES_ROSTER=getSpeciesRoster();
function botTotals(state,userId) {
  const data=state.botStats.get(String(userId))||{};
  let wins=0,losses=0;
  BOT_LEVELS.forEach(function(key){wins+=Math.max(0,Number(data[key]&&data[key].wins)||0);losses+=Math.max(0,Number(data[key]&&data[key].losses)||0);});
  return {wins:wins,losses:losses};
}
function getMetrics(userId,state,profile) {
  const fight=state.fightStats.get(String(userId))||{}, bot=botTotals(state,userId);
  const wins=Math.max(0,Number(fight.wins)||0),losses=Math.max(0,Number(fight.losses)||0);
  const daily=state.dailyClaims.get(String(userId))||{}, user=state.userSpecies.get(String(userId))||{};
  const bossWins=Math.max(0,Number(profile.counters.slimeLordBossWins)||0);
  const bossBattles=Math.max(0,Number(profile.counters.slimeLordBossBattles)||0);
  return {
    dailyStreak:Math.max(0,Number(daily.streak)||0),
    totalWins:wins+bossWins,
    totalBattles:wins+losses+bossBattles,
    pvpWins:Math.max(0,wins-bot.wins),
    pvpBattles:Math.max(0,wins+losses-bot.wins-bot.losses),
    botWins:bot.wins+bossWins,
    botBattles:bot.wins+bot.losses+bossBattles,
    rollsHeld:Math.max(0,Number(user.rolls)||0),
    rollsUsed:Math.max(0,Number(profile.counters.rollsUsed)||0),
    dailyClaims:Math.max(0,Number(profile.counters.dailyClaims)||0),
    slimeLordBossWins:Math.max(0,Number(profile.counters.slimeLordBossWins)||0),
    ultimates:Math.max(0,Number(profile.counters.ultimates)||0),
  };
}
function progressBar(value,target,width=8) {
  const max=Math.max(1,Number(target)||1), n=Math.max(0,Math.min(max,Number(value)||0));
  const filled=Math.round(n/max*width);
  return "▰".repeat(filled)+"▱".repeat(width-filled)+" "+n.toLocaleString()+"/"+max.toLocaleString();
}
function divider(container) {
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}
function addSection(container,body,button) {
  container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(body)).setButtonAccessory(button));
}
function makeClaimButton(customId,ready,claimed,reward) {
  // Discord requires every component in a message to have a unique custom ID,
  // including disabled buttons. Keep the routing prefix while deriving uniqueness
  // from the task's otherwise-unique active claim ID.
  const uniqueSuffix=String(customId||"").replace(/^ach:/,"");
  if(claimed) return new ButtonBuilder().setCustomId("ach:claimed:"+uniqueSuffix).setLabel("Claimed").setStyle(ButtonStyle.Success).setDisabled(true);
  if(ready) return new ButtonBuilder().setCustomId(customId).setLabel("Claim "+reward+" Glory").setStyle(ButtonStyle.Primary);
  return new ButtonBuilder().setCustomId("ach:locked:"+uniqueSuffix).setLabel("In Progress").setStyle(ButtonStyle.Secondary).setDisabled(true);
}
function formatClaimSummary(claims,fallback) {
  if(!Array.isArray(claims)||!claims.length) return fallback||"No achievements on this page were ready to claim.";
  const total=claims.reduce(function(sum,item){return sum+Math.max(0,Number(item.reward)||0);},0);
  const lines=claims.map(function(item){
    return "• **"+item.title+"**"+(item.detail?" · "+item.detail:"")+" · **+"+(Number(item.reward)||0)+" Glory**";
  });
  return "Claimed "+claims.length+" achievement "+(claims.length===1?"reward":"rewards")+" for "+GLORY+" **+"+total+" Glory**:\n"+lines.join("\n");
}
function addTask(container,task,dividerAfter=true) {
  const status=task.claimed?"\n**Status:** Claimed":task.ready?"\n**Status:** Ready to claim":"";
  addSection(container,"### "+task.title+"\n"+task.description+"\n"+progressBar(task.value,task.target)+"\n**Reward:** "+GLORY+" **+"+task.reward+"**"+status,
    makeClaimButton(task.customId,task.ready,task.claimed,task.reward));
  if(dividerAfter) divider(container);
}
function buildHome(userId,profile) {
  const container=new ContainerBuilder().setAccentColor(0x7562d9);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    "## "+GLORY+" GLORY ARCHIVES\nEarn Glory by reaching personal milestones and proving your mastery of every species.\n\n**Your Glory:** "+profile.glory.toLocaleString()
  ));
  divider(container);
  addSection(container,"### ⚔️ Normal Achievements\nBattle wins, total battles, daily streaks, rolls, ultimate uses, and boss milestones.",new ButtonBuilder().setCustomId("ach:normal:"+userId+":0").setLabel("View").setStyle(ButtonStyle.Primary));
  divider(container);
  addSection(container,"### 🐉 Species Achievements\nEach playable species has an individual mastery trial. Dragon variants and awakening forms have additional objectives.",new ButtonBuilder().setCustomId("ach:species:"+userId+":0").setLabel("View").setStyle(ButtonStyle.Primary));
  divider(container);
  addSection(container,"### 🏆 Glory Leaderboard\nSee the global Top 25. Only the Top 10 receive rank-update DMs.",new ButtonBuilder().setCustomId("ach:leaderboard:"+userId).setLabel("View").setStyle(ButtonStyle.Secondary));
  return {components:[container],flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,allowedMentions:{parse:[]}};
}
function buildNormalPage(userId,state,profile,page,notice) {
  const pageCount=Math.ceil(NORMAL_ACHIEVEMENTS.length/4),safePage=Math.max(0,Math.min(pageCount-1,Number(page)||0));
  const metrics=getMetrics(userId,state,profile),container=new ContainerBuilder().setAccentColor(0x7562d9);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## "+GLORY+" NORMAL ACHIEVEMENTS\nOnly the next milestone for each achievement is shown. Claiming it unlocks the next milestone."+(notice?"\n\n✅ "+notice:"")));
  divider(container);
  const visible= NORMAL_ACHIEVEMENTS.slice(safePage*4,safePage*4+4);
  visible.forEach(function(def,visibleIndex){
    const stage=Math.max(0,Number(profile.claimed["normal:"+def.key])||0);
    const done=stage>=def.milestones.length;
    const target=done?def.milestones[def.milestones.length-1]:def.milestones[stage];
    const reward=done?0:def.rewards[stage],value=Number(metrics[def.metric])||0,ready=!done&&value>=target;
    addTask(container,{
      title:def.title,description:def.description,value:value,target:target,reward:reward,
      claimed:done,ready:ready,customId:"ach:claim-normal:"+userId+":"+def.key+":"+stage+":"+safePage,
    },visibleIndex<visible.length-1);
  });
  const hasReadyClaim=visible.some(function(def){
    const stage=Math.max(0,Number(profile.claimed["normal:"+def.key])||0);
    return stage<def.milestones.length&&(Number(metrics[def.metric])||0)>=def.milestones[stage];
  });
  const nav=[new ButtonBuilder().setCustomId("ach:claim-all-normal:"+userId+":"+safePage).setLabel("Claim All").setStyle(ButtonStyle.Success).setDisabled(!hasReadyClaim)];
  if(safePage>0) nav.push(new ButtonBuilder().setCustomId("ach:normal:"+userId+":"+(safePage-1)).setLabel("Previous").setStyle(ButtonStyle.Secondary));
  nav.push(new ButtonBuilder().setCustomId("ach:home").setLabel("Back").setStyle(ButtonStyle.Secondary));
  if((safePage+1)*4<NORMAL_ACHIEVEMENTS.length) nav.push(new ButtonBuilder().setCustomId("ach:normal:"+userId+":"+(safePage+1)).setLabel("Next").setStyle(ButtonStyle.Primary));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(nav));
  return {components:[container],flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,allowedMentions:{parse:[]}};
}
function buildSpeciesListPage(userId,page,notice) {
  const pages=Math.max(1,Math.ceil(SPECIES_ROSTER.length/4)),safePage=Math.max(0,Math.min(pages-1,Number(page)||0));
  const container=new ContainerBuilder().setAccentColor(0x0891b2);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## 🐉 SPECIES ACHIEVEMENTS\nSpecies are ordered from common to rare, followed by dragon awakenings, awakening forms, and secret species. Open a species to view its quests."+(notice?"\n\n✅ "+notice:"")));
  divider(container);
  const visible=SPECIES_ROSTER.slice(safePage*4,safePage*4+4);
  visible.forEach(function(entry,visibleIndex){
    const category=entry.category+(entry.rarity?" · rarity weight "+entry.rarity:"");
    addSection(container,"### "+entry.emoji+" "+entry.name+"\n**Category:** "+category+"\nComplete its personal mastery trial to earn Glory.",
      new ButtonBuilder().setCustomId("ach:open:"+userId+":"+slug(entry.name)+":0").setLabel("View").setStyle(ButtonStyle.Primary));
    if(visibleIndex<visible.length-1) divider(container);
  });
  const nav=[];
  if(safePage>0) nav.push(new ButtonBuilder().setCustomId("ach:species:"+userId+":"+(safePage-1)).setLabel("Previous").setStyle(ButtonStyle.Secondary));
  nav.push(new ButtonBuilder().setCustomId("ach:home").setLabel("Back").setStyle(ButtonStyle.Secondary));
  if((safePage+1)*4<SPECIES_ROSTER.length) nav.push(new ButtonBuilder().setCustomId("ach:species:"+userId+":"+(safePage+1)).setLabel("Next").setStyle(ButtonStyle.Primary));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(nav));
  return {components:[container],flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,allowedMentions:{parse:[]}};
}
function getEntry(speciesSlug) {
  return SPECIES_ROSTER.find(function(entry){return slug(entry.name)===speciesSlug;})||null;
}
function dragonKeyForName(name) {
  return DRAGON_KEYS.find(function(key){return name===key+" Dragon";})||null;
}
function getSpeciesCounters(profile,name) {
  return profile.speciesCounters[name]||{battles:0,wins:0,losses:0,ults:0,pvpBattles:0,pvpWins:0,botBattles:0,botWins:0};
}
function makeSpeciesTrial(entry) {
  const name=entry.name;
  let metric="battles",target=5,reward=2,title=name+" Mastery",description="Complete 5 battles using "+name+". Both wins and losses count.";
  if(name==="True Dragon") {target=8;reward=4;title="Fourfold Cataclysm";description="Complete 8 battles while equipped as True Dragon. Both wins and losses count.";}
  else if(name==="Slime Lord") {metric="wins";target=6;reward=3;title="Adaptive Predator";description="Win 6 battles as Slime Lord.";}
  else if(name==="God"||name==="Demi God"||name==="Chaos Creator") {metric="wins";target=10;reward=3;title="Apex Authority";description="Win 10 battles as "+name+".";}
  else if(name==="Reaper"||name==="Archdemon"||name==="Eclipsed Sovereign"||name==="Mechangel") {metric="wins";target=7;reward=3;title=name+" Ascendancy";description="Win 7 battles using "+name+".";}
  else if(name.endsWith("Dragon")) {metric="wins";target=6;reward=3;title="Elemental Dominance";description="Win 6 battles using "+name+".";}
  else if(Number(entry.rarity)>0&&Number(entry.rarity)<=6) {metric="wins";target=8;reward=3;title="Rare Species Mastery";description="Win 8 battles using "+name+".";}
  return {id:"species:"+slug(name),metric:metric,target:target,reward:reward,title:title,description:description};
}
function hasAwakened(userData,name) {
  const def=AWAKENING_SPECIES[name];
  return Boolean(def&&userData&&userData.awakening&&userData.awakening[def.path]&&userData.awakening[def.path].awakened===true);
}
function dragonIsAwakened(profile,userData,key) {
  const id=key.toLowerCase(),stored=userData&&userData.awakening&&userData.awakening.trueDragon&&userData.awakening.trueDragon.variants;
  return profile.dragonAwakened[id]===true||Boolean(stored&&stored[id]&&stored[id].awakened===true);
}
function buildSpeciesTasks(userId,state,profile,speciesSlug) {
  const entry=getEntry(speciesSlug);
  if(!entry) return {entry:null,tasks:[]};
  const userData=state.userSpecies.get(String(userId))||{};
  const tasks=[],trial=makeSpeciesTrial(entry),counters=getSpeciesCounters(profile,entry.name),trialClaimed=profile.claimed[trial.id]===true;
  tasks.push({
    kind:"species",achievementId:trial.id,speciesName:entry.name,
    title:trial.title,description:trial.description,metric:trial.metric,
    value:Number(counters[trial.metric])||0,target:trial.target,reward:trial.reward,
    claimed:trialClaimed,ready:!trialClaimed&&(Number(counters[trial.metric])||0)>=trial.target,
    customId:"ach:claim-species:"+userId+":"+slug(entry.name),
  });
  const dragonKey=dragonKeyForName(entry.name);
  if(dragonKey) {
    const key=dragonKey.toLowerCase(),claimed=profile.dragonClaims[key]||{};
    const dragonTasks=[
      {title:"Elemental Presence",metric:"battles",target:5,reward:1,description:"Complete 5 battles with "+entry.name+". Wins and losses count."},
      {title:"Elemental Conquest",metric:"wins",target:3,reward:2,description:"Win 3 battles with "+entry.name+"."},
      {title:"Elemental Mastery",metric:"ults",target:2,reward:2,description:"Use your ultimate twice with "+entry.name+"."},
    ];
    dragonTasks.forEach(function(task,index){
      const value=Math.max(0,Number(counters[task.metric])||0),isClaimed=claimed[String(index)]===true;
      tasks.push({
        kind:"dragon",dragonSlug:key,taskIndex:index,title:task.title,description:task.description,
        metric:task.metric,value:value,target:task.target,reward:task.reward,
        claimed:isClaimed,ready:!isClaimed&&value>=task.target,
        customId:"ach:claim-dragon:"+userId+":"+key+":"+index,
      });
    });
    const allTrialsClaimed=claimed["0"]===true&&claimed["1"]===true&&claimed["2"]===true;
    const awakened=dragonIsAwakened(profile,userData,dragonKey),gloryClaimed=profile.dragonAwakened[key]===true;
    tasks.push({
      kind:"dragon-awakening",dragonKey:dragonKey,dragonSlug:key,
      title:"Awaken "+entry.name,
      description:"Claim all three elemental trials to awaken this variant. All four variants must be awakened independently to unlock True Dragon.",
      metric:"awakening",value:awakened?1:allTrialsClaimed?1:0,target:1,reward:3,
      claimed:gloryClaimed,ready:!gloryClaimed&&allTrialsClaimed,
      customId:"ach:awaken-dragon:"+userId+":"+dragonKey,
    });
  }
  if(AWAKENING_SPECIES[entry.name]) {
    const awakened=hasAwakened(userData,entry.name),id="awakening:"+slug(entry.name),wasClaimed=profile.claimed[id]===true;
    tasks.push({
      kind:"awakening",achievementId:id,speciesSlug:slug(entry.name),
      title:AWAKENING_SPECIES[entry.name].target+" Awakening",
      description:AWAKENING_SPECIES[entry.name].description+" Existing saved progress is used; this does not reset or replace the awakening.",
      metric:"awakening",value:awakened?1:0,target:1,reward:3,claimed:wasClaimed,ready:awakened&&!wasClaimed,
      customId:"ach:claim-awakening:"+userId+":"+slug(entry.name),
    });
  }
  if(entry.name==="True Dragon") {
    const unlocked=Boolean(userData.awakening&&userData.awakening.trueDragon&&(userData.awakening.trueDragon.awakened||userData.awakening.trueDragon.unlocked)),id="awakening:true-dragon",wasClaimed=profile.claimed[id]===true;
    tasks.push({
      kind:"awakening",achievementId:id,speciesSlug:slug(entry.name),
      title:"True Dragon Awakening",
      description:"Unlock True Dragon by awakening all four elemental variants, or receiving an owner-granted unlock.",
      metric:"awakening",value:unlocked?1:0,target:1,reward:3,claimed:wasClaimed,ready:unlocked&&!wasClaimed,
      customId:"ach:claim-awakening:"+userId+":true-dragon",
    });
  }
  return {entry,tasks};
}
function buildSpeciesDetailPage(userId,state,profile,speciesSlug,page,notice) {
  const built=buildSpeciesTasks(userId,state,profile,speciesSlug);
  if(!built.entry) return buildSpeciesListPage(userId,0,"That species entry could not be found.");
  const entry=built.entry,tasks=built.tasks,container=new ContainerBuilder().setAccentColor(entry.species.color||0x0891b2);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## "+entry.emoji+" "+entry.name+" · SPECIES TRIALS\nClaim All collects every ready reward shown on this page and lists what you earned."+(notice?"\n\n✅ "+notice:"")));
  divider(container);
  const pageCount=Math.max(1,Math.ceil(tasks.length/4)),safePage=Math.max(0,Math.min(pageCount-1,Number(page)||0));
  const visible=tasks.slice(safePage*4,safePage*4+4);
  visible.forEach(function(task,visibleIndex){addTask(container,Object.assign({},task,{value:task.value||0,customId:task.customId+":"+safePage}),visibleIndex<visible.length-1);});
  const hasReadyClaim=visible.some(function(task){return task.ready;});
  const nav=[new ButtonBuilder().setCustomId("ach:claim-all-species:"+userId+":"+speciesSlug+":"+safePage).setLabel("Claim All").setStyle(ButtonStyle.Success).setDisabled(!hasReadyClaim)];
  nav.push(new ButtonBuilder().setCustomId("ach:species:"+userId+":0").setLabel("Back to Species").setStyle(ButtonStyle.Secondary));
  if(safePage>0) nav.push(new ButtonBuilder().setCustomId("ach:open:"+userId+":"+speciesSlug+":"+(safePage-1)).setLabel("Previous").setStyle(ButtonStyle.Secondary));
  if((safePage+1)*4<tasks.length) nav.push(new ButtonBuilder().setCustomId("ach:open:"+userId+":"+speciesSlug+":"+(safePage+1)).setLabel("Next").setStyle(ButtonStyle.Primary));
  nav.push(new ButtonBuilder().setCustomId("ach:home").setLabel("Achievement Menu").setStyle(ButtonStyle.Secondary));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(nav));
  return {components:[container],flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,allowedMentions:{parse:[]}};
}
function formatLeaderboardRow(entry, rank) {
  const userId=String(entry && entry.userId || "");
  // A Discord mention renders the user's current display name in this server and
  // avoids stale/incorrect username strings. allowedMentions below prevents pings.
  const player=/^\d{17,20}$/.test(userId) ? "<@"+userId+">" : "Unknown Player";
  const prefix=rank===1?"🥇":rank===2?"🥈":rank===3?"🥉":"**#"+String(rank).padStart(2,"0")+"**";
  const glory=Math.max(0,Number(entry && entry.glory)||0).toLocaleString();
  return prefix+" "+(rank<=10?"🏅 ":"")+"**"+player+"** · "+GLORY+" **"+glory+" Glory**";
}
async function buildLeaderboardPayload(client) {
  const entries=await database.getGloryLeaderboardTop(25),container=new ContainerBuilder().setAccentColor(0xe0b64c);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## 🏆 "+GLORY+" GLOBAL GLORY LEADERBOARD\nTop 25 players ranked by total Glory. Top 10 players receive in-profile rank badges and rank-update DMs."));
  divider(container);
  if(entries===null) container.addTextDisplayComponents(new TextDisplayBuilder().setContent("MongoDB could not load the Glory leaderboard. Please try again later."));
  else if(!entries.length) container.addTextDisplayComponents(new TextDisplayBuilder().setContent("No Glory has been earned yet. Open /achievements to begin."));
  else {
    const rows=[];
    for(let index=0;index<entries.length;index++) {
      rows.push(formatLeaderboardRow(entries[index],index+1));
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(rows.join("\n")));
  }
  return {components:[container],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}};
}
async function recordBattle(userId,species,options) {
  options=options||{};
  if(!species||!species.name) return;
  const result=await mutateProfile(userId,function(profile){
    const name=species.name,entry=profile.speciesCounters[name]||{battles:0,wins:0,losses:0,ults:0,pvpBattles:0,pvpWins:0,botBattles:0,botWins:0};
    entry.battles=(Number(entry.battles)||0)+1;
    if(options.won) entry.wins=(Number(entry.wins)||0)+1; else entry.losses=(Number(entry.losses)||0)+1;
    if(options.mode==="pvp") {
      entry.pvpBattles=(Number(entry.pvpBattles)||0)+1;
      if(options.won) entry.pvpWins=(Number(entry.pvpWins)||0)+1;
    } else {
      entry.botBattles=(Number(entry.botBattles)||0)+1;
      if(options.won) entry.botWins=(Number(entry.botWins)||0)+1;
    }
    profile.speciesCounters[name]=entry;
    if(options.boss) {
      profile.counters.slimeLordBossBattles=(Number(profile.counters.slimeLordBossBattles)||0)+1;
      if(options.won) profile.counters.slimeLordBossWins=(Number(profile.counters.slimeLordBossWins)||0)+1;
    }
  });
  if(!result.ok) console.warn("[Achievements] Could not record battle for "+userId);
}
async function recordUltimate(userId,species) {
  if(!species||!species.name) return;
  const result=await mutateProfile(userId,function(profile){
    profile.counters.ultimates=(Number(profile.counters.ultimates)||0)+1;
    const entry=profile.speciesCounters[species.name]||{battles:0,wins:0,losses:0,ults:0,pvpBattles:0,pvpWins:0,botBattles:0,botWins:0};
    entry.ults=(Number(entry.ults)||0)+1;
    profile.speciesCounters[species.name]=entry;
  });
  if(!result.ok) console.warn("[Achievements] Could not record ultimate for "+userId);
}
async function recordDailyClaim(userId) {
  const result=await mutateProfile(userId,function(profile){profile.counters.dailyClaims=(Number(profile.counters.dailyClaims)||0)+1;});
  if(!result.ok) console.warn("[Achievements] Could not record daily claim for "+userId);
}
async function recordRollUsed(userId) {
  const result=await mutateProfile(userId,function(profile){profile.counters.rollsUsed=(Number(profile.counters.rollsUsed)||0)+1;});
  if(!result.ok) console.warn("[Achievements] Could not record roll use for "+userId);
}
async function renderHome(userId) {
  const loaded=await loadProfile(userId);
  if(!loaded.ok) return {components:[new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent("Glory data is unavailable. Please try again shortly."))],flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral};
  return buildHome(userId,loaded.data);
}
async function renderNormal(userId,state,page,notice) {
  const loaded=await loadProfile(userId);
  if(!loaded.ok) return {components:[new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent("Glory data is unavailable. Please try again shortly."))],flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral};
  return buildNormalPage(userId,state,loaded.data,page,notice);
}
async function renderDetail(userId,state,speciesSlug,page,notice) {
  const loaded=await loadProfile(userId);
  if(!loaded.ok) return buildSpeciesListPage(userId,0,"Glory data is unavailable. Please retry.");
  return buildSpeciesDetailPage(userId,state,loaded.data,speciesSlug,page,notice);
}
async function open(userId) {return renderHome(String(userId));}
async function claimDragonAwakeningGlory(userId,speciesSlug,dragonKey) {
  return mutateProfile(userId,function(profile) {
    if(profile.dragonAwakened[speciesSlug]===true)
      return {abort:true,alreadyAwarded:true};
    profile.dragonAwakened[speciesSlug]=true;
    profile.glory+=3;
    return {awarded:true,notice:"Awarded 3 Glory for awakening "+dragonKey+" Dragon."};
  });
}
async function applyDragonAwakening(userId,state,dragonKey) {
  const speciesSlug=String(dragonKey||"").toLowerCase();
  const loaded=await loadProfile(userId,true);
  if(!DRAGON_KEYS.includes(dragonKey)||!loaded.ok) return {ok:false,notice:"Dragon awakening data is unavailable.",rewards:[]};
  const profile=loaded.data,claimed=profile.dragonClaims[speciesSlug]||{};
  if(!(claimed["0"]&&claimed["1"]&&claimed["2"])) return {ok:false,notice:"Claim all three elemental trials before awakening this variant.",rewards:[]};
  const userData=state.userSpecies.get(String(userId))||{},currentAwakening=userData.awakening||{},existing=currentAwakening.trueDragon||{},variants=Object.assign({},existing.variants||{});
  if(variants[speciesSlug]&&variants[speciesSlug].awakened===true) {
    const reward=await claimDragonAwakeningGlory(userId,speciesSlug,dragonKey);
    if(!reward.ok) return {ok:false,notice:"This dragon is already awakened, but its 3 Glory reward could not be saved. The reward remains available to retry from this task.",rewards:[]};
    if(reward.outcome&&reward.outcome.awarded) return {ok:true,notice:"This dragon was already awakened. Its missing 3 Glory reward has now been credited.",rewards:[{title:"Awaken "+dragonKey+" Dragon",detail:"Elemental variant already awakened",reward:3}]};
    return {ok:true,notice:"This dragon is already awakened and its 3 Glory reward was already credited.",rewards:[]};
  }
  variants[speciesSlug]={awakened:true,awakenedAt:Date.now()};
  const allAwakened=DRAGON_KEYS.every(function(key){return variants[key.toLowerCase()]&&variants[key.toLowerCase()].awakened===true;});
  const newAwakening=Object.assign({},currentAwakening,{trueDragon:Object.assign({},existing,{variants:variants,unlocked:allAwakened||existing.unlocked===true,awakened:allAwakened||existing.awakened===true})});
  const saved=await database.saveUserSpecies(String(userId),{awakening:newAwakening});
  if(!saved) return {ok:false,notice:"MongoDB could not save the awakening. No unlock was applied.",rewards:[]};
  userData.awakening=newAwakening;
  state.userSpecies.set(String(userId),userData);
  const award=await claimDragonAwakeningGlory(userId,speciesSlug,dragonKey);
  if(!award.ok) return {ok:false,notice:"Dragon awakening saved, but its 3 Glory reward could not be saved. The reward remains available to retry from this task.",rewards:[]};
  if(award.outcome&&award.outcome.awarded) {
    return {
      ok:true,
      notice:allAwakened?"All four elemental dragons are now awakened. True Dragon is unlocked!":"Awakened "+dragonKey+" Dragon.",
      rewards:[{title:"Awaken "+dragonKey+" Dragon",detail:allAwakened?"Final elemental variant awakened; True Dragon unlocked":"Elemental variant awakened",reward:3}],
    };
  }
  return {ok:true,notice:"This dragon is awakened and its 3 Glory reward was already credited.",rewards:[]};
}

async function handleButton(interaction,state,client) {
  const id=String(interaction.customId||"");
  if(!id.startsWith("ach:")) return false;
  const parts=id.split(":"),actor=String(interaction.user.id);
  const target=parts[2]&&/^\d{17,20}$/.test(parts[2])?parts[2]:null;
  if(target&&target!==actor) {
    await interaction.reply({content:"Only the user who opened this achievement panel can use these buttons.",ephemeral:true});
    return true;
  }
  if(parts[1]==="locked"||parts[1]==="claimed") {
    await interaction.reply({content:"This achievement action is unavailable.",ephemeral:true});
    return true;
  }
  if(parts[1]==="home") {await interaction.update(await renderHome(actor));return true;}
  if(parts[1]==="normal") {await interaction.update(await renderNormal(actor,state,Number(parts[3])||0));return true;}
  if(parts[1]==="species") {await interaction.update(buildSpeciesListPage(actor,Number(parts[3])||0));return true;}
  if(parts[1]==="open") {await interaction.update(await renderDetail(actor,state,parts[3],Number(parts[4])||0));return true;}
  if(parts[1]==="leaderboard") {await interaction.update(await buildLeaderboardPayload(client));return true;}
  if(parts[1]==="claim-all-normal") {
    const requestedPage=Number(parts[3])||0,page=Math.max(0,Math.min(Math.ceil(NORMAL_ACHIEVEMENTS.length/4)-1,requestedPage));
    const claim=await mutateProfile(actor,function(profile){
      const metrics=getMetrics(actor,state,profile),visible=NORMAL_ACHIEVEMENTS.slice(page*4,page*4+4),rewards=[];
      for(const def of visible) {
        const stage=Math.max(0,Number(profile.claimed["normal:"+def.key])||0);
        if(stage>=def.milestones.length) continue;
        const targetValue=def.milestones[stage],value=Number(metrics[def.metric])||0;
        if(value<targetValue) continue;
        const reward=def.rewards[stage];
        profile.claimed["normal:"+def.key]=stage+1;
        profile.glory+=reward;
        rewards.push({title:def.title,detail:def.description+" Target: "+targetValue,reward:reward});
      }
      if(!rewards.length) return {abort:true,noReady:true,rewards:[]};
      return {rewards:rewards};
    });
    const outcome=claim.outcome||{};
    const notice=!claim.ok
      ?"Database save failed. No rewards were confirmed."
      :formatClaimSummary(outcome.rewards,"No achievements on this page were ready to claim.");
    await interaction.update(await renderNormal(actor,state,page,notice));
    return true;
  }
  if(parts[1]==="claim-normal") {
    const key=parts[3],expected=Number(parts[4])||0,page=Number(parts[5])||0,def=NORMAL_ACHIEVEMENTS.find(function(item){return item.key===key;});
    if(!def){await interaction.update(await renderNormal(actor,state,0,"That achievement could not be found."));return true;}
    const claim=await mutateProfile(actor,function(profile){
      const stage=Math.max(0,Number(profile.claimed["normal:"+key])||0),metrics=getMetrics(actor,state,profile);
      if(stage!==expected||stage>=def.milestones.length) return {abort:true};
      const targetValue=def.milestones[stage];
      if((Number(metrics[def.metric])||0)<targetValue) return {abort:true};
      const reward=def.rewards[stage];
      profile.claimed["normal:"+key]=stage+1;profile.glory+=reward;
      return {notice:"Claimed "+reward+" Glory for "+def.title+" ("+targetValue+")."};
    });
    const notice=claim.ok&&claim.outcome&&!claim.outcome.abort&&claim.outcome.notice?claim.outcome.notice:claim.ok?"Not ready, already claimed, or claim is out of date.":"Database save failed; no reward was confirmed.";
    await interaction.update(await renderNormal(actor,state,page,notice));
    return true;
  }
  if(parts[1]==="claim-all-species") {
    const speciesSlug=parts[3],requestedPage=Number(parts[4])||0;
    if(!getEntry(speciesSlug)){await interaction.update(buildSpeciesListPage(actor,0,"That species entry could not be found."));return true;}
    const claim=await mutateProfile(actor,function(profile){
      const built=buildSpeciesTasks(actor,state,profile,speciesSlug);
      if(!built.entry) return {abort:true,invalid:true,rewards:[],specialTasks:[]};
      const pageCount=Math.max(1,Math.ceil(built.tasks.length/4)),page=Math.max(0,Math.min(pageCount-1,requestedPage));
      const visible=built.tasks.slice(page*4,page*4+4),rewards=[],specialTasks=[];
      for(const task of visible) {
        if(!task.ready) continue;
        if(task.kind==="dragon-awakening") {specialTasks.push(task);continue;}
        if(task.kind==="species") {
          const counters=getSpeciesCounters(profile,task.speciesName);
          if(profile.claimed[task.achievementId]===true||(Number(counters[task.metric])||0)<task.target) continue;
          profile.claimed[task.achievementId]=true;
          profile.glory+=task.reward;
          rewards.push({title:task.title,detail:task.description,reward:task.reward});
        } else if(task.kind==="dragon") {
          const claimed=profile.dragonClaims[task.dragonSlug]||{},counters=getSpeciesCounters(profile,built.entry.name);
          if(claimed[String(task.taskIndex)]===true||(Number(counters[task.metric])||0)<task.target) continue;
          claimed[String(task.taskIndex)]=true;
          profile.dragonClaims[task.dragonSlug]=claimed;
          profile.glory+=task.reward;
          rewards.push({title:task.title,detail:task.description,reward:task.reward});
        } else if(task.kind==="awakening") {
          if(profile.claimed[task.achievementId]===true) continue;
          profile.claimed[task.achievementId]=true;
          profile.glory+=task.reward;
          rewards.push({title:task.title,detail:task.description,reward:task.reward});
        }
      }
      if(!rewards.length) return {abort:true,noReady:specialTasks.length===0,rewards:[],specialTasks:specialTasks};
      return {rewards:rewards,specialTasks:specialTasks};
    });
    const outcome=claim.outcome||{};
    let notice;
    if(!claim.ok) notice="Database save failed. No rewards from this batch were confirmed.";
    else if(outcome.invalid) notice="That species entry could not be found.";
    else {
      const rewards=Array.isArray(outcome.rewards)?outcome.rewards.slice():[];
      const extraNotices=[];
      for(const task of (outcome.specialTasks||[])) {
        const awakening=await applyDragonAwakening(actor,state,task.dragonKey);
        if(awakening.ok) {
          rewards.push(...awakening.rewards);
          if(awakening.notice&&!awakening.rewards.length) extraNotices.push(awakening.notice);
        } else extraNotices.push("⚠️ "+awakening.notice);
      }
      notice=rewards.length?formatClaimSummary(rewards):extraNotices.length?extraNotices.join("\n"):"No achievements on this page were ready to claim.";
      if(rewards.length&&extraNotices.length) notice+="\n"+extraNotices.join("\n");
    }
    await interaction.update(await renderDetail(actor,state,speciesSlug,requestedPage,notice));
    return true;
  }
  if(parts[1]==="claim-species") {
    const speciesSlug=parts[3],page=Number(parts[4])||0,entry=getEntry(speciesSlug);
    if(!entry){await interaction.update(buildSpeciesListPage(actor,0,"That species could not be found."));return true;}
    const trial=makeSpeciesTrial(entry);
    const claim=await mutateProfile(actor,function(profile){
      if(profile.claimed[trial.id]===true) return {abort:true};
      const counters=profile.speciesCounters[entry.name]||{};
      if((Number(counters[trial.metric])||0)<trial.target) return {abort:true};
      profile.claimed[trial.id]=true;profile.glory+=trial.reward;
      return {notice:"Claimed "+trial.reward+" Glory for "+trial.title+"."};
    });
    const notice=claim.ok&&claim.outcome&&!claim.outcome.abort?claim.outcome.notice:claim.ok?"Not ready or already claimed.":"Database save failed; no reward was confirmed.";
    await interaction.update(await renderDetail(actor,state,speciesSlug,page,notice));
    return true;
  }
  if(parts[1]==="claim-dragon") {
    const speciesSlug=parts[3],taskIndex=Number(parts[4]),page=Number(parts[5])||0,key=DRAGON_KEYS.find(function(k){return k.toLowerCase()===speciesSlug;});
    if(!key||![0,1,2].includes(taskIndex)){await interaction.update(buildSpeciesListPage(actor,0,"That dragon trial could not be found."));return true;}
    const name=key+" Dragon",requirements=[
      {metric:"battles",target:5,reward:1,title:"Elemental Presence"},
      {metric:"wins",target:3,reward:2,title:"Elemental Conquest"},
      {metric:"ults",target:2,reward:2,title:"Elemental Mastery"},
    ],requirement=requirements[taskIndex];
    const claim=await mutateProfile(actor,function(profile){
      const claimed=profile.dragonClaims[speciesSlug]||{};
      if(claimed[String(taskIndex)]===true) return {abort:true};
      const counters=profile.speciesCounters[name]||{};
      if((Number(counters[requirement.metric])||0)<requirement.target) return {abort:true};
      claimed[String(taskIndex)]=true;profile.dragonClaims[speciesSlug]=claimed;profile.glory+=requirement.reward;
      return {notice:"Claimed "+requirement.reward+" Glory for "+name+" · "+requirement.title+"."};
    });
    const notice=claim.ok&&claim.outcome&&!claim.outcome.abort?claim.outcome.notice:claim.ok?"Not ready or already claimed.":"Database save failed; no reward was confirmed.";
    await interaction.update(await renderDetail(actor,state,slug(name),page,notice));
    return true;
  }
  if(parts[1]==="awaken-dragon") {
    const page=Number(parts[4])||0,key=DRAGON_KEYS.find(function(k){return k.toLowerCase()===String(parts[3]||"").toLowerCase();});
    const awakening=await applyDragonAwakening(actor,state,key);
    const speciesSlug=key?slug(key+" Dragon"):slug(parts[3]);
    await interaction.update(await renderDetail(actor,state,speciesSlug,page,awakening.notice));
    return true;
  }
  if(parts[1]==="claim-awakening") {
    const speciesSlug=parts[3],page=Number(parts[4])||0,entry=getEntry(speciesSlug),name=entry&&entry.name,userData=state.userSpecies.get(actor)||{};
    let unlocked=false;
    if(name&&AWAKENING_SPECIES[name]) unlocked=hasAwakened(userData,name);
    else if(name==="True Dragon") unlocked=Boolean(userData.awakening&&userData.awakening.trueDragon&&(userData.awakening.trueDragon.awakened||userData.awakening.trueDragon.unlocked));
    if(!unlocked){await interaction.update(await renderDetail(actor,state,speciesSlug,0,"Complete or unlock the awakening before claiming this reward."));return true;}
    const achievementId="awakening:"+speciesSlug;
    const claim=await mutateProfile(actor,function(profile){
      if(profile.claimed[achievementId]===true) return {abort:true};
      profile.claimed[achievementId]=true;profile.glory+=3;
      return {notice:"Claimed 3 Glory for the awakening."};
    });
    const notice=claim.ok&&claim.outcome&&!claim.outcome.abort?claim.outcome.notice:claim.ok?"This awakening reward was already claimed.":"Database save failed; no reward was confirmed.";
    await interaction.update(await renderDetail(actor,state,speciesSlug,page,notice));
    return true;
  }
  return true;
}
let schedulerStarted=false,schedulerRunning=false;

// One-time migration cleanup for Discord roles created by the retired Glory leaderboard feature.
// The leaderboard will never create, assign, or synchronize Discord roles again.
async function removeLegacyGloryRoles(client) {
  const managedRoleName=/^LOZ Glory (#(?:[1-9]|10)|Top 25)$/;
  for(const guild of client.guilds.cache.values()) {
    let roles;
    try {
      roles=await guild.roles.fetch();
    } catch(error) {
      console.warn("[Glory] Could not fetch roles for cleanup in "+guild.id+": "+(error.message||error));
      continue;
    }
    const legacyRoles=Array.from(roles.values()).filter(function(role){return managedRoleName.test(role.name);});
    for(const role of legacyRoles) {
      try {
        await role.delete("LOZ no longer uses Discord roles for the Glory leaderboard");
        console.log("[Glory] Deleted retired leaderboard role "+role.name+" in guild "+guild.id);
      } catch(error) {
        console.warn("[Glory] Could not delete retired role "+role.name+" in guild "+guild.id+": "+(error.message||error));
      }
    }
  }
}
async function syncGloryBadges(state,current,previous) {
  const ranks=new Map(current.map(function(entry){return [String(entry.userId),Number(entry.rank)];}));
  const userIds=new Set(Array.from(state.userSpecies.keys()).concat(current.map(function(e){return String(e.userId);}),previous.map(function(e){return String(e.userId);})));
  for(const userId of userIds) {
    const data=state.userSpecies.get(userId);
    if(!data) continue;
    const badges=Array.isArray(data.badges)?data.badges.filter(function(b){return typeof b!=="string"||!/^GLORY_(\d+|TOP25)$/.test(b);}):[];
    const rank=ranks.get(userId);
    if(rank&&rank<=10) badges.push("GLORY_"+rank);
    else if(rank&&rank<=25) badges.push("GLORY_TOP25");
    const next=Array.from(new Set(badges));
    if(JSON.stringify(next)==JSON.stringify(data.badges||[])) continue;
    data.badges=next;
    await database.saveUserSpecies(userId,{badges:next});
  }
}
async function syncLeaderboardCycle(client,state) {
  if(schedulerRunning) return;
  schedulerRunning=true;
  try {
    const entries=await database.getGloryLeaderboardTop(25);
    if(entries===null) return;
    const snapshot=await database.getGloryLeaderboardSnapshot();
    if(!snapshot||!snapshot.ok) return;
    const previous=Array.isArray(snapshot.data)?snapshot.data:[];
    const current=entries.map(function(e,index){return {userId:String(e.userId),glory:Number(e.glory)||0,rank:index+1};});
    await syncGloryBadges(state,current,previous);
    const oldRanks=new Map(previous.map(function(e){return [String(e.userId),Number(e.rank)||0];}));
    for(const entry of current.filter(function(e){return e.rank<=10;})) {
      if(oldRanks.has(entry.userId)&&oldRanks.get(entry.userId)===entry.rank) continue;
      try {
        const user=await client.users.fetch(entry.userId);
        const container=new ContainerBuilder().setAccentColor(0xe0b64c);
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## 🏆 GLORY LEADERBOARD UPDATE\nYour current LOZ Glory rank is **#"+entry.rank+"**.\n\n"+GLORY+" **Glory:** "+entry.glory.toLocaleString()+"\n\nUse /achievements to view your milestones and /leaderboard with the Glory type to see the Top 25."));
        await user.send({components:[container],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}});
      } catch(error) {
        console.warn("[Glory] Could not DM Top 10 user "+entry.userId+": "+(error.message||error));
      }
    }
    await database.saveGloryLeaderboardSnapshot(current);
  } catch(error) {console.error("[Glory] Leaderboard cycle failed:",error);}
  finally {schedulerRunning=false;}
}
async function startLeaderboardScheduler(client,state) {
  if(schedulerStarted) return false;
  schedulerStarted=true;
  // Clean up roles from the old system before the first leaderboard refresh.
  await removeLegacyGloryRoles(client);
  void syncLeaderboardCycle(client,state);
  const timer=setInterval(function(){void syncLeaderboardCycle(client,state);},CHECK_INTERVAL_MS);
  if(typeof timer.unref==="function") timer.unref();
  return true;
}
module.exports = {
  open,handleButton,recordBattle,recordUltimate,recordDailyClaim,recordRollUsed,
  buildLeaderboardPayload,formatLeaderboardRow,startLeaderboardScheduler,getSpeciesRoster,removeLegacyGloryRoles,formatClaimSummary,makeClaimButton,
};