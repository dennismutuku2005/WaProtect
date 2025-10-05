require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Test configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Initialize Gemini
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
  console.log("✅ Gemini initialized with model: gemini-2.5-flash");
} else {
  console.error("❌ GEMINI_API_KEY not found in environment variables");
  process.exit(1);
}

// Mock local analysis for testing
function createMockLocalAnalysis() {
  return {
    score: 60,
    flags: ['urgency_pressure', 'suspicious_links'],
    details: {
      detectedPatterns: [
        'Urgency tactic: /urgent|hurry|limited|now|immediate|quick|fast|don\'t miss|last chance|only few/i',
        'Contains URLs: 1'
      ]
    }
  };
}

// Mock fallback analysis
function getFallbackAnalysis(localAnalysis, reason) {
  return {
    isSpam: localAnalysis.score >= 45,
    isAdvertisement: localAnalysis.score > 50,
    isFinancialScam: false,
    isOrganizationImpersonation: false,
    confidence: localAnalysis.score / 100,
    action: localAnalysis.score >= 60 ? 'delete' : 'allow',
    reason: reason || 'Fallback analysis',
    category: 'unknown',
    riskLevel: 'medium',
    matchedPatterns: localAnalysis.details.detectedPatterns
  };
}

// 🧪 TEST FUNCTION - Your original function with enhanced logging
async function analyzeWithGemini(messageText, localAnalysis) {
  console.log("\n🔍 === TESTING GEMINI FUNCTION ===");
  console.log(`📨 Message: "${messageText.substring(0, 100)}..."`);
  console.log(`📊 Local score: ${localAnalysis.score}/100`);
  
  if (!geminiModel) {
    console.log("⚠️ Gemini not available, using local analysis only");
    return getFallbackAnalysis(localAnalysis);
  }

  const prompt = `
CRITICAL: You MUST return ONLY valid JSON, no other text.

Analyze this Kenyan WhatsApp message for spam/scam patterns:

MESSAGE: "${messageText}"

LOCAL ANALYSIS:
- Score: ${localAnalysis.score}/100
- Flags: ${localAnalysis.flags.join(', ')}
- Patterns: ${localAnalysis.details.detectedPatterns.join('; ')}

RETURN THIS EXACT JSON FORMAT:
{
  "isSpam": true/false,
  "isAdvertisement": true/false,
  "isFinancialScam": true/false, 
  "isOrganizationImpersonation": true/false,
  "confidence": 0.85,
  "action": "delete_immediate|delete|warn|allow",
  "reason": "Brief explanation",
  "category": "financial_scam|org_impersonation|data_harvesting|advertisement|legitimate|unknown",
  "riskLevel": "critical|high|medium|low",
  "matchedPatterns": ["pattern1", "pattern2"]
}

RULES:
- Return ONLY the JSON object, no markdown, no extra text
- Use double quotes for all strings
- "delete_immediate" for financial scams, PIN requests, org impersonation
- Focus on Kenyan scam patterns
`;

  console.log("📤 Prompt length:", prompt.length, "characters");

  try {
    console.log("🚀 Sending request to Gemini...");
    
    const result = await geminiModel.generateContent(prompt);
    console.log("✅ Received response from Gemini");
    
    const response = await result.response;
    console.log("✅ Processed response");
    
    const text = response.text().trim();
    
    console.log("📥 Raw Gemini response:");
    console.log("----------------------------------------");
    console.log(text);
    console.log("----------------------------------------");
    console.log("Response length:", text.length, "characters");
    console.log("Response type:", typeof text);
    
    // Check if response is empty
    if (!text || text.length === 0) {
      console.log("❌ EMPTY RESPONSE DETECTED!");
      console.log("🔍 Checking response object structure...");
      console.log("Full response object:", JSON.stringify(response, null, 2));
      return getFallbackAnalysis(localAnalysis, "Empty response from Gemini");
    }

    // IMPROVED JSON EXTRACTION
    let jsonText = text;
    
    // Remove any code block markers
    jsonText = jsonText.replace(/```json|```/g, '');
    console.log("🔄 After removing code blocks:", jsonText.substring(0, 200) + "...");
    
    // Find JSON object more flexibly
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      console.log("✅ JSON object found in response");
      const jsonString = jsonMatch[0];
      console.log("📋 Extracted JSON:", jsonString);
      
      try {
        const analysis = JSON.parse(jsonString);
        console.log("✅ JSON parsed successfully");
        
        // VALIDATE REQUIRED FIELDS
        if (typeof analysis.isSpam === 'undefined') {
          console.log("❌ Missing required field: isSpam");
          throw new Error("Missing required field: isSpam");
        }
        
        console.log(`🤖 Gemini analysis: ${analysis.action} - ${analysis.reason}`);
        return analysis;
      } catch (parseError) {
        console.error("❌ JSON parse error:", parseError.message);
        console.log("📋 Problematic JSON string:", jsonString);
        return getFallbackAnalysis(localAnalysis, "JSON parse error: " + parseError.message);
      }
    } else {
      console.log("❌ No JSON found in response");
      console.log("🔍 Response content analysis:");
      console.log("- Starts with:", text.substring(0, 50));
      console.log("- Ends with:", text.substring(text.length - 50));
      console.log("- Contains curly braces:", text.includes('{') && text.includes('}'));
      return getFallbackAnalysis(localAnalysis, "No JSON in Gemini response");
    }
  } catch (error) {
    console.error("❌ Gemini analysis failed with error:");
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);
    
    // Check for specific Gemini API errors
    if (error.message.includes('API key')) {
      console.error("🔑 API KEY ISSUE: Check your GEMINI_API_KEY");
    } else if (error.message.includes('quota')) {
      console.error("📊 QUOTA ISSUE: You may have exceeded your API quota");
    } else if (error.message.includes('permission')) {
      console.error("🔐 PERMISSION ISSUE: Check your API key permissions");
    }
    
    return getFallbackAnalysis(localAnalysis, error.message);
  }
}

// 🧪 TEST CASES
const testMessages = [
  "Dear Entrepreneurial Magnates of Chapati & Smokie, limited time offer! Get free KSh 5,000 grant from UNICEF. Hurry now: https://fake-unicef.com",
  "Congratulations! You won KSh 50,000 from Safaricom. Send your ID and M-PESA PIN to claim: 0712345678",
  "Hello, just checking how you're doing today.",
  "URGENT: Your account will be suspended. Verify now at www.safaricom-update.com with your details"
];

// 🚀 RUN TESTS
async function runTests() {
  console.log("🎯 Starting Gemini API Tests...");
  console.log("🔑 API Key present:", !!GEMINI_API_KEY);
  console.log("🤖 Model initialized:", !!geminiModel);
  
  for (let i = 0; i < testMessages.length; i++) {
    console.log(`\n🧪 TEST ${i + 1}/${testMessages.length}`);
    console.log("=" .repeat(50));
    
    const message = testMessages[i];
    const localAnalysis = createMockLocalAnalysis();
    
    const startTime = Date.now();
    const result = await analyzeWithGemini(message, localAnalysis);
    const endTime = Date.now();
    
    console.log(`⏱️  Response time: ${endTime - startTime}ms`);
    console.log("📊 Final result:", JSON.stringify(result, null, 2));
    
    // Wait 2 seconds between tests to avoid rate limiting
    if (i < testMessages.length - 1) {
      console.log("⏳ Waiting 2 seconds before next test...");
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  console.log("\n🎊 All tests completed!");
}

// 🚀 START THE TESTS
runTests().catch(console.error);