'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const {
  INTERVIEW_QUESTIONS,
  QUESTION_MAP,
  VALID_QUESTION_IDS,
  VALID_LANGUAGES,
  getQuestionById,
  getQuestionText
} = require('../services/gnani/interviewQuestions');

const {
  getGnaniConfig,
  isGnaniEnabled,
  isPrismaRealDataAllowed,
  validateGnaniConfig
} = require('../services/gnani/gnaniConfig');

const {
  assertGnaniDataAccess
} = require('../services/gnani/gnaniPrivacyPolicy');

const timbreService = require('../services/gnani/timbreService');
const prismaService = require('../services/gnani/prismaService');
const { getQuestionAudio } = require('../controllers/release');

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    set(headerObj) {
      Object.assign(res.headers, headerObj);
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
    send(data) {
      res.body = data;
      return res;
    }
  };
  return res;
}

test('Gnani Kannada Voice Interview Integration Suite', async (t) => {
  const originalEnv = { ...process.env };

  t.afterEach(() => {
    // Restore environment after each subtest
    process.env = { ...originalEnv };
  });

  await t.test('1. Interview Questions Specification & Contract', () => {
    assert.equal(INTERVIEW_QUESTIONS.length, 5, 'Must have exactly 5 rehabilitation interview questions');

    const expectedIds = ['q1', 'q2', 'q3', 'q4', 'q5'];
    for (let i = 0; i < INTERVIEW_QUESTIONS.length; i++) {
      const q = INTERVIEW_QUESTIONS[i];
      assert.equal(q.id, expectedIds[i], `Question ${i + 1} must have id ${expectedIds[i]}`);
      assert.ok(typeof q.en === 'string' && q.en.trim().length > 10, `Question ${q.id} must have non-empty English text`);
      assert.ok(typeof q.kn === 'string' && q.kn.trim().length > 10, `Question ${q.id} must have non-empty Kannada text`);
      assert.equal(q.number, i + 1, `Question number must be ${i + 1}`);
    }

    assert.equal(VALID_QUESTION_IDS.size, 5);
    assert.deepEqual([...VALID_LANGUAGES], ['en', 'kn']);

    const q1 = getQuestionById('q1');
    assert.ok(q1);
    assert.equal(q1.id, 'q1');

    const invalidQ = getQuestionById('q99');
    assert.equal(invalidQ, null, 'Invalid question ID must return null');

    const textKn = getQuestionText('q1', 'kn');
    assert.equal(textKn, q1.kn);

    const textEn = getQuestionText('q1', 'en');
    assert.equal(textEn, q1.en);

    const fallbackEn = getQuestionText('q1', 'fr');
    assert.equal(fallbackEn, q1.en, 'Unsupported language must fall back to English');
  });

  await t.test('2. Configuration & Environment Settings', () => {
    process.env.GNANI_ENABLED = 'true';
    process.env.GNANI_API_KEY = 'test_api_key_123';
    process.env.GNANI_PRISMA_ENDPOINT = 'https://api.vachana.ai/stt/v3';
    process.env.GNANI_PRISMA_MODEL = 'prisma-v3.0';
    process.env.GNANI_PRISMA_LANGUAGE = 'kn-IN';
    process.env.GNANI_PRISMA_MODE = 'codemix';

    const config = getGnaniConfig();
    assert.ok(config);
    assert.equal(config.enabled, true);
    assert.equal(config.apiKey, 'test_api_key_123');
    assert.ok(config.prisma);
    assert.ok(config.timbre);

    assert.equal(config.prisma.model, 'prisma-v3.0');
    assert.equal(config.prisma.language, 'kn-IN');
    assert.equal(config.prisma.mode, 'codemix');

    assert.equal(config.timbre.language, 'kn');
    assert.equal(config.timbre.sampleRate, 48000);
    assert.equal(config.timbre.container, 'wav');

    assert.doesNotThrow(() => {
      validateGnaniConfig('all');
    });
  });

  await t.test('3. Privacy Enforcement Gate', () => {
    process.env.GNANI_ENABLED = 'true';
    process.env.GNANI_API_KEY = 'mock_api_key';
    process.env.GNANI_ALLOW_REAL_DATA = 'false';

    // Synthetic text should always pass
    assert.doesNotThrow(() => {
      assertGnaniDataAccess({
        dataClassification: 'synthetic',
        operation: 'test_synthetic'
      });
    });

    // Real patient data should fail closed (throw) when GNANI_ALLOW_REAL_DATA=false
    assert.throws(
      () => {
        assertGnaniDataAccess({
          dataClassification: 'real',
          operation: 'test_real'
        });
      },
      (err) => err.message.includes('GNANI_PRIVACY_POLICY') && err.message.includes('Real patient data')
    );

    // When GNANI_ALLOW_REAL_DATA is true, real patient data is permitted
    process.env.GNANI_ALLOW_REAL_DATA = 'true';
    assert.doesNotThrow(() => {
      assertGnaniDataAccess({
        dataClassification: 'real',
        operation: 'test_real_authorized'
      });
    });

    // When disabled, everything fails closed
    process.env.GNANI_ENABLED = 'false';
    assert.throws(
      () => {
        assertGnaniDataAccess({
          dataClassification: 'synthetic',
          operation: 'test_disabled'
        });
      },
      (err) => err.message.includes('disabled')
    );
  });

  await t.test('4. Timbre TTS Service - Question Validation, Synthesis & Caching', async () => {
    process.env.GNANI_ENABLED = 'true';
    process.env.GNANI_API_KEY = 'mock_api_key';

    // Invalid question ID rejection
    await assert.rejects(
      async () => {
        await timbreService.getQuestionAudio({ questionId: 'q99', language: 'kn' });
      },
      (err) => err.message.includes('Invalid or unknown question ID')
    );

    // Unsupported language rejection
    await assert.rejects(
      async () => {
        await timbreService.getQuestionAudio({ questionId: 'q1', language: 'fr' });
      },
      (err) => err.message.includes('Unsupported TTS language')
    );

    // Mock axios for successful TTS synthesis
    const originalPost = axios.post;
    let callCount = 0;
    timbreService.clearAudioCache();

    try {
      const syntheticWavBytes = Buffer.from('RIFF....WAVEfmt ....data....synthetic_pcm_audio');

      axios.post = async (url, data, config) => {
        callCount++;
        assert.ok(url.includes('tts'), 'Must call TTS endpoint');
        assert.equal(config.responseType, 'arraybuffer');
        assert.equal(data.language, 'kn');
        assert.ok(data.text && data.text.length > 0);
        return {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
          data: syntheticWavBytes
        };
      };

      // First call: should call API and populate cache
      const result1 = await timbreService.getQuestionAudio({ questionId: 'q1', language: 'kn' });
      assert.equal(callCount, 1, 'First call should hit external API');
      assert.equal(result1.fromCache, false);
      assert.equal(result1.contentType, 'audio/wav');
      assert.ok(result1.audioBuffer instanceof Buffer);
      assert.deepEqual(result1.audioBuffer, syntheticWavBytes);

      // Second call: should serve from cache without hitting API
      const result2 = await timbreService.getQuestionAudio({ questionId: 'q1', language: 'kn' });
      assert.equal(callCount, 1, 'Second call must hit in-memory cache, not API');
      assert.equal(result2.fromCache, true);
      assert.deepEqual(result2.audioBuffer, syntheticWavBytes);

      // Different question: should hit API
      const result3 = await timbreService.getQuestionAudio({ questionId: 'q2', language: 'kn' });
      assert.equal(callCount, 2, 'Different question ID must fetch new audio');
      assert.equal(result3.fromCache, false);
    } finally {
      axios.post = originalPost;
      timbreService.clearAudioCache();
    }
  });

  await t.test('5. Prisma STT Service - Transcription & Code-Mix Normalization', async () => {
    process.env.GNANI_ENABLED = 'true';
    process.env.GNANI_API_KEY = 'mock_api_key';

    const originalPost = axios.post;
    const syntheticBuffer = Buffer.from('fake_synthetic_audio_bytes_header_and_data');

    try {
      let capturedFormData = null;
      let capturedHeaders = null;

      axios.post = async (url, data, config) => {
        capturedFormData = data;
        capturedHeaders = config.headers;
        return {
          status: 200,
          data: {
            success: true,
            request_id: 'req_synthetic_123',
            transcript: 'ನನಗೆ ತುಂಬಾ ಭಯ ಮತ್ತು anxiety ಇದೆ. I feel depressed sometimes.',
            model: 'prisma-v3.0',
            detected_language_code: 'kn-IN',
            confidence: 0.94
          }
        };
      };

      const result = await prismaService.transcribeAudio({
        audioBuffer: syntheticBuffer,
        mimeType: 'audio/wav',
        dataClassification: 'synthetic'
      });

      assert.equal(result.provider, 'gnani_prisma');
      assert.equal(result.model, 'prisma-v3.0');
      assert.equal(result.language, 'kn-IN');
      assert.equal(result.mode, 'codemix');
      assert.ok(result.transcript.includes('anxiety'));
      assert.ok(result.transcript.includes('ಭಯ'));
      assert.equal(result.metadata.requestId, 'req_synthetic_123');

      // Verify authentication headers sent
      assert.ok(capturedHeaders['x-api-key-id'] || capturedHeaders['x-api-key']);
    } finally {
      axios.post = originalPost;
    }
  });

  await t.test('6. Prisma STT Service - Error Handling', async () => {
    process.env.GNANI_ENABLED = 'true';
    process.env.GNANI_API_KEY = 'mock_api_key';

    const originalPost = axios.post;
    const syntheticBuffer = Buffer.from('fake_synthetic_audio_bytes');

    try {
      axios.post = async () => {
        const error = new Error('Gateway Timeout');
        error.response = { status: 504, data: { message: 'Upstream audio engine timed out' } };
        throw error;
      };

      await assert.rejects(
        async () => {
          await prismaService.transcribeAudio({
            audioBuffer: syntheticBuffer,
            mimeType: 'audio/wav',
            dataClassification: 'synthetic'
          });
        },
        (err) => err.message.includes('PRISMA_STT_ERROR')
      );
    } finally {
      axios.post = originalPost;
    }
  });

  await t.test('7. End-to-End Bilingual Routing Contract in release controller', async () => {
    process.env.GNANI_ENABLED = 'true';
    process.env.GNANI_API_KEY = 'mock_api_key';

    // 1. Invalid question ID handling in controller
    const reqInvalid = {
      params: { questionId: 'invalid_q' },
      query: { lang: 'kn' }
    };
    const resInvalid = mockRes();
    await getQuestionAudio(reqInvalid, resInvalid);
    assert.equal(resInvalid.statusCode, 400);
    assert.ok(resInvalid.body.error.includes('Invalid question ID'));

    // 2. Unsupported language in controller
    const reqLang = {
      params: { questionId: 'q1' },
      query: { lang: 'de' }
    };
    const resLang = mockRes();
    await getQuestionAudio(reqLang, resLang);
    assert.equal(resLang.statusCode, 400);
    assert.ok(resLang.body.error.includes('Kannada'));

    // 3. Valid question audio retrieval
    const originalPost = axios.post;
    timbreService.clearAudioCache();
    const syntheticWav = Buffer.from('RIFF_test_wav_data_12345');

    try {
      axios.post = async () => ({
        status: 200,
        headers: { 'content-type': 'audio/wav' },
        data: syntheticWav
      });

      const reqValid = {
        params: { questionId: 'q1' },
        query: { lang: 'kn' }
      };
      const resValid = mockRes();
      await getQuestionAudio(reqValid, resValid);

      assert.equal(resValid.statusCode, 200);
      assert.equal(resValid.headers['Content-Type'], 'audio/wav');
      assert.ok(resValid.headers['Cache-Control'].includes('86400'));
      assert.deepEqual(resValid.body, syntheticWav);
    } finally {
      axios.post = originalPost;
      timbreService.clearAudioCache();
    }
  });

});
