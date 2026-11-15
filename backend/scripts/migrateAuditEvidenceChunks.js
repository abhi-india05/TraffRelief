'use strict';
/**
 * Migration script for AuditEvidenceChunk documents to support multi-chunk indexing:
 * - Assigns partIndex = 0 and partCount = 1 to existing unindexed documents.
 * - Detects any duplicate conflicts on (auditRef, domain, partIndex).
 * - Creates the new compound unique index: { auditRef: 1, domain: 1, partIndex: 1 }.
 * - Drops the legacy index: { auditRef: 1, domain: 1, embeddingVersion: 1 } only after verification.
 *
 * Usage:
 *   node backend/scripts/migrateAuditEvidenceChunks.js [--dry-run]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const connectDB = require('../db/connection');
const AuditEvidenceChunk = require('../models/auditEvidenceChunk');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

async function runMigration() {
  console.log('='.repeat(70));
  console.log('  MIGRATE AUDIT EVIDENCE CHUNKS TO MULTI-CHUNK STABLE IDENTITY');
  console.log('='.repeat(70));
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no DB modifications)' : 'LIVE EXECUTION'}`);

  const mongoUrl = process.env.MONGO_URL;
  if (!mongoUrl) {
    console.error('ERROR: MONGO_URL not found in environment.');
    process.exit(1);
  }

  await connectDB(mongoUrl);
  const collection = AuditEvidenceChunk.collection;

  // 1. Find all documents missing partIndex
  const unmigratedCount = await collection.countDocuments({ partIndex: { $exists: false } });
  console.log(`Found ${unmigratedCount} chunk document(s) without partIndex.`);

  // 2. Check for duplicate conflicts on potential (auditRef, domain, partIndex = 0)
  const duplicates = await collection.aggregate([
    {
      $group: {
        _id: { auditRef: '$auditRef', domain: '$domain', partIndex: { $ifNull: ['$partIndex', 0] } },
        count: { $sum: 1 },
        ids: { $push: '$_id' }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  if (duplicates.length > 0) {
    console.warn(`\n[WARNING] Detected ${duplicates.length} duplicate conflict(s) on (auditRef, domain, partIndex):`);
    for (const dup of duplicates) {
      console.warn(`  - auditRef: ${dup._id.auditRef}, domain: ${dup._id.domain}, count: ${dup.count}`);
    }
    console.warn('Conflicts must be inspected and resolved before dropping the legacy index.\n');
  } else {
    console.log('No duplicate conflicts detected on (auditRef, domain, partIndex).');
  }

  // 3. Migrate documents
  if (unmigratedCount > 0) {
    if (isDryRun) {
      console.log(`[DRY-RUN] Would update ${unmigratedCount} document(s) setting partIndex=0, partCount=1.`);
    } else {
      const updateResult = await collection.updateMany(
        { partIndex: { $exists: false } },
        {
          $set: {
            partIndex: 0,
            partCount: 1,
            sourceSegments: []
          }
        }
      );
      console.log(`Updated ${updateResult.modifiedCount} document(s) successfully.`);
    }
  }

  // 4. Index verification and update
  const existingIndexes = await collection.indexes();
  const hasLegacyIndex = existingIndexes.some(idx => idx.name === 'auditRef_1_domain_1_embeddingVersion_1');
  const hasNewIndex = existingIndexes.some(idx => idx.name === 'auditRef_1_domain_1_partIndex_1');

  console.log(`\nIndex status:`);
  console.log(`  - Legacy index (auditRef_1_domain_1_embeddingVersion_1): ${hasLegacyIndex ? 'Present' : 'Not found'}`);
  console.log(`  - New index (auditRef_1_domain_1_partIndex_1):           ${hasNewIndex ? 'Present' : 'Not found'}`);

  if (!isDryRun) {
    if (!hasNewIndex && duplicates.length === 0) {
      console.log('Creating new unique index: { auditRef: 1, domain: 1, partIndex: 1 }...');
      await collection.createIndex(
        { auditRef: 1, domain: 1, partIndex: 1 },
        { unique: true, name: 'auditRef_1_domain_1_partIndex_1' }
      );
      console.log('New index created successfully.');
    }

    if (hasLegacyIndex && duplicates.length === 0) {
      console.log('Dropping legacy index: auditRef_1_domain_1_embeddingVersion_1...');
      try {
        await collection.dropIndex('auditRef_1_domain_1_embeddingVersion_1');
        console.log('Legacy index dropped successfully.');
      } catch (err) {
        console.warn('Could not drop legacy index:', err.message);
      }
    }
  }

  console.log('='.repeat(70));
  console.log('Migration check complete.');
  await mongoose.connection.close();
}

if (require.main === module) {
  runMigration().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { runMigration };
