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
