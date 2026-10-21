import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GENERATED_KEY, REQUIRED_SECRETS, envFromExample } from '../../scripts/required-secrets.ts';
import { nodeFreeTools } from './fresh-clone-checks.ts';
import { REPO } from './stack.ts';

/**
 * `scripts/stack-init.sh` (#277, P10-02; Phase 10 plan "Success criterion 1", init rules). Every
 * test copies the script and `.env.example` into a temporary directory of its own and runs the
 * copy there: never in the checkout, whose `.env` it must not touch.
 */

const SCRIPT = readFileSync(join(REPO, 'scripts/stack-init.sh'), 'utf8');
const EXAMPLE = readFileSync(join(REPO, '.env.example'), 'utf8');
const HEX32 = /^[0-9a-f]{32}$/;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory with a copy of the script (`stack-init.sh`) and of `.env.example`. */
function sandbox(script = SCRIPT): string {
  const dir = mkdtempSync(join(tmpdir(), 'stack-init-test-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'stack-init.sh'), script);
  writeFileSync(join(dir, '.env.example'), EXAMPLE);
  return dir;
}

/** Runs the copy with /bin/sh, umask 022 (so mode 600 is the script's own doing). */
function init(
  dir: string,
  options: {
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly path?: string;
  } = {},
) {
  const result = spawnSync(
    '/bin/sh',
    [
      '-c',
      'umask 022; exec /bin/sh "$@"',
      'sh',
      join(dir, 'stack-init.sh'),
      ...(options.args ?? [dir]),
    ],
    {
      cwd: options.cwd ?? dir,
      encoding: 'utf8',
      env: { PATH: options.path ?? process.env.PATH ?? '', HOME: dir },
    },
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** `KEY=value` lines of an env file, in order. */
const entries = (text: string): [string, string][] =>
  text
    .split('\n')
    .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [match[1] ?? '', match[2] ?? '']);

/** A PATH of links to exactly these tools (the fresh-clone test's Node-free PATH, in small). */
function linkFarm(tools: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'stack-init-bin-'));
  dirs.push(dir);
  for (const tool of tools) {
    const found = (process.env.PATH ?? '')
      .split(delimiter)
      .map((entry) => join(entry, tool))
      .find((path) => existsSync(path));
    if (found === undefined) throw new Error(`${tool} not on the PATH`);
    symlinkSync(found, join(dir, tool));
  }
  return dir;
}

describe('scripts/stack-init.sh (#277)', () => {
  it('requires the same keys as the gate (REQUIRED_SECRETS in scripts/required-secrets.ts)', () => {
    const listed = /^REQUIRED_SECRETS='([^']*)'$/m.exec(SCRIPT)?.[1];
    expect(listed?.trim().split(/\s+/)).toEqual([...REQUIRED_SECRETS]);
  });

  it('writes .env with mode 600: the same keys as the gate, a new 32-hex value for each password and token', () => {
    const dir = sandbox();
    const result = init(dir);
    expect(result.code).toBe(0);
    const env = readFileSync(join(dir, '.env'), 'utf8');
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    const written = entries(env);
    // The gate's throw-away env file from the same .env.example (without its project and tag).
    const gate = entries(envFromExample(EXAMPLE, () => 'GENERATED').join('\n'));
    expect(written.map(([key]) => key)).toEqual(gate.map(([key]) => key));
    const values = new Set<string>();
    for (const [index, [key, value]] of written.entries()) {
      if (gate[index]?.[1] === 'GENERATED') {
        expect(value, key).toMatch(HEX32);
        values.add(value);
      } else {
        expect(value, key).toBe(gate[index]?.[1]);
      }
    }
    const generated = gate.filter(([, value]) => value === 'GENERATED').map(([key]) => key);
    expect(values.size).toBe(generated.length);
    for (const key of REQUIRED_SECRETS) expect(generated).toContain(key);
    for (const key of generated) expect(key).toMatch(GENERATED_KEY);
    // Every other line of .env.example (comments included) is kept as it is.
    expect(env.split('\n').filter((line) => !/^[A-Z0-9_]+=/.test(line))).toEqual(
      EXAMPLE.split('\n').filter((line) => !/^[A-Z0-9_]+=/.test(line)),
    );
  });

  it('appends a required secret .env.example lacks', () => {
    const dir = sandbox();
    writeFileSync(
      join(dir, '.env.example'),
      EXAMPLE.split('\n')
        .filter((line) => !line.startsWith('SIM_CONTROL_TOKEN='))
        .join('\n'),
    );
    expect(init(dir).code).toBe(0);
    const written = new Map(entries(readFileSync(join(dir, '.env'), 'utf8')));
    expect(written.get('SIM_CONTROL_TOKEN')).toMatch(HEX32);
  });

  it('falls back to od when openssl is not on the PATH, with the same key set', () => {
    const { required } = nodeFreeTools(SCRIPT, {});
    const tools = required.filter((tool) => !['git', 'docker'].includes(tool));
    expect(tools).not.toContain('openssl');
    const path = linkFarm(tools);
    const withOpenssl = sandbox();
    const withoutOpenssl = sandbox();
    expect(init(withOpenssl).code).toBe(0);
    const result = init(withoutOpenssl, { path });
    expect(result.code, result.stderr).toBe(0);
    const a = entries(readFileSync(join(withOpenssl, '.env'), 'utf8'));
    const b = entries(readFileSync(join(withoutOpenssl, '.env'), 'utf8'));
    expect(b.map(([key]) => key)).toEqual(a.map(([key]) => key));
    for (const [key, value] of b) if (GENERATED_KEY.test(key)) expect(value, key).toMatch(HEX32);
  });

  it('acts on its working directory, or on $1, never on its own directory', () => {
    const home = sandbox();
    const target = sandbox();
    // In the working directory (no argument): the target, while the script lives in `home`.
    const cwd = spawnSync('/bin/sh', [join(home, 'stack-init.sh')], {
      cwd: target,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(cwd.status).toBe(0);
    expect(existsSync(join(target, '.env'))).toBe(true);
    expect(existsSync(join(home, '.env'))).toBe(false);
    // With $1 from elsewhere: that directory.
    const other = sandbox();
    expect(init(home, { args: [other], cwd: target }).code).toBe(0);
    expect(existsSync(join(other, '.env'))).toBe(true);
    expect(existsSync(join(home, '.env'))).toBe(false);
  });

  it('says where the admin password is, never the password, when its output is not a terminal', () => {
    const dir = sandbox();
    const result = init(dir);
    const password = new Map(entries(readFileSync(join(dir, '.env'), 'utf8'))).get(
      'MES_BOOTSTRAP_ADMIN_PASSWORD',
    );
    expect(password).toMatch(HEX32);
    expect(result.stdout).toContain('MES_BOOTSTRAP_ADMIN_PASSWORD in .env');
    expect(`${result.stdout}${result.stderr}`).not.toContain(password);
  });

  it('reruns as "already initialised" without changing a complete .env', () => {
    const dir = sandbox();
    expect(init(dir).code).toBe(0);
    const before = readFileSync(join(dir, '.env'));
    const mtime = statSync(join(dir, '.env')).mtimeMs;
    const again = init(dir);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already initialised');
    // It read every required value to check it, and prints none of them.
    for (const [key, value] of entries(before.toString('utf8'))) {
      if (GENERATED_KEY.test(key))
        expect(`${again.stdout}${again.stderr}`, key).not.toContain(value);
    }
    expect(readFileSync(join(dir, '.env'))).toEqual(before);
    expect(statSync(join(dir, '.env')).mtimeMs).toBe(mtime);
  });

  it('reports a missing, empty or change-me required key by name only, exit 1, and changes nothing', () => {
    const dir = sandbox();
    const known = 'f'.repeat(32);
    const lines = REQUIRED_SECRETS.filter((key) => key !== 'SIM_CONTROL_TOKEN').map((key) => {
      if (key === 'OPCUA_READER_PASSWORD') return `${key}=`;
      if (key === 'DB_PASSWORD') return `${key}=change-me`;
      if (key === 'ERP_API_TOKEN') return `${key}="change-me"`;
      return `${key}=${known}`;
    });
    // GRAFANA_ADMIN_PASSWORD is optional: empty, never reported.
    const text = `${lines.join('\n')}\nGRAFANA_ADMIN_PASSWORD=\n`;
    writeFileSync(join(dir, '.env'), text, { mode: 0o600 });
    const result = init(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('missing: SIM_CONTROL_TOKEN');
    expect(result.stderr).toContain('missing: OPCUA_READER_PASSWORD');
    expect(result.stderr).toContain('weak (change-me): DB_PASSWORD');
    expect(result.stderr).toContain('weak (change-me): ERP_API_TOKEN');
    expect(result.stderr).not.toContain('GRAFANA');
    expect(result.stderr.match(/^ {2}(missing|weak)/gm)).toHaveLength(4);
    expect(`${result.stdout}${result.stderr}`).not.toContain(known);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(text);
  });

  it('never replaces a .env that appears while it runs (set -C)', () => {
    // An `openssl` that creates .env the first time it is called: the race, made certain.
    const dir = sandbox();
    const shim = mkdtempSync(join(tmpdir(), 'stack-init-shim-'));
    dirs.push(shim);
    writeFileSync(
      join(shim, 'openssl'),
      `#!/bin/sh\n[ -e "${dir}/.env" ] || echo 'theirs' > "${dir}/.env"\necho 0123456789abcdef0123456789abcdef\n`,
    );
    chmodSync(join(shim, 'openssl'), 0o755);
    const result = init(dir, { path: `${shim}${delimiter}${process.env.PATH ?? ''}` });
    expect(result.code).not.toBe(0);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('theirs\n');
  });

  it('exits 2 without .env.example or the directory', () => {
    const dir = sandbox();
    rmSync(join(dir, '.env.example'));
    expect(init(dir).code).toBe(2);
    expect(existsSync(join(dir, '.env'))).toBe(false);
    expect(init(dir, { args: [join(dir, 'nowhere')] }).code).toBe(2);
  });

  it('is never run in the checkout by these tests', () => {
    // The sandbox is outside the repository.
    const dir = sandbox();
    expect(dir.startsWith(REPO)).toBe(false);
    mkdirSync(join(dir, 'sub'));
    copyFileSync(join(dir, '.env.example'), join(dir, 'sub', '.env.example'));
    expect(init(dir, { args: [join(dir, 'sub')] }).code).toBe(0);
  });
});
