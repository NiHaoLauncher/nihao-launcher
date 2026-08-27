import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { LocalClient } from "../launcher/UserProfile";

export interface Lang {
  id: string;
  language: string;
  [key: string]: any;
}

interface ClientContextType {
  localClient: LocalClient | null;
  setLocalClient: (localClient: LocalClient | null) => void;
  /** True once InitPage has resolved whether a local profile exists at all — `localClient`
   *  being null is ambiguous on its own (still loading vs. genuinely no profile yet), so
   *  anything that needs to tell those apart (AuthContext's reachability probe) waits for this. */
  localClientLoaded: boolean;
  markLocalClientLoaded: () => void;

  language: Lang | null;
  setLanguageKeys: (language: Lang | null) => void;
}

const ClientContext = createContext<ClientContextType | undefined>(undefined);

function getSessionStorage<T>(key: string): T | null {
  try {
    const item = sessionStorage.getItem(key);
    return item ? JSON.parse(item) : null;
  } catch {
    return null;
  }
}

function setSessionStorage<T>(key: string, value: T | null): void {
  if (value === null) {
    sessionStorage.removeItem(key);
  } else {
    sessionStorage.setItem(key, JSON.stringify(value));
  }
}

export function ClientProvider({ children }: { children: ReactNode }) {
  const [localClient, setLocalClientState] = useState<LocalClient | null>(
    () => getSessionStorage<LocalClient>("localClient")
  );
  // A prior session already resolved this (localClient came from sessionStorage above), so
  // there's nothing to wait for this time either way.
  const [localClientLoaded, setLocalClientLoaded] = useState(() => getSessionStorage<LocalClient>("localClient") !== null);
  const [language, setLanguageState] = useState<Lang | null>(
    () => getSessionStorage<Lang>("language")
  );

  const setLocalClient = (value: LocalClient | null) => {
    setLocalClientState(value);
    setSessionStorage("localClient", value);
  };

  const markLocalClientLoaded = () => setLocalClientLoaded(true);

  const setLanguageKeys = (value: Lang | null) => {
    setLanguageState(value);
    setSessionStorage("language", value);
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__NIHAO_I18N__ = language;
    }
  }, [language]);

  return (
    <ClientContext.Provider value={{ localClient, setLocalClient, localClientLoaded, markLocalClientLoaded, language, setLanguageKeys }}>
      {children}
    </ClientContext.Provider>
  );
}

export function useClient() {
  const context = useContext(ClientContext);
  if (context === undefined) {
    throw new Error("useProfile must be used within a ProfileProvider");
  }
  return context;
}