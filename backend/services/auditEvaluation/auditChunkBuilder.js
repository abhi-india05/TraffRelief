'use strict';

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
 * Build 3 domain evidence chunks from an audit document.
 * @param {Object} audit — plain JS object (Mongoose doc or lean object)
 * @returns {Array<{domain, content, sourceFields}>}
 */
function buildChunks(audit) {
  const auditDate = audit.timestamp
    ? new Date(audit.timestamp).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'Date not recorded';

  return [
    buildMedicalChunk(audit, auditDate),
    buildPsychologicalChunk(audit, auditDate),
    buildProgressChunk(audit, auditDate)
  ];
}

module.exports = { buildChunks };
