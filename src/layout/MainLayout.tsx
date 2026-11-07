import { Outlet } from "react-router-dom";
import { ReactNode } from "react";
import { SlotBoundary, useSlots } from "@shared";
import type { ShellRegions } from "@shared";
import WinBar from "../components/WinBar";
import SimpleShell from "../shell/SimpleShell";
import { DragRegion, ProgressRegion, QuickPanelsRegion, AccountStateRegion, PlayerAvatarRegion, SocialToggleRegion } from "../shell/regions";

// Built once: the regions are plain elements, stable so a theme's shell re-rendering doesn't
// re-create them.
const REGIONS: ShellRegions = {
  quickPanels: <QuickPanelsRegion />,
  accountState: <AccountStateRegion />,
  playerAvatar: <PlayerAvatarRegion />,
  socialToggle: <SocialToggleRegion />,
  windowControls: <WinBar />,
  progress: <ProgressRegion />,
  dragRegion: <DragRegion />,
};

/**
 * The main window: hands the regions and current page to the `Shell` slot (the theme's arrangement
 * or the built-in `SimpleShell`). A throwing theme shell falls back to the built-in one.
 */
export default function MainLayout({ children }: { children?: ReactNode }) {
  const Shell = useSlots().Shell;
  const page = children ?? <Outlet />;

  const builtIn = <SimpleShell regions={REGIONS}>{page}</SimpleShell>;
  if (!Shell) return builtIn;
  return (
    <SlotBoundary slot="Shell" fallback={builtIn}>
      <Shell regions={REGIONS}>{page}</Shell>
    </SlotBoundary>
  );
}
