const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const {
  speciesRollTable,
  validateSpeciesRollTable,
  selectSpeciesRoll,
} = require("../constants.js");
const database = require("../database.js");

test("species roll probabilities are positive and total 100%", () => {
  assert.equal(validateSpeciesRollTable(), true);
  assert.equal(speciesRollTable.reduce((sum, entry) => sum + entry.probabilityPercent, 0), 100);
  assert.equal(speciesRollTable.find(entry => entry.isDragon).probabilityPercent, 2);
  assert.ok(speciesRollTable.every(entry => entry.weight > 0));
});

test("the RNG uses every configured weight, including Dragon", () => {
  const totalWeight = speciesRollTable.reduce((sum, entry) => sum + entry.weight, 0);
  let before = 0;
  for (const entry of speciesRollTable) {
    const midpoint = (before + entry.weight / 2) / totalWeight;
    const selected = selectSpeciesRoll(() => midpoint);
    assert.equal(entry.isDragon ? selected.isDragon : selected.name === entry.name, true);
    before += entry.weight;
  }
});

test("startup refuses to load data before MongoDB connects", async () => {
  await assert.rejects(
    database.loadAllData(new Map(), new Map(), new Map(), new Map(), new Map(), new Map()),
    /MongoDB is not connected/
  );
  await assert.rejects(database.connect(""), /MONGODB_URI is required/);
});

test("a first daily reward creates a user and increments rolls atomically", async () => {
  const originalReadyState = mongoose.connection.readyState;
  const originalFindOneAndUpdate = mongoose.Model.findOneAndUpdate;
  let captured;
  try {
    mongoose.connection.readyState = 1;
    mongoose.Model.findOneAndUpdate = function (filter, update, options) {
      captured = { filter, update, options };
      return Promise.resolve({ rolls:1, toObject() { return { userId:"new-player", rolls:1 }; } });
    };
    const saved = await database.addDailyRolls("new-player", 1, {
      species:{ name:"Human" }, originalSpecies:{ name:"Human" },
      questSpecies:{}, rolls:0, requestsEnabled:true, lastSwitch:0, badges:[],
    });
    assert.equal(saved.rolls, 1);
    assert.equal(captured.filter.userId, "new-player");
    assert.equal(captured.update.$inc.rolls, 1);
    assert.equal(captured.update.$setOnInsert.species.name, "Human");
    assert.equal(Object.hasOwn(captured.update.$setOnInsert, "rolls"), false);
    assert.equal(captured.options.upsert, true);
    assert.equal(captured.options.new, true);
  } finally {
    mongoose.Model.findOneAndUpdate = originalFindOneAndUpdate;
    mongoose.connection.readyState = originalReadyState;
  }
});
