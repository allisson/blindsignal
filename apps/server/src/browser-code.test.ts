import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// What a browser receives from this repository: the examples serve these from source.
const root = resolve(import.meta.dirname, '../../..');
const browserDirectories = [
  'packages/sdk/src',
  'packages/protocol/src',
  'examples/browser-demo/public',
  'examples/minimal-app/public',
];

const secrets: [string, RegExp][] = [
  // A JWK's private or symmetric member, quoted or not.
  ['a private JWK member', /(?<![\w$])[dk]["']?\s*:\s*["'][A-Za-z0-9_-]{16,}/],
  ['a PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // A bundler inlines it at build time: a backend secret would ship with the page.
  ['process.env', /\bprocess\.env\b/],
];

function findSecrets(text: string): string[] {
  return secrets.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function browserFiles(): string[] {
  return browserDirectories.flatMap((directory) =>
    readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      // Tests too: the examples serve every file of these directories.
      .map((entry) => join(entry.parentPath, entry.name)),
  );
}

describe('code served to the browser', () => {
  it('holds no application secret or private key', () => {
    const files = browserFiles();
    for (const directory of browserDirectories) {
      expect(files.some((path) => path.startsWith(join(root, directory)))).toBe(true);
    }
    expect(files.some((path) => path.endsWith('.test.ts'))).toBe(true);
    const found = files.flatMap((path) =>
      findSecrets(readFileSync(path, 'utf8')).map((name) => `${relative(root, path)}: ${name}`),
    );
    expect(found).toEqual([]);
  });

  it.each([
    ["d: 'JjYmcEYsv1xfWV9t2o4AYZaB1v-2LyF-Xesy0xTj0eU'", 'a private JWK member'],
    ['{"kty":"oct","k":"GawgguFyGrWKav7AX4VKUg"}', 'a private JWK member'],
    ['const jwk = { ...key, \'d\': "JjYmcEYsv1xfWV9t2o4AYZaB" }', 'a private JWK member'],
    ['-----BEGIN EC PRIVATE KEY-----', 'a PEM private key'],
    ['-----BEGIN PRIVATE KEY-----', 'a PEM private key'],
    ['const key = process.env.SIGNING_KEY;', 'process.env'],
  ])('finds %s', (text, name) => {
    expect(findSecrets(text)).toEqual([name]);
  });

  it.each([
    "const id: 'device-1234567890abcdef' = x;",
    'const record = { id: "JjYmcEYsv1xfWV9t2o4AYZaB" };',
    "jwk: { kty: 'EC', x: 'JjYmcEYsv1xfWV9t2o4AYZaB' }",
    '-----BEGIN PUBLIC KEY-----',
    'const env = subprocess.env;',
    'const env = process.environ;',
  ])('ignores %s', (text) => {
    expect(findSecrets(text)).toEqual([]);
  });
});
