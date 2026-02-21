import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePartyContext } from "./context/PartyContext";
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

type RoleView = "Seller" | "Buyer" | "Outsider";

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
    ? "bg-shell-950 text-shell-900"
    : "border border-shell-700 bg-white text-signal-slate";
}

function isValidPositiveNumber(value: string): boolean {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function isLockedContractError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("local_verdict_locked_contracts") || lower.includes("locked contracts");
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
  if (payload.issuerApproved) score += 8;
  if (payload.sellerAccepted) score += 2;
  if (payload.buyerAccepted) score += 2;
  if (payload.sellerTermsRevealed) score += 1;
  if (payload.buyerTermsRevealed) score += 1;
  if (optionalToNumber(payload.proposedQty) !== null && optionalToNumber(payload.proposedUnitPrice) !== null) score += 1;
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

export default function App() {
  const { availableParties } = usePartyContext();

  const [view, setView] = useState<RoleView>("Seller");
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
  const [sessionClosedInstruments, setSessionClosedInstruments] = useState<string[]>([]);
  const outsiderAcceptedBaselineRef = useRef<number | null>(null);

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
  const [selectedIntentInstrument, setSelectedIntentInstrument] = useState<string | null>(null);
  const [negotiationQty, setNegotiationQty] = useState("1000");
  const [negotiationPrice, setNegotiationPrice] = useState("99");
  const [negotiationSide, setNegotiationSide] = useState<"Buy" | "Sell">("Sell");
  const [negotiationSalt, setNegotiationSalt] = useState("simple-demo-salt");
  const startupResetDone = useRef(false);

  const sessionClosedInstrumentSet = useMemo(
    () => new Set(sessionClosedInstruments),
    [sessionClosedInstruments],
  );

  const sellerNegotiationsForSelection = useMemo(
    () => collapseNegotiationLanes(sellerNegotiations.filter((row) =>
      !isNegotiationClosed(row.payload) && !sessionClosedInstrumentSet.has(normalizeInstrument(row.payload.instrument)))),
    [sellerNegotiations, sessionClosedInstrumentSet],
  );

  const buyerNegotiationsCollapsed = useMemo(
    () => collapseNegotiationLanes(buyerNegotiations.filter((row) =>
      !isNegotiationClosed(row.payload) && !sessionClosedInstrumentSet.has(normalizeInstrument(row.payload.instrument)))),
    [buyerNegotiations, sessionClosedInstrumentSet],
  );

  const acceptedForOutsider = useMemo(
    () => companyNegotiations.filter((row) => isNegotiationClosed(row.payload)),
    [companyNegotiations],
  );
  const acceptedLedgerInstrumentSet = useMemo(
    () => new Set(acceptedForOutsider.map((row) => normalizeInstrument(row.payload.instrument))),
    [acceptedForOutsider],
  );
  const sessionOnlyClosedCount = useMemo(
    () => sessionClosedInstruments.filter((instrument) => !acceptedLedgerInstrumentSet.has(instrument)).length,
    [acceptedLedgerInstrumentSet, sessionClosedInstruments],
  );
  const sessionOnlyClosedInstruments = useMemo(
    () => sessionClosedInstruments.filter((instrument) => !acceptedLedgerInstrumentSet.has(instrument)),
    [acceptedLedgerInstrumentSet, sessionClosedInstruments],
  );
  const completedTotalDisplay = acceptedForOutsider.length + sessionOnlyClosedCount;
  const closedInstrumentSet = useMemo(
    () => new Set([...acceptedLedgerInstrumentSet, ...sessionClosedInstruments]),
    [acceptedLedgerInstrumentSet, sessionClosedInstruments],
  );
  const newAcceptedSinceLoad = useMemo(() => {
    const baseline = outsiderAcceptedBaselineRef.current;
    const ledgerDelta = baseline === null ? 0 : Math.max(0, acceptedForOutsider.length - baseline);
    return ledgerDelta + sessionOnlyClosedCount;
  }, [acceptedForOutsider.length, sessionOnlyClosedCount]);

  const selectedSellerNegotiation = useMemo(
    () => sellerNegotiationsForSelection.find((row) => row.contractId === sellerNegotiationCid)
      ?? sellerNegotiationsForSelection[0]
      ?? null,
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
    () => buyerNegotiationsForSelection.find((row) => row.contractId === buyerNegotiationCid)
      ?? buyerNegotiationsForSelection[0]
      ?? null,
    [buyerNegotiationCid, buyerNegotiationsForSelection],
  );

  useEffect(() => {
    if (!sellerNegotiationsForSelection.length) {
      setSellerNegotiationCid("");
      return;
    }
    if (
      !sellerNegotiationCid
      || !sellerNegotiationsForSelection.some((row) => row.contractId === sellerNegotiationCid)
    ) {
      setSellerNegotiationCid(sellerNegotiationsForSelection[0].contractId);
    }
  }, [sellerNegotiationCid, sellerNegotiationsForSelection]);

  useEffect(() => {
    if (!buyerNegotiationsForSelection.length) {
      setBuyerNegotiationCid("");
      return;
    }
    if (
      !buyerNegotiationCid
      || !buyerNegotiationsForSelection.some((row) => row.contractId === buyerNegotiationCid)
    ) {
      setBuyerNegotiationCid(buyerNegotiationsForSelection[0].contractId);
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
      if (outsiderAcceptedBaselineRef.current === null) {
        outsiderAcceptedBaselineRef.current = companyNeg
          .filter((row) => isNegotiationClosed(row.payload))
          .length;
      }
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
      setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [refreshLedger]);

  const markInstrumentClosed = useCallback((instrumentName: string) => {
    const normalized = normalizeInstrument(instrumentName);
    setSessionClosedInstruments((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
  }, []);

  const createTradeIntent = useCallback(async () => {
    await runAction("Trade intent created.", async () => {
      await createContract(seller, TEMPLATE_IDS.tradeIntent, {
        issuer: company,
        seller,
        sellerAgent,
        instrument,
        quantity: Number.parseFloat(quantity),
        minPrice: Number.parseFloat(minPrice),
      });
    });
  }, [company, instrument, minPrice, quantity, runAction, seller, sellerAgent]);

  const negotiationArgument = useCallback(async (choice: SellerChoice | BuyerChoice): Promise<Record<string, unknown>> => {
    if (choice === "SubmitSellerTerms" || choice === "SubmitBuyerTerms") {
      return {
        qty: Number.parseFloat(negotiationQty),
        unitPrice: Number.parseFloat(negotiationPrice),
      };
    }

    if (choice === "CommitTerms") {
      const qtyText = String(Number.parseFloat(negotiationQty));
      const priceText = String(Number.parseFloat(negotiationPrice));
      const commitmentHash = await sha256Hex(`${qtyText}|${priceText}|${negotiationSalt}`);
      return {
        side: { tag: negotiationSide, value: {} },
        commitmentHash,
      };
    }

    if (choice === "RevealTerms") {
      return {
        side: { tag: negotiationSide, value: {} },
        qtyText: String(Number.parseFloat(negotiationQty)),
        unitPriceText: String(Number.parseFloat(negotiationPrice)),
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
    const activeRows = rows.filter((row) =>
      !isNegotiationClosed(row.payload) && !sessionClosedInstrumentSet.has(normalizeInstrument(row.payload.instrument)));
    if (!activeRows.length) return null;
    const byCid = activeRows.find((row) => row.contractId === preferredContractId);
    if (byCid) return byCid;
    if (preferredInstrument) {
      const normalized = normalizeInstrument(preferredInstrument);
      const byInstrument = activeRows.find((row) => normalizeInstrument(row.payload.instrument) === normalized);
      if (byInstrument) return byInstrument;
    }
    return activeRows[0] ?? null;
  }, [sessionClosedInstrumentSet]);

  const runSellerAction = useCallback(async (choice?: SellerChoice): Promise<boolean> => {
    const effectiveChoice = choice ?? sellerChoice;

    if (NEGOTIATION_FIELD_CHOICES.includes(effectiveChoice)) {
      if (!isValidPositiveNumber(negotiationQty) || !isValidPositiveNumber(negotiationPrice)) {
        setError("Enter valid positive qty and unit price before negotiating.");
        return false;
      }
    }

    return runAction(`Seller action ${effectiveChoice} executed.`, async () => {
      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const liveRows = await queryPrivateNegotiations(sellerAgent);
        setSellerNegotiations(liveRows);
        const live = pickActiveNegotiation(
          liveRows,
          sellerNegotiationCid,
          selectedSellerNegotiation?.payload.instrument ?? null,
        );
        if (!live) throw new Error("No active seller-side negotiation available (it may already be accepted).");
        setSellerNegotiationCid(live.contractId);

        const arg = await negotiationArgument(effectiveChoice);
        try {
          await exerciseChoice(
            sellerAgent,
            TEMPLATE_IDS.privateNegotiation,
            live.contractId,
            effectiveChoice,
            arg,
          );
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
      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const liveRows = await queryPrivateNegotiations(buyerAgent);
        setBuyerNegotiations(liveRows);
        const live = pickActiveNegotiation(
          liveRows,
          buyerNegotiationCid,
          selectedBuyerNegotiation?.payload.instrument ?? null,
        );
        if (!live) throw new Error("No active buyer-side negotiation available (it may already be accepted).");
        setBuyerNegotiationCid(live.contractId);

        const arg = await negotiationArgument(effectiveChoice);
        try {
          await exerciseChoice(
            buyerAgent,
            TEMPLATE_IDS.privateNegotiation,
            live.contractId,
            effectiveChoice,
            arg,
          );
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
    pickActiveNegotiation,
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
    if (selectedSellerNegotiation.payload.sellerAccepted) {
      setError("Seller already accepted these terms.");
      return;
    }
    if (!hasSubmittedTerms(selectedSellerNegotiation.payload)) {
      const submitted = await runSellerAction("SubmitSellerTerms");
      if (!submitted) return;
    }
    const accepted = await runSellerAction("AcceptBySeller");
    if (accepted) {
      markInstrumentClosed(selectedSellerNegotiation.payload.instrument);
    }
  }, [markInstrumentClosed, runSellerAction, selectedSellerNegotiation]);

  const runBuyerAcceptOffer = useCallback(async () => {
    if (!selectedBuyerNegotiation) {
      setError("No buyer-side negotiation contract available yet.");
      return;
    }
    if (selectedBuyerNegotiation.payload.buyerAccepted) {
      setError("Buyer already accepted these terms.");
      return;
    }
    if (!hasSubmittedTerms(selectedBuyerNegotiation.payload)) {
      const submitted = await runBuyerAction("SubmitBuyerTerms");
      if (!submitted) return;
    }
    const accepted = await runBuyerAction("AcceptByBuyer");
    if (accepted) {
      markInstrumentClosed(selectedBuyerNegotiation.payload.instrument);
    }
  }, [markInstrumentClosed, runBuyerAction, selectedBuyerNegotiation]);

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
      if (closedInstrumentSet.has(normalizedInstrument)) {
        throw new Error("This intent already has an accepted offer. Negotiation is closed.");
      }
      const closedRows = liveRows.filter((row) =>
        isNegotiationClosed(row.payload) && normalizeInstrument(row.payload.instrument) === normalizedInstrument);
      if (closedRows.length > 0) {
        throw new Error("This intent already has an accepted offer. Negotiation is closed.");
      }
      const activeRows = liveRows.filter((row) =>
        !isNegotiationClosed(row.payload) && !sessionClosedInstrumentSet.has(normalizeInstrument(row.payload.instrument)));
      const match = activeRows.find(
        (row) => normalizeInstrument(row.payload.instrument) === normalizedInstrument,
      ) ?? null;

      if (!match) {
        const createdAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const payload: Record<string, unknown> = {
          issuer: company,
          seller,
          sellerAgent,
          buyer,
          buyerAgent,
          sellerJurisdiction: "US",
          buyerJurisdiction: "US",
          instrument: intent.payload.instrument,
          proposedQty: null,
          proposedUnitPrice: null,
          sellerAccepted: false,
          buyerAccepted: false,
          issuerApproved: false,
          createdAt,
          expiresAt,
          sellerCommitmentHash: null,
          buyerCommitmentHash: null,
          sellerTermsRevealed: false,
          buyerTermsRevealed: false,
        };

        const defaultForMissingField = (field: string): unknown => {
          if (field === "createdAt") return createdAt;
          if (field === "expiresAt") return expiresAt;
          if (field === "sellerJurisdiction" || field === "buyerJurisdiction") return "US";
          return "";
        };

        let created: ContractRecord<PrivateNegotiationPayload> | null = null;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            created = await createContract<PrivateNegotiationPayload>(
              company,
              TEMPLATE_IDS.privateNegotiation,
              payload,
            );
            break;
          } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason);
            const missingMatch = message.match(/Missing non-optional field:\s*([A-Za-z0-9_]+)/);
            if (missingMatch) {
              const field = missingMatch[1];
              payload[field] = defaultForMissingField(field);
              continue;
            }
            const unknownMatch = message.match(/Unknown field:\s*([A-Za-z0-9_]+)/);
            if (unknownMatch) {
              const field = unknownMatch[1];
              delete payload[field];
              continue;
            }
            throw reason;
          }
        }
        if (!created) {
          throw new Error("Could not create negotiation: payload schema mismatch across package versions.");
        }

        setSelectedIntentInstrument(intent.payload.instrument);
        setBuyerNegotiationCid(created.contractId);
      } else {
        setSelectedIntentInstrument(intent.payload.instrument);
        setBuyerNegotiationCid(match.contractId);
      }
    });
  }, [buyer, buyerAgent, closedInstrumentSet, company, runAction, seller, sellerAgent, sessionClosedInstrumentSet]);

  const outsiderPrivateCount = outsiderIntents.length + outsiderNegotiations.length;
  const outsiderPublicCount = outsiderSettlements.length + outsiderAudits.length;

  const selectedTerms = (payload: PrivateNegotiationPayload) => {
    const qty = optionalToNumber(payload.proposedQty);
    const price = optionalToNumber(payload.proposedUnitPrice);
    if (qty === null || price === null) return "No price/qty terms submitted yet.";
    return `Qty ${qty} @ ${price}`;
  };
  const sellerCanAccept = selectedSellerNegotiation
    ? !selectedSellerNegotiation.payload.sellerAccepted
    : false;
  const buyerCanAccept = selectedBuyerNegotiation
    ? !selectedBuyerNegotiation.payload.buyerAccepted
    : false;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 md:px-8">
      <section className="rounded-2xl border border-shell-700 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Agentic Shadow Cap</p>
            <h1 className="mt-1 text-3xl font-bold text-shell-950">Trade Console</h1>
            <p className="mt-2 text-sm text-signal-slate">
              Focused workflow: Seller creates intents, Buyer/Seller negotiate, Outsider sees only public outcome signals.
            </p>
          </div>
          <button
            className="rounded-lg border border-shell-700 px-3 py-2 text-sm font-semibold text-shell-950"
            onClick={() => void refreshLedger()}
            disabled={busy || loading}
          >
            Refresh
          </button>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {(["Seller", "Buyer", "Outsider"] as RoleView[]).map((role) => (
            <button
              key={role}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${statusPillClass(view === role)}`}
              onClick={() => setView(role)}
            >
              {role} View
            </button>
          ))}
        </div>

        {status ? <p className="mt-4 rounded-lg bg-signal-mint/15 px-3 py-2 text-sm text-shell-950">{status}</p> : null}
        {error ? <p className="mt-4 rounded-lg bg-signal-coral/15 px-3 py-2 text-sm text-signal-coral">{error}</p> : null}
        {loading ? <p className="mt-4 text-sm text-signal-slate">Refreshing ledger data...</p> : null}
      </section>

      {view === "Seller" ? (
        <section className="mt-6 grid gap-6 lg:grid-cols-2">
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
                    <div className="text-xs">CID {shortId(intent.contractId)}</div>
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
              </div>
            ) : (
              <p className="mt-3 text-sm text-signal-slate">No seller-visible negotiations yet.</p>
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
          </article>
        </section>
      ) : null}

      {view === "Buyer" ? (
        <section className="mt-6 grid gap-6 lg:grid-cols-2">
          <article className="rounded-2xl border border-shell-700 bg-white p-5 lg:col-span-2">
            <h2 className="text-xl font-semibold text-shell-950">All Trade Intents</h2>
            <p className="mt-1 text-sm text-signal-slate">
              Buyer can review every seller intent and jump straight into negotiation.
            </p>
            <div className="mt-3 grid gap-2">
              {tradeIntents.map((intent) => {
                const closed = closedInstrumentSet.has(normalizeInstrument(intent.payload.instrument));
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
                        disabled={busy || closed}
                      >
                        {closed ? "Closed" : "Negotiate"}
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
              </div>
            ) : (
              <p className="mt-3 text-sm text-signal-slate">
                {selectedIntentInstrument
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
          </article>
        </section>
      ) : null}

      {view === "Outsider" ? (
        <section className="mt-6 grid gap-6 lg:grid-cols-2">
          <article className="rounded-2xl border border-shell-700 bg-white p-5">
            <h2 className="text-xl font-semibold text-shell-950">Private Data Access</h2>
            <p className="mt-1 text-sm text-signal-slate">
              Outsider cannot inspect private intents or negotiation terms.
            </p>

            <div className="mt-4 rounded-lg border border-shell-700/70 bg-shell-900/40 p-4 text-sm">
              <div className="font-semibold text-shell-950">Private records visible to outsider</div>
              <div className="mt-1 text-signal-slate">TradeIntents: {outsiderIntents.length}</div>
              <div className="text-signal-slate">PrivateNegotiations: {outsiderNegotiations.length}</div>
              <div className={`mt-2 font-semibold ${outsiderPrivateCount === 0 ? "text-signal-mint" : "text-signal-coral"}`}>
                {outsiderPrivateCount === 0 ? "Blocked as expected." : "Unexpected visibility detected."}
              </div>
            </div>
          </article>

          <article className="rounded-2xl border border-shell-700 bg-white p-5">
            <h2 className="text-xl font-semibold text-shell-950">Joint Outcome Signal</h2>
            <p className="mt-1 text-sm text-signal-slate">
              Outsider sees summary outcome signals only, never private terms.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 p-4 text-sm text-signal-slate">
                <div className="text-xs uppercase tracking-[0.12em]">Completed (Total)</div>
                <div className="mt-1 text-2xl font-semibold text-shell-950">{completedTotalDisplay}</div>
              </div>
              <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 p-4 text-sm text-signal-slate">
                <div className="text-xs uppercase tracking-[0.12em]">New Since Load</div>
                <div className="mt-1 text-2xl font-semibold text-shell-950">{newAcceptedSinceLoad}</div>
              </div>
              <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 p-4 text-sm text-signal-slate">
                <div className="text-xs uppercase tracking-[0.12em]">Public Settlements</div>
                <div className="mt-1 text-2xl font-semibold text-shell-950">{outsiderSettlements.length}</div>
              </div>
              <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 p-4 text-sm text-signal-slate">
                <div className="text-xs uppercase tracking-[0.12em]">Public Audits</div>
                <div className="mt-1 text-2xl font-semibold text-shell-950">{outsiderAudits.length}</div>
              </div>
            </div>

            <div className="mt-3 rounded-lg border border-shell-700/70 bg-shell-900/40 p-4 text-sm text-signal-slate">
              <div className="font-semibold text-shell-950">
                {newAcceptedSinceLoad > 0
                  ? "New completed negotiation detected in this session."
                  : completedTotalDisplay > 0
                    ? "Only historical completed negotiations detected."
                    : outsiderPublicCount > 0
                      ? "Public completion artifact detected."
                      : "No outcome signal yet."}
              </div>
              <div className="mt-1 text-xs">
                Total includes historical ledger state; "New Since Load" tracks only this browser session.
              </div>
            </div>

            {sessionOnlyClosedInstruments.slice(0, 3).map((instrumentName) => (
              <div key={`session-${instrumentName}`} className="mt-3 rounded-md border border-shell-700/70 px-3 py-2 text-sm text-signal-slate">
                <div className="font-semibold text-shell-950">Completed (Session)</div>
                <div>{instrumentName.toUpperCase()}</div>
              </div>
            ))}
            {acceptedForOutsider.slice(0, 3).map((row) => (
              <div key={row.contractId} className="mt-3 rounded-md border border-shell-700/70 px-3 py-2 text-sm text-signal-slate">
                <div className="font-semibold text-shell-950">Completed {shortId(row.contractId)}</div>
                <div>{row.payload.instrument}</div>
              </div>
            ))}
            {outsiderSettlements.slice(0, 3).map((row) => (
              <div key={row.contractId} className="mt-3 rounded-md border border-shell-700/70 px-3 py-2 text-sm text-signal-slate">
                <div className="font-semibold text-shell-950">Settlement {shortId(row.contractId)}</div>
                <div>{row.payload.instrument} | Qty {optionalToNumber(row.payload.quantity)}</div>
              </div>
            ))}
            {outsiderAudits.slice(0, 3).map((row) => (
              <div key={row.contractId} className="mt-3 rounded-md border border-shell-700/70 px-3 py-2 text-sm text-signal-slate">
                <div className="font-semibold text-shell-950">Audit {shortId(row.contractId)}</div>
                <div>{row.payload.instrument} | Settled at {row.payload.settledAt}</div>
              </div>
            ))}
          </article>
        </section>
      ) : null}

      <footer className="mt-8 pb-8 text-xs text-signal-slate">
        Parties: seller={aliasOf(seller)} sellerAgent={aliasOf(sellerAgent)} buyerAgent={aliasOf(buyerAgent)} outsider={aliasOf(outsider)}
      </footer>
    </main>
  );
}
