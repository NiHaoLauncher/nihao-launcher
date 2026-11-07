import { useEffect, useRef, useState } from "react";
import "./Modal.css";
import { usePresence } from "./presence";
import { useModalBehaviors } from "./modalBehaviors";
import { useModalStack } from "./modalStack";
import SimpleModalChrome from "./SimpleModalChrome";
import { SlotBoundary, useSlots } from "../theme/slotsContext";
import type { ModalChromeProps } from "../theme/slots";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Horizontal action bar pinned below the (scrollable) body — e.g. Save/Close buttons.
   *  Omit for modals that don't need one (the body just ends without a bar). */
  footer?: React.ReactNode;
  /** Text for the footer's left-hand command line (e.g. what is about to change). Without it the
   *  line is just a blinking prompt. Only shown when there is a `footer`. */
  footerHint?: React.ReactNode;
  layout?: "default" | "categories";
  categories?: { id: string | number; label: string; icon?: React.ReactNode }[];
  activeCategory?: string | number;
  onCategoryChange?: (categoryId: string | number) => void;
  size?: "small" | "medium" | "large" | "full";
  /**
   * Fixed modal height instead of following content (`"auto"`): a number is px, a string any CSS
   * length (e.g. `"70vh"`). The body scrolls, the footer stays pinned.
   */
  height?: "auto" | number | string;
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  showCloseButton?: boolean;
  /** Drops the title bar — the content fills the window and the close button floats over it. */
  headerless?: boolean;
}

/**
 * A modal: handles mounting for the close animation, topmost-only Escape/outside clicks and
 * category pages. The frame itself is the `ModalChrome` slot.
 */
export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  footerHint,
  layout = "default",
  categories = [],
  activeCategory,
  onCategoryChange,
  size = "medium",
  height = "auto",
  closeOnEscape = true,
  closeOnBackdrop = true,
  showCloseButton = true,
  headerless = false,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const { present, closing } = usePresence(isOpen);
  const isTopmost = useModalStack(isOpen);

  useModalBehaviors(modalRef, [present, layout]);
  const [internalActiveCategory, setInternalActiveCategory] = useState<string | number | undefined>(
    categories.length > 0 ? categories[0].id : undefined
  );

  useEffect(() => {
    if (!closeOnEscape || !isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopmost()) onClose();
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose, closeOnEscape, isTopmost]);

  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = "hidden";
    if (!closeOnBackdrop) return () => { document.body.style.overflow = "unset"; };

    const handleClickOutside = (e: MouseEvent) => {
      if (!isTopmost()) return;
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose();
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.body.style.overflow = "unset";
    };
  }, [isOpen, onClose, closeOnBackdrop, isTopmost]);

  useEffect(() => {
    if (activeCategory !== undefined) {
      setInternalActiveCategory(activeCategory);
    }
  }, [activeCategory]);

  const selectedCategory = activeCategory !== undefined ? activeCategory : internalActiveCategory;

  // Immediate; a frame that wants an exit animation holds the click and calls this when done.
  const handleCategoryClick = (categoryId: string | number) => {
    if (categoryId === selectedCategory) return;
    if (onCategoryChange) onCategoryChange(categoryId);
    else setInternalActiveCategory(categoryId);
  };

  const Chrome = useSlots().ModalChrome;

  if (!present) return null;

  const chromeProps: ModalChromeProps = {
    containerRef: modalRef,
    closing,
    title,
    size,
    layout,
    fixedHeight: height === "auto" ? undefined : typeof height === "number" ? `${height}px` : height,
    showCloseButton,
    headerless,
    onClose,
    footer,
    footerHint,
    categories,
    selectedCategory,
    onCategoryClick: handleCategoryClick,
    page:
      layout === "categories" && categories.length > 0
        ? {
            key: String(selectedCategory),
            label: categories.find((c) => c.id === selectedCategory)?.label,
            index: Math.max(0, categories.findIndex((c) => c.id === selectedCategory)) + 1,
            total: categories.length,
          }
        : undefined,
    children,
  };

  const builtIn = <SimpleModalChrome {...chromeProps} />;
  if (!Chrome) return builtIn;
  return (
    <SlotBoundary slot="ModalChrome" fallback={builtIn}>
      <Chrome {...chromeProps} />
    </SlotBoundary>
  );
}
