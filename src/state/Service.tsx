import { create } from "zustand";
import type { AuthStatus } from "../context/AuthContext";
import type { AuthUser } from "../launcher/api";

/** Connection to the NiHao server and the signed-in session. Mirrored from `AuthProvider`
 *  (which still owns the connection lifecycle for now) so anything outside React's tree — the
 *  game-module bridge in particular — can read and subscribe to it. */
interface ServiceState {
  status: AuthStatus;
  user: AuthUser | null;
  sync: (patch: Pick<ServiceState, "status" | "user">) => void;
}

export const useService = create<ServiceState>((set) => ({
  status: "connecting",
  user: null,
  sync: (patch) => set(patch),
}));
