'use strict';
const mongoose = require('mongoose');

const sourceSegmentSchema = new mongoose.Schema({
  field: { type: String, required: true },
  text: { type: String, required: true },
  segmentIndex: { type: Number, default: 0 }
}, { _id: false });

const auditEvidenceChunkSchema = new mongoose.Schema({
  victimId: { type: mongoose.Schema.Types.ObjectId, ref: 'Victim', required: true, index: true },
  auditRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true },
  auditId: { type: String, required: true },
  domain: { type: String, required: true, enum: ['medical_physical', 'trauma_indicators', 'progress_tracking'] },
  partIndex: { type: Number, required: true, default: 0 },
  partCount: { type: Number, required: true, default: 1 },
  timestamp: { type: Date, required: true },
  content: { type: String, required: true },
  sourceFields: [{ type: String }],
  sourceSegments: [sourceSegmentSchema],
  embedding: { type: [Number], default: null },
  embeddingModel: { type: String, default: null },
  embeddingDimensions: { type: Number, default: null },
  embeddingVersion: { type: String, default: null },
  contentHash: { type: String, required: true },
  indexingStatus: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  indexingError: { type: String, default: null }
}, { timestamps: true });

// Compound unique: exactly one chunk document per (auditRef + domain + partIndex)
auditEvidenceChunkSchema.index(
  { auditRef: 1, domain: 1, partIndex: 1 },
  { unique: true }
);

// Index for vector search filtering
auditEvidenceChunkSchema.index({ victimId: 1, domain: 1, timestamp: -1 });

// Index for idempotent lookup by contentHash
auditEvidenceChunkSchema.index({ contentHash: 1 });

module.exports = mongoose.model('AuditEvidenceChunk', auditEvidenceChunkSchema);
