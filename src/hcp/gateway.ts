/**
 * HCP write-spine gateway. Selects the direct cookie client or the MCP daemon
 * wrapper by the HCP_VIA_MCP flag, so commit-estimate.ts imports from one place
 * and flips implementation by env. Default off = unchanged direct behavior.
 */
import * as direct from "./estimates.js";
import { createPriceBookItem as directCreatePriceBookItem } from "./price-book.js";
import * as mcp from "./mcp-client.js";

export const HCP_VIA_MCP = process.env.HCP_VIA_MCP === "true";

export const searchCustomer      = HCP_VIA_MCP ? mcp.searchCustomer      : direct.searchCustomer;
export const createCustomer      = HCP_VIA_MCP ? mcp.createCustomer      : direct.createCustomer;
export const createEstimate      = HCP_VIA_MCP ? mcp.createEstimate      : direct.createEstimate;
export const addLineItem         = HCP_VIA_MCP ? mcp.addLineItem         : direct.addLineItem;
export const assignTechnician    = HCP_VIA_MCP ? mcp.assignTechnician    : direct.assignTechnician;
export const setDeposit          = HCP_VIA_MCP ? mcp.setDeposit          : direct.setDeposit;
export const createPriceBookItem = HCP_VIA_MCP ? mcp.createPriceBookItem : directCreatePriceBookItem;
export const addCustomerAddress  = HCP_VIA_MCP ? mcp.addCustomerAddress  : direct.addCustomerAddress;

// updateEstimateNotes goes via MCP once CT102 runs a release tag that ships the
// update_estimate_notes tool. Until then the daemon reports it as an unknown
// tool, so fall back to the direct cookie client — note-writing must keep
// working either way (it runs before assignTechnician, the only notification).
export const updateEstimateNotes = !HCP_VIA_MCP
  ? direct.updateEstimateNotes
  : async (estimateUuid: string, notes: string): Promise<void> => {
      try {
        await mcp.updateEstimateNotes(estimateUuid, notes);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/unknown tool|tool.* not found|-32602/i.test(msg)) throw e;
        console.warn("[gateway] update_estimate_notes not on the MCP daemon yet — using direct client");
        await direct.updateEstimateNotes(estimateUuid, notes);
      }
    };
