import { describe, expect, test } from 'vitest';
import { formatDotenv, parseDotenv } from './dotenv-bulk';

describe('dotenv bulk format', () => {
  test('parses standard assignments, export, comments, quotes and equals in values', () => {
    expect(parseDotenv('# comment\nA=one\nexport TOKEN="abc=123"\nEMPTY=')).toEqual([
      { name: 'A', value: 'one' }, { name: 'TOKEN', value: 'abc=123' }, { name: 'EMPTY', value: '' },
    ]);
  });

  test('rejects invalid and duplicate names', () => {
    expect(() => parseDotenv('BAD-NAME=x')).toThrow(/变量名不合法/);
    expect(() => parseDotenv('A=1\nA=2')).toThrow(/变量重复/);
  });

  test('formats values as reusable dotenv text', () => {
    expect(formatDotenv([{ name: 'A', value: 'one' }, { name: 'B', value: 'hello world' }])).toBe('A=one\nB="hello world"');
  });
});
