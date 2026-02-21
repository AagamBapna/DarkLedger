import type {
  AgentDecisionLogPayload,
  AssetHoldingPayload,
  CashHoldingPayload,
  ContractRecord,
  DiscoveryInterestPayload,
  Party,
  PrivateNegotiationPayload,
  TradeAuditRecordPayload,
  TradeIntentPayload,
  TradeSettlementPayload,
} from "../types/contracts";

const JSON_API_URL = import.meta.env.VITE_JSON_API_URL ?? "http://localhost:7575";
const MARKET_API_URL = import.meta.env.VITE_MARKET_API_URL ?? "http://localhost:8090";
const STATIC_TOKEN = import.meta.env.VITE_JSON_API_TOKEN;
const USE_INSECURE_TOKENS =
  (import.meta.env.VITE_JSON_API_USE_INSECURE_TOKEN ?? "false").toLowerCase() === "true";

const PACKAGE_ID = import.meta.env.VITE_PACKAGE_ID ?? "";
const pkgPrefix = PACKAGE_ID ? `${PACKAGE_ID}:` : "";

export const TEMPLATE_IDS = {
  assetHolding: `${pkgPrefix}AgenticShadowCap.Market:AssetHolding`,
  cashHolding: `${pkgPrefix}AgenticShadowCap.Market:CashHolding`,
  tradeIntent: `${pkgPrefix}AgenticShadowCap.Market:TradeIntent`,
  discoveryInterest: `${pkgPrefix}AgenticShadowCap.Market:DiscoveryInterest`,
  privateNegotiation: `${pkgPrefix}AgenticShadowCap.Market:PrivateNegotiation`,
  tradeSettlement: `${pkgPrefix}AgenticShadowCap.Market:TradeSettlement`,
  tradeAuditRecord: `${pkgPrefix}AgenticShadowCap.Market:TradeAuditRecord`,
  agentDecisionLog: `${pkgPrefix}AgenticShadowCap.Market:AgentDecisionLog`,
} as const;

function base64UrlEncode(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const partyIdCache: Record<string, string> = {};
let partyResolutionDone = false;

function buildAdminToken(): string {
  const header = { alg: "none", typ: "JWT" };
  const payload = {
    "https://daml.com/ledger-api": {
      ledgerId: "sandbox",
      applicationId: "agentic-shadow-cap-ui",
      admin: true,
      actAs: [] as string[],
      readAs: [] as string[],
    },
  };
  return `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}.`;
}

async function resolveParties(): Promise<void> {
  if (partyResolutionDone) return;
  try {
    const token = buildAdminToken();
    const response = await fetch(`${JSON_API_URL}/v1/parties`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      const data = await response.json() as { result: Array<{ displayName?: string; identifier: string }> };
      for (const p of data.result ?? []) {
        if (p.displayName) {
          partyIdCache[p.displayName] = p.identifier;
        }
      }
    }
  } catch {
    // fall through — use display names as-is
  }
  partyResolutionDone = true;
}

function resolvedPartyId(party: Party): string {
  return partyIdCache[party] ?? party;
}

function buildInsecureToken(party: Party): string {
  const fullId = resolvedPartyId(party);
  const header = { alg: "none", typ: "JWT" };
  const payload = {
    "https://daml.com/ledger-api": {
      ledgerId: "sandbox",
      applicationId: "agentic-shadow-cap-ui",
      actAs: [fullId],
      readAs: [fullId],
    },
  };
  return `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}.`;
}

function authHeaderForParty(party: Party): string | null {
  if (STATIC_TOKEN) return STATIC_TOKEN;
  if (USE_INSECURE_TOKENS) return buildInsecureToken(party);
  return null;
}

async function jsonApiRequest<TResponse>(party: Party, path: string, body: unknown): Promise<TResponse> {
  await resolveParties();
  const token = authHeaderForParty(party);
  const response = await fetch(`${JSON_API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ledger-Party": resolvedPartyId(party),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${path} failed (${response.status}): ${message}`);
  }
  return (await response.json()) as TResponse;
}

interface QueryResponse<TPayload> {
  status: number;
  result: Array<{ contractId?: string; contract_id?: string; payload: TPayload }>;
}

interface ExerciseResponse<TPayload> {
  status: number;
  result: {
    exerciseResult: unknown;
    events: Array<{ created?: { contractId?: string; payload: TPayload } }>;
  };
}

async function queryTemplate<TPayload>(
  party: Party,
  templateId: string,
  query: Record<string, unknown> | null = null,
): Promise<Array<ContractRecord<TPayload>>> {
  const payload = query ? { templateIds: [templateId], query } : { templateIds: [templateId] };
  const response = await jsonApiRequest<QueryResponse<TPayload>>(party, "/v1/query", payload);
  return (response.result ?? []).map((item) => ({
    contractId: item.contractId ?? item.contract_id ?? "",
    payload: item.payload,
  }));
}

export async function queryContractsByTemplate<TPayload = Record<string, unknown>>(
  party: Party,
  templateId: string,
  query: Record<string, unknown> | null = null,
): Promise<Array<ContractRecord<TPayload>>> {
  return queryTemplate<TPayload>(party, templateId, query);
}

export async function queryAssetHoldings(party: Party) {
  return queryTemplate<AssetHoldingPayload>(party, TEMPLATE_IDS.assetHolding);
}

export async function queryCashHoldings(party: Party) {
  return queryTemplate<CashHoldingPayload>(party, TEMPLATE_IDS.cashHolding);
}

export async function queryTradeIntents(party: Party) {
  return queryTemplate<TradeIntentPayload>(party, TEMPLATE_IDS.tradeIntent);
}

export async function queryDiscoveryInterests(party: Party) {
  return queryTemplate<DiscoveryInterestPayload>(party, TEMPLATE_IDS.discoveryInterest);
}

export async function queryPrivateNegotiations(party: Party) {
  return queryTemplate<PrivateNegotiationPayload>(party, TEMPLATE_IDS.privateNegotiation);
}

export async function queryTradeSettlements(party: Party) {
  return queryTemplate<TradeSettlementPayload>(party, TEMPLATE_IDS.tradeSettlement);
}

export async function queryAuditRecords(party: Party) {
  return queryTemplate<TradeAuditRecordPayload>(party, TEMPLATE_IDS.tradeAuditRecord);
}

export async function queryDecisionLogs(party: Party) {
  return queryTemplate<AgentDecisionLogPayload>(party, TEMPLATE_IDS.agentDecisionLog);
}

export async function exerciseChoice(
  party: Party,
  templateId: string,
  contractId: string,
  choice: string,
  argument: Record<string, unknown>,
): Promise<unknown> {
  const response = await jsonApiRequest<ExerciseResponse<unknown>>(party, "/v1/exercise", {
    templateId,
    contractId,
    choice,
    argument,
  });
  return response.result.exerciseResult;
}

export async function createContract<TPayload>(
  party: Party,
  templateId: string,
  payload: Record<string, unknown>,
): Promise<ContractRecord<TPayload>> {
  const response = await jsonApiRequest<{ status: number; result: { contractId?: string; payload: TPayload } }>(
    party,
    "/v1/create",
    { templateId, payload },
  );
  return { contractId: response.result.contractId ?? "", payload: response.result.payload };
}

export async function injectMarketEvent(eventType: string, severity: number = 1.0) {
  const response = await fetch(`${MARKET_API_URL}/market-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: eventType, severity }),
  });
  if (!response.ok) throw new Error(`Market event injection failed: ${response.status}`);
  return response.json();
}

export async function getMarketApiStatus() {
  const response = await fetch(`${MARKET_API_URL}/status`);
  if (!response.ok) return null;
  return response.json();
}

export async function setAgentAutoReprice(role: "seller" | "buyer", enabled: boolean) {
  const response = await fetch(`${MARKET_API_URL}/agent-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, auto_reprice: enabled }),
  });
  if (!response.ok) {
    throw new Error(`Agent config update failed: ${response.status}`);
  }
  return response.json();
}

export function optionalToNumber(
  value: number | string | null | { tag: "Some" | "None"; value?: number | string },
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && "tag" in value) {
    if (value.tag === "None") return null;
    if (value.tag === "Some") return Number(value.value ?? 0);
  }
  return Number(value);
}

export function numberLike(value: string | number): number {
  return Number(value);
}
