import { useEffect, useMemo, useState } from "react";
import {
  TEMPLATE_IDS,
  createContract,
  exerciseChoice,
  optionalToNumber,
  queryDiscoveryInterests,
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
  | "CommitTerms"
  | "RevealTerms"
  | "AcceptBySeller"
  | "AcceptByBuyer"
  | "ApproveMatch"
  | "StartSettlement";

type SettlementChoice = "SimpleFinalizeSettlement" | "FinalizeSettlement";

interface ReplayStage {
  label: string;
  count: number;
  accent: string;
  visibleTo: string[];
  note: string;
}

function resolveAlias(availableParties: string[], alias: string): string {
  const exact = availableParties.find((partyId) => partyId === alias);
  if (exact) return exact;
  const qualified = availableParties.find((partyId) => partyId.startsWith(`${alias}::`));
  if (qualified) return qualified;
  return alias;
}

function aliasOf(partyId: string): string {
  return partyId.includes("::") ? partyId.split("::")[0] : partyId;
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

function discoveryTtlWindow(ttlSeconds: number = 300): { createdAt: string; expiresAt: string } {
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

function shortHash(value: string | null): string {
  if (!value) return "not committed";
  return `${value.slice(0, 14)}...${value.slice(-6)}`;
}

function pseudonymToken(value: string): string {
  let acc = 0;
  for (let index = 0; index < value.length; index += 1) {
    acc = (acc * 33 + value.charCodeAt(index)) >>> 0;
  }
  return acc.toString(16).toUpperCase().slice(-4).padStart(4, "0");
}

function maskedParty(role: "Buyer" | "Seller", partyId: string): string {
  return `${role}-${pseudonymToken(aliasOf(partyId))}`;
}

function shouldRevealIdentities(
  activeParty: string,
  negotiation: PrivateNegotiationPayload,
  settlements: Array<ContractRecord<TradeSettlementPayload>>,
): boolean {
  if (aliasOf(activeParty) === "Company") return true;
  return settlements.some(
    (settlement) =>
      settlement.payload.settled
      && settlement.payload.instrument === negotiation.instrument
      && matchesParty(settlement.payload.seller, negotiation.seller)
      && matchesParty(settlement.payload.buyer, negotiation.buyer),
  );
}

function counterpartyLine(
  activeParty: string,
  negotiation: PrivateNegotiationPayload,
  settlements: Array<ContractRecord<TradeSettlementPayload>>,
): string {
  if (shouldRevealIdentities(activeParty, negotiation, settlements)) {
    return `${aliasOf(negotiation.seller)} ↔ ${aliasOf(negotiation.buyer)}`;
  }

  const active = aliasOf(activeParty);
  if (active === "Seller" || active === "SellerAgent") {
    return maskedParty("Buyer", negotiation.buyer);
  }
  if (active === "Buyer" || active === "BuyerAgent") {
    return maskedParty("Seller", negotiation.seller);
  }
  return `${maskedParty("Seller", negotiation.seller)} ↔ ${maskedParty("Buyer", negotiation.buyer)}`;
}

function normalizeActionError(message: string): string {
  if (message.includes("DAML_AUTHORIZATION_ERROR")) {
    return "Authorization failed for this choice. Use Seller for TradeIntent, agents for negotiation choices, and Company for issuer or settlement choices.";
  }
  return message.length > 260 ? `${message.slice(0, 260)}...` : message;
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
  const outsider = useMemo(() => resolveAlias(availableParties, "Outsider"), [availableParties]);
  const executableParties = useMemo(
    () => availableParties.filter((entry) => aliasOf(entry) !== "Outsider"),
    [availableParties],
  );

  const [instrument, setInstrument] = useState("COMPANY-SERIES-A");
  const [quantity, setQuantity] = useState("1200");
  const [minPrice, setMinPrice] = useState("98");

  const [discoveryActor, setDiscoveryActor] = useState<string>(sellerAgent);
  const [discoveryOwner, setDiscoveryOwner] = useState<string>(seller);
  const [strategyTag, setStrategyTag] = useState("control-tower");
  const [discoverySide, setDiscoverySide] = useState<"Buy" | "Sell">("Sell");
  const [discoverableByCsv, setDiscoverableByCsv] = useState(`${buyerAgent}`);
  const [sellDiscoveryCid, setSellDiscoveryCid] = useState("");
  const [buyDiscoveryCid, setBuyDiscoveryCid] = useState("");

  const [negotiationActor, setNegotiationActor] = useState<string>(sellerAgent);
  const [negotiationChoice, setNegotiationChoice] = useState<NegotiationChoice>("SubmitSellerTerms");
  const [negotiationCid, setNegotiationCid] = useState("");
  const [negotiationQty, setNegotiationQty] = useState("1000");
  const [negotiationPrice, setNegotiationPrice] = useState("99");
  const [negotiationSide, setNegotiationSide] = useState<"Buy" | "Sell">("Sell");
  const [negotiationSalt, setNegotiationSalt] = useState("control-tower-salt");

  const [settlementActor, setSettlementActor] = useState<string>(company);
  const [settlementChoice, setSettlementChoice] = useState<SettlementChoice>("SimpleFinalizeSettlement");
  const [settlementCid, setSettlementCid] = useState("");
  const [sellerAssetCid, setSellerAssetCid] = useState("");
  const [buyerCashCid, setBuyerCashCid] = useState("");

  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);

  const replayStages = useMemo<ReplayStage[]>(
    () => [
      {
        label: "Intent",
        count: tradeIntents.length,
        accent: "text-signal-mint",
        visibleTo: ["Seller", "SellerAgent", "Company"],
        note: "Seller posts intent privately. Buyer-side and outsider still see zero.",
      },
      {
        label: "Discovery",
        count: discoveryInterests.length,
        accent: "text-signal-amber",
        visibleTo: ["Owner", "PostingAgent", "Company", "DiscoverableBy"],
        note: "Only a blind signal is visible, not full order details.",
      },
      {
        label: "Negotiation",
        count: negotiations.length,
        accent: "text-signal-coral",
        visibleTo: ["Seller", "SellerAgent", "Buyer", "BuyerAgent", "Company"],
        note: "Commit-reveal keeps exact terms protected until both sides reveal.",
      },
      {
        label: "Approval",
        count: negotiations.filter((item) => item.payload.issuerApproved).length,
        accent: "text-signal-mint",
        visibleTo: ["Company + negotiation parties"],
        note: "Issuer gate confirms commitments and reveals before settlement.",
      },
      {
        label: "Settlement",
        count: settlements.length,
        accent: "text-signal-amber",
        visibleTo: ["Settlement participants + issuer"],
        note: "DvP finalization produces auditable completion without outsider leakage.",
      },
    ],
    [discoveryInterests.length, negotiations, settlements.length, tradeIntents.length],
  );

  const partyUniverse = useMemo(
    () => ["Seller", "SellerAgent", "Buyer", "BuyerAgent", "Company", "Outsider"],
    [],
  );

  const privacyRows = useMemo(() => {
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
  }, [discoveryInterests.length, party, partyUniverse]);

  const selectedNegotiation = useMemo(() => {
    return negotiations.find((item) => item.contractId === negotiationCid) ?? negotiations[0] ?? null;
  }, [negotiationCid, negotiations]);

  const selectedSellerHash = optionalText(selectedNegotiation?.payload.sellerCommitmentHash ?? null);
  const selectedBuyerHash = optionalText(selectedNegotiation?.payload.buyerCommitmentHash ?? null);
  const termsFullyRevealed = Boolean(
    selectedNegotiation
      && selectedNegotiation.payload.sellerTermsRevealed
      && selectedNegotiation.payload.buyerTermsRevealed,
  );

  const discoveryActorOptions = useMemo(
    () => [sellerAgent, buyerAgent].filter((value, index, all) => Boolean(value) && all.indexOf(value) === index),
    [buyerAgent, sellerAgent],
  );

  const negotiationActorOptions = useMemo(() => {
    switch (negotiationChoice) {
      case "SubmitSellerTerms":
      case "AcceptBySeller":
        return [sellerAgent];
      case "SubmitBuyerTerms":
      case "AcceptByBuyer":
        return [buyerAgent];
      case "ApproveMatch":
      case "StartSettlement":
        return [company];
      default:
        return [sellerAgent, buyerAgent];
    }
  }, [buyerAgent, company, negotiationChoice, sellerAgent]);

  useEffect(() => {
    if (!negotiations.length) return;
    if (!negotiationCid) setNegotiationCid(negotiations[0].contractId);
  }, [negotiationCid, negotiations]);

  useEffect(() => {
    if (!settlements.length) return;
    if (!settlementCid) setSettlementCid(settlements[0].contractId);
  }, [settlementCid, settlements]);

  useEffect(() => {
    if (!sellerAssetCid && assetHoldings.length > 0) {
      setSellerAssetCid(assetHoldings[0].contractId);
    }
    if (!buyerCashCid && cashHoldings.length > 0) {
      setBuyerCashCid(cashHoldings[0].contractId);
    }
  }, [assetHoldings, buyerCashCid, cashHoldings, sellerAssetCid]);

  useEffect(() => {
    if (!discoveryActorOptions.includes(discoveryActor) && discoveryActorOptions.length > 0) {
      setDiscoveryActor(discoveryActorOptions[0]);
    }
  }, [discoveryActor, discoveryActorOptions]);

  useEffect(() => {
    const actorAlias = aliasOf(discoveryActor);
    if (actorAlias === "SellerAgent") {
      setDiscoveryOwner(seller);
      if (!discoverableByCsv) setDiscoverableByCsv(buyerAgent);
      return;
    }
    if (actorAlias === "BuyerAgent") {
      setDiscoveryOwner(buyer);
      if (!discoverableByCsv) setDiscoverableByCsv(sellerAgent);
    }
  }, [buyer, buyerAgent, discoverableByCsv, discoveryActor, seller, sellerAgent]);

  useEffect(() => {
    if (!negotiationActorOptions.includes(negotiationActor) && negotiationActorOptions.length > 0) {
      setNegotiationActor(negotiationActorOptions[0]);
    }
  }, [negotiationActor, negotiationActorOptions]);

  useEffect(() => {
    if (!discoveryInterests.length) return;
    if (!sellDiscoveryCid) {
      const firstSell = discoveryInterests.find((row) => sideTag(row.payload.side) === "Sell");
      if (firstSell) setSellDiscoveryCid(firstSell.contractId);
    }
    if (!buyDiscoveryCid) {
      const firstBuy = discoveryInterests.find((row) => sideTag(row.payload.side) === "Buy");
      if (firstBuy) setBuyDiscoveryCid(firstBuy.contractId);
    }
  }, [buyDiscoveryCid, discoveryInterests, sellDiscoveryCid]);

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
    } catch (reason) {
      const rawMessage = reason instanceof Error ? reason.message : String(reason);
      const message = normalizeActionError(rawMessage);
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
    await runAction(`TradeIntent created by ${seller}`, async () => {
      await createContract(seller, TEMPLATE_IDS.tradeIntent, {
        issuer: company,
        seller,
        sellerAgent,
        buyer,
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
    const ttl = discoveryTtlWindow();
    await runAction(`DiscoveryInterest (${discoverySide}) posted by ${discoveryActor}`, async () => {
      await createContract(discoveryActor, TEMPLATE_IDS.discoveryInterest, {
        issuer: company,
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
  };

  const matchDiscoveryPair = async () => {
    await runAction("Company matched discovery pair into private negotiation", async () => {
      const rows = await queryDiscoveryInterests(company);
      const scoped = rows.filter((item) => {
        if (item.payload.instrument !== instrument) return false;
        if (!strategyTag) return true;
        return item.payload.strategyTag === strategyTag;
      });

      const selectedSell = sellDiscoveryCid
        ? scoped.find((row) => row.contractId === sellDiscoveryCid)
        : scoped.find((row) => sideTag(row.payload.side) === "Sell");
      const selectedBuy = buyDiscoveryCid
        ? scoped.find((row) => row.contractId === buyDiscoveryCid)
        : scoped.find((row) => sideTag(row.payload.side) === "Buy");

      if (!selectedSell || !selectedBuy) {
        throw new Error("Need one Sell and one Buy discovery contract for matching. Switch to Company and refresh if IDs are missing.");
      }

      await exerciseChoice(company, TEMPLATE_IDS.discoveryInterest, selectedSell.contractId, "MatchWith", {
        counterpartyCid: selectedBuy.contractId,
      });
    });
  };

  const executeNegotiationChoice = async () => {
    if (!negotiationCid) {
      setErrorMessage("Choose a negotiation contract ID first.");
      return;
    }

    await runAction(`${negotiationChoice} by ${negotiationActor}`, async () => {
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

  const currentReplayStage = replayStages[replayIndex] ?? replayStages[0];
  const showNegotiationTerms = ["SubmitSellerTerms", "SubmitBuyerTerms", "CommitTerms", "RevealTerms"].includes(negotiationChoice);
  const showNegotiationSide = negotiationChoice === "CommitTerms" || negotiationChoice === "RevealTerms";
  const showSalt = negotiationChoice === "RevealTerms" || negotiationChoice === "CommitTerms";

  const fieldClass = "mt-1 w-full rounded-md border border-shell-700 bg-white px-3 py-2 text-shell-950";

  return (
    <section className="space-y-6">
      <div className="rounded-xl border border-shell-700 bg-white/70 p-4 backdrop-blur-xl">
        <p className="text-xs uppercase tracking-[0.24em] text-signal-slate">Live Action Console</p>
        <h3 className="mt-2 text-xl font-semibold text-shell-950">Manual Lifecycle Controls</h3>
        <p className="mt-2 text-sm text-signal-slate">
          Manual presenter flow only. Nothing auto-rotates or advances unless you click it.
        </p>

        <div className="mt-3 grid gap-2 text-xs text-signal-slate md:grid-cols-2">
          <p>1. Seller creates TradeIntent, then agents post discovery signals.</p>
          <p>2. Company matches discovery pair into one private negotiation.</p>
          <p>3. Agents submit, commit, and reveal terms.</p>
          <p>4. Company approves, starts settlement, and finalizes proof.</p>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {executableParties.map((entry) => (
            <button
              key={entry}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                party === entry
                  ? "bg-signal-mint text-shell-950"
                  : "border border-shell-700 bg-white text-signal-slate"
              }`}
              onClick={() => onSwitchParty(entry)}
            >
              {aliasOf(entry)}
            </button>
          ))}
          <button
            className="rounded-full border border-shell-700 bg-white px-4 py-2 text-sm font-semibold text-signal-coral"
            onClick={() => onSwitchParty(outsider)}
          >
            Outsider Probe
          </button>
          <button
            className="rounded-full border border-shell-700 bg-white px-4 py-2 text-sm font-semibold text-shell-950"
            onClick={() => void onRefresh()}
            disabled={busy}
          >
            Refresh Ledger
          </button>
        </div>

        {statusMessage ? (
          <p className="mt-3 rounded-md border border-signal-mint/40 bg-signal-mint/10 px-3 py-2 text-xs text-shell-950">
            {statusMessage}
          </p>
        ) : null}
        {errorMessage ? (
          <p className="mt-3 rounded-md border border-signal-coral/40 bg-signal-coral/10 px-3 py-2 text-xs text-signal-coral">
            {errorMessage}
          </p>
        ) : null}

        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          <article className="rounded-lg border border-shell-700 bg-white/85 p-4">
            <h4 className="text-lg font-semibold text-shell-950">Trade Intent + Discovery</h4>

            <label className="mt-3 block text-xs text-signal-slate">
              Actor
              <input className={fieldClass} value="Seller" disabled />
            </label>

            <label className="mt-3 block text-xs text-signal-slate">
              Instrument
              <input className={fieldClass} value={instrument} onChange={(event) => setInstrument(event.target.value)} />
            </label>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-signal-slate">
                Quantity
                <input className={fieldClass} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
              </label>
              <label className="text-xs text-signal-slate">
                Min Price
                <input className={fieldClass} value={minPrice} onChange={(event) => setMinPrice(event.target.value)} />
              </label>
            </div>

            <button
              className="mt-3 w-full rounded-md bg-signal-mint px-3 py-2 text-sm font-semibold text-shell-950 disabled:opacity-50"
              onClick={() => void createTradeIntent()}
              disabled={busy}
            >
              Create TradeIntent
            </button>

            <hr className="my-4 border-shell-700" />

            <label className="block text-xs text-signal-slate">
              Discovery Actor
              <select
                className={fieldClass}
                value={discoveryActor}
                onChange={(event) => setDiscoveryActor(event.target.value)}
              >
                {discoveryActorOptions.map((entry) => (
                  <option key={entry} value={entry}>{aliasOf(entry)}</option>
                ))}
              </select>
            </label>

            <label className="mt-3 block text-xs text-signal-slate">
              Discovery Owner
              <select
                className={fieldClass}
                value={discoveryOwner}
                onChange={(event) => setDiscoveryOwner(event.target.value)}
              >
                <option value={seller}>Seller</option>
                <option value={buyer}>Buyer</option>
              </select>
            </label>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-signal-slate">
                Side
                <select
                  className={fieldClass}
                  value={discoverySide}
                  onChange={(event) => setDiscoverySide(event.target.value as "Buy" | "Sell")}
                >
                  <option value="Sell">Sell</option>
                  <option value="Buy">Buy</option>
                </select>
              </label>
              <label className="text-xs text-signal-slate">
                Strategy Tag
                <input className={fieldClass} value={strategyTag} onChange={(event) => setStrategyTag(event.target.value)} />
              </label>
            </div>

            <label className="mt-3 block text-xs text-signal-slate">
              Discoverable By (CSV)
              <input
                className={fieldClass}
                value={discoverableByCsv}
                onChange={(event) => setDiscoverableByCsv(event.target.value)}
              />
            </label>

            <button
              className="mt-3 w-full rounded-md bg-[#a47832] px-3 py-2 text-sm font-semibold text-shell-950 disabled:opacity-50"
              onClick={() => void createDiscoveryInterest()}
              disabled={busy}
            >
              Post DiscoveryInterest
            </button>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-signal-slate">
                Sell Discovery CID
                <input
                  list="sell-discovery-cids"
                  className={fieldClass}
                  value={sellDiscoveryCid}
                  onChange={(event) => setSellDiscoveryCid(event.target.value)}
                  placeholder="optional"
                />
                <datalist id="sell-discovery-cids">
                  {discoveryInterests
                    .filter((row) => sideTag(row.payload.side) === "Sell")
                    .map((row) => <option key={row.contractId} value={row.contractId} />)}
                </datalist>
              </label>
              <label className="text-xs text-signal-slate">
                Buy Discovery CID
                <input
                  list="buy-discovery-cids"
                  className={fieldClass}
                  value={buyDiscoveryCid}
                  onChange={(event) => setBuyDiscoveryCid(event.target.value)}
                  placeholder="optional"
                />
                <datalist id="buy-discovery-cids">
                  {discoveryInterests
                    .filter((row) => sideTag(row.payload.side) === "Buy")
                    .map((row) => <option key={row.contractId} value={row.contractId} />)}
                </datalist>
              </label>
            </div>

            <button
              className="mt-3 w-full rounded-md bg-shell-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              onClick={() => void matchDiscoveryPair()}
              disabled={busy}
            >
              Match Discovery Pair (Company)
            </button>
          </article>

          <article className="rounded-lg border border-shell-700 bg-white/85 p-4">
            <h4 className="text-lg font-semibold text-shell-950">Negotiation Controls</h4>

            <label className="mt-3 block text-xs text-signal-slate">
              Choice
              <select
                className={fieldClass}
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

            <label className="mt-3 block text-xs text-signal-slate">
              Actor
              <select
                className={fieldClass}
                value={negotiationActor}
                onChange={(event) => setNegotiationActor(event.target.value)}
              >
                {negotiationActorOptions.map((entry) => (
                  <option key={entry} value={entry}>{aliasOf(entry)}</option>
                ))}
              </select>
            </label>

            <label className="mt-3 block text-xs text-signal-slate">
              Negotiation CID
              <input
                list="negotiation-cids"
                className={fieldClass}
                value={negotiationCid}
                onChange={(event) => setNegotiationCid(event.target.value)}
              />
              <datalist id="negotiation-cids">
                {negotiations.map((row) => (
                  <option key={row.contractId} value={row.contractId} />
                ))}
              </datalist>
            </label>

            {showNegotiationTerms ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-signal-slate">
                  Qty
                  <input className={fieldClass} value={negotiationQty} onChange={(event) => setNegotiationQty(event.target.value)} />
                </label>
                <label className="text-xs text-signal-slate">
                  Unit Price
                  <input
                    className={fieldClass}
                    value={negotiationPrice}
                    onChange={(event) => setNegotiationPrice(event.target.value)}
                  />
                </label>
              </div>
            ) : null}

            {showNegotiationSide ? (
              <label className="mt-3 block text-xs text-signal-slate">
                Side
                <select
                  className={fieldClass}
                  value={negotiationSide}
                  onChange={(event) => setNegotiationSide(event.target.value as "Buy" | "Sell")}
                >
                  <option value="Sell">Sell</option>
                  <option value="Buy">Buy</option>
                </select>
              </label>
            ) : null}

            {showSalt ? (
              <label className="mt-3 block text-xs text-signal-slate">
                Salt
                <input
                  className={fieldClass}
                  value={negotiationSalt}
                  onChange={(event) => setNegotiationSalt(event.target.value)}
                />
              </label>
            ) : null}

            <button
              className="mt-3 w-full rounded-md bg-shell-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              onClick={() => void executeNegotiationChoice()}
              disabled={busy}
            >
              Execute Negotiation Choice
            </button>
          </article>

          <article className="rounded-lg border border-shell-700 bg-white/85 p-4">
            <h4 className="text-lg font-semibold text-shell-950">Settlement + Proof Ops</h4>

            <label className="mt-3 block text-xs text-signal-slate">
              Settlement Actor
              <select
                className={fieldClass}
                value={settlementActor}
                onChange={(event) => setSettlementActor(event.target.value)}
              >
                <option value={company}>Company</option>
              </select>
            </label>

            <label className="mt-3 block text-xs text-signal-slate">
              Choice
              <select
                className={fieldClass}
                value={settlementChoice}
                onChange={(event) => setSettlementChoice(event.target.value as SettlementChoice)}
              >
                <option value="SimpleFinalizeSettlement">SimpleFinalizeSettlement</option>
                <option value="FinalizeSettlement">FinalizeSettlement</option>
              </select>
            </label>

            <label className="mt-3 block text-xs text-signal-slate">
              Settlement CID
              <input
                list="settlement-cids"
                className={fieldClass}
                value={settlementCid}
                onChange={(event) => setSettlementCid(event.target.value)}
              />
              <datalist id="settlement-cids">
                {settlements.map((row) => (
                  <option key={row.contractId} value={row.contractId} />
                ))}
              </datalist>
            </label>

            {settlementChoice === "FinalizeSettlement" ? (
              <>
                <label className="mt-3 block text-xs text-signal-slate">
                  Seller Asset CID
                  <input
                    list="seller-asset-cids"
                    className={fieldClass}
                    value={sellerAssetCid}
                    onChange={(event) => setSellerAssetCid(event.target.value)}
                  />
                  <datalist id="seller-asset-cids">
                    {assetHoldings.map((row) => (
                      <option key={row.contractId} value={row.contractId} />
                    ))}
                  </datalist>
                </label>

                <label className="mt-3 block text-xs text-signal-slate">
                  Buyer Cash CID
                  <input
                    list="buyer-cash-cids"
                    className={fieldClass}
                    value={buyerCashCid}
                    onChange={(event) => setBuyerCashCid(event.target.value)}
                  />
                  <datalist id="buyer-cash-cids">
                    {cashHoldings.map((row) => (
                      <option key={row.contractId} value={row.contractId} />
                    ))}
                  </datalist>
                </label>
              </>
            ) : null}

            <button
              className="mt-3 w-full rounded-md bg-shell-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              onClick={() => void executeSettlementChoice()}
              disabled={busy}
            >
              Execute Settlement Choice
            </button>

            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md border border-shell-700 bg-white p-2 text-signal-slate">Intents: {tradeIntents.length}</div>
              <div className="rounded-md border border-shell-700 bg-white p-2 text-signal-slate">Discovery: {discoveryInterests.length}</div>
              <div className="rounded-md border border-shell-700 bg-white p-2 text-signal-slate">Negotiations: {negotiations.length}</div>
              <div className="rounded-md border border-shell-700 bg-white p-2 text-signal-slate">Settlements: {settlements.length}</div>
              <div className="rounded-md border border-shell-700 bg-white p-2 text-signal-slate">Audits: {auditRecords.length}</div>
              <div className="rounded-md border border-shell-700 bg-white p-2 text-signal-slate">Party: {aliasOf(party)}</div>
            </div>
          </article>
        </div>
      </div>

      <div className="rounded-xl border border-shell-700 bg-white/70 p-4 backdrop-blur-xl">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Lifecycle Snapshot</p>
            <h4 className="mt-1 text-lg font-semibold text-shell-950">
              {currentReplayStage ? `${currentReplayStage.label} Stage` : "Lifecycle"}
            </h4>
            <p className="mt-1 text-xs text-signal-slate">Manual navigation only: Intent -&gt; Discovery -&gt; Negotiation -&gt; Approval -&gt; Settlement</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-md border border-shell-700 bg-white px-3 py-1.5 text-xs font-semibold text-signal-slate"
              onClick={() => setReplayIndex((prev) => (prev === 0 ? replayStages.length - 1 : prev - 1))}
            >
              Prev
            </button>
            <button
              className="rounded-md border border-shell-700 bg-white px-3 py-1.5 text-xs font-semibold text-signal-slate"
              onClick={() => setReplayIndex((prev) => (prev + 1) % replayStages.length)}
            >
              Next
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-5">
          {replayStages.map((stage, index) => {
            const active = index === replayIndex;
            return (
              <button
                key={stage.label}
                className={`rounded-lg border p-3 text-left transition ${
                  active
                    ? "border-shell-950 bg-shell-900/5 shadow-[0_8px_24px_rgba(36,56,99,0.12)]"
                    : "border-shell-700 bg-white/85"
                }`}
                onClick={() => setReplayIndex(index)}
              >
                <p className="text-xs uppercase tracking-[0.16em] text-signal-slate">{stage.label}</p>
                <p className={`mt-1 text-2xl font-semibold ${stage.accent}`}>{stage.count}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {stage.visibleTo.map((scope) => (
                    <span key={scope} className="rounded-full bg-shell-900/5 px-2 py-0.5 text-[10px] text-signal-slate">
                      {scope}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-sm text-signal-slate">{currentReplayStage?.note}</p>
      </div>

      <div className="rounded-xl border border-shell-700 bg-white/70 p-4 backdrop-blur-xl">
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

      <div className="grid gap-4 md:grid-cols-2">
        <article className="rounded-xl border border-shell-700 bg-white/70 p-4 backdrop-blur-xl">
          <h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-signal-slate">Commit-Reveal Theater</h4>
          {!selectedNegotiation ? (
            <p className="mt-2 text-sm text-signal-slate">No negotiation selected yet.</p>
          ) : (
            <div className="mt-2 space-y-3">
              <div className="rounded-md border border-shell-700 bg-white/85 p-3">
                <p className="text-xs text-signal-slate">Instrument</p>
                <p className="text-sm font-semibold text-shell-950">{selectedNegotiation.payload.instrument}</p>
                <p className="mt-1 text-xs text-signal-slate">
                  Counterparty view: {counterpartyLine(party, selectedNegotiation.payload, settlements)}
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-md border border-shell-700 bg-white/85 p-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-signal-slate">Seller commitment</p>
                  <p className="mt-1 font-mono text-xs text-shell-950">{shortHash(selectedSellerHash)}</p>
                  <p className="mt-1 text-[11px] text-signal-slate">
                    Revealed: {selectedNegotiation.payload.sellerTermsRevealed ? "yes" : "no"}
                  </p>
                </div>
                <div className="rounded-md border border-shell-700 bg-white/85 p-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-signal-slate">Buyer commitment</p>
                  <p className="mt-1 font-mono text-xs text-shell-950">{shortHash(selectedBuyerHash)}</p>
                  <p className="mt-1 text-[11px] text-signal-slate">
                    Revealed: {selectedNegotiation.payload.buyerTermsRevealed ? "yes" : "no"}
                  </p>
                </div>
              </div>
              <div
                className={`rounded-md border p-3 ${
                  termsFullyRevealed || aliasOf(party) === "Company"
                    ? "border-signal-mint/40 bg-signal-mint/10"
                    : "border-signal-amber/40 bg-signal-amber/10"
                }`}
              >
                <p className="text-xs uppercase tracking-[0.12em] text-signal-slate">Term reveal state</p>
                {termsFullyRevealed || aliasOf(party) === "Company" ? (
                  <p className="mt-1 text-sm text-shell-950">
                    Qty {optionalToNumber(selectedNegotiation.payload.proposedQty) ?? "—"} @
                    ${optionalToNumber(selectedNegotiation.payload.proposedUnitPrice) ?? "—"}
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-signal-slate">
                    Exact qty/price hidden until both parties reveal committed terms.
                  </p>
                )}
              </div>
            </div>
          )}
        </article>

        <article className="rounded-xl border border-shell-700 bg-white/70 p-4 backdrop-blur-xl">
          <h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-signal-slate">Negotiation Snapshot</h4>
          {negotiations.length === 0 ? (
            <p className="mt-2 text-sm text-signal-slate">No visible negotiations for this party yet.</p>
          ) : (
            <ul className="mt-2 space-y-2 text-sm">
              {negotiations.slice(0, 4).map((item) => {
                const revealIdentity = shouldRevealIdentities(party, item.payload, settlements);
                const revealTerms = revealIdentity || (item.payload.sellerTermsRevealed && item.payload.buyerTermsRevealed);
                return (
                  <li key={item.contractId} className="rounded-md border border-shell-700 bg-white/85 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-shell-950">{item.payload.instrument}</p>
                      <span className="rounded-full bg-shell-900/5 px-2 py-0.5 text-[10px] text-signal-slate">
                        {revealIdentity ? "identity revealed" : "counterparty masked"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-signal-slate">
                      {counterpartyLine(party, item.payload, settlements)}
                    </p>
                    {revealTerms ? (
                      <p className="mt-1 text-xs text-signal-slate">
                        qty={optionalToNumber(item.payload.proposedQty) ?? "—"} price=
                        {optionalToNumber(item.payload.proposedUnitPrice) ?? "—"}
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-signal-slate">terms hidden until both commit hashes are revealed</p>
                    )}
                    <p className="text-[11px] text-signal-slate">
                      cid={item.contractId.slice(0, 26)}...
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </article>
      </div>
    </section>
  );
}
