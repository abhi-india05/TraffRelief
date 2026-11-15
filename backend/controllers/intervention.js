'use strict';
const RehabilitationIntervention = require('../models/rehabilitationIntervention');
const Victim = require('../models/victim');
const Staff = require('../models/staff');
const Admin = require('../models/admin');
const Audit = require('../models/audit');

/**
 * Get all interventions for a victim with strict authorization.
 * Route: GET /staff/interventions/:victimId or GET /admin/interventions/:victimId
 */
async function getVictimInterventions(req, res) {
  try {
    const { victimId } = req.params;
    const { id: authUserId, role: authRole } = req.user || {};

    if (!victimId) return res.status(400).json({ error: 'victimId parameter is required' });

    const victim = await Victim.findOne({ victimId });
    if (!victim) return res.status(404).json({ error: 'Victim not found' });

    // Authorization: staff assigned or center admin
    if (authRole === 'staff') {
      const staff = await Staff.findOne({ staffId: authUserId });
      if (!staff || victim.staff?.toString() !== staff._id.toString()) {
        return res.status(403).json({ error: 'You are not assigned to this victim' });
      }
    } else if (authRole === 'admin') {
      const admin = await Admin.findOne({ adminId: authUserId });
      if (!admin || victim.admin?.toString() !== admin._id.toString()) {
        return res.status(403).json({ error: 'Victim not under your administrative center' });
      }
    } else {
      return res.status(403).json({ error: 'Unauthorized role' });
    }

    const interventions = await RehabilitationIntervention.find({ victimId: victim._id })
      .populate('staffResponsible', 'fullName staffId')
      .populate('sourceAuditRef', 'auditId timestamp')
      .populate('followUpAuditRef', 'auditId timestamp')
      .sort({ dateRecommended: -1 })
      .lean();

    return res.status(200).json({ interventions });
  } catch (err) {
    console.error('[controllers/intervention] Error getting interventions:', err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * Create a new rehabilitation intervention record (manual or audit-recommended).
 * Route: POST /staff/interventions/:victimId or POST /admin/interventions/:victimId
 */
async function createIntervention(req, res) {
  try {
    const { victimId } = req.params;
    const { id: authUserId, role: authRole } = req.user || {};
    const {
      sourceAuditId,
      sourceType,
      recommendedIntervention,
      status,
      staffNotes,
      dateRecommended
    } = req.body;

    if (!recommendedIntervention || recommendedIntervention.trim() === '') {
      return res.status(400).json({ error: 'recommendedIntervention is required' });
    }

    const victim = await Victim.findOne({ victimId });
    if (!victim) return res.status(404).json({ error: 'Victim not found' });

    let staff = null;
    if (authRole === 'staff') {
      staff = await Staff.findOne({ staffId: authUserId });
      if (!staff || victim.staff?.toString() !== staff._id.toString()) {
        return res.status(403).json({ error: 'You are not assigned to this victim' });
      }
    } else if (authRole === 'admin') {
      const admin = await Admin.findOne({ adminId: authUserId });
      if (!admin || victim.admin?.toString() !== admin._id.toString()) {
        return res.status(403).json({ error: 'Victim not under your administrative center' });
      }
    } else {
      return res.status(403).json({ error: 'Unauthorized role' });
    }

    let auditRef = null;
    let auditIdStr = null;
    let determinedSourceType = sourceType === 'manual' ? 'manual' : 'audit_recommendation';

    if (sourceAuditId && sourceAuditId !== 'MANUAL') {
      const audit = await Audit.findOne({ auditId: sourceAuditId });
      if (audit) {
        auditRef = audit._id;
        auditIdStr = audit.auditId;
        determinedSourceType = 'audit_recommendation';
      }
    } else {
      determinedSourceType = 'manual';
    }

    const intervention = new RehabilitationIntervention({
      victimId: victim._id,
      sourceAuditRef: auditRef,
      sourceAuditId: auditIdStr,
      sourceType: determinedSourceType,
      recommendedIntervention: recommendedIntervention.trim(),
      status: status || 'recommended',
      staffResponsible: staff ? staff._id : (victim.staff || null),
      dateRecommended: dateRecommended ? new Date(dateRecommended) : new Date(),
      staffNotes: staffNotes ? staffNotes.trim() : null
    });

    await intervention.save();
    return res.status(201).json({ message: 'Intervention created successfully', intervention });
  } catch (err) {
    console.error('[controllers/intervention] Error creating intervention:', err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * Update an existing intervention status/outcome with strict authorization.
 * Route: PATCH /staff/interventions/:interventionId or PATCH /admin/interventions/:interventionId
 */
async function updateIntervention(req, res) {
  try {
    const { interventionId } = req.params;
    const { id: authUserId, role: authRole } = req.user || {};
    const { status, observedOutcome, staffNotes, dateImplemented, followUpAuditId } = req.body;

    const intervention = await RehabilitationIntervention.findById(interventionId);
    if (!intervention) return res.status(404).json({ error: 'Intervention not found' });

    // Look up victim to enforce patient authorization
    const victim = await Victim.findById(intervention.victimId);
    if (!victim) return res.status(404).json({ error: 'Associated victim record not found' });

    if (authRole === 'staff') {
      const staff = await Staff.findOne({ staffId: authUserId });
      if (!staff || victim.staff?.toString() !== staff._id.toString()) {
        return res.status(403).json({ error: 'You are not assigned to this victim' });
      }
    } else if (authRole === 'admin') {
      const admin = await Admin.findOne({ adminId: authUserId });
      if (!admin || victim.admin?.toString() !== admin._id.toString()) {
        return res.status(403).json({ error: 'Victim not under your administrative center' });
      }
    } else {
      return res.status(403).json({ error: 'Unauthorized role' });
    }

    const updates = {};
    if (status) updates.status = status;
    if (observedOutcome !== undefined) updates.observedOutcome = observedOutcome;
    if (staffNotes !== undefined) updates.staffNotes = staffNotes;
    if (dateImplemented) updates.dateImplemented = new Date(dateImplemented);
    if (followUpAuditId) {
      updates.followUpAuditId = followUpAuditId;
      const followUpAudit = await Audit.findOne({ auditId: followUpAuditId });
      if (followUpAudit) updates.followUpAuditRef = followUpAudit._id;
    }

    const updated = await RehabilitationIntervention.findByIdAndUpdate(
      interventionId,
      { $set: updates },
      { new: true }
    );

    return res.status(200).json({ message: 'Intervention updated', intervention: updated });
  } catch (err) {
    console.error('[controllers/intervention] Error updating intervention:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { getVictimInterventions, createIntervention, updateIntervention };
