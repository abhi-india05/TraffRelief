'use strict';

// 2,048 tokens is approximately 8,192 characters (assuming ~4 chars per token)
const MAX_CHUNK_CHARS = parseInt(process.env.RAG_MAX_CHUNK_CHARS || '8000', 10);
const CHUNK_OVERLAP_CHARS = 400;

function formatField(label, value) {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  return `${label}:\n${String(value).trim()}`;
}

function buildMedicalChunk(audit, auditDate) {
  const lines = [`Assessment Domain: Medical and Physical Health`, `Assessment Date: ${auditDate}`];
  const sourceFields = [];

  const fields = [
    ['currentPhysicalSymptoms', 'Current Physical Symptoms'],
    ['physicalInjuriesSustained', 'Physical Injuries Sustained'],
    ['medicalConditionsRequiringTreatment', 'Medical Conditions Requiring Treatment'],
    ['currentMedicationsAndNeeds', 'Current Medications and Needs'],
    ['nutritionalStatus', 'Nutritional Status'],
    ['sleepPatterns', 'Sleep Patterns']
  ];

  for (const [field, label] of fields) {
    const formatted = formatField(label, audit[field]);
    if (formatted) { lines.push('', formatted); sourceFields.push(field); }
  }

  // Add relevant additional note if present
  const note = formatField('Additional Notes', audit.additionalNote);
  if (note) { lines.push('', note); sourceFields.push('additionalNote'); }

  return { domain: 'medical_physical', content: lines.join('\n'), sourceFields };
}

function buildPsychologicalChunk(audit, auditDate) {
  const lines = [`Assessment Domain: Psychological and Emotional Health`, `Assessment Date: ${auditDate}`];
  const sourceFields = [];

  const fields = [
    ['traumaIndicators', 'Trauma Indicators'],
    ['depressionSymptoms', 'Depression Symptoms'],
    ['anxietyIndicators', 'Anxiety Indicators'],
    ['dissociativeEpisodes', 'Dissociative Episodes'],
    ['selfHarmBehaviors', 'Self-Harm Observations'],
    ['emotionalRegulationChallenges', 'Emotional Regulation Challenges'],
    ['trustAndRelationshipIssues', 'Trust and Relationship Issues'],
    ['factorsAffectingMentalHealth', 'Factors Affecting Mental Health'],
    ['additionalNote', 'Staff Observations']
  ];

  for (const [field, label] of fields) {
    const formatted = formatField(label, audit[field]);
    if (formatted) { lines.push('', formatted); sourceFields.push(field); }
  }

  return { domain: 'trauma_indicators', content: lines.join('\n'), sourceFields };
}

function buildProgressChunk(audit, auditDate) {
  const lines = [`Assessment Domain: Rehabilitation Progress Tracking`, `Assessment Date: ${auditDate}`];
  const sourceFields = [];

  const fields = [
    ['gamesActivitiesTasksPerformedConductedGiven', 'Activities and Tasks Performed'],
    ['therapyAttendanceRate', 'Therapy Attendance Rate'],
    ['treatmentCompliance', 'Treatment Compliance'],
    ['skillDevelopmentMilestones', 'Skill Development Milestones'],
    ['behavioralImprovements', 'Behavioral Improvements'],
    ['goalAchievementProgress', 'Goal Achievement Progress'],
    ['setbacksIndicator', 'Setbacks'],
    ['medicationAdherence', 'Medication Adherence'],
    ['additionalNoteProgress', 'Progress Notes']
  ];

  for (const [field, label] of fields) {
    const formatted = formatField(label, audit[field]);
    if (formatted) { lines.push('', formatted); sourceFields.push(field); }
  }

  return { domain: 'progress_tracking', content: lines.join('\n'), sourceFields };
}

/**
 * Split an oversized chunk into bounded sub-chunks if content exceeds MAX_CHUNK_CHARS.
 *
 * @param {Object} chunk - { domain, content, sourceFields }
 * @returns {Array<Object>}
 */
function splitOversizedChunk(chunk) {
  if (!chunk.content || chunk.content.length <= MAX_CHUNK_CHARS) {
    return [chunk];
  }

  const subChunks = [];
  let startIndex = 0;
  let partNumber = 1;

  while (startIndex < chunk.content.length) {
    let endIndex = startIndex + MAX_CHUNK_CHARS;
    if (endIndex < chunk.content.length) {
      // Find nearest newline or paragraph break to avoid cutting mid-sentence
      const breakPoint = chunk.content.lastIndexOf('\n', endIndex);
      if (breakPoint > startIndex + (MAX_CHUNK_CHARS / 2)) {
        endIndex = breakPoint;
      }
    }

    const subContent = chunk.content.slice(startIndex, endIndex).trim();
    if (subContent.length > 0) {
      subChunks.push({
        domain: chunk.domain,
        content: `[Part ${partNumber}] ${subContent}`,
        sourceFields: chunk.sourceFields,
        partIndex: partNumber
      });
      partNumber++;
    }

    if (endIndex >= chunk.content.length) break;
    startIndex = Math.max(endIndex - CHUNK_OVERLAP_CHARS, startIndex + 1);
  }

  return subChunks.length > 0 ? subChunks : [chunk];
}

/**
 * Build domain evidence chunks from an audit document, splitting oversized ones.
 * @param {Object} audit — plain JS object (Mongoose doc or lean object)
 * @returns {Array<{domain, content, sourceFields}>}
 */
function buildChunks(audit) {
  const auditDate = audit.timestamp
    ? new Date(audit.timestamp).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'Date not recorded';

  const baseChunks = [
    buildMedicalChunk(audit, auditDate),
    buildPsychologicalChunk(audit, auditDate),
    buildProgressChunk(audit, auditDate)
  ];

  const finalChunks = [];
  for (const c of baseChunks) {
    finalChunks.push(...splitOversizedChunk(c));
  }

  return finalChunks;
}

module.exports = { buildChunks, splitOversizedChunk, MAX_CHUNK_CHARS };
