/**
 * Agent Router - Q-Learning Inspired Job-Agent Matching
 * 
 * Implements a smart matching system that:
 * - Scores agents based on multiple factors
 * - Learns from job outcomes to improve recommendations
 * - Provides explainable match reasons
 */

const logger = require('./logger');

// Default scoring weights (can be adjusted based on learning)
const DEFAULT_WEIGHTS = {
  skillMatch: 40,       // 0-40 points: How well skills match requirements
  categoryMatch: 20,    // 0-20 points: Agent specializes in this category
  successRate: 15,      // 0-15 points: Historical job completion rate
  rating: 15,           // 0-15 points: User ratings
  responseTime: 10,     // 0-10 points: How fast they typically respond
  priceMatch: 10,       // 0-10 points: Within budget range (bonus)
};

// Response time thresholds in seconds
const RESPONSE_TIME = {
  FAST: 3600,      // 1 hour
  MEDIUM: 86400,   // 24 hours
  SLOW: 604800,    // 1 week
};

/**
 * Calculate skill overlap between agent skills and required skills
 * Uses fuzzy matching for better results
 * @param {Array} agentSkills - Array of skill objects from agent
 * @param {Array} requiredSkills - Array of required skill names/keywords
 * @returns {number} Score between 0 and 1
 */
function calculateSkillOverlap(agentSkills, requiredSkills) {
  if (!requiredSkills || requiredSkills.length === 0) return 1;
  if (!agentSkills || agentSkills.length === 0) return 0;
  
  const agentSkillNames = agentSkills.map(s => 
    (s.name || '').toLowerCase() + ' ' + (s.description || '').toLowerCase()
  ).join(' ');
  
  let matchCount = 0;
  for (const required of requiredSkills) {
    const reqLower = required.toLowerCase();
    // Check for partial match in skill names or descriptions
    if (agentSkillNames.includes(reqLower)) {
      matchCount++;
    } else {
      // Fuzzy match: check if any words match
      const reqWords = reqLower.split(/\s+/);
      if (reqWords.some(word => word.length > 2 && agentSkillNames.includes(word))) {
        matchCount += 0.5;
      }
    }
  }
  
  return Math.min(1, matchCount / requiredSkills.length);
}

/**
 * Check if agent categories match required category
 * @param {Array} agentSkills - Agent's skill objects
 * @param {string} requiredCategory - Required category
 * @returns {boolean}
 */
function checkCategoryMatch(agentSkills, requiredCategory) {
  if (!requiredCategory) return true;
  if (!agentSkills || agentSkills.length === 0) return false;
  
  const reqLower = requiredCategory.toLowerCase();
  return agentSkills.some(s => 
    s.category && s.category.toLowerCase().includes(reqLower)
  );
}

/**
 * Calculate price match score
 * @param {Array} agentSkills - Agent's skills with prices
 * @param {number} budget - User's budget
 * @returns {number} Score between 0 and 1
 */
function calculatePriceMatch(agentSkills, budget) {
  if (!budget) return 0.5; // Neutral if no budget specified
  if (!agentSkills || agentSkills.length === 0) return 0.5;
  
  // Get minimum price from agent's skills
  const minPrice = Math.min(...agentSkills.map(s => parseFloat(s.price_usdc) || 999999));
  
  if (minPrice <= budget) {
    // Within budget - bonus points
    const ratio = minPrice / budget;
    return ratio >= 0.5 ? 1 : 0.7; // Prefer fair prices, not too cheap
  } else {
    // Over budget - reduce score based on how much over
    const overRatio = budget / minPrice;
    return Math.max(0, overRatio);
  }
}

/**
 * Score an agent for a specific job requirement
 * @param {Object} agent - Agent object with skills, rating, etc.
 * @param {Object} requirements - Job requirements
 * @param {Object} weights - Optional custom weights
 * @returns {Object} { score: number, reasons: string[], breakdown: Object }
 */
function scoreAgentForJob(agent, requirements = {}, weights = DEFAULT_WEIGHTS) {
  const breakdown = {};
  const reasons = [];
  let score = 0;
  
  // 1. Skill Match (0 - weights.skillMatch)
  const skillOverlap = calculateSkillOverlap(agent.skills, requirements.skills);
  breakdown.skillMatch = Math.round(skillOverlap * weights.skillMatch);
  score += breakdown.skillMatch;
  
  if (skillOverlap > 0.8) {
    const matchedSkills = requirements.skills?.slice(0, 2).join(', ') || 'requested services';
    reasons.push(`Strong skill match: ${matchedSkills}`);
  } else if (skillOverlap > 0.5) {
    reasons.push('Partial skill match');
  }
  
  // 2. Category Match (0 or weights.categoryMatch)
  const categoryMatch = checkCategoryMatch(agent.skills, requirements.category);
  breakdown.categoryMatch = categoryMatch ? weights.categoryMatch : 0;
  score += breakdown.categoryMatch;
  
  if (categoryMatch && requirements.category) {
    reasons.push(`Specializes in ${requirements.category}`);
  }
  
  // 3. Success Rate (0 - weights.successRate)
  // Use completion_rate from agent if available, default to 0.5 for new agents
  const successRate = parseFloat(agent.completion_rate) / 100 || 0.5;
  breakdown.successRate = Math.round(successRate * weights.successRate);
  score += breakdown.successRate;
  
  if (successRate >= 0.95) {
    reasons.push(`${Math.round(successRate * 100)}% success rate`);
  }
  
  // 4. Rating (0 - weights.rating)
  const rating = parseFloat(agent.rating) || 0;
  const ratingScore = (rating / 5) * weights.rating;
  breakdown.rating = Math.round(ratingScore);
  score += breakdown.rating;
  
  if (rating >= 4.5) {
    reasons.push(`${rating.toFixed(1)}★ rating`);
  } else if (rating >= 4.0) {
    reasons.push(`${rating.toFixed(1)}★ rated`);
  }
  
  // 5. Response Time (0 - weights.responseTime)
  const responseTime = parseInt(agent.response_time_avg) || RESPONSE_TIME.MEDIUM;
  let responseScore = 0;
  
  if (responseTime <= RESPONSE_TIME.FAST) {
    responseScore = weights.responseTime;
    reasons.push('Fast responder (<1h)');
  } else if (responseTime <= RESPONSE_TIME.MEDIUM) {
    responseScore = weights.responseTime * 0.5;
  }
  
  breakdown.responseTime = Math.round(responseScore);
  score += breakdown.responseTime;
  
  // 6. Price Match (0 - weights.priceMatch) - bonus
  if (requirements.budget) {
    const priceMatch = calculatePriceMatch(agent.skills, requirements.budget);
    breakdown.priceMatch = Math.round(priceMatch * weights.priceMatch);
    score += breakdown.priceMatch;
    
    if (priceMatch >= 0.9) {
      reasons.push('Within budget');
    }
  } else {
    breakdown.priceMatch = 0;
  }
  
  // Bonus: Trust tier boost
  if (agent.trust_tier === 'verified') {
    score += 5;
    reasons.push('Verified agent');
  } else if (agent.trust_tier === 'trusted') {
    score += 3;
  }
  
  // Bonus: Founder badge
  if (agent.is_founder) {
    score += 2;
    reasons.push('Founding agent');
  }
  
  // Ensure reasons array has at least one entry
  if (reasons.length === 0) {
    reasons.push('Available for hire');
  }
  
  return {
    score: Math.round(Math.min(100, score)),
    reasons: reasons.slice(0, 4), // Top 4 reasons
    breakdown
  };
}

/**
 * Parse a natural language query into structured requirements
 * @param {string} query - Natural language query like "I need help with Python data analysis"
 * @returns {Object} { skills: string[], category: string|null }
 */
function parseQuery(query) {
  if (!query) return { skills: [], category: null };
  
  const queryLower = query.toLowerCase();
  const requirements = {
    skills: [],
    category: null
  };
  
  // Category detection
  const categoryKeywords = {
    'research': ['research', 'analyze', 'analysis', 'study', 'investigate', 'report'],
    'writing': ['write', 'writing', 'copywriting', 'content', 'blog', 'article', 'copy'],
    'code': ['code', 'coding', 'programming', 'developer', 'software', 'python', 'javascript', 'api'],
    'image': ['image', 'design', 'graphic', 'logo', 'illustration', 'visual', 'creative'],
    'data': ['data', 'analytics', 'statistics', 'dashboard', 'excel', 'spreadsheet'],
    'automation': ['automation', 'workflow', 'integrate', 'bot', 'scrape', 'automate']
  };
  
  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.some(kw => queryLower.includes(kw))) {
      requirements.category = category;
      break;
    }
  }
  
  // Extract potential skill keywords (nouns and significant words)
  const stopWords = new Set(['i', 'need', 'help', 'with', 'want', 'looking', 'for', 'someone', 'to', 'can', 'who', 'that', 'a', 'an', 'the', 'my', 'me', 'please', 'do', 'make', 'create', 'build', 'get']);
  const words = queryLower
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
  
  requirements.skills = [...new Set(words)].slice(0, 5); // Top 5 unique keywords
  
  return requirements;
}

/**
 * Get agent recommendations based on requirements
 * @param {Array} agents - Array of agent objects
 * @param {Object} options - { query, category, budget, skills, limit }
 * @returns {Array} Sorted array of { agent, score, reasons }
 */
function getRecommendations(agents, options = {}) {
  const { query, category, budget, skills, limit = 10 } = options;
  
  // Parse natural language query if provided
  let requirements = { skills: [], category: null, budget: null };
  
  if (query) {
    requirements = parseQuery(query);
  }
  
  // Override with explicit parameters
  if (category) requirements.category = category;
  if (budget) requirements.budget = parseFloat(budget);
  if (skills) {
    requirements.skills = Array.isArray(skills) ? skills : skills.split(',').map(s => s.trim());
  }
  
  // Score all agents
  const scoredAgents = agents
    .filter(a => a.is_active !== false)
    .map(agent => {
      const { score, reasons, breakdown } = scoreAgentForJob(agent, requirements);
      return {
        agent,
        score,
        reasons,
        breakdown
      };
    });
  
  // Sort by score descending
  scoredAgents.sort((a, b) => b.score - a.score);
  
  // Return top N
  return scoredAgents.slice(0, limit);
}

/**
 * Record a match outcome for learning
 * @param {Object} db - Database instance
 * @param {string} jobUuid - Job UUID
 * @param {number} agentId - Agent ID
 * @param {number} matchScore - Score that was calculated at match time
 * @param {string} outcome - 'completed', 'disputed', 'cancelled'
 */
async function recordMatchOutcome(db, jobUuid, agentId, matchScore, outcome) {
  try {
    await db.query(`
      INSERT INTO match_outcomes (job_uuid, agent_id, match_score, outcome)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (job_uuid) DO UPDATE SET outcome = $4
    `, [jobUuid, agentId, matchScore, outcome]);
    
    logger.info('Recorded match outcome', { jobUuid, agentId, outcome });
  } catch (error) {
    logger.error('Failed to record match outcome', { error: error.message });
  }
}

/**
 * Get learning stats for weight adjustment
 * Returns success rate by score range
 * @param {Object} db - Database instance
 * @returns {Object} Stats for weight adjustment
 */
async function getLearningStats(db) {
  try {
    const result = await db.query(`
      SELECT 
        CASE 
          WHEN match_score >= 80 THEN 'high'
          WHEN match_score >= 50 THEN 'medium'
          ELSE 'low'
        END as score_range,
        COUNT(*) as total,
        COUNT(CASE WHEN outcome = 'completed' THEN 1 END) as completed,
        COUNT(CASE WHEN outcome = 'disputed' THEN 1 END) as disputed,
        AVG(match_score) as avg_score
      FROM match_outcomes
      WHERE created_at > NOW() - INTERVAL '90 days'
      GROUP BY score_range
    `);
    
    return {
      ranges: result.rows,
      totalOutcomes: result.rows.reduce((sum, r) => sum + parseInt(r.total), 0)
    };
  } catch (error) {
    logger.error('Failed to get learning stats', { error: error.message });
    return { ranges: [], totalOutcomes: 0 };
  }
}

/**
 * Update agent performance stats after job completion
 * @param {Object} db - Database instance  
 * @param {number} agentId - Agent ID
 */
async function updateAgentPerformanceStats(db, agentId) {
  try {
    await db.query(`
      WITH stats AS (
        SELECT 
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status IN ('completed', 'failed', 'refunded', 'disputed')) as total,
          AVG(EXTRACT(EPOCH FROM (
            CASE WHEN accepted_at IS NOT NULL THEN accepted_at - created_at ELSE NULL END
          ))) as avg_response
        FROM jobs 
        WHERE agent_id = $1
      )
      UPDATE agents SET
        total_jobs_completed = COALESCE((SELECT completed FROM stats), 0),
        success_rate = CASE 
          WHEN (SELECT total FROM stats) > 0 
          THEN ((SELECT completed FROM stats)::FLOAT / (SELECT total FROM stats)) 
          ELSE 0.5 
        END,
        response_time_avg = COALESCE((SELECT avg_response FROM stats)::INTEGER, 0)
      WHERE id = $1
    `, [agentId]);
    
    logger.info('Updated agent performance stats', { agentId });
  } catch (error) {
    logger.error('Failed to update agent performance stats', { error: error.message });
  }
}

module.exports = {
  DEFAULT_WEIGHTS,
  calculateSkillOverlap,
  checkCategoryMatch,
  calculatePriceMatch,
  scoreAgentForJob,
  parseQuery,
  getRecommendations,
  recordMatchOutcome,
  getLearningStats,
  updateAgentPerformanceStats
};
