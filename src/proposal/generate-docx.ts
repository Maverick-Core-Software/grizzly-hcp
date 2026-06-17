import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(__dirname, '../../assets/grizzly-proposal-template.docx');
const OUTPUT_DIR = path.resolve(__dirname, '../../proposals');

export interface ProposalContext {
  // Project Info
  customer_name: string;
  customer_address: string;
  customer_city_state_zip: string;
  customer_phone: string;
  customer_email: string;
  contact_name: string;
  project_location: string;
  date: string;
  proposal_number?: string;

  // Scope
  project_description: string;
  scope_of_work: string;
  included_materials: string;
  notes_clarifications: string;

  // Good / Better / Best
  good_price: string;
  good_summary: string;
  better_price: string;
  better_summary: string;
  best_price: string;
  best_summary: string;
  options_why_differ: string;

  // Pricing Summary (Better = recommended)
  projected_total: string;
  deposit_percent: string;
  deposit_amount: string;
  balance_due: string;

  // Company defaults
  company_phone_office: string;
  company_phone_cell: string;
  company_email: string;
}

export async function generateDocx(ctx: ProposalContext): Promise<string> {
  // Verify template exists
  try {
    await fs.access(TEMPLATE_PATH);
  } catch {
    throw new Error(
      `Proposal template not found at assets/grizzly-proposal-template.docx\n` +
      `Copy your template DOCX into the assets/ folder to enable generation.`
    );
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const templateBuf = await fs.readFile(TEMPLATE_PATH);
  const zip = new PizZip(templateBuf);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

  doc.render(ctx);

  const outputBuf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });

  // Filename: CustomerName-Location-Proposal.docx
  const safeName = (s: string) => s.replace(/[^a-z0-9 ]/gi, '').trim().replace(/\s+/g, '-');
  const filename = `${safeName(ctx.customer_name)}-${safeName(ctx.project_location)}-Proposal.docx`;
  const outputPath = path.join(OUTPUT_DIR, filename);

  await fs.writeFile(outputPath, outputBuf);
  return outputPath;
}

export function buildProposalContext(
  rawData: Record<string, string>,
  defaults: Record<string, string> = {}
): ProposalContext {
  const d = { ...defaults, ...rawData };
  return {
    customer_name: d.customer_name ?? '',
    customer_address: d.customer_address ?? '',
    customer_city_state_zip: d.customer_city_state_zip ?? '',
    customer_phone: d.customer_phone ?? '',
    customer_email: d.customer_email ?? '',
    contact_name: d.contact_name ?? d.customer_name ?? '',
    project_location: d.project_location ?? '',
    date: d.date ?? new Date().toLocaleDateString('en-US'),
    proposal_number: d.proposal_number,

    project_description: d.project_description ?? '',
    scope_of_work: d.scope_of_work ?? '',
    included_materials: d.included_materials ?? '',
    notes_clarifications: d.notes_clarifications ?? '',

    good_price: d.good_price ?? '',
    good_summary: d.good_summary ?? '',
    better_price: d.better_price ?? '',
    better_summary: d.better_summary ?? '',
    best_price: d.best_price ?? '',
    best_summary: d.best_summary ?? '',
    options_why_differ: d.options_why_differ ?? '',

    projected_total: d.projected_total ?? d.better_price ?? '',
    deposit_percent: d.deposit_percent ?? '50%',
    deposit_amount: d.deposit_amount ?? '',
    balance_due: d.balance_due ?? '',

    company_phone_office: d.company_phone_office ?? '(469) 863-9804',
    company_phone_cell: d.company_phone_cell ?? '(469) 863-9031',
    company_email: d.company_email ?? 'contactus@grizzlyelectrical.net',
  };
}
