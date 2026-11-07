/**
 * The same pack is often published on several services. `mergeSamePacks` folds those into one entry
 * that remembers every service it is on, and `mergeVersions` does the same for the builds of such a
 * pack. There is no id shared between services, so things count as the same when they agree on
 * enough of: title, URL slug, author, version name.
 */
import type { BrowseHit, ModpackVersion } from "./services";

/** A result plus the same pack's results on the other services. Everything else is the freshest one's. */
export type MergedHit = BrowseHit & { also: BrowseHit[] };

/** Every result a merged one stands for, the one it shows first. */
export function membersOf(hit: MergedHit): BrowseHit[] {
  const { also, ...first } = hit;
  return [first, ...also];
}

/** When a result's data last changed, as a number to compare; the oldest if the service didn't say. */
function freshness(hit: BrowseHit): number {
  const time = hit.updated ? Date.parse(hit.updated) : NaN;
  return isNaN(time) ? -Infinity : time;
}

/** Lowercase letters and digits only: `"Prominence™ II: Hasturian Era"` -> `"prominence ii hasturian era"`. */
function normalize(text: string): string {
  return text
    .replace(/[™®©]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Same title plus the same slug or an author in common, or the same slug plus an author in common
 * (the title may differ in decoration). A title alone is not enough: namesakes are common ("Create+",
 * "One Block Horror"), and so is a slug alone.
 */
export function isSamePack(a: BrowseHit, b: BrowseHit): boolean {
  if (a.service === b.service) return false;
  const title = normalize(a.title) !== "" && normalize(a.title) === normalize(b.title);
  const slug = a.slug !== "" && a.slug === b.slug;
  const names = new Set(a.authors.map(normalize));
  const author = b.authors.some((name) => names.has(normalize(name)));
  return (title && (slug || author)) || (slug && author);
}

/**
 * Keeps the order of `hits` (a pack stays where its first result was); a result that is the same
 * pack as an earlier one from another service joins it instead of appearing again. The service
 * whose data is freshest (it often differs: one checks updates sooner) is the one the entry shows,
 * and what it lacks (pictures) is filled in from the others. Only results in `hits` are compared, so
 * a pack on page 1 of one service and page 3 of another isn't found.
 */
export function mergeSamePacks(hits: BrowseHit[]): MergedHit[] {
  const groups: BrowseHit[][] = [];
  for (const hit of hits) {
    const group = groups.find((g) => g.every((m) => m.service !== hit.service) && g.some((m) => isSamePack(m, hit)));
    if (group) group.push(hit);
    else groups.push([hit]);
  }
  return groups.map((group) => {
    const best = group.reduce((a, b) => (freshness(b) > freshness(a) ? b : a));
    const others = group.filter((m) => m !== best);
    return {
      ...best,
      gallery: best.gallery.length > 0 ? best.gallery : others.find((m) => m.gallery.length > 0)?.gallery ?? [],
      icon_url: best.icon_url ?? others.find((m) => m.icon_url)?.icon_url,
      also: others,
    };
  });
}

/** A pack on one service: where to ask for its builds. */
export interface PackRef {
  service: string;
  projectId: string;
}

/** One build of a pack, and which service's copy of the pack it came from. */
export interface VersionSource extends PackRef {
  version: ModpackVersion;
}

const words = (text: string) => normalize(text).split(" ").filter(Boolean);

/** Every name a build goes by (Modrinth's name/number, CurseForge's display name/file name), without a `v` before the number. */
function labels(version: ModpackVersion): string[] {
  return [version.name, version.version_number].map((n) => normalize(n).replace(/\bv(?=\d)/g, "")).filter(Boolean);
}

/**
 * `"cobbleverse 1 7 42"` and `"cobbleverse 1 7 42 cf"`: the longer is the shorter with words
 * without digits added at either end. In order, so `"pack 1 8"` is not `"pack 1 8 1"`.
 */
function isTagged(a: string, b: string): boolean {
  const [short, long] = words(a).length <= words(b).length ? [words(a), words(b)] : [words(b), words(a)];
  const noDigits = (list: string[]) => list.every((w) => !/\d/.test(w));
  const text = short.join(" ");
  const atStart = long.slice(0, short.length).join(" ") === text && noDigits(long.slice(short.length));
  const atEnd = long.slice(long.length - short.length).join(" ") === text && noDigits(long.slice(0, long.length - short.length));
  return short.some((w) => /\d/.test(w)) && (atStart || atEnd);
}

/** The same name, or (`fuzzy`) the same but for a platform tag the other service added. */
function isSameVersion(a: ModpackVersion, b: ModpackVersion, fuzzy: boolean): boolean {
  if (!fuzzy) return labels(a).some((x) => labels(b).includes(x));
  return labels(a).some((x) => labels(b).some((y) => isTagged(x, y)));
}

/**
 * The builds of one pack on several services as one list, newest first. A build that is on more
 * than one service (same name, or the name plus a platform tag like `[CF]`) is one row listing each
 * service's copy, the first list's copy first: pass the preferred service's builds first.
 */
export function mergeVersions(lists: VersionSource[][]): VersionSource[][] {
  const rows: VersionSource[][] = [];
  for (const list of lists) {
    // Exact name matches first, so a loose match never takes a build that has an exact twin.
    let pending = list;
    for (const fuzzy of [false, true]) {
      pending = pending.filter((source) => {
        const row = rows.find((r) => r.every((m) => m.service !== source.service) && r.some((m) => isSameVersion(m.version, source.version, fuzzy)));
        row?.push(source);
        return !row;
      });
    }
    // Only now: builds of one service never merge with each other.
    rows.push(...pending.map((source) => [source]));
  }
  const published = (row: VersionSource[]) => Math.max(...row.map((s) => Date.parse(s.version.date_published) || 0));
  return rows.sort((a, b) => published(b) - published(a));
}
