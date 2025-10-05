const qrcode = require("qrcode-terminal");
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const { localSpamCheck } = require('../utils/spamDetector');
const { analyzeWithGemini } = require('./gemini');
const { handleSpamMessage } = require('../handlers/spamHandler');
const { handleAdminCommand } = require('../handlers/commandHandler');
const { normalizeJid } = require('../utils/jidNormalizer');

class WhatsAppService {
  constructor() {
    this.sock = null;
    this.isConnected = false;
    this.pingInterval = null;
  }

  async start() {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["WA Protect", "Chrome", "1.0"],
    });

    this.setupEventHandlers(saveCreds);
  }

  setupEventHandlers(saveCreds) {
    this.sock.ev.on("connection.update", (update) => {
      this.handleConnectionUpdate(update);
    });

    this.sock.ev.on("messages.upsert", async (m) => {
      await this.handleMessagesUpsert(m);
    });

    this.sock.ev.on("creds.update", saveCreds);
  }

  handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📱 Scan this QR code to log in:");
      qrcode.generate(qr, { small: true });
      this.isConnected = false;
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Connection closed:", reason);
      this.isConnected = false;
      clearInterval(this.pingInterval);
      if (reason !== DisconnectReason.loggedOut) this.start();
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
      this.isConnected = true;
      clearInterval(this.pingInterval);
      this.setupPingInterval();
      this.sendStartupMessage();
    }
  }

  async handleMessagesUpsert(m) {
    const msg = m.messages[0];
    if (!msg.message || !msg.key.remoteJid) return;

    const from = msg.key.remoteJid;
    const sender = msg.key.participant || from;

    // Ignore messages from ourselves
    if (msg.key.fromMe) {
      return;
    }

    const text = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                "";

    // Handle private messages (DMs) - Including Admin Commands
    if (!from.endsWith('@g.us')) {
      console.log(`📩 Private message from ${sender}: ${text.substring(0, 50)}...`);
      
      // Check if it's from admin
      if (normalizeJid(sender) === normalizeJid(process.env.ADMIN_JID_SEND)) {
        await handleAdminCommand(this.sock, text, sender);
      }
      return;
    }

    // Spam detection for group messages only
    if (text.trim().length === 0) return;

    console.log(`📨 Message in group from ${sender}: ${text.substring(0, 50)}...`);
    
    const localAnalysis = localSpamCheck(text, sender);
    
    if (localAnalysis.isHighConfidenceSpam) {
      console.log("🚨 High confidence spam detected, taking immediate action...");
      await handleSpamMessage(this.sock, msg, localAnalysis, null);
    } else if (localAnalysis.isSuspicious) {
      console.log("🔍 Suspicious message detected, sending to Gemini...");
      const geminiAnalysis = await analyzeWithGemini(text, localAnalysis);
      await handleSpamMessage(this.sock, msg, localAnalysis, geminiAnalysis);
    }
  }

  setupPingInterval() {
    this.pingInterval = setInterval(async () => {
      if (this.sock && this.isConnected) {
        try {
          await this.sock.query({
            tag: "iq",
            attrs: { type: "get", xmlns: "w:p", to: "@s.whatsapp.net" },
          });
          console.log("💓 Ping successful");
        } catch (err) {
          console.error("Ping failed:", err);
        }
      }
    }, parseInt(process.env.PING_INTERVAL || "60000"));
  }

  async sendStartupMessage() {
    try {
      await this.sock.sendMessage(process.env.ADMIN_JID_SEND, {
        text: `🤖 *WA Protect AI Agent v2.0 Online!*\n\n🛡️ *Enhanced Spam Protection*\n• Trained local detection algorithm\n• Gemini AI analysis for suspicious messages\n• Kenyan scam pattern recognition\n\n*Commands:*\n👉 *list groups* — See all groups\n👉 *spam stats* — Protection statistics\n👉 *test local <message>* — Test detection`
      });
      console.log("✅ Sent startup message to admin.");
    } catch (error) {
      console.error("Failed to send startup message:", error);
    }
  }

  getSocket() {
    return this.sock;
  }

  getConnectionStatus() {
    return this.isConnected;
  }
}

module.exports = WhatsAppService;