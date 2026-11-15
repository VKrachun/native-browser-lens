// The download section: the visitor's system first, and the files with their sizes and SHA-256
// sums from /download/manifest.json, which the deploy writes from the installers it uploads.
const platform = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
const os = platform.includes('mac') ? 'mac' : platform.includes('win') ? 'windows' : platform.includes('linux') ? 'linux' : null;
const names = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };

if (os) document.querySelector(`.dl[data-os="${os}"]`)?.setAttribute('data-here', '');

const megabytes = (bytes) => (bytes < 1e6 ? `${Math.ceil(bytes / 1e3)} KB` : `${(bytes / 1e6).toFixed(1)} MB`);

fetch('/download/manifest.json')
  .then((r) => (r.ok ? r.json() : { files: [] }))
  .then(({ files }) => {
    for (const file of files) {
      const box = document.querySelector(`[data-files="${file.os}"]`);
      if (!box) continue;
      const link = document.createElement('a');
      link.className = 'btn btn-ghost btn-sm';
      link.href = `/download/${file.name}`;
      link.textContent = `${file.label} · ${megabytes(file.size)}`;
      link.title = `SHA-256 ${file.sha256}`;
      box.append(link);
    }
    const mine = files.filter((f) => f.os === os);
    const hero = document.querySelector('[data-download]');
    if (hero && mine.length) {
      hero.textContent = `Download for ${names[os]}`;
      // One obvious file per system: the DMG on a Mac, the AppImage on Linux.
      hero.href = `/download/${mine[0].name}`;
    }
    for (const box of document.querySelectorAll('[data-files]')) {
      if (!box.children.length) {
        const soon = document.createElement('p');
        soon.className = 'soon';
        soon.textContent = 'Coming soon.';
        box.append(soon);
      }
    }
  })
  .catch(() => {});
