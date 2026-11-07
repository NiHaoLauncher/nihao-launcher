import { createContext, useContext, useSyncExternalStore } from 'react';
import { BridgeStore, LauncherBridge } from './types';

/** Legacy: a static bridge object handed over by an older host. Prefer the store below. */
export const LauncherBridgeContext = createContext<LauncherBridge | null>(null);

/**
 * The host's bridge as an external store; components subscribe to just the slice they read via
 * `useBridge`.
 */
export const BridgeStoreContext = createContext<BridgeStore | null>(null);

const noopSubscribe = () => () => {};

/**
 * Reads one slice of the host bridge, e.g. `useBridge((b) => b.gamePath)`. Re-renders only when
 * that slice changes (`Object.is`), so keep the selector returning a primitive or a stable
 * reference. `undefined` while no bridge is available.
 */
export function useBridge<T>(selector: (bridge: LauncherBridge) => T): T | undefined {
  const store = useContext(BridgeStoreContext);
  const legacy = useContext(LauncherBridgeContext);
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => {
      const bridge = store ? store.getState() : legacy;
      return bridge ? selector(bridge) : undefined;
    },
  );
}

/** The whole bridge; re-renders on any change. Prefer `useBridge` with a selector. */
export const useLauncher = (): LauncherBridge | null => useBridge((b) => b) ?? null;

/**
 * Хук для отримання ID поточного модуля (наприклад, "minecraft")
 */
export const useModuleId = (): string | undefined => useBridge((b) => b.moduleId);
