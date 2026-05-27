/**
 * printer-driver.js
 * ─────────────────────────────────────────────────────────────────────────
 * Isolated module that handles everything between a rendered <canvas> and a
 * generic BLE thermal printer:
 *
 *   1. Web Bluetooth: device discovery, GATT connect, characteristic lookup.
 *   2. Image processing: canvas RGBA → grayscale → 1-bit monochrome raster,
 *      packed MSB-first, byte-aligned per row (optional dithering).
 *   3. Protocol framing: wrap the raster in ESC/POS `GS v 0` raster command.
 *   4. BLE transport: slice the byte stream into MTU-safe chunks and write
 *      them to the GATT characteristic with pacing.
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

      // Listeners for connection-state changes (UI updates).
      this._stateListeners = [];
    }

    // ── Capability + state helpers ──────────────────────────────────────────

    static isSupported() {
      return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }

    onStateChange(fn) {
      this._stateListeners.push(fn);
    }

    _emitState() {
      const info = this.getStatus();
      this._stateListeners.forEach((fn) => {
        try { fn(info); } catch (e) { /* listener errors must not break us */ }
      });
    }

    getStatus() {
      return {
        connected: this.connected,
        deviceName: this.device ? (this.device.name || '(unnamed device)') : null,
        deviceId: this.device ? this.device.id : null,
        serviceUuid: this.service ? this.service.uuid : null,
        writeCharUuid: this.writeChar ? this.writeChar.uuid : null,
        notifyCharUuid: this.notifyChar ? this.notifyChar.uuid : null,
        profileName: this.profile ? this.profile.name : null,
        chunkSize: this.chunkSize,
        pacingMs: this.pacingMs
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

      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: OPTIONAL_SERVICES
      });

      // React to the printer dropping the link.
      this.device.addEventListener('gattserverdisconnected', () => {
        this.connected = false;
        this.server = null;
        this.service = null;
        this.writeChar = null;
        this.notifyChar = null;
        this._emitState();
      });

      this.server = await this.device.gatt.connect();
      await this._discoverProfile();

      this.connected = true;
      this._emitState();
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
          console.debug('[Printer] notify:', Array.from(bytes));
        });
      } catch (_) { /* notifications are best-effort */ }
    }

    async disconnect() {
      if (this.device && this.device.gatt && this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
      this.connected = false;
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

    setTuning({ threshold, dither, chunkSize, pacingMs }) {
      if (threshold != null) this.threshold = threshold;
      if (dither != null) this.dither = dither;
      if (chunkSize != null) this.chunkSize = chunkSize;
      if (pacingMs != null) this.pacingMs = pacingMs;
    }

    // ── Image processing: canvas → 1-bit monochrome raster ────────────────────

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

    // ── BLE transport ─────────────────────────────────────────────────────────

    /**
     * Slice a byte stream into MTU-safe chunks and write them to the GATT
     * write characteristic. Prefers writeWithoutResponse for throughput and
     * falls back to writeWithResponse, with a small pacing delay between
     * chunks to avoid overrunning the printer's tiny receive buffer.
     */
    async writeStream(stream, onProgress) {
      if (!this.connected || !this.writeChar) {
        throw new Error('Printer is not connected.');
      }

      const chunk = this.chunkSize || DEFAULT_CHUNK;
      const useNoResponse = this.writeChar.properties.writeWithoutResponse;

      for (let i = 0; i < stream.length; i += chunk) {
        const slice = stream.slice(i, i + chunk);
        if (useNoResponse) {
          await this.writeChar.writeValueWithoutResponse(slice);
        } else {
          await this.writeChar.writeValueWithResponse(slice);
        }
        if (onProgress) onProgress(Math.min(i + chunk, stream.length), stream.length);
        if (this.pacingMs > 0) await delay(this.pacingMs);
      }
    }

    /**
     * High-level convenience: render a canvas straight to the printer.
     * Returns the number of bytes transmitted.
     */
    async printCanvas(canvas, onProgress) {
      const raster = this.canvasToMonochrome(canvas);
      const stream = this.buildEscPosRaster(raster);
      await this.writeStream(stream, onProgress);
      return stream.length;
    }
  }

  global.PrinterDriver = PrinterDriver;
})(typeof window !== 'undefined' ? window : globalThis);
