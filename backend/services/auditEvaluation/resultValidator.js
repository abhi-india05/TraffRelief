'use strict';

const VALID_STATUSES = new Set(['improving', 'no_change', 'declining', 'insufficient_data']);
const VALID_SUFFICIENCY = new Set(['sufficient', 'limited', 'insufficient']);
const VALID_RETRIEVAL_MODES = new Set(['structured_only', 'hybrid']);
const REQUIRED_DOMAINS = ['medical_physical', 'trauma_indicators', 'progress_tracking'];

/**
 * Validate AI-generated result before persisting to MongoDB.
 * Rejects invalid schemas and sanitizes evidence references.
 *
 * @param {Object} parsed - raw parsed object from Gemini response
 * @param {Object} assembledContext - context used for generation (for evidence ref validation)
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

  // Build the set of valid auditIds from the assembled context for hallucination prevention
  const validContextAuditIds = new Set(assembledContext?.retrievalMetadata?.retrievedAuditIds || []);
  if (assembledContext?.currentAudit?.auditId) {
    validContextAuditIds.add(assembledContext.currentAudit.auditId);
  }
  if (assembledContext?.previousAudit?.auditId) {
    validContextAuditIds.add(assembledContext.previousAudit.auditId);
  }
  if (assembledContext?.baselineAudit?.auditId) {
    validContextAuditIds.add(assembledContext.baselineAudit.auditId);
  }

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

    // Validate evidence references against context
    const validatedRefs = [];
    if (Array.isArray(d.evidenceReferences)) {
      for (const ref of d.evidenceReferences) {
        if (!ref || typeof ref !== 'object' || !ref.auditId) {
          warnings.push(`Malformed evidenceReference in ${domain} (missing auditId)`);
          continue;
        }

        // Check if auditId exists in context
        if (validContextAuditIds.size > 0 && !validContextAuditIds.has(ref.auditId)) {
          warnings.push(`Unverified evidenceReference auditId "${ref.auditId}" in ${domain} not found in retrieved context`);
          continue; // Strip hallucinated reference
        }

        let refDate = null;
        if (ref.date) {
          const dObj = new Date(ref.date);
          if (!isNaN(dObj.getTime())) refDate = dObj;
        }

        validatedRefs.push({
          auditId: String(ref.auditId),
          date: refDate,
          field: ref.field ? String(ref.field) : null,
          observation: ref.observation ? String(ref.observation) : null,
          sourceType: ['structured', 'semantic', 'safety'].includes(ref.sourceType) ? ref.sourceType : 'structured'
        });
      }
    }

    const dataSufficiency = VALID_SUFFICIENCY.has(d.dataSufficiency) ? d.dataSufficiency : 'sufficient';

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

  // Safety evaluation override: deterministic safety rules take precedence
  const urgent = safetyEvaluation.urgent === true || parsed.urgent === true;
  const requiresHumanReview = safetyEvaluation.requiresHumanReview === true ||
    parsed.requires_human_review === true ||
    urgent;

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
    fit_for_discharge: parsed.fit_for_discharge === true,
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

module.exports = { validateAndSanitize, VALID_STATUSES, VALID_SUFFICIENCY, REQUIRED_DOMAINS };

