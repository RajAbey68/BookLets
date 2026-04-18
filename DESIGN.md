# BookLets Design System (Stitch Specification)

This document serves as the machine-readable source of truth for the BookLets UI/UX. AI agents (including Stitch) should refer to this context when generating or modifying components.

## 🎨 Visual Identity & Brand

- **Vibe**: Premium, AI-native, high-trust, and architectural.
- **Glassmorphism Base**: Heavy reliance on semi-transparent surfaces, deep blurs, and subtle borders.
- **Color Palette**:
    - `background`: #0b0f19 (Deep obsidian)
    - `surface`: rgba(255, 255, 255, 0.04)
    - `border`: rgba(255, 255, 255, 0.1)
    - `accent`: #3b82f6 (SymbiOS Blue)
    - `success`: #10b981
    - `danger`: #f43f5e
- **Typography**:
    - **Primary**: 'Inter', sans-serif (Precision and clarity)
    - **Header Weight**: 800 (Extra Bold for distinct hierarchy)

## 🧩 Component Patterns

### 1. Glass Card
Every major functional block must be wrapped in a `.glass-card`.
- **Blur**: 16px
- **Border**: 1px solid var(--surface-border)
- **Transition**: 0.25s ease-in-out on hover (translateY -2px).

### 2. Premium Button
- **Primary**: Solid accent color with subtle glow.
- **Secondary**: Outlined with glass border.
- **Micro-animation**: Scale 0.98 on click.

### 3. AI Automation States
Automated components must provide visual feedback of their "thinking" or "governance" status:
- **ANALYZING**: Pulse animation using accent color.
- **SUCCESS/POSTED**: Static success border glow.
- **HIL_REQUIRED**: Pulsing warning border.

## 🤖 AI Design Context
When generating new screens:
1.  **Prioritize Scannability**: Accounting data should be in clean `premium-table` formats.
2.  **Highlight Automation**: Use subtle badges for AI-generated entries.
3.  **HIL First**: If a task requires Human-in-the-Loop approval, make the action button primary and distinct.
