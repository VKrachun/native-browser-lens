# Sirv Lens

Capture browser defects with their evidence, review them, and file them. See
[ARCHITECTURE.md](ARCHITECTURE.md).

## Install

Download the installer for your computer from the [latest release](https://github.com/VKrachun/native-browser-lens/releases/latest).
Each installs for your user only, without administrator rights.

| Computer | Installer | Then |
| --- | --- | --- |
| Mac | `Sirv-Lens-VERSION-macos-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel) | Drag Sirv Lens to Applications and open it. |
| Windows | `Sirv-Lens-VERSION-windows-x64-setup.exe` | Run it; Sirv Lens opens at the end. |
| Ubuntu, Debian | `sirv-lens_VERSION_amd64.deb` | Open it in Software, or `sudo apt install ./sirv-lens_VERSION_amd64.deb`, then open Sirv Lens. |
| Arch | `sirv-lens-VERSION-linux-x86_64-pacman.tar.gz` | Contains a `PKGBUILD` for `makepkg -si`. |
| Any Linux | `Sirv-Lens-VERSION-linux-x86_64.AppImage` | Allow it to run as a program (file Properties, Permissions), then open it. |

The first time Sirv Lens opens, it sets itself up: it starts at login with a tray icon, registers
with your browsers, and opens a page that shows how to add the browser extension. Open Sirv Lens
again to see that page. In a terminal, `lens open` does the same and `lens doctor` checks each step.

The extension for Chrome, Edge and Brave is in the
[Chrome Web Store](https://chromewebstore.google.com/detail/sirv-lens/lihjnfpbomppjmdlnchkookggmefanbg).

Prefer the terminal? `curl -fsSL https://github.com/VKrachun/native-browser-lens/releases/latest/download/install.sh | sh`
(PowerShell: `irm https://github.com/VKrachun/native-browser-lens/releases/latest/download/install.ps1 | iex`).

Make the installers for the computer you are on with `node scripts/package.mjs --formats <formats>`
(`app,dmg`, `nsis`, or `appimage,deb,pacman`; add `--gpu vulkan` or `--gpu metal` for the GPU
speech program). The release workflow builds all of them for a `v*` tag.

## Website

`site/` is lens.sirv.studio: the landing page, privacy policy, permissions, terms and support (the
pages the extension stores ask for), served by Cloudflare Workers static assets. Put the installers
in `site/downloads/` (not committed), then `node site/deploy.mjs` assembles `site/dist/` with a
download manifest, SHA256SUMS and an Arch PKGBUILD, and deploys (`--dry-run` only assembles).

## Develop

Requirements: Rust (the version in `rust-toolchain.toml` installs by itself), Node.js 24, pnpm,
and Chromium for the end-to-end test.

```sh
cargo test                      # Rust tests; also regenerates extension/src/protocol
cargo build
lens register                   # target/debug/lens: register with your installed browsers
cd extension
pnpm install
pnpm build                      # .output/chrome-mv3; pnpm build:firefox for Firefox
LENS_E2E=1 pnpm build && pnpm test:e2e   # real Chromium, extension, shim, daemon, fixture site
```

Load `extension/.output/chrome-mv3` with **Load unpacked** in `chrome://extensions` and click the
Lens button. `lens status` shows the data folder and the daemon; `lens stop` stops the daemon.

## Agents

Coding agents read the defects a person reviewed, reproduce them and prove the fix. Three ways in:

- **Connect the agents here:** Settings > Coding agents, or `lens agents connect`. It adds the
  `sirv-lens` skill (`~/.claude/skills`, `~/.agents/skills`) and the `sirv-lens` MCP server to
  Claude Code, Codex, Cursor and Gemini CLI, for those installed. `lens agents disconnect` takes
  both back.
- **The plugin** (`plugin/`, the same skill and server, for Claude Code and Codex). It starts `lens`
  from PATH: the deb and pacman packages put it there; on macOS and with the AppImage, connect the
  agents from Settings instead.

  ```
  /plugin install sirv-lens --marketplace VKrachun/native-browser-lens
  ```

- **The CLI**, for agents without MCP and for scripts:

  | Command | What it does |
  | --- | --- |
  | `lens reviews [--json]` | Reviews, newest first, with their page and VibeQ task |
  | `lens review <id>` | One review as JSON (what `get_review` returns) |
  | `lens export <id> [--to DIR]` | The review as a folder: report, screenshots, evidence, test, HAR |
  | `lens export <id> --playwright [--to DIR] [--base-url URL]` | Each capture's test for the project (default `tests/lens`), private values from `LENS_PRIVATE_1` and on |
  | `lens verify <id> --base-url URL [--project DIR]` | Repeats the steps on the dev server with the project's Playwright; says whether the recorded failures happen again |
  | `lens recent [site]` | The last ten minutes the browser holds for a site (when Settings allows it) |

`lens mcp` serves the same over stdio:

| | |
| --- | --- |
| Tools | `list_reviews`, `search_reviews`, `get_review`, `read_review_file`, `playwright_test`, `verify_fix`, `recent_evidence` |
| Prompt | `fix` (a review id, or the VibeQ task it was filed as): `/mcp__sirv-lens__fix 12` in Claude Code |
| Resources | `lens://review/{id}` |

Every tool only reads, except `verify_fix`, which runs the project's Playwright in a scratch
folder (`.lens/verify`) and removes it. Page text in every answer is marked as untrusted data.

## VibeQ

Add the VibeQ address and your personal token in Lens Settings. The token stays in the system
secret store; `LENS_VIBEQ_TOKEN` overrides it for CI and automation. Filing a review again after
an error is always safe: Lens reconciles with VibeQ first and never creates a second task.
