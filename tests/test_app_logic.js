'use strict';

var assert = require('node:assert/strict');
var appLogic = require('../app.js');
var layout = appLogic.CardLayoutLogic;
var colorPrefs = appLogic.SeriesColorPreferenceLogic;
var latestCards = appLogic.LatestCardLogic;
var dateRanges = appLogic.DateRangeLogic;
var comparisonPrefs = appLogic.ComparisonPreferenceLogic;

[false, true].forEach(function (darkMode) {
  var manual = appLogic.measurementMarkerStyle(true, true, darkMode);
  assert.equal(manual.pointRadius, 3.5);
  assert.equal(manual.pointBorderWidth, 1);
  assert.equal(manual.pointBorderColor, darkMode ? '#1b2229' : '#ffffff');
  assert.equal(manual.pointHitRadius, 6);
  assert.equal(appLogic.measurementMarkerStyle(true, false, darkMode).pointRadius, 3.5);
  assert.equal(appLogic.measurementMarkerStyle(false, true, darkMode).pointRadius, 1.5);
  assert.equal(appLogic.measurementMarkerStyle(false, false, darkMode).pointRadius, 0);
});

// 実際の場所比較データセット生成をPC/スマホ双方の設定で検証する。
var vm = require('node:vm');
var source = require('node:fs').readFileSync(require.resolve('../app.js'), 'utf8');
var datasetBuilder = source.slice(source.indexOf('  function buildTimeseriesDataset('), source.indexOf('  // 場所比較モードの「1月始まり」'));
var segmentBuilder = source.slice(source.indexOf('  function yearlySegments('), source.indexOf('  function initYearlyPeriodControls('));
[false, true].forEach(function (narrow) {
  var context = {
    seriesData: { test: { records: [{ date: '2026-11-01', value: 20 }, { date: '2026-11-03', value: 19 }], color: '#123456' } },
    filterByRange: function (records) { return records; },
    parseDate: function (date) { return new Date(date); },
    currentTsPlotStyle: 'standard', narrowScreenMedia: { matches: narrow }, isDarkMode: true,
    measurementMarkerStyle: appLogic.measurementMarkerStyle, YearlyComparisonLogic: appLogic
  };
  vm.createContext(context);
  vm.runInContext(datasetBuilder + segmentBuilder, context);
  var dataset = context.buildTimeseriesDataset({ id: 'test', name: 'test', kind: 'tapwater' }, {});
  assert.equal(dataset.pointRadius, 3.5);
  assert.equal(dataset.borderWidth, narrow ? 1 : 2);
  var segmentContext = { chart: { data: { datasets: [dataset] } }, datasetIndex: 0, p0DataIndex: 0, p1DataIndex: 1 };
  assert.equal(dataset.segment.borderDash(segmentContext).join(','), '3,3');
  assert.equal(dataset.segment.borderWidth(segmentContext), 0.75);
  dataset.data[1].origDate = '2026-11-02';
  assert.equal(dataset.segment.borderDash(segmentContext).length, 0);
  assert.equal(dataset.segment.borderWidth(segmentContext), narrow ? 1 : 2);
  assert.equal(context.buildTimeseriesDataset({ id: 'test', kind: 'river' }, {}).pointRadius, 1.5);
  context.currentTsPlotStyle = 'dots';
  dataset = context.buildTimeseriesDataset({ id: 'test', kind: 'tapwater' }, {});
  assert.equal(dataset.showLine, false);
  assert.equal(dataset.pointRadius, narrow ? 1.5 : 2.5);
  assert.equal(dataset.segment, undefined);
});

var preferenceDefaults = { mode: 'timeseries', seriesId: null, years: null, period: null };
assert.deepEqual(comparisonPrefs.load(null), preferenceDefaults);
assert.deepEqual(comparisonPrefs.normalize({ mode: 'invalid', period: { start: ['06-01'], end: '09-30' } }), preferenceDefaults);
assert.deepEqual(comparisonPrefs.normalize({ period: { start: '09-30', end: '06-01' } }), preferenceDefaults);
assert.deepEqual(comparisonPrefs.normalize({ years: [2024, '2025', 2024, null, 2026, 10000] }).years, [2024, 2026]);
assert.deepEqual(comparisonPrefs.normalize({ years: [] }).years, []);
var prefValue = null;
var prefStorage = {
  getItem: function () { return prefValue; },
  setItem: function (key, value) {
    assert.equal(key, comparisonPrefs.STORAGE_KEY);
    prefValue = value;
  }
};
var savedComparison = { mode: 'yearly', seriesId: 'sea_area138', years: [2023, 2021], period: { start: '06-01', end: '09-30' } };
comparisonPrefs.save(prefStorage, savedComparison);
assert.deepEqual(comparisonPrefs.load(prefStorage), savedComparison);
prefValue = 'invalid json';
assert.deepEqual(comparisonPrefs.load(prefStorage), preferenceDefaults);
prefValue = 'null';
assert.deepEqual(comparisonPrefs.load(prefStorage), preferenceDefaults);
var deniedStorage = {
  getItem: function () { throw new Error('denied'); },
  setItem: function () { throw new Error('denied'); }
};
assert.deepEqual(comparisonPrefs.load(deniedStorage), preferenceDefaults);
assert.doesNotThrow(function () { comparisonPrefs.save(deniedStorage, savedComparison); });

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

console.log('ComparisonPreferenceLogic / YearlyComparisonLogic / CardLayoutLogic / SeriesColorPreferenceLogic / LatestCardLogic / DateRangeLogic tests OK');
