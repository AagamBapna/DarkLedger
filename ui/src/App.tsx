import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MatchFoundToast } from "./components/MatchFoundToast";
import { usePartyContext } from "./context/PartyContext";
import {
  TEMPLATE_IDS,
  exerciseChoice,
  getMarketApiStatus,
  queryAssetHoldings,
  queryCashHoldings,
  queryPrivateNegotiations,
  setAgentAutoReprice,
  queryTradeIntents,
  queryTradeSettlements
} from "./lib/ledgerClient";
import type {
  AssetHoldingPayload,
  CashHoldingPayload,
  ContractRecord,
  PrivateNegotiationPayload,
  TradeIntentPayload,
  TradeSettlementPayload
} from "./types/contracts";
import { AgentLogsView } from "./views/AgentLogsView";
import { ComplianceView } from "./views/ComplianceView";
import { MarketView } from "./views/MarketView";
import { OwnerView } from "./views/OwnerView";

type ViewKey = "owner" | "market" | "compliance" | "logs";

interface MatchToastState {
  instrument: string;
  counterparty: string;
}

const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS ?? "3000");

const JSON_API_URL = import.meta.env.VITE_JSON_API_URL ?? "http://localhost:7575";

function participantLabelFor(party: string, networkMode: string): string {
  if (party === "Public") return "none (unauthorized)";
  if (networkMode === "local") {
    if (party === "Seller" || party === "SellerAgent") return "seller-node:5011";
    if (party === "Buyer" || party === "BuyerAgent") return "buyer-node:5021";
    return "issuer-node:5031";
  }
  // For devnet/testnet/mainnet, show the gateway URL
  try {
    const url = new URL(JSON_API_URL);
    return `${url.host} (${networkMode})`;
  } catch {
    return `gateway (${networkMode})`;
  }
}

function counterpartyPseudonym(
  party: string,
  payload: PrivateNegotiationPayload
): string {
  if (party === "Seller" || party === "SellerAgent") {
    return `Buyer-${payload.buyer.slice(0, 6)}`;
  }
  if (party === "Buyer" || party === "BuyerAgent") {
    return `Seller-${payload.seller.slice(0, 6)}`;
  }
  return `Pair-${payload.instrument.slice(0, 6)}`;
}

function agentRoleForParty(party: string): "seller" | "buyer" | null {
  if (party === "Seller" || party === "SellerAgent") {
    return "seller";
  }
  if (party === "Buyer" || party === "BuyerAgent") {
    return "buyer";
  }
  return null;
}

export default function App() {
  const { party, setParty, autoReprice, setAutoReprice, logs, addLog, clearLogs, availableParties, networkMode } = usePartyContext();

  const [activeView, setActiveView] = useState<ViewKey>("owner");
  const [tradeIntents, setTradeIntents] = useState<Array<ContractRecord<TradeIntentPayload>>>([]);
  const [negotiations, setNegotiations] = useState<Array<ContractRecord<PrivateNegotiationPayload>>>(
    []
  );
  const [settlements, setSettlements] = useState<Array<ContractRecord<TradeSettlementPayload>>>([]);
  const [assetHoldings, setAssetHoldings] = useState<Array<ContractRecord<AssetHoldingPayload>>>([]);
  const [cashHoldings, setCashHoldings] = useState<Array<ContractRecord<CashHoldingPayload>>>([]);
  const [intentLastUpdate, setIntentLastUpdate] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [matchToast, setMatchToast] = useState<MatchToastState | null>(null);
  const [marketApiOnline, setMarketApiOnline] = useState(false);

  const priorIntentIds = useRef<Set<string>>(new Set());
  const priorNegotiationIds = useRef<Set<string>>(new Set());
  const priorSettlementIds = useRef<Set<string>>(new Set());

  const refreshLedgerData = useCallback(async () => {
    if (party === "Public") {
      setTradeIntents([]);
      setNegotiations([]);
      setSettlements([]);
      setAssetHoldings([]);
      setCashHoldings([]);
      setError(null);
      setLoading(false);
      return;
    }
    try {
      const [nextTradeIntents, nextNegotiations, nextSettlements, nextAssets, nextCash] = await Promise.all([
        queryTradeIntents(party),
        queryPrivateNegotiations(party),
        queryTradeSettlements(party),
        queryAssetHoldings(party),
        queryCashHoldings(party),
      ]);

      setTradeIntents(nextTradeIntents);
      setNegotiations(nextNegotiations);
      setSettlements(nextSettlements);
      setAssetHoldings(nextAssets);
      setCashHoldings(nextCash);
      setError(null);

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
            metadata: `cid=${contractId} party=${party}`
          });
        }
      }
      priorIntentIds.current = nextIntentIds;

      const nextNegotiationIds = new Set(nextNegotiations.map((contract) => contract.contractId));
      for (const negotiation of nextNegotiations) {
        if (!priorNegotiationIds.current.has(negotiation.contractId)) {
          addLog({
            source: "ledger-event",
            decision: "PrivateNegotiation created",
            metadata: `cid=${negotiation.contractId} instrument=${negotiation.payload.instrument}`
          });
          setMatchToast({
            instrument: negotiation.payload.instrument,
            counterparty: counterpartyPseudonym(party, negotiation.payload)
          });
        }
      }
      priorNegotiationIds.current = nextNegotiationIds;

      const nextSettlementIds = new Set(nextSettlements.map((contract) => contract.contractId));
      for (const contractId of nextSettlementIds) {
        if (!priorSettlementIds.current.has(contractId)) {
          addLog({
            source: "ledger-event",
            decision: "TradeSettlement created",
            metadata: `cid=${contractId}`
          });
        }
      }
      priorSettlementIds.current = nextSettlementIds;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown ledger error";
      setError(message);
      addLog({
        source: "ui-action",
        decision: "Ledger refresh failed",
        metadata: message
      });
    } finally {
      setLoading(false);
    }
  }, [party, addLog]);

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
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [party, setAutoReprice]);

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
    [party, setAutoReprice, addLog]
  );

  const onOverrideMinPrice = useCallback(
    async (contractId: string, nextMinPrice: number) => {
      if (!Number.isFinite(nextMinPrice) || nextMinPrice <= 0) {
        addLog({
          source: "ui-action",
          decision: "Manual override rejected",
          metadata: `invalid minPrice=${nextMinPrice}`
        });
        return;
      }
      try {
        await exerciseChoice(party, TEMPLATE_IDS.tradeIntent, contractId, "UpdatePrice", {
          newMinPrice: nextMinPrice.toFixed(2)
        });
        addLog({
          source: "ui-action",
          decision: "Manual minPrice override submitted",
          metadata: `cid=${contractId} minPrice=${nextMinPrice.toFixed(2)}`
        });
        await refreshLedgerData();
      } catch (err) {
        const message = err instanceof Error ? err.message : "UpdatePrice failed";
        addLog({
          source: "ui-action",
          decision: "Manual override failed",
          metadata: `cid=${contractId} error=${message}`
        });
        setError(message);
      }
    },
    [party, addLog, refreshLedgerData]
  );

  const onApproveMatch = useCallback(
    async (contractId: string) => {
      try {
        await exerciseChoice(party, TEMPLATE_IDS.privateNegotiation, contractId, "ApproveMatch", {});
        addLog({
          source: "ui-action",
          decision: "ApproveMatch submitted",
          metadata: `cid=${contractId}`
        });
        await refreshLedgerData();
      } catch (err) {
        const message = err instanceof Error ? err.message : "ApproveMatch failed";
        addLog({
          source: "ui-action",
          decision: "ApproveMatch failed",
          metadata: `cid=${contractId} error=${message}`
        });
        setError(message);
      }
    },
    [party, addLog, refreshLedgerData]
  );

  const navItems: Array<{ key: ViewKey; label: string }> = useMemo(
    () => [
      { key: "owner", label: "Owner View" },
      { key: "market", label: "Market View" },
      { key: "compliance", label: "Compliance View" },
      { key: "logs", label: "Agent Logs View" }
    ],
    []
  );

  return (
    <main className="min-h-screen bg-gradient-to-br from-shell-950 via-shell-900 to-shell-800 px-4 py-6 text-white md:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 rounded-2xl border border-shell-700 bg-shell-900/70 p-4 backdrop-blur">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-signal-slate">Agentic Shadow-Cap</p>
              <h1 className="mt-1 text-2xl font-semibold text-signal-mint">Dark Pool Agent Console</h1>
              <p className="mt-1 text-sm text-signal-slate">
                Participant endpoint: {participantLabelFor(party, networkMode)}
              </p>
            </div>
            <div className="flex flex-col gap-2 md:items-end">
              <label className="text-sm text-signal-slate">
                Party
                <select
                  className="ml-2 rounded-md border border-shell-700 bg-shell-950 px-2 py-1 text-white"
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
        </header>

        <nav className="mb-4 flex flex-wrap gap-2">
          {navItems.map((item) => (
            <button
              key={item.key}
              className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                item.key === activeView
                  ? "bg-signal-mint text-shell-950"
                  : "border border-shell-700 bg-shell-900/60 text-signal-slate hover:border-shell-600"
              }`}
              onClick={() => setActiveView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {loading && party !== "Public" ? <p className="text-sm text-signal-slate">Loading private ledger view...</p> : null}
        {error ? (
          <div className="mb-4 rounded-lg border border-signal-coral/40 bg-signal-coral/10 p-3 text-sm text-signal-coral">
            {error}
          </div>
        ) : null}

        {party === "Public" ? (
          <section className="flex min-h-[60vh] items-center justify-center">
            <div className="w-full max-w-2xl space-y-6 text-center">
              <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full border-2 border-signal-coral/40 bg-signal-coral/5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-signal-coral/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                </svg>
              </div>
              <p className="text-xs uppercase tracking-[0.24em] text-signal-slate">Unauthorized Perspective</p>
              <h2 className="text-3xl font-semibold text-white">Zero Visibility</h2>
              <p className="mx-auto max-w-md text-sm text-signal-slate">
                Canton's sub-transaction privacy model ensures complete data isolation.
                Without an authorized party identity, no contracts, holdings, or market
                activity are visible on this node.
              </p>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                {[
                  { label: "Trade Intents", value: "0" },
                  { label: "Negotiations", value: "0" },
                  { label: "Settlements", value: "0" },
                  { label: "Holdings", value: "0" },
                ].map((card) => (
                  <article key={card.label} className="rounded-xl border border-shell-700 bg-shell-900/80 p-4">
                    <p className="text-xs uppercase tracking-[0.15em] text-signal-slate">{card.label}</p>
                    <p className="mt-2 text-3xl font-semibold text-signal-slate">{card.value}</p>
                  </article>
                ))}
              </div>
              <p className="text-xs text-signal-slate/60">
                Select a party from the header to view their private ledger perspective.
              </p>
            </div>
          </section>
        ) : null}

        {party !== "Public" && activeView === "owner" ? (
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

        {party !== "Public" && activeView === "market" ? (
          <MarketView
            party={party}
            negotiations={negotiations}
            onOpenChannel={() => setActiveView("owner")}
          />
        ) : null}

        {party !== "Public" && activeView === "compliance" ? (
          <ComplianceView
            party={party}
            negotiations={negotiations}
            settlements={settlements}
            assetHoldings={assetHoldings}
            cashHoldings={cashHoldings}
            onApproveMatch={onApproveMatch}
          />
        ) : null}

        {party !== "Public" && activeView === "logs" ? <AgentLogsView party={party} logs={logs} onClear={clearLogs} /> : null}
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
