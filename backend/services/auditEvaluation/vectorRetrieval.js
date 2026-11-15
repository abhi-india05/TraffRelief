'use strict';
const mongoose = require('mongoose');
const AuditEvidenceChunk = require('../../models/auditEvidenceChunk');
const embeddingService = require('./embeddingService');

const isVectorEnabled = () => process.env.RAG_VECTOR_SEARCH_ENABLED === 'true';
const VECTOR_INDEX_NAME = process.env.RAG_VECTOR_INDEX_NAME || 'audit_evidence_index';
const TOP_K = parseInt(process.env.RAG_TOP_K_PER_DOMAIN || '5', 10);
const MIN_COSINE_SIMILARITY = parseFloat(
  process.env.RAG_MIN_COSINE_SIMILARITY || process.env.RAG_MIN_SIMILARITY_THRESHOLD || '0.60'
);

// MongoDB Atlas Vector Search normalized cosine score conversion:
// In Atlas, with similarity="cosine", vectorSearchScore = (1 + cosineSimilarity) / 2.
// Therefore, a desired raw cosine threshold of 0.60 requires an Atlas score of (1 + 0.60) / 2 = 0.80.
const ATLAS_SCORE_THRESHOLD = (1 + MIN_COSINE_SIMILARITY) / 2;

// Domain-specific query templates for semantic search
const DOMAIN_QUERIES = {
  medical_physical: (audit) => [
    'recurring physical symptoms injuries medication medical conditions',
    audit.currentPhysicalSymptoms || '',
    audit.medicalConditionsRequiringTreatment || '',
    'nutritional status sleep patterns medication adherence'
  ].filter(Boolean).join(' ').trim(),

  trauma_indicators: (audit) => [
    'anxiety depression trauma self-harm emotional regulation dissociation withdrawal',
    audit.traumaIndicators || '',
    audit.depressionSymptoms || '',
    audit.anxietyIndicators || '',
    'trust issues mental health factors'
  ].filter(Boolean).join(' ').trim(),

  progress_tracking: (audit) => [
    'therapy attendance rehabilitation activities skill development compliance setbacks',
    audit.therapyAttendanceRate || '',
    audit.goalAchievementProgress || '',
    'behavioral improvements medication adherence interventions'
  ].filter(Boolean).join(' ').trim()
};

/**
 * Perform semantic vector retrieval for one domain.
 * Returns [] if vector search is disabled or index not found.
 * Never throws — always returns empty array on failure.
 *
 * @param {string} domain
 * @param {Object} currentAudit - plain JS audit object
 * @param {ObjectId} victimObjectId - for patient isolation filter
 * @param {ObjectId} currentAuditObjectId - excluded from results
 * @param {Date} currentAuditTimestamp - exclude future records
 * @param {Object} [privacyOptions] - { dataClassification, databaseName }
 * @returns {Promise<Array>}
 */
async function retrieveByDomain(domain, currentAudit, victimObjectId, currentAuditObjectId, currentAuditTimestamp, privacyOptions = {}) {
  if (!isVectorEnabled()) return [];

  try {
    const queryText = DOMAIN_QUERIES[domain](currentAudit);
    if (!queryText || queryText.length < 10) return [];

    const queryVector = await embeddingService.embedQuery(queryText, privacyOptions);

    // Atlas $vectorSearch with patient isolation pre-filter
    const pipeline = [
      {
        $vectorSearch: {
          index: VECTOR_INDEX_NAME,
          path: 'embedding',
          queryVector,
          numCandidates: TOP_K * 10,
          limit: TOP_K * 2, // over-fetch before filtering
          filter: {
            victimId: victimObjectId,  // ObjectId — strict patient isolation enforced
            domain: domain,
            timestamp: { $lt: currentAuditTimestamp }
          }
        }
      },
      { $addFields: { atlasScore: { $meta: 'vectorSearchScore' } } },
      // Convert Atlas score to raw cosine similarity: rawCosine = 2 * atlasScore - 1
      {
        $addFields: {
          rawCosine: {
            $subtract: [{ $multiply: [2, '$atlasScore'] }, 1]
          }
        }
      },
      // Filter by normalized Atlas score threshold
      { $match: { atlasScore: { $gte: ATLAS_SCORE_THRESHOLD } } },
      { $match: { auditRef: { $ne: currentAuditObjectId } } },
      { $sort: { atlasScore: -1, timestamp: -1 } },
      { $limit: TOP_K },
      // Preserve auditRef, partIndex, sourceFields, sourceSegments for server-side validation; exclude heavy embedding & victimId
      { $project: { embedding: 0, _id: 0, victimId: 0 } }
    ];

    const results = await AuditEvidenceChunk.aggregate(pipeline);
    return results;
  } catch (err) {
    if (err.message && err.message.includes('index') && err.message.includes('not found')) {
      console.warn(`[vectorRetrieval] Atlas vector index "${VECTOR_INDEX_NAME}" not found for domain=${domain}. Using structured-only fallback.`);
    } else if (err.message && err.message.includes('GEMINI_PRIVACY_POLICY')) {
      console.error('[vectorRetrieval] Privacy gate blocked embedding generation:', err.message);
    } else {
      console.error(`[vectorRetrieval] Vector search failed for domain=${domain}:`, err.message);
    }
    return [];
  }
}

/**
 * Retrieve semantic evidence for all three domains.
 * @param {Object} currentAudit
 * @param {ObjectId} victimObjectId
 * @param {ObjectId} currentAuditObjectId
 * @param {Date} currentAuditTimestamp
 * @param {Object} [privacyOptions]
 * @returns {Promise<{medical_physical: [], trauma_indicators: [], progress_tracking: [], retrievalMode: string}>}
 */
async function retrieveSemanticContext(currentAudit, victimObjectId, currentAuditObjectId, currentAuditTimestamp, privacyOptions = {}) {
  if (!isVectorEnabled()) {
    return {
      medical_physical: [],
      trauma_indicators: [],
      progress_tracking: [],
      retrievalMode: 'structured_only'
    };
  }

  const [medical, psychological, progress] = await Promise.all([
    retrieveByDomain('medical_physical', currentAudit, victimObjectId, currentAuditObjectId, currentAuditTimestamp, privacyOptions),
    retrieveByDomain('trauma_indicators', currentAudit, victimObjectId, currentAuditObjectId, currentAuditTimestamp, privacyOptions),
    retrieveByDomain('progress_tracking', currentAudit, victimObjectId, currentAuditObjectId, currentAuditTimestamp, privacyOptions)
  ]);

  const totalRetrieved = medical.length + psychological.length + progress.length;

  return {
    medical_physical: medical,
    trauma_indicators: psychological,
    progress_tracking: progress,
    retrievalMode: totalRetrieved > 0 ? 'hybrid' : 'structured_only'
  };
}

module.exports = {
  retrieveSemanticContext,
  retrieveByDomain,
  ATLAS_SCORE_THRESHOLD,
  MIN_COSINE_SIMILARITY
};
