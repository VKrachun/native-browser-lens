import { describe, expect, it } from 'vitest';
import { bodyEvidence, REDACTED, requestBody, sanitize, sanitizeText, sanitizeUrl } from './sanitize';

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';

describe('sanitizeUrl', () => {
  it('removes credentials, fragments and secret query values', () => {
    const clean = sanitizeUrl(`https://user:pass@shop.test/cart?access_token=abc&page=2&X-Amz-Signature=f00#t=${jwt}`);
    expect(clean).not.toMatch(/user|pass@|abc|f00|eyJ/);
    expect(clean).toContain('page=2');
  });

  it('catches tokens by their shape in any value and in the path', () => {
    expect(sanitizeUrl(`https://shop.test/reset/${jwt}?next=${jwt}`)).not.toContain('eyJ');
    expect(sanitizeUrl('https://api.test/v1?q=sk-abcdefghijklmnopqrstu')).not.toContain('sk-abcdef');
  });

  it('caps the length', () => {
    expect(sanitizeUrl(`https://shop.test/?q=${'a'.repeat(40_000)}`).length).toBeLessThanOrEqual(16 * 1024);
  });
});

describe('sanitize', () => {
  it('redacts by key, by header name and by content', () => {
    const clean = sanitize({
      password: 'hunter2',
      headers: [{ name: 'Authorization', value: 'Bearer abc.def' }, { name: 'Accept', value: 'text/html' }],
      note: `token=xyz ${jwt}`,
    });
    const text = JSON.stringify(clean);
    expect(text).not.toMatch(/hunter2|abc\.def|xyz|eyJ/);
    expect(text).toContain('text/html');
  });

  it('keeps ordinary text', () => {
    expect(sanitizeText('total is NaN')).toBe('total is NaN');
  });
});

describe('bodyEvidence', () => {
  it('keeps same-origin JSON bodies without their secrets', () => {
    const evidence = bodyEvidence('{"error":"NaN","token":"s3cret"}', 'application/json', 'https://a.test/api', 'https://a.test/');
    expect(evidence).toEqual({ format: 'json', body: { error: 'NaN', token: REDACTED } });
  });

  it('leaves out other origins and binary bodies', () => {
    expect(bodyEvidence('{}', 'application/json', 'https://cdn.test/x', 'https://a.test/')).toHaveProperty('omission');
    expect(bodyEvidence('xx', 'image/png', 'https://a.test/x', 'https://a.test/')).toHaveProperty('omission');
  });
});

describe('private values', () => {
  it('redacts card numbers in text and numbers, but not timestamps', () => {
    expect(sanitizeText('paid with 4111 1111 1111 1111 today')).toBe(`paid with ${REDACTED} today`);
    expect(sanitize({ n: 4111111111111111 })).toEqual({ n: REDACTED });
    expect(sanitizeText('at 1763120400123')).toBe('at 1763120400123');
  });

  it('redacts payment and identity fields by name', () => {
    expect(sanitize({ cardNumber: 'x', cvc: '123', iban: 'y', coupon: 'SAVE10' })).toEqual({
      cardNumber: REDACTED,
      cvc: REDACTED,
      iban: REDACTED,
      coupon: 'SAVE10',
    });
  });
});

describe('requestBody', () => {
  const page = 'https://a.test/checkout';
  it('keeps same-origin JSON and form bodies without private fields', () => {
    expect(requestBody('{"coupon":"SAVE10","card":"4111111111111111"}', 'application/json', 'https://a.test/api', page)).toBe(
      `{"coupon":"SAVE10","card":"${REDACTED}"}`,
    );
    expect(requestBody('coupon=SAVE10&cvv=123', 'application/x-www-form-urlencoded', 'https://a.test/api', page)).toBe(
      `coupon=SAVE10&cvv=${encodeURIComponent(REDACTED)}`,
    );
  });

  it('leaves out other origins, binary bodies and large bodies', () => {
    expect(requestBody('{}', 'application/json', 'https://pay.test/api', page)).toBeUndefined();
    expect(requestBody('xx', 'application/octet-stream', 'https://a.test/api', page)).toBeUndefined();
    expect(requestBody('x'.repeat(20_000), 'text/plain', 'https://a.test/api', page)).toBeUndefined();
  });
});

describe('second bug hunt', () => {
  const page = 'https://a.test/checkout';
  it('redacts a whole cookie line and quoted secrets with spaces', () => {
    expect(sanitizeText('Cookie: theme=light; sid=DEMO')).not.toContain('DEMO');
    expect(sanitizeText('{"password":"two words"}')).not.toContain('words');
    expect(sanitizeText("password = 'two words'")).not.toContain('words');
  });
  it('redacts OAuth exchanges in form bodies and payment words in queries', () => {
    const body = requestBody('code=DEMO_A&code_verifier=DEMO_B&grant_type=authorization_code', 'application/x-www-form-urlencoded', 'https://a.test/token', page);
    expect(body).not.toMatch(/DEMO_[AB]/);
    expect(body).toContain('grant_type=authorization_code');
    expect(sanitizeUrl('https://a.test/pay?cvv=123&step=2')).not.toContain('123');
  });
});
