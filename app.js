/*
 * 茨城 水温比較アプリ (閲覧用フロントエンド)
 * ビルド工程なしの素のJS。Chart.js 4系 + chartjs-adapter-date-fns を使用。
 * config/stations.json から系列一覧を読み込み、各系列のJSON(data/**)をfetchして表示する。
 * 存在しない系列(fetch失敗)は静かにスキップし「データ未取得」として扱う。
 */

(function () {
  'use strict';

  // ---- 色覚多様性に配慮したパレット(Okabe-Ito) ----
  var COLOR_SEA = '#0072B2';
  var COLOR_TAPWATER = '#E69F00';
  var COLOR_KASUMIGAURA = '#009E73';
  var EXTRA_PALETTE = ['#CC79A7', '#56B4E9', '#D55E00', '#F0E442'];

  // 年比較モードでの年別強調色(系列色とは独立)
  var YEARLY_CURRENT_COLOR = '#D55E00'; // 今年
  var YEARLY_PREV_COLOR = '#0072B2';    // 昨年
  var YEARLY_BG_COLOR = 'rgba(120, 120, 120, 0.35)'; // それ以外の年(背景)

  // ---- アプリ状態 ----
  var stationsConfig = [];         // config/stations.json の series 配列
  var seriesData = {};             // id -> { config, meta, records, color, loaded, error }
  var currentMode = 'timeseries';
  var currentRange = '1y';
  var tsChart = null;
  var yearlyChart = null;
  var yearlyChartRendered = false;

  // ---- ユーティリティ ----

  // "YYYY-MM-DD" をタイムゾーンのずれなくローカル日付として Date に変換
  function parseDate(dateStr) {
    var parts = dateStr.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
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

  function addMonths(date, n) {
    var d = new Date(date.getTime());
    d.setMonth(d.getMonth() + n);
    return d;
  }

  // 系列一覧から色を割り当てる
  // 海=青、水道水=橙、霞ヶ浦(名前に含む最初の系列)=緑、それ以降は残りのパレットを順に割当
  function assignColors(list) {
    var colorById = {};
    var seaDone = false;
    var tapDone = false;
    var kasumiDone = false;
    var extraIdx = 0;

    list.forEach(function (s) {
      if (!seaDone && s.kind === 'sea') {
        colorById[s.id] = COLOR_SEA;
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
      colorById[s.id] = EXTRA_PALETTE[extraIdx % EXTRA_PALETTE.length];
      extraIdx += 1;
    });

    return colorById;
  }

  // 期間フィルタ: records (date昇順を想定) から [start, end] の範囲のみ返す
  // start が null の場合はフィルタなし(全期間)
  function filterByRange(records, start, end) {
    if (!start) {
      return records;
    }
    return records.filter(function (r) {
      var d = parseDate(r.date);
      return d >= start && d <= end;
    });
  }

  function getRangeBounds(rangeKey) {
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    switch (rangeKey) {
      case '1m':
        return { start: addMonths(now, -1), end: now };
      case '3m':
        return { start: addMonths(now, -3), end: now };
      case '1y':
        return { start: addMonths(now, -12), end: now };
      case '5y':
        return { start: addMonths(now, -60), end: now };
      case 'all':
      default:
        return { start: null, end: null };
    }
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
        stationsConfig = json.series || [];
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

  function renderLatestCards() {
    var container = document.getElementById('latest-cards');
    container.innerHTML = '';

    stationsConfig.forEach(function (station) {
      var entry = seriesData[station.id];
      var card = document.createElement('div');

      if (entry && entry.loaded) {
        var last = entry.records[entry.records.length - 1];
        card.className = 'latest-card';
        card.style.borderLeftColor = entry.color;
        card.innerHTML =
          '<span class="card-name">' + escapeHtml(station.name) + '</span>' +
          '<span class="card-value">' + last.value.toFixed(1) + '°C</span>' +
          '<span class="card-date">' + escapeHtml(last.date) + '</span>';
      } else {
        card.className = 'latest-card no-data';
        card.innerHTML =
          '<span class="card-name">' + escapeHtml(station.name) + '</span>' +
          '<span>データ未取得</span>';
      }
      container.appendChild(card);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // ---- 時系列モード ----

  function loadedStations() {
    return stationsConfig.filter(function (s) {
      return seriesData[s.id] && seriesData[s.id].loaded;
    });
  }

  function buildSeriesCheckboxes() {
    var container = document.getElementById('series-checkboxes');
    container.innerHTML = '';

    loadedStations().forEach(function (station) {
      var label = document.createElement('label');
      label.className = 'series-checkbox';

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!station.enabled;
      checkbox.dataset.seriesId = station.id;
      checkbox.addEventListener('change', renderTimeseriesChart);

      var swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = seriesData[station.id].color;

      label.appendChild(checkbox);
      label.appendChild(swatch);
      label.appendChild(document.createTextNode(station.name));
      container.appendChild(label);
    });
  }

  function checkedSeriesIds() {
    var checkboxes = document.querySelectorAll('#series-checkboxes input[type="checkbox"]');
    var ids = [];
    checkboxes.forEach(function (cb) {
      if (cb.checked) {
        ids.push(cb.dataset.seriesId);
      }
    });
    return ids;
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
          x: scalesX,
          y: {
            title: { display: true, text: '水温 (°C)' }
          }
        },
        plugins: {
          legend: { display: true, position: 'bottom' },
          tooltip: {
            callbacks: {
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
            }
          }
        }
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

  function buildYearlySelect() {
    var select = document.getElementById('yearly-series-select');
    select.innerHTML = '';

    loadedStations().forEach(function (station) {
      var opt = document.createElement('option');
      opt.value = station.id;
      opt.textContent = station.name;
      select.appendChild(opt);
    });

    select.addEventListener('change', renderYearlyChart);
  }

  function renderYearlyChart() {
    var canvas = document.getElementById('chart-yearly');
    var select = document.getElementById('yearly-series-select');
    var seriesId = select.value;
    if (!seriesId || !seriesData[seriesId]) {
      return;
    }
    var entry = seriesData[seriesId];
    var thisYear = new Date().getFullYear();
    var prevYear = thisYear - 1;

    var bgPoints = [];
    var thisYearPoints = [];
    var prevYearPoints = [];

    entry.records.forEach(function (r) {
      var d = parseDate(r.date);
      var year = d.getFullYear();
      var point = {
        x: toCommonYearDate(d),
        y: r.value,
        note: r.note || null,
        year: year,
        origDate: r.date
      };
      if (year === thisYear) {
        thisYearPoints.push(point);
      } else if (year === prevYear) {
        prevYearPoints.push(point);
      } else {
        bgPoints.push(point);
      }
    });

    var datasets = [
      {
        label: '過去の年(' + prevYear + '年より前)',
        data: bgPoints,
        showLine: false,
        pointRadius: 2,
        pointHoverRadius: 3,
        backgroundColor: YEARLY_BG_COLOR,
        borderColor: YEARLY_BG_COLOR
      },
      {
        label: prevYear + '年',
        data: prevYearPoints,
        showLine: false,
        pointRadius: 3,
        pointHoverRadius: 5,
        backgroundColor: YEARLY_PREV_COLOR,
        borderColor: YEARLY_PREV_COLOR
      },
      {
        label: thisYear + '年',
        data: thisYearPoints,
        showLine: false,
        pointRadius: 3,
        pointHoverRadius: 5,
        backgroundColor: YEARLY_CURRENT_COLOR,
        borderColor: YEARLY_CURRENT_COLOR
      }
    ];

    var config = {
      type: 'scatter',
      data: { datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        animation: false,
        scales: {
          x: {
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
          },
          y: {
            title: { display: true, text: '水温 (°C)' }
          }
        },
        plugins: {
          legend: { display: true, position: 'bottom' },
          tooltip: {
            callbacks: {
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
            }
          }
        }
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

  function init() {
    updateStatus('データ読み込み中...');
    loadAllData()
      .then(function () {
        var loaded = loadedStations().length;
        var total = stationsConfig.length;
        var failed = total - loaded;
        updateStatus(
          '読み込み完了: ' + loaded + '/' + total + ' 系列' +
          (failed > 0 ? '(' + failed + ' 系列はデータ未取得)' : '')
        );

        renderLatestCards();
        buildSeriesCheckboxes();
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
