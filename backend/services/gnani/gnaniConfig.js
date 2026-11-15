'use strict';
require('dotenv').config();

/**
 * Centralized Gnani AI Configuration Service.
 * Manages configuration and endpoints for Gnani Prisma STT and Gnani Timbre TTS.
 */
function getGnaniConfig() {
  const isEnabled = process.env.GNANI_ENABLED === 'true' || process.env.MOCK_GNANI === 'false';
  return {
    apiKeyId: process.env.GNANI_API_KEY_ID || process.env.GNANI_API_KEY || '',
    apiKey: process.env.GNANI_API_KEY || '',
    baseUrl: process.env.GNANI_BASE_URL || 'https://api.vachana.ai',
    enabled: isEnabled,
    allowRealData: process.env.GNANI_ALLOW_REAL_DATA === 'true',
    mockGnani: process.env.MOCK_GNANI === 'true',

    // Prisma STT settings
    prisma: {
      endpoint: process.env.GNANI_STT_URL || process.env.GNANI_PRISMA_ENDPOINT || 'https://api.vachana.ai/stt/v3',
      model: process.env.GNANI_STT_MODEL || process.env.GNANI_PRISMA_MODEL || 'prisma-v2.5',
      language: process.env.GNANI_PRISMA_LANGUAGE || 'kn-IN',
      mode: process.env.GNANI_PRISMA_MODE || 'codemix',
      supportedMimeTypes: new Set([
        'audio/wav',
        'audio/x-wav',
        'audio/wave',
        'audio/mp3',
        'audio/mpeg',
        'audio/ogg',
        'audio/webm',
        'audio/flac',
        'audio/aac',
        'audio/mp4',
        'audio/x-m4a'
      ])
    },

    // Timbre TTS settings
    timbre: {
      endpoint: process.env.GNANI_TTS_URL || process.env.GNANI_TIMBRE_ENDPOINT || 'https://api.vachana.ai/api/v1/tts/inference',
      streamEndpoint: process.env.GNANI_TTS_STREAM_URL || 'https://api.vachana.ai/api/v1/tts/stream',
      model: process.env.GNANI_TTS_MODEL || process.env.GNANI_TIMBRE_MODEL || 'timbre-v2.5',
      language: process.env.GNANI_TIMBRE_LANGUAGE || 'kn',
      voice: process.env.GNANI_TTS_VOICE || process.env.GNANI_TIMBRE_VOICE || 'Lakshmi',
      sampleRate: parseInt(process.env.GNANI_TIMBRE_SAMPLE_RATE || '48000', 10),
      container: 'wav',
      encoding: 'linear_pcm'
    }
  };
}

/**
 * Validate that Gnani integration is properly configured.
 * @param {string} service - 'stt' | 'tts' | 'all'
 * @throws {Error} if required configuration is missing
 */
function validateGnaniConfig(service = 'all') {
  const config = getGnaniConfig();

  if (!config.enabled) {
    throw new Error('GNANI_INTEGRATION_DISABLED: Gnani AI integration is disabled. Set GNANI_ENABLED=true to enable.');
  }

  if (!config.apiKey || config.apiKey.trim() === '') {
    throw new Error('GNANI_CONFIG_ERROR: GNANI_API_KEY is not configured in environment.');
  }

  if (service === 'stt' || service === 'all') {
    if (!config.prisma.endpoint) {
      throw new Error('GNANI_CONFIG_ERROR: GNANI_PRISMA_ENDPOINT is missing.');
    }
    if (!config.prisma.model) {
      throw new Error('GNANI_CONFIG_ERROR: GNANI_PRISMA_MODEL is missing.');
    }
  }

  if (service === 'tts' || service === 'all') {
    if (!config.timbre.endpoint) {
      throw new Error('GNANI_CONFIG_ERROR: GNANI_TIMBRE_ENDPOINT is missing.');
    }
    if (!config.timbre.voice) {
      throw new Error('GNANI_CONFIG_ERROR: GNANI_TIMBRE_VOICE is missing.');
    }
  }

  return config;
}

module.exports = {
  getGnaniConfig,
  validateGnaniConfig
};
