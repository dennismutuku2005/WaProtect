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

// ✅ INITIALIZE GEMINI AI
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ 
    model: "gemini-2.0-flash-exp",
    generationConfig: {
      temperature: 0.1,
      topK: 1,
      topP: 1,
      maxOutputTokens: 1024,
    }
  });
  console.log("✅ Gemini initialized successfully");
} else {
  console.log("⚠️ GEMINI_API_KEY not found - running with local detection only");
}

// ✅ Normalize JIDs
function normalizeJid(jid) {
  if (!jid) return "";
  return jid.split(":")[0].replace("@s.whatsapp.net", "").replace("@lid", "");
}

// 🎯 LOCAL SPAM DETECTION ALGORITHM
function localSpamCheck(messageText, senderInfo) {
  const text = messageText.toLowerCase().trim();
  
  // 🎯 LEGITIMACY INDICATORS (reduce false positives)
  const legitimacyIndicators = {
    trustedDomains: [
      /forms\.gle|forms\.google\.com/i,
      /bit\.ly|tinyurl\.com/i,
      /zoom\.us|meet\.google\.com/i,
      /\.edu|\.ac\.ke/i
    ],
    campusLanguage: [
      /trade fair|exhibition|campus|university|college|student/i,
      /agm|annual general meeting/i,
      /biashara|hustler|entrepreneurship/i
    ],
    humorMarkers: [
      /plc|limited|international|empire/i,
      /😂|😁|🤣|😅/g,
      /vibes|laughter|exposure/i
    ]
  };

  const trainedPatterns = {
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
    
    financialScams: [
      /\b(50,000|50000|5,000|5000|1,200|1200|500|300|250|800|1,500|1500|450|600|400|2,000|2000|10,000|10000)\b/,
      /\b(ksh|kes|shilling|money|cash|grant|fund|bursary|scholarship|award|assistance|donation|relief)\b/i,
      /\b(fee|processing fee|activation fee|admin fee|verification fee|documentation fee|clearing fee|logistics fee|delivery fee|placement fee|registration fee)\b/i,
      /\b(pay|send|transfer|deposit|mobile money|m-pesa|mpesa)\b/i
    ],
    
    urgencyTactics: [
      /urgent|hurry|limited|now|immediate|quick|fast|don't miss|last chance|only few/i,
      /congratulations|selected|pre-approved|eligible|qualify|winner|chosen/i
    ],
    
    dataHarvesting: [
      /\b(id|identification|student id|bank details|account number|mobile number|phone number|pin|password|address)\b/i,
      /\b(verify|confirm|validation|authentication|register|sign up|apply|submit)\b/i,
      /\b(form|application|document|upload|provide|enter|fill)\b/i
    ],
    
    contactPatterns: [
      /https?:\/\/[^\s]+|www\.[^\s]+|\.[a-z]{2,}\/[^\s]*/gi,
      /\+?[\d\s\-\(\)]{8,}|\d{8,}/g,
      /@[a-z0-9]+\.[a-z]{2,}/gi,
      /gmail\.com|yahoo\.com|hotmail\.com/i
    ],
    
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

  // 🎯 CHECK FOR LEGITIMACY INDICATORS FIRST
  let legitimacyScore = 0;
  
  legitimacyIndicators.trustedDomains.forEach(pattern => {
    if (pattern.test(text)) {
      legitimacyScore += 15;
      details.detectedPatterns.push(`Trusted domain detected`);
    }
  });

  legitimacyIndicators.campusLanguage.forEach(pattern => {
    if (pattern.test(text)) {
      legitimacyScore += 10;
      details.detectedPatterns.push(`Campus event language detected`);
    }
  });

  const laughEmojis = (text.match(/😂|😁|🤣|😅/g) || []).length;
  if (laughEmojis >= 3) {
    legitimacyScore += 20;
    details.detectedPatterns.push(`High humor content (${laughEmojis} laugh emojis)`);
  }

  legitimacyIndicators.humorMarkers.forEach(pattern => {
    if (pattern.test(text)) {
      legitimacyScore += 5;
    }
  });

  const legitimacyBonus = legitimacyScore > 30 ? 30 : legitimacyScore;
  if (legitimacyBonus > 0) {
    console.log(`✅ Legitimacy bonus: ${legitimacyBonus} points (reduces spam score)`);
  }

  // Pattern detection
  trainedPatterns.spoofedOrgs.forEach((pattern) => {
    if (pattern.test(text)) {
      spamScore += 35;
      flags.push('organization_impersonation');
      details.detectedPatterns.push(`Spoofed organization`);
    }
  });

  let financialFlags = 0;
  trainedPatterns.financialScams.forEach((pattern) => {
    if (pattern.test(text)) {
      financialFlags++;
      spamScore += 20;
    }
  });
  if (financialFlags >= 2) {
    flags.push('financial_scam');
    details.detectedPatterns.push(`Financial scam indicators (${financialFlags} patterns)`);
  }

  for (let i = 0; i < trainedPatterns.urgencyTactics.length; i++) {
    const pattern = trainedPatterns.urgencyTactics[i];
    if (pattern.test(text)) {
      spamScore += 15;
      flags.push('urgency_pressure');
      details.detectedPatterns.push(`Urgency tactic detected`);
      break;
    }
  }

  let dataFlags = 0;
  trainedPatterns.dataHarvesting.forEach((pattern) => {
    if (pattern.test(text)) {
      dataFlags++;
      spamScore += 25;
    }
  });
  if (dataFlags >= 2) {
    flags.push('data_harvesting');
    details.detectedPatterns.push(`Data harvesting attempt (${dataFlags} patterns)`);
  }

  const hasUrls = text.match(trainedPatterns.contactPatterns[0]);
  const hasPhoneNumbers = text.match(trainedPatterns.contactPatterns[1]);
  const hasPersonalEmails = text.match(trainedPatterns.contactPatterns[3]);

  if (hasUrls) {
    const isTrustedUrl = legitimacyIndicators.trustedDomains.some(pattern => 
      hasUrls.some(url => pattern.test(url))
    );
    
    if (!isTrustedUrl) {
      spamScore += 20;
      flags.push('suspicious_links');
      details.detectedPatterns.push(`Contains URLs: ${hasUrls.length}`);
    } else {
      console.log(`✅ Trusted URL detected, not penalized`);
    }
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

  trainedPatterns.scamPhrases.forEach((pattern) => {
    if (pattern.test(text)) {
      spamScore += 30;
      flags.push('known_scam_phrase');
      details.detectedPatterns.push(`Known scam phrase detected`);
    }
  });

  const words = text.split(/\s+/).length;
  
  if (words < 8 && financialFlags > 0) {
    spamScore += 10;
    flags.push('suspicious_short_message');
  }

  const exclamationCount = (text.match(/!/g) || []).length;
  if (exclamationCount > 2) {
    spamScore += 5;
    flags.push('excessive_exclamation');
  }

  const capsRatio = text.replace(/[^A-Z]/g, '').length / text.length;
  if (capsRatio > 0.5 && text.length > 15) {
    spamScore += 10;
    flags.push('excessive_caps');
  }

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
    isSuspicious: spamScore >= 45,
    isHighConfidenceSpam: spamScore >= 70,
    score: spamScore,
    flags: [...new Set(flags)],
    details,
    localDecision: details.recommendedAction
  };

  console.log(`🔍 Local spam check: ${result.score}pts - ${result.flags.join(', ')}`);
  if (result.details.detectedPatterns.length > 0) {
    console.log(`📋 Detected patterns: ${result.details.detectedPatterns.join(' | ')}`);
  }

  return result;
}

// 🤖 GEMINI AI ANALYSIS
async function analyzeWithGemini(messageText, localAnalysis) {
  console.log("🔍 Gemini function called");
  
  if (!geminiModel) {
    console.log("❌ Gemini not initialized, using fallback");
    return getFallbackAnalysis(localAnalysis, "Gemini not initialized");
  }

  const cleanMessage = messageText.substring(0, 500);
  
  const prompt = `
CRITICAL: You MUST return ONLY valid JSON, no other text.

Analyze this Kenyan WhatsApp message for spam/scam patterns:

MESSAGE: "${cleanMessage}"

LOCAL ANALYSIS:
- Score: ${localAnalysis.score}/100
- Flags: ${localAnalysis.flags.join(', ')}
- Patterns: ${localAnalysis.details.detectedPatterns.join('; ')}

CONTEXT AWARENESS:
- Campus/school events with registration are usually LEGITIMATE
- Google Forms links (forms.gle) are TRUSTED
- Humor and satire (emojis, jokes) indicate LEGITIMATE content
- Messages asking people to PAY TO SELL at trade fairs are LEGITIMATE business events
- "ROI" jokes in context of campus hustles are SATIRICAL, not scam promises

RETURN THIS EXACT JSON FORMAT:
{
  "isSpam": false,
  "isAdvertisement": false,
  "isFinancialScam": false, 
  "isOrganizationImpersonation": false,
  "confidence": 0.85,
  "action": "allow",
  "reason": "Brief explanation",
  "category": "legitimate",
  "riskLevel": "low",
  "matchedPatterns": []
}

RULES:
- Return ONLY the JSON object, no markdown, no extra text
- Use double quotes for all strings
- "delete_immediate" ONLY for: actual money requests, PIN/password requests, fake organization impersonation with urgency
- "allow" for: campus events, trade fairs, legitimate registrations, humor/satire
- Consider CONTEXT - not all mentions of money are scams
- Focus on INTENT: Is this trying to STEAL money or legitimately asking for event registration?
`;

  try {
    console.log("🚀 Sending to Gemini...");
    
    const result = await geminiModel.generateContent(prompt);
    console.log("✅ Got result from generateContent");
    
    const response = await result.response;
    console.log("✅ Got response");
    
    const text = response.text().trim();
    console.log("📥 Raw response length:", text.length);
    
    if (!text || text.length === 0) {
      console.log("❌ Empty response from Gemini");
      return getFallbackAnalysis(localAnalysis, "Empty response from Gemini");
    }

    console.log("🤖 Raw Gemini response:", text);
    
    let jsonText = text;
    jsonText = jsonText.replace(/```json|```/g, '');
    
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);
      
      if (typeof analysis.isSpam === 'undefined') {
        throw new Error("Missing required field: isSpam");
      }
      
      console.log(`✅ Gemini analysis: ${analysis.action} - ${analysis.reason}`);
      return analysis;
    } else {
      console.log("❌ No JSON found in response");
      return getFallbackAnalysis(localAnalysis, "No JSON in Gemini response");
    }
  } catch (error) {
    console.error("❌ Gemini analysis failed:", error.message);
    console.error("Error stack:", error.stack);
    return getFallbackAnalysis(localAnalysis, error.message);
  }
}

// 🛡️ FALLBACK ANALYSIS
function getFallbackAnalysis(localAnalysis, reason = 'Gemini unavailable') {
  const score = localAnalysis.score;
  const isHighRisk = score >= 70;
  const isMediumRisk = score >= 45;
  
  let category = 'unknown';
  if (localAnalysis.flags.includes('financial_scam')) category = 'financial_scam';
  else if (localAnalysis.flags.includes('organization_impersonation')) category = 'org_impersonation';
  else if (localAnalysis.flags.includes('data_harvesting')) category = 'data_harvesting';
  else if (score >= 50) category = 'advertisement';
  else if (score < 45) category = 'legitimate';

  return {
    isSpam: isMediumRisk,
    isAdvertisement: score >= 50 && category !== 'financial_scam',
    isFinancialScam: localAnalysis.flags.includes('financial_scam'),
    isOrganizationImpersonation: localAnalysis.flags.includes('organization_impersonation'),
    confidence: Math.min(score / 100, 0.95),
    action: isHighRisk ? 'delete_immediate' : 
            isMediumRisk ? 'delete' : 'allow',
    reason: reason,
    category: category,
    riskLevel: isHighRisk ? 'high' : isMediumRisk ? 'medium' : 'low',
    matchedPatterns: localAnalysis.details.detectedPatterns.slice(0, 3)
  };
}

// 🛡️ HANDLE SPAM MESSAGE
async function handleSpamMessage(message, localAnalysis, geminiAnalysis) {
  const from = message.key.remoteJid;
  const sender = message.key.participant || from;
  const messageText = message.message.conversation || 
                     message.message.extendedTextMessage?.text || "";

  console.log(`🛡️ Processing message from ${sender}: ${messageText.substring(0, 50)}...`);

  const groupMetadata = await sock.groupMetadata(from);
  const botJid = normalizeJid(ADMIN_JID_CHECK);
  
  const isBotAdmin = groupMetadata.participants.some(
    p => normalizeJid(p.id) === botJid && (p.admin === "admin" || p.admin === "superadmin")
  );

  console.log(`🔍 Bot JID: ${botJid}`);
  console.log(`🔍 Is Bot Admin: ${isBotAdmin}`);

  if (!isBotAdmin) {
    console.log("❌ Bot is not admin in this group, cannot take action");
    await sock.sendMessage(ADMIN_JID_SEND, {
      text: `⚠️ *SPAM DETECTED* (Cannot Act)\n\n*Group:* ${groupMetadata.subject}\n*Bot Status:* ❌ Not Admin\n\n*Spam Score:* ${localAnalysis.score}\n*Flags:* ${localAnalysis.flags.join(', ')}\n\n*From:* ${sender}\n*Message:* ${messageText}`
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
      
      await sock.sendMessage(from, { delete: message.key });
      console.log("✅ Deleted high-risk spam message");

      await sock.groupParticipantsUpdate(from, [sender], "remove");
      console.log(`🚫 Removed user ${sender} from group`);

      await sock.sendMessage(ADMIN_JID_SEND, {
        text: `🚨 *CRITICAL SPAM ALERT*\n\n*Group:* ${groupMetadata.subject}\n*User:* ${sender}\n*Action:* ✅ Message deleted & user removed\n*Risk Level:* ${finalAnalysis.riskLevel}\n*Local Score:* ${localAnalysis.score}\n*Reason:* ${finalAnalysis.reason}\n*Flags:* ${localAnalysis.flags.join(', ')}\n\n*Message:* ${messageText}`
      });

    } 
    else if (finalAnalysis.action === 'delete' || 
             finalAnalysis.riskLevel === 'high' ||
             localAnalysis.score >= 60) {
      
      await sock.sendMessage(from, { delete: message.key });
      console.log("✅ Deleted spam message");

      await sock.sendMessage(ADMIN_JID_SEND, {
        text: `🗑️ *Spam Message Deleted*\n\n*Group:* ${groupMetadata.subject}\n*User:* ${sender}\n*Risk Level:* ${finalAnalysis.riskLevel}\n*Score:* ${localAnalysis.score}\n*Reason:* ${finalAnalysis.reason}\n*Flags:* ${localAnalysis.flags.join(', ')}\n\n*Message:* ${messageText}`
      });

    } 
    else if (finalAnalysis.action === 'warn' || 
             (finalAnalysis.riskLevel === 'medium' && localAnalysis.score >= 45)) {
      
      await sock.sendMessage(from, {
        text: `⚠️ *Community Guidelines Reminder*\n\nPlease avoid sending promotional content, financial offers, or suspicious links in this group. Repeated violations may result in removal.\n\n*Detected:* ${finalAnalysis.reason}`
      });
      
      await sock.sendMessage(ADMIN_JID_SEND, {
        text: `⚠️ *Warning Sent for Suspicious Message*\n\n*Group:* ${groupMetadata.subject}\n*User:* ${sender}\n*Risk Level:* ${finalAnalysis.riskLevel}\n*Score:* ${localAnalysis.score}\n*Reason:* ${finalAnalysis.reason}\n\n*Message:* ${messageText}`
      });

    } 
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

// 🚀 INITIALIZE WHATSAPP
async function startWhatsApp() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["WA Protect", "Chrome", "1.0"],
  });

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

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || !msg.key.remoteJid) return;

    const from = msg.key.remoteJid;
    const sender = msg.key.participant || from;

    if (msg.key.fromMe) return;

    const text = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                "";

    if (!from.endsWith('@g.us')) {
      console.log(`📩 Private message from ${sender}: ${text.substring(0, 50)}...`);
      
      if (normalizeJid(sender) === normalizeJid(ADMIN_JID_SEND)) {
        const command = text.toLowerCase().trim();
        
        if (command === "list groups") {
          await sendGroupListToAdmin();
          return;
        } 
        else if (command.startsWith("test local ")) {
          await testLocalDetection(text.replace("test local", "").trim());
          return;
        }
        else {
          await sock.sendMessage(ADMIN_JID_SEND, {
            text: `❓ Unknown command. Available commands:\n\n• *list groups* — See all groups\n• *test local <message>* — Test detection`
          });
          return;
        }
      }
      
      console.log(`⚠️ Ignoring private message from non-admin: ${sender}`);
      return;
    }

    if (text.trim().length === 0) return;

    console.log(`📨 Message in group from ${sender}: ${text.substring(0, 50)}...`);
    
    const localAnalysis = localSpamCheck(text, sender);
    
    if (localAnalysis.isHighConfidenceSpam) {
      console.log("🚨 High confidence spam detected, taking immediate action...");
      await handleSpamMessage(msg, localAnalysis, null);
    } 
    else if (localAnalysis.isSuspicious) {
      console.log("🔍 Suspicious message detected, sending to Gemini...");
      const geminiAnalysis = await analyzeWithGemini(text, localAnalysis);
      await handleSpamMessage(msg, localAnalysis, geminiAnalysis);
    }
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
      text: `🤖 *WA Protect AI Agent v2.0 Online!*\n\n🛡️ *Enhanced Spam Protection*\n• Trained local detection algorithm\n• Gemini AI analysis for suspicious messages\n• Kenyan scam pattern recognition\n\n*Commands:*\n👉 *list groups* — See all groups\n👉 *test local <message>* — Test detection`
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
    timestamp: new Date().toISOString()
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
  console.log(`🤖 Gemini AI: ${GEMINI_API_KEY ? 'Enabled ✅' : 'Disabled ⚠️'}`);
});

startWhatsApp().catch(console.error);