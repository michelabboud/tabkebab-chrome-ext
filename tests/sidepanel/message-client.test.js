import { expect, test } from 'bun:test';

import { sendOrThrow } from '../../sidepanel/message-client.js';
import { installChromeMock } from '../helpers/chrome-mock.js';

test('returns every valid successful response unchanged', async () => {
  const responses = [{ ok: true, tabs: [1, 2] }, false, 0, [], {}];

  for (const response of responses) {
    const calls = [];
    chrome.runtime.sendMessage = async (message) => {
      calls.push(message);
      return response;
    };
    const message = { type: 'getTabs' };

    await expect(sendOrThrow(message)).resolves.toBe(response);
    expect(calls).toEqual([message]);
  }
});

test('rejects an error-shaped response with the exact background message', async () => {
  installChromeMock({ runtimeHandler: () => ({ error: 'Close failed' }) });

  await expect(sendOrThrow({ type: 'closeTabs' })).rejects.toEqual(new Error('Close failed'));
});

test('preserves a native runtime rejection', async () => {
  const nativeError = new Error('extension context invalidated');
  installChromeMock({
    runtimeHandler: async () => {
      throw nativeError;
    },
  });

  await expect(sendOrThrow({ type: 'getSettings' })).rejects.toBe(nativeError);
});

test('accepts null as a valid response', async () => {
  installChromeMock({ runtimeHandler: () => null });

  await expect(sendOrThrow({ type: 'optionalResult' })).resolves.toBeNull();
});
