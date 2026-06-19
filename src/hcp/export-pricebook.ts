/**
 * Pulls the full Grizzly price book from the HCP API and writes data/pricebook.csv.
 * Fetches all services across all categories under the Electrical industry.
 * Run: npm run export-pricebook
 * After export, run: npm run push-pricebook  (to re-index in RAG)
 */
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { hcpGet } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.resolve(__dirname, '../../data/pricebook.csv');

// ─── HCP response types ────────────────────────────────────────────────────────

interface HcpIndustry {
  uuid: string;
  name: string;
  industry_uuid: string;
}

interface HcpCategory {
  uuid: string;
  name: string;
}

interface HcpService {
  uuid: string;
  name: string;
  description: string;
  price: number;          // cents
  cost: number;           // cents
  taxable: boolean;
  unit_of_measure: string;
  task_number: string;
  online_booking_enabled: boolean;
  pricebook_category_uuid: string;
}

interface HcpMaterialCategory {
  uuid: string;
  name: string;
}

interface HcpMaterial {
  uuid: string;
  name: string;
  description: string;
  price: number;          // cents
  cost: number;           // cents
  taxable: boolean;
  unit_of_measure: string;
  part_number: string;
  material_category_uuid: string;
  material_category_name: string;
}

interface PagedList<T> {
  data: T[];
  page: number;
  page_size: number;
  total_pages_count: number;
  total_count: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function centsToStr(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function escape(s: string): string {
  return `"${String(s).replace(/"/g, '""')}"`;
}

function toCsvRow(service: HcpService, categoryName: string, industryUuid: string): string {
  return [
    'Electrical',
    industryUuid,
    categoryName,
    service.uuid,
    service.name,
    service.description,
    centsToStr(service.price),
    centsToStr(service.cost),
    String(service.taxable),
    service.unit_of_measure || 'Each',
    service.task_number || '',
    String(service.online_booking_enabled),
  ].map(escape).join(',');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function fetchAllServices(categoryUuid: string): Promise<HcpService[]> {
  const services: HcpService[] = [];
  let page = 1;
  while (true) {
    const res = await hcpGet<PagedList<HcpService>>(
      `/alpha/pricebook/services?pricebook_category_uuid=${categoryUuid}&page=${page}&page_size=100&sort_column=name&sort_direction=asc`
    );
    services.push(...res.data);
    if (page >= res.total_pages_count) break;
    page++;
  }
  return services;
}

async function fetchAllMaterials(materialCategoryUuid: string): Promise<HcpMaterial[]> {
  const materials: HcpMaterial[] = [];
  let page = 1;
  while (true) {
    const res = await hcpGet<PagedList<HcpMaterial>>(
      `/alpha/pricebook/materials?material_category_uuid=${materialCategoryUuid}&page=${page}&page_size=100&sort_column=name&sort_direction=asc`
    );
    materials.push(...res.data);
    if (page >= res.total_pages_count) break;
    page++;
  }
  return materials;
}

async function run() {
  console.log('Fetching Grizzly price book from HCP...\n');

  // 1. Get the Electrical industry
  const industries = await hcpGet<{ data?: HcpIndustry[] }>('/alpha/pricebook/industries');
  const electrical = (industries.data ?? []).find(i => i.name.toLowerCase().includes('electrical'));
  if (!electrical) throw new Error('Electrical industry not found in HCP');
  console.log(`Industry: ${electrical.name} (${electrical.uuid})`);

  // 2. Get all categories
  const cats = await hcpGet<PagedList<HcpCategory>>(
    `/alpha/pricebook/categories?pricebook_industry_uuid=${electrical.uuid}&page=1&page_size=100&sort_column=order_index&sort_direction=asc`
  );
  const categories = cats.data ?? [];
  console.log(`Categories: ${categories.map(c => c.name).join(', ')}\n`);

  // 3. Fetch all services across all categories
  const rows: string[] = [];
  let totalServices = 0;

  console.log('\nServices:');
  for (const cat of categories) {
    const services = await fetchAllServices(cat.uuid);
    console.log(`  ${cat.name}: ${services.length}`);
    for (const svc of services) {
      rows.push(toCsvRow(svc, cat.name, electrical.industry_uuid));
    }
    totalServices += services.length;
  }

  // 4. Fetch all materials across all material categories
  const mcats = await hcpGet<PagedList<HcpMaterialCategory>>(
    '/alpha/pricebook/material_categories?page=1&page_size=100'
  );
  let totalMaterials = 0;

  console.log('\nMaterials:');
  for (const mcat of mcats.data) {
    const materials = await fetchAllMaterials(mcat.uuid);
    console.log(`  ${mcat.name}: ${materials.length}`);
    for (const mat of materials) {
      rows.push([
        'Electrical',
        electrical.industry_uuid,
        mat.material_category_name || mcat.name,
        mat.uuid,
        mat.name,
        mat.description,
        centsToStr(mat.price),
        centsToStr(mat.cost),
        String(mat.taxable),
        mat.unit_of_measure || 'Each',
        mat.part_number || '',
        'false',
      ].map(escape).join(','));
    }
    totalMaterials += materials.length;
  }

  // 5. Write CSV
  const HEADER = [
    'Industry', 'Industry UUID', 'Category', 'UUID',
    'Name', 'Description', 'Price', 'Cost',
    'Taxable', 'Unit of Measure', 'Task Number', 'Online Booking',
  ].map(escape).join(',');

  const csv = HEADER + '\n' + rows.join('\n');
  await fs.writeFile(CSV_PATH, csv, 'utf-8');

  console.log(`\nExported ${totalServices} services + ${totalMaterials} materials = ${rows.length} total → ${CSV_PATH}`);
  console.log('Run "npm run push-pricebook" to re-index in RAG.');
}

run().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
