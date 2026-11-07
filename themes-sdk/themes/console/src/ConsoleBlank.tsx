import type { BlankShellProps } from "@shared/theme/slots";

/**
 * Console's frame for the first-run setup and uninstall pages: the same dark rounded panel as the
 * main window, window controls in the top right corner.
 */
export default function ConsoleBlank({ windowControls, dragRegion, children }: BlankShellProps) {
  return (
    <main className="mainLayout" style={{ overflow: "visible" }}>
      <div style={{backgroundColor:"var(--main-background-color)", width:"100%", height:"100%", borderRadius:"var(--border-radius)", display:"flex", flexDirection:"column", overflow:"hidden"}}>
        {dragRegion}
        <div style={{position:"absolute", right:"7px"}}>{windowControls}</div>
        {children}
      </div>
    </main>
  );
}
