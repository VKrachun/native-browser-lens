#!/usr/bin/env node
// Assembles site/dist (the pages, plus the installers in site/downloads with a manifest of their
// sizes and SHA-256 sums) and deploys lens.sirv.studio. `--dry-run` assembles and checks only.
//   node site/deploy.mjs [--dry-run]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const site = import.meta.dirname;
const dist = join(site, 'dist');
const downloads = join(site, 'downloads');
// Workers static assets take files up to 25 MiB.
const LIMIT = 25 * 1024 * 1024;
const KINDS = [
  [/macos-arm64\.dmg$/, 'mac', 'Apple silicon (.dmg)'],
  [/macos-x64\.dmg$/, 'mac', 'Intel (.dmg)'],
  [/x86_64\.AppImage$/, 'linux', 'AppImage'],
  [/_amd64\.deb$/, 'linux', '.deb (Debian, Ubuntu)'],
  [/aarch64\.AppImage$/, 'linux', 'AppImage (ARM64)'],
  [/_arm64\.deb$/, 'linux', '.deb ARM64 (Debian, Ubuntu)'],
  [/^PKGBUILD$/, 'linux', 'Arch (PKGBUILD)'],
  [/-setup\.exe$/, 'windows', 'Download setup'],
];

rmSync(dist, { recursive: true, force: true });
cpSync(join(site, 'public'), dist, { recursive: true });
mkdirSync(join(dist, 'download'), { recursive: true });
// Older versions stay downloadable at their address (winget and old links point there), but the
// page lists only the newest file of each kind.
const versionOf = (name) => (name.match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};
let files = [];
const sums = [];
let pacman;
for (const name of existsSync(downloads) ? readdirSync(downloads).sort() : []) {
  const isPacman = /-pacman\.tar\.gz$/.test(name);
  const kind = KINDS.find(([pattern]) => pattern.test(name));
  if (!kind && !isPacman) continue;
  const path = join(downloads, name);
  const size = statSync(path).size;
  if (size > LIMIT) throw new Error(`${name} is ${(size / 1048576).toFixed(1)} MiB; Workers assets take 25 MiB at most`);
  cpSync(path, join(dist, 'download', name));
  const data = readFileSync(path);
  const sha256 = createHash('sha256').update(data).digest('hex');
  // The Arch archive is the PKGBUILD's source, not a download of its own.
  if (isPacman) {
    sums.push(`${sha256}  ${name}`);
    if (!pacman || newer(versionOf(name), versionOf(pacman.name))) pacman = { name, data };
    continue;
  }
  files.push({ os: kind[1], label: kind[2], name, size, sha256, order: KINDS.indexOf(kind) });
}
if (pacman) {
  const { name, data } = pacman;
  const version = name.match(/sirv-lens-(.+)-linux-x86_64-pacman\.tar\.gz/)[1];
  writeFileSync(
    join(dist, 'download', 'PKGBUILD'),
    [
      '# Maintainer: Igor Varyvoda <lens@sirv.studio>',
      'pkgname=sirv-lens-bin',
      `pkgver=${version}`,
      'pkgrel=1',
      "pkgdesc='Record browser defects with your voice, review them, and file them as tasks an agent can repeat.'",
      "arch=('x86_64')",
      "url='https://lens.sirv.studio'",
      "license=('custom')",
      "depends=('glibc')",
      "provides=('sirv-lens')",
      "conflicts=('sirv-lens')",
      "options=('!strip' '!lto')",
      `source=("https://lens.sirv.studio/download/${name}")`,
      `sha512sums=('${createHash('sha512').update(data).digest('hex')}')`,
      'package() {',
      '  cp -r "${srcdir}/usr" "${pkgdir}/"',
      '}',
      '',
    ].join('\n'),
  );
}
const newest = new Map();
for (const file of files) {
  const best = newest.get(file.order);
  if (!best || newer(versionOf(file.name), versionOf(best.name))) newest.set(file.order, file);
}
files = [...newest.values()];
// The page offers one version: a platform whose newest file is older means its file is missing.
const listed = [...files.map((f) => f.name), ...(pacman ? [pacman.name] : [])];
if (new Set(listed.map((name) => versionOf(name).join('.'))).size > 1) {
  throw new Error(`site/downloads does not hold every file of one version; the newest of each kind are:\n  ${listed.join('\n  ')}`);
}
const pkgbuild = join(dist, 'download', 'PKGBUILD');
if (existsSync(pkgbuild)) {
  const data = readFileSync(pkgbuild);
  files.push({ os: 'linux', label: 'Arch (PKGBUILD)', name: 'PKGBUILD', size: data.length, sha256: createHash('sha256').update(data).digest('hex'), order: KINDS.findIndex((k) => k[1] === 'linux' && k[2].startsWith('Arch')) });
}
files.sort((a, b) => a.order - b.order);
writeFileSync(join(dist, 'download', 'manifest.json'), JSON.stringify({ files: files.map(({ order, ...f }) => f) }, null, 2));
sums.push(...files.map((f) => `${f.sha256}  ${f.name}`));
writeFileSync(join(dist, 'download', 'SHA256SUMS'), sums.length ? `${sums.join('\n')}\n` : '');
console.log(files.length ? files.map((f) => `${f.name}  ${(f.size / 1e6).toFixed(1)} MB  ${f.sha256}`).join('\n') : 'no installers in site/downloads');
if (!process.argv.includes('--dry-run')) {
  execFileSync('npx', ['wrangler', 'deploy', '--config', join(site, 'wrangler.jsonc')], { stdio: 'inherit' });
}
