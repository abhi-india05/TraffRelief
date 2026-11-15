'use strict';

/**
 * Deterministic Safety Evaluator for Rehabilitation Audits.
 *
 * Implements clinical negation detection, temporal scoping (acute vs historical),
 * and deterministic overrides that cannot be suppressed or hallucinated away by LLM output.
 */

// Patterns indicating acute, high-risk observation (without negation/historical qualification)
const ACUTE_RISK_TERMS = [
  /\bsuicid/i,
  /\bself[\s\-]?harm/i,
  /\bself[\s\-]?injur/i,
  /\bcut(ting)?\s*(self|herself|himself|wrists|arms)/i,
  /\bharm(ing)?\s*(self|herself|himself)/i,
  /\battempt(ed)?\s*(suicide|self[\s\-]?harm)/i,
  /\bactive\s+crisis\b/i,
  /\bemergency\s+hospitali[sz]ation\b/i,
  /\bsevere\s+physical\s+danger\b/i
];

// Moderate risk patterns (not acute life-safety, but warrants human clinical review)
const MODERATE_RISK_TERMS = [
  /\bsetback/i,
  /\bdeteriorat/i,
  /\bsevere\s+declin/i,
  /\bregress/i,
  /\bdissociat/i,
  /\bflashback/i,
  /\bpanic\s+attack/i,
  /\bsevere\s+distress/i,
  /\bacute\s+anxiety/i
];

// Negation patterns: when a risk keyword is preceded or modified by these, it is a documented negative
const NEGATION_PATTERNS = [
  /\bno\b/i,
  /\bdeni(es|ed|ying)\b/i,
  /\bwithout\b/i,
  /\bnone\b/i,
  /\bzero\b/i,
  /\bnot\s+exhibiting\b/i,
  /\bno\s+evidence\s+of\b/i,
  /\bnegative\s+for\b/i,
  /\bnot\s+reporting\b/i,
  /\bfree\s+of\b/i,
  /\babsent\b/i,
  /\bnil\b/i,
  /\bnot\s+observed\b/i,
  /\bnone\s+observed\b/i,
  /\bno\s+signs\s+of\b/i,
  /\bruled\s+out\b/i
];

// Historical qualification patterns: indicates prior/resolved risk, NOT current acute crisis
const HISTORICAL_PATTERNS = [
  /\bhistory\s+of\b/i,
  /\bpast\b/i,
  /\bprior\s+to\b/i,
  /\bpreviously\b/i,
  /\bformer\b/i,
  /\bresolved\b/i,
  /\bold\s+scars\b/i,
  /\byears\s+ago\b/i,
  /\bmonths\s+ago\b/i,
  /\bat\s+intake\b/i,
  /\bin\s+childhood\b/i,
  /\bhistoric(al)?\b/i
];

// Fields that must be checked for safety patterns
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
 * Classify a specific clause containing a keyword match.
 *
 * @param {string} clause - sentence or clause text
 * @param {RegExp} matchPattern - pattern that matched
 * @returns {'documented_negative' | 'historical_risk' | 'current_acute_risk'}
 */
function classifyRiskClause(clause, matchPattern) {
  const lowerClause = clause.toLowerCase().trim();

  // 1. Check for explicit negation
  for (const neg of NEGATION_PATTERNS) {
    if (neg.test(lowerClause)) {
      return 'documented_negative';
    }
  }

  // 2. Check for historical qualification
  for (const hist of HISTORICAL_PATTERNS) {
    if (hist.test(lowerClause)) {
      return 'historical_risk';
    }
  }

  // 3. Otherwise it is an active/acute finding
  return 'current_acute_risk';
}

/**
 * Split clinical free text into analysable clauses.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitIntoClauses(text) {
  if (!text || typeof text !== 'string') return [];
  // Split on periods, semicolons, commas followed by conjunctions, newlines
  return text
    .split(/(?:\.|\n|;|\band\b|\bbut\b|\bhowever\b)+/i)
    .map(s => s.trim())
    .filter(s => s.length > 2);
}

/**
 * Evaluate safety rules deterministically against current and historical audit fields.
 *
 * Returns:
 * - urgent: true ONLY if acute active risk is present in the current audit.
 * - requiresHumanReview: true if acute risk, moderate concern, or historical safety events exist.
 * - safetyTimeline: structured breakdown of acute, historical, and negative findings.
 *
 * @param {Object} currentAudit - plain JS audit object
 * @param {Array} historicalSafetyAudits - list of prior critical safety audits
 * @returns {Object} Deterministic safety assessment
 */
function evaluateSafety(currentAudit, historicalSafetyAudits = []) {
  const flags = [];
  const acuteFindings = [];
  const historicalFindings = [];
  const negativeFindings = [];
  const moderateFindings = [];

  if (!currentAudit || typeof currentAudit !== 'object') {
    return {
      urgent: false,
      requiresHumanReview: false,
      currentRiskLevel: 'none',
      safetyFlags: [],
      safetyTimeline: { acuteFindings: [], historicalFindings: [], negativeFindings: [], moderateFindings: [] }
    };
  }

  // 1. Check high-risk fields for acute, negative, or historical findings
  for (const field of HIGH_RISK_FIELDS) {
    const value = currentAudit[field];
    if (!value || typeof value !== 'string' || value.trim() === '') continue;

    const clauses = splitIntoClauses(value);
    for (const clause of clauses) {
      // In selfHarmBehaviors field, specific terms like cutting, burning, scratching represent self-harm
      const patterns = field === 'selfHarmBehaviors'
        ? [...ACUTE_RISK_TERMS, /\bcut(ting|s)?\b/i, /\bscratch(ing)?\b/i, /\bburn(ing)?\b/i]
        : ACUTE_RISK_TERMS;

      for (const pattern of patterns) {
        if (pattern.test(clause)) {
          const classification = classifyRiskClause(clause, pattern);
          const finding = {
            field,
            clause,
            matchedPattern: pattern.source,
            classification
          };

          if (classification === 'current_acute_risk') {
            acuteFindings.push(finding);
            flags.push({ field, severity: 'acute', clause, pattern: pattern.source });
          } else if (classification === 'historical_risk') {
            historicalFindings.push(finding);
            flags.push({ field, severity: 'historical', clause, pattern: pattern.source });
          } else if (classification === 'documented_negative') {
            negativeFindings.push(finding);
            flags.push({ field, severity: 'documented_negative', clause, pattern: pattern.source });
          }
          break; // Avoid double-matching same clause with multiple patterns
        }
      }
    }
  }

  // 2. Check moderate risk fields
  for (const field of MODERATE_RISK_FIELDS) {
    const value = currentAudit[field];
    if (!value || typeof value !== 'string' || value.trim() === '') continue;

    const clauses = splitIntoClauses(value);
    for (const clause of clauses) {
      for (const pattern of MODERATE_RISK_TERMS) {
        if (pattern.test(clause)) {
          const isNegated = NEGATION_PATTERNS.some(neg => neg.test(clause.toLowerCase()));
          if (!isNegated) {
            moderateFindings.push({ field, clause, pattern: pattern.source });
            flags.push({ field, severity: 'moderate', clause, pattern: pattern.source });
          }
          break;
        }
      }
    }
  }

  // 3. Process historical safety events from past audits
  const priorSafetyCount = Array.isArray(historicalSafetyAudits) ? historicalSafetyAudits.length : 0;
  if (priorSafetyCount > 0) {
    flags.push({
      severity: 'historical_record',
      count: priorSafetyCount,
      note: `Patient history contains ${priorSafetyCount} recorded historical safety observations.`
    });
  }

  // Determine final status
  const hasAcuteRisk = acuteFindings.length > 0;
  const hasModerateConcern = moderateFindings.length > 0;
  const hasHistoricalSafety = historicalFindings.length > 0 || priorSafetyCount > 0;

  const urgent = hasAcuteRisk;
  const requiresHumanReview = hasAcuteRisk || hasModerateConcern || hasHistoricalSafety;

  let currentRiskLevel = 'none';
  if (hasAcuteRisk) {
    currentRiskLevel = 'acute';
  } else if (hasModerateConcern) {
    currentRiskLevel = 'moderate';
  } else if (hasHistoricalSafety) {
    currentRiskLevel = 'historical_context';
  }

  return {
    urgent,
    requiresHumanReview,
    currentRiskLevel,
    safetyFlags: flags,
    safetyTimeline: {
      acuteFindings,
      historicalFindings,
      negativeFindings,
      moderateFindings,
      priorSafetyCount
    }
  };
}

module.exports = {
  evaluateSafety,
  classifyRiskClause,
  splitIntoClauses,
  ACUTE_RISK_TERMS,
  MODERATE_RISK_TERMS,
  NEGATION_PATTERNS,
  HISTORICAL_PATTERNS
};
