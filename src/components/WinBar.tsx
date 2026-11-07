import { useState, useEffect } from 'react';
import { appWindow } from '@tauri-apps/api/window';
import { ConfirmModal, t } from '@shared';
import PowerIcon from '@shared/assets/icons/power.svg?react';
import StatusButton from './StatusButton';
import { useSettingsModal } from './settings/useSettingsModal';

/** `minimal` = window buttons only (the loading screen: no status, no settings). */
export default function WinBar({ minimal = false }: { minimal?: boolean }) {
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
  let STYLE: React.CSSProperties = {
    backgroundColor: "var(--mainbar-background-color)",
    borderRadius:"50px",
    width:"36px", height:"36px",
    padding: "0",
    marginLeft: "15px",
    fontSize: "24px"
  };
  return (
    <div id="window-bar" style={{
      height:"auto", justifyContent:"right", display:"flex", padding:"7px",
      borderRadius:"var(--border-radius)", position:"relative", zIndex:"1000"
    }}
     >
        {!minimal && <StatusButton />}
        {!minimal && <button style={STYLE} onClick={openSettings} title="Settings">⚙</button>}
        <button style={STYLE} onClick={() => appWindow.minimize()}>-</button>
        <button style={STYLE} onClick={() => appWindow.toggleMaximize()}>🗖</button>
        <button style={STYLE} onClick={() => setIsCloseModal(true)}>×</button>
        <ConfirmModal
          isOpen={isCloseModal}
          onCancel={() => setIsCloseModal(false)}
          onConfirm={() => appWindow.close()}
          variant='danger'
          icon={<PowerIcon />}
          confirmIcon={<PowerIcon />}
          message={t('confirm_close_app', 'Are you sure you want to close the application?')}
          confirmText={t('button_close_app', 'Close')}
          cancelText={t('button_cancel', 'Cancel')}
        />
    </div>
  );
}