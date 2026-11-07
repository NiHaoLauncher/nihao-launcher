/**
 * The images and icons the launcher itself ships, available to themes by name. Vite resolves each
 * to its built URL, so a theme can show the launcher's own picture without copying it.
 *
 *   src/assets/<path>          ->  "<path>"             e.g. "profile.png", "icons/downloading.gif"
 *   src-shared/assets/<path>   ->  "shared/<path>"      e.g. "shared/icons/refresh.svg"
 */
const own = import.meta.glob("../assets/**/*.{png,jpg,jpeg,webp,gif,svg}", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const shared = import.meta.glob("../../src-shared/assets/**/*.{png,jpg,jpeg,webp,gif,svg}", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

const files = new Map<string, string>();
for (const [path, url] of Object.entries(own)) files.set(path.replace("../assets/", ""), url);
for (const [path, url] of Object.entries(shared)) files.set("shared/" + path.replace("../../src-shared/assets/", ""), url);

export const launcherAssetUrl = (name: string): string | undefined => files.get(name);
export const launcherAssetNames = (): string[] => [...files.keys()].sort();
