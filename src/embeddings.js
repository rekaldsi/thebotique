/**
 * Vector Embeddings Service for Semantic Search
 * 
 * Uses OpenAI's text-embedding-3-small model for generating embeddings.
 * Falls back to basic text matching if OpenAI API key is not available.
 * 
 * Inspired by Claude Flow's HNSW approach but simplified for MVP.
 */

const { OpenAI } = require('openai');
const logger = require('./logger');
const db = require('./db');

// Initialize OpenAI client if API key is available
let openai = null;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

function initOpenAI() {
  if (openai) return openai;
  
  if (!process.env.OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY not set - semantic search will fall back to text matching');
    return null;
  }
  
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  
  logger.info('OpenAI embeddings service initialized');
  return openai;
}

/**
 * Check if embeddings are available
 */
function isEmbeddingsAvailable() {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Generate embedding for a text string
 * @param {string} text - Text to embed
 * @returns {Promise<number[]|null>} - Embedding vector or null if unavailable
 */
async function embedText(text) {
  const client = initOpenAI();
  if (!client) return null;
  
  try {
    // Truncate text to avoid token limits (8191 tokens max for text-embedding-3-small)
    const truncatedText = text.slice(0, 8000);
    
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: truncatedText,
      dimensions: EMBEDDING_DIMENSIONS
    });
    
    return response.data[0].embedding;
  } catch (error) {
    logger.error('Failed to generate embedding', { error: error.message });
    return null;
  }
}

/**
 * Generate a combined embedding for an agent based on their profile and skills
 * @param {Object} agent - Agent object with name, bio, skills array
 * @returns {Promise<number[]|null>} - Combined embedding vector
 */
async function embedAgent(agent) {
  // Build a comprehensive text representation of the agent
  const parts = [];
  
  // Add name and bio
  if (agent.name) parts.push(`Agent: ${agent.name}`);
  if (agent.bio) parts.push(`Description: ${agent.bio}`);
  if (agent.tagline) parts.push(`Tagline: ${agent.tagline}`);
  
  // Add skills with their descriptions and categories
  if (agent.skills && Array.isArray(agent.skills)) {
    const skillTexts = agent.skills.map(skill => {
      const skillParts = [];
      if (skill.name) skillParts.push(skill.name);
      if (skill.description) skillParts.push(skill.description);
      if (skill.category) skillParts.push(`Category: ${skill.category}`);
      return skillParts.join('. ');
    });
    
    if (skillTexts.length > 0) {
      parts.push(`Skills: ${skillTexts.join('; ')}`);
    }
  }
  
  // Also add categories explicitly for better matching
  if (agent.skills && Array.isArray(agent.skills)) {
    const categories = [...new Set(agent.skills.map(s => s.category).filter(Boolean))];
    if (categories.length > 0) {
      parts.push(`Specializes in: ${categories.join(', ')}`);
    }
  }
  
  const fullText = parts.join('\n\n');
  
  if (!fullText.trim()) {
    logger.warn('Empty text for agent embedding', { agentId: agent.id });
    return null;
  }
  
  return embedText(fullText);
}

/**
 * Calculate cosine similarity between two vectors
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
 * @returns {number} - Similarity score between -1 and 1
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);
  
  if (normA === 0 || normB === 0) return 0;
  
  return dotProduct / (normA * normB);
}

/**
 * Semantic search for agents
 * @param {string} query - Natural language search query
 * @param {Object} options - Search options
 * @param {number} options.limit - Max results (default 10)
 * @param {number} options.minSimilarity - Min similarity threshold (default 0.3)
 * @param {string} options.category - Filter by category
 * @param {string} options.trustTier - Minimum trust tier
 * @returns {Promise<Object>} - Search results with similarity scores
 */
async function semanticSearch(query, options = {}) {
  const {
    limit = 10,
    minSimilarity = 0.3,
    category = null,
    trustTier = null
  } = options;
  
  // Check if embeddings are available
  if (!isEmbeddingsAvailable()) {
    logger.info('Embeddings unavailable, falling back to text search');
    return fallbackTextSearch(query, options);
  }
  
  // Generate query embedding
  const queryEmbedding = await embedText(query);
  if (!queryEmbedding) {
    logger.warn('Failed to embed query, falling back to text search');
    return fallbackTextSearch(query, options);
  }
  
  // Fetch all agents with embeddings
  let sql = `
    SELECT a.id, a.user_id, a.trust_tier, a.trust_score, a.rating, a.total_jobs,
           a.tagline, a.is_founder, a.description_embedding,
           u.wallet_address, u.name, u.avatar_url, u.bio,
           (SELECT json_agg(json_build_object(
             'id', s.id, 'name', s.name, 'description', s.description,
             'category', s.category, 'price_usdc', s.price_usdc,
             'estimated_time', s.estimated_time
           )) FROM skills s WHERE s.agent_id = a.id AND s.is_active = true) as skills
    FROM agents a
    JOIN users u ON a.user_id = u.id
    WHERE a.is_active = true
      AND a.description_embedding IS NOT NULL
  `;
  
  const params = [];
  let paramIndex = 1;
  
  // Category filter
  if (category) {
    sql += ` AND EXISTS (SELECT 1 FROM skills s WHERE s.agent_id = a.id AND LOWER(s.category) = LOWER($${paramIndex}))`;
    params.push(category);
    paramIndex++;
  }
  
  // Trust tier filter
  if (trustTier) {
    const tierOrder = ['new', 'rising', 'established', 'trusted', 'verified'];
    const minTierIndex = tierOrder.indexOf(trustTier);
    if (minTierIndex >= 0) {
      const validTiers = tierOrder.slice(minTierIndex);
      sql += ` AND COALESCE(a.trust_tier, 'new') = ANY($${paramIndex})`;
      params.push(validTiers);
      paramIndex++;
    }
  }
  
  const result = await db.query(sql, params);
  
  // Calculate similarities
  const results = result.rows
    .map(agent => {
      // Parse stored embedding (stored as JSON array)
      let agentEmbedding;
      try {
        agentEmbedding = typeof agent.description_embedding === 'string'
          ? JSON.parse(agent.description_embedding)
          : agent.description_embedding;
      } catch (e) {
        return null;
      }
      
      if (!agentEmbedding) return null;
      
      const similarity = cosineSimilarity(queryEmbedding, agentEmbedding);
      
      // Find skills that might match the query (for matchedSkills field)
      const queryLower = query.toLowerCase();
      const matchedSkills = (agent.skills || []).filter(skill => {
        const nameMatch = skill.name && skill.name.toLowerCase().includes(queryLower);
        const descMatch = skill.description && skill.description.toLowerCase().includes(queryLower);
        const catMatch = skill.category && skill.category.toLowerCase().includes(queryLower);
        return nameMatch || descMatch || catMatch;
      });
      
      // Remove embedding from response (too large)
      delete agent.description_embedding;
      
      return {
        agent,
        similarity: Math.round(similarity * 1000) / 1000, // Round to 3 decimal places
        matchedSkills: matchedSkills.map(s => s.name)
      };
    })
    .filter(r => r !== null && r.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
  
  // Also do a quick text search for agents without embeddings as a supplement
  const textSupplementResults = await getTextMatchSupplements(query, result.rows.map(r => r.id), limit - results.length);
  
  return {
    results,
    supplements: textSupplementResults,
    method: 'semantic',
    query,
    totalWithEmbeddings: result.rows.length,
    timestamp: new Date().toISOString()
  };
}

/**
 * Fallback text search when embeddings are unavailable
 */
async function fallbackTextSearch(query, options = {}) {
  const { limit = 10, category = null, trustTier = null } = options;
  
  let sql = `
    SELECT a.id, a.user_id, a.trust_tier, a.trust_score, a.rating, a.total_jobs,
           a.tagline, a.is_founder,
           u.wallet_address, u.name, u.avatar_url, u.bio,
           (SELECT json_agg(json_build_object(
             'id', s.id, 'name', s.name, 'description', s.description,
             'category', s.category, 'price_usdc', s.price_usdc,
             'estimated_time', s.estimated_time
           )) FROM skills s WHERE s.agent_id = a.id AND s.is_active = true) as skills
    FROM agents a
    JOIN users u ON a.user_id = u.id
    WHERE a.is_active = true
      AND (
        u.name ILIKE $1 OR u.bio ILIKE $1 OR
        EXISTS (SELECT 1 FROM skills s WHERE s.agent_id = a.id AND (
          s.name ILIKE $1 OR s.description ILIKE $1 OR s.category ILIKE $1
        ))
      )
  `;
  
  const searchPattern = `%${query}%`;
  const params = [searchPattern];
  let paramIndex = 2;
  
  if (category) {
    sql += ` AND EXISTS (SELECT 1 FROM skills s WHERE s.agent_id = a.id AND LOWER(s.category) = LOWER($${paramIndex}))`;
    params.push(category);
    paramIndex++;
  }
  
  if (trustTier) {
    const tierOrder = ['new', 'rising', 'established', 'trusted', 'verified'];
    const minTierIndex = tierOrder.indexOf(trustTier);
    if (minTierIndex >= 0) {
      const validTiers = tierOrder.slice(minTierIndex);
      sql += ` AND COALESCE(a.trust_tier, 'new') = ANY($${paramIndex})`;
      params.push(validTiers);
      paramIndex++;
    }
  }
  
  sql += ` ORDER BY a.is_founder DESC NULLS LAST, a.rating DESC, a.total_jobs DESC LIMIT $${paramIndex}`;
  params.push(limit);
  
  const result = await db.query(sql, params);
  
  // Calculate a pseudo-similarity score based on text matches
  const queryLower = query.toLowerCase();
  const results = result.rows.map(agent => {
    let score = 0;
    
    // Name match is highest value
    if (agent.name && agent.name.toLowerCase().includes(queryLower)) score += 0.5;
    if (agent.bio && agent.bio.toLowerCase().includes(queryLower)) score += 0.3;
    
    // Skill matches
    const matchedSkills = (agent.skills || []).filter(skill => {
      const nameMatch = skill.name && skill.name.toLowerCase().includes(queryLower);
      const descMatch = skill.description && skill.description.toLowerCase().includes(queryLower);
      return nameMatch || descMatch;
    });
    
    score += Math.min(matchedSkills.length * 0.2, 0.4);
    
    // Boost for trust/rating
    score += (agent.trust_score || 0) / 200;
    
    return {
      agent,
      similarity: Math.min(Math.round(score * 1000) / 1000, 0.99),
      matchedSkills: matchedSkills.map(s => s.name)
    };
  });
  
  return {
    results: results.sort((a, b) => b.similarity - a.similarity),
    supplements: [],
    method: 'text-fallback',
    query,
    totalWithEmbeddings: 0,
    timestamp: new Date().toISOString()
  };
}

/**
 * Get text-match supplements for agents without embeddings
 */
async function getTextMatchSupplements(query, excludeIds, limit) {
  if (limit <= 0) return [];
  
  const sql = `
    SELECT a.id, u.name, u.avatar_url,
           (SELECT json_agg(s.name) FROM skills s WHERE s.agent_id = a.id AND s.is_active = true) as skill_names
    FROM agents a
    JOIN users u ON a.user_id = u.id
    WHERE a.is_active = true
      AND a.description_embedding IS NULL
      AND a.id != ALL($1)
      AND (
        u.name ILIKE $2 OR u.bio ILIKE $2 OR
        EXISTS (SELECT 1 FROM skills s WHERE s.agent_id = a.id AND (
          s.name ILIKE $2 OR s.description ILIKE $2
        ))
      )
    LIMIT $3
  `;
  
  const result = await db.query(sql, [excludeIds, `%${query}%`, limit]);
  
  return result.rows.map(r => ({
    id: r.id,
    name: r.name,
    avatar_url: r.avatar_url,
    note: 'Text match (no embedding yet)'
  }));
}

/**
 * Store embedding for an agent in the database
 * @param {number} agentId - Agent ID
 * @param {number[]} embedding - Embedding vector
 */
async function storeAgentEmbedding(agentId, embedding) {
  if (!embedding) return false;
  
  try {
    await db.query(
      `UPDATE agents SET description_embedding = $1 WHERE id = $2`,
      [JSON.stringify(embedding), agentId]
    );
    return true;
  } catch (error) {
    logger.error('Failed to store agent embedding', { agentId, error: error.message });
    return false;
  }
}

/**
 * Compute and store embedding for a specific agent
 * @param {number} agentId - Agent ID to process
 */
async function computeAgentEmbedding(agentId) {
  // Fetch agent with skills
  const result = await db.query(`
    SELECT a.id, a.tagline, u.name, u.bio,
           (SELECT json_agg(json_build_object(
             'name', s.name, 'description', s.description, 'category', s.category
           )) FROM skills s WHERE s.agent_id = a.id AND s.is_active = true) as skills
    FROM agents a
    JOIN users u ON a.user_id = u.id
    WHERE a.id = $1
  `, [agentId]);
  
  if (result.rows.length === 0) {
    logger.warn('Agent not found for embedding', { agentId });
    return false;
  }
  
  const agent = result.rows[0];
  const embedding = await embedAgent(agent);
  
  if (embedding) {
    await storeAgentEmbedding(agentId, embedding);
    logger.info('Computed and stored embedding for agent', { agentId, name: agent.name });
    return true;
  }
  
  return false;
}

/**
 * Backfill embeddings for all agents that don't have them
 * @param {Object} options - Options
 * @param {number} options.batchSize - Batch size (default 10)
 * @param {number} options.delayMs - Delay between batches (default 1000)
 */
async function backfillEmbeddings(options = {}) {
  const { batchSize = 10, delayMs = 1000 } = options;
  
  if (!isEmbeddingsAvailable()) {
    logger.error('Cannot backfill embeddings - OPENAI_API_KEY not set');
    return { success: false, error: 'OpenAI API key not configured' };
  }
  
  // Get agents without embeddings
  const result = await db.query(`
    SELECT a.id, a.tagline, u.name, u.bio,
           (SELECT json_agg(json_build_object(
             'name', s.name, 'description', s.description, 'category', s.category
           )) FROM skills s WHERE s.agent_id = a.id AND s.is_active = true) as skills
    FROM agents a
    JOIN users u ON a.user_id = u.id
    WHERE a.is_active = true AND a.description_embedding IS NULL
    ORDER BY a.id
  `);
  
  const agents = result.rows;
  logger.info(`Starting embedding backfill for ${agents.length} agents`);
  
  let processed = 0;
  let failed = 0;
  
  // Process in batches
  for (let i = 0; i < agents.length; i += batchSize) {
    const batch = agents.slice(i, i + batchSize);
    
    const promises = batch.map(async (agent) => {
      try {
        const embedding = await embedAgent(agent);
        if (embedding) {
          await storeAgentEmbedding(agent.id, embedding);
          processed++;
          return true;
        }
        failed++;
        return false;
      } catch (error) {
        logger.error('Failed to process agent in backfill', { agentId: agent.id, error: error.message });
        failed++;
        return false;
      }
    });
    
    await Promise.all(promises);
    
    logger.info(`Backfill progress: ${i + batch.length}/${agents.length}`);
    
    // Rate limit delay
    if (i + batchSize < agents.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  logger.info(`Backfill complete: ${processed} processed, ${failed} failed`);
  
  return {
    success: true,
    total: agents.length,
    processed,
    failed
  };
}

/**
 * Get embedding stats for monitoring
 */
async function getEmbeddingStats() {
  const result = await db.query(`
    SELECT 
      COUNT(*) as total_agents,
      COUNT(CASE WHEN description_embedding IS NOT NULL THEN 1 END) as with_embeddings,
      COUNT(CASE WHEN description_embedding IS NULL THEN 1 END) as without_embeddings
    FROM agents
    WHERE is_active = true
  `);
  
  const stats = result.rows[0];
  
  return {
    totalAgents: parseInt(stats.total_agents),
    withEmbeddings: parseInt(stats.with_embeddings),
    withoutEmbeddings: parseInt(stats.without_embeddings),
    coverage: stats.total_agents > 0 
      ? Math.round((stats.with_embeddings / stats.total_agents) * 100)
      : 0,
    embeddingsAvailable: isEmbeddingsAvailable(),
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS
  };
}

module.exports = {
  isEmbeddingsAvailable,
  embedText,
  embedAgent,
  cosineSimilarity,
  semanticSearch,
  storeAgentEmbedding,
  computeAgentEmbedding,
  backfillEmbeddings,
  getEmbeddingStats,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS
};
