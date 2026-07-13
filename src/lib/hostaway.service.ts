import { prisma } from './prisma';
import { fetchWithTimeout, fetchWithRetry } from './http';

export interface HostawayReservation {
  id: number;
  listingId: number;
  checkInDate: string;
  checkOutDate: string;
  totalPrice: number;
  status: string;
  guestName: string;
  channelName: string;
  currency: string;
}

/**
 * Hostaway Integration Service
 * 
 * Responsible for communicating with the Hostaway PMS API
 * and providing normalized data for BookLets ingestion.
 */
export class HostawayService {
  private static API_BASE = 'https://api.hostaway.com/v1';

  private static CACHED_TOKEN: string | null = null;
  private static TOKEN_EXPIRY: number = 0;
  // Single-flight guard: concurrent callers share one in-flight refresh
  // instead of each hitting /access-tokens independently.
  private static REFRESH_INFLIGHT: Promise<string | null> | null = null;

  /**
   * Fetches reservations from Hostaway API.
   * COMPLIANCE: Now using real OAuth2 token-based authentication.
   */
  static async fetchReservations(limit: number = 50): Promise<HostawayReservation[]> {
    const isProd = process.env.NODE_ENV === 'production';
    const isStrict = process.env.STRICT_HOSTAWAY === 'true';
    const accountId = process.env.HOSTAWAY_ACCOUNT_ID;

    // Check accountId before requesting a token: a misconfigured deploy
    // shouldn't burn an OAuth round-trip just to fail the next check.
    if (!accountId && (isProd || isStrict)) {
      throw new Error('[HostawayService] CRITICAL: HOSTAWAY_ACCOUNT_ID is missing in production/strict mode.');
    }

    const accessToken = await this.getAccessToken();

    if (!accessToken) {
      if (isProd || isStrict) {
        throw new Error('[HostawayService] CRITICAL: Failed to retrieve Hostaway OAuth token. Check HOSTAWAY_CLIENT_ID and HOSTAWAY_CLIENT_SECRET.');
      }
      // No mock fallback: without credentials there are simply no reservations
      // to sync. Never fabricate data that could reach the ledger.
      console.warn('[HostawayService] No API credentials found — returning no reservations (Dev Mode).');
      return [];
    }

    try {
      console.log(`[HostawayService] Fetching ${limit} reservations from live API...`);

      const res = await fetchWithRetry(`${this.API_BASE}/reservations?limit=${limit}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Cache-Control': 'no-cache',
          'X-Hostaway-Account-Id': accountId || ""
        }
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(`Hostaway API Error: ${res.status} ${res.statusText} - ${JSON.stringify(errorData)}`);
      }

      const data = await res.json();
      return data.result || [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[HostawayService] API Call Failed:', message);
      if (isProd || isStrict) throw err; // Bubble up in production or strict mode
      // Dev: surface the failure as an empty result, never as fabricated data.
      return [];
    }
  }

  /**
   * OAuth2 Token Management: Retrieves or Refreshes the Access Token.
   */
  private static async getAccessToken(): Promise<string | null> {
    const clientId = process.env.HOSTAWAY_CLIENT_ID;
    const clientSecret = process.env.HOSTAWAY_CLIENT_SECRET || process.env.HOSTAWAY_API_KEY;

    if (!clientId || !clientSecret) {
      return null;
    }

    // Check Cache
    if (this.CACHED_TOKEN && Date.now() < this.TOKEN_EXPIRY) {
      return this.CACHED_TOKEN;
    }

    // Single-flight: if a refresh is already running, await the same promise.
    if (this.REFRESH_INFLIGHT) {
      return this.REFRESH_INFLIGHT;
    }

    this.REFRESH_INFLIGHT = this.refreshAccessToken(clientId, clientSecret);
    try {
      return await this.REFRESH_INFLIGHT;
    } finally {
      this.REFRESH_INFLIGHT = null;
    }
  }

  private static async refreshAccessToken(clientId: string, clientSecret: string): Promise<string | null> {
    try {
      console.log(`[HostawayService] Authenticating with Hostaway (Client ID: ${clientId})...`);
      const response = await fetchWithTimeout('https://api.hostaway.com/v1/access-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'general'
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token Exchange Failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      this.CACHED_TOKEN = data.access_token;
      // Hostaway tokens usually last 24h, but we handle the expiry provided by them
      this.TOKEN_EXPIRY = Date.now() + (data.expires_in * 1000) - 60000;

      return this.CACHED_TOKEN;
    } catch (err) {
      console.error('[HostawayService] OAuth2 Token Error:', err);
      return null;
    }
  }

  /**
   * Finds a property in BookLets associated with a Hostaway Listing ID.
   */
  static async findPropertyByHostawayId(hostawayListingId: number) {
    return prisma.property.findUnique({
      where: { hostawayId: hostawayListingId.toString() }
    });
  }
}
