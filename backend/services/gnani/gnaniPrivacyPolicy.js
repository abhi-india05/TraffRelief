'use strict';
require('dotenv').config();
const { getGnaniConfig } = require('./gnaniConfig');

/**
 * Gnani AI Data Privacy & Compliance Enforcement.
 *
 * Enforces strict clinical and regulatory boundaries before any survivor audio
 * is transmitted to hosted Gnani Prisma STT or Timbre TTS endpoints.
 *
 * Rules:
 * 1. Real patient data is strictly blocked from external Gnani AI processing
 *    unless GNANI_ALLOW_REAL_DATA=true is explicitly configured.
 * 2. Unclassified or missing classification defaults to 'real' (fail-closed).
 * 3. Client/frontend parameters cannot override the server-side database classification.
 * 4. Logs must never contain raw audio bytes, transcripts, or survivor PII.
 */
function assertGnaniDataAccess(options = {}) {
  const {
    operation = 'gnani_api',
    dataClassification = 'real',
    victimId = null
  } = options;

  const config = getGnaniConfig();

  // Rule 1: Fail closed if integration is not explicitly enabled
  if (!config.enabled) {
    throw new Error(
      `GNANI_PRIVACY_POLICY: Gnani AI integration is disabled. Operation "${operation}" aborted.`
    );
  }

  // Rule 2: API Key must be configured
  if (!config.apiKey || config.apiKey.trim() === '') {
    throw new Error(
      `GNANI_PRIVACY_POLICY: GNANI_API_KEY is not configured for operation "${operation}".`
    );
  }

  // Rule 3: Fail closed on real patient data
  const normalizedClass = (dataClassification || 'real').toLowerCase().trim();
  if (normalizedClass !== 'synthetic' && !config.allowRealData) {
    throw new Error(
      `GNANI_PRIVACY_POLICY: Real patient data (classification: "${normalizedClass}") cannot be sent to external Gnani AI services without explicit authorization (GNANI_ALLOW_REAL_DATA=true).`
    );
  }

  return true;
}

module.exports = {
  assertGnaniDataAccess
};
