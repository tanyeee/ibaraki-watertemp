/* トークンはこの端末内だけに保存し、固定のGitHub API宛にのみ送信する。 */
var TapwaterRegistration = (function () {
  'use strict';
  var OWNER = 'tanyeee';
  var ISSUES_PATH = '/repos/tanyeee/ibaraki-watertemp/issues';

  function buildRecord(date, valueText, note) {
    var parsed = new Date(date + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date) {
      throw new Error('有効な日付を入力してください。');
    }
    var value = Number(valueText);
    if (!String(valueText).trim() || !Number.isFinite(value) || value < -5 || value > 45) {
      throw new Error('水温は−5〜45°Cの範囲で入力してください。');
    }
    // 自動処理はnote:の1行を読むため、複数行の備考も1行へまとめる。
    var text = String(note || '').trim().replace(/\s+/g, ' ');
    if (text.length > 1000) throw new Error('備考は1000文字以内で入力してください。');
    return { title: 'temp: ' + date + ' ' + value.toFixed(1), body: text ? 'note: ' + text : '' };
  }

  function requestError(status, posting) {
    if (status === 401) return new Error('トークンが無効、または期限切れです。登録用トークンを再設定してください。');
    if (status === 403) return new Error('GitHubがアクセスを拒否しました。トークンのIssues書き込み権限・承認状態を確認してください。利用制限の場合は時間をおいてください。');
    if (status === 404) return new Error('対象リポジトリにアクセスできません。トークンの対象にibaraki-watertempを選択してください。');
    if (status === 429) return new Error('GitHubの利用制限に達しました。時間をおいてから再度お試しください。');
    if (status === 422) return new Error('GitHubが登録を受け付けませんでした。入力内容を確認し、時間をおいて再度お試しください。');
    if (posting) return new Error('送信結果を確認できません。下の「記録の受付・処理状況」で登録の有無を確認してから再送してください。');
    return new Error('GitHubへの接続を確認できませんでした。通信状態を確認してください。水温はまだ送信していません。');
  }

  async function request(token, path, payload) {
    var posting = payload !== undefined;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    try {
      var response;
      try {
        response = await fetch('https://api.github.com' + path, {
          method: posting ? 'POST' : 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: 'Bearer ' + token,
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json'
          },
          body: posting ? JSON.stringify(payload) : undefined,
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          signal: controller.signal
        });
      } catch (err) {
        throw requestError(0, posting);
      }
      if (response.status !== (posting ? 201 : 200)) throw requestError(response.status, posting);
      try { return await response.json(); }
      catch (err) { throw requestError(0, posting); }
    } finally {
      clearTimeout(timer);
    }
  }

  async function verifyOwner(token) {
    if (!/^github_pat_[A-Za-z0-9_]+$/.test(token)) {
      throw new Error('github_pat_で始まるFine-grained tokenを入力してください。');
    }
    var user = await request(token, '/user');
    if (!user || String(user.login).toLowerCase() !== OWNER) {
      throw new Error('このサイトへの記録は所有者tanyeeeのトークンが必要です。');
    }
  }

  async function register(token, record) {
    await verifyOwner(token);
    var issue = await request(token, ISSUES_PATH, record);
    if (!issue || !Number.isSafeInteger(issue.number) || issue.number <= 0) throw requestError(0, true);
    return issue.number;
  }

  return { buildRecord: buildRecord, verifyOwner: verifyOwner, register: register };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TapwaterRegistration;

(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  var TOKEN_KEY = 'tapwater_github_token_v1';
  var VALUE_KEY = 'tapwater_last_value';
  var token = '';
  var busy = false;
  var lastAccepted = null;
  var settings = document.getElementById('token-settings');
  var tokenForm = document.getElementById('token-form');
  var tokenInput = document.getElementById('token-input');
  var tokenStatus = document.getElementById('token-status');
  var tokenState = document.getElementById('token-state');
  var forget = document.getElementById('token-forget');
  var form = document.getElementById('temp-form');
  var status = document.getElementById('status-text');
  var dateInput = document.getElementById('date-input');
  var valueInput = document.getElementById('value-input');
  var noteInput = document.getElementById('note-input');
  var submit = document.getElementById('register-button');

  try {
    token = window.localStorage.getItem(TOKEN_KEY) || '';
    var lastValue = window.localStorage.getItem(VALUE_KEY);
    if (lastValue) valueInput.placeholder = '前回: ' + lastValue + '°C';
  } catch (err) { /* 保存不可でも設定したトークンをこの画面内で使える */ }
  dateInput.value = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  settings.open = !token;
  updateTokenState();

  function updateTokenState() {
    tokenState.textContent = token ? '設定済み' : '未設定';
    forget.disabled = busy || !token;
  }

  function message(element, text, error) {
    element.textContent = text;
    element.classList.toggle('error', !!error);
  }

  function setBusy(value) {
    busy = value;
    document.querySelectorAll('#temp-form input, #temp-form textarea, #temp-form button, #token-form input, #token-form button').forEach(function (element) {
      element.disabled = value;
    });
    form.setAttribute('aria-busy', String(value));
    updateTokenState();
  }

  tokenForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy || !tokenForm.reportValidity()) return;
    var candidate = tokenInput.value.trim();
    setBusy(true);
    message(tokenStatus, 'アカウントを確認しています…');
    try {
      await TapwaterRegistration.verifyOwner(candidate);
      token = candidate;
      tokenInput.value = '';
      try {
        window.localStorage.setItem(TOKEN_KEY, token);
        message(tokenStatus, 'この端末に保存しました。水温を入力して登録できます。');
        settings.open = false;
      } catch (err) {
        message(tokenStatus, 'ブラウザに保存できませんでした。この画面を閉じるまで利用できます。');
      }
      message(status, 'トークンを設定しました。日付と水温を入力して登録してください。');
    } catch (err) {
      tokenInput.value = '';
      message(tokenStatus, err.message, true);
    } finally { setBusy(false); }
  });

  forget.addEventListener('click', function () {
    if (busy) return;
    token = '';
    tokenInput.value = '';
    try {
      window.localStorage.removeItem(TOKEN_KEY);
      message(tokenStatus, '保存したトークンを削除しました。');
    } catch (err) {
      message(tokenStatus, '保存領域から削除できませんでした。ブラウザのサイトデータを削除してください。', true);
    }
    updateTokenState();
  });

  function accepted(number, repeated) {
    message(status, repeated ? '同じ内容はすでに受け付けています。' : '受付完了。自動処理後、数分でグラフに反映されます。');
    var link = document.createElement('a');
    link.href = 'https://github.com/tanyeee/ibaraki-watertemp/issues/' + number;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = ' 処理状況を見る';
    status.appendChild(link);
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    if (!token) {
      settings.open = true;
      message(status, '最初に登録用トークンを設定してください。', true);
      tokenInput.focus();
      return;
    }
    var record;
    try { record = TapwaterRegistration.buildRecord(dateInput.value, valueInput.value, noteInput.value); }
    catch (err) { message(status, err.message, true); return; }
    var signature = JSON.stringify(record);
    if (lastAccepted && lastAccepted.signature === signature) {
      accepted(lastAccepted.number, true);
      return;
    }
    var submittedValue = Number(valueInput.value).toFixed(1);
    setBusy(true);
    submit.textContent = '送信中…';
    message(status, 'GitHubへ送信しています…');
    try {
      var number = await TapwaterRegistration.register(token, record);
      lastAccepted = { signature: signature, number: number };
      try { window.localStorage.setItem(VALUE_KEY, submittedValue); } catch (err) { /* 任意保存 */ }
      accepted(number, false);
    } catch (err) {
      message(status, err.message, true);
    } finally {
      submit.textContent = '登録';
      setBusy(false);
    }
  });
})();
