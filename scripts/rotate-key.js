#!/usr/bin/env node
/**
 * Rotate agent API key
 * Usage: DATABASE_URL=... node scripts/rotate-key.js <agent_id>
 */

const { Pool } = require('pg');
const crypto = require('crypto');

const agentId = process.argv[2] || 1;
const newKey = 'hub_' + crypto.randomBytes(24).toString('hex');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function rotateKey() {
  try {
    const result = await pool.query(
      'UPDATE agents SET api_key = $1 WHERE id = $2 RETURNING id',
      [newKey, agentId]
    );
    
    if (result.rows.length === 0) {
      console.error('❌ Agent not found');
      process.exit(1);
    }
    
    console.log('✅ API key rotated for agent', agentId);
    console.log('🔑 New key:', newKey);
    console.log('\n⚠️  Save this key - it cannot be retrieved later!');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

rotateKey();
