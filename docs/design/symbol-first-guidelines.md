# Symbol-First Design Guidelines — Internal Admin & Worker Tools

> Scope: **internal** surfaces only — admin tooling and field-worker/staff flows.
> The **external public website** is explicitly NOT bound by these rules (it is
> artistic, brand-led, and multilingual — see the separate external DoD).
> Owner rule, 2026-07-03: staff interaction "must be symbols and not rely on
> read/written languages." Linear: RAJ-485.

## The one test that matters

**A person who cannot read any of our supported languages must be able to
complete the core task unaided.** Every staff screen is judged against this. If
removing all text would make the task impossible, the screen fails.

Text is permitted as a *reinforcement* (a label under an icon, a confirmation
number) — never as the *only* carrier of a required instruction, choice, or
status.

## The seven rules

1. **Every action is an icon first.** A recognisable pictogram (camera, broom,
   wrench, cart, banknote, tick, cross) carries the meaning; a short localised
   caption sits under it as support. Never an icon whose meaning depends on
   reading its label.
2. **Numbers are numerals, entered on a big numeric pad.** Money and counts use
   a full-screen number pad with a large running total. No spelled-out amounts,
   no tiny keyboard fields.
3. **Categories are pictures, not lists.** Expense/receipt categories are chosen
   from a grid of icons + colour (broom = cleaning, wrench = maintenance, cart =
   supplies, plug = utilities, car = transport…). The icon set is fixed and
   learnable; the same icon means the same thing everywhere.
4. **Onboarding is visual.** Staff enrol by scanning a QR code the manager shows
   them (scan = enrolled), backed by phone-OTP. No typed usernames/passwords for
   field staff. (RAJ-486.)
5. **Status is colour + symbol + haptic — never a sentence.** Green tick =
   saved; amber clock = queued/pending; red cross + shake = failed. A colour is
   never the *only* signal (accessibility: always pair colour with a distinct
   shape, per contrast rules).
6. **Progress is dots, not prose.** Multi-step capture shows step pips (●●○○) and
   a back arrow; the user always sees where they are and how to retreat.
7. **Confirm with tick / cross on a visual summary.** The final step shows the
   photo + the numerals + the category icon; the user confirms with a large
   green tick or cancels with a red cross. The receipt image itself is the
   primary "did I get this right?" cue.

## The canonical capture flow (reference implementation)

```
[📷 big camera button]
      ↓  (native camera → photo)
[ photo preview — retake ↺ or keep ✓ ]
      ↓
[ numeric pad, large running total at top ]
      ↓
[ icon category grid — tap one ]
      ↓
[ visual summary: photo + amount numerals + category icon ]
      ↓
[ 🟢 tick = submit   🔴 cross = cancel ]
      ↓
[ green tick + haptic → done | amber clock → queued offline ]
```

No step on this path requires reading a sentence to proceed.

## What still carries text (and why it's allowed)

- **Numerals** (amounts, dates as `dd / mm`, counts) — universal.
- **The receipt photo** — the source of truth the worker recognises visually.
- **Short reinforcement captions** under icons — localised, but redundant to the
  icon, so a non-reader loses nothing by ignoring them.

## Accessibility guardrails (do not trade these away for "clean")

- Colour is never the sole signal — always colour **and** shape/icon.
- Touch targets ≥ 44×44 px; primary actions thumb-reachable (bottom third).
- Icons meet contrast requirements against their background.
- Haptic feedback on submit/success/failure where the device supports it.

## Boundary with the external site (do not cross)

- The internal symbol rule must **not** flatten the public marketing site's
  design — that site is artistic and copy-led.
- The public site's styling must **not** leak text-dependence back into staff
  tools — e.g. don't replace a category icon grid with a prose dropdown because
  it "looks more premium".

## Acceptance checklist (per staff screen)

- [ ] Core task completable with all text hidden (usability check, non-reader).
- [ ] Every action has a first-class icon; captions are reinforcement only.
- [ ] Amounts/counts entered via numeric pad with a visible running total.
- [ ] Categories chosen from an icon+colour grid, not a text list.
- [ ] Status shown by colour **and** shape/icon (+ haptic where available).
- [ ] Progress shown as step pips with a back affordance.
- [ ] Final confirm is a visual summary + tick/cross.
- [ ] No colour-only signals; touch targets ≥ 44px; icon contrast passes.
