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

module.exports = {
  incrementRequestCount,
  getStats,
  resetStats
};
