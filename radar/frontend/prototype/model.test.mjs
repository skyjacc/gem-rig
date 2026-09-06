import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, sourceFixtures, evaluateCandidate, filterCandidates, redact, exportReport } from './model.mjs';

const options = { feePercent: 15, extractionCost: 120 };
const item = (overrides = {}) => ({ ...candidates[0], ...overrides });

test('six explicit offline candidate and source fixtures have unique IDs and required fields', () => {
  assert.equal(candidates.length, 6);
  assert.equal(sourceFixtures.length, 6);
  assert.equal(new Set(candidates.map((entry) => entry.id)).size, 6);
  assert.equal(new Set(sourceFixtures.map((entry) => entry.id)).size, 6);
  assert.deepEqual(candidates.map((entry) => entry.name), ['Diffusal Lance', 'Fireborn Odachi', 'Blood Shard', 'Scythe of Twin Deaths', 'Genuine Crown of Gore', 'Eye of Omoz']);
  for (const entry of candidates) {
    for (const field of ['id', 'name', 'hero', 'market', 'gem', 'description']) assert.equal(typeof entry[field], 'string');
    assert.match(entry.description, /Симуляция/);
    assert.match(entry.description, /вымышлен/i);
    assert.ok(['fresh', 'stale', 'unknown'].includes(entry.status));
    assert.ok(['steam', 'market', 'text-only'].includes(entry.evidence));
    assert.ok(entry.price >= 0 && entry.ageMinutes >= 0 && entry.fee >= 0);
    assert.ok(entry.exitPrice === null || typeof entry.exitPrice === 'number');
    assert.ok(entry.extraction === null || typeof entry.extraction === 'number');
  }
  for (const source of sourceFixtures) {
    for (const field of ['id', 'name', 'role', 'coverage', 'detail']) assert.equal(typeof source[field], 'string');
    assert.ok(['ok', 'stale', 'error'].includes(source.status));
    assert.ok(source.ageMinutes >= 0);
  }
});

test('positive estimate uses explicit fee and extraction overrides with investment ROI', () => {
  const result = evaluateCandidate(item({ fee: 99, extraction: null }), options);
  assert.equal(result.net, 156.5);
  assert.equal(result.roi, 26.08);
  assert.equal(result.eligible, true);
  assert.match(result.label, /симуляция/);
  assert.match(result.reasons.join(' '), /вымышлен/);
});

test('negative and break-even estimates never qualify', () => {
  const loss = evaluateCandidate(candidates[4], options);
  assert.equal(loss.net, -133.5);
  assert.equal(loss.eligible, false);
  assert.ok(loss.roi < 0);
  const zero = evaluateCandidate(item({ price: 100, exitPrice: 100 }), { feePercent: 0, extractionCost: 0 });
  assert.equal(zero.net, 0);
  assert.equal(zero.roi, 0);
  assert.equal(zero.eligible, false);
});

test('RUB math uses integer kopecks including half-kopeck rounding', () => {
  const result = evaluateCandidate(item({ price: 0.1, exitPrice: 0.3 }), { feePercent: 0, extractionCost: 0.1 });
  assert.equal(result.net, 0.1);
  assert.equal(result.roi, 50);
  assert.equal(evaluateCandidate(item({ price: 0, exitPrice: 1.005 }), { feePercent: 0, extractionCost: 0.01 }).net, 1);
  assert.equal(evaluateCandidate(item({ price: 0.01, exitPrice: 0.05 }), { feePercent: 10, extractionCost: 0 }).net, 0.04);
});

test('stale and unknown inputs suppress even highly profitable estimates', () => {
  for (const status of ['stale', 'unknown']) {
    const result = evaluateCandidate(item({ status, exitPrice: 100000 }), options);
    assert.equal(result.net, null);
    assert.equal(result.roi, null);
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.length > 0);
  }
});

test('text-only evidence cannot imply an actual kinetic or actionable result', () => {
  const result = evaluateCandidate(candidates[1], options);
  assert.equal(result.eligible, false);
  assert.equal(result.net, null);
  assert.match(result.reasons.join(' '), /тексте/);
  assert.equal(evaluateCandidate(item({ evidence: 'unverified' }), options).net, null);
});

test('missing exit and invalid monetary inputs fail closed', () => {
  for (const exitPrice of [null, undefined, NaN, Infinity, -1, '100']) {
    assert.equal(evaluateCandidate(item({ exitPrice }), options).net, null);
  }
  for (const price of [-1, NaN, Infinity, '10', Number.MAX_VALUE]) {
    assert.equal(evaluateCandidate(item({ price }), options).eligible, false);
  }
  assert.equal(evaluateCandidate(item({ price: 5e13, exitPrice: 6e13 }), { feePercent: 0, extractionCost: 5e13 }).net, null);
});

test('invalid scenario options fail closed and 100 percent fee is a valid loss', () => {
  for (const feePercent of [-1, 101, Infinity, NaN, '15', undefined]) {
    assert.equal(evaluateCandidate(item(), { ...options, feePercent }).net, null);
  }
  for (const extractionCost of [-1, Infinity, NaN, null, '120']) {
    assert.equal(evaluateCandidate(item(), { ...options, extractionCost }).net, null);
  }
  assert.equal(evaluateCandidate(item(), { ...options, feePercent: 100 }).net, -600);
});

test('zero investment does not produce infinite ROI or an eligible result', () => {
  const result = evaluateCandidate(item({ price: 0, exitPrice: 100 }), { feePercent: 0, extractionCost: 0 });
  assert.equal(result.net, 100);
  assert.equal(result.roi, null);
  assert.equal(result.eligible, false);
});

test('query is trimmed and case-insensitive across gem, hero and Russian description', () => {
  assert.deepEqual(filterCandidates(candidates, { query: '  SERENE honor  ' }).map((entry) => entry.id), ['diffusal-lance']);
  assert.deepEqual(filterCandidates(candidates, { query: 'juggernaut' }).map((entry) => entry.id), ['fireborn-odachi']);
  assert.equal(filterCandidates(candidates, { query: 'СИМУЛЯЦИЯ' }).length, 6);
  assert.equal(filterCandidates(candidates, { query: 'not-present' }).length, 0);
});

test('market and state filters compose without mutating fixture order', () => {
  const before = JSON.stringify(candidates);
  assert.notEqual(filterCandidates(candidates), candidates);
  assert.equal(filterCandidates(candidates).length, 6);
  assert.equal(filterCandidates(candidates, { market: 'steam' }).length, 0);
  assert.equal(filterCandidates(candidates, { market: 'Steam', state: 'fresh' }).length, 2);
  assert.deepEqual(filterCandidates(candidates, { state: 'attention' }).map((entry) => entry.id), ['fireborn-odachi', 'blood-shard', 'twin-deaths']);
  assert.equal(filterCandidates(candidates, { query: 'wraith', market: 'Market', state: 'attention' }).length, 1);
  assert.equal(JSON.stringify(candidates), before);
});

test('redaction masks nested secret fields and arrays without changing the input', () => {
  const input = { ordinary: 'visible', apiKey: 'alpha', nested: [{ TOKEN: 'beta', headers: { Authorization: 'Bearer gamma', Cookie: 'session=delta' }, password: 'epsilon', client_secret: 'zeta' }] };
  const before = JSON.stringify(input);
  const result = redact(input);
  assert.equal(result.ordinary, 'visible');
  assert.equal(result.apiKey, '[REDACTED]');
  assert.equal(result.nested[0].TOKEN, '[REDACTED]');
  assert.equal(result.nested[0].headers.Cookie, '[REDACTED]');
  for (const secret of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(JSON.stringify(input), before);
});

test('malicious query encodings, headers, auth schemes and demo sentinels are sanitized', () => {
  const input = 'https://example.invalid/?api%255Fkey=alpha&%74oken=beta&password=%22gamma%20delta%22&view=grid\nAuthorization: Bearer epsilon\nCookie: session=zeta; csrf=eta\nX-Api-Key: theta\nplain Bearer iota; https://user:kappa@example.invalid/ DEMO_SECRET_123';
  const result = redact(input);
  for (const secret of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'SECRET']) assert.ok(!result.includes(secret), `leaked ${secret}`);
  assert.ok(result.includes('view=grid'));
  assert.equal(redact('token="two words"; password=hidden&mode=demo').includes('two words'), false);
  assert.equal(redact('prefix SECRET suffix').includes('SECRET'), false);
});

test('redaction handles cycles, unsupported primitives, getters and prototype-shaped keys', () => {
  const input = JSON.parse('{"__proto__":{"token":"hidden"},"safe":true}');
  input.self = input;
  input.count = 10n;
  input.bad = Infinity;
  Object.defineProperty(input, 'accessor', { enumerable: true, get() { throw new Error('must not execute'); } });
  input.toJSON = () => { throw new Error('must not execute'); };
  const result = redact(input);
  assert.equal(result.self, '[Circular]');
  assert.equal(result.count, '10');
  assert.equal(result.bad, null);
  assert.equal(result.accessor, '[REDACTED]');
  assert.equal(result.__proto__.token, '[REDACTED]');
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.deepEqual(redact([undefined, Symbol('demo'), NaN]), [null, null, null]);
});

test('report is pretty JSON, fixed simulation schema and sanitized context/events', () => {
  const events = [{ type: 'evaluate', message: 'token=SECRET_event', result: evaluateCandidate(candidates[0], options) }];
  const context = { mode: 'live', schemaVersion: 999, headers: { authorization: 'SECRET_auth' }, note: 'SECRET_context', scenario: options };
  const report = exportReport(events, context);
  assert.match(report, /\n  "schemaVersion": 1,/);
  assert.ok(!report.includes('SECRET'));
  const parsed = JSON.parse(report);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.mode, 'simulation');
  assert.equal(parsed.events[0].type, 'evaluate');
  assert.equal(parsed.events[0].result.net, 156.5);
  assert.deepEqual(parsed.context.scenario, options);
  assert.equal(events[0].message, 'token=SECRET_event');
  assert.equal(JSON.parse(exportReport(undefined, undefined)).events, null);
});
