import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { Modal, t } from "@shared";
import { useApplication } from "../state/Application";

/** Matches `AFK_THRESHOLD` in `discord_presence.rs`: the presence and this modal flip together. */
const AFK_AFTER_MS = 10 * 60 * 1000;
const CHECK_EVERY_MS = 15_000;

/**
 * Shown when the launcher is open but nobody has touched the mouse or keyboard for a while. It
 * stays until its button is pressed, which is also when Discord presence leaves "Inactive user"
 * (`App.tsx` sends no activity pulses meanwhile). Not while a game runs: the launcher is in the
 * background then and its window sees no input by design.
 */
export function AfkModal() {
  const afk = useApplication((s) => s.afk);

  useEffect(() => {
    let lastInput = Date.now();
    const onInput = () => { lastInput = Date.now(); };
    const events = ["mousemove", "mousedown", "keydown", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, onInput));
    const timer = setInterval(() => {
      const { playing, afk, setAfk } = useApplication.getState();
      if (!afk && !playing && Date.now() - lastInput > AFK_AFTER_MS) setAfk(true);
    }, CHECK_EVERY_MS);
    return () => {
      events.forEach((e) => window.removeEventListener(e, onInput));
      clearInterval(timer);
    };
  }, []);

  function back() {
    useApplication.getState().setAfk(false);
    invoke("discord_presence_notify_active").catch(() => {});
  }

  return (
    <Modal
      isOpen={afk}
      onClose={back}
      closeOnEscape={false}
      closeOnBackdrop={false}
      showCloseButton={false}
      title={t("afk.title", "Are you still there?")}
      size="small"
      footer={<button className="btn-primary" onClick={back}>{t("afk.back", "I'm back")}</button>}
    >
      {/* A GIF goes here. */}
      <p style={{ margin: 0, textAlign: "center" }}>{t("afk.message", "You seem to be away.")}</p>
    </Modal>
  );
}
