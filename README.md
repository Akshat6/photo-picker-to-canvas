# Photo Picker to Canvas (Prototype)

Free experimental plugin for **Obsidian's native Canvas**, primarily designed for Android tablets.

## Features

- Select exactly one existing **file card** on a Canvas.
- Tap **Pick image** and choose a single photograph using the Android picker.
- Choose **Horizontal** (right) or **Vertical** (below).
- The plugin copies the image into a configurable vault folder (`Canvas Photos` by default), then attempts to insert a new file card at a configurable gap from the selected card.
- No rearranging existing cards, no batch import, no camera integration.

## Status and warning

**Experimental beta.** The picker and direction selection have been tested by a user on Android. A read-permissions error occurred during image saving; v0.3.2 attempts to read bytes immediately, **but this fix is not yet device-verified**. The plugin relies on undocumented native Canvas internals. Test only on a **duplicate** of your Canvas and back up your vault first. Keep `data.json` when upgrading.

## Install and update via BRAT (recommended during beta)

1. In Obsidian → **Settings → Community plugins**, install **BRAT** and enable it.
2. Run command **BRAT: Add a beta plugin for testing**.
3. Paste the public GitHub repository URL where this project is hosted (for example `https://github.com/USERNAME/photo-picker-to-canvas`).
4. Install/enable the plugin as instructed by BRAT. BRAT can check for new published GitHub releases and optionally auto-check on Obsidian startup.
5. If the plugin was previously installed manually, **back up the vault and the plugin's `data.json`, then disable/remove the old manual installation before installing through BRAT**. Reuse the same plugin id (`camera-to-canvas-prototype`); do not run duplicate installations.

## Releasing an update

The included GitHub Actions workflow is designed to publish a GitHub release automatically when the **manifest version changes** on the `main` branch. GitHub Actions must be enabled and allowed to write repository contents.

1. Change `main.js` and optionally `styles.css`.
2. Increase `version` in `manifest.json`, e.g. `0.3.2` → `0.3.3`. Keep the `id` unchanged.
3. Add the new version/minimum Obsidian version entry to `versions.json` (keep old entries).
4. Commit and push to `main`. GitHub Actions creates a GitHub release tagged with the exact version number **without a `v` prefix**, with `main.js`, `manifest.json`, and `styles.css` as assets.
5. On the tablet, run **BRAT: Check for updates to all beta plugins and UPDATE**, or enable BRAT's check-for-updates on startup option.

**First upload from a mobile browser:** GitHub cannot install a ZIP as a source repository. Extract this repository package, create a **public** GitHub repository, and upload the contents at the repository root, including `.github/workflows/release.yml`. If your browser doesn't upload the hidden `.github` folder, create `.github/workflows/release.yml` through GitHub's `Add file` → `Create new file` interface. GitHub Actions will publish the initial release after the first push/commit if enabled.

## File layout

```
manifest.json
main.js
styles.css
versions.json
README.md
.github/workflows/release.yml
```

Official resources: https://github.com/TfTHacker/obsidian42-brat and https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin
