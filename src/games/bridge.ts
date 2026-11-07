import { createStore } from "zustand/vanilla";
import type { BridgeStore, LauncherBridge, PlayingActivity } from "@shared";

/**
 * Host-side functions the bridge forwards to, passed as a getter because some are recreated every
 * host render and the bridge must not be.
 */
export type BridgeActions = Pick<
  LauncherBridge,
  "openModal" | "closeModal" | "confirm" | "toast" | "setLanguage" | "setQuickPanel"
> & {
  openGame: NonNullable<LauncherBridge["openGame"]>;
  consumeDeepLink: NonNullable<LauncherBridge["consumeDeepLink"]>;
  reportPlayingActivity: (activity: PlayingActivity | null) => void;
  setLauncherHidden: (hidden: boolean) => void;
};

/** The data half of the bridge — pushed in by `GameModuleRenderer` whenever it changes. */
export type BridgeData = Pick<
  LauncherBridge,
  "language" | "languageRevision" | "gamePath" | "gameSettings" | "signedIn" | "defaultNickname" | "pendingDeepLink" | "view"
>;

export interface GameBridge {
  store: BridgeStore;
  /** Updates only the data fields that actually changed; a no-op (no new snapshot, no module
   *  re-render) if none did. */
  update: (data: BridgeData) => void;
}

const DATA_KEYS: (keyof BridgeData)[] = [
  "language", "languageRevision", "gamePath", "gameSettings", "signedIn", "defaultNickname", "pendingDeepLink", "view",
];

export function createGameBridge(
  moduleId: string,
  getActions: () => BridgeActions,
  initial: BridgeData,
): GameBridge {
  const store = createStore<LauncherBridge>(() => ({
    ...initial,
    moduleId,
    openModal: (o) => getActions().openModal(o),
    closeModal: () => getActions().closeModal(),
    confirm: (o) => getActions().confirm(o),
    toast: (o) => getActions().toast(o),
    setQuickPanel: (items) => getActions().setQuickPanel(items),
    openGame: (l) => getActions().openGame(l),
    consumeDeepLink: () => getActions().consumeDeepLink(),
    setLanguage: (l) => getActions().setLanguage(l),
    reportPlayingActivity: (a) => getActions().reportPlayingActivity(a),
    setLauncherHidden: (h) => getActions().setLauncherHidden(h),
  }));

  return {
    store,
    update(data) {
      const current = store.getState();
      const changed = DATA_KEYS.some((k) => current[k] !== data[k]);
      if (changed) store.setState(data);
    },
  };
}
