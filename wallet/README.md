# Flex wallet

The execution layer: it receives the agent's hand-off envelope, checks it, and will sign and send what the user approves.

**Current state:** only the envelope checks exist. Nothing signs or sends yet. See
[the implementation plan](../docs/wallet/IMPLEMENTATION_PLAN.md).

## Commands

Run these in this folder. It's a separate package with its own lockfile, on Node 22 or later.

```sh
npm install
npm test
npm run typecheck
```

ESLint and Prettier run from the repo root: `npm run lint`.

## Layout

| Path | Holds |
| --- | --- |
| `src/schemas/handoff-envelope.schema.json` | The envelope: the contract between agent and wallet |
| `src/schemas/envelope.ts` | Envelope types, and the first check (JSON schema) |
| `src/schemas/intent.v2.ts`, `bridge.v2.ts` | The verified schemas, from the lab tests: the rules between fields |
| `src/mapping/to-plan.ts` | Turns an envelope into the verified plan |
| `src/mapping/check.ts` | `checkEnvelope`: runs all the checks. This is the entry point |
| `src/chain/redeem.v2.ts` | Encodes a payment batch and a delegation redeem |
| `test/unit/` | Unit tests |

## How an envelope is checked

| Stage | What it checks | Example failure |
| --- | --- | --- |
| `schema` | Shape, formats and size limits | A missing field, or 51 recipients on a `k` |
| `consistency` | Fields in the envelope agree with each other | `base_units` doesn't match `value` |
| `plan` | Payment rules, after mapping to the verified plan | A bridge landing on the wrong chain |

Rejection messages contain no amounts or addresses, because the agent shows them to the user.
