import type { ShellProps } from "@shared";
import { useTheme } from "../state/Theme";
import "./SimpleShell.css";

type Side = "top" | "bottom" | "left" | "right";

/**
 * The built-in main-window arrangement: one plain panel holding the bar, the page and the install
 * progress line, separated by thin lines. The quick panel can go on any side (theme setting "Quick
 * panel position"). It only places the regions it is given; a theme's `Shell` slot gets the same
 * regions and may arrange them freely.
 */
export default function SimpleShell({ regions, children }: ShellProps) {
  const setting = useTheme((s) => s.theme.settingValues?.quickPanel);
  const side: Side = setting === "bottom" || setting === "left" || setting === "right" ? setting : "top";

  // Off the top, the avatar + friends buttons follow the quick panel: bottom of the side column, left end of the bottom bar.
  const account = <div className="simple-account">{regions.playerAvatar}{regions.socialToggle}</div>;

  return (
    <main className="mainLayout simple-shell" data-quick-panel={side} style={{ overflow: "hidden" }}>
      <div className="splitHorizontal simple-split">
        {side === "left" && <aside className="mainbar simple-side">{regions.quickPanels}{account}</aside>}
        <div className="simple-content">
          {regions.dragRegion}
          <div className="mainbar simple-bar">
            <div className="simple-bar-spacer">{regions.accountState}{side === "top" && <>{regions.playerAvatar}{regions.socialToggle}</>}</div>
            {side === "top" && regions.quickPanels}
            {regions.windowControls}
          </div>
          <div className="simple-page">{children}</div>
          {side === "bottom" && (
            <div className="mainbar simple-bar simple-bar-bottom">{account}{regions.quickPanels}</div>
          )}
        </div>
        {side === "right" && <aside className="mainbar simple-side">{regions.quickPanels}{account}</aside>}
      </div>
      {regions.progress}
    </main>
  );
}
