// Implements: OQ-04 (provisional): the agent's §18 rule applied to the wallet. Logs hold codes and ids, never amounts,
// addresses, transaction hashes, keys or tokens. The field list is closed so a value can't be logged by accident.

export interface LogFields {
  request_id?: string;
  step?: number;
  chain_id?: number;
  http_status?: number;
  error_code?: string;
  stage?: string;
  attempts?: number;
}

export type Logger = (code: string, fields?: LogFields) => void;

const ALLOWED = ['request_id', 'step', 'chain_id', 'http_status', 'error_code', 'stage', 'attempts'] as const;

export function pickLogFields(fields: LogFields): LogFields {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED) if (fields[key] !== undefined) out[key] = fields[key];
  return out as LogFields;
}

export const stderrLogger: Logger = (code, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), code, ...pickLogFields(fields) })}\n`);
};

export const silentLogger: Logger = () => {};
