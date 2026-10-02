/*!
 * bank.js — 题库管理：题目增删改查、题型权重设置、JSON/CSV/文本批量导入、题库导出
 * 渲染容器（admin.html 提供）：#bankToolbar #tierPanel #bankList #bankImport #bankModal
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};
  var U = CI.util;
  var doc = root.document || null;

  var filter = { keyword: '', tier: 'all', tag: 'all', sortBy: 'createdAt' };

  function el(id) { return doc ? doc.getElementById(id) : null; }

  /* ------------------------------------------------------------------ *
   * 过滤与排序
   * ------------------------------------------------------------------ */

  function visibleQuestions(s) {
    var kw = filter.keyword.trim().toLowerCase();
    var list = s.bank.filter(function (q) {
      if (filter.tier !== 'all' && q.tier !== filter.tier) return false;
      if (filter.tag !== 'all' && q.tags.indexOf(filter.tag) < 0) return false;
      if (kw) {
        var hay = (q.stem + ' ' + q.answer + ' ' + q.tags.join(' ') + ' ' + q.source + ' ' + q.note).toLowerCase();
        if (hay.indexOf(kw) < 0) return false;
      }
      return true;
    });
    if (filter.sortBy === 'tier') {
      var order = s.tiers.map(function (t) { return t.key; });
      list.sort(function (a, b) { return order.indexOf(a.tier) - order.indexOf(b.tier) || a.createdAt - b.createdAt; });
    } else if (filter.sortBy === 'points') {
      list.sort(function (a, b) { return CI.store.questionPoints(s, b) - CI.store.questionPoints(s, a); });
    } else {
      list.sort(function (a, b) { return b.createdAt - a.createdAt; });
    }
    return list;
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function renderToolbar() {
    var s = CI.store.get();
    var box = el('bankToolbar');
    if (!box) return;

    var tierOpts = ['<option value="all">全部题型</option>'].concat(s.tiers.map(function (t) {
      return '<option value="' + t.key + '"' + (filter.tier === t.key ? ' selected' : '') + '>' +
        U.escapeHTML(t.label) + '（' + t.weight + '分）</option>';
    })).join('');

    var tagOpts = ['<option value="all">全部知识点</option>'].concat(s.tags.map(function (t) {
      return '<option value="' + U.escapeHTML(t) + '"' + (filter.tag === t ? ' selected' : '') + '>' + U.escapeHTML(t) + '</option>';
    })).join('');

    var counts = {};
    s.tiers.forEach(function (t) { counts[t.key] = 0; });
    s.bank.forEach(function (q) { counts[q.tier] = (counts[q.tier] || 0) + 1; });
    var chipHtml = s.tiers.map(function (t) {
      return '<span class="chip" style="border-color:' + t.color + '">' + U.escapeHTML(t.label) + ' ' + (counts[t.key] || 0) + ' 题</span>';
    }).join('');

    box.innerHTML =
      '<div class="bank-toolbar-row">' +
        '<input type="search" id="bankSearch" placeholder="搜索题干 / 答案 / 知识点" value="' + U.escapeHTML(filter.keyword) + '">' +
        '<select id="bankTierFilter">' + tierOpts + '</select>' +
        '<select id="bankTagFilter">' + tagOpts + '</select>' +
        '<select id="bankSort">' +
          '<option value="createdAt"' + (filter.sortBy === 'createdAt' ? ' selected' : '') + '>按录入时间</option>' +
          '<option value="tier"' + (filter.sortBy === 'tier' ? ' selected' : '') + '>按题型分组</option>' +
          '<option value="points"' + (filter.sortBy === 'points' ? ' selected' : '') + '>按分值高低</option>' +
        '</select>' +
        '<button class="btn btn-plus" onclick="CI.bankUI.openEditor()">＋ 新增题目</button>' +
        '<button class="btn" onclick="CI.bankUI.toggleImport(true)">批量导入</button>' +
        '<button class="btn" onclick="CI.bankUI.exportJSON()">导出题库</button>' +
      '</div>' +
      '<div class="bank-toolbar-row chip-row">' + chipHtml + '<span class="chip">共 ' + s.bank.length + ' 题</span></div>';

    var search = el('bankSearch');
    if (search) search.oninput = function () { filter.keyword = this.value; renderList(); };
    var tf = el('bankTierFilter');
    if (tf) tf.onchange = function () { filter.tier = this.value; renderList(); };
    var gf = el('bankTagFilter');
    if (gf) gf.onchange = function () { filter.tag = this.value; renderList(); };
    var so = el('bankSort');
    if (so) so.onchange = function () { filter.sortBy = this.value; renderList(); };
  }

  function renderList() {
    var s = CI.store.get();
    var box = el('bankList');
    if (!box) return;
    var list = visibleQuestions(s);
    if (!list.length) {
      box.innerHTML = '<div class="empty">' + (s.bank.length ? '没有符合条件的题目' : '题库还是空的，点「新增题目」或「批量导入」开始建库') + '</div>';
      return;
    }
    var order = s.tiers.map(function (t) { return t.key; });
    box.innerHTML = list.map(function (q) {
      var t = CI.store.tierOf(s, q.tier);
      var eff = CI.store.questionPoints(s, q);
      var used = s.quizzes.filter(function (qz) { return qz.questionIds.indexOf(q.id) >= 0; }).length;
      var ansCount = s.quizzes.reduce(function (n, qz) {
        return n + qz.records.filter(function (r) { return r.qid === q.id; }).length;
      }, 0);
      return '<div class="q-item" style="border-left-color:' + t.color + '">' +
        '<div class="q-main">' +
          '<div class="q-stem">' + U.escapeHTML(q.stem || '（空题干）') + '</div>' +
          '<div class="q-meta">' +
            '<span class="tag" style="background:' + t.color + '22;color:' + t.color + '">' + U.escapeHTML(t.label) + '</span>' +
            '<span class="tag tag-points">' + eff + ' 分' + (q.points === null ? '（继承题型）' : '（自定义）') + '</span>' +
            '<span class="tag tag-plain">' + U.escapeHTML(CI.grade.typeLabel(q)) + (q.options && q.options.length ? '（' + q.options.length + ' 项）' : '') + '</span>' +
            q.tags.map(function (x) { return '<span class="tag tag-plain">' + U.escapeHTML(x) + '</span>'; }).join('') +
            (q.source ? '<span class="tag tag-plain">来源 ' + U.escapeHTML(q.source) + '</span>' : '') +
            (ansCount ? '<span class="tag tag-plain">已作答 ' + ansCount + ' 次</span>' : '') +
            (used ? '<span class="tag tag-plain">在 ' + used + ' 套试卷中</span>' : '') +
          '</div>' +
          (q.answer ? '<div class="q-answer">答案：' + U.escapeHTML(q.answer) + '</div>' : '') +
        '</div>' +
        '<div class="q-actions">' +
          '<button class="mini-btn" onclick="CI.quizUI.addToCurrent(\'' + q.id + '\')" title="加入当前试卷">加入试卷</button>' +
          '<button class="mini-btn" onclick="CI.bankUI.openEditor(\'' + q.id + '\')">编辑</button>' +
          '<button class="mini-btn mini-danger" onclick="CI.bankUI.remove(\'' + q.id + '\')">删除</button>' +
        '</div>' +
      '</div>';
    }).join('') + '<div class="bank-foot">共 ' + s.bank.length + ' 题，当前显示 ' + list.length + ' 题（题型顺序：' +
      order.map(function (k) { return U.escapeHTML(CI.store.tierOf(s, k).label); }).join(' → ') + '）</div>';
  }

  function renderTierPanel() {
    var s = CI.store.get();
    var box = el('tierPanel');
    if (!box) return;
    box.innerHTML =
      '<div class="panel-title">题型与加权分值 <span class="panel-sub">（答对该题型题目所加的基础分，可直接修改；改后新记录按新分值计算，历史记录不变）</span></div>' +
      '<div class="tier-list">' +
      s.tiers.map(function (t) {
        var n = s.bank.filter(function (q) { return q.tier === t.key; }).length;
        return '<div class="tier-row" style="border-left-color:' + t.color + '">' +
          '<input class="tier-label" value="' + U.escapeHTML(t.label) + '" onchange="CI.bankUI.saveTier(\'' + t.key + '\',{label:this.value})">' +
          '<div class="tier-weight"><input type="number" step="0.5" min="0" value="' + t.weight + '" onchange="CI.bankUI.saveTier(\'' + t.key + '\',{weight:Number(this.value)})"><span>分</span></div>' +
          '<input type="color" value="' + t.color + '" onchange="CI.bankUI.saveTier(\'' + t.key + '\',{color:this.value})">' +
          '<input class="tier-desc" value="' + U.escapeHTML(t.desc) + '" placeholder="说明（可选）" onchange="CI.bankUI.saveTier(\'' + t.key + '\',{desc:this.value})">' +
          '<span class="tier-count">' + n + ' 题</span>' +
          '<button class="mini-btn mini-danger" onclick="CI.bankUI.removeTier(\'' + t.key + '\')">删除</button>' +
          '</div>';
      }).join('') +
      '</div>' +
      '<div class="tier-actions">' +
        '<button class="btn" onclick="CI.bankUI.addTier()">＋ 新增题型</button>' +
        '<button class="btn" onclick="CI.bankUI.openSettings()">计分口径设置</button>' +
        '<span class="hint-inline">当前计分：答对 = 基准分；部分正确 = 基准分 × ' + U.num(s.settings.halfRatio, 0.5) +
        '；答错 ' + (U.num(s.settings.wrongPenalty, 0) ? ('扣 ' + s.settings.wrongPenalty + ' 分') : '不扣分') +
        (U.num(s.settings.fastBonus, 0) ? ('；抢答额外 +' + s.settings.fastBonus) : '') + '</span>' +
      '</div>';
  }

  /* ------------------------------------------------------------------ *
   * 编辑弹窗
   * ------------------------------------------------------------------ */

  function openEditor(qid) {
    var s = CI.store.get();
    var q = qid ? CI.store.question(s, qid) : null;
    var box = el('bankModal');
    if (!box) return;

    var tierOpts = s.tiers.map(function (t) {
      return '<option value="' + t.key + '"' + (q && q.tier === t.key ? ' selected' : '') + '>' +
        U.escapeHTML(t.label) + '（默认 ' + t.weight + ' 分）</option>';
    }).join('');

    var hasOptions = !!(q && q.options && q.options.length);
    var kind = hasOptions ? 'choice' : 'auto';

    box.innerHTML =
      '<div class="modal-mask" onclick="CI.bankUI.closeEditor()"></div>' +
      '<div class="modal-box">' +
        '<div class="modal-head"><b>' + (q ? '编辑题目' : '新增题目') + '</b>' +
          '<button class="mini-btn" onclick="CI.bankUI.closeEditor()">✕</button></div>' +
        '<div class="modal-body">' +
          '<label class="fld"><span>题干 *</span><textarea id="qStem" rows="3" placeholder="例如：已知集合 A={x|x²-3x+2=0}，求 A 的子集个数">' + U.escapeHTML(q ? q.stem : '') + '</textarea></label>' +
          '<div class="fld-row">' +
            '<label class="fld"><span>题型（决定加权分）</span><select id="qTier">' + tierOpts + '</select></label>' +
            '<label class="fld"><span>自定义分值（留空=继承题型）</span><input type="number" id="qPoints" step="0.5" min="0" value="' + (q && q.points !== null ? q.points : '') + '" placeholder="继承题型权重"></label>' +
            '<label class="fld"><span>题目类型</span><select id="qKind" onchange="CI.bankUI.toggleKind()">' +
              '<option value="auto"' + (kind === 'auto' ? ' selected' : '') + '>填空题 / 主观题</option>' +
              '<option value="choice"' + (kind === 'choice' ? ' selected' : '') + '>选择题（学生端可点选、自动判分）</option>' +
            '</select></label>' +
          '</div>' +
          '<label class="fld" id="qOptionsWrap" style="' + (kind === 'choice' ? '' : 'display:none') + '">' +
            '<span>选项（每行一个，自动编号 A / B / C…）</span>' +
            '<textarea id="qOptions" rows="4" placeholder="甲&#10;乙&#10;丙&#10;丁">' + U.escapeHTML(q && q.options ? q.options.join('\n') : '') + '</textarea></label>' +
          '<label class="fld"><span id="qAnswerLabel">参考答案</span><input id="qAnswer" value="' + U.escapeHTML(q ? q.answer : '') + '" placeholder="选择题填字母（如 B 或 AC）；填空题可用 | 分隔多个等价答案"></label>' +
          '<div class="fld-row">' +
            '<label class="fld"><span>知识点（逗号分隔）</span><input id="qTags" value="' + U.escapeHTML(q ? q.tags.join('，') : '') + '" list="tagOptions"><datalist id="tagOptions">' +
              s.tags.map(function (t) { return '<option value="' + U.escapeHTML(t) + '">'; }).join('') + '</datalist></label>' +
            '<label class="fld"><span>来源 / 出处</span><input id="qSource" value="' + U.escapeHTML(q ? q.source : '') + '" placeholder="如：2024 真题 第 7 题"></label>' +
          '</div>' +
          '<label class="fld"><span>备注</span><input id="qNote" value="' + U.escapeHTML(q ? q.note : '') + '" placeholder="讲评要点、易错点…"></label>' +
          '<div class="hint-inline">选择题在「课堂协同」里由学生端点选自动判分（多选漏选算部分正确）；填空/主观题由老师判定。</div>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn" onclick="CI.bankUI.closeEditor()">取消</button>' +
          '<button class="btn btn-plus" onclick="CI.bankUI.saveEditor(' + (q ? ("'" + q.id + "'") : 'null') + ')">保存</button>' +
        '</div>' +
      '</div>' +
      '<datalist id="tagOptions">' + s.tags.map(function (t) { return '<option value="' + U.escapeHTML(t) + '">'; }).join('') + '</datalist>';
    box.style.display = 'flex';
    toggleKind();
  }

  /** 题目类型切换：选择题才显示选项框 */
  function toggleKind() {
    var kindEl = el('qKind');
    var wrap = el('qOptionsWrap');
    var label = el('qAnswerLabel');
    var answer = el('qAnswer');
    if (!kindEl || !wrap) return;
    var isChoice = kindEl.value === 'choice';
    wrap.style.display = isChoice ? '' : 'none';
    if (label) label.textContent = isChoice ? '参考答案（字母，如 B 或 AC）' : '参考答案（填空题可用 | 分隔多个等价答案）';
    if (answer) answer.placeholder = isChoice ? '例如：B 或 AC' : '例如：x=1|x = 1';
  }

  function closeEditor() {
    var box = el('bankModal');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  }

  function saveEditor(qid) {
    var stem = (el('qStem') || {}).value || '';
    if (!stem.trim()) { alert('题干不能为空'); return; }
    var kind = (el('qKind') || {}).value || 'auto';
    var options = kind === 'choice'
      ? String((el('qOptions') || {}).value || '').split(/\r?\n/)
          .map(function (x) { return x.replace(/^\s*[A-Za-z][.、:：)）]\s*/, '').trim(); })
          .filter(function (x) { return !!x; })
      : [];
    if (kind === 'choice') {
      if (options.length < 2) { alert('选择题至少要有 2 个选项'); return; }
      var letters = CI.grade.parseChoice((el('qAnswer') || {}).value);
      if (!letters.length) { alert('请填写正确答案的字母，例如 B 或 AC'); return; }
      if (letters.some(function (k) { return CI.grade.LETTERS.indexOf(k) >= options.length; })) {
        alert('答案字母超出了选项范围（当前 ' + options.length + ' 个选项：A~' + CI.grade.LETTERS[options.length - 1] + '）');
        return;
      }
    }
    var data = {
      stem: stem.trim(),
      tier: (el('qTier') || {}).value,
      points: (el('qPoints') || {}).value === '' ? null : Number((el('qPoints') || {}).value),
      answer: (el('qAnswer') || {}).value || '',
      options: options,
      tags: String((el('qTags') || {}).value || '').split(/[,，、;；\s]+/).filter(function (x) { return !!x; }),
      source: (el('qSource') || {}).value || '',
      note: (el('qNote') || {}).value || ''
    };
    if (qid) CI.store.updateQuestion(qid, data);
    else CI.store.addQuestion(data);
    // 知识点入库内存
    var s = CI.store.get();
    var newTags = data.tags.filter(function (t) { return s.tags.indexOf(t) < 0; });
    if (newTags.length) { s.tags = s.tags.concat(newTags); CI.store.commit('tags'); }
    closeEditor();
  }

  /* ------------------------------------------------------------------ *
   * 批量导入
   * ------------------------------------------------------------------ */

  function toggleImport(show) {
    var box = el('bankImport');
    if (!box) return;
    if (!show) { box.style.display = 'none'; box.innerHTML = ''; return; }
    var s = CI.store.get();
    box.style.display = 'block';
    box.innerHTML =
      '<div class="panel-title">批量导入题目</div>' +
      '<div class="import-grid">' +
        '<label class="fld"><span>默认题型</span><select id="impTier">' +
          s.tiers.map(function (t) { return '<option value="' + t.key + '">' + U.escapeHTML(t.label) + '（' + t.weight + ' 分）</option>'; }).join('') +
        '</select></label>' +
        '<label class="fld"><span>选择文件（.json / .csv / .txt）</span><input type="file" id="impFile" accept=".json,.csv,.txt"></label>' +
        '<label class="fld fld-check"><input type="checkbox" id="impDedupe" checked> 跳过题干完全相同的重复题</label>' +
      '</div>' +
      '<label class="fld"><span>或直接粘贴：每行一题，支持 <code>题干 | 答案</code>、<code>题干,答案</code>、JSON 数组</span>' +
        '<textarea id="impText" rows="6" placeholder="基础题示例：&#10;已知集合A={1,2}，子集个数为？ | 4&#10;函数 y=x² 的对称轴是？ | x=0"></textarea></label>' +
      '<div class="import-actions">' +
        '<button class="btn btn-plus" onclick="CI.bankUI.doImport()">开始导入</button>' +
        '<button class="btn" onclick="CI.bankUI.toggleImport(false)">取消</button>' +
        '<button class="btn" onclick="CI.bankUI.downloadTemplate()">下载模板</button>' +
      '</div>' +
      '<div id="impResult" class="import-result"></div>';

    var file = el('impFile');
    if (file) file.onchange = function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var ta = el('impText');
        if (ta) ta.value = String(reader.result || '');
      };
      reader.readAsText(f, 'utf-8');
    };
  }

  /** 把文本解析成题目数组：优先 JSON，其次 CSV/管道分隔的逐行文本 */
  function parseImport(text) {
    var raw = String(text || '').trim();
    if (!raw) return [];
    if (raw[0] === '[' || raw[0] === '{') {
      var data = JSON.parse(raw);
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.questions)) return data.questions;
      if (data && data.stem) return [data];
      return [];
    }
    return raw.split(/\r?\n/).map(function (line) {
      var t = line.trim();
      if (!t) return null;
      var parts = t.split(/\s*[|｜]\s*/);
      if (parts.length < 2) parts = t.split(/\t+/);
      // 选择题写法：题干 | 选项1 ; 选项2 ; 选项3 | 答案字母
      if (parts.length >= 3) {
        var last = parts[parts.length - 1].trim();
        if (/^[A-Ha-h][A-Ha-h,，、\s]*$/.test(last)) {
          var opts = parts.slice(1, parts.length - 1).join(' ; ')
            .split(/\s*[;；]\s*/)
            .map(function (x) { return x.replace(/^\s*[A-Ha-h][.、:：)）]\s*/, '').trim(); })
            .filter(function (x) { return !!x; });
          if (opts.length >= 2) {
            return { stem: parts[0].trim(), options: opts, answer: last.toUpperCase() };
          }
        }
      }
      if (parts.length < 2) {
        var m = t.match(/^(.+?)[,，]\s*([^,，]*)$/);
        if (m) parts = [m[1], m[2]];
      }
      var stem = parts[0];
      var answer = parts.length > 1 ? parts.slice(1).join(' / ') : '';
      // 支持 “基础题：题干 | 答案” 这种带题型前缀的写法
      var tierHit = null;
      var s = CI.store.get();
      var m2 = stem.match(/^(基础|拔高|扩展|提升|基础题|拔高题|扩展题|提升题)\s*[:：]\s*(.+)$/);
      if (m2) {
        var label = m2[1].indexOf('题') < 0 ? (m2[1] + '题') : m2[1];
        var hit = s.tiers.filter(function (x) { return x.label === label; })[0];
        if (hit) { tierHit = hit.key; stem = m2[2]; }
      }
      return { stem: stem.trim(), answer: String(answer || '').trim(), tier: tierHit };
    }).filter(Boolean);
  }

  function doImport() {
    var ta = el('impText');
    var text = ta ? ta.value : '';
    var defTier = (el('impTier') || {}).value;
    var dedupe = el('impDedupe') ? el('impDedupe').checked : true;
    var list;
    try {
      list = parseImport(text);
    } catch (e) {
      alert('解析失败：' + e.message);
      return;
    }
    if (!list.length) { alert('没有解析到题目'); return; }
    list.forEach(function (q) { if (!q.tier) q.tier = defTier; });

    // 导入前自检：选择题答案写成选项原文（如 `8` 而不是 `B`）会**静默判所有提交为答错**，
    // 这种错很难在课堂上发现，所以在入库前明确提示（老师可选择"仍然导入"）。
    var issues = [];
    list.forEach(function (q, i) {
      var v = CI.grade.validateQuestion(q);
      if (!v.ok) issues.push('第 ' + (i + 1) + ' 题「' + U.shortStem(q.stem, 18) + '」：' + v.warnings.join('；'));
    });
    if (issues.length) {
      var preview = issues.slice(0, 5).join('\n') + (issues.length > 5 ? '\n…（共 ' + issues.length + ' 题有问题）' : '');
      if (!root.confirm('发现 ' + issues.length + ' 处会导致判分异常的问题：\n\n' + preview + '\n\n仍然导入吗？（建议先改好再导入）')) return;
    }

    var res = CI.store.bulkImportQuestions(list, { dedupe: dedupe });
    var out = el('impResult');
    if (out) {
      out.innerHTML = '导入完成：新增 <b>' + res.added + '</b> 题，跳过 <b>' + res.skipped + '</b> 题。' +
        (issues.length ? '<br><span style="color:#b3261e">⚠️ 其中 ' + issues.length + ' 处判分风险见上（选择题答案必须是字母）</span>' : '');
    }
    renderToolbar(); renderList(); renderTierPanel();
  }

  function downloadTemplate() {
    var s = CI.store.get();
    var sample = s.tiers.map(function (t, i) {
      return { tier: t.key, tierLabel: t.label, points: null, stem: '【' + t.label + '示例】请替换为真实题干' + (i + 1), answer: '参考答案', tags: ['示例'], source: '', note: '' };
    });
    U.download('题库导入模板.json', JSON.stringify({ type: 'ci-question-bank', version: 2, questions: sample }, null, 2));
  }

  function exportJSON() {
    var data = CI.store.exportBank();
    var stamp = new Date().toISOString().slice(0, 10);
    U.download('题库_' + stamp + '.json', JSON.stringify(data, null, 2));
  }

  /* ------------------------------------------------------------------ *
   * 题型 / 设置
   * ------------------------------------------------------------------ */

  function saveTier(key, patch) { CI.store.updateTier(key, patch); }

  function addTier() {
    var label = prompt('新题型名称（例如：综合应用题）');
    if (!label) return;
    var w = prompt('该题型答对加多少分？', '6');
    if (w === null) return;
    CI.store.addTier({ label: label, weight: Number(w) || 1, color: '#607d8b' });
  }

  function removeTier(key) {
    var s = CI.store.get();
    var t = CI.store.tierOf(s, key);
    if (!confirm('确定删除题型「' + t.label + '」？')) return;
    var res = CI.store.removeTier(key);
    if (res && res.ok === false) alert(res.reason);
  }

  function openSettings() {
    var s = CI.store.get();
    var box = el('bankModal');
    if (!box) return;
    var st = s.settings;
    box.innerHTML =
      '<div class="modal-mask" onclick="CI.bankUI.closeEditor()"></div>' +
      '<div class="modal-box">' +
        '<div class="modal-head"><b>计分口径与学情阈值</b><button class="mini-btn" onclick="CI.bankUI.closeEditor()">✕</button></div>' +
        '<div class="modal-body">' +
          '<label class="fld"><span>课程名称（大屏标题）</span><input id="setCourse" value="' + U.escapeHTML(st.courseName || '') + '"></label>' +
          '<div class="fld-row">' +
            '<label class="fld"><span>部分正确计分系数</span><input type="number" id="setHalf" step="0.1" min="0" max="1" value="' + U.num(st.halfRatio, 0.5) + '"></label>' +
            '<label class="fld"><span>答错扣分</span><input type="number" id="setWrong" step="0.5" min="0" value="' + U.num(st.wrongPenalty, 0) + '"></label>' +
          '</div>' +
          '<div class="fld-row">' +
            '<label class="fld"><span>抢答额外加分（仅答对时）</span><input type="number" id="setFast" step="0.5" min="0" value="' + U.num(st.fastBonus, 0) + '"></label>' +
            '<label class="fld"><span>抢答名次加分（逗号分隔，第1/第2名…）</span><input id="setRankBonus" placeholder="留空=不启用；例：2,1" value="' + U.escapeHTML((Array.isArray(st.buzzRankBonuses) ? st.buzzRankBonuses : []).join(',')) + '"></label>' +
          '</div>' +
          '<div class="fld-row">' +
            '<label class="fld"><span>快捷加分是否计入统计</span><select id="setQuickCount">' +
              '<option value="1"' + (st.quickCountsAsAttempt !== false ? ' selected' : '') + '>计入（视为该题型答对一次）</option>' +
              '<option value="0"' + (st.quickCountsAsAttempt === false ? ' selected' : '') + '>只加分，不计入正确率</option>' +
            '</select></label>' +
            '<label class="fld"><span>&nbsp;</span><span class="hint-inline">填了名次分后，抢答答对按名次加分，不再叠加上面的「抢答额外加分」。</span></label>' +
          '</div>' +
          '<div class="fld-row">' +
            '<label class="fld"><span>薄弱阈值（得分率低于）</span><input type="number" id="setWeak" step="0.05" min="0" max="1" value="' + U.num(st.weakThreshold, 0.6) + '"></label>' +
            '<label class="fld"><span>优势阈值（得分率高于）</span><input type="number" id="setStrong" step="0.05" min="0" max="1" value="' + U.num(st.strongThreshold, 0.85) + '"></label>' +
            '<label class="fld"><span>最少样本量</span><input type="number" id="setMinSample" min="1" value="' + U.num(st.minSample, 2) + '"></label>' +
          '</div>' +
          '<div class="hint-inline">数值以 0~1 小数填写，例如 0.6 表示 60%。判定薄弱需同时满足「作答次数 ≥ 最少样本量」。</div>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn" onclick="CI.bankUI.closeEditor()">取消</button>' +
          '<button class="btn btn-plus" onclick="CI.bankUI.saveSettings()">保存</button>' +
        '</div>' +
      '</div>';
    box.style.display = 'flex';
  }

  function saveSettings() {
    // 名次加分：逗号/空格分隔的数字；留空 = 不启用（默认关闭，既有行为不变）
    var rankRaw = ((el('setRankBonus') || {}).value || '').trim();
    var rankBonuses = rankRaw
      ? rankRaw.split(/[,，\s]+/).map(function (x) { return Number(x); }).filter(function (x) { return !isNaN(x) && x >= 0; })
      : [];
    CI.store.updateSettings({
      courseName: (el('setCourse') || {}).value || '',
      halfRatio: Number((el('setHalf') || {}).value),
      wrongPenalty: Number((el('setWrong') || {}).value) || 0,
      fastBonus: Number((el('setFast') || {}).value) || 0,
      buzzRankBonuses: rankBonuses,
      quickCountsAsAttempt: (el('setQuickCount') || {}).value === '1',
      weakThreshold: Number((el('setWeak') || {}).value),
      strongThreshold: Number((el('setStrong') || {}).value),
      minSample: Number((el('setMinSample') || {}).value) || 1
    });
    closeEditor();
  }

  function remove(qid) {
    var s = CI.store.get();
    var q = CI.store.question(s, qid);
    if (!q) return;
    if (!confirm('删除题目「' + U.shortStem(q.stem) + '」？已产生的积分流水会保留。')) return;
    CI.store.removeQuestion(qid);
  }

  function render() {
    renderToolbar();
    renderTierPanel();
    renderList();
  }

  CI.bankUI = {
    render: render, renderList: renderList, renderToolbar: renderToolbar, renderTierPanel: renderTierPanel,
    openEditor: openEditor, closeEditor: closeEditor, saveEditor: saveEditor, remove: remove, toggleKind: toggleKind,
    toggleImport: toggleImport, parseImport: parseImport, doImport: doImport,
    downloadTemplate: downloadTemplate, exportJSON: exportJSON,
    saveTier: saveTier, addTier: addTier, removeTier: removeTier,
    openSettings: openSettings, saveSettings: saveSettings,
    getFilter: function () { return filter; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
