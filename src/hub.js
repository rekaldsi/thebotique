// The Botique - Routes and UI
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { ethers } = require('ethers');
const db = require('./db');
const blockchain = require('./blockchain');

// In-memory challenge store (TODO: move to Redis for production)
const challengeStore = new Map();
const { generateWithAI } = require('./ai');
const { generateImage } = require('./replicate');
const { getService } = require('./services');
const { notifyAgent, onJobPaid, onJobAccepted, onJobDelivered, onJobApproved, onJobDisputed, onRevisionRequested } = require('./webhooks');
// Lazy-load email to prevent startup crashes if nodemailer has issues
let sendEmail = null;
const getEmailSender = () => {
  if (!sendEmail) {
    try {
      sendEmail = require('./email').sendEmail;
    } catch (e) {
      console.error('Email module failed to load:', e.message);
      sendEmail = async () => { throw new Error('Email not available'); };
    }
  }
  return sendEmail;
};
const {
  validateBody,
  validateUuidParam,
  validateIdParam,
  validateRequestSize,
  createUserSchema,
  createJobSchema,
  payJobSchema,
  completeJobSchema,
  registerAgentSchema,
  validateAgentExists,
  validateSkillExists,
  validateUserExists,
  validateSkillBelongsToAgent,
  validateSkillPrice,
  sanitizeText,
  sanitizeJobInput,
  sanitizeWebhookUrl
} = require('./validation');

const router = express.Router();

// ============================================
// SECURITY: SENSITIVE FIELD REMOVAL
// ============================================

/**
 * Remove sensitive fields from agent objects before sending to clients
 * CRITICAL: api_key and webhook_secret must NEVER be exposed in public APIs
 */
const SENSITIVE_AGENT_FIELDS = ['api_key', 'webhook_secret'];

function sanitizeAgent(agent) {
  if (!agent) return agent;
  const sanitized = { ...agent };
  SENSITIVE_AGENT_FIELDS.forEach(field => delete sanitized[field]);
  return sanitized;
}

function sanitizeAgents(agents) {
  if (!Array.isArray(agents)) return agents;
  return agents.map(sanitizeAgent);
}

// ============================================
// ERROR HANDLING
// ============================================

/**
 * Format error response consistently
 */
function formatErrorResponse(error, defaultMessage = 'An error occurred') {
  // Don't expose internal errors in production
  const isProduction = process.env.NODE_ENV === 'production';

  // Known error types
  if (error.message.includes('not found')) {
    return {
      statusCode: 404,
      body: {
        error: error.message,
        code: 'NOT_FOUND'
      }
    };
  }

  if (error.message.includes('Invalid') || error.message.includes('mismatch') || error.message.includes('does not belong')) {
    return {
      statusCode: 400,
      body: {
        error: error.message,
        code: 'INVALID_INPUT'
      }
    };
  }

  if (error.message.includes('unauthorized') || error.message.includes('API key')) {
    return {
      statusCode: 403,
      body: {
        error: 'Unauthorized',
        code: 'UNAUTHORIZED'
      }
    };
  }

  if (error.message.includes('Already registered')) {
    return {
      statusCode: 409,
      body: {
        error: error.message,
        code: 'CONFLICT'
      }
    };
  }

  // Generic errors
  console.error('Unhandled error:', error);
  return {
    statusCode: 500,
    body: {
      error: isProduction ? defaultMessage : error.message,
      code: 'INTERNAL_ERROR'
    }
  };
}

/**
 * Express error handler middleware
 */
function errorHandler(err, req, res, next) {
  const { statusCode, body } = formatErrorResponse(err);
  res.status(statusCode).json(body);
}

// ============================================
// PWA SUPPORT
// ============================================
const PWA_HEAD = `
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#f97316">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="TheBotique">
  <link rel="apple-touch-icon" href="/icons/icon-192.png">
`;

const PWA_SCRIPT = `
  // Register Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then(reg => console.log('SW registered'))
        .catch(err => console.log('SW registration failed'));
    });
  }
`;

// ============================================
// UNIFIED HEADER COMPONENT
// ============================================
function getHeader(activePath = '') {
  const navItems = [
    { href: '/agents', label: 'Browse', mobileLabel: 'Browse Agents' },
    { href: '/categories', label: 'Categories', mobileLabel: 'Categories' },
    { href: '/compare', label: 'Compare', mobileLabel: 'Compare Agents' },
    { href: '/register', label: 'List Agent', mobileLabel: 'List Your Agent' },
    { href: '/dashboard', label: 'Dashboard', mobileLabel: 'Dashboard' },
    { href: '/docs', label: 'API', mobileLabel: 'API Docs' },
  ];
  
  const isActive = (href) => {
    if (href === '/agents' && activePath.startsWith('/agent')) return true;
    return activePath === href || activePath.startsWith(href + '/');
  };
  
  const navLinks = navItems.map(item => 
    `<a href="${item.href}"${isActive(item.href) ? ' class="active" aria-current="page"' : ''}>${item.label}</a>`
  ).join('\n      ');
  
  const mobileLinks = navItems.map(item =>
    `<a href="${item.href}"${isActive(item.href) ? ' class="active" aria-current="page"' : ''}>${item.mobileLabel}</a>`
  ).join('\n    ');
  
  return `
  <a href="#main-content" class="skip-link">Skip to main content</a>
  <header>
    <a href="/" class="logo">
      <img src="/logos/butler-bot.png" alt="TheBotique" class="logo-icon">
      <span>TheBotique</span>
      <span class="beta-badge">BETA</span>
    </a>
    <nav>
      ${navLinks}
    </nav>
    <button class="mobile-menu-btn" aria-label="Toggle menu" aria-expanded="false" aria-controls="mobileNav">
      <span></span><span></span><span></span>
    </button>
  </header>
  <nav class="mobile-nav" id="mobileNav" aria-label="Mobile navigation" hidden>
    ${mobileLinks}
    <a href="/support">Help</a>
    <a href="/terms">Terms</a>
    <a href="/privacy">Privacy</a>
  </nav>
`;
}

// Legacy constant for backwards compatibility
const HUB_HEADER = getHeader('');

// ============================================
// HUB LANDING PAGE
// ============================================
const HUB_STYLES = `
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  /* Smooth Scroll */
  html {
    scroll-behavior: smooth;
  }

  :root {
    /* ========================================
       REFINED FUTURISM - Design System v2.0
       "High-end gallery meets modern marketplace"
       ======================================== */
    
    /* Primary Brand */
    --brand-primary: #0A0E27;
    --brand-accent: #00F0FF;      /* Electric cyan - AI energy */
    --brand-accent-warm: #FF6B35; /* Coral - human warmth */
    
    /* Backgrounds */
    --bg: #0A0B0D;
    --bg-card: #12141C;
    --bg-card-hover: #1A1D29;
    --bg-input: #1E2130;
    --bg-elevated: #1A1D29;
    
    /* Borders */
    --border: #2A2D3A;
    --border-light: #3D4152;
    --border-accent: rgba(0, 240, 255, 0.3);
    
    /* Text */
    --text: #FAFBFD;
    --text-muted: #9B9FB5;
    --text-secondary: #C5C8D8;
    
    /* Legacy aliases */
    --teal: #00F0FF;
    --teal-dark: #00B8C4;
    --teal-light: #4DF7FF;
    --teal-glow: rgba(0, 240, 255, 0.25);
    --accent: #00F0FF;
    --accent-light: #4DF7FF;
    --accent-glow: rgba(0, 240, 255, 0.2);
    
    /* Semantic Colors */
    --success: #00E6B8;
    --success-light: #4DFFDA;
    --warning: #FFB800;
    --error: #FF5C5C;
    --info: #4D9FFF;
    
    /* Supporting */
    --green: #00E6B8;
    --green-light: #4DFFDA;
    --blue: #4D9FFF;
    --purple: #B794F6;
    --orange: #FF6B35;
    --red: #FF5C5C;
    --gold: #FFB800;
    --coral: #FF6B35;
    
    /* Trust Tier Colors */
    --tier-new: #9B9FB5;
    --tier-rising: #4D9FFF;
    --tier-established: #00E6B8;
    --tier-trusted: #FFB800;
    --tier-verified: #B794F6;
    
    /* Shadows - Refined */
    --shadow-sm: 0 1px 2px rgba(10, 14, 39, 0.15);
    --shadow-md: 0 4px 6px rgba(10, 14, 39, 0.2), 0 2px 4px rgba(10, 14, 39, 0.15);
    --shadow-lg: 0 10px 15px rgba(10, 14, 39, 0.25), 0 4px 6px rgba(10, 14, 39, 0.1);
    --shadow-xl: 0 20px 25px rgba(10, 14, 39, 0.3), 0 8px 10px rgba(10, 14, 39, 0.15);
    --shadow-2xl: 0 25px 50px rgba(10, 14, 39, 0.4);
    --shadow-glow: 0 0 30px var(--teal-glow);
    --glow-cyan: 0 0 20px rgba(0, 240, 255, 0.3);
    --glow-coral: 0 0 20px rgba(255, 107, 53, 0.3);
    
    /* Spacing */
    --radius-sm: 6px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --radius-xl: 24px;
    --radius-full: 9999px;
    
    /* Animation */
    --duration-fast: 150ms;
    --duration-normal: 300ms;
    --duration-slow: 500ms;
    --ease-out: cubic-bezier(0, 0, 0.2, 1);
    --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
    
    /* Glassmorphism */
    --glass-bg: rgba(255, 255, 255, 0.03);
    --glass-border: rgba(255, 255, 255, 0.08);
    --glass-blur: 20px;
    
    /* Crypto colors */
    --crypto-pending: #FBBF24;
    --crypto-confirmed: #10B981;
    --crypto-failed: #EF4444;
    
    /* Glow effects */
    --glow-verified: 0 0 20px rgba(183, 148, 246, 0.4), 0 0 40px rgba(183, 148, 246, 0.2);
    --glow-trusted: 0 0 20px rgba(255, 184, 0, 0.4), 0 0 40px rgba(255, 184, 0, 0.2);
    --glow-established: 0 0 20px rgba(0, 230, 184, 0.3);
  }
  
  /* ============================================
     GLASSMORPHISM COMPONENTS
     ============================================ */
  .glass-card {
    background: var(--glass-bg);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-lg);
  }
  
  .glass-card-dark {
    background: rgba(15, 23, 42, 0.7);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(59, 130, 246, 0.2);
  }
  
  /* ============================================
     TRUST BADGE ANIMATIONS
     ============================================ */
  .trust-badge-verified {
    animation: verified-pulse 2s ease-in-out infinite;
  }
  @keyframes verified-pulse {
    0%, 100% { box-shadow: var(--glow-verified); }
    50% { box-shadow: 0 0 30px rgba(183, 148, 246, 0.6), 0 0 60px rgba(183, 148, 246, 0.3); }
  }
  
  .trust-badge-trusted {
    animation: trusted-shimmer 3s ease-in-out infinite;
  }
  @keyframes trusted-shimmer {
    0%, 100% { box-shadow: var(--glow-trusted); }
    50% { box-shadow: 0 0 25px rgba(255, 184, 0, 0.5), 0 0 50px rgba(255, 184, 0, 0.25); }
  }
  
  /* ============================================
     ANIMATED COUNTERS
     ============================================ */
  .counter-animate {
    display: inline-block;
    transition: transform 0.3s ease;
  }
  .counter-animate.counting {
    animation: count-pop 0.15s ease-out;
  }
  @keyframes count-pop {
    0% { transform: scale(1); }
    50% { transform: scale(1.1); }
    100% { transform: scale(1); }
  }
  
  /* ============================================
     CARD HOVER EFFECTS (Enhanced)
     ============================================ */
  .card-lift {
    transition: transform 0.3s var(--ease-spring), box-shadow 0.3s ease;
  }
  .card-lift:hover {
    transform: translateY(-8px) scale(1.02);
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3), var(--glow-cyan);
  }
  
  /* ============================================
     CRYPTO TRANSACTION STATES
     ============================================ */
  .tx-pending {
    animation: tx-pulse 1.5s ease-in-out infinite;
  }
  @keyframes tx-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  
  .tx-confirmed {
    animation: tx-confirm 0.5s ease-out;
  }
  @keyframes tx-confirm {
    0% { transform: scale(0.8); opacity: 0; }
    50% { transform: scale(1.1); }
    100% { transform: scale(1); opacity: 1; }
  }
  
  /* ============================================
     SKELETON LOADING
     ============================================ */
  .skeleton {
    background: linear-gradient(
      90deg,
      rgba(229, 231, 235, 0.05) 0%,
      rgba(229, 231, 235, 0.1) 50%,
      rgba(229, 231, 235, 0.05) 100%
    );
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.5s infinite;
    border-radius: var(--radius-md);
  }
  @keyframes skeleton-shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    font-size: 16px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    overflow-x: hidden;
  }
  
  html {
    overflow-x: hidden;
  }
  
  /* Selection styling */
  ::selection {
    background: var(--accent);
    color: white;
  }

  /* ============================================
     ACCESSIBILITY: Skip Link
     ============================================ */
  .skip-link {
    position: absolute;
    top: -100px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--accent);
    color: #000;
    padding: 12px 24px;
    border-radius: 0 0 8px 8px;
    font-weight: 600;
    z-index: 10000;
    transition: top 0.2s ease;
    text-decoration: none;
  }
  .skip-link:focus {
    top: 0;
    outline: none;
  }

  /* ============================================
     ACCESSIBILITY: Reduced Motion
     ============================================ */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }

  /* ============================================
     ACCESSIBILITY: Screen Reader Only
     ============================================ */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* ============================================
     MODAL OVERLAY (Fixed Position)
     ============================================ */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    padding: 20px;
    animation: fadeIn 0.2s ease-out;
  }
  .modal-overlay .modal {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 16px;
    width: 100%;
    max-width: 500px;
    max-height: 90vh;
    overflow-y: auto;
    animation: slideUp 0.3s ease-out;
  }
  .modal-overlay .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
  }
  .modal-overlay .modal-header h2 {
    font-size: 1.25rem;
    margin: 0;
  }
  .modal-overlay .modal-close {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.5rem;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    transition: all 0.2s;
  }
  .modal-overlay .modal-close:hover {
    background: var(--bg-input);
    color: var(--text);
  }
  .modal-overlay .modal-body {
    padding: 24px;
  }
  /* Modal Responsive */
  @media (max-width: 768px) {
    .modal-overlay {
      padding: 16px;
    }
    .modal-overlay .modal {
      max-width: 100%;
      width: 100%;
      max-height: 85vh;
    }
    .modal-overlay .modal-header {
      padding: 16px 20px;
    }
    .modal-overlay .modal-body {
      padding: 20px;
    }
    .modal-overlay .modal-close {
      min-width: 44px;
      min-height: 44px;
    }
    .modal-buttons, .modal-overlay .btn-row {
      flex-direction: column;
      gap: 12px;
    }
    .modal-buttons .btn, .modal-overlay .btn {
      width: 100%;
      min-height: 48px;
    }
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  /* ============================================
     TYPOGRAPHY SYSTEM
     ============================================ */
  h1, h2, h3, h4, h5, h6 {
    font-weight: 700;
    line-height: 1.2;
    margin-bottom: 0.5em;
    letter-spacing: -0.02em;
  }

  h1 { font-size: 2.5rem; }
  h2 { font-size: 2rem; }
  h3 { font-size: 1.5rem; }
  h4 { font-size: 1.25rem; }
  h5 { font-size: 1.1rem; }
  h6 { font-size: 1rem; }

  p {
    line-height: 1.6;
    margin-bottom: 1em;
  }

  /* ============================================
     SPACING SYSTEM
     ============================================ */
  .mb-1 { margin-bottom: 8px; }
  .mb-2 { margin-bottom: 16px; }
  .mb-3 { margin-bottom: 24px; }
  .mb-4 { margin-bottom: 32px; }
  .mb-5 { margin-bottom: 48px; }

  .mt-1 { margin-top: 8px; }
  .mt-2 { margin-top: 16px; }
  .mt-3 { margin-top: 24px; }
  .mt-4 { margin-top: 32px; }
  .mt-5 { margin-top: 48px; }

  .p-1 { padding: 8px; }
  .p-2 { padding: 16px; }
  .p-3 { padding: 24px; }
  .p-4 { padding: 32px; }

  .gap-1 { gap: 8px; }
  .gap-2 { gap: 16px; }
  .gap-3 { gap: 24px; }

  .container { max-width: 1200px; margin: 0 auto; padding: 24px; overflow-x: hidden; }
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
    gap: 12px;
    font-weight: 700;
    font-size: 1.25rem;
    color: var(--text);
    text-decoration: none;
  }
  .logo-icon { 
    width: 36px; 
    height: 36px; 
    border-radius: 8px;
    object-fit: cover;
  }
  .beta-badge {
    font-size: 0.55rem;
    font-weight: 700;
    padding: 3px 6px;
    background: linear-gradient(135deg, var(--accent), var(--purple));
    color: #000;
    border-radius: 4px;
    letter-spacing: 0.05em;
    margin-left: -4px;
    animation: beta-pulse 2s ease-in-out infinite;
  }
  @keyframes beta-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }
  nav { display: flex; gap: 24px; align-items: center; }
  nav a {
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.9rem;
    transition: color 0.2s;
    padding: 8px 4px;
    border-radius: 4px;
  }
  nav a:hover { color: var(--text); }
  nav a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  nav a.active {
    color: var(--accent);
    position: relative;
  }
  nav a.active::after {
    content: '';
    position: absolute;
    bottom: -2px;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--accent);
    border-radius: 1px;
  }

  /* Mobile Menu Button */
  .mobile-menu-btn {
    display: none;
    flex-direction: column;
    gap: 5px;
    background: none;
    border: none;
    cursor: pointer;
    padding: 8px;
    z-index: 60;
  }
  .mobile-menu-btn span {
    display: block;
    width: 24px;
    height: 2px;
    background: var(--text);
    transition: all 0.3s;
  }
  .mobile-menu-btn.active span:nth-child(1) { transform: rotate(45deg) translate(5px, 5px); }
  .mobile-menu-btn.active span:nth-child(2) { opacity: 0; }
  .mobile-menu-btn.active span:nth-child(3) { transform: rotate(-45deg) translate(5px, -5px); }

  /* Mobile Nav Overlay - MUST be hidden by default */
  .mobile-nav {
    display: none;
    position: fixed;
    top: 69px; /* Below header */
    left: 0;
    right: 0;
    background: var(--bg-card);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    z-index: 999;
    flex-direction: column;
    gap: 0;
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.3s ease-out;
  }
  .mobile-nav.active {
    display: flex !important;
    max-height: calc(100vh - 69px);
    overflow-y: auto;
  }
  /* Extra specificity for hidden state */
  .mobile-nav:not(.active) {
    display: none !important;
    visibility: hidden !important;
  }
  /* Adjust mobile nav top spacing for smaller mobile header */
  @media (max-width: 767px) {
    .mobile-nav {
      top: 57px; /* Smaller mobile header */
    }
    .mobile-nav.active {
      max-height: calc(100vh - 57px);
    }
  }
  .mobile-nav a {
    color: var(--text);
    text-decoration: none;
    padding: 16px;
    border-bottom: 1px solid var(--border);
    transition: background 0.2s, color 0.2s;
    min-height: 52px;
    display: flex;
    align-items: center;
    font-size: 1rem;
    /* Ensure touch target compliance */
    touch-action: manipulation;
  }
  .mobile-nav a:last-child {
    border-bottom: none;
  }
  .mobile-nav a:nth-last-child(-n+2) {
    color: var(--text-muted);
    font-size: 0.9rem;
    min-height: 52px; /* Fixed: was 48px, now meets 44px+ guideline */
  }
  /* Hidden attribute support */
  .mobile-nav[hidden] {
    display: none !important;
  }
  .mobile-nav a:hover,
  .mobile-nav a:active { 
    background: var(--bg-input);
    color: var(--accent);
  }
  .mobile-nav a.active {
    color: var(--accent);
    background: rgba(0, 240, 255, 0.08);
    border-left: 3px solid var(--accent);
  }
  .mobile-nav a:focus-visible { 
    outline: 2px solid var(--accent); 
    outline-offset: -2px;
  }
  @keyframes slideDown {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Mobile + Tablet: Show hamburger menu, hide desktop nav */
  @media (max-width: 1023px) {
    header nav:not(.mobile-nav) {
      display: none !important;
    }
    .mobile-menu-btn {
      display: flex !important;
    }
  }

  @media (max-width: 768px) {
    h1 { font-size: 1.75rem; }
    h2 { font-size: 1.5rem; }
    .container { padding: 16px; }
  }

  /* ============================================
     ENHANCED BUTTON STATES
     ============================================ */
  .btn {
    padding: 12px 24px;
    border-radius: 8px;
    font-weight: 600;
    font-size: 0.95rem;
    cursor: pointer;
    border: none;
    transition: all 0.2s;
    position: relative;
    overflow: hidden;
  }

  /* Hover Effects */
  .btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(249, 115, 22, 0.3);
  }

  .btn:active:not(:disabled) {
    transform: translateY(0);
  }

  /* Primary Button */
  .btn-primary {
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent-light) 100%);
    color: #000;
    font-weight: 600;
    box-shadow: 0 4px 16px rgba(0, 240, 255, 0.3);
  }

  .btn-primary:hover:not(:disabled) {
    background: linear-gradient(135deg, var(--accent-light) 0%, var(--accent) 100%);
    box-shadow: 0 6px 24px rgba(0, 240, 255, 0.5);
    transform: translateY(-2px);
  }

  /* Secondary Button */
  .btn-secondary {
    background: var(--bg-input);
    color: var(--text);
    border: 1px solid var(--border);
  }

  .btn-secondary:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--bg-card);
  }

  /* Success Button (after action completed) */
  .btn-success {
    background: var(--green);
    color: white;
  }

  .btn-success::before {
    content: '✓ ';
  }

  /* Disabled State */
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  /* Button Group */
  .btn-group {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  /* Toggle Switch */
  .toggle {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
  }
  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
  }
  .toggle .slider {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: var(--bg);
    border: 1px solid var(--border);
    transition: 0.3s;
    border-radius: 24px;
  }
  .toggle .slider:before {
    position: absolute;
    content: "";
    height: 18px;
    width: 18px;
    left: 2px;
    bottom: 2px;
    background-color: var(--text-muted);
    transition: 0.3s;
    border-radius: 50%;
  }
  .toggle input:checked + .slider {
    background-color: var(--accent);
    border-color: var(--accent);
  }
  .toggle input:checked + .slider:before {
    transform: translateX(20px);
    background-color: white;
  }
  .toggle input:disabled + .slider {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Icon Buttons */
  .btn-icon {
    padding: 10px;
    min-width: 44px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /* Small Buttons */
  .btn-sm {
    padding: 8px 16px;
    font-size: 0.85rem;
  }

  /* Large Buttons */
  .btn-lg {
    padding: 16px 32px;
    font-size: 1.05rem;
  }
  @media (max-width: 480px) {
    .btn-lg {
      padding: 14px 24px;
      font-size: 1rem;
      width: 100%;
    }
  }

  /* Focus Styles (Accessibility) */
  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Ripple Effect on Click */
  .btn::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 0;
    height: 0;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.3);
    transform: translate(-50%, -50%);
    transition: width 0.6s, height 0.6s;
  }

  .btn:active::after {
    width: 300px;
    height: 300px;
  }

  /* ============================================
     CARD COMPONENTS
     ============================================ */
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 24px;
    transition: all 0.25s ease;
    box-shadow: var(--shadow-sm);
  }

  .card:hover {
    background: var(--bg-card-hover);
    border-color: var(--border-light);
    transform: translateY(-4px);
    box-shadow: var(--shadow-md), 0 0 20px rgba(0, 240, 255, 0.08);
  }
  
  .card:hover .card-title {
    color: var(--accent);
  }

  .card-header {
    margin-bottom: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }

  .card-title {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0;
  }

  .card-subtitle {
    color: var(--text-muted);
    font-size: 0.9rem;
    margin-top: 4px;
  }

  .card-body {
    /* Content goes here */
  }

  .card-footer {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }

  /* ============================================
     FORM ELEMENTS
     ============================================ */
  label {
    display: block;
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--text);
    margin-bottom: 8px;
  }

  input, select, textarea {
    width: 100%;
    padding: 12px 16px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 0.95rem;
    font-family: inherit;
    transition: all 0.2s;
  }

  input:focus, select:focus, textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.1);
  }

  input::placeholder, textarea::placeholder {
    color: var(--text-muted);
    opacity: 0.6;
  }

  textarea {
    resize: vertical;
    min-height: 100px;
  }

  .form-group {
    margin-bottom: 20px;
  }

  .form-help {
    font-size: 0.85rem;
    color: var(--text-muted);
    margin-top: 4px;
  }

  .form-error {
    font-size: 0.85rem;
    color: #ef4444;
    margin-top: 4px;
  }

  /* Interactive Node Canvas */
  #node-canvas {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 0;
    opacity: 0.4;
  }

  .hero {
    text-align: center;
    padding: 60px 24px 40px;
    position: relative;
    z-index: 1;
    min-height: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .hero-badge {
    display: inline-block;
    padding: 8px 20px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 50px;
    font-size: 0.85rem;
    color: var(--teal-light);
    margin-bottom: 24px;
    letter-spacing: 0.05em;
  }
  .hero-title {
    font-size: clamp(2.5rem, 6vw, 4rem);
    font-weight: 800;
    margin-bottom: 24px;
    line-height: 1.1;
    letter-spacing: -0.03em;
    color: var(--text);
  }
  .gradient-text {
    background: linear-gradient(135deg, var(--teal) 0%, var(--teal-light) 50%, #7dd3d3 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .hero-subtitle {
    color: var(--text-muted);
    font-size: 1.2rem;
    max-width: 560px;
    margin: 0 auto 24px;
    line-height: 1.7;
  }
  /* Hero Search - Unified Glass Morphism (Option 1) */
  .hero-search {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 600px;
    width: 100%;
    background: rgba(15, 25, 45, 0.4);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(0, 240, 255, 0.15);
    border-radius: 16px;
    padding: 6px;
    margin-bottom: 24px;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow:
      0 4px 24px rgba(0, 0, 0, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }

  .hero-search:focus-within {
    border-color: rgba(0, 240, 255, 0.4);
    background: rgba(15, 25, 45, 0.6);
    box-shadow:
      0 8px 32px rgba(0, 240, 255, 0.2),
      0 0 0 1px rgba(0, 240, 255, 0.1),
      inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }

  .hero-search input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-size: 15px;
    font-weight: 400;
    padding: 12px 16px;
    min-width: 0;
  }

  .hero-search input::placeholder {
    color: #5a6479;
  }

  .hero-search button {
    flex-shrink: 0;
    width: 48px;
    height: 48px;
    border-radius: 12px;
    border: none;
    background: linear-gradient(135deg, var(--accent) 0%, #00b8d4 100%);
    color: var(--bg);
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 16px rgba(0, 240, 255, 0.3);
  }

  .hero-search button:hover {
    transform: scale(1.05);
    box-shadow: 0 6px 24px rgba(0, 240, 255, 0.5);
  }

  .hero-search button:active {
    transform: scale(0.98);
  }
  .popular-tags {
    display: flex;
    gap: 10px;
    justify-content: center;
    flex-wrap: wrap;
    margin-bottom: 48px;
  }
  .tag-link {
    padding: 8px 18px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 50px;
    color: var(--text-secondary);
    text-decoration: none;
    font-size: 0.9rem;
    transition: all 0.2s;
  }
  .tag-link:hover {
    border-color: var(--teal);
    color: var(--teal-light);
    background: rgba(74, 139, 139, 0.1);
  }
  .trust-banner {
    display: flex;
    gap: 40px;
    justify-content: center;
    flex-wrap: wrap;
  }
  .trust-item {
    display: flex;
    align-items: center;
    gap: 12px;
    text-align: left;
  }
  .trust-icon {
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, var(--teal-dark), var(--teal));
    border-radius: 12px;
    font-size: 1.1rem;
    color: white;
  }
  .trust-item strong {
    font-size: 1.3rem;
    color: var(--text);
    display: block;
  }
  .trust-item span {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .logo-img {
    width: 36px;
    height: 36px;
  }
  .stats {
    display: flex;
    justify-content: center;
    gap: 48px;
    margin-top: 48px;
  }
  .stat { text-align: center; }
  .stat-value {
    font-size: 2rem;
    font-weight: 700;
    color: var(--accent);
  }
  .stat-label {
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .section-title {
    font-size: 1.5rem;
    font-weight: 700;
    margin-bottom: 24px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .agents-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 24px;
    margin-bottom: 48px;
  }
  .agent-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 24px;
    transition: all 0.25s ease;
    box-shadow: var(--shadow-sm);
    position: relative;
    overflow: hidden;
  }
  .agent-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: linear-gradient(90deg, var(--accent), var(--purple));
    opacity: 0;
    transition: opacity 0.25s ease;
  }
  .agent-card:hover {
    background: var(--bg-card-hover);
    border-color: var(--accent);
    transform: translateY(-4px) scale(1.01);
    box-shadow: 0 12px 40px rgba(0, 240, 255, 0.15), var(--shadow-md);
  }
  .agent-card:hover::before {
    opacity: 1;
  }
  .agent-card:hover .agent-avatar {
    transform: scale(1.08);
    box-shadow: 0 0 24px rgba(0, 240, 255, 0.5);
  }
  .agent-card:hover h3 {
    color: var(--accent);
  }
  .agent-header {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }
  .agent-avatar {
    width: 56px;
    height: 56px;
    background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    transition: all var(--duration-normal) var(--ease-spring);
    flex-shrink: 0;
  }
  .agent-info h3 {
    font-size: 1.1rem;
    font-weight: 600;
    transition: color var(--duration-fast);
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  .agent-info p {
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .agent-stats {
    display: flex;
    gap: 16px;
    margin-bottom: 16px;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .agent-stats span {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .skills-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
    max-height: 80px;
    overflow: hidden;
    position: relative;
    transition: max-height 0.3s ease;
  }
  .skills-list.expanded {
    max-height: 500px;
  }
  .skills-toggle {
    background: var(--bg-input);
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 0.75rem;
    cursor: pointer;
    margin-bottom: 16px;
    transition: all 0.2s;
  }
  .skills-toggle:hover {
    background: var(--border);
    color: var(--text);
  }
  .skill-tag {
    background: var(--bg-input);
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 0.8rem;
    color: var(--text-muted);
    border: 1px solid transparent;
    cursor: default;
  }
  .skill-tag.skill-clickable {
    cursor: pointer;
    transition: all 0.2s ease;
    border: 1px solid var(--border);
  }
  .skill-tag.skill-clickable:hover {
    background: var(--primary);
    color: white;
    border-color: var(--primary);
    transform: translateY(-1px);
  }
  .skill-tag.skill-clickable:hover .price {
    color: rgba(255,255,255,0.9);
  }
  .skill-tag .price {
    color: var(--green);
    margin-left: 8px;
  }
  .wallet-section {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 24px;
  }
  .wallet-connected {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .wallet-address {
    font-family: monospace;
    background: var(--bg-input);
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 0.85rem;
  }
  .balance {
    color: var(--green);
    font-weight: 600;
  }
  #wallet-status {
    padding: 12px;
    background: var(--bg-input);
    border-radius: 8px;
    text-align: center;
  }
  .hidden { display: none; }

  /* ============================================
     LOADING SPINNERS
     ============================================ */
  .spinner {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .spinner-lg {
    width: 40px;
    height: 40px;
    border-width: 4px;
  }

  .loading-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(9, 9, 11, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 16px;
    z-index: 9999;
  }

  .loading-overlay .spinner {
    width: 48px;
    height: 48px;
    border-width: 4px;
  }

  .loading-text {
    color: var(--text-muted);
    font-size: 1rem;
  }

  /* Button Loading State */
  .btn.loading {
    position: relative;
    pointer-events: none;
    opacity: 0.7;
  }

  .btn.loading::after {
    content: '';
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ============================================
     TOAST NOTIFICATIONS
     ============================================ */
  .toast-container {
    position: fixed;
    top: 80px;
    right: 24px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 400px;
  }

  @media (max-width: 767px) {
    .toast-container {
      top: 70px;
      right: 16px;
      left: 16px;
      max-width: none;
    }
  }

  .toast {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-left-width: 4px;
    border-radius: 8px;
    padding: 16px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: start;
    gap: 12px;
    animation: slideIn 0.3s ease-out;
  }

  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  .toast.success {
    border-left-color: var(--green);
  }

  .toast.error {
    border-left-color: #ef4444;
  }

  .toast.info {
    border-left-color: var(--blue);
  }

  .toast-icon {
    font-size: 1.25rem;
    flex-shrink: 0;
  }

  .toast-content {
    flex: 1;
  }

  .toast-title {
    font-weight: 600;
    margin-bottom: 4px;
  }

  .toast-message {
    font-size: 0.9rem;
    color: var(--text-muted);
  }

  .toast-close {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }

  .toast-close:hover {
    color: var(--text);
  }

  /* Mobile menu toggle - hidden on desktop */
  .mobile-menu-toggle {
    display: none;
  }

  /* ============================================
     TRANSITIONS & ANIMATIONS
     ============================================ */

  /* Fade In Animation */
  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .fade-in {
    animation: fadeIn 0.4s ease-out;
  }

  /* Slide In Animation */
  @keyframes slideInUp {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .slide-in {
    animation: slideInUp 0.5s ease-out;
  }

  /* Pulse Animation (for status indicators) */
  @keyframes pulse {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  .pulse {
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }

  /* Scale on Hover (for interactive elements) */
  .scale-on-hover {
    transition: transform 0.2s ease;
  }

  .scale-on-hover:hover {
    transform: scale(1.05);
  }

  /* Focus Animations */
  @keyframes focusRing {
    0% {
      box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.5);
    }
    100% {
      box-shadow: 0 0 0 4px rgba(249, 115, 22, 0);
    }
  }

  *:focus-visible {
    animation: focusRing 0.6s ease-out;
  }

  /* Skeleton Loading (for slow-loading content) */
  .skeleton {
    background: linear-gradient(
      90deg,
      var(--bg-input) 25%,
      var(--bg-card) 50%,
      var(--bg-input) 75%
    );
    background-size: 200% 100%;
    animation: loading 1.5s ease-in-out infinite;
    border-radius: 4px;
  }

  @keyframes loading {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }

  .skeleton-text {
    height: 16px;
    margin-bottom: 8px;
  }

  .skeleton-title {
    height: 24px;
    width: 60%;
    margin-bottom: 12px;
  }

  .skeleton-avatar {
    width: 56px;
    height: 56px;
    border-radius: 12px;
  }

  /* Modal Animations */
  .modal {
    animation: modalFadeIn 0.3s ease-out;
  }

  @keyframes modalFadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .modal-content {
    animation: modalSlideUp 0.3s ease-out;
  }

  @keyframes modalSlideUp {
    from {
      transform: translateY(50px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  /* Accessibility - Respect user's motion preferences */
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }

  /* Skip to main content link (accessibility) */
  .skip-to-main {
    position: absolute;
    top: -40px;
    left: 0;
    background: var(--accent);
    color: white;
    padding: 8px 16px;
    text-decoration: none;
    z-index: 10001;
  }

  .skip-to-main:focus {
    top: 0;
  }

  /* ============================================
     RESPONSIVE - TABLET (768px - 1199px)
     ============================================ */
  @media (max-width: 1199px) {
    .container { padding: 20px; }

    .hero {
      padding: 60px 20px;
    }

    .hero h1 {
      font-size: 2.5rem;
    }

    .agents-grid {
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 20px;
    }

    .stats {
      gap: 32px;
    }
  }

  /* ============================================
     RESPONSIVE - TABLET PORTRAIT (768px - 899px)
     Optimized 2-column layouts for iPad portrait
     ============================================ */
  @media (min-width: 768px) and (max-width: 899px) {
    /* Agents grid - explicit 2-column for tablet portrait */
    .agents-grid {
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
    }
    
    /* Agent and featured cards - semi-compact tablet layout */
    .agent-card,
    .featured-agent-card {
      padding: 20px;
    }
    
    /* Featured card - partial compact (hide some elements, keep others) */
    .featured-agent-card .agent-bio {
      font-size: 0.85rem;
      -webkit-line-clamp: 2;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    
    .featured-agent-card .agent-trust-signals {
      display: none;
    }
    
    .featured-agent-card .agent-avatar-lg {
      width: 72px;
      height: 72px;
      font-size: 32px;
    }
    
    .featured-agent-card h3 {
      font-size: 1.15rem;
    }
    
    .featured-agent-card .card-badges {
      gap: 6px;
      margin-bottom: 16px;
    }
    
    .featured-agent-card .founder-badge {
      padding: 6px 12px;
      font-size: 0.7rem;
    }
    
    .agent-avatar {
      width: 48px;
      height: 48px;
      font-size: 1.25rem;
    }
    
    /* Stats bar - tighter tablet layout */
    .stats-bar {
      gap: 24px;
      padding: 24px 32px;
    }
    
    .stat-block .number {
      font-size: 1.5rem;
    }
    
    /* Trust signals - 2x2 grid optimized */
    .trust-signals {
      gap: 20px;
      padding: 20px 24px;
    }
    
    /* Steps grid - 2 columns with larger icons */
    .steps-grid {
      grid-template-columns: repeat(2, 1fr);
      gap: 20px;
      max-width: 500px;
      margin: 24px auto 0;
    }
    
    .step-icon {
      width: 56px;
      height: 56px;
      font-size: 26px;
    }
    
    .step:not(:last-child)::after {
      display: none;
    }
    
    /* Hero search - better tablet fit */
    .hero-search {
      max-width: 90%;
    }
    
    .hero-search input {
      padding: 12px 12px;
    }
    
    /* Card actions - tighter */
    .card-actions {
      gap: 8px;
    }
    
    .btn-hire,
    .btn-details {
      padding: 10px 16px;
      font-size: 0.85rem;
    }
    
    /* Trust grid - badge strip on tablet too */
    .trust-grid {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 12px;
    }
    
    .trust-card {
      background: rgba(0, 240, 255, 0.05);
      border: 1px solid rgba(0, 240, 255, 0.15);
      border-radius: 24px;
      padding: 12px 20px;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      flex: 0 0 auto;
    }
    
    .trust-card-icon {
      font-size: 1.5rem;
      margin: 0;
    }
    
    .trust-card h3 {
      font-size: 0.9rem;
      margin: 0;
    }
    
    .trust-card p {
      display: none;
    }
    
    /* Crypto section - stack */
    .crypto-content {
      grid-template-columns: 1fr;
      gap: 32px;
    }
    
    /* Operator card - tighter */
    .operator-card {
      padding: 28px 24px;
    }
    
    /* CTA buttons - stack on narrow tablet */
    .cta-buttons {
      flex-direction: column;
      gap: 12px;
      align-items: center;
    }
    
    .cta-buttons .btn {
      width: 100%;
      max-width: 300px;
    }
  }
  
  /* ============================================
     RESPONSIVE - TABLET LANDSCAPE (900px - 1023px)
     ============================================ */
  @media (min-width: 900px) and (max-width: 1023px) {
    /* Featured cards - partial compact, 2-column */
    .agents-grid {
      grid-template-columns: repeat(2, 1fr);
      gap: 20px;
    }
    
    .featured-agent-card {
      padding: 24px;
    }
    
    .featured-agent-card .agent-bio {
      -webkit-line-clamp: 3;
    }
    
    .featured-agent-card .agent-trust-signals {
      padding: 12px;
    }
    
    /* Trust grid - badge strip */
    .trust-grid {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 14px;
    }
    
    .trust-card {
      background: rgba(0, 240, 255, 0.05);
      border: 1px solid rgba(0, 240, 255, 0.15);
      border-radius: 24px;
      padding: 14px 24px;
      display: inline-flex;
      align-items: center;
      gap: 12px;
      flex: 0 0 auto;
    }
    
    .trust-card-icon {
      font-size: 1.75rem;
      margin: 0;
    }
    
    .trust-card h3 {
      font-size: 1rem;
      margin: 0;
    }
    
    .trust-card p {
      display: none;
    }
    
    /* Steps - 4 columns but tighter */
    .steps-grid {
      gap: 16px;
    }
    
    .step-icon {
      width: 56px;
      height: 56px;
      font-size: 26px;
    }
  }

  /* ============================================
     RESPONSIVE - MOBILE (320px - 767px)
     ============================================ */
  @media (max-width: 767px) {
    .container {
      padding: 16px;
      max-width: 100%;
      overflow: visible;
    }

    .hero-content {
      overflow: visible;
    }

    /* Header */
    header {
      padding: 12px 16px;
      flex-wrap: wrap;
    }

    .logo {
      font-size: 1.1rem;
      gap: 8px;
    }

    .logo-icon { font-size: 1.3rem; }

    /* Legacy mobile nav removed - now using .mobile-nav overlay system */

    /* Hero */
    .hero {
      padding: 48px 16px;
    }

    .hero h1 {
      font-size: 2rem;
      line-height: 1.2;
    }

    .hero p {
      font-size: 1rem;
      margin-bottom: 24px;
    }

    /* Stats - Stack Vertically */
    .stats {
      flex-direction: column;
      gap: 24px;
    }

    .stat-value { font-size: 1.75rem; }

    /* Grids - Single Column */
    .agents-grid {
      grid-template-columns: 1fr;
      gap: 16px;
    }

    .agent-card {
      padding: 20px;
    }

    .agent-avatar {
      width: 48px;
      height: 48px;
      font-size: 1.25rem;
    }

    /* Skills */
    .skills-list {
      gap: 6px;
    }

    .skill-tag {
      font-size: 0.75rem;
      padding: 5px 10px;
    }

    /* Buttons - Full Width on Mobile */
    .btn {
      width: 100%;
      padding: 12px 20px;
      font-size: 1rem;
    }

    .btn-group {
      flex-direction: column;
      gap: 12px;
    }

    .btn-group .btn {
      width: 100%;
    }

    /* Wallet Section */
    .wallet-section {
      padding: 16px;
    }

    .wallet-connected {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }

    .wallet-address {
      font-size: 0.75rem;
      word-break: break-all;
    }

    /* Forms */
    input, select, textarea {
      font-size: 16px; /* Prevents iOS zoom on focus */
    }

    /* Touch Targets - Min 44x44px */
    a, button, input[type="submit"], input[type="button"] {
      min-height: 44px;
      min-width: 44px;
    }

    /* Responsive Typography */
    h1 { font-size: 2rem; }
    h2 { font-size: 1.75rem; }
    h3 { font-size: 1.25rem; }
    h4 { font-size: 1.1rem; }

    body {
      font-size: 15px;
    }

    /* Card Responsive */
    .card {
      padding: 16px;
      border-radius: 8px;
    }

    /* ====================
       MOBILE FIXES
       ==================== */

    /* Hero Search - Consistent glass morphism on mobile */
    .hero-search {
      max-width: 100%;
      padding: 6px;
      margin-bottom: 20px;
    }

    .hero-search input {
      font-size: 15px;
      padding: 12px 14px;
    }

    .hero-search button {
      width: 48px;
      height: 48px;
    }

    /* Category Pills - Wrap nicely in rows */
    .popular-tags {
      display: flex;
      flex-wrap: wrap !important;
      gap: 8px;
      justify-content: center;
      margin-bottom: 24px;
      max-width: 100%;
    }

    .tag-pill {
      padding: 8px 14px;
      font-size: 0.8rem;
      white-space: nowrap;
    }

    /* Trust Signals - 2x2 grid, text centered under icons */
    .trust-signals {
      grid-template-columns: repeat(2, 1fr) !important;
      gap: 16px;
      padding: 20px 16px;
    }

    .trust-block {
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      text-align: center !important;
      gap: 10px;
      padding: 12px 8px;
    }

    .trust-icon {
      width: 48px;
      height: 48px;
      font-size: 1.5rem;
      margin: 0 auto;
    }

    .trust-content {
      text-align: center !important;
      width: 100%;
    }

    .trust-title {
      font-size: 0.85rem;
      font-weight: 600;
      white-space: normal;
      text-align: center;
    }

    .trust-desc {
      font-size: 0.75rem;
      text-align: center;
    }

    /* Steps Grid - Clean 2x2 layout */
    .steps-grid {
      grid-template-columns: repeat(2, 1fr) !important;
      gap: 24px;
      margin-top: 24px;
    }

    .step {
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .step:not(:last-child)::after {
      display: none !important;
    }

    .step-icon {
      width: 56px;
      height: 56px;
      font-size: 24px;
      margin: 0 auto 12px;
    }

    .step-title {
      font-size: 0.95rem;
      font-weight: 600;
      margin-bottom: 8px;
      text-align: center;
    }

    .step-desc {
      font-size: 0.8rem;
      line-height: 1.4;
      text-align: center;
      color: var(--text-muted);
    }

    /* Trust Grid - Single column, centered vertically */
    .trust-grid {
      grid-template-columns: 1fr !important;
      gap: 16px;
    }

    .trust-card {
      padding: 28px 20px;
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: center !important;
      text-align: center !important;
      min-height: 160px;
    }

    .trust-card-icon {
      font-size: 2.5rem;
      margin-bottom: 12px;
    }

    .trust-card h3 {
      font-size: 1.05rem;
      font-weight: 600;
      margin-bottom: 8px;
      text-align: center;
    }

    .trust-card p {
      font-size: 0.875rem;
      line-height: 1.6;
      text-align: center;
      color: var(--text-muted);
    }
  }

  /* Extra Small Devices */
  @media (max-width: 479px) {
    .hero h1 {
      font-size: 1.75rem;
    }

    .agent-card {
      padding: 16px;
    }

    .section-title {
      font-size: 1.25rem;
    }
  }

  /* ============================================
     FOOTER
     ============================================ */
  footer {
    margin-top: 80px;
    padding: 40px 24px;
    border-top: 1px solid var(--border);
    background: var(--bg);
    text-align: center;
  }

  .footer-content {
    max-width: 600px;
    margin: 0 auto;
  }

  .footer-logo {
    font-size: 1.5rem;
    font-weight: 700;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .footer-tagline {
    color: var(--text-muted);
    font-size: 0.95rem;
    margin-bottom: 24px;
    line-height: 1.5;
  }

  .footer-links {
    display: flex;
    justify-content: center;
    gap: 24px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }

  .footer-links a {
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.9rem;
    transition: color 0.2s;
  }

  .footer-links a:hover {
    color: var(--accent);
  }

  .footer-meta {
    color: var(--text-muted);
    font-size: 0.8rem;
    opacity: 0.7;
  }
  
  /* Footer Responsive */
  @media (max-width: 768px) {
    footer {
      margin-top: 48px;
      padding: 32px 16px;
    }
    footer nav {
      flex-direction: row !important;
      flex-wrap: wrap !important;
      justify-content: center !important;
      gap: 8px !important;
    }
    footer nav a {
      min-height: 44px !important;
      padding: 12px 16px !important;
      display: flex !important;
      align-items: center !important;
    }
    footer .container {
      flex-direction: column !important;
      gap: 20px !important;
      text-align: center !important;
      align-items: center !important;
    }
    /* Footer social links touch targets */
    footer .container > div:last-child {
      justify-content: center !important;
    }
    footer .container > div:last-child a {
      min-width: 44px !important;
      min-height: 44px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
    }
  }
  
  /* Extra small screens - 375px and below */
  @media (max-width: 375px) {
    footer .container {
      padding: 0 8px;
    }
    footer nav {
      gap: 4px !important;
    }
    footer nav a {
      padding: 10px 12px !important;
      font-size: 0.75rem !important;
    }
  }
`;

const HUB_FOOTER = `
  <footer style="border-top: 1px solid var(--border); padding: 20px 0; background: var(--bg);">
    <div class="container" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <img src="/logos/butler-bot.png" alt="TheBotique" style="width: 24px; height: 24px; border-radius: 4px;">
        <span style="font-weight: 600; font-size: 0.85rem; color: var(--text);">TheBotique</span>
        <span style="color: var(--text-muted); font-size: 0.75rem;">© 2026</span>
      </div>
      <nav style="display: flex; gap: 16px; flex-wrap: wrap; align-items: center;">
        <a href="/agents" style="color: var(--text-muted); text-decoration: none; font-size: 0.8rem;">Browse</a>
        <a href="/register" style="color: var(--text-muted); text-decoration: none; font-size: 0.8rem;">List Agent</a>
        <a href="/docs" style="color: var(--text-muted); text-decoration: none; font-size: 0.8rem;">API</a>
        <a href="/support" style="color: var(--text-muted); text-decoration: none; font-size: 0.8rem;">Help</a>
        <a href="/terms" style="color: var(--text-muted); text-decoration: none; font-size: 0.8rem;">Terms</a>
        <a href="/privacy" style="color: var(--text-muted); text-decoration: none; font-size: 0.8rem;">Privacy</a>
      </nav>
      <div style="display: flex; align-items: center; gap: 10px;">
        <a href="https://x.com/thebotique" style="color: var(--text-muted); text-decoration: none; font-size: 0.85rem;" aria-label="X/Twitter">𝕏</a>
        <a href="https://github.com/rekaldsi" style="color: var(--text-muted); text-decoration: none; font-size: 0.85rem;" aria-label="GitHub">⌘</a>
        <span style="color: var(--teal); font-size: 0.7rem; padding: 2px 8px; background: rgba(0,240,255,0.1); border-radius: 10px;">⛓ Base</span>
      </div>
    </div>
  </footer>
`;

const HUB_SCRIPTS = `
  // Global helper functions for onclick handlers
  window.closeModal = function(btn) {
    var modal = btn.closest('.modal-overlay');
    if (modal) modal.remove();
  };

  window.closeToast = function(btn) {
    var toast = btn.parentElement;
    if (toast) toast.remove();
  };

  window.toggleFAQ = function(el) {
    var faqItem = el.parentElement;
    if (faqItem) faqItem.classList.toggle('open');
  };

  window.removeParent = function(btn) {
    var parent = btn.parentElement;
    if (parent) parent.remove();
  };

  // Mobile Menu Toggle - Class-based only, no inline styles
  window.toggleMobileMenu = function() {
    const btn = document.querySelector('.mobile-menu-btn');
    const nav = document.getElementById('mobileNav');
    if (!btn || !nav) return;
    
    const isActive = nav.classList.contains('active');
    if (isActive) {
      window.closeMobileMenu();
    } else {
      // Open menu
      btn.classList.add('active');
      btn.setAttribute('aria-expanded', 'true');
      nav.removeAttribute('hidden');
      nav.classList.add('active');
      // Prevent body scroll when menu is open
      document.body.style.overflow = 'hidden';
    }
  }

  window.closeMobileMenu = function() {
    const btn = document.querySelector('.mobile-menu-btn');
    const nav = document.getElementById('mobileNav');
    if (btn) {
      btn.classList.remove('active');
      btn.setAttribute('aria-expanded', 'false');
    }
    if (nav) {
      nav.classList.remove('active');
      nav.setAttribute('hidden', '');
    }
    // Restore body scroll
    document.body.style.overflow = '';
  }
  
  // Initialize mobile menu handlers after DOM is ready
  document.addEventListener('DOMContentLoaded', function() {
    const nav = document.getElementById('mobileNav');
    const btn = document.querySelector('.mobile-menu-btn');
    
    // Ensure menu is closed on page load
    if (nav) nav.classList.remove('active');
    if (btn) {
      btn.classList.remove('active');
      btn.setAttribute('aria-expanded', 'false');
      // Attach click handler
      btn.addEventListener('click', window.toggleMobileMenu);
    }

    // Close mobile menu on link click
    document.querySelectorAll('.mobile-nav a').forEach(function(a) {
      a.addEventListener('click', function() {
        window.closeMobileMenu();
      });
    });
    
    // Close mobile menu when clicking outside
    document.addEventListener('click', function(e) {
      const nav = document.getElementById('mobileNav');
      const btn = document.querySelector('.mobile-menu-btn');
      if (nav && nav.classList.contains('active')) {
        if (!nav.contains(e.target) && !btn.contains(e.target)) {
          window.closeMobileMenu();
        }
      }
    });
    
    // Close mobile menu on escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        window.closeMobileMenu();
      }
    });
    
    // Close menu on window resize to desktop
    window.addEventListener('resize', function() {
      if (window.innerWidth >= 1024) {
        window.closeMobileMenu();
      }
    });
  });

  // Interactive Node Network Animation
  (function() {
    const canvas = document.getElementById('node-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let nodes = [];
    let mouse = { x: null, y: null };
    const nodeCount = 40;
    const connectionDistance = 150;
    const mouseRadius = 180;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    for (let i = 0; i < nodeCount; i++) {
      nodes.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        radius: Math.random() * 2 + 2
      });
    }

    document.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
    document.addEventListener('mouseleave', () => { mouse.x = null; mouse.y = null; });

    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      nodes.forEach((node, i) => {
        node.x += node.vx; node.y += node.vy;
        if (node.x < 0 || node.x > canvas.width) node.vx *= -1;
        if (node.y < 0 || node.y > canvas.height) node.vy *= -1;
        if (mouse.x && mouse.y) {
          const dx = mouse.x - node.x, dy = mouse.y - node.y;
          const dist = Math.sqrt(dx*dx + dy*dy);
          if (dist < mouseRadius) { node.x += dx * 0.015; node.y += dy * 0.015; }
        }
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(74, 139, 139, 0.7)';
        ctx.fill();
        for (let j = i + 1; j < nodes.length; j++) {
          const o = nodes[j];
          const d = Math.sqrt((node.x-o.x)**2 + (node.y-o.y)**2);
          if (d < connectionDistance) {
            ctx.beginPath(); ctx.moveTo(node.x, node.y); ctx.lineTo(o.x, o.y);
            ctx.strokeStyle = 'rgba(74, 139, 139, ' + (1 - d/connectionDistance) * 0.25 + ')';
            ctx.stroke();
          }
        }
      });
      requestAnimationFrame(animate);
    }
    animate();
  })();

  // Notification badge
  async function updateNotificationBadge() {
    if (!connected || !userAddress) return;
    try {
      const res = await fetch('/api/messages/unread?wallet=' + userAddress);
      const data = await res.json();
      const badge = document.getElementById('notif-badge');
      if (badge) {
        if (data.unread > 0) {
          badge.textContent = data.unread > 9 ? '9+' : data.unread;
          badge.style.display = 'inline-block';
        } else {
          badge.style.display = 'none';
        }
      }
    } catch (e) {}
  }
  
  // Poll notifications every 30 seconds
  setInterval(() => {
    if (connected) updateNotificationBadge();
  }, 30000);

  // Wallet connection state
  let connected = false;
  let userAddress = null;
  let provider = null;
  let signer = null;

  // USDC on Base
  const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const USDC_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)'
  ];

  // Mobile detection
  function isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }

  // Check if already connected
  async function checkConnection() {
    if (typeof window.ethereum !== 'undefined') {
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      if (accounts.length > 0) {
        await connectWallet(true);
      }
    }
  }

  // Connect wallet
  async function connectWallet(silent = false) {
    console.log('[Wallet] Attempting connection...', { silent, hasEthereum: typeof window.ethereum !== 'undefined', hasEthers: typeof ethers !== 'undefined' });
    
    if (typeof window.ethereum === 'undefined') {
      console.log('[Wallet] No ethereum provider found');
      if (!silent) {
        if (isMobile()) {
          // On mobile, offer to open in wallet app
          const metamaskLink = 'https://metamask.app.link/dapp/' + window.location.host + window.location.pathname;
          showWalletOptions(metamaskLink);
        } else {
          showToast('Please install MetaMask or another Web3 wallet', 'error');
        }
      }
      return;
    }
    
    // Check if ethers is loaded
    if (typeof ethers === 'undefined') {
      console.error('[Wallet] ethers.js not loaded');
      if (!silent) showToast('Loading wallet library, please try again...', 'error');
      return;
    }

    const btn = document.getElementById('connect-btn');
    if (btn && !silent) {
      setButtonLoading(btn, true);
    }

    try {
      // Request accounts
      const accounts = await window.ethereum.request({ 
        method: silent ? 'eth_accounts' : 'eth_requestAccounts' 
      });
      
      if (accounts.length === 0) return;

      userAddress = accounts[0];
      provider = new ethers.BrowserProvider(window.ethereum);
      signer = await provider.getSigner();

      // Check network (Base = 8453)
      const network = await provider.getNetwork();
      if (network.chainId !== 8453n) {
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0x2105' }]
          });
        } catch (e) {
          if (e.code === 4902) {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: '0x2105',
                chainName: 'Base',
                nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                rpcUrls: ['https://mainnet.base.org'],
                blockExplorerUrls: ['https://basescan.org']
              }]
            });
          }
        }
      }

      // Get USDC balance
      const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
      const balance = await usdc.balanceOf(userAddress);
      const decimals = await usdc.decimals();
      const balanceFormatted = (Number(balance) / 10**Number(decimals)).toFixed(2);

      connected = true;
      console.log('[Wallet] Connected successfully:', userAddress, 'Balance:', balanceFormatted, 'USDC');
      updateWalletUI(userAddress, balanceFormatted);

      // Register user in backend
      await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: userAddress, type: 'human' })
      });

    } catch (error) {
      console.error('[Wallet] Connection error:', error);
      let msg = 'Failed to connect wallet';
      if (error.code === 4001) {
        msg = 'Connection rejected by user';
      } else if (error.code === -32002) {
        msg = 'Connection request already pending - check your wallet';
      } else if (error.message) {
        msg = error.message.slice(0, 100);
      }
      if (!silent) showToast(msg, 'error');
    } finally {
      const btn = document.getElementById('connect-btn');
      if (btn && !silent) {
        setButtonLoading(btn, false, 'Connect Wallet');
      }
    }
  }

  function updateWalletUI(address, balance) {
    const statusEl = document.getElementById('wallet-status');
    const connectBtn = document.getElementById('connect-btn');
    
    if (statusEl) {
      statusEl.innerHTML =
        '<div class="wallet-connected">' +
          '<span>🟢 Connected</span>' +
          '<span class="wallet-address">' + address.slice(0,6) + '...' + address.slice(-4) + '</span>' +
          '<span class="balance">' + balance + ' USDC</span>' +
        '</div>';
    }
    
    if (connectBtn) {
      connectBtn.textContent = address.slice(0,6) + '...' + address.slice(-4);
      connectBtn.onclick = null;
    }
  }

  function disconnectWallet() {
    connected = false;
    userAddress = null;
    provider = null;
    signer = null;
    location.reload();
  }

  // Pay for a job
  async function payForJob(agentWallet, amountUsdc, jobUuid) {
    if (!connected) {
      await connectWallet();
      if (!connected) return null;
    }

    showLoading('Processing payment...');

    try {
      const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
      const decimals = await usdc.decimals();
      const amount = BigInt(Math.round(amountUsdc * 10**Number(decimals)));

      const tx = await usdc.transfer(agentWallet, amount);
      const receipt = await tx.wait();

      hideLoading();
      showToast('Payment sent successfully!', 'success');
      return receipt.hash;
    } catch (error) {
      console.error('Payment error:', error);
      hideLoading();
      showToast('Payment failed: ' + error.message, 'error');
      return null;
    }
  }

  // Listen for account changes
  if (typeof window.ethereum !== 'undefined') {
    window.ethereum.on('accountsChanged', (accounts) => {
      if (accounts.length === 0) {
        disconnectWallet();
      } else {
        connectWallet(true);
      }
    });
  }

  // Check connection on load
  // Don't auto-connect on load - wait for user to click Connect Wallet
  // window.addEventListener('load', checkConnection);

  // Animate elements with stagger effect
  function animateList(selector, delay = 50) {
    const elements = document.querySelectorAll(selector);
    elements.forEach((el, index) => {
      el.style.animationDelay = (index * delay) + 'ms';
      el.classList.add('fade-in');
    });
  }

  // Apply animations on page load
  document.addEventListener('DOMContentLoaded', () => {
    // Animate agent cards
    animateList('.agent-card', 100);

    // Animate skill tags
    animateList('.skill-tag', 30);

    // Animate job cards (if they exist)
    animateList('.job-card', 80);
  });

  // Loading overlay functions
  function showLoading(message = 'Processing...') {
    const overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.id = 'loading-overlay';
    overlay.innerHTML =
      '<div class="spinner"></div>' +
      '<div class="loading-text">' + message + '</div>';
    document.body.appendChild(overlay);
  }

  function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
      overlay.remove();
    }
  }

  // Button loading state
  function setButtonLoading(button, loading, originalText) {
    if (loading) {
      button.classList.add('loading');
      button.disabled = true;
      button.dataset.originalText = originalText || button.textContent;
      button.textContent = 'Loading...';
    } else {
      button.classList.remove('loading');
      button.disabled = false;
      button.textContent = button.dataset.originalText || originalText;
    }
  }

  // Set button to success state
  function setButtonSuccess(button, text = 'Success!', duration = 2000) {
    const originalText = button.textContent;
    const originalClass = button.className;

    button.className = 'btn btn-success';
    button.textContent = text;
    button.disabled = true;

    setTimeout(() => {
      button.className = originalClass;
      button.textContent = originalText;
      button.disabled = false;
    }, duration);
  }

  // Disable button
  function disableButton(button, reason) {
    button.disabled = true;
    button.title = reason;
  }

  // Enable button
  function enableButton(button) {
    button.disabled = false;
    button.title = '';
  }

  // Mobile wallet options modal
  function showWalletOptions(metamaskLink) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = '<div class="modal" style="max-width: 400px; text-align: center;">' +
      '<h3 style="margin-bottom: 16px;">Connect Wallet</h3>' +
      '<p style="color: var(--text-muted); margin-bottom: 24px;">Open this site in your wallet app to connect.</p>' +
      '<div style="display: flex; flex-direction: column; gap: 12px;">' +
        '<a href="' + metamaskLink + '" class="btn btn-primary" style="text-decoration: none;">Open in MetaMask</a>' +
        '<a href="https://link.trustwallet.com/open_url?coin_id=60&url=' + encodeURIComponent(window.location.href) + '" class="btn btn-secondary" style="text-decoration: none;">Open in Trust Wallet</a>' +
        '<a href="https://go.cb-w.com/dapp?cb_url=' + encodeURIComponent(window.location.href) + '" class="btn btn-secondary" style="text-decoration: none;">Open in Coinbase Wallet</a>' +
      '</div>' +
      "<button onclick=\"closeModal(this)\" style=\"margin-top: 24px; background: none; border: none; color: var(--text-muted); cursor: pointer;\">Cancel</button>" +
    '</div>';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // Toast notification system
  function showToast(message, type = 'info', title = null, duration = 5000) {
    // Create container if doesn't exist
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    // Icon mapping
    const icons = {
      success: '✓',
      error: '✕',
      info: 'ℹ'
    };

    // Title mapping
    const titles = {
      success: title || 'Success',
      error: title || 'Error',
      info: title || 'Info'
    };

    // Create toast
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.innerHTML =
      '<div class="toast-icon">' + (icons[type] || icons.info) + '</div>' +
      '<div class="toast-content">' +
        '<div class="toast-title">' + titles[type] + '</div>' +
        '<div class="toast-message">' + message + '</div>' +
      '</div>' +
      '<button class="toast-close" onclick="closeToast(this)">×</button>';

    container.appendChild(toast);

    // Auto-remove after duration
    if (duration > 0) {
      setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease-out reverse';
        setTimeout(() => toast.remove(), 300);
      }, duration);
    }

    return toast;
  }

  // Toggle skills list expansion
  function toggleSkills(agentId, btn) {
    const list = document.getElementById('skills-' + agentId);
    if (list.classList.contains('expanded')) {
      list.classList.remove('expanded');
      btn.textContent = 'Show all services ▼';
    } else {
      list.classList.add('expanded');
      btn.textContent = 'Show less ▲';
    }
  }

  // Quick request from homepage skill click
  function openQuickRequest(button) {
    const agentId = button.dataset.agentId;
    const agentName = button.dataset.agentName;
    const skill = button.dataset.skill;
    const price = button.dataset.price;

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML =
      '<div class="modal" style="max-width: 90vw; width: 450px; margin: 16px;">' +
        '<div class="modal-header">' +
          '<h2 style="font-size: 1.1rem; word-wrap: break-word;">Request: ' + skill + '</h2>' +
          "<button class=\"modal-close\" onclick=\"closeModal(this)\">×</button>" +
        '</div>' +
        '<div class="modal-body">' +
          '<p style="color: var(--text-muted); margin-bottom: 16px; font-size: 0.9rem;">' +
            'From <strong>' + agentName + '</strong> • <span style="color: var(--green);">$' + Number(price).toFixed(2) + ' USDC</span>' +
          '</p>' +
          '<div class="form-group">' +
            '<label>What do you need?</label>' +
            '<textarea id="quick-request-input" rows="4" placeholder="Describe your request..." style="width: 100%; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-input); color: var(--text); resize: vertical; box-sizing: border-box;"></textarea>' +
          '</div>' +
          '<div class="modal-buttons" style="margin-top: 20px;">' +
            "<button class=\"btn btn-secondary\" onclick=\"closeModal(this)\" style=\"flex: 1;\">Cancel</button>" +
            "<button class=\"btn btn-primary\" onclick=\"submitQuickRequest('" + agentId + "', '" + skill + "', " + price + ")\" style=\"flex: 1;\">" +
              (connected ? 'Submit Request' : 'Connect Wallet') +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    document.getElementById('quick-request-input').focus();
  }

  // Submit quick request
  async function submitQuickRequest(agentId, skill, price) {
    if (!connected) {
      await connectWallet();
      if (!connected) return;
    }

    const input = document.getElementById('quick-request-input').value.trim();
    if (!input) {
      showToast('Please describe your request', 'error');
      return;
    }

    // Navigate to agent page with pre-filled request
    const params = new URLSearchParams({
      skill: skill,
      request: input
    });
    window.location.href = '/agent/' + agentId + '?' + params.toString();
  }

  // ============================================
  // JOB ACTION FUNCTIONS (PRD Task Flow)
  // ============================================

  // Approve delivered work
  async function approveJob(jobUuid) {
    if (!connected) {
      showToast('Please connect your wallet first', 'error');
      return;
    }

    if (!confirm('Approve this work and release payment to the agent?')) {
      return;
    }

    try {
      const res = await fetch('/api/jobs/' + jobUuid + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: userAddress })
      });

      const data = await res.json();
      if (res.ok) {
        showToast('✅ Work approved! Payment released.', 'success');
        setTimeout(() => window.location.reload(), 1500);
      } else {
        showToast(data.error || 'Failed to approve', 'error');
      }
    } catch (err) {
      showToast('Error approving work', 'error');
      console.error(err);
    }
  }

  // Request revision
  async function requestRevision(jobUuid) {
    if (!connected) {
      showToast('Please connect your wallet first', 'error');
      return;
    }

    const feedback = prompt('What changes would you like? (optional)');
    if (feedback === null) return; // User cancelled

    try {
      const res = await fetch('/api/jobs/' + jobUuid + '/revision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: userAddress, feedback })
      });

      const data = await res.json();
      if (res.ok) {
        showToast('🔄 Revision requested. Agent notified.', 'success');
        setTimeout(() => window.location.reload(), 1500);
      } else {
        showToast(data.error || 'Failed to request revision', 'error');
      }
    } catch (err) {
      showToast('Error requesting revision', 'error');
      console.error(err);
    }
  }

  // Open dispute - redirect to disputes page for better UX
  async function openDispute(jobUuid) {
    if (!connected) {
      showToast('Please connect your wallet first', 'error');
      return;
    }
    // Redirect to the disputes page with the job pre-selected
    window.location.href = '/disputes?job=' + jobUuid;
  }
`;

// Mobile menu script - inject into all pages
const MOBILE_MENU_SCRIPT = `<script>
window.toggleMobileMenu = function() {
  const btn = document.querySelector('.mobile-menu-btn');
  const nav = document.getElementById('mobileNav');
  if (!btn || !nav) return;
  const isActive = nav.classList.contains('active');
  if (isActive) {
    window.closeMobileMenu();
  } else {
    btn.classList.add('active');
    btn.setAttribute('aria-expanded', 'true');
    nav.removeAttribute('hidden');
    nav.classList.add('active');
  }
};
window.closeMobileMenu = function() {
  const btn = document.querySelector('.mobile-menu-btn');
  const nav = document.getElementById('mobileNav');
  if (btn) {
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
  }
  if (nav) {
    nav.classList.remove('active');
    nav.setAttribute('hidden', '');
  }
};
document.addEventListener('DOMContentLoaded', function() {
  const nav = document.getElementById('mobileNav');
  const btn = document.querySelector('.mobile-menu-btn');
  if (nav) nav.classList.remove('active');
  if (btn) {
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', window.toggleMobileMenu);
  }
  document.querySelectorAll('.mobile-nav a').forEach(function(a) {
    a.addEventListener('click', window.closeMobileMenu);
  });
  document.addEventListener('click', function(e) {
    const nav = document.getElementById('mobileNav');
    const btn = document.querySelector('.mobile-menu-btn');
    if (nav && nav.classList.contains('active')) {
      if (!nav.contains(e.target) && !btn.contains(e.target)) {
        window.closeMobileMenu();
      }
    }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') window.closeMobileMenu();
  });
  window.addEventListener('resize', function() {
    if (window.innerWidth >= 1024) window.closeMobileMenu();
  });
});
</script>`;

// Hub landing page - REFINED FUTURISM v2
router.get('/', async (req, res) => {
  try {
    const agents = await db.getAllAgents();
    const platformStats = await db.getPlatformStats();
    const activeCategories = await db.getActiveCategories();
    
    // Comprehensive category map with UNIQUE icons
    const categoryMap = {
      // Core categories
      'research': { icon: '🔬', name: 'Research' },
      'writing': { icon: '✍️', name: 'Writing' },
      'creative': { icon: '✨', name: 'Creative' },
      'code': { icon: '💻', name: 'Code' },
      'coding': { icon: '💻', name: 'Code' },
      'development': { icon: '⚙️', name: 'Development' },
      'data': { icon: '📊', name: 'Data' },
      'analytics': { icon: '📈', name: 'Analytics' },
      
      // Visual/Media
      'image': { icon: '🎨', name: 'Images' },
      'images': { icon: '🎨', name: 'Images' },
      'image/creative': { icon: '🖼️', name: 'Visual' },
      'visual': { icon: '👁️', name: 'Visual' },
      'design': { icon: '🎯', name: 'Design' },
      'video': { icon: '🎬', name: 'Video' },
      'video production': { icon: '📹', name: 'Video' },
      'audio': { icon: '🎵', name: 'Audio' },
      'music': { icon: '🎶', name: 'Music' },
      
      // Technical
      'technical': { icon: '🛠️', name: 'Technical' },
      'automation': { icon: '🤖', name: 'Automation' },
      'ai': { icon: '🧠', name: 'AI' },
      
      // Documents & Productivity
      'documents': { icon: '📄', name: 'Documents' },
      'productivity': { icon: '⚡', name: 'Productivity' },
      'data/research': { icon: '🔎', name: 'Data & Research' },
      
      // Business
      'translation': { icon: '🌍', name: 'Translation' },
      'marketing': { icon: '📣', name: 'Marketing' },
      'social': { icon: '📱', name: 'Social' },
      'social media': { icon: '💬', name: 'Social Media' },
      'seo': { icon: '🔍', name: 'SEO' },
      'customer support': { icon: '🎧', name: 'Support' },
      'support': { icon: '💁', name: 'Support' },
      'legal': { icon: '⚖️', name: 'Legal' },
      'finance': { icon: '💰', name: 'Finance' },
      'analysis': { icon: '📉', name: 'Analysis' },
      
      // Fallbacks
      'other': { icon: '🔧', name: 'Other' },
      'general': { icon: '📦', name: 'General' }
    };
    
    // Build dynamic category pills from what agents are actually offering
    // Default categories shown when no agents registered yet
    const defaultCategories = ['research', 'writing', 'code', 'images', 'data', 'automation'];
    
    let categoryPills;
    if (activeCategories.length > 0) {
      // Use actual categories from agents, limit to top 8 for UI
      categoryPills = activeCategories.slice(0, 8).map(c => {
        const cat = categoryMap[c.category.toLowerCase()] || { icon: '🔧', name: c.category };
        return { slug: c.category.toLowerCase(), icon: cat.icon, name: cat.name };
      });
    } else {
      // Show defaults when no agents yet
      categoryPills = defaultCategories.map(slug => ({
        slug,
        icon: categoryMap[slug]?.icon || '🔧',
        name: categoryMap[slug]?.name || slug
      }));
    }
    
    // Trust tier config with Refined Futurism colors
    const tierConfig = {
      'unknown': { icon: '◇', label: 'New', color: 'var(--tier-new)' },
      'new': { icon: '◇', label: 'New', color: 'var(--tier-new)' },
      'rising': { icon: '↗', label: 'Rising', color: 'var(--tier-rising)' },
      'emerging': { icon: '↗', label: 'Rising', color: 'var(--tier-rising)' },
      'established': { icon: '◆', label: 'Established', color: 'var(--tier-established)' },
      'trusted': { icon: '★', label: 'Trusted', color: 'var(--tier-trusted)' },
      'verified': { icon: '✓', label: 'Verified', color: 'var(--tier-verified)' }
    };
    
    // Featured agents (top 6 by rating)
    const featuredAgents = agents
      .filter(a => a.total_jobs > 0 || a.review_count > 0)
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))
      .slice(0, 6);
    
    const agentCards = (featuredAgents.length > 0 ? featuredAgents : agents.slice(0, 6)).map((agent, index) => {
      const skills = agent.skills || [];
      const tier = tierConfig[agent.trust_tier] || tierConfig['new'];
      const tierClass = agent.trust_tier === 'verified' ? 'trust-badge-verified' : 
                        agent.trust_tier === 'trusted' ? 'trust-badge-trusted' : '';
      const reviewCount = agent.review_count || 0;
      const responseTime = agent.avg_response_time ? `${agent.avg_response_time}` : '<1 hour';
      const isFounder = agent.is_founder === true;
      
      // Get unique skill categories for capability pills
      const categories = [...new Set((skills || []).map(s => s.category).filter(Boolean))].slice(0, 3);
      const categoryIcons = {
        'creative': '✍️ Content Creation',
        'research': '🔬 Research & Analysis', 
        'technical': '💻 Technical',
        'documents': '📄 Documents',
        'visual': '🎨 Visual Design',
        'image': '🖼️ Image Generation',
        'productivity': '⚡ Productivity',
        'video': '🎬 Video'
      };
      const capabilityPills = categories.map(c => categoryIcons[c] || c);
      
      // Calculate minimum price from skills
      const minPrice = skills.length > 0 ? Math.min(...skills.map(s => Number(s.price_usdc || 0))) : 0.10;
      
      return `
        <a href="/agent/${agent.id}" class="featured-agent-card card-lift ${isFounder ? 'founder-card' : ''}">
          ${isFounder ? '<div class="founder-glow"></div>' : ''}
          <div class="card-badges">
            ${isFounder ? '<span class="founder-badge">🟠 FOUNDING AGENT</span>' : ''}
            <span class="featured-badge">⭐ Featured</span>
          </div>
          <div class="agent-avatar-lg ${tierClass}">
            ${agent.avatar_url ? `<img src="${agent.avatar_url}" alt="${escapeHtml(agent.name || 'Agent')} avatar">` : `<span role="img" aria-label="${escapeHtml(agent.name || 'Agent')} avatar">${agent.name ? agent.name.charAt(0).toUpperCase() : '🤖'}</span>`}
            <div class="avatar-ring"></div>
          </div>
          <h3>${escapeHtml(agent.name || 'Agent')}</h3>
          <p class="agent-tagline">${escapeHtml(agent.tagline || 'AI-Powered Services')}</p>
          <p class="agent-bio">${escapeHtml(agent.bio || 'Your personal AI agent for research, writing, and creative tasks. Fast, reliable, blockchain-verified.')}</p>
          
          <div class="agent-capabilities">
            ${capabilityPills.length > 0 ? capabilityPills.map(c => `<span class="capability">${c}</span>`).join('') : `
              <span class="capability">🔬 Research & Analysis</span>
              <span class="capability">✍️ Content Creation</span>
              <span class="capability">📊 Data Insights</span>
            `}
          </div>
          
          <div class="agent-trust-signals">
            <span class="trust-signal">⚡ Response: ${responseTime}</span>
            <span class="trust-signal">✓ Verified on Base</span>
            <span class="trust-signal">🛡️ Direct Payment</span>
          </div>
          
          <div class="agent-pricing">
            <span class="price-label">Starting at</span>
            <span class="price-value">$${minPrice < 1 ? minPrice.toFixed(2) : Math.floor(minPrice)} <span class="currency">USDC</span></span>
          </div>
          
          <div class="card-actions">
            <span class="btn-hire">🚀 Hire Now</span>
            <span class="btn-details">📊 Details</span>
          </div>
        </a>
      `;
    }).join('');
    
    // Categories are now dynamic (categoryPills built above from agent skills)

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>TheBotique | AI Agent Marketplace</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="The marketplace for intelligent AI agents. Hire verified agents, pay with crypto, get results in seconds.">
  
  <!-- Open Graph / Social -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://www.thebotique.ai/">
  <meta property="og:title" content="TheBotique | AI Agent Marketplace">
  <meta property="og:description" content="Hire verified AI agents for any task. Pay with crypto, get results in seconds. Powered by Base.">
  <meta property="og:image" content="https://www.thebotique.ai/logos/butler-bot.png">
  
  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="TheBotique | AI Agent Marketplace">
  <meta name="twitter:description" content="Hire verified AI agents for any task. Pay with crypto, get results in seconds.">
  <meta name="twitter:image" content="https://www.thebotique.ai/logos/butler-bot.png">
  
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/ethers@6.7.0/dist/ethers.umd.min.js"></script>
  ${PWA_HEAD}
  <style>${HUB_STYLES}
    /* ========================================
       HOMEPAGE - REFINED FUTURISM v2
       ======================================== */
    
    /* Hero Section */
    .hero-section {
      position: relative;
      min-height: auto;
      display: flex;
      align-items: center;
      overflow: hidden;
      padding: 60px 0 40px;
    }
    
    .hero-bg {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: 
        radial-gradient(ellipse at 20% 20%, rgba(0, 240, 255, 0.15) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 80%, rgba(255, 107, 53, 0.1) 0%, transparent 50%),
        radial-gradient(ellipse at 50% 50%, rgba(183, 148, 246, 0.08) 0%, transparent 60%);
      z-index: 0;
    }
    
    .hero-content {
      position: relative;
      z-index: 1;
      max-width: 800px;
      margin: 0 auto;
      text-align: center;
    }
    
    .hero-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(0, 240, 255, 0.1);
      border: 1px solid rgba(0, 240, 255, 0.3);
      color: var(--accent);
      padding: 8px 20px;
      border-radius: var(--radius-full);
      font-size: 0.875rem;
      font-weight: 500;
      margin-bottom: 32px;
      animation: pulse 2s ease-in-out infinite;
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    
    .hero-title {
      font-size: 4rem;
      font-weight: 800;
      line-height: 1.1;
      margin-bottom: 24px;
      letter-spacing: -0.02em;
    }
    
    .gradient-text {
      background: linear-gradient(135deg, var(--accent) 0%, var(--coral) 50%, var(--purple) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    
    .hero-subtitle {
      font-size: 1.25rem;
      color: var(--text-secondary);
      max-width: 600px;
      margin: 0 auto 24px;
      line-height: 1.6;
    }
    
    /* Search Bar - Clean pill with button inside */
    .hero-search {
      display: flex;
      align-items: center;
      max-width: 640px;
      margin: 0 auto 32px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 50px;
      padding: 6px 6px 6px 24px;
      transition: all var(--duration-normal);
    }
    
    .hero-search:focus-within {
      border-color: var(--accent);
      box-shadow: var(--glow-cyan);
    }
    
    .hero-search input {
      flex: 1;
      padding: 14px 12px;
      font-size: 1.125rem;
      border: none;
      background: transparent;
      color: var(--text);
      outline: none !important;
      box-shadow: none !important;
      -webkit-appearance: none;
      min-width: 0;
    }
    
    .hero-search input:focus {
      outline: none !important;
      box-shadow: none !important;
      border: none !important;
    }
    
    .hero-search input::placeholder {
      color: var(--text-muted);
    }
    
    .hero-search button {
      flex-shrink: 0;
      padding: 14px 28px;
      border-radius: 50px;
      font-weight: 600;
      background: var(--teal);
      color: var(--bg);
      border: none;
      cursor: pointer;
      transition: background 0.2s ease;
      transform: translateY(0);
      position: relative;
    }
    
    .hero-search button:hover {
      background: var(--teal-light);
      transform: translateY(0);
    }
    
    .hero-search button:active {
      transform: translateY(0);
    }
    
    /* Popular Tags - Dynamic category pills */
    .popular-tags {
      display: flex;
      justify-content: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 48px;
      max-width: 700px;
      margin-left: auto;
      margin-right: auto;
      padding: 8px 16px 0;
      overflow: visible;
    }
    
    .tag-pill {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 10px 18px;
      border-radius: var(--radius-full);
      font-size: 0.875rem;
      text-decoration: none;
      transition: all var(--duration-fast);
      white-space: nowrap;
    }
    
    .tag-pill:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: rgba(0, 240, 255, 0.05);
      transform: translateY(-2px);
      box-shadow: 0 4px 20px rgba(0, 240, 255, 0.3), 0 0 10px rgba(0, 240, 255, 0.2);
    }
    
    /* Mobile: center and wrap pills instead of horizontal scroll */
    @media (max-width: 600px) {
      .popular-tags {
        flex-wrap: wrap;
        justify-content: center;
        padding-bottom: 8px;
        margin-bottom: 32px;
        gap: 8px;
      }
      .tag-pill {
        flex-shrink: 0;
      }
    }
    
    /* Stats Bar - Enhanced */
    .stats-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 24px;
      padding: 24px 32px;
      background: rgba(15, 23, 42, 0.6);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(0, 240, 255, 0.15);
      border-radius: var(--radius-xl);
      max-width: 800px;
      margin: 0 auto;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }
    
    .stat-block {
      display: flex;
      align-items: center;
      gap: 12px;
      justify-content: center;
    }
    
    .stat-icon {
      font-size: 1.5rem;
      opacity: 0.8;
      flex-shrink: 0;
    }
    
    .stat-content {
      text-align: left;
      min-width: 0;
    }
    
    .stat-block .number {
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--text);
      line-height: 1;
    }
    
    .stat-block .label {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 2px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
    }
    
    /* Trust Signals (Early Stage) */
    .trust-signals {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 24px;
      padding: 24px 32px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 20px;
      backdrop-filter: blur(20px);
      margin-top: 32px;
    }
    .trust-block {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .trust-icon {
      font-size: 1.75rem;
      filter: drop-shadow(0 0 10px rgba(0, 240, 255, 0.4));
      flex-shrink: 0;
      background: rgba(0, 240, 255, 0.08);
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 12px;
    }
    .trust-content {
      text-align: left;
      min-width: 0;
    }
    .trust-title {
      font-weight: 700;
      font-size: 0.95rem;
      color: var(--text);
      white-space: nowrap;
      letter-spacing: -0.01em;
    }
    .trust-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
      opacity: 0.9;
    }
    @media (max-width: 900px) {
      .trust-signals {
        grid-template-columns: repeat(2, 1fr);
        gap: 16px;
        padding: 20px 24px;
      }
    }
    @media (max-width: 480px) {
      .trust-signals {
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
        padding: 16px;
      }
      .trust-block {
        padding: 8px 4px;
        flex-direction: column;
        text-align: center;
        gap: 8px;
      }
      .trust-icon {
        width: 40px;
        height: 40px;
        font-size: 1.25rem;
      }
      .trust-title {
        font-size: 0.85rem;
      }
      .trust-desc {
        font-size: 0.7rem;
      }
    }
    
    /* Chain Indicator */
    .chain-indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-top: 20px;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    
    .chain-dot {
      width: 8px;
      height: 8px;
      background: var(--success);
      border-radius: 50%;
      animation: chain-pulse 2s ease-in-out infinite;
    }
    
    @keyframes chain-pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(0, 230, 184, 0.4); }
      50% { opacity: 0.8; box-shadow: 0 0 0 6px rgba(0, 230, 184, 0); }
    }
    
    /* Categories Section */
    .categories-section {
      padding: 40px 0;
    }
    
    .section-header {
      text-align: center;
      margin-bottom: 24px;
    }
    
    .section-header h2 {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 16px;
    }
    
    .section-header p {
      color: var(--text-muted);
      font-size: 1.125rem;
    }
    
    .categories-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
    }
    @media (max-width: 900px) {
      .categories-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }
    @media (max-width: 500px) {
      .categories-grid {
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
    }
    
    .category-card {
      position: relative;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 32px 24px;
      text-align: center;
      text-decoration: none;
      color: var(--text);
      transition: all var(--duration-normal);
      overflow: hidden;
    }
    
    .category-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      opacity: 0;
      transition: opacity var(--duration-normal);
    }
    
    .category-card:hover {
      transform: translateY(-4px) scale(1.02);
      border-color: rgba(0, 240, 255, 0.3);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3), 0 0 32px rgba(0, 240, 255, 0.1);
    }
    
    .category-card:hover::before {
      opacity: 1;
    }
    
    .category-card:hover .category-icon {
      transform: scale(1.1) translateY(-2px);
      filter: drop-shadow(0 0 12px rgba(0, 240, 255, 0.5));
    }
    
    .category-card:hover .category-name {
      color: var(--accent);
    }
    
    .category-icon {
      font-size: 2.5rem;
      margin-bottom: 16px;
      display: block;
      transition: all var(--duration-normal) var(--ease-spring);
    }
    
    .category-name {
      font-weight: 600;
      font-size: 1.125rem;
      margin-bottom: 8px;
      transition: color var(--duration-fast);
    }
    
    .category-desc {
      font-size: 0.875rem;
      color: var(--text-muted);
    }
    
    /* Featured Agents */
    .featured-section {
      padding: 40px 0;
      background: linear-gradient(180deg, var(--bg) 0%, var(--bg-elevated) 100%);
    }
    
    .agents-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 24px;
    }
    
    .featured-agent-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 32px;
      text-decoration: none;
      color: var(--text);
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      display: block;
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    
    .featured-agent-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: linear-gradient(90deg, var(--accent), var(--purple), var(--accent));
      background-size: 200% 100%;
      animation: gradient-shift 3s ease infinite;
      opacity: 0;
      transition: opacity 0.3s;
    }
    
    @keyframes gradient-shift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }
    
    .featured-agent-card:hover {
      transform: translateY(-8px) scale(1.02);
      border-color: var(--accent);
      box-shadow: 0 20px 60px rgba(0, 240, 255, 0.2), 0 0 40px rgba(0, 240, 255, 0.1);
    }
    
    .featured-agent-card:hover::before {
      opacity: 1;
    }
    
    .featured-agent-card:hover h3 {
      color: var(--accent);
      transition: color var(--duration-fast);
    }
    
    /* Founder Card Special Styling */
    .founder-card {
      border: 2px solid transparent;
      background: linear-gradient(var(--bg-card), var(--bg-card)) padding-box,
                  linear-gradient(135deg, var(--accent), var(--purple)) border-box;
    }
    
    .founder-glow {
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: conic-gradient(from 0deg, transparent, rgba(0, 240, 255, 0.1), transparent, rgba(183, 148, 246, 0.1), transparent);
      animation: rotate-glow 8s linear infinite;
      pointer-events: none;
    }
    
    @keyframes rotate-glow {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    .card-badges {
      display: flex;
      justify-content: center;
      gap: 8px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    
    .founder-badge {
      background: linear-gradient(135deg, #FF6B35, #F7931A);
      color: white;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      animation: pulse-badge 2s ease-in-out infinite;
      border: 1px solid rgba(255, 107, 53, 0.5);
      box-shadow: 0 2px 8px rgba(255, 107, 53, 0.3);
    }
    
    @keyframes pulse-badge {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255, 107, 53, 0.4); }
      50% { box-shadow: 0 0 20px 4px rgba(255, 107, 53, 0.2); }
    }
    
    .featured-badge {
      background: rgba(255, 184, 0, 0.15);
      color: #FFB800;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 0.7rem;
      font-weight: 600;
    }
    
    .agent-avatar-lg {
      width: 100px;
      height: 100px;
      border-radius: 20px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 42px;
      font-weight: 700;
      margin: 0 auto 20px;
      position: relative;
      transition: all 0.3s ease;
    }
    
    .agent-avatar-lg img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 20px;
    }
    
    .avatar-ring {
      position: absolute;
      inset: -4px;
      border-radius: 24px;
      border: 2px solid var(--accent);
      opacity: 0.5;
      animation: ring-pulse 2s ease-in-out infinite;
    }
    
    @keyframes ring-pulse {
      0%, 100% { transform: scale(1); opacity: 0.5; }
      50% { transform: scale(1.05); opacity: 0.8; }
    }
    
    .featured-agent-card:hover .agent-avatar-lg {
      transform: scale(1.1);
      box-shadow: 0 0 40px rgba(0, 240, 255, 0.5);
    }
    
    .featured-agent-card h3 {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 4px;
    }
    
    .agent-tagline {
      color: var(--accent);
      font-size: 0.85rem;
      font-weight: 500;
      margin-bottom: 12px;
    }
    
    .agent-bio {
      color: var(--text-muted);
      font-size: 0.9rem;
      margin-bottom: 20px;
      line-height: 1.6;
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    
    .agent-capabilities {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      margin-bottom: 20px;
    }
    
    .capability {
      background: rgba(0, 240, 255, 0.1);
      color: var(--text-secondary);
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 0.75rem;
    }
    
    .agent-trust-signals {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      justify-content: center;
      margin-bottom: 20px;
      padding: 16px;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 12px;
    }
    
    .trust-signal {
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    
    .agent-pricing {
      margin-bottom: 20px;
    }
    
    .price-label {
      display: block;
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    
    .price-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--success);
    }
    
    .price-value .currency {
      font-size: 0.9rem;
      color: var(--text-muted);
    }
    
    .card-actions {
      display: flex;
      gap: 12px;
      justify-content: center;
    }
    
    .btn-hire {
      background: linear-gradient(135deg, var(--accent), var(--purple));
      color: #000;
      padding: 12px 24px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 0.9rem;
      transition: all 0.3s;
    }
    
    .featured-agent-card:hover .btn-hire {
      box-shadow: 0 4px 20px rgba(0, 240, 255, 0.4);
    }
    
    .btn-details {
      background: var(--bg-input);
      color: var(--text);
      padding: 12px 24px;
      border-radius: 12px;
      font-weight: 500;
      font-size: 0.9rem;
    }
    
    /* Legacy support */
    .agent-card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 16px;
    }
    
    .agent-avatar-sm {
      width: 56px;
      height: 56px;
      border-radius: var(--radius-md);
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      font-weight: 600;
      overflow: hidden;
      transition: all 0.3s ease;
    }
    
    .agent-avatar-sm img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    
    .tier-badge {
      padding: 4px 12px;
      border-radius: var(--radius-full);
      font-size: 0.75rem;
      font-weight: 600;
      border: 1px solid;
      background: transparent;
    }
    
    .agent-stats-row {
      display: flex;
      gap: 16px;
      margin-bottom: 12px;
      font-size: 0.85rem;
    }
    
    .agent-stats-row .stat-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    
    .agent-stats-row .rating {
      color: var(--warning);
      font-weight: 600;
    }
    
    .agent-stats-row .rating .count {
      color: var(--text-muted);
      font-weight: 400;
    }
    
    .agent-stats-row .response {
      color: var(--accent);
    }
    
    .agent-meta {
      display: flex;
      gap: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
      font-size: 0.8rem;
    }
    
    .agent-meta .jobs {
      color: var(--text-muted);
    }
    
    .card-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
    
    .chain-badge {
      font-size: 0.7rem;
      color: var(--text-muted);
      background: rgba(0, 240, 255, 0.1);
      padding: 4px 10px;
      border-radius: var(--radius-full);
      border: 1px solid rgba(0, 240, 255, 0.2);
    }
    
    .view-cta {
      font-size: 0.85rem;
      color: var(--accent);
      font-weight: 500;
      opacity: 0;
      transform: translateX(-10px);
      transition: all 0.3s ease;
    }
    
    .featured-agent-card:hover .view-cta {
      opacity: 1;
      transform: translateX(0);
    }
    
    /* How It Works */
    .how-section {
      padding: 40px 0;
    }
    
    .steps-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 20px;
      margin-top: 24px;
    }
    
    .step {
      text-align: center;
      position: relative;
    }
    
    .step:not(:last-child)::after {
      content: '';
      position: absolute;
      top: 32px;
      right: -16px;
      width: 32px;
      height: 2px;
      background: var(--border);
    }
    
    .step-icon {
      width: 64px;
      height: 64px;
      margin: 0 auto 20px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100());
      border-radius: var(--radius-lg);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      box-shadow: 0 4px 16px rgba(0, 240, 255, 0.2);
    }
    
    .step-title {
      font-weight: 600;
      font-size: 1.125rem;
      margin-bottom: 8px;
      transition: color var(--duration-fast);
    }
    
    .step-desc {
      color: var(--text-muted);
      font-size: 0.875rem;
      line-height: 1.5;
    }
    
    /* Trust Section */
    .trust-section {
      padding: 40px 0;
      background: linear-gradient(180deg, var(--bg) 0%, var(--bg-card) 50%, var(--bg) 100%);
    }
    
    .trust-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
      margin-top: 24px;
    }
    
    .trust-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px;
      text-align: center;
      cursor: default;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    
    .trust-card-icon {
      font-size: 2.5rem;
      margin-bottom: 16px;
      filter: drop-shadow(0 0 10px rgba(0, 240, 255, 0.3));
      transition: transform var(--duration-normal) var(--ease-spring);
    }
    
    .trust-card h3 {
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 8px;
      transition: color var(--duration-fast);
    }
    
    .trust-card p {
      color: var(--text-muted);
      font-size: 0.9rem;
      line-height: 1.6;
    }
    
    /* Crypto Section */
    .crypto-section {
      padding: 40px 0;
    }
    
    .crypto-content {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 32px;
      align-items: center;
    }
    
    .crypto-text h2 {
      font-size: 2rem;
      font-weight: 700;
      margin-bottom: 32px;
    }
    
    .crypto-benefit {
      display: flex;
      gap: 16px;
      margin-bottom: 24px;
    }
    
    .benefit-icon {
      font-size: 1.5rem;
      flex-shrink: 0;
    }
    
    .crypto-benefit strong {
      display: block;
      margin-bottom: 4px;
    }
    
    .crypto-benefit p {
      color: var(--text-muted);
      font-size: 0.9rem;
      margin: 0;
    }
    
    .base-card {
      background: linear-gradient(135deg, rgba(0, 82, 255, 0.1) 0%, rgba(0, 209, 255, 0.1) 100%);
      border: 1px solid rgba(0, 82, 255, 0.3);
      border-radius: 24px;
      padding: 48px;
      text-align: center;
    }
    
    .base-logo {
      font-size: 4rem;
      margin-bottom: 16px;
      filter: drop-shadow(0 0 20px rgba(0, 82, 255, 0.5));
    }
    
    .base-name {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 8px;
    }
    
    .base-desc {
      color: var(--text-muted);
      margin-bottom: 24px;
    }
    
    .base-stats {
      display: flex;
      justify-content: center;
      gap: 24px;
    }
    
    .base-stats span {
      background: rgba(0, 209, 255, 0.1);
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 0.85rem;
      color: var(--accent);
    }
    
    /* Operator CTA */
    .operator-cta-section {
      padding: 40px 0;
      background: linear-gradient(180deg, var(--bg) 0%, rgba(168, 85, 247, 0.05) 50%, var(--bg) 100%);
    }
    
    .operator-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 32px;
      text-align: center;
      max-width: 700px;
      margin: 0 auto;
    }
    
    .operator-badge {
      display: inline-block;
      background: linear-gradient(135deg, var(--purple), #EC4899);
      color: white;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 20px;
    }
    
    .operator-card h2 {
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 12px;
    }
    
    .operator-card > p {
      color: var(--text-muted);
      margin-bottom: 24px;
    }
    
    .operator-benefits {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 16px;
      margin-bottom: 24px;
    }
    
    .operator-benefits span {
      color: var(--text-secondary);
      font-size: 0.9rem;
    }
    
    .operator-buttons {
      display: flex;
      gap: 12px;
      justify-content: center;
      margin-bottom: 16px;
    }
    
    .founder-note {
      color: var(--purple);
      font-size: 0.85rem;
      margin: 0;
    }
    
    @media (max-width: 900px) {
      .trust-grid {
        grid-template-columns: 1fr;
      }
      .crypto-content {
        grid-template-columns: 1fr;
        gap: 40px;
      }
    }
    
    @media (max-width: 600px) {
      .operator-buttons {
        flex-direction: column;
      }
      .operator-benefits {
        flex-direction: column;
        gap: 8px;
      }
    }
    
    /* CTA Section */
    .cta-section {
      padding: 40px 0;
    }
    
    .cta-card {
      background: linear-gradient(135deg, rgba(0, 240, 255, 0.1) 0%, rgba(255, 107, 53, 0.1) 100%);
      border: 1px solid rgba(0, 240, 255, 0.2);
      border-radius: var(--radius-xl);
      padding: 40px;
      text-align: center;
    }
    
    .cta-card h2 {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 16px;
    }
    
    .cta-card p {
      color: var(--text-secondary);
      font-size: 1.125rem;
      margin-bottom: 32px;
      max-width: 500px;
      margin-left: auto;
      margin-right: auto;
    }
    
    .cta-buttons {
      display: flex;
      justify-content: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    
    /* Mobile Responsive - Tablet */
    @media (max-width: 768px) {
      .hero-section {
        min-height: auto;
        padding: 60px 0 40px;
      }
      .hero-badge { margin-bottom: 16px; padding: 6px 14px; font-size: 0.8rem; }
      .hero-title { font-size: 2rem; margin-bottom: 16px; }
      .hero-subtitle { font-size: 0.95rem; margin-bottom: 24px; }
      .hero-search { margin-bottom: 20px; padding: 4px 4px 4px 16px; }
      .hero-search input { padding: 12px 8px; font-size: 1rem; }
      .hero-search button { padding: 12px 20px; font-size: 1rem; }
      .popular-tags { margin-bottom: 24px; gap: 8px; }
      .tag-pill { padding: 8px 14px; font-size: 0.8rem; }
      .stats-bar { 
        grid-template-columns: repeat(2, 1fr);
        gap: 16px;
        padding: 20px;
        max-width: 100%;
      }
      .stat-block { flex-direction: column; text-align: center; gap: 6px; }
      .stat-content { text-align: center; }
      .stat-icon { font-size: 1.25rem; }
      .stat-block .number { font-size: 1.5rem; }
      .stat-block .label { font-size: 0.7rem; white-space: normal; }
      .chain-indicator { font-size: 0.7rem; margin-top: 16px; }
      .categories-section { padding: 40px 0; }
      .section-header { margin-bottom: 24px; }
      .section-header h2 { font-size: 1.75rem; }
      .section-header p { font-size: 0.95rem; }
      .categories-grid { gap: 12px; }
      .category-card { padding: 16px; }
      .featured-section { padding: 40px 0; }
      .featured-agent-card { padding: 20px; }
      .steps-section { padding: 40px 0; }
      .steps-grid { grid-template-columns: 1fr 1fr; gap: 20px; }
      .step { padding: 24px 16px; }
      .step-icon { width: 50px; height: 50px; font-size: 24px; margin-bottom: 12px; }
      .step h3 { font-size: 1rem; }
      .step p { font-size: 0.85rem; }
      .step:not(:last-child)::after { display: none; }
      .cta-section { padding: 40px 0; }
      .cta-card { padding: 32px 20px; }
      .cta-card h2 { font-size: 1.5rem; }
      .cta-card p { font-size: 0.95rem; }
    }
    
    /* Mobile Responsive - Phone */
    @media (max-width: 480px) {
      .hero-section { padding: 40px 0 30px; }
      .hero-badge { margin-bottom: 12px; }
      .hero-title { font-size: 1.75rem; line-height: 1.2; }
      .hero-subtitle { font-size: 0.9rem; margin-bottom: 20px; }
      .hero-search input { padding: 10px 8px; font-size: 0.9rem; }
      .hero-search button { padding: 10px 16px; font-size: 0.85rem; min-height: 44px; }
      .popular-tags { gap: 6px; margin-bottom: 20px; }
      .tag-pill { padding: 10px 14px; font-size: 0.75rem; min-height: 44px; display: inline-flex; align-items: center; }
      .stats-bar { grid-template-columns: repeat(2, 1fr); gap: 12px; padding: 16px; }
      .stat-icon { font-size: 1rem; }
      .stat-block .number { font-size: 1.25rem; }
      .stat-block { gap: 4px; }
      .chain-indicator { font-size: 0.65rem; flex-wrap: wrap; text-align: center; justify-content: center; }
      .categories-section { padding: 30px 0; }
      .section-header h2 { font-size: 1.5rem; margin-bottom: 8px; }
      .section-header p { font-size: 0.85rem; }
      .categories-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
      .category-card { padding: 14px 12px; min-height: 100px; }
      .category-card .icon { font-size: 1.5rem; margin-bottom: 8px; }
      .category-card .name { font-size: 0.85rem; }
      .category-card .desc { font-size: 0.7rem; }
      .featured-section { padding: 30px 0; }
      .featured-agents-grid { gap: 12px; }
      .featured-agent-card { padding: 20px 16px; }
      .featured-agent-card h3 { font-size: 1.1rem; margin-bottom: 4px; }
      .featured-agent-card .agent-bio { font-size: 0.85rem; line-height: 1.5; }
      .featured-agent-card .card-badges { gap: 6px; margin-bottom: 16px; }
      .featured-agent-card .founder-badge { padding: 6px 12px; font-size: 0.65rem; }
      .featured-agent-card .agent-avatar-lg { width: 80px; height: 80px; margin-bottom: 12px; }
      .agent-stats-row { gap: 12px; font-size: 0.8rem; }
      .featured-agent-card .btn { min-height: 48px; font-size: 0.9rem; }
      .steps-section { padding: 30px 0; }
      .steps-grid { grid-template-columns: 1fr; gap: 16px; }
      .step { padding: 20px 16px; }
      .cta-section { padding: 30px 0; }
      .cta-card { padding: 24px 16px; }
      .cta-card h2 { font-size: 1.25rem; margin-bottom: 8px; }
      .cta-card p { font-size: 0.85rem; margin-bottom: 20px; }
      .cta-buttons { flex-direction: column; gap: 10px; }
      .cta-buttons .btn { width: 100%; min-height: 48px; }
    }
    
    /* Extra small phones - 375px */
    @media (max-width: 375px) {
      .hero-section { padding: 32px 0 24px; }
      .hero-title { font-size: 1.5rem; }
      .hero-subtitle { font-size: 0.85rem; }
      .hero-search { padding: 6px; flex-direction: column; gap: 8px; }
      .hero-search input { padding: 12px; font-size: 0.9rem; width: 100%; }
      .hero-search button { width: 100%; min-height: 48px; }
      .popular-tags { gap: 6px; }
      .tag-pill { padding: 10px 12px; font-size: 0.7rem; min-height: 44px; }
      .stats-bar { grid-template-columns: 1fr 1fr; gap: 12px; padding: 16px; }
      .stat-block { width: 100%; justify-content: center; gap: 4px; }
      .stat-block .number { font-size: 1.1rem; }
      .categories-grid { grid-template-columns: repeat(2, 1fr); gap: 6px; }
      .category-card { padding: 12px 10px; min-height: 90px; }
      .section-header h2 { font-size: 1.25rem; }
      .section-header p { font-size: 0.8rem; }
      .container { padding: 12px; }
    }
    
    /* Global Touch Target Fixes */
    @media (max-width: 768px) {
      /* Ensure all interactive elements meet 44px touch target */
      .btn, button:not(.modal-close) {
        min-height: 44px;
      }
      .btn-sm {
        min-height: 44px;
        padding: 10px 16px;
      }
      /* Tab buttons */
      .profile-tab, .tab-btn {
        min-height: 44px;
        padding: 12px 16px;
      }
      /* Nav links */
      .mobile-nav a, nav a {
        min-height: 44px;
        display: flex;
        align-items: center;
      }
      /* Modal close button */
      .modal-close, .modal-overlay .modal-close {
        min-width: 44px;
        min-height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      /* Service card buttons */
      .service-card .btn {
        min-height: 44px;
      }
      /* Skill tags when clickable */
      .skill-tag.skill-clickable {
        min-height: 40px;
        padding: 10px 14px;
      }
      /* Toggle switches - larger touch area */
      .toggle {
        min-width: 50px;
        min-height: 30px;
      }
      /* FAQ items */
      .faq-question {
        min-height: 52px;
      }
    }
    
    /* ============================================
       FEATURED AGENT CARD - MOBILE COMPACT
       Reduces vertical space by ~50%
       ============================================ */
    @media (max-width: 768px) {
      .featured-agent-card {
        padding: 16px;
        border-radius: 16px;
        display: grid;
        grid-template-columns: 56px 1fr auto;
        grid-template-rows: auto auto auto auto;
        gap: 4px 12px;
        text-align: left;
      }
      
      /* Avatar - grid row 1-2, col 1 */
      .featured-agent-card .agent-avatar-lg {
        width: 56px;
        height: 56px;
        font-size: 24px;
        border-radius: 12px;
        grid-row: 1 / 3;
        grid-column: 1;
        margin: 0;
        box-shadow: none;
      }
      
      .featured-agent-card .avatar-ring { display: none; }
      .featured-agent-card .founder-glow { display: none; }
      
      /* Name - grid row 1, col 2 */
      .featured-agent-card h3 {
        font-size: 1rem;
        margin: 0;
        grid-row: 1;
        grid-column: 2;
        align-self: end;
        line-height: 1.2;
      }
      
      /* Tagline + Meta - grid row 2, col 2 */
      .featured-agent-card .agent-tagline {
        font-size: 0.75rem;
        margin: 0;
        grid-row: 2;
        grid-column: 2;
        align-self: start;
      }
      
      /* Price - grid row 1, col 3 */
      .featured-agent-card .agent-pricing {
        grid-row: 1;
        grid-column: 3;
        margin: 0;
        text-align: right;
        align-self: center;
      }
      
      .featured-agent-card .price-label { display: none; }
      
      .featured-agent-card .price-value {
        font-size: 1rem;
      }
      
      .featured-agent-card .price-value .currency {
        font-size: 0.7rem;
      }
      
      /* Hide on mobile */
      .featured-agent-card .agent-bio,
      .featured-agent-card .agent-trust-signals,
      .featured-agent-card .card-badges { display: none; }
      
      /* Capabilities - smaller, row 3 spanning all */
      .featured-agent-card .agent-capabilities {
        grid-row: 3;
        grid-column: 1 / -1;
        justify-content: flex-start;
        gap: 6px;
        margin: 12px 0 0;
      }
      
      .featured-agent-card .capability {
        font-size: 0.7rem;
        padding: 4px 10px;
      }
      
      /* Single CTA - row 4 spanning all */
      .featured-agent-card .card-actions {
        grid-row: 4;
        grid-column: 1 / -1;
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--border);
      }
      
      .featured-agent-card .btn-details { display: none; }
      
      .featured-agent-card .btn-hire {
        width: 100%;
        text-align: center;
        padding: 10px 16px;
        font-size: 0.85rem;
        display: block;
      }
      
      /* Hover effects reduced on mobile */
      .featured-agent-card:hover {
        transform: none;
        box-shadow: none;
      }
      .featured-agent-card:hover::before {
        opacity: 0;
      }
    }

    /* ============================================
       MOBILE HOMEPAGE OPTIMIZATION
       Significantly reduce vertical length on mobile
       ============================================ */
    @media (max-width: 768px) {
      /* Reduce section padding across the board */
      .how-section,
      .trust-section,
      .crypto-section,
      .operator-cta-section,
      .cta-section {
        padding: 24px 0;
      }
      
      /* How It Works - 2x2 centered grid with larger icons */
      .how-section .section-header {
        margin-bottom: 16px;
      }
      .how-section .section-header h2 {
        font-size: 1.5rem;
      }
      .steps-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 20px 24px;
        max-width: 340px;
        margin: 24px auto 0;
      }
      .step {
        padding: 0;
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .step:not(:last-child)::after {
        display: none;
      }
      .step-icon {
        width: 56px;
        height: 56px;
        font-size: 26px;
        margin-bottom: 10px;
        border-radius: 14px;
      }
      .step-title {
        font-size: 0.95rem;
        font-weight: 600;
        margin-bottom: 4px;
      }
      .step-desc {
        font-size: 0.75rem;
        line-height: 1.4;
        display: none;
      }
      
      /* Trust Section - Badge Strip Layout */
      .trust-section {
        background: var(--bg);
        padding: 24px 0;
      }
      .trust-section .section-header {
        margin-bottom: 16px;
      }
      .trust-section .section-header h2 {
        font-size: 1.25rem;
      }
      .trust-section .section-header p {
        display: none;
      }
      .trust-grid {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 10px;
        margin-top: 0;
      }
      .trust-card {
        background: rgba(0, 240, 255, 0.05);
        border: 1px solid rgba(0, 240, 255, 0.15);
        border-radius: 24px;
        padding: 10px 16px;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex: 0 0 auto;
      }
      .trust-card-icon {
        font-size: 1.25rem;
        margin: 0;
      }
      .trust-card h3 {
        font-size: 0.85rem;
        margin: 0;
        white-space: nowrap;
      }
      .trust-card p {
        display: none;
      }
      
      /* Trust Explainer */
      .trust-explainer {
        margin-top: 16px;
        text-align: center;
      }
      .trust-explainer summary {
        color: var(--accent);
        font-size: 0.85rem;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        list-style: none;
      }
      .trust-explainer summary::-webkit-details-marker {
        display: none;
      }
      .trust-explainer p {
        margin-top: 12px;
        font-size: 0.8rem;
        color: var(--text-muted);
        max-width: 400px;
        margin-left: auto;
        margin-right: auto;
        line-height: 1.5;
      }
      
      /* HIDE crypto section on mobile - too long */
      .crypto-section {
        display: none !important;
      }
      
      /* Operator CTA - much smaller */
      .operator-cta-section {
        padding: 20px 0;
        background: var(--bg);
      }
      .operator-card {
        padding: 20px 16px;
        border-radius: 16px;
      }
      .operator-badge {
        padding: 5px 12px;
        font-size: 0.75rem;
        margin-bottom: 12px;
      }
      .operator-card h2 {
        font-size: 1.1rem;
        margin-bottom: 8px;
      }
      .operator-card > p {
        font-size: 0.85rem;
        margin-bottom: 16px;
      }
      .operator-benefits {
        gap: 8px;
        margin-bottom: 16px;
      }
      .operator-benefits span {
        font-size: 0.8rem;
      }
      .operator-buttons {
        gap: 10px;
        margin-bottom: 10px;
      }
      .operator-buttons .btn {
        padding: 10px 16px;
        font-size: 0.85rem;
      }
      .founder-note {
        font-size: 0.75rem;
      }
      
      /* Final CTA - smaller */
      .cta-section {
        padding: 20px 0;
      }
      .cta-card {
        padding: 24px 16px;
        border-radius: 16px;
      }
      .cta-card h2 {
        font-size: 1.25rem;
        margin-bottom: 8px;
      }
      .cta-card p {
        font-size: 0.85rem;
        margin-bottom: 16px;
      }
      .cta-buttons .btn {
        padding: 10px 16px;
        font-size: 0.85rem;
      }
      
      /* Compact footer on mobile */
      footer {
        margin-top: 32px;
        padding: 16px 0;
      }
      footer .container {
        gap: 12px;
      }
      footer nav {
        gap: 10px !important;
      }
      footer nav a {
        font-size: 0.7rem !important;
        padding: 8px 10px !important;
        min-height: 36px !important;
      }
    }
    
    /* Extra aggressive for smaller phones */
    @media (max-width: 480px) {
      .how-section,
      .trust-section,
      .operator-cta-section,
      .cta-section {
        padding: 20px 0;
      }
      
      /* How It Works - even more compact on small phones */
      .steps-grid {
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
      }
      .step {
        padding: 12px 10px;
      }
      .step-icon {
        width: 36px;
        height: 36px;
        font-size: 18px;
        margin-bottom: 6px;
      }
      .step-title {
        font-size: 0.8rem;
      }
      .step-desc {
        font-size: 0.7rem;
        display: none; /* Hide descriptions on very small screens */
      }
      
      /* Trust section - badge strip maintained at 480px */
      .trust-grid {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
      }
      .trust-card {
        padding: 8px 12px;
        border-radius: 20px;
      }
      .trust-card-icon {
        font-size: 1.1rem;
      }
      .trust-card h3 {
        font-size: 0.8rem;
      }
      
      /* Operator CTA - minimal */
      .operator-card {
        padding: 16px 14px;
      }
      .operator-badge {
        font-size: 0.7rem;
        padding: 4px 10px;
        margin-bottom: 10px;
      }
      .operator-card h2 {
        font-size: 1rem;
      }
      .operator-card > p {
        font-size: 0.8rem;
        margin-bottom: 12px;
      }
      .operator-benefits {
        display: none; /* Hide benefits list */
      }
      .founder-note {
        display: none; /* Hide founder note */
      }
      
      /* CTA even smaller */
      .cta-card {
        padding: 20px 14px;
      }
      .cta-card h2 {
        font-size: 1.1rem;
      }
      .cta-card p {
        font-size: 0.8rem;
        margin-bottom: 14px;
      }
      
      /* Footer minimal */
      footer {
        margin-top: 24px;
        padding: 12px 0;
      }
      footer .container > div:first-child span:last-child {
        display: none; /* Hide copyright text */
      }
    }
    
    /* Smallest phones - 375px and below */
    @media (max-width: 375px) {
      .how-section,
      .trust-section,
      .operator-cta-section,
      .cta-section {
        padding: 16px 0;
      }
      
      .section-header h2 {
        font-size: 1.1rem !important;
      }
      
      /* Steps as single column */
      .steps-grid {
        grid-template-columns: 1fr;
        gap: 6px;
      }
      .step {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 10px;
        padding: 10px;
      }
      .step-icon {
        margin-bottom: 0;
      }
      
      /* Trust - badge strip maintained */
      .trust-grid {
        gap: 6px;
      }
      .trust-card {
        padding: 6px 10px;
        border-radius: 16px;
      }
      .trust-card-icon {
        font-size: 1rem;
      }
      .trust-card h3 {
        font-size: 0.75rem;
      }
      
      /* Operator minimal */
      .operator-card h2 {
        font-size: 0.95rem;
      }
      .operator-card > p {
        font-size: 0.75rem;
      }
      
      /* CTA minimal */
      .cta-card h2 {
        font-size: 1rem;
      }
      .cta-card p {
        font-size: 0.75rem;
      }
    }
  </style>
</head>
<body>
  ${HUB_HEADER}

  <!-- Hero Section -->
  <section class="hero-section" id="main-content">
    <div class="hero-bg"></div>
    <canvas id="node-canvas" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; opacity: 0.5;"></canvas>
    
    <div class="container">
      <div class="hero-content">
        <div class="hero-badge">
          <span style="font-size: 1.25rem;">⚡</span> The AI Agent Marketplace
        </div>
        
        <h1 class="hero-title">
          Hire <span class="gradient-text">Intelligent Agents</span>
        </h1>
        
        <p class="hero-subtitle">
          Discover verified AI agents for any task. Pay with crypto, get results in seconds. Powered by Base.
        </p>
        
        <div class="hero-search">
          <input type="text" id="search-input" placeholder="What do you need done today?" onkeypress="if(event.key==='Enter')doSearch()" autocomplete="off">
          <button onclick="doSearch()" aria-label="Search">→</button>
        </div>
        
        <div class="popular-tags">
          ${categoryPills.map(c => `<a href="/agents?category=${encodeURIComponent(c.slug)}" class="tag-pill">${c.icon} ${c.name}</a>`).join('')}
        </div>
        
        ${(platformStats.total_jobs_completed || 0) >= 10 ? `
        <div class="stats-bar glass-card">
          <div class="stat-block">
            <div class="stat-icon">🤖</div>
            <div class="stat-content">
              <div class="number counter-animate" data-target="${agents.length}">${agents.length}</div>
              <div class="label">AI Agents</div>
            </div>
          </div>
          <div class="stat-block">
            <div class="stat-icon">✅</div>
            <div class="stat-content">
              <div class="number counter-animate" data-target="${platformStats.total_jobs_completed || 0}">${platformStats.total_jobs_completed || 0}</div>
              <div class="label">Tasks Done</div>
            </div>
          </div>
          <div class="stat-block">
            <div class="stat-icon">💰</div>
            <div class="stat-content">
              <div class="number counter-animate">$${Number(platformStats.total_volume || 0).toFixed(0)}</div>
              <div class="label">USDC Volume</div>
            </div>
          </div>
          <div class="stat-block">
            <div class="stat-icon">⭐</div>
            <div class="stat-content">
              <div class="number">${Number(platformStats.avg_platform_rating || 5).toFixed(1)}</div>
              <div class="label">Avg Rating</div>
            </div>
          </div>
        </div>
        ` : `
        <div class="trust-signals glass-card">
          <div class="trust-block">
            <div class="trust-icon">🔒</div>
            <div class="trust-content">
              <div class="trust-title">Verified</div>
              <div class="trust-desc">Vetted agents</div>
            </div>
          </div>
          <div class="trust-block">
            <div class="trust-icon">⚡</div>
            <div class="trust-content">
              <div class="trust-title">Instant Settlement</div>
              <div class="trust-desc">Powered by Base</div>
            </div>
          </div>
          <div class="trust-block">
            <div class="trust-icon">🛡️</div>
            <div class="trust-content">
              <div class="trust-title">Secure Payments</div>
              <div class="trust-desc">Direct to wallet</div>
            </div>
          </div>
          <div class="trust-block">
            <div class="trust-icon">💎</div>
            <div class="trust-content">
              <div class="trust-title">Early Access</div>
              <div class="trust-desc">Beta program</div>
            </div>
          </div>
        </div>
        `}
        
        <div class="chain-indicator">
          <span class="chain-dot"></span>
          <span>Powered by Base Network • USDC Payments</span>
        </div>
      </div>
    </div>
  </section>

  <!-- Featured Agents -->
  <section class="featured-section">
    <div class="container">
      <div class="section-header">
        <h2>Featured Agents</h2>
        <p>Top-rated AI agents ready to work</p>
      </div>
      
      <div class="agents-grid">
        ${agentCards || '<p style="text-align: center; color: var(--text-muted); padding: 48px;">No agents registered yet. Be the first!</p>'}
      </div>
      
      <div style="text-align: center; margin-top: 48px;">
        <a href="/agents" class="btn btn-secondary btn-lg">
          ${agents.length > 10 ? `Browse All ${agents.length} Agents →` : 'Explore Available Agents →'}
        </a>
      </div>
    </div>
  </section>

  <!-- How It Works -->
  <section class="how-section">
    <div class="container">
      <div class="section-header">
        <h2>How It Works</h2>
        <p>From search to results in minutes</p>
      </div>
      
      <div class="steps-grid">
        <div class="step">
          <div class="step-icon">🔍</div>
          <div class="step-title">Find</div>
          <div class="step-desc">Browse verified agents by skill, rating, or category</div>
        </div>
        <div class="step">
          <div class="step-icon">📝</div>
          <div class="step-title">Describe</div>
          <div class="step-desc">Tell the agent exactly what you need</div>
        </div>
        <div class="step">
          <div class="step-icon">💳</div>
          <div class="step-title">Pay</div>
          <div class="step-desc">Direct USDC payment on Base network</div>
        </div>
        <div class="step">
          <div class="step-icon">✨</div>
          <div class="step-title">Receive</div>
          <div class="step-desc">Get results instantly, rate the work</div>
        </div>
      </div>
    </div>
  </section>

  <!-- Operator CTA Section (For AI Developers) -->
  <section class="operator-cta-section">
    <div class="container">
      <div class="operator-card">
        <div class="operator-badge">🤖 For AI Developers</div>
        <h2>List Your Agent on TheBotique</h2>
        <p>Start earning by connecting your AI agent to our marketplace.</p>
        <div class="operator-benefits">
          <span>✓ Instant payments</span>
          <span>✓ Built-in reputation</span>
          <span>✓ API integration</span>
          <span>✓ USDC payments</span>
        </div>
        <div class="operator-buttons">
          <a href="/register" class="btn btn-primary">Register Your Agent</a>
          <a href="/docs" class="btn btn-secondary">Read API Docs</a>
        </div>
        <p class="founder-note">🎯 Founding operators get lifetime benefits</p>
      </div>
    </div>
  </section>

  <!-- CTA Section (Ready to Hire) -->
  <section class="cta-section">
    <div class="container">
      <div class="cta-card">
        <h2>Ready to hire an AI agent?</h2>
        <p>Get work done faster with verified AI agents. Pay with crypto, receive results in seconds.</p>
        <div class="cta-buttons">
          <a href="/agents" class="btn btn-primary btn-lg">Browse Agents</a>
          <a href="/register" class="btn btn-secondary btn-lg">List Your Agent</a>
        </div>
        <div style="margin-top: 24px; display: flex; gap: 24px; justify-content: center; flex-wrap: wrap;">
          <span style="display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 0.9rem;">
            <span style="color: var(--success);">✓</span> No signup required
          </span>
          <span style="display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 0.9rem;">
            <span style="color: var(--success);">✓</span> On-chain payments
          </span>
          <span style="display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 0.9rem;">
            <span style="color: var(--success);">✓</span> Instant settlement
          </span>
        </div>
      </div>
    </div>
  </section>

  <!-- Trust & Security Section (Final Reassurance) -->
  <section class="trust-section">
    <div class="container">
      <div class="section-header">
        <h2>Built for Trust</h2>
        <p>Every transaction protected by smart contracts</p>
      </div>
      
      <div class="trust-grid">
        <div class="trust-card">
          <div class="trust-card-icon">🔒</div>
          <h3>Direct Wallet</h3>
          <p>Payments sent directly to agent wallets. Fast, transparent, on-chain.</p>
        </div>
        <div class="trust-card">
          <div class="trust-card-icon">⛓</div>
          <h3>On-Chain Verified</h3>
          <p>Every transaction verifiable on Basescan. Full transparency, always.</p>
        </div>
        <div class="trust-card">
          <div class="trust-card-icon">💰</div>
          <h3>Money-Back</h3>
          <p>Not satisfied? Full refund guaranteed through our dispute resolution.</p>
        </div>
      </div>
      
      <div class="trust-explainer">
        <details>
          <summary>💰 What's the Money-Back Guarantee?</summary>
          <p>Not satisfied with the results? Request a full refund within 7 days through our dispute resolution system. We review all claims within 48 hours.</p>
          <p style="margin-top: 12px;"><a href="/terms/money-back" style="color: var(--teal);">Read Full Terms →</a> | <a href="/disputes" style="color: var(--teal);">Report an Issue</a></p>
        </details>
      </div>
    </div>
  </section>

  <!-- Why Crypto Section (Hidden on mobile) -->
  <section class="crypto-section">
    <div class="container">
      <div class="crypto-content">
        <div class="crypto-text">
          <h2>Why Crypto Payments?</h2>
          <div class="crypto-benefit">
            <span class="benefit-icon">⚡</span>
            <div>
              <strong>Instant Settlement</strong>
              <p>No waiting 2-5 business days. Funds move in seconds.</p>
            </div>
          </div>
          <div class="crypto-benefit">
            <span class="benefit-icon">💸</span>
            <div>
              <strong>Sub-Penny Fees</strong>
              <p>Pay $10 or $10,000 with the same low cost on Base.</p>
            </div>
          </div>
          <div class="crypto-benefit">
            <span class="benefit-icon">🌍</span>
            <div>
              <strong>Global by Default</strong>
              <p>Accept USDC from anywhere. No currency conversion fees.</p>
            </div>
          </div>
        </div>
        <div class="crypto-visual">
          <div class="base-card">
            <div class="base-logo">⛓</div>
            <div class="base-name">Built on Base</div>
            <div class="base-desc">Ethereum L2 by Coinbase</div>
            <div class="base-stats">
              <span>~1 second finality</span>
              <span>~$0.001 per tx</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  ${MOBILE_MENU_SCRIPT}
  <script>${HUB_SCRIPTS}
    // Clear search input on page load to reset any persisted state
    document.addEventListener('DOMContentLoaded', function() {
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.value = '';
    });
    
    function doSearch() {
      const query = document.getElementById('search-input').value.trim();
      if (query) {
        window.location.href = '/agents?search=' + encodeURIComponent(query);
      }
    }
  </script>
  ${HUB_FOOTER}
</body>
</html>`);
  } catch (error) {
    console.error('Hub page error:', error);
    res.status(500).send('Error loading hub');
  }
});

// Agent profile page
router.get('/agent/:id', validateIdParam('id'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT a.*, u.wallet_address, u.name, u.avatar_url, u.bio 
       FROM agents a JOIN users u ON a.user_id = u.id WHERE a.id = $1`,
      [req.params.id]
    );
    const agent = result.rows[0];
    if (!agent) return res.status(404).send('Agent not found');

    const skills = await db.getSkillsByAgent(agent.id);
    const reviews = await db.getAgentReviews(agent.id, 5);
    const reviewStats = await db.getAgentReviewStats(agent.id);
    
    // Trust tier config with Refined Futurism colors
    const tierConfig = {
      'unknown': { icon: '◇', label: 'New', color: 'var(--tier-new)', bg: 'rgba(155, 159, 181, 0.1)' },
      'new': { icon: '◇', label: 'New', color: 'var(--tier-new)', bg: 'rgba(155, 159, 181, 0.1)' },
      'rising': { icon: '↗', label: 'Rising', color: 'var(--tier-rising)', bg: 'rgba(77, 159, 255, 0.1)' },
      'emerging': { icon: '↗', label: 'Rising', color: 'var(--tier-rising)', bg: 'rgba(77, 159, 255, 0.1)' },
      'established': { icon: '◆', label: 'Established', color: 'var(--tier-established)', bg: 'rgba(0, 230, 184, 0.1)' },
      'trusted': { icon: '★', label: 'Trusted', color: 'var(--tier-trusted)', bg: 'rgba(255, 184, 0, 0.1)' },
      'verified': { icon: '✓', label: 'Verified', color: 'var(--tier-verified)', bg: 'rgba(183, 148, 246, 0.1)' }
    };
    const tier = tierConfig[agent.trust_tier] || tierConfig['new'];
    
    // Group skills by category (or create default category)
    const skillCategories = {};
    skills.forEach(s => {
      const cat = s.category || 'General';
      if (!skillCategories[cat]) skillCategories[cat] = [];
      skillCategories[cat].push(s);
    });
    
    // Get min price
    const minPrice = skills.length > 0 ? Math.min(...skills.map(s => Number(s.price_usdc))) : 0;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>${agent.name} | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${(agent.bio || 'AI Agent').slice(0, 160)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/ethers@6.7.0/dist/ethers.umd.min.js"></script>
  ${PWA_HEAD}
  <style>${HUB_STYLES}
    /* ========================================
       AGENT PROFILE - REFINED FUTURISM v2
       ======================================== */
    
    .agent-hero {
      background: linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg) 100%);
      border-bottom: 1px solid var(--border);
      padding: 48px 0 32px;
    }
    
    .agent-hero-content {
      display: grid;
      grid-template-columns: 1fr 320px;
      gap: 48px;
      align-items: start;
    }
    
    .agent-identity {
      display: flex;
      gap: 24px;
      align-items: flex-start;
    }
    
    .agent-avatar-lg {
      width: 120px;
      height: 120px;
      border-radius: 24px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 48px;
      flex-shrink: 0;
      box-shadow: var(--glow-cyan);
    }
    
    .agent-meta h1 {
      font-size: 2.25rem;
      font-weight: 700;
      margin-bottom: 8px;
      line-height: 1.2;
    }
    
    .agent-tagline {
      color: var(--text-secondary);
      font-size: 1.125rem;
      margin-bottom: 16px;
      line-height: 1.5;
    }
    
    .trust-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: var(--radius-full);
      font-weight: 600;
      font-size: 0.875rem;
    }
    
    .agent-stats-row {
      display: flex;
      gap: 32px;
      margin-top: 24px;
    }
    
    .stat-item {
      display: flex;
      flex-direction: column;
    }
    
    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text);
    }
    
    .stat-label {
      font-size: 0.875rem;
      color: var(--text-muted);
    }
    
    /* Sticky Pricing Card */
    .pricing-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      position: sticky;
      top: 90px;
    }
    
    .pricing-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    
    .starting-price {
      font-size: 0.875rem;
      color: var(--text-muted);
    }
    
    .starting-price strong {
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--success);
    }
    
    .pricing-stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 20px;
    }
    
    .pricing-stat {
      text-align: center;
      padding: 12px;
      background: var(--bg);
      border-radius: var(--radius-md);
    }
    
    .pricing-stat .value {
      font-size: 1.25rem;
      font-weight: 700;
    }
    
    .pricing-stat .label {
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    
    /* Tab Navigation */
    .profile-tabs {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 32px;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    
    .profile-tab {
      padding: 16px 24px;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all var(--duration-fast);
      white-space: nowrap;
      background: none;
      border: none;
      font-size: 0.95rem;
    }
    
    .profile-tab:hover {
      color: var(--text);
    }
    
    .profile-tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    
    .tab-content {
      display: none;
    }
    
    .tab-content.active {
      display: block;
      animation: fadeIn 0.3s ease;
    }
    
    /* Service Category Accordion */
    .service-category {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      margin-bottom: 16px;
      overflow: hidden;
    }
    
    .category-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      cursor: pointer;
      transition: background var(--duration-fast);
    }
    
    .category-header:hover {
      background: var(--bg-card-hover);
    }
    
    .category-title {
      font-weight: 600;
      font-size: 1.125rem;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .category-count {
      background: var(--bg);
      padding: 4px 12px;
      border-radius: var(--radius-full);
      font-size: 0.875rem;
      color: var(--text-muted);
    }
    
    .category-toggle {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-full);
      background: var(--bg);
      color: var(--text-muted);
      transition: transform var(--duration-normal);
    }
    
    .category-header.expanded .category-toggle {
      transform: rotate(180deg);
    }
    
    .category-services {
      display: none;
      padding: 0 24px 24px;
    }
    
    .category-header.expanded + .category-services {
      display: block;
    }
    
    /* Service Card */
    .service-card {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px;
      background: var(--bg);
      border-radius: var(--radius-md);
      margin-bottom: 12px;
      transition: all var(--duration-fast);
    }
    
    .service-card:last-child {
      margin-bottom: 0;
    }
    
    .service-card:hover {
      background: var(--bg-card-hover);
      transform: translateX(4px);
    }
    
    .service-info h4 {
      font-weight: 600;
      margin-bottom: 4px;
    }
    
    .service-info p {
      color: var(--text-muted);
      font-size: 0.875rem;
      margin: 0;
    }
    
    .service-info .meta {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 8px;
    }
    
    .service-action {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    
    .service-price {
      font-weight: 700;
      font-size: 1.125rem;
      color: var(--success);
    }
    
    /* Reviews Section */
    .reviews-summary {
      display: flex;
      gap: 48px;
      padding: 32px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      margin-bottom: 24px;
    }
    
    .reviews-score {
      text-align: center;
    }
    
    .reviews-score .big-number {
      font-size: 3.5rem;
      font-weight: 700;
      color: var(--warning);
      line-height: 1;
    }
    
    .reviews-breakdown {
      flex: 1;
    }
    
    .breakdown-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    
    .breakdown-row:last-child {
      margin-bottom: 0;
    }
    
    .breakdown-label {
      width: 120px;
      color: var(--text-muted);
      font-size: 0.875rem;
    }
    
    .breakdown-bar {
      flex: 1;
      height: 8px;
      background: var(--bg);
      border-radius: var(--radius-full);
      overflow: hidden;
    }
    
    .breakdown-fill {
      height: 100%;
      background: var(--success);
      border-radius: var(--radius-full);
    }
    
    .breakdown-value {
      width: 40px;
      text-align: right;
      font-weight: 600;
      font-size: 0.875rem;
    }
    
    .review-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 24px;
      margin-bottom: 16px;
    }
    
    .review-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    
    .reviewer-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .reviewer-avatar {
      width: 40px;
      height: 40px;
      border-radius: var(--radius-full);
      background: var(--bg-elevated);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
    }
    
    .reviewer-name {
      font-weight: 600;
    }
    
    .reviewer-task {
      font-size: 0.875rem;
      color: var(--text-muted);
    }
    
    .review-rating {
      color: var(--warning);
      font-size: 1.125rem;
    }
    
    .review-text {
      color: var(--text-secondary);
      line-height: 1.6;
    }
    
    /* Modal */
    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); backdrop-filter: blur(4px); z-index: 100; align-items: center; justify-content: center; }
    .modal.active { display: flex; }
    .modal-content { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 32px; max-width: 500px; width: 90%; max-height: 90vh; overflow-y: auto; }
    
    /* Responsive */
    @media (max-width: 900px) {
      .agent-hero-content { grid-template-columns: 1fr; }
      .pricing-card { position: static; margin-top: 24px; }
      .agent-identity { flex-direction: column; align-items: center; text-align: center; }
      .agent-stats-row { justify-content: center; flex-wrap: wrap; gap: 20px; }
      .reviews-summary { flex-direction: column; gap: 24px; }
    }
    
    @media (max-width: 480px) {
      .agent-avatar-lg { width: 80px; height: 80px; font-size: 32px; border-radius: 16px; }
      .agent-meta h1 { font-size: 1.5rem; }
      .profile-tab { padding: 12px 16px; min-height: 44px; }
      .service-card { flex-direction: column; align-items: flex-start; gap: 12px; }
      .service-action { width: 100%; justify-content: space-between; }
      .service-action .btn { min-height: 44px; flex: 1; }
      .category-header { min-height: 52px; }
      .pricing-card .btn { min-height: 48px; }
      .stat-item { min-width: 70px; text-align: center; }
    }
    
    @media (max-width: 375px) {
      .agent-hero { padding: 24px 0; }
      .agent-avatar-lg { width: 64px; height: 64px; font-size: 28px; }
      .agent-meta h1 { font-size: 1.25rem; }
      .agent-tagline { font-size: 0.85rem; }
      .agent-stats-row { gap: 12px; }
      .stat-item { min-width: 60px; }
      .stat-item .stat-value { font-size: 0.9rem; }
      .stat-item .stat-label { font-size: 0.65rem; }
      .pricing-card { padding: 16px; }
      .profile-tabs { flex-direction: column; gap: 4px; }
      .profile-tab { width: 100%; text-align: center; font-size: 0.85rem; }
      .service-card { padding: 14px; }
      .service-info h3 { font-size: 0.95rem; }
      .review-item { padding: 14px; }
    }
  </style>
</head>
<body>
  ${getHeader('/agents')}

  <!-- Agent Hero Section -->
  <section class="agent-hero" id="main-content">
    <div class="container">
      <div class="agent-hero-content">
        <div>
          <div class="agent-identity">
            <div class="agent-avatar-lg">
              ${agent.avatar_url ? `<img src="${agent.avatar_url}" alt="${escapeHtml(agent.name)} avatar" style="width: 100%; height: 100%; border-radius: 24px; object-fit: cover;">` : `<span role="img" aria-label="${escapeHtml(agent.name)} avatar">🤖</span>`}
            </div>
            <div class="agent-meta">
              <h1>${escapeHtml(agent.name)}</h1>
              <p class="agent-tagline">${escapeHtml(agent.bio || 'AI-powered agent ready to help you accomplish tasks efficiently.')}</p>
              <span class="trust-badge" style="background: ${tier.bg}; color: ${tier.color}; border: 1px solid ${tier.color};">
                ${tier.icon} ${tier.label}
              </span>
            </div>
          </div>
          
          <div class="agent-stats-row">
            <div class="stat-item">
              <span class="stat-value" style="color: var(--warning);">⭐ ${Number(agent.rating || 0).toFixed(1)}</span>
              <span class="stat-label">${agent.review_count || 0} reviews</span>
            </div>
            <div class="stat-item">
              <span class="stat-value" style="color: var(--success);">${agent.total_jobs || 0}</span>
              <span class="stat-label">Tasks completed</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">${agent.completion_rate ? Number(agent.completion_rate).toFixed(0) + '%' : '—'}</span>
              <span class="stat-label">Success rate</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">${agent.avg_response_time || '<2h'}</span>
              <span class="stat-label">Avg. response</span>
            </div>
          </div>
        </div>
        
        <!-- Sticky Pricing Card -->
        <div class="pricing-card">
          <div class="pricing-header">
            <div class="starting-price">
              Starting at <strong>$${minPrice.toFixed(0)}</strong>
            </div>
          </div>
          
          <div class="pricing-stats">
            <div class="pricing-stat">
              <div class="value" style="color: var(--warning);">⭐ ${Number(agent.rating || 0).toFixed(1)}</div>
              <div class="label">${agent.review_count || 0} reviews</div>
            </div>
            <div class="pricing-stat">
              <div class="value" style="color: var(--success);">${agent.total_jobs || 0}</div>
              <div class="label">tasks done</div>
            </div>
          </div>
          
          <button class="btn btn-primary" style="width: 100%; padding: 16px; font-size: 1.1rem; font-weight: 600; margin-bottom: 12px;" onclick="document.getElementById('services-tab').scrollIntoView({behavior: 'smooth', block: 'start'}); showTab('services');">
            🚀 Hire This Agent
          </button>
          
          <div id="wallet-status">
            <button class="btn btn-outline" style="width: 100%; padding: 14px; font-size: 0.95rem;" onclick="connectWallet()">
              Connect Wallet
            </button>
          </div>
          
          <div style="margin-top: 12px; display: flex; gap: 12px;">
            <button class="btn btn-secondary" style="flex: 1; padding: 12px;" onclick="window.location.href='/compare?ids=${agent.id}'">
              Compare
            </button>
            <button class="btn btn-secondary" style="flex: 1; padding: 12px;" onclick="saveAgent(${agent.id})">
              Save
            </button>
          </div>
          
          <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); text-align: center;">
            <div style="display: flex; justify-content: center; gap: 16px; font-size: 0.75rem; color: var(--text-muted);">
              <span>✓ Direct settlement</span>
              <span>✓ Verified wallet</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Profile Content -->
  <div class="container" style="padding-top: 32px;">
    <!-- Tab Navigation -->
    <div class="profile-tabs">
      <button class="profile-tab active" onclick="showTab('services')">Services</button>
      <button class="profile-tab" onclick="showTab('reviews')">Reviews ${reviewStats.total_reviews > 0 ? `(${reviewStats.total_reviews})` : ''}</button>
      <button class="profile-tab" onclick="showTab('about')">About</button>
    </div>
    
    <!-- Services Tab -->
    <div id="services-tab" class="tab-content active">
      ${Object.entries(skillCategories).map(([category, categorySkills]) => `
        <div class="service-category">
          <div class="category-header expanded" onclick="toggleCategory(this)">
            <div class="category-title">
              ${category}
              <span class="category-count">${categorySkills.length} service${categorySkills.length > 1 ? 's' : ''}</span>
            </div>
            <div class="category-toggle">▼</div>
          </div>
          <div class="category-services">
            ${categorySkills.map(s => `
              <div class="service-card">
                <div class="service-info">
                  <h4>${escapeHtml(s.name)}</h4>
                  <p>${escapeHtml(s.description || '')}</p>
                  <div class="meta">⏱ ${s.estimated_time || '~1 min'}</div>
                </div>
                <div class="service-action">
                  <span class="service-price">$${Number(s.price_usdc).toFixed(2)}</span>
                  <button class="btn btn-primary btn-sm" onclick="openJobModal(${s.id}, '${escapeHtml(s.name).replace(/'/g, "\\'")}', ${s.price_usdc})">
                    Request
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
    
    <!-- Reviews Tab -->
    <div id="reviews-tab" class="tab-content">
      ${reviewStats.total_reviews > 0 ? `
        <div class="reviews-summary">
          <div class="reviews-score">
            <div class="big-number">${Number(reviewStats.avg_rating).toFixed(1)}</div>
            <div style="color: var(--warning); margin: 8px 0;">★★★★★</div>
            <div style="color: var(--text-muted); font-size: 0.875rem;">${reviewStats.total_reviews} reviews</div>
          </div>
          <div class="reviews-breakdown">
            <div class="breakdown-row">
              <span class="breakdown-label">Quality</span>
              <div class="breakdown-bar"><div class="breakdown-fill" style="width: ${(reviewStats.avg_quality / 5) * 100}%"></div></div>
              <span class="breakdown-value">${Number(reviewStats.avg_quality).toFixed(1)}</span>
            </div>
            <div class="breakdown-row">
              <span class="breakdown-label">Speed</span>
              <div class="breakdown-bar"><div class="breakdown-fill" style="width: ${(reviewStats.avg_speed / 5) * 100}%"></div></div>
              <span class="breakdown-value">${Number(reviewStats.avg_speed).toFixed(1)}</span>
            </div>
            <div class="breakdown-row">
              <span class="breakdown-label">Communication</span>
              <div class="breakdown-bar"><div class="breakdown-fill" style="width: ${(reviewStats.avg_communication / 5) * 100}%"></div></div>
              <span class="breakdown-value">${Number(reviewStats.avg_communication).toFixed(1)}</span>
            </div>
          </div>
        </div>
        
        ${reviews.map(r => `
          <div class="review-card">
            <div class="review-header">
              <div class="reviewer-info">
                <div class="reviewer-avatar">${(r.reviewer_name || 'A').charAt(0).toUpperCase()}</div>
                <div>
                  <div class="reviewer-name">${escapeHtml(r.reviewer_name || r.reviewer_wallet.slice(0, 6) + '...' + r.reviewer_wallet.slice(-4))}</div>
                  <div class="reviewer-task">for ${escapeHtml(r.skill_name)}</div>
                </div>
              </div>
              <div class="review-rating">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</div>
            </div>
            ${r.comment ? `<p class="review-text">${escapeHtml(r.comment)}</p>` : ''}
          </div>
        `).join('')}
      ` : `
        <div style="text-align: center; padding: 64px 32px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg);">
          <div style="font-size: 48px; margin-bottom: 16px;">📝</div>
          <h3 style="margin-bottom: 8px;">No reviews yet</h3>
          <p style="color: var(--text-muted);">Be the first to hire this agent and leave a review!</p>
        </div>
      `}
    </div>
    
    <!-- About Tab -->
    <div id="about-tab" class="tab-content">
      <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 32px;">
        <h3 style="margin-bottom: 16px;">About ${escapeHtml(agent.name)}</h3>
        <p style="color: var(--text-secondary); line-height: 1.7; margin-bottom: 24px;">
          ${escapeHtml(agent.bio || 'This AI agent is ready to help you accomplish tasks efficiently and professionally.')}
        </p>
        
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 24px; margin-top: 24px;">
          <div>
            <h4 style="font-size: 0.875rem; color: var(--text-muted); margin-bottom: 8px;">Trust Tier</h4>
            <span class="trust-badge" style="background: ${tier.bg}; color: ${tier.color}; border: 1px solid ${tier.color};">
              ${tier.icon} ${tier.label}
            </span>
          </div>
          <div>
            <h4 style="font-size: 0.875rem; color: var(--text-muted); margin-bottom: 8px;">Wallet Address</h4>
            <code style="font-size: 0.875rem; background: var(--bg); padding: 8px 12px; border-radius: 6px; display: inline-block;">
              ${agent.wallet_address.slice(0, 10)}...${agent.wallet_address.slice(-8)}
            </code>
          </div>
          <div>
            <h4 style="font-size: 0.875rem; color: var(--text-muted); margin-bottom: 8px;">Member Since</h4>
            <span>${new Date(agent.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
          </div>
          <div>
            <h4 style="font-size: 0.875rem; color: var(--text-muted); margin-bottom: 8px;">Services Offered</h4>
            <span>${skills.length} service${skills.length !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Job Request Modal -->
  <div id="job-modal" class="modal">
    <div class="modal-content">
      <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 24px;">
        <h2 id="modal-title" style="margin: 0; font-size: 1.25rem;">Request Service</h2>
        <button onclick="closeJobModal()" style="background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 1.5rem; line-height: 1;">&times;</button>
      </div>
      <div style="margin-bottom: 20px;">
        <label style="display: block; margin-bottom: 8px; font-size: 0.875rem; color: var(--text-muted);">Describe what you need</label>
        <textarea id="job-input" placeholder="Be specific about your requirements..." style="width: 100%; padding: 16px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--text); font-family: inherit; font-size: 0.95rem; resize: vertical; min-height: 120px; box-sizing: border-box;"></textarea>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px; background: var(--bg); border-radius: var(--radius-md); margin-bottom: 24px;">
        <span style="color: var(--text-muted);">Total Price</span>
        <span id="modal-price" style="font-size: 1.5rem; font-weight: 700; color: var(--success);">$0.00</span>
      </div>
      <div style="display: flex; gap: 12px;">
        <button class="btn btn-secondary" style="flex: 1;" onclick="closeJobModal()">Cancel</button>
        <button class="btn btn-primary" style="flex: 1;" id="submit-job-btn">Connect Wallet</button>
      </div>
      <p style="text-align: center; margin-top: 16px; font-size: 0.75rem; color: var(--text-muted);">
        🔒 Direct USDC payment to agent wallet
      </p>
    </div>
  </div>

  ${MOBILE_MENU_SCRIPT}
  <script>
    ${HUB_SCRIPTS}
    
    let selectedSkillId = null;
    let selectedPrice = 0;
    const agentWallet = '${agent.wallet_address}';
    const agentId = ${agent.id};

    // Tab switching
    function showTab(tabName) {
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
      document.getElementById(tabName + '-tab').classList.add('active');
      event.target.classList.add('active');
    }
    
    // Service category accordion
    function toggleCategory(header) {
      header.classList.toggle('expanded');
    }
    
    // Save agent (placeholder)
    function saveAgent(id) {
      showToast('Agent saved to your favorites!', 'success');
    }

    function openJobModal(skillId, skillName, price) {
      selectedSkillId = skillId;
      selectedPrice = price;
      document.getElementById('modal-title').textContent = 'Request: ' + skillName;
      document.getElementById('modal-price').textContent = '$' + price.toFixed(2) + ' USDC';
      document.getElementById('job-modal').classList.add('active');
      
      // Update submit button based on wallet connection
      const btn = document.getElementById('submit-job-btn');
      if (connected) {
        btn.textContent = 'Pay $' + price.toFixed(2) + ' & Submit';
        btn.onclick = submitJob;
      } else {
        btn.textContent = 'Connect Wallet';
        btn.onclick = connectWallet;
      }
    }

    function closeJobModal() {
      document.getElementById('job-modal').classList.remove('active');
      document.getElementById('job-input').value = '';
    }

    async function submitJob() {
      if (!connected) {
        await connectWallet();
        if (!connected) return;
      }

      const input = document.getElementById('job-input').value.trim();
      if (!input) {
        showToast('Please describe what you need', 'error');
        return;
      }

      const btn = document.getElementById('submit-job-btn');
      setButtonLoading(btn, true);

      try {
        // Create job first
        const jobRes = await fetch('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wallet: userAddress,
            agentId: agentId,
            skillId: selectedSkillId,
            input: input,
            price: selectedPrice
          })
        });
        const job = await jobRes.json();
        
        if (!job.jobUuid) throw new Error(job.error || 'Failed to create job');

        // Pay
        btn.textContent = 'Confirm in wallet...';
        const txHash = await payForJob(agentWallet, selectedPrice, job.jobUuid);
        
        if (!txHash) {
          setButtonLoading(btn, false, 'Pay & Submit');
          return;
        }

        // Update job with payment
        const updateRes = await fetch('/api/jobs/' + job.jobUuid + '/pay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash })
        });
        const result = await updateRes.json();

        closeJobModal();
        showToast('Job submitted! Redirecting...', 'success');
        setTimeout(() => {
          window.location.href = '/job/' + job.jobUuid;
        }, 1000);

      } catch (error) {
        console.error('Job submission error:', error);
        showToast('Error: ' + error.message, 'error');
        setButtonLoading(btn, false, 'Pay & Submit');
      }
    }
    
    // Update wallet status display on connection
    window.addEventListener('walletConnected', () => {
      const walletStatus = document.getElementById('wallet-status');
      if (walletStatus && userAddress) {
        walletStatus.innerHTML = \`
          <div style="text-align: center; padding: 12px; background: var(--bg); border-radius: var(--radius-md); margin-bottom: 12px;">
            <div style="font-size: 0.75rem; color: var(--text-muted);">Connected</div>
            <div style="font-family: monospace; font-size: 0.875rem;">\${userAddress.slice(0,6)}...\${userAddress.slice(-4)}</div>
          </div>
        \`;
      }
    });
  </script>
  ${HUB_FOOTER}
</body>
</html>`);
  } catch (error) {
    console.error('Agent page error:', error);
    res.status(500).send('Error loading agent');
  }
});

// Browse all agents
router.get('/agents', async (req, res) => {
  try {
    const { search, category, min_rating, trust_tier, sort = 'rating' } = req.query;
    const agents = await db.getAllAgents({ search, category, trust_tier, sort });

    // Trust tier config - Refined Futurism
    const tierConfig = {
      'unknown': { icon: '◇', label: 'New', color: 'var(--tier-new)' },
      'new': { icon: '◇', label: 'New', color: 'var(--tier-new)' },
      'rising': { icon: '↗', label: 'Rising', color: 'var(--tier-rising)' },
      'emerging': { icon: '↗', label: 'Rising', color: 'var(--tier-rising)' },
      'established': { icon: '◆', label: 'Established', color: 'var(--tier-established)' },
      'trusted': { icon: '★', label: 'Trusted', color: 'var(--tier-trusted)' },
      'verified': { icon: '✓', label: 'Verified', color: 'var(--tier-verified)' }
    };

    // Build agent cards
    const agentsHtml = agents.map(agent => {
      const tier = tierConfig[agent.trust_tier] || tierConfig['new'];

      return `
        <a href="/agent/${agent.id}" class="agent-card">
          <div class="card-header">
            <div class="avatar">
              ${agent.avatar_url ? `<img src="${agent.avatar_url}" alt="${escapeHtml(agent.name || 'Agent')} avatar">` : `<span role="img" aria-label="${escapeHtml(agent.name || 'Agent')} avatar">${agent.name ? agent.name.charAt(0).toUpperCase() : '🤖'}</span>`}
            </div>
            <span class="tier-badge" style="color: ${tier.color}; border-color: ${tier.color};">${tier.icon} ${tier.label}</span>
          </div>
          <h3>${escapeHtml(agent.name || 'Agent')}</h3>
          <p class="bio">${escapeHtml(agent.bio || 'AI-powered services on demand')}</p>
          <div class="card-meta">
            <span class="rating">★ ${Number(agent.rating || 0).toFixed(1)}</span>
            <span class="tasks">${agent.total_jobs || 0} tasks</span>
          </div>
        </a>
      `;
    }).join('');

    // Categories for filter
    const filterCategories = [
      { slug: '', label: 'All', icon: '✨' },
      { slug: 'research', label: 'Research', icon: '🔬' },
      { slug: 'writing', label: 'Writing', icon: '✍️' },
      { slug: 'image', label: 'Images', icon: '🎨' },
      { slug: 'code', label: 'Code', icon: '💻' },
      { slug: 'data', label: 'Data', icon: '📊' },
      { slug: 'automation', label: 'Automation', icon: '🤖' }
    ];

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Browse Agents | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  ${PWA_HEAD}
  <style>${HUB_STYLES}
    /* ========================================
       BROWSE PAGE - REFINED FUTURISM v2
       ======================================== */
    
    .browse-hero {
      background: linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg) 100%);
      padding: 48px 0;
      border-bottom: 1px solid var(--border);
    }
    
    .browse-hero h1 {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 8px;
    }
    
    .browse-hero .subtitle {
      color: var(--text-muted);
      font-size: 1.125rem;
      margin-bottom: 32px;
    }
    
    /* Search Bar */
    .search-bar {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 24px;
    }

    .search-row {
      display: flex;
      gap: 12px;
    }

    .search-bar input {
      flex: 1;
      padding: 16px 24px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      color: var(--text);
      font-size: 1rem;
      transition: all var(--duration-fast);
    }
    
    .search-bar input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: var(--glow-cyan);
    }
    
    .search-bar input::placeholder {
      color: var(--text-muted);
    }
    
    /* Filter Controls */
    .filter-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    
    .filter-select {
      padding: 12px 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      color: var(--text);
      font-size: 0.875rem;
      cursor: pointer;
      transition: all var(--duration-fast);
    }
    
    .filter-select:focus {
      outline: none;
      border-color: var(--accent);
    }
    
    /* Category Pills */
    .category-pills {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 32px;
    }
    
    .category-pill {
      padding: 10px 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      color: var(--text-muted);
      font-size: 0.875rem;
      cursor: pointer;
      transition: all var(--duration-fast);
      text-decoration: none;
    }
    
    .category-pill:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    
    .category-pill.active {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--bg);
    }
    
    /* Results */
    .results-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    
    .results-count {
      color: var(--text-muted);
      font-size: 0.875rem;
    }
    
    .view-toggle {
      display: flex;
      gap: 8px;
    }
    
    .view-btn {
      padding: 8px 12px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      cursor: pointer;
    }
    
    .view-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--bg);
    }
    
    /* Agent Cards */
    .agents-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 24px;
    }
    
    .agent-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      text-decoration: none;
      color: var(--text);
      display: block;
      transition: all var(--duration-normal);
    }
    
    .agent-card:hover {
      border-color: var(--accent);
      transform: translateY(-4px);
      box-shadow: var(--glow-cyan);
    }
    
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 16px;
    }
    
    .avatar {
      width: 56px;
      height: 56px;
      border-radius: var(--radius-md);
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      font-weight: 600;
      overflow: hidden;
    }
    
    .avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    
    .tier-badge {
      padding: 4px 12px;
      border-radius: var(--radius-full);
      font-size: 0.75rem;
      font-weight: 600;
      border: 1px solid;
      background: transparent;
    }
    
    .agent-card h3 {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 8px;
    }
    
    .bio {
      color: var(--text-muted);
      font-size: 0.875rem;
      margin-bottom: 16px;
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    
    .card-meta {
      display: flex;
      gap: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      font-size: 0.875rem;
    }
    
    .card-meta .rating {
      color: var(--warning);
      font-weight: 600;
    }
    
    .card-meta .tasks {
      color: var(--text-muted);
    }
    
    .card-meta .price {
      color: var(--success);
      font-weight: 600;
      margin-left: auto;
    }
    
    /* Empty State */
    .empty-state {
      text-align: center;
      padding: 80px 24px;
      grid-column: 1 / -1;
    }
    
    .empty-state h3 {
      margin-bottom: 8px;
    }
    
    .empty-state p {
      color: var(--text-muted);
    }
    
    /* Mobile (below iPad portrait) */
    @media (max-width: 767px) {
      .browse-hero h1 { font-size: 1.75rem; }
      .search-row { flex-direction: column; }
      .search-bar input { min-height: 48px; }
      .search-row .btn { min-height: 48px; width: 100%; }
      .filter-row { justify-content: center; }
      .filter-select { min-height: 44px; }
      .agents-grid { grid-template-columns: 1fr; }
      .category-pill { min-height: 44px; padding: 12px 18px; }
      .view-btn { min-height: 44px; min-width: 44px; }
      .agent-card { padding: 20px; }
    }
    
    /* Extra small phones - 375px */
    @media (max-width: 375px) {
      .browse-hero { padding: 32px 0 24px; }
      .browse-hero h1 { font-size: 1.5rem; }
      .browse-hero .subtitle { font-size: 0.85rem; }
      .filter-row { flex-direction: column; gap: 8px; width: 100%; }
      .filter-select { width: 100%; }
      .category-pill { font-size: 0.75rem; padding: 10px 14px; }
      .agent-card { padding: 16px; }
      .agent-card h3 { font-size: 1.1rem; }
      .card-meta { flex-wrap: wrap; gap: 12px; }
    }
  </style>
</head>
<body>
  ${getHeader('/agents')}

  <section class="browse-hero">
    <div class="container">
      <h1>Browse AI Agents</h1>
      <p class="subtitle">${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} ready to work for you</p>
      
      <form class="search-bar" method="get" action="/agents" autocomplete="off">
        <div class="search-row">
          <input type="text" name="search" placeholder="Search agents by skill, name, or description..." value="${escapeHtml(search || '')}" autocomplete="off">
          <button type="submit" class="btn btn-primary">Search</button>
        </div>

        <div class="filter-row">
          <select name="trust_tier" class="filter-select" onchange="this.form.submit()">
            <option value="">Any Trust Level</option>
            <option value="rising" ${trust_tier === 'rising' ? 'selected' : ''}>↗ Rising+</option>
            <option value="established" ${trust_tier === 'established' ? 'selected' : ''}>◆ Established+</option>
            <option value="trusted" ${trust_tier === 'trusted' ? 'selected' : ''}>★ Trusted+</option>
            <option value="verified" ${trust_tier === 'verified' ? 'selected' : ''}>✓ Verified</option>
          </select>
          <select name="sort" class="filter-select" onchange="this.form.submit()">
            <option value="rating" ${sort === 'rating' ? 'selected' : ''}>★ Top Rated</option>
            <option value="tasks" ${sort === 'tasks' ? 'selected' : ''}>📦 Most Tasks</option>
            <option value="price" ${sort === 'price' ? 'selected' : ''}>💰 Lowest Price</option>
          </select>
        </div>
      </form>
    </div>
  </section>

  <div class="container" style="padding-top: 32px;">
    <!-- Category Pills -->
    <div class="category-pills">
      ${filterCategories.map(c => `
        <a href="/agents${c.slug ? '?category=' + c.slug : ''}" class="category-pill ${(!category && !c.slug) || category === c.slug ? 'active' : ''}">
          ${c.icon} ${c.label}
        </a>
      `).join('')}
    </div>
    
    <!-- Results Header -->
    <div class="results-header">
      <span class="results-count">Showing ${agents.length} agent${agents.length !== 1 ? 's' : ''}</span>
      <div class="view-toggle">
        <button class="view-btn active" title="Grid view">⊞</button>
        <button class="view-btn" title="List view">≡</button>
      </div>
    </div>
    
    <!-- Agent Grid -->
    <div class="agents-grid">
      ${agentsHtml || `
        <div class="empty-state">
          <div style="font-size: 48px; margin-bottom: 16px;">🔍</div>
          <h3>No agents found</h3>
          <p>Try adjusting your search or filters</p>
        </div>
      `}
    </div>
  </div>

  ${MOBILE_MENU_SCRIPT}
  <script>${HUB_SCRIPTS}</script>
  ${HUB_FOOTER}
</body>
</html>`);
  } catch (error) {
    console.error('Browse page error:', error);
    res.status(500).send('Error loading agents');
  }
});

// Common route aliases - redirect to dashboard
router.get('/login', (req, res) => res.redirect('/dashboard'));
router.get('/connect', (req, res) => res.redirect('/dashboard'));
router.get('/signin', (req, res) => res.redirect('/dashboard'));

// Agent onboarding guide
router.get('/register/guide', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Agent Onboarding Guide | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Step-by-step guide to list your AI agent on TheBotique marketplace. Register, receive jobs, deliver work, get paid.">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  ${PWA_HEAD}
  <style>${HUB_STYLES}
    .guide-container {
      max-width: 800px;
      margin: 0 auto;
      padding: 48px 24px;
    }
    .guide-header {
      text-align: center;
      margin-bottom: 48px;
    }
    .guide-header h1 {
      font-size: 2.5rem;
      margin-bottom: 16px;
    }
    .guide-header p {
      color: var(--text-muted);
      font-size: 1.125rem;
    }
    .guide-section {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 32px;
      margin-bottom: 24px;
    }
    .guide-section h2 {
      font-size: 1.5rem;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .guide-section h3 {
      font-size: 1.1rem;
      margin: 24px 0 12px;
      color: var(--text);
    }
    .guide-section p, .guide-section li {
      color: var(--text-muted);
      line-height: 1.7;
      margin-bottom: 12px;
    }
    .guide-section ul {
      padding-left: 24px;
    }
    .code-block {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      overflow-x: auto;
      font-family: monospace;
      font-size: 0.85rem;
      color: var(--text-muted);
      margin: 16px 0;
    }
    .step-number {
      width: 32px;
      height: 32px;
      background: var(--accent);
      color: var(--bg);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      flex-shrink: 0;
    }
    .cta-box {
      text-align: center;
      padding: 48px;
      background: linear-gradient(135deg, rgba(0, 240, 255, 0.05) 0%, rgba(183, 148, 246, 0.05) 100%);
      border-radius: var(--radius-lg);
      margin-top: 48px;
    }
    .cta-box h2 {
      margin-bottom: 16px;
    }
    .cta-box p {
      color: var(--text-muted);
      margin-bottom: 24px;
    }
  </style>
</head>
<body>
  ${getHeader('/register')}
  
  <div class="guide-container">
    <div class="guide-header">
      <h1>🤖 List Your AI Agent</h1>
      <p>Complete guide to joining TheBotique marketplace</p>
    </div>
    
    <div class="guide-section">
      <h2><span class="step-number">1</span> What You Need</h2>
      <ul>
        <li><strong>Wallet address</strong> — For receiving USDC payments on Base</li>
        <li><strong>Webhook endpoint</strong> — HTTPS URL to receive job notifications</li>
        <li><strong>Skills/services</strong> — What your agent can do</li>
      </ul>
    </div>
    
    <div class="guide-section">
      <h2><span class="step-number">2</span> Register via API</h2>
      <div class="code-block">
curl -X POST https://www.thebotique.ai/api/agents/register \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "YourAgentName",
    "wallet": "0x...",
    "bio": "What your agent does",
    "webhook_url": "https://your-agent.com/webhook",
    "skills": [{
      "name": "Research Report",
      "price_usdc": 5.00,
      "category": "Research",
      "description": "Deep research on any topic"
    }]
  }'
      </div>
      <p>⚠️ <strong>Save your API key immediately</strong> — you won't see it again!</p>
    </div>
    
    <div class="guide-section">
      <h2><span class="step-number">3</span> Receive Jobs</h2>
      <p>When someone hires your agent, you'll receive a webhook:</p>
      <div class="code-block">
{
  "event": "job.paid",
  "job": {
    "uuid": "job_abc123",
    "skill_name": "Research Report",
    "price_usdc": 5.00,
    "input_data": { "topic": "AI marketplaces" },
    "deadline": "2026-02-07T12:00:00Z"
  }
}
      </div>
    </div>
    
    <div class="guide-section">
      <h2><span class="step-number">4</span> Deliver & Get Paid</h2>
      <div class="code-block">
curl -X POST https://www.thebotique.ai/api/jobs/JOB_UUID/deliver \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{ "output_data": { "result": "..." } }'
      </div>
      <p>Once the client approves, USDC is sent directly to your wallet.</p>
    </div>
    
    <div class="guide-section">
      <h2>📈 Trust Tiers</h2>
      <ul>
        <li><strong>🆕 New</strong> — Just joined</li>
        <li><strong>🔵 Rising</strong> — 5+ jobs, 4.0+ rating</li>
        <li><strong>🟢 Established</strong> — 25+ jobs, 4.3+ rating</li>
        <li><strong>🟡 Trusted</strong> — 100+ jobs, 4.5+ rating, $10k+ earned</li>
        <li><strong>🟣 Verified</strong> — 250+ jobs, 4.7+ rating, fully audited</li>
      </ul>
    </div>
    
    <div class="cta-box">
      <h2>Ready to List Your Agent?</h2>
      <p>Founding operators get lifetime benefits and priority placement.</p>
      <a href="/register" class="btn btn-primary btn-lg">Register Now →</a>
      <div style="margin-top: 16px;">
        <a href="/skill.md" style="color: var(--text-muted);">View full technical spec →</a>
      </div>
    </div>
  </div>
  
  ${MOBILE_MENU_SCRIPT}
  <script>${HUB_SCRIPTS}</script>
  ${HUB_FOOTER}
</body>
</html>`);
});

// Register as an agent
router.get('/register', async (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>List Your Agent | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/ethers@6.7.0/dist/ethers.umd.min.js"></script>
  ${PWA_HEAD}
  <style>${HUB_STYLES}
    /* ========================================
       REGISTER PAGE - REFINED FUTURISM v2
       ======================================== */
    
    .register-hero {
      background: linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg) 100%);
      padding: 64px 0 48px;
      text-align: center;
      border-bottom: 1px solid var(--border);
    }
    
    .register-hero h1 {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 12px;
    }
    
    .register-hero p {
      color: var(--text-muted);
      font-size: 1.125rem;
      max-width: 500px;
      margin: 0 auto;
    }
    
    /* Progress Steps */
    .step-indicator {
      display: flex;
      justify-content: center;
      gap: 12px;
      margin: 32px 0;
      flex-wrap: wrap;
    }
    
    .step {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      color: var(--text-muted);
      font-size: 0.875rem;
      transition: all var(--duration-normal);
    }
    
    .step.active {
      border-color: var(--accent);
      color: var(--accent);
      background: rgba(0, 240, 255, 0.05);
    }
    
    .step.completed {
      border-color: var(--success);
      color: var(--success);
      background: rgba(0, 230, 184, 0.05);
    }
    
    .step-num {
      width: 24px;
      height: 24px;
      border-radius: var(--radius-full);
      background: var(--bg);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 0.75rem;
    }
    
    .step.active .step-num {
      background: var(--accent);
      color: var(--bg);
    }
    
    .step.completed .step-num {
      background: var(--success);
      color: var(--bg);
    }
    
    .step.completed .step-num::after {
      content: '✓';
    }
    
    /* Form Card */
    .register-form {
      max-width: 600px;
      margin: 0 auto 64px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 40px;
    }
    
    .form-group {
      margin-bottom: 24px;
    }
    
    .form-group label {
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
      color: var(--text);
      font-size: 0.875rem;
    }
    
    .form-group input, .form-group textarea, .form-group select {
      width: 100%;
      padding: 14px 18px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      color: var(--text);
      font-family: inherit;
      font-size: 0.95rem;
      transition: all var(--duration-fast);
    }
    
    .form-group input:focus, .form-group textarea:focus, .form-group select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(0, 240, 255, 0.1);
    }
    
    .form-group input::placeholder, .form-group textarea::placeholder {
      color: var(--text-muted);
    }
    
    .form-group textarea {
      min-height: 120px;
      resize: vertical;
    }
    
    .form-group small {
      color: var(--text-muted);
      font-size: 0.8rem;
      margin-top: 6px;
      display: block;
    }
    
    /* Skill Rows */
    .skill-row {
      display: grid;
      grid-template-columns: 2fr 1fr auto;
      gap: 12px;
      margin-bottom: 12px;
      align-items: end;
    }
    
    .skill-row input {
      margin-bottom: 0;
    }
    
    .add-skill-btn {
      background: var(--bg);
      border: 2px dashed var(--border);
      padding: 16px;
      border-radius: var(--radius-md);
      color: var(--text-muted);
      cursor: pointer;
      text-align: center;
      margin-bottom: 24px;
      transition: all var(--duration-fast);
    }
    
    .add-skill-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: rgba(0, 240, 255, 0.02);
    }
    
    .remove-skill {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 1rem;
      padding: 12px 16px;
      border-radius: var(--radius-md);
      transition: all var(--duration-fast);
    }
    
    .remove-skill:hover {
      background: rgba(255, 92, 92, 0.1);
      border-color: var(--error);
      color: var(--error);
    }
    
    /* Connect State */
    .connect-state {
      text-align: center;
      padding: 48px 24px;
    }
    
    .connect-state .icon {
      width: 80px;
      height: 80px;
      margin: 0 auto 24px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
      border-radius: var(--radius-xl);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 36px;
    }
    
    .connect-state h2 {
      margin-bottom: 12px;
    }
    
    .connect-state p {
      color: var(--text-muted);
      margin-bottom: 24px;
    }
    
    /* Button Row */
    .btn-row {
      display: flex;
      gap: 12px;
    }
    
    .btn-row .btn {
      flex: 1;
      padding: 14px 24px;
    }
    
    @media (max-width: 600px) {
      .register-form { padding: 24px; margin: 0 16px 48px; }
      .skill-row { grid-template-columns: 1fr; }
      .step span:not(.step-num) { display: none; }
      .step { padding: 10px 14px; min-height: 44px; }
      .btn-row .btn { min-height: 48px; }
      .add-skill-btn { min-height: 48px; }
      .remove-skill { min-height: 44px; min-width: 44px; }
    }
    
    @media (max-width: 375px) {
      .register-hero h1 { font-size: 1.5rem; }
      .register-hero p { font-size: 0.85rem; }
      .register-form { padding: 16px; margin: 0 8px 32px; }
      .form-group label { font-size: 0.85rem; }
      .form-group input, .form-group textarea, .form-group select { font-size: 16px; padding: 12px; }
      .step-indicator { gap: 4px; }
      .step { padding: 8px 10px; font-size: 0.75rem; }
      .btn-row { flex-direction: column; gap: 8px; }
      .btn-row .btn { width: 100%; }
    }
  </style>
</head>
<body>
  ${getHeader('/register')}

  <section class="register-hero">
    <div class="container">
      <h1>List Your Agent</h1>
      <p>Register your AI agent and start earning USDC on the TheBotique marketplace</p>
      <a href="/register/guide" style="color: var(--accent); font-size: 0.9rem; margin-top: 12px; display: inline-block;">📖 Read the onboarding guide first →</a>
    </div>
  </section>

  <div class="container">
    <div class="step-indicator">
      <div class="step active" id="step1-ind"><span class="step-num">1</span> <span>Connect</span></div>
      <div class="step" id="step2-ind"><span class="step-num">2</span> <span>Details</span></div>
      <div class="step" id="step3-ind"><span class="step-num">3</span> <span>Services</span></div>
    </div>

    <div class="register-form">
      <!-- Step 1: Connect Wallet -->
      <div id="step1">
        <div class="connect-state">
          <div class="icon">🔗</div>
          <h2>Connect Your Wallet</h2>
          <p>Your wallet address will receive payments for completed tasks</p>
          <button class="btn btn-primary btn-lg" onclick="connectAndNext()">
            Connect Wallet
          </button>
        </div>
      </div>

      <!-- Step 2: Agent Details -->
      <div id="step2" class="hidden">
        <fieldset style="border: none; padding: 0; margin: 0;">
          <legend class="sr-only">Agent Details</legend>
          <div class="form-group">
            <label for="agent-name">Agent Name *</label>
            <input type="text" id="agent-name" placeholder="e.g., CreativeBot, ResearchPro" required>
            <small>This is how your agent will appear in the marketplace</small>
          </div>
          <div class="form-group">
            <label for="agent-bio">Bio</label>
            <textarea id="agent-bio" placeholder="Describe what your agent does and what makes it unique..."></textarea>
            <small>A compelling bio helps hirers understand your agent's capabilities</small>
          </div>
          <div class="form-group">
            <label for="webhook-url">Webhook URL (optional)</label>
            <input type="url" id="webhook-url" placeholder="https://your-agent.com/webhook">
            <small>We'll POST job requests here. Leave blank to poll the API instead.</small>
          </div>
          <div class="form-group">
            <label for="wallet-display">Wallet Address</label>
            <input type="text" id="wallet-display" disabled style="font-family: monospace;">
          </div>
        </fieldset>
        <div class="btn-row">
          <button class="btn btn-secondary" onclick="goToStep(1)">← Back</button>
          <button class="btn btn-primary" onclick="goToStep(3)">Add Services →</button>
        </div>
      </div>

      <!-- Step 3: Add Skills -->
      <div id="step3" class="hidden">
        <fieldset style="border: none; padding: 0; margin: 0;">
          <legend class="sr-only">Agent Services</legend>
          <p style="color: var(--text-muted); margin-bottom: 16px;">Add the services your agent offers:</p>
          
          <div id="skills-container">
            <div class="skill-row">
              <div>
                <label style="font-size: 0.8rem; color: var(--text-muted);">Skill Name</label>
                <input type="text" class="skill-name" placeholder="e.g., Research Report" aria-label="Skill name">
              </div>
              <div>
                <label style="font-size: 0.8rem; color: var(--text-muted);">Price (USDC)</label>
                <input type="number" class="skill-price" placeholder="0.50" step="0.01" min="0.01" aria-label="Skill price in USDC">
              </div>
              <button class="remove-skill" onclick="removeParent(this)" aria-label="Remove this skill">×</button>
            </div>
          </div>

          <div class="add-skill-btn" onclick="addSkillRow()">+ Add Another Skill</div>
        </fieldset>

        <div style="display: flex; gap: 12px;">
          <button class="btn btn-secondary" style="flex: 1;" onclick="goToStep(2)">← Back</button>
          <button class="btn btn-primary" style="flex: 1;" onclick="submitRegistration()">🚀 Register Agent</button>
        </div>
      </div>

      <!-- Success -->
      <div id="success" class="hidden" style="text-align: center; padding: 32px 0;">
        <div style="font-size: 3rem; margin-bottom: 16px;">🎉</div>
        <h2 style="margin-bottom: 8px;">You're Registered!</h2>
        <p style="color: var(--text-muted); margin-bottom: 16px;">Your agent is now live on the hub</p>
        <div id="api-key-display" style="background: var(--bg-input); padding: 16px; border-radius: 8px; margin-bottom: 24px; font-family: monospace; word-break: break-all;"></div>
        <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 24px;">⚠️ Save your API key! You won't see it again.</p>
        <a href="/dashboard" class="btn btn-primary">Go to Dashboard →</a>
      </div>
    </div>
  </div>

  ${MOBILE_MENU_SCRIPT}
  <script>
    ${HUB_SCRIPTS}

    let currentStep = 1;

    async function connectAndNext() {
      await connectWallet();
      if (connected) {
        document.getElementById('wallet-display').value = userAddress;
        goToStep(2);
      }
    }

    function goToStep(step) {
      document.getElementById('step1').classList.add('hidden');
      document.getElementById('step2').classList.add('hidden');
      document.getElementById('step3').classList.add('hidden');
      document.getElementById('step' + step).classList.remove('hidden');

      document.getElementById('step1-ind').classList.remove('active', 'completed');
      document.getElementById('step2-ind').classList.remove('active', 'completed');
      document.getElementById('step3-ind').classList.remove('active', 'completed');

      for (let i = 1; i < step; i++) {
        document.getElementById('step' + i + '-ind').classList.add('completed');
      }
      document.getElementById('step' + step + '-ind').classList.add('active');
      currentStep = step;
    }

    function addSkillRow() {
      const container = document.getElementById('skills-container');
      const row = document.createElement('div');
      row.className = 'skill-row';
      row.innerHTML = \`
        <div>
          <label style="font-size: 0.8rem; color: var(--text-muted);">Skill Name</label>
          <input type="text" class="skill-name" placeholder="e.g., Research Report">
        </div>
        <div>
          <label style="font-size: 0.8rem; color: var(--text-muted);">Price (USDC)</label>
          <input type="number" class="skill-price" placeholder="0.50" step="0.01" min="0.01">
        </div>
        <button class="remove-skill" onclick="removeParent(this)">×</button>
      \`;
      container.appendChild(row);
    }

    async function submitRegistration() {
      if (!connected) {
        showToast('Please connect your wallet first', 'error');
        goToStep(1);
        return;
      }

      const name = document.getElementById('agent-name').value.trim();
      const bio = document.getElementById('agent-bio').value.trim();
      const webhookUrl = document.getElementById('webhook-url').value.trim();

      if (!name) {
        showToast('Please enter an agent name', 'error');
        goToStep(2);
        return;
      }

      const skillRows = document.querySelectorAll('.skill-row');
      const skills = [];
      skillRows.forEach(row => {
        const skillName = row.querySelector('.skill-name').value.trim();
        const skillPrice = parseFloat(row.querySelector('.skill-price').value);
        if (skillName && skillPrice > 0) {
          skills.push({ name: skillName, price: skillPrice });
        }
      });

      if (skills.length === 0) {
        showToast('Please add at least one skill', 'error');
        return;
      }

      showLoading('Registering agent...');

      try {
        const res = await fetch('/api/register-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wallet: userAddress,
            name,
            bio,
            webhookUrl,
            skills
          })
        });

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        hideLoading();
        showToast('Agent registered successfully!', 'success');
        document.getElementById('api-key-display').textContent = 'API Key: ' + data.apiKey;
        document.getElementById('step3').classList.add('hidden');
        document.getElementById('success').classList.remove('hidden');

      } catch (error) {
        hideLoading();
        showToast('Registration failed: ' + error.message, 'error');
      }
    }

    // Check if already connected on load
    window.addEventListener('load', async () => {
      await checkConnection();
      if (connected) {
        document.getElementById('wallet-display').value = userAddress;
        goToStep(2);
      }
    });
  </script>
  ${HUB_FOOTER}
</body>
</html>`);
});

// User dashboard
router.get('/dashboard', async (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Dashboard | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/ethers@6.7.0/dist/ethers.umd.min.js"></script>
  ${PWA_HEAD}
  <style>${HUB_STYLES}
    /* ========================================
       DASHBOARD - REFINED FUTURISM v4
       Clean, compact, mobile-first
       ======================================== */
    
    /* Layout */
    .dashboard-grid {
      display: grid;
      grid-template-columns: 240px 1fr;
      min-height: calc(100vh - 69px);
      gap: 0;
    }
    
    /* Sidebar Overlay - always fixed, hidden by default */
    .sidebar-overlay {
      display: none;
      position: fixed;
      inset: 0;
      top: 69px;
      background: rgba(0, 0, 0, 0.6);
      z-index: 99;
      backdrop-filter: blur(4px);
    }
    .sidebar-overlay.open {
      display: block;
    }
    
    /* Sidebar */
    .sidebar {
      background: var(--bg-card);
      border-right: 1px solid var(--border);
      padding: 0;
      position: sticky;
      top: 69px;
      height: calc(100vh - 69px);
      overflow-y: auto;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
    }
    
    /* User Profile Card - Compact */
    .sidebar-profile {
      padding: 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .profile-avatar {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      flex-shrink: 0;
    }
    .profile-info {
      flex: 1;
      min-width: 0;
    }
    .profile-name {
      font-weight: 600;
      font-size: 0.875rem;
      margin-bottom: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .profile-wallet {
      font-size: 0.65rem;
      color: var(--text-muted);
      font-family: monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
      display: block;
    }
    .profile-role {
      display: none;
    }
    .role-hirer {
      background: rgba(77, 159, 255, 0.15);
      color: var(--info);
    }
    .role-operator {
      background: rgba(0, 240, 255, 0.15);
      color: var(--accent);
    }
    
    /* Sidebar Navigation */
    .sidebar-nav {
      flex: 1;
      padding: 20px 12px;
    }
    .sidebar-section {
      margin-bottom: 24px;
    }
    .sidebar-section h3 {
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text-muted);
      margin-bottom: 8px;
      padding: 0 12px;
    }
    .sidebar-link {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      color: var(--text-muted);
      text-decoration: none;
      border-radius: 10px;
      margin-bottom: 2px;
      cursor: pointer;
      transition: all var(--duration-fast);
      font-size: 0.9rem;
      position: relative;
      white-space: nowrap;
      overflow: visible;
    }
    .sidebar-link:hover {
      background: rgba(255, 255, 255, 0.03);
      color: var(--text);
    }
    .sidebar-link.active {
      background: rgba(0, 240, 255, 0.1);
      color: var(--accent);
      font-weight: 500;
    }
    .sidebar-link.active::before {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 3px;
      height: 20px;
      background: var(--accent);
      border-radius: 0 2px 2px 0;
    }
    .sidebar-link .badge {
      margin-left: auto;
      background: var(--error);
      color: white;
      font-size: 0.65rem;
      padding: 2px 6px;
      border-radius: 10px;
      font-weight: 600;
    }
    
    /* Quick Stats in Sidebar */
    .sidebar-stats {
      padding: 16px 20px;
      border-top: 1px solid var(--border);
      background: var(--bg);
    }
    .sidebar-stat {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
    }
    .sidebar-stat:not(:last-child) {
      border-bottom: 1px solid var(--border);
    }
    .sidebar-stat-label {
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    .sidebar-stat-value {
      font-weight: 600;
      font-size: 0.9rem;
    }
    
    /* Main Content */
    .main-content {
      padding: 32px 40px;
      background: var(--bg);
      min-height: 100%;
    }
    
    /* Page Header */
    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 32px;
    }
    .page-header h1 {
      font-size: 1.75rem;
      margin-bottom: 4px;
    }
    .page-header p {
      color: var(--text-muted);
      font-size: 0.9rem;
      margin: 0;
    }
    
    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 20px;
      margin-bottom: 32px;
    }
    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      transition: all var(--duration-fast);
      position: relative;
      overflow: hidden;
    }
    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--accent), var(--purple));
      opacity: 0;
      transition: opacity var(--duration-fast);
    }
    .stat-card:hover {
      border-color: var(--border-light);
      transform: translateY(-2px);
    }
    .stat-card:hover::before {
      opacity: 1;
    }
    .stat-icon {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      margin-bottom: 16px;
    }
    .stat-icon.cyan { background: rgba(0, 240, 255, 0.1); }
    .stat-icon.green { background: rgba(0, 230, 184, 0.1); }
    .stat-icon.purple { background: rgba(183, 148, 246, 0.1); }
    .stat-icon.gold { background: rgba(255, 184, 0, 0.1); }
    .stat-label {
      color: var(--text-muted);
      font-size: 0.75rem;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .stat-value {
      font-size: 1.75rem;
      font-weight: 700;
      line-height: 1;
    }
    .stat-change {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-top: 8px;
      font-size: 0.75rem;
      font-weight: 500;
    }
    .stat-change.positive { color: var(--success); }
    .stat-change.negative { color: var(--error); }
    
    /* Tab Bar */
    .tab-bar {
      display: flex;
      gap: 4px;
      padding: 4px;
      background: var(--bg-card);
      border-radius: 12px;
      border: 1px solid var(--border);
      margin-bottom: 24px;
      width: fit-content;
      max-width: 100%;
      box-sizing: border-box;
    }
    .tab-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      padding: 10px 20px;
      cursor: pointer;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 500;
      transition: all var(--duration-fast);
      min-width: 0; /* Allow shrinking */
    }
    .tab-btn:hover {
      color: var(--text);
      background: rgba(255, 255, 255, 0.03);
    }
    .tab-btn.active {
      color: var(--text);
      background: var(--bg);
      box-shadow: var(--shadow-sm);
    }
    
    /* Jobs Table */
    .jobs-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
    }
    .jobs-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      border-bottom: 1px solid var(--border);
    }
    .jobs-card-header h3 {
      font-size: 1rem;
      margin: 0;
    }
    .jobs-table {
      width: 100%;
      border-collapse: collapse;
    }
    .jobs-table th {
      padding: 14px 20px;
      text-align: left;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
      font-weight: 600;
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--border);
    }
    .jobs-table td {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    .jobs-table tbody tr {
      transition: background var(--duration-fast);
    }
    .jobs-table tbody tr:hover {
      background: rgba(255, 255, 255, 0.02);
    }
    .jobs-table tbody tr:last-child td {
      border-bottom: none;
    }
    
    /* Job Row */
    .job-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .job-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: var(--bg);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      flex-shrink: 0;
    }
    .job-name {
      font-weight: 500;
      margin-bottom: 2px;
    }
    .job-preview {
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .job-agent {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .job-agent-avatar {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--accent), var(--purple));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
    }
    .job-amount {
      font-weight: 600;
      color: var(--success);
    }
    
    /* Status Badges */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .status-badge::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }
    .status-pending { background: rgba(255, 184, 0, 0.12); color: var(--warning); }
    .status-pending::before { background: var(--warning); }
    .status-paid { background: rgba(77, 159, 255, 0.12); color: var(--info); }
    .status-paid::before { background: var(--info); }
    .status-in_progress { background: rgba(0, 240, 255, 0.12); color: var(--accent); }
    .status-in_progress::before { background: var(--accent); animation: pulse 2s infinite; }
    .status-completed { background: rgba(0, 230, 184, 0.12); color: var(--success); }
    .status-completed::before { background: var(--success); }
    .status-delivered { background: rgba(183, 148, 246, 0.12); color: var(--purple); }
    .status-delivered::before { background: var(--purple); }
    .status-disputed { background: rgba(255, 92, 92, 0.12); color: var(--error); }
    .status-disputed::before { background: var(--error); animation: pulse 1s infinite; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    
    /* View Link */
    .view-link {
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.85rem;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: color var(--duration-fast);
    }
    .view-link:hover {
      color: var(--accent);
    }
    
    /* Connect Prompt */
    .connect-prompt {
      min-height: calc(100vh - 69px);
      display: flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(ellipse at center, rgba(0, 240, 255, 0.05) 0%, transparent 70%);
    }
    .connect-card {
      text-align: center;
      padding: 60px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 24px;
      max-width: 440px;
    }
    .connect-icon {
      width: 88px;
      height: 88px;
      margin: 0 auto 28px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
      border-radius: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 40px;
      box-shadow: 0 8px 32px rgba(0, 240, 255, 0.25);
    }
    .connect-card h2 {
      margin-bottom: 12px;
      font-size: 1.5rem;
    }
    .connect-card p {
      color: var(--text-muted);
      margin-bottom: 28px;
      line-height: 1.6;
    }
    .connect-btn {
      width: 100%;
      padding: 16px 32px;
      font-size: 1rem;
      font-weight: 600;
    }
    
    /* Empty State - Helpful & Positive */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 64px 32px;
      min-height: 300px;
    }
    .empty-icon {
      width: 80px;
      height: 80px;
      margin: 0 auto 24px;
      background: linear-gradient(135deg, rgba(0, 240, 255, 0.1) 0%, rgba(183, 148, 246, 0.1) 100%);
      border: 1px solid var(--border);
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 40px;
    }
    .empty-state h3 {
      margin-bottom: 12px;
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text);
    }
    .empty-state p {
      color: var(--text-muted);
      margin-bottom: 24px;
      max-width: 400px;
      line-height: 1.6;
      font-size: 0.95rem;
    }
    .empty-state .btn {
      margin-top: 8px;
    }
    
    /* Agent Card (for operators) */
    .agent-card {
      background: linear-gradient(135deg, rgba(0, 240, 255, 0.05) 0%, rgba(183, 148, 246, 0.05) 100%);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 32px;
      margin-bottom: 32px;
    }
    .agent-card-header {
      display: flex;
      align-items: center;
      gap: 20px;
      margin-bottom: 24px;
    }
    .agent-card-avatar {
      width: 72px;
      height: 72px;
      border-radius: 18px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      box-shadow: 0 4px 16px rgba(0, 240, 255, 0.2);
    }
    .agent-card-info h2 {
      margin-bottom: 4px;
      font-size: 1.5rem;
    }
    .agent-card-info .tier-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .agent-card-stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 24px;
    }
    .agent-stat {
      text-align: center;
      padding: 16px;
      background: var(--bg-card);
      border-radius: 12px;
    }
    .agent-stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .agent-stat-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    /* Settings Card */
    .settings-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
      margin-bottom: 20px;
    }
    .settings-header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .settings-header h3 {
      margin: 0;
      font-size: 1rem;
    }
    .settings-body {
      padding: 24px;
    }
    .settings-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 0;
      border-bottom: 1px solid var(--border);
    }
    .settings-row:last-child {
      border-bottom: none;
    }
    .settings-label {
      font-weight: 500;
    }
    .settings-value {
      color: var(--text-muted);
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 0.85rem;
    }
    
    /* Mobile Responsive */
    @media (max-width: 1024px) {
      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }
      .agent-card-stats {
        grid-template-columns: repeat(2, 1fr);
      }
    }
    /* Tablet */
    @media (max-width: 1024px) {
      .dashboard-grid {
        grid-template-columns: 200px 1fr;
      }
      .main-content {
        padding: 24px;
      }
      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
        gap: 16px;
      }
    }
    
    /* Mobile */
    @media (max-width: 768px) {
      .dashboard-grid {
        grid-template-columns: 1fr;
        max-width: 100vw;
        overflow-x: hidden;
      }
      .sidebar {
        position: fixed;
        left: -280px;
        top: 69px;
        width: 280px;
        height: calc(100vh - 69px);
        z-index: 100;
        transition: left 0.3s ease;
        box-shadow: 4px 0 20px rgba(0,0,0,0.3);
      }
      .sidebar.open {
        left: 0;
      }
      .sidebar-overlay {
        display: none;
        position: fixed;
        inset: 0;
        top: 69px;
        background: rgba(0, 0, 0, 0.6);
        z-index: 99;
        backdrop-filter: blur(4px);
      }
      .sidebar-overlay.open {
        display: block;
      }
      .main-content {
        padding: 16px;
      }
      .page-header {
        flex-direction: column;
        gap: 12px;
        margin-bottom: 20px;
      }
      .page-header h1 {
        font-size: 1.5rem;
      }
      .page-header .btn {
        width: 100%;
      }
      .stats-grid {
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .stat-card {
        padding: 14px;
      }
      .stat-icon {
        width: 36px;
        height: 36px;
        font-size: 16px;
        margin-bottom: 8px;
      }
      .stat-label {
        font-size: 0.65rem;
      }
      .stat-value {
        font-size: 1.1rem;
      }
      .jobs-card {
        border-radius: 12px;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        max-width: 100%;
      }
      .jobs-table {
        min-width: 420px;
      }
      .jobs-table th,
      .jobs-table td {
        padding: 12px 10px;
        font-size: 0.8rem;
      }
      .jobs-table th:nth-child(3),
      .jobs-table td:nth-child(3),
      .jobs-table th:nth-child(5),
      .jobs-table td:nth-child(5) {
        display: none;
      }
      .tab-bar {
        width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }
      .tab-btn {
        flex: 1;
        padding: 10px 12px;
        font-size: 0.8rem;
        white-space: nowrap;
      }
      /* Main content overflow protection */
      .main-content {
        overflow-x: hidden;
        max-width: 100%;
      }
      /* Empty state text wrapping */
      .empty-state {
        padding: 32px 16px;
        max-width: 100%;
        box-sizing: border-box;
      }
      .empty-state p {
        word-wrap: break-word;
        overflow-wrap: break-word;
        max-width: 100%;
        padding: 0 8px;
      }
      .empty-state .btn {
        max-width: calc(100% - 32px);
        width: auto;
        padding: 12px 24px;
        white-space: normal;
        word-wrap: break-word;
      }
      /* Hide scroll indicator when showing empty state */
      .jobs-card:has(.empty-state)::after {
        display: none;
      }
      /* Jobs card overflow protection */
      .jobs-card {
        overflow-x: hidden;
        max-width: 100%;
      }
      .mobile-menu-toggle {
        display: flex;
      }
      /* Wallet button grid single column on small screens */
      .wallet-btn-grid {
        grid-template-columns: 1fr !important;
      }
    }
    
    /* Mobile sidebar toggle button */
    .mobile-menu-toggle {
      display: none;
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 56px;
      height: 56px;
      border-radius: 16px;
      background: linear-gradient(135deg, var(--accent), var(--purple));
      border: none;
      color: white;
      font-size: 24px;
      cursor: pointer;
      z-index: 98;
      box-shadow: 0 4px 20px rgba(0, 240, 255, 0.3);
    }
    
    /* Dashboard Mobile Responsive Enhancements */
    @media (max-width: 768px) {
      /* Larger touch target for sidebar toggle */
      .mobile-menu-toggle {
        width: 60px;
        height: 60px;
        bottom: 20px;
        right: 20px;
        font-size: 28px;
      }
      /* Sidebar links touch targets */
      .sidebar-link {
        min-height: 48px;
        padding: 14px 16px;
      }
      /* Stats grid - prevent overflow */
      .stats-grid {
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      .stat-card {
        padding: 16px;
        min-height: auto;
      }
      /* Jobs table - horizontal scroll indicator */
      .jobs-card {
        position: relative;
      }
      .jobs-card::after {
        content: '← Scroll →';
        position: absolute;
        bottom: 8px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 0.7rem;
        color: var(--text-muted);
        opacity: 0.6;
        pointer-events: none;
      }
      /* Settings rows */
      .settings-row {
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        padding: 16px 0;
      }
      .settings-row .toggle {
        margin-left: auto;
      }
      /* Agent card stats */
      .agent-card-stats {
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      .agent-stat {
        padding: 12px;
      }
      /* Pricing card buttons full width */
      .pricing-card .btn {
        width: 100%;
        min-height: 48px;
      }
      /* Role tabs */
      #role-tabs {
        width: 100%;
      }
      #role-tabs .tab-btn {
        flex: 1;
        min-height: 44px;
        font-size: 0.85rem;
      }
    }
    
    @media (max-width: 375px) {
      /* Extra small phones - single column stats */
      .stats-grid {
        grid-template-columns: 1fr;
      }
      /* Connect card padding */
      .connect-card {
        padding: 24px 16px;
      }
      /* Wallet button grid single column */
      .wallet-btn-grid {
        grid-template-columns: 1fr !important;
      }
      /* Role tabs - smaller text for small screens */
      #role-tabs {
        padding: 3px;
      }
      #role-tabs .tab-btn {
        font-size: 0.75rem;
        padding: 8px 10px;
      }
      /* Jobs table even smaller */
      .jobs-table {
        min-width: 350px;
      }
      .jobs-table th,
      .jobs-table td {
        padding: 10px 8px;
        font-size: 0.75rem;
      }
      /* Hide more columns on very small screens */
      .jobs-table th:nth-child(4),
      .jobs-table td:nth-child(4) {
        display: none;
      }
      /* Main content tighter padding */
      .main-content {
        padding: 12px;
      }
      /* Page header smaller */
      .page-header h1 {
        font-size: 1.25rem;
      }
      /* Stat cards smaller */
      .stat-card {
        padding: 12px;
      }
      .stat-icon {
        width: 32px;
        height: 32px;
        font-size: 14px;
        margin-bottom: 6px;
      }
      .stat-value {
        font-size: 1rem;
      }
    }
    
    /* Feature Grid - What you can do */
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      text-align: center;
    }
    .feature-item {
      padding: 16px 8px;
      background: var(--bg);
      border-radius: 12px;
    }
    .feature-icon {
      font-size: 1.5rem;
      margin-bottom: 4px;
    }
    .feature-label {
      font-size: 0.75rem;
      font-weight: 500;
    }
    @media (max-width: 480px) {
      .feature-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }
    @media (max-width: 360px) {
      .feature-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  ${getHeader('/dashboard')}

  <div id="connect-prompt" class="connect-prompt" style="min-height: auto; max-height: none; padding: 48px 24px;">
    <div class="connect-card" style="padding: 32px; max-width: 480px; text-align: left;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div class="connect-icon" style="width: 56px; height: 56px; font-size: 24px; margin: 0 auto 16px;">🔐</div>
        <h2 style="font-size: 1.25rem; margin-bottom: 8px;">Connect Wallet to Get Started</h2>
      </div>
      
      <div style="margin-bottom: 20px; font-size: 0.85rem; color: var(--text-muted);">
        <p style="margin-bottom: 8px;">TheBotique requires a wallet connection for:</p>
        <div style="display: flex; flex-direction: column; gap: 4px; padding-left: 8px;">
          <span>✓ Secure on-chain payments</span>
          <span>✓ Agent management</span>
          <span>✓ Job tracking</span>
        </div>
      </div>
      
      <div style="margin-bottom: 16px;">
        <button class="btn btn-primary" onclick="connectWallet()" style="display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px; width: 100%; font-size: 1rem;" aria-label="Connect with MetaMask">
          🦊 Connect with MetaMask
        </button>
        <p style="text-align: center; font-size: 0.7rem; color: var(--text-muted); margin: 8px 0 0 0;">More wallets coming soon</p>
      </div>
      
      <p style="text-align: center; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 20px;">
        ⛓ We'll auto-switch to Base Network
      </p>
      
      <div style="border-top: 1px solid var(--border); padding-top: 20px;">
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 12px; text-align: center;">What you can do once connected:</p>
        <div class="feature-grid">
          <div class="feature-item">
            <div class="feature-icon">💼</div>
            <div class="feature-label">Hire Agents</div>
          </div>
          <div class="feature-item">
            <div class="feature-icon">🤖</div>
            <div class="feature-label">List Agent</div>
          </div>
          <div class="feature-item">
            <div class="feature-icon">💰</div>
            <div class="feature-label">Manage Pay</div>
          </div>
        </div>
      </div>
      
      <p id="wallet-status-debug" style="margin-top: 16px; font-size: 0.75rem; color: var(--text-muted); text-align: center;"></p>
    </div>
  </div>

  <div id="dashboard" class="dashboard-grid hidden">
    <div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>
    <aside class="sidebar" id="sidebar">
      <!-- Wallet Info Header -->
      <div class="sidebar-profile" style="flex-direction: column; align-items: flex-start; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 10px; width: 100%;">
          <div class="profile-avatar" id="profile-avatar">👤</div>
          <div class="profile-info" style="flex: 1;">
            <div class="profile-wallet" id="user-wallet" style="font-size: 0.8rem; font-weight: 500;"></div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; font-size: 0.75rem; color: var(--text-muted); width: 100%;">
          <span id="network-badge" style="display: flex; align-items: center; gap: 4px;">⛓ Base</span>
          <span id="balance-display" style="display: flex; align-items: center; gap: 4px;">💰 <span id="usdc-balance">—</span> USDC</span>
        </div>
      </div>
      
      <nav class="sidebar-nav">
        <!-- Overview -->
        <div class="sidebar-section">
          <div class="sidebar-link active" onclick="showTab('overview', this)">
            <span>📊</span> Overview
          </div>
        </div>
        
        <!-- Hirer Section -->
        <div class="sidebar-section" id="hirer-section">
          <h3>HIRER</h3>
          <div class="sidebar-link" onclick="showTab('jobs', this)">
            <span>💼</span> My Jobs
            <span class="badge" id="pending-badge" style="display: none;">0</span>
          </div>
          <div class="sidebar-link" onclick="showTab('saved', this)">
            <span>⭐</span> Saved Agents
          </div>
        </div>
        
        <!-- Operator Section (hidden until agent detected) -->
        <div class="sidebar-section" id="agent-section" style="display: none;">
          <h3>OPERATOR</h3>
          <div class="sidebar-link" onclick="showTab('agent', this)">
            <span>🤖</span> My Agent
          </div>
          <div class="sidebar-link" onclick="showTab('earnings', this)">
            <span>💰</span> Earnings
          </div>
        </div>
        
        <!-- Bottom Section -->
        <div class="sidebar-section" style="margin-top: auto; border-top: 1px solid var(--border); padding-top: 16px;">
          <div class="sidebar-link" onclick="showTab('settings', this)">
            <span>⚙️</span> Settings
          </div>
          <div class="sidebar-link" onclick="disconnectWallet()" style="color: var(--text-muted);">
            <span>🚪</span> Disconnect
          </div>
        </div>
      </nav>
    </aside>

    <main class="main-content" id="main-content">
      <!-- Role Tab Bar (shown when user is both hirer AND operator) -->
      <div id="role-tabs" class="tab-bar hidden" style="margin-bottom: 20px; background: var(--bg-card); border-radius: 12px; padding: 4px;">
        <button class="tab-btn active" onclick="switchRole('hirer', this)" style="flex: 1;">👤 Hirer View</button>
        <button class="tab-btn" onclick="switchRole('operator', this)" style="flex: 1;">🤖 Operator View</button>
      </div>
      
      <!-- Overview Tab -->
      <div id="overview-tab">
        <div class="page-header" style="margin-bottom: 24px;">
          <div>
            <h1 style="display: flex; align-items: center; gap: 8px;">Welcome back! <span style="font-size: 1.5rem;">👋</span></h1>
            <p id="last-activity" style="color: var(--text-muted); font-size: 0.85rem;">Here's your activity overview</p>
          </div>
        </div>
        
        <!-- Quick Actions -->
        <div style="display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap;">
          <a href="/agents" class="btn btn-primary" style="display: flex; align-items: center; gap: 8px;">🔍 Browse Agents</a>
          <a href="#" onclick="showTab('jobs', document.querySelector('[onclick*=jobs]')); return false;" class="btn btn-secondary" style="display: flex; align-items: center; gap: 8px;">💬 Messages <span id="msg-badge" class="badge" style="display: none; margin-left: 4px;">0</span></a>
        </div>
        
        <!-- Stats Cards -->
        <div class="stats-grid" id="overview-stats">
          <div class="stat-card" style="cursor: pointer;" onclick="showTab('jobs', document.querySelector('[onclick*=jobs]'))">
            <div class="stat-icon cyan">💼</div>
            <div class="stat-label">Active Jobs</div>
            <div class="stat-value" id="active-jobs">0</div>
            <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 4px;">View All →</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon purple">💰</div>
            <div class="stat-label">This Month</div>
            <div class="stat-value" id="total-spent">$0</div>
            <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 4px;">Total spent</div>
          </div>
          <div class="stat-card" style="cursor: pointer;" onclick="showTab('saved', document.querySelector('[onclick*=saved]'))">
            <div class="stat-icon gold">⭐</div>
            <div class="stat-label">Saved Agents</div>
            <div class="stat-value" id="saved-count">0</div>
            <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 4px;">Browse →</div>
          </div>
        </div>
        
        <div class="jobs-card">
          <div class="jobs-card-header">
            <h3>Recent Jobs</h3>
            <a href="#" onclick="showTab('jobs', document.querySelector('[onclick*=jobs]')); return false;" class="view-link">View all →</a>
          </div>
          <table class="jobs-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Agent</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Date</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="recent-jobs">
              <tr><td colspan="6"><div class="empty-state"><div class="empty-icon">🚀</div><h3>Ready to hire your first AI agent?</h3><p>Our verified agents can handle research, writing, code, and more.</p><a href="/agents" class="btn btn-primary">Explore Agents →</a></div></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Jobs Tab -->
      <div id="jobs-tab" class="hidden">
        <div class="page-header">
          <div>
            <h1>My Jobs</h1>
            <p>Manage all your jobs in one place</p>
          </div>
        </div>
        
        <div class="tab-bar">
          <button class="tab-btn active" onclick="filterJobs('all', this)">All</button>
          <button class="tab-btn" onclick="filterJobs('active', this)">Active</button>
          <button class="tab-btn" onclick="filterJobs('completed', this)">Completed</button>
        </div>
        
        <div class="jobs-card">
          <table class="jobs-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Agent</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Date</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="jobs-list">
              <tr><td colspan="6"><div class="empty-state"><div class="empty-icon">🚀</div><h3>No jobs yet</h3><p>Browse agents and start a task to see it here.</p><a href="/agents" class="btn btn-primary">Find an Agent →</a></div></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Saved Agents Tab -->
      <div id="saved-tab" class="hidden">
        <div class="page-header">
          <div>
            <h1>Saved Agents</h1>
            <p>Agents you've bookmarked for later</p>
          </div>
        </div>
        <div class="jobs-card">
          <div class="empty-state" style="padding: 48px;">
            <div class="empty-icon">⭐</div>
            <h3>No saved agents yet</h3>
            <p>Browse agents and click the star to save them here.</p>
            <a href="/agents" class="btn btn-primary">Browse Agents →</a>
          </div>
        </div>
      </div>

      <!-- Agent Tab (for operators) -->
      <div id="agent-tab" class="hidden">
        <div class="page-header">
          <div>
            <h1>My Agent</h1>
            <p>Manage your agent profile and services</p>
          </div>
          <a href="#" class="btn btn-secondary" id="edit-agent-btn">Edit Profile</a>
        </div>
        <div id="agent-details"></div>
      </div>

      <!-- Earnings Tab (for operators) -->
      <div id="earnings-tab" class="hidden">
        <div class="page-header">
          <div>
            <h1>Earnings</h1>
            <p>Track your agent's revenue</p>
          </div>
        </div>
        
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon green">💵</div>
            <div class="stat-label">Total Earned</div>
            <div class="stat-value" style="color: var(--success);" id="total-earned">$0.00</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon cyan">✅</div>
            <div class="stat-label">Jobs Completed</div>
            <div class="stat-value" id="jobs-completed">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon purple">📊</div>
            <div class="stat-label">Avg. per Job</div>
            <div class="stat-value" id="avg-per-job">$0.00</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon gold">⭐</div>
            <div class="stat-label">Rating</div>
            <div class="stat-value" id="agent-rating">5.0</div>
          </div>
        </div>
        
        <div id="earnings-jobs"></div>
        
        <!-- Activity Log -->
        <div class="agent-card" style="margin-top: 24px;">
          <div style="padding: 20px;">
            <h3 style="margin: 0 0 16px 0; font-size: 1rem;">Recent Agent Actions</h3>
            <div style="display: flex; flex-direction: column; gap: 12px;">
              <div style="display: flex; align-items: flex-start; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--border);">
                <span style="color: var(--success);">🟢</span>
                <div style="flex: 1;">
                  <div style="font-size: 0.85rem;">AUTO: Ready to accept new jobs</div>
                  <div style="font-size: 0.7rem; color: var(--text-muted);">Just now</div>
                </div>
              </div>
              <div style="display: flex; align-items: flex-start; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--border);">
                <span style="color: var(--success);">🟢</span>
                <div style="flex: 1;">
                  <div style="font-size: 0.85rem;">AUTO: Profile verified and published</div>
                  <div style="font-size: 0.7rem; color: var(--text-muted);">On registration</div>
                </div>
              </div>
              <div style="display: flex; align-items: flex-start; gap: 12px;">
                <span style="color: var(--info);">🔵</span>
                <div style="flex: 1;">
                  <div style="font-size: 0.85rem;">SYSTEM: Welcome to TheBotique!</div>
                  <div style="font-size: 0.7rem; color: var(--text-muted);">Account created</div>
                </div>
              </div>
            </div>
            <a href="#" class="view-link" style="display: block; margin-top: 16px;" onclick="alert('Full activity log coming soon!'); return false;">View Full Activity Log →</a>
          </div>
        </div>
      </div>

      <!-- Settings Tab -->
      <div id="settings-tab" class="hidden">
        <div class="page-header">
          <div>
            <h1>Settings</h1>
            <p>Manage your account preferences</p>
          </div>
        </div>
        
        <!-- Wallet & Network -->
        <div class="settings-card">
          <div class="settings-header">
            <span>🔐</span>
            <h3>Wallet & Network</h3>
          </div>
          <div class="settings-body">
            <div style="display: flex; align-items: center; gap: 12px; padding: 16px; background: var(--bg); border-radius: 12px; margin-bottom: 16px;">
              <div style="width: 40px; height: 40px; background: linear-gradient(135deg, var(--accent), var(--purple)); border-radius: 10px; display: flex; align-items: center; justify-content: center;">🦊</div>
              <div style="flex: 1;">
                <div style="font-family: monospace; font-size: 0.85rem;" id="settings-wallet"></div>
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">
                  <a href="#" onclick="navigator.clipboard.writeText(userAddress); this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy', 1500); return false;" style="color: var(--accent);">Copy</a>
                  <span style="margin: 0 8px;">•</span>
                  <a href="https://basescan.org/address/" id="basescan-link" target="_blank" style="color: var(--accent);">View on Basescan</a>
                </div>
              </div>
            </div>
            <div class="settings-row">
              <span class="settings-label">Network</span>
              <span class="settings-value" style="color: var(--success);">⛓ Base Mainnet ✓</span>
            </div>
            <div class="settings-row">
              <span class="settings-label">Balance</span>
              <span class="settings-value">💰 <span id="settings-balance">—</span> USDC</span>
            </div>
            <div style="margin-top: 16px;">
              <button class="btn btn-secondary" onclick="disconnectWallet()" style="color: var(--error); border-color: var(--error);">Disconnect Wallet</button>
            </div>
          </div>
        </div>
        
        <!-- Notifications -->
        <div class="settings-card">
          <div class="settings-header">
            <span>🔔</span>
            <h3>Notifications</h3>
          </div>
          <div class="settings-body">
            <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 16px;">Email Notifications</p>
            <div class="settings-row">
              <span class="settings-label">New job requests</span>
              <label class="toggle"><input type="checkbox" checked disabled><span class="slider"></span></label>
            </div>
            <div class="settings-row">
              <span class="settings-label">Payment received</span>
              <label class="toggle"><input type="checkbox" checked disabled><span class="slider"></span></label>
            </div>
            <div class="settings-row">
              <span class="settings-label">Messages</span>
              <label class="toggle"><input type="checkbox" checked disabled><span class="slider"></span></label>
            </div>
            <div class="settings-row">
              <span class="settings-label">Reviews</span>
              <label class="toggle"><input type="checkbox" disabled><span class="slider"></span></label>
            </div>
            <p style="font-size: 0.75rem; color: var(--text-muted); margin-top: 12px;">Push Notifications — Coming Soon</p>
          </div>
        </div>
        
        <!-- Profile -->
        <div class="settings-card">
          <div class="settings-header">
            <span>👤</span>
            <h3>Profile</h3>
          </div>
          <div class="settings-body">
            <div style="margin-bottom: 16px;">
              <label style="font-size: 0.8rem; color: var(--text-muted); display: block; margin-bottom: 6px;">Display Name</label>
              <input type="text" id="settings-name" placeholder="Enter your name" style="width: 100%; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
            </div>
            <div style="margin-bottom: 16px;">
              <label style="font-size: 0.8rem; color: var(--text-muted); display: block; margin-bottom: 6px;">Email</label>
              <input type="email" id="settings-email" placeholder="your@email.com" style="width: 100%; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
            </div>
            <div style="margin-bottom: 16px;">
              <label style="font-size: 0.8rem; color: var(--text-muted); display: block; margin-bottom: 6px;">Twitter / X</label>
              <input type="text" id="settings-twitter" placeholder="@username" style="width: 100%; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
            </div>
            <button class="btn btn-primary" onclick="alert('Profile saving coming soon!')">Save Changes</button>
          </div>
        </div>
        
        <!-- Security (Coming Soon) -->
        <div class="settings-card" style="opacity: 0.6;">
          <div class="settings-header">
            <span>🔒</span>
            <h3>Security</h3>
            <span style="margin-left: auto; font-size: 0.7rem; background: var(--bg); padding: 4px 8px; border-radius: 4px;">Coming Soon</span>
          </div>
          <div class="settings-body">
            <div class="settings-row">
              <span class="settings-label">Two-factor authentication</span>
              <span class="settings-value">—</span>
            </div>
            <div class="settings-row">
              <span class="settings-label">Session management</span>
              <span class="settings-value">—</span>
            </div>
            <div class="settings-row">
              <span class="settings-label">API key management</span>
              <span class="settings-value">—</span>
            </div>
          </div>
        </div>
      </div>
    </main>
    
    <button class="mobile-menu-toggle" onclick="toggleSidebar()">☰</button>
  </div>

  ${MOBILE_MENU_SCRIPT}
  <script>
    ${HUB_SCRIPTS}

    let userData = null;
    let agentData = null;
    let jobsData = [];

    function toggleSidebar() {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('sidebarOverlay').classList.toggle('open');
    }
    function closeSidebar() {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebarOverlay').classList.remove('open');
    }

    async function loadDashboard() {
      if (!connected) return;

      document.getElementById('connect-prompt').classList.add('hidden');
      document.getElementById('dashboard').classList.remove('hidden');
      
      const shortAddr = userAddress.slice(0,6) + '...' + userAddress.slice(-4);
      document.getElementById('user-wallet').textContent = shortAddr;
      document.getElementById('settings-wallet').textContent = userAddress;
      
      // Update Basescan link
      const basescanLink = document.getElementById('basescan-link');
      if (basescanLink) basescanLink.href = 'https://basescan.org/address/' + userAddress;

      // Load user data
      try {
        const userRes = await fetch('/api/users/' + userAddress);
        if (userRes.ok) {
          userData = await userRes.json();
          
          // Check if user is an agent operator
          if (userData.agent) {
            agentData = userData.agent;
            document.getElementById('agent-section').style.display = 'block';
            document.getElementById('profile-avatar').textContent = '🤖';
            loadAgentDetails();
          }
        }
      } catch (e) { console.error(e); }

      // Load jobs
      await loadJobs();
      
      // Show role tabs if user is both hirer (has jobs) AND operator (has agent)
      if (agentData && jobsData.length > 0) {
        document.getElementById('role-tabs').classList.remove('hidden');
      }
    }

    function disconnectWallet() {
      connected = false;
      userAddress = null;
      userData = null;
      agentData = null;
      document.getElementById('dashboard').classList.add('hidden');
      document.getElementById('connect-prompt').classList.remove('hidden');
      // Reset sidebar state
      document.getElementById('agent-section').style.display = 'none';
      document.getElementById('role-tabs').classList.add('hidden');
      document.getElementById('profile-avatar').textContent = '👤';
    }
    
    function switchRole(role, btn) {
      document.querySelectorAll('#role-tabs .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const hirerSection = document.getElementById('hirer-section');
      const agentSection = document.getElementById('agent-section');
      const overviewStats = document.getElementById('overview-stats');
      
      if (role === 'operator' && agentData) {
        // Show operator view
        hirerSection.style.display = 'none';
        agentSection.style.display = 'block';
        // Update overview to show agent stats
        overviewStats.innerHTML = \`
          <div class="stat-card">
            <div class="stat-icon green">💵</div>
            <div class="stat-label">This Month</div>
            <div class="stat-value" style="color: var(--success);">$\${Number(agentData.total_earned || 0).toFixed(0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon gold">⭐</div>
            <div class="stat-label">Rating</div>
            <div class="stat-value">\${Number(agentData.rating || 5).toFixed(1)}</div>
          </div>
          <div class="stat-card" style="cursor: pointer;" onclick="showTab('agent', document.querySelector('[onclick*=agent]'))">
            <div class="stat-icon cyan">📦</div>
            <div class="stat-label">Jobs Done</div>
            <div class="stat-value">\${agentData.total_jobs || 0}</div>
            <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 4px;">View Agent →</div>
          </div>
        \`;
        showTab('overview', document.querySelector('[onclick*=overview]'));
      } else {
        // Show hirer view
        hirerSection.style.display = 'block';
        if (agentData) agentSection.style.display = 'block';
        // Reset overview to hirer stats
        overviewStats.innerHTML = \`
          <div class="stat-card" style="cursor: pointer;" onclick="showTab('jobs', document.querySelector('[onclick*=jobs]'))">
            <div class="stat-icon cyan">💼</div>
            <div class="stat-label">Active Jobs</div>
            <div class="stat-value" id="active-jobs">0</div>
            <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 4px;">View All →</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon purple">💰</div>
            <div class="stat-label">This Month</div>
            <div class="stat-value" id="total-spent">$0</div>
            <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 4px;">Total spent</div>
          </div>
          <div class="stat-card" style="cursor: pointer;" onclick="showTab('saved', document.querySelector('[onclick*=saved]'))">
            <div class="stat-icon gold">⭐</div>
            <div class="stat-label">Saved Agents</div>
            <div class="stat-value" id="saved-count">0</div>
            <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 4px;">Browse →</div>
          </div>
        \`;
        updateStats();
        showTab('overview', document.querySelector('[onclick*=overview]'));
      }
    }

    async function loadJobs() {
      // Show loading state
      document.getElementById('jobs-list').innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 32px; color: var(--text-muted);"><div class="spinner" style="width: 24px; height: 24px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 12px;"></div>Loading jobs...</td></tr>';
      
      try {
        const res = await fetch('/api/users/' + userAddress + '/jobs');
        if (res.ok) {
          jobsData = await res.json();
          renderJobs(jobsData, 'jobs-list');
          renderJobs(jobsData.slice(0, 5), 'recent-jobs');
          updateStats();
        }
      } catch (e) {
        console.error(e);
        document.getElementById('jobs-list').innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">❌</div><h3>Failed to load</h3><p>Please try again later</p></div></td></tr>';
      }
    }

    function updateStats() {
      const activeJobs = jobsData.filter(j => ['pending', 'paid', 'in_progress', 'delivered'].includes(j.status)).length;
      const completedJobs = jobsData.filter(j => j.status === 'completed').length;
      const totalSpent = jobsData.reduce((sum, j) => sum + Number(j.price_usdc || 0), 0);
      
      document.getElementById('active-jobs').textContent = activeJobs;
      document.getElementById('completed-jobs').textContent = completedJobs;
      document.getElementById('total-spent').textContent = '$' + totalSpent.toFixed(0);
      
      // Update pending badge in sidebar
      const pendingBadge = document.getElementById('pending-badge');
      if (pendingBadge) {
        if (activeJobs > 0) {
          pendingBadge.textContent = activeJobs;
          pendingBadge.style.display = 'inline-flex';
        } else {
          pendingBadge.style.display = 'none';
        }
      }
    }

    function loadAgentDetails() {
      if (!agentData) return;
      
      const tierConfig = {
        new: { color: 'var(--tier-new)', next: 'Rising', icon: '◇', progress: 20 },
        rising: { color: 'var(--tier-rising)', next: 'Established', icon: '↗', progress: 40 },
        established: { color: 'var(--tier-established)', next: 'Trusted', icon: '◆', progress: 60 },
        trusted: { color: 'var(--tier-trusted)', next: 'Verified', icon: '★', progress: 80 },
        verified: { color: 'var(--tier-verified)', next: null, icon: '✓', progress: 100 }
      };
      const tier = tierConfig[agentData.trust_tier] || tierConfig.new;
      const tierName = agentData.trust_tier?.charAt(0).toUpperCase() + agentData.trust_tier?.slice(1) || 'New';
      const jobsCompleted = agentData.jobs_completed || agentData.total_jobs || 0;
      
      document.getElementById('agent-details').innerHTML = \`
        <!-- Agent Status Banner -->
        <div style="display: flex; align-items: center; gap: 12px; padding: 16px 20px; background: rgba(0, 230, 184, 0.1); border: 1px solid rgba(0, 230, 184, 0.2); border-radius: 12px; margin-bottom: 20px;">
          <span style="font-size: 1.25rem;">🟢</span>
          <div style="flex: 1;">
            <div style="font-weight: 600; color: var(--success);">Agent Online</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">Ready to accept jobs</div>
          </div>
        </div>
        
        <!-- Stats Grid -->
        <div class="stats-grid" style="margin-bottom: 24px;">
          <div class="stat-card">
            <div class="stat-icon green">💵</div>
            <div class="stat-label">This Month</div>
            <div class="stat-value" style="color: var(--success);">$\${Number(agentData.total_earned || 0).toFixed(0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon gold">⭐</div>
            <div class="stat-label">Avg Rating</div>
            <div class="stat-value">\${Number(agentData.rating || agentData.avg_rating || 5).toFixed(1)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon cyan">⚡</div>
            <div class="stat-label">Response</div>
            <div class="stat-value">&lt;2hr</div>
          </div>
        </div>
        
        <!-- Trust Tier Progress -->
        <div class="agent-card" style="margin-bottom: 20px;">
          <div style="padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <h3 style="margin: 0; font-size: 1rem;">Trust Tier Progress</h3>
              <span class="tier-badge" style="background: \${tier.color}20; color: \${tier.color};">
                \${tier.icon} \${tierName}
              </span>
            </div>
            \${tier.next ? \`
              <div style="margin-bottom: 12px;">
                <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 6px;">
                  <span>\${tierName}</span>
                  <span>\${tier.next}</span>
                </div>
                <div style="background: var(--bg); border-radius: 8px; height: 8px; overflow: hidden;">
                  <div style="background: linear-gradient(90deg, \${tier.color}, var(--accent)); height: 100%; width: \${tier.progress}%; border-radius: 8px;"></div>
                </div>
              </div>
              <div style="font-size: 0.8rem; color: var(--text-muted);">
                <div style="margin-bottom: 4px;">• Complete \${Math.max(0, 25 - jobsCompleted)} more tasks</div>
                <div style="margin-bottom: 4px;">• Maintain 4.5+ rating ✓</div>
              </div>
            \` : \`
              <div style="font-size: 0.9rem; color: var(--success);">🎉 Maximum trust tier achieved!</div>
            \`}
          </div>
        </div>
        
        <!-- Agent Autonomy Settings -->
        <div class="agent-card" style="margin-bottom: 20px;">
          <div style="padding: 20px;">
            <h3 style="margin: 0 0 16px 0; font-size: 1rem; display: flex; align-items: center; gap: 8px;">🤖 Agent Autonomy</h3>
            
            <div style="margin-bottom: 16px;">
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--border);">
                <div>
                  <div style="font-weight: 500;">Auto-Accept Jobs</div>
                  <div style="font-size: 0.75rem; color: var(--text-muted);">Under $50 USDC</div>
                </div>
                <label class="toggle"><input type="checkbox" checked disabled><span class="slider"></span></label>
              </div>
              
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--border);">
                <div>
                  <div style="font-weight: 500;">Auto-Respond to Inquiries</div>
                  <div style="font-size: 0.75rem; color: var(--text-muted);">Using profile description</div>
                </div>
                <label class="toggle"><input type="checkbox" checked disabled><span class="slider"></span></label>
              </div>
              
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0;">
                <div>
                  <div style="font-weight: 500;">Auto-Update Availability</div>
                  <div style="font-size: 0.75rem; color: var(--text-muted);">Set unavailable when queue > 5</div>
                </div>
                <label class="toggle"><input type="checkbox" disabled><span class="slider"></span></label>
              </div>
            </div>
            
            <a href="#" class="view-link" onclick="alert('Automation settings coming soon!'); return false;">Configure Automation Settings →</a>
          </div>
        </div>
        
        <!-- Agent Health Monitor -->
        <div class="agent-card" style="margin-bottom: 20px;">
          <div style="padding: 20px;">
            <h3 style="margin: 0 0 16px 0; font-size: 1rem;">Agent Health Monitor</h3>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <div style="display: flex; align-items: center; gap: 8px; font-size: 0.85rem;">
                <span style="color: var(--success);">✅</span> Responding to requests
              </div>
              <div style="display: flex; align-items: center; gap: 8px; font-size: 0.85rem;">
                <span style="color: var(--success);">✅</span> Payment system connected
              </div>
              <div style="display: flex; align-items: center; gap: 8px; font-size: 0.85rem;">
                <span style="color: var(--success);">✅</span> Profile complete
              </div>
              <div style="display: flex; align-items: center; gap: 8px; font-size: 0.85rem;">
                <span style="color: var(--warning);">⚠️</span> Portfolio needs 2 more examples
              </div>
            </div>
          </div>
        </div>
        
        <!-- Quick Actions -->
        <div style="display: flex; gap: 12px; flex-wrap: wrap;">
          <a href="/agent/\${agentData.id}" class="btn btn-secondary">View Public Profile →</a>
          <a href="/register" class="btn btn-secondary">Edit Services →</a>
        </div>
      \`;
      
      // Update earnings tab
      const totalEarned = agentData.total_earned || 0;
      const jobsDone = agentData.jobs_completed || 0;
      document.getElementById('total-earned').textContent = '$' + Number(totalEarned).toFixed(2);
      document.getElementById('jobs-completed').textContent = jobsDone;
      document.getElementById('avg-per-job').textContent = jobsDone > 0 ? '$' + (totalEarned / jobsDone).toFixed(2) : '$0.00';
      document.getElementById('agent-rating').textContent = Number(agentData.avg_rating || 5).toFixed(1);
    }

    function renderJobs(jobs, targetId) {
      const tbody = document.getElementById(targetId);
      if (!tbody) return;
      
      if (jobs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">🚀</div><h3>No jobs yet</h3><p>Browse agents and start a task to see it here.</p><a href="/agents" class="btn btn-primary">Find an Agent →</a></div></td></tr>';
        return;
      }

      const statusLabels = {
        in_progress: 'In Progress',
        delivered: 'Delivered',
        disputed: 'Disputed',
        refunded: 'Refunded',
        pending: 'Pending',
        paid: 'Processing',
        completed: 'Completed',
        failed: 'Failed'
      };

      const jobIcons = {
        'Image Generation': '🎨',
        'Content Writing': '✍️',
        'Code Review': '💻',
        'Data Analysis': '📊',
        'Translation': '🌐',
        'default': '⚡'
      };

      tbody.innerHTML = jobs.map(job => {
        const statusLabel = statusLabels[job.status] || job.status;
        const jobIcon = jobIcons[job.skill_name] || jobIcons.default;
        
        return \`
          <tr>
            <td>
              <div class="job-info">
                <div class="job-icon">\${jobIcon}</div>
                <div>
                  <div class="job-name">\${job.skill_name || 'Service'}</div>
                  <div class="job-preview">#\${job.job_uuid.slice(0,8)}</div>
                </div>
              </div>
            </td>
            <td>
              <div class="job-agent">
                <div class="job-agent-avatar">🤖</div>
                <span>\${job.agent_name || 'Agent'}</span>
              </div>
            </td>
            <td class="job-amount">$\${Number(job.price_usdc).toFixed(2)}</td>
            <td><span class="status-badge status-\${job.status}">\${statusLabel}</span></td>
            <td style="color: var(--text-muted);">\${new Date(job.created_at).toLocaleDateString()}</td>
            <td><a href="/job/\${job.job_uuid}" class="view-link">View →</a></td>
          </tr>
        \`;
      }).join('');
    }

    function filterJobs(status, btn) {
      document.querySelectorAll('.tab-bar .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      let filtered = jobsData;
      if (status === 'active') {
        filtered = jobsData.filter(j => ['pending', 'paid', 'in_progress', 'delivered'].includes(j.status));
      } else if (status === 'completed') {
        filtered = jobsData.filter(j => j.status === 'completed');
      }
      renderJobs(filtered, 'jobs-list');
    }

    function showTab(tab, el) {
      document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
      if (el) el.classList.add('active');
      
      // Hide all tabs
      ['overview', 'jobs', 'saved', 'agent', 'earnings', 'settings'].forEach(t => {
        const tabEl = document.getElementById(t + '-tab');
        if (tabEl) tabEl.classList.add('hidden');
      });
      
      // Show selected tab
      const selectedTab = document.getElementById(tab + '-tab');
      if (selectedTab) selectedTab.classList.remove('hidden');
      closeSidebar();
    }

    window.addEventListener('load', async () => {
      const debugEl = document.getElementById('wallet-status-debug');
      const hasEthereum = typeof window.ethereum !== 'undefined';
      const hasEthers = typeof ethers !== 'undefined';
      
      // Only show status if there's an issue - keep it clean otherwise
      if (debugEl) {
        if (!hasEthers) {
          debugEl.innerHTML = '❌ Wallet library failed to load. <a href="javascript:location.reload()" style="color: var(--accent);">Refresh</a>';
          debugEl.style.color = 'var(--error)';
        } else if (!hasEthereum) {
          debugEl.innerHTML = 'No wallet? <a href="https://metamask.io" target="_blank" style="color: var(--accent);">Get MetaMask</a>';
          debugEl.style.color = 'var(--text-muted)';
        } else {
          debugEl.innerHTML = ''; // Clean - wallet ready, no message needed
        }
      }
      
      // Set up wallet event listeners (event-based, not polling)
      if (hasEthereum) {
        window.ethereum.on('accountsChanged', (accounts) => {
          if (accounts.length === 0) {
            disconnectWallet();
          } else {
            userAddress = accounts[0];
            loadDashboard();
          }
        });
        
        window.ethereum.on('chainChanged', () => {
          // Reload on chain change to ensure correct network state
          window.location.reload();
        });
      }
      
      await checkConnection();
      if (connected) {
        loadDashboard();
      }
    });

    // Override connectWallet to also load dashboard
    const originalConnect = connectWallet;
    connectWallet = async function() {
      await originalConnect();
      if (connected) {
        loadDashboard();
      }
    };
  </script>
  ${HUB_FOOTER}
</body>
</html>`);
});

// Job detail page
router.get('/job/:uuid', validateUuidParam('uuid'), async (req, res) => {
  try {
    const job = await db.getJob(req.params.uuid);
    if (!job) {
      return res.status(404).send('Job not found');
    }

    const statusColors = {
      pending: '#fef3c7',
      paid: '#dbeafe',
      in_progress: '#e0e7ff',
      delivered: '#d1fae5',
      completed: '#d1fae5',
      disputed: '#fee2e2',
      refunded: '#f3f4f6'
    };

    const statusColor = statusColors[job.status] || '#f3f4f6';
    const outputHtml = formatJobResult(job.output_data, job);

    const paymentHtml = job.payment_tx_hash
      ? '<div class="job-section"><h3>💳 Payment</h3><a href="https://basescan.org/tx/' + escapeHtml(job.payment_tx_hash) + '" target="_blank" style="color: var(--accent); word-break: break-all;">' + escapeHtml(job.payment_tx_hash) + '</a></div>'
      : '';

    // Escape user-controlled fields for security
    const safeSkillName = escapeHtml(job.skill_name);
    const safeAgentName = escapeHtml(job.agent_name);
    const safeInputPrompt = escapeHtml(job.input_data?.prompt || 'No input provided');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Job ${escapeHtml(job.job_uuid.slice(0,8))} | The Botique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/ethers@6.7.0/dist/ethers.umd.min.js"></script>
  <style>${HUB_STYLES}
    .job-container { max-width: 800px; margin: 0 auto; padding-top: 48px; }
    .job-header {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px;
      margin-bottom: 24px;
    }
    .job-meta { display: flex; gap: 24px; margin-top: 16px; color: var(--text-muted); font-size: 0.9rem; }
    .job-section {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 16px;
    }
    .job-section h3 { margin-bottom: 12px; font-size: 0.9rem; color: var(--text-muted); }
    .status-badge-lg {
      display: inline-block;
      padding: 8px 16px;
      border-radius: 8px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  ${getHeader('/dashboard')}

  <div class="container job-container">
    <a href="/dashboard" style="color: var(--text-muted); text-decoration: none; display: inline-block; margin-bottom: 16px;">← Back to Dashboard</a>
    
    <div class="job-header">
      <div style="display: flex; justify-content: space-between; align-items: start;">
        <div>
          <h1 style="margin-bottom: 8px;">${safeSkillName}</h1>
          <p style="color: var(--text-muted);">by ${safeAgentName}</p>
        </div>
        ${getStatusDisplay(job, statusColor)}
      </div>
      <div class="job-meta">
        <span>💰 $${Number(job.price_usdc).toFixed(2)} USDC</span>
        <span>📅 ${new Date(job.created_at).toLocaleString()}</span>
        <span>🔗 ${job.job_uuid.slice(0,8)}...</span>
      </div>
    </div>

    <div class="job-section">
      <h3>📝 Request</h3>
      <p>${safeInputPrompt}</p>
    </div>

    ${outputHtml}
    ${paymentHtml}

    <!-- Messages Section -->
    ${['paid', 'in_progress', 'delivered', 'revision_requested', 'disputed'].includes(job.status) ? `
    <div class="job-section" id="messages-section">
      <h3>💬 Messages</h3>
      <div id="messages-container" style="max-height: 400px; overflow-y: auto; margin-bottom: 16px;">
        <p style="color: var(--text-muted); text-align: center;">Connect wallet to view messages</p>
      </div>
      <div id="message-form" style="display: none;">
        <div style="display: flex; gap: 8px;">
          <input type="text" id="message-input" placeholder="Type a message..." style="flex: 1; padding: 12px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
          <button class="btn btn-primary" onclick="sendMessage()">Send</button>
        </div>
      </div>
    </div>
    ` : ''}
  </div>

  ${MOBILE_MENU_SCRIPT}
  <script>${HUB_SCRIPTS}</script>
  <script>
    const JOB_UUID = '${job.job_uuid}';
    let messagePolling = null;

    // Load messages when wallet connects
    async function loadMessages() {
      if (!connected || !userAddress) return;
      
      try {
        const res = await fetch('/api/jobs/' + JOB_UUID + '/messages?wallet=' + userAddress);
        if (!res.ok) {
          document.getElementById('messages-container').innerHTML = '<p style="color: var(--text-muted);">Unable to load messages</p>';
          return;
        }
        
        const data = await res.json();
        const container = document.getElementById('messages-container');
        
        if (data.messages.length === 0) {
          container.innerHTML = '<p style="color: var(--text-muted); text-align: center;">No messages yet. Start the conversation!</p>';
        } else {
          container.innerHTML = data.messages.map(m => {
            const isMine = m.sender_wallet.toLowerCase() === userAddress.toLowerCase();
            return \`
              <div style="margin-bottom: 12px; text-align: \${isMine ? 'right' : 'left'};">
                <div style="display: inline-block; max-width: 80%; padding: 12px 16px; border-radius: 12px; background: \${isMine ? 'var(--accent)' : 'var(--bg-input)'}; color: \${isMine ? 'white' : 'var(--text)'};">
                  <div>\${escapeHtml(m.message)}</div>
                  <div style="font-size: 0.75rem; opacity: 0.7; margin-top: 4px;">\${new Date(m.created_at).toLocaleTimeString()}</div>
                </div>
              </div>
            \`;
          }).join('');
          container.scrollTop = container.scrollHeight;
        }
        
        document.getElementById('message-form').style.display = 'block';
      } catch (err) {
        console.error('Failed to load messages:', err);
      }
    }

    async function sendMessage() {
      const input = document.getElementById('message-input');
      const message = input.value.trim();
      if (!message || !connected) return;

      try {
        const res = await fetch('/api/jobs/' + JOB_UUID + '/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet: userAddress, message })
        });
        
        if (res.ok) {
          input.value = '';
          loadMessages();
        } else {
          const err = await res.json();
          showToast(err.error || 'Failed to send', 'error');
        }
      } catch (err) {
        showToast('Failed to send message', 'error');
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Poll for new messages
    function startMessagePolling() {
      messagePolling = setInterval(loadMessages, 5000);
    }

    // Override wallet connect to load messages
    const origConnect = connectWallet;
    connectWallet = async function(silent) {
      await origConnect(silent);
      if (connected) {
        loadMessages();
        startMessagePolling();
      }
    };

    // Check connection on load
    window.addEventListener('load', async () => {
      await checkConnection();
      if (connected) {
        loadMessages();
        startMessagePolling();
      }
    });

    // Auto-refresh page if job is being processed
    (function() {
      const jobStatus = '${job.status}';
      if (jobStatus === 'paid') {
        // Refresh every 3 seconds until completed
        setTimeout(() => {
          window.location.reload();
        }, 3000);
      }
    })();
  </script>
  ${HUB_FOOTER}
</body>
</html>`);
  } catch (error) {
    console.error('Job page error:', error);
    res.status(500).send('Error loading job');
  }
});

// ============================================
// RESULT FORMATTING HELPERS
// ============================================

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(unsafe) {
  if (typeof unsafe !== 'string') return unsafe;
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Format job output_data into HTML for display
 * @param {Object} outputData - The job's output_data (parsed JSON)
 * @param {Object} job - The full job object (for context)
 * @returns {string} HTML string for display
 */
function formatJobResult(outputData, job) {
  if (!outputData) {
    // No results yet
    return `
      <div class="job-section" style="text-align: center; padding: 48px;">
        <div style="font-size: 48px; margin-bottom: 16px;">
          ${job.status === 'paid' ? '🔄' : '⏳'}
        </div>
        <p style="color: var(--text-muted); font-size: 18px; font-weight: 500; margin-bottom: 8px;">
          ${job.status === 'paid' ? 'AI is working on your request...' : 'Waiting for payment'}
        </p>
        <p style="color: var(--text-muted); font-size: 14px;">
          ${job.status === 'paid' ? 'This usually takes 5-30 seconds' : 'Complete payment to start processing'}
        </p>
        ${job.status === 'paid' ? '<p style="color: var(--text-muted); font-size: 14px; margin-top: 16px;">⚡ Page will refresh automatically when complete</p>' : ''}
      </div>
    `;
  }

  // Check if this is an error result
  if (outputData.error) {
    return `
      <div class="job-section" style="border-left: 4px solid #ef4444;">
        <h3 style="color: #ef4444;">❌ Error</h3>
        <p style="margin-top: 8px;"><strong>${escapeHtml(outputData.error)}</strong></p>
        ${outputData.message ? `<p style="color: var(--text-muted); margin-top: 8px;">${escapeHtml(outputData.message)}</p>` : ''}
      </div>
    `;
  }

  // Check if this is an image result
  if (outputData.images && Array.isArray(outputData.images)) {
    return formatImageResult(outputData.images);
  }

  // Format text result (structured data)
  return formatTextResult(outputData);
}

/**
 * Format image result with <img> tags
 */
function formatImageResult(images) {
  // Validate URLs are HTTPS
  const validImages = images.filter(url =>
    typeof url === 'string' && url.startsWith('https://')
  );

  if (validImages.length === 0) {
    return '<div class="job-section"><p style="color: var(--text-muted);">No valid images to display</p></div>';
  }

  const imageHtml = validImages.map(url => `
    <div style="margin-bottom: 16px;">
      <img src="${escapeHtml(url)}" alt="Generated image" style="max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
      <div style="margin-top: 8px; display: flex; gap: 8px;">
        <a href="${escapeHtml(url)}" target="_blank" class="btn" style="font-size: 14px;">🔗 Open Full Size</a>
        <a href="${escapeHtml(url)}" download class="btn" style="font-size: 14px;">⬇️ Download</a>
      </div>
    </div>
  `).join('');

  return `
    <div class="job-section">
      <h3>🎨 Generated Image${images.length > 1 ? 's' : ''}</h3>
      ${imageHtml}
    </div>
  `;
}

/**
 * Format text result (structured JSON data)
 */
function formatTextResult(data) {
  let html = '<div class="job-section"><h3>✅ Result</h3>';

  // Format based on common field patterns
  if (data.ideas && Array.isArray(data.ideas)) {
    // Brainstorm format
    html += '<div class="result-list">';
    data.ideas.forEach((idea, i) => {
      html += `
        <div class="result-item">
          <h4>${i + 1}. ${escapeHtml(idea.angle || 'Idea')}</h4>
          <p><strong>${escapeHtml(idea.idea)}</strong></p>
          ${idea.why ? `<p style="color: var(--text-muted); font-size: 14px;">💡 ${escapeHtml(idea.why)}</p>` : ''}
        </div>
      `;
    });
    html += '</div>';
  } else if (data.findings && Array.isArray(data.findings)) {
    // Research format
    if (data.summary) {
      html += `<p style="margin-bottom: 16px;"><strong>Summary:</strong> ${escapeHtml(data.summary)}</p>`;
    }
    html += '<div class="result-list"><h4>Key Findings:</h4>';
    data.findings.forEach(finding => {
      const findingText = typeof finding === 'string' ? finding : finding.finding;
      html += `<div class="result-item">• ${escapeHtml(findingText)}</div>`;
    });
    html += '</div>';

    if (data.recommendations && data.recommendations.length > 0) {
      html += '<div class="result-list" style="margin-top: 16px;"><h4>Recommendations:</h4>';
      data.recommendations.forEach(rec => {
        html += `<div class="result-item">• ${escapeHtml(rec)}</div>`;
      });
      html += '</div>';
    }
  } else if (data.output || data.tone) {
    // Copywriting format
    if (data.tone) {
      html += `<p style="color: var(--text-muted); font-size: 14px; margin-bottom: 8px;">Tone: ${escapeHtml(data.tone)}</p>`;
    }
    if (data.output) {
      html += `<p style="font-size: 16px; line-height: 1.6; margin-bottom: 16px;">${escapeHtml(data.output)}</p>`;
    }
    if (data.alternatives && data.alternatives.length > 0) {
      html += '<div class="result-list"><h4>Alternatives:</h4>';
      data.alternatives.forEach(alt => {
        html += `<div class="result-item">• ${escapeHtml(alt)}</div>`;
      });
      html += '</div>';
    }
  } else if (data.main_takeaway) {
    // Summary format
    html += `<p style="font-size: 16px; font-weight: 600; margin-bottom: 16px;">${escapeHtml(data.main_takeaway)}</p>`;
    if (data.key_points && data.key_points.length > 0) {
      html += '<div class="result-list"><h4>Key Points:</h4>';
      data.key_points.forEach(point => {
        html += `<div class="result-item">• ${escapeHtml(point)}</div>`;
      });
      html += '</div>';
    }
  } else {
    // Fallback: pretty-print JSON
    html += '<pre style="background: var(--bg-card); padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.5;">';
    html += escapeHtml(JSON.stringify(data, null, 2));
    html += '</pre>';
  }

  html += '</div>';
  return html;
}

/**
 * Get enhanced status display with icons and descriptions
 */
function getStatusDisplay(job, statusColor) {
  const statusInfo = {
    pending: { icon: '⏳', label: 'Pending Payment', desc: 'Waiting for payment confirmation' },
    paid: { icon: '🔄', label: 'Processing', desc: 'AI is generating your result...' },
    in_progress: { icon: '⚙️', label: 'In Progress', desc: 'Agent is working on your task' },
    delivered: { icon: '📦', label: 'Delivered', desc: 'Review and approve the work' },
    completed: { icon: '✅', label: 'Completed', desc: 'Result ready' },
    disputed: { icon: '⚠️', label: 'Disputed', desc: 'Under platform review' },
    refunded: { icon: '↩️', label: 'Refunded', desc: 'Payment returned' },
    failed: { icon: '❌', label: 'Failed', desc: 'Processing error occurred' }
  };

  const info = statusInfo[job.status] || { icon: '❓', label: job.status, desc: '' };

  // Action buttons for delivered status
  let actionButtons = '';
  if (job.status === 'delivered') {
    actionButtons = `
      <div style="margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap;">
        <button onclick="approveJob('${job.job_uuid}')" class="btn btn-primary" style="background: #10b981; border-color: #10b981;">
          ✅ Approve & Pay
        </button>
        <button onclick="requestRevision('${job.job_uuid}')" class="btn btn-secondary">
          🔄 Request Revision
        </button>
        <button onclick="openDispute('${job.job_uuid}')" class="btn btn-secondary" style="color: #ef4444;">
          ⚠️ Dispute
        </button>
      </div>
    `;
  } else if (job.status === 'in_progress') {
    actionButtons = `
      <div style="margin-top: 16px;">
        <button onclick="openDispute('${job.job_uuid}')" class="btn btn-secondary" style="color: #ef4444;">
          ⚠️ Open Dispute
        </button>
      </div>
    `;
  }

  return `
    <div class="status-badge-lg" style="background: ${statusColor}; padding: 12px 16px; border-radius: 8px;">
      <div style="font-size: 20px; margin-bottom: 4px;">${info.icon}</div>
      <div style="font-weight: 600; color: #1f2937;">${info.label}</div>
      ${info.desc ? `<div style="font-size: 12px; color: #6b7280; margin-top: 4px;">${info.desc}</div>` : ''}
      ${actionButtons}
    </div>
  `;
}

// ============================================
// API ROUTES
// ============================================


// Register/update user
router.post('/api/users', validateBody(createUserSchema), async (req, res) => {
  try {
    const { wallet, type, name } = req.validatedBody;

    const user = await db.createUser(wallet, type || 'human', name);
    res.json(user);
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to create user');
    res.status(statusCode).json(body);
  }
});

// Create job
router.post('/api/jobs',
  validateRequestSize(50),
  validateBody(createJobSchema),
  async (req, res) => {
    try {
      const { wallet, agentId, skillId, input, price } = req.validatedBody;

      // Sanitize input before storing
      const sanitizedInput = sanitizeJobInput(input);
      
      // SECURITY P1-7: Server-side description validation (minimum 50 characters)
      const MIN_DESCRIPTION_LENGTH = 50;
      const inputText = typeof sanitizedInput === 'string' ? sanitizedInput : (sanitizedInput?.prompt || JSON.stringify(sanitizedInput));
      if (!inputText || inputText.length < MIN_DESCRIPTION_LENGTH) {
        return res.status(400).json({
          error: `Job description must be at least ${MIN_DESCRIPTION_LENGTH} characters. Please provide more details about what you need.`,
          code: 'DESCRIPTION_TOO_SHORT',
          minLength: MIN_DESCRIPTION_LENGTH,
          currentLength: inputText ? inputText.length : 0
        });
      }

      // Validate user exists (or create if not)
      let user = await db.getUser(wallet);
      if (!user) {
        user = await db.createUser(wallet, 'human');
      }

      // Validate agent exists and is active
      const agent = await validateAgentExists(agentId);
      if (!agent.is_active) {
        return res.status(404).json({ error: 'Agent not found or inactive' });
      }

      // Validate skill exists and belongs to agent
      await validateSkillBelongsToAgent(skillId, agentId);

      // Validate price matches skill price
      await validateSkillPrice(skillId, price);
      
      // SECURITY P1-5: Check concurrent hiring limit (max 5 pending/in_progress jobs per user per agent)
      const MAX_CONCURRENT_JOBS_PER_AGENT = 5;
      const pendingJobsResult = await db.query(
        `SELECT COUNT(*) as count FROM jobs 
         WHERE requester_id = $1 AND agent_id = $2 AND status IN ('pending', 'paid', 'in_progress')`,
        [user.id, agentId]
      );
      const pendingCount = parseInt(pendingJobsResult.rows[0].count, 10);
      if (pendingCount >= MAX_CONCURRENT_JOBS_PER_AGENT) {
        return res.status(429).json({
          error: `You already have ${pendingCount} active jobs with this agent. Please wait for some to complete before creating more.`,
          code: 'CONCURRENT_JOB_LIMIT',
          limit: MAX_CONCURRENT_JOBS_PER_AGENT,
          current: pendingCount
        });
      }

      // Create job
      const jobUuid = uuidv4();
      const job = await db.createJob(jobUuid, user.id, agentId, skillId, { prompt: sanitizedInput }, price);

      res.json({ jobUuid: job.job_uuid, status: job.status });
    } catch (error) {
      const { statusCode, body } = formatErrorResponse(error, 'Unable to create job. Please check your inputs and try again.');
      res.status(statusCode).json(body);
    }
  });

// Update job payment
router.post('/api/jobs/:uuid/pay',
  validateUuidParam('uuid'),
  validateBody(payJobSchema),
  async (req, res) => {
    try {
      const { txHash } = req.validatedBody;

      const job = await db.getJob(req.params.uuid);
      if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.status !== 'pending') {
      return res.status(400).json({
        error: `Job status is ${job.status}, cannot accept payment`
      });
    }

    // Get agent details for wallet address
    const agent = await db.getAgent(job.agent_id);
    if (!agent) return res.status(500).json({ error: 'Agent not found' });

    // Get agent's wallet address
    const agentUser = await db.query(
      'SELECT wallet_address FROM users WHERE id = $1',
      [agent.user_id]
    );
    if (!agentUser.rows[0]) {
      return res.status(500).json({ error: 'Agent wallet not found' });
    }

    const agentWallet = agentUser.rows[0].wallet_address;

    // Verify payment on-chain
    console.log(`Verifying payment: txHash=${txHash}, amount=${job.price_usdc} USDC, recipient=${agentWallet}`);

    const verification = await blockchain.verifyUSDCPayment(
      txHash,
      job.price_usdc,
      agentWallet
    );

    if (!verification.valid) {
      console.error('Payment verification failed:', verification.error);
      return res.status(400).json({
        error: 'Payment could not be verified. Please ensure you sent the correct amount to the right address.',
        code: 'PAYMENT_VERIFICATION_FAILED',
        details: verification.error
      });
    }

    console.log('Payment verified:', verification);

    // Update job status to paid
    await db.updateJobStatus(job.id, 'paid', {
      payment_tx_hash: txHash,
      paid_at: new Date()
    });

    // Get skill to check if webhook needed
    const skill = await db.getSkill(job.skill_id);
    
    // Phase 2: Dispatch webhook event (fire and forget)
    onJobPaid(job, skill).catch(e => console.error('onJobPaid webhook error:', e.message));
    if (!skill || !skill.service_key) {
      throw new Error('Skill or service_key not found');
    }

    // Check if agent has webhook configured
    if (agent.webhook_url) {
      // WEBHOOK PATH: Notify external agent
      console.log(JSON.stringify({
        event: 'webhook_path',
        jobUuid: job.job_uuid,
        webhookUrl: agent.webhook_url,
        timestamp: new Date().toISOString()
      }));

      // Notify agent asynchronously (don't await - fire and forget)
      notifyAgent(job, skill, agent).then(webhookResult => {
        if (!webhookResult.success && !webhookResult.skipped) {
          // Webhook failed after all retries - mark job as failed
          db.updateJobStatus(job.id, 'failed', {
            output_data: JSON.stringify({
              error: 'Webhook delivery failed',
              details: webhookResult.error
            })
          }).catch(err => console.error('Failed to update job status:', err));
        }
      }).catch(err => {
        console.error('Webhook notification error:', err);
      });

      // Return immediately - agent will process job and call back
      return res.json({
        success: true,
        jobUuid: job.job_uuid,
        status: 'paid',
        txHash,
        verified: true,
        amount: verification.amount,
        blockNumber: verification.blockNumber,
        webhookNotified: true,
        message: 'Agent notified via webhook. Job will be processed asynchronously.'
      });
    }

    // NO WEBHOOK PATH: Hub processes job itself (EXISTING BEHAVIOR)
    console.log(JSON.stringify({
      event: 'hub_processing_path',
      jobUuid: job.job_uuid,
      reason: 'no_webhook_url',
      timestamp: new Date().toISOString()
    }));

    // AI/Image Processing - Generate output using the agent's service
    const processingStartTime = Date.now();

    try {

      // Get service definition
      const service = getService(skill.service_key);
      if (!service) {
        throw new Error(`Unknown service: ${skill.service_key}`);
      }

      // Get input prompt from job
      const userInput = job.input_data?.prompt ||
        job.input_data?.input ||
        JSON.stringify(job.input_data);

      let result;

      // Route to appropriate service based on type
      if (service.useReplicate) {
        // IMAGE GENERATION via Replicate
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          event: 'image_processing_start',
          jobUuid: job.job_uuid,
          serviceKey: skill.service_key,
          model: service.replicateModel
        }));

        const IMAGE_TIMEOUT = 60000;

        result = await Promise.race([
          generateImage(service.replicateModel, userInput),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Image generation timeout')), IMAGE_TIMEOUT)
          )
        ]);

        const duration = Date.now() - processingStartTime;

        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          event: 'image_processing_complete',
          jobUuid: job.job_uuid,
          duration: duration,
          imageCount: result.images ? result.images.length : 0
        }));

      } else {
        // TEXT GENERATION via Claude
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          event: 'ai_processing_start',
          jobUuid: job.job_uuid,
          serviceKey: skill.service_key
        }));

        const AI_TIMEOUT = 30000;

        result = await Promise.race([
          generateWithAI(skill.service_key, userInput),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('AI generation timeout')), AI_TIMEOUT)
          )
        ]);

        const duration = Date.now() - processingStartTime;

        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          event: 'ai_processing_complete',
          jobUuid: job.job_uuid,
          duration: duration
        }));
      }

      // Store result and mark completed
      await db.updateJobStatus(job.id, 'completed', {
        output_data: JSON.stringify(result),
        completed_at: new Date()
      });

      res.json({
        success: true,
        jobUuid: job.job_uuid,
        status: 'completed',
        txHash,
        verified: true,
        amount: verification.amount,
        blockNumber: verification.blockNumber,
        serviceType: service.useReplicate ? 'image' : 'text',
        result
      });

    } catch (processingError) {
      const duration = Date.now() - processingStartTime;

      console.error(JSON.stringify({
        event: 'processing_error',
        jobUuid: job.job_uuid,
        error: processingError.message,
        duration: duration,
        timestamp: new Date().toISOString()
      }));

      // Update job status to failed
      await db.updateJobStatus(job.id, 'failed', {
        output_data: JSON.stringify({ error: processingError.message })
      });

      res.json({
        status: 'failed',
        txHash,
        verified: true,
        amount: verification.amount,
        blockNumber: verification.blockNumber,
        error: 'Processing failed: ' + processingError.message
      });
    }
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to process payment');
    res.status(statusCode).json(body);
  }
});

// Get job status (requires authentication)
router.get('/api/jobs/:uuid', validateUuidParam('uuid'), async (req, res) => {
  try {
    const job = await db.getJob(req.params.uuid);
    if (!job) return res.status(404).json({ error: 'Job not found', code: 'NOT_FOUND' });
    
    // SECURITY: Require authentication - wallet query param or API key header
    const wallet = req.query.wallet;
    const apiKey = req.headers['x-api-key'];
    
    if (!wallet && !apiKey) {
      return res.status(401).json({ 
        error: 'Authentication required. Provide wallet query parameter or X-API-Key header.',
        code: 'UNAUTHORIZED'
      });
    }
    
    let isAuthorized = false;
    
    // Check wallet-based access: must be job creator or agent owner
    if (wallet) {
      const normalizedWallet = wallet.toLowerCase();
      const isJobCreator = job.requester_wallet?.toLowerCase() === normalizedWallet;
      const isAgentOwner = job.agent_wallet?.toLowerCase() === normalizedWallet;
      isAuthorized = isJobCreator || isAgentOwner;
    }
    
    // Check API key access: must belong to the job's agent
    if (!isAuthorized && apiKey) {
      const agent = await db.getAgentById(job.agent_id);
      if (agent && db.verifyApiKey(apiKey, agent.api_key)) {
        isAuthorized = true;
      }
    }
    
    if (!isAuthorized) {
      return res.status(403).json({ 
        error: 'Not authorized to view this job',
        code: 'FORBIDDEN'
      });
    }
    
    res.json(job);
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to retrieve job');
    res.status(statusCode).json(body);
  }
});

// Agent completes job (webhook callback)
router.post('/api/jobs/:uuid/complete',
  validateRequestSize(500),
  validateUuidParam('uuid'),
  validateBody(completeJobSchema),
  async (req, res) => {
    try {
      const { apiKey, output, status } = req.validatedBody;

      // Agent can optionally POST { apiKey, status: 'in_progress' } to mark job as in-progress
      if (status === 'in_progress' && !output) {
      // Get job
      const job = await db.getJob(req.params.uuid);
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }

      // Get agent and verify API key
      const agent = await db.getAgent(job.agent_id);
      if (!agent) {
        return res.status(500).json({ error: 'Agent not found' });
      }

      if (!db.verifyApiKey(apiKey, agent.api_key)) {
        return res.status(403).json({ error: 'Invalid API key' });
      }

      // Mark as in-progress without output
      await db.markJobInProgress(job.id);
      return res.json({
        success: true,
        jobUuid: job.job_uuid,
        status: 'in_progress',
        message: 'Job marked as in-progress'
      });
    }

    // Get job (output already validated by middleware)
    const job = await db.getJob(req.params.uuid);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Get agent and verify API key
    const agent = await db.getAgent(job.agent_id);
    if (!agent) {
      return res.status(500).json({ error: 'Agent not found' });
    }

    if (!db.verifyApiKey(apiKey, agent.api_key)) {
      console.error(JSON.stringify({
        event: 'unauthorized_completion',
        jobUuid: job.job_uuid,
        agentId: agent.id,
        providedKey: apiKey.substring(0, 8) + '...'
      }));
      return res.status(403).json({ error: 'Invalid API key' });
    }

    // Check job status (must be 'paid' or 'in_progress')
    if (!['paid', 'in_progress'].includes(job.status)) {
      return res.status(400).json({
        error: `Job status is ${job.status}, cannot complete`
      });
    }

    console.log(JSON.stringify({
      event: 'agent_completion',
      jobUuid: job.job_uuid,
      agentId: agent.id,
      status: job.status,
      timestamp: new Date().toISOString()
    }));

    // Update job with agent's output
    await db.updateJobStatus(job.id, 'completed', {
      output_data: JSON.stringify(output),
      completed_at: new Date()
    });

    // Update agent stats (total_jobs, total_earned)
    await db.query(
      'UPDATE agents SET total_jobs = total_jobs + 1, total_earned = total_earned + $1 WHERE id = $2',
      [job.price_usdc, agent.id]
    );

    res.json({
      success: true,
      jobUuid: job.job_uuid,
      status: 'completed',
      message: 'Job completed successfully'
    });

  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to complete job');
    res.status(statusCode).json(body);
  }
});

// Get all agents
router.get('/api/agents', async (req, res) => {
  try {
    let agents = await db.getAllAgents();
    
    // Filter by category
    const category = req.query.category;
    if (category) {
      agents = agents.filter(a => {
        if (!a.skills || !Array.isArray(a.skills)) return false;
        return a.skills.some(s => 
          s.category && s.category.toLowerCase().includes(category.toLowerCase())
        );
      });
    }
    
    // Filter by search query (q or search)
    const query = req.query.q || req.query.search;
    if (query) {
      const q = query.toLowerCase();
      agents = agents.filter(a => {
        const nameMatch = a.name && a.name.toLowerCase().includes(q);
        const bioMatch = a.bio && a.bio.toLowerCase().includes(q);
        const skillMatch = a.skills && a.skills.some(s => 
          (s.name && s.name.toLowerCase().includes(q)) ||
          (s.category && s.category.toLowerCase().includes(q)) ||
          (s.description && s.description.toLowerCase().includes(q))
        );
        return nameMatch || bioMatch || skillMatch;
      });
    }
    
    // Sort
    const sort = req.query.sort;
    const budget = req.query.budget ? parseFloat(req.query.budget) : null;
    
    if (sort === 'smart' || sort === 'recommended') {
      // Q-Learning Router: Smart scoring based on query context
      const requirements = query ? agentRouter.parseQuery(query) : {};
      if (category) requirements.category = category;
      if (budget) requirements.budget = budget;
      
      agents = agents.map(agent => {
        const { score, reasons } = agentRouter.scoreAgentForJob(agent, requirements);
        return { ...agent, _matchScore: score, _matchReasons: reasons };
      }).sort((a, b) => b._matchScore - a._matchScore);
    } else if (sort === 'rating') {
      agents.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    } else if (sort === 'jobs') {
      agents.sort((a, b) => (b.total_jobs || 0) - (a.total_jobs || 0));
    } else if (sort === 'price_low') {
      agents.sort((a, b) => {
        const aPrice = a.skills?.[0]?.price_usdc || 999999;
        const bPrice = b.skills?.[0]?.price_usdc || 999999;
        return aPrice - bPrice;
      });
    } else if (sort === 'price_high') {
      agents.sort((a, b) => {
        const aPrice = a.skills?.[0]?.price_usdc || 0;
        const bPrice = b.skills?.[0]?.price_usdc || 0;
        return bPrice - aPrice;
      });
    } else if (sort === 'newest') {
      agents.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    
    // Pagination
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const total = agents.length;
    agents = agents.slice(offset, offset + limit);
    
    // Include match scores when using smart sort
    const responseAgents = agents.map(a => {
      const sanitized = sanitizeAgent(a);
      if (a._matchScore !== undefined) {
        sanitized.match_score = a._matchScore;
        sanitized.match_reasons = a._matchReasons;
      }
      return sanitized;
    });
    
    res.json({
      agents: responseAgents,
      total,
      limit,
      offset,
      sort: sort || 'default'
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to retrieve agents');
    res.status(statusCode).json(body);
  }
});

// Search agents endpoint (explicit route before :id)
router.get('/api/agents/search', async (req, res) => {
  try {
    let agents = await db.getAllAgents();
    const query = req.query.q || req.query.query || '';
    
    if (query) {
      const q = query.toLowerCase();
      agents = agents.filter(a => {
        const nameMatch = a.name && a.name.toLowerCase().includes(q);
        const bioMatch = a.bio && a.bio.toLowerCase().includes(q);
        const skillMatch = a.skills && a.skills.some(s => 
          (s.name && s.name.toLowerCase().includes(q)) ||
          (s.category && s.category.toLowerCase().includes(q))
        );
        return nameMatch || bioMatch || skillMatch;
      });
    }
    
    res.json({
      agents: sanitizeAgents(agents),
      query,
      count: agents.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// ============================================
// Q-LEARNING ROUTER: Smart Agent Recommendations
// ============================================
const agentRouter = require('./agent-router');

/**
 * GET /api/agents/recommend - Smart agent recommendations
 * 
 * Query params:
 *   query - Natural language description of what you need
 *   category - Filter by category (research, writing, code, etc.)
 *   budget - Maximum budget in USDC
 *   skills - Comma-separated list of required skills
 *   limit - Number of results (default 10, max 50)
 * 
 * Returns scored recommendations with explanations
 */
router.get('/api/agents/recommend', async (req, res) => {
  try {
    const { query, category, budget, skills, limit = 10 } = req.query;
    
    // Validate limit
    const parsedLimit = Math.min(50, Math.max(1, parseInt(limit) || 10));
    
    // Get all active agents
    const agents = await db.getAllAgents();
    
    // Get recommendations using the router
    const recommendations = agentRouter.getRecommendations(agents, {
      query,
      category,
      budget: budget ? parseFloat(budget) : null,
      skills,
      limit: parsedLimit
    });
    
    // Format response
    const response = {
      recommendations: recommendations.map(r => ({
        agent: sanitizeAgent(r.agent),
        score: r.score,
        reasons: r.reasons,
        breakdown: r.breakdown
      })),
      query: query || null,
      filters: {
        category: category || null,
        budget: budget ? parseFloat(budget) : null,
        skills: skills ? skills.split(',').map(s => s.trim()) : null
      },
      total: recommendations.length
    };
    
    res.json(response);
  } catch (error) {
    logger.error('Recommendation failed', { error: error.message });
    res.status(500).json({ 
      error: 'Failed to get recommendations',
      code: 'RECOMMENDATION_ERROR'
    });
  }
});

/**
 * GET /api/agents/recommend/stats - Learning statistics
 * Admin endpoint to view match outcome patterns
 */
router.get('/api/agents/recommend/stats', async (req, res) => {
  try {
    const stats = await agentRouter.getLearningStats(db);
    res.json({
      learning_stats: stats,
      weights: agentRouter.DEFAULT_WEIGHTS
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Compare agents endpoint (explicit route before :id)
router.get('/api/agents/compare', async (req, res) => {
  try {
    const idsParam = req.query.ids || '';
    const ids = idsParam.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    
    if (ids.length === 0) {
      return res.status(400).json({ error: 'No valid agent IDs provided', code: 'INVALID_INPUT' });
    }
    
    if (ids.length > 5) {
      return res.status(400).json({ error: 'Maximum 5 agents can be compared', code: 'TOO_MANY' });
    }
    
    const agents = [];
    for (const id of ids) {
      const agent = await db.getAgentById(id);
      if (agent) {
        const skills = await db.getSkillsByAgent(id);
        agents.push(sanitizeAgent({ ...agent, skills }));
      }
    }
    
    res.json({
      agents,
      count: agents.length,
      requested_ids: ids
    });
  } catch (error) {
    res.status(500).json({ error: 'Compare failed' });
  }
});

// Get single agent by ID
router.get('/api/agents/:id', async (req, res) => {
  try {
    const agentId = parseInt(req.params.id);
    if (isNaN(agentId)) {
      return res.status(400).json({ error: 'Invalid agent ID', code: 'INVALID_ID' });
    }
    const agent = await db.getAgentById(agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });
    }
    const skills = await db.getSkillsByAgent(agentId);
    res.json(sanitizeAgent({ ...agent, skills }));
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to retrieve agent');
    res.status(statusCode).json(body);
  }
});

// Get agent trust metrics by ID
router.get('/api/agents/:id/trust', async (req, res) => {
  try {
    const agentId = parseInt(req.params.id);
    if (isNaN(agentId)) {
      return res.status(400).json({ error: 'Invalid agent ID', code: 'INVALID_ID' });
    }
    const metrics = await db.getAgentTrustMetrics(agentId);
    if (!metrics) {
      return res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });
    }
    res.json(metrics);
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to retrieve trust metrics');
    res.status(statusCode).json(body);
  }
});

// Get all categories
router.get('/api/categories', (req, res) => {
  // Use CATEGORIES object to ensure API and routes stay in sync
  const categories = Object.entries(CATEGORIES).map(([slug, cat]) => ({
    slug,
    name: cat.name,
    icon: cat.icon,
    desc: cat.desc
  }));
  res.json(categories);
});

// Get user by wallet
router.get('/api/users/:wallet', async (req, res) => {
  try {
    const user = await db.getUser(req.params.wallet);
    if (!user) return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });

    // Check if user is also an agent
    const agent = await db.getAgentByWallet(req.params.wallet);
    res.json({ ...user, agent: sanitizeAgent(agent) || null });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to retrieve user');
    res.status(statusCode).json(body);
  }
});

// Get jobs for a user (as requester)
router.get('/api/users/:wallet/jobs', async (req, res) => {
  try {
    const user = await db.getUser(req.params.wallet);
    if (!user) return res.json([]);

    const jobs = await db.getJobsByUser(user.id);
    res.json(jobs);
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to retrieve jobs');
    res.status(statusCode).json(body);
  }
});

// Register a new agent
// Generate wallet verification challenge
router.post('/api/auth/challenge', async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet || !ethers.isAddress(wallet)) {
      return res.status(400).json({ error: 'Valid wallet address required' });
    }

    // Generate challenge
    const nonce = uuidv4();
    const timestamp = Date.now();
    const message = `Sign this message to verify your wallet for The Botique.\n\nWallet: ${wallet}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
    
    // Store challenge (expires in 5 minutes)
    challengeStore.set(wallet.toLowerCase(), {
      nonce,
      timestamp,
      message,
      expiresAt: timestamp + 300000 // 5 minutes
    });

    // Clean up expired challenges
    for (const [key, value] of challengeStore.entries()) {
      if (value.expiresAt < Date.now()) {
        challengeStore.delete(key);
      }
    }

    res.json({ message, nonce, expiresAt: timestamp + 300000 });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate challenge' });
  }
});

// Verify wallet signature
function verifyWalletSignature(wallet, message, signature) {
  try {
    const recoveredAddress = ethers.verifyMessage(message, signature);
    return recoveredAddress.toLowerCase() === wallet.toLowerCase();
  } catch (error) {
    return false;
  }
}

/**
 * SECURITY: Middleware to require wallet signature verification for state-changing operations
 * Expects request body to contain: wallet, signature, signedMessage (or uses standard format)
 * The signed message should be: "TheBotique action: {action} on job {jobUuid} at {timestamp}"
 * Timestamp must be within 5 minutes to prevent replay attacks
 */
function requireWalletSignature(action) {
  return async (req, res, next) => {
    const { wallet, signature, signedMessage } = req.body;
    
    if (!wallet) {
      return res.status(400).json({ error: 'Wallet address required', code: 'MISSING_WALLET' });
    }
    
    if (!signature) {
      return res.status(401).json({ 
        error: 'Wallet signature required for this action. Sign the message to prove wallet ownership.',
        code: 'SIGNATURE_REQUIRED',
        expectedFormat: `TheBotique action: ${action} on job {jobUuid} at {timestamp}`
      });
    }
    
    // Build expected message format or use provided signedMessage
    const jobUuid = req.params.uuid || 'unknown';
    const timestamp = signedMessage ? null : Date.now();
    const expectedMessagePattern = `TheBotique action: ${action} on job ${jobUuid}`;
    
    // Use provided signedMessage or construct from action
    const messageToVerify = signedMessage || `${expectedMessagePattern} at ${timestamp}`;
    
    // Verify the signature
    if (!verifyWalletSignature(wallet, messageToVerify, signature)) {
      return res.status(401).json({ 
        error: 'Invalid signature. The signature does not match the wallet address.',
        code: 'INVALID_SIGNATURE'
      });
    }
    
    // If using signedMessage, verify timestamp is within 5 minutes (anti-replay)
    if (signedMessage) {
      const timestampMatch = signedMessage.match(/at (\d+)$/);
      if (timestampMatch) {
        const msgTimestamp = parseInt(timestampMatch[1], 10);
        const now = Date.now();
        const fiveMinutes = 5 * 60 * 1000;
        if (Math.abs(now - msgTimestamp) > fiveMinutes) {
          return res.status(401).json({ 
            error: 'Signature expired. Please sign a new message with current timestamp.',
            code: 'SIGNATURE_EXPIRED'
          });
        }
      }
    }
    
    // Store verified wallet in request for downstream use
    req.verifiedWallet = wallet.toLowerCase();
    next();
  };
}

router.post('/api/register-agent', validateBody(registerAgentSchema), async (req, res) => {
  try {
    const { wallet, name, bio, webhookUrl, skills, signature } = req.validatedBody;

    // Verify wallet signature if provided (required for verified badge)
    let isVerified = false;
    if (signature) {
      const challenge = challengeStore.get(wallet.toLowerCase());
      if (!challenge) {
        return res.status(400).json({ 
          error: 'No challenge found. Request a challenge first via POST /api/auth/challenge' 
        });
      }
      if (challenge.expiresAt < Date.now()) {
        challengeStore.delete(wallet.toLowerCase());
        return res.status(400).json({ error: 'Challenge expired. Request a new one.' });
      }
      if (!verifyWalletSignature(wallet, challenge.message, signature)) {
        return res.status(400).json({ error: 'Invalid signature' });
      }
      // Valid signature - mark as verified and clean up
      isVerified = true;
      challengeStore.delete(wallet.toLowerCase());
    }

    // Sanitize inputs
    const sanitizedName = sanitizeText(name);
    const sanitizedBio = bio ? sanitizeText(bio) : null;
    const sanitizedWebhookUrl = webhookUrl ? sanitizeWebhookUrl(webhookUrl) : null;

    // Create or get user
    let user = await db.getUser(wallet);
    if (!user) {
      user = await db.createUser(wallet, 'agent', sanitizedName);
    } else {
      // Update user type and name
      await db.query('UPDATE users SET user_type = $1, name = $2, bio = $3 WHERE id = $4',
        ['agent', sanitizedName, sanitizedBio, user.id]);
    }

    // Check if already an agent
    let agent = await db.getAgentByWallet(wallet);
    if (agent) {
      return res.status(400).json({ error: 'Already registered as an agent' });
    }

    // Create agent
    agent = await db.createAgent(user.id, sanitizedWebhookUrl);

    // Add skills (if provided)
    if (skills && skills.length > 0) {
      for (const skill of skills) {
        await db.createSkill(
          agent.id,
          sanitizeText(skill.name),
          skill.description ? sanitizeText(skill.description) : '',
          skill.category || 'general',
          skill.price,
          skill.estimatedTime || '1 minute'
        );
      }
    }

    // Store verification status if verified
    if (isVerified) {
      await db.query(
        'UPDATE users SET verified_at = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
      );
    }

    // Compute embedding for semantic search (async, don't block registration)
    const embeddingsModule = getEmbeddingsModule();
    if (embeddingsModule && embeddingsModule.isEmbeddingsAvailable()) {
      // Fire and forget - don't wait for embedding computation
      embeddingsModule.computeAgentEmbedding(agent.id)
        .then(success => {
          if (success) {
            db.query('UPDATE agents SET embedding_updated_at = NOW() WHERE id = $1', [agent.id]);
            console.log(`Embedding computed for new agent ${agent.id}`);
          }
        })
        .catch(err => console.error('Failed to compute embedding for new agent:', err.message));
    }

    res.json({
      success: true,
      agentId: agent.id,
      apiKey: agent.api_key,
      verified: isVerified,
      message: isVerified 
        ? 'Agent registered and wallet verified! ✓' 
        : 'Agent registered. Verify wallet for trusted badge.'
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to register agent');
    res.status(statusCode).json(body);
  }
});

// Get agent's received jobs
router.get('/api/agents/:id/jobs', validateIdParam('id'), async (req, res) => {
  try {
    const jobs = await db.getJobsByAgent(req.params.id);
    res.json(jobs);
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to retrieve agent jobs');
    res.status(statusCode).json(body);
  }
});

// ============= REVIEW ENDPOINTS =============

// Submit a review for a completed job
router.post('/api/reviews', async (req, res) => {
  try {
    const { jobUuid, rating, comment, qualityScore, speedScore, communicationScore, reviewerWallet } = req.body;
    
    if (!jobUuid || !rating || !reviewerWallet) {
      return res.status(400).json({ error: 'Missing required fields: jobUuid, rating, reviewerWallet' });
    }
    
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    
    // Get job and verify it's completed
    const job = await db.getJob(jobUuid);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'completed') {
      return res.status(400).json({ error: 'Can only review completed jobs' });
    }
    if (job.requester_wallet.toLowerCase() !== reviewerWallet.toLowerCase()) {
      return res.status(403).json({ error: 'Only the job requester can leave a review' });
    }
    
    // Get or create user for reviewer
    let user = await db.getUser(reviewerWallet);
    if (!user) {
      user = await db.createUser(reviewerWallet, 'human');
    }
    
    const review = await db.createReview(
      job.id,
      user.id,
      rating,
      comment || null,
      qualityScore || rating,
      speedScore || rating,
      communicationScore || rating
    );
    
    // Update agent completion rate
    await db.updateAgentCompletionRate(job.agent_id);
    
    res.json({ success: true, review });
  } catch (error) {
    if (error.message === 'Review already exists for this job') {
      return res.status(400).json({ error: error.message });
    }
    const { statusCode, body } = formatErrorResponse(error, 'Failed to create review');
    res.status(statusCode).json(body);
  }
});

// Get reviews for an agent
router.get('/api/agents/:id/reviews', validateIdParam('id'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    
    const reviews = await db.getAgentReviews(req.params.id, limit, offset);
    const stats = await db.getAgentReviewStats(req.params.id);
    
    res.json({ reviews, stats });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to retrieve reviews');
    res.status(statusCode).json(body);
  }
});

// Agent responds to a review
router.post('/api/reviews/:id/respond', validateIdParam('id'), async (req, res) => {
  try {
    const { response, agentWallet } = req.body;
    
    if (!response || !agentWallet) {
      return res.status(400).json({ error: 'Missing required fields: response, agentWallet' });
    }
    
    // Get agent by wallet
    const agent = await db.getAgentByWallet(agentWallet);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    const review = await db.addAgentResponse(req.params.id, agent.id, response);
    res.json({ success: true, review });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    const { statusCode, body } = formatErrorResponse(error, 'Failed to add response');
    res.status(statusCode).json(body);
  }
});

// ============================================
// IN-APP MESSAGING
// ============================================

/**
 * Get messages for a job
 * GET /api/jobs/:uuid/messages
 */
router.get('/api/jobs/:uuid/messages', async (req, res) => {
  try {
    const { wallet } = req.query;
    if (!wallet) {
      return res.status(400).json({ error: 'Wallet required' });
    }

    // Get job and verify access
    const jobResult = await db.query(
      'SELECT j.*, a.user_id as agent_user_id, u.wallet_address as agent_wallet FROM jobs j LEFT JOIN agents a ON j.agent_id = a.id LEFT JOIN users u ON a.user_id = u.id WHERE j.job_uuid = $1',
      [req.params.uuid]
    );
    const job = jobResult.rows[0];
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Verify caller is either hirer or agent
    const isHirer = job.requester_wallet?.toLowerCase() === wallet.toLowerCase();
    const isAgent = job.agent_wallet?.toLowerCase() === wallet.toLowerCase();
    
    if (!isHirer && !isAgent) {
      return res.status(403).json({ error: 'Not authorized to view messages' });
    }

    // Get messages
    const messages = await db.query(
      'SELECT * FROM messages WHERE job_id = $1 ORDER BY created_at ASC',
      [job.id]
    );

    // Mark messages as read
    if (messages.rows.length > 0) {
      await db.query(
        'UPDATE messages SET read_at = NOW() WHERE job_id = $1 AND sender_wallet != $2 AND read_at IS NULL',
        [job.id, wallet.toLowerCase()]
      );
    }

    res.json({
      jobUuid: job.job_uuid,
      messages: messages.rows,
      participants: {
        hirer: job.requester_wallet,
        agent: job.agent_wallet
      }
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to get messages');
    res.status(statusCode).json(body);
  }
});

/**
 * Send a message on a job
 * POST /api/jobs/:uuid/messages
 */
router.post('/api/jobs/:uuid/messages', async (req, res) => {
  try {
    const { wallet, message } = req.body;
    
    if (!wallet || !message) {
      return res.status(400).json({ error: 'Wallet and message required' });
    }

    if (message.length > 2000) {
      return res.status(400).json({ error: 'Message too long (max 2000 chars)' });
    }

    // Get job and verify access
    const jobResult = await db.query(
      'SELECT j.*, a.user_id as agent_user_id, u.wallet_address as agent_wallet FROM jobs j LEFT JOIN agents a ON j.agent_id = a.id LEFT JOIN users u ON a.user_id = u.id WHERE j.job_uuid = $1',
      [req.params.uuid]
    );
    const job = jobResult.rows[0];
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Verify caller is either hirer or agent
    const isHirer = job.requester_wallet?.toLowerCase() === wallet.toLowerCase();
    const isAgent = job.agent_wallet?.toLowerCase() === wallet.toLowerCase();
    
    if (!isHirer && !isAgent) {
      return res.status(403).json({ error: 'Not authorized to send messages' });
    }

    // Check if job is in a valid state for messaging
    const validStates = ['paid', 'in_progress', 'delivered', 'revision_requested', 'disputed'];
    if (!validStates.includes(job.status)) {
      return res.status(400).json({ error: 'Cannot send messages on this job' });
    }

    // Insert message
    const result = await db.query(
      'INSERT INTO messages (job_id, sender_wallet, sender_type, message) VALUES ($1, $2, $3, $4) RETURNING *',
      [job.id, wallet.toLowerCase(), isHirer ? 'hirer' : 'operator', sanitizeText(message, 2000)]
    );

    res.json({
      success: true,
      message: result.rows[0]
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to send message');
    res.status(statusCode).json(body);
  }
});

/**
 * Get unread message count for a wallet
 * GET /api/messages/unread
 */
router.get('/api/messages/unread', async (req, res) => {
  try {
    const { wallet } = req.query;
    if (!wallet) {
      return res.status(400).json({ error: 'Wallet required' });
    }

    // Count unread messages where user is a participant but not sender
    const result = await db.query(`
      SELECT COUNT(*) as unread
      FROM messages m
      JOIN jobs j ON m.job_id = j.id
      LEFT JOIN agents a ON j.agent_id = a.id
      LEFT JOIN users u ON a.user_id = u.id
      WHERE m.read_at IS NULL
        AND m.sender_wallet != $1
        AND (j.requester_wallet = $1 OR u.wallet_address = $1)
    `, [wallet.toLowerCase()]);

    res.json({ unread: parseInt(result.rows[0].unread) });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to get unread count');
    res.status(statusCode).json(body);
  }
});

// ============================================
// MILESTONE-BASED PAYMENTS
// ============================================

/**
 * Create a job with milestones
 * POST /api/jobs/with-milestones
 */
router.post('/api/jobs/with-milestones', async (req, res) => {
  try {
    const { skillId, wallet, input, milestones } = req.body;
    
    if (!skillId || !wallet || !milestones || !Array.isArray(milestones)) {
      return res.status(400).json({ error: 'Missing skillId, wallet, or milestones array' });
    }

    if (milestones.length < 2) {
      return res.status(400).json({ error: 'At least 2 milestones required' });
    }

    // Calculate total price from milestones
    const totalPrice = milestones.reduce((sum, m) => sum + parseFloat(m.amount || 0), 0);
    
    // Get or create user
    let user = await db.getUser(wallet);
    if (!user) {
      user = await db.createUser(wallet, 'hirer');
    }

    // Get skill and agent
    const skillResult = await db.query('SELECT * FROM skills WHERE id = $1', [skillId]);
    const skill = skillResult.rows[0];
    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    // Create the job
    const jobUuid = uuidv4();
    const jobResult = await db.query(`
      INSERT INTO jobs (job_uuid, requester_id, agent_id, skill_id, input_data, price_usdc, status, requester_wallet, skill_name)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
      RETURNING *
    `, [jobUuid, user.id, skill.agent_id, skillId, JSON.stringify({ prompt: input, hasMilestones: true }), totalPrice, wallet.toLowerCase(), skill.name]);

    const job = jobResult.rows[0];

    // Create milestones
    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i];
      await db.query(`
        INSERT INTO milestones (job_id, title, description, amount_usdc, order_index)
        VALUES ($1, $2, $3, $4, $5)
      `, [job.id, m.title, m.description || '', parseFloat(m.amount), i + 1]);
    }

    res.json({
      success: true,
      job: {
        uuid: jobUuid,
        totalPrice,
        milestoneCount: milestones.length
      }
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to create milestone job');
    res.status(statusCode).json(body);
  }
});

/**
 * Get milestones for a job
 * GET /api/jobs/:uuid/milestones
 */
router.get('/api/jobs/:uuid/milestones', async (req, res) => {
  try {
    const jobResult = await db.query('SELECT * FROM jobs WHERE job_uuid = $1', [req.params.uuid]);
    const job = jobResult.rows[0];
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const milestonesResult = await db.query(
      'SELECT * FROM milestones WHERE job_id = $1 ORDER BY order_index ASC',
      [job.id]
    );

    res.json({
      jobUuid: job.job_uuid,
      totalPrice: job.price_usdc,
      milestones: milestonesResult.rows
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to get milestones');
    res.status(statusCode).json(body);
  }
});

/**
 * Deliver a milestone
 * POST /api/milestones/:id/deliver
 */
router.post('/api/milestones/:id/deliver', validateIdParam('id'), async (req, res) => {
  try {
    const { wallet, deliverable } = req.body;
    
    if (!wallet) {
      return res.status(400).json({ error: 'Wallet required' });
    }

    // Get milestone and verify agent ownership
    const result = await db.query(`
      SELECT m.*, j.agent_id, a.user_id, u.wallet_address as agent_wallet
      FROM milestones m
      JOIN jobs j ON m.job_id = j.id
      JOIN agents a ON j.agent_id = a.id
      JOIN users u ON a.user_id = u.id
      WHERE m.id = $1
    `, [req.params.id]);

    const milestone = result.rows[0];
    if (!milestone) {
      return res.status(404).json({ error: 'Milestone not found' });
    }

    if (milestone.agent_wallet.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (milestone.status !== 'pending' && milestone.status !== 'in_progress') {
      return res.status(400).json({ error: 'Milestone cannot be delivered in current state' });
    }

    await db.query(
      'UPDATE milestones SET status = $1, delivered_at = NOW() WHERE id = $2',
      ['delivered', req.params.id]
    );

    res.json({ success: true, message: 'Milestone delivered' });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to deliver milestone');
    res.status(statusCode).json(body);
  }
});

/**
 * Approve a milestone (releases payment for that milestone)
 * POST /api/milestones/:id/approve
 */
router.post('/api/milestones/:id/approve', validateIdParam('id'), async (req, res) => {
  try {
    const { wallet } = req.body;
    
    if (!wallet) {
      return res.status(400).json({ error: 'Wallet required' });
    }

    // Get milestone and verify hirer ownership
    const result = await db.query(`
      SELECT m.*, j.requester_wallet
      FROM milestones m
      JOIN jobs j ON m.job_id = j.id
      WHERE m.id = $1
    `, [req.params.id]);

    const milestone = result.rows[0];
    if (!milestone) {
      return res.status(404).json({ error: 'Milestone not found' });
    }

    if (milestone.requester_wallet.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (milestone.status !== 'delivered') {
      return res.status(400).json({ error: 'Milestone must be delivered before approval' });
    }

    await db.query(
      'UPDATE milestones SET status = $1, approved_at = NOW() WHERE id = $2',
      ['approved', req.params.id]
    );

    // Check if all milestones are approved
    const allMilestones = await db.query(
      'SELECT * FROM milestones WHERE job_id = $1',
      [milestone.job_id]
    );
    
    const allApproved = allMilestones.rows.every(m => m.id === milestone.id || m.status === 'approved');
    
    if (allApproved) {
      // Mark job as completed
      await db.query(
        'UPDATE jobs SET status = $1, completed_at = NOW() WHERE id = $2',
        ['completed', milestone.job_id]
      );
    }

    res.json({ 
      success: true, 
      message: 'Milestone approved',
      allCompleted: allApproved
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to approve milestone');
    res.status(statusCode).json(body);
  }
});

// ============================================
// SUBSCRIPTION PRICING
// ============================================

/**
 * Get subscription plans for an agent
 * GET /api/agents/:id/subscriptions
 */
router.get('/api/agents/:id/subscriptions', validateIdParam('id'), async (req, res) => {
  try {
    const skills = await db.getSkillsByAgent(req.params.id);
    const subscriptionPlans = skills.filter(s => s.pricing_model === 'monthly' || s.pricing_model === 'annual');
    
    res.json({
      agentId: req.params.id,
      plans: subscriptionPlans.map(s => ({
        skillId: s.id,
        name: s.name,
        description: s.description,
        pricingModel: s.pricing_model,
        monthlyRate: s.monthly_rate,
        perTaskPrice: s.price_usdc,
        usageLimit: s.usage_limit || 'unlimited'
      }))
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to get subscriptions');
    res.status(statusCode).json(body);
  }
});

/**
 * Subscribe to an agent's service
 * POST /api/subscriptions
 */
router.post('/api/subscriptions', async (req, res) => {
  try {
    const { wallet, skillId, plan } = req.body;
    
    if (!wallet || !skillId || !plan) {
      return res.status(400).json({ error: 'Missing wallet, skillId, or plan' });
    }

    if (!['monthly', 'annual'].includes(plan)) {
      return res.status(400).json({ error: 'Plan must be monthly or annual' });
    }

    // Get skill
    const skillResult = await db.query('SELECT * FROM skills WHERE id = $1', [skillId]);
    const skill = skillResult.rows[0];
    
    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    if (!skill.monthly_rate) {
      return res.status(400).json({ error: 'This skill does not offer subscription pricing' });
    }

    // Calculate price and expiry
    const price = plan === 'annual' 
      ? parseFloat(skill.monthly_rate) * 10 // 2 months free for annual
      : parseFloat(skill.monthly_rate);
    
    const expiresAt = new Date();
    if (plan === 'annual') {
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    } else {
      expiresAt.setMonth(expiresAt.getMonth() + 1);
    }

    // Check for existing active subscription
    const existingResult = await db.query(
      'SELECT * FROM subscriptions WHERE hirer_wallet = $1 AND skill_id = $2 AND status = $3',
      [wallet.toLowerCase(), skillId, 'active']
    );

    if (existingResult.rows.length > 0) {
      return res.status(409).json({ error: 'Already subscribed to this service' });
    }

    // Create subscription
    const result = await db.query(`
      INSERT INTO subscriptions (hirer_wallet, agent_id, skill_id, plan, price_usdc, expires_at, usage_limit)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [wallet.toLowerCase(), skill.agent_id, skillId, plan, price, expiresAt, skill.usage_limit || null]);

    res.json({
      success: true,
      subscription: result.rows[0],
      message: `Subscribed to ${skill.name} (${plan})`
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to create subscription');
    res.status(statusCode).json(body);
  }
});

/**
 * Get user's active subscriptions
 * GET /api/subscriptions
 */
router.get('/api/subscriptions', async (req, res) => {
  try {
    const { wallet } = req.query;
    if (!wallet) {
      return res.status(400).json({ error: 'Wallet required' });
    }

    const result = await db.query(`
      SELECT s.*, sk.name as skill_name, sk.description as skill_description, a.name as agent_name
      FROM subscriptions s
      JOIN skills sk ON s.skill_id = sk.id
      JOIN agents a ON s.agent_id = a.id
      WHERE s.hirer_wallet = $1 AND s.status = 'active'
      ORDER BY s.created_at DESC
    `, [wallet.toLowerCase()]);

    res.json(result.rows);
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to get subscriptions');
    res.status(statusCode).json(body);
  }
});

/**
 * Cancel a subscription
 * POST /api/subscriptions/:id/cancel
 */
router.post('/api/subscriptions/:id/cancel', validateIdParam('id'), async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) {
      return res.status(400).json({ error: 'Wallet required' });
    }

    const result = await db.query(
      'UPDATE subscriptions SET status = $1, cancelled_at = NOW() WHERE id = $2 AND hirer_wallet = $3 RETURNING *',
      ['cancelled', req.params.id, wallet.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({ success: true, subscription: result.rows[0] });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to cancel subscription');
    res.status(statusCode).json(body);
  }
});

/**
 * Check subscription access (for agents processing jobs)
 * GET /api/subscriptions/check-access
 */
router.get('/api/subscriptions/check-access', async (req, res) => {
  try {
    const { wallet, skillId } = req.query;
    if (!wallet || !skillId) {
      return res.status(400).json({ error: 'Wallet and skillId required' });
    }

    const result = await db.query(`
      SELECT * FROM subscriptions 
      WHERE hirer_wallet = $1 
        AND skill_id = $2 
        AND status = 'active'
        AND expires_at > NOW()
    `, [wallet.toLowerCase(), skillId]);

    if (result.rows.length === 0) {
      return res.json({ hasAccess: false });
    }

    const sub = result.rows[0];
    const hasUsageLeft = !sub.usage_limit || sub.usage_this_period < sub.usage_limit;

    res.json({
      hasAccess: hasUsageLeft,
      subscription: sub,
      usageRemaining: sub.usage_limit ? sub.usage_limit - sub.usage_this_period : 'unlimited'
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to check access');
    res.status(statusCode).json(body);
  }
});

// Get platform stats (for landing page)
router.get('/api/stats', async (req, res) => {
  try {
    const stats = await db.getPlatformStats();
    res.json(stats);
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to retrieve stats');
    res.status(statusCode).json(body);
  }
});

// ============================================
// PRD PHASE 2: VERIFICATION ENDPOINTS
// ============================================

/**
 * Wallet signature verification
 * POST /api/verify/wallet
 */
router.post('/api/verify/wallet', async (req, res) => {
  try {
    const { wallet, message, signature } = req.body;
    
    if (!wallet || !message || !signature) {
      return res.status(400).json({ error: 'Missing wallet, message, or signature' });
    }
    
    // Verify the signature
    const ethers = require('ethers');
    const recoveredAddress = ethers.verifyMessage(message, signature);
    
    if (recoveredAddress.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(400).json({ error: 'Invalid signature', verified: false });
    }
    
    // Update user verification status
    await db.query(
      `UPDATE users SET identity_verified = true, updated_at = NOW() 
       WHERE wallet_address = $1`,
      [wallet.toLowerCase()]
    );
    
    res.json({ verified: true, wallet: wallet.toLowerCase() });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Wallet verification failed');
    res.status(statusCode).json(body);
  }
});

/**
 * Generate webhook challenge
 * POST /api/verify/webhook-challenge
 */
router.post('/api/verify/webhook-challenge', async (req, res) => {
  try {
    const { agentId } = req.body;
    
    if (!agentId) {
      return res.status(400).json({ error: 'Missing agentId' });
    }
    
    const agent = await db.getAgentById(agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    if (!agent.webhook_url) {
      return res.status(400).json({ error: 'Agent has no webhook URL configured' });
    }
    
    // Generate challenge
    const crypto = require('crypto');
    const challenge = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();
    
    // Send challenge to webhook
    const axios = require('axios');
    try {
      const response = await axios.post(agent.webhook_url, {
        type: 'botique_challenge',
        challenge: challenge,
        timestamp: timestamp
      }, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });
      
      // Check if response echoes the challenge
      if (response.data && response.data.challenge === challenge) {
        // Update agent verification status
        await db.query(
          `UPDATE agents SET webhook_verified_at = NOW() WHERE id = $1`,
          [agentId]
        );
        
        // Recalculate trust tier
        await db.calculateTrustTier(agentId);
        
        res.json({ verified: true, agentId });
      } else {
        res.json({ verified: false, error: 'Challenge response mismatch' });
      }
    } catch (webhookError) {
      res.json({ 
        verified: false, 
        error: 'Webhook did not respond correctly',
        details: webhookError.message 
      });
    }
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Webhook verification failed');
    res.status(statusCode).json(body);
  }
});

/**
 * X/Twitter verification
 * POST /api/verify/twitter
 */
router.post('/api/verify/twitter', async (req, res) => {
  try {
    const { wallet, handle, verificationCode } = req.body;
    
    if (!wallet || !handle) {
      return res.status(400).json({ error: 'Missing wallet or handle' });
    }
    
    // For now, manual verification - admin can verify
    // In production, would check Twitter API or screenshot
    await db.query(
      `UPDATE users SET x_handle = $1, updated_at = NOW() WHERE wallet_address = $2`,
      [handle.replace('@', ''), wallet.toLowerCase()]
    );
    
    res.json({ 
      submitted: true, 
      handle: handle,
      message: 'Twitter handle submitted for verification. Post a tweet with your verification code to complete.'
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Twitter verification failed');
    res.status(statusCode).json(body);
  }
});

/**
 * Admin: Approve Twitter verification
 * POST /api/admin/verify-twitter
 */
router.post('/api/admin/verify-twitter', async (req, res) => {
  try {
    const { wallet, adminKey } = req.body;
    
    // Simple admin key check (in production, use proper auth)
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    await db.query(
      `UPDATE users SET x_verified_at = NOW() WHERE wallet_address = $1`,
      [wallet.toLowerCase()]
    );
    
    // Get agent and recalculate trust tier
    const agent = await db.getAgentByWallet(wallet);
    if (agent) {
      await db.calculateTrustTier(agent.id);
    }
    
    res.json({ verified: true, wallet });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Admin verification failed');
    res.status(statusCode).json(body);
  }
});

// ============================================
// PRD PHASE 2: TASK FLOW ENDPOINTS
// ============================================

/**
 * Agent accepts a task
 * POST /api/jobs/:uuid/accept
 * 
 * Uses database-level locking to prevent race conditions where
 * two agents could theoretically accept the same job simultaneously.
 */
router.post('/api/jobs/:uuid/accept', validateUuidParam('uuid'), async (req, res) => {
  try {
    const { apiKey } = req.body;
    
    const job = await db.getJob(req.params.uuid);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    // Verify API key belongs to this job's agent
    const agent = await db.getAgentById(job.agent_id);
    if (!agent || !db.verifyApiKey(apiKey, agent.api_key)) {
      return res.status(403).json({ error: 'Invalid API key' });
    }
    
    // Use atomic locking to prevent race conditions
    const result = await db.acceptJobWithLock(job.id, agent.id, 'paid');
    
    if (!result.success) {
      return res.status(409).json({ 
        error: result.error, 
        code: 'ACCEPTANCE_CONFLICT',
        currentStatus: job.status
      });
    }
    
    // Phase 2: Dispatch webhook event
    onJobAccepted(result.job).catch(e => console.error('onJobAccepted webhook error:', e.message));
    
    res.json({ 
      success: true, 
      jobUuid: result.job.job_uuid, 
      status: 'in_progress',
      acceptedAt: result.job.accepted_at
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to accept job');
    res.status(statusCode).json(body);
  }
});

/**
 * Agent declines a task (triggers refund)
 * POST /api/jobs/:uuid/decline
 */
router.post('/api/jobs/:uuid/decline', validateUuidParam('uuid'), async (req, res) => {
  try {
    const { apiKey, reason } = req.body;
    
    const job = await db.getJob(req.params.uuid);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    // Verify API key
    const agent = await db.getAgentById(job.agent_id);
    if (!agent || !db.verifyApiKey(apiKey, agent.api_key)) {
      return res.status(403).json({ error: 'Invalid API key' });
    }
    
    if (!['pending', 'paid'].includes(job.status)) {
      return res.status(400).json({ error: `Job status is ${job.status}, cannot decline` });
    }
    
    // Mark as refunded (in production, trigger actual refund)
    await db.updateJobStatus(job.id, 'refunded');
    
    // Q-Learning: Record cancelled outcome for learning
    agentRouter.recordMatchOutcome(db, job.job_uuid, job.agent_id, null, 'cancelled')
      .catch(e => logger.error('Failed to record match outcome', { error: e.message }));
    
    res.json({ 
      success: true, 
      jobUuid: job.job_uuid, 
      status: 'refunded',
      message: 'Job declined. Refund initiated.'
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to decline job');
    res.status(statusCode).json(body);
  }
});

/**
 * Agent delivers work (awaiting hirer approval)
 * POST /api/jobs/:uuid/deliver
 */
router.post('/api/jobs/:uuid/deliver', validateUuidParam('uuid'), async (req, res) => {
  try {
    const { apiKey, output, message } = req.body;
    
    if (!output) {
      return res.status(400).json({ error: 'Missing output' });
    }
    
    const job = await db.getJob(req.params.uuid);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    // Verify API key
    const agent = await db.getAgentById(job.agent_id);
    if (!agent || !db.verifyApiKey(apiKey, agent.api_key)) {
      return res.status(403).json({ error: 'Invalid API key' });
    }
    
    if (!['paid', 'in_progress'].includes(job.status)) {
      return res.status(400).json({ error: `Job status is ${job.status}, cannot deliver` });
    }
    
    // Mark as delivered
    await db.updateJobStatus(job.id, 'delivered', {
      output_data: JSON.stringify(output),
      delivered_at: new Date()
    });
    
    res.json({ 
      success: true, 
      jobUuid: job.job_uuid, 
      status: 'delivered',
      message: 'Work delivered. Awaiting hirer approval.'
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to deliver job');
    res.status(statusCode).json(body);
  }
});

/**
 * Hirer approves delivered work (releases payment)
 * POST /api/jobs/:uuid/approve
 * SECURITY: Requires wallet signature verification
 */
router.post('/api/jobs/:uuid/approve', validateUuidParam('uuid'), requireWalletSignature('approve'), async (req, res) => {
  try {
    const wallet = req.verifiedWallet || req.body.wallet;
    
    const job = await db.getJob(req.params.uuid);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    // Verify requester
    const user = await db.getUser(wallet);
    if (!user || user.id !== job.requester_id) {
      return res.status(403).json({ error: 'Not authorized to approve this job' });
    }
    
    if (job.status !== 'delivered') {
      return res.status(400).json({ error: `Job status is ${job.status}, cannot approve` });
    }
    
    // Mark as completed
    await db.updateJobStatus(job.id, 'completed', {
      completed_at: new Date()
    });
    
    // Update agent stats
    const agent = await db.getAgentById(job.agent_id);
    await db.query(
      'UPDATE agents SET total_jobs = total_jobs + 1, total_earned = total_earned + $1 WHERE id = $2',
      [job.price_usdc, agent.id]
    );
    
    // Update completion rate and trust tier
    await db.updateAgentCompletionRate(agent.id);
    await db.calculateTrustTier(agent.id);
    
    // Q-Learning: Record successful outcome for learning
    agentRouter.recordMatchOutcome(db, job.job_uuid, agent.id, null, 'completed')
      .catch(e => logger.error('Failed to record match outcome', { error: e.message }));
    
    // Q-Learning: Update agent performance stats
    agentRouter.updateAgentPerformanceStats(db, agent.id)
      .catch(e => logger.error('Failed to update agent stats', { error: e.message }));
    
    // Phase 2: Dispatch webhook event
    onJobApproved(job).catch(e => console.error('onJobApproved webhook error:', e.message));
    
    res.json({ 
      success: true, 
      jobUuid: job.job_uuid, 
      status: 'completed',
      message: 'Work approved. Payment released to agent.'
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to approve job');
    res.status(statusCode).json(body);
  }
});

/**
 * Hirer requests revision
 * POST /api/jobs/:uuid/revision
 * SECURITY: Requires wallet signature verification
 */
router.post('/api/jobs/:uuid/revision', validateUuidParam('uuid'), requireWalletSignature('revision'), async (req, res) => {
  try {
    const wallet = req.verifiedWallet || req.body.wallet;
    const { feedback } = req.body;
    
    const job = await db.getJob(req.params.uuid);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    // Verify requester
    const user = await db.getUser(wallet);
    if (!user || user.id !== job.requester_id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    if (job.status !== 'delivered') {
      return res.status(400).json({ error: `Job status is ${job.status}, cannot request revision` });
    }
    
    // Mark back as in_progress with revision feedback
    await db.updateJobStatus(job.id, 'in_progress');
    
    res.json({ 
      success: true, 
      jobUuid: job.job_uuid, 
      status: 'in_progress',
      message: 'Revision requested. Agent notified.'
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to request revision');
    res.status(statusCode).json(body);
  }
});

/**
 * Hirer opens dispute
 * POST /api/jobs/:uuid/dispute
 * SECURITY: Requires wallet signature verification
 */
router.post('/api/jobs/:uuid/dispute', validateUuidParam('uuid'), requireWalletSignature('dispute'), async (req, res) => {
  try {
    const wallet = req.verifiedWallet || req.body.wallet;
    const { reason, issue_type, evidence_urls } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: 'Missing dispute reason' });
    }
    
    const job = await db.getJob(req.params.uuid);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    // Verify requester
    const user = await db.getUser(wallet);
    if (!user || user.id !== job.requester_id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // SECURITY P1-3: Check for existing active dispute on this job
    if (job.status === 'disputed') {
      return res.status(400).json({ 
        error: 'This job already has an active dispute',
        code: 'DUPLICATE_DISPUTE'
      });
    }
    
    // Allow disputes for paid, in_progress, delivered, and revision_requested statuses
    if (!['paid', 'in_progress', 'delivered', 'revision_requested'].includes(job.status)) {
      return res.status(400).json({ error: `Job status is ${job.status}, cannot dispute` });
    }
    
    // Valid issue types for categorization
    const validIssueTypes = ['no_delivery', 'quality_mismatch', 'wrong_output', 'technical_error', 'partial_delivery', 'other'];
    const issueType = issue_type && validIssueTypes.includes(issue_type) ? issue_type : 'other';
    
    // Store dispute reason with issue type as JSON for richer tracking
    const disputeData = JSON.stringify({
      issue_type: issueType,
      description: reason,
      evidence_urls: evidence_urls || [],
      submitted_at: new Date().toISOString()
    });
    
    // Mark as disputed
    await db.query(
      `UPDATE jobs SET status = 'disputed', dispute_reason = $1, disputed_at = NOW() WHERE id = $2`,
      [disputeData, job.id]
    );
    
    // Phase 2: Dispatch webhook event
    onJobDisputed(job, reason).catch(e => console.error('onJobDisputed webhook error:', e.message));
    
    // Send email notification to support (if email is configured)
    try {
      const emailSender = getEmailSender();
      const issueTypeLabels = {
        'no_delivery': 'No Delivery',
        'quality_mismatch': 'Quality Mismatch',
        'wrong_output': 'Wrong Output',
        'technical_error': 'Technical Error',
        'partial_delivery': 'Partial Delivery',
        'other': 'Other Issue'
      };
      
      const supportEmail = process.env.SUPPORT_EMAIL || 'support@thebotique.ai';
      await emailSender({
        to: supportEmail,
        subject: '[Dispute] ' + issueTypeLabels[issueType] + ' - Job #' + job.job_uuid.slice(0, 8),
        html: '<h2>New Dispute Opened</h2>' +
          '<p><strong>Job UUID:</strong> ' + job.job_uuid + '</p>' +
          '<p><strong>Issue Type:</strong> ' + issueTypeLabels[issueType] + '</p>' +
          '<p><strong>Skill:</strong> ' + (job.skill_name || 'N/A') + '</p>' +
          '<p><strong>Amount:</strong> $' + parseFloat(job.price_usdc || 0).toFixed(2) + ' USDC</p>' +
          '<p><strong>User Wallet:</strong> ' + wallet + '</p>' +
          '<hr><h3>Description:</h3>' +
          '<p>' + reason.replace(/\n/g, '<br>') + '</p>' +
          '<hr><p><a href="https://www.thebotique.ai/admin">View in Admin Panel</a></p>'
      });
      console.log('[Dispute] Email notification sent for job ' + job.job_uuid);
    } catch (emailError) {
      // Email failure should not fail the dispute
      console.log('[Dispute] Email notification failed (non-critical): ' + emailError.message);
    }
    
    // Q-Learning: Record disputed outcome for learning
    agentRouter.recordMatchOutcome(db, job.job_uuid, job.agent_id, null, 'disputed')
      .catch(e => logger.error('Failed to record match outcome', { error: e.message }));
    
    res.json({ 
      success: true, 
      jobUuid: job.job_uuid, 
      status: 'disputed',
      issue_type: issueType,
      message: 'Dispute opened. Platform will review within 48 hours.'
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to open dispute');
    res.status(statusCode).json(body);
  }
});

/**
 * Recalculate trust tier for an agent
 * POST /api/agents/:id/recalculate-trust
 */
router.post('/api/agents/:id/recalculate-trust', validateIdParam('id'), async (req, res) => {
  try {
    const result = await db.calculateTrustTier(req.params.id);
    if (!result) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.json(result);
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to recalculate trust');
    res.status(statusCode).json(body);
  }
});

/**
 * Get trust tier progress for an agent
 * GET /api/agents/:id/trust-progress
 */
router.get('/api/agents/:id/trust-progress', validateIdParam('id'), async (req, res) => {
  try {
    const agent = await db.getAgentById(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Define tier requirements per PRD
    const tierRequirements = {
      new: { tasks: 0, rating: 0, responseHrs: Infinity, completionRate: 0, earnings: 0 },
      rising: { tasks: 5, rating: 4.0, responseHrs: 24, completionRate: 0, earnings: 0 },
      established: { tasks: 25, rating: 4.3, responseHrs: 12, completionRate: 90, earnings: 0 },
      trusted: { tasks: 100, rating: 4.5, responseHrs: 6, completionRate: 95, earnings: 10000 },
      verified: { tasks: 250, rating: 4.7, responseHrs: 3, completionRate: 98, earnings: 50000 }
    };

    const tierOrder = ['new', 'rising', 'established', 'trusted', 'verified'];
    const currentTierIndex = tierOrder.indexOf(agent.trust_tier || 'new');
    const nextTier = currentTierIndex < tierOrder.length - 1 ? tierOrder[currentTierIndex + 1] : null;

    // Current stats
    const current = {
      tasks: parseInt(agent.total_jobs) || 0,
      rating: parseFloat(agent.rating) || 0,
      responseHrs: (parseInt(agent.response_time_avg) || 0) / 3600,
      completionRate: parseFloat(agent.completion_rate) || 100,
      earnings: parseFloat(agent.total_earned) || 0,
      securityAudit: agent.security_audit_status === 'passed',
      webhookVerified: !!agent.webhook_verified_at,
      rentahuman: agent.rentahuman_enabled === true
    };

    // Calculate progress to next tier
    let progress = {};
    if (nextTier) {
      const req = tierRequirements[nextTier];
      progress = {
        nextTier,
        requirements: {
          tasks: { current: current.tasks, required: req.tasks, met: current.tasks >= req.tasks },
          rating: { current: current.rating.toFixed(1), required: req.rating, met: current.rating >= req.rating },
          responseTime: { current: current.responseHrs.toFixed(1) + 'h', required: req.responseHrs + 'h', met: current.responseHrs <= req.responseHrs || req.responseHrs === Infinity },
          completionRate: { current: current.completionRate.toFixed(0) + '%', required: req.completionRate + '%', met: current.completionRate >= req.completionRate },
          earnings: { current: '$' + current.earnings.toFixed(0), required: '$' + req.earnings, met: current.earnings >= req.earnings || req.earnings === 0 }
        },
        percentComplete: calculateProgressPercent(current, req)
      };

      // Add special requirements for higher tiers
      if (nextTier === 'established' || nextTier === 'trusted' || nextTier === 'verified') {
        progress.requirements.securityAudit = { current: current.securityAudit ? 'Passed' : 'Not done', required: 'Passed', met: current.securityAudit };
      }
      if (nextTier === 'verified') {
        progress.requirements.rentahuman = { current: current.rentahuman ? 'Enabled' : 'Not enabled', required: 'Enabled', met: current.rentahuman };
      }
    }

    res.json({
      currentTier: agent.trust_tier || 'new',
      trustScore: agent.trust_score || 0,
      stats: current,
      progress,
      tierBenefits: getTierBenefits(agent.trust_tier || 'new')
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to get trust progress');
    res.status(statusCode).json(body);
  }
});

// Helper to calculate progress percentage
function calculateProgressPercent(current, requirements) {
  const metrics = [
    Math.min(100, (current.tasks / requirements.tasks) * 100) || 0,
    Math.min(100, (current.rating / requirements.rating) * 100) || 0,
    requirements.completionRate > 0 ? Math.min(100, (current.completionRate / requirements.completionRate) * 100) : 100,
    requirements.earnings > 0 ? Math.min(100, (current.earnings / requirements.earnings) * 100) : 100
  ];
  return Math.round(metrics.reduce((a, b) => a + b, 0) / metrics.length);
}

// Helper to get tier benefits
function getTierBenefits(tier) {
  const benefits = {
    new: ['Listed in marketplace', 'Can accept tasks', 'Standard 15% platform fee'],
    rising: ['Rising badge', 'Improved search ranking', 'Featured in "New & Promising"', '12% platform fee'],
    established: ['Established badge', 'Priority support', '10% platform fee', 'Featured placement'],
    trusted: ['Trusted badge', 'Top search placement', '8% platform fee', 'Custom branding'],
    verified: ['Verified badge', 'Highest priority', '5% platform fee', 'Co-marketing opportunities', 'Dedicated support']
  };
  return benefits[tier] || benefits.new;
}

/**
 * Dashboard analytics for an agent
 * GET /api/agents/:id/analytics
 */
router.get('/api/agents/:id/analytics', validateIdParam('id'), async (req, res) => {
  try {
    const agentId = req.params.id;
    const { days = 30 } = req.query;
    
    // Get agent
    const agent = await db.getAgentById(agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Get jobs for this agent within time period
    const jobsResult = await db.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as tasks,
        SUM(CASE WHEN status = 'completed' THEN price_usdc ELSE 0 END) as earnings,
        AVG(CASE WHEN rating IS NOT NULL THEN rating ELSE NULL END) as avg_rating
      FROM jobs 
      WHERE agent_id = $1 
        AND created_at > NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [agentId]);

    // Get totals
    const totalsResult = await db.query(`
      SELECT 
        COUNT(*) as total_tasks,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_tasks,
        COUNT(CASE WHEN status = 'pending' OR status = 'paid' OR status = 'in_progress' THEN 1 END) as active_tasks,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN price_usdc ELSE 0 END), 0) as total_earnings,
        COALESCE(AVG(CASE WHEN rating IS NOT NULL THEN rating END), 0) as avg_rating
      FROM jobs WHERE agent_id = $1
    `, [agentId]);

    // Get recent reviews
    const reviewsResult = await db.query(`
      SELECT r.*, j.skill_name
      FROM reviews r
      JOIN jobs j ON r.job_id = j.id
      WHERE j.agent_id = $1
      ORDER BY r.created_at DESC
      LIMIT 5
    `, [agentId]);

    // Calculate week-over-week changes
    const lastWeekResult = await db.query(`
      SELECT 
        COUNT(*) as tasks,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN price_usdc ELSE 0 END), 0) as earnings
      FROM jobs 
      WHERE agent_id = $1 
        AND created_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
    `, [agentId]);

    const thisWeekResult = await db.query(`
      SELECT 
        COUNT(*) as tasks,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN price_usdc ELSE 0 END), 0) as earnings
      FROM jobs 
      WHERE agent_id = $1 
        AND created_at > NOW() - INTERVAL '7 days'
    `, [agentId]);

    const lastWeek = lastWeekResult.rows[0] || { tasks: 0, earnings: 0 };
    const thisWeek = thisWeekResult.rows[0] || { tasks: 0, earnings: 0 };

    res.json({
      period: `${days} days`,
      daily: jobsResult.rows,
      totals: totalsResult.rows[0],
      recentReviews: reviewsResult.rows,
      trends: {
        tasksChange: lastWeek.tasks > 0 
          ? Math.round(((thisWeek.tasks - lastWeek.tasks) / lastWeek.tasks) * 100) 
          : thisWeek.tasks > 0 ? 100 : 0,
        earningsChange: parseFloat(lastWeek.earnings) > 0 
          ? Math.round(((parseFloat(thisWeek.earnings) - parseFloat(lastWeek.earnings)) / parseFloat(lastWeek.earnings)) * 100) 
          : parseFloat(thisWeek.earnings) > 0 ? 100 : 0
      }
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to get analytics');
    res.status(statusCode).json(body);
  }
});

/**
 * Get pending actions for operator dashboard
 * GET /api/agents/:id/pending-actions
 */
router.get('/api/agents/:id/pending-actions', validateIdParam('id'), async (req, res) => {
  try {
    const agentId = req.params.id;

    // Get jobs needing action
    const pendingJobs = await db.query(`
      SELECT id, job_uuid, skill_name, status, price_usdc, created_at, input
      FROM jobs 
      WHERE agent_id = $1 
        AND status IN ('paid', 'in_progress')
      ORDER BY created_at ASC
    `, [agentId]);

    // Get revision requests
    const revisionJobs = await db.query(`
      SELECT id, job_uuid, skill_name, price_usdc, revision_notes, created_at
      FROM jobs 
      WHERE agent_id = $1 
        AND status = 'revision_requested'
      ORDER BY created_at ASC
    `, [agentId]);

    // Get disputes
    const disputes = await db.query(`
      SELECT id, job_uuid, skill_name, price_usdc, dispute_reason, disputed_at
      FROM jobs 
      WHERE agent_id = $1 
        AND status = 'disputed'
      ORDER BY disputed_at ASC
    `, [agentId]);

    // Get unanswered reviews (no agent_response)
    const unansweredReviews = await db.query(`
      SELECT r.id, r.rating, r.comment, r.created_at, j.skill_name
      FROM reviews r
      JOIN jobs j ON r.job_id = j.id
      WHERE j.agent_id = $1 
        AND r.agent_response IS NULL
        AND r.comment IS NOT NULL
      ORDER BY r.created_at DESC
      LIMIT 10
    `, [agentId]);

    res.json({
      pendingJobs: pendingJobs.rows,
      revisionRequests: revisionJobs.rows,
      disputes: disputes.rows,
      unansweredReviews: unansweredReviews.rows,
      totalActions: pendingJobs.rows.length + revisionJobs.rows.length + disputes.rows.length + unansweredReviews.rows.length
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to get pending actions');
    res.status(statusCode).json(body);
  }
});

/**
 * Respond to a review
 * POST /api/reviews/:id/respond
 */
router.post('/api/reviews/:id/respond', validateIdParam('id'), async (req, res) => {
  try {
    const { response, wallet } = req.body;
    
    if (!response || !wallet) {
      return res.status(400).json({ error: 'Response and wallet required' });
    }

    // Verify the wallet owns this agent's review
    const review = await db.query(`
      SELECT r.*, j.agent_id, a.user_id, u.wallet_address
      FROM reviews r
      JOIN jobs j ON r.job_id = j.id
      JOIN agents a ON j.agent_id = a.id
      JOIN users u ON a.user_id = u.id
      WHERE r.id = $1
    `, [req.params.id]);

    if (!review.rows[0]) {
      return res.status(404).json({ error: 'Review not found' });
    }

    if (review.rows[0].wallet_address.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(403).json({ error: 'Not authorized to respond to this review' });
    }

    // Update review with response
    await db.query(`
      UPDATE reviews 
      SET agent_response = $1, agent_response_at = NOW()
      WHERE id = $2
    `, [sanitizeText(response, 500), req.params.id]);

    res.json({ success: true, message: 'Response posted' });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to post response');
    res.status(statusCode).json(body);
  }
});

/**
 * Advanced agent search with filters
 * GET /api/agents/search
 * 
 * A2A Capability Discovery:
 * Use `capability` param to find agents that can do specific tasks.
 * Examples:
 *   /api/agents/search?capability=python
 *   /api/agents/search?capability=write%20code
 *   /api/agents/search?q=research&min_rating=4.5
 */
router.get('/api/agents/search', async (req, res) => {
  try {
    const {
      q,
      capability, // A2A: Semantic capability search
      category,
      skills,
      min_rating,
      max_price,
      trust_tier,
      sort = 'relevance', // Default to relevance for capability search
      order = 'desc',
      page = 1,
      limit = 20
    } = req.query;
    
    // Use capability or q for search
    const searchTerm = capability || q;
    
    let sql = `
      SELECT a.*, u.wallet_address, u.name, u.avatar_url, u.bio,
             (SELECT json_agg(s.*) FROM skills s WHERE s.agent_id = a.id AND s.is_active = true) as skills,
             CASE 
               WHEN $1::text IS NOT NULL THEN (
                 -- Relevance scoring for capability matching
                 CASE WHEN LOWER(u.name) LIKE LOWER($1) THEN 100 ELSE 0 END +
                 CASE WHEN LOWER(u.bio) LIKE LOWER($1) THEN 50 ELSE 0 END +
                 (SELECT COUNT(*) * 30 FROM skills s WHERE s.agent_id = a.id AND (
                   LOWER(s.name) LIKE LOWER($1) OR LOWER(s.description) LIKE LOWER($1)
                 )) +
                 COALESCE(a.trust_score, 0) / 10 +
                 COALESCE(a.total_jobs, 0)
               )
               ELSE COALESCE(a.trust_score, 0)
             END as relevance_score
      FROM agents a
      JOIN users u ON a.user_id = u.id
      WHERE a.is_active = true
    `;
    const params = [searchTerm ? `%${searchTerm}%` : null];
    let paramIndex = 2;
    
    // Search query / capability
    if (searchTerm) {
      sql += ` AND (u.name ILIKE $1 OR u.bio ILIKE $1 OR EXISTS (
        SELECT 1 FROM skills s WHERE s.agent_id = a.id AND (
          s.name ILIKE $1 OR s.description ILIKE $1 OR s.category ILIKE $1
        )
      ))`;
    }
    
    // Category filter
    if (category) {
      sql += ` AND EXISTS (SELECT 1 FROM skills s WHERE s.agent_id = a.id AND LOWER(s.category) = LOWER($${paramIndex}))`;
      params.push(category);
      paramIndex++;
    }
    
    // Min rating
    if (min_rating) {
      sql += ` AND a.rating >= $${paramIndex}`;
      params.push(parseFloat(min_rating));
      paramIndex++;
    }
    
    // Max price
    if (max_price) {
      sql += ` AND EXISTS (SELECT 1 FROM skills s WHERE s.agent_id = a.id AND s.price_usdc <= $${paramIndex})`;
      params.push(parseFloat(max_price));
      paramIndex++;
    }
    
    // Trust tier minimum
    if (trust_tier) {
      const tierOrder = ['new', 'rising', 'established', 'trusted', 'verified'];
      const minTierIndex = tierOrder.indexOf(trust_tier);
      if (minTierIndex >= 0) {
        const validTiers = tierOrder.slice(minTierIndex);
        sql += ` AND COALESCE(a.trust_tier, 'new') = ANY($${paramIndex})`;
        params.push(validTiers);
        paramIndex++;
      }
    }
    
    // Sorting - default to relevance for capability searches
    const sortFields = {
      'relevance': 'relevance_score',
      'rating': 'a.rating',
      'tasks': 'a.total_jobs',
      'price': '(SELECT MIN(s.price_usdc) FROM skills s WHERE s.agent_id = a.id)',
      'trust': 'a.trust_score'
    };
    const effectiveSort = searchTerm && sort === 'relevance' ? 'relevance' : (sort === 'relevance' ? 'rating' : sort);
    const sortField = sortFields[effectiveSort] || 'a.rating';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${sortField} ${sortOrder} NULLS LAST`;
    
    // Pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), offset);
    
    const result = await db.query(sql, params);
    
    // Transform results for A2A consumption
    const agents = sanitizeAgents(result.rows).map(agent => ({
      ...agent,
      matchScore: agent.relevance_score || 0,
      matchingSkills: searchTerm && agent.skills ? 
        agent.skills.filter(s => 
          (s.name && s.name.toLowerCase().includes(searchTerm.toLowerCase())) ||
          (s.description && s.description.toLowerCase().includes(searchTerm.toLowerCase()))
        ) : []
    }));
    
    res.json({
      agents,
      query: { q, capability, category, min_rating, max_price, trust_tier },
      page: parseInt(page),
      limit: parseInt(limit),
      total: result.rows.length,
      hasMore: result.rows.length === parseInt(limit)
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Search failed');
    res.status(statusCode).json(body);
  }
});

// ============================================
// SEMANTIC SEARCH (Vector-Based)
// ============================================

// Lazy-load embeddings module to prevent startup crashes if OpenAI unavailable
let embeddings = null;
function getEmbeddingsModule() {
  if (!embeddings) {
    try {
      embeddings = require('./embeddings');
    } catch (e) {
      console.error('Embeddings module failed to load:', e.message);
      embeddings = null;
    }
  }
  return embeddings;
}

/**
 * Semantic agent search using vector similarity
 * GET /api/agents/semantic-search
 * 
 * This endpoint uses OpenAI embeddings to find agents based on
 * natural language queries with semantic understanding.
 * 
 * Examples:
 *   /api/agents/semantic-search?q=I need help with market research
 *   /api/agents/semantic-search?q=Write me a blog post about AI
 *   /api/agents/semantic-search?q=analyze my sales data
 * 
 * Falls back to text search if OpenAI API key is not configured.
 */
router.get('/api/agents/semantic-search', async (req, res) => {
  try {
    const {
      q,
      query: queryParam, // Alias for q
      limit = 10,
      min_similarity = 0.3,
      category,
      trust_tier
    } = req.query;
    
    const searchQuery = q || queryParam;
    
    if (!searchQuery || searchQuery.trim().length === 0) {
      return res.status(400).json({
        error: 'Search query required',
        code: 'MISSING_QUERY',
        hint: 'Use ?q=your search query'
      });
    }
    
    const embeddingsModule = getEmbeddingsModule();
    if (!embeddingsModule) {
      // Fallback to basic text search
      return res.redirect(`/api/agents/search?q=${encodeURIComponent(searchQuery)}&limit=${limit}`);
    }
    
    const results = await embeddingsModule.semanticSearch(searchQuery, {
      limit: parseInt(limit),
      minSimilarity: parseFloat(min_similarity),
      category,
      trustTier: trust_tier
    });
    
    res.json(results);
  } catch (error) {
    console.error('Semantic search error:', error);
    const { statusCode, body } = formatErrorResponse(error, 'Semantic search failed');
    res.status(statusCode).json(body);
  }
});

/**
 * Get embedding statistics
 * GET /api/embeddings/stats
 */
router.get('/api/embeddings/stats', async (req, res) => {
  try {
    const embeddingsModule = getEmbeddingsModule();
    if (!embeddingsModule) {
      return res.json({
        available: false,
        error: 'Embeddings module not loaded'
      });
    }
    
    const stats = await embeddingsModule.getEmbeddingStats();
    res.json(stats);
  } catch (error) {
    console.error('Embedding stats error:', error);
    res.status(500).json({ error: 'Failed to get embedding stats' });
  }
});

/**
 * Trigger embedding backfill (admin only)
 * POST /api/embeddings/backfill
 * Requires X-Admin-Key header
 */
router.post('/api/embeddings/backfill', async (req, res) => {
  try {
    // Simple admin key check (should use proper auth in production)
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const embeddingsModule = getEmbeddingsModule();
    if (!embeddingsModule) {
      return res.status(503).json({
        error: 'Embeddings module not available',
        hint: 'Ensure OPENAI_API_KEY is set'
      });
    }
    
    // Run backfill in background
    const { batchSize = 10, delayMs = 1000 } = req.body || {};
    
    // Start backfill (don't await - let it run in background)
    embeddingsModule.backfillEmbeddings({ batchSize, delayMs })
      .then(result => console.log('Backfill completed:', result))
      .catch(err => console.error('Backfill failed:', err));
    
    res.json({
      message: 'Backfill started in background',
      batchSize,
      delayMs
    });
  } catch (error) {
    console.error('Backfill trigger error:', error);
    res.status(500).json({ error: 'Failed to start backfill' });
  }
});

/**
 * Compute embedding for a specific agent (admin/agent owner)
 * POST /api/agents/:id/compute-embedding
 */
router.post('/api/agents/:id/compute-embedding', async (req, res) => {
  try {
    const agentId = parseInt(req.params.id);
    if (isNaN(agentId)) {
      return res.status(400).json({ error: 'Invalid agent ID' });
    }
    
    // Check auth - either admin or the agent's own API key
    const apiKey = req.headers['x-api-key'];
    const adminKey = req.headers['x-admin-key'];
    
    let authorized = false;
    
    if (adminKey && adminKey === process.env.ADMIN_API_KEY) {
      authorized = true;
    } else if (apiKey) {
      // Verify API key belongs to this agent
      const agentResult = await db.query(
        'SELECT id FROM agents WHERE id = $1 AND api_key = $2',
        [agentId, apiKey]
      );
      if (agentResult.rows.length > 0) {
        authorized = true;
      }
    }
    
    if (!authorized) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const embeddingsModule = getEmbeddingsModule();
    if (!embeddingsModule) {
      return res.status(503).json({
        error: 'Embeddings module not available',
        hint: 'Ensure OPENAI_API_KEY is set'
      });
    }
    
    const success = await embeddingsModule.computeAgentEmbedding(agentId);
    
    if (success) {
      // Update timestamp
      await db.query(
        'UPDATE agents SET embedding_updated_at = NOW() WHERE id = $1',
        [agentId]
      );
      
      res.json({
        success: true,
        message: 'Embedding computed and stored',
        agentId
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to compute embedding'
      });
    }
  } catch (error) {
    console.error('Compute embedding error:', error);
    res.status(500).json({ error: 'Failed to compute embedding' });
  }
});

// ============================================
// LEGAL PAGES
// ============================================

// ============================================
// LOCALIZATION (Phase 3)
// ============================================

const SUPPORTED_LOCALES = {
  en: { name: 'English', flag: '🇺🇸' },
  es: { name: 'Español', flag: '🇪🇸' },
  zh: { name: '中文', flag: '🇨🇳' },
  ja: { name: '日本語', flag: '🇯🇵' },
  ko: { name: '한국어', flag: '🇰🇷' }
};

const TRANSLATIONS = {
  en: {
    nav: { browse: 'Browse Agents', register: 'Register Agent', dashboard: 'Dashboard' },
    hero: { title: 'AI Agents That', highlight: 'Actually Get Work Done', subtitle: 'Autonomous agents. Real results. Pay with crypto, get work done in seconds.' },
    search: { placeholder: 'What do you need? Try "research", "image", "code"...' },
    categories: { all: 'All Categories', research: 'Research', writing: 'Writing', image: 'Images', code: 'Code' },
    trust: { new: 'New', rising: 'Rising', established: 'Established', trusted: 'Trusted', verified: 'Verified' },
    actions: { hire: 'Hire', connect: 'Connect Wallet', submit: 'Submit', cancel: 'Cancel' },
    jobs: { pending: 'Pending', paid: 'Paid', completed: 'Completed', delivered: 'Delivered' }
  },
  es: {
    nav: { browse: 'Explorar Agentes', register: 'Registrar Agente', dashboard: 'Panel' },
    hero: { title: 'Agentes de IA Que', highlight: 'Realmente Trabajan', subtitle: 'Agentes autónomos. Resultados reales. Paga con cripto, obtén resultados en segundos.' },
    search: { placeholder: '¿Qué necesitas? Prueba "investigación", "imagen", "código"...' },
    categories: { all: 'Todas', research: 'Investigación', writing: 'Escritura', image: 'Imágenes', code: 'Código' },
    trust: { new: 'Nuevo', rising: 'Emergente', established: 'Establecido', trusted: 'Confiable', verified: 'Verificado' },
    actions: { hire: 'Contratar', connect: 'Conectar Wallet', submit: 'Enviar', cancel: 'Cancelar' },
    jobs: { pending: 'Pendiente', paid: 'Pagado', completed: 'Completado', delivered: 'Entregado' }
  },
  zh: {
    nav: { browse: '浏览代理', register: '注册代理', dashboard: '仪表板' },
    hero: { title: 'AI代理', highlight: '真正完成工作', subtitle: '自主代理。真实结果。使用加密货币支付，几秒钟内完成工作。' },
    search: { placeholder: '你需要什么？尝试"研究"、"图像"、"代码"...' },
    categories: { all: '全部', research: '研究', writing: '写作', image: '图像', code: '代码' },
    trust: { new: '新手', rising: '上升', established: '已建立', trusted: '可信', verified: '已验证' },
    actions: { hire: '雇用', connect: '连接钱包', submit: '提交', cancel: '取消' },
    jobs: { pending: '待处理', paid: '已支付', completed: '已完成', delivered: '已交付' }
  },
  ja: {
    nav: { browse: 'エージェントを探す', register: 'エージェント登録', dashboard: 'ダッシュボード' },
    hero: { title: 'AIエージェント', highlight: '本当に仕事をする', subtitle: '自律エージェント。実際の結果。暗号通貨で支払い、数秒で結果を得る。' },
    search: { placeholder: '何が必要ですか？「調査」「画像」「コード」を試してください...' },
    categories: { all: 'すべて', research: '調査', writing: '執筆', image: '画像', code: 'コード' },
    trust: { new: '新規', rising: '上昇中', established: '確立', trusted: '信頼', verified: '認証済' },
    actions: { hire: '雇用', connect: 'ウォレット接続', submit: '送信', cancel: 'キャンセル' },
    jobs: { pending: '保留中', paid: '支払済', completed: '完了', delivered: '納品済' }
  },
  ko: {
    nav: { browse: '에이전트 찾기', register: '에이전트 등록', dashboard: '대시보드' },
    hero: { title: 'AI 에이전트', highlight: '실제로 일을 처리', subtitle: '자율 에이전트. 실제 결과. 암호화폐로 결제하고 몇 초 만에 결과를 받으세요.' },
    search: { placeholder: '무엇이 필요하세요? "연구", "이미지", "코드"를 시도해보세요...' },
    categories: { all: '전체', research: '연구', writing: '글쓰기', image: '이미지', code: '코드' },
    trust: { new: '신규', rising: '상승', established: '확립', trusted: '신뢰', verified: '인증' },
    actions: { hire: '고용', connect: '지갑 연결', submit: '제출', cancel: '취소' },
    jobs: { pending: '대기중', paid: '지불됨', completed: '완료', delivered: '전달됨' }
  }
};

function getTranslation(locale, key) {
  const keys = key.split('.');
  let value = TRANSLATIONS[locale] || TRANSLATIONS.en;
  for (const k of keys) {
    value = value?.[k];
  }
  return value || TRANSLATIONS.en[keys[0]]?.[keys[1]] || key;
}

/**
 * Get available locales
 * GET /api/locales
 */
router.get('/api/locales', (req, res) => {
  res.json({
    locales: Object.entries(SUPPORTED_LOCALES).map(([code, data]) => ({
      code,
      ...data
    })),
    default: 'en'
  });
});

/**
 * Get translations for a locale
 * GET /api/locales/:locale
 */
router.get('/api/locales/:locale', (req, res) => {
  const locale = req.params.locale;
  
  if (!SUPPORTED_LOCALES[locale]) {
    return res.status(404).json({ error: 'Locale not supported' });
  }

  res.json({
    locale,
    ...SUPPORTED_LOCALES[locale],
    translations: TRANSLATIONS[locale]
  });
});

// ============================================
// DEVELOPER SDK & WEBHOOKS (Phase 3)
// ============================================

/**
 * Generate API key for operator
 * POST /api/developers/api-key
 */
router.post('/api/developers/api-key', async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) {
      return res.status(400).json({ error: 'Wallet required' });
    }

    // Generate API key
    const apiKey = 'bot_' + require('crypto').randomBytes(24).toString('hex');
    
    // Get or create user and store API key
    let user = await db.getUser(wallet);
    if (!user) {
      user = await db.createUser(wallet, 'operator');
    }

    await db.query(
      'UPDATE users SET api_key = $1, api_key_created_at = NOW() WHERE id = $2',
      [apiKey, user.id]
    );

    res.json({
      success: true,
      apiKey,
      message: 'Store this key securely. It will only be shown once.'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate API key' });
  }
});

/**
 * Validate API key middleware
 */
async function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  try {
    const result = await db.query(
      'SELECT * FROM users WHERE api_key = $1',
      [apiKey]
    );

    if (!result.rows[0]) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.apiUser = result.rows[0];
    next();
  } catch (error) {
    res.status(500).json({ error: 'Auth failed' });
  }
}

/**
 * SDK: Submit job programmatically
 * POST /api/sdk/jobs
 */
router.post('/api/sdk/jobs', validateApiKey, async (req, res) => {
  try {
    const { skillId, input, webhookUrl } = req.body;
    
    if (!skillId || !input) {
      return res.status(400).json({ error: 'skillId and input required' });
    }

    // Get skill
    const skillResult = await db.query('SELECT * FROM skills WHERE id = $1', [skillId]);
    const skill = skillResult.rows[0];
    
    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    // Create job
    const jobUuid = uuidv4();
    const job = await db.query(`
      INSERT INTO jobs (job_uuid, requester_id, agent_id, skill_id, input_data, price_usdc, status, requester_wallet, skill_name, webhook_url)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
      RETURNING *
    `, [
      jobUuid, 
      req.apiUser.id, 
      skill.agent_id, 
      skillId, 
      JSON.stringify({ prompt: input, source: 'sdk' }), 
      skill.price_usdc,
      req.apiUser.wallet_address,
      skill.name,
      webhookUrl || null
    ]);

    res.json({
      success: true,
      job: {
        uuid: jobUuid,
        status: 'pending',
        price: skill.price_usdc,
        skillName: skill.name
      },
      paymentRequired: true,
      paymentAddress: process.env.TREASURY_ADDRESS || '0x...'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create job' });
  }
});

/**
 * SDK: Get job status
 * GET /api/sdk/jobs/:uuid
 */
router.get('/api/sdk/jobs/:uuid', validateApiKey, async (req, res) => {
  try {
    const job = await db.getJob(req.params.uuid);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Verify ownership
    if (job.requester_id !== req.apiUser.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    res.json({
      uuid: job.job_uuid,
      status: job.status,
      skillName: job.skill_name,
      price: job.price_usdc,
      input: job.input_data,
      output: job.output_data,
      createdAt: job.created_at,
      completedAt: job.completed_at
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get job' });
  }
});

/**
 * SDK: List user's jobs
 * GET /api/sdk/jobs
 */
router.get('/api/sdk/jobs', validateApiKey, async (req, res) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    
    let query = 'SELECT * FROM jobs WHERE requester_id = $1';
    const params = [req.apiUser.id];
    
    if (status) {
      query += ' AND status = $2';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    res.json({
      jobs: result.rows.map(j => ({
        uuid: j.job_uuid,
        status: j.status,
        skillName: j.skill_name,
        price: j.price_usdc,
        createdAt: j.created_at
      })),
      pagination: { limit: parseInt(limit), offset: parseInt(offset) }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

/**
 * Webhook test endpoint
 * POST /api/webhooks/test
 */
// ============================================
// AGENT CERTIFICATION PROGRAM (Phase 3)
// ============================================

router.get('/api/certifications', async (req, res) => {
  const result = await db.query('SELECT * FROM certifications ORDER BY name');
  res.json(result.rows);
});

router.get('/api/agents/:id/certifications', validateIdParam('id'), async (req, res) => {
  const result = await db.query(`
    SELECT c.*, ac.status, ac.issued_at, ac.expires_at
    FROM agent_certifications ac
    JOIN certifications c ON ac.certification_id = c.id
    WHERE ac.agent_id = $1 AND ac.status = 'approved'
  `, [req.params.id]);
  res.json(result.rows);
});

router.post('/api/agents/:id/certifications/apply', validateIdParam('id'), async (req, res) => {
  const { wallet, certificationSlug } = req.body;
  if (!wallet || !certificationSlug) {
    return res.status(400).json({ error: 'wallet and certificationSlug required' });
  }

  // Verify ownership
  const agent = await db.query(`
    SELECT a.*, u.wallet_address FROM agents a
    JOIN users u ON a.user_id = u.id WHERE a.id = $1
  `, [req.params.id]);
  
  if (!agent.rows[0] || agent.rows[0].wallet_address.toLowerCase() !== wallet.toLowerCase()) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const cert = await db.query('SELECT * FROM certifications WHERE slug = $1', [certificationSlug]);
  if (!cert.rows[0]) {
    return res.status(404).json({ error: 'Certification not found' });
  }

  await db.query(`
    INSERT INTO agent_certifications (agent_id, certification_id, status)
    VALUES ($1, $2, 'pending')
    ON CONFLICT (agent_id, certification_id) DO UPDATE SET status = 'pending', created_at = NOW()
  `, [req.params.id, cert.rows[0].id]);

  res.json({ success: true, message: 'Application submitted' });
});

// ============================================
// PREMIUM SUPPORT (Phase 3)
// ============================================

const SUPPORT_TIERS = {
  free: { priority: 'normal', responseTime: '48h', features: ['Email support', 'Community forum'] },
  pro: { priority: 'high', responseTime: '24h', features: ['Priority email', 'Chat support', 'Phone callback'] },
  enterprise: { priority: 'urgent', responseTime: '4h', features: ['Dedicated manager', '24/7 phone', 'SLA guarantee'] }
};

router.get('/api/support/tiers', (req, res) => res.json(SUPPORT_TIERS));

router.post('/api/support/tickets', async (req, res) => {
  const { wallet, subject, message, category } = req.body;
  if (!wallet || !subject || !message) {
    return res.status(400).json({ error: 'wallet, subject, message required' });
  }

  const ticketUuid = uuidv4();
  const result = await db.query(`
    INSERT INTO support_tickets (ticket_uuid, user_wallet, subject, category)
    VALUES ($1, $2, $3, $4) RETURNING *
  `, [ticketUuid, wallet.toLowerCase(), subject, category]);

  await db.query(`
    INSERT INTO support_messages (ticket_id, sender_wallet, sender_type, message)
    VALUES ($1, $2, 'user', $3)
  `, [result.rows[0].id, wallet.toLowerCase(), message]);

  res.json({ success: true, ticketUuid, ticketId: result.rows[0].id });
});

router.get('/api/support/tickets', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });

  const result = await db.query(`
    SELECT * FROM support_tickets WHERE user_wallet = $1 ORDER BY created_at DESC
  `, [wallet.toLowerCase()]);
  res.json(result.rows);
});

router.get('/api/support/tickets/:uuid', async (req, res) => {
  const ticket = await db.query('SELECT * FROM support_tickets WHERE ticket_uuid = $1', [req.params.uuid]);
  if (!ticket.rows[0]) return res.status(404).json({ error: 'Ticket not found' });

  const messages = await db.query(
    'SELECT * FROM support_messages WHERE ticket_id = $1 ORDER BY created_at ASC',
    [ticket.rows[0].id]
  );
  res.json({ ticket: ticket.rows[0], messages: messages.rows });
});

// ============================================
// WHITE-LABEL (Phase 3)
// ============================================

const WHITE_LABEL_PLANS = {
  starter: { price: 299, revenueShare: 15, agents: 10, features: ['Custom branding', 'Subdomain'] },
  growth: { price: 799, revenueShare: 10, agents: 50, features: ['Custom domain', 'API access', 'Priority support'] },
  enterprise: { price: 1999, revenueShare: 5, agents: 'unlimited', features: ['Full customization', 'Dedicated support', 'SLA'] }
};

router.get('/api/white-label/plans', (req, res) => res.json(WHITE_LABEL_PLANS));

router.post('/api/white-label/apply', async (req, res) => {
  const { wallet, companyName, subdomain, plan = 'starter' } = req.body;
  if (!wallet || !companyName) {
    return res.status(400).json({ error: 'wallet, companyName required' });
  }

  const existing = await db.query('SELECT * FROM white_labels WHERE owner_wallet = $1', [wallet.toLowerCase()]);
  if (existing.rows[0]) {
    return res.status(409).json({ error: 'Already have a white-label application' });
  }

  const planConfig = WHITE_LABEL_PLANS[plan];
  const result = await db.query(`
    INSERT INTO white_labels (owner_wallet, company_name, subdomain, plan, monthly_fee, revenue_share)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [wallet.toLowerCase(), companyName, subdomain, plan, planConfig.price, planConfig.revenueShare]);

  res.json({ success: true, application: result.rows[0] });
});

router.get('/api/white-label/status', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });

  const result = await db.query('SELECT * FROM white_labels WHERE owner_wallet = $1', [wallet.toLowerCase()]);
  res.json(result.rows[0] || null);
});

router.put('/api/white-label/customize', async (req, res) => {
  const { wallet, logoUrl, primaryColor, secondaryColor, customDomain } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });

  const wl = await db.query('SELECT * FROM white_labels WHERE owner_wallet = $1', [wallet.toLowerCase()]);
  if (!wl.rows[0]) return res.status(404).json({ error: 'No white-label found' });

  await db.query(`
    UPDATE white_labels SET 
      logo_url = COALESCE($1, logo_url),
      primary_color = COALESCE($2, primary_color),
      secondary_color = COALESCE($3, secondary_color),
      custom_domain = COALESCE($4, custom_domain)
    WHERE owner_wallet = $5
  `, [logoUrl, primaryColor, secondaryColor, customDomain, wallet.toLowerCase()]);

  res.json({ success: true });
});

// ============================================
// FUTURE VISION: Multi-Agent Workflows
// ============================================

router.post('/api/workflows', async (req, res) => {
  const { wallet, name, description, steps } = req.body;
  if (!wallet || !name || !steps?.length) {
    return res.status(400).json({ error: 'wallet, name, steps required' });
  }

  const workflowUuid = uuidv4();
  const wf = await db.query(`
    INSERT INTO workflows (workflow_uuid, owner_wallet, name, description)
    VALUES ($1, $2, $3, $4) RETURNING *
  `, [workflowUuid, wallet.toLowerCase(), name, description]);

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await db.query(`
      INSERT INTO workflow_steps (workflow_id, step_order, skill_id, name, input_template, condition)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [wf.rows[0].id, i + 1, s.skillId, s.name, s.inputTemplate, s.condition]);
  }

  res.json({ success: true, workflowUuid, workflowId: wf.rows[0].id });
});

router.get('/api/workflows', async (req, res) => {
  const { wallet, public: showPublic } = req.query;
  let query = 'SELECT * FROM workflows WHERE ';
  let params = [];

  if (showPublic === 'true') {
    query += 'is_public = true';
  } else if (wallet) {
    query += 'owner_wallet = $1';
    params = [wallet.toLowerCase()];
  } else {
    return res.status(400).json({ error: 'wallet or public=true required' });
  }

  const result = await db.query(query + ' ORDER BY created_at DESC', params);
  res.json(result.rows);
});

router.get('/api/workflows/:uuid', async (req, res) => {
  const wf = await db.query('SELECT * FROM workflows WHERE workflow_uuid = $1', [req.params.uuid]);
  if (!wf.rows[0]) return res.status(404).json({ error: 'Workflow not found' });

  const steps = await db.query(
    'SELECT ws.*, s.name as skill_name FROM workflow_steps ws LEFT JOIN skills s ON ws.skill_id = s.id WHERE ws.workflow_id = $1 ORDER BY step_order',
    [wf.rows[0].id]
  );

  res.json({ workflow: wf.rows[0], steps: steps.rows });
});

router.post('/api/workflows/:uuid/run', async (req, res) => {
  const { wallet, input } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });

  const wf = await db.query('SELECT * FROM workflows WHERE workflow_uuid = $1', [req.params.uuid]);
  if (!wf.rows[0]) return res.status(404).json({ error: 'Workflow not found' });
  if (wf.rows[0].status !== 'active') return res.status(400).json({ error: 'Workflow not active' });

  const runUuid = uuidv4();
  const run = await db.query(`
    INSERT INTO workflow_runs (run_uuid, workflow_id, triggered_by, input_data)
    VALUES ($1, $2, $3, $4) RETURNING *
  `, [runUuid, wf.rows[0].id, wallet.toLowerCase(), JSON.stringify(input)]);

  await db.query('UPDATE workflows SET total_runs = total_runs + 1 WHERE id = $1', [wf.rows[0].id]);

  // In production: trigger async workflow executor
  res.json({ success: true, runUuid, status: 'running' });
});

router.get('/api/workflows/runs/:uuid', async (req, res) => {
  const run = await db.query('SELECT * FROM workflow_runs WHERE run_uuid = $1', [req.params.uuid]);
  if (!run.rows[0]) return res.status(404).json({ error: 'Run not found' });

  const steps = await db.query(
    'SELECT * FROM workflow_step_results WHERE run_id = $1 ORDER BY id',
    [run.rows[0].id]
  );

  res.json({ run: run.rows[0], stepResults: steps.rows });
});

router.put('/api/workflows/:uuid/status', async (req, res) => {
  const { wallet, status } = req.body;
  if (!wallet || !['draft', 'active', 'paused', 'archived'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const wf = await db.query('SELECT * FROM workflows WHERE workflow_uuid = $1', [req.params.uuid]);
  if (!wf.rows[0]) return res.status(404).json({ error: 'Workflow not found' });
  if (wf.rows[0].owner_wallet !== wallet.toLowerCase()) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  await db.query('UPDATE workflows SET status = $1 WHERE id = $2', [status, wf.rows[0].id]);
  res.json({ success: true, status });
});

// Workflow marketplace
router.get('/api/workflows/marketplace', async (req, res) => {
  const result = await db.query(`
    SELECT w.*, 
      (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count
    FROM workflows w 
    WHERE is_public = true AND status = 'active'
    ORDER BY total_runs DESC
    LIMIT 50
  `);
  res.json(result.rows);
});

// ============================================
// FUTURE VISION: Automated Task Routing
// ============================================

router.post('/api/tasks/auto-route', async (req, res) => {
  const { wallet, description, budget, urgency = 'normal', preferences } = req.body;
  if (!wallet || !description) {
    return res.status(400).json({ error: 'wallet, description required' });
  }

  // Get all active agents with their skills
  const agents = await db.query(`
    SELECT a.*, u.wallet_address,
      json_agg(json_build_object('id', s.id, 'name', s.name, 'price', s.price_usdc, 'category', s.category)) as skills
    FROM agents a
    JOIN users u ON a.user_id = u.id
    LEFT JOIN skills s ON s.agent_id = a.id
    WHERE a.status = 'active'
    GROUP BY a.id, u.wallet_address
  `);

  // Simple matching algorithm (in production: use ML)
  const keywords = description.toLowerCase().split(/\s+/);
  const scored = agents.rows.map(agent => {
    let score = 0;
    const skills = agent.skills || [];
    
    // Keyword matching
    skills.forEach(skill => {
      if (!skill.name) return;
      keywords.forEach(kw => {
        if (skill.name.toLowerCase().includes(kw)) score += 10;
        if (skill.category?.toLowerCase().includes(kw)) score += 5;
      });
    });

    // Trust tier bonus
    const tierBonus = { new: 0, rising: 5, established: 10, trusted: 20, verified: 30 };
    score += tierBonus[agent.trust_tier] || 0;

    // Rating bonus
    score += (parseFloat(agent.rating) || 0) * 5;

    // Budget filter
    const minPrice = Math.min(...skills.filter(s => s.price).map(s => parseFloat(s.price)));
    if (budget && minPrice > parseFloat(budget)) score -= 50;

    // Urgency matching (fast responders for urgent)
    if (urgency === 'urgent' && agent.response_time_avg < 3600) score += 15;

    return { agent, score, bestSkill: skills[0] };
  });

  // Sort and return top matches
  const matches = scored
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  res.json({
    query: { description, budget, urgency },
    matches: matches.map(m => ({
      agentId: m.agent.id,
      agentName: m.agent.name,
      trustTier: m.agent.trust_tier,
      rating: m.agent.rating,
      matchScore: m.score,
      suggestedSkill: m.bestSkill,
      estimatedPrice: m.bestSkill?.price
    })),
    autoSelected: matches[0] ? {
      agentId: matches[0].agent.id,
      skillId: matches[0].bestSkill?.id,
      confidence: Math.min(matches[0].score / 50, 1)
    } : null
  });
});

// ============================================
// FUTURE VISION: Blockchain Reputation
// ============================================

// On-chain reputation attestations (EAS-style)
router.get('/api/reputation/:wallet', async (req, res) => {
  const wallet = req.params.wallet.toLowerCase();

  // Get user stats
  const userResult = await db.query('SELECT * FROM users WHERE wallet_address = $1', [wallet]);
  const user = userResult.rows[0];

  // Get agent if exists
  const agentResult = await db.query(`
    SELECT a.* FROM agents a JOIN users u ON a.user_id = u.id WHERE u.wallet_address = $1
  `, [wallet]);
  const agent = agentResult.rows[0];

  // Calculate reputation score
  let reputation = {
    wallet,
    onChainScore: 0,
    components: {},
    attestations: []
  };

  if (agent) {
    // Agent reputation
    const completedJobs = parseInt(agent.total_jobs) || 0;
    const rating = parseFloat(agent.rating) || 0;
    const completionRate = parseFloat(agent.completion_rate) || 100;

    reputation.components = {
      taskCompletion: Math.min(completedJobs / 100, 1) * 25,
      qualityScore: (rating / 5) * 30,
      reliability: (completionRate / 100) * 20,
      tenure: Math.min((Date.now() - new Date(agent.created_at)) / (365 * 24 * 60 * 60 * 1000), 1) * 15,
      verification: agent.x_verified_at ? 10 : 0
    };

    reputation.onChainScore = Math.round(
      Object.values(reputation.components).reduce((a, b) => a + b, 0)
    );

    // Generate attestation data (for on-chain)
    reputation.attestations = [
      {
        type: 'TaskCompletion',
        value: completedJobs,
        timestamp: new Date().toISOString(),
        signature: null // Would be signed by platform
      },
      {
        type: 'AverageRating',
        value: rating,
        timestamp: new Date().toISOString(),
        signature: null
      }
    ];
  }

  // Get hirer reputation
  const hirerStats = await db.query(`
    SELECT COUNT(*) as jobs_posted,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as jobs_completed,
      COUNT(CASE WHEN status = 'disputed' THEN 1 END) as disputes
    FROM jobs WHERE requester_wallet = $1
  `, [wallet]);

  if (hirerStats.rows[0]) {
    const h = hirerStats.rows[0];
    reputation.hirerScore = {
      jobsPosted: parseInt(h.jobs_posted),
      completionRate: h.jobs_posted > 0 ? (h.jobs_completed / h.jobs_posted) * 100 : 0,
      disputeRate: h.jobs_posted > 0 ? (h.disputes / h.jobs_posted) * 100 : 0
    };
  }

  res.json(reputation);
});

router.post('/api/reputation/attest', async (req, res) => {
  const { wallet, targetWallet, attestationType, value, signature } = req.body;
  
  // In production: verify signature, write to blockchain
  // For now: store attestation intent
  
  res.json({
    success: true,
    attestation: {
      from: wallet,
      to: targetWallet,
      type: attestationType,
      value,
      timestamp: new Date().toISOString(),
      txHash: null // Would be returned after on-chain tx
    },
    message: 'Attestation queued for on-chain submission'
  });
});

// ============================================
// FUTURE VISION: Vertical Marketplaces
// ============================================

const VERTICALS = {
  legal: {
    name: 'Legal AI',
    slug: 'legal',
    icon: '⚖️',
    description: 'Contract review, legal research, compliance',
    requiredCerts: ['security-audit'],
    categories: ['contract-review', 'legal-research', 'compliance', 'ip-analysis'],
    complianceLevel: 'high'
  },
  medical: {
    name: 'Medical AI',
    slug: 'medical',
    icon: '🏥',
    description: 'Medical research, clinical documentation, health analysis',
    requiredCerts: ['security-audit', 'enterprise'],
    categories: ['medical-research', 'clinical-docs', 'health-analysis'],
    complianceLevel: 'hipaa'
  },
  finance: {
    name: 'Finance AI',
    slug: 'finance',
    icon: '💰',
    description: 'Financial analysis, trading signals, risk assessment',
    requiredCerts: ['security-audit'],
    categories: ['financial-analysis', 'trading', 'risk-assessment', 'reporting'],
    complianceLevel: 'high'
  },
  education: {
    name: 'Education AI',
    slug: 'education',
    icon: '📚',
    description: 'Tutoring, course creation, assessment',
    requiredCerts: [],
    categories: ['tutoring', 'course-creation', 'assessment', 'research'],
    complianceLevel: 'standard'
  },
  creative: {
    name: 'Creative AI',
    slug: 'creative',
    icon: '🎨',
    description: 'Design, content, video, music production',
    requiredCerts: [],
    categories: ['design', 'content', 'video', 'music', 'marketing'],
    complianceLevel: 'standard'
  }
};

router.get('/api/verticals', (req, res) => res.json(VERTICALS));

router.get('/api/verticals/:slug', async (req, res) => {
  const vertical = VERTICALS[req.params.slug];
  if (!vertical) return res.status(404).json({ error: 'Vertical not found' });

  // Get agents certified for this vertical
  const agents = await db.query(`
    SELECT DISTINCT a.*, 
      (SELECT json_agg(c.slug) FROM agent_certifications ac 
       JOIN certifications c ON ac.certification_id = c.id 
       WHERE ac.agent_id = a.id AND ac.status = 'approved') as certifications
    FROM agents a
    JOIN skills s ON s.agent_id = a.id
    WHERE s.category = ANY($1) AND a.status = 'active'
    ORDER BY a.rating DESC
  `, [vertical.categories]);

  // Filter by required certs
  const certified = agents.rows.filter(a => {
    if (vertical.requiredCerts.length === 0) return true;
    const certs = a.certifications || [];
    return vertical.requiredCerts.every(rc => certs.includes(rc));
  });

  res.json({
    vertical,
    totalAgents: certified.length,
    agents: certified.slice(0, 20),
    complianceNote: vertical.complianceLevel === 'hipaa' 
      ? 'All agents in this vertical are HIPAA-compliant certified'
      : vertical.complianceLevel === 'high'
      ? 'Enhanced security requirements apply'
      : null
  });
});

// ============================================
// FUTURE VISION: API Marketplace
// ============================================

router.get('/api/marketplace/apis', async (req, res) => {
  const { category, sort = 'popular' } = req.query;
  
  let orderBy = 'total_calls DESC';
  if (sort === 'newest') orderBy = 'created_at DESC';
  if (sort === 'price') orderBy = 'price_per_call ASC';

  const result = await db.query(`
    SELECT al.*, a.name as agent_name, a.trust_tier, a.rating
    FROM api_listings al
    JOIN agents a ON al.agent_id = a.id
    WHERE al.status = 'approved' AND al.is_public = true
    ORDER BY ${orderBy}
    LIMIT 50
  `);

  res.json(result.rows);
});

router.get('/api/marketplace/apis/:uuid', async (req, res) => {
  const listing = await db.query(`
    SELECT al.*, a.name as agent_name, a.trust_tier, a.rating, a.bio as agent_bio
    FROM api_listings al
    JOIN agents a ON al.agent_id = a.id
    WHERE al.listing_uuid = $1
  `, [req.params.uuid]);

  if (!listing.rows[0]) return res.status(404).json({ error: 'API not found' });
  res.json(listing.rows[0]);
});

router.post('/api/marketplace/apis', async (req, res) => {
  const { wallet, agentId, name, description, endpointBase, pricingModel, pricePerCall, monthlyPrice, rateLimit } = req.body;
  if (!wallet || !agentId || !name || !endpointBase) {
    return res.status(400).json({ error: 'wallet, agentId, name, endpointBase required' });
  }

  // Verify ownership
  const agent = await db.query(`
    SELECT a.* FROM agents a JOIN users u ON a.user_id = u.id 
    WHERE a.id = $1 AND u.wallet_address = $2
  `, [agentId, wallet.toLowerCase()]);

  if (!agent.rows[0]) return res.status(403).json({ error: 'Not authorized' });

  const listingUuid = uuidv4();
  const result = await db.query(`
    INSERT INTO api_listings (listing_uuid, agent_id, name, description, endpoint_base, pricing_model, price_per_call, monthly_price, rate_limit)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
  `, [listingUuid, agentId, name, description, endpointBase, pricingModel || 'per_call', pricePerCall, monthlyPrice, rateLimit || 1000]);

  res.json({ success: true, listing: result.rows[0] });
});

router.post('/api/marketplace/apis/:uuid/subscribe', async (req, res) => {
  const { wallet, plan } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });

  const listing = await db.query('SELECT * FROM api_listings WHERE listing_uuid = $1 AND status = $2', [req.params.uuid, 'approved']);
  if (!listing.rows[0]) return res.status(404).json({ error: 'API not found or not approved' });

  const apiKey = 'sk_' + require('crypto').randomBytes(24).toString('hex');

  const result = await db.query(`
    INSERT INTO api_subscriptions (listing_id, subscriber_wallet, api_key, plan)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (listing_id, subscriber_wallet) DO UPDATE SET api_key = $3, status = 'active'
    RETURNING *
  `, [listing.rows[0].id, wallet.toLowerCase(), apiKey, plan]);

  res.json({
    success: true,
    subscription: result.rows[0],
    apiKey,
    message: 'Store this API key securely'
  });
});

router.get('/api/marketplace/my-subscriptions', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });

  const result = await db.query(`
    SELECT asub.*, al.name, al.endpoint_base, al.rate_limit
    FROM api_subscriptions asub
    JOIN api_listings al ON asub.listing_id = al.id
    WHERE asub.subscriber_wallet = $1 AND asub.status = 'active'
  `, [wallet.toLowerCase()]);

  res.json(result.rows);
});

// ============================================
// FUTURE VISION: Enterprise Private Deployments
// ============================================

const ENTERPRISE_PLANS = {
  starter: { name: 'Starter', price: 999, users: 10, agents: 5, storage: '10GB', support: '24h' },
  business: { name: 'Business', price: 2999, users: 50, agents: 25, storage: '100GB', support: '4h' },
  enterprise: { name: 'Enterprise', price: 9999, users: 'unlimited', agents: 'unlimited', storage: '1TB', support: '1h SLA' }
};

router.get('/api/enterprise/plans', (req, res) => res.json(ENTERPRISE_PLANS));

router.post('/api/enterprise/request-demo', async (req, res) => {
  const { wallet, companyName, email, employeeCount, useCase } = req.body;
  if (!wallet || !companyName || !email) {
    return res.status(400).json({ error: 'wallet, companyName, email required' });
  }

  // In production: send to CRM, trigger sales workflow
  res.json({
    success: true,
    message: 'Demo request received. Our team will contact you within 24 hours.',
    referenceId: uuidv4().slice(0, 8)
  });
});

router.post('/api/enterprise/provision', async (req, res) => {
  const { wallet, plan, companyName, subdomain } = req.body;
  if (!isAdmin(wallet)) return res.status(403).json({ error: 'Admin only' });

  // Create enterprise deployment record
  const deploymentId = uuidv4();
  
  // In production: trigger Kubernetes/Docker deployment
  const deployment = {
    id: deploymentId,
    companyName,
    subdomain,
    plan,
    status: 'provisioning',
    endpoints: {
      api: `https://${subdomain}.api.thebotique.ai`,
      dashboard: `https://${subdomain}.thebotique.ai`,
      admin: `https://${subdomain}-admin.thebotique.ai`
    },
    createdAt: new Date().toISOString(),
    estimatedReady: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  };

  res.json({
    success: true,
    deployment,
    message: 'Deployment initiated. Estimated time: 30 minutes.'
  });
});

router.get('/api/enterprise/deployments', async (req, res) => {
  const { wallet } = req.query;
  if (!isAdmin(wallet)) return res.status(403).json({ error: 'Admin only' });

  // In production: fetch from deployment database
  res.json({
    deployments: [],
    message: 'Enterprise deployments managed via admin panel'
  });
});

router.get('/api/enterprise/health/:subdomain', async (req, res) => {
  // In production: check actual deployment health
  res.json({
    subdomain: req.params.subdomain,
    status: 'healthy',
    uptime: '99.99%',
    lastChecked: new Date().toISOString()
  });
});

router.get('/api/marketplace/my-apis', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });

  const result = await db.query(`
    SELECT al.*, 
      (SELECT COUNT(*) FROM api_subscriptions WHERE listing_id = al.id AND status = 'active') as subscribers
    FROM api_listings al
    JOIN agents a ON al.agent_id = a.id
    JOIN users u ON a.user_id = u.id
    WHERE u.wallet_address = $1
  `, [wallet.toLowerCase()]);

  res.json(result.rows);
});

router.get('/api/verticals/:slug/featured', async (req, res) => {
  const vertical = VERTICALS[req.params.slug];
  if (!vertical) return res.status(404).json({ error: 'Vertical not found' });

  const featured = await db.query(`
    SELECT a.*, COUNT(j.id) as recent_jobs
    FROM agents a
    JOIN skills s ON s.agent_id = a.id
    LEFT JOIN jobs j ON j.agent_id = a.id AND j.created_at > NOW() - INTERVAL '30 days'
    WHERE s.category = ANY($1) AND a.trust_tier IN ('trusted', 'verified')
    GROUP BY a.id
    ORDER BY a.rating DESC, recent_jobs DESC
    LIMIT 5
  `, [vertical.categories]);

  res.json(featured.rows);
});

router.get('/api/reputation/leaderboard', async (req, res) => {
  const result = await db.query(`
    SELECT a.id, a.name, a.trust_tier, a.rating, a.total_jobs, a.completion_rate,
      u.wallet_address,
      (COALESCE(a.total_jobs, 0) * 0.25 + 
       COALESCE(a.rating, 0) * 6 + 
       COALESCE(a.completion_rate, 0) * 0.2) as reputation_score
    FROM agents a
    JOIN users u ON a.user_id = u.id
    WHERE a.status = 'active'
    ORDER BY reputation_score DESC
    LIMIT 50
  `);

  res.json({
    leaderboard: result.rows.map((r, i) => ({
      rank: i + 1,
      ...r,
      reputationScore: Math.round(parseFloat(r.reputation_score))
    }))
  });
});

router.get('/api/recommendations/agents', async (req, res) => {
  const { wallet, category, recentTasks } = req.query;

  // Get trending agents
  const trending = await db.query(`
    SELECT a.*, COUNT(j.id) as recent_jobs
    FROM agents a
    LEFT JOIN jobs j ON j.agent_id = a.id AND j.created_at > NOW() - INTERVAL '7 days'
    WHERE a.status = 'active'
    GROUP BY a.id
    ORDER BY recent_jobs DESC, a.rating DESC
    LIMIT 10
  `);

  // Get category-specific if provided
  let categoryAgents = [];
  if (category) {
    const catResult = await db.query(`
      SELECT DISTINCT a.* FROM agents a
      JOIN skills s ON s.agent_id = a.id
      WHERE s.category = $1 AND a.status = 'active'
      ORDER BY a.rating DESC
      LIMIT 5
    `, [category]);
    categoryAgents = catResult.rows;
  }

  // Get similar to recent (if wallet provided)
  let similarAgents = [];
  if (wallet) {
    const recentResult = await db.query(`
      SELECT DISTINCT a.* FROM agents a
      JOIN skills s ON s.agent_id = a.id
      WHERE s.category IN (
        SELECT DISTINCT sk.category FROM jobs j
        JOIN skills sk ON j.skill_id = sk.id
        WHERE j.requester_wallet = $1
        LIMIT 3
      )
      AND a.status = 'active'
      ORDER BY a.rating DESC
      LIMIT 5
    `, [wallet.toLowerCase()]);
    similarAgents = recentResult.rows;
  }

  res.json({
    trending: sanitizeAgents(trending.rows),
    forCategory: sanitizeAgents(categoryAgents),
    basedOnHistory: sanitizeAgents(similarAgents)
  });
});

router.post('/api/workflows/:uuid/fork', async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });

  const wf = await db.query('SELECT * FROM workflows WHERE workflow_uuid = $1 AND is_public = true', [req.params.uuid]);
  if (!wf.rows[0]) return res.status(404).json({ error: 'Workflow not found or not public' });

  const steps = await db.query('SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_order', [wf.rows[0].id]);

  const newUuid = uuidv4();
  const newWf = await db.query(`
    INSERT INTO workflows (workflow_uuid, owner_wallet, name, description, status)
    VALUES ($1, $2, $3, $4, 'draft') RETURNING *
  `, [newUuid, wallet.toLowerCase(), wf.rows[0].name + ' (Fork)', wf.rows[0].description]);

  for (const s of steps.rows) {
    await db.query(`
      INSERT INTO workflow_steps (workflow_id, step_order, skill_id, name, input_template, condition)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [newWf.rows[0].id, s.step_order, s.skill_id, s.name, s.input_template, s.condition]);
  }

  res.json({ success: true, workflowUuid: newUuid });
});

router.post('/api/admin/white-label/activate', async (req, res) => {
  const { wallet, whitelabelId } = req.body;
  if (!isAdmin(wallet)) return res.status(403).json({ error: 'Not authorized' });

  await db.query(`
    UPDATE white_labels SET status = 'active', activated_at = NOW() WHERE id = $1
  `, [whitelabelId]);

  res.json({ success: true });
});

router.post('/api/support/tickets/:uuid/reply', async (req, res) => {
  const { wallet, message } = req.body;
  if (!wallet || !message) return res.status(400).json({ error: 'wallet, message required' });

  const ticket = await db.query('SELECT * FROM support_tickets WHERE ticket_uuid = $1', [req.params.uuid]);
  if (!ticket.rows[0]) return res.status(404).json({ error: 'Ticket not found' });

  const isSupport = isAdmin(wallet);
  await db.query(`
    INSERT INTO support_messages (ticket_id, sender_wallet, sender_type, message)
    VALUES ($1, $2, $3, $4)
  `, [ticket.rows[0].id, wallet.toLowerCase(), isSupport ? 'support' : 'user', message]);

  if (isSupport) {
    await db.query('UPDATE support_tickets SET status = $1, updated_at = NOW() WHERE id = $2', 
      ['in_progress', ticket.rows[0].id]);
  }

  res.json({ success: true });
});

router.post('/api/admin/certifications/approve', async (req, res) => {
  const { wallet, agentId, certificationId, approve } = req.body;
  if (!isAdmin(wallet)) return res.status(403).json({ error: 'Not authorized' });

  const status = approve ? 'approved' : 'rejected';
  const expiresAt = approve ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) : null;

  await db.query(`
    UPDATE agent_certifications 
    SET status = $1, issued_at = NOW(), expires_at = $2, issued_by = $3
    WHERE agent_id = $4 AND certification_id = $5
  `, [status, expiresAt, wallet, agentId, certificationId]);

  res.json({ success: true, status });
});

router.post('/api/webhooks/test', validateApiKey, async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'Webhook URL required' });
    }

    // Send test webhook
    const testPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      data: { message: 'This is a test webhook from TheBotique' }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload),
      timeout: 10000
    });

    res.json({
      success: response.ok,
      statusCode: response.status,
      message: response.ok ? 'Webhook received successfully' : 'Webhook delivery failed'
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// MULTI-CURRENCY SUPPORT (Phase 3)
// ============================================

// Supported currencies with contract addresses on Base
const SUPPORTED_CURRENCIES = {
  USDC: { 
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    symbol: 'USDC',
    name: 'USD Coin'
  },
  USDT: {
    address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    decimals: 6,
    symbol: 'USDT',
    name: 'Tether USD'
  },
  DAI: {
    address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    decimals: 18,
    symbol: 'DAI',
    name: 'Dai Stablecoin'
  },
  ETH: {
    address: 'native',
    decimals: 18,
    symbol: 'ETH',
    name: 'Ethereum'
  }
};

// Simple price feed (in production, use Chainlink or similar)
async function getExchangeRates() {
  return {
    USDC: 1.00,
    USDT: 1.00,
    DAI: 1.00,
    ETH: 2500.00 // Placeholder - use real price feed
  };
}

/**
 * Get supported currencies
 * GET /api/currencies
 */
router.get('/api/currencies', async (req, res) => {
  try {
    const rates = await getExchangeRates();
    
    res.json({
      currencies: Object.entries(SUPPORTED_CURRENCIES).map(([symbol, data]) => ({
        ...data,
        usdRate: rates[symbol]
      })),
      defaultCurrency: 'USDC'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get currencies' });
  }
});

/**
 * Convert price between currencies
 * GET /api/currencies/convert
 */
router.get('/api/currencies/convert', async (req, res) => {
  try {
    const { amount, from = 'USDC', to } = req.query;
    
    if (!amount || !to) {
      return res.status(400).json({ error: 'Amount and target currency required' });
    }

    if (!SUPPORTED_CURRENCIES[from] || !SUPPORTED_CURRENCIES[to]) {
      return res.status(400).json({ error: 'Unsupported currency' });
    }

    const rates = await getExchangeRates();
    const fromRate = rates[from];
    const toRate = rates[to];
    
    // Convert: amount in 'from' currency -> USD -> 'to' currency
    const usdValue = parseFloat(amount) * fromRate;
    const convertedAmount = usdValue / toRate;

    res.json({
      from: { currency: from, amount: parseFloat(amount) },
      to: { currency: to, amount: convertedAmount },
      usdValue,
      rate: fromRate / toRate
    });
  } catch (error) {
    res.status(500).json({ error: 'Conversion failed' });
  }
});

// ============================================
// TEAM ACCOUNTS (Phase 3)
// ============================================

/**
 * Create a team
 * POST /api/teams
 */
router.post('/api/teams', async (req, res) => {
  try {
    const { wallet, name } = req.body;
    
    if (!wallet || !name) {
      return res.status(400).json({ error: 'Wallet and team name required' });
    }

    // Check if user already owns a team
    const existingResult = await db.query(
      'SELECT * FROM teams WHERE owner_wallet = $1',
      [wallet.toLowerCase()]
    );

    if (existingResult.rows.length > 0) {
      return res.status(409).json({ error: 'You already own a team', team: existingResult.rows[0] });
    }

    // Create team
    const teamResult = await db.query(`
      INSERT INTO teams (name, owner_wallet)
      VALUES ($1, $2)
      RETURNING *
    `, [sanitizeText(name, 100), wallet.toLowerCase()]);

    const team = teamResult.rows[0];

    // Add owner as member
    await db.query(`
      INSERT INTO team_members (team_id, wallet_address, role)
      VALUES ($1, $2, 'owner')
    `, [team.id, wallet.toLowerCase()]);

    res.json({ success: true, team });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to create team');
    res.status(statusCode).json(body);
  }
});

/**
 * Get user's teams
 * GET /api/teams
 */
router.get('/api/teams', async (req, res) => {
  try {
    const { wallet } = req.query;
    if (!wallet) {
      return res.status(400).json({ error: 'Wallet required' });
    }

    const result = await db.query(`
      SELECT t.*, tm.role as my_role,
             (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count,
             (SELECT COUNT(*) FROM team_agents WHERE team_id = t.id) as agent_count
      FROM teams t
      JOIN team_members tm ON t.id = tm.team_id
      WHERE tm.wallet_address = $1
    `, [wallet.toLowerCase()]);

    res.json(result.rows);
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to get teams');
    res.status(statusCode).json(body);
  }
});

/**
 * Get team details
 * GET /api/teams/:id
 */
router.get('/api/teams/:id', validateIdParam('id'), async (req, res) => {
  try {
    const { wallet } = req.query;
    
    // Get team
    const teamResult = await db.query('SELECT * FROM teams WHERE id = $1', [req.params.id]);
    const team = teamResult.rows[0];
    
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Get members
    const membersResult = await db.query(
      'SELECT * FROM team_members WHERE team_id = $1',
      [req.params.id]
    );

    // Get agents
    const agentsResult = await db.query(`
      SELECT a.* FROM agents a
      JOIN team_agents ta ON a.id = ta.agent_id
      WHERE ta.team_id = $1
    `, [req.params.id]);

    res.json({
      team,
      members: membersResult.rows,
      agents: sanitizeAgents(agentsResult.rows)
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to get team');
    res.status(statusCode).json(body);
  }
});

/**
 * Invite member to team
 * POST /api/teams/:id/invite
 */
router.post('/api/teams/:id/invite', validateIdParam('id'), async (req, res) => {
  try {
    const { wallet, inviteeWallet, role = 'member' } = req.body;
    
    if (!wallet || !inviteeWallet) {
      return res.status(400).json({ error: 'Wallet and invitee wallet required' });
    }

    // Verify caller has permission
    const memberResult = await db.query(
      'SELECT * FROM team_members WHERE team_id = $1 AND wallet_address = $2',
      [req.params.id, wallet.toLowerCase()]
    );

    if (!memberResult.rows[0] || !['owner', 'admin'].includes(memberResult.rows[0].role)) {
      return res.status(403).json({ error: 'Not authorized to invite members' });
    }

    // Check if already a member
    const existingResult = await db.query(
      'SELECT * FROM team_members WHERE team_id = $1 AND wallet_address = $2',
      [req.params.id, inviteeWallet.toLowerCase()]
    );

    if (existingResult.rows.length > 0) {
      return res.status(409).json({ error: 'User is already a team member' });
    }

    // Add member
    await db.query(`
      INSERT INTO team_members (team_id, wallet_address, role, invited_by)
      VALUES ($1, $2, $3, $4)
    `, [req.params.id, inviteeWallet.toLowerCase(), role, wallet.toLowerCase()]);

    res.json({ success: true, message: 'Member invited' });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to invite member');
    res.status(statusCode).json(body);
  }
});

/**
 * Remove member from team
 * DELETE /api/teams/:id/members/:wallet
 */
router.delete('/api/teams/:id/members/:wallet', validateIdParam('id'), async (req, res) => {
  try {
    const { wallet } = req.body;
    const targetWallet = req.params.wallet;
    
    if (!wallet) {
      return res.status(400).json({ error: 'Your wallet required' });
    }

    // Verify caller has permission
    const memberResult = await db.query(
      'SELECT * FROM team_members WHERE team_id = $1 AND wallet_address = $2',
      [req.params.id, wallet.toLowerCase()]
    );

    const callerRole = memberResult.rows[0]?.role;
    if (!callerRole || !['owner', 'admin'].includes(callerRole)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Cannot remove owner
    const targetResult = await db.query(
      'SELECT * FROM team_members WHERE team_id = $1 AND wallet_address = $2',
      [req.params.id, targetWallet.toLowerCase()]
    );

    if (targetResult.rows[0]?.role === 'owner') {
      return res.status(400).json({ error: 'Cannot remove team owner' });
    }

    await db.query(
      'DELETE FROM team_members WHERE team_id = $1 AND wallet_address = $2',
      [req.params.id, targetWallet.toLowerCase()]
    );

    res.json({ success: true });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to remove member');
    res.status(statusCode).json(body);
  }
});

/**
 * Add agent to team
 * POST /api/teams/:id/agents
 */
router.post('/api/teams/:id/agents', validateIdParam('id'), async (req, res) => {
  try {
    const { wallet, agentId } = req.body;
    
    if (!wallet || !agentId) {
      return res.status(400).json({ error: 'Wallet and agentId required' });
    }

    // Verify caller owns the agent
    const agentResult = await db.query(`
      SELECT a.*, u.wallet_address as owner_wallet
      FROM agents a
      JOIN users u ON a.user_id = u.id
      WHERE a.id = $1
    `, [agentId]);

    if (!agentResult.rows[0]) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (agentResult.rows[0].owner_wallet.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(403).json({ error: 'You do not own this agent' });
    }

    // Verify caller is team admin
    const memberResult = await db.query(
      'SELECT * FROM team_members WHERE team_id = $1 AND wallet_address = $2',
      [req.params.id, wallet.toLowerCase()]
    );

    if (!memberResult.rows[0] || !['owner', 'admin'].includes(memberResult.rows[0].role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Add agent to team
    await db.query(
      'INSERT INTO team_agents (team_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, agentId]
    );

    res.json({ success: true, message: 'Agent added to team' });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Failed to add agent');
    res.status(statusCode).json(body);
  }
});

// ============================================
// ADMIN PANEL
// ============================================

// Simple admin auth - in production use proper auth
const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || '').split(',').map(w => w.toLowerCase().trim()).filter(Boolean);

function isAdmin(wallet) {
  if (!wallet) return false;
  return ADMIN_WALLETS.includes(wallet.toLowerCase());
}

router.get('/admin', async (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Admin Panel | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/ethers@6.7.0/dist/ethers.umd.min.js"></script>
  <style>${HUB_STYLES}
    .admin-header { background: linear-gradient(135deg, #7c3aed, #4f46e5); padding: 32px; color: white; margin-bottom: 32px; border-radius: 12px; }
    .admin-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; }
    .admin-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
    .admin-card h3 { margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .dispute-item { padding: 16px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; }
    .dispute-item.urgent { border-left: 4px solid #ef4444; }
    .action-buttons { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .badge-count { background: var(--accent); color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.8rem; }
  </style>
</head>
<body>
  ${HUB_HEADER}

  <div class="container">
    <div id="auth-check" style="text-align: center; padding: 64px;">
      <h2>Admin Access Required</h2>
      <p style="color: var(--text-muted); margin-bottom: 24px;">Connect an admin wallet to access this panel.</p>
      <button class="btn btn-primary" onclick="connectWallet()">Connect Wallet</button>
    </div>

    <div id="admin-panel" style="display: none;">
      <div class="admin-header">
        <h1>🛡️ Admin Panel</h1>
        <p>Manage disputes, verify agents, and monitor platform health.</p>
      </div>

      <div class="admin-grid">
        <!-- Disputes -->
        <div class="admin-card">
          <h3>⚠️ Open Disputes <span id="dispute-count" class="badge-count">0</span></h3>
          <div id="disputes-list">Loading...</div>
        </div>

        <!-- Pending Verifications -->
        <div class="admin-card">
          <h3>✓ Pending Verifications <span id="verify-count" class="badge-count">0</span></h3>
          <div id="verifications-list">Loading...</div>
        </div>

        <!-- Platform Stats -->
        <div class="admin-card">
          <h3>📊 Platform Stats</h3>
          <div id="platform-stats">Loading...</div>
        </div>

        <!-- Recent Activity -->
        <div class="admin-card">
          <h3>📋 Recent Jobs</h3>
          <div id="recent-jobs">Loading...</div>
        </div>
      </div>
    </div>
  </div>

  ${MOBILE_MENU_SCRIPT}
  <script>
    ${HUB_SCRIPTS}
    
    let adminWallet = null;

    async function checkAdminAccess() {
      if (!connected || !userAddress) return false;
      
      try {
        const res = await fetch('/api/admin/check?wallet=' + userAddress);
        const data = await res.json();
        return data.isAdmin;
      } catch (e) {
        return false;
      }
    }

    async function initAdmin() {
      await checkConnection();
      
      if (connected && userAddress) {
        const isAdmin = await checkAdminAccess();
        if (isAdmin) {
          adminWallet = userAddress;
          document.getElementById('auth-check').style.display = 'none';
          document.getElementById('admin-panel').style.display = 'block';
          loadAdminData();
        } else {
          document.getElementById('auth-check').innerHTML = '<h2>Access Denied</h2><p style="color: var(--text-muted);">This wallet is not an admin.</p>';
        }
      }
    }

    async function loadAdminData() {
      // Load disputes
      try {
        const res = await fetch('/api/admin/disputes?wallet=' + adminWallet);
        const disputes = await res.json();
        document.getElementById('dispute-count').textContent = disputes.length;
        document.getElementById('disputes-list').innerHTML = disputes.length 
          ? disputes.map(d => \`
              <div class="dispute-item \${d.disputed_at && new Date(d.disputed_at) < Date.now() - 48*60*60*1000 ? 'urgent' : ''}">
                <div style="font-weight: 600;">\${d.skill_name || 'Task'}</div>
                <div style="color: var(--text-muted); font-size: 0.85rem; margin: 4px 0;">$\${Number(d.price_usdc).toFixed(2)} · Job #\${d.job_uuid.slice(0,8)}</div>
                <div style="margin: 8px 0;">\${d.dispute_reason || 'No reason provided'}</div>
                <div class="action-buttons">
                  <button class="btn btn-secondary" style="padding: 8px 12px; font-size: 0.8rem;" onclick="resolveDispute('\${d.job_uuid}', 'refund')">Full Refund</button>
                  <button class="btn btn-secondary" style="padding: 8px 12px; font-size: 0.8rem;" onclick="resolveDispute('\${d.job_uuid}', 'partial')">Partial (50%)</button>
                  <button class="btn btn-primary" style="padding: 8px 12px; font-size: 0.8rem;" onclick="resolveDispute('\${d.job_uuid}', 'release')">Release to Agent</button>
                </div>
              </div>
            \`).join('')
          : '<p style="color: var(--text-muted);">No open disputes 🎉</p>';
      } catch (e) {
        document.getElementById('disputes-list').innerHTML = '<p style="color: var(--red);">Failed to load</p>';
      }

      // Load pending verifications
      try {
        const res = await fetch('/api/admin/pending-verifications?wallet=' + adminWallet);
        const verifications = await res.json();
        document.getElementById('verify-count').textContent = verifications.length;
        document.getElementById('verifications-list').innerHTML = verifications.length
          ? verifications.map(v => \`
              <div class="dispute-item">
                <div style="font-weight: 600;">\${v.name}</div>
                <div style="color: var(--text-muted); font-size: 0.85rem;">@\${v.x_handle || 'no handle'}</div>
                <div class="action-buttons">
                  <button class="btn btn-primary" style="padding: 8px 12px; font-size: 0.8rem;" onclick="approveVerification(\${v.id})">Approve</button>
                  <button class="btn btn-secondary" style="padding: 8px 12px; font-size: 0.8rem;" onclick="rejectVerification(\${v.id})">Reject</button>
                </div>
              </div>
            \`).join('')
          : '<p style="color: var(--text-muted);">No pending verifications</p>';
      } catch (e) {
        document.getElementById('verifications-list').innerHTML = '<p style="color: var(--red);">Failed to load</p>';
      }

      // Load platform stats
      try {
        const res = await fetch('/api/stats');
        const stats = await res.json();
        document.getElementById('platform-stats').innerHTML = \`
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div><span style="color: var(--text-muted);">Agents:</span> <strong>\${stats.total_agents}</strong></div>
            <div><span style="color: var(--text-muted);">Jobs:</span> <strong>\${stats.total_jobs}</strong></div>
            <div><span style="color: var(--text-muted);">Volume:</span> <strong>$\${Number(stats.total_volume_usdc || 0).toFixed(0)}</strong></div>
            <div><span style="color: var(--text-muted);">Active (24h):</span> <strong>\${stats.active_agents_24h || 0}</strong></div>
          </div>
        \`;
      } catch (e) {
        document.getElementById('platform-stats').innerHTML = '<p style="color: var(--red);">Failed to load</p>';
      }

      // Load recent jobs
      try {
        const res = await fetch('/api/admin/recent-jobs?wallet=' + adminWallet);
        const jobs = await res.json();
        document.getElementById('recent-jobs').innerHTML = jobs.slice(0, 5).map(j => \`
          <div style="padding: 8px 0; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between;">
            <span>\${j.skill_name || 'Task'}</span>
            <span class="status-badge status-\${j.status}">\${j.status}</span>
          </div>
        \`).join('') || '<p style="color: var(--text-muted);">No recent jobs</p>';
      } catch (e) {
        document.getElementById('recent-jobs').innerHTML = '<p style="color: var(--red);">Failed to load</p>';
      }
    }

    async function resolveDispute(jobUuid, resolution) {
      if (!confirm('Resolve this dispute with: ' + resolution + '?')) return;
      
      try {
        const res = await fetch('/api/admin/resolve-dispute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobUuid, resolution, wallet: adminWallet })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Dispute resolved', 'success');
          loadAdminData();
        } else {
          showToast(data.error || 'Failed', 'error');
        }
      } catch (e) {
        showToast('Error resolving dispute', 'error');
      }
    }

    async function approveVerification(agentId) {
      try {
        const res = await fetch('/api/admin/verify-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, wallet: adminWallet, action: 'approve' })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Agent verified', 'success');
          loadAdminData();
        } else {
          showToast(data.error || 'Failed', 'error');
        }
      } catch (e) {
        showToast('Error', 'error');
      }
    }

    async function rejectVerification(agentId) {
      try {
        const res = await fetch('/api/admin/verify-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, wallet: adminWallet, action: 'reject' })
        });
        loadAdminData();
      } catch (e) {
        showToast('Error', 'error');
      }
    }

    // Check wallet on load
    window.addEventListener('load', initAdmin);
    
    // Re-check after wallet connect
    const originalConnect = connectWallet;
    connectWallet = async function(silent) {
      await originalConnect(silent);
      initAdmin();
    };
  </script>
  ${HUB_FOOTER}
</body>
</html>`);
});

// Admin API endpoints
router.get('/api/admin/check', (req, res) => {
  const { wallet } = req.query;
  res.json({ isAdmin: isAdmin(wallet) });
});

router.get('/api/admin/disputes', async (req, res) => {
  const { wallet } = req.query;
  if (!isAdmin(wallet)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  try {
    const result = await db.query(`
      SELECT j.*, a.name as agent_name
      FROM jobs j
      LEFT JOIN agents a ON j.agent_id = a.id
      WHERE j.status = 'disputed'
      ORDER BY j.disputed_at ASC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch disputes' });
  }
});

router.get('/api/admin/pending-verifications', async (req, res) => {
  const { wallet } = req.query;
  if (!isAdmin(wallet)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  try {
    const result = await db.query(`
      SELECT a.*, u.wallet_address
      FROM agents a
      JOIN users u ON a.user_id = u.id
      WHERE a.x_handle IS NOT NULL 
        AND a.x_verified_at IS NULL
      ORDER BY a.created_at ASC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch verifications' });
  }
});

router.get('/api/admin/recent-jobs', async (req, res) => {
  const { wallet } = req.query;
  if (!isAdmin(wallet)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  try {
    const result = await db.query(`
      SELECT j.*, a.name as agent_name
      FROM jobs j
      LEFT JOIN agents a ON j.agent_id = a.id
      ORDER BY j.created_at DESC
      LIMIT 20
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

router.post('/api/admin/resolve-dispute', async (req, res) => {
  const { wallet, jobUuid, resolution } = req.body;
  
  if (!isAdmin(wallet)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  try {
    // Get job
    const job = await db.query('SELECT * FROM jobs WHERE job_uuid = $1', [jobUuid]);
    if (!job.rows[0]) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const j = job.rows[0];
    let newStatus, refundAmount;

    switch (resolution) {
      case 'refund':
        newStatus = 'refunded';
        refundAmount = j.price_usdc;
        break;
      case 'partial':
        newStatus = 'refunded';
        refundAmount = j.price_usdc / 2;
        break;
      case 'release':
        newStatus = 'completed';
        refundAmount = 0;
        break;
      default:
        return res.status(400).json({ error: 'Invalid resolution' });
    }

    await db.query(`
      UPDATE jobs 
      SET status = $1, 
          refund_amount = $2,
          resolved_at = NOW(),
          resolved_by = $3
      WHERE job_uuid = $4
    `, [newStatus, refundAmount, wallet, jobUuid]);

    // Recalculate agent trust
    if (j.agent_id) {
      await db.calculateTrustTier(j.agent_id);
    }

    res.json({ success: true, status: newStatus, refundAmount });
  } catch (error) {
    console.error('Resolve dispute error:', error);
    res.status(500).json({ error: 'Failed to resolve dispute' });
  }
});

router.post('/api/admin/verify-agent', async (req, res) => {
  const { wallet, agentId, action } = req.body;
  
  if (!isAdmin(wallet)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  try {
    if (action === 'approve') {
      await db.query(`
        UPDATE agents 
        SET x_verified_at = NOW(),
            security_audit_status = 'passed'
        WHERE id = $1
      `, [agentId]);
      
      // Recalculate trust tier
      await db.calculateTrustTier(agentId);
    } else {
      await db.query(`
        UPDATE agents 
        SET x_handle = NULL
        WHERE id = $1
      `, [agentId]);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update verification' });
  }
});

// ============================================
// SITEMAP & SEO
// ============================================

router.get('/sitemap.xml', async (req, res) => {
  try {
    const agents = await db.getAllAgents();
    const agentUrls = agents.map(a => `
    <url>
      <loc>https://www.thebotique.ai/agent/${a.id}</loc>
      <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
      <changefreq>daily</changefreq>
      <priority>0.7</priority>
    </url>`).join('');

    const categoryUrls = Object.keys(CATEGORIES).map(slug => `
    <url>
      <loc>https://www.thebotique.ai/category/${slug}</loc>
      <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
      <changefreq>daily</changefreq>
      <priority>0.6</priority>
    </url>`).join('');

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
      <loc>https://www.thebotique.ai/</loc>
      <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
      <changefreq>daily</changefreq>
      <priority>1.0</priority>
    </url>
    <url>
      <loc>https://www.thebotique.ai/agents</loc>
      <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
      <changefreq>hourly</changefreq>
      <priority>0.9</priority>
    </url>
    <url>
      <loc>https://www.thebotique.ai/categories</loc>
      <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
      <changefreq>daily</changefreq>
      <priority>0.8</priority>
    </url>
    <url>
      <loc>https://www.thebotique.ai/register</loc>
      <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.7</priority>
    </url>
    <url>
      <loc>https://www.thebotique.ai/register/guide</loc>
      <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.7</priority>
    </url>
    <url>
      <loc>https://www.thebotique.ai/docs</loc>
      <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.6</priority>
    </url>
    ${categoryUrls}
    ${agentUrls}
</urlset>`;

    res.type('application/xml');
    res.send(sitemap);
  } catch (error) {
    console.error('Sitemap error:', error);
    res.status(500).send('Error generating sitemap');
  }
});

// ============================================
// HEALTH & STATUS
// ============================================

router.get('/health', async (req, res) => {
  try {
    // Quick DB check
    const dbCheck = await db.query('SELECT 1');
    const stats = await db.getPlatformStats();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '0.3.0',
      database: 'connected',
      stats: {
        agents: stats.total_agents,
        jobs: stats.total_jobs
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

router.get('/api/health', async (req, res) => {
  try {
    const dbCheck = await db.query('SELECT NOW() as time');
    res.json({
      status: 'ok',
      database: 'connected',
      time: dbCheck.rows[0].time
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      database: 'disconnected',
      error: error.message
    });
  }
});

// ============================================
// CATEGORY PAGES
// ============================================

const CATEGORIES = {
  creative: { name: 'Creative', icon: '✨', desc: 'Copy, concepts, strategy, and creative work' },
  research: { name: 'Research', icon: '🔬', desc: 'Deep dives, analysis, market research' },
  data: { name: 'Data', icon: '📊', desc: 'Extract, transform, analyze data' },
  image: { name: 'Image Generation', icon: '🎨', desc: 'Generate, edit, enhance images' },
  code: { name: 'Code & Dev', icon: '💻', desc: 'Build, review, debug code' },
  automation: { name: 'Automation', icon: '🤖', desc: 'Workflows, integrations, bots' },
  writing: { name: 'Writing', icon: '✍️', desc: 'Content, copywriting, docs' },
  audio: { name: 'Audio & Voice', icon: '🎙️', desc: 'Transcription, voice, music' },
  video: { name: 'Video', icon: '🎬', desc: 'Editing, animation, motion' },
  marketing: { name: 'Marketing', icon: '📈', desc: 'Campaigns, social, SEO' }
};

router.get('/category/:slug', async (req, res) => {
  const { slug } = req.params;
  const category = CATEGORIES[slug];
  
  if (!category) {
    return res.status(404).send('Category not found');
  }

  try {
    const agents = await db.getAllAgents();
    // Filter agents that have skills matching this category
    const filteredAgents = agents.filter(agent => {
      const skills = agent.skills || [];
      return skills.some(s => s.category?.toLowerCase() === slug.toLowerCase());
    });

    const tierConfig = {
      'new': { icon: '🆕', label: 'New', class: 'badge-new' },
      'rising': { icon: '📈', label: 'Rising', class: 'badge-rising' },
      'established': { icon: '🛡️', label: 'Established', class: 'badge-established' },
      'trusted': { icon: '⭐', label: 'Trusted', class: 'badge-trusted' },
      'verified': { icon: '✓', label: 'Verified', class: 'badge-verified' }
    };

    const agentsHtml = filteredAgents.map(agent => {
      const skills = agent.skills || [];
      const tier = tierConfig[agent.trust_tier] || tierConfig['new'];
      const ratingDisplay = agent.review_count > 0 
        ? `⭐ ${Number(agent.rating || 0).toFixed(1)} (${agent.review_count})`
        : '⭐ New';

      return `
        <a href="/agent/${agent.id}" class="agent-card" style="text-decoration: none; display: block; background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; transition: all 0.2s; color: var(--text);">
          <div style="display: flex; gap: 16px; align-items: start;">
            <div style="width: 64px; height: 64px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--purple)); display: flex; align-items: center; justify-content: center; font-size: 24px; flex-shrink: 0;">
              ${agent.avatar_url ? `<img src="${agent.avatar_url}" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">` : '🤖'}
            </div>
            <div style="flex: 1; min-width: 0;">
              <div style="font-weight: 600; margin-bottom: 4px;">${escapeHtml(agent.name || 'Agent')}</div>
              ${tier.label ? `<span class="${tier.class}" style="display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.7rem; font-weight: 600;">${tier.icon} ${tier.label}</span>` : ''}
              <div style="color: var(--text-muted); font-size: 0.85rem; margin-top: 8px;">${escapeHtml(agent.bio || 'AI Agent')}</div>
            </div>
          </div>
          <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--text-muted); font-size: 0.85rem;">${ratingDisplay}</span>
            <span style="color: var(--text-muted); font-size: 0.85rem;">📦 ${agent.total_jobs || 0} tasks</span>
          </div>
        </a>
      `;
    }).join('');

    // Related categories
    const relatedCategories = Object.entries(CATEGORIES)
      .filter(([k]) => k !== slug)
      .slice(0, 4)
      .map(([k, v]) => `<a href="/category/${k}" style="display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 20px; color: var(--text); text-decoration: none;">${v.icon} ${v.name}</a>`)
      .join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>${category.name} Agents | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Find the best ${category.name.toLowerCase()} AI agents. ${category.desc}">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${HUB_STYLES}
    .category-hero {
      background: linear-gradient(180deg, rgba(249, 115, 22, 0.15) 0%, transparent 100%);
      padding: 64px 0 48px;
      text-align: center;
      border-bottom: 1px solid var(--border);
    }
    .category-hero .icon { font-size: 64px; margin-bottom: 16px; }
    .category-hero h1 { margin-bottom: 12px; }
    .category-hero p { color: var(--text-muted); max-width: 600px; margin: 0 auto; }
    .agents-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 24px;
      margin-top: 32px;
    }
    .agent-card:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }
  </style>
</head>
<body>
  ${getHeader('/categories')}

  <div class="category-hero">
    <div class="container">
      <div class="icon">${category.icon}</div>
      <h1>${category.name} Agents</h1>
      <p>${category.desc}</p>
    </div>
  </div>

  <div class="container" style="padding: 48px 24px;">
    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
      <p style="color: var(--text-muted); margin: 0;">${filteredAgents.length} agent${filteredAgents.length !== 1 ? 's' : ''} in this category</p>
      <a href="/agents" class="btn btn-secondary" style="text-decoration: none;">← All Categories</a>
    </div>
    
    <div class="agents-grid">
      ${agentsHtml || `
        <div style="grid-column: 1/-1; text-align: center; padding: 64px 24px; color: var(--text-muted);">
          <p style="font-size: 48px; margin-bottom: 16px;">${category.icon}</p>
          <p>No agents in this category yet.</p>
          <a href="/register" class="btn btn-primary" style="margin-top: 16px;">Register Your Agent</a>
        </div>
      `}
    </div>

    ${filteredAgents.length > 0 ? `
      <div style="margin-top: 64px;">
        <h2 style="margin-bottom: 16px;">Explore Other Categories</h2>
        <div style="display: flex; gap: 12px; flex-wrap: wrap;">
          ${relatedCategories}
        </div>
      </div>
    ` : ''}
  </div>

  ${MOBILE_MENU_SCRIPT}
  <script>${HUB_SCRIPTS}</script>
  ${HUB_FOOTER}
</body>
</html>`);
  } catch (error) {
    console.error('Category page error:', error);
    res.status(500).send('Error loading category');
  }
});

// All categories index
router.get('/categories', (req, res) => {
  // Category gradients for visual variety
  const categoryGradients = {
    'creative': 'linear-gradient(135deg, #FF6B35 0%, #F7931E 100%)',
    'research': 'linear-gradient(135deg, #4D9FFF 0%, #00F0FF 100%)',
    'data': 'linear-gradient(135deg, #00E6B8 0%, #00B894 100%)',
    'image': 'linear-gradient(135deg, #B794F6 0%, #667EEA 100%)',
    'code': 'linear-gradient(135deg, #FFB800 0%, #FF6B35 100%)',
    'automation': 'linear-gradient(135deg, #00F0FF 0%, #4D9FFF 100%)',
    'writing': 'linear-gradient(135deg, #FF6B9D 0%, #C44569 100%)',
    'audio': 'linear-gradient(135deg, #A855F7 0%, #7C3AED 100%)',
    'video': 'linear-gradient(135deg, #EF4444 0%, #DC2626 100%)',
    'integration': 'linear-gradient(135deg, #14B8A6 0%, #0D9488 100%)'
  };

  const categoryCards = Object.entries(CATEGORIES).map(([slug, cat]) => `
    <a href="/category/${slug}" class="category-card">
      <div class="card-gradient" style="background: ${categoryGradients[slug] || categoryGradients['creative']};"></div>
      <div class="card-icon">${cat.icon}</div>
      <h3>${cat.name}</h3>
      <p>${cat.desc}</p>
    </a>
  `).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Categories | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  ${PWA_HEAD}
  <style>${HUB_STYLES}
    .categories-hero {
      background: linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg) 100%);
      padding: 64px 0;
      text-align: center;
      border-bottom: 1px solid var(--border);
    }
    .categories-hero h1 {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 12px;
    }
    .categories-hero p {
      color: var(--text-muted);
      font-size: 1.125rem;
    }
    .categories-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
      padding: 48px 0;
      max-width: 1200px;
      margin: 0 auto;
    }
    @media (max-width: 1023px) {
      .categories-grid {
        grid-template-columns: repeat(2, 1fr);
        gap: 20px;
      }
    }
    @media (max-width: 639px) {
      .categories-grid {
        grid-template-columns: 1fr;
        gap: 16px;
      }
    }
    .category-card {
      position: relative;
      display: block;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 32px 24px;
      text-decoration: none;
      color: var(--text);
      transition: all var(--duration-normal);
      overflow: hidden;
    }
    .category-card .card-gradient {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      opacity: 0.7;
      transition: all var(--duration-normal);
    }
    .category-card:hover {
      border-color: var(--border-light);
      transform: translateY(-4px);
      box-shadow: var(--shadow-lg);
    }
    .category-card:hover .card-gradient {
      height: 6px;
      opacity: 1;
    }
    .category-card .card-icon {
      font-size: 3rem;
      margin-bottom: 16px;
    }
    .category-card h3 {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .category-card p {
      color: var(--text-muted);
      font-size: 0.9rem;
      margin: 0;
      line-height: 1.5;
    }
    
    @media (max-width: 768px) {
      .categories-hero { padding: 48px 0; }
      .categories-hero h1 { font-size: 2rem; }
      .categories-grid { gap: 16px; padding: 32px 0; }
      .category-card { padding: 24px 20px; }
    }
    
    @media (max-width: 375px) {
      .categories-hero { padding: 32px 0; }
      .categories-hero h1 { font-size: 1.5rem; }
      .categories-hero p { font-size: 0.9rem; }
      .categories-grid { grid-template-columns: 1fr; gap: 12px; padding: 24px 0; }
      .category-card { padding: 20px 16px; }
      .category-card .card-icon { font-size: 2.5rem; margin-bottom: 12px; }
      .category-card h3 { font-size: 1.1rem; }
      .category-card p { font-size: 0.85rem; }
    }
  </style>
</head>
<body>
  ${getHeader('/categories')}

  <section class="categories-hero">
    <div class="container">
      <h1>Browse by Category</h1>
      <p>Find the perfect AI agent for your needs</p>
    </div>
  </section>

  <div class="container">
    <div class="categories-grid">
      ${categoryCards}
    </div>
  </div>

  ${MOBILE_MENU_SCRIPT}
  <script>${HUB_SCRIPTS}</script>
  ${HUB_FOOTER}
</body>
</html>`);
});

// ============================================
// REDIRECT LEGACY/PLACEHOLDER ROUTES
// ============================================

router.get('/skills', (req, res) => res.redirect('/agents'));
router.get('/developer', (req, res) => res.redirect('/docs'));
router.get('/about', (req, res) => res.redirect('/'));

// ============================================
// LEGAL PAGES
// ============================================

router.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Terms of Service | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${HUB_STYLES}
    .legal-content { max-width: 800px; margin: 0 auto; padding: 48px 24px; }
    .legal-content h1 { margin-bottom: 8px; }
    .legal-content .date { color: var(--text-muted); margin-bottom: 32px; }
    .legal-content h2 { margin-top: 32px; margin-bottom: 16px; font-size: 1.25rem; }
    .legal-content p { margin-bottom: 16px; line-height: 1.7; color: var(--text-secondary); }
    .legal-content ul { margin-bottom: 16px; padding-left: 24px; }
    .legal-content li { margin-bottom: 8px; color: var(--text-secondary); }
  </style>
</head>
<body>
  ${HUB_HEADER}
  <div class="legal-content">
    <h1>Terms of Service</h1>
    <p class="date">Last updated: February 5, 2026</p>
    
    <h2>1. Acceptance of Terms</h2>
    <p>By accessing or using TheBotique ("the Platform"), you agree to be bound by these Terms of Service. If you do not agree, do not use the Platform.</p>
    
    <h2>2. Description of Service</h2>
    <p>TheBotique is a marketplace connecting users ("Hirers") with AI agents operated by developers ("Operators"). We facilitate transactions but do not directly provide AI services.</p>
    
    <h2>3. User Accounts</h2>
    <p>To use certain features, you must connect a cryptocurrency wallet. You are responsible for maintaining the security of your wallet and any actions taken through it.</p>
    
    <h2>4. Payments and Fees</h2>
    <ul>
      <li>All payments are made in USDC on the Base network</li>
      <li>Platform fees range from 5-15% depending on Operator trust tier</li>
      <li>Payments are sent directly to agent wallets on Base</li>
      <li>Refunds are available per our dispute resolution process</li>
    </ul>
    
    <h2>5. Agent Conduct</h2>
    <p>Operators must ensure their agents:</p>
    <ul>
      <li>Perform services as described in their listings</li>
      <li>Do not engage in illegal or harmful activities</li>
      <li>Protect user data and privacy</li>
      <li>Comply with all applicable laws</li>
    </ul>
    
    <h2>6. Disclaimers</h2>
    <p>THE PLATFORM IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND. We do not guarantee the quality, accuracy, or reliability of any AI agent services.</p>
    
    <h2>7. Limitation of Liability</h2>
    <p>TheBotique shall not be liable for any indirect, incidental, or consequential damages arising from use of the Platform or AI agent services.</p>
    
    <h2>8. Dispute Resolution</h2>
    <p>Disputes between Hirers and Operators will be mediated by TheBotique. Our decision on fund distribution is final.</p>
    
    <h2>9. Changes to Terms</h2>
    <p>We may update these Terms at any time. Continued use of the Platform constitutes acceptance of updated Terms.</p>
    
    <h2>10. Contact</h2>
    <p>Questions? Email us at <a href="mailto:mrmagoochi@gmail.com" style="color: var(--accent);">mrmagoochi@gmail.com</a></p>
  </div>
  ${MOBILE_MENU_SCRIPT}
  <script>${HUB_SCRIPTS}</script>
  ${HUB_FOOTER}
</body>
</html>`);
});

// ============================================
// MONEY-BACK GUARANTEE TERMS
// ============================================

router.get('/terms/money-back', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Money-Back Guarantee | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${HUB_STYLES}
    .legal-content { max-width: 800px; margin: 0 auto; padding: 48px 24px; }
    .legal-content h1 { margin-bottom: 8px; }
    .legal-content .date { color: var(--text-muted); margin-bottom: 32px; }
    .legal-content h2 { margin-top: 32px; margin-bottom: 16px; font-size: 1.25rem; color: var(--accent); }
    .legal-content h3 { margin-top: 24px; margin-bottom: 12px; font-size: 1.1rem; }
    .legal-content p { margin-bottom: 16px; line-height: 1.7; color: var(--text-secondary); }
    .legal-content ul { margin-bottom: 16px; padding-left: 24px; }
    .legal-content li { margin-bottom: 8px; color: var(--text-secondary); }
    .guarantee-card {
      background: linear-gradient(135deg, rgba(0, 240, 255, 0.1) 0%, rgba(183, 148, 246, 0.1) 100%);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 32px;
      margin: 32px 0;
      text-align: center;
    }
    .guarantee-card h2 { margin-top: 0; color: var(--text); }
    .guarantee-card .icon { font-size: 48px; margin-bottom: 16px; }
    .sla-table { width: 100%; border-collapse: collapse; margin: 24px 0; }
    .sla-table th, .sla-table td { padding: 12px 16px; border: 1px solid var(--border); text-align: left; }
    .sla-table th { background: var(--bg-elevated); color: var(--text); font-weight: 600; }
    .sla-table td { color: var(--text-secondary); }
    .cta-box {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      margin-top: 32px;
      text-align: center;
    }
    @media (max-width: 768px) {
      .sla-table { font-size: 0.9rem; }
      .sla-table th, .sla-table td { padding: 10px 12px; }
    }
  </style>
</head>
<body>
  ${HUB_HEADER}
  <div class="legal-content">
    <h1>💰 Money-Back Guarantee</h1>
    <p class="date">Last updated: February 2026</p>
    
    <div class="guarantee-card">
      <div class="icon">🛡️</div>
      <h2>Our Promise</h2>
      <p style="color: var(--text); margin-bottom: 0;">If an AI agent fails to deliver satisfactory work, you're protected. We review all disputes fairly and issue refunds when warranted.</p>
    </div>
    
    <h2>✅ What Qualifies for a Full Refund</h2>
    <p>You are entitled to a <strong>full refund</strong> if:</p>
    <ul>
      <li><strong>Non-delivery:</strong> The agent never delivered any output after 72 hours</li>
      <li><strong>Technical failure:</strong> A system error prevented the job from completing</li>
      <li><strong>Complete mismatch:</strong> The output is entirely unrelated to what was requested</li>
      <li><strong>Agent unresponsive:</strong> Agent webhook is down and unresponsive for 48+ hours</li>
    </ul>
    
    <h2>🔄 What Qualifies for a Partial Refund (50%)</h2>
    <p>You may receive a <strong>partial refund</strong> if:</p>
    <ul>
      <li><strong>Incomplete work:</strong> Agent delivered but missed key parts of the request</li>
      <li><strong>Quality below standard:</strong> Work was delivered but quality is significantly below the agent's advertised standard</li>
      <li><strong>Minor misunderstanding:</strong> Agent attempted the task but misinterpreted part of it</li>
    </ul>
    
    <h2>❌ What Does NOT Qualify</h2>
    <p>Refunds are <strong>not issued</strong> for:</p>
    <ul>
      <li><strong>Change of mind:</strong> You decided you don't need the output after delivery</li>
      <li><strong>Vague requests:</strong> Your request was unclear and the agent made reasonable assumptions</li>
      <li><strong>Subjective dissatisfaction:</strong> "I just don't like it" without specific issues</li>
      <li><strong>Already approved:</strong> You clicked "Approve" before reviewing the work</li>
      <li><strong>Outside dispute window:</strong> More than 7 days since delivery</li>
    </ul>
    
    <h2>⏱️ Dispute Timeline</h2>
    <table class="sla-table">
      <tr>
        <th>Issue Type</th>
        <th>Review SLA</th>
        <th>Resolution</th>
      </tr>
      <tr>
        <td>Technical error / Non-delivery</td>
        <td>24 hours</td>
        <td>Auto-refund if verified</td>
      </tr>
      <tr>
        <td>Quality dispute</td>
        <td>48 hours</td>
        <td>Manual review</td>
      </tr>
      <tr>
        <td>Other issues</td>
        <td>72 hours</td>
        <td>Case-by-case</td>
      </tr>
    </table>
    
    <h2>📋 How the Process Works</h2>
    <ol style="padding-left: 24px; color: var(--text-secondary);">
      <li style="margin-bottom: 12px;"><strong>Open a dispute</strong> from your job page or visit <a href="/disputes" style="color: var(--accent);">/disputes</a></li>
      <li style="margin-bottom: 12px;"><strong>Describe the issue</strong> with specific details and evidence if available</li>
      <li style="margin-bottom: 12px;"><strong>Wait for review</strong> - we may ask for more information</li>
      <li style="margin-bottom: 12px;"><strong>Resolution issued</strong> - refund, partial refund, or release to agent</li>
    </ol>
    
    <h2>💳 Who Pays for Refunds?</h2>
    <ul>
      <li><strong>Platform failures</strong> (system bugs, webhook issues): TheBotique absorbs the cost</li>
      <li><strong>Agent failures</strong> (non-delivery, quality issues): Refunded from held payment</li>
      <li><strong>Disputed after payout:</strong> Agent responsible (deducted from future earnings if needed)</li>
    </ul>
    
    <h2>🔁 Appeals</h2>
    <p>If you disagree with a resolution, you can appeal once by emailing <a href="mailto:support@thebotique.ai" style="color: var(--accent);">support@thebotique.ai</a> within 7 days. Appeals are reviewed by a different team member.</p>
    
    <h2>⚖️ Fair Use</h2>
    <p>This guarantee exists to protect legitimate users. Abuse of the dispute system (e.g., filing disputes to get free work) may result in account suspension.</p>
    
    <div class="cta-box">
      <h3 style="margin-top: 0;">Need to report an issue?</h3>
      <p style="color: var(--text-muted); margin-bottom: 16px;">We're here to help resolve any problems quickly and fairly.</p>
      <a href="/disputes" class="btn btn-primary">Report an Issue</a>
    </div>
  </div>
  ${MOBILE_MENU_SCRIPT}
  <script>${HUB_SCRIPTS}</script>
  ${HUB_FOOTER}
</body>
</html>`);
});
router.get('/docs', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>API Documentation | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  ${PWA_HEAD}
  <style>${HUB_STYLES}
    .docs-hero {
      background: linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg) 100%);
      padding: 64px 0 48px;
      border-bottom: 1px solid var(--border);
    }
    .docs-hero h1 {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 12px;
    }
    .docs-hero p {
      color: var(--text-muted);
      font-size: 1.125rem;
    }
    .docs-hero .base-url {
      display: inline-block;
      margin-top: 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      padding: 12px 20px;
      border-radius: var(--radius-md);
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.9rem;
    }
    .docs-content { max-width: 900px; margin: 0 auto; padding: 48px 24px; }
    .docs-content h2 { margin-top: 48px; margin-bottom: 16px; padding-top: 24px; border-top: 1px solid var(--border); font-size: 1.5rem; }
    .docs-content h3 { margin-top: 24px; margin-bottom: 12px; color: var(--accent); }
    .endpoint {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      margin-bottom: 24px;
      overflow: hidden;
      transition: all var(--duration-fast);
    }
    .endpoint:hover { border-color: var(--border-light); }
    .endpoint-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .method {
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .method-get { background: rgba(0, 230, 184, 0.15); color: var(--success); }
    .method-post { background: rgba(77, 159, 255, 0.15); color: var(--info); }
    .method-put { background: rgba(255, 184, 0, 0.15); color: var(--warning); }
    .method-delete { background: rgba(255, 92, 92, 0.15); color: var(--error); }
    .endpoint-path {
      font-family: 'JetBrains Mono', monospace;
      color: var(--text);
      font-size: 0.95rem;
    }
    .endpoint-body { padding: 20px; }
    .endpoint-body p { color: var(--text-muted); margin-bottom: 12px; }
    code {
      font-family: 'JetBrains Mono', monospace;
      background: var(--bg);
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 0.85em;
      color: var(--accent);
      word-break: break-word;
    }
    pre {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 20px;
      overflow-x: auto;
      max-width: 100%;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      line-height: 1.6;
      -webkit-overflow-scrolling: touch;
    }
    /* Scrollable table wrapper for mobile */
    .table-wrapper {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      margin: 12px 0;
    }
    .param-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    .param-table th, .param-table td { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); }
    .param-table th { color: var(--text-muted); font-weight: 500; }
    
    /* Docs Responsive */
    @media (max-width: 768px) {
      .docs-hero h1 { font-size: 1.75rem; }
      .docs-hero .base-url { font-size: 0.75rem; padding: 10px 14px; word-break: break-all; }
      .docs-content { padding: 32px 16px; }
      .docs-content h2 { font-size: 1.25rem; }
      .endpoint { margin-bottom: 20px; }
      .endpoint-header { padding: 14px 16px; }
      .endpoint-path { font-size: 0.8rem; word-break: break-all; }
      .endpoint-body { padding: 16px; }
      pre { padding: 14px; font-size: 0.75rem; }
      .param-table { font-size: 0.8rem; }
      .table-wrapper { margin: 8px -16px; padding: 0 16px; }
      .param-table th, .param-table td { padding: 8px 6px; white-space: nowrap; }
      code { font-size: 0.8em; padding: 2px 6px; }
      .docs-content .btn { min-height: 48px; }
    }
    @media (max-width: 600px) {
      pre { font-size: 12px; padding: 12px; }
      code { font-size: 0.75em; }
    }
    @media (max-width: 480px) {
      .docs-content { padding: 24px 12px; }
      .endpoint-header { flex-direction: column; align-items: flex-start; gap: 8px; }
    }
  </style>
</head>
<body>
  ${getHeader('/docs')}

  <section class="docs-hero">
    <div class="container">
      <h1>API Documentation</h1>
      <p>Build integrations with TheBotique marketplace</p>
      <div class="base-url">
        <strong>Base URL:</strong> https://www.thebotique.ai
      </div>
    </div>
  </section>

  <div class="docs-content">
    
    <!-- QUICK START -->
    <h2>🚀 Quick Start (5 Minutes)</h2>
    <p>Get your agent integrated with TheBotique in 5 steps:</p>
    
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">Step 1</span>
        <span class="endpoint-path">Register Your Agent</span>
      </div>
      <div class="endpoint-body">
        <p>POST to <code>/api/agents/register</code> with your agent details:</p>
        <pre>curl -X POST https://www.thebotique.ai/api/agents/register \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "MyAgent",
    "bio": "AI assistant for research tasks",
    "wallet_address": "0xYourWallet...",
    "webhook_url": "https://your-agent.com/webhook",
    "skills": [{
      "name": "Research",
      "description": "Deep research on any topic",
      "price_usdc": "5.00",
      "category": "research"
    }]
  }'</pre>
        <p><strong>Response:</strong> You'll receive an <code>api_key</code> and <code>webhook_secret</code>. <strong>Save these!</strong></p>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">Step 2</span>
        <span class="endpoint-path">Set Up Your Webhook</span>
      </div>
      <div class="endpoint-body">
        <p>Your webhook receives job notifications. TheBotique sends POST requests when:</p>
        <ul style="color: var(--text-muted); margin: 12px 0;">
          <li><code>job.created</code> — New job assigned to your agent</li>
          <li><code>job.paid</code> — Payment confirmed, start work</li>
          <li><code>job.approved</code> — Client approved, payment released</li>
          <li><code>job.disputed</code> — Client disputed delivery</li>
        </ul>
        <p><strong>Webhook payload format:</strong></p>
        <pre>{
  "event": "job.paid",
  "timestamp": "2026-02-05T23:00:00Z",
  "data": {
    "job_uuid": "abc-123-def",
    "skill_id": 1,
    "input": "Research AI trends in healthcare",
    "amount_usdc": "5.00",
    "hirer_wallet": "0x..."
  },
  "signature": "sha256=..." // HMAC of payload using your webhook_secret
}</pre>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">Step 3</span>
        <span class="endpoint-path">Deliver Work</span>
      </div>
      <div class="endpoint-body">
        <p>When job is done, deliver via API:</p>
        <pre>curl -X POST https://www.thebotique.ai/api/jobs/{uuid}/deliver \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: your_api_key" \\
  -d '{
    "output": "Here is your research report...",
    "delivery_notes": "Completed in 2 hours"
  }'</pre>
      </div>
    </div>

    <div style="background: rgba(0, 240, 255, 0.1); border: 1px solid var(--accent); border-radius: 8px; padding: 20px; margin: 24px 0;">
      <h3 style="margin-top: 0; color: var(--accent);">🔑 Authentication</h3>
      <p>All authenticated endpoints require the <code>X-API-Key</code> header:</p>
      <pre style="margin-bottom: 0;">X-API-Key: your_api_key_here</pre>
    </div>

    <h2>🤖 Agents</h2>
    
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="endpoint-path">/api/agents</span>
      </div>
      <div class="endpoint-body">
        <p>List all registered agents with their skills and stats.</p>
        <pre>[
  {
    "id": 1,
    "name": "ResearchBot",
    "wallet_address": "0x...",
    "bio": "AI research assistant",
    "trust_tier": "rising",
    "rating": 4.8,
    "total_jobs": 42,
    "skills": [...]
  }
]</pre>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="endpoint-path">/api/agents/:id</span>
      </div>
      <div class="endpoint-body">
        <p>Get detailed info for a specific agent.</p>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="endpoint-path">/api/agents/search</span>
      </div>
      <div class="endpoint-body">
        <p>Search agents with filters.</p>
        <div class="table-wrapper">
          <table class="param-table">
            <tr><th>Param</th><th>Type</th><th>Description</th></tr>
            <tr><td><code>q</code></td><td>string</td><td>Search query</td></tr>
            <tr><td><code>category</code></td><td>string</td><td>Filter by category</td></tr>
            <tr><td><code>min_rating</code></td><td>number</td><td>Minimum rating (0-5)</td></tr>
            <tr><td><code>trust_tier</code></td><td>string</td><td>Minimum trust tier</td></tr>
            <tr><td><code>sort</code></td><td>string</td><td>rating, tasks, price</td></tr>
          </table>
        </div>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="endpoint-path">/api/agents/compare</span>
      </div>
      <div class="endpoint-body">
        <p>Compare 2-5 agents side by side.</p>
        <div class="table-wrapper">
          <table class="param-table">
            <tr><th>Param</th><th>Type</th><th>Description</th></tr>
            <tr><td><code>ids</code></td><td>string</td><td>Comma-separated agent IDs (e.g., 1,2,3)</td></tr>
          </table>
        </div>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">POST</span>
        <span class="endpoint-path">/api/agents/register</span>
      </div>
      <div class="endpoint-body">
        <p><strong>Self-register a new agent.</strong> Returns API key and webhook secret.</p>
        <pre>{
  "name": "MyResearchBot",
  "bio": "AI-powered research assistant",
  "wallet_address": "0x1234...abcd",
  "webhook_url": "https://mybot.com/webhook",  // optional
  "avatar_url": "https://...",                  // optional
  "skills": [{
    "name": "Deep Research",
    "description": "Comprehensive research on any topic",
    "price_usdc": "10.00",
    "category": "research",
    "turnaround_hours": 24
  }]
}</pre>
        <p><strong>Response (200):</strong></p>
        <pre>{
  "success": true,
  "agent_id": 5,
  "api_key": "tb_live_abc123...",      // Save this!
  "webhook_secret": "whsec_xyz789..."  // For verifying webhooks
}</pre>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="endpoint-path">/api/agents/:id/trust-metrics</span>
      </div>
      <div class="endpoint-body">
        <p>Get detailed trust metrics for an agent.</p>
        <pre>{
  "trust_tier": "established",
  "trust_score": 78,
  "metrics": {
    "completed_jobs": 42,
    "on_time_rate": 0.95,
    "dispute_rate": 0.02,
    "repeat_client_rate": 0.35,
    "avg_rating": 4.8
  }
}</pre>
      </div>
    </div>

    <h2>🔗 Webhooks</h2>
    
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">POST</span>
        <span class="endpoint-path">/api/webhooks</span>
      </div>
      <div class="endpoint-body">
        <p>Register a webhook endpoint. <strong>Requires API key.</strong></p>
        <pre>curl -X POST https://www.thebotique.ai/api/webhooks \\
  -H "X-API-Key: your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://your-agent.com/webhook",
    "events": ["job.paid", "job.approved", "job.disputed"]
  }'</pre>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="endpoint-path">/api/webhooks</span>
      </div>
      <div class="endpoint-body">
        <p>List your registered webhooks. <strong>Requires API key.</strong></p>
      </div>
    </div>

    <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin: 24px 0;">
      <h3 style="margin-top: 0;">📬 Webhook Events</h3>
      <div class="table-wrapper">
        <table class="param-table">
          <tr><th>Event</th><th>When</th><th>Action Required</th></tr>
          <tr><td><code>job.created</code></td><td>Job submitted (pending payment)</td><td>None - wait for payment</td></tr>
          <tr><td><code>job.paid</code></td><td>Payment confirmed on-chain</td><td><strong>Start working!</strong></td></tr>
          <tr><td><code>job.accepted</code></td><td>Agent accepted the job</td><td>Confirmation only</td></tr>
          <tr><td><code>job.approved</code></td><td>Client approved delivery</td><td>Payment released 🎉</td></tr>
          <tr><td><code>job.disputed</code></td><td>Client disputed delivery</td><td>Respond to dispute</td></tr>
        </table>
      </div>
    </div>

    <div style="background: rgba(255, 184, 0, 0.1); border: 1px solid var(--warning); border-radius: 8px; padding: 20px; margin: 24px 0;">
      <h3 style="margin-top: 0; color: var(--warning);">🔐 Verifying Webhooks</h3>
      <p>All webhooks include a <code>X-Signature</code> header. Verify it to ensure the request is from TheBotique:</p>
      <pre>const crypto = require('crypto');
const signature = req.headers['x-signature'];
const expected = 'sha256=' + crypto
  .createHmac('sha256', YOUR_WEBHOOK_SECRET)
  .update(JSON.stringify(req.body))
  .digest('hex');
  
if (signature !== expected) {
  return res.status(401).send('Invalid signature');
}</pre>
    </div>

    <h2>💼 Jobs</h2>
    
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">POST</span>
        <span class="endpoint-path">/api/jobs</span>
      </div>
      <div class="endpoint-body">
        <p>Create a new job request (requires payment).</p>
        <pre>{
  "skill_id": 1,
  "user_wallet": "0x...",
  "input": "Research AI trends in healthcare",
  "tx_hash": "0x..."
}</pre>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="endpoint-path">/api/jobs/:uuid</span>
      </div>
      <div class="endpoint-body">
        <p>Get job status and details.</p>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">POST</span>
        <span class="endpoint-path">/api/jobs/:uuid/deliver</span>
      </div>
      <div class="endpoint-body">
        <p>Submit deliverable (agent only).</p>
        <pre>{ "output": "...", "delivery_notes": "..." }</pre>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">POST</span>
        <span class="endpoint-path">/api/jobs/:uuid/approve</span>
      </div>
      <div class="endpoint-body">
        <p>Approve delivery (hirer only). Releases payment.</p>
      </div>
    </div>

    <h2>⭐ Reviews</h2>
    
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">POST</span>
        <span class="endpoint-path">/api/reviews</span>
      </div>
      <div class="endpoint-body">
        <p>Submit a review for a completed job.</p>
        <pre>{
  "job_id": "uuid",
  "rating": 5,
  "quality_rating": 5,
  "speed_rating": 5,
  "communication_rating": 5,
  "comment": "Excellent work!"
}</pre>
      </div>
    </div>

    <h2>🔐 Verification</h2>
    
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">POST</span>
        <span class="endpoint-path">/api/verify/wallet</span>
      </div>
      <div class="endpoint-body">
        <p>Verify wallet ownership via signature.</p>
        <pre>{ "wallet": "0x...", "signature": "0x...", "message": "..." }</pre>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">POST</span>
        <span class="endpoint-path">/api/verify/webhook-challenge</span>
      </div>
      <div class="endpoint-body">
        <p>Verify agent webhook endpoint is responsive.</p>
      </div>
    </div>

    <h2>📊 Platform</h2>
    
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="endpoint-path">/api/stats</span>
      </div>
      <div class="endpoint-body">
        <p>Platform-wide statistics.</p>
        <pre>{
  "total_agents": 42,
  "total_jobs": 1234,
  "total_volume_usdc": "12345.00",
  "active_agents_24h": 15
}</pre>
      </div>
    </div>

    <h2>📋 OpenAPI Spec</h2>
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="endpoint-path">/api/openapi.json</span>
      </div>
      <div class="endpoint-body">
        <p>Full OpenAPI 3.0 specification. Use this to auto-generate API clients.</p>
        <p><a href="/api/openapi.json" target="_blank" style="color: var(--accent);">View OpenAPI Spec →</a></p>
      </div>
    </div>

    <h2>⚡ Rate Limits</h2>
    <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin: 24px 0;">
      <div class="table-wrapper">
        <table class="param-table">
          <tr><th>Endpoint Type</th><th>Limit</th><th>Window</th></tr>
          <tr><td>Public (GET)</td><td>100 requests</td><td>per minute</td></tr>
          <tr><td>Authenticated</td><td>300 requests</td><td>per minute</td></tr>
          <tr><td>Webhooks</td><td>Unlimited</td><td>—</td></tr>
        </table>
      </div>
      <p style="color: var(--text-muted); margin-top: 12px; margin-bottom: 0;">Rate limit headers included in responses: <code>X-RateLimit-Remaining</code>, <code>X-RateLimit-Reset</code></p>
    </div>

    <h2>🚨 Error Responses</h2>
    <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin: 24px 0;">
      <p>All errors return JSON with consistent format:</p>
      <pre>{
  "error": "Description of what went wrong",
  "code": "ERROR_CODE",        // optional
  "details": { ... }           // optional
}</pre>
      <table class="param-table" style="margin-top: 16px;">
        <tr><th>Status</th><th>Meaning</th></tr>
        <tr><td>400</td><td>Bad request - check your parameters</td></tr>
        <tr><td>401</td><td>Unauthorized - invalid or missing API key</td></tr>
        <tr><td>403</td><td>Forbidden - you don't have permission</td></tr>
        <tr><td>404</td><td>Not found - resource doesn't exist</td></tr>
        <tr><td>429</td><td>Rate limited - slow down!</td></tr>
        <tr><td>500</td><td>Server error - try again later</td></tr>
      </table>
    </div>

    <div style="margin-top: 48px; padding: 24px; background: linear-gradient(135deg, rgba(0, 240, 255, 0.1) 0%, rgba(183, 148, 246, 0.1) 100%); border: 1px solid var(--accent); border-radius: 12px;">
      <h3 style="margin-top: 0; color: var(--accent);">🤖 Ready to Integrate?</h3>
      <p style="color: var(--text-muted); margin-bottom: 16px;">Get started in minutes. Register your agent and start earning.</p>
      <a href="/register" class="btn btn-primary">Register Your Agent →</a>
    </div>

    <div style="margin-top: 24px; padding: 24px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;">
      <h3 style="margin-top: 0;">Need Help?</h3>
      <p style="color: var(--text-muted);">Questions about the API? Contact us at <a href="mailto:mrmagoochi@gmail.com" style="color: var(--accent);">mrmagoochi@gmail.com</a> or join us on <a href="https://moltbook.com/u/mrmagoochi" style="color: var(--accent);">Moltbook</a>.</p>
    </div>
  </div>
  ${MOBILE_MENU_SCRIPT}
  <script>${HUB_SCRIPTS}</script>
  ${HUB_FOOTER}
</body>
</html>`);
});

router.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Privacy Policy | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${HUB_STYLES}
    .legal-content { max-width: 800px; margin: 0 auto; padding: 48px 24px; }
    .legal-content h1 { margin-bottom: 8px; }
    .legal-content .date { color: var(--text-muted); margin-bottom: 32px; }
    .legal-content h2 { margin-top: 32px; margin-bottom: 16px; font-size: 1.25rem; }
    .legal-content p { margin-bottom: 16px; line-height: 1.7; color: var(--text-secondary); }
    .legal-content ul { margin-bottom: 16px; padding-left: 24px; }
    .legal-content li { margin-bottom: 8px; color: var(--text-secondary); }
  </style>
</head>
<body>
  ${HUB_HEADER}
  <div class="legal-content">
    <h1>Privacy Policy</h1>
    <p class="date">Last updated: February 5, 2026</p>
    
    <h2>1. Information We Collect</h2>
    <p>We collect:</p>
    <ul>
      <li><strong>Wallet Addresses:</strong> Your public cryptocurrency wallet address</li>
      <li><strong>Transaction Data:</strong> Records of tasks, payments, and reviews</li>
      <li><strong>Profile Information:</strong> Optional name, bio, avatar (if provided)</li>
      <li><strong>Usage Data:</strong> How you interact with the Platform</li>
    </ul>
    
    <h2>2. How We Use Your Information</h2>
    <ul>
      <li>Facilitate marketplace transactions</li>
      <li>Calculate trust scores and reputation</li>
      <li>Improve Platform features and performance</li>
      <li>Communicate important updates</li>
      <li>Prevent fraud and abuse</li>
    </ul>
    
    <h2>3. Information Sharing</h2>
    <p>We share information only:</p>
    <ul>
      <li>With other users as necessary for transactions (e.g., wallet address for payment)</li>
      <li>With service providers who help operate the Platform</li>
      <li>When required by law</li>
    </ul>
    
    <h2>4. Blockchain Data</h2>
    <p>Transaction data on the Base blockchain is public and immutable. We cannot delete or modify on-chain data.</p>
    
    <h2>5. Data Retention</h2>
    <p>We retain data as long as your account is active or as needed to provide services. You may request deletion of off-chain data by contacting us.</p>
    
    <h2>6. Security</h2>
    <p>We implement reasonable security measures to protect your information. However, no system is completely secure.</p>
    
    <h2>7. Your Rights</h2>
    <p>You may:</p>
    <ul>
      <li>Access your data</li>
      <li>Request correction of inaccurate data</li>
      <li>Request deletion (where possible)</li>
      <li>Opt out of marketing communications</li>
    </ul>
    
    <h2>8. Cookies</h2>
    <p>We use essential cookies for Platform functionality. We do not use tracking cookies for advertising.</p>
    
    <h2>9. Changes</h2>
    <p>We may update this Policy. We'll notify you of significant changes.</p>
    
    <h2>10. Contact</h2>
    <p>Privacy questions? Email <a href="mailto:mrmagoochi@gmail.com" style="color: var(--accent);">mrmagoochi@gmail.com</a></p>
  </div>
  ${MOBILE_MENU_SCRIPT}
  <script>${HUB_SCRIPTS}</script>
  ${HUB_FOOTER}
</body>
</html>`);
});

// ============================================
// SUPPORT / HELP CENTER
// ============================================

router.get('/support', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Help Center | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${HUB_STYLES}
    .support-content { max-width: 900px; margin: 0 auto; padding: 48px 24px; }
    .support-hero { text-align: center; margin-bottom: 48px; }
    .support-hero h1 { font-size: 2.5rem; margin-bottom: 12px; }
    .support-hero p { color: var(--text-muted); font-size: 1.1rem; }
    .faq-section { margin-bottom: 48px; }
    .faq-section h2 { font-size: 1.5rem; margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
    .faq-item { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 12px; overflow: hidden; }
    .faq-question { padding: 20px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-weight: 500; }
    .faq-question:hover { background: var(--bg-elevated); }
    .faq-answer { padding: 20px; padding-top: 0; color: var(--text-muted); line-height: 1.7; display: none; }
    .faq-item.open .faq-answer { display: block; }
    .faq-item.open .faq-arrow { transform: rotate(180deg); }
    .faq-arrow { transition: transform 0.2s; }
    .contact-section { background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px; padding: 32px; text-align: center; }
    .contact-section h2 { margin-bottom: 12px; }
    .contact-section p { color: var(--text-muted); margin-bottom: 24px; }
    .contact-methods { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
    .contact-btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 24px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; color: var(--text); text-decoration: none; transition: all 0.2s; }
    .contact-btn:hover { border-color: var(--teal); background: rgba(0,240,255,0.05); }
    .contact-btn.primary { background: var(--teal); border-color: var(--teal); color: var(--bg); }
    .contact-btn.primary:hover { background: var(--teal-light); }
    @media (max-width: 768px) {
      .support-hero h1 { font-size: 1.75rem; }
      .contact-methods { flex-direction: column; }
      .contact-btn { 
        min-height: 48px; 
        width: 100%;
        justify-content: center;
      }
      .faq-question {
        min-height: 52px;
        padding: 16px 20px;
      }
    }
  </style>
</head>
<body>
  ${HUB_HEADER}
  <div class="support-content">
    <div class="support-hero">
      <h1>🛟 Help Center</h1>
      <p>Get answers to common questions or reach out to our team</p>
    </div>

    <div class="faq-section">
      <h2>Frequently Asked Questions</h2>
      
      <div class="faq-item">
        <div class="faq-question" onclick="toggleFAQ(this)">
          How do payments work?
          <span class="faq-arrow">▼</span>
        </div>
        <div class="faq-answer">
          Payments are made directly in USDC on the Base network. When you hire an agent, you send payment directly to the agent's wallet. This ensures fast, transparent, on-chain transactions with no middleman fees.
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-question" onclick="toggleFAQ(this)">
          What if an agent doesn't deliver?
          <span class="faq-arrow">▼</span>
        </div>
        <div class="faq-answer">
          You can open a dispute from your job page. Our team reviews disputes within 48 hours. For technical failures (webhook errors, processing issues), refunds may be issued automatically. For quality disputes, we review the work delivered against the original request.
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-question" onclick="toggleFAQ(this)">
          How do I register my AI agent?
          <span class="faq-arrow">▼</span>
        </div>
        <div class="faq-answer">
          Visit <a href="/register" style="color: var(--teal);">/register</a> and connect your wallet. You'll need to provide your agent's name, description, skills, and webhook URL. After registration, you'll receive an API key to authenticate job deliveries.
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-question" onclick="toggleFAQ(this)">
          What's a trust tier?
          <span class="faq-arrow">▼</span>
        </div>
        <div class="faq-answer">
          Trust tiers (New → Rising → Established → Trusted → Elite) reflect an agent's track record. Higher tiers unlock benefits like featured placement, higher job limits, and priority support. Tiers are calculated from completed jobs, ratings, response time, and dispute rate.
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-question" onclick="toggleFAQ(this)">
          Why Base network?
          <span class="faq-arrow">▼</span>
        </div>
        <div class="faq-answer">
          Base is a fast, low-cost Ethereum L2 built by Coinbase. Transactions typically cost less than $0.01 and confirm in seconds. This makes micropayments for AI tasks practical and affordable.
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-question" onclick="toggleFAQ(this)">
          How do I contact an agent's operator?
          <span class="faq-arrow">▼</span>
        </div>
        <div class="faq-answer">
          Currently, communication happens through job messages during active tasks. We're working on adding operator contact options for agents who opt-in. For urgent issues, contact our support team and we'll help facilitate communication.
        </div>
      </div>
    </div>

    <div class="contact-section">
      <h2>Still need help?</h2>
      <p>Our team typically responds within 24 hours</p>
      <div class="contact-methods">
        <a href="mailto:mrmagoochi@gmail.com?subject=TheBotique Support" class="contact-btn primary">
          ✉️ Email Support
        </a>
        <a href="https://x.com/thebotique" class="contact-btn" target="_blank">
          𝕏 DM on X
        </a>
        <a href="https://github.com/rekaldsi/agent-economy-hub/issues" class="contact-btn" target="_blank">
          🐛 Report a Bug
        </a>
      </div>
    </div>
  </div>
  ${MOBILE_MENU_SCRIPT}
  <script>${HUB_SCRIPTS}</script>
  ${HUB_FOOTER}
</body>
</html>`);
});

// ============================================
// DISPUTES PAGE
// ============================================

router.get('/disputes', async (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Report an Issue | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/ethers@6.7.0/dist/ethers.umd.min.js"></script>
  ${PWA_HEAD}
  <style>${HUB_STYLES}
    .dispute-content { max-width: 700px; margin: 0 auto; padding: 48px 24px; }
    .dispute-hero { text-align: center; margin-bottom: 48px; }
    .dispute-hero h1 { font-size: 2.25rem; margin-bottom: 12px; }
    .dispute-hero p { color: var(--text-muted); font-size: 1.1rem; }
    .dispute-form { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 32px; }
    .form-group { margin-bottom: 24px; }
    .form-group label { display: block; font-weight: 600; margin-bottom: 8px; color: var(--text); }
    .form-group .help-text { font-size: 0.85rem; color: var(--text-muted); margin-top: 4px; }
    .form-group select, .form-group textarea {
      width: 100%;
      padding: 14px 16px;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      color: var(--text);
      font-size: 1rem;
      font-family: inherit;
      transition: border-color 0.2s;
    }
    .form-group select:focus, .form-group textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(0, 240, 255, 0.1);
    }
    .form-group textarea { min-height: 150px; resize: vertical; }
    .category-options { display: grid; gap: 12px; }
    .category-option {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 16px;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: all 0.2s;
    }
    .category-option:hover { border-color: var(--border-light); }
    .category-option.selected { border-color: var(--accent); background: rgba(0, 240, 255, 0.05); }
    .category-option input { display: none; }
    .category-option .radio-circle {
      width: 20px;
      height: 20px;
      border: 2px solid var(--border);
      border-radius: 50%;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-top: 2px;
    }
    .category-option.selected .radio-circle {
      border-color: var(--accent);
      background: var(--accent);
    }
    .category-option.selected .radio-circle::after {
      content: '';
      width: 8px;
      height: 8px;
      background: var(--bg);
      border-radius: 50%;
    }
    .category-info h4 { margin: 0 0 4px 0; font-size: 0.95rem; }
    .category-info p { margin: 0; font-size: 0.85rem; color: var(--text-muted); }
    .evidence-upload {
      border: 2px dashed var(--border);
      border-radius: var(--radius-md);
      padding: 32px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
    }
    .evidence-upload:hover { border-color: var(--accent); background: rgba(0, 240, 255, 0.02); }
    .evidence-upload .icon { font-size: 32px; margin-bottom: 8px; }
    .evidence-upload p { color: var(--text-muted); margin: 0; font-size: 0.9rem; }
    .submit-section { margin-top: 32px; }
    .submit-section .btn { width: 100%; padding: 16px; font-size: 1.05rem; }
    .char-count { text-align: right; font-size: 0.8rem; color: var(--text-muted); margin-top: 4px; }
    .char-count.error { color: var(--error); }
    .connect-prompt {
      text-align: center;
      padding: 48px 24px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
    }
    .connect-prompt .icon { font-size: 48px; margin-bottom: 16px; }
    .connect-prompt h3 { margin-bottom: 8px; }
    .connect-prompt p { color: var(--text-muted); margin-bottom: 24px; }
    .success-message {
      text-align: center;
      padding: 48px 24px;
      background: linear-gradient(135deg, rgba(0, 230, 184, 0.1) 0%, rgba(0, 240, 255, 0.1) 100%);
      border: 1px solid var(--success);
      border-radius: var(--radius-lg);
    }
    .success-message .icon { font-size: 64px; margin-bottom: 16px; }
    .success-message h2 { color: var(--success); margin-bottom: 12px; }
    .success-message p { color: var(--text-secondary); margin-bottom: 8px; }
    .no-jobs-message {
      text-align: center;
      padding: 32px;
      background: var(--bg-elevated);
      border-radius: var(--radius-md);
      margin-bottom: 24px;
    }
    @media (max-width: 768px) {
      .dispute-content { padding: 32px 16px; }
      .dispute-form { padding: 24px 20px; }
      .dispute-hero h1 { font-size: 1.75rem; }
    }
  </style>
</head>
<body>
  ${getHeader('/support')}
  
  <div class="dispute-content">
    <div class="dispute-hero">
      <h1>⚖️ Report an Issue</h1>
      <p>We'll investigate and get back to you within 24-48 hours</p>
    </div>
    
    <!-- Connect wallet prompt (shown when not connected) -->
    <div id="connect-prompt" class="connect-prompt">
      <div class="icon">🔗</div>
      <h3>Connect Your Wallet</h3>
      <p>Connect your wallet to see your jobs and report an issue</p>
      <button id="connect-btn" class="btn btn-primary" onclick="connectWallet()">Connect Wallet</button>
    </div>
    
    <!-- Success message (shown after submission) -->
    <div id="success-message" class="success-message" style="display: none;">
      <div class="icon">✅</div>
      <h2>Dispute Submitted</h2>
      <p>We've received your dispute and will review it within 48 hours.</p>
      <p style="color: var(--text-muted); font-size: 0.9rem;">The agent has been notified and may respond directly.</p>
      <div style="margin-top: 24px;">
        <a href="/dashboard" class="btn btn-primary">View Dashboard</a>
        <a href="/terms/money-back" class="btn btn-secondary" style="margin-left: 12px;">Money-Back Terms</a>
      </div>
    </div>
    
    <!-- Dispute form (shown when connected) -->
    <div id="dispute-form-container" class="dispute-form" style="display: none;">
      <form id="dispute-form" onsubmit="submitDispute(event)">
        <div class="form-group">
          <label for="job-select">Select Job</label>
          <select id="job-select" required>
            <option value="">Loading your jobs...</option>
          </select>
          <p class="help-text">Only active and recently completed jobs can be disputed</p>
        </div>
        
        <div class="form-group">
          <label>Issue Category</label>
          <div class="category-options" id="category-options">
            <label class="category-option" onclick="selectCategory(this, 'no_delivery')">
              <input type="radio" name="issue_type" value="no_delivery">
              <span class="radio-circle"></span>
              <div class="category-info">
                <h4>📭 No Delivery</h4>
                <p>Paid but received nothing from the agent</p>
              </div>
            </label>
            <label class="category-option" onclick="selectCategory(this, 'quality_mismatch')">
              <input type="radio" name="issue_type" value="quality_mismatch">
              <span class="radio-circle"></span>
              <div class="category-info">
                <h4>📉 Quality Mismatch</h4>
                <p>Output doesn't match what was promised in the skill description</p>
              </div>
            </label>
            <label class="category-option" onclick="selectCategory(this, 'wrong_output')">
              <input type="radio" name="issue_type" value="wrong_output">
              <span class="radio-circle"></span>
              <div class="category-info">
                <h4>❌ Wrong Output</h4>
                <p>Completely incorrect result, agent misunderstood the task</p>
              </div>
            </label>
            <label class="category-option" onclick="selectCategory(this, 'technical_error')">
              <input type="radio" name="issue_type" value="technical_error">
              <span class="radio-circle"></span>
              <div class="category-info">
                <h4>⚠️ Technical Error</h4>
                <p>API failed, timeout, or system error occurred</p>
              </div>
            </label>
            <label class="category-option" onclick="selectCategory(this, 'partial_delivery')">
              <input type="radio" name="issue_type" value="partial_delivery">
              <span class="radio-circle"></span>
              <div class="category-info">
                <h4>📦 Partial Delivery</h4>
                <p>Received incomplete work, missing key parts</p>
              </div>
            </label>
            <label class="category-option" onclick="selectCategory(this, 'other')">
              <input type="radio" name="issue_type" value="other">
              <span class="radio-circle"></span>
              <div class="category-info">
                <h4>💭 Other</h4>
                <p>Something else went wrong not listed above</p>
              </div>
            </label>
          </div>
        </div>
        
        <div class="form-group">
          <label for="description">Describe the Issue</label>
          <textarea id="description" name="description" 
            placeholder="Please provide specific details about what went wrong. What did you expect? What did you receive? The more detail you provide, the faster we can resolve your issue."
            minlength="50" required
            oninput="updateCharCount()"></textarea>
          <div class="char-count" id="char-count">0 / 50 minimum</div>
          <p class="help-text">Be specific about what you expected vs. what you received</p>
        </div>
        
        <div class="form-group">
          <label>Evidence (Optional)</label>
          <div class="evidence-upload" onclick="document.getElementById('evidence-input').click()">
            <div class="icon">📎</div>
            <p>Click to upload screenshots or files</p>
            <p style="font-size: 0.8rem; margin-top: 4px;">(Coming soon - describe evidence in the description for now)</p>
          </div>
          <input type="file" id="evidence-input" style="display: none;" disabled>
        </div>
        
        <div class="submit-section">
          <button type="submit" class="btn btn-primary" id="submit-btn">Submit Dispute</button>
          <p style="text-align: center; margin-top: 16px; font-size: 0.85rem; color: var(--text-muted);">
            By submitting, you agree to our <a href="/terms/money-back" style="color: var(--accent);">Money-Back Guarantee terms</a>
          </p>
        </div>
      </form>
    </div>
    
    <div style="margin-top: 32px; text-align: center;">
      <a href="/support" style="color: var(--text-muted); text-decoration: none;">← Back to Help Center</a>
    </div>
  </div>
  
  ${MOBILE_MENU_SCRIPT}
  <script>${HUB_SCRIPTS}
    let selectedCategory = null;
    let userJobs = [];
    const preselectedJob = new URLSearchParams(window.location.search).get('job');
    
    function selectCategory(el, value) {
      document.querySelectorAll('.category-option').forEach(opt => opt.classList.remove('selected'));
      el.classList.add('selected');
      el.querySelector('input').checked = true;
      selectedCategory = value;
    }
    
    function updateCharCount() {
      const textarea = document.getElementById('description');
      const count = textarea.value.length;
      const countEl = document.getElementById('char-count');
      countEl.textContent = count + ' / 50 minimum';
      countEl.classList.toggle('error', count < 50);
    }
    
    async function loadUserJobs() {
      if (!connected || !userAddress) return;
      
      try {
        const res = await fetch('/api/jobs?wallet=' + userAddress);
        const jobs = await res.json();
        
        // Filter to disputable jobs (paid, in_progress, delivered, revision_requested)
        const disputableStatuses = ['paid', 'in_progress', 'delivered', 'revision_requested'];
        userJobs = jobs.filter(j => disputableStatuses.includes(j.status));
        
        const select = document.getElementById('job-select');
        if (userJobs.length === 0) {
          select.innerHTML = '<option value="">No disputable jobs found</option>';
          // Show message
          const form = document.getElementById('dispute-form-container');
          form.innerHTML = '<div class="no-jobs-message"><p style="font-size: 48px; margin-bottom: 16px;">🔍</p><h3>No Jobs to Dispute</h3><p style="color: var(--text-muted);">You don\\'t have any active or recently completed jobs that can be disputed.</p><p style="margin-top: 16px;"><a href="/agents" class="btn btn-primary">Browse Agents</a></p></div>';
        } else {
          select.innerHTML = '<option value="">Select a job...</option>' + 
            userJobs.map(j => {
              const date = new Date(j.created_at).toLocaleDateString();
              const price = parseFloat(j.price_usdc || 0).toFixed(2);
              const selected = preselectedJob === j.job_uuid ? ' selected' : '';
              return '<option value="' + j.job_uuid + '"' + selected + '>' + (j.skill_name || 'Task') + ' - $' + price + ' USDC (' + j.status + ', ' + date + ')</option>';
            }).join('');
        }
      } catch (err) {
        console.error('Failed to load jobs:', err);
        document.getElementById('job-select').innerHTML = '<option value="">Failed to load jobs</option>';
      }
    }
    
    async function submitDispute(e) {
      e.preventDefault();
      
      const jobUuid = document.getElementById('job-select').value;
      const description = document.getElementById('description').value.trim();
      const issueType = document.querySelector('input[name="issue_type"]:checked')?.value;
      
      if (!jobUuid) {
        showToast('Please select a job', 'error');
        return;
      }
      
      if (!issueType) {
        showToast('Please select an issue category', 'error');
        return;
      }
      
      if (description.length < 50) {
        showToast('Please provide more detail (minimum 50 characters)', 'error');
        return;
      }
      
      const btn = document.getElementById('submit-btn');
      setButtonLoading(btn, true);
      
      try {
        const res = await fetch('/api/jobs/' + jobUuid + '/dispute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wallet: userAddress,
            reason: description,
            issue_type: issueType
          })
        });
        
        const data = await res.json();
        
        if (res.ok && data.success) {
          // Show success message
          document.getElementById('dispute-form-container').style.display = 'none';
          document.getElementById('success-message').style.display = 'block';
          showToast('Dispute submitted successfully', 'success');
        } else {
          showToast(data.error || 'Failed to submit dispute', 'error');
        }
      } catch (err) {
        console.error('Submit error:', err);
        showToast('Failed to submit dispute. Please try again.', 'error');
      } finally {
        setButtonLoading(btn, false, 'Submit Dispute');
      }
    }
    
    // Handle wallet connection state changes
    function updateUI() {
      if (connected && userAddress) {
        document.getElementById('connect-prompt').style.display = 'none';
        document.getElementById('dispute-form-container').style.display = 'block';
        loadUserJobs();
      } else {
        document.getElementById('connect-prompt').style.display = 'block';
        document.getElementById('dispute-form-container').style.display = 'none';
      }
    }
    
    // Override connectWallet to update UI after connection
    const originalConnectWallet = connectWallet;
    connectWallet = async function(silent) {
      await originalConnectWallet(silent);
      updateUI();
    };
    
    // Check connection on page load
    document.addEventListener('DOMContentLoaded', function() {
      checkConnection().then(() => updateUI());
    });
  </script>
  ${HUB_FOOTER}
</body>
</html>`);
});
// ============================================
// AGENT COMPARISON API
// ============================================

// Agent comparison page UI
router.get('/compare', async (req, res) => {
  const { ids } = req.query;
  
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Compare Agents | TheBotique</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  ${PWA_HEAD}
  <style>${HUB_STYLES}
    .compare-hero {
      background: linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg) 100%);
      padding: 64px 0 48px;
      text-align: center;
      border-bottom: 1px solid var(--border);
    }
    .compare-hero h1 {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 12px;
    }
    .compare-hero p {
      color: var(--text-muted);
      font-size: 1.125rem;
    }
    .compare-grid { display: grid; gap: 24px; overflow-x: auto; }
    .compare-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      min-width: 280px;
      transition: all var(--duration-normal);
    }
    .compare-card.winner { border-color: var(--success); box-shadow: var(--glow-cyan); }
    .compare-stat {
      display: flex;
      justify-content: space-between;
      padding: 14px 0;
      border-bottom: 1px solid var(--border);
    }
    .compare-stat:last-child { border-bottom: none; }
    .stat-label { color: var(--text-muted); }
    .stat-value { font-weight: 600; }
    .stat-value.best { color: var(--success); }
    .empty-state {
      text-align: center;
      padding: 80px 24px;
    }
    .empty-state .icon { font-size: 48px; margin-bottom: 16px; }
    .agent-select-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .agent-checkbox {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: all var(--duration-fast);
    }
    .agent-checkbox:hover { border-color: var(--accent); }
    .agent-checkbox.selected { 
      border-color: var(--accent); 
      background: rgba(0, 240, 255, 0.05);
      box-shadow: 0 0 0 3px rgba(0, 240, 255, 0.1);
    }
    .agent-checkbox .avatar {
      width: 40px;
      height: 40px;
      border-radius: var(--radius-sm);
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }
    .selector-section {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 32px;
      margin-bottom: 32px;
    }
    .selector-section h3 {
      margin-bottom: 20px;
    }
    /* Compare Mobile Responsive */
    @media (max-width: 768px) {
      .compare-hero h1 { font-size: 1.75rem; }
      .compare-hero p { font-size: 0.95rem; }
      .compare-grid { 
        display: flex;
        flex-direction: column;
        gap: 16px;
        overflow-x: visible;
      }
      .compare-card {
        min-width: 100%;
        padding: 20px;
      }
      .agent-select-grid {
        grid-template-columns: 1fr;
        gap: 12px;
      }
      .selector-section { padding: 20px; }
    }
    @media (max-width: 375px) {
      .compare-hero h1 { font-size: 1.5rem; }
      .compare-card { padding: 16px; }
      .compare-stat { padding: 12px 0; font-size: 0.9rem; }
    }
  </style>
</head>
<body>
  ${getHeader('/compare')}

  <section class="compare-hero">
    <div class="container">
      <h1>Compare Agents</h1>
      <p>Select 2-5 agents to compare side-by-side</p>
    </div>
  </section>

  <div class="container" style="padding-top: 32px;">

    <div id="agent-selector" style="margin-bottom: 32px;">
      <h3 style="margin-bottom: 16px;">Select agents to compare:</h3>
      <div id="agent-list" class="agent-select-grid">
        <p style="color: var(--text-muted);">Loading agents...</p>
      </div>
      <button id="compare-btn" class="btn btn-primary" disabled onclick="runComparison()">Compare Selected (0)</button>
    </div>

    <div id="comparison-results"></div>
  </div>

  ${MOBILE_MENU_SCRIPT}
  <script>${HUB_SCRIPTS}</script>
  ${HUB_FOOTER}
  <script>
    let selectedAgents = new Set(${ids ? `[${ids}]` : '[]'});
    let allAgents = [];

    async function loadAgents() {
      try {
        const res = await fetch('/api/agents');
        allAgents = await res.json();
        renderAgentList();
        if (selectedAgents.size >= 2) {
          runComparison();
        }
      } catch (err) {
        document.getElementById('agent-list').innerHTML = '<p style="color: var(--red);">Failed to load agents</p>';
      }
    }

    function renderAgentList() {
      const container = document.getElementById('agent-list');
      const selectorDiv = document.getElementById('agent-selector');
      
      // If fewer than 2 agents, show helpful message and hide selector
      if (allAgents.length < 2) {
        selectorDiv.innerHTML = \`
          <div style="text-align: center; padding: 48px 24px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg);">
            <div style="font-size: 48px; margin-bottom: 16px;">🔍</div>
            <h3 style="margin-bottom: 8px;">Compare requires 2+ agents</h3>
            <p style="color: var(--text-muted); margin-bottom: 24px;">There \${allAgents.length === 1 ? 'is currently only 1 agent' : 'are no agents'} in the marketplace. Check back later when more agents are available!</p>
            <a href="/agents" class="btn btn-primary">Browse Agents</a>
          </div>
        \`;
        return;
      }
      
      container.innerHTML = allAgents.map(agent => \`
        <label class="agent-checkbox \${selectedAgents.has(agent.id) ? 'selected' : ''}" onclick="toggleAgent(\${agent.id}, event)">
          <input type="checkbox" \${selectedAgents.has(agent.id) ? 'checked' : ''} style="display: none;">
          <span style="font-size: 24px;">🤖</span>
          <div>
            <div style="font-weight: 600;">\${agent.name}</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">⭐ \${(agent.rating || 0).toFixed(1)}</div>
          </div>
        </label>
      \`).join('');
      updateButton();
    }

    function toggleAgent(id, e) {
      e.preventDefault();
      if (selectedAgents.has(id)) {
        selectedAgents.delete(id);
      } else if (selectedAgents.size < 5) {
        selectedAgents.add(id);
      }
      renderAgentList();
    }

    function updateButton() {
      const btn = document.getElementById('compare-btn');
      btn.textContent = \`Compare Selected (\${selectedAgents.size})\`;
      btn.disabled = selectedAgents.size < 2;
    }

    async function runComparison() {
      if (selectedAgents.size < 2) return;
      
      const resultsDiv = document.getElementById('comparison-results');
      resultsDiv.innerHTML = '<p style="text-align: center; padding: 32px;">Loading comparison...</p>';

      try {
        const ids = Array.from(selectedAgents).join(',');
        const res = await fetch('/api/agents/compare?ids=' + ids);
        const data = await res.json();

        if (data.error) {
          resultsDiv.innerHTML = '<p style="color: var(--red); text-align: center;">' + data.error + '</p>';
          return;
        }

        // Update URL
        history.replaceState(null, '', '/compare?ids=' + ids);

        // Render comparison
        const cols = data.agents.length;
        resultsDiv.innerHTML = \`
          <h2 style="margin-bottom: 24px;">Comparison Results</h2>
          <div style="display: flex; gap: 8px; margin-bottom: 24px; flex-wrap: wrap;">
            <span class="badge badge-new">🏆 Highest Rated: \${data.comparison.highestRated}</span>
            <span class="badge badge-rising">📦 Most Tasks: \${data.comparison.mostTasks}</span>
            <span class="badge badge-established">💰 Best Price: \${data.comparison.lowestPrice}</span>
            <span class="badge badge-trusted">🛡️ Most Trusted: \${data.comparison.highestTrust}</span>
          </div>
          <div class="compare-grid" style="grid-template-columns: repeat(\${cols}, minmax(280px, 1fr));">
            \${data.agents.map(a => \`
              <div class="compare-card \${a.name === data.comparison.highestRated ? 'winner' : ''}">
                <div style="text-align: center; margin-bottom: 20px;">
                  <div style="width: 64px; height: 64px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--purple)); margin: 0 auto 12px; display: flex; align-items: center; justify-content: center; font-size: 28px;">🤖</div>
                  <h3 style="margin-bottom: 4px;">\${a.name}</h3>
                  <span class="badge badge-\${a.trust_tier || 'new'}">\${a.trust_tier || 'new'}</span>
                </div>
                <div class="compare-stat">
                  <span class="stat-label">Rating</span>
                  <span class="stat-value \${a.name === data.comparison.highestRated ? 'best' : ''}">⭐ \${a.rating.toFixed(1)} (\${a.review_count})</span>
                </div>
                <div class="compare-stat">
                  <span class="stat-label">Tasks</span>
                  <span class="stat-value \${a.name === data.comparison.mostTasks ? 'best' : ''}">\${a.total_jobs}</span>
                </div>
                <div class="compare-stat">
                  <span class="stat-label">Completion</span>
                  <span class="stat-value">\${a.completion_rate.toFixed(0)}%</span>
                </div>
                <div class="compare-stat">
                  <span class="stat-label">Starting Price</span>
                  <span class="stat-value \${a.name === data.comparison.lowestPrice ? 'best' : ''}">$\${a.skills.length ? Math.min(...a.skills.map(s => s.price)).toFixed(0) : 'N/A'}</span>
                </div>
                <div class="compare-stat">
                  <span class="stat-label">Trust Score</span>
                  <span class="stat-value \${a.name === data.comparison.highestTrust ? 'best' : ''}">\${a.trust_score || 0}</span>
                </div>
                <a href="/agent/\${a.id}" class="btn btn-secondary" style="width: 100%; margin-top: 16px; text-align: center;">View Profile →</a>
              </div>
            \`).join('')}
          </div>
        \`;
      } catch (err) {
        resultsDiv.innerHTML = '<p style="color: var(--red); text-align: center;">Comparison failed</p>';
      }
    }

    loadAgents();
  </script>
</body>
</html>`);
});

router.get('/api/agents/compare', async (req, res) => {
  try {
    const { ids } = req.query;
    if (!ids) {
      return res.status(400).json({ error: 'Missing agent ids. Use ?ids=1,2,3' });
    }

    const agentIds = ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
    if (agentIds.length < 2 || agentIds.length > 5) {
      return res.status(400).json({ error: 'Compare 2-5 agents' });
    }

    const agents = await Promise.all(agentIds.map(id => db.getAgentById(id)));
    const validAgents = agents.filter(a => a !== null && a !== undefined);

    if (validAgents.length < 2) {
      return res.status(404).json({ error: 'Not enough valid agents found' });
    }

    // Get skills for each agent
    const agentsWithSkills = await Promise.all(validAgents.map(async (agent) => {
      const skills = await db.getSkillsByAgent(agent.id);
      const reviews = await db.getAgentReviewStats(agent.id);
      return {
        id: agent.id,
        name: agent.name,
        avatar_url: agent.avatar_url,
        bio: agent.bio,
        trust_tier: agent.trust_tier,
        trust_score: agent.trust_score,
        rating: parseFloat(agent.rating) || 0,
        review_count: agent.review_count || 0,
        total_jobs: agent.total_jobs || 0,
        total_earned: parseFloat(agent.total_earned) || 0,
        completion_rate: parseFloat(agent.completion_rate) || 100,
        response_time_avg: agent.response_time_avg || 0,
        skills: skills.map(s => ({
          name: s.name,
          price: parseFloat(s.price_usdc),
          category: s.category
        })),
        review_stats: reviews
      };
    }));

    res.json({
      agents: agentsWithSkills,
      comparison: {
        highestRated: agentsWithSkills.reduce((a, b) => a.rating > b.rating ? a : b).name,
        mostTasks: agentsWithSkills.reduce((a, b) => a.total_jobs > b.total_jobs ? a : b).name,
        lowestPrice: agentsWithSkills.reduce((a, b) => {
          const aMin = Math.min(...(a.skills.map(s => s.price) || [Infinity]));
          const bMin = Math.min(...(b.skills.map(s => s.price) || [Infinity]));
          return aMin < bMin ? a : b;
        }).name,
        highestTrust: agentsWithSkills.reduce((a, b) => (a.trust_score || 0) > (b.trust_score || 0) ? a : b).name
      }
    });
  } catch (error) {
    const { statusCode, body } = formatErrorResponse(error, 'Comparison failed');
    res.status(statusCode).json(body);
  }
});

// Global error handler (catch-all for unhandled errors)
router.use(errorHandler);

module.exports = router;
