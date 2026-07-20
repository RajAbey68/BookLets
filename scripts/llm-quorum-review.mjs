/**
 * LLM Quorum Review — Z.AI external four-eyes for BookLets PRs.
 *
 * Flow (see .github/workflows/llm-quorum-review.yml for the mandate):
 *   1. Fetch the PR diff (GitHub API, the workflow's own read token).
 *   2. Ask Z.AI GLM for a strict-JSON verdict: PASS/FAIL + rationale.
 *   3. On PASS, submit an APPROVE review as RajAbeyBot with the verdict
 *      embedded, so the audit trail shows who voted and why.
 *
 * Fail-safe by design: any missing secret, API error, or FAIL verdict just
 * logs and exits 0 WITHOUT approving — this job adds approvals, it never
 * blocks a PR. (Branch protection remains the blocking mechanism.)
 *
 * Standalone Node 20+ ESM script: no dependencies, global fetch only.
 * Verified with `node --check`; `npm run lint`/`build` do not apply here.
 */

const {
  ZAI_API_KEY,
  RAJABEYBOT_TOKEN,
  ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4',
  ZAI_MODEL = 'glm-4.6',
  GH_REPO,
  PR_NUMBER,
  PR_TITLE = '',
  HEAD_SHA = '',
  GITHUB_TOKEN,
} = process.env;

const MAX_DIFF_CHARS = 180_000; // keep well inside GLM context; truncate loudly

function skip(reason) {
  console.log(`[llm-quorum-review] SKIP (no approval, not a failure): ${reason}`);
  process.exit(0);
}

if (!ZAI_API_KEY) skip('ZAI_API_KEY secret not set');
if (!RAJABEYBOT_TOKEN) skip('RAJABEYBOT_TOKEN secret not set');
if (!GH_REPO || !PR_NUMBER || !GITHUB_TOKEN) skip('missing PR context env');

const ghHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

async function fetchDiff() {
  const res = await fetch(
    `https://api.github.com/repos/${GH_REPO}/pulls/${PR_NUMBER}`,
    { headers: { ...ghHeaders(GITHUB_TOKEN), Accept: 'application/vnd.github.diff' } },
  );
  if (!res.ok) skip(`diff fetch failed: HTTP ${res.status}`);
  let diff = await res.text();
  if (diff.length > MAX_DIFF_CHARS) {
    console.log(`[llm-quorum-review] diff truncated ${diff.length} -> ${MAX_DIFF_CHARS} chars`);
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[DIFF TRUNCATED FOR REVIEW — full diff on the PR]`;
  }
  return diff;
}

async function zaiVerdict(diff) {
  const res = await fetch(`${ZAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ZAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ZAI_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are the independent Layer-1 code reviewer for a double-entry bookkeeping app ' +
            '(Next.js/TypeScript/Prisma/Postgres). Financial integrity rules that MUST hold: ' +
            'journal entries balance; POSTED entries are immutable; automated entries are DRAFT-only; ' +
            'maker != checker (no self-approval); tenant isolation (organizationId scoping) is never widened; ' +
            'no secrets or credentials in code. Review the diff adversarially. ' +
            'Reply with STRICT JSON only, no markdown fence: ' +
            '{"verdict":"PASS"|"FAIL","confidence":0..1,"rationale":"<=120 words","concerns":["..."]}. ' +
            'FAIL only for defects that should block merging (correctness, security, financial integrity). ' +
            'Style nits belong in concerns with verdict PASS.',
        },
        { role: 'user', content: `PR #${PR_NUMBER}: ${PR_TITLE}\nHEAD: ${HEAD_SHA}\n\n${diff}` },
      ],
    }),
  });
  if (!res.ok) skip(`Z.AI call failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? '';
  try {
    // Tolerate accidental code fences around the JSON.
    const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(jsonText);
    if (parsed.verdict !== 'PASS' && parsed.verdict !== 'FAIL') throw new Error('bad verdict');
    return parsed;
  } catch {
    skip(`unparseable Z.AI reply: ${raw.slice(0, 300)}`);
  }
}

async function approveAsBot(verdict) {
  const body =
    `**External four-eyes (Z.AI ${ZAI_MODEL}) verdict: PASS** ` +
    `(confidence ${verdict.confidence ?? 'n/a'}) on ${HEAD_SHA.slice(0, 7)}\n\n` +
    `${verdict.rationale ?? ''}\n\n` +
    (verdict.concerns?.length
      ? `Non-blocking concerns:\n${verdict.concerns.map((c) => `- ${c}`).join('\n')}\n\n`
      : '') +
    '_Automated per the operator mandate in AGENTS.md: non-Anthropic LLM reviews, ' +
    'RajAbeyBot signs. Raj is not a code reviewer._';
  const res = await fetch(`https://api.github.com/repos/${GH_REPO}/pulls/${PR_NUMBER}/reviews`, {
    method: 'POST',
    headers: { ...ghHeaders(RAJABEYBOT_TOKEN), 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'APPROVE', body, commit_id: HEAD_SHA || undefined }),
  });
  if (!res.ok) skip(`approval POST failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  console.log('[llm-quorum-review] APPROVED as RajAbeyBot');
}

const diff = await fetchDiff();
const verdict = await zaiVerdict(diff);
console.log(`[llm-quorum-review] Z.AI verdict: ${verdict.verdict} — ${verdict.rationale ?? ''}`);
if (verdict.verdict === 'PASS') {
  await approveAsBot(verdict);
} else {
  console.log('[llm-quorum-review] FAIL verdict — no approval. Concerns:', verdict.concerns ?? []);
}
