'use strict';
var assert = require('node:assert/strict');
var registration = require('../input.js');
var token = 'github_pat_test_fixture';
var originalFetch = global.fetch;

async function run() {
  var record = registration.buildRecord('2026-11-04', '18.2', '朝に測定\n晴れ');
  assert.deepEqual(record, { title: 'temp: 2026-11-04 18.2', body: 'note: 朝に測定 晴れ' });
  assert.throws(function () { registration.buildRecord('2026-02-30', '18', ''); }, /日付/);
  ['', 'Infinity', '46', '-6'].forEach(function (value) {
    assert.throws(function () { registration.buildRecord('2026-11-04', value, ''); }, /水温/);
  });
  var calls = [];
  global.fetch = async function (url, options) {
    calls.push({ url: url, options: options });
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(url.includes(token), false);
    return { status: options.method === 'POST' ? 201 : 200, json: async function () {
      return options.method === 'POST' ? { number: 123 } : { login: 'tanyeee' };
    } };
  };
  assert.equal(await registration.register(token, record), 123);
  assert.deepEqual(calls.map(function (call) { return call.url; }), [
    'https://api.github.com/user', 'https://api.github.com/repos/tanyeee/ibaraki-watertemp/issues'
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), record);

  calls = [];
  global.fetch = async function (url) {
    calls.push(url);
    return { status: 200, json: async function () { return { login: 'someone-else' }; } };
  };
  await assert.rejects(registration.register(token, record), /所有者/);
  assert.equal(calls.length, 1); // 別アカウントではIssueを作成しない。
  await assert.rejects(registration.verifyOwner('not-a-token'), /Fine-grained/);
  assert.equal(calls.length, 1);

  for (var status of [401, 403, 404, 422, 429, 500, 0]) {
    calls = [];
    global.fetch = async function (url, options) {
      calls.push(url);
      if (options.method === 'GET') return { status: 200, json: async function () { return { login: 'tanyeee' }; } };
      if (!status) throw new Error('network failure');
      return { status: status };
    };
    await assert.rejects(registration.register(token, record), status === 0 || status === 500 ? /送信結果を確認できません/ : /トークン|GitHub|リポジトリ/);
    assert.equal(calls.length, 2); // POSTの不明な結果を自動再送しない。
  }
  console.log('TapwaterRegistration validation, owner check, fixed API destination, payload, failures/no retry: OK');
}
run().catch(function (error) { console.error(error); process.exitCode = 1; })
  .finally(function () { global.fetch = originalFetch; });
