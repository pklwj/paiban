/* app.js —— 界面与交互 */
(function () {
  'use strict';

  var Core = window.Core;
  var LS_KEY = 'paiban.v1';

  var state = null;
  var ui = { r: 0, d: 0, er: 0, ed: 0 };  // r/d 锚点，er/ed 拖到的另一端
  var hist = [], future = [];
  var pop = null, popCtx = null;
  var dragging = false, dragMoved = false, wasSelected = false;
  var saveTimer = null;
  var issueItems = [];
  var STORAGE_OK = true;

  function chipList(k) {
    return (state && state.chips && state.chips[k]) || [];
  }

  /* ---------------- 基础工具 ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isField(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }
  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 1900);
  }

  /* ---------------- 存取 ---------------- */
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) { raw = null; }
    if (raw) {
      try {
        var s = JSON.parse(raw);
        if (s && s.staff && s.cells) return normalize(s);
      } catch (e) { /* 坏数据就用示例 */ }
    }
    return Core.fromSeed(window.SEED);
  }

  function normalize(s) {
    var hadPool = Array.isArray(s.dutyPool);
    var base = Core.emptyState();
    Object.keys(base).forEach(function (k) {
      if (s[k] == null) s[k] = base[k];
    });
    var isOld = Number(s.version || 1) < 2;
    s.staff = s.staff.map(function (p) {
      var g = p.group || '';
      if (isOld && !g && window.SEED.groupOf) g = window.SEED.groupOf[p.name] || '';
      return { id: p.id || Core.newStaff().id, name: p.name || '', prefix: p.prefix || '', group: g };
    });
    s.version = 2;
    if (!s.dict.countOnly && s.dict.countOnly !== '') s.dict.countOnly = '医生';

    var defChips = Core.emptyState().chips;
    if (!s.chips) s.chips = { combos: defChips.combos.slice(), shifts: defChips.shifts.slice(), posts: defChips.posts.slice() };
    ['combos', 'shifts', 'posts'].forEach(function (k) {
      if (!Array.isArray(s.chips[k])) s.chips[k] = defChips[k].slice();
    });
    s.staff.forEach(function (p) {
      var arr = s.cells[p.id];
      if (!Array.isArray(arr)) arr = [];
      while (arr.length < 7) arr.push('');
      s.cells[p.id] = arr.slice(0, 7);
      if (s.owed[p.id] == null) s.owed[p.id] = '';
    });
    while (s.duty.length < 7) s.duty.push('');
    while (s.counts.length < 7) s.counts.push('');

    if (!hadPool) {
      s.dutyPool = [];
      s.duty.forEach(function (id) {
        if (id && s.dutyPool.indexOf(id) === -1) s.dutyPool.push(id);
      });
    }
    s.dutyPool = s.dutyPool.filter(function (id) { return !!s.cells[id]; });

    return s;
  }

  function save() {
    if (STORAGE_OK) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        var hint = document.getElementById('saveHint');
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(state));
          if (hint) {
            var d = new Date();
            hint.textContent = '已保存 ' + Core.pad2(d.getHours()) + ':' + Core.pad2(d.getMinutes());
          }
        } catch (e) {
          if (hint) hint.textContent = '保存失败，请用「更多 → 导出 JSON」留底';
        }
      }, 250);
    }
    scheduleFileWrite();
  }

  /* ---------------- U 盘数据文件 ---------------- */
  var fileHandle = null, fileName = '', fileTimer = null;

  function idbOpen() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('paiban-fs', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbPut(k, v) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function idbGet(k) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction('kv', 'readonly');
        var rq = tx.objectStore('kv').get(k);
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function idbDel(k) {
    return idbOpen().then(function (db) {
      var tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(k);
    }).catch(function () {});
  }

  function setFileHint(t) {
    var el = $('#fileHint');
    if (el) el.textContent = t;
  }

  function updateFileHint() {
    setFileHint(fileHandle ? ('文件：' + fileName) : '数据存本机');
  }

  function loadFromText(text) {
    var s = JSON.parse(text);
    if (!s || !s.staff || !s.cells) throw new Error('不是排班数据文件');
    pushHist();
    state = normalize(s);
    render();
    save();
  }

  async function connectFile() {
    if (!window.showOpenFilePicker) {
      toast('当前浏览器不支持直接读写文件，请用「导出 JSON」');
      return;
    }
    var picked;
    try {
      picked = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: '排班数据', accept: { 'application/json': ['.json'] } }]
      });
    } catch (e) {
      return; // 用户取消
    }
    if (!picked || !picked[0]) return;
    var h = picked[0];
    try {
      var perm = await h.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') perm = await h.requestPermission({ mode: 'readwrite' });
      var file = await h.getFile();
      var text = await file.text();
      var loaded = false;
      try { loadFromText(text); loaded = true; } catch (e2) { loaded = false; }
      if (!loaded) {
        if (!confirm('「' + h.name + '」是空文件或不是排班数据，是否用当前表格内容初始化它？')) return;
        fileHandle = h;
        fileName = h.name;
        await writeFileNow();
        idbPut('handle', h).catch(function () {});
        updateFileHint();
        toast('已用当前内容初始化 ' + fileName);
        return;
      }
      fileHandle = h;
      fileName = h.name;
      idbPut('handle', h).catch(function () {});
      updateFileHint();
      toast(perm === 'granted'
        ? '已连接 ' + fileName + '，改动会自动写回'
        : '已读取 ' + fileName + '，但没有写入权限，只能手动另存');
    } catch (e) {
      toast('打开失败：' + e.message);
    }
  }

  function disconnectFile() {
    fileHandle = null;
    fileName = '';
    idbDel('handle');
    updateFileHint();
    toast('已断开，之后只存本机浏览器');
  }

  async function saveAsFile() {
    if (!window.showSaveFilePicker) {
      toast('当前浏览器不支持直接写文件，请用「导出 JSON」');
      return;
    }
    var h;
    try {
      h = await window.showSaveFilePicker({
        suggestedName: '排班数据.json',
        types: [{ description: '排班数据', accept: { 'application/json': ['.json'] } }]
      });
    } catch (e) {
      return;
    }
    fileHandle = h;
    fileName = h.name;
    var ok = await writeFileNow();
    if (ok) {
      idbPut('handle', h).catch(function () {});
      updateFileHint();
      toast('已保存到 ' + fileName + '，之后改动自动写回');
    }
  }

  async function writeFileNow() {
    if (!fileHandle) return false;
    try {
      var perm = await fileHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        setFileHint('文件需重新授权，点这里连接');
        return false;
      }
      var w = await fileHandle.createWritable();
      await w.write(JSON.stringify(state));
      await w.close();
      var d = new Date();
      setFileHint('已写入 ' + fileName + ' ' + Core.pad2(d.getHours()) + ':' + Core.pad2(d.getMinutes()));
      return true;
    } catch (e) {
      setFileHint('写入失败：' + (e.message || '未知错误'));
      return false;
    }
  }

  function scheduleFileWrite() {
    if (!fileHandle) return;
    clearTimeout(fileTimer);
    fileTimer = setTimeout(function () { writeFileNow(); }, 700);
  }

  function restoreFile() {
    if (!window.showOpenFilePicker) return;
    idbGet('handle').then(function (h) {
      if (!h) return;
      return h.queryPermission({ mode: 'readwrite' }).then(function (p) {
        if (p !== 'granted') {
          setFileHint('上次的文件 ' + h.name + '，点此重连');
          return;
        }
        return h.getFile().then(function (f) { return f.text(); }).then(function (t) {
          fileHandle = h;
          fileName = h.name;
          loadFromText(t);
          updateFileHint();
        }).catch(function () {
          setFileHint('文件读不出来，点此重连');
        });
      });
    }).catch(function () {});
  }

  function snapshot() {
    return JSON.stringify({
      title: state.title, weekStart: state.weekStart,
      markers: state.markers, dict: state.dict, chips: state.chips,
      staff: state.staff, cells: state.cells, owed: state.owed,
      duty: state.duty, dutyPool: state.dutyPool, counts: state.counts
    });
  }

  function restore(json) {
    var s = JSON.parse(json);
    state.title = s.title;
    state.weekStart = s.weekStart;
    state.markers = s.markers;
    state.dict = s.dict;
    if (s.chips) state.chips = s.chips;
    state.staff = s.staff;
    state.cells = s.cells;
    state.owed = s.owed;
    state.duty = s.duty;
    state.dutyPool = s.dutyPool || [];
    state.counts = s.counts;
    render();
    save();
  }

  function pushHist() {
    hist.push(snapshot());
    if (hist.length > 80) hist.shift();
    future.length = 0;
    updateMenu();
  }

  function undo() {
    if (!hist.length) return;
    future.push(snapshot());
    restore(hist.pop());
    updateMenu();
    toast('已撤销');
  }

  function redo() {
    if (!future.length) return;
    hist.push(snapshot());
    restore(future.pop());
    updateMenu();
    toast('已重做');
  }

  /* ---------------- 渲染 ---------------- */
  function gkey(g) {
    if (g === '医生') return 'doc';
    if (g === '护士') return 'nurse';
    if (g === '技师') return 'tech';
    return 'other';
  }

  function nameHtml(s) {
    return (s.prefix ? '<span class="pre">' + esc(s.prefix) + '</span>' : '') + esc(s.name);
  }

  function cellHtml(text) {
    var p = Core.splitMarks(text, state.markers);
    return esc(p.text) + (p.marks ? '<sup class="mk">' + esc(p.marks) + '</sup>' : '');
  }

  function dutyCell(d) {
    var pool = state.dutyPool || [];
    var list = state.staff.filter(function (s) {
      return !pool.length || pool.indexOf(s.id) !== -1;
    });
    var cur = state.duty[d];
    if (cur && !list.some(function (s) { return s.id === cur; })) {
      var extra = state.staff.filter(function (s) { return s.id === cur; })[0];
      if (extra) list = list.concat([extra]);
    }
    var opts = '<option value="">—</option>';
    list.forEach(function (s) {
      opts += '<option value="' + esc(s.id) + '"' + (cur === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>';
    });
    return '<td><select class="duty" data-day="' + d + '">' + opts + '</select></td>';
  }

  function countCell(d) {
    var c = Core.dayCounts(state, d);
    var raw = String(state.counts[d] == null ? '' : state.counts[d]);
    var bad = Core.countsMatch(c, raw) === false;
    return '<td class="cnt-cell' + (bad ? ' bad' : '') + '" data-day="' + d + '">' +
      '<input class="cnt" data-day="' + d + '" maxlength="12" value="' + esc(raw) + '" title="表内实际：' + Core.fmtCounts(c) + '　双击按实际填入">' +
      '<div class="cnt-hint' + (bad ? ' bad' : '') + '">' + Core.fmtCounts(c) + '</div>' +
      '</td>';
  }

  function render() {
    var dates = Core.weekDates(state.weekStart);

    var thead = '<tr><th class="c-name">姓名</th>';
    dates.forEach(function (x, i) {
      thead += '<th>' +
        '<div class="wd">' + x.wd + '</div><div class="md">' + x.md + '</div></th>';
    });
    thead += '<th class="c-owed">欠班-<br>欠假+</th></tr>';
    $('#grid thead').innerHTML = thead;

    var gCount = {};
    state.staff.forEach(function (s) { if (s.group) gCount[s.group] = (gCount[s.group] || 0) + 1; });

    var html = '';
    var lastGroup = null;
    state.staff.forEach(function (s, r) {
      var g = s.group || '';
      if (g && g !== lastGroup) {
        html += '<tr class="group-row"><td colspan="9"><span class="gdot ' + gkey(g) + '"></span>' +
          esc(g) + ' · ' + gCount[g] + ' 人</td></tr>';
      }
      lastGroup = g;
      html += '<tr class="srow' + (r % 2 ? ' alt' : '') + '" data-r="' + r + '"' +
        (g ? ' data-g="' + gkey(g) + '"' : '') + '>';
      html += '<td class="c-name" data-r="' + r + '">' + nameHtml(s) + '</td>';
      for (var d = 0; d < 7; d++) {
        html += '<td class="cell" data-r="' + r + '" data-d="' + d + '">' + cellHtml(Core.cellText(state, s.id, d)) + '</td>';
      }
      html += '<td class="c-owed"><input class="owed" data-r="' + r + '" type="text" spellcheck="false" value="' +
        esc(state.owed[s.id] || '') + '" placeholder="—"></td>';
      html += '</tr>';
    });

    html += '<tr class="row-duty"><td class="c-name">二值<button class="mini-edit" data-act="dutypool" title="编辑二值人员名单">✎</button></td>';
    for (var d2 = 0; d2 < 7; d2++) html += dutyCell(d2);
    html += '<td class="c-owed"></td></tr>';

    html += '<tr class="row-count"><td class="c-name">人数<span class="sub">' +
      (state.dict.countOnly ? '仅' + esc(state.dict.countOnly) : '全体') + '</span></td>';
    for (var d3 = 0; d3 < 7; d3++) html += countCell(d3);
    html += '<td class="c-owed"></td></tr>';

    $('#grid tbody').innerHTML = html;
    // 人员被删除后，选中位置可能越界，收敛回去
    var maxR = Math.max(0, state.staff.length - 1);
    ui.r = Math.min(ui.r, maxR);
    ui.er = Math.min(ui.er, maxR);
    ui.d = Math.min(ui.d, 6);
    ui.ed = Math.min(ui.ed, 6);
    paintSelection(false);
    refreshIssues();
  }

  function paintCell(r, d) {
    var td = document.querySelector('td.cell[data-r="' + r + '"][data-d="' + d + '"]');
    if (td) td.innerHTML = cellHtml(Core.cellText(state, state.staff[r].id, d));
  }

  function refreshCounts() {
    for (var d = 0; d < 7; d++) {
      var td = document.querySelector('td.cnt-cell[data-day="' + d + '"]');
      if (!td) continue;
      var c = Core.dayCounts(state, d);
      var input = td.querySelector('.cnt');
      var raw = String(input ? input.value : state.counts[d] || '');
      var bad = Core.countsMatch(c, raw) === false;
      td.classList.toggle('bad', bad);
      var hint = td.querySelector('.cnt-hint');
      if (hint) {
        hint.textContent = Core.fmtCounts(c);
        hint.classList.toggle('bad', bad);
      }
      if (input) input.title = '表内实际：' + Core.fmtCounts(c) + '　双击按实际填入';
    }
  }

  function normRange() {
    return {
      r1: Math.min(ui.r, ui.er), r2: Math.max(ui.r, ui.er),
      c1: Math.min(ui.d, ui.ed), c2: Math.max(ui.d, ui.ed)
    };
  }

  function paintSelection(scroll) {
    $$('td.cell.sel, td.cell.rng').forEach(function (td) { td.classList.remove('sel', 'rng'); });
    var g = normRange();
    for (var r = g.r1; r <= g.r2; r++) {
      for (var c = g.c1; c <= g.c2; c++) {
        var cell = document.querySelector('td.cell[data-r="' + r + '"][data-d="' + c + '"]');
        if (cell) cell.classList.add('rng');
      }
    }
    var td = document.querySelector('td.cell[data-r="' + ui.r + '"][data-d="' + ui.d + '"]');
    if (!td) return;
    td.classList.add('sel');
    if (!scroll) return;
    var wrap = $('#gridwrap');
    var r0 = td.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    if (r0.top < w.top + 52) wrap.scrollTop -= (w.top + 52 - r0.top);
    else if (r0.bottom > w.bottom - 2) wrap.scrollTop += (r0.bottom - w.bottom + 2);
    if (r0.left < w.left + 106) wrap.scrollLeft -= (w.left + 106 - r0.left);
    else if (r0.right > w.right - 2) wrap.scrollLeft += (r0.right - w.right + 2);
  }


  function refreshIssues() {
    issueItems = Core.validate(state);
    var badge = $('#issueBadge');
    var errs = issueItems.filter(function (x) { return x.level !== 'info'; }).length;
    badge.textContent = issueItems.length;
    badge.classList.toggle('bad', errs > 0);

    if (!issueItems.length) {
      $('#issuesList').innerHTML = '<div class="issue-empty">没有发现问题</div>';
      return;
    }
    $('#issuesList').innerHTML = issueItems.map(function (it, i) {
      return '<button class="issue ' + it.level + '" data-i="' + i + '"><span class="dot"></span>' + esc(it.msg) + '</button>';
    }).join('');
  }

  function select(r, d, extend) {
    r = Math.max(0, Math.min(state.staff.length - 1, r));
    d = Math.max(0, Math.min(6, d));
    if (!extend) { ui.r = r; ui.d = d; }
    ui.er = r;
    ui.ed = d;
    paintSelection(true);
  }

  function move(dr, dc, extend) { select(ui.er + dr, ui.ed + dc, !!extend); }

  /* ---------------- 单元格写入 ---------------- */
  function setCell(r, d, val) {
    var s = state.staff[r];
    if (!s) return;
    if (Core.cellText(state, s.id, d) === val) return;
    pushHist();
    state.cells[s.id][d] = val;
    paintCell(r, d);
    refreshCounts();
    refreshIssues();
    save();
  }

  /* ---------------- 编辑浮层 ---------------- */
  /* 追加按钮内容：汉字之间不加空格；遇到字母/数字（XCM、DR1）才补一个空格 */
  function appendToken(input, text) {
    var v = input.value.replace(/\s+$/, '');
    var sep = '';
    if (v && !/[\/／]$/.test(v)) {
      var ascii = /[A-Za-z0-9]/;
      if (ascii.test(v.slice(-1)) || ascii.test(text.charAt(0))) sep = ' ';
    }
    input.value = v ? v + sep + text : text;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function openEditor(r, d, initial) {
    closeEditor();
    var person = state.staff[r];
    if (!person) return;
    var cell = document.querySelector('td.cell[data-r="' + r + '"][data-d="' + d + '"]');
    if (!cell) return;
    var cur = Core.cellText(state, person.id, d);
    var val = initial == null ? cur : initial;

    var box = document.createElement('div');
    box.className = 'pop';
    var html = '<input class="pop-input" type="text" spellcheck="false" value="' + esc(val) + '">';

    html += '<div class="pop-group"><span class="pop-label">常用</span>' +
      chipList('combos').map(function (x) { return '<button class="chip" data-combo="' + esc(x) + '">' + esc(x) + '</button>'; }).join('') +
      '</div>';

    html += '<div class="pop-group"><span class="pop-label">写法</span>' +
      chipList('shifts').map(function (x) { return '<button class="chip" data-ins="' + esc(x) + '">' + esc(x) + '</button>'; }).join('') +
      '</div>';

    html += '<div class="pop-group"><span class="pop-label">岗位</span>' +
      chipList('posts').map(function (x) { return '<button class="chip" data-ins="' + esc(x) + '">' + esc(x) + '</button>'; }).join('') +
      '</div>';

    html += '<div class="pop-group"><span class="pop-label">标记</span>' +
      state.markers.map(function (m) { return '<button class="chip mkchip" data-mk="' + esc(m) + '">' + esc(m) + '</button>'; }).join('') +
      '</div>';

    html += '<div class="pop-foot">' +
      '<button class="btn tiny ghost" data-act="clear">清空</button>' +
      '<button class="btn tiny ghost" data-act="below">↓ 应用到下方</button>' +
      '<span class="grow"></span>' +
      '<button class="linkbtn" data-act="chips">自定义</button>' +
      '<button class="btn tiny ghost" data-act="cancel">取消</button>' +
      '<button class="btn tiny primary" data-act="ok">确定</button>' +
      '</div>';

    box.innerHTML = html;
    document.body.appendChild(box);

    popCtx = { r: r, d: d };
    pop = box;

    positionPop(box, cell);
    var input = box.querySelector('.pop-input');
    input.focus();
    if (initial == null) input.select();
    else input.setSelectionRange(initial.length, initial.length);

    box.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var input2 = box.querySelector('.pop-input');
      if (btn.dataset.combo != null) {
        input2.value = btn.dataset.combo;
        input2.focus();
      } else if (btn.dataset.ins != null) {
        appendToken(input2, btn.dataset.ins);
      } else if (btn.dataset.mk != null) {
        input2.value = input2.value.replace(/\s+$/, '') + btn.dataset.mk;
        input2.focus();
      } else if (btn.dataset.act) {
        var act = btn.dataset.act;
        if (act === 'ok') commitEditor();
        else if (act === 'cancel') closeEditor();
        else if (act === 'clear') { input2.value = ''; input2.focus(); }
        else if (act === 'below') applyBelow();
        else if (act === 'chips') { closeEditor(); openChips(); }
      }
    });

    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitEditor(1, 0); }
      else if (e.key === 'Tab') { e.preventDefault(); commitEditor(0, e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
    });
  }

  function positionPop(box, cell) {
    var rect = cell.getBoundingClientRect();
    var w = box.offsetWidth || 372;
    var h = box.offsetHeight || 300;
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 10));
    var top = rect.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6);
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }

  function commitEditor(dr, dc) {
    if (!pop) return;
    var v = pop.querySelector('.pop-input').value.replace(/\s+$/, '');
    var ctx = popCtx;
    closeEditor();
    setCell(ctx.r, ctx.d, v);
    if (dr || dc) move(dr, dc);
  }

  function closeEditor() {
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    pop = null;
    popCtx = null;
  }

  function applyBelow() {
    if (!pop) return;
    var v = pop.querySelector('.pop-input').value.replace(/\s+$/, '');
    var ctx = popCtx;
    var n = 0;
    pushHist();
    for (var r = ctx.r; r < state.staff.length; r++) {
      state.cells[state.staff[r].id][ctx.d] = v;
      n++;
    }
    closeEditor();
    render();
    save();
    toast('已填入下方 ' + n + ' 行');
  }

  /* ---------------- 区域复制粘贴 ---------------- */
  function rangeTSV() {
    var g = normRange(), lines = [];
    for (var r = g.r1; r <= g.r2; r++) {
      var cols = [];
      for (var c = g.c1; c <= g.c2; c++) cols.push(Core.cellText(state, state.staff[r].id, c));
      lines.push(cols.join('\t'));
    }
    return lines.join('\n');
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.parentNode.removeChild(ta);
    if (ok) done();
    else toast('复制失败：浏览器不让访问剪贴板');
  }

  function copyRange() {
    var g = normRange();
    var text = rangeTSV();
    var label = (g.r2 - g.r1 + 1) + ' 行 × ' + (g.c2 - g.c1 + 1) + ' 列';
    function done() { toast('已复制 ' + label); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function applyPaste(text) {
    if (!text) return;
    var lines = String(text).replace(/\r/g, '').split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) return;

    var block = lines.map(function (l) { return l.split('\t'); });
    var g = normRange();
    pushHist();
    var n = 0;

    if (block.length === 1 && block[0].length === 1) {
      // 单格内容 → 铺满整个选区
      for (var r = g.r1; r <= g.r2; r++) {
        for (var c = g.c1; c <= g.c2; c++) {
          state.cells[state.staff[r].id][c] = block[0][0];
          n++;
        }
      }
    } else {
      // 多格内容 → 从选区左上角贴入，超出表格的部分丢掉
      for (var i = 0; i < block.length; i++) {
        var rr = g.r1 + i;
        if (rr >= state.staff.length) break;
        for (var j = 0; j < block[i].length; j++) {
          var cc = g.c1 + j;
          if (cc > 6) break;
          state.cells[state.staff[rr].id][cc] = block[i][j];
          n++;
        }
      }
    }
    render();
    save();
    toast('已粘贴 ' + n + ' 格');
  }

  /* ---------------- 键盘 ---------------- */
  function onKey(e) {
    if (pop) return;
    var modalOn = $('#modal').classList.contains('on');

    if (e.key === 'Escape') {
      if (modalOn) closeModal();
      else if ($('#issues').classList.contains('on')) $('#issues').classList.remove('on');
      else if (ui.er !== ui.r || ui.ed !== ui.d) { ui.er = ui.r; ui.ed = ui.d; paintSelection(false); }
      return;
    }
    if (modalOn) return;
    if (isField(e.target)) return;

    var meta = e.ctrlKey || e.metaKey;
    var k = (e.key || '').toLowerCase();

    if (meta && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (meta && k === 'y') { e.preventDefault(); redo(); return; }
    if (meta && k === 's') { e.preventDefault(); doExport(); return; }
    if (meta && k === 'd') { e.preventDefault(); fillDown(); return; }
    if (meta && k === 'c') { e.preventDefault(); copyRange(); return; }
    if (meta && k === 'v') { return; }  // 交给原生 paste 事件，避免剪贴板权限问题

    // 焦点在按钮/链接上时不要抢 Tab，否则键盘没法走焦点
    var onControl = !!(e.target && /^(BUTTON|A)$/.test(e.target.tagName));

    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); move(-1, 0, e.shiftKey); break;
      case 'ArrowDown': e.preventDefault(); move(1, 0, e.shiftKey); break;
      case 'ArrowLeft': e.preventDefault(); move(0, -1, e.shiftKey); break;
      case 'ArrowRight': e.preventDefault(); move(0, 1, e.shiftKey); break;
      case 'Enter': e.preventDefault(); openEditor(ui.r, ui.d); break;
      case 'Delete': case 'Backspace': e.preventDefault(); setCell(ui.r, ui.d, ''); break;
      case 'Tab':
        if (onControl) break;
        e.preventDefault();
        move(0, e.shiftKey ? -1 : 1);
        break;
      default:
        if (e.key && e.key.length === 1 && !meta && !e.altKey) {
          e.preventDefault();
          openEditor(ui.r, ui.d, e.key);
        }
    }
  }

  function fillDown() {
    if (ui.r === 0) return;
    var v = Core.cellText(state, state.staff[ui.r - 1].id, ui.d);
    setCell(ui.r, ui.d, v);
    toast('已从上一行填充');
  }

  /* ---------------- 弹窗 ---------------- */
  function openModal(title, bodyHtml, footHtml) {
    $('#modalTitle').textContent = title;

    // 每次重建 body/foot 节点，避免上一轮绑定的事件累积
    var oldBody = $('#modalBody');
    var body = oldBody.cloneNode(false);
    oldBody.parentNode.replaceChild(body, oldBody);
    body.innerHTML = bodyHtml;

    var oldFoot = $('#modalFoot');
    var foot = oldFoot.cloneNode(false);
    oldFoot.parentNode.replaceChild(foot, oldFoot);
    foot.innerHTML = footHtml || '<button class="btn" data-close>关闭</button>';

    $('#modal').classList.add('on');
    return { body: body, foot: foot };
  }

  function closeModal() { $('#modal').classList.remove('on'); }

  /* 人员管理 */
  function groupSelect(cur) {
    var opts = ['', '医生', '护士', '技师'].map(function (v) {
      return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + (v || '—') + '</option>';
    }).join('');
    return '<select class="pgroup">' + opts + '</select>';
  }

  function openPeople() {
    var rows = state.staff.map(function (s) {
      return '<div class="prow" data-id="' + esc(s.id) + '">' +
        '<span class="pnum"></span>' +
        '<input class="pname" value="' + esc(s.name) + '" spellcheck="false">' +
        '<input class="pmark" maxlength="2" value="' + esc(s.prefix) + '" placeholder="前缀">' +
        groupSelect(s.group) +
        '<button class="mini" data-act="up" title="上移">↑</button>' +
        '<button class="mini" data-act="down" title="下移">↓</button>' +
        '<button class="mini danger" data-act="del" title="删除">✕</button>' +
        '</div>';
    }).join('');

    var m = openModal('人员管理',
      '<div class="plist">' + rows + '</div>' +
      '<button class="btn ghost" data-act="add">＋ 新增人员</button> ' +
      '<button class="btn ghost" data-act="sort">按分组排序</button>' +
      '<p class="hint">改名字不会丢数据（按人记录）。删掉的人，其排班内容一并删除。分组只影响编辑页的分隔显示，导出 Excel 时仍是一张连续表。</p>',
      '<button class="btn" data-close>取消</button><button class="btn primary" data-act="save">保存</button>');

    function renumber() {
      $$('.prow', m.body).forEach(function (row, i) {
        row.querySelector('.pnum').textContent = i + 1;
      });
    }
    renumber();

    m.body.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var act = btn.dataset.act;
      var row = btn.closest('.prow');

      if (act === 'add') {
        var div = document.createElement('div');
        div.className = 'prow';
        div.innerHTML = '<span class="pnum"></span>' +
          '<input class="pname" value="新人员" spellcheck="false">' +
          '<input class="pmark" maxlength="2" placeholder="前缀">' +
          groupSelect('') +
          '<button class="mini" data-act="up" title="上移">↑</button>' +
          '<button class="mini" data-act="down" title="下移">↓</button>' +
          '<button class="mini danger" data-act="del" title="删除">✕</button>';
        $('.plist', m.body).appendChild(div);
        div.querySelector('.pname').focus();
        div.querySelector('.pname').select();
      } else if (act === 'del' && row) {
        row.parentNode.removeChild(row);
      } else if (act === 'up' && row && row.previousElementSibling) {
        row.parentNode.insertBefore(row, row.previousElementSibling);
      } else if (act === 'down' && row && row.nextElementSibling) {
        row.parentNode.insertBefore(row.nextElementSibling, row);
      } else if (act === 'sort') {
        var order = { '医生': 0, '护士': 1, '技师': 2, '': 3 };
        var list = $('.plist', m.body);
        $$('.prow', list).sort(function (a, b) {
          var ga = a.querySelector('.pgroup').value, gb = b.querySelector('.pgroup').value;
          return (order[ga] == null ? 3 : order[ga]) - (order[gb] == null ? 3 : order[gb]);
        }).forEach(function (r) { list.appendChild(r); });
      }
      renumber();
    });

    m.foot.addEventListener('click', function (e) {
      if (!e.target.closest('button[data-act="save"]')) return;
      applyPeople();
    });
  }

  function applyPeople() {
    var list = [];
    $$('#modalBody .prow').forEach(function (row) {
      var name = row.querySelector('.pname').value.trim();
      if (!name) return;
      list.push({
        id: row.dataset.id || Core.newStaff().id,
        name: name,
        prefix: row.querySelector('.pmark').value.trim(),
        group: row.querySelector('.pgroup').value
      });
    });
    if (!list.length) { toast('至少保留一个人'); return; }

    pushHist();
    var cells = {}, owed = {};
    list.forEach(function (s) {
      cells[s.id] = state.cells[s.id] || ['', '', '', '', '', '', ''];
      owed[s.id] = state.owed[s.id] || '';
    });
    state.staff = list;
    state.cells = cells;
    state.owed = owed;
    state.duty = state.duty.map(function (id) { return cells[id] ? id : ''; });
    state.dutyPool = (state.dutyPool || []).filter(function (id) { return !!cells[id]; });

    closeModal();
    render();
    save();
    toast('人员已更新');
  }

  /* 标记管理 */
  function openMarks() {
    var m = openModal('标记（▲ ● ★ ※ …）',
      '<div class="mrow"><input id="newMark" maxlength="2" placeholder="输入一个符号，例如 ▲"><button class="btn" data-act="add">添加</button></div>' +
      '<div class="mlist" id="markList"></div>' +
      '<p class="hint">点单元格里的标记按钮，符号会贴到这一格末尾。导出 Excel 时会自动变成红色上标，位置和原表一致。姓名前面的 ★ 在「人员管理」里填前缀。</p>');

    function paint() {
      $('#markList').innerHTML = state.markers.map(function (mk, i) {
        return '<span class="chip mark-chip">' + esc(mk) + '<b data-i="' + i + '">✕</b></span>';
      }).join('');
    }
    paint();

    m.body.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act="add"]');
      if (!btn) return;
      var v = $('#newMark').value.trim();
      if (!v) return;
      if (state.markers.indexOf(v) !== -1) { toast('已经有了'); return; }
      pushHist();
      state.markers.push(v);
      $('#newMark').value = '';
      paint();
      save();
    });

    $('#markList').addEventListener('click', function (e) {
      var b = e.target.closest('b[data-i]');
      if (!b) return;
      pushHist();
      state.markers.splice(+b.dataset.i, 1);
      paint();
      save();
    });
  }

  /* 关键词设置 */
  function openDict() {
    var d = state.dict;
    var m = openModal('统计设置（决定底部人数怎么算）',
      '<div class="dict-row"><label>审核关键词</label><input id="kAudit" value="' + esc(d.audit.join(' ')) + '"></div>' +
      '<div class="dict-row"><label>写报告关键词</label><input id="kWrite" value="' + esc(d.write.join(' ')) + '"></div>' +
      '<div class="dict-row"><label>上午关键词</label><input id="kAm" value="' + esc(d.am.join(' ')) + '"></div>' +
      '<div class="dict-row"><label>下午关键词</label><input id="kPm" value="' + esc(d.pm.join(' ')) + '"></div>' +
      '<div class="dict-row"><label>人数统计范围</label><select id="kScope" class="dict-select">' +
        '<option value="医生"' + (d.countOnly === '医生' ? ' selected' : '') + '>仅医生</option>' +
        '<option value=""' + (d.countOnly === '' ? ' selected' : '') + '>全体人员</option>' +
      '</select></div>' +
      '<p class="hint">格子里出现「审」就计 1 个审核人，出现「写」就计 1 个写报告人；同一格既没写上午也没写下午，按整天算。用空格隔开多个词。' +
      '底部那行人数默认只数医生，护士、技师不参与，按你表里的口径。</p>',
      '<button class="btn" data-close>取消</button><button class="btn primary" data-act="save">保存</button>');

    m.foot.addEventListener('click', function (e) {
      if (!e.target.closest('button[data-act="save"]')) return;
      function split(v) {
        return v.split(/[\s,，、]+/).filter(function (x) { return !!x; });
      }
      var audit = split($('#kAudit').value);
      var write = split($('#kWrite').value);
      var am = split($('#kAm').value);
      var pm = split($('#kPm').value);
      if (!audit.length || !write.length || !am.length || !pm.length) {
        toast('关键词不能为空');
        return;
      }
      pushHist();
      state.dict.audit = audit;
      state.dict.write = write;
      state.dict.am = am;
      state.dict.pm = pm;
      state.dict.countOnly = $('#kScope').value;
      closeModal();
      render();
      save();
      toast('已按新关键词重算');
    });
  }

  /* 按钮自定义：常用 / 写法 / 岗位 */
  function openChips() {
    var def = Core.emptyState().chips;
    function join(a) { return a.join('\n'); }

    var m = openModal('自定义按钮',
      '<div class="chipset"><label>常用（一格一个，浮层最上面一排；整句放这里）</label>' +
        '<textarea id="cCombos" rows="4" spellcheck="false">' + esc(join(state.chips.combos)) + '</textarea></div>' +
      '<div class="chipset"><label>写法（点一下追加到输入框）</label>' +
        '<textarea id="cShifts" rows="4" spellcheck="false">' + esc(join(state.chips.shifts)) + '</textarea></div>' +
      '<div class="chipset"><label>岗位</label>' +
        '<textarea id="cPosts" rows="3" spellcheck="false">' + esc(join(state.chips.posts)) + '</textarea></div>' +
      '<p class="hint">一行一个，顺序就是显示顺序，重复的会自动去掉。带空格的整句放「常用」里最省事。标记不在这里，点顶栏「标记」管。</p>',
      '<button class="btn ghost" data-act="reset">恢复默认</button><span class="grow"></span>' +
      '<button class="btn" data-close>取消</button><button class="btn primary" data-act="save">保存</button>');

    m.foot.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;

      if (btn.dataset.act === 'reset') {
        $('#cCombos').value = join(def.combos);
        $('#cShifts').value = join(def.shifts);
        $('#cPosts').value = join(def.posts);
        return;
      }
      if (btn.dataset.act !== 'save') return;

      function parse(v) {
        var seen = {}, out = [];
        String(v).split(/\r?\n/).forEach(function (line) {
          var t = line.trim();
          if (t && !seen[t]) { seen[t] = 1; out.push(t); }
        });
        return out;
      }

      var combos = parse($('#cCombos').value);
      var shifts = parse($('#cShifts').value);
      var posts = parse($('#cPosts').value);
      if (!combos.length && !shifts.length && !posts.length) { toast('至少留一个按钮'); return; }

      pushHist();
      state.chips = { combos: combos, shifts: shifts, posts: posts };
      closeModal();
      save();
      toast('按钮已更新');
    });
  }

  /* 二值人员名单 */
  function openDutyPool() {
    var pool = state.dutyPool || [];
    var rows = state.staff.map(function (s) {
      var on = pool.indexOf(s.id) !== -1;
      return '<label class="dp-row" data-name="' + esc(s.name) + '">' +
        '<input type="checkbox" value="' + esc(s.id) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="dp-name">' + nameHtml(s) + '</span>' +
        '<span class="dp-group ' + gkey(s.group) + '">' + esc(s.group || '未分组') + '</span>' +
        '</label>';
    }).join('');

    var m = openModal('二值人员名单',
      '<div class="dp-tools">' +
        '<input id="dpSearch" placeholder="搜名字" spellcheck="false">' +
        '<button class="btn tiny ghost" data-act="all">全选</button>' +
        '<button class="btn tiny ghost" data-act="none">清空</button>' +
      '</div>' +
      '<div class="dp-list" id="dpList">' + rows + '</div>' +
      '<p class="hint">勾上的人才会出现在二值下拉里。全部不勾等于不限制（下拉显示所有人）。</p>',
      '<button class="btn" data-close>取消</button><button class="btn primary" data-act="save">保存</button>');

    m.body.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var boxes = $$('#dpList input[type=checkbox]');
      if (btn.dataset.act === 'all') boxes.forEach(function (b) { b.checked = true; });
      if (btn.dataset.act === 'none') boxes.forEach(function (b) { b.checked = false; });
    });

    $('#dpSearch').addEventListener('input', function () {
      var q = this.value.trim().toLowerCase();
      $$('#dpList .dp-row').forEach(function (row) {
        row.style.display = (!q || row.dataset.name.toLowerCase().indexOf(q) !== -1) ? '' : 'none';
      });
    });

    m.foot.addEventListener('click', function (e) {
      if (!e.target.closest('button[data-act="save"]')) return;
      var picked = [];
      $$('#dpList input[type=checkbox]').forEach(function (b) {
        if (b.checked) picked.push(b.value);
      });
      pushHist();
      state.dutyPool = picked;
      closeModal();
      render();
      save();
      toast(picked.length ? ('二值名单：' + picked.length + ' 人') : '二值下拉恢复显示全部人员');
    });
  }

  /* 导出 */
  function doExport() {
    if (!window.ExcelJS || !window.PaibanExport) {
      toast('Excel 组件没加载成功，检查 vendor/exceljs.min.js 是否还在');
      return;
    }
    var btn = $('#btnExport');
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '生成中…';

    function done() {
      btn.disabled = false;
      btn.textContent = old;
    }

    try {
      var wb = window.PaibanExport.buildWorkbook(window.ExcelJS, state);
      wb.xlsx.writeBuffer().then(function (buf) {
        var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = window.PaibanExport.fileName(state);
        document.body.appendChild(a);
        a.click();
        a.parentNode.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        toast('已导出：' + a.download);
        done();
      }).catch(function (err) {
        toast('导出失败：' + err.message);
        done();
      });
    } catch (err) {
      toast('导出失败：' + err.message);
      done();
    }
  }

  function downloadText(text, name, type) {
    var blob = new Blob([text], { type: type || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.parentNode.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  function doImport(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var s = JSON.parse(String(reader.result));
        if (!s || !s.staff || !s.cells) throw new Error('不是排班表备份文件');
        pushHist();
        state = normalize(s);
        render();
        save();
        toast('已导入');
      } catch (e) {
        toast('导入失败：' + e.message);
      }
    };
    reader.readAsText(file);
  }

  /* ---------------- 菜单与按钮 ---------------- */
  function updateMenu() {
    var u = $('.menu button[data-act="undo"]');
    var r = $('.menu button[data-act="redo"]');
    if (u) u.disabled = !hist.length;
    if (r) r.disabled = !future.length;
  }

  function bind() {
    var grid = $('#grid');

    grid.addEventListener('click', function (e) {
      if (e.target.closest('[data-act="dutypool"]')) {
        openDutyPool();
        return;
      }
      var td = e.target.closest('td.cell');
      if (!td) {
        var nm = e.target.closest('td.c-name');
        if (nm && nm.dataset.r != null) select(+nm.dataset.r, 0);
        return;
      }
      if (dragMoved) { dragMoved = false; return; }  // 拖选结束，不当成点击
      var r = +td.dataset.r, d = +td.dataset.d;
      if (wasSelected) { wasSelected = false; openEditor(r, d); }
      else select(r, d);
    });

    /* 拖动框选 */
    grid.addEventListener('mousedown', function (e) {
      var td = e.target.closest('td.cell');
      if (!td || e.button !== 0) return;
      var r = +td.dataset.r, d = +td.dataset.d;
      wasSelected = (ui.r === r && ui.d === d && ui.er === r && ui.ed === d);
      dragging = true;
      dragMoved = false;
      select(r, d, e.shiftKey);   // Shift 点选 = 从锚点扩到这一点
      e.preventDefault();
    });

    grid.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var td = e.target.closest('td.cell');
      if (!td) return;
      var r = +td.dataset.r, d = +td.dataset.d;
      if (r === ui.er && d === ui.ed) return;
      dragMoved = true;
      select(r, d, true);
    });

    document.addEventListener('mouseup', function () { dragging = false; });

    /* 粘贴：用原生 paste 事件，能直接吃 Excel 复制过来的制表符 */
    document.addEventListener('paste', function (e) {
      if (pop || isField(e.target)) return;
      var t = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!t) return;
      e.preventDefault();
      applyPaste(t);
    });

    grid.addEventListener('dblclick', function (e) {
      var td = e.target.closest('td.cell');
      if (td) { openEditor(+td.dataset.r, +td.dataset.d); return; }
      var cnt = e.target.closest('input.cnt');
      if (cnt) {
        var d = +cnt.dataset.day;
        pushHist();
        state.counts[d] = Core.fmtCountsValue(Core.dayCounts(state, d));
        cnt.value = state.counts[d];
        refreshCounts();
        refreshIssues();
        save();
        toast('已按表内实际填入');
      }
    });

    grid.addEventListener('change', function (e) {
      var sel = e.target.closest('select.duty');
      if (!sel) return;
      state.duty[+sel.dataset.day] = sel.value;
      refreshIssues();
      save();
    });

    grid.addEventListener('input', function (e) {
      var cnt = e.target.closest('input.cnt');
      if (cnt) {
        state.counts[+cnt.dataset.day] = cnt.value;
        refreshCounts();
        save();
        return;
      }
      var owed = e.target.closest('input.owed');
      if (owed) {
        state.owed[state.staff[+owed.dataset.r].id] = owed.value;
        save();
      }
    });

    document.addEventListener('mousedown', function (e) {
      if (!pop) return;
      if (pop.contains(e.target)) return;
      commitEditor();
    });

    document.addEventListener('keydown', onKey);

    $('#gridwrap').addEventListener('scroll', function () { if (pop) commitEditor(); });
    window.addEventListener('resize', function () { closeEditor(); });
    window.addEventListener('beforeunload', function () {
      if (!STORAGE_OK) return;
      try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    });

    $('#titleInput').addEventListener('input', function () {
      state.title = this.value;
      document.title = this.value || '排班表';
      save();
    });

    $('#weekStart').addEventListener('change', function () {
      var monday = Core.mondayOf(this.value || Core.fmtISO(new Date()));
      state.weekStart = monday;
      this.value = monday;
      render();
      save();
      toast('已切到 ' + monday + ' 这一周，表内内容不变');
    });

    $('#btnPeople').addEventListener('click', openPeople);
    $('#btnMarks').addEventListener('click', openMarks);
    $('#btnDict').addEventListener('click', openDict);

    $('#btnCheck').addEventListener('click', function () {
      var panel = $('#issues');
      panel.classList.toggle('on');
    });

    $('#modal').addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) { closeModal(); return; }
      if (e.target === this) closeModal();
    });
    $('#issues').addEventListener('click', function (e) {
      if (!e.target.closest('#issueClose')) return;
      $('#issues').classList.remove('on');
    });

    $('#issuesList').addEventListener('click', function (e) {
      var btn = e.target.closest('.issue');
      if (!btn) return;
      var it = issueItems[+btn.dataset.i];
      if (!it) return;
      if (it.day == null) { toast('点「人员」给这些人选分组'); return; }
      var target = 0;
      if (it.post) {
        for (var i = 0; i < state.staff.length; i++) {
          if (Core.cellText(state, state.staff[i].id, it.day).indexOf(it.post) !== -1) { target = i; break; }
        }
      }
      select(target, it.day);
      var td = document.querySelector('td.cell[data-r="' + target + '"][data-d="' + it.day + '"]');
      if (td) td.scrollIntoView({ block: 'center', inline: 'center' });
    });

    $('#btnFillCounts').addEventListener('click', function () {
      pushHist();
      for (var d = 0; d < 7; d++) state.counts[d] = Core.fmtCountsValue(Core.dayCounts(state, d));
      render();
      save();
      toast('7 天人数已按表内实际重算');
    });

    $('#btnExport').addEventListener('click', doExport);

    var menu = $('#menu');
    $('#btnMenu').addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.toggle('on');
    });
    document.addEventListener('click', function (e) {
      if (!menu.contains(e.target) && e.target !== $('#btnMenu')) menu.classList.remove('on');
    });

    menu.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      menu.classList.remove('on');
      var act = btn.dataset.act;

      if (act === 'undo') undo();
      else if (act === 'redo') redo();
      else if (act === 'json') {
        downloadText(JSON.stringify(state, null, 2), '排班表备份_' + state.weekStart + '.json');
        toast('已导出备份');
      } else if (act === 'import') {
        $('#fileInput').click();
      } else if (act === 'connect') {
        connectFile();
      } else if (act === 'saveas') {
        saveAsFile();
      } else if (act === 'disconnect') {
        disconnectFile();
      } else if (act === 'print') {
        window.print();
      } else if (act === 'seed') {
        if (!confirm('载入示例数据会覆盖当前内容，继续？')) return;
        pushHist();
        state = Core.fromSeed(window.SEED);
        render();
        save();
        toast('已载入示例数据');
      } else if (act === 'clear') {
        if (!confirm('清空所有排班内容？人员名单保留，可用 Ctrl+Z 撤销。')) return;
        pushHist();
        state.staff.forEach(function (s) { state.cells[s.id] = ['', '', '', '', '', '', '']; });
        state.duty = ['', '', '', '', '', '', ''];
        state.counts = ['', '', '', '', '', '', ''];
        render();
        save();
        toast('已清空');
      } else if (act === 'help') {
        openModal('怎么用',
          '<div class="help">' +
          '<p><b>点格子 → 打字或点下面的按钮 → 回车。</b>回车是确认并往下一格，Tab 是往右一格，Esc 取消。</p>' +
          '<p><b>键盘：</b>方向键移动，<kbd>Enter</kbd> 编辑，<kbd>Ctrl+D</kbd> 把上一行内容填下来，<kbd>Ctrl+Z</kbd> 撤销，<kbd>Ctrl+S</kbd> 直接导出 Excel。</p>' +
          '<p><b>半天的写法：</b>用 <b>/</b> 分隔，比如 <b>上写/下审 XCM</b>、<b>休/DR4</b>。程序按 / 切成两段分别统计，所以周一半天休也能算准。</p>' +
          '<p><b>底部人数：</b>四个数字依次是「上午审 / 下午审 / 上午写 / 下午写」。全是单位数就照原表写 <b>5587</b>、<b>33.66</b>；' +
          '一旦出现两位数就写成 <b>3/3/10/8</b>（斜杠隔开），两种写法程序都认。' +
          '默认<b>只统计医生</b>，护士和技师不参与；要改成全体，在「设置」里换统计范围。' +
          '格子里会出现灰色小字，那是按表内实际算出来的；对不上会变红。想整体重算点顶栏「人数自动统计」。</p>' +
          '<p><b>欠班/欠假：</b>最后一列是自由填写的备注框，不参与计算。</p>' +
          '<p><b>导出：</b>顶栏「导出 Excel」，出来的表带标题合并、冻结窗格、边框、A4 横向打印设置，标记自动变红色上标。</p>' +
          '<p><b>放 U 盘用（数据跟着走）：</b>把整个文件夹拷到 U 盘，双击 index.html 打开。首次点「更多 → 新建数据文件」，存到 U 盘里（比如 <b>排班数据.json</b>）；之后每次改动 0.7 秒后自动写回这个文件。' +
          '换电脑打开时点右下角「数据存本机」，选中那个 json 就连上了。同一台电脑下次打开会自动连接。</p>' +
          '<p><b>数据也存浏览器本地一份</b>，但换电脑或清缓存就没了 —— 想带走数据，用上面的数据文件，或「更多 → 导出 JSON 备份」。</p>' +
          '</div>');
      }
    });

    $('#fileInput').addEventListener('change', function () {
      if (this.files && this.files[0]) doImport(this.files[0]);
      this.value = '';
    });

    $('#warnClose').addEventListener('click', function () {
      $('#warnbar').hidden = true;
    });

    $('#fileHint').addEventListener('click', function () {
      if (fileHandle) {
        toast('当前文件：' + fileName + '　点「更多 → 断开数据文件」可断开');
      } else {
        connectFile();
      }
    });
  }

  function init() {
    var had = false;
    try {
      localStorage.setItem('__paiban_test', '1');
      localStorage.removeItem('__paiban_test');
      had = !!localStorage.getItem(LS_KEY);
    } catch (e) {
      STORAGE_OK = false;
      had = false;
    }

    state = load();
    $('#weekStart').value = state.weekStart;
    $('#titleInput').value = state.title;
    document.title = state.title || '排班表';

    bind();
    render();
    select(0, 0);
    updateMenu();

    if (!STORAGE_OK) {
      var sw = $('#storeWarn');
      sw.hidden = false;
      sw.textContent = '此环境不能本地保存，改完请用「更多 → 导出 JSON」留底';
    }

    updateFileHint();
    restoreFile();

    if (!had) {
      var bad = Core.validate(state).filter(function (x) {
        return x.level === 'warn' && x.msg.indexOf('底部') !== -1;
      }).length;
      if (bad) {
        $('#warnText').textContent = '当前是示例数据（按原表截图转录）。其中 ' + bad +
          ' 天底部人数与表内统计对不上，可能是转录误差或原表笔误，点「校验」可逐个定位。正式使用前建议「更多 → 清空排班」重填。';
        $('#warnbar').hidden = false;
      }
    }
  }

  if (/[?&]debug=1/.test(location.search)) {
    window.PaibanFileDebug = {
      setHandle: function (h, name) { fileHandle = h; fileName = name || h.name; updateFileHint(); },
      writeNow: writeFileNow,
      info: function () { return { connected: !!fileHandle, name: fileName }; }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
