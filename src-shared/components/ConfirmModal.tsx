import { ReactNode, useEffect, useRef } from "react";
import { t } from "../i18n";
import WarningIcon from "../assets/icons/warning.svg?react";
import "./Modal.css";
import { usePresence } from "./presence";
import { useModalBehaviors } from "./modalBehaviors";
import { useModalStack } from "./modalStack";

interface ConfirmModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "primary" | "danger";
  /** Big icon above the message. `danger` defaults to a warning sign (pass e.g. a trash can for a delete); `null` for none. */
  icon?: ReactNode | null;
  /** Icon inside the confirm button. `danger` defaults to a warning sign; `null` for none. */
  confirmIcon?: ReactNode | null;
}

export default function ConfirmModal({
  isOpen,
  onConfirm,
  onCancel,
  message,
  confirmText = t("button_confirm", "Confirm"),
  cancelText = t("button_cancel", "Cancel"),
  variant = "primary",
  icon,
  confirmIcon,
}: ConfirmModalProps) {
  const danger = variant === "danger";
  const bigIcon = icon === undefined ? (danger ? <WarningIcon /> : null) : icon;
  const buttonIcon = confirmIcon === undefined ? (danger ? <WarningIcon /> : null) : confirmIcon;
  const modalRef = useRef<HTMLDivElement>(null);
  const { present, closing } = usePresence(isOpen);

  useModalBehaviors(modalRef, [present]);

  const isTopmost = useModalStack(isOpen);

  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopmost()) onCancel();
    };

    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onCancel, isTopmost]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!isTopmost()) return;

      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.body.style.overflow = "hidden";
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.body.style.overflow = "unset";
    };
  }, [isOpen, onCancel, isTopmost]);

  if (!present) return null;

  return (
    <div className={`modal-overlay${danger ? " modal-overlay-danger" : ""}${closing ? " closing" : ""}`}>
      <div className={`modal-container modal-size-small${danger ? " confirm-danger" : ""}`} ref={modalRef}>
        <div className="modal-body">
          <div className="modal-content">
            {bigIcon && <div className="confirm-icon">{bigIcon}</div>}
            <p className="confirm-message">{message}</p>
          </div>
        </div>
        <div className="modal-footer confirm-actions">
          <button
            onClick={onCancel}
            type="button"
          >
            {cancelText}
          </button>
          <button
            className={`btn-${variant}`}
            onClick={onConfirm}
            type="button"
          >
            {buttonIcon}
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
