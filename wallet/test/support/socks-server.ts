// Copy of the agent's test/fakes/socks-server.ts (the packages share no code). A stand-in for Tor's SOCKS port
// (RFC 1928 + RFC 1929 username/password), for tests. It records every CONNECT (the SOCKS username picks the Tor
// circuit, and the address type shows whether the client resolved DNS itself), maps test hostnames to local servers, and
// refuses everything else. No real network is touched.
import { createServer, connect, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface SocksConnect {
  user: string;
  pass: string;
  /** 'domain' when the client sent a hostname (DNS left to the proxy), 'ipv4' / 'ipv6' when it resolved it itself. */
  atyp: 'domain' | 'ipv4' | 'ipv6';
  host: string;
  port: number;
}

/** Reads exactly `n` bytes from a socket, buffering what arrives early. */
function reader(socket: Socket): (n: number) => Promise<Buffer> {
  let buf = Buffer.alloc(0);
  let waiting: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  const pump = (): void => {
    if (waiting && buf.length >= waiting.n) {
      const out = buf.subarray(0, waiting.n);
      buf = buf.subarray(waiting.n);
      const w = waiting;
      waiting = null;
      w.resolve(out);
    }
  };
  socket.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    pump();
  });
  socket.on('close', () => waiting?.reject(new Error('closed')));
  return (n) =>
    new Promise<Buffer>((resolve, reject) => {
      waiting = { n, resolve, reject };
      pump();
    });
}

export class FakeSocks {
  readonly connects: SocksConnect[] = [];
  /** hostname → local port to dial. */
  readonly hosts = new Map<string, number>();
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;

  /** `socks5h://127.0.0.1:<port>`, as the config takes it. */
  get url(): string {
    return `socks5h://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    this.server = createServer((s) => void this.handle(s));
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  private async handle(client: Socket): Promise<void> {
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => {});
    const read = reader(client);
    try {
      const [ver, nMethods] = await read(2);
      const methods = await read(nMethods as number);
      if (ver !== 5 || !methods.includes(0x02)) {
        client.end(Buffer.from([5, 0xff])); // Tor isolation needs username/password auth
        return;
      }
      client.write(Buffer.from([5, 0x02]));
      const [, ulen] = await read(2);
      const user = (await read(ulen as number)).toString();
      const [plen] = await read(1);
      const pass = (await read(plen as number)).toString();
      client.write(Buffer.from([1, 0]));
      const [, cmd, , atypByte] = await read(4);
      let atyp: SocksConnect['atyp'];
      let host: string;
      if (atypByte === 3) {
        const [len] = await read(1);
        host = (await read(len as number)).toString();
        atyp = 'domain';
      } else if (atypByte === 1) {
        host = [...(await read(4))].join('.');
        atyp = 'ipv4';
      } else {
        host = (await read(16)).toString('hex');
        atyp = 'ipv6';
      }
      const port = (await read(2)).readUInt16BE(0);
      this.connects.push({ user, pass, atyp, host, port });
      const target = atyp === 'domain' ? this.hosts.get(host) : undefined;
      if (cmd !== 1 || target === undefined) {
        client.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); // host unreachable
        return;
      }
      const upstream = connect(target, '127.0.0.1');
      this.sockets.add(upstream);
      upstream.on('close', () => this.sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      upstream.on('connect', () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        client.removeAllListeners('data');
        client.pipe(upstream).pipe(client);
      });
    } catch {
      client.destroy();
    }
  }
}
