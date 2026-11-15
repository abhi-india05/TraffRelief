require("dotenv").config();

const fs = require("fs");
const mongoose = require("mongoose");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { assertGeminiDataAccess, sanitizeClinicalText } = require("../services/geminiPrivacyPolicy");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BERT_URL = process.env.BERT_PREDICTION_URL; // Your FastAPI endpoint
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const Release = require("../models/release.js");
const Staff = require("../models/staff.js");
const Victim = require("../models/victim.js");
const Admin = require("../models/admin.js");
const prismaService = require("../services/gnani/prismaService");
const timbreService = require("../services/gnani/timbreService");
const { getQuestionById } = require("../services/gnani/interviewQuestions");

const createRelease = async (req, res) => {
  try {
    const { staffId, victimId } = req.params;
    const { id: authUserId, role: authRole } = req.user || {};

    if (!staffId || !victimId) {
      return res.status(400).json({ error: "staffId and victimId parameters are required" });
    }

    const victim = await Victim.findOne({ victimId: victimId });
    if (!victim) {
      return res.status(404).json({ error: "Victim not found" });
    }

    const staff = await Staff.findOne({ staffId: staffId });
    if (!staff) {
      return res.status(404).json({ error: "Staff not found" });
    }

    // Role-based authorization: staff must own victim and match parameter; admin must own victim's center
    if (authRole === "staff") {
      if (authUserId !== staffId || victim.staff?.toString() !== staff._id.toString()) {
        return res.status(403).json({ error: "You are not authorized to create releases for this victim" });
      }
    } else if (authRole === "admin") {
      const admin = await Admin.findOne({ adminId: authUserId });
      if (!admin || victim.admin?.toString() !== admin._id.toString()) {
        return res.status(403).json({ error: "Victim not under your administrative center" });
      }
    } else {
      return res.status(403).json({ error: "Unauthorized role" });
    }

    if (victim.status !== "released") {
      return res.status(400).json({ error: "Victim is not marked as Released" });
    }

    const hash = uuidv4();

    const newRelease = new Release({
      victimId: victim._id,
      staffId: staff._id,
      scheduledDate:  Date.now(),
      transcription: null,
      summary: null,
      results: {},
      hashLink: hash,
      submitted: false,
    });

    await newRelease.save();

    return res.status(201).json({
      message: "Release created successfully",
      release: {
        id: newRelease._id,
        hashLink: newRelease.hashLink,
        submitted: newRelease.submitted,
      },
    });
  } catch (error) {
    console.error("Error creating release:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

async function submitRelease(req, res) {
  let audioPath = null;
  try {
    const { hashId } = req.params;
    if (!hashId) {
      return res.status(400).json({ error: "hashId parameter is required" });
    }

    if (!req.file || !req.file.path) {
      return res.status(400).json({ error: "Audio file is required (field name: 'audio')" });
    }

    audioPath = req.file.path;

    // find release record and associated victim FIRST before invoking AI
    const releaseRecord = await Release.findOne({ hashLink: hashId }).populate("victimId");
    if (!releaseRecord) {
      return res.status(404).json({ error: "Release record not found" });
    }
    if (releaseRecord.submitted) {
      return res.status(400).json({ error: "Release has already been submitted" });
    }

    const victim = releaseRecord.victimId;
    const dataClassification = victim?.dataClassification || "real";
    const databaseName = mongoose.connection?.name || "";

    // Read audio buffer
    const audioBuffer = fs.readFileSync(audioPath);
    const audioMimeType = (req.body.mimeType || req.file.mimetype || 'audio/webm').split(';')[0].trim().toLowerCase();
    const interviewLanguage = (req.body.language || req.body.interviewLanguage || 'en').toLowerCase().trim();

    let transcript = '';
    let summary = '';
    let provider = 'gemini';
    let transcriptionModel = null;
    let transcriptionMode = null;
    let detectedLanguage = null;

    if (interviewLanguage === 'kn') {
      // --- KANNADA INTERVIEW PIPELINE (Gnani Prisma STT + Gemini Summary) ---
      provider = 'gnani_prisma';

      const prismaResult = await prismaService.transcribeAudio({
        audioBuffer,
        mimeType: audioMimeType,
        filename: req.file.originalname || `recording.${audioMimeType.split('/')[1] || 'webm'}`,
        dataClassification,
        patientId: victim?._id
      });

      transcript = prismaResult.transcript;
      transcriptionModel = prismaResult.model;
      transcriptionMode = prismaResult.mode;
      detectedLanguage = prismaResult.language;

      if (!transcript || transcript.trim() === '') {
        return res.status(422).json({
          error: "Prisma STT produced an empty transcription for the Kannada interview audio."
        });
      }

      console.log("[submitRelease] Kannada transcription completed via Prisma STT (length: %d chars)", transcript.length);

      // Translate and summarize Kannada transcript to English for the downstream classifier
      assertGeminiDataAccess({
        operation: "audio_summarization",
        dataClassification,
        databaseName
      });

      const sanitizedTranscript = sanitizeClinicalText(transcript);
      const translationSummarizationPrompt = `Translate and summarize this Kannada interview transcript into a single emotionally-aware English sentence. Retain distress and emotional expressions faithfully without inventing details or diagnosing.\nTranscript: "${sanitizedTranscript}"`;

      const summaryResult = await model.generateContent([{ text: translationSummarizationPrompt }]);
      summary = summaryResult.response.text().trim();
      console.log("[submitRelease] Kannada-to-English summary generated (length: %d chars)", summary.length);

    } else {
      // --- ENGLISH INTERVIEW PIPELINE (Gemini STT + Gemini Summary) ---
      provider = 'gemini';
      transcriptionModel = 'gemini-2.0-flash';

      assertGeminiDataAccess({
        operation: "audio_transcription",
        dataClassification,
        databaseName
      });

      const transcriptionPrompt = "Transcribe this audio accurately in English.";

      const transcriptionResult = await model.generateContent([
        { text: transcriptionPrompt },
        { inlineData: { mimeType: audioMimeType, data: audioBuffer.toString("base64") } },
      ]);

      transcript = transcriptionResult.response.text().trim();
      console.log("[submitRelease] English transcription completed via Gemini (length: %d chars)", transcript.length);

      assertGeminiDataAccess({
        operation: "audio_summarization",
        dataClassification,
        databaseName
      });

      const sanitizedTranscript = sanitizeClinicalText(transcript);
      const summarizationPrompt = `Summarize this text in one emotionally-aware English sentence. Keep distress or emotion keywords intact.\nText: "${sanitizedTranscript}"`;

      const summaryResult = await model.generateContent([{ text: summarizationPrompt }]);
      summary = summaryResult.response.text().trim();
      console.log("[submitRelease] English summary generated (length: %d chars)", summary.length);
    }

    // BERT / classification using English summary
    const bertResp = await axios.post(BERT_URL, { text: summary });
    const result = bertResp.data;
    console.log("[submitRelease] Sentiment analysis completed");

    // ensure results object exists
    releaseRecord.submitted = true;
    releaseRecord.submittedTime = Date.now();
    releaseRecord.transcription = transcript; // Original script (Kannada or English)
    releaseRecord.summary = summary; // English analysis summary
    releaseRecord.interviewLanguage = interviewLanguage === 'kn' ? 'kn' : 'en';
    releaseRecord.transcriptionProvider = provider;
    releaseRecord.transcriptionModel = transcriptionModel;
    releaseRecord.transcriptionMode = transcriptionMode;
    releaseRecord.detectedLanguage = detectedLanguage;
    releaseRecord.analysisLanguage = 'en';
    releaseRecord.processingStatus = 'completed';
    releaseRecord.processingError = null;
    releaseRecord.results = releaseRecord.results || {};

    // map BERT scores into results safely
    if (result && result.scores) {
      releaseRecord.results.anxiety = String(result.scores.LABEL_0 || 0);
      releaseRecord.results.bipolar = String(result.scores.LABEL_1 || 0);
      releaseRecord.results.depression = String(result.scores.LABEL_2 || 0);
      releaseRecord.results.normal = String(result.scores.LABEL_3 || 0);
      releaseRecord.results.personality_disorder = String(result.scores.LABEL_4 || 0);
      releaseRecord.results.stress = String(result.scores.LABEL_5 || 0);
      releaseRecord.results.suicidal = String(result.scores.LABEL_6 || 0);

      // pick top label
      let highest = -1;
      let highestkey = "";
      for (const key in result.scores) {
        if (result.scores[key] > highest) {
          highest = result.scores[key];
          highestkey = key;
        }
      }
      const labelMap = {
        LABEL_0: "anxiety",
        LABEL_1: "bipolar",
        LABEL_2: "depression",
        LABEL_3: "normal",
        LABEL_4: "personality_disorder",
        LABEL_5: "stress",
        LABEL_6: "suicidal",
      };
      releaseRecord.verdict = labelMap[highestkey] || "";
    }

    await releaseRecord.save();

    return res.status(200).json({ message: "Release submitted successfully", release: releaseRecord });
  } catch (error) {
    console.error("Error submitting release:", error.message || error);
    res.status(500).json({ error: error.message || "Internal server error" });
  } finally {
    // Guaranteed cleanup of uploaded temporary audio file
    if (audioPath) {
      try {
        if (fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath);
        }
      } catch (e) {
        // ignore unlink error
      }
    }
  }
}

async function getQuestionAudio(req, res) {
  try {
    const { questionId, hashId } = req.params;
    const { lang = 'kn' } = req.query;

    if (hashId) {
      const releaseRecord = await Release.findOne({ hashLink: hashId });
      if (!releaseRecord) {
        return res.status(404).json({ error: "Release record not found" });
      }
      if (releaseRecord.submitted) {
        return res.status(400).json({ error: "Interview has already been submitted" });
      }
    }

    const normalizedLang = (lang || 'kn').toLowerCase();
    if (normalizedLang !== 'kn') {
      return res.status(400).json({ error: 'Question audio synthesis is currently supported for "kn" (Kannada).' });
    }

    const question = getQuestionById(questionId);
    if (!question) {
      return res.status(400).json({ error: `Invalid question ID "${questionId}". Must be one of q1 through q5.` });
    }

    const ttsResult = await timbreService.getQuestionAudio({
      questionId: question.id,
      language: normalizedLang
    });

    res.set({
      'Content-Type': ttsResult.contentType || 'audio/wav',
      'Content-Length': ttsResult.audioBuffer.length,
      'Cache-Control': 'public, max-age=86400',
      'X-Audio-From-Cache': String(ttsResult.fromCache)
    });

    return res.status(200).send(ttsResult.audioBuffer);
  } catch (err) {
    console.warn('[getQuestionAudio] Question audio playback unavailable:', err.message);
    return res.status(503).json({
      error: "Question audio playback currently unavailable",
      details: err.message
    });
  }
}

async function viewReleaseResults(req, res) {
  try {
    const { hashId } = req.params;
    const { id: authUserId, role: authRole } = req.user || {};

    if (!hashId) {
      return res.status(400).json({ error: "hashId parameter is required" });
    }

    const releaseRecord = await Release.findOne({ hashLink: hashId }).populate("victimId").populate("staffId");
    if (!releaseRecord) {
      return res.status(404).json({ error: "Release record not found" });
    }

    const victim = releaseRecord.victimId;
    if (!victim) {
      return res.status(404).json({ error: "Associated victim not found" });
    }

    // Role-based patient isolation check
    if (authRole === "staff") {
      const staff = await Staff.findOne({ staffId: authUserId });
      if (!staff || victim.staff?.toString() !== staff._id.toString()) {
        return res.status(403).json({ error: "You are not assigned to this victim" });
      }
    } else if (authRole === "admin") {
      const admin = await Admin.findOne({ adminId: authUserId });
      if (!admin || victim.admin?.toString() !== admin._id.toString()) {
        return res.status(403).json({ error: "Victim not under your administrative center" });
      }
    } else {
      return res.status(403).json({ error: "Unauthorized role" });
    }

    if (!releaseRecord.submitted) {
      return res.status(400).json({ error: "Release has not been submitted yet" });
    }

    return res.status(200).json({ release: releaseRecord });
  } catch (error) {
    console.error("Error fetching release results:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

async function viewReleaseByVictim(req, res) {
  try {
    const { victimId } = req.params;
    const { id: authUserId, role: authRole } = req.user || {};

    if (!victimId) {
      return res.status(400).json({ error: "victimId parameter is required" });
    }

    const victim = await Victim.findOne({ victimId });
    if (!victim) {
      return res.status(404).json({ error: "Victim not found" });
    }

    // Role-based patient isolation check
    if (authRole === "staff") {
      const staff = await Staff.findOne({ staffId: authUserId });
      if (!staff || victim.staff?.toString() !== staff._id.toString()) {
        return res.status(403).json({ error: "You are not assigned to this victim" });
      }
    } else if (authRole === "admin") {
      const admin = await Admin.findOne({ adminId: authUserId });
      if (!admin || victim.admin?.toString() !== admin._id.toString()) {
        return res.status(403).json({ error: "Victim not under your administrative center" });
      }
    } else {
      return res.status(403).json({ error: "Unauthorized role" });
    }

    // fetch all releases for this victim, populate staff and victim, sort newest first
    const releaseRecords = await Release.find({ victimId: victim._id })
      .populate("staffId", "staffId fullName email")
      .populate("victimId", "victimId fullName")
      .sort({ createdAt: -1 });

    if (!Array.isArray(releaseRecords) || releaseRecords.length === 0) {
      return res.status(404).json({ error: "No release records found for this victim" });
    }

    return res.status(200).json({ releases: releaseRecords });
  } catch (error) {
    console.error("Error fetching release by victim:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}
// ...existing code...
module.exports = {
  createRelease,
  submitRelease,
  viewReleaseResults,
  viewReleaseByVictim,
  getQuestionAudio
};