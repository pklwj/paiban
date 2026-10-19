/* export.js —— 生成 xlsx，版式对齐原表。浏览器用 window.PaibanExport，Node 里可直接 require 做校验。 */
(function (root) {
  'use strict';

  var Core = (typeof module === 'object' && typeof module.exports === 'object' && typeof require === 'function')
    ? require('./core.js')
    : root.Core;

  var FONT = '宋体';
  var LINE = { style: 'thin', color: { argb: 'FFA9B0BB' } };
  var COLS = 9;

  /* 配色：表头浅蓝、隔行浅灰、底部两行浅灰（周末不做特殊处理） */
  var FILL_HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F2' } };
  var FILL_BAND = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F6F8' } };
  var FILL_TOTAL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F6' } };
  var FILL_WHITE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };

  function border4() {
    return { top: LINE, left: LINE, bottom: LINE, right: LINE };
  }

  function dutyName(state, d) {
    var id = state.duty[d];
    if (!id) return '';
    for (var i = 0; i < state.staff.length; i++) {
      if (state.staff[i].id === id) return state.staff[i].name;
    }
    return '';
  }

  function buildWorkbook(ExcelJS, state) {
    var dates = Core.weekDates(state.weekStart);
    var n = state.staff.length;

    var wb = new ExcelJS.Workbook();
    wb.creator = '医学影像科排班表';
    wb.created = new Date();

    var ws = wb.addWorksheet('排班表');
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 2, topLeftCell: 'B3', activeCell: 'B3' }];
    ws.columns = [{ width: 15 }]
      .concat([{ width: 15.5 }, { width: 15.5 }, { width: 15.5 }, { width: 15.5 }, { width: 15.5 }, { width: 15.5 }, { width: 15.5 }])
      .concat([{ width: 12 }]);

    /* 标题 */
    ws.mergeCells(1, 1, 1, COLS);
    var title = ws.getCell(1, 1);
    title.value = state.title || '排班表';
    title.font = { name: FONT, size: 16, bold: true };
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    for (var c1 = 1; c1 <= COLS; c1++) ws.getRow(1).getCell(c1).border = border4();
    ws.getRow(1).height = 30;

    /* 表头 */
    var head = ['姓名'];
    dates.forEach(function (x) { head.push(x.wd + '\n' + x.md); });
    head.push('欠班-\n欠假+');

    var hr = ws.getRow(2);
    hr.height = 34;
    for (var i = 0; i < COLS; i++) {
      var hc = hr.getCell(i + 1);
      hc.value = head[i];
      hc.font = { name: FONT, size: 10.5, bold: true };
      hc.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      hc.border = border4();
      hc.fill = FILL_HEAD;
    }

    /* 人员行：隔行浅灰 + 周末列淡蓝 */
    state.staff.forEach(function (s, idx) {
      var row = ws.getRow(3 + idx);
      row.height = 23;
      var band = (idx % 2 === 1) ? FILL_BAND : FILL_WHITE;

      var nameCell = row.getCell(1);
      nameCell.value = (s.prefix || '') + s.name;
      nameCell.font = { name: FONT, size: 10, bold: true };
      nameCell.alignment = { horizontal: 'center', vertical: 'middle' };
      nameCell.border = border4();
      nameCell.fill = band;

      for (var d = 0; d < 7; d++) {
        var cell = row.getCell(2 + d);
        var parts = Core.splitMarks(Core.cellText(state, s.id, d), state.markers);
        if (parts.marks) {
          cell.value = {
            richText: [
              { font: { name: FONT, size: 10 }, text: parts.text },
              { font: { name: FONT, size: 8.5, color: { argb: 'FFD32F2F' }, vertAlign: 'superscript' }, text: parts.marks }
            ]
          };
        } else {
          cell.value = parts.text;
          cell.font = { name: FONT, size: 10 };
        }
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = border4();
        cell.fill = band;
      }

      var owed = row.getCell(COLS);
      owed.value = state.owed[s.id] || '';
      owed.font = { name: FONT, size: 10 };
      owed.alignment = { horizontal: 'center', vertical: 'middle' };
      owed.border = border4();
      owed.fill = band;
    });

    /* 二值行 */
    var dRow = ws.getRow(3 + n);
    dRow.height = 23;
    var dLabel = dRow.getCell(1);
    dLabel.value = '二值';
    dLabel.font = { name: FONT, size: 10, bold: true };
    dLabel.alignment = { horizontal: 'center', vertical: 'middle' };
    dLabel.border = border4();
    dLabel.fill = FILL_TOTAL;
    for (var d2 = 0; d2 < 7; d2++) {
      var dc = dRow.getCell(2 + d2);
      dc.value = dutyName(state, d2);
      dc.font = { name: FONT, size: 10, bold: true };
      dc.alignment = { horizontal: 'center', vertical: 'middle' };
      dc.border = border4();
      dc.fill = FILL_TOTAL;
    }
    var dOwed = dRow.getCell(COLS);
    dOwed.border = border4();
    dOwed.fill = FILL_TOTAL;

    /* 人数行（上午审/下午审/上午写/下午写，按原表写成 5587 这种） */
    var cRow = ws.getRow(4 + n);
    cRow.height = 23;
    var cLabel = cRow.getCell(1);
    cLabel.value = '';
    cLabel.border = border4();
    cLabel.fill = FILL_TOTAL;
    for (var d3 = 0; d3 < 7; d3++) {
      var cc = cRow.getCell(2 + d3);
      cc.value = String(state.counts[d3] == null ? '' : state.counts[d3]);
      cc.font = { name: FONT, size: 10 };
      cc.alignment = { horizontal: 'center', vertical: 'middle' };
      cc.border = border4();
      cc.fill = FILL_TOTAL;
    }
    var cOwed = cRow.getCell(COLS);
    cOwed.border = border4();
    cOwed.fill = FILL_TOTAL;

    /* 打印设置：A4 纵向、整张缩到一页、居中 */
    ws.pageSetup = {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      horizontalCentered: true,
      margins: { left: 0.3, right: 0.3, top: 0.3, bottom: 0.3, header: 0.15, footer: 0.15 },
      printTitlesRow: '1:2',
      printArea: 'A1:I' + (4 + n)
    };

    return wb;
  }

  function fileName(state) {
    var first = Core.weekDates(state.weekStart)[0];
    return String(state.title || '排班表').replace(/[\\\/:*?"<>|]/g, '') + '_' + first.iso + '.xlsx';
  }

  var api = { buildWorkbook: buildWorkbook, fileName: fileName };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PaibanExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
