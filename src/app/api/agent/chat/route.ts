import { NextResponse } from 'next/server';
import { resolveActiveContext } from '@/lib/auth-context';
import { runLedgerAgent, MAX_HISTORY_TURNS, type AgentTurn } from '@/lib/agent/runner';

/**
 * POST /api/agent/chat — one question to the read-only ledger assistant.
 *
 * The voice UI transcribes speech in the browser and posts the transcript
 * here; nothing about this route is audio-aware, which is what lets the same
 * endpoint serve typed questions.
 *
 * Auth is enforced twice over: middleware gates everything outside /login, and
 * each tool re-resolves the caller's org through resolveActiveContext. The
 * explicit check here exists to return a clean 401 instead of letting the
 * model narrate five identical "not authenticated" tool failures.
 */

export const dynamic = 'force-dynamic';

/** A spoken question that runs past this is a transcription fault, not a question. */
const MAX_QUESTION_CHARS = 2000;

export async function POST(request: Request) {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const payload = (body ?? {}) as { question?: unknown; history?: unknown };

  const question = typeof payload.question === 'string' ? payload.question.trim() : '';
  if (question === '') {
    return NextResponse.json({ error: 'Nothing to answer — no question was sent.' }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      { error: `That question is too long (limit ${MAX_QUESTION_CHARS} characters).` },
      { status: 400 },
    );
  }

  const history = parseHistory(payload.history);

  try {
    const result = await runLedgerAgent(question, history);
    return NextResponse.json(result);
  } catch (error) {
    // A missing ANTHROPIC_API_KEY lands here. Say so rather than returning a
    // bare 500 — an operator who can't get an answer needs to know the
    // assistant is unconfigured, not that the ledger is broken.
    console.error('[api/agent/chat] agent run failed:', error);
    const message =
      error instanceof Error && error.message.includes('ANTHROPIC_API_KEY')
        ? 'The ledger assistant is not configured on this deployment.'
        : 'The assistant could not answer that. Try again shortly.';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

/**
 * Accepts only well-formed prior turns and drops the rest.
 *
 * The client owns the transcript, so this is untrusted input: anything that
 * isn't a plain user/assistant string turn is discarded rather than repaired.
 */
function parseHistory(raw: unknown): AgentTurn[] {
  if (!Array.isArray(raw)) return [];

  const turns: AgentTurn[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string' || content.trim() === '') continue;
    turns.push({ role, content: content.trim() });
  }

  return turns.slice(-MAX_HISTORY_TURNS);
}
