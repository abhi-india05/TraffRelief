'use strict';

const MAX_EVIDENCE_PER_DOMAIN = parseInt(process.env.RAG_MAX_EVIDENCE_PER_DOMAIN || '5', 10);
// Default context budget: ~36,000 chars (~9,000 tokens)
const MAX_CONTEXT_CHARS = parseInt(process.env.RAG_MAX_CONTEXT_CHARS || '36000', 10);

/**
 * Estimate character size of a JS object when serialized.
 */
function estimateCharSize(obj) {
  try {
    return JSON.stringify(obj || {}).length;
  } catch {
    return 0;
  }
}

/**
 * Assemble the final evaluation context from structured + semantic retrieval.
 * Employs priority-based context budgeting:
 * Priority 1: Current audit (never trimmed)
 * Priority 2: Immediately preceding audit
 * Priority 3: Baseline intake audit
 * Priority 4: Active/historical interventions & safety-critical observations
 * Priority 5: Recent chronological history (oldest trimmed first if constrained)
 * Priority 6: Semantic domain evidence (trimmed first if constrained)
 *
 * @param {Object} currentAudit
 * @param {Object} structuredResult
 * @param {Object} semanticResult
 * @returns {Object} Assembled RAG context
 */
function assembleContext(currentAudit, structuredResult, semanticResult) {
  const retrievedAuditIds = new Set(structuredResult.retrievedAuditIds || []);
  if (currentAudit.auditId) retrievedAuditIds.add(currentAudit.auditId);

  // Deduplicate semantic evidence against structured history
  const structuredAuditIds = new Set([
    structuredResult.previousAudit?.auditId,
    structuredResult.baselineAudit?.auditId,
    ...(structuredResult.recentChronologicalHistory || []).map(a => a.auditId),
    ...(structuredResult.criticalSafetyAudits || []).map(a => a.auditId)
  ].filter(Boolean));

  const dedupedDomainEvidence = {};
  for (const [domain, chunks] of Object.entries({
    medical_physical: semanticResult?.medical_physical || [],
    trauma_indicators: semanticResult?.trauma_indicators || [],
    progress_tracking: semanticResult?.progress_tracking || []
  })) {
    // Filter out chunks whose auditId is already in structured history
    const unique = (chunks || [])
      .filter(c => c.auditId && !structuredAuditIds.has(c.auditId))
      .slice(0, MAX_EVIDENCE_PER_DOMAIN);
    dedupedDomainEvidence[domain] = unique;
    unique.forEach(c => { if (c.auditId) retrievedAuditIds.add(c.auditId); });
  }

  // Interventions from structured result
  const interventions = structuredResult.rehabilitationInterventions || [];

  // Start assembling core priority components
  const sanitizedCurrent = sanitizeForPrompt(currentAudit);
  const sanitizedPrevious = sanitizeForPrompt(structuredResult.previousAudit);
  const sanitizedBaseline = sanitizeForPrompt(structuredResult.baselineAudit);
  const sanitizedSafety = (structuredResult.criticalSafetyAudits || []).map(sanitizeForPrompt);
  let chronologicalHistory = (structuredResult.recentChronologicalHistory || []).map(sanitizeForPrompt);

  let isTruncated = false;
  const contextWarnings = [];

  if ((structuredResult.criticalSafetyAudits || []).length >= 10) {
    contextWarnings.push('High volume of historical safety events recorded — clinical human review required.');
  }

  // Budget management: calculate total size and trim lowest priority items if exceeding budget
  let currentEstimate = estimateCharSize({
    currentAudit: sanitizedCurrent,
    previousAudit: sanitizedPrevious,
    baselineAudit: sanitizedBaseline,
    safety: sanitizedSafety,
    interventions,
    history: chronologicalHistory,
    evidence: dedupedDomainEvidence
  });

  // Step 1: Trim semantic evidence if over budget (first down to 2, then to 1)
  if (currentEstimate > MAX_CONTEXT_CHARS) {
    for (const domain of Object.keys(dedupedDomainEvidence)) {
      if (dedupedDomainEvidence[domain].length > 2) {
        dedupedDomainEvidence[domain] = dedupedDomainEvidence[domain].slice(0, 2);
        isTruncated = true;
      }
    }
    currentEstimate = estimateCharSize({
      currentAudit: sanitizedCurrent,
      previousAudit: sanitizedPrevious,
      baselineAudit: sanitizedBaseline,
      safety: sanitizedSafety,
      interventions,
      history: chronologicalHistory,
      evidence: dedupedDomainEvidence
    });
  }

  if (currentEstimate > MAX_CONTEXT_CHARS) {
    for (const domain of Object.keys(dedupedDomainEvidence)) {
      if (dedupedDomainEvidence[domain].length > 1) {
        dedupedDomainEvidence[domain] = dedupedDomainEvidence[domain].slice(0, 1);
        isTruncated = true;
      }
    }
    currentEstimate = estimateCharSize({
      currentAudit: sanitizedCurrent,
      previousAudit: sanitizedPrevious,
      baselineAudit: sanitizedBaseline,
      safety: sanitizedSafety,
      interventions,
      history: chronologicalHistory,
      evidence: dedupedDomainEvidence
    });
  }

  // Step 2: Trim older chronological history if still over budget
  if (currentEstimate > MAX_CONTEXT_CHARS && chronologicalHistory.length > 2) {
    chronologicalHistory = chronologicalHistory.slice(-2); // keep only 2 most recent
    isTruncated = true;
    contextWarnings.push('Chronological history was trimmed to fit model context window budget.');
  }

  const finalEstimatedChars = estimateCharSize({
    currentAudit: sanitizedCurrent,
    previousAudit: sanitizedPrevious,
    baselineAudit: sanitizedBaseline,
    safety: sanitizedSafety,
    interventions,
    history: chronologicalHistory,
    evidence: dedupedDomainEvidence
  });

  return {
    currentAudit: sanitizedCurrent,
    isFirstAudit: structuredResult.isFirstAudit,
    totalHistoricalAudits: structuredResult.totalHistoricalAudits,

    previousAudit: sanitizedPrevious,
    baselineAudit: sanitizedBaseline,

    recentChronologicalHistory: chronologicalHistory,
    domainEvidence: dedupedDomainEvidence,
    historicalSafetyIndicators: sanitizedSafety,
    rehabilitationInterventions: interventions,
    previousAIRecommendations: structuredResult.previousAIRecommendations || [],

    contextWarnings,

    retrievalMetadata: {
      retrievalMode: semanticResult?.retrievalMode || 'structured_only',
      retrievedAuditIds: Array.from(retrievedAuditIds),
      retrievalCounts: {
        recentHistory: chronologicalHistory.length,
        safetyEvents: sanitizedSafety.length,
        interventions: interventions.length,
        semanticMedical: dedupedDomainEvidence.medical_physical.length,
        semanticPsychological: dedupedDomainEvidence.trauma_indicators.length,
        semanticProgress: dedupedDomainEvidence.progress_tracking.length
      },
      budget: {
        totalChars: finalEstimatedChars,
        estimatedTokens: Math.round(finalEstimatedChars / 4),
        budgetLimitChars: MAX_CONTEXT_CHARS,
        isTruncated
      },
      embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001'
    }
  };
}

function sanitizeForPrompt(audit) {
  if (!audit) return null;
  const { _id, victimId, submittedBy, __v, embedding, embeddingVersion, embeddingModel, contentHash, ...rest } = audit;
  return rest;
}

module.exports = { assembleContext, MAX_CONTEXT_CHARS, MAX_EVIDENCE_PER_DOMAIN };
