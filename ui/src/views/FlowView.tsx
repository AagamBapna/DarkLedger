import { useEffect, useMemo, useRef, useState } from "react";
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
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function commitmentHashForTerms(qtyText: string, unitPriceText: string, salt: string): Promise<string> {
  return sha256Hex(`${qtyText}|${unitPriceText}|${salt}`);
}

function optionalText(value: string | null | { tag: "Some" | "None"; value?: string }): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "tag" in value) {
    if (value.tag === "Some") {
      return value.value ?? null;
    }
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
  for (let i = 0; i < value.length; i += 1) {
    acc = (acc * 33 + value.charCodeAt(i)) >>> 0;
  }
  return acc.toString(16).toUpperCase().slice(-4).padStart(4, "0");
}

function maskedParty(role: "Buyer" | "Seller", party: string): string {
  return `${role}-${pseudonymToken(aliasOf(party))}`;
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
  const [negotiationSide, setNegotiationSide] = useState<"Buy" | "Sell">("Sell");
  const [negotiationSalt, setNegotiationSalt] = useState("manual-commit-salt");

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
  const [judgePauseEnabled, setJudgePauseEnabled] = useState(true);
  const [judgePauseGate, setJudgePauseGate] = useState<{ title: string; hint: string } | null>(null);

  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);

  const pauseResolverRef = useRef<(() => void) | null>(null);

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

  const replayStages = useMemo<ReplayStage[]>(
    () => [
      {
        label: "Intent",
        count: tradeIntents.length,
        accent: "text-signal-mint",
        visibleTo: ["Seller", "SellerAgent", "Company"],
        note: "Seller posts intent privately. Buyer side and Outsider see nothing.",
      },
      {
        label: "Discovery",
        count: discoveryInterests.length,
        accent: "text-signal-amber",
        visibleTo: ["Owner", "PostingAgent", "Company", "DiscoverableBy"],
        note: "Blind signal only. Quantity and price stay hidden.",
      },
      {
        label: "Negotiation",
        count: negotiations.length,
        accent: "text-signal-coral",
        visibleTo: ["Seller", "SellerAgent", "Buyer", "BuyerAgent", "Company"],
        note: "Counterparties remain masked for non-issuer viewers.",
      },
      {
        label: "Approval",
        count: negotiations.filter((item) => item.payload.issuerApproved).length,
        accent: "text-signal-mint",
        visibleTo: ["Company + negotiation parties"],
        note: "Issuer gate checks commit + reveal integrity before approving.",
      },
      {
        label: "Settlement",
        count: settlements.length,
        accent: "text-signal-amber",
        visibleTo: ["Settlement participants + issuer"],
        note: "Final DvP + audit record. Real identities become explicit for issuer/settlement views.",
      },
    ],
    [discoveryInterests.length, negotiations, settlements.length, tradeIntents.length],
  );

  useEffect(() => {
    if (!replayPlaying || replayStages.length === 0) return;
    const timer = window.setInterval(() => {
      setReplayIndex((prev) => (prev + 1) % replayStages.length);
    }, 1400);
    return () => {
      window.clearInterval(timer);
    };
  }, [replayPlaying, replayStages.length]);

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
    const ttl = discoveryTtlWindow();
    await runAction(`DiscoveryInterest (${discoverySide}) posted by ${orderActor}`, async () => {
      await createContract(orderActor, TEMPLATE_IDS.discoveryInterest, {
        issuer: company,
        owner: orderActor,
        postingAgent: orderActor,
        discoverableBy,
        instrument,
        side: { tag: discoverySide, value: {} },
        strategyTag,
        createdAt: ttl.createdAt,
        expiresAt: ttl.expiresAt,
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

  const waitForJudgePause = async (title: string, hint: string) => {
    if (!judgePauseEnabled) return;
    setJudgePauseGate({ title, hint });
    await new Promise<void>((resolve) => {
      pauseResolverRef.current = resolve;
    });
    setJudgePauseGate(null);
  };

  const continueJudgeScript = () => {
    const resolver = pauseResolverRef.current;
    if (!resolver) return;
    pauseResolverRef.current = null;
    resolver();
  };

  const runGuidedDemo = async () => {
    if (demoRunning) return;

    setBusy(true);
    setDemoRunning(true);
    setStatusMessage(null);
    setErrorMessage(null);

    const runTag = `judge-ui-${Date.now().toString().slice(-6)}`;
    let scriptNegotiationCid = "";

    const resolveCurrentNegotiationCid = async (): Promise<string> => {
      const rows = await queryPrivateNegotiations(company);
      const match = rows.find(
        (item) =>
          item.payload.instrument === instrument
          && matchesParty(item.payload.sellerAgent, sellerAgent)
          && matchesParty(item.payload.buyerAgent, buyerAgent),
      );
      if (!match) {
        throw new Error("Could not resolve active negotiation contract.");
      }
      return match.contractId;
    };

    const runStep = async (label: string, activeParty: string, action: () => Promise<void>) => {
      setDemoStep(label);
      onSwitchParty(activeParty);
      await delay(550);
      await action();
      onLog({
        source: "ui-action",
        decision: "Judge mode step completed",
        metadata: label,
      });
      await onRefresh();
      await delay(500);
    };

    try {
      const qty = Number.parseFloat(quantity) || 1000;
      const px = Number.parseFloat(minPrice) || 95;

      await runStep("1/6 Seller posts private TradeIntent", seller, async () => {
        await createContract(seller, TEMPLATE_IDS.tradeIntent, {
          issuer: company,
          seller,
          sellerAgent,
          instrument,
          quantity: qty,
          minPrice: px,
        });
      });
      await waitForJudgePause(
        "Proof Moment: Visibility Shock",
        "Use the top switch to flip Seller -> Outsider on this contract ID and show disappearance.",
      );

      await runStep("2/6 SellerAgent posts blind sell discovery", sellerAgent, async () => {
        const ttl = discoveryTtlWindow();
        await createContract(sellerAgent, TEMPLATE_IDS.discoveryInterest, {
          issuer: company,
          owner: seller,
          postingAgent: sellerAgent,
          discoverableBy: [buyerAgent],
          instrument,
          side: { tag: "Sell", value: {} },
          strategyTag: runTag,
          createdAt: ttl.createdAt,
          expiresAt: ttl.expiresAt,
        });
      });

      await runStep("3/6 BuyerAgent posts blind buy discovery", buyerAgent, async () => {
        const ttl = discoveryTtlWindow();
        await createContract(buyerAgent, TEMPLATE_IDS.discoveryInterest, {
          issuer: company,
          owner: buyer,
          postingAgent: buyerAgent,
          discoverableBy: [sellerAgent],
          instrument,
          side: { tag: "Buy", value: {} },
          strategyTag: runTag,
          createdAt: ttl.createdAt,
          expiresAt: ttl.expiresAt,
        });
      });
      await waitForJudgePause(
        "Proof Moment: No Public Order Book",
        "Point to leak-comparison panel: only blind signals exist before matching.",
      );

      await runStep("4/6 Company matches discovery -> private negotiation", company, async () => {
        const before = await queryPrivateNegotiations(company);
        const beforeIds = new Set(before.map((item) => item.contractId));

        const discoveries = await queryDiscoveryInterests(company);
        const sellDiscovery = discoveries.find(
          (item) =>
            sideTag(item.payload.side) === "Sell"
            && item.payload.instrument === instrument
            && item.payload.strategyTag === runTag
            && matchesParty(item.payload.postingAgent, sellerAgent),
        );
        const buyDiscovery = discoveries.find(
          (item) =>
            sideTag(item.payload.side) === "Buy"
            && item.payload.instrument === instrument
            && item.payload.strategyTag === runTag
            && matchesParty(item.payload.postingAgent, buyerAgent),
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

      await runStep("5/6 Agents commit hashes, then reveal terms", sellerAgent, async () => {
        if (!scriptNegotiationCid) {
          throw new Error("Judge mode missing negotiation contract ID.");
        }
        const qtyText = String(qty);
        const unitPriceText = String(px);
        const sellerSalt = "judge-seller-salt";
        const buyerSalt = "judge-buyer-salt";
        const sellerHash = await commitmentHashForTerms(qtyText, unitPriceText, sellerSalt);
        const buyerHash = await commitmentHashForTerms(qtyText, unitPriceText, buyerSalt);

        await exerciseChoice(sellerAgent, TEMPLATE_IDS.privateNegotiation, scriptNegotiationCid, "SubmitSellerTerms", {
          qty,
          unitPrice: px,
        });
        scriptNegotiationCid = await resolveCurrentNegotiationCid();
        await exerciseChoice(buyerAgent, TEMPLATE_IDS.privateNegotiation, scriptNegotiationCid, "AcceptByBuyer", {});
        scriptNegotiationCid = await resolveCurrentNegotiationCid();
        await exerciseChoice(sellerAgent, TEMPLATE_IDS.privateNegotiation, scriptNegotiationCid, "AcceptBySeller", {});
        scriptNegotiationCid = await resolveCurrentNegotiationCid();

        await exerciseChoice(sellerAgent, TEMPLATE_IDS.privateNegotiation, scriptNegotiationCid, "CommitTerms", {
          side: { tag: "Sell", value: {} },
          commitmentHash: sellerHash,
        });
        scriptNegotiationCid = await resolveCurrentNegotiationCid();
        await exerciseChoice(buyerAgent, TEMPLATE_IDS.privateNegotiation, scriptNegotiationCid, "CommitTerms", {
          side: { tag: "Buy", value: {} },
          commitmentHash: buyerHash,
        });
        scriptNegotiationCid = await resolveCurrentNegotiationCid();

        await exerciseChoice(sellerAgent, TEMPLATE_IDS.privateNegotiation, scriptNegotiationCid, "RevealTerms", {
          side: { tag: "Sell", value: {} },
          qtyText,
          unitPriceText,
          salt: sellerSalt,
        });
        scriptNegotiationCid = await resolveCurrentNegotiationCid();
        await exerciseChoice(buyerAgent, TEMPLATE_IDS.privateNegotiation, scriptNegotiationCid, "RevealTerms", {
          side: { tag: "Buy", value: {} },
          qtyText,
          unitPriceText,
          salt: buyerSalt,
        });
        scriptNegotiationCid = await resolveCurrentNegotiationCid();
      });
      await waitForJudgePause(
        "Proof Moment: Commit-Reveal Theater",
        "Open the commit-reveal panel and show hashes first, terms unlocked after reveal.",
      );

      await runStep("6/6 Company approves + settles", company, async () => {
        if (!scriptNegotiationCid) {
          throw new Error("Judge mode missing negotiation contract ID.");
        }
        await exerciseChoice(company, TEMPLATE_IDS.privateNegotiation, scriptNegotiationCid, "ApproveMatch", {});

        const afterApprove = await queryPrivateNegotiations(company);
        const approved = afterApprove.find(
          (item) =>
            item.payload.issuerApproved
            && item.payload.instrument === instrument
            && matchesParty(item.payload.sellerAgent, sellerAgent)
            && matchesParty(item.payload.buyerAgent, buyerAgent),
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
      await waitForJudgePause(
        "Proof Moment: Settlement + Identity Reveal",
        "Switch to issuer/compliance view to show real counterparties and immutable audit output.",
      );

      setStatusMessage("Judge mode complete. Capture outsider proof, commit-reveal panel, and final settlement cards.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Judge mode failed";
      setErrorMessage(message);
      onLog({
        source: "ui-action",
        decision: "Judge mode failed",
        metadata: message,
      });
    } finally {
      setBusy(false);
      setDemoRunning(false);
      setDemoStep(null);
      setJudgePauseGate(null);
      pauseResolverRef.current = null;
    }
  };

  const currentReplayStage = replayStages[replayIndex] ?? replayStages[0];

  return (
    <section className="space-y-6">
      <div className="rounded-xl border border-shell-700 bg-white/70 p-4 backdrop-blur-xl">
        <p className="text-xs uppercase tracking-[0.24em] text-signal-slate">Live Flow</p>
        <h3 className="mt-2 text-xl font-semibold text-shell-950">Judge Mode + Multi-Party Command Studio</h3>
        <p className="mt-2 text-sm text-signal-slate">
          One-click full private trade, pause on proof moments, and replay privacy visibility at every stage.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            className="rounded-md bg-shell-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => void runGuidedDemo()}
          >
            {demoRunning ? "Running Judge Script..." : "Run Full Private Trade (Judge Mode)"}
          </button>
          <label className="flex items-center gap-2 rounded-md border border-shell-700 bg-white px-3 py-1.5 text-xs text-signal-slate">
            <input
              type="checkbox"
              className="h-4 w-4 accent-signal-mint"
              checked={judgePauseEnabled}
              onChange={(event) => setJudgePauseEnabled(event.target.checked)}
            />
            Pause at proof checkpoints
          </label>
          {demoStep ? <p className="text-xs text-signal-slate">Current step: {demoStep}</p> : null}
        </div>

        {judgePauseGate ? (
          <div className="mt-3 rounded-lg border border-signal-amber/40 bg-signal-amber/10 p-3">
            <p className="text-sm font-semibold text-shell-950">{judgePauseGate.title}</p>
            <p className="mt-1 text-xs text-signal-slate">{judgePauseGate.hint}</p>
            <button
              className="mt-2 rounded-md bg-signal-amber px-3 py-1.5 text-xs font-semibold text-shell-950"
              onClick={continueJudgeScript}
            >
              Continue Judge Script
            </button>
          </div>
        ) : null}

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
        </div>
      </div>

      <div className="rounded-xl border border-shell-700 bg-white/70 p-4 backdrop-blur-xl">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Timeline Replay Mode</p>
            <h4 className="mt-1 text-lg font-semibold text-shell-950">
              {currentReplayStage ? `${currentReplayStage.label} Stage` : "Lifecycle"}
            </h4>
            <p className="mt-1 text-xs text-signal-slate">Intent -&gt; Discovery -&gt; Negotiation -&gt; Approval -&gt; Settlement</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-md border border-shell-700 bg-white px-3 py-1.5 text-xs font-semibold text-signal-slate"
              onClick={() => setReplayIndex((prev) => (prev === 0 ? replayStages.length - 1 : prev - 1))}
            >
              Prev
            </button>
            <button
              className="rounded-md bg-shell-950 px-3 py-1.5 text-xs font-semibold text-white"
              onClick={() => setReplayPlaying((prev) => !prev)}
            >
              {replayPlaying ? "Pause" : "Play"}
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
              <article
                key={stage.label}
                className={`rounded-lg border p-3 transition ${
                  active
                    ? "border-shell-950 bg-shell-900/5 shadow-[0_8px_24px_rgba(36,56,99,0.12)]"
                    : "border-shell-700 bg-white/85"
                }`}
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
              </article>
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

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-shell-700 bg-white/70 p-4 backdrop-blur-xl">
          <h4 className="text-lg font-semibold text-signal-mint">Manual Order Entry</h4>
          <p className="mt-1 text-xs text-signal-slate">Inject new intents and blind discovery signals live.</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-xs text-signal-slate">
              Submit As
              <select
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
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
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
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
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
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
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
                value={minPrice}
                onChange={(event) => setMinPrice(event.target.value)}
              />
            </label>
            <label className="text-xs text-signal-slate">
              Discovery Side
              <select
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
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
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
                value={strategyTag}
                onChange={(event) => setStrategyTag(event.target.value)}
              />
            </label>
          </div>
          <label className="mt-3 block text-xs text-signal-slate">
            Discoverable By (comma-separated parties)
            <input
              className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
              value={discoverableByCsv}
              onChange={(event) => setDiscoverableByCsv(event.target.value)}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded-md bg-signal-mint px-3 py-2 text-sm font-semibold text-shell-950 disabled:opacity-50"
              disabled={busy}
              onClick={() => void createTradeIntent()}
            >
              Create Sell TradeIntent
            </button>
            <button
              className="rounded-md bg-signal-amber px-3 py-2 text-sm font-semibold text-shell-950 disabled:opacity-50"
              disabled={busy}
              onClick={() => void createDiscoveryInterest()}
            >
              Post DiscoveryInterest
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-shell-700 bg-white/70 p-4 backdrop-blur-xl">
          <h4 className="text-lg font-semibold text-signal-amber">Negotiation + Settlement Controls</h4>
          <p className="mt-1 text-xs text-signal-slate">Drive commit/reveal and settlement choices manually.</p>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-xs text-signal-slate">
              Negotiation Actor
              <select
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
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
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
                value={negotiationChoice}
                onChange={(event) => setNegotiationChoice(event.target.value as NegotiationChoice)}
              >
                <option value="SubmitSellerTerms">SubmitSellerTerms</option>
                <option value="SubmitBuyerTerms">SubmitBuyerTerms</option>
                <option value="CommitTerms">CommitTerms</option>
                <option value="RevealTerms">RevealTerms</option>
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
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
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
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
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
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
                value={negotiationPrice}
                onChange={(event) => setNegotiationPrice(event.target.value)}
              />
            </label>
            <label className="text-xs text-signal-slate">
              Side (commit/reveal)
              <select
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
                value={negotiationSide}
                onChange={(event) => setNegotiationSide(event.target.value as "Buy" | "Sell")}
              >
                <option value="Sell">Sell</option>
                <option value="Buy">Buy</option>
              </select>
            </label>
            <label className="text-xs text-signal-slate">
              Salt (commit/reveal)
              <input
                className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
                value={negotiationSalt}
                onChange={(event) => setNegotiationSalt(event.target.value)}
              />
            </label>
          </div>
          <button
            className="mt-3 rounded-md bg-signal-amber px-3 py-2 text-sm font-semibold text-shell-950 disabled:opacity-50"
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
                  className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
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
                  className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
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
                  className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
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
                  className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
                  value={sellerAssetCid}
                  onChange={(event) => setSellerAssetCid(event.target.value)}
                />
              </label>
              <label className="text-xs text-signal-slate">
                Buyer Cash CID
                <input
                  className="mt-1 w-full rounded-md border border-shell-700 bg-white px-2 py-2 text-shell-950"
                  value={buyerCashCid}
                  onChange={(event) => setBuyerCashCid(event.target.value)}
                />
              </label>
            </div>
            <button
              className="mt-3 rounded-md bg-signal-coral px-3 py-2 text-sm font-semibold text-shell-950 disabled:opacity-50"
              disabled={busy}
              onClick={() => void executeSettlementChoice()}
            >
              Execute Settlement Choice
            </button>
          </div>
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

      <article className="rounded-xl border border-shell-700 bg-white/70 p-4 backdrop-blur-xl">
        <h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-signal-slate">Action Output</h4>
        {statusMessage ? <p className="mt-2 text-sm text-signal-mint">{statusMessage}</p> : null}
        {errorMessage ? <p className="mt-2 text-sm text-signal-coral">{errorMessage}</p> : null}
        {!statusMessage && !errorMessage ? (
          <p className="mt-2 text-sm text-signal-slate">Execute actions above to generate observable on-ledger state changes.</p>
        ) : null}
      </article>
    </section>
  );
}
