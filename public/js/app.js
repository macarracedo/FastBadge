/**
 * app.js — FastBadge main application logic.
 *
 * Responsibilities:
 *   - Lightweight hash-based tab router (Scanner / Designer / Templates / Config).
 *   - Badge template loading + canvas rendering (mm/pt → device pixels).
 *   - Template store (built-in default + user templates saved in localStorage).
 *   - Real-time label resizing from preset dropdown / custom inputs.
 *   - QR scanner lifecycle (html5-qrcode) + the unattended check-in flow.
 *   - Wiring the PrinterDriver (from printer-driver.js) into the UI.
 */

(function () {
  'use strict';

  const MM_PER_INCH = 25.4;
  const TEMPLATES_KEY = 'fastbadge.templates';
  const CUSTOM = '__custom__';

  // ── Application state ──────────────────────────────────────────────────────
  const state = {
    template: null,          // parsed badge template JSON (active in Designer)
    templateName: null,      // name of the active template (or CUSTOM)
    sample: null,            // current sample attendee for preview
    marginMm: 2,
    fontScale: 1,
    showLogo: true,
    dither: false,
    threshold: 128,          // mono cutoff — lives in the Designer now
    rotation: 0,             // pre-print payload rotation (0/90/180/270)
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

  // Preconfigured label sizes (mm). "Otro" lets the user type custom dimensions.
  const LABEL_PRESETS = [
    { label: '40 × 12 mm', w: 40, h: 12 },
    { label: '40 × 30 mm', w: 40, h: 30 },
    { label: '50 × 30 mm', w: 50, h: 30 },
    { label: '57 × 32 mm', w: 57, h: 32 },
    { label: '60 × 40 mm', w: 60, h: 40 },
    { label: '80 × 50 mm', w: 80, h: 50 }
  ];

  // Printer hardware presets — selecting one auto-tunes the BLE transfer.
  const PRINTER_MODELS = [
    { label: 'Generic ESC/POS (safe default)', chunk: 20, pacing: 8 },
    { label: 'Nordic UART (NUS)', chunk: 20, pacing: 5 },
    { label: 'Label printer / negotiated MTU (fast)', chunk: 180, pacing: 0 },
    { label: 'Slow / unstable link', chunk: 16, pacing: 20 },
    { label: 'Custom / manual', chunk: null, pacing: null }
  ];

  // Starter layout offered by "New blank" in the Templates view.
  const STARTER_TEMPLATE = {
    name: 'New Badge',
    description: 'Starter template — edit the fields below.',
    width_mm: 50, height_mm: 30, dpi: 203, margin_mm: 2,
    background: '#ffffff',
    logo: { visible: true, x_mm: 2, y_mm: 2, w_mm: 9, h_mm: 9, text: 'FB' },
    elements: [
      { type: 'text', id: 'name', binding: '{{name}}', x_mm: 2, y_mm: 13, font_family: 'Arial, sans-serif', font_size_pt: 15, font_weight: 'bold', align: 'left', color: '#000000' },
      { type: 'text', id: 'company', binding: '{{company}}', x_mm: 2, y_mm: 19, font_family: 'Arial, sans-serif', font_size_pt: 10, font_weight: 'normal', align: 'left', color: '#000000' },
      { type: 'text', id: 'role', binding: '{{role}}', x_mm: 2, y_mm: 24, font_family: 'Arial, sans-serif', font_size_pt: 9, font_weight: 'normal', align: 'left', color: '#000000' },
      { type: 'text', id: 'badge_id', binding: '{{id}}', x_mm: 48, y_mm: 2, font_family: 'Arial, sans-serif', font_size_pt: 8, font_weight: 'normal', align: 'right', color: '#000000' }
    ]
  };

  // ── Small DOM helpers ──────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function addOption(sel, value, label) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  }

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
  // 0. Template store (built-in default + user templates in localStorage)
  // ════════════════════════════════════════════════════════════════════════
  const templateStore = {
    _builtin: null,

    _read() {
      try {
        const raw = JSON.parse(localStorage.getItem(TEMPLATES_KEY));
        return Array.isArray(raw) ? raw : [];
      } catch (_) { return []; }
    },
    _write(list) {
      localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list));
    },

    /** All templates: the built-in first, then user-saved ones. */
    list() {
      const out = [];
      if (this._builtin) {
        out.push({ name: this._builtin.name || 'Default', data: this._builtin, builtin: true });
      }
      this._read().forEach((t) => out.push({ name: t.name, data: t.data, builtin: false }));
      return out;
    },
    get(name) {
      return this.list().find((t) => t.name === name) || null;
    },
    save(name, data) {
      const user = this._read();
      const i = user.findIndex((t) => t.name === name);
      if (i >= 0) user[i] = { name, data };
      else user.push({ name, data });
      this._write(user);
    },
    remove(name) {
      this._write(this._read().filter((t) => t.name !== name));
    }
  };

  // ════════════════════════════════════════════════════════════════════════
  // 1. Tab router
  // ════════════════════════════════════════════════════════════════════════
  function routeTo(tab) {
    const valid = ['scanner', 'designer', 'templates', 'config'];
    if (!valid.includes(tab)) tab = 'scanner';

    $$('.view').forEach((v) => { v.hidden = v.dataset.view !== tab; });
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));

    // Stop the camera when leaving the scanner to release the device.
    if (tab !== 'scanner' && state.scanning) stopScanner();

    // Re-render the canvas when entering the designer (size may have changed).
    if (tab === 'designer') renderBadge();
    // Refresh template lists when opening the manager.
    if (tab === 'templates') refreshTemplateDropdowns();
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

  // ── Template loading + selection ─────────────────────────────────────────
  async function loadTemplate() {
    try {
      const res = await fetch('/templates/default-badge.json');
      templateStore._builtin = await res.json();
    } catch (err) {
      toast('Failed to load built-in template: ' + err.message, 'err');
      templateStore._builtin = JSON.parse(JSON.stringify(STARTER_TEMPLATE));
      templateStore._builtin.name = 'Default Conference Badge';
    }
    refreshTemplateDropdowns();
    selectTemplate(templateStore._builtin.name);
    initTemplateEditor();
  }

  /** Make a template the active one in the Designer and render it. */
  function selectTemplate(name) {
    const entry = templateStore.get(name);
    if (!entry) return;
    state.template = JSON.parse(JSON.stringify(entry.data));
    state.templateName = name;
    applyTemplateToUi();
    renderBadge();
    const sel = $('#templateSelect');
    if (sel) sel.value = name;
    const wrap = $('#customTemplateWrap');
    if (wrap) wrap.hidden = true;
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
    syncLabelPreset();
  }

  // ════════════════════════════════════════════════════════════════════════
  // 3. Label dimensions (preset dropdown + custom inputs)
  // ════════════════════════════════════════════════════════════════════════
  function bindLabelPreset() {
    const sel = $('#labelPreset');
    LABEL_PRESETS.forEach((p, i) => addOption(sel, String(i), p.label));
    addOption(sel, CUSTOM, 'Otro (personalizado)…');

    sel.addEventListener('change', () => {
      if (sel.value === CUSTOM) {
        $('#customDims').hidden = false;
        return;
      }
      const p = LABEL_PRESETS[parseInt(sel.value, 10)];
      if (!p || !state.template) return;
      $('#customDims').hidden = true;
      state.template.width_mm = p.w;
      state.template.height_mm = p.h;
      $('#widthMm').value = p.w;
      $('#heightMm').value = p.h;
      renderBadge();
    });
  }

  /** Reflect the active template's dimensions in the preset dropdown. */
  function syncLabelPreset() {
    const sel = $('#labelPreset');
    if (!sel || !state.template) return;
    const idx = LABEL_PRESETS.findIndex(
      (p) => p.w === state.template.width_mm && p.h === state.template.height_mm
    );
    if (idx >= 0) {
      sel.value = String(idx);
      $('#customDims').hidden = true;
    } else {
      sel.value = CUSTOM;
      $('#customDims').hidden = false;
    }
  }

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

    // Mono threshold now lives with the image adjustments (depends on contrast,
    // not on the BLE connection).
    $('#thresholdRange').value = state.threshold;
    $('#thresholdOut').textContent = state.threshold;
    $('#thresholdRange').addEventListener('input', (e) => {
      state.threshold = parseInt(e.target.value, 10);
      $('#thresholdOut').textContent = state.threshold;
      printer.setTuning({ threshold: state.threshold });
    });

    // Pre-print payload rotation (fixes orientation when the label feeds the
    // opposite way to the on-screen design). Applies only to the print stream.
    $('#rotation').value = String(state.rotation);
    $('#rotation').addEventListener('change', (e) => {
      state.rotation = parseInt(e.target.value, 10) || 0;
      printer.setTuning({ rotation: state.rotation });
    });

    // Template picker: pick a saved template, or "Otro" to edit raw JSON.
    $('#templateSelect').addEventListener('change', () => {
      const v = $('#templateSelect').value;
      if (v === CUSTOM) {
        $('#customTemplateWrap').hidden = false;
        $('#templateJson').value = JSON.stringify(state.template, null, 2);
        state.templateName = CUSTOM;
      } else {
        selectTemplate(v);
      }
    });

    $('#btnReloadTemplate').addEventListener('click', () => loadTemplate());

    $('#btnApplyJson').addEventListener('click', () => {
      try {
        state.template = JSON.parse($('#templateJson').value);
        state.templateName = CUSTOM;
        applyTemplateToUi();
        renderBadge();
        const tsel = $('#templateSelect');
        if (tsel) tsel.value = CUSTOM;
        $('#customTemplateWrap').hidden = false;
        toast('Template applied.', 'ok');
      } catch (err) {
        toast('Invalid JSON: ' + err.message, 'err');
      }
    });

    $('#btnTestPrint').addEventListener('click', () => printCurrentBadge());
  }

  // ════════════════════════════════════════════════════════════════════════
  // 4b. Template manager view
  // ════════════════════════════════════════════════════════════════════════
  function refreshTemplateDropdowns() {
    const list = templateStore.list();

    const desig = $('#templateSelect');
    if (desig) {
      const prev = state.templateName;
      desig.innerHTML = '';
      list.forEach((t) => addOption(desig, t.name, t.name + (t.builtin ? ' (built-in)' : '')));
      addOption(desig, CUSTOM, 'Otro (custom JSON)…');
      if (prev && (prev === CUSTOM || templateStore.get(prev))) desig.value = prev;
    }

    const mgr = $('#tplManagerSelect');
    if (mgr) {
      const prev = mgr.value;
      mgr.innerHTML = '';
      list.forEach((t) => addOption(mgr, t.name, t.name + (t.builtin ? ' (built-in)' : '')));
      if (prev && templateStore.get(prev)) mgr.value = prev;
    }
  }

  function loadIntoTemplateEditor(name) {
    const entry = templateStore.get(name);
    if (!entry) return;
    // Built-in is read-only: clear the name so a save creates a copy.
    $('#tplName').value = entry.builtin ? '' : entry.name;
    $('#tplEditor').value = JSON.stringify(entry.data, null, 2);
  }

  function initTemplateEditor() {
    const sel = $('#tplManagerSelect');
    if (sel && sel.value) loadIntoTemplateEditor(sel.value);
  }

  function bindTemplateManager() {
    const sel = $('#tplManagerSelect');

    sel.addEventListener('change', () => loadIntoTemplateEditor(sel.value));

    $('#btnTplNew').addEventListener('click', () => {
      $('#tplName').value = '';
      $('#tplEditor').value = JSON.stringify(STARTER_TEMPLATE, null, 2);
      toast('Blank template ready — give it a name and save.', 'ok');
    });

    $('#btnTplSave').addEventListener('click', () => {
      const name = $('#tplName').value.trim();
      if (!name) { toast('Enter a template name first.', 'warn'); return; }
      let data;
      try {
        data = JSON.parse($('#tplEditor').value);
      } catch (err) {
        toast('Invalid JSON: ' + err.message, 'err');
        return;
      }
      if (templateStore._builtin && name === (templateStore._builtin.name || 'Default')) {
        toast('That name is reserved for the built-in template. Choose another.', 'warn');
        return;
      }
      templateStore.save(name, data);
      refreshTemplateDropdowns();
      sel.value = name;
      toast('Template saved.', 'ok');
    });

    $('#btnTplDelete').addEventListener('click', () => {
      const name = sel.value;
      const entry = templateStore.get(name);
      if (!entry) return;
      if (entry.builtin) { toast('The built-in template cannot be deleted.', 'warn'); return; }
      templateStore.remove(name);
      // If the deleted template was active in the Designer, fall back to built-in.
      if (state.templateName === name && templateStore._builtin) {
        selectTemplate(templateStore._builtin.name);
      }
      refreshTemplateDropdowns();
      loadIntoTemplateEditor(sel.value);
      toast('Template deleted.', 'ok');
    });

    $('#btnTplPreview').addEventListener('click', () => {
      const name = sel.value;
      if (!templateStore.get(name)) return;
      selectTemplate(name);
      location.hash = 'designer';
      toast('Loaded into Designer.', 'ok');
    });
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

    $('#btnReconnect').addEventListener('click', async () => {
      try {
        toast('Reconnecting…');
        await printer.resetConnection();
        toast('Printer reconnected.', 'ok');
      } catch (err) {
        toast('Reconnect failed: ' + err.message, 'err');
      }
    });

    ['#chunkSize', '#pacingMs', '#writeMode'].forEach((sel) =>
      $(sel).addEventListener('change', applyTuning)
    );

    $('#verboseLog').addEventListener('change', (e) =>
      printer.setTuning({ verboseLog: e.target.checked })
    );
    $('#btnClearLog').addEventListener('click', () => { $('#bleLog').textContent = ''; });

    // Stream the driver's audit log into the debug panel.
    printer.onLog(appendBleLog);

    printer.onStateChange(updatePrinterStatus);
    updatePrinterStatus(printer.getStatus());
  }

  function appendBleLog(entry) {
    const el = $('#bleLog');
    if (!el) return;
    const time = new Date(entry.t).toLocaleTimeString();
    el.textContent += `[${time}] ${entry.level.toUpperCase().padEnd(5)} ${entry.message}\n`;
    // Keep the buffer bounded so long sessions don't grow without limit.
    if (el.textContent.length > 20000) el.textContent = el.textContent.slice(-15000);
    el.scrollTop = el.scrollHeight;
  }

  /** Printer-model dropdown auto-tunes the BLE transfer parameters. */
  function bindPrinterModel() {
    const sel = $('#printerModel');
    PRINTER_MODELS.forEach((m, i) => addOption(sel, String(i), m.label));

    sel.addEventListener('change', () => {
      const m = PRINTER_MODELS[parseInt(sel.value, 10)];
      if (!m) return;
      if (m.chunk == null) {
        // Custom / manual → reveal the advanced panel for hand-tuning.
        $('#advTransmission').open = true;
        return;
      }
      $('#chunkSize').value = m.chunk;
      $('#pacingMs').value = m.pacing;
      applyTuning();
    });
  }

  function applyTuning() {
    printer.setTuning({
      chunkSize: clampNum($('#chunkSize').value, 8, 512, 20),
      pacingMs: clampNum($('#pacingMs').value, 0, 200, 8),
      threshold: state.threshold,
      dither: state.dither,
      rotation: state.rotation,
      writeMode: $('#writeMode') ? $('#writeMode').value : 'auto',
      verboseLog: $('#verboseLog') ? $('#verboseLog').checked : false
    });
  }

  function updatePrinterStatus(s) {
    let stateText = s.connected ? 'Connected' : 'Disconnected';
    if (s.queueLength) stateText += ` · ${s.queueLength} job(s) queued`;
    else if (s.processing) stateText += ' · printing…';
    $('#stState').textContent = stateText;
    $('#stName').textContent = s.deviceName || '—';
    $('#stProfile').textContent = s.profileName || '—';
    $('#stService').textContent = s.serviceUuid || '—';
    $('#stWrite').textContent = s.writeCharUuid || '—';
    $('#stNotify').textContent = s.notifyCharUuid || '—';

    $('#btnDisconnect').disabled = !s.connected;
    $('#btnConnect').disabled = s.connected || !PrinterDriver.isSupported();
    // Reconnect/reset stays available whenever a device has been chosen, even
    // after a drop — that's its whole point as a fail-safe.
    $('#btnReconnect').disabled = !s.hasDevice || !PrinterDriver.isSupported();

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
    bindLabelPreset();
    bindDesignerControls();
    bindPrinterUi();
    bindPrinterModel();
    bindTemplateManager();
    bindScanner();
    printer.setTuning({ threshold: state.threshold, rotation: state.rotation });
    loadTemplate();
    loadBackendStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
