'use strict';
/**
 * Synthetic patient fixtures for automated testing and baseline evaluation comparisons.
 * ALL data is strictly synthetic. Contains NO real patient or identifiable clinical information.
 */

const mongoose = require('mongoose');

const SYNTHETIC_VICTIM_ID_1 = new mongoose.Types.ObjectId();
const SYNTHETIC_VICTIM_ID_2 = new mongoose.Types.ObjectId();
const SYNTHETIC_STAFF_ID_1 = new mongoose.Types.ObjectId();
const SYNTHETIC_STAFF_ID_2 = new mongoose.Types.ObjectId();
const SYNTHETIC_ADMIN_ID_1 = new mongoose.Types.ObjectId();

// Scenario 1 & 2: Longitudinal patient with improving medical but declining trauma and recurring self-harm
const SYNTHETIC_PATIENT_1_AUDITS = [
  {
    _id: new mongoose.Types.ObjectId(),
    auditId: 'AUD-SYN-101',
    victimId: SYNTHETIC_VICTIM_ID_1,
    submittedBy: SYNTHETIC_STAFF_ID_1,
    timestamp: new Date('2026-01-10T10:00:00Z'),
    isFirst: true,
    currentPhysicalSymptoms: 'Severe fatigue, headaches, body aches from physical abuse.',
    physicalInjuriesSustained: 'Multiple contusions on torso and lower extremities.',
    medicalConditionsRequiringTreatment: 'Malnutrition, iron deficiency anemia.',
    currentMedicationsAndNeeds: 'Multivitamins, iron supplements, analgesics.',
    nutritionalStatus: 'Poor nutritional state, BMI 17.2.',
    sleepPatterns: 'Severe insomnia, frequent nightmares.',
    traumaIndicators: 'High distress, hypervigilance, emotional numbing.',
    depressionSymptoms: 'Frequent weeping, profound hopelessness.',
    anxietyIndicators: 'Severe generalized anxiety, panic attacks in crowded rooms.',
    dissociativeEpisodes: 'Occasional spacing out during interviews.',
    selfHarmBehaviors: 'None observed at intake.',
    emotionalRegulationChallenges: 'Easily overwhelmed by minor stressors.',
    trustAndRelationshipIssues: 'Extreme distrust of all staff and authority figures.',
    factorsAffectingMentalHealth: 'Fear of retaliation from traffickers.',
    additionalNote: 'Intake audit conducted following initial shelter rescue.',
    gamesActivitiesTasksPerformedConductedGiven: 'Refused initial recreational activities.',
    therapyAttendanceRate: 'Intake assessment only.',
    treatmentCompliance: 'Agreed to medical examination.',
    skillDevelopmentMilestones: 'Initial life skills assessment.',
    behavioralImprovements: 'Baseline established.',
    goalAchievementProgress: 'Immediate physical stabilization.',
    setbacksIndicator: 'None documented.',
    medicationAdherence: 'Initiated supplements under supervision.',
    additionalNoteProgress: 'Patient requires close monitoring.'
  },
  {
    _id: new mongoose.Types.ObjectId(),
    auditId: 'AUD-SYN-102',
    victimId: SYNTHETIC_VICTIM_ID_1,
    submittedBy: SYNTHETIC_STAFF_ID_1,
    timestamp: new Date('2026-02-10T10:00:00Z'),
    isFirst: false,
    currentPhysicalSymptoms: 'Mild headaches, fatigue significantly reduced.',
    physicalInjuriesSustained: 'Contusions healed, no new injuries.',
    medicalConditionsRequiringTreatment: 'Anemia resolving, improved iron levels.',
    currentMedicationsAndNeeds: 'Iron supplements continued.',
    nutritionalStatus: 'Weight gain of 2kg, appetite returning.',
    sleepPatterns: 'Sleep duration increased to 5 hours nightly.',
    traumaIndicators: 'Flashbacks triggered by loud noises, moderate anxiety.',
    depressionSymptoms: 'Persistent low mood, but participates in group dining.',
    anxietyIndicators: 'Moderate anxiety, panic attacks reduced to 1 per week.',
    dissociativeEpisodes: 'No dissociative episodes noted this month.',
    selfHarmBehaviors: 'Superficial scratching on forearms during distress.',
    emotionalRegulationChallenges: 'Able to use breathing exercises when anxious.',
    trustAndRelationshipIssues: 'Developing rapport with assigned social worker.',
    factorsAffectingMentalHealth: 'Uncertainty regarding legal case.',
    additionalNote: 'Psychological support intensified following scratching incident.',
    gamesActivitiesTasksPerformedConductedGiven: 'Participated in art therapy twice weekly.',
    therapyAttendanceRate: 'Attended 7 of 8 scheduled sessions.',
    treatmentCompliance: 'Adherent with medical recommendations.',
    skillDevelopmentMilestones: 'Began introductory computer literacy module.',
    behavioralImprovements: 'Interacting politely with peer residents.',
    goalAchievementProgress: 'Completed personal safety awareness workshop.',
    setbacksIndicator: 'Minor distress episode with scratching behavior.',
    medicationAdherence: 'Full compliance with iron therapy.',
    additionalNoteProgress: 'Engaging well in non-verbal art therapies.'
  },
  {
    _id: new mongoose.Types.ObjectId(),
    auditId: 'AUD-SYN-103',
    victimId: SYNTHETIC_VICTIM_ID_1,
    submittedBy: SYNTHETIC_STAFF_ID_1,
    timestamp: new Date('2026-03-10T10:00:00Z'),
    isFirst: false,
    currentPhysicalSymptoms: 'Physical symptoms resolved, good physical stamina.',
    physicalInjuriesSustained: 'No physical injuries sustained.',
    medicalConditionsRequiringTreatment: 'Anemia fully resolved.',
    currentMedicationsAndNeeds: 'No ongoing medical prescriptions required.',
    nutritionalStatus: 'Normal nutritional status, healthy BMI 19.8.',
    sleepPatterns: 'Sleeping 7 hours nightly with occasional restless periods.',
    traumaIndicators: 'Escalation in trauma nightmares following court summons.',
    depressionSymptoms: 'Increased depressive withdrawal, stopped eating lunch.',
    anxietyIndicators: 'Severe acute anxiety regarding upcoming court testimony.',
    dissociativeEpisodes: 'One dissociative episode during legal prep session.',
    selfHarmBehaviors: 'Patient engaged in self-harm (cutting forearm with paperclip).',
    emotionalRegulationChallenges: 'High emotional dysregulation, acute distress.',
    trustAndRelationshipIssues: 'Expressed fear that staff will share testimony details.',
    factorsAffectingMentalHealth: 'Imminent court appearance as prosecution witness.',
    additionalNote: 'Emergency psychiatric consultation scheduled due to cutting incident.',
    gamesActivitiesTasksPerformedConductedGiven: 'Withdrew from group computer classes.',
    therapyAttendanceRate: 'Missed 3 therapy sessions due to distress.',
    treatmentCompliance: 'Compliant with basic shelter rules, refusing group rooms.',
    skillDevelopmentMilestones: 'Computer literacy paused.',
    behavioralImprovements: 'Isolated in room, avoiding peers.',
    goalAchievementProgress: 'Legal orientation completed.',
    setbacksIndicator: 'Severe emotional setback and self-harm behavior documented.',
    medicationAdherence: 'Not applicable.',
    additionalNoteProgress: '1-on-1 crisis intervention protocol initiated.'
  }
];

// Patient 2: Separate patient for cross-patient isolation testing
const SYNTHETIC_PATIENT_2_AUDITS = [
  {
    _id: new mongoose.Types.ObjectId(),
    auditId: 'AUD-SYN-201',
    victimId: SYNTHETIC_VICTIM_ID_2,
    submittedBy: SYNTHETIC_STAFF_ID_2,
    timestamp: new Date('2026-02-01T10:00:00Z'),
    isFirst: true,
    currentPhysicalSymptoms: 'Sprained left ankle, untreated skin rash.',
    physicalInjuriesSustained: 'Ankle sprain sustained during escape.',
    medicalConditionsRequiringTreatment: 'Topical dermatitis, musculoskeletal rehabilitation.',
    currentMedicationsAndNeeds: 'Topical corticosteroid, anti-inflammatory gel.',
    nutritionalStatus: 'Adequate nutritional status.',
    sleepPatterns: 'Normal sleep patterns.',
    traumaIndicators: 'Mild situational anxiety, good emotional resilience.',
    depressionSymptoms: 'No clinical depression symptoms reported.',
    anxietyIndicators: 'Mild anticipatory anxiety about vocational training.',
    dissociativeEpisodes: 'None reported.',
    selfHarmBehaviors: 'No history or current observation of self-harm.',
    emotionalRegulationChallenges: 'Emotionally stable and cooperative.',
    trustAndRelationshipIssues: 'Open and communicative with shelter staff.',
    factorsAffectingMentalHealth: 'Eager to begin vocational employment.',
    additionalNote: 'Patient exhibits strong coping mechanisms.',
    gamesActivitiesTasksPerformedConductedGiven: 'Active participation in vocational sewing workshop.',
    therapyAttendanceRate: 'Attended 100% of counseling sessions.',
    treatmentCompliance: 'Complete compliance with physiotherapy.',
    skillDevelopmentMilestones: 'Earned level-1 tailoring certificate.',
    behavioralImprovements: 'Proactive community contributor in shelter.',
    goalAchievementProgress: 'Achieved vocational training milestones ahead of schedule.',
    setbacksIndicator: 'No setbacks documented.',
    medicationAdherence: 'Applying topical medications as directed.',
    additionalNoteProgress: 'Candidate for expedited community integration.'
  }
];

module.exports = {
  SYNTHETIC_VICTIM_ID_1,
  SYNTHETIC_VICTIM_ID_2,
  SYNTHETIC_STAFF_ID_1,
  SYNTHETIC_STAFF_ID_2,
  SYNTHETIC_ADMIN_ID_1,
  SYNTHETIC_PATIENT_1_AUDITS,
  SYNTHETIC_PATIENT_2_AUDITS
};

