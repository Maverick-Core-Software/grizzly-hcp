export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  unit?: string; // "each", "hr", "ft", etc.
}

export interface ProposalData {
  customer: {
    name: string;
    phone?: string;
    email?: string;
    address: string;
    city?: string;
    state?: string;
    zip?: string;
  };
  jobType?: string;      // e.g. "Panel Upgrade", "Service Call", "Rough-In"
  tags?: string[];
  scopeOfWork: string;   // free-text notes / description
  lineItems: LineItem[];
  estimateNumber?: string;
  validUntil?: string;   // ISO date string
}
