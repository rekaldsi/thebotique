const { z } = require('zod');
const db = require('./db');

// ============================================
// ZOD SCHEMAS
// ============================================

// Ethereum address (0x + 40 hex chars)
const ethereumAddressSchema = z.string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format');

// Transaction hash (0x + 64 hex chars)
const txHashSchema = z.string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid transaction hash format');

// UUID v4
const uuidSchema = z.string()
  .uuid('Invalid UUID format');

// HTTPS URL
const httpsUrlSchema = z.string()
  .url('Invalid URL format')
  .refine(url => url.startsWith('https://'), 'Webhook URL must use HTTPS');

// Price (positive number, max $1000)
const priceSchema = z.number()
  .positive('Price must be positive')
  .max(1000, 'Price cannot exceed $1000');

// Positive integer ID
const positiveIdSchema = z.number()
  .int('ID must be an integer')
  .positive('ID must be positive');

// API key (min 32 chars)
const apiKeySchema = z.string()
  .min(32, 'Invalid API key format');

// Job input (max 10KB as string)
const jobInputSchema = z.union([
  z.string().max(10000, 'Input text too large (max 10KB)'),
  z.object({}).passthrough() // Allow objects
]).refine(
  (val) => {
    const size = JSON.stringify(val).length;
    return size <= 10000;
  },
  'Input data too large (max 10KB)'
);

// Job output (max 100KB)
const jobOutputSchema = z.object({}).passthrough()
  .refine(
    (val) => {
      const size = JSON.stringify(val).length;
      return size <= 100000;
    },
    'Output data too large (max 100KB)'
  );

// ============================================
// REQUEST SCHEMAS
// ============================================

const createUserSchema = z.object({
  wallet: ethereumAddressSchema,
  type: z.enum(['human', 'agent']).optional(),
  name: z.string().max(100).optional()
});

const createJobSchema = z.object({
  wallet: ethereumAddressSchema,
  agentId: positiveIdSchema,
  skillId: positiveIdSchema,
  input: jobInputSchema,
  price: priceSchema
});

const payJobSchema = z.object({
  txHash: txHashSchema
});

const completeJobSchema = z.object({
  apiKey: apiKeySchema,
  output: z.union([
    jobOutputSchema,
    z.undefined() // Allow missing output for status updates
  ]).optional(),
  status: z.enum(['in_progress', 'completed']).optional()
});

const registerAgentSchema = z.object({
  wallet: ethereumAddressSchema,
  name: z.string().min(1, 'Name is required').max(100, 'Name too long (max 100 chars)'),
  bio: z.string().max(500, 'Bio too long (max 500 chars)').optional(),
  webhookUrl: z.union([
    httpsUrlSchema,
    z.null(),
    z.undefined()
  ]).optional(),
  skills: z.array(z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    category: z.string().max(50).optional(),
    price: z.number().positive().max(1000),
    estimatedTime: z.string().max(50).optional()
  })).min(1, 'At least one skill is required').optional(),
  // Optional signature for wallet verification
  signature: z.string().optional()
});

// ============================================
// VALIDATION MIDDLEWARE
// ============================================

/**
 * Create Express middleware for validating request body
 * @param {z.ZodSchema} schema - Zod schema to validate against
 * @returns {Function} Express middleware
 */
function validateBody(schema) {
  return (req, res, next) => {
    try {
      const validated = schema.parse(req.body);
      req.validatedBody = validated; // Store validated data
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        // Format Zod errors into user-friendly response
        const firstError = error.errors[0];
        return res.status(400).json({
          error: firstError.message,
          code: 'VALIDATION_ERROR',
          field: firstError.path.join('.'),
          details: error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        });
      }
      next(error);
    }
  };
}

/**
 * Validate UUID parameter
 */
function validateUuidParam(paramName = 'uuid') {
  return (req, res, next) => {
    try {
      uuidSchema.parse(req.params[paramName]);
      next();
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid job ID format',
        code: 'INVALID_UUID'
      });
    }
  };
}

/**
 * Validate positive integer ID parameter
 */
function validateIdParam(paramName = 'id') {
  return (req, res, next) => {
    const id = parseInt(req.params[paramName], 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({
        error: `Invalid ${paramName} format`,
        code: 'INVALID_ID'
      });
    }
    req.params[paramName] = id; // Store parsed integer
    next();
  };
}

/**
 * Validate request body size doesn't exceed limit
 */
function validateRequestSize(maxSizeKB = 100) {
  return (req, res, next) => {
    const contentLength = req.headers['content-length'];
    if (contentLength && parseInt(contentLength, 10) > maxSizeKB * 1024) {
      return res.status(413).json({
        error: `Request body too large (max ${maxSizeKB}KB)`,
        code: 'PAYLOAD_TOO_LARGE'
      });
    }
    next();
  };
}

// ============================================
// HELPER FUNCTIONS (backward compatibility)
// ============================================

function isValidEthereumAddress(address) {
  return ethereumAddressSchema.safeParse(address).success;
}

function isValidPrice(price) {
  return priceSchema.safeParse(price).success;
}

function isValidTxHash(hash) {
  return txHashSchema.safeParse(hash).success;
}

function isValidUuid(uuid) {
  return uuidSchema.safeParse(uuid).success;
}

// ============================================
// DATABASE EXISTENCE VALIDATORS
// ============================================

/**
 * Validate that agent exists in database
 */
async function validateAgentExists(agentId) {
  const agent = await db.getAgent(agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }
  return agent;
}

/**
 * Validate that skill exists in database
 */
async function validateSkillExists(skillId) {
  const skill = await db.getSkill(skillId);
  if (!skill) {
    throw new Error('Skill not found');
  }
  return skill;
}

/**
 * Validate that user exists in database
 */
async function validateUserExists(wallet) {
  const user = await db.getUser(wallet);
  if (!user) {
    throw new Error('User not found. Please create an account first.');
  }
  return user;
}

/**
 * Validate that skill belongs to agent
 */
async function validateSkillBelongsToAgent(skillId, agentId) {
  const skill = await db.getSkill(skillId);
  if (!skill) {
    throw new Error('Skill not found');
  }
  if (skill.agent_id !== agentId) {
    throw new Error('Skill does not belong to specified agent');
  }
  return skill;
}

/**
 * Validate that skill price matches expected price
 */
async function validateSkillPrice(skillId, expectedPrice) {
  const skill = await db.getSkill(skillId);
  if (!skill) {
    throw new Error('Skill not found');
  }

  const skillPrice = parseFloat(skill.price_usdc);
  const providedPrice = parseFloat(expectedPrice);

  // Allow 0.1% tolerance for floating point precision
  const tolerance = skillPrice * 0.001;
  if (Math.abs(skillPrice - providedPrice) > tolerance) {
    throw new Error(`Price mismatch. Expected $${skillPrice.toFixed(2)}, got $${providedPrice.toFixed(2)}`);
  }

  return skill;
}

// ============================================
// SANITIZATION HELPERS
// ============================================

/**
 * Sanitize text input (trim, normalize whitespace)
 */
function sanitizeText(text) {
  if (typeof text !== 'string') return text;
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Sanitize job input data
 */
function sanitizeJobInput(input) {
  if (typeof input === 'string') {
    return sanitizeText(input);
  }
  if (typeof input === 'object' && input !== null) {
    const sanitized = {};
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string') {
        sanitized[key] = sanitizeText(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
  return input;
}

/**
 * Validate and sanitize webhook URL
 */
function sanitizeWebhookUrl(url) {
  if (!url) return null;

  // Ensure HTTPS
  if (!url.startsWith('https://')) {
    throw new Error('Webhook URL must use HTTPS protocol');
  }

  // Validate URL format
  try {
    const parsed = new URL(url);

    // Don't allow localhost/private IPs in production
    if (process.env.NODE_ENV === 'production') {
      const hostname = parsed.hostname;
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.')) {
        throw new Error('Webhook URL cannot use private/local addresses');
      }
    }

    return url.trim();
  } catch (error) {
    throw new Error('Invalid webhook URL format');
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Schemas
  ethereumAddressSchema,
  txHashSchema,
  uuidSchema,
  httpsUrlSchema,
  priceSchema,
  positiveIdSchema,
  apiKeySchema,
  jobInputSchema,
  jobOutputSchema,

  // Request schemas
  createUserSchema,
  createJobSchema,
  payJobSchema,
  completeJobSchema,
  registerAgentSchema,

  // Middleware
  validateBody,
  validateUuidParam,
  validateIdParam,
  validateRequestSize,

  // Helper functions (backward compat)
  isValidEthereumAddress,
  isValidPrice,
  isValidTxHash,
  isValidUuid,

  // Database validators
  validateAgentExists,
  validateSkillExists,
  validateUserExists,
  validateSkillBelongsToAgent,
  validateSkillPrice,

  // Sanitization helpers
  sanitizeText,
  sanitizeJobInput,
  sanitizeWebhookUrl
};
