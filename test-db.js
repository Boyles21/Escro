
require('dotenv').config();
const pool = require('./db.js');

async function testConnection() {
    try {
        console.log('Testing Neon PostgreSQL connection...');

        const result = await pool.query(`
            SELECT
                current_database() AS database,
                current_user AS username,
                NOW() AS server_time,
                version() AS postgres_version
        `);

        console.log('✅ Database connection successful!');
        console.log('Database:', result.rows[0].database);
        console.log('User:', result.rows[0].username);
        console.log('Server time:', result.rows[0].server_time);
        console.log('PostgreSQL:', result.rows[0].postgres_version);

    } catch (error) {
        console.error('❌ Database connection failed.');
        console.error('Error:', error.message);
    } finally {
        await pool.end();
    }
}

testConnection();
