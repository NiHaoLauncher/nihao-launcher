// The Playtime modal of an instance: totals, an activity chart, the split by place and the lists of
// its worlds and servers. Entrance motion is pure CSS (`pt-*`), so "Interface animations" off stops it.
import { useEffect, useState } from "react";
import { t } from "@shared/components/Translate";
import { Modal } from "@shared/index";
import { useCallModule } from "@shared/modules";
import ClockIcon from "@shared/assets/icons/clock.svg?react";
import CubesIcon from "@shared/assets/icons/cubes.svg?react";
import GlobeIcon from "@shared/assets/icons/globe.svg?react";
import { ModpackProfile } from "./types";
import { formatPlaytime, formatLastPlayed } from "./helpers";

const WEEKS = 26;

/** Local `YYYY-MM-DD`, the key format of `play_stats.daily`. */
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Server names `track_location` can produce; older builds also stored mods' log lines, which this hides. */
const SERVER_NAME = /^[\w.-]+(:\d+)?$/;

/**
 * GitHub-style activity chart: one column per week (Monday first), one square per day, shaded by
 * that day's play time relative to the busiest day shown. Only days since `daily` was introduced
 * have data.
 */
function ActivityChart({ days }: { days: { d: Date; secs: number }[] }) {
  const max = Math.max(...days.map((x) => x.secs), 1);
  const level = (secs: number) => (secs <= 0 ? 0 : Math.min(4, Math.ceil((secs / max) * 4)));
  const months = days.filter((_, i) => i % 7 === 0).map(({ d }, w, all) => (w === 0 || all[w - 1].d.getMonth() !== d.getMonth() ? d.toLocaleString(undefined, { month: "short" }) : ""));
  return (
    <div className="pt-activity">
      <div className="pt-months">{months.map((m, i) => <span key={i}>{m}</span>)}</div>
      <div className="pt-grid">
        {days.map(({ d, secs }, i) => (
          <i
            key={d.getTime()}
            className={`pt-cell lv${secs < 0 ? "-future" : level(secs)}`}
            style={{ "--col": Math.floor(i / 7) } as React.CSSProperties}
            title={secs < 0 ? "" : `${d.toLocaleDateString()}: ${secs > 0 ? formatPlaytime(secs) : t("minecraft.launch.playtime_no_play", "no play")}`}
          />
        ))}
      </div>
      <div className="pt-scale">
        {t("minecraft.launch.playtime_less", "Less")}
        {[0, 1, 2, 3, 4].map((l) => <i key={l} className={`pt-cell lv${l}`} />)}
        {t("minecraft.launch.playtime_more", "More")}
      </div>
    </div>
  );
}

type Row = { key: string; title: string; sub: string; icon: string | null; secs: number };

export function PlaytimeModal({ name, profile, onClose }: { name: string; profile: ModpackProfile; onClose: () => void }) {
  const call_module = useCallModule();
  const stats = profile.play_stats;
  /** The instance's worlds and servers as the game lists them (with their icons). */
  const [targets, setTargets] = useState<{ worlds: { folder: string; icon: string | null }[]; servers: { name: string; ip: string; icon: string | null }[] } | null>(null);
  useEffect(() => {
    call_module("list_play_targets", { name }).then(setTargets).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const worlds = Object.entries(stats?.worlds ?? {});
  const servers = Object.entries(stats?.servers ?? {}).filter(([n]) => SERVER_NAME.test(n));
  const sum = (e: [string, number][]) => e.reduce((n, [, v]) => n + v, 0);
  const menu = stats?.menu_secs ?? 0;
  const total = Math.max(profile.play_secs, 1);
  const worldSecs = sum(worlds);
  const serverSecs = sum(servers);
  const untracked = Math.max(profile.play_secs - menu - worldSecs - serverSecs, 0);
  const pct = (secs: number) => `${Math.round((secs / total) * 100)}%`;

  const parts = [
    { key: "menu", label: t("minecraft.launch.playtime_menu", "Menu & loading"), secs: menu },
    { key: "world", label: t("minecraft.launch.playtime_singleplayer", "Singleplayer"), secs: worldSecs },
    { key: "server", label: t("minecraft.launch.playtime_multiplayer", "Multiplayer"), secs: serverSecs },
    { key: "untracked", label: t("minecraft.launch.playtime_untracked", "Not tracked"), secs: untracked },
  ].filter((p) => p.secs > 0);

  // The chart window: whole weeks ending with the current one, Monday first.
  const daily = stats?.daily ?? {};
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - (WEEKS - 1) * 7);
  const days = Array.from({ length: WEEKS * 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return { d, secs: d > today ? -1 : daily[dayKey(d)] ?? 0 };
  });
  const played = days.filter((x) => x.secs > 0);
  const best = Math.max(...played.map((x) => x.secs), 0);
  const average = played.length > 0 ? Math.round(sum(played.map((x): [string, number] => ["", x.secs])) / played.length) : 0;

  // Every world and server the game lists, plus played ones it no longer lists (deleted), most played first.
  const worldRows: Row[] = [...new Set([...(targets?.worlds.map((w) => w.folder) ?? []), ...Object.keys(stats?.worlds ?? {}).filter(Boolean)])].map((folder) => ({
    key: folder, title: folder, sub: t("minecraft.launch.playtime_world_sub", "Singleplayer"), icon: targets?.worlds.find((w) => w.folder === folder)?.icon ?? null, secs: stats?.worlds[folder] ?? 0,
  })).sort((a, b) => b.secs - a.secs);
  const unknownWorldSecs = stats?.worlds[""] ?? 0;
  if (unknownWorldSecs > 0) {
    worldRows.push({ key: "", title: t("minecraft.launch.playtime_unknown_world", "Unknown world"), sub: t("minecraft.launch.playtime_world_sub", "Singleplayer"), icon: null, secs: unknownWorldSecs });
  }
  const bare = (ip: string) => ip.replace(/:25565$/, "");
  const serverRows: Row[] = [...new Map([
    ...(targets?.servers ?? []).map((sv): [string, Omit<Row, "key" | "secs">] => [bare(sv.ip), { title: sv.name, sub: sv.ip, icon: sv.icon }]),
    ...servers.map(([ip]): [string, Omit<Row, "key" | "secs">] => [ip, { title: ip, sub: ip, icon: null }]),
  ]).entries()].map(([ip, v]) => ({ key: ip, ...v, secs: stats?.servers[ip] ?? 0 })).sort((a, b) => b.secs - a.secs);

  // Rows keep the list shape of the game's own world/server screens: icon, name, grey detail lines.
  const mcList = (title: string, icon: React.ReactNode, rows: Row[]) => rows.length > 0 && (
    <section className="mc-list pt-card">
      <h4>{icon}{title}</h4>
      {rows.map((r, i) => (
        <div key={r.key} className="mc-entry" style={{ "--i": i } as React.CSSProperties}>
          {r.icon ? <img src={r.icon} alt="" /> : <span className="mc-entry-noicon" />}
          <div className="mc-entry-text">
            <b title={r.title}>{r.title}</b>
            <span title={r.sub}>{r.sub}</span>
            <span className="mc-entry-time">{r.secs > 0 ? `${formatPlaytime(r.secs)} · ${pct(r.secs)}` : t("minecraft.launch.playtime_not_played", "Not played yet")}</span>
          </div>
        </div>
      ))}
    </section>
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t("minecraft.launch.playtime", "Playtime")}
      size="large"
      footerHint={t("minecraft.launch.playtime_hint", "Counted from the game log while you play.")}
      footer={<button className="btn-primary" onClick={onClose}>{t("minecraft.launch.crash_close", "Close")}</button>}
    >
      <div className="pt-layout">
        <div className="pt-main">
          <div className="pt-hero pt-card">
            <span className="pt-badge"><ClockIcon /></span>
            <div className="pt-hero-text">
              <b>{formatPlaytime(profile.play_secs)}</b>
              <small>{profile.last_played ? `${t("minecraft.launch.last_played", "Last played")}: ${formatLastPlayed(profile.last_played)}` : t("minecraft.launch.never", "Never")}</small>
            </div>
          </div>

          {played.length > 0 && (
            <div className="pt-stats">
              <div className="pt-stat"><b>{played.length}</b><small>{t("minecraft.launch.playtime_active_days", "Active days")}</small></div>
              <div className="pt-stat"><b>{formatPlaytime(best)}</b><small>{t("minecraft.launch.playtime_best_day", "Best day")}</small></div>
              <div className="pt-stat"><b>{formatPlaytime(average)}</b><small>{t("minecraft.launch.playtime_avg_day", "Per active day")}</small></div>
            </div>
          )}

          <section className="pt-card">
            <h4>{t("minecraft.launch.playtime_activity", "Activity")}</h4>
            <ActivityChart days={days} />
          </section>

          {parts.length > 0 ? (
            <section className="pt-card">
              <h4>{t("minecraft.launch.playtime_split", "Where the time went")}</h4>
              <div className="pt-bar">
                {parts.map((p) => <i key={p.key} className={`pt-seg-${p.key}`} style={{ width: pct(p.secs) }} title={`${p.label}: ${formatPlaytime(p.secs)}`} />)}
              </div>
              <ul className="pt-legend">
                {parts.map((p) => (
                  <li key={p.key}><i className={`pt-seg-${p.key}`} />{p.label}<b>{formatPlaytime(p.secs)}</b><small>{pct(p.secs)}</small></li>
                ))}
              </ul>
            </section>
          ) : (
            <p className="pt-empty">{t("minecraft.launch.playtime_empty", "Nothing to show yet: the breakdown fills in as you play.")}</p>
          )}
        </div>

        <div className="pt-side">
          {mcList(t("minecraft.launch.playtime_worlds", "Singleplayer worlds"), <CubesIcon />, worldRows)}
          {mcList(t("minecraft.launch.playtime_servers", "Servers"), <GlobeIcon />, serverRows)}
        </div>
      </div>
    </Modal>
  );
}
