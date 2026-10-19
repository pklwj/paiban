/*
 * 回归测试。用法：
 *   node tests/run.js           跑全部
 *   node tests/run.js core      只跑纯逻辑
 * 需要本机有 Chrome（默认查 Program Files，可用 CHROME 环境变量指定）。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/') + '?debug=1';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}

/* ---------------- 纯逻辑 ---------------- */
function runCore() {
  console.log('\n[core]');
  global.window = global;
  require(path.join(ROOT, 'js/seed.js'));
  const Core = require(path.join(ROOT, 'js/core.js'));

  const a = Core.analyzeText('上下审 XCM', Core.emptyState().dict);
  ok('上下审 → 上午下午都算审核', a.audit.am && a.audit.pm && !a.write.am);

  const b = Core.analyzeText('上审 XCM/休', Core.emptyState().dict);
  ok('上审/休 → 只算上午审核', b.audit.am && !b.audit.pm);

  const c = Core.analyzeText('休/下写 XCM', Core.emptyState().dict);
  ok('休/下写 → 只算下午写报告', !c.write.am && c.write.pm);

  const d = Core.analyzeText('中下写', Core.emptyState().dict);
  ok('中下写 → 下午', d.write.pm && !d.write.am);

  const st = Core.fromSeed(global.SEED);
  const mon = Core.dayCounts(st, 0);
  ok('示例周一男生人数 5/5 8/7', Core.fmtCounts(mon) === '审5/5 写8/7', Core.fmtCounts(mon));

  st.dict.countOnly = '医生';
  const docOnly = Core.signature(Core.dayCounts(st, 0));
  st.dict.countOnly = '';
  const all = Core.signature(Core.dayCounts(st, 0));
  ok('只统计医生与全体结果一致（本表无护士写审）', docOnly === all, docOnly + ' vs ' + all);

  ok('countsMatch 四位一致', Core.countsMatch(mon, '5587') === true);
  ok('countsMatch 不一致', Core.countsMatch(mon, '5588') === false);
  ok('countsMatch 带小数点也认', Core.countsMatch({ amAudit: 3, pmAudit: 3, amWrite: 6, pmWrite: 6 }, '33.66') === true);
  ok('countsMatch 空值返回 null', Core.countsMatch(mon, '') === null);

  ok('两位数用斜杠写法', Core.fmtCountsValue({ amAudit: 3, pmAudit: 3, amWrite: 10, pmWrite: 8 }) === '3/3/10/8');
  ok('单位数沿用连写', Core.fmtCountsValue({ amAudit: 5, pmAudit: 5, amWrite: 8, pmWrite: 7 }) === '5587');
  ok('解析连写', JSON.stringify(Core.parseCounts('5587')) === '[5,5,8,7]');
  ok('解析斜杠', JSON.stringify(Core.parseCounts('3/3/10/8')) === '[3,3,10,8]');
  ok('解析逗号', JSON.stringify(Core.parseCounts('3,3,10,8')) === '[3,3,10,8]');
  ok('解析 33.66', JSON.stringify(Core.parseCounts('33.66')) === '[3,3,6,6]');
  ok('解析认不出的返回 null', Core.parseCounts('33108') === null);
  ok('斜杠写法能比对通过', Core.countsMatch({ amAudit: 3, pmAudit: 3, amWrite: 10, pmWrite: 8 }, '3/3/10/8') === true);

  // 两位数且用斜杠写对了，就不该再提示
  const bigOk = Core.emptyState();
  for (let i = 0; i < 10; i++) {
    const s = Core.newStaff('医' + i);
    s.group = '医生';
    bigOk.staff.push(s);
    bigOk.cells[s.id] = ['上审 XCM', '', '', '', '', '', ''];
  }
  bigOk.counts[0] = '10/0/0/0';
  const okIssues = Core.validate(bigOk);
  ok('两位数写对了不报「两位数」提示', !okIssues.some(x => x.msg.indexOf('两位数') !== -1), okIssues.map(x => x.msg));

  // 两位数：四位数放不下，应该给出提示而不是静默
  const big = Core.emptyState();
  for (let i = 0; i < 10; i++) {
    const s = Core.newStaff('医' + i);
    s.group = '医生';
    big.staff.push(s);
    big.cells[s.id] = ['上下审 XCM', '', '', '', '', '', ''];
  }
  big.counts[0] = '0587';
  const issues = Core.validate(big);
  ok('10 人审核时提示「两位数」', issues.some(x => x.msg.indexOf('两位数') !== -1), issues.map(x => x.msg));

  ok('splitMarks 剥离尾部标记', Core.splitMarks('上下写 XCM●', ['●']).marks === '●');
  ok('splitMarks 不误伤正文', Core.splitMarks('休/下写 XCM', ['●']).text === '休/下写 XCM');

  // 导出：生成文件并确认能读回
  const ExcelJS = require(path.join(ROOT, 'vendor/exceljs.min.js'));
  const Export = require(path.join(ROOT, 'js/export.js'));
  return Export.buildWorkbook(ExcelJS, st).xlsx.writeBuffer().then(buf => {
    ok('生成 xlsx 字节数正常', buf.byteLength > 5000, buf.byteLength);
    const out = path.join(os.tmpdir(), 'paiban-test.xlsx');
    fs.writeFileSync(out, Buffer.from(buf));
    ok('xlsx 已落盘', fs.existsSync(out));
  });
}

/* ---------------- 浏览器交互 ---------------- */
function findChrome() {
  const cands = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  return cands.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
}

const get = p => new Promise((res, rej) => http.get(p, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej));

async function runUI() {
  console.log('\n[ui]');
  const chrome = findChrome();
  if (!chrome) { console.log('  跳过：没找到 Chrome/Edge'); return; }

  const port = 9401;
  const profile = path.join(os.tmpdir(), 'paiban-test-profile');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + port, '--window-size=1400,900',
    'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/')], { stdio: 'ignore' });

  let ws;
  try {
    let list = [];
    for (let i = 0; i < 50; i++) {
      try {
        const j = JSON.parse(await get('http://127.0.0.1:' + port + '/json/list'));
        list = j.filter(t => t.type === 'page' && t.url.indexOf('index.html') !== -1);
        if (list.length) break;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 300));
    }
    if (!list.length) { console.log('  跳过：拿不到调试目标'); return; }

    ws = new WebSocket(list[0].webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let id = 0; const pend = new Map(); const errors = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    });
    const send = (method, params) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evl = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval error');
      return r.result.result.value;
    };
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await send('Runtime.enable');

    // 让下一次导航前就禁用本地存储，验证「localStorage 不可用时仍写文件」
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'try{Storage.prototype.setItem=function(){throw new Error("storage blocked")}}catch(e){}'
    });
    await send('Page.navigate', { url: PAGE });
    await wait(1500);

    ok('页面渲染 43 人', await evl("document.querySelectorAll('tr.srow').length") === 43);
    ok('提示本地存储不可用', await evl("document.getElementById('storeWarn').hidden === false"));

    // 注入假文件句柄，改一格，确认仍然写文件（修复前的 bug：save 提前 return）
    await evl(`(function(){
      window.__w=null;
      window.PaibanFileDebug.setHandle({
        name:'t.json',
        queryPermission:function(){return Promise.resolve('granted')},
        createWritable:function(){return Promise.resolve({write:function(t){window.__w=t;return Promise.resolve()},close:function(){return Promise.resolve()}})},
        getFile:function(){return Promise.resolve({text:function(){return Promise.resolve('{}')}})}
      },'t.json');
      return 1;
    })()`);
    await evl("document.querySelector('td.cell[data-r=\"0\"][data-d=\"0\"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait(150);
    await evl("(function(){document.querySelector('.pop-input').value='本地存储坏了也能存';document.querySelector('.pop [data-act=\"ok\"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));return 1})()");
    await wait(1200);
    ok('本地存储不可用时仍写入文件', await evl("!!window.__w") === true);
    ok('写入内容正确', await evl("(function(){try{var o=JSON.parse(window.__w);return o.cells[o.staff[0].id][0]}catch(e){return 'parse-fail'}})()") === '本地存储坏了也能存');

    // 滚动时提交而不是丢弃
    await evl("document.querySelector('td.cell[data-r=\"1\"][data-d=\"1\"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait(150);
    await evl("document.querySelector('.pop-input').value='滚动提交测试'");
    await evl("document.getElementById('gridwrap').dispatchEvent(new Event('scroll'))");
    await wait(300);
    ok('滚动后内容已提交', await evl("document.querySelector('td.cell[data-r=\"1\"][data-d=\"1\"]').textContent") === '滚动提交测试');
    ok('浮动层已关闭', await evl("!document.querySelector('.pop')") === true);

    // Tab 不被工具按钮劫持
    const tabBtn = await evl(`(function(){
      var e=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});
      document.getElementById('btnExport').dispatchEvent(e);
      return e.defaultPrevented;
    })()`);
    ok('按钮上按 Tab 不拦截', tabBtn === false);
    const tabBody = await evl(`(function(){
      var e=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    })()`);
    ok('表格上按 Tab 由程序接管', tabBody === true);

    // 拖动框选 3×3
    const dragCount = await evl(`(function(){
      document.querySelector('td.cell[data-r="0"][data-d="0"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
      document.querySelector('td.cell[data-r="2"][data-d="2"]').dispatchEvent(new MouseEvent('mousemove',{bubbles:true}));
      document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      return document.querySelectorAll('td.cell.rng').length;
    })()`);
    ok('拖动框选 3×3 = 9 格', dragCount === 9, dragCount);

    // Shift+方向键扩选
    const shiftCount = await evl(`(function(){
      document.querySelector('td.cell[data-r="0"][data-d="0"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
      document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true}));
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true}));
      return document.querySelectorAll('td.cell.rng').length;
    })()`);
    ok('Shift+右移两次选中 3 格', shiftCount === 3, shiftCount);

    // Ctrl+C 复制成 TSV
    const copied = await evl(`(function(){
      window.__cp=null;
      try{ Object.defineProperty(navigator.clipboard,'writeText',{value:function(t){window.__cp=t;return Promise.resolve()},configurable:true}); }catch(e){}
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',ctrlKey:true,bubbles:true}));
      return window.__cp;
    })()`);
    ok('复制内容为制表符分隔', copied === '本地存储坏了也能存\t上下审 XCM▲\t上下审 XCM/开会', copied);

    // 从外部粘贴 2×2 区块
    const pasteOk = await evl(`(function(){
      var dt=new DataTransfer();
      dt.setData('text/plain','甲\\t乙\\n丙\\t丁');
      document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
      return [
        document.querySelector('td.cell[data-r="0"][data-d="0"]').textContent,
        document.querySelector('td.cell[data-r="0"][data-d="1"]').textContent,
        document.querySelector('td.cell[data-r="1"][data-d="0"]').textContent,
        document.querySelector('td.cell[data-r="1"][data-d="1"]').textContent
      ].join(',');
    })()`);
    ok('粘贴 2×2 区块', pasteOk === '甲,乙,丙,丁', pasteOk);

    // 单格内容铺满选区
    const fillOk = await evl(`(function(){
      document.querySelector('td.cell[data-r="3"][data-d="0"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
      document.querySelector('td.cell[data-r="4"][data-d="1"]').dispatchEvent(new MouseEvent('mousemove',{bubbles:true}));
      document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      var dt=new DataTransfer();
      dt.setData('text/plain','整块');
      document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
      var out=[];
      for(var r=3;r<=4;r++) for(var c=0;c<=1;c++) out.push(document.querySelector('td.cell[data-r="'+r+'"][data-d="'+c+'"]').textContent);
      return out.join(',');
    })()`);
    ok('单格粘贴铺满 2×2', fillOk === '整块,整块,整块,整块', fillOk);

    // 单击只选中，再点才进编辑
    const clickOnce = await evl(`(function(){
      function tap(r,d){
        var td=document.querySelector('td.cell[data-r="'+r+'"][data-d="'+d+'"]');
        td.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
        document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
        td.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      }
      tap(6,3);
      var first = !!document.querySelector('.pop');
      tap(6,3);
      var second = !!document.querySelector('.pop');
      if (document.querySelector('.pop')) document.querySelector('.pop [data-act="cancel"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      return [first, second].join(',');
    })()`);
    ok('第一次单击不弹编辑、第二次才弹', clickOnce === 'false,true', clickOnce);

    // 删到最后一个人以后按 Enter 不报错
    await evl("document.getElementById('btnPeople').click()");
    await wait(200);
    await evl("(function(){var rows=document.querySelectorAll('#modalBody .prow');rows[rows.length-1].querySelector('[data-act=\\\"del\\\"]').click();return rows.length})()");
    await evl("document.querySelector('#modalFoot button[data-act=\"save\"]').click()");
    await wait(400);
    await evl("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await wait(300);
    ok('删人后按 Enter 不抛异常', errors.length === 0, errors);
    ok('人员数减 1', await evl("document.querySelectorAll('tr.srow').length") === 42);

    ok('全程无 JS 异常', errors.length === 0, errors);
  } finally {
    if (ws) try { ws.close(); } catch (e) {}
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

(async () => {
  const only = process.argv[2];
  if (only !== 'ui') await runCore();
  if (only !== 'core') await runUI();
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e && e.stack || e); process.exit(2); });
