import { defineConfig } from 'wxt';
import { DEV_KEY } from './src/dev-key';

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => {
    const firefox = browser === 'firefox';
    // The test build pre-grants fixture sites (below): a store package must never be one.
    if (process.env.LENS_E2E && process.env.LENS_STORE) throw new Error('LENS_E2E and LENS_STORE together: unset LENS_E2E for a store build');
    return {
      name: 'Sirv Lens',
      description: 'Record a bug with your voice: get a task with the steps, network errors and a replay. Works with the free Sirv Lens app.',
      permissions: [
        'nativeMessaging',
        'storage',
        'tabs',
        'scripting',
        'activeTab',
        // Wakes the background during a recording (see background.ts); it shows no warning.
        'alarms',
        ...(firefox ? ['webRequest'] : ['sidePanel', 'debugger', 'favicon', 'offscreen']),
      ],
      // Lens reads a site only after the person grants that exact origin from the side panel.
      // Firefox screenshots a tab only with <all_urls> (or a fresh toolbar click): Lens asks for it
      // there, and still collects only on the sites the person adds.
      optional_host_permissions: ['http://*/*', 'https://*/*', ...(firefox ? ['<all_urls>'] : [])],
      // The end-to-end build pre-grants the local fixture origin: a test cannot click Chrome's prompt.
      // .test is reserved for testing: the product screenshots serve their demo site there.
      ...(process.env.LENS_E2E ? { host_permissions: ['http://127.0.0.1/*', 'http://*.test/*', 'https://app.basecamp.com/*'] } : {}),
      action: { default_title: 'Open Lens' },
      commands: {
        capture: {
          suggested_key: { default: 'Alt+Shift+L' },
          description: 'Capture the page with its evidence',
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
