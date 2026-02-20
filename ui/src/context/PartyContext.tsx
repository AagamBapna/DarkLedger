import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentLogEntry, Party } from "../types/contracts";

interface PartyContextShape {
  party: Party;
  setParty: (party: Party) => void;
  autoReprice: boolean;
  setAutoReprice: (enabled: boolean) => void;
  logs: AgentLogEntry[];
  addLog: (entry: Omit<AgentLogEntry, "id" | "at">) => void;
  clearLogs: () => void;
  availableParties: string[];
  networkMode: string;
}

const PartyContext = createContext<PartyContextShape | undefined>(undefined);

const MAX_LOG_ENTRIES = 250;

const DEFAULT_PARTIES: Party[] = ["Seller", "SellerAgent", "Buyer", "BuyerAgent", "Company", "Outsider"];

export const partyOptions: Party[] = DEFAULT_PARTIES;

const JSON_API_URL = import.meta.env.VITE_JSON_API_URL ?? "http://localhost:7575";
const NETWORK_MODE = import.meta.env.VITE_CANTON_NETWORK_MODE ?? "local";

export function PartyProvider({ children }: { children: ReactNode }) {
  const [party, setParty] = useState<Party>("SellerAgent");
  const [autoReprice, setAutoReprice] = useState(true);
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);
  const [availableParties, setAvailableParties] = useState<string[]>([...DEFAULT_PARTIES]);

  // Dynamically load parties from gateway /v1/parties
  useEffect(() => {
    let cancelled = false;
    const loadParties = async () => {
      try {
        const response = await fetch(`${JSON_API_URL}/v1/parties`);
        if (!response.ok) return;
        const data = await response.json() as { result?: Array<{ displayName?: string; identifier: string }> };
        const parties = (data.result ?? [])
          .map((p) => p.displayName || p.identifier)
          .filter((name) => name);
        if (!cancelled && parties.length > 0) {
          setAvailableParties(Array.from(new Set(parties)));
        }
      } catch {
        // Fall back to defaults
      }
    };
    void loadParties();
    return () => { cancelled = true; };
  }, []);

  const addLog = useCallback((entry: Omit<AgentLogEntry, "id" | "at">) => {
    setLogs((prev) => {
      const next: AgentLogEntry = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        ...entry
      };
      return [next, ...prev].slice(0, MAX_LOG_ENTRIES);
    });
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  const value = useMemo(
    () => ({
      party,
      setParty,
      autoReprice,
      setAutoReprice,
      logs,
      addLog,
      clearLogs,
      availableParties,
      networkMode: NETWORK_MODE,
    }),
    [party, autoReprice, logs, addLog, clearLogs, availableParties]
  );

  return <PartyContext.Provider value={value}>{children}</PartyContext.Provider>;
}

export function usePartyContext(): PartyContextShape {
  const context = useContext(PartyContext);
  if (!context) {
    throw new Error("usePartyContext must be used inside PartyProvider.");
  }
  return context;
}
