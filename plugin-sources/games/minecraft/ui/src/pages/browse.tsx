// Browsing a service for content to install, with its filters.
import { useEffect, useRef, useState } from "react";
import { t } from "@shared/components/Translate";
import { Modal } from "@shared/index";
import { useCallModule } from "@shared/modules";
import { installedKey, useContentServices, useServiceClient } from "../services";
import type { BrowseHit, ServiceInfo } from "../services";
import FileIcon from "@shared/assets/icons/file.svg?react";
import DownloadIcon from "@shared/assets/icons/download.svg?react";
import ChevronDownIcon from "@shared/assets/icons/chevron-down.svg?react";
import SearchIcon from "@shared/assets/icons/search.svg?react";
import SlidersIcon from "@shared/assets/icons/sliders.svg?react";
import { ContentCategory } from "./types";
import { waitForBackgroundJob, overallPercent, formatCount, formatEnvironmentValue, getPageNumbers } from "./helpers";
import { ServiceLogo, BrowseTags } from "./components";
import { ProjectDetailModal } from "./projectDetail";

/** A collapsible filter group in Browse content's sidebar; click the title to hide/show. */
export function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="modpack-browse-filter-section">
      <button type="button" className="modpack-browse-filter-section-toggle" onClick={() => setOpen((v) => !v)}>
        <span>{title}</span>
        <ChevronDownIcon className={`modpack-browse-filter-chevron${open ? " open" : ""}`} width={14} height={14} />
      </button>
      {open && <div className="modpack-browse-filter-section-body">{children}</div>}
    </div>
  );
}

/** Page buttons for a list of `pageCount` pages: previous, numbers (with gaps) and next, and how many results there are. */
export function Pager({ page, pageCount, total, disabled, onPage }: {
  page: number;
  pageCount: number;
  total?: number;
  disabled?: boolean;
  onPage: (page: number) => void;
}) {
  const go = (p: number) => onPage(Math.min(pageCount, Math.max(1, p)));
  return (
    <nav className="market-pager">
      <span className="market-pager-total">{total !== undefined ? `${formatCount(total)} ${t("minecraft.market.results", "results")}` : ""}</span>
      <div className="market-pager-controls">
        <button onClick={() => go(page - 1)} disabled={page <= 1 || disabled} aria-label={t("minecraft.content_manager.prev_page", "Prev")}>
          <ChevronDownIcon width={16} height={16} style={{ transform: "rotate(90deg)" }} />
        </button>
        {getPageNumbers(page, pageCount).map((p, i) =>
          p === "..." ? (
            <span key={`gap-${i}`} className="market-pager-ellipsis">…</span>
          ) : (
            <button key={p} className={p === page ? "active" : ""} onClick={() => go(p)} disabled={disabled}>{p}</button>
          )
        )}
        <button onClick={() => go(page + 1)} disabled={page >= pageCount || disabled} aria-label={t("minecraft.content_manager.next_page", "Next")}>
          <ChevronDownIcon width={16} height={16} style={{ transform: "rotate(-90deg)" }} />
        </button>
      </div>
    </nav>
  );
}

/** English names of the usual sort ids; a service's other ids show as they are until translated. */
const SORT_FALLBACKS: Record<string, string> = {
  downloads: "Downloads", follows: "Follows", newest: "Newest", updated: "Recently updated", popularity: "Popularity",
};

/** "Sort by": relevance plus the sorts a service offers (`ServiceInfo.sorts`). */
export function SortFilter({ sorts, value, onChange }: { sorts: string[]; value: string; onChange: (sort: string) => void }) {
  return (
    <FilterSection title={t("minecraft.content_manager.sort_by", "Sort by")}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("minecraft.content_manager.sort_relevance", "Relevance")}</option>
        {sorts.map((s) => (
          <option key={s} value={s}>{t(`minecraft.content_manager.sort_${s}`, SORT_FALLBACKS[s] ?? s)}</option>
        ))}
      </select>
    </FilterSection>
  );
}

/** A service's environment values (`ServiceInfo.environments`) as togglable chips; hidden if it has none. */
export function EnvironmentFilter({ environments, selected, onToggle }: { environments: string[]; selected: Set<string>; onToggle: (v: string) => void }) {
  if (environments.length === 0) return null;
  return (
    <FilterSection title={t("minecraft.content_manager.environment", "Environment")}>
      <div className="modpack-browse-filter-categories">
        {environments.map((v) => (
          <button
            key={v}
            className={`modpack-browse-filter-chip${selected.has(v) ? " active" : ""}`}
            onClick={() => onToggle(v)}
          >
            {formatEnvironmentValue(v)}
          </button>
        ))}
      </div>
    </FilterSection>
  );
}

/** A service's category chips (`ServiceInfo`'s own taxonomy, fetched by the caller). */
export function CategoryFilter({ categories, loading, selected, onToggle }: {
  categories: string[];
  loading: boolean;
  selected: Set<string>;
  onToggle: (c: string) => void;
}) {
  return (
    <FilterSection title={t("minecraft.content_manager.categories", "Categories")}>
      {loading && <p className="modpack-option-hint">{t("minecraft.content_manager.loading", "Loading...")}</p>}
      {!loading && categories.length === 0 && (
        <p className="modpack-option-hint">{t("minecraft.content_manager.no_filters", "No filters for this service.")}</p>
      )}
      {!loading && categories.length > 0 && (
        <div className="modpack-browse-filter-categories">
          {categories.map((c) => (
            <button
              key={c}
              className={`modpack-browse-filter-chip${selected.has(c) ? " active" : ""}`}
              onClick={() => onToggle(c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}
    </FilterSection>
  );
}

const PAGE_SIZE = 20;

/**
 * "Browse content": searches one of the online services (picked at the top) for the active
 * category, scoped server-side to the instance's game version/loader, and installs the picked result
 * into the matching folder. `onInstalled` re-fetches the list so the new file gets a cached
 * name/icon. `installedProjectIds` holds `installedKey`s.
 */
export function BrowseContentModal({
  onClose, gamePath, name, category: initialCategory, onInstalled, installedProjectIds,
}: {
  onClose: () => void;
  gamePath: string | undefined;
  name: string;
  /** The category shown first; the player switches between them inside. */
  category: ContentCategory;
  onInstalled: () => void;
  /** `installedKey`s of what each category already has. */
  installedProjectIds: (category: ContentCategory) => Set<string>;
}) {
  const call_module = useCallModule();
  const [category, setCategory] = useState<ContentCategory>(initialCategory);
  /** Installed this session: the list the parent passes only catches up after its rescan. */
  const [justInstalled, setJustInstalled] = useState<Set<string>>(new Set());
  const installedIds = new Set([...installedProjectIds(category), ...justInstalled]);
  const services = useContentServices().filter((s) => s.content.includes(category));
  const [serviceId, setServiceId] = useState("");
  const service: ServiceInfo | undefined =
    services.find((s) => s.id === serviceId && !s.unavailable) ?? services.find((s) => !s.unavailable);
  const client = useServiceClient(service?.id ?? "");
  /** Drops the answer of a search that a newer one (or a service switch) has overtaken. */
  const searchSeq = useRef(0);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<BrowseHit[]>([]);
  const [totalHits, setTotalHits] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = PAGE_SIZE;
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installPercent, setInstallPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [detailProjectId, setDetailProjectId] = useState<string | null>(null);
  const [sort, setSort] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [selectedEnvironments, setSelectedEnvironments] = useState<Set<string>>(new Set());

  async function handleSearch(targetPage: number, targetPageSize: number) {
    if (!gamePath || !service) return;
    const seq = ++searchSeq.current;
    setSearching(true);
    setError(null);
    try {
      const res = await client.searchContent({
        name,
        category,
        query,
        offset: (targetPage - 1) * targetPageSize,
        limit: targetPageSize,
        sort,
        categories: Array.from(selectedCategories),
        environments: Array.from(selectedEnvironments),
      });
      if (seq !== searchSeq.current) return;
      setResults(res.hits);
      setTotalHits(res.totalHits);
    } catch (e) {
      if (seq === searchSeq.current) setError(String(e));
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }

  useEffect(() => {
    handleSearch(page, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, sort, selectedCategories, selectedEnvironments, service?.id, category]);

  function changeCategory(next: ContentCategory) {
    if (next === category) return;
    setCategory(next);
    setSort("");
    setSelectedCategories(new Set());
    setSelectedEnvironments(new Set());
    setAvailableCategories([]);
    setResults([]);
    setPage(1);
  }

  function changeService(id: string) {
    if (id === service?.id) return;
    setServiceId(id);
    // Sorts, environments and categories are the service's own.
    setSort("");
    setSelectedCategories(new Set());
    setSelectedEnvironments(new Set());
    setAvailableCategories([]);
    setPage(1);
  }

  function runSearch() {
    if (page === 1) {
      handleSearch(1, pageSize);
    } else {
      setPage(1);
    }
  }

  function toggleCategory(c: string) {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
    setPage(1);
  }

  function changeSort(newSort: string) {
    setSort(newSort);
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

  const activeFilterCount = selectedCategories.size + selectedEnvironments.size + (sort ? 1 : 0);

  useEffect(() => {
    if (!gamePath || !service) return;
    let cancelled = false;
    setCategoriesLoading(true);
    client.categories(category)
      .then((list) => { if (!cancelled) setAvailableCategories(list); })
      .catch(console.error)
      .finally(() => { if (!cancelled) setCategoriesLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service?.id, category]);

  const pageCount = Math.max(1, Math.ceil(totalHits / pageSize));

  async function handleInstall(projectId: string, title: string) {
    if (!gamePath || !service) return;
    setInstalling(projectId);
    setInstallPercent(0);
    setError(null);
    try {
      const job = await client.install({ name, category, projectId, title });
      const jobError = await waitForBackgroundJob(call_module, job, (p) => setInstallPercent(overallPercent(p)));
      if (jobError) throw new Error(jobError);
      setJustInstalled((prev) => new Set(prev).add(installedKey(service.id, projectId)));
      onInstalled();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(null);
    }
  }

  const categoryLabels: Record<ContentCategory, string> = {
    mods: t("minecraft.content_manager.mods", "Mods"),
    resourcepacks: t("minecraft.content_manager.resourcepacks", "Resource packs"),
    shaderpacks: t("minecraft.content_manager.shaderpacks", "Shader packs"),
    datapacks: t("minecraft.content_manager.datapacks", "Datapacks"),
  };

  return (
    <>
    <Modal
      isOpen
      onClose={onClose}
      title={t("minecraft.content_manager.browse", "Browse content")}
      size="full"
      height="95vh"
    >
      <div className="modpack-browse-layout modpack-browse-full">
        <div className="option-container modpack-browse-main">
          <nav className="pill-nav modpack-browse-categories">
            {(Object.keys(categoryLabels) as ContentCategory[]).map((c) => (
              <button key={c} type="button" className={c === category ? "active" : ""} onClick={() => changeCategory(c)}>
                {categoryLabels[c]}
              </button>
            ))}
          </nav>

          <div className={`modpack-browse-bar${searchOpen ? " open" : ""}`}>
            <nav className="pill-nav modpack-browse-services">
              {services.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={s.id === service?.id ? "active" : ""}
                  disabled={!!s.unavailable}
                  title={s.unavailable ?? undefined}
                  onClick={() => changeService(s.id)}
                >
                  <ServiceLogo service={s.id} className="pill-nav-icon" alt="" />
                  {s.name}
                </button>
              ))}
            </nav>

            <button type="button" className="modpack-browse-search-toggle" title={t("minecraft.content_manager.search", "Search...")} onClick={() => { setSearchOpen(true); setTimeout(() => searchInput.current?.focus(), 0); }}>
              <SearchIcon width={18} height={18} />
            </button>
            <div className="modpack-browse-search market-search">
              <SearchIcon width={18} height={18} />
              <input
                ref={searchInput}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
                placeholder={t("minecraft.content_manager.search_placeholder", "Search {service}...").replace("{service}", service?.name ?? "")}
              />
            </div>
          </div>

          {error && <p className="modpack-error">{error}</p>}

          {totalHits > 0 && <Pager page={page} pageCount={pageCount} total={totalHits} disabled={searching} onPage={setPage} />}

          <div className="modpack-browse-results">
            {searching && <p className="modpack-option-hint">{t("minecraft.content_manager.searching", "Searching...")}</p>}
            {!searching && results.length === 0 && (
              <p className="modpack-option-hint">{t("minecraft.content_manager.no_results", "No results.")}</p>
            )}
            {!searching && results.map((hit) => {
              const installed = installedIds.has(installedKey(hit.service, hit.project_id));
              return (
              <div
                key={hit.project_id}
                className="modpack-browse-row modpack-browse-row-clickable"
                onClick={() => setDetailProjectId(hit.project_id)}
              >
                {hit.icon_url ? (
                  <img className="modpack-browse-icon" src={hit.icon_url} alt="" />
                ) : (
                  <span className="modpack-browse-icon modpack-file-icon"><FileIcon width={16} height={16} /></span>
                )}
                <div className="modpack-browse-text">
                  <span className="modpack-browse-title">{hit.title}</span>
                  <span className="modpack-browse-description">{hit.description}</span>
                  <BrowseTags environment={hit.environment} categories={hit.categories} />
                </div>
                <div className="modpack-browse-actions">
                  <button
                    className={`modpack-browse-install${installed ? " installed" : ""}${installing === hit.project_id ? " installing" : ""}`}
                    style={installing === hit.project_id ? ({ "--pct": `${installPercent}%` } as React.CSSProperties) : undefined}
                    onClick={(e) => { e.stopPropagation(); handleInstall(hit.project_id, hit.title); }}
                    disabled={installed || installing !== null}
                  >
                    {installed
                      ? t("minecraft.content_manager.installed", "Installed")
                      : installing === hit.project_id
                        ? `${installPercent}%`
                        : t("minecraft.content_manager.install", "Install")}
                  </button>
                  <span className="modpack-browse-downloads">
                    <DownloadIcon width={12} height={12} /> {formatCount(hit.downloads)}
                  </span>
                </div>
              </div>
              );
            })}
          </div>

          {totalHits > 0 && pageCount > 1 && <Pager page={page} pageCount={pageCount} disabled={searching} onPage={setPage} />}
        </div>

        <div className="modpack-browse-filters-sidebar option-container">
          <div className="modpack-browse-filters-header">
            <SlidersIcon width={18} height={18} />
            <span>{t("minecraft.content_manager.filters", "Filters")}</span>
            {activeFilterCount > 0 && (
              <button
                className="modpack-browse-filters-clear"
                onClick={() => { setSelectedCategories(new Set()); setSort(""); setSelectedEnvironments(new Set()); setPage(1); }}
              >
                {t("minecraft.content_manager.clear_filters", "Clear")}
              </button>
            )}
          </div>

          <SortFilter sorts={service?.sorts ?? []} value={sort} onChange={changeSort} />
          <EnvironmentFilter environments={service?.environments ?? []} selected={selectedEnvironments} onToggle={toggleEnvironment} />
          <CategoryFilter categories={availableCategories} loading={categoriesLoading} selected={selectedCategories} onToggle={toggleCategory} />
        </div>
      </div>
    </Modal>
    {detailProjectId && service && (
      <ProjectDetailModal
        service={service.id}
        projectId={detailProjectId}
        category={category}
        gamePath={gamePath}
        name={name}
        installed={installedIds.has(installedKey(service.id, detailProjectId))}
        onClose={() => setDetailProjectId(null)}
        onInstalled={onInstalled}
      />
    )}
    </>
  );
}
