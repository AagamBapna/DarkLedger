import { useEffect, useMemo, useState } from "react";
import {
  TEMPLATE_IDS,
  createContract,
  exerciseChoice,
  optionalToNumber,
  queryDiscoveryInterests,
  queryPrivateNegotiations,
  queryTradeSettlements,
} from "../lib/ledgerClient";
import type {
  AgentLogEntry,
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

interface FlowViewProps {
  party: Party;
  availableParties: string[];
  tradeIntents: Array<ContractRecord<TradeIntentPayload>>;
  discoveryInterests: Array<ContractRecord<DiscoveryInterestPayload>>;
  negotiations: Array<ContractRecord<PrivateNegotiationPayload>>;
  settlements: Array<ContractRecord<TradeSettlementPayload>>;
  auditRecords: Array<ContractRecord<TradeAuditRecordPayload>>;
  assetHoldings: Array<ContractRecord<AssetHoldingPayload>>;
  cashHoldings: Array<ContractRecord<CashHoldingPayload>>;
  onSwitchParty: (nextParty: string) => void;
  onRefresh: () => Promise<void>;
  onLog: (entry: Omit<AgentLogEntry, "id" | "at">) => void;
}

type NegotiationChoice =
  | "SubmitSellerTerms"
  | "SubmitBuyerTerms"
  | "AcceptBySeller"
  | "AcceptByBuyer"
  | "ApproveMatch"
  | "StartSettlement";

type SettlementChoice = "SimpleFinalizeSettlement" | "FinalizeSettlement";

function resolveAlias(availableParties: string[], alias: string): string {
  const exact = availableParties.find((party) => party === alias);
  if (exact) return exact;
  const qualified = availableParties.find((party) => party.startsWith(`${alias}::`));
  if (qualified) return qualified;
  return alias;
}

function aliasOf(party: string): string {
  return party.includes("::") ? party.split("::")[0] : party;
}

function matchesParty(left: string, right: string): boolean {
  return aliasOf(left) === aliasOf(right);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stageVisibility(label: string): string {
  switch (label) {
    case "Intent":
      return "Seller, SellerAgent, Company";
    case "Discovery":
      return "Owner, PostingAgent, Issuer, Discoverable Counterparty";
    case "Negotiation":
      return "Seller, SellerAgent, Buyer, BuyerAgent, Company";
    case "Issuer Approval":
      return "Same negotiation parties + Company decision";
    case "Settlement":
      return "Same parties, DvP state private to involved parties";
    case "Audit":
      return "Issuer + trade participants";
    default:
      return "Party-scoped";
  }
}

export function FlowView({
  party,
  availableParties,
  tradeIntents,
  discoveryInterests,
  negotiations,
  settlements,
  auditRecords,
  assetHoldings,
  cashHoldings,
  onSwitchParty,
  onRefresh,
  onLog,
}: FlowViewProps) {
  const seller = useMemo(() => resolveAlias(availableParties, "Seller"), [availableParties]);
  const sellerAgent = useMemo(() => resolveAlias(availableParties, "SellerAgent"), [availableParties]);
  const buyer = useMemo(() => resolveAlias(availableParties, "Buyer"), [availableParties]);
  const buyerAgent = useMemo(() => resolveAlias(availableParties, "BuyerAgent"), [availableParties]);
  const company = useMemo(() => resolveAlias(availableParties, "Company"), [availableParties]);
  const executableParties = useMemo(
    () => availableParties.filter((entry) => entry !== "Public"),
    [availableParties],
  );

  const [orderActor, setOrderActor] = useState<string>(seller);
  const [instrument, setInstrument] = useState("COMPANY-SERIES-A");
  const [quantity, setQuantity] = useState("1500");
  const [minPrice, setMinPrice] = useState("95");
  const [strategyTag, setStrategyTag] = useState("manual-ui");
  const [discoverySide, setDiscoverySide] = useState<"Buy" | "Sell">("Buy");
  const [discoverableByCsv, setDiscoverableByCsv] = useState(`${buyerAgent}`);

  const [negotiationActor, setNegotiationActor] = useState<string>(sellerAgent);
  const [negotiationChoice, setNegotiationChoice] = useState<NegotiationChoice>("SubmitSellerTerms");
  const [negotiationCid, setNegotiationCid] = useState("");
  const [negotiationQty, setNegotiationQty] = useState("1000");
  const [negotiationPrice, setNegotiationPrice] = useState("98");

  const [settlementActor, setSettlementActor] = useState<string>(company);
  const [settlementChoice, setSettlementChoice] = useState<SettlementChoice>("SimpleFinalizeSettlement");
  const [settlementCid, setSettlementCid] = useState("");
  const [sellerAssetCid, setSellerAssetCid] = useState("");
  const [buyerCashCid, setBuyerCashCid] = useState("");

  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);
  const [demoStep, setDemoStep] = useState<string | null>(null);

  useEffect(() => {
    if (!availableParties.includes(orderActor) && executableParties.length > 0) {
      setOrderActor(executableParties[0]);
    }
  }, [availableParties, executableParties, orderActor]);

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

  const lifecycleStages = useMemo(
    () => [
      { label: "Intent", count: tradeIntents.length, accent: "text-signal-mint" },
      { label: "Discovery", count: discoveryInterests.length, accent: "text-signal-amber" },
      { label: "Negotiation", count: negotiations.length, accent: "text-signal-coral" },
      {
        label: "Issuer Approval",
        count: negotiations.filter((item) => item.payload.issuerApproved).length,
        accent: "text-signal-mint",
      },
      { label: "Settlement", count: settlements.length, accent: "text-signal-amber" },
      { label: "Audit", count: auditRecords.length, accent: "text-signal-coral" },
    ],
    [auditRecords.length, discoveryInterests.length, negotiations, settlements.length, tradeIntents.length],
  );

  const partyUniverse = useMemo(
    () => ["Seller", "SellerAgent", "Buyer", "BuyerAgent", "Company", "Public"],
    [],
  );

  const privacyRows = useMemo(
    () => {
      const current = aliasOf(party);
      const rows: Array<{
        label: string;
        visibleTo: string;
        hiddenFrom: string;
        visibleForActive: boolean;
      }> = [];

      const addFixedRow = (label: string, visibleParties: string[]) => {
        const hidden = partyUniverse.filter((candidate) => !visibleParties.includes(candidate));
        rows.push({
          label,
          visibleTo: visibleParties.join(", "),
          hiddenFrom: hidden.join(", "),
          visibleForActive: visibleParties.includes(current),
        });
      };

      addFixedRow("TradeIntent", ["Seller", "SellerAgent", "Company"]);
      rows.push({
        label: "DiscoveryInterest",
        visibleTo: "Owner, PostingAgent, Issuer, DiscoverableBy",
        hiddenFrom: "Any non-participant party",
        visibleForActive: discoveryInterests.length > 0,
      });
      addFixedRow("PrivateNegotiation", ["Seller", "SellerAgent", "Buyer", "BuyerAgent", "Company"]);
      addFixedRow("TradeSettlement", ["Seller", "SellerAgent", "Buyer", "BuyerAgent", "Company"]);
      addFixedRow("TradeAuditRecord", ["Seller", "SellerAgent", "Buyer", "BuyerAgent", "Company"]);

      return rows;
    },
    [discoveryInterests.length, party, partyUniverse],
  );

  const runAction = async (description: string, action: () => Promise<void>) => {
    setBusy(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      await action();
      setStatusMessage(description);
      onLog({
        source: "ui-action",
        decision: "Manual action executed",
        metadata: description,
      });
      await onRefresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Action failed";
      setErrorMessage(message);
      onLog({
        source: "ui-action",
        decision: "Manual action failed",
        metadata: `${description} error=${message}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const createTradeIntent = async () => {
    await runAction(`TradeIntent created by ${orderActor}`, async () => {
      await createContract(orderActor, TEMPLATE_IDS.tradeIntent, {
        issuer: company,
        seller,
        sellerAgent,
        instrument,
        quantity: Number.parseFloat(quantity),
        minPrice: Number.parseFloat(minPrice),
      });
    });
  };

  const createDiscoveryInterest = async () => {
    const discoverableBy = discoverableByCsv
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    await runAction(`DiscoveryInterest (${discoverySide}) posted by ${orderActor}`, async () => {
      await createContract(orderActor, TEMPLATE_IDS.discoveryInterest, {
        issuer: company,
        owner: orderActor,
        postingAgent: orderActor,
        discoverableBy,
        instrument,
        side: { tag: discoverySide, value: {} },
        strategyTag,
      });
    });
  };

  const executeNegotiationChoice = async () => {
    if (!negotiationCid) {
      setErrorMessage("Choose a negotiation contract ID first.");
      return;
    }
    await runAction(`${negotiationChoice} by ${negotiationActor}`, async () => {
      const argument =
        negotiationChoice === "SubmitSellerTerms" || negotiationChoice === "SubmitBuyerTerms"
          ? {
              qty: Number.parseFloat(negotiationQty),
              unitPrice: Number.parseFloat(negotiationPrice),
            }
          : {};
      await exerciseChoice(
        negotiationActor,
        TEMPLATE_IDS.privateNegotiation,
        negotiationCid,
        negotiationChoice,
        argument,
      );
    });
  };

  const executeSettlementChoice = async () => {
    if (!settlementCid) {
      setErrorMessage("Choose a settlement contract ID first.");
      return;
    }
    await runAction(`${settlementChoice} by ${settlementActor}`, async () => {
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
  };

  const runGuidedDemo = async () => {
    if (demoRunning) return;

    setBusy(true);
    setDemoRunning(true);
    setStatusMessage(null);
    setErrorMessage(null);

    const runTag = `guided-ui-${Date.now().toString().slice(-6)}`;
    let scriptNegotiationCid = "";

    const runStep = async (label: string, activeParty: string, action: () => Promise<void>) => {
      setDemoStep(label);
      onSwitchParty(activeParty);
      await delay(550);
      await action();
      onLog({
        source: "ui-action",
        decision: "Guided demo step completed",
        metadata: label,
      });
      await onRefresh();
      await delay(500);
    };

    try {
      const qty = Number.parseFloat(quantity) || 1000;
      const px = Number.parseFloat(minPrice) || 95;

      await runStep("1/6 Seller posts TradeIntent", seller, async () => {
        await createContract(seller, TEMPLATE_IDS.tradeIntent, {
          issuer: company,
          seller,
          sellerAgent,
          instrument,
          quantity: qty,
          minPrice: px,
        });
      });

      await runStep("2/6 SellerAgent posts blind sell discovery", sellerAgent, async () => {
        await createContract(sellerAgent, TEMPLATE_IDS.discoveryInterest, {
          issuer: company,
          owner: seller,
          postingAgent: sellerAgent,
          discoverableBy: [buyerAgent],
          instrument,
          side: { tag: "Sell", value: {} },
          strategyTag: runTag,
        });
      });

      await runStep("3/6 BuyerAgent posts blind buy discovery", buyerAgent, async () => {
        await createContract(buyerAgent, TEMPLATE_IDS.discoveryInterest, {
          issuer: company,
          owner: buyer,
          postingAgent: buyerAgent,
          discoverableBy: [sellerAgent],
          instrument,
          side: { tag: "Buy", value: {} },
          strategyTag: runTag,
        });
      });

      await runStep("4/6 Company matches discovery -> negotiation", company, async () => {
        const before = await queryPrivateNegotiations(company);
        const beforeIds = new Set(before.map((item) => item.contractId));

        const discoveries = await queryDiscoveryInterests(company);
        const sellDiscovery = discoveries.find(
          (item) =>
            sideTag(item.payload.side) === "Sell" &&
            item.payload.instrument === instrument &&
            item.payload.strategyTag === runTag &&
            matchesParty(item.payload.postingAgent, sellerAgent),
        );
        const buyDiscovery = discoveries.find(
          (item) =>
            sideTag(item.payload.side) === "Buy" &&
            item.payload.instrument === instrument &&
            item.payload.strategyTag === runTag &&
            matchesParty(item.payload.postingAgent, buyerAgent),
        );

        if (!sellDiscovery || !buyDiscovery) {
          throw new Error("Could not find scripted discovery interests for matching.");
        }

        await exerciseChoice(company, TEMPLATE_IDS.discoveryInterest, sellDiscovery.contractId, "MatchWith", {
          counterpartyCid: buyDiscovery.contractId,
        });

        const after = await queryPrivateNegotiations(company);
        const created = after.find((item) => !beforeIds.has(item.contractId));
        if (!created) {
          throw new Error("Match created no visible PrivateNegotiation contract.");
        }
        scriptNegotiationCid = created.contractId;
      });

      await runStep("5/6 Agents negotiate and accept terms", sellerAgent, async () => {
        if (!scriptNegotiationCid) {
          throw new Error("Guided demo missing negotiation contract ID.");
        }
        await exerciseChoice(sellerAgent, TEMPLATE_IDS.privateNegotiation, scriptNegotiationCid, "SubmitSellerTerms", {
          qty,
          unitPrice: px,
        });
        await exerciseChoice(buyerAgent, TEMPLATE_IDS.privateNegotiation, scriptNegotiationCid, "AcceptByBuyer", {});
        await exerciseChoice(sellerAgent, TEMPLATE_IDS.privateNegotiation, scriptNegotiationCid, "AcceptBySeller", {});
      });

      await runStep("6/6 Company approves + settles + finalizes", company, async () => {
        if (!scriptNegotiationCid) {
          throw new Error("Guided demo missing negotiation contract ID.");
        }
        await exerciseChoice(company, TEMPLATE_IDS.privateNegotiation, scriptNegotiationCid, "ApproveMatch", {});

        const afterApprove = await queryPrivateNegotiations(company);
        const approved = afterApprove.find(
          (item) =>
            item.payload.issuerApproved &&
            item.payload.instrument === instrument &&
            matchesParty(item.payload.sellerAgent, sellerAgent) &&
            matchesParty(item.payload.buyerAgent, buyerAgent),
        );
        if (!approved) {
          throw new Error("Issuer-approved negotiation not found.");
        }

        const settlementsBefore = await queryTradeSettlements(company);
        const beforeIds = new Set(settlementsBefore.map((item) => item.contractId));

        await exerciseChoice(company, TEMPLATE_IDS.privateNegotiation, approved.contractId, "StartSettlement", {});

        const settlementsAfter = await queryTradeSettlements(company);
        const created = settlementsAfter.find((item) => !beforeIds.has(item.contractId));
        if (!created) {
          throw new Error("StartSettlement did not create a visible settlement contract.");
        }
        await exerciseChoice(company, TEMPLATE_IDS.tradeSettlement, created.contractId, "SimpleFinalizeSettlement", {});
      });

      setStatusMessage("Guided demo complete. Switch to Public view to show zero visibility, then return to party views for proof.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Guided demo failed";
      setErrorMessage(message);
      onLog({
        source: "ui-action",
        decision: "Guided demo failed",
        metadata: message,
      });
    } finally {
      setBusy(false);
      setDemoRunning(false);
      setDemoStep(null);
    }
  };

  return (
    <section className="space-y-6">
      <div className="rounded-xl border border-shell-700 bg-white/70 backdrop-blur-xl p-4">
        <p className="text-xs uppercase tracking-[0.24em] text-signal-slate">Live Flow</p>
        <h3 className="mt-2 text-xl font-semibold text-shell-950">Lifecycle + Multi-Party Command Studio</h3>
        <p className="mt-2 text-sm text-signal-slate">
          Submit manual actions as different parties, then switch perspectives to prove who can see each stage.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            className="rounded-md bg-shell-950 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => void runGuidedDemo()}
          >
            {demoRunning ? "Running Guided Demo..." : "Run Guided Demo Mode"}
          </button>
          {demoStep ? <p className="text-xs text-signal-slate">Current step: {demoStep}</p> : null}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {executableParties.map((entry) => (
            <button
              key={entry}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                party === entry
                  ? "bg-signal-mint text-shell-950"
                  : "border border-shell-700 bg-white text-signal-slate"
              }`}
              onClick={() => onSwitchParty(entry)}
            >
              View as {entry.includes("::") ? entry.split("::")[0] : entry}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {lifecycleStages.map((stage) => (
          <article key={stage.label} className="rounded-xl border border-shell-700 bg-white/80 backdrop-blur-xl p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-signal-slate">{stage.label}</p>
            <p className={`mt-2 text-3xl font-semibold ${stage.accent}`}>{stage.count}</p>
            <p className="mt-2 text-xs text-signal-slate">{stageVisibility(stage.label)}</p>
          </article>
        ))}
      </div>

      <div className="rounded-xl border border-shell-700 bg-white/70 backdrop-blur-xl p-4">
        <h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-signal-slate">
          Privacy Proof Panel
        </h4>
        <p className="mt-1 text-xs text-signal-slate">
          Live contract-level privacy claims for party <span className="font-semibold text-shell-950">{aliasOf(party)}</span>.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-shell-700 text-left text-xs uppercase tracking-[0.12em] text-signal-slate">
                <th className="py-2">Contract</th>
                <th className="py-2">Visible To</th>
                <th className="py-2">Hidden From</th>
                <th className="py-2">Current Party Status</th>
              </tr>
            </thead>
            <tbody>
              {privacyRows.map((row) => (
                <tr key={row.label} className="border-b border-shell-800">
                  <td className="py-3 font-medium text-shell-950">{row.label}</td>
                  <td className="py-3 text-signal-slate">{row.visibleTo}</td>
                  <td className="py-3 text-signal-slate">{row.hiddenFrom}</td>
                  <td className="py-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-semibold ${
                        row.visibleForActive
                          ? "bg-signal-mint/20 text-signal-mint"
                          : "bg-signal-coral/15 text-signal-coral"
                      }`}
                    >
                      {row.visibleForActive ? "Visible for current party" : "Hidden for current party"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-shell-700 bg-white/70 backdrop-blur-xl p-4">
          <h4 className="text-lg font-semibold text-signal-mint">Manual Order Entry</h4>
          <p className="mt-1 text-xs text-signal-slate">Use this to inject new orders and discovery signals live.</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-xs text-signal-slate">
              Submit As
              <select
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                value={orderActor}
                onChange={(event) => setOrderActor(event.target.value)}
              >
                {executableParties.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
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
              Min Price (Intent)
              <input
                type="number"
                min="0.01"
                step="0.01"
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                value={minPrice}
                onChange={(event) => setMinPrice(event.target.value)}
              />
            </label>
            <label className="text-xs text-signal-slate">
              Discovery Side
              <select
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                value={discoverySide}
                onChange={(event) => setDiscoverySide(event.target.value as "Buy" | "Sell")}
              >
                <option value="Buy">Buy</option>
                <option value="Sell">Sell</option>
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
          <label className="mt-3 block text-xs text-signal-slate">
            Discoverable By (comma-separated parties)
            <input
              className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
              value={discoverableByCsv}
              onChange={(event) => setDiscoverableByCsv(event.target.value)}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded-md bg-signal-mint px-3 py-1.5 text-sm font-semibold text-shell-950 disabled:opacity-50"
              disabled={busy}
              onClick={() => void createTradeIntent()}
            >
              Create Sell TradeIntent
            </button>
            <button
              className="rounded-md bg-signal-amber px-3 py-1.5 text-sm font-semibold text-shell-950 disabled:opacity-50"
              disabled={busy}
              onClick={() => void createDiscoveryInterest()}
            >
              Post DiscoveryInterest
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-shell-700 bg-white/70 backdrop-blur-xl p-4">
          <h4 className="text-lg font-semibold text-signal-amber">Negotiation & Settlement Controls</h4>
          <p className="mt-1 text-xs text-signal-slate">Exercise key choices manually to force full lifecycle states.</p>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-xs text-signal-slate">
              Negotiation Actor
              <select
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                value={negotiationActor}
                onChange={(event) => setNegotiationActor(event.target.value)}
              >
                {executableParties.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-signal-slate">
              Negotiation Choice
              <select
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                value={negotiationChoice}
                onChange={(event) => setNegotiationChoice(event.target.value as NegotiationChoice)}
              >
                <option value="SubmitSellerTerms">SubmitSellerTerms</option>
                <option value="SubmitBuyerTerms">SubmitBuyerTerms</option>
                <option value="AcceptBySeller">AcceptBySeller</option>
                <option value="AcceptByBuyer">AcceptByBuyer</option>
                <option value="ApproveMatch">ApproveMatch</option>
                <option value="StartSettlement">StartSettlement</option>
              </select>
            </label>
            <label className="text-xs text-signal-slate md:col-span-2">
              Negotiation Contract
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
            <label className="text-xs text-signal-slate">
              Qty (submit choices)
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
              Price (submit choices)
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
          <button
            className="mt-3 rounded-md bg-signal-amber px-3 py-1.5 text-sm font-semibold text-shell-950 disabled:opacity-50"
            disabled={busy}
            onClick={() => void executeNegotiationChoice()}
          >
            Execute Negotiation Choice
          </button>

          <div className="mt-4 border-t border-shell-700 pt-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs text-signal-slate">
                Settlement Actor
                <select
                  className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                  value={settlementActor}
                  onChange={(event) => setSettlementActor(event.target.value)}
                >
                  {executableParties.map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-signal-slate">
                Settlement Choice
                <select
                  className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                  value={settlementChoice}
                  onChange={(event) => setSettlementChoice(event.target.value as SettlementChoice)}
                >
                  <option value="SimpleFinalizeSettlement">SimpleFinalizeSettlement</option>
                  <option value="FinalizeSettlement">FinalizeSettlement</option>
                </select>
              </label>
              <label className="text-xs text-signal-slate md:col-span-2">
                Settlement Contract
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
                  className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                  value={sellerAssetCid}
                  onChange={(event) => setSellerAssetCid(event.target.value)}
                />
              </label>
              <label className="text-xs text-signal-slate">
                Buyer Cash CID
                <input
                  className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-1.5 text-shell-950"
                  value={buyerCashCid}
                  onChange={(event) => setBuyerCashCid(event.target.value)}
                />
              </label>
            </div>
            <button
              className="mt-3 rounded-md bg-signal-coral px-3 py-1.5 text-sm font-semibold text-shell-950 disabled:opacity-50"
              disabled={busy}
              onClick={() => void executeSettlementChoice()}
            >
              Execute Settlement Choice
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <article className="rounded-xl border border-shell-700 bg-white/70 backdrop-blur-xl p-4">
          <h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-signal-slate">Negotiation Snapshot</h4>
          {negotiations.length === 0 ? (
            <p className="mt-2 text-sm text-signal-slate">No visible negotiations for this party yet.</p>
          ) : (
            <ul className="mt-2 space-y-2 text-sm">
              {negotiations.slice(0, 4).map((item) => (
                <li key={item.contractId} className="rounded-md border border-shell-700 bg-white/80 p-2">
                  <p className="font-medium text-shell-950">{item.payload.instrument}</p>
                  <p className="text-xs text-signal-slate">
                    qty={optionalToNumber(item.payload.proposedQty) ?? "—"} price={optionalToNumber(item.payload.proposedUnitPrice) ?? "—"}
                  </p>
                  <p className="text-xs text-signal-slate">cid={item.contractId.slice(0, 26)}...</p>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="rounded-xl border border-shell-700 bg-white/70 backdrop-blur-xl p-4">
          <h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-signal-slate">Action Output</h4>
          {statusMessage ? <p className="mt-2 text-sm text-signal-mint">{statusMessage}</p> : null}
          {errorMessage ? <p className="mt-2 text-sm text-signal-coral">{errorMessage}</p> : null}
          {!statusMessage && !errorMessage ? (
            <p className="mt-2 text-sm text-signal-slate">Execute actions above to generate observable on-ledger state changes.</p>
          ) : null}
        </article>
      </div>
    </section>
  );
}
