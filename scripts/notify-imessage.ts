// Send-only Photon helper. Reuses grizzly-hcp's Spectrum creds to deliver a
// one-shot iMessage. Usage: tsx scripts/notify-imessage.ts "<message>"
// Exits 0 on send, non-zero on failure. No-ops (exit 0, logged) if CARTER_PHONE unset.
import 'dotenv/config';
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';

async function main() {
  const text = process.argv.slice(2).join(' ').trim();
  if (!text) { console.error('[notify-imessage] no message text'); process.exit(2); }

  const to = process.env.CARTER_PHONE;
  if (!to) { console.warn('[notify-imessage] CARTER_PHONE unset — skipping send'); process.exit(0); }
  if (!process.env.PROJECT_ID || !process.env.PROJECT_SECRET) {
    console.error('[notify-imessage] PROJECT_ID/PROJECT_SECRET unset'); process.exit(3);
  }

  const app = await Spectrum({
    projectId: process.env.PROJECT_ID,
    projectSecret: process.env.PROJECT_SECRET,
    providers: [imessage.config()],
  });
  const space = await imessage(app).space.create(to);
  await space.send(text);
  console.log('[notify-imessage] sent');
  process.exit(0);
}

main().catch((e) => { console.error('[notify-imessage] failed:', e?.message || e); process.exit(1); });
