const mongoose= require('mongoose');
const victim = require('./victim');

const releaseSchema=new mongoose.Schema({
    scheduledDate:{
        type:Date,
        required:true,
        default:Date.now()
    },
    submittedTime:{
        type:Date,
        default:null
    },
    victimId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:'Victim',
        required:true
    },

    staffId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:'Staff',
        required:true
    },
    transcription:{
        type:String,
        
    },
    summary:{
        type:String,
        
    },
   results:{
    anxiety:String,
    bipolar:String,
depression:String,
	normal:String,
 personality_disorder:String,
stress:String,
suicidal:String
   },
   submitted:{
    type:Boolean,
    default:false
   },
   hashLink:{
    type:String,
    required:true
   },

   verdict:{
    type:String,
    default:null
   },
   interviewLanguage: {
    type: String,
    enum: ['en', 'kn'],
    default: 'en'
   },
   transcriptionProvider: {
    type: String,
    enum: ['gemini', 'gnani_prisma'],
    default: 'gemini'
   },
   transcriptionModel: {
    type: String,
    default: null
   },
   transcriptionMode: {
    type: String,
    default: null
   },
   detectedLanguage: {
    type: String,
    default: null
   },
   analysisLanguage: {
    type: String,
    default: 'en'
   },
   processingStatus: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending'
   },
   processingError: {
    type: String,
    default: null
   }
}
);

   module.exports=mongoose.model("Release",releaseSchema);
   
    