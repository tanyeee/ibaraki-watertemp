/*
 * 茨城 水温比較アプリ (閲覧用フロントエンド)
 * ビルド工程なしの素のJS。Chart.js 4系 + chartjs-adapter-date-fns を使用。
 * config/stations.json から系列一覧を読み込み、各系列のJSON(data/**)をfetchして表示する。
 * 存在しない系列(fetch失敗)は静かにスキップし「データ未取得」として扱う。
 */

// 年比較の状態操作はDOMに依存させず、ブラウザ外でも検証できるようにする。
var YearlyComparisonLogic = (function () {
  'use strict';

  function extractAvailableYears(records) {
    var seen = {};
    (records || []).forEach(function (record) {
      var match = String(record.date || '').match(/^(\d{4})-/);
      if (match) seen[Number(match[1])] = true;
    });
    return Object.keys(seen).map(Number).sort(function (a, b) { return b - a; });
  }

  function defaultYears(availableYears, currentYear) {
    var available = {};
    availableYears.forEach(function (year) { available[year] = true; });
    return [currentYear, currentYear - 1, currentYear - 2].filter(function (year) {
      return available[year];
    });
  }

  function reconcileYears(selectedYears, availableYears) {
    var available = {};
    var seen = {};
    availableYears.forEach(function (year) { available[year] = true; });
    return selectedYears.filter(function (year) {
      if (!available[year] || seen[year]) return false;
      seen[year] = true;
      return true;
    });
  }

  function addYear(selectedYears, year, availableYears) {
    if (availableYears.indexOf(year) === -1 || selectedYears.indexOf(year) !== -1) {
      return selectedYears.slice();
    }
    return selectedYears.concat(year);
  }

  function removeYear(selectedYears, year) {
    return selectedYears.filter(function (selectedYear) { return selectedYear !== year; });
  }

  return {
    extractAvailableYears: extractAvailableYears,
    defaultYears: defaultYears,
    reconcileYears: reconcileYears,
    addYear: addYear,
    removeYear: removeYear
  };
})();

// 表示期間の計算と境界フィルタはDOMに依存させず、Nodeでも検証可能にする。
var DateRangeLogic = (function () {
  'use strict';

  function parseDate(dateStr) {
    var parts = dateStr.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function addMonths(date, amount) {
    var result = new Date(date.getTime());
    var originalDay = result.getDate();
    result.setDate(1);
    result.setMonth(result.getMonth() + amount);
    var lastDay = new Date(
      result.getFullYear(),
      result.getMonth() + 1,
      0
    ).getDate();
    result.setDate(Math.min(originalDay, lastDay));
    return result;
  }

  function filterByRange(records, start, end) {
    if (!start) return records;
    return records.filter(function (record) {
      var date = parseDate(record.date);
      return date >= start && date <= end;
    });
  }

  function getRangeBounds(rangeKey, referenceDate) {
    var end = referenceDate ? new Date(referenceDate.getTime()) : new Date();
    end.setHours(0, 0, 0, 0);
    var monthsByRange = {
      '1m': 1,
      '3m': 3,
      '6m': 6,
      '9m': 9,
      '1y': 12,
      '5y': 60
    };
    if (!monthsByRange[rangeKey]) return { start: null, end: null };
    return { start: addMonths(end, -monthsByRange[rangeKey]), end: end };
  }

  return {
    parseDate: parseDate,
    addMonths: addMonths,
    filterByRange: filterByRange,
    getRangeBounds: getRangeBounds
  };
})();

// 系列のグループ化と選択規則はDOMに依存させず、Nodeでも検証可能にする。
var SeriesSelectionLogic = (function () {
  'use strict';

  var GROUP_ORDER = ['海', '水道水', '霞ヶ浦', '北浦', '利根川'];
  var SELECTED_SERIES_STORAGE_KEY = 'watertemp_selected_series';
  var REPRESENTATIVE_IDS = [
    'sea_area137',
    'tapwater',
    'kasumigaura_koshin',
    'tonegawa_up_upper'
  ];

  function groupSeries(series) {
    var byGroup = {};
    var extraGroups = [];

    (series || []).forEach(function (station) {
      var group = station.group || 'その他';
      if (!byGroup[group]) {
        byGroup[group] = [];
        if (GROUP_ORDER.indexOf(group) === -1) extraGroups.push(group);
      }
      byGroup[group].push(station);
    });

    return GROUP_ORDER.concat(extraGroups).filter(function (group) {
      return byGroup[group] && byGroup[group].length;
    }).map(function (group) {
      return { name: group, series: byGroup[group] };
    });
  }

  function initialSelectedIds(series) {
    var configured = {};
    (series || []).forEach(function (station) { configured[station.id] = true; });
    return REPRESENTATIVE_IDS.filter(function (id) { return configured[id]; });
  }

  // localStorageに保存された選択IDのうち、現在表示可能な系列のみを残す。
  // savedIds が配列でない(未保存/破損)場合は null を返し、呼び出し側で
  // 代表4地点などの既定値にフォールバックできるようにする。
  // savedIds が空配列([])の場合はそのまま空配列を返す(「全て解除」の復元)。
  function restoreSelectedIds(savedIds, visibleStations) {
    if (!Array.isArray(savedIds)) return null;
    var visible = {};
    (visibleStations || []).forEach(function (station) { visible[station.id] = true; });
    return savedIds.filter(function (id) {
      return typeof id === 'string' && visible[id];
    });
  }

  // storage は localStorage 互換オブジェクト(getItem/setItemを持つ)を想定。
  // 未対応環境やアクセス不可(プライベートモード等)では null を返す。
  function loadSelectedSeriesIds(storage) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
      var raw = storage.getItem(SELECTED_SERIES_STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  function saveSelectedSeriesIds(storage, ids) {
    if (!storage || typeof storage.setItem !== 'function') return;
    try {
      storage.setItem(SELECTED_SERIES_STORAGE_KEY, JSON.stringify(ids || []));
    } catch (err) {
      // 保存領域が使えない環境では黙って無視する
    }
  }

  function presetSelectedIds(preset, series) {
    if (preset === 'representative') return initialSelectedIds(series);
    if (preset === 'none') return [];
    return (series || []).filter(function (station) {
      if (preset === 'tonegawa') return station.group === '利根川';
      if (preset === 'lakes') return station.group === '霞ヶ浦' || station.group === '北浦';
      return false;
    }).map(function (station) { return station.id; });
  }

  function isDormantDatasetEnd(datasetEnd, today) {
    var dateMatch = String(datasetEnd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) return false;

    var endTime = Date.UTC(
      Number(dateMatch[1]),
      Number(dateMatch[2]) - 1,
      Number(dateMatch[3])
    );
    var endDate = new Date(endTime);
    if (
      endDate.getUTCFullYear() !== Number(dateMatch[1]) ||
      endDate.getUTCMonth() !== Number(dateMatch[2]) - 1 ||
      endDate.getUTCDate() !== Number(dateMatch[3])
    ) return false;

    var base = today instanceof Date ? today : new Date();
    var todayTime = Date.UTC(base.getFullYear(), base.getMonth(), base.getDate());
    return todayTime - endTime >= 30 * 24 * 60 * 60 * 1000;
  }

  function groupSelectionState(series, selectedIds, availableIds) {
    var selected = {};
    var available = {};
    (selectedIds || []).forEach(function (id) { selected[id] = true; });
    (availableIds || []).forEach(function (id) { available[id] = true; });

    var selectedCount = 0;
    var selectableCount = 0;
    var selectedSelectableCount = 0;
    (series || []).forEach(function (station) {
      if (selected[station.id]) selectedCount += 1;
      if (available[station.id]) {
        selectableCount += 1;
        if (selected[station.id]) selectedSelectableCount += 1;
      }
    });

    return {
      selectedCount: selectedCount,
      totalCount: (series || []).length,
      selectableCount: selectableCount,
      checked: selectableCount > 0 && selectedSelectableCount === selectableCount,
      indeterminate: selectedSelectableCount > 0 && selectedSelectableCount < selectableCount
    };
  }

  return {
    GROUP_ORDER: GROUP_ORDER.slice(),
    REPRESENTATIVE_IDS: REPRESENTATIVE_IDS.slice(),
    SELECTED_SERIES_STORAGE_KEY: SELECTED_SERIES_STORAGE_KEY,
    groupSeries: groupSeries,
    initialSelectedIds: initialSelectedIds,
    presetSelectedIds: presetSelectedIds,
    restoreSelectedIds: restoreSelectedIds,
    loadSelectedSeriesIds: loadSelectedSeriesIds,
    saveSelectedSeriesIds: saveSelectedSeriesIds,
    isDormantDatasetEnd: isDormantDatasetEnd,
    groupSelectionState: groupSelectionState
  };
})();

// 最新値カードの行数・配置はDOMに依存させず、保存値が壊れていても
// 安全な配置へ正規化できるようにする。
var CardLayoutLogic = (function () {
  'use strict';

  var COLUMNS = 3;
  var DEFAULT_ROWS = 2;
  var MIN_ROWS = 1;
  var MAX_ROWS = 3;

  function normalizeRows(value) {
    var rows = Number(value);
    return Number.isInteger(rows) && rows >= MIN_ROWS && rows <= MAX_ROWS
      ? rows
      : DEFAULT_ROWS;
  }

  function capacity(rows) {
    return normalizeRows(rows) * COLUMNS;
  }

  function normalizeSlots(slots, rows, validIds) {
    var allowed = {};
    var seen = {};
    (validIds || []).forEach(function (id) { allowed[id] = true; });
    var source = Array.isArray(slots) ? slots : [];
    var result = [];
    for (var index = 0; index < capacity(rows); index += 1) {
      var id = source[index];
      if (typeof id === 'string' && allowed[id] && !seen[id]) {
        result.push(id);
        seen[id] = true;
      } else {
        result.push(null);
      }
    }
    return result;
  }

  function defaultLayout(defaultIds, validIds) {
    return {
      rows: DEFAULT_ROWS,
      slots: normalizeSlots(defaultIds, DEFAULT_ROWS, validIds)
    };
  }

  function normalizeLayout(saved, defaultIds, validIds) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
      return defaultLayout(defaultIds, validIds);
    }
    var rows = normalizeRows(saved.rows);
    return { rows: rows, slots: normalizeSlots(saved.slots, rows, validIds) };
  }

  function selectedIds(layout) {
    return (layout && Array.isArray(layout.slots) ? layout.slots : []).filter(Boolean);
  }

  function assignSlot(slots, index, nextId) {
    var result = Array.isArray(slots) ? slots.slice() : [];
    var previousId = result[index] || null;
    var normalizedNextId = typeof nextId === 'string' && nextId ? nextId : null;
    var existingIndex = normalizedNextId ? result.indexOf(normalizedNextId) : -1;
    if (existingIndex !== -1 && existingIndex !== index) {
      result[existingIndex] = previousId;
    }
    result[index] = normalizedNextId;
    return result;
  }

  return {
    COLUMNS: COLUMNS,
    DEFAULT_ROWS: DEFAULT_ROWS,
    MIN_ROWS: MIN_ROWS,
    MAX_ROWS: MAX_ROWS,
    normalizeRows: normalizeRows,
    capacity: capacity,
    normalizeSlots: normalizeSlots,
    defaultLayout: defaultLayout,
    normalizeLayout: normalizeLayout,
    selectedIds: selectedIds,
    assignSlot: assignSlot
  };
})();

// 上部カードは時刻付きの最新観測値を優先し、未配信の系列では従来の
// 日次recordsへフォールバックする。グラフ側はrecordsだけを使い続ける。
var LatestCardLogic = (function () {
  'use strict';

  var OBSERVED_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00\+09:00$/;

  function shortDate(dateStr) {
    var parts = String(dateStr).split('-');
    return Number(parts[1]) + '/' + Number(parts[2]);
  }

  function reading(meta, records, todayJst) {
    var latest = meta && meta.latest_observation;
    var observedAt = latest && latest.observed_at;
    var match = typeof observedAt === 'string' ? observedAt.match(OBSERVED_AT_PATTERN) : null;
    if (
      match &&
      typeof latest.value === 'number' &&
      Number.isFinite(latest.value)
    ) {
      var date = match[1] + '-' + match[2] + '-' + match[3];
      var time = match[4] + ':' + match[5];
      return {
        value: latest.value,
        fullDate: date + ' ' + time,
        shortDate: date === todayJst ? time : shortDate(date),
        hourly: true
      };
    }

    var list = Array.isArray(records) ? records : [];
    var last = list.length ? list[list.length - 1] : null;
    if (!last || typeof last.value !== 'number' || !Number.isFinite(last.value)) return null;
    return {
      value: last.value,
      fullDate: last.date,
      shortDate: shortDate(last.date),
      hourly: false
    };
  }

  return { reading: reading };
})();

// 地点比較の色は、設定順に各 group 内のパレットを割り当てる。
// DOMに依存させず、Nodeでもライト/ダーク双方を検証可能にする。
var ColorAssignmentLogic = (function () {
  'use strict';

  var PALETTES = {
    light: {
      '海': ['#0072B2', '#004C80'],
      '水道水': ['#E53935'],
      '霞ヶ浦': ['#009E73', '#4CAF50', '#8BC34A'],
      '北浦': ['#9467BD', '#CC79A7', '#E377C2'],
      '利根川': ['#C97E00', '#F5A623'],
      'その他': ['#0072B2', '#E69F00', '#009E73', '#CC79A7']
    },
    dark: {
      '海': ['#56B4E9', '#3D7EBB'],
      '水道水': ['#FF5252'],
      '霞ヶ浦': ['#4DD0A8', '#81C784', '#AED581'],
      '北浦': ['#B39DDB', '#E88AC5', '#F48FB1'],
      '利根川': ['#E8A93D', '#FFC04D'],
      'その他': ['#56B4E9', '#FFB74D', '#4DD0A8', '#E88AC5']
    }
  };

  function assignColors(list, darkMode) {
    var colorById = {};
    var groupIndexes = {};
    var paletteSet = darkMode ? PALETTES.dark : PALETTES.light;

    (list || []).forEach(function (station) {
      var group = station.group || 'その他';
      var palette = paletteSet[group] || paletteSet['その他'];
      var index = groupIndexes[group] || 0;
      colorById[station.id] = palette[index % palette.length];
      groupIndexes[group] = index + 1;
    });

    return colorById;
  }

  return {
    PALETTES: PALETTES,
    assignColors: assignColors
  };
})();

// 地点ごとのユーザー指定色を安全に正規化し、localStorageへ保存する。
// DOMに依存させず、破損データや廃止地点IDをNodeテストでも検証可能にする。
var SeriesColorPreferenceLogic = (function () {
  'use strict';

  var STORAGE_KEY = 'watertemp_series_colors_v1';
  var HEX_COLOR_PATTERN = /^#[0-9A-F]{6}$/;

  function normalizeColor(value) {
    var color = String(value || '').toUpperCase();
    return HEX_COLOR_PATTERN.test(color) ? color : null;
  }

  function normalizeMap(value, validIds) {
    var normalized = {};
    var allowed = {};
    (validIds || []).forEach(function (id) { allowed[id] = true; });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
    Object.keys(value).forEach(function (id) {
      var color = normalizeColor(value[id]);
      if (allowed[id] && color) normalized[id] = color;
    });
    return normalized;
  }

  function load(storage, validIds) {
    if (!storage) return {};
    try {
      return normalizeMap(JSON.parse(storage.getItem(STORAGE_KEY)), validIds);
    } catch (err) {
      return {};
    }
  }

  function save(storage, colorMap) {
    if (!storage) return;
    try {
      var keys = Object.keys(colorMap || {});
      if (!keys.length && typeof storage.removeItem === 'function') {
        storage.removeItem(STORAGE_KEY);
      } else {
        storage.setItem(STORAGE_KEY, JSON.stringify(colorMap || {}));
      }
    } catch (err) {
      // 保存領域が使えない環境では現在のページ内だけで反映する
    }
  }

  function applyOverrides(defaultColors, customColors) {
    var result = Object.assign({}, defaultColors || {});
    Object.keys(customColors || {}).forEach(function (id) {
      var color = normalizeColor(customColors[id]);
      if (Object.prototype.hasOwnProperty.call(result, id) && color) {
        result[id] = color;
      }
    });
    return result;
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    normalizeColor: normalizeColor,
    normalizeMap: normalizeMap,
    load: load,
    save: save,
    applyOverrides: applyOverrides
  };
})();

// 最新値カードの文字色を系列色から作り、背景とのコントラストを保証する。
// DOMに依存させず、Nodeでも全系列を検証可能にする。
var CardTextColorLogic = (function () {
  'use strict';

  var BACKGROUNDS = {
    light: '#FFFFFF',
    dark: '#1A1F26'
  };
  var MIN_CONTRAST = 4.5;

  function hexToRgb(hex) {
    var value = String(hex).replace('#', '');
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16)
    };
  }

  function rgbToHex(rgb) {
    return '#' + ['r', 'g', 'b'].map(function (key) {
      return Math.round(rgb[key]).toString(16).padStart(2, '0');
    }).join('').toUpperCase();
  }

  function mix(hex, targetHex, amount) {
    var color = hexToRgb(hex);
    var target = hexToRgb(targetHex);
    return rgbToHex({
      r: color.r + (target.r - color.r) * amount,
      g: color.g + (target.g - color.g) * amount,
      b: color.b + (target.b - color.b) * amount
    });
  }

  function relativeLuminance(hex) {
    var rgb = hexToRgb(hex);
    var channels = ['r', 'g', 'b'].map(function (key) {
      var channel = rgb[key] / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function contrastRatio(first, second) {
    var firstLuminance = relativeLuminance(first);
    var secondLuminance = relativeLuminance(second);
    var lighter = Math.max(firstLuminance, secondLuminance);
    var darker = Math.min(firstLuminance, secondLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function readableSeriesColor(seriesColor, darkMode) {
    var background = darkMode ? BACKGROUNDS.dark : BACKGROUNDS.light;
    var target = darkMode ? '#FFFFFF' : '#000000';
    var amount = darkMode ? 0.65 : 0.55;
    var color = mix(seriesColor, target, amount);

    while (contrastRatio(color, background) < MIN_CONTRAST && amount < 1) {
      amount = Math.min(1, amount + 0.05);
      color = mix(seriesColor, target, amount);
    }
    return color;
  }

  return {
    BACKGROUNDS: BACKGROUNDS,
    contrastRatio: contrastRatio,
    readableSeriesColor: readableSeriesColor
  };
})();

// 年比較モードの「平年値バンド」計算(月日ごとの平均・最小・最大 + 移動平均平滑化)。
// DOMに依存させず、Nodeでも実データを使って検証可能にする。
var NormalBandLogic = (function () {
  'use strict';

  var MIN_YEARS_FOR_BAND = 4;
  var SMOOTHING_WINDOW = 7;

  function parseDateParts(dateStr) {
    var parts = String(dateStr).split('-');
    return { year: Number(parts[0]), month: Number(parts[1]), day: Number(parts[2]) };
  }

  // 月日を「2000年(うるう年)基準の通日index」(0〜365)に変換する。
  // 2/29はindex 59として扱え、平年のデータはそのまま月日で対応する日にマップされる。
  function dayOfCommonYear(month, day) {
    var start = Date.UTC(2000, 0, 1);
    var target = Date.UTC(2000, month - 1, day);
    return Math.round((target - start) / 86400000);
  }

  function indexToCommonYearDate(index) {
    return new Date(2000, 0, 1 + index);
  }

  function countYears(records) {
    var years = {};
    (records || []).forEach(function (record) {
      years[Number(String(record.date).slice(0, 4))] = true;
    });
    return Object.keys(years).length;
  }

  // 通日indexごとに、全期間の平均・最小・最大を計算する(index 0〜365の366要素、固定長)。
  function computeMonthDayStats(records) {
    var buckets = {};
    (records || []).forEach(function (record) {
      var parts = parseDateParts(record.date);
      var idx = dayOfCommonYear(parts.month, parts.day);
      if (!buckets[idx]) buckets[idx] = [];
      buckets[idx].push(record.value);
    });

    var result = [];
    for (var idx = 0; idx <= 365; idx++) {
      var values = buckets[idx];
      if (!values || !values.length) {
        result.push({ index: idx, mean: null, min: null, max: null, count: 0 });
        continue;
      }
      var sum = 0;
      var min = values[0];
      var max = values[0];
      values.forEach(function (value) {
        sum += value;
        if (value < min) min = value;
        if (value > max) max = value;
      });
      result.push({
        index: idx,
        mean: sum / values.length,
        min: min,
        max: max,
        count: values.length
      });
    }
    return result;
  }

  // windowSize(既定7日)の移動平均。端は範囲内で利用可能な値のみで平均する。
  // 対象日にデータが存在しない(nullの)日は結果もnullのままにする。
  function movingAverage(stats, field, windowSize) {
    var half = Math.floor((windowSize || SMOOTHING_WINDOW) / 2);
    return stats.map(function (stat, i) {
      if (stat[field] === null || stat[field] === undefined) return null;
      var sum = 0;
      var count = 0;
      for (var offset = -half; offset <= half; offset++) {
        var j = i + offset;
        if (j < 0 || j >= stats.length) continue;
        var value = stats[j][field];
        if (value === null || value === undefined) continue;
        sum += value;
        count += 1;
      }
      return count ? sum / count : null;
    });
  }

  // 平年値バンド(月日ごとの平滑化済み平均・最小・最大)を計算する。
  // 対象年数がMIN_YEARS_FOR_BAND未満の場合はnullを返す。
  function computeBand(records) {
    if (countYears(records) < MIN_YEARS_FOR_BAND) return null;
    var stats = computeMonthDayStats(records);
    var smoothedMean = movingAverage(stats, 'mean', SMOOTHING_WINDOW);
    var smoothedMin = movingAverage(stats, 'min', SMOOTHING_WINDOW);
    var smoothedMax = movingAverage(stats, 'max', SMOOTHING_WINDOW);
    return stats.map(function (stat, i) {
      return {
        x: indexToCommonYearDate(stat.index),
        mean: smoothedMean[i],
        min: smoothedMin[i],
        max: smoothedMax[i]
      };
    });
  }

  return {
    MIN_YEARS_FOR_BAND: MIN_YEARS_FOR_BAND,
    SMOOTHING_WINDOW: SMOOTHING_WINDOW,
    dayOfCommonYear: dayOfCommonYear,
    indexToCommonYearDate: indexToCommonYearDate,
    countYears: countYears,
    computeMonthDayStats: computeMonthDayStats,
    movingAverage: movingAverage,
    computeBand: computeBand
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = YearlyComparisonLogic;
  module.exports.SeriesSelectionLogic = SeriesSelectionLogic;
  module.exports.DateRangeLogic = DateRangeLogic;
  module.exports.ColorAssignmentLogic = ColorAssignmentLogic;
  module.exports.SeriesColorPreferenceLogic = SeriesColorPreferenceLogic;
  module.exports.CardTextColorLogic = CardTextColorLogic;
  module.exports.NormalBandLogic = NormalBandLogic;
  module.exports.CardLayoutLogic = CardLayoutLogic;
  module.exports.LatestCardLogic = LatestCardLogic;
}

(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // 年比較モードでの年別色(選択順。4色目以降も無彩色にはしない)
  var YEARLY_PALETTE_LIGHT = [
    '#D55E00', '#0072B2', '#009E73', '#CC79A7', '#E69F00', '#56B4E9',
    '#6A3D9A', '#A6761D', '#1B9E77', '#E7298A', '#7570B3', '#66A61E'
  ];
  var YEARLY_PALETTE_DARK = [
    '#FF8A65', '#56B4E9', '#4DD0A8', '#E88AC5', '#FFB74D', '#90CAF9',
    '#B39DDB', '#D7A75B', '#65D6B4', '#F48FB1', '#B8AFE8', '#A5D66A'
  ];
  var YEARLY_BG_LIGHT = 'rgba(95, 105, 115, 0.20)';
  var YEARLY_BG_DARK = 'rgba(205, 215, 225, 0.18)';
  // 平年値バンド(範囲の塗り・平均値の線)の配色。テーマに応じて切り替える。
  var NORMAL_BAND_FILL_LIGHT = 'rgba(70, 110, 150, 0.15)';
  var NORMAL_BAND_FILL_DARK = 'rgba(150, 190, 225, 0.16)';
  var NORMAL_BAND_LINE_LIGHT = 'rgba(60, 85, 105, 0.85)';
  var NORMAL_BAND_LINE_DARK = 'rgba(205, 220, 232, 0.85)';
  var NORMAL_BAND_STORAGE_KEY = 'watertemp_yearly_normal_band';

  // ---- アプリ状態 ----
  var stationsConfig = [];         // config/stations.json の series 配列
  var seriesData = {};             // id -> { config, meta, records, color, loaded, error }
  var currentMode = 'timeseries';
  var currentRange = '1y';
  var currentCalendarStartMonth = 0; // 0: 1月 | 3: 4月
  var TS_DISPLAY_MODE_STORAGE_KEY = 'watertemp_ts_display_mode';
  var TS_PLOT_STYLE_STORAGE_KEY = 'watertemp_ts_plot_style';
  var THEME_STORAGE_KEY = 'watertemp_theme';
  var currentTsDisplayMode = 'rolling'; // 'jan-start' | 'rolling'
  var currentTsPlotStyle = 'standard'; // 'standard' | 'dots'
  var TICK_MARK_LENGTH = 6;
  var MINOR_TICK_MARK_LENGTH = 3;
  var showDormantStations = false;
  var tsChart = null;
  var yearlyChart = null;
  var yearlyChartRendered = false;
  var selectedYearlyYears = [];
  var yearlyYearsInitialized = false;
  var darkModeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  var narrowScreenMedia = window.matchMedia('(max-width: 600px)');
  var isDarkMode = darkModeMedia.matches;
  var latestCardResizeFrame = null;
  var customSeriesColors = {};
  var editingSeriesColorId = null;
  var pendingSeriesColor = null;
  var seriesColorDialogTrigger = null;
  var SERIES_COLOR_PRESETS = [
    { name: 'ブルー', color: '#2F8FC2' },
    { name: '濃いブルー', color: '#3B82C4' },
    { name: 'グリーン', color: '#008F72' },
    { name: '明るいグリーン', color: '#3D9C56' },
    { name: 'イエロー', color: '#BA7E00' },
    { name: 'オレンジ', color: '#D66A1F' },
    { name: 'レッド', color: '#D64B55' },
    { name: 'ピンク', color: '#B45C94' },
    { name: 'パープル', color: '#8F6BC0' },
    { name: 'グレー', color: '#6F8190' },
    { name: 'ターコイズ', color: '#00A6A6' },
    { name: 'ブラウン', color: '#A06B35' }
  ];
  var CARDS_EXPANDED_STORAGE_KEY = 'watertemp_cards_expanded';
  // 折りたたみ時に表示する最新値カード(3枚×2行、この順で表示)
  var DEFAULT_FEATURED_CARD_IDS = [
    'sea_area137',
    'sea_area138',
    'tapwater',
    'kasumigaura_koshin',
    'kitaura_jinguubashi',
    'tonegawa_down_upper'
  ];
  var CARD_LAYOUT_STORAGE_KEY = 'watertemp_featured_card_layout_v1';
  var featuredCardLayout = {
    rows: CardLayoutLogic.DEFAULT_ROWS,
    slots: DEFAULT_FEATURED_CARD_IDS.slice()
  };
  var cardsExpanded = false;

  // ---- ユーティリティ ----

  var parseDate = DateRangeLogic.parseDate;
  var filterByRange = DateRangeLogic.filterByRange;
  var getRangeBounds = DateRangeLogic.getRangeBounds;

  // プライベートブラウジング等でlocalStorageへのアクセス自体が例外を
  // 投げる環境があるため、安全に取得できるようラップする。
  function getLocalStorage() {
    try {
      return window.localStorage;
    } catch (err) {
      return null;
    }
  }

  // 最新値カードの展開状態(狭い画面向け)をlocalStorageから復元する。
  function loadCardsExpandedPref() {
    var storage = getLocalStorage();
    if (!storage) return false;
    try {
      return storage.getItem(CARDS_EXPANDED_STORAGE_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function saveCardsExpandedPref(expanded) {
    var storage = getLocalStorage();
    if (!storage) return;
    try {
      storage.setItem(CARDS_EXPANDED_STORAGE_KEY, expanded ? '1' : '0');
    } catch (err) {
      // 保存領域が使えない環境では黙って無視する
    }
  }

  function availableCardIds() {
    return stationsConfig.map(function (station) { return station.id; });
  }

  function loadFeaturedCardLayout() {
    var storage = getLocalStorage();
    var saved = null;
    if (storage) {
      try {
        saved = JSON.parse(storage.getItem(CARD_LAYOUT_STORAGE_KEY));
      } catch (err) {
        saved = null;
      }
    }
    return CardLayoutLogic.normalizeLayout(
      saved,
      DEFAULT_FEATURED_CARD_IDS,
      availableCardIds()
    );
  }

  function saveFeaturedCardLayout(layout) {
    featuredCardLayout = CardLayoutLogic.normalizeLayout(
      layout,
      DEFAULT_FEATURED_CARD_IDS,
      availableCardIds()
    );
    var storage = getLocalStorage();
    if (!storage) return;
    try {
      storage.setItem(CARD_LAYOUT_STORAGE_KEY, JSON.stringify(featuredCardLayout));
    } catch (err) {
      // 保存領域が使えない環境では現在のページ内だけで反映する
    }
  }

  // 場所比較モードの表示形式(1月始まり/直近表示)をlocalStorageから復元する。
  // 未保存/破損時は既定値の「直近表示」を返す。
  function loadTsDisplayModePref() {
    var storage = getLocalStorage();
    if (!storage) return 'rolling';
    try {
      var value = storage.getItem(TS_DISPLAY_MODE_STORAGE_KEY);
      return value === 'jan-start' ? 'jan-start' : 'rolling';
    } catch (err) {
      return 'rolling';
    }
  }

  function saveTsDisplayModePref(mode) {
    var storage = getLocalStorage();
    if (!storage) return;
    try {
      storage.setItem(TS_DISPLAY_MODE_STORAGE_KEY, mode);
    } catch (err) {
      // 保存領域が使えない環境では黙って無視する
    }
  }

  // 場所比較モードの描画スタイル。未保存/破損時は線+ドットを既定とする。
  function loadTsPlotStylePref() {
    var storage = getLocalStorage();
    if (!storage) return 'standard';
    try {
      return storage.getItem(TS_PLOT_STYLE_STORAGE_KEY) === 'dots' ? 'dots' : 'standard';
    } catch (err) {
      return 'standard';
    }
  }

  function saveTsPlotStylePref(style) {
    var storage = getLocalStorage();
    if (!storage) return;
    try {
      storage.setItem(TS_PLOT_STYLE_STORAGE_KEY, style);
    } catch (err) {
      // 保存領域が使えない環境では黙って無視する
    }
  }

  function formatDateJP(date) {
    var y = date.getFullYear();
    var m = date.getMonth() + 1;
    var d = date.getDate();
    return y + '/' + m + '/' + d;
  }

  // "YYYY-MM-DD" 形式の文字列を「M月D日 (YYYY年)」表記にする(年比較モードのツールチップ用)
  function formatMonthDayWithYear(dateStr) {
    var d = parseDate(dateStr);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 (' + d.getFullYear() + '年)';
  }

  // 系列一覧から group ごとのパレットで色を割り当てる
  function assignColors(list) {
    return ColorAssignmentLogic.assignColors(list, isDarkMode);
  }

  function resolvedSeriesColors(list) {
    return SeriesColorPreferenceLogic.applyOverrides(assignColors(list), customSeriesColors);
  }

  function applyResolvedSeriesColors() {
    var colorById = resolvedSeriesColors(stationsConfig);
    stationsConfig.forEach(function (station) {
      if (seriesData[station.id]) {
        seriesData[station.id].color = colorById[station.id];
      }
    });
  }

  function chartTheme() {
    if (isDarkMode) {
      return {
        text: '#dce3ea',
        grid: 'rgba(220, 227, 234, 0.14)',
        tooltipBg: '#252e37',
        tooltipBorder: '#52616f'
      };
    }
    return {
      text: '#4b5560',
      grid: 'rgba(75, 85, 96, 0.14)',
      tooltipBg: '#ffffff',
      tooltipBorder: '#c8d0d7'
    };
  }

  function themedScale(scale) {
    var theme = chartTheme();
    scale.ticks = scale.ticks || {};
    scale.ticks.color = theme.text;
    // 目盛り線(tick mark)はプラグイン側で内向きに描画するため、
    // Chart.js標準の外向きtickは非表示にする(薄いグリッド線自体は維持)。
    scale.grid = { color: theme.grid, drawTicks: false };
    scale.border = { color: theme.grid };
    if (scale.title) {
      scale.title.color = theme.text;
    }
    return scale;
  }

  // X軸(下)・Y軸(左)の主目盛りを内向きに描画する。
  // X軸にはラベルのない月の副目盛りを追加し、右端は目盛りなしの軸線で閉じる。
  var inwardTicksPlugin = {
    id: 'inwardTicks',
    afterDraw: function (chart) {
      var ctx = chart.ctx;
      var area = chart.chartArea;
      var theme = chartTheme();
      var xScale = chart.scales.x;
      var yScale = chart.scales.y;

      // 薄いグリッド線と重なって見分けが付かなくなるのを避けるため、
      // 目盛り線自体は軸の境界線と同じ、はっきりした色で描く。
      ctx.save();
      ctx.strokeStyle = theme.tooltipBorder;
      ctx.lineWidth = 1;

      if (xScale && xScale.position === 'bottom') {
        var majorMonths = {};
        (xScale.ticks || []).forEach(function (tick) {
          var tickDate = new Date(tick.value);
          majorMonths[tickDate.getFullYear() + '-' + tickDate.getMonth()] = true;
          var xPixel = xScale.getPixelForValue(tick.value);
          if (xPixel < area.left - 0.5 || xPixel > area.right + 0.5) return;
          ctx.beginPath();
          ctx.moveTo(xPixel, area.bottom);
          ctx.lineTo(xPixel, area.bottom - TICK_MARK_LENGTH);
          ctx.stroke();
        });

        // afterBuildTicksでラベル対象を2ヶ月ごとに絞っているため、
        // その間の月初を短い副目盛りとして補う。
        var firstVisible = new Date(xScale.min);
        var monthCursor = new Date(firstVisible.getFullYear(), firstVisible.getMonth(), 1);
        if (monthCursor.getTime() < xScale.min) {
          monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
        }
        while (monthCursor.getTime() <= xScale.max) {
          var monthKey = monthCursor.getFullYear() + '-' + monthCursor.getMonth();
          if (!majorMonths[monthKey]) {
            var minorX = xScale.getPixelForValue(monthCursor.getTime());
            if (minorX >= area.left - 0.5 && minorX <= area.right + 0.5) {
              ctx.beginPath();
              ctx.moveTo(minorX, area.bottom);
              ctx.lineTo(minorX, area.bottom - MINOR_TICK_MARK_LENGTH);
              ctx.stroke();
            }
          }
          monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
        }
      }

      if (yScale && yScale.position === 'left') {
        (yScale.ticks || []).forEach(function (tick) {
          var yPixel = yScale.getPixelForValue(tick.value);
          if (yPixel < area.top - 0.5 || yPixel > area.bottom + 0.5) return;
          ctx.beginPath();
          ctx.moveTo(area.left, yPixel);
          ctx.lineTo(area.left + TICK_MARK_LENGTH, yPixel);
          ctx.stroke();
        });
      }

      // 反対側に目盛りやラベルを増やさず、右端の軸線だけを描いて閉じる。
      ctx.beginPath();
      ctx.moveTo(area.right, area.top);
      ctx.lineTo(area.right, area.bottom);
      ctx.stroke();

      ctx.restore();
    }
  };
  Chart.register(inwardTicksPlugin);

  // chartjs-plugin-zoom(CDN読み込み)が利用可能な場合のみズーム/パン機能を有効化する。
  // CDNが使えない/ブロックされている環境では静かにフォールバック(ズームなし)する。
  var zoomPluginRef = (typeof window !== 'undefined')
    ? (window.ChartZoom || window['chartjs-plugin-zoom'] || null)
    : null;
  var zoomPluginAvailable = false;
  if (zoomPluginRef) {
    try {
      Chart.register(zoomPluginRef);
      zoomPluginAvailable = true;
    } catch (err) {
      zoomPluginAvailable = false;
    }
  }

  // 最近傍スナップ(両モード共通): タップ/ホバー時に最も近いX軸上の点にスナップする。
  var NEAREST_INTERACTION = { mode: 'nearest', intersect: false, axis: 'x' };

  function themedPlugins(tooltipCallbacks) {
    var theme = chartTheme();
    var narrow = narrowScreenMedia.matches;
    return {
      legend: {
        display: true,
        position: 'bottom',
        labels: {
          color: theme.text,
          usePointStyle: true,
          boxWidth: narrow ? 8 : 12,
          boxHeight: narrow ? 8 : 12,
          padding: narrow ? 6 : 10,
          font: { size: narrow ? 10 : 12 },
          filter: function (item, data) {
            var dataset = data.datasets[item.datasetIndex];
            return !(dataset && dataset._hideFromLegend);
          }
        }
      },
      tooltip: {
        backgroundColor: theme.tooltipBg,
        titleColor: theme.text,
        bodyColor: theme.text,
        borderColor: theme.tooltipBorder,
        borderWidth: 1,
        callbacks: tooltipCallbacks
      }
    };
  }

  // 場所比較の凡例はcanvas外のHTMLグリッドに描画し、狭い画面でも
  // 名称が重ならないようにする。クリック時の系列表示切替は従来どおり維持する。
  var timeseriesHtmlLegendPlugin = {
    id: 'timeseriesHtmlLegend',
    afterUpdate: function (chart) {
      var container = document.getElementById('chart-timeseries-legend');
      if (!container || chart.canvas.id !== 'chart-timeseries') return;
      container.innerHTML = '';

      var items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
      items.forEach(function (item) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'chart-html-legend-item';
        button.classList.toggle('is-hidden', !!item.hidden);
        button.setAttribute('aria-pressed', String(!item.hidden));
        button.setAttribute('aria-label', item.text + 'の表示を切り替え');

        var marker = document.createElement('span');
        marker.className = 'chart-html-legend-marker';
        marker.style.backgroundColor = String(item.fillStyle || item.strokeStyle || 'transparent');

        var label = document.createElement('span');
        label.className = 'chart-html-legend-label';
        label.textContent = item.text;

        button.appendChild(marker);
        button.appendChild(label);
        button.addEventListener('click', function () {
          chart.setDatasetVisibility(item.datasetIndex, !chart.isDatasetVisible(item.datasetIndex));
          chart.update();
        });
        container.appendChild(button);
      });
      container.hidden = items.length === 0;
    }
  };

  // ---- データ読み込み ----

  function loadStationsConfig() {
    return fetch('config/stations.json')
      .then(function (res) {
        if (!res.ok) {
          throw new Error('config/stations.json の取得に失敗しました (HTTP ' + res.status + ')');
        }
        return res.json();
      })
      .then(function (json) {
        stationsConfig = (json.series || []).filter(function (s) { return !s.hidden; });
        return stationsConfig;
      });
  }

  function loadSeriesJson(station) {
    return fetch(station.path)
      .then(function (res) {
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }
        return res.json();
      })
      .then(function (json) {
        var records = (json.records || []).slice().sort(function (a, b) {
          return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
        });
        seriesData[station.id] = {
          config: station,
          meta: json.meta || {},
          records: records,
          loaded: records.length > 0,
          dormant: SeriesSelectionLogic.isDormantDatasetEnd(
            json.meta && json.meta.dataset_end
          ),
          error: false
        };
      })
      .catch(function () {
        // 存在しない系列(準備中データ等)は静かにスキップして「データ未取得」扱い
        seriesData[station.id] = {
          config: station,
          meta: {},
          records: [],
          loaded: false,
          dormant: false,
          error: true
        };
      });
  }

  function loadAllData() {
    return loadStationsConfig().then(function (list) {
      customSeriesColors = SeriesColorPreferenceLogic.load(
        getLocalStorage(),
        list.map(function (station) { return station.id; })
      );
      var colorById = resolvedSeriesColors(list);
      var tasks = list.map(function (station) {
        return loadSeriesJson(station).then(function () {
          seriesData[station.id].color = colorById[station.id];
        });
      });
      return Promise.all(tasks);
    });
  }

  // ---- ヘッダ: 最新値カード ----

  function primaryVisibleStations() {
    return stationsConfig.filter(function (station) {
      var entry = seriesData[station.id];
      return showDormantStations || !(entry && entry.dormant);
    });
  }

  // 折りたたみ時に表示するカード。null は空き枠として位置を維持する。
  function featuredSlotStations() {
    var stationById = {};
    stationsConfig.forEach(function (station) { stationById[station.id] = station; });
    return featuredCardLayout.slots.map(function (id) {
      return id ? stationById[id] || null : null;
    });
  }

  function buildLatestCardElement(station) {
    var entry = seriesData[station.id];
    var latestReading = entry
      ? LatestCardLogic.reading(entry.meta, entry.records, currentJapanDate())
      : null;
    var card = document.createElement('div');
    var cardTextColor = entry && entry.color
      ? CardTextColorLogic.readableSeriesColor(entry.color, isDarkMode)
      : '';

    if (latestReading) {
      card.className = 'latest-card';
      card.style.borderLeftColor = entry.color;
      card.innerHTML =
        '<span class="card-name">' + escapeHtml(station.name) + '</span>' +
        '<span class="card-reading">' +
          '<span class="card-value">' + latestReading.value.toFixed(1) + '°C</span>' +
          '<span class="card-date card-date-full">' +
            escapeHtml(latestReading.fullDate) + '</span>' +
          '<span class="card-date card-date-short" title="' +
            escapeHtml(latestReading.fullDate) + '">' +
            escapeHtml(latestReading.shortDate) + '</span>' +
        '</span>';
    } else {
      card.className = 'latest-card no-data';
      card.innerHTML =
        '<span class="card-name">' + escapeHtml(station.name) + '</span>' +
        '<span>データ未取得</span>';
    }
    card.querySelector('.card-name').style.color = cardTextColor;
    var cardValue = card.querySelector('.card-value');
    if (cardValue) cardValue.style.color = cardTextColor;
    return card;
  }

  function renderLatestCards() {
    var container = document.getElementById('latest-cards');
    container.innerHTML = '';

    var featuredWrap = document.createElement('div');
    featuredWrap.className = 'latest-cards-featured';
    featuredWrap.dataset.rows = String(featuredCardLayout.rows);
    featuredSlotStations().forEach(function (station) {
      if (station) {
        featuredWrap.appendChild(buildLatestCardElement(station));
      } else {
        var placeholder = document.createElement('div');
        placeholder.className = 'latest-card-placeholder';
        placeholder.setAttribute('aria-hidden', 'true');
        featuredWrap.appendChild(placeholder);
      }
    });

    var groupsWrap = document.createElement('div');
    groupsWrap.className = 'latest-cards-groups';
    SeriesSelectionLogic.groupSeries(primaryVisibleStations()).forEach(function (group) {
      group.series.forEach(function (station) {
        groupsWrap.appendChild(buildLatestCardElement(station));
      });
    });

    container.appendChild(featuredWrap);
    container.appendChild(groupsWrap);

    scheduleLatestCardNameSizing();
    updateCardsCollapse();
  }

  // 初期状態では厳選カードのみ表示し、トグルボタンで全カードの展開/折りたたみを切り替える。
  // スマホ・PC共通の挙動(画面幅に依存しない)。
  function updateCardsCollapse() {
    var container = document.getElementById('latest-cards');
    var toggle = document.getElementById('latest-cards-toggle');
    var customize = document.getElementById('latest-cards-customize');
    if (!container || !toggle || !customize) return;

    var selected = {};
    CardLayoutLogic.selectedIds(featuredCardLayout).forEach(function (id) {
      selected[id] = true;
    });
    var hasOverflow = primaryVisibleStations().some(function (station) {
      return !selected[station.id];
    });
    var effectivelyExpanded = hasOverflow && cardsExpanded;

    toggle.hidden = !hasOverflow;
    toggle.setAttribute('aria-expanded', String(effectivelyExpanded));
    toggle.textContent = effectivelyExpanded ? '閉じる ▴' : 'すべて表示 ▾';
    customize.hidden = effectivelyExpanded;

    container.classList.toggle('cards-expanded', effectivelyExpanded);
  }

  function initCardsToggle() {
    var toggle = document.getElementById('latest-cards-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', function () {
      cardsExpanded = !cardsExpanded;
      saveCardsExpandedPref(cardsExpanded);
      updateCardsCollapse();
    });
  }

  function closeCardCustomizer(dialog) {
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
  }

  function cardSlotLabel(index) {
    var row = Math.floor(index / CardLayoutLogic.COLUMNS) + 1;
    var columnLabels = ['左', '中央', '右'];
    return row + '行目・' + columnLabels[index % CardLayoutLogic.COLUMNS];
  }

  function cardOptionLabel(station) {
    var entry = seriesData[station.id];
    if (entry && entry.dormant) return station.name + '（休止中）';
    if (!entry || !entry.loaded) return station.name + '（データ未取得）';
    return station.name;
  }

  function initCardCustomizer() {
    var dialog = document.getElementById('latest-cards-dialog');
    var openButton = document.getElementById('latest-cards-customize');
    var form = document.getElementById('latest-cards-form');
    var slotsContainer = document.getElementById('card-customizer-slots');
    var closeButton = document.getElementById('card-customizer-close');
    var cancelButton = document.getElementById('card-customizer-cancel');
    var resetButton = document.getElementById('card-customizer-reset');
    if (!dialog || !openButton || !form || !slotsContainer) return;

    var draft = null;
    openButton.disabled = false;

    function expandDraft(layout) {
      var slots = layout.slots.slice();
      while (slots.length < CardLayoutLogic.capacity(CardLayoutLogic.MAX_ROWS)) {
        slots.push(null);
      }
      return { rows: layout.rows, slots: slots };
    }

    function renderSlots(focusIndex) {
      slotsContainer.innerHTML = '';
      var slotCount = CardLayoutLogic.capacity(draft.rows);
      for (var index = 0; index < slotCount; index += 1) {
        (function (slotIndex) {
          var label = document.createElement('label');
          label.className = 'card-customizer-slot';

          var labelText = document.createElement('span');
          labelText.textContent = cardSlotLabel(slotIndex);

          var select = document.createElement('select');
          select.dataset.slotIndex = String(slotIndex);
          select.setAttribute('aria-label', cardSlotLabel(slotIndex) + 'に表示する地点');

          var emptyOption = document.createElement('option');
          emptyOption.value = '';
          emptyOption.textContent = '空欄';
          select.appendChild(emptyOption);

          SeriesSelectionLogic.groupSeries(stationsConfig).forEach(function (group) {
            var optgroup = document.createElement('optgroup');
            optgroup.label = group.name;
            group.series.forEach(function (station) {
              var option = document.createElement('option');
              option.value = station.id;
              option.textContent = cardOptionLabel(station);
              optgroup.appendChild(option);
            });
            select.appendChild(optgroup);
          });
          select.value = draft.slots[slotIndex] || '';

          select.addEventListener('change', function () {
            var nextId = select.value || null;
            draft.slots = CardLayoutLogic.assignSlot(draft.slots, slotIndex, nextId);
            renderSlots(slotIndex);
          });

          label.appendChild(labelText);
          label.appendChild(select);
          slotsContainer.appendChild(label);
        })(index);
      }
      if (typeof focusIndex === 'number') {
        var focusSelect = slotsContainer.querySelector(
          'select[data-slot-index="' + focusIndex + '"]'
        );
        if (focusSelect) focusSelect.focus();
      }
    }

    function syncRowControls() {
      form.querySelectorAll('input[name="card-rows"]').forEach(function (radio) {
        radio.checked = Number(radio.value) === draft.rows;
      });
    }

    function renderDraft() {
      syncRowControls();
      renderSlots();
    }

    openButton.addEventListener('click', function () {
      draft = expandDraft(featuredCardLayout);
      renderDraft();
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    });

    form.querySelectorAll('input[name="card-rows"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (!draft || !radio.checked) return;
        draft.rows = CardLayoutLogic.normalizeRows(radio.value);
        renderSlots();
      });
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!draft) return;
      saveFeaturedCardLayout({
        rows: draft.rows,
        slots: draft.slots.slice(0, CardLayoutLogic.capacity(draft.rows))
      });
      renderLatestCards();
      closeCardCustomizer(dialog);
    });

    resetButton.addEventListener('click', function () {
      draft = expandDraft(CardLayoutLogic.defaultLayout(
        DEFAULT_FEATURED_CARD_IDS,
        availableCardIds()
      ));
      renderDraft();
    });
    closeButton.addEventListener('click', function () { closeCardCustomizer(dialog); });
    cancelButton.addEventListener('click', function () { closeCardCustomizer(dialog); });
  }

  function resizeLatestCardNames() {
    var names = Array.prototype.slice.call(
      document.querySelectorAll('#latest-cards .card-name')
    );
    if (!names.length) return;

    names.forEach(function (name) { name.style.fontSize = '10px'; });

    var sampleStyle = window.getComputedStyle(names[0]);
    var canvas = document.createElement('canvas');
    var context = canvas.getContext('2d');
    context.font = sampleStyle.fontStyle + ' ' + sampleStyle.fontWeight +
      ' 1px ' + sampleStyle.fontFamily;

    var commonSize = names.reduce(function (smallest, name) {
      var measuredAtOnePixel = context.measureText(name.textContent).width;
      var availableWidth = name.clientWidth - 1;
      if (!measuredAtOnePixel || availableWidth <= 0) return smallest;
      return Math.min(smallest, availableWidth / measuredAtOnePixel);
    }, 16);

    commonSize = Math.max(10, Math.min(16, commonSize));
    names.forEach(function (name) {
      name.style.fontSize = commonSize.toFixed(2) + 'px';
    });
  }

  function scheduleLatestCardNameSizing() {
    if (latestCardResizeFrame !== null) {
      window.cancelAnimationFrame(latestCardResizeFrame);
    }
    latestCardResizeFrame = window.requestAnimationFrame(function () {
      latestCardResizeFrame = null;
      resizeLatestCardNames();
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function shortDate(dateStr) {
    var date = parseDate(dateStr);
    return (date.getMonth() + 1) + '/' + date.getDate();
  }

  function currentJapanDate() {
    return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  // ---- 時系列モード ----

  function loadedStations() {
    return stationsConfig.filter(function (s) {
      return seriesData[s.id] && seriesData[s.id].loaded;
    });
  }

  function stationById(seriesId) {
    return stationsConfig.filter(function (station) { return station.id === seriesId; })[0] || null;
  }

  function hasCustomSeriesColor(seriesId) {
    return Object.prototype.hasOwnProperty.call(customSeriesColors, seriesId);
  }

  function updateSeriesColorResetAllButton() {
    var button = document.getElementById('series-colors-reset-all');
    if (button) button.disabled = Object.keys(customSeriesColors).length === 0;
  }

  function updateSeriesColorControls() {
    document.querySelectorAll('#series-checkboxes .series-checkbox[data-series-id]').forEach(function (row) {
      var entry = seriesData[row.dataset.seriesId];
      if (!entry || !entry.color) return;
      var swatch = row.querySelector('.swatch');
      var buttonSwatch = row.querySelector('.series-color-button-swatch');
      if (swatch) swatch.style.background = entry.color;
      if (buttonSwatch) buttonSwatch.style.background = entry.color;
    });
    updateSeriesColorResetAllButton();
  }

  function refreshSeriesColorViews() {
    applyResolvedSeriesColors();
    renderLatestCards();
    updateSeriesColorControls();
    if (tsChart) renderTimeseriesChart();
  }

  function saveCustomSeriesColors() {
    SeriesColorPreferenceLogic.save(getLocalStorage(), customSeriesColors);
  }

  function setCustomSeriesColor(seriesId, color) {
    var normalized = SeriesColorPreferenceLogic.normalizeColor(color);
    if (!stationById(seriesId) || !normalized) return;
    customSeriesColors = Object.assign({}, customSeriesColors);
    customSeriesColors[seriesId] = normalized;
    saveCustomSeriesColors();
    refreshSeriesColorViews();
  }

  function resetCustomSeriesColor(seriesId) {
    if (!hasCustomSeriesColor(seriesId)) return;
    customSeriesColors = Object.assign({}, customSeriesColors);
    delete customSeriesColors[seriesId];
    saveCustomSeriesColors();
    refreshSeriesColorViews();
  }

  function resetAllCustomSeriesColors() {
    if (!Object.keys(customSeriesColors).length) return;
    customSeriesColors = {};
    saveCustomSeriesColors();
    refreshSeriesColorViews();
  }

  function syncSeriesColorDialog() {
    var station = stationById(editingSeriesColorId);
    var stationLabel = document.getElementById('series-color-station');
    var customInput = document.getElementById('series-color-custom-input');
    var resetButton = document.getElementById('series-color-reset');
    if (!station || !pendingSeriesColor) return;
    if (stationLabel) stationLabel.textContent = station.name;
    if (customInput) customInput.value = pendingSeriesColor.toLowerCase();
    if (resetButton) resetButton.disabled = !hasCustomSeriesColor(editingSeriesColorId);
    document.querySelectorAll('#series-color-presets button[data-color]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.color === pendingSeriesColor));
    });
  }

  function openSeriesColorDialog(seriesId, trigger) {
    var dialog = document.getElementById('series-color-dialog');
    var entry = seriesData[seriesId];
    if (!dialog || !entry || !entry.color) return;
    editingSeriesColorId = seriesId;
    pendingSeriesColor = hasCustomSeriesColor(seriesId)
      ? customSeriesColors[seriesId]
      : entry.color.toUpperCase();
    seriesColorDialogTrigger = trigger || null;
    syncSeriesColorDialog();
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function initSeriesColorControls() {
    var dialog = document.getElementById('series-color-dialog');
    var form = document.getElementById('series-color-form');
    var presets = document.getElementById('series-color-presets');
    var customInput = document.getElementById('series-color-custom-input');
    var closeButton = document.getElementById('series-color-close');
    var cancelButton = document.getElementById('series-color-cancel');
    var resetButton = document.getElementById('series-color-reset');
    var resetAllButton = document.getElementById('series-colors-reset-all');
    if (!dialog || !form || !presets || !customInput) return;

    presets.innerHTML = '';
    SERIES_COLOR_PRESETS.forEach(function (preset) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'series-color-preset';
      button.dataset.color = preset.color;
      button.setAttribute('aria-label', preset.name + 'を選ぶ');
      button.setAttribute('aria-pressed', 'false');
      var swatch = document.createElement('span');
      swatch.className = 'series-color-preset-swatch';
      swatch.style.background = preset.color;
      button.appendChild(swatch);
      button.addEventListener('click', function () {
        pendingSeriesColor = preset.color;
        syncSeriesColorDialog();
      });
      presets.appendChild(button);
    });

    customInput.addEventListener('input', function () {
      pendingSeriesColor = customInput.value.toUpperCase();
      syncSeriesColorDialog();
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (editingSeriesColorId && pendingSeriesColor) {
        setCustomSeriesColor(editingSeriesColorId, pendingSeriesColor);
      }
      closeCardCustomizer(dialog);
    });
    resetButton.addEventListener('click', function () {
      if (editingSeriesColorId) resetCustomSeriesColor(editingSeriesColorId);
      closeCardCustomizer(dialog);
    });
    closeButton.addEventListener('click', function () { closeCardCustomizer(dialog); });
    cancelButton.addEventListener('click', function () { closeCardCustomizer(dialog); });
    dialog.addEventListener('close', function () {
      editingSeriesColorId = null;
      pendingSeriesColor = null;
      if (seriesColorDialogTrigger) seriesColorDialogTrigger.focus();
      seriesColorDialogTrigger = null;
    });
    resetAllButton.addEventListener('click', resetAllCustomSeriesColors);
    updateSeriesColorResetAllButton();
  }

  function buildSeriesCheckboxes(selectedIds) {
    var container = document.getElementById('series-checkboxes');
    container.innerHTML = '';
    var visibleStations = primaryVisibleStations();
    var initialIds = selectedIds || SeriesSelectionLogic.initialSelectedIds(visibleStations);

    SeriesSelectionLogic.groupSeries(visibleStations).forEach(function (group) {
      var details = document.createElement('details');
      details.className = 'series-group';
      details.dataset.group = group.name;

      var summary = document.createElement('summary');
      summary.className = 'series-group-summary';

      var title = document.createElement('span');
      title.className = 'series-group-title';
      title.textContent = group.name;

      var badge = document.createElement('span');
      badge.className = 'series-count-badge';
      badge.setAttribute('aria-live', 'polite');

      var toggleLabel = document.createElement('label');
      toggleLabel.className = 'series-group-toggle';
      var toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.dataset.groupToggle = group.name;
      toggle.setAttribute('aria-label', group.name + 'を一括ON/OFF');
      var toggleText = document.createElement('span');
      toggleText.textContent = '一括ON/OFF';
      toggleLabel.appendChild(toggle);
      toggleLabel.appendChild(toggleText);

      summary.appendChild(title);
      summary.appendChild(badge);
      summary.appendChild(toggleLabel);
      details.appendChild(summary);

      var list = document.createElement('div');
      list.className = 'series-group-list';
      group.series.forEach(function (station) {
        var entry = seriesData[station.id];
        var available = !!(entry && entry.loaded);
        var row = document.createElement('div');
        row.className = 'series-checkbox' + (available ? '' : ' unavailable');
        row.dataset.seriesId = station.id;
        var label = document.createElement('label');
        label.className = 'series-checkbox-main';

        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = available && initialIds.indexOf(station.id) !== -1;
        checkbox.disabled = !available;
        checkbox.dataset.seriesId = station.id;
        checkbox.dataset.group = group.name;

        var swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = entry.color;

        var name = document.createElement('span');
        name.className = 'series-name';
        name.textContent = station.name;

        label.appendChild(checkbox);
        label.appendChild(swatch);
        label.appendChild(name);
        if (!available) {
          var status = document.createElement('span');
          status.className = 'series-unavailable-badge';
          status.textContent = '未取得';
          label.appendChild(status);
        }
        if (entry && entry.dormant) {
          var dormantStatus = document.createElement('span');
          dormantStatus.className = 'series-dormant-badge';
          dormantStatus.textContent = '休止中(最終: ' + entry.meta.dataset_end + ')';
          label.appendChild(dormantStatus);
        }

        var colorButton = document.createElement('button');
        colorButton.type = 'button';
        colorButton.className = 'series-color-button';
        colorButton.setAttribute('aria-label', station.name + 'の色を変更');
        colorButton.setAttribute('title', station.name + 'の色を変更');
        var colorButtonSwatch = document.createElement('span');
        colorButtonSwatch.className = 'series-color-button-swatch';
        colorButtonSwatch.style.background = entry.color;
        colorButton.appendChild(colorButtonSwatch);
        colorButton.addEventListener('click', function () {
          openSeriesColorDialog(station.id, colorButton);
        });

        row.appendChild(label);
        row.appendChild(colorButton);
        list.appendChild(row);
      });
      details.appendChild(list);
      container.appendChild(details);

      toggleLabel.addEventListener('click', function (event) {
        event.stopPropagation();
      });
      toggle.addEventListener('change', function () {
        list.querySelectorAll('input[data-series-id]:not(:disabled)').forEach(function (checkbox) {
          checkbox.checked = toggle.checked;
        });
        updateSeriesGroupState(details);
        renderTimeseriesChart();
        persistSelectedSeries();
      });

      list.addEventListener('change', function (event) {
        if (!event.target.matches('input[data-series-id]')) return;
        updateSeriesGroupState(details);
        renderTimeseriesChart();
        persistSelectedSeries();
      });

      updateSeriesGroupState(details);
      details.open = false;
    });

  }

  function updateSeriesGroupState(details) {
    var checkboxes = Array.prototype.slice.call(
      details.querySelectorAll('input[data-series-id]')
    );
    var selectedIds = checkboxes.filter(function (checkbox) {
      return checkbox.checked;
    }).map(function (checkbox) { return checkbox.dataset.seriesId; });
    var availableIds = checkboxes.filter(function (checkbox) {
      return !checkbox.disabled;
    }).map(function (checkbox) { return checkbox.dataset.seriesId; });
    var group = SeriesSelectionLogic.groupSeries(primaryVisibleStations()).filter(function (candidate) {
      return candidate.name === details.dataset.group;
    })[0];
    var state = SeriesSelectionLogic.groupSelectionState(
      group ? group.series : [],
      selectedIds,
      availableIds
    );
    var toggle = details.querySelector('input[data-group-toggle]');
    toggle.checked = state.checked;
    toggle.indeterminate = state.indeterminate;
    toggle.disabled = state.selectableCount === 0;
    details.querySelector('.series-count-badge').textContent =
      state.selectedCount + '/' + state.totalCount + ' ON';
  }

  function applySeriesPreset(preset) {
    var selectedIds = SeriesSelectionLogic.presetSelectedIds(preset, stationsConfig);
    document.querySelectorAll('#series-checkboxes input[data-series-id]').forEach(function (checkbox) {
      checkbox.checked = !checkbox.disabled && selectedIds.indexOf(checkbox.dataset.seriesId) !== -1;
    });
    document.querySelectorAll('#series-checkboxes .series-group').forEach(function (details) {
      updateSeriesGroupState(details);
    });
    renderTimeseriesChart();
    persistSelectedSeries();
  }

  function checkedSeriesIds() {
    var checkboxes = document.querySelectorAll('#series-checkboxes input[data-series-id]');
    var ids = [];
    checkboxes.forEach(function (cb) {
      if (cb.checked) {
        ids.push(cb.dataset.seriesId);
      }
    });
    return ids;
  }

  // 場所比較モードの選択地点をlocalStorageへ保存する。
  // 再読み込み後も選択状態を維持するための処理(プリセット適用時も含む)。
  function persistSelectedSeries() {
    SeriesSelectionLogic.saveSelectedSeriesIds(getLocalStorage(), checkedSeriesIds());
  }

  function initSeriesControls() {
    document.getElementById('series-presets').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-preset]');
      if (!button) return;
      applySeriesPreset(button.dataset.preset);
    });

    document.getElementById('show-dormant-series').addEventListener('change', function (event) {
      var selectedIds = checkedSeriesIds();
      showDormantStations = event.target.checked;
      if (!showDormantStations) {
        selectedIds = selectedIds.filter(function (id) {
          return !(seriesData[id] && seriesData[id].dormant);
        });
      }
      renderLatestCards();
      buildSeriesCheckboxes(selectedIds);
      renderTimeseriesChart();
      persistSelectedSeries();
    });
  }

  function buildTimeseriesDataset(station, bounds) {
    var entry = seriesData[station.id];
    var filtered = filterByRange(entry.records, bounds.start, bounds.end);
    var points = filtered.map(function (r) {
      return {
        x: parseDate(r.date),
        y: r.value,
        note: r.note || null,
        seriesName: station.name
      };
    });
    var showLine = currentTsPlotStyle === 'standard';
    return {
      label: station.name,
      data: points,
      showLine: showLine,
      spanGaps: showLine,
      borderWidth: showLine ? 1 : 0,
      pointRadius: showLine ? (narrowScreenMedia.matches ? 0.25 : 1) : (narrowScreenMedia.matches ? 1.5 : 2.5),
      pointHoverRadius: 4,
      backgroundColor: entry.color,
      borderColor: entry.color
    };
  }

  // 場所比較モードの固定期間表示。1月／4月の選択した月から同年12月末まで表示する。
  // 4月始まりを1〜3月に開いた場合は、直近の前年4月〜12月を表示する。
  function getCalendarStartBounds() {
    var now = new Date();
    var startYear = now.getFullYear();
    if (now.getMonth() < currentCalendarStartMonth) {
      startYear -= 1;
    }
    return {
      start: new Date(startYear, currentCalendarStartMonth, 1),
      end: new Date(startYear, 11, 31)
    };
  }

  function isOddMonth(date) {
    return (date.getMonth() + 1) % 2 === 1;
  }

  // 目盛り自体を奇数月のみに絞り込む(Chart.jsのautoSkipが偶数月側を
  // 残してしまい、ラベルをコールバックで空文字にするだけでは狭い画面で
  // 全ラベルが空欄になる場合があるため、生成段階で除外する)。
  function keepOddMonthTicks(axis) {
    axis.ticks = (axis.ticks || []).filter(function (tick) {
      return isOddMonth(new Date(tick.value));
    });
  }

  // 固定期間表示では開始月から2ヶ月おきに目盛りを残し、
  // 4月始まりでも先頭の「4月」が省略されないようにする。
  function keepCalendarMonthTicks(axis) {
    axis.ticks = (axis.ticks || []).filter(function (tick) {
      var month = new Date(tick.value).getMonth();
      return (month - currentCalendarStartMonth + 12) % 2 === 0;
    });
  }

  // 直近表示モードのX軸ラベル("yy/M"表記。奇数月のみが渡ってくる)
  function rollingMonthTickLabel(value) {
    var date = new Date(value);
    return String(date.getFullYear()).slice(-2) + '/' + (date.getMonth() + 1);
  }

  // 固定期間表示・年比較モードのX軸ラベル("M月"表記)
  function monthOnlyTickLabel(value) {
    var date = new Date(value);
    return (date.getMonth() + 1) + '月';
  }

  // 直近表示モードのうち短期間(1ヶ月/3ヶ月/半年)は、月初ティック自体が
  // 少なく奇数月フィルタを適用するとラベルが0件になり得るため対象外とする。
  var SHORT_ROLLING_RANGES = ['1m', '3m', '6m'];

  // ズームリセットボタンの見た目を、現在のズーム/パン状態に応じて更新する。
  // 脱出手段を確実に残すため、プラグインが有効な間はボタン自体は常に押せる
  // (ズーム中でなければ強調表示だけ外す)。
  // タッチ操作(狭い画面/coarseポインタ)かどうかで操作案内の文言を切り替える。
  function tsZoomHintText() {
    var isTouch = (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
      || narrowScreenMedia.matches;
    return isTouch ? '横方向にピンチして拡大' : 'Ctrl+ホイールで拡大';
  }

  function updateTsZoomResetButton() {
    var btn = document.getElementById('ts-zoom-reset');
    var hint = document.getElementById('ts-zoom-hint');
    if (!btn) return;
    if (!zoomPluginAvailable || !tsChart) {
      btn.disabled = true;
      if (hint) hint.hidden = true;
      return;
    }
    var zoomed = typeof tsChart.isZoomedOrPanned === 'function' && tsChart.isZoomedOrPanned();
    btn.disabled = !zoomed;
    btn.classList.toggle('zoom-active', !!zoomed);
    if (hint) {
      hint.textContent = tsZoomHintText();
      hint.hidden = false;
    }
  }

  function initTsZoomResetButton() {
    var btn = document.getElementById('ts-zoom-reset');
    var hint = document.getElementById('ts-zoom-hint');
    var toolbar = document.getElementById('ts-chart-toolbar');
    if (!btn) return;
    if (toolbar) toolbar.hidden = !zoomPluginAvailable;
    btn.hidden = !zoomPluginAvailable;
    if (hint) {
      hint.hidden = !zoomPluginAvailable;
      hint.textContent = tsZoomHintText();
    }
    btn.addEventListener('click', function () {
      // resetZoomが効かない異常状態でも必ず戻れるよう、
      // ズーム解除のうえチャートを作り直すハードリセットにする。
      try {
        if (tsChart && typeof tsChart.resetZoom === 'function') {
          tsChart.resetZoom('none');
        }
      } catch (err) { /* 異常状態でも下の再構築で復帰する */ }
      renderTimeseriesChart();
    });
  }

  function renderTimeseriesChart() {
    var canvas = document.getElementById('chart-timeseries');
    var isCalendarStart = currentTsDisplayMode === 'jan-start';
    var bounds = isCalendarStart ? getCalendarStartBounds() : getRangeBounds(currentRange);
    var ids = checkedSeriesIds();
    var isShortRolling = !isCalendarStart && SHORT_ROLLING_RANGES.indexOf(currentRange) !== -1;

    var datasets = loadedStations()
      .filter(function (s) {
        return ids.indexOf(s.id) !== -1;
      })
      .map(function (s) {
        return buildTimeseriesDataset(s, bounds);
      });

    var scalesX = {
      type: 'time',
      time: {
        unit: 'month',
        tooltipFormat: 'yyyy/M/d'
      },
      ticks: {
        maxRotation: 0,
        minRotation: 0,
        callback: isCalendarStart ? monthOnlyTickLabel : rollingMonthTickLabel
      },
      title: { display: true, text: '日付' }
    };
    if (isCalendarStart) {
      scalesX.afterBuildTicks = keepCalendarMonthTicks;
    } else if (!isShortRolling) {
      scalesX.afterBuildTicks = keepOddMonthTicks;
    }
    if (bounds.start) {
      // Dateオブジェクトを渡すとズームプラグインが毎回「外部変更」と誤検知して
      // 元範囲を再学習し、ズーム状態が壊れるため数値(エポックms)で渡す
      scalesX.min = bounds.start.getTime();
      scalesX.max = bounds.end.getTime();
    }

    var config = {
      type: 'scatter',
      data: { datasets: datasets },
      plugins: [timeseriesHtmlLegendPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        animation: false,
        interaction: NEAREST_INTERACTION,
        scales: {
          x: themedScale(scalesX),
          y: themedScale({
            title: { display: true, text: '水温 (°C)' }
          })
        },
        plugins: themedPlugins({
              title: function (items) {
                if (!items.length) return '';
                var raw = items[0].raw;
                return formatDateJP(raw.x);
              },
              label: function (item) {
                var raw = item.raw;
                var text = raw.seriesName + ': ' + raw.y.toFixed(1) + '°C';
                if (raw.note) {
                  text += ' (' + raw.note + ')';
                }
                return text;
              }
            })
      }
    };
    config.options.plugins.legend.display = false;

    if (zoomPluginAvailable) {
      // X軸のみズーム/パン可能にする(Y軸は固定)。
      // PC: ホイール+Ctrl(またはトラックパッドのピンチ、ブラウザ上はctrlKey付きwheelとして届く)でズーム、
      //     ドラッグでパン。スマホ: ピンチでズーム、2本指ドラッグでパン(1本指はページスクロールに委ねる)。
      config.options.plugins.zoom = {
        // minRange: 拡大しすぎて操作不能になるのを防ぐ(最小7日幅まで)
        limits: { x: { min: 'original', max: 'original', minRange: 7 * 24 * 60 * 60 * 1000 } },
        pan: {
          enabled: true,
          mode: 'x',
          onPan: function (ctx) { updateTsZoomResetButton(ctx.chart); },
          onPanComplete: function (ctx) { updateTsZoomResetButton(ctx.chart); }
        },
        zoom: {
          wheel: { enabled: true, modifierKey: 'ctrl' },
          pinch: { enabled: true },
          mode: 'x',
          // limits.minRange がプラグイン側で効かないため、下限(7日)に達したら
          // それ以上のズームイン操作自体をキャンセルする。スケールを外から書き換える
          // 方式はプラグインが「元の範囲」を誤学習してズームアウト不能になるので不可。
          onZoomStart: function (ctx) {
            var s = ctx.chart.scales.x;
            if (!s) return;
            var MINR = 7 * 24 * 60 * 60 * 1000;
            var e = ctx.event || {};
            var zoomingIn = (typeof e.deltaY === 'number') ? e.deltaY < 0
              : (typeof e.scale === 'number') ? e.scale > 1 : true;
            if (zoomingIn && (s.max - s.min) <= MINR * 1.05) return false;
          },
          onZoom: function (ctx) { updateTsZoomResetButton(ctx.chart); },
          onZoomComplete: function (ctx) { updateTsZoomResetButton(ctx.chart); }
        }
      };
    }

    if (tsChart) {
      tsChart.destroy();
    }
    tsChart = new Chart(canvas.getContext('2d'), config);
    updateTsZoomResetButton();
  }

  function initRangeButtons() {
    // 同じ行にあるズームリセットボタン(data-rangeなし)を誤って拾わないこと
    var buttons = document.querySelectorAll('#range-buttons button[data-range]');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        buttons.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        currentRange = btn.dataset.range;
        renderTimeseriesChart();
      });
    });
  }

  function initCalendarStartButtons() {
    var buttons = document.querySelectorAll('#calendar-start-buttons button[data-start-month]');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var startMonth = Number(btn.dataset.startMonth);
        if ((startMonth !== 0 && startMonth !== 3) || startMonth === currentCalendarStartMonth) return;
        currentCalendarStartMonth = startMonth;
        updateTsDisplayModeUI();
        renderTimeseriesChart();
      });
    });
  }

  // 場所比較モードの表示形式(1月始まり/直近表示)に応じて、
  // トグルボタンの見た目と表示期間ボタンの表示/非表示を切り替える。
  function updateTsDisplayModeUI() {
    var toggle = document.getElementById('ts-display-toggle');
    var rangeButtons = document.getElementById('range-buttons');
    var calendarStartButtons = document.getElementById('calendar-start-buttons');
    if (!toggle || !rangeButtons || !calendarStartButtons) return;
    var isCalendarStart = currentTsDisplayMode === 'jan-start';

    toggle.querySelectorAll('.ts-display-btn').forEach(function (btn) {
      var active = btn.dataset.displayMode === currentTsDisplayMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    rangeButtons.classList.toggle('is-hidden', isCalendarStart);
    calendarStartButtons.classList.toggle('is-hidden', !isCalendarStart);
    calendarStartButtons.querySelectorAll('button[data-start-month]').forEach(function (btn) {
      var active = Number(btn.dataset.startMonth) === currentCalendarStartMonth;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function initTsDisplayToggle() {
    var toggle = document.getElementById('ts-display-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', function (event) {
      var button = event.target.closest('.ts-display-btn');
      if (!button) return;
      var mode = button.dataset.displayMode;
      if (mode === currentTsDisplayMode) return;
      currentTsDisplayMode = mode;
      saveTsDisplayModePref(currentTsDisplayMode);
      updateTsDisplayModeUI();
      renderTimeseriesChart();
    });
    updateTsDisplayModeUI();
  }

  function updateTsPlotStyleUI() {
    var toggle = document.getElementById('ts-plot-style-toggle');
    if (!toggle) return;
    toggle.querySelectorAll('.ts-display-btn').forEach(function (btn) {
      var active = btn.dataset.plotStyle === currentTsPlotStyle;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function initTsPlotStyleToggle() {
    var toggle = document.getElementById('ts-plot-style-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', function (event) {
      var button = event.target.closest('.ts-display-btn');
      if (!button || button.dataset.plotStyle === currentTsPlotStyle) return;
      currentTsPlotStyle = button.dataset.plotStyle;
      saveTsPlotStylePref(currentTsPlotStyle);
      updateTsPlotStyleUI();
      renderTimeseriesChart();
    });
    updateTsPlotStyleUI();
  }

  // ---- 年比較モード ----

  // 任意の日付を共通年(2000年、うるう年)にマップする。2/29もそのまま扱える。
  function toCommonYearDate(date) {
    return new Date(2000, date.getMonth(), date.getDate());
  }

  function yearlyColor(index) {
    var palette = isDarkMode ? YEARLY_PALETTE_DARK : YEARLY_PALETTE_LIGHT;
    if (index < palette.length) return palette[index];
    var hue = Math.round((index * 137.508) % 360);
    return 'hsl(' + hue + ', 68%, ' + (isDarkMode ? '68%' : '40%') + ')';
  }

  function prepareYearlyEntry(entry) {
    if (entry.yearlyRecordsByYear) return;
    entry.availableYears = YearlyComparisonLogic.extractAvailableYears(entry.records);
    entry.yearlyRecordsByYear = {};
    entry.records.forEach(function (record) {
      var year = Number(record.date.slice(0, 4));
      if (!entry.yearlyRecordsByYear[year]) entry.yearlyRecordsByYear[year] = [];
      entry.yearlyRecordsByYear[year].push(record);
    });
  }

  // 平年値バンド(月日ごとの平均・最小・最大)を初回のみ計算しentryにキャッシュする。
  // 対象年数が不足している場合はnullをキャッシュし、以後は再計算しない。
  function prepareNormalBand(entry) {
    if (entry.normalBand !== undefined) return entry.normalBand;
    entry.normalBand = NormalBandLogic.computeBand(entry.records);
    return entry.normalBand;
  }

  // 平年値バンドのチェックボックスの有効/無効・注記を、対象系列の年数に応じて更新する。
  function updateNormalBandControl(entry) {
    var checkbox = document.getElementById('yearly-normal-band');
    var note = document.getElementById('yearly-normal-band-note');
    if (!checkbox) return;
    var yearCount = NormalBandLogic.countYears(entry.records);
    var available = yearCount >= NormalBandLogic.MIN_YEARS_FOR_BAND;
    checkbox.disabled = !available;
    if (note) {
      note.textContent = available
        ? ''
        : 'データ蓄積中(' + yearCount + '年分、' + NormalBandLogic.MIN_YEARS_FOR_BAND + '年以上で表示可)';
    }
  }

  // 平年値バンドの表示可否(チェック状態)をlocalStorageから復元する。
  // 未保存時は既定値のON(true)を返す。
  function loadNormalBandPref() {
    var storage = getLocalStorage();
    if (!storage) return true;
    try {
      var value = storage.getItem(NORMAL_BAND_STORAGE_KEY);
      return value === null ? true : value === '1';
    } catch (err) {
      return true;
    }
  }

  function saveNormalBandPref(checked) {
    var storage = getLocalStorage();
    if (!storage) return;
    try {
      storage.setItem(NORMAL_BAND_STORAGE_KEY, checked ? '1' : '0');
    } catch (err) {
      // 保存領域が使えない環境では黙って無視する
    }
  }

  function yearlyPoint(record, year) {
    var date = parseDate(record.date);
    return {
      x: toCommonYearDate(date),
      y: record.value,
      note: record.note || null,
      year: year,
      origDate: record.date
    };
  }

  // 日付が連続しない(欠測)箇所では折れ線を繋がないよう、
  // 隙間にy=nullの点を挿入する(spanGaps:falseと組み合わせて使う)。
  // points は同一年内でx(日付)昇順に並んでいる前提。
  function withYearlyGapBreaks(points) {
    if (!points.length) return points;
    var result = [points[0]];
    for (var i = 1; i < points.length; i++) {
      var prevDate = parseDate(points[i - 1].origDate);
      var curDate = parseDate(points[i].origDate);
      var diffDays = Math.round((curDate.getTime() - prevDate.getTime()) / 86400000);
      if (diffDays > 1) {
        var midDate = new Date(prevDate.getTime() + (curDate.getTime() - prevDate.getTime()) / 2);
        result.push({ x: toCommonYearDate(midDate), y: null });
      }
      result.push(points[i]);
    }
    return result;
  }

  function currentYearlyEntry() {
    var seriesId = document.getElementById('yearly-series-select').value;
    return seriesData[seriesId] || null;
  }

  function syncYearlyControls(entry) {
    var yearSelect = document.getElementById('yearly-year-select');
    var addButton = document.getElementById('yearly-add-button');
    var chips = document.getElementById('yearly-selected-years');
    var addableYears = entry.availableYears.filter(function (year) {
      return selectedYearlyYears.indexOf(year) === -1;
    });

    yearSelect.innerHTML = '';
    if (!addableYears.length) {
      var emptyOption = document.createElement('option');
      emptyOption.textContent = '追加できる年はありません';
      yearSelect.appendChild(emptyOption);
    } else {
      addableYears.forEach(function (year) {
        var option = document.createElement('option');
        option.value = year;
        option.textContent = year + '年';
        yearSelect.appendChild(option);
      });
    }
    yearSelect.disabled = !addableYears.length;
    addButton.disabled = !addableYears.length;

    chips.innerHTML = '';
    if (!selectedYearlyYears.length) {
      var empty = document.createElement('span');
      empty.className = 'year-chips-empty';
      empty.textContent = '表示する年が選択されていません';
      chips.appendChild(empty);
      return;
    }
    selectedYearlyYears.forEach(function (year, index) {
      var chip = document.createElement('span');
      chip.className = 'year-chip';
      chip.style.setProperty('--year-color', yearlyColor(index));

      var label = document.createElement('span');
      label.textContent = year + '年';
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.year = year;
      remove.setAttribute('aria-label', year + '年を表示から外す');
      remove.textContent = '×';
      chip.appendChild(label);
      chip.appendChild(remove);
      chips.appendChild(chip);
    });
  }

  function handleYearlySeriesChange() {
    var entry = currentYearlyEntry();
    if (!entry) return;
    prepareYearlyEntry(entry);
    if (!yearlyYearsInitialized) {
      selectedYearlyYears = YearlyComparisonLogic.defaultYears(
        entry.availableYears,
        new Date().getFullYear()
      );
      yearlyYearsInitialized = true;
    } else {
      selectedYearlyYears = YearlyComparisonLogic.reconcileYears(
        selectedYearlyYears,
        entry.availableYears
      );
    }
    syncYearlyControls(entry);
    updateNormalBandControl(entry);
    if (currentMode === 'yearly' || yearlyChartRendered) {
      renderYearlyChart();
    }
  }

  function buildYearlySelect() {
    var select = document.getElementById('yearly-series-select');
    select.innerHTML = '';

    var loadedIds = loadedStations().map(function (station) { return station.id; });
    SeriesSelectionLogic.groupSeries(stationsConfig).forEach(function (group) {
      var available = group.series.filter(function (station) {
        return loadedIds.indexOf(station.id) !== -1;
      });
      if (!available.length) return;

      var optgroup = document.createElement('optgroup');
      optgroup.label = group.name;
      available.forEach(function (station) {
        var opt = document.createElement('option');
        opt.value = station.id;
        opt.textContent = station.name;
        optgroup.appendChild(opt);
      });
      select.appendChild(optgroup);
    });

    select.addEventListener('change', handleYearlySeriesChange);

    document.getElementById('yearly-add-button').addEventListener('click', function () {
      var entry = currentYearlyEntry();
      var value = Number(document.getElementById('yearly-year-select').value);
      if (!entry || !value) return;
      selectedYearlyYears = YearlyComparisonLogic.addYear(
        selectedYearlyYears,
        value,
        entry.availableYears
      );
      syncYearlyControls(entry);
      renderYearlyChart();
    });
    document.getElementById('yearly-selected-years').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-year]');
      var entry = currentYearlyEntry();
      if (!button || !entry) return;
      selectedYearlyYears = YearlyComparisonLogic.removeYear(
        selectedYearlyYears,
        Number(button.dataset.year)
      );
      syncYearlyControls(entry);
      renderYearlyChart();
    });
    document.getElementById('yearly-show-all').addEventListener('change', renderYearlyChart);

    var normalBandCheckbox = document.getElementById('yearly-normal-band');
    normalBandCheckbox.checked = loadNormalBandPref();
    normalBandCheckbox.addEventListener('change', function () {
      saveNormalBandPref(normalBandCheckbox.checked);
      renderYearlyChart();
    });

    handleYearlySeriesChange();
  }

  function renderYearlyChart() {
    var canvas = document.getElementById('chart-yearly');
    var select = document.getElementById('yearly-series-select');
    var seriesId = select.value;
    if (!seriesId || !seriesData[seriesId]) {
      return;
    }
    var entry = seriesData[seriesId];
    prepareYearlyEntry(entry);
    var showAllYears = document.getElementById('yearly-show-all').checked;
    var datasets = [];

    var normalBandCheckbox = document.getElementById('yearly-normal-band');
    if (normalBandCheckbox && normalBandCheckbox.checked && !normalBandCheckbox.disabled) {
      var band = prepareNormalBand(entry);
      if (band) {
        var minPoints = band.map(function (b) { return { x: b.x, y: b.min }; });
        var maxPoints = band.map(function (b) { return { x: b.x, y: b.max }; });
        var meanPoints = band.map(function (b) { return { x: b.x, y: b.mean }; });
        var bandFillColor = isDarkMode ? NORMAL_BAND_FILL_DARK : NORMAL_BAND_FILL_LIGHT;
        var bandLineColor = isDarkMode ? NORMAL_BAND_LINE_DARK : NORMAL_BAND_LINE_LIGHT;

        // 最小値のデータセット(不可視。次のデータセットのfill基準線として使う)
        datasets.push({
          label: '平年範囲(最小・内部用)',
          data: minPoints,
          type: 'line',
          showLine: true,
          fill: false,
          borderWidth: 0,
          pointRadius: 0,
          pointHitRadius: 0,
          spanGaps: true,
          tension: 0,
          borderColor: 'transparent',
          backgroundColor: 'transparent',
          _hideFromLegend: true
        });
        // 最大値のデータセット(直前の最小値データセットとの間を塗って範囲バンドにする)
        datasets.push({
          label: '過去の最大・最小範囲',
          data: maxPoints,
          type: 'line',
          showLine: true,
          fill: '-1',
          borderWidth: 0,
          pointRadius: 0,
          pointHitRadius: 0,
          spanGaps: true,
          tension: 0,
          borderColor: 'transparent',
          backgroundColor: bandFillColor
        });
        // 平均値の細い実線
        datasets.push({
          label: '平均値',
          data: meanPoints,
          type: 'line',
          showLine: true,
          fill: false,
          borderWidth: narrowScreenMedia.matches ? 1 : 1.5,
          pointRadius: 0,
          pointHitRadius: 0,
          spanGaps: true,
          tension: 0.15,
          borderColor: bandLineColor,
          backgroundColor: bandLineColor
        });
      }
    }

    if (showAllYears) {
      // 年ごとにデータセットを分けないと、共通年軸(2000年)上で
      // 別々の年の点同士が直線で繋がってしまうため年別に分割する。
      // 凡例には代表として1件だけ出す(残りは非表示にして重複を避ける)。
      var bgLegendShown = false;
      entry.availableYears.forEach(function (year) {
        if (selectedYearlyYears.indexOf(year) !== -1) return;
        var bgPoints = withYearlyGapBreaks(
          entry.yearlyRecordsByYear[year].map(function (record) {
            return yearlyPoint(record, year);
          })
        );
        var bgColor = isDarkMode ? YEARLY_BG_DARK : YEARLY_BG_LIGHT;
        datasets.push({
          label: 'その他の年',
          data: bgPoints,
          type: 'line',
          showLine: true,
          spanGaps: false,
          pointRadius: 0,
          pointHitRadius: 0,
          borderWidth: 1,
          tension: 0.2,
          backgroundColor: bgColor,
          borderColor: bgColor,
          _hideFromLegend: bgLegendShown
        });
        bgLegendShown = true;
      });
    }

    selectedYearlyYears.forEach(function (year, index) {
      var color = yearlyColor(index);
      var points = withYearlyGapBreaks(
        (entry.yearlyRecordsByYear[year] || []).map(function (record) {
          return yearlyPoint(record, year);
        })
      );
      datasets.push({
        label: year + '年',
        data: points,
        type: 'line',
        showLine: true,
        spanGaps: false,
        pointRadius: 0,
        pointHitRadius: 6,
        pointHoverRadius: 4,
        borderWidth: narrowScreenMedia.matches ? 1 : 2,
        tension: 0.2,
        backgroundColor: color,
        borderColor: color
      });
    });

    var chartPlugins = themedPlugins({
          title: function (items) {
            if (!items.length) return '';
            var raw = items[0].raw;
            return formatMonthDayWithYear(raw.origDate);
          },
          label: function (item) {
            var raw = item.raw;
            var text = entry.config.name + ': ' + raw.y.toFixed(1) + '°C';
            if (raw.note) {
              text += ' (' + raw.note + ')';
            }
            return text;
          }
        });
    chartPlugins.title = {
      display: true,
      text: entry.config.name + ' の年比較',
      color: chartTheme().text,
      font: { size: 14, weight: '600' }
    };

    var config = {
      type: 'scatter',
      data: { datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        animation: false,
        interaction: NEAREST_INTERACTION,
        scales: {
          x: themedScale({
            type: 'time',
            time: { unit: 'month' },
            min: new Date(2000, 0, 1),
            max: new Date(2000, 11, 31),
            afterBuildTicks: keepOddMonthTicks,
            ticks: {
              // ダミー年(2000)は表示せず「1月」「3月」…奇数月のみ表示する
              maxRotation: 0,
              minRotation: 0,
              callback: monthOnlyTickLabel
            },
            title: { display: true, text: '月日' }
          }),
          y: themedScale({
            title: { display: true, text: '水温 (°C)' }
          })
        },
        plugins: chartPlugins
      }
    };

    if (yearlyChart) {
      yearlyChart.destroy();
    }
    yearlyChart = new Chart(canvas.getContext('2d'), config);
    yearlyChartRendered = true;
  }

  // ---- タブ切替 ----

  function initTabs() {
    var tsTab = document.getElementById('tab-timeseries');
    var yTab = document.getElementById('tab-yearly');
    var tsPanel = document.getElementById('panel-timeseries');
    var yPanel = document.getElementById('panel-yearly');

    function activate(mode) {
      currentMode = mode;
      var isTs = mode === 'timeseries';
      tsTab.classList.toggle('active', isTs);
      yTab.classList.toggle('active', !isTs);
      tsTab.setAttribute('aria-selected', String(isTs));
      yTab.setAttribute('aria-selected', String(!isTs));
      tsPanel.classList.toggle('hidden', !isTs);
      yPanel.classList.toggle('hidden', isTs);

      if (!isTs && !yearlyChartRendered) {
        renderYearlyChart();
      } else if (!isTs && yearlyChart) {
        yearlyChart.resize();
      } else if (isTs && tsChart) {
        tsChart.resize();
      }
    }

    tsTab.addEventListener('click', function () { activate('timeseries'); });
    yTab.addEventListener('click', function () { activate('yearly'); });
  }

  // ---- 初期化 ----

  function updateStatus(text) {
    document.getElementById('global-status').textContent = text;
  }

  function initReloadButton() {
    document.getElementById('reload-button').addEventListener('click', function () {
      var url = new URL(window.location.href);
      url.searchParams.set('v', Date.now());
      window.location.href = url.toString();
    });
  }

  // ---- テーマ(ライト/ダーク)手動切替 ----

  function getStoredTheme() {
    var storage = getLocalStorage();
    if (!storage) return null;
    try {
      var value = storage.getItem(THEME_STORAGE_KEY);
      return (value === 'light' || value === 'dark') ? value : null;
    } catch (err) {
      return null;
    }
  }

  function setStoredTheme(theme) {
    var storage = getLocalStorage();
    if (!storage) return;
    try {
      storage.setItem(THEME_STORAGE_KEY, theme);
    } catch (err) {
      // localStorageが使えない環境では無視
    }
  }

  // 手動選択があればそれを優先し、なければ端末設定(prefers-color-scheme)に従う
  function currentDarkModePreference() {
    var stored = getStoredTheme();
    if (stored === 'dark') return true;
    if (stored === 'light') return false;
    return darkModeMedia.matches;
  }

  // data-theme属性は手動選択がある場合のみ付与し、無い場合はmedia queryに委ねる
  function syncThemeAttribute() {
    var stored = getStoredTheme();
    if (stored) {
      document.documentElement.setAttribute('data-theme', stored);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function updateThemeToggleButton() {
    var btn = document.getElementById('theme-toggle-button');
    if (!btn) return;
    if (isDarkMode) {
      btn.textContent = '☀';
      btn.setAttribute('aria-label', 'ライト表示に切り替え');
      btn.setAttribute('title', 'ライト表示に切り替え');
    } else {
      btn.textContent = '🌙';
      btn.setAttribute('aria-label', 'ダーク表示に切り替え');
      btn.setAttribute('title', 'ダーク表示に切り替え');
    }
  }

  function initThemeToggle() {
    var btn = document.getElementById('theme-toggle-button');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var nextTheme = isDarkMode ? 'light' : 'dark';
      setStoredTheme(nextTheme);
      syncThemeAttribute();
      refreshThemeColors();
    });
  }

  function refreshThemeColors() {
    isDarkMode = currentDarkModePreference();
    updateThemeToggleButton();
    applyResolvedSeriesColors();

    if (stationsConfig.length) {
      renderLatestCards();
      updateSeriesColorControls();
    }
    if (tsChart) {
      renderTimeseriesChart();
    }
    var yearlyEntry = currentYearlyEntry();
    if (yearlyEntry && yearlyYearsInitialized) {
      syncYearlyControls(yearlyEntry);
    }
    if (yearlyChartRendered) {
      renderYearlyChart();
    }
  }

  function init() {
    initReloadButton();
    syncThemeAttribute();
    isDarkMode = currentDarkModePreference();
    initThemeToggle();
    updateThemeToggleButton();
    cardsExpanded = loadCardsExpandedPref();
    initCardsToggle();
    currentTsDisplayMode = loadTsDisplayModePref();
    currentTsPlotStyle = loadTsPlotStylePref();
    initTsZoomResetButton();
    window.addEventListener('resize', scheduleLatestCardNameSizing);
    window.addEventListener('resize', updateCardsCollapse);
    updateStatus('データ読み込み中...');
    loadAllData()
      .then(function () {
        // 読み込み中に端末テーマ(手動選択が無ければ端末設定)が変わっていても、描画直前の設定を採用する
        isDarkMode = currentDarkModePreference();
        updateThemeToggleButton();
        applyResolvedSeriesColors();
        darkModeMedia.addEventListener('change', function () {
          // 手動選択(localStorage)がある場合は端末設定の変化を無視する
          if (!getStoredTheme()) {
            refreshThemeColors();
          }
        });

        var loaded = loadedStations().length;
        var total = stationsConfig.length;
        var failed = total - loaded;
        updateStatus(
          failed > 0
            ? '⚠ ' + failed + '地点のデータを取得できませんでした'
            : ''
        );

        featuredCardLayout = loadFeaturedCardLayout();
        renderLatestCards();
        initCardCustomizer();
        var restoredSelectedIds = SeriesSelectionLogic.restoreSelectedIds(
          SeriesSelectionLogic.loadSelectedSeriesIds(getLocalStorage()),
          primaryVisibleStations()
        );
        buildSeriesCheckboxes(restoredSelectedIds);
        initSeriesControls();
        initSeriesColorControls();
        buildYearlySelect();
        initRangeButtons();
        initCalendarStartButtons();
        initTsDisplayToggle();
        initTsPlotStyleToggle();
        initTabs();
        renderTimeseriesChart();
      })
      .catch(function (err) {
        updateStatus('データ読み込みに失敗しました: ' + err.message);
      });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
