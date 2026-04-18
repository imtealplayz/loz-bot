# Loz-Bot

Loz-Bot is a feature-rich Discord bot designed to enhance server interactions with custom commands, game mechanics, and administrative utilities. Built with `discord.js`, it offers a robust and engaging experience for community members.

## Features

*   **Custom Commands:** Interactive commands for various server activities.
*   **Game Mechanics:** Engaging mini-games and reward systems.
*   **Moderation Tools:** Basic moderation capabilities to help manage the server.
*   **Database Integration:** Persistent data storage for user profiles and game states.

## Technologies Used

*   **Language:** JavaScript
*   **Framework:** Node.js, Discord.js
*   **Database:** MongoDB (via `database.js` module)

## Project Structure

```
loz-bot/
├── commands.js             # Defines and handles bot commands
├── combat.js               # Combat-related game logic
├── constants.js            # Stores various constants and configurations
├── database.js             # Handles MongoDB connection and operations
├── fights.js               # Logic for fight mechanics
├── helpers.js              # Utility functions and helper methods
├── index.js                # Main bot entry point and event handler
├── package.json            # Project dependencies and scripts
├── state.js                # Manages bot's internal state
└── README.md               # Project documentation
```

## Setup Instructions

To get Loz-Bot running on your Discord server, follow these steps:

### 1. Prerequisites

*   **Node.js:** Ensure you have Node.js (LTS version recommended) installed.
*   **MongoDB:** A running MongoDB instance (local or cloud-hosted).
*   **Discord Bot Token:** Create a new application on the [Discord Developer Portal](https://discord.com/developers/applications) and obtain your bot token.
*   **Discord Client ID:** Get your bot's client ID from the Discord Developer Portal.

### 2. Clone the Repository

```bash
git clone https://github.com/imtealplayz/loz-bot.git
cd loz-bot
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Configure Environment Variables

Create a `.env` file in the root directory of the project and add the following:

```
TOKEN=YOUR_DISCORD_BOT_TOKEN
CLIENT_ID=YOUR_DISCORD_CLIENT_ID
MONGO_URI=YOUR_MONGODB_CONNECTION_STRING
```

*Replace the placeholder values with your actual bot token, client ID, and MongoDB connection string.*

### 5. Run the Bot

```bash
node index.js
```

The bot should now be online and ready to join your Discord server. Ensure you have invited the bot to your server with the necessary permissions.
