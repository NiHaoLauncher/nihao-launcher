import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "@shared/i18n";
import type { LinkState, OnlineServiceProps } from "@shared/theme/slots";
import RefreshIcon from "@shared/assets/icons/refresh.svg?react";
import OrbitIcon from "@shared/assets/icons/orbit.svg?react";
import UserIcon from "@shared/assets/icons/user-circle.svg?react";

/**
 * Segments of the beacon's ring (angle, index) with an uneven delay/period each, so a down link
 * never lunges in step.
 */
const TICKS = Array.from({ length: 16 }, (_, i) => ({
  "--a": `${i * 22.5}deg`,
  "--i": i,
  "--d": `${((i * 37) % 29) / 10}s`,
  "--s": `${3.6 + ((i * 53) % 17) / 7}s`,
}));

/**
 * Colour of one symbol in a console lane: mostly the link colour with the odd red/grey/amber one
 * (an unclean connection).
 */
type Tone = "b" | "r" | "g" | "y";

function toneAt(i: number, lane: number): Tone {
  const h = (i * 31 + lane * 17) % 23;
  if (h === 3 || h === 14) return "r";
  if (h === 7 || h === 11 || h === 19) return "g";
  if (h === 21) return "y";
  return "b";
}

/** Splits `text` into same-tone runs, e.g. [{ tone: "b", text: "._ ." }, { tone: "r", text: "-" }]. */
function toRuns(text: string, lane: number): { tone: Tone; text: string }[] {
  const runs: { tone: Tone; text: string }[] = [];
  [...text].forEach((ch, i) => {
    const tone = toneAt(i, lane);
    const last = runs[runs.length - 1];
    if (last && last.tone === tone) last.text += ch;
    else runs.push({ tone, text: ch });
  });
  return runs;
}

/**
 * Console data lanes for the connecting state: runs of symbols advancing one character at a time
 * (CSS `steps()`). `n` = symbols per repeat; the lane hops exactly that far per cycle so the
 * repeat is seamless.
 */
const LANE_UNITS = [
  "._ . _-_ .:_ -. _          .._-. _ :. -_ .     _.-   ",
  ".. _ - . __ .- :        _. -_. .: _ .-. __       :  ",
  "- . _:. .__          - ._ . :_ .-_ .    -.. _. :_      ",
];
const LANES = LANE_UNITS.map((unit, lane) => {
  const n = [...unit].length;
  const repeats = Math.ceil(130 / n) + 1; // enough to cover the card plus one hop
  return { n, runs: Array.from({ length: repeats }, () => toRuns(unit, lane)).flat() };
});

/**
 * The rare burst of "information" across a dead link: a few bright symbols stepping across one
 * character at a time.
 */
const BURST_CHARS = [..."_:. -_ :.- _:"].map((ch, i) => ({ ch, tone: toneAt(i, 2) }));

/** Each symbol of a burst gets its own random size, 1px up to the full 14px of the lanes. */
const randomBurstSizes = () => BURST_CHARS.map(() => 1 + Math.floor(Math.random() * 14));

const CLEAN_CHARS = [..."-- >>>> .:"].map((ch) => ({ ch, tone: "b" as Tone }));

/** Bursts come at random; noisier and more frequent on a dead link, calmer on a live one. */
const DEAD_BURST_MS: [number, number] = [4000, 15000];
const LIVE_BURST_MS: [number, number] = [8000, 20000];
const burstGap = (lost: boolean) => {
  const [min, max] = lost ? DEAD_BURST_MS : LIVE_BURST_MS;
  return min + Math.random() * (max - min);
};

const animationsOff = () => document.documentElement.dataset.animations === "off";

function Burst({ state }: { state: LinkState }) {
  const animated = !animationsOff();
  const lost = state === "lost";
  // Each pass is a fresh element (`key={run}`): the CSS animation plays once per mount and the
  // timer decides when the next starts (CSS can't randomise an interval).
  const [run, setRun] = useState(0);
  const [sizes, setSizes] = useState(randomBurstSizes);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSizes(randomBurstSizes());
      setRun((r) => r + 1);
    }, burstGap(lost));
    return () => clearTimeout(timer);
  }, [run, lost]);

  const chars = lost ? BURST_CHARS : CLEAN_CHARS;
  if (!animated) return null;
  return (
    <span
      key={run}
      className="os-burst"
      style={run === 0 ? ({ "--burst-delay": `${1 + Math.random() * 3}s` } as React.CSSProperties) : undefined}
    >
      <b>
        {chars.map((c, i) => (
          <span key={i} className={`t-${c.tone}`} style={{ fontSize: lost ? sizes[i] : 13 }}>{c.ch}</span>
        ))}
      </b>
    </span>
  );
}

/** How long the switch between two link states plays (beacon flash + background change). Keep in
 *  step with `--c-link-switch` in vars.css, which drives the matching CSS durations. */
const SWITCH_MS = 900;
const transitionMs = () => SWITCH_MS;

/**
 * A signal beacon instead of a status dot: rings radiate while up, a sweep turns while
 * (re)connecting, a dashed dead ring when the signal is lost.
 */
function SignalBeacon({ state }: { state: LinkState }) {
  const shown = useRef(state);
  // `on` while a state change is being played out; `id` restarts the one-shot flash each time.
  const [sw, setSw] = useState({ id: 0, on: false });

  useLayoutEffect(() => {
    if (shown.current === state) return;
    shown.current = state;
    setSw((cur) => ({ id: cur.id + 1, on: true }));
    const timer = setTimeout(() => setSw((cur) => ({ ...cur, on: false })), transitionMs());
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <span className={`os-beacon os-beacon-${state}${sw.on ? " os-beacon-switching" : ""}`} aria-hidden="true">
      {sw.on && <span key={sw.id} className="os-beacon-flash" />}
      <span className="os-beacon-ring" />
      <span className="os-beacon-ring os-beacon-ring-2" />
      <span className="os-beacon-sweep" />
      <span className="os-ticks">
        {TICKS.map((tick, i) => (
          <i key={i} style={tick as React.CSSProperties} />
        ))}
      </span>
      <span className="os-beacon-core" />
    </span>
  );
}

/**
 * The card's background activity layer per link state: a calm, faint console stream
 * (connected/signed out), three jumping console lanes (connecting), a flat dashed line with rare
 * flickers and bursts (lost).
 */
function EcgLayer({ state, phase, live }: { state: LinkState; phase?: "in" | "out"; live: boolean }) {
  return (
    <span className={`os-ecg os-card-${state}${phase ? ` os-ecg-${phase}` : ""}`} aria-hidden="true">
      <span className="os-ecg-line" />
      {live && <Burst state={state} />}
      <span className="os-lanes">
        {LANES.map((lane, i) => (
          <i key={i}>
            <b style={{ "--n": lane.n } as React.CSSProperties}>
              {lane.runs.map((run, j) => <span key={j} className={`t-${run.tone}`}>{run.text}</span>)}
            </b>
          </i>
        ))}
      </span>
    </span>
  );
}

/**
 * The card's background with a transition: on a state change the old layer fades out while the new
 * one fades in beneath it, in coarse steps.
 */
function EcgStream({ state }: { state: LinkState }) {
  const shown = useRef(state);
  const [tr, setTr] = useState<{ id: number; from: LinkState | null }>({ id: 0, from: null });

  // Layout effect: the new state must never be painted un-wiped for even one frame.
  useLayoutEffect(() => {
    if (shown.current === state) return;
    const from = shown.current;
    shown.current = state;
    setTr((cur) => ({ id: cur.id + 1, from }));
    const timer = setTimeout(() => setTr((cur) => ({ ...cur, from: null })), transitionMs());
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <>
      {tr.from && <EcgLayer key={`out-${tr.id}`} state={tr.from} phase="out" live={false} />}
      <EcgLayer key={`in-${tr.id}`} state={state} phase={tr.from ? "in" : undefined} live />
    </>
  );
}

/**
 * Antenna-style strength bars: four steps that never sit still; all lit when connected, a low
 * flicker when lost. Heights come from CSS (`--h` nominal height, `--i` index).
 */
function SignalBars({ state }: { state: LinkState }) {
  const lit = state === "locked" ? 4 : state === "standby" ? 2 : state === "searching" ? 1 : 0;
  return (
    <span className={`os-bars os-bars-${state}`} aria-hidden="true">
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          className={n <= lit ? "on" : ""}
          style={{ "--h": `${n * 4 + 2}px`, "--i": n - 1 } as React.CSSProperties}
        />
      ))}
    </span>
  );
}

/**
 * Settings > Online Service, the "space" design: the launcher's own link is the "uplink", every
 * module with a server of its own a "satellite". The launcher connects and polls; this only draws
 * and owns every animation.
 */
export default function OnlineService(p: OnlineServiceProps) {
  const { uplink } = p;
  return (
    <div className="settings-tab os-tab">
      <section className={`os-card os-uplink os-card-${uplink.state}`}>
        <EcgStream state={uplink.state} />
        <SignalBeacon state={uplink.state} />
        <div className="os-uplink-text">
          <span className="os-eyebrow"><OrbitIcon className="os-eyebrow-icon" />{t("online_uplink", "Uplink")}</span>
          <span className="os-uplink-title">{uplink.label}</span>
          <span className="os-uplink-sub">{uplink.account}</span>
        </div>
        <SignalBars state={uplink.state} />
        <div className="os-actions">
          {p.canSignIn && (
            <button className="settings-secondary-btn" onClick={p.onSignIn}>
              {t("button_login", "Sign in")}
            </button>
          )}
          <button
            className={`os-refresh${p.refreshing ? " spinning" : ""}`}
            title={t("button_refresh", "Refresh")}
            aria-label={t("button_refresh", "Refresh")}
            disabled={p.refreshing}
            onClick={p.onRefresh}
          >
            <RefreshIcon />
          </button>
        </div>
      </section>

      {p.servers.length > 0 && (
        <span className="os-section-label">{t("online_satellites", "Game servers")}</span>
      )}
      {p.servers.map((svc) => (
        <section className={`os-card os-satellite os-card-${svc.state}`} key={svc.id}>
          <EcgStream state={svc.state} />
          <SignalBeacon state={svc.state} />
          {svc.icon && <img src={svc.icon} alt="" className="os-satellite-icon" />}
          <div className="os-uplink-text">
            <span className="os-uplink-title">{svc.name}</span>
            <span className="os-uplink-sub">{svc.label}</span>
          </div>
          <SignalBars state={svc.state} />
        </section>
      ))}

      {p.canManageProfile && (
        <button className="settings-secondary-btn os-profile-btn" onClick={p.onManageProfile}>
          <UserIcon className="os-profile-icon" />
          {t("button_manage_profile", "Manage profile")}
        </button>
      )}
    </div>
  );
}
