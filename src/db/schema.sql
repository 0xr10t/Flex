-- Implements: §7.1 DDL (verbatim). Owned by the Orchestrator; lanes must not edit.
-- DB1: amount placeholders (session-scoped)
CREATE TABLE db1_amount_placeholders (
  placeholder  TEXT PRIMARY KEY CHECK (placeholder GLOB 'amount_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  session_id   TEXT NOT NULL,
  request_id   TEXT NOT NULL,
  amount       TEXT NOT NULL,             -- decimal string, > 0, <= token decimals
  token        TEXT NOT NULL CHECK (token IN ('USDC','ETH')),
  source       TEXT NOT NULL CHECK (source IN ('user','derived','untrusted')),
  origin       TEXT NOT NULL,             -- 'phrase' | 'relative' | 'bridge_padded' | 'autopay_per_period_cap' | 'autopay_total_cap' | 'document'
  confirmed    INTEGER NOT NULL DEFAULT 1 CHECK (confirmed IN (0,1)), -- 0 for untrusted until the user confirms
  created_at   TEXT NOT NULL
);

-- DB2: address book (persistent)
CREATE TABLE db2_address_book (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,               -- as the user typed it
  name_key   TEXT NOT NULL,               -- normalized: trim, lowercase, collapse spaces
  chain_id   INTEGER NOT NULL,
  chain      TEXT NOT NULL,               -- chain display name
  address    TEXT NOT NULL,               -- EIP-55
  ens_name   TEXT,                        -- normalized ENS name if it came from ENS
  added_at   TEXT NOT NULL,
  added_by   TEXT NOT NULL CHECK (added_by = 'user_confirmed'),
  UNIQUE (name_key, chain_id)
);
CREATE INDEX db2_by_address ON db2_address_book(address);
-- Invariant enforced in code (transaction): all rows with the same name_key have the same address,
-- and all rows with the same address have the same name_key.

-- DB3: address placeholders (session-scoped)
CREATE TABLE db3_address_placeholders (
  placeholder         TEXT PRIMARY KEY,   -- 'address_' + 8 hex, or 'group_' + 8 hex
  session_id          TEXT NOT NULL,
  request_id          TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('single','group','member')),
  name                TEXT,               -- contact name / ENS name / subname; NULL never for single
  address             TEXT,               -- EIP-55; NULL for kind='group'
  ens_name            TEXT,
  chain_id            INTEGER,            -- chain the address was confirmed/resolved for; NULL = chain-agnostic EVM address
  group_placeholder   TEXT,               -- for kind='member': the group it belongs to
  source              TEXT NOT NULL CHECK (source IN ('user','contact','ens','untrusted','session')),
  reused_from_chain_id INTEGER,           -- set when address reused silently from another chain's DB2 row
  created_at          TEXT NOT NULL
);

-- DB4: balances (persistent, refreshed every message)
CREATE TABLE db4_balances (
  chain_id    INTEGER NOT NULL,
  chain       TEXT NOT NULL,
  token       TEXT NOT NULL CHECK (token IN ('USDC','ETH')),
  balance     TEXT NOT NULL,              -- decimal string
  base_units  TEXT NOT NULL,              -- integer string
  status      TEXT NOT NULL CHECK (status IN ('ok','unavailable')),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (chain_id, token)
);

-- DB5: agent limits (persistent; written only by the settings API)
CREATE TABLE db5_limits (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                -- JSON
  updated_at TEXT NOT NULL
);

-- DB6: spend log (persistent)
CREATE TABLE db6_spend_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id        TEXT NOT NULL,
  step              INTEGER,               -- intent step; NULL for autopay_payment
  kind              TEXT NOT NULL CHECK (kind IN ('payment','bridge_out','bridge_buffer','autopay_prefund','autopay_payment')),
  counts_toward_limit INTEGER NOT NULL CHECK (counts_toward_limit IN (0,1)),
  chain_id          INTEGER NOT NULL,
  token             TEXT NOT NULL,
  amount            TEXT NOT NULL,
  recipient_address TEXT,
  intent_id         TEXT,                  -- 'i','j','k' or NULL
  autopay_id        TEXT,
  status            TEXT NOT NULL CHECK (status IN ('pending','executed','failed')),
  tx_hash           TEXT,
  created_at        TEXT NOT NULL,
  executed_at       TEXT
);
-- counts_toward_limit = 1 for kind IN ('payment','bridge_buffer','autopay_payment'), else 0.

-- DB7: autopay registry (persistent)
CREATE TABLE db7_autopays (
  autopay_id         TEXT PRIMARY KEY,     -- 'ap_' + 12 hex
  request_id         TEXT NOT NULL,
  recipient_name     TEXT NOT NULL,
  recipient_address  TEXT NOT NULL,
  chain_id           INTEGER NOT NULL,
  token              TEXT NOT NULL,
  amount_per_payment TEXT NOT NULL,
  schedule_json      TEXT NOT NULL,        -- the schedule object of §12.5
  delegate_address   TEXT,
  cre_job_id         TEXT,
  status             TEXT NOT NULL CHECK (status IN ('pending','active','cancelled','ended','failed')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- DB8: session store (session-scoped)
CREATE TABLE db8_sessions (
  session_id TEXT PRIMARY KEY,             -- 'ses_' + 12 hex
  timezone   TEXT NOT NULL,
  opened_at  TEXT NOT NULL
);
CREATE TABLE db8_prompts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('typed','pasted','answer')),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE db8_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL,
  request_id     TEXT NOT NULL,
  payments_json  TEXT NOT NULL,            -- the S8 payments (placeholders only) of a handed-off request
  handed_off_at  TEXT NOT NULL
);
