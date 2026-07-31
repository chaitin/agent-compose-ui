export interface DotenvEntry { name: string; value: string; }

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unquote(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote) return value;
  const inner = value.slice(1, -1);
  if (quote === "'") return inner;
  return inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

export function parseDotenv(text: string): DotenvEntry[] {
  const entries: DotenvEntry[] = [];
  const seen = new Set<string>();
  for (const [index, source] of text.replace(/\r\n/g, '\n').split('\n').entries()) {
    let line = source.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const equals = line.indexOf('=');
    if (equals < 1) throw new Error(`第 ${index + 1} 行格式错误，应为 KEY=VALUE`);
    const name = line.slice(0, equals).trim();
    if (!NAME.test(name)) throw new Error(`第 ${index + 1} 行变量名不合法：${name || '（空）'}`);
    if (seen.has(name)) throw new Error(`第 ${index + 1} 行变量重复：${name}`);
    seen.add(name);
    entries.push({ name, value: unquote(line.slice(equals + 1).trim()) });
  }
  if (!entries.length) throw new Error('请至少粘贴一个环境变量');
  return entries;
}

function quote(value: string): string {
  if (!/[\s#"'\\\r\n]/.test(value)) return value;
  return JSON.stringify(value);
}

export function formatDotenv(entries: DotenvEntry[]): string {
  return entries.map((entry) => `${entry.name}=${quote(entry.value)}`).join('\n');
}
