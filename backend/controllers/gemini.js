'use strict';
require('dotenv').config();

const Audit = require('../models/audit');
const Staff = require('../models/staff');
const Admin = require('../models/admin');
const Victim = require('../models/victim');
const { runEvaluationPipeline } = require('../services/auditEvaluation/auditEvaluationService');

/**
 * Controller middleware for audit evaluation during initial audit submission.
 * Receives the newly persisted audit via res.locals.audit.
 * Preserves the audit even if AI evaluation fails.
 */
async function evaluateAudit(req, res) {
  try {
    const currentAudit = res.locals.audit;
    if (!currentAudit) {
      return res.status(400).json({ error: 'No audit available for evaluation' });
    }

    const pipelineResult = await runEvaluationPipeline(currentAudit);

    if (!pipelineResult.success) {
      // Audit was saved by addAudit, but AI evaluation failed
      // Return 202 Accepted or 200 with partial status so frontend knows audit is saved
      return res.status(200).json({
        message: 'Audit saved successfully, but AI evaluation encountered an issue and can be retried.',
        audit: pipelineResult.audit || currentAudit,
        evaluationStatus: 'failed',
        error: pipelineResult.error
      });
    }

    return res.status(200).json({
      message: pipelineResult.note || 'AI evaluation completed successfully',
      audit: pipelineResult.audit,
      evaluation: pipelineResult.evaluation
    });

  } catch (err) {
    console.error('[controllers/gemini] Unexpected error in evaluateAudit:', err);
    return res.status(500).json({
      error: err.message,
      message: 'Audit was saved, but evaluation service failed unexpectedly'
    });
  }
}

/**
 * Controller to retry evaluation for an existing audit without creating a new audit.
 * Route: POST /staff/audit/:auditId/retry-evaluation or /admin/audit/:auditId/retry-evaluation
 */
async function retryAuditEvaluation(req, res) {
  try {
    const { auditId } = req.params;
    const { id: userId, role } = req.user || {};

    if (!auditId) {
      return res.status(400).json({ error: 'auditId parameter is required' });
    }

    const audit = await Audit.findOne({ auditId }).populate('victimId');
    if (!audit) {
      return res.status(404).json({ error: 'Audit not found' });
    }

    // Role-based authorization
    if (role === 'staff') {
      const staff = await Staff.findOne({ staffId: userId });
      if (!staff) {
        return res.status(403).json({ error: 'Staff account not found' });
      }
      const victim = audit.victimId;
      if (!victim || victim.staff?.toString() !== staff._id.toString()) {
        return res.status(403).json({ error: 'You are not assigned to this victim' });
      }
    } else if (role === 'admin') {
      const admin = await Admin.findOne({ adminId: userId });
      if (!admin) {
        return res.status(403).json({ error: 'Admin account not found' });
      }
      const victim = audit.victimId;
      if (!victim || victim.admin?.toString() !== admin._id.toString()) {
        return res.status(403).json({ error: 'Victim does not belong to your administrative center' });
      }
    } else {
      return res.status(403).json({ error: 'Unauthorized role' });
    }

    // Reset status to pending so runEvaluationPipeline can claim it
    await Audit.findByIdAndUpdate(audit._id, { $set: { evaluationStatus: 'pending' } });
    audit.evaluationStatus = 'pending';

    const pipelineResult = await runEvaluationPipeline(audit);

    if (!pipelineResult.success) {
      return res.status(500).json({
        message: 'Evaluation retry failed',
        error: pipelineResult.error,
        audit: pipelineResult.audit || audit
      });
    }

    return res.status(200).json({
      message: 'Evaluation retry completed successfully',
      audit: pipelineResult.audit,
      evaluation: pipelineResult.evaluation
    });

  } catch (err) {
    console.error('[controllers/gemini] Error in retryAuditEvaluation:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { evaluateAudit, retryAuditEvaluation };
