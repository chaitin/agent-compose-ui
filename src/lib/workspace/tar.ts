// Self-implemented USTAR tar encoder, pure Uint8Array, no deps.
// Design doc §4.1: browser-side tar packing for multi-file/folder uploads.
// Backend (agent-compose/pkg/workspaces/file_workspace.go:294-347 ExtractWorkspaceTarArchive)
// rejects symlinks/hardlinks and requires relative paths - we never emit those entry types.

import type { TarEntryInput } from './types';

const HEADER_SIZE = 512;
const BLOCK_SIZE = 512;
const EOF_BLOCK = new Uint8Array(BLOCK_SIZE * 2);

export class TarEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarEncodeError';
  }
}

export function sanitizeTarPath(rawPath: string): string | null {
  let p = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = p.split('/');
  const cleaned: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    if (seg.includes('\0')) return null;
    cleaned.push(seg);
  }
  return cleaned.length > 0 ? cleaned.join('/') : null;
}

function encodeString(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function fillOctal(value: number, fieldLength: number): Uint8Array {
  // fieldLength includes the trailing NUL.
  const digits = value.toString(8).padStart(fieldLength - 1, '0');
  const buf = new Uint8Array(fieldLength);
  const digitBytes = encodeString(digits);
  buf.set(digitBytes, 0);
  buf[digitBytes.length] = 0; // NUL terminator
  return buf;
}

function buildHeader(entry: TarEntryInput): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE);
  const nameBytes = encodeString(entry.path);
  if (nameBytes.length > 100) {
    throw new TarEncodeError(`tar entry path too long (>100 bytes): ${entry.path}`);
  }
  header.set(nameBytes, 0); // name: 100 bytes
  header.set(fillOctal(0o644, 8), 100); // mode
  header.set(fillOctal(0, 8), 108); // uid
  header.set(fillOctal(0, 8), 116); // gid
  header.set(fillOctal(entry.file.size, 12), 124); // size
  header.set(fillOctal(entry.mtime ?? Math.floor(Date.now() / 1000), 12), 136); // mtime
  for (let i = 148; i < 156; i++) header[i] = 32; // chksum field as spaces during computation
  header[156] = 0x30; // typeflag '0' (regular file)
  header.set(encodeString('ustar\0'), 257); // magic
  header[263] = 0x30; // version '0'
  header[264] = 0x30; // version '0'

  let sum = 0;
  for (let i = 0; i < HEADER_SIZE; i++) sum += header[i];
  const chksumDigits = sum.toString(8).padStart(6, '0');
  const chksumBytes = encodeString(chksumDigits + '\0 ');
  header.set(chksumBytes, 148);
  return header;
}

function paddingFor(size: number): Uint8Array | null {
  const remainder = size % BLOCK_SIZE;
  if (remainder === 0) return null;
  return new Uint8Array(BLOCK_SIZE - remainder);
}

// Pack entries into a single tar Blob. File contents are passed as Blob parts
// to the Blob constructor, so the browser handles assembly without reading
// everything into JS memory upfront. The resulting Blob is sent via XHR +
// FormData, which is more reliable than fetch + duplex:'half' streaming.
export function packTarBlob(entries: TarEntryInput[]): Blob {
  const parts: BlobPart[] = [];
  for (const entry of entries) {
    const sanitized = sanitizeTarPath(entry.path);
    if (!sanitized) {
      throw new TarEncodeError(`invalid tar entry path: ${entry.path}`);
    }
    const header = buildHeader({ ...entry, path: sanitized });
    parts.push(header as unknown as BlobPart);
    parts.push(entry.file);
    const pad = paddingFor(entry.file.size);
    if (pad) parts.push(pad as unknown as BlobPart);
  }
  parts.push(EOF_BLOCK as unknown as BlobPart);
  return new Blob(parts, { type: 'application/x-tar' });
}
