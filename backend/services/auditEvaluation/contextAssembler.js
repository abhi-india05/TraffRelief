'use strict';

const MAX_EVIDENCE_PER_DOMAIN = parseInt(process.env.RAG_MAX_EVIDENCE_PER_DOMAIN || '10', 10);

/**
 * Assemble the final evaluation context from structured + semantic retrieval.
 * Priority order when budget-constrained:
 * 1. Current audit
 * 2. Previous audit
 * 3. Baseline audit
 * 4. Critical safety events
 * 5. Recent chronological history
 * 6. Semantic domain evidence
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
    const unique = chunks
      .filter(c => c.auditId && !structuredAuditIds.has(c.auditId))
      .slice(0, MAX_EVIDENCE_PER_DOMAIN);
    dedupedDomainEvidence[domain] = unique;
    unique.forEach(c => { if (c.auditId) retrievedAuditIds.add(c.auditId); });
  }

  // Check for context budget pressure on safety events
  const hasOverflowSafety = (structuredResult.criticalSafetyAudits || []).length >= 10;

  return {
    currentAudit: sanitizeForPrompt(currentAudit),
    isFirstAudit: structuredResult.isFirstAudit,
    totalHistoricalAudits: structuredResult.totalHistoricalAudits,

    previousAudit: sanitizeForPrompt(structuredResult.previousAudit),
    baselineAudit: sanitizeForPrompt(structuredResult.baselineAudit),

    recentChronologicalHistory: (structuredResult.recentChronologicalHistory || []).map(sanitizeForPrompt),

    domainEvidence: dedupedDomainEvidence,

    historicalSafetyIndicators: (structuredResult.criticalSafetyAudits || []).map(sanitizeForPrompt),

    previousAIRecommendations: structuredResult.previousAIRecommendations || [],

    contextWarnings: [
      hasOverflowSafety ? 'Many historical safety events found — context may be truncated. Human review is strongly recommended.' : null
    ].filter(Boolean),

    retrievalMetadata: {
      retrievalMode: semanticResult?.retrievalMode || 'structured_only',
      retrievedAuditIds: Array.from(retrievedAuditIds),
      retrievalCounts: {
        recentHistory: (structuredResult.recentChronologicalHistory || []).length,
        safetyEvents: (structuredResult.criticalSafetyAudits || []).length,
        semanticMedical: dedupedDomainEvidence.medical_physical.length,
        semanticPsychological: dedupedDomainEvidence.trauma_indicators.length,
        semanticProgress: dedupedDomainEvidence.progress_tracking.length
      },
      embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001'
    }
  };
}

function sanitizeForPrompt(audit) {
  if (!audit) return null;
  // Strip internal DB fields — do NOT include ObjectIds or sensitive metadata in Gemini prompt
  const { _id, victimId, submittedBy, __v, embedding, embeddingVersion, embeddingModel, contentHash, ...rest } = audit;
  return rest;
}

module.exports = { assembleContext };
