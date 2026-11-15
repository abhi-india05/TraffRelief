'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  ATLAS_SCORE_THRESHOLD,
  MIN_COSINE_SIMILARITY,
  retrieveByDomain
} = require('../services/auditEvaluation/vectorRetrieval');
const { assertGeminiDataAccess } = require('../services/geminiPrivacyPolicy');
const AuditEvidenceChunk = require('../models/auditEvidenceChunk');
const Victim = require('../models/victim');
const Staff = require('../models/staff');
const Admin = require('../models/admin');
const Audit = require('../models/audit');
const Release = require('../models/release');
const RehabilitationIntervention = require('../models/rehabilitationIntervention');

const {
  createIntervention,
  updateIntervention
} = require('../controllers/intervention');
const {
  viewReleaseResults
} = require('../controllers/release');

const {
  SYNTHETIC_VICTIM_ID_1,
  SYNTHETIC_VICTIM_ID_2,
  SYNTHETIC_STAFF_ID_1,
  SYNTHETIC_STAFF_ID_2,
  SYNTHETIC_ADMIN_ID_1
} = require('./fixtures/syntheticPatients');

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    }
  };
  return res;
}

test('D. Security & Patient Isolation Suite', async (t) => {

  await t.test('1. Atlas vector search score conversion accurately maps cosine similarity', () => {
    assert.equal(MIN_COSINE_SIMILARITY, 0.60);
    assert.equal(ATLAS_SCORE_THRESHOLD, 0.80);

    const testAtlasScore = 0.85;
    const computedRawCosine = 2 * testAtlasScore - 1;
    assert.ok(Math.abs(computedRawCosine - 0.70) < 1e-6);

    const lowAtlasScore = 0.60;
    assert.ok(lowAtlasScore < ATLAS_SCORE_THRESHOLD, 'Atlas score 0.60 (raw cosine 0.20) must be rejected by 0.80 threshold');
  });

  await t.test('2. Vector search pipeline construction strictly enforces patient isolation, thresholds, and domain filters', async () => {
    const originalEnabled = process.env.RAG_VECTOR_SEARCH_ENABLED;
    const originalAggregate = AuditEvidenceChunk.aggregate;
    const embeddingService = require('../services/auditEvaluation/embeddingService');
    const originalEmbedQuery = embeddingService.embedQuery;

    process.env.RAG_VECTOR_SEARCH_ENABLED = 'true';
    embeddingService.embedQuery = async () => Array(768).fill(0.05);

    let capturedPipeline = null;
    AuditEvidenceChunk.aggregate = async (pipeline) => {
      capturedPipeline = pipeline;
      return [];
    };

    try {
      const victimOid = new mongoose.Types.ObjectId(SYNTHETIC_VICTIM_ID_1);
      const currentAuditOid = new mongoose.Types.ObjectId();
      const cutoffTime = new Date('2026-03-01T00:00:00Z');
      const testAudit = { currentPhysicalSymptoms: 'Severe joint pain and dizziness' };

      await retrieveByDomain('medical_physical', testAudit, victimOid, currentAuditOid, cutoffTime, {
        dataClassification: 'synthetic',
        databaseName: 'traffrelief_synthetic'
      });

      assert.ok(capturedPipeline, 'Atlas aggregate pipeline should be executed');

      // Check step 0: $vectorSearch
      const vectorStep = capturedPipeline[0].$vectorSearch;
      assert.ok(vectorStep, '$vectorSearch step must be present');
      assert.equal(vectorStep.filter.victimId.toString(), victimOid.toString(), 'Patient isolation filter must match target victimId');
      assert.equal(vectorStep.filter.domain, 'medical_physical');
      assert.deepEqual(vectorStep.filter.timestamp, { $lt: cutoffTime });

      // Check step 3: Atlas threshold match
      const thresholdMatch = capturedPipeline.find(step => step.$match && step.$match.atlasScore);
      assert.ok(thresholdMatch, 'Pipeline must filter by atlasScore threshold');
      assert.equal(thresholdMatch.$match.atlasScore.$gte, ATLAS_SCORE_THRESHOLD);

      // Check step 4: Exclude current audit
      const excludeCurrentMatch = capturedPipeline.find(step => step.$match && step.$match.auditRef);
      assert.ok(excludeCurrentMatch, 'Pipeline must exclude current auditRef');
      assert.deepEqual(excludeCurrentMatch.$match.auditRef, { $ne: currentAuditOid });

      // Check step 6: Projection preserves required traceability fields
      const projectStep = capturedPipeline.find(step => step.$project);
      assert.ok(projectStep, 'Pipeline must project fields');
      assert.equal(projectStep.$project.embedding, 0);
      assert.equal(projectStep.$project.victimId, 0);

    } finally {
      process.env.RAG_VECTOR_SEARCH_ENABLED = originalEnabled;
      AuditEvidenceChunk.aggregate = originalAggregate;
      embeddingService.embedQuery = originalEmbedQuery;
    }
  });

  await t.test('3. Actual Express handler: Staff member cannot create intervention for unassigned patient', async () => {
    const origVictimFindOne = Victim.findOne;
    const origStaffFindOne = Staff.findOne;

    Victim.findOne = async () => ({
      _id: new mongoose.Types.ObjectId(SYNTHETIC_VICTIM_ID_1),
      victimId: 'VIC-SYN-001',
      staff: new mongoose.Types.ObjectId(SYNTHETIC_STAFF_ID_1) // Assigned to Staff 1
    });

    Staff.findOne = async () => ({
      _id: new mongoose.Types.ObjectId(SYNTHETIC_STAFF_ID_2), // Different staff ID
      staffId: 'STAFF-002'
    });

    try {
      const req = {
        params: { victimId: 'VIC-SYN-001' },
        user: { id: 'STAFF-002', role: 'staff' },
        body: { recommendedIntervention: 'Daily physical therapy' }
      };
      const res = mockRes();

      await createIntervention(req, res);
      assert.equal(res.statusCode, 403);
      assert.ok(res.body.error.includes('not assigned to this victim'));
    } finally {
      Victim.findOne = origVictimFindOne;
      Staff.findOne = origStaffFindOne;
    }
  });

  await t.test('4. Actual Express handler: Cross-victim sourceAuditId in createIntervention is strictly rejected', async () => {
    const origVictimFindOne = Victim.findOne;
    const origStaffFindOne = Staff.findOne;
    const origAuditFindOne = Audit.findOne;

    const assignedStaffOid = new mongoose.Types.ObjectId(SYNTHETIC_STAFF_ID_1);
    const targetVictimOid = new mongoose.Types.ObjectId(SYNTHETIC_VICTIM_ID_1);
    const differentVictimOid = new mongoose.Types.ObjectId(SYNTHETIC_VICTIM_ID_2);

    Victim.findOne = async () => ({
      _id: targetVictimOid,
      victimId: 'VIC-SYN-001',
      staff: assignedStaffOid
    });

    Staff.findOne = async () => ({
      _id: assignedStaffOid,
      staffId: 'STAFF-001'
    });

    // Audit belongs to a DIFFERENT victim
    Audit.findOne = async () => ({
      _id: new mongoose.Types.ObjectId(),
      auditId: 'AUD-DIFFERENT-PATIENT',
      victimId: differentVictimOid
    });

    try {
      const req = {
        params: { victimId: 'VIC-SYN-001' },
        user: { id: 'STAFF-001', role: 'staff' },
        body: {
          recommendedIntervention: 'Medication management',
          sourceAuditId: 'AUD-DIFFERENT-PATIENT'
        }
      };
      const res = mockRes();

      await createIntervention(req, res);
      assert.equal(res.statusCode, 400);
      assert.ok(res.body.error.includes('does not belong to victim'));
    } finally {
      Victim.findOne = origVictimFindOne;
      Staff.findOne = origStaffFindOne;
      Audit.findOne = origAuditFindOne;
    }
  });

  await t.test('5. Actual Express handler: Modifying immutable fields in updateIntervention is rejected', async () => {
    const origInterventionFindById = RehabilitationIntervention.findById;
    const origVictimFindById = Victim.findById;
    const origStaffFindOne = Staff.findOne;

    const staffOid = new mongoose.Types.ObjectId(SYNTHETIC_STAFF_ID_1);
    const victimOid = new mongoose.Types.ObjectId(SYNTHETIC_VICTIM_ID_1);

    RehabilitationIntervention.findById = () => ({
      populate: () => ({
        populate: () => ({
          populate: async () => ({
            _id: new mongoose.Types.ObjectId(),
            victimId: victimOid,
            status: 'recommended',
            save: async () => {}
          })
        })
      })
    });

    Victim.findById = async () => ({
      _id: victimOid,
      staff: staffOid
    });

    Staff.findOne = async () => ({
      _id: staffOid,
      staffId: 'STAFF-001'
    });

    try {
      // Attempt to reassign intervention to another victim
      const req = {
        params: { id: new mongoose.Types.ObjectId().toString() },
        user: { id: 'STAFF-001', role: 'staff' },
        body: { victimId: new mongoose.Types.ObjectId().toString() }
      };
      const res = mockRes();

      await updateIntervention(req, res);
      assert.equal(res.statusCode, 400);
      assert.ok(res.body.error.includes('immutable'));
    } finally {
      RehabilitationIntervention.findById = origInterventionFindById;
      Victim.findById = origVictimFindById;
      Staff.findOne = origStaffFindOne;
    }
  });

  await t.test('6. Actual Express handler: viewReleaseResults verifies staff authorization', async () => {
    const origReleaseFindOne = Release.findOne;
    const origStaffFindOne = Staff.findOne;

    const staffOid1 = new mongoose.Types.ObjectId(SYNTHETIC_STAFF_ID_1);
    const staffOid2 = new mongoose.Types.ObjectId(SYNTHETIC_STAFF_ID_2);

    Release.findOne = () => ({
      populate: () => ({
        populate: async () => ({
          _id: new mongoose.Types.ObjectId(),
          hashLink: 'test-hash-link',
          submitted: true,
          victimId: {
            _id: new mongoose.Types.ObjectId(SYNTHETIC_VICTIM_ID_1),
            staff: staffOid1 // Assigned to Staff 1
          },
          staffId: {
            _id: staffOid1
          }
        })
      })
    });

    Staff.findOne = async () => ({
      _id: staffOid2, // Authenticated user is Staff 2
      staffId: 'STAFF-002'
    });

    try {
      const req = {
        params: { hashId: 'test-hash-link' },
        user: { id: 'STAFF-002', role: 'staff' }
      };
      const res = mockRes();

      await viewReleaseResults(req, res);
      assert.equal(res.statusCode, 403);
      assert.ok(res.body.error.includes('not assigned to this victim'));
    } finally {
      Release.findOne = origReleaseFindOne;
      Staff.findOne = origStaffFindOne;
    }
  });

  await t.test('7. Centralized privacy policy: Cross-patient data leakage detection in source records', () => {
    const originalTier = process.env.GEMINI_API_TIER;
    const originalAllow = process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA;
    const originalKey = process.env.GEMINI_API_KEY;

    try {
      process.env.GEMINI_API_KEY = 'mock_key_for_testing';
      process.env.GEMINI_API_TIER = 'free';
      process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA = 'true';

      const patient1Oid = new mongoose.Types.ObjectId(SYNTHETIC_VICTIM_ID_1);
      const patient2Oid = new mongoose.Types.ObjectId(SYNTHETIC_VICTIM_ID_2);

      const mixedSourceRecords = [
        { auditId: 'AUD-P1-01', victimId: patient1Oid, dataClassification: 'synthetic' },
        { auditId: 'AUD-P2-01', victimId: patient2Oid, dataClassification: 'synthetic' } // Leakage!
      ];

      assert.throws(
        () => assertGeminiDataAccess({
          operation: 'test_isolation',
          dataClassification: 'synthetic',
          databaseName: 'traffrelief_synthetic',
          patientId: patient1Oid,
          sourceRecords: mixedSourceRecords
        }),
        /Cross-patient data leakage detected/
      );
    } finally {
      process.env.GEMINI_API_TIER = originalTier;
      process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA = originalAllow;
      process.env.GEMINI_API_KEY = originalKey;
    }
  });
});
