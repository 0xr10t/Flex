// POSIX mode bits are not access controls on Windows. Use a protected DACL there.
// The PowerShell program is fixed; the path is data in the environment, never shell source.
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const WINDOWS_ACL = `
$ErrorActionPreference = 'Stop'
$path = $env:FLEX_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:FLEX_PRIVATE_ACTION -eq 'protect') {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
  [System.IO.File]::SetAccessControl($path, $acl)
}
$acl = [System.IO.File]::GetAccessControl($path)
if (-not $acl.AreAccessRulesProtected) { exit 2 }
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 3 }
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
$own = $false
foreach ($rule in $rules) {
  if ($rule.AccessControlType -eq 'Allow') {
    if ($rule.IdentityReference.Value -ne $sid.Value) { exit 4 }
    if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData) -ne 0) { $own = $true }
  }
}
if (-not $own) { exit 5 }
`;

function windowsAcl(path: string, action: 'protect' | 'check'): void {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_ACL, 'utf16le').toString('base64')], {
    env: { ...process.env, FLEX_PRIVATE_PATH: path, FLEX_PRIVATE_ACTION: action },
    stdio: 'ignore', windowsHide: true, timeout: 15_000,
  });
}

export function protectPrivateFile(path: string): void {
  if (!lstatSync(path).isFile()) throw new Error('private file must be a regular file');
  if (process.platform === 'win32') windowsAcl(path, 'protect');
  else chmodSync(path, 0o600);
}

export function assertPrivateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error('private file must be a regular file');
  if (process.platform === 'win32') windowsAcl(path, 'check');
  else if ((stat.mode & 0o777) !== 0o600) throw new Error('private file must have mode 0600');
}
