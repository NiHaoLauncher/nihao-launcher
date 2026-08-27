import { useEffect, useRef } from "react";
import "./Modal.css";

interface ConfirmModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "primary" | "danger";
}

export default function ConfirmModal({
  isOpen,
  onConfirm,
  onCancel,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "primary",
}: ConfirmModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const modalOverlays = document.querySelectorAll('.modal-overlay');
        const topmostModal = modalOverlays[modalOverlays.length - 1];
        const isTopmost = topmostModal === e.target || topmostModal?.contains(e.target as Node);

        if (isTopmost || modalOverlays.length === 1) {
          onCancel();
        }
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onCancel]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const allModals = Array.from(document.querySelectorAll('.modal-overlay'));
      const topmostModal = allModals[allModals.length - 1];
      const isTopmost = modalRef.current?.closest('.modal-overlay') === topmostModal;
      if (!isTopmost) return;

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
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-container modal-size-small">
        <div className="modal-body">
          <div className="modal-content">
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
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
