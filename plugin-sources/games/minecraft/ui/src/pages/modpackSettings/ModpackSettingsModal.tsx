// The settings of one instance.
import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/api/dialog";
import { t } from "@shared/components/Translate";
import { Modal, ConfirmModal } from "@shared/index";
import { useCallModule } from "@shared/modules";
import { useBridge, useSettingsFooter } from "@shared";
import type { Change } from "@shared";
import { createServiceClient, useContentServices } from "../../services";
import type { ModpackVersion } from "../../services";
import TrashIcon from "@shared/assets/icons/trash.svg?react";
import CloudUploadIcon from "@shared/assets/icons/cloud-upload.svg?react";
import DownloadIcon from "@shared/assets/icons/download.svg?react";
import SlidersIcon from "@shared/assets/icons/sliders.svg?react";
import { ModpackProfile, SettingsCategory } from "../types";
import { isManaged } from "../helpers";
import { useGamePath, useSignedIn } from "../hooks";
import { ModpackVersionsModal } from "../market";
import { GeneralTab } from "./GeneralTab";
import { InstallTab } from "./InstallTab";
import { PublishTab } from "./PublishTab";

export function ModpackSettingsModal(
  {
    open, onClose, name, profile, iconData, bannerData, generalRam,
    onProfileChange, onIconChange, onBannerChange, onDeleted, onDuplicated,
  }: {
    open: boolean;
    onClose: () => void;
    name: string;
    profile: ModpackProfile;
    iconData: string | null;
    bannerData: string | null;
    generalRam: number | undefined;
    onProfileChange: (profile: ModpackProfile) => void;
    onIconChange: (iconData: string | null) => void;
    onBannerChange: (bannerData: string | null) => void;
    onDeleted: () => void;
    onDuplicated: (newName: string) => void;
  }
) {
  const call_module = useCallModule();
  const gamePath = useGamePath();
  const signedIn = useSignedIn();
  const toast = useBridge((b) => b.toast);
  const reportError = (e: unknown) => toast?.({ message: String(e), variant: "error" });
  const [category, setCategory] = useState<SettingsCategory>("general");

  const [displayName, setDisplayName] = useState(profile.display_name);
  const [pickingIcon, setPickingIcon] = useState(false);
  const [pickingBanner, setPickingBanner] = useState(false);

  const [repairing, setRepairing] = useState(false);
  const [duplicateName, setDuplicateName] = useState(`${name}-copy`);
  const [duplicating, setDuplicating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [useCustomRam, setUseCustomRam] = useState(profile.use_custom_ram);
  const [maxRam, setMaxRam] = useState(profile.max_ram);
  const [minRam, setMinRam] = useState(profile.min_ram);
  const [javaPath, setJavaPath] = useState(profile.java_path ?? "");
  const [jvmArgs, setJvmArgs] = useState(profile.jvm_arguments);

  // Publish: only when this instance tracks a published pack. `publishInfo` is server-side state
  // (visibility, ownership) that `profile.pack` doesn't carry; see `get_modpack_publish_info`.
  const [publishInfo, setPublishInfo] = useState<{ visibility: string; is_owner: boolean; latest_build: number } | null>(null);
  const [publishInfoLoading, setPublishInfoLoading] = useState(false);
  const [publishInfoError, setPublishInfoError] = useState<string | null>(null);
  const [publishName, setPublishName] = useState(profile.pack?.name ?? "");
  const [publishVisibility, setPublishVisibility] = useState<"public" | "invite">("public");
  const [savingPublish, setSavingPublish] = useState(false);
  const [inviteLogin, setInviteLogin] = useState("");
  const [inviting, setInviting] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [pendingVersion, setPendingVersion] = useState<ModpackVersion | null>(null);
  /** The pack's newest build on its service (and the one installed, when still listed): is this one out of date? */
  const [versionInfo, setVersionInfo] = useState<{ latest: ModpackVersion; current?: ModpackVersion } | null>(null);
  const [confirmDetachService, setConfirmDetachService] = useState(false);
  const [detachingService, setDetachingService] = useState(false);
  const services = useContentServices();
  /** Tied to a service: its name, icon, banner and content are not ours to change until detached. */
  const managed = isManaged(profile);
  /** What the instance follows: the service it was installed from, or NiHao's own. */
  const origin = profile.source ? services.find((x) => x.id === profile.source!.service)?.name ?? profile.source.service : "NiHao";
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [deletingPack, setDeletingPack] = useState(false);
  const [confirmDeletePack, setConfirmDeletePack] = useState(false);

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCategory("general");
    setDisplayName(profile.display_name);
    setDuplicateName(`${name}-copy`);
    setUseCustomRam(profile.use_custom_ram);
    setMaxRam(profile.max_ram);
    setMinRam(profile.min_ram);
    setJavaPath(profile.java_path ?? "");
    setJvmArgs(profile.jvm_arguments);
    setConfirmDelete(false);
    setPublishName(profile.pack?.name ?? "");
    setPublishInfo(null);
    setPublishInfoError(null);
    setInviteLogin("");
    setConfirmDetach(false);
    setConfirmDetachService(false);
    setConfirmDeletePack(false);
    setVersionsOpen(false);
    setPendingVersion(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const source = profile.source;
  useEffect(() => {
    if (!open || !source) return;
    let cancelled = false;
    createServiceClient(call_module, source.service).modpackVersions(source.project_id)
      .then((versions) => {
        const stable = versions.filter((v) => v.version_type === "release");
        const newest = (stable.length > 0 ? stable : versions).reduce<ModpackVersion | null>((a, b) => (!a || Date.parse(b.date_published) > Date.parse(a.date_published) ? b : a), null);
        if (!cancelled && newest) setVersionInfo({ latest: newest, current: versions.find((v) => v.id === source.version_id) });
      })
      .catch(console.error);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source?.service, source?.project_id, source?.version_id]);
  const outdated = !!source && !!versionInfo && versionInfo.latest.id !== source.version_id
    && (!versionInfo.current || Date.parse(versionInfo.latest.date_published) > Date.parse(versionInfo.current.date_published));

  useEffect(() => {
    if (category !== "publish" || !profile.pack || !signedIn) return;
    let cancelled = false;
    setPublishInfoLoading(true);
    setPublishInfoError(null);
    call_module("get_modpack_publish_info", { id: profile.pack.id })
      .then((res: any) => {
        if (cancelled) return;
        setPublishInfo(res ?? null);
        if (res) setPublishVisibility(res.visibility === "invite" ? "invite" : "public");
      })
      .catch((e) => { if (!cancelled) setPublishInfoError(String(e)); })
      .finally(() => { if (!cancelled) setPublishInfoLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, profile.pack?.id, signedIn]);

  // One combined save for every editable field across both categories; all their state stays
  // mounted, so it is safe whichever tab is active.
  async function handleSaveAll() {
    if (!gamePath) return;
    setSaving(true);
    try {
      const trimmedName = displayName.trim();
      if (trimmedName && trimmedName !== profile.display_name) {
        await call_module("rename_modpack", { name, display_name: trimmedName });
      }
      await call_module("update_modpack_settings", {
        name,
        max_ram: maxRam,
        min_ram: minRam,
        use_custom_ram: useCustomRam,
        java_path: javaPath.trim() ? javaPath.trim() : null,
        jvm_arguments: jvmArgs,
      });
      onProfileChange({
        ...profile,
        display_name: trimmedName || profile.display_name,
        max_ram: maxRam,
        min_ram: minRam,
        use_custom_ram: useCustomRam,
        java_path: javaPath.trim() ? javaPath.trim() : null,
        jvm_arguments: jvmArgs,
      });
      onClose();
    } catch (e) {
      reportError(e);
    } finally {
      setSaving(false);
    }
  }

  async function handlePickIcon() {
    if (!gamePath) return;
    try {
      const picked = await openFileDialog({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      setPickingIcon(true);
      const res: any = await call_module("set_modpack_icon", { name, icon_source_path: picked });
      onIconChange(res?.icon_data ?? null);
    } catch (e) {
      reportError(e);
    } finally {
      setPickingIcon(false);
    }
  }

  async function handlePickBanner() {
    if (!gamePath) return;
    try {
      const picked = await openFileDialog({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      setPickingBanner(true);
      const res: any = await call_module("set_modpack_banner", { name, banner_source_path: picked });
      onBannerChange(res?.banner_data ?? null);
    } catch (e) {
      reportError(e);
    } finally {
      setPickingBanner(false);
    }
  }

  async function handleRepair() {
    if (!gamePath) return;
    setRepairing(true);
    try {
      if (profile.source) {
        await call_module("sync_modpack", { name });
      } else {
        await call_module("create_modpack", {
          name,
          core: profile.core.toLowerCase(),
          version: profile.version_id,
          loader: profile.loader_version,
        });
      }
      toast?.({ message: t("minecraft.modpack_settings.repair_started", "Re-verifying files — watch the progress bar at the bottom."), variant: "info" });
    } catch (e) {
      reportError(e);
    } finally {
      setRepairing(false);
    }
  }

  async function handleSwitchVersion() {
    const version = pendingVersion;
    if (!gamePath || !version) return;
    setPendingVersion(null);
    try {
      await call_module("sync_modpack", { name, version_id: version.id, version_number: version.version_number });
      toast?.({ message: t("minecraft.modpack_settings.version_started", "Switching to {version} — watch the progress bar at the bottom.").replace("{version}", version.version_number), variant: "info" });
      onClose();
    } catch (e) {
      reportError(e);
    }
  }

  async function handleDuplicate() {
    if (!gamePath || !duplicateName.trim()) return;
    setDuplicating(true);
    try {
      await call_module("duplicate_modpack", { name, new_name: duplicateName.trim() });
      onDuplicated(duplicateName.trim());
    } catch (e) {
      reportError(e);
    } finally {
      setDuplicating(false);
    }
  }

  async function handleDelete() {
    if (!gamePath) return;
    setDeleting(true);
    try {
      await call_module("delete_modpack", { name });
      onDeleted();
      toast?.({ message: t("minecraft.modpack_settings.delete_done", "Modpack deleted."), variant: "success" });
    } catch (e) {
      const message = String(e);
      setDeleting(false);
      toast?.({ message: `${t("minecraft.modpack_settings.delete_failed", "Couldn't delete the modpack.")} ${message}`, variant: "error" });
    }
  }

  async function handleSavePublish() {
    if (!profile.pack || !signedIn) return;
    setSavingPublish(true);
    try {
      const trimmed = publishName.trim();
      const newName = trimmed && trimmed !== profile.pack.name ? trimmed : null;
      const newVisibility = publishInfo && publishVisibility !== publishInfo.visibility ? publishVisibility : null;
      if (newName || newVisibility) {
        await call_module("update_modpack_publish", {
          id: profile.pack.id,
          name: newName,
          visibility: newVisibility,
        });
      }
      setPublishInfo((prev) => (prev ? { ...prev, visibility: publishVisibility } : prev));
      if (newName) {
        onProfileChange({ ...profile, pack: { ...profile.pack, name: newName } });
      }
    } catch (e) {
      reportError(e);
    } finally {
      setSavingPublish(false);
    }
  }

  async function handleInvite() {
    if (!profile.pack || !signedIn || !inviteLogin.trim()) return;
    setInviting(true);
    try {
      const login = inviteLogin.trim();
      await call_module("invite_to_modpack_publish", { id: profile.pack.id, login });
      toast?.({ message: t("minecraft.modpack_settings.publish_invited", "Invited.").replace("{login}", login), variant: "success" });
      setInviteLogin("");
    } catch (e) {
      reportError(e);
    } finally {
      setInviting(false);
    }
  }

  async function handleDetachService() {
    if (!gamePath) return;
    setDetachingService(true);
    try {
      await call_module("detach_modpack", { name });
      onProfileChange({ ...profile, source: null, pack: null, downloaded: false });
      setConfirmDetachService(false);
      toast?.({ message: t("minecraft.modpack_settings.detach_service_done", "Detached: this is a custom instance now."), variant: "success" });
    } catch (e) {
      const message = String(e);
      toast?.({ message: `${t("minecraft.modpack_settings.publish_detach_failed", "Couldn't detach the pack.")} ${message}`, variant: "error" });
    } finally {
      setDetachingService(false);
    }
  }

  async function handleDetach() {
    if (!gamePath) return;
    setDetaching(true);
    try {
      await call_module("unlink_modpack_publish", { name });
      onProfileChange({ ...profile, pack: null });
      setConfirmDetach(false);
      setCategory("general");
      toast?.({ message: t("minecraft.modpack_settings.publish_detach_done", "Detached from NiHao."), variant: "success" });
    } catch (e) {
      const message = String(e);
      setDetaching(false);
      toast?.({ message: `${t("minecraft.modpack_settings.publish_detach_failed", "Couldn't detach the pack.")} ${message}`, variant: "error" });
    }
  }

  async function handleDeletePack() {
    if (!gamePath || !signedIn || !profile.pack) return;
    setDeletingPack(true);
    try {
      await call_module("delete_online_modpack", { name, id: profile.pack.id });
      onProfileChange({ ...profile, pack: null });
      setConfirmDeletePack(false);
      setCategory("general");
      toast?.({ message: t("minecraft.modpack_settings.publish_delete_done", "Pack deleted from NiHao."), variant: "success" });
    } catch (e) {
      const message = String(e);
      setDeletingPack(false);
      toast?.({ message: `${t("minecraft.modpack_settings.publish_delete_failed", "Couldn't delete the pack from NiHao.")} ${message}`, variant: "error" });
    }
  }

  // minRam (-Xms) has no slider; it is kept in sync with maxRam so it never exceeds it.
  function handleMaxRamChange(v: number) {
    setMaxRam(v);
    if (v < minRam) setMinRam(v);
  }

  const changes: Change[] = [];
  const show = (v: string) => v || "—";
  const ramLabel = (custom: boolean, mb: number) => (custom ? `${mb} MB` : t("minecraft.modpack_settings.ram_general", "general"));
  if (displayName.trim() && displayName.trim() !== profile.display_name) {
    changes.push({ label: t("minecraft.modpack_settings.name_label", "Name"), from: profile.display_name, to: displayName.trim() });
  }
  if (javaPath.trim() !== (profile.java_path ?? "")) {
    changes.push({ label: t("minecraft.modpack_settings.java_path_label", "Java path"), from: show(profile.java_path ?? ""), to: show(javaPath.trim()) });
  }
  if (jvmArgs !== profile.jvm_arguments) {
    changes.push({ label: t("minecraft.modpack_settings.jvm_args_label", "JVM arguments"), from: show(profile.jvm_arguments), to: show(jvmArgs) });
  }
  if (useCustomRam !== profile.use_custom_ram || (useCustomRam && maxRam !== profile.max_ram)) {
    changes.push({
      label: t("minecraft.modpack_settings.max_ram_label", "Maximum memory"),
      from: ramLabel(profile.use_custom_ram, profile.max_ram),
      to: ramLabel(useCustomRam, maxRam),
    });
  }
  function handleCancelEdits() {
    setDisplayName(profile.display_name);
    setJavaPath(profile.java_path ?? "");
    setJvmArgs(profile.jvm_arguments);
    setUseCustomRam(profile.use_custom_ram);
    setMaxRam(profile.max_ram);
    setMinRam(profile.min_ram);
  }
  const { footer, hint } = useSettingsFooter({ changes, saving, canSave: !!gamePath, onSave: handleSaveAll, onCancel: handleCancelEdits });

  return (
    <>
      <Modal
        isOpen={open && !confirmDelete && !confirmDetach && !confirmDetachService && !confirmDeletePack && !versionsOpen && !pendingVersion}
        onClose={onClose}
        title={t("minecraft.modpack_settings.title", "Modpack settings")}
        size="large"
        layout="categories"
        categories={[
          { id: "general", label: t("minecraft.modpack_settings.general", "General"), icon: <SlidersIcon /> },
          { id: "install", label: t("minecraft.modpack_settings.install", "Install"), icon: <DownloadIcon /> },
          // A downloaded (Public) instance is a server-managed mirror: not something to
          // publish/detach/delete from here.
          ...(profile.pack && !profile.downloaded ? [{ id: "publish", label: t("minecraft.modpack_settings.publish", "Publish"), icon: <CloudUploadIcon /> }] : []),
        ]}
        activeCategory={category}
        onCategoryChange={(id: string | number) => setCategory(id as SettingsCategory)}
        footer={footer}
        footerHint={hint}
      >
        {category === "general" && (
          <GeneralTab
            profile={profile}
            managed={managed}
            origin={origin}
            iconData={iconData}
            bannerData={bannerData}
            pickingIcon={pickingIcon}
            pickingBanner={pickingBanner}
            handlePickIcon={handlePickIcon}
            handlePickBanner={handlePickBanner}
            displayName={displayName}
            setDisplayName={setDisplayName}
            source={source}
            outdated={outdated}
            versionInfo={versionInfo}
            setVersionsOpen={setVersionsOpen}
            handleRepair={handleRepair}
            repairing={repairing}
            detachingService={detachingService}
            setConfirmDetachService={setConfirmDetachService}
            duplicateName={duplicateName}
            setDuplicateName={setDuplicateName}
            handleDuplicate={handleDuplicate}
            duplicating={duplicating}
            setConfirmDelete={setConfirmDelete}
            deleting={deleting}
          />
        )}

        {category === "install" && (
          <InstallTab
            javaPath={javaPath}
            setJavaPath={setJavaPath}
            jvmArgs={jvmArgs}
            setJvmArgs={setJvmArgs}
            useCustomRam={useCustomRam}
            setUseCustomRam={setUseCustomRam}
            maxRam={maxRam}
            generalRam={generalRam}
            handleMaxRamChange={handleMaxRamChange}
          />
        )}

        {category === "publish" && profile.pack && (
          <PublishTab
            pack={profile.pack}
            signedIn={signedIn}
            publishInfo={publishInfo}
            publishInfoLoading={publishInfoLoading}
            publishInfoError={publishInfoError}
            publishName={publishName}
            setPublishName={setPublishName}
            publishVisibility={publishVisibility}
            setPublishVisibility={setPublishVisibility}
            savingPublish={savingPublish}
            handleSavePublish={handleSavePublish}
            inviteLogin={inviteLogin}
            setInviteLogin={setInviteLogin}
            inviting={inviting}
            handleInvite={handleInvite}
            setConfirmDetach={setConfirmDetach}
            detaching={detaching}
            setConfirmDeletePack={setConfirmDeletePack}
            deletingPack={deletingPack}
          />
        )}

      </Modal>

      {open && versionsOpen && source && (
        <ModpackVersionsModal
          sources={[{ service: source.service, projectId: source.project_id }]}
          title={source.name}
          onClose={() => setVersionsOpen(false)}
          onChoose={async (picked) => { setVersionsOpen(false); setPendingVersion(picked.version); }}
        />
      )}

      <ConfirmModal
        isOpen={open && !!pendingVersion}
        onCancel={() => setPendingVersion(null)}
        onConfirm={handleSwitchVersion}
        message={t("minecraft.modpack_settings.version_confirm", "Switch \"{name}\" to version {version}? The pack's files are replaced and those this version drops are deleted; changes you made to the pack's configs are overwritten. Saves and settings stay.").replace("{name}", profile.display_name).replace("{version}", pendingVersion?.version_number ?? "")}
        confirmText={t("minecraft.modpack_settings.version_switch", "Switch")}
        icon={<DownloadIcon />}
        confirmIcon={<DownloadIcon />}
      />

      <ConfirmModal
        isOpen={open && confirmDetach}
        onCancel={() => setConfirmDetach(false)}
        onConfirm={handleDetach}
        message={t(
          "minecraft.modpack_settings.publish_detach_confirm",
          "Detach this instance from the published pack? You can re-publish it later to reattach."
        )}
        confirmText={t("minecraft.modpack_settings.publish_detach", "Detach")}
        variant="danger"
      />

      <ConfirmModal
        isOpen={open && confirmDetachService}
        onCancel={() => setConfirmDetachService(false)}
        onConfirm={handleDetachService}
        message={t("minecraft.modpack_settings.detach_service_confirm", "Detach \"{name}\" from {service}? It becomes a custom instance; its files stay as they are.").replace("{name}", profile.display_name).replace("{service}", origin)}
        confirmText={t("minecraft.modpack_settings.publish_detach", "Detach")}
        variant="danger"
      />

      <ConfirmModal
        isOpen={open && confirmDeletePack}
        onCancel={() => setConfirmDeletePack(false)}
        onConfirm={handleDeletePack}
        message={t(
          "minecraft.modpack_settings.publish_delete_confirm",
          "Permanently delete this pack from the server? Every published build, its icon/banner, and everyone else's ability to download it disappear immediately. This cannot be undone."
        )}
        confirmText={t("minecraft.modpack_settings.publish_delete", "Delete pack")}
        variant="danger"
        icon={<TrashIcon />}
        confirmIcon={<TrashIcon />}
      />

      <ConfirmModal
        isOpen={open && confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        message={t("minecraft.modpack_settings.delete_confirm", "Delete \"{name}\"? This removes all its saves and mods permanently.").replace("{name}", profile.display_name)}
        confirmText={t("minecraft.modpack_settings.delete", "Delete instance")}
        variant="danger"
        icon={<TrashIcon />}
        confirmIcon={<TrashIcon />}
      />
    </>
  );
}
