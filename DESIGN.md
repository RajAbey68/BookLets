# BookLets Design System — Full Token Specification

> **Version:** 2.0  
> **Status:** Active (glass-dark theme)  
> **AI Context:** This document is the machine-readable source of truth for every visual token, component primitive, and layout rule used by BookLets. Refer here before generating or modifying any UI.

---

## 1. Theme Tokens — Glass-Dark

All tokens are expressed as CSS custom properties on `:root`. Every component MUST use these variables directly — no hardcoded colors outside this spec.

### 1.1 Color Palette

| Token | Value | Usage |
|---|---|---|
| `--bg-color` | `#0b0f19` | Deep obsidian — root page background |
| `--sidebar-bg` | `rgba(15, 23, 42, 0.7)` | Sidebar / drawer backdrop |
| `--header-bg` | `rgba(15, 23, 42, 0.4)` | Top app bar |
| `--surface-color` | `rgba(255, 255, 255, 0.04)` | Glass surface default |
| `--surface-color-hover` | `rgba(255, 255, 255, 0.08)` | Hover state on glass surfaces |
| `--surface-border` | `rgba(255, 255, 255, 0.1)` | Glass card / panel borders |
| `--surface-border-hover` | `rgba(255, 255, 255, 0.18)` | Hover border state |
| `--text-primary` | `#f8fafc` | Primary body + heading text |
| `--text-secondary` | `#94a3b8` | Supporting text, labels, metadata |
| `--text-muted` | `#64748b` | Dimmed / disabled text |
| `--accent-color` | `#3b82f6` | SymbiOS Blue — primary action, active links |
| `--accent-hover` | `#60a5fa` | Accent hover / focus glow |
| `--accent-subtle` | `rgba(59, 130, 246, 0.1)` | Subtle accent backgrounds |
| `--danger-color` | `#f43f5e` | Destructive actions, errors |
| `--danger-subtle` | `rgba(244, 63, 94, 0.1)` | Danger background tint |
| `--success-color` | `#10b981` | Success, posted, reconciled |
| `--success-subtle` | `rgba(16, 185, 129, 0.1)` | Success background tint |
| `--warning-color` | `#f59e0b` | HIL required, warnings, pending |
| `--warning-subtle` | `rgba(245, 158, 11, 0.1)` | Warning background tint |

### 1.2 Glass & Blur Scale

| Token | Value |
|---|---|
| `--glass-blur` | `blur(16px)` |
| `--glass-blur-heavy` | `blur(32px)` |
| `--glass-blur-light` | `blur(8px)` |

### 1.3 Shadow Scale

| Token | Value | Usage |
|---|---|---|
| `--shadow-sm` | `0 1px 3px rgba(0,0,0,0.3)` | Small elevation |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.4)` | Cards, dialogs |
| `--shadow-lg` | `0 12px 36px rgba(0,0,0,0.5)` | Modals, overlays |
| `--shadow-glow-accent` | `0 0 24px rgba(59, 130, 246, 0.3)` | Accent glow for buttons |
| `--shadow-glow-success` | `0 0 24px rgba(16, 185, 129, 0.25)` | Success state glow |

### 1.4 Border Radius Scale

| Token | Value | Usage |
|---|---|---|
| `--radius-sm` | `6px` | Badges, small elements |
| `--radius-md` | `10px` | Buttons, inputs |
| `--radius-lg` | `12px` | Glass cards, panels |
| `--radius-xl` | `16px` | Modals, sheets |
| `--radius-full` | `9999px` | Pills, avatars |

### 1.5 Spacing Scale

| Token | Value | px (approx) |
|---|---|---|
| `--space-1` | `0.25rem` | 4px |
| `--space-2` | `0.5rem` | 8px |
| `--space-3` | `0.75rem` | 12px |
| `--space-4` | `1rem` | 16px |
| `--space-5` | `1.25rem` | 20px |
| `--space-6` | `1.5rem` | 24px |
| `--space-8` | `2rem` | 32px |
| `--space-10` | `2.5rem` | 40px |
| `--space-12` | `3rem` | 48px |

### 1.6 Typography Scale

| Token | Value | Weight | Line Height | Usage |
|---|---|---|---|---|
| `--text-xs` | `0.625rem` | 600 | 1.2 | Badges, labels |
| `--text-sm` | `0.75rem` | 600 | 1.4 | Table headers, captions |
| `--text-base` | `0.875rem` | 500 | 1.5 | Body, buttons |
| `--text-md` | `0.9375rem` | 500 | 1.5 | Larger body |
| `--text-lg` | `1rem` | 600 | 1.4 | Section headings (h3) |
| `--text-xl` | `1.25rem` | 700 | 1.4 | Sub-section headings |
| `--text-2xl` | `1.75rem` | 700 | 1.3 | Page headings (h2) |
| `--text-3xl` | `2.25rem` | 700 | 1.2 | Stat values |
| `--text-4xl` | `2.75rem` | 800 | 1.1 | Hero / dashboard titles (h1) |

**Font family:** `'Inter', sans-serif` (loaded via `next/font/google` with `display: swap`).

### 1.7 Transition & Animation Tokens

| Token | Value | Usage |
|---|---|---|
| `--transition-fast` | `0.15s ease` | Hover, active, micro-interactions |
| `--transition-normal` | `0.25s ease` | Card hover lift, drawer open |
| `--transition-slow` | `0.35s ease` | Page transitions, mood changes |
| `--spring-fast` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Springy scale on click |
| `--spring-normal` | `cubic-bezier(0.22, 1, 0.36, 1)` | Generic spring overshoot |

### 1.8 Z-Index Scale

| Token | Value | Usage |
|---|---|---|
| `--z-base` | `1` | Default stacking |
| `--z-header` | `40` | App header |
| `--z-overlay` | `90` | Mobile sidebar overlay |
| `--z-sidebar` | `100` | Sidebar / drawer |
| `--z-modal` | `200` | Dialogs, modals |
| `--z-toast` | `300` | Toast notifications |
| `--z-tooltip` | `400` | Tooltips |

---

## 2. Layout & Viewport

### 2.1 Safe Area Viewport Meta

Every page MUST include the following viewport meta:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

All `env(safe-area-inset-*)` values are consumed through CSS:

```css
:root {
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
}
```

### 2.2 App Shell

```
┌──────────────────────────────────────┐
│  App Header (64px mob / 72px desk)   │  ← z-index: 40, glass backdrop
├──────────────────────────────────────┤
│  Main Content (overflow-y: auto)     │
│  padding: 1.25rem mob / 3rem desk    │
│                                      │
└──────────────────────────────────────┘
┌──────────────────────────────────────┐
│  Bottom Tab Bar (mobile, 56px + sb)  │  ← New: mobile-only
└──────────────────────────────────────┘
```

### 2.3 Breakpoints

| Name | Min Width | Target |
|---|---|---|
| `sm` | 640px | Tablet portrait |
| `md` | 768px | Tablet landscape |
| `lg` | 1024px | Desktop / sidebar visible |

Mobile-first: `@media (min-width: ...)` for progressive enhancement.

---

## 3. Component Primitives

### 3.1 Glass Card (`.glass-card`)

```
┌──────────────────────────┐
│  background: var(--surface-color)
│  border: 1px solid var(--surface-border)
│  border-radius: var(--radius-lg)
│  padding: var(--space-6)
│  backdrop-filter: var(--glass-blur)
├──────────────────────────┤
│  Content goes here        │
│                          │
└──────────────────────────┘
  ↓ on hover
  transform: translateY(-2px);
  border-color: var(--surface-border-hover);
```

### 3.2 Button System

| Variant | Background | Border | Text | Special |
|---|---|---|---|---|
| `.btn-primary` | `var(--accent-color)` | none | `#fff` | `box-shadow: var(--shadow-glow-accent)` |
| `.btn-secondary` | `var(--surface-color)` | `1px solid var(--surface-border)` | `var(--text-primary)` | hover: accent border |
| `.btn-danger` | `var(--danger-color)` | none | `#fff` | `box-shadow: 0 4px 12px rgba(244,63,94,0.3)` |
| `.btn-ghost` | transparent | none | `var(--text-secondary)` | hover: `var(--surface-color)` bg |

All buttons: `min-height: 44px` (mobile touch target), `padding: 0.75rem 1.25rem`, `transform: scale(0.98)` on active.

### 3.3 Data Table (`.premium-table`)

**Desktop:** Standard `<table>` with sticky header.  
**Mobile (< 1024px):** Card-style — each row becomes a stacked card with `data-label` attribute driving the pseudo-element label.

```
Desktop:                            Mobile:
┌──────┬──────┬──────┐             ┌──────────────────┐
│ Name │ Amt  │ Date │             │ Name: Acme Inc   │
├──────┼──────┼──────┤             │ Amt:  €1,200.00  │
│ ...  │ ...  │ ...  │             │ Date: 2025-06-01 │
└──────┴──────┴──────┘             └──────────────────┘
```

### 3.4 Input System

| Token | Value |
|---|---|
| Background | `var(--surface-color)` |
| Border | `1px solid var(--surface-border)` |
| Border (focus) | `1px solid var(--accent-color)` |
| Border radius | `var(--radius-md)` |
| Padding | `0.75rem 1rem` |
| Font | `var(--text-base)` |
| Min height | `44px` (mobile touch target) |
| Label | `var(--text-sm)`, `var(--text-secondary)`, uppercase |

### 3.5 Bottom Tab Bar (Mobile-Only)

```
┌──────────┬──────────┬──────────┬──────────┐
│  Home    │ Ledger   │ Reports  │ More     │
│  (icon)  │  (icon)  │  (icon)  │  (icon)  │
└──────────┴──────────┴──────────┴──────────┘
  ↑ active tab gets var(--accent-color)
  ↑ height: 56px + env(safe-area-inset-bottom)
  ↑ backdrop-filter: var(--glass-blur-heavy)
  ↑ max 5 tabs; labels truncated at 6 chars
```

### 3.6 AI Automation & State Badges

| State | Visual | CSS |
|---|---|---|
| **ANALYZING** | Pulse animation on accent | `.is-analyzing` — `animation: pulse-accent 1.6s ease-in-out infinite` |
| **SUCCESS/POSTED** | Static success border glow | `.is-success` — `border-color: var(--success-color)` + `box-shadow: var(--shadow-glow-success)` |
| **HIL_REQUIRED** | Pulsing warning border | `.is-hil` — `animation: pulse-warning 1.6s ease-in-out infinite` |

```css
@keyframes pulse-accent {
  0%, 100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.35); }
  50%      { box-shadow: 0 0 0 8px rgba(59, 130, 246, 0);    }
}
@keyframes pulse-warning {
  0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.35); }
  50%      { box-shadow: 0 0 0 8px rgba(245, 158, 11, 0);    }
}
```

---

## 4. Mobile Touch Targets

Every tappable element MUST have a minimum touch target of **44×44 CSS pixels** (WCAG 2.2 / Apple HIG). Use `min-height: 44px` and `min-width: 44px` where applicable.

| Element | Min Size | Spacing |
|---|---|---|
| Buttons | 44×44 | ≥ 8px gap between adjacent targets |
| Nav items | 44×44 | ≥ 8px |
| Icon-only buttons | 44×44 (with 24×24 icon centered) | ≥ 8px |
| List items | 44px min height | ≥ 8px padding |
| Tab bar items | 48×44 | Full width with flex |

---

## 5. Thumb Zone Layout (Mobile)

Following the iOS thumb zone model:

```
┌────────────────────────────────────────┐
│  ❌ Hard-to-reach zone (top-left)      │  ← Avoid primary actions here
│  → Place menu, back buttons            │
├────────────────────────────────────────┤
│  ⚡ Sweet zone (center-right)          │  ← Primary actions, confirm
│  → Natural right-thumb arc             │
├────────────────────────────────────────┤
│  ⚡ Sweet zone (bottom bar)            │  ← Tab navigation, urgent actions
│  → Within thumb rest area              │
└────────────────────────────────────────┘
```

Layout guidelines:
- **Top-left (44×44):** Back, menu hamburger, secondary controls
- **Bottom bar (100% width, 56px tall):** Primary navigation tabs
- **Right edge (bottom 25%):** FAB-style "Create Entry" / primary CTA
- **Avoid top-right** for critical actions on large phones
- All bottom elements add `padding-bottom: env(safe-area-inset-bottom)`

---

## 6. Icons

- Use inline SVGs (no icon library dependency).
- Default icon size for nav: `24×24` (viewBox `0 0 24 24`).
- Default icon size for inline with text: `14–18px` (height/width).
- Stroke width: `2` for nav, `2.5` for small inline icons.
- Color: `currentColor` (inherits from parent text color).
- All icons MUST have `aria-hidden="true"` or appropriate `aria-label`.

---

## 7. Accessibility Tokens

| Concern | Rule |
|---|---|
| Color contrast | All text on `--bg-color` must pass WCAG AA (4.5:1 normal, 3:1 large) |
| Focus rings | `outline: 2px solid var(--accent-color)` offset 2px, shown on `:focus-visible` |
| Reduced motion | `@media (prefers-reduced-motion)` disables pulse animations, reduces transitions to `0.01ms` |
| Touch targets | Minimum 44×44 CSS pixels |
| Labels | All inputs require `<label>` or `aria-label` |

---

## 8. Code Generation Directives

When generating new UI:

1. **Token-first:** Use CSS variables from this spec — never hardcode values.
2. **Mobile-first:** Write `base` styles for mobile, use `@media (min-width: 1024px)` for desktop overrides.
3. **Glass card every block:** Every major functional block gets `.glass-card`.
4. **Touch targets ≥ 44px:** Every tappable element meets touch target minimum.
5. **Safe areas:** Bottom-anchored elements add `env(safe-area-inset-bottom)` padding.
6. **AI states:** Automation components always render visual state (ANALYZING / SUCCESS / HIL_REQUIRED).
7. **Scannability:** Accounting data uses semantic `premium-table` format.
8. **HIL first:** If a task requires Human-in-the-Loop, the action button is primary and distinct.
9. **Icons inline:** Inline SVGs only — no icon library imports.
10. **Dark theme default:** No light mode in v1; `color-scheme: dark` on `<html>`.
