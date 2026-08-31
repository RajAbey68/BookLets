/**
 * Voice-assistant agent loop.
 *
 * The tools are mocked here — this file is about the loop's contract with the
 * model: every tool_use gets exactly one tool_result (the API rejects the
 * follow-up otherwise), a thrown or unknown tool degrades instead of crashing,
 * a refusal is detected before content is read, and the loop cannot run away.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const create = vi.fn();
const execute = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: (...args: unknown[]) => create(...args) };
  },
}));

// Built inside the factory: vi.mock is hoisted above the consts, and the
// factory runs during the hoisted import of the module under test, so a
// top-level `fakeTool` would still be in its temporal dead zone here.
vi.mock('@/lib/agent/tools', () => {
  const fakeTool = {
    name: 'get_trial_balance',
    description: 'Trial balance totals.',
    inputSchema: { type: 'object' as const, properties: {} },
    execute: (...args: unknown[]) => execute(...args),
  };
  return {
    LEDGER_TOOLS: [fakeTool],
    findTool: (name: string) => (name === 'get_trial_balance' ? fakeTool : undefined),
  };
});

import { runLedgerAgent, MAX_HISTORY_TURNS } from '@/lib/agent/runner';

const textReply = (text: string) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
});

const toolCall = (name: string, input: Record<string, unknown> = {}) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runLedgerAgent', () => {
  it('returns the model’s text when no tool is needed', async () => {
    create.mockResolvedValueOnce(textReply('The books balance.'));

    const result = await runLedgerAgent('Do the books balance?');

    expect(result.reply).toBe('The books balance.');
    expect(result.toolTrace).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('runs a tool, feeds the result back, and reports the trace', async () => {
    create
      .mockResolvedValueOnce(toolCall('get_trial_balance', { period: '2026-6' }))
      .mockResolvedValueOnce(textReply('Debits and credits both come to 100.'));
    execute.mockResolvedValue({ ok: true, data: { totalDebit: '100.00' } });

    const result = await runLedgerAgent('Do the books balance?');

    expect(execute).toHaveBeenCalledWith({ period: '2026-6' });
    expect(result.reply).toBe('Debits and credits both come to 100.');
    expect(result.toolTrace).toEqual([
      { name: 'get_trial_balance', input: { period: '2026-6' }, ok: true },
    ]);

    // The second request must replay the assistant turn whole and answer the
    // tool_use with a matching tool_result — an orphaned id is a 400.
    const followUp = create.mock.calls[1][0];
    const [assistantTurn, resultTurn] = followUp.messages.slice(-2);
    expect(assistantTurn.role).toBe('assistant');
    expect(assistantTurn.content[0].type).toBe('tool_use');
    expect(resultTurn.role).toBe('user');
    expect(resultTurn.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: JSON.stringify({ totalDebit: '100.00' }),
    });
    expect(resultTurn.content[0].is_error).toBeUndefined();
  });

  it('sends a failed tool back as an error result the agent can recover from', async () => {
    create
      .mockResolvedValueOnce(toolCall('get_trial_balance'))
      .mockResolvedValueOnce(textReply('I couldn’t read the trial balance.'));
    execute.mockResolvedValue({ ok: false, error: 'Not authenticated.' });

    const result = await runLedgerAgent('Do the books balance?');

    expect(result.toolTrace[0]).toEqual({
      name: 'get_trial_balance',
      input: {},
      ok: false,
      error: 'Not authenticated.',
    });
    expect(create.mock.calls[1][0].messages.at(-1).content[0]).toMatchObject({
      is_error: true,
      content: 'Not authenticated.',
    });
  });

  it('still answers the tool_use when the tool throws', async () => {
    create
      .mockResolvedValueOnce(toolCall('get_trial_balance'))
      .mockResolvedValueOnce(textReply('Something went wrong reading the ledger.'));
    execute.mockRejectedValue(new Error('socket hang up'));

    const result = await runLedgerAgent('Do the books balance?');

    expect(result.toolTrace[0].ok).toBe(false);
    const toolResult = create.mock.calls[1][0].messages.at(-1).content[0];
    expect(toolResult.tool_use_id).toBe('toolu_1');
    expect(toolResult.is_error).toBe(true);
    // The raw error must not travel back to something that gets spoken.
    expect(toolResult.content).not.toMatch(/socket hang up/);
  });

  it('reports an invented tool name instead of throwing', async () => {
    create
      .mockResolvedValueOnce(toolCall('post_journal_entry', { amount: 1550 }))
      .mockResolvedValueOnce(textReply('I can only read the ledger.'));

    const result = await runLedgerAgent('Record 1550 for groceries.');

    expect(execute).not.toHaveBeenCalled();
    expect(result.toolTrace[0]).toMatchObject({ name: 'post_journal_entry', ok: false });
    expect(create.mock.calls[1][0].messages.at(-1).content[0].is_error).toBe(true);
  });

  it('handles a refusal without reading the content array', async () => {
    // A declined turn arrives as a normal 200 with empty content; indexing
    // content[0] here would throw instead of answering.
    create.mockResolvedValueOnce({ stop_reason: 'refusal', content: [], stop_details: { category: 'cyber' } });

    const result = await runLedgerAgent('something disallowed');

    expect(result.reply).toMatch(/can’t answer/);
    expect(result.truncated).toBe(false);
  });

  it('stops after the iteration ceiling rather than looping forever', async () => {
    create.mockResolvedValue(toolCall('get_trial_balance'));
    execute.mockResolvedValue({ ok: true, data: {} });

    const result = await runLedgerAgent('Do the books balance?');

    expect(result.truncated).toBe(true);
    expect(result.reply).toMatch(/one figure at a time/);
    expect(create).toHaveBeenCalledTimes(6);
  });

  it('falls back to a plain sentence when the model returns no text', async () => {
    create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [] });

    const result = await runLedgerAgent('hello');

    expect(result.reply).toBe('I don’t have an answer for that.');
  });

  it('trims history to the recent turns and puts the question last', async () => {
    create.mockResolvedValueOnce(textReply('ok'));
    const history = Array.from({ length: MAX_HISTORY_TURNS + 6 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `turn ${index}`,
    }));

    await runLedgerAgent('latest question', history);

    const { messages } = create.mock.calls[0][0];
    expect(messages.length).toBe(MAX_HISTORY_TURNS + 1);
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'latest question' });
    // Oldest turns dropped, not the newest.
    expect(messages[0].content).toBe('turn 6');
  });

  it('offers the model only the read-only tool set', async () => {
    create.mockResolvedValueOnce(textReply('ok'));

    await runLedgerAgent('anything');

    const { tools, system } = create.mock.calls[0][0];
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(['get_trial_balance']);
    expect(tools[0].input_schema).toEqual({ type: 'object', properties: {} });
    // The prompt has to say so too — the model is asked to decline write
    // requests in words, not just fail to find a tool.
    expect(system).toMatch(/cannot post, edit, approve, or reject/);
  });

  it('fails loudly when the API key is missing', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    await expect(runLedgerAgent('anything')).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(create).not.toHaveBeenCalled();
  });
});
