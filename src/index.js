require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./logger');
const stats = require('./stats');
const db = require('./db');

const app = express();

// Redirect non-www to www (fixes routing issues with apex domain).
//
// Except /.well-known/. Those are host-scoped verification endpoints (RFC 8615):
// something asks "does THIS host vouch for this?" and answers the exact host it
// was asked about. Plenty of verifiers do not follow redirects, so a 301 there
// reads as "no proof" rather than "look over there" -- and it is the apex that
// namespaces are keyed to, not www.
app.use((req, res, next) => {
  const host = req.get('host');
  if (host === 'thebotique.ai' && !req.path.startsWith('/.well-known/')) {
    return res.redirect(301, `https://www.thebotique.ai${req.originalUrl}`);
  }
  next();
});

// CORS: Explicit allowed origins (security fix - no wildcard)
app.use(cors({
  origin: ['https://www.thebotique.ai', 'https://thebotique.ai'],
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));

// Security headers via helmet
app.use(helmet({
  contentSecurityPolicy: false, // We set CSP manually below for wallet compatibility
  hsts: { maxAge: 31536000, includeSubDomains: true },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// Billing webhooks are signed over the EXACT raw bytes, so this must run
// before express.json below -- once the body is parsed the original bytes
// are gone and no signature can ever verify. express.raw marks the body as
// consumed, so express.json skips this path.
app.use('/drift/billing/webhook', express.raw({ type: '*/*', limit: '512kb' }));

// More restrictive limits for API endpoints
app.use(express.json({
  limit: '100kb', // Default limit for most requests
  strict: true    // Only accept arrays and objects
}));

// Security: Content-Security-Policy header
// Note: 'unsafe-eval' needed for some ethers.js operations, wallet providers need blob: and data:
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https: blob:",
    "connect-src 'self' https://mainnet.base.org https://base-mainnet.g.alchemy.com https://*.alchemy.com https://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.com wss://*.walletconnect.org https://cloudflare-eth.com",
    "frame-src 'self' https://*.walletconnect.com https://*.walletconnect.org"
  ].join('; '));
  next();
});

// Behind Railway's proxy, req.ip is the proxy's address unless Express is
// told to trust the X-Forwarded-For header. express-rate-limit was warning
// about exactly this in production: without it every visitor shares a single
// rate-limit bucket, so one noisy client throttles everybody. One hop.
app.set('trust proxy', 1);

// Staging gate. A dev copy of the board must never be indexed or crawled, or
// its test posts and its separately-keyed checkpoints could be mistaken for
// the live log. With STAGING set, /robots.txt is overridden (this route is
// registered ahead of the static mount below, so it wins over public/robots.txt,
// which welcomes crawlers on purpose in production) and every response carries
// X-Robots-Tag, so the gate holds even on a page that forgets a meta tag.
if (process.env.STAGING) {
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });
  app.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
}

// Serve static files from public directory (PWA assets)
const path = require('path');
app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '1d',
  etag: true
}));

// /skill.md is served by src/sigil/skill.js, which builds it from the live
// SITE constant. The route that used to be here sent public/skill.md -- the
// onboarding file for the retired marketplace -- and being registered ahead of
// the router, it shadowed the real one. It returned 200 locally with the wrong
// content and 500 in production, where that file is not in the container.

// Serve capability manifest schema
app.get('/schemas/capability-manifest-v1.json', (req, res) => {
  res.json({
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "TheBotique Capability Manifest",
    "version": "1.0",
    "type": "object",
    "properties": {
      "version": { "type": "string" },
      "capabilities": {
        "type": "object",
        "properties": {
          "can_do": { "type": "array", "items": { "type": "string" } },
          "cannot_do": { "type": "array", "items": { "type": "string" } },
          "response_model": { "enum": ["sync", "async", "human_assisted"] },
          "avg_response_time": { "type": "string" },
          "human_escalation": { "type": "boolean" }
        }
      },
      "safety": {
        "type": "object",
        "properties": {
          "reads_external_data": { "type": "boolean" },
          "writes_external_data": { "type": "boolean" },
          "executes_code": { "type": "boolean" },
          "requires_human_review": { "type": "boolean" }
        }
      }
    }
  });
});

// Request logging and stats
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;

    // Track stats
    stats.incrementRequestCount(req.method, req.path, res.statusCode);

    const referer = req.get('referer') || null;
    const ua = req.get('user-agent') || null;
    stats.recordArrival(req.path, referer, ua);

    const logData = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      referer,
      ua
    };

    if (res.statusCode >= 500) {
      logger.error('Request failed', logData);
    } else if (res.statusCode >= 400) {
      logger.warn('Request error', logData);
    } else {
      logger.info('Request completed', logData);
    }
  });

  next();
});

// Arrival attribution (server-side, off unless ARRIVALS_KEY is set). 404 rather
// than 401 so the endpoint's existence is not advertised while it is disabled.
app.get('/api/arrivals', (req, res) => {
  const key = process.env.ARRIVALS_KEY;
  if (!key || req.get('x-arrivals-key') !== key) return res.status(404).end();
  res.json(stats.getArrivals());
});

const PORT = process.env.PORT || 7378;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ============================================
// RATE LIMITING
// ============================================

// HTML pages - very generous (200 req/min per IP)
const htmlPageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false // Disable `X-RateLimit-*` headers
});

// Read-only API endpoints - generous (100 req/min per IP)
//
// Despite the name, this sits in front of every /api method, GET and POST
// alike -- see the unconditional app.use('/api', apiReadLimiter) below -- and
// it is what 429'd near-simultaneous signed board posts in a live multi-agent
// test. A signed POST /api/post is already governed by the board's own
// per-agent control (src/board/ingest.js checkRate: burst 5/20s, 40/hour,
// 200/day), which is the real anti-spam gate for it; this blanket per-IP
// bucket is the anti-DoS backstop for everything else and has no business
// also capping several agents' legitimate, near-simultaneous posts. Skip it
// on that one path and give it its own generous bucket below instead.
//
// req.path here is relative to this middleware's OWN mount point ('/api'),
// not the full request path -- Express trims the matched prefix before
// calling a use()-mounted handler -- so the comparison below is against
// '/post', not '/api/post'.
const apiReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many API requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'POST' && req.path === '/post'
});

// The anti-DoS backstop for signed board posts specifically, now that they are
// exempt from apiReadLimiter above. Wide enough that it is not expected to
// bind in ordinary use -- the real control is checkRate, per agent, inside
// the handler.
const boardPostLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Too many requests to /api/post, please slow down' },
  standardHeaders: true,
  legacyHeaders: false
});

// Passwordless-auth POSTs (/drift/login) send an email via Resend to a
// caller-supplied address. Without a cap, an unauthenticated caller can
// email-bomb an arbitrary victim through our sending domain (and inflate
// drift_accounts). Strict, per-IP, POST only -- the GET login form is exempt.
const driftAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many attempts, please wait a minute and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method !== 'POST'
});

// /api/witness triggers an outbound key-directory fetch to a caller-supplied
// domain -- a confused-deputy relay. The generic 100/min /api bucket is too
// loose for a request that costs an outbound connection, so give it a tight
// dedicated one. (Private/internal targets are already blocked in
// sigil/directory.js's resolve-and-pin guard.)
const witnessLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many witness submissions, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});


// ============================================
// API KEY-BASED RATE LIMITING (A2A Enhancement)
// ============================================

// Store for API key rate limits (in-memory, use Redis in production)
const apiKeyLimits = new Map();

/**
 * API Key rate limiter middleware
 * Limits requests per API key in addition to IP-based limits
 * Reads: 100/min, Writes: 20/min
 */
const apiKeyRateLimiter = (type = 'read') => {
  const limits = {
    read: { max: 100, windowMs: 60000 },
    write: { max: 20, windowMs: 60000 }
  };
  const config = limits[type] || limits.read;
  
  return (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      // No API key, fall through to IP-based limiting
      return next();
    }
    
    const key = `${apiKey}:${type}`;
    const now = Date.now();
    
    let record = apiKeyLimits.get(key);
    if (!record || now - record.windowStart > config.windowMs) {
      record = { count: 0, windowStart: now };
    }
    
    record.count++;
    apiKeyLimits.set(key, record);
    
    // Set rate limit headers
    const remaining = Math.max(0, config.max - record.count);
    const reset = Math.ceil((record.windowStart + config.windowMs - now) / 1000);
    
    res.setHeader('X-RateLimit-Limit', config.max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', reset);
    
    if (record.count > config.max) {
      res.setHeader('Retry-After', reset);
      return res.status(429).json({
        error: 'Rate limit exceeded',
        code: 'RATE_LIMIT_EXCEEDED',
        limit: config.max,
        windowMs: config.windowMs,
        retryAfter: reset,
        type: type
      });
    }
    
    next();
  };
};

// Cleanup old rate limit records every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of apiKeyLimits.entries()) {
    if (now - record.windowStart > 300000) { // 5 minutes
      apiKeyLimits.delete(key);
    }
  }
}, 300000);

// Apply HTML page rate limiter to GET routes
app.use('/', (req, res, next) => {
  // Only apply to HTML pages (GET requests to non-API routes)
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return htmlPageLimiter(req, res, next);
  }
  next();
});

// Apply rate limiters to specific API endpoints
// Signed board posts: a generous, dedicated bucket instead of the tight
// generic one apiReadLimiter's skip (above) now bypasses for this path.
app.use('/api/post', boardPostLimiter);
// Tight dedicated bucket for the witness endpoint's outbound-fetch relay risk,
// applied before the generic /api limiter below so it takes precedence.
app.use('/api/witness', witnessLimiter);
// Cap passwordless-login POSTs so the endpoint can't email-bomb a third party.
app.use('/drift/login', driftAuthLimiter);

// Apply read limiter to all other API endpoints
app.use('/api', apiReadLimiter);

// Apply API key-based rate limiting (in addition to IP-based)
// Write operations (POST, PUT, PATCH, DELETE)
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return apiKeyRateLimiter('write')(req, res, next);
  }
  return apiKeyRateLimiter('read')(req, res, next);
});

// Mount the live board (TheBotique). Form bodies are parsed only under /drift,
// so the rest of the app keeps exactly the body-parsing behaviour it had.
try {
  // Body parsers follow the routes. The API moved from /sigil/api to /api
  // when the board became the site rather than a section of it; leaving the
  // parser on the old prefix would have left every POST endpoint -- register,
  // post, witness -- receiving an undefined body. /gate is retired.
  //
  // /tamper and /verify take their input as query parameters (their forms are
  // method=get), so they need no parser.
  app.use('/drift', express.urlencoded({ extended: false, limit: '16kb' }));
  // /api and /mcp are parsed by the global 64kb express.json above; no
  // per-path mount is needed and a second one would be dead (the body is
  // already consumed by the time the request reaches it).
  app.use(require('./drift/routes').mount(db));
  app.use(require('./drift/account-routes').mount(db));
} catch (error) {
  logger.warn('Drift routes not mounted', { error: error.message });
}

// The retired agent marketplace (jobs / agents / webhooks / trust) has been
// removed entirely: unmounted first, then deleted along with ~1,500 lines of
// dead endpoints and its dead modules. The live product is the signed board.

// Health
app.get('/health', async (req, res) => {
  try {
    // Test DB connection
    await db.query('SELECT 1');

    const uptime = stats.getStats().uptime;

    // What this reports is the platform that is actually running. It used to
    // describe the retired agent marketplace -- an agent name, a service
    // count, a model -- none of which this site does any more.
    //
    // `commit` is the point of it. A green deploy status says the platform
    // accepted a build; it does not say the running process is the code you
    // pushed. Comparing this against the SHA you deployed does.
    const posts = (await db.query('SELECT count(*)::int n FROM board_posts')).rows[0];
    const cp = (await db.query(
      'SELECT tree_size, created_at FROM board_checkpoints ORDER BY id DESC LIMIT 1'
    )).rows[0];

    res.json({
      status: 'healthy',
      commit: process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
      // Which instance this is, not just which build. Two processes pointed
      // at different databases otherwise report identically here.
      site: process.env.SIGIL_SITE || 'https://www.thebotique.ai',
      uptime: `${uptime.hours}h ${uptime.minutes % 60}m ${uptime.seconds % 60}s`,
      database: 'connected',
      log: {
        posts: posts ? posts.n : 0,
        treeSize: cp ? cp.tree_size : 0,
        // Same two numbers as posts/treeSize above, named so the gap between
        // them is unmissable rather than something you have to already know
        // to go looking for: checkpointing runs on its own cadence (see
        // board/schedule.js), so tree_size can run ahead of
        // checkpoint_tree_size for a while after a burst of posts. Kept
        // alongside the older field names rather than replacing them, so
        // nothing already reading this response breaks.
        tree_size: posts ? posts.n : 0,
        checkpoint_tree_size: cp ? cp.tree_size : 0,
        lastCheckpoint: cp ? cp.created_at : null,
        origin: require('./board/store').ORIGIN,
        signed: Boolean(process.env.SIGIL_LOG_KEY)
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Health check database connection failed', { error: error.message });
    res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Readiness check (for Railway health checks)
app.get('/ready', async (req, res) => {
  try {
    // Test database connection
    await db.query('SELECT 1');
    res.json({ ready: true, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('Readiness check failed', { error: error.message });
    res.status(503).json({
      ready: false,
      error: 'Database connection failed',
      timestamp: new Date().toISOString()
    });
  }
});

// A2A Health Check endpoint (standard path for agent-to-agent communication)
// Returns platform status, version, and capabilities for agent discovery
app.get('/api/health', async (req, res) => {
  try {
    // Test DB connection
    await db.query('SELECT 1');
    const uptime = stats.getStats().uptime;
    
    res.json({
      status: 'ok',
      version: '1.0.0',
      platform: 'thebotique',
      timestamp: new Date().toISOString(),
      uptime: `${uptime.hours}h ${uptime.minutes % 60}m ${uptime.seconds % 60}s`,
      capabilities: {
        a2a: true,
        webhooks: true,
        api_key_auth: true
      },
      endpoints: {
        agents: '/api/agents',
        search: '/api/agents/search',
        jobs: '/api/jobs',
        webhooks: '/api/webhooks'
      },
      rateLimits: {
        reads: '100/min',
        writes: '20/min',
        jobCreation: '10/min'
      }
    });
  } catch (error) {
    logger.error('API Health check failed', { error: error.message });
    res.status(503).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// A2A Status endpoint (alias)
app.get('/api/status', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({ status: 'error', timestamp: new Date().toISOString() });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  // Body-parser errors carry a real HTTP status (400 malformed JSON, 413 too
  // large) and forcing them all to 500 mislabels a client mistake as a server
  // fault and leaks the parser's message. Honour err.status, and for /mcp speak
  // JSON-RPC so a protocol client gets a code it can act on rather than a bare
  // HTML-shaped 500.
  const status = Number.isInteger(err.status) ? err.status : 500;
  const parseError = err.type === 'entity.parse.failed';
  const tooLarge = err.type === 'entity.too.large';
  if (req.path === '/mcp') {
    res.set('MCP-Protocol-Version', '2026-07-28');
    const code = parseError ? -32700 : (status >= 400 && status < 500 ? -32600 : -32603);
    const message = parseError ? 'Parse error' : tooLarge ? 'Request too large' : 'Invalid Request';
    return res.status(status).json({ jsonrpc: '2.0', id: null, error: { code, message } });
  }
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : 'Request error',
    message: process.env.NODE_ENV === 'production' && status >= 500 ? 'An error occurred' : err.message
  });
});

// Track server instance for graceful shutdown
let server;

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, starting graceful shutdown`);

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
    });
  }

  // Close database pool
  try {
    await db.closePool();
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
  }

  logger.info('Graceful shutdown complete');
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  gracefulShutdown('uncaughtException').then(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
  gracefulShutdown('unhandledRejection').then(() => process.exit(1));
});

// Start server
async function start() {
  // Validate required environment variables with helpful messages.
  // Only DATABASE_URL is hard-required: without it the process cannot serve
  // a single page. Every other integration constructs its client lazily and
  // fails at call time, not import time, so a missing key degrades one
  // feature instead of taking the whole site down.
  const required = {
    DATABASE_URL: 'PostgreSQL connection string (e.g., postgresql://user:pass@host:5432/db)'
  };

  // Feature keys. Absent => that feature is disabled, site still serves.
  const featureKeys = {
    ANTHROPIC_API_KEY: 'Claude text generation for paid jobs',
    ALCHEMY_API_KEY: 'Base L2 RPC for USDC payment verification',
    REPLICATE_API_TOKEN: 'Replicate image generation',
    OPENAI_API_KEY: 'Embeddings for semantic agent search (falls back to text match)'
  };
  for (const [key, feature] of Object.entries(featureKeys)) {
    if (!process.env[key]) logger.warn(`${key} not set - disabled: ${feature}`);
  }

  const errors = [];
  for (const [key, description] of Object.entries(required)) {
    if (!process.env[key]) {
      errors.push(`  ✗ ${key}: ${description}`);
    }
  }

  if (errors.length > 0) {
    logger.error('Missing required environment variables:');
    errors.forEach(err => logger.error(err));
    logger.error('Please check your .env file. See .env.example for reference.');
    process.exit(1);
  }

  // Check optional environment variables
  const optional = {
    PORT: process.env.PORT || 7378,
    NODE_ENV: process.env.NODE_ENV || 'development',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info'
  };

  logger.info('Environment configuration', optional);

  try {
    await db.initDB();

    // Test database connection
    try {
      await db.query('SELECT 1');
      logger.info('Database connection verified');
    } catch (error) {
      logger.error('Database connection test failed', { error: error.message });
      throw error;
    }

    // Verify AI service key format
    if (ANTHROPIC_API_KEY && !ANTHROPIC_API_KEY.startsWith('sk-ant-')) {
      logger.warn('ANTHROPIC_API_KEY format unexpected (should start with sk-ant-)');
    }

    // Verify Replicate token format (if provided)
    if (process.env.REPLICATE_API_TOKEN && !process.env.REPLICATE_API_TOKEN.startsWith('r8_')) {
      logger.warn('REPLICATE_API_TOKEN format unexpected (should start with r8_)');
    }

    // Supply-chain snapshot collector. Runs at most once a day, guarded by a
    // DB timestamp so redeploys cannot double-run it. Errors are logged and
    // swallowed inside the scheduler -- a failed crawl must never take the
    // site down. Disable with COLLECTOR_ENABLED=false.
    try {
      require('./collector/schedule').start({ db, logger });
      logger.info('Snapshot collector scheduled');
    } catch (error) {
      logger.warn('Collector not scheduled', { error: error.message });
    }

    // TheBotique tables. Separate from initDB so the marketplace schema and
    // this one cannot entangle.
    //
    // The snapshot table is created here as well as by the collector: the
    // watchlist queries it, and the collector's first run is two minutes
    // after boot, so without this the account pages 500 on a fresh
    // database. Both statements are CREATE TABLE IF NOT EXISTS.
    try {
      const fs = require('fs');
      await db.query(fs.readFileSync(require('path').join(__dirname, 'collector/schema.sql'), 'utf8'));
      await require('./board/store').init(db);
      require('./board/schedule').start(db, logger);
      await require('./drift/auth').init(db);
      const a = require('./drift/auth');
      const m = require('./drift/mail');
      if (!a.sessionsAvailable()) {
        logger.warn('SESSION_SECRET not set - sign-in disabled (sessions would be forgeable)');
      }
      if (!m.configured()) {
        logger.warn('RESEND_API_KEY not set - disabled: outbound email for sign-in links and alerts');
      }
    } catch (error) {
      logger.warn('Drift account tables not initialised', { error: error.message });
    }

    server = app.listen(PORT, () => {
      logger.info('Agent Economy Hub started', {
        version: '0.9.0',
        port: PORT,
        ai: 'claude-sonnet-4',
        hasAnthropicKey: !!ANTHROPIC_API_KEY,
        hasDatabaseUrl: !!process.env.DATABASE_URL,
        hasAlchemyKey: !!process.env.ALCHEMY_API_KEY,
        hasReplicateToken: !!process.env.REPLICATE_API_TOKEN
      });
    });
  } catch (error) {
    logger.error('Failed to start server', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

start();
// Deployed at 2026-02-06T01:50:22Z
