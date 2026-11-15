'use strict';
const Audit = require('../../models/audit');
const { retrieveStructuredContext } = require('./structuredRetrieval');
const { retrieveSemanticContext } = require('./vectorRetrieval');
const { assembleContext } = require('./contextAssembler');
const { evaluateWithContext } = require('./geminiEvaluator');
const { validateAndSanitize } = require('./resultValidator');
const { evaluateSafety } = require('./safetyEvaluator');
const { indexAudit } = require('./auditIndexingService');

/**
 * Run the full hybrid RAG evaluation pipeline for a saved audit.
 * Idempotent — can be safely retried if a previous attempt failed.
 * Never creates or duplicates the audit document.
 *
 * @param {Object} audit - Mongoose document or plain object with _id, victimId, auditId
 * @returns {Promise<{ success: boolean, audit: Object, evaluation?: Object, error?: string, note?: string }>}
 */
async function runEvaluationPipeline(audit) {
  const auditId = audit.auditId;

  // --- Concurrency guard: atomically claim processing status ---
  const claimed = await Audit.findOneAndUpdate(
    { _id: audit._id, evaluationStatus: { $in: ['pending', 'failed'] } },
    { $set: { evaluationStatus: 'processing', evaluationError: null } },
    { new: true }
  );

  if (!claimed) {
    // Already processing or completed
    const current = await Audit.findById(audit._id).lean();
    return {
      success: current?.evaluationStatus === 'completed',
      audit: current,
      note: current?.evaluationStatus === 'completed'
        ? 'Audit already evaluated'
        : 'Evaluation already in progress by another worker'
    };
  }

  try {
    const auditPlain = audit.toObject ? audit.toObject() : audit;

    // --- CASE 1: First audit (Baseline) ---
    // If patient has no prior history, produce a baseline evaluation without fabricating longitudinal comparisons
    if (auditPlain.isFirst) {
      const baselineResult = {
        domain_evaluations: {
          medical_physical: {
            status: 'insufficient_data',
            reasons: ['Initial baseline assessment — longitudinal comparison requires subsequent follow-up assessments.'],
            evidence: ['Initial intake assessment recorded.'],
            evidenceReferences: [],
            dataSufficiency: 'insufficient'
          },
          trauma_indicators: {
            status: 'insufficient_data',
            reasons: ['Initial baseline assessment — longitudinal trauma trajectory cannot be determined from a single audit.'],
            evidence: ['Initial trauma markers documented.'],
            evidenceReferences: [],
            dataSufficiency: 'insufficient'
          },
          progress_tracking: {
            status: 'insufficient_data',
            reasons: ['Initial baseline assessment — rehabilitation progress tracking commences with subsequent audits.'],
            evidence: ['Initial rehabilitation plan established.'],
            evidenceReferences: [],
            dataSufficiency: 'insufficient'
          }
        },
        urgent: false,
        recommended_actions: [
          'Establish multidisciplinary rehabilitation care plan.',
          'Schedule first follow-up assessment within 14–30 days.'
        ],
        fit_for_discharge: false,
        requires_human_review: false,
        next_audit_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        retrievalMetadata: {
          retrievalMode: 'structured_only',
          retrievedAuditIds: [auditId],
          evaluationVersion: 'rag-v1'
        }
      };

      // Perform deterministic safety check even on first audit
      const safetyResult = evaluateSafety(auditPlain, []);
      if (safetyResult.urgent) baselineResult.urgent = true;
      if (safetyResult.requiresHumanReview) baselineResult.requires_human_review = true;

      // Index initial audit so it can serve as baseline for future audits
      await indexAudit(auditPlain).catch(err => {
        console.warn(`[auditEvaluationService] Indexing baseline audit ${auditId} warning:`, err.message);
      });

      await Audit.findByIdAndUpdate(audit._id, {
        $set: {
          result: baselineResult,
          generatedResults: true,
          evaluationStatus: 'completed',
          evaluationVersion: 'rag-v1',
          indexingStatus: 'completed'
        }
      });

      const updated = await Audit.findById(audit._id).lean();
      return {
        success: true,
        audit: updated,
        evaluation: baselineResult,
        note: 'Baseline evaluation established for first audit'
      };
    }

    // --- CASE 2: Longitudinal Audit (Subsequent) ---

    // Step 1: Idempotent indexing of current audit chunks
    let indexingStatus = 'completed';
    let indexingError = null;
    try {
      const indexResult = await indexAudit(auditPlain);
      if (indexResult.failed > 0) {
        indexingStatus = 'failed';
        indexingError = `${indexResult.failed} chunk(s) failed indexing`;
      }
    } catch (idxErr) {
      indexingStatus = 'failed';
      indexingError = idxErr.message;
      console.warn(`[auditEvaluationService] Indexing error for audit ${auditId}:`, idxErr.message);
    }

    // Step 2: Structured retrieval from MongoDB (mandatory: baseline, previous, recent N, critical safety)
    const currentTimestamp = auditPlain.timestamp || auditPlain.createdAt || new Date();
    const structuredContext = await retrieveStructuredContext(
      auditPlain.victimId,
      audit._id,
      currentTimestamp
    );

    // Step 3: Semantic retrieval via Atlas Vector Search (graceful fallback if disabled/unavailable)
    const semanticContext = await retrieveSemanticContext(
      auditPlain,
      auditPlain.victimId,
      audit._id,
      currentTimestamp
    );

    // Step 4: Assemble RAG context with deduplication and context budgeting
    const assembledContext = assembleContext(auditPlain, structuredContext, semanticContext);

    // Step 5: Deterministic safety evaluation (safety rules override AI findings)
    const safetyEvaluation = evaluateSafety(auditPlain, structuredContext.criticalSafetyAudits || []);

    // Step 6: Evidence-grounded Gemini longitudinal evaluation
    const rawAIEvaluation = await evaluateWithContext(assembledContext);

    // Step 7: Strict schema & evidence reference validation
    const validation = validateAndSanitize(rawAIEvaluation, assembledContext, safetyEvaluation);
    if (!validation.valid) {
      throw new Error(`Evaluation schema validation failed: ${validation.errors.join('; ')}`);
    }

    // Step 8: Persist validated evaluation
    await Audit.findByIdAndUpdate(audit._id, {
      $set: {
        result: validation.result,
        generatedResults: true,
        evaluationStatus: 'completed',
        evaluationVersion: 'rag-v1',
        evaluationError: null,
        indexingStatus,
        indexingError
      }
    });

    const updated = await Audit.findById(audit._id).lean();
    return {
      success: true,
      audit: updated,
      evaluation: validation.result,
      warnings: validation.warnings
    };

  } catch (err) {
    console.error(`[auditEvaluationService] Evaluation pipeline failed for audit ${auditId}:`, err.message);

    // Preserve the original audit, record the failure status
    await Audit.findByIdAndUpdate(audit._id, {
      $set: {
        evaluationStatus: 'failed',
        evaluationError: err.message.substring(0, 1000)
      }
    }).catch(() => {});

    return {
      success: false,
      audit: await Audit.findById(audit._id).lean().catch(() => null),
      error: err.message
    };
  }
}

module.exports = { runEvaluationPipeline };

