"use strict";

const questSystem = require("./quest-system.js");
const achievementSystem = require("./achievements.js");
const { updateCyborgProgress, updateHalfBloodProgress } = require("./helpers.js");

function addFightProgress(fight,userId,type,amount=1) {
  if (!fight || !userId || !["damage","ults"].includes(type)) return;
  if (!fight.progressByPlayer || typeof fight.progressByPlayer !== "object") fight.progressByPlayer = {};
  const id=String(userId);
  if (!fight.progressByPlayer[id]) fight.progressByPlayer[id]={damage:0,ults:0};
  fight.progressByPlayer[id][type]=Math.max(0,Number(fight.progressByPlayer[id][type])||0)+Math.max(0,Number(amount)||0);
}

async function commitFightProgress(fight,userId,species) {
  const pending=fight?.progressByPlayer?.[String(userId)];
  if(!pending || !species?.name) return;
  const damage=Math.max(0,Number(pending.damage)||0),ults=Math.max(0,Number(pending.ults)||0);
  if(damage>0) {
    await questSystem.trackProgress(userId,"damage",damage);
    await achievementSystem.recordDamage(userId,species,damage);
    if(species.name==="Cyborg") await updateCyborgProgress(String(userId),"damage",damage);
    if(species.name==="Half-Blood") await updateHalfBloodProgress(String(userId),"damage",damage,species.name);
  }
  if(ults>0) {
    await questSystem.trackProgress(userId,"ults",ults);
    await achievementSystem.recordUltimate(userId,species,ults);
    if(species.name==="Cyborg") await updateCyborgProgress(String(userId),"ult",ults);
    if(species.name==="Half-Blood") await updateHalfBloodProgress(String(userId),"ult",ults,species.name);
  }
  delete fight.progressByPlayer[String(userId)];
}

module.exports={addFightProgress,commitFightProgress};
