# Railway Configuration Explained

## railway.json

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "node src/index.js",
    "healthcheckPath": "/health",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

### Configuration Details

**Builder: NIXPACKS**
- Automatic Node.js detection via package.json
- Installs dependencies with `npm install`
- No custom build steps needed
- Alternative: DOCKERFILE (if you need custom build)

**Start Command: node src/index.js**
- Runs the Express server
- Matches package.json "start" script
- No process manager needed (Railway handles restarts)

**Health Check Path: /health**
- Railway polls this endpoint every 60 seconds
- Endpoint must return 200 for healthy status
- Returns 503 if database connection fails
- See Phase 9 documentation for implementation details

**Restart Policy: ON_FAILURE**
- Restarts app if it crashes or becomes unhealthy
- Max retries: 3 attempts
- After 3 failed restarts, app stays down (manual intervention needed)
- Alternative: ALWAYS (restarts even on clean exit, not recommended)

### Why These Settings Work

1. **NIXPACKS**: Detects Node.js automatically, no config needed
2. **Health Check**: Our /health endpoint tests DB connection and returns proper status codes
3. **Restart Policy**: ON_FAILURE prevents infinite restart loops while recovering from transient issues
4. **Max Retries: 3**: Balances automatic recovery with preventing runaway restarts

### When to Modify

**Change builder to DOCKERFILE if**:
- Need custom system dependencies (e.g., ImageMagick, FFmpeg)
- Need multi-stage builds
- Need specific Node.js version not detected by Nixpacks

**Change health check path if**:
- Using different endpoint for health checks
- Need custom health check logic

**Change restart policy to ALWAYS if**:
- App intentionally exits and should always restart
- Not recommended for our use case

**Increase max retries if**:
- Database connections are slow to establish
- External service dependencies are unreliable
- Current setting (3) is usually sufficient

---

## Optional: Environment-Specific Configuration

Railway doesn't support multiple railway.json files, but you can use environment variables:

```javascript
// In src/index.js (already implemented)
const PORT = process.env.PORT || 7378;
const NODE_ENV = process.env.NODE_ENV || 'development';
```

Set these in Railway dashboard → Variables:
- NODE_ENV=production
- LOG_LEVEL=info (or warn for less verbose logging)
