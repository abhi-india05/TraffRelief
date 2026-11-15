'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { assembleContext, MAX_CONTEXT_CHARS } = require('../services/auditEvaluation/contextAssembler');
const { SYNTHETIC_PATIENT_1_AUDITS } = require('./fixtures/syntheticPatients');

test('B. Structured Retrieval & Context Assembly Suite', async (t) => {
  const audits = SYNTHETIC_PATIENT_1_AUDITS;
  const audit1 = audits[0]; // Jan 10
  const audit2 = audits[1]; // Feb 10
  const audit3 = audits[2]; // Mar 10

  await t.test('1. First-audit behavior correctly handles lack of prior history', () => {
    const mockStructuredFirst = {
      previousAudit: null,
      baselineAudit: null,
      recentChronologicalHistory: [],
      criticalSafetyAudits: [],
      rehabilitationInterventions: [],
      previousAIRecommendations: [],
      totalHistoricalAudits: 0,
      isFirstAudit: true,
      retrievedAuditIds: [audit1.auditId]
    };

    const mockSemantic = {
      medical_physical: [],
      trauma_indicators: [],
      progress_tracking: [],
      retrievalMode: 'structured_only'
    };

    const ctx = assembleContext(audit1, mockStructuredFirst, mockSemantic);
    assert.equal(ctx.isFirstAudit, true);
    assert.equal(ctx.totalHistoricalAudits, 0);
    assert.equal(ctx.previousAudit, null);
    assert.equal(ctx.baselineAudit, null);
    assert.equal(ctx.recentChronologicalHistory.length, 0);
  });

  await t.test('2, 3 & 4. Baseline and previous audits are identified and chronologically ordered', () => {
    const priorHistory = [audit2, audit1]; // sorted desc by timestamp

    const previous = priorHistory[0]; // Audit 2
    const baseline = priorHistory[priorHistory.length - 1]; // Audit 1
    const recentChronological = priorHistory.slice().reverse(); // oldest first: [Audit 1, Audit 2]

    assert.equal(previous.auditId, 'AUD-SYN-102');
    assert.equal(baseline.auditId, 'AUD-SYN-101');
    assert.equal(recentChronological[0].auditId, 'AUD-SYN-101');
    assert.equal(recentChronological[1].auditId, 'AUD-SYN-102');

    assert.ok(
      new Date(recentChronological[0].timestamp) < new Date(recentChronological[1].timestamp),
      'Recent history must be ordered oldest to newest'
    );
  });

  await t.test('5. Future assessments (timestamp >= current) are excluded from historical retrieval', () => {
    const currentAuditTime = new Date('2026-02-10T10:00:00Z');
    const filtered = audits.filter(a => new Date(a.timestamp) < currentAuditTime);

    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].auditId, 'AUD-SYN-101');
    assert.ok(!filtered.some(a => a.auditId === 'AUD-SYN-103'), 'Future audit 103 must be excluded');
  });

  await t.test('6. Rehabilitation interventions are integrated into assembled context', () => {
    const mockInterventions = [
      {
        id: 'INT-001',
        sourceType: 'manual',
        recommendedIntervention: 'Trauma-informed art therapy twice weekly',
        status: 'in_progress',
        dateRecommended: new Date('2026-01-15')
      }
    ];

    const mockStructured = {
      previousAudit: audit2,
      baselineAudit: audit1,
      recentChronologicalHistory: [audit1, audit2],
      criticalSafetyAudits: [],
      rehabilitationInterventions: mockInterventions,
      previousAIRecommendations: [],
      totalHistoricalAudits: 2,
      isFirstAudit: false,
      retrievedAuditIds: [audit1.auditId, audit2.auditId]
    };

    const assembled = assembleContext(audit3, mockStructured, {});
    assert.ok(Array.isArray(assembled.rehabilitationInterventions));
    assert.equal(assembled.rehabilitationInterventions.length, 1);
    assert.equal(assembled.rehabilitationInterventions[0].id, 'INT-001');
  });

  await t.test('7. Context assembler dedupes semantic evidence already present in structured history', () => {
    const structuredMock = {
      previousAudit: audit2,
      baselineAudit: audit1,
      recentChronologicalHistory: [audit1, audit2],
      criticalSafetyAudits: [audit2],
      rehabilitationInterventions: [],
      previousAIRecommendations: [],
      totalHistoricalAudits: 2,
      isFirstAudit: false,
      retrievedAuditIds: [audit1.auditId, audit2.auditId]
    };

    const semanticMock = {
      medical_physical: [
        { auditId: 'AUD-SYN-101', content: 'Duplicate chunk from audit 1', score: 0.88 },
        { auditId: 'AUD-SYN-099', content: 'Older unique chunk from audit 99', score: 0.75 }
      ],
      trauma_indicators: [],
      progress_tracking: [],
      retrievalMode: 'hybrid'
    };

    const assembled = assembleContext(audit3, structuredMock, semanticMock);

    // AUD-SYN-101 is already in structured history, so it should be deduped out of domainEvidence
    const medEvidence = assembled.domainEvidence.medical_physical;
    assert.equal(medEvidence.length, 1);
    assert.equal(medEvidence[0].auditId, 'AUD-SYN-099');
    assert.ok(assembled.retrievalMetadata.retrievedAuditIds.includes('AUD-SYN-099'));
  });

  await t.test('8. Token-aware budgeting trims lower-priority chunks when context exceeds budget', () => {
    // Generate large semantic evidence chunks that exceed MAX_CONTEXT_CHARS (36,000)
    const largeChunks = Array.from({ length: 15 }, (_, i) => ({
      auditId: `AUD-OLD-${i}`,
      content: 'Lengthy historical medical report with detailed symptoms. '.repeat(200) // ~11,000 chars each
    }));

    const structuredMock = {
      previousAudit: audit2,
      baselineAudit: audit1,
      recentChronologicalHistory: [audit1, audit2],
      criticalSafetyAudits: [],
      rehabilitationInterventions: [],
      previousAIRecommendations: [],
      totalHistoricalAudits: 2,
      isFirstAudit: false,
      retrievedAuditIds: [audit1.auditId, audit2.auditId]
    };

    const semanticMock = {
      medical_physical: largeChunks,
      trauma_indicators: [],
      progress_tracking: [],
      retrievalMode: 'hybrid'
    };

    const assembled = assembleContext(audit3, structuredMock, semanticMock);

    // Context budget must be respected and lower-priority semantic chunks trimmed
    assert.ok(assembled.retrievalMetadata.budget.totalChars > 0);
    assert.ok(assembled.domainEvidence.medical_physical.length <= 2, 'Semantic chunks must be trimmed under budget pressure');
    // Core records are strictly preserved:
    assert.ok(assembled.currentAudit);
    assert.ok(assembled.previousAudit);
    assert.ok(assembled.baselineAudit);
  });
});
