const logger = require('./logger');
const startTime = Date.now();

// Track request counts
const requestCounts = {
  total: 0,
  byMethod: {},
  byPath: {},
  byStatus: {}
};

function incrementRequestCount(method, path, status) {
  requestCounts.total++;
  requestCounts.byMethod[method] = (requestCounts.byMethod[method] || 0) + 1;
  requestCounts.byPath[path] = (requestCounts.byPath[path] || 0) + 1;
  requestCounts.byStatus[status] = (requestCounts.byStatus[status] || 0) + 1;
}

function getStats() {
  const uptime = Date.now() - startTime;
  return {
    uptime: {
      ms: uptime,
      seconds: Math.floor(uptime / 1000),
      minutes: Math.floor(uptime / 60000),
      hours: Math.floor(uptime / 3600000)
    },
    requests: requestCounts,
    memory: process.memoryUsage(),
    nodeVersion: process.version,
    platform: process.platform
  };
}

function resetStats() {
  requestCounts.total = 0;
  requestCounts.byMethod = {};
  requestCounts.byPath = {};
  requestCounts.byStatus = {};
  logger.info('Stats reset');
}

// --- arrival attribution --------------------------------------------------
// Where agent-relevant requests come from, so "how did an agent find us" is
// answerable. Kept in memory and server-side only: exposed through the
// token-gated /api/arrivals, never on the public /activity page. Referer and
// user-agent are self-reported, so this is a diagnostic signal, not proof.
const AGENT_PATHS = ['/mcp', '/skill.md', '/llms.txt', '/.well-known/http-message-signatures-directory'];
const arrivals = { total: 0, byReferer: {}, byUa: {}, byPath: {} };

function uaFamily(ua) {
  if (!ua) return '(none)';
  const s = String(ua);
  const m = s.match(/(GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-User|PerplexityBot|Googlebot|Google-Extended|Applebot|Bingbot|CCBot|python-requests|node-fetch|axios|curl|Go-http-client|okhttp|undici|Python|Node)/i);
  return m ? m[1] : s.slice(0, 48);
}
function refererHost(ref) {
  if (!ref) return '(direct)';
  try { return new URL(ref).host || '(direct)'; } catch { return '(other)'; }
}
function bump(obj, key) { obj[key] = (obj[key] || 0) + 1; }

function recordArrival(path, referer, ua) {
  if (!AGENT_PATHS.some((p) => path === p || path.startsWith(p + '/'))) return;
  arrivals.total++;
  bump(arrivals.byReferer, refererHost(referer));
  bump(arrivals.byUa, uaFamily(ua));
  bump(arrivals.byPath, path);
}
function getArrivals() { return arrivals; }

module.exports = {
  incrementRequestCount,
  getStats,
  resetStats,
  recordArrival,
  getArrivals
};
