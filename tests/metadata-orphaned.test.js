#!/usr/bin/env node

// Unit tests for the metadata-client bug fixes:
//   #12 — findOrphanedRecords null relation connections + no silent empty-array swallow
//   #14 — listAllObjects metadata pagination (person / note were missing)
//
// Style follows tests/serialize-rich-text.test.js: plain node assertions
// against the compiled dist/ output. GraphQL is mocked by replacing the
// client's GraphQLClient instances with fakes that expose `request()`.

import { TwentyClient } from '../dist/client/twenty-client.js';

let passed = 0;
let failed = 0;

function assert(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function assertThrows(name, fn) {
  try {
    await fn();
    assert(name, false, 'expected an error but none was thrown');
  } catch {
    assert(name, true);
  }
}

// Build a TwentyClient and swap in mock GraphQL clients. `private` fields are
// not enforced at runtime in compiled JS, so direct assignment works.
function makeClient({ dataRequest, metadataRequest } = {}) {
  const client = new TwentyClient({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  if (dataRequest) client.client = { request: dataRequest };
  if (metadataRequest) client.metadataClient = { request: metadataRequest };
  return client;
}

// ---------------------------------------------------------------------------
console.log('findOrphanedRecords (#12)');

// 1. Null relation connections must not throw and must count as 0.
{
  const data = {
    // companies query
    companies: {
      edges: [
        // null people connection -> treated as 0 -> orphaned company
        { node: { id: 'c1', name: 'NullPeople Co', people: null, opportunities: null } },
        // explicit 0 people -> orphaned, with opportunities present
        { node: { id: 'c2', name: 'ZeroPeople Co', people: { totalCount: 0 }, opportunities: { totalCount: 3 } } },
        // has people -> NOT orphaned
        { node: { id: 'c3', name: 'HasPeople Co', people: { totalCount: 2 }, opportunities: { totalCount: 0 } } },
      ],
    },
  };
  const contacts = {
    people: {
      edges: [
        { node: { id: 'p1', name: { firstName: 'Ada', lastName: 'Lovelace' }, companyId: null, opportunities: null } },
        { node: { id: 'p2', name: null, companyId: null, opportunities: { totalCount: 1 } } },
      ],
    },
  };

  let call = 0;
  const client = makeClient({
    dataRequest: async () => (call++ === 0 ? data : contacts),
  });

  const result = await client.findOrphanedRecords();

  assert('does not throw on null connections', true);
  assert('orphaned companies count = 2', result.companies.length === 2, `got ${result.companies.length}`);
  assert('null people connection counted as orphan', result.companies.some(c => c.id === 'c1'));
  assert('null opportunities connection -> opportunityCount 0',
    result.companies.find(c => c.id === 'c1').opportunityCount === 0);
  assert('present opportunities connection preserved',
    result.companies.find(c => c.id === 'c2').opportunityCount === 3);
  assert('company with people excluded', !result.companies.some(c => c.id === 'c3'));

  assert('orphaned contacts count = 2', result.contacts.length === 2);
  assert('null name handled without throwing',
    result.contacts.find(c => c.id === 'p2').name === '');
  assert('null opportunities on contact -> 0',
    result.contacts.find(c => c.id === 'p1').opportunityCount === 0);
}

// 2. A failing query must surface as a thrown error (NOT a silent empty result).
await assertThrows('GraphQL error propagates instead of returning empty arrays', async () => {
  const client = makeClient({
    dataRequest: async () => { throw new Error('GraphQL boom'); },
  });
  await client.findOrphanedRecords();
});

// ---------------------------------------------------------------------------
console.log('\nlistAllObjects pagination (#14)');

// 3. Objects spread across multiple pages must ALL be collected, including
//    person and note which previously fell off the (single) first page.
{
  const page1 = {
    objects: {
      edges: [
        { node: obj('company', false, true, false), cursor: 'a' },
        { node: obj('task', false, true, false), cursor: 'b' },
        { node: obj('opportunity', false, true, false), cursor: 'c' },
      ],
      pageInfo: { hasNextPage: true, endCursor: 'c' },
    },
  };
  const page2 = {
    objects: {
      edges: [
        { node: obj('person', false, true, false), cursor: 'd' },
        { node: obj('note', false, true, false), cursor: 'e' },
        { node: obj('workspaceMember', false, true, true), cursor: 'f' }, // system
        { node: obj('myCustom', true, true, false), cursor: 'g' }, // custom
      ],
      pageInfo: { hasNextPage: false, endCursor: 'g' },
    },
  };

  const requests = [];
  let call = 0;
  const client = makeClient({
    metadataRequest: async (_query, vars) => {
      requests.push(vars);
      return call++ === 0 ? page1 : page2;
    },
  });

  // includeSystem:true so the system bucket is retained for classification checks.
  const summary = await client.listAllObjects({ includeSystem: true });

  assert('paginated through both pages (2 requests)', requests.length === 2, `got ${requests.length}`);
  assert('second request passes the endCursor as after', requests[1]?.after === 'c');
  assert('first request passes a first arg', typeof requests[0]?.first === 'number');
  assert('person collected across pages', summary.standard.some(o => o.nameSingular === 'person'));
  assert('note collected across pages', summary.standard.some(o => o.nameSingular === 'note'));
  assert('standard count includes all 5 non-custom/non-system',
    summary.standard.length === 5, `got ${summary.standard.length} (${summary.standard.map(o => o.nameSingular).join(',')})`);
  assert('custom object classified as custom', summary.custom.some(o => o.nameSingular === 'myCustom'));
  assert('system object classified as system', summary.system.some(o => o.nameSingular === 'workspaceMember'));
}

// 4. Single page (hasNextPage=false) makes exactly one request.
{
  let calls = 0;
  const client = makeClient({
    metadataRequest: async () => {
      calls++;
      return {
        objects: {
          edges: [{ node: obj('company', false, true, false), cursor: 'a' }],
          pageInfo: { hasNextPage: false, endCursor: 'a' },
        },
      };
    },
  });
  const summary = await client.listAllObjects();
  assert('single page => one request', calls === 1, `got ${calls}`);
  assert('single page returns the object', summary.totalCount === 1);
}

// 5. activeOnly filter still excludes inactive objects.
{
  const client = makeClient({
    metadataRequest: async () => ({
      objects: {
        edges: [
          { node: obj('company', false, true, false), cursor: 'a' },
          { node: obj('inactiveThing', false, false, false), cursor: 'b' },
        ],
        pageInfo: { hasNextPage: false, endCursor: 'b' },
      },
    }),
  });
  const summary = await client.listAllObjects({ activeOnly: true });
  assert('inactive object excluded when activeOnly', !summary.standard.some(o => o.nameSingular === 'inactiveThing'));
  assert('active object retained', summary.standard.some(o => o.nameSingular === 'company'));
}

function obj(nameSingular, isCustom, isActive, isSystem) {
  return {
    id: nameSingular,
    nameSingular,
    namePlural: nameSingular + 's',
    labelSingular: nameSingular,
    labelPlural: nameSingular + 's',
    description: '',
    icon: '',
    isCustom,
    isActive,
    isSystem,
    createdAt: '2020-01-01',
    updatedAt: '2020-01-01',
  };
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
