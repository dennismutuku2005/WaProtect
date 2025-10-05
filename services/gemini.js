const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GEMINI_API_KEY } = require('../config/constants');

let genAI;
let geminiModel;

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

module.exports = {
  analyzeWithGemini
};