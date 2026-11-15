'use strict';

// Explicit patterns that indicate a HIGH-RISK observation
// These are NOT clinical diagnoses — they are field-value patterns requiring urgent human escalation
const HIGH_RISK_PATTERNS = [
  /\bsuicid/i,
  /\bself.?harm/i,
  /\bself.?injur/i,
  /\bcut(ting)?\s*(self|herself|himself)/i,
  /\bharm(ing)?\s*(self|herself|himself)/i,
  /\battempt(ed)?\s*(suicide|self.?harm)/i,
  /\bactive\s+crisis/i,
  /\bemergency/i,
  /\bhospitali[sz]/i
];

const MODERATE_RISK_PATTERNS = [
  /\bsetback/i,
  /\bdeterioration/i,
  /\bsevere\s+declin/i,
  /\bregress/i,
  /\bdissociat/i,
  /\bflashback/i,
  /\bpanic\s+attack/i
];

// Fields that must be checked for high-risk patterns
const HIGH_RISK_FIELDS = [
  'selfHarmBehaviors',
  'traumaIndicators',
  'depressionSymptoms',
  'additionalNote',
  'setbacksIndicator',
  'physicalInjuriesSustained'
];

const MODERATE_RISK_FIELDS = [
  'anxietyIndicators',
  'emotionalRegulationChallenges',
  'factorsAffectingMentalHealth',
  'additionalNoteProgress'
];

/**
 * Evaluate safety rules deterministically against current audit fields.
 * Returns urgent=true and requires_human_review=true when any high-risk pattern is found.
 * This deterministic safety assessment overrides any AI assessment.
 *
 * @param {Object} currentAudit - plain JS audit object
 * @param {Array} historicalSafetyAudits - list of prior critical safety audits
 * @returns {{ urgent: boolean, requiresHumanReview: boolean, safetyFlags: Array<{field?: string, severity: string, pattern?: string, count?: number}> }}
 */
function evaluateSafety(currentAudit, historicalSafetyAudits = []) {
  const flags = [];
  let urgent = false;
  let requiresHumanReview = false;

  if (!currentAudit || typeof currentAudit !== 'object') {
    return { urgent: false, requiresHumanReview: false, safetyFlags: [] };
  }

  // Check current audit high-risk fields
  for (const field of HIGH_RISK_FIELDS) {
    const value = currentAudit[field];
    if (!value || typeof value !== 'string' || value.trim() === '') continue;

    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(value)) {
        urgent = true;
        requiresHumanReview = true;
        flags.push({ field, severity: 'high', pattern: pattern.source });
        break;
      }
    }
  }

  // Check current audit moderate-risk fields
  for (const field of MODERATE_RISK_FIELDS) {
    const value = currentAudit[field];
    if (!value || typeof value !== 'string' || value.trim() === '') continue;

    for (const pattern of MODERATE_RISK_PATTERNS) {
      if (pattern.test(value)) {
        requiresHumanReview = true;
        flags.push({ field, severity: 'moderate', pattern: pattern.source });
        break;
      }
    }
  }

  // If historical critical safety events exist, always flag for human review
  if (Array.isArray(historicalSafetyAudits) && historicalSafetyAudits.length > 0) {
    requiresHumanReview = true;
    flags.push({
      severity: 'historical',
      count: historicalSafetyAudits.length,
      note: 'Patient history includes recorded critical safety observations.'
    });
  }

  return { urgent, requiresHumanReview, safetyFlags: flags };
}

module.exports = { evaluateSafety, HIGH_RISK_PATTERNS, MODERATE_RISK_PATTERNS };

