'use strict';
const mongoose = require('mongoose');
const AuditEvidenceChunk = require('../../models/auditEvidenceChunk');
const Victim = require('../../models/victim');
const { buildChunks } = require('./auditChunkBuilder');
const embeddingService = require('./embeddingService');

const isRagEnabled = () => process.env.RAG_ENABLED !== 'false';
const isVectorEnabled = () => process.env.RAG_VECTOR_SEARCH_ENABLED === 'true';
const getEmbeddingVersion = () => `${embeddingService.EMBEDDING_MODEL}@768`;

/**
 * Index a single audit: build domain chunks, embed new/changed ones, upsert to MongoDB
 * using the complete stable chunk identity: { auditRef, domain, partIndex }.
 * Idempotent — safe to call multiple times on the same audit.
 *
 * @param {Object} audit — Mongoose doc or plain object with _id, victimId, auditId, timestamp and assessment fields
 * @returns {Promise<{ success: boolean, indexed: number, skipped: number, failed: number, error?: string }>}
 */
async function indexAudit(audit) {
  if (!isRagEnabled()) return { success: true, indexed: 0, skipped: 0, failed: 0, note: 'RAG disabled' };

  const result = { success: true, indexed: 0, skipped: 0, failed: 0 };
  const vectorEnabled = isVectorEnabled();
  const currentEmbeddingVersion = vectorEnabled ? getEmbeddingVersion() : null;

  // Resolve victim data classification for privacy gate
  let dataClassification = audit.victimId?.dataClassification || audit.dataClassification;
  if (!dataClassification && audit.victimId) {
    try {
      const v = await Victim.findById(audit.victimId).select('dataClassification').lean();
      if (v) dataClassification = v.dataClassification;
    } catch {
      dataClassification = 'real';
    }
  }
  const privacyOptions = {
    dataClassification: dataClassification || 'real',
    databaseName: mongoose.connection?.name || ''
  };

  const chunks = buildChunks(audit);

  // Group chunk part counts per domain to clean up stale subchunks if content shrank
  const domainPartCounts = {};
  for (const c of chunks) {
    domainPartCounts[c.domain] = Math.max(domainPartCounts[c.domain] || 0, c.partCount);
  }

  for (const chunk of chunks) {
    const hash = embeddingService.computeContentHash(chunk.content);
    const chunkIdentity = {
      auditRef: audit._id,
      domain: chunk.domain,
      partIndex: chunk.partIndex
    };

    // Check for existing chunk with identical identity, content hash and embedding version
    const existing = await AuditEvidenceChunk.findOne({
      ...chunkIdentity,
      contentHash: hash,
      embeddingVersion: currentEmbeddingVersion
    });

    if (existing && existing.indexingStatus === 'completed') {
      result.skipped++;
      continue;
    }

    let embedding = null;
    let embeddingModel = null;
    let embeddingDimensions = null;
    let embeddingVersion = null;

    if (vectorEnabled) {
      try {
        embedding = await embeddingService.embedDocument(chunk.content, privacyOptions);
        embeddingModel = embeddingService.EMBEDDING_MODEL;
        embeddingDimensions = embeddingService.EMBEDDING_DIMENSIONS;
        embeddingVersion = currentEmbeddingVersion;
      } catch (err) {
        console.error(
          `[auditIndexingService] Embedding failed for domain=${chunk.domain} part=${chunk.partIndex} auditId=${audit.auditId}:`,
          err.message
        );
        result.failed++;

        // Store chunk without embedding for structured fallback and mark failed
        try {
          await AuditEvidenceChunk.findOneAndUpdate(
            chunkIdentity,
            {
              $set: {
                victimId: audit.victimId,
                auditRef: audit._id,
                auditId: audit.auditId,
                domain: chunk.domain,
                partIndex: chunk.partIndex,
                partCount: chunk.partCount,
                timestamp: audit.timestamp || new Date(),
                content: chunk.content,
                sourceFields: chunk.sourceFields,
                sourceSegments: chunk.sourceSegments || [],
                contentHash: hash,
                embedding: null,
                embeddingModel: null,
                embeddingDimensions: null,
                embeddingVersion: null,
                indexingStatus: 'failed',
                indexingError: err.message.substring(0, 500)
              }
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
        chunkIdentity,
        {
          $set: {
            victimId: audit.victimId,
            auditRef: audit._id,
            auditId: audit.auditId,
            domain: chunk.domain,
            partIndex: chunk.partIndex,
            partCount: chunk.partCount,
            timestamp: audit.timestamp || new Date(),
            content: chunk.content,
            sourceFields: chunk.sourceFields,
            sourceSegments: chunk.sourceSegments || [],
            contentHash: hash,
            embedding,
            embeddingModel,
            embeddingDimensions,
            embeddingVersion,
            indexingStatus: vectorEnabled ? 'completed' : 'pending',
            indexingError: null
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      result.indexed++;
    } catch (dbErr) {
      console.error(
        `[auditIndexingService] DB upsert failed for domain=${chunk.domain} part=${chunk.partIndex}:`,
        dbErr.message
      );
      result.failed++;
    }
  }

  // Clean up any stale subchunks if an audit was re-evaluated with fewer parts
  for (const [domain, maxPartCount] of Object.entries(domainPartCounts)) {
    try {
      await AuditEvidenceChunk.deleteMany({
        auditRef: audit._id,
        domain,
        partIndex: { $gte: maxPartCount }
      });
    } catch {
      // Non-critical cleanup
    }
  }

  result.success = result.failed === 0 || result.indexed > 0;
  return result;
}

module.exports = { indexAudit };
