import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
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
    script = ('#!/bin/sh\\n' + ('exit 1\\n' if kind == 'broken' else 'printf "%s\\\\n" "' + version + '"\\n')).encode()
    entry.size = len(script)
    entry.mode = 0o755
    bundle.addfile(entry, io.BytesIO(script))
    if kind in ('traversal', 'absolute', 'symlink', 'hardlink', 'duplicate'):
        entry = tarfile.TarInfo({'traversal': '../escaped', 'absolute': '/tmp/flex-escaped', 'duplicate': 'bin/flexx'}.get(kind, 'evil'))
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
  return spawnSync(join(prefix, 'bin/flexx'), ['--version'], { encoding: 'utf8' }).stdout.trim();
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

for (const kind of ['traversal', 'absolute', 'symlink', 'hardlink', 'duplicate']) {
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
  assert.notEqual(spawnSync('bash', [installer], { env }).status, 0);
  assert.notEqual(spawnSync('bash', [installer, '--version'], { env }).status, 0);
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
