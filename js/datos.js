// Acceso a servicios externos y caché local.
import { procesarOverpass, cfgPerfil } from './curvas.js?v=15';

export const TAM_CELDA = 0.25;   // grados
const MARGEN = 0.06;             // grados extra alrededor de cada celda
export const VERSION = 'v3'; // cambia al recalibrar para volver a analizar las carreteras
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const ORS = 'https://api.heigit.org/openrouteservice';
const PELIAS = 'https://api.heigit.org/pelias/v1';

// ---------- Ajustes (en el propio iPhone) ----------
const DEF = { clave: '', autonomia: 200, reserva: 30, peajes: true, habitual: null, casa: null, perfil: 'normal' };
export function ajustes() {
  try { return { ...DEF, ...JSON.parse(localStorage.getItem('ajustes') || '{}') }; } catch { return { ...DEF }; }
}
export function guardarAjustes(a) {
  try { localStorage.setItem('ajustes', JSON.stringify(a)); } catch {}
}

// ---------- IndexedDB mínima ----------
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('rutas-curvas', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('celdas');
        r.result.createObjectStore('favoritas', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
async function op(store, modo, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, modo);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
    tx.onerror = () => rej(tx.error);
  });
}
export const idb = {
  get: (s, k) => op(s, 'readonly', (o) => o.get(k)),
  put: (s, v, k) => op(s, 'readwrite', (o) => (k === undefined ? o.put(v) : o.put(v, k))),
  del: (s, k) => op(s, 'readwrite', (o) => o.delete(k)),
  all: (s) => op(s, 'readonly', (o) => o.getAll()),
  keys: (s) => op(s, 'readonly', (o) => o.getAllKeys()),
  clear: (s) => op(s, 'readwrite', (o) => o.clear()),
};

// ---------- Celdas de curvas ----------
export const prefijoCeldas = () => `${VERSION}:${ajustes().perfil || 'normal'}:`;
export function claveCelda(i, j) { return `${prefijoCeldas()}${i}:${j}`; }
export function celdasDe(bbox) {
  const out = [];
  const i0 = Math.floor(bbox.s / TAM_CELDA), i1 = Math.floor(bbox.n / TAM_CELDA);
  const j0 = Math.floor(bbox.w / TAM_CELDA), j1 = Math.floor(bbox.e / TAM_CELDA);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push({ i, j, clave: claveCelda(i, j) });
  return out;
}
function limites(i, j) {
  return { s: i * TAM_CELDA, n: (i + 1) * TAM_CELDA, w: j * TAM_CELDA, e: (j + 1) * TAM_CELDA };
}

// Las consultas al servidor público se hacen de una en una y con tiempo máximo,
// para no saturarlo ni quedarse esperando indefinidamente.
let colaOverpass = Promise.resolve();
function enCola(fn) {
  const p = colaOverpass.then(fn, fn);
  colaOverpass = p.catch(() => {});
  return p;
}
async function overpass(query, intentos = 2) {
  return enCola(async () => {
    let ultimo;
    for (let n = 0; n < intentos; n++) {
      for (const url of OVERPASS) {
        const ctrl = new AbortController();
        const reloj = setTimeout(() => ctrl.abort(), 75000);
        try {
          const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctrl.signal });
          if (r.ok) return await r.json();
          ultimo = new Error(`el servidor de mapas respondió ${r.status}`);
          if (r.status === 429 || r.status === 504) await espera(5000);
        } catch (e) {
          ultimo = e.name === 'AbortError' ? new Error('el servidor de mapas no ha respondido a tiempo') : e;
        } finally { clearTimeout(reloj); }
      }
    }
    throw new Error('No se pudieron descargar los datos de carreteras: ' + (ultimo?.message || 'error desconocido') + '.');
  });
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const SIN_ASFALTAR = 'unpaved|gravel|fine_gravel|dirt|earth|ground|grass|sand|mud|compacted|pebblestone|rock|wood';
let indiceP = null;
function indicePrecalculadas() {
  if (!indiceP) {
    indiceP = fetch(`data/curvas/${VERSION}/indice.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  return indiceP;
}
export function consultaCelda(i, j, cfg) {
  const c = limites(i, j);
  const b = `${(c.s - MARGEN).toFixed(3)},${(c.w - MARGEN).toFixed(3)},${(c.n + MARGEN).toFixed(3)},${(c.e + MARGEN).toFixed(3)}`;
  const tipos = 'primary|secondary|tertiary|primary_link|secondary_link|tertiary_link' + (cfg.sinClasificar ? '|unclassified' : '');
  return `[out:json][timeout:90];
way["highway"~"^(${tipos})$"]["surface"!~"^(${SIN_ASFALTAR})$"]["tracktype"!~"."]["access"!~"^(no|private)$"](${b});
out body geom qt;`;
}
export { limites };
export async function descargarCelda(i, j) {
  const perfil = ajustes().perfil || 'normal';
  const cfg = cfgPerfil(perfil);
  let tramos = null;
  // 1) Curvas precalculadas y publicadas junto a la app (Madrid y alrededores).
  const ind = await indicePrecalculadas();
  const c = limites(i, j);
  if (ind && c.s >= ind.zona.s - 1e-9 && c.n <= ind.zona.n + 1e-9 && c.w >= ind.zona.w - 1e-9 && c.e <= ind.zona.e + 1e-9) {
    try {
      const r = await fetch(`data/curvas/${VERSION}/${perfil}/${i}_${j}.json`);
      if (r.ok) tramos = (await r.json()).tramos;
    } catch { /* se calcula al vuelo */ }
  }
  // 2) Si no las hay, se calculan con el servidor público de OpenStreetMap.
  if (!tramos) tramos = procesarOverpass(await overpass(consultaCelda(i, j, cfg)), limites(i, j), cfg);
  const reg = { t: Date.now(), tramos };
  await idb.put('celdas', reg, claveCelda(i, j));
  return reg;
}

// ---------- Gasolineras ----------
export async function gasolineras(bbox) {
  const b = `${bbox.s.toFixed(3)},${bbox.w.toFixed(3)},${bbox.n.toFixed(3)},${bbox.e.toFixed(3)}`;
  const q = `[out:json][timeout:60];(node["amenity"="fuel"](${b});way["amenity"="fuel"](${b}););out center tags;`;
  const j = await overpass(q, 1);
  return (j.elements || []).map((e) => ({
    p: e.type === 'node' ? [e.lat, e.lon] : [e.center.lat, e.center.lon],
    nombre: e.tags?.brand || e.tags?.name || e.tags?.operator || 'Gasolinera',
  }));
}

// ---------- OpenRouteService ----------
function exigirClave() {
  const k = ajustes().clave.trim();
  if (!k) throw new Error('Falta tu clave de OpenRouteService. Pégala en Ajustes.');
  return k;
}
export async function ruta(puntos, { peajes = true, radios = null } = {}) {
  try {
    return await rutaUnaVez(puntos, { peajes, radios });
  } catch (e) {
    // Si el servicio no admite el radio de búsqueda ampliado, se reintenta con el normal.
    if (radios && /radius|radiuses|2003|2010/i.test(e.message)) return rutaUnaVez(puntos, { peajes, radios: null });
    throw e;
  }
}
async function rutaUnaVez(puntos, { peajes, radios }) {
  const clave = exigirClave();
  const body = {
    coordinates: puntos.map((p) => [+p[1].toFixed(6), +p[0].toFixed(6)]),
    instructions: true,
    preference: 'recommended',
  };
  if (peajes) body.options = { avoid_features: ['tollways'] };
  if (radios) body.radiuses = radios;
  let r;
  try {
    r = await fetch(`${ORS}/v2/directions/driving-car/geojson`, {
      method: 'POST',
      headers: { Authorization: clave, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('No hay conexión con el servicio de rutas. Revisa tu cobertura.');
  }
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json())?.error?.message || ''; } catch {}
    if (r.status === 403 && /quota|limit|exceed/i.test(msg)) throw new Error('Has agotado la cuota diaria de OpenRouteService. Se renueva 24 horas después de tu primera consulta del día.');
    if (r.status === 401) throw new Error('La clave de OpenRouteService no es válida. Revísala en Ajustes.');
    if (r.status === 403) throw new Error('OpenRouteService ha rechazado la consulta: o la clave no es válida o se ha agotado la cuota diaria. Puedes ver tu cuota en account.heigit.org.');
    if (/2010|routable point/i.test(msg)) throw new Error('Algún punto queda lejos de una carretera. Muévelo más cerca de una vía.');
    if (r.status === 429) throw new Error('Demasiadas consultas seguidas a OpenRouteService. Espera un minuto y vuelve a intentarlo.');
    throw new Error(`El servicio de rutas no pudo calcularla (${r.status}). ${msg}`);
  }
  const j = await r.json();
  const f = j.features[0];
  const legs = (f.properties.segments || []).map((s) => ({ distance: s.distance || 0, duration: s.duration || 0 }));
  return {
    wayPoints: f.properties.way_points || null,
    coords: f.geometry.coordinates.map((c) => [c[1], c[0]]),
    distance: f.properties.summary.distance || 0,
    duration: f.properties.summary.duration || 0,
    legs,
  };
}

// ---------- Búsqueda de lugares ----------
export async function buscarLugar(texto, cerca) {
  const k = ajustes().clave.trim();
  if (k) {
    try {
      const u = new URL(`${PELIAS}/search`);
      u.searchParams.set('api_key', k);
      u.searchParams.set('text', texto);
      u.searchParams.set('boundary.country', 'ES');
      u.searchParams.set('size', '6');
      if (cerca) { u.searchParams.set('focus.point.lat', cerca[0]); u.searchParams.set('focus.point.lon', cerca[1]); }
      const r = await fetch(u);
      if (r.ok) {
        const j = await r.json();
        const res = (j.features || []).map((f) => ({ etiqueta: f.properties.label, p: [f.geometry.coordinates[1], f.geometry.coordinates[0]] }));
        if (res.length) return res;
      }
    } catch {}
  }
  return buscarNominatim(texto);
}

// Alternativa: Nominatim (OpenStreetMap)
export async function buscarNominatim(texto) {
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('q', texto);
  u.searchParams.set('countrycodes', 'es');
  u.searchParams.set('limit', '6');
  u.searchParams.set('accept-language', 'es');
  const r = await fetch(u);
  if (!r.ok) throw new Error('No se pudo buscar el lugar.');
  const j = await r.json();
  return j.map((x) => ({ etiqueta: x.display_name, p: [+x.lat, +x.lon] }));
}
