const express = require('express');
const app = express();

app.use(express.json({ limit: '5mb' }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ─────────────────────────────────────────────────────────────────
// Storage layer
//   • Uses Vercel Blob when BLOB_READ_WRITE_TOKEN is present
//     (set automatically when you create a Blob store from
//      Vercel Storage → Blob → Create and connect to the project).
//   • Falls back to in-memory store when the env var is missing
//     (local dev, or while the integration is not yet attached).
// ─────────────────────────────────────────────────────────────────
let storage;
const hasBlob = !!process.env.BLOB_READ_WRITE_TOKEN;

if (hasBlob) {
  const blob = require('@vercel/blob');
  const PATHNAME = (mode) => `kabi/reports/${mode}.json`;

  storage = {
    backend: 'blob',
    async get(mode) {
      try {
        // Look up the blob by exact pathname (returns URL we can fetch)
        const { blobs } = await blob.list({ prefix: PATHNAME(mode), limit: 5 });
        if (!blobs.length) return null;
        const match = blobs.find((b) => b.pathname === PATHNAME(mode)) || blobs[0];
        // Cache-bust to avoid stale CDN reads right after a write
        const res = await fetch(match.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
      } catch (err) {
        console.error('[Blob] get error:', err);
        return null;
      }
    },
    async set(mode, value) {
      await blob.put(PATHNAME(mode), JSON.stringify(value), {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
        cacheControlMaxAge: 0   // disable CDN caching for read-after-write
      });
    }
  };
} else {
  const mem = { weekly: null, monthly: null, quarterly: null };
  storage = {
    backend: 'memory',
    async get(mode)        { return mem[mode]; },
    async set(mode, value) { mem[mode] = value; }
  };
}

const VALID = new Set(['weekly', 'monthly', 'quarterly']);
const clean = (s) => String(s || '').slice(0, 100).replace(/[<>"']/g, '');
const emptyState = () => ({ data: null, version: 0, history: [] });

// ── Health ──
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString(), storage: storage.backend });
});

// ── GET current report for a mode ──
app.get('/api/reports/:mode', async (req, res) => {
  const { mode } = req.params;
  if (!VALID.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  try {
    const state = (await storage.get(mode)) || emptyState();
    res.json({ data: state.data, version: state.version });
  } catch (err) {
    res.status(500).json({ error: 'Storage error', detail: String(err) });
  }
});

// ── GET version only ──
app.get('/api/reports/:mode/version', async (req, res) => {
  const { mode } = req.params;
  if (!VALID.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  try {
    const state = (await storage.get(mode)) || emptyState();
    res.json({ version: state.version });
  } catch (err) {
    res.status(500).json({ error: 'Storage error', detail: String(err) });
  }
});

// ── PUT report ──
app.put('/api/reports/:mode', async (req, res) => {
  const { mode } = req.params;
  if (!VALID.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  const { data, user } = req.body;
  if (!data) return res.status(400).json({ error: 'Missing data' });

  try {
    const state = (await storage.get(mode)) || emptyState();
    state.data = data;
    state.version++;
    const savedAt = new Date().toISOString();
    state.history.push({
      id: state.history.length + 1,
      data: JSON.parse(JSON.stringify(data)),
      version: state.version,
      saved_by: clean(user || 'anonymous'),
      saved_at: savedAt
    });
    if (state.history.length > 50) state.history = state.history.slice(-50);
    await storage.set(mode, state);
    res.json({ ok: true, version: state.version, savedAt });
  } catch (err) {
    res.status(500).json({ error: 'Storage error', detail: String(err) });
  }
});

// ── GET history ──
app.get('/api/reports/:mode/history', async (req, res) => {
  const { mode } = req.params;
  if (!VALID.has(mode)) return res.status(400).json({ error: 'Invalid mode' });
  try {
    const state = (await storage.get(mode)) || emptyState();
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const items = state.history.slice(-limit).reverse().map((h) => ({
      id: h.id, version: h.version, saved_at: h.saved_at, saved_by: h.saved_by
    }));
    res.json({ history: items });
  } catch (err) {
    res.status(500).json({ error: 'Storage error', detail: String(err) });
  }
});

// ── POST sync/propagate ──
app.post('/api/sync/propagate', async (req, res) => {
  const { source } = req.body || {};
  const results = [];
  try {
    if (!source || source === 'weekly') {
      const weekly = (await storage.get('weekly')) || emptyState();
      if (weekly.data) {
        const monthly = (await storage.get('monthly')) || emptyState();
        monthly.data = mergeData(monthly.data, weekly.data);
        monthly.version++;
        await storage.set('monthly', monthly);
        results.push({ target: 'monthly', version: monthly.version });
      }
    }
    if (!source || source === 'weekly' || source === 'monthly') {
      const monthly = (await storage.get('monthly')) || emptyState();
      if (monthly.data) {
        const quarterly = (await storage.get('quarterly')) || emptyState();
        quarterly.data = mergeData(quarterly.data, monthly.data);
        quarterly.version++;
        await storage.set('quarterly', quarterly);
        results.push({ target: 'quarterly', version: quarterly.version });
      }
    }
    res.json({ ok: true, propagated: results });
  } catch (err) {
    res.status(500).json({ error: 'Storage error', detail: String(err) });
  }
});

// ── POST import ──
app.post('/api/import', async (req, res) => {
  const { entries } = req.body || {};
  if (!entries || !Array.isArray(entries)) return res.status(400).json({ error: 'Missing entries' });
  try {
    let imported = 0;
    const states = {
      weekly:    (await storage.get('weekly'))    || emptyState(),
      monthly:   (await storage.get('monthly'))   || emptyState(),
      quarterly: (await storage.get('quarterly')) || emptyState()
    };
    for (const e of entries) {
      if (e.mode && e.data && VALID.has(e.mode)) {
        const s = states[e.mode];
        s.history.push({
          id: s.history.length + 1,
          data: e.data,
          version: ++imported,
          saved_by: 'import',
          saved_at: new Date().toISOString()
        });
      }
    }
    for (const mode of VALID) {
      await storage.set(mode, states[mode]);
    }
    res.json({ ok: true, imported });
  } catch (err) {
    res.status(500).json({ error: 'Storage error', detail: String(err) });
  }
});

// ── Merge helper (unchanged) ──
function mergeData(base, incoming) {
  if (!incoming) return base;
  if (!base) return JSON.parse(JSON.stringify(incoming));
  const out = { week: base.week || incoming.week, secs: {} };
  const allKeys = new Set([...Object.keys(base.secs || {}), ...Object.keys(incoming.secs || {})]);
  for (const k of allKeys) {
    const b = (base.secs || {})[k] || {};
    const inc = (incoming.secs || {})[k] || {};
    out.secs[k] = { ...b };
    if (!out.secs[k].p && inc.p) out.secs[k].p = inc.p;
    for (const arr of ['kp', 'ac', 'ch', 'nw', 'pr', 'tk']) {
      const seen = new Set((b[arr] || []).map((x) => JSON.stringify(x)));
      out.secs[k][arr] = [...(b[arr] || [])];
      for (const item of inc[arr] || []) {
        if (!seen.has(JSON.stringify(item))) out.secs[k][arr].push(item);
      }
    }
  }
  return out;
}

module.exports = app;
