import { Outlet } from "react-router-dom";
import { ReactNode } from "react";
import { SlotBoundary, useSlots } from "@shared";
import type { BlankShellProps } from "@shared";
import { DragRegion } from "../shell/regions";
import WinBar from "../components/WinBar";
import "../shell/SimpleShell.css";

/** Built-in frame: one solid panel (like `SimpleShell`), window controls in the top right corner. */
function SimpleBlankShell({ windowControls, dragRegion, children }: BlankShellProps) {
  return (
    <main className="mainLayout simple-shell" style={{ overflow: "hidden" }}>
      {dragRegion}
      <div style={{ position: "absolute", right: "7px" }}>{windowControls}</div>
      {children}
    </main>
  );
}

/**
 * The frame of the full-window pages (first-run setup, uninstall): the theme's `BlankShell` slot or
 * the built-in one (also the fallback if the theme's throws).
 */
export default function BlankLayout({ children, minimal }: { children?: ReactNode; minimal?: boolean }) {
  const Shell = useSlots().BlankShell;
  const props = { windowControls: <WinBar minimal={minimal} />, dragRegion: <DragRegion />, children: children ?? <Outlet /> };

  const builtIn = <SimpleBlankShell {...props} />;
  if (!Shell) return builtIn;
  return (
    <SlotBoundary slot="BlankShell" fallback={builtIn}>
      <Shell {...props} />
    </SlotBoundary>
  );
}
