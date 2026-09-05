// Agent-to-Agent Relay via PostgreSQL
// Allows DigiJerry and Baal to communicate through shared DB

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

// Initialize the agent_messages table
async function initAgentRelay() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id SERIAL PRIMARY KEY,
      from_agent VARCHAR(100) NOT NULL,
      to_agent VARCHAR(100),
      message TEXT NOT NULL,
      metadata JSONB DEFAULT '{}',
      read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_agent, read, created_at);
  `);
  console.log('✓ Agent relay table initialized');
}

// Send a message to another agent (or broadcast if to_agent is null)
async function sendAgentMessage(fromAgent, toAgent, message, metadata = {}) {
  const result = await pool.query(
    `INSERT INTO agent_messages (from_agent, to_agent, message, metadata) 
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [fromAgent, toAgent, message, JSON.stringify(metadata)]
  );
  return result.rows[0];
}

// Get unread messages for an agent
async function getUnreadMessages(agentName, markAsRead = true) {
  const result = await pool.query(
    `SELECT * FROM agent_messages 
     WHERE (to_agent = $1 OR to_agent IS NULL) AND read = FALSE 
     ORDER BY created_at ASC`,
    [agentName]
  );
  
  if (markAsRead && result.rows.length > 0) {
    const ids = result.rows.map(r => r.id);
    await pool.query(
      `UPDATE agent_messages SET read = TRUE WHERE id = ANY($1)`,
      [ids]
    );
  }
  
  return result.rows;
}

// Get recent messages (for context/history)
async function getRecentMessages(limit = 50) {
  const result = await pool.query(
    `SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows.reverse();
}

module.exports = {
  initAgentRelay,
  sendAgentMessage,
  getUnreadMessages,
  getRecentMessages,
  pool
};
