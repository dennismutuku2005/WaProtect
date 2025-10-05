require("dotenv").config();

module.exports = {
  PORT: process.env.PORT || 3000,
  ADMIN_JID_SEND: process.env.ADMIN_JID_SEND,
  ADMIN_JID_CHECK: process.env.ADMIN_JID_CHECK,
  PING_INTERVAL: parseInt(process.env.PING_INTERVAL || "60000"),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  
  // Spam detection thresholds
  SPAM_THRESHOLDS: {
    HIGH_CONFIDENCE: 70,
    SUSPICIOUS: 45,
    REVIEW: 60
  }
};