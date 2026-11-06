// Regenerates test/fixtures/llm/<test-id>.json (ORCHESTRATOR_PROMPT §5.4 format) from compact definitions.
// Run: node test/acceptance/build-fixtures.mjs
//
// Payments fixtures name placeholders symbolically ("$amount:N" = N-th entry of the AMOUNTS list in the prompt,
// "$recipient:N" likewise); test/acceptance/harness.ts (AcceptanceLlm) substitutes the real ones, which are random.
// Outputs follow the spec examples: §8.10 for the prompts' own examples, §19 for the worked examples.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '..', 'fixtures', 'llm');
mkdirSync(OUT, { recursive: true });

const amt = (phrase, number, o = {}) => ({
  phrase,
  number,
  relative: o.relative ?? null,
  token: o.token ?? null,
  fiat: o.fiat ?? null,
  role: o.role ?? 'pay',
});
const A = (match, ...items) => ({ name: 'amounts', match, output: { amounts: items.map((i) => amt(...i)) } });
const T = (match, actions, o = {}) => ({
  name: 'request_type',
  match,
  output: { request_type: o.type ?? 'actions', actions, also_balance: o.also ?? false },
});
const S = (match, ...spans) => ({
  name: 'spans',
  match,
  output: { spans: spans.map(([text, kind, role = 'payee']) => ({ text, kind, role })) },
});
const pay = (kind, amount, recipient, chain = 'unstated', x = {}) => ({
  kind,
  amount,
  recipient,
  chain,
  frequency: x.frequency ?? null,
  interval: x.interval ?? null,
  times_per_week: x.times_per_week ?? null,
  days_of_week: x.days_of_week ?? null,
  day_of_month: x.day_of_month ?? null,
});
const P = (match, ...payments) => ({ name: 'payments', match, output: { payments } });
const Q = (match, ...items) => ({
  name: 'quarantine',
  match,
  output: {
    items: items.map((i) => ({
      address: i.address ?? null,
      ens_name: i.ens ?? null,
      amount: i.amount ?? null,
      token: i.token ?? null,
    })),
  },
});
const a0 = '$amount:0';
const a1 = '$amount:1';
const r0 = '$recipient:0';
const r1 = '$recipient:1';
const r2 = '$recipient:2';
const USDC = { token: 'USDC' };
const K = 'ACTION KINDS:'; // always present in the S8 user message

const ADDR = {
  new1: '0x' + '5'.repeat(40),
  aaaa: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111',
  bbbb: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2222',
  wallet: '0x00000000000000000000000000000000000000Aa',
};

const F = {};
const single = (text, amountItem, spans, payment) => [
  A(text, amountItem),
  T('to', ['i']),
  S('to', ...spans),
  P(K, payment),
];
const aradhya50 = (text, chain = 'unstated') =>
  single(text, ['50 usdc', '50', USDC], [['aradhya', 'name']], pay('i', a0, r0, chain));

F['A-01'] = [
  A('Send 50 USDc to ARADHYA', ['50 USDc', '50', USDC]),
  T('to ARADHYA', ['i']),
  S('to ARADHYA', ['ARADHYA', 'name']),
  P(K, pay('i', a0, r0)),
];
const e2 = () => [
  A('Send 50 usdc to ARADHYA on base', ['50 usdc', '50', USDC]),
  T('to ARADHYA on base', ['i']),
  S('to ARADHYA on base', ['ARADHYA', 'name']),
  P(K, pay('i', a0, r0, 84532)),
];
F['A-02'] = e2();
F['A-03'] = [
  A(
    'Send 40 usdc to ARADHYA on base, and 20 usdc to mihir on arbitrum',
    ['40 usdc', '40', USDC],
    ['20 usdc', '20', USDC],
  ),
  T('ARADHYA on base', ['i']),
  S('ARADHYA on base', ['ARADHYA', 'name'], ['mihir', 'name']),
  P(K, pay('i', a0, r0, 84532), pay('i', a1, r1, 421614)),
];
const E4 = 'Send 10 usdc to everyone on the list with @iitr.ac.in subdomain';
F['A-04'] = [
  A(E4, ['10 usdc', '10', USDC]),
  T('everyone on the list', ['i']),
  S('everyone on the list', ['@iitr.ac.in', 'group']),
  P(K, pay('i', a0, r0)),
];
F['A-05'] = F['A-04'];
F['A-06'] = [...e2(), A('Send 5 more', ['5', '5']), T('more', ['i']), S('more'), P(K, pay('i', a0, r0))];
F['A-07'] = [A('send 5 more', ['5', '5']), T('more', ['i']), S('more')];
const mihirK = (text, ex) => [
  A(text, ['10 usdc', '10', USDC]),
  T('mihir', ['k']),
  S('mihir', ['mihir', 'name']),
  P(K, pay('k', a0, r0, 'unstated', ex)),
];
F['A-08'] = mihirK('pay mihir 10 usdc every friday for 8 weeks', {
  frequency: 'weekly',
  interval: 1,
  days_of_week: ['FRI'],
});
F['A-09'] = mihirK('pay mihir 10 usdc every friday', { frequency: 'weekly', interval: 1, days_of_week: ['FRI'] });
F['A-10'] = mihirK('pay mihir 10 usdc 3 times a week until I cancel', {
  frequency: 'weekly',
  interval: 1,
  times_per_week: 3,
});
const stop = [
  A('stop paying mihir'),
  T('stop paying', ['l']),
  S('stop paying', ['mihir', 'name']),
  P(K, pay('l', null, r0)),
];
F['A-11'] = stop;
F['A-12'] = stop;
F['A-13'] = stop;
F['A-14'] = [
  A(
    'Pay Aradhya 50 usdc for the design work she did for my friend Kabir, she charged 500 last time',
    ['50 usdc', '50', USDC],
    ['500', '500', { role: 'context' }],
  ),
  T('design work', ['i']),
  S('design work', ['Aradhya', 'name'], ['Kabir', 'name', 'mentioned']),
  P('for the design work', pay('i', a0, r0)),
];
F['A-15'] = [
  Q('Invoice #42', { address: ADDR.aaaa, amount: '120', token: 'USDC' }, { address: ADDR.bbbb }),
  A('pay this invoice'),
  T('pay this invoice', ['i']),
  S('pay this invoice'),
  P(K, pay('i', a0, r0)),
];
F['A-17'] = [A("what's my balance"), T('balance', [], { type: 'balance' })];
F['A-18'] = [A('swap my eth for usdc'), T('swap', [], { type: 'unsupported' })];
F['A-19'] = [
  A('send 10 usdc to aradhya and swap eth', ['10 usdc', '10', USDC]),
  T('swap', [], { type: 'unsupported' }),
];
const ten = (text, spans) => single(text, ['10 usdc', '10', USDC], spans, pay('i', a0, r0));
F['A-20'] = ten('send 10 usdc to riya', [['riya', 'name']]);
F['A-21'] = ten(`send 10 usdc to ${ADDR.new1}`, [[ADDR.new1, 'address']]);
F['A-22'] = F['A-21'];
F['A-23'] = ten('send 10 usdc to riya.eth', [['riya.eth', 'ens']]);
F['A-24'] = F['A-23'];
F['A-25'] = F['A-20'];
F['A-26'] = aradhya50('send 50 usdc to aradhya on sepolia', 11155111);
F['A-27'] = single('send 150 usdc to mihir', ['150 usdc', '150', USDC], [['mihir', 'name']], pay('i', a0, r0));
F['A-28'] = [
  A(
    'send 100 usdc to aradhya, 100 usdc to mihir and 100 usdc to priya',
    ['100 usdc', '100', USDC],
    ['100 usdc', '100', USDC],
    ['100 usdc', '100', USDC],
  ),
  T('to aradhya', ['i']),
  S('to aradhya', ['aradhya', 'name'], ['mihir', 'name'], ['priya', 'name']),
  P(K, pay('i', a0, r0), pay('i', a1, r1), pay('i', '$amount:2', r2)),
];
F['A-29'] = [
  A('send 100 usdc to everyone under iitr.eth on base', ['100 usdc', '100', USDC]),
  T('everyone under', ['i']),
  S('everyone under', ['iitr.eth', 'group']),
  P(K, pay('i', a0, r0, 84532)),
];
F['A-30'] = single('send 100 usdc to mihir', ['100 usdc', '100', USDC], [['mihir', 'name']], pay('i', a0, r0));
F['A-31'] = aradhya50('send 50 usdc to aradhya on base', 84532);
F['A-32'] = [
  A(
    'send 100 usdc to aradhya on base and 0.05 eth to mihir on base',
    ['100 usdc', '100', USDC],
    ['0.05 eth', '0.05', { token: 'ETH' }],
  ),
  T('to aradhya', ['i']),
  S('to aradhya', ['aradhya', 'name'], ['mihir', 'name']),
  P(K, pay('i', a0, r0, 84532), pay('i', a1, r1, 84532)),
];
F['A-36'] = single(
  'send fifty bucks to mihir',
  ['fifty bucks', '50', { fiat: 'USD' }],
  [['mihir', 'name']],
  pay('i', a0, r0),
);
F['A-37'] = single('send ₹500 to mihir', ['₹500', '500', { fiat: 'OTHER' }], [['mihir', 'name']], pay('i', a0, r0));
F['A-38'] = [
  A('send 10 each to aradhya and mihir', ['10', '10']),
  T('each to', ['i']),
  S('each to', ['aradhya', 'name'], ['mihir', 'name']),
  P(K, pay('i', a0, r0), pay('i', a0, r1)),
];
F['A-39'] = [
  A('split 30 between aradhya and mihir', ['30', '30']),
  T('between', ['i']),
  S('between', ['aradhya', 'name'], ['mihir', 'name']),
];
F['A-40'] = single(
  'send half my eth to mihir',
  ['half my eth', null, { relative: 'half', token: 'ETH' }],
  [['mihir', 'name']],
  pay('i', a0, r0),
);
F['A-41'] = [
  A('send all my usdc to everyone under iitr.eth', ['all my usdc', null, { relative: 'all', token: 'USDC' }]),
  T('everyone under', ['i']),
  S('everyone under', ['iitr.eth', 'group']),
  P(K, pay('i', a0, r0)),
];
F['A-42'] = aradhya50('send 10 usdc to aradhya at 5pm');
F['A-42'][0] = A('send 10 usdc to aradhya at 5pm', ['10 usdc', '10', USDC]);
F['A-43'] = single(
  'send 0.1234567 usdc to mihir',
  ['0.1234567 usdc', '0.1234567', USDC],
  [['mihir', 'name']],
  pay('i', a0, r0),
);
F['A-44'] = ten(`send 10 usdc to ${ADDR.wallet}`, [[ADDR.wallet, 'address']]);
F['A-44-me'] = [A('send 10 usdc to me', ['10 usdc', '10', USDC]), T('to me', ['i']), S('to me', ['me', 'name'])];
for (const id of ['A-47', 'A-49', 'A-51', 'A-52']) F[id] = F['A-01'];
F['A-50'] = [...F['A-01'], A("what's my balance"), T('balance', [], { type: 'balance' })];
F['A-55'] = single('send 10 usdc to mihir', ['10 usdc', '10', USDC], [['mihir', 'name']], pay('i', a0, r0));
F['A-56'] = aradhya50('send 50 usdc to aradhya');
F['A-56-control'] = F['A-56'];
F['A-57'] = [
  A('send 10 usdc and 0.01 eth to mihir', ['10 usdc', '10', USDC], ['0.01 eth', '0.01', { token: 'ETH' }]),
  T('to mihir', ['i']),
  S('to mihir', ['mihir', 'name']),
  P(K, pay('i', a0, r0), pay('i', a1, r0)),
];
F['A-58'] = mihirK('pay mihir 10 usdc every month on the 31st for 3 months', {
  frequency: 'monthly',
  interval: 1,
  day_of_month: 31,
});
F['A-59'] = [
  A('send 40 usdc to aradhya and 20 usdc to mihir', ['40 usdc', '40', USDC], ['20 usdc', '20', USDC]),
  T('to aradhya', ['i']),
  S('to aradhya', ['aradhya', 'name'], ['mihir', 'name']),
  P(K, pay('i', a0, r1), pay('i', a1, r0)),
  P('CORRECTION:', pay('i', a0, r1), pay('i', a1, r0)),
];

for (const [id, calls] of Object.entries(F)) {
  writeFileSync(join(OUT, `${id}.json`), JSON.stringify({ calls }, null, 2) + '\n');
}
// eslint-disable-next-line no-undef
process.stdout.write(`wrote ${Object.keys(F).length} fixtures\n`);
