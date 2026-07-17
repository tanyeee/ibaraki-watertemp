'use strict';

var assert = require('node:assert/strict');
var appLogic = require('../app.js');
var layout = appLogic.CardLayoutLogic;

assert.equal(layout.capacity(1), 3);
assert.equal(layout.capacity(2), 6);
assert.equal(layout.capacity(3), 9);
assert.equal(layout.capacity(99), 6);

var defaults = ['a', 'b', 'c', 'd', 'e', 'f'];
var valid = defaults.concat(['g', 'h', 'i']);
assert.deepEqual(layout.defaultLayout(defaults, valid), {
  rows: 2,
  slots: defaults
});

assert.deepEqual(
  layout.normalizeLayout(
    { rows: 3, slots: ['a', null, 'b', 'a', 'unknown', 'c', 'd', 'e', 'f'] },
    defaults,
    valid
  ),
  {
    rows: 3,
    slots: ['a', null, 'b', null, null, 'c', 'd', 'e', 'f']
  }
);

assert.deepEqual(
  layout.selectedIds({ rows: 1, slots: ['a', null, 'c'] }),
  ['a', 'c']
);

assert.deepEqual(
  layout.assignSlot(['a', 'b', 'c'], 0, 'c'),
  ['c', 'b', 'a']
);
assert.deepEqual(
  layout.assignSlot(['a', 'b', 'c'], 1, null),
  ['a', null, 'c']
);

console.log('CardLayoutLogic tests OK');
