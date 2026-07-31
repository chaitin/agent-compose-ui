import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ServiceError } from './errors.mjs';
import { createStorage } from './storage.mjs';
import { createMetadataStore } from './metadata.mjs';

const PREFIX = '/script-api/v1';

function tokenMatches(actual, expected) {
  const left = Buffer.from(String(actual ?? ''));
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Tokens the script-service refuses at startup. The leaked value below was
// previously shipped in docker/.env.example; keep rejecting it so no
// deployment that copied it verbatim keeps running with a publicly-known token.
const WEAK_TOKENS = new Set([
  'replace-me',
  'changeme',
  'change-me',
  'password',
  'secret',
  'token',
  'your-token',
  'your-token-here',
  'please-run-openssl-rand-hex-32',
  'cf3675f0466c32d703281eba8656d24d4458b5f2fb824c51e8b3fd14b34cd0fd',
]);

// Deployment-time token strength policy, enforced by server.mjs at startup.
// createScriptService() below only requires *a* non-empty token (so tests can
// pass short fixtures); the entry point applies this stronger check.
export function assertUsableToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('SCRIPT_SERVICE_TOKEN is required');
  }
  if (token.length < 16) {
    throw new Error('SCRIPT_SERVICE_TOKEN is too short; generate one with `openssl rand -hex 32`');
  }
  if (WEAK_TOKENS.has(token.toLowerCase())) {
    throw new Error('SCRIPT_SERVICE_TOKEN is a known placeholder; generate a fresh one with `openssl rand -hex 32`');
  }
}

async function readJsonBody(req, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (tooLarge) continue;
    if (size > maxBodyBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw new ServiceError(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError(400, 'INVALID_PATH', '请求体不是合法 JSON');
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res, error) {
  if (error instanceof ServiceError) {
    if (error.status >= 500) console.error(`[script-service] ${error.code}:`, error.message);
    sendJson(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  console.error(`[script-service] INTERNAL_ERROR:`, error?.stack ?? error);
  sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: '内部错误' } });
}

function pathSegments(pathname) {
  return pathname.split('/').filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new ServiceError(400, 'INVALID_PATH', '路径编码无效');
    }
  });
}

async function handleRequest({ storage, metadata, token, maxBodyBytes, req, res }) {
  if (!tokenMatches(req.headers['x-script-service-token'], token)) {
    throw new ServiceError(401, 'UNAUTHORIZED', '未授权');
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  if (!url.pathname.startsWith(PREFIX)) throw new ServiceError(404, 'NOT_FOUND', '路径不存在');
  const segments = pathSegments(url.pathname.slice(PREFIX.length));
  const query = url.searchParams;
  const method = req.method;
  const [a, b, c] = segments;

  if (a === 'health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, version: '1' });
  }

  if (a === 'tree' && method === 'GET') {
    return sendJson(res, 200, await storage.listTree());
  }

  if (a === 'files') {
    if (method === 'GET') {
      const filePath = query.get('path');
      if (!filePath) throw new ServiceError(400, 'INVALID_PATH', '缺少 path 参数');
      return sendJson(res, 200, await storage.readFile(filePath));
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req, maxBodyBytes);
      return sendJson(res, 200, await storage.writeFile(body));
    }
    if (method === 'DELETE') {
      const filePath = query.get('path');
      if (!filePath) throw new ServiceError(400, 'INVALID_PATH', '缺少 path 参数');
      const expectedSha256 = query.get('expectedSha256') || undefined;
      return sendJson(res, 200, await storage.deleteFile(filePath, expectedSha256));
    }
  }

  if (a === 'folders') {
    if (method === 'POST') {
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body?.path) throw new ServiceError(400, 'INVALID_PATH', '缺少 path');
      return sendJson(res, 201, await storage.createFolder(body.path));
    }
    if (method === 'DELETE') {
      const folderPath = query.get('path');
      if (!folderPath) throw new ServiceError(400, 'INVALID_PATH', '缺少 path 参数');
      const recursive = query.get('recursive') === 'true';
      return sendJson(res, 200, await storage.deleteFolder(folderPath, recursive));
    }
  }

  if (a === 'projects' && b) {
    const projectId = b;
    if (!c && method === 'PUT') {
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body?.projectName) throw new ServiceError(400, 'INVALID_PATH', '缺少 projectName');
      return sendJson(res, 200, await metadata.ensureProject({ projectId, projectName: body.projectName }));
    }
    if (!c && method === 'DELETE') {
      return sendJson(res, 200, await metadata.deleteProject(projectId));
    }
    if (c === 'manifest') {
      if (method === 'GET') {
        return sendJson(res, 200, await metadata.readManifest(projectId));
      }
      if (method === 'PUT') {
        const body = await readJsonBody(req, maxBodyBytes);
        await metadata.writeManifest(projectId, body);
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        await metadata.deleteManifest(projectId);
        return sendJson(res, 200, { ok: true });
      }
    }
  }

  throw new ServiceError(404, 'NOT_FOUND', '路径不存在');
}

export async function createScriptService({ root, token, maxBodyBytes, maxFileBytes }) {
  if (!token) throw new Error('createScriptService: token is required');
  const storage = createStorage(root, { maxFileBytes });
  const metadata = await createMetadataStore(root);

  const server = createServer(async (req, res) => {
    try {
      await handleRequest({ storage, metadata, token, maxBodyBytes, req, res });
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, error);
    }
  });

  return server;
}
