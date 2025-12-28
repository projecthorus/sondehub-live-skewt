const API_BASE = "https://api.v2.sondehub.org";
const WS_URL = "wss://ws-reader.v2.sondehub.org/";
const LIVE_EVERY = 30; // refresh chart every N live packets. Noting that this includes duplicates
const DEFAULT_SITE = "94672"; // Adelaide Airport. Replace with Gawler once that's operational
const DECIMATE_FACTOR = 25;
const ASCENT_RATE_CUTOFF = 3.5;

const state = {
  sites: [],
  siteId: null,
  siteMeta: null,
  sondes: [],
  sondeId: null,
  serial: null,
  range: 43200,
  telemetry: new Map(),
  mqtt: null,
  liveCount: 0,
  skewt: null,
  latestFrame: null,
  selectedConvTemp: null,
  descentCutoff: null
};

// Could probably do this using toISOString, and some replacement.
function formatUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}Z`;
}

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const logEl = $("log");
  const time = formatUtc(new Date());
  const line = document.createElement("div");
  line.textContent = "[" + time + "] " + msg;
  logEl.prepend(line);
};

function setStatus(text, kind = "info") {
  $("statusText").textContent = text;
  const pill = $("livePill");
  pill.className = "pill";
  if (kind === "live") pill.classList.add("live"), pill.textContent = "Live";
  else if (kind === "error") pill.classList.add("error"), pill.textContent = "Error";
  else pill.textContent = "Idle";
}

function pressureFromAltitude(altMeters) {
  const g0 = 9.80665, M = 0.0289644, R = 8.3144598, L = 0.0065, T0 = 288.15, P0 = 1013.25;
  const h = Math.max(altMeters, -50);
  return P0 * Math.pow(1 - (L * h) / T0, (g0 * M) / (R * L));
}

function altitudeFromPressure(pressure) {
  const g0 = 9.80665, M = 0.0289644, R = 8.3144598, L = 0.0065, T0 = 288.15, P0 = 1013.25;
  if (!Number.isFinite(pressure) || pressure <= 0) return null;
  const ratio = Math.pow(pressure / P0, (R * L) / (g0 * M));
  return (T0 / L) * (1 - ratio);
}

function dewpointFromRh(tempC, rh) {
  if (rh == null || rh <= 0) return null;
  const a = 17.27, b = 237.7;
  const alpha = Math.log(rh / 100) + (a * tempC) / (b + tempC);
  return (b * alpha) / (a - alpha);
}

// Work out if this sonde is within one of the synoptic periods and display that in the sonde list.
// We still add the time of the packet in case there are multiple sondes launched in the same period.
function formatFirstPacketLabel(ts) {
  if (!ts) return "unknown";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60;
  const dateForLabel = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const synHours = [0, 6, 12, 18];
  let closest = null;
  let minDist = Infinity;
  for (const syn of synHours) {
    const dist = Math.abs(hours - syn);
    const wrapDist = Math.min(dist, 24 - dist);
    if (wrapDist < minDist) {
      minDist = wrapDist;
      closest = syn;
    }
  }
  const inSynWindow = closest !== null && minDist <= 3;
  if (inSynWindow && closest === 0 && (24 - hours) <= 3) {
    // Launches just before 00Z belong to the next day's 00Z synoptic period
    dateForLabel.setUTCDate(dateForLabel.getUTCDate() + 1);
  }
  const y = dateForLabel.getUTCFullYear();
  const m = String(dateForLabel.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dateForLabel.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const datePart = `${y}-${m}-${day}`;
  const timePart = `${hh}:${mm}Z`;
  if (inSynWindow) {
    const synLabel = String(closest).padStart(2, "0") + "Z";
    return `${datePart} ${synLabel} (${timePart})`;
  }
  return `${datePart} ${timePart}`;
}

function satVaporPressure(tempC) {
  return 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
}

function mixingRatio(pressure, dewpointC) {
  const e = satVaporPressure(dewpointC);
  return 0.622 * e / Math.max(pressure - e, 1e-6);
}

function lclPressure(tempC, dewpointC, pressure) {
  const t = tempC + 273.15;
  const td = dewpointC + 273.15;
  const tlcl = 1 / (1 / (td - 56) + Math.log(t / td) / 800) + 56; // Bolton 1980, Kelvin
  return pressure * Math.pow(tlcl / t, 1 / 0.286);
}

function thetaE(tempC, dewpointC, pressure) {
  const t = tempC + 273.15;
  const td = dewpointC + 273.15;
  const w = mixingRatio(pressure, dewpointC);
  const tlcl = 1 / (1 / (td - 56) + Math.log(t / td) / 800) + 56;
  const theta = t * Math.pow(1000 / pressure, 0.286);
  return theta * Math.exp((3.376 / tlcl - 0.00254) * w * 1000 * (1 + 0.81 * w));
}

function parcelTempFromThetaE(thetae, pressure) {
  // Solve for parcel temperature (C) along moist adiabat conserving theta-e
  let low = -80, high = 60;
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2;
    const teMid = thetaE(mid, mid, pressure); // approximate using Td=T on moist adiabat
    if (teMid > thetae) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

function findConvectionLevels(envFrames, parcelTempC, parcelDewC) {
  if (!envFrames.length) return null;
  const env = envFrames.slice().sort((a, b) => b.pressure - a.pressure); // high pressure (near surface) first
  const sfc = env[0];
  if (!Number.isFinite(parcelTempC) || !Number.isFinite(parcelDewC) || !Number.isFinite(sfc.pressure)) return null;
  const thetae = thetaE(parcelTempC, parcelDewC, sfc.pressure);
  const pLcl = lclPressure(parcelTempC, parcelDewC, sfc.pressure);
  let lfc = null;
  let el = null;
  for (const level of env) {
    if (!Number.isFinite(level.pressure) || !Number.isFinite(level.temp)) continue;
    if (level.pressure < pLcl) {
      const parcelT = parcelTempFromThetaE(thetae, level.pressure);
      if (lfc === null && parcelT > level.temp) {
        lfc = level;
      } else if (lfc && el === null && parcelT < level.temp) {
        el = level;
        break;
      }
    }
  }
  return { pLcl, lfc, el, surface: sfc };
}

function normalizeFrame(raw) {
  const key = raw.frame;
  if (!key) return null;

  // Extract time, and discard anything newer than our descent cutoff (if we have one)
  const tsStr = raw.datetime;
  const ts = tsStr ? new Date(tsStr).getTime() : null;
  if (state.descentCutoff && ts && ts > state.descentCutoff) {
    return null;
  }

  // Attempt to filter out any positions before launch based on ascent rate
  if(raw.vel_v < ASCENT_RATE_CUTOFF) return null;

  const temp = Number.isFinite(raw.temp) ? raw.temp : null;
  const humidity = Number.isFinite(raw.humidity) ? raw.humidity : null;
  const wdir = Number.isFinite(raw.heading) ? (raw.heading + 180) % 360 : null;
  const wspd = Number.isFinite(raw.vel_h) ? raw.vel_h : null;
  const pressure = Number.isFinite(raw.pressure) ? raw.pressure :
    (Number.isFinite(raw.alt) ? pressureFromAltitude(raw.alt) : null);
  
  // Some more filtering
  if (pressure == null || temp == null) return null;
  if (humidity < 0.5) return null; // This one is important! We often get 0% humidity values when we dont have all the cal data.
  if (temp < -272.0) return null;

  // Calculate dewpoint, and discard anything that results in invalid values 
  // With the humidity filter above we probably shouldn't need this anymore.
  const dewpoint = dewpointFromRh(temp, humidity);
  if (Number.isNaN(dewpoint)) return null;


  return {
    key,
    temp,
    humidity,
    dewpoint: dewpoint,
    pressure,
    altitude: raw.alt ?? null,
    datetime: raw.datetime ?? raw.time_received ?? null,
    lat: raw.lat ?? null,
    lon: raw.lon ?? null,
    frame: raw.frame ?? null,
    wdir,
    wspd,
    vel_v: raw.vel_v ?? null
  };
}

function sortFrames() {
  return Array.from(state.telemetry.values())
    .sort((a, b) => b.pressure - a.pressure);
}

function decimateFrames(frames, factor = 1) {
  if (!frames.length || factor <= 1) return frames;
  const decimated = [];
  for (let i = 0; i < frames.length; i += factor) {
    decimated.push(frames[i]);
  }
  const last = frames[frames.length - 1];
  if (decimated[decimated.length - 1] !== last) decimated.push(last);
  return decimated;
}

function updateMeta(latest) {
  const meta = $("meta");
  if (!latest) {
    meta.innerHTML = "<div><strong>—</strong>Time</div><div><strong>—</strong>Altitude</div><div><strong>—</strong>Temperature</div><div><strong>—</strong>Dewpoint</div>";
    const trackerLink = $("trackerLink");
    if (trackerLink) {
      trackerLink.href = "https://sondehub.org/";
      trackerLink.textContent = "View in SondeHub tracker";
    }
    return;
  }
  const fmtAlt = latest.altitude != null ? latest.altitude.toFixed(0) + " m" : "—";
  const fmtTime = latest.datetime ? formatUtc(new Date(latest.datetime)) : "—";
  const fmtTemp = Number.isFinite(latest.temp) ? `${latest.temp.toFixed(1)}°C` : "—";
  const fmtDew = Number.isFinite(latest.dewpoint) ? `${latest.dewpoint.toFixed(1)}°C` : "—";
    meta.innerHTML = `
      <div><strong>${fmtTime}</strong>Time</div>
      <div><strong>${fmtAlt}</strong>Altitude</div>
      <div><strong>${fmtTemp}</strong>Temperature</div>
      <div><strong>${fmtDew}</strong>Dewpoint</div>
    `;
  const trackerLink = $("trackerLink");
  if (trackerLink) {
    if (state.sondeId) {
      trackerLink.href = `https://sondehub.org/${state.sondeId}`;
      trackerLink.textContent = `View ${state.sondeId} on SondeHub tracker`;
    } else {
      trackerLink.href = "https://sondehub.org/";
      trackerLink.textContent = "View in SondeHub tracker";
    }
  }
}

function updateUrl() {
  const url = new URL(window.location);
  if (state.serial) {
    url.searchParams.set("serial", state.serial);
    url.searchParams.delete("site");
  } else {
    url.searchParams.delete("serial");
    if (state.siteId) url.searchParams.set("site", state.siteId);
    else url.searchParams.delete("site");
  }
  url.searchParams.delete("sonde");
  url.searchParams.set("last", state.range);
  const activeTab = document.querySelector(".tab-btn.active")?.getAttribute("data-tab");
  if (activeTab) url.searchParams.set("tab", activeTab);
  history.replaceState({}, "", url.toString());

  const permalink = document.getElementById("permalink");
  if (permalink) {
    permalink.href = url.toString();
  }
}

function updateControlVisibility() {
  const serialMode = Boolean(state.serial);
  const siteGroup = $("siteSelectGroup");
  const sondeGroup = $("sondeSelectGroup");
  const serialGroup = $("serialInputGroup");
  const rangeGroup = $("rangeSelectGroup");
  if (siteGroup) siteGroup.classList.toggle("hidden", serialMode);
  if (sondeGroup) sondeGroup.classList.toggle("hidden", serialMode);
  if (serialGroup) {
    serialGroup.classList.toggle("hidden", !serialMode);
    const input = $("serialInput");
    if (serialMode && input && input.value !== state.serial) {
      input.value = state.serial ?? "";
    }
  }
  if (rangeGroup) rangeGroup.classList.toggle("hidden", serialMode);
}

// ---------- Fetching ----------
async function loadSites() {
  const params = new URLSearchParams(window.location.search);
  state.range = Number(params.get("last")) || state.range;
  const rangeSelect = $("rangeSelect");
  if (rangeSelect) rangeSelect.value = String(state.range);
  const serialParam = params.get("serial");
  if (serialParam) {
    state.serial = serialParam;
    state.siteId = null;
    state.sondeId = serialParam;
    updateControlVisibility();
    setStatus(`Loading radiosonde ${serialParam}…`);
    await loadSondeHistory();
    return;
  }
  state.serial = null;
  updateControlVisibility();
  setStatus("Loading SondeHub sites…");
  const res = await fetch(API_BASE + "/sites", { headers: { "accept-encoding": "gzip" } });
  const data = await res.json();
  state.sites = Object.entries(data).map(([id, info]) => ({
    id,
    name: info.station_name || id,
    position: info.position,
    meta: info
  })).sort((a, b) => a.name.localeCompare(b.name));
  const siteSelect = $("siteSelect");
  siteSelect.innerHTML = state.sites.map(site =>
    `<option value="${site.id}">${site.name} (${site.id})</option>`).join("");
  state.siteId = params.get("site") || DEFAULT_SITE;
  siteSelect.value = state.siteId;
  setStatus("Loaded sites. Pulling latest flights…");
  await loadSondesForSite();
}

async function loadSondesForSite() {
  const site = state.siteId;
  if (!site) return;
  setStatus(`Loading sondes for site ${site}…`);
  const url = `${API_BASE}/sondes/site/${site}?last=${state.range}`;
  const res = await fetch(url);
  const data = await res.json();
  const flights = Object.entries(data || {}).map(([id, info]) => {
    const ts = info.datetime;
    return { id, ts, info };
  }).sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
  state.sondes = flights;
  const sondeSelect = $("sondeSelect");
  if (!flights.length) {
    sondeSelect.innerHTML = "<option>No sondes in range</option>";
    setStatus("No sondes found for this site in the selected window", "error");
    return;
  }
  const params = new URLSearchParams(window.location.search);
  state.sondeId = params.get("sonde") || flights[0].id;
  sondeSelect.innerHTML = flights.map(f => {
    const label = `${f.id} · ${formatFirstPacketLabel(f.ts)}`;
    return `<option value="${f.id}">${label}</option>`;
  }).join("");
  sondeSelect.value = state.sondeId;
  setStatus("Downloading sonde history…");
  await loadSondeHistory();
}

async function loadSondeHistory() {
  if (!state.sondeId) return;
  state.telemetry = new Map();
  state.descentCutoff = null;
  const url = `${API_BASE}/sonde/${state.sondeId}?last=${state.range}`;
  const res = await fetch(url);
  const data = await res.json();
  let ascent_count = 0;
  let descent_count = 0;
  for (const frame of data) {
    const tsStr = frame.datetime;
    const ts = tsStr ? new Date(tsStr).getTime() : null;
    if (state.descentCutoff && ts && ts > state.descentCutoff) {
      continue;
    }

    // Discard everything with an ascent rate below ~3.5m/s 
    if (typeof frame.vel_v !== "number" || frame.vel_v <= ASCENT_RATE_CUTOFF){
      // If we've been ascending for enough time, we can start to look for indications of a burst
      if (typeof frame.vel_v === "number" && frame.vel_v < -1 && (ascent_count > 300) && !state.descentCutoff) {
        descent_count += 1;
        
        if(descent_count > 10){
          // Probably found the burst point
          if (ts) state.descentCutoff = ts;
          // Debugging...
          //console.log("Found Descent point at " + state.descentCutoff);
          //console.log(frame);
          continue;
        }
      }
      // Otherwise, we're somewhere between descending and ascending (maybe on the ground?), so skip
      continue;
    } else {
      // Otherwise, this is probably a packet while ascending.
      ascent_count += 1;
      // Reset the descent counter.
      descent_count = 0;
    }


    const norm = normalizeFrame(frame);
    if (norm) {
      state.telemetry.set(norm.key, norm);
      state.latestFrame = norm;
    }

  }
  updateUrl();
  renderChart();
  if (state.latestFrame) updateMeta(state.latestFrame);
  maybeStartLive(data[data.length - 1]);
  if (state.telemetry.size) {
    setStatus(`History loaded (${state.telemetry.size} PTU frames)`);
  } else {
    setStatus("No PTU frames to plot for this sonde", "error");
  }
}

// ---------- Chart ----------
function ensureSkewt() {
  if (state.skewt) return state.skewt;
  if (typeof window.L === "undefined") {
    window.L = { Browser: { mobile: false }, version: "0" };
  } else if (!window.L.Browser) {
    window.L.Browser = { mobile: false };
  }
  state.skewt = new SkewT("#skewt", { gradient: 45, topp: 300 });
  updateSkewtSize();
  return state.skewt;
}

function updateSkewtSize() {
  const chart = state.skewt;
  if (!chart) return;
  const el = document.getElementById("skewt");
  if (!el) return;
  const parent = el.parentElement;
  const baseWidth = parent?.clientWidth || el.clientWidth || el.getBoundingClientRect().width || 0;
  const chartWidth = Math.max(0, baseWidth);
  const chartHeight = Math.max(420, Math.min(520, window.innerHeight - 240));
  if (chart.setParams) chart.setParams({ width: chartWidth, height: chartHeight });
}

function toSkewtSounding(frames) {
  return frames.map(frame => {
    const point = {
      press: frame.pressure,
      hght: Number.isFinite(frame.altitude) ? frame.altitude : altitudeFromPressure(frame.pressure),
      temp: frame.temp,
      dwpt: Number.isFinite(frame.dewpoint) ? frame.dewpoint : undefined
    };
    if (Number.isFinite(frame.wdir)) point.wdir = frame.wdir;
    if (Number.isFinite(frame.wspd)) point.wspd = frame.wspd;
    return point;
  }).filter(p => Number.isFinite(p.press) && Number.isFinite(p.temp));
}

function renderChart() {
  const chart = ensureSkewt();
  updateSkewtSize();
  const frames = sortFrames();
  // Only use data below 300 hPa
  const filteredFrames = frames.filter(f => Number.isFinite(f.pressure) && f.pressure >= 300);
  if (!filteredFrames.length) {
    if (chart.clear) chart.clear();
    updateMeta(null);
    setStatus("No PTU frames to plot for this sonde", "error");
    return;
  }
  const plotFrames = decimateFrames(filteredFrames, DECIMATE_FACTOR);
  const sounding = toSkewtSounding(plotFrames);
  if (!sounding.length) {
    if (chart.clear) chart.clear();
    updateMeta(null);
    setStatus("No usable PTU frames for this sonde", "error");
    return;
  }
  chart.plot(sounding, { add: false, select: true, max: 1 });
  if (chart.selectSkewt) chart.selectSkewt(sounding);
  updateMeta(state.latestFrame || frames[frames.length-1]);
  updateConvectionPlot(filteredFrames);
}

// ---------- Live feed ----------
function teardownLive() {
  if (state.mqtt) {
    try { state.mqtt.disconnect(); } catch (e) {}
    state.mqtt = null;
  }
  state.liveCount = 0;
  setStatus("Live feed idle");
}

function maybeStartLive(lastFrame) {
  teardownLive();
  if (!state.sondeId) return;
  //const climbing = lastFrame && typeof lastFrame.vel_v === "number" ? lastFrame.vel_v > -0.5 : true;
  //if (!climbing) {
  // Use the descent cutoff detection
  if(state.descentCutoff !== null){
    console.log("Not connecting to websockets, flight is descending.");
    setStatus("Flight appears to be descending or ended. Live feed paused.");
    return;
  }
  const clientId = "Live-SkewT-" + Math.floor(Math.random() * 1e9);
  const mqtt = new Paho.Client(WS_URL, clientId);
  mqtt.onConnectionLost = (error) => {setStatus("Websocket lost. Will stay on history.", "error"); console.log(error)};
  mqtt.onMessageArrived = (msg) => {
    try {
      const payload = JSON.parse(msg.payloadString);
      const norm = normalizeFrame(payload);
      if (!norm) return;
      state.telemetry.set(norm.key, norm);
      state.latestFrame = norm;
      updateMeta(norm);
      state.liveCount += 1;
      if (state.liveCount % LIVE_EVERY === 0) {
        renderChart();
        setStatus("Live updating…", "live");
      }
    } catch (err) {
      log("Parse error: " + err.message);
    }
  };
  mqtt.connect({
    useSSL: true,
    onSuccess: () => {
      mqtt.subscribe("sondes/" + state.sondeId);
      //setStatus("Live connected to sondes/" + state.sondeId, "live");
    },
    onFailure: () => setStatus("Unable to open live websocket", "error"),
    reconnect: true
  });
  state.mqtt = mqtt;
}

// ---------- UI wiring ----------
$("siteSelect").addEventListener("change", async (e) => {
  state.serial = null;
  state.siteId = e.target.value;
  updateControlVisibility();
  updateUrl();
  await loadSondesForSite();
});

$("sondeSelect").addEventListener("change", async (e) => {
  state.sondeId = e.target.value;
  updateUrl();
  await loadSondeHistory();
});

$("rangeSelect").addEventListener("change", async (e) => {
  state.range = Number(e.target.value) || 43200;
  updateUrl();
  if (state.serial) {
    await loadSondeHistory();
  } else {
    await loadSondesForSite();
  }
});

$("reloadBtn").addEventListener("click", async () => {
  setStatus("Manually refreshing…");
  if (state.serial) {
    await loadSondeHistory();
  } else {
    await loadSondesForSite();
  }
});

const serialInput = $("serialInput");
if (serialInput) {
  serialInput.addEventListener("change", async (e) => {
    const val = e.target.value.trim();
    if (!val) return;
    state.serial = val;
    state.sondeId = val;
    state.siteId = null;
    updateControlVisibility();
    updateUrl();
    setStatus(`Loading radiosonde ${val}…`);
    await loadSondeHistory();
  });
  serialInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      serialInput.dispatchEvent(new Event("change"));
    }
  });
}

window.addEventListener("load", () => {
  ensureSkewt();
  setupTabs();
  loadSites().catch(err => {
    setStatus("Failed to load SondeHub: " + err.message, "error");
    console.log(err);
    log(err.stack || err.message);
  });
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      updateSkewtSize();
      renderChart();
    }, 120);
  });
});

function setupTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  const contents = document.querySelectorAll(".tab-content");
  const params = new URLSearchParams(window.location.search);
  const defaultTab = params.get("tab");
  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-tab");
      buttons.forEach(b => b.classList.toggle("active", b === btn));
      contents.forEach(c => c.classList.toggle("active", c.id === target));
      if (history.replaceState) {
        const url = new URL(window.location);
        url.searchParams.set("tab", target);
        history.replaceState({}, "", url.toString());
      }
      if (target === "skewt-tab") {
            updateSkewtSize();
            renderChart();
      } else if (target === "conv-tab") {
        updateConvectionPlot(sortFrames().filter(f => Number.isFinite(f.pressure) && f.pressure >= 300));
      }
    });
  });
  if (defaultTab) {
    const btn = Array.from(buttons).find(b => b.getAttribute("data-tab") === defaultTab);
    if (btn) btn.click();
  }
}

function updateConvectionPlot(frames) {
  const container = document.getElementById("convPlot");
  const legend = document.getElementById("convLegend");
  if (!container) return;
  if (!frames || !frames.length) {
    container.innerHTML = "";
    if (legend) legend.textContent = "Waiting for data.";
    return;
  }

  // Default: parcel/virtual temperature intersection method.
  // const result = calcConvectionCrossings(frames);
  // Alternative: Peter Temple method, used on https://slash.dotat.org/cgi-bin/atmos
  // Going with this method, as it's what's been used by the glider pilot community for decades.
  const result = calcConvectionEstTempleCrossings(frames);

  if (!result || !result.crossings.length) {
    container.innerHTML = "";
    if (legend) legend.textContent = result?.message || "No intersection found across temperature range";
    return;
  }

  const { crossings, minTemp = 0, maxTemp = 50, maxFeet = 20000 } = result;
  const margin = { top: 12, right: 16, bottom: 30, left: 60 };
  const width = container.clientWidth - margin.left - margin.right;
  const height = 360;
  const xScale = d3.scaleLinear().domain([minTemp, maxTemp]).range([0, width]);
  const yScale = d3.scaleLinear().domain([0, maxFeet]).range([height, 0]);
  const line = d3.line()
    .x(d => xScale(d.temp))
    .y(d => yScale(d.feet));
  container.innerHTML = "";
  const svg = d3.select(container)
    .append("svg")
    .attr("width", width + margin.left + margin.right)
    .attr("height", height + margin.top + margin.bottom);
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  const tooltip = d3.select(container)
    .append("div")
    .attr("class", "conv-tooltip")
    .style("position", "absolute")
    .style("pointer-events", "none")
    .style("padding", "6px 8px")
    .style("background", "rgba(0,0,0,0.7)")
    .style("color", "#fff")
    .style("border-radius", "6px")
    .style("font-size", "12px")
    .style("display", "none");

  g.append("rect")
    .attr("x", 0).attr("y", 0)
    .attr("width", width).attr("height", height)
    .attr("fill", "none")
    .attr("stroke", "#d9e1ec");

  const xAxis = d3.axisBottom(xScale).ticks(8).tickFormat(d => `${d}°C`);
  const yAxis = d3.axisLeft(yScale).ticks(5).tickFormat(d => `${Math.round(d/100)/10}k ft`);
  const gx = g.append("g")
    .attr("transform", `translate(0,${height})`)
    .call(xAxis);
  gx.selectAll("text")
    .attr("font-size", 11)
    .attr("fill", "#666");
  g.append("g")
    .call(yAxis)
    .selectAll("text")
    .attr("font-size", 11)
    .attr("fill", "#666");

  // gridlines
  g.append("g")
    .attr("class", "grid grid-x")
    .attr("transform", `translate(0,${height})`)
    .call(d3.axisBottom(xScale)
      .ticks(8)
      .tickSize(-height)
      .tickFormat(""))
    .selectAll("line")
    .attr("stroke", "#e6edf5")
    .attr("stroke-dasharray", "2 2");

  g.append("text")
    .attr("x", width / 2)
    .attr("y", height + margin.bottom)
    .attr("text-anchor", "middle")
    .attr("fill", "#666")
    .attr("font-size", 12)
    .text("Surface temperature (°C)");

  g.append("text")
    .attr("x", -margin.left + 12)
    .attr("y", height / 2)
    .attr("text-anchor", "middle")
    .attr("transform", `rotate(-90, ${-margin.left + 12}, ${height / 2})`)
    .attr("fill", "#666")
    .attr("font-size", 12)
    .text("Altitude (ft)");

  g.append("g")
    .attr("class", "grid grid-y")
    .call(d3.axisLeft(yScale)
      .ticks(5)
      .tickSize(-width)
      .tickFormat(""))
    .selectAll("line")
    .attr("stroke", "#e6edf5")
    .attr("stroke-dasharray", "2 2");

  g.append("path")
    .datum(crossings)
    .attr("fill", "none")
    .attr("stroke", "#0a78d0")
    .attr("stroke-width", 2)
    .attr("d", line);

  const bisectTemp = d3.bisector(d => d.temp).left;
  const clampTemp = (t) => Math.max(minTemp, Math.min(maxTemp, t));
  const showTooltip = (tempVal) => {
    const t = clampTemp(tempVal);
    const idx = bisectTemp(crossings, t);
    const a = crossings[Math.max(0, Math.min(crossings.length - 1, idx - 1))];
    const b = crossings[Math.max(0, Math.min(crossings.length - 1, idx))];
    const interp = b.temp !== a.temp ? a.feet + (b.feet - a.feet) * ((t - a.temp) / (b.temp - a.temp)) : a.feet;
    const x = xScale(t);
    const y = yScale(interp);
    markerLine.attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", height).attr("stroke", "#0a78d0").attr("stroke-dasharray", "4 3").attr("opacity", 1);
    tooltip
      .style("display", "block")
      .style("left", `${margin.left + x + 12}px`)
      .style("top", `${margin.top + y - 10}px`)
      .text(`${t.toFixed(1)}°C → ${Math.round(interp)} ft`);
  };

  const markerLine = g.append("line").attr("opacity", 0);
  g.append("rect")
    .attr("fill", "transparent")
    .attr("x", 0).attr("y", 0)
    .attr("width", width).attr("height", height)
    .on("mousemove", (event) => {
      const [mx] = d3.pointer(event);
      const tempVal = xScale.invert(mx);
      if (state.selectedConvTemp == null) showTooltip(tempVal);
    })
    .on("mouseleave", () => {
      if (state.selectedConvTemp == null) {
        tooltip.style("display", "none");
        markerLine.attr("opacity", 0);
      } else {
        showTooltip(state.selectedConvTemp);
      }
    })
    .on("click", (event) => {
      const [mx] = d3.pointer(event);
      const tempVal = xScale.invert(mx);
      state.selectedConvTemp = clampTemp(tempVal);
      showTooltip(state.selectedConvTemp);
    });

  if (state.selectedConvTemp != null) {
    showTooltip(state.selectedConvTemp);
  } else {
    tooltip.style("display", "none");
    markerLine.attr("opacity", 0);
  }

  if (legend) {
    legend.textContent = "";
  }
}

function calcConvectionCrossings(frames) {
  if (!frames || !frames.length) return null;
  const getAlt = (lvl) => Number.isFinite(lvl.altitude) ? lvl.altitude : (altitudeFromPressure(lvl.pressure) || 0);
  const env = frames.slice().sort((a, b) => b.pressure - a.pressure).map(lvl => {
    const wEnv = Number.isFinite(lvl.dewpoint) ? mixingRatio(lvl.pressure, lvl.dewpoint) : 0;
    const tv = (lvl.temp + 273.15) * (1 + 0.61 * wEnv);
    return { ...lvl, tv, alt: getAlt(lvl) };
  }); // surface first
  const sfc = env[0];
  if (!Number.isFinite(sfc.temp) || !Number.isFinite(sfc.dewpoint)) {
    return { crossings: [], message: "Insufficient data for convection estimate" };
  }
  const tempMin = 0;
  const tempMax = 50;
  const crossings = [];

  for (let t = tempMin; t <= tempMax; t += 1) {
    const wSurf = mixingRatio(sfc.pressure, sfc.dewpoint);
    const thetae = thetaE(t, sfc.dewpoint, sfc.pressure);
    const pLcl = lclPressure(t, sfc.dewpoint, sfc.pressure);
    let last = null;
    let crossingFeet = null;
    for (const lvl of env) {
      const parcelTemp = lvl.pressure >= pLcl
        ? (t + 273.15) * Math.pow(lvl.pressure / sfc.pressure, 0.286) - 273.15
        : parcelTempFromThetaE(thetae, lvl.pressure);
      const wParcel = lvl.pressure >= pLcl ? wSurf : mixingRatio(lvl.pressure, parcelTemp);
      const parcelTv = (parcelTemp + 273.15) * (1 + 0.61 * wParcel);
      const diff = parcelTv - lvl.tv;
      if (last && last.diff > 0 && diff <= 0) {
        const frac = last.diff / (last.diff - diff);
        const alt = last.alt + frac * (lvl.alt - last.alt);
        crossingFeet = alt * 3.28084;
        break;
      }
      last = { diff, alt: lvl.alt };
    }
    if (crossingFeet != null) crossings.push({ temp: t, feet: crossingFeet });
  }

  return { crossings, minTemp: tempMin, maxTemp: tempMax, maxFeet: 20000 };
}

function calcConvectionEstTemple(frames) {
  if (!frames || !frames.length) return null;
  const getAlt = (lvl) => Number.isFinite(lvl.altitude) ? lvl.altitude : (altitudeFromPressure(lvl.pressure) || 0);
  const profile = frames.slice()
    .sort((a, b) => b.pressure - a.pressure)
    .map(lvl => ({
      temp: lvl.temp,
      altFt: getAlt(lvl) * 3.28084
    }))
    .filter(p => Number.isFinite(p.temp) && Number.isFinite(p.altFt));
  if (!profile.length) return null;
  const f = 0.9999955;
  const heights = Array(51).fill(0);
  let tprev = null;
  let hprev = null;
  profile.forEach((pt, idx) => {
    if (idx === 0) {
      tprev = pt.temp;
      hprev = pt.altFt;
      return;
    }
    const { temp: t, altFt: h } = pt;
    const d1 = f * (tprev + 0.003 * hprev);
    const l1 = hprev / f;
    const d2 = f * (t + 0.003 * h);
    const l2 = h / f;
    const denom = (d2 - d1);
    if (denom === 0) {
      tprev = t;
      hprev = h;
      return;
    }
    const m = (l2 - l1) / denom;
    for (let temp = 50; temp > 0; temp--) {
      const l = m * f * temp + l1 - m * d1;
      if (l >= l1 && l <= l2) {
        heights[temp] = f * l;
      }
    }
    tprev = t;
    hprev = h;
  });
  const table = heights.map((h, temp) => ({ temp, feet: h }))
    .filter(row => Number.isFinite(row.feet) && row.feet > 0 && row.feet <= 20000);
  return table;
}

function calcConvectionEstTempleCrossings(frames) {
  const table = calcConvectionEstTemple(frames);
  if (!table) return null;
  const crossings = table.filter(row => Number.isFinite(row.feet));
  return { crossings, minTemp: 0, maxTemp: 50, maxFeet: 20000 };
}
