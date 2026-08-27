import { invoke } from "@tauri-apps/api";
import { useCallback } from "react";
import { Lang, useClient } from "./ClientContext";
import { deepResolveTranslations } from "@shared/components/Translate";

export function initLanguage(id: string) {
  const { setLanguageKeys } = useClient();
  console.info(`Initialization language(${id}) ...`);

  invoke("get_lang", { "id": id })
    .then((data: any) => {
      const lang: Lang = { ...data, id };
      const resolved = deepResolveTranslations(lang);
      setLanguageKeys(resolved);
    })
    .catch((e) => {
      console.error(`Failed to load language "${id}":`, e);
    });
}

export function useInitLanguage() {
  const { setLanguageKeys } = useClient();

  return useCallback((id: string) => {
    console.info(`Initialization language(${id}) ...`);
    invoke("get_lang", { "id": id })
      .then((data: any) => {
        const lang: Lang = { ...data, id };
        console.info("Loaded language data:", lang);
        // Auto-resolve translate-keys before saving
        const resolved = deepResolveTranslations(lang);
        console.info("Resolved language data:", resolved);
        setLanguageKeys(resolved);
      })
      .catch((e) => {
        console.error(`Failed to load language "${id}":`, e);
      });
  }, [setLanguageKeys]);
}