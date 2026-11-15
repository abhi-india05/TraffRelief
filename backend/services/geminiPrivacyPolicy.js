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

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sanitize clinical and audit free-text to remove potential PII while preserving
 * clinical and psychological semantics necessary for longitudinal evaluation.
 *
 * @param {string} text - Raw input text
 * @param {Object} [options] - Optional context for targeted redaction (known names)
 * @param {string[]} [options.knownNames] - Known patient or staff names to redact
 * @returns {string} Sanitized text free of common PII identifiers
 */
function sanitizeClinicalText(text, options = {}) {
  if (!text || typeof text !== 'string') return text || '';

  let sanitized = text;

  // Redact known names if supplied
  const names = Array.isArray(options.knownNames) ? options.knownNames : [];
  if (options.patientName) names.push(options.patientName);
  if (options.staffName) names.push(options.staffName);

  for (const name of names) {
    if (name && typeof name === 'string' && name.trim().length > 2) {
      const reg = new RegExp(`\\b${escapeRegex(name.trim())}\\b`, 'gi');
      sanitized = sanitized.replace(reg, '[REDACTED_NAME]');
    }
  }

  // Redact generic PII patterns
  for (const { pattern, replacement } of PII_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized;
}

/**
 * Sanitize an object containing clinical fields recursively.
 *
 * @param {Object} obj
 * @param {Object} [options]
 * @returns {Object} Sanitized object copy
 */
function sanitizeClinicalObject(obj, options = {}) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeClinicalObject(item, options));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = sanitizeClinicalText(value, options);
    } else if (value && typeof value === 'object') {
      result[key] = sanitizeClinicalObject(value, options);
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
 * 2. GEMINI_API_TIER must be explicitly 'paid' or 'free'. Unknown values fail closed.
 * 3. Paid tier (GEMINI_API_TIER=paid) is permitted for both real and synthetic data,
 *    as commercial Google Workspace / Cloud terms guarantee data is not used for model training.
 * 4. Free tier (GEMINI_API_TIER=free):
 *    - STRICTLY FORBIDDEN in production (NODE_ENV=production).
 *    - STRICTLY FORBIDDEN for real patient data (dataClassification !== 'synthetic').
 *    - STRICTLY FORBIDDEN unless the connected database is explicitly allowlisted in GEMINI_FREE_TIER_ALLOWED_DATABASES.
 *    - ONLY permitted if:
 *        a) NODE_ENV !== 'production'
 *        b) ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA === 'true'
 *        c) Database name exactly matches an entry in GEMINI_FREE_TIER_ALLOWED_DATABASES
 *        d) Every contributing patient and record is explicitly classified as 'synthetic'.
 *
 * @param {Object} options
 * @param {string} options.operation - Description of operation (e.g. 'audit_evaluation', 'audit_embedding', 'audio_transcription')
 * @param {string} [options.dataClassification] - 'real' | 'synthetic' (defaults to 'real')
 * @param {Array<Object>} [options.sourceRecords] - Source records being processed
 * @param {string} [options.databaseName] - Current MongoDB database name
 * @param {string} [options.patientId] - Target patient ObjectId/string for cross-patient isolation check
 * @throws {Error} if access is disallowed
 */
function assertGeminiDataAccess({
  operation = 'unspecified_operation',
  dataClassification = 'real',
  sourceRecords = [],
  databaseName = '',
  patientId = null
} = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(`GEMINI_PRIVACY_POLICY: GEMINI_API_KEY is not configured for operation "${operation}".`);
  }

  const rawTier = (process.env.GEMINI_API_TIER || '').trim().toLowerCase();
  const nodeEnv = (process.env.NODE_ENV || 'development').trim().toLowerCase();
  const allowFreeSynthetic = process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA === 'true';

  // Rule: Reject unknown or unconfigured API tiers
  if (!rawTier) {
    throw new Error(
      `GEMINI_PRIVACY_POLICY: GEMINI_API_TIER is not configured. Set to "paid" for commercial privacy terms, or "free" with ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA=true for synthetic testing.`
    );
  }
  if (rawTier !== 'paid' && rawTier !== 'free') {
    throw new Error(
      `GEMINI_PRIVACY_POLICY: Invalid GEMINI_API_TIER "${rawTier}". Must be explicitly "paid" or "free".`
    );
  }

  // Rule: Paid tier check
  if (rawTier === 'paid') {
    return true;
  }

  // Below checks apply strictly to Free Tier:

  // Check 1: Production environment MUST use paid tier
  if (nodeEnv === 'production') {
    throw new Error(
      `GEMINI_PRIVACY_POLICY: Production environment strictly requires GEMINI_API_TIER=paid. Real patient trauma data must never be processed under Free Tier terms.`
    );
  }

  // Check 2: Check overall data classification - real patient data is NEVER permitted on Free Tier
  let effectiveClassification = (dataClassification || 'real').toLowerCase();
  if (effectiveClassification !== 'synthetic') {
    throw new Error(
      `GEMINI_PRIVACY_POLICY: Real patient data (classification: "${effectiveClassification}") cannot be sent to Gemini Free Tier. Google's Free Tier terms permit training on input data. Upgrade to GEMINI_API_TIER=paid or use synthetic patient records for testing.`
    );
  }

  // Check 3: Synthetic data on Free Tier requires explicit opt-in
  if (!allowFreeSynthetic) {
    throw new Error(
      `GEMINI_PRIVACY_POLICY: Free Tier usage for synthetic data requires ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA=true in environment.`
    );
  }

  // Check 4: Explicit synthetic database allowlist check
  // Read comma-separated allowlist, e.g. "traffrelief_synthetic,traffrelief_test"
  const allowedDbsRaw = process.env.GEMINI_FREE_TIER_ALLOWED_DATABASES || 'traffrelief_synthetic';
  const allowedDbs = allowedDbsRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  const currentDb = (databaseName || '').trim().toLowerCase();
  if (currentDb && (currentDb.includes('prod') || currentDb.includes('live'))) {
    throw new Error(
      `GEMINI_PRIVACY_POLICY: Production database "${databaseName}" detected. Real patient data must never be processed under Free Tier terms.`
    );
  }
  if (!currentDb || !allowedDbs.includes(currentDb)) {
    throw new Error(
      `GEMINI_PRIVACY_POLICY: Database "${databaseName || 'unknown'}" is not allowlisted for Free Tier access. Allowed synthetic databases: [${allowedDbs.join(', ')}].`
    );
  }

  // Check 5: Check every source record for classification and patient isolation
  if (Array.isArray(sourceRecords) && sourceRecords.length > 0) {
    for (const record of sourceRecords) {
      if (!record) continue;
      const recordClass = (record.dataClassification || record.victimId?.dataClassification || 'real').toLowerCase();
      if (recordClass !== 'synthetic') {
        throw new Error(
          `GEMINI_PRIVACY_POLICY: Contributing source record (id: ${record._id || record.auditId || 'unknown'}) is classified as "${recordClass}". All source records must be explicitly synthetic under Free Tier.`
        );
      }

      // Cross-patient verification if patientId is provided
      if (patientId) {
        const recordVictimId = record.victimId?._id?.toString() || record.victimId?.toString();
        if (recordVictimId && recordVictimId !== patientId.toString()) {
          throw new Error(
            `GEMINI_PRIVACY_POLICY: Cross-patient data leakage detected. Source record belongs to patient "${recordVictimId}", not target patient "${patientId}".`
          );
        }
      }
    }
  }

  return true;
}

module.exports = {
  assertGeminiDataAccess,
  sanitizeClinicalText,
  sanitizeClinicalObject,
  PII_PATTERNS
};
