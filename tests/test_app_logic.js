'use strict';

var assert = require('node:assert/strict');
var appLogic = require('../app.js');
var layout = appLogic.CardLayoutLogic;
var colorPrefs = appLogic.SeriesColorPreferenceLogic;

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

assert.equal(colorPrefs.normalizeColor('#2f8fc2'), '#2F8FC2');
assert.equal(colorPrefs.normalizeColor('#12345'), null);
assert.deepEqual(
  colorPrefs.normalizeMap(
    { a: '#2f8fc2', b: 'invalid', removed: '#D64B55' },
    ['a', 'b']
  ),
  { a: '#2F8FC2' }
);
assert.deepEqual(
  colorPrefs.applyOverrides(
    { a: '#111111', b: '#222222' },
    { a: '#2f8fc2', removed: '#D64B55' }
  ),
  { a: '#2F8FC2', b: '#222222' }
);

var storageValue = null;
var storage = {
  getItem: function () { return storageValue; },
  setItem: function (key, value) { storageValue = value; },
  removeItem: function () { storageValue = null; }
};
colorPrefs.save(storage, { a: '#2F8FC2' });
assert.deepEqual(colorPrefs.load(storage, ['a']), { a: '#2F8FC2' });
colorPrefs.save(storage, {});
assert.equal(storageValue, null);

console.log('CardLayoutLogic / SeriesColorPreferenceLogic tests OK');
