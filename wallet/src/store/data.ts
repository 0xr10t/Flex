import { DATA_RESOURCES, dataPage, pickData, type DataQuery, type DataRow } from '@flex/protocol';
import type { Database } from 'better-sqlite3';

const COLUMNS: Record<string, string> = {
  requests:
    "request_id,created_at,finished_at,json_extract(envelope_json,'$.wallet_address') AS wallet_address,json_extract(envelope_json,'$.intents') AS intents_json",
  steps: 'request_id,step,status,tx_hash,nonce,error_code,executed_at,data_json',
  reports: 'id,request_id,step,status,attempts,next_attempt_at,body_json',
  'wallet-autopays':
    'plan_id,request_id,step,autopay_id,chain_id,executor,token,amount,fee,end_at,status,registered_block',
  watchers: 'chain_id,last_block',
  approvals: 'request_id,step,batch_id,chain_id,status,created_ms,tx_hash,payload_json',
};
export function readWalletData(db: Database, resource: string, query: DataQuery) {
  const spec = DATA_RESOURCES.find((s) => s.resource === resource && s.source === 'wallet');
  const columns = COLUMNS[resource];
  if (!spec || !columns) throw new Error('unknown resource');
  const filters = spec.filters.filter((k) => query[k as keyof DataQuery] !== undefined);
  const values = filters.map((k) => query[k as keyof DataQuery]!) as Array<string | number>;
  const where = filters.length ? ' WHERE ' + filters.map((k) => `${k} = ?`).join(' AND ') : '';
  const table = spec.tables[0]!;
  const total = (db.prepare(`SELECT count(*) n FROM ${table}${where}`).get(...values) as { n: number }).n;
  const rows = db
    .prepare(`SELECT ${columns} FROM ${table}${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
    .all(...values, query.limit, query.offset) as DataRow[];
  for (const row of rows) {
    if (typeof row.intents_json === 'string') {
      row.intents = JSON.parse(row.intents_json);
      delete row.intents_json;
    }
    if ('data_json' in row) {
      const data = row.data_json ? JSON.parse(String(row.data_json)) : {};
      row.data = pickData(data, [
        'tracking_status',
        'destination_tx_hash',
        'observed_destination_tx_hash',
        'fee_wei',
        'delayed',
        'dest_scan_next',
        'destination_observe_next',
        'arrive_by_ms',
        'rejected',
      ]);
      if (data.message && typeof data.message === 'object')
        (row.data as DataRow).message = pickData(data.message, [
          'message_id',
          'message_number',
          'source_selector',
          'dest_selector',
          'on_ramp',
          'off_ramp',
          'source_token',
          'dest_token',
          'amount',
          'receiver',
        ]);
      if (data.typedData)
        (row.data as DataRow).delegation_status = data.rejected
          ? 'rejected'
          : data.signature
            ? 'signed'
            : 'awaiting_signature';
      delete row.data_json;
    }
    if ('body_json' in row) {
      const body = JSON.parse(String(row.body_json));
      row.body = pickData(body, ['kind', 'request_id', 'step', 'status', 'tx_hash', 'executed_at', 'bridge_fee_eth']);
      if (body.autopay)
        (row.body as DataRow).autopay = pickData(body.autopay, [
          'autopay_id',
          'plan_id',
          'executor_address',
          'chain_id',
          'token',
          'slot',
          'status',
          'amount',
          'fee',
        ]);
      delete row.body_json;
    }
    if ('payload_json' in row) {
      const payload = JSON.parse(String(row.payload_json));
      row.summary = Array.isArray(payload.summary) ? payload.summary.filter((v: unknown) => typeof v === 'string') : [];
      row.provider_batch_id = payload.providerBatchId ?? null;
      delete row.payload_json;
    }
  }
  return dataPage(spec, query, rows, total);
}
