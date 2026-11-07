import { ReactNode, useEffect } from "react";
import { create } from "zustand";
import { t } from "@shared";
import "./settings.css";
import { useModal } from "../../context/ModalContext";
import { useTheme } from "../../state/Theme";
import GeneralSettingsTab from "./GeneralSettingsTab";
import GameSettingsTab from "./GameSettingsTab";
import AppearanceSettingsTab from "./AppearanceSettingsTab";
import OnlineServiceTab from "./OnlineServiceTab";
import AboutSettingsTab from "./AboutSettingsTab";
import SlidersIcon from "@shared/assets/icons/sliders.svg?react";
import GamepadIcon from "@shared/assets/icons/gamepad.svg?react";
import CloudIcon from "@shared/assets/icons/cloud.svg?react";
import PaletteIcon from "@shared/assets/icons/palette.svg?react";
import InfoIcon from "@shared/assets/icons/info.svg?react";

type SettingsCategory = "general" | "appearance" | "games" | "online" | "about";

interface SettingsUi {
  active: boolean;
  category: SettingsCategory;
  /** The active tab's Save/Cancel buttons, reported up so the modal can pin them in its footer. */
  footer: ReactNode;
  /** What the active tab says is about to change (the footer's command line) — see ChangeSummary. */
  hint: ReactNode;
  open: () => void;
  close: () => void;
  changeCategory: (next: SettingsCategory) => void;
  reportFooter: (buttons: ReactNode, text?: ReactNode) => void;
}

/**
 * The settings screen's state, in a store rather than a component: whoever opens it can be
 * unmounted and re-created while it is open (a theme with another main-window layout does that),
 * and the screen must not lose its place or keep a stale footer.
 */
const useSettingsUi = create<SettingsUi>((set, get) => ({
  active: false,
  category: "general",
  footer: null,
  hint: null,
  open: () => set({ active: true, category: "general", footer: null, hint: null }),
  close: () => set({ active: false }),
  changeCategory: (next) => {
    // Re-clicking the active tab must do nothing: it would clear the footer, but the tab (same
    // category) wouldn't remount to report Save again.
    if (next === get().category) return;
    set({ category: next, footer: null, hint: null });
  },
  reportFooter: (buttons, text) => set({ footer: buttons, hint: text ?? null }),
}));

/** Opens the settings screen. */
export function useSettingsModal() {
  return useSettingsUi((s) => s.open);
}

/**
 * Stable id: `openModal` treats a repeat call with the same id as an in-place update, which tab
 * switching needs.
 */
const MODAL_ID = "settings-modal";

/**
 * Keeps the shared `Modal` open in its categories layout while the store says settings are active.
 * Mount once at the app root so it outlives the main window layout. Tabs report their Save button
 * via `reportFooter`; it is pinned in the footer.
 */
export function SettingsModalHost() {
  const { openModal } = useModal();
  const { active, category, footer, hint, close, changeCategory, reportFooter } = useSettingsUi();

  useEffect(() => {
    if (!active) return;
    openModal({
      id: MODAL_ID,
      title: t("title_launcher", "Settings"),
      size: "large",
      height: 600,
      layout: "categories",
      categories: [
        { id: "general", label: t("title_general", "General"), icon: <SlidersIcon /> },
        { id: "appearance", label: t("title_appearance", "Appearance"), icon: <PaletteIcon /> },
        { id: "games", label: t("title_game", "Game settings"), icon: <GamepadIcon /> },
        { id: "online", label: t("title_online_service", "Online Service"), icon: <CloudIcon /> },
        { id: "about", label: t("title_about", "About"), icon: <InfoIcon /> },
      ],
      activeCategory: category,
      onCategoryChange: (id) => changeCategory(id as SettingsCategory),
      content: category === "general"
        ? <GeneralSettingsTab onFooterChange={reportFooter} />
        : category === "appearance"
          ? <AppearanceSettingsTab onFooterChange={reportFooter} />
          : category === "games"
            ? <GameSettingsTab onFooterChange={reportFooter} />
            : category === "online"
              ? <OnlineServiceTab />
              : <AboutSettingsTab />,
      footer,
      footerHint: hint,
      onClose: () => {
        close();
        // Closing without saving: previewed theme/settings revert.
        useTheme.getState().discardPreview();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, category, footer, hint]);

  return null;
}
