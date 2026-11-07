import { useEffect, useState } from "react";
import { t } from "@shared/components/Translate";
import { useCallModule } from "@shared/modules";
import { useBridge } from "@shared";
import PlayIcon from "@shared/assets/icons/play.svg?react";
import ClockIcon from "@shared/assets/icons/clock.svg?react";
import GamepadIcon from "@shared/assets/icons/gamepad.svg?react";
import RefreshIcon from "@shared/assets/icons/refresh.svg?react";
import PACKAGE from "@shared/assets/package.png";
import { formatLastPlayed, formatPlaytime } from "./helpers";
import { LoaderLabel } from "./components";
import { useBackgroundImage } from "./hooks";

/**
 * What the launcher's main page shows for this game (`view: "home"`): the modpack played last, with
 * its banner, how long it was played and a way back into it, plus a notice when its NiHao Client mod
 * has a newer build.
 */
export function HomeBanner() {
  const call_module = useCallModule();
  const openGame = useBridge((b) => b.openGame);
  const languageRevision = useBridge((b) => b.languageRevision);
  const [last, setLast] = useState<any | null | undefined>(undefined);
  const [clientUpdate, setClientUpdate] = useState<string | null>(null);
  const defaultBackground = useBackgroundImage();

  useEffect(() => {
    let cancelled = false;
    call_module("get_modpacks", {}).then((list: any) => {
      const played = (Array.isArray(list) ? list : []).filter((m: any) => m.profile?.last_played);
      const newest = played.sort((a: any, b: any) => b.profile.last_played - a.profile.last_played)[0] ?? null;
      if (cancelled) return;
      setLast(newest);
      if (newest) {
        call_module("get_nihao_client_status", { name: newest.name })
          .then((s: any) => !cancelled && setClientUpdate(s?.update ? s.build?.version ?? "" : null))
          .catch(() => {});
      }
    }).catch(() => setLast(null));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!last) return null;
  const profile = last.profile;
  const background = last.banner_data ?? defaultBackground;
  const open = () => openGame?.({ kind: "open-modpack", segments: [last.name], data: { name: last.name, profile: last.profile, icon_data: last.icon_data, banner_data: last.banner_data } });
  return (
    <div className="home-banner" onClick={open} style={background ? { backgroundImage: `linear-gradient(90deg, rgba(0,0,0,0.75), rgba(0,0,0,0.15)), url(${background})` } : undefined} key={languageRevision}>
      <div className="home-banner-body">
        <div className="home-banner-head">
          <img className="home-banner-icon" src={last.icon_data ?? PACKAGE} alt="" />
          <div>
            <small className="home-banner-kicker"><GamepadIcon width={14} height={14} /> {t("minecraft.home.continue", "Continue playing")}</small>
            <h2>{profile.display_name || last.name}</h2>
          </div>
        </div>
        <div className="launch-chips">
          <span className="launch-chip">
            <LoaderLabel loader={String(profile.core)} label="" />
            <span className="launch-chip-text">
              <b>{String(profile.core)}</b>
              <small>{[profile.version_id, profile.loader_version].filter(Boolean).join(" · ")}</small>
            </span>
          </span>
          <span className="launch-chip">
            <ClockIcon className="launch-chip-logo" />
            <span className="launch-chip-text">
              <b>{t("minecraft.launch.playtime", "Playtime")}</b>
              <small>{formatPlaytime(profile.play_secs)}</small>
            </span>
          </span>
          <span className="launch-chip">
            <PlayIcon className="launch-chip-logo" />
            <span className="launch-chip-text">
              <b>{t("minecraft.launch.last_played", "Last played")}</b>
              <small>{formatLastPlayed(profile.last_played)}</small>
            </span>
          </span>
          {clientUpdate !== null && (
            <span className="launch-chip launch-nihao-chip has-update">
              <RefreshIcon className="launch-chip-logo" />
              <span className="launch-chip-text">
                <b>{t("minecraft.launch.nihao_client", "NiHao Client")}</b>
                <small>{t("minecraft.home.client_update", "Update available")}{clientUpdate ? ` · ${clientUpdate}` : ""}</small>
              </span>
            </span>
          )}
        </div>
        <button className="modpack-play-btn home-banner-play" onClick={open}>
          <PlayIcon width={18} height={18} /> {t("minecraft.launch.button", "Launch")}
        </button>
      </div>
    </div>
  );
}
