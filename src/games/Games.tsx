import { useState, useEffect } from "react";
import React from "react";
import { SliderField, BrowseField, t, HoverHint, OptionRow } from "@shared";
import FolderIcon from "@shared/assets/icons/folder.svg?react";
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
  hint?: string; // shown as a hover hint
}

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
    <div className="settings-tab">
      <OptionRow
        stack
        icon={<FolderIcon className="settings-icon" />}
        label={t("setting_game_path", "Game folder path")}
        hint={t("hint_game_path", "Where the game's files (instances, libraries, assets) are stored.")}
      >
        <BrowseField
          value={path}
          onChange={(v) => { setPath(v); onPathChange(v); }}
          placeholder="Select game folder..."
          mode="directory"
          defaultPath={defaultPath}
        />
        <p className="settings-hint">{t("label_default", "Default")}: {defaultPath}</p>
      </OptionRow>

      {settingsFields?.map((field) => {
        const value = currentValues[field.key] ?? field.defaultValue;
        const label = t(`${gameId}.settings.${field.key}.label`, field.label);
        const hint = field.hint ? t(`${gameId}.settings.${field.key}.hint`, field.hint) : undefined;

        if (field.type === "toggle") {
          const toggle = (
            <div className="settings-field">
              <label className="settings-checkbox-label">
                <input
                  type="checkbox"
                  checked={value as boolean}
                  onChange={(e) => onValueChange(field.key, e.target.checked)}
                />
                <span className="settings-option-text">{label}</span>
              </label>
            </div>
          );
          return hint ? <HoverHint key={field.key} text={hint}>{toggle}</HoverHint> : <div key={field.key}>{toggle}</div>;
        }

        return (
          <OptionRow key={field.key} label={label} hint={hint} stack={field.type === "slider"}>
            {field.type === "text" && (
              <input type="text" value={value as string} onChange={(e) => onValueChange(field.key, e.target.value)} />
            )}

            {field.type === "number" && (
              <input
                type="number"
                value={value as number}
                min={field.min}
                max={field.max}
                onChange={(e) => onValueChange(field.key, Number(e.target.value))}
              />
            )}

            {field.type === "select" && (
              <select value={value as string} onChange={(e) => onValueChange(field.key, e.target.value)}>
                {field.options?.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
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
          </OptionRow>
        );
      })}
    </div>
  );
}
