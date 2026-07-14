import { expect, test } from 'bun:test';

import { sendOrThrow } from '../../sidepanel/message-client.js';
import { installChromeMock } from '../helpers/chrome-mock.js';

test('returns a successful response unchanged', async () => {
  const response = { ok: true, tabs: [1, 2] };
  const harness = installChromeMock({ runtimeHandler: () => response });
  const message = { type: 'getTabs' };

  await expect(sendOrThrow(message)).resolves.toEqual(response);
  expect(harness.calls.runtime.sendMessage).toEqual([[message]]);
});

test('rejects an error-shaped response', async () => {
  installChromeMock({ runtimeHandler: () => ({ error: 'restore failed' }) });

  await expect(sendOrThrow({ type: 'restoreStash' })).rejects.toThrow('restore failed');
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
