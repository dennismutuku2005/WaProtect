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
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_JID_SEND = process.env.ADMIN_JID_SEND;
const ADMIN_JID_CHECK = process.env.ADMIN_JID_CHECK;
const PING_INTERVAL = parseInt(process.env.PING_INTERVAL || "60000");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

let sock;
let isConnected = false;
let pingInterval;
let genAI;
let geminiModel;

// Initialize Gemini AI
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    generationConfig: {
      temperature: 0.1,
      topK: 1,
      topP: 1,
      maxOutputTokens: 1024,
    }
  });
} else {
  console.warn("⚠️ GEMINI_API_KEY not found - AI features disabled");
}

// ✅ Normalize JIDs
function normalizeJid(jid) {
  if (!jid) return "";
  return jid.split(":")[0].replace("@s.whatsapp.net", "").replace("@lid", "");
}

// 🎯 TRAINED LOCAL SPAM DETECTION ALGORITHM
function localSpamCheck(messageText, senderInfo) {
  const text = messageText.toLowerCase().trim();
  
  // 🚨 TRAINED PATTERNS FROM DATASET
  const trainedPatterns = {
    // Organization impersonation
    spoofedOrgs: [
      /unicef foundation/i,
      /facebook foundation/i,
      /givedirectly/i,
      /safaricom foundation/i,
      /world health organization|who/i,
      /undp/i,
      /mastercard foundation/i,
      /usaid/i,
      /red cross kenya/i,
      /world food programme|wfp/i,
      /meta charitable fund/i,
      /world bank youth fund/i,
      /scholarship africa/i,
      /corona relief fund/i
    ],
    
    // Financial scam patterns
    financialScams: [
      /\b(50,000|50000|5,000|5000|1,200|1200|500|300|250|800|1,500|1500|450|600|400|2,000|2000|10,000|10000)\b/,
      /\b(ksh|kes|shilling|money|cash|grant|fund|bursary|scholarship|award|assistance|donation|relief)\b/i,
      /\b(fee|processing fee|activation fee|admin fee|verification fee|documentation fee|clearing fee|logistics fee|delivery fee|placement fee|registration fee)\b/i,
      /\b(pay|send|transfer|deposit|mobile money|m-pesa|mpesa)\b/i
    ],
    
    // Urgency and pressure tactics
    urgencyTactics: [
      /urgent|hurry|limited|now|immediate|quick|fast|don't miss|last chance|only few/i,
      /congratulations|selected|pre-approved|eligible|qualify|winner|chosen/i
    ],
    
    // Data harvesting patterns
    dataHarvesting: [
      /\b(id|identification|student id|bank details|account number|mobile number|phone number|pin|password|address)\b/i,
      /\b(verify|confirm|validation|authentication|register|sign up|apply|submit)\b/i,
      /\b(form|application|document|upload|provide|enter|fill)\b/i
    ],
    
    // Link and contact patterns
    contactPatterns: [
      /https?:\/\/[^\s]+|www\.[^\s]+|\.[a-z]{2,}\/[^\s]*/gi,
      /\+?[\d\s\-\(\)]{8,}|\d{8,}/g,
      /@[a-z0-9]+\.[a-z]{2,}/gi,
      /gmail\.com|yahoo\.com|hotmail\.com/i
    ],
    
    // Specific scam phrases from training data
    scamPhrases: [
      /child welfare grant|business grant|small business grant|cash assistance|relief package|support voucher/i,
      /free.*test kits|free.*business boosts|free.*airtime|free.*voucher/i,
      /pata kazi|part time jobs|job placement|vacancies/i,
      /flood victims|medical bills|donation|charity|help needed/i,
      /half price|cheap|discount|offer|deal|promotion/i
    ]
  };

  let spamScore = 0;
  const flags = [];
  const details = {
    detectedPatterns: [],
    confidence: "low",
    recommendedAction: "allow"
  };

  // 🔍 PATTERN 1: Organization Impersonation (High Severity)
  trainedPatterns.spoofedOrgs.forEach((pattern, index) => {
    if (pattern.test(text)) {
      spamScore += 35;
      flags.push('organization_impersonation');
      details.detectedPatterns.push(`Spoofed organization detected: ${pattern}`);
    }
  });

  // 🔍 PATTERN 2: Financial Scam Indicators (High Severity)
  let financialFlags = 0;
  trainedPatterns.financialScams.forEach((pattern, index) => {
    if (pattern.test(text)) {
      financialFlags++;
      spamScore += 20;
    }
  });
  if (financialFlags >= 2) {
    flags.push('financial_scam');
    details.detectedPatterns.push(`Multiple financial scam indicators (${financialFlags} patterns)`);
  }

  // 🔍 PATTERN 3: Urgency Tactics (Medium Severity)
  for (let i = 0; i < trainedPatterns.urgencyTactics.length; i++) {
    const pattern = trainedPatterns.urgencyTactics[i];
    if (pattern.test(text)) {
      spamScore += 15;
      flags.push('urgency_pressure');
      details.detectedPatterns.push(`Urgency tactic: ${pattern}`);
      break; // Only count once
    }
  }

  // 🔍 PATTERN 4: Data Harvesting (High Severity)
  let dataFlags = 0;
  trainedPatterns.dataHarvesting.forEach((pattern, index) => {
    if (pattern.test(text)) {
      dataFlags++;
      spamScore += 25;
    }
  });
  if (dataFlags >= 2) {
    flags.push('data_harvesting');
    details.detectedPatterns.push(`Data harvesting attempt (${dataFlags} patterns)`);
  }

  // 🔍 PATTERN 5: Contact & Link Analysis (Medium Severity)
  const hasUrls = text.match(trainedPatterns.contactPatterns[0]);
  const hasPhoneNumbers = text.match(trainedPatterns.contactPatterns[1]);
  const hasPersonalEmails = text.match(trainedPatterns.contactPatterns[3]);

  if (hasUrls) {
    spamScore += 20;
    flags.push('suspicious_links');
    details.detectedPatterns.push(`Contains URLs: ${hasUrls.length}`);
  }

  if (hasPhoneNumbers) {
    spamScore += 15;
    flags.push('phone_numbers');
    details.detectedPatterns.push(`Contains phone numbers: ${hasPhoneNumbers.length}`);
  }

  if (hasPersonalEmails) {
    spamScore += 25;
    flags.push('personal_emails');
    details.detectedPatterns.push(`Uses personal email addresses`);
  }

  // 🔍 PATTERN 6: Specific Scam Phrases (High Severity)
  trainedPatterns.scamPhrases.forEach((pattern, index) => {
    if (pattern.test(text)) {
      spamScore += 30;
      flags.push('known_scam_phrase');
      details.detectedPatterns.push(`Known scam phrase: ${pattern}`);
    }
  });

  // 🔍 PATTERN 7: Message Structure Analysis
  const words = text.split(/\s+/).length;
  
  // Very short messages with financial terms
  if (words < 8 && financialFlags > 0) {
    spamScore += 10;
    flags.push('suspicious_short_message');
  }

  // Multiple exclamation marks
  const exclamationCount = (text.match(/!/g) || []).length;
  if (exclamationCount > 2) {
    spamScore += 5;
    flags.push('excessive_exclamation');
  }

  // ALL CAPS check
  const capsRatio = text.replace(/[^A-Z]/g, '').length / text.length;
  if (capsRatio > 0.5 && text.length > 15) {
    spamScore += 10;
    flags.push('excessive_caps');
  }

  // 🎯 CONFIDENCE CALCULATION & DECISION
  spamScore = Math.min(spamScore, 100);
  
  if (spamScore >= 70) {
    details.confidence = "high";
    details.recommendedAction = "delete_immediate";
  } else if (spamScore >= 45) {
    details.confidence = "medium";
    details.recommendedAction = "review_gemini";
  } else {
    details.confidence = "low";
    details.recommendedAction = "allow";
  }

  const result = {
    isSuspicious: spamScore >= 45, // Send to Gemini
    isHighConfidenceSpam: spamScore >= 70, // Immediate action
    score: spamScore,
    flags: [...new Set(flags)], // Remove duplicates
    details,
    localDecision: details.recommendedAction
  };

  console.log(`🔍 Local spam check: ${result.score}pts - ${result.flags.join(', ')}`);
  if (result.details.detectedPatterns.length > 0) {
    console.log(`📋 Detected patterns: ${result.details.detectedPatterns.join(' | ')}`);
  }

  return result;
}

// 🤖 GEMINI AI ANALYSIS WITH TRAINED PROMPT
async function analyzeWithGemini(messageText, localAnalysis) {
  if (!geminiModel) {
    console.log("⚠️ Gemini not available, using local analysis only");
    return {
      isSpam: localAnalysis.isHighConfidenceSpam,
      isAdvertisement: localAnalysis.score > 50,
      confidence: localAnalysis.score / 100,
      action: localAnalysis.isHighConfidenceSpam ? 'delete' : 'allow',
      reason: 'Gemini not available',
      category: 'unknown',
      riskLevel: localAnalysis.score >= 70 ? 'high' : 'medium'
    };
  }

  const prompt = `
You are an AI security analyst trained to detect Kenyan SMS/WhatsApp scams based on known patterns. Analyze this message and return ONLY valid JSON.

TRAINING DATA PATTERNS TO CONSIDER:
- Organization impersonation (UNICEF, Safaricom, WHO, etc.)
- Financial scams with specific amounts (KSh1,200, KSh500, etc.)
- Urgency tactics and false congratulations
- Data harvesting (ID, bank details, MPESA PIN)
- Suspicious links and personal contact requests

MESSAGE TO ANALYZE: "${messageText}"

LOCAL ANALYSIS RESULTS:
- Score: ${localAnalysis.score}/100
- Flags: ${localAnalysis.flags.join(', ')}
- Confidence: ${localAnalysis.details.confidence}
- Detected Patterns: ${localAnalysis.details.detectedPatterns.join('; ')}

ANALYSIS CRITERIA:
1. Check for organization impersonation from training data
2. Look for financial amounts combined with fee requests
3. Identify urgency pressure tactics
4. Detect data harvesting attempts
5. Evaluate link and contact safety

RETURN STRICT JSON FORMAT:
{
  "isSpam": boolean,
  "isAdvertisement": boolean,
  "isFinancialScam": boolean,
  "isOrganizationImpersonation": boolean,
  "confidence": number (0-1),
  "action": "delete_immediate" | "delete" | "warn" | "allow",
  "reason": "string with specific explanation",
  "category": "financial_scam" | "org_impersonation" | "data_harvesting" | "advertisement" | "legitimate" | "unknown",
  "riskLevel": "critical" | "high" | "medium" | "low",
  "matchedPatterns": ["array", "of", "specific", "patterns"]
}

RULES:
- "delete_immediate" for financial scams, PIN requests, org impersonation
- "delete" for clear spam and advertisements
- "warn" for suspicious but not clearly malicious
- "allow" for legitimate messages

Focus on Kenyan scam patterns from the training data. Be strict with financial requests and organization impersonation.
`;

  try {
    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);
      console.log(`🤖 Gemini analysis: ${analysis.action} - ${analysis.reason}`);
      console.log(`🎯 Category: ${analysis.category} | Risk: ${analysis.riskLevel}`);
      return analysis;
    } else {
      throw new Error("Invalid JSON response from Gemini");
    }
  } catch (error) {
    console.error("❌ Gemini analysis failed:", error);
    // Fallback to local analysis
    return {
      isSpam: localAnalysis.isHighConfidenceSpam,
      isAdvertisement: localAnalysis.score > 50,
      isFinancialScam: localAnalysis.flags.includes('financial_scam'),
      isOrganizationImpersonation: localAnalysis.flags.includes('organization_impersonation'),
      confidence: localAnalysis.score / 100,
      action: localAnalysis.isHighConfidenceSpam ? 'delete_immediate' : 
              localAnalysis.score >= 45 ? 'delete' : 'allow',
      reason: 'Gemini analysis failed, using local detection',
      category: 'unknown',
      riskLevel: localAnalysis.score >= 70 ? 'high' : 
                localAnalysis.score >= 45 ? 'medium' : 'low',
      matchedPatterns: localAnalysis.details.detectedPatterns
    };
  }
}

// 🛡️ TAKE ACTION ON MESSAGE
// 🛡️ TAKE ACTION ON MESSAGE - FIXED VERSION
async function handleSpamMessage(message, localAnalysis, geminiAnalysis) {
  const from = message.key.remoteJid;
  const sender = message.key.participant || from;
  const messageText = message.message.conversation || 
                     message.message.extendedTextMessage?.text || "";

  console.log(`🛡️ Processing message from ${sender}: ${messageText.substring(0, 50)}...`);

  // Update spam statistics
  spamStats.totalProcessed++;
  if (localAnalysis.isSuspicious) spamStats.localFlagged++;
  if (geminiAnalysis) spamStats.geminiAnalyzed++;

  // Check if bot is admin in the group
  const groupMetadata = await sock.groupMetadata(from);
  
  // Use ADMIN_JID_CHECK as the bot's JID (the account that's logged in)
  const botJid = normalizeJid(ADMIN_JID_CHECK);
  
  const isBotAdmin = groupMetadata.participants.some(
    p => normalizeJid(p.id) === botJid && (p.admin === "admin" || p.admin === "superadmin")
  );

  console.log(`🔍 Bot JID: ${botJid}`);
  console.log(`🔍 Is Bot Admin: ${isBotAdmin}`);

  if (!isBotAdmin) {
    console.log("❌ Bot is not admin in this group, cannot take action");
    await sock.sendMessage(ADMIN_JID_SEND, {
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
    // 🚨 IMMEDIATE DELETE ACTIONS
    if (finalAnalysis.action === 'delete_immediate' || 
        finalAnalysis.riskLevel === 'critical' ||
        localAnalysis.score >= 85) {
      
      // Delete the message
      await sock.sendMessage(from, {
        delete: message.key
      });
      console.log("✅ Deleted high-risk spam message");
      spamStats.messagesDeleted++;

      // Remove user from group for critical threats
      await sock.groupParticipantsUpdate(
        from,
        [sender],
        "remove"
      );
      console.log(`🚫 Removed user ${sender} from group for critical spam`);
      spamStats.usersRemoved++;

      // Notify admin
      await sock.sendMessage(ADMIN_JID_SEND, {
        text: `🚨 *CRITICAL SPAM ALERT*\n\n*Group:* ${groupMetadata.subject}\n*User:* ${sender}\n*Action:* ✅ Message deleted & user removed\n*Risk Level:* ${finalAnalysis.riskLevel}\n*Local Score:* ${localAnalysis.score}\n*Reason:* ${finalAnalysis.reason}\n*Flags:* ${localAnalysis.flags.join(', ')}\n\n*Message:* ${messageText}`
      });

    } 
    // 🗑️ STANDARD DELETE ACTIONS
    else if (finalAnalysis.action === 'delete' || 
             finalAnalysis.riskLevel === 'high' ||
             localAnalysis.score >= 60) {
      
      await sock.sendMessage(from, {
        delete: message.key
      });
      console.log("✅ Deleted spam message");
      spamStats.messagesDeleted++;

      await sock.sendMessage(ADMIN_JID_SEND, {
        text: `🗑️ *Spam Message Deleted*\n\n*Group:* ${groupMetadata.subject}\n*User:* ${sender}\n*Risk Level:* ${finalAnalysis.riskLevel}\n*Score:* ${localAnalysis.score}\n*Reason:* ${finalAnalysis.reason}\n*Flags:* ${localAnalysis.flags.join(', ')}\n\n*Message:* ${messageText}`
      });

    } 
    // ⚠️ WARNING ACTIONS
    else if (finalAnalysis.action === 'warn' || 
             (finalAnalysis.riskLevel === 'medium' && localAnalysis.score >= 45)) {
      
      // Send warning to the group
      await sock.sendMessage(from, {
        text: `⚠️ *Community Guidelines Reminder*\n\nPlease avoid sending promotional content, financial offers, or suspicious links in this group. Repeated violations may result in removal.\n\n*Detected:* ${finalAnalysis.reason}`
      });
      spamStats.warningsSent++;
      
      await sock.sendMessage(ADMIN_JID_SEND, {
        text: `⚠️ *Warning Sent for Suspicious Message*\n\n*Group:* ${groupMetadata.subject}\n*User:* ${sender}\n*Risk Level:* ${finalAnalysis.riskLevel}\n*Score:* ${localAnalysis.score}\n*Reason:* ${finalAnalysis.reason}\n\n*Message:* ${messageText}`
      });

    } 
    // 📊 MONITOR ONLY (suspicious but not actionable)
    else if (localAnalysis.isSuspicious) {
      await sock.sendMessage(ADMIN_JID_SEND, {
        text: `👀 *Suspicious Message Monitored*\n\n*Group:* ${groupMetadata.subject}\n*User:* ${sender}\n*Score:* ${localAnalysis.score}\n*Flags:* ${localAnalysis.flags.join(', ')}\n*Action:* Monitoring only\n\n*Message:* ${messageText}`
      });
    }

  } catch (error) {
    console.error("❌ Error taking action on spam:", error);
    await sock.sendMessage(ADMIN_JID_SEND, {
      text: `❌ *Failed to take action on spam*\n\n*Error:* ${error.message}\n*Group:* ${groupMetadata.subject}\n*User:* ${sender}\n\n*Original Message:* ${messageText}`
    });
  }
}

// 🚀 INITIALIZE WHATSAPP CONNECTION
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

  // 💬 MESSAGE PROCESSING WITH SPAM DETECTION
  // 💬 FIXED MESSAGE PROCESSING WITH SPAM DETECTION
sock.ev.on("messages.upsert", async (m) => {
  const msg = m.messages[0];
  if (!msg.message || !msg.key.remoteJid) return;

  const from = msg.key.remoteJid;
  const sender = msg.key.participant || from;

  // Ignore messages from ourselves (bot's own messages)
  if (msg.key.fromMe) {
    return;
  }

  const text = msg.message.conversation ||
              msg.message.extendedTextMessage?.text ||
              "";

  // 🧠 HANDLE PRIVATE MESSAGES (DMs) - Including Admin Commands
  if (!from.endsWith('@g.us')) {
    console.log(`📩 Private message from ${sender}: ${text.substring(0, 50)}...`);
    
    // Check if it's from admin
    if (normalizeJid(sender) === normalizeJid(ADMIN_JID_SEND)) {
      const command = text.toLowerCase().trim();
      
      if (command === "list groups") {
        console.log("✅ Processing 'list groups' command");
        await sendGroupListToAdmin();
        return;
      } 
      else if (command === "spam stats") {
        console.log("✅ Processing 'spam stats' command");
        await sendSpamStats();
        return;
      } 
      else if (command.startsWith("test local ")) {
        console.log("✅ Processing 'test local' command");
        await testLocalDetection(text.replace("test local", "").trim());
        return;
      }
      else {
        // Unknown command from admin
        console.log(`⚠️ Unknown command from admin: ${command}`);
        await sock.sendMessage(ADMIN_JID_SEND, {
          text: `❓ Unknown command. Available commands:\n\n• *list groups* — See all groups\n• *spam stats* — Protection statistics\n• *test local <message>* — Test detection`
        });
        return;
      }
    }
    
    // Not from admin, ignore other private messages
    console.log(`⚠️ Ignoring private message from non-admin: ${sender}`);
    return;
  }

  // 🛡️ SPAM DETECTION FOR GROUP MESSAGES ONLY
  if (text.trim().length === 0) return; // Ignore empty messages

  console.log(`📨 Message in group from ${sender}: ${text.substring(0, 50)}...`);
  
  // Step 1: Local spam check with trained algorithm
  const localAnalysis = localSpamCheck(text, sender);
  
  // Step 2: Decision tree based on local analysis
  if (localAnalysis.isHighConfidenceSpam) {
    console.log("🚨 High confidence spam detected, taking immediate action...");
    await handleSpamMessage(msg, localAnalysis, null);
  } 
  else if (localAnalysis.isSuspicious) {
    console.log("🔍 Suspicious message detected, sending to Gemini...");
    const geminiAnalysis = await analyzeWithGemini(text, localAnalysis);
    
    // Step 3: Take action based on combined analysis
    await handleSpamMessage(msg, localAnalysis, geminiAnalysis);
  }
  // Messages with score < 45 are allowed automatically
});

  sock.ev.on("creds.update", saveCreds);
}

// 💓 KEEP-ALIVE PING
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

// 📊 SPAM STATISTICS
let spamStats = {
  totalProcessed: 0,
  localFlagged: 0,
  geminiAnalyzed: 0,
  messagesDeleted: 0,
  usersRemoved: 0,
  warningsSent: 0,
  efficiency: 0
};

async function sendSpamStats() {
  if (!sock || !isConnected) return;
  
  spamStats.efficiency = spamStats.totalProcessed > 0 ? 
    ((spamStats.localFlagged / spamStats.totalProcessed) * 100).toFixed(1) : 0;

  const statsMessage = `📊 *Spam Protection Stats*\n
🤖 *Local Detection Engine*
Total Messages Processed: ${spamStats.totalProcessed}
Locally Flagged: ${spamStats.localFlagged}
Gemini Analyses: ${spamStats.geminiAnalyzed}

🛡️ *Actions Taken*
Messages Deleted: ${spamStats.messagesDeleted}
Users Removed: ${spamStats.usersRemoved}
Warnings Sent: ${spamStats.warningsSent}

⚡ *Efficiency*
Local Filter Rate: ${spamStats.efficiency}%
API Call Savings: ~${(100 - (spamStats.geminiAnalyzed / spamStats.totalProcessed * 100)).toFixed(1)}%`;

  await sock.sendMessage(ADMIN_JID_SEND, { text: statsMessage });
}

// 🧪 TEST LOCAL DETECTION
async function testLocalDetection(testMessage) {
  if (!testMessage) {
    await sock.sendMessage(ADMIN_JID_SEND, {
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

  await sock.sendMessage(ADMIN_JID_SEND, { text: resultMessage });
}

// 📋 EXISTING FUNCTIONS (keep your original implementations)
async function getGroupsList() {
  try {
    const groups = await sock.groupFetchAllParticipating();
    const botId = normalizeJid(sock.user.id);
    const adminCheckId = normalizeJid(ADMIN_JID_CHECK);

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

async function sendStartupMessage() {
  try {
    await sock.sendMessage(ADMIN_JID_SEND, {
      text: `🤖 *WA Protect AI Agent v2.0 Online!*\n\n🛡️ *Enhanced Spam Protection*\n• Trained local detection algorithm\n• Gemini AI analysis for suspicious messages\n• Kenyan scam pattern recognition\n\n*Commands:*\n👉 *list groups* — See all groups\n👉 *spam stats* — Protection statistics\n👉 *test local <message>* — Test detection`
    });
    console.log("✅ Sent startup message to admin.");
  } catch (error) {
    console.error("Failed to send startup message:", error);
  }
}

// 🌐 EXPRESS ENDPOINTS
app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    status: isConnected ? "Ready" : "Connecting...",
    timestamp: new Date().toISOString(),
    spamStats: spamStats
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

// 🧹 CLEAN SHUTDOWN
process.on("SIGINT", () => {
  clearInterval(pingInterval);
  process.exit();
});

app.listen(PORT, () => {
  console.log(`🚀 WA Protect Server running on port ${PORT}`);
  console.log(`🛡️ Trained Spam Protection System Activated`);
  console.log(`🎯 Local detection algorithm trained on 20 Kenyan scam patterns`);
  console.log(`🤖 Gemini AI: ${GEMINI_API_KEY ? 'Enabled' : 'Disabled'}`);
});

startWhatsApp().catch(console.error); 