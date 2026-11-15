'use strict';
const Audit = require('../../models/audit');
const RehabilitationIntervention = require('../../models/rehabilitationIntervention');

const RECENT_COUNT = parseInt(process.env.RAG_RECENT_AUDIT_COUNT || '5', 10);

/**
 * Retrieve bounded structured historical context for a victim's audit.
 * Employs bounded queries at the database level to prevent memory exhaustion
 * on long-stay patients with hundreds of audits.
 *
 * @param {ObjectId} victimObjectId - victim's MongoDB _id
 * @param {ObjectId} currentAuditObjectId - current audit _id (excluded from history)
 * @param {Date} currentAuditTimestamp - current audit creation time
 * @returns {Promise<Object>} structured retrieval result
 */
async function retrieveStructuredContext(victimObjectId, currentAuditObjectId, currentAuditTimestamp) {
  const baseFilter = {
    victimId: victimObjectId,
    _id: { $ne: currentAuditObjectId },
    timestamp: { $lt: currentAuditTimestamp }
  };

  // 1. Total prior audit count (bounded count query)
  const totalHistorical = await Audit.countDocuments(baseFilter);

  // 2. Previous (immediately prior) audit
  const previousAuditDoc = await Audit.findOne(baseFilter)
    .sort({ timestamp: -1 })
    .lean();

  // 3. Baseline (earliest) intake audit
  const baselineAuditDoc = await Audit.findOne(baseFilter)
    .sort({ timestamp: 1 })
    .lean();

  // Check if baseline and previous are identical document
  const isSameDoc = previousAuditDoc && baselineAuditDoc &&
    previousAuditDoc._id.toString() === baselineAuditDoc._id.toString();
  const baselineAudit = isSameDoc ? null : baselineAuditDoc;

  // 4. Recent N audits (excluding current), bounded by RECENT_COUNT
  const recentChronologicalDocs = await Audit.find(baseFilter)
    .sort({ timestamp: -1 })
    .limit(RECENT_COUNT)
    .lean();
  const recentChronological = recentChronologicalDocs.reverse(); // chronological order (oldest first)

  // 5. Critical safety historical records - bounded deterministic query (limit 10)
  const criticalSafetyDocs = await Audit.find({
    ...baseFilter,
    $or: [
      { selfHarmBehaviors: { $exists: true, $nin: [null, '', 'None', 'No self-harm', 'No self-harm behavior observed', 'none', 'N/A', 'n/a'] } },
      { 'result.urgent': true },
      { setbacksIndicator: { $regex: /severe|crisis|urgent|critical|emergency|deteriorat/i } },
      { traumaIndicators: { $regex: /severe|acute|crisis|flashback/i } }
    ]
  })
    .sort({ timestamp: -1 })
    .limit(10)
    .lean();

  // 6. Rehabilitation Interventions lifecycle (active and recent, limit 10)
  const interventionDocs = await RehabilitationIntervention.find({ victimId: victimObjectId })
    .sort({ dateRecommended: -1 })
    .limit(10)
    .lean();

  const formattedInterventions = interventionDocs.map(i => ({
    id: i._id.toString(),
    sourceType: i.sourceType || 'audit_recommendation',
    sourceAuditId: i.sourceAuditId || null,
    recommendedIntervention: i.recommendedIntervention,
    status: i.status,
    dateRecommended: i.dateRecommended,
    dateImplemented: i.dateImplemented,
    observedOutcome: i.observedOutcome,
    staffNotes: i.staffNotes
  }));

  // 7. Previous AI evaluations (most recent 3 with generatedResults)
  const previousEvaluationDocs = await Audit.find({
    ...baseFilter,
    generatedResults: true,
    result: { $ne: null }
  })
    .sort({ timestamp: -1 })
    .limit(3)
    .lean();

  const previousEvaluations = previousEvaluationDocs.map(a => ({
    auditId: a.auditId,
    timestamp: a.timestamp,
    result: {
      domain_evaluations: a.result?.domain_evaluations,
      urgent: a.result?.urgent,
      recommended_actions: a.result?.recommended_actions,
      fit_for_discharge: a.result?.fit_for_discharge
    }
  }));

  // Deduplicated auditIds retrieved across all structured queries
  const retrievedIdSet = new Set();
  if (previousAuditDoc?.auditId) retrievedIdSet.add(previousAuditDoc.auditId);
  if (baselineAudit?.auditId) retrievedIdSet.add(baselineAudit.auditId);
  recentChronological.forEach(a => { if (a.auditId) retrievedIdSet.add(a.auditId); });
  criticalSafetyDocs.forEach(a => { if (a.auditId) retrievedIdSet.add(a.auditId); });

  return {
    previousAudit: sanitizeAudit(previousAuditDoc),
    baselineAudit: sanitizeAudit(baselineAudit),
    recentChronologicalHistory: recentChronological.map(sanitizeAudit),
    criticalSafetyAudits: criticalSafetyDocs.map(sanitizeAudit),
    rehabilitationInterventions: formattedInterventions,
    previousAIRecommendations: previousEvaluations,
    totalHistoricalAudits: totalHistorical,
    isFirstAudit: totalHistorical === 0,
    retrievedAuditIds: Array.from(retrievedIdSet)
  };
}

/** Remove ObjectIds and internal metadata before passing to evaluation */
function sanitizeAudit(audit) {
  if (!audit) return null;
  const { _id, victimId, submittedBy, __v, ...rest } = audit;
  return rest;
}

module.exports = { retrieveStructuredContext };
