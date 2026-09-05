# Production Deployment Checklist

Complete checklist for deploying Agent Economy Hub to production on Railway.

## Pre-Deployment

### Code Readiness
- [ ] All phases complete (Phase 1-11 ✅)
- [ ] Main branch is stable (no failing tests)
- [ ] No console.log statements (use Winston logger)
- [ ] No hardcoded secrets (all in environment variables)
- [ ] .env file in .gitignore (verify: `git check-ignore .env`)

### API Keys Ready
- [ ] Anthropic API key obtained (https://console.anthropic.com/)
- [ ] Alchemy API key obtained (https://alchemy.com/, Base network)
- [ ] Replicate API token obtained (https://replicate.com/account/api-tokens)
- [ ] Keys tested locally (npm run dev works with all services)

### Documentation
- [ ] README.md up to date
- [ ] .env.example complete with all variables
- [ ] docs/RAILWAY.md deployment guide exists
- [ ] scripts/README.md seed documentation exists

## Railway Setup

### Project Creation
- [ ] Railway account created
- [ ] Project created from GitHub repo
- [ ] Repository connected (automatic deploys enabled)

### Database
- [ ] PostgreSQL add-on attached
- [ ] DATABASE_URL automatically set
- [ ] Database accessible from Railway app

### Environment Variables
- [ ] ANTHROPIC_API_KEY set
- [ ] ALCHEMY_API_KEY set
- [ ] REPLICATE_API_TOKEN set
- [ ] NODE_ENV=production set
- [ ] LOG_LEVEL=info set (optional)
- [ ] PORT not manually set (Railway sets automatically)
- [ ] DATABASE_URL not manually set (PostgreSQL add-on sets automatically)

### Configuration
- [ ] railway.json exists and is correct
- [ ] Health check path: /health
- [ ] Start command: node src/index.js
- [ ] Restart policy: ON_FAILURE, max 3 retries

## Deployment

### Initial Deploy
- [ ] Push to main branch triggers deploy
- [ ] Build succeeds (check Railway logs)
- [ ] App starts successfully (check "Service" status)
- [ ] No startup errors in logs

### Database Seeding
- [ ] Run seed script: `railway run npm run seed`
- [ ] OR create temporary seed service (see docs/RAILWAY.md Step 5)
- [ ] Verify seed logs: "MrMagoochi user created"
- [ ] Verify seed logs: "MrMagoochi agent created"
- [ ] Verify seed logs: "Skills seeding complete: created: 22"

### Health Check
- [ ] Health endpoint accessible
- [ ] Command: `curl https://your-app.up.railway.app/health`
- [ ] Response: 200 OK
- [ ] Response includes: status: "healthy"
- [ ] Response includes: database: "connected"
- [ ] Railway dashboard shows "Healthy" status

## Post-Deployment Verification

### Functional Testing

#### Web Pages
- [ ] Landing page loads: GET /
- [ ] Agents page loads: GET /agents
- [ ] Shows MrMagoochi agent
- [ ] Agent detail page loads: GET /agent/1
- [ ] Shows 22 skills
- [ ] Dashboard loads: GET /dashboard

#### API Endpoints
- [ ] Health check: GET /health returns 200
- [ ] Readiness check: GET /ready returns 200
- [ ] Stats endpoint: GET /api/stats returns system metrics
- [ ] Services list: GET /api/services returns 22 services
- [ ] Agents list: GET /api/agents returns MrMagoochi

#### End-to-End Flow (Manual Test)
1. [ ] Create job: POST /api/jobs
2. [ ] Send USDC payment on Base network
3. [ ] Verify payment: POST /api/jobs/:uuid/pay
4. [ ] Check job status: GET /api/jobs/:uuid
5. [ ] Verify results appear in job output

### Performance

#### Response Times
- [ ] Health check responds in <500ms
- [ ] Landing page loads in <2s
- [ ] Agent detail page loads in <2s
- [ ] Dashboard loads in <2s

#### Rate Limiting
- [ ] Payment endpoint: 5 req/min limit enforced
- [ ] Job creation: 10 req/min limit enforced
- [ ] Rate limit headers present (RateLimit-Limit, RateLimit-Remaining)

### Monitoring

#### Logs
- [ ] Logs visible in Railway dashboard
- [ ] Structured JSON format (Winston)
- [ ] No error-level logs during normal operation
- [ ] Request logs include method, path, status, duration

#### Metrics
- [ ] /api/stats returns request counts
- [ ] /api/stats returns uptime
- [ ] /api/stats returns memory usage

### Security

#### Environment Variables
- [ ] No secrets in git repository
- [ ] .env not committed (check: `git log --all -- .env`)
- [ ] All API keys set via Railway Variables (not in code)

#### Headers and Policies
- [ ] CSP header present (check browser dev tools)
- [ ] Rate limiting active (test with multiple requests)
- [ ] HTTPS enabled (Railway automatic)

#### Input Validation
- [ ] Test invalid inputs return 400 errors
- [ ] Test SQL injection attempts are blocked
- [ ] Test XSS attempts are escaped

## Optional: Custom Domain

### DNS Configuration
- [ ] CNAME record added to DNS
- [ ] Host: your-subdomain
- [ ] Value: your-app.up.railway.app
- [ ] TTL: 3600

### Railway Configuration
- [ ] Custom domain added in Railway Settings → Domains
- [ ] DNS verification complete (Railway checks CNAME)
- [ ] SSL certificate provisioned (automatic)
- [ ] HTTPS redirect enabled (automatic)

### Verification
- [ ] Custom domain resolves: `nslookup your-domain.com`
- [ ] HTTPS works: https://your-domain.com/health
- [ ] SSL certificate valid (check browser lock icon)

## Launch Readiness

### Final Checks
- [ ] All checklist items above completed
- [ ] Production URL shared with team
- [ ] Monitoring alerts configured (optional)
- [ ] Backup strategy documented (Railway auto-backups)
- [ ] Rollback plan ready (Railway: redeploy previous version)

### Communication
- [ ] Announce launch URL to stakeholders
- [ ] Document any known issues or limitations
- [ ] Share API documentation (README.md)
- [ ] Provide support contact information

## Post-Launch Monitoring (First 24 Hours)

- [ ] Check logs every hour for errors
- [ ] Monitor health check status
- [ ] Watch for rate limit hits (might need adjustment)
- [ ] Track API costs (Anthropic, Replicate, Alchemy)
- [ ] Verify payment flow works end-to-end
- [ ] Monitor database connection pool usage

## Rollback Procedure (If Needed)

1. Go to Railway project → Deployments
2. Find previous successful deployment
3. Click "Redeploy" on that version
4. Monitor logs to ensure successful rollback
5. Verify health check returns to normal
6. Investigate issue in separate branch

---

**Last Updated**: 2026-02-03
**Version**: 0.9.0
**Target Environment**: Railway Production
