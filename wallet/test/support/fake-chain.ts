// A chain in memory. `hang` makes one call never return, which is what the runner sees if the process dies at that moment:
// the old runner is abandoned, and a new one starts from what was saved.
import { encodeEventTopics, encodeAbiParameters, erc20Abi, keccak256, toHex, type Hex, type Log } from 'viem';
import { UPGRADED_CODE } from '../../src/chain/addresses.js';
import { decodeCall, decodeExecuteBatch } from '../../src/guard/decode.js';
import {
  ChainUnavailableError,
  SimulationUnavailableError,
  WouldFailError,
  type SimBlock,
  type SimCallResult,
  type ChainLog,
  type LogQuery,
  type ChainGateway,
  type SignedTx,
  type TxReceipt,
  type TxRequest,
} from '../../src/chain/gateway.js';

const ETH_TRACE_LOG: Hex = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export const transferLog = (token: Hex, from: Hex, to: Hex, value: bigint): Log =>
  ({
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockNumber: 1n,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: `0x${'22'.repeat(32)}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  }) as Log;

type Call = 'prepareAndSign' | 'broadcast' | 'getReceipt';

export class FakeChain implements ChainGateway {
  code: Hex | undefined = UPGRADED_CODE as Hex;
  signed: SignedTx[] = [];
  broadcasts: Hex[] = [];
  upgrades = 0;
  mined = 0;
  /** Decides the receipt of a mined transaction. Null means it is still waiting. */
  receiptFor: (hash: Hex) => TxReceipt | null = () => ({
    status: 'success',
    logs: [],
    executedAt: '2026-11-06T10:00:05.000Z',
    blockNumber: 1,
  });
  wouldFail = false;
  unavailable: Partial<Record<Call | 'getCode', boolean>> = {};
  hang: Partial<Record<Call, boolean>> = {};
  log: string[] = [];

  private async enter(call: Call): Promise<void> {
    if (this.hang[call]) await new Promise(() => {});
    if (this.unavailable[call]) throw new ChainUnavailableError();
  }

  async getCode(address: Hex): Promise<Hex | undefined> {
    if (this.unavailable.getCode) throw new ChainUnavailableError();
    return address.toLowerCase() === '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b' ? '0x60' : this.code;
  }

  async sendUpgrade(): Promise<void> {
    this.upgrades++;
    this.code = UPGRADED_CODE as Hex;
  }

  async prepareAndSign(tx: TxRequest): Promise<SignedTx> {
    await this.enter('prepareAndSign');
    if (this.wouldFail) throw new WouldFailError();
    const raw = toHex(`${tx.data}/${this.signed.length}`);
    const signed = { raw, hash: keccak256(raw), nonce: this.signed.length };
    this.signed.push(signed);
    this.log.push('sign');
    return signed;
  }

  async broadcast(raw: Hex): Promise<void> {
    if (!this.hang.broadcast) await this.enter('broadcast');
    this.broadcasts.push(raw);
    this.log.push('send');
    if (this.hang.broadcast) await new Promise(() => {});
  }

  private sent(hash: Hex): boolean {
    return this.broadcasts.some((raw) => keccak256(raw) === hash);
  }

  async getReceipt(hash: Hex): Promise<TxReceipt | null> {
    await this.enter('getReceipt');
    return this.sent(hash) ? this.receiptFor(hash) : null;
  }

  async minedNonce(): Promise<number> {
    return this.mined;
  }

  getFinalizedReceipt(hash: Hex): Promise<TxReceipt | null> {
    return this.getReceipt(hash);
  }
  async getTransaction(): Promise<import('../../src/chain/gateway.js').ChainTransaction | null> {
    return null;
  }
  finalizedBlock(): Promise<{ number: number; timestamp: number }> {
    return this.latestBlock();
  }

  async call(): Promise<Hex> {
    return '0x';
  }

  async latestBlock() {
    return { number: 1, timestamp: 1_800_000_000 };
  }

  async blockTime(): Promise<number> {
    return 1_800_000_000;
  }

  async getLogs(_query: LogQuery): Promise<ChainLog[]> {
    return [];
  }

  /** What `eth_simulateV1` does here. By default it reads the batch and logs what it would really move. */
  simulation: 'real' | 'unavailable' | 'fails' | 'moves-nothing' | 'pays-someone-else' = 'real';
  simulated = 0;

  async simulate(blocks: SimBlock[]): Promise<SimCallResult[][]> {
    this.simulated++;
    if (this.simulation === 'unavailable') throw new SimulationUnavailableError();
    return blocks.map((block) =>
      block.calls.map((call) => {
        if (this.simulation === 'fails') return { status: 'failure' as const, logs: [] };
        if (this.simulation === 'moves-nothing') return { status: 'success' as const, logs: [] };
        const logs = (decodeExecuteBatch(call.data) ?? []).map(decodeCall).flatMap((c) => {
          const to =
            this.simulation === 'pays-someone-else' ? ('0x000000000000000000000000000000000000dead' as Hex) : null;
          if (c.kind === 'eth') return [transferLog(ETH_TRACE_LOG, call.from, to ?? c.to, c.value)];
          if (c.kind === 'transfer') return [transferLog(c.token, call.from, to ?? c.to, c.value)];
          return [];
        });
        return { status: 'success' as const, logs };
      }),
    );
  }

  async signTypedData(): Promise<Hex> {
    return '0x';
  }
}
