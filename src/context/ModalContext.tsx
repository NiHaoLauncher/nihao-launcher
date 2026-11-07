import { createContext, useContext, useState, useCallback, useRef, ReactNode } from "react";
import { Modal, ConfirmModal, modalCloseMs, animationsOff } from "@shared";
import { useLocalization } from "../state/Localization";

interface ConfirmOptions {
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "primary" | "danger";
  icon?: ReactNode | null;
  confirmIcon?: ReactNode | null;
}

type ConfirmResolver = (result: boolean) => void;

interface OpenModalOptions {
  title: string;
  content: ReactNode;
  footer?: ReactNode;
  /** Left-hand command-line text of the footer (see `Modal`). */
  footerHint?: ReactNode;
  size?: "small" | "medium" | "large" | "full";
  /** Fixed height (px, or a CSS length string) instead of following the content — see `Modal`. */
  height?: "auto" | number | string;
  layout?: "default" | "categories";
  categories?: { id: string | number; label: string; icon?: React.ReactNode }[];
  activeCategory?: string | number;
  onCategoryChange?: (categoryId: string | number) => void;
  showCloseButton?: boolean;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  /** Called right before the modal is dismissed (X, Escape, backdrop click, or `closeModal()`). */
  onClose?: () => void;
  /**
   * Reuses an already-open modal with this id instead of stacking a new one (e.g. Settings
   * updating its single modal on tab change). Omit it, or pass a fresh id, to open an independent
   * modal that layers on top.
   */
  id?: string;
}

interface ModalEntry extends OpenModalOptions {
  id: string;
  /** Set while the modal plays its close animation, just before it is removed. */
  closing?: boolean;
}

interface ModalContextType {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /**
   * Returns the modal's id (also when none was passed), so it can be closed later with
   * `closeModal(id)`.
   */
  openModal: (options: OpenModalOptions) => string;
  /** Closes the modal matching `id`, or the topmost one when omitted. No-op if none is open. */
  closeModal: (id?: string) => void;
}

const ModalContext = createContext<ModalContextType | null>(null);

let nextModalId = 0;

export function ModalProvider({ children }: { children: ReactNode }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmOptions, setConfirmOptions] = useState<ConfirmOptions>({ message: "" });
  const [, setConfirmResolver] = useState<ConfirmResolver | null>(null);

  // A real stack: several modals can be open at once. `modalsRef` mirrors `modals` so the
  // deps-free `closeModal` always reads the current stack.
  const [modals, setModals] = useState<ModalEntry[]>([]);
  // Open modals hold the `content` created when they opened, which React won't re-render, so
  // depend on the language revision to refresh their text.
  const languageRevision = useLocalization((s) => s.revision);
  const modalsRef = useRef<ModalEntry[]>([]);
  modalsRef.current = modals;

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    setConfirmOptions(options);
    setConfirmOpen(true);
    return new Promise<boolean>((resolve) => {
      setConfirmResolver(() => resolve);
    });
  }, []);

  const handleConfirmClose = useCallback((result: boolean) => {
    setConfirmOpen(false);
    setConfirmResolver((prevResolver: ConfirmResolver | null) => {
      if (prevResolver) prevResolver(result);
      return null;
    });
  }, []);

  const openModal = useCallback((options: OpenModalOptions): string => {
    const id = options.id ?? `modal-${nextModalId++}`;
    const entry: ModalEntry = { ...options, id };
    setModals((prev) => {
      const exists = prev.some((m) => m.id === id);
      return exists ? prev.map((m) => (m.id === id ? entry : m)) : [...prev, entry];
    });
    return id;
  }, []);

  const closeModal = useCallback((id?: string) => {
    const current = modalsRef.current.filter((m) => !m.closing);
    if (current.length === 0) return;
    const targetId = id ?? current[current.length - 1].id;
    const target = current.find((m) => m.id === targetId);
    if (!target) return;
    target.onClose?.();
    setModals((prev) => prev.map((m) => (m.id === targetId ? { ...m, closing: true } : m)));
    setTimeout(
      () => setModals((prev) => prev.filter((m) => m.id !== targetId || !m.closing)),
      animationsOff() ? 0 : modalCloseMs(),
    );
  }, []);

  return (
    <ModalContext.Provider value={{ confirm, openModal, closeModal }}>
      {children}

      {/*
       * Rendered in open order so a later (stacked) modal paints on top; `Modal` only dismisses
       * the topmost.
       */}
      {modals.map((m) => (
        <Modal
          key={`${m.id}:${languageRevision}`}
          isOpen={!m.closing}
          onClose={() => closeModal(m.id)}
          title={m.title}
          size={m.size}
          height={m.height}
          layout={m.layout}
          categories={m.categories}
          activeCategory={m.activeCategory}
          onCategoryChange={m.onCategoryChange}
          showCloseButton={m.showCloseButton}
          closeOnBackdrop={m.closeOnBackdrop}
          closeOnEscape={m.closeOnEscape}
          footer={m.footer}
          footerHint={m.footerHint}
        >
          {m.content}
        </Modal>
      ))}

      {/*
       * After the generic ones: it is often opened from inside one, and a later overlay paints
       * above an earlier one.
       */}
      <ConfirmModal
        isOpen={confirmOpen}
        onConfirm={() => handleConfirmClose(true)}
        onCancel={() => handleConfirmClose(false)}
        message={confirmOptions.message}
        confirmText={confirmOptions.confirmText}
        cancelText={confirmOptions.cancelText}
        variant={confirmOptions.variant}
        icon={confirmOptions.icon}
        confirmIcon={confirmOptions.confirmIcon}
      />
    </ModalContext.Provider>
  );
}

export function useModal() {
  const context = useContext(ModalContext);
  if (!context) {
    throw new Error("useModal must be used within a ModalProvider");
  }
  return context;
}
