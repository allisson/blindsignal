import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The SDK's public API (ADR 0046) and the README that documents it.
const sdk = resolve(import.meta.dirname, '../../../packages/sdk');
const entryPoints = ['src/index.ts', 'src/testing/fake-peer.ts'];

function exportedNames(source: string): string[] {
  // A star export would hide its names from this test.
  if (/^export \*/m.test(source)) throw new Error('export * is not listed');
  const lists = [...source.matchAll(/^export (?:type )?\{([^}]*)\}/gm)].flatMap(([, list]) =>
    list!.split(',').map((name) => name.replace(/^\s*type\s+/, '').trim()),
  );
  const declarations = [
    ...source.matchAll(/^export (?:abstract )?(?:class|function|const|type|interface) (\w+)/gm),
  ].map(([, name]) => name!);
  return [...lists, ...declarations].filter(Boolean);
}

// In a code span, so a name in prose ("Session" in a heading) does not count.
function undocumented(names: string[], readme: string): string[] {
  const spans = [...readme.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span!);
  return names.filter((name) =>
    spans.every((span) => !new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(span)),
  );
}

describe('the SDK README', () => {
  it('names every export of the SDK', () => {
    const names = entryPoints.flatMap((path) =>
      exportedNames(readFileSync(resolve(sdk, path), 'utf8')),
    );
    expect(names).toContain('BlindSignalClient');
    expect(names).toContain('FakeDataChannel');
    expect(undocumented(names, readFileSync(resolve(sdk, 'README.md'), 'utf8'))).toEqual([]);
  });

  it('reads named, type, and declared exports', () => {
    const source = [
      'export {',
      '  a,',
      '  type B,',
      "} from './a.ts';",
      'export type { C } from "./c.ts";',
      'export class D {}',
      'export interface E {}',
    ].join('\n');
    expect(exportedNames(source)).toEqual(['a', 'B', 'C', 'D', 'E']);
    expect(() => exportedNames("export * from './a.ts';")).toThrow();
  });

  it('counts a name only inside a code span, as a whole word', () => {
    expect(undocumented(['Session', 'Device'], '## Session\n`DeviceKey`')).toEqual([
      'Session',
      'Device',
    ]);
    expect(undocumented(['Session', 'Device'], 'a `Session`, `{ Device }`')).toEqual([]);
  });
});
