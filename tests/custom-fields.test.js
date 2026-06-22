#!/usr/bin/env node

// Unit tests for the config-driven custom-fields loader (#2 — extended to
// opportunities). Style follows tests/metadata-orphaned.test.js.

import {
  loadCustomFields,
  customFieldsZodShape,
  pickCustomFieldValues,
  customFieldsGraphQLFragment,
  renderCustomFieldLines,
} from '../dist/config/custom-fields.js';

let passed = 0;
let failed = 0;

function assert(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ---------------------------------------------------------------------------
console.log('loadCustomFields — per-object env keys');

// company + opportunity read distinct env vars
{
  process.env.CUSTOM_COMPANY_FIELDS = JSON.stringify([{ name: 'renewalDate', type: 'string' }]);
  process.env.CUSTOM_OPPORTUNITY_FIELDS = JSON.stringify([
    { name: 'isStrategic', type: 'boolean', description: 'Strategic flag' },
    { name: 'forecastCategory', type: 'string' },
  ]);

  const co = loadCustomFields('company');
  const opp = loadCustomFields('opportunity');

  assert('company reads CUSTOM_COMPANY_FIELDS', co.length === 1 && co[0].name === 'renewalDate');
  assert('opportunity reads CUSTOM_OPPORTUNITY_FIELDS', opp.length === 2 && opp[0].name === 'isStrategic');
  assert('opportunity types preserved', opp[0].type === 'boolean' && opp[1].type === 'string');

  delete process.env.CUSTOM_COMPANY_FIELDS;
  delete process.env.CUSTOM_OPPORTUNITY_FIELDS;
}

// unset -> empty (clean default; no custom fields registered)
{
  delete process.env.CUSTOM_OPPORTUNITY_FIELDS;
  delete process.env.CUSTOM_FIELDS_FILE;
  assert('unset opportunity env -> []', loadCustomFields('opportunity').length === 0);
}

// invalid JSON shape -> throws (fail loud, don't silently drop config)
{
  process.env.CUSTOM_OPPORTUNITY_FIELDS = JSON.stringify([{ name: '', type: 'string' }]);
  let threw = false;
  try { loadCustomFields('opportunity'); } catch { threw = true; }
  assert('invalid field def throws', threw);
  delete process.env.CUSTOM_OPPORTUNITY_FIELDS;
}

// ---------------------------------------------------------------------------
console.log('\ncustomFieldsZodShape — builds optional typed schema');
{
  const shape = customFieldsZodShape([
    { name: 'seatCount', type: 'number' },
    { name: 'isStrategic', type: 'boolean' },
    { name: 'notes', type: 'string' },
  ]);
  assert('shape has all 3 keys', ['seatCount', 'isStrategic', 'notes'].every(k => k in shape));
  // every entry is optional (parsing an empty object succeeds)
  const z = shape.seatCount;
  assert('fields are optional', z.isOptional?.() === true || z._def?.typeName === 'ZodOptional');
}

// ---------------------------------------------------------------------------
console.log('\npickCustomFieldValues — allowlist, no leakage');
{
  const fields = [{ name: 'isStrategic', type: 'boolean' }, { name: 'forecastCategory', type: 'string' }];
  const input = {
    name: 'Big Deal',
    isStrategic: true,
    forecastCategory: 'commit',
    maliciousField: 'should not pass',  // not declared -> must be dropped
    stage: 'PROPOSAL',
  };
  const picked = pickCustomFieldValues(fields, input);
  assert('declared custom fields pass through', picked.isStrategic === true && picked.forecastCategory === 'commit');
  assert('undeclared keys are NOT included (allowlist)', !('maliciousField' in picked) && !('stage' in picked) && !('name' in picked));
  assert('only the 2 declared keys present', Object.keys(picked).length === 2);
}

// absent values are omitted (not set to undefined)
{
  const fields = [{ name: 'isStrategic', type: 'boolean' }];
  const picked = pickCustomFieldValues(fields, { name: 'x' });  // isStrategic not provided
  assert('absent custom field omitted entirely', !('isStrategic' in picked) && Object.keys(picked).length === 0);
}

// ---------------------------------------------------------------------------
console.log('\ncustomFieldsGraphQLFragment — read selection set');
{
  const fields = [
    { name: 'isStrategic', type: 'boolean' },
    { name: 'forecastCategory', type: 'string' },
  ];
  const frag = customFieldsGraphQLFragment(fields);
  assert('fragment lists each declared field name', frag.includes('isStrategic') && frag.includes('forecastCategory'));
  assert('fragment is newline-joined', frag === 'isStrategic\nforecastCategory');
  assert('empty fields -> empty fragment', customFieldsGraphQLFragment([]) === '');
}

// ---------------------------------------------------------------------------
console.log('\nrenderCustomFieldLines — single-record read output');
{
  const fields = [
    { name: 'isStrategic', type: 'boolean', description: 'Strategic flag' },
    { name: 'forecastCategory', type: 'string' },
    { name: 'seatCount', type: 'number' },
  ];
  const record = { isStrategic: true, forecastCategory: null, seatCount: 0 };
  const lines = renderCustomFieldLines(fields, record);

  assert('one line per declared field', lines.length === 3);
  assert('uses description as label when present', lines[0] === 'Strategic flag: true');
  assert('falls back to field name as label', lines[1].startsWith('forecastCategory:'));
  assert('null value renders Not specified', lines[1] === 'forecastCategory: Not specified');
  // 0 is a real value, not "empty" — must not be swallowed
  assert('zero is rendered, not treated as empty', lines[2] === 'seatCount: 0');
  assert('empty fields -> no lines', renderCustomFieldLines([], record).length === 0);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
