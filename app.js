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

  var GROUP_ORDER = ['海', '水道水', '霞ヶ浦', '北浦', '利根川河口堰'];
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

  function presetSelectedIds(preset, series) {
    if (preset === 'representative') return initialSelectedIds(series);
    if (preset === 'none') return [];
    return (series || []).filter(function (station) {
      if (preset === 'tonegawa') return station.group === '利根川河口堰';
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
    groupSeries: groupSeries,
    initialSelectedIds: initialSelectedIds,
    presetSelectedIds: presetSelectedIds,
    isDormantDatasetEnd: isDormantDatasetEnd,
    groupSelectionState: groupSelectionState
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = YearlyComparisonLogic;
  module.exports.SeriesSelectionLogic = SeriesSelectionLogic;
  module.exports.DateRangeLogic = DateRangeLogic;
}

(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ---- 色覚多様性に配慮したパレット(Okabe-Ito) ----
  var COLOR_SEA_LIGHT = '#0072B2';
  var COLOR_SEA_DARK = '#56B4E9';
  var COLOR_TAPWATER = '#E69F00';
  var COLOR_KASUMIGAURA = '#009E73';
  var EXTRA_PALETTE_LIGHT = ['#CC79A7', '#56B4E9', '#D55E00', '#F0E442'];
  var EXTRA_PALETTE_DARK = ['#CC79A7', '#0072B2', '#D55E00', '#F0E442'];

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
  var isDarkMode = darkModeMedia.matches;

  // ---- ユーティリティ ----

  var parseDate = DateRangeLogic.parseDate;
  var filterByRange = DateRangeLogic.filterByRange;
  var getRangeBounds = DateRangeLogic.getRangeBounds;

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

  // 系列一覧から色を割り当てる
  // 海=青、水道水=橙、霞ヶ浦(名前に含む最初の系列)=緑、それ以降は残りのパレットを順に割当
  function assignColors(list) {
    var colorById = {};
    var colorSea = isDarkMode ? COLOR_SEA_DARK : COLOR_SEA_LIGHT;
    var extraPalette = isDarkMode ? EXTRA_PALETTE_DARK : EXTRA_PALETTE_LIGHT;
    var seaDone = false;
    var tapDone = false;
    var kasumiDone = false;
    var extraIdx = 0;

    list.forEach(function (s) {
      if (!seaDone && s.kind === 'sea') {
        colorById[s.id] = colorSea;
        seaDone = true;
        return;
      }
      if (!tapDone && s.kind === 'tapwater') {
        colorById[s.id] = COLOR_TAPWATER;
        tapDone = true;
        return;
      }
      if (!kasumiDone && s.name && s.name.indexOf('霞ヶ浦') !== -1) {
        colorById[s.id] = COLOR_KASUMIGAURA;
        kasumiDone = true;
        return;
      }
      colorById[s.id] = extraPalette[extraIdx % extraPalette.length];
      extraIdx += 1;
    });

    return colorById;
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
    return {
      legend: {
        display: true,
        position: 'bottom',
        labels: { color: theme.text }
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

  function renderLatestCards() {
    var container = document.getElementById('latest-cards');
    container.innerHTML = '';

    SeriesSelectionLogic.groupSeries(primaryVisibleStations()).forEach(function (group) {
      var section = document.createElement('section');
      section.className = 'latest-group';
      section.setAttribute('aria-label', group.name);

      var heading = document.createElement('h2');
      heading.className = 'latest-group-title';
      heading.textContent = group.name;
      section.appendChild(heading);

      var cards = document.createElement('div');
      cards.className = 'latest-group-cards';
      group.series.forEach(function (station) {
        var entry = seriesData[station.id];
        var card = document.createElement('div');

        if (entry && entry.loaded) {
          var last = entry.records[entry.records.length - 1];
          card.className = 'latest-card';
          card.style.borderLeftColor = entry.color;
          card.innerHTML =
            '<span class="card-name">' + escapeHtml(station.name) + '</span>' +
            '<span class="card-value">' + last.value.toFixed(1) + '°C</span>' +
            '<span class="card-date card-date-full">' + escapeHtml(last.date) + '</span>' +
            '<span class="card-date card-date-short">' +
              escapeHtml(shortDate(last.date)) + '</span>';
        } else {
          card.className = 'latest-card no-data';
          card.innerHTML =
            '<span class="card-name">' + escapeHtml(station.name) + '</span>' +
            '<span>データ未取得</span>';
        }
        cards.appendChild(card);
      });
      section.appendChild(cards);
      container.appendChild(section);
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
      });

      list.addEventListener('change', function (event) {
        if (!event.target.matches('input[data-series-id]')) return;
        updateSeriesGroupState(details);
        renderTimeseriesChart();
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
      pointRadius: 2,
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
        displayFormats: { month: 'yyyy/M' },
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
        pointRadius: 2,
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
        pointRadius: 3,
        pointHoverRadius: 5,
        backgroundColor: color,
        borderColor: color
      });
    });

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
        plugins: themedPlugins({
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
            })
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
          '読み込み完了: ' + loaded + '/' + total + ' 系列' +
          (failed > 0 ? '(' + failed + ' 系列はデータ未取得)' : '')
        );

        renderLatestCards();
        buildSeriesCheckboxes();
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
