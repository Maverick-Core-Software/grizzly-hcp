/**
 * Approval policy for Maverick agent actions.
 *
 * Defines which actions require user confirmation and validates approved payloads.
 * Does NOT implement the waiting mechanism — each channel adapter (text card,
 * voice spoken confirmation, CLI stdin) handles the actual approval flow.
 */

export type ActionType =
  | 'create_estimate'
  | 'create_customer'
  | 'create_pricebook_item'
  | 'schedule_job'
  | 'reschedule_job'
  | 'send_invoice'
  | 'reply_to_customer'
  | 'mark_job_complete'
  | 'upload_photo';

const REQUIRES_APPROVAL = new Set<ActionType>([
  'create_estimate',
  'create_customer',
  'create_pricebook_item',
  'schedule_job',
  'reschedule_job',
  'send_invoice',
  'reply_to_customer',
  'mark_job_complete',
  'upload_photo',
]);

export function requiresApproval(action: ActionType): boolean {
  return REQUIRES_APPROVAL.has(action);
}

// ─── Approved payload shapes ──────────────────────────────────────────────────

export interface ApprovedLineItem {
  name: string;
  quantity: number;
  unitPrice: number;
  type: 'matched' | 'new' | string;
  serviceItemId?: string;
}

export interface ApprovedNewCustomer {
  isNew: true;
  name: string;
  email?: string;
  phone?: string;
}

export interface ApprovedExistingCustomer {
  isNew?: false;
  id: string;         // HCP cus_...
  addressId: string;  // HCP adr_...
  name: string;
}

export type ApprovedCustomer = ApprovedNewCustomer | ApprovedExistingCustomer;

export interface ApprovedNewPricebookItem {
  name: string;
  description: string;
  category: string;
  unitPrice: number;
}

export interface ApprovedEstimatePayload {
  operationId: string;
  lineItems: ApprovedLineItem[];
  customer: ApprovedCustomer;
  newPricebookItems?: ApprovedNewPricebookItem[];
  techIds: string[];           // [] = no tech assigned
  depositPercent?: number;
  depositAmount?: number;
}

export function validateEstimatePayload(payload: unknown): payload is ApprovedEstimatePayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.operationId !== 'string') return false;
  if (!Array.isArray(p.lineItems) || !p.lineItems.length) return false;
  if (!p.customer || typeof p.customer !== 'object') return false;
  if (!Array.isArray(p.techIds)) return false;
  return true;
}
