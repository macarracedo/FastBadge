/**
 * printer-driver.js
 * ─────────────────────────────────────────────────────────────────────────
 * Isolated module that handles everything between a rendered <canvas> and a
 * generic BLE thermal printer:
 *
 *   1. Web Bluetooth: device discovery, GATT connect, characteristic lookup.
 *   2. Image processing: canvas RGBA → optional rotation → grayscale → 1-bit
 *      monochrome raster, packed MSB-first, byte-aligned per row (opt. dither).
 *   3. Protocol framing: wrap the raster in ESC/POS `GS v 0` raster command.
 *   4. BLE transport: a serialized print QUEUE slices each byte stream into
 *      MTU-safe chunks and writes them to the GATT characteristic with pacing,
 *      so consecutive print jobs never overlap GATT operations.
 *   5. Audit logging: every meaningful step emits a log entry (console + any
 *      registered listener) so the BLE flow can be traced.
 *
 * Exposed as a global `PrinterDriver` (no module bundler required).
 */

(function (global) {
  'use strict';

  // ── Known BLE profiles for common generic printers ───────────────────────
  // Many cheap Chinese thermal printers expose a Nordic-UART-like service or a
  // proprietary 0xFFxx service. We try a small set of well-known UUIDs. If your
  // printer differs, override via setProfile() from the Config tab.
  const KNOWN_PROFILES = [
    {
      name: 'Generic 0xFF00 (ESC/POS)',
      service: 0xff00,
      writeChar: 0xff02,
      notifyChar: 0xff01
    },
    {
      name: 'Nordic UART (NUS)',
      service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
      writeChar: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
      notifyChar: '6e400003-b5a3-f393-e0a9-e50e24dcca9e'
    },
    {
      name: 'Generic 0xAE00',
      service: 0xae00,
      writeChar: 0xae01,
      notifyChar: 0xae02
    },
    {
      name: 'Generic 0x18F0 (label printers)',
      service: 0x18f0,
      writeChar: 0x2af1,
      notifyChar: 0x2af0
    }
  ];

  // Optional services we ask the browser to grant access to even when using
  // acceptAllDevices (GATT won't expose a service unless it was listed here).
  const OPTIONAL_SERVICES = KNOWN_PROFILES.map((p) => p.service).concat([
    0x1800, // Generic Access
    0x1801, // Generic Attribute
    0x180a, // Device Information
    0x180f, // Battery Service
    0x1812  // HID (some printers)
  ]);

  const DEFAULT_THRESHOLD = 128; // luminance cutoff: below = ink (black dot)
  const DEFAULT_CHUNK = 20;      // safe payload when MTU is the BLE default (23-3)
  const DEFAULT_PACING_MS = 8;   // gap between chunks so the RX buffer drains

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  class PrinterDriver {
    constructor() {
      this.device = null;
      this.server = null;
      this.service = null;
      this.writeChar = null;
      this.notifyChar = null;
      this.profile = null;
      this.connected = false;

      this.threshold = DEFAULT_THRESHOLD;
      this.dither = false;
      this.chunkSize = DEFAULT_CHUNK;
      this.pacingMs = DEFAULT_PACING_MS;
      this.rotation = 0;            // 0 | 90 | 180 | 270 — applied before binarize
      this.writeMode = 'auto';      // 'auto' | 'withResponse' | 'noResponse'
      this.verboseLog = false;      // log every chunk (noisy)

      // Print queue — serializes jobs so GATT operations never overlap.
      this._queue = [];
      this._processing = false;
      this._jobSeq = 0;

      // Listeners.
      this._stateListeners = [];
      this._logListeners = [];
    }

    // ── Capability + state helpers ──────────────────────────────────────────

    static isSupported() {
      return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }

    onStateChange(fn) {
      this._stateListeners.push(fn);
    }

    onLog(fn) {
      this._logListeners.push(fn);
    }

    _emitState() {
      const info = this.getStatus();
      this._stateListeners.forEach((fn) => {
        try { fn(info); } catch (e) { /* listener errors must not break us */ }
      });
    }

    /** Emit an audit-log entry to the console and any registered listeners. */
    _log(level, message, data) {
      const entry = { t: Date.now(), level, message, data };
      const sink = console[level] || console.log;
      try { sink.call(console, '[Printer] ' + message, data != null ? data : ''); } catch (_) { /* ignore */ }
      this._logListeners.forEach((fn) => {
        try { fn(entry); } catch (e) { /* ignore */ }
      });
      return entry;
    }

    getStatus() {
      return {
        connected: this.connected,
        hasDevice: !!this.device,
        deviceName: this.device ? (this.device.name || '(unnamed device)') : null,
        deviceId: this.device ? this.device.id : null,
        serviceUuid: this.service ? this.service.uuid : null,
        writeCharUuid: this.writeChar ? this.writeChar.uuid : null,
        notifyCharUuid: this.notifyChar ? this.notifyChar.uuid : null,
        profileName: this.profile ? this.profile.name : null,
        chunkSize: this.chunkSize,
        pacingMs: this.pacingMs,
        rotation: this.rotation,
        queueLength: this._queue.length,
        processing: this._processing
      };
    }

    // ── Connection ───────────────────────────────────────────────────────────

    /**
     * Request a device from the browser chooser and connect its GATT server.
     * Uses acceptAllDevices so the user can pick any printer; the real service
     * is discovered afterwards by probing KNOWN_PROFILES.
     */
    async connect() {
      if (!PrinterDriver.isSupported()) {
        throw new Error('Web Bluetooth is not available. Use Chrome/Edge over http://localhost or https://.');
      }

      this._log('info', 'Requesting device from the browser chooser…');
      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: OPTIONAL_SERVICES
      });
      this._log('info', 'Device selected: ' + (this.device.name || '(unnamed)'));

      // React to the printer dropping the link. Remove any previous handler
      // first so reconnecting the same device doesn't stack listeners.
      if (this._onDisconnect) {
        this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);
      }
      this._onDisconnect = () => {
        this._log('warn', 'GATT server disconnected.');
        this.connected = false;
        this.server = null;
        this.service = null;
        this.writeChar = null;
        this.notifyChar = null;
        this._emitState();
      };
      this.device.addEventListener('gattserverdisconnected', this._onDisconnect);

      await this._openGatt();
      return this.getStatus();
    }

    /** (Re)open the GATT server on the already-selected device and discover. */
    async _openGatt() {
      this._log('info', 'Connecting GATT server…');
      this.server = await this.device.gatt.connect();
      await this._discoverProfile();
      this.connected = true;
      this._log('info', 'Connected. Profile: ' + (this.profile ? this.profile.name : '?'));
      this._emitState();
      // A reconnection may have left jobs waiting in the queue.
      this._processQueue();
    }

    /**
     * Fail-safe: tear the GATT link down and bring it back up on the SAME
     * device (no chooser). Clears stale characteristic state that can make a
     * printer ignore everything after the first job.
     */
    async resetConnection() {
      if (!this.device) {
        throw new Error('No device to reconnect — use "Connect printer" first.');
      }
      this._log('warn', 'Resetting connection…');
      try {
        if (this.device.gatt && this.device.gatt.connected) {
          this.device.gatt.disconnect();
        }
      } catch (e) {
        this._log('warn', 'Disconnect during reset threw: ' + e.message);
      }
      this.connected = false;
      this.service = null;
      this.writeChar = null;
      this.notifyChar = null;
      this._emitState();
      // Give the stack a moment to fully tear down before re-opening.
      await delay(400);
      await this._openGatt();
      this._log('info', 'Reset complete.');
      return this.getStatus();
    }

    /**
     * Probe the connected GATT server for one of the known profiles.
     * Falls back to scanning every service for any writable characteristic.
     */
    async _discoverProfile() {
      // 1. Try each known profile by its declared service/characteristic UUIDs.
      for (const profile of KNOWN_PROFILES) {
        try {
          const service = await this.server.getPrimaryService(profile.service);
          const writeChar = await service.getCharacteristic(profile.writeChar);
          this.service = service;
          this.writeChar = writeChar;
          this.profile = profile;
          // The notify characteristic is optional (status feedback).
          try {
            this.notifyChar = await service.getCharacteristic(profile.notifyChar);
            await this._subscribeNotifications();
          } catch (_) { this.notifyChar = null; }
          this._log('debug', 'Matched profile: ' + profile.name);
          return;
        } catch (_) {
          // Not this profile; keep probing.
        }
      }

      // 2. Generic fallback: enumerate all services, pick the first writable
      //    characteristic we find.
      const services = await this.server.getPrimaryServices();
      for (const service of services) {
        const chars = await service.getCharacteristics();
        const writable = chars.find(
          (c) => c.properties.write || c.properties.writeWithoutResponse
        );
        if (writable) {
          this.service = service;
          this.writeChar = writable;
          this.notifyChar = chars.find((c) => c.properties.notify) || null;
          this.profile = { name: `Auto-detected (${service.uuid})`, service: service.uuid };
          if (this.notifyChar) await this._subscribeNotifications();
          this._log('debug', 'Auto-detected writable characteristic on ' + service.uuid);
          return;
        }
      }

      throw new Error('No writable characteristic found on this device.');
    }

    async _subscribeNotifications() {
      try {
        await this.notifyChar.startNotifications();
        this.notifyChar.addEventListener('characteristicvaluechanged', (e) => {
          // Printer status bytes; surfaced for debugging.
          const bytes = new Uint8Array(e.target.value.buffer);
          this._log('debug', 'notify: ' + Array.from(bytes).join(','));
        });
      } catch (_) { /* notifications are best-effort */ }
    }

    async disconnect() {
      if (this.device && this.device.gatt && this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
      this.connected = false;
      this._log('info', 'Disconnected by user.');
      this._emitState();
    }

    /** Manually override the profile (Config tab advanced settings). */
    setProfile({ service, writeChar, notifyChar, name }) {
      KNOWN_PROFILES.unshift({
        name: name || 'User-defined',
        service,
        writeChar,
        notifyChar
      });
    }

    setTuning({ threshold, dither, chunkSize, pacingMs, rotation, writeMode, verboseLog }) {
      if (threshold != null) this.threshold = threshold;
      if (dither != null) this.dither = dither;
      if (chunkSize != null) this.chunkSize = chunkSize;
      if (pacingMs != null) this.pacingMs = pacingMs;
      if (rotation != null) this.rotation = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
      if (writeMode != null) this.writeMode = writeMode;
      if (verboseLog != null) this.verboseLog = verboseLog;
    }

    // ── Image processing: canvas → (rotate) → 1-bit monochrome raster ─────────

    /**
     * Return a canvas rotated by this.rotation degrees. 90/270 swap the
     * dimensions; 0 returns the source unchanged. Used to fix payload
     * orientation when the label feeds differently than the on-screen design.
     */
    _rotateCanvas(canvas) {
      const deg = this.rotation;
      if (!deg) return canvas;
      const swap = (deg === 90 || deg === 270);
      const out = document.createElement('canvas');
      out.width = swap ? canvas.height : canvas.width;
      out.height = swap ? canvas.width : canvas.height;
      const ctx = out.getContext('2d');
      // Paint white first so any uncovered area stays "no ink".
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.translate(out.width / 2, out.height / 2);
      ctx.rotate(deg * Math.PI / 180);
      ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
      return out;
    }

    /** Copy a canvas into a detached one so queued jobs are immune to later edits. */
    _snapshot(canvas) {
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      out.getContext('2d').drawImage(canvas, 0, 0);
      return out;
    }

    /**
     * Convert an HTMLCanvasElement to a packed monochrome raster bitmap.
     *
     * Returns { width, height, bytesPerRow, data } where `data` is a Uint8Array
     * of length bytesPerRow * height. Bit layout is MSB-first: the leftmost
     * pixel of a byte is bit 7. A set bit (1) means "print a dot" (black).
     */
    canvasToMonochrome(canvas) {
      const width = canvas.width;
      const height = canvas.height;
      const ctx = canvas.getContext('2d');
      const rgba = ctx.getImageData(0, 0, width, height).data;

      // Each row is byte-aligned: 8 dots per byte, rounded up.
      const bytesPerRow = Math.ceil(width / 8);
      const data = new Uint8Array(bytesPerRow * height);

      // Precompute a grayscale buffer (needed for dithering, harmless otherwise).
      const gray = new Float32Array(width * height);
      for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
        // Composite over white (transparent canvas areas must read as white).
        const alpha = a / 255;
        const rr = r * alpha + 255 * (1 - alpha);
        const gg = g * alpha + 255 * (1 - alpha);
        const bb = b * alpha + 255 * (1 - alpha);
        // ITU-R BT.601 perceptual luminance.
        gray[p] = 0.299 * rr + 0.587 * gg + 0.114 * bb;
      }

      if (this.dither) {
        this._floydSteinberg(gray, width, height);
      }

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const lum = gray[y * width + x];
          const ink = lum < this.threshold; // dark pixel → print
          if (ink) {
            // byteIndex within the row-major packed buffer.
            const byteIndex = y * bytesPerRow + (x >> 3); // x>>3 == floor(x/8)
            const bitOffset = 7 - (x & 7);                // MSB-first within byte
            data[byteIndex] |= (1 << bitOffset);
          }
        }
      }

      return { width, height, bytesPerRow, data };
    }

    /**
     * Floyd–Steinberg error diffusion (in place) on a grayscale buffer.
     * Produces a stippled 1-bit image that generic printers reproduce far
     * better than a hard threshold for photos/logos.
     */
    _floydSteinberg(gray, width, height) {
      const T = this.threshold;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          const old = gray[idx];
          const next = old < T ? 0 : 255;
          const err = old - next;
          gray[idx] = next;
          // Distribute the quantization error to neighbouring pixels.
          if (x + 1 < width) gray[idx + 1] += err * 7 / 16;
          if (y + 1 < height) {
            if (x > 0) gray[idx + width - 1] += err * 3 / 16;
            gray[idx + width] += err * 5 / 16;
            if (x + 1 < width) gray[idx + width + 1] += err * 1 / 16;
          }
        }
      }
    }

    // ── Protocol framing ──────────────────────────────────────────────────────

    /**
     * Wrap a packed raster in the ESC/POS `GS v 0` raster bit-image command.
     *
     *   GS  v  0  m  xL xH  yL yH  [data...]
     *   1D 76 30 00 xL xH  yL yH  ...
     *
     * xL/xH = bytesPerRow (little-endian 16-bit) ; yL/yH = height (LE 16-bit).
     * We also prepend ESC @ (initialize) and append a few line-feeds so the
     * label advances and tears off cleanly.
     */
    buildEscPosRaster(raster) {
      const { bytesPerRow, height, data } = raster;

      const init = [0x1b, 0x40]; // ESC @  → reset printer state
      const header = [
        0x1d, 0x76, 0x30, 0x00,        // GS v 0, mode 0 (normal)
        bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
        height & 0xff, (height >> 8) & 0xff
      ];
      const feed = [0x0a, 0x0a, 0x0a]; // advance label

      const out = new Uint8Array(init.length + header.length + data.length + feed.length);
      let off = 0;
      out.set(init, off); off += init.length;
      out.set(header, off); off += header.length;
      out.set(data, off); off += data.length;
      out.set(feed, off);
      return out;
    }

    // ── Print queue ───────────────────────────────────────────────────────────

    /**
     * High-level convenience: render a canvas straight to the printer. The job
     * is enqueued and processed serially, so consecutive calls never collide
     * on the GATT characteristic. Returns a promise resolving to bytes sent.
     */
    printCanvas(canvas, onProgress) {
      return this.enqueuePrint(canvas, onProgress);
    }

    /** Queue a print job. The canvas is snapshotted immediately. */
    enqueuePrint(canvas, onProgress) {
      const snapshot = this._snapshot(canvas);
      return new Promise((resolve, reject) => {
        const job = { id: ++this._jobSeq, canvas: snapshot, onProgress, resolve, reject };
        this._queue.push(job);
        this._log('info', `Job #${job.id} queued (queue length ${this._queue.length}).`);
        this._emitState();
        this._processQueue();
      });
    }

    /** Drain the queue one job at a time. Safe to call repeatedly. */
    async _processQueue() {
      if (this._processing) return;
      this._processing = true;
      this._emitState();

      while (this._queue.length) {
        // Don't pull a job while we have nothing to write to; wait for a
        // (re)connection to resume the queue instead of failing everything.
        if (!this.connected || !this.writeChar) {
          this._log('warn', 'Queue paused — printer not connected. ' +
            this._queue.length + ' job(s) waiting.');
          break;
        }

        const job = this._queue.shift();
        this._emitState();
        try {
          const t0 = now();
          this._log('info', `Job #${job.id} started (rotation ${this.rotation}°).`);
          const rotated = this._rotateCanvas(job.canvas);
          const raster = this.canvasToMonochrome(rotated);
          const stream = this.buildEscPosRaster(raster);
          this._log('info',
            `Job #${job.id}: ${raster.width}×${raster.height}px → ${stream.length} bytes.`);
          await this.writeStream(stream, job.onProgress, job.id);
          const ms = Math.round(now() - t0);
          this._log('info', `Job #${job.id} completed in ${ms} ms (${stream.length} bytes).`);
          job.resolve(stream.length);
        } catch (err) {
          this._log('error', `Job #${job.id} failed: ${err.message}`);
          job.reject(err);
        }

        // Settle gap between jobs so the printer's tiny buffer fully drains
        // before the next ESC @ reset — this is key to multi-print reliability.
        if (this._queue.length) await delay(Math.max(60, this.pacingMs));
      }

      this._processing = false;
      this._emitState();
    }

    // ── BLE transport ─────────────────────────────────────────────────────────

    /** Resolve the effective write method given writeMode + characteristic caps. */
    _useNoResponse() {
      const props = this.writeChar.properties;
      if (this.writeMode === 'withResponse') {
        return props.write ? false : true; // fall back if only no-response exists
      }
      if (this.writeMode === 'noResponse') {
        return props.writeWithoutResponse ? true : false;
      }
      // auto: prefer no-response for throughput, else with-response.
      return !!props.writeWithoutResponse;
    }

    /**
     * Slice a byte stream into MTU-safe chunks and write them to the GATT
     * write characteristic. Writes are awaited one at a time (so a single
     * job never overlaps GATT operations), with a small pacing delay between
     * chunks to avoid overrunning the printer's tiny receive buffer.
     */
    async writeStream(stream, onProgress, jobId) {
      if (!this.connected || !this.writeChar) {
        throw new Error('Printer is not connected.');
      }

      const chunk = this.chunkSize || DEFAULT_CHUNK;
      const useNoResponse = this._useNoResponse();
      const total = stream.length;
      const nChunks = Math.ceil(total / chunk);
      this._log('debug',
        `Job #${jobId}: writing ${nChunks} chunk(s) of ${chunk}B ` +
        `(mode=${useNoResponse ? 'withoutResponse' : 'withResponse'}, pacing=${this.pacingMs}ms).`);

      for (let i = 0, c = 0; i < total; i += chunk, c++) {
        const slice = stream.slice(i, i + chunk);
        try {
          if (useNoResponse) {
            await this.writeChar.writeValueWithoutResponse(slice);
          } else {
            await this.writeChar.writeValueWithResponse(slice);
          }
        } catch (err) {
          this._log('error', `Job #${jobId}: write failed at byte ${i}/${total}: ${err.message}`);
          throw err;
        }
        const sent = Math.min(i + chunk, total);
        if (this.verboseLog) {
          this._log('debug', `Job #${jobId}: chunk ${c + 1}/${nChunks} sent (${sent}/${total} B).`);
        }
        if (onProgress) onProgress(sent, total);
        if (this.pacingMs > 0) await delay(this.pacingMs);
      }
    }
  }

  global.PrinterDriver = PrinterDriver;
})(typeof window !== 'undefined' ? window : globalThis);
