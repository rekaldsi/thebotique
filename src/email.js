// Email sending via Gmail SMTP
const nodemailer = require('nodemailer');

// Gmail SMTP configuration
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_EMAIL || 'mrmagoochi@gmail.com',
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

/**
 * Send an email via Gmail SMTP
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.body - Email body (plain text)
 * @param {string} [options.html] - Email body (HTML)
 * @param {string} [options.cc] - CC recipients
 * @param {string} [options.bcc] - BCC recipients
 * @returns {Promise<Object>} - Send result
 */
async function sendEmail({ to, subject, body, html, cc, bcc }) {
  if (!process.env.GMAIL_APP_PASSWORD) {
    throw new Error('GMAIL_APP_PASSWORD not configured');
  }

  const mailOptions = {
    from: `"MrMagoochi" <${process.env.GMAIL_EMAIL || 'mrmagoochi@gmail.com'}>`,
    to,
    subject,
    text: body
  };

  if (html) mailOptions.html = html;
  if (cc) mailOptions.cc = cc;
  if (bcc) mailOptions.bcc = bcc;

  const result = await transporter.sendMail(mailOptions);
  
  return {
    success: true,
    messageId: result.messageId,
    to,
    subject
  };
}

/**
 * Email templates for TheBotique notifications
 */
const emailTemplates = {
  jobCompleted: (job, agentName) => ({
    subject: `✅ Your task is complete - ${job.skill_name || 'Task'}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <span style="font-size: 32px;">✨</span>
          <h1 style="margin: 8px 0; color: #1f2937;">TheBotique</h1>
        </div>
        <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <h2 style="margin: 0 0 8px; color: #166534;">✅ Task Completed!</h2>
          <p style="margin: 0; color: #15803d;">${agentName} has delivered your work.</p>
        </div>
        <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <p style="margin: 0 0 8px;"><strong>Task:</strong> ${job.skill_name || 'Service'}</p>
          <p style="margin: 0 0 8px;"><strong>Amount:</strong> $${Number(job.price_usdc).toFixed(2)} USDC</p>
          <p style="margin: 0;"><strong>Job ID:</strong> ${job.job_uuid.slice(0, 8)}...</p>
        </div>
        <div style="text-align: center;">
          <a href="https://www.thebotique.ai/job/${job.job_uuid}" style="display: inline-block; background: #f97316; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">View Results →</a>
        </div>
        <p style="text-align: center; color: #6b7280; font-size: 14px; margin-top: 24px;">
          Review the deliverable and approve to release payment.
        </p>
      </div>
    `
  }),

  jobDelivered: (job, agentName) => ({
    subject: `📦 Work delivered - Review required`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <span style="font-size: 32px;">✨</span>
          <h1 style="margin: 8px 0; color: #1f2937;">TheBotique</h1>
        </div>
        <div style="background: #eff6ff; border: 1px solid #93c5fd; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <h2 style="margin: 0 0 8px; color: #1e40af;">📦 Work Delivered</h2>
          <p style="margin: 0; color: #1d4ed8;">${agentName} has submitted the deliverable for your review.</p>
        </div>
        <div style="text-align: center;">
          <a href="https://www.thebotique.ai/job/${job.job_uuid}" style="display: inline-block; background: #f97316; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Review & Approve →</a>
        </div>
        <p style="text-align: center; color: #6b7280; font-size: 14px; margin-top: 24px;">
          You have 7 days to review. After that, payment auto-releases.
        </p>
      </div>
    `
  }),

  newTask: (job, hirerName) => ({
    subject: `🎉 New task request - $${Number(job.price_usdc).toFixed(2)}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <span style="font-size: 32px;">✨</span>
          <h1 style="margin: 8px 0; color: #1f2937;">TheBotique</h1>
        </div>
        <div style="background: #fef3c7; border: 1px solid #fcd34d; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <h2 style="margin: 0 0 8px; color: #92400e;">🎉 New Task!</h2>
          <p style="margin: 0; color: #a16207;">You have a new paid task waiting.</p>
        </div>
        <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <p style="margin: 0 0 8px;"><strong>Service:</strong> ${job.skill_name || 'Service'}</p>
          <p style="margin: 0 0 8px;"><strong>Payment:</strong> $${Number(job.price_usdc).toFixed(2)} USDC</p>
          <p style="margin: 0;"><strong>From:</strong> ${hirerName || 'Anonymous'}</p>
        </div>
        <div style="text-align: center;">
          <a href="https://www.thebotique.ai/dashboard" style="display: inline-block; background: #f97316; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">View in Dashboard →</a>
        </div>
      </div>
    `
  }),

  trustTierUp: (agentName, newTier, tierLabel) => ({
    subject: `🎊 Congrats! You reached ${tierLabel} tier`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <span style="font-size: 32px;">✨</span>
          <h1 style="margin: 8px 0; color: #1f2937;">TheBotique</h1>
        </div>
        <div style="background: linear-gradient(135deg, #fef3c7, #fde68a); border-radius: 8px; padding: 24px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 48px;">🎊</span>
          <h2 style="margin: 16px 0 8px; color: #92400e;">Level Up!</h2>
          <p style="margin: 0; color: #a16207; font-size: 18px;">${agentName} is now <strong>${tierLabel}</strong></p>
        </div>
        <p style="text-align: center; color: #6b7280;">
          Keep up the great work! Higher tiers unlock better search placement and lower fees.
        </p>
        <div style="text-align: center; margin-top: 24px;">
          <a href="https://www.thebotique.ai/dashboard" style="display: inline-block; background: #f97316; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">View Dashboard →</a>
        </div>
      </div>
    `
  })
};

/**
 * Send a job notification email
 */
async function sendJobNotification(type, job, recipientEmail, extraData = {}) {
  if (!recipientEmail || !process.env.GMAIL_APP_PASSWORD) {
    console.log('Skipping email notification - no email or SMTP not configured');
    return null;
  }

  try {
    const template = emailTemplates[type];
    if (!template) {
      console.error('Unknown email template:', type);
      return null;
    }

    const { subject, html } = template(job, extraData.agentName || extraData.hirerName || 'Agent');
    
    return await sendEmail({
      to: recipientEmail,
      subject,
      body: subject, // Fallback plain text
      html
    });
  } catch (error) {
    console.error('Failed to send notification email:', error);
    return null;
  }
}

module.exports = { sendEmail, sendJobNotification, emailTemplates };
