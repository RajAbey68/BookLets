# BookLets — Mobile-Native Integration Plan

> **Version:** 1.0  
> **Status:** Draft for implementation  
> **Context:** BookLets runs as a Next.js web app targeting both desktop (sidebar nav) and mobile (bottom tab bar) form factors. This document specifies all iOS/Android native feature integration points for a hybrid approach using the Web platform (PWA + Capacitor/Cordova bridge where needed).

---

## 1. Mobile Navigation Architecture

### 1.1 Bottom Tab Bar

Replace the desktop sidebar with a fixed bottom tab bar on mobile (< 1024px).

**Tab Definitions (max 5):**

| # | Icon | Label | Route | Visible |
|---|---|---|---|---|
| 1 | Grid/Dashboard | Home | `/` | Always |
| 2 | Calendar | Bookings | `/bookings` | Always |
| 3 | Book | Ledger | `/ledger` | Always |
| 4 | Trending-Up | Reports | `/reports` | Always |
| 5 | User/More | More | *(sheet or menu popover)* | Always |

**Reports sub-routes (accessible via "More" → card grid or a sub-navigation sheet):**

- P&L Statement — `/reports/pl`
- Balance Sheet — `/reports/balance-sheet`
- Trial Balance — `/reports/trial-balance`
- Property Yield — `/properties`

**Tab Bar Spec:**

```
┌──────────────────────────────────────────────────┐
│  Active tab: var(--accent-color) icon + label     │
│  Inactive tab: var(--text-secondary)              │
│  Background: rgba(15, 23, 42, 0.9)               │
│  backdrop-filter: blur(32px)                      │
│  Border-top: 1px solid var(--surface-border)      │
│  Height: 56px + env(safe-area-inset-bottom)       │
│  Label: var(--text-xs), truncate at 6 chars       │
│  Icon: 24x24 viewBox, strokeWidth={2}             │
│  Transition: spring-based on tab switch           │
└──────────────────────────────────────────────────┘
```

**Implementation Notes:**
- Add `BottomTabBar.tsx` component rendered only at mobile breakpoint (`lg-hidden sm-only-flex`)
- Use `usePathname()` and `useRouter()` for tab highlighting and navigation
- Animate indicator line under active tab with Framer Motion or CSS spring animation
- Prevent layout shift when keyboard opens: `position: sticky` + keyboard-aware height

---

## 2. Native Feature Integration

### 2.1 Haptic Feedback

**Purpose:** Provide tactile feedback on key interactions — button taps, tab switches, pull-to-refresh, success/error confirms.

**Strategy — Web Haptic API (Vibration):**

```typescript
// lib/haptics.ts
type HapticType = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';

const HAPTIC_PATTERNS: Record<HapticType, number[]> = {
  light:   [10],
  medium:  [20],
  heavy:   [40],
  success: [10, 30, 10],    // short-light-medium
  warning: [30, 50, 30],    // medium-heavy-medium
  error:   [50, 30, 50, 30], // heavy-heavy
};

export function triggerHaptic(type: HapticType = 'light'): void {
  if (typeof navigator === 'undefined' || !navigator.vibrate) return;
  const pattern = HAPTIC_PATTERNS[type];
  navigator.vibrate(pattern);
}
```

**Capacitor/Cordova Bridge (enhanced haptics):**

```typescript
// When running inside Capacitor, use @capacitor/haptics plugin instead
// import { Haptics, ImpactStyle } from '@capacitor/haptics';
// 
// export async function triggerHaptic(type: HapticType): Promise<void> {
//   const map: Record<HapticType, ImpactStyle> = {
//     light: ImpactStyle.Light,
//     medium: ImpactStyle.Medium,
//     heavy: ImpactStyle.Heavy,
//     success: ImpactStyle.Medium,
//     warning: ImpactStyle.Heavy,
//     error: ImpactStyle.Heavy,
//   };
//   await Haptics.impact({ style: map[type] });
// }
```

**Touch Points:**

| Interaction | Haptic Type | Condition |
|---|---|---|
| Tab bar tap | `light` | Always |
| Primary button tap | `medium` | Always |
| Destructive action | `heavy` | Always |
| Entry posted successfully | `success` | On POST complete |
| HIL approval granted | `success` | On 4-eyes approve |
| Error / validation fail | `warning` | On form error |
| Pull-to-refresh trigger | `medium` | On threshold crossed |

### 2.2 Biometric Authentication

**Purpose:** Re-authenticate before sensitive operations — approving a 4-eyes entry, exporting ledger, accessing org settings.

**Strategy — WebAuthn + Capacitor Bridge:**

```typescript
// lib/biometrics.ts
export interface BiometricResult {
  success: boolean;
  error?: string;
}

export async function authenticateBiometric(
  reason: string = 'Confirm your identity'
): Promise<BiometricResult> {
  // Capacitor path (iOS/Android native)
  if (typeof (window as any).Capacitor !== 'undefined') {
    try {
      const { BiometricAuth } = await import('@capacitor/biometric-auth');
      const result = await BiometricAuth.authenticate({ reason });
      return { success: result.authenticated };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  // Web path — fallback to WebAuthn if available
  if (typeof navigator.credentials?.get !== 'undefined') {
    try {
      // Assume platform authenticator (Touch ID / Face ID / Windows Hello)
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: new Uint8Array(32),   // server-generated in production
          rpId: window.location.hostname,
          userVerification: 'required',
        },
      });
      return { success: !!cred };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  return { success: false, error: 'Biometric auth unavailable' };
}
```

**Touch Points:**

| Flow | Reason Prompt | Fallback |
|---|---|---|
| 4-eyes approval | "Approve journal entry" | Password re-entry |
| Ledger export | "Export financial data" | Password re-entry |
| Org settings | "Access organization settings" | Password re-entry |
| App unlock (idle > 5 min) | "Unlock BookLets" | PIN / password |

### 2.3 Native Share Sheet

**Purpose:** Share reports, export links, or booking summaries via the OS share sheet.

**Strategy — Web Share API:**

```typescript
// lib/share.ts
interface SharePayload {
  title: string;
  text: string;
  url?: string;
  files?: File[];
}

export async function shareViaNativeSheet(payload: SharePayload): Promise<boolean> {
  if (typeof navigator.share !== 'function') {
    // Fallback: copy to clipboard + manual instruction
    await navigator.clipboard.writeText(payload.text);
    return false;
  }

  try {
    await navigator.share(payload);
    return true;
  } catch (e: any) {
    if (e.name === 'AbortError') return false; // user cancelled
    throw e;
  }
}
```

**Touch Points:**

| Context | Share Content |
|---|---|
| P&L report | PDF / CSV download link + "Here's the P&L for [period]" |
| Balance sheet | PDF link + "Balance sheet as of [date]" |
| Booking detail | Booking summary + deep link to booking page |
| Owner statement | PDF statement + "Owner statement for [property]" |

### 2.4 Push Notifications

**Purpose:** Notify on AI journal posting, HIL approval requests, sync completion, booking recognition events.

**Strategy — VAPID Web Push (PWA) + Capacitor Push Plugin:**

```typescript
// lib/notifications.ts
export async function registerPushNotifications(): Promise<string | null> {
  // 1. Request permission
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  // 2. Register service worker
  const registration = await navigator.serviceWorker.ready;

  // 3. Subscribe to push (server provides VAPID public key)
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!
    ),
  });

  // 4. Send subscription to server
  await fetch('/api/notifications/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  });

  return subscription.endpoint;
}
```

**Notification Types:**

| Type | Title | Body | Action |
|---|---|---|---|
| `journal_posted` | Entry Posted | "AI posted cleaning fee entry — OK" | Tap → Ledger |
| `hil_requested` | Approval Needed | "€450 expense needs your approval" | Tap → Approvals |
| `sync_complete` | Sync Complete | "Hostaway sync finished — 3 new bookings" | Tap → Bookings |
| `hil_approved` | Entry Approved | "Your entry was approved by [name]" | Tap → Ledger |
| `hil_rejected` | Entry Rejected | "Your entry was rejected — see details" | Tap → Approvals |

**Service Worker Structure:**

```
public/
  sw.js              ← PWA service worker (cache-first for static assets)
  sw-push.js         ← Push event handler (responds to push events)
```

`sw.js` responsibilities:
- Cache app shell on install (precache)
- Serve cached assets for offline use
- Delegate push events to `sw-push.js`

### 2.5 Camera Integration

**Purpose:** Photograph receipts for automatic OCR / journal entry creation.

**Strategy — Native `<input type="file" accept="image/*" capture="environment">` first, Capacitor Camera plugin for advanced control:**

```typescript
// lib/camera.ts
export async function captureReceipt(): Promise<File | null> {
  // Capacitor path (native camera overlay, flash control, EXIF reading)
  if (typeof (window as any).Capacitor !== 'undefined') {
    try {
      const { Camera, CameraSource } = await import('@capacitor/camera');
      const image = await Camera.getPhoto({
        source: CameraSource.Camera,
        quality: 90,
        width: 2048,
        height: 2048,
        resultType: 'base64',
      });
      // Convert base64 to File for upload
      const blob = dataURLToBlob(`data:image/jpeg;base64,${image.base64String}`);
      return new File([blob], `receipt-${Date.now()}.jpg`, { type: 'image/jpeg' });
    } catch (e: any) {
      if (e.message?.includes('cancel')) return null;
      throw e;
    }
  }

  // Web fallback — use browser file picker with camera mode
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';   // ← rear camera
    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      resolve(file);
    };
    input.click();
  });
}
```

**Touch Points:**

| Component | Flow |
|---|---|
| ReceiptUploader | "Take Photo" button → capture → preview → confirm → upload to OCR pipeline |
| Journal Entry Form | Paperclip icon → "Scan Receipt" → capture → attach to entry |
| Quick Entry (Home) | FAB → "Scan Receipt" → capture → auto-create draft entry |

---

## 3. PWA Manifest

No existing manifest found. A `public/manifest.json` must be created:

```json
{
  "name": "BookLets - Property Bookkeeping",
  "short_name": "BookLets",
  "description": "Open-source bookkeeping for short-term rental businesses",
  "start_url": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0b0f19",
  "theme_color": "#0b0f19",
  "categories": ["finance", "business", "productivity"],
  "icons": [
    { "src": "/icons/icon-192x192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/icons/icon-512x512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" },
    { "src": "/icons/icon-v.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" }
  ],
  "screenshots": [
    { "src": "/screenshots/dashboard-mobile.png", "sizes": "390x844", "type": "image/png", "form_factor": "narrow" },
    { "src": "/screenshots/dashboard-desktop.png", "sizes": "1440x900", "type": "image/png", "form_factor": "wide" }
  ]
}
```

---

## 4. Service Worker Strategy

No existing service worker found. Structure:

```
public/sw.js (precache-busting install + stale-while-revalidate)
public/offline.html (offline fallback page with branded message)
```

**Cache strategies:**

| Resource | Strategy | TTL |
|---|---|---|
| App shell (HTML, JS, CSS) | CacheFirst (precache on install) | Until SW update |
| Fonts | CacheFirst (precache) | 30d |
| API responses (GET) | NetworkFirst → fallback to cache | 5 min |
| POST / PATCH | NetworkOnly | N/A |
| Images / icons | StaleWhileRevalidate | 7d |
| Offline page | CacheOnly (precached) | Permanent |

**Push + Notification handling (sw.js onpush):**

```javascript
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  const options = {
    body: data.body ?? '',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/badge-icon.png',
    vibrate: [100, 50, 100],
    data: { url: data.url ?? '/' },
    actions: data.actions ?? [],
  };
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'BookLets', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url ?? '/';
  event.waitUntil(
    clients.openWindow(urlToOpen)
  );
});
```

---

## 5. Spring Animations

Use CSS `cubic-bezier` spring curves for mobile-native feel.

```css
/* Token-level springs */
:root {
  --spring-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);  /* Tab switch, card lift */
  --spring-smooth: cubic-bezier(0.22, 1, 0.36, 1);      /* Sheet open, drawer */
  --spring-snappy: cubic-bezier(0.18, 0.89, 0.32, 1.28); /* Button press restore */
}

/* Tab bar active indicator */
.tab-indicator {
  transition: transform 0.35s var(--spring-bounce),
              width 0.35s var(--spring-bounce);
}

/* Bottom sheet entry */
.bottom-sheet-enter {
  transform: translateY(100%);
  transition: transform 0.4s var(--spring-smooth);
}
.bottom-sheet-enter-active {
  transform: translateY(0);
}

/* Button micro-animation */
.btn:active {
  transform: scale(0.96);
  transition: transform 0.1s var(--spring-snappy);
}
```

**Framer Motion (if added as dependency):**

```tsx
// Example: Tab bar spring
const tabSpring = {
  type: 'spring',
  stiffness: 400,
  damping: 30,
  mass: 0.8,
};

<motion.div
  layoutId="tab-indicator"
  transition={tabSpring}
  className="tab-indicator"
/>
```

---

## 6. Capacitor Wrapper (Future)

If/When BookLets is wrapped natively via Capacitor:

```
npx @capacitor/cli create
npm install @capacitor/ios @capacitor/android
npm install @capacitor/haptics @capacitor/biometric-auth @capacitor/camera @capacitor/push-notifications @capacitor/splash-screen

npx cap add ios
npx cap add android
```

Configure `capacitor.config.ts`:

```typescript
import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.booklets.app',
  appName: 'BookLets',
  webDir: 'out',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1000,
      backgroundColor: '#0b0f19',
      androidScaleType: 'CENTER_CROP',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
```

---

## 7. Implementation Priority

| # | Feature | Effort | Depends On | Target Phase |
|---|---|---|---|---|
| 1 | Bottom tab bar component + route wiring | 0.5d | AppShell refactor | Phase 1 |
| 2 | `public/manifest.json` + viewport meta | 0.25d | Layout update | Phase 1 |
| 3 | Service worker (offline + push) | 1d | VAPID key setup | Phase 2 |
| 4 | Haptic feedback hook (`useHaptics`) | 0.25d | None | Phase 1 |
| 5 | Camera → ReceiptUploader integration | 1d | Phase 1 camera lib | Phase 2 |
| 6 | Biometric auth gate on approvals/export | 1.5d | WebAuthn server endpoint | Phase 2 |
| 7 | Share sheet on reports | 0.5d | Report page refactor | Phase 2 |
| 8 | Capacitor wrapper project | 2d | All web features stable | Phase 3 |
| 9 | Push notification server endpoint | 1d | Service worker | Phase 2 |
| 10 | Spring animation pass on all transitions | 0.5d | None | Phase 1 |
