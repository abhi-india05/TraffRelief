'use strict';
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { convertRawToJSON_usingJSON5 } = require('../../utils/utils.js');
const { assertGeminiDataAccess, sanitizeClinicalObject } = require('../geminiPrivacyPolicy');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_EVALUATION_MODEL || 'gemini-2.5-flash-lite';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const model = genAI ? genAI.getGenerativeModel({ model: GEMINI_MODEL }) : null;

const SYSTEM_INSTRUCTION = `You are an expert clinical-assessment assistant for human-trafficking rehabilitation cases.
Your task is to conduct a longitudinal evaluation of a patient's current rehabilitation audit against their retrieved historical context and produce a single machine-readable JSON object following the result schema described below.

CRITICAL CLINICAL & EVALUATION GUIDELINES:
1. Output ONLY valid JSON — nothing else (no explanatory text, no markdown code blocks, no trailing commas).
2. Evaluate each of the three rehabilitation domains INDEPENDENTLY:
   - medical_physical (physical health, injuries, medications, nutrition, sleep)
   - trauma_indicators (psychological trauma, anxiety, depression, dissociation, self-harm, emotional regulation, trust)
   - progress_tracking (rehabilitation activities, therapy attendance, compliance, skills, milestones, setbacks)
3. For each domain, determine:
   - status: "improving" | "no_change" | "declining" | "insufficient_data".
     Use "insufficient_data" when history is absent or baseline is missing.
   - reasons: array of 2–5 concise clinical reasons (each 6–40 words) referencing specific documented changes.
   - evidence: array of 2–6 concise evidence strings (each 6–40 words) indicating directionality (e.g., "AUD-101: sleep disturbed -> AUD-102: normal sleep").
   - evidenceReferences: array of objects referencing exact audits from the context:
     [{"auditId": "AUD-###", "date": "YYYY-MM-DD", "field": "fieldName", "observation": "exact brief quote/summary", "sourceType": "structured|semantic|safety"}]
     CRITICAL: Only reference auditIds that are present in the provided context! Only reference observations that actually appear in those audits. Do NOT invent audit IDs or observations.
   - dataSufficiency: "sufficient" | "limited" | "insufficient".
4. Missing Data & Negation Rules:
   - An empty field or missing observation does NOT mean the condition has resolved or is normal.
   - Clearly distinguish between a documented negative finding ("no self-harm observed") and an unrecorded/missing field.
   - Consider documented rehabilitation interventions when evaluating trajectory. Do not claim an intervention caused improvement unless explicitly documented; report temporal association only.
   - Do not infer psychiatric or medical diagnoses.
5. Safety & Urgency:
   - urgent: true or false. Set true ONLY if ANY acute safety, medical, or severe psychological risk is currently present (e.g., active suicidal ideation, fresh self-harm, unaddressed severe injuries, acute psychosis, severe distress). Do NOT set urgent=true solely for historical, resolved, or denied symptoms.
   - requires_human_review: true or false. Set true if urgent is true, if severe setbacks exist, or if conflicting historical data is observed.
6. Recommendations & Discharge:
   - recommended_actions: array of 1–8 short actionable items (each 6–30 words) prioritizing immediate safety, medical care, therapy, and social support.
   - fit_for_discharge: boolean. Set true ONLY if sustained improvement is documented across all domains, no urgent concerns exist, and functional support is in place. If urgent=true, fit_for_discharge MUST be false.
   - next_audit_date: an ISO 8601 date string (YYYY-MM-DD). If immediate follow-up is needed use 3–7 days ahead; standard interval is 14–30 days.

REQUIRED OUTPUT JSON SCHEMA:
{
  "domain_evaluations": {
    "medical_physical": {
      "status": "improving | no_change | declining | insufficient_data",
      "reasons": ["string"],
      "evidence": ["string"],
      "evidenceReferences": [
        {
          "auditId": "string",
          "date": "YYYY-MM-DD",
          "field": "string",
          "observation": "string",
          "sourceType": "structured"
        }
      ],
      "dataSufficiency": "sufficient | limited | insufficient"
    },
    "trauma_indicators": {
      "status": "improving | no_change | declining | insufficient_data",
      "reasons": ["string"],
      "evidence": ["string"],
      "evidenceReferences": [],
      "dataSufficiency": "sufficient | limited | insufficient"
    },
    "progress_tracking": {
      "status": "improving | no_change | declining | insufficient_data",
      "reasons": ["string"],
      "evidence": ["string"],
      "evidenceReferences": [],
      "dataSufficiency": "sufficient | limited | insufficient"
    }
  },
  "urgent": false,
  "recommended_actions": ["string"],
  "fit_for_discharge": false,
  "requires_human_review": false,
  "next_audit_date": "YYYY-MM-DD",
  "retrievalMetadata": {
    "retrievalMode": "structured_only | hybrid",
    "evaluationVersion": "rag-v1"
  }
}`;

/**
 * Call Gemini to perform longitudinal evaluation on the assembled RAG context.
 *
 * @param {Object} assembledContext - complete context from contextAssembler
 * @param {Object} [options] - privacy and evaluation options
 * @param {string} [options.dataClassification] - 'real' | 'synthetic'
 * @param {string} [options.databaseName] - MongoDB database name
 * @returns {Promise<Object>} parsed raw evaluation object
 */
async function evaluateWithContext(assembledContext, options = {}) {
  // Enforce centralized privacy gate
  assertGeminiDataAccess({
    operation: 'audit_evaluation',
    dataClassification: options.dataClassification || assembledContext?.victimClassification || 'real',
    databaseName: options.databaseName || ''
  });

  if (!GEMINI_API_KEY || !genAI || !model) {
    throw new Error('Gemini API is not configured. GEMINI_API_KEY is missing or invalid.');
  }

  const rawPayload = {
    currentAssessment: assembledContext.currentAudit,
    immediatelyPrecedingAssessment: assembledContext.previousAudit || null,
    initialBaselineAssessment: assembledContext.baselineAudit || null,
    recentChronologicalHistory: assembledContext.recentChronologicalHistory || [],
    semanticallyRetrievedEvidence: assembledContext.domainEvidence || {},
    criticalHistoricalSafetyObservations: assembledContext.historicalSafetyIndicators || [],
    activeAndPastInterventions: assembledContext.rehabilitationInterventions || [],
    previousAIEvaluations: assembledContext.previousAIRecommendations || [],
    contextWarnings: assembledContext.contextWarnings || [],
    availableAuditIds: assembledContext.retrievalMetadata?.retrievedAuditIds || []
  };

  // Sanitize any free-text clinical data before assembling outbound prompt
  const promptPayload = sanitizeClinicalObject(rawPayload);

  const userPrompt = `Perform a longitudinal rehabilitation evaluation for this patient case.\n\nEVALUATION CONTEXT:\n${JSON.stringify(promptPayload, null, 2)}\n\nProduce ONLY the strict JSON object specified in your system instructions.`;

  const fullPrompt = `${SYSTEM_INSTRUCTION}\n\n${userPrompt}`;

  const response = await model.generateContent({
    contents: [
      {
        role: 'user',
        parts: [{ text: fullPrompt }]
      }
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2500,
      responseMimeType: 'application/json'
    }
  });

  const rawText = await response.response.text();
  const parsed = convertRawToJSON_usingJSON5(rawText);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Failed to parse Gemini evaluation output as valid JSON');
  }

  return parsed;
}

module.exports = { evaluateWithContext, SYSTEM_INSTRUCTION };
