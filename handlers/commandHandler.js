const { normalizeJid } = require('../utils/jidNormalizer');
const { localSpamCheck } = require('../utils/spamDetector');
const spamStats = require('../models/stats');

async function getGroupsList(sock) {
  try {
    const groups = await sock.groupFetchAllParticipating();
    const botId = normalizeJid(sock.user.id);
    const adminCheckId = normalizeJid(process.env.ADMIN_JID_CHECK);

    const list = Object.values(groups).map((g) => {
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

async function sendGroupListToAdmin(sock) {
  if (!sock || !sock.user) {
    console.log("⚠️ Not connected yet, cannot send group list");
    return;
  }

  try {
    const groups = await getGroupsList(sock);

    if (!groups.length) {
      await sock.sendMessage(process.env.ADMIN_JID_SEND, {
        text: "📭 No groups found.",
      });
      return;
    }

    let message = "📋 *WA Protect Group List:*\n\n";
    groups.forEach((g, i) => {
      message += `${i + 1}. *${g.name}*\n   ID: ${g.id}\n   👤 Admin: ${
        g.isHumanAdmin ? "✅ Yes" : "❌ No"
      }\n   🤖 Bot Admin: ${g.isBotAdmin ? "✅ Yes" : "❌ No"}\n\n`;
    });

    await sock.sendMessage(process.env.ADMIN_JID_SEND, { text: message.trim() });
    console.log("✅ Sent group list to admin.");
  } catch (err) {
    console.error("Failed to send group list:", err);
  }
}

async function sendSpamStats(sock) {
  if (!sock) return;
  
  const stats = spamStats.getStats();
  const efficiency = stats.totalProcessed > 0 ? 
    ((stats.localFlagged / stats.totalProcessed) * 100).toFixed(1) : 0;

  const statsMessage = `📊 *Spam Protection Stats*\n
🤖 *Local Detection Engine*
Total Messages Processed: ${stats.totalProcessed}
Locally Flagged: ${stats.localFlagged}
Gemini Analyses: ${stats.geminiAnalyzed}

🛡️ *Actions Taken*
Messages Deleted: ${stats.messagesDeleted}
Users Removed: ${stats.usersRemoved}
Warnings Sent: ${stats.warningsSent}

⚡ *Efficiency*
Local Filter Rate: ${efficiency}%
API Call Savings: ~${(100 - (stats.geminiAnalyzed / stats.totalProcessed * 100)).toFixed(1)}%`;

  await sock.sendMessage(process.env.ADMIN_JID_SEND, { text: statsMessage });
}

async function testLocalDetection(sock, testMessage) {
  if (!testMessage) {
    await sock.sendMessage(process.env.ADMIN_JID_SEND, {
      text: "❌ Please provide a message to test:\n`test local Your message here`"
    });
    return;
  }

  const analysis = localSpamCheck(testMessage, "test");
  
  const resultMessage = `🧪 *Local Detection Test*\n
*Message:* ${testMessage}
*Score:* ${analysis.score}/100
*Confidence:* ${analysis.details.confidence}
*Action:* ${analysis.localDecision}
*Flags:* ${analysis.flags.join(', ')}

*Detected Patterns:*
${analysis.details.detectedPatterns.map(p => `• ${p}`).join('\n')}`;

  await sock.sendMessage(process.env.ADMIN_JID_SEND, { text: resultMessage });
}

async function handleAdminCommand(sock, text, sender) {
  const command = text.toLowerCase().trim();
  
  if (command === "list groups") {
    console.log("✅ Processing 'list groups' command");
    await sendGroupListToAdmin(sock);
  } else if (command === "spam stats") {
    console.log("✅ Processing 'spam stats' command");
    await sendSpamStats(sock);
  } else if (command.startsWith("test local ")) {
    console.log("✅ Processing 'test local' command");
    await testLocalDetection(sock, text.replace("test local", "").trim());
  } else {
    console.log(`⚠️ Unknown command from admin: ${command}`);
    await sock.sendMessage(process.env.ADMIN_JID_SEND, {
      text: `❓ Unknown command. Available commands:\n\n• *list groups* — See all groups\n• *spam stats* — Protection statistics\n• *test local <message>* — Test detection`
    });
  }
}

module.exports = {
  handleAdminCommand,
  sendGroupListToAdmin,
  sendSpamStats,
  testLocalDetection
};