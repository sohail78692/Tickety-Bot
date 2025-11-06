// commands.js

const { 
    SlashCommandBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    EmbedBuilder, 
    PermissionsBitField, 
    ChannelType,
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle,
    StringSelectMenuBuilder
} = require('discord.js');

// --- DATABASE UTILITIES IMPORT (FIX: Imports from db_config.js now) ---
// Import the Mongoose utility functions from the dedicated database file
const { 
    getGuildConfig, 
    setGuildConfig, 
    updateGuildConfig 
} = require('./db_config.js'); // FIXED: Changed from './index.js' to './db_config.js'


// --- Utility Function to Check Config Status ---
/**
 * Checks if the essential configuration (category and support role) is set.
 * @param {object} config The guild configuration object.
 * @returns {boolean} True if configured, false otherwise.
 */
function isConfigured(config) {
    return config.categoryId && config.supportRoleId;
}

// --- Permissions Definitions ---
const REQUIRED_LOGS_PERMISSIONS = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.AttachFiles
];
const REQUIRED_CATEGORY_PERMISSIONS = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.ManageChannels, // Required to set permissions for new channels
];

// --- 1. /ticket-config (STAFF) ---
const ticketConfigCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-config')
        .setDescription('⚙️ [Staff] Configure the main ticketing system settings.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addChannelOption(option => 
            option.setName('category')
                .setDescription('The category where new ticket channels will be created.')
                .addChannelTypes(ChannelType.GuildCategory)
                .setRequired(false))
        .addChannelOption(option =>
            option.setName('logs-channel')
                .setDescription('The text channel where transcripts and logs will be sent.')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false))
        .addRoleOption(option =>
            option.setName('support-role')
                .setDescription('The role that will be pinged and given access to tickets.')
                .setRequired(false))
        .addStringOption(option => 
            option.setName('action')
                .setDescription('Select an action (e.g., view current settings).')
                .setRequired(false)
                .addChoices(
                    { name: 'view', value: 'view' },
                    { name: 'reset', value: 'reset' }
                )),
    
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        const action = interaction.options.getString('action');
        const category = interaction.options.getChannel('category');
        const logsChannel = interaction.options.getChannel('logs-channel');
        const supportRole = interaction.options.getRole('support-role');

        let config = await getGuildConfig(guild.id);
        const update = {};

        if (action === 'view') {
            return interaction.editReply({ embeds: [createConfigViewEmbed(config, guild)] });
        }

        if (action === 'reset') {
            await setGuildConfig(guild.id, { guildId: guild.id, ticketTopics: [] });
            return interaction.editReply({ 
                content: '✅ All ticketing configuration (category, logs, role, topics) has been reset to default values.',
                embeds: [createConfigViewEmbed({ guildId: guild.id, ticketTopics: [] }, guild)] 
            });
        }
        
        // --- Apply Updates ---
        if (category) {
            if (!guild.members.me.permissionsIn(category).has(REQUIRED_CATEGORY_PERMISSIONS)) {
                return interaction.editReply(`❌ Bot requires the following permissions in the **${category.name}** category: \`${REQUIRED_CATEGORY_PERMISSIONS.join(', ')}\`.`);
            }
            update.categoryId = category.id;
        }

        if (logsChannel) {
            if (!guild.members.me.permissionsIn(logsChannel).has(REQUIRED_LOGS_PERMISSIONS)) {
                 return interaction.editReply(`❌ Bot requires the following permissions in the **${logsChannel.name}** channel: \`${REQUIRED_LOGS_PERMISSIONS.join(', ')}\`.`);
            }
            update.logsChannelId = logsChannel.id;
        }

        if (supportRole) {
            update.supportRoleId = supportRole.id;
        }

        if (Object.keys(update).length > 0) {
            await updateGuildConfig(guild.id, update);
            // Re-fetch the config to show the updated state
            config = await getGuildConfig(guild.id); 
            await interaction.editReply({ 
                content: '✅ Ticketing configuration updated.', 
                embeds: [createConfigViewEmbed(config, guild)] 
            });
        } else {
             // If no options were provided, just show the view embed
            await interaction.editReply({ embeds: [createConfigViewEmbed(config, guild)] });
        }
    }
};

/**
 * Creates an embed showing the current guild configuration.
 * @param {object} config The guild configuration object.
 * @param {Guild} guild The Discord Guild object.
 * @returns {EmbedBuilder} The configuration view embed.
 */
function createConfigViewEmbed(config, guild) {
    const isReady = isConfigured(config) && config.ticketTopics.length > 0;
    const topicsList = config.ticketTopics.map((t, i) => 
        `\`${i + 1}.\` ${t.emoji || '📄'} **${t.label}** (\`${t.value}\`)`
    ).join('\n') || '*No topics configured. Use `/ticket-topic add`.*';

    const embed = new EmbedBuilder()
        .setColor(isReady ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setTitle('🎫 Ticketing System Configuration')
        .setDescription(isReady 
            ? '✅ The system is configured and ready to use!' 
            : '⚠️ Essential setup incomplete. Please set a Category, Support Role, and add at least one Topic.'
        )
        .addFields(
            { 
                name: 'Ticket Category', 
                value: config.categoryId ? `<#${config.categoryId}> (\`${config.categoryId}\`)` : '`Not Set`', 
                inline: true 
            },
            { 
                name: 'Support Role', 
                value: config.supportRoleId ? `<@&${config.supportRoleId}> (\`${config.supportRoleId}\`)` : '`Not Set`', 
                inline: true 
            },
            { 
                name: 'Logs Channel', 
                value: config.logsChannelId ? `<#${config.logsChannelId}> (\`${config.logsChannelId}\`)` : '`Not Set`', 
                inline: true 
            },
            { 
                name: `Configured Topics (${config.ticketTopics.length})`, 
                value: topicsList, 
            }
        )
        .setFooter({ text: `Guild ID: ${guild.id}` })
        .setTimestamp();
    
    return embed;
}

// --- 2. /ticket-topic (STAFF) ---
const ticketTopicCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-topic')
        .setDescription('📋 [Staff] Manage ticket topics for the panel.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addSubcommand(subcommand =>
            subcommand.setName('add')
                .setDescription('Adds a new topic to the ticket panel.')
                .addStringOption(option => option.setName('label').setDescription('Display name for the topic (e.g., General Support)').setRequired(true))
                .addStringOption(option => option.setName('value').setDescription('Unique ID/Value for the topic (e.g., general_support)').setRequired(true))
                .addStringOption(option => option.setName('description').setDescription('Short description for the topic.').setRequired(true))
                .addStringOption(option => option.setName('emoji').setDescription('Optional: Emoji for the topic (character or custom ID).')))
        .addSubcommand(subcommand =>
            subcommand.setName('remove')
                .setDescription('Removes a topic using its unique value.')
                .addStringOption(option => option.setName('value').setDescription('The unique ID/Value of the topic to remove.').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('list')
                .setDescription('Lists all currently configured topics.')),
    
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;
        let config = await getGuildConfig(guildId);
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'list') {
            return interaction.editReply({ embeds: [createConfigViewEmbed(config, interaction.guild)] });
        }

        if (subcommand === 'add') {
            const label = interaction.options.getString('label');
            const value = interaction.options.getString('value').toLowerCase().replace(/[^a-z0-9_]+/g, ''); // Sanitize value
            const description = interaction.options.getString('description');
            const emoji = interaction.options.getString('emoji');

            if (config.ticketTopics.some(t => t.value === value)) {
                return interaction.editReply(`❌ A topic with the unique value \`${value}\` already exists.`);
            }

            const newTopic = { label, value, description, emoji };
            config.ticketTopics.push(newTopic);

            await setGuildConfig(guildId, config);
            return interaction.editReply(`✅ Topic **${label}** (\`${value}\`) has been added to the configuration.`);
        }

        if (subcommand === 'remove') {
            const valueToRemove = interaction.options.getString('value');
            const initialLength = config.ticketTopics.length;
            
            config.ticketTopics = config.ticketTopics.filter(t => t.value !== valueToRemove);
            
            if (config.ticketTopics.length === initialLength) {
                return interaction.editReply(`❌ Topic with value \`${valueToRemove}\` not found.`);
            }

            await setGuildConfig(guildId, config);
            return interaction.editReply(`✅ Topic with value \`${valueToRemove}\` has been removed.`);
        }
    }
};

// --- 3. /ticket-panel (STAFF) ---
const ticketPanelCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-panel')
        .setDescription('🖼️ [Staff] Send the ticket creation panel to the current channel.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addStringOption(option => 
            option.setName('style')
                .setDescription('Select the style for the panel.')
                .setRequired(true)
                .addChoices(
                    { name: 'Buttons (up to 5 topics)', value: 'buttons' },
                    { name: 'Select Menu (for 5+ topics)', value: 'select' }
                ))
        .addStringOption(option => 
            option.setName('title')
                .setDescription('Optional: Title for the embed.')
                .setRequired(false))
        .addStringOption(option => 
            option.setName('description')
                .setDescription('Optional: Description for the embed.')
                .setRequired(false)),
    
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const config = await getGuildConfig(interaction.guild.id);
        const style = interaction.options.getString('style');
        const title = interaction.options.getString('title') || 'Need Assistance? Open a Ticket!';
        const description = interaction.options.getString('description') || 'Select a topic below to open a private support ticket. Please be detailed in your request.';

        if (!isConfigured(config)) {
            return interaction.editReply('❌ The ticketing system is not fully configured. Please set the Category and Support Role using `/ticket-config` first.');
        }

        if (config.ticketTopics.length === 0) {
            return interaction.editReply('❌ No ticket topics have been configured. Please add topics using `/ticket-topic add` first.');
        }

        const panelEmbed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle(title)
            .setDescription(description)
            .setTimestamp();
        
        let components = [];

        if (style === 'buttons') {
            if (config.ticketTopics.length > 5) {
                return interaction.editReply('❌ You selected the **Button** style, but you have more than 5 topics. Please use the **Select Menu** style or remove some topics.');
            }
            // Create a button for each topic
            const row = new ActionRowBuilder();
            config.ticketTopics.forEach(topic => {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`ticket_open_${topic.value}`)
                        .setLabel(topic.label)
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji(topic.emoji || '🎫')
                );
            });
            components.push(row);

        } else if (style === 'select') {
            // Create a select menu with all topics
            const options = config.ticketTopics.map(topic => ({
                label: topic.label,
                description: topic.description,
                value: topic.value,
                emoji: topic.emoji,
            }));

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('ticket_panel_topic_select')
                .setPlaceholder('Select a ticket topic...')
                .addOptions(options);

            components.push(new ActionRowBuilder().addComponents(selectMenu));
        }

        // Send the panel
        await interaction.channel.send({
            embeds: [panelEmbed],
            components: components
        });

        // Confirm to the staff member
        await interaction.editReply({ content: '✅ Ticket panel sent successfully to this channel.' });
    }
};

// --- 4. /ticket-rename (STAFF) ---
const ticketRenameCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-rename')
        .setDescription('✏️ [Staff] Renames the current ticket channel.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addStringOption(option => 
            option.setName('new-name')
                .setDescription('The new name for the ticket channel (e.g., urgent-issue-user).')
                .setRequired(true)),
    async execute(interaction) {
        // Import handler function from index.js at runtime
        const { handleRenameTicket } = require('./index.js'); 
        const newName = interaction.options.getString('new-name');
        await handleRenameTicket(interaction, newName);
    }
};

// --- 5. /ticket-add (STAFF) ---
const ticketAddCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-add')
        .setDescription('➕ [Staff] Adds a user to the current ticket channel.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addUserOption(option => 
            option.setName('user')
                .setDescription('The user to add to the ticket.')
                .setRequired(true)),
    async execute(interaction) {
        // Import handler function from index.js at runtime
        const { handleUserManagement } = require('./index.js');
        const user = interaction.options.getUser('user');
        await handleUserManagement(interaction, user, true); // true for add
    }
};

// --- 6. /ticket-remove (STAFF) ---
const ticketRemoveCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-remove')
        .setDescription('➖ [Staff] Removes a user from the current ticket channel.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addUserOption(option => 
            option.setName('user')
                .setDescription('The user to remove from the ticket.')
                .setRequired(true)),
    async execute(interaction) {
        // Import handler function from index.js at runtime
        const { handleUserManagement } = require('./index.js');
        const user = interaction.options.getUser('user');
        await handleUserManagement(interaction, user, false); // false for remove
    }
};

// --- 7. /ticket-close (STAFF) ---
const ticketCloseCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-close')
        .setDescription('🔒 [Staff] Closes and archives the current ticket channel.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addBooleanOption(option => 
            option.setName('silent')
                .setDescription('Whether to close the ticket without a final message in the channel.')
                .setRequired(false)),
    async execute(interaction) {
        // Import handler function from index.js at runtime
        const { handleCloseTicket } = require('./index.js');
        const silent = interaction.options.getBoolean('silent') || false;
        await handleCloseTicket(interaction, silent);
    }
};

// --- 8. /ticket-claim (STAFF) ---
const ticketClaimCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-claim')
        .setDescription('🙋‍♂️ [Staff] Claims the ticket, assigning it to yourself.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addBooleanOption(option => 
            option.setName('force')
                .setDescription('Forcefully claim the ticket even if already claimed by someone else.')
                .setRequired(false)),
    async execute(interaction) {
        // Import handler function from index.js at runtime
        const { handleClaimTicket } = require('./index.js'); 
        const forceClaim = interaction.options.getBoolean('force') || false;
        await handleClaimTicket(interaction, forceClaim);
    }
};

// --- 9. /ticket-lock (STAFF) ---
const ticketLockCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-lock')
        .setDescription('🔒 [Staff] Locks the ticket, preventing the user from sending messages.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
    async execute(interaction) {
        // Import handler function from index.js at runtime
        const { handleLockTicket } = require('./index.js');
        await handleLockTicket(interaction, true); 
    }
};

// --- 10. /ticket-unlock (STAFF) ---
const ticketUnlockCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-unlock')
        .setDescription('🔓 [Staff] Unlocks the ticket, allowing the user to send messages again.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
    async execute(interaction) {
        // Import handler function from index.js at runtime
        const { handleLockTicket } = require('./index.js');
        await handleLockTicket(interaction, false); 
    }
};


// --- EXPORTS ---
module.exports = [
    ticketConfigCommand,
    ticketTopicCommand,
    ticketPanelCommand,
    ticketRenameCommand,
    ticketAddCommand,
    ticketRemoveCommand,
    ticketCloseCommand,
    ticketClaimCommand,
    ticketLockCommand,
    ticketUnlockCommand,
];