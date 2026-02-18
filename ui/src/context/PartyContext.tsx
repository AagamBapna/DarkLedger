import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { AgentLogEntry, Party } from "../types/contracts";

interface PartyContextShape {
  party: Party;
  setParty: (party: Party) => void;
  autoReprice: boolean;
  setAutoReprice: (enabled: boolean) => void;
  logs: AgentLogEntry[];
  addLog: (entry: Omit<AgentLogEntry, "id" | "at">) => void;
  clearLogs: () => void;
}

const PartyContext = createContext<PartyContextShape | undefined>(undefined);

const MAX_LOG_ENTRIES = 250;

export const partyOptions: Party[] = ["Seller", "SellerAgent", "Buyer", "BuyerAgent", "Company", "Public"];

export function PartyProvider({ children }: { children: ReactNode }) {
  const [party, setParty] = useState<Party>("SellerAgent");
  const [autoReprice, setAutoReprice] = useState(true);
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);

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
      clearLogs
    }),
    [party, autoReprice, logs, addLog, clearLogs]
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
