// Small pieces of UI that several pages use.
import { useEffect, useState } from "react";
import { t } from "@shared/components/Translate";
import { useCallModule } from "@shared/modules";
import { useContentServices } from "../services";
import CloudIcon from "@shared/assets/icons/cloud-small.svg?react";
import CrownIcon from "@shared/assets/icons/crown.svg?react";
import ArchiveIcon from "@shared/assets/icons/archive.svg?react";
import { ModpackProfile } from "./types";
import { environmentTagLabels, MAX_VISIBLE_TAGS } from "./helpers";
import { useAssetIcon, loaderIconCache } from "./hooks";

export function LoaderLabel({ loader, label }: { loader: string; label?: string }) {
  const call_module = useCallModule();
  const id = loader.toLowerCase();
  const [url, setUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    let p = loaderIconCache.get(id);
    if (!p) {
      p = call_module("get_asset", { path: `minecraft/loaders/${id}.svg` })
        .then((res: any) => res?.url as string | undefined)
        .catch(() => undefined);
      loaderIconCache.set(id, p);
    }
    p.then(setUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <span className="loader-label">
      {url && <span className="loader-label-icon" style={{ maskImage: `url(${url})`, WebkitMaskImage: `url(${url})` }} />}
      {label ?? loader}
    </span>
  );
}

export function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M12 3.5l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6-4.4-4.2 6-.8L12 3.5Z" strokeLinejoin="round" />
    </svg>
  );
}

/** Logo of an online service (`ServiceInfo.id`, `ModpackSource.service`): `assets/minecraft/services/<id>.png`. */
export function ServiceLogo({ service, className, alt = service }: { service: string; className?: string; alt?: string }) {
  const url = useAssetIcon(`minecraft/services/${service}.png`);
  return url ? <img className={className} src={url} alt={alt} /> : null;
}

/** Display name of an online service (`ServiceInfo.name`); its id until the list has loaded. */
export function ServiceName({ service }: { service: string }) {
  const name = useContentServices().find((s) => s.id === service)?.name ?? service;
  return <>{name}</>;
}

/**
 * Top-left badge on a modpack tile marking a downloaded (Public) instance: a cloud, or a crown if
 * this account owns the pack (see `useOwnedPackIds`). No badge for plain custom instances, even
 * published ones.
 */
export function ModpackBadge({ profile, ownedIds, catalogIds }: { profile: ModpackProfile; ownedIds: Set<string>; catalogIds: Set<string> | null }) {
  if (!profile.downloaded) return null;
  // Gone from the server's catalog (and the catalog was fetched fine) → archived; works like online.
  if (profile.pack?.id && catalogIds && !catalogIds.has(profile.pack.id)) {
    return (
      <span className="modpack-tile-badge modpack-tile-badge-archived" title={t("minecraft.modpacks_list.badge_archived", "Archived — no longer on the server")}>
        <ArchiveIcon width={13} height={13} />
      </span>
    );
  }
  const owned = !!profile.pack?.id && ownedIds.has(profile.pack.id);
  return (
    <span
      className={`modpack-tile-badge${owned ? " modpack-tile-badge-owner" : ""}`}
      title={
        owned
          ? t("minecraft.modpacks_list.badge_owned", "You own this pack")
          : t("minecraft.modpacks_list.badge_public", "Downloaded from Public")
      }
    >
      {owned ? <CrownIcon width={13} height={13} /> : <CloudIcon width={13} height={13} />}
    </span>
  );
}

/** The header button that grows the console / content panel to the whole page and back. */
export function PanelExpandButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      className="client-log-close"
      onClick={onToggle}
      title={expanded ? t("minecraft.launch.panel_collapse", "Collapse") : t("minecraft.launch.panel_expand", "Expand to full page")}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {expanded
          ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
          : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
      </svg>
    </button>
  );
}

/**
 * Environment tag(s) first, then the service's categories (which may also carry loaders), capped with the
 * rest folded into a "+N" tag. Shared by the search row and the detail modal.
 */
export function BrowseTags({ environment, categories }: { environment: string[]; categories: string[] }) {
  const tags = [...environmentTagLabels(environment), ...categories];
  if (tags.length === 0) return null;
  const visible = tags.slice(0, MAX_VISIBLE_TAGS);
  const extra = tags.length - visible.length;
  return (
    <div className="modpack-browse-tags">
      {visible.map((tag, i) => (
        <span key={i} className="modpack-browse-tag">{tag}</span>
      ))}
      {extra > 0 && <span className="modpack-browse-tag modpack-browse-tag-more">+{extra}</span>}
    </div>
  );
}

/** Thin divider between an editable-fields block and an actions block within a category. */
export function SettingsDivider() {
  return <hr style={{ border: "none", borderTop: "1px solid var(--hr-color)", opacity: 0.25, margin: "16px 0" }} />;
}
