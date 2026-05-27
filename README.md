# FastBadge

**Real-time event badge printing & check-in system** for staff working registration desks at conferences and events.

FastBadge scans an attendee's QR code, verifies and updates their status in Google Sheets, and instantly prints a personalized badge to a generic Chinese BLE thermal label printer (Marklife / Niimbot / Deluxe style) — all from a browser running on a tablet or phone, with no native app to install.

---

## 👤 Autor

**Manuel Alonso Carracedo**
- Email: manuel.alonso.carracedo@uvigo.gal
- ResearchGate: [Perfil](https://www.researchgate.net/profile/Manuel-Alonso-Carracedo)
- ORCID: [0009-0001-5037-5826](https://orcid.org/0009-0001-5037-5826)
 
---

## Table of contents

1. [Architecture overview](#architecture-overview)
2. [Why a backend is required](#why-a-backend-is-required)
3. [Project structure](#project-structure)
4. [Local installation](#local-installation)
5. [Google Sheets integration guide](#google-sheets-integration-guide)
6. [Using the application](#using-the-application)
7. [Badge template format](#badge-template-format)
8. [The BLE printing pipeline (math & binary)](#the-ble-printing-pipeline-math--binary)
9. [Browser & hardware compatibility](#browser--hardware-compatibility)
10. [Troubleshooting](#troubleshooting)

---

## Architecture overview

FastBadge is a **client-heavy** application. Almost all real work (canvas rendering, bitmap conversion, BLE transmission, QR scanning) happens in the browser using native Web APIs. The Node.js/Express backend is intentionally thin and exists for two reasons only:

- **Secure context provider** — `navigator.bluetooth` and `getUserMedia` (camera) are only exposed by browsers on a *secure context*: `https://` or `http://localhost`. Serving the front-end from a local Express server on `http://localhost:3000` satisfies this requirement without TLS certificates.
- **Google Sheets proxy** — API keys / service-account credentials must never ship to the browser. The backend holds the credentials and exposes a tiny REST surface (`/api/attendee/:id`, `/api/checkin`) that the front-end calls.

```
┌─────────────────────────────────────────────┐         ┌──────────────────────┐
│  Browser (tablet / phone @ http://localhost) │         │  Node.js + Express   │
│                                               │         │                      │
│  app.js ──── tab router / QR lifecycle        │  HTTP   │  server.js           │
│  printer-driver.js ─ Web Bluetooth + bitmap   │◄───────►│  /api/attendee/:id   │
│  <canvas> ─ badge rendering                   │  JSON   │  /api/checkin        │
│                                               │         │        │             │
└───────────────┬───────────────────────────────┘        └────────┼─────────────┘
                │ Web Bluetooth (GATT)                             │ googleapis
                ▼                                                  ▼
        BLE Thermal Printer                                 Google Sheets API
```

---

## Why a backend is required

| Concern | Solved by |
| --- | --- |
| Web Bluetooth needs a secure context | Express serves the app on `http://localhost` |
| Camera (`getUserMedia`) needs a secure context | same |
| Google credentials must stay secret | Express keeps them server-side, exposes a proxy |
| CORS / Google API quirks | normalized through the proxy |

If Google credentials are **not** configured, the server transparently falls back to an in-memory **mock dataset** so the whole app remains testable end-to-end (scanning, printing, status updates) without any cloud setup.

---

## Project structure

```
FastBadge/
├── package.json              # dependencies + npm scripts
├── server.js                 # Express: static hosting + Google Sheets proxy
├── .env.example              # environment variable template
├── README.md                 # this file
├── templates/
│   └── default-badge.json    # sample structured badge layout (mm + dpi metadata)
└── public/
    ├── index.html            # app shell, 3 tabs (Scanner / Designer / Config)
    ├── css/
    │   └── styles.css         # modern responsive UI
    └── js/
        ├── app.js             # router, QR scanner lifecycle, check-in flow
        └── printer-driver.js  # Web Bluetooth + canvas→monochrome + chunking
```

---

## Local installation

**Prerequisites:** Node.js ≥ 18, and a Chromium-based browser (Chrome / Edge) — Web Bluetooth is *not* available in Firefox or Safari.

```bash
# 1. Install dependencies
npm install

# 2. (Optional) configure Google Sheets — see next section.
cp .env.example .env
#   ...edit .env...   (skip to run against mock data)

# 3. Start the server
npm start
#   → FastBadge running at http://localhost:3000   (mock-data mode)

# 4. Open Chrome / Edge at:
http://localhost:3000
```

> **Tablet / phone usage:** Web Bluetooth requires a secure context. On a real device either (a) run the laptop server and reach it over `https://` behind a reverse proxy, or (b) for same-device testing use Chrome on Android with a USB-forwarded `localhost` (`chrome://inspect` → Port forwarding). Plain `http://<LAN-IP>` will **not** unlock Bluetooth.

---

## Google Sheets integration guide

The proxy supports **two** auth modes. Configure one in `.env` (copy from `.env.example`):

### Option A — API key (read-only, simplest)

Good for verifying attendees, but the public Sheets API key cannot *write* unless the sheet is public-editable (not recommended). Use Option B for real check-in writes.

```env
GOOGLE_SHEETS_ID=1AbC...your_spreadsheet_id...XyZ
GOOGLE_API_KEY=AIza...your_api_key...
SHEET_RANGE=Attendees!A:E
```

### Option B — Service account (read + write, recommended)

1. Create a Google Cloud project → enable the **Google Sheets API**.
2. Create a **Service Account**, generate a JSON key.
3. Share your spreadsheet with the service-account email (e.g. `fastbadge@project.iam.gserviceaccount.com`) as **Editor**.
4. Configure `.env`:

```env
GOOGLE_SHEETS_ID=1AbC...your_spreadsheet_id...XyZ
GOOGLE_SERVICE_ACCOUNT_EMAIL=fastbadge@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
SHEET_RANGE=Attendees!A:E
```

> Keep the `\n` escapes in `GOOGLE_PRIVATE_KEY`; the server converts them back to real newlines.

### Expected sheet columns

The first row is treated as a header. Default expected columns (configurable via `SHEET_RANGE`):

| id | name | company | role | status |
| --- | --- | --- | --- | --- |
| A-001 | Ada Lovelace | Analytical Engines | Speaker | Pending |
| A-002 | Alan Turing | Bletchley Ltd | Attendee | Pending |

The QR code printed for / carried by each attendee must encode the value in the **`id`** column.

---

## Using the application

### Config tab
- **Connect printer** — pairs a BLE printer via the browser chooser. Status panel shows device name, service & characteristic UUIDs, and live connection state.
- **Label size** — separate Width / Height inputs in **millimeters**. Changing either instantly resizes the design canvas using the configured DPI (default 203 DPI → 8 dots/mm).
- **Google Sheets** — shows the Spreadsheet ID and whether the backend is in *live* or *mock* mode.

### Designer tab
- Live `<canvas>` preview of the badge, rendered from the structured JSON template.
- Controls for margins, logo visibility, and global font scaling.
- **Test print** sends the current canvas straight to the printer.

### Scanner tab
- Starts the camera (`html5-qrcode`) and scans continuously.
- **Automated flow:** valid QR → extract id → `POST /api/checkin` → on success render badge → stream to printer — fully unattended. A cooldown prevents double-scanning the same id.

---

## Badge template format

`templates/default-badge.json` describes a label declaratively. Mandatory metadata lets the UI auto-adapt on load:

```jsonc
{
  "name": "Default Conference Badge",
  "width_mm": 50,        // physical label width
  "height_mm": 30,       // physical label height
  "dpi": 203,            // printer resolution → pixels = mm / 25.4 * dpi
  "margin_mm": 2,
  "logo": { "visible": true, "x_mm": 2, "y_mm": 2, "w_mm": 10, "h_mm": 10 },
  "elements": [
    {
      "type": "text",
      "binding": "{{name}}",   // placeholder resolved from attendee record
      "x_mm": 2, "y_mm": 14,
      "font_size_pt": 14,
      "font_weight": "bold",
      "align": "left"
    }
  ]
}
```

Supported placeholders: `{{id}}`, `{{name}}`, `{{company}}`, `{{role}}`. Coordinates and sizes are authored in **millimeters / points** and converted to device pixels at render time, so the same template prints identically on any DPI.

---

## The BLE printing pipeline (math & binary)

This is the core reverse-engineering work. Turning a visual canvas into bytes a generic thermal printer accepts happens in four stages, all in `printer-driver.js`.

### 1. Millimeters → dots (pixels)

Thermal printers address the head in **dots**. At 203 DPI:

```
dots_per_mm = DPI / 25.4 = 203 / 25.4 ≈ 8 dots/mm
width_px  = round(width_mm  * dots_per_mm)
height_px = round(height_mm * dots_per_mm)
```

The print head has a fixed dot count per row, and **each row must be byte-aligned** (8 dots = 1 byte). So the byte width is:

```
bytes_per_row = ceil(width_px / 8)
```

We round `width_px` up to a multiple of 8 to avoid partial bytes at the row edge.

### 2. Canvas → grayscale → 1-bit monochrome

We read the canvas pixels with `ctx.getImageData()`, giving an `RGBA` array (4 bytes/pixel). For each pixel:

```
luminance = 0.299*R + 0.587*G + 0.114*B      // perceptual gray
ink       = luminance < THRESHOLD            // dark pixel = print a dot
```

A simple fixed threshold (default 128) is used; the code also supports optional **Floyd–Steinberg dithering** to render photos/logos as stippled dots, which generic printers reproduce far better than flat gray.

### 3. Packing bits into a bitmap (MSB-first)

Thermal printers expect **1 bit per pixel, 8 pixels per byte, most-significant-bit = leftmost pixel**. For pixel at `(x, y)`:

```
byteIndex = y * bytes_per_row + (x >> 3)      // x >> 3 == floor(x / 8)
bitOffset = 7 - (x & 7)                        // MSB-first within the byte
if (ink) buffer[byteIndex] |= (1 << bitOffset)
```

The result is a contiguous `Uint8Array` of `bytes_per_row * height_px` bytes — the raster bitmap.

### 4. Command framing + MTU chunking

Generic ESC/POS-style raster printing uses the **`GS v 0`** command to send a raster bitmap:

```
GS  v  0  m  xL xH  yL yH  [bitmap bytes...]
1D 76 30 00 xL xH  yL yH  ...
```

where `xL xH` is `bytes_per_row` as little-endian 16-bit, and `yL yH` is `height_px` as little-endian 16-bit. (Niimbot-class printers use a different proprietary frame; the driver exposes a pluggable `protocol` so the framing can be swapped — `escpos` is the default and the best-documented.)

The full command stream is then **sliced into BLE-safe chunks**. A BLE characteristic write is bounded by the negotiated **ATT MTU** minus 3 bytes of ATT header. Many cheap printers only support the default MTU (23 → 20 usable bytes), so the driver chunks conservatively:

```
CHUNK = negotiatedMTU ? (negotiatedMTU - 3) : 20
for (let i = 0; i < stream.length; i += CHUNK) {
    await characteristic.writeValueWithoutResponse(stream.slice(i, i + CHUNK));
    await delay(pacingMs);   // small gap so the printer's RX buffer drains
}
```

We prefer `writeValueWithoutResponse` (write command) for throughput, falling back to `writeValueWithResponse` if the characteristic doesn't support it. A short inter-chunk delay prevents overrunning the printer's tiny receive buffer (a very common failure mode that manifests as truncated or garbled labels).

---

## Browser & hardware compatibility

| | Web Bluetooth | Camera |
| --- | --- | --- |
| Chrome (desktop, Android) | ✅ | ✅ |
| Edge (desktop) | ✅ | ✅ |
| Firefox | ❌ | ✅ |
| Safari / iOS | ❌ | ✅ |

Because iOS/Safari lack Web Bluetooth, use **Android Chrome** or a desktop Chromium browser for the printing workflow. The check-in/scan flow alone works anywhere.

The default GATT service/characteristic UUIDs target common generic printers; if your printer differs, set its UUIDs in the Config tab (or `printer-driver.js` `KNOWN_PROFILES`). When in doubt, connect with `acceptAllDevices` and inspect the discovered services in the status panel.

---

## Troubleshooting

- **"Bluetooth not available"** — you're not on a secure context. Use `http://localhost` or `https://`, and a Chromium browser.
- **Printer connects but prints nothing / garbage** — wrong service UUID or protocol. Try the alternate profile, lower the MTU chunk, or increase inter-chunk pacing in Config.
- **Camera won't start** — grant camera permission; only one app can hold the camera at a time.
- **Sheets writes fail** — you're likely in API-key mode (read-only). Switch to a service account and share the sheet with it.
- **Label is shifted / cropped** — verify `width_mm`/`height_mm`/`dpi` match the physical media; the head dot-width is fixed per model.

---

## License

MIT — provided as a reference implementation for event tooling and BLE printer reverse-engineering education.
