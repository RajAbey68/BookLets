# Global Operating Model: Orchestrator / Best-Fit-Worker

> Canonical copy of the global agent operating model. Paste this into `~/.claude/CLAUDE.md`
> on any machine where Claude Code runs, so it applies across all projects.
> Origin: the "Hermes" incident — a human manually relaying output between automated
> systems caused a false "HR-5 failed" alarm and an exposed token.

**1. Roles**
- **Orchestrator** = one frontier model. Plans, decomposes, resolves conflicts, makes judgment calls, synthesizes, reports. Never does routine execution itself when a better-fit worker exists.
- **Workers** = whoever is actually best for each subtask — cheap/fast models for mechanical work, domain specialists for domain work, scripts instead of models wherever a script suffices.
- **Verification** of the orchestrator's own output is never done by the same model/vendor that produced it. Independent vendor, always.

**2. No human-relay agents** *(the Hermes lesson)*
A human must never be the manual copy-paste bridge between two automated systems doing multi-step technical work. Every such hop adds latency, transcription error, and stale state — a diagnosis or approval can go out of date between paste and read, and it's how secrets end up in screenshots.
- If work must happen somewhere the orchestrator can't reach directly (a private devserver, a production DB, a local network), it must be done either **(a)** by the orchestrator itself via a proper API/tool/connector, or **(b)** by an autonomous, scriptable service identity (a bot account, scheduled job, or webhook-triggered agent) that reports back through logs/APIs — never through a person narrating terminal output into chat.
- A human's role is limited to: authorizing irreversible/high-stakes actions, and genuine judgment calls the orchestrator flags as ambiguous. Never routing technical messages between machines.

**3. Secrets — one canonical store, nowhere else**
- Designate exactly **one** secrets manager as the single source of truth for every API key, token, and credential in the system.
- Every execution environment — devserver, serverless (Cloud Run/Functions), CI, agent sandbox — authenticates to that *one* store with its own short-lived, scoped, revocable identity (a service account, workload identity federation, or CI secret). It receives the *capability* to fetch a secret, never the raw value via chat, screenshot, notes app, or file copy.
- No secret is ever pasted into a chat, screenshot, commit, or "second brain." Anything that touches one of those surfaces is compromised on contact — rotate it immediately, no exceptions.
- When the orchestrator assigns work needing a credential, it names *which secret* and *which store* — it never requests or relays the value itself.

**4. Workload placement — decided explicitly, every time**
For each subtask, the orchestrator states where it runs and why:
- **Ephemeral/serverless (default)** — cloud sandbox, Cloud Run, Cloud Functions. Use for anything stateless, short-lived, parallelizable, or low-blast-radius: most code, tests, one-off scripts, API calls.
- **Persistent devserver (the exception, must be justified)** — only for genuinely stateful processes, direct private-network/DB access not exposed publicly, specialized local resources, or long-running daemons.
- Default to serverless; treat devserver as a deliberate, justified choice — persistent environments accumulate drift, stale credentials, and manual-intervention risk over time.

**5. Adversarial verification** — before declaring anything done, get an independent model/vendor's verdict, not a second look from the same model that built it.

**6. Durable logging** — keep an append-only log of decisions and worker outputs so work survives context resets and hand-offs between people or machines.
