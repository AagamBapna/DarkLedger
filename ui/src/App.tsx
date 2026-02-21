import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePartyContext } from "./context/PartyContext";
import { ContractVisibilityInspector } from "./views/ContractVisibilityInspector";
import { DarkAuctionView } from "./views/DarkAuctionView";
import { LandingPage } from "./views/LandingPage";
import { LendingWorkspaceView } from "./views/LendingWorkspaceView";
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

type RoleView = "Landing" | "Lending" | "DarkAuction" | "Seller" | "Buyer" | "Outsider" | "Inspector" | "Challenge";

type SellerChoice = "SubmitSellerTerms" | "CommitTerms" | "RevealTerms" | "AcceptBySeller" | "RejectBySeller";
type BuyerChoice = "SubmitBuyerTerms" | "CommitTerms" | "RevealTerms" | "AcceptByBuyer" | "RejectByBuyer";

function aliasOf(value: string): string { return value.includes("::") ? value.split("::")[0] : value; }
function resolveAlias(availableParties: string[], alias: string): string { const exact = availableParties.find((e) => e === alias); if (exact) return exact; const qualified = availableParties.find((e) => e.startsWith(`${alias}::`)); if (qualified) return qualified; return alias; }

function sideTag(value: string | { tag?: string } | Record<string, unknown>): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) { if ("tag" in value && typeof value.tag === "string") return value.tag; const keys = Object.keys(value); if (keys.length === 1) return keys[0]; }
  return "";
}

async function sha256Hex(value: string): Promise<string> { const data = new TextEncoder().encode(value); const digest = await crypto.subtle.digest("SHA-256", data); return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join(""); }
function shortId(value: string): string { if (!value) return "-"; return value.length <= 16 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`; }
function optionalText(value: string | null | { tag: "Some" | "None"; value?: string }): string { if (value === null || value === undefined) return "not committed"; if (typeof value === "string") return value; if (value.tag === "Some") return value.value ?? "not committed"; return "not committed"; }
function isValidPositiveNumber(value: string): boolean { return parsePositiveDecimal(value) !== null; }
function parsePositiveDecimal(value: string): string | null { const t = value.trim(); if (!/^\d+(\.\d+)?$/.test(t)) return null; const p = Number(t); if (!Number.isFinite(p) || p <= 0) return null; return t; }
function isLockedContractError(message: string): boolean { const l = message.toLowerCase(); return l.includes("local_verdict_locked_contracts") || l.includes("locked contracts"); }
function normalizeLedgerError(message: string): string { if (message.toLowerCase().includes("cannot accept before terms exist")) return "Cannot accept yet. Submit terms first using Negotiate."; return message; }

const NEGOTIATION_FIELD_CHOICES = ["SubmitSellerTerms", "SubmitBuyerTerms", "CommitTerms", "RevealTerms"];
function normalizeInstrument(value: string): string { return value.trim().toLowerCase(); }
function negotiationLaneKey(row: ContractRecord<PrivateNegotiationPayload>): string { return [normalizeInstrument(row.payload.instrument), aliasOf(row.payload.sellerAgent), aliasOf(row.payload.buyerAgent)].join("|"); }
function negotiationScore(p: PrivateNegotiationPayload): number { let s = 0; if (!p.issuerApproved) s += 100; if (!isFullyAccepted(p)) s += 40; if (hasSubmittedTerms(p)) s += 20; if (isAcceptedByEither(p)) s += 8; if (p.sellerTermsRevealed) s += 2; if (p.buyerTermsRevealed) s += 2; return s; }
function isFullyAccepted(p: PrivateNegotiationPayload): boolean { return p.sellerAccepted && p.buyerAccepted; }
function isAcceptedByEither(p: PrivateNegotiationPayload): boolean { return p.sellerAccepted || p.buyerAccepted; }
function isNegotiationClosed(p: PrivateNegotiationPayload): boolean { return isFullyAccepted(p); }
function isNegotiationLive(p: PrivateNegotiationPayload): boolean { return !p.issuerApproved; }
function hasSubmittedTerms(p: PrivateNegotiationPayload): boolean { return optionalToNumber(p.proposedQty) !== null && optionalToNumber(p.proposedUnitPrice) !== null; }

function collapseNegotiationLanes(rows: Array<ContractRecord<PrivateNegotiationPayload>>): Array<ContractRecord<PrivateNegotiationPayload>> {
  const byLane = new Map<string, ContractRecord<PrivateNegotiationPayload>>();
  for (const row of rows) { const key = negotiationLaneKey(row); const existing = byLane.get(key); if (!existing) { byLane.set(key, row); continue; } if (negotiationScore(row.payload) > negotiationScore(existing.payload) || (negotiationScore(row.payload) === negotiationScore(existing.payload) && row.contractId > existing.contractId)) byLane.set(key, row); }
  return Array.from(byLane.values());
}

function pickBestNegotiation(rows: Array<ContractRecord<PrivateNegotiationPayload>>, preferredContractId: string, preferredInstrument?: string | null): ContractRecord<PrivateNegotiationPayload> | null {
  const live = rows.filter((r) => isNegotiationLive(r.payload)); if (!live.length) return null;
  const byCid = live.find((r) => r.contractId === preferredContractId); if (byCid) return byCid;
  const ni = preferredInstrument ? normalizeInstrument(preferredInstrument) : null;
  const cands = ni ? live.filter((r) => normalizeInstrument(r.payload.instrument) === ni) : live; if (!cands.length) return null;
  return [...cands].sort((a, b) => { const d = negotiationScore(b.payload) - negotiationScore(a.payload); return d !== 0 ? d : b.contractId.localeCompare(a.contractId); })[0] ?? null;
}

interface DetectedCompletion { contractId: string; instrument: string; quantity: number | null; unitPrice: number | null; seller: string; buyer: string; detectedAt: string; }
interface OutsiderAcceptedSignal { contractId: string; instrument: string; quantity: number | null; unitPrice: number | null; detectedAt: string; source: "Live Detection" | "Ledger Snapshot"; }

/* ── Navigation ── */
const NAV_ITEMS: Array<{ key: RoleView; label: string; icon: string }> = [
  { key: "Landing", label: "Dashboard", icon: "grid" },
  { key: "Lending", label: "Lending Desk", icon: "coins" },
  { key: "DarkAuction", label: "Dark Auction", icon: "auction" },
  { key: "Seller", label: "Seller Console", icon: "upload" },
  { key: "Buyer", label: "Buyer Portal", icon: "download" },
  { key: "Outsider", label: "Outsider View", icon: "eye" },
  { key: "Inspector", label: "Inspector", icon: "search" },
  { key: "Challenge", label: "Privacy Challenge", icon: "shield" },
];

function NavIcon({ type, className }: { type: string; className?: string }) {
  const cn = className ?? "nav-icon";
  const props = { className: cn, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (type) {
    case "grid": return <svg {...props}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>;
    case "coins": return <svg {...props}><circle cx="8" cy="8" r="3.5" /><circle cx="16" cy="16" r="3.5" /><path d="M11 9.5l2 2M9.5 11l2 2" /></svg>;
    case "auction": return <svg {...props}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>;
    case "upload": return <svg {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>;
    case "download": return <svg {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>;
    case "eye": return <svg {...props}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>;
    case "search": return <svg {...props}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>;
    case "shield": return <svg {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" /></svg>;
    default: return null;
  }
}

export default function App() {
  const { availableParties } = usePartyContext();
  const [view, setView] = useState<RoleView>("Landing");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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

  const sellerNegotiationsForSelection = useMemo(() => collapseNegotiationLanes(sellerNegotiations.filter((r) => isNegotiationLive(r.payload))), [sellerNegotiations]);
  const buyerNegotiationsCollapsed = useMemo(() => collapseNegotiationLanes(buyerNegotiations.filter((r) => isNegotiationLive(r.payload))), [buyerNegotiations]);
  const acceptedForOutsider = useMemo(() => companyNegotiations.filter((r) => isNegotiationClosed(r.payload)), [companyNegotiations]);
  const completedTotalDisplay = acceptedForOutsider.length;

  const outsiderAcceptedSignals = useMemo<OutsiderAcceptedSignal[]>(() => {
    const seen = new Set<string>(); const signals: OutsiderAcceptedSignal[] = [];
    for (const r of detectedCompletions) { if (seen.has(r.contractId)) continue; seen.add(r.contractId); signals.push({ contractId: r.contractId, instrument: r.instrument, quantity: r.quantity, unitPrice: r.unitPrice, detectedAt: r.detectedAt, source: "Live Detection" }); }
    for (const r of acceptedForOutsider) { if (seen.has(r.contractId)) continue; seen.add(r.contractId); signals.push({ contractId: r.contractId, instrument: r.payload.instrument, quantity: optionalToNumber(r.payload.proposedQty), unitPrice: optionalToNumber(r.payload.proposedUnitPrice), detectedAt: r.payload.expiresAt, source: "Ledger Snapshot" }); }
    return signals.sort((a, b) => { const ap = a.source === "Live Detection" ? 0 : 1; const bp = b.source === "Live Detection" ? 0 : 1; if (ap !== bp) return ap - bp; return b.detectedAt.localeCompare(a.detectedAt); }).slice(0, 8);
  }, [acceptedForOutsider, detectedCompletions]);

  const selectedSellerNegotiation = useMemo(() => sellerNegotiationsForSelection.find((r) => r.contractId === sellerNegotiationCid) ?? null, [sellerNegotiationCid, sellerNegotiationsForSelection]);
  const buyerNegotiationsForSelection = useMemo(() => { if (!selectedIntentInstrument) return buyerNegotiationsCollapsed; const n = normalizeInstrument(selectedIntentInstrument); return buyerNegotiationsCollapsed.filter((r) => normalizeInstrument(r.payload.instrument) === n); }, [buyerNegotiationsCollapsed, selectedIntentInstrument]);
  const selectedBuyerNegotiation = useMemo(() => buyerNegotiationsForSelection.find((r) => r.contractId === buyerNegotiationCid) ?? null, [buyerNegotiationCid, buyerNegotiationsForSelection]);

  useEffect(() => { if (!sellerNegotiationCid) return; if (!sellerNegotiationsForSelection.some((r) => r.contractId === sellerNegotiationCid)) setSellerNegotiationCid(""); }, [sellerNegotiationCid, sellerNegotiationsForSelection]);
  useEffect(() => { if (!buyerNegotiationCid) return; if (!buyerNegotiationsForSelection.some((r) => r.contractId === buyerNegotiationCid)) setBuyerNegotiationCid(""); }, [buyerNegotiationCid, buyerNegotiationsForSelection]);

  const refreshLedger = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [intents, sNeg, bNeg, cNeg, oI, oN, oS, oA] = await Promise.all([queryTradeIntents(seller), queryPrivateNegotiations(sellerAgent), queryPrivateNegotiations(buyerAgent), queryPrivateNegotiations(company), queryTradeIntents(outsider), queryPrivateNegotiations(outsider), queryTradeSettlements(outsider), queryAuditRecords(outsider)]);
      setTradeIntents(intents); setSellerNegotiations(sNeg); setBuyerNegotiations(bNeg); setCompanyNegotiations(cNeg); setOutsiderIntents(oI); setOutsiderNegotiations(oN); setOutsiderSettlements(oS); setOutsiderAudits(oA);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); }
  }, [buyerAgent, company, outsider, seller, sellerAgent]);

  useEffect(() => { if (view === "Outsider") { if (outsiderViewPrimedRef.current) return; seenAcceptedCidsRef.current = new Set(acceptedForOutsider.map((r) => r.contractId)); outsiderDetectionInitializedRef.current = true; setDetectedCompletions([]); outsiderViewPrimedRef.current = true; return; } outsiderViewPrimedRef.current = false; }, [acceptedForOutsider, view]);
  useEffect(() => { if (view !== "Outsider" || loading) return; const seen = seenAcceptedCidsRef.current; if (!outsiderDetectionInitializedRef.current) { acceptedForOutsider.forEach((r) => seen.add(r.contractId)); outsiderDetectionInitializedRef.current = true; return; } const nr = acceptedForOutsider.filter((r) => !seen.has(r.contractId)); if (!nr.length) return; const dt = new Date().toISOString(); nr.forEach((r) => seen.add(r.contractId)); setDetectedCompletions((prev) => [...nr.map((r) => ({ contractId: r.contractId, instrument: r.payload.instrument, quantity: optionalToNumber(r.payload.proposedQty), unitPrice: optionalToNumber(r.payload.proposedUnitPrice), seller: r.payload.seller, buyer: r.payload.buyer, detectedAt: dt })), ...prev].slice(0, 20)); }, [acceptedForOutsider, loading, view]);
  useEffect(() => { if (startupResetDone.current) return; startupResetDone.current = true; void (async () => { try { const ex = await queryTradeIntents(seller); await Promise.all(ex.map((i) => exerciseChoice(seller, TEMPLATE_IDS.tradeIntent, i.contractId, "ArchiveIntent", {}))); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { await refreshLedger(); } })(); }, [refreshLedger, seller]);
  useEffect(() => { if (view !== "Outsider") return; const t = window.setInterval(() => { if (!busy) void refreshLedger(); }, 2000); return () => window.clearInterval(t); }, [busy, refreshLedger, view]);

  const runAction = useCallback(async (desc: string, action: () => Promise<void>): Promise<boolean> => { setBusy(true); setStatus(null); setError(null); try { await action(); setStatus(desc); await refreshLedger(); await new Promise((r) => setTimeout(r, 120)); await refreshLedger(); return true; } catch (e) { setError(normalizeLedgerError(e instanceof Error ? e.message : String(e))); return false; } finally { setBusy(false); } }, [refreshLedger]);
  const createTradeIntent = useCallback(async () => { await runAction("Trade intent created.", async () => { await createContract(seller, TEMPLATE_IDS.tradeIntent, { issuer: company, seller, sellerAgent, buyer, instrument, quantity: Number.parseFloat(quantity), minPrice: Number.parseFloat(minPrice) }); }); }, [buyer, company, instrument, minPrice, quantity, runAction, seller, sellerAgent]);

  const negotiationArgument = useCallback(async (choice: SellerChoice | BuyerChoice): Promise<Record<string, unknown>> => {
    const qD = parsePositiveDecimal(negotiationQty); const pD = parsePositiveDecimal(negotiationPrice);
    if (choice === "SubmitSellerTerms" || choice === "SubmitBuyerTerms") { if (!qD || !pD) throw new Error("Enter valid positive decimal qty and unit price."); return { qty: qD, unitPrice: pD }; }
    if (choice === "CommitTerms") { if (!qD || !pD) throw new Error("Enter valid positive decimal qty and unit price."); return { side: { tag: negotiationSide, value: {} }, commitmentHash: await sha256Hex(`${qD}|${pD}|${negotiationSalt}`) }; }
    if (choice === "RevealTerms") { if (!qD || !pD) throw new Error("Enter valid positive decimal qty and unit price."); return { side: { tag: negotiationSide, value: {} }, qtyText: qD, unitPriceText: pD, salt: negotiationSalt }; }
    return {};
  }, [negotiationPrice, negotiationQty, negotiationSalt, negotiationSide]);

  const pickActiveNegotiation = useCallback((rows: Array<ContractRecord<PrivateNegotiationPayload>>, pid: string, pi?: string | null) => pickBestNegotiation(rows, pid, pi), []);
  const waitForNegotiationVisibility = useCallback(async (party: string, inst: string, cid?: string | null) => { const n = normalizeInstrument(inst); const tc = cid ?? ""; for (let a = 0; a < 8; a++) { const rows = await queryPrivateNegotiations(party); const m = pickBestNegotiation(rows, tc, n); if (m) return { rows, match: m }; await new Promise((r) => setTimeout(r, 250)); } return null; }, []);

  const runSellerAction = useCallback(async (choice?: SellerChoice): Promise<boolean> => {
    const c = choice ?? sellerChoice;
    if (NEGOTIATION_FIELD_CHOICES.includes(c) && (!isValidPositiveNumber(negotiationQty) || !isValidPositiveNumber(negotiationPrice))) { setError("Enter valid positive qty and unit price."); return false; }
    return runAction(`Seller ${c} executed.`, async () => { for (let a = 0; a < 6; a++) { const lr = await queryPrivateNegotiations(sellerAgent); setSellerNegotiations(lr); const live = pickActiveNegotiation(lr, sellerNegotiationCid, selectedSellerNegotiation?.payload.instrument ?? null); if (!live) { if (a < 5) { await new Promise((r) => setTimeout(r, 300)); continue; } throw new Error("No seller negotiation available."); } setSellerNegotiationCid(live.contractId); try { const res = await exerciseChoice(sellerAgent, TEMPLATE_IDS.privateNegotiation, live.contractId, c, await negotiationArgument(c)); const nc = typeof res === "string" ? res : ""; if (nc) { const v = await waitForNegotiationVisibility(sellerAgent, live.payload.instrument, nc); const rc = v ? v.match.contractId : nc; setSellerLastGeneratedCid(rc); if (v) { setSellerNegotiations(v.rows); setSellerNegotiationCid(rc); } else setSellerNegotiationCid(rc); } return; } catch (e) { const m = e instanceof Error ? e.message : String(e); if (!isLockedContractError(m) || a === 5) throw e; await new Promise((r) => setTimeout(r, 1100)); } } });
  }, [sellerChoice, negotiationQty, negotiationPrice, negotiationArgument, runAction, sellerAgent, sellerNegotiationCid, selectedSellerNegotiation, pickActiveNegotiation, waitForNegotiationVisibility]);

  const runBuyerAction = useCallback(async (choice?: BuyerChoice): Promise<boolean> => {
    const c = choice ?? buyerChoice;
    if (NEGOTIATION_FIELD_CHOICES.includes(c) && (!isValidPositiveNumber(negotiationQty) || !isValidPositiveNumber(negotiationPrice))) { setError("Enter valid positive qty and unit price."); return false; }
    return runAction(`Buyer ${c} executed.`, async () => { for (let a = 0; a < 6; a++) { const lr = await queryPrivateNegotiations(buyerAgent); setBuyerNegotiations(lr); const live = pickActiveNegotiation(lr, buyerNegotiationCid, selectedBuyerNegotiation?.payload.instrument ?? selectedIntentInstrument); if (!live) { if (a < 5) { await new Promise((r) => setTimeout(r, 300)); continue; } throw new Error("No buyer negotiation available."); } setBuyerNegotiationCid(live.contractId); try { const res = await exerciseChoice(buyerAgent, TEMPLATE_IDS.privateNegotiation, live.contractId, c, await negotiationArgument(c)); const nc = typeof res === "string" ? res : ""; if (nc) { const v = await waitForNegotiationVisibility(buyerAgent, live.payload.instrument, nc); const rc = v ? v.match.contractId : nc; setBuyerLastGeneratedCid(rc); if (v) { setBuyerNegotiations(v.rows); setSelectedIntentInstrument(v.match.payload.instrument); setBuyerNegotiationCid(rc); } else { setSelectedIntentInstrument(live.payload.instrument); setBuyerNegotiationCid(rc); } } return; } catch (e) { const m = e instanceof Error ? e.message : String(e); if (!isLockedContractError(m) || a === 5) throw e; await new Promise((r) => setTimeout(r, 1100)); } } });
  }, [buyerChoice, negotiationQty, negotiationPrice, negotiationArgument, runAction, buyerAgent, buyerNegotiationCid, selectedBuyerNegotiation, selectedIntentInstrument, pickActiveNegotiation, waitForNegotiationVisibility]);

  const runBuyerNegotiate = useCallback(async () => { await runBuyerAction("SubmitBuyerTerms"); }, [runBuyerAction]);
  const runSellerNegotiate = useCallback(async () => { await runSellerAction("SubmitSellerTerms"); }, [runSellerAction]);
  const runSellerAcceptOffer = useCallback(async () => { if (!selectedSellerNegotiation) { setError("No seller negotiation available."); return; } if (!hasSubmittedTerms(selectedSellerNegotiation.payload)) { setError("Submit terms first."); return; } await runSellerAction("AcceptBySeller"); }, [runSellerAction, selectedSellerNegotiation]);
  const runBuyerAcceptOffer = useCallback(async () => { if (!selectedBuyerNegotiation) { setError("No buyer negotiation available."); return; } if (!hasSubmittedTerms(selectedBuyerNegotiation.payload)) { setError("Submit terms first."); return; } await runBuyerAction("AcceptByBuyer"); }, [runBuyerAction, selectedBuyerNegotiation]);

  const runBuyerNegotiateFromIntent = useCallback(async (intent: ContractRecord<TradeIntentPayload>) => {
    const qty = optionalToNumber(intent.payload.quantity); const price = optionalToNumber(intent.payload.minPrice);
    if (qty === null || price === null || qty <= 0 || price <= 0) { setError("Invalid intent."); return; }
    setNegotiationQty(String(qty)); setNegotiationPrice(String(price)); setNegotiationSide("Buy"); setBuyerChoice("SubmitBuyerTerms");
    await runAction(`Setup for ${intent.payload.instrument}.`, async () => {
      const lr = await queryPrivateNegotiations(buyerAgent); setBuyerNegotiations(lr);
      const match = pickBestNegotiation(lr, "", normalizeInstrument(intent.payload.instrument));
      if (!match || !hasSubmittedTerms(match.payload)) {
        const created = await createContract<PrivateNegotiationPayload>(company, TEMPLATE_IDS.privateNegotiation, { issuer: company, seller, sellerAgent, buyer, buyerAgent, instrument: intent.payload.instrument, proposedQty: qty, proposedUnitPrice: price, sellerAccepted: true, buyerAccepted: false, issuerApproved: false, expiresAt: new Date(Date.now() + 86400000).toISOString(), sellerCommitmentHash: null, buyerCommitmentHash: null, sellerTermsRevealed: false, buyerTermsRevealed: false });
        const v = await waitForNegotiationVisibility(buyerAgent, intent.payload.instrument, created.contractId);
        if (v) { setBuyerNegotiations(v.rows); setSelectedIntentInstrument(intent.payload.instrument); setBuyerLastGeneratedCid(v.match.contractId); setBuyerNegotiationCid(v.match.contractId); }
        else { setSelectedIntentInstrument(intent.payload.instrument); setBuyerLastGeneratedCid(created.contractId); setBuyerNegotiationCid(created.contractId); }
      } else {
        const v = await waitForNegotiationVisibility(buyerAgent, intent.payload.instrument, match.contractId);
        if (v) { setBuyerNegotiations(v.rows); setSelectedIntentInstrument(intent.payload.instrument); setBuyerNegotiationCid(v.match.contractId); }
        else { setSelectedIntentInstrument(intent.payload.instrument); setBuyerNegotiationCid(match.contractId); }
      }
    });
  }, [buyer, buyerAgent, company, runAction, seller, sellerAgent, waitForNegotiationVisibility]);

  const selectedTerms = (p: PrivateNegotiationPayload) => { const q = optionalToNumber(p.proposedQty); const pr = optionalToNumber(p.proposedUnitPrice); if (q === null || pr === null) return "No terms yet."; return `Qty ${q} @ ${pr}`; };
  const copyContractId = useCallback(async (cid: string) => { try { await navigator.clipboard.writeText(cid); setStatus(`Copied ${shortId(cid)}.`); setError(null); } catch { setError("Clipboard blocked."); } }, []);
  const suggestedIntentCid = useMemo(() => tradeIntents[0]?.contractId ?? "", [tradeIntents]);
  const suggestedNegotiationCid = useMemo(() => selectedSellerNegotiation?.contractId ?? selectedBuyerNegotiation?.contractId ?? sellerNegotiationsForSelection[0]?.contractId ?? buyerNegotiationsForSelection[0]?.contractId ?? companyNegotiations[0]?.contractId ?? "", [buyerNegotiationsForSelection, companyNegotiations, selectedBuyerNegotiation, selectedSellerNegotiation, sellerNegotiationsForSelection]);
  const sellerCanAccept = selectedSellerNegotiation ? hasSubmittedTerms(selectedSellerNegotiation.payload) && !selectedSellerNegotiation.payload.sellerAccepted : false;
  const buyerCanAccept = selectedBuyerNegotiation ? hasSubmittedTerms(selectedBuyerNegotiation.payload) && !selectedBuyerNegotiation.payload.buyerAccepted : false;

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const ic = "mt-1.5 w-full rounded-xl border border-[#E2E8F0] bg-slate-50 px-4 py-2.5 text-sm text-[#1E293B]";
  const lc = "text-xs font-semibold uppercase tracking-wider text-[#64748B]";

  return (
    <div className="dashboard-layout">
      {/* Sidebar */}
      <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#14B8A6] to-[#0D9488]">
            <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
          </div>
          {!sidebarCollapsed && <h1 className="text-base font-bold text-[#1E293B]" style={{ fontFamily: "Sora" }}>DarkLedger</h1>}
          <button className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-[#64748B] hover:bg-slate-100" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>{sidebarCollapsed ? <polyline points="9 18 15 12 9 6" /> : <polyline points="15 18 9 12 15 6" />}</svg>
          </button>
        </div>
        <nav className="mt-2 flex-1 space-y-0.5">
          {NAV_ITEMS.map((item) => (
            <button key={item.key} className={`sidebar-nav-item ${view === item.key ? "active" : ""}`} onClick={() => setView(item.key)} title={sidebarCollapsed ? item.label : undefined}>
              <NavIcon type={item.icon} /><span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="mx-4 my-3 border-t border-[#E2E8F0]" />
        <div className="space-y-0.5 pb-2">
          <button className="sidebar-nav-item" onClick={() => void refreshLedger()} disabled={busy || loading}>
            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
            <span className="nav-label">{loading ? "Refreshing..." : "Refresh"}</span>
          </button>
        </div>
        {!sidebarCollapsed && (
          <div className="border-t border-[#E2E8F0] px-4 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#14B8A6] to-[#0D9488] text-sm font-bold text-white">{aliasOf(seller).charAt(0).toUpperCase()}</div>
              <div className="min-w-0"><p className="truncate text-sm font-semibold text-[#1E293B]">{aliasOf(seller)}</p><p className="text-xs text-[#64748B]">Network Admin</p></div>
            </div>
          </div>
        )}
      </aside>

      {/* Main */}
      <div className={`dashboard-main ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        <header className="dashboard-header">
          <div><h2 className="text-xl font-bold text-[#1E293B]" style={{ fontFamily: "Sora" }}>Hello! {aliasOf(seller)}</h2><p className="mt-0.5 text-sm text-[#64748B]">Welcome to your private trading dashboard.</p></div>
          <div className="flex items-center gap-4">
            <div className="search-input hidden md:flex"><svg className="h-4 w-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg><input type="text" placeholder="Search..." readOnly /></div>
            <div className="hidden items-center gap-2 text-sm text-[#64748B] lg:flex">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
              <span className="font-medium">{dateStr}</span><span className="text-slate-300">|</span>
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              <span className="font-medium">{timeStr}</span>
            </div>
            <div className="notification-bell"><svg className="h-5 w-5 text-[#64748B]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>{(detectedCompletions.length > 0 || error) && <span className="dot" />}</div>
          </div>
        </header>

        <div className="px-8 pt-2">
          {status && <div className="animate-slide-up mb-3 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><svg className="h-5 w-5 flex-shrink-0 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg><span>{status}</span><button className="ml-auto text-emerald-600" onClick={() => setStatus(null)}><svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button></div>}
          {error && <div className="animate-slide-up mb-3 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><svg className="h-5 w-5 flex-shrink-0 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg><span>{error}</span><button className="ml-auto text-red-600" onClick={() => setError(null)}><svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button></div>}
        </div>

        <div className="dashboard-content">
          {view === "Landing" && <LandingPage onOpenConsole={() => setView("Seller")} onOpenInspector={() => setView("Inspector")} onOpenDarkAuction={() => setView("DarkAuction")} onOpenLending={() => setView("Lending")} stats={{ tradeIntents: tradeIntents.length, sellerNegotiations: sellerNegotiationsForSelection.length, buyerNegotiations: buyerNegotiationsForSelection.length, completedDeals: completedTotalDisplay, settlements: outsiderSettlements.length, auditRecords: outsiderAudits.length }} parties={availableParties.slice(0, 10)} />}
          {view === "Lending" && <div className="animate-fade-rise"><LendingWorkspaceView /></div>}
          {view === "DarkAuction" && <div className="animate-fade-rise"><DarkAuctionView /></div>}

          {view === "Seller" && (
            <section className="stagger-children grid gap-6 lg:grid-cols-2">
              <div className="dash-card"><div className="mb-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-teal-50 to-teal-100"><NavIcon type="upload" className="h-5 w-5 text-[#14B8A6]" /></div><div><h2 className="text-lg font-semibold text-[#1E293B]">Create Trade Intent</h2><p className="text-sm text-[#64748B]">Post intents for the market.</p></div></div>
                <label className={`mt-4 block ${lc}`}>Instrument<input className={ic} value={instrument} onChange={(e) => setInstrument(e.target.value)} /></label>
                <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className={lc}>Quantity<input className={ic} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label><label className={lc}>Min Price<input className={ic} value={minPrice} onChange={(e) => setMinPrice(e.target.value)} /></label></div>
                <button className="btn-dark mt-5 w-full rounded-xl py-3" onClick={() => void createTradeIntent()} disabled={busy}>Create Trade Intent</button>
                <div className="mt-5"><div className="flex items-center justify-between"><p className="text-sm font-semibold text-[#1E293B]">Seller Intents</p><span className="badge badge-mint">{tradeIntents.length}</span></div>
                  <div className="mt-3 space-y-2">{tradeIntents.slice(0, 5).map((i) => (<div key={i.contractId} className="rounded-xl border border-[#E2E8F0] bg-slate-50 p-3 text-sm"><div className="flex items-center justify-between"><span className="font-semibold text-[#1E293B]">{i.payload.instrument}</span><button className="rounded-lg border border-[#E2E8F0] bg-white px-2 py-1 text-xs font-medium text-[#64748B]" onClick={() => void copyContractId(i.contractId)}>Copy</button></div><div className="mt-1 text-[#64748B]">Qty {optionalToNumber(i.payload.quantity)} | Min {optionalToNumber(i.payload.minPrice)}</div></div>))}{tradeIntents.length === 0 && <p className="text-sm text-[#64748B]">No intents yet.</p>}</div>
                </div>
              </div>
              <div className="dash-card"><div className="mb-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-purple-50 to-purple-100"><svg className="h-5 w-5 text-[#8B5CF6]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg></div><div><h2 className="text-lg font-semibold text-[#1E293B]">Seller Negotiation</h2><p className="text-sm text-[#64748B]">View buyer responses.</p></div></div>
                <label className={`mt-4 block ${lc}`}>Negotiation<select className={ic} value={selectedSellerNegotiation?.contractId ?? ""} onChange={(e) => setSellerNegotiationCid(e.target.value)}><option value="">Select</option>{sellerNegotiationsForSelection.map((r) => <option key={r.contractId} value={r.contractId}>{r.payload.instrument} - {shortId(r.contractId)}</option>)}</select></label>
                {selectedSellerNegotiation ? <div className="mt-3 rounded-xl border border-[#E2E8F0] bg-slate-50 p-3 text-sm"><div className="font-semibold text-[#1E293B]">{selectedSellerNegotiation.payload.instrument}</div><div className="mt-1 text-[#64748B]">{selectedTerms(selectedSellerNegotiation.payload)}</div><div className="mt-1 flex gap-3 text-xs text-[#64748B]"><span>Seller: {selectedSellerNegotiation.payload.sellerAccepted ? <span className="text-emerald-600">accepted</span> : "pending"}</span><span>Buyer: {selectedSellerNegotiation.payload.buyerAccepted ? <span className="text-emerald-600">accepted</span> : "pending"}</span></div>{sellerLastGeneratedCid && <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-700">New: {shortId(sellerLastGeneratedCid)}</div>}</div> : <p className="mt-3 text-sm text-[#64748B]">{sellerNegotiationsForSelection.length > 0 ? "Select a negotiation." : "No negotiations yet."}</p>}
                <div className="mt-4 grid gap-4 sm:grid-cols-2"><label className={lc}>Qty<input className={ic} value={negotiationQty} onChange={(e) => setNegotiationQty(e.target.value)} /></label><label className={lc}>Unit Price<input className={ic} value={negotiationPrice} onChange={(e) => setNegotiationPrice(e.target.value)} /></label></div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2"><button className="btn-primary rounded-xl py-2.5" onClick={() => void runSellerAcceptOffer()} disabled={busy || !selectedSellerNegotiation || !sellerCanAccept}>Accept</button><button className="btn-secondary rounded-xl py-2.5" onClick={() => void runSellerNegotiate()} disabled={busy || !selectedSellerNegotiation}>Negotiate</button></div>
              </div>
            </section>
          )}

          {view === "Buyer" && (
            <section className="stagger-children grid gap-6">
              <div className="dash-card"><div className="mb-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-orange-50 to-orange-100"><svg className="h-5 w-5 text-[#F97316]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" /><line x1="3" y1="6" x2="21" y2="6" /><path d="M16 10a4 4 0 0 1-8 0" /></svg></div><div><h2 className="text-lg font-semibold text-[#1E293B]">Trade Intents</h2><p className="text-sm text-[#64748B]">Review and negotiate.</p></div><span className="badge badge-amber ml-auto">{tradeIntents.length}</span></div>
                <div className="grid gap-2">{tradeIntents.map((i) => <div key={i.contractId} className="flex items-center justify-between rounded-xl border border-[#E2E8F0] bg-slate-50 p-3 text-sm"><div><span className="font-semibold text-[#1E293B]">{i.payload.instrument}</span><span className="ml-3 text-[#64748B]">Qty {optionalToNumber(i.payload.quantity)} | Min {optionalToNumber(i.payload.minPrice)}</span></div><button className="btn-primary rounded-lg px-4 py-1.5 text-xs" onClick={() => void runBuyerNegotiateFromIntent(i)} disabled={busy}>Negotiate</button></div>)}{tradeIntents.length === 0 && <p className="text-sm text-[#64748B]">No intents.</p>}</div>
              </div>
              <div className="dash-card"><div className="mb-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-50 to-blue-100"><NavIcon type="download" className="h-5 w-5 text-blue-500" /></div><div><h2 className="text-lg font-semibold text-[#1E293B]">Buyer Negotiation</h2><p className="text-sm text-[#64748B]">Counter, accept, or reject.</p></div></div>
                <label className={`mt-4 block ${lc}`}>Negotiation<select className={ic} value={selectedBuyerNegotiation?.contractId ?? ""} onChange={(e) => setBuyerNegotiationCid(e.target.value)} disabled={!buyerNegotiationsForSelection.length}><option value="">Select</option>{buyerNegotiationsForSelection.map((r) => <option key={r.contractId} value={r.contractId}>{r.payload.instrument} - {shortId(r.contractId)}</option>)}</select></label>
                {selectedBuyerNegotiation ? <div className="mt-3 rounded-xl border border-[#E2E8F0] bg-slate-50 p-3 text-sm"><div className="font-semibold text-[#1E293B]">{selectedBuyerNegotiation.payload.instrument}</div><div className="mt-1 text-[#64748B]">{selectedTerms(selectedBuyerNegotiation.payload)}</div><div className="mt-1 flex gap-3 text-xs text-[#64748B]"><span>Seller: {selectedBuyerNegotiation.payload.sellerAccepted ? <span className="text-emerald-600">accepted</span> : "pending"}</span><span>Buyer: {selectedBuyerNegotiation.payload.buyerAccepted ? <span className="text-emerald-600">accepted</span> : "pending"}</span></div>{buyerLastGeneratedCid && <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-700">New: {shortId(buyerLastGeneratedCid)}</div>}</div> : <p className="mt-3 text-sm text-[#64748B]">{buyerNegotiationsForSelection.length > 0 ? "Select a negotiation." : "No negotiations yet."}</p>}
                <div className="mt-4 grid gap-4 sm:grid-cols-2"><label className={lc}>Qty<input className={ic} value={negotiationQty} onChange={(e) => setNegotiationQty(e.target.value)} /></label><label className={lc}>Unit Price<input className={ic} value={negotiationPrice} onChange={(e) => setNegotiationPrice(e.target.value)} /></label></div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2"><button className="btn-primary rounded-xl py-2.5" onClick={() => void runBuyerAcceptOffer()} disabled={busy || !selectedBuyerNegotiation || !buyerCanAccept}>Accept</button><button className="btn-secondary rounded-xl py-2.5" onClick={() => void runBuyerNegotiate()} disabled={busy || !selectedBuyerNegotiation}>Negotiate</button></div>
              </div>
            </section>
          )}

          {view === "Outsider" && (
            <section className="stagger-children space-y-6"><div className="dash-card">
              <div className="mb-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-50 to-indigo-100"><NavIcon type="eye" className="h-5 w-5 text-indigo-500" /></div><div><h2 className="text-lg font-semibold text-[#1E293B]">Outsider Signal</h2><p className="text-sm text-[#64748B]">Auto-refreshes every 2s.</p></div><div className="ml-auto flex items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /><span className="text-xs font-medium text-emerald-600">Live</span></div></div>
              <div className="mb-6 grid gap-4 sm:grid-cols-3">
                <div className="rounded-xl border border-[#E2E8F0] bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wider text-[#64748B]">Completed</p><p className="mt-1 text-2xl font-bold text-[#1E293B]" style={{ fontFamily: "Sora" }}>{completedTotalDisplay}</p></div>
                <div className="rounded-xl border border-[#E2E8F0] bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wider text-[#64748B]">Detections</p><p className="mt-1 text-2xl font-bold text-[#1E293B]" style={{ fontFamily: "Sora" }}>{detectedCompletions.length}</p></div>
                <div className="rounded-xl border border-[#E2E8F0] bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wider text-[#64748B]">Signals</p><p className="mt-1 text-2xl font-bold text-[#1E293B]" style={{ fontFamily: "Sora" }}>{outsiderAcceptedSignals.length}</p></div>
              </div>
              <p className="text-sm font-semibold text-[#1E293B]">Live Feed</p>
              <div className="mt-3 space-y-2">{detectedCompletions.slice(0, 5).map((r) => <div key={`${r.contractId}-l`} className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm"><div className="flex items-center justify-between"><span className="font-semibold text-[#1E293B]">{r.instrument}</span><span className="badge badge-mint">detected</span></div><div className="mt-1 text-[#64748B]">Qty {r.quantity ?? "-"} | Unit {r.unitPrice ?? "-"}</div></div>)}{!detectedCompletions.length && <p className="text-sm text-[#64748B]">No outcomes yet.</p>}</div>
              <p className="mt-6 text-sm font-semibold text-[#1E293B]">Recent Outcomes</p>
              <div className="mt-3 space-y-2">{outsiderAcceptedSignals.map((s) => <div key={s.contractId} className="rounded-xl border border-[#E2E8F0] bg-slate-50 p-3 text-sm"><div className="flex items-center justify-between"><span className="font-semibold text-[#1E293B]">{s.instrument}</span><span className="badge badge-purple">{s.source}</span></div><div className="mt-1 text-[#64748B]">Qty {s.quantity ?? "-"} | Unit {s.unitPrice ?? "-"}</div></div>)}{!outsiderAcceptedSignals.length && <p className="text-sm text-[#64748B]">No outcomes.</p>}</div>
            </div></section>
          )}

          {view === "Inspector" && <div className="animate-fade-rise"><ContractVisibilityInspector availableParties={availableParties} activeParty={view} /></div>}
          {view === "Challenge" && <div className="animate-fade-rise"><PrivacyChallengeMode partyByRole={{ Seller: seller, Buyer: buyer, Outsider: outsider, Inspector: company }} suggestedIntentCid={suggestedIntentCid} suggestedNegotiationCid={suggestedNegotiationCid} /></div>}
        </div>
      </div>
    </div>
  );
}
