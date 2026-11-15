import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { toast } from 'react-toastify'
import Footer from '../components/Footer'
import { INTERVIEW_QUESTIONS } from '../services/interviewQuestions'

// Audio Interview Page
// - Five questions appear one-by-one with bilingual support (English / Kannada)
// - Kannada questions support voice playback via Gnani Timbre TTS
// - Single MediaRecorder instance used across all questions
// - Preserves genuine audio MIME type (WebM, Ogg, MP3, etc.)
// - Pause (between questions) and resume (for next question) append audio
// - After final stop the entire audio blob is saved locally (IndexedDB) and can be uploaded

function getExtensionFromMime(mime) {
  const m = (mime || '').toLowerCase()
  if (m.includes('webm')) return '.webm'
  if (m.includes('ogg')) return '.ogg'
  if (m.includes('wav')) return '.wav'
  if (m.includes('mp4') || m.includes('m4a')) return '.mp4'
  if (m.includes('mp3') || m.includes('mpeg')) return '.mp3'
  return '.webm'
}

// --- Lightweight IndexedDB helpers (no external libs) ---
function openAudioDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('audio-db', 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function saveBlobToIDB(key, blob) {
  const db = await openAudioDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite')
    const store = tx.objectStore('files')
    const req = store.put(blob, key)
    req.onsuccess = () => resolve(true)
    req.onerror = () => reject(req.error)
  })
}

async function getBlobFromIDB(key) {
  const db = await openAudioDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readonly')
    const store = tx.objectStore('files')
    const req = store.get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

async function deleteBlobFromIDB(key) {
  const db = await openAudioDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite')
    const store = tx.objectStore('files')
    const req = store.delete(key)
    req.onsuccess = () => resolve(true)
    req.onerror = () => reject(req.error)
  })
}

export default function AudioInterviewPage() {
  const { hashId } = useParams()
  const [currentQuestion, setCurrentQuestion] = useState(0) // 0..4
  const [selectedLanguage, setSelectedLanguage] = useState('en') // 'en' | 'kn'
  const [recordingStatus, setRecordingStatus] = useState('idle') // 'idle' | 'recording' | 'paused' | 'ended' | 'permission-denied'
  const [isUploading, setIsUploading] = useState(false)
  const [savedExists, setSavedExists] = useState(false)
  const [savedUrl, setSavedUrl] = useState(null)
  const [savedMime, setSavedMime] = useState('audio/webm')
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const [ttsLoading, setTtsLoading] = useState(false)

  const mediaRecorderRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const audioChunksRef = useRef([]) // will hold all chunks across questions
  const advanceTimerRef = useRef(null)
  const ttsAudioRef = useRef(null)
  const SAVED_KEY = 'answers-complete'

  // helper to pick a supported mimeType
  const pickMimeType = () => {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp3'
    ]
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return ''
    }
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || ''
  }

  const stopTtsPlayback = () => {
    if (ttsAudioRef.current) {
      try {
        ttsAudioRef.current.pause()
        ttsAudioRef.current.currentTime = 0
      } catch (e) {
        // ignore
      }
      ttsAudioRef.current = null
    }
    setTtsPlaying(false)
    setTtsLoading(false)
  }

  // request microphone and create MediaRecorder once when user first starts
  const initMediaRecorder = async (forcePrompt = false) => {
    if (mediaRecorderRef.current) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream

      const mimeType = pickMimeType()
      const options = mimeType ? { mimeType } : {}
      const mr = new MediaRecorder(stream, options)

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data)
        }
      }

      mr.onstop = async () => {
        const actualMime = mr.mimeType || mimeType || 'audio/webm'
        const completeBlob = new Blob(audioChunksRef.current, { type: actualMime })
        setSavedMime(actualMime)
        try {
          await saveBlobToIDB(SAVED_KEY, completeBlob)
          setSavedExists(true)
          const url = URL.createObjectURL(completeBlob)
          setSavedUrl(url)
          toast.success('Recording saved locally')
        } catch (err) {
          console.error('Failed to save locally', err)
          toast.error('Failed to save recording locally')
        }

        audioChunksRef.current = []
        mediaRecorderRef.current = null
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((t) => t.stop())
          mediaStreamRef.current = null
        }

        setIsUploading(false)
      }

      mediaRecorderRef.current = mr
      if (recordingStatus === 'permission-denied') setRecordingStatus('idle')
    } catch (err) {
      console.error('Microphone permission or creation failed', err)
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError' || err.name === 'PermissionDeniedError')) {
        setRecordingStatus('permission-denied')
        toast.error('Microphone permission denied. Click "Allow Microphone" or enable microphone access in browser/site settings.')
      } else if (err && err.name === 'NotFoundError') {
        toast.error('No microphone found. Please connect a microphone and try again.')
      } else {
        toast.error('Unable to access microphone. Please allow microphone permissions.')
      }
      throw err
    }
  }

  // start or resume recording (always ensure TTS audio is stopped so question is not recorded)
  const startRecording = async () => {
    if (recordingStatus === 'permission-denied') {
      toast.error('Microphone permission denied. Click "Allow Microphone" and retry.')
      return
    }

    // Stop question audio playback immediately
    stopTtsPlayback()

    try {
      await initMediaRecorder()
    } catch (err) {
      return
    }
    const mr = mediaRecorderRef.current
    if (!mr) return

    try {
      if (mr.state === 'inactive') {
        mr.start()
      } else if (mr.state === 'paused') {
        mr.resume()
      }
      setRecordingStatus('recording')
    } catch (err) {
      console.error(err)
      toast.error('Recording failed to start/resume')
    }
  }

  const pauseForQuestion = () => {
    const mr = mediaRecorderRef.current
    if (!mr || mr.state !== 'recording') return
    try {
      mr.pause()
      setRecordingStatus('paused')

      advanceTimerRef.current = setTimeout(() => {
        stopTtsPlayback()
        setCurrentQuestion((idx) => Math.min(INTERVIEW_QUESTIONS.length - 1, idx + 1))
      }, 2000)
    } catch (err) {
      console.error('Pause failed', err)
      toast.error('Unable to pause recording')
    }
  }

  const stopSessionAndSave = async () => {
    stopTtsPlayback()
    const mr = mediaRecorderRef.current
    if (!mr) return
    try {
      setRecordingStatus('ended')
      setIsUploading(true)
      mr.stop()
    } catch (err) {
      console.error('Stop failed', err)
      toast.error('Unable to stop recorder')
      setIsUploading(false)
    }
  }

  const handleTtsPlayback = async () => {
    if (ttsPlaying) {
      stopTtsPlayback()
      return
    }

    try {
      setTtsLoading(true)
      const q = INTERVIEW_QUESTIONS[currentQuestion]
      const questionId = q ? q.id : `q${currentQuestion + 1}`
      const url = `http://localhost:5000/staff/release/${hashId}/question-audio/${questionId}?lang=kn`

      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause()
      }

      const audio = new Audio(url)
      ttsAudioRef.current = audio

      audio.onended = () => {
        setTtsPlaying(false)
        setTtsLoading(false)
      }

      audio.onerror = (e) => {
        console.warn('TTS question audio load error:', e)
        setTtsPlaying(false)
        setTtsLoading(false)
        toast.warn('Question audio unavailable. Please read the question on screen.')
      }

      await audio.play()
      setTtsPlaying(true)
    } catch (err) {
      console.warn('TTS play error:', err)
      toast.warn('Audio playback not supported or unavailable')
    } finally {
      setTtsLoading(false)
    }
  }

  const uploadAudioBlob = async (blobToUpload) => {
    try {
      setIsUploading(true)
      const actualType = blobToUpload.type || savedMime || 'audio/webm'
      const ext = getExtensionFromMime(actualType)
      const formData = new FormData()
      formData.append('audio', blobToUpload, `interview-recording${ext}`)
      formData.append('mimeType', actualType)
      formData.append('language', selectedLanguage)
      formData.append('questionsCount', INTERVIEW_QUESTIONS.length)

      const token = localStorage.getItem('token')
      const headers = {}
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      const res = await fetch(`http://localhost:5000/staff/${hashId}`, {
        method: 'POST',
        headers,
        body: formData
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: 'Failed to upload audio interview' }))
        toast.error(err.message || 'Failed to upload audio interview')
      } else {
        toast.success('Audio interview uploaded successfully')
        await deleteLocalSavedBlob()
      }
    } catch (err) {
      console.error('Upload error', err)
      toast.error('Upload failed, please try again')
    } finally {
      setIsUploading(false)
    }
  }

  const handleRecordButton = async () => {
    if (recordingStatus === 'permission-denied') {
      try {
        await initMediaRecorder(true)
        toast.info('If prompted, allow microphone for this site.')
      } catch (err) {
        // still denied
      }
      return
    }

    if (recordingStatus === 'idle') {
      await startRecording()
      return
    }

    if (recordingStatus === 'recording') {
      if (currentQuestion === INTERVIEW_QUESTIONS.length - 1) {
        if (advanceTimerRef.current) {
          clearTimeout(advanceTimerRef.current)
          advanceTimerRef.current = null
        }
        await stopSessionAndSave()
      } else {
        pauseForQuestion()
      }
      return
    }

    if (recordingStatus === 'paused') {
      if (advanceTimerRef.current) {
        clearTimeout(advanceTimerRef.current)
        advanceTimerRef.current = null
      }
      await startRecording()
      return
    }

    if (recordingStatus === 'ended') {
      toast.info('Recording session has ended')
    }
  }

  // Local storage helpers
  const loadLocalSavedBlob = async () => {
    try {
      const blob = await getBlobFromIDB(SAVED_KEY)
      if (blob) {
        setSavedExists(true)
        setSavedMime(blob.type || 'audio/webm')
        const url = URL.createObjectURL(blob)
        setSavedUrl(url)
      } else {
        setSavedExists(false)
      }
    } catch (err) {
      console.error('Failed to load saved blob', err)
    }
  }

  const clearSavedUrl = () => {
    if (savedUrl) {
      URL.revokeObjectURL(savedUrl)
      setSavedUrl(null)
    }
    setSavedExists(false)
  }

  const deleteLocalSavedBlob = async () => {
    try {
      await deleteBlobFromIDB(SAVED_KEY)
      clearSavedUrl()
      toast.info('Local copy cleared')
    } catch (err) {
      console.error('Failed to delete local copy', err)
      toast.error('Failed to clear local copy')
    }
  }

  const uploadLocalCopy = async () => {
    try {
      const blob = await getBlobFromIDB(SAVED_KEY)
      if (!blob) return toast.error('No saved recording found')
      await uploadAudioBlob(blob)
    } catch (err) {
      console.error('Upload local copy failed', err)
      toast.error('Upload failed')
    }
  }

  // cleanup on unmount
  useEffect(() => {
    loadLocalSavedBlob()
    return () => {
      stopTtsPlayback()
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop())
        mediaStreamRef.current = null
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop() } catch (e) { }
        mediaRecorderRef.current = null
      }
      clearSavedUrl()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const buttonLabel = (() => {
    if (recordingStatus === 'permission-denied') return 'Allow Microphone'
    if (recordingStatus === 'idle') return 'Start Recording'
    if (recordingStatus === 'recording') return currentQuestion === INTERVIEW_QUESTIONS.length - 1 ? 'Stop Recording' : 'Stop Recording'
    if (recordingStatus === 'paused') return 'Start Recording'
    if (recordingStatus === 'ended') return 'Session Ended'
    return 'Record'
  })()

  const currentQ = INTERVIEW_QUESTIONS[currentQuestion] || {}

  return (
    <main className="w-full min-h-screen font-['QuickSand'] bg-stone-100 pt-20">
      <div className="p-8 flex flex-col gap-8">
        <div className="max-w-4xl mx-auto bg-[#FCF6F5] rounded-2xl shadow p-8 border-2" style={{ borderColor: '#990011' }}>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
            <div>
              <h1 className="text-3xl font-medium text-[#990011]">Audio Interview</h1>
              <p className="text-sm text-gray-600 mt-1">
                Answer the five questions using audio in English or Kannada. Recordings are transcribed and evaluated for rehabilitation follow-up.
              </p>
            </div>

            {/* Language Switcher */}
            <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-full border shadow-sm">
              <span className="text-xs font-semibold text-gray-500 uppercase">Language:</span>
              <button
                type="button"
                onClick={() => {
                  if (recordingStatus === 'recording') return
                  stopTtsPlayback()
                  setSelectedLanguage('en')
                }}
                disabled={recordingStatus === 'recording'}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                  selectedLanguage === 'en'
                    ? 'bg-[#990011] text-[#FCF6F5] shadow-sm'
                    : 'text-gray-700 hover:text-[#990011]'
                }`}
              >
                English
              </button>
              <button
                type="button"
                onClick={() => {
                  if (recordingStatus === 'recording') return
                  stopTtsPlayback()
                  setSelectedLanguage('kn')
                }}
                disabled={recordingStatus === 'recording'}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                  selectedLanguage === 'kn'
                    ? 'bg-[#990011] text-[#FCF6F5] shadow-sm'
                    : 'text-gray-700 hover:text-[#990011]'
                }`}
              >
                ಕನ್ನಡ (Kannada)
              </button>
            </div>
          </div>

          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-6 pt-4 border-t border-gray-200">
            <div className="flex-1">
              <p className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-1">
                Question {currentQuestion + 1} of {INTERVIEW_QUESTIONS.length}
              </p>
              <p className="text-2xl font-bold text-[#990011] leading-relaxed">
                {selectedLanguage === 'kn' ? currentQ.kn : currentQ.en}
              </p>
              {selectedLanguage === 'kn' && (
                <p className="text-xs text-gray-500 mt-1 italic font-sans">
                  {currentQ.en}
                </p>
              )}

              {/* Kannada Voice Playback (Gnani Timbre TTS) */}
              {selectedLanguage === 'kn' && (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={handleTtsPlayback}
                    disabled={recordingStatus === 'recording' || ttsLoading}
                    className="inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-semibold rounded-lg border-2 border-[#990011] text-[#990011] hover:bg-[#990011] hover:text-[#FCF6F5] transition-all disabled:opacity-40"
                    title="Gnani Timbre TTS Voice Assistance"
                  >
                    {ttsLoading ? (
                      <span>⏳ ಧ್ವನಿ ಲೋಡ್ ಆಗುತ್ತಿದೆ... (Loading...)</span>
                    ) : ttsPlaying ? (
                      <span>⏹️ ಧ್ವನಿ ನಿಲ್ಲಿಸಿ (Stop Audio)</span>
                    ) : (
                      <span>🔊 ಪ್ರಶ್ನೆ ಕೇಳಿ (Listen in Kannada)</span>
                    )}
                  </button>
                </div>
              )}
            </div>

            <div className="text-left md:text-right flex flex-col items-start md:items-end">
              <p className="italic font-serif text-xs text-gray-600 mb-2">
                Click button to start answering:
              </p>
              <button
                onClick={handleRecordButton}
                disabled={recordingStatus === 'ended' || isUploading}
                className={`px-6 py-3 rounded-full font-semibold shadow-lg focus:outline-none transform transition-transform ${
                  recordingStatus === 'recording' ? 'animate-pulse scale-105' : 'hover:scale-105'
                }`}
                style={{ backgroundColor: '#990011', color: '#FCF6F5' }}
              >
                {buttonLabel}
              </button>
            </div>
          </div>

          <div className="mt-4">
            <div className="p-4 rounded-lg border bg-white" style={{ borderColor: '#990011' }}>
              <p className="text-sm text-gray-700">Status: <strong>{recordingStatus}</strong></p>
              <p className="text-sm text-gray-700">
                {recordingStatus === 'recording'
                  ? 'Recording your voice... Speak clearly.'
                  : recordingStatus === 'paused'
                  ? 'Paused between questions. Preparing next question...'
                  : ''}
              </p>
              {recordingStatus === 'permission-denied' && (
                <p className="text-sm text-red-600 mt-1">
                  Microphone access is blocked. Please enable microphone for this site in browser settings or click "Allow Microphone".
                </p>
              )}
              {isUploading && <p className="text-sm text-gray-700 mt-1">Processing and uploading interview recording...</p>}
            </div>
          </div>

          <div className="mt-6">
            <div className="grid grid-cols-1 gap-3">
              <div className="flex gap-2 items-center">
                <span className="text-sm font-semibold">Local recording copy:</span>
                {savedExists ? (
                  <span className="text-sm font-medium text-green-700">Available locally ({savedMime})</span>
                ) : (
                  <span className="text-sm text-slate-600">None</span>
                )}
              </div>

              {savedUrl && (
                <div className="flex flex-col gap-2">
                  <audio controls src={savedUrl} className="w-full" />
                  <div className="flex gap-2">
                    <button onClick={uploadLocalCopy} className="px-4 py-2 rounded bg-[#990011] text-[#FCF6F5]">
                      Upload
                    </button>
                    <button onClick={deleteLocalSavedBlob} className="px-4 py-2 rounded border bg-white">
                      Clear Local Copy
                    </button>
                    <a
                      href={savedUrl}
                      download={`answers${getExtensionFromMime(savedMime)}`}
                      className="px-4 py-2 rounded border bg-white"
                    >
                      Download
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="mt-6">
            <div className="grid grid-cols-5 gap-2">
              {INTERVIEW_QUESTIONS.map((q, i) => (
                <div
                  key={q.id || i}
                  className={`p-2 text-xs text-center rounded transition-all ${
                    i < currentQuestion
                      ? 'bg-[#990011] text-[#FCF6F5]'
                      : i === currentQuestion
                      ? 'border-2 font-bold'
                      : 'bg-white'
                  } shadow-sm`}
                  style={{ borderColor: '#990011' }}
                >
                  Q{i + 1}
                </div>
              ))}
            </div>
          </div>

        </div>

        <div className="max-w-4xl mx-auto">
          <p className="text-xs text-gray-500 text-center">
            Note: All responses are processed securely. Kannada recordings are transcribed via Gnani Prisma STT with code-mix support and evaluated for follow-up rehabilitation support.
          </p>
        </div>
      </div>

      <Footer />
    </main>
  )
}
