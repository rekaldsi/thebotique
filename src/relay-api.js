// Simple HTTP API for Agent Relay
// Endpoint: POST /relay/send, GET /relay/messages/:agent

const express = require('express');
const router = express.Router();
const { sendAgentMessage, getUnreadMessages, getRecentMessages, initAgentRelay } = require('./agent-relay');

// Initialize on load
initAgentRelay().catch(console.error);

// Send a message
router.post('/send', async (req, res) => {
  try {
    const { from, to, message, metadata } = req.body;
    if (!from || !message) {
      return res.status(400).json({ error: 'from and message required' });
    }
    const msg = await sendAgentMessage(from, to || null, message, metadata || {});
    res.json({ ok: true, message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get unread messages for an agent
router.get('/messages/:agent', async (req, res) => {
  try {
    const messages = await getUnreadMessages(req.params.agent, req.query.mark !== 'false');
    res.json({ ok: true, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get recent message history
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const messages = await getRecentMessages(limit);
    res.json({ ok: true, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
