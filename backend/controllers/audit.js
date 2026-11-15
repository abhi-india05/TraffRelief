'use strict';
const Audit = require('../models/audit');
const Staff = require('../models/staff');
const Victim = require('../models/victim');
const ActivityLog = require('../models/activityLog');
const Admin = require('../models/admin');

async function addAudit(req, res, next) {
  try {
    const { staffId, victimId } = req.params;
    const { id: authUserId, role: authRole } = req.user || {};

    if (!authRole || (authRole !== 'staff' && authRole !== 'admin')) {
      return res.status(403).json({ error: 'Unauthorized role' });
    }

    if (!staffId || !victimId) {
      return res
        .status(400)
        .json({ error: 'staffId and victimId parameters are required' });
    }

    if (authRole === 'staff' && authUserId !== staffId) {
      return res
        .status(403)
        .json({ error: 'Staff member identity mismatch' });
    }

    const staff = await Staff.findOne({ staffId: staffId });
    if (!staff) {
      return res.status(404).json({ error: 'Staff not found' });
    }

    const victim = await Victim.findOne({ victimId });
    if (!victim) {
      return res.status(404).json({ error: 'Victim not found' });
    }

    // Verify patient assignment
    if (authRole === 'staff') {
      const isAssigned = victim.staff && victim.staff.toString() === staff._id.toString();
      if (!isAssigned) {
        return res
          .status(403)
          .json({ error: 'You are not assigned to this victim' });
      }
    } else if (authRole === 'admin') {
      const admin = await Admin.findOne({ adminId: authUserId });
      if (!admin || !victim.admin || victim.admin.toString() !== admin._id.toString()) {
        return res
          .status(403)
          .json({ error: 'Victim is not under your administrative scope' });
      }
    }

    // Generate a new sequential auditId
    let newAuditId = 'AUD-101';
    const lastAudit = await Audit.findOne().sort({ _id: -1 });

    if (lastAudit && lastAudit.auditId) {
      const parts = String(lastAudit.auditId).split('-');
      const lastNum = parseInt(parts[1], 10) || 100;
      newAuditId = `AUD-${lastNum + 1}`;
    }

    req.body.submittedBy = staff._id;
    req.body.victimId = victim._id;
    req.body.auditId = newAuditId;
    req.body.result = null;

    const allAudits = await Audit.find({ victimId: victim._id });
    if (allAudits.length === 0) {
      req.body.isFirst = true;
    } else {
      req.body.isFirst = false;
    }

    let attempts = 0;
    let newAudit = null;
    while (attempts < 5) {
      try {
        req.body.auditId = newAuditId;
        const candidate = new Audit(req.body);
        newAudit = await candidate.save();
        break;
      } catch (err) {
        if (
          err &&
          err.code === 11000 &&
          err.keyPattern &&
          err.keyPattern.auditId
        ) {
          const latest = await Audit.findOne().sort({ _id: -1 });
          const parts =
            latest && latest.auditId
              ? String(latest.auditId).split('-')
              : [null, '100'];
          const lastNum = parseInt(parts[1], 10) || 100;
          newAuditId = `AUD-${lastNum + 1}`;
          attempts++;
          continue;
        }
        throw err;
      }
    }

    if (!newAudit) {
      console.error('Failed to create audit after retries');
      return res
        .status(500)
        .json({ error: 'Could not create audit, please retry' });
    }

    await ActivityLog.create({
      staffId: staff._id,
      adminId: victim.admin || null,
      activity: 'Audit Submitted',
      description: `Audit ${newAudit.auditId} submitted by ${staff.fullName} for victim ${victim.fullName} (${victim.victimId})`,
      timestamp: new Date(),
      readStatus: false,
    });

    res.locals.audit = newAudit;
    return next();
  } catch (error) {
    console.error('Error adding audit:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get pending audits scoped strictly to the requesting user's assigned victims or center.
 */
async function getPendingAudits(req, res) {
  try {
    const { id: authUserId, role: authRole } = req.user || {};
    if (!authUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let victimFilter = {};

    if (authRole === 'staff') {
      const staff = await Staff.findOne({ staffId: authUserId });
      if (!staff) return res.status(404).json({ error: 'Staff not found' });

      const assignedVictims = await Victim.find({
        staff: staff._id,
        status: { $ne: 'released' }
      }).select('_id');
      const victimIds = assignedVictims.map(v => v._id);
      victimFilter = { victimId: { $in: victimIds } };

    } else if (authRole === 'admin') {
      const admin = await Admin.findOne({ adminId: authUserId });
      if (!admin) return res.status(404).json({ error: 'Admin not found' });

      const centerVictims = await Victim.find({
        admin: admin._id,
        status: { $ne: 'released' }
      }).select('_id');
      const victimIds = centerVictims.map(v => v._id);
      victimFilter = { victimId: { $in: victimIds } };

    } else {
      return res.status(403).json({ error: 'Unauthorized role' });
    }

    const now = new Date();

    const auditsWithField = await Audit.find({
      ...victimFilter,
      'result.next_audit_date': { $exists: true, $ne: null },
    })
      .populate('victimId', 'victimId _id status isActive fullName')
      .sort({ 'result.next_audit_date': 1 })
      .lean();

    const pending = auditsWithField.filter((a) => {
      const raw = a.result?.next_audit_date;
      if (!raw) return false;
      const d = new Date(raw);
      if (isNaN(d) || d > now) return false;

      const v = a.victimId;
      if (!v) return false;
      const activeByFlag = v.isActive !== false;
      const activeByStatus = v.status
        ? v.status.toLowerCase() !== 'released'
        : true;
      return activeByFlag && activeByStatus;
    });

    return res.status(200).json(pending);
  } catch (error) {
    console.error('Error retrieving pending audits:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get audit summary list for a specific victim, enforcing assignment/center isolation.
 */
async function getAuditsByVictimId(req, res) {
  try {
    const { victimId } = req.params;
    const { id: authUserId, role: authRole } = req.user || {};

    if (!victimId) {
      return res.status(400).json({ error: 'victimId parameter is required' });
    }

    const victim = await Victim.findOne({ victimId });
    if (!victim) return res.status(404).json({ error: 'Victim not found' });

    // Authorization check
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

    const audits = await Audit.find({ victimId: victim._id })
      .populate({
        path: 'submittedBy',
        model: 'Staff',
        select: 'fullName staffId',
      })
      .sort({ timestamp: -1, _id: -1 })
      .lean();

    const list = audits.map((a) => ({
      auditId: a.auditId,
      date: a.timestamp || a.createdAt || null,
      evaluationStatus: a.evaluationStatus || 'completed',
      urgent: a.result?.urgent || false,
      staffName:
        (a.submittedBy && (a.submittedBy.fullName || a.submittedBy.staffId)) ||
        'Unknown',
    }));

    return res.status(200).json({ audits: list });
  } catch (error) {
    console.error('Error retrieving victim audits:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get detailed audit record with strict authorization against the patient record.
 */
async function getAuditDetails(req, res) {
  try {
    const { auditId } = req.params;
    const { id: authUserId, role: authRole } = req.user || {};

    if (!auditId) {
      return res.status(400).json({ error: 'auditId parameter is required' });
    }

    let audit;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(auditId);
    if (isObjectId) {
      audit = await Audit.findById(auditId).populate('victimId');
    } else {
      audit = await Audit.findOne({ auditId }).populate('victimId');
    }

    if (!audit) {
      return res.status(404).json({ error: 'Audit not found' });
    }

    const victim = audit.victimId;
    if (!victim) {
      return res.status(404).json({ error: 'Associated victim not found' });
    }

    // Role-based patient isolation check
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

    return res.status(200).json(audit);
  } catch (error) {
    console.error('Error retrieving audit details:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get audits submitted by a specific staff member.
 */
async function getAuditByStaff(req, res) {
  try {
    const { staffId } = req.params;
    const { id: authUserId, role: authRole } = req.user || {};

    if (!staffId) {
      return res.status(400).json({ error: 'staffId parameter is required' });
    }

    const targetStaff = await Staff.findOne({ staffId });
    if (!targetStaff) {
      return res.status(404).json({ error: 'Staff not found' });
    }

    // Requester must be the staff member or their center admin
    if (authRole === 'staff' && authUserId !== staffId) {
      return res.status(403).json({ error: 'Unauthorized to view another staff member\'s audits' });
    } else if (authRole === 'admin') {
      const admin = await Admin.findOne({ adminId: authUserId });
      if (!admin || targetStaff.centre?.toString() !== admin.centre?.toString()) {
        return res.status(403).json({ error: 'Staff member is not in your administrative center' });
      }
    }

    const audits = await Audit.find({ submittedBy: targetStaff._id })
      .populate('victimId', 'victimId fullName')
      .sort({ timestamp: -1 })
      .limit(100)
      .lean();

    return res.status(200).json(audits);
  } catch (error) {
    console.error('Error retrieving audits by staff:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get all audits scoped to admin center with bounded pagination.
 */
async function getAllAudits(req, res) {
  try {
    const { id: authUserId, role: authRole } = req.user || {};

    if (authRole !== 'admin') {
      return res.status(403).json({ error: 'Only administrators may access the complete audit register' });
    }

    const admin = await Admin.findOne({ adminId: authUserId });
    if (!admin) {
      return res.status(404).json({ error: 'Admin account not found' });
    }

    // Scope to victims under this admin
    const centerVictims = await Victim.find({ admin: admin._id }).select('_id');
    const victimIds = centerVictims.map(v => v._id);

    const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);

    const audits = await Audit.find({ victimId: { $in: victimIds } })
      .populate('victimId', 'victimId fullName')
      .populate('submittedBy', 'fullName staffId')
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json(audits);
  } catch (error) {
    console.error('Error retrieving all audits:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function getVictimAuditHistory(req, res) {
  try {
    const { victimId } = req.params;
    const { role, id } = req.user || {};

    if (!victimId) {
      return res.status(400).json({ error: 'victimId is required' });
    }

    const victim = await Victim.findOne({ victimId });
    if (!victim) {
      return res.status(404).json({ error: 'Victim not found' });
    }

    if (role === 'staff') {
      const staff = await Staff.findOne({ staffId: id });
      if (!staff) {
        return res.status(404).json({ error: 'Staff not found' });
      }
      const isAssigned = victim.staff?.toString() === staff._id.toString();
      if (!isAssigned) {
        return res
          .status(403)
          .json({ error: 'You can only view your assigned victims' });
      }
    } else if (role === 'admin') {
      const admin = await Admin.findOne({ adminId: id });
      if (!admin) {
        return res.status(404).json({ error: 'Admin not found' });
      }
      if (victim.admin?.toString() !== admin._id.toString()) {
        return res
          .status(403)
          .json({ error: 'Victim not under your management' });
      }
    } else {
      return res.status(403).json({ error: 'Unauthorized role' });
    }

    const audits = await Audit.find({ victimId: victim._id })
      .sort({ timestamp: 1 })
      .select(
        'auditId timestamp ' +
          'nutritionalStatus ' +
          'selfHarmBehaviors ' +
          'therapyAttendanceRate treatmentCompliance goalAchievementProgress ' +
          'trustAndRelationshipIssues emotionalRegulationChallenges ' +
          'behavioralImprovements skillDevelopmentMilestones ' +
          'setbacksIndicator medicationAdherence ' +
          'currentPhysicalSymptoms physicalInjuriesSustained ' +
          'traumaIndicators depressionSymptoms anxietyIndicators ' +
          'result evaluationStatus generatedResults'
      )
      .lean();

    return res.status(200).json({
      victimId: victim.victimId,
      victimName: victim.fullName,
      audits,
    });
  } catch (error) {
    console.error('Error retrieving victim audit history:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  addAudit,
  getAuditsByVictimId,
  getAllAudits,
  getAuditDetails,
  getAuditByStaff,
  getPendingAudits,
  getVictimAuditHistory,
};
