'use strict';

const MAX_EVIDENCE_PER_DOMAIN = parseInt(process.env.RAG_MAX_EVIDENCE_PER_DOMAIN || '5', 10);
// Default context budget: ~36,000 chars (~9,000 tokens)
const MAX_CONTEXT_CHARS = parseInt(process.env.RAG_MAX_CONTEXT_CHARS || '36000', 10);
// Estimated system prompt & formatting overhead (~1,250 tokens / 5,000 chars)
const SYSTEM_OVERHEAD_CHARS = 5000;
// Effective budget for audit data payload
const EFFECTIVE_BUDGET_CHARS = Math.max(8000, MAX_CONTEXT_CHARS - SYSTEM_OVERHEAD_CHARS);

/**
 * Estimate character size of a JS object when serialized to JSON.
 */
function estimateCharSize(obj) {
  try {
    return JSON.stringify(obj || {}).length;
  } catch {
    return 0;
  }
}

/**
 * Conservative token count estimator.
 * English clinical text with JSON formatting averages ~3.5 characters per token.
 * Clearly identified as estimated rather than directly measured.
 */
function estimateTokens(chars) {
  return Math.ceil((chars || 0) / 3.5);
}

/**
 * Helper to extract a normalized string audit ID from an audit or chunk object.
 */
function getAuditId(item) {
  if (!item) return null;
  return (item.auditRef || item.auditId || item._id)?.toString() || null;
}

/**
 * Produces a safe compact representation of an audit when the mandatory context
 * exceeds the token budget. Preserves original source references and all safety-critical fields,
 * while truncating verbose narrative fields.
 */
function compactAudit(audit) {
  if (!audit) return null;
  const sanitized = sanitizeForPrompt(audit);
  const compacted = {};
  const safetyPreservedKeys = new Set([
    'auditId', 'createdAt', 'timestamp', 'submittedByRole',
    'selfHarmBehaviors', 'incidentReportsOrSetbacks',
    'medicalConditionsRequiringTreatment', 'physicalInjuriesSustained',
    'suicidalIdeation', 'safetyAlerts'
  ]);

  for (const [key, val] of Object.entries(sanitized)) {
    if (safetyPreservedKeys.has(key)) {
      compacted[key] = val;
    } else if (typeof val === 'string' && val.length > 150) {
      compacted[key] = val.slice(0, 150) + '... [summarized due to context limit]';
    } else {
      compacted[key] = val;
    }
  }
  compacted._isCompacted = true;
  return compacted;
}

/**
 * Assemble the final evaluation context from structured + semantic retrieval.
 * Employs priority-based context budgeting:
 * Priority 1: Current audit (never trimmed)
 * Priority 2: Immediately preceding audit
 * Priority 3: Baseline intake audit
 * Priority 4: Critical safety indicators & timeline
 * Priority 5: Active & historical rehabilitation interventions
 * Priority 6: Recent chronological history (oldest trimmed first if constrained)
 * Priority 7: Semantic domain evidence (trimmed first if constrained)
 * Priority 8: Previous AI recommendations
 *
 * @param {Object} currentAudit
 * @param {Object} structuredResult
 * @param {Object} semanticResult
 * @returns {Object} Assembled RAG context
 */
function assembleContext(currentAudit, structuredResult, semanticResult) {
  const retrievedAuditIds = new Set(structuredResult?.retrievedAuditIds || []);
  const currentId = getAuditId(currentAudit);
  if (currentId) retrievedAuditIds.add(currentId);

  // Set of audit IDs already fully represented in structured history
  const structuredAuditIds = new Set([
    getAuditId(structuredResult?.previousAudit),
    getAuditId(structuredResult?.baselineAudit),
    ...(structuredResult?.recentChronologicalHistory || []).map(getAuditId),
    ...(structuredResult?.criticalSafetyAudits || []).map(getAuditId)
  ].filter(Boolean));

  // Deduplicate semantic evidence against structured history and support multiple subchunks
  const dedupedDomainEvidence = {};
  let totalSemanticChunks = 0;

  for (const domain of ['medical_physical', 'trauma_indicators', 'progress_tracking']) {
    const rawChunks = semanticResult?.[domain] || [];
    const seenChunkKeys = new Set();
    const unique = [];

    for (const chunk of rawChunks) {
      const chunkAuditId = getAuditId(chunk);
      // Discard if audit is already in structured history (entire audit is already included)
      if (chunkAuditId && structuredAuditIds.has(chunkAuditId)) {
        continue;
      }
      // Support multiple subchunks from the same audit with distinct partIndex
      const partIdx = chunk.partIndex != null ? chunk.partIndex : 0;
      const chunkKey = `${chunkAuditId || 'unknown'}_${domain}_${partIdx}`;
      if (seenChunkKeys.has(chunkKey)) {
        continue;
      }
      seenChunkKeys.add(chunkKey);
      unique.push(chunk);
      if (chunkAuditId) retrievedAuditIds.add(chunkAuditId);
    }

    dedupedDomainEvidence[domain] = unique.slice(0, MAX_EVIDENCE_PER_DOMAIN);
    totalSemanticChunks += dedupedDomainEvidence[domain].length;
  }

  // Interventions from structured result
  let interventions = [...(structuredResult?.rehabilitationInterventions || [])];

  // Core priority components
  const sanitizedCurrent = sanitizeForPrompt(currentAudit);
  let sanitizedPrevious = sanitizeForPrompt(structuredResult?.previousAudit);
  let sanitizedBaseline = sanitizeForPrompt(structuredResult?.baselineAudit);
  let sanitizedSafety = (structuredResult?.criticalSafetyAudits || []).map(sanitizeForPrompt);
  let chronologicalHistory = (structuredResult?.recentChronologicalHistory || []).map(sanitizeForPrompt);
  let previousRecommendations = [...(structuredResult?.previousAIRecommendations || [])];

  let isTruncated = false;
  let historySummarized = false;
  let requiresHumanReview = false;
  const contextWarnings = [];

  if ((structuredResult?.criticalSafetyAudits || []).length >= 10) {
    contextWarnings.push('High volume of historical safety events recorded — clinical human review required.');
    requiresHumanReview = true;
  }

  // Helper to calculate current payload size
  const computePayloadSize = () => estimateCharSize({
    currentAudit: sanitizedCurrent,
    previousAudit: sanitizedPrevious,
    baselineAudit: sanitizedBaseline,
    safety: sanitizedSafety,
    safetyTimeline: structuredResult?.safetyTimeline || [],
    interventions,
    history: chronologicalHistory,
    evidence: dedupedDomainEvidence,
    previousRecommendations
  });

  let currentEstimate = computePayloadSize();

  // Priority-based trimming when exceeding effective data budget:

  // Step 0: Trim previous AI recommendations (Priority 8)
  if (currentEstimate > EFFECTIVE_BUDGET_CHARS && previousRecommendations.length > 0) {
    previousRecommendations = [];
    isTruncated = true;
    currentEstimate = computePayloadSize();
  }

  // Step 1: Trim semantic evidence (Priority 7) - first down to 2, then 1, then 0 per domain
  if (currentEstimate > EFFECTIVE_BUDGET_CHARS) {
    for (const domain of Object.keys(dedupedDomainEvidence)) {
      if (dedupedDomainEvidence[domain].length > 2) {
        dedupedDomainEvidence[domain] = dedupedDomainEvidence[domain].slice(0, 2);
        isTruncated = true;
      }
    }
    currentEstimate = computePayloadSize();
  }

  if (currentEstimate > EFFECTIVE_BUDGET_CHARS) {
    for (const domain of Object.keys(dedupedDomainEvidence)) {
      if (dedupedDomainEvidence[domain].length > 1) {
        dedupedDomainEvidence[domain] = dedupedDomainEvidence[domain].slice(0, 1);
        isTruncated = true;
      }
    }
    currentEstimate = computePayloadSize();
  }

  if (currentEstimate > EFFECTIVE_BUDGET_CHARS) {
    for (const domain of Object.keys(dedupedDomainEvidence)) {
      if (dedupedDomainEvidence[domain].length > 0) {
        dedupedDomainEvidence[domain] = [];
        isTruncated = true;
      }
    }
    currentEstimate = computePayloadSize();
  }

  // Step 2: Trim older chronological history (Priority 6) - first to 2, then 1, then 0
  if (currentEstimate > EFFECTIVE_BUDGET_CHARS && chronologicalHistory.length > 2) {
    chronologicalHistory = chronologicalHistory.slice(-2);
    isTruncated = true;
    contextWarnings.push('Chronological history was trimmed to fit model context window budget.');
    currentEstimate = computePayloadSize();
  }

  if (currentEstimate > EFFECTIVE_BUDGET_CHARS && chronologicalHistory.length > 1) {
    chronologicalHistory = chronologicalHistory.slice(-1);
    isTruncated = true;
    currentEstimate = computePayloadSize();
  }

  if (currentEstimate > EFFECTIVE_BUDGET_CHARS && chronologicalHistory.length > 0) {
    chronologicalHistory = [];
    isTruncated = true;
    currentEstimate = computePayloadSize();
  }

  // Step 3: Trim completed interventions if very many (Priority 5)
  if (currentEstimate > EFFECTIVE_BUDGET_CHARS && interventions.length > 5) {
    // Keep active/in_progress interventions + top 3 most recent
    const active = interventions.filter(i => i.status === 'in_progress' || i.status === 'recommended');
    const completed = interventions.filter(i => i.status !== 'in_progress' && i.status !== 'recommended').slice(0, 3);
    interventions = [...active, ...completed];
    isTruncated = true;
    currentEstimate = computePayloadSize();
  }

  // Step 4: Mandatory records alone exceed budget (Current + Previous + Baseline + Safety)
  // Produce a safe compact representation without silently discarding mandatory history
  if (currentEstimate > EFFECTIVE_BUDGET_CHARS) {
    if (sanitizedPrevious) {
      sanitizedPrevious = compactAudit(sanitizedPrevious);
    }
    if (sanitizedBaseline) {
      sanitizedBaseline = compactAudit(sanitizedBaseline);
    }
    if (sanitizedSafety.length > 5) {
      // Compact safety audits while preserving critical timeline
      sanitizedSafety = sanitizedSafety.slice(-5).map(compactAudit);
    }
    historySummarized = true;
    requiresHumanReview = true;
    isTruncated = true;
    contextWarnings.push('Context budget exceeded: mandatory historical audit records were compacted. Clinical human review required.');
    currentEstimate = computePayloadSize();
  }

  // Recount semantic chunks after any trimming
  const remainingSemanticCount =
    (dedupedDomainEvidence.medical_physical?.length || 0) +
    (dedupedDomainEvidence.trauma_indicators?.length || 0) +
    (dedupedDomainEvidence.progress_tracking?.length || 0);

  // Server determines retrievalMode strictly
  const retrievalMode = remainingSemanticCount > 0 ? 'hybrid' : 'structured_only';

  return {
    currentAudit: sanitizedCurrent,
    isFirstAudit: structuredResult?.isFirstAudit || false,
    totalHistoricalAudits: structuredResult?.totalHistoricalAudits || 0,

    previousAudit: sanitizedPrevious,
    baselineAudit: sanitizedBaseline,

    recentChronologicalHistory: chronologicalHistory,
    domainEvidence: dedupedDomainEvidence,
    historicalSafetyIndicators: sanitizedSafety,
    safetyTimeline: structuredResult?.safetyTimeline || [],
    rehabilitationInterventions: interventions,
    previousAIRecommendations: previousRecommendations,

    contextWarnings,
    historySummarized,
    requiresHumanReview,

    retrievalMetadata: {
      retrievalMode,
      semanticFailed: Boolean(semanticResult?.failed),
      retrievedAuditIds: Array.from(retrievedAuditIds),
      retrievalCounts: {
        recentHistory: chronologicalHistory.length,
        safetyEvents: sanitizedSafety.length,
        interventions: interventions.length,
        semanticMedical: dedupedDomainEvidence.medical_physical?.length || 0,
        semanticPsychological: dedupedDomainEvidence.trauma_indicators?.length || 0,
        semanticProgress: dedupedDomainEvidence.progress_tracking?.length || 0,
        totalSemanticEvidence: remainingSemanticCount
      },
      budget: {
        totalChars: currentEstimate,
        estimatedTokens: estimateTokens(currentEstimate),
        isEstimatedTokenCount: true,
        budgetLimitChars: MAX_CONTEXT_CHARS,
        systemOverheadChars: SYSTEM_OVERHEAD_CHARS,
        effectiveBudgetChars: EFFECTIVE_BUDGET_CHARS,
        isTruncated,
        historySummarized
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

module.exports = {
  assembleContext,
  compactAudit,
  estimateCharSize,
  estimateTokens,
  MAX_CONTEXT_CHARS,
  MAX_EVIDENCE_PER_DOMAIN,
  SYSTEM_OVERHEAD_CHARS,
  EFFECTIVE_BUDGET_CHARS
};
