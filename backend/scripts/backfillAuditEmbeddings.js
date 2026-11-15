'use strict';
/**
 * Backfill utility for generating domain evidence chunks and embeddings for historical audits.
 *
 * Usage:
 *   node backend/scripts/backfillAuditEmbeddings.js [--dry-run] [--batch-size=10] [--limit=100] [--victim-id=VID]
 *
 * Safe to interrupt and restart: checks existing chunks and hashes before generating.
 * Never prints patient names or identifiable clinical observations.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const connectDB = require('../db/connection');
const Audit = require('../models/audit');
const { indexAudit } = require('../services/auditEvaluation/auditIndexingService');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

function getArgValue(prefix, defaultValue) {
  const arg = args.find(a => a.startsWith(prefix));
  if (!arg) return defaultValue;
  return arg.split('=')[1] || defaultValue;
}

const BATCH_SIZE = parseInt(getArgValue('--batch-size', '10'), 10);
const LIMIT = parseInt(getArgValue('--limit', '0'), 10);
const TARGET_VICTIM_ID = getArgValue('--victim-id', null);

async function runBackfill() {
  console.log('='.repeat(60));
  console.log('  TRAFFRELIEF HISTORICAL AUDIT EMBEDDING BACKFILL');
  console.log('='.repeat(60));
  console.log(`Mode:            ${isDryRun ? 'DRY RUN (no DB writes or API calls)' : 'LIVE'}`);
  console.log(`Batch size:      ${BATCH_SIZE}`);
  console.log(`Limit:           ${LIMIT > 0 ? LIMIT : 'All historical audits'}`);
  console.log(`Target victim:   ${TARGET_VICTIM_ID || 'All victims'}`);
  console.log(`RAG Enabled:     ${process.env.RAG_ENABLED}`);
  console.log(`Vector Enabled:  ${process.env.RAG_VECTOR_SEARCH_ENABLED}`);
  console.log(`Embedding Model: ${process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001'}`);
  console.log('-'.repeat(60));

  const mongoUrl = process.env.MONGO_URL;
  if (!mongoUrl) {
    console.error('ERROR: MONGO_URL not found in environment.');
    process.exit(1);
  }

  await connectDB(mongoUrl);

  const query = {};
  if (TARGET_VICTIM_ID) {
    query.victimId = TARGET_VICTIM_ID;
  }

  let auditQuery = Audit.find(query).sort({ timestamp: 1 });
  if (LIMIT > 0) {
    auditQuery = auditQuery.limit(LIMIT);
  }

  const audits = await auditQuery.lean();
  console.log(`Found ${audits.length} historical audit(s) to inspect.\n`);

  if (audits.length === 0) {
    console.log('No audits match query. Exiting.');
    await mongoose.connection.close();
    return;
  }

  let totalProcessed = 0;
  let totalIndexed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (let i = 0; i < audits.length; i += BATCH_SIZE) {
    const batch = audits.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(audits.length / BATCH_SIZE);

    console.log(`[Batch ${batchNum}/${totalBatches}] Processing ${batch.length} audit(s)...`);

    for (const audit of batch) {
      totalProcessed++;
      const auditLabel = `Audit ${audit.auditId || audit._id}`;

      if (isDryRun) {
        console.log(`  [DRY-RUN] Would process ${auditLabel} (Date: ${audit.timestamp || 'N/A'})`);
        totalSkipped++;
        continue;
      }

      try {
        const result = await indexAudit(audit);
        totalIndexed += result.indexed;
        totalSkipped += result.skipped;
        totalFailed += result.failed;

        console.log(
          `  ${auditLabel}: indexed=${result.indexed}, skipped=${result.skipped}, failed=${result.failed}`
        );
      } catch (err) {
        totalFailed++;
        console.error(`  ERROR processing ${auditLabel}:`, err.message);
      }

      // Small delay between audits to respect Gemini API rate limits
      if (!isDryRun) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('  BACKFILL SUMMARY');
  console.log('='.repeat(60));
  console.log(`Audits inspected: ${totalProcessed}`);
  console.log(`Chunks indexed:   ${totalIndexed}`);
  console.log(`Chunks skipped:   ${totalSkipped} (already indexed / unchanged)`);
  console.log(`Chunks failed:    ${totalFailed}`);
  console.log('='.repeat(60));

  await mongoose.connection.close();
  console.log('Database connection closed.');
}

runBackfill().catch(err => {
  console.error('Fatal backfill error:', err);
  process.exit(1);
});

