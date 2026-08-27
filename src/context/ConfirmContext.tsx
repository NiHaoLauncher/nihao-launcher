import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { ConfirmModal } from "@shared";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "primary" | "danger";
}

type ConfirmResolver = (result: boolean) => void;

interface ConfirmContextType {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextType | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions>({ title: "", message: "" });
  const [, setResolver] = useState<ConfirmResolver | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    setOptions(options);
    setIsOpen(true);
    return new Promise<boolean>((resolve) => {
      setResolver(() => resolve);
    });
  }, [setResolver]);

  const handleClose = useCallback((result: boolean) => {
    setIsOpen(false);
    setOptions({ title: "", message: "" });
    setResolver((prevResolver: ConfirmResolver | null) => {
      if (prevResolver) prevResolver(result);
      return null;
    });
  }, [setResolver]);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <ConfirmModal
        isOpen={isOpen}
        onConfirm={() => handleClose(true)}
        onCancel={() => handleClose(false)}
        message={options.message}
        confirmText={options.confirmText}
        cancelText={options.cancelText}
        variant={options.variant}
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const context = useContext(ConfirmContext);
  if (!context) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return context.confirm;
}
