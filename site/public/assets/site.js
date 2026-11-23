// The download section: the visitor's system first, and the files with their sizes and SHA-256
// sums from /download/manifest.json, which the deploy writes from the installers it uploads.
const RELEASES = 'https://github.com/sirv/native-browser-lens/releases/latest';
const platform = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
const os = platform.includes('mac') ? 'mac' : platform.includes('win') ? 'windows' : platform.includes('linux') ? 'linux' : null;
const names = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };

if (os) document.querySelector(`.dl[data-os="${os}"]`)?.setAttribute('data-here', '');

const megabytes = (bytes) => (bytes < 1e6 ? `${Math.ceil(bytes / 1e3)} KB` : `${(bytes / 1e6).toFixed(1)} MB`);

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

fetch('/download/manifest.json')
  .then((r) => {
    if (!r.ok) throw new Error(`manifest: ${r.status}`);
    return r.json();
  })
  .then(({ files }) => {
    for (const file of files) {
      const box = document.querySelector(`[data-files="${file.os}"]`);
      if (!box) continue;
      const link = document.createElement('a');
      link.className = 'btn btn-sm';
      link.href = `/download/${file.name}`;
      link.textContent = `${file.label} · ${megabytes(file.size)}`;
      link.title = `SHA-256 ${file.sha256}`;
      box.append(link);
    }
    // One obvious file per system: the DMG on a Mac, the AppImage on Linux. ARM Linux gets an ARM
    // file or none; a browser cannot tell an Intel Mac, so a link under the button offers its DMG.
    const arm = /aarch64|arm/.test(platform);
    const mine = files.filter((f) => f.os === os && (os !== 'linux' || /aarch64|arm64/.test(f.name) === arm));
    const hero = document.querySelector('[data-download]');
    if (hero && mine.length) {
      hero.textContent = `Download for ${names[os]}`;
      hero.href = `/download/${mine[0].name}`;
      const intel = os === 'mac' && mine.find((f) => f.name.includes('macos-x64'));
      if (intel && intel !== mine[0]) {
        const note = document.createElement('p');
        note.className = 'fine';
        const a = document.createElement('a');
        a.href = `/download/${intel.name}`;
        a.textContent = 'Download the Intel DMG';
        note.append('Intel Mac? ', a, '.');
        hero.parentElement.after(note);
      }
    }
    fillEmpty('Coming soon.');
  })
  .catch(() => fillEmpty('The file list did not load.', true));
