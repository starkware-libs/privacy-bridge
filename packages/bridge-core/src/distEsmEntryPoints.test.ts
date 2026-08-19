// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Every published entry point must load under native Node ESM, not just under a
// bundler: Node requires explicit file extensions on relative specifiers, so an
// extensionless `./x` in the emit is ERR_MODULE_NOT_FOUND for a plain-Node
// consumer while `skipLibCheck` + bundler resolution keep tsc quiet.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type ExportEntry = { types?: string; import?: string };

const entryPoints = Object.entries(
  JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')).exports as Record<
    string,
    ExportEntry
  >,
).map(([subpath, entry]) => ({ subpath, file: entry.import as string }));

function importUnderNode(file: string): { status: number; stderr: string } {
  const target = resolve(pkgRoot, file);
  try {
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(target)})`],
      {
        cwd: pkgRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? 1, stderr: e.stderr ?? String(err) };
  }
}

describe('published dist loads under native Node ESM', () => {
  it('has a built dist (run `pnpm build` first)', () => {
    expect(entryPoints.length).toBeGreaterThan(0);
    for (const { file } of entryPoints) {
      expect(existsSync(resolve(pkgRoot, file)), `missing ${file} — run pnpm build`).toBe(true);
    }
  });

  // react/viem/starknet are peerDependencies and are installed here, so a real
  // consumer's peer install is what a bare-specifier failure would mean — never
  // this bug. A specifier under dist/ that Node cannot resolve is always ours.
  for (const { subpath, file } of entryPoints) {
    it(`imports "${subpath}" (${file}) with no unresolved dist specifier`, () => {
      const { status, stderr } = importUnderNode(file);
      const unresolvedInDist = /Cannot find module '([^']*\/dist\/[^']*)'/.exec(stderr);
      expect(
        unresolvedInDist?.[1] ?? null,
        `Node could not resolve a file inside dist/:\n${stderr}`,
      ).toBe(null);
      expect(status, `node failed to import ${file}:\n${stderr}`).toBe(0);
    }, 60_000);
  }
});
