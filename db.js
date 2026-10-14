const { Pool } = require('pg');
require('dotenv').config();

// Create a flexible connection configuration
let connectionConfig = {};

if (process.env.DATABASE_URL) {
    // Production Path: If running on Render, use the Neon Cloud Connection String directly
    connectionConfig = {
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false // Required by Neon to handle secure cloud queries safely
        }
    };
} else {
    // Local Path: If running on your home PC, use your local .env pgAdmin parameters
    connectionConfig = {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
    };
}

const pool = new Pool(connectionConfig);

module.exports = pool;
