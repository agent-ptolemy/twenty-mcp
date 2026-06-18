#!/usr/bin/env node

import { serializeRichText } from '../dist/client/twenty-client.js';

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

console.log('serializeRichText');

const undef = serializeRichText(undefined);
assert('undefined input returns undefined', undef === undefined);

const empty = serializeRichText('');
assert('empty string returns object with empty markdown', empty?.markdown === '');
assert('empty string returns blocknote with one empty paragraph', empty?.blocknote && JSON.parse(empty.blocknote).length === 1);

const single = serializeRichText('hello world');
assert('single-line markdown is the input', single?.markdown === 'hello world');
const singleBlocks = JSON.parse(single.blocknote);
assert('single-line blocknote has one paragraph', singleBlocks.length === 1);
assert('single-line block type is paragraph', singleBlocks[0].type === 'paragraph');
assert('single-line content is the text', singleBlocks[0].content[0]?.text === 'hello world');
assert('single-line content has empty styles', JSON.stringify(singleBlocks[0].content[0]?.styles) === '{}');

const multi = serializeRichText('first paragraph\n\nsecond paragraph');
assert('multi-paragraph markdown preserves input', multi?.markdown === 'first paragraph\n\nsecond paragraph');
const multiBlocks = JSON.parse(multi.blocknote);
assert('multi-paragraph splits into two blocks', multiBlocks.length === 2);
assert('first block content matches', multiBlocks[0].content[0]?.text === 'first paragraph');
assert('second block content matches', multiBlocks[1].content[0]?.text === 'second paragraph');

const props = JSON.parse(serializeRichText('x').blocknote)[0].props;
assert('paragraph has textColor=default', props.textColor === 'default');
assert('paragraph has backgroundColor=default', props.backgroundColor === 'default');
assert('paragraph has textAlignment=left', props.textAlignment === 'left');

const withId = JSON.parse(serializeRichText('block id check').blocknote)[0];
assert('block has id field', typeof withId.id === 'string' && withId.id.length === 10);
assert('block id is alphanumeric', /^[a-z0-9]{10}$/.test(withId.id));

const twoBlocks = JSON.parse(serializeRichText('a\n\nb').blocknote);
assert('multi-paragraph blocks have unique ids', twoBlocks[0].id !== twoBlocks[1].id);

const out = serializeRichText('shape check');
assert('output has only blocknote and markdown keys', Object.keys(out).sort().join(',') === 'blocknote,markdown');
assert('blocknote is a string', typeof out.blocknote === 'string');
assert('markdown is a string', typeof out.markdown === 'string');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
