import { expect, it } from 'vitest';
import { sameView, type View } from './limited';

const view = (over: Partial<View> = {}): View => ({ windowId: 1, active: true, url: 'https://shop.test/cart', document: 'a', ...over });

it('keeps a shot of the same tab and page, also after a hash or pushState change', () => {
  expect(sameView(view(), view({ url: 'https://shop.test/cart#total' }))).toBe(true);
  expect(sameView(view(), view({ url: 'https://shop.test/checkout' }))).toBe(true);
});

it('drops a shot when the tab moved, went to the back or loaded another page', () => {
  expect(sameView(view(), view({ windowId: 2 }))).toBe(false);
  expect(sameView(view(), view({ active: false }))).toBe(false);
  expect(sameView(view(), view({ document: 'b' }))).toBe(false);
});

it('decides by the origin when the page gives no document mark', () => {
  expect(sameView(view({ document: null }), view({ document: null, url: 'https://shop.test/x' }))).toBe(true);
  expect(sameView(view({ document: null }), view({ document: null, url: 'https://login.test/' }))).toBe(false);
});
