const { Pool } = require('pg');
const crypto = require('crypto');
const logger = require('./logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database schema
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Users table (humans and agents)
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        wallet_address VARCHAR(42) UNIQUE NOT NULL,
        user_type VARCHAR(10) NOT NULL CHECK (user_type IN ('human', 'agent')),
        name VARCHAR(100),
        avatar_url TEXT,
        bio TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Agents table (extends users for agent-specific data)
      CREATE TABLE IF NOT EXISTS agents (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        webhook_url TEXT,
        api_key VARCHAR(64) UNIQUE,
        is_active BOOLEAN DEFAULT true,
        total_jobs INTEGER DEFAULT 0,
        total_earned DECIMAL(18, 6) DEFAULT 0,
        rating DECIMAL(3, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Skills offered by agents
      CREATE TABLE IF NOT EXISTS skills (
        id SERIAL PRIMARY KEY,
        agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        category VARCHAR(50),
        price_usdc DECIMAL(18, 6) NOT NULL,
        estimated_time VARCHAR(50),
        service_key TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Jobs / service requests
      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        job_uuid VARCHAR(36) UNIQUE NOT NULL,
        requester_id INTEGER REFERENCES users(id),
        agent_id INTEGER REFERENCES agents(id),
        skill_id INTEGER REFERENCES skills(id),
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'in_progress', 'delivered', 'completed', 'disputed', 'refunded', 'failed')),
        input_data JSONB,
        output_data JSONB,
        price_usdc DECIMAL(18, 6) NOT NULL,
        payment_tx_hash VARCHAR(66),
        payout_tx_hash VARCHAR(66),
        created_at TIMESTAMP DEFAULT NOW(),
        paid_at TIMESTAMP,
        delivered_at TIMESTAMP,
        completed_at TIMESTAMP
      );

      -- Reviews for completed jobs
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
        reviewer_id INTEGER REFERENCES users(id),
        rating INTEGER CHECK (rating >= 1 AND rating <= 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Webhook delivery log
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id SERIAL PRIMARY KEY,
        job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
        agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
        webhook_url TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        success BOOLEAN NOT NULL,
        status_code INTEGER,
        error TEXT,
        response_body TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Create indexes for performance
      CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_jobs_requester ON jobs(requester_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_agent ON jobs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_skills_agent ON skills(agent_id);
      CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_job ON webhook_deliveries(job_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_agent ON webhook_deliveries(agent_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_success ON webhook_deliveries(success);
    `);

    // Migration: Add service_key column if it doesn't exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'skills' AND column_name = 'service_key'
        ) THEN
          ALTER TABLE skills ADD COLUMN service_key TEXT;
        END IF;
      END $$;
    `);

    // Migration: Populate service_key for existing skills
    await client.query(`
      UPDATE skills
      SET service_key = LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]', '', 'g'))
      WHERE service_key IS NULL
    `);

    // Migration: Enhanced reviews table with breakdown scores
    await client.query(`
      DO $$
      BEGIN
        -- Add quality_score column
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'reviews' AND column_name = 'quality_score'
        ) THEN
          ALTER TABLE reviews ADD COLUMN quality_score INTEGER CHECK (quality_score >= 1 AND quality_score <= 5);
        END IF;
        
        -- Add speed_score column
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'reviews' AND column_name = 'speed_score'
        ) THEN
          ALTER TABLE reviews ADD COLUMN speed_score INTEGER CHECK (speed_score >= 1 AND speed_score <= 5);
        END IF;
        
        -- Add communication_score column
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'reviews' AND column_name = 'communication_score'
        ) THEN
          ALTER TABLE reviews ADD COLUMN communication_score INTEGER CHECK (communication_score >= 1 AND communication_score <= 5);
        END IF;
        
        -- Add agent_response column
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'reviews' AND column_name = 'agent_response'
        ) THEN
          ALTER TABLE reviews ADD COLUMN agent_response TEXT;
        END IF;
        
        -- Add review_count to agents
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'review_count'
        ) THEN
          ALTER TABLE agents ADD COLUMN review_count INTEGER DEFAULT 0;
        END IF;
        
        -- Add completion_rate to agents
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'completion_rate'
        ) THEN
          ALTER TABLE agents ADD COLUMN completion_rate DECIMAL(5,2) DEFAULT 100;
        END IF;
        
        -- Add trust_tier to agents
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'trust_tier'
        ) THEN
          ALTER TABLE agents ADD COLUMN trust_tier VARCHAR(20) DEFAULT 'new';
        END IF;
        
        -- PRD Trust System: Add response_time_avg
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'response_time_avg'
        ) THEN
          ALTER TABLE agents ADD COLUMN response_time_avg INTEGER DEFAULT 0;
        END IF;
        
        -- PRD Trust System: Add security_audit_status
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'security_audit_status'
        ) THEN
          ALTER TABLE agents ADD COLUMN security_audit_status VARCHAR(20) DEFAULT 'none';
        END IF;
        
        -- PRD Trust System: Add security_audit_at
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'security_audit_at'
        ) THEN
          ALTER TABLE agents ADD COLUMN security_audit_at TIMESTAMP;
        END IF;
        
        -- PRD Trust System: Add rentahuman_enabled
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'rentahuman_enabled'
        ) THEN
          ALTER TABLE agents ADD COLUMN rentahuman_enabled BOOLEAN DEFAULT false;
        END IF;
        
        -- PRD Trust System: Add trust_score (0-100)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'trust_score'
        ) THEN
          ALTER TABLE agents ADD COLUMN trust_score INTEGER DEFAULT 0;
        END IF;
        
        -- PRD: Add tagline to agents
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'tagline'
        ) THEN
          ALTER TABLE agents ADD COLUMN tagline VARCHAR(200);
        END IF;
        
        -- Founding Agent flag
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'is_founder'
        ) THEN
          ALTER TABLE agents ADD COLUMN is_founder BOOLEAN DEFAULT false;
        END IF;
        
        -- PRD: Add verification fields to users
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'email'
        ) THEN
          ALTER TABLE users ADD COLUMN email VARCHAR(255);
        END IF;
        
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'email_verified'
        ) THEN
          ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT false;
        END IF;
        
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'identity_verified'
        ) THEN
          ALTER TABLE users ADD COLUMN identity_verified BOOLEAN DEFAULT false;
        END IF;
        
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'x_handle'
        ) THEN
          ALTER TABLE users ADD COLUMN x_handle VARCHAR(50);
        END IF;
        
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'x_verified_at'
        ) THEN
          ALTER TABLE users ADD COLUMN x_verified_at TIMESTAMP;
        END IF;
        
        -- PRD: Add webhook_verified_at to agents
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'webhook_verified_at'
        ) THEN
          ALTER TABLE agents ADD COLUMN webhook_verified_at TIMESTAMP;
        END IF;
        
        -- PRD: Add dispute fields to jobs
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'dispute_reason'
        ) THEN
          ALTER TABLE jobs ADD COLUMN dispute_reason TEXT;
        END IF;
        
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'disputed_at'
        ) THEN
          ALTER TABLE jobs ADD COLUMN disputed_at TIMESTAMP;
        END IF;
        
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'human_verified'
        ) THEN
          ALTER TABLE jobs ADD COLUMN human_verified BOOLEAN DEFAULT false;
        END IF;
      END $$;
    `);

    // Create indexes for reviews
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reviews_job ON reviews(job_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews(reviewer_id);
    `);

    // Migration: Subscription pricing support
    await client.query(`
      DO $$
      BEGIN
        -- Add pricing_model to skills (per_task, hourly, monthly, annual)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'skills' AND column_name = 'pricing_model'
        ) THEN
          ALTER TABLE skills ADD COLUMN pricing_model TEXT DEFAULT 'per_task' CHECK (pricing_model IN ('per_task', 'hourly', 'monthly', 'annual'));
        END IF;
        
        -- Add hourly_rate for hourly pricing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'skills' AND column_name = 'hourly_rate'
        ) THEN
          ALTER TABLE skills ADD COLUMN hourly_rate DECIMAL(18,6);
        END IF;
        
        -- Add monthly_rate for subscription pricing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'skills' AND column_name = 'monthly_rate'
        ) THEN
          ALTER TABLE skills ADD COLUMN monthly_rate DECIMAL(18,6);
        END IF;
      END $$;
    `);

    // Migration: Milestones table for multi-phase tasks
    await client.query(`
      CREATE TABLE IF NOT EXISTS milestones (
        id SERIAL PRIMARY KEY,
        job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        amount_usdc DECIMAL(18,6) NOT NULL,
        order_index INTEGER NOT NULL,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'delivered', 'approved', 'disputed')),
        delivered_at TIMESTAMP,
        approved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_milestones_job ON milestones(job_id);
    `);

    // Migration: Subscriptions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        hirer_wallet TEXT NOT NULL,
        agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
        skill_id INTEGER REFERENCES skills(id) ON DELETE CASCADE,
        plan TEXT CHECK (plan IN ('monthly', 'annual')),
        price_usdc DECIMAL(18,6) NOT NULL,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired')),
        started_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL,
        cancelled_at TIMESTAMP,
        stripe_subscription_id TEXT,
        usage_this_period INTEGER DEFAULT 0,
        usage_limit INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_subscriptions_hirer ON subscriptions(hirer_wallet);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_agent ON subscriptions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
    `);

    // Migration: Team accounts (Phase 3)
    await client.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        owner_wallet TEXT NOT NULL,
        plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS team_members (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        wallet_address TEXT NOT NULL,
        role TEXT DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
        invited_by TEXT,
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(team_id, wallet_address)
      );
      
      CREATE TABLE IF NOT EXISTS team_agents (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(team_id, agent_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_wallet);
      CREATE INDEX IF NOT EXISTS idx_team_members_wallet ON team_members(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_team_agents_team ON team_agents(team_id);
    `);

    // Migration: API keys for SDK access
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'api_key'
        ) THEN
          ALTER TABLE users ADD COLUMN api_key TEXT;
          ALTER TABLE users ADD COLUMN api_key_created_at TIMESTAMP;
          CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);
        END IF;
      END $$;
    `);

    // Migration: Webhook URL on jobs
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'webhook_url'
        ) THEN
          ALTER TABLE jobs ADD COLUMN webhook_url TEXT;
        END IF;
      END $$;
    `);

    // Migration: Agent Certifications (Phase 3)
    await client.query(`
      CREATE TABLE IF NOT EXISTS certifications (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        description TEXT,
        requirements TEXT,
        badge_icon TEXT,
        badge_color TEXT DEFAULT '#f97316',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS agent_certifications (
        id SERIAL PRIMARY KEY,
        agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
        certification_id INTEGER REFERENCES certifications(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
        issued_at TIMESTAMP,
        expires_at TIMESTAMP,
        issued_by TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(agent_id, certification_id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_certs_agent ON agent_certifications(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_certs_status ON agent_certifications(status);
    `);

    // Seed default certifications
    await client.query(`
      INSERT INTO certifications (name, slug, description, badge_icon, badge_color)
      VALUES 
        ('Security Audited', 'security-audit', 'Passed platform security review', '🔒', '#22c55e'),
        ('Fast Responder', 'fast-responder', 'Average response time under 1 hour', '⚡', '#eab308'),
        ('Top Rated', 'top-rated', 'Maintained 4.8+ rating with 50+ reviews', '⭐', '#f97316'),
        ('High Volume', 'high-volume', 'Completed 500+ tasks successfully', '🚀', '#8b5cf6'),
        ('Enterprise Ready', 'enterprise', 'Meets enterprise SLA requirements', '🏢', '#3b82f6')
      ON CONFLICT (slug) DO NOTHING
    `);

    // Migration: Support Tickets (Phase 3)
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id SERIAL PRIMARY KEY,
        ticket_uuid TEXT UNIQUE NOT NULL,
        user_wallet TEXT NOT NULL,
        priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        category TEXT,
        subject TEXT NOT NULL,
        status TEXT DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting', 'resolved', 'closed')),
        assigned_to TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS support_messages (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE CASCADE,
        sender_wallet TEXT NOT NULL,
        sender_type TEXT CHECK (sender_type IN ('user', 'support', 'system')),
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_user ON support_tickets(user_wallet);
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);
    `);

    // Migration: White-Label Deployments (Phase 3)
    await client.query(`
      CREATE TABLE IF NOT EXISTS white_labels (
        id SERIAL PRIMARY KEY,
        owner_wallet TEXT NOT NULL,
        subdomain TEXT UNIQUE,
        custom_domain TEXT UNIQUE,
        company_name TEXT NOT NULL,
        logo_url TEXT,
        primary_color TEXT DEFAULT '#f97316',
        secondary_color TEXT DEFAULT '#8b5cf6',
        plan TEXT DEFAULT 'starter' CHECK (plan IN ('starter', 'growth', 'enterprise')),
        monthly_fee DECIMAL(10,2),
        revenue_share DECIMAL(5,2) DEFAULT 10.00,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
        created_at TIMESTAMP DEFAULT NOW(),
        activated_at TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_whitelabel_owner ON white_labels(owner_wallet);
      CREATE INDEX IF NOT EXISTS idx_whitelabel_domain ON white_labels(custom_domain);
    `);

    // ============================================
    // FUTURE VISION: Multi-Agent Workflows
    // ============================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS workflows (
        id SERIAL PRIMARY KEY,
        workflow_uuid TEXT UNIQUE NOT NULL,
        owner_wallet TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        is_public BOOLEAN DEFAULT false,
        status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
        total_runs INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS workflow_steps (
        id SERIAL PRIMARY KEY,
        workflow_id INTEGER REFERENCES workflows(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL,
        skill_id INTEGER REFERENCES skills(id),
        name TEXT NOT NULL,
        input_template TEXT,
        output_mapping TEXT,
        condition TEXT,
        on_success_step INTEGER,
        on_failure_step INTEGER,
        timeout_seconds INTEGER DEFAULT 300
      );

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id SERIAL PRIMARY KEY,
        run_uuid TEXT UNIQUE NOT NULL,
        workflow_id INTEGER REFERENCES workflows(id) ON DELETE CASCADE,
        triggered_by TEXT NOT NULL,
        status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        current_step INTEGER DEFAULT 1,
        input_data JSONB,
        output_data JSONB,
        started_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP,
        total_cost DECIMAL(18,6) DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS workflow_step_results (
        id SERIAL PRIMARY KEY,
        run_id INTEGER REFERENCES workflow_runs(id) ON DELETE CASCADE,
        step_id INTEGER REFERENCES workflow_steps(id),
        job_uuid TEXT,
        status TEXT,
        input_data JSONB,
        output_data JSONB,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        cost DECIMAL(18,6)
      );

      CREATE INDEX IF NOT EXISTS idx_workflows_owner ON workflows(owner_wallet);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id);
    `);

    // FUTURE VISION: API Marketplace
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_listings (
        id SERIAL PRIMARY KEY,
        listing_uuid TEXT UNIQUE NOT NULL,
        agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        endpoint_base TEXT NOT NULL,
        documentation_url TEXT,
        pricing_model TEXT DEFAULT 'per_call' CHECK (pricing_model IN ('per_call', 'monthly', 'usage_tier')),
        price_per_call DECIMAL(18,6),
        monthly_price DECIMAL(18,6),
        rate_limit INTEGER DEFAULT 1000,
        is_public BOOLEAN DEFAULT true,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
        total_calls INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS api_subscriptions (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER REFERENCES api_listings(id) ON DELETE CASCADE,
        subscriber_wallet TEXT NOT NULL,
        api_key TEXT UNIQUE NOT NULL,
        plan TEXT,
        calls_this_month INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(listing_id, subscriber_wallet)
      );

      CREATE TABLE IF NOT EXISTS api_calls (
        id SERIAL PRIMARY KEY,
        subscription_id INTEGER REFERENCES api_subscriptions(id) ON DELETE CASCADE,
        endpoint TEXT,
        status_code INTEGER,
        latency_ms INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_api_listings_agent ON api_listings(agent_id);
      CREATE INDEX IF NOT EXISTS idx_api_subs_wallet ON api_subscriptions(subscriber_wallet);
    `);

    // Phase 2: Webhooks registration table
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id SERIAL PRIMARY KEY,
        agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events TEXT[] DEFAULT ARRAY['job.*'],
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        last_triggered_at TIMESTAMP,
        failure_count INTEGER DEFAULT 0
      );
      
      CREATE INDEX IF NOT EXISTS idx_webhooks_agent ON webhooks(agent_id);
      CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(is_active);
    `);

    // Phase 2: Add on_time_rate and dispute_rate to agents
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'on_time_rate'
        ) THEN
          ALTER TABLE agents ADD COLUMN on_time_rate DECIMAL(5,2) DEFAULT 100;
        END IF;
        
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'dispute_rate'
        ) THEN
          ALTER TABLE agents ADD COLUMN dispute_rate DECIMAL(5,2) DEFAULT 0;
        END IF;
        
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'repeat_client_rate'
        ) THEN
          ALTER TABLE agents ADD COLUMN repeat_client_rate DECIMAL(5,2) DEFAULT 0;
        END IF;
        
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'webhook_secret'
        ) THEN
          ALTER TABLE agents ADD COLUMN webhook_secret TEXT;
        END IF;
      END $$;
    `);

    // Migration: Messages table for in-app communication
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
        sender_wallet TEXT NOT NULL,
        sender_type TEXT CHECK (sender_type IN ('hirer', 'operator')),
        message TEXT NOT NULL,
        read_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_job ON messages(job_id);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_wallet);
    `);

    // Migration: Human Escalation (RentAHuman integration)
    await client.query(`
      DO $$
      BEGIN
        -- Add human_escalation_status to jobs
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'human_escalation_status'
        ) THEN
          ALTER TABLE jobs ADD COLUMN human_escalation_status TEXT CHECK (human_escalation_status IN ('none', 'requested', 'searching', 'assigned', 'in_progress', 'completed', 'failed'));
          ALTER TABLE jobs ALTER COLUMN human_escalation_status SET DEFAULT 'none';
        END IF;
        
        -- Add rentahuman_bounty_id for tracking
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'rentahuman_bounty_id'
        ) THEN
          ALTER TABLE jobs ADD COLUMN rentahuman_bounty_id TEXT;
        END IF;
        
        -- Add human_worker_id 
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'human_worker_id'
        ) THEN
          ALTER TABLE jobs ADD COLUMN human_worker_id TEXT;
        END IF;
        
        -- Add human_cost_usdc
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'human_cost_usdc'
        ) THEN
          ALTER TABLE jobs ADD COLUMN human_cost_usdc DECIMAL(18,6) DEFAULT 0;
        END IF;
        
        -- Add human_deadline
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'human_deadline'
        ) THEN
          ALTER TABLE jobs ADD COLUMN human_deadline TIMESTAMP;
        END IF;
        
        -- Add human_result (JSONB for flexible data)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'human_result'
        ) THEN
          ALTER TABLE jobs ADD COLUMN human_result JSONB;
        END IF;
        
        -- Add human_requested_at
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'human_requested_at'
        ) THEN
          ALTER TABLE jobs ADD COLUMN human_requested_at TIMESTAMP;
        END IF;
        
        -- Add human_completed_at
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'human_completed_at'
        ) THEN
          ALTER TABLE jobs ADD COLUMN human_completed_at TIMESTAMP;
        END IF;
        
        -- Add capability_manifest to agents (JSONB)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'capability_manifest'
        ) THEN
          ALTER TABLE agents ADD COLUMN capability_manifest JSONB;
        END IF;
        
        -- Add max_human_budget_usdc to agents
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'max_human_budget_usdc'
        ) THEN
          ALTER TABLE agents ADD COLUMN max_human_budget_usdc DECIMAL(18,6) DEFAULT 100;
        END IF;
      END $$;
    `);
    
    // Create index for human escalation queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_human_escalation ON jobs(human_escalation_status) WHERE human_escalation_status != 'none';
    `);

    // Migration: Credits System for A2A payments
    await client.query(`
      -- Credits balance on users
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'credits_balance'
        ) THEN
          ALTER TABLE users ADD COLUMN credits_balance DECIMAL(18,6) DEFAULT 0;
        END IF;
      END $$;
      
      -- Credit transactions table for audit trail
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(18,6) NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'job_payment', 'job_earning', 'refund', 'platform_fee')),
        description TEXT,
        reference_id TEXT,
        job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
        balance_after DECIMAL(18,6) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_credit_tx_type ON credit_transactions(type);
      CREATE INDEX IF NOT EXISTS idx_credit_tx_created ON credit_transactions(created_at);
      
      -- Platform settings table
      CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      
      -- Set default platform fee (5%)
      INSERT INTO platform_settings (key, value) VALUES ('platform_fee_percent', '5')
      ON CONFLICT (key) DO NOTHING;
    `);
    
    logger.info('Credits system tables initialized');

    // Migration: Vector Embeddings for Semantic Search
    await client.query(`
      DO $$
      BEGIN
        -- Add description_embedding column to agents for semantic search
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'description_embedding'
        ) THEN
          ALTER TABLE agents ADD COLUMN description_embedding JSONB;
          COMMENT ON COLUMN agents.description_embedding IS 'OpenAI text-embedding-3-small vector (1536 dims) for semantic search';
        END IF;
        
        -- Add embedding_updated_at to track staleness
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'embedding_updated_at'
        ) THEN
          ALTER TABLE agents ADD COLUMN embedding_updated_at TIMESTAMP;
        END IF;
      END $$;
    `);
    
    logger.info('Vector embeddings schema initialized');

    // ============================================
    // Q-LEARNING ROUTER: Match Outcomes Table
    // ============================================
    await client.query(`
      -- Track match outcomes for learning/optimization
      CREATE TABLE IF NOT EXISTS match_outcomes (
        id SERIAL PRIMARY KEY,
        job_uuid UUID UNIQUE NOT NULL,
        agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
        match_score FLOAT,
        outcome VARCHAR(20) CHECK (outcome IN ('completed', 'disputed', 'cancelled', 'failed')),
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_match_outcomes_agent ON match_outcomes(agent_id);
      CREATE INDEX IF NOT EXISTS idx_match_outcomes_outcome ON match_outcomes(outcome);
      CREATE INDEX IF NOT EXISTS idx_match_outcomes_created ON match_outcomes(created_at);
    `);
    
    // Q-Learning Router: Agent performance columns
    await client.query(`
      DO $$
      BEGIN
        -- Add success_rate column if not exists
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'success_rate'
        ) THEN
          ALTER TABLE agents ADD COLUMN success_rate FLOAT DEFAULT 0.5;
        END IF;
        
        -- Add total_jobs_completed column if not exists
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agents' AND column_name = 'total_jobs_completed'
        ) THEN
          ALTER TABLE agents ADD COLUMN total_jobs_completed INTEGER DEFAULT 0;
        END IF;
      END $$;
    `);
    
    logger.info('Q-Learning router tables initialized');

    // One-time API key rotation (set ROTATE_API_KEY=agentId in Railway to trigger)
    if (process.env.ROTATE_API_KEY) {
      const agentId = parseInt(process.env.ROTATE_API_KEY) || 1;
      const newKey = 'hub_' + require('crypto').randomBytes(24).toString('hex');
      await client.query('UPDATE agents SET api_key = $1 WHERE id = $2', [newKey, agentId]);
      logger.info('🔑 API KEY ROTATED', { agentId, newKey });
      console.log('\n' + '='.repeat(60));
      console.log('🔑 NEW API KEY FOR AGENT ' + agentId);
      console.log('   ' + newKey);
      console.log('='.repeat(60) + '\n');
      console.log('⚠️  REMOVE ROTATE_API_KEY env var after copying the key!\n');
    }

    logger.info('Database schema initialized');
  } catch (error) {
    logger.error('Database initialization failed', { error: error.message, stack: error.stack });
    throw error;
  } finally {
    client.release();
  }
  
  // Seed demo agents (runs on every startup, safe - checks for existing)
  await seedDemoAgents();
}

// Helper functions
async function query(text, params) {
  const result = await pool.query(text, params);
  return result;
}

async function getUser(walletAddress) {
  const result = await query(
    'SELECT * FROM users WHERE wallet_address = $1',
    [walletAddress.toLowerCase()]
  );
  return result.rows[0];
}

async function createUser(walletAddress, userType, name = null) {
  const result = await query(
    `INSERT INTO users (wallet_address, user_type, name) 
     VALUES ($1, $2, $3) 
     ON CONFLICT (wallet_address) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [walletAddress.toLowerCase(), userType, name]
  );
  return result.rows[0];
}

async function getAgent(userId) {
  const result = await query(
    'SELECT a.*, u.wallet_address, u.name, u.avatar_url, u.bio FROM agents a JOIN users u ON a.user_id = u.id WHERE a.user_id = $1',
    [userId]
  );
  return result.rows[0];
}

async function getAgentByWallet(walletAddress) {
  const result = await query(
    `SELECT a.*, u.wallet_address, u.name, u.avatar_url, u.bio 
     FROM agents a 
     JOIN users u ON a.user_id = u.id 
     WHERE u.wallet_address = $1`,
    [walletAddress.toLowerCase()]
  );
  return result.rows[0];
}

async function getAllAgents(filters = {}) {
  // NOTE: Explicitly select fields to EXCLUDE sensitive data (api_key, webhook_secret)
  const { search, category, trust_tier, sort = 'rating' } = filters;
  const params = [];
  let paramIndex = 1;
  
  // Build WHERE conditions
  const conditions = ['a.is_active = true'];
  
  // Search filter - match name, bio, or skill names/descriptions
  if (search && search.trim()) {
    const searchTerm = `%${search.trim().toLowerCase()}%`;
    params.push(searchTerm);
    conditions.push(`(
      LOWER(u.name) LIKE $${paramIndex} OR 
      LOWER(u.bio) LIKE $${paramIndex} OR
      EXISTS (SELECT 1 FROM skills s WHERE s.agent_id = a.id AND (LOWER(s.name) LIKE $${paramIndex} OR LOWER(s.description) LIKE $${paramIndex}))
    )`);
    paramIndex++;
  }
  
  // Category filter - match skill categories
  if (category && category.trim()) {
    params.push(category.trim().toLowerCase());
    conditions.push(`EXISTS (SELECT 1 FROM skills s WHERE s.agent_id = a.id AND LOWER(s.category) LIKE $${paramIndex})`);
    paramIndex++;
  }
  
  // Trust tier filter - minimum tier level
  if (trust_tier && trust_tier.trim()) {
    const tierOrder = ['new', 'rising', 'established', 'trusted', 'verified'];
    const minTierIndex = tierOrder.indexOf(trust_tier.toLowerCase());
    if (minTierIndex >= 0) {
      const validTiers = tierOrder.slice(minTierIndex);
      params.push(validTiers);
      conditions.push(`COALESCE(a.trust_tier, 'new') = ANY($${paramIndex})`);
      paramIndex++;
    }
  }
  
  // Build ORDER BY
  let orderBy = 'a.rating DESC, a.total_jobs DESC';
  if (sort === 'tasks') orderBy = 'a.total_jobs DESC, a.rating DESC';
  else if (sort === 'price') orderBy = '(SELECT MIN(price_usdc) FROM skills WHERE agent_id = a.id) ASC NULLS LAST';
  
  const result = await query(
    `SELECT a.id, a.user_id, a.webhook_url, a.is_active, a.total_jobs, 
            a.total_earned, a.rating, a.created_at, a.trust_tier, a.trust_score,
            a.tagline, a.is_founder,
            u.wallet_address, u.name, u.avatar_url, u.bio,
            (SELECT json_agg(json_build_object(
              'id', s.id, 'name', s.name, 'description', s.description,
              'category', s.category, 'price_usdc', s.price_usdc,
              'estimated_time', s.estimated_time, 'service_key', s.service_key
            )) FROM skills s WHERE s.agent_id = a.id AND s.is_active = true) as skills
     FROM agents a 
     JOIN users u ON a.user_id = u.id 
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.is_founder DESC NULLS LAST, ${orderBy}`,
    params
  );
  return result.rows;
}

/**
 * SECURITY P1-6: Hash API key using SHA-256
 * @param {string} apiKey - Plain text API key
 * @returns {string} Hashed API key
 */
function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * SECURITY P1-6: Verify API key against stored hash
 * Uses timing-safe comparison to prevent timing attacks
 * @param {string} providedKey - Plain text API key from request
 * @param {string} storedValue - Could be hash (new) or plain text (legacy)
 * @returns {boolean} True if key matches
 */
function verifyApiKey(providedKey, storedValue) {
  if (!providedKey || !storedValue) return false;
  
  // Hash the provided key
  const providedHash = hashApiKey(providedKey);
  
  // Check if stored value is a hash (64 hex chars) or legacy plain key (starts with 'hub_')
  const isLegacyKey = storedValue.startsWith('hub_');
  
  if (isLegacyKey) {
    // Legacy: direct comparison (timing-safe)
    try {
      return crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(storedValue));
    } catch (e) {
      // Buffer lengths don't match - can't be equal
      return false;
    }
  } else {
    // New: compare hashes (timing-safe)
    try {
      return crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(storedValue));
    } catch (e) {
      return false;
    }
  }
}

async function createAgent(userId, webhookUrl = null) {
  // Generate API key - return plain text to user, store hash
  const apiKeyPlain = 'hub_' + crypto.randomBytes(24).toString('hex');
  const apiKeyHash = hashApiKey(apiKeyPlain);
  
  const result = await query(
    `INSERT INTO agents (user_id, webhook_url, api_key) 
     VALUES ($1, $2, $3) 
     RETURNING *`,
    [userId, webhookUrl, apiKeyHash]
  );
  
  // Return agent with PLAIN api_key (only time user sees it)
  const agent = result.rows[0];
  agent.api_key = apiKeyPlain; // Override hash with plain for this response only
  return agent;
}

async function createSkill(agentId, name, description, category, priceUsdc, estimatedTime) {
  const result = await query(
    `INSERT INTO skills (agent_id, name, description, category, price_usdc, estimated_time) 
     VALUES ($1, $2, $3, $4, $5, $6) 
     RETURNING *`,
    [agentId, name, description, category, priceUsdc, estimatedTime]
  );
  return result.rows[0];
}

async function getSkillsByAgent(agentId) {
  const result = await query(
    'SELECT DISTINCT ON (name, category) * FROM skills WHERE agent_id = $1 AND is_active = true ORDER BY name, category, id',
    [agentId]
  );
  return result.rows;
}

/**
 * Get distinct categories that agents are actually offering
 * Used for dynamic category pills on homepage
 */
async function getActiveCategories() {
  const result = await query(
    `SELECT DISTINCT category, COUNT(*) as count 
     FROM skills 
     WHERE is_active = true AND category IS NOT NULL AND category != ''
     GROUP BY category 
     ORDER BY count DESC, category ASC`
  );
  return result.rows;
}

async function createJob(jobUuid, requesterId, agentId, skillId, inputData, priceUsdc) {
  const result = await query(
    `INSERT INTO jobs (job_uuid, requester_id, agent_id, skill_id, input_data, price_usdc) 
     VALUES ($1, $2, $3, $4, $5, $6) 
     RETURNING *`,
    [jobUuid, requesterId, agentId, skillId, JSON.stringify(inputData), priceUsdc]
  );
  return result.rows[0];
}

async function updateJobStatus(jobId, status, extraFields = {}) {
  // Whitelist allowed fields to prevent SQL injection
  const allowedFields = [
    'payment_tx_hash',
    'payout_tx_hash',
    'paid_at',
    'delivered_at',
    'completed_at',
    'output_data',
    'accepted_at',
    'dispute_reason',
    'disputed_at'
  ];

  const setClauses = ['status = $2'];
  const values = [jobId, status];
  let paramIndex = 3;

  for (const [key, value] of Object.entries(extraFields)) {
    // Security: Only allow whitelisted fields
    if (!allowedFields.includes(key)) {
      logger.warn('Ignoring invalid field in updateJobStatus', { field: key });
      continue;
    }

    setClauses.push(`${key} = $${paramIndex}`);
    values.push(value);
    paramIndex++;
  }

  const result = await query(
    `UPDATE jobs SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );
  return result.rows[0];
}

/**
 * SECURITY P1-4: Update job status with transaction and row locking to prevent race conditions
 * @param {number} jobId - Job ID to update
 * @param {string} newStatus - Target status
 * @param {string[]} allowedFromStatuses - Array of statuses from which transition is allowed
 * @param {Object} extraFields - Additional fields to update
 * @returns {Object} { success: boolean, job?: object, error?: string }
 */
async function updateJobStatusWithLock(jobId, newStatus, allowedFromStatuses, extraFields = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Lock the job row and verify status atomically
    const lockResult = await client.query(
      `SELECT * FROM jobs WHERE id = $1 FOR UPDATE`,
      [jobId]
    );
    
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Job not found' };
    }
    
    const job = lockResult.rows[0];
    
    // Verify current status allows this transition
    if (!allowedFromStatuses.includes(job.status)) {
      await client.query('ROLLBACK');
      return { 
        success: false, 
        error: `Job status is '${job.status}', cannot transition to '${newStatus}'`,
        currentStatus: job.status
      };
    }
    
    // Build update query with extra fields
    const allowedFields = [
      'payment_tx_hash', 'payout_tx_hash', 'paid_at', 'delivered_at',
      'completed_at', 'output_data', 'accepted_at', 'dispute_reason', 'disputed_at'
    ];
    
    const setClauses = ['status = $2'];
    const values = [jobId, newStatus];
    let paramIndex = 3;
    
    for (const [key, value] of Object.entries(extraFields)) {
      if (!allowedFields.includes(key)) {
        logger.warn('Ignoring invalid field in updateJobStatusWithLock', { field: key });
        continue;
      }
      setClauses.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
    
    const updateResult = await client.query(
      `UPDATE jobs SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );
    
    await client.query('COMMIT');
    
    return { success: true, job: updateResult.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Accept a job with proper locking to prevent race conditions
 * Uses SELECT FOR UPDATE to ensure only one agent can accept
 * @param {number} jobId - Job ID to accept
 * @param {number} expectedAgentId - Agent ID that should own this job
 * @param {string} requiredStatus - Status the job must be in (default: 'paid')
 * @returns {Object} { success: boolean, job?: object, error?: string }
 */
async function acceptJobWithLock(jobId, expectedAgentId, requiredStatus = 'paid') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Lock the job row and verify status atomically
    const lockResult = await client.query(
      `SELECT * FROM jobs WHERE id = $1 FOR UPDATE`,
      [jobId]
    );
    
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Job not found' };
    }
    
    const job = lockResult.rows[0];
    
    // Verify agent ownership
    if (job.agent_id !== expectedAgentId) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Job not assigned to this agent' };
    }
    
    // Verify status
    if (job.status !== requiredStatus) {
      await client.query('ROLLBACK');
      return { success: false, error: `Job status is '${job.status}', expected '${requiredStatus}'` };
    }
    
    // Update status to in_progress
    const updateResult = await client.query(
      `UPDATE jobs SET status = 'in_progress', accepted_at = NOW() WHERE id = $1 RETURNING *`,
      [jobId]
    );
    
    await client.query('COMMIT');
    
    return { success: true, job: updateResult.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getJob(jobUuid) {
  const result = await query(
    `SELECT j.*, 
            u_req.wallet_address as requester_wallet,
            u_agent.wallet_address as agent_wallet,
            u_agent.name as agent_name,
            s.name as skill_name
     FROM jobs j
     JOIN users u_req ON j.requester_id = u_req.id
     JOIN agents a ON j.agent_id = a.id
     JOIN users u_agent ON a.user_id = u_agent.id
     JOIN skills s ON j.skill_id = s.id
     WHERE j.job_uuid = $1`,
    [jobUuid]
  );
  return result.rows[0];
}

async function getJobsByUser(userId) {
  const result = await query(
    `SELECT j.*, s.name as skill_name, u.name as agent_name
     FROM jobs j
     JOIN skills s ON j.skill_id = s.id
     JOIN agents a ON j.agent_id = a.id
     JOIN users u ON a.user_id = u.id
     WHERE j.requester_id = $1
     ORDER BY j.created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function getJobsByAgent(agentId) {
  const result = await query(
    `SELECT j.*, s.name as skill_name, u.name as requester_name, u.wallet_address as requester_wallet
     FROM jobs j
     JOIN skills s ON j.skill_id = s.id
     JOIN users u ON j.requester_id = u.id
     WHERE j.agent_id = $1
     ORDER BY j.created_at DESC`,
    [agentId]
  );
  return result.rows;
}

async function getSkill(skillId) {
  const result = await query(
    'SELECT * FROM skills WHERE id = $1',
    [skillId]
  );
  return result.rows[0];
}

/**
 * Log webhook delivery attempt
 */
async function logWebhookDelivery(jobId, agentId, webhookUrl, result) {
  await query(
    `INSERT INTO webhook_deliveries (job_id, agent_id, webhook_url, attempts, success, status_code, error, response_body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      jobId,
      agentId,
      webhookUrl,
      result.attempts || 0,
      result.success || false,
      result.statusCode || null,
      result.error || null,
      result.response ? JSON.stringify(result.response) : null
    ]
  );
}

/**
 * Mark job as in-progress (agent is processing)
 */
async function markJobInProgress(jobId) {
  return updateJobStatus(jobId, 'in_progress', {
    // No additional fields needed
  });
}

/**
 * Create a review for a completed job
 */
async function createReview(jobId, reviewerId, rating, comment, qualityScore, speedScore, communicationScore) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get the job to find the agent
    const jobResult = await client.query('SELECT agent_id FROM jobs WHERE id = $1', [jobId]);
    if (jobResult.rows.length === 0) {
      throw new Error('Job not found');
    }
    const agentId = jobResult.rows[0].agent_id;

    // Check if review already exists for this job
    const existingReview = await client.query('SELECT id FROM reviews WHERE job_id = $1', [jobId]);
    if (existingReview.rows.length > 0) {
      throw new Error('Review already exists for this job');
    }

    // Create the review
    const reviewResult = await client.query(
      `INSERT INTO reviews (job_id, reviewer_id, rating, comment, quality_score, speed_score, communication_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [jobId, reviewerId, rating, comment, qualityScore, speedScore, communicationScore]
    );

    // Update agent's rating and review_count
    await client.query(`
      UPDATE agents SET 
        review_count = review_count + 1,
        rating = (
          SELECT COALESCE(AVG(rating), 0)
          FROM reviews r
          JOIN jobs j ON r.job_id = j.id
          WHERE j.agent_id = $1
        )
      WHERE id = $1
    `, [agentId]);

    await client.query('COMMIT');
    return reviewResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get reviews for an agent
 */
async function getAgentReviews(agentId, limit = 20, offset = 0) {
  const result = await query(
    `SELECT r.*, 
            j.job_uuid, 
            s.name as skill_name,
            u.wallet_address as reviewer_wallet,
            u.name as reviewer_name
     FROM reviews r
     JOIN jobs j ON r.job_id = j.id
     JOIN skills s ON j.skill_id = s.id
     JOIN users u ON r.reviewer_id = u.id
     WHERE j.agent_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [agentId, limit, offset]
  );
  return result.rows;
}

/**
 * Get review stats for an agent
 */
async function getAgentReviewStats(agentId) {
  const result = await query(
    `SELECT 
       COUNT(*) as total_reviews,
       COALESCE(AVG(rating), 0) as avg_rating,
       COALESCE(AVG(quality_score), 0) as avg_quality,
       COALESCE(AVG(speed_score), 0) as avg_speed,
       COALESCE(AVG(communication_score), 0) as avg_communication,
       COUNT(CASE WHEN rating = 5 THEN 1 END) as five_star,
       COUNT(CASE WHEN rating = 4 THEN 1 END) as four_star,
       COUNT(CASE WHEN rating = 3 THEN 1 END) as three_star,
       COUNT(CASE WHEN rating = 2 THEN 1 END) as two_star,
       COUNT(CASE WHEN rating = 1 THEN 1 END) as one_star
     FROM reviews r
     JOIN jobs j ON r.job_id = j.id
     WHERE j.agent_id = $1`,
    [agentId]
  );
  return result.rows[0];
}

/**
 * Add agent response to a review
 */
async function addAgentResponse(reviewId, agentId, response) {
  // Verify the review belongs to this agent
  const verifyResult = await query(
    `SELECT r.id FROM reviews r
     JOIN jobs j ON r.job_id = j.id
     WHERE r.id = $1 AND j.agent_id = $2`,
    [reviewId, agentId]
  );
  
  if (verifyResult.rows.length === 0) {
    throw new Error('Review not found or not owned by this agent');
  }

  const result = await query(
    `UPDATE reviews SET agent_response = $1 WHERE id = $2 RETURNING *`,
    [response, reviewId]
  );
  return result.rows[0];
}

/**
 * Get agent by ID
 */
async function getAgentById(agentId) {
  const result = await query(
    `SELECT a.*, u.wallet_address, u.name, u.avatar_url, u.bio 
     FROM agents a 
     JOIN users u ON a.user_id = u.id 
     WHERE a.id = $1`,
    [agentId]
  );
  return result.rows[0];
}

/**
 * Update agent completion rate
 */
async function updateAgentCompletionRate(agentId) {
  await query(`
    UPDATE agents SET completion_rate = (
      SELECT CASE 
        WHEN COUNT(*) = 0 THEN 100
        ELSE (COUNT(CASE WHEN status = 'completed' THEN 1 END)::DECIMAL / COUNT(*)::DECIMAL) * 100
      END
      FROM jobs 
      WHERE agent_id = $1 AND status IN ('completed', 'failed', 'refunded')
    )
    WHERE id = $1
  `, [agentId]);
}

/**
 * Calculate and update trust tier for an agent
 * Based on PRD 5-tier model:
 * Tier 1: New (gray) - Just joined
 * Tier 2: Rising (blue) - 5+ tasks, 4.0+ rating, <24hr response, no disputes
 * Tier 3: Established (green) - 25+ tasks, 4.3+ rating, <12hr response, security audit, 90%+ completion
 * Tier 4: Trusted (gold) - 100+ tasks, 4.5+ rating, <6hr response, 95%+ completion, $10k+ earned
 * Tier 5: Verified (platinum) - 250+ tasks, 4.7+ rating, <3hr response, 98%+ completion, $50k+ earned, rentahuman
 */
async function calculateTrustTier(agentId) {
  const agentResult = await query(
    `SELECT a.*, 
            u.created_at as user_created_at,
            u.email_verified,
            u.identity_verified,
            u.x_verified_at,
            (SELECT COUNT(*) FROM jobs j WHERE j.agent_id = a.id AND j.status = 'disputed') as dispute_count
     FROM agents a
     JOIN users u ON a.user_id = u.id
     WHERE a.id = $1`,
    [agentId]
  );
  
  if (agentResult.rows.length === 0) return null;
  
  const agent = agentResult.rows[0];
  const totalJobs = parseInt(agent.total_jobs) || 0;
  const rating = parseFloat(agent.rating) || 0;
  const completionRate = parseFloat(agent.completion_rate) || 100;
  const totalEarned = parseFloat(agent.total_earned) || 0;
  const responseTimeHrs = (parseInt(agent.response_time_avg) || 0) / 3600; // Convert seconds to hours
  const hasSecurityAudit = agent.security_audit_status === 'passed';
  const hasRentahuman = agent.rentahuman_enabled === true;
  const hasDisputes = parseInt(agent.dispute_count) > 0;
  const webhookVerified = !!agent.webhook_verified_at;
  const socialVerified = !!agent.x_verified_at;
  
  let tier = 'new';
  let trustScore = 10; // Base score
  
  // Tier 5: Verified (platinum)
  if (
    totalJobs >= 250 &&
    rating >= 4.7 &&
    responseTimeHrs <= 3 &&
    completionRate >= 98 &&
    totalEarned >= 50000 &&
    hasSecurityAudit &&
    hasRentahuman
  ) {
    tier = 'verified';
    trustScore = 95;
  }
  // Tier 4: Trusted (gold)
  else if (
    totalJobs >= 100 &&
    rating >= 4.5 &&
    responseTimeHrs <= 6 &&
    completionRate >= 95 &&
    totalEarned >= 10000 &&
    hasSecurityAudit
  ) {
    tier = 'trusted';
    trustScore = 80;
  }
  // Tier 3: Established (green)
  else if (
    totalJobs >= 25 &&
    rating >= 4.3 &&
    responseTimeHrs <= 12 &&
    completionRate >= 90 &&
    hasSecurityAudit
  ) {
    tier = 'established';
    trustScore = 60;
  }
  // Tier 2: Rising (blue)
  else if (
    totalJobs >= 5 &&
    rating >= 4.0 &&
    responseTimeHrs <= 24 &&
    !hasDisputes &&
    (webhookVerified || socialVerified)
  ) {
    tier = 'rising';
    trustScore = 40;
  }
  // Tier 1: New (gray) - default
  else {
    tier = 'new';
    trustScore = Math.min(30, 10 + totalJobs * 2 + (rating > 0 ? rating * 3 : 0));
  }
  
  // Update agent
  await query(
    `UPDATE agents SET trust_tier = $1, trust_score = $2 WHERE id = $3`,
    [tier, Math.round(trustScore), agentId]
  );
  
  return { tier, trustScore: Math.round(trustScore) };
}

/**
 * Get trust tier display info
 */
function getTrustTierDisplay(tier) {
  const tiers = {
    'new': { label: 'New', color: '#6b7280', icon: '🆕', badgeClass: 'badge-new' },
    'rising': { label: 'Rising', color: '#3b82f6', icon: '📈', badgeClass: 'badge-rising' },
    'established': { label: 'Established', color: '#10b981', icon: '🛡️', badgeClass: 'badge-established' },
    'trusted': { label: 'Trusted', color: '#f59e0b', icon: '⭐', badgeClass: 'badge-trusted' },
    'verified': { label: 'Verified', color: '#8b5cf6', icon: '✓', badgeClass: 'badge-verified' }
  };
  return tiers[tier] || tiers['new'];
}

/**
 * Get platform stats
 */
async function getPlatformStats() {
  const result = await query(`
    SELECT 
      (SELECT COUNT(*) FROM agents WHERE is_active = true) as total_agents,
      (SELECT COUNT(*) FROM skills WHERE is_active = true) as total_skills,
      (SELECT COUNT(*) FROM jobs WHERE status = 'completed') as total_jobs_completed,
      (SELECT COALESCE(SUM(price_usdc), 0) FROM jobs WHERE status = 'completed') as total_volume,
      (SELECT COALESCE(AVG(a.rating), 0) FROM agents a WHERE a.review_count > 0) as avg_platform_rating
  `);
  return result.rows[0];
}

/**
 * Gracefully close database connection pool
 */
async function closePool() {
  try {
    await pool.end();
    logger.info('Database connection pool closed');
  } catch (error) {
    logger.error('Error closing database pool', { error: error.message });
    throw error;
  }
}

/**
 * Phase 2: Calculate enhanced trust metrics for an agent
 */
async function calculateTrustMetrics(agentId) {
  const result = await query(`
    WITH job_stats AS (
      SELECT 
        COUNT(*) as total_jobs,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_jobs,
        COUNT(CASE WHEN status = 'disputed' THEN 1 END) as disputed_jobs,
        COUNT(CASE WHEN status = 'completed' AND delivered_at <= created_at + INTERVAL '24 hours' THEN 1 END) as on_time_jobs,
        AVG(EXTRACT(EPOCH FROM (COALESCE(paid_at, NOW()) - created_at))) as avg_response_seconds
      FROM jobs WHERE agent_id = $1
    ),
    repeat_clients AS (
      SELECT COUNT(DISTINCT requester_id) as unique_clients,
             COUNT(*) as total_requests,
             COUNT(DISTINCT CASE WHEN job_count > 1 THEN requester_id END) as repeat_clients
      FROM (
        SELECT requester_id, COUNT(*) as job_count
        FROM jobs WHERE agent_id = $1 AND status = 'completed'
        GROUP BY requester_id
      ) sub
    )
    SELECT 
      js.*,
      rc.unique_clients,
      rc.repeat_clients,
      CASE WHEN rc.unique_clients > 0 
           THEN (rc.repeat_clients::DECIMAL / rc.unique_clients::DECIMAL) * 100 
           ELSE 0 END as repeat_rate
    FROM job_stats js, repeat_clients rc
  `, [agentId]);
  
  const stats = result.rows[0];
  const totalJobs = parseInt(stats.total_jobs) || 0;
  const completedJobs = parseInt(stats.completed_jobs) || 0;
  const disputedJobs = parseInt(stats.disputed_jobs) || 0;
  const onTimeJobs = parseInt(stats.on_time_jobs) || 0;
  
  const onTimeRate = completedJobs > 0 ? (onTimeJobs / completedJobs) * 100 : 100;
  const disputeRate = totalJobs > 0 ? (disputedJobs / totalJobs) * 100 : 0;
  const repeatClientRate = parseFloat(stats.repeat_rate) || 0;
  const avgResponseTime = stats.avg_response_seconds ? Math.round(stats.avg_response_seconds) : 0;
  
  // Update agent with calculated metrics
  await query(`
    UPDATE agents SET 
      on_time_rate = $2,
      dispute_rate = $3,
      repeat_client_rate = $4,
      response_time_avg = $5
    WHERE id = $1
  `, [agentId, onTimeRate, disputeRate, repeatClientRate, avgResponseTime]);
  
  return {
    on_time_rate: Math.round(onTimeRate * 100) / 100,
    dispute_rate: Math.round(disputeRate * 100) / 100,
    repeat_client_rate: Math.round(repeatClientRate * 100) / 100,
    avg_response_time_seconds: avgResponseTime,
    jobs_completed: completedJobs,
    total_jobs: totalJobs
  };
}

/**
 * Phase 2: Get full trust metrics for API
 */
async function getAgentTrustMetrics(agentId) {
  const agent = await getAgentById(agentId);
  if (!agent) return null;
  
  // Calculate fresh metrics
  const metrics = await calculateTrustMetrics(agentId);
  
  // Get review stats
  const reviewStats = await getAgentReviewStats(agentId);
  
  // Format response time
  const avgResponseHours = metrics.avg_response_time_seconds / 3600;
  let responseTimeFormatted;
  if (avgResponseHours < 1) {
    responseTimeFormatted = `${Math.round(metrics.avg_response_time_seconds / 60)}m`;
  } else if (avgResponseHours < 24) {
    responseTimeFormatted = `${avgResponseHours.toFixed(1)}h`;
  } else {
    responseTimeFormatted = `${Math.round(avgResponseHours / 24)}d`;
  }
  
  return {
    trust_score: agent.trust_score || 0,
    trust_tier: agent.trust_tier || 'new',
    jobs_completed: metrics.jobs_completed,
    on_time_rate: metrics.on_time_rate / 100,
    dispute_rate: metrics.dispute_rate / 100,
    avg_response_time: responseTimeFormatted,
    repeat_client_rate: metrics.repeat_client_rate / 100,
    rating: parseFloat(reviewStats.avg_rating) || 0,
    review_count: parseInt(reviewStats.total_reviews) || 0,
    verification_level: getVerificationLevel(agent),
    platform_since: agent.created_at
  };
}

/**
 * Get verification level string
 */
function getVerificationLevel(agent) {
  const verifications = [];
  if (agent.wallet_address) verifications.push('wallet');
  if (agent.webhook_verified_at) verifications.push('webhook');
  if (agent.x_verified_at) verifications.push('twitter');
  if (agent.security_audit_status === 'passed') verifications.push('security_audit');
  return verifications.length > 0 ? verifications.join(',') : 'none';
}

/**
 * Phase 2: Register a webhook for an agent
 */
async function registerWebhook(agentId, url, events = ['job.*']) {
  const secret = 'whsec_' + require('crypto').randomBytes(24).toString('hex');
  
  const result = await query(`
    INSERT INTO webhooks (agent_id, url, secret, events)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT DO NOTHING
    RETURNING *
  `, [agentId, url, secret, events]);
  
  // Also update agent's webhook_secret for backwards compatibility
  await query(`UPDATE agents SET webhook_secret = $1 WHERE id = $2`, [secret, agentId]);
  
  return result.rows[0];
}

/**
 * Phase 2: Get webhooks for an agent
 */
async function getAgentWebhooks(agentId) {
  const result = await query(
    `SELECT id, url, events, is_active, created_at, last_triggered_at, failure_count
     FROM webhooks WHERE agent_id = $1`,
    [agentId]
  );
  return result.rows;
}

/**
 * Phase 2: Delete a webhook
 */
async function deleteWebhook(webhookId, agentId) {
  const result = await query(
    `DELETE FROM webhooks WHERE id = $1 AND agent_id = $2 RETURNING *`,
    [webhookId, agentId]
  );
  return result.rows[0];
}

/**
 * Phase 2: Get webhooks to trigger for an event
 */
async function getWebhooksForEvent(agentId, eventType) {
  const result = await query(`
    SELECT * FROM webhooks 
    WHERE agent_id = $1 
      AND is_active = true 
      AND (events @> ARRAY[$2] OR events @> ARRAY['job.*'])
  `, [agentId, eventType]);
  return result.rows;
}

/**
 * Phase 2: Update webhook after delivery attempt
 */
async function updateWebhookStatus(webhookId, success) {
  if (success) {
    await query(`
      UPDATE webhooks SET 
        last_triggered_at = NOW(),
        failure_count = 0
      WHERE id = $1
    `, [webhookId]);
  } else {
    await query(`
      UPDATE webhooks SET 
        failure_count = failure_count + 1,
        is_active = CASE WHEN failure_count >= 4 THEN false ELSE is_active END
      WHERE id = $1
    `, [webhookId]);
  }
}

/**
 * Phase 2: Public trust lookup by wallet
 */
async function getTrustByWallet(walletAddress) {
  const result = await query(`
    SELECT a.*, u.wallet_address, u.created_at as platform_since
    FROM agents a
    JOIN users u ON a.user_id = u.id
    WHERE u.wallet_address = $1
  `, [walletAddress.toLowerCase()]);
  
  if (result.rows.length === 0) return null;
  
  const agent = result.rows[0];
  const verifications = [];
  if (agent.wallet_address) verifications.push('wallet');
  if (agent.webhook_verified_at) verifications.push('webhook');
  if (agent.x_verified_at) verifications.push('twitter');
  
  return {
    wallet: agent.wallet_address,
    trust_score: agent.trust_score || 0,
    tier: agent.trust_tier || 'new',
    jobs_completed: agent.total_jobs || 0,
    platform_since: agent.platform_since,
    verification: verifications
  };
}

/**
 * Seed demo agents for marketplace testing
 * Creates DataDive (Data/Research) and PixelForge (Image/Creative)
 */
/**
 * Setup MrMagoochi as Founding Agent and remove demo agents
 * Runs on every startup but is idempotent
 */
async function seedDemoAgents() {
  const client = await pool.connect();
  try {
    logger.info('Running agent setup migrations...');
    
    // Remove demo agents with fake wallets (one-time cleanup)
    const demoWallets = [
      '0xda7a01ve000000000000000000000000000d1ve',  // DataDive
      '0xp1xel000000000000000000000000000f0rge'     // PixelForge
    ];
    
    for (const wallet of demoWallets) {
      const result = await client.query(`
        SELECT u.id as user_id, a.id as agent_id 
        FROM users u LEFT JOIN agents a ON a.user_id = u.id 
        WHERE u.wallet_address = $1
      `, [wallet]);
      
      if (result.rows.length > 0) {
        const { user_id, agent_id } = result.rows[0];
        if (agent_id) {
          await client.query('DELETE FROM skills WHERE agent_id = $1', [agent_id]);
          await client.query('DELETE FROM agents WHERE id = $1', [agent_id]);
        }
        await client.query('DELETE FROM users WHERE id = $1', [user_id]);
        logger.info('Removed demo agent', { wallet: wallet.slice(0, 10) });
      }
    }
    
    // Setup MrMagoochi as Founding Agent (idempotent)
    const mrMagoochiWallet = '0xa193128362e6de28e6d51eebc98505672ffeb3c5';
    
    // Update user profile
    await client.query(`
      UPDATE users SET
        bio = COALESCE(NULLIF(bio, ''), 'Founding Agent of TheBotique. Creative strategist, researcher, and AI specialist. From brainstorms to code reviews — 40+ services across creative, research, technical, and visual domains.'),
        avatar_url = COALESCE(avatar_url, 'https://api.dicebear.com/7.x/bottts/svg?seed=MrMagoochi&backgroundColor=0f172a')
      WHERE wallet_address = $1
    `, [mrMagoochiWallet]);
    
    // Update agent as founder
    await client.query(`
      UPDATE agents SET
        trust_tier = 'verified',
        trust_score = GREATEST(trust_score, 100),
        is_founder = true,
        tagline = COALESCE(NULLIF(tagline, ''), 'AI-Powered Services')
      WHERE user_id = (SELECT id FROM users WHERE wallet_address = $1)
    `, [mrMagoochiWallet]);
    
    logger.info('MrMagoochi configured as Founding Agent');
    logger.info('Agent setup complete');
    
  } catch (error) {
    logger.error('Error in agent setup', { error: error.message });
    // Don't throw - non-critical
  } finally {
    client.release();
  }
}

// ============================================
// CREDITS SYSTEM FUNCTIONS
// ============================================

/**
 * Get user's credit balance
 */
async function getCreditsBalance(userId) {
  const result = await query(
    'SELECT credits_balance FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0]?.credits_balance || 0;
}

/**
 * Get platform fee percentage
 */
async function getPlatformFee() {
  const result = await query(
    "SELECT value FROM platform_settings WHERE key = 'platform_fee_percent'"
  );
  return parseFloat(result.rows[0]?.value || '5');
}

/**
 * Add credits to a user account (deposit)
 */
async function addCredits(userId, amount, description = 'Credit deposit', referenceId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Update balance
    const balanceResult = await client.query(
      'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2 RETURNING credits_balance',
      [amount, userId]
    );
    const newBalance = balanceResult.rows[0].credits_balance;
    
    // Log transaction
    await client.query(`
      INSERT INTO credit_transactions (user_id, amount, type, description, reference_id, balance_after)
      VALUES ($1, $2, 'deposit', $3, $4, $5)
    `, [userId, amount, description, referenceId, newBalance]);
    
    await client.query('COMMIT');
    return { success: true, balance: newBalance };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Deduct credits for a job payment
 * Returns { success, balance, agentAmount, platformFee } or { success: false, error }
 */
async function deductCreditsForJob(hirerId, agentUserId, amount, jobId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check hirer balance
    const hirerBalance = await client.query(
      'SELECT credits_balance FROM users WHERE id = $1 FOR UPDATE',
      [hirerId]
    );
    const currentBalance = parseFloat(hirerBalance.rows[0]?.credits_balance || 0);
    
    if (currentBalance < amount) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Insufficient credits', required: amount, available: currentBalance };
    }
    
    // Get platform fee
    const feeResult = await client.query("SELECT value FROM platform_settings WHERE key = 'platform_fee_percent'");
    const feePercent = parseFloat(feeResult.rows[0]?.value || '5');
    const platformFee = amount * (feePercent / 100);
    const agentAmount = amount - platformFee;
    
    // Deduct from hirer
    const newHirerBalance = await client.query(
      'UPDATE users SET credits_balance = credits_balance - $1 WHERE id = $2 RETURNING credits_balance',
      [amount, hirerId]
    );
    
    // Log hirer transaction
    await client.query(`
      INSERT INTO credit_transactions (user_id, amount, type, description, job_id, balance_after)
      VALUES ($1, $2, 'job_payment', $3, $4, $5)
    `, [hirerId, -amount, `Payment for job`, jobId, newHirerBalance.rows[0].credits_balance]);
    
    // Add to agent
    const newAgentBalance = await client.query(
      'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2 RETURNING credits_balance',
      [agentAmount, agentUserId]
    );
    
    // Log agent earning
    await client.query(`
      INSERT INTO credit_transactions (user_id, amount, type, description, job_id, balance_after)
      VALUES ($1, $2, 'job_earning', $3, $4, $5)
    `, [agentUserId, agentAmount, `Earning from job (${feePercent}% platform fee)`, jobId, newAgentBalance.rows[0].credits_balance]);
    
    // Log platform fee (to a special platform account if we have one, or just record it)
    await client.query(`
      INSERT INTO credit_transactions (user_id, amount, type, description, job_id, balance_after)
      VALUES ($1, $2, 'platform_fee', $3, $4, $5)
    `, [agentUserId, -platformFee, `Platform fee (${feePercent}%)`, jobId, newAgentBalance.rows[0].credits_balance]);
    
    await client.query('COMMIT');
    
    return {
      success: true,
      hirerBalance: newHirerBalance.rows[0].credits_balance,
      agentBalance: newAgentBalance.rows[0].credits_balance,
      agentAmount,
      platformFee,
      feePercent
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Refund credits for a cancelled/disputed job
 */
async function refundCredits(userId, amount, jobId, description = 'Job refund') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const balanceResult = await client.query(
      'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2 RETURNING credits_balance',
      [amount, userId]
    );
    
    await client.query(`
      INSERT INTO credit_transactions (user_id, amount, type, description, job_id, balance_after)
      VALUES ($1, $2, 'refund', $3, $4, $5)
    `, [userId, amount, description, jobId, balanceResult.rows[0].credits_balance]);
    
    await client.query('COMMIT');
    return { success: true, balance: balanceResult.rows[0].credits_balance };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get credit transaction history for a user
 */
async function getCreditHistory(userId, limit = 50) {
  const result = await query(`
    SELECT * FROM credit_transactions 
    WHERE user_id = $1 
    ORDER BY created_at DESC 
    LIMIT $2
  `, [userId, limit]);
  return result.rows;
}

module.exports = {
  pool,
  query,
  initDB,
  closePool,
  getUser,
  createUser,
  getAgent,
  getAgentById,
  getAgentByWallet,
  getAllAgents,
  createAgent,
  // API key security (P1-6)
  hashApiKey,
  verifyApiKey,
  createSkill,
  getSkillsByAgent,
  getSkill,
  createJob,
  updateJobStatus,
  updateJobStatusWithLock,
  acceptJobWithLock,
  getJob,
  getJobsByUser,
  getJobsByAgent,
  logWebhookDelivery,
  markJobInProgress,
  // Review functions
  createReview,
  getAgentReviews,
  getAgentReviewStats,
  addAgentResponse,
  updateAgentCompletionRate,
  // Trust tier functions
  calculateTrustTier,
  getTrustTierDisplay,
  getPlatformStats,
  // Phase 2: Trust metrics
  calculateTrustMetrics,
  getAgentTrustMetrics,
  getVerificationLevel,
  // Phase 2: Webhooks
  registerWebhook,
  getAgentWebhooks,
  deleteWebhook,
  getWebhooksForEvent,
  updateWebhookStatus,
  // Phase 2: Public trust lookup
  getTrustByWallet,
  // Demo data
  seedDemoAgents,
  // Dynamic categories
  getActiveCategories,
  // Credits system
  getCreditsBalance,
  getPlatformFee,
  addCredits,
  deductCreditsForJob,
  refundCredits,
  getCreditHistory
};
