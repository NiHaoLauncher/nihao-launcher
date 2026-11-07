// The modpack market: browsing, trending, a pack's page and its versions.
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { open as openExternalUrl } from "@tauri-apps/api/shell";
import { t } from "@shared/components/Translate";
import { Modal } from "@shared/index";
import { useCallModule } from "@shared/modules";
import { useBridge, animationsOff } from "@shared";
import PACKAGE from "@shared/assets/package.png";
import { membersOf, mergeSamePacks, mergeVersions } from "../duplicates";
import type { MergedHit, PackRef, VersionSource } from "../duplicates";
import { createServiceClient, installedKey, interleave, useContentServices, useServiceClient } from "../services";
import type { BrowseHit, ModpackVersion, ProjectDetail, SearchResult, ServiceClient } from "../services";
import FileIcon from "@shared/assets/icons/file.svg?react";
import DownloadIcon from "@shared/assets/icons/download.svg?react";
import ExternalLinkIcon from "@shared/assets/icons/external-link.svg?react";
import CopyIcon from "@shared/assets/icons/copy.svg?react";
import CubesIcon from "@shared/assets/icons/cubes.svg?react";
import SearchIcon from "@shared/assets/icons/search.svg?react";
import ChevronDownIcon from "@shared/assets/icons/chevron-down.svg?react";
import SlidersIcon from "@shared/assets/icons/sliders.svg?react";
import { ModpackSource } from "./types";
import { formatCount } from "./helpers";
import { useBackgroundImage, useDismiss, useOnScreen } from "./hooks";
import { LoaderLabel, ServiceLogo, BrowseTags } from "./components";
import { ViewerArrows, GalleryImageMenu, ZoomableImage } from "./imageViewer";
import { FilterSection, SortFilter, EnvironmentFilter, CategoryFilter, Pager } from "./browse";
import { renderMarkdownBody } from "./markdown";

/**
 * Modrinth's `categories` also carry loaders, but Browse's filter gets a dedicated Loaders
 * section. Matches `LOADERS` in index.tsx minus "vanilla", which isn't a modpack category.
 */
const MODPACK_LOADER_VALUES = ["fabric", "forge", "neoforge"];

/**
 * Every build of a pack, newest first, from each service it is on (`sources`, the preferred service
 * first); a build several services publish is one row with each service's logo. Clicking a row
 * installs it from the first service, a logo installs it from that service. A service that fails
 * to answer shows its error above the others' builds. `explicit` makes the row plain text with an
 * Install button instead (a pack's page lists builds; installing one should be a deliberate click).
 */
function ModpackVersionList({ sources, onChoose, explicit }: { sources: PackRef[]; onChoose: (source: VersionSource) => Promise<void>; explicit?: boolean }) {
  const call_module = useCallModule();
  const services = useContentServices();
  const [rows, setRows] = useState<VersionSource[][] | null>(null);
  /** `service:version id` of the build being installed. */
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourcesKey = sources.map((s) => `${s.service}:${s.projectId}`).join();
  const nameOf = (service: string) => services.find((s) => s.id === service)?.name ?? service;
  const buildKey = (s: VersionSource) => `${s.service}:${s.version.id}`;

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    Promise.allSettled(sources.map(async (s): Promise<VersionSource[]> => {
      const versions = await createServiceClient(call_module, s.service).modpackVersions(s.projectId);
      return versions.map((version) => ({ ...s, version }));
    })).then((answers) => {
      if (cancelled) return;
      setRows(mergeVersions(answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []))));
      const failed = answers.flatMap((a) => (a.status === "rejected" ? [String(a.reason)] : []));
      if (failed.length > 0) setError(failed.join("\n"));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesKey]);

  async function choose(source: VersionSource) {
    setPicking(buildKey(source));
    setError(null);
    try {
      await onChoose(source);
    } catch (e) {
      setError(String(e));
    } finally {
      setPicking(null);
    }
  }

  return (
    <div className="option-container">
      {error && <p className="modpack-error">{error}</p>}
      {!rows && <p className="modpack-option-hint">{t("minecraft.create_modpack.loading_versions", "Loading versions...")}</p>}
      <div className="modpack-version-list">
        {rows?.map((row) => {
          const v = row[0].version;
          return (
            <div key={row.map(buildKey).join("|")} className={`modpack-version-row${picking !== null ? " busy" : ""}${explicit ? " explicit" : ""}`}>
              <button type="button" className="modpack-version-pick" disabled={picking !== null || explicit} onClick={() => choose(row[0])}>
                <span className="modpack-version-main">
                  <strong>{v.version_number}</strong>
                  <span className={`modpack-version-type ${v.version_type}`}>{v.version_type}</span>
                  <small>{v.name !== v.version_number ? v.name : ""}</small>
                </span>
                <span className="modpack-version-meta">
                  {[v.game_versions[v.game_versions.length - 1], v.loaders.join(", "), new Date(v.date_published).toLocaleDateString()].filter(Boolean).join(" · ")}
                  {row.some((s) => buildKey(s) === picking) ? ` · ${t("minecraft.create_modpack.downloading", "Downloading...")}` : ""}
                </span>
              </button>
              {explicit && sources.length <= 1 && (
                <button type="button" className="modpack-version-install" disabled={picking !== null} onClick={() => choose(row[0])}>
                  <DownloadIcon width={14} height={14} /> {t("minecraft.content_manager.install", "Install")}
                </button>
              )}
              {sources.length > 1 && (
                <span className="modpack-version-sources">
                  {row.map((s) => (
                    <button
                      key={s.service}
                      type="button"
                      className="modpack-version-source"
                      disabled={picking !== null}
                      title={t("minecraft.market.install_from", "Install from {service}").replace("{service}", nameOf(s.service))}
                      onClick={() => choose(s)}
                    >
                      <ServiceLogo service={s.service} alt={nameOf(s.service)} />
                    </button>
                  ))}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Version picker shown before installing a modpack from the online services (not ours). */
export function ModpackVersionsModal({
  sources, title, onClose, onChoose,
}: {
  sources: PackRef[];
  title: string;
  onClose: () => void;
  onChoose: (source: VersionSource) => Promise<void>;
}) {
  return (
    <Modal isOpen onClose={onClose} title={`${title} — ${t("minecraft.create_modpack.pick_version", "Choose a version")}`} size="medium">
      <ModpackVersionList sources={sources} onChoose={onChoose} />
    </Modal>
  );
}

/** Downloads + imports one build of a service's modpack as a new instance (binding it to the project). */
async function installMarketModpack(
  call_module: ReturnType<typeof useCallModule>,
  client: ServiceClient,
  pack: { project_id: string; title: string; icon_url?: string; banner_url?: string; url?: string },
  v: ModpackVersion,
) {
  const sourcePath = await client.downloadModpack(pack.project_id, v.id);
  const preview: any = await call_module("peek_modpack_file", { source_path: sourcePath });
  if (!preview?.name || preview.format === "raw") throw new Error("This pack has no manifest, so it can't be installed from the market.");
  const source: ModpackSource = { service: client.id, project_id: pack.project_id, version_id: v.id, version_number: v.version_number, name: pack.title, icon_url: pack.icon_url, url: pack.url };
  await call_module("import_modpack", { name: String(preview.name).trim(), source_path: sourcePath, minecraft_version: null, loader: null, loader_version: null, icon_url: pack.icon_url ?? null, banner_url: pack.banner_url ?? null, source });
}

/**
 * News-style "Trending" block: one big featured pack (its gallery crossfading behind the text) and
 * a column of the others. The featured pack advances by itself, in order, and the active item's
 * background fills up as the time it has left; that countdown (not the gallery slideshow) freezes
 * while the pointer is over the block, and clicking an item jumps to it.
 */
function TrendingPanel({ hits, serviceNames, onPick, onMenu }: {
  hits: MergedHit[];
  serviceNames: Record<string, string>;
  onPick: (hit: MergedHit) => void;
  onMenu: (x: number, y: number, hit: MergedHit) => void;
}) {
  const [index, setIndex] = useState(0);
  const [slide, setSlide] = useState(0);
  const [paused, setPaused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const hit = hits[Math.min(index, hits.length - 1)];
  const images = hit.gallery.length > 0 ? hit.gallery : hit.icon_url ? [hit.icon_url] : [];

  useEffect(() => setSlide(0), [index]);
  // The list is as tall as the big panel and scrolls: keep the active item centred in it, without
  // scrolling the page itself (which `scrollIntoView` would).
  useEffect(() => {
    const list = listRef.current;
    const item = list?.children[index] as HTMLElement | undefined;
    if (!list || !item) return;
    list.scrollTo({
      top: item.offsetTop - (list.clientHeight - item.offsetHeight) / 2,
      left: item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2,
      behavior: "smooth",
    });
  }, [index]);
  useEffect(() => {
    if (images.length < 2) return;
    const id = setInterval(() => setSlide((n) => (n + 1) % images.length), 2800);
    return () => clearInterval(id);
  }, [index, images.length]);

  return (
    <div>
      <h2 className="market-heading">
        <svg className="market-flame" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path fill="#ff7a18" d="M12 2c1 3.500-.500 5-2 7-1.500 2-3 3.800-3 6.500A5 5 0 0 0 12 21a5 5 0 0 0 5-5.500c0-2.500-1.200-4-2.500-5.300.100 1.500-.500 2.500-1.500 3C13.500 10 13.500 5 12 2z" />
          <path className="market-flame-core" fill="#ffd23f" d="M12 21a3 3 0 0 0 3-3c0-1.600-1-2.600-2-3.800-.3 1-.9 1.600-1.600 2.300C10.500 17 9 16.900 9 18a3 3 0 0 0 3 3z" />
        </svg>
        {t("minecraft.market.trending", "Trending")}
      </h2>
      <section className={`market-trending${paused ? " paused" : ""}`} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
        <div
          className="market-feature"
          onClick={() => onPick(hit)}
          onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY, hit); }}
        >
          {images.map((url, i) => (
            <img
              key={`${hit.project_id}-${url}`}
              className={`market-feature-bg${hit.gallery.length > 0 ? " photo" : ""}${i === slide ? " shown" : ""}`}
              src={url}
              alt=""
            />
          ))}
          <div className="market-feature-body">
            <span className="market-feature-kicker market-feature-service">
              {[hit, ...hit.also].map((m) => (
                <span key={m.service} className="market-feature-service-item">
                  <ServiceLogo service={m.service} className="market-service-logo" alt="" />
                  {serviceNames[m.service] ?? m.service}
                </span>
              ))}
            </span>
            <h2>{hit.title}</h2>
            <p>{hit.description}</p>
            <div className="market-feature-foot">
              <button className="modpack-browse-install" onClick={(e) => { e.stopPropagation(); onPick(hit); }}>
                {t("minecraft.market.view", "View modpack")}
              </button>
              <span className="modpack-browse-downloads"><DownloadIcon width={12} height={12} /> {formatCount(hit.downloads)}</span>
            </div>
          </div>
        </div>
        <div className="market-trending-list">
          <div className="market-trending-scroll" ref={listRef}>
            {hits.map((h, i) => (
              <button
                key={installedKey(h.service, h.project_id)}
                className={`market-trending-item${i === index ? " active" : ""}`}
                onClick={() => setIndex(i)}
                onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY, h); }}
                title={h.title}
              >
                {i === index && hits.length > 1 && <i className="market-trending-fill" onAnimationEnd={() => setIndex((n) => (n + 1) % hits.length)} />}
                {h.icon_url ? <img src={h.icon_url} alt="" /> : <span className="market-trending-noicon" />}
                <span className="market-trending-title">{h.title}</span>
                <span className="market-trending-services">
                  {[h, ...h.also].map((m) => (
                    <ServiceLogo key={m.service} service={m.service} className="market-service-logo market-trending-service" alt={serviceNames[m.service] ?? m.service} />
                  ))}
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * One service modpack's page (route `/market/:service/:projectId`): a banner with the Install button, then
 * Description / Gallery / Versions tabs next to a side card with the facts (downloads, followers,
 * environment, categories, links, license). Opened from a pack that is on several services, it
 * shows the service picked for it (the one with the freshest data) and lists the builds of all of
 * them (`state.members`).
 */
type DetailSection = "about" | "gallery" | "versions";

/** The narrowest a panel of the pack's page is allowed to get before there are fewer of them. */
const PANEL_MIN_WIDTH = 520;
/** The page's own side padding, which its panels do not get. */
const PAGE_PADDING = 40;

export function ModpackMarketDetailPage() {
  const call_module = useCallModule();
  const navigate = useNavigate();
  const { service = "", projectId = "" } = useParams();
  const client = useServiceClient(service);
  const serviceNames: Record<string, string> = Object.fromEntries(useContentServices().map((s) => [s.id, s.name]));
  /** The same pack on the other services, when the market found it there too. */
  const others = ((useLocation().state as { members?: BrowseHit[] } | null)?.members ?? []).filter((m) => m.service !== service);
  /** Where to ask for builds: this service's pack first, then the others'. */
  const sources: PackRef[] = [{ service, projectId }, ...others.map((m) => ({ service: m.service, projectId: m.project_id }))];
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailSection>("about");
  const [picking, setPicking] = useState(false);
  const [shotIndex, setShotIndex] = useState<number | null>(null);
  const [imageMenu, setImageMenu] = useState<{ x: number; y: number; url: string } | null>(null);
  const [slide, setSlide] = useState(0);
  const bannerImages = (detail?.gallery ?? []).slice(0, 6);

  useEffect(() => {
    if (bannerImages.length < 2) return;
    const id = setInterval(() => setSlide((n) => (n + 1) % bannerImages.length), 4000);
    return () => clearInterval(id);
  }, [bannerImages.length]);

  useEffect(() => {
    setDetail(null);
    client.project(projectId)
      .then(setDetail)
      .catch((e: any) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, projectId]);

  const install = async (source: VersionSource) => {
    if (!detail) return;
    // Images are only fetched from their own service's CDN, so take those of the service installed from.
    const first = detail.gallery[0];
    const same = source.service === service;
    const other = others.find((m) => m.service === source.service);
    const icon_url = same ? detail.icon_url : other?.icon_url;
    const banner_url = same ? first?.full_url ?? first?.url : other?.gallery[0];
    await installMarketModpack(call_module, createServiceClient(call_module, source.service), { project_id: source.projectId, title: detail.title, icon_url, banner_url, url: same ? detail.url : other?.url }, source.version);
    navigate("/");
  };

  const links: [string, string | undefined][] = detail ? [
    [serviceNames[service] ?? service, detail.url],
    ...others.map((m): [string, string | undefined] => [serviceNames[m.service] ?? m.service, m.url]),
    [t("minecraft.market.link_source", "Source"), detail.source_url],
    [t("minecraft.market.link_issues", "Issues"), detail.issues_url],
    [t("minecraft.market.link_wiki", "Wiki"), detail.wiki_url],
    [t("minecraft.market.link_discord", "Discord"), detail.discord_url],
  ] : [];

  // How many panels fit side by side: Description stays open in the first and the others show the
  // rest (see `PANEL_MIN_WIDTH`). One panel falls back to tabs.
  const pageRef = useRef<HTMLDivElement>(null);
  const [pageWidth, setPageWidth] = useState(0);
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const observer = new ResizeObserver(() => setPageWidth(page.clientWidth - PAGE_PADDING));
    observer.observe(page);
    return () => observer.disconnect();
  }, []);
  const [picked, setPicked] = useState<DetailSection>("gallery");
  const sections: DetailSection[] = detail ? ["about", ...(detail.gallery.length > 0 ? ["gallery" as const] : []), "versions"] : [];
  const panels = Math.min(sections.length, Math.max(1, Math.floor(pageWidth / PANEL_MIN_WIDTH)));
  /** What each panel shows; with fewer panels than sections the last one lets you choose among the rest. */
  const spare = sections.slice(1);
  const panelSections: DetailSection[] = panels >= sections.length ? sections : panels === 2 ? ["about", spare.includes(picked) ? picked : spare[0]] : ["about"];
  const infoCard = detail && (
    <>
            <div className="market-detail-stats">
              <div><b>{formatCount(detail.downloads)}</b><small>{t("minecraft.market.downloads", "Downloads")}</small></div>
              <div><b>{formatCount(detail.followers)}</b><small>{t("minecraft.market.followers", "Followers")}</small></div>
            </div>
            {detail.license_name && (
              <div className="market-detail-license"><small>{t("minecraft.market.license", "License")}</small><span>{detail.license_name}</span></div>
            )}
            <BrowseTags environment={detail.environment} categories={detail.categories} />
            <div className="market-detail-links">
              {links.filter(([, url]) => url).map(([label, url]) => (
                <button key={label} className="modpack-project-open-browser" onClick={() => openExternalUrl(url!).catch(console.error)}>
                  <ExternalLinkIcon width={14} height={14} /> {label}
                </button>
              ))}
            </div>
    </>
  );
  const installButton = (
    <button className="modpack-play-btn market-detail-install" onClick={() => setPicking(true)}>
      <DownloadIcon width={18} height={18} /> {t("minecraft.create_modpack.install", "Install modpack")}
    </button>
  );
  const sectionLabel = (id: DetailSection) => id === "about" ? t("minecraft.market.tab_about", "Description") : id === "gallery" ? t("minecraft.market.tab_gallery", "Gallery") : t("minecraft.market.tab_versions", "Versions");
  const renderSection = (id: DetailSection, d: ProjectDetail) => {
    if (id === "about") return <div className="modpack-project-body market-detail-about">{renderMarkdownBody(d.body)}</div>;
    if (id === "gallery") {
      return (
        <div className="market-gallery-grid">
          {d.gallery.map((g, i) => (
            <button
              key={i}
              className="market-gallery-item"
              onClick={() => setShotIndex(i)}
              onContextMenu={(e) => { e.preventDefault(); setImageMenu({ x: e.clientX, y: e.clientY, url: g.full_url ?? g.url }); }}
              title={g.title}
            >
              <img src={g.url} alt={g.title ?? ""} />
            </button>
          ))}
        </div>
      );
    }
    return <ModpackVersionList sources={sources} onChoose={install} explicit />;
  };

  return (
    <div className={`market-detail${panels > 1 ? " multi" : ""}`} ref={pageRef}>
      <button className="market-back" onClick={() => navigate(-1)}><ChevronDownIcon width={14} height={14} style={{ transform: "rotate(90deg)" }} /> {t("minecraft.market.title", "Modpack market")}</button>
      {error && <p className="modpack-error">{error}</p>}
      {!detail && !error && <p className="modpack-option-hint">{t("minecraft.content_manager.loading", "Loading...")}</p>}
      {detail && (
        <>
          <div className="market-detail-hero">
            {bannerImages.map((g, i) => (
              <img key={g.url} className={`market-detail-hero-bg${i === slide ? " shown" : ""}`} src={g.url} alt="" />
            ))}
            <div className="market-detail-hero-body">
              {detail.icon_url
                ? <img className="market-detail-icon" src={detail.icon_url} alt="" />
                : <span className="market-detail-icon modpack-file-icon"><FileIcon width={28} height={28} /></span>}
              <div className="market-detail-title">
                <h1>{detail.title}</h1>
                <p>{detail.description}</p>
              </div>
              {panels > 1 ? (
                <aside className="market-detail-aside">
                  {infoCard}
                  {installButton}
                </aside>
              ) : installButton}
            </div>
          </div>

          <div className="market-detail-columns">
            <div className="market-detail-main">
              {panels === 1 ? (
                <>
                  <nav className="pill-nav">
                    {sections.map((id) => (
                      <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
                        {sectionLabel(id)}{id === "gallery" && <span className="pill-nav-count">{detail.gallery.length}</span>}
                      </button>
                    ))}
                  </nav>
                  {renderSection(tab, detail)}
                </>
              ) : (
                <div className="market-panels" style={{ gridTemplateColumns: `repeat(${panelSections.length}, minmax(0, 1fr))` }}>
                  {panelSections.map((id, i) => (
                    <section key={`${i}-${id}`} className="market-panel">
                      <header className="market-panel-head">
                        {panels < sections.length && i === panelSections.length - 1 && spare.length > 1 ? (
                          <nav className="pill-nav">
                            {spare.map((choice) => (
                              <button key={choice} className={choice === id ? "active" : ""} onClick={() => setPicked(choice)}>
                                {sectionLabel(choice)}{choice === "gallery" && <span className="pill-nav-count">{detail.gallery.length}</span>}
                              </button>
                            ))}
                          </nav>
                        ) : (
                          <span>{sectionLabel(id)}</span>
                        )}
                      </header>
                      <div className="market-panel-body">{renderSection(id, detail)}</div>
                    </section>
                  ))}
                </div>
              )}
            </div>
            {panels === 1 && <aside className="market-detail-side">{infoCard}</aside>}
          </div>
        </>
      )}

      {picking && detail && (
        <ModpackVersionsModal sources={sources} title={detail.title} onClose={() => setPicking(false)} onChoose={install} />
      )}
      <Modal isOpen={shotIndex !== null} onClose={() => setShotIndex(null)} title="" size="full" headerless>
        {detail && shotIndex !== null && detail.gallery[shotIndex] && (
          <>
            <ZoomableImage
              src={detail.gallery[shotIndex].full_url ?? detail.gallery[shotIndex].url}
              onContextMenu={(e) => { e.preventDefault(); setImageMenu({ x: e.clientX, y: e.clientY, url: detail.gallery[shotIndex].full_url ?? detail.gallery[shotIndex].url }); }}
            />
            <ViewerArrows index={shotIndex} count={detail.gallery.length} onGo={setShotIndex} />
          </>
        )}
      </Modal>
      {imageMenu && <GalleryImageMenu {...imageMenu} service={service} onClose={() => setImageMenu(null)} />}
    </div>
  );
}

/** How many packs the Trending block lists: an even number, so its two-column list on wide windows has no gap at the end. */
const TRENDING_COUNT = 14;

/** The newest release-like game version (`"1.21.1"` over `"1.9"`), else the last one listed. */
function newestGameVersion(versions: string[]): string | undefined {
  const parts = (v: string) => v.split(".").map((p) => parseInt(p, 10) || 0);
  const newest = versions
    .filter((v) => /^\d+(\.\d+)+$/.test(v))
    .sort((a, b) => {
      const [x, y] = [parts(a), parts(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const diff = (x[i] ?? 0) - (y[i] ?? 0);
        if (diff) return diff;
      }
      return 0;
    });
  return newest[newest.length - 1] ?? versions[versions.length - 1];
}

/** The logo of every service a market pack is on (more than one when `mergeSamePacks` folded copies). */
function ServiceBadges({ hit, serviceNames }: { hit: MergedHit; serviceNames: Record<string, string> }) {
  return (
    <div className="market-tile-badges">
      {[hit, ...hit.also].map((m) => (
        <span key={m.service} className="modpack-tile-badge modpack-tile-badge-service" title={serviceNames[m.service] ?? m.service}>
          <ServiceLogo service={m.service} alt={serviceNames[m.service] ?? m.service} />
        </span>
      ))}
    </div>
  );
}

/**
 * Right-click menu of a market pack: install (the builds of every service it is on), view (from the
 * service with the freshest data), and, for each service, open its page and copy its link.
 */
function MarketHitMenu({ x, y, hit, serviceNames, onInstall, onView, onClose }: {
  x: number;
  y: number;
  hit: MergedHit;
  serviceNames: Record<string, string>;
  onInstall: (hit: MergedHit) => void;
  onView: (hit: MergedHit) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const toast = useBridge((b) => b.toast);
  useDismiss(menuRef, onClose);
  const at = useOnScreen(menuRef, x, y);

  const members = membersOf(hit);
  const several = members.length > 1;
  const nameOf = (m: BrowseHit) => serviceNames[m.service] ?? m.service;

  async function copyLink(m: BrowseHit) {
    try {
      await navigator.clipboard.writeText(m.url);
      toast?.({ message: t("minecraft.market.link_copied", "Link copied to the clipboard."), variant: "success" });
    } catch (e) {
      console.error(e);
      toast?.({ message: t("minecraft.market.copy_link_failed", "Couldn't copy the link."), variant: "error" });
    }
    onClose();
  }

  return (
    <div ref={menuRef} className="modpack-context-menu" style={{ left: at.x, top: at.y }}>
      <button onClick={() => { onInstall(hit); onClose(); }}>
        <DownloadIcon width={16} height={16} />
        {t("minecraft.content_manager.install", "Install")}
      </button>
      <button onClick={() => { onView(hit); onClose(); }}>
        <CubesIcon width={16} height={16} />
        {t("minecraft.market.view", "View modpack")}
      </button>
      <hr />
      {members.map((m) => (
        <button key={`open-${m.service}`} disabled={!m.url} onClick={() => { openExternalUrl(m.url).catch(console.error); onClose(); }}>
          <ExternalLinkIcon width={16} height={16} />
          {several
            ? t("minecraft.market.open_on", "Open on {service}").replace("{service}", nameOf(m))
            : t("minecraft.content_manager.open_in_browser", "Open in browser")}
        </button>
      ))}
      {members.map((m) => (
        <button key={`copy-${m.service}`} disabled={!m.url} onClick={() => copyLink(m)}>
          <CopyIcon width={16} height={16} />
          {several
            ? t("minecraft.market.copy_link_of", "Copy {service} link").replace("{service}", nameOf(m))
            : t("minecraft.market.copy_link", "Copy link")}
        </button>
      ))}
    </div>
  );
}

/**
 * A market result drawn as the instances page's tile (`.modpack-tile`): the pack's first gallery
 * picture (else the plugin's background) behind its icon, name and download count, with the logo of
 * each service it is on as badges. It keeps a fixed slot in the grid; on hover or focus the tile grows
 * downwards over its neighbours with the description, last update and game version/loaders.
 */
/** Pictures already requested, so each one is fetched and decoded once. */
const decodedPictures = new Map<string, Promise<void>>();
function decoded(url: string): Promise<void> {
  let ready = decodedPictures.get(url);
  if (!ready) {
    const img = new Image();
    img.src = url;
    ready = img.decode().catch(() => {});
    decodedPictures.set(url, ready);
  }
  return ready;
}

function MarketTile({ hit, serviceNames, background, onOpen, onMenu }: {
  hit: MergedHit;
  serviceNames: Record<string, string>;
  background: string | undefined;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const pictures = hit.gallery.length > 0 ? hit.gallery : background ? [background] : [];
  // While the pointer is on the tile its background goes through the pack's gallery, fading from
  // one picture to the next. A picture is fetched only then, and shown once it is ready, so the
  // fade never waits on the network.
  const [hovered, setHovered] = useState(false);
  const [slide, setSlide] = useState(0);
  useEffect(() => {
    if (!hovered) { setSlide(0); return; }
    if (pictures.length < 2 || animationsOff()) return;
    let cancelled = false;
    let at = 0;
    const timer = setInterval(async () => {
      const next = (at + 1) % pictures.length;
      await decoded(pictures[next]);
      if (cancelled) return;
      at = next;
      setSlide(next);
    }, 2200);
    pictures.forEach(decoded);
    return () => { cancelled = true; clearInterval(timer); };
  }, [hovered, pictures.length]);
  const shown = hovered ? pictures : pictures.slice(0, 1);
  const version = newestGameVersion(hit.game_versions);
  const updated = hit.updated ? new Date(hit.updated) : null;
  return (
    <div className="market-tile-slot">
      <div
        className="modpack-tile market-tile"
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        <div className="market-tile-head">
          <div className="modpack-tile-background">
            {shown.map((url, i) => (
              <img key={url} className={i === slide ? "shown" : ""} src={url} alt="" decoding="async" />
            ))}
          </div>
          <ServiceBadges hit={hit} serviceNames={serviceNames} />
          <div className="modpack-tile-info">
            <img className="modpack-tile-icon" src={hit.icon_url ?? PACKAGE} alt="" />
            <div className="modpack-tile-text">
              <h2>{hit.title}</h2>
              <p><DownloadIcon width={11} height={11} className="modpack-tile-meta-icon" /> {formatCount(hit.downloads)}</p>
            </div>
          </div>
        </div>
        <div className="market-tile-more">
          <p className="market-tile-description">{hit.description}</p>
          <dl className="market-tile-facts">
            {updated && !isNaN(updated.getTime()) && (
              <>
                <dt>{t("minecraft.market.updated", "Updated")}</dt>
                <dd>{updated.toLocaleDateString()}</dd>
              </>
            )}
            {(version || hit.loaders.length > 0) && (
              <>
                <dt>Minecraft</dt>
                <dd>
                  {version}
                  {hit.loaders.map((l) => <LoaderLabel key={l} loader={l} />)}
                </dd>
              </>
            )}
          </dl>
        </div>
      </div>
    </div>
  );
}

/**
 * The selected values the service can match: `[]` when nothing is selected, `null` when something
 * is but the service has none of it (so it has nothing to show for these filters).
 */
function narrowFilter(selected: Set<string>, supported: string[]): string[] | null {
  if (selected.size === 0) return [];
  const matching = supported.filter((v) => selected.has(v));
  return matching.length > 0 ? matching : null;
}

/**
 * "Modpack market": a page (route `/market`) for finding a whole modpack on the online services
 * that host them. Trending on top, then search results next to an always-open filters column. The
 * enabled services are searched side by side and their results interleaved; a filter only reaches
 * a service that offers it. There is no instance version/loader to scope to yet, so filters are
 * player-picked. Picking a pack opens its page, where a build is chosen and installed.
 */
export function ModpackMarketPage() {
  const call_module = useCallModule();
  const navigate = useNavigate();
  const listedServices = useContentServices().filter((s) => s.modpacks);
  const marketServices = listedServices.filter((s) => !s.unavailable);
  const serviceNames = Object.fromEntries(listedServices.map((s) => [s.id, s.name]));
  const tileBackground = useBackgroundImage();
  const marketKey = marketServices.map((s) => s.id).join();
  /** Services the player switched off in the filters: nothing is fetched from or shown for them. */
  const [disabledServices, setDisabledServices] = useState<Set<string>>(new Set());
  const activeServices = marketServices.filter((s) => !disabledServices.has(s.id));
  const activeKey = activeServices.map((s) => s.id).join();
  /** Drops the answer of a search that a newer one has overtaken. */
  const searchSeq = useRef(0);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MergedHit[]>([]);
  const [totalHits, setTotalHits] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState(1);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trending, setTrending] = useState<MergedHit[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; hit: MergedHit } | null>(null);
  /** The pack whose version picker is open, from the context menu's Install. */
  const [installing, setInstalling] = useState<MergedHit | null>(null);
  const pageSize = 20;

  const [sort, setSort] = useState("");
  const [selectedVersion, setSelectedVersion] = useState("");
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [selectedLoaders, setSelectedLoaders] = useState<Set<string>>(new Set());
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  /** Each service's own category names (a service is absent until its list arrives); the filter offers their union. */
  const [categoriesByService, setCategoriesByService] = useState<Record<string, string[]>>({});
  const [selectedEnvironments, setSelectedEnvironments] = useState<Set<string>>(new Set());
  const availableCategories = Array.from(new Set(Object.values(categoriesByService).flat()));
  const categoriesLoading = marketServices.some((s) => !(s.id in categoriesByService));
  const availableSorts = Array.from(new Set(activeServices.flatMap((s) => s.sorts)));
  const availableEnvironments = Array.from(new Set(activeServices.flatMap((s) => s.environments)));

  async function handleSearch(targetPage: number) {
    const seq = ++searchSeq.current;
    setSearching(true);
    setError(null);
    const settled = await Promise.allSettled(activeServices.map(async (s): Promise<SearchResult> => {
      const categories = narrowFilter(selectedCategories, categoriesByService[s.id] ?? []);
      const environments = narrowFilter(selectedEnvironments, s.environments);
      if (!categories || !environments) return { hits: [], totalHits: 0 };
      return createServiceClient(call_module, s.id).searchModpacks({
        query,
        offset: (targetPage - 1) * pageSize,
        limit: pageSize,
        sort: s.sorts.includes(sort) ? sort : "",
        minecraft_version: selectedVersion,
        categories,
        environments,
        loaders: Array.from(selectedLoaders),
      });
    }));
    if (seq !== searchSeq.current) return;
    const found = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    setResults(mergeSamePacks(interleave(found.map((r) => r.hits))));
    setTotalHits(found.reduce((n, r) => n + r.totalHits, 0));
    setPageCount(Math.max(1, ...found.map((r) => Math.ceil(r.totalHits / pageSize))));
    setError(settled.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : [])).join("\n") || null);
    setSearching(false);
  }

  useEffect(() => {
    handleSearch(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sort, selectedVersion, selectedCategories, selectedEnvironments, selectedLoaders, activeKey]);

  function runSearch() {
    if (page === 1) handleSearch(1);
    else setPage(1);
  }

  function changeSort(newSort: string) {
    setSort(newSort);
    setPage(1);
  }

  function changeVersion(v: string) {
    setSelectedVersion(v);
    setPage(1);
  }

  function toggleLoader(l: string) {
    setSelectedLoaders((prev) => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l); else next.add(l);
      return next;
    });
    setPage(1);
  }

  function toggleCategory(c: string) {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
    setPage(1);
  }

  function toggleEnvironment(v: string) {
    setSelectedEnvironments((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v); else next.add(v);
      return next;
    });
    setPage(1);
  }

  function toggleService(id: string) {
    setDisabledServices((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setPage(1);
  }

  const activeFilterCount =
    selectedCategories.size + selectedEnvironments.size + selectedLoaders.size + disabledServices.size + (sort ? 1 : 0) + (selectedVersion ? 1 : 0);

  useEffect(() => {
    let cancelled = false;
    const clients = marketServices.map((s) => ({ service: s, client: createServiceClient(call_module, s.id) }));
    // `TRENDING_COUNT` per service, merged one from each in turn (the services' order), so the list alternates
    // between them and the first ones show both.
    Promise.allSettled(clients.map(({ service: s, client }) => client.searchModpacks({
      query: "", offset: 0, limit: TRENDING_COUNT, sort: ["follows", "popularity"].find((x) => s.sorts.includes(x)) ?? "", minecraft_version: "", categories: [], environments: [], loaders: [],
    })))
      .then((rs) => {
        if (cancelled) return;
        const merged = mergeSamePacks(interleave(rs.flatMap((r) => (r.status === "fulfilled" ? [r.value.hits] : [])))).slice(0, TRENDING_COUNT);
        // Packs that two services share merge into one, so fewer than asked can be left: keep the count even.
        setTrending(merged.slice(0, merged.length - (merged.length % 2)));
      });
    for (const { service: s, client } of clients) {
      client.categories("modpacks")
        .catch((e) => { console.error(e); return [] as string[]; })
        .then((list) => setCategoriesByService((prev) => ({ ...prev, [s.id]: list })));
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketKey]);

  useEffect(() => {
    setVersionsLoading(true);
    call_module("get_versions", { core: "vanilla" })
      .then((res: any) => setAvailableVersions(Array.isArray(res) ? res : []))
      .catch(console.error)
      .finally(() => setVersionsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Opens the service with the freshest data (the merged pack's own), handing over the others for the builds list. */
  const openPack = (hit: MergedHit) => navigate(`/market/${hit.service}/${hit.project_id}`, { state: { members: membersOf(hit) } });

  const showTrending = trending.length > 0 && page === 1 && !query.trim() && activeFilterCount === 0;

  return (
    <div className="modpack-market">
      <div className="modpack-browse-layout">
        <div className="option-container modpack-browse-main">
          <div className="modpack-browse-search market-search">
            <SearchIcon width={18} height={18} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
              placeholder={t("minecraft.market.search_placeholder", "Search modpacks...")}
            />
          </div>

          {error && <p className="modpack-error">{error}</p>}

          {showTrending && (
            <TrendingPanel hits={trending} serviceNames={serviceNames} onPick={openPack} onMenu={(x, y, hit) => setMenu({ x, y, hit })} />
          )}

          {totalHits > 0 && <Pager page={page} pageCount={pageCount} total={totalHits} disabled={searching} onPage={setPage} />}

          <div className="modpack-browse-results">
            {searching && <p className="modpack-option-hint">{t("minecraft.content_manager.searching", "Searching...")}</p>}
            {!searching && results.length === 0 && (
              <p className="modpack-option-hint">{t("minecraft.content_manager.no_results", "No results.")}</p>
            )}
            {!searching && results.map((hit) => (
              <MarketTile
                key={installedKey(hit.service, hit.project_id)}
                hit={hit}
                serviceNames={serviceNames}
                background={tileBackground}
                onOpen={() => openPack(hit)}
                onMenu={(x, y) => setMenu({ x, y, hit })}
              />
            ))}
          </div>
          {totalHits > 0 && pageCount > 1 && <Pager page={page} pageCount={pageCount} disabled={searching} onPage={setPage} />}
        </div>

        {(
          <div className="modpack-browse-filters-sidebar option-container">
            <div className="modpack-browse-filters-header">
              <SlidersIcon width={18} height={18} />
              <span>{t("minecraft.content_manager.filters", "Filters")}</span>
              {activeFilterCount > 0 && (
                <button
                  className="modpack-browse-filters-clear"
                  onClick={() => {
                    setSelectedCategories(new Set());
                    setSort("");
                    setSelectedEnvironments(new Set());
                    setSelectedLoaders(new Set());
                    setSelectedVersion("");
                    setDisabledServices(new Set());
                    setPage(1);
                  }}
                >
                  {t("minecraft.content_manager.clear_filters", "Clear")}
                </button>
              )}
            </div>

            <FilterSection title={t("minecraft.market.services", "Services")}>
              <div className="modpack-browse-filter-categories">
                {listedServices.map((s) => (
                  <button
                    key={s.id}
                    className={`modpack-browse-filter-chip${disabledServices.has(s.id) || s.unavailable ? "" : " active"}`}
                    disabled={!!s.unavailable}
                    title={s.unavailable ?? undefined}
                    onClick={() => toggleService(s.id)}
                  >
                    <ServiceLogo service={s.id} className="pill-nav-icon" alt="" />
                    {s.name}
                  </button>
                ))}
              </div>
            </FilterSection>

            <SortFilter sorts={availableSorts} value={sort} onChange={changeSort} />

            <FilterSection title={t("minecraft.create_modpack.filter_version", "Version")}>
              <select value={selectedVersion} onChange={(e) => changeVersion(e.target.value)} disabled={versionsLoading}>
                <option value="">{t("minecraft.content_manager.environment_any", "Any")}</option>
                {versionsLoading && <option>{t("minecraft.content_manager.loading", "Loading...")}</option>}
                {!versionsLoading && availableVersions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </FilterSection>

            <FilterSection title={t("minecraft.create_modpack.filter_loaders", "Loaders")}>
              <div className="modpack-browse-filter-categories">
                {MODPACK_LOADER_VALUES.map((l) => (
                  <button
                    key={l}
                    className={`modpack-browse-filter-chip${selectedLoaders.has(l) ? " active" : ""}`}
                    onClick={() => toggleLoader(l)}
                  >
                    <LoaderLabel loader={l} label={l} />
                  </button>
                ))}
              </div>
            </FilterSection>

            <EnvironmentFilter environments={availableEnvironments} selected={selectedEnvironments} onToggle={toggleEnvironment} />
            <CategoryFilter categories={availableCategories} loading={categoriesLoading} selected={selectedCategories} onToggle={toggleCategory} />

          </div>
        )}
      </div>

      {menu && (
        <MarketHitMenu
          x={menu.x}
          y={menu.y}
          hit={menu.hit}
          serviceNames={serviceNames}
          onInstall={setInstalling}
          onView={openPack}
          onClose={() => setMenu(null)}
        />
      )}
      {installing && (
        <ModpackVersionsModal
          sources={membersOf(installing).map((m) => ({ service: m.service, projectId: m.project_id }))}
          title={installing.title}
          onClose={() => setInstalling(null)}
          onChoose={async (source) => {
            const member = membersOf(installing).find((m) => m.service === source.service);
            await installMarketModpack(
              call_module,
              createServiceClient(call_module, source.service),
              { project_id: source.projectId, title: installing.title, icon_url: member?.icon_url, banner_url: member?.gallery[0], url: member?.url },
              source.version,
            );
            navigate("/");
          }}
        />
      )}
    </div>
  );
}
