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
import { PrivacyMatrixView } from "./views/PrivacyMatrixView";

type ShockTemplate = "tradeIntent" | "privateNegotiation" | "tradeSettlement";
type NegotiationChoice =
  | "SubmitSellerTerms"
  | "SubmitBuyerTerms"
  | "CommitTerms"
  | "RevealTerms"
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
        const message = err instanceof Error ? err.message : "Action failed";
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
    runConsoleAction,
  ]);

  const executeSettlementChoice = useCallback(async () => {
    if (!settlementCid) {
      setActionError("Select a TradeSettlement contract ID first.");
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

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#eef1f8] via-[#f8f9fd] to-[#edf1fb] px-4 py-6 text-shell-950 md:px-8">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <header className="rounded-3xl border border-shell-700 bg-white/80 p-6 shadow-[0_18px_60px_rgba(36,56,99,0.12)] backdrop-blur-xl">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-signal-slate">Canton Privacy Control Tower</p>
              <h1 className="mt-2 text-4xl font-bold leading-tight text-shell-950 md:text-5xl">
                Confidential OTC Trading Feature Showcase
              </h1>
              <p className="mt-2 max-w-3xl text-base text-signal-slate">
                Always-on demonstration of party-scoped visibility, commit-reveal integrity, issuer controls, and audit-grade settlement flow.
              </p>
            </div>
            <div className="grid gap-2 rounded-2xl border border-shell-700 bg-white p-4 md:min-w-[320px]">
              <p className="text-xs uppercase tracking-[0.16em] text-signal-slate">Party & Network</p>
              <p className="text-2xl font-semibold text-shell-950">{aliasOf(party)}</p>
              <p className="text-xs text-signal-slate">Network mode: {networkMode}</p>
              <p className="text-sm text-signal-slate">Endpoint: {participantLabelFor(party, networkMode)}</p>
              <p className="text-xs">
                Connectivity: <span className={error ? "text-signal-coral" : "text-signal-mint"}>{error ? "degraded" : "connected"}</span>
              </p>
              <p className="text-xs">
                Market API: <span className={marketApiOnline ? "text-signal-mint" : "text-signal-coral"}>{marketApiOnline ? "online" : "offline"}</span>
              </p>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {availableParties.map((entry) => {
              const active = party === entry;
              return (
                <button
                  key={entry}
                  className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
                    active
                      ? "border-shell-950 bg-shell-950 text-white shadow-pulse"
                      : "border-shell-700 bg-white text-shell-950 hover:border-shell-950"
                  }`}
                  onClick={() => setParty(entry)}
                >
                  {aliasOf(entry)}
                </button>
              );
            })}
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">What This Party Can See</p>
              <p className="mt-2 text-sm text-shell-950">{partyVisibilityNarrative.canSee}</p>
            </article>
            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">What This Party Cannot See</p>
              <p className="mt-2 text-sm text-shell-950">{partyVisibilityNarrative.cannotSee}</p>
            </article>
          </div>
        </header>

        <section className="rounded-3xl border border-shell-700 bg-white/75 p-5 backdrop-blur-xl">
          <p className="text-xs uppercase tracking-[0.24em] text-signal-slate">Privacy Guarantees</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Outsider Visibility</p>
              <p className={`mt-2 text-3xl font-bold ${outsiderVisibilityTotal === 0 ? "text-signal-mint" : "text-signal-coral"}`}>
                {outsiderVisibilityTotal}
              </p>
              <p className="text-sm text-signal-slate">{outsiderVisibilityTotal === 0 ? "PASS: zero visible records" : "FAIL: unexpected visibility"}</p>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Replay Attack Protection</p>
              <p className={`mt-2 text-3xl font-bold ${replayAttackBlocked ? "text-signal-mint" : "text-signal-coral"}`}>
                {replayAttackBlocked ? "BLOCKED" : "RISK"}
              </p>
              <p className="text-sm text-signal-slate">Driven by commit-reveal and single-use choices.</p>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Discovery TTL Cleanup</p>
              <p className={`mt-2 text-3xl font-bold ${expiredDiscoveryCount === 0 ? "text-signal-mint" : "text-signal-amber"}`}>
                {expiredDiscoveryCount === 0 ? "PASS" : "ACTIVE"}
              </p>
              <p className="text-sm text-signal-slate">Active: {activeDiscoveryCount} | Expired: {expiredDiscoveryCount}</p>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-4">
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

        <section className="rounded-3xl border border-shell-700 bg-white/80 p-5 backdrop-blur-xl">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Feature Showcase Grid</p>
              <h2 className="mt-1 text-2xl font-semibold text-shell-950">All Major Capabilities, Live At Once</h2>
            </div>
            <div className="flex items-center gap-2 text-xs text-signal-slate">
              <button
                className="rounded-md border border-shell-700 bg-white px-3 py-1.5 font-semibold text-shell-950"
                onClick={() => void refreshLedgerData(party)}
                disabled={loading}
              >
                {loading ? "Refreshing..." : "Refresh Ledger"}
              </button>
              <button
                className="rounded-md bg-signal-coral px-3 py-1.5 font-semibold text-shell-950 disabled:opacity-50"
                onClick={() => void runRedTeamProbe()}
                disabled={spyRunning}
              >
                {spyRunning ? "Probing..." : "Run Outsider Probe"}
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-3">
            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Trade Intents</p>
              <p className="mt-1 text-2xl font-semibold text-shell-950">{tradeIntents.length}</p>
              <p className="text-xs text-signal-slate">Total qty: {tradeIntents.reduce((sum, row) => sum + Number(row.payload.quantity), 0).toLocaleString()}</p>
              <div className="mt-3 space-y-2">
                {tradeIntents.slice(0, 3).map((intent) => {
                  const currentMin = Number(intent.payload.minPrice);
                  const draft = draftOverrides[intent.contractId] ?? currentMin.toFixed(2);
                  return (
                    <div key={intent.contractId} className="rounded-lg border border-shell-700 bg-shell-900/5 p-2">
                      <p className="text-sm font-semibold text-shell-950">{intent.payload.instrument}</p>
                      <p className="text-xs text-signal-slate">
                        Qty {Number(intent.payload.quantity).toLocaleString()} | Min ${currentMin.toFixed(2)} | CID {shortId(intent.contractId)}
                      </p>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-signal-slate">Expand actions</summary>
                        <div className="mt-2 flex items-center gap-2">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            className="w-28 rounded-md border border-shell-700 bg-white px-2 py-1 text-xs text-shell-950"
                            value={draft}
                            onChange={(event) =>
                              setDraftOverrides((prev) => ({ ...prev, [intent.contractId]: event.target.value }))
                            }
                          />
                          <button
                            className="rounded-md bg-signal-mint px-2 py-1 text-xs font-semibold text-shell-950 disabled:opacity-50"
                            disabled={!canOverridePrice}
                            onClick={() => void onOverrideMinPrice(intent.contractId, Number.parseFloat(draft))}
                          >
                            Update Price
                          </button>
                        </div>
                      </details>
                    </div>
                  );
                })}
                {tradeIntents.length === 0 ? <p className="text-xs text-signal-slate">No visible TradeIntent contracts.</p> : null}
              </div>
              <label className="mt-3 flex items-center gap-2 text-xs text-signal-slate">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-signal-mint"
                  checked={autoReprice}
                  disabled={!canToggleAutoReprice}
                  onChange={(event) => void onAutoRepriceToggle(event.target.checked)}
                />
                Agent auto-reprice
              </label>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Discovery (TTL + Matching)</p>
              <p className="mt-1 text-2xl font-semibold text-shell-950">{discoveryInterests.length}</p>
              <p className="text-xs text-signal-slate">Active {activeDiscoveryCount} | Expired {expiredDiscoveryCount}</p>
              <div className="mt-3 space-y-2">
                {discoveryInterests.slice(0, 3).map((item) => {
                  const expiresAt = new Date(item.payload.expiresAt).getTime();
                  const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now();
                  return (
                    <div key={item.contractId} className="rounded-lg border border-shell-700 bg-shell-900/5 p-2">
                      <p className="text-sm font-semibold text-shell-950">{item.payload.instrument}</p>
                      <p className="text-xs text-signal-slate">
                        {sideTag(item.payload.side)} | by {aliasOf(item.payload.postingAgent)} | CID {shortId(item.contractId)}
                      </p>
                      <p className={`text-xs ${expired ? "text-signal-coral" : "text-signal-mint"}`}>
                        {expired ? "Expired" : "TTL active"}
                      </p>
                    </div>
                  );
                })}
                {discoveryInterests.length === 0 ? <p className="text-xs text-signal-slate">No visible DiscoveryInterest contracts.</p> : null}
              </div>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Negotiation + Commit-Reveal</p>
              <p className="mt-1 text-2xl font-semibold text-shell-950">{negotiations.length}</p>
              <p className="text-xs text-signal-slate">
                committed {negotiations.filter((n) => optionalText(n.payload.sellerCommitmentHash) && optionalText(n.payload.buyerCommitmentHash)).length}
                {" | "}
                revealed {negotiations.filter((n) => n.payload.sellerTermsRevealed && n.payload.buyerTermsRevealed).length}
              </p>
              <div className="mt-3 space-y-2">
                {negotiations.slice(0, 3).map((n) => (
                  <div key={n.contractId} className="rounded-lg border border-shell-700 bg-shell-900/5 p-2">
                    <p className="text-sm font-semibold text-shell-950">{n.payload.instrument}</p>
                    <p className="text-xs text-signal-slate">CID {shortId(n.contractId)} | issuer {n.payload.issuerApproved ? "approved" : "pending"}</p>
                    <p className="text-xs text-signal-slate">
                      seller {n.payload.sellerAccepted ? "ok" : "pending"} | buyer {n.payload.buyerAccepted ? "ok" : "pending"}
                    </p>
                    <p className="text-xs text-signal-slate">
                      commit {optionalText(n.payload.sellerCommitmentHash) && optionalText(n.payload.buyerCommitmentHash) ? "ready" : "pending"}
                      {" | "}
                      reveal {n.payload.sellerTermsRevealed && n.payload.buyerTermsRevealed ? "done" : "pending"}
                    </p>
                  </div>
                ))}
                {negotiations.length === 0 ? <p className="text-xs text-signal-slate">No active private negotiations.</p> : null}
              </div>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Compliance + Settlement</p>
              <p className="mt-1 text-2xl font-semibold text-shell-950">{pendingApprovals} pending approvals</p>
              <p className="text-xs text-signal-slate">{pendingSettlements} pending settlements</p>
              <div className="mt-3 space-y-2">
                {negotiations
                  .filter((item) => item.payload.sellerAccepted && item.payload.buyerAccepted && !item.payload.issuerApproved)
                  .slice(0, 2)
                  .map((item) => (
                    <div key={item.contractId} className="rounded-lg border border-shell-700 bg-shell-900/5 p-2">
                      <p className="text-sm font-semibold text-shell-950">Approve {item.payload.instrument}</p>
                      <p className="text-xs text-signal-slate">CID {shortId(item.contractId)}</p>
                      <button
                        className="mt-2 rounded-md bg-signal-amber px-2 py-1 text-xs font-semibold text-shell-950 disabled:opacity-50"
                        disabled={actionBusy}
                        onClick={() => void runConsoleAction(`ApproveMatch ${shortId(item.contractId)}`, () => onApproveMatch(companyParty, item.contractId))}
                      >
                        Approve Match
                      </button>
                    </div>
                  ))}
                {settlements.slice(0, 2).map((s) => (
                  <div key={s.contractId} className="rounded-lg border border-shell-700 bg-shell-900/5 p-2">
                    <p className="text-sm font-semibold text-shell-950">{s.payload.instrument}</p>
                    <p className="text-xs text-signal-slate">
                      Settled: {s.payload.settled ? "yes" : "no"} | Qty {Number(s.payload.quantity).toLocaleString()} | Px {Number(s.payload.unitPrice).toFixed(2)}
                    </p>
                  </div>
                ))}
                {pendingApprovals === 0 && pendingSettlements === 0 ? (
                  <p className="text-xs text-signal-slate">Compliance queue currently clear.</p>
                ) : null}
              </div>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Audit Trail</p>
              <p className="mt-1 text-2xl font-semibold text-shell-950">{auditRecords.length}</p>
              <div className="mt-3 space-y-2">
                {auditRecords.slice(0, 4).map((item) => (
                  <details key={item.contractId} className="rounded-lg border border-shell-700 bg-shell-900/5 p-2">
                    <summary className="cursor-pointer text-sm font-semibold text-shell-950">{item.payload.instrument} ({shortId(item.contractId)})</summary>
                    <p className="mt-1 text-xs text-signal-slate">
                      Qty {Number(item.payload.quantity).toLocaleString()} | Price {Number(item.payload.unitPrice).toFixed(2)} | Settled {new Date(item.payload.settledAt).toLocaleString()}
                    </p>
                  </details>
                ))}
                {auditRecords.length === 0 ? <p className="text-xs text-signal-slate">No audit records visible.</p> : null}
              </div>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Agent Intelligence + Logs</p>
              <p className="mt-1 text-2xl font-semibold text-shell-950">{decisionLogs.length} decision logs</p>
              <div className="mt-3 space-y-2">
                {decisionLogs.slice(0, 2).map((item) => (
                  <details key={item.contractId} className="rounded-lg border border-shell-700 bg-shell-900/5 p-2">
                    <summary className="cursor-pointer text-sm font-semibold text-shell-950">
                      {item.payload.decision.toUpperCase()} {item.payload.instrument} ({shortId(item.contractId)})
                    </summary>
                    <p className="mt-1 text-xs text-signal-slate">{item.payload.reasoning}</p>
                  </details>
                ))}
                {logs.slice(0, 3).map((entry) => (
                  <details key={entry.id} className="rounded-lg border border-shell-700 bg-shell-900/5 p-2">
                    <summary className="cursor-pointer text-xs font-semibold text-shell-950">
                      {entry.source} | {entry.decision}
                    </summary>
                    <p className="mt-1 text-xs text-signal-slate">{entry.metadata}</p>
                  </details>
                ))}
                {decisionLogs.length === 0 && logs.length === 0 ? <p className="text-xs text-signal-slate">No logs yet.</p> : null}
              </div>
              <button
                className="mt-3 rounded-md border border-shell-700 px-2 py-1 text-xs font-semibold text-signal-slate"
                onClick={clearLogs}
              >
                Clear local logs
              </button>
            </article>
          </div>
        </section>

        <section className="rounded-3xl border border-shell-700 bg-white/80 p-5 backdrop-blur-xl">
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
            <article className="rounded-xl border border-shell-700 bg-white p-4">
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

            <article className="rounded-xl border border-shell-700 bg-white p-4">
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

        <section className="rounded-3xl border border-shell-700 bg-white/80 p-5 backdrop-blur-xl">
          <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Cross-Party Visibility Matrix</p>
          <div className="mt-3">
            <PrivacyMatrixView
              availableParties={availableParties}
              activeParty={party}
              refreshToken={matrixRefreshToken}
            />
          </div>
        </section>

        <section className="rounded-3xl border border-shell-700 bg-white/80 p-5 backdrop-blur-xl">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Live Action Console</p>
              <h2 className="mt-1 text-2xl font-semibold text-shell-950">Manual Lifecycle Controls</h2>
            </div>
            <div className="text-sm text-signal-slate">
              {actionStatus ? <span className="text-signal-mint">Last action: {actionStatus}</span> : "Ready"}
              {actionError ? <span className="ml-2 text-signal-coral">{actionError}</span> : null}
            </div>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-3">
            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <h3 className="text-lg font-semibold text-shell-950">Trade Intent + Discovery</h3>
              <div className="mt-3 grid gap-3">
                <label className="text-xs text-signal-slate">
                  Actor
                  <select
                    className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                    value={orderActor}
                    onChange={(event) => setOrderActor(event.target.value)}
                  >
                    {availableParties.filter((entry) => aliasOf(entry) !== "Outsider").map((entry) => (
                      <option key={entry} value={entry}>{entry}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-signal-slate">
                  Instrument
                  <input
                    className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                    value={instrument}
                    onChange={(event) => setInstrument(event.target.value)}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-signal-slate">
                    Quantity
                    <input
                      type="number"
                      min="1"
                      step="1"
                      className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                      value={quantity}
                      onChange={(event) => setQuantity(event.target.value)}
                    />
                  </label>
                  <label className="text-xs text-signal-slate">
                    Min Price
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                      value={minPrice}
                      onChange={(event) => setMinPrice(event.target.value)}
                    />
                  </label>
                </div>
                <button
                  className="rounded-md bg-signal-mint px-3 py-2 text-sm font-semibold text-shell-950 disabled:opacity-50"
                  disabled={actionBusy}
                  onClick={() => void executeCreateTradeIntent()}
                >
                  Create TradeIntent
                </button>

                <hr className="border-shell-700" />

                <label className="text-xs text-signal-slate">
                  Discovery Actor
                  <select
                    className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                    value={discoveryActor}
                    onChange={(event) => setDiscoveryActor(event.target.value)}
                  >
                    {availableParties.filter((entry) => aliasOf(entry) !== "Outsider").map((entry) => (
                      <option key={entry} value={entry}>{entry}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-signal-slate">
                  Discovery Owner
                  <select
                    className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                    value={discoveryOwner}
                    onChange={(event) => setDiscoveryOwner(event.target.value)}
                  >
                    {availableParties.filter((entry) => aliasOf(entry) !== "Outsider").map((entry) => (
                      <option key={entry} value={entry}>{entry}</option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-signal-slate">
                    Side
                    <select
                      className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                      value={discoverySide}
                      onChange={(event) => setDiscoverySide(event.target.value as "Buy" | "Sell")}
                    >
                      <option value="Sell">Sell</option>
                      <option value="Buy">Buy</option>
                    </select>
                  </label>
                  <label className="text-xs text-signal-slate">
                    Strategy Tag
                    <input
                      className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                      value={strategyTag}
                      onChange={(event) => setStrategyTag(event.target.value)}
                    />
                  </label>
                </div>
                <label className="text-xs text-signal-slate">
                  Discoverable By (CSV)
                  <input
                    className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                    value={discoverableByCsv}
                    onChange={(event) => setDiscoverableByCsv(event.target.value)}
                  />
                </label>
                <button
                  className="rounded-md bg-signal-amber px-3 py-2 text-sm font-semibold text-shell-950 disabled:opacity-50"
                  disabled={actionBusy}
                  onClick={() => void executeCreateDiscoveryInterest()}
                >
                  Post DiscoveryInterest
                </button>
              </div>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <h3 className="text-lg font-semibold text-shell-950">Negotiation Controls</h3>
              <div className="mt-3 grid gap-3">
                <label className="text-xs text-signal-slate">
                  Actor
                  <select
                    className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                    value={negotiationActor}
                    onChange={(event) => setNegotiationActor(event.target.value)}
                  >
                    {availableParties.filter((entry) => aliasOf(entry) !== "Outsider").map((entry) => (
                      <option key={entry} value={entry}>{entry}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-signal-slate">
                  Choice
                  <select
                    className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                    value={negotiationChoice}
                    onChange={(event) => setNegotiationChoice(event.target.value as NegotiationChoice)}
                  >
                    <option value="SubmitSellerTerms">SubmitSellerTerms</option>
                    <option value="SubmitBuyerTerms">SubmitBuyerTerms</option>
                    <option value="AcceptBySeller">AcceptBySeller</option>
                    <option value="AcceptByBuyer">AcceptByBuyer</option>
                    <option value="CommitTerms">CommitTerms</option>
                    <option value="RevealTerms">RevealTerms</option>
                    <option value="ApproveMatch">ApproveMatch</option>
                    <option value="StartSettlement">StartSettlement</option>
                  </select>
                </label>
                <label className="text-xs text-signal-slate">
                  Negotiation CID
                  <input
                    list="negotiation-cids"
                    className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                    value={negotiationCid}
                    onChange={(event) => setNegotiationCid(event.target.value)}
                  />
                  <datalist id="negotiation-cids">
                    {negotiations.map((item) => (
                      <option key={item.contractId} value={item.contractId} />
                    ))}
                  </datalist>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-signal-slate">
                    Qty
                    <input
                      type="number"
                      step="1"
                      min="1"
                      className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                      value={negotiationQty}
                      onChange={(event) => setNegotiationQty(event.target.value)}
                    />
                  </label>
                  <label className="text-xs text-signal-slate">
                    Unit Price
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                      value={negotiationPrice}
                      onChange={(event) => setNegotiationPrice(event.target.value)}
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-signal-slate">
                    Side
                    <select
                      className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                      value={negotiationSide}
                      onChange={(event) => setNegotiationSide(event.target.value as "Buy" | "Sell")}
                    >
                      <option value="Sell">Sell</option>
                      <option value="Buy">Buy</option>
                    </select>
                  </label>
                  <label className="text-xs text-signal-slate">
                    Salt
                    <input
                      className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                      value={negotiationSalt}
                      onChange={(event) => setNegotiationSalt(event.target.value)}
                    />
                  </label>
                </div>
                <button
                  className="rounded-md bg-shell-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={actionBusy}
                  onClick={() => void executeNegotiationChoice()}
                >
                  Execute Negotiation Choice
                </button>
              </div>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <h3 className="text-lg font-semibold text-shell-950">Settlement + Proof Ops</h3>
              <div className="mt-3 grid gap-3">
                <label className="text-xs text-signal-slate">
                  Settlement Actor
                  <select
                    className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                    value={settlementActor}
                    onChange={(event) => setSettlementActor(event.target.value)}
                  >
                    {availableParties.filter((entry) => aliasOf(entry) !== "Outsider").map((entry) => (
                      <option key={entry} value={entry}>{entry}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-signal-slate">
                  Choice
                  <select
                    className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                    value={settlementChoice}
                    onChange={(event) => setSettlementChoice(event.target.value as SettlementChoice)}
                  >
                    <option value="SimpleFinalizeSettlement">SimpleFinalizeSettlement</option>
                    <option value="FinalizeSettlement">FinalizeSettlement</option>
                  </select>
                </label>
                <label className="text-xs text-signal-slate">
                  Settlement CID
                  <input
                    list="settlement-cids"
                    className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                    value={settlementCid}
                    onChange={(event) => setSettlementCid(event.target.value)}
                  />
                  <datalist id="settlement-cids">
                    {settlements.map((item) => (
                      <option key={item.contractId} value={item.contractId} />
                    ))}
                  </datalist>
                </label>
                <label className="text-xs text-signal-slate">
                  Seller Asset CID
                  <input
                    list="asset-cids"
                    className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                    value={sellerAssetCid}
                    onChange={(event) => setSellerAssetCid(event.target.value)}
                  />
                  <datalist id="asset-cids">
                    {assetHoldings.map((item) => (
                      <option key={item.contractId} value={item.contractId} />
                    ))}
                  </datalist>
                </label>
                <label className="text-xs text-signal-slate">
                  Buyer Cash CID
                  <input
                    list="cash-cids"
                    className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                    value={buyerCashCid}
                    onChange={(event) => setBuyerCashCid(event.target.value)}
                  />
                  <datalist id="cash-cids">
                    {cashHoldings.map((item) => (
                      <option key={item.contractId} value={item.contractId} />
                    ))}
                  </datalist>
                </label>
                <button
                  className="rounded-md bg-signal-coral px-3 py-2 text-sm font-semibold text-shell-950 disabled:opacity-50"
                  disabled={actionBusy}
                  onClick={() => void executeSettlementChoice()}
                >
                  Execute Settlement Choice
                </button>

                <hr className="border-shell-700" />

                <div className="rounded-lg border border-shell-700 bg-shell-900/5 p-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-signal-slate">Outsider Proof Snapshot</p>
                  <p className={`mt-1 text-lg font-semibold ${outsiderVisibilityTotal === 0 ? "text-signal-mint" : "text-signal-coral"}`}>
                    Visibility Count: {outsiderVisibilityTotal}
                  </p>
                  <p className="text-xs text-signal-slate">
                    Last probe: {outsiderSnapshot.updatedAt ? new Date(outsiderSnapshot.updatedAt).toLocaleTimeString() : "pending"}
                  </p>
                  {redTeamAttempts.length > 0 ? (
                    <p className="mt-1 text-xs text-signal-slate">Latest: {redTeamAttempts[0].message}</p>
                  ) : null}
                </div>
              </div>
            </article>
          </div>
        </section>

        {error ? (
          <div className="rounded-xl border border-signal-coral/40 bg-signal-coral/10 p-3 text-sm text-signal-coral">
            {error}
          </div>
        ) : null}

        <section className="rounded-3xl border border-shell-700 bg-white/80 p-5 backdrop-blur-xl">
          <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Demo Story Cue</p>
          <p className="mt-2 text-sm text-signal-slate">
            {leakPreview
              ? `Legacy leak model exposes ${leakPreview.instrument}, size ${Math.round(leakPreview.quantity).toLocaleString()}, and price floor ${leakPreview.minPrice.toFixed(2)}. Canton keeps outsider visibility at ${outsiderVisibilityTotal}.`
              : "Create a TradeIntent to populate a live leak-vs-privacy narrative cue."}
          </p>
        </section>
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
