const { normalizeJid } = require('../utils/jidNormalizer');
const spamStats = require('../models/stats');

async function handleSpamMessage(sock, message, localAnalysis, geminiAnalysis) {
  const from = message.key.remoteJid;
  const sender = message.key.participant || from;
  const messageText = message.message.conversation || 
                     message.message.extendedTextMessage?.text || "";

  console.log(`🛡️ Processing message from ${sender}: ${messageText.substring(0, 50)}...`);

  // Update spam statistics
  spamStats.increment('totalProcessed');
  if (localAnalysis.isSuspicious) spamStats.increment('localFlagged');
  if (geminiAnalysis) spamStats.increment('geminiAnalyzed');

  // Check if bot is admin in the group
  const groupMetadata = await sock.groupMetadata(from);
  const botJid = normalizeJid(process.env.ADMIN_JID_CHECK);
  
  const isBotAdmin = groupMetadata.participants.some(
    p => normalizeJid(p.id) === botJid && (p.admin === "admin" || p.admin === "superadmin")
  );

  console.log(`🔍 Bot JID: ${botJid}`);
  console.log(`🔍 Is Bot Admin: ${isBotAdmin}`);

  if (!isBotAdmin) {
    console.log("❌ Bot is not admin in this group, cannot take action");
    await sock.sendMessage(process.env.ADMIN_JID_SEND, {
      text: `⚠️ *SPAM DETECTED* (Cannot Act)\n\n*Group:* ${groupMetadata.subject}\n*Bot Status:* ❌ Not Admin\n\n*Action Required:* Make ${botJid} an admin in this group to enable spam deletion and user removal.\n\n*Spam Score:* ${localAnalysis.score}\n*Flags:* ${localAnalysis.flags.join(', ')}\n\n*From:* ${sender}\n*Message:* ${messageText}`
    });
    return;
  }

  const finalAnalysis = geminiAnalysis || {
    action: localAnalysis.localDecision,
    riskLevel: localAnalysis.score >= 70 ? 'high' : 'medium',
    reason: 'Local analysis only'
  };

  try {
    if (finalAnalysis.action === 'delete_immediate' || 
        finalAnalysis.riskLevel === 'critical' ||
        localAnalysis.score >= 85) {
      
      await sock.sendMessage(from, {
        delete: message.key
      });
      console.log("✅ Deleted high-risk spam message");
      spamStats.increment('messagesDeleted');

      await sock.groupParticipantsUpdate(from, [sender], "remove");
      console.log(`🚫 Removed user ${sender} from group for critical spam`);
      spamStats.increment('usersRemoved');

      await sock.sendMessage(process.env.ADMIN_JID_SEND, {
        text: `🚨 *CRITICAL SPAM ALERT*\n\n*Group:* ${groupMetadata.subject}\n*User:* ${sender}\n*Action:* ✅ Message deleted & user removed\n*Risk Level:* ${finalAnalysis.riskLevel}\n*Local Score:* ${localAnalysis.score}\n*Reason:* ${finalAnalysis.reason}\n*Flags:* ${localAnalysis.flags.join(', ')}\n\n*Message:* ${messageText}`
      });

    } else if (finalAnalysis.action === 'delete' || 
               finalAnalysis.riskLevel === 'high' ||
               localAnalysis.score >= 60) {
      
      await sock.sendMessage(from, {
        delete: message.key
      });
      console.log("✅ Deleted spam message");
      spamStats.increment('messagesDeleted');

      await sock.sendMessage(process.env.ADMIN_JID_SEND, {
        text: `🗑️ *Spam Message Deleted*\n\n*Group:* ${groupMetadata.subject}\n*User:* ${sender}\n*Risk Level:* ${finalAnalysis.riskLevel}\n*Score:* ${localAnalysis.score}\n*Reason:* ${finalAnalysis.reason}\n*Flags:* ${localAnalysis.flags.join(', ')}\n\n*Message:* ${messageText}`
      });

    } else if (finalAnalysis.action === 'warn' || 
               (finalAnalysis.riskLevel === 'medium' && localAnalysis.score >= 45)) {
      
      await sock.sendMessage(from, {
        text: `⚠️ *Community Guidelines Reminder*\n\nPlease avoid sending promotional content, financial offers, or suspicious links in this group. Repeated violations may result in removal.\n\n*Detected:* ${finalAnalysis.reason}`
      });
      spamStats.increment('warningsSent');
      
      await sock.sendMessage(process.env.ADMIN_JID_SEND, {
        text: `⚠️ *Warning Sent for Suspicious Message*\n\n*Group:* ${groupMetadata.subject}\n*User:* ${sender}\n*Risk Level:* ${finalAnalysis.riskLevel}\n*Score:* ${localAnalysis.score}\n*Reason:* ${finalAnalysis.reason}\n\n*Message:* ${messageText}`
      });

    } else if (localAnalysis.isSuspicious) {
      await sock.sendMessage(process.env.ADMIN_JID_SEND, {
        text: `👀 *Suspicious Message Monitored*\n\n*Group:* ${groupMetadata.subject}\n*User:* ${sender}\n*Score:* ${localAnalysis.score}\n*Flags:* ${localAnalysis.flags.join(', ')}\n*Action:* Monitoring only\n\n*Message:* ${messageText}`
      });
    }

  } catch (error) {
    console.error("❌ Error taking action on spam:", error);
    await sock.sendMessage(process.env.ADMIN_JID_SEND, {
      text: `❌ *Failed to take action on spam*\n\n*Error:* ${error.message}\n*Group:* ${groupMetadata.subject}\n*User:* ${sender}\n\n*Original Message:* ${messageText}`
    });
  }
}

module.exports = {
  handleSpamMessage
};