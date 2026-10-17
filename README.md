# UlanziDeckPlugins

Plugins for [Ulanzi Deck](https://www.ulanzi.com/) (Ulanzi Studio ≥ 2.1.4).

| Plugin | Version | Description | Platform |
|---|---|---|---|
| `com.ulanzi.audiooutput.ulanziPlugin` | 1.0.0 | Cycle default playback device: speaker → bluetooth → headphone | Windows 10+ |
| `com.ulanzi.sysmonitor.ulanziPlugin` | 1.7.0 | CPU / Memory / Disk / Network / GPU monitor with trend charts (D200) | macOS 10.11+, Windows 10+ |

## Build

Each plugin builds independently with webpack (`npm run build` → `dist/app.js`).
A `Makefile` wraps build, package and install:

```sh
cd com.ulanzi.sysmonitor.ulanziPlugin   # or com.ulanzi.audiooutput.ulanziPlugin
make package   # build + zip into release/<plugin>-<version>.zip
make verify    # sanity-check the zip and manifest
make install   # copy into the UlanziDeck Plugins folder (then restart Ulanzi Studio)
```

Notes:

- `sysmonitor` ships a Rust helper (`helpers/winquery` → `bin/win-x64/winquery.exe`,
  cross-compiled to `x86_64-pc-windows-gnu`). If `cargo` is unavailable the build
  skips it and the plugin falls back to PowerShell.
- `audiooutput` switches devices via `plugin/scripts/*.ps1` and has unit tests (`npm test`).

## Release

Each plugin publishes a GitHub release tagged `<prefix>-v<version>`
(`sysmonitor-v*` / `audiooutput-v*`) with the packaged zip attached.

```sh
cd com.ulanzi.sysmonitor.ulanziPlugin
make bump V=1.8.0     # edits manifest.json + the version table above (no commit)
git commit -am "chore: bump version 1.7.0 -> 1.8.0"
make release          # build + zip, tag, push, gh release create with the zip
```

`make release` refuses to run on a dirty worktree and aborts after building if the
build touched tracked files (e.g. the `sysmonitor` `winquery.exe`), so the tag
always matches the committed sources. Release notes come from the commits since
the previous same-prefix tag.

## Install a release zip

1. Run `make package` inside the plugin folder.
2. Unzip `release/<plugin>-<version>.zip` into the UlanziDeck `Plugins` folder.
3. Restart Ulanzi Studio.

## Layout

```text
com.ulanzi.<name>.ulanziPlugin/
├── manifest.json          # plugin metadata (UUID, version, actions)
├── plugin/                # runtime JS (bundled by webpack from here)
├── property-inspector/    # per-action inspector UI
├── libs/                  # shared UlanziDeck JS/CSS assets
├── assets/                # icons
├── en.json zh_CN.json zh_HK.json   # i18n strings
├── Makefile webpack.config.js package.json
└── helpers/ test/ scripts/ bin/    # per-plugin extras (see above)
```

`node_modules/`, `dist/` and `release/` are build artifacts and not committed.
