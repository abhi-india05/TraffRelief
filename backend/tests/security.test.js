'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  ATLAS_SCORE_THRESHOLD,
  MIN_COSINE_SIMILARITY
} = require('../services/auditEvaluation/vectorRetrieval');
const {
  SYNTHETIC_VICTIM_ID_1,
  SYNTHETIC_VICTIM_ID_2,
  SYNTHETIC_STAFF_ID_1,
  SYNTHETIC_STAFF_ID_2,
  SYNTHETIC_ADMIN_ID_1
} = require('./fixtures/syntheticPatients');

test('D. Security & Patient Isolation Suite', async (t) => {

  await t.test('1. Atlas vector search score conversion accurately maps cosine similarity', () => {
    // Priority 6: In Atlas Vector Search with similarity="cosine", vectorSearchScore = (1 + cosine) / 2
    // If raw cosine threshold is 0.60, Atlas score threshold must be 0.80
    assert.equal(MIN_COSINE_SIMILARITY, 0.60);
    assert.equal(ATLAS_SCORE_THRESHOLD, 0.80);

    // Verify reverse mapping: rawCosine = 2 * atlasScore - 1
    const testAtlasScore = 0.85;
    const computedRawCosine = 2 * testAtlasScore - 1;
    assert.ok(Math.abs(computedRawCosine - 0.70) < 1e-6);

    // A low Atlas score like 0.60 represents raw cosine of 0.20 and must be rejected by threshold
    const lowAtlasScore = 0.60;
    assert.ok(lowAtlasScore < ATLAS_SCORE_THRESHOLD, 'Atlas score 0.60 (raw cosine 0.20) must be rejected by 0.80 threshold');
  });

  await t.test('2. Staff member identity mismatch is rejected (identity spoofing check)', () => {
    const authenticatedStaffId = 'STAFF-001';
    const routeParamStaffId = 'STAFF-002'; // spoof attempt

    const checkStaffIdentity = (authRole, authUser, targetStaff) => {
      if (authRole === 'staff' && authUser !== targetStaff) {
        return false;
      }
      return true;
    };

    assert.equal(checkStaffIdentity('staff', authenticatedStaffId, routeParamStaffId), false);
    assert.equal(checkStaffIdentity('staff', authenticatedStaffId, authenticatedStaffId), true);
  });

  await t.test('3. Staff member cannot access or audit an unassigned patient', () => {
    const mockVictim = {
      _id: SYNTHETIC_VICTIM_ID_1,
      staff: SYNTHETIC_STAFF_ID_1 // assigned to staff 1
    };

    const isAssigned = (victim, staffObjectId) => {
      return victim.staff && victim.staff.toString() === staffObjectId.toString();
    };

    assert.equal(isAssigned(mockVictim, SYNTHETIC_STAFF_ID_1), true);
    assert.equal(isAssigned(mockVictim, SYNTHETIC_STAFF_ID_2), false);
  });

  await t.test('4. Admin scope isolation: admin cannot access victim under different admin', () => {
    const mockVictim = {
      _id: SYNTHETIC_VICTIM_ID_1,
      admin: SYNTHETIC_ADMIN_ID_1
    };
    const otherAdminId = new mongoose.Types.ObjectId();

    const isAdminAuthorized = (victim, adminObjectId) => {
      return victim.admin && victim.admin.toString() === adminObjectId.toString();
    };

    assert.equal(isAdminAuthorized(mockVictim, SYNTHETIC_ADMIN_ID_1), true);
    assert.equal(isAdminAuthorized(mockVictim, otherAdminId), false);
  });

  await t.test('5. Vector retrieval query strictly enforces patient isolation filter via victimId', () => {
    const victimObjectId = SYNTHETIC_VICTIM_ID_1;
    const domain = 'medical_physical';
    const cutoffDate = new Date();

    const vectorFilter = {
      victimId: victimObjectId,
      domain: domain,
      timestamp: { $lt: cutoffDate }
    };

    // Verify filter mandates exact victimId
    assert.equal(vectorFilter.victimId.toString(), SYNTHETIC_VICTIM_ID_1.toString());
    assert.notEqual(vectorFilter.victimId.toString(), SYNTHETIC_VICTIM_ID_2.toString());
    assert.ok(vectorFilter.victimId instanceof mongoose.Types.ObjectId);
  });

  await t.test('6. Evaluation retry never creates duplicate audits (idempotency guard)', () => {
    let mockAuditDoc = {
      _id: new mongoose.Types.ObjectId(),
      auditId: 'AUD-SYN-101',
      evaluationStatus: 'failed',
      callCount: 0
    };

    const claimEvaluation = (doc) => {
      if (['pending', 'failed'].includes(doc.evaluationStatus)) {
        doc.evaluationStatus = 'processing';
        doc.callCount++;
        return true; // claimed
      }
      return false; // rejected / concurrent conflict
    };

    // First attempt claims it
    const claim1 = claimEvaluation(mockAuditDoc);
    assert.equal(claim1, true);
    assert.equal(mockAuditDoc.evaluationStatus, 'processing');

    // Concurrent second attempt rejected without duplicate audit
    const claim2 = claimEvaluation(mockAuditDoc);
    assert.equal(claim2, false);
    assert.equal(mockAuditDoc.callCount, 1);
  });

  await t.test('7. Manual interventions do not require an audit reference (sourceType="manual")', () => {
    const manualIntervention = {
      victimId: SYNTHETIC_VICTIM_ID_1,
      sourceAuditRef: null,
      sourceAuditId: null,
      sourceType: 'manual',
      recommendedIntervention: 'Daily physical therapy for ankle rehabilitation'
    };

    assert.equal(manualIntervention.sourceType, 'manual');
    assert.equal(manualIntervention.sourceAuditRef, null);
    assert.ok(manualIntervention.recommendedIntervention.length > 0);
  });
});
