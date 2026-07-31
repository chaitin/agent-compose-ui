import { randomBytes } from 'node:crypto';

export interface Fixture {
  batchId: string;
  projectName: string;
  image: string;
  agentImage: string;
  stdoutMarker: string;
  stderrMarker: string;
  llmMarker: string;
  scriptMarker: string;
  successCommand: string;
  failedCommand: string;
  streamCommand: string;
  stopCommand: string;
  scriptPath: string;
  scriptContent: string;
}

export interface FixtureLedger {
  batchId: string;
  projects: Set<string>;
  runs: Set<string>;
  sandboxes: Set<string>;
  scriptPaths: Set<string>;
  imageWasPresent: boolean;
  imagePulled: boolean;
}

function defaultBatchId(): string {
  const stamp = new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z').toLowerCase();
  return `e2e-${stamp}-${randomBytes(3).toString('hex')}`;
}

export function buildFixture(batchId = defaultBatchId()): Fixture {
  if (!/^e2e-[A-Za-z0-9_-]+$/.test(batchId)) throw new Error(`unsafe E2E batch ID: ${batchId}`);
  const stdoutMarker = `${batchId}-stdout`;
  const stderrMarker = `${batchId}-stderr`;
  const llmMarker = `${batchId}-llm-ok`;
  const scriptMarker = `${batchId}-script-ok`;
  return {
    batchId,
    projectName: batchId,
    image: 'busybox:1.36.1',
    agentImage: 'ghcr.io/chaitin/agent-compose-guest:latest',
    stdoutMarker,
    stderrMarker,
    llmMarker,
    scriptMarker,
    successCommand: `printf '${stdoutMarker}'`,
    failedCommand: `sh -c "printf '${stderrMarker}' >&2; exit 17"`,
    streamCommand: `sh -c "printf '${stdoutMarker}-1'; printf '${stderrMarker}' >&2; printf '${stdoutMarker}-2'"`,
    stopCommand: 'sh -c "sleep 120"',
    scriptPath: `${batchId}/main.js`,
    scriptContent: `console.log(${JSON.stringify(scriptMarker)});\n`,
  };
}

export function createLedger(batchId: string): FixtureLedger {
  return {
    batchId,
    projects: new Set(),
    runs: new Set(),
    sandboxes: new Set(),
    scriptPaths: new Set(),
    imageWasPresent: false,
    imagePulled: false,
  };
}

export function assertLedgerOwns<K extends 'projects' | 'runs' | 'sandboxes' | 'scriptPaths'>(ledger: FixtureLedger, kind: K, id: string): string {
  if (!ledger[kind].has(id) || !id.includes(ledger.batchId)) {
    throw new Error(`${kind} resource is not owned by ${ledger.batchId}: ${id}`);
  }
  return id;
}
