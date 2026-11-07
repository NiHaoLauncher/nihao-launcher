# NiHao themes

A theme is a folder in `themes/` next to the launcher's exe:

```
themes/<id>/
  theme.json   { "id": "<id>", "name": "...", "version": "...", "author": "...", "icon": "icon.svg" }   (id = folder name)
  theme.js     the built theme (a script that defines `NihaoThemeEntry`)
  icon.svg     optional: the preview shown in the theme list (png/svg/webp, up to 256 KB) — draw how the theme looks
  assets/      optional: your own images and fonts (png jpg webp gif svg woff woff2 ttf otf; 2 MB each, 12 MB total)
```

The launcher ships one theme inside itself — **Simple** (a plain look). Everything else, including
**Console**, is a folder theme like the ones here. In *Settings → Appearance* the user picks one; a
theme is code, so the launcher asks before running it for the first time and again whenever its
`theme.js` changes (it remembers the SHA-256 of what was approved).

## What a theme can set

A theme exports an object (see `src-shared/theme/types.ts`); whatever it leaves out stays as in
**Simple**:

| key | what it is |
|---|---|
| `colors`, `radii`, `fonts` | tokens, applied as CSS custom properties on `<html>` |
| `motion` | `{ modalCloseMs }` — how long a closing modal stays mounted for your exit animation. Nothing else: the launcher has no animation logic, so all motion is yours (keyframes in `css`, scripts in `behaviors`, slots) |
| `behaviors` | `modal(root)` — code attached to every modal window, returns its cleanup (a custom scrollbar, a wheel feel, ...) |
| `css` | extra CSS (a string). The built-in look is written with `:where()` (zero specificity), so your rules win however you write them |
| `bare: true` | switch the built-in stylesheet off while this theme is active, so `css` styles everything from scratch |
| `slots` | your own components for parts of the launcher's structure — `Shell` (the main window: where the quick panel, friends, progress line go), `BlankShell` (the frame of the first-run setup and uninstall pages), `LoadingScreen` (the startup screen) and `ModalChrome` (the frame of every modal, including its page-switch animation) and `OnlineService` (Settings > Online Service) — see `src-shared/theme/slots.ts` |

A slot component that throws is replaced by the built-in one, so a broken theme can't leave the
launcher unusable. Safe mode (`--safe-mode`, or `NIHAO_SAFE_MODE=1`) starts with the built-in theme
whatever is saved.

Slots also run inside game modules' modals (they have their own copy of React): a slot works
there only if it uses **no hooks**; otherwise the modal falls back to the built-in frame.

## Settings

A theme can offer the user settings of its own (Settings → Appearance, while it is active). Export
`{ settings, theme }` instead of a plain object:

```ts
export default {
  settings: [
    { key: "accent", label: "Accent colour", type: "select", default: "blue", options: [...] },
    { key: "blinkingCursor", label: "Blinking cursor", type: "toggle", default: true },
    // also: "number" (min/max/step), "color", "text"
  ],
  theme: (ctx) => ({ colors: { accent: pick(ctx.settings.accent) }, /* ...everything else */ }),
};
```

`theme(ctx)` is called again every time a value changes, so the preview is live. Values are checked
against the declaration (a wrong type or unknown choice becomes the default) and saved in the
user's profile, per theme. Each setting is also a CSS variable, `--ts-<key>`.

## Assets

`ctx.assets` gives a theme files by name, as URLs usable in `<img src>` and CSS `url()`:

- `ctx.assets.own("logo.png")` — a file from the theme's own `assets/` folder (also `--asset-logo-png`
  as a ready `url(...)` CSS variable); `ctx.assets.ownNames()` lists them
- `ctx.assets.launcher("profile.png")` — a picture the launcher itself ships
  (`"libraryGames.png"`, `"icons/downloading.gif"`, `"shared/icons/refresh.svg"`, ...);
  `ctx.assets.launcherNames()` lists them. Hand-written themes: `window.__NIHAO__.launcherAsset(name)`

Assets are data: scripts and html in `assets/` are ignored; the only code a theme has is `theme.js`.

## Building

Themes are TypeScript/TSX, built into a single script with `react` and `react/jsx-runtime` as
**externals** — they must run on the launcher's own React (`window.__NIHAO__`), never a second copy.
`themes-sdk/vite.config.ts` does that.

```
npm run build:themes                 # builds every theme in themes-sdk/themes/ into themes-sdk/dist/<id>/
node themes-sdk/build.mjs console    # just one
npm run install:themes               # builds and copies them into target/debug/themes/ (dev)
```

`themes-sdk/themes/console/` is the reference: tokens, settings, an icon, motion, `behaviors`, custom
`ModalChrome` and `OnlineService` slots and the stylesheets, all in one small project.

`themes-sdk/examples/ocean/` is a theme written **by hand** (no build step): settings, its own asset,
a launcher asset, an icon, and a custom `Shell`.
