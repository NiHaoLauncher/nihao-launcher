import { ReactNode } from "react";

interface ActionLink {
  key: string;
  label: string;
  icon: ReactNode;
  onClick?: () => void;
}

export function ConsoleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.5 9.5l3 2.5-3 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="11.5" y1="14.5" x2="16.5" y2="14.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M3.5 5.5A1.5 1.5 0 0 1 5 4h4.6c.4 0 .77.17 1.03.47l1.2 1.4a1.5 1.5 0 0 0 1.14.53H19a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-13Z" />
    </svg>
  );
}

export function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M18 8a3 3 0 1 0-2.83-4H15a3 3 0 0 0 .09 3.32L8.7 10.6a3 3 0 1 0 0 2.8l6.39 3.28A3 3 0 1 0 15 15a2.98 2.98 0 0 0 .09.7L8.7 12.4a3 3 0 0 0 0-.8l6.39-3.28c.53.42 1.19.68 1.91.68Z" />
    </svg>
  );
}

export function ContentIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M12 3 21 8l-9 5-9-5 9-5Z" />
      <path d="M3 12l9 5 9-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 16l9 5 9-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.14.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.63 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.32.6.22l2.39-.96c.49.38 1.04.7 1.63.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.59-.24 1.14-.56 1.63-.94l2.39.96c.24.1.5 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" />
    </svg>
  );
}

function buildLinks(handlers: {
  onOpenConsole?: () => void;
  onOpenFolder?: () => void;
  onShare?: () => void;
  onOpenContent?: () => void;
  onOpenSettings?: () => void;
}): ActionLink[] {
  return [
    { key: "console", label: "Console", onClick: handlers.onOpenConsole, icon: <ConsoleIcon /> },
    { key: "folder", label: "Open folder", onClick: handlers.onOpenFolder, icon: <FolderIcon /> },
    { key: "share", label: "Share", onClick: handlers.onShare, icon: <ShareIcon /> },
    { key: "content", label: "Content manager", onClick: handlers.onOpenContent, icon: <ContentIcon /> },
    { key: "settings", label: "Settings", onClick: handlers.onOpenSettings, icon: <SettingsIcon /> },
  ];
}

export function ActionsBanner({
  visible = true,
  onOpenConsole,
  onOpenFolder,
  onShare,
  onOpenContent,
  onOpenSettings,
}: {
  visible?: boolean;
  onOpenConsole?: () => void;
  onOpenFolder?: () => void;
  onShare?: () => void;
  onOpenContent?: () => void;
  onOpenSettings?: () => void;
}) {
  const links = buildLinks({ onOpenConsole, onOpenFolder, onShare, onOpenContent, onOpenSettings });

  return (
    <div className={`actions-banner${visible ? "" : " actions-banner-hidden"}`}>
      {links.map((link) => (
        <button
          key={link.key}
          type="button"
          className="actions-banner-item"
          title={link.label}
          onClick={link.onClick}
        >
          {link.icon}
        </button>
      ))}
    </div>
  );
}
