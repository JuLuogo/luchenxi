/*!
 * tests/anchors.js — 打印关键函数/字段的当前行号（改代码后修文档行号引用用）
 *   node tests/anchors.js [文件关键字]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const WATCH = {
  'assets/js/sync.js': [
    /function snapshot\(/, /function sendNow\(/, /function sendDump\(/, /function requestDump\(/,
    /function push\(/, /hasAnswer:/, /answerKey:/, /tierWeights:/, /questionIndex:/, /reveal: revealed/,
    /^  CI\.sync = /
  ],
  'assets/js/classroom.js': [
    /function handleCmd\(/, /function addBuzz\(/, /function addPending\(/, /function resolvePending\(/,
    /function dropPending\(/, /function clearBuzz\(/, /function clearFeed\(/, /function setAccepting\(/,
    /function setReveal\(/, /function isRevealed\(/, /function moveQuestion\(/, /function loadRemoteState\(/,
    /function applyRemote\(/, /function renderControl\(/, /function restoreFromHub\(/, /function metaPayload\(/,
    /function toggleAccepting\(/, /function toggleReveal\(/, /^  CI\.classroom = /,
    /onclick="CI\.classroom\.toggleAccepting/, /onclick="CI\.classroom\.toggleReveal/,
    /onclick="CI\.classroom\.moveQuestion/
  ],
  'assets/js/store.js': [
    /function normalizeQuestion\(/, /function computePoints\(/, /function recordResult\(/, /function normalize\(/,
    /function shortStem\(/, /function bulkImportQuestions\(/, /function exportBank\(/, /function updateSettings\(/,
    /^  CI\.store = /, /source: r\.source \|\|/, /VERSION = /
  ],
  'assets/js/admin.js': [
    /function init\(/, /function maybeOfferRestore\(/, /function quickTier\(/, /function undoLast\(/,
    /function renderAll\(/, /CI\.sync\.init\(\{/
  ],
  'assets/js/student.js': [
    /function submit\(/, /function renderQA\(/, /function pickTeam\(/, /setConn\('on'/
  ],
  'sync-server.js': [
    /function getRoom\(/, /function pushPresence\(/, /function handleHttp\(/, /msg\.type === 'dump'/, /msg\.type === 'cmd'/
  ]
};

const filter = process.argv[2] || '';

Object.keys(WATCH).forEach((file) => {
  if (filter && file.indexOf(filter) < 0) return;
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
  console.log('\n=== ' + file + ' （共 ' + lines.length + ' 行） ===');
  lines.forEach((text, i) => {
    if (WATCH[file].some((re) => re.test(text))) {
      console.log('  ' + String(i + 1).padStart(4) + ': ' + text.trim().slice(0, 92));
    }
  });
});
