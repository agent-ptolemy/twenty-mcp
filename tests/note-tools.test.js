#!/usr/bin/env node

// Unit tests for P2 note read tools + get_record_url (client layer).
// Style follows tests/metadata-orphaned.test.js.

import { TwentyClient } from '../dist/client/twenty-client.js';

let passed = 0;
let failed = 0;

function assert(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

function makeClient({ dataRequest, baseUrl } = {}) {
  const client = new TwentyClient({ apiKey: 'test', baseUrl: baseUrl || 'https://api.twenty.com' });
  if (dataRequest) client.client = { request: dataRequest };
  return client;
}

// ---------------------------------------------------------------------------
console.log('note read tools');

// getNote returns the note, or null when absent.
{
  const client = makeClient({ dataRequest: async () => ({ note: { id: 'n1', title: 'Hi', bodyV2: { markdown: 'body' } } }) });
  const note = await client.getNote('n1');
  assert('getNote returns the note', note?.id === 'n1');

  const empty = makeClient({ dataRequest: async () => ({ note: null }) });
  assert('getNote returns null when not found', (await empty.getNote('x')) === null);
}

// searchNotes passes an ilike %term% filter and maps results.
{
  let captured;
  const client = makeClient({
    dataRequest: async (q, vars) => { captured = vars; return { notes: { edges: [{ node: { id: 'n1', title: 'Quarterly' } }] } }; },
  });
  const notes = await client.searchNotes('quart', { limit: 5 });
  assert('searchNotes wraps term in %...%', captured.term === '%quart%', `got ${captured?.term}`);
  assert('searchNotes returns mapped notes', notes.length === 1 && notes[0].id === 'n1');
}

// listNotes applies offset/limit client-side.
{
  const edges = [1,2,3,4,5].map(i => ({ node: { id: `n${i}`, title: `N${i}` } }));
  const client = makeClient({ dataRequest: async () => ({ notes: { edges } }) });
  const page = await client.listNotes({ limit: 2, offset: 2 });
  assert('listNotes honours offset+limit', page.length === 2 && page[0].id === 'n3', `got ${page.map(n=>n.id).join(',')}`);
}

// empty/malformed responses don't throw.
{
  const client = makeClient({ dataRequest: async () => ({}) });
  assert('listNotes tolerates empty response', (await client.listNotes()).length === 0);
  assert('searchNotes tolerates empty response', (await client.searchNotes('x')).length === 0);
}

// ---------------------------------------------------------------------------
console.log('\nget_record_url');

// Cloud: api.twenty.com -> twenty.com UI host.
{
  const client = makeClient({ baseUrl: 'https://api.twenty.com' });
  const url = client.getRecordUrl('company', 'abc');
  assert('strips api. prefix for cloud UI host', url === 'https://twenty.com/object/company/abc', `got ${url}`);
}

// Self-hosted without api. prefix: host preserved.
{
  const client = makeClient({ baseUrl: 'https://crm.example.com' });
  const url = client.getRecordUrl('person', 'p1');
  assert('preserves non-api host', url === 'https://crm.example.com/object/person/p1', `got ${url}`);
}

// TWENTY_UI_URL override wins.
{
  process.env.TWENTY_UI_URL = 'https://ui.internal.example/';
  const client = makeClient({ baseUrl: 'https://api.twenty.com' });
  const url = client.getRecordUrl('opportunity', 'o1');
  assert('TWENTY_UI_URL override used (trailing slash trimmed)',
    url === 'https://ui.internal.example/object/opportunity/o1', `got ${url}`);
  delete process.env.TWENTY_UI_URL;
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
