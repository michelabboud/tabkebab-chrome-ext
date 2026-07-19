// Manual Task 13 fixture: a loopback-only OpenAI-compatible endpoint whose
// completion request settles only after the client connection is aborted.

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const COMPLETION_PATH = '/v1/chat/completions';
const METRICS_PATH = '/metrics';

const corsHeaders = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
});

const metrics = {
  requestStarts: 0,
  connectionAborts: 0,
  completedRequests: 0,
  activeRequests: 0,
  maxActiveRequests: 0,
};

const pendingRequests = new Set();

function jsonResponse(value, status = 200) {
  return Response.json(value, { status, headers: corsHeaders });
}

function readPort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('TABKEBAB_HANG_PORT must be an integer from 0 through 65535');
  }
  return port;
}

function holdUntilConnectionAbort(request) {
  metrics.requestStarts += 1;
  metrics.activeRequests += 1;
  metrics.maxActiveRequests = Math.max(
    metrics.maxActiveRequests,
    metrics.activeRequests,
  );

  return new Promise((resolve) => {
    let settled = false;
    const finish = ({ aborted, status }) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener('abort', onAbort);
      pendingRequests.delete(cancel);
      metrics.activeRequests -= 1;
      if (aborted) metrics.connectionAborts += 1;
      else metrics.completedRequests += 1;
      resolve(new Response(null, { status, headers: corsHeaders }));
    };
    const onAbort = () => finish({ aborted: true, status: 499 });
    const cancel = () => finish({ aborted: false, status: 503 });

    pendingRequests.add(cancel);
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener('abort', onAbort, { once: true });
  });
}

const server = Bun.serve({
  hostname: DEFAULT_HOST,
  port: readPort(process.env.TABKEBAB_HANG_PORT),
  idleTimeout: 255,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method === 'GET' && url.pathname === METRICS_PATH) {
      return jsonResponse({ ...metrics });
    }
    if (request.method === 'POST' && url.pathname === COMPLETION_PATH) {
      return holdUntilConnectionAbort(request);
    }
    return jsonResponse({ error: 'Not found' }, 404);
  },
});

async function shutdown() {
  for (const cancel of [...pendingRequests]) cancel();
  await server.stop(true);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

console.log(JSON.stringify({
  ready: true,
  baseUrl: `http://${DEFAULT_HOST}:${server.port}/v1`,
  metricsUrl: `http://${DEFAULT_HOST}:${server.port}${METRICS_PATH}`,
}));
