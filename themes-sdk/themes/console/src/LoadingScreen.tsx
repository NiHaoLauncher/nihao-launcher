import type { LoadingScreenProps } from "@shared/theme/slots";

/**
 * Console's startup screen: a dark rounded card with the status line, loading animation, update
 * progress bar and (while waiting for the server) a continue-offline button. The launcher drives
 * it; this only draws.
 */
export default function LoadingScreen({ title, image, progress, onSkip, skipLabel }: LoadingScreenProps) {
  return (
    <main style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ backgroundColor: "var(--main-background-color)", width: "85%", height: "200px", borderRadius: "var(--border-radius)" }}>
        <div style={{ display: "grid", placeItems: "center", justifyContent: "center", alignItems: "center" }}>
          <h1>{title}</h1>
          <img src={image} style={{ imageRendering: "pixelated", width: "150px" }} />
          {progress !== null && (
            <div style={{ width: "300px", height: "8px", background: "#ddd", borderRadius: "4px", overflow: "hidden", marginTop: "1rem" }}>
              <div style={{ width: `${progress}%`, height: "100%", background: "var(--main-color)", transition: "width 0.2s" }} />
            </div>
          )}
          {onSkip && <button onClick={onSkip} style={{ marginTop: "1rem" }}>{skipLabel}</button>}
        </div>
      </div>
    </main>
  );
}
