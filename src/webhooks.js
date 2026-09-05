const axios = require('axios');
const db = require('./db');

/**
 * Deliver webhook with retry logic
 * @param {string} webhookUrl - Agent's webhook URL
 * @param {Object} payload - Webhook payload
 * @param {Object} options - { maxAttempts, timeoutMs, retryDelays }
 * @returns {Promise<Object>} { success: boolean, attempts: number, response?, error? }
 */
async function deliverWebhook(webhookUrl, payload, options = {}) {
  const {
    maxAttempts = 4,
    timeoutMs = 30000,
    retryDelays = [0, 1000, 2000, 4000] // Exponential backoff: 0s, 1s, 2s, 4s
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(JSON.stringify({
        event: 'webhook_attempt',
        attempt,
        webhookUrl,
        jobUuid: payload.jobUuid,
        timestamp: new Date().toISOString()
      }));

      // Wait for retry delay (0 on first attempt)
      const delay = retryDelays[attempt - 1] || 0;
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // Make HTTP POST with timeout
      const response = await axios.post(webhookUrl, payload, {
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AgentEconomyHub/1.0'
        },
        validateStatus: (status) => status >= 200 && status < 300
      });

      // Success!
      console.log(JSON.stringify({
        event: 'webhook_success',
        attempt,
        webhookUrl,
        jobUuid: payload.jobUuid,
        statusCode: response.status,
        timestamp: new Date().toISOString()
      }));

      return {
        success: true,
        attempts: attempt,
        statusCode: response.status,
        response: response.data
      };

    } catch (error) {
      lastError = error;

      console.error(JSON.stringify({
        event: 'webhook_failure',
        attempt,
        webhookUrl,
        jobUuid: payload.jobUuid,
        error: error.message,
        code: error.code,
        statusCode: error.response?.status,
        timestamp: new Date().toISOString()
      }));

      // Don't retry on 4xx errors (client errors)
      if (error.response && error.response.status >= 400 && error.response.status < 500) {
        console.log(JSON.stringify({
          event: 'webhook_abort',
          reason: '4xx_error',
          statusCode: error.response.status,
          jobUuid: payload.jobUuid
        }));

        return {
          success: false,
          attempts: attempt,
          statusCode: error.response.status,
          error: `HTTP ${error.response.status}: ${error.message}`
        };
      }

      // Continue retrying on 5xx or network errors
    }
  }

  // All attempts failed
  console.error(JSON.stringify({
    event: 'webhook_exhausted',
    webhookUrl,
    jobUuid: payload.jobUuid,
    attempts: maxAttempts,
    error: lastError?.message
  }));

  return {
    success: false,
    attempts: maxAttempts,
    error: lastError?.message || 'All webhook attempts failed'
  };
}

/**
 * Notify agent of paid job via webhook
 * @param {Object} job - Job object from database
 * @param {Object} skill - Skill object from database
 * @param {Object} agent - Agent object from database
 */
async function notifyAgent(job, skill, agent) {
  if (!agent.webhook_url) {
    console.log(JSON.stringify({
      event: 'webhook_skip',
      reason: 'no_webhook_url',
      agentId: agent.id,
      jobUuid: job.job_uuid
    }));
    return { success: false, skipped: true, reason: 'no_webhook_url' };
  }

  const payload = {
    jobUuid: job.job_uuid,
    agentId: agent.id,
    skillId: skill.id,
    serviceKey: skill.service_key,
    input: job.input_data,
    price: parseFloat(job.price_usdc),
    paidAt: job.paid_at || new Date().toISOString()
  };

  const result = await deliverWebhook(agent.webhook_url, payload);

  // Log delivery to database (fire and forget)
  db.logWebhookDelivery(job.id, agent.id, agent.webhook_url, result)
    .catch(err => console.error('Failed to log webhook delivery:', err));

  return result;
}

// ============================================
// PHASE 2: WEBHOOK EVENT DISPATCHER
// ============================================
const crypto = require('crypto');
const logger = require('./logger');

/**
 * Job event types for Phase 2 webhooks
 */
const JobEvents = {
  BID_RECEIVED: 'job.bid_received',
  ACCEPTED: 'job.accepted',
  PAID: 'job.paid',
  IN_PROGRESS: 'job.in_progress',
  DELIVERED: 'job.delivered',
  APPROVED: 'job.approved',
  COMPLETED: 'job.completed',
  DISPUTED: 'job.disputed',
  PAYMENT_RELEASED: 'job.payment_released',
  REVISION_REQUESTED: 'job.revision_requested'
};

/**
 * Dispatch a webhook event to all registered listeners (Phase 2)
 */
async function dispatchWebhookEvent(agentId, eventType, data) {
  try {
    const webhooks = await db.getWebhooksForEvent(agentId, eventType);
    
    if (!webhooks || webhooks.length === 0) {
      return;
    }
    
    for (const webhook of webhooks) {
      const payload = {
        id: `evt_${crypto.randomBytes(12).toString('hex')}`,
        type: eventType,
        created: Math.floor(Date.now() / 1000),
        data
      };
      
      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(JSON.stringify(payload))
        .digest('hex');
      
      // Fire and forget delivery with signed payload
      deliverSignedWebhook(webhook, payload, signature).catch(err => {
        logger.error('Phase 2 webhook delivery failed', { webhookId: webhook.id, error: err.message });
      });
    }
    
    logger.info('Webhook event dispatched', { agentId, eventType, count: webhooks.length });
  } catch (error) {
    logger.error('Webhook dispatch error', { agentId, eventType, error: error.message });
  }
}

/**
 * Deliver signed webhook (Phase 2 format)
 */
async function deliverSignedWebhook(webhook, payload, signature, attempt = 1) {
  const maxAttempts = 3;
  
  try {
    const response = await axios.post(webhook.url, payload, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'X-Botique-Signature': signature,
        'X-Botique-Event': payload.type,
        'X-Botique-Delivery': payload.id,
        'User-Agent': 'TheBotique/2.0'
      }
    });
    
    await db.updateWebhookStatus(webhook.id, true);
    return true;
  } catch (error) {
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
      return deliverSignedWebhook(webhook, payload, signature, attempt + 1);
    }
    await db.updateWebhookStatus(webhook.id, false);
    throw error;
  }
}

/**
 * Event dispatchers for specific job events
 */
async function onJobPaid(job, skill) {
  await dispatchWebhookEvent(job.agent_id, JobEvents.PAID, {
    job_uuid: job.job_uuid,
    agent_id: job.agent_id,
    price_usdc: parseFloat(job.price_usdc),
    skill_name: skill?.name || 'Unknown',
    skill_id: job.skill_id,
    requester_wallet: job.requester_wallet,
    input_data: job.input_data
  });
}

async function onJobAccepted(job) {
  await dispatchWebhookEvent(job.agent_id, JobEvents.ACCEPTED, {
    job_uuid: job.job_uuid,
    agent_id: job.agent_id,
    price_usdc: parseFloat(job.price_usdc)
  });
}

async function onJobDelivered(job) {
  await dispatchWebhookEvent(job.agent_id, JobEvents.DELIVERED, {
    job_uuid: job.job_uuid,
    agent_id: job.agent_id
  });
}

async function onJobApproved(job) {
  await dispatchWebhookEvent(job.agent_id, JobEvents.APPROVED, {
    job_uuid: job.job_uuid,
    agent_id: job.agent_id,
    price_usdc: parseFloat(job.price_usdc)
  });
  
  await dispatchWebhookEvent(job.agent_id, JobEvents.PAYMENT_RELEASED, {
    job_uuid: job.job_uuid,
    agent_id: job.agent_id,
    amount_usdc: parseFloat(job.price_usdc)
  });
}

async function onJobDisputed(job, reason) {
  await dispatchWebhookEvent(job.agent_id, JobEvents.DISPUTED, {
    job_uuid: job.job_uuid,
    agent_id: job.agent_id,
    reason
  });
}

async function onRevisionRequested(job, feedback) {
  await dispatchWebhookEvent(job.agent_id, JobEvents.REVISION_REQUESTED, {
    job_uuid: job.job_uuid,
    agent_id: job.agent_id,
    feedback
  });
}

module.exports = {
  // Legacy
  deliverWebhook,
  notifyAgent,
  // Phase 2
  JobEvents,
  dispatchWebhookEvent,
  onJobPaid,
  onJobAccepted,
  onJobDelivered,
  onJobApproved,
  onJobDisputed,
  onRevisionRequested
};
