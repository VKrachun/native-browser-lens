# Store listing texts (Chrome Web Store, Firefox Add-ons)

Packages: `cd extension && LENS_STORE=1 pnpm zip && LENS_STORE=1 pnpm zip:firefox`
(`.output/sirv-lens-extension-<v>-chrome.zip`, `-firefox.zip`, `-sources.zip`). Images: this folder.

## Name and summary

- Name: Sirv Lens
- Summary (manifest description, 120 characters): Record a bug with your voice: get a task with the
  steps, network errors and a replay. Works with the free Sirv Lens app.
- Category: Developer Tools (Chrome); Web Development (Firefox)
- Homepage: https://lens.sirv.studio
- Support: https://lens.sirv.studio/support, lens@sirv.studio
- Privacy policy: https://lens.sirv.studio/privacy

## Description

Lens turns "this looks broken" into a task that a developer or a coding agent can reproduce.

Open the Lens side panel on the site you test, press Record and talk. Lens keeps your clicks, keys and page changes, the network and the console, and your voice. Press Stop and Lens opens the recording: a replay of the page with your words, written down on your computer.

- Trim and cut, draw on the page, highlight an element, and black out anything private.
- With your own Claude Code or Codex (optional), Lens writes the title and findings and splits a long recording into one task per problem.
- Open a draft in Linear or GitHub Issues, or copy a summary into Jira Cloud. In Basecamp, Lens fills the title and Notes and attaches your selected evidence ZIP or replay MP4. The video can include your recorded microphone audio. You post the to-do when ready.
- Coding agents read reviewed recordings from Lens over MCP.

Private by default
- Lens reads a site only after you allow it, one site at a time.
- Recordings and your voice stay on your computer until you file or export them. You can include recorded microphone audio in a replay video you share.
- Passwords, card numbers and private fields are masked. Cookies, request headers and tokens are never recorded.
- No analytics, no tracking, and no server of ours.

Lens needs its free companion app for macOS, Windows or Linux: https://lens.sirv.studio. The app stores the recordings, writes down your voice with Whisper and files the tasks.

Why each permission: https://lens.sirv.studio/permissions
Privacy policy: https://lens.sirv.studio/privacy

## Chrome: privacy practices

Single purpose: Lens records a browser session with the user's voice and turns it into a reproducible bug report (the steps, the network and console evidence, and a replay) that the user reviews and files.

Permission justifications:
- debugger: To read what the page did on sites the user allowed: network requests and their status, bodies of the site's own API calls and failed requests, console errors, and a screenshot after each step. Lens attaches only to tabs of allowed sites.
- nativeMessaging: To talk to the Sirv Lens app on the same computer, which stores recordings, transcribes the voice and files tasks. The extension talks to no server.
- sidePanel: Lens works from the side panel: Record, Stop, recordings and notes.
- tabs: To know which site the active tab shows, so Lens collects only on allowed sites, and to open the review page after a recording.
- scripting: To add the recorder (page structure and the user's steps, private fields masked) to tabs of allowed sites.
- activeTab: To capture the tab in front when the user clicks the Lens button or presses its shortcut.
- storage: To keep the user's settings, such as the recording mode and whether to record the voice.
- offscreen: To keep recording the user's voice while the side panel is closed during a recording.
- favicon: To show each site's icon in the side panel.
- Host permissions (optional, http/https): requested for sites you choose to record and for the saved Basecamp destination when you choose to fill its draft.

Remote code: No. All code is in the package.

Data usage (handled on the user's computer, sent only where the user files): Website content, User activity, Web history, Personally identifiable information (optional recorded voice). Certify: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used for creditworthiness or lending.

## Firefox: notes for reviewers

The extension needs its companion app (native messaging host studio.sirv.lens). To test:
1. Download the app from https://lens.sirv.studio (Linux AppImage or deb, or the notarized macOS DMG) and open it once. It registers the native messaging host for Firefox and opens a welcome page.
2. Load the add-on, open its sidebar on any http(s) site, choose "Collect evidence on this site", then Record and Stop. The recording opens for review.

Source: the package is built with WXT (Vite) from the attached source archive; see BUILD.md in it (`pnpm install --frozen-lockfile && pnpm zip:firefox`). The `<all_urls>` optional permission is requested only because Firefox allows tab screenshots (tabs.captureVisibleTab) only with it; Lens still records only the sites the user adds. Basecamp draft sharing requests optional Firefox data permissions for the selected review content and URLs, recorded interactions in attachments, and microphone audio when included.
