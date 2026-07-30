/**
 * LLM Quorum Review — Z.AI external four-eyes for BookLets PRs (FAIL-CLOSED).
 *
 * Flow:
 *   1. Fetch the PR diff (GitHub API, the workflow's own read token).
 *   2. Ask Z.AI GLM for a strict-JSON verdict: PASS/FAIL + rationale.
 *   3. On PASS -> submit an APPROVE review as RajAbeyBot + a `success` Check Run.
 *   4. On FAIL -> submit a REQUEST_CHANGES review as RajAbeyBot + a `failure`
 *      Check Run (a real blocking signal branch protection can require).
 *   5. On any failure to RUN (missing secret, API error, unparseable reply) ->
 *      exit 1 (BLOCK), never silently pass. This is the fail-closed fix: a
 *      reviewer outage must not be read as "approved".
 *
 * HARD RULE (operator correction, 2026-07-15):
 *   - This job is a QUALITY GATE, not a correctness oracle. Balanced entries can
 *     still post the wrong account / wrong tenant (PR #91 was a balanced, green,
 *     test-passing cross-tenant leak). The only thing containing that class is the
 *     single-tenant cap (ALLOW_MULTI_TENANCY=false). Do NOT claim invariants hold.
 *   - The system prompt lists rules to CHECK, never facts that hold.
 *
 * Exit semantics:
 *   exit 0  = neutral: job was not required to run (draft / external fork / disabled).
 *   exit 1  = BLOCK: job should have run but failed, OR the verdict was FAIL.
 *
 * The APPROVE/REQUEST_CHANGES review + Check Run are the audit trail. RajAbeyBot
 * signs; Raj is not a code reviewer.
 *
 * Standalone Node 20+ ESM, no deps, global fetch only.
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
  FAIL_CLOSED = 'true',
} = process.env;

const MAX_DIFF_CHARS = 180_000;
const isFailClosed = FAIL_CLOSED !== 'false';

function neutral(reason) {
  console.log(`[llm-quorum-review] NEUTRAL (not required to run): ${reason}`);
  process.exit(0);
}

function block(reason) {
  console.error(`[llm-quorum-review] BLOCK: ${reason}`);
  process.exit(1);
}

if (!GH_REPO || !PR_NUMBER || !GITHUB_TOKEN) {
  block('missing PR context env (GH_REPO/PR_NUMBER/GITHUB_TOKEN)');
}
if (!ZAI_API_KEY) block('ZAI_API_KEY secret not set — reviewer cannot run');
if (!RAJABEYBOT_TOKEN) block('RAJABEYBOT_TOKEN secret not set — cannot sign review');

const ghHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

async function setCheckRun(conclusion, title, summary) {
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/check-runs`, {
      method: 'POST',
      headers: { ...ghHeaders(GITHUB_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'llm-quorum-review (Z.AI four-eyes)',
        head_sha: HEAD_SHA,
        status: 'completed',
        conclusion,
        output: { title, summary },
      }),
    });
    if (!res.ok) console.error(`[llm-quorum-review] check-run write failed: HTTP ${res.status}`);
  } catch (e) {
    console.error(`[llm-quorum-review] check-run write error: ${e.message}`);
  }
}

async function fetchDiff() {
  const res = await fetch(
    `https://api.github.com/repos/${GH_REPO}/pulls/${PR_NUMBER}`,
    { headers: { ...ghHeaders(GITHUB_TOKEN), Accept: 'application/vnd.github.diff' } },
  );
  if (!res.ok) block(`diff fetch failed: HTTP ${res.status}`);
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
            '(Next.js/TypeScript/Prisma/Postgres). CHECK the diff against these rules (they are ' +
            'requirements to verify, NOT guarantees that hold): journal entries must balance; ' +
            'POSTED entries must stay immutable; automated entries must be DRAFT-only; ' +
            'maker != checker (no self-approval); tenant isolation (organizationId scoping) must ' +
            'not be widened or leaked; no secrets/credentials in code. ' +
            'CRITICAL: a balanced entry can still post the WRONG account or WRONG tenant — ' +
            'flag any account-mapping or tenant-scope drift explicitly, even if it balances. ' +
            'Review adversarially. Reply STRICT JSON only, no markdown fence: ' +
            '{"verdict":"PASS"|"FAIL","confidence":0..1,"rationale":"<=120 words","concerns":["..."]}. ' +
            'FAIL only for defects that should block merging (correctness, security, financial ' +
            'integrity, tenant isolation). Style nits belong in concerns with verdict PASS.',
        },
        { role: 'user', content: `PR #${PR_NUMBER}: ${PR_TITLE}\nHEAD: ${HEAD_SHA}\n\n${diff}` },
      ],
    }),
  });
  if (!res.ok) block(`Z.AI call failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  let data;
  try {
    data = await res.json();
  } catch {
    block(`Z.AI returned non-JSON body (HTTP ${res.status})`);
  }
  const raw = data?.choices?.[0]?.message?.content ?? '';
  if (!raw) block(`Z.AI returned empty/no content (HTTP ${res.status}, keys: ${Object.keys(data ?? {}).join(',')})`);
  try {
    const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(jsonText);
    if (parsed.verdict !== 'PASS' && parsed.verdict !== 'FAIL') throw new Error('bad verdict');
    return parsed;
  } catch {
    block(`unparseable Z.AI reply: ${raw.slice(0, 300)}`);
  }
}

async function postReview(event, verdict, title) {
  const body =
    `**External four-eyes (Z.AI ${ZAI_MODEL}) verdict: ${verdict.verdict}** ` +
    `(confidence ${verdict.confidence ?? 'n/a'}) on ${HEAD_SHA.slice(0, 7)}\n\n` +
    `${verdict.rationale ?? ''}\n\n` +
    (verdict.concerns?.length
      ? `Concerns:\n${verdict.concerns.map((c) => `- ${c}`).join('\n')}\n\n`
      : '') +
    '_Automated per the operator mandate in AGENTS.md: non-Anthropic LLM reviews, ' +
    'RajAbeyBot signs. Raj is not a code reviewer. This is a quality gate, not a ' +
    'correctness oracle — a balanced entry can still post the wrong account/tenant._';
  const res = await fetch(`https://api.github.com/repos/${GH_REPO}/pulls/${PR_NUMBER}/reviews`, {
    method: 'POST',
    headers: { ...ghHeaders(RAJABEYBOT_TOKEN), 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, body, commit_id: HEAD_SHA || undefined }),
  });
  if (!res.ok) block(`review POST (${event}) failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  console.log(`[llm-quorum-review] ${event} posted as RajAbeyBot`);
}

const diff = await fetchDiff();
const verdict = await zaiVerdict(diff);
console.log(`[llm-quorum-review] Z.AI verdict: ${verdict.verdict} — ${verdict.rationale ?? ''}`);

if (verdict.verdict === 'PASS') {
  await postReview('APPROVE', verdict, `Z.AI four-eyes: PASS`);
  await setCheckRun('success', 'Z.AI four-eyes: PASS', `Confidence ${verdict.confidence ?? 'n/a'}. Quality gate only.`);
  console.log('[llm-quorum-review] done (PASS)');
} else {
  await postReview('REQUEST_CHANGES', verdict, `Z.AI four-eyes: FAIL`);
  await setCheckRun('failure', 'Z.AI four-eyes: FAIL', `Blocked: ${verdict.concerns?.join('; ') ?? 'see review'}`);
  block('Z.AI returned FAIL — PR blocked pending human review');
}