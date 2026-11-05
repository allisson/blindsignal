import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The tarballs `pnpm publish` uploads (ADR 0050), installed where no workspace link resolves them.
const packages = resolve(import.meta.dirname, '../../../packages');
const names = ['protocol', 'sdk'] as const;
let root: string;
const contents: Record<string, string[]> = {};
const manifests: Record<string, Record<string, unknown>> = {};

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'blindsignal-pack-'));
  for (const name of names) {
    const tarball = run(
      'pnpm',
      ['pack', '--pack-destination', root, '--json'],
      join(packages, name),
    );
    const file = (JSON.parse(tarball) as { filename: string }).filename;
    contents[name] = run('tar', ['-tzf', file], root)
      .split('\n')
      .filter(Boolean)
      .map((path) => path.replace(/^package\//, ''))
      .sort();
    const target = join(root, 'node_modules/@blindsignal', name);
    mkdirSync(target, { recursive: true });
    run('tar', ['-xzf', file, '-C', target, '--strip-components=1'], root);
    manifests[name] = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  }
  // The protocol's one dependency, from this workspace.
  const zod = dirname(
    createRequire(join(packages, 'protocol/package.json')).resolve('zod/package.json'),
  );
  symlinkSync(zod, join(root, 'node_modules/zod'));
}, 120_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the published packages', () => {
  it('ship the build, its types, the README, and the license, and no sources or tests', () => {
    for (const name of names) {
      const files = contents[name]!;
      expect(files).toContain('LICENSE');
      expect(files).toContain('package.json');
      expect(files).toContain('dist/index.js');
      expect(files).toContain('dist/index.d.ts');
      expect(
        files.filter(
          (file) => !/^(dist\/.+\.(js|d\.ts)|LICENSE|package\.json|README\.md)$/.test(file),
        ),
      ).toEqual([]);
      expect(files.filter((file) => /\.test\.|fake-socket/.test(file))).toEqual([]);
    }
    expect(contents.sdk).toContain('README.md');
    expect(contents.sdk).toContain('dist/testing/fake-peer.d.ts');
  });

  it('point their exports at the build and pin the protocol to its release', () => {
    expect(manifests.sdk!.exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './testing': {
        types: './dist/testing/fake-peer.d.ts',
        default: './dist/testing/fake-peer.js',
      },
    });
    expect(manifests.protocol!.exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    });
    expect(manifests.sdk!.dependencies).toEqual({
      '@blindsignal/protocol': manifests.protocol!.version,
    });
  });

  it('keep members tagged @internal out of the types', () => {
    const session = readFileSync(
      join(root, 'node_modules/@blindsignal/sdk/dist/session.d.ts'),
      'utf8',
    );
    expect(session).toContain('class Session');
    expect(session).not.toMatch(/\bactivate\(/);
  });

  // Two tsc runs and a node process: seconds on a CI runner.
  it('type-check and load in an application outside the workspace', { timeout: 60_000 }, () => {
    writeFileSync(
      join(root, 'app.ts'),
      [
        "import { BlindSignalClient, BlindSignalError, errorClasses } from '@blindsignal/sdk';",
        "import { FakePeerConnection } from '@blindsignal/sdk/testing';",
        'export const used: unknown[] = [BlindSignalClient, BlindSignalError, errorClasses, FakePeerConnection];',
        '',
      ].join('\n'),
    );
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    // An application's tsconfig, with a bundler or with Node's own resolution.
    for (const [module, moduleResolution] of [
      ['nodenext', 'nodenext'],
      ['esnext', 'bundler'],
    ]) {
      const compilerOptions = {
        module,
        moduleResolution,
        target: 'es2024',
        lib: ['es2024', 'dom'],
      };
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { ...compilerOptions, strict: true, noEmit: true, types: [] },
          files: ['app.ts'],
        }),
      );
      run(process.execPath, [tsc, '-p', 'tsconfig.json'], root);
    }
    const loaded = run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const sdk = await import('@blindsignal/sdk'); await import('@blindsignal/sdk/testing'); console.log(typeof sdk.BlindSignalClient);",
      ],
      root,
    );
    expect(loaded.trim()).toBe('function');
  });
});
