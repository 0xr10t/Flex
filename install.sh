#!/usr/bin/env bash
# Install a prepared Flex release. No services, configuration, or model downloads.
set -euo pipefail
umask 077

usage() {
  cat <<'HELP'
Usage: bash install.sh --version VERSION --sha256 DIGEST [options]

  --version VERSION  Release tag, such as v0.1.0 (required)
  --sha256 DIGEST    SHA-256 obtained through a trusted channel (required)
  --archive PATH     Install a local archive instead of downloading
  --prefix PATH      Absolute installation directory (default: ~/.flex)
  -h, --help         Show this help

Downloads flex-VERSION-OS-ARCH.tar.gz from 0xr10t/Flex GitHub Releases.
Supported targets: linux/darwin, x86_64/aarch64. Requires Bash, Python 3,
and curl for downloads. Archives must contain bin/flexx plus its runtime,
with no enclosing directory, symlinks, hard links, or special files.
HELP
}
fail() { printf 'flex installer: %s\n' "$*" >&2; exit 1; }
version=''
digest=''
archive=''
prefix="${HOME:?HOME must be set}/.flex"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --version|--sha256|--archive|--prefix)
      [[ $# -ge 2 && -n "$2" ]] || fail "missing value for $1"
      case "$1" in
        --version) version="$2" ;;
        --sha256) digest="$2" ;;
        --archive) archive="$2" ;;
        --prefix) prefix="$2" ;;
      esac
      shift 2 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]] || fail 'provide a release version such as v0.1.0'
[[ "$digest" =~ ^[[:xdigit:]]{64}$ ]] || fail 'provide a trusted 64-character SHA-256 digest'
[[ "$prefix" == /* && "$prefix" != / ]] || fail '--prefix must be an absolute non-root directory'
command -v python3 >/dev/null 2>&1 || fail 'Python 3 is required'
case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  *) fail 'unsupported OS; use a supported Linux or macOS environment' ;;
esac
case "$(uname -m)" in
  x86_64|amd64) architecture=x86_64 ;;
  arm64|aarch64) architecture=aarch64 ;;
  *) fail 'unsupported CPU architecture' ;;
esac
if [[ -n "$archive" ]]; then
  [[ -f "$archive" ]] || fail 'local archive does not exist'
else
  command -v curl >/dev/null 2>&1 || fail 'curl is required for downloads'
fi
# Resolve paths and reject symlinked installation components before writing.
prefix=$(python3 - "$prefix" <<'PY'
import os, pathlib, sys
p = pathlib.Path(os.path.abspath(sys.argv[1]))
for part in (p, *p.parents):
    if part.is_symlink():
        sys.exit('flex installer: installation path must not contain symlinks')
if p == pathlib.Path('/'):
    sys.exit('flex installer: cannot install into /')
for child in ('versions', 'bin', 'current'):
    target = p / child
    if child != 'current' and target.is_symlink():
        sys.exit('flex installer: installation directories must not be symlinks')
    if child == 'current' and target.exists() and not target.is_symlink():
        sys.exit('flex installer: current exists and is not an installer symlink')
launcher = p / 'bin/flexx'
if os.path.lexists(launcher) and not (launcher.is_symlink() and os.readlink(launcher) == '../current/bin/flexx'):
    sys.exit('flex installer: refusing to replace an unrelated bin/flexx')
print(p)
PY
)
mkdir -p "$prefix"
lock="$prefix/.install-lock"
mkdir "$lock" 2>/dev/null || fail 'another install holds .install-lock; inspect it before removing a stale lock'
staging=''
cleanup() {
  # Only remove this invocation's private staging directory and empty lock.
  python3 - "$staging" "$lock" <<'PY'
import pathlib, shutil, sys
if sys.argv[1]:
    shutil.rmtree(sys.argv[1])
pathlib.Path(sys.argv[2]).rmdir()
PY
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ ! -e "$prefix/versions/$version" && ! -L "$prefix/versions/$version" ]] || fail 'version already installed; existing releases are never overwritten'
staging=$(mktemp -d "$prefix/.install.XXXXXXXX")
if [[ -z "$archive" ]]; then
  archive="$staging/release.tar.gz"
  asset="flex-$version-$platform-$architecture.tar.gz"
  printf 'Downloading %s from GitHub Releases...\n' "$asset"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 600 --retry 2 \
    "https://github.com/0xr10t/Flex/releases/download/$version/$asset" --output "$archive" ||
    fail "could not download $asset; check that release $version is published for this platform"
fi
python3 - "$archive" "$digest" "$staging/payload" <<'PY'
import hashlib, pathlib, shutil, sys, tarfile
archive, digest, destination = sys.argv[1:]
h = hashlib.sha256()
with open(archive, 'rb') as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        h.update(chunk)
if h.hexdigest() != digest.lower():
    sys.exit('flex installer: SHA-256 mismatch; nothing activated')
root = pathlib.Path(destination)
with tarfile.open(archive, 'r:gz') as bundle:
    members = bundle.getmembers()
    seen = set()
    # Validate the whole archive before writing any payload file.
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or '\\' in member.name:
            sys.exit('flex installer: unsafe archive path')
        if not (member.isfile() or member.isdir()):
            sys.exit('flex installer: archive links and special files are forbidden')
        if path in seen:
            sys.exit('flex installer: duplicate archive path')
        seen.add(path)
    for member in members:
        target = root / member.name
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o700 if member.mode & 0o111 else 0o600)
launcher = root / 'bin/flexx'
if not launcher.is_file() or not launcher.stat().st_mode & 0o111:
    sys.exit('flex installer: release must contain executable bin/flexx')
PY
"$staging/payload/bin/flexx" --version || fail 'release smoke check failed; previous version remains active'
python3 - "$staging" "$prefix" "$version" <<'PY'
import os, pathlib, sys
stage, root, version = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
(root / 'versions').mkdir(exist_ok=True)
(root / 'bin').mkdir(exist_ok=True)
os.rename(stage / 'payload', root / 'versions' / version)
launcher = root / 'bin/flexx'
if not os.path.lexists(launcher):
    launcher.symlink_to('../current/bin/flexx')
link = stage / 'current'
link.symlink_to('versions/' + version)
os.replace(link, root / 'current')
PY
printf '\nInstalled Flex %s in %s\n' "$version" "$prefix"
printf 'Add this directory to your PATH: %s/bin\n' "$prefix"
printf 'No shell files, configuration, or services were changed.\n'
printf 'Run flexx --help for the commands supported by this release.\n'
