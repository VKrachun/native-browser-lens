// The Open Graph image, site/public/assets/og.png (1200x630), drawn with the site's own CSS: node site/og.mjs
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';

const root = join(import.meta.dirname, '..');
const { chromium } = createRequire(join(root, 'extension/package.json'))('playwright-core');
const pub = join(root, 'site/public');
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/site.css"><style>
body{width:1200px;height:630px;overflow:hidden;margin:0}
.og{display:grid;grid-template-columns:1fr 520px;gap:48px;padding:56px 64px;height:630px;box-sizing:border-box;align-items:center}
.og h1{font-size:68px;line-height:.98;font-weight:800;letter-spacing:-0.022em;margin-top:28px}
.og .brand{font-size:26px}.og .brand img{width:40px;height:40px}
.og .url{margin-top:28px;font:400 20px var(--record);color:var(--ink-soft)}
.og .lines li{animation:none!important}.og .lines .bar{animation:none!important}

</style></head><body><div class="og"><div><span class="brand"><img src="/assets/icon.svg" alt="">Sirv Lens</span>
<h1>Show the bug. Say what's wrong. Hand it to an agent.</h1><p class="url">lens.sirv.studio · free</p></div>
<figure class="sheet"><div class="caption"><p class="caption-case">Checkout: total shows NaN after the SAVE20 coupon</p><p class="caption-meta">shop.juniper.test · 0:21 · with your voice</p></div>
<ol class="lines">
<li><time>0:01</time><span class="who who-say">You said</span><span class="what"><q>I apply the coupon, SAVE20.</q></span></li>
<li><time>0:04</time><span class="who">Step</span><span class="what">Click button <b>“Apply”</b></span></li>
<li class="fail"><time>0:04</time><span class="who">HTTP 500</span><span class="what"><code>POST /api/price</code></span></li>
<li><time>0:05</time><span class="who">Screen</span><span class="what">Appeared: <b>“$NaN”</b></span></li>
<li><time>0:06</time><span class="who who-say">You said</span><span class="what"><q>The total is broken.</q></span></li>
<li><time>0:12</time><span class="who">Step</span><span class="what">Card number <span class="bar"></span></span></li>
</ol><span class="exhibit exhibit-link">Exhibit <b>A</b></span></figure></div></body></html>`;
const types = { '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/og') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
  const f = join(pub, p);
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, colorScheme: 'light', reducedMotion: 'reduce' });
await page.goto(`http://127.0.0.1:${server.address().port}/og`, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(pub, 'assets/og.png') });
await browser.close(); server.close();
