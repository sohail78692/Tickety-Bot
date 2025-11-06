// commands.js

const { 
    SlashCommandBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    EmbedBuilder, 
    PermissionsBitField, 
    ChannelType,
    MessageFlags,
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle,
    StringSelectMenuBuilder
} = require('discord.js');
const fs = require('fs/promises');

const CONFIG_FILE = 'config.json';

// --- Utility Function to Read/Write Config ---
async function readConfig() {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error("Error reading config.json:", error);
        return {}; // Return empty object on error
    }
}

async function writeConfig(config) {
    try {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (error) {
        console.error("Error writing to config.json:", error);
    }
}

// --- Permissions Definitions ---
const REQUIRED_LOGS_PERMISSIONS = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.AttachFiles
];
const REQUIRED_CATEGORY_PERMISSIONS = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.ManageChannels,
    PermissionsBitField.Flags.ManageRoles // For setting channel permissions
];

// --- 1. /ticket-config (ADMIN) ---
const ticketConfigCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-config')
        .setDescription('⚙️ [Admin] Sets the core configuration for the ticket system.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addChannelOption(option =>
            option.setName('category')
                .setDescription('The category where new tickets will be created.')
                .addChannelTypes(ChannelType.GuildCategory)
                .setRequired(true))
        .addRoleOption(option =>
            option.setName('support_role')
                .setDescription('The role that will have access to all tickets.')
                .setRequired(true))
        .addChannelOption(option =>
            option.setName('logs_channel')
                .setDescription('The text channel where ticket transcripts and logs will be sent.')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)),

    async execute(interaction) {
        const categoryChannel = interaction.options.getChannel('category');
        const supportRole = interaction.options.getRole('support_role');
        const logsChannel = interaction.options.getChannel('logs_channel');
        const botMember = interaction.guild.members.me;

        // --- 1. Permission Check: Logs Channel ---
        const logPerms = logsChannel.permissionsFor(botMember);
        const missingLogPerms = REQUIRED_LOGS_PERMISSIONS.filter(perm => !logPerms.has(perm));

        if (missingLogPerms.length > 0) {
            return interaction.reply({
                content: `❌ **Permissions Error!**\nI'm missing the following permissions in the **Logs Channel** (${logsChannel}):\n\`${missingLogPerms.join('`, `')}\`\nPlease grant these permissions and try again.`,
                flags: MessageFlags.Ephemeral
            });
        }
        
        // --- 2. Permission Check: Ticket Category ---
        const categoryPerms = categoryChannel.permissionsFor(botMember);
        const missingCategoryPerms = REQUIRED_CATEGORY_PERMISSIONS.filter(perm => !categoryPerms.has(perm));
        
        if (missingCategoryPerms.length > 0) {
            return interaction.reply({
                content: `❌ **Permissions Error!**\nI'm missing the following permissions in the **Ticket Category** (${categoryChannel}):\n\`${missingCategoryPerms.join('`, `')}\`\nPlease grant these permissions and try again.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // --- 3. Save Configuration ---
        try {
            const config = await readConfig();
            
            // Initialize guild config if it doesn't exist
            if (!config[interaction.guildId]) {
                config[interaction.guildId] = { ticketTopics: [] };
            }
            
            config[interaction.guildId].categoryId = categoryChannel.id;
            config[interaction.guildId].logsChannelId = logsChannel.id;
            config[interaction.guildId].supportRoleId = supportRole.id;
            
            await writeConfig(config);

            const responseEmbed = new EmbedBuilder()
                .setTitle('✅ System Configured Successfully')
                .setDescription('The **Tickety Bot** is now ready! Here\'s your setup:')
                .addFields(
                    { name: '📁 Ticket Category', value: `${categoryChannel}`, inline: true },
                    { name: '🛡️ Support Role', value: `${supportRole}`, inline: true },
                    { name: '📜 Logs Channel', value: `${logsChannel}`, inline: true }
                )
                .setColor(0x57F287) // Green
                .setFooter({ text: 'Next steps: Use /ticket-topic to add topics, then /ticket-panel to post.' });

            await interaction.reply({ embeds: [responseEmbed], flags: MessageFlags.Ephemeral });

        } catch (error) {
            console.error('Error saving configuration:', error);
            await interaction.reply({ content: '❌ An unexpected error occurred while saving the configuration.', flags: MessageFlags.Ephemeral });
        }
    },
};

// --- 2. /ticket-topic (ADMIN) ---
const ticketTopicCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-topic')
        .setDescription('⚙️ [Admin] Manages the topics for the ticket panel dropdown.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Add a new topic to the ticket panel.')
            .addStringOption(opt => opt.setName('label').setDescription('The text shown in the dropdown (e.g., "General Support").').setRequired(true).setMaxLength(100))
            .addStringOption(opt => opt.setName('value').setDescription('A unique ID (e.g., "general_support"). No spaces.').setRequired(true).setMaxLength(100))
            .addStringOption(opt => opt.setName('description').setDescription('A short description shown under the label.').setRequired(false).setMaxLength(100))
            .addStringOption(opt => opt.setName('emoji').setDescription('An optional emoji for the topic.').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Remove a topic from the ticket panel.')
            .addStringOption(opt => opt.setName('value').setDescription('The unique ID (value) of the topic to remove.').setRequired(true).setMaxLength(100))
        )
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('List all current ticket topics.')
        ),

    async execute(interaction) {
        const config = await readConfig();
        const guildConfig = config[interaction.guildId];

        if (!guildConfig || !guildConfig.categoryId) {
            return interaction.reply({ content: '❌ Please run `/ticket-config` first before managing topics.', flags: MessageFlags.Ephemeral });
        }
        
        // Ensure ticketTopics array exists
        if (!guildConfig.ticketTopics) {
            guildConfig.ticketTopics = [];
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === 'add') {
                const label = interaction.options.getString('label');
                const value = interaction.options.getString('value').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''); // Clean value
                const description = interaction.options.getString('description') || 'Click to open a ticket.';
                const emoji = interaction.options.getString('emoji') || null;

                if (!value) {
                     return interaction.reply({ content: `❌ The ID \`${interaction.options.getString('value')}\` is invalid. Please use letters, numbers, and underscores only.`, flags: MessageFlags.Ephemeral });
                }

                if (guildConfig.ticketTopics.find(t => t.value === value)) {
                    return interaction.reply({ content: `❌ A topic with the ID \`${value}\` already exists. Please choose a unique value.`, flags: MessageFlags.Ephemeral });
                }
                
                if (guildConfig.ticketTopics.length >= 25) {
                    return interaction.reply({ content: '❌ You have reached the maximum limit of 25 ticket topics.', flags: MessageFlags.Ephemeral });
                }

                guildConfig.ticketTopics.push({ label, value, description, emoji });
                await writeConfig(config);

                await interaction.reply({ content: `✅ Successfully added topic: **${label}**`, flags: MessageFlags.Ephemeral });

            } else if (subcommand === 'remove') {
                const value = interaction.options.getString('value');
                const originalLength = guildConfig.ticketTopics.length;
                guildConfig.ticketTopics = guildConfig.ticketTopics.filter(t => t.value !== value);

                if (guildConfig.ticketTopics.length === originalLength) {
                    return interaction.reply({ content: `❌ No topic with the ID \`${value}\` was found.`, flags: MessageFlags.Ephemeral });
                }

                await writeConfig(config);
                await interaction.reply({ content: `✅ Successfully removed topic with ID: \`${value}\``, flags: MessageFlags.Ephemeral });

            } else if (subcommand === 'list') {
                if (guildConfig.ticketTopics.length === 0) {
                    return interaction.reply({ content: 'ℹ️ You have no ticket topics configured. Use `/ticket-topic add` to create one.', flags: MessageFlags.Ephemeral });
                }

                const embed = new EmbedBuilder()
                    .setTitle('🎫 Current Ticket Topics')
                    .setColor(0x5865F2)
                    .setDescription(guildConfig.ticketTopics.map((t, i) => {
                        return `**${i + 1}. ${t.label}** ${t.emoji || ''}\n   - **ID:** \`${t.value}\`\n   - **Desc:** *${t.description}*`;
                    }).join('\n\n'));
                
                await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }
        } catch (error) {
            console.error('Error in /ticket-topic:', error);
            await interaction.reply({ content: '❌ An error occurred while managing topics.', flags: MessageFlags.Ephemeral });
        }
    },
};

// --- 3. /ticket-panel (ADMIN) ---
const ticketPanelCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-panel')
        .setDescription('⚙️ [Admin] Posts the main ticket creation panel with a dropdown menu.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addStringOption(option =>
            option.setName('title')
                .setDescription('The main title for the panel embed (e.g., "Support Center").')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('description')
                .setDescription('The text to display above the dropdown menu.')
                .setRequired(true)),

    async execute(interaction) {
        const config = await readConfig();
        const guildConfig = config[interaction.guildId];
        const title = interaction.options.getString('title');
        const description = interaction.options.getString('description');

        if (!guildConfig || !guildConfig.categoryId) {
            return interaction.reply({ content: '❌ Please run `/ticket-config` first.', flags: MessageFlags.Ephemeral });
        }

        if (!guildConfig.ticketTopics || guildConfig.ticketTopics.length === 0) {
            return interaction.reply({ content: '❌ You must add at least one topic with `/ticket-topic add` before posting a panel.', flags: MessageFlags.Ephemeral });
        }

        // --- 1. Build Embed ---
        const panelEmbed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(0x5865F2) // Discord Blurple
            .setFooter({ text: 'Please select a topic to open a ticket.' });

        // --- 2. Build Select Menu ---
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('ticket_panel_menu')
            .setPlaceholder('Click to select a support topic...')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(guildConfig.ticketTopics.map(topic => ({
                label: topic.label,
                description: topic.description,
                value: topic.value,
                emoji: topic.emoji || undefined
            })));
        
        const row = new ActionRowBuilder().addComponents(selectMenu);

        // --- 3. Send Panel with Error Handling (FIX for 50013) ---
        try {
            await interaction.channel.send({
                embeds: [panelEmbed],
                components: [row]
            });
            await interaction.reply({ content: '✅ Ticket panel posted successfully!', flags: MessageFlags.Ephemeral });
        
        } catch (error) {
            console.error('Error sending ticket panel:', error);
            // Check for the specific Missing Permissions error (50013)
            if (error.code === 50013) {
                return interaction.reply({
                    content: `❌ **Permissions Error!**\nI failed to post the panel in ${interaction.channel}.\nPlease ensure I have \`View Channel\` and \`Send Messages\` permissions there.`,
                    flags: MessageFlags.Ephemeral
                });
            }
            // Generic fallback
            await interaction.reply({ content: '❌ An unexpected error occurred while posting the panel.', flags: MessageFlags.Ephemeral });
        }
    },
};

// --- 4. /ticket-rename (STAFF) ---
const ticketRenameCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-rename')
        .setDescription('✍️ [Staff] Renames the current ticket channel.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels) // Base perm check
        .addStringOption(option =>
            option.setName('new_name')
                .setDescription('The new name for the ticket channel (e.g., bug-report-user).')
                .setRequired(true)
                .setMinLength(3)
                .setMaxLength(100)),
                
    async execute(interaction) {
        // Validation (isSupportUser, isTicketChannel) is handled in index.js
        const newName = interaction.options.getString('new_name');
        
        try {
            const oldName = interaction.channel.name;
            await interaction.channel.setName(newName);

            const renameEmbed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setDescription(`✍️ Channel renamed from \`#${oldName}\` to \`#${newName}\` by ${interaction.user}.`);
            
            await interaction.channel.send({ embeds: [renameEmbed] });
            await interaction.reply({ content: '✅ Channel renamed.', flags: MessageFlags.Ephemeral });

        } catch (error) {
            console.error('Error renaming channel:', error);
            await interaction.reply({ 
                content: '❌ **Rename Failed.** Ensure the name is valid (no spaces, special chars) and I have `Manage Channels` permission.', 
                flags: MessageFlags.Ephemeral 
            });
        }
    },
};

// --- 5. /ticket-add (STAFF) ---
const ticketAddCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-add')
        .setDescription('👤 [Staff] Adds a user to the current ticket channel.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to add to the ticket.')
                .setRequired(true)),

    async execute(interaction) {
        const userToAdd = interaction.options.getUser('user');
        
        try {
            await interaction.channel.permissionOverwrites.edit(userToAdd.id, {
                ViewChannel: true,
                SendMessages: true
            });

            const addEmbed = new EmbedBuilder()
                .setColor(0x57F287) // Green
                .setDescription(`👤 ${userToAdd} has been **added** to this ticket by ${interaction.user}.`);

            await interaction.channel.send({ embeds: [addEmbed] });
            await interaction.reply({ content: `✅ Added ${userToAdd.tag} to the ticket.`, flags: MessageFlags.Ephemeral });

        } catch (error) {
            console.error('Error adding user:', error);
            await interaction.reply({ 
                content: '❌ **Add Failed.** Ensure I have `Manage Roles` permission in this category.', 
                flags: MessageFlags.Ephemeral 
            });
        }
    },
};

// --- 6. /ticket-remove (STAFF) ---
const ticketRemoveCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-remove')
        .setDescription('✖️ [Staff] Removes a user from the current ticket channel.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to remove from the ticket.')
                .setRequired(true)),

    async execute(interaction) {
        const userToRemove = interaction.options.getUser('user');

        try {
            await interaction.channel.permissionOverwrites.delete(userToRemove.id);

            const removeEmbed = new EmbedBuilder()
                .setColor(0xED4245) // Red
                .setDescription(`✖️ ${userToRemove} has been **removed** from this ticket by ${interaction.user}.`);
            
            await interaction.channel.send({ embeds: [removeEmbed] });
            await interaction.reply({ content: `✅ Removed ${userToRemove.tag} from the ticket.`, flags: MessageFlags.Ephemeral });

        } catch (error) {
            console.error('Error removing user:', error);
            await interaction.reply({ 
                content: '❌ **Remove Failed.** Ensure I have `Manage Roles` permission in this category.', 
                flags: MessageFlags.Ephemeral 
            });
        }
    },
};

// --- 7. /ticket-claim (STAFF) ---
const ticketClaimCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-claim')
        .setDescription('🙋 [Staff] Claims the current ticket, assigning it to yourself.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
    async execute(interaction) {
        // This command just triggers the button logic, which is handled in index.js
        // The validation (isSupport, isTicket) is already done by the command handler in index.js
        
        // We call the handler function directly from index.js
        const { handleClaimTicket } = require('./index.js'); // Import from index
        await handleClaimTicket(interaction, true); // `true` to force claim
    }
};

// --- 8. /ticket-lock (STAFF) ---
const ticketLockCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-lock')
        .setDescription('🔒 [Staff] Locks the ticket, preventing the user from sending messages.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
    async execute(interaction) {
        const { handleLockTicket } = require('./index.js');
        await handleLockTicket(interaction, true); // `true` to lock
    }
};

// --- 9. /ticket-unlock (STAFF) ---
const ticketUnlockCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-unlock')
        .setDescription('🔓 [Staff] Unlocks the ticket, allowing the user to send messages again.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
    async execute(interaction) {
        const { handleLockTicket } = require('./index.js');
        await handleLockTicket(interaction, false); // `false` to unlock
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
    ticketClaimCommand,
    ticketLockCommand,
    ticketUnlockCommand
];