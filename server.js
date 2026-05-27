/**
 * FastBadge backend.
 *
 * Two responsibilities, deliberately kept thin:
 *   1. Serve the static front-end on http://localhost so the browser grants a
 *      "secure context" (required by navigator.bluetooth and getUserMedia).
 *   2. Proxy/orchestrate access to the Google Sheets attendee table, keeping
 *      credentials server-side.
 *
 * If Google credentials are absent or invalid, the server transparently falls
 * back to an in-memory mock dataset so the app stays fully testable offline.
 */

'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');

// googleapis is optional at runtime: in pure mock mode we never touch it, and
// we don't want a missing install to crash local testing. Load defensively.
let google = null;
try {
  google = require('googleapis').google;
} catch (err) {
  console.warn('[FastBadge] googleapis not installed — running in mock mode only.');
}

const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.GOOGLE_SHEETS_ID || '';
const SHEET_RANGE = process.env.SHEET_RANGE || 'Attendees!A:E';

// ───────────────────────────────────────────────────────────────────────────
// Mock dataset — used whenever live Sheets access is not configured/available.
// ───────────────────────────────────────────────────────────────────────────
const MOCK_ATTENDEES = [
  { id: 'A-001', name: 'Ada Lovelace', company: 'Analytical Engines', role: 'Speaker', status: 'Pending' },
  { id: 'A-002', name: 'Alan Turing', company: 'Bletchley Ltd', role: 'Attendee', status: 'Pending' },
  { id: 'A-003', name: 'Grace Hopper', company: 'US Navy', role: 'Keynote', status: 'Pending' },
  { id: 'A-004', name: 'Margaret Hamilton', company: 'MIT', role: 'Attendee', status: 'Pending' },
  { id: 'A-005', name: 'Katherine Johnson', company: 'NASA', role: 'Attendee', status: 'Pending' }
];

/**
 * SheetsBackend abstracts away "live Google Sheets" vs "mock memory" so the
 * route handlers don't care which one is active.
 */
class SheetsBackend {
  constructor() {
    this.mode = 'mock';
    this.sheets = null;      // googleapis Sheets client (live mode)
    this.canWrite = false;   // API-key mode is read-only
    this.mock = MOCK_ATTENDEES.map((a) => ({ ...a }));
    this._headerOrder = ['id', 'name', 'company', 'role', 'status'];
  }

  /** Decide and initialize the active mode based on environment variables. */
  async init() {
    if (!google || !SHEET_ID) {
      this._logMode('No Google config detected');
      return;
    }

    try {
      if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
        // Service account → full read/write.
        const auth = new google.auth.JWT({
          email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          // .env stores newlines as literal "\n"; restore real newlines.
          key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        await auth.authorize();
        this.sheets = google.sheets({ version: 'v4', auth });
        this.mode = 'live';
        this.canWrite = true;
        this._logMode('Service account authenticated');
      } else if (process.env.GOOGLE_API_KEY) {
        // API key → read-only.
        this.sheets = google.sheets({ version: 'v4', auth: process.env.GOOGLE_API_KEY });
        this.mode = 'live';
        this.canWrite = false;
        this._logMode('API key (read-only)');
      } else {
        this._logMode('Sheet id set but no credentials');
      }
    } catch (err) {
      console.error('[FastBadge] Google auth failed, falling back to mock:', err.message);
      this.mode = 'mock';
      this.sheets = null;
    }
  }

  _logMode(reason) {
    if (this.mode === 'live') {
      console.log(`[FastBadge] Sheets mode: LIVE (${reason}, write=${this.canWrite}).`);
    } else {
      console.log(`[FastBadge] Sheets mode: MOCK (${reason}).`);
    }
  }

  status() {
    return {
      mode: this.mode,
      canWrite: this.mode === 'mock' ? true : this.canWrite,
      spreadsheetId: SHEET_ID || null,
      range: SHEET_RANGE
    };
  }

  /** Fetch and parse all rows into attendee objects keyed by header row. */
  async _fetchRows() {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_RANGE
    });
    const rows = res.data.values || [];
    if (rows.length === 0) return { header: [], records: [] };

    const header = rows[0].map((h) => String(h).trim().toLowerCase());
    const records = rows.slice(1).map((row, idx) => {
      const obj = { _row: idx + 2 }; // 1-based sheet row (header is row 1)
      header.forEach((key, col) => { obj[key] = row[col] !== undefined ? row[col] : ''; });
      return obj;
    });
    return { header, records };
  }

  /** Look up a single attendee by id. Returns the record or null. */
  async findAttendee(id) {
    const target = String(id).trim();
    if (this.mode === 'mock') {
      return this.mock.find((a) => a.id === target) || null;
    }
    const { records } = await this._fetchRows();
    return records.find((r) => String(r.id).trim() === target) || null;
  }

  /**
   * Mark an attendee as checked in (status = "Attended").
   * Returns { attendee, alreadyCheckedIn }.
   */
  async checkIn(id) {
    const target = String(id).trim();

    if (this.mode === 'mock') {
      const a = this.mock.find((x) => x.id === target);
      if (!a) return null;
      const already = a.status && a.status.toLowerCase() === 'attended';
      a.status = 'Attended';
      a.checkedInAt = new Date().toISOString();
      return { attendee: { ...a }, alreadyCheckedIn: already };
    }

    // Live mode: locate the row + the "status" column, then write.
    const { header, records } = await this._fetchRows();
    const rec = records.find((r) => String(r.id).trim() === target);
    if (!rec) return null;

    const already = rec.status && rec.status.toLowerCase() === 'attended';

    if (this.canWrite) {
      const statusCol = header.indexOf('status');
      if (statusCol >= 0) {
        const colLetter = String.fromCharCode(65 + statusCol); // A, B, C...
        const cell = `${SHEET_RANGE.split('!')[0]}!${colLetter}${rec._row}`;
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: cell,
          valueInputOption: 'RAW',
          requestBody: { values: [['Attended']] }
        });
      }
      rec.status = 'Attended';
    }

    return { attendee: rec, alreadyCheckedIn: already };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Express app
// ───────────────────────────────────────────────────────────────────────────
const app = express();
const backend = new SheetsBackend();

app.use(express.json());

// Serve the front-end (this is what makes http://localhost a secure context).
app.use(express.static(path.join(__dirname, 'public')));

// Expose templates so the front-end can load badge layouts.
app.use('/templates', express.static(path.join(__dirname, 'templates')));

/** Backend / Sheets status for the Config panel. */
app.get('/api/status', (req, res) => {
  res.json({ ok: true, sheets: backend.status() });
});

/** Verify an attendee without mutating anything (used by the Scanner preview). */
app.get('/api/attendee/:id', async (req, res) => {
  try {
    const attendee = await backend.findAttendee(req.params.id);
    if (!attendee) return res.status(404).json({ ok: false, error: 'Attendee not found' });
    res.json({ ok: true, attendee });
  } catch (err) {
    console.error('[FastBadge] /api/attendee error:', err.message);
    res.status(500).json({ ok: false, error: 'Lookup failed' });
  }
});

/** Verify + mark as attended. This is the unattended check-in entry point. */
app.post('/api/checkin', async (req, res) => {
  const id = (req.body && req.body.id) || '';
  if (!id) return res.status(400).json({ ok: false, error: 'Missing attendee id' });

  try {
    const result = await backend.checkIn(id);
    if (!result) return res.status(404).json({ ok: false, error: 'Attendee not found' });
    res.json({
      ok: true,
      attendee: result.attendee,
      alreadyCheckedIn: result.alreadyCheckedIn,
      mode: backend.status().mode
    });
  } catch (err) {
    console.error('[FastBadge] /api/checkin error:', err.message);
    res.status(500).json({ ok: false, error: 'Check-in failed' });
  }
});

backend.init().finally(() => {
  app.listen(PORT, () => {
    console.log(`\n  FastBadge running at http://localhost:${PORT}  (${backend.status().mode}-data mode)\n`);
  });
});
