require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { OMDB_API_KEY } = process.env;
if (!OMDB_API_KEY) {
  console.error('Missing OMDB_API_KEY in environment.');
  // Only hard-exit locally; on Vercel, exiting would just give a confusing crash
  if (require.main === module) process.exit(1);
}

// Clean each origin: remove quotes, spaces and a trailing slash, so small .env typos don't break matching
const clean = s => s.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(clean).filter(Boolean);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.get('/health', (_req, res) => res.json({ ok: true }));

// Fail clearly if the key is missing in deployment
app.use('/api', (_req, res, next) => {
  if (!OMDB_API_KEY) return res.status(500).json({ error: 'Server not configured' });
  next();
});

// 1) Origin check.
// Chrome often sends NO Origin header for extension requests, so a missing Origin is allowed.
// If an Origin IS sent, it must be in ALLOWED_ORIGINS.
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowed.includes(origin)) {
    console.error(`BLOCKED: origin ${JSON.stringify(origin)} is not in ALLOWED_ORIGINS`);
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});
app.use(cors({ origin: allowed.length ? allowed : false, methods: ['GET'] }));

// 2) Rate limit per IP (per function instance on Vercel, so only a soft limit)
app.use('/api', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));

// 3) Cache (per warm instance on Vercel; helps, but isn't shared or guaranteed)
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, exp: Date.now() + ttlMs });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

async function omdb(params) {
  const url = new URL('https://www.omdbapi.com/');
  Object.entries({ ...params, apikey: OMDB_API_KEY }).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url);
  let data;
  try { data = await r.json(); } catch { throw new Error('OMDb returned HTTP ' + r.status); }
  // Key problems and quota problems are real failures; "Movie not found" is not
  if (data.Response === 'False' && /api key|limit/i.test(data.Error || '')) {
    throw new Error('OMDb said: ' + data.Error);
  }
  return data;
}
const val = v => (v && v !== 'N/A' ? v : null);
const poster = v => (val(v) && v.startsWith('https://') ? v : null);

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.status(400).json({ error: 'Query too short' });
  try {
    const data = await cached('s:' + q.toLowerCase(), 10 * 60_000, () => omdb({ s: q, type: 'movie' }));
    if (data.Response === 'False') return res.json([]);
    res.json(data.Search.slice(0, 8).map(m => ({
      id: m.imdbID, title: m.Title, year: m.Year, poster: poster(m.Poster),
    })));
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(502).json({ error: 'Search failed' });
  }
});

app.get('/api/movie/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^tt\d{6,10}$/.test(id)) return res.status(400).json({ error: 'Bad request' });
  try {
    const out = await cached('m:' + id, 60 * 60_000, async () => {
      const o = await omdb({ i: id, plot: 'short' });
      if (o.Response === 'False') return null;
      return {
        id: o.imdbID,
        title: o.Title,
        year: o.Year,
        rated: val(o.Rated),
        runtime: val(o.Runtime),
        genres: val(o.Genre) ? o.Genre.split(', ') : [],
        director: val(o.Director),
        actors: val(o.Actors),
        awards: val(o.Awards),
        plot: val(o.Plot),
        poster: poster(o.Poster),
        ratings: {
          imdb: val(o.imdbRating),
          imdbVotes: val(o.imdbVotes),
          rottenTomatoes: o.Ratings?.find(r => r.Source === 'Rotten Tomatoes')?.Value || null,
          metacritic: val(o.Metascore),
        },
        links: {
          imdb: `https://www.imdb.com/title/${o.imdbID}/`,
          reviews: `https://www.imdb.com/title/${o.imdbID}/reviews/`,
          watch: `https://www.justwatch.com/search?q=${encodeURIComponent(o.Title)}`,
        },
      };
    });
    if (!out) return res.status(404).json({ error: 'Not found' });
    res.json(out);
  } catch (e) {
    console.error('Lookup error:', e.message);
    res.status(502).json({ error: 'Lookup failed' });
  }
});

// Vercel: export the app. Local: run it with `node api/index.js`.
if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => {
    console.log('CineStub backend running');
    console.log('Allowed origins:', JSON.stringify(allowed));
    console.log('OMDb key loaded, length:', (OMDB_API_KEY || '').length, '(normally 8)');
  });
}

module.exports = app;