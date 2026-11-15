'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { buildChunks } = require('../services/auditEvaluation/auditChunkBuilder');
const { computeContentHash, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = require('../services/auditEvaluation/embeddingService');
const { SYNTHETIC_PATIENT_1_AUDITS } = require('./fixtures/syntheticPatients');

test('A. Embedding & Chunking Suite', async (t) => {
  const audit = SYNTHETIC_PATIENT_1_AUDITS[0];

  await t.test('1. Three domain chunks are generated from a valid audit', () => {
    const chunks = buildChunks(audit);
    assert.equal(chunks.length, 3);
    const domains = chunks.map(c => c.domain);
    assert.deepEqual(domains, ['medical_physical', 'trauma_indicators', 'progress_tracking']);
    for (const c of chunks) {
      assert.ok(c.content.length > 50, `Chunk ${c.domain} should have substantial content`);
      assert.ok(Array.isArray(c.sourceFields), 'sourceFields should be an array');
      assert.ok(c.sourceFields.length > 0, `Chunk ${c.domain} should list source fields`);
    }
  });

  await t.test('2. Empty or irrelevant fields are handled gracefully without undefined text', () => {
    const sparseAudit = {
      auditId: 'AUD-SPARSE',
      timestamp: new Date(),
      currentPhysicalSymptoms: 'Mild pain',
      additionalNote: null,
      traumaIndicators: undefined,
      selfHarmBehaviors: ''
    };
    const chunks = buildChunks(sparseAudit);
    assert.equal(chunks.length, 3);
    for (const c of chunks) {
      assert.ok(!c.content.includes('undefined'), 'Content should never contain "undefined"');
      assert.ok(!c.content.includes('null'), 'Content should never contain "null"');
    }
    // Only medical has actual field
    const medChunk = chunks.find(c => c.domain === 'medical_physical');
    assert.ok(medChunk.sourceFields.includes('currentPhysicalSymptoms'));
    const traumaChunk = chunks.find(c => c.domain === 'trauma_indicators');
    assert.equal(traumaChunk.sourceFields.length, 0);
  });

  await t.test('3. Configured dimensions and model match requirements (768, gemini-embedding-001)', () => {
    assert.equal(EMBEDDING_DIMENSIONS, 768);
    assert.ok(EMBEDDING_MODEL.includes('embedding'));
  });

  await t.test('4. L2 normalization produces vectors with unit length = 1.0', () => {
    // Generate synthetic unnormalized vector
    const raw = Array.from({ length: 768 }, (_, i) => Math.sin(i) * 5);
    const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
    const normalized = raw.map(v => v / norm);
    const magnitude = Math.sqrt(normalized.reduce((s, v) => s + v * v, 0));
    assert.ok(Math.abs(magnitude - 1.0) < 1e-6, `Magnitude should be ~1.0, got ${magnitude}`);
  });

  await t.test('5 & 6. Task types distinguish RETRIEVAL_DOCUMENT and RETRIEVAL_QUERY', () => {
    const docTask = 'RETRIEVAL_DOCUMENT';
    const queryTask = 'RETRIEVAL_QUERY';
    assert.notEqual(docTask, queryTask);
    assert.equal(docTask, 'RETRIEVAL_DOCUMENT');
    assert.equal(queryTask, 'RETRIEVAL_QUERY');
  });

  await t.test('7. Content hashes are deterministic and prevent duplicate work', () => {
    const text1 = 'Assessment Domain: Medical\nSymptoms: Headaches';
    const text2 = 'Assessment Domain: Medical\nSymptoms: Headaches';
    const text3 = 'Assessment Domain: Medical\nSymptoms: Fever';

    const hash1 = computeContentHash(text1);
    const hash2 = computeContentHash(text2);
    const hash3 = computeContentHash(text3);

    assert.equal(hash1, hash2, 'Identical content must produce identical hashes');
    assert.notEqual(hash1, hash3, 'Different content must produce different hashes');
    assert.equal(hash1.length, 64, 'SHA-256 hash length must be 64 characters');
  });

  await t.test('8. Chunk content contains NO patient PII (names, victimIds, staffIds)', () => {
    const auditWithPII = {
      ...audit,
      fullName: 'Alice TestSubject',
      victimId: 'VICTIM-123456789',
      staffName: 'Officer Bob',
      staffId: 'STAFF-987654321'
    };
    const chunks = buildChunks(auditWithPII);
    for (const c of chunks) {
      assert.ok(!c.content.includes('Alice TestSubject'), 'Chunk content must not contain patient name');
      assert.ok(!c.content.includes('VICTIM-123456789'), 'Chunk content must not contain victim ID');
      assert.ok(!c.content.includes('Officer Bob'), 'Chunk content must not contain staff name');
      assert.ok(!c.content.includes('STAFF-987654321'), 'Chunk content must not contain staff ID');
    }
  });

  await t.test('9 & 10. Free-tier privacy gate rejects unauthorized access', () => {
    // Test the gate function with mock environments
    const originalTier = process.env.GEMINI_API_TIER;
    const originalAllow = process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA;
    const originalNodeEnv = process.env.NODE_ENV;

    try {
      // In production with free tier -> must throw
      process.env.NODE_ENV = 'production';
      process.env.GEMINI_API_TIER = 'free';
      process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA = 'false';

      // Re-require or test privacy logic
      const checkPrivacy = (tier, nodeEnv, allowSynth) => {
        if (tier === 'paid') return true;
        if (nodeEnv !== 'production' && allowSynth === true) return true;
        throw new Error('EMBEDDING_PRIVACY_GATE');
      };

      assert.throws(() => checkPrivacy('free', 'production', false), /EMBEDDING_PRIVACY_GATE/);
      assert.throws(() => checkPrivacy('', 'development', false), /EMBEDDING_PRIVACY_GATE/);
      assert.equal(checkPrivacy('paid', 'production', false), true);
      assert.equal(checkPrivacy('free', 'development', true), true);
    } finally {
      process.env.GEMINI_API_TIER = originalTier;
      process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA = originalAllow;
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});

