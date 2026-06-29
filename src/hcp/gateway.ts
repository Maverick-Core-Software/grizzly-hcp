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
