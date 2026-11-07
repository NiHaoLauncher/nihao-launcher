import { ReactNode } from "react";
import HoverHint from "./HoverHint";

/**
 * One option in the General tab's look: a card with an optional icon and the name on the left and
 * the control on the right (`stack` puts a wide control — a path, a slider — under the name
 * instead). `hint` adds the hover hint.
 */
export default function OptionRow({ icon, label, hint, stack, htmlFor, children }: {
  icon?: ReactNode;
  label: string;
  hint?: string;
  stack?: boolean;
  htmlFor?: string;
  children: ReactNode;
}) {
  const name = <label className="settings-option-text" htmlFor={htmlFor}>{label}</label>;
  const row = (
    <div className="settings-field">
      <div className={`settings-row${stack ? " settings-row-stack" : ""}`}>
        {stack ? <div className="settings-row-head">{icon}{name}</div> : <>{icon}{name}</>}
        {children}
      </div>
    </div>
  );
  return hint ? <HoverHint text={hint}>{row}</HoverHint> : row;
}
