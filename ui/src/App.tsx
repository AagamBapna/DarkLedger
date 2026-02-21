import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePartyContext } from "./context/PartyContext";
import { ContractVisibilityInspector } from "./views/ContractVisibilityInspector";
import { DarkAuctionView } from "./views/DarkAuctionView";
import { LandingPage } from "./views/LandingPage";
import { PrivacyChallengeMode } from "./views/PrivacyChallengeMode";
import {
  TEMPLATE_IDS,
  createContract,
  exerciseChoice,
  optionalToNumber,
  queryAuditRecords,
  queryPrivateNegotiations,
  queryTradeIntents,
  queryTradeSettlements,
} from "./lib/ledgerClient";
import type {
  ContractRecord,
  PrivateNegotiationPayload,
  TradeAuditRecordPayload,
  TradeIntentPayload,
  TradeSettlementPayload,
} from "./types/contracts";

type RoleView = "Landing" | "DarkAuction" | "Seller" | "Buyer" | "Outsider" | "Inspector" | "Challenge";

type SellerChoice =
  | "SubmitSellerTerms"
  | "CommitTerms"
  | "RevealTerms"
  | "AcceptBySeller"
  | "RejectBySeller";

type BuyerChoice =
  | "SubmitBuyerTerms"
  | "CommitTerms"
  | "RevealTerms"
  | "AcceptByBuyer"
  | "RejectByBuyer";

function aliasOf(value: string): string {
  return value.includes("::") ? value.split("::")[0] : value;
}

function resolveAlias(availableParties: string[], alias: string): string {
  const exact = availableParties.find((entry) => entry === alias);
  if (exact) return exact;
  const qualified = availableParties.find((entry) => entry.startsWith(`${alias}::`));
  if (qualified) return qualified;
  return alias;
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

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function shortId(value: string): string {
  if (!value) return "-";
  return value.length <= 16 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function optionalText(value: string | null | { tag: "Some" | "None"; value?: string }): string {
  if (value === null || value === undefined) return "not committed";
  if (typeof value === "string") return value;
  if (value.tag === "Some") return value.value ?? "not committed";
  return "not committed";
}

function statusPillClass(active: boolean): string {
  return active
    ? "border border-signal-mint/40 bg-shell-950 text-shell-900 shadow-soft"
    : "border border-shell-700/70 bg-white/75 text-signal-slate hover:border-signal-mint/40 hover:text-shell-950";
}

function isValidPositiveNumber(value: string): boolean {
  return parsePositiveDecimal(value) !== null;
}

function parsePositiveDecimal(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return trimmed;
}

function isLockedContractError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("local_verdict_locked_contracts") || lower.includes("locked contracts");
}

function normalizeLedgerError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("cannot accept before terms exist")) {
    return "Cannot accept yet. Submit terms first using Negotiate.";
  }
  return message;
}

const NEGOTIATION_FIELD_CHOICES = ["SubmitSellerTerms", "SubmitBuyerTerms", "CommitTerms", "RevealTerms"];

function normalizeInstrument(value: string): string {
  return value.trim().toLowerCase();
}

function negotiationLaneKey(row: ContractRecord<PrivateNegotiationPayload>): string {
  return [
    normalizeInstrument(row.payload.instrument),
    aliasOf(row.payload.sellerAgent),
    aliasOf(row.payload.buyerAgent),
  ].join("|");
}

function negotiationScore(payload: PrivateNegotiationPayload): number {
  let score = 0;
  if (!payload.issuerApproved) score += 100;
  if (!isFullyAccepted(payload)) score += 40;
  if (hasSubmittedTerms(payload)) score += 20;
  if (isAcceptedByEither(payload)) score += 8;
  if (payload.sellerTermsRevealed) score += 2;
  if (payload.buyerTermsRevealed) score += 2;
  return score;
}

function isFullyAccepted(payload: PrivateNegotiationPayload): boolean {
  return payload.sellerAccepted && payload.buyerAccepted;
}

function isAcceptedByEither(payload: PrivateNegotiationPayload): boolean {
  return payload.sellerAccepted || payload.buyerAccepted;
}

function isNegotiationClosed(payload: PrivateNegotiationPayload): boolean {
  return isFullyAccepted(payload);
}

function isNegotiationLive(payload: PrivateNegotiationPayload): boolean {
  return !payload.issuerApproved;
}

function hasSubmittedTerms(payload: PrivateNegotiationPayload): boolean {
  return optionalToNumber(payload.proposedQty) !== null && optionalToNumber(payload.proposedUnitPrice) !== null;
}

function collapseNegotiationLanes(
  rows: Array<ContractRecord<PrivateNegotiationPayload>>,
): Array<ContractRecord<PrivateNegotiationPayload>> {
  const byLane = new Map<string, ContractRecord<PrivateNegotiationPayload>>();
  for (const row of rows) {
    const key = negotiationLaneKey(row);
    const existing = byLane.get(key);
    if (!existing) {
      byLane.set(key, row);
      continue;
    }
    const existingScore = negotiationScore(existing.payload);
    const nextScore = negotiationScore(row.payload);
    if (nextScore > existingScore || (nextScore === existingScore && row.contractId > existing.contractId)) {
      byLane.set(key, row);
    }
  }
  return Array.from(byLane.values());
}

function pickBestNegotiation(
  rows: Array<ContractRecord<PrivateNegotiationPayload>>,
  preferredContractId: string,
  preferredInstrument?: string | null,
): ContractRecord<PrivateNegotiationPayload> | null {
  const liveRows = rows.filter((row) => isNegotiationLive(row.payload));
  if (!liveRows.length) return null;

  const byCid = liveRows.find((row) => row.contractId === preferredContractId);
  if (byCid) return byCid;

  const normalizedInstrument = preferredInstrument ? normalizeInstrument(preferredInstrument) : null;
  const candidates = normalizedInstrument
    ? liveRows.filter((row) => normalizeInstrument(row.payload.instrument) === normalizedInstrument)
    : liveRows;
  if (!candidates.length) return null;

  const sorted = [...candidates].sort((left, right) => {
    const scoreDelta = negotiationScore(right.payload) - negotiationScore(left.payload);
    if (scoreDelta !== 0) return scoreDelta;
    return right.contractId.localeCompare(left.contractId);
  });
  return sorted[0] ?? null;
}

interface DetectedCompletion {
  contractId: string;
  instrument: string;
  quantity: number | null;
  unitPrice: number | null;
  seller: string;
  buyer: string;
  detectedAt: string;
}

interface OutsiderAcceptedSignal {
  contractId: string;
  instrument: string;
  quantity: number | null;
  unitPrice: number | null;
  detectedAt: string;
  source: "Live Detection" | "Ledger Snapshot";
}

export default function App() {
  const { availableParties } = usePartyContext();

  const [view, setView] = useState<RoleView>("Landing");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [tradeIntents, setTradeIntents] = useState<Array<ContractRecord<TradeIntentPayload>>>([]);
  const [sellerNegotiations, setSellerNegotiations] = useState<Array<ContractRecord<PrivateNegotiationPayload>>>([]);
  const [buyerNegotiations, setBuyerNegotiations] = useState<Array<ContractRecord<PrivateNegotiationPayload>>>([]);
  const [companyNegotiations, setCompanyNegotiations] = useState<Array<ContractRecord<PrivateNegotiationPayload>>>([]);
  const [outsiderIntents, setOutsiderIntents] = useState<Array<ContractRecord<TradeIntentPayload>>>([]);
  const [outsiderNegotiations, setOutsiderNegotiations] = useState<Array<ContractRecord<PrivateNegotiationPayload>>>([]);
  const [outsiderSettlements, setOutsiderSettlements] = useState<Array<ContractRecord<TradeSettlementPayload>>>([]);
  const [outsiderAudits, setOutsiderAudits] = useState<Array<ContractRecord<TradeAuditRecordPayload>>>([]);
  const [detectedCompletions, setDetectedCompletions] = useState<DetectedCompletion[]>([]);
  const seenAcceptedCidsRef = useRef<Set<string>>(new Set());
  const outsiderDetectionInitializedRef = useRef(false);
  const outsiderViewPrimedRef = useRef(false);

  const seller = useMemo(() => resolveAlias(availableParties, "Seller"), [availableParties]);
  const sellerAgent = useMemo(() => resolveAlias(availableParties, "SellerAgent"), [availableParties]);
  const buyer = useMemo(() => resolveAlias(availableParties, "Buyer"), [availableParties]);
  const buyerAgent = useMemo(() => resolveAlias(availableParties, "BuyerAgent"), [availableParties]);
  const company = useMemo(() => resolveAlias(availableParties, "Company"), [availableParties]);
  const outsider = useMemo(() => resolveAlias(availableParties, "Outsider"), [availableParties]);

  const [instrument, setInstrument] = useState("COMPANY-SERIES-A");
  const [quantity, setQuantity] = useState("1200");
  const [minPrice, setMinPrice] = useState("98");

  const [sellerChoice, setSellerChoice] = useState<SellerChoice>("SubmitSellerTerms");
  const [buyerChoice, setBuyerChoice] = useState<BuyerChoice>("SubmitBuyerTerms");
  const [sellerNegotiationCid, setSellerNegotiationCid] = useState("");
  const [buyerNegotiationCid, setBuyerNegotiationCid] = useState("");
  const [sellerLastGeneratedCid, setSellerLastGeneratedCid] = useState<string | null>(null);
  const [buyerLastGeneratedCid, setBuyerLastGeneratedCid] = useState<string | null>(null);
  const [selectedIntentInstrument, setSelectedIntentInstrument] = useState<string | null>(null);
  const [negotiationQty, setNegotiationQty] = useState("1000");
  const [negotiationPrice, setNegotiationPrice] = useState("99");
  const [negotiationSide, setNegotiationSide] = useState<"Buy" | "Sell">("Sell");
  const [negotiationSalt, setNegotiationSalt] = useState("simple-demo-salt");
  const startupResetDone = useRef(false);

  const sellerNegotiationsForSelection = useMemo(
    () => collapseNegotiationLanes(sellerNegotiations.filter((row) =>
      isNegotiationLive(row.payload))),
    [sellerNegotiations],
  );

  const buyerNegotiationsCollapsed = useMemo(
    () => collapseNegotiationLanes(buyerNegotiations.filter((row) =>
      isNegotiationLive(row.payload))),
    [buyerNegotiations],
  );

  const acceptedForOutsider = useMemo(
    () => companyNegotiations.filter((row) => isNegotiationClosed(row.payload)),
    [companyNegotiations],
  );
  const completedTotalDisplay = acceptedForOutsider.length;
  const outsiderAcceptedSignals = useMemo<OutsiderAcceptedSignal[]>(() => {
    const seen = new Set<string>();
    const signals: OutsiderAcceptedSignal[] = [];

    for (const row of detectedCompletions) {
      if (seen.has(row.contractId)) continue;
      seen.add(row.contractId);
      signals.push({
        contractId: row.contractId,
        instrument: row.instrument,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        detectedAt: row.detectedAt,
        source: "Live Detection",
      });
    }

    for (const row of acceptedForOutsider) {
      if (seen.has(row.contractId)) continue;
      seen.add(row.contractId);
      signals.push({
        contractId: row.contractId,
        instrument: row.payload.instrument,
        quantity: optionalToNumber(row.payload.proposedQty),
        unitPrice: optionalToNumber(row.payload.proposedUnitPrice),
        detectedAt: row.payload.expiresAt,
        source: "Ledger Snapshot",
      });
    }

    return signals
      .sort((left, right) => {
        const leftPriority = left.source === "Live Detection" ? 0 : 1;
        const rightPriority = right.source === "Live Detection" ? 0 : 1;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        return right.detectedAt.localeCompare(left.detectedAt);
      })
      .slice(0, 8);
  }, [acceptedForOutsider, detectedCompletions]);

  const selectedSellerNegotiation = useMemo(
    () => sellerNegotiationsForSelection.find((row) => row.contractId === sellerNegotiationCid) ?? null,
    [sellerNegotiationCid, sellerNegotiationsForSelection],
  );

  const buyerNegotiationsForSelection = useMemo(() => {
    if (!selectedIntentInstrument) return buyerNegotiationsCollapsed;
    const normalized = normalizeInstrument(selectedIntentInstrument);
    return buyerNegotiationsCollapsed.filter(
      (row) => normalizeInstrument(row.payload.instrument) === normalized,
    );
  }, [buyerNegotiationsCollapsed, selectedIntentInstrument]);

  const selectedBuyerNegotiation = useMemo(
    () => buyerNegotiationsForSelection.find((row) => row.contractId === buyerNegotiationCid) ?? null,
    [buyerNegotiationCid, buyerNegotiationsForSelection],
  );

  useEffect(() => {
    if (!sellerNegotiationCid) {
      return;
    }
    if (!sellerNegotiationsForSelection.some((row) => row.contractId === sellerNegotiationCid)) {
      setSellerNegotiationCid("");
    }
  }, [sellerNegotiationCid, sellerNegotiationsForSelection]);

  useEffect(() => {
    if (!buyerNegotiationCid) {
      return;
    }
    if (!buyerNegotiationsForSelection.some((row) => row.contractId === buyerNegotiationCid)) {
      setBuyerNegotiationCid("");
    }
  }, [buyerNegotiationCid, buyerNegotiationsForSelection]);

  const refreshLedger = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [intents, sellerNeg, buyerNeg, companyNeg, outIntents, outNeg, outSettle, outAudit] = await Promise.all([
        queryTradeIntents(seller),
        queryPrivateNegotiations(sellerAgent),
        queryPrivateNegotiations(buyerAgent),
        queryPrivateNegotiations(company),
        queryTradeIntents(outsider),
        queryPrivateNegotiations(outsider),
        queryTradeSettlements(outsider),
        queryAuditRecords(outsider),
      ]);

      setTradeIntents(intents);
      setSellerNegotiations(sellerNeg);
      setBuyerNegotiations(buyerNeg);
      setCompanyNegotiations(companyNeg);
      setOutsiderIntents(outIntents);
      setOutsiderNegotiations(outNeg);
      setOutsiderSettlements(outSettle);
      setOutsiderAudits(outAudit);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [buyerAgent, company, outsider, seller, sellerAgent]);

  useEffect(() => {
    if (view === "Outsider") {
      if (outsiderViewPrimedRef.current) {
        return;
      }
      seenAcceptedCidsRef.current = new Set(acceptedForOutsider.map((row) => row.contractId));
      outsiderDetectionInitializedRef.current = true;
      setDetectedCompletions([]);
      outsiderViewPrimedRef.current = true;
      return;
    }
    outsiderViewPrimedRef.current = false;
  }, [acceptedForOutsider, view]);

  useEffect(() => {
    if (view !== "Outsider" || loading) {
      return;
    }

    const seen = seenAcceptedCidsRef.current;
    if (!outsiderDetectionInitializedRef.current) {
      acceptedForOutsider.forEach((row) => seen.add(row.contractId));
      outsiderDetectionInitializedRef.current = true;
      return;
    }

    const newRows = acceptedForOutsider.filter((row) => !seen.has(row.contractId));
    if (newRows.length === 0) {
      return;
    }

    const detectedAt = new Date().toISOString();
    const additions: DetectedCompletion[] = newRows.map((row) => ({
      contractId: row.contractId,
      instrument: row.payload.instrument,
      quantity: optionalToNumber(row.payload.proposedQty),
      unitPrice: optionalToNumber(row.payload.proposedUnitPrice),
      seller: row.payload.seller,
      buyer: row.payload.buyer,
      detectedAt,
    }));

    newRows.forEach((row) => seen.add(row.contractId));
    setDetectedCompletions((prev) => [...additions, ...prev].slice(0, 20));
  }, [acceptedForOutsider, loading, view]);

  useEffect(() => {
    if (startupResetDone.current) {
      return;
    }
    startupResetDone.current = true;

    void (async () => {
      try {
        const existingIntents = await queryTradeIntents(seller);
        await Promise.all(existingIntents.map((intent) => exerciseChoice(
          seller,
          TEMPLATE_IDS.tradeIntent,
          intent.contractId,
          "ArchiveIntent",
          {},
        )));
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
      } finally {
        await refreshLedger();
      }
    })();

    return () => {};
  }, [refreshLedger, seller]);

  useEffect(() => {
    if (view !== "Outsider") return;
    const timer = window.setInterval(() => {
      if (!busy) void refreshLedger();
    }, 2000);
    return () => {
      window.clearInterval(timer);
    };
  }, [busy, refreshLedger, view]);

  const runAction = useCallback(async (description: string, action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await action();
      setStatus(description);
      await refreshLedger();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await refreshLedger();
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(normalizeLedgerError(message));
      return false;
    } finally {
      setBusy(false);
    }
  }, [refreshLedger]);

  const createTradeIntent = useCallback(async () => {
    await runAction("Trade intent created.", async () => {
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
  }, [buyer, company, instrument, minPrice, quantity, runAction, seller, sellerAgent]);

  const negotiationArgument = useCallback(async (choice: SellerChoice | BuyerChoice): Promise<Record<string, unknown>> => {
    const qtyDecimal = parsePositiveDecimal(negotiationQty);
    const priceDecimal = parsePositiveDecimal(negotiationPrice);

    if (choice === "SubmitSellerTerms" || choice === "SubmitBuyerTerms") {
      if (!qtyDecimal || !priceDecimal) {
        throw new Error("Enter valid positive decimal qty and unit price.");
      }
      return {
        qty: qtyDecimal,
        unitPrice: priceDecimal,
      };
    }

    if (choice === "CommitTerms") {
      if (!qtyDecimal || !priceDecimal) {
        throw new Error("Enter valid positive decimal qty and unit price.");
      }
      const qtyText = qtyDecimal;
      const priceText = priceDecimal;
      const commitmentHash = await sha256Hex(`${qtyText}|${priceText}|${negotiationSalt}`);
      return {
        side: { tag: negotiationSide, value: {} },
        commitmentHash,
      };
    }

    if (choice === "RevealTerms") {
      if (!qtyDecimal || !priceDecimal) {
        throw new Error("Enter valid positive decimal qty and unit price.");
      }
      return {
        side: { tag: negotiationSide, value: {} },
        qtyText: qtyDecimal,
        unitPriceText: priceDecimal,
        salt: negotiationSalt,
      };
    }

    return {};
  }, [negotiationPrice, negotiationQty, negotiationSalt, negotiationSide]);

  const pickActiveNegotiation = useCallback((
    rows: Array<ContractRecord<PrivateNegotiationPayload>>,
    preferredContractId: string,
    preferredInstrument?: string | null,
  ): ContractRecord<PrivateNegotiationPayload> | null => {
    return pickBestNegotiation(rows, preferredContractId, preferredInstrument);
  }, []);

  const waitForNegotiationVisibility = useCallback(async (
    partyForQuery: string,
    instrumentName: string,
    preferredCid?: string | null,
  ): Promise<{
    rows: Array<ContractRecord<PrivateNegotiationPayload>>;
    match: ContractRecord<PrivateNegotiationPayload>;
  } | null> => {
    const normalized = normalizeInstrument(instrumentName);
    const targetCid = preferredCid ?? "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const rows = await queryPrivateNegotiations(partyForQuery);
      const match = pickBestNegotiation(rows, targetCid, normalized);
      if (match) {
        return { rows, match };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }, []);

  const runSellerAction = useCallback(async (choice?: SellerChoice): Promise<boolean> => {
    const effectiveChoice = choice ?? sellerChoice;

    if (NEGOTIATION_FIELD_CHOICES.includes(effectiveChoice)) {
      if (!isValidPositiveNumber(negotiationQty) || !isValidPositiveNumber(negotiationPrice)) {
        setError("Enter valid positive qty and unit price before negotiating.");
        return false;
      }
    }

    return runAction(`Seller action ${effectiveChoice} executed.`, async () => {
      const maxAttempts = 6;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const liveRows = await queryPrivateNegotiations(sellerAgent);
        setSellerNegotiations(liveRows);
        const live = pickActiveNegotiation(
          liveRows,
          sellerNegotiationCid,
          selectedSellerNegotiation?.payload.instrument ?? null,
        );
        if (!live) {
          if (attempt < maxAttempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            continue;
          }
          throw new Error("No seller-side negotiation available. Try Buyer -> Negotiate first, then Refresh.");
        }
        setSellerNegotiationCid(live.contractId);

        const arg = await negotiationArgument(effectiveChoice);
        try {
          const exerciseResult = await exerciseChoice(
            sellerAgent,
            TEMPLATE_IDS.privateNegotiation,
            live.contractId,
            effectiveChoice,
            arg,
          );
          const nextCid = typeof exerciseResult === "string" ? exerciseResult : "";
          if (nextCid) {
            const visible = await waitForNegotiationVisibility(sellerAgent, live.payload.instrument, nextCid);
            const resolvedNextCid = visible ? visible.match.contractId : nextCid;
            setSellerLastGeneratedCid(resolvedNextCid);
            if (visible) {
              setSellerNegotiations(visible.rows);
              setSellerNegotiationCid(resolvedNextCid);
            } else {
              setSellerNegotiationCid(resolvedNextCid);
            }
          }
          return;
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason);
          if (!isLockedContractError(message) || attempt === maxAttempts - 1) {
            throw reason;
          }
          await new Promise((resolve) => setTimeout(resolve, 1100));
        }
      }
    });
  }, [
    sellerChoice,
    negotiationQty,
    negotiationPrice,
    negotiationArgument,
    runAction,
    sellerAgent,
    sellerNegotiationCid,
    selectedSellerNegotiation,
    pickActiveNegotiation,
    waitForNegotiationVisibility,
  ]);

  const runBuyerAction = useCallback(async (choice?: BuyerChoice): Promise<boolean> => {
    const effectiveChoice = choice ?? buyerChoice;

    if (NEGOTIATION_FIELD_CHOICES.includes(effectiveChoice)) {
      if (!isValidPositiveNumber(negotiationQty) || !isValidPositiveNumber(negotiationPrice)) {
        setError("Enter valid positive qty and unit price before negotiating.");
        return false;
      }
    }

    return runAction(`Buyer action ${effectiveChoice} executed.`, async () => {
      const maxAttempts = 6;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const liveRows = await queryPrivateNegotiations(buyerAgent);
        setBuyerNegotiations(liveRows);
        const live = pickActiveNegotiation(
          liveRows,
          buyerNegotiationCid,
          selectedBuyerNegotiation?.payload.instrument ?? selectedIntentInstrument,
        );
        if (!live) {
          if (attempt < maxAttempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            continue;
          }
          throw new Error("No buyer-side negotiation available. Start from Trade Intents -> Negotiate.");
        }
        setBuyerNegotiationCid(live.contractId);

        const arg = await negotiationArgument(effectiveChoice);
        try {
          const exerciseResult = await exerciseChoice(
            buyerAgent,
            TEMPLATE_IDS.privateNegotiation,
            live.contractId,
            effectiveChoice,
            arg,
          );
          const nextCid = typeof exerciseResult === "string" ? exerciseResult : "";
          if (nextCid) {
            const visible = await waitForNegotiationVisibility(buyerAgent, live.payload.instrument, nextCid);
            const resolvedNextCid = visible ? visible.match.contractId : nextCid;
            setBuyerLastGeneratedCid(resolvedNextCid);
            if (visible) {
              setBuyerNegotiations(visible.rows);
              setSelectedIntentInstrument(visible.match.payload.instrument);
              setBuyerNegotiationCid(resolvedNextCid);
            } else {
              setSelectedIntentInstrument(live.payload.instrument);
              setBuyerNegotiationCid(resolvedNextCid);
            }
          }
          return;
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason);
          if (!isLockedContractError(message) || attempt === maxAttempts - 1) {
            throw reason;
          }
          await new Promise((resolve) => setTimeout(resolve, 1100));
        }
      }
    });
  }, [
    buyerChoice,
    negotiationQty,
    negotiationPrice,
    negotiationArgument,
    runAction,
    buyerAgent,
    buyerNegotiationCid,
    selectedBuyerNegotiation,
    selectedIntentInstrument,
    pickActiveNegotiation,
    waitForNegotiationVisibility,
  ]);

  const runBuyerNegotiate = useCallback(async () => {
    await runBuyerAction("SubmitBuyerTerms");
  }, [runBuyerAction]);

  const runSellerNegotiate = useCallback(async () => {
    await runSellerAction("SubmitSellerTerms");
  }, [runSellerAction]);

  const runSellerAcceptOffer = useCallback(async () => {
    if (!selectedSellerNegotiation) {
      setError("No seller-side negotiation contract available yet.");
      return;
    }
    if (!hasSubmittedTerms(selectedSellerNegotiation.payload)) {
      setError("Cannot accept yet. Submit terms first using Negotiate.");
      return;
    }
    const accepted = await runSellerAction("AcceptBySeller");
    if (!accepted) return;
  }, [runSellerAction, selectedSellerNegotiation]);

  const runBuyerAcceptOffer = useCallback(async () => {
    if (!selectedBuyerNegotiation) {
      setError("No buyer-side negotiation contract available yet.");
      return;
    }
    if (!hasSubmittedTerms(selectedBuyerNegotiation.payload)) {
      setError("Cannot accept yet. Submit terms first using Negotiate.");
      return;
    }
    const accepted = await runBuyerAction("AcceptByBuyer");
    if (!accepted) return;
  }, [runBuyerAction, selectedBuyerNegotiation]);

  const runBuyerNegotiateFromIntent = useCallback(async (intent: ContractRecord<TradeIntentPayload>) => {
    const qty = optionalToNumber(intent.payload.quantity);
    const price = optionalToNumber(intent.payload.minPrice);
    if (qty === null || price === null || qty <= 0 || price <= 0) {
      setError("Intent has invalid qty/price and cannot be used for negotiation.");
      return;
    }

    setNegotiationQty(String(qty));
    setNegotiationPrice(String(price));
    setNegotiationSide("Buy");
    setBuyerChoice("SubmitBuyerTerms");

    await runAction(`Negotiation setup for ${intent.payload.instrument}.`, async () => {
      const liveRows = await queryPrivateNegotiations(buyerAgent);
      setBuyerNegotiations(liveRows);
      const normalizedInstrument = normalizeInstrument(intent.payload.instrument);
      const match = pickBestNegotiation(liveRows, "", normalizedInstrument);

      if (!match || !hasSubmittedTerms(match.payload)) {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const payload: Record<string, unknown> = {
          issuer: company,
          seller,
          sellerAgent,
          buyer,
          buyerAgent,
          instrument: intent.payload.instrument,
          // Seed negotiation with seller intent terms so buyer can accept directly.
          proposedQty: qty,
          proposedUnitPrice: price,
          sellerAccepted: true,
          buyerAccepted: false,
          issuerApproved: false,
          expiresAt,
          sellerCommitmentHash: null,
          buyerCommitmentHash: null,
          sellerTermsRevealed: false,
          buyerTermsRevealed: false,
        };
        const created = await createContract<PrivateNegotiationPayload>(
          company,
          TEMPLATE_IDS.privateNegotiation,
          payload,
        );
        const visible = await waitForNegotiationVisibility(buyerAgent, intent.payload.instrument, created.contractId);
        if (visible) {
          setBuyerNegotiations(visible.rows);
          setSelectedIntentInstrument(intent.payload.instrument);
          setBuyerLastGeneratedCid(visible.match.contractId);
          setBuyerNegotiationCid(visible.match.contractId);
        } else {
          setSelectedIntentInstrument(intent.payload.instrument);
          setBuyerLastGeneratedCid(created.contractId);
          setBuyerNegotiationCid(created.contractId);
        }
      } else {
        const visible = await waitForNegotiationVisibility(buyerAgent, intent.payload.instrument, match.contractId);
        if (visible) {
          setBuyerNegotiations(visible.rows);
          setSelectedIntentInstrument(intent.payload.instrument);
          setBuyerNegotiationCid(visible.match.contractId);
        } else {
          setSelectedIntentInstrument(intent.payload.instrument);
          setBuyerNegotiationCid(match.contractId);
        }
      }
    });
  }, [buyer, buyerAgent, company, runAction, seller, sellerAgent, waitForNegotiationVisibility]);

  const selectedTerms = (payload: PrivateNegotiationPayload) => {
    const qty = optionalToNumber(payload.proposedQty);
    const price = optionalToNumber(payload.proposedUnitPrice);
    if (qty === null || price === null) return "No price/qty terms submitted yet.";
    return `Qty ${qty} @ ${price}`;
  };

  const copyContractId = useCallback(async (contractId: string) => {
    try {
      await navigator.clipboard.writeText(contractId);
      setStatus(`Copied contract ID ${shortId(contractId)}.`);
      setError(null);
    } catch {
      setError("Unable to copy contract ID. Clipboard permission may be blocked.");
    }
  }, []);

  const suggestedIntentCid = useMemo(() => tradeIntents[0]?.contractId ?? "", [tradeIntents]);
  const suggestedNegotiationCid = useMemo(() => {
    return selectedSellerNegotiation?.contractId
      ?? selectedBuyerNegotiation?.contractId
      ?? sellerNegotiationsForSelection[0]?.contractId
      ?? buyerNegotiationsForSelection[0]?.contractId
      ?? companyNegotiations[0]?.contractId
      ?? "";
  }, [
    buyerNegotiationsForSelection,
    companyNegotiations,
    selectedBuyerNegotiation,
    selectedSellerNegotiation,
    sellerNegotiationsForSelection,
  ]);

  const sellerCanAccept = selectedSellerNegotiation
    ? hasSubmittedTerms(selectedSellerNegotiation.payload) && !selectedSellerNegotiation.payload.sellerAccepted
    : false;
  const buyerCanAccept = selectedBuyerNegotiation
    ? hasSubmittedTerms(selectedBuyerNegotiation.payload) && !selectedBuyerNegotiation.payload.buyerAccepted
    : false;

  return (
    <main className="app-shell mx-auto max-w-7xl px-4 py-8 md:px-8 lg:py-10">
      <section className="app-panel panel-sheen relative overflow-hidden rounded-[1.75rem] border border-shell-700 bg-white/80 p-6 shadow-soft">
        <div className="pointer-events-none absolute -right-12 -top-14 h-40 w-40 rounded-full bg-signal-mint/20 blur-3xl" />
        <div className="pointer-events-none absolute -left-16 bottom-0 h-36 w-36 rounded-full bg-[#46a8c9]/20 blur-3xl" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">DarkLedger</p>
            <h1 className="mt-1 text-3xl font-bold text-shell-950">Private Trading Console</h1>
            <p className="mt-2 text-sm text-signal-slate">
              Confidential negotiation flow with selective visibility, issuer control, and auditable settlement outcomes.
            </p>
          </div>
          <button
            className="rounded-xl border border-shell-700/75 bg-white/75 px-3 py-2 text-sm font-semibold text-shell-950 shadow-soft"
            onClick={() => void refreshLedger()}
            disabled={busy || loading}
          >
            Refresh
          </button>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {(["Landing", "DarkAuction", "Seller", "Buyer", "Outsider", "Inspector", "Challenge"] as RoleView[]).map((role) => (
            <button
              key={role}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${statusPillClass(view === role)}`}
              onClick={() => setView(role)}
            >
              {role === "Landing"
                ? "Home"
                : role === "DarkAuction"
                  ? "Dark Auction"
                  : `${role} View`}
            </button>
          ))}
        </div>

        {status ? <p className="mt-4 rounded-lg bg-signal-mint/15 px-3 py-2 text-sm text-shell-950">{status}</p> : null}
        {error ? <p className="mt-4 rounded-lg bg-signal-coral/15 px-3 py-2 text-sm text-signal-coral">{error}</p> : null}
        {loading ? <p className="mt-4 text-sm text-signal-slate">Refreshing ledger data...</p> : null}
      </section>

      {view === "Landing" ? (
        <LandingPage
          onOpenConsole={() => setView("Seller")}
          onOpenInspector={() => setView("Inspector")}
          onOpenDarkAuction={() => setView("DarkAuction")}
        />
      ) : null}

      {view === "DarkAuction" ? <DarkAuctionView /> : null}

      {view === "Seller" ? (
        <section className="mt-6 grid animate-fade-rise gap-6 lg:grid-cols-2">
          <article className="rounded-2xl border border-shell-700 bg-white p-5">
            <h2 className="text-xl font-semibold text-shell-950">Create Trade Intent</h2>
            <p className="mt-1 text-sm text-signal-slate">Seller creates intents. This is the only creation form in this UI.</p>

            <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
              Instrument
              <input
                className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={instrument}
                onChange={(event) => setInstrument(event.target.value)}
              />
            </label>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
                Quantity
                <input
                  className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
                Min Price
                <input
                  className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                  value={minPrice}
                  onChange={(event) => setMinPrice(event.target.value)}
                />
              </label>
            </div>

            <button
              className="mt-4 w-full rounded-md bg-shell-950 px-4 py-2 text-sm font-semibold text-shell-900"
              onClick={() => void createTradeIntent()}
              disabled={busy}
            >
              Create Trade Intent
            </button>

            <div className="mt-5">
              <p className="text-sm font-semibold text-shell-950">Current Seller Intents ({tradeIntents.length})</p>
              <div className="mt-2 space-y-2">
                {tradeIntents.slice(0, 5).map((intent) => (
                  <div key={intent.contractId} className="rounded-md border border-shell-700/70 px-3 py-2 text-sm text-signal-slate">
                    <div className="font-semibold text-shell-950">{intent.payload.instrument}</div>
                    <div>Qty {optionalToNumber(intent.payload.quantity)} | Min {optionalToNumber(intent.payload.minPrice)}</div>
                    <div className="mt-2 rounded-md border border-shell-700/60 bg-shell-900/30 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-signal-slate">Contract ID</span>
                        <button
                          className="rounded border border-shell-700 bg-white px-2 py-1 text-[11px] font-semibold text-shell-950"
                          onClick={() => void copyContractId(intent.contractId)}
                          type="button"
                        >
                          Copy CID
                        </button>
                      </div>
                      <code className="mt-1 block break-all text-xs font-mono text-shell-950">{intent.contractId}</code>
                    </div>
                  </div>
                ))}
                {tradeIntents.length === 0 ? <p className="text-sm text-signal-slate">No intents yet.</p> : null}
              </div>
            </div>
          </article>

          <article className="rounded-2xl border border-shell-700 bg-white p-5">
            <h2 className="text-xl font-semibold text-shell-950">Seller Negotiation</h2>
            <p className="mt-1 text-sm text-signal-slate">Seller sees buyer responses and can negotiate back.</p>

            <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
              Negotiation Contract
              <select
                className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={selectedSellerNegotiation?.contractId ?? ""}
                onChange={(event) => setSellerNegotiationCid(event.target.value)}
              >
                <option value="">Select negotiation</option>
                {sellerNegotiationsForSelection.map((row) => (
                  <option key={row.contractId} value={row.contractId}>
                    {row.payload.instrument} • {shortId(row.contractId)}
                  </option>
                ))}
              </select>
            </label>

            {selectedSellerNegotiation ? (
              <div className="mt-3 rounded-md border border-shell-700/70 bg-shell-900/30 px-3 py-2 text-sm text-signal-slate">
                <div className="font-semibold text-shell-950">{selectedSellerNegotiation.payload.instrument}</div>
                <div>{selectedTerms(selectedSellerNegotiation.payload)}</div>
                <div>
                  Seller accepted: {String(selectedSellerNegotiation.payload.sellerAccepted)} | Buyer accepted: {String(selectedSellerNegotiation.payload.buyerAccepted)}
                </div>
                <div>
                  Seller commit: {shortId(optionalText(selectedSellerNegotiation.payload.sellerCommitmentHash))}
                </div>
                <div>
                  Buyer commit: {shortId(optionalText(selectedSellerNegotiation.payload.buyerCommitmentHash))}
                </div>
                <div className="mt-2 rounded-md border border-shell-700/60 bg-white/80 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-signal-slate">Current CID</span>
                    <button
                      className="rounded border border-shell-700 bg-white px-2 py-1 text-[11px] font-semibold text-shell-950"
                      onClick={() => void copyContractId(selectedSellerNegotiation.contractId)}
                      type="button"
                    >
                      Copy CID
                    </button>
                  </div>
                  <code className="mt-1 block break-all text-xs font-mono text-shell-950">{selectedSellerNegotiation.contractId}</code>
                </div>
                {sellerLastGeneratedCid ? (
                  <div className="mt-2 rounded-md border border-signal-mint/35 bg-signal-mint/10 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-signal-slate">Last New CID</span>
                      <button
                        className="rounded border border-shell-700 bg-white px-2 py-1 text-[11px] font-semibold text-shell-950"
                        onClick={() => void copyContractId(sellerLastGeneratedCid)}
                        type="button"
                      >
                        Copy CID
                      </button>
                    </div>
                    <code className="mt-1 block break-all text-xs font-mono text-shell-950">{sellerLastGeneratedCid}</code>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-sm text-signal-slate">
                {sellerNegotiationsForSelection.length > 0
                  ? "Select a negotiation to continue."
                  : "No seller-visible negotiations yet."}
              </p>
            )}

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
                Qty
                <input
                  className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                  value={negotiationQty}
                  onChange={(event) => setNegotiationQty(event.target.value)}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
                Unit Price
                <input
                  className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                  value={negotiationPrice}
                  onChange={(event) => setNegotiationPrice(event.target.value)}
                />
              </label>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button
                className="rounded-md border border-shell-700 px-4 py-2 text-sm font-semibold text-shell-950"
                onClick={() => void runSellerAcceptOffer()}
                disabled={busy || !selectedSellerNegotiation || !sellerCanAccept}
              >
                Accept Offer
              </button>
              <button
                className="rounded-md border border-shell-700 px-4 py-2 text-sm font-semibold text-shell-950"
                onClick={() => void runSellerNegotiate()}
                disabled={busy || !selectedSellerNegotiation}
              >
                Negotiate
              </button>
            </div>
            {selectedSellerNegotiation && !hasSubmittedTerms(selectedSellerNegotiation.payload) ? (
              <p className="mt-2 text-xs text-signal-slate">Accept is disabled until qty and unit price terms exist.</p>
            ) : null}
          </article>
        </section>
      ) : null}

      {view === "Buyer" ? (
        <section className="mt-6 grid animate-fade-rise gap-6 lg:grid-cols-2">
          <article className="rounded-2xl border border-shell-700 bg-white p-5 lg:col-span-2">
            <h2 className="text-xl font-semibold text-shell-950">All Trade Intents</h2>
            <p className="mt-1 text-sm text-signal-slate">
              Buyer can review every seller intent and jump straight into negotiation.
            </p>
            <div className="mt-3 grid gap-2">
              {tradeIntents.map((intent) => {
                return (
                  <div key={intent.contractId} className="rounded-md border border-shell-700/70 px-3 py-2 text-sm">
                    <div className="font-semibold text-shell-950">{intent.payload.instrument}</div>
                    <div className="text-signal-slate">
                      Qty {optionalToNumber(intent.payload.quantity)} | Min {optionalToNumber(intent.payload.minPrice)}
                    </div>
                    <div className="mt-2">
                      <button
                        className="rounded-md border border-shell-700 px-3 py-1 text-xs font-semibold text-shell-950 disabled:cursor-not-allowed disabled:text-signal-slate"
                        onClick={() => void runBuyerNegotiateFromIntent(intent)}
                        disabled={busy}
                      >
                        Negotiate
                      </button>
                    </div>
                  </div>
                );
              })}
              {tradeIntents.length === 0 ? <p className="text-sm text-signal-slate">No trade intents available.</p> : null}
            </div>
          </article>

          <article className="rounded-2xl border border-shell-700 bg-white p-5 lg:col-span-2">
            <h2 className="text-xl font-semibold text-shell-950">Buyer Negotiation View</h2>
            <p className="mt-1 text-sm text-signal-slate">
              Buyer sees seller proposals on each negotiation and can counter, commit/reveal, accept, or reject.
            </p>

            <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
              Negotiation Contract
              <select
                className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={selectedBuyerNegotiation?.contractId ?? ""}
                onChange={(event) => setBuyerNegotiationCid(event.target.value)}
                disabled={buyerNegotiationsForSelection.length === 0}
              >
                <option value="">Select negotiation</option>
                {buyerNegotiationsForSelection.map((row) => (
                  <option key={row.contractId} value={row.contractId}>
                    {row.payload.instrument} • {shortId(row.contractId)}
                  </option>
                ))}
              </select>
            </label>
            {selectedIntentInstrument ? (
              <p className="mt-2 text-xs text-signal-slate">
                Scoped to intent instrument: <span className="font-semibold text-shell-950">{selectedIntentInstrument}</span>
              </p>
            ) : null}

            {selectedBuyerNegotiation ? (
              <div className="mt-3 rounded-md border border-shell-700/70 bg-shell-900/30 px-3 py-2 text-sm text-signal-slate">
                <div className="font-semibold text-shell-950">{selectedBuyerNegotiation.payload.instrument}</div>
                <div>{selectedTerms(selectedBuyerNegotiation.payload)}</div>
                <div>
                  Seller accepted: {String(selectedBuyerNegotiation.payload.sellerAccepted)} | Buyer accepted: {String(selectedBuyerNegotiation.payload.buyerAccepted)}
                </div>
                <div>
                  Reveal status: seller={String(selectedBuyerNegotiation.payload.sellerTermsRevealed)} buyer={String(selectedBuyerNegotiation.payload.buyerTermsRevealed)}
                </div>
                <div className="mt-2 rounded-md border border-shell-700/60 bg-white/80 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-signal-slate">Current CID</span>
                    <button
                      className="rounded border border-shell-700 bg-white px-2 py-1 text-[11px] font-semibold text-shell-950"
                      onClick={() => void copyContractId(selectedBuyerNegotiation.contractId)}
                      type="button"
                    >
                      Copy CID
                    </button>
                  </div>
                  <code className="mt-1 block break-all text-xs font-mono text-shell-950">{selectedBuyerNegotiation.contractId}</code>
                </div>
                {buyerLastGeneratedCid ? (
                  <div className="mt-2 rounded-md border border-signal-mint/35 bg-signal-mint/10 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-signal-slate">Last New CID</span>
                      <button
                        className="rounded border border-shell-700 bg-white px-2 py-1 text-[11px] font-semibold text-shell-950"
                        onClick={() => void copyContractId(buyerLastGeneratedCid)}
                        type="button"
                      >
                        Copy CID
                      </button>
                    </div>
                    <code className="mt-1 block break-all text-xs font-mono text-shell-950">{buyerLastGeneratedCid}</code>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-sm text-signal-slate">
                {buyerNegotiationsForSelection.length > 0
                  ? "Select a negotiation to continue."
                  : selectedIntentInstrument
                    ? `No negotiation exists yet for ${selectedIntentInstrument}.`
                    : "No buyer-visible negotiations yet."}
              </p>
            )}

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
                Qty
                <input
                  className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                  value={negotiationQty}
                  onChange={(event) => setNegotiationQty(event.target.value)}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
                Unit Price
                <input
                  className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                  value={negotiationPrice}
                  onChange={(event) => setNegotiationPrice(event.target.value)}
                />
              </label>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button
                className="rounded-md border border-shell-700 px-4 py-2 text-sm font-semibold text-shell-950"
                onClick={() => void runBuyerAcceptOffer()}
                disabled={busy || !selectedBuyerNegotiation || !buyerCanAccept}
              >
                Accept Offer
              </button>
              <button
                className="rounded-md border border-shell-700 px-4 py-2 text-sm font-semibold text-shell-950"
                onClick={() => void runBuyerNegotiate()}
                disabled={busy || !selectedBuyerNegotiation}
              >
                Negotiate
              </button>
            </div>
            {selectedBuyerNegotiation && !hasSubmittedTerms(selectedBuyerNegotiation.payload) ? (
              <p className="mt-2 text-xs text-signal-slate">Accept is disabled until qty and unit price terms exist.</p>
            ) : null}
          </article>
        </section>
      ) : null}

      {view === "Outsider" ? (
        <section className="mt-6 animate-fade-rise">
          <article className="rounded-2xl border border-shell-700 bg-white p-5">
            <h2 className="text-xl font-semibold text-shell-950">Outsider Outcome Signal</h2>
            <p className="mt-1 text-sm text-signal-slate">Auto-refreshes every 2 seconds while this view is open.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-1">
              <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 p-4 text-sm text-signal-slate">
                <div className="text-xs uppercase tracking-[0.12em]">Completed (Total)</div>
                <div className="mt-1 text-2xl font-semibold text-shell-950">{completedTotalDisplay}</div>
              </div>
            </div>

            <div className="mt-5">
              <p className="text-sm font-semibold text-shell-950">Live Accepted Feed</p>
              <div className="mt-2 space-y-2">
                {detectedCompletions.slice(0, 5).map((row) => (
                  <div key={`${row.contractId}-live`} className="rounded-md border border-signal-mint/35 bg-signal-mint/10 px-3 py-2 text-sm text-signal-slate">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-shell-950">{row.instrument}</div>
                      <span className="rounded-full border border-signal-mint/40 bg-white px-2 py-1 text-[11px] text-signal-mint">
                        just detected
                      </span>
                    </div>
                    <div className="mt-1">Qty {row.quantity ?? "-"} | Unit {row.unitPrice ?? "-"}</div>
                    <div className="mt-2 rounded-md border border-signal-mint/35 bg-white/85 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-signal-slate">Contract ID</span>
                        <button
                          className="rounded border border-shell-700 bg-white px-2 py-1 text-[11px] font-semibold text-shell-950"
                          onClick={() => void copyContractId(row.contractId)}
                          type="button"
                        >
                          Copy CID
                        </button>
                      </div>
                      <code className="mt-1 block break-all text-xs font-mono text-shell-950">{row.contractId}</code>
                    </div>
                  </div>
                ))}
                {detectedCompletions.length === 0 ? (
                  <p className="text-sm text-signal-slate">No new accepted outcomes detected in this session yet.</p>
                ) : null}
              </div>
            </div>

            <div className="mt-5">
              <p className="text-sm font-semibold text-shell-950">Recent Accepted Outcomes (CID Included)</p>
              <div className="mt-2 space-y-2">
                {outsiderAcceptedSignals.map((signal) => (
                  <div key={signal.contractId} className="rounded-md border border-shell-700/70 bg-shell-900/20 px-3 py-2 text-sm text-signal-slate">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-shell-950">{signal.instrument}</div>
                      <span className="rounded-full border border-shell-700 bg-white px-2 py-1 text-[11px] text-signal-slate">
                        {signal.source}
                      </span>
                    </div>
                    <div className="mt-1">
                      Qty {signal.quantity ?? "-"} | Unit {signal.unitPrice ?? "-"}
                    </div>
                    <div className="mt-2 rounded-md border border-shell-700/60 bg-white/80 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-signal-slate">Contract ID</span>
                        <button
                          className="rounded border border-shell-700 bg-white px-2 py-1 text-[11px] font-semibold text-shell-950"
                          onClick={() => void copyContractId(signal.contractId)}
                          type="button"
                        >
                          Copy CID
                        </button>
                      </div>
                      <code className="mt-1 block break-all text-xs font-mono text-shell-950">{signal.contractId}</code>
                    </div>
                  </div>
                ))}
                {outsiderAcceptedSignals.length === 0 ? (
                  <p className="text-sm text-signal-slate">No accepted outcomes yet.</p>
                ) : null}
              </div>
            </div>
          </article>
        </section>
      ) : null}

      {view === "Inspector" ? (
        <section className="mt-6 animate-fade-rise">
          <ContractVisibilityInspector
            availableParties={availableParties}
            activeParty={view}
          />
        </section>
      ) : null}

      {view === "Challenge" ? (
        <PrivacyChallengeMode
          partyByRole={{
            Seller: seller,
            Buyer: buyer,
            Outsider: outsider,
            Inspector: company,
          }}
          suggestedIntentCid={suggestedIntentCid}
          suggestedNegotiationCid={suggestedNegotiationCid}
        />
      ) : null}

    </main>
  );
}
