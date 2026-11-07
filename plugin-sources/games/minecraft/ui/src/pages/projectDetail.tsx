// The detail view of one project from a service.
import { useEffect, useState } from "react";
import { open as openExternalUrl } from "@tauri-apps/api/shell";
import { t } from "@shared/components/Translate";
import { Modal } from "@shared/index";
import { useCallModule } from "@shared/modules";
import { useServiceClient } from "../services";
import type { ProjectDetail } from "../services";
import FileIcon from "@shared/assets/icons/file.svg?react";
import DownloadIcon from "@shared/assets/icons/download.svg?react";
import ExternalLinkIcon from "@shared/assets/icons/external-link.svg?react";
import { ContentCategory } from "./types";
import { waitForBackgroundJob, formatCount } from "./helpers";
import { BrowseTags } from "./components";
import { renderMarkdownBody } from "./markdown";

export function ProjectDetailModal({
  service, projectId, category, gamePath, name, installed, onClose, onInstalled,
}: {
  service: string;
  projectId: string;
  category: ContentCategory;
  gamePath: string | undefined;
  name: string;
  installed: boolean;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const call_module = useCallModule();
  const client = useServiceClient(service);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    client.project(projectId)
      .then(setDetail)
      .catch((e: any) => setError(String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleInstall() {
    if (!gamePath || !detail) return;
    setInstalling(true);
    setError(null);
    try {
      const job = await client.install({ name, category, projectId, title: detail.title });
      const jobError = await waitForBackgroundJob(call_module, job);
      if (jobError) throw new Error(jobError);
      onInstalled();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  }

  function handleOpenInBrowser() {
    if (detail) openExternalUrl(detail.url).catch(console.error);
  }

  return (
    <Modal isOpen onClose={onClose} title={detail?.title ?? t("minecraft.content_manager.loading", "Loading...")} size="large">
      <div className="option-container modpack-project-detail">
        {loading && <p className="modpack-option-hint">{t("minecraft.content_manager.loading", "Loading...")}</p>}
        {error && <p className="modpack-error">{error}</p>}
        {!loading && detail && (
          <>
            <div className="modpack-project-header">
              {detail.icon_url ? (
                <img className="modpack-browse-icon" src={detail.icon_url} alt="" />
              ) : (
                <span className="modpack-browse-icon modpack-file-icon"><FileIcon width={16} height={16} /></span>
              )}
              <div className="modpack-project-header-text">
                <span className="modpack-browse-title">{detail.title}</span>
                <span className="modpack-browse-description">{detail.description}</span>
                <BrowseTags environment={detail.environment} categories={detail.categories} />
              </div>
              <div className="modpack-browse-actions">
                <button
                  className={`modpack-browse-install${installed ? " installed" : ""}`}
                  onClick={handleInstall}
                  disabled={installed || installing}
                >
                  {installed
                    ? t("minecraft.content_manager.installed", "Installed")
                    : installing
                      ? t("minecraft.content_manager.installing", "Installing...")
                      : t("minecraft.content_manager.install", "Install")}
                </button>
                <span className="modpack-browse-downloads">
                  <DownloadIcon width={12} height={12} /> {formatCount(detail.downloads)}
                </span>
                <button className="modpack-project-open-browser" onClick={handleOpenInBrowser}>
                  <ExternalLinkIcon width={14} height={14} /> {t("minecraft.content_manager.open_in_browser", "Open in browser")}
                </button>
              </div>
            </div>

            {detail.gallery.length > 0 && (
              <div className="modpack-project-gallery">
                {detail.gallery.map((g, i) => (
                  <img key={i} className="modpack-project-gallery-image" src={g.url} alt={g.title ?? ""} />
                ))}
              </div>
            )}

            <div className="modpack-project-body">
              {renderMarkdownBody(detail.body)}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
