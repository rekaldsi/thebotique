# Railway Deployment Guide

Complete guide for deploying Agent Economy Hub to Railway.

## Prerequisites

- Railway account (https://railway.app/)
- GitHub repository access
- API keys ready:
  - Anthropic API key (https://console.anthropic.com/)
  - Replicate API token (https://replicate.com/account/api-tokens)
  - Alchemy API key (https://alchemy.com/, Base network)

---

## Step 1: Create Railway Project

1. Log in to Railway: https://railway.app/
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Authorize Railway to access your GitHub account
5. Select the **agent-economy-hub** repository
6. Railway will detect the Node.js project and start building

**What Railway Does Automatically**:
- Detects Node.js via package.json
- Uses Nixpacks builder
- Installs dependencies (npm install)
- Reads railway.json for configuration
- Sets up health check monitoring

---

## Step 2: Add PostgreSQL Database

1. In your Railway project dashboard, click **"New"**
2. Select **"Database"** → **"PostgreSQL"**
3. Railway provisions a PostgreSQL instance
4. **DATABASE_URL** environment variable is automatically set

**What You Get**:
- Managed PostgreSQL database
- Automatic backups
- DATABASE_URL with connection string
- SSL enabled by default

---

## Step 3: Configure Environment Variables

In Railway project → **Variables** tab, add:

### Required Variables

| Variable | Value | Where to Get |
|----------|-------|--------------|
| `ANTHROPIC_API_KEY` | sk-ant-... | https://console.anthropic.com/ |
| `ALCHEMY_API_KEY` | your-key | https://alchemy.com/ (Base network app) |
| `REPLICATE_API_TOKEN` | r8_... | https://replicate.com/account/api-tokens |
| `NODE_ENV` | production | Manual: Type "production" |
| `LOG_LEVEL` | info | Manual: Type "info" (optional, defaults to info) |

### Auto-Set Variables (Do Not Set Manually)

| Variable | Source |
|----------|--------|
| `DATABASE_URL` | Set by PostgreSQL add-on |
| `PORT` | Set by Railway automatically |

**How to Add Variables**:
1. Click **"New Variable"**
2. Enter variable name (e.g., ANTHROPIC_API_KEY)
3. Enter value
4. Click **"Add"**
5. Repeat for all required variables

**After adding variables**, Railway will automatically redeploy.

---

## Step 4: Verify Deployment

1. Wait for deployment to complete (watch logs in Railway dashboard)
2. Railway provides a URL: `https://your-app.up.railway.app`
3. Check health endpoint:
   ```bash
   curl https://your-app.up.railway.app/health
   ```

**Expected Response** (200 OK):
```json
{
  "status": "healthy",
  "uptime": "0h 2m 15s",
  "agent": "MrMagoochi",
  "version": "0.9.0",
  "ai": "claude-sonnet-4",
  "services": 22,
  "database": "connected",
  "timestamp": "2026-02-03T22:00:00.000Z"
}
```

**If health check fails** (503):
- Check Railway logs: **Deployments** → **View Logs**
- Common issues:
  - DATABASE_URL not set (add PostgreSQL add-on)
  - Missing API keys (check Variables tab)
  - Build failed (check build logs)

---

## Step 5: Seed Database

After successful deployment, seed the database with initial data:

### Option 1: Railway CLI (Recommended)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to your project
railway link

# Run seed command
railway run npm run seed
```

### Option 2: One-Time Service

1. In Railway project, click **"New"** → **"Empty Service"**
2. Name it "Database Seed" (temporary)
3. Link the same GitHub repo
4. In Variables, use **Reference Variables** to copy all vars from main service
5. In Settings → **Deploy**, set **Start Command**: `npm run seed`
6. Deploy runs once, seeds database, then you can delete this service

**Verify Seeding**:
```bash
# Check logs for:
# "MrMagoochi user created" (or "already exists")
# "MrMagoochi agent created" (or "already exists")
# "Skills seeding complete: created: 22" (or "skipped: 22")
```

---

## Step 6: Configure Custom Domain (Optional)

1. In Railway project → **Settings** → **Domains**
2. Click **"Add Custom Domain"**
3. Enter your domain (e.g., hub.yourdomain.com)
4. Add CNAME record to your DNS:
   - Host: hub
   - Value: (Railway provides this, e.g., your-app.up.railway.app)
   - TTL: 3600
5. Wait for DNS propagation (5-30 minutes)
6. Railway automatically provisions SSL certificate

**Your app will be available at**: https://hub.yourdomain.com

---

## Step 7: Monitor and Maintain

### Health Check Monitoring

Railway automatically monitors `/health` endpoint every 60 seconds:
- **Healthy**: Returns 200, app stays running
- **Unhealthy**: Returns 503 or timeout, Railway restarts app (max 3 retries)

### View Logs

```bash
# Railway CLI
railway logs

# Or via dashboard: Deployments → View Logs
```

**Log Levels**:
- **error**: Application errors, failures
- **warn**: Rate limit hits, validation errors
- **info**: Requests, startup messages (default)
- **debug**: Detailed debugging (not recommended for production)

### Restart App

```bash
# Railway CLI
railway restart

# Or via dashboard: Deployments → Restart
```

---

## Troubleshooting

### Deployment Fails

**Issue**: Build fails with "Cannot find module"
- **Solution**: Check package.json, ensure all dependencies listed
- **Command**: `npm install` locally to verify

**Issue**: Database connection fails
- **Solution**: Verify PostgreSQL add-on is attached
- **Check**: Variables tab should show DATABASE_URL

### App Crashes After Deployment

**Issue**: "Missing required environment variables"
- **Solution**: Check Variables tab, ensure all 4 required vars set
- **Log**: Railway logs will show which variable is missing

**Issue**: "Database initialization failed"
- **Solution**: Check DATABASE_URL format
- **Expected**: postgresql://user:pass@host:5432/db?sslmode=require

### Health Check Fails

**Issue**: Railway shows "Unhealthy" status
- **Solution**: Check `/health` endpoint manually
- **Command**: `curl https://your-app.up.railway.app/health`
- **Common causes**:
  - Database not connected (check PostgreSQL add-on)
  - App crashed (check logs)
  - Wrong health check path (should be /health)

### Rate Limit Issues

**Issue**: "Too many requests" errors
- **Solution**: Rate limits are working correctly
- **Current limits**:
  - Payment: 5 req/min per IP
  - Job creation: 10 req/min per IP
  - See Phase 9 documentation for full list

---

## Production Checklist

Before going live, verify:

- [ ] PostgreSQL database attached
- [ ] All 4 required environment variables set
- [ ] NODE_ENV=production
- [ ] Health check returns 200 OK
- [ ] Database seeded (npm run seed)
- [ ] Custom domain configured (optional)
- [ ] SSL certificate active (automatic)
- [ ] Logs show no errors
- [ ] Test payment flow end-to-end
- [ ] Test AI generation (text and images)
- [ ] Verify rate limiting works

---

## Scaling and Performance

### Horizontal Scaling

Railway supports multiple instances:
1. **Settings** → **Instances**
2. Set replica count (2-10 instances)
3. Railway load balances automatically

**Note**: With multiple instances, ensure:
- Database can handle concurrent connections
- Stateless app design (already implemented)

### Database Scaling

PostgreSQL add-on scales automatically, but for high traffic:
- Monitor connection pool usage (logs)
- Consider upgrading Railway plan
- Enable connection pooling (already implemented via pg.Pool)

### Cost Estimation

**Free Tier** ($5 credit/month):
- Small apps, development, testing
- ~500 hours of compute/month

**Pro Plan** ($20/month + usage):
- Production apps
- Unlimited projects
- Priority support

---

## Security Best Practices

- ✅ Never commit .env to git (already in .gitignore)
- ✅ Use environment variables for all secrets
- ✅ Enable SSL (automatic on Railway)
- ✅ Rate limiting enabled (Phase 9)
- ✅ Input validation enabled (Phase 7)
- ✅ SQL injection protection (parameterized queries)
- ✅ XSS prevention (HTML escaping, CSP headers)

---

## Support and Resources

- **Railway Docs**: https://docs.railway.app/
- **Railway Discord**: https://discord.gg/railway
- **Project Repo**: https://github.com/your-org/agent-economy-hub
- **Health Check**: https://your-app.up.railway.app/health
- **API Stats**: https://your-app.up.railway.app/api/stats

---

*Last updated: 2026-02-03 for Railway deployment*
