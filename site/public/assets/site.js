// The download section: the visitor's system first, and the files with their sizes and SHA-256
// sums from /download/manifest.json, which the deploy writes from the installers it uploads.
const RELEASES = 'https://github.com/sirv/native-browser-lens/releases/latest';
const platform = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
const os = platform.includes('mac') ? 'mac' : platform.includes('win') ? 'windows' : platform.includes('linux') ? 'linux' : null;
const names = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };

if (os) document.querySelector(`.dl[data-os="${os}"]`)?.setAttribute('data-here', '');

const megabytes = (bytes) => (bytes < 1e6 ? `${Math.ceil(bytes / 1e3)} KB` : `${(bytes / 1e6).toFixed(1)} MB`);

/** Returns 'arm', 'x86', or null when the browser hides the CPU architecture. */
const detectArch = async () => {
  try {
    const hints = await navigator.userAgentData?.getHighEntropyValues?.(['architecture']);
    const arch = hints?.architecture?.toLowerCase();
    if (arch === 'arm') return 'arm';
    if (arch === 'x86') return 'x86';
  } catch {}
  if (os === 'mac') {
    // Firefox and older browsers expose the GPU through WebGL; Safari masks both Apple silicon and
    // Intel as "Apple GPU", so only specific chip names count as a reliable signal.
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = String(
          (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '',
        );
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        if (/\bapple m\d/i.test(renderer)) return 'arm';
        if (/\b(intel|amd|radeon|nvidia|geforce)\b/i.test(renderer)) return 'x86';
      }
    } catch {}
    return null;
  }
  const raw = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
  if (/aarch64|arm64/.test(raw)) return 'arm';
  if (/x86_64|x64|win64|wow64|amd64/.test(raw)) return 'x86';
  return null;
};

/** An empty box says why, with the way to the files: the release on GitHub when this site cannot list them. */
const fillEmpty = (text, link) => {
  for (const box of document.querySelectorAll('[data-files]')) {
    if (box.children.length) continue;
    const note = document.createElement('p');
    note.className = 'soon';
    note.textContent = text;
    if (link) {
      const a = document.createElement('a');
      a.href = RELEASES;
      a.textContent = 'Get it from GitHub Releases';
      note.append(' ', a, '.');
    }
    box.append(note);
  }
};

const addNote = (hero, ...parts) => {
  const note = document.createElement('p');
  note.className = 'fine';
  note.append(...parts);
  hero.parentElement.after(note);
};

const fileLink = (file, text) => {
  const a = document.createElement('a');
  a.href = `/download/${file.name}`;
  a.textContent = text;
  return a;
};

Promise.all([
  fetch('/download/manifest.json').then((r) => {
    if (!r.ok) throw new Error(`manifest: ${r.status}`);
    return r.json();
  }),
  detectArch(),
])
  .then(([{ files }, arch]) => {
    const ordered =
      os === 'mac' && arch === 'x86'
        ? [...files].sort((a, b) => (b.name.includes('macos-x64') ? 1 : 0) - (a.name.includes('macos-x64') ? 1 : 0))
        : files;
    for (const file of ordered) {
      const box = document.querySelector(`[data-files="${file.os}"]`);
      if (!box) continue;
      const link = document.createElement('a');
      link.className = 'btn btn-sm';
      link.href = `/download/${file.name}`;
      link.textContent = `${file.label} · ${megabytes(file.size)}`;
      link.title = `SHA-256 ${file.sha256}`;
      box.append(link);
    }
    const hero = document.querySelector('[data-download]');
    if (hero && os) {
      if (os === 'mac') {
        const armFile = files.find((f) => f.os === 'mac' && f.name.includes('macos-arm64'));
        const x64File = files.find((f) => f.os === 'mac' && f.name.includes('macos-x64'));
        if (arch === 'x86' && x64File) {
          hero.textContent = 'Download for Mac (Intel)';
          hero.href = `/download/${x64File.name}`;
          if (armFile) addNote(hero, 'Apple silicon Mac? ', fileLink(armFile, 'Download the Apple silicon DMG'), '.');
        } else if (arch === 'arm' && armFile) {
          hero.textContent = 'Download for Mac (Apple silicon)';
          hero.href = `/download/${armFile.name}`;
          if (x64File) addNote(hero, 'Intel Mac? ', fileLink(x64File, 'Download the Intel DMG'), '.');
        } else if (armFile || x64File) {
          // Do not guess arm64 when the browser hides the Mac chip: send visitors to the Mac
          // card (or let them pick directly below) so Intel Macs never get the wrong DMG.
          hero.textContent = 'Download for macOS';
          hero.href = '#download';
          if (armFile && x64File) {
            addNote(
              hero,
              'Choose your Mac: ',
              fileLink(armFile, 'Apple silicon (.dmg)'),
              ' or ',
              fileLink(x64File, 'Intel (.dmg)'),
              '.',
            );
          }
        }
      } else {
        const arm = arch === 'arm';
        const mine = files.filter((f) => f.os === os && (os !== 'linux' || /aarch64|arm64/.test(f.name) === arm));
        if (mine.length) {
          hero.textContent = `Download for ${names[os]}`;
          hero.href = `/download/${mine[0].name}`;
        }
      }
    }
    fillEmpty('Coming soon.');
  })
  .catch(() => fillEmpty('The file list did not load.', true));
