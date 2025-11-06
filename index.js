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
const fs = require('fs/promises'); 

const CONFIG_FILE = 'config.json';
const commands = require('./commands.js');

// --- CLIENT INITIALIZATION ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.MessageContent,
    ],
    partials: [
        Partials.Channel,
    ],
});

// --- COLLECTIONS ---
client.commands = new Collection();
commands.forEach(command => client.commands.set(command.data.name, command));
client.ticketCooldowns = new Collection();
const TICKET_COOLDOWN_MINUTES = 3;

// --- UTILITY FUNCTIONS ---
async function readConfig() {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        // If config doesn't exist or is empty, create a blank object
        if (error.code === 'ENOENT') {
            await fs.writeFile(CONFIG_FILE, JSON.stringify({}, null, 2));
            return {};
        }
        console.warn("Could not read config.json:", error.message);
        return {}; // Return empty object on other errors
    }
}

const isTicketChannel = (channel, config) => {
    if (!config || !config.categoryId) return false;
    return channel.type === ChannelType.GuildText && 
           channel.parentId === config.categoryId;
}

const isSupportUser = (member, config) => {
    if (!config || !config.supportRoleId) return false;
    // Check if member object is valid
    if (!member || !member.roles) return false; 
    return member.roles.cache.has(config.supportRoleId) || 
           member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// Finds the original ticket creator's ID from the channel topic
const getTicketCreatorId = (channel) => {
    if (!channel.topic) return null;
    const match = channel.topic.match(/User ID: (\d+)/);
    return match ? match[1] : null;
}

// Finds the main "control panel" embed message in a ticket channel
async function getControlPanelMessage(channel) {
    try {
        // Fetch the first message in the channel, which should be the welcome embed
        const messages = await channel.messages.fetch({ limit: 1, after: '0' });
        const message = messages.first();
        
        // Verify it's from the bot and has the correct embed
        if (message && message.author.id === client.user.id && message.embeds[0]?.footer?.text.includes('Ticket ID:')) {
            return message;
        }
        
        // Fallback: Search last 10 messages if first isn't it (e.g., pings)
        const recentMessages = await channel.messages.fetch({ limit: 10 });
        const panelMessage = recentMessages.find(m => 
            m.author.id === client.user.id && 
            m.embeds[0]?.footer?.text.includes('Ticket ID:')
        );
        
        return panelMessage || null;

    } catch (error) {
        console.error(`Error fetching control panel message in ${channel.id}:`, error);
        return null;
    }
}

// --- PRIMARY EVENT HANDLERS ---

// Ready Event
client.on('clientReady', () => { // FIX: Use 'clientReady' to resolve DeprecationWarning
    console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
    client.user.setActivity('Serving Support Tickets', { type: 3 }); // Type 3 is "WATCHING"
    
    // Register commands
    client.application.commands.set(client.commands.map(cmd => cmd.data))
        .then(() => console.log('✅ Slash commands registered successfully.'))
        .catch(error => console.error('❌ Failed to register slash commands:', error));
});

// Interaction Create Event (Main Router)
client.on('interactionCreate', async interaction => {
    if (!interaction.inGuild()) return;

    // Top-level error handler for ALL interactions. This is a failsafe.
    try {
        const config = (await readConfig())[interaction.guildId];
        
        // Check if bot is configured
        if (!config && !interaction.isChatInputCommand()) {
             // If a button/menu is clicked and config is gone, just error
            if (interaction.isRepliable()) {
                 return interaction.reply({ content: '❌ This component is outdated or the bot is not configured.', flags: MessageFlags.Ephemeral });
            }
            return;
        }
        
        if (!config && interaction.isChatInputCommand() && interaction.commandName !== 'ticket-config') {
             return interaction.reply({ content: '❌ The bot is not configured on this server. Please ask an administrator to run `/ticket-config`.', flags: MessageFlags.Ephemeral });
        }
        
        // Route interactions
        if (interaction.isChatInputCommand()) {
            await executeSlashCommand(interaction, config);
        } else if (interaction.isStringSelectMenu()) {
            await handleSelectMenuInteraction(interaction, config);
        } else if (interaction.isModalSubmit()) {
            await handleModalSubmit(interaction, config);
        } else if (interaction.isButton()) {
            await handleButtonInteraction(interaction, config);
        }
    } catch (error) {
        console.error('💥 Unhandled error in interactionCreate:', error);
        // FIX: Use flags instead of "ephemeral: true"
        const errorReply = { content: '❌ An unknown error occurred. The development team has been notified.', flags: MessageFlags.Ephemeral };
        if (interaction.isRepliable()) {
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(errorReply).catch(e => console.error("Failed to editReply on unhandled error:", e));
            } else {
                await interaction.reply(errorReply).catch(e => console.error("Failed to reply on unhandled error:", e));
            }
        }
    }
});

// --- INTERACTION LOGIC ---

/** 1. SLASH COMMANDS **/
async function executeSlashCommand(interaction, config) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    // Centralized validation for staff-only commands used inside tickets
    const staffTicketCommands = ['ticket-rename', 'ticket-add', 'ticket-remove', 'ticket-claim', 'ticket-lock', 'ticket-unlock'];

    if (staffTicketCommands.includes(interaction.commandName)) {
        if (!isTicketChannel(interaction.channel, config)) {
            return interaction.reply({ content: '🚫 This command can only be used inside an active ticket channel.', flags: MessageFlags.Ephemeral });
        }
        if (!isSupportUser(interaction.member, config)) {
            return interaction.reply({ content: '🚫 You must be a member of the Support Team to use this command.', flags: MessageFlags.Ephemeral });
        }
    }

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(`Error executing command ${interaction.commandName}:`, error);
        await interaction.reply({ content: `❌ An error occurred while running this command.`, flags: MessageFlags.Ephemeral });
    }
}

/** 2. SELECT MENUS (Ticket Topic Selection) **/
async function handleSelectMenuInteraction(interaction, config) {
    if (interaction.customId !== 'ticket_panel_menu') return;

    // --- 1. Cooldown Check ---
    const cooldownData = client.ticketCooldowns.get(interaction.user.id);
    if (cooldownData) {
        const remainingTime = (cooldownData - Date.now()) / 1000;
        return interaction.reply({
            content: `⏳ **Cooldown Active!** Please wait **${Math.ceil(remainingTime)}** seconds before creating a new ticket.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // --- 2. Existing Ticket Check ---
    const existingTicket = interaction.guild.channels.cache.find(c => 
        c.parentId === config.categoryId && 
        c.topic && 
        c.topic.includes(`User ID: ${interaction.user.id}`)
    );
    if (existingTicket) {
        return interaction.reply({ 
            content: `⚠️ You already have an open ticket: ${existingTicket}.\nPlease close your existing ticket before opening a new one.`, 
            flags: MessageFlags.Ephemeral 
        });
    }

    // --- 3. Show Modal ---
    const topicValue = interaction.values[0];
    const topic = config.ticketTopics.find(t => t.value === topicValue);
    if (!topic) {
        return interaction.reply({ content: '❌ That topic seems to be outdated. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const modal = new ModalBuilder()
        .setCustomId(`ticket_create_modal_${topicValue}`)
        .setTitle(`📝 ${topic.label}`);

    const subjectInput = new TextInputBuilder()
        .setCustomId('ticket_subject')
        .setLabel("Subject")
        .setPlaceholder("e.g., I can't connect to the server")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);
        
    const descriptionInput = new TextInputBuilder()
        .setCustomId('ticket_description')
        .setLabel("Detailed Description")
        .setPlaceholder("Please provide as much detail as possible, including any steps you've already taken.")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(20)
        .setMaxLength(1000);

    modal.addComponents(
        new ActionRowBuilder().addComponents(subjectInput),
        new ActionRowBuilder().addComponents(descriptionInput)
    );

    await interaction.showModal(modal);
}

/** 3. MODAL SUBMITS (Ticket Creation) **/
async function handleModalSubmit(interaction, config) {
    if (!interaction.customId.startsWith('ticket_create_modal_')) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const topicValue = interaction.customId.replace('ticket_create_modal_', '');
    const topic = config.ticketTopics.find(t => t.value === topicValue);
    const subject = interaction.fields.getTextInputValue('ticket_subject');
    const description = interaction.fields.getTextInputValue('ticket_description');

    if (!topic) {
        return interaction.editReply({ content: '❌ An error occurred (invalid topic). Please try again.' });
    }

    // --- Create Ticket Channel ---
    try {
        const channelName = `${topic.value}-${interaction.user.username.substring(0, 15)}`;
        
        const newChannel = await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: config.categoryId,
            topic: `Ticket for ${interaction.user.tag} (User ID: ${interaction.user.id}). Subject: ${subject}`,
            permissionOverwrites: [
                { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }, // @everyone
                { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // Ticket Creator
                { id: config.supportRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // Support Role
                { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] } // Bot
            ],
        });

        // --- Send Welcome Message & Control Panel ---
        const welcomeEmbed = new EmbedBuilder()
            .setTitle(`${topic.emoji || '🎫'} ${topic.label} Ticket`)
            .setColor(0x5865F2) // Blue
            .addFields(
                { name: '👤 User', value: `${interaction.user}`, inline: true },
                { name: '🛡️ Claimed By', value: '`Unclaimed`', inline: true },
                { name: '⌛ Status', value: '`Open`', inline: true },
                { name: '📋 Subject', value: subject, inline: false },
                { name: '📝 Description', value: description, inline: false }
            )
            .setFooter({ text: `Ticket ID: ${newChannel.id}` });
        
        const staffRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setStyle(ButtonStyle.Success).setEmoji('🙋'),
            new ButtonBuilder().setCustomId('ticket_lock').setLabel('Lock').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
            new ButtonBuilder().setCustomId('ticket_close_start').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('❌')
        );

        await newChannel.send({ 
            content: `Welcome ${interaction.user}! <@&${config.supportRoleId}> will be with you shortly.`, 
            embeds: [welcomeEmbed], 
            components: [staffRow] 
        });

        // --- Set Cooldown ---
        const cooldownEndTime = Date.now() + (TICKET_COOLDOWN_MINUTES * 60 * 1000);
        client.ticketCooldowns.set(interaction.user.id, cooldownEndTime);
        setTimeout(() => client.ticketCooldowns.delete(interaction.user.id), cooldownEndTime - Date.now());

        await interaction.editReply({ 
            content: `✅ **Ticket Created!**\nYour support ticket has been opened in ${newChannel}.`
        });

    } catch (error) {
        console.error('Error creating ticket channel:', error);
        if (error.code === 50013) { // Missing Permissions
            return interaction.editReply({ 
                content: `❌ **Permissions Error!**\nI failed to create the ticket channel. Please ask an admin to ensure I have \`Manage Channels\` and \`Manage Roles\` permissions in the \`${interaction.guild.channels.cache.get(config.categoryId).name}\` category.`
            });
        }
        await interaction.editReply({ content: '❌ An unexpected error occurred while creating your ticket.' });
    }
}

/** 4. BUTTON INTERACTIONS (Claim, Lock, Close) **/
async function handleButtonInteraction(interaction, config) {
    if (!isTicketChannel(interaction.channel, config)) return; // Ignore buttons outside tickets
    
    // --- Staff-Only Button Validation ---
    const staffButtons = ['ticket_claim', 'ticket_unclaim', 'ticket_lock', 'ticket_unlock'];
    if (staffButtons.includes(interaction.customId)) {
        if (!isSupportUser(interaction.member, config)) {
            return interaction.reply({ content: '🚫 This button is for Support Team members only.', flags: MessageFlags.Ephemeral });
        }
    }
    
    // --- Button Router ---
    switch (interaction.customId) {
        case 'ticket_claim':
            await module.exports.handleClaimTicket(interaction, false); // false = not forced
            break;
        case 'ticket_unclaim':
            await handleUnclaimTicket(interaction);
            break;
        case 'ticket_lock':
            await module.exports.handleLockTicket(interaction, true); // true = lock
            break;
        case 'ticket_unlock':
            await module.exports.handleLockTicket(interaction, false); // false = unlock
            break;
        case 'ticket_close_start':
            await handleCloseButton(interaction, config);
            break;
        case 'ticket_close_confirm':
            await closeTicket(interaction, config);
            break;
        case 'ticket_close_cancel':
            await interaction.message.delete().catch(() => {});
            break;
    }
}


// --- 5. CORE TICKET FUNCTIONS ---
// We export these functions so commands.js can call them

/** Handles Ticket Claiming (Button + Command) **/
module.exports.handleClaimTicket = async (interaction, force = false) => {
    // `force` is true when called from /ticket-claim, false from button
    const isCommand = force;
    
    if (isCommand) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferUpdate();

    const reply = isCommand ? interaction.editReply.bind(interaction) : interaction.followUp.bind(interaction);

    const controlPanelMessage = await getControlPanelMessage(interaction.channel);
    if (!controlPanelMessage) return reply({ content: '❌ Cannot find ticket control panel message.', flags: MessageFlags.Ephemeral });

    const embed = new EmbedBuilder(controlPanelMessage.embeds[0].data);
    const claimedByField = embed.data.fields.find(f => f.name === '🛡️ Claimed By');

    if (claimedByField.value !== '`Unclaimed`' && claimedByField.value !== `<@${interaction.user.id}>`) {
        return reply({ content: `⚠️ This ticket is already claimed by ${claimedByField.value}!`, flags: MessageFlags.Ephemeral });
    }
    if (claimedByField.value === `<@${interaction.user.id}>`) {
        return reply({ content: 'ℹ️ You have already claimed this ticket.', flags: MessageFlags.Ephemeral });
    }

    // Update Embed
    embed.data.fields.find(f => f.name === '🛡️ Claimed By').value = `${interaction.user}`;
    embed.data.fields.find(f => f.name === '⌛ Status').value = '`In Progress`';
    embed.setColor(0xFEE75C); // Yellow

    // **BUG FIX (50035):** Rebuild the row declaratively
    const newRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_unclaim').setLabel('Unclaim').setStyle(ButtonStyle.Success).setEmoji('👤'),
        new ButtonBuilder().setCustomId('ticket_lock').setLabel('Lock').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
        new ButtonBuilder().setCustomId('ticket_close_start').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('❌')
    );
    
    await controlPanelMessage.edit({ embeds: [embed], components: [newRow] });
    
    const claimEmbed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setDescription(`🙋 ${interaction.user} has **claimed** this ticket.`);
    await interaction.channel.send({ embeds: [claimEmbed] });
    
    if (isCommand) await interaction.editReply({ content: '✅ Ticket claimed!', flags: MessageFlags.Ephemeral });
};

/** Handles Ticket Unclaiming (Button) **/
async function handleUnclaimTicket(interaction) {
    await interaction.deferUpdate();

    const controlPanelMessage = await getControlPanelMessage(interaction.channel);
    if (!controlPanelMessage) return; // Fail silently, maybe log
    
    const embed = new EmbedBuilder(controlPanelMessage.embeds[0].data);

    // Update Embed
    embed.data.fields.find(f => f.name === '🛡️ Claimed By').value = '`Unclaimed`';
    embed.data.fields.find(f => f.name === '⌛ Status').value = '`Open`';
    embed.setColor(0x5865F2); // Blue

    // **BUG FIX (50035):** Rebuild the row declaratively
    const newRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setStyle(ButtonStyle.Success).setEmoji('🙋'),
        new ButtonBuilder().setCustomId('ticket_lock').setLabel('Lock').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
        new ButtonBuilder().setCustomId('ticket_close_start').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('❌')
    );

    await controlPanelMessage.edit({ embeds: [embed], components: [newRow] });
    
    const unclaimEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setDescription(`👋 ${interaction.user} has **unclaimed** this ticket. It is now available.`);
    await interaction.channel.send({ embeds: [unclaimEmbed] });
}

/** Handles Ticket Locking/Unlocking (Button + Command) **/
module.exports.handleLockTicket = async (interaction, lock = true) => {
    // `lock` is true to lock, false to unlock
    const isCommand = interaction.isCommand();
    
    if (isCommand) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferUpdate();

    const reply = isCommand ? interaction.editReply.bind(interaction) : interaction.followUp.bind(interaction);

    const channel = interaction.channel;
    const creatorId = getTicketCreatorId(channel);
    if (!creatorId) return reply({ content: '❌ Cannot find ticket creator ID.', flags: MessageFlags.Ephemeral });

    const controlPanelMessage = await getControlPanelMessage(channel);
    if (!controlPanelMessage) return reply({ content: '❌ Cannot find ticket control panel.', flags: MessageFlags.Ephemeral });

    const embed = new EmbedBuilder(controlPanelMessage.embeds[0].data);
    
    // **BUG FIX (50035):** Get the current Claim/Unclaim button to preserve it
    const claimButton = controlPanelMessage.components[0].components.find(c => c.customId.includes('claim'));
    const closeButton = new ButtonBuilder().setCustomId('ticket_close_start').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('❌');
    
    // Failsafe if claim button isn't found (should be impossible)
    if (!claimButton) {
        console.error("CRITICAL: Could not find a claim/unclaim button during lock.");
        return reply({ content: '❌ A critical error occurred. Cannot find claim button.', flags: MessageFlags.Ephemeral });
    }

    try {
        if (lock) {
            // --- LOCK ---
            await channel.permissionOverwrites.edit(creatorId, { SendMessages: false });
            
            embed.data.fields.find(f => f.name === '⌛ Status').value = '`Locked`';
            embed.setColor(0xED4245); // Red

            // Rebuild row with new "Unlock" button
            const newRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder(claimButton.data), // Add the existing claim/unclaim button
                new ButtonBuilder().setCustomId('ticket_unlock').setLabel('Unlock').setStyle(ButtonStyle.Success).setEmoji('🔓'),
                closeButton
            );

            await controlPanelMessage.edit({ embeds: [embed], components: [newRow] });
            
            const lockEmbed = new EmbedBuilder().setColor(0xED4245).setDescription(`🔒 ${interaction.user} has **locked** this ticket. The user can no longer send messages.`);
            await channel.send({ embeds: [lockEmbed] });
            
            if (isCommand) await interaction.editReply({ content: '✅ Ticket locked.', flags: MessageFlags.Ephemeral });

        } else {
            // --- UNLOCK ---
            await channel.permissionOverwrites.edit(creatorId, { SendMessages: true });
            
            const claimedBy = embed.data.fields.find(f => f.name === '🛡️ Claimed By').value;
            embed.data.fields.find(f => f.name === '⌛ Status').value = (claimedBy === '`Unclaimed`') ? '`Open`' : '`In Progress`';
            embed.setColor((claimedBy === '`Unclaimed`') ? 0x5865F2 : 0xFEE75C); // Blue or Yellow

            // Rebuild row with new "Lock" button
            const newRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder(claimButton.data), // Add the existing claim/unclaim button
                new ButtonBuilder().setCustomId('ticket_lock').setLabel('Lock').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
                closeButton
            );

            await controlPanelMessage.edit({ embeds: [embed], components: [newRow] });
            
            const unlockEmbed = new EmbedBuilder().setColor(0x57F287).setDescription(`🔓 ${interaction.user} has **unlocked** this ticket. The user can now send messages.`);
            await channel.send({ embeds: [unlockEmbed] });
            
            if (isCommand) await interaction.editReply({ content: '✅ Ticket unlocked.', flags: MessageFlags.Ephemeral });
        }
    } catch (error) {
        console.error('Error locking/unlocking ticket:', error);
        const errorMsg = '❌ **Error:** Failed to set permissions. Do I have `Manage Roles` permission in this category?';
        if (isCommand) {
            await interaction.editReply({ content: errorMsg, flags: MessageFlags.Ephemeral });
        } else {
            // Can't reply ephemerally to a deferred update, so send a message
            await channel.send({ content: `${interaction.user}, ${errorMsg}` });
        }
    }
};

/** Handles Close Button (Initial Confirmation) **/
async function handleCloseButton(interaction, config) {
    const creatorId = getTicketCreatorId(interaction.channel);

    // Only the ticket creator OR a support user can close
    if (interaction.user.id !== creatorId && !isSupportUser(interaction.member, config)) {
        return interaction.reply({
            content: '🚫 You must be the ticket owner or a Support Team member to close this ticket.',
            flags: MessageFlags.Ephemeral
        });
    }

    const confirmEmbed = new EmbedBuilder()
        .setTitle('⚠️ Are you sure?')
        .setDescription('Are you sure you want to close this ticket? This action cannot be undone.\nA transcript will be saved.')
        .setColor(0xFEE75C); // Yellow

    const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_close_confirm').setLabel('Confirm Close').setStyle(ButtonStyle.Danger).setEmoji('✔️'),
        new ButtonBuilder().setCustomId('ticket_close_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('✖️')
    );

    await interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], flags: MessageFlags.Ephemeral });
}

/** Handles Close Confirmation (Deletion & Transcript) **/
async function closeTicket(interaction, config) {
    // This function is triggered by 'ticket_close_confirm' button
    
    // Acknowledge button press and hide confirmation message
    try {
        await interaction.update({ content: '⌛ Closing ticket and generating transcript...', components: [], embeds: [] });
    } catch (e) {
        console.warn("Could not edit close confirmation reply, probably already closed.");
        return; // Stop execution if we can't edit the reply (e.g., double-click)
    }
    
    const channel = interaction.channel;

    try {
        // --- 1. Generate Transcript ---
        const transcriptFile = await createTranscript(channel, {
            limit: -1,
            returnType: 'attachment',
            saveImages: true,
            poweredBy: false,
            filename: `${channel.name}-transcript.html`,
        });

        // --- 2. Send Transcript to Logs Channel ---
        const logsChannel = interaction.guild.channels.cache.get(config.logsChannelId);
        const creatorId = getTicketCreatorId(channel);
        
        if (logsChannel) {
            const logEmbed = new EmbedBuilder()
                .setTitle('📜 Ticket Closed & Archived')
                .setColor(0x95A5A6) // Grey
                .addFields(
                    { name: 'Ticket', value: `\`#${channel.name}\``, inline: true },
                    { name: 'Closed By', value: `${interaction.user}`, inline: true },
                    { name: 'Opened By', value: creatorId ? `<@${creatorId}>` : '`Unknown`', inline: true }
                )
                .setTimestamp();
            
            try {
                await logsChannel.send({ 
                    embeds: [logEmbed], 
                    files: [transcriptFile] 
                });
            } catch (logError) {
                console.error("Error sending to log channel:", logError);
                // Send error message into the ticket channel itself as a fallback
                await channel.send(`❌ **Critical Error:** Failed to send transcript to logs channel. It may be missing permissions. Archiving ticket...`);
            }
        } else {
            console.warn(`Logs channel ID ${config.logsChannelId} not found! Transcript not saved.`);
            await channel.send('⚠️ **Warning:** Logs channel not found. Transcript will not be saved.');
        }

        // --- 3. Delete Channel ---
        await channel.send('✅ Ticket closed. This channel will be deleted in 5 seconds.');
        setTimeout(() => {
            channel.delete().catch(err => console.error('Failed to delete ticket channel:', err));
        }, 5000);

    } catch (error) {
        console.error('Error during ticket closure:', error);
        await channel.send(`❌ An unexpected error occurred while closing the ticket. Please delete it manually. Error: ${error.message}`);
    }
}

// --- GLOBAL CRASH HANDLERS ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 UNHANDLED REJECTION:', promise, 'Reason:', reason);
});

process.on('uncaughtException', (err, origin) => {
    console.error(`💥 UNCAUGHT EXCEPTION: ${err.message}\nOrigin: ${origin}`);
});

client.login(process.env.BOT_TOKEN);