import { Outlet } from "react-router-dom";
import { ReactNode } from "react";
import "./MainLayout.css";
import WinBar from "../components/WinBar";

export default function BlankLayout({ children, hideWinBar }: { children?: ReactNode, hideWinBar?: boolean }) {
  return (
    <main className="mainLayout" style={{ overflow: "visible" }}>
      <div style={{backgroundColor:"var(--main-background-color)", width:"100%", height:"100%", borderRadius:"var(--border-radius)", display:"flex", flexDirection:"column", overflow:"hidden"}}>
        <div style={{position:"absolute",top:"0",left:"0",zIndex:"999", width:"100%", height:"20px"}} data-tauri-drag-region/>
        {
          hideWinBar ?? 
          <div style={{position:"absolute", right:"7px"}}>
            <WinBar/>
          </div>
        }
        {children ?? <Outlet />}
      </div>
    </main>
  )
}