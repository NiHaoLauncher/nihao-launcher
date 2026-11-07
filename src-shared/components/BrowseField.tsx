import { open as openDialog } from "@tauri-apps/api/dialog";
import "./BrowseField.css";

/**
 * A text input paired with a native file/folder picker button; shared so every path field looks
 * the same (e.g. the game folder in Game settings).
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
