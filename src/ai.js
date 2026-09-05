const Anthropic = require('@anthropic-ai/sdk');
const { getService } = require('./services');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ============================================
// AI GENERATION (uses services.js prompts)
// ============================================
async function generateWithAI(serviceKey, userMessage) {
  // Get service config - try new services first, fall back to legacy
  const service = getService(serviceKey);
  const systemPrompt = service ? service.systemPrompt : null;

  if (!systemPrompt) {
    throw new Error(`Unknown service: ${serviceKey}`);
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userMessage }
      ]
    });

    const content = response.content[0].text;
    // Extract JSON from response (Claude may wrap in markdown)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('AI generation error:', error.message);
    throw error;
  }
}

module.exports = {
  generateWithAI
};
