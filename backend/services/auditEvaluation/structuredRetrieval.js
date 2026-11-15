'use strict';
const Audit = require('../../models/audit');

const RECENT_COUNT = parseInt(process.env.RAG_RECENT_AUDIT_COUNT || '5', 10);

/**
 * Retrieve structured historical context for a victim's audit.
 * @param {ObjectId} victimObjectId - victim's MongoDB _id
 * @param {ObjectId} currentAuditObjectId - current audit _id (excluded from history)
 * @param {Date} currentAuditTimestamp - current audit creation time
 * @returns {Promise<Object>} structured retrieval result
 */
async function retrieveStructuredContext(victimObjectId, currentAuditObjectId, currentAuditTimestamp) {
  // All audits for this victim BEFORE the current one, newest first
  const allPrior = await Audit.find({
    victimId: victimObjectId,
    _id: { $ne: currentAuditObjectId },
    timestamp: { $lt: currentAuditTimestamp }
  })
    .sort({ timestamp: -1 })
    .lean();

  const totalHistorical = allPrior.length;

  // Previous (immediately prior) audit
  const previousAudit = allPrior[0] || null;

  // Baseline (earliest) audit - last in the array since sorted desc
  const baselineAudit = allPrior.length > 0 ? allPrior[allPrior.length - 1] : null;

  // Recent N audits (excluding current and not already counted)
  // If previous and baseline are same record (only 1 prior), handle gracefully
  const recentChronological = allPrior
    .slice(0, RECENT_COUNT)
    .reverse(); // oldest first for chronological display

  // Critical safety historical records - deterministic field-based retrieval
  // These are retrieved REGARDLESS of vector similarity
  const criticalSafetyAudits = await Audit.find({
    victimId: victimObjectId,
    _id: { $ne: currentAuditObjectId },
    timestamp: { $lt: currentAuditTimestamp },
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

  // Previous AI-generated evaluations (most recent 3)
  const previousEvaluations = allPrior
    .filter(a => a.generatedResults && a.result)
    .slice(0, 3)
    .map(a => ({
      auditId: a.auditId,
      timestamp: a.timestamp,
      result: {
        domain_evaluations: a.result?.domain_evaluations,
        urgent: a.result?.urgent,
        recommended_actions: a.result?.recommended_actions,
        fit_for_discharge: a.result?.fit_for_discharge
      }
    }));

  return {
    previousAudit: sanitizeAudit(previousAudit),
    baselineAudit: sanitizeAudit(baselineAudit === previousAudit ? null : baselineAudit),
    recentChronologicalHistory: recentChronological.map(sanitizeAudit),
    criticalSafetyAudits: criticalSafetyAudits.map(sanitizeAudit),
    previousAIRecommendations: previousEvaluations,
    totalHistoricalAudits: totalHistorical,
    isFirstAudit: totalHistorical === 0,
    retrievedAuditIds: [
      ...(previousAudit ? [previousAudit.auditId] : []),
      ...(baselineAudit && baselineAudit !== previousAudit ? [baselineAudit.auditId] : []),
      ...recentChronological.map(a => a.auditId),
      ...criticalSafetyAudits.map(a => a.auditId)
    ].filter((v, i, arr) => arr.indexOf(v) === i) // deduplicate
  };
}

/** Remove ObjectIds and other internal fields before passing to AI */
function sanitizeAudit(audit) {
  if (!audit) return null;
  const { _id, victimId, submittedBy, __v, ...rest } = audit;
  return rest;
}

module.exports = { retrieveStructuredContext };
