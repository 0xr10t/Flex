/** A DB2 identity, with all of its network rows grouped together. */
export interface ContactRecord {
  id: number;
  name: string;
  address: string;
  chain_ids: number[];
  ens_name: string | null;
  /** Opaque revision used to reject edits based on an older snapshot. */
  version: string;
}

export interface ContactEdit {
  name: string;
  address: string;
  chain_ids: number[];
  version: string;
}

export interface ContactsPage {
  contacts: ContactRecord[];
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
  networks: Array<{ chain_id: number; name: string }>;
}
