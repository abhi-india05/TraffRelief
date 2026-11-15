'use strict';
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const { assertGeminiDataAccess, sanitizeClinicalText } = require('../geminiPrivacyPolicy');

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = parseInt(process.env.GEMINI_EMBEDDING_DIMENSIONS || '768', 10);

function checkPrivacyGate(options = {}) {
  return assertGeminiDataAccess({
    operation: 'embedding_privacy_gate',
    dataClassification: options.dataClassification || 'real',
    databaseName: options.databaseName || ''
  });
}

function l2Normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map(v => v / norm);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function embedWithRetry(genAI, text, taskType, attempt = 0) {
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  try {
    const result = await model.embedContent({
      content: { parts: [{ text }], role: 'user' },
      taskType,
      outputDimensionality: EMBEDDING_DIMENSIONS
    });
    const values = result.embedding?.values;
    if (!values || values.length === 0) throw new Error('Empty embedding returned');
    return l2Normalize(values);
  } catch (err) {
    const isRateLimit = err.status === 429 || (err.message || '').includes('429') || (err.message || '').toLowerCase().includes('quota');
    if (isRateLimit && attempt < 3) {
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 16000);
      await sleep(delay);
      return embedWithRetry(genAI, text, taskType, attempt + 1);
    }
    throw err;
  }
}

/**
 * Generate a document embedding (for indexing stored chunks).
 * @param {string} text — content text
 * @param {Object} [options] - privacy and context options
 * @param {string} [options.dataClassification] - 'real' | 'synthetic'
 * @param {string} [options.databaseName] - database name
 * @returns {Promise<number[]>} 768-dim L2-normalised vector
 */
async function embedDocument(text, options = {}) {
  assertGeminiDataAccess({
    operation: 'embed_document',
    dataClassification: options.dataClassification || 'real',
    databaseName: options.databaseName || ''
  });
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const sanitizedText = sanitizeClinicalText(text);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return embedWithRetry(genAI, sanitizedText, 'RETRIEVAL_DOCUMENT');
}

/**
 * Generate a query embedding (for semantic search).
 * @param {string} text — query text
 * @param {Object} [options] - privacy and context options
 * @param {string} [options.dataClassification] - 'real' | 'synthetic'
 * @param {string} [options.databaseName] - database name
 * @returns {Promise<number[]>} 768-dim L2-normalised vector
 */
async function embedQuery(text, options = {}) {
  assertGeminiDataAccess({
    operation: 'embed_query',
    dataClassification: options.dataClassification || 'real',
    databaseName: options.databaseName || ''
  });
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const sanitizedText = sanitizeClinicalText(text);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return embedWithRetry(genAI, sanitizedText, 'RETRIEVAL_QUERY');
}

/**
 * Compute SHA-256 hash of text for deduplication.
 * @param {string} text
 * @returns {string}
 */
function computeContentHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

module.exports = {
  embedDocument,
  embedQuery,
  computeContentHash,
  checkPrivacyGate,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS
};
