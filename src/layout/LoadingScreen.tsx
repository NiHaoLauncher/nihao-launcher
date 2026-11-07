import { useEffect } from "react";
import { SlotBoundary, useSlots } from "@shared";
import type { LoadingScreenProps } from "@shared";
import { DragRegion } from "../shell/regions";
import WinBar from "../components/WinBar";
import { hideBoot } from "../boot";
import "./LoadingScreen.css";

const RING_R = 92;
const RING_LEN = 2 * Math.PI * RING_R;

/**
 * Built-in startup screen: a planet with a moon; the outer ring is the update download progress.
 * The status line is only exposed as the label; a link to continue offline shows while waiting for
 * the server.
 */
function SimpleLoadingScreen({ title, progress, onSkip, skipLabel }: LoadingScreenProps) {
  return (
    <main className="simple-loading">
      <DragRegion />
      <div className="simple-loading-box">
        <svg className={`simple-orbit${progress === null ? " indeterminate" : ""}`} viewBox="0 0 200 200" role="img" aria-label={title}>
          <circle className="simple-orbit-track" cx="100" cy="100" r={RING_R} />
          <circle
            className="simple-orbit-arc" cx="100" cy="100" r={RING_R}
            strokeDasharray={progress === null ? undefined : `${(progress / 100) * RING_LEN} ${RING_LEN}`}
          />
          <circle className="simple-orbit-path" cx="100" cy="100" r="46" />
          <circle className="simple-orbit-planet" cx="100" cy="100" r="20" />
          <g className="simple-orbit-moon"><circle cx="146" cy="100" r="4" /></g>
        </svg>
        {onSkip && <button className="simple-loading-skip" onClick={onSkip}>{skipLabel}</button>}
      </div>
    </main>
  );
}

/**
 * The startup screen: the theme's `slots.LoadingScreen` or the built-in one (also the fallback if
 * the theme's throws; the launcher must always be able to start).
 */
export default function LoadingScreen(props: LoadingScreenProps) {
  useEffect(hideBoot, []);
  const View = useSlots().LoadingScreen;
  const builtIn = <SimpleLoadingScreen {...props} />;
  const screen = !View ? builtIn : (
    <SlotBoundary slot="LoadingScreen" fallback={builtIn}>
      <View {...props} />
    </SlotBoundary>
  );
  return (
    <>
      {screen}
      <div style={{ position: "fixed", top: 0, right: 0, zIndex: 1000 }}><WinBar minimal /></div>
    </>
  );
}
