'use strict';

var assert = require('node:assert/strict');
var appLogic = require('../app.js');
var layout = appLogic.CardLayoutLogic;
var colorPrefs = appLogic.SeriesColorPreferenceLogic;
var latestCards = appLogic.LatestCardLogic;
var dateRanges = appLogic.DateRangeLogic;

assert.equal(appLogic.isGap({ origDate: '2025-01-01' }, { origDate: '2025-01-02' }), false);
assert.equal(appLogic.isGap({ origDate: '2025-01-01' }, { origDate: '2025-01-03' }), true);
assert.equal(appLogic.isGap({ origDate: '2025-02-28' }, { origDate: '2025-03-01' }), false);
assert.equal(appLogic.isGap({ origDate: '2024-02-28' }, { origDate: '2024-03-01' }), true);
assert.equal(appLogic.isGap({ origDate: '2024-02-29' }, { origDate: '2024-03-01' }), false);
assert.equal(appLogic.isGap({ origDate: '2025-03-08' }, { origDate: '2025-03-10' }), true);
assert.equal(appLogic.isGap(null, {}), false);
assert.equal(appLogic.validatePeriod('06-01', '09-30').valid, true);
assert.equal(appLogic.validatePeriod('02-29', '02-29').valid, true);
assert.equal(appLogic.validatePeriod('02-30', '03-01').valid, false);
assert.equal(appLogic.validatePeriod('04-31', '05-01').valid, false);
assert.equal(appLogic.validatePeriod('13-01', '13-31').valid, false);
assert.equal(appLogic.validatePeriod('09-30', '06-01').valid, false);
assert.equal(appLogic.validatePeriod('', '12-31').valid, false);
var summer = { start: '06-01', end: '09-30' };
assert.equal(appLogic.includesDate('2024-06-01', summer), true);
assert.equal(appLogic.includesDate('2025-09-30', summer), true);
assert.equal(appLogic.includesDate('2026-10-01', summer), false);
assert.equal(appLogic.includesDate('2024-05-31', summer), false);
assert.equal(appLogic.includesDate('2024-01-01', null), true);
var oneDay = appLogic.periodBounds({ start: '02-29', end: '02-29' });
assert.equal(oneDay.start.getFullYear(), 2000);
assert.equal(oneDay.start.getDate(), 29);
assert.equal(oneDay.end - oneDay.start, 86399999);

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

assert.deepEqual(
  latestCards.reading(
    {
      latest_observation: {
        observed_at: '2026-07-22T14:00:00+09:00',
        value: 27.3
      }
    },
    [{ date: '2026-07-22', value: 26.8 }],
    '2026-07-22'
  ),
  {
    value: 27.3,
    fullDate: '2026-07-22 14:00',
    shortDate: '14:00',
    hourly: true
  }
);
assert.deepEqual(
  latestCards.reading({}, [{ date: '2026-07-21', value: 26.8 }], '2026-07-22'),
  {
    value: 26.8,
    fullDate: '2026-07-21',
    shortDate: '7/21',
    hourly: false
  }
);

assert.equal(dateRanges.isIsoDate('2021-04-01'), true);
assert.equal(dateRanges.isIsoDate('2021-02-29'), false);
assert.deepEqual(
  dateRanges.validateCustomRange('2021-04-01', '2022-03-31', '2016-01-01', '2026-09-09'),
  { valid: true, message: '' }
);
assert.equal(
  dateRanges.validateCustomRange('2022-04-01', '2022-03-31').valid,
  false
);
assert.equal(
  dateRanges.validateCustomRange('2015-12-31', '2022-03-31', '2016-01-01', '2026-09-09').valid,
  false
);

console.log('YearlyComparisonLogic / CardLayoutLogic / SeriesColorPreferenceLogic / LatestCardLogic / DateRangeLogic tests OK');
