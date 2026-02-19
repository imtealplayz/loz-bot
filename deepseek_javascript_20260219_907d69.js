const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    PermissionFlagsBits,
    ActivityType,
    Partials
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
});

const Database = require('@replit/database');
const db = new Database();

// Store active adrop confirmation timeouts
const adropConfirmations = new Map();

// ====================================================
// HELPER FUNCTIONS
// ====================================================

function parseTime(timeStr) {
    const units = { 's': 1000, 'm': 60000, 'h': 3600000, 'd': 86400000 };
    const match = timeStr.match(/^(\d+)([smhd])$/);
    if (!match) return null;
    
    const num = parseInt(match[1]);
    const unit = match[2];
    const ms = num * units[unit];
    
    if (ms > 28 * 24 * 60 * 60 * 1000) return { error: 'Max 28 days' };
    return { ms, readable: `${num}${unit}` };
}

function parseClaimTime(input) {
    if (!input || !input.startsWith('ct=')) return null;
    const timeStr = input.slice(3);
    const time = parseTime(timeStr);
    return time;
}

async function resolveUser(guild, input) {
    try {
        if (input.match(/^<@!?\d+>$/)) {
            const id = input.replace(/\D/g, '');
            return await guild.members.fetch(id);
        }
        if (/^\d+$/.test(input)) return await guild.members.fetch(input);
        if (input.includes('#')) {
            const members = await guild.members.fetch();
            return members.find(m => m.user.tag === input);
        }
        const members = await guild.members.fetch();
        return members.find(m => 
            m.user.username.toLowerCase().includes(input.toLowerCase()) ||
            m.displayName.toLowerCase().includes(input.toLowerCase())
        );
    } catch { 
        return null; 
    }
}

async function getMuteRole(guild) {
    const roleId = await db.get(`muteRole_${guild.id}`);
    return roleId ? guild.roles.cache.get(roleId) : null;
}

async function getDropRoles(guild, type = 'normal') {
    const key = type === 'reaction' ? `rdropRoles_${guild.id}` : 
                type === 'adrop' ? `adropRoles_${guild.id}` : 
                `dropRoles_${guild.id}`;
    const roleIds = await db.get(key) || [];
    return roleIds.map(id => guild.roles.cache.get(id)).filter(role => role);
}

async function removeDropRole(guild, roleId, type = 'normal') {
    const key = type === 'reaction' ? `rdropRoles_${guild.id}` : 
                type === 'adrop' ? `adropRoles_${guild.id}` : 
                `dropRoles_${guild.id}`;
    const roleIds = await db.get(key) || [];
    const newRoleIds = roleIds.filter(id => id !== roleId);
    await db.set(key, newRoleIds);
    return newRoleIds;
}

// ====================================================
// BOT READY
// ====================================================

client.once('ready', () => {
    console.log(`✅ Bot online as ${client.user.tag}!`);
    console.log(`✅ Prefix: '`);
    client.user.setPresence({
        status: 'dnd',
        activities: [{ name: 'Kyubi by 9lana', type: ActivityType.Listening }]
    });
});

// ====================================================
// REACTION HANDLER - For immediate reaction drop start
// ====================================================

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    
    try {
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();
        
        const message = reaction.message;
        if (!message.guild) return;
        
        // Check for reaction drops
        const rdropId = `${message.guild.id}_${message.id}`;
        const rdropData = await db.get(`rdrop_${rdropId}`);
        
        if (rdropData && !rdropData.started) {
            // Get current reaction count
            const currentReaction = message.reactions.cache.get('🎉');
            if (!currentReaction) return;
            
            const users = await currentReaction.users.fetch();
            const uniqueReactors = users.filter(u => !u.bot).size;
            
            // Check if goal reached
            if (uniqueReactors >= rdropData.requiredReactions) {
                // Mark as started to prevent multiple starts
                rdropData.started = true;
                await db.set(`rdrop_${rdropId}`, rdropData);
                
                // Get host user for username
                let hostUser;
                try {
                    hostUser = await client.users.fetch(rdropData.hostId);
                } catch {
                    hostUser = { tag: 'Unknown Host' };
                }
                
                // Start the drop IMMEDIATELY
                const channel = message.channel;
                
                // Get reaction drop roles for ping
                const rdropRoles = await getDropRoles(message.guild, 'reaction');
                
                // Create drop embed (Light Green)
                const dropEmbed = new EmbedBuilder()
                    .setColor(0x90EE90)
                    .setTitle(`🎉 ${rdropData.prize}`)
                    .setDescription(`**Hosted by:** ${hostUser.tag}`)
                    .addFields(
                        { name: '⏰ Ends', value: `<t:${Math.floor((Date.now() + rdropData.dropTime) / 1000)}:R>`, inline: true },
                        { name: '🏆 Winners', value: `${rdropData.winners}`, inline: true },
                        { name: '📋 Message ID', value: `\`${rdropData.messageId}\``, inline: true }
                    )
                    .setFooter({ text: 'React with 🎉 to join the drop!' })
                    .setTimestamp();
                
                // Send drop message with role ping
                let dropMessage;
                const roleMentions = rdropRoles.map(r => `<@&${r.id}>`).join(' ');
                dropMessage = await channel.send({
                    content: `🎉 **REACTION DROP STARTED!** ${roleMentions}`,
                    embeds: [dropEmbed]
                });
                
                await dropMessage.react('🎉');
                
                // Update original reaction embed
                const updatedReactEmbed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle(`✅ ${rdropData.prize}`)
                    .setDescription('**Reaction Requirement Met!**\nDrop has started.')
                    .addFields(
                        { name: '🎯 Required', value: `${rdropData.requiredReactions} reactions`, inline: true },
                        { name: '⏰ Started', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
                    )
                    .setTimestamp();
                
                await message.edit({ embeds: [updatedReactEmbed] });
                
                // Save as normal drop
                const dropId = `${message.guild.id}_${dropMessage.id}`;
                await db.set(`drop_${dropId}`, {
                    messageId: dropMessage.id,
                    channelId: channel.id,
                    guildId: message.guild.id,
                    hostId: rdropData.hostId,
                    hostTag: hostUser.tag,
                    prize: rdropData.prize,
                    winners: rdropData.winners,
                    endTime: Date.now() + rdropData.dropTime,
                    claimTime: rdropData.claimTime,
                    claimed: false,
                    winnerIds: []
                });
                
                // Delete reaction drop from database
                await db.delete(`rdrop_${rdropId}`);
                
                // Set timeout for drop end
                setTimeout(async () => {
                    try {
                        const dropData = await db.get(`drop_${dropId}`);
                        if (!dropData) return;
                        
                        const endedMessage = await channel.messages.fetch(dropData.messageId);
                        const reaction = endedMessage.reactions.cache.get('🎉');
                        let winners = [];
                        
                        if (reaction) {
                            const users = await reaction.users.fetch();
                            const participants = users.filter(u => !u.bot).map(u => u.id);
                            
                            if (participants.length > 0) {
                                const shuffled = [...participants].sort(() => Math.random() - 0.5);
                                winners = shuffled.slice(0, Math.min(dropData.winners, participants.length));
                                
                                dropData.winnerIds = winners;
                                await db.set(`drop_${dropId}`, dropData);
                            }
                        }
                        
                        // Update to electric blue
                        const updatedEmbed = new EmbedBuilder()
                            .setColor(0x00B0F0)
                            .setTitle(`🎉 ${dropData.prize}`)
                            .setDescription('**Drop Ended!**')
                            .addFields(
                                { name: '🎯 Hosted by', value: dropData.hostTag || `<@${dropData.hostId}>`, inline: true },
                                { name: '⏰ Ended', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
                                { name: '📋 Message ID', value: `\`${dropData.messageId}\``, inline: true }
                            )
                            .setTimestamp();
                        
                        await endedMessage.edit({ embeds: [updatedEmbed] });
                        
                        if (winners.length > 0) {
                            const winnerMentions = winners.map(id => `<@${id}>`).join(', ');
                            
                            // PING WINNERS OUTSIDE THE EMBED
                            await channel.send(`🏆 **CONGRATULATIONS WINNER${winners.length > 1 ? 'S' : ''}!** ${winnerMentions}`);
                            
                            const winnerEmbed = new EmbedBuilder()
                                .setColor(0xFF0000)
                                .setTitle(`🏆 ${dropData.prize}`)
                                .setDescription(`**Winner${winners.length > 1 ? 's' : ''}:** ${winnerMentions}`)
                                .setFooter({ text: `This drop was hosted by ${dropData.hostTag || 'Unknown Host'} | Message ID: ${dropData.messageId}` })
                                .setTimestamp();
                            
                            await channel.send({ embeds: [winnerEmbed] });
                            
                            if (dropData.claimTime) {
                                const claimEndTime = Date.now() + dropData.claimTime;
                                await channel.send(`⏰ **Claim Time:** ${winners.length > 1 ? 'Winners have' : 'Winner has'} <t:${Math.floor(claimEndTime / 1000)}:R> to claim!\nHost: \`'claimed\``);
                                
                                setTimeout(async () => {
                                    const updatedData = await db.get(`drop_${dropId}`);
                                    if (!updatedData || updatedData.claimed) return;
                                    await channel.send(`⏰ **CLAIM TIME OVER!**\nClaim time for **${dropData.prize}** ended.`);
                                    await db.delete(`drop_${dropId}`);
                                }, dropData.claimTime);
                            } else {
                                await db.delete(`drop_${dropId}`);
                            }
                        } else {
                            await channel.send(`❌ Drop **${dropData.prize}** ended with no participants.`);
                            await db.delete(`drop_${dropId}`);
                        }
                        
                    } catch (error) {
                        console.error('Error ending reaction drop:', error);
                    }
                }, rdropData.dropTime);
            }
        }
    } catch (error) {
        console.error('Reaction handler error:', error);
    }
});

// ====================================================
// MESSAGE HANDLER FOR 'k COMMAND
// ====================================================

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    
    // Check for 'k command in any channel
    if (message.content === "'k") {
        // Look for pending adrop confirmations for this user
        for (const [key, data] of adropConfirmations.entries()) {
            if (data.hostId === message.author.id && !data.acknowledged) {
                // Found a pending adrop
                data.acknowledged = true;
                
                // Clear all pending timeouts
                if (data.timeouts) {
                    data.timeouts.forEach(timeout => clearTimeout(timeout));
                }
                
                // Send confirmation
                await message.reply(`✅ Acknowledged! The adrop for **${data.prize}** has been confirmed. You will not receive further pings.`);
                
                // Delete from map
                adropConfirmations.delete(key);
                
                // Update the embed to show confirmed
                try {
                    const channel = await client.channels.fetch(data.channelId);
                    const msg = await channel.messages.fetch(data.messageId);
                    
                    const confirmedEmbed = EmbedBuilder.from(msg.embeds[0])
                        .setColor(0x00FF00)
                        .setFooter({ text: '✓ Host acknowledged' });
                    
                    await msg.edit({ embeds: [confirmedEmbed] });
                } catch (e) {}
                
                return;
            }
        }
        
        // If no pending adrop found
        await message.reply('❌ No pending adrop confirmation found for you.');
        return;
    }
    
    // Continue with regular command handling
    if (!message.guild) return; // Ignore DMs for other commands
    if (!message.content.startsWith("'")) return;
    
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    // ===== HELP =====
    if (command === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('📋 Bot Commands - Prefix: `\'`')
            .addFields(
                { name: '⚙️ Mute Role', value: '`\'muterole create` - Create muted role\n`\'muterole @role` - Set existing role', inline: false },
                { name: '🛡️ Moderation', value: '`\'timeout @user 1h` - Timeout user\n`\'kick @user` - Kick user\n`\'ban @user` - Ban user\n`\'softban @user` - Softban user\n`\'mute @user 1h` - Mute user\n`\'rto @user` - Remove timeout', inline: false },
                { name: '🎯 Drop Roles', value: '`\'droprole @role1 @role2 @role3` - Set drop roles\n`\'droprole disable @role` - Remove role\n`\'droprole disable all` - Remove all\n`\'droprole` - Show roles', inline: false },
                { name: '🎯 Reaction Drop Roles', value: '`\'rdroprole @role1 @role2 @role3` - Set rdrop roles\n`\'rdroprole disable @role` - Remove role\n`\'rdroprole disable all` - Remove all\n`\'rdroprole` - Show roles', inline: false },
                { name: '🎯 Adrop Roles', value: '`\'adroprole @role1 @role2 @role3` - Set adrop roles\n`\'adroprole disable @role` - Remove role\n`\'adroprole disable all` - Remove all\n`\'adroprole` - Show roles', inline: false },
                { name: '🎉 Normal Drop', value: '`\'drop <time> <winners> [ct=] [yes/no] <prize>` - Host drop\n`\'claimed` - Mark as claimed', inline: false },
                { name: '🎉 Reaction Drop', value: '`\'rdrop <req> <react_time> <drop_time> <winners> [ct=] [yes/no] <prize>` - Host reaction drop\n`\'fstart <msg_id>` - Force start\n⚠️ **Starts immediately when goal reached!**', inline: false },
                { name: '🔔 Adrop (Alert Drop)', value: '`\'adrop <req> <time> [r=1-10] <prize>` - Host alert drop\nWhen req reached: pings host\nReply with `\'k` to stop pings\nDefault r=1, max 10', inline: false },
                { name: '🛠️ Management', value: '`\'cancel <msg_id>` - Cancel drop\n`\'end <msg_id>` - End early\n`\'rr <msg_id> [count]` - Reroll winners', inline: false },
                { name: '🔧 Utility', value: '`\'ping` - Check latency', inline: false }
            )
            .setFooter({ text: `Requested by ${message.author.tag}` })
            .setTimestamp();
        
        return message.channel.send({ embeds: [helpEmbed] });
    }
    
    // ===== PING =====
    if (command === 'ping') {
        const sent = await message.reply({ content: 'Pinging...', fetchReply: true });
        const latency = sent.createdTimestamp - message.createdTimestamp;
        const apiLatency = Math.round(client.ws.ping);
        return sent.edit(`🏓 Pong! Latency: ${latency}ms | API: ${apiLatency}ms`);
    }
    
    // ===== MUTE ROLE =====
    if (command === 'muterole') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return message.reply('❌ You need Manage Roles permission.');
        }
        
        if (args[0] === 'create') {
            try {
                let muteRole = message.guild.roles.cache.find(role => role.name === 'Muted');
                if (!muteRole) {
                    muteRole = await message.guild.roles.create({
                        name: 'Muted',
                        color: '#808080'
                    });
                }
                
                await db.set(`muteRole_${message.guild.id}`, muteRole.id);
                return message.reply(`✅ Muted role created: ${muteRole.name}`);
            } catch (error) {
                return message.reply(`❌ Error: ${error.message}`);
            }
        }
        
        if (args[0]) {
            const roleInput = args.join(' ');
            let role = null;
            
            if (roleInput.match(/^<@&\d+>$/)) {
                const roleId = roleInput.replace(/\D/g, '');
                role = message.guild.roles.cache.get(roleId);
            } else if (/^\d+$/.test(roleInput)) {
                role = message.guild.roles.cache.get(roleInput);
            } else {
                role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleInput.toLowerCase());
            }
            
            if (!role) return message.reply('❌ Role not found.');
            await db.set(`muteRole_${message.guild.id}`, role.id);
            return message.reply(`✅ Set ${role.name} as mute role.`);
        }
        
        const muteRoleId = await db.get(`muteRole_${message.guild.id}`);
        if (muteRoleId) {
            const role = message.guild.roles.cache.get(muteRoleId);
            return message.reply(`Current mute role: ${role ? role.name : 'Not found'}`);
        }
        return message.reply('No mute role set. Use `\'muterole create`');
    }
    
    // ===== TIMEOUT =====
    if (command === 'timeout' || command === 'to') {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
            return message.reply('❌ Need Moderate Members permission.');
        }
        if (args.length < 2) return message.reply('Usage: `\'timeout @user 1h`');
        
        const member = await resolveUser(message.guild, args[0]);
        if (!member) return message.reply('User not found.');
        
        const time = parseTime(args[1]);
        if (!time) return message.reply('Invalid time. Use: 1s, 1m, 1h, 1d');
        
        const reason = args.slice(2).join(' ') || 'No reason';
        
        try {
            await member.timeout(time.ms, reason);
            return message.reply(`✅ ${member.user.tag} timed out for ${time.readable}. Reason: ${reason}`);
        } catch (error) {
            return message.reply(`❌ ${error.message}`);
        }
    }
    
    // ===== REMOVE TIMEOUT =====
    if (command === 'rto') {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
            return message.reply('❌ Need Moderate Members permission.');
        }
        if (!args[0]) return message.reply('Usage: `\'rto @user`');
        
        const member = await resolveUser(message.guild, args[0]);
        if (!member) return message.reply('User not found.');
        
        try {
            await member.timeout(null);
            return message.reply(`✅ Timeout removed from ${member.user.tag}`);
        } catch (error) {
            return message.reply(`❌ ${error.message}`);
        }
    }
    
    // ===== KICK =====
    if (command === 'kick') {
        if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) {
            return message.reply('❌ Need Kick Members permission.');
        }
        if (!args[0]) return message.reply('Usage: `\'kick @user`');
        
        const member = await resolveUser(message.guild, args[0]);
        if (!member) return message.reply('User not found.');
        
        const reason = args.slice(1).join(' ') || 'No reason';
        
        try {
            await member.kick(reason);
            return message.reply(`✅ ${member.user.tag} kicked. Reason: ${reason}`);
        } catch (error) {
            return message.reply(`❌ ${error.message}`);
        }
    }
    
    // ===== BAN =====
    if (command === 'ban') {
        if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
            return message.reply('❌ Need Ban Members permission.');
        }
        if (!args[0]) return message.reply('Usage: `\'ban @user`');
        
        const member = await resolveUser(message.guild, args[0]);
        if (!member) return message.reply('User not found.');
        
        const reason = args.slice(1).join(' ') || 'No reason';
        
        try {
            await member.ban({ reason });
            return message.reply(`✅ ${member.user.tag} banned. Reason: ${reason}`);
        } catch (error) {
            return message.reply(`❌ ${error.message}`);
        }
    }
    
    // ===== SOFTBAN =====
    if (command === 'softban') {
        if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
            return message.reply('❌ Need Ban Members permission.');
        }
        if (!args[0]) return message.reply('Usage: `\'softban @user`');
        
        const member = await resolveUser(message.guild, args[0]);
        if (!member) return message.reply('User not found.');
        
        const reason = args.slice(1).join(' ') || 'No reason';
        
        try {
            await member.ban({ reason, deleteMessageSeconds: 7 * 24 * 60 * 60 }); // 7 days
            await message.guild.members.unban(member.id);
            return message.reply(`✅ ${member.user.tag} softbanned. Reason: ${reason}`);
        } catch (error) {
            return message.reply(`❌ ${error.message}`);
        }
    }
    
    // ===== MUTE =====
    if (command === 'mute') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return message.reply('❌ Need Manage Roles permission.');
        }
        if (args.length < 2) return message.reply('Usage: `\'mute @user 1h`');
        
        const muteRole = await getMuteRole(message.guild);
        if (!muteRole) return message.reply('No mute role. Use `\'muterole create`');
        
        const member = await resolveUser(message.guild, args[0]);
        if (!member) return message.reply('User not found.');
        
        const time = parseTime(args[1]);
        if (!time) return message.reply('Invalid time.');
        
        const reason = args.slice(2).join(' ') || 'No reason';
        
        try {
            await member.roles.add(muteRole, reason);
            return message.reply(`✅ ${member.user.tag} muted for ${time.readable}. Reason: ${reason}\nUse \`'rto @user\` to unmute.`);
        } catch (error) {
            return message.reply(`❌ ${error.message}`);
        }
    }
    
    // ===== DROP ROLES =====
    if (command === 'droprole') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return message.reply('❌ Need Manage Roles permission.');
        }
        
        if (args[0] === 'disable' && args[1] === 'all') {
            await db.set(`dropRoles_${message.guild.id}`, []);
            return message.reply('✅ All drop roles disabled.');
        }
        
        if (args[0] === 'disable' && args[1]) {
            const roleInput = args.slice(1).join(' ');
            let role = null;
            
            if (roleInput.match(/^<@&\d+>$/)) {
                const roleId = roleInput.replace(/\D/g, '');
                role = message.guild.roles.cache.get(roleId);
            } else if (/^\d+$/.test(roleInput)) {
                role = message.guild.roles.cache.get(roleInput);
            } else {
                role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleInput.toLowerCase());
            }
            
            if (!role) return message.reply('❌ Role not found.');
            await removeDropRole(message.guild, role.id, 'normal');
            return message.reply(`✅ Removed ${role.name} from drop roles.`);
        }
        
        if (!args[0]) {
            const roles = await getDropRoles(message.guild, 'normal');
            if (roles.length === 0) return message.reply('No drop roles set.');
            const list = roles.map(r => `${r.name} (<@&${r.id}>)`).join('\n');
            return message.reply(`**Current Drop Roles:**\n${list}`);
        }
        
        const roles = [];
        for (const input of args) {
            let role = null;
            if (input.match(/^<@&\d+>$/)) {
                const id = input.replace(/\D/g, '');
                role = message.guild.roles.cache.get(id);
            } else if (/^\d+$/.test(input)) {
                role = message.guild.roles.cache.get(input);
            } else {
                role = message.guild.roles.cache.find(r => r.name.toLowerCase() === input.toLowerCase());
            }
            if (!role) return message.reply(`❌ Role "${input}" not found.`);
            if (roles.length >= 3) return message.reply('❌ Max 3 roles.');
            roles.push(role);
        }
        
        await db.set(`dropRoles_${message.guild.id}`, roles.map(r => r.id));
        const roleNames = roles.map(r => r.name).join(', ');
        return message.reply(`✅ Drop roles set: ${roleNames}`);
    }
    
    // ===== REACTION DROP ROLES =====
    if (command === 'rdroprole') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return message.reply('❌ Need Manage Roles permission.');
        }
        
        if (args[0] === 'disable' && args[1] === 'all') {
            await db.set(`rdropRoles_${message.guild.id}`, []);
            return message.reply('✅ All reaction drop roles disabled.');
        }
        
        if (args[0] === 'disable' && args[1]) {
            const roleInput = args.slice(1).join(' ');
            let role = null;
            
            if (roleInput.match(/^<@&\d+>$/)) {
                const id = roleInput.replace(/\D/g, '');
                role = message.guild.roles.cache.get(id);
            } else if (/^\d+$/.test(roleInput)) {
                role = message.guild.roles.cache.get(roleInput);
            } else {
                role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleInput.toLowerCase());
            }
            
            if (!role) return message.reply('❌ Role not found.');
            await removeDropRole(message.guild, role.id, 'reaction');
            return message.reply(`✅ Removed ${role.name} from reaction drop roles.`);
        }
        
        if (!args[0]) {
            const roles = await getDropRoles(message.guild, 'reaction');
            if (roles.length === 0) return message.reply('No reaction drop roles set.');
            const list = roles.map(r => `${r.name} (<@&${r.id}>)`).join('\n');
            return message.reply(`**Current Reaction Drop Roles:**\n${list}`);
        }
        
        const roles = [];
        for (const input of args) {
            let role = null;
            if (input.match(/^<@&\d+>$/)) {
                const id = input.replace(/\D/g, '');
                role = message.guild.roles.cache.get(id);
            } else if (/^\d+$/.test(input)) {
                role = message.guild.roles.cache.get(input);
            } else {
                role = message.guild.roles.cache.find(r => r.name.toLowerCase() === input.toLowerCase());
            }
            if (!role) return message.reply(`❌ Role "${input}" not found.`);
            if (roles.length >= 3) return message.reply('❌ Max 3 roles.');
            roles.push(role);
        }
        
        await db.set(`rdropRoles_${message.guild.id}`, roles.map(r => r.id));
        const roleNames = roles.map(r => r.name).join(', ');
        return message.reply(`✅ Reaction drop roles set: ${roleNames}`);
    }
    
    // ===== ADROP ROLES =====
    if (command === 'adroprole') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return message.reply('❌ Need Manage Roles permission.');
        }
        
        if (args[0] === 'disable' && args[1] === 'all') {
            await db.set(`adropRoles_${message.guild.id}`, []);
            return message.reply('✅ All adrop roles disabled.');
        }
        
        if (args[0] === 'disable' && args[1]) {
            const roleInput = args.slice(1).join(' ');
            let role = null;
            
            if (roleInput.match(/^<@&\d+>$/)) {
                const id = roleInput.replace(/\D/g, '');
                role = message.guild.roles.cache.get(id);
            } else if (/^\d+$/.test(roleInput)) {
                role = message.guild.roles.cache.get(roleInput);
            } else {
                role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleInput.toLowerCase());
            }
            
            if (!role) return message.reply('❌ Role not found.');
            await removeDropRole(message.guild, role.id, 'adrop');
            return message.reply(`✅ Removed ${role.name} from adrop roles.`);
        }
        
        if (!args[0]) {
            const roles = await getDropRoles(message.guild, 'adrop');
            if (roles.length === 0) return message.reply('No adrop roles set.');
            const list = roles.map(r => `${r.name} (<@&${r.id}>)`).join('\n');
            return message.reply(`**Current Adrop Roles:**\n${list}`);
        }
        
        const roles = [];
        for (const input of args) {
            let role = null;
            if (input.match(/^<@&\d+>$/)) {
                const id = input.replace(/\D/g, '');
                role = message.guild.roles.cache.get(id);
            } else if (/^\d+$/.test(input)) {
                role = message.guild.roles.cache.get(input);
            } else {
                role = message.guild.roles.cache.find(r => r.name.toLowerCase() === input.toLowerCase());
            }
            if (!role) return message.reply(`❌ Role "${input}" not found.`);
            if (roles.length >= 3) return message.reply('❌ Max 3 roles.');
            roles.push(role);
        }
        
        await db.set(`adropRoles_${message.guild.id}`, roles.map(r => r.id));
        const roleNames = roles.map(r => r.name).join(', ');
        return message.reply(`✅ Adrop roles set: ${roleNames}`);
    }
    
    // ===== NORMAL DROP =====
    if (command === 'drop') {
        if (args.length < 3) {
            return message.reply('❌ Usage: `\'drop <time> <winners> [ct=] [yes/no] <prize>`');
        }
        
        let timeInput = args[0];
        let winnersInput = args[1];
        let claimTime = null;
        let pingSetting = 'yes';
        let prizeStartIndex = 2;
        
        for (let i = 2; i < args.length; i++) {
            if (args[i].startsWith('ct=')) {
                claimTime = parseClaimTime(args[i]);
                if (!claimTime) return message.reply('❌ Invalid claim time. Use: ct=1h');
                prizeStartIndex++;
            } else if (args[i].toLowerCase() === 'yes' || args[i].toLowerCase() === 'no') {
                pingSetting = args[i].toLowerCase();
                prizeStartIndex++;
            }
        }
        
        const time = parseTime(timeInput);
        if (!time) return message.reply('❌ Invalid time. Use: 1s, 1m, 1h, 1d');
        
        const winners = parseInt(winnersInput);
        if (isNaN(winners) || winners < 1) return message.reply('❌ Invalid winners count');
        if (winners > 20) return message.reply('❌ Max 20 winners.');
        
        const prize = args.slice(prizeStartIndex).join(' ');
        if (!prize) return message.reply('❌ Provide prize name.');
        
        // Delete command message
        try { await message.delete(); } catch {}
        
        const dropRoles = await getDropRoles(message.guild, 'normal');
        const endTimestamp = Math.floor((Date.now() + time.ms) / 1000);
        
        const dropEmbed = new EmbedBuilder()
            .setColor(0x90EE90)
            .setTitle(`🎉 ${prize}`)
            .setDescription(`**Hosted by:** ${message.author.tag}`)
            .addFields(
                { name: '⏰ Ends', value: `<t:${endTimestamp}:R>`, inline: true },
                { name: '🏆 Winners', value: `${winners}`, inline: true },
                { name: '📋 Message ID', value: `\`${message.id}\``, inline: true }
            )
            .setFooter({ text: 'React with 🎉 to join!' })
            .setTimestamp();
        
        let dropMsg;
        if (pingSetting === 'yes' && dropRoles.length > 0) {
            const roleMentions = dropRoles.map(r => `<@&${r.id}>`).join(' ');
            dropMsg = await message.channel.send({ content: `🎉 **NEW DROP!** ${roleMentions}`, embeds: [dropEmbed] });
        } else {
            dropMsg = await message.channel.send({ embeds: [dropEmbed] });
        }
        
        await dropMsg.react('🎉');
        
        const dropId = `${message.guild.id}_${dropMsg.id}`;
        await db.set(`drop_${dropId}`, {
            messageId: dropMsg.id,
            channelId: message.channel.id,
            hostId: message.author.id,
            hostTag: message.author.tag,
            prize: prize,
            winners: winners,
            endTime: Date.now() + time.ms,
            claimTime: claimTime ? claimTime.ms : null,
            claimed: false,
            winnerIds: []
        });
        
        setTimeout(async () => {
            try {
                const data = await db.get(`drop_${dropId}`);
                if (!data) return;
                
                const channel = await client.channels.fetch(data.channelId);
                const msg = await channel.messages.fetch(data.messageId);
                const reaction = msg.reactions.cache.get('🎉');
                let winnersList = [];
                
                if (reaction) {
                    const users = await reaction.users.fetch();
                    const participants = users.filter(u => !u.bot).map(u => u.id);
                    if (participants.length > 0) {
                        const shuffled = [...participants].sort(() => Math.random() - 0.5);
                        winnersList = shuffled.slice(0, Math.min(data.winners, participants.length));
                        data.winnerIds = winnersList;
                        await db.set(`drop_${dropId}`, data);
                    }
                }
                
                const updatedEmbed = new EmbedBuilder()
                    .setColor(0x00B0F0)
                    .setTitle(`🎉 ${data.prize}`)
                    .setDescription('**Drop Ended!**')
                    .addFields(
                        { name: '🎯 Hosted by', value: data.hostTag || `<@${data.hostId}>`, inline: true },
                        { name: '⏰ Ended', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
                        { name: '📋 Message ID', value: `\`${data.messageId}\``, inline: true }
                    )
                    .setTimestamp();
                
                await msg.edit({ embeds: [updatedEmbed] });
                
                if (winnersList.length > 0) {
                    const winnerMentions = winnersList.map(id => `<@${id}>`).join(', ');
                    
                    // PING WINNERS OUTSIDE THE EMBED
                    await channel.send(`🏆 **CONGRATULATIONS WINNER${winnersList.length > 1 ? 'S' : ''}!** ${winnerMentions}`);
                    
                    const winnerEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle(`🏆 ${data.prize}`)
                        .setDescription(`**Winner${winnersList.length > 1 ? 's' : ''}:** ${winnerMentions}`)
                        .setFooter({ text: `This drop was hosted by ${data.hostTag || 'Unknown Host'} | Message ID: ${data.messageId}` })
                        .setTimestamp();
                    
                    await channel.send({ embeds: [winnerEmbed] });
                    
                    if (data.claimTime) {
                        const claimEnd = Date.now() + data.claimTime;
                        await channel.send(`⏰ Claim by <t:${Math.floor(claimEnd/1000)}:R>\nHost: \`'claimed\``);
                        
                        setTimeout(async () => {
                            const updated = await db.get(`drop_${dropId}`);
                            if (!updated || updated.claimed) return;
                            await channel.send(`⏰ Claim time ended for **${data.prize}**`);
                            await db.delete(`drop_${dropId}`);
                        }, data.claimTime);
                    } else {
                        await db.delete(`drop_${dropId}`);
                    }
                } else {
                    await channel.send(`❌ Drop ended with no participants.`);
                    await db.delete(`drop_${dropId}`);
                }
            } catch (error) {
                console.error('Drop end error:', error);
            }
        }, time.ms);
        
        return message.reply(`✅ Drop started for **${prize}**!`).catch(() => {});
    }
    
    // ===== REACTION DROP =====
    if (command === 'rdrop') {
        if (args.length < 5) {
            return message.reply('❌ Usage: `\'rdrop <req> <react_time> <drop_time> <winners> [ct=] [yes/no] <prize>`');
        }
        
        let reqInput = args[0];
        let reactTimeInput = args[1];
        let dropTimeInput = args[2];
        let winnersInput = args[3];
        let claimTime = null;
        let pingSetting = 'yes';
        let prizeStartIndex = 4;
        
        for (let i = 4; i < args.length; i++) {
            if (args[i].startsWith('ct=')) {
                claimTime = parseClaimTime(args[i]);
                if (!claimTime) return message.reply('❌ Invalid claim time. Use: ct=1h');
                prizeStartIndex++;
            } else if (args[i].toLowerCase() === 'yes' || args[i].toLowerCase() === 'no') {
                pingSetting = args[i].toLowerCase();
                prizeStartIndex++;
            }
        }
        
        const req = parseInt(reqInput);
        if (isNaN(req) || req < 1) return message.reply('❌ Invalid reactions needed.');
        if (req > 100) return message.reply('❌ Max 100 reactions needed.');
        
        const reactTime = parseTime(reactTimeInput);
        const dropTime = parseTime(dropTimeInput);
        if (!reactTime || !dropTime) return message.reply('❌ Invalid time format.');
        
        const winners = parseInt(winnersInput);
        if (isNaN(winners) || winners < 1) return message.reply('❌ Invalid winners count.');
        if (winners > 20) return message.reply('❌ Max 20 winners.');
        
        const prize = args.slice(prizeStartIndex).join(' ');
        if (!prize) return message.reply('❌ Provide prize name.');
        
        // Delete command message
        try { await message.delete(); } catch {}
        
        const rdropRoles = await getDropRoles(message.guild, 'reaction');
        const reactEnd = Math.floor((Date.now() + reactTime.ms) / 1000);
        
        const reactEmbed = new EmbedBuilder()
            .setColor(0x87CEEB)
            .setTitle(`🎉 ${prize}`)
            .setDescription(`**Hosted by:** ${message.author.tag}`)
            .addFields(
                { name: '⏰ React Time', value: `<t:${reactEnd}:R>`, inline: true },
                { name: '🎯 Required', value: `**${req} reactions**`, inline: true },
                { name: '🏆 Winners', value: `${winners}`, inline: true }
            )
            .setFooter({ text: `Need ${req} reactions to start! React with 🎉` })
            .setTimestamp();
        
        let reactMsg;
        if (pingSetting === 'yes' && rdropRoles.length > 0) {
            const roleMentions = rdropRoles.map(r => `<@&${r.id}>`).join(' ');
            reactMsg = await message.channel.send({ 
                content: `🎉 **REACTION DROP!** ${roleMentions}\nNeed **${req} reactions** to start!`, 
                embeds: [reactEmbed] 
            });
        } else {
            reactMsg = await message.channel.send({ 
                content: `🎉 **REACTION DROP!** Need **${req} reactions** to start!`, 
                embeds: [reactEmbed] 
            });
        }
        
        await reactMsg.react('🎉');
        
        const rdropId = `${message.guild.id}_${reactMsg.id}`;
        await db.set(`rdrop_${rdropId}`, {
            messageId: reactMsg.id,
            channelId: message.channel.id,
            hostId: message.author.id,
            prize: prize,
            winners: winners,
            requiredReactions: req,
            reactEndTime: Date.now() + reactTime.ms,
            dropTime: dropTime.ms,
            claimTime: claimTime ? claimTime.ms : null,
            started: false
        });
        
        return message.reply(`✅ Reaction drop started! Need **${req} reactions** to start.`).catch(() => {});
    }
    
    // ===== ADROP =====
    if (command === 'adrop') {
        if (args.length < 3) {
            return message.reply('❌ Usage: `\'adrop <req> <time> [r=1-10] <prize>`\nExample: `\'adrop 10 5m r=3 Discord Nitro`');
        }
        
        let reqInput = args[0];
        let timeInput = args[1];
        let pingCount = 1; // Default
        let prizeStartIndex = 2;
        
        // Check for r= parameter
        if (args[2] && args[2].startsWith('r=')) {
            const pingValue = parseInt(args[2].slice(2));
            if (!isNaN(pingValue) && pingValue >= 1 && pingValue <= 10) {
                pingCount = pingValue;
            } else {
                return message.reply('❌ Invalid ping count. Use r=1 to r=10');
            }
            prizeStartIndex = 3;
        }
        
        const req = parseInt(reqInput);
        if (isNaN(req) || req < 1) return message.reply('❌ Invalid reactions needed.');
        if (req > 100) return message.reply('❌ Max 100 reactions needed.');
        
        const time = parseTime(timeInput);
        if (!time) return message.reply('❌ Invalid time. Use: 1s, 1m, 1h, 1d');
        
        const prize = args.slice(prizeStartIndex).join(' ');
        if (!prize) return message.reply('❌ Provide prize name.');
        
        // Delete command message
        try { await message.delete(); } catch {}
        
        const adropRoles = await getDropRoles(message.guild, 'adrop');
        const reactEndTimestamp = Math.floor((Date.now() + time.ms) / 1000);
        
        const adropEmbed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle(`🔔 ${prize}`)
            .setDescription(`**Hosted by:** ${message.author.tag}`)
            .addFields(
                { name: '⏰ React Time', value: `<t:${reactEndTimestamp}:R> to alert`, inline: true },
                { name: '🎯 Required', value: `**${req} reactions**`, inline: true },
                { name: '🔔 Pings', value: `${pingCount} time${pingCount > 1 ? 's' : ''}`, inline: true }
            )
            .setFooter({ text: `React with 🎉 to help reach the goal! When reached, host will be pinged.` })
            .setTimestamp();
        
        let adropMsg;
        if (adropRoles.length > 0) {
            const roleMentions = adropRoles.map(r => `<@&${r.id}>`).join(' ');
            adropMsg = await message.channel.send({
                content: `🔔 **NEW ALERT DROP!** ${roleMentions}\nNeed **${req} reactions** to alert the host!`,
                embeds: [adropEmbed]
            });
        } else {
            adropMsg = await message.channel.send({ 
                content: `🔔 **NEW ALERT DROP!**\nNeed **${req} reactions** to alert the host!`,
                embeds: [adropEmbed] 
            });
        }
        
        await adropMsg.react('🎉');
        
        const adropId = `${message.guild.id}_${adropMsg.id}`;
        await db.set(`adrop_${adropId}`, {
            messageId: adropMsg.id,
            channelId: message.channel.id,
            guildId: message.guild.id,
            hostId: message.author.id,
            prize: prize,
            requiredReactions: req,
            reactEndTime: Date.now() + time.ms,
            pingCount: pingCount,
            triggered: false
        });
        
        // Set timeout to check if requirement met
        setTimeout(async () => {
            try {
                const adropData = await db.get(`adrop_${adropId}`);
                if (!adropData || adropData.triggered) return;
                
                const channel = await client.channels.fetch(adropData.channelId);
                const msg = await channel.messages.fetch(adropData.messageId);
                const reaction = msg.reactions.cache.get('🎉');
                
                let got = 0;
                if (reaction) {
                    const users = await reaction.users.fetch();
                    got = users.filter(u => !u.bot).size;
                }
                
                if (got >= adropData.requiredReactions) {
                    // Mark as triggered
                    adropData.triggered = true;
                    await db.set(`adrop_${adropId}`, adropData);
                    
                    // Get host member
                    const host = await message.guild.members.fetch(adropData.hostId).catch(() => null);
                    if (!host) return;
                    
                    // Send initial ping in channel
                    await channel.send(`🔔 **ALERT!** <@${adropData.hostId}> Your adrop for **${adropData.prize}** has reached ${got} reactions! Reply with \`'k\` in any channel to stop pings.`);
                    
                    // Update embed
                    const triggeredEmbed = new EmbedBuilder()
                        .setColor(0xFFA500)
                        .setTitle(`🔔 ${adropData.prize}`)
                        .setDescription('**Goal Reached! Host has been alerted.**')
                        .addFields(
                            { name: '🎯 Reactions', value: `${got}/${adropData.requiredReactions}`, inline: true },
                            { name: '🔔 Pings', value: `${adropData.pingCount} times`, inline: true }
                        )
                        .setFooter({ text: 'Waiting for host to reply with \'k\'' })
                        .setTimestamp();
                    
                    await msg.edit({ embeds: [triggeredEmbed] });
                    
                    // Store confirmation data
                    const timeouts = [];
                    
                    // Schedule pings
                    if (adropData.pingCount > 1) {
                        for (let i = 1; i < adropData.pingCount; i++) {
                            const timeout = setTimeout(async () => {
                                const currentData = await db.get(`adrop_${adropId}`);
                                if (!currentData) return;
                                
                                const confirmData = adropConfirmations.get(adropId);
                                if (confirmData && confirmData.acknowledged) return;
                                
                                if (i <= 2) {
                                    // First few pings in channel
                                    await channel.send(`🔔 **PING ${i+1}/${adropData.pingCount}!** <@${adropData.hostId}> Still waiting for \`'k\`!`);
                                } else {
                                    // Switch to DM
                                    try {
                                        await host.send(`🔔 **DM ALERT!** Your adrop for **${adropData.prize}** still needs acknowledgment! Reply with \`'k\` in any channel to stop pings.`);
                                    } catch (e) {
                                        await channel.send(`🔔 **FINAL REMINDER!** <@${adropData.hostId}> Reply with \`'k\`!`);
                                    }
                                }
                            }, i * 30000); // 30s intervals
                            
                            timeouts.push(timeout);
                        }
                    }
                    
                    // Store in map
                    adropConfirmations.set(adropId, {
                        hostId: adropData.hostId,
                        prize: adropData.prize,
                        messageId: adropData.messageId,
                        channelId: adropData.channelId,
                        timeouts: timeouts,
                        acknowledged: false
                    });
                    
                } else {
                    // Goal not reached - cancel
                    await channel.send(`❌ **ADROP CANCELLED!**\n**${adropData.prize}** only got ${got}/${adropData.requiredReactions} reactions.`);
                    await db.delete(`adrop_${adropId}`);
                    
                    const cancelledEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle(`❌ ${adropData.prize}`)
                        .setDescription('**Cancelled - Goal Not Reached**')
                        .addFields(
                            { name: '🎯 Required', value: `${adropData.requiredReactions} reactions`, inline: true },
                            { name: '📊 Received', value: `${got} reactions`, inline: true }
                        )
                        .setTimestamp();
                    
                    await msg.edit({ embeds: [cancelledEmbed] });
                }
            } catch (error) {
                console.error('Adrop check error:', error);
            }
        }, time.ms);
        
        return message.reply(`✅ Alert drop started for **${prize}**! Need **${req} reactions**.`).catch(() => {});
    }
    
    // ===== FSTART =====
    if (command === 'fstart') {
        if (!args[0]) return message.reply('❌ Usage: `\'fstart <message_id>`');
        
        const msgId = args[0];
        const rdropId = `${message.guild.id}_${msgId}`;
        
        try {
            const data = await db.get(`rdrop_${rdropId}`);
            if (!data) return message.reply('❌ No active reaction drop with that ID.');
            if (data.started) return message.reply('❌ Drop already started.');
            
            const channel = await client.channels.fetch(data.channelId);
            const msg = await channel.messages.fetch(msgId);
            
            // Mark as started
            data.started = true;
            await db.set(`rdrop_${rdropId}`, data);
            
            // Get host user
            let hostUser;
            try {
                hostUser = await client.users.fetch(data.hostId);
            } catch {
                hostUser = { tag: 'Unknown Host' };
            }
            
            // Get reaction drop roles
            const rdropRoles = await getDropRoles(message.guild, 'reaction');
            
            // Create drop embed
            const dropEmbed = new EmbedBuilder()
                .setColor(0x90EE90)
                .setTitle(`🎉 ${data.prize}`)
                .setDescription(`**Hosted by:** ${hostUser.tag}`)
                .addFields(
                    { name: '⏰ Ends', value: `<t:${Math.floor((Date.now() + data.dropTime) / 1000)}:R>`, inline: true },
                    { name: '🏆 Winners', value: `${data.winners}`, inline: true },
                    { name: '📋 Message ID', value: `\`${data.messageId}\``, inline: true }
                )
                .setFooter({ text: 'React with 🎉 to join the drop!' })
                .setTimestamp();
            
            // Send drop message
            let dropMessage;
            const roleMentions = rdropRoles.map(r => `<@&${r.id}>`).join(' ');
            dropMessage = await channel.send({
                content: `🎉 **REACTION DROP STARTED!** ${roleMentions}`,
                embeds: [dropEmbed]
            });
            
            await dropMessage.react('🎉');
            
            // Update original embed
            const updatedEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`✅ ${data.prize}`)
                .setDescription('**Force Started by Host!**')
                .setTimestamp();
            
            await msg.edit({ embeds: [updatedEmbed] });
            
            // Save as normal drop
            const dropId = `${message.guild.id}_${dropMessage.id}`;
            await db.set(`drop_${dropId}`, {
                messageId: dropMessage.id,
                channelId: channel.id,
                guildId: message.guild.id,
                hostId: data.hostId,
                hostTag: hostUser.tag,
                prize: data.prize,
                winners: data.winners,
                endTime: Date.now() + data.dropTime,
                claimTime: data.claimTime,
                claimed: false,
                winnerIds: []
            });
            
            await db.delete(`rdrop_${rdropId}`);
            
            return message.reply(`✅ Force started drop for **${data.prize}**!`).catch(() => {});
            
        } catch (error) {
            return message.reply(`❌ Error: ${error.message}`);
        }
    }
    
    // ===== CANCEL =====
    if (command === 'cancel') {
        if (!args[0]) return message.reply('❌ Usage: `\'cancel <message_id>`');
        
        const msgId = args[0];
        const dropId = `${message.guild.id}_${msgId}`;
        
        try {
            // Check all types
            let data = await db.get(`drop_${dropId}`);
            let type = 'drop';
            if (!data) {
                data = await db.get(`rdrop_${dropId}`);
                type = 'rdrop';
            }
            if (!data) {
                data = await db.get(`adrop_${dropId}`);
                type = 'adrop';
            }
            
            if (!data) return message.reply('❌ No active drop with that ID.');
            
            if (data.hostId !== message.author.id && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                return message.reply('❌ Only host or Manage Messages can cancel.');
            }
            
            const channel = await client.channels.fetch(data.channelId);
            const msg = await channel.messages.fetch(msgId).catch(() => null);
            
            if (msg) {
                const cancelEmbed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle(`❌ ${data.prize}`)
                    .setDescription('**Cancelled by Host**')
                    .setTimestamp();
                
                await msg.edit({ embeds: [cancelEmbed] });
            }
            
            await channel.send(`❌ Drop **${data.prize}** cancelled.`);
            await db.delete(`${type}_${dropId}`);
            
            // Clear any adrop confirmations
            if (type === 'adrop') {
                const confirmData = adropConfirmations.get(dropId);
                if (confirmData && confirmData.timeouts) {
                    confirmData.timeouts.forEach(t => clearTimeout(t));
                }
                adropConfirmations.delete(dropId);
            }
            
            return message.reply(`✅ Drop cancelled.`).catch(() => {});
        } catch (error) {
            return message.reply(`❌ Error: ${error.message}`);
        }
    }
    
    // ===== END =====
    if (command === 'end') {
        if (!args[0]) return message.reply('❌ Usage: `\'end <message_id>`');
        
        const msgId = args[0];
        const dropId = `${message.guild.id}_${msgId}`;
        
        try {
            const data = await db.get(`drop_${dropId}`);
            if (!data) return message.reply('❌ No active drop with that ID.');
            
            if (data.hostId !== message.author.id && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                return message.reply('❌ Only host or Manage Messages can end early.');
            }
            
            const channel = await client.channels.fetch(data.channelId);
            const msg = await channel.messages.fetch(msgId);
            const reaction = msg.reactions.cache.get('🎉');
            let winnersList = [];
            
            if (reaction) {
                const users = await reaction.users.fetch();
                const participants = users.filter(u => !u.bot).map(u => u.id);
                if (participants.length > 0) {
                    const shuffled = [...participants].sort(() => Math.random() - 0.5);
                    winnersList = shuffled.slice(0, Math.min(data.winners, participants.length));
                }
            }
            
            const endedEmbed = new EmbedBuilder()
                .setColor(0x00B0F0)
                .setTitle(`🎉 ${data.prize}`)
                .setDescription('**Ended Early!**')
                .addFields(
                    { name: '🎯 Hosted by', value: data.hostTag || `<@${data.hostId}>`, inline: true },
                    { name: '📋 Message ID', value: `\`${data.messageId}\``, inline: true }
                )
                .setTimestamp();
            
            await msg.edit({ embeds: [endedEmbed] });
            
            if (winnersList.length > 0) {
                const winnerMentions = winnersList.map(id => `<@${id}>`).join(', ');
                await channel.send(`🏆 **WINNERS!** ${winnerMentions}`);
                
                const winnerEmbed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle(`🏆 ${data.prize}`)
                    .setDescription(`**Winners:** ${winnerMentions}`)
                    .setFooter({ text: `Hosted by ${data.hostTag || 'Unknown Host'}` });
                
                await channel.send({ embeds: [winnerEmbed] });
            } else {
                await channel.send(`❌ Drop ended with no participants.`);
            }
            
            await db.delete(`drop_${dropId}`);
            return message.reply(`✅ Drop ended early.`).catch(() => {});
        } catch (error) {
            return message.reply(`❌ Error: ${error.message}`);
        }
    }
    
    // ===== RR (REROLL) =====
    if (command === 'rr') {
        if (!args[0]) return message.reply('❌ Usage: `\'rr <message_id> [count]`');
        
        const msgId = args[0];
        const count = args[1] ? parseInt(args[1]) : null;
        const dropId = `${message.guild.id}_${msgId}`;
        
        try {
            const data = await db.get(`drop_${dropId}`);
            if (!data) return message.reply('❌ No drop found with that ID.');
            
            if (data.hostId !== message.author.id && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                return message.reply('❌ Only host or Manage Messages can reroll.');
            }
            
            const channel = await client.channels.fetch(data.channelId);
            const msg = await channel.messages.fetch(msgId);
            const reaction = msg.reactions.cache.get('🎉');
            
            if (!reaction) return message.reply('❌ No reactions found.');
            
            const users = await reaction.users.fetch();
            const allParticipants = users.filter(u => !u.bot).map(u => u.id);
            
            if (allParticipants.length === 0) return message.reply('❌ No participants.');
            
            const available = allParticipants.filter(id => !data.winnerIds?.includes(id));
            if (available.length === 0) return message.reply('❌ No new participants to reroll from.');
            
            const rerollCount = count || Math.min(data.winners, available.length);
            const shuffled = [...available].sort(() => Math.random() - 0.5);
            const newWinners = shuffled.slice(0, Math.min(rerollCount, available.length));
            
            let finalWinners = [...(data.winnerIds || [])];
            for (let i = 0; i < newWinners.length; i++) {
                if (i < finalWinners.length) {
                    finalWinners[i] = newWinners[i];
                } else {
                    finalWinners.push(newWinners[i]);
                }
            }
            
            data.winnerIds = finalWinners;
            await db.set(`drop_${dropId}`, data);
            
            const winnerMentions = finalWinners.map(id => `<@${id}>`).join(', ');
            await channel.send(`🎲 **REROLL!** New winners: ${winnerMentions}`);
            
            return message.reply(`✅ Rerolled ${newWinners.length} winner(s).`).catch(() => {});
        } catch (error) {
            return message.reply(`❌ Error: ${error.message}`);
        }
    }
    
    // ===== CLAIMED =====
    if (command === 'claimed') {
        const keys = await db.list();
        let found = null;
        let foundId = null;
        
        for (const key of keys) {
            if (key.startsWith('drop_')) {
                const data = await db.get(key);
                if (data && data.channelId === message.channel.id && data.hostId === message.author.id && !data.claimed) {
                    found = data;
                    foundId = key;
                    break;
                }
            }
        }
        
        if (!found) return message.reply('❌ No active drop found to claim.');
        
        found.claimed = true;
        await db.set(foundId, found);
        
        const winnerMention = found.winnerIds?.map(id => `<@${id}>`).join(', ') || 'Unknown';
        await message.channel.send(`✅ **CLAIMED!** Prize **${found.prize}** claimed by ${winnerMention} • Hosted by <@${found.hostId}>`);
        
        await db.delete(foundId);
        try { await message.delete(); } catch {}
    }
});

// ====================================================
// LOGIN
// ====================================================

const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('❌ No token found! Add DISCORD_TOKEN to Secrets');
    process.exit(1);
}

client.login(token).catch(error => {
    console.error('❌ Login failed:', error.message);
});