import { describe, expect, it } from 'vitest';
import { stepsOf } from './steps';
import type { Action } from './protocol/Action';

const page = 'https://app.test/assets';
const action = (kind: Action['kind'], extra: Partial<Action> = {}): Action => ({
  timestamp: 1,
  kind,
  url: page,
  target: null,
  value: null,
  masked: false,
  ...extra,
});

describe('stepsOf', () => {
  it('names failures by request, drops browser cancels, and keeps names short', () => {
    const steps = stepsOf(
      [
        action('click', {
          target: { testId: null, role: null, name: null, nth: null, css: 'div', text: 'New Ctrl+K Upload Sirv account Filter Layout Sort View' },
        }),
        action('navigate', { timestamp: 2, url: 'https://app.test/assets/library?x=1' }),
      ],
      [
        { timestamp: 3, kind: 'request', data: { requestId: 'a', url: 'https://app.test/api/assets', method: 'POST' } },
        { timestamp: 4, kind: 'networkFailure', data: { requestId: 'a', errorText: 'NS_ERROR_DOM_NETWORK_ERR' } },
        { timestamp: 5, kind: 'request', data: { requestId: 'b', url: 'https://app.test/api/x', method: 'GET' } },
        { timestamp: 6, kind: 'networkFailure', data: { requestId: 'b', errorText: 'NS_BINDING_ABORTED' } },
        { timestamp: 7, kind: 'response', data: { requestId: 'c', url: 'https://cdn.other/p.png', status: 404 } },
      ],
      page,
    );
    expect(steps.map((s) => s.text)).toEqual([
      'Click “New Ctrl+K Upload Sirv account Filter…”',
      'Go to /assets/library?x=1',
      'Request failed · POST /api/assets',
      'HTTP 404 · cdn.other/p.png',
    ]);
  });
});
