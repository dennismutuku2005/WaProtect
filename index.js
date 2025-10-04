require("dotenv").config();
const express = require("express");
const qrcode = require("qrcode-terminal");
const cors = require("cors");
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_JID_SEND = process.env.ADMIN_JID_SEND;   // send messages here
const ADMIN_JID_CHECK = process.env.ADMIN_JID_CHECK; // check admin in group
const PING_INTERVAL = parseInt(process.env.PING_INTERVAL || "60000");

let sock;
let isConnected = false;
let pingInterval;

// ✅ Normalize JIDs
function normalizeJid(jid) {
  if (!jid) return "";
  return jid.split(":")[0].replace("@s.whatsapp.net", "").replace("@lid", "");
}

// 🚀 Initialize WhatsApp connection
async function startWhatsApp() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["WA Protect", "Chrome", "1.0"],
  });

  // 🔄 Connection updates
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📱 Scan this QR code to log in:");
      qrcode.generate(qr, { small: true });
      isConnected = false;
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Connection closed:", reason);
      isConnected = false;
      clearInterval(pingInterval);
      if (reason !== DisconnectReason.loggedOut) startWhatsApp();
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
      isConnected = true;
      clearInterval(pingInterval);
      setupPingInterval();
      sendStartupMessage();
    }
  });

  // 💬 Listen for messages (commands)
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || !msg.key.remoteJid) return;

    const from = msg.key.remoteJid;
    const sender = msg.key.participant || from;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    // 🧠 Commands from ADMIN_JID_SEND only
    if (sender === ADMIN_JID_SEND) {
      const command = text.toLowerCase().trim();
      if (command === "list groups") {
        await sendGroupListToAdmin();
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// 💓 Keep-alive ping
function setupPingInterval() {
  pingInterval = setInterval(async () => {
    if (sock && isConnected) {
      try {
        await sock.query({
          tag: "iq",
          attrs: { type: "get", xmlns: "w:p", to: "@s.whatsapp.net" },
        });
        console.log("💓 Ping successful");
      } catch (err) {
        console.error("Ping failed:", err);
      }
    }
  }, PING_INTERVAL);
}

// 📋 Fetch group list
async function getGroupsList() {
  try {
    const groups = await sock.groupFetchAllParticipating();

    const botId = normalizeJid(sock.user.id);
    const adminCheckId = normalizeJid(ADMIN_JID_CHECK);

    console.log("\n🤖 Bot ID:", botId);
    console.log("👤 Admin (check) ID:", adminCheckId);

    const list = Object.values(groups).map((g) => {
      console.log(`\n📣 Checking group: ${g.subject}`);
      console.log("Group ID:", g.id);

      g.participants.forEach((p) => {
        console.log(
          ` - ${p.id} | Admin: ${p.admin ? p.admin : "❌ not admin"}`
        );
      });

      const isBotAdmin = g.participants.some(
        (p) =>
          normalizeJid(p.id) === botId &&
          (p.admin === "admin" || p.admin === "superadmin")
      );

      const isHumanAdmin = g.participants.some(
        (p) =>
          normalizeJid(p.id) === adminCheckId &&
          (p.admin === "admin" || p.admin === "superadmin")
      );

      console.log(`🤖 Bot is admin? ${isBotAdmin ? "✅ YES" : "❌ NO"}`);
      console.log(
        `👤 Human Admin (${ADMIN_JID_CHECK}) is admin? ${
          isHumanAdmin ? "✅ YES" : "❌ NO"
        }`
      );

      return {
        id: g.id,
        name: g.subject,
        isBotAdmin,
        isHumanAdmin,
      };
    });

    return list;
  } catch (error) {
    console.error("❌ Error fetching groups:", error);
    return [];
  }
}

// 📨 Send group list to admin
async function sendGroupListToAdmin() {
  if (!sock || !isConnected) {
    console.log("⚠️ Not connected yet, cannot send group list");
    return;
  }

  try {
    const groups = await getGroupsList();

    if (!groups.length) {
      await sock.sendMessage(ADMIN_JID_SEND, {
        text: "📭 No groups found.",
      });
      console.log("Sent 'no groups' message to admin.");
      return;
    }

    let message = "📋 *WA Protect Group List:*\n\n";
    groups.forEach((g, i) => {
      message += `${i + 1}. *${g.name}*\n   ID: ${g.id}\n   👤 Admin: ${
        g.isHumanAdmin ? "✅ Yes" : "❌ No"
      }\n   🤖 Bot Admin: ${g.isBotAdmin ? "✅ Yes" : "❌ No"}\n\n`;
    });

    await sock.sendMessage(ADMIN_JID_SEND, { text: message.trim() });
    console.log("✅ Sent group list to admin.");
  } catch (err) {
    console.error("Failed to send group list:", err);
  }
}

// 🔔 Notify admin on startup
async function sendStartupMessage() {
  try {
    await sock.sendMessage(ADMIN_JID_SEND, {
      text: `🤖 *WA Protect AI Agent is online!*\n\nYou can send:\n👉 *list groups* — to see all groups I'm in.`,
    });
    console.log("✅ Sent startup message to admin.");
  } catch (error) {
    console.error("Failed to send startup message:", error);
  }
}

// 🌐 Express endpoints
app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    status: isConnected ? "Ready" : "Connecting...",
    timestamp: new Date().toISOString(),
  });
});

app.get("/groups", async (req, res) => {
  try {
    if (!isConnected) return res.status(503).json({ error: "Not connected" });
    const list = await getGroupsList();
    res.json({ total: list.length, groups: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🧹 Clean shutdown
process.on("SIGINT", () => {
  clearInterval(pingInterval);
  process.exit();
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

startWhatsApp().catch(console.error);
