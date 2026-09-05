#!/usr/bin/env node
/**
 * Backfill Embeddings Script
 * 
 * Computes and stores vector embeddings for all agents that don't have them yet.
 * Uses OpenAI's text-embedding-3-small model.
 * 
 * Usage:
 *   node scripts/backfill-embeddings.js [options]
 * 
 * Options:
 *   --batch-size=N    Process N agents at a time (default: 10)
 *   --delay=MS        Wait MS milliseconds between batches (default: 1000)
 *   --dry-run         Show what would be done without making changes
 *   --agent-id=ID     Process only a specific agent ID
 * 
 * Environment:
 *   DATABASE_URL      PostgreSQL connection string (required)
 *   OPENAI_API_KEY    OpenAI API key (required)
 */

require('dotenv').config();

const embeddings = require('../src/embeddings');
const db = require('../src/db');
const logger = require('../src/logger');

// Parse command line arguments
function parseArgs() {
  const args = {
    batchSize: 10,
    delayMs: 1000,
    dryRun: false,
    agentId: null
  };
  
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--batch-size=')) {
      args.batchSize = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--delay=')) {
      args.delayMs = parseInt(arg.split('=')[1]);
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--agent-id=')) {
      args.agentId = parseInt(arg.split('=')[1]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Backfill Embeddings Script

Computes and stores vector embeddings for all agents that don't have them yet.

Usage:
  node scripts/backfill-embeddings.js [options]

Options:
  --batch-size=N    Process N agents at a time (default: 10)
  --delay=MS        Wait MS between batches to respect rate limits (default: 1000)
  --dry-run         Show what would be done without making changes
  --agent-id=ID     Process only a specific agent ID
  --help, -h        Show this help message

Environment Variables:
  DATABASE_URL      PostgreSQL connection string (required)
  OPENAI_API_KEY    OpenAI API key (required)

Examples:
  # Backfill all agents with default settings
  node scripts/backfill-embeddings.js

  # Process a specific agent
  node scripts/backfill-embeddings.js --agent-id=42

  # Dry run to see what would be processed
  node scripts/backfill-embeddings.js --dry-run

  # Slow batch processing for rate limit safety
  node scripts/backfill-embeddings.js --batch-size=5 --delay=2000
      `);
      process.exit(0);
    }
  }
  
  return args;
}

async function main() {
  const args = parseArgs();
  
  console.log('='.repeat(60));
  console.log('TheBotique Embedding Backfill');
  console.log('='.repeat(60));
  console.log('');
  
  // Check prerequisites
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ ERROR: OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }
  
  if (!process.env.DATABASE_URL) {
    console.error('❌ ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }
  
  // Initialize database
  console.log('📊 Initializing database connection...');
  await db.initDB();
  
  // Get current stats
  const stats = await embeddings.getEmbeddingStats();
  console.log('');
  console.log('Current Status:');
  console.log(`  Total agents: ${stats.totalAgents}`);
  console.log(`  With embeddings: ${stats.withEmbeddings}`);
  console.log(`  Without embeddings: ${stats.withoutEmbeddings}`);
  console.log(`  Coverage: ${stats.coverage}%`);
  console.log(`  Model: ${stats.model}`);
  console.log('');
  
  if (args.dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made');
    console.log('');
  }
  
  // Single agent mode
  if (args.agentId) {
    console.log(`Processing single agent: ${args.agentId}`);
    
    if (args.dryRun) {
      const result = await db.query(`
        SELECT a.id, u.name, a.description_embedding IS NOT NULL as has_embedding
        FROM agents a
        JOIN users u ON a.user_id = u.id
        WHERE a.id = $1
      `, [args.agentId]);
      
      if (result.rows.length === 0) {
        console.log(`❌ Agent ${args.agentId} not found`);
      } else {
        const agent = result.rows[0];
        console.log(`  Agent: ${agent.name}`);
        console.log(`  Has embedding: ${agent.has_embedding ? 'Yes' : 'No'}`);
        if (!agent.has_embedding) {
          console.log('  → Would compute embedding');
        }
      }
    } else {
      const success = await embeddings.computeAgentEmbedding(args.agentId);
      if (success) {
        await db.query('UPDATE agents SET embedding_updated_at = NOW() WHERE id = $1', [args.agentId]);
        console.log(`✅ Embedding computed for agent ${args.agentId}`);
      } else {
        console.log(`❌ Failed to compute embedding for agent ${args.agentId}`);
      }
    }
    
    await db.closePool();
    return;
  }
  
  // Full backfill
  console.log(`Backfill Settings:`);
  console.log(`  Batch size: ${args.batchSize}`);
  console.log(`  Delay between batches: ${args.delayMs}ms`);
  console.log('');
  
  if (stats.withoutEmbeddings === 0) {
    console.log('✅ All agents already have embeddings!');
    await db.closePool();
    return;
  }
  
  if (args.dryRun) {
    // Just list agents without embeddings
    const result = await db.query(`
      SELECT a.id, u.name
      FROM agents a
      JOIN users u ON a.user_id = u.id
      WHERE a.is_active = true AND a.description_embedding IS NULL
      ORDER BY a.id
      LIMIT 50
    `);
    
    console.log(`Agents that would be processed (showing first 50):`);
    for (const agent of result.rows) {
      console.log(`  - Agent ${agent.id}: ${agent.name}`);
    }
    
    if (stats.withoutEmbeddings > 50) {
      console.log(`  ... and ${stats.withoutEmbeddings - 50} more`);
    }
  } else {
    // Run backfill
    console.log('Starting backfill...');
    console.log('');
    
    const startTime = Date.now();
    const result = await embeddings.backfillEmbeddings({
      batchSize: args.batchSize,
      delayMs: args.delayMs
    });
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('');
    console.log('='.repeat(60));
    console.log('Backfill Complete');
    console.log('='.repeat(60));
    console.log(`  Duration: ${duration}s`);
    console.log(`  Total: ${result.total}`);
    console.log(`  Processed: ${result.processed}`);
    console.log(`  Failed: ${result.failed}`);
    
    // Show updated stats
    const newStats = await embeddings.getEmbeddingStats();
    console.log('');
    console.log('Updated Status:');
    console.log(`  Coverage: ${newStats.coverage}%`);
  }
  
  await db.closePool();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
