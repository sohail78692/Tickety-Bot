// index.js

// Load environment variables from .env
require('dotenv').config();

const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    Collection, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ChannelType, 
    PermissionsBitField, 
    EmbedBuilder,
    MessageFlags,
    DiscordAPIError,
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle
} = require('discord.js');
const { createTranscript } = require('discord-html-transcripts');

// ADD EXPRESS REQUIREMENT HERE
const express = require('express');

const commands = require('./commands.js');

// --- DATABASE UTILITIES IMPORT ---
// Import the new Mongoose utility functions from the dedicated file
const { 
    connectDB, 
    getGuildConfig, 
    setGuildConfig, 
    updateGuildConfig 
} = require('./db_config.js'); 


// --- BOT CLIENT SETUP ---

// Intents required for message content, guild member management, and interactions
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [
        Partials.Channel, // Required for DMs
        Partials.Message,
        Partials.Reaction
    ]
});

// A collection to hold all slash commands
client.commands = new Collection();
commands.forEach(cmd => client.commands.set(cmd.data.name, cmd));

// --- BOT UTILITY FUNCTIONS ---

/**
 * Retrieves the current ticket number for a guild's category, 
 * or 0 if the category doesn't exist or is not a proper ticket category.
 * @param {Guild} guild The Discord Guild object.
 * @param {string} categoryId The ID of the ticket category.
 * @returns {number} The next ticket number.
 */
function getNextTicketNumber(guild, categoryId) {
    const category = guild.channels.cache.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
        return 1; // Start from 1 if category is not set up correctly
    }

    // Get all channels in the category that match the ticket name pattern
    const ticketChannels = category.children.cache.filter(c => 
        c.name.startsWith('ticket-') && c.type === ChannelType.GuildText
    );

    let maxNumber = 0;
    
    ticketChannels.forEach(channel => {
        // Extract the number from the channel name (e.g., 'ticket-42' -> 42)
        const match = channel.name.match(/ticket-(\d+)/);
        if (match && match[1]) {
            const number = parseInt(match[1], 10);
            if (number > maxNumber) {
                maxNumber = number;
            }
        }
    });

    return maxNumber + 1;
}

// --- TICKET HANDLERS ---

/**
 * Handles the creation of a new ticket channel.
 * @param {Interaction} interaction The interaction object (button click or modal submit).
 * @param {string} topicValue The value of the selected ticket topic.
 * @param {string} [issueDescription] Optional description from the modal.
 */
async function handleTicketCreation(interaction, topicValue, issueDescription = null) {
    const guild = interaction.guild;
    const user = interaction.user;
    const config = await getGuildConfig(guild.id);

    if (!config.categoryId || !config.supportRoleId) {
        return interaction.editReply({ 
            content: '❌ The ticketing system is not fully configured for this server. Please run `/ticket-config` first.', 
            ephemeral: true 
        }).catch(() => {});
    }

    const topic = config.ticketTopics.find(t => t.value === topicValue);
    if (!topic) {
        return interaction.editReply({ 
            content: '❌ Invalid ticket topic selected.', 
            ephemeral: true 
        }).catch(() => {});
    }
    
    // Check if user already has an open ticket for this guild
    const existingTicket = guild.channels.cache.find(c => 
        c.name.startsWith('ticket-') && c.topic?.includes(`UserID: ${user.id}`)
    );

    if (existingTicket) {
        return interaction.editReply({
            content: `⚠️ You already have an open ticket: ${existingTicket}. Please close your current ticket before opening a new one.`,
            ephemeral: true
        }).catch(() => {});
    }

    const ticketNumber = getNextTicketNumber(guild, config.categoryId);
    const channelName = `ticket-${ticketNumber}`;

    try {
        const ticketChannel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: config.categoryId,
            topic: `Ticket ID: ${channelName} | UserID: ${user.id} | Topic: ${topic.label}`,
            permissionOverwrites: [
                // Deny @everyone from viewing the channel
                {
                    id: guild.id,
                    deny: [PermissionsBitField.Flags.ViewChannel],
                },
                // Allow the user to view, send messages, attach files
                {
                    id: user.id,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.AttachFiles
                    ],
                },
                // Allow the support role to view, send messages, manage channel (for closing)
                {
                    id: config.supportRoleId,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.AttachFiles,
                        PermissionsBitField.Flags.ManageChannels // For closing/locking
                    ],
                },
                // Deny the bot itself from seeing the channel if it's not needed (optional, but good practice)
                {
                    id: client.user.id,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.AttachFiles,
                    ],
                }
            ],
        });
        

        // Confirmation embed for the ticket channel
        const welcomeEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`${topic.emoji ? topic.emoji : '🎫'} New Ticket Opened: ${topic.label}`)
            .setDescription(
                `Welcome ${user}! A member of the <@&${config.supportRoleId}> team will be with you shortly. 
                \n**Issue:** ${issueDescription ? issueDescription : '*(No description provided)*'}`
            )
            .addFields(
                { name: 'Opened By', value: `<@${user.id}>`, inline: true },
                { name: 'Topic', value: topic.label, inline: true },
            )
            .setTimestamp();
            
        // Buttons for staff
        const actionRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_claim')
                    .setLabel('Claim Ticket')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🙋‍♂️'),
                new ButtonBuilder()
                    .setCustomId('ticket_close_confirm')
                    .setLabel('Close')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔒'),
            );
        
        await ticketChannel.send({ 
            content: `<@${user.id}> <@&${config.supportRoleId}>`, 
            embeds: [welcomeEmbed], 
            components: [actionRow] 
        });

        // Confirmation reply to the user who opened the ticket
        await interaction.editReply({ 
            content: `✅ Your ticket has been created! Head over to ${ticketChannel}.`, 
            ephemeral: true 
        });

        // Send log entry (optional)
        if (config.logsChannelId) {
            const logsChannel = guild.channels.cache.get(config.logsChannelId);
            if (logsChannel) {
                const logEmbed = new EmbedBuilder()
                    .setColor(ButtonStyle.Success)
                    .setTitle(`Ticket Opened (#${ticketNumber})`)
                    .setDescription(`**User:** <@${user.id}>\n**Channel:** ${ticketChannel}\n**Topic:** ${topic.label}`)
                    .setTimestamp();
                await logsChannel.send({ embeds: [logEmbed] }).catch(() => console.error("Could not send log message."));
            }
        }

    } catch (error) {
        console.error('Error creating ticket channel:', error);
        await interaction.editReply({ 
            content: '❌ There was an error creating your ticket. Please try again or contact a server admin.', 
            ephemeral: true 
        }).catch(() => {});
    }
}


/**
 * Handles the confirmation process for closing a ticket.
 * @param {Interaction} interaction The button interaction.
 */
async function handleCloseTicketConfirm(interaction) {
    const channel = interaction.channel;
    const config = await getGuildConfig(interaction.guild.id);
    
    // Check if the channel is a ticket channel and user is support staff
    if (!channel.name.startsWith('ticket-') || !interaction.member.roles.cache.has(config.supportRoleId)) {
        return interaction.reply({ content: '❌ This command can only be used by support staff in a ticket channel.', ephemeral: true });
    }

    const closeRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('ticket_close_final')
                .setLabel('Confirm Close')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId('ticket_cancel_close')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('✖️'),
        );

    await interaction.reply({
        content: `⚠️ Are you sure you want to close this ticket? This will archive the channel and create a transcript.`,
        components: [closeRow],
        ephemeral: true
    });
}

/**
 * Handles the final process of closing a ticket, archiving, and logging.
 * @param {Interaction} interaction The button interaction or slash command.
 * @param {boolean} silent Whether to suppress the transcript/log message in the ticket channel.
 */
async function handleCloseTicket(interaction, silent = false) {
    const channel = interaction.channel;
    const guild = interaction.guild;
    const user = interaction.user;
    const config = await getGuildConfig(guild.id);
    
    // Check if the channel is a ticket channel
    if (!channel.name.startsWith('ticket-')) {
        return interaction.reply({ content: '❌ This command must be used in a ticket channel.', ephemeral: true });
    }
    
    // Defer the reply to buy time for the transcript generation
    if (interaction.deferred || interaction.replied) {
        // If this is a final confirmation button click, it's already deferred/replied
        // We will edit the previous ephemeral message instead of deferring again
    } else {
        await interaction.deferReply({ ephemeral: true });
    }


    try {
        // 1. Generate Transcript
        const transcriptFile = await createTranscript(channel, {
            limit: -1, // No message limit
            saveImages: true,
            poweredBy: false,
            fileName: `${channel.name}.html`,
        });

        const ticketUserMatch = channel.topic?.match(/UserID: (\d+)/);
        const ticketUser = ticketUserMatch ? await client.users.fetch(ticketUserMatch[1]) : null;

        // 2. Send Log/Transcript
        if (config.logsChannelId) {
            const logsChannel = guild.channels.cache.get(config.logsChannelId);
            if (logsChannel) {
                const logEmbed = new EmbedBuilder()
                    .setColor(ButtonStyle.Danger)
                    .setTitle(`Ticket Closed: ${channel.name}`)
                    .setDescription(`**User:** ${ticketUser ? `<@${ticketUser.id}>` : 'Unknown'}\n**Closed By:** <@${user.id}>\n**Channel ID:** ${channel.id}`)
                    .setTimestamp();
                
                await logsChannel.send({ 
                    embeds: [logEmbed], 
                    files: [transcriptFile] 
                }).catch(err => console.error("Failed to send transcript/log to logs channel:", err));
            }
        }

        // 3. Notify User via DM
        if (ticketUser) {
            const dmEmbed = new EmbedBuilder()
                .setColor(ButtonStyle.Danger)
                .setTitle(`Ticket Closed in ${guild.name}`)
                .setDescription(`Your ticket (${channel.name}) has been closed by <@${user.id}>.`)
                .setTimestamp();

            await ticketUser.send({ embeds: [dmEmbed], files: [transcriptFile] })
                .catch(() => console.log(`Could not DM user ${ticketUser.tag} the transcript.`));
        }

        // 4. Notify Ticket Channel and Delete
        if (!silent) {
            const closingEmbed = new EmbedBuilder()
                .setColor(ButtonStyle.Danger)
                .setDescription(`✅ Ticket closed by <@${user.id}>. Deleting channel in 5 seconds...`);
            
            // Send the final message in the ticket channel (not ephemeral)
            await channel.send({ embeds: [closingEmbed] });
        }
        
        // Final success reply to the staff member
        await interaction.editReply({ 
            content: `✅ Ticket ${channel.name} has been closed and archived.`, 
            components: [] // Remove components if it was a button interaction
        });

        // Delete channel after a short delay
        setTimeout(() => {
            channel.delete().catch(err => console.error(`Failed to delete channel ${channel.name}:`, err));
        }, 5000);

    } catch (error) {
        console.error('Error during ticket closing process:', error);
        await interaction.editReply({ 
            content: '❌ An error occurred during the closing process. Check console for details.', 
            components: []
        }).catch(() => {});
    }
}

/**
 * Handles claiming a ticket by setting the topic and sending a confirmation.
 * @param {Interaction} interaction The button or slash command interaction.
 * @param {boolean} forceClaim If true, the claim button/command was used.
 */
async function handleClaimTicket(interaction, forceClaim) {
    // FIX: Defer reply immediately to prevent the 10062 "Unknown interaction" error
    // Database lookups and channel operations can take longer than 3 seconds.
    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.channel;
    const user = interaction.user;
    const config = await getGuildConfig(interaction.guild.id); // This DB call can be slow

    // Check if the user has the support role
    if (!interaction.member.roles.cache.has(config.supportRoleId)) {
        return interaction.editReply({ 
            content: '❌ Only users with the configured support role can claim a ticket.', 
            ephemeral: true 
        });
    }

    const currentTopic = channel.topic || '';
    const claimedMatch = currentTopic.match(/Claimed By: (\d+)/);

    if (claimedMatch && !forceClaim) {
        const currentClaimerId = claimedMatch[1];
        if (currentClaimerId === user.id) {
            return interaction.editReply({ content: '⚠️ You have already claimed this ticket.', ephemeral: true });
        } else {
            return interaction.editReply({ 
                content: `⚠️ This ticket is already claimed by <@${currentClaimerId}>. Use \`/ticket-claim force:true\` to forcefully re-claim it.`, 
                ephemeral: true 
            });
        }
    }

    try {
        // Update the topic
        const newTopic = currentTopic.replace(/ \| Claimed By: \d+/, ''); // Remove old claim if present
        await channel.setTopic(`${newTopic} | Claimed By: ${user.id}`);

        const claimEmbed = new EmbedBuilder()
            .setColor(ButtonStyle.Success)
            .setDescription(`✅ This ticket has been claimed by <@${user.id}>. The staff member will assist you shortly.`);

        // Find the initial message and disable/remove the claim button
        const messages = await channel.messages.fetch({ limit: 5 });
        const initialMessage = messages.find(m => m.components.length > 0 && m.components[0].components.some(c => c.customId === 'ticket_claim'));

        if (initialMessage) {
            const updatedRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('ticket_claimed_disabled')
                        .setLabel('Claimed')
                        .setStyle(ButtonStyle.Success)
                        .setDisabled(true)
                        .setEmoji('✅'),
                    // Keep the close button
                    ...initialMessage.components[0].components.filter(c => c.customId !== 'ticket_claim').map(c => new ButtonBuilder(c))
                );

            // Use edit instead of reply for the original message
            await initialMessage.edit({ components: [updatedRow] }).catch(() => {});
        }
        
        // Use editReply since we deferred at the start
        await interaction.editReply({ embeds: [claimEmbed] });

    } catch (error) {
        console.error('Error claiming ticket:', error);
        // Use editReply since we deferred at the start
        await interaction.editReply({ content: '❌ An error occurred while claiming the ticket.', ephemeral: true });
    }
}

/**
 * Handles locking/unlocking a ticket channel for the ticket user.
 * @param {Interaction} interaction The slash command interaction.
 * @param {boolean} lockState True to lock (deny send messages), false to unlock (allow send messages).
 */
async function handleLockTicket(interaction, lockState) {
    const channel = interaction.channel;
    const config = await getGuildConfig(interaction.guild.id);
    
    // Check if the channel is a ticket channel
    if (!channel.name.startsWith('ticket-')) {
        return interaction.reply({ content: '❌ This command must be used in a ticket channel.', ephemeral: true });
    }

    const ticketUserMatch = channel.topic?.match(/UserID: (\d+)/);
    if (!ticketUserMatch) {
        return interaction.reply({ content: '❌ Could not find the original ticket creator from the channel topic.', ephemeral: true });
    }

    const ticketUserId = ticketUserMatch[1];
    
    try {
        await channel.permissionOverwrites.edit(ticketUserId, {
            SendMessages: lockState ? false : true,
        });

        const action = lockState ? 'locked' : 'unlocked';
        const emoji = lockState ? '🔒' : '🔓';

        const embed = new EmbedBuilder()
            .setColor(lockState ? ButtonStyle.Danger : ButtonStyle.Success)
            .setDescription(`${emoji} Ticket has been ${action} by <@${interaction.user.id}>. <@${ticketUserId}> can ${lockState ? 'no longer' : 'now'} send messages.`);
        
        await interaction.reply({ embeds: [embed] });

    } catch (error) {
        console.error(`Error ${lockState ? 'locking' : 'unlocking'} ticket:`, error);
        await interaction.reply({ content: `❌ An error occurred while ${lockState ? 'locking' : 'unlocking'} the ticket.`, ephemeral: true });
    }
}

/**
 * Handles renaming the ticket channel.
 * @param {Interaction} interaction The slash command interaction.
 * @param {string} newName The new desired channel name.
 */
async function handleRenameTicket(interaction, newName) {
    const channel = interaction.channel;
    
    // Simple validation
    if (!channel.name.startsWith('ticket-')) {
        return interaction.reply({ content: '❌ This command must be used in a ticket channel.', ephemeral: true });
    }
    
    // Clean up the name for channel use (lowercase, no spaces, hyphens only)
    const safeName = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    
    if (safeName.length < 2 || safeName.length > 100) {
        return interaction.reply({ content: '❌ The new name must be between 2 and 100 characters after cleanup.', ephemeral: true });
    }

    try {
        await channel.setName(safeName);

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setDescription(`✏️ Ticket channel renamed to **#${safeName}** by <@${interaction.user.id}>.`);
        
        await interaction.reply({ embeds: [embed] });

    } catch (error) {
        console.error('Error renaming ticket:', error);
        await interaction.reply({ content: '❌ An error occurred while renaming the ticket. Ensure the bot has the `Manage Channels` permission.', ephemeral: true });
    }
}

/**
 * Handles adding or removing a user from the ticket channel permissions.
 * @param {Interaction} interaction The slash command interaction.
 * @param {User} userToManage The user to add/remove.
 * @param {boolean} isAdd True for adding, false for removing.
 */
async function handleUserManagement(interaction, userToManage, isAdd) {
    const channel = interaction.channel;
    
    if (!channel.name.startsWith('ticket-')) {
        return interaction.reply({ content: '❌ This command must be used in a ticket channel.', ephemeral: true });
    }

    try {
        if (isAdd) {
            await channel.permissionOverwrites.edit(userToManage.id, {
                ViewChannel: true,
                SendMessages: true,
                AttachFiles: true,
            });
            const embed = new EmbedBuilder()
                .setColor(ButtonStyle.Success)
                .setDescription(`➕ <@${userToManage.id}> has been added to the ticket by <@${interaction.user.id}>.`);
            await interaction.reply({ embeds: [embed] });
        } else {
            await channel.permissionOverwrites.delete(userToManage.id);
            const embed = new EmbedBuilder()
                .setColor(ButtonStyle.Danger)
                .setDescription(`➖ <@${userToManage.id}> has been removed from the ticket by <@${interaction.user.id}>.`);
            await interaction.reply({ embeds: [embed] });
        }
    } catch (error) {
        console.error(`Error ${isAdd ? 'adding' : 'removing'} user:`, error);
        await interaction.reply({ content: `❌ An error occurred while ${isAdd ? 'adding' : 'removing'} the user. Ensure the bot has the correct permissions.`, ephemeral: true });
    }
}

// --- BOT EVENTS ---

client.on('ready', async () => {
    console.log(`🤖 ${client.user.tag} is online and ready!`);
    
    // Register commands globally
    const clientId = process.env.CLIENT_ID;
    const guildId = client.guilds.cache.first()?.id; // Optional: register to the first guild for quicker testing
    
    const commandData = client.commands.map(command => command.data.toJSON());
    
    try {
        const rest = client.rest.setToken(process.env.BOT_TOKEN);

        // Register commands globally (usually takes up to an hour)
        await rest.put(
            `/applications/${clientId}/commands`,
            { body: commandData },
        );
        // Or register per-guild for instant testing (uncomment to use):
        // await rest.put(
        //     `/applications/${clientId}/guilds/${guildId}/commands`,
        //     { body: commandData },
        // );

        console.log('✅ Successfully registered application commands.');
    } catch (error) {
        console.error('❌ Failed to register application commands:', error);
    }
});


client.on('interactionCreate', async interaction => {
    // --- Slash Command Handling ---
    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);

        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            return;
        }

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
            } else {
                await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
            }
        }
    } 
    // --- Button/Select Menu/Modal Handling ---
    else if (interaction.isButton()) {
        const customId = interaction.customId;

        if (customId === 'ticket_close_confirm') {
            await handleCloseTicketConfirm(interaction);
        } else if (customId === 'ticket_close_final') {
            // Already handled by close confirm deferral, just execute the closing logic
            await handleCloseTicket(interaction);
        } else if (customId === 'ticket_cancel_close') {
            await interaction.update({ content: '❌ Ticket closure cancelled.', components: [] });
        } else if (customId === 'ticket_claim') {
            // This handler is now async and defers its reply
            await handleClaimTicket(interaction, false);
        } else if (customId.startsWith('ticket_open_')) {
            const topicValue = customId.replace('ticket_open_', '');
            const config = await getGuildConfig(interaction.guild.id);
            const topic = config.ticketTopics.find(t => t.value === topicValue);

            if (!topic) {
                return interaction.reply({ content: '❌ Invalid ticket topic.', ephemeral: true });
            }

            // Create a modal for additional information
            const modal = new ModalBuilder()
                .setCustomId(`ticket_modal_${topicValue}`)
                .setTitle(`Open Ticket: ${topic.label}`);
            
            const descriptionInput = new TextInputBuilder()
                .setCustomId('issue_description')
                .setLabel('Please describe your issue (Required)')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMinLength(10)
                .setMaxLength(1000);

            const actionRow = new ActionRowBuilder().addComponents(descriptionInput);
            modal.addComponents(actionRow);

            await interaction.showModal(modal);
        }
    } else if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('ticket_modal_')) {
            await interaction.deferReply({ ephemeral: true });

            const topicValue = interaction.customId.replace('ticket_modal_', '');
            const issueDescription = interaction.fields.getTextInputValue('issue_description');
            
            await handleTicketCreation(interaction, topicValue, issueDescription);
        }
    } else if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'ticket_panel_topic_select') {
             const topicValue = interaction.values[0]; // Only one selection is possible
             const config = await getGuildConfig(interaction.guild.id);
             const topic = config.ticketTopics.find(t => t.value === topicValue);

             if (!topic) {
                 return interaction.reply({ content: '❌ Invalid ticket topic.', ephemeral: true });
             }

             // Create a modal for additional information
             const modal = new ModalBuilder()
                 .setCustomId(`ticket_modal_${topicValue}`)
                 .setTitle(`Open Ticket: ${topic.label}`);
            
             const descriptionInput = new TextInputBuilder()
                 .setCustomId('issue_description')
                 .setLabel('Please describe your issue (Required)')
                 .setStyle(TextInputStyle.Paragraph)
                 .setRequired(true)
                 .setMinLength(10)
                 .setMaxLength(1000);

             const actionRow = new ActionRowBuilder().addComponents(descriptionInput);
             modal.addComponents(actionRow);

             await interaction.showModal(modal);
        }
    }
});


// --- GLOBAL CRASH HANDLERS ---\
process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 UNHANDLED REJECTION:', promise, 'Reason:', reason);
});

process.on('uncaughtException', (err, origin) => {
    console.error(`💥 UNCAUGHT EXCEPTION: ${err.message}\nOrigin: ${origin}`);
});

const app = express();
// Use the port provided by the hosting environment or default to 3000
const port = process.env.PORT || 3000;

// Simple route for Uptime Robot to ping
app.get('/', (req, res) => {
    // Respond with a simple status message and a 200 OK status
    res.status(200).send('Bot is running and listening for Uptime Robot pings!');
});

// Start the web server
app.listen(port, () => {
    console.log(`🌍 Web server listening on port ${port} for keep-alive pings.`);
});


// --- START BOT ---
// 1. Connect to MongoDB (via the imported utility)
connectDB()
    // 2. Login to Discord
    .then(() => client.login(process.env.BOT_TOKEN))
    .catch(error => console.error('Failed to start bot due to DB or login error:', error));


// --- EXPORT HANDLERS/UTILITIES ---\
// Export necessary functions for use in commands.js
module.exports = {
    handleTicketCreation,
    handleCloseTicket,
    handleClaimTicket,
    handleLockTicket,
    handleRenameTicket,
    handleUserManagement,
    getGuildConfig, 
    setGuildConfig, 
    updateGuildConfig,
};