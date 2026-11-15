'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateSafety } = require('../services/auditEvaluation/safetyEvaluator');
const { validateAndSanitize } = require('../services/auditEvaluation/resultValidator');
const { SYNTHETIC_PATIENT_1_AUDITS } = require('./fixtures/syntheticPatients');

test('E. Gemini Evaluation, Safety & Result Validation Suite', async (t) => {
  const audit3 = SYNTHETIC_PATIENT_1_AUDITS[2]; // has cutting incident

  const validAssembledContext = {
    currentAudit: {
      auditId: 'AUD-SYN-103',
      selfHarmBehaviors: 'Superficial cutting on left forearm with paperclip observed.'
    },
    previousAudit: {
      auditId: 'AUD-SYN-102',
      therapyAttendanceRate: 'Attended 7/8 therapy sessions regularly.'
    },
    baselineAudit: {
      auditId: 'AUD-SYN-101',
      currentPhysicalSymptoms: 'Severe fatigue, headaches, and dizziness.'
    },
    totalHistoricalAudits: 2,
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
          { auditId: 'AUD-SYN-101', date: '2026-01-10', field: 'currentPhysicalSymptoms', observation: 'fatigue headaches', sourceType: 'structured' }
        ],
        dataSufficiency: 'sufficient'
      },
      trauma_indicators: {
        status: 'declining',
        reasons: ['Acute trauma spike associated with court proceedings.'],
        evidence: ['AUD-102: superficial scratching -> AUD-103: cutting forearm with paperclip'],
        evidenceReferences: [
          { auditId: 'AUD-SYN-103', date: '2026-03-10', field: 'selfHarmBehaviors', observation: 'cutting on left forearm', sourceType: 'structured' }
        ],
        dataSufficiency: 'sufficient'
      },
      progress_tracking: {
        status: 'declining',
        reasons: ['Withdrew from group computer classes and missed 3 therapy sessions.'],
        evidence: ['AUD-102: attended 7/8 sessions -> AUD-103: missed 3 sessions'],
        evidenceReferences: [
          { auditId: 'AUD-SYN-102', date: '2026-02-10', field: 'therapyAttendanceRate', observation: 'Attended 7/8 therapy sessions', sourceType: 'structured' }
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

  await t.test('2. Hallucinated or ungrounded evidenceReferences are stripped with warnings', () => {
    const outputWithBadRefs = {
      ...sampleValidOutput,
      domain_evaluations: {
        ...sampleValidOutput.domain_evaluations,
        medical_physical: {
          ...sampleValidOutput.domain_evaluations.medical_physical,
          evidenceReferences: [
            { auditId: 'AUD-HALLUCINATED-999', observation: 'Made up record', sourceType: 'structured' },
            { auditId: 'AUD-SYN-101', field: 'currentPhysicalSymptoms', observation: 'totally fabricated bone fractures', sourceType: 'structured' },
            { auditId: 'AUD-SYN-101', field: 'currentPhysicalSymptoms', observation: 'fatigue headaches', sourceType: 'structured' }
          ]
        }
      }
    };

    const res = validateAndSanitize(outputWithBadRefs, validAssembledContext, {});
    assert.equal(res.valid, true);
    const refs = res.result.domain_evaluations.medical_physical.evidenceReferences;
    // Both hallucinated auditId and ungrounded observation are stripped; only grounded ref remains
    assert.equal(refs.length, 1);
    assert.equal(refs[0].auditId, 'AUD-SYN-101');
    assert.ok(res.warnings.some(w => w.includes('AUD-HALLUCINATED-999')));
    assert.ok(res.warnings.some(w => w.includes('failed grounding check')));
  });

  await t.test('3. Negation handling: "no self-harm" and "denies suicidal ideation" do NOT trigger urgent', () => {
    const negativeAudit = {
      auditId: 'AUD-NEG',
      selfHarmBehaviors: 'No self-harm behavior observed. Patient denies suicidal ideation.',
      traumaIndicators: 'Mild anxiety, negative for panic attacks.'
    };
    const safety = evaluateSafety(negativeAudit, []);
    assert.equal(safety.urgent, false, 'Documented negative findings must NOT trigger urgent=true');
    assert.equal(safety.currentRiskLevel, 'none');
    assert.ok(safety.safetyTimeline.negativeFindings.length >= 2, 'Negative findings must be recorded in timeline');
  });

  await t.test('4. Historical qualification: past suicide attempt does NOT trigger current acute urgency', () => {
    const historicalAudit = {
      auditId: 'AUD-HIST',
      selfHarmBehaviors: 'History of cutting wrists prior to intake, currently fully resolved. Old scars visible.',
      traumaIndicators: 'Calm mood.'
    };
    const safety = evaluateSafety(historicalAudit, []);
    assert.equal(safety.urgent, false, 'Historical resolved risk must NOT trigger urgent=true');
    assert.equal(safety.requiresHumanReview, true, 'Historical risk flags for clinical review');
    assert.ok(safety.safetyTimeline.historicalFindings.length >= 1, 'Historical finding must be recorded in timeline');
  });

  await t.test('5 & 8. Urgent safety flag overrides AI and FORCES fit_for_discharge=false', () => {
    const acuteAudit = {
      auditId: 'AUD-ACUTE',
      selfHarmBehaviors: 'Active suicidal ideation expressed. Staff intercepted scissors.'
    };
    const safety = evaluateSafety(acuteAudit, []);
    assert.equal(safety.urgent, true);

    // AI hallucinates fit_for_discharge: true and urgent: false
    const deceptiveAIOutput = {
      ...sampleValidOutput,
      urgent: false,
      fit_for_discharge: true
    };

    const validated = validateAndSanitize(deceptiveAIOutput, validAssembledContext, safety);
    assert.equal(validated.result.urgent, true, 'Deterministic safety overrides AI urgent flag');
    assert.equal(validated.result.fit_for_discharge, false, 'Discharge invariant: acute patient is NEVER fit for discharge');
    assert.equal(validated.result.requires_human_review, true);
  });

  await t.test('6 & 7. First-audit produces insufficient_data status and insufficient dataSufficiency', () => {
    const firstAuditOutput = {
      domain_evaluations: {
        medical_physical: { status: 'insufficient_data', reasons: ['Initial audit'], evidence: [], dataSufficiency: 'sufficient' },
        trauma_indicators: { status: 'insufficient_data', reasons: ['Initial audit'], evidence: [], dataSufficiency: 'sufficient' },
        progress_tracking: { status: 'insufficient_data', reasons: ['Initial audit'], evidence: [], dataSufficiency: 'sufficient' }
      },
      urgent: false,
      recommended_actions: ['Establish baseline'],
      fit_for_discharge: false,
      requires_human_review: false,
      next_audit_date: null
    };

    const firstAuditContext = { isFirstAudit: true, totalHistoricalAudits: 0 };
    const res = validateAndSanitize(firstAuditOutput, firstAuditContext, {});
    assert.equal(res.valid, true);
    // Strict rule: first audit dataSufficiency is forced to 'insufficient'
    assert.equal(res.result.domain_evaluations.medical_physical.dataSufficiency, 'insufficient');
  });

  await t.test('9 & 10. Existing historical result format (without new fields) is backward compatible', () => {
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
    assert.equal(res.result.domain_evaluations.medical_physical.dataSufficiency, 'insufficient');
    assert.deepEqual(res.result.domain_evaluations.medical_physical.evidenceReferences, []);
    assert.equal(res.result.requires_human_review, false);
    assert.equal(res.result.retrievalMetadata.retrievalMode, 'hybrid');
  });
});
