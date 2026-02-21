import { useCallback, useEffect, useMemo, useState } from "react";
import { usePartyContext } from "../context/PartyContext";
import {
  TEMPLATE_IDS,
  createContract,
  exerciseChoice,
  optionalToNumber,
  queryCreditProfiles,
  queryLoanOffers,
  queryLoanRepaymentEvents,
  queryLoanRequestForLenders,
  queryLoanRequests,
  queryLoans,
} from "../lib/ledgerClient";
import type {
  ContractRecord,
  CreditProfilePayload,
  LoanOfferPayload,
  LoanPayload,
  LoanRepaymentEventPayload,
  LoanRequestForLenderPayload,
  LoanRequestPayload,
} from "../types/contracts";

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

function shortId(value: string): string {
  if (!value) return "-";
  return value.length <= 16 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function parsePositiveDecimal(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return trimmed;
}

export function LendingHubView() {
  const { availableParties } = usePartyContext();

  const issuer = useMemo(() => resolveAlias(availableParties, "Company"), [availableParties]);
  const borrower = useMemo(() => resolveAlias(availableParties, "Buyer"), [availableParties]);
  const lender = useMemo(() => resolveAlias(availableParties, "Seller"), [availableParties]);
  const outsider = useMemo(() => resolveAlias(availableParties, "Outsider"), [availableParties]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [issuerRequests, setIssuerRequests] = useState<Array<ContractRecord<LoanRequestPayload>>>([]);
  const [borrowerRequests, setBorrowerRequests] = useState<Array<ContractRecord<LoanRequestPayload>>>([]);
  const [outsiderRequests, setOutsiderRequests] = useState<Array<ContractRecord<LoanRequestPayload>>>([]);

  const [lenderVisibleRequests, setLenderVisibleRequests] = useState<Array<ContractRecord<LoanRequestForLenderPayload>>>([]);
  const [borrowerVisibleRequests, setBorrowerVisibleRequests] = useState<Array<ContractRecord<LoanRequestForLenderPayload>>>([]);

  const [issuerOffers, setIssuerOffers] = useState<Array<ContractRecord<LoanOfferPayload>>>([]);
  const [borrowerOffers, setBorrowerOffers] = useState<Array<ContractRecord<LoanOfferPayload>>>([]);
  const [lenderOffers, setLenderOffers] = useState<Array<ContractRecord<LoanOfferPayload>>>([]);

  const [issuerLoans, setIssuerLoans] = useState<Array<ContractRecord<LoanPayload>>>([]);
  const [borrowerLoans, setBorrowerLoans] = useState<Array<ContractRecord<LoanPayload>>>([]);
  const [lenderLoans, setLenderLoans] = useState<Array<ContractRecord<LoanPayload>>>([]);
  const [outsiderLoans, setOutsiderLoans] = useState<Array<ContractRecord<LoanPayload>>>([]);

  const [creditProfiles, setCreditProfiles] = useState<Array<ContractRecord<CreditProfilePayload>>>([]);
  const [repaymentEvents, setRepaymentEvents] = useState<Array<ContractRecord<LoanRepaymentEventPayload>>>([]);

  const [requestedAmount, setRequestedAmount] = useState("50000");
  const [maxRateBps, setMaxRateBps] = useState("950");
  const [durationDays, setDurationDays] = useState("30");
  const [purpose, setPurpose] = useState("Working capital");

  const [selectedRequestCid, setSelectedRequestCid] = useState("");

  const [selectedDisclosureCid, setSelectedDisclosureCid] = useState("");
  const [offeredAmount, setOfferedAmount] = useState("45000");
  const [offeredRateBps, setOfferedRateBps] = useState("825");
  const [offerNote, setOfferNote] = useState("Term loan with weekly repayment schedule.");

  const [selectedOfferCid, setSelectedOfferCid] = useState("");
  const [selectedLoanCid, setSelectedLoanCid] = useState("");
  const [repaymentAmount, setRepaymentAmount] = useState("10000");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [
        issReq,
        borReq,
        outReq,
        lendViewReq,
        borViewReq,
        issOff,
        borOff,
        lendOff,
        issLoan,
        borLoan,
        lendLoan,
        outLoan,
        profiles,
        repayments,
      ] = await Promise.all([
        queryLoanRequests(issuer),
        queryLoanRequests(borrower),
        queryLoanRequests(outsider),
        queryLoanRequestForLenders(lender),
        queryLoanRequestForLenders(borrower),
        queryLoanOffers(issuer),
        queryLoanOffers(borrower),
        queryLoanOffers(lender),
        queryLoans(issuer),
        queryLoans(borrower),
        queryLoans(lender),
        queryLoans(outsider),
        queryCreditProfiles(borrower),
        queryLoanRepaymentEvents(borrower),
      ]);

      setIssuerRequests(issReq);
      setBorrowerRequests(borReq);
      setOutsiderRequests(outReq);
      setLenderVisibleRequests(lendViewReq);
      setBorrowerVisibleRequests(borViewReq);
      setIssuerOffers(issOff);
      setBorrowerOffers(borOff);
      setLenderOffers(lendOff);
      setIssuerLoans(issLoan);
      setBorrowerLoans(borLoan);
      setLenderLoans(lendLoan);
      setOutsiderLoans(outLoan);
      setCreditProfiles(profiles);
      setRepaymentEvents(repayments);

      if (!selectedRequestCid && issReq[0]) setSelectedRequestCid(issReq[0].contractId);
      if (!selectedDisclosureCid && lendViewReq[0]) setSelectedDisclosureCid(lendViewReq[0].contractId);
      if (!selectedOfferCid && borOff[0]) setSelectedOfferCid(borOff[0].contractId);
      if (!selectedLoanCid && borLoan[0]) setSelectedLoanCid(borLoan[0].contractId);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [borrower, issuer, lender, outsider, selectedDisclosureCid, selectedLoanCid, selectedOfferCid, selectedRequestCid]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = useCallback(async (successMessage: string, action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await action();
      setStatus(successMessage);
      await refresh();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const createLoanRequest = useCallback(async () => {
    await runAction("Loan request created by borrower.", async () => {
      const amount = parsePositiveDecimal(requestedAmount);
      const rate = parsePositiveDecimal(maxRateBps);
      const duration = Number.parseInt(durationDays, 10);
      if (!amount || !rate) throw new Error("Requested amount and max rate must be positive.");
      if (!Number.isInteger(duration) || duration <= 0) throw new Error("Duration days must be a positive integer.");
      if (!purpose.trim()) throw new Error("Purpose is required.");

      await createContract(borrower, TEMPLATE_IDS.loanRequest, {
        issuer,
        borrower,
        requestedAmount: amount,
        maxRateBps: rate,
        durationDays: duration,
        purpose: purpose.trim(),
        createdAt: new Date().toISOString(),
        active: true,
      });
    });
  }, [borrower, durationDays, issuer, maxRateBps, purpose, requestedAmount, runAction]);

  const shareRequestToLender = useCallback(async () => {
    await runAction("Issuer disclosed request to lender.", async () => {
      if (!selectedRequestCid) throw new Error("Select a request first.");
      await exerciseChoice(
        issuer,
        TEMPLATE_IDS.loanRequest,
        selectedRequestCid,
        "ShareWithLender",
        { lender },
      );
    });
  }, [issuer, lender, runAction, selectedRequestCid]);

  const submitOffer = useCallback(async () => {
    await runAction("Lender submitted loan offer.", async () => {
      if (!selectedDisclosureCid) throw new Error("Select a disclosed request first.");
      const amount = parsePositiveDecimal(offeredAmount);
      const rate = parsePositiveDecimal(offeredRateBps);
      if (!amount || !rate) throw new Error("Offered amount and rate must be positive.");

      await exerciseChoice(
        lender,
        TEMPLATE_IDS.loanRequestForLender,
        selectedDisclosureCid,
        "SubmitOffer",
        {
          offeredAmount: amount,
          offeredRateBps: rate,
          note: offerNote.trim(),
        },
      );
    });
  }, [lender, offerNote, offeredAmount, offeredRateBps, runAction, selectedDisclosureCid]);

  const acceptOffer = useCallback(async () => {
    await runAction("Borrower accepted and funded offer.", async () => {
      if (!selectedOfferCid) throw new Error("Select an offer first.");
      await exerciseChoice(
        borrower,
        TEMPLATE_IDS.loanOffer,
        selectedOfferCid,
        "AcceptAndFund",
        {},
      );
    });
  }, [borrower, runAction, selectedOfferCid]);

  const repayLoan = useCallback(async () => {
    await runAction("Repayment posted to loan.", async () => {
      if (!selectedLoanCid) throw new Error("Select a loan first.");
      const payment = parsePositiveDecimal(repaymentAmount);
      if (!payment) throw new Error("Repayment amount must be positive.");
      await exerciseChoice(
        borrower,
        TEMPLATE_IDS.loan,
        selectedLoanCid,
        "Repay",
        { payment },
      );
    });
  }, [borrower, repaymentAmount, runAction, selectedLoanCid]);

  const latestProfile = useMemo(() => {
    if (!creditProfiles.length) return null;
    const sorted = [...creditProfiles].sort(
      (left, right) =>
        new Date(right.payload.updatedAt).getTime() - new Date(left.payload.updatedAt).getTime(),
    );
    return sorted[0] ?? null;
  }, [creditProfiles]);
  const currentScore = latestProfile ? optionalToNumber(latestProfile.payload.score) : null;

  return (
    <section className="mt-6 animate-fade-rise space-y-6">
      <article className="rounded-2xl border border-shell-700 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-signal-slate">Lending Hub</p>
            <h2 className="mt-1 text-3xl font-semibold text-shell-950">Private Credit On Canton</h2>
            <p className="mt-2 text-sm text-signal-slate">
              End-to-end flow: borrower request, issuer disclosure, lender offer, borrower funding, repayment, and credit updates.
            </p>
            <p className="mt-2 text-xs text-signal-slate">
              Roles: issuer=<span className="font-semibold text-shell-950">{aliasOf(issuer)}</span> · borrower=<span className="font-semibold text-shell-950">{aliasOf(borrower)}</span> · lender=<span className="font-semibold text-shell-950">{aliasOf(lender)}</span>
            </p>
          </div>
          <button
            className="rounded-xl border border-shell-700 bg-white px-4 py-2 text-sm font-semibold text-shell-950"
            onClick={() => void refresh()}
            disabled={busy || loading}
          >
            Refresh
          </button>
        </div>

        {status ? <p className="mt-4 rounded-lg bg-signal-mint/15 px-3 py-2 text-sm text-shell-950">{status}</p> : null}
        {error ? <p className="mt-4 rounded-lg bg-signal-coral/15 px-3 py-2 text-sm text-signal-coral">{error}</p> : null}
        {loading ? <p className="mt-4 text-sm text-signal-slate">Loading lending contracts...</p> : null}
      </article>

      <div className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Step 1 · Borrower Request</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
              Requested Amount
              <input
                className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={requestedAmount}
                onChange={(event) => setRequestedAmount(event.target.value)}
              />
            </label>
            <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
              Max Rate (bps)
              <input
                className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={maxRateBps}
                onChange={(event) => setMaxRateBps(event.target.value)}
              />
            </label>
            <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate sm:col-span-2">
              Duration (days)
              <input
                className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={durationDays}
                onChange={(event) => setDurationDays(event.target.value)}
              />
            </label>
          </div>
          <label className="mt-3 block text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Purpose
            <input
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
            />
          </label>
          <button
            className="mt-3 rounded-xl bg-shell-950 px-4 py-2 text-sm font-semibold text-shell-900 disabled:opacity-55"
            onClick={() => void createLoanRequest()}
            disabled={busy}
          >
            Create Loan Request
          </button>
        </article>

        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Step 2 · Issuer Disclosure</p>
          <label className="mt-3 block text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Request Contract
            <select
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={selectedRequestCid}
              onChange={(event) => setSelectedRequestCid(event.target.value)}
            >
              <option value="">Select request</option>
              {issuerRequests.filter((row) => row.payload.active).map((row) => (
                <option key={row.contractId} value={row.contractId}>
                  {shortId(row.contractId)} · amount {optionalToNumber(row.payload.requestedAmount)} · {row.payload.durationDays}d
                </option>
              ))}
            </select>
          </label>
          <button
            className="mt-3 rounded-xl border border-shell-700 bg-white px-4 py-2 text-sm font-semibold text-shell-950 disabled:opacity-55"
            onClick={() => void shareRequestToLender()}
            disabled={busy || !selectedRequestCid}
          >
            Disclose To Lender
          </button>
        </article>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Step 3 · Lender Offer</p>
          <label className="mt-3 block text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Disclosed Request
            <select
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={selectedDisclosureCid}
              onChange={(event) => setSelectedDisclosureCid(event.target.value)}
            >
              <option value="">Select disclosure</option>
              {lenderVisibleRequests.map((row) => (
                <option key={row.contractId} value={row.contractId}>
                  {shortId(row.contractId)} · {row.payload.purpose} · {row.payload.durationDays}d
                </option>
              ))}
            </select>
          </label>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
              Offered Amount
              <input
                className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={offeredAmount}
                onChange={(event) => setOfferedAmount(event.target.value)}
              />
            </label>
            <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
              Offered Rate (bps)
              <input
                className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
                value={offeredRateBps}
                onChange={(event) => setOfferedRateBps(event.target.value)}
              />
            </label>
          </div>
          <label className="mt-3 block text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Note
            <input
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={offerNote}
              onChange={(event) => setOfferNote(event.target.value)}
            />
          </label>
          <button
            className="mt-3 rounded-xl border border-shell-700 bg-white px-4 py-2 text-sm font-semibold text-shell-950 disabled:opacity-55"
            onClick={() => void submitOffer()}
            disabled={busy || !selectedDisclosureCid}
          >
            Submit Offer
          </button>
        </article>

        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Step 4 · Funding + Repayment</p>
          <label className="mt-3 block text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Offer Contract
            <select
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={selectedOfferCid}
              onChange={(event) => setSelectedOfferCid(event.target.value)}
            >
              <option value="">Select offer</option>
              {borrowerOffers.filter((row) => row.payload.status === "OPEN").map((row) => (
                <option key={row.contractId} value={row.contractId}>
                  {shortId(row.contractId)} · {optionalToNumber(row.payload.offeredAmount)} @ {optionalToNumber(row.payload.offeredRateBps)}bps · {row.payload.durationDays}d
                </option>
              ))}
            </select>
          </label>
          <button
            className="mt-3 rounded-xl border border-shell-700 bg-white px-4 py-2 text-sm font-semibold text-shell-950 disabled:opacity-55"
            onClick={() => void acceptOffer()}
            disabled={busy || !selectedOfferCid}
          >
            Accept + Fund
          </button>

          <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Loan Contract
            <select
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={selectedLoanCid}
              onChange={(event) => setSelectedLoanCid(event.target.value)}
            >
              <option value="">Select loan</option>
              {borrowerLoans.filter((row) => row.payload.status === "ACTIVE").map((row) => (
                <option key={row.contractId} value={row.contractId}>
                  {shortId(row.contractId)} · balance {optionalToNumber(row.payload.balance)} · {row.payload.durationDays}d
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 block text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Repayment Amount
            <input
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={repaymentAmount}
              onChange={(event) => setRepaymentAmount(event.target.value)}
            />
          </label>
          <button
            className="mt-3 rounded-xl border border-shell-700 bg-white px-4 py-2 text-sm font-semibold text-shell-950 disabled:opacity-55"
            onClick={() => void repayLoan()}
            disabled={busy || !selectedLoanCid}
          >
            Repay Loan
          </button>
        </article>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Privacy Snapshot</p>
          <div className="mt-3 space-y-2 text-sm">
            <div className="rounded-lg border border-shell-700/70 bg-shell-900/55 px-3 py-2 text-shell-950">
              Borrower sees requests: <span className="font-semibold">{borrowerRequests.length}</span>
            </div>
            <div className="rounded-lg border border-shell-700/70 bg-shell-900/55 px-3 py-2 text-shell-950">
              Lender sees disclosed reqs: <span className="font-semibold">{lenderVisibleRequests.length}</span>
            </div>
            <div className="rounded-lg border border-shell-700/70 bg-shell-900/55 px-3 py-2 text-shell-950">
              Outsider sees requests: <span className="font-semibold">{outsiderRequests.length}</span>
            </div>
            <div className="rounded-lg border border-shell-700/70 bg-shell-900/55 px-3 py-2 text-shell-950">
              Outsider sees loans: <span className="font-semibold">{outsiderLoans.length}</span>
            </div>
          </div>
        </article>

        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Loan Book</p>
          <p className="mt-2 text-sm text-signal-slate">Issuer-visible loans: {issuerLoans.length}</p>
          <div className="mt-3 space-y-2">
            {issuerLoans.slice(0, 6).map((loan) => (
              <div key={loan.contractId} className="rounded-lg border border-shell-700/70 bg-shell-900/55 px-3 py-2 text-sm">
                <p className="font-semibold text-shell-950">{shortId(loan.contractId)}</p>
                <p className="text-signal-slate">
                  principal {optionalToNumber(loan.payload.principal)} · balance {optionalToNumber(loan.payload.balance)} · status {loan.payload.status}
                </p>
              </div>
            ))}
            {issuerLoans.length === 0 ? <p className="text-sm text-signal-slate">No loans yet.</p> : null}
          </div>
        </article>

        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Credit + Repayment</p>
          <p className="mt-2 text-sm text-signal-slate">
            Current borrower score: <span className="font-semibold text-shell-950">{currentScore ?? "-"}</span>
          </p>
          <p className="mt-1 text-sm text-signal-slate">Repayment events: {repaymentEvents.length}</p>
          <div className="mt-3 space-y-2">
            {repaymentEvents.slice(0, 5).map((event) => (
              <div key={event.contractId} className="rounded-lg border border-shell-700/70 bg-shell-900/55 px-3 py-2 text-sm">
                <p className="font-semibold text-shell-950">Paid {optionalToNumber(event.payload.payment)}</p>
                <p className="text-signal-slate">Remaining {optionalToNumber(event.payload.remainingBalance)}</p>
              </div>
            ))}
            {repaymentEvents.length === 0 ? <p className="text-sm text-signal-slate">No repayments yet.</p> : null}
          </div>
        </article>
      </div>

      <article className="rounded-2xl border border-shell-700 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Offer Visibility Check</p>
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <div className="rounded-lg border border-shell-700/70 bg-shell-900/55 p-3">
            <p className="text-xs uppercase tracking-[0.1em] text-signal-slate">Issuer Offers</p>
            <p className="mt-1 text-2xl font-semibold text-shell-950">{issuerOffers.length}</p>
          </div>
          <div className="rounded-lg border border-shell-700/70 bg-shell-900/55 p-3">
            <p className="text-xs uppercase tracking-[0.1em] text-signal-slate">Borrower Offers</p>
            <p className="mt-1 text-2xl font-semibold text-shell-950">{borrowerOffers.length}</p>
          </div>
          <div className="rounded-lg border border-shell-700/70 bg-shell-900/55 p-3">
            <p className="text-xs uppercase tracking-[0.1em] text-signal-slate">Lender Offers</p>
            <p className="mt-1 text-2xl font-semibold text-shell-950">{lenderOffers.length}</p>
          </div>
        </div>
      </article>
    </section>
  );
}
