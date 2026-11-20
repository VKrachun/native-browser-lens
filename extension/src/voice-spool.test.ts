import { expect, it } from 'vitest';
import { spoolKey } from './voice-spool';

it('keeps the voice of each recording apart, also in one tab', () => {
  expect(spoolKey(7, 1000)).not.toBe(spoolKey(7, 2000));
  expect(spoolKey(7, 1000)).not.toBe(spoolKey(8, 1000));
});
