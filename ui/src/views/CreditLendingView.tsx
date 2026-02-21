import { FormEvent, useEffect, useMemo, useState } from "react";
import { useCreditLendingData } from "../hooks/useCreditLendingData";
import type { ApiOrderBookTier, BorrowerAsk, LenderBid } from "../types/creditLending";

type LendingSubview = "borrower" | "lender" | "orderbook";

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(value: string): string {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
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

export function CreditLendingView() {
  const lending = useCreditLendingData();

  const [activeView, setActiveView] = useState<LendingSubview>("borrower");
  const [status, setStatus] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  const [walletDraft, setWalletDraft] = useState("");

  const [requestForm, setRequestForm] = useState({ amount: "5000", rate: "8.5", duration: "12", purpose: "Working Capital" });
  const [askForm, setAskForm] = useState({ amount: "5000", rate: "8.5", duration: "12" });
  const [offerForm, setOfferForm] = useState({ loanRequestId: "", amount: "5000", rate: "8.0", duration: "12" });
  const [bidForm, setBidForm] = useState({ amount: "10000", rate: "6.5", duration: "18" });
  const [manualAllocationById, setManualAllocationById] = useState<Record<string, string>>({});

  const interactive = lending.authStatus === "authenticated" && !demoMode;
  const currentParty = lending.currentUser?.party ?? "demo-user";

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

  async function runAction(label: string, action: () => Promise<void>) {
    setStatus(null);
    try {
      await action();
      setStatus(label);
    } catch {
      // Hook already surfaces error state.
    }
  }

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
    const duration = parsePositiveNumber(requestForm.duration);

    if (!amount || !interestRate || !duration || !requestForm.purpose.trim()) {
      setStatus("Enter a valid amount, interest rate, duration, and purpose.");
      return;
    }

    await runAction("Loan request submitted.", async () => {
      await lending.createLoanRequest({
        amount,
        interestRate,
        duration,
        purpose: requestForm.purpose.trim(),
      });
    });
  }

  async function onPlaceAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!interactive) return;

    const amount = parsePositiveNumber(askForm.amount);
    const maxInterestRate = parsePositiveNumber(askForm.rate);
    const duration = parsePositiveNumber(askForm.duration);
    const creditProfileId = lending.creditProfile.contractId;

    if (!amount || !maxInterestRate || !duration || !creditProfileId) {
      setStatus("Place ask failed. Ensure values are valid and a credit profile exists.");
      return;
    }

    await runAction("Order-book ask placed.", async () => {
      await lending.createBorrowerAsk({
        amount,
        maxInterestRate,
        duration,
        creditProfileId,
      });
    });
  }

  async function onCreateOffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!interactive) return;

    const amount = parsePositiveNumber(offerForm.amount);
    const interestRate = parsePositiveNumber(offerForm.rate);
    const duration = parsePositiveNumber(offerForm.duration);

    if (!offerForm.loanRequestId || !amount || !interestRate || !duration) {
      setStatus("Select a request and enter valid offer values.");
      return;
    }

    await runAction("Loan offer created.", async () => {
      await lending.createLoanOffer({
        loanRequestId: offerForm.loanRequestId,
        amount,
        interestRate,
        duration,
      });
    });
  }

  async function onPlaceBid(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!interactive) return;

    const amount = parsePositiveNumber(bidForm.amount);
    const minInterestRate = parsePositiveNumber(bidForm.rate);
    const maxDuration = parsePositiveNumber(bidForm.duration);

    if (!amount || !minInterestRate || !maxDuration) {
      setStatus("Enter valid bid values.");
      return;
    }

    await runAction("Lender bid placed.", async () => {
      await lending.createLenderBid({ amount, minInterestRate, maxDuration });
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

  if ((lending.authStatus === "unauthenticated" || lending.authStatus === "no-backend") && !demoMode) {
    return (
      <section className="mt-6 animate-fade-rise rounded-2xl border border-shell-700 bg-white/92 p-6 shadow-soft">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">Credit Lending</p>
        <h2 className="mt-2 text-2xl font-bold text-shell-950">Sign In</h2>
        <p className="mt-1 text-sm text-signal-slate">
          {lending.authStatus === "no-backend"
            ? "Backend not reachable. Start the lending backend or continue in read-only demo mode."
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

            {lending.authStatus === "no-backend" ? (
              <button
                className="rounded-md border border-shell-700 px-4 py-2 text-sm font-semibold text-shell-950"
                type="button"
                onClick={() => setDemoMode(true)}
              >
                Continue Read-Only
              </button>
            ) : null}
          </div>
        </form>
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
              Full lending lifecycle: requests, offers, bids/asks, matched proposals, token funding, and repayment.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
              onClick={() => void lending.refresh()}
              disabled={lending.loading || !interactive}
              type="button"
            >
              Refresh
            </button>
            {interactive ? (
              <button
                className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                onClick={() => void lending.logout()}
                type="button"
              >
                Sign Out
              </button>
            ) : (
              <button
                className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                onClick={() => setDemoMode(false)}
                type="button"
              >
                Exit Demo
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 px-3 py-2 text-sm">
            <span className="font-semibold text-shell-950">User:</span>{" "}
            <span className="text-signal-slate">{lending.currentUser?.name ?? "demo-user"}</span>
          </div>
          <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 px-3 py-2 text-sm">
            <span className="font-semibold text-shell-950">Party:</span>{" "}
            <span className="text-signal-slate break-all">{currentParty}</span>
          </div>
          <div className="rounded-lg border border-shell-700/70 bg-shell-900/40 px-3 py-2 text-sm">
            <span className="font-semibold text-shell-950">Mode:</span>{" "}
            <span className="text-signal-slate">{interactive ? "Live" : "Read-Only Demo"}</span>
          </div>
        </div>

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

        <div className="mt-4 flex flex-wrap gap-2">
          {["borrower", "lender", "orderbook"].map((entry) => (
            <button
              key={entry}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${activeView === entry
                ? "border border-signal-mint/40 bg-shell-950 text-shell-900 shadow-soft"
                : "border border-shell-700/70 bg-white/75 text-signal-slate hover:border-signal-mint/40 hover:text-shell-950"
              }`}
              onClick={() => setActiveView(entry as LendingSubview)}
              type="button"
            >
              {entry === "borrower" ? "Borrower" : entry === "lender" ? "Lender" : "Order Book"}
            </button>
          ))}
        </div>

        {status ? <p className="mt-4 rounded-lg bg-signal-mint/15 px-3 py-2 text-sm text-shell-950">{status}</p> : null}
        {lending.error ? <p className="mt-4 rounded-lg bg-signal-coral/15 px-3 py-2 text-sm text-signal-coral">{lending.error}</p> : null}
        {lending.loading ? <p className="mt-4 text-sm text-signal-slate">Refreshing lending data...</p> : null}
      </article>

      {activeView === "borrower" ? (
        <>
          <section className="grid gap-6 xl:grid-cols-2">
            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Create Loan Request</h3>
              <p className="mt-1 text-sm text-signal-slate">Publish a request and optionally seed an order-book ask.</p>

              <form className="mt-4 grid gap-3" onSubmit={(event) => void onCreateRequest(event)}>
                <input
                  className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                  value={requestForm.purpose}
                  onChange={(event) => setRequestForm((prev) => ({ ...prev, purpose: event.target.value }))}
                  placeholder="Purpose"
                />
                <div className="grid gap-3 sm:grid-cols-3">
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
                    placeholder="Rate %"
                  />
                  <input
                    className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                    value={requestForm.duration}
                    onChange={(event) => setRequestForm((prev) => ({ ...prev, duration: event.target.value }))}
                    placeholder="Months"
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
              <p className="mt-1 text-sm text-signal-slate">Expose demand directly to lender liquidity bids.</p>

              <form className="mt-4 grid gap-3" onSubmit={(event) => void onPlaceAsk(event)}>
                <div className="grid gap-3 sm:grid-cols-3">
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
                    placeholder="Max Rate %"
                  />
                  <input
                    className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                    value={askForm.duration}
                    onChange={(event) => setAskForm((prev) => ({ ...prev, duration: event.target.value }))}
                    placeholder="Months"
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

          <section className="grid gap-6 xl:grid-cols-2">
            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">My Loan Requests ({myRequests.length})</h3>
              <div className="mt-3 space-y-2">
                {myRequests.map((row) => (
                  <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-shell-950">{row.purpose}</div>
                      {badge(row.status)}
                    </div>
                    <div className="mt-1 text-signal-slate">
                      {formatCurrency(row.amount)} | {formatPercent(row.interestRate)} | {row.duration} mo | {row.offersCount} offers
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
                <p className="text-sm text-signal-slate">Updated {formatDate(lending.creditProfile.lastUpdated)}</p>
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
                    <div className="text-signal-slate">Max {formatPercent(row.maxInterestRate)} | {row.duration} mo</div>
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

          <section className="grid gap-6 xl:grid-cols-2">
            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Pending Offers ({lending.offers.length})</h3>
              <div className="mt-3 space-y-2">
                {lending.offers.map((row) => (
                  <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-shell-950">From {row.lender}</div>
                      {badge(row.status)}
                    </div>
                    <div className="mt-1 text-signal-slate">
                      {formatCurrency(row.amount)} | {formatPercent(row.interestRate)} | {row.duration} mo
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
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
                    </div>
                  </div>
                ))}
                {lending.offers.length === 0 ? <p className="text-sm text-signal-slate">No offers available.</p> : null}
              </div>
            </article>

            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Matched Proposals ({myMatchedAsBorrower.length})</h3>
              <div className="mt-3 space-y-2">
                {myMatchedAsBorrower.map((row) => (
                  <div key={row.contractId} className="rounded-lg border border-signal-mint/30 bg-signal-mint/8 px-3 py-2 text-sm">
                    <div className="font-semibold text-shell-950">{formatCurrency(row.principal)} matched</div>
                    <div className="mt-1 text-signal-slate">
                      {formatPercent(row.interestRate)} | {Math.round(row.durationDays / 30)} mo | matched {formatDate(row.matchedAt)}
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
          </section>

          <section className="grid gap-6 xl:grid-cols-2">
            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">My Loans ({myLoansBorrower.length})</h3>
              <div className="mt-3 space-y-2">
                {myLoansBorrower.map((row) => (
                  <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-shell-950">{row.purpose || "Loan"}</div>
                      {badge(row.status)}
                    </div>
                    <div className="mt-1 text-signal-slate">
                      {formatCurrency(row.amount)} | {formatPercent(row.interestRate)} | due {formatDate(row.dueDate)}
                    </div>
                    {row.status === "active" ? (
                      <div className="mt-2 flex flex-wrap gap-2">
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
                      </div>
                    ) : null}
                  </div>
                ))}
                {myLoansBorrower.length === 0 ? <p className="text-sm text-signal-slate">No active loans yet.</p> : null}
              </div>
            </article>

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
                    <div className="text-signal-slate">Requested {formatDate(row.requestedAt)}</div>
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
                      {formatPercent(row.interestRate)} | {row.durationDays} days | requested {formatDate(row.requestedAt)}
                    </div>
                    <div className="mt-1 text-xs text-signal-slate">Awaiting lender confirmation.</div>
                  </div>
                ))}
                {myFundingIntentsBorrower.length === 0 ? <p className="text-sm text-signal-slate">No pending funding intents.</p> : null}
              </div>
            </article>
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
                  <option value="">Select request</option>
                  {openRequestsForLender.map((row) => (
                    <option key={row.contractId} value={row.contractId}>
                      {row.purpose} | {formatCurrency(row.amount)} | {row.borrower}
                    </option>
                  ))}
                </select>
                <div className="grid gap-3 sm:grid-cols-3">
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
                    placeholder="Rate %"
                  />
                  <input
                    className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                    value={offerForm.duration}
                    onChange={(event) => setOfferForm((prev) => ({ ...prev, duration: event.target.value }))}
                    placeholder="Months"
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
              <p className="mt-1 text-sm text-signal-slate">Provide liquidity into the marketplace order book.</p>

              <form className="mt-4 grid gap-3" onSubmit={(event) => void onPlaceBid(event)}>
                <div className="grid gap-3 sm:grid-cols-3">
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
                    placeholder="Min Rate %"
                  />
                  <input
                    className="w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                    value={bidForm.duration}
                    onChange={(event) => setBidForm((prev) => ({ ...prev, duration: event.target.value }))}
                    placeholder="Max Months"
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
                      <div className="font-semibold text-shell-950">{row.purpose}</div>
                      {badge(row.status)}
                    </div>
                    <div className="mt-1 text-signal-slate">
                      {formatCurrency(row.amount)} | target {formatPercent(row.interestRate)} | {row.duration} mo | {row.borrower}
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
                      Min {formatPercent(row.minInterestRate)} | Max {row.maxDuration} mo | Remaining {formatCurrency(row.remainingAmount)}
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

          <section className="grid gap-6 xl:grid-cols-2">
            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Matched Proposals ({myMatchedAsLender.length})</h3>
              <div className="mt-3 space-y-2">
                {myMatchedAsLender.map((row) => (
                  <div key={row.contractId} className="rounded-lg border border-signal-mint/30 bg-signal-mint/8 px-3 py-2 text-sm">
                    <div className="font-semibold text-shell-950">{formatCurrency(row.principal)} matched</div>
                    <div className="mt-1 text-signal-slate">
                      {formatPercent(row.interestRate)} | {Math.round(row.durationDays / 30)} mo | matched {formatDate(row.matchedAt)}
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
                    <div className="text-signal-slate">{formatPercent(row.interestRate)} | {row.durationDays} days</div>
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

          <section>
            <article className="rounded-2xl border border-shell-700 bg-white p-5">
              <h3 className="text-lg font-semibold text-shell-950">Funded Loans ({myLoansLender.length})</h3>
              <div className="mt-3 space-y-2">
                {myLoansLender.map((row) => (
                  <div key={row.contractId} className="rounded-lg border border-shell-700/70 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-shell-950">{row.purpose || "Loan"}</div>
                      {badge(row.status)}
                    </div>
                    <div className="mt-1 text-signal-slate">
                      {formatCurrency(row.amount)} | {formatPercent(row.interestRate)} | due {formatDate(row.dueDate)}
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
              <p className="mt-1 text-sm text-signal-slate">Aggregated by rate and duration.</p>
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-shell-700/60 text-xs uppercase tracking-[0.1em] text-signal-slate">
                      <th className="px-2 py-2">Rate</th>
                      <th className="px-2 py-2">Duration (days)</th>
                      <th className="px-2 py-2 text-right">Volume</th>
                      <th className="px-2 py-2 text-right">Orders</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookAsks.map((row, index) => (
                      <tr key={`${row.interestRate}-${row.duration}-${index}`} className="border-b border-shell-700/40 last:border-b-0">
                        <td className="px-2 py-2 font-semibold text-shell-950">{formatPercent(row.interestRate)}</td>
                        <td className="px-2 py-2 text-signal-slate">{row.duration}</td>
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
              <p className="mt-1 text-sm text-signal-slate">Aggregated demand levels.</p>
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-shell-700/60 text-xs uppercase tracking-[0.1em] text-signal-slate">
                      <th className="px-2 py-2">Rate</th>
                      <th className="px-2 py-2">Duration (days)</th>
                      <th className="px-2 py-2 text-right">Volume</th>
                      <th className="px-2 py-2 text-right">Orders</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookBids.map((row, index) => (
                      <tr key={`${row.interestRate}-${row.duration}-${index}`} className="border-b border-shell-700/40 last:border-b-0">
                        <td className="px-2 py-2 font-semibold text-shell-950">{formatPercent(row.interestRate)}</td>
                        <td className="px-2 py-2 text-signal-slate">{row.duration}</td>
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
    </section>
  );
}
