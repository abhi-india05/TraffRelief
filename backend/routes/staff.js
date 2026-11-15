const express = require("express");
const router = express.Router();
const upload = require('../middlewares/upload');
const {
  getVictims,
  getVictimById,
  getStaffById,
  getNotifications,
  addInitialDetails,
  getStaffAudits,
  getMyVictims,
  getReleasedVictims
} = require("../controllers/staff.js");
const {
  addAudit,
  getPendingAudits,
  getAuditsByVictimId,
  getAuditDetails
} = require("../controllers/audit.js");
const { evaluateAudit, retryAuditEvaluation } = require("../controllers/gemini.js");
const {
  getVictimInterventions,
  createIntervention,
  updateIntervention
} = require("../controllers/intervention.js");
const {
  createRelease,
  submitRelease,
  viewReleaseResults,
  viewReleaseByVictim,
  getQuestionAudio
} = require("../controllers/release.js");
const { verifyToken } = require('../middlewares/authentication.js');
const { uploadCloud } = require("../utils/cloudinary.js");

router.get('/get-my-victims', verifyToken, getMyVictims);
router.get('/get-victims/:staffId', verifyToken, getVictims);
router.get('/get-victim/:victimId', verifyToken, getVictimById);
router.get('/get-staff/:staffId', verifyToken, getStaffById);
router.get('/getNotifications', verifyToken, getNotifications);
router.post('/add-initial-details', verifyToken, uploadCloud.single('photo'), addInitialDetails);
router.post('/:staffId/:victimId/add-audit', verifyToken, addAudit, evaluateAudit);
router.get('/:staffId/audits', verifyToken, getStaffAudits);
router.post('/:staffId/create-release/:victimId', verifyToken, createRelease);
router.get('/:staffId/:victimId/view-release', verifyToken, viewReleaseByVictim);
router.get('/:victimId/view-release', verifyToken, viewReleaseByVictim);
router.post("/release/:hashId/submit", upload.single("audio"), submitRelease);
router.get("/release/:hashId/results", verifyToken, viewReleaseResults);
router.get("/release/:hashId/question-audio/:questionId", getQuestionAudio);
router.get("/release/question-audio/:questionId", getQuestionAudio);

router.post('/:hashId', upload.single("audio"), submitRelease);
router.get('/pending-audits', verifyToken, getPendingAudits);
router.get('/:staffId/pending-audits', verifyToken, getPendingAudits);
router.get('/:staffId/released-victims', verifyToken, getReleasedVictims);
router.get('/victim/:victimId/audits', verifyToken, getAuditsByVictimId);
router.get('/audit-summary/:auditId', verifyToken, getAuditDetails);

// Evaluation retry and intervention routes
router.post('/audit/:auditId/retry-evaluation', verifyToken, retryAuditEvaluation);
router.get('/interventions/:victimId', verifyToken, getVictimInterventions);
router.post('/interventions/:victimId', verifyToken, createIntervention);
router.patch('/interventions/:interventionId', verifyToken, updateIntervention);

module.exports = router;
