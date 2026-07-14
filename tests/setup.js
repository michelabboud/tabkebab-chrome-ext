import { afterEach, beforeEach } from 'bun:test';

import { installChromeMock, resetChromeMock } from './helpers/chrome-mock.js';

beforeEach(() => installChromeMock());
afterEach(() => resetChromeMock());
