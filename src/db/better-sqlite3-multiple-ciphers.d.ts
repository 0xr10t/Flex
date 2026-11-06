// Implements: §5 database driver typing. `better-sqlite3-multiple-ciphers` ships an index.d.ts that its package.json
// "exports" map hides under NodeNext resolution; it is API-compatible with better-sqlite3, whose types
// (@types/better-sqlite3) are a dev dependency. Owner: Lane A.

declare module 'better-sqlite3-multiple-ciphers' {
  import Database from 'better-sqlite3';
  export = Database;
}
