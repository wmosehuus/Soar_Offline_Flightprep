/* Flight card core: OFP text parser + card builder + PDF renderer.
   Runs unchanged in the browser (window.FlightCard) and in Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlightCard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 1. PDF text -> lines (pdf.js textContent) ----------
  function linesFromTextContent(tc) {
    const items = tc.items.filter(i => i.str && i.str.trim() !== '');
    const rows = [];
    for (const it of items) {
      const x = it.transform[4], y = it.transform[5];
      let row = rows.find(r => Math.abs(r.y - y) < 2.5);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, w: it.width, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    return rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      let out = '', end = null;
      for (const it of r.items) {
        const cw = it.s.length ? Math.max(it.w / it.s.length, 3) : 5;
        if (end !== null) {
          const gap = it.x - end;
          out += gap > cw * 0.3 ? ' '.repeat(Math.max(1, Math.round(gap / cw))) : '';
        }
        out += it.s; end = it.x + it.w;
      }
      return out;
    });
  }

  // ---------- 2. Parser ----------
  const num = s => (s === undefined || s === null) ? null : parseInt(s, 10);
  function grab(text, re) { const m = re.exec(text); return m ? m.slice(1) : null; }

  function parseOfp(lines) {
    const flights = [];
    const starts = [];
    lines.forEach((l, i) => {
      const m = /Log Nr\.:\s*(\d+)\s+Page\s+1\s+([A-Z]{4})-([A-Z]{4})\s+([A-Z]{2,3}\d+[A-Z]?)\s*$/.exec(l);
      if (m) starts.push({ i, log: m[1], dep: m[2], arr: m[3], callsign: m[4] });
    });
    starts.forEach((st, k) => {
      const endLimit = k + 1 < starts.length ? starts[k + 1].i : lines.length;
      let end = endLimit;
      for (let j = st.i; j < endLimit; j++) if (/CAPT SIGN|RVSM CHECK/.test(lines[j])) { end = j; break; }
      flights.push(parseSegment(lines.slice(st.i, end), st));
    });
    return flights;
  }

  function parseSegment(seg, st) {
    const t = seg.join('\n');
    const f = { log: st.log, callsign: st.callsign, depIcao: st.dep, arrIcao: st.arr, warnings: [] };
    const need = (label, v) => { if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) f.warnings.push('OFP field not read: ' + label); return v; };
    let m;

    m = grab(t, /^\s*[A-Z]{2,3}\d+[A-Z]?\s+[A-Z]{4}-[A-Z]{4}\s+(\d{2}[A-Z]{3}\d{2})\s+ECON:\s*(?:CI\s*)?(\S*)\s+PERF-\s*([-\d.]+)\s+(\S+)\s+([A-Z0-9]{5,6})\s*$/m);
    if (m) { f.date = m[0]; f.ci = m[1]; f.perf = m[2]; f.type = m[3]; f.regFull = m[4]; f.reg = m[4].replace(/^ZS/, ''); }
    need('date/registration', m);
    m = grab(t, /COMP:\s*(\d\d:\d\d)(?::\d\d)?\s*\/ETD\s*(\d\d:\d\d)Z/); if (m) { f.comp = m[0]; f.etd = m[1]; }
    m = grab(t, /W\/C\s*([+-]?\d+)/); f.wc = m ? m[0] : '';
    m = grab(t, /DEST FL:\s*(\S+)/);
    f.fls = m ? (m[0].match(/FL(\d+)/g) || []).map(s => s.slice(2)) : [];
    need('cruise FL', f.fls.length ? 1 : null);
    m = grab(t, /ALTN FL:\s*(\d+)/); f.altnFl = m ? m[0] : '';
    m = grab(t, /CREW\/PAX\s*\(EST\s*(\d+)/); f.pax = need('EST PAX', m ? num(m[0]) : null);

    const row = (label, re) => { const g = grab(t, re); need(label, g); return g; };
    m = row('TRIP', /^\s*TRIP\s+([A-Z]{4})\/([A-Z]{3})\s+(\d+)\s+(\d+)\s+(\d+:\d\d)/m);
    if (m) { f.arrIata = m[1]; f.dist = num(m[2]); f.trip = num(m[3]); f.tripTime = m[4]; if (m[0] !== f.arrIcao) f.warnings.push('TRIP destination ' + m[0] + ' differs from header ' + f.arrIcao); }
    m = grab(t, /^\s*ALT1\s+([A-Z]{4})\/([A-Z]{3})\s+(\d+)\s+(\d+)\s+(\d+:\d\d)/m);
    f.alt1 = m ? { icao: m[0], iata: m[1], dist: num(m[2]), fuel: num(m[3]), time: m[4] } : null;
    need('ALT1', f.alt1);
    m = row('FINAL RES', /FINAL RES\s+(\d+)\s+(\d+:\d\d)/); if (m) f.finres = num(m[0]);
    m = row('ADDITIONAL', /ADDITIONAL\s+(\d+)\s+\d+:\d\d/); if (m) f.additional = num(m[0]);
    m = row('COMPANY FUEL', /COMPANY FUEL\s+(\d+)\s+\d+:\d\d/); if (m) f.company = num(m[0]);
    m = row('CONT', /^\s*CONT\s*(\S*)\s+(\d+)\s+\d+:\d\d/m); if (m) { f.contType = m[0]; f.cont = num(m[1]); }
    m = row('TAXI', /^\s*TAXI\s+(\d+)/m); if (m) f.taxi = num(m[0]);
    m = row('MIN RAMP FUEL', /MIN RAMP FUEL\/ENDUR\s+(\d+)\s+(\d+:\d\d)/); if (m) f.minRamp = num(m[0]);
    m = row('TANK/EXTRA', /^\s*(?:TANK\.\/EXTRA|TANKERING)\s+(\d+)\s+\d+:\d\d/m); if (m) f.tank = num(m[0]);
    m = row('BLOCK FUEL', /BLOCK FUEL\/ENDUR\s+(\d+)\s+(\d+:\d\d)/); if (m) { f.block = num(m[0]); f.endur = m[1]; }
    m = row('ZFW', /(\d+)\s+ZFW\b/); if (m) f.zfw = num(m[0]);
    m = row('T/O F', /(\d+)\s+T\/O F\b/); if (m) f.tof = num(m[0]);
    m = row('T/O WT', /(\d+)\s+T\/O WT\b/); if (m) f.tow = num(m[0]);
    m = row('LND WT', /(\d+)\s+LND WT\b/); if (m) f.lw = num(m[0]);
    m = grab(t, /UDL WT\s+(\d+)/); f.udl = m ? num(m[0]) : null;

    m = grab(t, /^\s*-([A-Z]{4})\/([A-Z]{3})\s+(\d+)\s+(\d+)\s+(\d+:\d\d)/m);
    f.alt2 = m ? { icao: m[0], iata: m[1], dist: num(m[2]), fuel: num(m[3]), time: m[4] } : null;
    m = grab(t, /NO ALTN SUBTRACT\s+(\d+)/); f.noAltnSubtract = m ? num(m[0]) : null;
    m = grab(t, /T\/O WT ADJ 1000KG-\+\/-\s*(\S+)/);
    f.adj1000 = m ? m[0] : null; need('T/O WT ADJ 1000KG', f.adj1000);
    m = row('CH/OUT (STD)', /(\d\d:\d\d)\s+CH\/OUT/); if (m) f.std = m[0];
    m = row('CHK/IN (STA)', /(\d\d:\d\d)\s+CHK\/IN/); if (m) f.sta = m[0];
    m = grab(t, /(\d+:\d\d)\s+CHOCKS/); f.blockTime = m ? m[0] : '';

    // arithmetic cross-checks: a misread figure should not reach the card silently
    const ok = (a, b, tol) => Math.abs(a - b) <= tol;
    if ([f.trip, f.alt1 && f.alt1.fuel, f.finres, f.additional, f.company, f.cont, f.taxi, f.minRamp].every(v => typeof v === 'number')) {
      const sum = f.trip + f.alt1.fuel + f.finres + f.additional + f.company + f.cont + f.taxi;
      if (!ok(sum, f.minRamp, 3)) f.warnings.push('Fuel lines sum to ' + sum + ' but MIN RAMP is ' + f.minRamp);
    }
    if (typeof f.minRamp === 'number' && typeof f.tank === 'number' && typeof f.block === 'number' && !ok(f.minRamp + f.tank, f.block, 2)) f.warnings.push('MIN RAMP + TANK/EXTRA does not equal BLOCK');
    if (typeof f.block === 'number' && typeof f.taxi === 'number' && typeof f.tof === 'number' && !ok(f.block - f.taxi, f.tof, 2)) f.warnings.push('BLOCK - TAXI does not equal T/O FUEL');
    if (typeof f.zfw === 'number' && typeof f.tof === 'number' && typeof f.tow === 'number' && !ok(f.zfw + f.tof, f.tow, 2)) f.warnings.push('ZFW + T/O FUEL does not equal T/O WT');
    if (typeof f.tow === 'number' && typeof f.trip === 'number' && typeof f.lw === 'number' && !ok(f.tow - f.trip, f.lw, 2)) f.warnings.push('T/O WT - TRIP does not equal LND WT');
    return f;
  }

  // ---------- 3. Card model ----------
  const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  function sortKey(f) {
    const m = /^(\d\d)([A-Z]{3})(\d\d)$/.exec(f.date || '');
    const d = m ? Date.UTC(2000 + +m[3], MONTHS[m[2]] || 0, +m[1]) : 0;
    const t = /^(\d\d):(\d\d)$/.exec(f.std || '');
    return d + (t ? (+t[1] * 60 + +t[2]) * 60000 : 0);
  }
  function iataOf(ref, icao) {
    for (const k in ref.airfields) if (ref.airfields[k].icao === icao) return k;
    return null;
  }
  const tonnes = v => (typeof v === 'number') ? (v / 1000).toFixed(3) : '';

  function buildCards(flights, ref) {
    // de-duplicate (same callsign + date): keep the last one supplied
    const seen = new Map();
    flights.forEach(f => seen.set(f.callsign + '|' + f.date + '|' + f.depIcao, f));
    const list = Array.from(seen.values()).sort((a, b) => sortKey(a) - sortKey(b));
    return list.map(f => {
      const w = f.warnings.slice();
      const dep = iataOf(ref, f.depIcao), arr = f.arrIata || iataOf(ref, f.arrIcao);
      const afDep = dep && ref.airfields[dep], afArr = arr && ref.airfields[arr];
      if (!afDep) w.push('No airfield data for ' + f.depIcao);
      if (!afArr) w.push('No airfield data for ' + f.arrIcao);
      const ac = ref.aircraft[f.reg];
      if (!ac) w.push('No aircraft data for ' + (f.regFull || '?'));
      const route = dep && arr ? ref.routes[dep + '-' + arr] : null;
      if (!route) w.push('No route MORA for ' + (dep || f.depIcao) + '-' + (arr || f.arrIcao));
      const altLine = a => a ? { icao: a.icao, fuel: (typeof f.finres === 'number') ? a.fuel + f.finres : null } : null;
      return {
        f, warnings: w,
        reg: f.reg || '?', dep: dep || f.depIcao, arr: arr || f.arrIcao,
        fltNo: (f.callsign || '').replace(/^[A-Z]+0*/, '') || f.callsign,
        msaDep: afDep && afDep.msa ? afDep.msa + ' MSA' : 'NO DATA', msaArr: afArr && afArr.msa ? afArr.msa + ' MSA' : 'NO DATA',
        std: f.std || '', sta: f.sta || '', time: f.tripTime || '',
        adj: f.adj1000 === null ? '' : f.adj1000,
        blockT: tonnes(f.block), burnT: tonnes(f.trip), pax: f.pax === null || f.pax === undefined ? '' : String(f.pax),
        fl: f.fls.join('/'),
        alt1: altLine(f.alt1), alt2: altLine(f.alt2),
        eo: afDep && afDep.eo && afDep.eo.length ? afDep.eo : ['NO ENGINE-OUT DATA FOR ' + (dep || f.depIcao)],
        rmora: route || 'NO DATA',
        zfw: f.zfw, tow: f.tow, lw: f.lw,
        ac: ac || null,
        refRev: [ac ? f.reg + ' ' + (ac.rev || 'V8.1') : '', afDep ? dep + ' ' + (afDep.rev || 'V8.1') : ''].filter(Boolean).join(', ')
      };
    });
  }

  // ---------- 4. PDF rendering (pdf-lib) ----------
  const COLS = [125, 125, 200, 125, 215, 45];
  const ROWS = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4.3, 1, 1, 1, 1, 4.3, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1];
  const C = {
    black: [0, 0, 0], red: [1, 0, 0], white: [1, 1, 1], grey: [0.85, 0.85, 0.85], txtGrey: [0.4, 0.4, 0.4],
    peach: [0.99, 0.91, 0.85], pink: [0.95, 0.86, 0.86], blue: [0.86, 0.9, 0.95], green: [0.85, 0.89, 0.74], warn: [0.8, 0, 0]
  };

  function makeDrawer(PDFLib, page, fonts) {
    const H = page.getHeight();
    const rgb = c => PDFLib.rgb(c[0], c[1], c[2]);
    const clean = s => String(s === null || s === undefined ? '' : s).replace(/[^\u0020-\u007E\u00A0-\u00FF\u2013\u2014\u2018-\u201D\u2022\u2026\u2190-\u2193]/g, '?');
    function rect(x, y, w, h, o) {
      o = o || {};
      page.drawRectangle({ x, y: H - y - h, width: w, height: h, color: o.fill ? rgb(o.fill) : undefined,
        borderColor: o.noBorder ? undefined : rgb(C.black), borderWidth: o.noBorder ? 0 : (o.lw || 0.6) });
    }
    function fit(text, font, size, maxW) {
      let s = size;
      while (s > 3 && font.widthOfTextAtSize(text, s) > maxW) s -= 0.25;
      return s;
    }
    function text(str, x, y, w, h, o) {
      o = o || {};
      str = clean(str); if (!str) return;
      const font = o.bold ? fonts.bold : fonts.reg, pad = o.pad === undefined ? Math.min(3, w * 0.04) : o.pad;
      const size = fit(str, font, o.size, w - 2 * pad);
      const tw = font.widthOfTextAtSize(str, size);
      const tx = o.align === 'left' ? x + pad : o.align === 'right' ? x + w - pad - tw : x + (w - tw) / 2;
      const capH = size * 0.64;
      const ty = o.valign === 'top' ? y + pad * 0.6 + capH + 1 : y + (h + capH) / 2;
      page.drawText(str, { x: tx, y: H - ty, size, font, color: rgb(o.color || C.black) });
    }
    function wrap(str, font, size, maxW) {
      const words = clean(str).split(/\s+/), out = []; let cur = '';
      for (const wd of words) {
        const t = cur ? cur + ' ' + wd : wd;
        if (font.widthOfTextAtSize(t, size) <= maxW || !cur) cur = t; else { out.push(cur); cur = wd; }
      }
      if (cur) out.push(cur);
      return out;
    }
    function para(linesIn, x, y, w, h, o) {
      const font = o.bold ? fonts.bold : fonts.reg; let size = o.size, lines;
      for (; ;) {
        lines = []; linesIn.forEach(l => wrap(l, font, size, w - 6).forEach(s => lines.push(s)));
        if (lines.length * size * 1.18 <= h - 3 || size <= 4) break; size -= 0.25;
      }
      lines.forEach((l, i) => page.drawText(l, { x: x + 3, y: H - (y + 2 + size * 0.85 + i * size * 1.18), size, font, color: rgb(o.color || C.black) }));
    }
    return { rect, text, para };
  }

  function drawCard(PDFLib, page, fonts, card, X, Y, W, Hh, footer) {
    const d = makeDrawer(PDFLib, page, fonts);
    const cs = COLS.reduce((a, b) => a + b, 0), rs = ROWS.reduce((a, b) => a + b, 0);
    const cx = [X]; COLS.forEach(c => cx.push(cx[cx.length - 1] + c / cs * W));
    const ry = [Y]; ROWS.forEach(r => ry.push(ry[ry.length - 1] + r / rs * Hh));
    const u = Hh / rs;
    const cell = (c0, c1, r0, r1, o) => {
      o = o || {};
      const x = cx[c0], y = ry[r0], w = cx[c1 + 1] - cx[c0], h = ry[r1 + 1] - ry[r0];
      d.rect(x, y, w, h, o);
      if (o.t !== undefined && o.t !== null && o.t !== '') d.text(o.t, x, y, w, h, Object.assign({ size: u * 0.62 }, o));
      return { x, y, w, h };
    };
    const S = k => u * k;
    const c = card;

    // header
    cell(0, 0, 0, 1, { t: c.reg, bold: true, size: S(1.05) });
    cell(1, 1, 0, 1, { t: 'P/BAY', bold: true, size: S(0.6), valign: 'top' });
    cell(2, 4, 0, 2, { t: 'MEL/CDL', bold: true, size: S(0.62), valign: 'top', fill: C.peach });
    cell(0, 1, 2, 2, { t: 'TNK REQ      Y  /  N', align: 'left', size: S(0.6) });
    // sector block
    cell(0, 0, 3, 3, { t: c.dep }); cell(1, 1, 3, 3, { t: c.arr });
    cell(2, 2, 3, 4, { t: c.fltNo, bold: true, size: S(1.15) });
    cell(3, 3, 3, 3, { t: 'P1000KG' }); cell(3, 3, 4, 4, { t: c.adj, bold: true, size: S(0.7) });
    cell(0, 0, 4, 4, { t: c.msaDep, color: C.red, size: S(0.58) }); cell(1, 1, 4, 4, { t: c.msaArr, color: C.red, size: S(0.58) });
    cell(0, 0, 5, 5, { t: 'RED BOX', fill: C.red, color: C.white, size: S(0.6) }); cell(0, 0, 6, 6, { fill: C.red });
    cell(1, 1, 5, 6, { t: c.std, bold: true, size: S(1.05) });
    cell(2, 2, 5, 6, { t: c.time, size: S(0.9), fill: C.blue });
    cell(3, 3, 5, 6, { t: c.sta, bold: true, size: S(1.05) });
    cell(0, 0, 7, 7, { t: 'FUEL' }); cell(1, 1, 7, 7, { t: 'BLOCK' }); cell(2, 2, 7, 7, { t: 'BURN' }); cell(3, 3, 7, 7, { t: 'EST PAX' });
    cell(0, 0, 8, 8, {}); cell(1, 1, 8, 8, { t: c.blockT, color: C.txtGrey, size: S(0.6) }); cell(2, 2, 8, 8, { t: c.burnT, color: C.txtGrey, size: S(0.6) });
    cell(3, 3, 8, 8, { t: c.pax, bold: true, size: S(0.7) });
    // alternates + FL
    cell(4, 4, 3, 3, { t: 'ALT FUEL', fill: C.pink });
    const altCell = (r0, a) => {
      const b = cell(4, 4, r0, r0 + 1, { fill: C.pink });
      if (!a) return;
      d.text(a.icao, b.x, b.y, b.w * 0.48, b.h, { size: S(0.72) });
      d.text(a.fuel === null ? '?' : String(a.fuel), b.x + b.w * 0.44, b.y, b.w * 0.56, b.h, { size: S(0.86), bold: true });
    };
    altCell(4, c.alt1); altCell(6, c.alt2);
    const fb = cell(4, 4, 8, 8, {});
    d.text('FL', fb.x, fb.y, fb.w * 0.3, fb.h, { size: S(0.55), color: C.txtGrey });
    d.text(c.fl, fb.x + fb.w * 0.25, fb.y, fb.w * 0.75, fb.h, { size: S(0.72), bold: true });
    // engine out, RMORA
    const eb = cell(0, 4, 9, 11, {});
    d.para(c.eo, eb.x, eb.y, eb.w, eb.h, { size: S(0.62) });
    cell(0, 0, 12, 12, { t: 'RMORA', bold: true });
    cell(1, 2, 12, 12, { t: c.rmora, bold: true, color: C.red, align: 'left' });
    cell(3, 4, 12, 12, { t: 'CTOT:', bold: true, align: 'left' });
    // writing boxes
    cell(0, 2, 13, 17, { t: 'D.ATIS', valign: 'top', size: S(0.6) }); cell(3, 4, 13, 17, { t: 'D.CLR', valign: 'top', size: S(0.6) });
    cell(0, 2, 18, 22, { t: 'A.ATIS', valign: 'top', size: S(0.6) }); cell(3, 4, 18, 22, { t: 'A.CLR', valign: 'top', size: S(0.6) });
    // aircraft block
    const ac = c.ac || { items: [], cat: '', cert: '', mtow: '', mlw: '', mzfw: '' };
    const it = i => ac.items[i] || '';
    const sm = S(0.5);
    cell(0, 0, 23, 23, { t: 'W/C', align: 'left' }); cell(1, 2, 23, 23, { t: c.ac ? ac.cat : 'NO AIRCRAFT DATA', size: sm, color: c.ac ? C.black : C.warn }); cell(3, 4, 23, 23, { t: ac.cert, size: sm });
    cell(0, 0, 24, 24, { t: 'MAAS', align: 'left' }); cell(1, 2, 24, 24, { t: it(13), size: sm }); cell(3, 4, 24, 24, { t: ac.mtow, size: sm });
    cell(0, 0, 25, 25, { t: 'I', align: 'left' }); cell(1, 2, 25, 25, { t: it(12), size: sm }); cell(3, 3, 25, 25, { t: ac.mlw, size: sm }); cell(4, 4, 25, 25, { t: ac.mzfw, size: sm });
    const wt = (r, v, lab, i, j) => {
      cell(0, 0, r, r, { t: (typeof v === 'number' ? v : '?') + ' ' + lab, fill: C.green, align: 'left', size: S(0.6), pad: 1.5 });
      cell(1, 2, r, r, { t: it(i), size: sm }); cell(3, 4, r, r, { t: it(j), size: sm });
    };
    wt(26, c.zfw, 'ZFW', 11, 0); wt(27, c.tow, 'TOW', 10, 1); wt(28, c.lw, 'LW', 9, 2);
    cell(0, 0, 29, 31, { t: 'Parking Bay', valign: 'top', size: S(0.48) });
    [[29, 8, 3], [30, 7, 4], [31, 6, 5]].forEach(a => { cell(1, 2, a[0], a[0], { t: it(a[1]), size: sm }); cell(3, 4, a[0], a[0], { t: it(a[2]), size: sm }); });
    // side strip
    'ANCAAMtFORDEC'.split('').forEach((ch, i) => cell(5, 5, i, i, { t: ch, bold: true, size: S(0.6), pad: 0.5 }));
    for (let r = 13; r <= 28; r++) cell(5, 5, r, r, { fill: C.grey });
    cell(5, 5, 29, 31, {});
    // outer frame
    d.rect(X, Y, W, Hh, { lw: 1.1 });
    // footer (outside the card)
    if (footer) {
      const f = c.f, fs = Math.max(4.5, u * 0.42);
      const bits = [f.callsign, f.date, 'OFP log ' + f.log, f.comp ? 'comp ' + f.comp + 'Z' : '', f.ci ? 'CI ' + f.ci : '', f.wc ? 'W/C ' + f.wc : '',
        f.altnFl ? 'ALTN FL' + f.altnFl : '', f.noAltnSubtract !== null ? 'NO ALTN SUBTRACT ' + f.noAltnSubtract : '', f.tank ? 'TANK/EXTRA ' + f.tank : '', c.refRev ? 'ref data ' + c.refRev : ''].filter(Boolean).join('  \u00B7  ');
      d.text(bits, X, Y + Hh + 1, W, fs * 1.5, { size: fs, align: 'left', pad: 0, color: C.txtGrey });
      c.warnings.forEach((wn, i) => d.text('CHECK OFP: ' + wn, X, Y + Hh + 1 + fs * 1.4 * (i + 1), W, fs * 1.5, { size: fs, align: 'left', pad: 0, color: C.warn, bold: true }));
    }
  }

  async function renderPdf(PDFLib, fontkit, fontBytes, cards, ref, opts) {
    opts = opts || {};
    const doc = await PDFLib.PDFDocument.create();
    doc.registerFontkit(fontkit);
    const fonts = { reg: await doc.embedFont(fontBytes.reg, { subset: false }), bold: await doc.embedFont(fontBytes.bold, { subset: false }) };
    const title = cards.length ? 'Flight cards ' + cards[0].f.date + ' ' + cards.map(c => c.f.callsign).join(' ') : 'Flight cards';
    doc.setTitle(title); doc.setCreator('Flight Card generator');
    const d0 = pg => makeDrawer(PDFLib, pg, fonts);
    // overview pages: 4 cards per A4 portrait, 2 x 2, for printing and folding
    const A4 = [595.28, 841.89], mx = 26, my = 24, gx = 36, gy = 40, foot = 16;
    const cw = (A4[0] - 2 * mx - gx) / 2, ch = (A4[1] - 2 * my - gy) / 2 - foot;
    for (let p = 0; p < Math.max(1, Math.ceil(cards.length / 4)); p++) {
      const pg = doc.addPage(A4);
      cards.slice(p * 4, p * 4 + 4).forEach((c, i) => {
        const col = i % 2, rw = Math.floor(i / 2);
        drawCard(PDFLib, pg, fonts, c, mx + col * (cw + gx), my + rw * (ch + foot + gy), cw, ch, true);
      });
      d0(pg).text('Transcription aid only - the OFP is authoritative', mx, A4[1] - 14, A4[0] - 2 * mx, 8, { size: 5, color: C.txtGrey });
    }
    // one page per sector for handwriting
    const P = [530, 841.89], m = 14, f2 = 26;
    cards.forEach(c => {
      const pg = doc.addPage(P);
      drawCard(PDFLib, pg, fonts, c, m, m, P[0] - 2 * m, P[1] - 2 * m - f2, true);
    });
    return await doc.save();
  }

  return { linesFromTextContent, parseOfp, buildCards, renderPdf, sortKey };
});
