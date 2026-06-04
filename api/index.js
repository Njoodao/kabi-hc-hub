const express = require('express');
const app = express();

app.use(express.json({ limit: '5mb' }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ─────────────────────────────────────────────────────────────────
// Storage layer (Vercel Blob if available, else in-memory)
// ─────────────────────────────────────────────────────────────────
let storage;
const hasBlob = !!process.env.BLOB_READ_WRITE_TOKEN;

if (hasBlob) {
  const blob = require('@vercel/blob');

  storage = {
    backend: 'blob',
    async getJSON(pathname) {
      try {
        const { blobs } = await blob.list({ prefix: pathname, limit: 5 });
        if (!blobs.length) return null;
        const match = blobs.find((b) => b.pathname === pathname) || blobs[0];
        const res = await fetch(match.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
      } catch (err) {
        console.error('[Blob] get error:', pathname, err);
        return null;
      }
    },
    async setJSON(pathname, value) {
      await blob.put(pathname, JSON.stringify(value), {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
        cacheControlMaxAge: 0
      });
    },
    async deleteByPathname(pathname) {
      try {
        const { blobs } = await blob.list({ prefix: pathname, limit: 5 });
        const match = blobs.find((b) => b.pathname === pathname);
        if (match) await blob.del(match.url);
      } catch (err) {
        console.error('[Blob] delete error:', pathname, err);
      }
    },
    async listPrefix(prefix) {
      try {
        const { blobs } = await blob.list({ prefix });
        // For each, return pathname + the parsed body
        const out = [];
        for (const b of blobs) {
          try {
            const res = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
            if (res.ok) out.push({ pathname: b.pathname, data: await res.json(), uploadedAt: b.uploadedAt });
          } catch (e) { /* skip */ }
        }
        return out;
      } catch (err) {
        console.error('[Blob] list error:', prefix, err);
        return [];
      }
    }
  };
} else {
  const mem = {};
  storage = {
    backend: 'memory',
    async getJSON(pathname)  { return mem[pathname] || null; },
    async setJSON(pathname, value) { mem[pathname] = value; },
    async deleteByPathname(pathname) { delete mem[pathname]; },
    async listPrefix(prefix) {
      return Object.keys(mem).filter((k) => k.startsWith(prefix))
        .map((k) => ({ pathname: k, data: mem[k], uploadedAt: new Date().toISOString() }));
    }
  };
}

const VALID_MODE = new Set(['weekly', 'monthly', 'quarterly']);
const sanitize  = (s) => String(s || '').slice(0, 100).replace(/[<>"']/g, '');
const cleanPeriod = (p) => String(p || '').replace(/[^A-Za-z0-9 _·.-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
const periodKey   = (p) => cleanPeriod(p).replace(/[\s·]+/g, '-');   // pathname-safe
const DRAFT_PATH   = (mode) => `kabi/reports/${mode}.json`;
const ARCHIVE_PATH = (mode, period) => `kabi/archive/${mode}/${periodKey(period)}.json`;
const ARCHIVE_PREFIX = (mode) => `kabi/archive/${mode}/`;
const emptyDraft = () => ({ data: null, version: 0, history: [] });

// ── Health ──
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString(), storage: storage.backend });
});

// ── Current draft endpoints ──
app.get('/api/reports/:mode', async (req, res) => {
  const { mode } = req.params;
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  const state = (await storage.getJSON(DRAFT_PATH(mode))) || emptyDraft();
  res.json({ data: state.data, version: state.version });
});

app.get('/api/reports/:mode/version', async (req, res) => {
  const { mode } = req.params;
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  const state = (await storage.getJSON(DRAFT_PATH(mode))) || emptyDraft();
  res.json({ version: state.version });
});

app.put('/api/reports/:mode', async (req, res) => {
  const { mode } = req.params;
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  const { data, user } = req.body;
  if (!data) return res.status(400).json({ error: 'Missing data' });
  const state = (await storage.getJSON(DRAFT_PATH(mode))) || emptyDraft();
  state.data = data;
  state.version++;
  const savedAt = new Date().toISOString();
  state.history.push({
    id: state.history.length + 1,
    version: state.version,
    saved_by: sanitize(user || 'anonymous'),
    saved_at: savedAt
  });
  if (state.history.length > 50) state.history = state.history.slice(-50);
  await storage.setJSON(DRAFT_PATH(mode), state);
  res.json({ ok: true, version: state.version, savedAt });
});

// Clear the current draft (used when monthly/quarterly is archived)
app.delete('/api/reports/:mode', async (req, res) => {
  const { mode } = req.params;
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  await storage.setJSON(DRAFT_PATH(mode), emptyDraft());
  res.json({ ok: true, cleared: true });
});

app.get('/api/reports/:mode/history', async (req, res) => {
  const { mode } = req.params;
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  const state = (await storage.getJSON(DRAFT_PATH(mode))) || emptyDraft();
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const items = state.history.slice(-limit).reverse();
  res.json({ history: items });
});

// ── Archive endpoints ──
// Schema for an archived entry:
//   { period: "April 2026",
//     sections: { ops: {...}, hcdev: {...}, ... },
//     savedAt:  { ops: "ISO", hcdev: "ISO", ... },
//     lastSavedAt: "ISO",  lastSavedBy: "name",  mode }
//
// Legacy entries used `{ period, data, saved_by, saved_at, mode }` where `data.secs.{secId}`
// held each section. We migrate-on-read so old entries still appear correctly.

function normalizeArchiveEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.sections && typeof entry.sections === 'object') return entry;
  // Legacy migration
  if (entry.data && entry.data.secs) {
    return {
      period: entry.period,
      sections: { ...entry.data.secs },
      savedAt: {},
      lastSavedAt: entry.saved_at,
      lastSavedBy: entry.saved_by,
      mode: entry.mode,
      _legacyData: entry.data       // keep original for backward fetch
    };
  }
  return entry;
}

// PUT: save/update ONE section in an archive entry (per-section save).
// Body: { period: "April 2026", sectionId: "ops", sectionData: {...}, user: "..." }
app.put('/api/archive/:mode/:period', async (req, res) => {
  const { mode } = req.params;
  const periodSlug = decodeURIComponent(req.params.period || '');
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  if (!periodSlug) return res.status(400).json({ error: 'Missing period slug' });

  const { period, sectionId, sectionData, user } = req.body || {};
  if (!period || !sectionId || !sectionData) {
    return res.status(400).json({ error: 'Missing period, sectionId, or sectionData' });
  }

  try {
    const path = ARCHIVE_PATH(mode, periodSlug);
    let entry = normalizeArchiveEntry(await storage.getJSON(path));
    if (!entry) entry = { period: cleanPeriod(period), sections: {}, savedAt: {}, mode };
    if (!entry.sections) entry.sections = {};
    if (!entry.savedAt)  entry.savedAt  = {};

    entry.sections[sectionId] = sectionData;
    entry.savedAt[sectionId]  = new Date().toISOString();
    entry.lastSavedAt = entry.savedAt[sectionId];
    entry.lastSavedBy = sanitize(user || 'anonymous');
    entry.period = cleanPeriod(period);
    entry.mode = mode;

    await storage.setJSON(path, entry);
    res.json({ ok: true, period: entry.period, sectionId, lastSavedAt: entry.lastSavedAt });
  } catch (err) {
    console.error('PUT archive err:', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST: legacy full-snapshot save (still supported by older clients).
app.post('/api/archive/:mode/:period', async (req, res) => {
  const { mode } = req.params;
  const period = decodeURIComponent(req.params.period || '');
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  if (!period) return res.status(400).json({ error: 'Missing period' });

  // RESTORE MODE: { entry: {...full archive doc...} }  → save as-is, preserving
  // savedAt / lastSavedAt / lastSavedBy. Used by Restore (importArchive).
  if (req.body && req.body.entry && typeof req.body.entry === 'object') {
    const e = req.body.entry;
    const entry = {
      period: cleanPeriod(e.period || period),
      sections: e.sections || {},
      savedAt: e.savedAt || {},
      lastSavedAt: e.lastSavedAt || new Date().toISOString(),
      lastSavedBy: sanitize(e.lastSavedBy || 'restore'),
      mode
    };
    if (e._customSections) entry._customSections = e._customSections;
    await storage.setJSON(ARCHIVE_PATH(mode, period), entry);
    return res.json({ ok: true, restored: true, period: entry.period, lastSavedAt: entry.lastSavedAt });
  }

  const { data, user } = req.body;
  if (!data) return res.status(400).json({ error: 'Missing data' });

  // Convert to the new section-based schema so reads are consistent.
  const sections = (data && data.secs) ? { ...data.secs } : {};
  const now = new Date().toISOString();
  const savedAt = {};
  for (const k of Object.keys(sections)) savedAt[k] = now;
  const entry = {
    period: cleanPeriod(data.week || period),
    sections,
    savedAt,
    lastSavedAt: now,
    lastSavedBy: sanitize(user || 'anonymous'),
    mode
  };
  await storage.setJSON(ARCHIVE_PATH(mode, period), entry);
  res.json({ ok: true, period: entry.period, lastSavedAt: now });
});

// List all archived entries for a mode (with section keys for UI filtering).
app.get('/api/archive/:mode', async (req, res) => {
  const { mode } = req.params;
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  const list = await storage.listPrefix(ARCHIVE_PREFIX(mode));
  const entries = list.map((e) => {
    const n = normalizeArchiveEntry(e.data) || {};
    return {
      period: n.period || '',
      sections: n.sections ? Object.keys(n.sections) : [],
      lastSavedAt: n.lastSavedAt || e.uploadedAt,
      lastSavedBy: n.lastSavedBy || ''
    };
  });
  res.json({ entries });
});

// Get one archived entry (full data).
app.get('/api/archive/:mode/:period', async (req, res) => {
  const { mode } = req.params;
  const period = decodeURIComponent(req.params.period || '');
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  const raw = await storage.getJSON(ARCHIVE_PATH(mode, period));
  const entry = normalizeArchiveEntry(raw);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  res.json(entry);
});

// Delete the entire archive entry for a period (all sections).
app.delete('/api/archive/:mode/:period', async (req, res) => {
  const { mode } = req.params;
  const period = decodeURIComponent(req.params.period || '');
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  await storage.deleteByPathname(ARCHIVE_PATH(mode, period));
  res.json({ ok: true, deleted: true });
});

// Delete ONE section from an archive entry (un-archive that section).
app.delete('/api/archive/:mode/:period/:sectionId', async (req, res) => {
  const { mode, sectionId } = req.params;
  const period = decodeURIComponent(req.params.period || '');
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  try {
    const path = ARCHIVE_PATH(mode, period);
    const entry = normalizeArchiveEntry(await storage.getJSON(path));
    if (!entry || !entry.sections) return res.status(404).json({ error: 'Not found' });
    delete entry.sections[sectionId];
    if (entry.savedAt) delete entry.savedAt[sectionId];
    if (Object.keys(entry.sections).length === 0) {
      await storage.deleteByPathname(path);
    } else {
      entry.lastSavedAt = new Date().toISOString();
      await storage.setJSON(path, entry);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Legacy: sync/propagate (kept for compatibility, period-aware) ──
app.post('/api/sync/propagate', async (req, res) => {
  res.json({ ok: true, note: 'Auto-propagation is disabled. Use per-section Generate button.' });
});

// ── Import (unchanged) ──
app.post('/api/import', async (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'Missing entries' });
  let imported = 0;
  for (const e of entries) {
    if (e.mode && e.data && VALID_MODE.has(e.mode) && e.period) {
      await storage.setJSON(ARCHIVE_PATH(e.mode, e.period), {
        period: cleanPeriod(e.period),
        data: e.data,
        saved_by: 'import',
        saved_at: new Date().toISOString(),
        mode: e.mode
      });
      imported++;
    }
  }
  res.json({ ok: true, imported });
});


// ═════════════════════════════════════════════════════════════════
// EXTERNAL READ-ONLY API  /api/v1/*
// Requires KABI_READ_TOKEN env var. Accepts the token via
//   • Authorization: Bearer <token>
//   • or  ?token=<token>  (URL-friendly for simple integrations)
// All endpoints are GET-only — no writes, no deletes.
// ═════════════════════════════════════════════════════════════════
const READ_TOKEN = process.env.KABI_READ_TOKEN || '';

function checkReadToken(req, res, next) {
  if (!READ_TOKEN) {
    return res.status(503).json({
      error: 'External API not configured',
      hint: 'Set KABI_READ_TOKEN env var in Vercel project settings to enable'
    });
  }
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const qtoken = (req.query && req.query.token) ? String(req.query.token).trim() : '';
  const given = bearer || qtoken;
  if (given !== READ_TOKEN) {
    return res.status(401).json({ error: 'Invalid or missing token' });
  }
  next();
}

// ── Health ──
app.get('/api/v1/health', checkReadToken, (_req, res) => {
  res.json({
    status: 'ok',
    api: 'kabi-hc-hub-readonly',
    version: 1,
    storage: storage.backend,
    timestamp: new Date().toISOString()
  });
});

// ── Section metadata (so external systems know the schema) ──
app.get('/api/v1/sections', checkReadToken, (_req, res) => {
  res.json({
    builtin: [
      { id: 'ops',   name: 'Operations',              builtin: true },
      { id: 'hcdev', name: 'HC Development & PM',     builtin: true },
      { id: 'ic',    name: 'Internal Communication',  builtin: true },
      { id: 'ta',    name: 'Talent Acquisition',      builtin: true },
      { id: 'it',    name: 'Information Technology',  builtin: true },
      { id: 'fac',   name: 'Facility',                builtin: true }
    ],
    sectionDataShape: {
      p:  'string — presenter name',
      kp: 'array of [task, status, details] — Key Points',
      ac: 'array of strings — Activities / Accomplishments',
      ch: 'array of [challenge, action] — Challenges',
      nw: 'array of strings — Next-period Focus',
      tk: 'array of tickets (IT/Facility only)',
      pr: 'array of [item, qty/price] (Facility only)',
      pt: 'string — total (Facility only)',
      t:  'string — ticket count (IT only)'
    }
  });
});

// ── List entries for a mode ──
app.get('/api/v1/archive/:mode', checkReadToken, async (req, res) => {
  const { mode } = req.params;
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode (use weekly|monthly|quarterly)' });
  try {
    const blobs = await storage.listPrefix(ARCHIVE_PREFIX(mode));
    const items = blobs.map(b => ({
      slug: b.pathname.replace(ARCHIVE_PREFIX(mode), '').replace(/\.json$/, ''),
      period: b.data?.period,
      mode: b.data?.mode || mode,
      lastSavedAt: b.data?.lastSavedAt,
      lastSavedBy: b.data?.lastSavedBy,
      sections: Object.keys(b.data?.sections || {}),
      uploadedAt: b.uploadedAt
    }));
    items.sort((a, b) => (b.lastSavedAt || '').localeCompare(a.lastSavedAt || ''));
    res.json({ mode, count: items.length, items });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// ── Get full entry for a mode + period ──
app.get('/api/v1/archive/:mode/:period', checkReadToken, async (req, res) => {
  const { mode } = req.params;
  const period = decodeURIComponent(req.params.period || '');
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  try {
    const entry = await storage.getJSON(ARCHIVE_PATH(mode, period));
    if (!entry) return res.status(404).json({ error: 'Not found', mode, period });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// ── Dump all archives (every mode, every period) — heavy, useful for sync ──
app.get('/api/v1/archive', checkReadToken, async (_req, res) => {
  try {
    const out = { weekly: [], monthly: [], quarterly: [] };
    for (const mode of ['weekly', 'monthly', 'quarterly']) {
      const blobs = await storage.listPrefix(ARCHIVE_PREFIX(mode));
      out[mode] = blobs.map(b => b.data).filter(Boolean);
    }
    res.json({
      generatedAt: new Date().toISOString(),
      counts: { weekly: out.weekly.length, monthly: out.monthly.length, quarterly: out.quarterly.length },
      data: out
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// ── Get one specific SECTION within an entry (lightweight) ──
app.get('/api/v1/archive/:mode/:period/:sectionId', checkReadToken, async (req, res) => {
  const { mode, sectionId } = req.params;
  const period = decodeURIComponent(req.params.period || '');
  if (!VALID_MODE.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  try {
    const entry = await storage.getJSON(ARCHIVE_PATH(mode, period));
    if (!entry) return res.status(404).json({ error: 'Entry not found', mode, period });
    const section = entry.sections && entry.sections[sectionId];
    if (!section) return res.status(404).json({ error: 'Section not found', sectionId });
    res.json({
      mode, period: entry.period, sectionId, section,
      savedAt: entry.savedAt && entry.savedAt[sectionId],
      lastSavedBy: entry.lastSavedBy
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});


module.exports = app;
