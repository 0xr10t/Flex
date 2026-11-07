import { DATA_RESOURCES, dataPage, type DataPage, type DataQuery, type DataRow } from '@flex/protocol';
import type { Database } from '../database.js';

const COLUMNS: Record<string, string> = {
  amounts: 'placeholder,session_id,request_id,amount,token,source,origin,confirmed,created_at',
  contacts: 'id,name,name_key,chain_id,chain,address,ens_name,added_at,added_by',
  recipients:
    'placeholder,session_id,request_id,kind,name,address,ens_name,chain_id,group_placeholder,source,reused_from_chain_id,created_at',
  balances:
    "chain_id,chain,token,CASE WHEN status='ok' THEN balance ELSE NULL END AS balance,CASE WHEN status='ok' THEN base_units ELSE NULL END AS base_units,status,updated_at",
  limits: 'key,value,updated_at',
  transactions:
    'id,request_id,step,kind,counts_toward_limit,chain_id,token,amount,recipient_address,intent_id,autopay_id,autopay_slot,status,tx_hash,created_at,executed_at',
  autopays:
    'autopay_id,request_id,recipient_name,recipient_address,chain_id,token,amount_per_payment,schedule_json,delegate_address,cre_job_id,plan_id,executor_address,fee,recipients_json,display_json,status,created_at,updated_at',
  session: 'session_id,timezone,opened_at',
  prompts: 'id,session_id,request_id,kind,text,created_at',
  history: 'id,session_id,request_id,payments_json,handed_off_at',
  handoffs:
    "request_id,status,json_extract(envelope_json,'$.created_at') AS created_at,json_extract(envelope_json,'$.intents') AS intents_json",
};
export function createDataReader(db: Database) {
  return (resource: string, q: DataQuery): DataPage => {
    const spec = DATA_RESOURCES.find((s) => s.resource === resource && s.source === 'agent');
    const cols = COLUMNS[resource];
    if (!spec || !cols) throw new Error('unknown data resource');
    const filters = [...spec.filters, ...(spec.sessionScoped ? ['session_id'] : [])].filter(
      (k) => q[k as keyof DataQuery] !== undefined,
    );
    const where = filters.length ? ' WHERE ' + filters.map((k) => `${k} = ?`).join(' AND ') : '';
    const values = filters.map((k) => q[k as keyof DataQuery]!) as Array<string | number>;
    const table = spec.tables[0]!;
    const total = (db.prepare(`SELECT count(*) n FROM ${table}${where}`).get(...values) as { n: number }).n;
    const rows = db
      .prepare(`SELECT ${cols} FROM ${table}${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(...values, q.limit, q.offset) as DataRow[];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (key.endsWith('_json') || (resource === 'limits' && key === 'value')) {
          const value = row[key];
          if (typeof value === 'string') {
            row[key.replace(/_json$/, '')] = JSON.parse(value);
            if (key.endsWith('_json')) delete row[key];
          }
        }
      }
    }
    return dataPage(spec, q, rows, total);
  };
}
