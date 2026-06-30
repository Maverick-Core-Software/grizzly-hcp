/**
 * All HCP estimate operations via internal API.
 * Prices throughout are in DOLLARS — we convert to cents internally.
 */
import { hcpPost, hcpPostForm, hcpPut, hcpPatch, hcpDelete, hcpGet } from './client.js';
import { v4 as uuid } from 'uuid';

const toCents = (dollars: number) => Math.round(dollars * 100);

export interface HcpLineItem {
  name: string;
  description?: string;
  unitPrice: number;       // dollars
  unitCost?: number;       // dollars
  quantity: number;
  kind: 'labor' | 'materials' | 'fixed discount';
  taxable?: boolean;
  serviceItemId?: string;  // olit_... or pbmat_... from price book
  serviceItemType?: string;
  orderIndex?: number;
  materialDetail?: { part_number?: string };
}

export interface HcpEstimate {
  estimateId: number;
  uuid: string;            // est_...
}

export interface HcpCreatedLineItem {
  id: string;              // rli_...
  name: string;
  unitPrice: number;       // cents (as returned by HCP)
  quantity: number;
  amount: number;          // cents
}

// ─── Create ──────────────────────────────────────────────────────────────────

export async function createEstimate(
  customerId: string,    // cus_...
  addressId: string      // adr_...
): Promise<HcpEstimate> {
  // /pro/ endpoint requires form-urlencoded and the field is service_address_uuid (not address_id)
  const res = await hcpPostForm<{ estimate_id: number; uuid: string }>(
    `/pro/add_estimate/customer/${customerId}`,
    { service_address_uuid: addressId, is_virtual: false }
  );
  return { estimateId: res.estimate_id, uuid: res.uuid };
}

// ─── Templates ───────────────────────────────────────────────────────────────

/** Apply a saved estimate template to an estimate option. */
export async function applyTemplate(
  estimateUuid: string,
  templateUuid: string   // eot_...
): Promise<void> {
  await hcpPut(
    `/alpha/estimate_templates/estimate_options/${estimateUuid}`,
    { estimate_option_template_uuid: templateUuid }
  );
}

/** Add a second estimate option (e.g. "better", "best"). */
export async function addEstimateOption(
  jobUuid: string,        // csr_... (the parent job uuid)
  name: string            // "good", "better", "best"
): Promise<void> {
  await hcpPost(`/pro/jobs/react/${jobUuid}/add_estimate_option`, { name });
}

// ─── Line items ──────────────────────────────────────────────────────────────

/** Add a single line item to an estimate. Returns the created item id. */
export async function addLineItem(
  estimateUuid: string,
  item: HcpLineItem,
  orderIndex = 0
): Promise<HcpCreatedLineItem> {
  const unitPriceCents = toCents(item.unitPrice);
  const unitCostCents  = toCents(item.unitCost ?? 0);
  const amountCents    = unitPriceCents * item.quantity;

  const isDiscount = item.kind === 'fixed discount';

  const body: Record<string, unknown> = {
    name: item.name,
    description: item.description ?? '',
    unit_price: unitPriceCents,
    unit_cost: unitCostCents,
    quantity: item.quantity,
    amount: amountCents,
    kind: item.kind,
    taxable: item.taxable ?? false,
    material_detail: item.materialDetail ?? {},
    client_side_id: uuid(),
    expand: ['material_line_item_detail', 'materials_auto_populated'],
  };

  // Discounts don't take job_uuid or order_index
  if (!isDiscount) {
    body.job_uuid = estimateUuid;
    body.order_index = orderIndex;
  }

  // Labor items require duration
  if (item.kind === 'labor') {
    body.duration_in_minutes = 120;
  }

  if (item.serviceItemId) {
    body.service_item_id = item.serviceItemId;
    body.service_item_type = item.serviceItemType ?? deriveServiceType(item.serviceItemId);
  }

  const res = await hcpPost<{ id: string; unit_price: number; quantity: number; amount: number; name: string }>(
    `/alpha/jobs/${estimateUuid}/line_items`,
    body
  );

  return { id: res.id, name: res.name, unitPrice: res.unit_price, quantity: res.quantity, amount: res.amount };
}

/** Bulk-update quantities/prices on existing line items (e.g. after applying a template). */
export async function bulkUpdateLineItems(
  estimateUuid: string,
  items: Array<{
    id: string;           // rli_...
    name: string;
    description?: string;
    unitPrice: number;    // dollars
    unitCost?: number;
    quantity: number;
    kind: string;
    taxable?: boolean;
    serviceItemId?: string;
    serviceItemType?: string;
    orderIndex?: number;
  }>
): Promise<void> {
  const lineItems = items.map(item => ({
    object: 'request_line_item',
    id: item.id,
    name: item.name,
    description: item.description ?? '',
    unit_price: toCents(item.unitPrice),
    unit_cost: toCents(item.unitCost ?? 0),
    quantity: item.quantity,
    amount: toCents(item.unitPrice) * item.quantity,
    kind: item.kind,
    taxable: item.taxable ?? false,
    order_index: item.orderIndex ?? 0,
    service_item_id: item.serviceItemId ?? null,
    service_item_type: item.serviceItemType ?? null,
    material_detail: {},
    client_side_id: uuid(),
  }));

  await hcpPost(`/alpha/jobs/${estimateUuid}/line_items/bulk_update`, {
    expand: ['material_line_item_detail', 'line_item_images'],
    line_items: lineItems,
  });
}

/** Update a single existing line item (e.g. change quantity or price). */
export async function updateLineItem(
  estimateUuid: string,
  lineItemId: string,     // rli_...
  changes: Partial<{ name: string; unitPrice: number; quantity: number; kind: string }>
): Promise<void> {
  const body: Record<string, unknown> = { id: lineItemId, client_side_id: lineItemId, material_detail: {} };
  if (changes.name      !== undefined) body.name       = changes.name;
  if (changes.unitPrice !== undefined) body.unit_price = toCents(changes.unitPrice);
  if (changes.quantity  !== undefined) body.quantity   = changes.quantity;
  if (changes.kind      !== undefined) body.kind       = changes.kind;
  if (changes.unitPrice !== undefined && changes.quantity !== undefined) {
    body.amount = toCents(changes.unitPrice) * changes.quantity;
  }
  await hcpPatch(`/alpha/jobs/${estimateUuid}/line_items/${lineItemId}`, body);
}

/** Delete a line item. */
export async function deleteLineItem(
  estimateUuid: string,
  lineItemId: string
): Promise<void> {
  await hcpDelete(`/alpha/jobs/${estimateUuid}/line_items/${lineItemId}`);
}

// ─── Deposit ─────────────────────────────────────────────────────────────────

/**
 * Set a deposit on an estimate.
 * deposit_amount is ALWAYS in cents (flat dollar amount).
 * deposit_type is a UI label only — "percent" or "flat".
 *
 * @param flatAmountDollars Flat dollar amount of the deposit (e.g. total * 0.5)
 * @param type UI display label — use "percent" if deposit was calculated as a percentage
 */
export async function setDeposit(
  estimateUuid: string,
  flatAmountDollars: number,
  type: 'percent' | 'flat' = 'percent',
  dueDateDaysFromNow = 30
): Promise<void> {
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + dueDateDaysFromNow);

  await hcpPatch(`/alpha/jobs/${estimateUuid}/deposit`, {
    deposit_amount: toCents(flatAmountDollars),
    deposit_due_date: dueDate.toISOString().slice(0, 10),
    deposit_type: type,
  });
}

// ─── Send ─────────────────────────────────────────────────────────────────────

/** Send an estimate to the customer via HCP text + email. Phone is required to SMS; email is optional. */
export async function sendEstimate(
  estimateUuid: string,
  opts: { phone?: string; email?: string; customerName?: string } = {}
): Promise<void> {
  const sends: Promise<unknown>[] = [];

  if (opts.phone) {
    sends.push(hcpPost(`/api/v2/pro/requests/text_estimate`, {
      request_uuid: estimateUuid,
      request_uuids: [estimateUuid],
      checklist_ids: [],
      custom_sms_message: 'Your estimate from Grizzly Electrical Solutions',
      phone_number: opts.phone,
      estimate_plus: true,
    }));
  }

  if (opts.email) {
    const name = opts.customerName ?? 'there';
    sends.push(hcpPost(`/api/v2/pro/requests/email_estimate`, {
      attachment_ids: [],
      request_uuid: estimateUuid,
      request_uuids: [estimateUuid],
      checklist_ids: [],
      email: opts.email,
      custom_email_subject: 'Your estimate from Grizzly Electrical Solutions',
      custom_message: `Hi ${name},\n\nThank you for reaching out to Grizzly Electrical Solutions! Please see your estimate attached. You can approve or decline directly from the link. Once approved, we'll reach out to get you on the schedule.\n\nQuestions? Call or text us at (469) 863-9804.`,
      estimate_plus: true,
    }));
  }

  await Promise.all(sends);
}

/** Write conversation transcript to the estimate's notes (visible to Carter + Jaime in HCP). */
export async function updateEstimateNotes(
  estimateUuid: string,
  notes: string
): Promise<void> {
  await hcpPost(`/api/estimates/${estimateUuid}/notes`, {
    estimate_uuid: estimateUuid,
    content: notes,
    expand: ['updated_by'],
  });
}

export async function emailEstimate(opts: {
  primaryEstimateUuid: string;
  allEstimateUuids: string[];
  toEmail: string;
  subject: string;
  message: string;
}): Promise<void> {
  await hcpPost(`/api/v2/pro/requests/email_estimate`, {
    attachment_ids: [],
    checklist_ids: [],
    request_uuid: opts.primaryEstimateUuid,
    request_uuids: opts.allEstimateUuids,
    email: opts.toEmail,
    custom_email_subject: opts.subject,
    custom_message: opts.message,
    estimate_plus: true,
  });
}

// ─── Customers ────────────────────────────────────────────────────────────────

export interface HcpCustomer {
  id: string;          // cus_...
  name: string;
  addressId: string;   // adr_...
  address: string;
}

/** Search for a customer by name. Returns best match or null. */
export async function searchCustomer(name: string): Promise<HcpCustomer | null> {
  try {
    const params = new URLSearchParams({
      q: name,
      page: '1',
      page_size: '10',
      contractor: 'false',
      has_email: 'false',
      sort_by: 'display_name',
      sort_direction: 'asc',
      for_franchise: 'false',
    });
    params.append('expand[]', 'addresses');

    const res = await hcpGet<{
      data?: Array<{
        id: string;
        display_name: string;
        addresses?: { data?: Array<{ id: string; street: string }> };
      }>;
    }>(`/alpha/customers?${params}`);

    const customers = res.data ?? [];
    if (!customers.length) return null;

    const match = customers[0];
    const addr = match.addresses?.data?.[0];
    return {
      id: match.id,
      name: match.display_name,
      addressId: addr?.id ?? '',
      address: addr?.street ?? '',
    };
  } catch {
    return null;
  }
}

// ─── Customer creation ────────────────────────────────────────────────────────

/** Create a new customer in HCP. Returns the created customer or throws on failure. */
export async function createCustomer(opts: {
  name: string;
  email: string;
  phone?: string;
}): Promise<HcpCustomer> {
  const parts = opts.name.trim().split(/\s+/);
  const firstName = parts[0] || opts.name;
  const lastName = parts.slice(1).join(' ') || '';

  const res = await hcpPost<{
    id: string;
    display_name: string;
    addresses?: { data?: Array<{ id: string; street: string }> };
  }>('/alpha/customers', {
    first_name: firstName,
    last_name: lastName,
    email: opts.email,
    phone_number: opts.phone ?? '',
    addresses_attributes: [{ street: '' }],
  });

  const addr = res.addresses?.data?.[0];
  return {
    id: res.id,
    name: res.display_name,
    addressId: addr?.id ?? '',
    address: addr?.street ?? '',
  };
}

// ─── Technician assignment ────────────────────────────────────────────────────

/**
 * Assign a technician to an estimate and trigger their push notification.
 * estimateUuid: est_... UUID from createEstimate
 * employeeUuid: pro_... UUID — Carter's is pro_fec6f009ddfe47bcb388ee45a83c31f1
 *
 * The /api/estimates/ namespace uses a different UUID (best_... prefix) than the
 * /alpha/ namespace (est_... prefix), so we fetch it first.
 */
export async function assignTechnician(estimateUuid: string, employeeUuids: string[]): Promise<void> {
  const est = await hcpGet<{ uuid: string }>(`/api/estimates/${estimateUuid}`);
  const apiUuid = est.uuid ?? estimateUuid;
  await hcpPut(`/api/estimates/${apiUuid}/assignees`, {
    service_pro_uuids: employeeUuids,
    notify_pro: true,
  });
}

// ─── Templates list ───────────────────────────────────────────────────────────

export interface HcpTemplate {
  uuid: string;    // eot_...
  name: string;
}

/** List saved estimate templates. */
export async function listTemplates(): Promise<HcpTemplate[]> {
  try {
    const res = await hcpGet<{ estimate_option_templates?: Array<{ uuid: string; name: string }> }>(
      `/alpha/estimate_templates/estimate_option_templates`
    );
    return (res.estimate_option_templates ?? []).map(t => ({ uuid: t.uuid, name: t.name }));
  } catch {
    return [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveServiceType(serviceItemId: string): string {
  if (serviceItemId.startsWith('olit_'))  return 'OrganizationalLineItemTemplate';
  if (serviceItemId.startsWith('pbmat_')) return 'Pricebook::Material';
  if (serviceItemId.startsWith('pbsd_'))  return 'Pricebook::StandardDiscount';
  return 'OrganizationalLineItemTemplate';
}
