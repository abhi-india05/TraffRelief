'use strict';
const AuditEvidenceChunk = require('../../models/auditEvidenceChunk');
const { buildChunks } = require('./auditChunkBuilder');
const { embedDocument, computeContentHash, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = require('./embeddingService');

const RAG_ENABLED = process.env.RAG_ENABLED === 'true';
const RAG_VECTOR_ENABLED = process.env.RAG_VECTOR_SEARCH_ENABLED === 'true';
const EMBEDDING_VERSION = `${EMBEDDING_MODEL}@768`;

/**
 * Index a single audit: build domain chunks, embed new/changed ones, upsert to MongoDB.
 * Idempotent — safe to call multiple times on the same audit.
 *
 * @param {Object} audit — Mongoose doc or plain object with _id, victimId, auditId, timestamp and all assessment fields
 * @returns {Promise<{ success: boolean, indexed: number, skipped: number, failed: number, error?: string }>}
 */
async function indexAudit(audit) {
  if (!RAG_ENABLED) return { success: true, indexed: 0, skipped: 0, failed: 0, note: 'RAG disabled' };

  const result = { success: true, indexed: 0, skipped: 0, failed: 0 };

  const chunks = buildChunks(audit);

  for (const chunk of chunks) {
    const hash = computeContentHash(chunk.content);

    // Check for existing chunk with same content hash and embedding version
    const existing = await AuditEvidenceChunk.findOne({
      auditRef: audit._id,
      domain: chunk.domain,
      contentHash: hash,
      embeddingVersion: RAG_VECTOR_ENABLED ? EMBEDDING_VERSION : null
    });

    if (existing && existing.indexingStatus === 'completed') {
      result.skipped++;
      continue;
    }

    let embedding = null;
    let embeddingModel = null;
    let embeddingDimensions = null;
    let embeddingVersion = null;

    if (RAG_VECTOR_ENABLED) {
      try {
        embedding = await embedDocument(chunk.content);
        embeddingModel = EMBEDDING_MODEL;
        embeddingDimensions = EMBEDDING_DIMENSIONS;
        embeddingVersion = EMBEDDING_VERSION;
      } catch (err) {
        // Log without sensitive content
        console.error(`[auditIndexingService] Embedding failed for domain=${chunk.domain} auditId=${audit.auditId}:`, err.message);
        result.failed++;
        // Still store the chunk without embedding for structured retrieval
        try {
          await AuditEvidenceChunk.findOneAndUpdate(
            { auditRef: audit._id, domain: chunk.domain },
            {
              victimId: audit.victimId,
              auditRef: audit._id,
              auditId: audit.auditId,
              domain: chunk.domain,
              timestamp: audit.timestamp || new Date(),
              content: chunk.content,
              sourceFields: chunk.sourceFields,
              contentHash: hash,
              embedding: null,
              embeddingModel: null,
              embeddingDimensions: null,
              embeddingVersion: null,
              indexingStatus: 'failed',
              indexingError: err.message.substring(0, 500)
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
        } catch (dbErr) {
          console.error('[auditIndexingService] Failed to save failed chunk record:', dbErr.message);
        }
        continue;
      }
    }

    try {
      await AuditEvidenceChunk.findOneAndUpdate(
        { auditRef: audit._id, domain: chunk.domain },
        {
          victimId: audit.victimId,
          auditRef: audit._id,
          auditId: audit.auditId,
          domain: chunk.domain,
          timestamp: audit.timestamp || new Date(),
          content: chunk.content,
          sourceFields: chunk.sourceFields,
          contentHash: hash,
          embedding,
          embeddingModel,
          embeddingDimensions,
          embeddingVersion,
          indexingStatus: RAG_VECTOR_ENABLED ? 'completed' : 'pending',
          indexingError: null
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      result.indexed++;
    } catch (dbErr) {
      console.error(`[auditIndexingService] DB upsert failed for domain=${chunk.domain}:`, dbErr.message);
      result.failed++;
    }
  }

  result.success = result.failed === 0 || result.indexed > 0;
  return result;
}

module.exports = { indexAudit };
