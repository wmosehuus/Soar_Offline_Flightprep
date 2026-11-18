/* Flight Cards page logic. Parsing and PDF layout live in core.js. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const LS_KEY = 'flightcards.refdata.v1';
  const state = { defaults: null, ref: null, fonts: null, db: null, downloads: null, cards: [], pdf: null, filename: '', refSource: '' };

  // ---------- helpers ----------
  const clone = o => JSON.parse(JSON.stringify(o));
  const today = () => { const d = new Date(); return String(d.getDate()).padStart(2, '0') + ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()] + String(d.getFullYear()).slice(2); };
  function show(el, text, kind) { el.hidden = !text; el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : ''); }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function validRef(r) { return r && typeof r === 'object' && r.aircraft && r.airfields && r.routes; }

  // ---------- views ----------
  function route() {
    const ref = location.hash === '#reference';
    $('view-cards').hidden = ref; $('view-reference').hidden = !ref;
    $('tab-cards').setAttribute('aria-current', ref ? 'false' : 'page');
    $('tab-reference').setAttribute('aria-current', ref ? 'page' : 'false');
  }
  window.addEventListener('hashchange', route); route();

  // ---------- reference data: load / save ----------
  function refStatus() {
    const n = Object.keys(state.ref.aircraft).length, a = Object.keys(state.ref.airfields).length;
    $('ref-status').textContent = n + ' aircraft, ' + a + ' airfields. ' + state.refSource;
    if ($('noref')) $('noref').hidden = n > 0;
  }
  async function saveRef(what) {
    state.ref.revised = today();
    let local = false, cloud = false;
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.ref)); local = true; } catch (e) { /* storage may be unavailable */ }
    if (state.db) {
      try { await state.db.doc('ref/data').set({ data: clone(state.ref), savedAt: new Date().toISOString() }); cloud = true; } catch (e) { cloud = false; }
    }
    state.refSource = cloud ? 'Saved to this page, available on all your devices.' : local ? 'Saved on this device only.' : 'Not saved: storage is unavailable. Export a backup.';
    refStatus();
    show($('ref-msg'), what + ' ' + state.refSource, cloud || local ? 'ok' : 'warn');
    fillSelects();
    if (state.cards.length) await rebuild();
  }
  async function loadRef() {
    const empty = { revised: '', aircraft: {}, airfields: {}, routes: {} };
    try { const r = await fetch('refdata.json'); state.defaults = r.ok ? await r.json() : empty; } catch (e) { state.defaults = empty; }
    if (!validRef(state.defaults)) state.defaults = empty;
    state.ref = clone(state.defaults); state.refSource = Object.keys(state.ref.aircraft).length ? 'Using the built-in data.' : 'No reference data yet.';
    try { const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (validRef(s)) { state.ref = s; state.refSource = 'Using data saved on this device.'; } } catch (e) { /* ignore */ }
    refStatus(); fillSelects();
    if (window.claude && window.claude.use) {
      window.claude.use('downloads').then(d => { state.downloads = d; }).catch(() => { });
      try {
        const db = await window.claude.use('db');
        if (db) {
          state.db = db;
          const snap = await Promise.race([db.doc('ref/data').get(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))]);
          const body = snap.exists ? snap.data() : null;
          if (body && validRef(body.data)) { state.ref = clone(body.data); state.refSource = 'Using your saved data.'; refStatus(); fillSelects(); if (state.cards.length) await rebuild(); }
        }
      } catch (e) { /* keep what we have */ }
    }
  }

  // ---------- reference data: editors ----------
  function opts(sel, keys, newLabel) {
    const cur = sel.value;
    sel.innerHTML = keys.map(k => '<option value="' + esc(k) + '">' + esc(k) + '</option>').join('') + '<option value="">' + newLabel + '</option>';
    sel.value = keys.includes(cur) ? cur : (keys[0] || '');
  }
  function fillSelects() {
    opts($('ac-select'), Object.keys(state.ref.aircraft).sort(), 'New aircraft');
    opts($('af-select'), Object.keys(state.ref.airfields).sort(), 'New airfield');
    opts($('rt-select'), Object.keys(state.ref.routes).sort(), 'New route');
    loadAc(); loadAf(); loadRt();
  }
  function loadAc() {
    const k = $('ac-select').value, a = state.ref.aircraft[k] || { items: [] };
    $('ac-reg').value = k; $('ac-reg').disabled = !!k;
    $('ac-cat').value = a.cat || ''; $('ac-cert').value = a.cert || '';
    $('ac-mtow').value = a.mtow || ''; $('ac-mlw').value = a.mlw || ''; $('ac-mzfw').value = a.mzfw || '';
    $('ac-items').value = (a.items || []).join('\n');
    $('ac-rev').textContent = k ? 'Last revised: ' + (a.rev || 'V8.1') : '';
    $('ac-del').disabled = !k; armed($('ac-del'), false);
  }
  function loadAf() {
    const k = $('af-select').value, a = state.ref.airfields[k] || {};
    $('af-iata').value = k; $('af-iata').disabled = !!k;
    $('af-icao').value = a.icao || ''; $('af-msa').value = a.msa || ''; $('af-eo').value = (a.eo || []).join('\n');
    $('af-rev').textContent = k ? 'Last revised: ' + (a.rev || 'V8.1') : '';
    $('af-del').disabled = !k; armed($('af-del'), false);
  }
  function loadRt() {
    const k = $('rt-select').value, p = k.split('-');
    $('rt-from').value = p[0] || ''; $('rt-to').value = p[1] || '';
    $('rt-from').disabled = $('rt-to').disabled = !!k;
    $('rt-val').value = k ? state.ref.routes[k] : '';
    $('rt-del').disabled = !k; armed($('rt-del'), false);
  }
  $('ac-select').addEventListener('change', loadAc);
  $('af-select').addEventListener('change', loadAf);
  $('rt-select').addEventListener('change', loadRt);

  // two-step confirmation for destructive buttons (the page cannot open a browser dialog)
  function armed(btn, on) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.dataset.armed = on ? '1' : '';
    btn.textContent = on ? 'Tap again to confirm' : btn.dataset.label;
  }
  function confirmClick(btn, fn) {
    btn.addEventListener('click', () => {
      if (btn.dataset.armed === '1') { armed(btn, false); fn(); }
      else { armed(btn, true); setTimeout(() => armed(btn, false), 5000); }
    });
  }
  const lines = v => v.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const numOrText = v => { const t = v.trim(); return /^\d+$/.test(t) ? parseInt(t, 10) : t; };

  $('ac-save').addEventListener('click', () => {
    const reg = $('ac-reg').value.trim().toUpperCase().replace(/^ZS-?/, '');
    if (!/^[A-Z]{3}$/.test(reg)) return show($('ref-msg'), 'Enter the registration as its last three letters, for example ZWX.', 'warn');
    const items = lines($('ac-items').value);
    if (items.length > 14) return show($('ref-msg'), 'The card has room for 14 difference items. You entered ' + items.length + '.', 'warn');
    state.ref.aircraft[reg] = { mtow: numOrText($('ac-mtow').value), mlw: numOrText($('ac-mlw').value), mzfw: numOrText($('ac-mzfw').value), items, cat: $('ac-cat').value.trim(), cert: $('ac-cert').value.trim(), rev: today() };
    $('ac-select').innerHTML = '<option value="' + reg + '" selected>' + reg + '</option>';
    saveRef('ZS-' + reg + ' saved.');
  });
  confirmClick($('ac-del'), () => { const k = $('ac-select').value; delete state.ref.aircraft[k]; saveRef('ZS-' + k + ' deleted.'); });

  $('af-save').addEventListener('click', () => {
    const iata = $('af-iata').value.trim().toUpperCase(), icao = $('af-icao').value.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(iata) || !/^[A-Z]{4}$/.test(icao)) return show($('ref-msg'), 'Enter a three-letter IATA code and a four-letter ICAO code.', 'warn');
    state.ref.airfields[iata] = { icao, msa: $('af-msa').value.trim(), eo: lines($('af-eo').value), rev: today() };
    $('af-select').innerHTML = '<option value="' + iata + '" selected>' + iata + '</option>';
    saveRef(iata + ' saved.');
  });
  confirmClick($('af-del'), () => { const k = $('af-select').value; delete state.ref.airfields[k]; saveRef(k + ' deleted.'); });

  $('rt-save').addEventListener('click', () => {
    const a = $('rt-from').value.trim().toUpperCase(), b = $('rt-to').value.trim().toUpperCase(), v = $('rt-val').value.trim();
    if (!/^[A-Z]{3}$/.test(a) || !/^[A-Z]{3}$/.test(b) || !v) return show($('ref-msg'), 'Enter both IATA codes and a MORA value.', 'warn');
    state.ref.routes[a + '-' + b] = v;
    $('rt-select').innerHTML = '<option value="' + a + '-' + b + '" selected>' + a + '-' + b + '</option>';
    saveRef(a + '-' + b + ' saved.');
  });
  confirmClick($('rt-del'), () => { const k = $('rt-select').value; delete state.ref.routes[k]; saveRef(k + ' deleted.'); });

  $('ref-export').addEventListener('click', () => saveFile('Soar_Flightprep_reference_' + today() + '.json', JSON.stringify(state.ref, null, 1), $('ref-msg')));
  $('ref-import').addEventListener('change', async ev => {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    try {
      const r = JSON.parse(await f.text());
      if (!validRef(r)) throw new Error('bad');
      state.ref = r; await saveRef('Reference data imported.');
    } catch (e) { show($('ref-msg'), 'That file is not a Flight Cards reference export. Nothing was changed.', 'warn'); }
  });
  confirmClick($('ref-reset'), () => { state.ref = clone(state.defaults); saveRef('Reference data reset.'); });

  // ---------- saving files ----------
  async function saveFile(filename, data, msgEl) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    if (state.downloads) {
      try { await state.downloads.save({ filename, data: blob }); show(msgEl, filename + ' handed to your device to save or share.', 'ok'); return; }
      catch (e) {
        if (e && e.code === 'declined') return show(msgEl, 'Save cancelled.', '');
        if (e && e.code === 'rate_limited') return show(msgEl, 'A save prompt is already open. Answer it, then try again.', 'warn');
      }
    }
    try {
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      if (!state.downloads && window.claude) show(msgEl, 'Saving is not available in this view. Open the page in the Claude app or on claude.ai and try again.', 'warn');
    } catch (e) { show(msgEl, 'This view cannot save files. Open the page in the Claude app or on claude.ai.', 'warn'); }
  }

  // ---------- OFP reading ----------
  async function readPdf(file) {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    let all = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      all = all.concat(FlightCard.linesFromTextContent(await page.getTextContent()));
    }
    return FlightCard.parseOfp(all);
  }
  async function handleFiles(files) {
    files = Array.from(files).filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) return show($('status'), 'Choose a PDF file from CrewBriefing.', 'warn');
    show($('status'), 'Reading ' + files.length + (files.length === 1 ? ' file' : ' files') + '.', '');
    let flights = [], failed = [];
    for (const f of files) {
      try { const fl = await readPdf(f); if (fl.length) flights = flights.concat(fl); else failed.push(f.name); }
      catch (e) { failed.push(f.name); }
    }
    if (!flights.length) { $('result').hidden = true; return show($('status'), 'No operational flight plan was found in ' + failed.join(', ') + '. Check that it is a CrewBriefing OFP or Flight Group PDF.', 'warn'); }
    state.flights = flights;
    await rebuild();
    show($('status'), failed.length ? 'No flight plan found in: ' + failed.join(', ') + '. The other files were read.' : '', failed.length ? 'warn' : '');
    $('howto').hidden = true;
  }
  async function rebuild() {
    state.cards = FlightCard.buildCards(state.flights, state.ref);
    renderTable();
    const bytes = await FlightCard.renderPdf(PDFLib, fontkit, state.fonts, state.cards, state.ref);
    state.pdf = bytes;
    const f0 = state.cards[0].f;
    state.filename = 'FlightCards_' + (f0.date || 'undated') + '_' + state.cards.map(c => c.f.callsign).join('-') + '.pdf';
    $('save-note').textContent = state.filename + '. Page 1 is the print-and-fold sheet, followed by ' + state.cards.length + (state.cards.length === 1 ? ' page' : ' pages') + ' for GoodNotes.';
    $('result').hidden = false;
    preview(bytes).catch(() => { $('preview').hidden = true; });
  }
  function renderTable() {
    const head = ['Flight', 'Reg', 'Route', 'STD', 'STA', 'Time', 'FL', 'Pax', 'P1000KG', 'Block', 'Burn', 'ALT 1', 'ALT 2', 'Check'];
    const alt = a => a ? a.icao + ' ' + (a.fuel === null ? '?' : a.fuel) : '';
    let h = '<thead><tr>' + head.map((t, i) => '<th' + (i >= 6 && i <= 10 ? ' class="n"' : '') + '>' + t + '</th>').join('') + '</tr></thead><tbody>';
    const warns = [];
    state.cards.forEach(c => {
      const ok = !c.warnings.length;
      c.warnings.forEach(w => warns.push(c.f.callsign + ': ' + w));
      h += '<tr>' + [c.f.callsign, c.reg, c.dep + '-' + c.arr, c.std, c.sta, c.time].map(v => '<td>' + esc(v) + '</td>').join('') +
        [c.fl, c.pax, c.adj, c.f.block, c.f.trip].map(v => '<td class="n">' + esc(v) + '</td>').join('') +
        '<td>' + esc(alt(c.alt1)) + '</td><td>' + esc(alt(c.alt2)) + '</td><td><span class="pill ' + (ok ? 'ok">Read OK' : 'warn">Check OFP') + '</span></td></tr>';
    });
    $('sectors').innerHTML = h + '</tbody>';
    const date = state.cards[0].f.date || '';
    $('result-title').textContent = state.cards.length + (state.cards.length === 1 ? ' sector' : ' sectors') + (date ? ', ' + date : '');
    $('warnings').innerHTML = warns.map(w => '<div class="msg warn">' + esc(w) + '</div>').join('');
  }
  async function preview(bytes) {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    const page = await doc.getPage(1), vp = page.getViewport({ scale: 1.5 }), cv = $('preview');
    cv.width = vp.width; cv.height = vp.height; cv.hidden = false;
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  }

  $('file').addEventListener('change', ev => { const fs = ev.target.files; handleFiles(fs).finally(() => { ev.target.value = ''; }); });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
  $('save-pdf').addEventListener('click', () => { if (state.pdf) saveFile(state.filename, new Blob([state.pdf], { type: 'application/pdf' }), $('status')); });
  function pdfFile() { return new File([state.pdf], state.filename, { type: 'application/pdf' }); }
  function shareReady() { try { return !window.claude && !!navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 'a.pdf', { type: 'application/pdf' })] }); } catch (e) { return false; } }
  if ($('share-pdf')) {
    $('share-pdf').hidden = !shareReady();
    $('share-pdf').addEventListener('click', async () => {
      if (!state.pdf) return;
      try { await navigator.share({ files: [pdfFile()], title: state.filename }); }
      catch (e) { if (!e || e.name !== 'AbortError') show($('status'), 'Sharing did not work here. Use Save flight cards PDF instead.', 'warn'); }
    });
  }
  $('clear').addEventListener('click', () => { state.flights = []; state.cards = []; state.pdf = null; $('result').hidden = true; $('howto').hidden = false; show($('status'), '', ''); });

  // ---------- start ----------
  (async function init() {
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
      const [r, b] = await Promise.all([fetch('fonts/Carlito-Regular.ttf').then(x => x.arrayBuffer()), fetch('fonts/Carlito-Bold.ttf').then(x => x.arrayBuffer())]);
      state.fonts = { reg: r, bold: b };
      await loadRef();
      if (!window.claude && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
    } catch (e) {
      show($('status'), 'The page did not load completely. Check your connection and reload.', 'warn');
    }
  })();
})();
