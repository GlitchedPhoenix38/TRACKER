import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Linux';
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const IS_VERCEL = process.env.VERCEL === '1' || process.env.VERCEL === 'true' || Boolean(process.env.VERCEL);
const IS_DIRECT_RUN = import.meta.url === pathToFileURL(process.argv[1]).href;
const DB_DIR = IS_VERCEL ? '/tmp' : join(process.cwd(), 'data');
const PUBLIC_DIR = join(process.cwd(), 'public');
const DB_PATH = join(DB_DIR, 'analytics.sqlite');

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    ip TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    browser TEXT NOT NULL,
    os TEXT NOT NULL,
    device TEXT NOT NULL,
    country TEXT,
    region TEXT,
    city TEXT,
    latitude REAL,
    longitude REAL,
    location_accuracy REAL,
    location_source TEXT,
    referrer TEXT,
    path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_visits_started_at ON visits(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_visits_country ON visits(country);
  CREATE INDEX IF NOT EXISTS idx_visits_device ON visits(device);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('visits', 'location_accuracy', 'REAL');
ensureColumn('visits', 'location_source', 'TEXT');

const statements = {
  insertVisit: db.prepare(`
    INSERT INTO visits (
      session_id, ip, ip_hash, user_agent, browser, os, device, country, region,
      city, latitude, longitude, location_accuracy, location_source, referrer, path,
      started_at, last_seen_at, duration_seconds
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      duration_seconds = MAX(visits.duration_seconds, excluded.duration_seconds),
      path = excluded.path,
      latitude = COALESCE(excluded.latitude, visits.latitude),
      longitude = COALESCE(excluded.longitude, visits.longitude),
      location_accuracy = COALESCE(excluded.location_accuracy, visits.location_accuracy),
      location_source = COALESCE(excluded.location_source, visits.location_source)
  `),
  updateVisit: db.prepare(`
    UPDATE visits
    SET last_seen_at = ?, duration_seconds = MAX(duration_seconds, ?)
    WHERE session_id = ?
  `),
  updateVisitLocation: db.prepare(`
    UPDATE visits
    SET
      last_seen_at = ?,
      duration_seconds = MAX(duration_seconds, ?),
      latitude = ?,
      longitude = ?,
      location_accuracy = ?,
      location_source = 'browser'
    WHERE session_id = ?
  `),
  recentVisits: db.prepare('SELECT * FROM visits ORDER BY started_at DESC LIMIT ?'),
  totals: db.prepare(`
    SELECT
      COUNT(*) AS total_visits,
      COUNT(DISTINCT ip_hash) AS unique_visitors,
      ROUND(AVG(duration_seconds)) AS avg_duration,
      MAX(started_at) AS last_visit
    FROM visits
  `),
  groupByCountry: db.prepare(`
    SELECT COALESCE(country, 'Unknown') AS label, COUNT(*) AS value
    FROM visits GROUP BY label ORDER BY value DESC LIMIT 12
  `),
  groupByDevice: db.prepare(`
    SELECT device AS label, COUNT(*) AS value
    FROM visits GROUP BY device ORDER BY value DESC
  `),
  groupByBrowser: db.prepare(`
    SELECT browser AS label, COUNT(*) AS value
    FROM visits GROUP BY browser ORDER BY value DESC LIMIT 10
  `),
  timeline: db.prepare(`
    SELECT strftime('%Y-%m-%d %H:00', started_at) AS label, COUNT(*) AS value
    FROM visits
    WHERE started_at >= datetime('now', '-7 days')
    GROUP BY label ORDER BY label ASC
  `),
  mapPoints: db.prepare(`
    SELECT
      CASE
        WHEN location_source = 'browser' THEN 'Browser location'
        ELSE COALESCE(city, region, country, 'Unknown')
      END AS label,
      country,
      latitude,
      longitude,
      location_accuracy,
      location_source,
      COUNT(*) AS value
    FROM visits
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    GROUP BY label, country, latitude, longitude, location_accuracy, location_source
    ORDER BY value DESC LIMIT 200
  `)
};

const countryCentroids = {
  US: [39.8283, -98.5795], CA: [56.1304, -106.3468], GB: [55.3781, -3.4360],
  DE: [51.1657, 10.4515], FR: [46.2276, 2.2137], IN: [20.5937, 78.9629],
  PK: [30.3753, 69.3451], BD: [23.6850, 90.3563], AU: [-25.2744, 133.7751],
  BR: [-14.2350, -51.9253], JP: [36.2048, 138.2529], SG: [1.3521, 103.8198],
  AE: [23.4241, 53.8478], NL: [52.1326, 5.2913], ES: [40.4637, -3.7492],
  IT: [41.8719, 12.5674], ZA: [-30.5595, 22.9375], MX: [23.6345, -102.5528]
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

function nowIso() {
  return new Date().toISOString();
}

function hashIp(ip) {
  return createHash('sha256').update(`${SESSION_SECRET}:${ip}`).digest('hex');
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const [key, ...value] = part.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }).filter(([key]) => key));
}

function sign(value) {
  return createHash('sha256').update(`${value}.${SESSION_SECRET}`).digest('hex');
}

function adminCookie() {
  const value = `admin.${Date.now()}`;
  return `${value}.${sign(value)}`;
}

function isAuthed(req) {
  const token = parseCookies(req.headers.cookie).analytics_admin;
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length < 3) return false;
  const signature = parts.pop();
  const value = parts.join('.');
  const expected = sign(value);
  return safeEqual(signature, expected);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(payload);
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return (ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function geoFromHeaders(req) {
  const h = req.headers;
  const country = firstHeader(h, ['cf-ipcountry', 'x-vercel-ip-country', 'x-country-code']);
  const region = firstHeader(h, ['x-vercel-ip-country-region', 'x-region', 'x-appengine-region']);
  const city = firstHeader(h, ['x-vercel-ip-city', 'x-city', 'x-appengine-city']);
  const rawLat = firstHeader(h, ['x-vercel-ip-latitude', 'x-latitude']);
  const rawLon = firstHeader(h, ['x-vercel-ip-longitude', 'x-longitude']);
  const lat = rawLat === null ? NaN : Number(rawLat);
  const lon = rawLon === null ? NaN : Number(rawLon);
  const centroid = country && countryCentroids[country.toUpperCase()];

  return {
    country: country || null,
    region: region || null,
    city: city ? decodeURIComponent(city) : null,
    latitude: Number.isFinite(lat) ? lat : centroid?.[0] ?? null,
    longitude: Number.isFinite(lon) ? lon : centroid?.[1] ?? null,
    locationAccuracy: null,
    locationSource: Number.isFinite(lat) && Number.isFinite(lon) ? 'host' : centroid ? 'country' : null
  };
}

function firstHeader(headers, names) {
  for (const name of names) {
    const value = headers[name];
    if (Array.isArray(value)) return value[0];
    if (value) return value;
  }
  return null;
}

function parseUserAgent(ua) {
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) && !/Chromium\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) && !/Chrome\//.test(ua) ? 'Safari'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /OPR\//.test(ua) ? 'Opera'
    : 'Other';

  const os = /Windows NT/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'Other';

  const device = /Mobi|Android|iPhone|iPod/.test(ua) ? 'Mobile'
    : /iPad|Tablet/.test(ua) ? 'Tablet'
    : 'Desktop';

  return { browser, os, device };
}

function browserLocation(payload) {
  const latitude = Number(payload.latitude);
  const longitude = Number(payload.longitude);
  const accuracy = Number(payload.accuracy);

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;

  return {
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? Math.min(accuracy, 1_000_000) : null
  };
}

async function handleTrack(req, res) {
  const raw = await readBody(req);
  const payload = raw ? JSON.parse(raw) : {};
  const sessionId = String(payload.sessionId || '').slice(0, 80);
  if (!sessionId) return send(res, 400, { error: 'Missing sessionId' });

  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || 'Unknown').slice(0, 1000);
  const parsedUa = parseUserAgent(ua);
  const geo = geoFromHeaders(req);
  const preciseLocation = payload.event === 'location' ? browserLocation(payload) : null;
  const duration = Math.max(0, Math.min(Number(payload.durationSeconds) || 0, 86_400));
  const seenAt = nowIso();

  if (payload.event === 'end' || payload.event === 'heartbeat') {
    statements.updateVisit.run(seenAt, duration, sessionId);
  } else if (preciseLocation) {
    const result = statements.updateVisitLocation.run(
      seenAt,
      duration,
      preciseLocation.latitude,
      preciseLocation.longitude,
      preciseLocation.accuracy,
      sessionId
    );
    if (result.changes === 0) {
      statements.insertVisit.run(
        sessionId,
        ip,
        hashIp(ip),
        ua,
        parsedUa.browser,
        parsedUa.os,
        parsedUa.device,
        geo.country,
        geo.region,
        geo.city,
        preciseLocation.latitude,
        preciseLocation.longitude,
        preciseLocation.accuracy,
        'browser',
        String(payload.referrer || '').slice(0, 500),
        String(payload.path || '/').slice(0, 300),
        seenAt,
        seenAt,
        duration
      );
    }
  } else {
    statements.insertVisit.run(
      sessionId,
      ip,
      hashIp(ip),
      ua,
      parsedUa.browser,
      parsedUa.os,
      parsedUa.device,
      geo.country,
      geo.region,
      geo.city,
      geo.latitude,
      geo.longitude,
      geo.locationAccuracy,
      geo.locationSource,
      String(payload.referrer || '').slice(0, 500),
      String(payload.path || '/').slice(0, 300),
      seenAt,
      seenAt,
      duration
    );
  }

  send(res, 204, '');
}

function adminData() {
  return {
    totals: statements.totals.get(),
    recentVisits: statements.recentVisits.all(100),
    countries: statements.groupByCountry.all(),
    devices: statements.groupByDevice.all(),
    browsers: statements.groupByBrowser.all(),
    timeline: statements.timeline.all(),
    mapPoints: statements.mapPoints.all()
  };
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'POST' && url.pathname === '/api/track') return await handleTrack(req, res);

    if (url.pathname === '/admin/login' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      if (safeEqual(body.get('password') || '', ADMIN_PASSWORD)) {
        send(res, 302, '', {
          Location: '/admin',
          'Set-Cookie': `analytics_admin=${adminCookie()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`
        });
      } else {
        send(res, 401, 'Invalid password');
      }
      return;
    }

    if (url.pathname === '/api/admin/analytics') {
      if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
      return send(res, 200, adminData());
    }

    if (url.pathname === '/admin') {
      const file = isAuthed(req) ? 'admin.html' : 'login.html';
      return serveFile(res, join(PUBLIC_DIR, file));
    }

    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    return serveFile(res, join(PUBLIC_DIR, normalize(requested).replace(/^(\.\.[/\\])+/, '')));
  } catch (error) {
    console.error(error);
    send(res, 500, { error: 'Server error' });
  }
}

export async function handler(req, res) {
  return route(req, res);
}

function serveFile(res, filePath) {
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) return send(res, 404, 'Not found');
  const ext = extname(filePath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const cache = ext === '.html' ? 'no-store' : 'public, max-age=3600';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cache });
  res.end(readFileSync(filePath));
}

if (!IS_VERCEL && IS_DIRECT_RUN) {
  createServer(route).listen(PORT, () => {
    console.log(`Analytics app listening on http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
    if (ADMIN_PASSWORD === 'Linux') {
      console.log('Set ADMIN_PASSWORD before exposing this app outside local development.');
    }
  });
}
