import { ReactNode } from "react";
import ConsoleIcon from "@shared/assets/icons/terminal.svg?react";
import FolderIcon from "@shared/assets/icons/folder.svg?react";
import ShareIcon from "@shared/assets/icons/share.svg?react";
import ContentIcon from "@shared/assets/icons/layers.svg?react";
import SettingsIcon from "@shared/assets/icons/settings.svg?react";

interface ActionLink {
  key: string;
  label: string;
  icon: ReactNode;
  onClick?: () => void;
}

function buildLinks(handlers: {
  onOpenConsole?: () => void;
  onOpenFolder?: () => void;
  onShare?: () => void;
  onOpenContent?: () => void;
  onOpenSettings?: () => void;
}): ActionLink[] {
  return [
    { key: "console", label: "Console", onClick: handlers.onOpenConsole, icon: <ConsoleIcon width={18} height={18} /> },
    { key: "folder", label: "Open folder", onClick: handlers.onOpenFolder, icon: <FolderIcon width={18} height={18} /> },
    { key: "share", label: "Share", onClick: handlers.onShare, icon: <ShareIcon width={18} height={18} /> },
    { key: "content", label: "Content manager", onClick: handlers.onOpenContent, icon: <ContentIcon width={18} height={18} /> },
    { key: "settings", label: "Settings", onClick: handlers.onOpenSettings, icon: <SettingsIcon width={18} height={18} /> },
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
  // A missing handler (e.g. `onOpenContent` for a server-downloaded instance) hides that button
  // instead of leaving a dead one.
  const links = buildLinks({ onOpenConsole, onOpenFolder, onShare, onOpenContent, onOpenSettings }).filter((link) => link.onClick);

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
