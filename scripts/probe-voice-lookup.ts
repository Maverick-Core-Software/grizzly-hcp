/**
 * Manual probe for the caller-scoped voice lookup against LIVE HCP (read-only).
 * Usage:
 *   npx tsx scripts/probe-voice-lookup.ts "<phone>" "<name>" ["<address>"]
 * Requires a valid HCP session (npm run login).
 */
import 'dotenv/config';
import { lookupMyAppointments } from '../src/agent/tools/reads/voice-lookup.js';

const [phone, name, address] = process.argv.slice(2);
if (!name) {
  console.error('Usage: npx tsx scripts/probe-voice-lookup.ts "<phone>" "<name>" ["<address>"]');
  process.exit(1);
}
const result = await lookupMyAppointments({ callerPhone: phone, name, address });
console.log(JSON.stringify(result, null, 2));
