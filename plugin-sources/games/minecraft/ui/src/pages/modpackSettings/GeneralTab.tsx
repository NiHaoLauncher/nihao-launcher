// The General tab of the instance settings: icon, banner, name, version, repair, detach, duplicate, delete. The state and the handlers belong to the modal; this draws them.
import { t } from "@shared/components/Translate";
import { OptionRow } from "@shared";
import type { ModpackVersion } from "../../services";
import TrashIcon from "@shared/assets/icons/trash.svg?react";
import DownloadIcon from "@shared/assets/icons/download.svg?react";
import ExternalLinkIcon from "@shared/assets/icons/external-link.svg?react";
import CopyIcon from "@shared/assets/icons/copy.svg?react";
import RefreshIcon from "@shared/assets/icons/refresh.svg?react";
import LayersIcon from "@shared/assets/icons/layers.svg?react";
import { ModpackProfile } from "../types";

export function GeneralTab({
  profile,
  managed,
  origin,
  iconData,
  bannerData,
  pickingIcon,
  pickingBanner,
  handlePickIcon,
  handlePickBanner,
  displayName,
  setDisplayName,
  source,
  outdated,
  versionInfo,
  setVersionsOpen,
  handleRepair,
  repairing,
  detachingService,
  setConfirmDetachService,
  duplicateName,
  setDuplicateName,
  handleDuplicate,
  duplicating,
  setConfirmDelete,
  deleting,
}: {
  profile: ModpackProfile;
  managed: boolean;
  origin: string;
  iconData: string | null;
  bannerData: string | null;
  pickingIcon: boolean;
  pickingBanner: boolean;
  handlePickIcon: () => void;
  handlePickBanner: () => void;
  displayName: string;
  setDisplayName: (name: string) => void;
  source: ModpackProfile["source"];
  outdated: boolean;
  versionInfo: { latest: ModpackVersion; current?: ModpackVersion } | null;
  setVersionsOpen: (open: boolean) => void;
  handleRepair: () => void;
  repairing: boolean;
  detachingService: boolean;
  setConfirmDetachService: (open: boolean) => void;
  duplicateName: string;
  setDuplicateName: (name: string) => void;
  handleDuplicate: () => void;
  duplicating: boolean;
  setConfirmDelete: (open: boolean) => void;
  deleting: boolean;
}) {
  return (
    <div className="settings-tab">
      {managed && (
        <p className="settings-hint">
          {profile.source
            ? t(
                "minecraft.modpack_settings.source_hint",
                "This instance was installed from {service} — its icon, banner, name and content are managed by it, not locally. Detach it to change them."
              ).replace("{service}", origin)
            : t(
                "minecraft.modpack_settings.downloaded_hint",
                "This instance was downloaded from Public — its icon, banner, name and content are managed by the server, not locally."
              )}
        </p>
      )}

      {!managed && (
        <>
          <div className="settings-field">
            <div className="modpack-images-row">
              <div>
                <label>{t("minecraft.modpack_settings.icon_label", "Icon")}</label>
                <div
                  className="modpack-icon-preview modpack-image-picker"
                  onClick={pickingIcon ? undefined : handlePickIcon}
                  role="button"
                  title={t("minecraft.modpack_settings.icon_change", "Change icon")}
                >
                  {iconData && <img src={iconData} alt="" />}
                  <div className="modpack-image-picker-overlay">
                    {pickingIcon
                      ? t("minecraft.modpack_settings.icon_uploading", "Uploading...")
                      : t("minecraft.modpack_settings.icon_change", "Change icon")}
                  </div>
                </div>
              </div>

              <div>
                <label>{t("minecraft.modpack_settings.banner_label", "Banner")}</label>
                <div
                  className="modpack-banner-preview modpack-image-picker"
                  onClick={pickingBanner ? undefined : handlePickBanner}
                  role="button"
                  title={t("minecraft.modpack_settings.banner_change", "Change banner")}
                >
                  {bannerData && <img src={bannerData} alt="" />}
                  <div className="modpack-image-picker-overlay">
                    {pickingBanner
                      ? t("minecraft.modpack_settings.banner_uploading", "Uploading...")
                      : t("minecraft.modpack_settings.banner_change", "Change banner")}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <OptionRow icon={<LayersIcon className="settings-icon" />} label={t("minecraft.modpack_settings.name_label", "Name")} hint={t("minecraft.modpack_settings.name_hint", "The name shown for this modpack in the launcher.")}>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </OptionRow>
        </>
      )}

      {source && (
        <OptionRow
          icon={<DownloadIcon className="settings-icon" />}
          label={t("minecraft.modpack_settings.version_label", "Version: {version}").replace("{version}", source.version_number)}
          hint={outdated && versionInfo
            ? t("minecraft.modpack_settings.version_outdated", "A newer version is available: {version}.").replace("{version}", versionInfo.latest.version_number)
            : t("minecraft.modpack_settings.version_hint", "Move this instance to a newer or an older build of the pack. The pack's files are replaced; your saves and settings stay.")}
        >
          <button className={`settings-secondary-btn${outdated ? " modpack-update-btn" : ""}`} onClick={() => setVersionsOpen(true)}>
            {t("minecraft.modpack_settings.version_change", "Change version")}
          </button>
        </OptionRow>
      )}

      <OptionRow icon={<RefreshIcon className="settings-icon" />} label={t("minecraft.modpack_settings.repair_label", "Repair")} hint={profile.source
        ? t("minecraft.modpack_settings.repair_hint_pack", "Re-checks the game's files and the pack's own: whatever is missing or broken is downloaded again from {service}.").replace("{service}", origin)
        : t("minecraft.modpack_settings.repair_hint", "Re-checks and re-downloads any missing or broken files.")}>
        <button className="settings-secondary-btn" onClick={handleRepair} disabled={repairing}>
          {repairing
            ? t("minecraft.modpack_settings.repairing", "Starting...")
            : t("minecraft.modpack_settings.repair", "Repair / re-verify files")}
        </button>
      </OptionRow>

      {managed && (
        <OptionRow
          icon={<ExternalLinkIcon className="settings-icon" />}
          label={t("minecraft.modpack_settings.detach_service_label", "Detach from {service}").replace("{service}", origin)}
          hint={t("minecraft.modpack_settings.detach_service_hint", "Makes this a custom instance: you can then change its name, icon, banner and content, and it no longer follows {service}. Its files stay exactly as they are.").replace("{service}", origin)}
        >
          <button className="settings-secondary-btn modpack-danger-btn" onClick={() => setConfirmDetachService(true)} disabled={detachingService}>
            {t("minecraft.modpack_settings.publish_detach", "Detach")}
          </button>
        </OptionRow>
      )}

      {!managed && (
        <OptionRow icon={<CopyIcon className="settings-icon" />} label={t("minecraft.modpack_settings.duplicate_label", "Duplicate")} hint={t("minecraft.modpack_settings.duplicate_hint", "Makes a copy of this instance under the name you enter, with all its files.")}>
          <input type="text" value={duplicateName} onChange={(e) => setDuplicateName(e.target.value)} />
          <button className="settings-secondary-btn" onClick={handleDuplicate} disabled={duplicating || !duplicateName.trim()}>
            {duplicating ? t("minecraft.modpack_settings.duplicating", "Duplicating...") : t("minecraft.modpack_settings.duplicate", "Duplicate")}
          </button>
        </OptionRow>
      )}

      <OptionRow icon={<TrashIcon className="settings-icon" />} label={t("minecraft.modpack_settings.delete_label", "Delete instance")} hint={t("minecraft.modpack_settings.delete_hint", "Permanently removes its saves, mods and settings.")}>
        <button className="settings-secondary-btn modpack-danger-btn" onClick={() => setConfirmDelete(true)} disabled={deleting}>
          {t("minecraft.modpack_settings.delete", "Delete instance")}
        </button>
      </OptionRow>
    </div>
  );
}
