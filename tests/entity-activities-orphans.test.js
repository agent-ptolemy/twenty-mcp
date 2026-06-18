#!/usr/bin/env node

// Contract tests for ISSUE #1:
//   - getEntityActivities must be ENTITY-SCOPED (not the global feed)
//   - findOrphanedRecords must actually check opportunities and tasks
//
// Style follows tests/metadata-orphaned.test.js: plain node assertions against
// the compiled dist/ output, with GraphQL mocked by swapping client.request.

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

function makeClient({ dataRequest } = {}) {
  const client = new TwentyClient({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  if (dataRequest) client.client = { request: dataRequest };
  return client;
}

// ---------------------------------------------------------------------------
console.log('getEntityActivities — entity scoping (#1)');

// 1. Queries must be scoped to the requested entity (filter carries the id),
//    and results come from noteTargets/taskTargets, NOT the global tasks/notes.
{
  const queriesSeen = [];
  const client = makeClient({
    dataRequest: async (query, vars) => {
      queriesSeen.push(query);
      if (query.includes('taskTargets')) {
        return {
          taskTargets: {
            edges: [
              { node: { task: { id: 't1', title: 'Scoped Task', bodyV2: { markdown: 'x' }, assigneeId: 'u1', assignee: { id: 'u1', name: { firstName: 'A', lastName: 'B' } }, createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' } } },
            ],
          },
        };
      }
      return {
        noteTargets: {
          edges: [
            { node: { note: { id: 'n1', title: 'Scoped Note', bodyV2: { markdown: 'y' }, createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' } } },
          ],
        },
      };
    },
  });

  const result = await client.getEntityActivities({ entityId: 'company-123', entityType: 'company', limit: 20, offset: 0 });

  assert('queries noteTargets and taskTargets (not global feed)',
    queriesSeen.some(q => q.includes('noteTargets')) && queriesSeen.some(q => q.includes('taskTargets')));
  assert('scopes by companyId for company entity',
    queriesSeen.every(q => q.includes('companyId')) && queriesSeen.every(q => q.includes('company-123')));
  assert('returns the scoped task', result.activities.some(a => a.id === 't1' && a.type === 'task'));
  assert('returns the scoped note', result.activities.some(a => a.id === 'n1' && a.type === 'note'));
  assert('totalCount reflects scoped set (2)', result.totalCount === 2, `got ${result.totalCount}`);
  assert('sorted newest-first (note 03 before task 02)', result.activities[0].id === 'n1');
}

// 2. Person entity scopes by personId; opportunity by opportunityId.
{
  const seen = [];
  const client = makeClient({
    dataRequest: async (query) => {
      seen.push(query);
      return query.includes('taskTargets')
        ? { taskTargets: { edges: [] } }
        : { noteTargets: { edges: [] } };
    },
  });
  await client.getEntityActivities({ entityId: 'p-9', entityType: 'person' });
  assert('person scopes by personId', seen.every(q => q.includes('personId')));

  seen.length = 0;
  await client.getEntityActivities({ entityId: 'opp-9', entityType: 'opportunity' });
  assert('opportunity scopes by opportunityId', seen.every(q => q.includes('opportunityId')));
}

// 3. De-duplication: same note targeted twice -> counted once.
{
  const client = makeClient({
    dataRequest: async (query) => {
      if (query.includes('taskTargets')) return { taskTargets: { edges: [] } };
      return {
        noteTargets: {
          edges: [
            { node: { note: { id: 'dup', title: 'Dup', bodyV2: { markdown: '' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } } },
            { node: { note: { id: 'dup', title: 'Dup', bodyV2: { markdown: '' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } } },
          ],
        },
      };
    },
  });
  const result = await client.getEntityActivities({ entityId: 'c1', entityType: 'company' });
  assert('duplicate target counted once', result.totalCount === 1, `got ${result.totalCount}`);
}

// 4. Pagination: offset/limit honoured against the combined sorted set.
{
  const client = makeClient({
    dataRequest: async (query) => {
      if (query.includes('taskTargets')) {
        return {
          taskTargets: {
            edges: [1, 2, 3].map(i => ({
              node: { task: { id: `t${i}`, title: `T${i}`, bodyV2: { markdown: '' }, assigneeId: null, assignee: null, createdAt: `2026-0${i}-01T00:00:00Z`, updatedAt: `2026-0${i}-01T00:00:00Z` } },
            })),
          },
        };
      }
      return { noteTargets: { edges: [] } };
    },
  });
  const result = await client.getEntityActivities({ entityId: 'c1', entityType: 'company', limit: 1, offset: 1 });
  assert('limit returns 1 item', result.activities.length === 1, `got ${result.activities.length}`);
  assert('offset skips newest (t3), returns t2', result.activities[0].id === 't2', `got ${result.activities[0]?.id}`);
  assert('hasMore true when more remain', result.hasMore === true);
  assert('totalCount = full scoped set (3)', result.totalCount === 3);
}

// ---------------------------------------------------------------------------
console.log('\nfindOrphanedRecords — opportunities & tasks (#1)');

// 5. Orphaned opportunities (missing company OR contact) and tasks (no assignee)
//    are actually detected, not hardcoded to 0.
{
  const responses = [
    // 1: companies
    { companies: { edges: [{ node: { id: 'c1', name: 'Co', people: { totalCount: 1 }, opportunities: { totalCount: 0 } } }] } },
    // 2: contacts without company
    { people: { edges: [] } },
    // 3: opportunities
    { opportunities: { edges: [
      { node: { id: 'o1', name: 'No company',  companyId: null,  pointOfContactId: 'p1' } },
      { node: { id: 'o2', name: 'No contact',  companyId: 'c1',  pointOfContactId: null } },
      { node: { id: 'o3', name: 'Fully linked',companyId: 'c1',  pointOfContactId: 'p1' } },
    ] } },
    // 4: tasks without assignee
    { tasks: { edges: [
      { node: { id: 't1', title: 'Unassigned', assigneeId: null } },
    ] } },
  ];
  let i = 0;
  const client = makeClient({ dataRequest: async () => responses[i++] });

  const result = await client.findOrphanedRecords();

  assert('orphaned opportunities detected (2 of 3)', result.opportunities.length === 2, `got ${result.opportunities.length}`);
  assert('opp missing company flagged hasCompany=false',
    result.opportunities.find(o => o.id === 'o1')?.hasCompany === false);
  assert('opp missing contact flagged hasContact=false',
    result.opportunities.find(o => o.id === 'o2')?.hasContact === false);
  assert('fully-linked opportunity excluded', !result.opportunities.some(o => o.id === 'o3'));
  assert('orphaned tasks detected (1)', result.tasks.length === 1 && result.tasks[0].id === 't1');
  assert('task hasAssignee=false', result.tasks[0].hasAssignee === false);
}

// 6. Empty opportunities/tasks -> empty arrays, no crash (regression guard).
{
  const responses = [
    { companies: { edges: [] } },
    { people: { edges: [] } },
    { opportunities: { edges: [] } },
    { tasks: { edges: [] } },
  ];
  let i = 0;
  const client = makeClient({ dataRequest: async () => responses[i++] });
  const result = await client.findOrphanedRecords();
  assert('no opportunities -> empty array', Array.isArray(result.opportunities) && result.opportunities.length === 0);
  assert('no tasks -> empty array', Array.isArray(result.tasks) && result.tasks.length === 0);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
