import { ReactNode, useCallback, useEffect, useState } from "react";
import { t } from "@shared";
import "./settings.css";
import { useModal } from "../../context/ModalContext";
import GeneralSettingsTab from "./GeneralSettingsTab";
import GameSettingsTab from "./GameSettingsTab";
import OnlineServiceTab from "./OnlineServiceTab";

type SettingsCategory = "general" | "games" | "online";

/**
 * Opens the shared `Modal` (via `useModal()`) in its "categories" layout as a settings
 * screen. `Modal`'s category state lives with the caller, so switching tabs re-invokes
 * `openModal` with fresh `content`/`activeCategory` instead of the modal managing it itself.
 *
 * Each tab's Save button used to live inline in its own scrollable content; it's now reported
 * up via `onFooterChange` and rendered in the modal's pinned `footer` slot instead, so it stays
 * visible regardless of scroll position. The active tab still owns the button's state/logic
 * (saving/disabled) — this just relocates *where* it renders.
 */
export function useSettingsModal() {
  const { openModal } = useModal();
  const [active, setActive] = useState(false);
  const [category, setCategory] = useState<SettingsCategory>("general");
  const [footer, setFooter] = useState<ReactNode>(null);

  const changeCategory = useCallback((next: SettingsCategory) => {
    setFooter(null); // avoid the previous tab's Save button flashing before the new one reports its own
    setCategory(next);
  }, []);

  useEffect(() => {
    if (!active) return;
    openModal({
      title: t("title_launcher", "Settings"),
      size: "large",
      layout: "categories",
      categories: [
        { id: "general", label: t("title_general", "General") },
        { id: "games", label: t("title_game", "Game settings") },
        { id: "online", label: t("title_online_service", "Online Service") },
      ],
      activeCategory: category,
      onCategoryChange: (id) => changeCategory(id as SettingsCategory),
      content: category === "general"
        ? <GeneralSettingsTab onFooterChange={setFooter} />
        : category === "games"
          ? <GameSettingsTab onFooterChange={setFooter} />
          : <OnlineServiceTab />,
      footer,
      onClose: () => setActive(false),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, category, footer]);

  return useCallback(() => {
    setCategory("general");
    setFooter(null);
    setActive(true);
  }, []);
}
