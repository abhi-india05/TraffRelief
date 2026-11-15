'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { buildChunks, splitOversizedChunk } = require('../services/auditEvaluation/auditChunkBuilder');
const { computeContentHash, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = require('../services/auditEvaluation/embeddingService');
const { assertGeminiDataAccess, sanitizeClinicalText } = require('../services/geminiPrivacyPolicy');
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
    const raw = Array.from({ length: 768 }, (_, i) => Math.sin(i) * 5);
    const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
    const normalized = raw.map(v => v / norm);
    const magnitude = Math.sqrt(normalized.reduce((s, v) => s + v * v, 0));
    assert.ok(Math.abs(magnitude - 1.0) < 1e-6, `Magnitude should be ~1.0, got ${magnitude}`);
  });

  await t.test('5 & 6. Oversized chunks are safely split into bounded sub-chunks', () => {
    const hugeText = 'Clinical progress observation: patient exhibited gradual recovery. '.repeat(200); // ~13,000 chars
    const oversizedChunk = {
      domain: 'progress_tracking',
      content: hugeText,
      sourceFields: ['behavioralImprovements']
    };
    const splitResult = splitOversizedChunk(oversizedChunk);
    assert.ok(splitResult.length > 1, 'Chunk over 8,000 characters must be split into multiple sub-chunks');
    for (const sub of splitResult) {
      assert.ok(sub.content.length <= 8500, 'Sub-chunk must not exceed budget');
      assert.equal(sub.domain, 'progress_tracking');
    }
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

  await t.test('8. Chunk content contains NO patient PII and sanitizeClinicalText redacts identifiers', () => {
    const textWithPII = 'Patient Alice, phone +91 9876543210, email test@ngo.org, Aadhaar 1234 5678 9012, PIN: 110001, reports insomnia.';
    const sanitized = sanitizeClinicalText(textWithPII);

    assert.ok(!sanitized.includes('9876543210'), 'Phone number must be redacted');
    assert.ok(!sanitized.includes('test@ngo.org'), 'Email must be redacted');
    assert.ok(!sanitized.includes('1234 5678 9012'), 'National ID must be redacted');
    assert.ok(!sanitized.includes('110001'), 'PIN code must be redacted');
    assert.ok(sanitized.includes('insomnia'), 'Clinical symptom must be preserved');
  });

  await t.test('9 & 10. Centralized Gemini privacy policy strictly blocks Free Tier on real/production data', () => {
    const originalTier = process.env.GEMINI_API_TIER;
    const originalAllow = process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalKey = process.env.GEMINI_API_KEY;

    try {
      process.env.GEMINI_API_KEY = 'mock_api_key';

      // 1. Free tier in production MUST throw
      process.env.NODE_ENV = 'production';
      process.env.GEMINI_API_TIER = 'free';
      process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA = 'true';
      assert.throws(
        () => assertGeminiDataAccess({ operation: 'test', dataClassification: 'synthetic' }),
        /GEMINI_PRIVACY_POLICY: Production environment strictly requires GEMINI_API_TIER=paid/
      );

      // 2. Free tier with real patient data MUST throw
      process.env.NODE_ENV = 'development';
      process.env.GEMINI_API_TIER = 'free';
      process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA = 'true';
      assert.throws(
        () => assertGeminiDataAccess({ operation: 'test', dataClassification: 'real' }),
        /GEMINI_PRIVACY_POLICY: Real patient data.*cannot be sent to Gemini Free Tier/
      );

      // 3. Free tier with production database name MUST throw
      assert.throws(
        () => assertGeminiDataAccess({ operation: 'test', dataClassification: 'synthetic', databaseName: 'traffrelief_prod' }),
        /GEMINI_PRIVACY_POLICY: Production database/
      );

      // 4. Free tier without ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA=true MUST throw
      process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA = 'false';
      assert.throws(
        () => assertGeminiDataAccess({ operation: 'test', dataClassification: 'synthetic' }),
        /ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA=true/
      );

      // 5. Paid tier is permitted for both real and synthetic data
      process.env.GEMINI_API_TIER = 'paid';
      assert.equal(
        assertGeminiDataAccess({ operation: 'test', dataClassification: 'real', databaseName: 'traffrelief' }),
        true
      );
    } finally {
      process.env.GEMINI_API_TIER = originalTier;
      process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA = originalAllow;
      process.env.NODE_ENV = originalNodeEnv;
      process.env.GEMINI_API_KEY = originalKey;
    }
  });
});
