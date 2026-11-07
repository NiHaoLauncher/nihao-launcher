import { invoke } from "@tauri-apps/api/tauri";
import { useCallback } from "react";
import { useBridge } from "./hooks";

export type Value = string | number | boolean | null | { [key: string]: Value } | Value[];

export async function call_module(module: string, method: string, args: Value = {}): Promise<any> {
    return await invoke("call_module", { module, method, args });
}

/**
 * Хук для спрощеного виклику методів поточного модуля (автоматично підставляє moduleId)
 */
export function useCallModule() {
  const moduleId = useBridge((b) => b.moduleId);
  // Stable per module: components list this in effect dependency arrays, so a new function on
  // every render would re-run those effects (and re-fetch) on every render.
  return useCallback(async (method: string, args: Value = {}): Promise<any> => {
    if (!moduleId) {
      throw new Error("No moduleId found in launcherBridge context. Ensure this component is inside a Module.");
    }
    return await call_module(moduleId, method, args);
  }, [moduleId]);
}
