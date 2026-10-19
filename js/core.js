/* core.js —— 纯逻辑层：日期、单元格解析、人数统计、校验。无 DOM 依赖，浏览器与 Node 通用。 */
(function (root) {
  'use strict';

  var WD = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function parseDate(str) {
    var p = String(str).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
  }

  function fmtISO(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fmtMD(d) { return (d.getMonth() + 1) + '.' + d.getDate(); }

  /* 取所在周的周一 */
  function mondayOf(str) {
    var d = parseDate(str);
    var w = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - w);
    return fmtISO(d);
  }

  function weekDates(startStr) {
    var d = parseDate(startStr), out = [];
    for (var i = 0; i < 7; i++) {
      var x = new Date(d.getTime());
      x.setDate(d.getDate() + i);
      out.push({ iso: fmtISO(x), md: fmtMD(x), wd: WD[(x.getDay() + 6) % 7] });
    }
    return out;
  }

  function hits(text, keys) {
    if (!keys || !keys.length) return false;
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] && text.indexOf(keys[i]) !== -1) return true;
    }
    return false;
  }

  /*
   * 解析一格文字，判断「上午/下午」有没有人在「审核」、有没有人在「写报告」。
   * 规则：先按 / 切成若干段（半天的写法就靠这个），段内有 上/早 算上午，有 下/晚 算下午，
   *       段内没有任何时段词则按整天算。
   */
  function analyzeText(text, dict) {
    var segs = String(text == null ? '' : text).split(/[\/／]/);
    var res = { audit: { am: false, pm: false }, write: { am: false, pm: false } };
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i].trim();
      if (!s) continue;
      var am = hits(s, dict.am), pm = hits(s, dict.pm);
      if (!am && !pm) { am = true; pm = true; }
      if (hits(s, dict.audit)) {
        if (am) res.audit.am = true;
        if (pm) res.audit.pm = true;
      }
      if (hits(s, dict.write)) {
        if (am) res.write.am = true;
        if (pm) res.write.pm = true;
      }
    }
    return res;
  }

  function cellText(state, staffId, d) {
    var arr = state.cells[staffId];
    return arr && arr[d] ? arr[d] : '';
  }

  /* 某一天的四个数字：上午审 / 下午审 / 上午写 / 下午写（默认只统计医生） */
  function dayCounts(state, d) {
    var amAudit = 0, pmAudit = 0, amWrite = 0, pmWrite = 0;
    var only = state.dict && state.dict.countOnly;
    for (var i = 0; i < state.staff.length; i++) {
      var s = state.staff[i];
      if (only && s.group !== only) continue;
      var r = analyzeText(cellText(state, s.id, d), state.dict);
      if (r.audit.am) amAudit++;
      if (r.audit.pm) pmAudit++;
      if (r.write.am) amWrite++;
      if (r.write.pm) pmWrite++;
    }
    return { amAudit: amAudit, pmAudit: pmAudit, amWrite: amWrite, pmWrite: pmWrite };
  }

  function signature(c) {
    return '' + c.amAudit + c.pmAudit + c.amWrite + c.pmWrite;
  }

  function fmtSig(raw) {
    var t = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (t.length < 4) return '';
    return '审' + t.charAt(0) + '/' + t.charAt(1) + ' 写' + t.charAt(2) + '/' + t.charAt(3);
  }

  /* 直接按对象格式化，人数到两位数也不会串位 */
  function fmtCounts(c) {
    return '审' + c.amAudit + '/' + c.pmAudit + ' 写' + c.amWrite + '/' + c.pmWrite;
  }

  /* 写回表格用的值：全是单位数用 5587，出现两位数用 3/3/10/8 */
  function fmtCountsValue(c) {
    var v = [c.amAudit, c.pmAudit, c.amWrite, c.pmWrite];
    var big = false;
    for (var i = 0; i < v.length; i++) if (v[i] > 9) big = true;
    return v.join(big ? '/' : '');
  }

  /* 解析表底值：5587、33.66、3/3/10/8、3,3,10,8 都认，认不出返回 null */
  function parseCounts(raw) {
    var t = String(raw == null ? '' : raw).trim();
    if (!t) return null;
    var digits = t.replace(/\D/g, '');
    if (digits.length === 4) return digits.split('').map(Number);
    var parts = t.split(/[^\d]+/).filter(function (x) { return x !== ''; });
    if (parts.length === 4) {
      var out = parts.map(Number);
      for (var i = 0; i < 4; i++) if (isNaN(out[i])) return null;
      return out;
    }
    return null;
  }

  /*
   * 拿表底写的数字和实际统计比对。
   * 返回 true=一致，false=不一致，null=认不出（不判断）。
   */
  function countsMatch(c, raw) {
    var p = parseCounts(raw);
    if (!p) return null;
    var v = [c.amAudit, c.pmAudit, c.amWrite, c.pmWrite];
    for (var i = 0; i < 4; i++) {
      if (p[i] !== v[i]) return false;
    }
    return true;
  }

  /* 把文字尾部的标记（▲●★※…）剥出来，渲染时做成红色上标 */
  function splitMarks(text, markers) {
    var t = String(text == null ? '' : text);
    var marks = '';
    if (!markers || !markers.length) return { text: t.trim(), marks: '' };
    for (;;) {
      var trimmed = t.replace(/\s+$/, '');
      if (!trimmed) break;
      var last = trimmed.slice(-1);
      if (markers.indexOf(last) !== -1) {
        marks = last + marks;
        t = trimmed.slice(0, -1);
      } else break;
    }
    return { text: t.trim(), marks: marks };
  }

  function newStaff(name) {
    return {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name || '新人员',
      prefix: '',
      group: ''
    };
  }

  function emptyState() {
    return {
      version: 1,
      title: '医学影像科排班表',
      weekStart: mondayOf(fmtISO(new Date())),
      markers: ['▲', '●', '★', '※'],
      chips: {
        combos: ['上下审 XCM', '上下写 XCM', '上下审 X', '上下写 XC', '上下审 XC', '休', '出', '上写/值', 'DR3/值', '上下 DR1', '上下 C3', '早中 1.5'],
        shifts: ['上', '下', '上下', '上中', '中下', '下晚', '早中', '上夜', '审', '写', '单', '消', '值', '夜', '休', '出', '开会', '补休', '放休', '干休'],
        posts: ['XCM', 'X', 'XC', 'DR1', 'DR2', 'DR3', 'DR4', 'C1', 'C2', 'C3', '钼靶']
      },
      dict: {
        audit: ['审'],
        write: ['写', '单'],
        am: ['上', '早'],
        pm: ['下', '晚'],
        countOnly: '医生'
      },
      staff: [],
      cells: {},
      owed: {},
      duty: ['', '', '', '', '', '', ''],
      dutyPool: [],
      counts: ['', '', '', '', '', '', '']
    };
  }

  /* 从 seed 构造完整状态 */
  function fromSeed(seed) {
    var st = emptyState();
    st.title = seed.title || st.title;
    st.weekStart = seed.weekStart || st.weekStart;
    if (seed.markers) st.markers = seed.markers.slice();
    if (seed.dict) {
      for (var k in seed.dict) if (Object.prototype.hasOwnProperty.call(seed.dict, k)) st.dict[k] = seed.dict[k];
    }
    var markers = st.markers;
    (seed.rows || []).forEach(function (row) {
      var name = String(row[0] || '').trim();
      var prefix = '';
      if (name && markers.indexOf(name.charAt(0)) !== -1) {
        prefix = name.charAt(0);
        name = name.slice(1);
      }
      var s = newStaff(name);
      s.prefix = prefix;
      s.group = (seed.groupOf && seed.groupOf[name]) || '';
      st.staff.push(s);
      var cells = [];
      for (var d = 0; d < 7; d++) cells.push(String(row[1 + d] == null ? '' : row[1 + d]));
      st.cells[s.id] = cells;
      st.owed[s.id] = String(row[8] == null ? '' : row[8]);
    });
    var byName = {};
    st.staff.forEach(function (s) { byName[s.name] = s.id; });
    st.duty = (seed.duty || []).map(function (n) { return byName[n] || ''; });
    while (st.duty.length < 7) st.duty.push('');
    st.counts = (seed.counts || []).slice(0, 7);
    while (st.counts.length < 7) st.counts.push('');

    /* 二值默认名单：示例里排过二值的人 */
    st.dutyPool = [];
    st.duty.forEach(function (id) {
      if (id && st.dutyPool.indexOf(id) === -1) st.dutyPool.push(id);
    });

    return st;
  }

  /* 校验：返回问题列表 */
  function validate(state) {
    var issues = [];

    var noGroup = [];
    for (var n = 0; n < state.staff.length; n++) {
      if (!state.staff[n].group) noGroup.push(state.staff[n].name);
    }
    if (noGroup.length) {
      issues.push({
        level: 'warn',
        msg: '有 ' + noGroup.length + ' 人没设分组（' + noGroup.slice(0, 3).join('、') +
          (noGroup.length > 3 ? ' 等' : '') + '），不参与人数统计'
      });
    }

    for (var d = 0; d < 7; d++) {
      var c = dayCounts(state, d);
      var dayName = weekDates(state.weekStart)[d].wd;
      if (!c.amAudit) issues.push({ level: 'err', day: d, msg: dayName + ' 上午没有人审核' });
      if (!c.pmAudit) issues.push({ level: 'err', day: d, msg: dayName + ' 下午没有人审核' });
      if (!c.amWrite) issues.push({ level: 'err', day: d, msg: dayName + ' 上午没有人写报告' });
      if (!c.pmWrite) issues.push({ level: 'err', day: d, msg: dayName + ' 下午没有人写报告' });
      if (!state.duty[d]) issues.push({ level: 'warn', day: d, msg: dayName + ' 二值还没有排人' });

      var rawText = String(state.counts[d] == null ? '' : state.counts[d]).trim();
      var raw = rawText.replace(/\D/g, '');
      var vals = [c.amAudit, c.pmAudit, c.amWrite, c.pmWrite];
      var big = vals.some(function (v) { return v > 9; });
      var m = countsMatch(c, rawText);

      if (rawText && m === false && !big) {
        issues.push({
          level: 'warn', day: d,
          msg: dayName + ' 底部写的是 ' + raw + '（' + fmtSig(raw) + '），表内实际 ' + fmtCounts(c)
        });
      } else if (rawText && m !== true && big) {
        issues.push({
          level: 'info', day: d,
          msg: dayName + ' 人数到了两位数（' + fmtCounts(c) + '），建议写成 ' + fmtCountsValue(c)
        });
      }
    }
    return issues;
  }

  var Core = {
    WD: WD,
    pad2: pad2,
    parseDate: parseDate,
    fmtISO: fmtISO,
    fmtMD: fmtMD,
    mondayOf: mondayOf,
    weekDates: weekDates,
    analyzeText: analyzeText,
    cellText: cellText,
    dayCounts: dayCounts,
    signature: signature,
    fmtSig: fmtSig,
    fmtCounts: fmtCounts,
    fmtCountsValue: fmtCountsValue,
    parseCounts: parseCounts,
    countsMatch: countsMatch,
    splitMarks: splitMarks,
    newStaff: newStaff,
    emptyState: emptyState,
    fromSeed: fromSeed,
    validate: validate
  };

  if (typeof module === 'object' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
