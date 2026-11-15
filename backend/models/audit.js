/*const mongoose = require('mongoose');
const { Schema } = mongoose;

const ResultSchema = new Schema({
  
  domain_evaluations: {

    medical_physical: {
      status: {
        type: String,
        enum: ["improving", "no_change", "declining"],
        required: true
      },
      score: { type: Number, required: true },
      confidence: { type: Number, required: true },
      reasons: [{ type: String, required: true }],
      evidence: [{ type: String, required: true }]
    },

    trauma_indicators: {
      status: {
        type: String,
        enum: ["improving", "no_change", "declining"],
        required: true
      },
      score: { type: Number, required: true },
      confidence: { type: Number, required: true },
      reasons: [{ type: String, required: true }],
      evidence: [{ type: String, required: true }]
  },

  progress_tracking: {
    status: {
        type: String,
        enum: ["improving", "no_change", "declining"],
        required: true
      },
      score: { type: Number, required: true },
      confidence: { type: Number, required: true },
      reasons: [{ type: String, required: true }],
      evidence: [{ type: String, required: true }]
    },
  
  urgent: { type: Boolean, required: true },
  recommended_actions: [{ type: String, required: true }],
  fit_for_discharge: {
      type: Boolean,
      required: true,
      default: false
    },

    next_audit_date: { 
      type: Date 
    }
}});

const AuditSchema = new Schema({
  auditId:{
    type: String,
    required: true,
    unique: true
  },
  victimId:{
    type: Schema.Types.ObjectId,
    ref: 'Victim',
    required: true
  },

  submittedBy:{
    type: Schema.Types.ObjectId,
    ref: 'Staff',
    required: true
  },
  // medical and physical
  currentPhysicalSymptoms: String,
  physicalInjuriesSustained: String,
  medicalConditionsRequiringTreatment: String,
  currentMedicationsAndNeeds: String,
  nutritionalStatus: String,
  sleepPatterns: String,

  // psychological and emotional assessment
  traumaIndicators: String,
  depressionSymptoms: String,
  anxietyIndicators: String,
  dissociativeEpisodes: String,
  selfHarmBehaviors: String,
  emotionalRegulationChallenges: String,
  trustAndRelationshipIssues: String,
  factorsAffectingMentalHealth: String,
  additionalNote: String,

  // progress tracking
  gamesActivitiesTasksPerformedConductedGiven: String,
  therapyAttendanceRate: String,
  treatmentCompliance: String,
  skillDevelopmentMilestones: String,
  behavioralImprovements: String,
  goalAchievementProgress: String,
  setbacksIndicator: String,
  medicationAdherence: String,
  additionalNoteProgress: String,

  // new result field
  isFirst:{ type: Boolean, default: false },
  result: { type: ResultSchema, default:null},
  generatedResults: { type: Boolean, default: false },
  {
  timestamps:{createdAt:"timestamp",updatedAt:false}
  }
});

module.exports = mongoose.model('Audit', AuditSchema);
*/
const mongoose = require('mongoose');
const { Schema } = mongoose;

// Reusable sub-schema for per-domain RAG evidence references
const evidenceReferenceSchema = new Schema({
  auditId: String,
  date: Date,
  field: String,
  observation: String,
  sourceType: { type: String, enum: ['structured', 'semantic', 'safety'] }
}, { _id: false });

const ResultSchema = new Schema({
  domain_evaluations: {
    medical_physical: {
      status: {
        type: String,
        enum: ["improving", "no_change", "declining", "insufficient_data"],
        required: true
      },
      reasons: [{ type: String, required: true }],
      evidence: [{ type: String, required: true }],
      // Extended RAG fields (new — existing [String] evidence preserved)
      evidenceReferences: [evidenceReferenceSchema],
      dataSufficiency: {
        type: String,
        enum: ['sufficient', 'limited', 'insufficient'],
        default: 'sufficient'
      }
    },

    trauma_indicators: {
      status: {
        type: String,
        enum: ["improving", "no_change", "declining", "insufficient_data"],
        required: true
      },
      reasons: [{ type: String, required: true }],
      evidence: [{ type: String, required: true }],
      // Extended RAG fields
      evidenceReferences: [evidenceReferenceSchema],
      dataSufficiency: {
        type: String,
        enum: ['sufficient', 'limited', 'insufficient'],
        default: 'sufficient'
      }
    },

    progress_tracking: {
      status: {
        type: String,
        enum: ["improving", "no_change", "declining", "insufficient_data"],
        required: true
      },
      reasons: [{ type: String, required: true }],
      evidence: [{ type: String, required: true }],
      // Extended RAG fields
      evidenceReferences: [evidenceReferenceSchema],
      dataSufficiency: {
        type: String,
        enum: ['sufficient', 'limited', 'insufficient'],
        default: 'sufficient'
      }
    }
  },

  urgent: { type: Boolean, required: true },
  recommended_actions: [{ type: String, required: true }],
  fit_for_discharge: {
    type: Boolean,
    required: true,
    default: false
  },

  next_audit_date: { type: Date },

  // Top-level RAG additions
  requires_human_review: { type: Boolean, default: false },
  retrievalMetadata: {
    retrievalMode: { type: String, enum: ['structured_only', 'hybrid'], default: 'structured_only' },
    embeddingModel: String,
    retrievedAuditIds: [String],
    evaluationVersion: String
  }
});

const AuditSchema = new Schema(
  {
    auditId: {
      type: String,
      required: true,
      unique: true
    },
    victimId: {
      type: Schema.Types.ObjectId,
      ref: 'Victim',
      required: true
    },
    submittedBy: {
      type: Schema.Types.ObjectId,
      ref: 'Staff',
      required: true
    },

    // medical and physical
    currentPhysicalSymptoms: String,
    physicalInjuriesSustained: String,
    medicalConditionsRequiringTreatment: String,
    currentMedicationsAndNeeds: String,
    nutritionalStatus: String,
    sleepPatterns: String,

    // psychological and emotional assessment
    traumaIndicators: String,
    depressionSymptoms: String,
    anxietyIndicators: String,
    dissociativeEpisodes: String,
    selfHarmBehaviors: String,
    emotionalRegulationChallenges: String,
    trustAndRelationshipIssues: String,
    factorsAffectingMentalHealth: String,
    additionalNote: String,

    // progress tracking
    gamesActivitiesTasksPerformedConductedGiven: String,
    therapyAttendanceRate: String,
    treatmentCompliance: String,
    skillDevelopmentMilestones: String,
    behavioralImprovements: String,
    goalAchievementProgress: String,
    setbacksIndicator: String,
    medicationAdherence: String,
    additionalNoteProgress: String,

    // new result field
    isFirst: { type: Boolean, default: false },
    result: { type: ResultSchema, default: null },
    generatedResults: { type: Boolean, default: false },

    // RAG evaluation pipeline tracking
    evaluationStatus: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', 'requires_review'],
      default: 'pending'
    },
    evaluationError: { type: String, default: null },
    evaluationVersion: { type: String, default: null },
    indexingStatus: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending'
    },
    indexingError: { type: String, default: null }
  },
  {
    timestamps: { createdAt: 'timestamp', updatedAt: false } // ✅ correct place
  }
);

module.exports = mongoose.model('Audit', AuditSchema);
