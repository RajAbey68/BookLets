'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Push-to-talk chat with the read-only ledger assistant.
 *
 * Speech in and speech out both run in the browser via the Web Speech API, so
 * no audio ever leaves the device and the deployment needs no speech vendor —
 * only the transcript is posted to /api/agent/chat. The trade is coverage:
 * Chrome and Safari support it, Firefox does not, so the typed input below is
 * a first-class path rather than a fallback for the impatient.
 *
 * The transcript of what was heard is always shown next to the answer. That is
 * the safety property this screen depends on: the assistant reads figures
 * aloud, speech-to-text mis-hears numbers, and the operator needs to see the
 * question that actually got asked before trusting the number that came back.
 */

interface ToolTraceEntry {
  name: string;
  ok: boolean;
  error?: string;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  toolTrace?: ToolTraceEntry[];
  /** Rendered as an error rather than an answer. */
  failed?: boolean;
}

/**
 * Minimal shape of the Web Speech API we rely on.
 *
 * Not in lib.dom — it is a draft spec shipped behind a vendor prefix — so the
 * fields actually read are declared here rather than pulling in a dependency.
 */
interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const MIC_ERROR_COPY: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow it in your browser settings to talk.',
  'service-not-allowed': 'Microphone access was blocked by your browser or device policy.',
  'no-speech': 'I didn’t catch anything — hold the button and speak, then release.',
  'audio-capture': 'No microphone was found.',
  network: 'Speech recognition needs a network connection and could not reach it.',
};

export default function VoiceChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [typed, setTyped] = useState('');
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(true);
  const [micError, setMicError] = useState<string | null>(null);
  const [speechSupported, setSpeechSupported] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /**
   * Final transcript accumulates outside React state: `onresult` can fire
   * several times between renders, and reading a stale `interim` on release
   * would drop whatever arrived in the last frame.
   */
  const finalTranscriptRef = useRef('');
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  /** Latest turns, for the send path — avoids re-creating `ask` on every turn. */
  const turnsRef = useRef<Turn[]>([]);

  useEffect(() => {
    turnsRef.current = turns;
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  useEffect(() => {
    setSpeechSupported(getSpeechRecognition() !== null);
  }, []);

  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    window.speechSynthesis.speak(utterance);
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (trimmed === '' || thinking) return;

      // History excludes failed turns — a 503 is not something the model
      // should try to make sense of on the next question.
      const history = turnsRef.current
        .filter((turn) => !turn.failed)
        .map((turn) => ({ role: turn.role, content: turn.content }));

      setTurns((prior) => [...prior, { role: 'user', content: trimmed }]);
      setThinking(true);

      try {
        const response = await fetch('/api/agent/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: trimmed, history }),
        });
        const payload = await response.json();

        if (!response.ok) {
          setTurns((prior) => [
            ...prior,
            {
              role: 'assistant',
              content: payload.error ?? 'The assistant could not answer that.',
              failed: true,
            },
          ]);
          return;
        }

        setTurns((prior) => [
          ...prior,
          { role: 'assistant', content: payload.reply, toolTrace: payload.toolTrace ?? [] },
        ]);
        if (speakReplies) speak(payload.reply);
      } catch {
        setTurns((prior) => [
          ...prior,
          { role: 'assistant', content: 'Could not reach the assistant.', failed: true },
        ]);
      } finally {
        setThinking(false);
      }
    },
    [speak, speakReplies, thinking],
  );

  const startListening = useCallback(() => {
    const Recognition = getSpeechRecognition();
    if (!Recognition || listening || thinking) return;

    // Speaking over the previous answer confuses the recogniser and the operator.
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    setMicError(null);
    finalTranscriptRef.current = '';
    setInterim('');

    const recognition = new Recognition();
    recognition.lang = 'en-GB';
    // Push-to-talk: keep the stream open for the whole hold so a pause between
    // "profit and loss" and "for this quarter" doesn't end the question early.
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) {
          finalTranscriptRef.current += text;
        } else {
          pending += text;
        }
      }
      setInterim(finalTranscriptRef.current + pending);
    };

    recognition.onerror = (event) => {
      setMicError(MIC_ERROR_COPY[event.error] ?? `Microphone error: ${event.error}`);
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
      const heard = finalTranscriptRef.current.trim();
      finalTranscriptRef.current = '';
      setInterim('');
      if (heard !== '') void ask(heard);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      // start() throws if a previous session is still tearing down.
      setMicError('The microphone is still busy — try again in a moment.');
    }
  }, [ask, listening, thinking]);

  const stopListening = useCallback(() => {
    // stop() flushes the final result, which onend then sends. abort() would
    // discard everything just said.
    recognitionRef.current?.stop();
  }, []);

  useEffect(
    () => () => {
      recognitionRef.current?.abort();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    },
    [],
  );

  const submitTyped = (event: React.FormEvent) => {
    event.preventDefault();
    const question = typed;
    setTyped('');
    void ask(question);
  };

  const micBusy = thinking;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div
        style={{
          border: '1px solid var(--surface-border)',
          borderRadius: '12px',
          padding: '1.25rem',
          minHeight: '18rem',
          maxHeight: '60vh',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        {turns.length === 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', lineHeight: 1.7 }}>
            <p style={{ marginTop: 0 }}>
              Hold the button and ask about the ledger. Try:
            </p>
            <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
              <li>“What’s our profit and loss this quarter?”</li>
              <li>“Do the books balance?”</li>
              <li>“How many drafts are waiting for approval?”</li>
              <li>“What’s occupancy this month?”</li>
            </ul>
            <p style={{ marginBottom: 0 }}>
              The assistant reads the ledger only — it cannot post, approve, or reject anything.
            </p>
          </div>
        )}

        {turns.map((turn, index) => (
          <div
            key={index}
            style={{
              alignSelf: turn.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
            }}
          >
            <div
              style={{
                fontSize: '0.6875rem',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--text-secondary)',
                marginBottom: '0.25rem',
                textAlign: turn.role === 'user' ? 'right' : 'left',
              }}
            >
              {turn.role === 'user' ? 'You said' : 'Assistant'}
            </div>
            <div
              style={{
                padding: '0.75rem 1rem',
                borderRadius: '12px',
                background:
                  turn.role === 'user' ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)',
                border: turn.failed ? '1px solid #ef4444' : '1px solid var(--surface-border)',
                color: turn.role === 'user' ? '#fff' : 'var(--text-primary)',
                fontSize: '0.9375rem',
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
              }}
            >
              {turn.content}
            </div>

            {turn.toolTrace && turn.toolTrace.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.375rem',
                  marginTop: '0.5rem',
                }}
              >
                {turn.toolTrace.map((entry, entryIndex) => (
                  <span
                    key={entryIndex}
                    title={entry.error ?? 'Read from the ledger'}
                    style={{
                      fontSize: '0.6875rem',
                      padding: '0.125rem 0.5rem',
                      borderRadius: '999px',
                      border: '1px solid var(--surface-border)',
                      color: entry.ok ? 'var(--text-secondary)' : '#ef4444',
                    }}
                  >
                    {entry.ok ? 'read' : 'failed'} · {entry.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}

        {listening && interim !== '' && (
          <div style={{ alignSelf: 'flex-end', maxWidth: '85%', opacity: 0.6 }}>
            <div
              style={{
                padding: '0.75rem 1rem',
                borderRadius: '12px',
                border: '1px dashed var(--surface-border)',
                fontSize: '0.9375rem',
                fontStyle: 'italic',
              }}
            >
              {interim}
            </div>
          </div>
        )}

        {thinking && (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            Reading the ledger…
          </div>
        )}

        <div ref={threadEndRef} />
      </div>

      {micError && (
        <div style={{ color: '#ef4444', fontSize: '0.8125rem' }} role="alert">
          {micError}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        {speechSupported ? (
          <button
            type="button"
            // Pointer events cover mouse, touch, and pen with one path.
            onPointerDown={startListening}
            onPointerUp={stopListening}
            onPointerLeave={stopListening}
            onPointerCancel={stopListening}
            disabled={micBusy}
            aria-pressed={listening}
            style={{
              padding: '0.875rem 1.5rem',
              borderRadius: '999px',
              border: '1px solid var(--surface-border)',
              background: listening ? '#ef4444' : 'var(--accent-color)',
              color: '#fff',
              fontSize: '0.9375rem',
              fontWeight: 600,
              cursor: micBusy ? 'not-allowed' : 'pointer',
              opacity: micBusy ? 0.5 : 1,
              // Stops the long-press text-selection / context menu on mobile.
              touchAction: 'none',
              userSelect: 'none',
            }}
          >
            {listening ? 'Listening — release to ask' : 'Hold to talk'}
          </button>
        ) : (
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
            This browser has no speech recognition — type your question instead.
          </span>
        )}

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.8125rem',
            color: 'var(--text-secondary)',
          }}
        >
          <input
            type="checkbox"
            checked={speakReplies}
            onChange={(event) => {
              setSpeakReplies(event.target.checked);
              if (!event.target.checked && typeof window !== 'undefined') {
                window.speechSynthesis?.cancel();
              }
            }}
          />
          Read answers aloud
        </label>
      </div>

      <form onSubmit={submitTyped} style={{ display: 'flex', gap: '0.5rem' }}>
        <label htmlFor="assistant-question" style={{ position: 'absolute', left: '-9999px' }}>
          Ask the ledger assistant
        </label>
        <input
          id="assistant-question"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="…or type a question"
          disabled={thinking}
          style={{
            flex: 1,
            padding: '0.75rem 1rem',
            borderRadius: '10px',
            border: '1px solid var(--surface-border)',
            background: 'rgba(255,255,255,0.03)',
            color: 'var(--text-primary)',
            fontSize: '0.9375rem',
          }}
        />
        <button
          type="submit"
          disabled={thinking || typed.trim() === ''}
          style={{
            padding: '0.75rem 1.25rem',
            borderRadius: '10px',
            border: '1px solid var(--surface-border)',
            background: 'rgba(255,255,255,0.05)',
            color: 'var(--text-primary)',
            fontSize: '0.9375rem',
            fontWeight: 600,
            cursor: thinking || typed.trim() === '' ? 'not-allowed' : 'pointer',
          }}
        >
          Ask
        </button>
      </form>
    </div>
  );
}
