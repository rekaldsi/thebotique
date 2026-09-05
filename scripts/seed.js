require('dotenv').config();
const db = require('../src/db');
const { getAllServices } = require('../src/services');
const logger = require('../src/logger');

// MrMagoochi configuration
const MRMAGOOCHI_WALLET = '0xA193128362e6dE28E6D51eEbc98505672FFeb3c5';
const MRMAGOOCHI_NAME = 'MrMagoochi';

/**
 * Main seeding function
 */
async function seed() {
  try {
    logger.info('Starting database seed...');

    // 1. Create or get MrMagoochi user
    logger.info('Checking for MrMagoochi user...');
    let user = await db.getUser(MRMAGOOCHI_WALLET);

    if (user) {
      logger.info('MrMagoochi user already exists', {
        userId: user.id,
        wallet: user.wallet_address,
        name: user.name
      });
    } else {
      logger.info('Creating MrMagoochi user...');
      user = await db.createUser(MRMAGOOCHI_WALLET, 'agent', MRMAGOOCHI_NAME);
      logger.info('MrMagoochi user created', {
        userId: user.id,
        wallet: user.wallet_address,
        name: user.name
      });
    }

    // 2. Create or get MrMagoochi agent
    logger.info('Checking for MrMagoochi agent...');
    let agent = await db.getAgent(user.id);

    if (agent) {
      logger.info('MrMagoochi agent already exists', {
        agentId: agent.id,
        userId: agent.user_id,
        apiKey: agent.api_key ? `${agent.api_key.substring(0, 10)}...` : null,
        webhookUrl: agent.webhook_url || 'none (hub processes directly)'
      });
    } else {
      logger.info('Creating MrMagoochi agent...');
      // webhook_url = null means hub processes jobs directly (no external webhook)
      agent = await db.createAgent(user.id, null);
      logger.info('MrMagoochi agent created', {
        agentId: agent.id,
        userId: agent.user_id,
        apiKey: agent.api_key ? `${agent.api_key.substring(0, 10)}...` : null,
        webhookUrl: 'none (hub processes directly)'
      });
    }

    // 3. Create or update skills from services.js
    logger.info('Seeding skills from services.js...');
    const services = getAllServices();
    logger.info(`Found ${services.length} services to seed`);

    // Get existing skills for this agent
    const existingSkills = await db.getSkillsByAgent(agent.id);
    const existingServiceKeys = new Set(existingSkills.map(s => s.service_key));

    let created = 0;
    let skipped = 0;

    for (const service of services) {
      if (existingServiceKeys.has(service.key)) {
        logger.info(`Skill already exists: ${service.key}`, {
          name: service.name,
          category: service.category,
          price: service.price
        });
        skipped++;
      } else {
        logger.info(`Creating skill: ${service.key}`, {
          name: service.name,
          category: service.category,
          price: service.price
        });

        const skill = await db.createSkill(
          agent.id,
          service.name,
          service.description,
          service.category,
          service.price,
          service.estimatedTime
        );

        // Update service_key for mapping
        await db.query(
          'UPDATE skills SET service_key = $1 WHERE id = $2',
          [service.key, skill.id]
        );

        created++;
      }
    }

    logger.info('Skills seeding complete', {
      total: services.length,
      created,
      skipped,
      categories: {
        creative: services.filter(s => s.category === 'creative').length,
        research: services.filter(s => s.category === 'research').length,
        technical: services.filter(s => s.category === 'technical').length,
        documents: services.filter(s => s.category === 'documents').length,
        productivity: services.filter(s => s.category === 'productivity').length,
        visual: services.filter(s => s.category === 'visual').length
      }
    });

    logger.info('Database seed complete!');
  } catch (error) {
    logger.error('Seed failed', { error: error.message, stack: error.stack });
    throw error;
  } finally {
    // Close database connection
    await db.closePool();
  }
}

// Run if called directly
if (require.main === module) {
  seed()
    .then(() => {
      logger.info('Seed script finished successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Seed script failed', { error: error.message });
      process.exit(1);
    });
}

module.exports = { seed };
