
declare global {
  interface Window {
    __NIHAO_I18N__?: Record<string, string>;
  }
}

/**
 * Отримує переклад за ключем.
 * Шукає в window.__NIHAO_I18N__ (заповнюється лаунчером)
 */
export const t = (key: string, fallback: string): string => {
  if (typeof window !== 'undefined' && window.__NIHAO_I18N__) {
    return window.__NIHAO_I18N__[key] || fallback;
  }
  return fallback;
};

/**
 * Компонент для відображення перекладеного тексту
 */
export const T = ({ k, alt }: { k: string; alt?: string }) => {
  const text = t(k, alt || k);
  return <>{text}</>;
};
