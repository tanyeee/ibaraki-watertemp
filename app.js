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

// 地点比較の色は、設定順に各 group 内のパレットを割り当てる。
// DOMに依存させず、Nodeでもライト/ダーク双方を検証可能にする。
var ColorAssignmentLogic = (function () {
  'use strict';

  var PALETTES = {
    light: {
      '海': ['#0072B2', '#56B4E9'],
      '水道水': ['#E69F00'],
      '霞ヶ浦': ['#009E73', '#4CAF50', '#8BC34A'],
      '北浦': ['#9467BD', '#CC79A7', '#E377C2'],
      '利根川': ['#D55E00', '#FF9E4A'],
      'その他': ['#0072B2', '#E69F00', '#009E73', '#CC79A7']
    },
    dark: {
      '海': ['#56B4E9', '#90CAF9'],
      '水道水': ['#E6C229'],
      '霞ヶ浦': ['#4DD0A8', '#81C784', '#AED581'],
      '北浦': ['#B39DDB', '#E88AC5', '#F48FB1'],
      '利根川': ['#FF8A65', '#E25822'],
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = YearlyComparisonLogic;
  module.exports.SeriesSelectionLogic = SeriesSelectionLogic;
  module.exports.DateRangeLogic = DateRangeLogic;
  module.exports.ColorAssignmentLogic = ColorAssignmentLogic;
  module.exports.CardTextColorLogic = CardTextColorLogic;
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

  // ---- アプリ状態 ----
  var stationsConfig = [];         // config/stations.json の series 配列
  var seriesData = {};             // id -> { config, meta, records, color, loaded, error }
  var currentMode = 'timeseries';
  var currentRange = '1y';
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
  var CARDS_EXPANDED_STORAGE_KEY = 'watertemp_cards_expanded';
  // 折りたたみ時に表示する最新値カード(3枚×2行、この順で表示)
  var FEATURED_CARD_IDS = [
    'sea_area137',
    'sea_area138',
    'tapwater',
    'kasumigaura_koshin',
    'kitaura_jinguubashi',
    'tonegawa_down_upper'
  ];
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
    scale.grid = { color: theme.grid };
    scale.border = { color: theme.grid };
    if (scale.title) {
      scale.title.color = theme.text;
    }
    return scale;
  }

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
          font: { size: narrow ? 10 : 12 }
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
      var colorById = assignColors(list);
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

  // 折りたたみ時に表示する厳選カード(表示可能なもののみ、指定順)。
  function featuredStations() {
    var visibleById = {};
    primaryVisibleStations().forEach(function (station) {
      visibleById[station.id] = station;
    });
    return FEATURED_CARD_IDS.map(function (id) {
      return visibleById[id];
    }).filter(Boolean);
  }

  function buildLatestCardElement(station) {
    var entry = seriesData[station.id];
    var card = document.createElement('div');
    var cardTextColor = entry && entry.color
      ? CardTextColorLogic.readableSeriesColor(entry.color, isDarkMode)
      : '';

    if (entry && entry.loaded) {
      var last = entry.records[entry.records.length - 1];
      card.className = 'latest-card';
      card.style.borderLeftColor = entry.color;
      card.innerHTML =
        '<span class="card-name">' + escapeHtml(station.name) + '</span>' +
        '<span class="card-reading">' +
          '<span class="card-value">' + last.value.toFixed(1) + '°C</span>' +
          '<span class="card-date card-date-full">' + escapeHtml(last.date) + '</span>' +
          '<span class="card-date card-date-short">' +
            escapeHtml(shortDate(last.date)) + '</span>' +
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
    featuredStations().forEach(function (station) {
      featuredWrap.appendChild(buildLatestCardElement(station));
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
    if (!container || !toggle) return;

    var hasOverflow = primaryVisibleStations().length > featuredStations().length;

    toggle.hidden = !hasOverflow;
    toggle.setAttribute('aria-expanded', String(cardsExpanded));
    toggle.textContent = cardsExpanded ? '閉じる ▴' : 'すべて表示 ▾';

    container.classList.toggle('cards-expanded', hasOverflow && cardsExpanded);
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

  // ---- 時系列モード ----

  function loadedStations() {
    return stationsConfig.filter(function (s) {
      return seriesData[s.id] && seriesData[s.id].loaded;
    });
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
        var label = document.createElement('label');
        label.className = 'series-checkbox' + (available ? '' : ' unavailable');

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
        list.appendChild(label);
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
    return {
      label: station.name,
      data: points,
      showLine: false,
      pointRadius: narrowScreenMedia.matches ? 0.5 : 2,
      pointHoverRadius: 4,
      backgroundColor: entry.color,
      borderColor: entry.color
    };
  }

  function renderTimeseriesChart() {
    var canvas = document.getElementById('chart-timeseries');
    var bounds = getRangeBounds(currentRange);
    var ids = checkedSeriesIds();

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
        displayFormats: { month: 'yy/M' },
        tooltipFormat: 'yyyy/M/d'
      },
      title: { display: true, text: '日付' }
    };
    if (bounds.start) {
      scalesX.min = bounds.start;
      scalesX.max = bounds.end;
    }

    var config = {
      type: 'scatter',
      data: { datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        animation: false,
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

    if (tsChart) {
      tsChart.destroy();
    }
    tsChart = new Chart(canvas.getContext('2d'), config);
  }

  function initRangeButtons() {
    var buttons = document.querySelectorAll('#range-buttons button');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        buttons.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        currentRange = btn.dataset.range;
        renderTimeseriesChart();
      });
    });
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

    if (showAllYears) {
      var backgroundPoints = [];
      entry.availableYears.forEach(function (year) {
        if (selectedYearlyYears.indexOf(year) !== -1) return;
        entry.yearlyRecordsByYear[year].forEach(function (record) {
          backgroundPoints.push(yearlyPoint(record, year));
        });
      });
      datasets.push({
        label: 'その他の年',
        data: backgroundPoints,
        showLine: false,
        pointRadius: narrowScreenMedia.matches ? 0.5 : 2,
        pointHoverRadius: 3,
        backgroundColor: isDarkMode ? YEARLY_BG_DARK : YEARLY_BG_LIGHT,
        borderColor: isDarkMode ? YEARLY_BG_DARK : YEARLY_BG_LIGHT
      });
    }

    selectedYearlyYears.forEach(function (year, index) {
      var color = yearlyColor(index);
      var points = (entry.yearlyRecordsByYear[year] || []).map(function (record) {
        return yearlyPoint(record, year);
      });
      datasets.push({
        label: year + '年',
        data: points,
        showLine: false,
        pointRadius: narrowScreenMedia.matches ? 0.5 : 3,
        pointHoverRadius: 5,
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
        scales: {
          x: themedScale({
            type: 'time',
            time: { unit: 'month' },
            min: new Date(2000, 0, 1),
            max: new Date(2000, 11, 31),
            ticks: {
              // ダミー年(2000)は表示せず「1月」〜「12月」の日本語表記にする
              callback: function (value) {
                return (new Date(value).getMonth() + 1) + '月';
              }
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

  function updateThemeColors(event) {
    isDarkMode = event.matches;
    var colorById = assignColors(stationsConfig);

    stationsConfig.forEach(function (station) {
      if (seriesData[station.id]) {
        seriesData[station.id].color = colorById[station.id];
      }
    });

    if (stationsConfig.length) {
      renderLatestCards();
      document.querySelectorAll('#series-checkboxes input[data-series-id]').forEach(function (checkbox) {
        var swatch = checkbox.parentElement.querySelector('.swatch');
        if (swatch && seriesData[checkbox.dataset.seriesId]) {
          swatch.style.background = seriesData[checkbox.dataset.seriesId].color;
        }
      });
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
    cardsExpanded = loadCardsExpandedPref();
    initCardsToggle();
    window.addEventListener('resize', scheduleLatestCardNameSizing);
    window.addEventListener('resize', updateCardsCollapse);
    updateStatus('データ読み込み中...');
    loadAllData()
      .then(function () {
        // 読み込み中に端末テーマが変わっていても、描画直前の設定を採用する
        isDarkMode = darkModeMedia.matches;
        var colorById = assignColors(stationsConfig);
        stationsConfig.forEach(function (station) {
          seriesData[station.id].color = colorById[station.id];
        });
        darkModeMedia.addEventListener('change', updateThemeColors);

        var loaded = loadedStations().length;
        var total = stationsConfig.length;
        var failed = total - loaded;
        updateStatus(
          failed > 0
            ? '⚠ ' + failed + '地点のデータを取得できませんでした'
            : ''
        );

        renderLatestCards();
        var restoredSelectedIds = SeriesSelectionLogic.restoreSelectedIds(
          SeriesSelectionLogic.loadSelectedSeriesIds(getLocalStorage()),
          primaryVisibleStations()
        );
        buildSeriesCheckboxes(restoredSelectedIds);
        initSeriesControls();
        buildYearlySelect();
        initRangeButtons();
        initTabs();
        renderTimeseriesChart();
      })
      .catch(function (err) {
        updateStatus('データ読み込みに失敗しました: ' + err.message);
      });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
