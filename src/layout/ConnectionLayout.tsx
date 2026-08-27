import { ReactNode } from "react";
import { Outlet } from "react-router-dom";

export default function ConnectionLayout({ children }: { children?: ReactNode }) {
  return (
    <main style={{justifyContent:"center", alignItems:"center"}}>
      <div style={{backgroundColor:"var(--main-background-color)", width:"85%", height:"200px", borderRadius:"var(--border-radius)"}}>
        {children ?? <Outlet />}
      </div>
    </main>
  )
}