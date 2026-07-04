# Design References — Best-in-Class Patterns to Adopt (BookLets v2)

> Owner directive 2026-07-03: "be influenced by third-party websites top of their
> class for UI/UX; we'll copy it." Every internal-tools row was inspected as a real
> screen on Mobbin (links live); every external row traces to a named product/source.
> Linear: RAJ-483 / 485 / 487. Research-only — no fabrication; unverifiable items in §4.

## 1. Internal tools — mobile-first, guided, SYMBOL-FIRST

Target: an admin/worker who may not read fluently and must still capture an expense,
enter an amount, pick a category, and post it.

| App | Flow / screen | Pattern to adopt | Why it fits symbol-first + non-accountant + mobile |
|---|---|---|---|
| Expensify | [Create expense via photo](https://mobbin.com/flows/49a113d4-5959-4b6e-ae99-a4a0a0e917c3) | Manual/Scan/Distance icon pills → full-screen camera, one big green shutter | One dominant action per screen; non-reader taps camera + shutter |
| Expensify | [Manual amount](https://mobbin.com/flows/96eca170-e2c5-41da-be39-bc51510e7837) | Oversized live `$0` + dedicated numeric pad, green Next | Numerals universal; the big figure is the feedback |
| Expensify | Confirm-details | Review card: receipt thumbnail on top, tappable rows, one green Create | The photo (not text) proves what's posting — the review-queue gate |
| Buddy | [Categories](https://mobbin.com/flows/0da6b259-ff4a-43b6-a24e-daec4d8d2f98) | Coloured circular category icons inline under the amount | Colour + icon = recognition without reading |
| bless. | [Category grid](https://mobbin.com/flows/31458b0a-decb-4fda-b32c-68afa0606679) | 4-across monochrome icon-tile category grid, one tap = selected | Strongest pure symbol-first picker found |
| Rocket Money | [Category icon](https://mobbin.com/flows/efb2c010-d135-462e-bce6-bb236dd2cd6d) | Every category gets BOTH an icon and a colour token | Two redundant cues per category for low-literacy robustness |
| YNAB | [Approve scheduled txn](https://mobbin.com/flows/50808b84-7bf6-4f70-a2c5-1236186c450a) | Count-badged review pill → per-item icon actions → "You're All Done!" | Confirm-before-post at scale; visual closure for non-readers |
| Monarch | [Add a review](https://mobbin.com/flows/a1ae5455-ecef-49b2-99db-31753798ec66) | Green-tick "You reviewed everything!" completion card | Positive colour-driven closure |
| Taco Bell | [Scan receipt](https://mobbin.com/flows/18c8b0ba-4cb8-4d75-8298-976c113210e7) | Framing brackets + live "move closer" proximity nudge | Brackets tell a non-reader where to aim; live hint corrects without prose |
| Duolingo | [Onboarding](https://mobbin.com/flows/ac9d2f58-868d-4fd3-a79c-9655ce6b1522) | One question per screen, illustrated single-select, top progress bar | Gold standard for guiding non-experts; never two asks at once |
| Rocket Money | [Onboarding](https://mobbin.com/flows/fed2772b-6edd-432f-b195-0691f2d84d04) | Icon-led single-select question cards | Same wizard shape applied to finance |
| Mimo | [Onboarding](https://mobbin.com/flows/a59b2d63-1c67-4f4c-9fac-e9565ee90657) | 3-stop slider for ordinal input | Slider beats keyboard for low-literacy "how much" input |

External refs for internal tools:
- **Pleo** — capture at the moment of purchase: card tap → push → one-tap photo → OCR
  auto-fills vendor/date/amount → auto-matched, with offline capture that syncs later.
  Adopt: nudge-to-capture, OCR pre-fill (confirm not type), offline-first.
- **Photomath / Google Lens** — point→instant result: framing rectangle/brackets,
  confirmation of the recognised value before showing the result. Adopt the framing
  affordance + OCR-value confirmation step.

## 2. External public website — artistic, brand-led, multilingual (en + si/ta/zh/hi)

| Ref | Pattern | Adopt | Why translation-robust |
|---|---|---|---|
| Way (hospitality SaaS) | Looping video hero + luxury endorsement band | Video/real-imagery hero + social-proof | Video carries premium feel with minimal words → survives translation |
| Linear/Framer/Notion | Narrative hero, visual explains value before scroll | Short headline + explanatory visual | 4–6 word headline translates cleanly; the visual does the work |
| Storylane | Personality via palette + illustration, not more copy | Brand via colour/illustration | Less copy = fewer translation-length blowouts |
| Magical | Disciplined dark-luxury, clean | Pick ONE luxury direction intentionally | Aligns with owner's design-quality rules |
| Tamil Design System | Inter (Latin) + Noto Sans Tamil, line-height 1.8 for Tamil | Per-script font pairing via `:lang()`, taller Indic line-height | Proven anti-tofu, no clipped conjuncts |
| Noto ecosystem | Dedicated Noto per script; no universal font | Per-script Noto + `unicode-range` partition; Noto fallback chain | Covers all 5 languages; keeps CJK off non-CJK visitors |

Translation-robust typography rules:
1. Design for +30–40% text expansion (Tamil/Sinhala run longer) — no fixed-width copy boxes.
2. Per-script line-height (Indic/CJK need more vertical room).
3. `:lang()` weight correction (400 reads heavier in dense scripts).
4. Subset Indic fonts preserving OpenType GSUB/GPOS; test conjuncts.
5. Always chain to Noto fallback (prevent tofu breaking layout).
6. Keep hero/section copy short and idiomatic.

## 3. Adopt / Avoid

**Adopt:** (1) camera-first one-tap capture with OCR pre-fill; (2) oversized live numeral
+ dedicated numeric pad; (3) icon+colour category picker (two channels); (4) one-decision
wizard with progress bar + illustrated cards; (5) confirm-before-post card anchored on the
receipt photo; (6) count-badged review queue → per-item icon actions → explicit "All Done";
(7) framing brackets + live proximity nudge for scanning; (8) public site: video/real-imagery
hero + short narrative headline + per-script Noto pairing.

**Avoid:** (1) text-field-first "add expense" forms (Splitwise) — text is a label, never the
gate; (2) default Tailwind/shadcn card-grid look (anti-template policy; show ≥4 of 10 design
qualities); (3) dense multi-field single-screen add-transaction (Quicken/Monarch detail) —
split into wizard steps; (4) fixed-width text containers / single global line-height on the
public site (clips Tamil/Sinhala, overflows on translation).

## 4. Could NOT verify (no fabrication)

- Ramp receipt-capture UX — not inspected; Pleo is the sourced alternative.
- Dext/Receipt Bank, QuickBooks, Xero, Wave — named but no verified screens pulled this pass;
  follow-up Mobbin search recommended.
- Non-reader/screen-reader accessibility of scan apps specifically — sources describe how scan
  works, not accessibility; the audio/haptic inferences in §1 are synthesis, flagged as such.
- "Way" site — cited via a Webflow roundup, not visited directly.
