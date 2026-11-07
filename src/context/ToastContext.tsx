import { createContext, useCallback, useContext, useRef, useState, ReactNode } from "react";
import "./ToastContext.css";

export type ToastVariant = "success" | "error" | "info";

export interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. Default 5000. */
  duration?: number;
}

interface ToastItem extends Required<Omit<ToastOptions, "duration">> {
  id: number;
}

interface ToastContextType {
  showToast: (options: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((options: ToastOptions) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message: options.message, variant: options.variant ?? "info" }]);
    const duration = options.duration ?? 5000;
    if (duration > 0) {
      setTimeout(() => dismissToast(id), duration);
    }
  }, [dismissToast]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-item toast-${toast.variant}`} onClick={() => dismissToast(toast.id)}>
            <span className="toast-icon">
              {toast.variant === "success" ? "✓" : toast.variant === "error" ? "✕" : "ⓘ"}
            </span>
            <span className="toast-message">{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
