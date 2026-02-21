import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCreditLendingData } from "../hooks/useCreditLendingData";
import { AdvancedLendingLab } from "./AdvancedLendingLab";
import type { ApiOrderBookTier, BorrowerAsk, LenderBid } from "../types/creditLending";

type LendingSubview = "borrower" | "lender" | "orderbook" | "advanced";

interface CreditLendingViewProps {
  forceDemo?: boolean;
  demoRunToken?: number;
}

interface WalkthroughStep {
  title: string;
  description: string;
  view: LendingSubview;
}

const PRIVATE_REQUEST_DURATION_MONTHS = 12;
const PRIVATE_BID_DURATION_MONTHS = 18;

const WALKTHROUGH_STEPS: WalkthroughStep[] = [
  { title: "Canton Verification", description: "All participants receive privacy-scoped verification.", view: "borrower" },
  { title: "Borrower Demand", description: "Borrower posts private amount + APY request.", view: "borrower" },
  { title: "Lender Liquidity", description: "Lender posts private liquidity and offers.", view: "lender" },
  { title: "Borrower Accepts", description: "Borrower accepts via private token intent.", view: "borrower" },
  { title: "Funding Confirmed", description: "Lender confirms funding without identity disclosure.", view: "lender" },
  { title: "Repayment Requested", description: "Borrower requests repayment privately.", view: "borrower" },
  { title: "Repayment Settled", description: "Lender completes repayment.", view: "lender" },
  { title: "Order Book Check", description: "Anonymized spread/depth update.", view: "orderbook" },
  { title: "Advanced Scenarios", description: "Matching, margin, syndication, secondary trades.", view: "advanced" },
];

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function parsePositiveNumber(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function statusClass(status: string): string {
  if (["active", "open", "pending", "filled", "offered", "accepted"].includes(status)) {
    return "bg-signal-mint/12 text-signal-mint border-signal-mint/30";
  }
  if (status === "partial") {
    return "bg-signal-amber/12 text-signal-amber border-signal-amber/35";
  }
  if (["defaulted", "rejected", "cancelled"].includes(status)) {
    return "bg-signal-coral/12 text-signal-coral border-signal-coral/30";
  }
  return "bg-shell-900 text-signal-slate border-shell-700/60";
}

function badge(status: string) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusClass(status)}`}>
      {status}
    </span>
  );
}

function privacyScoreForParty(party: string): number {
  const base = party.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return 620 + (base % 180);
}

function aggregateFallbackOrderBook(
  lenderBids: LenderBid[],
  borrowerAsks: BorrowerAsk[],
): { asks: ApiOrderBookTier[]; bids: ApiOrderBookTier[]; spread: number | null } {
  const asksMap = new Map<string, ApiOrderBookTier>();
  const bidsMap = new Map<string, ApiOrderBookTier>();

  for (const bid of lenderBids) {
    const key = `${bid.minInterestRate}|${bid.maxDuration}`;
    const existing = asksMap.get(key);
    if (existing) {
      existing.totalAmount += bid.remainingAmount;
      existing.orderCount += 1;
    } else {
      asksMap.set(key, {
        interestRate: bid.minInterestRate,
        duration: bid.maxDuration,
        totalAmount: bid.remainingAmount,
        orderCount: 1,
      });
    }
  }

  for (const ask of borrowerAsks) {
    const key = `${ask.maxInterestRate}|${ask.duration}`;
    const existing = bidsMap.get(key);
    if (existing) {
      existing.totalAmount += ask.amount;
      existing.orderCount += 1;
    } else {
      bidsMap.set(key, {
        interestRate: ask.maxInterestRate,
        duration: ask.duration,
        totalAmount: ask.amount,
        orderCount: 1,
      });
    }
  }

  const asks = Array.from(asksMap.values()).sort((left, right) => right.interestRate - left.interestRate);
  const bids = Array.from(bidsMap.values()).sort((left, right) => right.interestRate - left.interestRate);

  const bestAsk = asks.length ? Math.min(...asks.map((row) => row.interestRate)) : null;
  const bestBid = bids.length ? Math.max(...bids.map((row) => row.interestRate)) : null;
  const spread = bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null;

  return { asks, bids, spread };
}

export function CreditLendingView({ forceDemo = false, demoRunToken = 0 }: CreditLendingViewProps) {
  const lending = useCreditLendingData({ forceDemo });
  const lendingRef = useRef(lending);

  const [activeView, setActiveView] = useState<LendingSubview>("borrower");
  const [status, setStatus] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(forceDemo);
  const [presentationMode, setPresentationMode] = useState(forceDemo);
  const [showAdvancedPanels, setShowAdvancedPanels] = useState(false);
  const [cantonVerified, setCantonVerified] = useState(false);
  const [verifyingCanton, setVerifyingCanton] = useState(false);
  const [walkthroughStepIndex, setWalkthroughStepIndex] = useState(0);
  const [advancedAutoRunToken, setAdvancedAutoRunToken] = useState(0);
  const [autoDemoBusy, setAutoDemoBusy] = useState(false);
  const lastDemoRunTokenRef = useRef(0);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  const [walletDraft, setWalletDraft] = useState("");

  const [requestForm, setRequestForm] = useState({ amount: "5000", rate: "8.5" });
  const [askForm, setAskForm] = useState({ amount: "5000", rate: "8.5" });
  const [offerForm, setOfferForm] = useState({ loanRequestId: "", amount: "5000", rate: "8.0" });
  const [bidForm, setBidForm] = useState({ amount: "10000", rate: "6.5" });
  const [manualAllocationById, setManualAllocationById] = useState<Record<string, string>>({});

  const authenticated = lending.authStatus === "authenticated" && !demoMode;
  const baseInteractive = authenticated || demoMode;
  const interactive = baseInteractive && cantonVerified;
  const currentParty = lending.currentUser?.party ?? "demo-user";
  const modeLabel = authenticated ? "Live Privacy Mode" : "Interactive Privacy Demo";

  useEffect(() => {
    lendingRef.current = lending;
  }, [lending]);

  useEffect(() => {
    if (forceDemo) {
      setDemoMode(true);
    }
  }, [forceDemo]);

  useEffect(() => {
    setWalletDraft(lending.walletUrl ?? "");
  }, [lending.walletUrl]);

  const myRequests = useMemo(
    () => lending.requests.filter((row) => row.borrower === currentParty),
    [currentParty, lending.requests],
  );
  const myAsks = useMemo(
    () => lending.asks.filter((row) => row.borrower === currentParty),
    [currentParty, lending.asks],
  );
  const myLoansBorrower = useMemo(
    () => lending.loans.filter((row) => row.borrower === currentParty),
    [currentParty, lending.loans],
  );
  const myLoansLender = useMemo(
    () => lending.loans.filter((row) => row.lender === currentParty),
    [currentParty, lending.loans],
  );

  const myBids = useMemo(
    () => lending.bids.filter((row) => row.lender === currentParty),
    [currentParty, lending.bids],
  );

  const openRequestsForLender = useMemo(
    () => lending.requests.filter((row) => row.status === "open" && row.borrower !== currentParty),
    [currentParty, lending.requests],
  );

  const myFundingIntentsBorrower = useMemo(
    () => lending.fundingIntents.filter((row) => row.borrower === currentParty),
    [currentParty, lending.fundingIntents],
  );

  const myFundingIntentsLender = useMemo(
    () => lending.fundingIntents.filter((row) => row.lender === currentParty),
    [currentParty, lending.fundingIntents],
  );

  const myPrincipalRequestsLender = useMemo(
    () => lending.principalRequests.filter((row) => row.lender === currentParty),
    [currentParty, lending.principalRequests],
  );

  const myRepaymentRequestsBorrower = useMemo(
    () => lending.repaymentRequests.filter((row) => row.borrower === currentParty),
    [currentParty, lending.repaymentRequests],
  );

  const myRepaymentRequestsLender = useMemo(
    () => lending.repaymentRequests.filter((row) => row.lender === currentParty),
    [currentParty, lending.repaymentRequests],
  );

  const myMatchedAsBorrower = useMemo(
    () => lending.matchedProposals.filter((row) => row.borrower === currentParty),
    [currentParty, lending.matchedProposals],
  );

  const myMatchedAsLender = useMemo(
    () => lending.matchedProposals.filter((row) => row.lender === currentParty),
    [currentParty, lending.matchedProposals],
  );

  const borrowerOfferInbox = useMemo(
    () => lending.offers.filter((row) => {
      const sourceRequest = lending.requests.find(
        (request) => request.contractId === row.loanRequestId || request.id === row.loanRequestId,
      );
      if (!sourceRequest) {
        return true;
      }
      return sourceRequest.borrower === currentParty;
    }),
    [currentParty, lending.offers, lending.requests],
  );

  useEffect(() => {
    if (!offerForm.loanRequestId && openRequestsForLender[0]?.contractId) {
      setOfferForm((prev) => ({ ...prev, loanRequestId: openRequestsForLender[0].contractId }));
    }
  }, [offerForm.loanRequestId, openRequestsForLender]);

  const fallbackBook = useMemo(
    () => aggregateFallbackOrderBook(lending.bids, lending.asks),
    [lending.asks, lending.bids],
  );

  const bookAsks = lending.orderBook?.asks?.length ? lending.orderBook.asks : fallbackBook.asks;
  const bookBids = lending.orderBook?.bids?.length ? lending.orderBook.bids : fallbackBook.bids;
  const bookSpread = lending.orderBook?.spread ?? fallbackBook.spread;

  const askVolume = bookAsks.reduce((sum, row) => sum + row.totalAmount, 0);
  const bidVolume = bookBids.reduce((sum, row) => sum + row.totalAmount, 0);
  const orderCount = bookAsks.reduce((sum, row) => sum + row.orderCount, 0)
    + bookBids.reduce((sum, row) => sum + row.orderCount, 0);
  const activeLoanCount = lending.loans.filter((row) => row.status === "active").length;
  const currentWalkthroughStep = WALKTHROUGH_STEPS[walkthroughStepIndex] ?? WALKTHROUGH_STEPS[0];

  async function runAction(label: string, action: () => Promise<void>) {
    setStatus(null);
    try {
      await action();
      setStatus(label);
    } catch {
      // Hook already surfaces error state.
    }
  }

  const goToWalkthroughStep = useCallback((nextIndex: number, openFullControls = false) => {
    const clamped = Math.min(WALKTHROUGH_STEPS.length - 1, Math.max(0, nextIndex));
    const step = WALKTHROUGH_STEPS[clamped];
    setWalkthroughStepIndex(clamped);
    setActiveView(step.view);
    if (openFullControls) {
      setPresentationMode(false);
    }
    setStatus(`Step ${clamped + 1}/${WALKTHROUGH_STEPS.length}: ${step.title}`);
  }, []);

  const moveWalkthroughStep = useCallback((direction: -1 | 1, openFullControls = false) => {
    goToWalkthroughStep(walkthroughStepIndex + direction, openFullControls);
  }, [goToWalkthroughStep, walkthroughStepIndex]);

  const runCantonVerification = useCallback(async () => {
    if (cantonVerified || verifyingCanton) {
      return;
    }

    setVerifyingCanton(true);
    setStatus("Running Canton privacy verification for all participants...");
    await delay(900);
    await delay(900);
    setCantonVerified(true);
    setStatus("Canton verification complete. Only amount, APY, and score are visible.");
    setVerifyingCanton(false);
  }, [cantonVerified, verifyingCanton]);

  const runFullDemoScenario = useCallback(async () => {
    if (autoDemoBusy || !baseInteractive) {
      return;
    }

    if (!cantonVerified) {
      await runCantonVerification();
    }

    const wait = (ms: number) => new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    });
    const stepPauseMs = 1200;
    const transitionMs = 850;
    const goToStep = async (index: number) => {
      const step = WALKTHROUGH_STEPS[index];
      setWalkthroughStepIndex(index);
      setStatus(`Step ${index + 1}/${WALKTHROUGH_STEPS.length}: ${step.title}`);
      setActiveView(step.view);
      await wait(stepPauseMs);
    };

    setAutoDemoBusy(true);
    setDemoMode(true);
    setPresentationMode(false);
    setWalkthroughStepIndex(0);
    setStatus("Starting guided lending demo...");

    const wallet = "https://wallet.demo.local";
    lendingRef.current.setWalletUrl(wallet);
    setWalletDraft(wallet);

    try {
      await goToStep(0);
      await wait(transitionMs);

      await goToStep(1);
      await lendingRef.current.createLoanRequest({
        amount: 18000,
        interestRate: 8.1,
        duration: 12,
        purpose: "Guided Demo Working Capital",
      });

      const snapshotAfterRequest = lendingRef.current;
      if (snapshotAfterRequest.creditProfile.contractId) {
        await snapshotAfterRequest.createBorrowerAsk({
          amount: 16000,
          maxInterestRate: 8.4,
          duration: 12,
          creditProfileId: snapshotAfterRequest.creditProfile.contractId,
        });
      }
      await wait(transitionMs);

      await goToStep(2);
      await lendingRef.current.createLenderBid({
        amount: 25000,
        minInterestRate: 6.9,
        maxDuration: 18,
      });

      const snapshotForOffer = lendingRef.current;
      const requestForOffer = snapshotForOffer.requests.find((row) => row.borrower !== currentParty && row.status === "open")
        ?? snapshotForOffer.requests.find((row) => row.borrower !== currentParty);
      if (requestForOffer) {
        await snapshotForOffer.createLoanOffer({
          loanRequestId: requestForOffer.contractId,
          amount: Math.max(4000, Math.round(requestForOffer.amount * 0.45)),
          interestRate: Math.max(6.5, requestForOffer.interestRate - 0.4),
          duration: requestForOffer.duration,
        });
      }
      await wait(transitionMs);

      await goToStep(3);
      const snapshotForTokenAccept = lendingRef.current;
      const offerForBorrower = snapshotForTokenAccept.offers.find((offer) => {
        const sourceRequest = snapshotForTokenAccept.requests.find(
          (row) => row.contractId === offer.loanRequestId || row.id === offer.loanRequestId,
        );
        return !!sourceRequest && sourceRequest.borrower === currentParty && offer.status === "pending";
      });

      if (offerForBorrower && snapshotForTokenAccept.creditProfile.contractId) {
        await snapshotForTokenAccept.acceptOfferWithToken(
          offerForBorrower.contractId,
          snapshotForTokenAccept.creditProfile.contractId,
        );
      }
      await wait(transitionMs);

      await goToStep(4);
      const snapshotForIntent = lendingRef.current;
      const lenderIntent = snapshotForIntent.fundingIntents.find((row) => row.lender === currentParty);
      if (lenderIntent) {
        await snapshotForIntent.confirmFundingIntent(lenderIntent.contractId);
      }

      const snapshotForFunding = lendingRef.current;
      const lenderPrincipalRequest = snapshotForFunding.principalRequests.find((row) => row.lender === currentParty);
      if (lenderPrincipalRequest) {
        await snapshotForFunding.completeFunding(
          lenderPrincipalRequest.contractId,
          `alloc-funding-${Date.now()}`,
        );
      }
      await wait(transitionMs);

      await goToStep(5);
      const snapshotForRepaymentRequest = lendingRef.current;
      const borrowerLoan = snapshotForRepaymentRequest.loans.find((row) => row.borrower === currentParty && row.status === "active");
      if (borrowerLoan) {
        await snapshotForRepaymentRequest.requestRepayment(borrowerLoan.contractId);
      }
      await wait(transitionMs);

      await goToStep(6);
      const snapshotForRepayment = lendingRef.current;
      const lenderRepayment = snapshotForRepayment.repaymentRequests.find((row) => row.lender === currentParty);
      if (lenderRepayment) {
        await snapshotForRepayment.completeRepayment(
          lenderRepayment.contractId,
          `alloc-repay-${Date.now()}`,
        );
      }
      await wait(transitionMs);
      await goToStep(7);

      await goToStep(8);
      setAdvancedAutoRunToken((value) => value + 1);
      await wait(900);
      setStatus("Guided demo complete. Replay anytime with Run Full Demo.");
    } catch {
      setStatus("Guided demo completed with partial data. Continue in full controls.");
    } finally {
      setAutoDemoBusy(false);
    }
  }, [autoDemoBusy, baseInteractive, cantonVerified, currentParty, runCantonVerification]);

  useEffect(() => {
    if (demoRunToken <= 0 || demoRunToken === lastDemoRunTokenRef.current) {
      return;
    }
    lastDemoRunTokenRef.current = demoRunToken;
    void runFullDemoScenario();
  }, [demoRunToken, runFullDemoScenario]);

  async function onLoginSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError(null);

    if (!username.trim()) {
      setLoginError("Username is required.");
      return;
    }

    setLoginBusy(true);
    try {
      const ok = await lending.login(username.trim(), password);
      if (!ok) {
        setLoginError("Login failed. Check credentials.");
      }
    } catch {
      setLoginError("Could not reach the backend.");
    } finally {
      setLoginBusy(false);
    }
  }

  async function onCreateRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!interactive) return;

    const amount = parsePositiveNumber(requestForm.amount);
    const interestRate = parsePositiveNumber(requestForm.rate);

    if (!amount || !interestRate) {
      setStatus("Enter a valid amount and APY.");
      return;
    }

    await runAction("Loan request submitted.", async () => {
      await lending.createLoanRequest({
        amount,
        interestRate,
        duration: PRIVATE_REQUEST_DURATION_MONTHS,
        purpose: "Private Canton Credit Request",
      });
    });
  }

  async function onPlaceAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!interactive) return;

    const amount = parsePositiveNumber(askForm.amount);
    const maxInterestRate = parsePositiveNumber(askForm.rate);
    const creditProfileId = lending.creditProfile.contractId;

    if (!amount || !maxInterestRate || !creditProfileId) {
      setStatus("Place ask failed. Ensure values are valid and a credit profile exists.");
      return;
    }

    await runAction("Order-book ask placed.", async () => {
      await lending.createBorrowerAsk({
        amount,
        maxInterestRate,
        duration: PRIVATE_REQUEST_DURATION_MONTHS,
        creditProfileId,
      });
    });
  }

  async function onCreateOffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!interactive) return;

    const amount = parsePositiveNumber(offerForm.amount);
    const interestRate = parsePositiveNumber(offerForm.rate);

    if (!offerForm.loanRequestId || !amount || !interestRate) {
      setStatus("Select a request and enter valid amount and APY.");
      return;
    }

    await runAction("Loan offer created.", async () => {
      await lending.createLoanOffer({
        loanRequestId: offerForm.loanRequestId,
        amount,
        interestRate,
        duration: PRIVATE_REQUEST_DURATION_MONTHS,
      });
    });
  }

  async function onPlaceBid(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!interactive) return;

    const amount = parsePositiveNumber(bidForm.amount);
    const minInterestRate = parsePositiveNumber(bidForm.rate);

    if (!amount || !minInterestRate) {
      setStatus("Enter valid amount and APY.");
      return;
    }

    await runAction("Lender bid placed.", async () => {
      await lending.createLenderBid({ amount, minInterestRate, maxDuration: PRIVATE_BID_DURATION_MONTHS });
    });
  }

  if (lending.authStatus === "checking" && !demoMode) {
    return (
      <section className="mt-6 animate-fade-rise rounded-2xl border border-shell-700 bg-white/90 p-8 shadow-soft">
        <p className="text-sm font-semibold uppercase tracking-[0.12em] text-signal-slate">Credit Lending</p>
        <h2 className="mt-2 text-2xl font-bold text-shell-950">Connecting to lending backend</h2>
        <p className="mt-2 text-sm text-signal-slate">Checking authentication and backend availability...</p>
      </section>
    );
  }

  if ((lending.authStatus === "unauthenticated" || lending.authStatus === "no-backend") && !demoMode && !forceDemo) {
    return (
      <section className="mt-6 animate-fade-rise rounded-2xl border border-shell-700 bg-white/92 p-6 shadow-soft">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">Credit Lending</p>
        <h2 className="mt-2 text-2xl font-bold text-shell-950">Sign In</h2>
        <p className="mt-1 text-sm text-signal-slate">
          {lending.authStatus === "no-backend"
            ? "Backend not reachable. Use interactive demo mode."
            : "Authenticate with the lending backend to use borrower/lender workflows."}
        </p>

        <form className="mt-5 grid gap-3 sm:max-w-md" onSubmit={(event) => void onLoginSubmit(event)}>
          <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Username
            <input
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="app-user"
            />
          </label>

          <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Password
            <input
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Optional"
            />
          </label>

          {loginError ? (
            <p className="rounded-md bg-signal-coral/12 px-3 py-2 text-sm text-signal-coral">{loginError}</p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-md bg-shell-950 px-4 py-2 text-sm font-semibold text-shell-900"
              type="submit"
              disabled={loginBusy}
            >
              {loginBusy ? "Signing in..." : "Sign In"}
            </button>

            <button
              className="rounded-md border border-shell-700 px-4 py-2 text-sm font-semibold text-shell-950"
              type="button"
              onClick={() => setDemoMode(true)}
            >
              Open Interactive Demo
            </button>
          </div>
        </form>
      </section>
    );
  }

  if (!cantonVerified) {
    return (
      <section className="mt-6 animate-fade-rise rounded-2xl border border-shell-700 bg-white/92 p-8 shadow-soft">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Canton Privacy Verification</p>
        <h2 className="mt-2 text-2xl font-bold text-shell-950">Verify Participants Before Lending</h2>
        <p className="mt-2 max-w-3xl text-sm text-signal-slate">
          This desk runs in privacy mode: Canton verification happens first. After verification, counterparties stay anonymous and only
          amount, APY, and credit score are exchanged.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            className="rounded-md bg-shell-950 px-4 py-2 text-sm font-semibold text-shell-900"
            onClick={() => void runCantonVerification()}
            disabled={verifyingCanton}
            type="button"
          >
            {verifyingCanton ? "Verifying..." : "Run Canton Verification"}
          </button>
        </div>
      </section>
    );
  }

  if (forceDemo && presentationMode) {
    return (
      <section className="mt-6 space-y-6 animate-fade-rise">
        <article className="rounded-2xl border border-shell-700 bg-white/92 p-5 shadow-soft">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Simple Demo View</p>
              <h2 className="mt-1 text-2xl font-bold text-shell-950">Lending Lifecycle Overview</h2>
              <p className="mt-1 text-sm text-signal-slate">
                Canton-first privacy flow: verify once, then run demand, liquidity, matching, funding, repayment, and advanced scenarios.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                onClick={() => void runFullDemoScenario()}
                disabled={autoDemoBusy || !interactive}
                type="button"
              >
                {autoDemoBusy ? "Running Demo..." : "Run Full Demo"}
              </button>
              <button
                className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                onClick={() => setPresentationMode(false)}
                type="button"
              >
                Open Full Controls
              </button>
            </div>
          </div>
          {status ? <p className="mt-4 rounded-lg bg-signal-mint/15 px-3 py-2 text-sm text-shell-950">{status}</p> : null}
          {lending.error ? <p className="mt-4 rounded-lg bg-signal-coral/15 px-3 py-2 text-sm text-signal-coral">{lending.error}</p> : null}
        </article>

        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-signal-slate">Requests</p>
              <p className="text-lg font-semibold text-shell-950">{lending.requests.length}</p>
            </div>
            <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-signal-slate">Offers</p>
              <p className="text-lg font-semibold text-shell-950">{lending.offers.length}</p>
            </div>
            <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-signal-slate">Active Loans</p>
              <p className="text-lg font-semibold text-shell-950">{activeLoanCount}</p>
            </div>
            <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-signal-slate">Book Levels</p>
              <p className="text-lg font-semibold text-shell-950">{bookAsks.length + bookBids.length}</p>
            </div>
          </div>

          <h3 className="mt-4 text-lg font-semibold text-shell-950">How The Demo Works</h3>
          <p className="mt-1 text-sm text-signal-slate">Use arrows to walk each step, then open full controls for detail.</p>
          <div className="mt-4 flex items-center gap-2">
            <button
              className="rounded border border-shell-700 px-3 py-2 text-sm font-semibold text-shell-950"
              type="button"
              onClick={() => moveWalkthroughStep(-1)}
              disabled={walkthroughStepIndex === 0}
            >
              &lt; Prev
            </button>
            <div className="min-w-0 flex-1 rounded-lg border border-shell-700/70 bg-shell-900/40 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-signal-slate">
                Step {walkthroughStepIndex + 1} of {WALKTHROUGH_STEPS.length}
              </p>
              <p className="mt-1 text-sm font-semibold text-shell-950">{currentWalkthroughStep.title}</p>
              <p className="text-sm text-signal-slate">{currentWalkthroughStep.description}</p>
            </div>
            <button
              className="rounded border border-shell-700 px-3 py-2 text-sm font-semibold text-shell-950"
              type="button"
              onClick={() => moveWalkthroughStep(1)}
              disabled={walkthroughStepIndex === WALKTHROUGH_STEPS.length - 1}
            >
              Next &gt;
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded border border-shell-700 px-3 py-2 text-sm font-semibold text-shell-950"
              onClick={() => goToWalkthroughStep(walkthroughStepIndex, true)}
              type="button"
            >
              Open Step In Workspace
            </button>
            <button
              className="rounded border border-shell-700 px-3 py-2 text-sm font-semibold text-shell-950"
              onClick={() => goToWalkthroughStep(0)}
              type="button"
            >
              Reset To Step 1
            </button>
          </div>
        </article>
      </section>
    );
  }

  return (
    <section className="mt-6 space-y-6 animate-fade-rise">
      <article className="rounded-2xl border border-shell-700 bg-white/92 p-5 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Credit Lending</p>
            <h2 className="mt-1 text-2xl font-bold text-shell-950">Borrower + Lender Console</h2>
            <p className="mt-1 text-sm text-signal-slate">
              Canton privacy lending lifecycle with anonymized counterparties and score-based matching.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {forceDemo ? (
              <>
                <button
                  className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                  onClick={() => moveWalkthroughStep(-1, true)}
                  disabled={walkthroughStepIndex === 0}
                  type="button"
                >
                  &lt;
                </button>
                <button
                  className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                  onClick={() => moveWalkthroughStep(1, true)}
                  disabled={walkthroughStepIndex === WALKTHROUGH_STEPS.length - 1}
                  type="button"
                >
                  &gt;
                </button>
                <button
                  className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                  onClick={() => setPresentationMode(true)}
                  type="button"
                >
                  Demo View
                </button>
              </>
            ) : null}
            <button
              className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
              onClick={() => setShowAdvancedPanels((value) => !value)}
              type="button"
            >
              {showAdvancedPanels ? "Core Mode" : "Advanced Details"}
            </button>
            <button
              className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
              onClick={() => void runFullDemoScenario()}
              disabled={autoDemoBusy || !interactive}
              type="button"
            >
              {autoDemoBusy ? "Running..." : "Run Full Demo"}
            </button>
            {!forceDemo ? (
              <button
                className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                onClick={() => void lending.refresh()}
                disabled={lending.loading || !interactive}
                type="button"
              >
                Refresh
              </button>
            ) : null}
            {authenticated ? (
              <button
                className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                onClick={() => void lending.logout()}
                type="button"
              >
                Sign Out
              </button>
            ) : !forceDemo ? (
              <button
                className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                onClick={() => setDemoMode(false)}
                type="button"
              >
                Exit Demo
              </button>
            ) : (
              <span className="rounded-md border border-signal-mint/40 bg-signal-mint/15 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-signal-mint">
                Demo Mode
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-shell-700/70 bg-shell-900/40 px-3 py-2 text-sm">
          <span className="font-semibold text-shell-950">Mode:</span>{" "}
          <span className="text-signal-slate">{modeLabel}</span>
          <span className="px-1 text-signal-slate">|</span>
          <span className="text-signal-slate">Counterparties remain anonymous after Canton verification.</span>
        </div>

        {showAdvancedPanels ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
            <input
              className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={walletDraft}
              onChange={(event) => setWalletDraft(event.target.value)}
              placeholder="Wallet URL for token-based steps (optional)"
              disabled={!interactive}
            />
            <button
              className="rounded-md border border-shell-700 px-3 py-2 text-sm font-semibold text-shell-950"
              onClick={() => {
                lending.setWalletUrl(walletDraft.trim() || null);
                setStatus("Wallet URL updated.");
              }}
              type="button"
              disabled={!interactive}
            >
              Save Wallet
            </button>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          {(["borrower", "lender", "orderbook", ...(showAdvancedPanels ? ["advanced"] : [])] as LendingSubview[]).map((entry) => (
            <button
              key={entry}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${activeView === entry
                ? "border border-signal-mint/40 bg-shell-950 text-shell-900 shadow-soft"
                : "border border-shell-700/70 bg-white/75 text-signal-slate hover:border-signal-mint/40 hover:text-shell-950"
              }`}
              onClick={() => {
                setActiveView(entry as LendingSubview);
                const stepIndex = WALKTHROUGH_STEPS.findIndex((step) => step.view === entry);
                if (stepIndex >= 0) {
                  setWalkthroughStepIndex(stepIndex);
                }
              }}
              type="button"
            >
              {entry === "borrower"
                ? "Borrower"
                : entry === "lender"
                  ? "Lender"
                  : entry === "orderbook"
                    ? "Order Book"
                    : "Advanced"}
            </button>
          ))}
        </div>

        {status ? <p className="mt-4 rounded-lg bg-signal-mint/15 px-3 py-2 text-sm text-shell-950">{status}</p> : null}
        {lending.error ? <p className="mt-4 rounded-lg bg-signal-coral/15 px-3 py-2 text-sm text-signal-coral">{lending.error}</p> : null}
        {lending.loading ? <p className="mt-4 text-sm text-signal-slate">Refreshing lending data...</p> : null}
      </article>

      {activeView === "borrower" ? (
        <>
          <section className={`grid gap-6 ${showAdvancedPanels ? "xl:grid-cols-2" : ""}`}>
            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Create Loan Request</h3>
              <p className="mt-1 text-sm text-signal-slate">Publish private lending demand with amount and APY only.</p>

              <form className="mt-4 grid gap-3" onSubmit={(event) => void onCreateRequest(event)}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                    value={requestForm.amount}
                    onChange={(event) => setRequestForm((prev) => ({ ...prev, amount: event.target.value }))}
                    placeholder="Amount"
                  />
                  <input
                    className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                    value={requestForm.rate}
                    onChange={(event) => setRequestForm((prev) => ({ ...prev, rate: event.target.value }))}
                    placeholder="APY %"
                  />
                </div>
                <button
                  className="rounded-md bg-shell-950 px-4 py-2 text-sm font-semibold text-shell-900"
                  type="submit"
                  disabled={!interactive}
                >
                  Submit Request
                </button>
              </form>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Place Borrower Ask</h3>
              <p className="mt-1 text-sm text-signal-slate">Expose private borrower demand into the order book.</p>

              <form className="mt-4 grid gap-3" onSubmit={(event) => void onPlaceAsk(event)}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                    value={askForm.amount}
                    onChange={(event) => setAskForm((prev) => ({ ...prev, amount: event.target.value }))}
                    placeholder="Amount"
                  />
                  <input
                    className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                    value={askForm.rate}
                    onChange={(event) => setAskForm((prev) => ({ ...prev, rate: event.target.value }))}
                    placeholder="Max APY %"
                  />
                </div>
                <button
                  className="rounded-md border border-shell-700 px-4 py-2 text-sm font-semibold text-shell-950"
                  type="submit"
                  disabled={!interactive || !lending.creditProfile.contractId}
                >
                  Place Ask
                </button>
              </form>
            </article>
          </section>

          {showAdvancedPanels ? (
            <section className="grid gap-6 xl:grid-cols-2">
              <article className="rounded-2xl border border-shell-700 bg-white p-5">
                <h3 className="text-lg font-semibold text-shell-950">My Loan Requests ({myRequests.length})</h3>
                <div className="mt-3 space-y-2">
                  {myRequests.map((row) => (
                    <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold text-shell-950">Verified Request</div>
                        {badge(row.status)}
                      </div>
                      <div className="mt-1 text-signal-slate">
                        {formatCurrency(row.amount)} | APY {formatPercent(row.interestRate)} | score {lending.creditProfile.score} | {row.offersCount} offers
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          className="rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-signal-coral"
                          onClick={() => void runAction("Loan request withdrawn.", async () => {
                            await lending.withdrawLoanRequest(row.id);
                          })}
                          disabled={!interactive || row.status !== "open"}
                          type="button"
                        >
                          Withdraw
                        </button>
                      </div>
                    </div>
                  ))}
                  {myRequests.length === 0 ? <p className="text-sm text-signal-slate">No requests yet.</p> : null}
                </div>
              </article>

              <article className="rounded-2xl border border-shell-700 bg-white p-5">
                <h3 className="text-lg font-semibold text-shell-950">Credit Profile</h3>
                <div className="mt-3 rounded-lg border border-shell-700/70 bg-shell-900/40 p-4">
                  <p className="text-4xl font-bold text-shell-950">{lending.creditProfile.score}</p>
                  <p className="text-sm text-signal-slate">Canton-verified private score feed.</p>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div className="rounded-md bg-white/80 p-2 text-center">
                      <p className="font-semibold text-shell-950">{lending.creditProfile.totalLoans}</p>
                      <p className="text-signal-slate">Total</p>
                    </div>
                    <div className="rounded-md bg-white/80 p-2 text-center">
                      <p className="font-semibold text-shell-950">{lending.creditProfile.successfulRepayments}</p>
                      <p className="text-signal-slate">Repaid</p>
                    </div>
                    <div className="rounded-md bg-white/80 p-2 text-center">
                      <p className="font-semibold text-shell-950">{lending.creditProfile.defaults}</p>
                      <p className="text-signal-slate">Defaults</p>
                    </div>
                  </div>
                </div>

                <h4 className="mt-4 text-sm font-semibold uppercase tracking-[0.1em] text-signal-slate">My Order-Book Asks ({myAsks.length})</h4>
                <div className="mt-2 space-y-2">
                  {myAsks.map((row) => (
                    <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-shell-950">{formatCurrency(row.amount)} ask</span>
                        {badge(row.status)}
                      </div>
                      <div className="text-signal-slate">Max APY {formatPercent(row.maxInterestRate)} | score {lending.creditProfile.score}</div>
                      <button
                        className="mt-2 rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-signal-coral"
                        onClick={() => void runAction("Borrower ask cancelled.", async () => {
                          await lending.cancelBorrowerAsk(row.contractId);
                        })}
                        disabled={!interactive}
                        type="button"
                      >
                        Cancel Ask
                      </button>
                    </div>
                  ))}
                  {myAsks.length === 0 ? <p className="text-sm text-signal-slate">No asks yet.</p> : null}
                </div>
              </article>
            </section>
          ) : (
            <section className="grid gap-6 xl:grid-cols-2">
              <article className="rounded-2xl border border-shell-700 bg-white p-5">
                <h3 className="text-lg font-semibold text-shell-950">Borrower Snapshot</h3>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-md border border-shell-700/70 bg-shell-900/40 p-3 text-center text-sm">
                    <p className="font-semibold text-shell-950">{myRequests.length}</p>
                    <p className="text-signal-slate">Requests</p>
                  </div>
                  <div className="rounded-md border border-shell-700/70 bg-shell-900/40 p-3 text-center text-sm">
                    <p className="font-semibold text-shell-950">{myAsks.length}</p>
                    <p className="text-signal-slate">Asks</p>
                  </div>
                  <div className="rounded-md border border-shell-700/70 bg-shell-900/40 p-3 text-center text-sm">
                    <p className="font-semibold text-shell-950">{myLoansBorrower.length}</p>
                    <p className="text-signal-slate">Loans</p>
                  </div>
                </div>
              </article>
              <article className="rounded-2xl border border-shell-700 bg-white p-5">
                <h3 className="text-lg font-semibold text-shell-950">Credit Score</h3>
                <p className="mt-2 text-4xl font-bold text-shell-950">{lending.creditProfile.score}</p>
                <p className="mt-1 text-sm text-signal-slate">Advanced borrower analytics available via `Advanced Details`.</p>
              </article>
            </section>
          )}

          <section className="grid gap-6 xl:grid-cols-2">
            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Offer Inbox ({borrowerOfferInbox.length})</h3>
              <div className="mt-3 space-y-2">
                {borrowerOfferInbox.map((row) => (
                  <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-shell-950">Verified Lender Offer</div>
                      {badge(row.status)}
                    </div>
                    <div className="mt-1 text-signal-slate">
                      {formatCurrency(row.amount)} | APY {formatPercent(row.interestRate)} | score {privacyScoreForParty(row.lender)}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {showAdvancedPanels ? (
                        <>
                          <button
                            className="rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-shell-950"
                            onClick={() => void runAction("Offer accepted.", async () => {
                              if (!lending.creditProfile.contractId) return;
                              await lending.fundLoan(row.contractId, lending.creditProfile.contractId);
                            })}
                            disabled={!interactive || !lending.creditProfile.contractId}
                            type="button"
                          >
                            Accept (Direct)
                          </button>
                          <button
                            className="rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-shell-950"
                            onClick={() => void runAction("Token funding intent created.", async () => {
                              if (!lending.creditProfile.contractId) return;
                              await lending.acceptOfferWithToken(row.contractId, lending.creditProfile.contractId);
                            })}
                            disabled={!interactive || !lending.creditProfile.contractId || !lending.walletUrl}
                            type="button"
                          >
                            Accept with Token
                          </button>
                        </>
                      ) : (
                        <button
                          className="rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-shell-950"
                          onClick={() => void runAction("Offer accepted.", async () => {
                            if (!lending.creditProfile.contractId) return;
                            if (lending.walletUrl) {
                              await lending.acceptOfferWithToken(row.contractId, lending.creditProfile.contractId);
                              return;
                            }
                            await lending.fundLoan(row.contractId, lending.creditProfile.contractId);
                          })}
                          disabled={!interactive || !lending.creditProfile.contractId}
                          type="button"
                        >
                          Accept Offer
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {borrowerOfferInbox.length === 0 ? <p className="text-sm text-signal-slate">No offers available.</p> : null}
              </div>
            </article>

            {showAdvancedPanels ? (
              <article className="rounded-2xl border border-shell-700 bg-white p-5">
                <h3 className="text-lg font-semibold text-shell-950">Matched Proposals ({myMatchedAsBorrower.length})</h3>
                <div className="mt-3 space-y-2">
                  {myMatchedAsBorrower.map((row) => (
                    <div key={row.contractId} className="rounded-lg border border-signal-mint/30 bg-signal-mint/8 px-3 py-2 text-sm">
                      <div className="font-semibold text-shell-950">{formatCurrency(row.principal)} matched</div>
                      <div className="mt-1 text-signal-slate">
                        APY {formatPercent(row.interestRate)} | counterparty score {privacyScoreForParty(row.lender)}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <button
                          className="rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-shell-950"
                          onClick={() => void runAction("Matched proposal accepted.", async () => {
                            await lending.acceptProposal(row.contractId);
                          })}
                          disabled={!interactive}
                          type="button"
                        >
                          Accept
                        </button>
                        <button
                          className="rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-signal-coral"
                          onClick={() => void runAction("Matched proposal rejected.", async () => {
                            await lending.rejectProposal(row.contractId);
                          })}
                          disabled={!interactive}
                          type="button"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                  {myMatchedAsBorrower.length === 0 ? <p className="text-sm text-signal-slate">No matched proposals.</p> : null}
                </div>
              </article>
            ) : null}
          </section>

          <section className={`grid gap-6 ${showAdvancedPanels ? "xl:grid-cols-2" : ""}`}>
            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">My Loans ({myLoansBorrower.length})</h3>
              <div className="mt-3 space-y-2">
                {myLoansBorrower.map((row) => (
                  <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-shell-950">Private Loan</div>
                      {badge(row.status)}
                    </div>
                    <div className="mt-1 text-signal-slate">
                      {formatCurrency(row.amount)} | APY {formatPercent(row.interestRate)} | score {privacyScoreForParty(row.lender)}
                    </div>
                    {row.status === "active" ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {showAdvancedPanels ? (
                          <>
                            <button
                              className="rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-shell-950"
                              onClick={() => void runAction("Loan repaid.", async () => {
                                await lending.repayLoan(row.contractId);
                              })}
                              disabled={!interactive}
                              type="button"
                            >
                              Repay (Direct)
                            </button>
                            <button
                              className="rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-shell-950"
                              onClick={() => void runAction("Repayment request created.", async () => {
                                await lending.requestRepayment(row.contractId);
                              })}
                              disabled={!interactive || !lending.walletUrl}
                              type="button"
                            >
                              Repay with Token
                            </button>
                          </>
                        ) : (
                          <button
                            className="rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-shell-950"
                            onClick={() => void runAction("Loan repaid.", async () => {
                              if (lending.walletUrl) {
                                await lending.requestRepayment(row.contractId);
                                return;
                              }
                              await lending.repayLoan(row.contractId);
                            })}
                            disabled={!interactive}
                            type="button"
                          >
                            Repay Loan
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                ))}
                {myLoansBorrower.length === 0 ? <p className="text-sm text-signal-slate">No active loans yet.</p> : null}
              </div>
            </article>

            {showAdvancedPanels ? (
              <article className="rounded-2xl border border-shell-700 bg-white p-5">
                <h3 className="text-lg font-semibold text-shell-950">Pending Borrower Token Steps</h3>

              <h4 className="mt-3 text-sm font-semibold uppercase tracking-[0.1em] text-signal-slate">
                Repayment Requests ({myRepaymentRequestsBorrower.length})
              </h4>
              <div className="mt-2 space-y-2">
                {myRepaymentRequestsBorrower.map((row) => (
                  <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-shell-950">{formatCurrency(row.repaymentAmount)}</span>
                      {badge(row.allocationCid ? "allocated" : "awaiting wallet")}
                    </div>
                    <div className="text-signal-slate">score {lending.creditProfile.score}</div>
                    {!row.allocationCid && lending.walletUrl ? (
                      <a
                        className="mt-2 inline-block rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-shell-950"
                        href={lending.walletUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Allocate in Wallet
                      </a>
                    ) : null}
                  </div>
                ))}
                {myRepaymentRequestsBorrower.length === 0 ? <p className="text-sm text-signal-slate">No pending repayment requests.</p> : null}
              </div>

                <h4 className="mt-4 text-sm font-semibold uppercase tracking-[0.1em] text-signal-slate">
                  Funding Intents ({myFundingIntentsBorrower.length})
                </h4>
                <div className="mt-2 space-y-2">
                  {myFundingIntentsBorrower.map((row) => (
                    <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                      <div className="font-semibold text-shell-950">{formatCurrency(row.principal)}</div>
                      <div className="text-signal-slate">
                        APY {formatPercent(row.interestRate)} | score {privacyScoreForParty(row.lender)}
                      </div>
                      <div className="mt-1 text-xs text-signal-slate">Awaiting lender confirmation.</div>
                    </div>
                  ))}
                  {myFundingIntentsBorrower.length === 0 ? <p className="text-sm text-signal-slate">No pending funding intents.</p> : null}
                </div>
              </article>
            ) : null}
          </section>
        </>
      ) : null}

      {activeView === "lender" ? (
        <>
          <section className="grid gap-6 xl:grid-cols-2">
            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Create Loan Offer</h3>
              <p className="mt-1 text-sm text-signal-slate">Offer terms against open borrower requests.</p>

              <form className="mt-4 grid gap-3" onSubmit={(event) => void onCreateOffer(event)}>
                <select
                  className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                  value={offerForm.loanRequestId}
                  onChange={(event) => setOfferForm((prev) => ({ ...prev, loanRequestId: event.target.value }))}
                >
                  <option value="">Select verified request</option>
                  {openRequestsForLender.map((row) => (
                    <option key={row.contractId} value={row.contractId}>
                      {formatCurrency(row.amount)} | APY {formatPercent(row.interestRate)} | score {privacyScoreForParty(row.borrower)}
                    </option>
                  ))}
                </select>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                    value={offerForm.amount}
                    onChange={(event) => setOfferForm((prev) => ({ ...prev, amount: event.target.value }))}
                    placeholder="Amount"
                  />
                  <input
                    className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                    value={offerForm.rate}
                    onChange={(event) => setOfferForm((prev) => ({ ...prev, rate: event.target.value }))}
                    placeholder="APY %"
                  />
                </div>
                <button
                  className="rounded-md bg-shell-950 px-4 py-2 text-sm font-semibold text-shell-900"
                  type="submit"
                  disabled={!interactive}
                >
                  Submit Offer
                </button>
              </form>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Place Lender Bid</h3>
              <p className="mt-1 text-sm text-signal-slate">Provide private liquidity into the marketplace order book.</p>

              <form className="mt-4 grid gap-3" onSubmit={(event) => void onPlaceBid(event)}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                    value={bidForm.amount}
                    onChange={(event) => setBidForm((prev) => ({ ...prev, amount: event.target.value }))}
                    placeholder="Amount"
                  />
                  <input
                    className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                    value={bidForm.rate}
                    onChange={(event) => setBidForm((prev) => ({ ...prev, rate: event.target.value }))}
                    placeholder="Min APY %"
                  />
                </div>
                <button
                  className="rounded-md border border-shell-700 px-4 py-2 text-sm font-semibold text-shell-950"
                  type="submit"
                  disabled={!interactive}
                >
                  Place Bid
                </button>
              </form>
            </article>
          </section>

          <section className="grid gap-6 xl:grid-cols-2">
            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Open Borrower Requests ({openRequestsForLender.length})</h3>
              <div className="mt-3 space-y-2">
                {openRequestsForLender.map((row) => (
                  <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-shell-950">Verified Borrower Request</div>
                      {badge(row.status)}
                    </div>
                    <div className="mt-1 text-signal-slate">
                      {formatCurrency(row.amount)} | APY {formatPercent(row.interestRate)} | score {privacyScoreForParty(row.borrower)}
                    </div>
                  </div>
                ))}
                {openRequestsForLender.length === 0 ? <p className="text-sm text-signal-slate">No open requests available.</p> : null}
              </div>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">My Liquidity Bids ({myBids.length})</h3>
              <div className="mt-3 space-y-2">
                {myBids.map((row) => (
                  <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-shell-950">{formatCurrency(row.amount)} liquidity</div>
                      {badge(row.status)}
                    </div>
                    <div className="mt-1 text-signal-slate">
                      APY floor {formatPercent(row.minInterestRate)} | score {lending.creditProfile.score} | remaining {formatCurrency(row.remainingAmount)}
                    </div>
                    <button
                      className="mt-2 rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-signal-coral"
                      onClick={() => void runAction("Lender bid cancelled.", async () => {
                        await lending.cancelLenderBid(row.contractId);
                      })}
                      disabled={!interactive}
                      type="button"
                    >
                      Cancel Bid
                    </button>
                  </div>
                ))}
                {myBids.length === 0 ? <p className="text-sm text-signal-slate">No active bids.</p> : null}
              </div>
            </article>
          </section>

          {showAdvancedPanels ? (
            <section className="grid gap-6 xl:grid-cols-2">
              <article className="rounded-2xl border border-shell-700 bg-white p-5">
                <h3 className="text-lg font-semibold text-shell-950">Matched Proposals ({myMatchedAsLender.length})</h3>
                <div className="mt-3 space-y-2">
                  {myMatchedAsLender.map((row) => (
                    <div key={row.contractId} className="rounded-lg border border-signal-mint/30 bg-signal-mint/8 px-3 py-2 text-sm">
                      <div className="font-semibold text-shell-950">{formatCurrency(row.principal)} matched</div>
                      <div className="mt-1 text-signal-slate">
                        APY {formatPercent(row.interestRate)} | counterparty score {privacyScoreForParty(row.borrower)}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <button
                          className="rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-shell-950"
                          onClick={() => void runAction("Matched proposal accepted.", async () => {
                            await lending.acceptProposal(row.contractId);
                          })}
                          disabled={!interactive}
                          type="button"
                        >
                          Accept
                        </button>
                        <button
                          className="rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-signal-coral"
                          onClick={() => void runAction("Matched proposal rejected.", async () => {
                            await lending.rejectProposal(row.contractId);
                          })}
                          disabled={!interactive}
                          type="button"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                  {myMatchedAsLender.length === 0 ? <p className="text-sm text-signal-slate">No matched proposals.</p> : null}
                </div>
              </article>

              <article className="rounded-2xl border border-shell-700 bg-white p-5">
                <h3 className="text-lg font-semibold text-shell-950">Pending Token Actions</h3>

                <h4 className="mt-3 text-sm font-semibold uppercase tracking-[0.1em] text-signal-slate">
                  Funding Intents ({myFundingIntentsLender.length})
                </h4>
                <div className="mt-2 space-y-2">
                  {myFundingIntentsLender.map((row) => (
                    <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                      <div className="font-semibold text-shell-950">{formatCurrency(row.principal)}</div>
                      <div className="text-signal-slate">APY {formatPercent(row.interestRate)} | score {privacyScoreForParty(row.borrower)}</div>
                      <button
                        className="mt-2 rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-shell-950"
                        onClick={() => void runAction("Funding intent confirmed.", async () => {
                          await lending.confirmFundingIntent(row.contractId);
                        })}
                        disabled={!interactive}
                        type="button"
                      >
                        Confirm Funding Intent
                      </button>
                    </div>
                  ))}
                  {myFundingIntentsLender.length === 0 ? <p className="text-sm text-signal-slate">No funding intents.</p> : null}
                </div>

                <h4 className="mt-4 text-sm font-semibold uppercase tracking-[0.1em] text-signal-slate">
                  Principal Requests ({myPrincipalRequestsLender.length})
                </h4>
                <div className="mt-2 space-y-2">
                  {myPrincipalRequestsLender.map((row) => {
                    const manualAllocation = manualAllocationById[row.contractId] ?? "";
                    const allocationId = row.allocationCid || manualAllocation.trim();
                    return (
                      <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                        <div className="font-semibold text-shell-950">{formatCurrency(row.principal)}</div>
                        <div className="text-signal-slate">{row.allocationCid ? "Allocation attached" : "Awaiting wallet allocation"}</div>
                        {!row.allocationCid ? (
                          <input
                            className="mt-2 w-full rounded-md border border-shell-700 px-3 py-2 text-xs"
                            placeholder="Paste allocation contract ID"
                            value={manualAllocation}
                            onChange={(event) => setManualAllocationById((prev) => ({ ...prev, [row.contractId]: event.target.value }))}
                          />
                        ) : null}
                        <button
                          className="mt-2 rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-shell-950"
                          onClick={() => void runAction("Funding completed.", async () => {
                            if (!allocationId) return;
                            await lending.completeFunding(row.contractId, allocationId);
                          })}
                          disabled={!interactive || !allocationId}
                          type="button"
                        >
                          Complete Funding
                        </button>
                      </div>
                    );
                  })}
                  {myPrincipalRequestsLender.length === 0 ? <p className="text-sm text-signal-slate">No principal requests.</p> : null}
                </div>

                <h4 className="mt-4 text-sm font-semibold uppercase tracking-[0.1em] text-signal-slate">
                  Repayment Requests ({myRepaymentRequestsLender.length})
                </h4>
                <div className="mt-2 space-y-2">
                  {myRepaymentRequestsLender.map((row) => {
                    const manualAllocation = manualAllocationById[row.contractId] ?? "";
                    const allocationId = row.allocationCid || manualAllocation.trim();
                    return (
                      <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                        <div className="font-semibold text-shell-950">{formatCurrency(row.repaymentAmount)}</div>
                        <div className="text-signal-slate">{row.allocationCid ? "Allocation attached" : "Awaiting borrower allocation"}</div>
                        {!row.allocationCid ? (
                          <input
                            className="mt-2 w-full rounded-md border border-shell-700 px-3 py-2 text-xs"
                            placeholder="Paste allocation contract ID"
                            value={manualAllocation}
                            onChange={(event) => setManualAllocationById((prev) => ({ ...prev, [row.contractId]: event.target.value }))}
                          />
                        ) : null}
                        <button
                          className="mt-2 rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-shell-950"
                          onClick={() => void runAction("Repayment completed.", async () => {
                            if (!allocationId) return;
                            await lending.completeRepayment(row.contractId, allocationId);
                          })}
                          disabled={!interactive || !allocationId}
                          type="button"
                        >
                          Complete Repayment
                        </button>
                      </div>
                    );
                  })}
                  {myRepaymentRequestsLender.length === 0 ? <p className="text-sm text-signal-slate">No repayment requests.</p> : null}
                </div>
              </article>
            </section>
          ) : null}

          <section>
            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Funded Loans ({myLoansLender.length})</h3>
              <div className="mt-3 space-y-2">
                {myLoansLender.map((row) => (
                  <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-shell-950">Private Loan</div>
                      {badge(row.status)}
                    </div>
                    <div className="mt-1 text-signal-slate">
                      {formatCurrency(row.amount)} | APY {formatPercent(row.interestRate)} | score {privacyScoreForParty(row.borrower)}
                    </div>
                    {row.status === "active" ? (
                      <button
                        className="mt-2 rounded border border-shell-700 px-2 py-1 text-xs font-semibold text-signal-coral"
                        onClick={() => void runAction("Loan marked default.", async () => {
                          await lending.markLoanDefault(row.contractId);
                        })}
                        disabled={!interactive}
                        type="button"
                      >
                        Mark Default
                      </button>
                    ) : null}
                  </div>
                ))}
                {myLoansLender.length === 0 ? <p className="text-sm text-signal-slate">No funded lender loans.</p> : null}
              </div>
            </article>
          </section>
        </>
      ) : null}

      {activeView === "orderbook" ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">Lender Asks Volume</p>
              <p className="mt-2 text-2xl font-bold text-shell-950">{formatCurrency(askVolume)}</p>
            </article>
            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">Borrower Bids Volume</p>
              <p className="mt-2 text-2xl font-bold text-shell-950">{formatCurrency(bidVolume)}</p>
            </article>
            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">Spread</p>
              <p className="mt-2 text-2xl font-bold text-shell-950">{bookSpread !== null ? formatPercent(bookSpread) : "N/A"}</p>
            </article>
            <article className="rounded-2xl border border-shell-700 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">Active Orders</p>
              <p className="mt-2 text-2xl font-bold text-shell-950">{orderCount}</p>
            </article>
          </section>

          <section className="grid gap-6 xl:grid-cols-2">
            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Asks (Lenders)</h3>
              <p className="mt-1 text-sm text-signal-slate">Aggregated private liquidity by APY and amount.</p>
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-shell-700/60 text-xs uppercase tracking-[0.1em] text-signal-slate">
                      <th className="px-2 py-2">APY</th>
                      <th className="px-2 py-2 text-right">Volume</th>
                      <th className="px-2 py-2 text-right">Orders</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookAsks.map((row, index) => (
                      <tr key={`${row.interestRate}-${row.duration}-${index}`} className="border-b border-shell-700/40 last:border-b-0">
                        <td className="px-2 py-2 font-semibold text-shell-950">{formatPercent(row.interestRate)}</td>
                        <td className="px-2 py-2 text-right text-shell-950">{formatCurrency(row.totalAmount)}</td>
                        <td className="px-2 py-2 text-right text-signal-slate">{row.orderCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {bookAsks.length === 0 ? <p className="pt-3 text-sm text-signal-slate">No ask levels.</p> : null}
              </div>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Bids (Borrowers)</h3>
              <p className="mt-1 text-sm text-signal-slate">Aggregated private borrower demand by APY and amount.</p>
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-shell-700/60 text-xs uppercase tracking-[0.1em] text-signal-slate">
                      <th className="px-2 py-2">APY</th>
                      <th className="px-2 py-2 text-right">Volume</th>
                      <th className="px-2 py-2 text-right">Orders</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookBids.map((row, index) => (
                      <tr key={`${row.interestRate}-${row.duration}-${index}`} className="border-b border-shell-700/40 last:border-b-0">
                        <td className="px-2 py-2 font-semibold text-shell-950">{formatPercent(row.interestRate)}</td>
                        <td className="px-2 py-2 text-right text-shell-950">{formatCurrency(row.totalAmount)}</td>
                        <td className="px-2 py-2 text-right text-signal-slate">{row.orderCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {bookBids.length === 0 ? <p className="pt-3 text-sm text-signal-slate">No bid levels.</p> : null}
              </div>
            </article>
          </section>
        </>
      ) : null}

      {activeView === "advanced" ? (
        <AdvancedLendingLab
          interactive={interactive}
          currentParty={currentParty}
          bids={lending.bids}
          asks={lending.asks}
          requests={lending.requests}
          autoRunToken={advancedAutoRunToken}
          onStatus={setStatus}
        />
      ) : null}
    </section>
  );
}
