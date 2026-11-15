import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import AdminNavbar from "../components/AdminNavbar";
import StaffNavbar from "../components/StaffNavbar";
import { getUserData } from "../utils/CommonFetches";

function AuditSummary() {
  const token = localStorage.getItem("token");
  const { auditId } = useParams();
  const navigate = useNavigate();

  const codeId = auditId;
  const [userData, setUserData] = useState(null);
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [interventions, setInterventions] = useState([]);

  useEffect(() => {
    if (!token) {
      setErr("Missing auth token");
      setLoading(false);
      return;
    }

    getUserData(token, setUserData);
  }, [token]);

  const fetchAuditData = async () => {
    if (!auditId || !token || !userData) return;
    try {
      setLoading(true);
      const url = `http://localhost:5000/admin/audit-summary/${auditId}`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Failed to fetch audit");
      }
      setAudit(data);
      setErr("");

      // Fetch interventions if victimId available
      if (data.victimId) {
        const victimIdStr = typeof data.victimId === "object" ? data.victimId.victimId || data.victimId._id : data.victimId;
        const rolePrefix = userData.role === "admin" ? "admin" : "staff";
        try {
          const intRes = await fetch(`http://localhost:5000/${rolePrefix}/interventions/${victimIdStr}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (intRes.ok) {
            const intData = await intRes.json();
            setInterventions(intData.interventions || []);
          }
        } catch {
          // ignore optional interventions fetch error
        }
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditData();
  }, [auditId, token, userData]);

  const handleRetryEvaluation = async () => {
    if (!token || !userData || !auditId) return;
    setRetrying(true);
    try {
      const rolePrefix = userData.role === "admin" ? "admin" : "staff";
      const res = await fetch(`http://localhost:5000/${rolePrefix}/audit/${auditId}/retry-evaluation`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || data.message || "Failed to retry evaluation");
      }
      await fetchAuditData();
    } catch (e) {
      alert(`Retry error: ${e.message}`);
    } finally {
      setRetrying(false);
    }
  };

  const fieldMap = useMemo(
    () => [
      ["Current Physical Symptoms", "currentPhysicalSymptoms"],
      ["Physical Injuries Sustained", "physicalInjuriesSustained"],
      ["Medical Conditions Requiring Treatment", "medicalConditionsRequiringTreatment"],
      ["Current Medications And Needs", "currentMedicationsAndNeeds"],
      ["Nutritional Status", "nutritionalStatus"],
      ["Sleep Patterns", "sleepPatterns"],
      ["Trauma Indicators", "traumaIndicators"],
      ["Depression Symptoms", "depressionSymptoms"],
      ["Anxiety Indicators", "anxietyIndicators"],
      ["Dissociative Episodes", "dissociativeEpisodes"],
      ["Self-harm Behaviors", "selfHarmBehaviors"],
      ["Emotional Regulation Challenges", "emotionalRegulationChallenges"],
      ["Trust And Relationship Issues", "trustAndRelationshipIssues"],
      ["Factors Affecting Mental Health", "factorsAffectingMentalHealth"],
      ["Additional Note", "additionalNote"],
      ["Games/Activities/Tasks", "gamesActivitiesTasksPerformedConductedGiven"],
      ["Therapy Attendance Rate", "therapyAttendanceRate"],
      ["Treatment Compliance", "treatmentCompliance"],
      ["Skill Development Milestones", "skillDevelopmentMilestones"],
      ["Behavioral Improvements", "behavioralImprovements"],
      ["Goal Achievement Progress", "goalAchievementProgress"],
      ["Setbacks Indicator", "setbacksIndicator"],
      ["Medication Adherence", "medicationAdherence"],
      ["Additional Note (Progress)", "additionalNoteProgress"],
    ],
    []
  );

  const nonEmpty = useMemo(() => {
    if (!audit) return [];
    return fieldMap.filter(([_, key]) => {
      const v = audit[key];
      return typeof v === "string" ? v.trim().length > 0 : !!v;
    });
  }, [audit, fieldMap]);

  const displayDate = (d) => (d ? new Date(d).toLocaleDateString() : "N/A");

  const getStatusBadgeClass = (status) => {
    switch (status) {
      case "improving":
        return "bg-emerald-100 text-emerald-800 border-emerald-300";
      case "declining":
        return "bg-rose-100 text-rose-800 border-rose-300";
      case "no_change":
        return "bg-blue-100 text-blue-800 border-blue-300";
      case "insufficient_data":
      default:
        return "bg-amber-100 text-amber-800 border-amber-300";
    }
  };

  const renderDomainCard = (domainKey, label, domainData) => {
    if (!domainData) return null;
    const statusClass = getStatusBadgeClass(domainData.status);

    return (
      <div key={domainKey} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between border-b pb-3 mb-3">
          <div className="font-semibold text-slate-800">{label}</div>
          <div className="flex items-center gap-2">
            {domainData.dataSufficiency && (
              <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600 capitalize">
                Data: {domainData.dataSufficiency}
              </span>
            )}
            <span className={`text-xs uppercase font-bold tracking-wider px-2.5 py-1 rounded-full border ${statusClass}`}>
              {domainData.status?.replace("_", " ")}
            </span>
          </div>
        </div>

        {Array.isArray(domainData.reasons) && domainData.reasons.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Longitudinal Assessment & Reasons
            </div>
            <ul className="list-disc list-inside space-y-1 text-sm text-slate-700">
              {domainData.reasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </div>
        )}

        {Array.isArray(domainData.evidence) && domainData.evidence.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Documented Evidence
            </div>
            <ul className="list-disc list-inside space-y-1 text-sm text-slate-600 bg-slate-50 rounded-lg p-2.5">
              {domainData.evidence.map((ev, i) => (
                <li key={i}>{ev}</li>
              ))}
            </ul>
          </div>
        )}

        {Array.isArray(domainData.evidenceReferences) && domainData.evidenceReferences.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-100">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              Traceable Historical References
            </div>
            <div className="space-y-1.5">
              {domainData.evidenceReferences.map((ref, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between text-xs bg-teal-50 border border-teal-200 rounded p-2 text-teal-900"
                >
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => navigate(`/audit-summary/${ref.auditId}`)}
                      className="font-mono font-bold text-teal-700 hover:underline hover:text-teal-900 bg-white px-1.5 py-0.5 rounded border border-teal-300"
                    >
                      {ref.auditId}
                    </button>
                    {ref.field && <span className="text-slate-600 font-medium">{ref.field}:</span>}
                    <span className="text-slate-800">{ref.observation || "Observed condition"}</span>
                  </div>
                  {ref.date && (
                    <span className="text-slate-500 text-[11px] shrink-0 ml-2">
                      {displayDate(ref.date)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const resultBlock = () => {
    const r = audit?.result;
    const evalStatus = audit?.evaluationStatus;

    if (!r && evalStatus === "processing") {
      return (
        <div className="w-full rounded-xl border border-blue-400 bg-blue-50 text-blue-900 p-5 flex items-center justify-between">
          <div>
            <div className="font-semibold text-base mb-1">AI Longitudinal Evaluation In Progress...</div>
            <div className="text-sm text-blue-700">
              Gemini is assembling historical evidence and analyzing patient trajectory.
            </div>
          </div>
          <button
            onClick={fetchAuditData}
            className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700 transition"
          >
            Refresh
          </button>
        </div>
      );
    }

    if (!r || evalStatus === "failed") {
      return (
        <div className="w-full rounded-xl border border-amber-300 bg-amber-50 text-amber-900 p-5">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold text-base">
              {evalStatus === "failed" ? "AI Evaluation Incomplete or Failed" : "No AI Result Generated Yet"}
            </div>
            <button
              onClick={handleRetryEvaluation}
              disabled={retrying}
              className="px-4 py-1.5 rounded-lg bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 transition disabled:opacity-50"
            >
              {retrying ? "Retrying..." : "Run AI Evaluation"}
            </button>
          </div>
          {audit?.evaluationError && (
            <div className="text-xs font-mono bg-white p-2 rounded border border-amber-200 text-rose-700 mt-2">
              Error details: {audit.evaluationError}
            </div>
          )}
        </div>
      );
    }

    const de = r.domain_evaluations || {};
    const retrievalMeta = r.retrievalMetadata || {};

    return (
      <div className="w-full rounded-xl border border-teal-600 bg-slate-50 p-6 shadow-sm space-y-6">
        {/* Header with Badges */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
          <div>
            <div className="text-xl font-bold text-teal-800">
              Longitudinal AI Rehabilitation Assessment
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Engine: <span className="font-semibold">{retrievalMeta.evaluationVersion || "rag-v1"}</span>
              {retrievalMeta.retrievalMode && (
                <span className="ml-3 uppercase tracking-wider text-teal-700 font-bold">
                  Mode: {retrievalMeta.retrievalMode.replace("_", " ")}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {r.urgent && (
              <span className="px-3 py-1 rounded-full text-xs font-bold bg-rose-600 text-white animate-pulse">
                URGENT CLINICAL ATTENTION
              </span>
            )}
            {r.requires_human_review && (
              <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-500 text-white">
                Requires Human Review
              </span>
            )}
            <button
              onClick={handleRetryEvaluation}
              disabled={retrying}
              className="text-xs text-teal-700 hover:text-teal-900 border border-teal-300 rounded px-2.5 py-1 hover:bg-teal-100 transition"
            >
              {retrying ? "Re-evaluating..." : "Re-run Evaluation"}
            </button>
          </div>
        </div>

        {/* Urgent Alert Banner */}
        {r.urgent && (
          <div className="p-4 rounded-xl border-2 border-rose-500 bg-rose-50 text-rose-900 text-sm">
            <span className="font-bold">HIGH RISK OBSERVATION DETECTED:</span> A safety pattern (self-harm, severe trauma, or acute injury) was identified in this or historical records. Mandatory professional clinical review is required before discharge or routine activities.
          </div>
        )}

        {/* 3 Domain Evaluations */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {renderDomainCard("medical_physical", "Medical & Physical Health", de.medical_physical)}
          {renderDomainCard("trauma_indicators", "Psychological & Emotional Health", de.trauma_indicators)}
          {renderDomainCard("progress_tracking", "Rehabilitation Progress", de.progress_tracking)}
        </div>

        {/* Timeline & Next Steps */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-white p-4 rounded-xl border border-slate-200 text-sm">
          <div>
            <span className="text-slate-500">Next Scheduled Audit:</span>{" "}
            <span className="font-semibold text-slate-800">
              {displayDate(r.next_audit_date)}
            </span>
          </div>
          <div>
            <span className="text-slate-500">Discharge Consideration:</span>{" "}
            <span className={`font-semibold ${r.fit_for_discharge ? "text-emerald-700" : "text-slate-700"}`}>
              {r.fit_for_discharge ? "Suggested for Review (AI Advisory Only)" : "Not Currently Recommended"}
            </span>
          </div>
        </div>

        {/* Recommended Actions */}
        {Array.isArray(r.recommended_actions) && r.recommended_actions.length > 0 && (
          <div className="bg-white p-4 rounded-xl border border-slate-200">
            <div className="text-sm font-semibold text-slate-800 mb-2.5">
              Recommended Clinical & Rehabilitation Actions
            </div>
            <div className="flex flex-wrap gap-2">
              {r.recommended_actions.map((act, idx) => (
                <span
                  key={idx}
                  className="px-3 py-1.5 rounded-lg border border-teal-200 bg-teal-50 text-teal-800 text-sm"
                >
                  {act}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Documented Interventions (Follow-up Tracking) */}
        {interventions.length > 0 && (
          <div className="bg-white p-4 rounded-xl border border-slate-200">
            <div className="text-sm font-semibold text-slate-800 mb-2.5">
              Tracked Interventions for Patient
            </div>
            <div className="space-y-2">
              {interventions.map((item) => (
                <div
                  key={item._id}
                  className="p-2.5 rounded-lg border border-slate-100 bg-slate-50 text-xs flex items-center justify-between"
                >
                  <div>
                    <span className="font-semibold text-slate-800">{item.recommendedIntervention}</span>
                    {item.staffNotes && (
                      <span className="text-slate-500 ml-2 italic">— {item.staffNotes}</span>
                    )}
                  </div>
                  <span className="px-2 py-0.5 rounded uppercase font-semibold text-[10px] bg-slate-200 text-slate-700">
                    {item.status?.replace("_", " ")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <main className="min-h-screen w-full font-['QuickSand'] flex flex-col bg-stone-100">
      {userData?.role === "admin" && <AdminNavbar />}
      {userData?.role === "staff" && <StaffNavbar />}

      <div className="w-full p-6 md:p-10">
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="text-teal-700 text-2xl font-semibold">
              Rehabilitation Audit Summary
            </div>
            <div className="mt-1 text-slate-600 text-sm">
              {codeId && (
                <span className="mr-3">
                  Code: <span className="font-medium text-slate-800">{codeId}</span>
                </span>
              )}
              {audit?.timestamp && (
                <span className="mr-3">
                  Date: <span className="font-medium text-slate-800">{displayDate(audit.timestamp)}</span>
                </span>
              )}
            </div>
          </div>
          <button
            onClick={() => navigate(-1)}
            className="px-4 py-2 rounded-lg border border-teal-500 text-teal-700 hover:bg-teal-50 transition"
          >
            Back
          </button>
        </div>

        {loading && (
          <div className="w-full rounded-xl border border-teal-600 bg-white p-4 text-teal-700">
            Loading audit details...
          </div>
        )}

        {!loading && err && (
          <div className="w-full rounded-xl border border-rose-400 bg-rose-50 p-4 text-rose-700">
            {err}
          </div>
        )}

        {!loading && audit && !err && (
          <div className="grid grid-cols-1 gap-6">
            <div className="w-full rounded-xl border border-teal-600 bg-white p-5">
              <div className="text-base font-semibold text-slate-800 mb-4 border-b pb-2">
                Recorded Clinical Assessment Fields
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {nonEmpty.map(([label, key]) => (
                  <div key={key} className="flex flex-col">
                    <div className="text-xs uppercase tracking-wide text-slate-500">
                      {label}
                    </div>
                    <div className="text-slate-800 text-sm mt-0.5">{audit[key]}</div>
                  </div>
                ))}
                {nonEmpty.length === 0 && (
                  <div className="text-slate-600">No fields to display.</div>
                )}
              </div>
            </div>
            {resultBlock()}
          </div>
        )}
      </div>
    </main>
  );
}

export default AuditSummary;
