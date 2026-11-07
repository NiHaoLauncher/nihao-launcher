import { create } from "zustand";
import type { QuickPanelItem } from "@shared";

interface QuickPanelState {
  /** Buttons each game module registered, by game id. */
  items: Record<string, QuickPanelItem[]>;
  setItems: (gameId: string, items: QuickPanelItem[]) => void;
  clear: (gameId: string) => void;
}

const NONE: QuickPanelItem[] = [];

export const useQuickPanel = create<QuickPanelState>((set) => ({
  items: {},
  setItems: (gameId, items) =>
    set((s) => ({ items: { ...s.items, [gameId]: items } })),
  clear: (gameId) =>
    set((s) => {
      if (!s.items[gameId]) return s;
      const { [gameId]: _removed, ...rest } = s.items;
      return { items: rest };
    }),
}));

/** The buttons registered by one game (a stable empty array when none). */
export const useGameQuickItems = (gameId: string | undefined): QuickPanelItem[] =>
  useQuickPanel((s) => (gameId ? s.items[gameId] ?? NONE : NONE));
