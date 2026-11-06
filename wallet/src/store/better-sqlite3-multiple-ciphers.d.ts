// The package's "exports" map hides its types under NodeNext. It is API-compatible with better-sqlite3.
declare module 'better-sqlite3-multiple-ciphers' {
  import Database from 'better-sqlite3';
  export = Database;
}
