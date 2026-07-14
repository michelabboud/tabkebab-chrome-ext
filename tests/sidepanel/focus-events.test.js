import { describe, expect, test } from 'bun:test';

import {
  createFocusRunCommand,
  focusMessageMatchesState,
  handleFocusPanelMessage,
  routePanelFocusMessage,
} from '../../sidepanel/focus-events.js';

function createFocusPanel() {
  return {
    state: { status: 'active', runId: 'run-b' },
    _flashDistraction() {},
    _showReport() {},
    handleFocusMessage(message) {
      return handleFocusPanelMessage(message, this);
    },
  };
}

describe('Focus runtime event identity', () => {
  test('panel lifecycle commands carry the displayed run ID', () => {
    const state = { status: 'active', runId: 'run-a' };

    expect(createFocusRunCommand('pauseFocus', state)).toEqual({
      action: 'pauseFocus',
      expectedRunId: 'run-a',
    });
    expect(createFocusRunCommand('resumeFocus', state)).toEqual({
      action: 'resumeFocus',
      expectedRunId: 'run-a',
    });
    expect(createFocusRunCommand('extendFocus', state, { minutes: 5 })).toEqual({
      action: 'extendFocus',
      minutes: 5,
      expectedRunId: 'run-a',
    });
    expect(createFocusRunCommand('endFocus', state)).toEqual({
      action: 'endFocus',
      expectedRunId: 'run-a',
    });
  });

  test('the shared predicate requires an exact non-empty current run ID', () => {
    expect(focusMessageMatchesState(
      { type: 'focusDistraction', runId: 'run-b' },
      { status: 'active', runId: 'run-b' },
    )).toBeTrue();
    expect(focusMessageMatchesState(
      { type: 'focusEnded', runId: 'run-a' },
      { status: 'active', runId: 'run-b' },
    )).toBeFalse();
    expect(focusMessageMatchesState(
      { type: 'focusEnded' },
      { status: 'active', runId: 'run-b' },
    )).toBeFalse();
    expect(focusMessageMatchesState(
      { type: 'focusEnded', runId: 'run-b' },
      null,
    )).toBeFalse();
    expect(focusMessageMatchesState(
      { type: 'focusDistraction', runId: 'run-b' },
      { status: 'paused', runId: 'run-b' },
    )).toBeFalse();
    expect(focusMessageMatchesState(
      { type: 'focusDistraction', runId: 'run-b' },
      { status: 'ending', runId: 'run-b' },
    )).toBeFalse();
  });

  test('the component handler ignores stale events and handles matching events', () => {
    const panel = createFocusPanel();
    const distractions = [];
    const reports = [];
    panel._flashDistraction = (...args) => distractions.push(args);
    panel._showReport = (record) => reports.push(record);

    handleFocusPanelMessage({
      type: 'focusDistraction',
      runId: 'run-a',
      domain: 'stale.test',
      count: 1,
    }, panel);
    handleFocusPanelMessage({
      type: 'focusEnded',
      runId: 'run-a',
      record: { runId: 'run-a' },
    }, panel);

    expect(distractions).toEqual([]);
    expect(reports).toEqual([]);
    expect(panel.state.runId).toBe('run-b');

    handleFocusPanelMessage({
      type: 'focusDistraction',
      runId: 'run-b',
      domain: 'blocked.test',
      count: 2,
    }, panel);
    expect(distractions).toEqual([['blocked.test', 2]]);

    const record = { runId: 'run-b' };
    handleFocusPanelMessage({
      type: 'focusEnded',
      runId: 'run-b',
      record,
    }, panel);
    expect(panel.state).toBeNull();
    expect(reports).toEqual([record]);
  });

  test('the global panel route ignores stale view, blink, and button effects', async () => {
    const panel = createFocusPanel();
    const calls = [];
    panel.handleFocusMessage = (message) => calls.push(['component', message.type]);
    const handlers = {
      updateFocusBtnState: () => calls.push(['button']),
      showFocusView: () => calls.push(['view']),
      blink: () => calls.push(['blink']),
    };

    expect(await routePanelFocusMessage({
      type: 'focusDistraction',
      runId: 'run-a',
      openFocusView: true,
      blink: true,
    }, panel, handlers)).toBeFalse();
    expect(await routePanelFocusMessage({
      type: 'focusEnded',
      runId: 'run-a',
    }, panel, handlers)).toBeFalse();
    expect(calls).toEqual([]);

    expect(await routePanelFocusMessage({
      type: 'focusDistraction',
      runId: 'run-b',
      openFocusView: true,
      blink: true,
    }, panel, handlers)).toBeTrue();
    expect(calls).toEqual([
      ['component', 'focusDistraction'],
      ['button'],
      ['view'],
      ['blink'],
    ]);
  });

  test('the global route hydrates a cold panel before accepting the current run', async () => {
    const panel = createFocusPanel();
    panel.state = null;
    const calls = [];
    panel.handleFocusMessage = (message) => calls.push(['component', message.runId]);

    const handled = await routePanelFocusMessage({
      type: 'focusDistraction',
      runId: 'run-b',
      openFocusView: true,
      blink: true,
    }, panel, {
      loadFocusState: async () => {
        calls.push(['hydrate']);
        return { status: 'active', runId: 'run-b' };
      },
      updateFocusBtnState: () => calls.push(['button']),
      showFocusView: () => calls.push(['view']),
      blink: () => calls.push(['blink']),
    });

    expect(handled).toBeTrue();
    expect(panel.state).toEqual({ status: 'active', runId: 'run-b' });
    expect(calls).toEqual([
      ['hydrate'],
      ['component', 'run-b'],
      ['button'],
      ['view'],
      ['blink'],
    ]);
  });

  test('durable replacement authority rejects a locally matching stale event', async () => {
    const panel = createFocusPanel();
    panel.state = { status: 'active', runId: 'run-a' };
    const calls = [];
    panel.handleFocusMessage = (message) => calls.push(['component', message.type]);
    const handlers = {
      loadFocusState: async () => ({ status: 'active', runId: 'run-b' }),
      updateFocusBtnState: () => calls.push(['button']),
      showFocusView: () => calls.push(['view']),
      blink: () => calls.push(['blink']),
    };

    expect(await routePanelFocusMessage({
      type: 'focusDistraction',
      runId: 'run-a',
      openFocusView: true,
      blink: true,
    }, panel, handlers)).toBeFalse();
    expect(panel.state).toEqual({ status: 'active', runId: 'run-b' });
    expect(calls).toEqual([]);

    panel.state = { status: 'active', runId: 'run-a' };
    expect(await routePanelFocusMessage({
      type: 'focusEnded',
      runId: 'run-a',
    }, panel, handlers)).toBeFalse();
    expect(panel.state).toEqual({ status: 'active', runId: 'run-b' });
    expect(calls).toEqual([]);
  });

  test('focusEnded accepts the displayed run only when durable authority is absent', async () => {
    const panel = createFocusPanel();
    panel.state = { status: 'active', runId: 'run-a' };
    const calls = [];
    panel.handleFocusMessage = (message) => {
      calls.push(['component', message.type]);
      panel.state = null;
    };

    expect(await routePanelFocusMessage({
      type: 'focusEnded',
      runId: 'run-a',
    }, panel, {
      loadFocusState: async () => null,
      updateFocusBtnState: () => calls.push(['button']),
    })).toBeTrue();
    expect(panel.state).toBeNull();
    expect(calls).toEqual([
      ['component', 'focusEnded'],
      ['button'],
    ]);
  });
});
