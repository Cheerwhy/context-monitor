/**
 * Context Monitor sidecar server for Antigravity Auxiliary Pane.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const READER_PATH = join(__dirname, 'transcript_reader.mjs');
const READER_URL = pathToFileURL(READER_PATH).href;
let cachedReader = { mtimeMs: -1, mod: null };

async function getReader() {
  const { mtimeMs } = statSync(READER_PATH);
  if (cachedReader.mod && cachedReader.mtimeMs === mtimeMs) {
    return cachedReader.mod;
  }
  const mod = await import(`${READER_URL}?v=${mtimeMs}`);
  cachedReader = { mtimeMs, mod };
  return mod;
}
const STATIC = {
  '/styles.css': ['styles.css', 'text/css'],
  '/app.js': ['app.js', 'application/javascript'],
};

function renderPageHtml() {
  const html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
  const css = readFileSync(join(__dirname, 'styles.css'), 'utf-8');
  const js = readFileSync(join(__dirname, 'app.js'), 'utf-8');
  return html
    .replace('<link rel="stylesheet" href="/styles.css">', () => `<style>\n${css}\n</style>`)
    .replace('<script src="/app.js"></script>', () => `<script>\n${js}\n</script>`);
}

const app = new SidecarApp();

app.page('/', () => {
  console.log('[context_monitor] GET /');
  return renderPageHtml();
});

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }),
    'GET',
  );
}

app.api(
  '/api/context',
  async (data) => {
    const { readContextSnapshot } = await getReader();
    const conv = data?.conversationId || app.config.conversationId || '';
    const etag = typeof data?.etag === 'string' ? data.etag : '';
    const allowFallback = data?.fallback === '1' || data?.fallback === 'true';
    const payload = readContextSnapshot(conv, etag, { allowFallback });
    return new Response(JSON.stringify(payload), {
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
    });
  },
  'GET',
);

const shutdown = () => {
  app.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.run();
