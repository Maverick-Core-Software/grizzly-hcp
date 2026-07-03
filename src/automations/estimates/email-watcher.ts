/**
 * Maverick Email Watcher — polls Gmail inboxes for new estimate requests,
 * classifies them with Haiku, extracts attachments (PDF/DOCX/image/CAD), asks
 * the RAG for a scope of work, then drives the HCP estimate pipeline.
 *
 * Run:  npm run watch-email   (long-running; managed by PM2 as `mav-email-watcher`)
 *
 * This used to live in a standalone, un-versioned C:\Workspace\Active\email-watcher.
 * It now lives in-repo next to from-email.ts (the pipeline it feeds) so the trigger
 * and the pipeline share one source of truth and one .env.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import twilio from 'twilio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/automations/estimates → repo root. Spawns and state files are anchored here
// so the watcher works regardless of the cwd PM2 launches it from.
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DATA_DIR = path.join(REPO_ROOT, 'data');

const GMAIL_URL = process.env.GMAIL_MULTI_URL || 'http://localhost:8000';
const ACCOUNTS = (process.env.GMAIL_ACCOUNTS || 'grizzly1,grizzly2').split(',').map(s => s.trim());
const GMAIL_KEY = process.env.GMAIL_MULTI_API_KEY || '';
const MCC_URL = process.env.MCC_URL || 'http://localhost:3000';
const RAG_URL = process.env.RAG_URL || 'http://192.168.1.12:8181';
const ANTH_KEY = process.env.ANTHROPIC_API_KEY || '';
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '300000', 10);
const SEEN_FILE = path.join(DATA_DIR, 'seen-emails.json');
const FAIL_FILE = path.join(DATA_DIR, 'failed-emails.json');

const MODEL_HAIKU = 'claude-haiku-4-5-20251001';

// ── External API shapes (gmail-multi / Anthropic) — loose by nature ────────────
// ponytail: these come from external services; we type only the fields we touch.
interface Attachment { id: string; filename?: string; name?: string; mime_type?: string; }
interface Email {
  id: string;
  from: string;
  subject: string;
  date?: string;
  snippet?: string;
  body_text?: string;
  body_html?: string;
  attachments?: Attachment[];
}
type Seen = Record<string, string[]>;

// ── Seen-email persistence ────────────────────────────────────────────────────

async function loadSeen(): Promise<Seen> {
  try { return JSON.parse(await fs.readFile(SEEN_FILE, 'utf-8')); }
  catch { return {}; }
}

async function saveSeen(seen: Seen): Promise<void> {
  await fs.writeFile(SEEN_FILE, JSON.stringify(seen, null, 2));
}

async function logFailed(account: string, email: Email, reason: string): Promise<void> {
  let fails: unknown[] = [];
  try { fails = JSON.parse(await fs.readFile(FAIL_FILE, 'utf-8')); } catch { /* first failure */ }
  fails.push({ ts: new Date().toISOString(), account, id: email.id, from: email.from, subject: email.subject, reason });
  await fs.writeFile(FAIL_FILE, JSON.stringify(fails, null, 2));
}

// ── Gmail-multi helpers ───────────────────────────────────────────────────────

function gmailHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (GMAIL_KEY) h['Authorization'] = `Bearer ${GMAIL_KEY}`;
  return h;
}

async function gmailGet(p: string): Promise<any> {
  const res = await fetch(`${GMAIL_URL}${p}`, { headers: gmailHeaders() });
  if (!res.ok) throw new Error(`gmail-multi ${p} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function searchNewEmails(account: string, seenIds: string[]): Promise<Array<{ id: string }>> {
  const data = await gmailGet(`/search/${account}?q=is:unread&max_results=50`);
  return (data.emails || []).filter((e: { id: string }) => !seenIds.includes(e.id));
}

async function getEmail(account: string, emailId: string): Promise<Email> {
  const data = await gmailGet(`/email/${account}/${emailId}`);
  return data.email;
}

async function getAttachment(account: string, emailId: string, attachmentId: string): Promise<{ data_base64: string; size: number }> {
  return gmailGet(`/attachment/${account}/${emailId}/${attachmentId}`);
}

// ── Sender deny-list ───────────────────────────────────────────────────────────
// Mail from these senders is NEVER a customer estimate request — it's Housecall
// Pro's own automated notifications (new-job/lead alerts, signed/approved estimate
// copies, payment receipts, TradeWire marketing). Processing them would create
// duplicate estimates for jobs HCP already has. Deterministic — runs before Haiku.
const IGNORE_SENDER = /@(?:[a-z0-9-]+\.)*housecallpro\.com\b/i;

export function isIgnoredSender(from: string): boolean {
  return IGNORE_SENDER.test(from || '');
}

// ── Haiku classification ──────────────────────────────────────────────────────

async function classifyEmail(email: Email): Promise<string> {
  const preview = [
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    '',
    (email.body_text || email.snippet || '').slice(0, 1500),
  ].join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTH_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL_HAIKU,
      max_tokens: 50,
      system: `You classify inbound emails to Grizzly Electrical, a licensed electrician company.
Reply with EXACTLY ONE word:
- estimate_request  (a customer is describing electrical work they want quoted or done)
- ignore  (spam, marketing, newsletters, automated alerts, receipts, or clearly unrelated)

IMPORTANT: Housecall Pro and other CRM/system notifications are ALWAYS "ignore",
even when they mention a job, estimate, or payment. Examples that are "ignore":
"New job from your website", "Congrats on your new job", "Copy of signed estimate #...",
"Response on estimate #... approved", payment/receipt notifications, any "[Customer] - $amount".
Only classify as estimate_request when an actual person is asking for electrical work.

One word only. No punctuation.`,
      messages: [{ role: 'user', content: preview }],
    }),
  });

  if (!res.ok) throw new Error(`Haiku classify → ${res.status}`);
  const data: any = await res.json();
  return (data.content?.[0]?.text || '').trim().toLowerCase().replace(/\W/g, '');
}

// ── Attachment extraction ─────────────────────────────────────────────────────

const EXTRACTABLE = /\.(pdf|docx|doc|txt|md)$/i;
const IMAGE_MIME = /^image\/(jpeg|jpg|png|gif|webp)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;
const CAD_EXT = /\.(dwg|dxf|rvt|skp|ifc|3dm|step|stp)$/i;

// PDF / DOCX / text via MCC extract-file
async function extractFileBase64(filename: string, base64Data: string): Promise<string> {
  const res = await fetch(`${MCC_URL}/api/extract-file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: filename, data: base64Data }),
  });
  if (!res.ok) throw new Error(`extract-file → ${res.status}`);
  const data: any = await res.json();
  return data.text || '';
}

// Image → Claude vision description
const ANTH_VISION_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
async function describeImage(filename: string, base64Data: string, mimeType: string): Promise<string> {
  const ext = filename.split('.').pop()?.toLowerCase() || 'jpeg';
  const media = mimeType && IMAGE_MIME.test(mimeType) ? mimeType : (ANTH_VISION_MIME[ext] || 'image/jpeg');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTH_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL_HAIKU,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media, data: base64Data } },
          { type: 'text', text: 'This image was attached to an estimate request email sent to Grizzly Electrical. Describe what you see that is relevant to an electrical estimate: panels, outlets, wiring, damage, floor plan layout, measurements, labels, or any other electrical detail. Be specific and concise.' },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`vision → ${res.status}`);
  const data: any = await res.json();
  return data.content?.[0]?.text || '';
}

// Strip HTML tags for form-submission emails that send only HTML
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Blueprint takeoff via Grizzly-HCP pipeline ───────────────────────────────

async function runBlueprintTakeoff(filename: string, base64Data: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  const tmpFile = path.join(os.tmpdir(), `grizzly-takeoff-${Date.now()}${ext}`);
  try {
    await fs.writeFile(tmpFile, Buffer.from(base64Data, 'base64'));

    // ponytail: takeoff CLI emits a rich TakeoffResult; we only read the fields below.
    const result: any = await new Promise((resolve, reject) => {
      const proc = spawn('npx', ['tsx', 'src/takeoff/cli.ts', tmpFile, '--format', 'json'], {
        cwd: REPO_ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout!.on('data', d => { stdout += d; });
      proc.stderr!.on('data', d => { stderr += d; });
      const timer = setTimeout(() => { proc.kill(); reject(new Error('takeoff timed out')); }, 180_000);
      proc.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`takeoff exit ${code}: ${stderr.slice(0, 300)}`));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`takeoff bad JSON: ${stdout.slice(0, 200)}`)); }
      });
    });

    // Format TakeoffResult into a human-readable context block
    const r = result;
    const devices = Object.entries(r.devices || {})
      .map(([k, v]) => `${v}× ${k}`)
      .join(', ') || 'none detected';
    const routing = r.estimated_routing_lengths?.by_type
      ? Object.entries(r.estimated_routing_lengths.by_type)
          .map(([k, v]: [string, any]) => `${k}: ~${v.nominal_ft}ft`)
          .join(', ')
      : 'unknown';
    const labor = r.labor
      ? `${r.labor.rough_in_hours}h rough-in + ${r.labor.trim_out_hours}h trim + ${r.labor.panel_hours}h panel = ${r.labor.total_hours}h total`
      : 'unknown';
    const conf = r.confidence
      ? `devices=${r.confidence.device_counts}, routing=${r.confidence.routing_lengths}`
      : '';
    const warns = (r.warnings || []).filter((w: any) => w.severity !== 'info').map((w: any) => `⚠ ${w.message}`).join('\n');

    return [
      `[Blueprint Takeoff: ${filename}]`,
      `Devices: ${devices}`,
      `Routing: ${routing}`,
      `Labor: ${labor}`,
      conf ? `Confidence: ${conf}` : '',
      warns,
      '⚠ Requires human review',
    ].filter(Boolean).join('\n');

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  takeoff failed (${filename}): ${msg}`);
    // DWG with no ODA converter gives a clear message
    if (msg.includes('ODA') || msg.includes('converter') || msg.includes('dwg')) {
      return `[Blueprint: ${filename} — DWG conversion requires ODA FileConverter (free at opendesign.com)]`;
    }
    return `[Blueprint: ${filename} — takeoff failed: ${msg.slice(0, 200)}]`;
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

// ── Electrical content filter for extracted attachments ──────────────────────
// Runs a Haiku pass over raw extracted PDF/DOCX text to return only the
// electrically-relevant details, preventing blueprint non-electrical content
// (plumbing, hot tubs, HVAC, structural) from contaminating the RAG scope.
async function summarizeAttachmentForElectrical(filename: string, rawText: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTH_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL_HAIKU,
      max_tokens: 300,
      system: [
        'You are an electrical estimating assistant. Extract ONLY the electrically-relevant details from this document.',
        'Include: panel specs, circuit counts, outlet/switch/fixture counts, wire gauge, breaker sizes, EV charger specs, service size, load calculations, electrical room locations.',
        'Ignore: plumbing, HVAC, hot tubs, structural/architectural notes, non-electrical rooms, finishes, landscaping.',
        'If no electrical details are present, respond with exactly: NO_ELECTRICAL_DETAILS',
        'Be concise — two to five sentences or a short list.',
      ].join('\n'),
      messages: [{ role: 'user', content: `File: ${filename}\n\n${rawText.slice(0, 6000)}` }],
    }),
  });
  if (!res.ok) throw new Error(`Haiku attachment summary → ${res.status}`);
  const data: any = await res.json();
  const summary = (data.content?.[0]?.text || '').trim();
  return summary === 'NO_ELECTRICAL_DETAILS' ? '' : summary;
}

// ── RAG scope generation ──────────────────────────────────────────────────────

async function generateScope(emailContext: string): Promise<string> {
  const res = await fetch(`${RAG_URL}/estimate-stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: emailContext, history: [], top_k: 20 }),
  });

  if (!res.ok) throw new Error(`RAG /estimate-stream → ${res.status}`);

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let scope = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') break;
      try { const tok = JSON.parse(raw); if (tok.delta) scope += tok.delta; } catch { /* keep-alive line */ }
    }
  }

  return scope;
}

// ── HCP estimate creation via from-email.ts ──────────────────────────────────

interface FromEmailPayload {
  from: string;
  subject: string;
  body: string;
  scope: string;
  attachmentContext?: string;
}

function spawnFromEmail(payload: FromEmailPayload): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', 'src/automations/estimates/from-email.ts'], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    proc.stdin!.write(JSON.stringify(payload));
    proc.stdin!.end();

    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', d => { stdout += d; });
    proc.stderr!.on('data', d => { stderr += d; process.stderr.write(d); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('from-email.ts timed out after 2 minutes'));
    }, 120_000);

    proc.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`from-email.ts bad output (exit): ${stderr.slice(0, 500)}\nstdout: ${stdout.slice(0, 200)}`)); }
    });
  });
}

// ── Approval monitoring helpers ───────────────────────────────────────────────

const HCP_ESTIMATE_UUID_RE = /housecallpro\.com\/app\/estimates\/([a-f0-9-]{36})/i;

function extractApprovalUuid(email: Email): string | null {
  const subjectLower = (email.subject ?? '').toLowerCase();
  const isApproval =
    (subjectLower.includes('approved') || subjectLower.includes('signed')) &&
    subjectLower.includes('estimate');
  if (!isApproval) return null;
  const body = email.body_text || email.body_html || email.snippet || '';
  const match = body.match(HCP_ESTIMATE_UUID_RE);
  return match?.[1] ?? null;
}

function lookupCustomerPhone(estimateUuid: string): string | null {
  try {
    const file = path.join(REPO_ROOT, 'data/customer-sessions.jsonl');
    const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of [...lines].reverse()) {
      try {
        const entry = JSON.parse(line);
        if (entry.estimateUuid === estimateUuid) return entry.phone;
      } catch { /* skip malformed */ }
    }
  } catch { /* file doesn't exist yet */ }
  return null;
}

async function handleEstimateApproval(estimateUuid: string): Promise<void> {
  const phone = lookupCustomerPhone(estimateUuid);
  if (!phone) {
    console.log(`[approval] Estimate ${estimateUuid} not from customer chat — skipping SMS`);
    return;
  }
  if (!process.env.TWILIO_PHONE_NUMBER) {
    console.error('[approval] TWILIO_PHONE_NUMBER not set — skipping SMS');
    return;
  }
  console.log(`[approval] Sending follow-up SMS to ${phone} for estimate ${estimateUuid}`);
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER!,
    to: phone,
    body: "Great news — your estimate is approved! 🎉 One quick question to help us finalize pricing before we head out: do you know how old your electrical panel is, or when it was last updated?",
  });
}

// ── Process a single email ────────────────────────────────────────────────────

async function processEmail(account: string, email: Email): Promise<void> {
  const label = `[${account}] "${email.subject}" from ${email.from}`;
  console.log(`\n${label}`);

  // Hard deny-list: HCP / CRM notifications never become estimate requests.
  // Exception: approval notifications trigger a follow-up SMS to the customer.
  if (isIgnoredSender(email.from)) {
    const approvalUuid = extractApprovalUuid(email);
    if (approvalUuid) {
      await handleEstimateApproval(approvalUuid).catch(
        e => console.error(`[approval] SMS failed: ${e instanceof Error ? e.message : e}`)
      );
    }
    console.log('  → skip (Housecall Pro / automated notification)');
    return;
  }

  // Classify
  let classification: string;
  try {
    classification = await classifyEmail(email);
  } catch (e) {
    console.error(`  classify failed: ${e instanceof Error ? e.message : e}`);
    return;
  }

  console.log(`  classification: ${classification}`);
  if (classification !== 'estimaterequest' && classification !== 'estimate_request') {
    console.log('  → skip');
    return;
  }

  // Resolve best body text — prefer plain text, fall back to stripped HTML
  const bodyText = (email.body_text?.trim())
    || (email.body_html ? stripHtml(email.body_html) : '')
    || (email.snippet || '');

  // Extract all attachments by type
  const attachments = email.attachments || [];
  const attachmentNotes: string[] = [];

  for (const att of attachments) {
    const name = att.filename || att.name || 'attachment';
    const mime = att.mime_type || '';
    try {
      if (EXTRACTABLE.test(name)) {
        console.log(`  extracting ${name}`);
        const attData = await getAttachment(account, email.id, att.id);
        const text = await extractFileBase64(name, attData.data_base64);
        if (text) {
          const summary = await summarizeAttachmentForElectrical(name, text);
          if (summary) attachmentNotes.push(`[Attachment: ${name} — electrical details]\n${summary}`);
          else console.log(`  ${name}: no electrical details found — attachment excluded from scope`);
        }

      } else if (IMAGE_EXT.test(name) || IMAGE_MIME.test(mime)) {
        console.log(`  describing image: ${name}`);
        const attData = await getAttachment(account, email.id, att.id);
        const desc = await describeImage(name, attData.data_base64, mime);
        if (desc) attachmentNotes.push(`[Image: ${name}]\n${desc}`);

      } else if (CAD_EXT.test(name)) {
        console.log(`  running blueprint takeoff: ${name}`);
        const attData = await getAttachment(account, email.id, att.id);
        const takeoffNote = await runBlueprintTakeoff(name, attData.data_base64);
        attachmentNotes.push(takeoffNote);

      } else {
        attachmentNotes.push(`[Attachment: ${name} (${mime || 'unknown type'})]`);
      }
    } catch (e) {
      console.error(`  attachment failed (${name}): ${e instanceof Error ? e.message : e}`);
      attachmentNotes.push(`[${name} — extraction failed: ${e instanceof Error ? e.message : e}]`);
    }
  }

  // Build RAG context
  const emailContext = [
    'New estimate request received by email at Grizzly Electrical.',
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Date: ${email.date}`,
    '',
    'Customer message:',
    bodyText.slice(0, 3000),
    attachmentNotes.length
      ? `\nAttachment context (electrical details only — non-electrical content pre-filtered):\n${attachmentNotes.join('\n\n').slice(0, 8000)}`
      : '',
    '',
    'Generate a preliminary scope of work for this ELECTRICAL estimate. List ONLY electrical work items, materials, and NEC code considerations. Do NOT include plumbing, HVAC, hot tubs, structural, or any non-electrical work even if mentioned in attachments. Do NOT ask follow-up questions — produce the best scope possible from the information provided.',
    '',
    'GRIZZLY ELECTRICAL DEFAULT ASSUMPTIONS (apply unless the customer message says otherwise):',
    '- EV chargers: assume 48A (50A breaker, 6 AWG wire) unless a specific amperage is stated.',
    '- "Next to the panel" or "right next to panel": assume same stud cavity — no significant wire run, breaker to outlet/charger location is inches, not feet.',
    '- "Open space in panel" or "space in panel": treat as confirmed 2-pole breaker slot available — do NOT ask if there is room.',
    '- Wall/ceiling finish: assume finished drywall unless the customer specifies otherwise (unfinished, concrete, etc.).',
    '- Materials: Grizzly supplies wire and wiring devices (breakers, outlets, switches, covers). Fixtures (light fixtures, fans, EV chargers) are customer-supplied. Do not list fixtures as Grizzly-supplied material.',
    '- Upsells (surge protection, GFCI upgrades, smart switches, etc.): do not ask about or include as follow-up items. Only include if the customer explicitly requested it.',
    '- Permits: do NOT assume a permit is needed unless (a) the customer mentioned one, (b) it is a panel upgrade, (c) it is a service change, or (d) it is a remodel. Standard add-a-circuit or device swap jobs do not require a permit assumption.',
  ].join('\n');

  // Generate scope
  let scope: string;
  try {
    console.log('  generating scope via RAG...');
    scope = await generateScope(emailContext);
    console.log(`  scope: ${scope.length} chars`);
  } catch (e) {
    console.error(`  RAG scope failed: ${e instanceof Error ? e.message : e}`);
    scope = `[Scope generation unavailable — RAG offline]\n\n${(email.body_text || '').slice(0, 500)}`;
  }

  // Create HCP estimate
  try {
    console.log('  creating HCP estimate...');
    const result = await spawnFromEmail({
      from: email.from,
      subject: email.subject,
      body: bodyText.slice(0, 2000),
      scope,
      attachmentContext: attachmentNotes.join('\n\n').slice(0, 3000),
    });

    if (result.success) {
      console.log(`  ✅ ${result.estimateUrl}`);
      if (Array.isArray(result.unmatched) && result.unmatched.length) {
        console.warn(`  ⚠️  ${result.unmatched.length} item(s) need manual pricing in HCP (added at $0): ${result.unmatched.join(', ')}`);
      }
    } else {
      console.error(`  ❌ HCP failed: ${result.error}`);
      await logFailed(account, email, result.error);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ❌ spawn failed: ${msg}`);
    await logFailed(account, email, msg);
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  console.log(`\n[poll] ${new Date().toISOString()}`);
  const seen = await loadSeen();

  for (const account of ACCOUNTS) {
    const seenIds = seen[account] || [];
    try {
      const newEmails = await searchNewEmails(account, seenIds);
      if (!newEmails.length) { console.log(`[${account}] no new emails`); continue; }
      console.log(`[${account}] ${newEmails.length} new email(s)`);

      for (const summary of newEmails) {
        // Mark seen immediately so a crash doesn't reprocess
        seenIds.push(summary.id);
        seen[account] = seenIds;
        await saveSeen(seen);

        try {
          const email = await getEmail(account, summary.id);
          await processEmail(account, email);
        } catch (e) {
          console.error(`[${account}] failed to process ${summary.id}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } catch (e) {
      console.error(`[${account}] search failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Maverick Email Watcher ===');
  console.log(`Accounts:  ${ACCOUNTS.join(', ')}`);
  console.log(`Poll:      every ${POLL_MS / 1000}s`);
  console.log(`Gmail API: ${GMAIL_URL}`);
  console.log(`RAG:       ${RAG_URL}`);
  console.log(`Repo root: ${REPO_ROOT}`);

  if (!ANTH_KEY) console.warn('[warn] ANTHROPIC_API_KEY not set — classification will fail');

  await fs.mkdir(DATA_DIR, { recursive: true });
  await poll();
  setInterval(poll, POLL_MS);
}

// Only boot the poll loop when run directly (npm run watch-email), not when
// imported by the self-check or other tooling.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
