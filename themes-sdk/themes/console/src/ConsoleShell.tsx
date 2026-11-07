import type { ShellProps } from "@shared/theme/slots";

/**
 * The Console main-window arrangement: content column with the top bar (quick panel in the middle,
 * window controls at the right) above the page, install progress line along the bottom. It only
 * places the regions.
 */
export default function ConsoleShell({ regions, children }: ShellProps) {
  return (
    <main className="mainLayout" style={{ overflow: "visible" }}>
      <div className="splitHorizontal" style={{width:"100%", flex:"1", minHeight:"0", display:"flex"}}>
        <div style={{backgroundColor:"var(--main-background-color)", width:"100%", flex:"1", minHeight:"0", borderRadius:"var(--border-radius)", display:"flex", flexDirection:"column", overflow:"hidden"}}>
          {regions.dragRegion}
          <div className="mainbar" style={{display:"flex",height:"50px", zIndex:"5", flexShrink:"0"}}>
            <div style={{width:"250px",padding:"7px",display:"flex",alignItems:"center",gap:"8px"}}>{regions.accountState}{regions.playerAvatar}{regions.socialToggle}</div>
            {regions.quickPanels}
            {regions.windowControls}
          </div>
          <div style={{overflowY:"auto", flex:"1", minHeight:"0"}}>
            {children}
          </div>
        </div>
      </div>
      {regions.progress}
    </main>
  );
}
