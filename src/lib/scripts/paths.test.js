import { describe, expect, test } from 'bun:test';
import { decodePointer, encodePointer, parseScriptRef, toScriptRef } from './paths';

describe('script refs', () => {
  test('parses and formats explicit project paths', () => {
    expect(parseScriptRef('$ref:data-pipeline/scripts/a.js')).toBe('data-pipeline/scripts/a.js');
    expect(toScriptRef('shared-tools/a.js')).toBe('$ref:shared-tools/a.js');
  });

  test.each(['$ref:../a.js', '$ref:/a.js', '$ref:a.txt', 'prefix:$ref:a.js', '$ref:demo/.metadata/x.js', '$ref:demo\\a.js'])(
    'rejects %s',
    (value) => {
      expect(parseScriptRef(value)).toBeNull();
    },
  );

  test('rejects non-string values', () => {
    expect(parseScriptRef(null)).toBeNull();
    expect(parseScriptRef(undefined)).toBeNull();
    expect(parseScriptRef(123)).toBeNull();
  });

  test('escapes agent names in JSON pointers', () => {
    const pointer = encodePointer(['agents', 'a/b~c', 'scheduler', 'script']);
    expect(pointer).toBe('/agents/a~1b~0c/scheduler/script');
    expect(decodePointer(pointer)).toEqual(['agents', 'a/b~c', 'scheduler', 'script']);
  });
});
