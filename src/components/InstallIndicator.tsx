import "./InstallIndicator.css";
import { InstallEntry, computeEtapPercent, computeOverallPercent } from "../hooks/useInstallStatus";

/**
 * Mini "other installs running" spinners — sits in the top-right corner of the bottom
 * progress bar, one ring per install beyond the one already shown as the full bar. Hover a
 * ring to see that install's full detail (name, stage, file count, its own progress bar).
 */
export default function InstallIndicator({ installs }: { installs: InstallEntry[] }) {
  if (installs.length === 0) return null;

  return (
    <div className="mini-installs">
      {installs.map(({ module, progress }, i) => (
        <div key={`${module}-${progress.name}-${i}`} className="mini-install" title={`${progress.name} (${module})`}>
          <div
            className="spinner"
            style={{ background: `conic-gradient(var(--main-color) ${computeOverallPercent(progress)}%, rgba(255,255,255,0.18) 0)` }}
          />
          <div className="mini-install-panel">
            <div className="install-panel-item">
              <div className="install-panel-title">
                <span>{progress.name}</span>
                <span className="install-panel-module">{module}</span>
              </div>
              <div className="install-panel-stage">
                {progress.etap} · {progress.status}
                {progress.filename ? ` — ${progress.filename}` : ""}
              </div>
              {progress.total_files > 0 && (
                <div className="install-panel-filecount">{progress.current_file}/{progress.total_files} files</div>
              )}
              <div className="install-panel-bar">
                <div className="install-panel-bar-fill" style={{ width: `${computeEtapPercent(progress)}%` }} />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
