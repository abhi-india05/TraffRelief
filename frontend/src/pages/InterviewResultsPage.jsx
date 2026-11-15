import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import Footer from "../components/Footer";
import StaffNavbar from "../components/StaffNavbar";

export default function InterviewResultsPage() {
  const { hashId } = useParams();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const token = localStorage.getItem("token");

  useEffect(() => {
    if (!hashId) {
      setError("Missing identifier");
      setLoading(false);
      return;
    }
    const fetchResults = async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `http://localhost:5000/staff/release/${encodeURIComponent(hashId)}/results`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Failed to load results");
        }

        setResult(data.release);
      } catch (err) {
        setError(err.message || "Failed to load results");
      } finally {
        setLoading(false);
      }
    };
    fetchResults();
  }, [hashId, token]);

  const formatScore = (score) => {
    const num = parseFloat(score);
    if (isNaN(num)) return "0.0%";
    return (num * 100).toFixed(1) + "%";
  };

  const isKannada = result?.interviewLanguage === "kn";
  const isGnaniPrisma = result?.transcriptionProvider === "gnani_prisma";

  return (
    <main className="w-full min-h-screen bg-stone-100 font-['QuickSand'] pt-20">
      <StaffNavbar />
      <div className="p-8 max-w-4xl mx-auto">
        <div className="bg-white rounded-2xl shadow p-8 border border-gray-200">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-6">
            <div>
              <h2 className="text-3xl font-bold text-gray-800">Rehabilitation Interview Results</h2>
              <p className="text-sm text-gray-500 mt-1">
                Post-release voice interview screening and mental-health indicator evaluation.
              </p>
            </div>

            {/* Badges */}
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${
                  isKannada
                    ? "bg-amber-100 text-amber-900 border border-amber-300"
                    : "bg-blue-100 text-blue-900 border border-blue-300"
                }`}
              >
                {isKannada ? "ಕನ್ನಡ (Kannada)" : "English"}
              </span>

              {isGnaniPrisma ? (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-900 border border-emerald-300">
                  Gnani Prisma STT (Codemix)
                </span>
              ) : (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-300">
                  {result?.transcriptionProvider ? `STT: ${result.transcriptionProvider}` : "STT: Gemini"}
                </span>
              )}
            </div>
          </div>

          {loading ? (
            <div className="py-16 text-center text-gray-500">
              <p className="text-lg">Loading interview results...</p>
            </div>
          ) : error ? (
            <div className="py-8 text-center text-red-600 bg-red-50 rounded-xl my-6 p-4 border border-red-200">
              <p className="font-semibold">{error}</p>
            </div>
          ) : !result ? (
            <div className="py-16 text-center text-gray-500">
              <p>No results available for this interview.</p>
            </div>
          ) : (
            <div className="space-y-6 mt-6">
              {/* Primary Signal Verdict Card */}
              {result.verdict && (
                <div className="p-4 rounded-xl bg-teal-50 border-2 border-teal-500 flex items-center justify-between">
                  <div>
                    <span className="text-xs uppercase tracking-wider font-bold text-teal-800">
                      Primary Mental-Health Indicator
                    </span>
                    <h3 className="text-2xl font-bold text-teal-900 capitalize mt-0.5">
                      {result.verdict.replace(/_/g, " ")}
                    </h3>
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-semibold text-teal-800">Confidence Score</span>
                    <p className="text-2xl font-bold text-teal-900">
                      {formatScore(result.results?.[result.verdict] || 0)}
                    </p>
                  </div>
                </div>
              )}

              {/* English Analysis Summary (Clinical distillation) */}
              {result.summary && (
                <div className="border border-gray-200 rounded-xl p-5 bg-stone-50">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-lg font-semibold text-gray-800">
                      {isKannada ? "English Clinical Summary (Translated)" : "Clinical Analysis Summary"}
                    </h3>
                    {isKannada && (
                      <span className="text-xs bg-stone-200 text-stone-700 px-2.5 py-0.5 rounded-full font-medium">
                        Translated for DeBERTa Classifier
                      </span>
                    )}
                  </div>
                  <p className="text-gray-700 leading-relaxed font-sans">{result.summary}</p>
                </div>
              )}

              {/* 7-Category Indicator Breakdown */}
              <div className="border border-gray-200 rounded-xl p-5 bg-white">
                <h3 className="text-lg font-semibold text-gray-800 mb-1">Classification Breakdown</h3>
                <p className="text-xs text-gray-500 mb-4">
                  Multi-class probability distribution across all 7 mental-health evaluation categories.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {Object.entries(result.results || {}).map(([key, value]) => {
                    const isPrimary = key === result.verdict;
                    return (
                      <div
                        key={key}
                        className={`p-3.5 rounded-lg border transition-all ${
                          isPrimary
                            ? "bg-teal-50 border-teal-500 shadow-sm"
                            : "bg-gray-50 border-gray-200 hover:bg-gray-100"
                        }`}
                      >
                        <div className="flex items-center justify-between text-xs text-gray-600 capitalize font-medium">
                          <span>{key.replace(/_/g, " ")}</span>
                          {isPrimary && (
                            <span className="text-xs text-teal-700 font-bold">Primary</span>
                          )}
                        </div>
                        <div className="text-xl font-bold text-gray-800 mt-1">
                          {formatScore(value)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Full Transcription */}
              <div className="border border-gray-200 rounded-xl p-5 bg-white">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-lg font-semibold text-gray-800">
                    {isKannada ? "Original Audio Transcription (Kannada / Code-Mixed)" : "Full Audio Transcription"}
                  </h3>
                  {isKannada && (
                    <span className="text-xs text-gray-500">
                      STT Engine: {result.transcriptionModel || "Gnani Prisma v3.0"}
                    </span>
                  )}
                </div>
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                  <p className="whitespace-pre-wrap text-gray-800 font-sans text-base leading-relaxed">
                    {result.transcription || "No transcription text recorded."}
                  </p>
                </div>
              </div>

              {/* Clinical Screening Disclaimer */}
              <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 leading-relaxed">
                <strong className="font-bold">Clinical Care Notice: </strong>
                The mental-health classification and voice transcriptions presented above are automated screening signals intended to assist rehabilitation staff. Automated voice transcription, translation, and classification must be clinically evaluated by qualified rehabilitation and social work professionals and should not be used as an independent clinical diagnosis.
              </div>

              {/* Metadata Footer */}
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center pt-2 text-xs text-gray-500 border-t gap-2">
                <div>
                  Interview Language: <strong className="text-gray-700">{isKannada ? "Kannada (kn)" : "English (en)"}</strong>
                  {result.detectedLanguage && (
                    <span className="ml-2">| Detected: <strong className="text-gray-700">{result.detectedLanguage}</strong></span>
                  )}
                </div>
                <div>
                  Submitted: {result.submittedTime ? new Date(result.submittedTime).toLocaleString() : "N/A"}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <Footer />
    </main>
  );
}
