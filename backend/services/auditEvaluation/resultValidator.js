'use strict';

const VALID_STATUSES = new Set(['improving', 'no_change', 'declining', 'insufficient_data']);
const VALID_SUFFICIENCY = new Set(['sufficient', 'limited', 'insufficient']);
const REQUIRED_DOMAINS = ['medical_physical', 'trauma_indicators', 'progress_tracking'];

/**
 * Normalise text for exact grounding comparison by stripping harmless punctuation,
 * excessive whitespace, and casing differences.
 *
 * @param {string} str
 * @returns {string}
 */
function normalizeGroundingText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check whether an observation quotation is grounded in source text.
 * Requires the observation to be an exact normalized substring of the target field.
 * Loose token-overlap heuristics are rejected to guarantee clinical fidelity.
 *
 * @param {string} observation - AI reported observation/quote
 * @param {string} sourceText - Actual audit field text
 * @returns {boolean}
 */
function isObservationGrounded(observation, sourceText) {
  if (!observation || !sourceText) return false;
  const normObs = normalizeGroundingText(observation);
  const normSrc = normalizeGroundingText(sourceText);

  if (!normObs || !normSrc) return false;
  return normSrc.includes(normObs);
}

/**
 * Build a server-side trusted evidence source map from the assembled context.
 * Gemini NEVER defines or modifies this map.
 *
 * Map Key: auditId (e.g. 'AUD-101')
 * Map Value: {
 *   auditId: string,
 *   auditRef: ObjectId|string,
 *   date: Date|null,
 *   fields: { [fieldName]: string },
 *   sourceTypes: Set<'structured'|'semantic'|'safety'>,
 *   sourceSegments: Array<{ field: string, text: string }>
 * }
 *
 * @param {Object} assembledContext
 * @returns {Map<string, Object>}
 */
function buildEvidenceSourceMap(assembledContext) {
  const sourceMap = new Map();

  function registerRecord(record, primarySourceType = 'structured') {
    if (!record || !record.auditId) return;
    const auditId = String(record.auditId).trim();

    const existing = sourceMap.get(auditId) || {
      auditId,
      auditRef: record.auditRef || record._id || null,
      date: record.timestamp ? new Date(record.timestamp) : null,
      fields: {},
      sourceTypes: new Set(),
      sourceSegments: []
    };

    existing.sourceTypes.add(primarySourceType);
    if (!existing.auditRef && (record.auditRef || record._id)) {
      existing.auditRef = record.auditRef || record._id;
    }
    if (!existing.date && record.timestamp) {
      existing.date = new Date(record.timestamp);
    }

    // Register all string fields from the audit document
    for (const [key, val] of Object.entries(record)) {
      if (typeof val === 'string' && val.trim() !== '') {
        existing.fields[key] = val.trim();
      }
    }

    sourceMap.set(auditId, existing);
  }

  // Register structured historical records
  registerRecord(assembledContext?.currentAudit, 'structured');
  registerRecord(assembledContext?.previousAudit, 'structured');
  registerRecord(assembledContext?.baselineAudit, 'structured');

  (assembledContext?.recentChronologicalHistory || []).forEach(r => registerRecord(r, 'structured'));
  (assembledContext?.historicalSafetyIndicators || []).forEach(r => registerRecord(r, 'safety'));

  // Register safety timeline events
  (assembledContext?.safetyTimeline || []).forEach(item => {
    if (item?.auditId) {
      const entry = sourceMap.get(item.auditId) || {
        auditId: item.auditId,
        auditRef: null,
        date: item.timestamp ? new Date(item.timestamp) : null,
        fields: {},
        sourceTypes: new Set(),
        sourceSegments: []
      };
      entry.sourceTypes.add('safety');
      if (item.field && item.observation) {
        entry.fields[item.field] = item.observation;
      }
      sourceMap.set(item.auditId, entry);
    }
  });

  // Register semantic domain evidence chunks
  const domainEvidence = assembledContext?.domainEvidence || {};
  for (const chunks of Object.values(domainEvidence)) {
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        if (!chunk || !chunk.auditId) continue;
        const auditId = String(chunk.auditId).trim();
        const existing = sourceMap.get(auditId) || {
          auditId,
          auditRef: chunk.auditRef || null,
          date: chunk.timestamp ? new Date(chunk.timestamp) : null,
          fields: {},
          sourceTypes: new Set(),
          sourceSegments: []
        };
        existing.sourceTypes.add('semantic');
        if (chunk.auditRef && !existing.auditRef) existing.auditRef = chunk.auditRef;
        if (chunk.timestamp && !existing.date) existing.date = new Date(chunk.timestamp);

        // Register segments
        if (Array.isArray(chunk.sourceSegments)) {
          for (const seg of chunk.sourceSegments) {
            if (seg?.field && seg.text) {
              existing.fields[seg.field] = seg.text;
              existing.sourceSegments.push({ field: seg.field, text: seg.text });
            }
          }
        }
        sourceMap.set(auditId, existing);
      }
    }
  }

  return sourceMap;
}

/**
 * Validate AI-generated result before persisting to MongoDB.
 * Rejects invalid schemas, strictly verifies evidence references against exact source fields,
 * strips ungrounded or hallucinated references, and enforces deterministic safety overrides.
 *
 * @param {Object} parsed - raw parsed object from Gemini response
 * @param {Object} assembledContext - trusted context used for generation
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

  const evidenceSourceMap = buildEvidenceSourceMap(assembledContext);
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

    // Strict evidence reference validation
    const validatedRefs = [];
    if (Array.isArray(d.evidenceReferences)) {
      for (const ref of d.evidenceReferences) {
        if (!ref || typeof ref !== 'object' || !ref.auditId) {
          warnings.push(`Malformed evidenceReference in ${domain} (missing auditId)`);
          continue;
        }

        const auditIdStr = String(ref.auditId).trim();

        // 1. Audit ID must exist in trusted evidence source map
        if (!evidenceSourceMap.has(auditIdStr)) {
          warnings.push(
            `Unverified evidenceReference auditId "${auditIdStr}" in ${domain} not found in retrieved context`
          );
          continue; // Strip hallucinated audit reference
        }

        const sourceEntry = evidenceSourceMap.get(auditIdStr);

        // 2. Field name must be present
        if (!ref.field || typeof ref.field !== 'string' || ref.field.trim() === '') {
          warnings.push(`Evidence reference for audit ${auditIdStr} in ${domain} missing specific source field`);
          continue;
        }
        const fieldName = ref.field.trim();

        // 3. The target field MUST exist and have content in that specific audit
        const sourceFieldContent = sourceEntry.fields[fieldName];
        if (!sourceFieldContent) {
          warnings.push(
            `Evidence reference in ${domain} cites field "${fieldName}" in audit ${auditIdStr}, but that field does not exist in the source audit`
          );
          continue; // Strip reference with non-existent field (never fall back to full audit text)
        }

        // 4. Observation must be present and non-empty
        if (!ref.observation || typeof ref.observation !== 'string' || ref.observation.trim() === '') {
          warnings.push(`Evidence reference in ${domain} for audit ${auditIdStr} missing observation text`);
          continue;
        }
        const observationText = ref.observation.trim();

        // 5. Exact quotation grounding check within the specific source field
        if (!isObservationGrounded(observationText, sourceFieldContent)) {
          warnings.push(
            `Evidence reference in ${domain} (audit ${auditIdStr}, field "${fieldName}") failed grounding check (exact quotation not found): "${observationText.substring(0, 50)}"`
          );
          continue; // Strip ungrounded reference
        }

        // 6. Source type must be derived by the server (never accept untrusted model self-report)
        let derivedSourceType = 'structured';
        if (sourceEntry.sourceTypes.has('semantic')) {
          derivedSourceType = 'semantic';
        } else if (sourceEntry.sourceTypes.has('safety')) {
          derivedSourceType = 'safety';
        }

        // 7. Date must match actual source audit date
        const verifiedDate = sourceEntry.date ? sourceEntry.date : null;

        validatedRefs.push({
          auditId: auditIdStr,
          date: verifiedDate,
          field: fieldName,
          observation: observationText,
          sourceType: derivedSourceType
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
    assembledContext?.requiresHumanReview === true ||
    urgent;

  // Discharge safety invariant: an acute/urgent patient is NEVER fit for discharge
  const fitForDischarge = urgent ? false : parsed.fit_for_discharge === true;

  // If history was summarized due to context budget limits, cap data sufficiency at 'limited'
  if (assembledContext?.historySummarized) {
    for (const d of REQUIRED_DOMAINS) {
      if (validatedDomains[d] && validatedDomains[d].dataSufficiency === 'sufficient') {
        validatedDomains[d].dataSufficiency = 'limited';
        warnings.push(`Domain "${d}" data sufficiency capped at "limited" due to summarized historical context.`);
      }
    }
  }

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

  // Server strictly owns retrieval mode (Gemini self-reported mode is rejected)
  const serverRetrievalMode = assembledContext?.retrievalMetadata?.retrievalMode || 'structured_only';

  const sanitizedResult = {
    domain_evaluations: validatedDomains,
    urgent,
    recommended_actions: recommendedActions,
    fit_for_discharge: fitForDischarge,
    next_audit_date: nextAuditDate,
    requires_human_review: requiresHumanReview,
    retrievalMetadata: {
      retrievalMode: serverRetrievalMode,
      embeddingModel: assembledContext?.retrievalMetadata?.embeddingModel || null,
      retrievedAuditIds: assembledContext?.retrievalMetadata?.retrievedAuditIds || [],
      retrievalCounts: assembledContext?.retrievalMetadata?.retrievalCounts || null,
      budget: assembledContext?.retrievalMetadata?.budget || null,
      evaluationVersion: 'rag-v1'
    }
  };

  return { valid: true, result: sanitizedResult, warnings };
}

module.exports = {
  validateAndSanitize,
  isObservationGrounded,
  buildEvidenceSourceMap,
  normalizeGroundingText,
  VALID_STATUSES,
  VALID_SUFFICIENCY,
  REQUIRED_DOMAINS
};
