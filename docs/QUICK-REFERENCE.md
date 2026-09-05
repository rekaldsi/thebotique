# Railway Quick Reference

One-page reference for common Railway deployment tasks.

## URLs

- **Railway Dashboard**: https://railway.app/
- **Project URL**: https://your-app.up.railway.app
- **Health Check**: https://your-app.up.railway.app/health
- **API Stats**: https://your-app.up.railway.app/api/stats

## Environment Variables (Required)

| Variable | Example | Where to Get |
|----------|---------|--------------|
| ANTHROPIC_API_KEY | sk-ant-... | https://console.anthropic.com/ |
| ALCHEMY_API_KEY | abc123... | https://alchemy.com/ (Base network) |
| REPLICATE_API_TOKEN | r8_... | https://replicate.com/account/api-tokens |
| NODE_ENV | production | Manual: Type "production" |

**Auto-Set** (don't set manually):
- DATABASE_URL (from PostgreSQL add-on)
- PORT (from Railway)

## Common Commands

### Railway CLI

```bash
# Install
npm install -g @railway/cli

# Login
railway login

# Link project
railway link

# View logs
railway logs

# Run seed script
railway run npm run seed

# Restart service
railway restart

# Open dashboard
railway open
```

### Manual Deployment

```bash
# Push to main branch
git push origin main

# Railway auto-deploys on push
```

## Quick Health Check

```bash
# Check if app is healthy
curl https://your-app.up.railway.app/health

# Expected: {"status":"healthy","database":"connected",...}
```

## Troubleshooting (5-Minute Debug)

### App Won't Start

1. **Check logs**: Railway → Deployments → View Logs
2. **Common issues**:
   - Missing env var: "Missing required environment variables: [...]"
   - DB not connected: Add PostgreSQL add-on
   - Build failed: Check package.json dependencies

### Health Check Fails (503)

1. **Test manually**: `curl https://your-app.up.railway.app/health`
2. **If timeout**: App crashed, check logs
3. **If "database: disconnected"**: Check PostgreSQL add-on

### Rate Limited (429)

- **Normal behavior**: Rate limits are working
- **Limits**: Payment (5/min), Job creation (10/min), Reads (100/min)
- **Fix**: Wait 60 seconds or increase limits in code

## Deployment Steps (60 Seconds)

1. Create Railway project from GitHub
2. Add PostgreSQL database
3. Set 4 environment variables (see table above)
4. Deploy automatically happens
5. Run: `railway run npm run seed`
6. Verify: `curl https://your-app.up.railway.app/health`

✅ Done!

## Monitoring

**Health**: Railway auto-monitors `/health` every 60s
**Logs**: Railway dashboard → Deployments → View Logs
**Metrics**: https://your-app.up.railway.app/api/stats

## Useful Links

- [Full Deployment Guide](RAILWAY.md)
- [Production Checklist](PRODUCTION-CHECKLIST.md)
- [Railway Docs](https://docs.railway.app/)
- [Project README](../README.md)

---

*For detailed instructions, see [RAILWAY.md](RAILWAY.md)*
