import VoiceChat from '@/components/VoiceChat';

/**
 * /assistant — talk to the ledger, read-only.
 *
 * The page itself is static; everything happens in the client component and
 * the /api/agent/chat route, which re-resolves the caller's organisation on
 * every question. Auth is enforced by the global middleware.
 */
export default function AssistantPage() {
  return (
    <>
      <div style={{ marginBottom: '2rem' }}>
        <div
          style={{
            fontSize: '0.875rem',
            color: 'var(--accent-color)',
            fontWeight: '600',
            marginBottom: '0.5rem',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Assistant
        </div>
        <h1 style={{ marginBottom: '0.5rem' }}>Ask the ledger</h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0, maxWidth: '48rem' }}>
          Hold the button and ask a question out loud, or type it. The assistant reads
          the books — P&amp;L, trial balance, balance sheet, portfolio metrics, and the
          approval queue — and answers aloud. It cannot post, approve, or reject
          anything: a mis-heard figure must never reach a double-entry ledger. Every
          answer shows the transcript of what was heard, so you can check the question
          before you trust the number.
        </p>
      </div>

      <VoiceChat />
    </>
  );
}
