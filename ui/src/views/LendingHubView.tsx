import { useMemo } from "react";
import { useCreditLendingData } from "../hooks/useCreditLendingData";

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

export function LendingHubView() {
  const lending = useCreditLendingData();

  const activeLoans = useMemo(
    () => lending.loans.filter((row) => row.status === "active"),
    [lending.loans],
  );

  const outstanding = useMemo(
    () => activeLoans.reduce((sum, row) => sum + row.amount, 0),
    [activeLoans],
  );

  const avgRate = useMemo(() => {
    if (!activeLoans.length) return 0;
    return activeLoans.reduce((sum, row) => sum + row.interestRate, 0) / activeLoans.length;
  }, [activeLoans]);

  return (
    <section className="mt-6 animate-fade-rise space-y-6">
      <article className="rounded-2xl border border-shell-700 bg-white p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Canton Lending Lens</p>
        <h2 className="mt-1 text-3xl font-semibold text-shell-950">Privacy-Scoped Credit Snapshot</h2>
        <p className="mt-2 text-sm text-signal-slate">
          Summary view for bilateral lending state on Canton-style privacy boundaries.
        </p>
      </article>

      <section className="grid gap-6 lg:grid-cols-3">
        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">Active Loans</p>
          <p className="mt-2 text-3xl font-semibold text-shell-950">{activeLoans.length}</p>
        </article>
        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">Outstanding Principal</p>
          <p className="mt-2 text-3xl font-semibold text-shell-950">{formatCurrency(outstanding)}</p>
        </article>
        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">Average Rate</p>
          <p className="mt-2 text-3xl font-semibold text-shell-950">{formatPercent(avgRate)}</p>
        </article>
      </section>

      <article className="rounded-2xl border border-shell-700 bg-white p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-semibold text-shell-950">Recent Loan Book</h3>
          <button
            className="rounded-md border border-shell-700 px-3 py-2 text-sm font-semibold text-shell-950"
            onClick={() => void lending.refresh()}
            disabled={lending.loading || lending.authStatus !== "authenticated"}
            type="button"
          >
            Refresh
          </button>
        </div>
        {lending.error ? (
          <p className="mt-3 rounded-md bg-signal-coral/15 px-3 py-2 text-sm text-signal-coral">{lending.error}</p>
        ) : null}
        <div className="mt-3 space-y-2">
          {lending.loans.slice(0, 8).map((row) => (
            <div key={row.contractId} className="rounded-lg border border-shell-700/70 bg-shell-900/45 px-3 py-2 text-sm">
              <p className="font-semibold text-shell-950">{row.purpose || "Loan"}</p>
              <p className="text-signal-slate">
                {formatCurrency(row.amount)} • {formatPercent(row.interestRate)} • due {formatDate(row.dueDate)} • {row.status}
              </p>
            </div>
          ))}
          {lending.loans.length === 0 ? <p className="text-sm text-signal-slate">No loans visible for this party.</p> : null}
        </div>
      </article>
    </section>
  );
}
