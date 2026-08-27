import { invoke } from "@tauri-apps/api/tauri";
import { useLauncher } from "./hooks";

export type Value = string | number | boolean | null | { [key: string]: Value } | Value[];

export async function call_module(module: string, method: string, args: Value = {}): Promise<any> {
    console.log("CALL MODULE", module, method, args);
    return await invoke("call_module", { module, method, args });
}

/**
 * Хук для спрощеного виклику методів поточного модуля (автоматично підставляє moduleId)
 */
export function useCallModule() {
  const bridge = useLauncher();
  return async (method: string, args: Value = {}): Promise<any> => {
    console.log("DEBUG: bridge is", bridge);
    const module = bridge?.moduleId;
    if (!module) {
      throw new Error("No moduleId found in launcherBridge context. Ensure this component is inside a Module.");
    }
    return await call_module(module, method, args);
  };
}