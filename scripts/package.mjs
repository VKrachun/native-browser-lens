#!/usr/bin/env node
// Builds the friendly installers: Sirv Lens.app in a DMG (macOS), a setup program for the current
// user (Windows), and an AppImage, a .deb and an Arch package (Linux). One run makes the formats of
// the platform it runs on, from one build of Lens, its speech programs and the two extensions.
//
//   node scripts/package.mjs --formats appimage,deb,pacman [--gpu vulkan] [--target <triple>]
//
// macOS signing: set APPLE_SIGNING_IDENTITY. Notarization (app and DMG): also set APPLE_API_KEY
// (key ID), APPLE_API_ISSUER and APPLE_API_KEY_PATH (the App Store Connect .p8).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { formats: { type: 'string' }, gpu: { type: 'string' }, target: { type: 'string' }, 'skip-build': { type: 'boolean' } },
});
if (!values.formats) throw new Error('--formats is required, for example appimage,deb,pacman');
const root = resolve(import.meta.dirname, '..');
const windows = process.platform === 'win32';
const linux = process.platform === 'linux';
const darwin = process.platform === 'darwin';
const exe = windows ? '.exe' : '';
const run = (command, args, cwd = root, env = process.env) => execFileSync(command, args, { cwd, stdio: 'inherit', shell: windows, env });
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: root, shell: windows }));
const version = metadata.packages.find((p) => p.name === 'lens').version;
const arch = { x64: 'x64', arm64: 'arm64' }[process.arch] ?? process.arch;
const linuxArch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch] ?? process.arch;
// Linux: Lens is the static musl build (it needs no glibc at all), and the speech programs come from
// Ubuntu 22.04 in Docker (scripts/speech-linux.sh), so the packages start on glibc 2.34 and newer.
const target = values.target ?? (linux ? `${linuxArch}-unknown-linux-musl` : undefined);
const targetArgs = target ? ['--target', target] : [];
const release = join(metadata.target_directory, ...(target ? [target] : []), 'release');
const macosMin = (target?.startsWith('x86_64-') || (!target && arch === 'x64')) ? '10.15' : '11.0';
const buildEnv = darwin
  ? {
      ...process.env,
      MACOSX_DEPLOYMENT_TARGET: process.env.MACOSX_DEPLOYMENT_TARGET ?? macosMin,
      CMAKE_OSX_DEPLOYMENT_TARGET: process.env.CMAKE_OSX_DEPLOYMENT_TARGET ?? macosMin,
    }
  : process.env;

if (!values['skip-build']) {
  const extension = join(root, 'extension');
  run('pnpm', ['build'], extension);
  run('pnpm', ['build:firefox'], extension);
  run('cargo', ['build', '--release', '--locked', ...targetArgs], root, buildEnv);
  if (linux) {
    run('docker', ['run', '--rm', '-v', `${root}:/src`, '-w', '/src', 'ubuntu:22.04', 'sh', 'scripts/speech-linux.sh', 'target/jammy/bin', ...(values.gpu ? [values.gpu] : [])]);
    for (const name of ['lens-speech', ...(values.gpu ? ['lens-speech-gpu'] : [])]) {
      copyFileSync(join(root, 'target', 'jammy', 'bin', name), join(release, name));
    }
  } else {
    run('cargo', ['build', '--release', '--locked', '-p', 'lens-speech', ...targetArgs], root, buildEnv);
  }
  if (values.gpu && !linux) {
    // Its own target folder: the GPU build of lens-speech must not overwrite the CPU one.
    const gpuDir = join(metadata.target_directory, 'gpu');
    run('cargo', ['build', '--release', '--locked', '-p', 'lens-speech', '--features', values.gpu, '--target-dir', gpuDir, ...targetArgs], root, buildEnv);
    copyFileSync(
      join(gpuDir, ...(target ? [target] : []), 'release', `lens-speech${exe}`),
      join(release, `lens-speech-gpu${exe}`),
    );
  }
}

// A test build pre-grants the fixture sites (LENS_E2E in wxt.config.ts): installed, it would read
// them without the person's prompt. --skip-build packages whatever .output holds, so check it.
for (const folder of ['chrome-mv3', 'firefox-mv3']) {
  const manifest = JSON.parse(readFileSync(join(root, 'extension', '.output', folder, 'manifest.json'), 'utf8'));
  if (manifest.host_permissions?.length) {
    throw new Error(`extension/.output/${folder} is a test build (it grants ${manifest.host_permissions.join(', ')}); build it again without LENS_E2E`);
  }
}

// macOS: an x86_64 binary comes out of the linker unsigned (arm64 ones are signed ad hoc), and
// codesign refuses to sign Lens beside an unsigned program. The speech programs are signed first:
// with the Developer ID when there is one (cargo-packager signs them again), else ad hoc.
if (process.platform === 'darwin') {
  for (const name of ['lens-speech', 'lens-speech-gpu']) {
    const program = join(release, name);
    if (!existsSync(program)) continue;
    const identity = process.env.APPLE_SIGNING_IDENTITY;
    run('codesign', ['--force', ...(identity ? ['--options', 'runtime', '--timestamp', '--sign', identity] : ['--sign', '-']), program]);
  }
}

// The programs that go beside Lens: the speech programs. On Windows the shortcut opens lensw, which
// starts lens without a console window; lens then sees no terminal and runs the first run.
const binaries = windows
  ? [{ path: 'lensw', main: true }, { path: 'lens' }, { path: 'lens-speech' }]
  : [{ path: 'lens', main: true }, { path: 'lens-speech' }];
if (existsSync(join(release, `lens-speech-gpu${exe}`))) binaries.push({ path: 'lens-speech-gpu' });

const config = {
  name: 'sirv-lens',
  'product-name': 'Sirv Lens',
  version,
  identifier: 'studio.sirv.lens',
  description: 'Record browser defects with your voice, review them, and file them as tasks an agent can repeat.',
  'long-description':
    'Sirv Lens records what you do on a site, with your voice, the network and the console, and turns it into a reviewed task for VibeQ that a coding agent can reproduce.',
  homepage: 'https://lens.sirv.studio',
  authors: ['Igor Varyvoda <igor@varyvoda.com>'],
  category: 'DeveloperTool',
  publisher: 'Sirv',
  // Several sizes: the AppImage needs a square one at a size it knows (512 at most).
  // Absolute: the packager resolves relative paths from the config file's folder.
  // macOS's icns writer takes 1024 px only as a @2x image ("No matching IconType" otherwise).
  icons: ['icon-32.png', 'icon-128.png', 'icon-256.png', 'icon-512.png', process.platform === 'darwin' ? 'icon-512@2x.png' : 'icon.png'].map(
    (f) => join(root, 'assets', f),
  ),
  'out-dir': join(root, 'dist'),
  'binaries-dir': release,
  binaries,
  resources: [
    { src: join(root, 'extension/.output/chrome-mv3'), target: 'extension' },
    { src: join(root, 'extension/.output/firefox-mv3'), target: 'extension-firefox' },
  ],
  // Per user, no administrator: Lens itself installs per user (service, browser registrations).
  // The template is the packager's own plus Lens's steps: the background app stops before files
  // change, and an uninstall also removes the login entry and the browser registrations. The
  // uninstaller offers to delete the data folder (paths.rs), unticked.
  nsis: {
    installMode: 'currentUser',
    template: join(root, 'assets', 'windows', 'installer.nsi'),
    appdataPaths: ['$LOCALAPPDATA/Sirv/Lens'],
  },
  // Not just "lens": other software uses that package name.
  deb: { 'package-name': 'sirv-lens', depends: ['libc6'] },
  pacman: { depends: ['glibc'] },
  // The Vulkan loader belongs to the system, beside its GPU drivers; a bundled one would also need
  // the build computer's newer glibc. Without one, Lens uses the CPU speech program.
  appimage: { 'excluded-libraries': ['libvulkan.so*'] },
  macos: {
    'info-plist-path': join(root, 'assets', 'macos', 'Info.plist'),
    'minimum-system-version': macosMin,
    ...(process.env.APPLE_SIGNING_IDENTITY ? { 'signing-identity': process.env.APPLE_SIGNING_IDENTITY } : {}),
  },
};
const out = join(root, 'dist');
mkdirSync(out, { recursive: true });
const configPath = join(out, 'packager.json');
writeFileSync(configPath, JSON.stringify(config, null, 2));

// macOS: the packager makes and signs the app; the DMG is made here with hdiutil, since the
// packager's create-dmg drives Finder over AppleScript, which fails on headless runners. With the
// App Store Connect API key (APPLE_API_KEY = key ID, APPLE_API_ISSUER, APPLE_API_KEY_PATH = the .p8)
// both the app and the DMG are notarized and stapled here, so a downloaded DMG opens without a
// Gatekeeper warning. The packager would notarize the app itself on seeing the key: not given it.
const formats = values.formats.split(',');
const dmg = darwin && formats.includes('dmg');
const { APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH, APPLE_SIGNING_IDENTITY } = process.env;
const notarize = darwin && APPLE_API_KEY && APPLE_API_ISSUER && APPLE_API_KEY_PATH;
// linuxdeploy's own strip is older than current distributions' libraries (.relr.dyn) and fails
// on them; the binaries are release builds already.
const packagerEnv = { ...process.env, NO_STRIP: '1' };
if (darwin) for (const name of ['APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH']) delete packagerEnv[name];
const packagerFormats = dmg ? [...new Set([...formats.filter((f) => f !== 'dmg'), 'app'])] : formats;
run('cargo', ['packager', '--release', '--formats', packagerFormats.join(','), '--config', configPath], root, packagerEnv);

if (dmg) {
  // Apple's service sometimes drops the connection, a new ticket can take a moment to arrive, and
  // hdiutil sometimes finds its disk busy: each step tries again before failing the release.
  const retry = (step) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return step();
      } catch (error) {
        if (attempt === 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 15_000);
      }
    }
  };
  const notarizeAndStaple = (file, upload = file) => {
    const output = retry(() =>
      execFileSync('xcrun', ['notarytool', 'submit', upload, '--key', APPLE_API_KEY_PATH, '--key-id', APPLE_API_KEY, '--issuer', APPLE_API_ISSUER, '--wait', '--output-format', 'json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      }),
    );
    const { status, id } = JSON.parse(output);
    if (status !== 'Accepted') throw new Error(`notarization of ${file}: ${status} (see xcrun notarytool log ${id})`);
    retry(() => run('xcrun', ['stapler', 'staple', file]));
  };
  const app = join(out, `${config['product-name']}.app`);
  if (notarize) {
    const zip = join(out, 'notarize-app.zip');
    run('ditto', ['-c', '-k', '--keepParent', '--sequesterRsrc', app, zip]);
    notarizeAndStaple(app, zip);
    rmSync(zip);
  }
  // The DMG holds the app and a link to /Applications to drag it to.
  const stage = join(out, 'dmg-stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  run('ditto', [app, join(stage, `${config['product-name']}.app`)]);
  symlinkSync('/Applications', join(stage, 'Applications'));
  const file = join(out, `Sirv-Lens-${version}-macos-${arch}.dmg`);
  retry(() => run('hdiutil', ['create', '-volname', config['product-name'], '-srcfolder', stage, '-ov', '-fs', 'HFS+', '-format', 'UDZO', file]));
  rmSync(stage, { recursive: true });
  if (APPLE_SIGNING_IDENTITY) run('codesign', ['--force', '--timestamp', '--sign', APPLE_SIGNING_IDENTITY, file]);
  if (notarize) notarizeAndStaple(file);
}

// Names people recognise on a download page, instead of the packager's lens_VERSION_ARCH.
const names = [
  [/\.dmg$/, `Sirv-Lens-${version}-macos-${arch}.dmg`],
  [/-setup\.exe$/, `Sirv-Lens-${version}-windows-${arch}-setup.exe`],
  [/\.AppImage$/, `Sirv-Lens-${version}-linux-${linuxArch}.AppImage`],
  [/\.deb$/, `sirv-lens_${version}_${arch === 'x64' ? 'amd64' : arch}.deb`],
  [/\.tar\.gz$/, `sirv-lens-${version}-linux-${linuxArch}-pacman.tar.gz`],
];
for (const file of readdirSync(out)) {
  const found = names.find(([pattern]) => pattern.test(file));
  // cargo-packager names them lens_… (Linux) or "Sirv Lens_…" (macOS, Windows).
  if (found && /^(lens|lensw|Sirv Lens)_/.test(file)) renameSync(join(out, file), join(out, found[1]));
}
console.log(readdirSync(out).filter((f) => !f.startsWith('.')).join('\n'));

