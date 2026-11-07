import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { getGameConfig } from "../../games/GameRegistry";

/**
 * Re-verify interval while a service is healthy; also the cadence of the first retries after it
 * drops (`FAST_RETRY_ATTEMPTS`).
 */
const STEADY_POLL_MS = 20000;
/**
 * Quick retries after losing a connection it had, before falling back to `SLOW_RETRY_MS`. A module
 * that never connected gets none and waits for a manual refresh.
 */
const FAST_RETRY_ATTEMPTS = 3;
/**
 * Retry cadence once `FAST_RETRY_ATTEMPTS` is used up: a service that worked is still worth
 * waiting on, just not every 20s.
 */
const SLOW_RETRY_MS = 10 * 60 * 1000;

export interface ModuleServiceStatus {
  moduleId: string;
  name: string;
  icon?: string;
  /** `null` while the very first check for this module is still in flight. */
  connected: boolean | null;
}

interface ModuleServiceTimerState {
  everConnected: boolean;
  attemptsSinceLoss: number;
  /** Never connected on the first check: polling stopped until the next manual refresh. */
  gaveUp: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Polls `check_service_status` of every loaded module that opted in (`hasOnlineService`): a cheap
 * unauthenticated reachability probe against the module's own server.
 * Retries per module: healthy re-checks every `STEADY_POLL_MS`; after a drop,
 * `FAST_RETRY_ATTEMPTS` retries then `SLOW_RETRY_MS` forever; never connected once: a single
 * check, then it waits for a manual refresh.
 */
export function useModuleServices(refreshSignal: number) {
  const [services, setServices] = useState<ModuleServiceStatus[]>([]);
  const stateRef = useRef<Map<string, ModuleServiceTimerState>>(new Map());
  const cancelledRef = useRef(false);

  function scheduleCheck(moduleId: string, delay: number) {
    if (cancelledRef.current) return;
    const s = stateRef.current.get(moduleId);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => checkOnce(moduleId), delay);
  }

  async function checkOnce(moduleId: string) {
    if (cancelledRef.current) return;
    const s = stateRef.current.get(moduleId);
    if (!s || s.gaveUp) return;

    let ok = false;
    try {
      const res: any = await invoke("call_module", { module: moduleId, method: "check_service_status", args: {} });
      ok = !!res?.connected;
    } catch {
      ok = false;
    }
    if (cancelledRef.current) return;
    // `stateRef` may have been replaced by a refresh while this was in flight.
    const current = stateRef.current.get(moduleId);
    if (!current) return;

    setServices((prev) => prev.map((m) => (m.moduleId === moduleId ? { ...m, connected: ok } : m)));

    if (ok) {
      current.everConnected = true;
      current.attemptsSinceLoss = 0;
      scheduleCheck(moduleId, STEADY_POLL_MS);
      return;
    }

    if (!current.everConnected) {
      current.gaveUp = true;
      return;
    }

    current.attemptsSinceLoss += 1;
    const delay = current.attemptsSinceLoss <= FAST_RETRY_ATTEMPTS ? STEADY_POLL_MS : SLOW_RETRY_MS;
    scheduleCheck(moduleId, delay);
  }

  async function discover() {
    let moduleIds: string[] = [];
    try {
      const res = await invoke("list_modules");
      moduleIds = Array.isArray(res) ? res : [];
    } catch {
      return;
    }
    if (cancelledRef.current) return;

    const withService: ModuleServiceStatus[] = [];
    for (const moduleId of moduleIds) {
      try {
        const cfg = await getGameConfig(moduleId);
        if (!cfg.hasOnlineService) continue;
        withService.push({ moduleId, name: cfg.name, icon: cfg.icon, connected: null });
      } catch {
      }
    }
    if (cancelledRef.current) return;

    for (const s of stateRef.current.values()) {
      if (s.timer) clearTimeout(s.timer);
    }
    stateRef.current = new Map(
      withService.map((m) => [m.moduleId, { everConnected: false, attemptsSinceLoss: 0, gaveUp: false, timer: null }])
    );

    setServices(withService);
    withService.forEach((svc) => checkOnce(svc.moduleId));
  }

  useEffect(() => {
    cancelledRef.current = false;
    discover();
    return () => {
      cancelledRef.current = true;
      for (const s of stateRef.current.values()) {
        if (s.timer) clearTimeout(s.timer);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  return services;
}
