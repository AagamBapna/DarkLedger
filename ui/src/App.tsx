import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MatchFoundToast } from "./components/MatchFoundToast";
import { usePartyContext } from "./context/PartyContext";
import {
  TEMPLATE_IDS,
  exerciseChoice,
  getMarketApiStatus,
  queryAssetHoldings,
  queryAuditRecords,
  queryCashHoldings,
  queryDiscoveryInterests,
  queryPrivateNegotiations,
  queryTradeIntents,
  queryTradeSettlements,
  setAgentAutoReprice,
} from "./lib/ledgerClient";
import type {
  AssetHoldingPayload,
  CashHoldingPayload,
  ContractRecord,
  DiscoveryInterestPayload,
  PrivateNegotiationPayload,
  TradeAuditRecordPayload,
  TradeIntentPayload,
  TradeSettlementPayload,
} from "./types/contracts";
import { AgentLogsView } from "./views/AgentLogsView";
import { ComplianceView } from "./views/ComplianceView";
import { FlowView } from "./views/FlowView";
import { MarketView } from "./views/MarketView";
import { OwnerView } from "./views/OwnerView";
import { PrivacyMatrixView } from "./views/PrivacyMatrixView";

type ViewKey = "owner" | "flow" | "market" | "compliance" | "privacy" | "logs";
type ShockTemplate = "tradeIntent" | "privateNegotiation" | "tradeSettlement";

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
  if (alias === "Seller" || alias === "SellerAgent") {
    return "seller";
  }
  if (alias === "Buyer" || alias === "BuyerAgent") {
    return "buyer";
  }
  return null;
}

function errorMessageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function isJsonApiListLimitError(message: string): boolean {
  return message.includes("JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED");
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

  const [activeView, setActiveView] = useState<ViewKey>("owner");
  const [tradeIntents, setTradeIntents] = useState<Array<ContractRecord<TradeIntentPayload>>>([]);
  const [discoveryInterests, setDiscoveryInterests] = useState<Array<ContractRecord<DiscoveryInterestPayload>>>([]);
  const [negotiations, setNegotiations] = useState<Array<ContractRecord<PrivateNegotiationPayload>>>([]);
  const [settlements, setSettlements] = useState<Array<ContractRecord<TradeSettlementPayload>>>([]);
  const [auditRecords, setAuditRecords] = useState<Array<ContractRecord<TradeAuditRecordPayload>>>([]);
  const [assetHoldings, setAssetHoldings] = useState<Array<ContractRecord<AssetHoldingPayload>>>([]);
  const [cashHoldings, setCashHoldings] = useState<Array<ContractRecord<CashHoldingPayload>>>([]);
  const [intentLastUpdate, setIntentLastUpdate] = useState<Record<string, string>>({});
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

  const priorIntentIds = useRef<Set<string>>(new Set());
  const priorNegotiationIds = useRef<Set<string>>(new Set());
  const priorSettlementIds = useRef<Set<string>>(new Set());
  const discoveryOverflowLogged = useRef(false);

  const sellerParty = useMemo(
    () => resolveAlias(availableParties, "Seller"),
    [availableParties],
  );
  const outsiderParty = useMemo(
    () => resolveAlias(availableParties, "Outsider"),
    [availableParties],
  );

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

  const refreshVisibilityShock = useCallback(async () => {
    setShockLoading(true);
    try {
      const [sellerRows, outsiderRows] = await Promise.all([
        queryContractsForTemplate(shockTemplate, sellerParty),
        queryContractsForTemplate(shockTemplate, outsiderParty),
      ]);

      const availableSellerContractIds = sellerRows.map((contract) => contract.contractId);
      const nextContractId =
        shockContractId && availableSellerContractIds.includes(shockContractId)
          ? shockContractId
          : availableSellerContractIds[0] ?? "";

      if (nextContractId !== shockContractId) {
        setShockContractId(nextContractId);
      }

      const sellerVisible = nextContractId
        ? sellerRows.some((contract) => contract.contractId === nextContractId)
        : false;
      const outsiderVisible = nextContractId
        ? outsiderRows.some((contract) => contract.contractId === nextContractId)
        : false;

      setVisibilityShock({
        template: shockTemplate,
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

  const refreshLedgerData = useCallback(async () => {
    try {
      const [
        tradeIntentsResult,
        discoveryResult,
        negotiationsResult,
        settlementsResult,
        auditsResult,
        assetsResult,
        cashResult,
      ] = await Promise.allSettled([
        queryTradeIntents(party),
        queryDiscoveryInterests(party),
        queryPrivateNegotiations(party),
        queryTradeSettlements(party),
        queryAuditRecords(party),
        queryAssetHoldings(party),
        queryCashHoldings(party),
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
              metadata: `cid=${contractId} party=${party}`,
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
              counterparty: counterpartyPseudonym(party, negotiation.payload),
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
  }, [party, addLog, refreshOutsiderSnapshot, refreshVisibilityShock]);

  useEffect(() => {
    setLoading(true);
    void refreshLedgerData();
    const timer = window.setInterval(() => {
      void refreshLedgerData();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [refreshLedgerData]);

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
        await refreshLedgerData();
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
    async (contractId: string) => {
      try {
        await exerciseChoice(party, TEMPLATE_IDS.privateNegotiation, contractId, "ApproveMatch", {});
        addLog({
          source: "ui-action",
          decision: "ApproveMatch submitted",
          metadata: `cid=${contractId}`,
        });
        await refreshLedgerData();
      } catch (err) {
        const message = err instanceof Error ? err.message : "ApproveMatch failed";
        addLog({
          source: "ui-action",
          decision: "ApproveMatch failed",
          metadata: `cid=${contractId} error=${message}`,
        });
        setError(message);
      }
    },
    [party, addLog, refreshLedgerData],
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
            ? "Try to spy => 0 records (private-denied across all templates)."
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
      setRedTeamAttempts((prev) => [
        failureAttempt,
        ...prev,
      ].slice(0, 8));
      addLog({
        source: "ui-action",
        decision: "Red-team probe failed",
        metadata: message,
      });
    } finally {
      setSpyRunning(false);
    }
  }, [addLog, outsiderParty, spyRunning]);

  const navItems: Array<{ key: ViewKey; label: string }> = useMemo(
    () => [
      { key: "owner", label: "Owner View" },
      { key: "flow", label: "Live Flow View" },
      { key: "market", label: "Market View" },
      { key: "compliance", label: "Compliance View" },
      { key: "privacy", label: "Privacy Matrix View" },
      { key: "logs", label: "Agent Logs View" },
    ],
    [],
  );

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

  const expiredDiscoveryCount = discoveryInterests.filter((item) => {
    const expiresAt = new Date(item.payload.expiresAt).getTime();
    return Number.isFinite(expiresAt) && expiresAt <= Date.now();
  }).length;

  const shockTemplateLabel =
    shockTemplate === "tradeIntent"
      ? "TradeIntent"
      : shockTemplate === "privateNegotiation"
        ? "PrivateNegotiation"
        : "TradeSettlement";

  const shockDisappears = visibilityShock
    ? visibilityShock.sellerVisible && !visibilityShock.outsiderVisible
    : false;

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#eef1f8] via-[#f8f9fd] to-[#edf1fb] px-4 py-6 text-shell-950 md:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 rounded-2xl border border-shell-700 bg-white/70 p-4 shadow-[0_12px_44px_rgba(36,56,99,0.08)] backdrop-blur-xl">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-signal-slate">Agentic Shadow-Cap</p>
              <h1 className="mt-1 text-2xl font-semibold text-shell-950">Dark Pool Privacy Theater</h1>
              <p className="mt-1 text-sm text-signal-slate">
                Participant endpoint: {participantLabelFor(party, networkMode)}
              </p>
            </div>
            <div className="flex flex-col gap-2 md:items-end">
              <label className="text-sm text-signal-slate">
                Party
                <select
                  className="ml-2 rounded-md border border-shell-700 bg-white px-2 py-1 text-shell-950"
                  value={party}
                  onChange={(event) => setParty(event.target.value)}
                >
                  {availableParties.map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs">
                Connectivity:{" "}
                <span className={error ? "text-signal-coral" : "text-signal-mint"}>
                  {error ? "degraded" : "connected"}
                </span>
              </p>
              <p className="text-xs">
                Market API:{" "}
                <span className={marketApiOnline ? "text-signal-mint" : "text-signal-slate"}>
                  {marketApiOnline ? "online" : "offline"}
                </span>
              </p>
            </div>
          </div>
          <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {availableParties.map((entry) => {
              const active = party === entry;
              return (
                <button
                  key={entry}
                  className={`whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition ${
                    active
                      ? "border-shell-950 bg-shell-950 text-white"
                      : "border-shell-700 bg-white text-signal-slate hover:border-shell-600"
                  }`}
                  onClick={() => setParty(entry)}
                >
                  {aliasOf(entry)}
                </button>
              );
            })}
          </div>
        </header>

        <section className="mb-4 grid gap-3 md:grid-cols-4">
          <article className="rounded-xl border border-shell-700 bg-white/80 p-3">
            <p className="text-xs uppercase tracking-[0.15em] text-signal-slate">Outsider Visibility</p>
            <p className={`mt-2 text-xl font-semibold ${outsiderVisibilityTotal === 0 ? "text-signal-mint" : "text-signal-coral"}`}>
              {outsiderVisibilityTotal}
            </p>
            <p className="text-xs text-signal-slate">{outsiderVisibilityTotal === 0 ? "Invariant holds" : "Investigate immediately"}</p>
          </article>
          <article className="rounded-xl border border-shell-700 bg-white/80 p-3">
            <p className="text-xs uppercase tracking-[0.15em] text-signal-slate">Replay Attack</p>
            <p className={`mt-2 text-xl font-semibold ${replayAttackBlocked ? "text-signal-mint" : "text-signal-coral"}`}>
              {replayAttackBlocked ? "Blocked" : "Risk"}
            </p>
            <p className="text-xs text-signal-slate">Commit-reveal + single-use choices</p>
          </article>
          <article className="rounded-xl border border-shell-700 bg-white/80 p-3">
            <p className="text-xs uppercase tracking-[0.15em] text-signal-slate">Expired Discovery</p>
            <p className={`mt-2 text-xl font-semibold ${expiredDiscoveryCount === 0 ? "text-signal-mint" : "text-signal-amber"}`}>
              {expiredDiscoveryCount === 0 ? "Auto-cleaned" : `${expiredDiscoveryCount} pending`}
            </p>
            <p className="text-xs text-signal-slate">Visible from current party scope</p>
          </article>
          <article className="rounded-xl border border-shell-700 bg-white/80 p-3">
            <p className="text-xs uppercase tracking-[0.15em] text-signal-slate">Visibility Shock</p>
            <p className={`mt-2 text-xl font-semibold ${shockDisappears ? "text-signal-mint" : "text-signal-amber"}`}>
              {shockDisappears ? "Seller -> Outsider = vanish" : "Awaiting contract"}
            </p>
            <p className="text-xs text-signal-slate">
              {visibilityShock?.checkedAt ? `Checked ${new Date(visibilityShock.checkedAt).toLocaleTimeString()}` : "Pending check"}
            </p>
          </article>
        </section>

        <section className="mb-4 rounded-xl border border-shell-700 bg-white/70 p-4 backdrop-blur-xl">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-signal-slate">Live Visibility Shock Switch</p>
              <h2 className="mt-1 text-lg font-semibold text-shell-950">Same Contract ID, Two Perspectives</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-signal-slate">
              <span className="rounded-full bg-signal-mint/15 px-2 py-1 text-signal-mint">Seller view</span>
              <span className="rounded-full bg-signal-coral/15 px-2 py-1 text-signal-coral">Outsider view</span>
            </div>
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
              Contract ID from Seller perspective
              <input
                list="shock-contract-ids"
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                value={shockContractId}
                onChange={(event) => setShockContractId(event.target.value)}
                placeholder="Select or paste contract ID"
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
              {shockLoading ? "Checking..." : "Refresh proof"}
            </button>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <article className="rounded-lg border border-shell-700 bg-white/80 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Seller</p>
              <p className={`mt-1 text-sm font-semibold ${visibilityShock?.sellerVisible ? "text-signal-mint" : "text-signal-coral"}`}>
                {visibilityShock?.sellerVisible ? `Sees ${shockTemplateLabel} ${visibilityShock.contractId.slice(0, 22)}...` : "No matching contract visible"}
              </p>
              <p className="mt-1 text-xs text-signal-slate">Total visible contracts: {visibilityShock?.sellerCount ?? 0}</p>
              <button
                className="mt-2 rounded-md border border-shell-700 px-3 py-1.5 text-xs font-semibold text-signal-slate"
                onClick={() => setParty(sellerParty)}
              >
                Flip to Seller
              </button>
            </article>
            <article className="rounded-lg border border-shell-700 bg-white/80 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-signal-slate">Outsider</p>
              <p className={`mt-1 text-sm font-semibold ${visibilityShock?.outsiderVisible ? "text-signal-coral" : "text-signal-mint"}`}>
                {visibilityShock?.outsiderVisible ? "Unexpected: contract is visible" : "Instant disappearance confirmed"}
              </p>
              <p className="mt-1 text-xs text-signal-slate">Total visible contracts: {visibilityShock?.outsiderCount ?? 0}</p>
              <button
                className="mt-2 rounded-md border border-shell-700 px-3 py-1.5 text-xs font-semibold text-signal-slate"
                onClick={() => setParty(outsiderParty)}
              >
                Flip to Outsider
              </button>
            </article>
          </div>
        </section>

        <section className="mb-4 grid gap-4 md:grid-cols-2">
          <article className="rounded-xl border border-shell-700 bg-white/75 p-4 backdrop-blur-xl">
            <p className="text-xs uppercase tracking-[0.2em] text-signal-coral">Before (Mock Public Order Book)</p>
            <h3 className="mt-2 text-lg font-semibold text-shell-950">Leak-heavy world</h3>
            {leakPreview ? (
              <ul className="mt-2 space-y-1 text-sm text-signal-slate">
                <li>Instrument leaked: {leakPreview.instrument}</li>
                <li>Size leaked: {Math.round(leakPreview.quantity).toLocaleString()} units</li>
                <li>Price floor leaked: ${leakPreview.minPrice.toFixed(2)}</li>
                <li>Counterparties leaked: {leakPreview.sellerAlias} vs {leakPreview.buyerAlias}</li>
              </ul>
            ) : (
              <p className="mt-2 text-sm text-signal-slate">No insider sample loaded yet.</p>
            )}
          </article>
          <article className="rounded-xl border border-shell-700 bg-white/75 p-4 backdrop-blur-xl">
            <p className="text-xs uppercase tracking-[0.2em] text-signal-mint">After (Canton Private Flow)</p>
            <h3 className="mt-2 text-lg font-semibold text-shell-950">Privacy-first execution</h3>
            <ul className="mt-2 space-y-1 text-sm text-signal-slate">
              <li>Outsider TradeIntents: {outsiderSnapshot.tradeIntents}</li>
              <li>Outsider Negotiations: {outsiderSnapshot.negotiations}</li>
              <li>Outsider Settlements: {outsiderSnapshot.settlements}</li>
              <li className={outsiderVisibilityTotal === 0 ? "text-signal-mint" : "text-signal-coral"}>
                Total outsider visibility: {outsiderVisibilityTotal}
              </li>
            </ul>
            <p className="mt-2 text-xs text-signal-slate">
              Last probe: {outsiderSnapshot.updatedAt ? new Date(outsiderSnapshot.updatedAt).toLocaleTimeString() : "pending"}
            </p>
          </article>
        </section>

        <nav className="mb-4 flex flex-wrap gap-2">
          {navItems.map((item) => (
            <button
              key={item.key}
              className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                item.key === activeView
                  ? "bg-shell-950 text-white"
                  : "border border-shell-700 bg-white/60 text-signal-slate backdrop-blur-xl hover:border-shell-600"
              }`}
              onClick={() => setActiveView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {loading && aliasOf(party) !== "Outsider" ? (
          <p className="text-sm text-signal-slate">Loading private ledger view...</p>
        ) : null}
        {error ? (
          <div className="mb-4 rounded-lg border border-signal-coral/40 bg-signal-coral/10 p-3 text-sm text-signal-coral">
            {error}
          </div>
        ) : null}

        {aliasOf(party) === "Outsider" ? (
          <section className="space-y-4">
            <div className="rounded-2xl border border-shell-700 bg-white/75 p-5 text-center backdrop-blur-xl">
              <p className="text-xs uppercase tracking-[0.24em] text-signal-slate">Outsider Perspective</p>
              <h2 className="mt-2 text-3xl font-semibold text-shell-950">Live Visibility Proof</h2>
              <p className="mx-auto mt-2 max-w-xl text-sm text-signal-slate">
                This party runs real ledger queries with no stake in private contracts.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                {[
                  { label: "Trade Intents", value: String(tradeIntents.length) },
                  { label: "Negotiations", value: String(negotiations.length) },
                  { label: "Settlements", value: String(settlements.length) },
                  { label: "Holdings", value: String(assetHoldings.length + cashHoldings.length) },
                ].map((card) => (
                  <article key={card.label} className="rounded-xl border border-shell-700 bg-white/90 p-3">
                    <p className="text-xs uppercase tracking-[0.15em] text-signal-slate">{card.label}</p>
                    <p className="mt-2 text-3xl font-semibold text-signal-slate">{card.value}</p>
                  </article>
                ))}
              </div>
              <div className="mt-4 rounded-xl border border-shell-700 bg-shell-900/5 p-4 text-left">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-signal-slate">Red-Team Panel</p>
                    <p className="mt-1 text-sm text-signal-slate">
                      Try to spy as Outsider. Expected result is always private-denied.
                    </p>
                  </div>
                  <button
                    className="rounded-md bg-signal-coral px-4 py-2 text-sm font-semibold text-shell-950 disabled:opacity-50"
                    disabled={spyRunning}
                    onClick={() => void runRedTeamProbe()}
                  >
                    {spyRunning ? "Probing..." : "Try to spy"}
                  </button>
                </div>
                {redTeamAttempts.length > 0 ? (
                  <ul className="mt-3 space-y-2 text-xs">
                    {redTeamAttempts.map((entry) => (
                      <li key={entry.id} className="rounded-md border border-shell-700 bg-white/80 p-2">
                        <p className="font-semibold text-shell-950">{entry.result}</p>
                        <p className="text-signal-slate">{entry.message}</p>
                        <p className="text-signal-slate/80">{new Date(entry.at).toLocaleTimeString()}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-xs text-signal-slate">No probe run yet.</p>
                )}
              </div>
            </div>
          </section>
        ) : null}

        {aliasOf(party) !== "Outsider" && activeView === "owner" ? (
          <OwnerView
            party={party}
            tradeIntents={tradeIntents}
            negotiations={negotiations}
            assetHoldings={assetHoldings}
            cashHoldings={cashHoldings}
            logs={logs}
            autoReprice={autoReprice}
            onAutoRepriceToggle={onAutoRepriceToggle}
            onOverrideMinPrice={onOverrideMinPrice}
            intentLastUpdate={intentLastUpdate}
          />
        ) : null}

        {aliasOf(party) !== "Outsider" && activeView === "flow" ? (
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
            onSwitchParty={setParty}
            onRefresh={refreshLedgerData}
            onLog={addLog}
          />
        ) : null}

        {aliasOf(party) !== "Outsider" && activeView === "market" ? (
          <MarketView
            party={party}
            negotiations={negotiations}
            onOpenChannel={() => setActiveView("owner")}
          />
        ) : null}

        {aliasOf(party) !== "Outsider" && activeView === "compliance" ? (
          <ComplianceView
            party={party}
            negotiations={negotiations}
            settlements={settlements}
            assetHoldings={assetHoldings}
            cashHoldings={cashHoldings}
            onApproveMatch={onApproveMatch}
          />
        ) : null}

        {aliasOf(party) !== "Outsider" && activeView === "privacy" ? (
          <PrivacyMatrixView
            availableParties={availableParties}
            activeParty={party}
            refreshToken={logs.length}
          />
        ) : null}

        {aliasOf(party) !== "Outsider" && activeView === "logs" ? (
          <AgentLogsView party={party} logs={logs} onClear={clearLogs} />
        ) : null}
      </div>

      {matchToast ? (
        <MatchFoundToast
          instrument={matchToast.instrument}
          counterparty={matchToast.counterparty}
          onOpenChannel={() => {
            setActiveView("owner");
            setMatchToast(null);
          }}
          onDismiss={() => setMatchToast(null)}
        />
      ) : null}
    </main>
  );
}
