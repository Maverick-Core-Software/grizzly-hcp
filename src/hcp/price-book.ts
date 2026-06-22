/**
 * HCP price book API — create and manage price book services.
 * Endpoint: POST /alpha/pricebook/services (multipart/form-data, prices in cents)
 */
import { hcpGet, hcpPostForm, hcpDelete } from './client.js';
import { appendToCsv, removeFromCsv } from '../rag/price-book.js';
import { indexPriceBookItem } from '../rag/client.js';

export interface HcpPriceBookItem {
  uuid: string;        // olit_...
  name: string;
  description: string;
  unitPrice: number;   // dollars
  unitCost: number;    // dollars
  taxable: boolean;
  unitOfMeasure: string;
  categoryUuid: string;
}

export interface HcpMaterialItem {
  uuid: string;        // pbmat_...
  name: string;
  description: string;
  unitPrice: number;   // dollars
  unitCost: number;
  taxable: boolean;
  unitOfMeasure: string;
  partNumber: string;
  materialCategoryUuid: string;
}

/** Fetch the first category UUID under the Electrical industry. Used as default for services. */
async function getDefaultCategoryUuid(): Promise<string> {
  const industries = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    '/alpha/pricebook/industries'
  );
  const electrical = (industries.data ?? []).find(i =>
    i.name.toLowerCase().includes('electrical')
  );
  if (!electrical) throw new Error('Electrical industry not found in HCP price book');

  const cats = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    `/alpha/pricebook/categories?pricebook_industry_uuid=${electrical.uuid}&id=${electrical.uuid}&page=1&page_size=100&sort_column=order_index&sort_direction=asc`
  );
  const first = (cats.data ?? [])[0];
  if (!first) throw new Error('No categories found in HCP price book');
  return first.uuid;
}

/** Fetch the "Miscellaneous Material" category UUID, falling back to the first available. */
async function getDefaultMaterialCategoryUuid(): Promise<string> {
  const res = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    '/alpha/pricebook/material_categories?page=1&page_size=100'
  );
  const cats = res.data ?? [];
  const misc = cats.find(c => c.name.toLowerCase().includes('miscellaneous'));
  const first = cats[0];
  if (!misc && !first) throw new Error('No material categories found in HCP price book');
  return (misc ?? first).uuid;
}

/**
 * Create a new material item in the HCP price book.
 * Also syncs the entry to the local pricebook.csv cache and indexes in RAG.
 */
export async function createMaterialItem(item: {
  name: string;
  description?: string;
  unitPrice: number;
  unitCost?: number;
  taxable?: boolean;
  unitOfMeasure?: string;
  partNumber?: string;
  category?: string;
  materialCategoryUuid?: string;
}): Promise<HcpMaterialItem> {
  const materialCategoryUuid = item.materialCategoryUuid ?? await getDefaultMaterialCategoryUuid();
  const priceCents = Math.round(item.unitPrice * 100);
  const costCents  = Math.round((item.unitCost ?? 0) * 100);

  const res = await hcpPostForm<{
    uuid: string;
    name: string;
    description: string;
    price: number;
    cost: number;
    taxable: boolean;
    unit_of_measure: string;
    part_number: string;
    material_category_uuid: string;
  }>('/alpha/pricebook/materials', {
    name:                    item.name,
    description:             item.description ?? '',
    price:                   priceCents,
    cost:                    costCents,
    taxable:                 item.taxable ?? false,
    unit_of_measure:         item.unitOfMeasure ?? 'Each',
    part_number:             item.partNumber ?? '',
    material_category_uuid:  materialCategoryUuid,
    online_booking_enabled:  false,
    flat_rate_enabled:       false,
  });

  const created: HcpMaterialItem = {
    uuid:                 res.uuid,
    name:                 res.name,
    description:          res.description,
    unitPrice:            res.price / 100,
    unitCost:             res.cost / 100,
    taxable:              res.taxable,
    unitOfMeasure:        res.unit_of_measure,
    partNumber:           res.part_number,
    materialCategoryUuid: res.material_category_uuid,
  };

  await appendToCsv({
    category:      item.category ?? 'Miscellaneous Material',
    uuid:          created.uuid,
    name:          created.name,
    description:   created.description,
    price:         created.unitPrice,
    priceStr:      `$${created.unitPrice.toFixed(2)}`,
    unitOfMeasure: created.unitOfMeasure,
  });

  indexPriceBookItem({
    uuid:          created.uuid,
    name:          created.name,
    description:   created.description,
    price:         created.unitPrice,
    category:      item.category ?? 'Miscellaneous Material',
    unitOfMeasure: created.unitOfMeasure,
  }).catch(e => {
    console.warn(`[price-book] RAG index skipped: ${(e as Error).message}`);
  });

  return created;
}

/**
 * List every service in the HCP price book (across all Electrical categories),
 * with prices in dollars. Used by cleanup tooling to find $0 / unpriced items.
 */
export async function listAllServices(): Promise<Array<{ uuid: string; name: string; price: number; category: string }>> {
  const industries = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    '/alpha/pricebook/industries'
  );
  const electrical = (industries.data ?? []).find(i => i.name.toLowerCase().includes('electrical'));
  if (!electrical) throw new Error('Electrical industry not found in HCP price book');

  const cats = await hcpGet<{ data?: Array<{ uuid: string; name: string }> }>(
    `/alpha/pricebook/categories?pricebook_industry_uuid=${electrical.uuid}&id=${electrical.uuid}&page=1&page_size=100&sort_column=order_index&sort_direction=asc`
  );

  const out: Array<{ uuid: string; name: string; price: number; category: string }> = [];
  for (const cat of cats.data ?? []) {
    let page = 1;
    while (true) {
      const res = await hcpGet<{
        data: Array<{ uuid: string; name: string; price: number }>;
        total_pages_count: number;
      }>(`/alpha/pricebook/services?pricebook_category_uuid=${cat.uuid}&page=${page}&page_size=100&sort_column=name&sort_direction=asc`);
      for (const s of res.data) out.push({ uuid: s.uuid, name: s.name, price: s.price / 100, category: cat.name });
      if (page >= res.total_pages_count) break;
      page++;
    }
  }
  return out;
}

/**
 * Delete an item from the HCP price book and remove it from the local CSV cache.
 * Routes by uuid prefix: olit_ → service, pbmat_ → material.
 * NOTE: there is no RAG de-index endpoint, so a deleted item may linger in the
 * RAG vector store until the collection is rebuilt — non-blocking for callers.
 */
export async function deletePriceBookItem(uuid: string): Promise<void> {
  const endpoint = uuid.startsWith('pbmat_')
    ? `/alpha/pricebook/materials/${uuid}`
    : `/alpha/pricebook/services/${uuid}`;
  await hcpDelete(endpoint);
  await removeFromCsv(uuid).catch(() => { /* CSV may not contain it — fine */ });
}

/**
 * Create a new service item in the HCP price book.
 * Also syncs the entry to the local pricebook.csv cache.
 */
export async function createPriceBookItem(item: {
  name: string;
  description?: string;
  unitPrice: number;       // dollars
  unitCost?: number;       // dollars
  taxable?: boolean;
  unitOfMeasure?: string;
  category?: string;       // display name for CSV
  categoryUuid?: string;   // pbcat_... (looked up if omitted)
}): Promise<HcpPriceBookItem> {
  const categoryUuid = item.categoryUuid ?? await getDefaultCategoryUuid();

  const priceCents = Math.round(item.unitPrice * 100);
  const costCents  = Math.round((item.unitCost ?? 0) * 100);

  const res = await hcpPostForm<{
    uuid: string;
    name: string;
    description: string;
    price: number;        // cents
    cost: number;         // cents
    taxable: boolean;
    unit_of_measure: string;
    pricebook_category_uuid: string;
  }>('/alpha/pricebook/services', {
    name:                              item.name,
    description:                       item.description ?? '',
    price:                             priceCents,
    cost:                              costCents,
    taxable:                           item.taxable ?? false,
    unit_of_measure:                   item.unitOfMeasure ?? 'Each',
    pricebook_category_uuid:           categoryUuid,
    online_booking_enabled:            false,
    flat_rate_enabled:                 false,
    track_material_usage:              true,
    materialsCost:                     0,
    materialsPrice:                    0,
    laborRatesCost:                    costCents,
    laborRatesPrice:                   priceCents,
    'tax_assignment_attributes[tax_code_uuid]': '',
    task_number:                       '',
  });

  const created: HcpPriceBookItem = {
    uuid:         res.uuid,
    name:         res.name,
    description:  res.description,
    unitPrice:    res.price / 100,
    unitCost:     res.cost / 100,
    taxable:      res.taxable,
    unitOfMeasure: res.unit_of_measure,
    categoryUuid: res.pricebook_category_uuid,
  };

  await appendToCsv({
    category:      item.category ?? 'Custom',
    uuid:          created.uuid,
    name:          created.name,
    description:   created.description,
    price:         created.unitPrice,
    priceStr:      `$${created.unitPrice.toFixed(2)}`,
    unitOfMeasure: created.unitOfMeasure,
  });

  // Index in RAG for semantic price book search — non-blocking, best-effort
  indexPriceBookItem({
    uuid:          created.uuid,
    name:          created.name,
    description:   created.description,
    price:         created.unitPrice,
    category:      item.category ?? 'Custom',
    unitOfMeasure: created.unitOfMeasure,
  }).catch(e => {
    console.warn(`[price-book] RAG index skipped: ${(e as Error).message}`);
  });

  return created;
}
