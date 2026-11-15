'use strict';
require('dotenv').config();

/**
 * Centralized Gemini Data Privacy & API-Tier Policy Enforcement Service.
 *
 * All outbound calls to Google Gemini API (embeddings, evaluation, audio transcription,
 * and summarization) MUST go through this policy gate to prevent exposure of real
 * human trafficking survivor / victim data to Google's Free Tier training pipeline.
 */

// Common regex patterns for PII detection and redaction
const PII_PATTERNS = [
  // Email addresses
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[REDACTED_EMAIL]' },
  // Indian phone numbers (+91, 10 digits starting 6-9)
  { pattern: /(?:\+91[\-\s]?)?[6-9]\d{9}\b/g, replacement: '[REDACTED_PHONE]' },
  // International phone numbers with country code
  { pattern: /\b\+\d{1,3}[\s\-]?\(?\d{2,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{3,4}\b/g, replacement: '[REDACTED_PHONE]' },
  // Aadhaar numbers (12 digits with or without spaces)
  { pattern: /\b\d{4}\s\d{4}\s\d{4}\b/g, replacement: '[REDACTED_NATIONAL_ID]' },
  // Indian PIN codes (6 digits following common address labels)
  { pattern: /(?:PIN|Pin|Pincode|Zip|Postal)\s*(?:Code)?[:\-\s]+(\d{6})\b/gi, replacement: 'PIN: [REDACTED_PIN]' }
];

/**
 * Sanitize clinical and audit free-text to remove potential PII while preserving
 * clinical and psychological semantics necessary for longitudinal evaluation.
 *
 * @param {string} text - Raw input text
 * @returns {string} Sanitized text free of common PII identifiers
 */
function sanitizeClinicalText(text) {
  if (!text || typeof text !== 'string') return text || '';

  let sanitized = text;
  for (const { pattern, replacement } of PII_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized;
}

/**
 * Sanitize an object containing clinical fields recursively.
 *
 * @param {Object} obj
 * @returns {Object} Sanitized object copy
 */
function sanitizeClinicalObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeClinicalObject(item));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = sanitizeClinicalText(value);
    } else if (value && typeof value === 'object') {
      result[key] = sanitizeClinicalObject(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Assert that data access to Gemini API complies with organization privacy standards.
 *
 * Rules:
 * 1. GEMINI_API_KEY must be configured.
 * 2. Paid tier (GEMINI_API_TIER=paid) is permitted for both real and synthetic data,
 *    as commercial Google Workspace / Cloud terms guarantee data is not used for model training.
 * 3. Free tier (GEMINI_API_TIER=free or unset):
 *    - STRICTLY FORBIDDEN in production (NODE_ENV=production).
 *    - STRICTLY FORBIDDEN for real patient data (dataClassification !== 'synthetic').
 *    - STRICTLY FORBIDDEN if database name matches production patterns.
 *    - ONLY permitted if:
 *        a) NODE_ENV !== 'production'
 *        b) ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA === 'true'
 *        c) All involved patient records are explicitly classified as 'synthetic'.
 *
 * @param {Object} options
 * @param {string} options.operation - Description of operation (e.g. 'audit_evaluation', 'audit_embedding', 'audio_transcription')
 * @param {string} [options.dataClassification] - 'real' | 'synthetic' (defaults to 'real')
 * @param {Array<Object>} [options.sourceRecords] - Source records being processed
 * @param {string} [options.databaseName] - Current MongoDB database name
 * @throws {Error} if access is disallowed
 */
function assertGeminiDataAccess({
  operation = 'unspecified_operation',
  dataClassification = 'real',
  sourceRecords = [],
  databaseName = ''
} = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(`GEMINI_PRIVACY_POLICY: GEMINI_API_KEY is not configured for operation "${operation}".`);
  }

  const apiTier = (process.env.GEMINI_API_TIER || '').trim().toLowerCase();
  const nodeEnv = (process.env.NODE_ENV || 'development').trim().toLowerCase();
  const allowFreeSynthetic = process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA === 'true';

  // Determine effective classification across individual records if provided
  let effectiveClassification = (dataClassification || 'real').toLowerCase();
  if (Array.isArray(sourceRecords) && sourceRecords.length > 0) {
    for (const record of sourceRecords) {
      const recordClass = (record?.dataClassification || record?.victimId?.dataClassification || 'real').toLowerCase();
      if (recordClass !== 'synthetic') {
        effectiveClassification = 'real';
        break;
      }
    }
  }

  // Check 1: Paid Tier is compliant
  if (apiTier === 'paid') {
    return true;
  }

  // Check 2: Unconfigured tier
  if (!apiTier) {
    throw new Error(
      `GEMINI_PRIVACY_POLICY: GEMINI_API_TIER is not set. Set GEMINI_API_TIER=paid for commercial privacy terms, or GEMINI_API_TIER=free with ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA=true for synthetic testing.`
    );
  }

  // Check 3: Production environment MUST use paid tier
  if (nodeEnv === 'production') {
    throw new Error(
      `GEMINI_PRIVACY_POLICY: Production environment strictly requires GEMINI_API_TIER=paid. Real patient trauma data must never be processed under Free Tier terms.`
    );
  }

  // Check 4: Production database name guard
  const lowerDb = (databaseName || '').toLowerCase();
  if (lowerDb.includes('prod') || lowerDb.includes('live')) {
    throw new Error(
      `GEMINI_PRIVACY_POLICY: Production database (${databaseName}) detected. GEMINI_API_TIER=paid is required.`
    );
  }

  // Check 5: Real or unclassified patient data on Free Tier
  if (effectiveClassification !== 'synthetic') {
    throw new Error(
      `GEMINI_PRIVACY_POLICY: Real patient data (classification: "${effectiveClassification}") cannot be sent to Gemini Free Tier. Google's Free Tier terms permit training on input data. Upgrade to GEMINI_API_TIER=paid or use synthetic patient records for testing.`
    );
  }

  // Check 6: Synthetic data on Free Tier requires explicit opt-in
  if (!allowFreeSynthetic) {
    throw new Error(
      `GEMINI_PRIVACY_POLICY: Free Tier usage for synthetic data requires ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA=true in environment.`
    );
  }

  return true;
}

module.exports = {
  assertGeminiDataAccess,
  sanitizeClinicalText,
  sanitizeClinicalObject,
  PII_PATTERNS
};
