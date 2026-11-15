import { PROTOCOL_VERSION } from './lens-client';
import type { ClientInfo } from './protocol/ClientInfo';

/** Which browser this is, as setup names it. */
export async function detectBrowser(): Promise<string> {
  const firefox = (browser.runtime as unknown as { getBrowserInfo?: () => Promise<{ name: string }> }).getBrowserInfo;
  if (firefox) return (await firefox()).name.toLowerCase();
  const nav = navigator as Navigator & { brave?: unknown; userAgentData?: { brands: { brand: string }[] } };
  if (nav.brave) return 'brave';
  const brands = nav.userAgentData?.brands.map((b) => b.brand) ?? [];
  if (brands.includes('Microsoft Edge')) return 'edge';
  if (brands.includes('Google Chrome')) return 'chrome';
  return 'chromium';
}

/** A random ID for this browser profile, so setup can tell two profiles apart. */
async function profileId(): Promise<string> {
  const { profile } = (await browser.storage.local.get('profile')) as { profile?: string };
  if (profile) return profile;
  const created = crypto.randomUUID();
  await browser.storage.local.set({ profile: created });
  return created;
}

export async function clientInfo(): Promise<ClientInfo> {
  const { origins = [] } = await browser.permissions.getAll();
  return {
    browser: await detectBrowser(),
    extensionVersion: browser.runtime.getManifest().version,
    profile: await profileId(),
    protocol: PROTOCOL_VERSION,
    grantedOrigins: [...new Set(origins.filter((o) => /^https?:\/\//.test(o)).map((o) => o.replace(/\/\*$/, '')))],
    extensionId: browser.runtime.id,
  };
}
