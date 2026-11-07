import type { CSSProperties } from "react";
import type { ModalChromeProps } from "../theme/slots";

/**
 * The built-in modal frame, plain on purpose: title bar with close button, the body (a page, or a
 * page plus categories at its right) and a footer with actions. A theme replaces it via
 * `slots.ModalChrome` and/or restyles its classes. What a modal does (closing, switching pages,
 * scrolling, Escape) is `Modal`'s job and arrives through props.
 */
export default function SimpleModalChrome({
  containerRef,
  closing,
  title,
  size,
  layout,
  fixedHeight,
  showCloseButton,
  headerless,
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
  const withCategories = layout === "categories" && categories.length > 0 && !!page;

  return (
    <div className={`modal-overlay${closing ? " closing" : ""}`}>
      <div
        className={`modal-container modal-size-${size} ${layout === "categories" ? "modal-categories-layout" : ""}${fixed ? " modal-fixed-height" : ""}${headerless ? " modal-headerless" : ""}`}
        style={fixed ? ({ "--modal-height": fixedHeight } as CSSProperties) : undefined}
        ref={containerRef}
      >
        {headerless ? (
          showCloseButton && (
            <button className="modal-close modal-close-floating" onClick={onClose} type="button" aria-label="Close modal">
              &times;
            </button>
          )
        ) : (
          <div className="modal-header">
            <h3>{title}</h3>
            {showCloseButton && (
              <button className="modal-close" onClick={onClose} type="button" aria-label="Close modal">
                &times;
              </button>
            )}
          </div>
        )}
        <div className="modal-body">
          {withCategories ? (
            <>
              <div className="modal-content">
                <div key={page.key} className="modal-content-switch">
                  {children}
                </div>
              </div>
              <div className="modal-categories">
                {categories.map((category) => (
                  <button
                    key={category.id}
                    className={`category-btn ${selectedCategory === category.id ? "active" : ""}`}
                    onClick={() => onCategoryClick(category.id)}
                    type="button"
                  >
                    {category.icon && <span className="category-icon">{category.icon}</span>}
                    <span className="category-label">{category.label}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="modal-content">{children}</div>
          )}
        </div>
        {footer && (
          <div className="modal-footer">
            {footerHint && <span className="modal-footer-hint">{footerHint}</span>}
            <div className="modal-footer-actions">{footer}</div>
          </div>
        )}
      </div>
    </div>
  );
}
