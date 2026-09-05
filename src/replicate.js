// src/replicate.js
// Image Generation Module - Replicate API integration

const Replicate = require('replicate');

// Initialize Replicate client
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

/**
 * Generate image using Replicate API
 * @param {string} modelId - Replicate model ID (e.g., "black-forest-labs/flux-schnell")
 * @param {string} prompt - User's image description
 * @param {Object} options - Additional model parameters (optional)
 * @returns {Promise<Object>} Result with image URLs
 * @throws {Error} If model not found or generation fails
 */
async function generateImage(modelId, prompt, options = {}) {
  if (!process.env.REPLICATE_API_TOKEN) {
    throw new Error('REPLICATE_API_TOKEN not configured');
  }

  try {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'replicate_start',
      modelId: modelId,
      promptLength: prompt.length
    }));

    const startTime = Date.now();

    // Start prediction
    const input = {
      prompt: prompt,
      ...options
    };

    // Run prediction and wait for completion
    const output = await replicate.run(modelId, { input });

    const duration = Date.now() - startTime;

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'replicate_complete',
      modelId: modelId,
      duration: duration,
      imageCount: Array.isArray(output) ? output.length : 1
    }));

    // Normalize output format
    if (Array.isArray(output)) {
      return { images: output };
    } else if (typeof output === 'string') {
      return { images: [output] };
    } else {
      return { images: [output.toString()] };
    }

  } catch (error) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'replicate_error',
      modelId: modelId,
      error: error.message,
      stack: error.stack
    }));
    throw error;
  }
}

/**
 * Get available Replicate models
 * @returns {Object} Map of model names to IDs
 */
function getModels() {
  return {
    'flux-schnell': 'black-forest-labs/flux-schnell',
    'sdxl': 'stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b',
    'photomaker': 'tencentarc/photomaker:ddfc2b08d209f9fa8c1eca692712918bd449f695dabb4a958da31802a9570fe4'
  };
}

module.exports = {
  generateImage,
  getModels
};
