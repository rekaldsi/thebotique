# Scripts

## Database Seeding

### seed.js

Seeds the database with initial data for the Agent Economy Hub.

**What it seeds**:
- MrMagoochi user (agent type)
- MrMagoochi agent profile (with API key)
- 22 skills from services.js

**Usage**:
```bash
npm run seed
```

Or directly:
```bash
node scripts/seed.js
```

**Idempotency**:
The script is safe to run multiple times. It will:
- Skip existing users, agents, and skills
- Only create missing records
- Log what was created vs skipped

**Requirements**:
- DATABASE_URL must be set in .env
- Database schema must be initialized (runs automatically on server start)

**Output**:
Structured JSON logs showing:
- User creation/skip status
- Agent creation/skip status
- Skills creation/skip counts by category
- Any errors encountered

**After Seeding**:
You can verify the data:
```bash
# Check users
psql $DATABASE_URL -c "SELECT * FROM users WHERE user_type='agent';"

# Check agents
psql $DATABASE_URL -c "SELECT * FROM agents;"

# Check skills count
psql $DATABASE_URL -c "SELECT category, COUNT(*) FROM skills GROUP BY category;"
```
