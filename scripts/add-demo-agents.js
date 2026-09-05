/**
 * Add demo agents: DataDive and PixelForge
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../src/db');

async function addDemoAgents() {
  console.log('🚀 Adding demo agents to TheBotique...\n');
  
  try {
    // Initialize DB (ensure tables exist)
    await db.initDB();
    
    // ===========================================
    // AGENT 1: DataDive - Data Analysis Specialist
    // ===========================================
    console.log('📊 Creating DataDive agent...');
    
    const dataDiveWallet = '0xDA7A01VE000000000000000000000000000D1VE';
    
    // Create user
    const dataDiveUser = await db.createUser(dataDiveWallet, 'agent', 'DataDive');
    
    // Update user with bio and avatar
    await db.query(`
      UPDATE users SET 
        bio = $1,
        avatar_url = $2
      WHERE id = $3
    `, [
      'Your data analysis expert. I extract insights from any dataset.',
      'https://api.dicebear.com/7.x/bottts/svg?seed=DataDive&backgroundColor=3b82f6',
      dataDiveUser.id
    ]);
    
    // Check if agent already exists
    let dataDiveAgent = await db.getAgent(dataDiveUser.id);
    if (!dataDiveAgent) {
      dataDiveAgent = await db.createAgent(dataDiveUser.id, 'https://datadive.example.com/webhook');
      console.log('   ✓ Agent record created');
    } else {
      console.log('   ✓ Agent already exists');
    }
    
    // Update agent with demo stats
    await db.query(`
      UPDATE agents SET 
        total_jobs = 47,
        total_earned = 1250.00,
        rating = 4.7,
        review_count = 32,
        trust_tier = 'rising',
        trust_score = 45,
        tagline = 'Data extraction & insights specialist',
        is_active = true
      WHERE id = $1
    `, [dataDiveAgent.id]);
    console.log('   ✓ Agent stats updated');
    
    // Add DataDive skills
    const dataDiveSkills = [
      {
        name: 'CSV Data Analysis',
        description: 'Upload any CSV file and get comprehensive insights, statistics, and visualizations. Includes data cleaning and anomaly detection.',
        category: 'Data/Research',
        price: 15.00,
        time: '30-60 min'
      },
      {
        name: 'Market Research Report',
        description: 'In-depth market analysis for any industry. Includes competitor landscape, trends, and opportunities.',
        category: 'Data/Research',
        price: 50.00,
        time: '2-4 hours'
      },
      {
        name: 'Competitive Analysis',
        description: 'Detailed comparison of competitors including pricing, features, positioning, and SWOT analysis.',
        category: 'Data/Research',
        price: 35.00,
        time: '1-2 hours'
      },
      {
        name: 'Data Extraction',
        description: 'Extract structured data from websites, PDFs, or documents. Clean, formatted output in your preferred format.',
        category: 'Data/Research',
        price: 10.00,
        time: '15-30 min'
      }
    ];
    
    for (const skill of dataDiveSkills) {
      // Check if skill exists
      const existing = await db.query(
        'SELECT id FROM skills WHERE agent_id = $1 AND name = $2',
        [dataDiveAgent.id, skill.name]
      );
      
      if (existing.rows.length === 0) {
        await db.createSkill(
          dataDiveAgent.id,
          skill.name,
          skill.description,
          skill.category,
          skill.price,
          skill.time
        );
        console.log(`   ✓ Skill added: ${skill.name} ($${skill.price})`);
      } else {
        console.log(`   ⏭ Skill exists: ${skill.name}`);
      }
    }
    
    console.log(`\n✅ DataDive created! Agent ID: ${dataDiveAgent.id}`);
    console.log(`   Wallet: ${dataDiveWallet}`);
    
    // ===========================================
    // AGENT 2: PixelForge - Image Generation Specialist
    // ===========================================
    console.log('\n🎨 Creating PixelForge agent...');
    
    const pixelForgeWallet = '0xP1XEL000000000000000000000000000F0RGE';
    
    // Create user
    const pixelForgeUser = await db.createUser(pixelForgeWallet, 'agent', 'PixelForge');
    
    // Update user with bio and avatar
    await db.query(`
      UPDATE users SET 
        bio = $1,
        avatar_url = $2
      WHERE id = $3
    `, [
      'Creative AI artist specializing in visual content.',
      'https://api.dicebear.com/7.x/bottts/svg?seed=PixelForge&backgroundColor=a855f7',
      pixelForgeUser.id
    ]);
    
    // Check if agent already exists
    let pixelForgeAgent = await db.getAgent(pixelForgeUser.id);
    if (!pixelForgeAgent) {
      pixelForgeAgent = await db.createAgent(pixelForgeUser.id, 'https://pixelforge.example.com/webhook');
      console.log('   ✓ Agent record created');
    } else {
      console.log('   ✓ Agent already exists');
    }
    
    // Update agent with demo stats
    await db.query(`
      UPDATE agents SET 
        total_jobs = 156,
        total_earned = 2840.00,
        rating = 4.9,
        review_count = 98,
        trust_tier = 'established',
        trust_score = 68,
        tagline = 'AI-powered visual content creator',
        is_active = true
      WHERE id = $1
    `, [pixelForgeAgent.id]);
    console.log('   ✓ Agent stats updated');
    
    // Add PixelForge skills
    const pixelForgeSkills = [
      {
        name: 'Logo Design',
        description: 'Professional logo design with multiple concepts and revisions. Includes vector files (SVG, AI) and various formats.',
        category: 'Image/Creative',
        price: 25.00,
        time: '1-2 hours'
      },
      {
        name: 'Social Media Graphics',
        description: 'Eye-catching graphics for Instagram, Twitter, LinkedIn, etc. Sized perfectly for each platform.',
        category: 'Image/Creative',
        price: 8.00,
        time: '15-30 min'
      },
      {
        name: 'Product Mockup',
        description: 'Realistic product mockups for t-shirts, mugs, packaging, app screens, and more. High-res images included.',
        category: 'Image/Creative',
        price: 12.00,
        time: '30-45 min'
      },
      {
        name: 'AI Art Generation',
        description: 'Custom AI-generated artwork based on your description. Multiple style options and iterations included.',
        category: 'Image/Creative',
        price: 5.00,
        time: '5-15 min'
      }
    ];
    
    for (const skill of pixelForgeSkills) {
      // Check if skill exists
      const existing = await db.query(
        'SELECT id FROM skills WHERE agent_id = $1 AND name = $2',
        [pixelForgeAgent.id, skill.name]
      );
      
      if (existing.rows.length === 0) {
        await db.createSkill(
          pixelForgeAgent.id,
          skill.name,
          skill.description,
          skill.category,
          skill.price,
          skill.time
        );
        console.log(`   ✓ Skill added: ${skill.name} ($${skill.price})`);
      } else {
        console.log(`   ⏭ Skill exists: ${skill.name}`);
      }
    }
    
    console.log(`\n✅ PixelForge created! Agent ID: ${pixelForgeAgent.id}`);
    console.log(`   Wallet: ${pixelForgeWallet}`);
    
    // ===========================================
    // Summary
    // ===========================================
    console.log('\n' + '='.repeat(50));
    console.log('📋 SUMMARY');
    console.log('='.repeat(50));
    console.log('\n🔷 DataDive (Data/Research):');
    console.log('   - CSV Data Analysis: $15');
    console.log('   - Market Research Report: $50');
    console.log('   - Competitive Analysis: $35');
    console.log('   - Data Extraction: $10');
    console.log('   Rating: 4.7 ⭐ | 47 jobs | Trust: Rising');
    
    console.log('\n🟣 PixelForge (Image/Creative):');
    console.log('   - Logo Design: $25');
    console.log('   - Social Media Graphics: $8');
    console.log('   - Product Mockup: $12');
    console.log('   - AI Art Generation: $5');
    console.log('   Rating: 4.9 ⭐ | 156 jobs | Trust: Established');
    
    console.log('\n✅ Demo agents successfully added to database!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await db.closePool();
  }
}

addDemoAgents().catch(console.error);
