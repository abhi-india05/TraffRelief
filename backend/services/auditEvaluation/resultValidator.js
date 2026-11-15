'use strict';

const VALID_STATUSES = new Set(['improving', 'no_change', 'declining', 'insufficient_data']);
const VALID_SUFFICIENCY = new Set(['sufficient', 'limited', 'insufficient']);
const VALID_RETRIEVAL_MODES = new Set(['structured_only', 'hybrid']);
const REQUIRED_DOMAINS = ['medical_physical', 'trauma_indicators', 'progress_tracking'];

/**
 * Normalise text for fuzzy grounding comparison.
 */
function normalizeText(str) {
  if (!str || typeof str !== 'string') return '';
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Check whether an observation quotation or claim is grounded in source text.
 * Requires either a substring match or high keyword overlap.
 *
 * @param {string} observation - AI reported observation/quote
 * @param {string} sourceText - Actual audit text
 * @returns {boolean}
 */
function isObservationGrounded(observation, sourceText) {
  if (!observation || !sourceText) return false;
  const normObs = normalizeText(observation);
  const normSrc = normalizeText(sourceText);

  if (normSrc.includes(normObs)) return true;

  // Keyword token overlap check
  const obsTokens = normObs.split(' ').filter(t => t.length > 3);
  if (obsTokens.length === 0) return true;

  const matches = obsTokens.filter(t => normSrc.includes(t));
  const overlapRatio = matches.length / obsTokens.length;

  return overlapRatio >= 0.5; // At least 50% of salient clinical terms appear in source
}

/**
 * Build a lookup map of all audit records and evidence chunks in the assembled context.
 *
 * @param {Object} assembledContext
 * @returns {Map<string, Object>} auditId -> audit field data
 */
function buildContextAuditMap(assembledContext) {
  const auditMap = new Map();

  function registerAudit(a) {
    if (!a || !a.auditId) return;
    const existing = auditMap.get(a.auditId) || { fields: {}, fullText: '' };
    for (const [k, v] of Object.entries(a)) {
      if (typeof v === 'string') {
        existing.fields[k] = v;
        existing.fullText += ' ' + v;
      }
    }
    if (a.timestamp) existing.timestamp = a.timestamp;
    auditMap.set(a.auditId, existing);
  }

  registerAudit(assembledContext?.currentAudit);
  registerAudit(assembledContext?.previousAudit);
  registerAudit(assembledContext?.baselineAudit);

  (assembledContext?.recentChronologicalHistory || []).forEach(registerAudit);
  (assembledContext?.historicalSafetyIndicators || []).forEach(registerAudit);

  // Register semantic domain chunks
  const domainEvidence = assembledContext?.domainEvidence || {};
  for (const chunks of Object.values(domainEvidence)) {
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        if (!chunk || !chunk.auditId) continue;
        const existing = auditMap.get(chunk.auditId) || { fields: {}, fullText: '' };
        if (chunk.content) existing.fullText += ' ' + chunk.content;
        if (Array.isArray(chunk.sourceFields)) {
          chunk.sourceFields.forEach(f => {
            if (!existing.fields[f] && chunk.content) existing.fields[f] = chunk.content;
          });
        }
        auditMap.set(chunk.auditId, existing);
      }
    }
  }

  return auditMap;
}

/**
 * Validate AI-generated result before persisting to MongoDB.
 * Rejects invalid schemas, strips ungrounded or hallucinated evidence references,
 * and enforces deterministic safety overrides.
 *
 * @param {Object} parsed - raw parsed object from Gemini response
 * @param {Object} assembledContext - context used for generation
 * @param {Object} safetyEvaluation - from safetyEvaluator (overrides AI urgent flag)
 * @returns {{ valid: boolean, result?: Object, errors?: string[], warnings?: string[] }}
 */
function validateAndSanitize(parsed, assembledContext, safetyEvaluation = {}) {
  const errors = [];
  const warnings = [];

  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, errors: ['Evaluation result is null or not an object'] };
  }

  const de = parsed.domain_evaluations;
  if (!de || typeof de !== 'object') {
    return { valid: false, errors: ['Missing domain_evaluations in result'] };
  }

  const contextAuditMap = buildContextAuditMap(assembledContext);
  const isFirstAudit = assembledContext?.isFirstAudit === true;
  const totalHistorical = assembledContext?.totalHistoricalAudits || 0;

  const validatedDomains = {};

  for (const domain of REQUIRED_DOMAINS) {
    const d = de[domain];
    if (!d || typeof d !== 'object') {
      errors.push(`Missing or invalid domain evaluation for: ${domain}`);
      continue;
    }

    const status = d.status;
    if (!VALID_STATUSES.has(status)) {
      errors.push(`Invalid status "${status}" for domain ${domain}. Allowed: ${[...VALID_STATUSES].join(', ')}`);
    }

    if (!Array.isArray(d.reasons) || d.reasons.length === 0) {
      errors.push(`${domain}.reasons must be a non-empty array of strings`);
    }

    if (!Array.isArray(d.evidence)) {
      errors.push(`${domain}.evidence must be an array of strings`);
    }

    // Validate evidence references against context audit map
    const validatedRefs = [];
    if (Array.isArray(d.evidenceReferences)) {
      for (const ref of d.evidenceReferences) {
        if (!ref || typeof ref !== 'object' || !ref.auditId) {
          warnings.push(`Malformed evidenceReference in ${domain} (missing auditId)`);
          continue;
        }

        const auditIdStr = String(ref.auditId).trim();

        // 1. Check if auditId exists in context
        if (!contextAuditMap.has(auditIdStr)) {
          warnings.push(`Unverified evidenceReference auditId "${auditIdStr}" in ${domain} not found in retrieved context`);
          continue; // Strip hallucinated reference
        }

        const sourceAuditData = contextAuditMap.get(auditIdStr);

        // 2. Observation grounding check
        if (ref.observation && sourceAuditData) {
          const targetFieldText = ref.field && sourceAuditData.fields[ref.field]
            ? sourceAuditData.fields[ref.field]
            : sourceAuditData.fullText;

          if (targetFieldText && !isObservationGrounded(ref.observation, targetFieldText)) {
            warnings.push(
              `Evidence reference in ${domain} (audit ${auditIdStr}, field "${ref.field || 'all'}") failed grounding check: "${ref.observation.substring(0, 40)}..."`
            );
            continue; // Strip ungrounded reference
          }
        }

        let refDate = null;
        if (ref.date) {
          const dObj = new Date(ref.date);
          if (!isNaN(dObj.getTime())) refDate = dObj;
        }

        validatedRefs.push({
          auditId: auditIdStr,
          date: refDate,
          field: ref.field ? String(ref.field) : null,
          observation: ref.observation ? String(ref.observation) : null,
          sourceType: ['structured', 'semantic', 'safety'].includes(ref.sourceType) ? ref.sourceType : 'structured'
        });
      }
    }

    // Conservative data sufficiency rule
    let dataSufficiency = VALID_SUFFICIENCY.has(d.dataSufficiency) ? d.dataSufficiency : 'insufficient';
    if (isFirstAudit || totalHistorical === 0) {
      dataSufficiency = 'insufficient';
    } else if (totalHistorical < 2 && dataSufficiency === 'sufficient') {
      dataSufficiency = 'limited';
    }

    validatedDomains[domain] = {
      status: VALID_STATUSES.has(status) ? status : 'insufficient_data',
      reasons: Array.isArray(d.reasons) ? d.reasons.map(r => String(r)).filter(r => r.trim() !== '') : [],
      evidence: Array.isArray(d.evidence) ? d.evidence.map(e => String(e)).filter(e => e.trim() !== '') : [],
      evidenceReferences: validatedRefs,
      dataSufficiency
    };
  }

  // Hard errors block persistence
  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // Deterministic safety override: acute risk takes absolute precedence
  const urgent = safetyEvaluation.urgent === true || parsed.urgent === true;
  const requiresHumanReview = safetyEvaluation.requiresHumanReview === true ||
    parsed.requires_human_review === true ||
    urgent;

  // Discharge safety invariant: an acute/urgent patient is NEVER fit for discharge
  const fitForDischarge = urgent ? false : parsed.fit_for_discharge === true;

  // Validate next_audit_date
  let nextAuditDate = null;
  if (parsed.next_audit_date) {
    const d = new Date(parsed.next_audit_date);
    if (!isNaN(d.getTime())) nextAuditDate = d;
  }

  // Validate recommended_actions
  const recommendedActions = Array.isArray(parsed.recommended_actions)
    ? parsed.recommended_actions.map(a => String(a)).filter(a => a.trim() !== '')
    : [];

  // Validate retrieval metadata
  const retrievalMode = VALID_RETRIEVAL_MODES.has(parsed.retrievalMetadata?.retrievalMode)
    ? parsed.retrievalMetadata.retrievalMode
    : (assembledContext?.retrievalMetadata?.retrievalMode || 'structured_only');

  const sanitizedResult = {
    domain_evaluations: validatedDomains,
    urgent,
    recommended_actions: recommendedActions,
    fit_for_discharge: fitForDischarge,
    next_audit_date: nextAuditDate,
    requires_human_review: requiresHumanReview,
    retrievalMetadata: {
      retrievalMode,
      embeddingModel: assembledContext?.retrievalMetadata?.embeddingModel || null,
      retrievedAuditIds: assembledContext?.retrievalMetadata?.retrievedAuditIds || [],
      evaluationVersion: 'rag-v1'
    }
  };

  return { valid: true, result: sanitizedResult, warnings };
}

module.exports = {
  validateAndSanitize,
  isObservationGrounded,
  buildContextAuditMap,
  VALID_STATUSES,
  VALID_SUFFICIENCY,
  REQUIRED_DOMAINS
};
