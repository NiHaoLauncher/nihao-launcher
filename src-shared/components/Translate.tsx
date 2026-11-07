import { Fragment } from "react";
import { Lang } from "@shared/types";

const getActiveLanguage = (): Lang | null => {
  return (window as any).__NIHAO_I18N__ || null;
};



export function deepResolveTranslations(lang: Lang): Lang {
  const result = { ...lang };
  for (const [key, value] of Object.entries(lang)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      if ("translate-key" in value && typeof value["translate-key"] === "string") {
        const tKey = value["translate-key"];
        result[key] = lang[tKey] ?? tKey;
      } else {
        result[key] = deepResolveTranslationsValue(value, lang);
      }
    }
  }
  return result;
}
export function deepResolveTranslationsValue(obj: any, lang: Lang): any {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(item => deepResolveTranslationsValue(item, lang));

  if ("translate-key" in obj && typeof obj["translate-key"] === "string") {
    const tKey = obj["translate-key"];
    return lang[tKey] ?? tKey;
  }

  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = deepResolveTranslationsValue(value, lang);
  }
  return result;
}


export function t(key: string, alt?:string): string {
  const language = getActiveLanguage();
  if (!language) return alt??key;
  const value = language[key] ?? alt ?? key;
  return typeof value === "string" ? value.replace(/\\n/g, "\n") : value;
}

export function T({ k, alt }: { k: string, alt?:string }) {
  const language = getActiveLanguage();
  if (!language) return <>{alt??k}</>;
  const value = language[k] ?? alt ?? k;
  if (typeof value !== "string") return <>{value}</>;

  // Plain text with line breaks, never HTML: a translation (or a value put into one) can't inject markup.
  return (
    <span>
      {value.split("\n").map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {line}
        </Fragment>
      ))}
    </span>
  );
}