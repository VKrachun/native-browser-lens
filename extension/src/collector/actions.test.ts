import { describe, expect, it } from 'vitest';
import { blocked, cleanName, fileType, privateValue, setMaskSelectors, type FieldFacts } from './actions';

const field = (facts: Partial<FieldFacts>): FieldFacts => ({
  type: 'text',
  autocomplete: '',
  name: '',
  id: '',
  label: '',
  placeholder: '',
  ...facts,
});

describe('privateValue', () => {
  it('reads every autocomplete token and the accessible name', () => {
    expect(privateValue(field({ autocomplete: 'section-pay billing cc-csc' }), '000')).toBe(true);
    expect(privateValue(field({ label: 'CVV' }), '000')).toBe(true);
  });

  it('keeps ordinary values', () => {
    expect(privateValue(field({ name: 'coupon', label: 'Coupon' }), 'SAVE10')).toBe(false);
    expect(privateValue(field({ label: 'Search' }), 'red shoes')).toBe(false);
    expect(privateValue(field({ label: 'Quantity' }), '12')).toBe(false);
  });

  it('masks private fields by type, autocomplete and name', () => {
    expect(privateValue(field({ type: 'password' }), 'hunter2')).toBe(true);
    expect(privateValue(field({ autocomplete: 'cc-number' }), '1')).toBe(true);
    expect(privateValue(field({ autocomplete: 'one-time-code' }), '1')).toBe(true);
    expect(privateValue(field({ name: 'card' }), 'x')).toBe(true);
    expect(privateValue(field({ label: 'CVC' }), '123')).toBe(true);
    expect(privateValue(field({ label: 'API key' }), 'abc')).toBe(true);
    expect(privateValue(field({ placeholder: 'IBAN' }), 'x')).toBe(true);
  });

  it('masks values that look like numbers or secrets anywhere', () => {
    expect(privateValue(field({ label: 'Notes' }), '4111 1111 1111 1111')).toBe(true);
    expect(privateValue(field({ label: 'Notes' }), 'Bearer abc.def')).toBe(true);
    expect(privateValue(field({ label: 'Notes' }), 'eyJhbGciOi.eyJzdWIi.c2lnbmF0dXJl')).toBe(true);
  });
});

it('setMaskSelectors adds the valid selectors to [data-lens-block]', () => {
  const probe = { querySelector: (selector: string) => (selector.includes('((') ? (() => { throw new SyntaxError(selector); })() : null) };
  expect(setMaskSelectors(['.salary', 'div((', '#ssn'], probe)).toEqual(['.salary', '#ssn']);
  const seen: string[] = [];
  const el = { closest: (selector: string) => (seen.push(selector), null) };
  expect(blocked(el)).toBe(false);
  expect(seen).toEqual(['[data-lens-block], .salary, #ssn']);
  setMaskSelectors([], probe);
});

it('fileType names an extension only when the file has one', () => {
  expect(['photo.JPG', 'a.tar.gz', 'id_rsa', '.bashrc', 'name.'].map(fileType)).toEqual(['jpg', 'gz', '?', '?', '?']);
});

describe('cleanName', () => {
  it('collapses whitespace and refuses what cannot match exactly', () => {
    expect(cleanName('  Pay \n now ')).toBe('Pay now');
    expect(cleanName('')).toBeNull();
    expect(cleanName('x'.repeat(81))).toBeNull();
    expect(cleanName('token=abc123')).toBeNull();
  });
});
