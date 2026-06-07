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
// Module-level token cache — survives Next.js hot-reload and serverless
// re-use within the same process lifetime (unlike static class fields which
// reset on every cold start when the class is re-evaluated).
const _tokenCache: { token: string | null; expiry: number } = {
  token: null,
  expiry: 0,
};

export class HostawayService {
  private static API_BASE = 'https://api.hostaway.com/v1';

  // Single-flight guard: concurrent callers share one in-flight refresh
  // instead of each hitting /access-tokens independently. (The token itself
  // lives in the module-level _tokenCache above so it survives class re-eval.)
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
      console.warn('[HostawayService] No API credentials found. Using mock reservations (Dev Mode).');
      return this.getMockReservations();
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
      return this.getMockReservations();
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

    // Check module-level cache (survives process lifetime, not class re-evaluation)
    if (_tokenCache.token && Date.now() < _tokenCache.expiry) {
      return _tokenCache.token;
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
          scope: 'general',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token Exchange Failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      _tokenCache.token = data.access_token;
      // Hostaway tokens typically last 24h; subtract 60s to avoid edge-case expiry
      _tokenCache.expiry = Date.now() + (data.expires_in * 1000) - 60_000;

      return _tokenCache.token;
    } catch (err) {
      console.error('[HostawayService] OAuth2 Token Error:', err);
      return null;
    }
  }

  /**
   * Mocks the Hostaway response for development and verification.
   */
  private static getMockReservations(): HostawayReservation[] {
    const today = new Date();
    const lastWeek = new Date(today);
    lastWeek.setDate(today.getDate() - 7);
    
    const nextWeek = new Date(today);
    nextWeek.setDate(today.getDate() + 7);

    return [
      {
        id: 1001,
        listingId: 501,
        checkInDate: lastWeek.toISOString().split('T')[0],
        checkOutDate: today.toISOString().split('T')[0], // Checked out TODAY
        totalPrice: 1200.00,
        status: 'confirmed',
        guestName: 'John Doe',
        channelName: 'Airbnb',
        currency: 'EUR'
      },
      {
        id: 1002,
        listingId: 501,
        checkInDate: today.toISOString().split('T')[0],
        checkOutDate: nextWeek.toISOString().split('T')[0], // Active Booking
        totalPrice: 850.00,
        status: 'confirmed',
        guestName: 'Jane Smith',
        channelName: 'Booking.com',
        currency: 'EUR'
      }
    ];
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
