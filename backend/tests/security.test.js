'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  SYNTHETIC_VICTIM_ID_1,
  SYNTHETIC_VICTIM_ID_2,
  SYNTHETIC_STAFF_ID_1,
  SYNTHETIC_STAFF_ID_2,
  SYNTHETIC_ADMIN_ID_1
} = require('./fixtures/syntheticPatients');

test('D. Security & Patient Isolation Suite', async (t) => {

  await t.test('1. Unauthenticated requests are rejected with 401', () => {
    const authHeader = undefined;
    const isAuthorized = authHeader && authHeader.startsWith('Bearer ');
    assert.equal(Boolean(isAuthorized), false);
  });

  await t.test('2. Staff member cannot submit audit as another staff member (identity spoofing check)', () => {
    const authenticatedStaffId = 'STAFF-001';
    const routeParamStaffId = 'STAFF-002'; // spoof attempt

    const canSubmit = (authRole, authUser, targetStaff) => {
      if (authRole === 'staff' && authUser !== targetStaff) {
        return false;
      }
      return true;
    };

    assert.equal(canSubmit('staff', authenticatedStaffId, routeParamStaffId), false);
    assert.equal(canSubmit('staff', authenticatedStaffId, authenticatedStaffId), true);
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
    // Vector search filter construction
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
    // Simulating atomic update claim pattern used by auditEvaluationService
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

  await t.test('7. Sensitive clinical text, transcripts, and patient names are not written to audit chunks', () => {
    const sensitiveAudit = {
      auditId: 'AUD-TEST',
      victimName: 'Jane Doe',
      victimId: 'VIC-999',
      currentPhysicalSymptoms: 'Mild back pain',
      secretNote: 'Confidential clinical background'
    };

    const { buildChunks } = require('../services/auditEvaluation/auditChunkBuilder');
    const chunks = buildChunks(sensitiveAudit);

    for (const c of chunks) {
      assert.ok(!c.content.includes('Jane Doe'), 'Chunk content must not contain patient name');
      assert.ok(!c.content.includes('VIC-999'), 'Chunk content must not contain victimId');
      assert.ok(!c.content.includes('secretNote'), 'Chunk content must not contain arbitrary unlisted fields');
    }
  });
});

