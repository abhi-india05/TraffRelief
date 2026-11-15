'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateSafety } = require('../services/auditEvaluation/safetyEvaluator');
const { validateAndSanitize } = require('../services/auditEvaluation/resultValidator');
const { SYNTHETIC_PATIENT_1_AUDITS } = require('./fixtures/syntheticPatients');

test('E. Gemini Evaluation, Safety & Result Validation Suite', async (t) => {
  const audit3 = SYNTHETIC_PATIENT_1_AUDITS[2]; // has cutting incident

  const validAssembledContext = {
    currentAudit: { auditId: 'AUD-SYN-103' },
    previousAudit: { auditId: 'AUD-SYN-102' },
    baselineAudit: { auditId: 'AUD-SYN-101' },
    retrievalMetadata: {
      retrievalMode: 'hybrid',
      retrievedAuditIds: ['AUD-SYN-101', 'AUD-SYN-102', 'AUD-SYN-103'],
      embeddingModel: 'gemini-embedding-001'
    }
  };

  const sampleValidOutput = {
    domain_evaluations: {
      medical_physical: {
        status: 'improving',
        reasons: ['Physical stamina restored and anemia fully resolved.'],
        evidence: ['AUD-101: fatigue -> AUD-103: normal stamina'],
        evidenceReferences: [
          { auditId: 'AUD-SYN-101', date: '2026-01-10', field: 'currentPhysicalSymptoms', observation: 'Fatigue', sourceType: 'structured' }
        ],
        dataSufficiency: 'sufficient'
      },
      trauma_indicators: {
        status: 'declining',
        reasons: ['Acute trauma spike associated with court proceedings.'],
        evidence: ['AUD-102: superficial scratching -> AUD-103: cutting forearm with paperclip'],
        evidenceReferences: [
          { auditId: 'AUD-SYN-102', date: '2026-02-10', field: 'selfHarmBehaviors', observation: 'Scratching', sourceType: 'safety' },
          { auditId: 'AUD-SYN-103', date: '2026-03-10', field: 'selfHarmBehaviors', observation: 'Cutting forearm', sourceType: 'structured' }
        ],
        dataSufficiency: 'sufficient'
      },
      progress_tracking: {
        status: 'declining',
        reasons: ['Withdrew from group computer classes and missed 3 therapy sessions.'],
        evidence: ['AUD-102: attended 7/8 sessions -> AUD-103: missed 3 sessions'],
        evidenceReferences: [
          { auditId: 'AUD-SYN-102', date: '2026-02-10', field: 'therapyAttendanceRate', observation: 'Attended 7/8', sourceType: 'structured' }
        ],
        dataSufficiency: 'sufficient'
      }
    },
    urgent: true,
    recommended_actions: [
      'Immediate crisis counseling and 1-on-1 safety monitoring.',
      'Urgent psychiatric evaluation for self-harm escalation.'
    ],
    fit_for_discharge: false,
    requires_human_review: true,
    next_audit_date: '2026-03-17',
    retrievalMetadata: { retrievalMode: 'hybrid', evaluationVersion: 'rag-v1' }
  };

  await t.test('1. Valid evaluation with all three domains validates successfully', () => {
    const safety = evaluateSafety(audit3, []);
    const res = validateAndSanitize(sampleValidOutput, validAssembledContext, safety);
    assert.equal(res.valid, true);
    assert.equal(res.result.urgent, true);
    assert.equal(res.result.requires_human_review, true);
    assert.equal(res.result.domain_evaluations.medical_physical.status, 'improving');
    assert.equal(res.result.domain_evaluations.trauma_indicators.status, 'declining');
    assert.equal(res.result.domain_evaluations.progress_tracking.status, 'declining');
  });

  await t.test('2. Hallucinated evidenceReferences (not in context) are stripped with warnings', () => {
    const outputWithHallucinatedAudit = {
      ...sampleValidOutput,
      domain_evaluations: {
        ...sampleValidOutput.domain_evaluations,
        medical_physical: {
          ...sampleValidOutput.domain_evaluations.medical_physical,
          evidenceReferences: [
            { auditId: 'AUD-HALLUCINATED-999', observation: 'Made up record', sourceType: 'structured' },
            { auditId: 'AUD-SYN-101', observation: 'Real record', sourceType: 'structured' }
          ]
        }
      }
    };

    const res = validateAndSanitize(outputWithHallucinatedAudit, validAssembledContext, {});
    assert.equal(res.valid, true);
    // Hallucinated ref is stripped
    const refs = res.result.domain_evaluations.medical_physical.evidenceReferences;
    assert.equal(refs.length, 1);
    assert.equal(refs[0].auditId, 'AUD-SYN-101');
    assert.ok(res.warnings.some(w => w.includes('AUD-HALLUCINATED-999')));
  });

  await t.test('3. Invalid JSON structure is rejected', () => {
    const res1 = validateAndSanitize(null, validAssembledContext, {});
    assert.equal(res1.valid, false);
    const res2 = validateAndSanitize('string instead of object', validAssembledContext, {});
    assert.equal(res2.valid, false);
    const res3 = validateAndSanitize({}, validAssembledContext, {});
    assert.equal(res3.valid, false);
  });

  await t.test('4. Invalid status values are rejected', () => {
    const invalidStatusOutput = {
      ...sampleValidOutput,
      domain_evaluations: {
        ...sampleValidOutput.domain_evaluations,
        medical_physical: {
          ...sampleValidOutput.domain_evaluations.medical_physical,
          status: 'cured_and_happy' // invalid enum
        }
      }
    };
    const res = validateAndSanitize(invalidStatusOutput, validAssembledContext, {});
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('Invalid status')));
  });

  await t.test('5 & 8. Urgent safety flag CANNOT be suppressed by reassuring historical evidence', () => {
    // Current audit has active self-harm (cutting forearm)
    const safety = evaluateSafety(audit3, [{ auditId: 'AUD-OLD', selfHarmBehaviors: 'scratching' }]);
    assert.equal(safety.urgent, true);
    assert.equal(safety.requiresHumanReview, true);

    // Suppose Gemini erroneously said urgent=false and fit_for_discharge=true
    const deceptiveAIOutput = {
      ...sampleValidOutput,
      urgent: false, // AI claimed not urgent
      fit_for_discharge: true
    };

    const validated = validateAndSanitize(deceptiveAIOutput, validAssembledContext, safety);
    // Deterministic safety check overrides AI complacency:
    assert.equal(validated.result.urgent, true, 'Urgent flag must remain true due to cutting pattern');
    assert.equal(validated.result.requires_human_review, true, 'Human review must remain true');
  });

  await t.test('6 & 7. Insufficient history produces insufficient_data status and limited sufficiency', () => {
    const firstAuditOutput = {
      domain_evaluations: {
        medical_physical: { status: 'insufficient_data', reasons: ['Initial audit'], evidence: [], dataSufficiency: 'insufficient' },
        trauma_indicators: { status: 'insufficient_data', reasons: ['Initial audit'], evidence: [], dataSufficiency: 'insufficient' },
        progress_tracking: { status: 'insufficient_data', reasons: ['Initial audit'], evidence: [], dataSufficiency: 'insufficient' }
      },
      urgent: false,
      recommended_actions: ['Establish baseline'],
      fit_for_discharge: false,
      requires_human_review: false,
      next_audit_date: null
    };

    const res = validateAndSanitize(firstAuditOutput, validAssembledContext, {});
    assert.equal(res.valid, true);
    assert.equal(res.result.domain_evaluations.medical_physical.status, 'insufficient_data');
    assert.equal(res.result.domain_evaluations.medical_physical.dataSufficiency, 'insufficient');
  });

  await t.test('9 & 10. Existing historical result format (without new fields) is backward compatible', () => {
    // Legacy format saved before RAG upgrade: no evidenceReferences, no dataSufficiency, no requires_human_review
    const legacyResult = {
      domain_evaluations: {
        medical_physical: { status: 'improving', reasons: ['Physical healing observed'], evidence: ['Good progress'] },
        trauma_indicators: { status: 'no_change', reasons: ['Stable mood'], evidence: ['Consistent baseline'] },
        progress_tracking: { status: 'improving', reasons: ['High attendance'], evidence: ['100% attendance'] }
      },
      urgent: false,
      recommended_actions: ['Continue current regimen'],
      fit_for_discharge: false,
      next_audit_date: '2026-04-01'
    };

    const res = validateAndSanitize(legacyResult, validAssembledContext, {});
    assert.equal(res.valid, true);
    // Defaults safely applied
    assert.equal(res.result.domain_evaluations.medical_physical.dataSufficiency, 'sufficient');
    assert.deepEqual(res.result.domain_evaluations.medical_physical.evidenceReferences, []);
    assert.equal(res.result.requires_human_review, false);
    assert.equal(res.result.retrievalMetadata.retrievalMode, 'hybrid');
  });
});

