import { create } from "zustand";

export type NoticeKind = "info" | "ok" | "error";

export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
  /** Bold first line when the notice is about something named (a modpack); `text` is then the action. */
  title?: string;
  /** Picture of what it is about (a game's icon). */
  icon?: string;
  at: number;
}

interface StatusState {
  notices: Notice[];
  push: (kind: NoticeKind, text: string, about?: { title?: string; icon?: string }) => void;
  clear: () => void;
}

const MAX_NOTICES = 30;
let nextId = 1;

/** Notifications of this launcher run (not saved): newest first. */
export const useStatus = create<StatusState>((set) => ({
  notices: [],
  push: (kind, text, about) =>
    set((s) => ({ notices: [{ id: nextId++, kind, text, ...about, at: Date.now() }, ...s.notices].slice(0, MAX_NOTICES) })),
  clear: () => set({ notices: [] }),
}));
