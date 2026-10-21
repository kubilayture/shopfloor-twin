/**
 * Vitest global setup (P10-01): picks the run's fast-check seed once per workspace and run
 * (`FC_SEED` if set, else a drawn one), prints it, and provides it to the test workers, where
 * `setup.ts` applies it with `fc.configureGlobal`.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { resolveSeed, seedLine } from './seed.ts';
import './context.ts';

/** The workspace's package name, or its directory's name without one. */
function workspaceName(root: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    if (typeof manifest.name === 'string' && manifest.name !== '') return manifest.name;
  } catch {
    // No readable package.json: fall back to the directory.
  }
  return basename(root);
}

export default function setup(project: TestProject): void {
  const seed = resolveSeed(process.env.FC_SEED);
  console.log(seedLine(workspaceName(project.config.root), seed));
  project.provide('fcSeed', seed);
}
