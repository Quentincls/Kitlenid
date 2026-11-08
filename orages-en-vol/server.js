// Orages en vol — serveur (Node.js >= 22, aucune dépendance)
// - sert le site statique (public/)
// - relaie les sources ouvertes qui n'autorisent pas les appels directs du navigateur (CORS)
// - agrège la foudre temps réel Blitzortung et la diffuse en Server-Sent Events

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const UA = "orages-en-vol/1.0 (+open-data storm map)";
const LIGHTNING_KEEP_MS = 60 * 60 * 1000; // 60 min d'historique
const LIGHTNING_MAX = 60000;

/* ------------------------------------------------------------------ */
/* Cache HTTP minimal                                                  */
/* ------------------------------------------------------------------ */
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttlMs) return hit.v;
  if (hit && hit.p) return hit.p;
  const p = fn()
    .then((v) => {
      cache.set(key, { t: Date.now(), v });
      return v;
    })
    .catch((e) => {
      // en cas d'erreur on renvoie la dernière valeur connue si elle existe
      if (hit) {
        cache.set(key, { t: hit.t, v: hit.v });
        return hit.v;
      }
      cache.delete(key);
      throw e;
    });
  cache.set(key, { ...(hit || { t: 0 }), p });
  return p;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (!v.p && now - v.t > 15 * 60 * 1000) cache.delete(k);
}, 60000).unref();

async function getJSON(url, { timeout = 15000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ------------------------------------------------------------------ */
/* Foudre temps réel — Blitzortung.org (réseau communautaire)          */
/* ------------------------------------------------------------------ */
const strikes = []; // {t, lat, lon}
const sseClients = new Set();
let pending = [];
let wsState = { host: null, connected: false, since: null, received: 0 };

function lzwDecode(b) {
  const dict = {};
  const chars = b.split("");
  let cur = chars[0];
  let prev = cur;
  const out = [cur];
  let code = 256;
  for (let i = 1; i < chars.length; i++) {
    const c = chars[i].charCodeAt(0);
    const entry = c < 256 ? chars[i] : dict[c] ? dict[c] : prev + cur;
    out.push(entry);
    cur = entry.charAt(0);
    dict[code++] = prev + cur;
    prev = entry;
  }
  return out.join("");
}

const WS_HOSTS = ["ws1", "ws8", "ws2", "ws3", "ws7"];
let wsIdx = 0;
function connectLightning() {
  if (typeof WebSocket === "undefined") {
    console.error("WebSocket indisponible : Node.js >= 22 requis pour la foudre temps réel");
    return;
  }
  const host = WS_HOSTS[wsIdx++ % WS_HOSTS.length];
  let ws;
  let watchdog;
  const restart = () => {
    clearTimeout(watchdog);
    wsState.connected = false;
    try { ws.close(); } catch {}
    setTimeout(connectLightning, 3000);
  };
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(restart, 60000); // pas de message pendant 60 s -> reconnexion
  };
  try {
    ws = new WebSocket(`wss://${host}.blitzortung.org/`);
  } catch (e) {
    return setTimeout(connectLightning, 5000);
  }
  ws.onopen = () => {
    wsState = { host, connected: true, since: Date.now(), received: wsState.received };
    ws.send('{"a":111}');
    arm();
    console.log(`[foudre] connecté à ${host}.blitzortung.org`);
  };
  ws.onmessage = (m) => {
    arm();
    try {
      const j = JSON.parse(lzwDecode(String(m.data)));
      if (typeof j.lat !== "number" || typeof j.lon !== "number") return;
      const s = { t: Math.round(j.time / 1e6), lat: +j.lat.toFixed(4), lon: +j.lon.toFixed(4) };
      strikes.push(s);
      pending.push(s);
      wsState.received++;
    } catch {}
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    console.log(`[foudre] déconnecté de ${host}, nouvelle tentative…`);
    restart();
  };
}

// diffusion groupée toutes les secondes + purge de l'historique
setInterval(() => {
  const cutoff = Date.now() - LIGHTNING_KEEP_MS;
  let drop = 0;
  while (drop < strikes.length && strikes[drop].t < cutoff) drop++;
  if (strikes.length - drop > LIGHTNING_MAX) drop = strikes.length - LIGHTNING_MAX;
  if (drop) strikes.splice(0, drop);
  if (!pending.length) return;
  const payload = `data: ${JSON.stringify(pending.map((s) => [s.t, s.lat, s.lon]))}\n\n`;
  pending = [];
  for (const res of sseClients) res.write(payload);
}, 1000).unref();

setInterval(() => {
  for (const res of sseClients) res.write(": ping\n\n");
}, 20000).unref();

/* ------------------------------------------------------------------ */
/* Sources aéronautiques                                               */
/* ------------------------------------------------------------------ */
const AWC = "https://aviationweather.gov/api/data";

function parseBbox(q) {
  // bbox = sud,ouest,nord,est
  const v = String(q || "").split(",").map(Number);
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) return null;
  let [s, w, n, e] = v;
  s = Math.max(-90, s); n = Math.min(90, n);
  w = Math.max(-180, w); e = Math.min(180, e);
  // arrondi pour mutualiser le cache
  const r = (x) => Math.round(x * 2) / 2;
  return [r(s), r(w), r(n), r(e)];
}

async function sigmets() {
  return cached("sigmets", 120000, async () => {
    const [intl, us] = await Promise.allSettled([
      getJSON(`${AWC}/isigmet?format=geojson`),
      getJSON(`${AWC}/airsigmet?format=geojson`),
    ]);
    const feats = [];
    if (intl.status === "fulfilled" && intl.value?.features) {
      for (const f of intl.value.features) {
        const p = f.properties || {};
        feats.push({
          type: "Feature",
          geometry: f.geometry,
          properties: {
            source: "ISIGMET",
            fir: p.firName || p.firId,
            id: p.seriesId,
            hazard: p.hazard,
            qualifier: p.qualifier,
            from: p.validTimeFrom,
            to: p.validTimeTo,
            top: p.top ?? null,
            base: p.base ?? null,
            dir: p.dir,
            spd: p.spd,
            raw: p.rawSigmet,
            convective: p.hazard === "TS" || /\bTS|CB\b/.test(p.rawSigmet || ""),
          },
        });
      }
    }
    if (us.status === "fulfilled" && us.value?.features) {
      for (const f of us.value.features) {
        const p = f.properties || {};
        feats.push({
          type: "Feature",
          geometry: f.geometry,
          properties: {
            source: p.airSigmetType || "AIRSIGMET",
            fir: p.icaoId,
            id: p.seriesId,
            hazard: p.hazard,
            from: p.validTimeFrom,
            to: p.validTimeTo,
            top: p.altitudeHi1 ?? null,
            base: p.altitudeLow1 ?? null,
            dir: p.movementDir,
            spd: p.movementSpd,
            raw: p.rawAirSigmet,
            convective: p.hazard === "CONVECTIVE" || p.hazard === "TS",
          },
        });
      }
    }
    if (!feats.length && intl.status === "rejected" && us.status === "rejected") throw intl.reason;
    return { type: "FeatureCollection", features: feats.filter((f) => f.geometry) };
  });
}

async function metars(bbox) {
  const key = "metar:" + bbox.join(",");
  return cached(key, 120000, async () => {
    const d = await getJSON(`${AWC}/metar?format=geojson&bbox=${bbox.join(",")}`);
    const features = (d?.features || []).map((f) => {
      const p = f.properties || {};
      const raw = p.rawOb || "";
      return {
        type: "Feature",
        geometry: f.geometry,
        properties: {
          id: p.id,
          site: p.site,
          time: p.obsTime,
          raw,
          wx: p.wx,
          fltcat: p.fltcat,
          wspd: p.wspd,
          wgst: p.wgst,
          wdir: p.wdir,
          ts: /(^|\s)[-+]?(VC)?TS[A-Z]*/.test(raw.split(" RMK")[0]) || /(^|\s)(\+|-)?TS/.test(p.wx || ""),
          cb: /\d{3}CB\b/.test(raw) || /\bTCU\b/.test(raw),
        },
      };
    });
    return { type: "FeatureCollection", features };
  });
}

async function pireps(bbox) {
  const key = "pirep:" + bbox.join(",");
  return cached(key, 180000, async () => {
    const d = await getJSON(`${AWC}/pirep?format=geojson&age=3&bbox=${bbox.join(",")}`);
    const features = (d?.features || []).map((f) => {
      const p = f.properties || {};
      return {
        type: "Feature",
        geometry: f.geometry,
        properties: {
          raw: p.rawOb,
          type: p.airepType,
          ac: p.acType,
          fl: p.fltlvl,
          time: p.obsTime,
          tb: p.tbInt1 || null,
          ic: p.icgInt1 || null,
          wx: p.wxString || null,
        },
      };
    });
    return { type: "FeatureCollection", features };
  });
}

// Avions : adsb.lol (données ouvertes ODbL), repli sur OpenSky Network
async function aircraft(lat, lon, distNm) {
  const r = (x) => Math.round(x * 4) / 4;
  lat = r(lat); lon = r(lon);
  const dist = Math.max(10, Math.min(250, Math.round(distNm / 10) * 10));
  const key = `ac:${lat}:${lon}:${dist}`;
  return cached(key, 8000, async () => {
    try {
      const d = await getJSON(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`, { timeout: 12000 });
      return {
        source: "adsb.lol",
        aircraft: (d?.ac || [])
          .filter((a) => typeof a.lat === "number" && typeof a.lon === "number")
          .map((a) => ({
            id: a.hex,
            cs: (a.flight || "").trim() || a.r || a.hex,
            reg: a.r || null,
            type: a.t || null,
            lat: a.lat,
            lon: a.lon,
            alt: a.alt_baro === "ground" ? 0 : a.alt_geom ?? a.alt_baro ?? null, // ft
            gnd: a.alt_baro === "ground",
            gs: a.gs ?? null, // kt
            trk: a.track ?? a.true_heading ?? null,
            vs: a.baro_rate ?? a.geom_rate ?? null, // ft/min
            sq: a.squawk || null,
          })),
      };
    } catch (e) {
      const dLat = dist / 60;
      const dLon = dist / (60 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
      const url = `https://opensky-network.org/api/states/all?lamin=${lat - dLat}&lomin=${lon - dLon}&lamax=${lat + dLat}&lomax=${lon + dLon}`;
      const d = await getJSON(url, { timeout: 15000 });
      return {
        source: "OpenSky Network",
        aircraft: (d?.states || [])
          .filter((s) => typeof s[5] === "number" && typeof s[6] === "number")
          .map((s) => ({
            id: s[0],
            cs: (s[1] || "").trim() || s[0],
            reg: null,
            type: null,
            lat: s[6],
            lon: s[5],
            alt: s[13] != null ? Math.round(s[13] * 3.28084) : s[7] != null ? Math.round(s[7] * 3.28084) : null,
            gnd: !!s[8],
            gs: s[9] != null ? Math.round(s[9] * 1.94384) : null,
            trk: s[10],
            vs: s[11] != null ? Math.round(s[11] * 196.85) : null,
            sq: s[14],
          })),
      };
    }
  });
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function sendJSON(res, code, obj, maxAge = 0) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(obj));
}

async function serveStatic(req, res, pathname) {
  let p = pathname === "/" ? "/index.html" : pathname;
  const file = normalize(join(PUBLIC_DIR, decodeURIComponent(p)));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Introuvable");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const q = url.searchParams;
  try {
    switch (url.pathname) {
      case "/api/health":
        return sendJSON(res, 200, {
          ok: true,
          lightning: { ...wsState, buffered: strikes.length, clients: sseClients.size },
        });

      case "/api/lightning": {
        const since = Number(q.get("since")) || Date.now() - 30 * 60 * 1000;
        let i = strikes.length;
        while (i > 0 && strikes[i - 1].t >= since) i--;
        return sendJSON(res, 200, strikes.slice(i).map((s) => [s.t, s.lat, s.lon]));
      }

      case "/api/lightning/stream": {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("retry: 3000\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      case "/api/sigmets":
        return sendJSON(res, 200, await sigmets(), 60);

      case "/api/metars": {
        const bbox = parseBbox(q.get("bbox"));
        if (!bbox) return sendJSON(res, 400, { error: "bbox=sud,ouest,nord,est requis" });
        return sendJSON(res, 200, await metars(bbox), 60);
      }

      case "/api/pireps": {
        const bbox = parseBbox(q.get("bbox"));
        if (!bbox) return sendJSON(res, 400, { error: "bbox=sud,ouest,nord,est requis" });
        return sendJSON(res, 200, await pireps(bbox), 60);
      }

      case "/api/aircraft": {
        const lat = Number(q.get("lat"));
        const lon = Number(q.get("lon"));
        const dist = Number(q.get("dist") || 150);
        if (!Number.isFinite(lat) || !Number.isFinite(lon))
          return sendJSON(res, 400, { error: "lat et lon requis" });
        return sendJSON(res, 200, await aircraft(lat, lon, dist));
      }

      default:
        if (url.pathname.startsWith("/api/")) return sendJSON(res, 404, { error: "inconnu" });
        return serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    console.error("[api]", url.pathname, e.message);
    return sendJSON(res, 502, { error: "source indisponible", detail: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Orages en vol : http://localhost:${PORT}`);
  if (process.env.NO_LIGHTNING !== "1") connectLightning();
});
