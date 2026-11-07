import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import process from 'node:process';
import { URL } from 'node:url';

const installer = fileURLToPath(new URL('../../install.sh', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'flex-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, prefix: join(root, 'private install') };
}
function archive(root, version, kind = 'valid') {
  const path = join(root, `${version}-${kind}.tar.gz`);
  const build = spawnSync(
    'python3',
    [
      '-c',
      `
import io, sys, tarfile
path, version, kind = sys.argv[1:]
with tarfile.open(path, 'w:gz') as bundle:
    entry = tarfile.TarInfo('bin/flexx')
    body = {'broken': 'exit 1\\n', 'hang': 'sleep 30\\n'}.get(kind, 'printf "%s\\\\n" "' + version + '"\\n')
    script = ('#!/bin/sh\\n' + body).encode()
    entry.size = len(script)
    entry.mode = 0o644 if kind == 'nonexec' else 0o755
    if kind == 'missing': entry.name = 'bin/other'
    if kind == 'invalidexec': script = b'not an executable'; entry.size = len(script)
    bundle.addfile(entry, io.BytesIO(script))
    if kind in ('traversal', 'absolute', 'symlink', 'hardlink', 'duplicate', 'conflict', 'fifo', 'normalized-duplicate'):
        entry = tarfile.TarInfo({'traversal': '../escaped', 'absolute': '/tmp/flex-escaped', 'duplicate': 'bin/flexx', 'normalized-duplicate': './bin//flexx', 'conflict': 'bin'}.get(kind, 'evil'))
        if kind == 'fifo': entry.type = tarfile.FIFOTYPE
        if kind in ('symlink', 'hardlink'):
            entry.type = tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE
            entry.linkname = '/tmp'
        bundle.addfile(entry, io.BytesIO(b''))
`,
      path,
      version,
      kind,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(build.status, 0, build.stderr);
  return { path, digest: createHash('sha256').update(readFileSync(path)).digest('hex') };
}
function install(prefix, version, bundle, extra = [], env = {}) {
  return spawnSync(
    'bash',
    [
      installer,
      '--version',
      version,
      '--sha256',
      bundle.digest,
      '--archive',
      bundle.path,
      '--prefix',
      prefix,
      ...extra,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
}
function active(prefix) {
  const result = spawnSync(join(prefix, 'bin/flexx'), ['--version'], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

test('installs and upgrades under a path with spaces, retaining old release and user files', (t) => {
  const { root, prefix } = fixture(t);
  mkdirSync(prefix);
  writeFileSync(join(prefix, 'config.json'), 'private config');
  assert.equal(install(prefix, 'v0.1.0', archive(root, 'v0.1.0')).status, 0);
  assert.equal(active(prefix), 'v0.1.0');
  const next = archive(root, 'v0.2.0');
  assert.equal(install(prefix, 'v0.2.0', next).status, 0);
  assert.equal(active(prefix), 'v0.2.0');
  assert.equal(readlinkSync(join(prefix, 'current')), 'versions/v0.2.0');
  assert.ok(existsSync(join(prefix, 'versions/v0.1.0/bin/flexx')));
  assert.equal(readFileSync(join(prefix, 'config.json'), 'utf8'), 'private config');
  assert.notEqual(install(prefix, 'v0.2.0', next).status, 0);
  assert.equal(active(prefix), 'v0.2.0');
  assert.ok(!existsSync(join(prefix, '.install-lock')));
});

test('failed checksum and failed smoke check leave the previous release active', (t) => {
  const { root, prefix } = fixture(t);
  assert.equal(install(prefix, 'v0.1.0', archive(root, 'v0.1.0')).status, 0);
  const next = archive(root, 'v0.2.0');
  assert.notEqual(install(prefix, 'v0.2.0', { ...next, digest: '0'.repeat(64) }).status, 0);
  assert.notEqual(install(prefix, 'v0.2.0', archive(root, 'v0.2.0', 'broken')).status, 0);
  assert.equal(active(prefix), 'v0.1.0');
  assert.ok(!existsSync(join(prefix, 'versions/v0.2.0')));
  assert.ok(!existsSync(join(prefix, '.install-lock')));
});

for (const kind of ['traversal', 'absolute', 'symlink', 'hardlink', 'duplicate', 'fifo', 'normalized-duplicate']) {
  test(`rejects ${kind} archive entries before activation`, (t) => {
    const { root, prefix } = fixture(t);
    const result = install(prefix, 'v0.1.0', archive(root, 'v0.1.0', kind));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive/);
    assert.ok(!existsSync(join(prefix, 'current')));
    assert.ok(!existsSync(join(root, 'escaped')));
    assert.ok(!existsSync(join(prefix, '.install-lock')));
  });
}

test('refuses unrelated launchers and symlinked installation directories', (t) => {
  const { root, prefix } = fixture(t);
  const bundle = archive(root, 'v0.1.0');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  const launcher = join(prefix, 'bin/flexx');
  writeFileSync(launcher, 'unrelated');
  assert.notEqual(install(prefix, 'v0.1.0', bundle).status, 0);
  assert.equal(readFileSync(launcher, 'utf8'), 'unrelated');
  const other = join(root, 'symlink');
  symlinkSync(prefix, other);
  assert.notEqual(install(other, 'v0.1.0', bundle).status, 0);
  assert.notEqual(install(resolve(prefix, '..', '..', '..'), 'v0.1.0', bundle, ['--prefix', '/']).status, 0);
});

test('refuses concurrent installs without deleting the existing lock', (t) => {
  const { root, prefix } = fixture(t);
  mkdirSync(join(prefix, '.install-lock'), { recursive: true });
  assert.notEqual(install(prefix, 'v0.1.0', archive(root, 'v0.1.0')).status, 0);
  assert.ok(existsSync(join(prefix, '.install-lock')));
});

test('downloads the matching pinned platform asset over HTTPS', (t) => {
  const { root, prefix } = fixture(t);
  const bundle = archive(root, 'v0.1.0');
  const bin = join(root, 'tools');
  mkdirSync(bin);
  const log = join(root, 'curl-args');
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env python3
import json, os, shutil, sys
args = sys.argv[1:]
with open(os.environ['INSTALL_CURL_LOG'], 'w') as out: json.dump(args, out)
shutil.copyfile(os.environ['INSTALL_ARCHIVE'], args[args.index('--output') + 1])
`,
  );
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; esac\n');
  for (const name of ['curl', 'uname']) chmodSync(join(bin, name), 0o700);
  const result = spawnSync('bash', [installer, '--version', 'v0.1.0', '--sha256', bundle.digest, '--prefix', prefix], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALL_ARCHIVE: bundle.path, INSTALL_CURL_LOG: log },
  });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(readFileSync(log, 'utf8'));
  assert.ok(args.includes('https://github.com/0xr10t/Flex/releases/download/v0.1.0/flex-v0.1.0-darwin-aarch64.tar.gz'));
  assert.equal(args[args.indexOf('--proto-redir') + 1], '=https');
  assert.equal(active(prefix), 'v0.1.0');
});

test('requires a version and trusted digest; help works without installation', (t) => {
  const { root } = fixture(t);
  const env = { ...process.env, HOME: root };
  assert.equal(spawnSync('bash', [installer, '--help'], { env }).status, 0);
  assert.notEqual(spawnSync('bash', [installer, '--version'], { env }).status, 0);
  assert.notEqual(spawnSync('bash', [installer, '--version', 'v0.1.0'], { env }).status, 0);
  assert.notEqual(spawnSync('bash', [installer, '--sha256', '0'.repeat(64)], { env }).status, 0);
  assert.ok(!existsSync(join(root, '.flex')));
});

test('failed downloads clean staging and retain the active release', (t) => {
  const { root, prefix } = fixture(t);
  assert.equal(install(prefix, 'v0.1.0', archive(root, 'v0.1.0')).status, 0);
  const tools = join(root, 'download-tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'curl'), '#!/bin/sh\nexit 22\n');
  chmodSync(join(tools, 'curl'), 0o700);
  const result = spawnSync('bash', [installer, '--version', 'v0.2.0', '--sha256', '0'.repeat(64), '--prefix', prefix], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${tools}:${process.env.PATH}` },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not download flex-v0\.2\.0-.*; check that release v0\.2\.0 is published/);
  assert.equal(active(prefix), 'v0.1.0');
  assert.ok(!existsSync(join(prefix, '.install-lock')));
});

test('unsupported platforms fail before creating the installation directory', (t) => {
  const { root, prefix } = fixture(t);
  const tools = join(root, 'unsupported-tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'uname'), '#!/bin/sh\necho UnsupportedOS\n');
  chmodSync(join(tools, 'uname'), 0o700);
  const result = install(prefix, 'v0.1.0', archive(root, 'v0.1.0'), [], { PATH: `${tools}:${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported OS/);
  assert.ok(!existsSync(prefix));
});

test('installs to the default prefix when $HOME is reached through a symlink', (t) => {
  const { root } = fixture(t);
  const real = join(root, 'real-home');
  mkdirSync(real);
  symlinkSync(real, join(root, 'home'));
  const bundle = archive(root, 'v0.1.0');
  const result = spawnSync(
    'bash',
    [installer, '--version', 'v0.1.0', '--sha256', bundle.digest, '--archive', bundle.path],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: join(root, 'home') },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(active(join(real, '.flex')), 'v0.1.0');
});

test('stops a smoke check that never finishes', (t) => {
  const { root, prefix } = fixture(t);
  const result = install(prefix, 'v0.1.0', archive(root, 'v0.1.0', 'hang'), [], { FLEX_INSTALL_SMOKE_TIMEOUT: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not finish within 1 seconds/);
  assert.ok(!existsSync(join(prefix, 'current')));
  assert.ok(!existsSync(join(prefix, '.install-lock')));
});

test('unreadable archives and blocking files fail with installer messages, not tracebacks', (t) => {
  const { root, prefix } = fixture(t);
  const valid = archive(root, 'v0.1.0');
  const garbage = join(root, 'not-gzip.tar.gz');
  writeFileSync(garbage, 'plain text, not a gzip stream');
  const truncated = join(root, 'truncated.tar.gz');
  writeFileSync(truncated, readFileSync(valid.path).subarray(0, 40));
  const digestOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const cases = [
    [prefix, { path: garbage, digest: digestOf(garbage) }],
    [prefix, { path: truncated, digest: digestOf(truncated) }],
    [prefix, archive(root, 'v0.1.0', 'conflict')],
  ];
  for (const blocker of ['bin', 'versions']) {
    const blocked = join(root, `blocked-${blocker}`);
    mkdirSync(blocked);
    writeFileSync(join(blocked, blocker), 'not a directory');
    cases.push([blocked, valid]);
  }
  for (const [target, bundle] of cases) {
    const result = install(target, 'v0.1.0', bundle);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /Traceback/);
    assert.match(result.stderr.trim().split('\n').at(-1), /^flexx installer: /);
    assert.ok(!existsSync(join(target, 'current')));
    assert.ok(!existsSync(join(target, '.install-lock')));
  }
});

test('a read-only prefix is reported as such, not as a held lock', { skip: process.getuid?.() === 0 }, (t) => {
  const { root, prefix } = fixture(t);
  mkdirSync(prefix);
  chmodSync(prefix, 0o500);
  const result = install(prefix, 'v0.1.0', archive(root, 'v0.1.0'));
  chmodSync(prefix, 0o700);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot create files in/);
});

test('refuses the root directory however it is spelled', (t) => {
  const { root } = fixture(t);
  const bundle = archive(root, 'v0.1.0');
  for (const spelling of ['//', '/tmp/..']) {
    const result = install(spelling, 'v0.1.0', bundle);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot install into \//);
  }
});

for (const kind of ['nonexec', 'missing', 'invalidexec']) {
  test(`rejects a ${kind} launcher without a traceback or activation`, (t) => {
    const { root, prefix } = fixture(t);
    const result = install(prefix, 'v0.1.0', archive(root, 'v0.1.0', kind));
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /Traceback/);
    assert.ok(!existsSync(join(prefix, 'current')));
    assert.deepEqual(readdirSync(prefix), []);
  });
}

test('refuses an unrelated current symlink and a prefix that is a regular file', (t) => {
  const { root, prefix } = fixture(t);
  const bundle = archive(root, 'v0.1.0');
  writeFileSync(prefix, 'keep');
  const fileResult = install(prefix, 'v0.1.0', bundle);
  assert.notEqual(fileResult.status, 0);
  assert.doesNotMatch(fileResult.stderr, /Traceback/);
  assert.equal(readFileSync(prefix, 'utf8'), 'keep');
  const other = join(root, 'other');
  mkdirSync(other);
  symlinkSync('../outside', join(other, 'current'));
  assert.notEqual(install(other, 'v0.1.0', bundle).status, 0);
  assert.equal(readlinkSync(join(other, 'current')), '../outside');
});

function sourceFixture(t) {
  const { root, prefix } = fixture(t);
  const tools = join(root, 'tools');
  mkdirSync(tools);
  const log = join(root, 'commands.jsonl');
  writeFileSync(
    join(tools, 'git'),
    `#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ['SOURCE_LOG'], 'a') as f: f.write(json.dumps(['git'] + args) + '\\n')
if args[0] == 'clone':
    if os.environ.get('SOURCE_FAIL') == 'clone': sys.exit(1)
    root = pathlib.Path(args[-1])
    (root / 'dist/src/cli').mkdir(parents=True)
    (root / '.env.example').write_text('FLEX_WALLET_ADDRESS=\\n')
    (root / 'dist/src/cli/main.js').write_text("console.log(process.argv[2] === '--version' ? 'flexx 0.1.0' : JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}));")
elif args[0] == '-C': print('a' * 40)
else: sys.exit(2)
`,
  );
  writeFileSync(
    join(tools, 'npm'),
    `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['SOURCE_LOG'], 'a') as f: f.write(json.dumps(['npm'] + args) + '\\n')
key = args[1] if args[0] == '--prefix' else args[0]
if os.environ.get('SOURCE_DRAIN_STDIN'): sys.stdin.read()
sys.exit(1 if os.environ.get('SOURCE_FAIL') == key else 0)
`,
  );
  for (const name of ['git', 'npm']) chmodSync(join(tools, name), 0o700);
  const env = { ...process.env, PATH: `${tools}:${process.env.PATH}`, SOURCE_LOG: log };
  const run = (extra = [], overrides = {}) =>
    spawnSync('bash', [installer, '--source', '--prefix', prefix, ...extra], {
      encoding: 'utf8',
      env: { ...env, ...overrides },
    });
  return { root, prefix, tools, log, run };
}

test('source install builds all project components and launches after relocation from any directory', (t) => {
  const { root, prefix, log, run } = sourceFixture(t);
  const result = run([], { NODE_ENV: 'production' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(active(prefix), 'flexx 0.1.0');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0].slice(0, -1), [
    'git',
    'clone',
    '--depth',
    '1',
    '--branch',
    'master',
    '--',
    'https://github.com/0xr10t/Flex.git',
  ]);
  assert.deepEqual(
    calls.filter(([tool]) => tool === 'npm'),
    [
      ['npm', 'ci', '--include=dev'],
      ['npm', '--prefix', 'wallet', 'ci', '--include=dev'],
      ['npm', '--prefix', 'wallet/cre/autopay', 'ci', '--include=dev'],
      ['npm', 'run', 'testnet:build'],
    ],
  );
  const launched = spawnSync(join(prefix, 'bin/flexx'), ['--help', 'an argument with spaces'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(JSON.parse(launched.stdout), {
    cwd: join(prefix, 'versions', `source-${'a'.repeat(40)}`),
    args: ['--help', 'an argument with spaces'],
  });
  assert.ok(!existsSync(join(prefix, '.install-lock')));
  const config = join(prefix, 'current', '.env');
  assert.equal(readFileSync(config, 'utf8'), 'FLEX_WALLET_ADDRESS=\n');
  assert.equal(statSync(config).mode & 0o777, 0o600);
  writeFileSync(config, 'user configuration');
  assert.notEqual(run().status, 0);
  assert.equal(readFileSync(config, 'utf8'), 'user configuration');
});

for (const stage of ['clone', 'ci', 'wallet', 'wallet/cre/autopay', 'run']) {
  test(`source failure at ${stage} stops immediately and removes staging and lock`, (t) => {
    const { prefix, log, run } = sourceFixture(t);
    const result = run([], { SOURCE_FAIL: stage });
    assert.notEqual(result.status, 0);
    assert.deepEqual(readdirSync(prefix), []);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const last = calls.at(-1);
    assert.equal(last[1] === '--prefix' ? last[2] : last[1], stage);
  });
}

test('source options cannot bypass release checksum requirements', (t) => {
  const { prefix, run } = sourceFixture(t);
  for (const args of [
    ['--version', 'v0.1.0'],
    ['--sha256', '0'.repeat(64)],
    ['--archive', '/tmp/archive'],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot be combined/);
    assert.ok(!existsSync(prefix));
  }
});

test('source installation validates Node before creating the prefix', (t) => {
  const { prefix, tools, run } = sourceFixture(t);
  writeFileSync(join(tools, 'node'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(tools, 'node'), 0o700);
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node 22.12/);
  assert.ok(!existsSync(prefix));
});

test('curl | bash: no arguments means a source install, and a child reading stdin cannot eat the script', (t) => {
  const { prefix, log } = sourceFixture(t);
  const env = { ...process.env, PATH: `${join(log, '..', 'tools')}:${process.env.PATH}`, SOURCE_LOG: log };
  const result = spawnSync('bash', [], {
    input: readFileSync(installer),
    encoding: 'utf8',
    env: { ...env, HOME: join(prefix, '..'), SOURCE_DRAIN_STDIN: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(active(join(prefix, '..', '.flex')), 'flexx 0.1.0');
  assert.match(result.stdout, /Run flexx/);
});

test('a truncated download runs nothing', (t) => {
  const { prefix } = fixture(t);
  const script = readFileSync(installer, 'utf8');
  const result = spawnSync('bash', ['-s', '--', '--prefix', prefix], {
    input: script.slice(0, script.lastIndexOf('main "$@"')),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout + result.stderr, '');
  assert.ok(!existsSync(prefix));
});
