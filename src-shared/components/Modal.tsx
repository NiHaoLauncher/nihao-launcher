import { useEffect, useRef, useState } from "react";
import "./Modal.css";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Horizontal action bar pinned below the (scrollable) body — e.g. Save/Close buttons.
   *  Omit for modals that don't need one (the body just ends without a bar). */
  footer?: React.ReactNode;
  layout?: "default" | "categories";
  categories?: { id: string | number; label: string; icon?: React.ReactNode }[];
  activeCategory?: string | number;
  onCategoryChange?: (categoryId: string | number) => void;
  size?: "small" | "medium" | "large" | "full";
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  showCloseButton?: boolean;
}

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  layout = "default",
  categories = [],
  activeCategory,
  onCategoryChange,
  size = "medium",
  closeOnEscape = true,
  closeOnBackdrop = true,
  showCloseButton = true,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [internalActiveCategory, setInternalActiveCategory] = useState<string | number | undefined>(
    categories.length > 0 ? categories[0].id : undefined
  );

  useEffect(() => {
    if (!closeOnEscape) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Check if this modal is the topmost one
        const modalOverlays = document.querySelectorAll('.modal-overlay');
        const topmostModal = modalOverlays[modalOverlays.length - 1];
        const isTopmost = topmostModal === e.target || topmostModal?.contains(e.target as Node);
        
        if (isTopmost || modalOverlays.length === 1) {
          onClose();
        }
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose, closeOnEscape]);

  useEffect(() => {
    if (!closeOnBackdrop) return;

    const handleClickOutside = (e: MouseEvent) => {
      // Check if this modal is the topmost one by comparing z-index
      const allModals = Array.from(document.querySelectorAll('.modal-overlay'));
      const topmostModal = allModals[allModals.length - 1];
      
      // Only close if this is the topmost modal
      const isTopmost = modalRef.current?.closest('.modal-overlay') === topmostModal;
      if (!isTopmost) return;
      
      // Check if click was outside modal content
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
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
  }, [isOpen, onClose, closeOnBackdrop]);

  useEffect(() => {
    if (activeCategory !== undefined) {
      setInternalActiveCategory(activeCategory);
    }
  }, [activeCategory]);

  const selectedCategory = activeCategory !== undefined ? activeCategory : internalActiveCategory;

  const handleCategoryClick = (categoryId: string | number) => {
    if (onCategoryChange) {
      onCategoryChange(categoryId);
    } else {
      setInternalActiveCategory(categoryId);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className={`modal-container modal-size-${size} ${layout === "categories" ? "modal-categories-layout" : ""}`} ref={modalRef}>
        <div className="modal-header">
          <h3>{title}</h3>
          {showCloseButton && (
            <button
              className="modal-close"
              onClick={onClose}
              type="button"
              aria-label="Close modal"
            >
              &times;
            </button>
          )}
        </div>
        <div className="modal-body">
          {layout === "categories" && categories.length > 0 ? (
            <>
              <div className="modal-content">
                {children}
              </div>
              <div className="modal-categories">
                {categories.map((category) => (
                  <button
                    key={category.id}
                    className={`category-btn ${selectedCategory === category.id ? "active" : ""}`}
                    onClick={() => handleCategoryClick(category.id)}
                    type="button"
                  >
                    {category.icon && <span className="category-icon">{category.icon}</span>}
                    <span className="category-label">{category.label}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="modal-content">
              {children}
            </div>
          )}
        </div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
