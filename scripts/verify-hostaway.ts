import { HostawayService } from '../src/lib/hostaway.service';
import * as dotenv from 'dotenv';
import path from 'path';

// Load .env from root
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function verify() {
  console.log('--- Hostaway Connectivity Verification ---');
  console.log('Environment:', process.env.NODE_ENV || 'development');
  console.log('Client ID:', process.env.HOSTAWAY_CLIENT_ID || 'MISSING');
  console.log('Account ID:', process.env.HOSTAWAY_ACCOUNT_ID || 'MISSING');

  try {
    const reservations = await HostawayService.fetchReservations(5);
    console.log('Success! Received reservations:', reservations.length);
    if (reservations.length > 0) {
      console.log('First Reservation Sample:', {
        id: reservations[0].id,
        guest: reservations[0].guestName,
        total: reservations[0].totalPrice,
        currency: reservations[0].currency
      });
    }
  } catch (err: any) {
    console.error('Verification Failed!');
    console.error(err.message);
    process.exit(1);
  }
}

verify();
