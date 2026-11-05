import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

/** Every Markdown file of a repository, untracked ones included, outside what Git ignores. */
function markdownFiles(root: string): string[] {
  const args = ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '*.md'];
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '' && existsSync(join(root, file)));
}

// A fenced block shows syntax, not links or headings.
function withoutFences(markdown: string): string {
  return markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
}

/** The relative link targets of a document; code blocks and code spans hold none. */
function linkTargets(markdown: string): string[] {
  const prose = withoutFences(markdown).replace(/`[^`\n]*`/g, '');
  return [...prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map(([, target]) => target!)
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target));
}

/** The anchors GitHub gives a document's headings. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const [, heading] of withoutFences(markdown).matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const slug = heading!
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replaceAll(' ', '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    result.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return result;
}

/** The links of a file whose target file, or heading in a Markdown target, does not exist. */
function brokenLinks(root: string, file: string): string[] {
  const markdown = readFileSync(join(root, file), 'utf8');
  return linkTargets(markdown).flatMap((target) => {
    const [path = '', fragment] = target.split('#', 2);
    const destination = path === '' ? file : join(dirname(file), decodeURIComponent(path));
    if (!existsSync(join(root, destination))) return [`${file}: ${target}`];
    // Anchors are checked in Markdown only: GitHub's line anchors in code have no heading.
    if (fragment === undefined || !destination.endsWith('.md')) return [];
    const targetAnchors = anchors(readFileSync(join(root, destination), 'utf8'));
    return targetAnchors.has(decodeURIComponent(fragment)) ? [] : [`${file}: ${target}`];
  });
}

describe('the Markdown files', () => {
  it('link only to files and headings that exist', () => {
    const files = markdownFiles(root);
    expect(files).toContain('README.md');
    expect(files).toContain('docs/README.md');
    expect(files.flatMap((file) => brokenLinks(root, file))).toEqual([]);
  });
});

describe('the link check', () => {
  let directory = '';
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'blindsignal-links-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function write(file: string, markdown: string): void {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), markdown);
  }

  it('lists untracked documents too', () => {
    execFileSync('git', ['init', '--quiet'], { cwd: directory });
    write('docs/new.md', '# New\n');
    write('code.ts', '');
    expect(markdownFiles(directory)).toEqual(['docs/new.md']);
  });

  it('reports a missing file, a missing heading in another document or its own', () => {
    write('docs/b.md', '# B\n\n## Kept\n');
    write('src/c.ts', '');
    write(
      'docs/a.md',
      [
        '# A',
        '[ok](b.md) [ok](b.md#kept) [ok](#a) [ok](../src/c.ts#L1) [ok](../src)',
        '[gone](missing.md) [gone](b.md#renamed) [gone](#nowhere)',
      ].join('\n'),
    );
    expect(brokenLinks(directory, 'docs/a.md')).toEqual([
      'docs/a.md: missing.md',
      'docs/a.md: b.md#renamed',
      'docs/a.md: #nowhere',
    ]);
  });
});

describe('linkTargets', () => {
  it('reads relative links and images, with or without a title or an anchor', () => {
    const markdown = [
      'See [the spec](docs/spec.md), [a section](../a.md#b "B"), and [here](#c).',
      '![a diagram](images/d.svg) and [`code`](e.md).',
    ].join('\n');
    expect(linkTargets(markdown)).toEqual([
      'docs/spec.md',
      '../a.md#b',
      '#c',
      'images/d.svg',
      'e.md',
    ]);
  });

  it('skips URLs, code spans, and fenced blocks', () => {
    const markdown = [
      '[web](https://example.com) [mail](mailto:a@example.com) `[span](f.md)`',
      '```md',
      '[fenced](g.md)',
      '```',
      '~~~',
      '[tilde](h.md)',
      '~~~',
    ].join('\n');
    expect(linkTargets(markdown)).toEqual([]);
  });
});

describe('anchors', () => {
  it('slugs headings as GitHub does', () => {
    const markdown = [
      '# BlindSignal — Technical Specification',
      '## 7a. Pairing',
      '### `rtc.ice_config` and [TURN](turn.md)',
      '## Closed ##',
      '## Pairing',
      '#### 7a. Pairing',
      '```',
      '# not a heading',
      '```',
    ].join('\n');
    expect([...anchors(markdown)]).toEqual([
      'blindsignal--technical-specification',
      '7a-pairing',
      'rtcice_config-and-turn',
      'closed',
      'pairing',
      '7a-pairing-1',
    ]);
  });
});
