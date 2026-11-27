import { rmSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'wxt';
import { DEV_KEY } from './src/dev-key';

const require = createRequire(import.meta.url);
const transformersOrtDist = dirname(
  createRequire(require.resolve('@huggingface/transformers')).resolve('onnxruntime-web'),
);
const parakeetOrtDist = dirname(
  createRequire(require.resolve('parakeet.js')).resolve('onnxruntime-web'),
);

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [
      {
        // parakeet.js accepts `wasmPaths` in initOrt() but omits assigning it before the CDN fallback check.
        name: 'parakeet-honors-wasmPaths',
        transform(code, id) {
          if (id.replace(/\\/g, '/').endsWith('parakeet.js/src/backend.js') && code.includes('if (!ort.env.wasm.wasmPaths)')) {
            return {
              code: code.replace(
                'if (!ort.env.wasm.wasmPaths)',
                'if (wasmPaths) { ort.env.wasm.wasmPaths = wasmPaths; }\n  if (!ort.env.wasm.wasmPaths)',
              ),
              map: null,
            };
          }
          return null;
        },
      },
    ],
  }),
  hooks: {
    // Bundle onnxruntime-web's WASM + MJS loaders locally so MV3 CSP never fetches from cdn.jsdelivr.net.
    'build:publicAssets': (_wxt, assets) => {
      for (const file of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
        assets.push({
          absoluteSrc: join(transformersOrtDist, file),
          relativeDest: `ort/${file}`,
        });
      }
      for (const file of [
        'ort-wasm-simd-threaded.jsep.mjs',
        'ort-wasm-simd-threaded.jsep.wasm',
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.wasm',
      ]) {
        assets.push({
          absoluteSrc: join(parakeetOrtDist, file),
          relativeDest: `ort-parakeet/${file}`,
        });
      }
    },
    // Vite also emits a hashed duplicate of ort-wasm-*.wasm inside assets/ that we never use (wasmPaths points at /ort/).
    'build:done': (wxt) => {
      const assetsDir = join(wxt.config.outDir, 'assets');
      try {
        for (const name of readdirSync(assetsDir)) {
          if (/^ort-wasm-.*\.wasm$/.test(name)) rmSync(join(assetsDir, name), { force: true });
        }
      } catch {
        // ignore if assetsDir absent
      }
    },
  },
  manifest: ({ browser }) => {
    const firefox = browser === 'firefox';
    // The test build pre-grants fixture sites (below): a store package must never be one.
    if (process.env.LENS_E2E && process.env.LENS_STORE) throw new Error('LENS_E2E and LENS_STORE together: unset LENS_E2E for a store build');
    return {
      name: 'Sirv Lens',
      description: 'Record a bug with your voice: get a task with the steps, network errors and a replay. Runs completely in your browser.',
      permissions: [
        'storage',
        'tabs',
        'scripting',
        'activeTab',
        // Wakes the background during a recording (see background.ts); it shows no warning.
        'alarms',
        ...(firefox ? ['webRequest'] : ['sidePanel', 'debugger', 'favicon', 'offscreen']),
      ],
      // Allow WebAssembly for in-browser Whisper (WebGPU / WASM) transcription.
      content_security_policy: {
        extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
      },
      // Lens reads a site only after the person grants that exact origin from the side panel.
      // Firefox screenshots a tab only with <all_urls> (or a fresh toolbar click): Lens asks for it
      // there, and still collects only on the sites the person adds.
      optional_host_permissions: ['http://*/*', 'https://*/*', ...(firefox ? ['<all_urls>'] : [])],
      // The end-to-end build pre-grants the local fixture origin: a test cannot click Chrome's prompt.
      // .test is reserved for testing: the product screenshots serve their demo site there.
      ...(process.env.LENS_E2E ? { host_permissions: ['http://127.0.0.1/*', 'http://*.test/*', 'https://app.basecamp.com/*'] } : {}),
      // No img-src CSP for the extension pages: it would block "Show images from the site" too.
      // Replays fetch nothing by default because replay-offline.ts takes the addresses out first.
      // Split incognito on Chromium so Review, Replay, Annotate, Settings and Microphone tabs open
      // inside the Incognito window rather than jumping to or spawning a normal window. Firefox
      // does not support split mode and keeps its default.
      ...(firefox ? {} : { incognito: 'split' as const }),
      action: { default_title: 'Open Lens' },
      commands: {
        'toggle-recording': {
          suggested_key: { default: 'Alt+Shift+R' },
          description: 'Start or stop recording the current tab',
        },
        'drop-marker': {
          suggested_key: { default: 'Alt+Shift+M' },
          description: 'Drop a timestamped marker during recording',
        },
      },
      // The key pins the unpacked development ID that `lens register` allows. Store builds drop it.
      ...(firefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'lens@sirv.studio',
                strict_min_version: '140.0',
                data_collection_permissions: {
                  required: ['none'],
                  optional: ['websiteContent', 'websiteActivity', 'browsingActivity', 'personallyIdentifyingInfo'],
                },
              },
            },
          }
        : // The Chrome Web Store refuses a manifest with a key; it gives the store build its own ID.
          process.env.LENS_STORE
          ? {}
          : { key: DEV_KEY }),
    };
  },
});
