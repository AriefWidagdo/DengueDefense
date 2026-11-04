const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPayload, validate, validDate, normalize } = require('../app.js');
const qrcode = require('../vendor/qrcode.js');
const fixture = { trap_id: 'vd-001', site: 'TEST SITE — not a field deployment', location: 'North gate, TEST ONLY', deployed_on: '2026-11-01', service_on: '2026-11-08', latitude: '-6.2', longitude: '106.816666', setup: 'Adult card + egg strip', note: 'TEST ONLY', mode: 'details' };

test('bucket ID QR is short, permanent and does not encode mutable details', () => {
  assert.equal(buildPayload({ ...fixture, mode: 'identity' }), 'VD1:TRAP:VD-001');
  assert.equal(buildPayload({ ...fixture, mode: 'identity', site: 'ANOTHER TEST SITE', deployed_on: '2027-01-01', service_on: '' }), 'VD1:TRAP:VD-001');
  assert.equal(normalize({ ...fixture, mode: '' }).mode, 'identity');
});
test('details QR carries the actual container metadata with no website', () => {
  const payload = buildPayload(fixture);
  assert.match(payload, /ID: VD-001/);
  assert.match(payload, /Site: TEST SITE — not a field deployment/);
  assert.match(payload, /Deployed: 2026-11-01/);
  assert.match(payload, /Service due: 2026-11-08/);
  assert.match(payload, /GPS: -6.2, 106.816666/);
  assert.doesNotMatch(payload, /https?:|localhost|127\.0\.0\.1/);
});
test('Maps QR uses coordinates in an HTTPS URL', () => {
  const url = new URL(buildPayload({ ...fixture, mode: 'maps' }));
  assert.equal(url.origin, 'https://www.google.com');
  assert.equal(url.searchParams.get('api'), '1');
  assert.equal(url.searchParams.get('query'), '-6.2,106.816666');
});
test('Maps without GPS uses human location, not an invented coordinate', () => {
  const url = new URL(buildPayload({ ...fixture, mode: 'maps', latitude: '', longitude: '' }));
  assert.equal(url.searchParams.get('query'), `${fixture.location}, ${fixture.site}`);
});
test('reject incomplete IDs, missing fields, unsupported mode and invalid setup', () => {
  for (const change of [{ trap_id: '' }, { trap_id: '../x' }, { site: '' }, { location: '' }, { mode: 'web' }, { setup: '<bad>' }]) assert.notEqual(validate({ ...fixture, ...change }), '');
});
test('reject calendar errors, earlier service dates and invalid GPS', () => {
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2028-02-29'), true);
  for (const change of [{ deployed_on: '2026-02-30' }, { service_on: '2026-10-31' }, { latitude: '91' }, { longitude: '181' }, { latitude: '' }, { latitude: 'NaN' }, { latitude: '0x12' }]) assert.notEqual(validate({ ...fixture, ...change }), '');
});
test('normalize control characters and case without treating metadata as markup', () => {
  const normalized = normalize({ ...fixture, note: 'a\nID: forged\tb' });
  assert.equal(normalized.trap_id, 'VD-001');
  assert.equal(normalized.note, 'a ID: forged b');
  assert.equal(validate(fixture), '');
});
test('vendored QR encoder generates scalable UTF-8 QR with four-module margin', () => {
  qrcode.stringToBytes = text => Array.from(new TextEncoder().encode(text));
  const code = qrcode(0, 'Q');
  code.addData(buildPayload({ ...fixture, site: 'TEST ONLY — 東京' }), 'Byte');
  code.make();
  const svg = code.createSvgTag({ cellSize: 5, margin: 20, scalable: true });
  assert.match(svg, /<svg/);
  assert.match(svg, /viewBox/);
  assert.ok(code.getModuleCount() > 20);
});
