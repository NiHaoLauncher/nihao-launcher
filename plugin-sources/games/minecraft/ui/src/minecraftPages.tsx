import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { t } from "@shared/components/Translate";
import { useCallModule } from "@shared/modules";
import { useBridge } from "@shared";
import ScreenshotsSVG from "@shared/assets/icons/screenshots.svg?react";
import ProfilesIcon from "@shared/assets/icons/shirt.svg?react";
import MarketIcon from "@shared/assets/icons/market.svg?react";
import { useGamePath, useSignedIn } from "./pages/hooks";
import { ProfileManagerContext } from "./pages/profiles";
import { ProfilesPage } from "./pages/profilesPage";
import { ScreenshotsPage } from "./pages/screenshots";
import { MinecraftLaunch } from "./pages/launch";
import { ModpacksList } from "./pages/modpacks";
import { ModpackMarketDetailPage, ModpackMarketPage } from "./pages/market";

/**
 * Core Settings' "Player profiles" button navigates here with `{ kind: "open-profile-manager" }`
 * in `pendingDeepLink`; this watches for it and opens the profiles page (like
 * `usePlayTogetherDeepLink`).
 */
function useProfileManagerDeepLink(openProfileManager: () => void) {
  const pendingDeepLink = useBridge((b) => b.pendingDeepLink);

  useEffect(() => {
    if (pendingDeepLink?.kind === "open-profile-manager") {
      openProfileManager();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDeepLink]);
}

/**
 * Puts this game's buttons into the launcher's quick panel while its page is open. Items are
 * registered once per language; each `onClick` goes through a ref so it runs the current handler
 * without re-registering.
 */
function useQuickPanelButtons(openProfileManager: () => void, openScreenshots: () => void, openMarket: () => void, screenshotsActive: boolean, profilesActive: boolean, marketActive: boolean) {
  const setQuickPanel = useBridge((b) => b.setQuickPanel);
  const languageRevision = useBridge((b) => b.languageRevision);
  const openRef = useRef(openProfileManager);
  openRef.current = openProfileManager;
  const screenshotsRef = useRef(openScreenshots);
  screenshotsRef.current = openScreenshots;
  const marketRef = useRef(openMarket);
  marketRef.current = openMarket;

  useEffect(() => {
    setQuickPanel?.([
      {
        id: "market",
        label: t("minecraft.market.title", "Modpack market"),
        icon: <MarketIcon />,
        onClick: () => marketRef.current(),
        active: marketActive,
      },
      {
        id: "profiles",
        label: t("minecraft.launch.profile_manager", "Player profiles"),
        icon: <ProfilesIcon />,
        onClick: () => openRef.current(),
        active: profilesActive,
      },
      {
        id: "screenshot",
        label: t("minecraft.launch.screenshots", "Screenshots"),
        icon: <ScreenshotsSVG />,
        onClick: () => screenshotsRef.current(),
        active: screenshotsActive,
      },
    ]);
    return () => setQuickPanel?.([]);
  }, [setQuickPanel, languageRevision, screenshotsActive, profilesActive, marketActive]);
}

/**
 * The home banner's "Launch" sends `{ kind: "open-modpack", segments: [name], data }`; with `data` the
 * router starts on the modpack's page (`Root`), without it (a link from elsewhere) the modpack is looked up here. The host clears the link right after mounting, so the lookup must not be cancelled when it
 * goes; returns whether it is still on its way, so the page shows nothing instead of the list meanwhile.
 */
function useOpenModpackDeepLink(): boolean {
  const navigate = useNavigate();
  const call_module = useCallModule();
  const pendingDeepLink = useBridge((b) => b.pendingDeepLink);
  const [resolving, setResolving] = useState(pendingDeepLink?.kind === "open-modpack" && !pendingDeepLink.data);

  useEffect(() => {
    if (pendingDeepLink?.kind !== "open-modpack" || pendingDeepLink.data) return;
    const name = pendingDeepLink.segments[0];
    setResolving(true);
    call_module("get_modpacks", {}).then((list: any) => {
      const found = Array.isArray(list) ? list.find((i: any) => i.name === name) : null;
      if (found) navigate("/play", { replace: true, state: { name: found.name, profile: found.profile, icon_data: found.icon_data, banner_data: found.banner_data } });
    }).catch(console.error).finally(() => setResolving(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDeepLink]);
  return resolving;
}

export function PagesBrowser() {
  const location = useLocation();
  usePlayTogetherDeepLink();
  const openingModpack = useOpenModpackDeepLink();
  const navigate = useNavigate();
  const openProfileManager = () => navigate("/profiles");
  useProfileManagerDeepLink(openProfileManager);
  const onProfiles = location.pathname.startsWith("/profiles");
  const onScreenshots = location.pathname.startsWith("/screenshots");
  const beforeScreenshots = useRef<{ to: string; state: unknown } | null>(null);
  const toggleScreenshots = () => {
    if (onScreenshots) {
      const prev = beforeScreenshots.current;
      navigate(prev?.to ?? "/", { state: prev?.state });
    } else {
      beforeScreenshots.current = { to: location.pathname + location.search, state: location.state };
      navigate("/screenshots");
    }
  };
  const onMarket = location.pathname.startsWith("/market");
  const toggleMarket = () => navigate(onMarket ? "/" : "/market");
  useQuickPanelButtons(openProfileManager, toggleScreenshots, toggleMarket, onScreenshots, onProfiles, onMarket);
  if (openingModpack) return null;
  return (
    <ProfileManagerContext.Provider value={openProfileManager}>
      <Routes>
        {/*
         * `key={location.key}` forces a fresh mount on each navigation to this route:
         * `MinecraftLaunch` navigates to itself after an install, and its `useState(state?.xxx)`
         * initializers would otherwise keep the not-yet-installed preview state.
         */}
        <Route path="/play" element={<MinecraftLaunch key={location.key} />} />
        <Route path="/screenshots" element={<ScreenshotsPage />} />
        <Route path="/profiles" element={<ProfilesPage />} />
        <Route path="/market" element={<ModpackMarketPage />} />
        <Route path="/market/:service/:projectId" element={<ModpackMarketDetailPage />} />
        <Route path="/" element={<ModpacksList />} />
      </Routes>
    </ProfileManagerContext.Provider>
  )
}

/**
 * Discord's "Play together" button points at `nihaolauncher://play-together/minecraft/<packId>`;
 * the module sees `{ kind: "play-together", segments: [packId] }`. Like clicking a "Public" tile:
 * go to `/play` if the pack is already downloaded, else open the not-yet-installed preview.
 */
function usePlayTogetherDeepLink() {
  const navigate = useNavigate();
  const call_module = useCallModule();
  const gamePath = useGamePath();
  const signedIn = useSignedIn();
  const pendingDeepLink = useBridge((b) => b.pendingDeepLink);

  useEffect(() => {
    if (!pendingDeepLink || pendingDeepLink.kind !== "play-together" || !gamePath || !signedIn) return;
    const packId = pendingDeepLink.segments[0];
    if (!packId) return;
    let cancelled = false;
    (async () => {
      const instances: any = await call_module("get_modpacks", {}).catch(() => null);
      if (cancelled) return;
      const existing = Array.isArray(instances) ? instances.find((i: any) => i.profile?.pack?.id === packId) : null;
      if (existing) {
        navigate("/play", { state: { name: existing.name, profile: existing.profile, icon_data: existing.icon_data, banner_data: existing.banner_data } });
        return;
      }

      const catalog: any = await call_module("list_online_modpacks", {}).catch(() => null);
      if (cancelled) return;
      const mp = Array.isArray(catalog) ? catalog.find((m: any) => m.id === packId) : null;
      if (mp) {
        navigate("/play", {
          state: {
            publicPreview: true,
            publicId: mp.id,
            packName: mp.name,
            icon_data: mp.icon_data_uri ?? null,
            banner_data: mp.banner_data_uri ?? null,
          },
        });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDeepLink, gamePath, signedIn]);
}
