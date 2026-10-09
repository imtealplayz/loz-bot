# LOZ Bot

A Discord RPG bot built around a persistent species system, turn-based combat, fights, and server gameplay.

## What it does

LOZ is the foundation for a larger Discord RPG system. Its core gameplay is driven by species data, player state, combat logic, and database persistence.

## Core systems

- Species / character system
- Turn-based fight and combat logic
- Persistent player and game state
- Discord command handling
- MongoDB-backed data
- Extensible helpers and constants for game rules

## Stack

- JavaScript
- Node.js
- discord.js
- MongoDB

## Run locally

```bash
npm install
node index.js
```

Configure the Discord token and MongoDB connection in `.env` using the variables expected by the project.

## Project structure

```text
commands.js     Discord command handling
combat.js       Core combat logic
fights.js       Fight flow and battle mechanics
database.js     Database access
state.js        Runtime state management
helpers.js      Shared utilities
constants.js    Game configuration
index.js        Bot entry point
```

## Status

Gameplay system under active development. LOZ is also the gameplay foundation for related web/RPG experiments.


## Top.gg vote rewards

LOZ grants species rolls automatically after a signed Top.gg Webhooks V2 vote is verified. The default reward is **1 roll per vote**, doubled to **2 rolls** when Top.gg marks a vote as a weekend vote. A 12-hour per-user cooldown prevents webhook retries from granting repeated rewards.

Configure these Railway variables:

- `TOPGG_WEBHOOK_SECRET`: the Webhooks V2 signing secret from Top.gg (the value beginning with `whs_`).
- `TOPGG_ROLLS_PER_VOTE`: optional integer reward per normal vote (defaults to `1`).

Expose the Railway service on its assigned `PORT`, then configure the Top.gg webhook URL as `https://YOUR-RAILWAY-DOMAIN/topgg/webhook`. The `/health` route is available for a simple health check. Use the dashboard test delivery to verify signature handling; test deliveries never grant rolls. Players can use `/vote` to open the vote page and view their vote-reward totals.
