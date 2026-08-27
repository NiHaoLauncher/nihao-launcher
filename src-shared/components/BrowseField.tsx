import { open as openDialog } from "@tauri-apps/api/dialog";
import "./BrowseField.css";

/**
 * A text input paired with a native file/folder picker button — the same look used by the
 * launcher's own Game settings (game folder path), shared so every path-picking field in the
 * app looks identical instead of each place reimplementing its own input+button styling.
 */
export default function BrowseField({
  value,
  onChange,
  placeholder,
  mode = "file",
  defaultPath,
  filters,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mode?: "file" | "directory";
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}) {
  async function handleBrowse() {
    try {
      const selected = await openDialog({
        directory: mode === "directory",
        multiple: false,
        defaultPath,
        filters,
      });
      if (selected && !Array.isArray(selected)) onChange(selected);
    } catch (err) {
      console.error("Failed to open dialog:", err);
    }
  }

  return (
    <div className="browse-field-row">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="browse-field-input"
      />
      <button type="button" onClick={handleBrowse} className="browse-field-btn">
        📁 Browse
      </button>
    </div>
  );
}
