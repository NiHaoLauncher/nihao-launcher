import { useState, useEffect } from "react";
import React from "react";
import { SliderField, BrowseField } from "@shared";
import "./Games.css";

export function GameBanner(
  {src, onClick, className, style} :
  {src:string, onClick?:()=>void, className?:string, style?:React.CSSProperties}
) {
  return (
    <img
      src={src}
      onClick={onClick}
      className={"gameBanner "+className}
      style={{maxHeight:"200px", ...style}}
    />
  )
}

/* ── Settings field types ────────────────────────────────── */

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
  marks?: number[]; // custom tick positions (e.g. [512, 1024, 2048, 4096])
}

/* ── Game Settings Panel ─────────────────────────────────── */

interface GameSettingsProps {
  gameId: string;
  gameName: string;
  defaultPath: string;
  settingsFields?: SettingsField[];
  currentPath?: string;
  currentValues?: Record<string, any>;
  onPathChange: (path: string) => void;
  onValueChange: (key: string, value: any) => void;
}

export function GameSettings({
  gameId,
  defaultPath,
  settingsFields,
  currentPath,
  currentValues = {},
  onPathChange,
  onValueChange,
}: GameSettingsProps) {
  const [path, setPath] = useState(currentPath ?? defaultPath);

  useEffect(() => {
    setPath(currentPath ?? defaultPath);
  }, [gameId, currentPath, defaultPath]);

  return (
    <div className="game-settings">
      {/* Game path */}
      <div className="game-path-row">
        <label style={{ display: "block", marginBottom: "0.3rem", fontSize: "0.85rem", color: "var(--text-color)" }}>
          Game folder path
        </label>
        <BrowseField
          value={path}
          onChange={(v) => { setPath(v); onPathChange(v); }}
          placeholder="Select game folder..."
          mode="directory"
          defaultPath={defaultPath}
        />
        <p style={{
          margin: "0.3rem 0 0 0",
          fontSize: "0.75rem",
          color: "var(--text-secondary-color)",
          fontStyle: "italic",
        }}>
          Default: {defaultPath}
        </p>
      </div>

      {/* Dynamic settings fields */}
      {settingsFields?.map((field) => {
        const value = currentValues[field.key] ?? field.defaultValue;

        return (
          <div key={field.key} style={{ marginTop: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.3rem", fontSize: "0.85rem", color: "var(--text-color)" }}>
              {field.label}
            </label>

            {field.type === "text" && (
              <input
                type="text"
                value={value as string}
                onChange={(e) => onValueChange(field.key, e.target.value)}
                style={inputStyle}
              />
            )}

            {field.type === "number" && (
              <input
                type="number"
                value={value as number}
                min={field.min}
                max={field.max}
                onChange={(e) => onValueChange(field.key, Number(e.target.value))}
                style={inputStyle}
              />
            )}

            {field.type === "select" && (
              <select
                value={value as string}
                onChange={(e) => onValueChange(field.key, e.target.value)}
                style={inputStyle}
              >
                {field.options?.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            )}

            {field.type === "toggle" && (
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={value as boolean}
                  onChange={(e) => onValueChange(field.key, e.target.checked)}
                  style={{ width: "18px", height: "18px" }}
                />
                <span style={{ fontSize: "0.9rem" }}>
                  {value ? "Enabled" : "Disabled"}
                </span>
              </label>
            )}

            {field.type === "slider" && (
              <SliderField
                value={value as number}
                min={field.min ?? 0}
                max={field.max ?? 100}
                step={field.step ?? 1}
                unit={field.unit}
                marks={field.marks}
                onChange={(v) => onValueChange(field.key, v)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.75rem",
  fontSize: "0.9rem",
  borderRadius: "6px",
  border: "1px solid var(--hr-color)",
  backgroundColor: "var(--bg-color)",
  color: "var(--text-color)",
  outline: "none",
  boxSizing: "border-box",
};