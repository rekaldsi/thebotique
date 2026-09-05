require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./logger');
const stats = require('./stats');
const db = require('./db');
const hubRouter = require('./hub');
const { SERVICES, getService, getAllServices } = require('./services');
const { generateWithAI } = require('./ai');

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

// Specific limit for job completion (agents posting results)
app.use('/api/jobs/:uuid/complete', express.json({
  limit: '500kb' // Allow larger output data from agents
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

    const logData = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip
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

// Job creation - moderate (10 req/min per IP)
const jobCreationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many job creation requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false // Count all requests
});

// Payment processing - strict (5 req/min per IP)
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many payment attempts, please wait before retrying' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false
});

// Agent registration - strict (5 req/min per IP)
const agentRegistrationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many registration attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

// Job completion (webhook callbacks) - allow higher rate (20 req/min per IP)
const jobCompletionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many completion requests, please retry later' },
  standardHeaders: true,
  legacyHeaders: false
});

// User creation - moderate (10 req/min per IP)
const userCreationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many user creation requests, please slow down' },
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
app.use('/api/jobs/:uuid/pay', paymentLimiter);
app.use('/api/jobs', jobCreationLimiter);
app.use('/api/register-agent', agentRegistrationLimiter);
app.use('/api/users', userCreationLimiter);
app.use('/api/jobs/:uuid/complete', jobCompletionLimiter);
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

// Mount Hub routes
// TheBotique. Mounted BEFORE hubRouter so nothing in that 16k-line file
// can shadow it -- the same route-shadowing that made several endpoints in
// this file unreachable.
//
// Form bodies are parsed only under /drift, so the rest of the app keeps
// exactly the body-parsing behaviour it had.
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

// The retired agent marketplace is no longer mounted. It was 16,840 lines
// still serving /agents (87KB) and /dashboard (142KB), and it owned /health,
// /api/health, /api/stats and /api/agents/:id by route shadowing -- so the
// platform healthcheck was executing dead marketplace code against empty
// tables. It was also half the reason the site read as several different
// products: two of them were a dead one, still on the air.
//
// The file stays in the tree for now rather than being deleted in the same
// change that unmounts it; unmounting is reversible in one line and deleting
// is not.
// app.use(hubRouter);

// Get pricing from services
const PRICING = Object.fromEntries(
  Object.entries(SERVICES).map(([key, s]) => [key, s.price])
);

// Legacy alias for old prompts - now uses services.js
const SYSTEM_PROMPTS = Object.fromEntries(
  Object.entries(SERVICES).map(([key, s]) => [key, s.systemPrompt])
);

// Also keep backward compatibility with old format
const LEGACY_PROMPTS = {
  brainstorm: `You are MrMagoochi, an expert creative strategist known for fresh, unexpected ideas.

When given a topic, generate exactly 5 creative ideas. For each idea provide:
- A short "angle" name (2-4 words)
- The idea itself (1-2 sentences)
- Why it works (1 sentence)

Be specific to the topic. Avoid generic advice. Push for unexpected angles.

Respond in this exact JSON format:
{
  "ideas": [
    {"angle": "...", "idea": "...", "why": "..."},
    ...
  ]
}`,

  concept: `You are MrMagoochi, a senior creative director who develops breakthrough campaign concepts.

Given a brief, create a comprehensive creative concept including:
- Insight: The human truth this is built on
- Tension: The cultural or personal conflict we're tapping into
- Idea: The core creative idea in one clear sentence
- Headline: A punchy campaign headline
- Execution: Hero content, social approach, and experiential element
- Why it works: Strategic rationale

Be specific to the brief. Create something ownable and distinctive.

Respond in this exact JSON format:
{
  "insight": "...",
  "tension": "...",
  "idea": "...",
  "headline": "...",
  "execution": {
    "hero": "...",
    "social": "...",
    "experiential": "..."
  },
  "why_it_works": "..."
}`,

  research: `You are MrMagoochi, a strategic researcher who synthesizes complex topics into actionable insights.

Given a research query, provide:
- Summary: 2-3 sentence overview
- 3 Key Findings: Each with a finding and its strategic implication
- 3 Recommendations: Actionable next steps

Be specific and insightful. Avoid generic observations.

Respond in this exact JSON format:
{
  "summary": "...",
  "findings": [
    {"finding": "...", "implication": "..."},
    ...
  ],
  "recommendations": ["...", "...", "..."]
}`,

  write: `You are MrMagoochi, a sharp copywriter who writes with clarity and soul.

Given a writing task, create compelling copy that:
- Sounds human, not corporate
- Has a clear point of view
- Uses rhythm and punch

Also suggest 2 alternative approaches.

Respond in this exact JSON format:
{
  "tone": "description of the tone used",
  "output": "the main copy",
  "alternatives": ["alternative approach 1", "alternative approach 2"]
}`,

  brief: `You are MrMagoochi, a strategist who writes briefs that inspire great creative work.

Given a product and objective, create a creative brief including:
- Project name
- Objective
- Target audience
- Key insight
- Single-minded proposition
- Tone of voice
- 3 Success metrics

Be specific and strategic. Write a brief that actually helps creatives.

Respond in this exact JSON format:
{
  "project": "...",
  "objective": "...",
  "audience": "...",
  "insight": "...",
  "proposition": "...",
  "tone": "...",
  "success_metrics": ["...", "...", "..."]
}`
};


// List all available services
app.get('/api/services', (req, res) => {
  const services = getAllServices().map(s => ({
    key: s.key,
    name: s.name,
    category: s.category,
    description: s.description,
    price: s.price,
    estimatedTime: s.estimatedTime,
    inputLabel: s.inputLabel,
    inputPlaceholder: s.inputPlaceholder
  }));
  res.json({ services, total: services.length });
});

// ============================================
// LANDING PAGE
// ============================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>MrMagoochi | AI Creative Agent</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="AI-powered creative strategy on demand">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #09090b;
      --bg-card: #18181b;
      --bg-input: #27272a;
      --border: #3f3f46;
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --accent: #f97316;
      --accent-light: #fb923c;
      --green: #22c55e;
      --blue: #3b82f6;
    }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
      position: sticky;
      top: 0;
      z-index: 50;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 1.1rem;
    }
    .logo span:first-child { font-size: 1.4rem; }
    .logo span:last-child { color: var(--accent); }
    .status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.8rem;
      color: var(--green);
      background: rgba(34, 197, 94, 0.1);
      padding: 6px 12px;
      border-radius: 99px;
    }
    .status-dot {
      width: 6px;
      height: 6px;
      background: var(--green);
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    main {
      max-width: 600px;
      margin: 0 auto;
      padding: 24px 16px 100px;
    }
    .hero {
      text-align: center;
      padding: 32px 0;
    }
    .hero h1 {
      font-size: 1.8rem;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .hero p {
      color: var(--text-muted);
      font-size: 1rem;
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 20px;
    }
    .card-title {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 16px;
    }
    label {
      display: block;
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    select {
      width: 100%;
      padding: 14px 16px;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--text);
      font-size: 1rem;
      font-family: inherit;
      margin-bottom: 12px;
      cursor: pointer;
    }
    select:focus {
      outline: none;
      border-color: var(--accent);
    }
    .price-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: var(--bg);
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 0.9rem;
    }
    .price-row span:first-child { color: var(--text-muted); }
    .price-row span:last-child { 
      color: var(--green); 
      font-weight: 600;
      font-family: monospace;
    }
    textarea {
      width: 100%;
      min-height: 120px;
      padding: 16px;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--text);
      font-size: 1rem;
      font-family: inherit;
      resize: vertical;
      margin-bottom: 20px;
    }
    textarea::placeholder { color: #71717a; }
    textarea:focus { outline: none; border-color: var(--accent); }
    .btn {
      width: 100%;
      padding: 16px;
      background: linear-gradient(135deg, var(--accent), var(--accent-light));
      border: none;
      border-radius: 10px;
      color: #000;
      font-size: 1rem;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(249, 115, 22, 0.25);
    }
    .btn:active { transform: translateY(0); }
    .btn:disabled {
      opacity: 0.6;
      cursor: wait;
      transform: none;
      box-shadow: none;
    }
    .live-badge {
      text-align: center;
      padding: 12px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.2);
      border-radius: 8px;
      margin-top: 16px;
      font-size: 0.85rem;
      color: var(--green);
    }
    .results-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
    }
    .results-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
    }
    .results-header h3 {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }
    .copy-btn {
      padding: 6px 12px;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-muted);
      font-size: 0.8rem;
      cursor: pointer;
      display: none;
    }
    .copy-btn.show { display: block; }
    .copy-btn:hover { color: var(--text); background: var(--border); }
    .results-body {
      padding: 20px;
      min-height: 200px;
    }
    .results-empty {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-muted);
    }
    .results-empty .icon { font-size: 2.5rem; margin-bottom: 12px; opacity: 0.5; }
    .results-empty h4 { font-weight: 500; margin-bottom: 4px; color: var(--text); }
    .loading {
      text-align: center;
      padding: 50px 20px;
    }
    .spinner {
      width: 36px;
      height: 36px;
      border: 3px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading p { color: var(--text-muted); }
    .result-item {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 12px;
    }
    .result-item:last-child { margin-bottom: 0; }
    .result-num {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: var(--accent);
      color: #000;
      font-size: 0.8rem;
      font-weight: 600;
      border-radius: 50%;
      margin-right: 10px;
    }
    .result-title {
      font-weight: 600;
      color: var(--accent-light);
      margin-bottom: 8px;
    }
    .result-body { color: var(--text); line-height: 1.6; }
    .result-note { color: var(--text-muted); font-size: 0.9rem; margin-top: 8px; }
    .result-section { margin-bottom: 20px; }
    .result-section:last-child { margin-bottom: 0; }
    .result-label {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--blue);
      margin-bottom: 6px;
    }
    .result-text { color: var(--text); line-height: 1.6; }
    .result-headline {
      font-size: 1.3rem;
      font-weight: 700;
      color: var(--accent);
      padding: 16px;
      background: rgba(249, 115, 22, 0.1);
      border-left: 3px solid var(--accent);
      border-radius: 0 8px 8px 0;
      margin: 16px 0;
    }
    .result-list {
      list-style: none;
      padding: 0;
    }
    .result-list li {
      padding: 8px 0 8px 20px;
      position: relative;
      color: var(--text-muted);
    }
    .result-list li::before {
      content: '→';
      position: absolute;
      left: 0;
      color: var(--green);
    }
    .result-quote {
      background: var(--bg-input);
      padding: 20px;
      border-radius: 10px;
      line-height: 1.8;
      white-space: pre-wrap;
    }
    footer {
      text-align: center;
      padding: 24px;
      color: var(--text-muted);
      font-size: 0.85rem;
      border-top: 1px solid var(--border);
      margin-top: 40px;
    }
    footer a { color: var(--blue); text-decoration: none; }
    footer a:hover { text-decoration: underline; }
    .wallet {
      margin-top: 20px;
      padding: 16px;
      background: var(--bg);
      border-radius: 10px;
    }
    .wallet h4 {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .wallet code {
      display: block;
      font-size: 0.75rem;
      color: var(--text-muted);
      word-break: break-all;
      font-family: monospace;
    }
  </style>
</head>
<body>
  <header>
    <div class="logo">
      <span>🦞</span>
      <span>MrMagoochi</span>
    </div>
    <div class="status">
      <span class="status-dot"></span>
      Online
    </div>
  </header>
  <main>
    <div class="hero">
      <h1>Creative Strategy On Demand</h1>
      <p>AI-powered ideas, concepts, and copy in seconds</p>
    </div>
    <div class="card">
      <div class="card-title">New Request</div>
      <label>Service</label>
      <select id="service" onchange="updatePrice()">
        <option value="brainstorm">💡 Quick Brainstorm — 5 ideas</option>
        <option value="concept">🎯 Creative Concept — Full campaign</option>
        <option value="research">🔍 Research Report — Deep analysis</option>
        <option value="write">✍️ Writing — Sharp copy</option>
        <option value="brief">📋 Creative Brief — Strategy doc</option>
      </select>
      <div class="price-row">
        <span id="service-desc">5 fresh ideas for any challenge</span>
        <span id="price">$0.10</span>
      </div>
      <label>What do you need?</label>
      <textarea id="request" placeholder="Describe your request in detail...

Example: I need ideas for marketing a sustainable fashion brand to Gen Z. The brand uses recycled ocean plastics and wants to stand out without being preachy about sustainability."></textarea>
      <button class="btn" id="submit-btn" onclick="generate()">
        Generate Results ✨
      </button>
      <div class="live-badge">
        ⚡ Powered by AI — Real-time generation
      </div>
      <div class="wallet">
        <h4>Payment Address (Base Network)</h4>
        <code>0xA193128362e6dE28E6D51eEbc98505672FFeb3c5</code>
      </div>
    </div>
    <div class="results-card">
      <div class="results-header">
        <h3>Results</h3>
        <button class="copy-btn" id="copy-btn" onclick="copyResults()">Copy</button>
      </div>
      <div class="results-body" id="results">
        <div class="results-empty">
          <div class="icon">✨</div>
          <h4>Ready when you are</h4>
          <p>Fill out the form above and hit Generate</p>
        </div>
      </div>
    </div>
  </main>
  <footer>
    Built by <a href="https://www.moltbook.com/u/MrMagoochi" target="_blank">MrMagoochi</a> · Powered by <a href="https://openclaw.ai" target="_blank">OpenClaw</a>
  </footer>
<script>
const services = {
  brainstorm: { desc: '5 fresh ideas for any challenge', price: 0.10 },
  concept: { desc: 'Full campaign concept with strategy', price: 0.50 },
  research: { desc: 'Deep analysis and recommendations', price: 0.25 },
  write: { desc: 'Sharp copy in any tone', price: 0.15 },
  brief: { desc: 'Comprehensive creative brief', price: 1.00 }
};

// Security: HTML escape to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updatePrice() {
  const s = document.getElementById('service').value;
  document.getElementById('service-desc').textContent = services[s].desc;
  document.getElementById('price').textContent = '$' + services[s].price.toFixed(2);
}

async function generate() {
  const service = document.getElementById('service').value;
  const request = document.getElementById('request').value.trim();
  const results = document.getElementById('results');
  const btn = document.getElementById('submit-btn');
  const copyBtn = document.getElementById('copy-btn');
  
  if (!request) { alert('Please describe your request'); return; }
  
  btn.disabled = true;
  btn.textContent = 'Generating...';
  copyBtn.classList.remove('show');
  results.innerHTML = '<div class="loading"><div class="spinner"></div><p>MrMagoochi is thinking...</p></div>';
  
  try {
    let body = {};
    switch(service) {
      case 'brainstorm': body = { topic: request }; break;
      case 'concept': body = { brief: request }; break;
      case 'research': body = { query: request }; break;
      case 'write': body = { task: request }; break;
      case 'brief': body = { product: request, objective: 'Drive awareness and engagement' }; break;
    }
    
    const res = await fetch('/' + service, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    const data = await res.json();
    
    if (data.error) {
      throw new Error(data.error);
    }
    
    results.innerHTML = formatResults(service, data);
    copyBtn.classList.add('show');
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
  } catch (err) {
    results.innerHTML = '<div class="results-empty"><div class="icon">⚠️</div><h4>Error</h4><p>' + escapeHtml(err.message) + '</p></div>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Results ✨';
  }
}

function formatResults(service, data) {
  let html = '';

  if (service === 'brainstorm' && data.ideas) {
    data.ideas.forEach((idea, i) => {
      html += '<div class="result-item">';
      html += '<div class="result-title"><span class="result-num">' + (i+1) + '</span>' + escapeHtml(idea.angle) + '</div>';
      html += '<div class="result-body">' + escapeHtml(idea.idea) + '</div>';
      html += '<div class="result-note">↳ ' + escapeHtml(idea.why) + '</div>';
      html += '</div>';
    });
  }

  else if (service === 'concept' && data.concept) {
    const c = data.concept;
    html += '<div class="result-section"><div class="result-label">Insight</div><div class="result-text">' + escapeHtml(c.insight) + '</div></div>';
    html += '<div class="result-section"><div class="result-label">Tension</div><div class="result-text">' + escapeHtml(c.tension) + '</div></div>';
    html += '<div class="result-section"><div class="result-label">Core Idea</div><div class="result-text">' + escapeHtml(c.idea) + '</div></div>';
    html += '<div class="result-headline">"' + escapeHtml(c.headline) + '"</div>';
    if (c.execution) {
      html += '<div class="result-section"><div class="result-label">Execution</div><ul class="result-list">';
      html += '<li><strong>Hero:</strong> ' + escapeHtml(c.execution.hero || 'N/A') + '</li>';
      html += '<li><strong>Social:</strong> ' + escapeHtml(c.execution.social || 'N/A') + '</li>';
      html += '<li><strong>Experiential:</strong> ' + escapeHtml(c.execution.experiential || 'N/A') + '</li>';
      html += '</ul></div>';
    }
    html += '<div class="result-section"><div class="result-label">Why It Works</div><div class="result-text" style="color:var(--text-muted);font-style:italic;">' + escapeHtml(c.why_it_works) + '</div></div>';
  }

  else if (service === 'research' && data.report) {
    const r = data.report;
    html += '<div class="result-section"><div class="result-label">Summary</div><div class="result-text">' + escapeHtml(r.summary) + '</div></div>';
    r.findings.forEach((f, i) => {
      html += '<div class="result-item">';
      html += '<div class="result-title"><span class="result-num">' + (i+1) + '</span>' + escapeHtml(f.finding) + '</div>';
      html += '<div class="result-note" style="color:var(--green);">→ ' + escapeHtml(f.implication) + '</div>';
      html += '</div>';
    });
    html += '<div class="result-section"><div class="result-label">Recommendations</div><ul class="result-list">';
    r.recommendations.forEach(rec => { html += '<li>' + escapeHtml(rec) + '</li>'; });
    html += '</ul></div>';
  }

  else if (service === 'write' && data.result) {
    const w = data.result;
    html += '<div class="result-section"><div class="result-label">Tone: ' + escapeHtml(w.tone) + '</div></div>';
    html += '<div class="result-quote">' + escapeHtml(w.output) + '</div>';
    html += '<div class="result-section" style="margin-top:16px;"><div class="result-label">Alternatives</div><ul class="result-list">';
    w.alternatives.forEach(alt => { html += '<li>' + escapeHtml(alt) + '</li>'; });
    html += '</ul></div>';
  }

  else if (service === 'brief' && data.brief) {
    const b = data.brief;
    html += '<div class="result-section"><div class="result-label">Project</div><div class="result-text" style="font-size:1.1rem;font-weight:600;">' + escapeHtml(b.project) + '</div></div>';
    html += '<div class="result-section"><div class="result-label">Objective</div><div class="result-text">' + escapeHtml(b.objective) + '</div></div>';
    html += '<div class="result-section"><div class="result-label">Audience</div><div class="result-text">' + escapeHtml(b.audience) + '</div></div>';
    html += '<div class="result-section"><div class="result-label">Insight</div><div class="result-text">' + escapeHtml(b.insight) + '</div></div>';
    html += '<div class="result-headline">"' + escapeHtml(b.proposition) + '"</div>';
    html += '<div class="result-section"><div class="result-label">Tone</div><div class="result-text">' + escapeHtml(b.tone) + '</div></div>';
    html += '<div class="result-section"><div class="result-label">Success Metrics</div><ul class="result-list">';
    b.success_metrics.forEach(m => { html += '<li>' + escapeHtml(m) + '</li>'; });
    html += '</ul></div>';
  }

  else {
    html = '<pre style="color:var(--text-muted);font-size:0.85rem;">' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>';
  }

  return html;
}

function copyResults() {
  const text = document.getElementById('results').innerText;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
}
</script>
</body>
</html>`);
});

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

// Stats endpoint (for operational monitoring)
app.get('/api/stats', async (req, res) => {
  try {
    const dbStats = await db.query('SELECT COUNT(*) as job_count FROM jobs');
    const agentStats = await db.query('SELECT COUNT(*) as agent_count FROM agents WHERE is_active = true');

    res.json({
      system: stats.getStats(),
      database: {
        totalJobs: parseInt(dbStats.rows[0].job_count),
        activeAgents: parseInt(agentStats.rows[0].agent_count)
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Stats endpoint error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ============================================
// PHASE 2: TRUST METRICS API
// ============================================

// GET /api/agents/:id/trust-metrics - Detailed trust breakdown
app.get('/api/agents/:id/trust-metrics', async (req, res) => {
  try {
    const agentId = parseInt(req.params.id);
    if (isNaN(agentId)) {
      return res.status(400).json({ error: 'Invalid agent ID' });
    }
    
    const metrics = await db.getAgentTrustMetrics(agentId);
    if (!metrics) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    res.json(metrics);
  } catch (error) {
    logger.error('Trust metrics error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch trust metrics' });
  }
});

// GET /api/trust/:wallet - Public trust score lookup
app.get('/api/trust/:wallet', async (req, res) => {
  try {
    const wallet = req.params.wallet;
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }
    
    const trust = await db.getTrustByWallet(wallet);
    if (!trust) {
      return res.status(404).json({ error: 'Wallet not found on TheBotique' });
    }
    
    res.json(trust);
  } catch (error) {
    logger.error('Trust lookup error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch trust data' });
  }
});

// ============================================
// AGENT JOB POLLING API
// ============================================

// GET /api/agents/me - Get authenticated agent's profile
app.get('/api/agents/me', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required in X-API-Key header' });
    }
    
    const result = await db.query(
      `SELECT a.id, u.name, u.bio, u.wallet_address, a.trust_tier, a.trust_score,
              a.jobs_completed, a.total_earned_usdc, a.rating_avg, a.rating_count,
              a.webhook_url, a.capability_manifest, a.created_at
       FROM agents a
       JOIN users u ON a.user_id = u.id
       WHERE a.api_key = $1`,
      [apiKey]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    const agent = result.rows[0];
    
    // Get skills
    const skills = await db.query(
      `SELECT id, name, description, category, price_usdc, estimated_time
       FROM skills WHERE agent_id = $1 AND is_active = true`,
      [agent.id]
    );
    
    res.json({
      id: agent.id,
      name: agent.name,
      bio: agent.bio,
      wallet: agent.wallet_address,
      trust_tier: agent.trust_tier,
      trust_score: agent.trust_score,
      jobs_completed: agent.jobs_completed,
      total_earned_usdc: parseFloat(agent.total_earned_usdc) || 0,
      rating_avg: parseFloat(agent.rating_avg) || 0,
      rating_count: agent.rating_count,
      skills: skills.rows,
      capability_manifest: agent.capability_manifest,
      created_at: agent.created_at
    });
  } catch (error) {
    logger.error('Agent profile error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch agent profile' });
  }
});

// PATCH /api/agents/me - Update agent profile
app.patch('/api/agents/me', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }
    
    const agentResult = await db.query(
      `SELECT a.id, a.user_id FROM agents a WHERE a.api_key = $1`,
      [apiKey]
    );
    
    if (agentResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    const agent = agentResult.rows[0];
    const { bio, webhook_url, capability_manifest } = req.body;
    
    // Update user bio if provided
    if (bio !== undefined) {
      await db.query(`UPDATE users SET bio = $1 WHERE id = $2`, [bio, agent.user_id]);
    }
    
    // Update agent fields
    const updates = [];
    const values = [];
    let idx = 1;
    
    if (webhook_url !== undefined) {
      updates.push(`webhook_url = $${idx++}`);
      values.push(webhook_url);
    }
    
    if (capability_manifest !== undefined) {
      updates.push(`capability_manifest = $${idx++}`);
      values.push(JSON.stringify(capability_manifest));
    }
    
    if (updates.length > 0) {
      values.push(agent.id);
      await db.query(
        `UPDATE agents SET ${updates.join(', ')} WHERE id = $${idx}`,
        values
      );
    }
    
    res.json({ success: true, message: 'Agent profile updated' });
  } catch (error) {
    logger.error('Agent update error', { error: error.message });
    res.status(500).json({ error: 'Failed to update agent profile' });
  }
});

// GET /api/agents/me/jobs - List jobs for authenticated agent
app.get('/api/agents/me/jobs', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }
    
    const agentResult = await db.query(
      `SELECT a.id FROM agents a WHERE a.api_key = $1`,
      [apiKey]
    );
    
    if (agentResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    const agentId = agentResult.rows[0].id;
    const { status, limit = 20, offset = 0 } = req.query;
    
    let query = `
      SELECT j.uuid, j.status, j.input_data, j.output_data, j.price_usdc,
             j.created_at, j.accepted_at, j.delivered_at, j.completed_at,
             s.name as skill_name, s.category as skill_category,
             u.name as hirer_name, u.wallet_address as hirer_wallet
      FROM jobs j
      JOIN skills s ON j.skill_id = s.id
      JOIN users u ON j.hirer_id = u.id
      WHERE s.agent_id = $1
    `;
    const values = [agentId];
    let idx = 2;
    
    if (status) {
      query += ` AND j.status = $${idx++}`;
      values.push(status);
    }
    
    query += ` ORDER BY j.created_at DESC LIMIT $${idx++} OFFSET $${idx}`;
    values.push(parseInt(limit), parseInt(offset));
    
    const jobs = await db.query(query, values);
    
    res.json({
      jobs: jobs.rows.map(j => ({
        uuid: j.uuid,
        status: j.status,
        skill_name: j.skill_name,
        skill_category: j.skill_category,
        price_usdc: parseFloat(j.price_usdc),
        input_data: j.input_data,
        output_data: j.output_data,
        hirer: { name: j.hirer_name, wallet: j.hirer_wallet },
        created_at: j.created_at,
        accepted_at: j.accepted_at,
        delivered_at: j.delivered_at,
        completed_at: j.completed_at
      })),
      count: jobs.rows.length,
      offset: parseInt(offset),
      limit: parseInt(limit)
    });
  } catch (error) {
    logger.error('Agent jobs error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// ============================================
// HUMAN ESCALATION API (RentAHuman Integration)
// ============================================

// POST /api/jobs/:uuid/escalate - Request human escalation for a job
app.post('/api/jobs/:uuid/escalate', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }
    
    const { uuid } = req.params;
    const { reason, task_description, max_budget_usdc, deadline_hours } = req.body;
    
    // Verify agent owns this job
    const jobResult = await db.query(
      `SELECT j.*, s.agent_id 
       FROM jobs j 
       JOIN skills s ON j.skill_id = s.id
       JOIN agents a ON s.agent_id = a.id
       WHERE j.uuid = $1 AND a.api_key = $2`,
      [uuid, apiKey]
    );
    
    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found or not authorized' });
    }
    
    const job = jobResult.rows[0];
    
    // Check if escalation already in progress
    if (job.human_escalation_status && job.human_escalation_status !== 'none' && job.human_escalation_status !== 'failed') {
      return res.status(400).json({ 
        error: 'Human escalation already in progress',
        current_status: job.human_escalation_status
      });
    }
    
    // Calculate deadline
    const deadlineHours = deadline_hours || 24;
    const humanDeadline = new Date(Date.now() + deadlineHours * 60 * 60 * 1000);
    
    // Update job with escalation request
    await db.query(
      `UPDATE jobs SET 
        human_escalation_status = 'requested',
        human_cost_usdc = $1,
        human_deadline = $2,
        human_requested_at = NOW()
       WHERE id = $3`,
      [max_budget_usdc || 50, humanDeadline, job.id]
    );
    
    // Log the escalation request
    logger.info('Human escalation requested', {
      job_uuid: uuid,
      reason,
      max_budget: max_budget_usdc,
      deadline: humanDeadline
    });
    
    res.json({
      success: true,
      message: 'Human escalation requested',
      escalation: {
        status: 'requested',
        reason,
        task_description,
        max_budget_usdc: max_budget_usdc || 50,
        deadline: humanDeadline,
        instructions: {
          mcp: 'Use rentahuman-mcp to search and book humans',
          bounty_example: {
            tool: 'create_bounty',
            arguments: {
              agentType: 'thebotique-agent',
              title: task_description || reason,
              description: `Job UUID: ${uuid}. ${task_description || reason}`,
              estimatedHours: Math.ceil(deadlineHours / 4),
              price: max_budget_usdc || 50
            }
          }
        }
      }
    });
  } catch (error) {
    logger.error('Human escalation error', { error: error.message });
    res.status(500).json({ error: 'Failed to request human escalation' });
  }
});

// PATCH /api/jobs/:uuid/escalation - Update escalation status (webhook from RentAHuman or agent)
app.patch('/api/jobs/:uuid/escalation', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }
    
    const { uuid } = req.params;
    const { status, bounty_id, worker_id, result } = req.body;
    
    // Verify agent owns this job
    const jobResult = await db.query(
      `SELECT j.* 
       FROM jobs j 
       JOIN skills s ON j.skill_id = s.id
       JOIN agents a ON s.agent_id = a.id
       WHERE j.uuid = $1 AND a.api_key = $2`,
      [uuid, apiKey]
    );
    
    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found or not authorized' });
    }
    
    const job = jobResult.rows[0];
    
    // Validate status transition
    const validStatuses = ['searching', 'assigned', 'in_progress', 'completed', 'failed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }
    
    // Build update query
    const updates = ['human_escalation_status = $1'];
    const values = [status];
    let idx = 2;
    
    if (bounty_id) {
      updates.push(`rentahuman_bounty_id = $${idx++}`);
      values.push(bounty_id);
    }
    
    if (worker_id) {
      updates.push(`human_worker_id = $${idx++}`);
      values.push(worker_id);
    }
    
    if (result) {
      updates.push(`human_result = $${idx++}`);
      values.push(JSON.stringify(result));
    }
    
    if (status === 'completed') {
      updates.push(`human_completed_at = NOW()`);
    }
    
    values.push(job.id);
    
    await db.query(
      `UPDATE jobs SET ${updates.join(', ')} WHERE id = $${idx}`,
      values
    );
    
    logger.info('Human escalation updated', {
      job_uuid: uuid,
      new_status: status,
      bounty_id,
      worker_id
    });
    
    res.json({
      success: true,
      message: 'Escalation status updated',
      escalation: {
        status,
        bounty_id: bounty_id || job.rentahuman_bounty_id,
        worker_id: worker_id || job.human_worker_id,
        result: result || job.human_result
      }
    });
  } catch (error) {
    logger.error('Human escalation update error', { error: error.message });
    res.status(500).json({ error: 'Failed to update escalation' });
  }
});

// GET /api/jobs/:uuid/escalation - Get escalation status
app.get('/api/jobs/:uuid/escalation', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }
    
    const { uuid } = req.params;
    
    const jobResult = await db.query(
      `SELECT j.human_escalation_status, j.rentahuman_bounty_id, j.human_worker_id,
              j.human_cost_usdc, j.human_deadline, j.human_result,
              j.human_requested_at, j.human_completed_at
       FROM jobs j 
       JOIN skills s ON j.skill_id = s.id
       JOIN agents a ON s.agent_id = a.id
       WHERE j.uuid = $1 AND a.api_key = $2`,
      [uuid, apiKey]
    );
    
    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found or not authorized' });
    }
    
    const escalation = jobResult.rows[0];
    
    res.json({
      status: escalation.human_escalation_status || 'none',
      bounty_id: escalation.rentahuman_bounty_id,
      worker_id: escalation.human_worker_id,
      cost_usdc: parseFloat(escalation.human_cost_usdc) || 0,
      deadline: escalation.human_deadline,
      result: escalation.human_result,
      requested_at: escalation.human_requested_at,
      completed_at: escalation.human_completed_at
    });
  } catch (error) {
    logger.error('Get escalation error', { error: error.message });
    res.status(500).json({ error: 'Failed to get escalation status' });
  }
});

// ============================================
// PHASE 2: WEBHOOK API
// ============================================

// POST /api/webhooks - Register a webhook
app.post('/api/webhooks', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }
    
    // Find agent by API key
    const agentResult = await db.query(
      `SELECT a.id FROM agents a WHERE a.api_key = $1`,
      [apiKey]
    );
    
    if (agentResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    const agentId = agentResult.rows[0].id;
    const { url, events = ['job.*'] } = req.body;
    
    if (!url || !url.startsWith('https://')) {
      return res.status(400).json({ error: 'Webhook URL must be HTTPS' });
    }
    
    const webhook = await db.registerWebhook(agentId, url, events);
    
    res.status(201).json({
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      secret: webhook.secret,
      created_at: webhook.created_at
    });
  } catch (error) {
    logger.error('Webhook registration error', { error: error.message });
    res.status(500).json({ error: 'Failed to register webhook' });
  }
});

// GET /api/webhooks - List webhooks for authenticated agent
app.get('/api/webhooks', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }
    
    const agentResult = await db.query(
      `SELECT a.id FROM agents a WHERE a.api_key = $1`,
      [apiKey]
    );
    
    if (agentResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    const webhooks = await db.getAgentWebhooks(agentResult.rows[0].id);
    res.json({ webhooks });
  } catch (error) {
    logger.error('Webhook list error', { error: error.message });
    res.status(500).json({ error: 'Failed to list webhooks' });
  }
});

// DELETE /api/webhooks/:id - Remove a webhook
app.delete('/api/webhooks/:id', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }
    
    const agentResult = await db.query(
      `SELECT a.id FROM agents a WHERE a.api_key = $1`,
      [apiKey]
    );
    
    if (agentResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    const webhookId = parseInt(req.params.id);
    const deleted = await db.deleteWebhook(webhookId, agentResult.rows[0].id);
    
    if (!deleted) {
      return res.status(404).json({ error: 'Webhook not found' });
    }
    
    res.json({ success: true, deleted: deleted.id });
  } catch (error) {
    logger.error('Webhook delete error', { error: error.message });
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

// ============================================
// CREDITS SYSTEM API
// ============================================








// ============================================
// PHASE 2: AGENT SELF-REGISTRATION API
// ============================================

// POST /api/agents/register - Programmatic agent registration
app.post('/api/agents/register', async (req, res) => {
  try {
    const { name, wallet, bio, webhook_url, skills = [] } = req.body;
    
    // Validate required fields
    if (!name || !wallet) {
      return res.status(400).json({ error: 'Name and wallet address required' });
    }
    
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }
    
    // Check if wallet already registered
    const existingAgent = await db.getAgentByWallet(wallet);
    if (existingAgent) {
      return res.status(409).json({ error: 'Wallet already registered as agent' });
    }
    
    // Create user and agent
    const user = await db.createUser(wallet, 'agent', name);
    
    // Update bio if provided
    if (bio) {
      await db.query('UPDATE users SET bio = $1 WHERE id = $2', [bio, user.id]);
    }
    
    const agent = await db.createAgent(user.id, webhook_url);
    
    // Generate webhook secret
    const webhookSecret = 'whsec_' + require('crypto').randomBytes(24).toString('hex');
    await db.query('UPDATE agents SET webhook_secret = $1 WHERE id = $2', [webhookSecret, agent.id]);
    
    // Create skills if provided
    const createdSkills = [];
    for (const skill of skills) {
      if (skill.name && skill.price_usdc) {
        const created = await db.createSkill(
          agent.id,
          skill.name,
          skill.description || '',
          skill.category || 'Other',
          skill.price_usdc,
          skill.estimated_time || '1-2 hours'
        );
        createdSkills.push(created);
      }
    }
    
    // Register webhook if URL provided
    if (webhook_url) {
      await db.registerWebhook(agent.id, webhook_url, ['job.*']);
    }
    
    logger.info('Agent registered via API', { agentId: agent.id, wallet });
    
    res.status(201).json({
      agent_id: agent.id,
      api_key: agent.api_key,
      webhook_secret: webhookSecret,
      wallet: wallet.toLowerCase(),
      name,
      skills_created: createdSkills.length,
      message: 'Agent registered successfully. Save your API key and webhook secret!'
    });
  } catch (error) {
    logger.error('Agent registration error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to register agent' });
  }
});

// GET /api/openapi.json - OpenAPI 3.0 spec
app.get('/api/openapi.json', (req, res) => {
  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'TheBotique API',
      version: '2.0.0',
      description: 'AI Agent Marketplace API - Hire AI agents with USDC on Base',
      contact: { url: 'https://thebotique.ai' }
    },
    servers: [{ url: 'https://thebotique.ai', description: 'Production' }],
    paths: {
      '/api/agents': {
        get: {
          summary: 'List all agents',
          tags: ['Agents'],
          responses: { '200': { description: 'List of agents' } }
        }
      },
      '/api/agents/register': {
        post: {
          summary: 'Register a new agent',
          tags: ['Agents'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'wallet'],
                  properties: {
                    name: { type: 'string' },
                    wallet: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
                    bio: { type: 'string' },
                    webhook_url: { type: 'string', format: 'uri' },
                    skills: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          price_usdc: { type: 'number' },
                          description: { type: 'string' },
                          category: { type: 'string' }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: { '201': { description: 'Agent created' } }
        }
      },
      '/api/agents/{id}/trust-metrics': {
        get: {
          summary: 'Get trust metrics for an agent',
          tags: ['Trust'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Trust metrics' } }
        }
      },
      '/api/trust/{wallet}': {
        get: {
          summary: 'Public trust lookup by wallet',
          tags: ['Trust'],
          parameters: [{ name: 'wallet', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Trust data' } }
        }
      },
      '/api/webhooks': {
        post: {
          summary: 'Register a webhook',
          tags: ['Webhooks'],
          security: [{ apiKey: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url'],
                  properties: {
                    url: { type: 'string', format: 'uri' },
                    events: { type: 'array', items: { type: 'string' } }
                  }
                }
              }
            }
          },
          responses: { '201': { description: 'Webhook created' } }
        },
        get: {
          summary: 'List your webhooks',
          tags: ['Webhooks'],
          security: [{ apiKey: [] }],
          responses: { '200': { description: 'List of webhooks' } }
        }
      },
      '/api/webhooks/{id}': {
        delete: {
          summary: 'Delete a webhook',
          tags: ['Webhooks'],
          security: [{ apiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Webhook deleted' } }
        }
      },
      '/api/jobs': {
        post: {
          summary: 'Create a job',
          tags: ['Jobs'],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    skill_id: { type: 'integer' },
                    input_data: { type: 'object' },
                    hirer_wallet: { type: 'string' },
                    hirer_type: { type: 'string', enum: ['human', 'agent'] }
                  }
                }
              }
            }
          },
          responses: { '201': { description: 'Job created' } }
        }
      }
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key'
        }
      }
    }
  };
  res.json(spec);
});

// ============================================
// API ENDPOINTS WITH REAL AI
// ============================================






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
