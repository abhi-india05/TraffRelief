'use strict';
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = parseInt(process.env.GEMINI_EMBEDDING_DIMENSIONS || '768', 10);
const GEMINI_API_TIER = (process.env.GEMINI_API_TIER || '').toLowerCase();
const ALLOW_FREE_SYNTHETIC = process.env.ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA === 'true';
const NODE_ENV = process.env.NODE_ENV || 'development';

function checkPrivacyGate() {
  if (GEMINI_API_TIER === 'paid') return; // always allowed
  if (NODE_ENV !== 'production' && ALLOW_FREE_SYNTHETIC) return; // dev with explicit consent
  if (GEMINI_API_TIER === '') {
    throw new Error('EMBEDDING_PRIVACY_GATE: GEMINI_API_TIER is not configured. Set to "paid" for production or "free" with ALLOW_FREE_GEMINI_FOR_SYNTHETIC_DATA=true for synthetic dev data only.');
  }
  throw new Error('EMBEDDING_PRIVACY_GATE: Real patient data must not be sent to Gemini Free Tier. Set GEMINI_API_TIER=paid or configure for synthetic data only.');
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
 * @param {string} text — sanitised content text, no PII
 * @returns {Promise<number[]>} 768-dim L2-normalised vector
 */
async function embedDocument(text) {
  checkPrivacyGate();
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return embedWithRetry(genAI, text, 'RETRIEVAL_DOCUMENT');
}

/**
 * Generate a query embedding (for semantic search).
 * @param {string} text — sanitised query text, no PII
 * @returns {Promise<number[]>} 768-dim L2-normalised vector
 */
async function embedQuery(text) {
  checkPrivacyGate();
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return embedWithRetry(genAI, text, 'RETRIEVAL_QUERY');
}

/**
 * Compute SHA-256 hash of text for deduplication.
 * @param {string} text
 * @returns {string}
 */
function computeContentHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

module.exports = { embedDocument, embedQuery, computeContentHash, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
