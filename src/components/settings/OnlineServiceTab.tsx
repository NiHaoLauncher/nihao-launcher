import { useEffect, useRef, useState } from "react";
import { SlotBoundary, t, useSlots } from "@shared";
import type { LinkState, OnlineServiceProps } from "@shared";
import { useAuth } from "../../context/AuthContext";
import { useLoginModal } from "../../hooks/useLoginModal";
import SimpleOnlineService from "./SimpleOnlineService";
import { useModuleServices } from "./useModuleServices";

/**
 * Settings > Online Service. Does the work (the launcher's connection, polling each module's
 * server, refreshing in order, signing in) and hands the result to a view: the theme's
 * `slots.OnlineService` or the built-in one.
 */
export default function OnlineServiceTab() {
  const { status, user, reconnect } = useAuth();
  const openLoginModal = useLoginModal();
  const [moduleRefreshSignal, setModuleRefreshSignal] = useState(0);
  const moduleServices = useModuleServices(moduleRefreshSignal);
  // Set by Refresh, cleared when `status` settles (leaves "connecting"); module services refresh
  // only if it settles on "authenticated": general server first, module servers once it is back.
  const awaitingGeneralRef = useRef(false);

  useEffect(() => {
    if (!awaitingGeneralRef.current || status === "connecting") return;
    awaitingGeneralRef.current = false;
    if (status === "authenticated") {
      setModuleRefreshSignal((n) => n + 1);
    }
  }, [status]);

  const uplink: LinkState =
    status === "authenticated" ? "locked"
      : status === "anonymous" ? "standby"
        : status === "connecting" ? "searching"
          : "lost"; // unavailable, or idle (never tried)

  const label = (connected: boolean | null) =>
    connected === null
      ? t("status_connecting", "Connecting...")
      : connected
        ? t("status_connected", "Connected")
        : t("status_disconnected", "Not connected");

  const props: OnlineServiceProps = {
    uplink: {
      state: uplink,
      label: label(status === "connecting" ? null : status === "authenticated" || status === "anonymous"),
      account: status === "authenticated"
        ? t("status_signed_in", "Signed in") + (user ? ` (${user.displayname})` : "")
        : t("status_signed_out", "Not signed in"),
    },
    servers: moduleServices.map((svc) => ({
      id: svc.moduleId,
      name: svc.name,
      icon: svc.icon,
      state: svc.connected === null ? "searching" : svc.connected ? "locked" : "lost",
      label: label(svc.connected),
    })),
    canSignIn: status === "anonymous",
    onSignIn: () => openLoginModal(),
    refreshing: status === "connecting",
    onRefresh: () => {
      awaitingGeneralRef.current = true;
      reconnect();
    },
    // Sign-in is by emailed code now, so there is no password to manage.
    canManageProfile: false,
    onManageProfile: () => {},
  };

  const View = useSlots().OnlineService;
  const builtIn = <SimpleOnlineService {...props} />;

  return View ? (
    <SlotBoundary slot="OnlineService" fallback={builtIn}>
      <View {...props} />
    </SlotBoundary>
  ) : builtIn;
}
