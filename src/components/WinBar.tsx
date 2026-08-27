import { useState, useEffect } from 'react';
import { appWindow } from '@tauri-apps/api/window';
import { ConfirmModal } from '@shared';
import { useSettingsModal } from './settings/useSettingsModal';

export default function WinBar() {
  const [isDecorated, setIsDecorated] = useState(false);
  const [isCloseModal, setIsCloseModal] = useState(false);
  const openSettings = useSettingsModal();

  useEffect(() => {
    const checkDecorated = async () => {
      const decorated = await appWindow.isDecorated();
      setIsDecorated(decorated);
    };
    checkDecorated();
  }, []);

  if (isDecorated) return <></>;

  return (
    <div id="window-bar" style={{backgroundColor:"var(--mainbar-background-color)", width:"250px",
      height:"auto", justifyContent:"right", display:"flex", padding:"7px",
      borderRadius:"var(--border-radius)", position:"relative", zIndex:"1000"
    }}
    data-tauri-drag-region >
        <button onClick={openSettings} title="Settings">⚙</button>
        <button onClick={() => appWindow.minimize()}>-</button>
        {/* <button onClick={() => appWindow.toggleMaximize()}>□</button> */}
        <button onClick={() => setIsCloseModal(true)}>×</button>
        <ConfirmModal
          isOpen={isCloseModal}
          onCancel={() => setIsCloseModal(false)}
          onConfirm={() => appWindow.close()}
          message="Are you sure you want to close the application?"
        />
    </div>
  );
}