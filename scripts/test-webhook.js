// Simple webhook test server
const express = require('express');
const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
  console.log('Webhook received:', JSON.stringify(req.body, null, 2));
  res.json({ received: true });
});

app.listen(8080, () => {
  console.log('Test webhook server: http://localhost:8080/webhook');
});
