import { ReactNode } from "react";

export type SettingsFieldType = "text" | "number" | "select" | "toggle" | "slider";

export interface SettingsField {
  key: string;
  label: string;
  type: SettingsFieldType;
  defaultValue: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  marks?: number[];
}

export interface ConfirmOptions {
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "primary" | "danger";
}

export interface OpenModalOptions {
  title: string;
  content: ReactNode;
  size?: "small" | "medium" | "large" | "full";
  layout?: "default" | "categories";
  categories?: { id: string | number; label: string; icon?: ReactNode }[];
  activeCategory?: string | number;
  onCategoryChange?: (categoryId: string | number) => void;
  showCloseButton?: boolean;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
}

export interface LauncherBridge {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  openModal: (options: OpenModalOptions) => void;
  closeModal: () => void;
  language: string;
  setLanguage: (lang: string) => void;
  moduleId?: string;
  /** The user-configured install path for this game (from the Settings screen), if set. */
  gamePath?: string;
  /** This game's saved values from the general "Game settings" tab (`settingsFields`,
   *  e.g. `{ ram: 8192 }`) — lets a module fall back to the general setting instead of
   *  needing its own copy of the same value (e.g. a per-instance "use custom RAM" toggle). */
  gameSettings?: Record<string, any>;
}

export interface Lang {
  id: string;
  language: string;
  [key: string]: any;
}