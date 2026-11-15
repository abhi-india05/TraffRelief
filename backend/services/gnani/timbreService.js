'use strict';
const axios = require('axios');
const { getGnaniConfig, validateGnaniConfig } = require('./gnaniConfig');
const { getQuestionById, getQuestionText, VALID_QUESTION_IDS } = require('./interviewQuestions');

// In-memory audio cache: Map<cacheKey, { audioBuffer: Buffer, contentType: string, createdAt: number }>
const ttsAudioCache = new Map();
const QUESTION_CONFIG_VERSION = 'v1';

/**
 * Generate a deterministic cache key for a static interview question prompt.
 */
function getCacheKey(questionId, language, model, voice) {
  return `${language}:${questionId}:${model}:${voice}:${QUESTION_CONFIG_VERSION}`;
}

/**
 * Synthesize speech for a predefined interview question using Gnani Timbre TTS.
 * Enforces strict input validation: only stable question IDs ('q1'..'q5') are permitted.
 * Arbitrary text is strictly rejected.
 *
 * @param {Object} options
 * @param {string} options.questionId - 'q1'..'q5'
 * @param {string} [options.language='kn'] - Language code ('kn')
 * @returns {Promise<{ audioBuffer: Buffer, contentType: string, fromCache: boolean }>}
 */
async function getQuestionAudio(options = {}) {
  const { questionId, language = 'kn' } = options;

  // 1. Strict validation: only accept supported languages
  const normalizedLang = (language || 'kn').toLowerCase();
  if (normalizedLang !== 'kn') {
    throw new Error(`TIMBRE_TTS_ERROR: Unsupported TTS language "${language}". Only "kn" is supported for Timbre question prompts.`);
  }

  // 2. Strict validation: only accept predefined question IDs
  const questionObj = getQuestionById(questionId);
  if (!questionObj) {
    throw new Error(`TIMBRE_TTS_ERROR: Invalid or unknown question ID "${questionId}". Permitted: [${[...VALID_QUESTION_IDS].join(', ')}]`);
  }

  const promptText = getQuestionText(questionObj.id, normalizedLang);
  if (!promptText) {
    throw new Error(`TIMBRE_TTS_ERROR: No prompt text found for question "${questionId}" in language "${normalizedLang}".`);
  }

  // 3. Check configuration
  const config = getGnaniConfig();
  validateGnaniConfig('tts');

  const { endpoint, model, voice, sampleRate, container, encoding } = config.timbre;
  const cacheKey = getCacheKey(questionObj.id, normalizedLang, model, voice);

  // 4. Return from in-memory cache if available
  if (ttsAudioCache.has(cacheKey)) {
    const cached = ttsAudioCache.get(cacheKey);
    return {
      audioBuffer: cached.audioBuffer,
      contentType: cached.contentType,
      fromCache: true
    };
  }

  // 5. Call Gnani Timbre TTS inference endpoint
  try {
    const payload = {
      text: promptText,
      model: model,
      voice: voice,
      language: normalizedLang,
      speed: 1.0,
      audio_config: {
        sample_rate: sampleRate,
        container: container || 'wav',
        encoding: encoding || 'linear_pcm'
      }
    };

    const headers = {
      'Content-Type': 'application/json',
      'X-API-Key-ID': config.apiKeyId || config.apiKey,
      'x-api-key': config.apiKey
    };

    const response = await axios.post(endpoint, payload, {
      headers,
      responseType: 'arraybuffer',
      timeout: 15000
    });

    const audioBuffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || 'audio/wav';

    // Store in cache
    ttsAudioCache.set(cacheKey, {
      audioBuffer,
      contentType,
      createdAt: Date.now()
    });

    return {
      audioBuffer,
      contentType,
      fromCache: false
    };

  } catch (err) {
    // Sanitize error: never leak API key
    const status = err.response?.status;
    let safeMessage = err.message || 'Timbre TTS service request failed';

    if (err.response?.data) {
      try {
        const parsed = JSON.parse(Buffer.from(err.response.data).toString('utf8'));
        if (parsed.message || parsed.error) {
          safeMessage = parsed.message || parsed.error;
        }
      } catch {
        // response was binary
      }
    }

    throw new Error(`TIMBRE_TTS_ERROR: (HTTP ${status || 'network'}) ${safeMessage}`);
  }
}

/**
 * Clear the in-memory TTS cache (useful for tests).
 */
function clearTtsCache() {
  ttsAudioCache.clear();
}

module.exports = {
  getQuestionAudio,
  getCacheKey,
  clearTtsCache,
  clearAudioCache: clearTtsCache,
  ttsAudioCache
};
