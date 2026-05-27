/**
 * app.js — FastBadge main application logic.
 *
 * Responsibilities:
 *   - Lightweight hash-based tab router (Scanner / Designer / Config).
 *   - Badge template loading + canvas rendering (mm/pt → device pixels).
 *   - Real-time label resizing from the Config inputs.
 *   - QR scanner lifecycle (html5-qrcode) + the unattended check-in flow.
 *   - Wiring the PrinterDriver (from printer-driver.js) into the UI.
 */

(function () {
  'use strict';

  const MM_PER_INCH = 25.4;

  // ── Application state ──────────────────────────────────────────────────────
  const state = {
    template: null,          // parsed badge template JSON
    sample: null,            // current sample attendee for preview
    marginMm: 2,
    fontScale: 1,
    showLogo: true,
    dither: false,
    backend: null,           // /api/status payload
    scanning: false,
    qr: null,                // Html5Qrcode instance
    lastScan: { id: null, at: 0 },
    autoPrint: true
  };

  const printer = new PrinterDriver();

  // A few sample attendees so the Designer is useful without scanning.
  const SAMPLES = [
    { id: 'A-001', name: 'Ada Lovelace', company: 'Analytical Engines', role: 'Speaker' },
    { id: 'A-003', name: 'Grace Hopper', company: 'US Navy', role: 'Keynote' },
    { id: 'A-007', name: 'Bill', company: 'A Really Long Company Name LLC', role: 'Attendee' }
  ];

  // ── Small DOM helpers ──────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' toast-' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 1. Tab router
  // ════════════════════════════════════════════════════════════════════════
  function routeTo(tab) {
    const valid = ['scanner', 'designer', 'config'];
    if (!valid.includes(tab)) tab = 'scanner';

    $$('.view').forEach((v) => { v.hidden = v.dataset.view !== tab; });
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));

    // Stop the camera when leaving the scanner to release the device.
    if (tab !== 'scanner' && state.scanning) stopScanner();

    // Re-render the canvas when entering the designer (size may have changed).
    if (tab === 'designer') renderBadge();
  }

  function initRouter() {
    window.addEventListener('hashchange', () => routeTo(location.hash.slice(1)));
    routeTo(location.hash.slice(1) || 'scanner');
  }

  // ════════════════════════════════════════════════════════════════════════
  // 2. Template + canvas rendering
  // ════════════════════════════════════════════════════════════════════════

  /** Convert millimeters to device pixels at the template's DPI. */
  function mmToPx(mm) {
    const dpi = state.template ? state.template.dpi : 203;
    return (mm / MM_PER_INCH) * dpi;
  }

  /** Convert points (1pt = 1/72 inch) to device pixels at the template DPI. */
  function ptToPx(pt) {
    const dpi = state.template ? state.template.dpi : 203;
    return (pt / 72) * dpi * state.fontScale;
  }

  /** Resolve {{placeholders}} in a binding string against a data record. */
  function resolveBinding(binding, data) {
    return String(binding).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
      (data && data[key] != null) ? data[key] : ''
    );
  }

  /** Size the canvas to the template's physical dimensions (byte-aligned width). */
  function sizeCanvas() {
    const canvas = $('#badgeCanvas');
    const t = state.template;
    let widthPx = Math.round(mmToPx(t.width_mm));
    const heightPx = Math.round(mmToPx(t.height_mm));
    // Round the width up to a multiple of 8 so each raster row is byte-aligned
    // (the printer head addresses dots in groups of 8 → 1 byte).
    widthPx = Math.ceil(widthPx / 8) * 8;

    canvas.width = widthPx;
    canvas.height = heightPx;

    // Display the canvas at a comfortable on-screen scale while keeping the
    // backing store at true device resolution.
    const cssScale = Math.min(3, Math.max(1, 380 / widthPx));
    canvas.style.width = (widthPx * cssScale) + 'px';
    canvas.style.height = (heightPx * cssScale) + 'px';

    const meta = `${t.width_mm}×${t.height_mm} mm @ ${t.dpi} DPI → ${widthPx}×${heightPx} px`;
    if ($('#canvasMeta')) $('#canvasMeta').textContent = meta;
    if ($('#pxMeta')) $('#pxMeta').textContent = `${widthPx} × ${heightPx} px (width byte-aligned)`;
  }

  /** Draw the badge for the current sample data onto the canvas. */
  function renderBadge() {
    if (!state.template) return;
    sizeCanvas();

    const canvas = $('#badgeCanvas');
    const ctx = canvas.getContext('2d');
    const t = state.template;
    const data = state.sample || SAMPLES[0];

    // White background (thermal media is white; un-inked = white).
    ctx.fillStyle = t.background || '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const margin = mmToPx(state.marginMm);

    // Optional logo: a simple rounded square placeholder with initials.
    if (state.showLogo && t.logo && t.logo.visible) {
      const lx = mmToPx(t.logo.x_mm) + margin - mmToPx(t.margin_mm || 0);
      const ly = mmToPx(t.logo.y_mm) + margin - mmToPx(t.margin_mm || 0);
      const lw = mmToPx(t.logo.w_mm);
      const lh = mmToPx(t.logo.h_mm);
      ctx.fillStyle = '#000';
      roundRect(ctx, lx, ly, lw, lh, lw * 0.18);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${lh * 0.5}px ${t.logo.font || 'Arial, sans-serif'}`;
      ctx.fillText(t.logo.text || 'FB', lx + lw / 2, ly + lh / 2);
    }

    // Text elements.
    ctx.fillStyle = '#000';
    (t.elements || []).forEach((el) => {
      if (el.type !== 'text') return;
      const text = resolveBinding(el.binding, data);
      if (!text) return;

      const x = mmToPx(el.x_mm) + (margin - mmToPx(t.margin_mm || 0));
      const y = mmToPx(el.y_mm) + (margin - mmToPx(t.margin_mm || 0));
      const size = ptToPx(el.font_size_pt || 10);

      ctx.fillStyle = el.color || '#000';
      ctx.textAlign = el.align || 'left';
      ctx.textBaseline = 'top';
      ctx.font = `${el.font_weight || 'normal'} ${size}px ${el.font_family || 'Arial, sans-serif'}`;

      // Clamp text to the printable width so long values don't overflow the label.
      const maxWidth = canvas.width - margin - mmToPx(2);
      fitText(ctx, text, x, y, maxWidth);
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Draw text, shrinking the font if it would exceed maxWidth. */
  function fitText(ctx, text, x, y, maxWidth) {
    let metrics = ctx.measureText(text);
    if (metrics.width > maxWidth) {
      // Re-parse the current font size and scale it down to fit.
      const match = ctx.font.match(/(\d+(?:\.\d+)?)px/);
      if (match) {
        const orig = parseFloat(match[1]);
        const scaled = Math.max(6, orig * (maxWidth / metrics.width));
        ctx.font = ctx.font.replace(/(\d+(?:\.\d+)?)px/, scaled + 'px');
      }
    }
    ctx.fillText(text, x, y);
  }

  // ── Template loading ───────────────────────────────────────────────────────
  async function loadTemplate(fromServer) {
    try {
      if (fromServer !== false) {
        const res = await fetch('/templates/default-badge.json');
        state.template = await res.json();
      }
      applyTemplateToUi();
      renderBadge();
    } catch (err) {
      toast('Failed to load template: ' + err.message, 'err');
    }
  }

  /** Push template metadata into the Config/Designer inputs. */
  function applyTemplateToUi() {
    const t = state.template;
    $('#widthMm').value = t.width_mm;
    $('#heightMm').value = t.height_mm;
    $('#dpi').value = t.dpi;
    $('#dpiLabel').textContent = t.dpi;
    state.marginMm = t.margin_mm != null ? t.margin_mm : 2;
    $('#marginRange').value = state.marginMm;
    $('#marginOut').textContent = state.marginMm;
    $('#fontScaleRange').value = state.fontScale;
    $('#fontScaleOut').textContent = state.fontScale.toFixed(2);
    $('#templateJson').value = JSON.stringify(t, null, 2);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 3. Real-time label resizing (Config inputs)
  // ════════════════════════════════════════════════════════════════════════
  function bindDimensionInputs() {
    const apply = () => {
      if (!state.template) return;
      state.template.width_mm = clampNum($('#widthMm').value, 10, 200, state.template.width_mm);
      state.template.height_mm = clampNum($('#heightMm').value, 10, 200, state.template.height_mm);
      state.template.dpi = clampNum($('#dpi').value, 100, 600, state.template.dpi);
      $('#dpiLabel').textContent = state.template.dpi;
      renderBadge();
    };
    ['#widthMm', '#heightMm', '#dpi'].forEach((sel) => $(sel).addEventListener('input', apply));
  }

  function clampNum(v, min, max, fallback) {
    const n = parseFloat(v);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // ════════════════════════════════════════════════════════════════════════
  // 4. Designer controls
  // ════════════════════════════════════════════════════════════════════════
  function bindDesignerControls() {
    const sel = $('#sampleSelect');
    SAMPLES.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${s.name} — ${s.role}`;
      sel.appendChild(opt);
    });
    state.sample = SAMPLES[0];
    sel.addEventListener('change', () => {
      state.sample = SAMPLES[parseInt(sel.value, 10)] || SAMPLES[0];
      renderBadge();
    });

    $('#marginRange').addEventListener('input', (e) => {
      state.marginMm = parseFloat(e.target.value);
      $('#marginOut').textContent = state.marginMm;
      renderBadge();
    });
    $('#fontScaleRange').addEventListener('input', (e) => {
      state.fontScale = parseFloat(e.target.value);
      $('#fontScaleOut').textContent = state.fontScale.toFixed(2);
      renderBadge();
    });
    $('#logoToggle').addEventListener('change', (e) => {
      state.showLogo = e.target.checked;
      renderBadge();
    });
    $('#ditherToggle').addEventListener('change', (e) => {
      state.dither = e.target.checked;
      printer.setTuning({ dither: state.dither });
    });

    $('#btnReloadTemplate').addEventListener('click', () => loadTemplate(true));
    $('#btnApplyJson').addEventListener('click', () => {
      try {
        state.template = JSON.parse($('#templateJson').value);
        applyTemplateToUi();
        renderBadge();
        toast('Template applied.', 'ok');
      } catch (err) {
        toast('Invalid JSON: ' + err.message, 'err');
      }
    });

    $('#btnTestPrint').addEventListener('click', () => printCurrentBadge());
  }

  // ════════════════════════════════════════════════════════════════════════
  // 5. Printing
  // ════════════════════════════════════════════════════════════════════════
  async function printCurrentBadge() {
    if (!printer.connected) {
      toast('Connect a printer first (Config tab).', 'warn');
      return;
    }
    const canvas = $('#badgeCanvas');
    const progress = $('#printProgress');
    const bar = progress.querySelector('.progress-bar span');
    const label = progress.querySelector('.progress-label');
    progress.hidden = false;

    try {
      const bytes = await printer.printCanvas(canvas, (sent, total) => {
        const pct = Math.round((sent / total) * 100);
        bar.style.width = pct + '%';
        label.textContent = `${sent}/${total} B`;
      });
      toast(`Printed (${bytes} bytes sent).`, 'ok');
    } catch (err) {
      toast('Print failed: ' + err.message, 'err');
    } finally {
      setTimeout(() => { progress.hidden = true; bar.style.width = '0'; }, 800);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 6. Printer connection (Config tab) + status panel
  // ════════════════════════════════════════════════════════════════════════
  function bindPrinterUi() {
    if (!PrinterDriver.isSupported()) {
      $('#bleUnsupported').hidden = false;
      $('#btnConnect').disabled = true;
    }

    $('#btnConnect').addEventListener('click', async () => {
      try {
        applyTuning();
        toast('Select your printer in the chooser…');
        await printer.connect();
        toast('Printer connected.', 'ok');
      } catch (err) {
        toast('Connection failed: ' + err.message, 'err');
      }
    });

    $('#btnDisconnect').addEventListener('click', () => printer.disconnect());

    ['#chunkSize', '#pacingMs', '#threshold'].forEach((sel) =>
      $(sel).addEventListener('change', applyTuning)
    );

    printer.onStateChange(updatePrinterStatus);
    updatePrinterStatus(printer.getStatus());
  }

  function applyTuning() {
    printer.setTuning({
      chunkSize: clampNum($('#chunkSize').value, 8, 512, 20),
      pacingMs: clampNum($('#pacingMs').value, 0, 200, 8),
      threshold: clampNum($('#threshold').value, 1, 254, 128),
      dither: state.dither
    });
  }

  function updatePrinterStatus(s) {
    $('#stState').textContent = s.connected ? 'Connected' : 'Disconnected';
    $('#stName').textContent = s.deviceName || '—';
    $('#stProfile').textContent = s.profileName || '—';
    $('#stService').textContent = s.serviceUuid || '—';
    $('#stWrite').textContent = s.writeCharUuid || '—';
    $('#stNotify').textContent = s.notifyCharUuid || '—';

    $('#btnDisconnect').disabled = !s.connected;
    $('#btnConnect').disabled = s.connected || !PrinterDriver.isSupported();

    const pill = $('#printerPill');
    pill.classList.toggle('pill-on', s.connected);
    pill.classList.toggle('pill-off', !s.connected);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 7. Backend status (Google Sheets)
  // ════════════════════════════════════════════════════════════════════════
  async function loadBackendStatus() {
    try {
      const res = await fetch('/api/status');
      const json = await res.json();
      state.backend = json.sheets;
      const s = json.sheets;
      $('#cfgMode').textContent = s.mode === 'live' ? 'LIVE (Google Sheets)' : 'MOCK (in-memory)';
      $('#cfgSheetId').textContent = s.spreadsheetId || '— (not set)';
      $('#cfgRange').textContent = s.range || '—';
      $('#cfgWrite').textContent = s.canWrite ? 'Yes' : 'No (read-only)';

      const pill = $('#sheetsPill');
      pill.classList.toggle('pill-on', true); // backend reachable
      pill.classList.toggle('pill-off', false);
    } catch (err) {
      $('#sheetsPill').classList.add('pill-off');
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 8. QR scanner + unattended check-in flow
  // ════════════════════════════════════════════════════════════════════════
  function bindScanner() {
    $('#btnScanStart').addEventListener('click', startScanner);
    $('#btnScanStop').addEventListener('click', stopScanner);
    $('#autoPrintToggle').addEventListener('change', (e) => {
      state.autoPrint = e.target.checked;
    });
  }

  async function startScanner() {
    if (state.scanning) return;
    if (typeof Html5Qrcode === 'undefined') {
      toast('QR library failed to load (check your connection).', 'err');
      return;
    }
    try {
      state.qr = new Html5Qrcode('qrReader');
      await state.qr.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        onScanSuccess,
        () => { /* per-frame decode errors are normal; ignore */ }
      );
      state.scanning = true;
      $('#btnScanStart').disabled = true;
      $('#btnScanStop').disabled = false;
      setScanResult('Scanning… present a QR code.', '');
    } catch (err) {
      toast('Camera error: ' + err.message, 'err');
    }
  }

  async function stopScanner() {
    if (!state.scanning || !state.qr) return;
    try {
      await state.qr.stop();
      await state.qr.clear();
    } catch (_) { /* ignore */ }
    state.scanning = false;
    state.qr = null;
    $('#btnScanStart').disabled = false;
    $('#btnScanStop').disabled = true;
  }

  function setScanResult(msg, kind) {
    const el = $('#scanResult');
    el.textContent = msg;
    el.className = 'scan-result' + (kind ? ' ' + kind : '');
  }

  /**
   * Called by html5-qrcode on every successful decode. Implements the
   * unattended flow with a debounce so the same code isn't processed twice
   * while it's still in view.
   */
  async function onScanSuccess(decodedText) {
    const id = extractId(decodedText);
    const now = Date.now();

    // Debounce: ignore the same id within a 4s cooldown window.
    if (id === state.lastScan.id && now - state.lastScan.at < 4000) return;
    state.lastScan = { id, at: now };

    setScanResult(`Verifying ${id}…`, '');

    try {
      const res = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const json = await res.json();

      if (!res.ok || !json.ok) {
        setScanResult(`✗ ${id}: ${json.error || 'check-in failed'}`, 'err');
        logCheckin({ id, name: id }, 'error');
        return;
      }

      const a = json.attendee;
      if (json.alreadyCheckedIn) {
        setScanResult(`⚠ ${a.name} was already checked in.`, 'warn');
        logCheckin(a, 'skip');
        return; // do not reprint duplicates
      }

      setScanResult(`✓ ${a.name} checked in.`, 'ok');

      // Auto-print the badge for the freshly checked-in attendee.
      if (state.autoPrint && printer.connected) {
        state.sample = a;
        renderBadge();
        try {
          await printer.printCanvas($('#badgeCanvas'));
          logCheckin(a, 'printed');
        } catch (err) {
          setScanResult(`✓ ${a.name} checked in, but print failed: ${err.message}`, 'warn');
          logCheckin(a, 'noprint');
        }
      } else {
        logCheckin(a, printer.connected ? 'noprint' : 'noprinter');
      }
    } catch (err) {
      setScanResult('Network error: ' + err.message, 'err');
    }
  }

  /** Extract an attendee id from the raw QR payload (plain id, URL, or JSON). */
  function extractId(text) {
    const raw = String(text).trim();
    // JSON payload with an id field.
    try {
      const obj = JSON.parse(raw);
      if (obj && (obj.id || obj.attendeeId)) return String(obj.id || obj.attendeeId);
    } catch (_) { /* not JSON */ }
    // URL with ?id= query param.
    try {
      const u = new URL(raw);
      const qp = u.searchParams.get('id');
      if (qp) return qp;
    } catch (_) { /* not a URL */ }
    return raw;
  }

  function logCheckin(attendee, outcome) {
    const ul = $('#checkinLog');
    const li = document.createElement('li');
    const time = new Date().toLocaleTimeString();
    const badgeMap = {
      printed: '<span class="badge-ok">badge printed</span>',
      skip: '<span class="badge-skip">duplicate</span>',
      noprint: '<span class="badge-skip">print failed</span>',
      noprinter: '<span class="badge-skip">no printer</span>',
      error: '<span class="badge-skip">error</span>'
    };
    li.innerHTML =
      `<span class="who">${escapeHtml(attendee.name || attendee.id)}</span>` +
      `<span>${badgeMap[outcome] || ''}</span>` +
      `<span class="when">${time}</span>`;
    ul.prepend(li);
    while (ul.children.length > 25) ul.removeChild(ul.lastChild);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ════════════════════════════════════════════════════════════════════════
  // Bootstrap
  // ════════════════════════════════════════════════════════════════════════
  function init() {
    initRouter();
    bindDimensionInputs();
    bindDesignerControls();
    bindPrinterUi();
    bindScanner();
    loadTemplate(true);
    loadBackendStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
