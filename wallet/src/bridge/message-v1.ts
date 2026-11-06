// EVM-only reader for the CCIP 2.0 MessageV1 wire format.
// Format: https://github.com/smartcontractkit/chainlink-ccip/blob/main/chains/evm/contracts/libraries/MessageV1Codec.sol
import { slice, size, type Hex } from 'viem';

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Hex) {}
  read(length: number): Hex {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > size(this.bytes))
      throw new Error('invalid CCIP message length');
    if (length === 0) return '0x';
    const result = slice(this.bytes, this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  uint(length: number): bigint {
    return BigInt(this.read(length));
  }
  variable(lengthBytes: number): Hex {
    return this.read(Number(this.uint(lengthBytes)));
  }
  address(emptyAllowed = false): Hex {
    const raw = this.variable(1);
    if (emptyAllowed && raw === '0x') return raw;
    if (size(raw) === 20) return raw;
    if (size(raw) === 32 && /^0x0{24}/i.test(raw)) return slice(raw, 12);
    throw new Error('invalid CCIP EVM address');
  }
  end(): void {
    if (this.offset !== size(this.bytes)) throw new Error('trailing CCIP message bytes');
  }
}

/** Rejects unknown versions, truncation and trailing data. No guessed field offsets beyond the versioned format. */
export function decodeTokenMessage(encoded: Hex) {
  const r = new Reader(encoded);
  if (r.uint(1) !== 1n) throw new Error('unsupported CCIP message encoding');
  const sourceSelector = r.uint(8);
  const destSelector = r.uint(8);
  const messageNumber = r.uint(8);
  r.read(4); // execution gas limit
  const receiveGasLimit = r.uint(4);
  const finality = r.uint(4);
  r.read(32); // verifier/executor hash
  const onRamp = r.address();
  const offRamp = r.address();
  const sender = r.address();
  const receiver = r.address();
  r.variable(2); // destination-specific verification data
  const t = new Reader(r.variable(2));
  if (t.uint(1) !== 1n) throw new Error('unsupported CCIP token encoding');
  const amount = t.uint(32);
  const sourcePool = t.address();
  const sourceToken = t.address();
  const destToken = t.address();
  const tokenReceiver = t.address(true);
  t.variable(2); // token-pool data
  t.end();
  const data = r.variable(2);
  r.end();
  return {
    sourceSelector,
    destSelector,
    messageNumber,
    receiveGasLimit,
    finality,
    onRamp,
    offRamp,
    sender,
    receiver,
    amount,
    sourcePool,
    sourceToken,
    destToken,
    tokenReceiver,
    data,
  };
}
