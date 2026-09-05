/**
 * Tests for Agent Router
 * Run with: node src/agent-router.test.js
 */

const {
  calculateSkillOverlap,
  checkCategoryMatch,
  calculatePriceMatch,
  scoreAgentForJob,
  parseQuery,
  getRecommendations
} = require('./agent-router');

// Simple test framework
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${e.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} Expected ${expected}, got ${actual}`);
  }
}

function assertRange(actual, min, max, msg = '') {
  if (actual < min || actual > max) {
    throw new Error(`${msg} Expected ${actual} to be between ${min} and ${max}`);
  }
}

function assertArrayIncludes(array, item, msg = '') {
  if (!array.includes(item)) {
    throw new Error(`${msg} Expected array to include "${item}"`);
  }
}

// Mock agent data
const mockAgent = {
  id: 1,
  name: 'TestAgent',
  skills: [
    { id: 1, name: 'Python Development', description: 'Build Python apps', category: 'code', price_usdc: 25 },
    { id: 2, name: 'Data Analysis', description: 'Analyze data with pandas', category: 'data', price_usdc: 30 }
  ],
  rating: 4.5,
  completion_rate: 95,
  response_time_avg: 1800, // 30 minutes
  trust_tier: 'trusted'
};

const mockAgent2 = {
  id: 2,
  name: 'ResearchBot',
  skills: [
    { id: 3, name: 'Market Research', description: 'Deep market analysis', category: 'research', price_usdc: 50 }
  ],
  rating: 4.2,
  completion_rate: 88,
  response_time_avg: 43200, // 12 hours
  trust_tier: 'rising'
};

console.log('\n📊 Testing Agent Router\n');

// Test: calculateSkillOverlap
test('calculateSkillOverlap: full match', () => {
  const overlap = calculateSkillOverlap(mockAgent.skills, ['python', 'data']);
  assertRange(overlap, 0.8, 1.0, 'Should have high overlap');
});

test('calculateSkillOverlap: partial match', () => {
  const overlap = calculateSkillOverlap(mockAgent.skills, ['python', 'javascript']);
  assertRange(overlap, 0.4, 0.8, 'Should have partial overlap');
});

test('calculateSkillOverlap: no match', () => {
  const overlap = calculateSkillOverlap(mockAgent.skills, ['marketing', 'seo']);
  assertRange(overlap, 0, 0.5, 'Should have low overlap');
});

test('calculateSkillOverlap: empty requirements', () => {
  const overlap = calculateSkillOverlap(mockAgent.skills, []);
  assertEqual(overlap, 1, 'Empty requirements should return 1');
});

// Test: checkCategoryMatch
test('checkCategoryMatch: matching category', () => {
  const match = checkCategoryMatch(mockAgent.skills, 'code');
  assertEqual(match, true, 'Should match code category');
});

test('checkCategoryMatch: non-matching category', () => {
  const match = checkCategoryMatch(mockAgent.skills, 'writing');
  assertEqual(match, false, 'Should not match writing category');
});

// Test: calculatePriceMatch
test('calculatePriceMatch: within budget', () => {
  const match = calculatePriceMatch(mockAgent.skills, 100);
  // Returns 0.7 for very cheap prices (to avoid suspiciously low), 1.0 for fair prices
  assertRange(match, 0.7, 1.0, 'Should be good match when within budget');
});

test('calculatePriceMatch: over budget', () => {
  const match = calculatePriceMatch(mockAgent.skills, 10);
  assertRange(match, 0.3, 0.5, 'Should be partial match when over budget');
});

test('calculatePriceMatch: no budget', () => {
  const match = calculatePriceMatch(mockAgent.skills, null);
  assertEqual(match, 0.5, 'Should be neutral when no budget');
});

// Test: scoreAgentForJob
test('scoreAgentForJob: high match scenario', () => {
  const { score, reasons } = scoreAgentForJob(mockAgent, {
    skills: ['python', 'data'],
    category: 'code',
    budget: 50
  });
  assertRange(score, 70, 100, 'Should have high score');
  console.log(`  Score: ${score}, Reasons: ${reasons.join(', ')}`);
});

test('scoreAgentForJob: low match scenario', () => {
  const { score, reasons } = scoreAgentForJob(mockAgent, {
    skills: ['marketing', 'seo'],
    category: 'writing',
    budget: 5
  });
  assertRange(score, 20, 60, 'Should have lower score');
  console.log(`  Score: ${score}, Reasons: ${reasons.join(', ')}`);
});

test('scoreAgentForJob: includes trust tier bonus', () => {
  const { score: trustedScore } = scoreAgentForJob({ ...mockAgent, trust_tier: 'verified' }, {});
  const { score: newScore } = scoreAgentForJob({ ...mockAgent, trust_tier: 'new' }, {});
  assertEqual(trustedScore > newScore, true, 'Verified should score higher than new');
});

// Test: parseQuery
test('parseQuery: detects code category', () => {
  const { category, skills } = parseQuery('I need help with Python programming');
  assertEqual(category, 'code', 'Should detect code category');
  assertArrayIncludes(skills, 'python', 'Should extract python skill');
});

test('parseQuery: detects research category', () => {
  const { category } = parseQuery('Can you analyze market trends?');
  assertEqual(category, 'research', 'Should detect research category');
});

test('parseQuery: extracts multiple skills', () => {
  const { skills } = parseQuery('Need JavaScript and React developer for API work');
  assertEqual(skills.length >= 2, true, 'Should extract multiple skills');
});

// Test: getRecommendations
test('getRecommendations: returns sorted results', () => {
  const agents = [mockAgent, mockAgent2];
  const recs = getRecommendations(agents, {
    query: 'python data analysis',
    category: 'code'
  });
  assertEqual(recs.length, 2, 'Should return 2 recommendations');
  assertEqual(recs[0].agent.id, 1, 'TestAgent should be first (better match for code)');
  assertEqual(recs[0].score >= recs[1].score, true, 'Should be sorted by score descending');
});

test('getRecommendations: respects limit', () => {
  const agents = [mockAgent, mockAgent2];
  const recs = getRecommendations(agents, { limit: 1 });
  assertEqual(recs.length, 1, 'Should respect limit');
});

test('getRecommendations: works with empty options', () => {
  const agents = [mockAgent, mockAgent2];
  const recs = getRecommendations(agents, {});
  assertEqual(recs.length, 2, 'Should return all agents');
});

// Summary
console.log('\n' + '='.repeat(40));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(40) + '\n');

process.exit(failed > 0 ? 1 : 0);
