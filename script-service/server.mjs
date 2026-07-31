import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScriptService, assertUsableToken } from './app.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.SCRIPT_DATA_DIR || path.join(webRoot, 'data', 'scripts'));
const token = process.env.SCRIPT_SERVICE_TOKEN;
assertUsableToken(token);
await mkdir(root, { recursive: true, mode: 0o700 });
const server = await createScriptService({
  root,
  token,
  maxBodyBytes: 2 * 1024 * 1024 + 64 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
});
const port = Number(process.env.SCRIPT_SERVICE_PORT || 7420);
const host = process.env.SCRIPT_SERVICE_HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`script service listening on ${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
