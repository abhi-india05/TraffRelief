'use strict';
const Audit = require('../../models/audit');
const RehabilitationIntervention = require('../../models/rehabilitationIntervention');
const { evaluateSafety } = require('./safetyEvaluator');

const RECENT_COUNT = parseInt(process.env.RAG_RECENT_AUDIT_COUNT || '5', 10);

/**
 * Retrieve bounded structured historical context for a victim's audit.
 * Employs bounded queries at the database level to prevent memory exhaustion
 * on long-stay patients with hundreds of audits.
 *
 * Implements strict temporal cutoff to prevent future intervention or audit leakage,
 * and deterministic safety classification to prevent negative findings from being
 * counted as positive safety emergencies.
 *
 * @param {ObjectId} victimObjectId - victim's MongoDB _id
 * @param {ObjectId} currentAuditObjectId - current audit _id (excluded from history)
 * @param {Date} currentAuditTimestamp - current audit creation time
 * @returns {Promise<Object>} structured retrieval result
 */
async function retrieveStructuredContext(victimObjectId, currentAuditObjectId, currentAuditTimestamp) {
  const currentCutoff = new Date(currentAuditTimestamp);
  const baseFilter = {
    victimId: victimObjectId,
    _id: { $ne: currentAuditObjectId },
    timestamp: { $lt: currentCutoff }
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

  // 5. Historical safety records & timeline construction using deterministic safety evaluator
  // Query candidates with candidate text before current cutoff
  const candidateSafetyDocs = await Audit.find({
    ...baseFilter,
    $or: [
      { selfHarmBehaviors: { $exists: true, $nin: [null, ''] } },
      { 'result.urgent': true },
      { setbacksIndicator: { $exists: true, $nin: [null, ''] } },
      { traumaIndicators: { $exists: true, $nin: [null, ''] } }
    ]
  })
    .sort({ timestamp: -1 })
    .limit(50)
    .lean();

  const safetyTimeline = [];
  const positiveSafetyAudits = [];
  let totalPositiveEvents = 0;
  let totalHistoricalContext = 0;
  let totalDocumentedNegatives = 0;

  for (const doc of candidateSafetyDocs) {
    const safety = evaluateSafety(doc, []);
    const docDate = doc.timestamp || doc.createdAt;

    // Check acute findings on that date
    if (safety.safetyTimeline.acuteFindings.length > 0) {
      totalPositiveEvents++;
      positiveSafetyAudits.push(doc);
      for (const finding of safety.safetyTimeline.acuteFindings) {
        safetyTimeline.push({
          auditId: doc.auditId,
          timestamp: docDate,
          field: finding.field,
          observation: finding.clause,
          classification: 'positive_event'
        });
      }
    }

    // Check historical context findings on that date
    if (safety.safetyTimeline.historicalFindings.length > 0) {
      totalHistoricalContext++;
      if (!positiveSafetyAudits.some(a => a.auditId === doc.auditId)) {
        positiveSafetyAudits.push(doc);
      }
      for (const finding of safety.safetyTimeline.historicalFindings) {
        safetyTimeline.push({
          auditId: doc.auditId,
          timestamp: docDate,
          field: finding.field,
          observation: finding.clause,
          classification: 'historical_context'
        });
      }
    }

    // Check moderate findings
    if (safety.safetyTimeline.moderateFindings.length > 0) {
      for (const finding of safety.safetyTimeline.moderateFindings) {
        safetyTimeline.push({
          auditId: doc.auditId,
          timestamp: docDate,
          field: finding.field,
          observation: finding.clause,
          classification: 'moderate_concern'
        });
      }
    }

    // Check documented negative findings (e.g. "No self-harm observed")
    // Recorded for context but NOT marked as positive safety alarms
    if (safety.safetyTimeline.negativeFindings.length > 0) {
      totalDocumentedNegatives++;
      for (const finding of safety.safetyTimeline.negativeFindings) {
        safetyTimeline.push({
          auditId: doc.auditId,
          timestamp: docDate,
          field: finding.field,
          observation: finding.clause,
          classification: 'documented_negative'
        });
      }
    }
  }

  // Sort timeline chronologically (oldest to newest)
  safetyTimeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Limit positiveSafetyAudits to most relevant (up to 15) without silent data loss
  const boundedSafetyAudits = positiveSafetyAudits.slice(0, 15);

  // 6. Rehabilitation Interventions lifecycle (STRICT TEMPORAL CUTOFF)
  // Only retrieve interventions recommended on or before the current audit timestamp
  const interventionDocs = await RehabilitationIntervention.find({
    victimId: victimObjectId,
    dateRecommended: { $lte: currentCutoff }
  })
    .sort({ dateRecommended: -1 })
    .limit(15)
    .lean();

  const formattedInterventions = interventionDocs.map(i => {
    let effectiveStatus = i.status;
    let effectiveDateImplemented = i.dateImplemented;
    let effectiveFollowUpAuditId = i.followUpAuditId;

    // Temporal protection: if implementation or follow-up occurred after currentAuditTimestamp,
    // do not leak future completion status into this historical evaluation
    if (effectiveDateImplemented && new Date(effectiveDateImplemented) > currentCutoff) {
      effectiveDateImplemented = null;
      effectiveFollowUpAuditId = null;
      if (effectiveStatus === 'completed') {
        effectiveStatus = 'in_progress';
      }
    }

    return {
      id: i._id.toString(),
      sourceType: i.sourceType || 'audit_recommendation',
      sourceAuditId: i.sourceAuditId || null,
      recommendedIntervention: i.recommendedIntervention,
      status: effectiveStatus,
      dateRecommended: i.dateRecommended,
      dateImplemented: effectiveDateImplemented,
      followUpAuditId: effectiveFollowUpAuditId,
      observedOutcome: effectiveDateImplemented ? i.observedOutcome : null,
      staffNotes: i.staffNotes
    };
  });

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
  boundedSafetyAudits.forEach(a => { if (a.auditId) retrievedIdSet.add(a.auditId); });
  safetyTimeline.forEach(t => { if (t.auditId) retrievedIdSet.add(t.auditId); });

  return {
    previousAudit: sanitizeAudit(previousAuditDoc),
    baselineAudit: sanitizeAudit(baselineAudit),
    recentChronologicalHistory: recentChronological.map(sanitizeAudit),
    criticalSafetyAudits: boundedSafetyAudits.map(sanitizeAudit),
    safetyTimeline,
    safetyMetrics: {
      totalEventsEvaluated: safetyTimeline.length,
      totalPositiveEvents,
      totalHistoricalContext,
      totalDocumentedNegatives
    },
    rehabilitationInterventions: formattedInterventions,
    previousAIRecommendations: previousEvaluations,
    totalHistoricalAudits: totalHistorical,
    isFirstAudit: totalHistorical === 0,
    retrievedAuditIds: Array.from(retrievedIdSet)
  };
}

/** Remove internal DB metadata before passing to evaluation */
function sanitizeAudit(audit) {
  if (!audit) return null;
  const { victimId, submittedBy, __v, ...rest } = audit;
  return rest;
}

module.exports = { retrieveStructuredContext };
