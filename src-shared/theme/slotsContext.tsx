import { Component, createContext, useContext, type ErrorInfo, type ReactNode } from "react";
import type { ThemeBehaviors, ThemeSlots } from "./slots";

const NO_SLOTS: Partial<ThemeSlots> = {};

declare global {
  interface Window {
    /** The active theme's slots, published by the host when a theme is applied — for code running
     *  in a game module's bundle, which has its own copy of React and therefore can't see the
     *  host's context. */
    __NIHAO_SLOTS__?: Partial<ThemeSlots>;
    /** The active theme's behaviors, published the same way. */
    __NIHAO_BEHAVIORS__?: ThemeBehaviors;
  }
}

/** The active theme's replacement components. Provided by the launcher (`ThemeSlotsProvider`). */
export const ThemeSlotsContext = createContext<Partial<ThemeSlots>>(NO_SLOTS);

/**
 * The slots in effect: the context in the launcher, or what the host published on `window` in a
 * game module's bundle (separate React). A slot there must use no hooks; if it throws,
 * `SlotBoundary` swaps in the built-in one.
 */
export const useSlots = (): Partial<ThemeSlots> => {
  const fromContext = useContext(ThemeSlotsContext);
  if (fromContext !== NO_SLOTS) return fromContext;
  return (typeof window !== "undefined" && window.__NIHAO_SLOTS__) || NO_SLOTS;
};

interface BoundaryProps {
  /** What to show instead if the slot throws while rendering. */
  fallback: ReactNode;
  /** Name for the console message. */
  slot: string;
  children: ReactNode;
}

/** Catches an error thrown by a theme's slot component and shows the built-in one instead. */
export class SlotBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Theme slot "${this.props.slot}" failed — using the built-in one.`, error, info.componentStack);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
