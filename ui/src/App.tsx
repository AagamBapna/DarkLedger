import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MatchFoundToast } from "./components/MatchFoundToast";
import { usePartyContext } from "./context/PartyContext";
import {
  TEMPLATE_IDS,
  createContract,
  exerciseChoice,
  getMarketApiStatus,
  queryAssetHoldings,
  queryAuditRecords,
  queryCashHoldings,
  queryDecisionLogs,
  queryDiscoveryInterests,
  queryPrivateNegotiations,
  queryTradeIntents,
  queryTradeSettlements,
  setAgentAutoReprice,
} from "./lib/ledgerClient";
import type {
  AgentDecisionLogPayload,
  AssetHoldingPayload,
  CashHoldingPayload,
  ContractRecord,
  DiscoveryInterestPayload,
  PrivateNegotiationPayload,
  TradeAuditRecordPayload,
  TradeIntentPayload,
  TradeSettlementPayload,
} from "./types/contracts";
import { FlowView } from "./views/FlowView";
import { PrivacyMatrixView } from "./views/PrivacyMatrixView";

type ShockTemplate = "tradeIntent" | "privateNegotiation" | "tradeSettlement";
type NegotiationChoice =
  | "SubmitSellerTerms"
  | "SubmitBuyerTerms"
  | "CommitTerms"
  | "RevealTerms"
  | "RejectBySeller"
  | "RejectByBuyer"
  | "ExpireNegotiation"
  | "AcceptBySeller"
  | "AcceptByBuyer"
  | "ApproveMatch"
  | "StartSettlement";
type SettlementChoice = "SimpleFinalizeSettlement" | "FinalizeSettlement";

interface MatchToastState {
  instrument: string;
  counterparty: string;
}

interface VisibilityShockState {
  template: ShockTemplate;
  sellerCount: number;
  outsiderCount: number;
  sellerVisible: boolean;
  outsiderVisible: boolean;
  contractId: string;
  availableSellerContractIds: string[];
  checkedAt: string;
}

interface OutsiderSnapshot {
  tradeIntents: number;
  discovery: number;
  negotiations: number;
  settlements: number;
  audits: number;
  assets: number;
  cash: number;
  ok: boolean;
  message: string;
  updatedAt: string;
}

interface RedTeamAttempt {
  id: string;
  at: string;
  result: "private-denied" | "leak-detected" | "probe-error";
  message: string;
}

interface LeakPreview {
  instrument: string;
  quantity: number;
  minPrice: number;
  sellerAlias: string;
  buyerAlias: string;
}

interface EntropyStreak {
  top: number;
  left: number;
  width: number;
  delay: string;
  duration: string;
}

const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS ?? "3000");
const JSON_API_URL = import.meta.env.VITE_JSON_API_URL ?? "http://localhost:7575";

function aliasOf(party: string): string {
  return party.includes("::") ? party.split("::")[0] : party;
}

function shortId(value: string, size: number = 8): string {
  if (!value) return "-";
  if (value.length <= size * 2 + 3) return value;
  return `${value.slice(0, size)}...${value.slice(-size)}`;
}

function resolveAlias(availableParties: string[], alias: string): string {
  const exact = availableParties.find((entry) => entry === alias);
  if (exact) return exact;
  const qualified = availableParties.find((entry) => entry.startsWith(`${alias}::`));
  if (qualified) return qualified;
  return alias;
}

function participantLabelFor(party: string, networkMode: string): string {
  if (aliasOf(party) === "Outsider") return "none (outsider read-as)";
  if (networkMode === "local") {
    if (aliasOf(party) === "Seller" || aliasOf(party) === "SellerAgent") return "seller-node:5011";
    if (aliasOf(party) === "Buyer" || aliasOf(party) === "BuyerAgent") return "buyer-node:5021";
    return "issuer-node:5031";
  }
  try {
    const url = new URL(JSON_API_URL);
    return `${url.host} (${networkMode})`;
  } catch {
    return `gateway (${networkMode})`;
  }
}

function pseudonymToken(value: string): string {
  let acc = 0;
  for (let i = 0; i < value.length; i += 1) {
    acc = (acc * 33 + value.charCodeAt(i)) >>> 0;
  }
  return acc.toString(16).toUpperCase().slice(-4).padStart(4, "0");
}

function counterpartyPseudonym(
  party: string,
  payload: PrivateNegotiationPayload,
): string {
  const alias = aliasOf(party);
  if (alias === "Seller" || alias === "SellerAgent") {
    return `Buyer-${pseudonymToken(payload.buyer)}`;
  }
  if (alias === "Buyer" || alias === "BuyerAgent") {
    return `Seller-${pseudonymToken(payload.seller)}`;
  }
  return `Pair-${pseudonymToken(payload.instrument)}`;
}

function agentRoleForParty(party: string): "seller" | "buyer" | null {
  const alias = aliasOf(party);
  if (alias === "Seller" || alias === "SellerAgent") return "seller";
  if (alias === "Buyer" || alias === "BuyerAgent") return "buyer";
  return null;
}

function isAlias(party: string, expected: string): boolean {
  return aliasOf(party) === expected;
}

function normalizeActionError(message: string): string {
  if (message.includes("DAML_AUTHORIZATION_ERROR")) {
    return "Authorization failed for the selected actor. Use Seller for TradeIntent, SellerAgent/BuyerAgent for negotiation, and Company for settlement/compliance actions.";
  }
  return message.length > 240 ? `${message.slice(0, 240)}...` : message;
}

function errorMessageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function isJsonApiListLimitError(message: string): boolean {
  return message.includes("JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED");
}

function sideTag(value: string | { tag?: string } | Record<string, unknown>): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    if ("tag" in value && typeof value.tag === "string") return value.tag;
    const keys = Object.keys(value);
    if (keys.length === 1) return keys[0];
  }
  return "";
}

function discoveryTtlWindow(ttlSeconds: number = 240): { createdAt: string; expiresAt: string } {
  const created = new Date();
  const expires = new Date(created.getTime() + ttlSeconds * 1000);
  return {
    createdAt: created.toISOString(),
    expiresAt: expires.toISOString(),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function commitmentHashForTerms(qtyText: string, unitPriceText: string, salt: string): Promise<string> {
  return sha256Hex(`${qtyText}|${unitPriceText}|${salt}`);
}

function optionalText(value: string | null | { tag: "Some" | "None"; value?: string }): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "tag" in value) {
    if (value.tag === "Some") return value.value ?? null;
    return null;
  }
  return null;
}

async function queryContractsForTemplate(template: ShockTemplate, party: string) {
  switch (template) {
    case "tradeIntent":
      return queryTradeIntents(party);
    case "privateNegotiation":
      return queryPrivateNegotiations(party);
    case "tradeSettlement":
      return queryTradeSettlements(party);
    default:
      return [];
  }
}

async function loadOutsiderSnapshot(outsiderParty: string): Promise<OutsiderSnapshot> {
  const [tradeIntents, discovery, negotiations, settlements, audits, assets, cash] = await Promise.all([
    queryTradeIntents(outsiderParty).then((rows) => rows.length).catch(() => 0),
    queryDiscoveryInterests(outsiderParty).then((rows) => rows.length).catch(() => 0),
    queryPrivateNegotiations(outsiderParty).then((rows) => rows.length).catch(() => 0),
    queryTradeSettlements(outsiderParty).then((rows) => rows.length).catch(() => 0),
    queryAuditRecords(outsiderParty).then((rows) => rows.length).catch(() => 0),
    queryAssetHoldings(outsiderParty).then((rows) => rows.length).catch(() => 0),
    queryCashHoldings(outsiderParty).then((rows) => rows.length).catch(() => 0),
  ]);

  const totalVisible = tradeIntents + discovery + negotiations + settlements + audits + assets + cash;

  return {
    tradeIntents,
    discovery,
    negotiations,
    settlements,
    audits,
    assets,
    cash,
    ok: totalVisible === 0,
    message: totalVisible === 0 ? "private-denied" : `unexpected visibility=${totalVisible}`,
    updatedAt: new Date().toISOString(),
  };
}

export default function App() {
  const {
    party,
    setParty,
    autoReprice,
    setAutoReprice,
    logs,
    addLog,
    clearLogs,
    availableParties,
    networkMode,
  } = usePartyContext();

  const [tradeIntents, setTradeIntents] = useState<Array<ContractRecord<TradeIntentPayload>>>([]);
  const [discoveryInterests, setDiscoveryInterests] = useState<Array<ContractRecord<DiscoveryInterestPayload>>>([]);
  const [negotiations, setNegotiations] = useState<Array<ContractRecord<PrivateNegotiationPayload>>>([]);
  const [settlements, setSettlements] = useState<Array<ContractRecord<TradeSettlementPayload>>>([]);
  const [auditRecords, setAuditRecords] = useState<Array<ContractRecord<TradeAuditRecordPayload>>>([]);
  const [assetHoldings, setAssetHoldings] = useState<Array<ContractRecord<AssetHoldingPayload>>>([]);
  const [cashHoldings, setCashHoldings] = useState<Array<ContractRecord<CashHoldingPayload>>>([]);
  const [decisionLogs, setDecisionLogs] = useState<Array<ContractRecord<AgentDecisionLogPayload>>>([]);

  const [intentLastUpdate, setIntentLastUpdate] = useState<Record<string, string>>({});
  const [draftOverrides, setDraftOverrides] = useState<Record<string, string>>({});

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [matchToast, setMatchToast] = useState<MatchToastState | null>(null);
  const [marketApiOnline, setMarketApiOnline] = useState(false);

  const [shockTemplate, setShockTemplate] = useState<ShockTemplate>("tradeIntent");
  const [shockContractId, setShockContractId] = useState("");
  const [shockLoading, setShockLoading] = useState(false);
  const [visibilityShock, setVisibilityShock] = useState<VisibilityShockState | null>(null);

  const [outsiderSnapshot, setOutsiderSnapshot] = useState<OutsiderSnapshot>({
    tradeIntents: 0,
    discovery: 0,
    negotiations: 0,
    settlements: 0,
    audits: 0,
    assets: 0,
    cash: 0,
    ok: true,
    message: "private-denied",
    updatedAt: "",
  });
  const [spyRunning, setSpyRunning] = useState(false);
  const [redTeamAttempts, setRedTeamAttempts] = useState<RedTeamAttempt[]>([]);
  const [leakPreview, setLeakPreview] = useState<LeakPreview | null>(null);

  const [actionBusy, setActionBusy] = useState(false);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const sellerParty = useMemo(() => resolveAlias(availableParties, "Seller"), [availableParties]);
  const sellerAgentParty = useMemo(() => resolveAlias(availableParties, "SellerAgent"), [availableParties]);
  const buyerParty = useMemo(() => resolveAlias(availableParties, "Buyer"), [availableParties]);
  const buyerAgentParty = useMemo(() => resolveAlias(availableParties, "BuyerAgent"), [availableParties]);
  const companyParty = useMemo(() => resolveAlias(availableParties, "Company"), [availableParties]);
  const outsiderParty = useMemo(() => resolveAlias(availableParties, "Outsider"), [availableParties]);

  const [orderActor, setOrderActor] = useState<string>(sellerParty);
  const [instrument, setInstrument] = useState("COMPANY-SERIES-A");
  const [quantity, setQuantity] = useState("1200");
  const [minPrice, setMinPrice] = useState("98");

  const [discoveryActor, setDiscoveryActor] = useState<string>(sellerAgentParty);
  const [discoveryOwner, setDiscoveryOwner] = useState<string>(sellerParty);
  const [discoverySide, setDiscoverySide] = useState<"Buy" | "Sell">("Sell");
  const [discoverableByCsv, setDiscoverableByCsv] = useState<string>(buyerAgentParty);
  const [strategyTag, setStrategyTag] = useState("control-tower");

  const [negotiationActor, setNegotiationActor] = useState<string>(sellerAgentParty);
  const [negotiationChoice, setNegotiationChoice] = useState<NegotiationChoice>("SubmitSellerTerms");
  const [negotiationCid, setNegotiationCid] = useState("");
  const [negotiationQty, setNegotiationQty] = useState("1000");
  const [negotiationPrice, setNegotiationPrice] = useState("99");
  const [negotiationSide, setNegotiationSide] = useState<"Buy" | "Sell">("Sell");
  const [negotiationSalt, setNegotiationSalt] = useState("control-tower-salt");

  const [settlementActor, setSettlementActor] = useState<string>(companyParty);
  const [settlementChoice, setSettlementChoice] = useState<SettlementChoice>("SimpleFinalizeSettlement");
  const [settlementCid, setSettlementCid] = useState("");
  const [sellerAssetCid, setSellerAssetCid] = useState("");
  const [buyerCashCid, setBuyerCashCid] = useState("");

  const [advancedActor, setAdvancedActor] = useState<string>(companyParty);
  const [advancedTemplateId, setAdvancedTemplateId] = useState<string>(TEMPLATE_IDS.privateNegotiation);
  const [advancedContractId, setAdvancedContractId] = useState("");
  const [advancedChoice, setAdvancedChoice] = useState("ExpireNegotiation");
  const [advancedArgumentJson, setAdvancedArgumentJson] = useState("{}");

  const priorIntentIds = useRef<Set<string>>(new Set());
  const priorNegotiationIds = useRef<Set<string>>(new Set());
  const priorSettlementIds = useRef<Set<string>>(new Set());
  const discoveryOverflowLogged = useRef(false);

  useEffect(() => {
    setOrderActor(sellerParty);
    setDiscoveryActor(sellerAgentParty);
    setDiscoveryOwner(sellerParty);
    setDiscoverableByCsv(buyerAgentParty);
    setNegotiationActor(sellerAgentParty);
    setSettlementActor(companyParty);
    setAdvancedActor(companyParty);
  }, [buyerAgentParty, companyParty, sellerAgentParty, sellerParty]);

  useEffect(() => {
    if (!negotiationCid && negotiations.length > 0) {
      setNegotiationCid(negotiations[0].contractId);
    }
  }, [negotiationCid, negotiations]);

  useEffect(() => {
    if (!settlementCid && settlements.length > 0) {
      setSettlementCid(settlements[0].contractId);
    }
  }, [settlementCid, settlements]);

  useEffect(() => {
    if (!sellerAssetCid && assetHoldings.length > 0) {
      setSellerAssetCid(assetHoldings[0].contractId);
    }
    if (!buyerCashCid && cashHoldings.length > 0) {
      setBuyerCashCid(cashHoldings[0].contractId);
    }
  }, [assetHoldings, buyerCashCid, cashHoldings, sellerAssetCid]);

  const refreshOutsiderSnapshot = useCallback(async () => {
    try {
      const snapshot = await loadOutsiderSnapshot(outsiderParty);
      setOutsiderSnapshot(snapshot);
      return snapshot;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Outsider probe failed";
      setOutsiderSnapshot((prev) => ({
        ...prev,
        ok: false,
        message,
        updatedAt: new Date().toISOString(),
      }));
      return null;
    }
  }, [outsiderParty]);

  const refreshVisibilityShock = useCallback(async (templateOverride?: ShockTemplate, contractIdOverride?: string) => {
    setShockLoading(true);
    try {
      const targetTemplate = templateOverride ?? shockTemplate;
      const targetContractId = contractIdOverride ?? shockContractId;
      const [sellerRows, outsiderRows] = await Promise.all([
        queryContractsForTemplate(targetTemplate, sellerParty),
        queryContractsForTemplate(targetTemplate, outsiderParty),
      ]);

      const availableSellerContractIds = sellerRows.map((contract) => contract.contractId);
      const nextContractId =
        targetContractId && availableSellerContractIds.includes(targetContractId)
          ? targetContractId
          : availableSellerContractIds[0] ?? "";

      if (nextContractId !== targetContractId) {
        setShockContractId(nextContractId);
      }

      const sellerVisible = nextContractId
        ? sellerRows.some((contract) => contract.contractId === nextContractId)
        : false;
      const outsiderVisible = nextContractId
        ? outsiderRows.some((contract) => contract.contractId === nextContractId)
        : false;

      setVisibilityShock({
        template: targetTemplate,
        sellerCount: sellerRows.length,
        outsiderCount: outsiderRows.length,
        sellerVisible,
        outsiderVisible,
        contractId: nextContractId,
        availableSellerContractIds,
        checkedAt: new Date().toISOString(),
      });
    } catch {
      setVisibilityShock((prev) =>
        prev
          ? {
              ...prev,
              checkedAt: new Date().toISOString(),
            }
          : null,
      );
    } finally {
      setShockLoading(false);
    }
  }, [outsiderParty, sellerParty, shockContractId, shockTemplate]);

  const refreshLedgerData = useCallback(async (targetParty: string) => {
    try {
      const [
        tradeIntentsResult,
        discoveryResult,
        negotiationsResult,
        settlementsResult,
        auditsResult,
        assetsResult,
        cashResult,
        decisionsResult,
      ] = await Promise.allSettled([
        queryTradeIntents(targetParty),
        queryDiscoveryInterests(targetParty),
        queryPrivateNegotiations(targetParty),
        queryTradeSettlements(targetParty),
        queryAuditRecords(targetParty),
        queryAssetHoldings(targetParty),
        queryCashHoldings(targetParty),
        queryDecisionLogs(targetParty),
      ]);

      const failures: string[] = [];

      if (tradeIntentsResult.status === "fulfilled") {
        const nextTradeIntents = tradeIntentsResult.value;
        setTradeIntents(nextTradeIntents);

        const now = new Date().toISOString();
        setIntentLastUpdate((prev) => {
          const merged = { ...prev };
          for (const intent of nextTradeIntents) {
            merged[intent.contractId] = merged[intent.contractId] ?? now;
          }
          return merged;
        });

        const nextIntentIds = new Set(nextTradeIntents.map((contract) => contract.contractId));
        for (const contractId of nextIntentIds) {
          if (!priorIntentIds.current.has(contractId)) {
            addLog({
              source: "ledger-event",
              decision: "TradeIntent visible",
              metadata: `cid=${contractId} party=${targetParty}`,
            });
          }
        }
        priorIntentIds.current = nextIntentIds;
      } else {
        failures.push(`TradeIntent: ${errorMessageFrom(tradeIntentsResult.reason)}`);
      }

      if (discoveryResult.status === "fulfilled") {
        setDiscoveryInterests(discoveryResult.value);
        discoveryOverflowLogged.current = false;
      } else {
        const message = errorMessageFrom(discoveryResult.reason);
        if (isJsonApiListLimitError(message)) {
          if (!discoveryOverflowLogged.current) {
            addLog({
              source: "ui-action",
              decision: "Discovery query capped by node limit",
              metadata:
                "Too many DiscoveryInterest contracts visible (>200). Reset localnet or retire stale discovery contracts.",
            });
            discoveryOverflowLogged.current = true;
          }
        } else {
          failures.push(`DiscoveryInterest: ${message}`);
        }
      }

      if (negotiationsResult.status === "fulfilled") {
        const nextNegotiations = negotiationsResult.value;
        setNegotiations(nextNegotiations);

        const nextNegotiationIds = new Set(nextNegotiations.map((contract) => contract.contractId));
        for (const negotiation of nextNegotiations) {
          if (!priorNegotiationIds.current.has(negotiation.contractId)) {
            addLog({
              source: "ledger-event",
              decision: "PrivateNegotiation created",
              metadata: `cid=${negotiation.contractId} instrument=${negotiation.payload.instrument}`,
            });
            setMatchToast({
              instrument: negotiation.payload.instrument,
              counterparty: counterpartyPseudonym(targetParty, negotiation.payload),
            });
          }
        }
        priorNegotiationIds.current = nextNegotiationIds;
      } else {
        failures.push(`PrivateNegotiation: ${errorMessageFrom(negotiationsResult.reason)}`);
      }

      if (settlementsResult.status === "fulfilled") {
        const nextSettlements = settlementsResult.value;
        setSettlements(nextSettlements);

        const nextSettlementIds = new Set(nextSettlements.map((contract) => contract.contractId));
        for (const contractId of nextSettlementIds) {
          if (!priorSettlementIds.current.has(contractId)) {
            addLog({
              source: "ledger-event",
              decision: "TradeSettlement created",
              metadata: `cid=${contractId}`,
            });
          }
        }
        priorSettlementIds.current = nextSettlementIds;
      } else {
        failures.push(`TradeSettlement: ${errorMessageFrom(settlementsResult.reason)}`);
      }

      if (auditsResult.status === "fulfilled") {
        setAuditRecords(auditsResult.value);
      } else {
        failures.push(`TradeAuditRecord: ${errorMessageFrom(auditsResult.reason)}`);
      }

      if (assetsResult.status === "fulfilled") {
        setAssetHoldings(assetsResult.value);
      } else {
        failures.push(`AssetHolding: ${errorMessageFrom(assetsResult.reason)}`);
      }

      if (cashResult.status === "fulfilled") {
        setCashHoldings(cashResult.value);
      } else {
        failures.push(`CashHolding: ${errorMessageFrom(cashResult.reason)}`);
      }

      if (decisionsResult.status === "fulfilled") {
        setDecisionLogs(decisionsResult.value);
      }

      setError(failures.length > 0 ? failures.join(" | ") : null);
      void refreshOutsiderSnapshot();
      void refreshVisibilityShock();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown ledger error";
      setError(message);
      addLog({
        source: "ui-action",
        decision: "Ledger refresh failed",
        metadata: message,
      });
    } finally {
      setLoading(false);
    }
  }, [addLog, refreshOutsiderSnapshot, refreshVisibilityShock]);

  useEffect(() => {
    setLoading(true);
    void refreshLedgerData(party);
    const timer = window.setInterval(() => {
      void refreshLedgerData(party);
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [party, refreshLedgerData]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await getMarketApiStatus();
        if (!cancelled) {
          setMarketApiOnline(result !== null);
          const role = agentRoleForParty(party);
          if (result?.agent_config && role) {
            const key = `${role}_auto_reprice`;
            const value = result.agent_config[key];
            if (typeof value === "boolean") {
              setAutoReprice(value);
            }
          }
        }
      } catch {
        if (!cancelled) setMarketApiOnline(false);
      }
    };
    void poll();
    const timer = window.setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [party, setAutoReprice]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const snapshot = await refreshOutsiderSnapshot();
      if (cancelled || snapshot === null) return;
    };
    void poll();
    const timer = window.setInterval(poll, 9000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshOutsiderSnapshot]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      await refreshVisibilityShock();
      if (cancelled) return;
    };
    void poll();
    const timer = window.setInterval(poll, 7000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshVisibilityShock]);

  useEffect(() => {
    if (aliasOf(party) === "Outsider") return;
    if (tradeIntents.length === 0) return;

    const intent = tradeIntents[0];
    const negotiation = negotiations[0];
    setLeakPreview({
      instrument: intent.payload.instrument,
      quantity: Number(intent.payload.quantity),
      minPrice: Number(intent.payload.minPrice),
      sellerAlias: negotiation ? `Seller-${pseudonymToken(negotiation.payload.seller)}` : `Seller-${pseudonymToken(intent.payload.seller)}`,
      buyerAlias: negotiation ? `Buyer-${pseudonymToken(negotiation.payload.buyer)}` : "Buyer-????",
    });
  }, [party, negotiations, tradeIntents]);

  const onAutoRepriceToggle = useCallback(
    async (enabled: boolean) => {
      setAutoReprice(enabled);
      const role = agentRoleForParty(party);
      if (!role) {
        addLog({
          source: "ui-action",
          decision: "Auto-reprice toggle ignored",
          metadata: `party=${party} has no agent role`,
        });
        return;
      }
      try {
        await setAgentAutoReprice(role, enabled);
        addLog({
          source: "ui-action",
          decision: "Auto-reprice toggled",
          metadata: `role=${role} enabled=${String(enabled)}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Agent config update failed";
        addLog({
          source: "ui-action",
          decision: "Auto-reprice toggle failed",
          metadata: message,
        });
        setError(message);
      }
    },
    [party, setAutoReprice, addLog],
  );

  const onOverrideMinPrice = useCallback(
    async (contractId: string, nextMinPrice: number) => {
      if (!Number.isFinite(nextMinPrice) || nextMinPrice <= 0) {
        addLog({
          source: "ui-action",
          decision: "Manual override rejected",
          metadata: `invalid minPrice=${nextMinPrice}`,
        });
        return;
      }
      try {
        await exerciseChoice(party, TEMPLATE_IDS.tradeIntent, contractId, "UpdatePrice", {
          newMinPrice: nextMinPrice.toFixed(2),
        });
        addLog({
          source: "ui-action",
          decision: "Manual minPrice override submitted",
          metadata: `cid=${contractId} minPrice=${nextMinPrice.toFixed(2)}`,
        });
        await refreshLedgerData(party);
      } catch (err) {
        const message = err instanceof Error ? err.message : "UpdatePrice failed";
        addLog({
          source: "ui-action",
          decision: "Manual override failed",
          metadata: `cid=${contractId} error=${message}`,
        });
        setError(message);
      }
    },
    [party, addLog, refreshLedgerData],
  );

  const onArchiveTradeIntent = useCallback(
    async (contractId: string) => {
      try {
        await exerciseChoice(sellerParty, TEMPLATE_IDS.tradeIntent, contractId, "ArchiveIntent", {});
        addLog({
          source: "ui-action",
          decision: "TradeIntent archived",
          metadata: `cid=${contractId}`,
        });
        await refreshLedgerData(party);
      } catch (err) {
        const message = err instanceof Error ? err.message : "ArchiveIntent failed";
        addLog({
          source: "ui-action",
          decision: "TradeIntent archive failed",
          metadata: `cid=${contractId} error=${message}`,
        });
        setError(normalizeActionError(message));
      }
    },
    [addLog, party, refreshLedgerData, sellerParty],
  );

  const onApproveMatch = useCallback(
    async (actor: string, contractId: string) => {
      await exerciseChoice(actor, TEMPLATE_IDS.privateNegotiation, contractId, "ApproveMatch", {});
    },
    [],
  );

  const runRedTeamProbe = useCallback(async () => {
    if (spyRunning) return;
    setSpyRunning(true);
    try {
      const snapshot = await loadOutsiderSnapshot(outsiderParty);
      setOutsiderSnapshot(snapshot);
      const total =
        snapshot.tradeIntents
        + snapshot.discovery
        + snapshot.negotiations
        + snapshot.settlements
        + snapshot.audits
        + snapshot.assets
        + snapshot.cash;

      const outcome: RedTeamAttempt = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        result: total === 0 ? "private-denied" : "leak-detected",
        message:
          total === 0
            ? "Probe result: private-denied across all templates."
            : `Unexpected outsider visibility detected (${total} records).`,
      };

      setRedTeamAttempts((prev) => [outcome, ...prev].slice(0, 8));
      addLog({
        source: "ui-action",
        decision: "Red-team probe executed",
        metadata: outcome.message,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Red-team probe failed";
      const failureAttempt: RedTeamAttempt = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        result: "probe-error",
        message,
      };
      setRedTeamAttempts((prev) => [failureAttempt, ...prev].slice(0, 8));
      addLog({
        source: "ui-action",
        decision: "Red-team probe failed",
        metadata: message,
      });
    } finally {
      setSpyRunning(false);
    }
  }, [addLog, outsiderParty, spyRunning]);

  const runConsoleAction = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setActionBusy(true);
      setActionStatus(null);
      setActionError(null);
      try {
        await action();
        setActionStatus(label);
        addLog({
          source: "ui-action",
          decision: "Control tower action executed",
          metadata: label,
        });
        await refreshLedgerData(party);
        await refreshOutsiderSnapshot();
        await refreshVisibilityShock();
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : "Action failed";
        const message = normalizeActionError(rawMessage);
        setActionError(message);
        addLog({
          source: "ui-action",
          decision: "Control tower action failed",
          metadata: `${label} error=${message}`,
        });
      } finally {
        setActionBusy(false);
      }
    },
    [addLog, party, refreshLedgerData, refreshOutsiderSnapshot, refreshVisibilityShock],
  );

  const executeCreateTradeIntent = useCallback(async () => {
    if (!isAlias(orderActor, "Seller")) {
      setActionError("TradeIntent creation requires Actor=Seller.");
      return;
    }
    const qty = Number.parseFloat(quantity);
    const px = Number.parseFloat(minPrice);
    await runConsoleAction(`TradeIntent created by ${aliasOf(orderActor)}`, async () => {
      await createContract(orderActor, TEMPLATE_IDS.tradeIntent, {
        issuer: companyParty,
        seller: sellerParty,
        sellerAgent: sellerAgentParty,
        instrument,
        quantity: Number.isFinite(qty) ? qty : 1000,
        minPrice: Number.isFinite(px) ? px : 95,
      });
    });
  }, [companyParty, instrument, minPrice, orderActor, quantity, runConsoleAction, sellerAgentParty, sellerParty]);

  const executeCreateDiscoveryInterest = useCallback(async () => {
    const discoveryActorAlias = aliasOf(discoveryActor);
    if (discoveryActorAlias !== "SellerAgent" && discoveryActorAlias !== "BuyerAgent") {
      setActionError("DiscoveryInterest posting requires Actor=SellerAgent or BuyerAgent.");
      return;
    }
    const discoverableBy = discoverableByCsv
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    const ttl = discoveryTtlWindow();

    await runConsoleAction(`DiscoveryInterest posted by ${aliasOf(discoveryActor)} (${discoverySide})`, async () => {
      await createContract(discoveryActor, TEMPLATE_IDS.discoveryInterest, {
        issuer: companyParty,
        owner: discoveryOwner,
        postingAgent: discoveryActor,
        discoverableBy,
        instrument,
        side: { tag: discoverySide, value: {} },
        strategyTag,
        createdAt: ttl.createdAt,
        expiresAt: ttl.expiresAt,
      });
    });
  }, [companyParty, discoverableByCsv, discoveryActor, discoveryOwner, discoverySide, instrument, runConsoleAction, strategyTag]);

  const executeNegotiationChoice = useCallback(async () => {
    if (!negotiationCid) {
      setActionError("Select a PrivateNegotiation contract ID first.");
      return;
    }

    const expectedActor =
      negotiationChoice === "SubmitSellerTerms"
      || negotiationChoice === "AcceptBySeller"
      || negotiationChoice === "RejectBySeller"
        ? sellerAgentParty
        : negotiationChoice === "SubmitBuyerTerms"
          || negotiationChoice === "AcceptByBuyer"
          || negotiationChoice === "RejectByBuyer"
          ? buyerAgentParty
          : negotiationChoice === "CommitTerms" || negotiationChoice === "RevealTerms"
            ? (negotiationSide === "Sell" ? sellerAgentParty : buyerAgentParty)
            : companyParty;

    if (negotiationActor !== expectedActor) {
      setActionError(`"${negotiationChoice}" requires Actor=${aliasOf(expectedActor)}.`);
      return;
    }

    await runConsoleAction(`${negotiationChoice} by ${aliasOf(negotiationActor)}`, async () => {
      let argument: Record<string, unknown> = {};

      if (negotiationChoice === "SubmitSellerTerms" || negotiationChoice === "SubmitBuyerTerms") {
        argument = {
          qty: Number.parseFloat(negotiationQty),
          unitPrice: Number.parseFloat(negotiationPrice),
        };
      } else if (negotiationChoice === "CommitTerms") {
        const qtyText = String(Number.parseFloat(negotiationQty));
        const unitPriceText = String(Number.parseFloat(negotiationPrice));
        const commitmentHash = await commitmentHashForTerms(qtyText, unitPriceText, negotiationSalt);
        argument = {
          side: { tag: negotiationSide, value: {} },
          commitmentHash,
        };
      } else if (negotiationChoice === "RevealTerms") {
        argument = {
          side: { tag: negotiationSide, value: {} },
          qtyText: String(Number.parseFloat(negotiationQty)),
          unitPriceText: String(Number.parseFloat(negotiationPrice)),
          salt: negotiationSalt,
        };
      }

      if (negotiationChoice === "ApproveMatch") {
        await onApproveMatch(negotiationActor, negotiationCid);
        return;
      }

      await exerciseChoice(
        negotiationActor,
        TEMPLATE_IDS.privateNegotiation,
        negotiationCid,
        negotiationChoice,
        argument,
      );
    });
  }, [
    negotiationActor,
    negotiationChoice,
    negotiationCid,
    negotiationPrice,
    negotiationQty,
    negotiationSalt,
    negotiationSide,
    onApproveMatch,
    buyerAgentParty,
    companyParty,
    runConsoleAction,
    sellerAgentParty,
  ]);

  const executeSettlementChoice = useCallback(async () => {
    if (!settlementCid) {
      setActionError("Select a TradeSettlement contract ID first.");
      return;
    }

    if (!isAlias(settlementActor, "Company")) {
      setActionError("Settlement choices require Actor=Company.");
      return;
    }

    await runConsoleAction(`${settlementChoice} by ${aliasOf(settlementActor)}`, async () => {
      if (settlementChoice === "FinalizeSettlement") {
        await exerciseChoice(
          settlementActor,
          TEMPLATE_IDS.tradeSettlement,
          settlementCid,
          settlementChoice,
          { sellerAssetCid, buyerCashCid },
        );
        return;
      }
      await exerciseChoice(
        settlementActor,
        TEMPLATE_IDS.tradeSettlement,
        settlementCid,
        settlementChoice,
        {},
      );
    });
  }, [buyerCashCid, runConsoleAction, sellerAssetCid, settlementActor, settlementChoice, settlementCid]);

  const executeAdvancedChoice = useCallback(async () => {
    if (!advancedContractId.trim()) {
      setActionError("Enter a contract ID for advanced choice execution.");
      return;
    }

    let argument: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(advancedArgumentJson || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setActionError("Advanced argument JSON must be an object.");
        return;
      }
      argument = parsed as Record<string, unknown>;
    } catch {
      setActionError("Advanced argument JSON is invalid.");
      return;
    }

    await runConsoleAction(`Advanced choice ${advancedChoice} by ${aliasOf(advancedActor)}`, async () => {
      await exerciseChoice(
        advancedActor,
        advancedTemplateId,
        advancedContractId.trim(),
        advancedChoice.trim(),
        argument,
      );
    });
  }, [
    advancedActor,
    advancedArgumentJson,
    advancedChoice,
    advancedContractId,
    advancedTemplateId,
    runConsoleAction,
  ]);

  const outsiderVisibilityTotal =
    outsiderSnapshot.tradeIntents
    + outsiderSnapshot.discovery
    + outsiderSnapshot.negotiations
    + outsiderSnapshot.settlements
    + outsiderSnapshot.audits
    + outsiderSnapshot.assets
    + outsiderSnapshot.cash;

  const replayAttackBlocked = negotiations.every((item) =>
    item.payload.issuerApproved
      ? item.payload.sellerTermsRevealed && item.payload.buyerTermsRevealed
      : true,
  );

  const commitRevealStatus = useMemo(() => {
    const hasRevealed = negotiations.some(
      (item) => item.payload.sellerTermsRevealed && item.payload.buyerTermsRevealed,
    );
    if (hasRevealed) return "revealed" as const;

    const hasCommitted = negotiations.some(
      (item) =>
        optionalText(item.payload.sellerCommitmentHash) !== null
        && optionalText(item.payload.buyerCommitmentHash) !== null,
    );
    if (hasCommitted) return "committed" as const;

    return "awaiting" as const;
  }, [negotiations]);

  const expiredDiscoveryCount = discoveryInterests.filter((item) => {
    const expiresAt = new Date(item.payload.expiresAt).getTime();
    return Number.isFinite(expiresAt) && expiresAt <= Date.now();
  }).length;

  const activeDiscoveryCount = Math.max(discoveryInterests.length - expiredDiscoveryCount, 0);

  const shockTemplateLabel =
    shockTemplate === "tradeIntent"
      ? "TradeIntent"
      : shockTemplate === "privateNegotiation"
        ? "PrivateNegotiation"
        : "TradeSettlement";

  const canOverridePrice = aliasOf(party) === "SellerAgent";
  const canToggleAutoReprice =
    aliasOf(party) === "Seller"
    || aliasOf(party) === "SellerAgent"
    || aliasOf(party) === "Buyer"
    || aliasOf(party) === "BuyerAgent";

  const tradeIntentActorOptions = useMemo(() => {
    const options = availableParties.filter((entry) => isAlias(entry, "Seller"));
    return options.length > 0 ? options : [sellerParty];
  }, [availableParties, sellerParty]);

  const discoveryActorOptions = useMemo(() => {
    const options = availableParties.filter((entry) => {
      const alias = aliasOf(entry);
      return alias === "SellerAgent" || alias === "BuyerAgent";
    });
    return options.length > 0 ? options : [sellerAgentParty, buyerAgentParty];
  }, [availableParties, buyerAgentParty, sellerAgentParty]);

  const discoveryOwnerOptions = useMemo(() => {
    const options = availableParties.filter((entry) => {
      const alias = aliasOf(entry);
      return alias === "Seller" || alias === "Buyer";
    });
    return options.length > 0 ? options : [sellerParty, buyerParty];
  }, [availableParties, buyerParty, sellerParty]);

  const requiredNegotiationActor = useMemo(() => {
    if (
      negotiationChoice === "SubmitSellerTerms"
      || negotiationChoice === "AcceptBySeller"
      || negotiationChoice === "RejectBySeller"
    ) return sellerAgentParty;
    if (
      negotiationChoice === "SubmitBuyerTerms"
      || negotiationChoice === "AcceptByBuyer"
      || negotiationChoice === "RejectByBuyer"
    ) return buyerAgentParty;
    if (negotiationChoice === "CommitTerms" || negotiationChoice === "RevealTerms") {
      return negotiationSide === "Sell" ? sellerAgentParty : buyerAgentParty;
    }
    return companyParty;
  }, [buyerAgentParty, companyParty, negotiationChoice, negotiationSide, sellerAgentParty]);

  const settlementActorOptions = useMemo(() => {
    const options = availableParties.filter((entry) => isAlias(entry, "Company"));
    return options.length > 0 ? options : [companyParty];
  }, [availableParties, companyParty]);

  useEffect(() => {
    if (!tradeIntentActorOptions.includes(orderActor)) {
      setOrderActor(tradeIntentActorOptions[0]);
    }
  }, [orderActor, tradeIntentActorOptions]);

  useEffect(() => {
    if (!discoveryActorOptions.includes(discoveryActor)) {
      setDiscoveryActor(discoveryActorOptions[0]);
    }
  }, [discoveryActor, discoveryActorOptions]);

  useEffect(() => {
    if (!discoveryOwnerOptions.includes(discoveryOwner)) {
      setDiscoveryOwner(discoveryOwnerOptions[0]);
    }
  }, [discoveryOwner, discoveryOwnerOptions]);

  useEffect(() => {
    if (negotiationActor !== requiredNegotiationActor) {
      setNegotiationActor(requiredNegotiationActor);
    }
  }, [negotiationActor, requiredNegotiationActor]);

  useEffect(() => {
    if (!settlementActorOptions.includes(settlementActor)) {
      setSettlementActor(settlementActorOptions[0]);
    }
  }, [settlementActor, settlementActorOptions]);

  const partyVisibilityNarrative = useMemo(() => {
    const alias = aliasOf(party);
    switch (alias) {
      case "Seller":
      case "SellerAgent":
        return {
          canSee: "Seller-side intents, scoped discovery, negotiations, settlements, audits.",
          cannotSee: "Buyer private strategy outside scoped contracts.",
        };
      case "Buyer":
      case "BuyerAgent":
        return {
          canSee: "Buyer-side discovery, negotiations, settlements, and resulting audit records.",
          cannotSee: "Seller-only intent details before matching.",
        };
      case "Company":
        return {
          canSee: "Issuer compliance scope across intent, discovery, negotiation, settlement, audit.",
          cannotSee: "No public order-book leakage to non-participants.",
        };
      case "Outsider":
        return {
          canSee: "Only denied probes and zero-visibility evidence.",
          cannotSee: "All private contracts and terms.",
        };
      default:
        return {
          canSee: "Party-scoped contracts visible by Canton disclosure rules.",
          cannotSee: "Contracts not shared to this participant.",
        };
    }
  }, [party]);

  const pendingApprovals = negotiations.filter((item) =>
    item.payload.sellerAccepted
    && item.payload.buyerAccepted
    && !item.payload.issuerApproved,
  ).length;

  const pendingSettlements = settlements.filter((item) => !item.payload.settled).length;

  const matrixRefreshToken =
    logs.length
    + tradeIntents.length
    + discoveryInterests.length
    + negotiations.length
    + settlements.length
    + outsiderVisibilityTotal;

  const refreshAllViews = useCallback(async () => {
    await refreshLedgerData(party);
    await refreshOutsiderSnapshot();
    await refreshVisibilityShock();
  }, [party, refreshLedgerData, refreshOutsiderSnapshot, refreshVisibilityShock]);

  const entropyLines = useMemo(() => {
    const seedText = [
      party,
      networkMode,
      String(outsiderVisibilityTotal),
      String(tradeIntents.length),
      String(discoveryInterests.length),
      String(negotiations.length),
      String(settlements.length),
      String(error ? 1 : 0),
    ].join("|");

    let state = 2166136261;
    for (const char of seedText) {
      state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
    }

    const nextHexChunk = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0).toString(16).toUpperCase().padStart(8, "0");
    };

    return Array.from({ length: 20 }, (_, index) => {
      const chunks = Array.from({ length: 15 }, () => nextHexChunk()).join(" ");
      return `${String(index).padStart(2, "0")} ${chunks}`;
    });
  }, [
    tradeIntents,
    discoveryInterests,
    negotiations,
    settlements,
    party,
    networkMode,
    outsiderVisibilityTotal,
    error,
  ]);

  const introStreaks = useMemo<EntropyStreak[]>(() => [
    { top: 8, left: 30, width: 66, delay: "0s", duration: "4.2s" },
    { top: 13, left: 42, width: 54, delay: "0.3s", duration: "3.6s" },
    { top: 19, left: 20, width: 70, delay: "0.7s", duration: "4.7s" },
    { top: 24, left: 48, width: 58, delay: "0.2s", duration: "3.8s" },
    { top: 30, left: 25, width: 63, delay: "0.5s", duration: "4.5s" },
    { top: 37, left: 58, width: 48, delay: "0.8s", duration: "3.9s" },
    { top: 44, left: 31, width: 62, delay: "1.1s", duration: "4.8s" },
    { top: 51, left: 16, width: 72, delay: "0.4s", duration: "4.4s" },
    { top: 58, left: 52, width: 55, delay: "1.3s", duration: "4.1s" },
    { top: 64, left: 28, width: 67, delay: "0.9s", duration: "4.6s" },
    { top: 71, left: 60, width: 46, delay: "1.5s", duration: "3.7s" },
    { top: 77, left: 23, width: 64, delay: "1.8s", duration: "4.3s" },
    { top: 84, left: 45, width: 56, delay: "1.6s", duration: "4.0s" },
    { top: 90, left: 26, width: 70, delay: "2.1s", duration: "4.9s" },
  ], []);

  return (
    <main className="app-canvas px-4 py-6 text-shell-950 md:px-8">
      <div className="mx-auto max-w-[1600px] space-y-5">
        <header className="hero-shell">
          <div className="hero-shell__copy">
            <p className="text-xs uppercase tracking-[0.28em] text-signal-slate">Canton Privacy Control Tower</p>
            <h1 className="hero-title">
              The confidential market stack designed for private execution.
            </h1>
            <p className="mt-3 max-w-3xl text-sm text-signal-slate md:text-base">
              Live proof of scoped visibility, commit-reveal safety, settlement controls, and outsider denial across the same contract lifecycle.
            </p>

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                className="hero-pill"
                onClick={() => void refreshLedgerData(party)}
                disabled={loading}
              >
                {loading ? "Refreshing..." : "Request Access"}
              </button>
              <button
                className="hero-pill hero-pill--ghost"
                onClick={() => void runRedTeamProbe()}
                disabled={spyRunning}
              >
                {spyRunning ? "Probing..." : "Launch Probe"}
              </button>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <article className="data-card md:min-w-[320px]">
                <p className="text-xs uppercase tracking-[0.16em] text-signal-slate">Party & Network</p>
                <p className="mt-1 text-2xl font-semibold text-shell-950">{aliasOf(party)}</p>
                <p className="text-xs text-signal-slate">Network mode: {networkMode}</p>
                <p className="text-sm text-signal-slate">Endpoint: {participantLabelFor(party, networkMode)}</p>
                <p className="text-xs">
                  Connectivity: <span className={error ? "text-signal-coral" : "text-signal-mint"}>{error ? "degraded" : "connected"}</span>
                </p>
                <p className="text-xs">
                  Market API: <span className={marketApiOnline ? "text-signal-mint" : "text-signal-coral"}>{marketApiOnline ? "online" : "offline"}</span>
                </p>
              </article>
              <article className="data-card">
                <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">What This Party Can See</p>
                <p className="mt-2 text-sm text-shell-950">{partyVisibilityNarrative.canSee}</p>
                <p className="mt-3 text-xs uppercase tracking-[0.14em] text-signal-slate">What This Party Cannot See</p>
                <p className="mt-1 text-sm text-shell-950">{partyVisibilityNarrative.cannotSee}</p>
              </article>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {availableParties.map((entry) => {
                const active = party === entry;
                return (
                  <button
                    key={entry}
                    className={`hero-chip ${active ? "hero-chip--active" : ""}`}
                    onClick={() => setParty(entry)}
                  >
                    {aliasOf(entry)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="hero-shell__entropy" aria-hidden="true">
            <div className="entropy-scanline" />
            <div className="entropy-streaks">
              {introStreaks.map((streak, index) => (
                <span
                  key={`${streak.top}-${streak.left}-${index}`}
                  className="entropy-streak"
                  style={{
                    top: `${streak.top}%`,
                    left: `${streak.left}%`,
                    width: `${streak.width}%`,
                    animationDelay: streak.delay,
                    animationDuration: streak.duration,
                  }}
                />
              ))}
            </div>
            <div className="entropy-track">
              {[...entropyLines, ...entropyLines].map((line, index) => (
                <p key={`${line}-${index}`} className="entropy-line">{line}</p>
              ))}
            </div>
          </div>
        </header>

        <section className="panel-shell">
          <p className="text-xs uppercase tracking-[0.24em] text-signal-slate">Privacy Guarantees</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <article className="data-card">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Outsider Visibility</p>
              <p className={`mt-2 text-3xl font-bold ${outsiderVisibilityTotal === 0 ? "text-signal-mint" : "text-signal-coral"}`}>
                {outsiderVisibilityTotal}
              </p>
              <p className="text-sm text-signal-slate">{outsiderVisibilityTotal === 0 ? "PASS: zero visible records" : "FAIL: unexpected visibility"}</p>
            </article>

            <article className="data-card">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Replay Attack Protection</p>
              <p className={`mt-2 text-3xl font-bold ${replayAttackBlocked ? "text-signal-mint" : "text-signal-coral"}`}>
                {replayAttackBlocked ? "BLOCKED" : "RISK"}
              </p>
              <p className="text-sm text-signal-slate">Driven by commit-reveal and single-use choices.</p>
            </article>

            <article className="data-card">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Discovery TTL Cleanup</p>
              <p className={`mt-2 text-3xl font-bold ${expiredDiscoveryCount === 0 ? "text-signal-mint" : "text-signal-amber"}`}>
                {expiredDiscoveryCount === 0 ? "PASS" : "ACTIVE"}
              </p>
              <p className="text-sm text-signal-slate">Active: {activeDiscoveryCount} | Expired: {expiredDiscoveryCount}</p>
            </article>

            <article className="data-card">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Commit-Reveal Integrity</p>
              <p className={`mt-2 text-3xl font-bold uppercase ${
                commitRevealStatus === "revealed"
                  ? "text-signal-mint"
                  : commitRevealStatus === "committed"
                    ? "text-signal-amber"
                    : "text-signal-slate"
              }`}>
                {commitRevealStatus}
              </p>
              <p className="text-sm text-signal-slate">Negotiations with both commitments and reveal parity.</p>
            </article>
          </div>
        </section>

        <section className="panel-shell">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Same Contract, Two Perspectives</p>
              <h2 className="mt-1 text-2xl font-semibold text-shell-950">Live Contract Visibility Proof</h2>
            </div>
            <p className="text-sm text-signal-slate">
              Seller and Outsider query the same {shockTemplateLabel} contract ID.
            </p>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[180px_1fr_auto]">
            <label className="text-xs text-signal-slate">
              Template
              <select
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                value={shockTemplate}
                onChange={(event) => setShockTemplate(event.target.value as ShockTemplate)}
              >
                <option value="tradeIntent">TradeIntent</option>
                <option value="privateNegotiation">PrivateNegotiation</option>
                <option value="tradeSettlement">TradeSettlement</option>
              </select>
            </label>

            <label className="text-xs text-signal-slate">
              Contract ID
              <input
                list="shock-contract-ids"
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                value={shockContractId}
                onChange={(event) => setShockContractId(event.target.value)}
                placeholder="Pick seller-side contract ID"
              />
              <datalist id="shock-contract-ids">
                {visibilityShock?.availableSellerContractIds.map((contractId) => (
                  <option key={contractId} value={contractId} />
                ))}
              </datalist>
            </label>

            <button
              className="rounded-md bg-shell-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              disabled={shockLoading}
              onClick={() => void refreshVisibilityShock()}
            >
              {shockLoading ? "Checking..." : "Refresh Proof"}
            </button>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <article className="data-card">
              <p className="text-xs uppercase tracking-[0.12em] text-signal-slate">Authorized Party (Seller)</p>
              <p className={`mt-2 text-lg font-semibold ${visibilityShock?.sellerVisible ? "text-signal-mint" : "text-signal-coral"}`}>
                {visibilityShock?.sellerVisible ? "VISIBLE" : "NOT VISIBLE"}
              </p>
              <p className="mt-1 text-sm text-signal-slate">Total seller-scope contracts: {visibilityShock?.sellerCount ?? 0}</p>
              <p className="text-xs text-signal-slate">Contract ID: {visibilityShock?.contractId ? shortId(visibilityShock.contractId, 10) : "-"}</p>
              <button
                className="mt-2 rounded-md border border-shell-700 px-3 py-1.5 text-xs font-semibold text-shell-950"
                onClick={() => setParty(sellerParty)}
              >
                Switch to Seller
              </button>
            </article>

            <article className="data-card">
              <p className="text-xs uppercase tracking-[0.12em] text-signal-slate">Outsider</p>
              <p className={`mt-2 text-lg font-semibold ${visibilityShock?.outsiderVisible ? "text-signal-coral" : "text-signal-mint"}`}>
                {visibilityShock?.outsiderVisible ? "VISIBLE (UNEXPECTED)" : "NOT VISIBLE"}
              </p>
              <p className="mt-1 text-sm text-signal-slate">Total outsider-scope contracts: {visibilityShock?.outsiderCount ?? 0}</p>
              <p className="text-xs text-signal-slate">Last checked: {visibilityShock?.checkedAt ? new Date(visibilityShock.checkedAt).toLocaleTimeString() : "-"}</p>
              <button
                className="mt-2 rounded-md border border-shell-700 px-3 py-1.5 text-xs font-semibold text-shell-950"
                onClick={() => setParty(outsiderParty)}
              >
                Switch to Outsider
              </button>
            </article>
          </div>
        </section>

        <section className="panel-shell">
          <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Cross-Party Visibility Matrix</p>
          <div className="mt-3">
            <PrivacyMatrixView
              availableParties={availableParties}
              activeParty={party}
              refreshToken={matrixRefreshToken}
            />
          </div>
        </section>

        <section className="panel-shell">
          <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Manual Demo Flow</p>
          <div className="mt-3">
            <FlowView
              party={party}
              availableParties={availableParties}
              tradeIntents={tradeIntents}
              discoveryInterests={discoveryInterests}
              negotiations={negotiations}
              settlements={settlements}
              auditRecords={auditRecords}
              assetHoldings={assetHoldings}
              cashHoldings={cashHoldings}
              onSwitchParty={(nextParty) => setParty(nextParty)}
              onRefresh={refreshAllViews}
              onLog={addLog}
            />
          </div>
        </section>


        {error ? (
          <div className="rounded-xl border border-signal-coral/40 bg-signal-coral/10 p-3 text-sm text-signal-coral">
            {error}
          </div>
        ) : null}

      </div>

      {matchToast ? (
        <MatchFoundToast
          instrument={matchToast.instrument}
          counterparty={matchToast.counterparty}
          onOpenChannel={() => setMatchToast(null)}
          onDismiss={() => setMatchToast(null)}
        />
      ) : null}
    </main>
  );
}
