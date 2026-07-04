# Legal Position Note — Cross-Border OCR Transfer of Receipt/Note Images (Sri Lanka)

> Linear RAJ-492 · BLOCKING gate for Phase B · Prepared 2026-07-03 from PRIMARY
> Sri Lankan statutory text. **Research, NOT legal advice** — lawyer sign-off items
> flagged in §4. Full source register + verbatim section reading in the research
> record; this file is the durable summary.

## Bottom line (go/no-go for Phase B)

**GO, on the explicit-consent basis.** Sending photographed receipts/notes to a
third-party OCR API abroad (z.ai GLM vision / Google Gemini vision) is permissible for
BookLets provided we obtain **explicit, informed, risk-disclosed opt-in consent** before
any image leaves Sri Lanka (PDPA s.26(5)(a)), plus a Schedule I lawful basis for the
underlying processing (s.5). No data-residency law blocks us.

## Key findings (all PRIMARY-SOURCED from Act text on parliament.lk unless tagged)

1. **A photographed receipt IS "personal data"** — PDPA No. 9 of 2022 s.56 expressly lists
   "financial data" as an identifier. Treat the image stream as personal data by default.
2. **No data-localization law binds BookLets.** The ONLY SL statutory residency rule is
   PDPA **s.26(1)**, which binds **"public authorities" only** (s.56: Ministries, Departments,
   Provincial Councils, local authorities, statutory bodies). BookLets is a private app →
   not caught. s.26(3)–(5) expressly permit private controllers to transfer abroad.
3. **Computer Crimes Act No. 24 of 2007 localization claim → REFUTED from primary text.**
   It is purely a computer-offences/investigation statute (long title + offence list
   confirmed verbatim); contains NO data-residency or cross-border provision. Do not repeat
   this claim in any BookLets deliverable.
4. **Explicit consent is a sufficient transfer basis (s.26(5)(a))** because SL has no adequacy
   decisions and only DRAFT safeguard-instrument directives. Consent (s.56) must be freely
   given, specific, informed, unambiguous, affirmative, and withdrawable.
5. **Commencement: substantive Parts (I, II, III, VII incl. s.26) are NOT yet operative as of
   mid-2026.** The original 18 Mar 2025 date was repealed (Gazette 2427/34, 14 Mar 2025) and
   Amendment Act No. 22 of 2025 (Gazette 31 Oct 2025) made commencement depend on a future
   ministerial Order that has not issued. Penalties (LKR 10m/breach) not yet live. **Build to
   comply now** — activation can be sudden by gazette.
6. **No registration regime; DPO likely not mandatory** at BookLets' scale (draft thresholds
   ~25,000 subjects / 20+ processors).

## Must implement before Phase B ships (s.26(5)(a) consent basis)

1. **Explicit, informed, risk-disclosed opt-in consent flow** — before any image leaves SL,
   an affirmative (not pre-ticked, not bundled) opt-in to a plain-language notice stating:
   the image may contain personal/financial data; it will be **sent outside Sri Lanka** to a
   named third-party OCR provider (z.ai GLM / Google Gemini); SL has **no adequacy decision /
   no safeguard instrument** and the **possible risks** of that; the purpose (receipt text
   extraction), retention, controller identity, data-subject rights, and that consent is
   **withdrawable**. Log consent version + timestamp + user.
2. **Transfer/consent logging** per image: consent version, timestamp, user, destination
   provider, purpose (accountability + proof of s.26(5)(a)).
3. **Data minimisation before transfer** — send only what OCR needs; avoid images that could
   reveal special categories (s.56 "…including photographs… racial or ethnic origin" → higher
   Schedule II bar).
4. **Underlying lawful basis** — record a Schedule I basis for the processing itself (s.5).
   Transfer consent and processing basis are TWO separate requirements — satisfy both.
5. **Privacy notice** publishing cross-border transfer details + recipients.
6. **Prefer the safeguards route once directives mature** — move from consent-only to a binding
   contractual safeguard / TIA with the OCR provider; track z.ai and Google DPA terms now.
7. **Assign an owner to monitor the SL Government Gazette** for the commencement Order and final
   cross-border directives.

## Lawyer sign-off required before Phase B (do not treat this note as legal advice)

- Confirm current commencement status of Parts I/II/III/VII against the live Gazette.
- Approve exact wording of the s.26(5)(a) consent notice + risk disclosure.
- Confirm BookLets is not caught by any sector regime (e.g. Financial Consumer Protection
  Regulations No. 1 of 2023 — binds only CBSL-supervised institutions).
- Confirm whether any receipt content plausibly falls into special categories (→ Schedule II).

## Honest gaps

- Amendment Act No. 22 of 2025 PDF did not render as text this session; its section wording and
  the Gazette 2427/34 repeal are corroborated by strong SECONDARY sources (DLA Piper; ClearLaunch
  verified Jun 2026), not opened verbatim. Reported (Biometric Update, DPA officials) to have
  RELAXED cross-border flows — favourable, but confirm against amended s.26 text before relying.
- DPO thresholds, cross-border instrument directives, breach-notification and DPMP guidance are
  all still DRAFT; final versions may change specifics.
