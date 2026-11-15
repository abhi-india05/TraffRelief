'use strict';

// 2,048 tokens is approximately 8,192 characters (assuming ~4 chars per token)
const MAX_CHUNK_CHARS = parseInt(process.env.RAG_MAX_CHUNK_CHARS || '8000', 10);
const CHUNK_OVERLAP_CHARS = 400;

const DOMAIN_DEFINITIONS = {
  medical_physical: {
    title: 'Medical and Physical Health',
    fields: [
      ['currentPhysicalSymptoms', 'Current Physical Symptoms'],
      ['physicalInjuriesSustained', 'Physical Injuries Sustained'],
      ['medicalConditionsRequiringTreatment', 'Medical Conditions Requiring Treatment'],
      ['currentMedicationsAndNeeds', 'Current Medications and Needs'],
      ['nutritionalStatus', 'Nutritional Status'],
      ['sleepPatterns', 'Sleep Patterns'],
      ['additionalNote', 'Additional Medical Notes']
    ]
  },
  trauma_indicators: {
    title: 'Psychological and Emotional Health',
    fields: [
      ['traumaIndicators', 'Trauma Indicators'],
      ['depressionSymptoms', 'Depression Symptoms'],
      ['anxietyIndicators', 'Anxiety Indicators'],
      ['dissociativeEpisodes', 'Dissociative Episodes'],
      ['selfHarmBehaviors', 'Self-Harm Observations'],
      ['emotionalRegulationChallenges', 'Emotional Regulation Challenges'],
      ['trustAndRelationshipIssues', 'Trust and Relationship Issues'],
      ['factorsAffectingMentalHealth', 'Factors Affecting Mental Health'],
      ['additionalNote', 'Staff Observations']
    ]
  },
  progress_tracking: {
    title: 'Rehabilitation Progress Tracking',
    fields: [
      ['gamesActivitiesTasksPerformedConductedGiven', 'Activities and Tasks Performed'],
      ['therapyAttendanceRate', 'Therapy Attendance Rate'],
      ['treatmentCompliance', 'Treatment Compliance'],
      ['skillDevelopmentMilestones', 'Skill Development Milestones'],
      ['behavioralImprovements', 'Behavioral Improvements'],
      ['goalAchievementProgress', 'Goal Achievement Progress'],
      ['setbacksIndicator', 'Setbacks'],
      ['medicationAdherence', 'Medication Adherence'],
      ['additionalNoteProgress', 'Progress Notes']
    ]
  }
};

/**
 * Split a single field value if it exceeds MAX_CHUNK_CHARS.
 *
 * @param {string} fieldName
 * @param {string} labelOrText
 * @param {string} [optionalText]
 * @returns {Array<{field: string, label: string, text: string, segmentIndex: number}>}
 */
function segmentFieldText(fieldName, labelOrText, optionalText) {
  let label = labelOrText;
  let text = optionalText;
  if (optionalText === undefined) {
    text = labelOrText;
    label = fieldName;
  }
  if (!text || text.length <= MAX_CHUNK_CHARS) {
    return [{ field: fieldName, label, text: text || '', segmentIndex: 0 }];
  }

  const segments = [];
  let startIndex = 0;
  let segmentIndex = 0;

  while (startIndex < text.length) {
    let endIndex = startIndex + (MAX_CHUNK_CHARS - 500); // Leave room for headers
    if (endIndex < text.length) {
      const breakPoint = text.lastIndexOf('\n', endIndex);
      if (breakPoint > startIndex + (MAX_CHUNK_CHARS / 3)) {
        endIndex = breakPoint;
      }
    }

    const subText = text.slice(startIndex, endIndex).trim();
    if (subText.length > 0) {
      segments.push({
        field: fieldName,
        label: `${label} (Segment ${segmentIndex + 1})`,
        text: subText,
        segmentIndex
      });
      segmentIndex++;
    }

    if (endIndex >= text.length) break;
    startIndex = Math.max(endIndex - CHUNK_OVERLAP_CHARS, startIndex + 1);
  }

  return segments.length > 0 ? segments : [{ field: fieldName, label, text, segmentIndex: 0 }];
}

/**
 * Build chunks for a single domain with field-level source mapping and stable partIndex.
 *
 * @param {string} domainKey
 * @param {Object} audit
 * @param {string} auditDate
 * @returns {Array<Object>}
 */
function buildDomainChunks(domainKey, audit, auditDate) {
  const def = DOMAIN_DEFINITIONS[domainKey];
  if (!def) return [];

  // 1. Gather all segments across non-empty fields in this domain
  const domainSegments = [];
  for (const [field, label] of def.fields) {
    const rawValue = audit[field];
    if (rawValue !== null && rawValue !== undefined && String(rawValue).trim() !== '') {
      const fieldText = String(rawValue).trim();
      const segs = segmentFieldText(field, label, fieldText);
      domainSegments.push(...segs);
    }
  }

  // 2. If no fields have content, produce a single empty placeholder chunk
  if (domainSegments.length === 0) {
    const header = [
      `Assessment Domain: ${def.title}`,
      `Assessment Date: ${auditDate}`,
      `Assessment Part: 1 of 1`,
      '',
      '(No domain observations recorded in this assessment)'
    ].join('\n');

    return [{
      domain: domainKey,
      partIndex: 0,
      partCount: 1,
      content: header,
      sourceFields: [],
      sourceSegments: []
    }];
  }

  // 3. Pack segments into chunks respecting MAX_CHUNK_CHARS
  const rawChunks = [];
  let currentSegments = [];
  let currentLength = 0;

  for (const seg of domainSegments) {
    const entryText = `\n\n${seg.label}:\n${seg.text}`;
    const entryLength = entryText.length;

    // Check if adding this segment would exceed limit (and current chunk is not empty)
    if (currentSegments.length > 0 && (currentLength + entryLength > MAX_CHUNK_CHARS)) {
      rawChunks.push(currentSegments);
      currentSegments = [seg];
      currentLength = entryLength;
    } else {
      currentSegments.push(seg);
      currentLength += entryLength;
    }
  }

  if (currentSegments.length > 0) {
    rawChunks.push(currentSegments);
  }

  const partCount = rawChunks.length;

  // 4. Format final chunk objects with zero-based partIndex
  return rawChunks.map((segments, index) => {
    const chunkLines = [
      `Assessment Domain: ${def.title}`,
      `Assessment Date: ${auditDate}`,
      `Assessment Part: ${index + 1} of ${partCount}`
    ];

    const sourceFields = Array.from(new Set(segments.map(s => s.field)));
    const sourceSegments = segments.map(s => ({
      field: s.field,
      text: s.text,
      segmentIndex: s.segmentIndex
    }));

    for (const seg of segments) {
      chunkLines.push('', `${seg.label}:\n${seg.text}`);
    }

    return {
      domain: domainKey,
      partIndex: index,
      partCount,
      content: chunkLines.join('\n'),
      sourceFields,
      sourceSegments
    };
  });
}

/**
 * Build all domain evidence chunks from an audit document.
 * Each chunk carries a stable partIndex (0, 1, 2...) and field-level source mapping.
 *
 * @param {Object} audit — plain JS object (Mongoose doc or lean object)
 * @returns {Array<{domain, partIndex, partCount, content, sourceFields, sourceSegments}>}
 */
function buildChunks(audit) {
  const auditDate = audit.timestamp
    ? new Date(audit.timestamp).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'Date not recorded';

  const medical = buildDomainChunks('medical_physical', audit, auditDate);
  const psychological = buildDomainChunks('trauma_indicators', audit, auditDate);
  const progress = buildDomainChunks('progress_tracking', audit, auditDate);

  return [...medical, ...psychological, ...progress];
}

/**
 * Split an oversized chunk into bounded sub-chunks while maintaining
 * domain identity, source fields, and bounding within MAX_CHUNK_CHARS.
 *
 * @param {Object} chunk - { domain, content, sourceFields }
 * @returns {Array<Object>}
 */
function splitOversizedChunk(chunk) {
  if (!chunk || !chunk.content) return [];
  if (chunk.content.length <= MAX_CHUNK_CHARS) {
    return [{ ...chunk, partIndex: 0, partCount: 1, sourceSegments: [] }];
  }

  const fieldName = (chunk.sourceFields && chunk.sourceFields[0]) || 'content';
  const segments = segmentFieldText(fieldName, chunk.content);
  const parts = [];
  let currentContent = '';
  let currentSegments = [];

  for (const seg of segments) {
    if (currentContent.length + seg.text.length + 2 > MAX_CHUNK_CHARS && currentContent.length > 0) {
      parts.push({
        domain: chunk.domain,
        content: currentContent.trim(),
        sourceFields: chunk.sourceFields || [],
        sourceSegments: currentSegments
      });
      currentContent = '';
      currentSegments = [];
    }
    currentContent += (currentContent ? '\n\n' : '') + seg.text;
    currentSegments.push(seg);
  }

  if (currentContent.length > 0) {
    parts.push({
      domain: chunk.domain,
      content: currentContent.trim(),
      sourceFields: chunk.sourceFields || [],
      sourceSegments: currentSegments
    });
  }

  return parts.map((p, idx) => ({
    ...p,
    partIndex: idx,
    partCount: parts.length
  }));
}

module.exports = {
  buildChunks,
  buildDomainChunks,
  segmentFieldText,
  splitOversizedChunk,
  MAX_CHUNK_CHARS,
  DOMAIN_DEFINITIONS
};
