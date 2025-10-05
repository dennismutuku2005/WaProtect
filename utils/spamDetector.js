const { normalizeJid } = require('./jidNormalizer');

function localSpamCheck(messageText, senderInfo) {
  const text = messageText.toLowerCase().trim();
  
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

  // 🔍 PATTERN 1: Organization Impersonation (High Severity)
  trainedPatterns.spoofedOrgs.forEach((pattern) => {
    if (pattern.test(text)) {
      spamScore += 35;
      flags.push('organization_impersonation');
      details.detectedPatterns.push(`Spoofed organization detected: ${pattern}`);
    }
  });

  // 🔍 PATTERN 2: Financial Scam Indicators (High Severity)
  let financialFlags = 0;
  trainedPatterns.financialScams.forEach((pattern) => {
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
  let urgencyFlags = 0;
  trainedPatterns.urgencyTactics.forEach((pattern) => {
    if (pattern.test(text)) {
      urgencyFlags++;
      spamScore += 15;
    }
  });
  if (urgencyFlags > 0) {
    flags.push('urgency_pressure');
    details.detectedPatterns.push(`Urgency tactics detected (${urgencyFlags} patterns)`);
  }

  // 🔍 PATTERN 4: Data Harvesting (High Severity)
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

  // 🔍 PATTERN 5: Contact & Link Analysis (Medium Severity)
  const hasUrls = text.match(trainedPatterns.contactPatterns[0]);
  const hasPhoneNumbers = text.match(trainedPatterns.contactPatterns[1]);
  const hasEmails = text.match(trainedPatterns.contactPatterns[2]);
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

  if (hasEmails) {
    spamScore += 10;
    flags.push('email_addresses');
    details.detectedPatterns.push(`Contains email addresses`);
  }

  if (hasPersonalEmails) {
    spamScore += 25;
    flags.push('personal_emails');
    details.detectedPatterns.push(`Uses personal email addresses`);
  }

  // 🔍 PATTERN 6: Specific Scam Phrases (High Severity)
  trainedPatterns.scamPhrases.forEach((pattern) => {
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
    details.detectedPatterns.push('Short message with financial terms');
  }

  // Multiple exclamation marks
  const exclamationCount = (text.match(/!/g) || []).length;
  if (exclamationCount > 2) {
    spamScore += 5;
    flags.push('excessive_exclamation');
    details.detectedPatterns.push(`Excessive exclamation marks: ${exclamationCount}`);
  }

  // Multiple question marks (pressure tactic)
  const questionCount = (text.match(/\?/g) || []).length;
  if (questionCount > 3) {
    spamScore += 5;
    flags.push('excessive_questions');
    details.detectedPatterns.push(`Excessive questioning: ${questionCount}`);
  }

  // ALL CAPS check
  const capsRatio = text.replace(/[^A-Z]/g, '').length / text.length;
  if (capsRatio > 0.5 && text.length > 15) {
    spamScore += 10;
    flags.push('excessive_caps');
    details.detectedPatterns.push(`Excessive capitalization: ${(capsRatio * 100).toFixed(1)}%`);
  }

  // 🔍 PATTERN 8: Keyword Density Analysis
  const scamKeywords = [
    'free', 'win', 'won', 'prize', 'lottery', 'claim', 'bonus', 
    'reward', 'offer', 'limited', 'exclusive', 'guaranteed'
  ];
  
  let keywordMatches = 0;
  scamKeywords.forEach(keyword => {
    const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
    if (regex.test(text)) {
      keywordMatches++;
    }
  });
  
  if (keywordMatches >= 3) {
    spamScore += 15;
    flags.push('high_scam_keyword_density');
    details.detectedPatterns.push(`High scam keyword density: ${keywordMatches} keywords`);
  }

  // 🔍 PATTERN 9: Repeated Patterns
  const repeatedPhrases = text.match(/(\b\w+\b)(?=.*\b\1\b)/gi);
  if (repeatedPhrases && repeatedPhrases.length > 2) {
    spamScore += 5;
    flags.push('repeated_phrases');
    details.detectedPatterns.push(`Repeated phrases detected: ${repeatedPhrases.slice(0, 3).join(', ')}`);
  }

  // 🔍 PATTERN 10: Time-sensitive Language
  const timeSensitivePatterns = [
    /today only/i,
    /within.*hours/i,
    /before.*tomorrow/i,
    /expires.*soon/i,
    /last.*day/i,
    /final.*call/i
  ];
  
  timeSensitivePatterns.forEach(pattern => {
    if (pattern.test(text)) {
      spamScore += 10;
      flags.push('time_sensitive_pressure');
      details.detectedPatterns.push(`Time-sensitive pressure: ${pattern}`);
      return;
    }
  });

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
    isSuspicious: spamScore >= 45,
    isHighConfidenceSpam: spamScore >= 70,
    score: spamScore,
    flags: [...new Set(flags)], // Remove duplicates
    details,
    localDecision: details.recommendedAction,
    messageLength: text.length,
    wordCount: words
  };

  console.log(`🔍 Local spam check: ${result.score}pts - ${result.flags.join(', ')}`);
  if (result.details.detectedPatterns.length > 0) {
    console.log(`📋 Detected patterns: ${result.details.detectedPatterns.slice(0, 5).join(' | ')}${result.details.detectedPatterns.length > 5 ? '...' : ''}`);
  }

  return result;
}

// Additional helper function for testing
function testSpamDetection(message) {
  const result = localSpamCheck(message, 'test');
  console.log('\n🧪 SPAM DETECTION TEST RESULT:');
  console.log(`📝 Message: "${message}"`);
  console.log(`🎯 Score: ${result.score}/100`);
  console.log(`🛡️ Confidence: ${result.details.confidence}`);
  console.log(`🚩 Flags: ${result.flags.join(', ')}`);
  console.log(`⚡ Decision: ${result.localDecision}`);
  console.log(`📊 Patterns: ${result.details.detectedPatterns.length} detected`);
  return result;
}

module.exports = {
  localSpamCheck,
  testSpamDetection
};