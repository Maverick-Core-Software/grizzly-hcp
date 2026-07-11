/**
 * MCP-client wrapper around the housecall-pro-mcp HTTP daemon. Exposes the same
 * signatures as src/hcp/estimates.ts + price-book.ts so consumers swap by import
 * path. Selected at runtime by gateway.ts when HCP_VIA_MCP=true.
 *
 * ponytail: one lazy singleton Client per process, reused across calls (the
 * daemon is stateless Streamable-HTTP, so one connect serves many callTool's).
 * Short-lived spawn scripts connect on first call and exit without closing.
 * Upgrade path: add an explicit close()/health-check if a long-lived consumer
 * needs reconnect-on-drop.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { HcpCustomer, HcpEstimate, HcpCreatedLineItem, HcpLineItem } from "./estimates.js";
import type { HcpPriceBookItem } from "./price-book.js";

let clientPromise: Promise<Client> | null = null;

function getClient(): Promise<Client> {
  if (clientPromise) return clientPromise;
  const url = process.env.HCP_MCP_URL || "http://127.0.0.1:7332/";
  const token = process.env.HCP_MCP_TOKEN;
  if (!token) throw new Error("HCP service unavailable: HCP_MCP_TOKEN is required when HCP_VIA_MCP=true");
  clientPromise = (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "grizzly-hcp", version: "1.0.0" });
    await client.connect(transport);
    return client;
  })().catch((e) => {
    clientPromise = null; // allow retry on next call
    throw new Error(`HCP service unavailable: ${e instanceof Error ? e.message : String(e)}`);
  });
  return clientPromise;
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const client = await getClient();
  const res: any = await client.callTool({ name, arguments: args });
  const text: string = res?.content?.[0]?.text ?? "";
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (res?.isError || parsed?.success === false) {
    throw new Error(`HCP ${name} failed: ${text}`);
  }
  return parsed as T;
}

export async function searchCustomer(name: string): Promise<HcpCustomer | null> {
  const { customer } = await callTool<{ customer: HcpCustomer | null }>("search_customer", { name });
  return customer;
}

export async function createCustomer(opts: { name: string; email: string; phone?: string }): Promise<HcpCustomer> {
  const { customer } = await callTool<{ customer: HcpCustomer }>("create_customer", opts);
  return customer;
}

export async function createEstimate(customerId: string, addressId: string): Promise<HcpEstimate> {
  const { estimate } = await callTool<{ estimate: HcpEstimate }>("create_estimate", {
    customer_id: customerId,
    address_id: addressId,
  });
  return estimate;
}

export async function addLineItem(
  estimateUuid: string,
  item: HcpLineItem,
  orderIndex = 0
): Promise<HcpCreatedLineItem> {
  const { lineItem } = await callTool<{ lineItem: HcpCreatedLineItem }>("add_line_item", {
    estimate_id: estimateUuid,
    name: item.name,
    description: item.description,
    unit_price: item.unitPrice,
    unit_cost: item.unitCost,
    quantity: item.quantity,
    kind: item.kind,
    taxable: item.taxable,
    service_item_id: item.serviceItemId,
    service_item_type: item.serviceItemType,
    order_index: item.orderIndex ?? orderIndex,
  });
  return lineItem;
}

export async function assignTechnician(estimateUuid: string, employeeUuids: string[]): Promise<void> {
  await callTool("assign_technician", { estimate_uuid: estimateUuid, employee_uuids: employeeUuids });
}

export async function setDeposit(
  estimateUuid: string,
  flatAmountDollars: number,
  type: "percent" | "flat" = "percent",
  dueDateDaysFromNow = 30
): Promise<void> {
  const due = new Date();
  due.setDate(due.getDate() + dueDateDaysFromNow);
  await callTool("set_deposit", {
    estimate_id: estimateUuid,
    deposit_amount: flatAmountDollars,
    deposit_type: type,
    deposit_due_date: due.toISOString().slice(0, 10),
  });
}

export async function createPriceBookItem(item: {
  name: string;
  description?: string;
  unitPrice: number;
  unitCost?: number;
  taxable?: boolean;
  unitOfMeasure?: string;
  category?: string;     // ignored for the API call (bookkeeping only — see commit-estimate.ts)
  categoryUuid?: string;
}): Promise<HcpPriceBookItem> {
  const { item: created } = await callTool<{ item: HcpPriceBookItem }>("create_pricebook_item", {
    name: item.name,
    unit_price: item.unitPrice,
    description: item.description,
    unit_cost: item.unitCost,
    taxable: item.taxable,
    unit_of_measure: item.unitOfMeasure,
    category_uuid: item.categoryUuid,
  });
  return created;
}

/**
 * Voice-agent additions. These three tools exist only on the MCP daemon (no direct-client
 * equivalent), so consumers import them from this module directly instead of gateway.ts.
 */
export async function listEmployees(): Promise<{ count: number; employees: Array<Record<string, unknown>> }> {
  return callTool<{ count: number; employees: Array<Record<string, unknown>> }>("list_employees", {});
}

/** Raw HCP notes response for an estimate/job. Shape is not guaranteed — parse defensively. */
export async function getJobNotes(estimateUuid: string): Promise<unknown> {
  return callTool<unknown>("get_job_notes", { estimate_id: estimateUuid });
}

/**
 * Schedule a job/request. requestId is the NUMERIC estimate/request id as a string
 * (HcpEstimate.estimateId), NOT the est_... uuid. scheduleData comes from
 * buildSchedulePayload() — never hand-build it.
 */
export async function updateJobSchedule(
  requestId: string,
  scheduleData: Record<string, unknown>
): Promise<unknown> {
  return callTool<unknown>("update_job_schedule", { request_id: requestId, schedule_data: scheduleData });
}
