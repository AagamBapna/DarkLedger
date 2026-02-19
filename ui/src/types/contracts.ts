export type Party = string;

export interface ContractRecord<TPayload> {
  contractId: string;
  payload: TPayload;
}

export interface TradeIntentPayload {
  issuer: string;
  seller: string;
  sellerAgent: string;
  instrument: string;
  quantity: string | number;
  minPrice: string | number;
}

export interface DiscoveryInterestPayload {
  issuer: string;
  owner: string;
  postingAgent: string;
  discoverableBy: string[];
  instrument: string;
  side: string | { tag?: string };
  strategyTag: string;
}

export interface PrivateNegotiationPayload {
  issuer: string;
  seller: string;
  sellerAgent: string;
  buyer: string;
  buyerAgent: string;
  instrument: string;
  proposedQty: string | number | null | { tag: "Some" | "None"; value?: string | number };
  proposedUnitPrice: string | number | null | { tag: "Some" | "None"; value?: string | number };
  sellerAccepted: boolean;
  buyerAccepted: boolean;
  issuerApproved: boolean;
  expiresAt: string;
}

export interface TradeSettlementPayload {
  issuer: string;
  seller: string;
  sellerAgent: string;
  buyer: string;
  buyerAgent: string;
  instrument: string;
  quantity: string | number;
  unitPrice: string | number;
  rofrApproved: boolean;
  settled: boolean;
}

export interface TradeAuditRecordPayload {
  issuer: string;
  seller: string;
  buyer: string;
  sellerAgent: string;
  buyerAgent: string;
  instrument: string;
  quantity: string | number;
  unitPrice: string | number;
  settledAt: string;
}

export interface AgentDecisionLogPayload {
  agent: string;
  owner: string;
  instrument: string;
  decision: string;
  reasoning: string;
  timestamp: string;
  marketContext: string;
}

export interface AssetHoldingPayload {
  owner: string;
  issuer: string;
  instrument: string;
  quantity: string | number;
}

export interface CashHoldingPayload {
  owner: string;
  issuer: string;
  currency: string;
  amount: string | number;
}

export interface AgentLogEntry {
  id: string;
  at: string;
  source: "market-feed" | "seller-agent" | "buyer-agent" | "ledger-event" | "ui-action" | "llm-advisor";
  decision: string;
  metadata: string;
  reasoning?: string;
}
