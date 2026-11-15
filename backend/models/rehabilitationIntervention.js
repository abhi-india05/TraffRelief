'use strict';
const mongoose = require('mongoose');

const rehabilitationInterventionSchema = new mongoose.Schema({
  victimId: { type: mongoose.Schema.Types.ObjectId, ref: 'Victim', required: true, index: true },
  sourceAuditRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', default: null },
  sourceAuditId: { type: String, default: null },
  sourceType: {
    type: String,
    enum: ['audit_recommendation', 'manual'],
    default: 'audit_recommendation'
  },
  recommendedIntervention: { type: String, required: true },
  status: {
    type: String,
    enum: ['recommended', 'accepted', 'in_progress', 'completed', 'not_implemented', 'discontinued'],
    default: 'recommended'
  },
  staffResponsible: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', default: null },
  dateRecommended: { type: Date, required: true, default: Date.now },
  dateImplemented: { type: Date, default: null },
  followUpAuditRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', default: null },
  followUpAuditId: { type: String, default: null },
  observedOutcome: { type: String, default: null },
  staffNotes: { type: String, default: null }
}, { timestamps: true });

rehabilitationInterventionSchema.index({ victimId: 1, status: 1 });
rehabilitationInterventionSchema.index({ sourceAuditRef: 1 });

module.exports = mongoose.model('RehabilitationIntervention', rehabilitationInterventionSchema);
