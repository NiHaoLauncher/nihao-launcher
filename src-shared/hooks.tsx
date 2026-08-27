import { createContext, useContext } from 'react';
import { LauncherBridge } from './types';

/**
 * Контекст для "Моста" в модулях
 */
export const LauncherBridgeContext = createContext<LauncherBridge | null>(null);

/**
 * Хук для доступу до функцій лаунчера (модалки, мова тощо).
 * Працює і в самому лаунчері (через ModalContext), і в модулях (через Bridge).
 */
export const useLauncher = () => {
  const bridge = useContext(LauncherBridgeContext);
  
  // Якщо ми в модулі і маємо міст — повертаємо його
  if (bridge) return bridge;

  // Якщо ми в лаунчері, ми повинні використовувати реальні контексти.
  // Але для спрощення бібліотеки ми можемо зробити так, 
  // щоб лаунчер теж прокидав себе в цей контекст.
  return bridge;
};

/**
 * Хук для отримання ID поточного модуля (наприклад, "minecraft")
 */
export const useModuleId = (): string | undefined => {
  const bridge = useLauncher();
  return bridge?.moduleId;
};
