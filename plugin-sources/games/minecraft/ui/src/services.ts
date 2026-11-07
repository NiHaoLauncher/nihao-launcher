/**
 * Online content services (Modrinth, ...) as the UI sees them. Everything about a service comes
 * from the backend (`list_content_services`), so a new service needs no change here: write it in
 * `library/services/` on the Rust side and drop its logo at `assets/minecraft/services/<id>.png`.
 *
 * `useContentServices()` lists them; `useServiceClient(id)` (or `createServiceClient` for several
 * at once) talks to one.
 */
import { useEffect, useMemo, useState } from "react";
import { useCallModule } from "@shared/modules";

type CallModule = ReturnType<typeof useCallModule>;

/** `ServiceInfo` in `library/services/mod.rs`. */
export interface ServiceInfo {
  id: string;
  name: string;
  /** Instance-content categories it can browse and install (`mods`, `resourcepacks`, ...). */
  content: string[];
  /** Whether it hosts whole modpacks (the Modpack market). */
  modpacks: boolean;
  /** Sort ids it accepts besides the default relevance. */
  sorts: string[];
  /** Environment filter values it accepts; empty = no such filter. */
  environments: string[];
  /** Why it can't be used right now (e.g. a missing API key); show it disabled with this as the hint. */
  unavailable?: string | null;
}

/**
 * A search result. Icons and gallery images are plain CDN URLs the webview loads directly (not
 * base64): these results are ephemeral.
 */
export interface BrowseHit {
  /** The service it came from, added by the client. */
  service: string;
  project_id: string;
  title: string;
  description: string;
  icon_url?: string;
  /** Gallery images of the project (may be empty). */
  gallery: string[];
  downloads: number;
  author: string;
  /** Every author, `author` first. */
  authors: string[];
  /** The service's short name for the project; empty if none. */
  slug: string;
  /** The project's page on the service's own site. */
  url: string;
  environment: string[];
  categories: string[];
  /** When it last changed (RFC 3339). */
  updated?: string;
  /** Minecraft versions it supports, in no particular order. */
  game_versions: string[];
  /** Lowercase loader names it supports. */
  loaders: string[];
}

/** The full project page for the detail view. */
export interface ProjectDetail {
  project_id: string;
  title: string;
  description: string;
  /** Raw Markdown from a third party: render it with the safe renderer, never as HTML. */
  body: string;
  /** The project's page on the service's own site. */
  url: string;
  icon_url?: string;
  downloads: number;
  followers: number;
  categories: string[];
  environment: string[];
  license_name?: string;
  license_url?: string;
  source_url?: string;
  issues_url?: string;
  wiki_url?: string;
  discord_url?: string;
  /** `url` is a downscaled copy (thumbnails, banners); `full_url` the original, when the service has one. */
  gallery: { url: string; full_url?: string; title?: string }[];
}

export interface ModpackVersion {
  id: string;
  name: string;
  version_number: string;
  version_type: "release" | "beta" | "alpha";
  game_versions: string[];
  loaders: string[];
  date_published: string;
  downloads: number;
}

export interface SearchResult {
  hits: BrowseHit[];
  totalHits: number;
}

/** Filters shared by both searches; each list is OR'd within itself. */
interface SearchFilters {
  query: string;
  offset: number;
  limit: number;
  sort: string;
  categories: string[];
  environments: string[];
}

/** Key of a project across services, for "is it installed" sets (ids are only unique per service). */
export function installedKey(service: string, projectId: string): string {
  return `${service}:${projectId}`;
}

/** The backend commands of one service, with its id filled in. */
export function createServiceClient(call_module: CallModule, service: string) {
  const toResult = (res: any): SearchResult => ({
    hits: Array.isArray(res?.hits) ? res.hits.map((h: Omit<BrowseHit, "service">) => ({ ...h, service })) : [],
    totalHits: typeof res?.total_hits === "number" ? res.total_hits : 0,
  });
  const list = (res: any): any[] => (Array.isArray(res) ? res : []);

  return {
    id: service,
    /** Scoped to the instance `name`'s game version and loader. */
    searchContent: (args: SearchFilters & { name: string; category: string }): Promise<SearchResult> =>
      call_module("search_content", { service, ...args }).then(toResult),
    /** For the market, where there is no instance yet: version and loaders are picked by the player. */
    searchModpacks: (args: SearchFilters & { minecraft_version: string; loaders: string[] }): Promise<SearchResult> =>
      call_module("search_modpacks", { service, ...args }).then(toResult),
    categories: (category: string): Promise<string[]> =>
      call_module("list_content_categories", { service, category }).then(list),
    project: (projectId: string): Promise<ProjectDetail> =>
      call_module("get_content_project", { service, project_id: projectId }),
    /** Starts the background install; resolves with the job label to hand to `waitForBackgroundJob`. */
    install: (args: { name: string; category: string; projectId: string; title: string }): Promise<string> =>
      call_module("install_content", {
        service, name: args.name, category: args.category, project_id: args.projectId, title: args.title,
      }).then((res) => String(res?.job ?? args.title)),
    modpackVersions: (projectId: string): Promise<ModpackVersion[]> =>
      call_module("list_modpack_versions", { service, project_id: projectId }).then(list),
    /** Downloads one build to a temp file and resolves with its path. */
    downloadModpack: (projectId: string, versionId: string): Promise<string> =>
      call_module("download_modpack", { service, project_id: projectId, version_id: versionId }).then(String),
  };
}

export type ServiceClient = ReturnType<typeof createServiceClient>;

export function useServiceClient(service: string): ServiceClient {
  const call_module = useCallModule();
  return useMemo(() => createServiceClient(call_module, service), [call_module, service]);
}

// One request for the whole UI: the list can't change while the plugin is loaded.
let servicesRequest: Promise<ServiceInfo[]> | null = null;

/** Every service the backend offers, in display order; empty until loaded (or if that failed). */
export function useContentServices(): ServiceInfo[] {
  const call_module = useCallModule();
  const [services, setServices] = useState<ServiceInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    servicesRequest ??= call_module("list_content_services").then((res) => (Array.isArray(res) ? res : []));
    servicesRequest
      .then((list) => { if (!cancelled) setServices(list); })
      .catch((e) => { servicesRequest = null; console.error(e); });
    return () => { cancelled = true; };
  }, [call_module]);

  return services;
}

/** Merges lists round-robin (every list's first, then every second, ...), so one service's results don't bury the others'. */
export function interleave<T>(lists: T[][]): T[] {
  const merged: T[] = [];
  for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) {
    for (const list of lists) if (i < list.length) merged.push(list[i]);
  }
  return merged;
}
