// Browser-initiated tabs may navigate before Playwright can intercept their first request.
// Resolve the Basecamp hostname to loopback and use the editor's real file handling there.
import { createServer } from 'node:https';
import { createHash, createPublicKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { generate } from 'selfsigned';
import { rolldown } from 'rolldown';

export async function basecampFixture() {
  const tls = await generate([{ name: 'commonName', value: 'app.basecamp.com' }], { algorithm: 'sha256' });
  const pin = createHash('sha256').update(createPublicKey(tls.cert).export({ type: 'spki', format: 'der' })).digest('base64');
  const build = await rolldown({
    input: fileURLToPath(import.meta.resolve('@37signals/lexxy')),
    external: ['@rails/activestorage'], platform: 'browser',
    transform: { define: { 'process.env.NODE_ENV': '"production"' } },
  });
  const { output } = await build.generate({ format: 'esm' });
  await build.close();
  const scripts = { trix: readFileSync(new URL(import.meta.resolve('trix'))), lexxy: output[0].code };
  const fixture = { editor: 'trix', submitted: 0, restored: false };
  const server = createServer({ key: tls.private, cert: tls.cert }, (req, res) => {
    if (req.method !== 'GET') { fixture.submitted++; res.writeHead(405).end(); return; }
    if (req.url === '/editor.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(scripts[fixture.editor]);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(`
      <style>trix-editor, lexxy-editor {display:block; min-height:80px}</style>
      <script type="module" src="/editor.js"></script>
      <form method="post">
        <textarea name="todo[content]" aria-label="Title">${fixture.restored ? 'My existing draft' : ''}</textarea>
        <input id="notes" type="hidden" name="todo[description]"><${fixture.editor}-editor input="notes"></${fixture.editor}-editor>
        <button>Add to-do</button>
      </form>
      <script>document.addEventListener('trix-attachment-add', e => {
        (window.received ??= []).push(e.attachment.file);
        // As Basecamp does: the upload finishes and the attachment gets its address, so the
        // editor's progress bar goes away.
        if (e.attachment.file) {
          e.attachment.setUploadProgress(100);
          e.attachment.setAttributes({ url: '/uploads/' + encodeURIComponent(e.attachment.file.name) });
        }
      });</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return Object.assign(fixture, { server, flags: [
    '--host-resolver-rules=MAP app.basecamp.com 127.0.0.1:' + server.address().port,
    '--ignore-certificate-errors-spki-list=' + pin,
    '--no-proxy-server',
  ] });
}
