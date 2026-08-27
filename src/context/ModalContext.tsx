import { createContext, useContext, useState, useCallback, useRef, ReactNode } from "react";
import { Modal, ConfirmModal } from "@shared";

// ── Confirm ──────────────────────────────────────────────
interface ConfirmOptions {
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "primary" | "danger";
}

type ConfirmResolver = (result: boolean) => void;

// ── Generic Modal ────────────────────────────────────────
interface OpenModalOptions {
  title: string;
  content: ReactNode;
  footer?: ReactNode;
  size?: "small" | "medium" | "large" | "full";
  layout?: "default" | "categories";
  categories?: { id: string | number; label: string; icon?: React.ReactNode }[];
  activeCategory?: string | number;
  onCategoryChange?: (categoryId: string | number) => void;
  showCloseButton?: boolean;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  /** Called right before the modal is dismissed (X, Escape, backdrop click). */
  onClose?: () => void;
}

interface ModalContextType {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  openModal: (options: OpenModalOptions) => void;
  closeModal: () => void;
}

const ModalContext = createContext<ModalContextType | null>(null);

export function ModalProvider({ children }: { children: ReactNode }) {
  // Confirm state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmOptions, setConfirmOptions] = useState<ConfirmOptions>({ message: "" });
  const [, setConfirmResolver] = useState<ConfirmResolver | null>(null);

  // Generic modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalOptions, setModalOptions] = useState<OpenModalOptions>({ title: "", content: null });
  const onCloseRef = useRef<(() => void) | undefined>(undefined);

  // ── Confirm API ──────────────────────────────────────
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

  // ── Generic Modal API ────────────────────────────────
  const openModal = useCallback((options: OpenModalOptions) => {
    onCloseRef.current = options.onClose;
    setModalOptions(options);
    setModalOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setModalOptions({ title: "", content: null });
    onCloseRef.current?.();
    onCloseRef.current = undefined;
  }, []);

  return (
    <ModalContext.Provider value={{ confirm, openModal, closeModal }}>
      {children}

      {/* Confirm modal */}
      <ConfirmModal
        isOpen={confirmOpen}
        onConfirm={() => handleConfirmClose(true)}
        onCancel={() => handleConfirmClose(false)}
        message={confirmOptions.message}
        confirmText={confirmOptions.confirmText}
        cancelText={confirmOptions.cancelText}
        variant={confirmOptions.variant}
      />

      {/* Generic modal */}
      <Modal
        isOpen={modalOpen}
        onClose={closeModal}
        title={modalOptions.title}
        size={modalOptions.size}
        layout={modalOptions.layout}
        categories={modalOptions.categories}
        activeCategory={modalOptions.activeCategory}
        onCategoryChange={modalOptions.onCategoryChange}
        showCloseButton={modalOptions.showCloseButton}
        closeOnBackdrop={modalOptions.closeOnBackdrop}
        closeOnEscape={modalOptions.closeOnEscape}
        footer={modalOptions.footer}
      >
        {modalOptions.content}
      </Modal>
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
