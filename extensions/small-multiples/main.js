/*
 * TIC Small Multiples (bars with variance) - a Tableau viz extension.
 *
 * One small bar chart per member of the "Panel by" field, every panel on the
 * same axes. When a comparison measure is on "Compare to" (a target, or last
 * year), each bar also shows its variance: a green cap where the value beat the
 * comparison, a red block where it fell short, and a thin dark tick marking the
 * comparison itself. Up to two panels whose totals are clearly worst get a red
 * outline, so the bad news stands out without anyone hunting for it.
 *
 * Marks-card tiles (ids must match the .trex <encoding id="...">):
 *   date    - Bars       (one bar per value, e.g. MONTH(Order Date))
 *   measure - Value      (a measure, e.g. SUM(Sales))
 *   compare - Compare to (a measure, e.g. SUM(Target); optional, none = plain bars)
 *   panel   - Panel by   (a dimension, e.g. Region; optional, none = one chart)
 *
 * Higher is better: a value above its comparison is green. (For costs, where
 * lower is better, swap GOOD_IS_HIGHER below.)
 *
 * Plain JavaScript and SVG, no build step and no third-party chart library, so
 * it runs from any static web server and an IT reviewer can read every line.
 * Data is only ever written into the page as text (never as HTML).
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MAX_PANELS = 60;          // more than this is unreadable; we say so on screen
  var GOOD_IS_HIGHER = true;    // a value above its comparison is good (green)
  var STANDOUT_MAX = 2;         // at most this many panels get the "worst" outline
  var STANDOUT_BELOW = -0.05;   // ...and only if their total is at least 5% below the comparison
  var STANDOUT_MIN_PANELS = 3;  // with one or two panels there is nothing to stand out from
  var TARGET_ASPECT = 1.6;      // preferred panel width / height
  var LEFT_GUTTER = 46;         // room for y-axis labels on the first column
  var HEADER_H = 24;            // "Sales vs Target by Order Date, one panel per Region"
  var TITLE_H = 18;             // panel title strip
  var X_AXIS_H = 16;            // room for x-axis labels under each panel
  var PAD = 6;                  // space between panels
  var BAR_FILL = 0.68;          // share of each slot the bar takes up

  var lastModel = null;         // last data we drew, so a resize needs no refetch
  var lastSize = '';            // size of the last drawing, e.g. "900x560"
  var generation = 0;           // discards a slow fetch overtaken by a newer one
  var refreshTimer = null;
  var resizeFrame = null;
  var unregisterFns = [];       // Tableau's addEventListener returns an unregister function

  var chartEl = document.getElementById('chart');
  var messageEl = document.getElementById('message');
  var tooltipEl = document.getElementById('tooltip');

  // ---------------------------------------------------------------- start-up

  function boot() {
    tableau.extensions.initializeAsync().then(function () {
      var ws = tableau.extensions.worksheetContent.worksheet;
      var eventType = (tableau.TableauEventType && tableau.TableauEventType.SummaryDataChanged) || 'summary-data-changed';
      unregisterFns.push(ws.addEventListener(eventType, scheduleRefresh));
      wireResize();
      refresh();
    }).catch(function (err) {
      showMessage('The extension could not start', errorText(err));
    });
  }

  // Works whether this script runs before or after the page has finished loading.
  if (document.readyState === 'complete') { boot(); } else { window.addEventListener('load', boot); }

  window.addEventListener('unload', function () {
    unregisterFns.forEach(function (fn) { try { fn(); } catch (e) { /* already gone */ } });
  });

  function scheduleRefresh() {
    // Tableau can fire several changes in a burst (dragging pills); wait for it to settle.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 100);
  }

  function wireResize() {
    function onResize() {
      if (resizeFrame) { cancelAnimationFrame(resizeFrame); }
      resizeFrame = requestAnimationFrame(function () {
        // Only redraw when the size really changed, so a hover is not wiped for nothing.
        var size = window.innerWidth + 'x' + window.innerHeight;
        if (lastModel && size !== lastSize) { draw(lastModel); }
      });
    }
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) { new ResizeObserver(onResize).observe(document.body); }
  }

  // ---------------------------------------------------------------- reading Tableau

  function refresh() {
    var myGen = ++generation;
    var ws = tableau.extensions.worksheetContent.worksheet;

    Promise.all([getEncodings(ws), readSummary(ws)]).then(function (results) {
      if (myGen !== generation) { return; }        // a newer refresh has started
      var enc = results[0];
      var table = results[1];

      if (!enc.date || !enc.measure) {
        lastModel = null;
        showMessage('Small multiples: add your fields',
          'On the Marks card, drop a date on Bars (for example MONTH(Order Date)) and ' +
          'a measure on Value (for example SUM(Sales)). Optionally, add a second measure on ' +
          'Compare to (a target or last year) to see the variance, and a dimension on ' +
          'Panel by (for example Region).');
        return;
      }
      var model = buildModel(enc, table);
      if (!model.panels.length) {
        lastModel = null;
        showMessage('No data to draw', 'The worksheet returned no rows with both a bar and a number. Check your filters.');
        return;
      }
      lastModel = model;
      draw(model);
    }).catch(function (err) {
      if (myGen !== generation) { return; }
      showMessage('Could not read the worksheet data', errorText(err));
    });
  }

  function getEncodings(ws) {
    return ws.getVisualSpecificationAsync().then(function (spec) {
      var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
      var out = { date: null, measure: null, compare: null, panel: null };
      ((marks && marks.encodings) || []).forEach(function (e) {
        if (e.id in out && !out[e.id] && e.field) { out[e.id] = e.field.name; }
      });
      return out;
    });
  }

  function readSummary(ws) {
    return ws.getSummaryDataReaderAsync().then(function (reader) {
      // An empty table has no pages, and asking for them throws, so check first.
      var read = reader.totalRowCount === 0
        ? Promise.resolve({ columns: [], data: [], isTotalRowCountLimited: false })
        : reader.getAllPagesAsync();
      return read.then(function (table) {
        return release(reader).then(function () { return table; });
      }, function (err) {
        return release(reader).then(function () { throw err; });
      });
    });
  }

  function release(reader) {
    // Readers hold resources in Tableau; always hand them back, and never let a
    // failed clean-up hide the real result.
    return Promise.resolve().then(function () { return reader.releaseAsync(); })
      .catch(function (err) { console.warn('[small-multiples] release failed', err); });
  }

  // ---------------------------------------------------------------- shaping the data

  function toNumber(dv) {
    if (!dv) { return null; }
    var n = typeof dv.value === 'number' ? dv.value : parseFloat(dv.value);
    return isFinite(n) ? n : null;               // nulls and blanks become "no value"
  }

  function buildModel(enc, table) {
    var cols = table.columns || [];
    function colIndex(name) {
      for (var i = 0; i < cols.length; i++) {
        if (cols[i].fieldName === name) {
          return (typeof cols[i].index === 'number' && cols[i].index >= 0) ? cols[i].index : i;
        }
      }
      return -1;
    }
    var xi = colIndex(enc.date);
    var yi = colIndex(enc.measure);
    var ci = enc.compare ? colIndex(enc.compare) : -1;
    var pi = enc.panel ? colIndex(enc.panel) : -1;
    if (xi < 0 || yi < 0) { return { panels: [] }; }

    // Decide what kind of bars we have: real dates, plain numbers, or categories.
    var rows = table.data || [];
    var allDates = true, allNumbers = true;
    rows.forEach(function (r) {
      var v = r[xi] && r[xi].value;
      if (v === null || v === undefined) { return; }
      if (parseDate(v) === null) { allDates = false; }
      if (typeof v !== 'number') { allNumbers = false; }
    });
    var xKind = allDates ? 'time' : (allNumbers ? 'linear' : 'ordinal');

    // Every distinct bar value becomes a "slot", shared by all panels, so the
    // same month sits in the same place in every panel.
    var slotByKey = {}, slots = [];
    function slotFor(xv) {
      var key, sortKey;
      if (xKind === 'time') { sortKey = parseDate(xv.value); key = String(sortKey); }
      else if (xKind === 'linear') { sortKey = xv.value; key = String(sortKey); }
      else { key = String(xv.formattedValue); sortKey = slots.length; }   // categories keep Tableau's order
      if (sortKey === null || (typeof sortKey === 'number' && !isFinite(sortKey))) { return null; }
      if (!(key in slotByKey)) { slotByKey[key] = { key: key, sortKey: sortKey, label: String(xv.formattedValue) }; slots.push(slotByKey[key]); }
      return slotByKey[key];
    }

    var byMember = {}, order = [];
    var valueSample = null;
    rows.forEach(function (r) {
      var xv = r[xi];
      var y = toNumber(r[yi]);
      if (!xv || y === null) { return; }
      var slot = slotFor(xv);
      if (!slot) { return; }
      var c = ci >= 0 ? toNumber(r[ci]) : null;
      if (valueSample === null) { valueSample = String(r[yi].formattedValue); }

      var member = pi >= 0 && r[pi] ? String(r[pi].formattedValue) : 'All';
      if (!byMember[member]) { byMember[member] = {}; order.push(member); }
      var cell = byMember[member][slot.key];
      if (!cell) {
        byMember[member][slot.key] = {
          value: y, compare: c,
          valueLabel: String(r[yi].formattedValue),
          compareLabel: c === null ? null : String(r[ci].formattedValue)
        };
      } else {
        // The same bar twice for one member (a finer field on Detail): add them up.
        cell.value += y; cell.valueLabel = null;
        if (c !== null) { cell.compare = (cell.compare || 0) + c; cell.compareLabel = null; }
      }
    });

    if (xKind !== 'ordinal') { slots.sort(function (a, b) { return a.sortKey - b.sortKey; }); }
    slots.forEach(function (s, i) { s.index = i; });

    var fmt = makeFormatter(valueSample);
    var hasCompare = ci >= 0;
    var yMin = 0, yMax = 0;

    var panels = order.map(function (m) {
      var cells = slots.map(function (s) {
        var cell = byMember[m][s.key];
        if (!cell) { return null; }
        if (cell.valueLabel === null) { cell.valueLabel = fmt.plain(cell.value); }
        if (cell.compare !== null && cell.compareLabel === null) { cell.compareLabel = fmt.plain(cell.compare); }
        cell.variance = cell.compare === null ? null : cell.value - cell.compare;
        return cell;
      });
      var sumV = 0, sumC = 0, pairs = 0, total = 0;
      cells.forEach(function (cell) {
        if (!cell) { return; }
        total += cell.value;
        if (cell.compare !== null) { sumV += cell.value; sumC += cell.compare; pairs++; }
      });
      var varAbs = pairs ? sumV - sumC : null;
      var varPct = pairs && sumC !== 0 ? varAbs / Math.abs(sumC) : null;
      return { member: m, cells: cells, total: total, varAbs: varAbs, varPct: varPct, standout: false };
    });

    var hidden = Math.max(0, panels.length - MAX_PANELS);
    panels = panels.slice(0, MAX_PANELS);

    // The shared value axis covers every bar and every comparison tick, and zero.
    panels.forEach(function (p) {
      p.cells.forEach(function (cell) {
        if (!cell) { return; }
        yMin = Math.min(yMin, cell.value); yMax = Math.max(yMax, cell.value);
        if (cell.compare !== null) { yMin = Math.min(yMin, cell.compare); yMax = Math.max(yMax, cell.compare); }
      });
    });
    if (yMin === yMax) { yMax = yMin + 1; }

    markStandouts(panels);

    return {
      panels: panels,
      hiddenCount: hidden,
      limited: table.isTotalRowCountLimited === true,
      xKind: xKind,
      slots: slots,
      hasCompare: hasCompare,
      fmt: fmt,
      yDomain: [yMin, yMax],
      names: {
        date: cleanName(enc.date),
        measure: cleanName(enc.measure),
        compare: enc.compare ? cleanName(enc.compare) : null,
        panel: enc.panel ? cleanName(enc.panel) : null
      }
    };
  }

  // "Two tiles stand out": the panels whose totals fall furthest short of the
  // comparison, at most STANDOUT_MAX of them, and only if they are at least
  // 5% short. A panel that is merely a bit below, or a chart with fewer than
  // three panels, is never outlined.
  function markStandouts(panels) {
    if (panels.length < STANDOUT_MIN_PANELS) { return; }
    var sign = GOOD_IS_HIGHER ? 1 : -1;
    panels
      .filter(function (p) { return p.varPct !== null && sign * p.varPct <= STANDOUT_BELOW; })
      .sort(function (a, b) { return sign * a.varPct - sign * b.varPct; })
      .slice(0, STANDOUT_MAX)
      .forEach(function (p) { p.standout = true; });
  }

  function isGood(variance) { return GOOD_IS_HIGHER ? variance > 0 : variance < 0; }

  // Tableau hands continuous dates over as strings such as "2026-08-01 00:00:00"
  // (verified in Desktop 2026.2). Read the digits directly and build a UTC time;
  // new Date("...") would read it as local time and can shift the month.
  function parseDate(v) {
    if (v instanceof Date) { return v.getTime(); }
    if (typeof v !== 'string') { return null; }
    var m = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
    if (!m) { return null; }
    return Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 1, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  }

  // "SUM(Sales)" -> "Sales", "MONTH(Order Date)" -> "Order Date"
  function cleanName(name) {
    if (!name) { return ''; }
    var m = /^[A-Za-z]+\((.*)\)$/.exec(name.trim());
    return m ? m[1] : name;
  }

  // Tableau formats each value for us ("$38,000"), but nobody formats the
  // variance. Borrow the currency sign and decimals from a sample value so the
  // variance reads the same way: "+$2,150". Percent and odd formats fall back
  // to a plain number.
  function makeFormatter(sample) {
    var prefix = '', suffix = '', decimals = 0, ok = false;
    var m = sample ? /^([^\d\-−(]*)-?([\d,]+)(?:\.(\d+))?([^\d]*)$/.exec(sample.trim()) : null;
    if (m && m[4].indexOf('%') < 0) { ok = true; prefix = m[1]; decimals = m[3] ? m[3].length : 0; suffix = m[4]; }
    var nf = (typeof Intl !== 'undefined')
      ? new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      : null;
    function body(n) { return nf ? nf.format(Math.abs(n)) : String(Math.abs(n)); }
    return {
      plain: function (n) { return ok ? (n < 0 ? '-' : '') + prefix + body(n) + suffix : fmtNumber(n); },
      signed: function (n) {
        var s = n > 0 ? '+' : (n < 0 ? '−' : '±');
        return ok ? s + prefix + body(n) + suffix : s + fmtNumber(Math.abs(n));
      }
    };
  }

  function fmtPct(p) {
    if (p === null) { return ''; }
    var s = p > 0 ? '+' : (p < 0 ? '−' : '±');
    return s + (Math.abs(p) * 100).toFixed(1) + '%';
  }

  // ---------------------------------------------------------------- scales and ticks

  // Round-number ticks covering lo..hi, using at most `count` intervals.
  function niceTicks(lo, hi, count) {
    var span = hi - lo;
    var mag = Math.pow(10, Math.floor(Math.log10(span / count)));
    var step = mag * 10;
    var mults = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < mults.length; i++) {
      var s = mag * mults[i];
      if (Math.ceil(hi / s) - Math.floor(lo / s) <= count) { step = s; break; }
    }
    var start = Math.floor(lo / step) * step;
    var end = Math.ceil(hi / step) * step;
    var ticks = [];
    for (var t = start; t <= end + step / 2; t += step) { ticks.push(Math.round(t / step) * step); }
    return ticks;
  }

  var compactFmt = (typeof Intl !== 'undefined')
    ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
    : null;
  function fmtNumber(n) { return compactFmt ? compactFmt.format(n) : String(n); }

  // Short labels under the bars: "Jan" when every bar is in one year, "Jan 26" otherwise.
  function slotLabel(model, slot) {
    if (model.xKind === 'time') {
      var first = new Date(model.slots[0].sortKey).getUTCFullYear();
      var last = new Date(model.slots[model.slots.length - 1].sortKey).getUTCFullYear();
      var opts = first === last
        ? { month: 'short', timeZone: 'UTC' }
        : { month: 'short', year: '2-digit', timeZone: 'UTC' };
      return new Intl.DateTimeFormat(undefined, opts).format(new Date(slot.sortKey));
    }
    if (model.xKind === 'linear') { return String(slot.sortKey); }   // years stay 2024, not 2k
    return slot.label;
  }

  // ---------------------------------------------------------------- layout

  function chooseGrid(n, width, height) {
    var best = { cols: 1, rows: n, score: -1 };
    for (var cols = 1; cols <= n; cols++) {
      var rows = Math.ceil(n / cols);
      var pw = (width - LEFT_GUTTER) / cols;
      var ph = (height - HEADER_H) / rows;
      var plotW = pw - 2 * PAD, plotH = ph - TITLE_H - X_AXIS_H - PAD;
      if (plotW <= 0 || plotH <= 0) { continue; }
      // Reward big panels, penalise shapes far from the preferred aspect, and
      // avoid leaving most of the last row empty.
      var aspect = plotW / plotH;
      var shapePenalty = Math.min(aspect / TARGET_ASPECT, TARGET_ASPECT / aspect);
      var fill = n / (rows * cols);
      var score = Math.min(plotW, plotH * TARGET_ASPECT) * shapePenalty * (0.7 + 0.3 * fill);
      if (score > best.score) { best = { cols: cols, rows: rows, score: score }; }
    }
    return best;
  }

  // ---------------------------------------------------------------- drawing

  function el(name, attrs, parent) {
    var node = document.createElementNS(SVG_NS, name);
    for (var k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) { node.setAttribute(k, attrs[k]); } }
    if (parent) { parent.appendChild(node); }
    return node;
  }

  function text(parent, x, y, str, cls, anchor) {
    var t = el('text', { x: x, y: y, 'class': cls, 'text-anchor': anchor || 'start' }, parent);
    t.textContent = str;                          // text only: member names can never become HTML
    return t;
  }

  function textWidth(node, fallbackChars) {
    try { return node.getComputedTextLength(); } catch (e) { return fallbackChars * 6.5; }
  }

  // A rectangle between two y positions, whichever way round they come.
  function vRect(g, x, w, ya, yb, cls) {
    var top = Math.min(ya, yb), h = Math.abs(ya - yb);
    return el('rect', { x: x.toFixed(1), y: top.toFixed(1), width: w.toFixed(1), height: Math.max(h, 0.5).toFixed(1), 'class': cls }, g);
  }

  function drawHeader(svg, model, width) {
    var n = model.names;
    var notes = [];
    if (model.hiddenCount) { notes.push('first ' + MAX_PANELS + ' panels shown, ' + model.hiddenCount + ' more hidden'); }
    if (model.limited) { notes.push('Tableau limited the rows sent'); }
    var right = width - PAD;
    if (notes.length) {
      var nt = text(svg, right, 16, notes.join(' · '), 'sm-note', 'end');
      right -= textWidth(nt, notes.join(' · ').length) + 16;
    }

    // Longest wording first; on a narrow worksheet fall back to shorter ones so
    // the legend never runs off the edge.
    var titles = [
      n.measure + (n.compare ? ' vs ' + n.compare : '') + ' by ' + n.date + (n.panel ? ', one panel per ' + n.panel : ''),
      n.measure + (n.compare ? ' vs ' + n.compare : '') + ' by ' + n.date,
      n.measure + (n.compare ? ' vs ' + n.compare : '')
    ];
    var legends = !model.hasCompare ? [[]] : [
      ['above ' + n.compare, 'below ' + n.compare, 'furthest below'],
      ['above', 'below', 'worst'],
      ['', '', '']
    ];
    var showStandout = model.panels.some(function (p) { return p.standout; });
    var classes = ['sm-var-good', 'sm-var-bad', 'sm-legend-standout'];

    var g = null;
    for (var li = 0; li < legends.length; li++) {
      for (var ti = 0; ti < titles.length; ti++) {
        if (g) { svg.removeChild(g); }
        g = el('g', {}, svg);
        var h = text(g, LEFT_GUTTER + PAD, 16, titles[ti], 'sm-header');
        var x = LEFT_GUTTER + PAD + textWidth(h, titles[ti].length) + 16;
        // A small legend, so nobody has to guess what green, red and the outline mean.
        legends[li].forEach(function (label, k) {
          if (k === 2 && !showStandout) { return; }
          el('rect', { x: x, y: 8, width: 9, height: 9, 'class': classes[k] }, g);
          x += 13;
          if (label) {
            var t = text(g, x, 16, label, 'sm-legend');
            x += textWidth(t, label.length);
          }
          x += 12;
        });
        if (x - 12 <= right) { return; }
      }
    }
  }

  function draw(model) {
    hideMessage();
    hideTooltip();
    lastSize = window.innerWidth + 'x' + window.innerHeight;
    var width = Math.max(200, window.innerWidth);
    var height = Math.max(150, window.innerHeight);
    while (chartEl.firstChild) { chartEl.removeChild(chartEl.firstChild); }

    var n = model.panels.length;
    var grid = chooseGrid(n, width, height);
    if (grid.score < 0) {
      showMessage('Not enough room', 'Make the worksheet bigger, or filter to fewer ' + (model.names.panel || 'panels') + '.');
      return;
    }
    var pw = (width - LEFT_GUTTER) / grid.cols;
    var ph = (height - HEADER_H) / grid.rows;
    var plotW = pw - 2 * PAD;
    var plotH = ph - TITLE_H - X_AXIS_H - PAD;

    var svg = el('svg', { width: width, height: height, role: 'img' }, chartEl);
    drawHeader(svg, model, width);

    // Shared scales: the same for every panel.
    // Fewer y ticks on short panels so the labels never crowd (about one per 25px).
    var yTicks = niceTicks(model.yDomain[0], model.yDomain[1], Math.max(3, Math.min(5, Math.floor(plotH / 25))));
    var yLo = yTicks[0], yHi = yTicks[yTicks.length - 1];
    function sy(v) { return plotH - (v - yLo) / (yHi - yLo) * plotH; }
    var nSlots = model.slots.length;
    var slotW = plotW / nSlots;
    var barW = Math.max(1, slotW * BAR_FILL);
    function slotX(i) { return i * slotW + (slotW - barW) / 2; }
    var y0 = sy(0);

    // Label every k-th bar so the labels never overlap (about 30px each).
    var labelEvery = Math.max(1, Math.ceil(30 / slotW));
    if (model.xKind === 'ordinal') { labelEvery = Math.max(labelEvery, Math.ceil(60 / slotW)); }

    var panelGeoms = [];

    model.panels.forEach(function (p, i) {
      var col = i % grid.cols, row = Math.floor(i / grid.cols);
      var left = LEFT_GUTTER + col * pw + PAD;
      var top = HEADER_H + row * ph;
      var plotTop = top + TITLE_H;

      if (p.standout) {
        el('rect', { x: left - 3, y: top - 1, width: plotW + 6, height: TITLE_H + plotH + 4, rx: 2, 'class': 'sm-standout' }, svg);
      }

      // Title: total variance (or total) on the right, member name in the room left over.
      var right, rightCls;
      if (model.hasCompare && p.varPct !== null) {
        var arrow = p.varAbs === 0 ? '' : (p.varAbs > 0 ? '▲ ' : '▼ ');
        right = [arrow + fmtPct(p.varPct) + ' vs ' + model.names.compare, arrow + fmtPct(p.varPct), fmtPct(p.varPct)];
        rightCls = p.varAbs === 0 ? 'sm-latest' : (isGood(p.varAbs) ? 'sm-total-good' : 'sm-total-bad');
      } else {
        right = ['total ' + model.fmt.plain(p.total), model.fmt.plain(p.total), fmtNumber(p.total)];
        rightCls = 'sm-latest';
      }
      // On narrow panels, drop words from the right-hand text until the name has room.
      var rt = text(svg, left + plotW, top + 13, right[0], rightCls, 'end');
      var room = plotW - textWidth(rt, right[0].length) - 8;
      for (var r = 1; r < right.length && room < Math.min(70, plotW * 0.5); r++) {
        rt.textContent = right[r];
        room = plotW - textWidth(rt, right[r].length) - 8;
      }
      fitText(text(svg, left, top + 13, p.member, p.standout ? 'sm-title sm-title-standout' : 'sm-title'), p.member, room);

      var g = el('g', { transform: 'translate(' + left + ',' + plotTop + ')' }, svg);
      el('rect', { x: 0, y: 0, width: plotW, height: plotH, 'class': 'sm-panel-bg' }, g);

      yTicks.forEach(function (t) {
        if (t === 0) { return; }                  // zero gets its own darker line, drawn over the bars
        var y = Math.round(sy(t)) + 0.5;
        el('line', { x1: 0, x2: plotW, y1: y, y2: y, 'class': 'sm-grid' }, g);
      });
      if (col === 0) {
        yTicks.forEach(function (t) { text(g, -6, Math.round(sy(t)) + 3.5, fmtNumber(t), 'sm-tick', 'end'); });
      }

      // The hover band sits behind the bars.
      var band = el('rect', { x: 0, y: 0, width: slotW, height: plotH, 'class': 'sm-hover-band', visibility: 'hidden' }, g);

      p.cells.forEach(function (cell, k) {
        if (!cell) { return; }
        var x = slotX(k);
        var yv = sy(cell.value);
        var hasVar = cell.compare !== null && cell.variance !== 0;
        var good = hasVar && isGood(cell.variance);
        // Good: a green cap on the bar, from the comparison to the value (drawn on top).
        // Bad: a red block from the value to where the comparison is (drawn underneath,
        // so a bar that dips below zero still shows in grey).
        if (hasVar && !good) { vRect(g, x, barW, yv, sy(cell.compare), 'sm-var-bad'); }
        vRect(g, x, barW, y0, yv, 'sm-bar');
        if (hasVar && good) { vRect(g, x, barW, yv, sy(cell.compare), 'sm-var-good'); }
        if (cell.compare !== null) {
          var yc = sy(cell.compare);
          var tickOver = Math.min(2, slotW * (1 - BAR_FILL) / 2);
          var ty = Math.round(yc) + 0.5;
          el('line', { x1: (x - tickOver).toFixed(1), x2: (x + barW + tickOver).toFixed(1), y1: ty, y2: ty, 'class': 'sm-compare' }, g);
        }
      });

      var zy = Math.round(y0) + 0.5;
      el('line', { x1: 0, x2: plotW, y1: zy, y2: zy, 'class': 'sm-zero' }, g);

      // x labels only where no panel sits underneath (the bottom of each column).
      var hasPanelBelow = i + grid.cols < n;
      if (!hasPanelBelow) {
        model.slots.forEach(function (s, k) {
          if (k % labelEvery !== 0) { return; }
          var maxPx = slotW * labelEvery - 4;
          text(g, k * slotW + slotW / 2, plotH + 12, truncate(slotLabel(model, s), maxPx), 'sm-tick', 'middle');
        });
      }

      panelGeoms.push({ panel: p, left: left, top: plotTop, band: band });
    });

    // Linked hover: point at one bar and the same bar lights up in every panel.
    svg.addEventListener('mousemove', function (ev) {
      var rect = svg.getBoundingClientRect();
      var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      var hit = null;
      for (var k = 0; k < panelGeoms.length; k++) {
        var pg = panelGeoms[k];
        if (mx >= pg.left && mx <= pg.left + plotW && my >= pg.top && my <= pg.top + plotH) { hit = pg; break; }
      }
      if (!hit) { clearHover(panelGeoms); return; }
      var idx = Math.min(nSlots - 1, Math.max(0, Math.floor((mx - hit.left) / slotW)));
      var cell = hit.panel.cells[idx];
      if (!cell) { clearHover(panelGeoms); return; }
      panelGeoms.forEach(function (pg) {
        pg.band.setAttribute('x', (idx * slotW).toFixed(1));
        pg.band.setAttribute('visibility', pg.panel.cells[idx] ? 'visible' : 'hidden');
      });
      showTooltip(ev.clientX, ev.clientY, hit.panel.member, model.slots[idx], cell, model);
    });
    svg.addEventListener('mouseleave', function () { clearHover(panelGeoms); });
  }

  function clearHover(panelGeoms) {
    panelGeoms.forEach(function (pg) { pg.band.setAttribute('visibility', 'hidden'); });
    hideTooltip();
  }

  // Shorten a drawn label, one letter at a time, until it fits the room it has.
  function fitText(node, str, maxPx) {
    var n = str.length;
    while (n > 3 && textWidth(node, n) > maxPx) { n--; node.textContent = str.slice(0, n - 1) + '…'; }
  }

  function truncate(str, maxPx) {
    var maxChars = Math.max(3, Math.floor(maxPx / 6.5));
    return str.length > maxChars ? str.slice(0, maxChars - 1) + '…' : str;
  }

  // ---------------------------------------------------------------- tooltip and messages

  function showTooltip(cx, cy, member, slot, cell, model) {
    var names = model.names;
    while (tooltipEl.firstChild) { tooltipEl.removeChild(tooltipEl.firstChild); }
    addLine(tooltipEl, member, 'tt-member');
    addPair(tooltipEl, names.date, slot.label);
    addPair(tooltipEl, names.measure, cell.valueLabel);
    if (cell.compare !== null) {
      addPair(tooltipEl, names.compare, cell.compareLabel);
      var pct = cell.compare !== 0 ? ' (' + fmtPct(cell.variance / Math.abs(cell.compare)) + ')' : '';
      var cls = cell.variance === 0 ? '' : (isGood(cell.variance) ? 'tt-good' : 'tt-bad');
      addPair(tooltipEl, 'Variance', model.fmt.signed(cell.variance) + pct, cls);
    } else if (model.hasCompare) {
      addPair(tooltipEl, names.compare, 'no value');
    }
    tooltipEl.hidden = false;
    var w = tooltipEl.offsetWidth, h = tooltipEl.offsetHeight;
    var left = cx + 14, top = cy + 14;
    if (left + w > window.innerWidth - 4) { left = cx - w - 14; }
    if (top + h > window.innerHeight - 4) { top = cy - h - 14; }
    tooltipEl.style.left = Math.max(4, left) + 'px';
    tooltipEl.style.top = Math.max(4, top) + 'px';
  }

  function addLine(parent, str, cls) {
    var div = document.createElement('div');
    if (cls) { div.className = cls; }
    div.textContent = str;
    parent.appendChild(div);
  }

  function addPair(parent, label, value, valueCls) {
    var div = document.createElement('div');
    var span = document.createElement('span');
    span.className = 'tt-label';
    span.textContent = label + ': ';
    div.appendChild(span);
    var v = document.createElement('span');
    if (valueCls) { v.className = valueCls; }
    v.textContent = value;
    div.appendChild(v);
    parent.appendChild(div);
  }

  function hideTooltip() { tooltipEl.hidden = true; }

  function showMessage(title, body) {
    while (chartEl.firstChild) { chartEl.removeChild(chartEl.firstChild); }
    while (messageEl.firstChild) { messageEl.removeChild(messageEl.firstChild); }
    var s = document.createElement('strong');
    s.textContent = title;
    messageEl.appendChild(s);
    messageEl.appendChild(document.createTextNode(body));
    messageEl.hidden = false;
    hideTooltip();
  }

  function hideMessage() { messageEl.hidden = true; }

  function errorText(err) {
    return (err && err.message) ? err.message : String(err);
  }
})();
