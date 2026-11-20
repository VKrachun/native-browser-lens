import { expect, it } from 'vitest';
import { OFFLINE_POLICY, offlineCss, offlineEvents } from './replay-offline';

const BLANK = /^data:image\/gif;base64,/;

it('takes the remote addresses out of CSS and keeps the rest', () => {
  expect(offlineCss('a{background:url("https://x.test/a.png") no-repeat}')).toBe('a{background:none no-repeat}');
  expect(offlineCss("b{background:url( 'http://x.test/b.png' )}")).toBe('b{background:none}');
  expect(offlineCss('c{background:url(//cdn.test/c.png)}')).toBe('c{background:none}');
  expect(offlineCss('@import "https://x.test/more.css" screen;\nd{color:red}')).toBe('\nd{color:red}');
  expect(offlineCss('@import url(https://x.test/more.css);')).toBe('');
  // What the URL parser reads as remote, and the plain strings of image-set(), go too.
  expect(offlineCss('b{background:url("ht\\ntps://x.test/a.png")}')).toBe('b{background:none}');
  expect(offlineCss('b{background:url(\\\\x.test/a.png)}')).toBe('b{background:none}');
  expect(offlineCss('b{background:image-set("https://x.test/a.png" 1x)}')).toBe('b{background:image-set("" 1x)}');
  expect(offlineCss('b{content:"hi"; background:url(data:image/png;base64,AA)}')).toBe('b{content:"hi"; background:url(data:image/png;base64,AA)}');
  expect(offlineCss('e{background:url(data:image/png;base64,AAAA)}')).toBe('e{background:url(data:image/png;base64,AAAA)}');
  expect(offlineCss('f{background:url(blob:chrome-extension://a/b)}')).toBe('f{background:url(blob:chrome-extension://a/b)}');
});

it('leaves a full snapshot with nothing to fetch, but links and inlined images as they were', () => {
  const [snapshot] = offlineEvents([
    {
      type: 2,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [{ type: 2, id: 100, tagName: 'html', attributes: {}, childNodes: [{ type: 2, id: 101, tagName: 'body', attributes: {}, childNodes: [
            { type: 2, id: 2, tagName: 'img', attributes: { src: 'https://x.test/a.png', srcset: 'https://x.test/a2.png 2x', alt: 'A' }, childNodes: [] },
            { type: 2, id: 3, tagName: 'img', attributes: { src: 'data:image/png;base64,AAAA', rr_dataURL: 'data:image/png;base64,BBBB' }, childNodes: [] },
            { type: 2, id: 4, tagName: 'a', attributes: { href: 'https://x.test/next', style: 'background:url(https://x.test/bg.png)' }, childNodes: [] },
            { type: 2, id: 5, tagName: 'link', attributes: { rel: 'stylesheet', href: 'https://x.test/s.css', _cssText: 'g{background:url(https://x.test/g.png)}' }, childNodes: [] },
            { type: 2, id: 6, tagName: 'iframe', attributes: { src: 'https://ads.test/frame' }, childNodes: [] },
            { type: 2, id: 7, tagName: 'video', attributes: { src: 'https://x.test/v.mp4', poster: 'https://x.test/p.png' }, childNodes: [] },
            { type: 2, id: 8, tagName: 'style', attributes: {}, childNodes: [{ type: 3, id: 9, textContent: 'h{background:url("https://x.test/h.png")}', isStyle: true }] },
            { type: 2, id: 10, tagName: 'meta', attributes: { 'http-equiv': 'refresh', content: '0;url=https://x.test/' }, childNodes: [] },
          ] }] }],
        },
      },
    },
  ]) as { data: { node: { childNodes: { attributes: Record<string, unknown>; childNodes: { textContent?: string }[] }[] } } }[];
  // The root <html> gets a head with the policy; the body follows it.
  const html = snapshot!.data.node.childNodes[0] as unknown as { childNodes: { childNodes: NonNullable<typeof snapshot>["data"]["node"]["childNodes"] }[] };
  const [img, inlined, link, sheet, frame, video, style, meta] = html.childNodes[1]!.childNodes;
  expect(img!.attributes.src).toMatch(BLANK);
  expect(img!.attributes).not.toHaveProperty('srcset');
  expect(img!.attributes.alt).toBe('A');
  expect(inlined!.attributes).toEqual({ src: 'data:image/png;base64,AAAA', rr_dataURL: 'data:image/png;base64,BBBB' });
  expect(link!.attributes).toEqual({ href: 'https://x.test/next', style: 'background:none' });
  expect(sheet!.attributes).toEqual({ rel: 'stylesheet', _cssText: 'g{background:none}' });
  expect(frame!.attributes.src).toBe('about:blank');
  expect(video!.attributes).toEqual({});
  expect(style!.childNodes[0]!.textContent).toBe('h{background:none}');
  expect(meta!.attributes).toEqual({ 'http-equiv': 'refresh' });
});

it('rewrites later changes: added nodes, attribute changes by id, text, rules and fonts', () => {
  const [mutation, rule, declaration, font] = offlineEvents([
    {
      type: 3,
      data: {
        source: 0,
        adds: [{ parentId: 1, nextId: null, node: { type: 2, id: 20, tagName: 'img', attributes: { src: 'https://x.test/1.png' }, childNodes: [] } }],
        attributes: [
          { id: 20, attributes: { src: 'https://x.test/2.png', srcset: '//cdn.test/2.png 1x' } },
          { id: 21, attributes: { href: 'https://x.test/unknown' } },
          { id: 22, attributes: { style: { background: 'url(https://x.test/s.png)', color: 'red' } } },
        ],
        texts: [{ id: 30, value: 'i{background:url(https://x.test/i.png)}' }],
      },
    },
    { type: 3, data: { source: 8, id: 40, adds: [{ rule: 'j{background:url(https://x.test/j.png)}', index: 0 }] } },
    { type: 3, data: { source: 13, id: 41, set: { property: 'background', value: 'url(https://x.test/k.png)' } } },
    { type: 3, data: { source: 10, family: 'Brand', fontSource: 'https://x.test/brand.woff2', buffer: false } },
  ]) as { data: Record<string, any> }[];
  expect(mutation!.data.adds[0].node.attributes.src).toMatch(BLANK);
  expect(mutation!.data.attributes[0].attributes.src).toMatch(BLANK);
  expect(mutation!.data.attributes[0].attributes.srcset).toBeNull();
  // An element Lens never saw added: its address goes, whatever it is.
  expect(mutation!.data.attributes[1].attributes.href).toBeNull();
  expect(mutation!.data.attributes[2].attributes.style).toEqual({ background: 'none', color: 'red' });
  expect(mutation!.data.texts[0].value).toBe('i{background:none}');
  expect(rule!.data.adds[0].rule).toBe('j{background:none}');
  expect(declaration!.data.set.value).toBe('none');
  expect(font!.data.fontSource).toBe('local("none")');
});

it('gives every full snapshot the offline policy and drops srcdoc', () => {
  const snapshot = {
    type: 2,
    data: { node: { type: 0, childNodes: [{ type: 2, tagName: 'html', childNodes: [{ type: 2, tagName: 'head', attributes: {}, childNodes: [] }, { type: 2, tagName: 'body', attributes: {}, childNodes: [{ type: 2, tagName: 'iframe', id: 9, attributes: { srcdoc: '<img src=https://x.test/a.png>', src: '\thttps://x.test/f' }, childNodes: [] }] }] }] } },
  };
  const out = (offlineEvents([snapshot]) as typeof snapshot[])[0]!;
  const html = out.data.node.childNodes[0] as { childNodes: { tagName: string; childNodes: { tagName: string; attributes: Record<string, string> }[] }[] };
  expect(html.childNodes[0]!.childNodes[0]!.attributes).toEqual({ 'http-equiv': 'Content-Security-Policy', content: OFFLINE_POLICY });
  expect(html.childNodes[1]!.childNodes[0]!.attributes).toEqual({ src: 'about:blank' });
});

it('keeps quoted text outside image-set and makes a head when there is none', () => {
  // Page words stay as recorded; CSS loses every quoted address, also in an escaped image-set.
  const [, words] = offlineEvents([
    { type: 3, data: { source: 0, adds: [{ parentId: 1, node: { type: 3, id: 5, textContent: 'url(https://x.test) "https://x.test"' } }] } },
    { type: 3, data: { source: 0, texts: [{ id: 5, value: 'see "https://x.test" here' }] } },
  ]) as { data: { texts: { value: string }[] } }[];
  expect(words!.data.texts[0]!.value).toBe('see "https://x.test" here');
  expect(offlineCss('b{background:im\\61ge-set("https://x.test/a.png" 1x)}')).toBe('b{background:im\\61ge-set("" 1x)}');
  const started = Date.now();
  offlineCss('url("' + '\\'.repeat(50000) + 'x');
  offlineCss('image-set("' + '\\a'.repeat(50000));
  expect(Date.now() - started).toBeLessThan(500);
  const snapshot = { type: 2, data: { node: { type: 0, childNodes: [{ type: 2, tagName: 'html', childNodes: [{ type: 2, tagName: 'body', childNodes: [] }] }] } } };
  const out = (offlineEvents([snapshot]) as typeof snapshot[])[0]!;
  const html = out.data.node.childNodes[0] as unknown as { childNodes: { tagName: string; childNodes: { attributes: Record<string, string> }[] }[] };
  expect(html.childNodes[0]!.tagName).toBe('head');
  expect(html.childNodes[0]!.childNodes[0]!.attributes.content).toBe(OFFLINE_POLICY);
  const bare = { type: 2, data: { node: { type: 0, childNodes: [{ type: 2, tagName: 'body', childNodes: [] }] } } };
  const emptied = (offlineEvents([bare]) as typeof bare[])[0]!;
  expect(JSON.stringify(emptied)).not.toContain('body');
});
