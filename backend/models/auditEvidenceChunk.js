const mongoose = require('mongoose');
const crypto = require('crypto');

const auditEvidenceChunkSchema = new mongoose.Schema({
  victimId: { type: mongoose.Schema.Types.ObjectId, ref: 'Victim', required: true, index: true },
  auditRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true },
  auditId: { type: String, required: true },
  domain: { type: String, required: true, enum: ['medical_physical', 'trauma_indicators', 'progress_tracking'] },
  timestamp: { type: Date, required: true },
  content: { type: String, required: true },
  sourceFields: [{ type: String }],
  embedding: { type: [Number], default: null },
  embeddingModel: { type: String, default: null },
  embeddingDimensions: { type: Number, default: null },
  embeddingVersion: { type: String, default: null },
  contentHash: { type: String, required: true },
  indexingStatus: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  indexingError: { type: String, default: null }
}, { timestamps: true });

// Compound unique: one chunk per audit+domain+embeddingVersion
auditEvidenceChunkSchema.index(
  { auditRef: 1, domain: 1, embeddingVersion: 1 },
  { unique: true, sparse: true }
);
// Index for vector search filtering
auditEvidenceChunkSchema.index({ victimId: 1, domain: 1, timestamp: -1 });
// Index for idempotent upsert by contentHash
auditEvidenceChunkSchema.index({ contentHash: 1 });

module.exports = mongoose.model('AuditEvidenceChunk', auditEvidenceChunkSchema);
