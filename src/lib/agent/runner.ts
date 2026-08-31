import Anthropic from '@anthropic-ai/sdk';
import { LEDGER_TOOLS, findTool } from './tools';

/**
 * The agent loop behind the voice assistant.
 *
 * Deliberately a hand-written loop rather than the SDK tool runner: the UI
 * shows every tool the agent consulted, so we need the trace, and we want a
 * hard iteration ceiling on a path a guest can trigger by talking.
 */

/**
 * How many model turns one question may take.
 *
 * Every ledger question in the registry is answerable from one or two tools,
 * so this is a runaway guard rather than a real budget: without it a model
 * that keeps re-reading the trial balance would bill indefinitely against a
 * request nobody is watching.
 */
const MAX_ITERATIONS = 6;

/** Turns of history replayed to the model. Voice questions are short. */
export const MAX_HISTORY_TURNS = 12;

const MODEL = process.env.BOOKLETS_AGENT_MODEL ?? 'claude-opus-5';

/**
 * Thinking is on by default on this model family and costs latency, which is
 * the thing you feel most in a spoken exchange. Low effort keeps the reply
 * quick; these are lookups, not analysis. `max_tokens` covers thinking and
 * reply together, so it needs headroom well beyond the visible answer.
 */
const EFFORT = 'low';
const MAX_TOKENS = 8000;

const SYSTEM_PROMPT = `You are the BookLets ledger assistant. BookLets is the double-entry
bookkeeping system of record for a short-term-rental property portfolio. You are
answering an operator who is speaking to you, so your reply will be read aloud.

WHAT YOU CAN DO
You have read-only tools over the ledger: profit and loss, trial balance, balance
sheet, portfolio metrics, and the pending-approval queue. Call them to answer;
never answer a question about figures from memory or from earlier in the
conversation if a tool can give you the current number.

WHAT YOU CANNOT DO
You cannot post, edit, approve, or reject anything. There is no tool for it, by
design: speech is the weakest evidence this product accepts, and speech-to-text
mis-hears numbers. If you are asked to record an expense, post a journal entry,
or approve a draft, say plainly that you can only read the ledger and point the
operator at the relevant page — /ledger/new to raise an entry, /review to decide
drafts. Do not offer to do it anyway.

SPEAKING NUMBERS
Say amounts as bare numbers with no currency symbol or currency name — BookLets
records currency per journal line, not per report, so you do not know it and
must not guess. Round to whole units when reading a figure aloud unless the
operator asks for the exact amount; the written transcript beside you carries the
precise value. Give the headline number first, then at most two or three
supporting figures. Do not read out long lists of accounts.

BEING HONEST ABOUT LIMITS
Tool results are capped: they tell you how many rows were omitted and whether a
queue was truncated. Say so when it matters rather than implying you listed
everything. Profit and loss covers POSTED entries only — if the operator seems to
be asking about money that has not been approved yet, say that drafts are
excluded and check the approval queue.

If a tool returns an error, say what failed in one sentence. Do not retry the
same call more than once.

Keep replies short. Two or three sentences is usually right for something being
spoken aloud.`;

export interface ToolTraceEntry {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  /** Present only when the tool failed — surfaced in the UI, not spoken. */
  error?: string;
}

export interface AgentTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentReply {
  reply: string;
  toolTrace: ToolTraceEntry[];
  /** True when the loop hit MAX_ITERATIONS rather than finishing cleanly. */
  truncated: boolean;
}

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. The ledger assistant needs it to answer questions.',
    );
  }
  cachedClient ??= new Anthropic();
  return cachedClient;
}

/** Tool definitions in the wire shape, built once — the set never varies. */
const TOOL_DEFINITIONS = LEDGER_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema,
}));

/**
 * Runs one question to a spoken answer.
 *
 * `history` is prior turns, oldest first, excluding `question`. Callers should
 * trim it to MAX_HISTORY_TURNS; this function does not trust that they did.
 */
export async function runLedgerAgent(
  question: string,
  history: AgentTurn[] = [],
): Promise<AgentReply> {
  const client = getClient();
  const toolTrace: ToolTraceEntry[] = [];

  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-MAX_HISTORY_TURNS).map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
    { role: 'user' as const, content: question },
  ];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      output_config: { effort: EFFORT },
      tools: TOOL_DEFINITIONS,
      messages,
    });

    // Safety classifiers can decline a turn; that arrives as a normal 200 with
    // an empty or partial content array, so it must be checked before reading.
    if (response.stop_reason === 'refusal') {
      return {
        reply: 'I can’t answer that one. Try rephrasing, or ask about the ledger directly.',
        toolTrace,
        truncated: false,
      };
    }

    if (response.stop_reason !== 'tool_use') {
      return { reply: collectText(response.content), toolTrace, truncated: false };
    }

    // The assistant turn must be replayed whole — dropping the tool_use blocks
    // would orphan the tool_result blocks we are about to send back.
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    // All results for one assistant turn go back in a single user message.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUses) {
      const tool = findTool(toolUse.name);
      const input = (toolUse.input ?? {}) as Record<string, unknown>;

      if (!tool) {
        // Only reachable if the model invents a name; report it rather than
        // throwing, so the agent can correct itself on the next turn.
        toolTrace.push({ name: toolUse.name, input, ok: false, error: 'Unknown tool.' });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `No tool named ${toolUse.name} exists.`,
          is_error: true,
        });
        continue;
      }

      let result;
      try {
        result = await tool.execute(input);
      } catch (error) {
        // A thrown tool must still produce a tool_result — the API rejects the
        // follow-up if any tool_use id is left unanswered.
        console.error(`[agent/runner] tool ${tool.name} threw:`, error);
        result = { ok: false as const, error: 'That lookup failed unexpectedly.' };
      }

      toolTrace.push({
        name: tool.name,
        input,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
      });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.ok ? JSON.stringify(result.data) : result.error,
        ...(result.ok ? {} : { is_error: true }),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return {
    reply:
      'That took more steps than I can complete in one go. Ask me for one figure at a time.',
    toolTrace,
    truncated: true,
  };
}

function collectText(content: Anthropic.ContentBlock[]): string {
  const text = content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  return text === '' ? 'I don’t have an answer for that.' : text;
}
