import * as Sentry from '@sentry/nextjs';

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    console.warn('[Sentry] SENTRY_DSN not configured; error tracking disabled');
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    enabled: process.env.NODE_ENV === 'production' || process.env.SENTRY_ENABLED === 'true',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.functionIntegration(),
    ],
    beforeSend(event) {
      // Filter out non-critical errors in development
      if (process.env.NODE_ENV === 'development' && event.level === 'info') {
        return null;
      }
      return event;
    },
  });
}

export { Sentry };
