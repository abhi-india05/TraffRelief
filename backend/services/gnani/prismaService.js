'use strict';
const axios = require('axios');
const path = require('path');
const { getGnaniConfig, validateGnaniConfig } = require('./gnaniConfig');
const { assertGnaniDataAccess } = require('./gnaniPrivacyPolicy');

const EXTENSION_MAP = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp3': '.mp3',
  'audio/mpeg': '.mp3',
  'audio/flac': '.flac',
  'audio/aac': '.aac',
  'audio/mp4': '.mp4',
  'audio/x-m4a': '.m4a'
};

/**
 * Transcribe Kannada / Kannada-English code-mixed audio using Gnani Prisma STT REST API.
 *
 * @param {Object} options
 * @param {Buffer} options.audioBuffer - Raw audio file buffer
 * @param {string} [options.mimeType='audio/webm'] - Actual MIME type of the recorded audio
 * @param {string} [options.filename='recording.webm'] - Original or synthesized filename
 * @param {string} [options.dataClassification='real'] - Patient data classification ('synthetic'|'real')
 * @param {string} [options.patientId] - Target patient identifier
 * @returns {Promise<Object>} Normalized transcription response
 */
async function transcribeAudio(options = {}) {
  const {
    audioBuffer,
    mimeType = 'audio/webm',
    filename = 'recording.webm',
    dataClassification = 'real',
    patientId = null
  } = options;

  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new Error('PRISMA_STT_ERROR: Invalid audio payload. Non-empty Buffer is required.');
  }

  // 1. Enforce centralized privacy gate (real data fail-closed)
  assertGnaniDataAccess({
    operation: 'prisma_stt',
    dataClassification,
    victimId: patientId
  });

  // 2. Validate configuration
  const config = getGnaniConfig();
  validateGnaniConfig('stt');

  // 3. Format validation
  const baseMime = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (!config.prisma.supportedMimeTypes.has(baseMime)) {
    throw new Error(
      `PRISMA_STT_ERROR: Unsupported audio MIME type "${mimeType}". Supported formats: [${[...config.prisma.supportedMimeTypes].join(', ')}]`
    );
  }

  // Determine appropriate filename with extension
  const ext = EXTENSION_MAP[baseMime] || path.extname(filename) || '.webm';
  const finalFilename = filename.endsWith(ext) ? filename : `recording${ext}`;

  // 4. Construct multipart/form-data payload
  const formData = new FormData();
  const audioBlob = new Blob([audioBuffer], { type: baseMime });
  formData.append('audio_file', audioBlob, finalFilename);
  formData.append('model', config.prisma.model);
  formData.append('language_code', config.prisma.language);
  formData.append('format', config.prisma.mode);

  const headers = {
    'X-API-Key-ID': config.apiKeyId || config.apiKey,
    'x-api-key': config.apiKey
  };

  // 5. Call Prisma STT REST endpoint
  try {
    const response = await axios.post(config.prisma.endpoint, formData, {
      headers,
      timeout: 45000 // 45 seconds timeout for speech-to-text
    });

    const data = response.data || {};

    const transcript = (typeof data.transcript === 'string')
      ? data.transcript.trim()
      : (data.text || '').trim();

    return {
      transcript,
      provider: 'gnani_prisma',
      model: data.model || config.prisma.model,
      language: data.detected_language_code || config.prisma.language,
      mode: config.prisma.mode,
      metadata: {
        requestId: data.request_id || null,
        processingTime: data.processing_time != null ? data.processing_time : null,
        endToEndLatency: data.end_to_end_latency != null ? data.end_to_end_latency : null
      }
    };

  } catch (err) {
    const status = err.response?.status;
    let safeMessage = err.message || 'Prisma STT request failed';

    if (err.response?.data) {
      const respData = err.response.data;
      if (typeof respData === 'object' && (respData.message || respData.error)) {
        safeMessage = respData.message || respData.error;
      }
    }

    throw new Error(`PRISMA_STT_ERROR: (HTTP ${status || 'network'}) ${safeMessage}`);
  }
}

module.exports = {
  transcribeAudio,
  EXTENSION_MAP
};
