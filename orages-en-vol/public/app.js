/* Orages en vol — client cartographique
 * Sources : Blitzortung (via /api), RainViewer, EUMETSAT View, NOAA AWC (via /api),
 * adsb.lol / OpenSky (via /api), Open-Meteo.
 */
(() => {
  "use strict";

  /* ================================================================ */
  /* Utilitaires                                                       */
  /* ================================================================ */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const R_KM = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const KM_PER_NM = 1.852;

  function distKm(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }
  function destination(lat, lon, brg, km) {
    const d = km / R_KM, b = toRad(brg), p1 = toRad(lat), l1 = toRad(lon);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [toDeg(p2), ((toDeg(l2) + 540) % 360) - 180];
  }
  const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const cardinal = (b) => ["N", "NE", "E", "SE", "S", "SO", "O", "NO"][Math.round(b / 45) % 8];
  const fmtUTC = (d) => d.toISOString().substr(11, 5) + "Z";
  const fl = (ft) => (ft == null ? "–" : ft < 5000 ? `${Math.round(ft / 100) * 100} ft` : `FL${String(Math.round(ft / 100)).padStart(3, "0")}`);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function pointInGeom(lon, lat, g) {
    if (!g) return false;
    if (g.type === "Polygon") return pointInRing(lon, lat, g.coordinates[0]);
    if (g.type === "MultiPolygon") return g.coordinates.some((p) => pointInRing(lon, lat, p[0]));
    return false;
  }

  async function api(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
  }

  function setStatus(src, state) {
    const el = $(`.pill[data-src="${src}"]`);
    if (el) el.className = `pill ${state}`;
  }

  /* ================================================================ */
  /* Carte                                                             */
  /* ================================================================ */
  const saved = (() => {
    try {
      const h = location.hash.match(/^#(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
      if (h) return { z: +h[1], c: [+h[2], +h[3]] };
      return JSON.parse(localStorage.getItem("oev:view") || "null");
    } catch { return null; }
  })();

  const map = L.map("map", {
    center: saved?.c || [46.6, 2.4],
    zoom: saved?.z || 6,
    minZoom: 2,
    maxZoom: 12,
    worldCopyJump: true,
    zoomControl: true,
    preferCanvas: true,
  });

  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
  L.tileLayer(`${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
    maxNativeZoom: 16,
    maxZoom: 19,
    attribution: 'Fond © <a href="https://www.esri.com" target="_blank">Esri</a>, HERE, Garmin, © OpenStreetMap',
  }).addTo(map);

  // Panneaux (ordre d'empilement)
  const panes = { sat: 250, radar: 300, li: 330, sigmet: 380, strikes: 450, track: 560, aircraft: 620, labels: 640 };
  for (const [n, z] of Object.entries(panes)) {
    map.createPane(n);
    map.getPane(n).style.zIndex = z;
    if (["sat", "radar", "li", "strikes"].includes(n)) map.getPane(n).style.pointerEvents = "none";
  }
  L.tileLayer(`${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
    maxNativeZoom: 16, maxZoom: 19, pane: "labels", opacity: 0.8,
  }).addTo(map);

  function saveView() {
    const c = map.getCenter(), z = map.getZoom();
    const v = { z, c: [+c.lat.toFixed(3), +c.lng.toFixed(3)] };
    try { localStorage.setItem("oev:view", JSON.stringify(v)); } catch {}
    history.replaceState(null, "", `#${z}/${v.c[0]}/${v.c[1]}`);
  }
  map.on("moveend", saveView);

  const hint = $("#mapHint");
  function showHint(t) {
    hint.hidden = !t;
    hint.textContent = t || "";
  }

  /* ================================================================ */
  /* Foudre temps réel                                                 */
  /* ================================================================ */
  const settings = { historyMin: 30, minAlt: 20000 };
  let strikes = []; // [t, lat, lon] triés par temps
  const STRIKE_COLORS = [
    [60e3, "#ffffff"],
    [5 * 60e3, "#ffe14d"],
    [15 * 60e3, "#ff9d2e"],
    [30 * 60e3, "#ff4d4d"],
    [Infinity, "#9b3b6b"],
  ];

  const StrikeLayer = L.Layer.extend({
    onAdd(m) {
      this._canvas = L.DomUtil.create("canvas", "strike-canvas");
      this._canvas.style.position = "absolute";
      m.getPane("strikes").appendChild(this._canvas);
      m.on("move resize zoomend viewreset", this.redraw, this);
      m.on("zoomstart", this._hide, this);
      this._raf = null;
      this.redraw();
    },
    onRemove(m) {
      m.off("move resize zoomend viewreset", this.redraw, this);
      m.off("zoomstart", this._hide, this);
      this._canvas.remove();
    },
    _hide() { this._canvas.style.visibility = "hidden"; },
    redraw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this._draw(); });
    },
    _draw() {
      const m = this._map;
      if (!m) return;
      const size = m.getSize();
      const dpr = window.devicePixelRatio || 1;
      const c = this._canvas;
      c.style.visibility = "visible";
      if (c.width !== size.x * dpr || c.height !== size.y * dpr) {
        c.width = size.x * dpr; c.height = size.y * dpr;
        c.style.width = size.x + "px"; c.style.height = size.y + "px";
      }
      L.DomUtil.setPosition(c, m.containerPointToLayerPoint([0, 0]));
      const ctx = c.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);

      const now = Date.now();
      const minT = now - settings.historyMin * 60e3;
      const z = m.getZoom();
      const r = z <= 4 ? 1.6 : z <= 6 ? 2.6 : z <= 8 ? 3.6 : 4.6;
      const b = m.getBounds().pad(0.05);
      const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
      let fresh = false;

      // du plus ancien au plus récent pour que les récents soient au-dessus
      for (let ci = STRIKE_COLORS.length - 1; ci >= 0; ci--) {
        const maxAge = STRIKE_COLORS[ci][0];
        const minAge = ci ? STRIKE_COLORS[ci - 1][0] : 0;
        ctx.strokeStyle = STRIKE_COLORS[ci][1];
        ctx.lineWidth = ci === 0 ? 1.8 : 1.3;
        ctx.globalAlpha = ci === 4 ? 0.65 : 1;
        ctx.beginPath();
        for (let i = 0; i < strikes.length; i++) {
          const [t, lat, lon] = strikes[i];
          if (t < minT) continue;
          const age = now - t;
          if (age >= maxAge || age < minAge) continue;
          if (lat < s || lat > n) continue;
          let L2 = lon;
          if (L2 < w) L2 += 360; else if (L2 > e) L2 -= 360;
          if (L2 < w || L2 > e) continue;
          const p = m.latLngToContainerPoint([lat, L2]);
          ctx.moveTo(p.x - r, p.y); ctx.lineTo(p.x + r, p.y);
          ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x, p.y + r);
        }
        ctx.stroke();
      }
      // halo des impacts de moins de 8 secondes
      ctx.globalAlpha = 1;
      for (let i = strikes.length - 1; i >= 0; i--) {
        const [t, lat, lon] = strikes[i];
        const age = now - t;
        if (age > 8000) break;
        if (lat < s || lat > n) continue;
        const p = m.latLngToContainerPoint([lat, lon]);
        const k = age / 8000;
        ctx.strokeStyle = `rgba(255,240,150,${1 - k})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4 + k * 18, 0, Math.PI * 2);
        ctx.stroke();
        fresh = true;
      }
      if (fresh) this.redraw();
    },
  });
  const strikeLayer = new StrikeLayer();

  // index spatial (grille 0,5°) pour l'analyse de risque
  let grid = new Map();
  const CELL = 0.5;
  const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  function rebuildGrid() {
    const minT = Date.now() - 15 * 60e3;
    grid = new Map();
    for (let i = strikes.length - 1; i >= 0; i--) {
      const s = strikes[i];
      if (s[0] < minT) break;
      const k = cellKey(s[1], s[2]);
      let a = grid.get(k);
      if (!a) grid.set(k, (a = []));
      a.push(s);
    }
  }
  function strikesAround(lat, lon, km) {
    const dLat = km / 111;
    const dLon = km / (111 * Math.max(0.15, Math.cos(toRad(lat))));
    const out = [];
    for (let a = Math.floor((lat - dLat) / CELL); a <= Math.floor((lat + dLat) / CELL); a++)
      for (let o = Math.floor((lon - dLon) / CELL); o <= Math.floor((lon + dLon) / CELL); o++) {
        const c = grid.get(`${a}:${o}`);
        if (c) out.push(...c);
      }
    return out;
  }

  let rateTimes = [];
  function addStrikes(list) {
    if (!list.length) return;
    const start = strikes.length;
    for (const s of list) strikes.push(s);
    for (let i = Math.max(1, start); i < strikes.length; i++)
      if (strikes[i][0] < strikes[i - 1][0]) { strikes.sort((a, b) => a[0] - b[0]); break; }
    rateTimes.push(...list.map((s) => s[0]));
    strikeLayer.redraw();
  }
  function pruneStrikes() {
    const minT = Date.now() - 60 * 60e3;
    let i = 0;
    while (i < strikes.length && strikes[i][0] < minT) i++;
    if (i) strikes.splice(0, i);
    const minR = Date.now() - 60e3;
    rateTimes = rateTimes.filter((t) => t >= minR);
  }

  // Mode autonome (sans serveur) : connexion directe du navigateur au réseau Blitzortung
  function lzwDecode(b) {
    const dict = {}, chars = b.split("");
    let cur = chars[0], prev = cur, code = 256;
    const out = [cur];
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
  let wsIdx = 0;
  function startDirectLightning() {
    const hosts = ["ws1", "ws8", "ws2", "ws3"];
    const host = hosts[wsIdx++ % hosts.length];
    let ws, buf = [], watchdog, flush;
    const restart = () => {
      clearTimeout(watchdog); clearInterval(flush);
      setStatus("lightning", "err");
      try { ws.close(); } catch {}
      setTimeout(startDirectLightning, 3000);
    };
    const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(restart, 60000); };
    try { ws = new WebSocket(`wss://${host}.blitzortung.org/`); } catch { return setTimeout(startDirectLightning, 5000); }
    ws.onopen = () => { ws.send('{"a":111}'); setStatus("lightning", "ok"); arm(); };
    ws.onmessage = (m) => {
      arm();
      try {
        const j = JSON.parse(lzwDecode(String(m.data)));
        if (typeof j.lat === "number" && typeof j.lon === "number") buf.push([Math.round(j.time / 1e6), j.lat, j.lon]);
      } catch {}
    };
    ws.onclose = restart;
    flush = setInterval(() => { if (buf.length) { addStrikes(buf); buf = []; } }, 1000);
  }

  async function startLightning() {
    setStatus("lightning", "loading");
    if (!SERVER) return startDirectLightning();
    try {
      addStrikes(await api(`/api/lightning?since=${Date.now() - 60 * 60e3}`));
      rebuildGrid();
    } catch (e) { console.warn(e); }
    const es = new EventSource("/api/lightning/stream");
    es.onopen = () => setStatus("lightning", "ok");
    es.onerror = () => setStatus("lightning", "err");
    es.onmessage = (ev) => {
      try { addStrikes(JSON.parse(ev.data)); } catch {}
    };
  }

  // taux d'impacts dans la vue (par minute)
  setInterval(() => {
    pruneStrikes();
    const b = map.getBounds();
    const minT = Date.now() - 60e3;
    let n = 0;
    for (let i = strikes.length - 1; i >= 0 && strikes[i][0] >= minT; i--)
      if (b.contains([strikes[i][1], strikes[i][2]])) n++;
    $("#rate").textContent = n;
    strikeLayer.redraw();
  }, 2000);

  /* ================================================================ */
  /* Radar RainViewer (animé)                                          */
  /* ================================================================ */
  const radar = { frames: [], layers: {}, idx: 0, playing: false, timer: null, host: "", opacity: 0.7, on: true };
  const radarGroup = L.layerGroup();

  function radarLayer(frame) {
    if (!radar.layers[frame.path]) {
      radar.layers[frame.path] = L.tileLayer(`${radar.host}${frame.path}/256/{z}/{x}/{y}/4/1_1.png`, {
        pane: "radar",
        opacity: 0,
        maxNativeZoom: 7,
        maxZoom: 19,
        tileSize: 256,
        attribution: '<a href="https://www.rainviewer.com/" target="_blank">RainViewer</a>',
      });
    }
    return radar.layers[frame.path];
  }
  function showRadarFrame(i) {
    if (!radar.frames.length) return;
    radar.idx = (i + radar.frames.length) % radar.frames.length;
    const f = radar.frames[radar.idx];
    const lyr = radarLayer(f);
    if (!radarGroup.hasLayer(lyr)) radarGroup.addLayer(lyr);
    for (const [p, l] of Object.entries(radar.layers)) l.setOpacity(p === f.path ? radar.opacity : 0);
    // précharge l'image suivante pendant l'animation
    if (radar.playing) {
      const nx = radarLayer(radar.frames[(radar.idx + 1) % radar.frames.length]);
      if (!radarGroup.hasLayer(nx)) radarGroup.addLayer(nx);
    }
    $("#radarSlider").value = radar.idx;
    const d = new Date(f.time * 1000);
    const ago = Math.round((Date.now() - d) / 60000);
    $("#radarTime").textContent = `${fmtUTC(d)} (−${ago} min)`;
  }
  async function loadRadar() {
    setStatus("radar", "loading");
    try {
      const d = await fetch("https://api.rainviewer.com/public/weather-maps.json").then((r) => r.json());
      radar.host = d.host;
      const frames = [...(d.radar?.past || []), ...(d.radar?.nowcast || [])];
      const keep = new Set(frames.map((f) => f.path));
      for (const [p, l] of Object.entries(radar.layers))
        if (!keep.has(p)) { radarGroup.removeLayer(l); delete radar.layers[p]; }
      const wasLast = radar.idx >= radar.frames.length - 1;
      radar.frames = frames;
      $("#radarSlider").max = frames.length - 1;
      showRadarFrame(wasLast || !radar.playing ? frames.length - 1 : radar.idx);
      setStatus("radar", "ok");
    } catch (e) {
      console.warn(e);
      setStatus("radar", "err");
    }
  }
  function toggleRadarPlay(force) {
    radar.playing = force ?? !radar.playing;
    $("#radarPlay").textContent = radar.playing ? "❚❚" : "▶";
    clearInterval(radar.timer);
    if (radar.playing) {
      radar.timer = setInterval(() => {
        const last = radar.idx === radar.frames.length - 1;
        showRadarFrame(radar.idx + 1);
        if (last) { clearInterval(radar.timer); setTimeout(() => radar.playing && toggleRadarPlay(true), 1200); }
      }, 550);
    } else showRadarFrame(radar.frames.length - 1);
  }
  $("#radarPlay").addEventListener("click", () => toggleRadarPlay());
  $("#radarSlider").addEventListener("input", (e) => { toggleRadarPlay(false); showRadarFrame(+e.target.value); });
  $("#radarOpacity").addEventListener("input", (e) => { radar.opacity = +e.target.value; showRadarFrame(radar.idx); });

  /* ================================================================ */
  /* Satellite EUMETSAT (WMS)                                          */
  /* ================================================================ */
  const EUM = "https://view.eumetsat.int/geoserver/wms";
  const wms = (layers, opts = {}) =>
    L.tileLayer.wms(EUM, {
      layers, format: "image/png", transparent: true, version: "1.3.0", pane: opts.pane || "sat",
      opacity: opts.opacity ?? 0.6, attribution: '<a href="https://view.eumetsat.int" target="_blank">EUMETSAT</a>',
      tileSize: 512, maxZoom: 19,
    });
  const satLayer = L.layerGroup([wms("mumi:worldcloudmap_ir108", { opacity: 0.45 }), wms("mtg_fd:ir105_hrfi", { opacity: 0.55 })]);
  const convLayer = wms("msg_fes:rgb_convection", { opacity: 0.6 });
  const liLayer = wms("mtg_fd:li_afa", { pane: "li", opacity: 0.85 });
  setInterval(() => {
    const t = Math.floor(Date.now() / 300000);
    for (const l of [...satLayer.getLayers(), convLayer, liLayer]) if (map.hasLayer(l)) l.setParams({ _t: t });
  }, 300000);

  /* ================================================================ */
  /* SIGMET                                                            */
  /* ================================================================ */
  let sigmetData = [];
  const sigmetLayer = L.geoJSON(null, {
    pane: "sigmet",
    filter: (f) => (f.properties.convective ? layerOn.sigmet : layerOn.sigmetAll),
    style: (f) => {
      const conv = f.properties.convective;
      return {
        color: conv ? "#ff3b5c" : "#7aa2ff",
        weight: conv ? 2 : 1.5,
        dashArray: conv ? null : "6 4",
        fillColor: conv ? "#ff3b5c" : "#7aa2ff",
        fillOpacity: conv ? 0.12 : 0.06,
      };
    },
    onEachFeature: (f, l) => {
      const p = f.properties;
      const alt = p.top ? `${p.base ? fl(p.base) : "SFC"} → ${fl(p.top)}` : "";
      l.bindPopup(
        `<b>${esc(p.source)} ${esc(p.hazard || "")} ${esc(p.qualifier || "")}</b><br>` +
          `${esc(p.fir || "")} · série ${esc(p.id || "")}<br>` +
          `Validité ${p.from ? fmtUTC(new Date(p.from)) : "?"} → ${p.to ? fmtUTC(new Date(p.to)) : "?"}` +
          (alt ? `<br>Niveaux ${alt}` : "") +
          (p.dir ? `<br>Déplacement ${esc(p.dir)}${p.spd ? " " + esc(p.spd) + " kt" : ""}` : "") +
          `<pre>${esc(p.raw || "")}</pre>`,
        { maxWidth: 360 }
      );
    },
  });
  function renderSigmets() {
    sigmetLayer.clearLayers();
    sigmetLayer.addData({ type: "FeatureCollection", features: sigmetData });
  }
  async function loadSigmets() {
    if (!SERVER) return setStatus("sigmet", "off");
    setStatus("sigmet", "loading");
    try {
      const d = await api("/api/sigmets");
      const now = Date.now();
      sigmetData = d.features.filter((f) => !f.properties.to || new Date(f.properties.to) > now);
      $("#sigmetCount").textContent = sigmetData.filter((f) => f.properties.convective).length;
      renderSigmets();
      setStatus("sigmet", "ok");
    } catch (e) {
      console.warn(e);
      setStatus("sigmet", "err");
    }
  }
  function sigmetsAt(lat, lon, altFt) {
    return sigmetData.filter((f) => {
      const p = f.properties;
      if (!p.convective) return false;
      if (altFt != null && p.top && altFt > p.top + 1000) return false;
      return pointInGeom(lon, lat, f.geometry);
    });
  }

  /* ================================================================ */
  /* METAR & PIREP                                                     */
  /* ================================================================ */
  const TS_SVG = '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>';
  const FLTCAT = { VFR: "#38d39f", MVFR: "#4ea1ff", IFR: "#ff4d4d", LIFR: "#d24dff" };
  const metarLayer = L.layerGroup();
  const pirepLayer = L.layerGroup();
  let metarTs = [];

  function viewBbox() {
    const b = map.getBounds().pad(0.1);
    return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(1)).join(",");
  }

  async function loadMetars() {
    if (!SERVER) return;
    if (!layerOn.metar || map.getZoom() < 5) { metarLayer.clearLayers(); return; }
    try {
      const d = await api(`/api/metars?bbox=${viewBbox()}`);
      metarLayer.clearLayers();
      metarTs = [];
      for (const f of d.features) {
        const p = f.properties;
        const [lon, lat] = f.geometry.coordinates;
        const z = map.getZoom();
        if (!p.ts && !p.cb && z < 7) continue; // à faible zoom : seulement les stations orageuses
        let icon;
        if (p.ts) {
          icon = L.divIcon({ className: "metar-ts", html: TS_SVG, iconSize: [22, 22] });
          metarTs.push(p);
        } else {
          const c = p.cb ? "#ffb020" : FLTCAT[p.fltcat] || "#8b98b5";
          icon = L.divIcon({ className: "", html: `<div class="metar-dot" style="background:${c}"></div>`, iconSize: [12, 12] });
        }
        L.marker([lat, lon], { icon, pane: "sigmet", zIndexOffset: p.ts ? 500 : 0 })
          .bindPopup(
            `<b>${esc(p.id)}</b> ${p.ts ? "⚡ <b style='color:#ffd23f'>Orage</b>" : p.cb ? "· CB/TCU signalés" : ""}<br>` +
              `<span class="muted">${esc(p.site || "")}</span><br>` +
              `${p.time ? fmtUTC(new Date(p.time)) : ""} · ${esc(p.fltcat || "")}` +
              `<pre>${esc(p.raw)}</pre>`
          )
          .addTo(metarLayer);
      }
    } catch (e) { console.warn(e); }
  }

  async function loadPireps() {
    if (!SERVER) return;
    if (!layerOn.pirep || map.getZoom() < 4) { pirepLayer.clearLayers(); return; }
    try {
      const d = await api(`/api/pireps?bbox=${viewBbox()}`);
      pirepLayer.clearLayers();
      for (const f of d.features) {
        const p = f.properties;
        if (!f.geometry) continue;
        const [lon, lat] = f.geometry.coordinates;
        const sev = /SEV|EXTRM/.test(p.tb || "") ? "#ff3b5c" : /MOD/.test(p.tb || "") ? "#ffb020" : p.tb ? "#9fd3ff" : "#8b98b5";
        L.circleMarker([lat, lon], { radius: 5, color: "#000", weight: 1, fillColor: sev, fillOpacity: 0.95, pane: "sigmet" })
          .bindPopup(
            `<b>${esc(p.type || "PIREP")}</b> ${esc(p.ac || "")} · FL${esc(p.fl ?? "?")}<br>` +
              (p.tb ? `Turbulence : <b>${esc(p.tb)}</b><br>` : "") +
              (p.ic ? `Givrage : <b>${esc(p.ic)}</b><br>` : "") +
              `${p.time ? fmtUTC(new Date(p.time)) : ""}<pre>${esc(p.raw)}</pre>`
          )
          .addTo(pirepLayer);
      }
    } catch (e) { console.warn(e); }
  }

  /* ================================================================ */
  /* Trafic aérien + analyse d'exposition                              */
  /* ================================================================ */
  const acLayer = L.layerGroup();
  const trackLayer = L.layerGroup().addTo(map);
  const aircraft = new Map(); // id -> {data, marker, t0, risk}
  let selectedId = null;
  const LEVEL_COLORS = ["#38d39f", "#7cc4ff", "#ffb020", "#ff3b5c"];
  const LEVEL_TXT = ["RAS", "Activité au loin", "Orage proche", "Orage sur la route"];
  const PLANE_PATH = "M12 2c.8 0 1.3.9 1.3 2v5.2l7.7 4.6v2l-7.7-2.3v4.9l2.2 1.7V22L12 21l-3.5 1v-1.9l2.2-1.7v-4.9L3 15.8v-2l7.7-4.6V4c0-1.1.5-2 1.3-2z";

  function assess(a) {
    if (a.gnd) return { level: 0, nearest: null, ahead: null, n20: 0, n50: 0, n100: 0, sig: [] };
    const near = strikesAround(a.lat, a.lon, 160);
    let nearest = null, ahead = null, n20 = 0, n50 = 0, n100 = 0, nearestBrg = null;
    for (const s of near) {
      const d = distKm(a.lat, a.lon, s[1], s[2]);
      if (d > 160) continue;
      if (d <= 20) n20++;
      if (d <= 50) n50++;
      if (d <= 100) n100++;
      if (nearest == null || d < nearest) { nearest = d; nearestBrg = bearing(a.lat, a.lon, s[1], s[2]); }
      if (a.trk != null && d <= 150 && angDiff(bearing(a.lat, a.lon, s[1], s[2]), a.trk) <= 30 && (ahead == null || d < ahead)) ahead = d;
    }
    const sig = sigmetsAt(a.lat, a.lon, a.alt);
    let level = 0;
    if (nearest != null && nearest <= 150) level = 1;
    if ((nearest != null && nearest <= 50) || (ahead != null && ahead <= 100) || sig.length) level = 2;
    if (n20 >= 1 || (ahead != null && ahead <= 40 && n50 >= 3)) level = 3;
    return { level, nearest, nearestBrg, ahead, n20, n50, n100, sig };
  }

  function planeIcon(a, risk, sel) {
    const c = LEVEL_COLORS[risk.level];
    const rot = a.trk ?? 0;
    return L.divIcon({
      className: `ac-icon lvl${risk.level}${sel ? " sel" : ""}${a.gnd ? " gnd" : ""}`,
      html: `<svg viewBox="0 0 24 24" style="transform:rotate(${rot}deg)"><path d="${PLANE_PATH}" fill="${c}" stroke="#05080f" stroke-width="1"/></svg><span class="lbl">${esc(a.cs)}</span>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }

  function visibleAircraft() {
    return [...aircraft.values()].filter((o) => !o.data.gnd && (o.data.alt ?? 0) >= settings.minAlt);
  }

  let acSource = "";
  async function loadAircraft() {
    if (!SERVER) return setStatus("aircraft", "off");
    if (!layerOn.aircraft) return;
    const z = map.getZoom();
    if (z < 5) {
      showHint("Zoomez pour afficher le trafic aérien");
      return;
    }
    const c = map.getCenter();
    const ne = map.getBounds().getNorthEast();
    const distNm = Math.min(250, distKm(c.lat, c.lng, ne.lat, ne.lng) / KM_PER_NM);
    showHint(distNm >= 250 && z < 7 ? "Trafic affiché dans un rayon de 250 NM autour du centre" : "");
    setStatus("aircraft", "loading");
    try {
      const d = await api(`/api/aircraft?lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&dist=${Math.ceil(distNm)}`);
      acSource = d.source;
      const now = Date.now();
      const seen = new Set();
      for (const a of d.aircraft) {
        seen.add(a.id);
        let o = aircraft.get(a.id);
        if (!o) {
          o = { data: a, t0: now, marker: null, risk: null };
          aircraft.set(a.id, o);
        }
        o.data = a; o.t0 = now;
      }
      for (const [id, o] of aircraft)
        if (!seen.has(id) && id !== selectedId) { o.marker && acLayer.removeLayer(o.marker); aircraft.delete(id); }
      setStatus("aircraft", "ok");
      refreshAircraft(true);
    } catch (e) {
      console.warn(e);
      setStatus("aircraft", "err");
    }
  }

  // extrapolation des positions entre deux rafraîchissements
  function extrapolate(o) {
    const a = o.data;
    if (a.gnd || !a.gs || a.trk == null) return [a.lat, a.lon];
    const dt = Math.min(60, (Date.now() - o.t0) / 1000);
    return destination(a.lat, a.lon, a.trk, (a.gs * KM_PER_NM * dt) / 3600);
  }

  function refreshAircraft(full) {
    if (full) rebuildGrid();
    let exposed = [];
    for (const o of aircraft.values()) {
      const a = o.data;
      const show = layerOn.aircraft && (a.alt ?? 0) >= settings.minAlt && !a.gnd || o.data.id === selectedId;
      const pos = extrapolate(o);
      if (full || !o.risk) {
        const prev = o.risk?.level;
        o.risk = assess({ ...a, lat: pos[0], lon: pos[1] });
        o.iconDirty = prev !== o.risk.level || o.trk !== a.trk;
        o.trk = a.trk;
      }
      if (!show) {
        if (o.marker) { acLayer.removeLayer(o.marker); o.marker = null; }
        continue;
      }
      if (!o.marker) {
        o.marker = L.marker(pos, { icon: planeIcon(a, o.risk, a.id === selectedId), pane: "aircraft", keyboard: false })
          .on("click", () => selectAircraft(a.id));
        o.marker.bindTooltip(() => `${esc(o.data.cs)} · ${fl(o.data.alt)}`, { direction: "top", offset: [0, -10] });
        acLayer.addLayer(o.marker);
      } else {
        o.marker.setLatLng(pos);
        if (o.iconDirty) { o.marker.setIcon(planeIcon(a, o.risk, a.id === selectedId)); o.iconDirty = false; }
      }
      if (o.risk.level >= 2) exposed.push(o);
    }
    $("#acCount").textContent = visibleAircraft().length;
    const inView = exposed.filter((o) => map.getBounds().contains(o.marker.getLatLng()));
    $("#alertCount").textContent = inView.length;
    $("#alertPill").classList.toggle("hot", inView.some((o) => o.risk.level === 3));
    if (full) renderAlerts();
    if (selectedId) renderSelected(false);
  }
  setInterval(() => refreshAircraft(false), 1000);

  function renderAlerts() {
    const b = map.getBounds();
    const list = visibleAircraft()
      .filter((o) => o.risk && o.risk.level >= 1 && o.marker && b.contains(o.marker.getLatLng()))
      .sort((x, y) => y.risk.level - x.risk.level || (x.risk.ahead ?? x.risk.nearest ?? 999) - (y.risk.ahead ?? y.risk.nearest ?? 999));
    const el = $("#alertList");
    if (!list.length) {
      el.innerHTML = `<p class="muted">Aucun vol exposé dans la zone affichée${map.getZoom() < 5 ? " (zoomez pour charger le trafic)" : ""}.</p>`;
      return;
    }
    el.innerHTML = list
      .slice(0, 80)
      .map((o) => {
        const r = o.risk, a = o.data;
        const info = r.ahead != null ? `orage à ${Math.round(r.ahead / KM_PER_NM)} NM devant` : r.nearest != null ? `orage à ${Math.round(r.nearest / KM_PER_NM)} NM` : "";
        return `<div class="item" data-id="${esc(a.id)}"><span class="cs">${esc(a.cs)}</span><span class="meta">${fl(a.alt)} · ${esc(a.type || "")}<br>${info}${r.sig.length ? " · SIGMET" : ""}</span><span class="badge l${r.level}">${LEVEL_TXT[r.level]}</span></div>`;
      })
      .join("");
  }
  $("#alertList").addEventListener("click", (e) => {
    const it = e.target.closest(".item");
    if (it) selectAircraft(it.dataset.id, true);
  });
  $("#alertPill").addEventListener("click", () => openTab("alerts"));

  /* ---------- Vol sélectionné ---------- */
  const wxCache = new Map();
  async function convectiveWx(lat, lon) {
    const k = `${lat.toFixed(1)}:${lon.toFixed(1)}`;
    const hit = wxCache.get(k);
    if (hit && Date.now() - hit.t < 10 * 60e3) return hit.v;
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}` +
      `&hourly=cape,lifted_index,freezing_level_height,convective_inhibition,precipitation` +
      `&forecast_hours=4&past_hours=1&timezone=GMT`;
    const d = await fetch(url).then((r) => r.json());
    const h = d.hourly || {};
    const now = new Date().toISOString().substr(0, 13);
    let i = (h.time || []).findIndex((t) => t.startsWith(now));
    if (i < 0) i = 0;
    const pick = (n) => (h[n] ? h[n][i] : null);
    const maxNext = (n) => (h[n] ? Math.max(...h[n].slice(i, i + 4).filter((v) => v != null)) : null);
    const v = {
      cape: pick("cape"), capeMax: maxNext("cape"),
      li: pick("lifted_index"),
      fzl: pick("freezing_level_height"), cin: pick("convective_inhibition"),
      precip: pick("precipitation"),
    };
    wxCache.set(k, { t: Date.now(), v });
    return v;
  }
  function capeTxt(c) {
    if (c == null) return "–";
    if (c < 300) return `${Math.round(c)} J/kg · faible`;
    if (c < 1000) return `${Math.round(c)} J/kg · modérée`;
    if (c < 2500) return `${Math.round(c)} J/kg · forte`;
    return `${Math.round(c)} J/kg · extrême`;
  }
  function wxHTML(w) {
    if (!w) return `<p class="muted">Chargement de l'analyse convective…</p>`;
    const pct = Math.min(100, ((w.capeMax ?? w.cape ?? 0) / 3000) * 100);
    return `<div class="grid">
        <div class="kv"><span>CAPE actuelle</span><b>${capeTxt(w.cape)}</b></div>
        <div class="kv"><span>CAPE max (3 h)</span><b>${w.capeMax != null && isFinite(w.capeMax) ? Math.round(w.capeMax) + " J/kg" : "–"}</b></div>
        <div class="kv"><span>Lifted Index</span><b>${w.li != null ? (w.li > 0 ? "+" : "") + w.li.toFixed(1) + (w.li <= -6 ? " · très instable" : w.li <= -3 ? " · instable" : w.li < 0 ? " · peu instable" : " · stable") : "–"}</b></div>
        <div class="kv"><span>Isotherme 0 °C</span><b>${w.fzl != null ? fl(w.fzl * 3.28084) : "–"}</b></div>
      </div><div class="bar" title="Instabilité"><i style="width:${pct}%"></i></div>`;
  }

  let selWx = null;
  function selectAircraft(id, fly) {
    const prev = aircraft.get(selectedId);
    selectedId = id;
    if (prev?.marker) prev.marker.setIcon(planeIcon(prev.data, prev.risk, false));
    const o = aircraft.get(id);
    if (!o) return;
    if (o.marker) o.marker.setIcon(planeIcon(o.data, o.risk, true));
    if (fly && o.marker) map.flyTo(o.marker.getLatLng(), Math.max(map.getZoom(), 7), { duration: 0.8 });
    openTab("flight");
    selWx = null;
    const [lat, lon] = extrapolate(o);
    convectiveWx(lat, lon).then((w) => { if (selectedId === id) { selWx = w; renderSelected(true); } }).catch(() => {});
    renderSelected(true);
  }

  function drawTrack(o, pos) {
    trackLayer.clearLayers();
    const a = o.data;
    if (a.trk == null || !a.gs || a.gnd) return;
    const km15 = (a.gs * KM_PER_NM * 15) / 60;
    const end = destination(pos[0], pos[1], a.trk, km15);
    const c = LEVEL_COLORS[o.risk.level];
    // cône de surveillance ±30° sur 150 km
    const cone = [pos];
    for (let b = -30; b <= 30; b += 5) cone.push(destination(pos[0], pos[1], a.trk + b, 150));
    L.polygon(cone, { pane: "track", color: c, weight: 1, opacity: 0.6, fillOpacity: 0.07, dashArray: "3 5", interactive: false }).addTo(trackLayer);
    L.polyline([pos, end], { pane: "track", color: "#fff", weight: 2, dashArray: "6 6", interactive: false }).addTo(trackLayer);
    L.circleMarker(end, { pane: "track", radius: 3, color: "#fff", interactive: false })
      .bindTooltip("+15 min", { permanent: true, direction: "right", className: "" })
      .addTo(trackLayer);
    for (const km of [20 * KM_PER_NM, 50 * KM_PER_NM])
      L.circle(pos, { pane: "track", radius: km * 1000, color: "#ffffff", weight: 1, opacity: 0.25, fill: false, interactive: false }).addTo(trackLayer);
  }

  function renderSelected(redrawAll) {
    const o = aircraft.get(selectedId);
    const el = $("#flightDetail");
    if (!o) return;
    const a = o.data, r = o.risk || assess(a);
    const pos = extrapolate(o);
    drawTrack(o, pos);
    if (!redrawAll && !$("#flightDetail .card")) redrawAll = true;
    const nm = (km) => (km == null ? "–" : `${Math.round(km / KM_PER_NM)} NM`);
    const eta = r.ahead != null && a.gs ? Math.max(0, Math.round((r.ahead / KM_PER_NM / a.gs) * 60)) : null;
    let msg;
    switch (r.level) {
      case 3: msg = `Activité électrique <b>à moins de 10 NM</b> ou cellule active droit devant${eta != null ? ` (≈ ${eta} min)` : ""}.`; break;
      case 2: msg = r.sig.length ? `Vol à l'intérieur d'un <b>SIGMET convectif</b>${r.sig[0].properties.top ? ` (sommets ${fl(r.sig[0].properties.top)})` : ""}.` : r.ahead != null ? `Orage à ${nm(r.ahead)} sur la route (±30°).` : `Orage à ${nm(r.nearest)}, hors de la route.`; break;
      case 1: msg = `Activité orageuse dans un rayon de 80 NM, hors de la route.`; break;
      default: msg = "Aucun impact de foudre détecté dans un rayon de 80 NM sur les 15 dernières minutes.";
    }
    const html = `
      <div class="card">
        <h2>${esc(a.cs)} <span class="badge l${r.level}">${LEVEL_TXT[r.level]}</span></h2>
        <div class="muted small">${esc([a.type, a.reg, a.id?.toUpperCase()].filter(Boolean).join(" · "))} · source ${esc(acSource)}</div>
      </div>
      <div class="card">
        <h3>Paramètres de vol</h3>
        <div class="grid">
          <div class="kv"><span>Niveau</span><b>${fl(a.alt)}</b></div>
          <div class="kv"><span>Vitesse sol</span><b>${a.gs != null ? Math.round(a.gs) + " kt" : "–"}</b></div>
          <div class="kv"><span>Route</span><b>${a.trk != null ? Math.round(a.trk) + "°" : "–"}</b></div>
          <div class="kv"><span>Vario</span><b>${a.vs != null ? (a.vs > 0 ? "+" : "") + Math.round(a.vs) + " ft/min" : "–"}</b></div>
          <div class="kv"><span>Position</span><b>${pos[0].toFixed(2)}, ${pos[1].toFixed(2)}</b></div>
          <div class="kv"><span>Transpondeur</span><b>${esc(a.sq || "–")}</b></div>
        </div>
      </div>
      <div class="card risk" style="--c:${LEVEL_COLORS[r.level]}">
        <h3>Exposition orageuse (15 dernières min)</h3>
        <div class="grid">
          <div class="kv"><span>Impact le plus proche</span><b>${nm(r.nearest)}${r.nearestBrg != null ? " " + cardinal(r.nearestBrg) : ""}</b></div>
          <div class="kv"><span>Sur la route (±30°)</span><b>${nm(r.ahead)}${eta != null ? ` · ${eta} min` : ""}</b></div>
          <div class="kv"><span>Impacts &lt; 20 NM</span><b>${strikesWithin(pos, 20)}</b></div>
          <div class="kv"><span>Impacts &lt; 50 NM</span><b>${strikesWithin(pos, 50)}</b></div>
        </div>
        <p>${msg}</p>
      </div>
      <div class="card">
        <h3>Analyse convective au point (Open-Meteo)</h3>
        <div id="wxBox">${wxHTML(selWx)}</div>
      </div>
      <div class="row">
        <button class="btn" id="btnFollow">${follow ? "Ne plus suivre" : "Suivre l'avion"}</button>
        <button class="btn" id="btnClose">Fermer</button>
      </div>`;
    if (redrawAll) el.innerHTML = html;
    else {
      // mise à jour légère : on remplace seulement les cartes dynamiques
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      const cards = $$(".card", el), nc = $$(".card", tmp);
      for (let i = 0; i < 3; i++) if (cards[i] && nc[i]) cards[i].innerHTML = nc[i].innerHTML;
    }
    if (follow) map.panTo(pos, { animate: true, duration: 0.5 });
  }
  function strikesWithin(pos, nmR) {
    const km = nmR * KM_PER_NM;
    return strikesAround(pos[0], pos[1], km).filter((s) => distKm(pos[0], pos[1], s[1], s[2]) <= km).length;
  }
  let follow = false;
  $("#flightDetail").addEventListener("click", (e) => {
    if (e.target.id === "btnFollow") { follow = !follow; renderSelected(true); }
    if (e.target.id === "btnClose") clearSelection();
  });
  function clearSelection() {
    const o = aircraft.get(selectedId);
    selectedId = null;
    follow = false;
    if (o?.marker) o.marker.setIcon(planeIcon(o.data, o.risk, false));
    trackLayer.clearLayers();
    $("#flightDetail").innerHTML = `<p class="muted">Cliquez sur un avion pour analyser son exposition.</p>`;
  }

  // Recherche par indicatif
  $("#search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toUpperCase();
    const el = $("#searchResults");
    if (q.length < 2) { el.innerHTML = ""; return; }
    const res = [...aircraft.values()].filter((o) => (o.data.cs || "").toUpperCase().includes(q) || (o.data.reg || "").toUpperCase().includes(q)).slice(0, 12);
    el.innerHTML = res.length
      ? res.map((o) => `<div class="item" data-id="${esc(o.data.id)}"><span class="cs">${esc(o.data.cs)}</span><span class="meta">${fl(o.data.alt)} · ${esc(o.data.type || "")}</span><span class="badge l${o.risk?.level ?? 0}">${LEVEL_TXT[o.risk?.level ?? 0]}</span></div>`).join("")
      : `<p class="muted small">Aucun vol trouvé dans la zone chargée.</p>`;
  });
  $("#searchResults").addEventListener("click", (e) => {
    const it = e.target.closest(".item");
    if (it) { selectAircraft(it.dataset.id, true); $("#searchResults").innerHTML = ""; $("#search").value = ""; }
  });

  /* ---------- Clic sur la carte : analyse du point ---------- */
  map.on("click", async (e) => {
    const { lat, lng } = e.latlng.wrap();
    const pos = [lat, lng];
    const n20 = strikesWithin(pos, 20), n50 = strikesWithin(pos, 50);
    const sig = sigmetsAt(lat, lng, null);
    const pop = L.popup({ maxWidth: 300 })
      .setLatLng(e.latlng)
      .setContent(`<b>${lat.toFixed(2)}, ${lng.toFixed(2)}</b><br>Impacts (15 min) : ${n20} à &lt;20 NM · ${n50} à &lt;50 NM` + (sig.length ? `<br><b style="color:#ff3b5c">Dans ${sig.length} SIGMET convectif(s)</b>` : "") + `<div id="ptWx" style="margin-top:8px">${wxHTML(null)}</div>`)
      .openOn(map);
    try {
      const w = await convectiveWx(lat, lng);
      const box = pop.getElement()?.querySelector("#ptWx");
      if (box) box.innerHTML = wxHTML(w);
    } catch {}
  });

  /* ================================================================ */
  /* Couches & réglages                                                */
  /* ================================================================ */
  const layerOn = {};
  const LAYERS = {
    strikes: strikeLayer,
    radar: radarGroup,
    sat: satLayer,
    convection: convLayer,
    li: liLayer,
    sigmet: sigmetLayer,
    sigmetAll: null,
    metar: metarLayer,
    pirep: pirepLayer,
    aircraft: acLayer,
    labels: null,
  };
  function applyLayer(name, on) {
    layerOn[name] = on;
    try { localStorage.setItem("oev:layers", JSON.stringify(layerOn)); } catch {}
    const l = LAYERS[name];
    if (name === "sigmet" || name === "sigmetAll") {
      renderSigmets();
      if (layerOn.sigmet || layerOn.sigmetAll) sigmetLayer.addTo(map); else map.removeLayer(sigmetLayer);
      return;
    }
    if (name === "labels") { map.getContainer().classList.toggle("show-labels", on); return; }
    if (l) on ? l.addTo(map) : map.removeLayer(l);
    if (name === "metar") loadMetars();
    if (name === "pirep") loadPireps();
    if (name === "aircraft") { if (on) loadAircraft(); refreshAircraft(false); }
    if (name === "radar") $("#radarBar").style.display = on ? "" : "none";
  }
  const storedLayers = (() => { try { return JSON.parse(localStorage.getItem("oev:layers") || "{}"); } catch { return {}; } })();
  for (const cb of $$("input[data-layer]")) {
    if (cb.dataset.layer in storedLayers) cb.checked = storedLayers[cb.dataset.layer];
    layerOn[cb.dataset.layer] = cb.checked;
    cb.addEventListener("change", () => applyLayer(cb.dataset.layer, cb.checked));
  }

  $("#historySel").addEventListener("change", (e) => { settings.historyMin = +e.target.value; strikeLayer.redraw(); });
  $("#minAltSel").addEventListener("change", (e) => { settings.minAlt = +e.target.value; refreshAircraft(true); });

  // Onglets
  function openTab(name) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $$(".tab-body").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $("#panel").classList.add("open");
  }
  $$(".tab").forEach((t) => t.addEventListener("click", () => openTab(t.dataset.tab)));
  $("#panelToggle").addEventListener("click", () => $("#panel").classList.toggle("open"));

  // Horloge UTC
  setInterval(() => { $("#clock").textContent = new Date().toISOString().substr(11, 8) + " UTC"; }, 1000);

  /* ================================================================ */
  /* Démarrage & rafraîchissements                                     */
  /* ================================================================ */
  let SERVER = false;
  for (const name of Object.keys(LAYERS)) applyLayer(name, layerOn[name]);
  loadRadar();
  (async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      SERVER = r.ok && (r.headers.get("content-type") || "").includes("json");
    } catch { SERVER = false; }
    if (!SERVER) {
      document.body.classList.add("standalone");
      $("#standaloneNote").hidden = false;
      if (layerOn.aircraft || layerOn.sigmet) { /* calques sans source en mode autonome */ }
    }
    startLightning();
    loadSigmets();
    loadAircraft(); loadMetars(); loadPireps();
  })();

  let moveTimer;
  map.on("moveend", () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { loadAircraft(); loadMetars(); loadPireps(); renderAlerts(); }, 400);
  });
  map.on("zoomend", () => { if (map.getZoom() < 5) { showHint("Zoomez pour afficher le trafic aérien"); for (const o of aircraft.values()) if (o.marker) { acLayer.removeLayer(o.marker); o.marker = null; } aircraft.clear(); } });

  setInterval(loadAircraft, 10000);
  setInterval(loadRadar, 5 * 60e3);
  setInterval(loadSigmets, 2 * 60e3);
  setInterval(() => { loadMetars(); loadPireps(); }, 5 * 60e3);
  setInterval(() => refreshAircraft(true), 5000);
})();
