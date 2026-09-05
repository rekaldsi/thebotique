#!/usr/bin/env node
/**
 * Cleanup script for launch:
 * 1. Remove demo agents (DataDive, PixelForge)
 * 2. Update MrMagoochi as Founding Agent
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function cleanup() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    console.log('🧹 Starting cleanup for launch...\n');
    
    // 1. Remove demo agents by fake wallet addresses
    const demoWallets = [
      '0xda7a01ve000000000000000000000000000d1ve',  // DataDive
      '0xp1xel000000000000000000000000000f0rge'     // PixelForge
    ];
    
    for (const wallet of demoWallets) {
      // Get user ID and agent ID in one query
      const result = await client.query(`
        SELECT u.id as user_id, a.id as agent_id, u.name
        FROM users u 
        LEFT JOIN agents a ON a.user_id = u.id 
        WHERE u.wallet_address = $1
      `, [wallet]);
      
      if (result.rows.length > 0) {
        const { user_id, agent_id, name } = result.rows[0];
        
        if (agent_id) {
          // Delete skills first (foreign key constraint)
          await client.query('DELETE FROM skills WHERE agent_id = $1', [agent_id]);
          // Delete agent
          await client.query('DELETE FROM agents WHERE id = $1', [agent_id]);
        }
        
        // Delete user
        await client.query('DELETE FROM users WHERE id = $1', [user_id]);
        console.log(`  ✓ Removed ${name} (${wallet.slice(0, 10)}...)`);
      }
    }
    
    console.log('\n✅ Demo agents removed\n');
    
    // 2. Update MrMagoochi as Founding Agent
    console.log('👑 Updating MrMagoochi as Founding Agent...\n');
    
    // Update user profile
    await client.query(`
      UPDATE users SET
        bio = 'Founding Agent of TheBotique. Creative strategist, researcher, and AI specialist. From brainstorms to code reviews — 40+ services across creative, research, technical, and visual domains.',
        avatar_url = 'https://api.dicebear.com/7.x/bottts/svg?seed=MrMagoochi&backgroundColor=0f172a'
      WHERE wallet_address = '0xa193128362e6de28e6d51eebc98505672ffeb3c5'
    `);
    console.log('  ✓ Updated bio and avatar');
    
    // Update agent record  
    await client.query(`
      UPDATE agents SET
        trust_tier = 'verified',
        trust_score = 100,
        is_founder = true,
        tagline = 'AI-Powered Services'
      WHERE user_id = (
        SELECT id FROM users WHERE wallet_address = '0xa193128362e6de28e6d51eebc98505672ffeb3c5'
      )
    `);
    console.log('  ✓ Set as Founding Agent (verified tier, is_founder=true)');
    
    await client.query('COMMIT');
    console.log('\n🚀 Cleanup complete! MrMagoochi is now the Founding Agent.\n');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error during cleanup:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

cleanup().catch(err => {
  console.error(err);
  process.exit(1);
});
