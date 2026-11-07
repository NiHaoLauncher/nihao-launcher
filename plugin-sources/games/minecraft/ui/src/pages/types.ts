// Shapes of the data the Minecraft module's pages pass around.
import { useCallModule } from "@shared/modules";

/** Loaders that have a separate build/version number to pick beyond the game version. */
export const LOADERS_WITH_BUILD_VERSION = ["fabric", "neoforge"];

export interface ModpackProfile {
  display_name: string;
  version_id: string;
  core: "VANILLA" | "FABRIC" | "NEOFORGE" | "FORGE";
  loader_version: string | null;
  max_ram: number;
  min_ram: number;
  use_custom_ram: boolean;
  java_path: string | null;
  jvm_arguments: string;
  icon: string | null;
  banner: string | null;
  /**
   * Set once this instance tracks a published pack (see MODPACK_FORMAT.md); `id` is matched
   * against a "Public" tab entry's `id` to know it is installed.
   */
  pack: { id: string; name: string; build: number } | null;
  /**
   * `true` only for an instance installed via the "Public" tab's Download (unlike `pack !== null`,
   * also true for a local instance its owner later published). Drives the Custom/Public tab and
   * hides local-only General settings and the Content manager.
   */
  downloaded: boolean;
  /** Seconds the game has run from this instance. */
  play_secs: number;
  /** `play_secs` split by place (`PlayStats`); older sessions are not in it, so it can sum to less. */
  play_stats?: { menu_secs: number; worlds: Record<string, number>; servers: Record<string, number>; daily?: Record<string, number> };
  /** Unix seconds of the last launch, `null` if never launched. */
  last_played: number | null;
  /** Set when downloaded from a third-party service (see `services.ts`): the project/build it is tied to. */
  source: ModpackSource | null;
  /** Files the pack needs that have to be downloaded by hand (see `MissingFilesModal`). */
  missing_files?: MissingFile[];
}

/** A file `check_missing_files` took from the Downloads folder (`DownloadedCopy` in `missing_files.rs`). */
export type DownloadedCopy = { file: string; path: string };

/** `BlockedFile` in `library/services/mod.rs`. */
export interface MissingFile {
  /** Relative to the instance (e.g. `mods/a.jar`). */
  path: string;
  sha1: string;
  name: string;
  /** The file's page on the service. */
  page_url: string;
}

export type ModpackSource = {
  /** `ServiceInfo.id` */
  service: string;
  project_id: string;
  version_id: string;
  version_number: string;
  name: string;
  icon_url?: string;
  url?: string;
};

export interface ModpackEntry {
  name: string;
  profile: ModpackProfile;
  icon_data: string | null;
  banner_data: string | null;
  /** The instance's `mods/` holds the NiHao Client mod. */
  nihao_client?: boolean;
}

/**
 * Result of `peek_modpack_file`: a picked .zip/.mrpack parsed without extracting, for the "Install
 * modpack" preview. `format === "raw"` is a plain .zip with no manifest:
 * `minecraft_version`/`loader` come back empty and the confirm screen lets the player fill them
 * in.
 */
export interface ImportPreview {
  format: "own" | "full" | "mrpack" | "curseforge" | "raw";
  name: string;
  minecraft_version: string;
  loader: string;
  loader_version: string | null;
}

export interface ScreenshotEntry {
  instance: string;
  file: string;
  modified: number;
}

export type PlayingStatus = "menu" | "singleplayer" | "multiplayer";

export interface TileMenuTarget {
  name: string;
  profile: ModpackProfile;
  icon_data: string | null;
  banner_data: string | null;
}

export interface OfflineProfile {
  id: string;
  name: string;
  // "offline", "elyby" (signed in with `login_elyby`) or "microsoft" (reserved), same as Rust's
  // `OfflineProfile::service`.
  service: string;
  // Lets this flow through `call_module`'s `Value`-typed args without a cast.
  [key: string]: string;
}

export type CallModuleFn = ReturnType<typeof useCallModule>;

export interface ProfilesResponse {
  profiles: OfflineProfile[];
  defaultProfileId: string | null;
}

export interface OnlineModpack {
  id: string;
  name: string;
  visibility: "public" | "invite";
  latest_build: number;
  is_owner: boolean;
  icon_data_uri?: string | null;
  banner_data_uri?: string | null;
}

export interface PlayTarget {
  kind: "world" | "server";
  value: string;
}

export interface ExportEntry {
  name: string;
  is_dir: boolean;
  /** Bytes: the file's own, or everything inside a folder. */
  size: number;
}

/**
 * Result of `list_content`: every mod/resourcepack/shaderpack/datapack in the instance.
 * Names/versions/icons come from file metadata and/or an online-service hash lookup, cached on the
 * Rust side (`content_cache.rs`). `enabled` only matters for mods (`*.jar.disabled`).
 */
interface ContentEntry {
  name: string;
  size: number;
  is_dir: boolean;
  enabled: boolean;
  display_name?: string;
  version?: string;
  icon_data?: string;
  /** Set together with `service` when an online lookup recognised the file. */
  project_id?: string;
  service?: string;
}

export interface ContentLists {
  mods: ContentEntry[];
  resourcepacks: ContentEntry[];
  shaderpacks: ContentEntry[];
  datapacks: ContentEntry[];
}

export type ContentCategory = "mods" | "resourcepacks" | "shaderpacks" | "datapacks";

export type SettingsCategory = "general" | "install" | "publish";
