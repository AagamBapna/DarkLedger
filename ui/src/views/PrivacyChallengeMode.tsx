import { useEffect, useMemo, useState } from "react";
import { TEMPLATE_IDS, queryContractsByTemplate } from "../lib/ledgerClient";

type RoleView = "Seller" | "Buyer" | "Outsider" | "Inspector";
type ChallengeTemplateKey = "tradeIntent" | "privateNegotiation";
type ResolutionKind = "exact" | "prefix" | "ellipsis" | "fallback";
type FallbackSource = "suggested" | "active";

interface ChallengeFieldOption {
  key: string;
  label: string;
  detail: string;
  visibleTo: RoleView[];
  read: (payload: Record<string, unknown>) => unknown;
}

interface ChallengeRowResult {
  role: RoleView;
  party: string;
  queryOk: boolean;
  totalRows: number;
  matchedCount: number;
  visible: boolean;
  value: string;
  error: string;
  expectedVisible: boolean;
}

interface PrivacyChallengeProof {
  timestamp: string;
  templateKey: ChallengeTemplateKey;
  templateId: string;
  fieldKey: string;
  fieldLabel: string;
  fieldDetail: string;
  targetContractId: string;
  probeRole: RoleView;
  resolvedFrom: ResolutionKind;
  results: ChallengeRowResult[];
  proofHash: string;
}

interface RoleSnapshot {
  role: RoleView;
  party: string;
  queryOk: boolean;
  rows: Array<{ contractId: string; payload: Record<string, unknown> }>;
  error: string;
}

interface PrivacyChallengeModeProps {
  partyByRole: Record<RoleView, string>;
  suggestedIntentCid: string;
  suggestedNegotiationCid: string;
}

const ROLE_ORDER: RoleView[] = ["Seller", "Buyer", "Outsider", "Inspector"];

const TEMPLATE_OPTIONS: Array<{ key: ChallengeTemplateKey; label: string }> = [
  { key: "tradeIntent", label: "TradeIntent" },
  { key: "privateNegotiation", label: "PrivateNegotiation" },
];

const CHALLENGE_FIELDS: Record<ChallengeTemplateKey, ChallengeFieldOption[]> = {
  tradeIntent: [
    {
      key: "instrument",
      label: "Instrument",
      detail: "Instrument identifier from seller intent.",
      visibleTo: ["Seller", "Buyer", "Inspector"],
      read: (payload) => payload.instrument,
    },
    {
      key: "quantity",
      label: "Quantity",
      detail: "Quantity requested by the seller intent.",
      visibleTo: ["Seller", "Buyer", "Inspector"],
      read: (payload) => payload.quantity,
    },
    {
      key: "minPrice",
      label: "Min Price",
      detail: "Seller floor price on TradeIntent.",
      visibleTo: ["Seller", "Buyer", "Inspector"],
      read: (payload) => payload.minPrice,
    },
    {
      key: "seller",
      label: "Seller Identity",
      detail: "Seller party identity in TradeIntent.",
      visibleTo: ["Seller", "Buyer", "Inspector"],
      read: (payload) => payload.seller,
    },
  ],
  privateNegotiation: [
    {
      key: "proposedQty",
      label: "Proposed Quantity",
      detail: "Current negotiated quantity value.",
      visibleTo: ["Seller", "Buyer", "Inspector"],
      read: (payload) => payload.proposedQty,
    },
    {
      key: "proposedUnitPrice",
      label: "Proposed Unit Price",
      detail: "Current negotiated unit price value.",
      visibleTo: ["Seller", "Buyer", "Inspector"],
      read: (payload) => payload.proposedUnitPrice,
    },
    {
      key: "sellerCommitmentHash",
      label: "Seller Commitment Hash",
      detail: "Seller commit hash used before reveal.",
      visibleTo: ["Seller", "Buyer", "Inspector"],
      read: (payload) => payload.sellerCommitmentHash,
    },
    {
      key: "buyerCommitmentHash",
      label: "Buyer Commitment Hash",
      detail: "Buyer commit hash used before reveal.",
      visibleTo: ["Seller", "Buyer", "Inspector"],
      read: (payload) => payload.buyerCommitmentHash,
    },
    {
      key: "sellerAccepted",
      label: "Seller Accepted",
      detail: "Seller acceptance flag in negotiation state.",
      visibleTo: ["Seller", "Buyer", "Inspector"],
      read: (payload) => payload.sellerAccepted,
    },
    {
      key: "buyerAccepted",
      label: "Buyer Accepted",
      detail: "Buyer acceptance flag in negotiation state.",
      visibleTo: ["Seller", "Buyer", "Inspector"],
      read: (payload) => payload.buyerAccepted,
    },
  ],
};

function aliasOf(value: string): string {
  return value.includes("::") ? value.split("::")[0] : value;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const maybeOptional = value as { tag?: string; value?: unknown };
    if (maybeOptional.tag === "None") return "None";
    if (maybeOptional.tag === "Some") return maybeOptional.value === undefined ? "Some" : String(maybeOptional.value);
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

function buildFilename(proof: PrivacyChallengeProof): string {
  const cidPrefix = proof.targetContractId ? proof.targetContractId.slice(0, 12) : "unknown";
  const stamp = proof.timestamp.replace(/[:.]/g, "-");
  return `privacy-proof-${proof.templateKey}-${proof.fieldKey}-${cidPrefix}-${stamp}.json`;
}

function normalizeCid(value: string): string {
  return value.trim().toLowerCase();
}

function matchesEllipsis(input: string, candidate: string): boolean {
  const [prefix, suffix] = input.split("...");
  if (!prefix || !suffix) return false;
  return candidate.startsWith(prefix) && candidate.endsWith(suffix);
}

function cidMatchesInput(input: string, candidate: string): boolean {
  const normalizedInput = normalizeCid(input);
  const normalizedCandidate = normalizeCid(candidate);
  if (!normalizedInput) return false;
  if (normalizedInput.includes("...")) return matchesEllipsis(normalizedInput, normalizedCandidate);
  return normalizedCandidate === normalizedInput || normalizedCandidate.startsWith(normalizedInput);
}

function roleWeight(role: RoleView): number {
  switch (role) {
    case "Seller":
      return 4;
    case "Buyer":
      return 3;
    case "Inspector":
      return 2;
    case "Outsider":
      return 1;
    default:
      return 0;
  }
}

function pickBestActiveCid(
  snapshots: RoleSnapshot[],
  preferredCid: string,
  allowedCids?: string[],
): { cid: string; source: FallbackSource } | null {
  const universe = allowedCids?.length
    ? Array.from(new Set(allowedCids))
    : Array.from(new Set(snapshots.flatMap((snapshot) => snapshot.rows.map((row) => row.contractId))));
  if (!universe.length) return null;

  const normalizedPreferred = normalizeCid(preferredCid);
  if (normalizedPreferred) {
    const preferredMatch = universe.find((cid) => normalizeCid(cid) === normalizedPreferred);
    if (preferredMatch) return { cid: preferredMatch, source: "suggested" };
  }

  const scoreByCid = new Map<string, number>();
  for (const snapshot of snapshots) {
    const seen = new Set(snapshot.rows.map((row) => row.contractId));
    for (const cid of seen) {
      if (!universe.includes(cid)) continue;
      scoreByCid.set(cid, (scoreByCid.get(cid) ?? 0) + roleWeight(snapshot.role));
    }
  }

  const ranked = [...universe].sort((left, right) => {
    const scoreDelta = (scoreByCid.get(right) ?? 0) - (scoreByCid.get(left) ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    return right.localeCompare(left);
  });
  return ranked[0] ? { cid: ranked[0], source: "active" } : null;
}

export function PrivacyChallengeMode({
  partyByRole,
  suggestedIntentCid,
  suggestedNegotiationCid,
}: PrivacyChallengeModeProps) {
  const [templateKey, setTemplateKey] = useState<ChallengeTemplateKey>("privateNegotiation");
  const [fieldKey, setFieldKey] = useState<string>(CHALLENGE_FIELDS.privateNegotiation[0]?.key ?? "");
  const [probeRole, setProbeRole] = useState<RoleView>("Outsider");
  const [contractId, setContractId] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [proof, setProof] = useState<PrivacyChallengeProof | null>(null);

  const fieldOptions = useMemo(() => CHALLENGE_FIELDS[templateKey], [templateKey]);
  const suggestedCid = templateKey === "tradeIntent" ? suggestedIntentCid : suggestedNegotiationCid;

  useEffect(() => {
    if (!fieldOptions.some((field) => field.key === fieldKey)) {
      setFieldKey(fieldOptions[0]?.key ?? "");
    }
  }, [fieldKey, fieldOptions]);

  useEffect(() => {
    if (!contractId && suggestedCid) {
      setContractId(suggestedCid);
    }
  }, [contractId, suggestedCid]);

  const selectedField = useMemo(
    () => fieldOptions.find((field) => field.key === fieldKey) ?? fieldOptions[0],
    [fieldKey, fieldOptions],
  );

  const runChallenge = async () => {
    if (!selectedField) {
      setError("Select a field before running the challenge.");
      return;
    }

    const rawInput = contractId.trim() || suggestedCid.trim();
    if (!rawInput) {
      setError("Enter or auto-fill a contract ID before running.");
      return;
    }

    setRunning(true);
    setError(null);
    setStatus(null);
    try {
      const templateId = TEMPLATE_IDS[templateKey];
      const snapshots = await Promise.all(
        ROLE_ORDER.map(async (role): Promise<RoleSnapshot> => {
          const party = partyByRole[role];
          try {
            const rows = await queryContractsByTemplate<Record<string, unknown>>(party, templateId);
            return {
              role,
              party: aliasOf(party),
              queryOk: true,
              rows,
              error: "",
            };
          } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason);
            return {
              role,
              party: aliasOf(party),
              queryOk: false,
              rows: [],
              error: message,
            };
          }
        }),
      );

      const activeCids = Array.from(
        new Set(
          snapshots
            .flatMap((snapshot) => snapshot.rows)
            .map((row) => row.contractId),
        ),
      );
      const candidateCids = activeCids.filter((cid) => cidMatchesInput(rawInput, cid));

      let resolvedCid = "";
      let resolvedFrom: ResolutionKind = "exact";
      let statusMessage = "";

      if (candidateCids.length === 1) {
        resolvedCid = candidateCids[0];
        const normalizedInput = normalizeCid(rawInput);
        const normalizedResolved = normalizeCid(resolvedCid);
        resolvedFrom = normalizedInput.includes("...")
          ? "ellipsis"
          : normalizedInput === normalizedResolved
            ? "exact"
            : "prefix";
        statusMessage =
          resolvedFrom === "exact"
            ? "Challenge completed using exact CID."
            : `Challenge completed using ${resolvedFrom} CID match.`;
      } else if (templateKey === "privateNegotiation") {
        const fallback = pickBestActiveCid(
          snapshots,
          suggestedCid,
          candidateCids.length > 1 ? candidateCids : activeCids,
        );
        if (!fallback) {
          setProof(null);
          setError(
            "Contract ID not found in active contracts. It may be stale/consumed. Click Use Suggested CID or paste the latest full CID.",
          );
          return;
        }
        resolvedCid = fallback.cid;
        resolvedFrom = "fallback";
        statusMessage = "Challenge completed.";
      } else if (candidateCids.length === 0) {
        setProof(null);
        setError("Contract ID not found in active contracts. It may be stale/consumed. Click Use Suggested CID or paste the latest full CID.");
        return;
      } else {
        setProof(null);
        setError(`CID input matched ${candidateCids.length} contracts. Paste a longer/full CID to disambiguate.`);
        return;
      }


      const results: ChallengeRowResult[] = snapshots.map((snapshot) => {
        const matchedRows = snapshot.rows.filter((row) => row.contractId === resolvedCid);
        const payload = matchedRows[0]?.payload ?? null;
        const visible = matchedRows.length > 0;
        const value = snapshot.queryOk
          ? visible
            ? formatValue(selectedField.read(payload))
            : "REDACTED"
          : "ERROR";
        return {
          role: snapshot.role,
          party: snapshot.party,
          queryOk: snapshot.queryOk,
          totalRows: snapshot.rows.length,
          matchedCount: matchedRows.length,
          visible,
          value,
          error: snapshot.error,
          expectedVisible: selectedField.visibleTo.includes(snapshot.role),
        };
      });

      const timestamp = new Date().toISOString();
      const baseProof = {
        timestamp,
        templateKey,
        templateId,
        fieldKey: selectedField.key,
        fieldLabel: selectedField.label,
        fieldDetail: selectedField.detail,
        targetContractId: resolvedCid,
        probeRole,
        resolvedFrom,
        results,
      };
      const proofHash = await sha256Hex(JSON.stringify(baseProof));
      setProof({ ...baseProof, proofHash });
      setContractId(resolvedCid);
      setStatus(statusMessage);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
    } finally {
      setRunning(false);
    }
  };

  const downloadProof = () => {
    if (!proof) return;
    const blob = new Blob([JSON.stringify(proof, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = buildFilename(proof);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const copyResolvedCid = async () => {
    if (!proof) return;
    try {
      await navigator.clipboard.writeText(proof.targetContractId);
      setStatus("Copied resolved CID.");
    } catch {
      setError("Unable to copy CID. Clipboard permission may be blocked.");
    }
  };

  const visibleRoles = proof ? proof.results.filter((row) => row.visible).map((row) => row.role) : [];
  const hiddenRoles = proof ? proof.results.filter((row) => !row.visible).map((row) => row.role) : [];

  return (
    <section className="mt-6 rounded-2xl border border-shell-700 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Privacy Challenge Mode</p>
          <h2 className="mt-1 text-xl font-semibold text-shell-950">Adversarial Visibility Proof</h2>
          <p className="mt-1 text-sm text-signal-slate">
            Pick a contract, field, and probe party. One click runs live queries for all roles and generates downloadable proof.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-md border border-shell-700 px-3 py-2 text-sm font-semibold text-shell-950"
            onClick={() => setContractId(suggestedCid)}
            disabled={!suggestedCid}
          >
            Use Suggested CID
          </button>
          <button
            className="rounded-md bg-shell-950 px-4 py-2 text-sm font-semibold text-shell-900 disabled:opacity-60"
            onClick={() => void runChallenge()}
            disabled={running}
          >
            {running ? "Running..." : "Run Challenge"}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <label className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
          Template
          <select
            className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
            value={templateKey}
            onChange={(event) => setTemplateKey(event.target.value as ChallengeTemplateKey)}
          >
            {TEMPLATE_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
          Field
          <select
            className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
            value={selectedField?.key ?? ""}
            onChange={(event) => setFieldKey(event.target.value)}
          >
            {fieldOptions.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
          Probe Party
          <select
            className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
            value={probeRole}
            onChange={(event) => setProbeRole(event.target.value as RoleView)}
          >
            {ROLE_ORDER.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
          Contract ID
          <input
            className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 font-mono text-sm"
            value={contractId}
            onChange={(event) => setContractId(event.target.value)}
            placeholder={suggestedCid || "00..."}
          />
        </label>
      </div>

      <div className="mt-3 rounded-md border border-shell-700/70 bg-shell-900/30 px-3 py-2 text-xs text-signal-slate">
        Target field: <span className="font-semibold text-shell-950">{selectedField?.label ?? "-"}</span>. {selectedField?.detail}
      </div>

      {status ? (
        <p className="mt-3 rounded-md border border-signal-mint/40 bg-signal-mint/10 px-3 py-2 text-sm text-shell-950">
          {status}
        </p>
      ) : null}

      {error ? (
        <p className="mt-3 rounded-md border border-signal-coral/40 bg-signal-coral/10 px-3 py-2 text-sm text-signal-coral">
          {error}
        </p>
      ) : null}

      {proof ? (
        <div className="mt-4 rounded-lg border border-shell-700/70 bg-shell-900/25 p-3 text-xs text-signal-slate">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p>
                Timestamp: <span className="font-semibold text-shell-950">{new Date(proof.timestamp).toLocaleString()}</span>
              </p>
              <p className="mt-1">
                Probe Role: <span className="font-semibold text-shell-950">{proof.probeRole}</span> | Match Type:{" "}
                <span className="font-semibold text-shell-950">{proof.resolvedFrom}</span>
              </p>
              <p className="mt-2">Resolved CID:</p>
              <code className="mt-1 block break-all font-mono text-shell-950">{proof.targetContractId}</code>
              <p className="mt-2">Proof Hash:</p>
              <code className="mt-1 block break-all font-mono text-shell-950">{proof.proofHash}</code>
              <p className="mt-2">
                Visible roles: <span className="font-semibold text-shell-950">{visibleRoles.join(", ") || "none"}</span> | Hidden roles:{" "}
                <span className="font-semibold text-shell-950">{hiddenRoles.join(", ") || "none"}</span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                onClick={copyResolvedCid}
              >
                Copy CID
              </button>
              <button
                className="rounded-md border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                onClick={downloadProof}
              >
                Download Proof JSON
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-shell-700 text-left text-xs uppercase tracking-[0.14em] text-signal-slate">
              <th className="py-2">Role</th>
              <th className="py-2">Query</th>
              <th className="py-2">Matched</th>
              <th className="py-2">Visible</th>
              <th className="py-2">Field Value</th>
              <th className="py-2">Expected</th>
              <th className="py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {(proof?.results ?? []).map((row) => {
              const verdictOk = row.visible === row.expectedVisible;
              return (
                <tr
                  key={row.role}
                  className={`border-b border-shell-800 ${
                    !verdictOk ? "bg-signal-coral/6" : row.role === probeRole ? "bg-signal-mint/8" : ""
                  }`}
                >
                  <td className="py-3 font-semibold text-shell-950">
                    {row.role}
                    <div className="text-xs font-normal text-signal-slate">{row.party}</div>
                  </td>
                  <td className="py-3">
                    <span className={row.queryOk ? "text-signal-mint" : "text-signal-coral"}>
                      {row.queryOk ? "ok" : "failed"}
                    </span>
                    <div className="text-xs text-signal-slate">total={row.totalRows}</div>
                  </td>
                  <td className="py-3">{row.matchedCount}</td>
                  <td className="py-3">
                    <span className={row.visible ? "text-signal-mint" : "text-signal-coral"}>
                      {row.visible ? "yes" : "no"}
                    </span>
                  </td>
                  <td className="py-3 font-mono text-xs text-shell-950">{row.value}</td>
                  <td className="py-3">
                    <span className={verdictOk ? "text-signal-mint" : "text-signal-coral"}>
                      {row.expectedVisible ? "visible" : "hidden"} {verdictOk ? "(match)" : "(mismatch)"}
                    </span>
                  </td>
                  <td className="py-3 text-xs text-signal-coral">{row.error || "none"}</td>
                </tr>
              );
            })}
            {!proof ? (
              <tr>
                <td className="py-3 text-signal-slate" colSpan={7}>
                  Run challenge to populate live privacy proof rows.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
