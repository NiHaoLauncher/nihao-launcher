// Creating an instance: from scratch, from a file, from a service or from NiHao's public list.
import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/api/dialog";
import { t } from "@shared/components/Translate";
import { Modal, OptionRow, HoverHint, useBridge } from "@shared";
import NIHAO_ICON from "@shared/assets/nihao-icon.png";
import GamepadIcon from "@shared/assets/icons/gamepad.svg?react";
import LayersIcon from "@shared/assets/icons/layers.svg?react";
import PencilIcon from "@shared/assets/icons/file.svg?react";
import { useCallModule } from "@shared/modules";
import { LOADERS } from "../index";
import SearchIcon from "@shared/assets/icons/search.svg?react";
import CubesIcon from "@shared/assets/icons/cubes.svg?react";
import ZipFileIcon from "@shared/assets/icons/zipfile.svg?react";
import { LOADERS_WITH_BUILD_VERSION, ImportPreview } from "./types";
import { useGamePath, useAssetIcon } from "./hooks";
import { LoaderLabel } from "./components";

export function CreateModpackModal(
  { open, onClose, onCreated }: { open: boolean, onClose: () => void, onCreated: () => void }
) {
  const call_module = useCallModule();
  const gamePath = useGamePath();
  // The general "Use NiHao Client by default" setting; on until the player turns it off.
  const nihaoByDefault = useBridge((b) => b.gameSettings)?.default_nihao_client !== false;
  const modrinthIcon = useAssetIcon("minecraft/services/modrinth.png");

  const [menu, setMenu] = useState<"variants" | "custom" | "install">("variants");
  const [name, setName] = useState("");
  const [loader, setLoader] = useState("vanilla");
  const [versions, setVersions] = useState<string[]>([]);
  const [version, setVersion] = useState("");
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [loaderVersions, setLoaderVersions] = useState<string[]>([]);
  const [loaderVersion, setLoaderVersion] = useState("");
  const [loadingLoaderVersions, setLoadingLoaderVersions] = useState(false);
  const [nihaoBuild, setNihaoBuild] = useState<{ version: string } | null>(null);
  const [useNihao, setUseNihao] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [importSourcePath, setImportSourcePath] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importName, setImportName] = useState("");
  const [importIconUrl, setImportIconUrl] = useState<string | null>(null);
  const [peeking, setPeeking] = useState(false);
  const [installing, setInstalling] = useState(false);

  const navigate = useNavigate();

  // Also drives the "raw" import confirm screen's version picker: a manifest-less .zip has no
  // version/loader of its own, so it reuses "Custom setup"'s state.
  const needsManualPick = menu === "custom" || (menu === "install" && importPreview?.format === "raw");

  useEffect(() => {
    if (!needsManualPick) return;
    setLoadingVersions(true);
    call_module("get_versions", { core: loader })
      .then((res: any) => {
        const list: string[] = Array.isArray(res) ? res : [];
        setVersions(list);
        setVersion(list[0] ?? "");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingVersions(false));
  }, [needsManualPick, loader]);

  // Loader build versions depend on the game version; only for loaders with a build number
  // (Fabric, NeoForge).
  useEffect(() => {
    if (!needsManualPick || !LOADERS_WITH_BUILD_VERSION.includes(loader) || !version) {
      setLoaderVersions([]);
      setLoaderVersion("");
      return;
    }
    setLoadingLoaderVersions(true);
    call_module("get_loader_versions", { core: loader, version })
      .then((res: any) => {
        const list: string[] = Array.isArray(res) ? res : [];
        setLoaderVersions(list);
        setLoaderVersion(list[0] ?? "");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingLoaderVersions(false));
  }, [menu, loader, version]);

  // The NiHao Client build for the picked loader + game version; the checkbox shows only when one exists.
  useEffect(() => {
    setNihaoBuild(null);
    setUseNihao(nihaoByDefault);
    if (menu !== "custom" || !version || loadingVersions) return;
    let stale = false;
    call_module("get_nihao_client", { core: loader, version })
      .then((res: any) => { if (!stale) setNihaoBuild(res ?? null); })
      .catch(() => {});
    return () => { stale = true; };
  }, [menu, loader, version, loadingVersions, nihaoByDefault]);

  const closeFun = () => {
    setMenu("variants"); setName(""); setError(null);
    setImportSourcePath(null); setImportPreview(null); setImportName(""); setImportIconUrl(null);
    onClose();
  };

  async function handlePickImportFile() {
    const picked = await openFileDialog({
      multiple: false,
      filters: [{ name: "Modpack", extensions: ["zip", "mrpack"] }],
    });
    if (!picked || Array.isArray(picked)) return;
    setError(null);
    setImportPreview(null);
    setPeeking(true);
    setMenu("install");
    try {
      const preview: any = await call_module("peek_modpack_file", { source_path: picked });
      setImportSourcePath(picked);
      setImportPreview(preview);
      setImportName(preview?.name ?? "");
      setImportIconUrl(null);
    } catch (e) {
      setError(String(e));
      setMenu("variants");
    } finally {
      setPeeking(false);
    }
  }

  async function handleImport() {
    if (!gamePath || !importSourcePath || !importName.trim()) return;
    if (importPreview?.format === "raw" && !version) return;
    setInstalling(true);
    setError(null);
    try {
      const isRaw = importPreview?.format === "raw";
      await call_module("import_modpack", {
        name: importName.trim(),
        source_path: importSourcePath,
        minecraft_version: isRaw ? version : null,
        loader: isRaw ? loader : null,
        loader_version: isRaw && LOADERS_WITH_BUILD_VERSION.includes(loader) ? (loaderVersion || null) : null,
        icon_url: importIconUrl,
        banner_url: null,
        source: null,
      });
      onCreated();
      closeFun();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  }

  async function handleCreate() {
    if (!gamePath || !name.trim() || !version) return;
    setCreating(true);
    setError(null);
    try {
      await call_module("create_modpack", {
        name: name.trim(),
        core: loader,
        version,
        loader: LOADERS_WITH_BUILD_VERSION.includes(loader) ? (loaderVersion || null) : null,
        nihao_client: useNihao && !!nihaoBuild,
      });
      onCreated();
      closeFun();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <Modal
        isOpen={open && menu === "variants"}
        onClose={closeFun}
        title={t("minecraft.create_modpack.title", "Create Modpack")}
        size="large"
      >
        <div className="create-variants">
          <div className="create-variants-col">
            <div className="variant instance" onClick={() => setMenu("custom")}>
              <span className="variant-icon"><CubesIcon /></span>
              <div>
                <h2>{t("minecraft.create_modpack.custom_variant", "Custom setup")}</h2>
                <p>{t("minecraft.create_modpack.custom_variant_hint", "Start from scratch by picking a loader and game version.")}</p>
              </div>
            </div>
            <div className="variant instance" onClick={handlePickImportFile}>
              <span className="variant-icon"><ZipFileIcon /></span>
              <div>
                <h2>{t("minecraft.create_modpack.install_variant", "Install modpack")}</h2>
                <p>{t("minecraft.create_modpack.install_variant_hint", "Load a modpack file — our own format, Modrinth's .mrpack or a CurseForge pack.")}</p>
              </div>
            </div>
          </div>
          <div className="create-variants-col">
            <div className="variant instance variant-fill" onClick={() => { closeFun(); navigate("/market"); }}>
              <span className="variant-icon"><SearchIcon /></span>
              <div>
                <h2>
                  {t("minecraft.create_modpack.browse_variant", "Modpack market")}
                  {modrinthIcon && <img className="variant-service" src={modrinthIcon} alt="Modrinth" title="Modrinth" />}
                </h2>
                <p>{t("minecraft.create_modpack.browse_variant_hint", "Find and download a modpack from online services.")}</p>
              </div>
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={open && menu === "custom"}
        onClose={closeFun}
        title={t("minecraft.create_modpack.title", "Create Modpack")}
        size="medium"
        footer={
          <>
            <button onClick={() => setMenu("variants")} disabled={creating}>{t("minecraft.create_modpack.back", "Back")}</button>
            <button
              className="btn-primary"
              onClick={handleCreate}
              disabled={creating || !name.trim() || !version}
            >
              {creating ? t("minecraft.create_modpack.creating", "Creating...") : t("minecraft.create_modpack.create", "Create instance")}
            </button>
          </>
        }
      >
        <div className="settings-tab">
          <OptionRow stack icon={<PencilIcon className="settings-icon" />} label={t("minecraft.create_modpack.name_label", "Name")}>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </OptionRow>
          <OptionRow stack icon={<CubesIcon className="settings-icon" />} label={t("minecraft.create_modpack.loader_label", "Loader")}>
            <div className="create-loaders">
              {LOADERS.map((item) => (
                <button
                  key={item.value}
                  onClick={() => setLoader(item.value)}
                  style={{ backgroundColor: item.value === loader ? "var(--main-color)" : "" }}
                >
                  <LoaderLabel loader={item.value} label={item.label} />
                </button>
              ))}
            </div>
          </OptionRow>
          <OptionRow icon={<GamepadIcon className="settings-icon" />} label={t("minecraft.create_modpack.version_label", "Game version")}>
            <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={loadingVersions}>
              {loadingVersions && <option>Loading...</option>}
              {!loadingVersions && versions.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </OptionRow>
          {LOADERS_WITH_BUILD_VERSION.includes(loader) && (
            <OptionRow icon={<LayersIcon className="settings-icon" />} label={t("minecraft.create_modpack.loader_version_label", "Loader version")}>
              <select
                value={loaderVersion}
                onChange={(e) => setLoaderVersion(e.target.value)}
                disabled={loadingLoaderVersions || loaderVersions.length === 0}
              >
                {loadingLoaderVersions && <option>Loading...</option>}
                {!loadingLoaderVersions && loaderVersions.length === 0 && <option>No loader versions found</option>}
                {!loadingLoaderVersions && loaderVersions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </OptionRow>
          )}
          {nihaoBuild && (
            <HoverHint text={t("minecraft.create_modpack.use_nihao_client_hint", "Adds our mod to the instance: Ely.by skins and the screenshot gallery.")}>
              <div className="settings-field">
                <label className="settings-checkbox-label">
                  <input type="checkbox" checked={useNihao} onChange={(e) => setUseNihao(e.target.checked)} />
                  <img className="settings-icon" src={NIHAO_ICON} alt="" />
                  <span className="settings-option-text">{t("minecraft.create_modpack.use_nihao_client", "Use NiHao Client")} ({nihaoBuild.version})</span>
                </label>
              </div>
            </HoverHint>
          )}
        </div>
        {error && <p style={{ color: "var(--nh-danger)", fontSize: "0.85rem" }}>{error}</p>}
      </Modal>

      <Modal
        isOpen={open && menu === "install"}
        onClose={closeFun}
        title={t("minecraft.create_modpack.title", "Create Modpack")}
        size="medium"
        footer={
          <>
            <button onClick={() => setMenu("variants")} disabled={installing}>Back</button>
            <button
              className="btn-primary"
              onClick={handleImport}
              disabled={
                installing || peeking || !importPreview || !importName.trim() ||
                (importPreview?.format === "raw" && !version)
              }
            >
              {installing
                ? t("minecraft.create_modpack.installing", "Installing...")
                : t("minecraft.create_modpack.install", "Install modpack")}
            </button>
          </>
        }
      >
        <div className="option-container">
          {peeking && (
            <p className="modpack-option-hint">
              {t("minecraft.create_modpack.reading_file", "Reading modpack file...")}
            </p>
          )}
          {importPreview && (
            <>
              <div className="option">
                <label>{t("minecraft.modpack_settings.name_label", "Name")}</label>
                <input type="text" value={importName} onChange={(e) => setImportName(e.target.value)} />
              </div>
              <div className="option">
                <label>{t("minecraft.create_modpack.format_label", "Format")}</label>
                <p className="modpack-option-hint">
                  {importPreview.format === "own" || importPreview.format === "full"
                    ? t("minecraft.share.own_format", "Our format (.zip)")
                    : importPreview.format === "mrpack"
                    ? t("minecraft.share.mrpack_format", "Modrinth (.mrpack)")
                    : importPreview.format === "curseforge"
                    ? t("minecraft.share.curseforge_format", "CurseForge (.zip)")
                    : t("minecraft.share.raw_format", "Plain .zip (no manifest)")}
                </p>
              </div>
              {importPreview.format === "raw" ? (
                <>
                  <div className="option">
                    <label>Loader</label>
                    <div style={{ display: "flex", flexDirection: "row" }}>
                      {LOADERS.map((item) => (
                        <button
                          key={item.value}
                          onClick={() => setLoader(item.value)}
                          style={{ backgroundColor: item.value === loader ? "var(--main-color)" : "" }}
                        >
                          <LoaderLabel loader={item.value} label={item.label} />
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="option">
                    <label>Game version</label>
                    <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={loadingVersions}>
                      {loadingVersions && <option>Loading...</option>}
                      {!loadingVersions && versions.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                  {LOADERS_WITH_BUILD_VERSION.includes(loader) && (
                    <div className="option">
                      <label>Loader version</label>
                      <select
                        value={loaderVersion}
                        onChange={(e) => setLoaderVersion(e.target.value)}
                        disabled={loadingLoaderVersions || loaderVersions.length === 0}
                      >
                        {loadingLoaderVersions && <option>Loading...</option>}
                        {!loadingLoaderVersions && loaderVersions.length === 0 && <option>No loader versions found</option>}
                        {!loadingLoaderVersions && loaderVersions.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                  )}
                </>
              ) : (
                <div className="option">
                  <label>{t("minecraft.create_modpack.detected_label", "Detected")}</label>
                  <p className="modpack-option-hint">
                    {importPreview.minecraft_version} · {importPreview.loader}
                    {importPreview.loader_version ? ` ${importPreview.loader_version}` : ""}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
        {error && <p style={{ color: "var(--nh-danger)", fontSize: "0.85rem" }}>{error}</p>}
      </Modal>
    </>
  );
}
