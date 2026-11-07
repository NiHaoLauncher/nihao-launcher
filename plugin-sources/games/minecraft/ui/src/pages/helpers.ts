// Small pure helpers shared by the pages: sizes, counts, names, background jobs.
import { ModpackProfile } from "./types";

/**
 * An instance tied to an online service (ours, Modrinth or CurseForge): its name, icon, banner and
 * content follow the service, so they can only be viewed until it is detached.
 */
export function isManaged(profile: ModpackProfile): boolean {
  return profile.downloaded || !!profile.source;
}

/**
 * Loader name preceded by its icon. `loader` is case-insensitive; `label` defaults to the id. The
 * icon is a CSS mask so it follows the text colour (`currentColor` SVGs would render black in an
 * <img>).
 */
/** "1 h 5 min" / "12 min" / "< 1 min" / "—" for a play time in seconds. */
export function formatPlaytime(secs: number): string {
  if (!secs) return "—";
  const min = Math.floor(secs / 60);
  if (min < 1) return "< 1 min";
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Overall install progress 0-100 across every etap (same formula as the launcher's bottom bar). */
export function overallPercent(p: any): number {
  if (!(p?.total_etaps > 0)) return 0;
  const etap = p.total_files > 0 ? p.current_file / p.total_files : p.status === "extract" || p.status === "skip" ? 1 : 0.3;
  const overall = (Math.max(0, p.current_etaps - 1) + Math.min(1, Math.max(0, etap))) / p.total_etaps;
  return Math.max(0, Math.min(100, Math.round(overall * 100)));
}

/**
 * Several commands start a background job and return at once (export, import, service installs);
 * the shared `get_install_status` tracks each under `label`. Polls until the entry disappears,
 * returning the failure message if `lastError` names this job, else `null`. `onProgress` gets the job's
 * entry on every poll while it runs.
 */
export async function waitForBackgroundJob(call_module: (method: string, args?: any) => Promise<any>, label: string, onProgress?: (entry: any) => void): Promise<string | null> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const res: any = await call_module("get_install_status", {});
    const entry = Array.isArray(res?.installing) ? res.installing.find((p: any) => p?.name === label) : undefined;
    if (entry) {
      onProgress?.(entry);
      continue;
    }
    if (res?.lastError?.name === label) return String(res.lastError.error ?? "Job failed.");
    return null;
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** `1234` -> `"1.2K"`, `2600000` -> `"2.6M"`, for download counts. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  const units = ["K", "M", "B"];
  let value = n / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)}${units[unit]}`;
}

/** `"client_only_server_optional"` -> `"client only server optional"` — `text-transform:
 *  capitalize` in CSS handles the rest. */
export function formatEnvironmentValue(v: string): string {
  return v.replace(/_/g, " ");
}

/**
 * A hit's `environment` lists every environment any version supports; this formats each and drops
 * `"unknown"`.
 */
export function environmentTagLabels(environment: string[]): string[] {
  return environment.filter((v) => v && v !== "unknown").map(formatEnvironmentValue);
}

export const MAX_VISIBLE_TAGS = 5;

/** Builds a compact page-number list with `"..."` gap markers, e.g. `[1, "...", 6, 7, 8, "...", 994]` —
 *  always keeps the first/last page and a small window around the current one visible. */
export function getPageNumbers(current: number, total: number): (number | "...")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages: (number | "...")[] = [1];
  if (current > 3) pages.push("...");
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let i = start; i <= end; i++) pages.push(i);
  if (current < total - 2) pages.push("...");
  pages.push(total);
  return pages;
}

/** The game's own join line (`Connecting to host, port`); mods log other "Connecting to ..." lines. */
export const JOINING_SERVER = /Connecting to [^\s,]+, \d+\s*$/;

/** "5 minutes ago" / "3 hours ago" / "2 days ago", and the plain date from 7 days on. */
export function formatLastPlayed(unixSecs: number): string {
  const secs = Math.max(0, Date.now() / 1000 - unixSecs);
  const ago = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (secs < 60) return ago.format(0, "second");
  if (secs < 3600) return ago.format(-Math.floor(secs / 60), "minute");
  if (secs < 86400) return ago.format(-Math.floor(secs / 3600), "hour");
  if (secs < 7 * 86400) return ago.format(-Math.floor(secs / 86400), "day");
  return new Date(unixSecs * 1000).toLocaleDateString();
}
