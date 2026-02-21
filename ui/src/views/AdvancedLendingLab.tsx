import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { BorrowerAsk, LenderBid, LoanRequest } from "../types/creditLending";

type OrderSide = "lender" | "borrower";
type OrderType = "GTC" | "IOC" | "FOK";

interface EngineOrder {
  id: string;
  side: OrderSide;
  orderType: OrderType;
  party: string;
  amount: number;
  remaining: number;
  rate: number;
  duration: number;
  createdAt: number;
  source: "seed" | "manual";
}

interface MatchFill {
  id: string;
  takerOrderId: string;
  makerOrderId: string;
  lender: string;
  borrower: string;
  amount: number;
  rate: number;
  duration: number;
  matchedAt: string;
}

interface MarginLoan {
  id: string;
  lender: string;
  borrower: string;
  principal: number;
  rate: number;
  duration: number;
  collateral: number;
  status: "active" | "liquidated";
  source: "matching" | "syndication";
  openedAt: string;
}

interface LiquidationEvent {
  id: string;
  loanId: string;
  borrower: string;
  lender: string;
  beforePrincipal: number;
  afterPrincipal: number;
  fractionLiquidated: number;
  reason: string;
  createdAt: string;
}

interface SyndicatedTranche {
  id: string;
  originLender: string;
  currentHolder: string;
  principal: number;
  rate: number;
  createdAt: string;
}

interface SyndicatedFacility {
  id: string;
  borrower: string;
  purpose: string;
  duration: number;
  totalPrincipal: number;
  createdAt: string;
  tranches: SyndicatedTranche[];
}

interface SecondaryTrade {
  id: string;
  facilityId: string;
  trancheId: string;
  seller: string;
  buyer: string;
  notional: number;
  pricePct: number;
  settledValue: number;
  createdAt: string;
}

interface TrancheDraft {
  lender: string;
  amount: string;
  rate: string;
}

interface AdvancedLendingLabProps {
  interactive: boolean;
  currentParty: string;
  bids: LenderBid[];
  asks: BorrowerAsk[];
  requests: LoanRequest[];
  autoRunToken?: number;
  onStatus?: (message: string) => void;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatDate(value: string): string {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function parsePositiveNumber(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function isCompatible(taker: EngineOrder, maker: EngineOrder): boolean {
  if (taker.side === maker.side) return false;
  if (maker.remaining <= 0) return false;

  if (taker.side === "borrower") {
    return maker.rate <= taker.rate && maker.duration >= taker.duration;
  }
  return maker.rate >= taker.rate && maker.duration <= taker.duration;
}

function makerPriority(taker: EngineOrder, left: EngineOrder, right: EngineOrder): number {
  if (taker.side === "borrower") {
    if (left.rate !== right.rate) return left.rate - right.rate;
  } else if (left.rate !== right.rate) {
    return right.rate - left.rate;
  }
  return left.createdAt - right.createdAt;
}

function rowStatusClass(status: string): string {
  if (["active", "healthy", "open", "good"].includes(status)) return "text-signal-mint";
  if (["warning", "margin-call", "partial"].includes(status)) return "text-signal-amber";
  if (["liquidated", "critical", "closed"].includes(status)) return "text-signal-coral";
  return "text-signal-slate";
}

function computeHealthFactor(loan: MarginLoan, marginRequirementPct: number, stressHaircutPct: number): number {
  const required = loan.principal * (marginRequirementPct / 100);
  if (required <= 0) return Number.POSITIVE_INFINITY;
  const stressFactor = Math.max(0, 1 - (stressHaircutPct / 100));
  const effectiveCollateral = loan.collateral * stressFactor;
  return effectiveCollateral / required;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function AdvancedLendingLab({
  interactive,
  currentParty,
  bids,
  asks,
  requests,
  autoRunToken = 0,
  onStatus,
}: AdvancedLendingLabProps) {
  const seededRef = useRef(false);
  const lastAutoRunTokenRef = useRef(0);

  const [orders, setOrders] = useState<EngineOrder[]>([]);
  const [fills, setFills] = useState<MatchFill[]>([]);
  const [marginLoans, setMarginLoans] = useState<MarginLoan[]>([]);
  const [vaults, setVaults] = useState<Record<string, number>>({});
  const [liquidations, setLiquidations] = useState<LiquidationEvent[]>([]);

  const [orderForm, setOrderForm] = useState({
    side: "borrower" as OrderSide,
    orderType: "GTC" as OrderType,
    party: currentParty,
    amount: "50000",
    rate: "8.5",
    duration: "12",
  });
  const [replaceDraftById, setReplaceDraftById] = useState<Record<string, { amount: string; rate: string; duration: string }>>({});

  const [marginRequirementPct, setMarginRequirementPct] = useState("130");
  const [stressHaircutPct, setStressHaircutPct] = useState("0");
  const [topUpParty, setTopUpParty] = useState(currentParty);
  const [topUpAmount, setTopUpAmount] = useState("50000");

  const [facilities, setFacilities] = useState<SyndicatedFacility[]>([]);
  const [secondaryTrades, setSecondaryTrades] = useState<SecondaryTrade[]>([]);
  const [facilityBorrower, setFacilityBorrower] = useState(currentParty);
  const [facilityPurpose, setFacilityPurpose] = useState("Syndicated credit line");
  const [facilityDuration, setFacilityDuration] = useState("18");
  const [trancheDrafts, setTrancheDrafts] = useState<TrancheDraft[]>([
    { lender: "", amount: "60000", rate: "7.8" },
    { lender: "", amount: "40000", rate: "8.2" },
  ]);

  const [secondaryForm, setSecondaryForm] = useState({
    facilityId: "",
    trancheId: "",
    buyer: "",
    notional: "25000",
    pricePct: "98",
  });

  const [notice, setNotice] = useState<string | null>(null);

  const marginRequirement = parsePositiveNumber(marginRequirementPct) ?? 130;
  const stressHaircut = parsePositiveNumber(stressHaircutPct) ?? 0;

  const knownParties = useMemo(() => {
    const values = new Set<string>();
    values.add(currentParty);
    for (const row of bids) values.add(row.lender);
    for (const row of asks) values.add(row.borrower);
    for (const row of requests) values.add(row.borrower);
    for (const row of facilities) {
      values.add(row.borrower);
      for (const tranche of row.tranches) {
        values.add(tranche.originLender);
        values.add(tranche.currentHolder);
      }
    }
    for (const row of orders) values.add(row.party);
    return Array.from(values).filter(Boolean).sort();
  }, [asks, bids, currentParty, facilities, orders, requests]);

  const selectedFacility = useMemo(
    () => facilities.find((row) => row.id === secondaryForm.facilityId) ?? null,
    [facilities, secondaryForm.facilityId],
  );
  const selectedTranche = useMemo(
    () => selectedFacility?.tranches.find((row) => row.id === secondaryForm.trancheId) ?? null,
    [selectedFacility, secondaryForm.trancheId],
  );

  useEffect(() => {
    if (seededRef.current) return;
    const now = Date.now();
    const seededOrders: EngineOrder[] = [
      ...bids.map((row, index) => ({
        id: `seed-lender-${row.contractId}`,
        side: "lender" as const,
        orderType: "GTC" as const,
        party: row.lender,
        amount: row.remainingAmount,
        remaining: row.remainingAmount,
        rate: row.minInterestRate,
        duration: row.maxDuration,
        createdAt: now + index,
        source: "seed" as const,
      })),
      ...asks.map((row, index) => ({
        id: `seed-borrower-${row.contractId}`,
        side: "borrower" as const,
        orderType: "GTC" as const,
        party: row.borrower,
        amount: row.amount,
        remaining: row.amount,
        rate: row.maxInterestRate,
        duration: row.duration,
        createdAt: now + bids.length + index,
        source: "seed" as const,
      })),
    ];
    setOrders(seededOrders);

    const initialVaults: Record<string, number> = {};
    const parties = new Set<string>([
      currentParty,
      ...bids.map((row) => row.lender),
      ...asks.map((row) => row.borrower),
      ...requests.map((row) => row.borrower),
    ]);
    for (const party of parties) {
      initialVaults[party] = 100000;
    }
    setVaults(initialVaults);

    if (knownParties.length > 0) {
      setTopUpParty((prev) => (prev && knownParties.includes(prev) ? prev : knownParties[0]));
      setFacilityBorrower((prev) => (prev && knownParties.includes(prev) ? prev : knownParties[0]));
    }
    seededRef.current = true;
  }, [asks, bids, currentParty, knownParties, requests]);

  useEffect(() => {
    setOrderForm((prev) => ({ ...prev, party: prev.party || currentParty }));
  }, [currentParty]);

  useEffect(() => {
    if (knownParties.length === 0) return;
    if (!topUpParty || !knownParties.includes(topUpParty)) setTopUpParty(knownParties[0]);
    if (!facilityBorrower || !knownParties.includes(facilityBorrower)) setFacilityBorrower(knownParties[0]);
    if (!secondaryForm.buyer || !knownParties.includes(secondaryForm.buyer)) {
      setSecondaryForm((prev) => ({ ...prev, buyer: knownParties[0] }));
    }
  }, [facilityBorrower, knownParties, secondaryForm.buyer, topUpParty]);

  function pushNotice(message: string) {
    setNotice(message);
    onStatus?.(message);
  }

  useEffect(() => {
    if (!interactive || autoRunToken <= 0 || autoRunToken === lastAutoRunTokenRef.current) {
      return;
    }
    lastAutoRunTokenRef.current = autoRunToken;

    const now = new Date().toISOString();
    const borrower = currentParty;
    const lenderA = knownParties.find((party) => party !== borrower) ?? "lender-alpha";
    const lenderB = knownParties.find((party) => party !== borrower && party !== lenderA) ?? "lender-beta";

    const fillA: MatchFill = {
      id: makeId("fill"),
      takerOrderId: makeId("ord"),
      makerOrderId: makeId("ord"),
      lender: lenderA,
      borrower,
      amount: 32000,
      rate: 7.6,
      duration: 12,
      matchedAt: now,
    };
    const fillB: MatchFill = {
      id: makeId("fill"),
      takerOrderId: makeId("ord"),
      makerOrderId: makeId("ord"),
      lender: lenderB,
      borrower,
      amount: 18000,
      rate: 8.1,
      duration: 18,
      matchedAt: now,
    };
    setFills((prev) => [fillA, fillB, ...prev].slice(0, 80));

    const lenderResting: EngineOrder = {
      id: makeId("ord"),
      side: "lender",
      orderType: "GTC",
      party: lenderA,
      amount: 20000,
      remaining: 20000,
      rate: 6.9,
      duration: 18,
      createdAt: Date.now(),
      source: "manual",
    };
    const borrowerResting: EngineOrder = {
      id: makeId("ord"),
      side: "borrower",
      orderType: "GTC",
      party: borrower,
      amount: 15000,
      remaining: 15000,
      rate: 8.4,
      duration: 12,
      createdAt: Date.now(),
      source: "manual",
    };
    setOrders((prev) => [lenderResting, borrowerResting, ...prev].slice(0, 100));

    setVaults((prev) => ({
      ...prev,
      [borrower]: Math.max(0, (prev[borrower] ?? 100000) - 65000),
      [lenderA]: prev[lenderA] ?? 100000,
      [lenderB]: prev[lenderB] ?? 100000,
    }));

    const marginLoanHealthy: MarginLoan = {
      id: makeId("loan"),
      lender: lenderA,
      borrower,
      principal: 32000,
      rate: 7.6,
      duration: 12,
      collateral: 50000,
      status: "active",
      source: "matching",
      openedAt: now,
    };
    const marginLoanRisk: MarginLoan = {
      id: makeId("loan"),
      lender: lenderB,
      borrower,
      principal: 22000,
      rate: 8.2,
      duration: 18,
      collateral: 18000,
      status: "active",
      source: "matching",
      openedAt: now,
    };
    setMarginLoans((prev) => [marginLoanHealthy, marginLoanRisk, ...prev].slice(0, 120));

    const liquidation: LiquidationEvent = {
      id: makeId("liq"),
      loanId: marginLoanRisk.id,
      borrower,
      lender: lenderB,
      beforePrincipal: 22000,
      afterPrincipal: 11000,
      fractionLiquidated: 0.5,
      reason: "Stage 2 liquidation",
      createdAt: now,
    };
    setLiquidations((prev) => [liquidation, ...prev].slice(0, 60));

    const trancheA: SyndicatedTranche = {
      id: makeId("tranche"),
      originLender: lenderA,
      currentHolder: lenderA,
      principal: 60000,
      rate: 7.4,
      createdAt: now,
    };
    const trancheB: SyndicatedTranche = {
      id: makeId("tranche"),
      originLender: lenderB,
      currentHolder: lenderB,
      principal: 40000,
      rate: 8.0,
      createdAt: now,
    };
    const facility: SyndicatedFacility = {
      id: makeId("facility"),
      borrower,
      purpose: "Auto-demo syndicated facility",
      duration: 18,
      totalPrincipal: trancheA.principal + trancheB.principal,
      createdAt: now,
      tranches: [trancheA, trancheB],
    };
    setFacilities((prev) => [facility, ...prev].slice(0, 40));

    const trade: SecondaryTrade = {
      id: makeId("trade"),
      facilityId: facility.id,
      trancheId: trancheA.id,
      seller: lenderA,
      buyer: lenderB,
      notional: 20000,
      pricePct: 99,
      settledValue: 19800,
      createdAt: now,
    };
    setSecondaryTrades((prev) => [trade, ...prev].slice(0, 80));
    setSecondaryForm((prev) => ({
      ...prev,
      facilityId: facility.id,
      trancheId: trancheA.id,
      buyer: lenderB,
      notional: "20000",
      pricePct: "99",
    }));

    pushNotice("Advanced demo populated: matching fills, margin event, syndicated facility, and secondary trade.");
  }, [autoRunToken, currentParty, interactive, knownParties]);

  function onSubmitAdvancedOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!interactive) return;

    const amount = parsePositiveNumber(orderForm.amount);
    const rate = parsePositiveNumber(orderForm.rate);
    const duration = parsePositiveNumber(orderForm.duration);
    if (!amount || !rate || !duration || !orderForm.party.trim()) {
      pushNotice("Advanced order rejected: enter valid party, amount, rate, and duration.");
      return;
    }

    const incoming: EngineOrder = {
      id: makeId("ord"),
      side: orderForm.side,
      orderType: orderForm.orderType,
      party: orderForm.party.trim(),
      amount,
      remaining: amount,
      rate,
      duration,
      createdAt: Date.now(),
      source: "manual",
    };

    const workingBook = orders.map((row) => ({ ...row }));
    const candidateMakers = workingBook
      .filter((row) => isCompatible(incoming, row))
      .sort((left, right) => makerPriority(incoming, left, right));

    const totalAvailable = candidateMakers.reduce((sum, row) => sum + row.remaining, 0);
    if (incoming.orderType === "FOK" && totalAvailable + 1e-9 < incoming.amount) {
      pushNotice(`FOK order cancelled: required ${formatCurrency(incoming.amount)}, available ${formatCurrency(totalAvailable)}.`);
      return;
    }

    const producedFills: MatchFill[] = [];
    const taker = { ...incoming };

    for (const maker of candidateMakers) {
      if (taker.remaining <= 1e-9) break;
      const fillAmount = Math.min(taker.remaining, maker.remaining);
      if (fillAmount <= 0) continue;

      maker.remaining -= fillAmount;
      taker.remaining -= fillAmount;

      const lender = taker.side === "lender" ? taker.party : maker.party;
      const borrower = taker.side === "borrower" ? taker.party : maker.party;
      const durationMonths = taker.side === "borrower" ? taker.duration : maker.duration;

      producedFills.push({
        id: makeId("fill"),
        takerOrderId: taker.id,
        makerOrderId: maker.id,
        lender,
        borrower,
        amount: fillAmount,
        rate: maker.rate,
        duration: durationMonths,
        matchedAt: new Date().toISOString(),
      });
    }

    const nextBook = workingBook.filter((row) => row.remaining > 1e-9);
    const wasUnfilled = taker.remaining > 1e-9;
    if (wasUnfilled && incoming.orderType === "GTC") {
      nextBook.push({ ...taker });
    }
    setOrders(nextBook);
    setFills((prev) => [...producedFills, ...prev].slice(0, 80));

    if (producedFills.length > 0) {
      const nextVaults = { ...vaults };
      const newLoans: MarginLoan[] = producedFills.map((fill) => {
        const requiredCollateral = fill.amount * (marginRequirement / 100);
        const targetCollateral = requiredCollateral * 1.05;
        const available = nextVaults[fill.borrower] ?? 0;
        const posted = Math.min(targetCollateral, available);
        nextVaults[fill.borrower] = Math.max(0, available - posted);
        return {
          id: makeId("loan"),
          lender: fill.lender,
          borrower: fill.borrower,
          principal: fill.amount,
          rate: fill.rate,
          duration: fill.duration,
          collateral: posted,
          status: "active",
          source: "matching",
          openedAt: fill.matchedAt,
        };
      });
      setVaults(nextVaults);
      setMarginLoans((prev) => [...newLoans, ...prev]);
    }

    if (producedFills.length === 0 && incoming.orderType === "IOC") {
      pushNotice(`IOC order not matched and dropped: ${formatCurrency(incoming.amount)}.`);
      return;
    }

    if (producedFills.length > 0 && wasUnfilled && incoming.orderType === "IOC") {
      pushNotice(`IOC partial fill: ${formatCurrency(incoming.amount - taker.remaining)} executed, ${formatCurrency(taker.remaining)} cancelled.`);
      return;
    }

    if (producedFills.length > 0 && wasUnfilled && incoming.orderType === "GTC") {
      pushNotice(`Matched ${producedFills.length} fills. Remaining ${formatCurrency(taker.remaining)} posted to book.`);
      return;
    }

    if (producedFills.length > 0) {
      pushNotice(`Matched ${producedFills.length} fill(s) for ${formatCurrency(producedFills.reduce((sum, row) => sum + row.amount, 0))}.`);
      return;
    }

    pushNotice("Order accepted to resting book.");
  }

  function cancelRestingOrder(orderId: string) {
    if (!interactive) return;
    setOrders((prev) => prev.filter((row) => row.id !== orderId));
    pushNotice("Resting order cancelled.");
  }

  function replaceRestingOrder(order: EngineOrder) {
    if (!interactive) return;
    const draft = replaceDraftById[order.id];
    const amount = parsePositiveNumber(draft?.amount ?? String(order.remaining));
    const rate = parsePositiveNumber(draft?.rate ?? String(order.rate));
    const duration = parsePositiveNumber(draft?.duration ?? String(order.duration));
    if (!amount || !rate || !duration) {
      pushNotice("Replace failed: enter valid amount/rate/duration.");
      return;
    }
    setOrders((prev) => prev.map((row) => (row.id === order.id
      ? {
        ...row,
        amount,
        remaining: amount,
        rate,
        duration,
        createdAt: Date.now(),
      }
      : row)));
    pushNotice("Order replaced (cancel/replace semantics applied).");
  }

  function topUpVault() {
    if (!interactive) return;
    const amount = parsePositiveNumber(topUpAmount);
    if (!topUpParty || !amount) {
      pushNotice("Top-up failed: choose party and positive amount.");
      return;
    }
    setVaults((prev) => ({ ...prev, [topUpParty]: (prev[topUpParty] ?? 0) + amount }));
    pushNotice(`Vault topped up: ${topUpParty} +${formatCurrency(amount)}.`);
  }

  function runLiquidationLadder() {
    if (!interactive) return;
    const created: LiquidationEvent[] = [];
    setMarginLoans((prev) => prev.map((loan) => {
      if (loan.status !== "active") return loan;
      const hf = computeHealthFactor(loan, marginRequirement, stressHaircut);
      if (hf >= 1) return loan;

      let fraction = 0.25;
      let reason = "Stage 1 margin call";
      if (hf < 0.8) {
        fraction = 1;
        reason = "Stage 3 forced liquidation";
      } else if (hf < 0.9) {
        fraction = 0.5;
        reason = "Stage 2 liquidation";
      }

      const beforePrincipal = loan.principal;
      const afterPrincipal = Math.max(0, loan.principal * (1 - fraction));
      const collateralPenalty = beforePrincipal * fraction * 0.08;
      const afterCollateral = Math.max(0, loan.collateral - collateralPenalty);

      created.push({
        id: makeId("liq"),
        loanId: loan.id,
        borrower: loan.borrower,
        lender: loan.lender,
        beforePrincipal,
        afterPrincipal,
        fractionLiquidated: fraction,
        reason,
        createdAt: new Date().toISOString(),
      });

      return {
        ...loan,
        principal: afterPrincipal,
        collateral: afterCollateral,
        status: afterPrincipal <= 1 ? "liquidated" : "active",
      };
    }));

    if (created.length > 0) {
      setLiquidations((prev) => [...created, ...prev].slice(0, 60));
      pushNotice(`Liquidation ladder processed ${created.length} position(s).`);
      return;
    }
    pushNotice("No positions breached margin thresholds.");
  }

  function addTrancheDraftRow() {
    setTrancheDrafts((prev) => [...prev, { lender: "", amount: "", rate: "" }]);
  }

  function createSyndicatedFacility() {
    if (!interactive) return;
    const duration = parsePositiveNumber(facilityDuration);
    if (!facilityBorrower.trim() || !facilityPurpose.trim() || !duration) {
      pushNotice("Facility creation failed: borrower, purpose, and duration are required.");
      return;
    }

    const parsedTranches = trancheDrafts
      .map((row) => ({
        lender: row.lender.trim(),
        amount: parsePositiveNumber(row.amount),
        rate: parsePositiveNumber(row.rate),
      }))
      .filter((row) => row.lender && row.amount && row.rate) as Array<{ lender: string; amount: number; rate: number }>;

    if (parsedTranches.length < 2) {
      pushNotice("Syndication requires at least two valid lender tranches.");
      return;
    }

    const duplicateLenders = new Set<string>();
    for (const tranche of parsedTranches) {
      if (duplicateLenders.has(tranche.lender)) {
        pushNotice("Syndication failed: each tranche must use a distinct lender.");
        return;
      }
      duplicateLenders.add(tranche.lender);
    }

    const totalPrincipal = parsedTranches.reduce((sum, row) => sum + row.amount, 0);
    const createdAt = new Date().toISOString();
    const tranches: SyndicatedTranche[] = parsedTranches.map((row) => ({
      id: makeId("tranche"),
      originLender: row.lender,
      currentHolder: row.lender,
      principal: row.amount,
      rate: row.rate,
      createdAt,
    }));

    const facility: SyndicatedFacility = {
      id: makeId("facility"),
      borrower: facilityBorrower.trim(),
      purpose: facilityPurpose.trim(),
      duration,
      totalPrincipal,
      createdAt,
      tranches,
    };

    setFacilities((prev) => [facility, ...prev]);
    setSecondaryForm((prev) => ({
      ...prev,
      facilityId: facility.id,
      trancheId: tranches[0]?.id ?? "",
    }));

    const nextVaults = { ...vaults };
    const openedLoans: MarginLoan[] = tranches.map((tranche) => {
      const requiredCollateral = tranche.principal * (marginRequirement / 100);
      const targetCollateral = requiredCollateral * 1.05;
      const available = nextVaults[facility.borrower] ?? 0;
      const posted = Math.min(targetCollateral, available);
      nextVaults[facility.borrower] = Math.max(0, available - posted);
      return {
        id: makeId("loan"),
        lender: tranche.currentHolder,
        borrower: facility.borrower,
        principal: tranche.principal,
        rate: tranche.rate,
        duration: facility.duration,
        collateral: posted,
        status: "active",
        source: "syndication",
        openedAt: createdAt,
      };
    });
    setVaults(nextVaults);
    setMarginLoans((prev) => [...openedLoans, ...prev]);
    pushNotice(`Syndicated facility created: ${formatCurrency(totalPrincipal)} across ${tranches.length} lenders.`);
  }

  function executeSecondaryTrade() {
    if (!interactive) return;
    if (!selectedFacility || !selectedTranche) {
      pushNotice("Secondary trade failed: select facility and tranche.");
      return;
    }
    const buyer = secondaryForm.buyer.trim();
    const notional = parsePositiveNumber(secondaryForm.notional);
    const pricePct = parsePositiveNumber(secondaryForm.pricePct);
    if (!buyer || !notional || !pricePct) {
      pushNotice("Secondary trade failed: enter buyer, notional, and price.");
      return;
    }
    if (notional - selectedTranche.principal > 1e-9) {
      pushNotice("Secondary trade failed: notional exceeds tranche principal.");
      return;
    }
    if (buyer === selectedTranche.currentHolder) {
      pushNotice("Secondary trade failed: buyer already holds this tranche.");
      return;
    }

    const tradeId = makeId("trade");
    const settledValue = notional * (pricePct / 100);
    const now = new Date().toISOString();

    setFacilities((prev) => prev.map((facility) => {
      if (facility.id !== selectedFacility.id) return facility;

      const target = facility.tranches.find((row) => row.id === selectedTranche.id);
      if (!target) return facility;

      if (Math.abs(target.principal - notional) <= 1e-9) {
        return {
          ...facility,
          tranches: facility.tranches.map((row) => (row.id === target.id
            ? { ...row, currentHolder: buyer }
            : row)),
        };
      }

      const residualPrincipal = target.principal - notional;
      const updatedTranches = facility.tranches.flatMap((row) => {
        if (row.id !== target.id) return [row];
        return [
          { ...row, principal: residualPrincipal },
          {
            id: makeId("tranche"),
            originLender: row.originLender,
            currentHolder: buyer,
            principal: notional,
            rate: row.rate,
            createdAt: now,
          },
        ];
      });

      return { ...facility, tranches: updatedTranches };
    }));

    setSecondaryTrades((prev) => [
      {
        id: tradeId,
        facilityId: selectedFacility.id,
        trancheId: selectedTranche.id,
        seller: selectedTranche.currentHolder,
        buyer,
        notional,
        pricePct,
        settledValue,
        createdAt: now,
      },
      ...prev,
    ].slice(0, 80));

    setSecondaryForm((prev) => ({ ...prev, notional: "25000", pricePct: "98" }));
    pushNotice(`Secondary trade executed: ${formatCurrency(notional)} from ${selectedTranche.currentHolder} to ${buyer}.`);
  }

  const restingLenderOrders = useMemo(
    () => orders.filter((row) => row.side === "lender").sort((left, right) => left.rate - right.rate || left.createdAt - right.createdAt),
    [orders],
  );
  const restingBorrowerOrders = useMemo(
    () => orders.filter((row) => row.side === "borrower").sort((left, right) => right.rate - left.rate || left.createdAt - right.createdAt),
    [orders],
  );

  const activeMarginLoans = marginLoans.filter((row) => row.status === "active");
  const notionalMatched = fills.reduce((sum, row) => sum + row.amount, 0);
  const unhealthyCount = activeMarginLoans.filter((row) => computeHealthFactor(row, marginRequirement, stressHaircut) < 1).length;

  return (
    <section className="space-y-6">
      <article className="rounded-2xl border border-shell-700 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">Advanced Engine</p>
        <h3 className="mt-1 text-2xl font-bold text-shell-950">Matching, Margin, Syndication</h3>
        <p className="mt-2 text-sm text-signal-slate">
          Session-local execution engine with price-time matching (`GTC`/`IOC`/`FOK`), collateral health, liquidation ladder, and syndicated participation trades.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 px-3 py-2 text-sm">
            <p className="text-xs uppercase tracking-[0.1em] text-signal-slate">Resting Orders</p>
            <p className="mt-1 text-xl font-semibold text-shell-950">{orders.length}</p>
          </div>
          <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 px-3 py-2 text-sm">
            <p className="text-xs uppercase tracking-[0.1em] text-signal-slate">Matched Notional</p>
            <p className="mt-1 text-xl font-semibold text-shell-950">{formatCurrency(notionalMatched)}</p>
          </div>
          <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 px-3 py-2 text-sm">
            <p className="text-xs uppercase tracking-[0.1em] text-signal-slate">Margin Alerts</p>
            <p className={`mt-1 text-xl font-semibold ${unhealthyCount > 0 ? "text-signal-coral" : "text-shell-950"}`}>{unhealthyCount}</p>
          </div>
          <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 px-3 py-2 text-sm">
            <p className="text-xs uppercase tracking-[0.1em] text-signal-slate">Syndicated Facilities</p>
            <p className="mt-1 text-xl font-semibold text-shell-950">{facilities.length}</p>
          </div>
        </div>
        {notice ? <p className="mt-4 rounded-md bg-signal-mint/15 px-3 py-2 text-sm text-shell-950">{notice}</p> : null}
      </article>

      <section className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <h4 className="text-lg font-semibold text-shell-950">1) Matching Engine + Order Types</h4>
          <p className="mt-1 text-sm text-signal-slate">
            Borrower orders define max acceptable rate. Lender orders define min acceptable rate. Matching enforces price-time priority.
          </p>
          <form className="mt-4 grid gap-3" onSubmit={(event) => void onSubmitAdvancedOrder(event)}>
            <div className="grid gap-3 sm:grid-cols-3">
              <select
                className="rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={orderForm.side}
                onChange={(event) => setOrderForm((prev) => ({ ...prev, side: event.target.value as OrderSide }))}
              >
                <option value="borrower">Borrower Order</option>
                <option value="lender">Lender Order</option>
              </select>
              <select
                className="rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={orderForm.orderType}
                onChange={(event) => setOrderForm((prev) => ({ ...prev, orderType: event.target.value as OrderType }))}
              >
                <option value="GTC">GTC</option>
                <option value="IOC">IOC</option>
                <option value="FOK">FOK</option>
              </select>
              <select
                className="rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={orderForm.party}
                onChange={(event) => setOrderForm((prev) => ({ ...prev, party: event.target.value }))}
              >
                {knownParties.map((party) => (
                  <option key={party} value={party}>{party}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <input
                className="rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={orderForm.amount}
                onChange={(event) => setOrderForm((prev) => ({ ...prev, amount: event.target.value }))}
                placeholder="Amount"
              />
              <input
                className="rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={orderForm.rate}
                onChange={(event) => setOrderForm((prev) => ({ ...prev, rate: event.target.value }))}
                placeholder={orderForm.side === "borrower" ? "Max Rate %" : "Min Rate %"}
              />
              <input
                className="rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={orderForm.duration}
                onChange={(event) => setOrderForm((prev) => ({ ...prev, duration: event.target.value }))}
                placeholder="Duration (months)"
              />
            </div>
            <button
              className="rounded-md bg-shell-950 px-4 py-2 text-sm font-semibold text-shell-900 disabled:opacity-60"
              type="submit"
              disabled={!interactive}
            >
              Submit Advanced Order
            </button>
          </form>
        </article>

        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <h4 className="text-lg font-semibold text-shell-950">Recent Fills ({fills.length})</h4>
          <div className="mt-3 space-y-2">
            {fills.slice(0, 8).map((row) => (
              <div key={row.id} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-shell-950">{formatCurrency(row.amount)}</span>
                  <span className="text-signal-slate">{formatDate(row.matchedAt)}</span>
                </div>
                <p className="text-signal-slate">
                  {row.borrower} vs {row.lender} • {formatPercent(row.rate)} • {row.duration} mo
                </p>
              </div>
            ))}
            {fills.length === 0 ? <p className="text-sm text-signal-slate">No fills yet.</p> : null}
          </div>
        </article>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <h4 className="text-lg font-semibold text-shell-950">Resting Order Book</h4>

          <h5 className="mt-3 text-sm font-semibold uppercase tracking-[0.1em] text-signal-slate">Lender Liquidity ({restingLenderOrders.length})</h5>
          <div className="mt-2 space-y-2">
            {restingLenderOrders.slice(0, 8).map((row) => {
              const draft = replaceDraftById[row.id] ?? { amount: String(row.remaining), rate: String(row.rate), duration: String(row.duration) };
              return (
                <div key={row.id} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                  <p className="font-semibold text-shell-950">
                    {formatCurrency(row.remaining)} @ {formatPercent(row.rate)} • {row.duration} mo
                  </p>
                  <p className="text-signal-slate">{row.party} • {row.orderType} • {row.source}</p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <input
                      className="rounded border border-shell-700 px-2 py-1 text-xs"
                      value={draft.amount}
                      onChange={(event) => setReplaceDraftById((prev) => ({ ...prev, [row.id]: { ...draft, amount: event.target.value } }))}
                      placeholder="Amount"
                    />
                    <input
                      className="rounded border border-shell-700 px-2 py-1 text-xs"
                      value={draft.rate}
                      onChange={(event) => setReplaceDraftById((prev) => ({ ...prev, [row.id]: { ...draft, rate: event.target.value } }))}
                      placeholder="Rate"
                    />
                    <input
                      className="rounded border border-shell-700 px-2 py-1 text-xs"
                      value={draft.duration}
                      onChange={(event) => setReplaceDraftById((prev) => ({ ...prev, [row.id]: { ...draft, duration: event.target.value } }))}
                      placeholder="Duration"
                    />
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      className="rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-shell-950"
                      onClick={() => replaceRestingOrder(row)}
                      type="button"
                      disabled={!interactive}
                    >
                      Replace
                    </button>
                    <button
                      className="rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-signal-coral"
                      onClick={() => cancelRestingOrder(row.id)}
                      type="button"
                      disabled={!interactive}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              );
            })}
            {restingLenderOrders.length === 0 ? <p className="text-sm text-signal-slate">No lender orders.</p> : null}
          </div>
        </article>

        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <h5 className="text-sm font-semibold uppercase tracking-[0.1em] text-signal-slate">Borrower Demand ({restingBorrowerOrders.length})</h5>
          <div className="mt-2 space-y-2">
            {restingBorrowerOrders.slice(0, 8).map((row) => (
              <div key={row.id} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                <p className="font-semibold text-shell-950">
                  {formatCurrency(row.remaining)} @ {formatPercent(row.rate)} • {row.duration} mo
                </p>
                <p className="text-signal-slate">{row.party} • {row.orderType} • {row.source}</p>
              </div>
            ))}
            {restingBorrowerOrders.length === 0 ? <p className="text-sm text-signal-slate">No borrower orders.</p> : null}
          </div>
        </article>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <h4 className="text-lg font-semibold text-shell-950">2) Collateral / Margin + Liquidation</h4>
          <p className="mt-1 text-sm text-signal-slate">
            Margin health uses stressed collateral / required collateral. Liquidation ladder: 25% / 50% / 100%.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
              Margin Requirement (%)
              <input
                className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={marginRequirementPct}
                onChange={(event) => setMarginRequirementPct(event.target.value)}
              />
            </label>
            <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
              Stress Haircut (%)
              <input
                className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={stressHaircutPct}
                onChange={(event) => setStressHaircutPct(event.target.value)}
              />
            </label>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <select
              className="rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={topUpParty}
              onChange={(event) => setTopUpParty(event.target.value)}
            >
              {knownParties.map((party) => (
                <option key={party} value={party}>{party}</option>
              ))}
            </select>
            <input
              className="rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={topUpAmount}
              onChange={(event) => setTopUpAmount(event.target.value)}
              placeholder="Top-up amount"
            />
            <button
              className="rounded-md border border-shell-700 px-3 py-2 text-sm font-semibold text-shell-950"
              onClick={topUpVault}
              type="button"
              disabled={!interactive}
            >
              Top Up Vault
            </button>
          </div>

          <button
            className="mt-3 rounded-md bg-shell-950 px-4 py-2 text-sm font-semibold text-shell-900 disabled:opacity-60"
            onClick={runLiquidationLadder}
            type="button"
            disabled={!interactive}
          >
            Run Liquidation Ladder
          </button>

          <div className="mt-4 space-y-2">
            {knownParties.map((party) => (
              <div key={party} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                <p className="font-semibold text-shell-950">{party}</p>
                <p className="text-signal-slate">Vault balance: {formatCurrency(vaults[party] ?? 0)}</p>
              </div>
            ))}
          </div>
        </article>

        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <h5 className="text-sm font-semibold uppercase tracking-[0.1em] text-signal-slate">Margined Loans ({marginLoans.length})</h5>
          <div className="mt-2 space-y-2">
            {marginLoans.slice(0, 10).map((loan) => {
              const hf = computeHealthFactor(loan, marginRequirement, stressHaircut);
              const tag = loan.status === "liquidated"
                ? "liquidated"
                : hf < 0.8
                  ? "critical"
                  : hf < 1
                    ? "margin-call"
                    : "healthy";
              return (
                <div key={loan.id} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-shell-950">{loan.borrower} / {loan.lender}</span>
                    <span className={`text-xs font-semibold uppercase tracking-[0.08em] ${rowStatusClass(tag)}`}>{tag}</span>
                  </div>
                  <p className="text-signal-slate">
                    Principal {formatCurrency(loan.principal)} • Collateral {formatCurrency(loan.collateral)} • HF {hf.toFixed(2)}
                  </p>
                  <p className="text-xs text-signal-slate">
                    {loan.source} • {formatPercent(loan.rate)} • {loan.duration} mo • opened {formatDate(loan.openedAt)}
                  </p>
                </div>
              );
            })}
            {marginLoans.length === 0 ? <p className="text-sm text-signal-slate">No margined positions yet.</p> : null}
          </div>

          <h5 className="mt-4 text-sm font-semibold uppercase tracking-[0.1em] text-signal-slate">Liquidation Events ({liquidations.length})</h5>
          <div className="mt-2 space-y-2">
            {liquidations.slice(0, 8).map((row) => (
              <div key={row.id} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                <p className="font-semibold text-shell-950">{row.reason}</p>
                <p className="text-signal-slate">
                  {row.borrower} / {row.lender} • {formatPercent(row.fractionLiquidated * 100)} • {formatCurrency(row.beforePrincipal)} -&gt; {formatCurrency(row.afterPrincipal)}
                </p>
              </div>
            ))}
            {liquidations.length === 0 ? <p className="text-sm text-signal-slate">No liquidation events yet.</p> : null}
          </div>
        </article>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <h4 className="text-lg font-semibold text-shell-950">3) Syndication + Secondary Market</h4>
          <p className="mt-1 text-sm text-signal-slate">
            Create multi-lender facilities, then transfer tranche participation via secondary trades.
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <select
              className="rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={facilityBorrower}
              onChange={(event) => setFacilityBorrower(event.target.value)}
            >
              {knownParties.map((party) => (
                <option key={party} value={party}>{party}</option>
              ))}
            </select>
            <input
              className="rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={facilityDuration}
              onChange={(event) => setFacilityDuration(event.target.value)}
              placeholder="Duration (months)"
            />
          </div>
          <input
            className="mt-3 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
            value={facilityPurpose}
            onChange={(event) => setFacilityPurpose(event.target.value)}
            placeholder="Facility purpose"
          />

          <div className="mt-3 space-y-2">
            {trancheDrafts.map((row, index) => (
              <div key={`tranche-draft-${index}`} className="grid gap-2 sm:grid-cols-3">
                <input
                  className="rounded-md border border-shell-700 px-3 py-2 text-sm"
                  value={row.lender}
                  onChange={(event) => setTrancheDrafts((prev) => prev.map((entry, idx) => (idx === index ? { ...entry, lender: event.target.value } : entry)))}
                  placeholder="Lender party"
                />
                <input
                  className="rounded-md border border-shell-700 px-3 py-2 text-sm"
                  value={row.amount}
                  onChange={(event) => setTrancheDrafts((prev) => prev.map((entry, idx) => (idx === index ? { ...entry, amount: event.target.value } : entry)))}
                  placeholder="Principal"
                />
                <input
                  className="rounded-md border border-shell-700 px-3 py-2 text-sm"
                  value={row.rate}
                  onChange={(event) => setTrancheDrafts((prev) => prev.map((entry, idx) => (idx === index ? { ...entry, rate: event.target.value } : entry)))}
                  placeholder="Rate %"
                />
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded border border-shell-700 px-3 py-2 text-sm font-semibold text-shell-950"
              onClick={addTrancheDraftRow}
              type="button"
            >
              Add Tranche
            </button>
            <button
              className="rounded bg-shell-950 px-3 py-2 text-sm font-semibold text-shell-900 disabled:opacity-60"
              onClick={createSyndicatedFacility}
              type="button"
              disabled={!interactive}
            >
              Create Syndicated Facility
            </button>
          </div>
        </article>

        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <h5 className="text-sm font-semibold uppercase tracking-[0.1em] text-signal-slate">Secondary Trade Ticket</h5>
          <div className="mt-3 grid gap-2">
            <select
              className="rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={secondaryForm.facilityId}
              onChange={(event) => setSecondaryForm((prev) => ({
                ...prev,
                facilityId: event.target.value,
                trancheId: facilities.find((row) => row.id === event.target.value)?.tranches[0]?.id ?? "",
              }))}
            >
              <option value="">Select facility</option>
              {facilities.map((facility) => (
                <option key={facility.id} value={facility.id}>
                  {facility.borrower} • {formatCurrency(facility.totalPrincipal)} • {facility.purpose}
                </option>
              ))}
            </select>
            <select
              className="rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={secondaryForm.trancheId}
              onChange={(event) => setSecondaryForm((prev) => ({ ...prev, trancheId: event.target.value }))}
              disabled={!selectedFacility}
            >
              <option value="">Select tranche</option>
              {selectedFacility?.tranches.map((tranche) => (
                <option key={tranche.id} value={tranche.id}>
                  Holder {tranche.currentHolder} • {formatCurrency(tranche.principal)} • {formatPercent(tranche.rate)}
                </option>
              ))}
            </select>
            <select
              className="rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={secondaryForm.buyer}
              onChange={(event) => setSecondaryForm((prev) => ({ ...prev, buyer: event.target.value }))}
            >
              {knownParties.map((party) => (
                <option key={party} value={party}>{party}</option>
              ))}
            </select>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                className="rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={secondaryForm.notional}
                onChange={(event) => setSecondaryForm((prev) => ({ ...prev, notional: event.target.value }))}
                placeholder="Notional"
              />
              <input
                className="rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={secondaryForm.pricePct}
                onChange={(event) => setSecondaryForm((prev) => ({ ...prev, pricePct: event.target.value }))}
                placeholder="Price % of par"
              />
            </div>
            <button
              className="rounded-md border border-shell-700 px-3 py-2 text-sm font-semibold text-shell-950 disabled:opacity-60"
              onClick={executeSecondaryTrade}
              type="button"
              disabled={!interactive}
            >
              Execute Participation Trade
            </button>
          </div>
        </article>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <h5 className="text-sm font-semibold uppercase tracking-[0.1em] text-signal-slate">Facilities ({facilities.length})</h5>
          <div className="mt-2 space-y-2">
            {facilities.map((facility) => (
              <div key={facility.id} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                <p className="font-semibold text-shell-950">
                  {facility.borrower} • {formatCurrency(facility.totalPrincipal)} • {facility.duration} mo
                </p>
                <p className="text-signal-slate">{facility.purpose} • created {formatDate(facility.createdAt)}</p>
                <div className="mt-2 space-y-1">
                  {facility.tranches.map((tranche) => (
                    <p key={tranche.id} className="text-xs text-signal-slate">
                      {formatCurrency(tranche.principal)} @ {formatPercent(tranche.rate)} • holder {tranche.currentHolder}
                    </p>
                  ))}
                </div>
              </div>
            ))}
            {facilities.length === 0 ? <p className="text-sm text-signal-slate">No syndicated facilities yet.</p> : null}
          </div>
        </article>

        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <h5 className="text-sm font-semibold uppercase tracking-[0.1em] text-signal-slate">Secondary Trades ({secondaryTrades.length})</h5>
          <div className="mt-2 space-y-2">
            {secondaryTrades.map((trade) => (
              <div key={trade.id} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                <p className="font-semibold text-shell-950">
                  {trade.seller} -&gt; {trade.buyer} • {formatCurrency(trade.notional)}
                </p>
                <p className="text-signal-slate">
                  {trade.pricePct.toFixed(2)}% of par • settle {formatCurrency(trade.settledValue)} • {formatDate(trade.createdAt)}
                </p>
              </div>
            ))}
            {secondaryTrades.length === 0 ? <p className="text-sm text-signal-slate">No secondary trades yet.</p> : null}
          </div>
        </article>
      </section>
    </section>
  );
}
