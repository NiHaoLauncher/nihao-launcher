import { useCallback, useEffect, useRef } from "react";

/** Open modals, bottom to top. Which one is on top is tracked here rather than read back from the
 *  DOM, so it works however a theme draws a modal's frame. */
const stack: symbol[] = [];

/**
 * Registers a modal as open while `active`. Returns `isTopmost()` — Escape and clicks outside must
 * only reach the modal that is on top, never one underneath it.
 */
export function useModalStack(active: boolean): () => boolean {
  const id = useRef(Symbol("modal")).current;

  useEffect(() => {
    if (!active) return;
    stack.push(id);
    return () => {
      const at = stack.lastIndexOf(id);
      if (at >= 0) stack.splice(at, 1);
    };
  }, [active, id]);

  return useCallback(() => stack[stack.length - 1] === id, [id]);
}
