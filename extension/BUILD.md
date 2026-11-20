# Building the Sirv Lens extension from source

Requirements: Node.js 24 and pnpm 11 (any OS).

```sh
pnpm install --frozen-lockfile
pnpm build:firefox   # Firefox: .output/firefox-mv3
pnpm build           # Chrome:  .output/chrome-mv3
```

`pnpm zip:firefox` makes the same package as the one submitted. The code is TypeScript and React,
bundled by WXT (Vite); nothing is fetched or generated at run time. `src/protocol` holds TypeScript
types generated from the Lens app (Rust, ts-rs) and committed as source.

The extension reads the local review from the Sirv Lens app through native messaging
(host `studio.sirv.lens`). The app is free: https://lens.sirv.studio
