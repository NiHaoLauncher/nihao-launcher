import { ReactNode, useEffect, useRef } from "react";
import { t } from "@shared";
import { useAuth } from "../context/AuthContext";
import { useModal } from "../context/ModalContext";
import GetUserData from "../launcher/Authorization";

interface LoginModalOptions {
  /**
   * Whether the player can dismiss the modal without signing in (X, backdrop, Escape); default
   * `true`. `false` for a forced re-login (e.g. a rejected stored session), which needs an
   * explicit way out (see `extra`).
   */
  dismissible?: boolean;
  /**
   * Extra content below the login form, e.g. `initialization.tsx`'s "continue offline" button for
   * a forced re-login.
   */
  extra?: ReactNode;
}

/**
 * The one login prompt for the whole app. Opened through `openModal` (stacks, so it layers on top
 * even from inside another modal) and closes itself once `AuthContext.status` becomes
 * "authenticated".
 */
export function useLoginModal() {
  const { status } = useAuth();
  const { openModal, closeModal } = useModal();
  // Id of the modal this hook's latest call opened, so the auto-close effect closes exactly that
  // one, not whatever is topmost.
  const openIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (openIdRef.current && status === "authenticated") {
      closeModal(openIdRef.current);
      openIdRef.current = null;
    }
  }, [status, closeModal]);

  return (options?: LoginModalOptions) => {
    const dismissible = options?.dismissible ?? true;
    openIdRef.current = openModal({
      title: t("init.sign_in_title", "Sign in"),
      size: "small",
      showCloseButton: dismissible,
      closeOnBackdrop: dismissible,
      closeOnEscape: dismissible,
      onClose: () => { openIdRef.current = null; },
      content: (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "1rem" }}>
          <GetUserData />
          {options?.extra}
        </div>
      ),
    });
  };
}
