import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ModalChromeProps } from "@shared/theme/slots";

/**
 * How long the page being left plays its exit (`modal-content-out`) before the next loads. Keep in
 * step with `--c-page-out` in modal.css.
 */
const PAGE_EXIT_MS = 280;

/** True when the launcher's "Interface animations" switch is off (it lives on `<html>`). */
const animationsOff = () => document.documentElement.dataset.animations === "off";

/**
 * The Console modal frame: overlay, window, title bar, framed page pane, category menu and
 * command-line footer. What a modal does (closing, Escape, outside clicks) is the launcher's; the
 * animated page switch is this frame's: the page being left steps out first, then the new category
 * loads.
 */
export default function ConsoleModalChrome({
  containerRef,
  closing,
  title,
  size,
  layout,
  fixedHeight,
  showCloseButton,
  onClose,
  footer,
  footerHint,
  categories,
  selectedCategory,
  onCategoryClick,
  page,
  children,
}: ModalChromeProps) {
  const fixed = fixedHeight !== undefined;

  // `pending`: the category already chosen but not yet loaded — its button lights up straight away.
  const [pending, setPending] = useState<string | number | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onCategory = (id: string | number) => {
    if (id === selectedCategory || pending !== undefined) return;
    if (animationsOff()) {
      onCategoryClick(id);
      return;
    }
    setPending(id);
    timer.current = setTimeout(() => {
      onCategoryClick(id);
      setPending(undefined);
    }, PAGE_EXIT_MS);
  };
  const highlighted = pending ?? selectedCategory;
  const leaving = pending !== undefined;

  return (
    <div className={`modal-overlay${closing ? " closing" : ""}`}>
      <div
        className={`modal-container modal-size-${size} ${layout === "categories" ? "modal-categories-layout" : ""}${fixed ? " modal-fixed-height" : ""}`}
        style={fixed ? ({ "--modal-height": fixedHeight } as CSSProperties) : undefined}
        ref={containerRef}
      >
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
          {layout === "categories" && categories.length > 0 && page ? (
            <>
              <div className="modal-content modal-content-framed">
                <div className="modal-pane">
                  <div className="modal-pane-title">
                    <span>{page.label}</span>
                    <span>
                      {String(page.index).padStart(2, "0")}
                      /{String(page.total).padStart(2, "0")}
                    </span>
                  </div>
                  {/* Re-keyed per category, so switching plays the content-in animation. */}
                  <div
                    key={page.key}
                    className={`modal-content-switch modal-pane-body${leaving ? " leaving" : ""}`}
                  >
                    {children}
                  </div>
                </div>
              </div>
              <div className="modal-categories">
                {categories.map((category) => (
                  <button
                    key={category.id}
                    className={`category-btn ${highlighted === category.id ? "active" : ""}`}
                    onClick={() => onCategory(category.id)}
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
        {footer && (
          <div className="modal-footer">
            <span className="modal-footer-prompt">
              <span aria-hidden="true">&rsaquo;</span>
              {footerHint && <span className="modal-footer-hint">{footerHint}</span>}
              <i aria-hidden="true">_</i>
            </span>
            <div className="modal-footer-actions">{footer}</div>
          </div>
        )}
      </div>
    </div>
  );
}
