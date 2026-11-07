import type { ThemeSettingField, ThemeSettingValue, ThemeSettingValues } from "./types";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const MAX_FIELDS = 40;

/** Keeps the setting declarations that are well-formed; drops the rest (and any beyond `MAX_FIELDS`). */
export function sanitizeSchema(raw: unknown): ThemeSettingField[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ThemeSettingField[] = [];
  for (const f of raw) {
    if (out.length >= MAX_FIELDS || !isPlainObject(f)) continue;
    const { key, label, type } = f;
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(key) || seen.has(key)) continue;
    if (typeof label !== "string" || !label) continue;
    const base = { key, label, description: typeof f.description === "string" ? f.description : undefined };
    if (type === "toggle" && typeof f.default === "boolean") out.push({ ...base, type, default: f.default });
    else if (type === "text" && typeof f.default === "string") out.push({ ...base, type, default: f.default, maxLength: typeof f.maxLength === "number" ? f.maxLength : undefined });
    else if (type === "color" && typeof f.default === "string") out.push({ ...base, type, default: f.default });
    else if (type === "number" && typeof f.default === "number" && Number.isFinite(f.default)) {
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      out.push({ ...base, type, default: f.default, min: num(f.min), max: num(f.max), step: num(f.step) });
    } else if (type === "select" && Array.isArray(f.options)) {
      const options = f.options.filter((o): o is { value: string; label: string } => isPlainObject(o) && typeof o.value === "string" && typeof o.label === "string");
      if (options.length > 0 && typeof f.default === "string") out.push({ ...base, type, default: f.default, options });
    } else continue;
    seen.add(key);
  }
  return out;
}

/** One saved value checked against its declaration; anything off falls back to the default. */
function coerce(field: ThemeSettingField, value: unknown): ThemeSettingValue {
  switch (field.type) {
    case "toggle":
      return typeof value === "boolean" ? value : field.default;
    case "text":
      return typeof value === "string" ? value.slice(0, field.maxLength ?? 200) : field.default;
    case "color":
      return typeof value === "string" && /^#[0-9a-fA-F]{3,8}$|^(rgb|hsl)a?\([\d\s.,%/-]+\)$/.test(value) ? value : field.default;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return field.default;
      return Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, value));
    }
    case "select":
      return typeof value === "string" && field.options.some((o) => o.value === value) ? value : field.default;
  }
}

/** The values in effect: one per declared setting, from `saved` where valid, else the default. */
export function resolveSettings(schema: ThemeSettingField[], saved: unknown): ThemeSettingValues {
  const src = isPlainObject(saved) ? saved : {};
  return Object.fromEntries(schema.map((f) => [f.key, coerce(f, src[f.key])]));
}
