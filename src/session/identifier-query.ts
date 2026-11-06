// Unknown identifiers never go to a model, explorer or RPC, and are never remembered or echoed.
import { detectSecret, type SecretKind } from '../guard/secrets.js';
import { fromBaseUnits } from '../contracts/money.js';
import { TOKEN_DECIMALS, type Address, type ChainConfig, type ChainId } from '../contracts/types.js';
import type { HistoryReader } from '../history/types.js';

const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const SECRET_TEXT: Record<SecretKind, string> = {
  raw_private_key: 'This is a 32-byte hexadecimal value. That format is shared by private keys, transaction hashes, block hashes and other digests. Its appearance alone cannot tell which it is. Treat it as secret unless you know its source.',
  extended_key: 'This has an extended private-key format. Treat it as secret; a prefix alone does not verify its checksum or validity.',
  wif_key: 'This matches a checksummed Bitcoin WIF private-key encoding. Treat it as secret.',
  solana_secret: 'This decodes to 64 bytes of base58 data. It could be a Solana secret key or a transaction signature; the format alone cannot distinguish them. Treat it as secret unless you know its source.',
  seed_phrase: 'This looks like a recovery phrase. Treat it as secret; this does not establish that its checksum is valid.',
  keystore_json: 'This looks like an encrypted wallet keystore. It contains sensitive key material and should be kept private.',
};

function knownTransaction(value: string, options: { address: Address; chains: readonly ChainConfig[]; history?: HistoryReader }): string | null {
  const valueHash = `0x${value.replace(/^0x/i, '')}`.toLowerCase();
  const lines: string[] = [];
  for (const chain of options.chains) {
    const snapshot = options.history?.snapshot(chain.chain_id as ChainId);
    if (!snapshot || snapshot.address.toLowerCase() !== options.address.toLowerCase() || snapshot.status !== 'ok') continue;
    const transfers = snapshot.transfers.filter((transfer) => transfer.hash.toLowerCase() === valueHash);
    if (!transfers.length) continue;
    const seen = new Set<string>();
    const sums = { ETH: 0n, USDC: 0n };
    for (const transfer of transfers) {
      if (seen.has(transfer.id)) continue;
      seen.add(transfer.id);
      sums[transfer.token] += transfer.units;
    }
    const amounts = (['ETH', 'USDC'] as const).filter((t) => sums[t] > 0n).map((t) => `${fromBaseUnits(sums[t], TOKEN_DECIMALS[t])} ${t}`).join(' and ');
    lines.push(`${chain.name}: the cached account history records ${amounts} received by your account in this transaction.`);
  }
  return lines.length ? `This matches a transaction hash in your cached history.\n${lines.join('\n')}\nThis identifies the recorded transaction; it does not prove finality or rule out someone reusing the same bytes as a key.` : null;
}

/** Only explicit explanation requests. Bare secrets still follow the original S1 refusal. */
export function explainIdentifierQuery(text: string, options: { address: Address; chains: readonly ChainConfig[]; history?: HistoryReader }): string | null {
  if (text.length > 8000) return null;
  const match = text.trim().match(/^(?:(?:can|could) you\s+)?(?:please\s+)?(?:explain|identify|classify|what(?:'s| is)(?: this)?|is this)(?:\s+(?:this|unknown|hash|value|identifier|an?|private|key|transaction|tx|or|something|else))*(?:\s*[:?\-]\s*|\s+)([\s\S]+)$/i);
  if (!match) return null;
  let candidate = match[1]!.trim().replace(/[?!.]+$/, '').trim();
  if (/^`[^`]+`$/.test(candidate) || /^"[^"]+"$/.test(candidate) || /^'[^']+'$/.test(candidate)) candidate = candidate.slice(1, -1).trim();
  // Reject attached instructions, URLs, multiple identifiers and arbitrary prose. A phrase/keystore is recognized below.
  const secret = detectSecret(candidate);
  const single = /^(?:0x)?[0-9a-f]{8,}$/i.test(candidate) ||
    (/^[A-Za-z0-9]{24,}$/.test(candidate) && /[0-9]/.test(candidate)) ||
    (secret !== null && /^[A-Za-z0-9]+$/.test(candidate));
  const structuredSecret = secret === 'seed_phrase' && /^[a-z]+(?:\s+[a-z]+){11,23}$/i.test(candidate) || secret === 'keystore_json' && candidate.startsWith('{') && candidate.endsWith('}');
  if (!single && !structuredSecret) return null;
  const hex = candidate.replace(/^0x/i, '');
  if (/^[0-9a-f]{64}$/i.test(hex)) {
    const known = knownTransaction(candidate, options);
    if (known) return known;
    const scalar = BigInt(`0x${hex}`);
    return `${SECRET_TEXT.raw_private_key}${scalar === 0n || scalar >= SECP256K1_ORDER ? ' This particular value is outside the valid Ethereum private-key range.' : ''} I did not send this value to a model or look it up online.`;
  }
  if (secret) return `${SECRET_TEXT[secret]} I did not send it to a model, save it, or look it up online.`;
  if (/^0x[0-9a-f]{40}$/i.test(candidate)) return 'This has the format of a 20-byte Ethereum/EVM address. The shape alone does not identify its network, owner, or whether it is a contract. It is not a 32-byte transaction hash or Ethereum private key.';
  if (/^(?:0x)?(?:02|03)[0-9a-f]{64}$/i.test(candidate)) return 'This has the format of a 33-byte compressed elliptic-curve public key. Format alone does not verify that the key is valid.';
  if (/^(?:0x)?[0-9a-f]{128,130}$/i.test(candidate) && (hex.length === 128 || hex.length === 130)) return 'This is 64 or 65 bytes of hexadecimal data, a size used by ECDSA signatures (and, for some 65-byte values, uncompressed public keys). Format alone cannot verify a signature, identify a signer, or establish what was signed.';
  if (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0) return `This is ${hex.length / 2} bytes of hexadecimal data. Its format alone does not establish whether it is a hash, key, encoded data, or something else.`;
  return 'I cannot identify this value reliably from its format. Tell me where it came from without sharing a private key or recovery phrase.';
}
