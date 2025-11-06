// db_config.js
// Contains all Mongoose connection logic, models, and utility functions
// to resolve the circular dependency between index.js and commands.js

const mongoose = require('mongoose'); // Import Mongoose

// --- MONGODB CONNECTION AND MODEL ---

// Define the Schema for Ticket Topics (Sub-document Schema)
const TicketTopicSchema = new mongoose.Schema({
    label: { type: String, required: true },
    value: { type: String, required: true },
    description: { type: String, required: true },
    emoji: { type: String, default: null }, // Can be an emoji character or a custom Discord emoji string
}, { _id: false });

// Define the main Guild Configuration Schema
const GuildConfigSchema = new mongoose.Schema({
    // Discord Guild ID (unique identifier for each server)
    guildId: { type: String, required: true, unique: true },
    
    // Config fields (Channel and Role IDs)
    categoryId: { type: String, default: null },
    logsChannelId: { type: String, default: null },
    supportRoleId: { type: String, default: null },
    
    // Array of available ticket topics
    ticketTopics: { type: [TicketTopicSchema], default: [] },
});

// Create the Mongoose Model
const GuildConfig = mongoose.model('GuildConfig', GuildConfigSchema);

/**
 * Connects to the MongoDB database using the URI from the environment variables.
 */
async function connectDB() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error("❌ MONGODB_URI is not set in the .env file. Bot cannot start without configuration persistence.");
        process.exit(1);
    }
    
    try {
        // Set Mongoose options to avoid deprecation warnings
        await mongoose.connect(uri);
        console.log('✅ Connected to MongoDB!');
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error);
        // Exit process if DB connection fails
        process.exit(1); 
    }
}

// --- DATABASE UTILITY FUNCTIONS ---

/**
 * Retrieves the configuration for a specific guild, or creates a default entry if it doesn't exist.
 * @param {string} guildId The ID of the guild.
 * @returns {Promise<object>} The guild's configuration object (Mongoose document as plain object).
 */
async function getGuildConfig(guildId) {
    try {
        // Find the config, or create a new one with defaults if not found
        let config = await GuildConfig.findOneAndUpdate(
            { guildId: guildId },
            { $setOnInsert: { guildId: guildId } }, // Only set guildId on insert
            { 
                upsert: true, // Create if not found
                new: true,    // Return the updated/new document
                lean: true    // Return a plain JavaScript object instead of a Mongoose document
            } 
        );
        
        // Ensure ticketTopics array is present for consistency
        if (!config.ticketTopics) {
            config.ticketTopics = [];
        }
        
        return config;
    } catch (error) {
        console.error(`Error retrieving config for guild ${guildId}:`, error);
        // Return a safe, unconfigured default on error
        return { guildId, ticketTopics: [], categoryId: null, logsChannelId: null, supportRoleId: null }; 
    }
}

/**
 * Saves or updates a guild's configuration by completely replacing the non-ID fields.
 * This is primarily used by the /ticket-config topic and save features.
 * @param {string} guildId The ID of the guild.
 * @param {object} newConfig The entire new configuration object to save.
 */
async function setGuildConfig(guildId, newConfig) {
    try {
        await GuildConfig.updateOne(
            { guildId: guildId },
            { 
                $set: { 
                    categoryId: newConfig.categoryId || null,
                    logsChannelId: newConfig.logsChannelId || null,
                    supportRoleId: newConfig.supportRoleId || null,
                    ticketTopics: newConfig.ticketTopics || [],
                }
            },
            { upsert: true }
        );
        console.log(`Config for guild ${guildId} saved successfully.`);
    } catch (error) {
        console.error(`Error setting config for guild ${guildId}:`, error);
    }
}

/**
 * Updates specific fields in a guild's configuration.
 * @param {string} guildId The ID of the guild.
 * @param {object} updateObject An object containing fields to update (e.g., { categoryId: '123' }).
 */
async function updateGuildConfig(guildId, updateObject) {
    try {
        await GuildConfig.updateOne(
            { guildId: guildId },
            { $set: updateObject },
            { upsert: true }
        );
    } catch (error) {
        console.error(`Error updating config for guild ${guildId}:`, error);
    }
}

module.exports = {
    connectDB,
    getGuildConfig,
    setGuildConfig,
    updateGuildConfig
};