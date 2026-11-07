// Motor de curvas: geometría, detección de tramos revirados, planificador y gasolineras.
// Funciones puras (sin DOM) para poder probarlas fuera del navegador.

export const CFG = {
  pasoRemuestreo: 10,      // metros entre puntos al remuestrear
  kRadio: 2,               // puntos a cada lado para calcular el radio (2 x 10 m)
  ventana: 50,             // puntos a cada lado en la ventana móvil (≈ 1 km total)
  umbralCurvas: 0.3,       // densidad mínima para considerar un tramo revirado
  hueco: 30,               // puntos (≈ 300 m) de recta que se toleran dentro de un tramo
  longMin: 1500,           // metros mínimos de un tramo
  nivelNaranja: 0.65,      // densidad desde la que el tramo es naranja
  nivelRojo: 1.0,          // densidad desde la que el tramo es rojo
  velNivel: { 1: 65, 2: 55, 3: 45 },   // km/h estimados en cada nivel
  pesoNivel: { 1: 1, 2: 1.7, 3: 2.5 }, // valor de cada km según nivel
};

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function dist(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function longitud(coords) {
  let t = 0;
  for (let i = 1; i < coords.length; i++) t += dist(coords[i - 1], coords[i]);
  return t;
}

export function rumbo(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Remuestrea una polilínea a puntos equiespaciados.
export function remuestrear(coords, paso) {
  if (coords.length < 2) return coords.slice();
  const out = [coords[0]];
  let resto = paso;
  for (let i = 1; i < coords.length; i++) {
    let a = coords[i - 1];
    const b = coords[i];
    let d = dist(a, b);
    while (d >= resto) {
      const f = resto / d;
      a = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      out.push(a);
      d -= resto;
      resto = paso;
    }
    resto -= d;
  }
  const ult = coords[coords.length - 1];
  if (dist(out[out.length - 1], ult) > paso * 0.3) out.push(ult);
  return out;
}

// Radio de la circunferencia que pasa por tres puntos (en metros). Infinity si están alineados.
export function radio(p1, p2, p3) {
  const lat0 = rad(p2[0]);
  const xy = (p) => [rad(p[1] - p2[1]) * R * Math.cos(lat0), rad(p[0] - p2[0]) * R];
  const [ax, ay] = xy(p1), [bx, by] = [0, 0], [cx, cy] = xy(p3);
  const a = Math.hypot(bx - cx, by - cy), b = Math.hypot(ax - cx, ay - cy), c = Math.hypot(ax - bx, ay - by);
  const area2 = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
  if (area2 < 1e-6) return Infinity;
  return (a * b * c) / (2 * area2);
}

export function pesoRadio(r) {
  if (r < 35) return 2;
  if (r < 60) return 1.5;
  if (r < 100) return 1;
  if (r < 175) return 0.6;
  return 0;
}

// Une vías de OSM que continúan una a otra (comparten extremo) en cadenas largas.
export function encadenar(ways) {
  const clave = (w) => w.tags?.ref || w.tags?.name || '';
  const porNodo = new Map();
  for (const w of ways) {
    for (const n of [w.nodes[0], w.nodes[w.nodes.length - 1]]) {
      if (!porNodo.has(n)) porNodo.set(n, []);
      porNodo.get(n).push(w);
    }
  }
  // Para cada extremo decide con qué vía continúa (si hay una continuación clara).
  const sigue = (w, nodo) => {
    const otras = (porNodo.get(nodo) || []).filter((o) => o !== w);
    if (otras.length === 1) return otras[0];
    const k = clave(w);
    if (k) {
      const mismas = otras.filter((o) => clave(o) === k);
      if (mismas.length === 1) return mismas[0];
    }
    return null;
  };
  const usada = new Set();
  const cadenas = [];
  for (const w of ways) {
    if (usada.has(w.id)) continue;
    usada.add(w.id);
    let coords = w.geometry.map((g) => [g.lat, g.lon]);
    const ids = [w.id];
    // Extiende hacia delante
    let actual = w, nodoFin = w.nodes[w.nodes.length - 1];
    for (let s = 0; s < 500; s++) {
      const n = sigue(actual, nodoFin);
      if (!n || usada.has(n.id) || sigue(n, nodoFin) !== actual) break;
      usada.add(n.id); ids.push(n.id);
      let g = n.geometry.map((x) => [x.lat, x.lon]);
      if (n.nodes[0] === nodoFin) { nodoFin = n.nodes[n.nodes.length - 1]; }
      else { g = g.reverse(); nodoFin = n.nodes[0]; }
      coords = coords.concat(g.slice(1));
      actual = n;
    }
    // Extiende hacia atrás
    actual = w; let nodoIni = w.nodes[0];
    for (let s = 0; s < 500; s++) {
      const n = sigue(actual, nodoIni);
      if (!n || usada.has(n.id) || sigue(n, nodoIni) !== actual) break;
      usada.add(n.id); ids.unshift(n.id);
      let g = n.geometry.map((x) => [x.lat, x.lon]);
      if (n.nodes[n.nodes.length - 1] === nodoIni) { nodoIni = n.nodes[0]; }
      else { g = g.reverse(); nodoIni = n.nodes[n.nodes.length - 1]; }
      coords = g.slice(0, -1).concat(coords);
      actual = n;
    }
    cadenas.push({ coords, ids, ref: w.tags?.ref || '', name: w.tags?.name || '' });
  }
  return cadenas;
}

// Detecta los tramos revirados dentro de una cadena.
export function tramosDeCadena(cadena, cfg = CFG) {
  const p = remuestrear(cadena.coords, cfg.pasoRemuestreo);
  const n = p.length;
  if (n * cfg.pasoRemuestreo < cfg.longMin) return [];
  const k = cfg.kRadio;
  const w = new Float64Array(n);
  for (let i = k; i < n - k; i++) w[i] = pesoRadio(radio(p[i - k], p[i], p[i + k]));
  const pref = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pref[i + 1] = pref[i] + w[i];
  const V = cfg.ventana;
  const marca = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - V), b = Math.min(n, i + V + 1);
    if ((pref[b] - pref[a]) / (b - a) >= cfg.umbralCurvas) marca[i] = 1;
  }
  // Rachas marcadas, uniendo huecos cortos
  const rachas = [];
  let i = 0;
  while (i < n) {
    if (!marca[i]) { i++; continue; }
    let j = i;
    while (j < n && marca[j]) j++;
    const ult = rachas[rachas.length - 1];
    if (ult && i - ult[1] <= cfg.hueco) ult[1] = j; else rachas.push([i, j]);
    i = j;
  }
  const out = [];
  for (let [a, b] of rachas) {
    while (a < b && w[a] === 0) a++;
    while (b > a && w[b - 1] === 0) b--;
    const lenM = (b - a) * cfg.pasoRemuestreo;
    if (lenM < cfg.longMin) continue;
    const dens = (pref[b] - pref[a]) / (b - a);
    if (dens < cfg.umbralCurvas) continue;
    const lvl = dens >= cfg.nivelRojo ? 3 : dens >= cfg.nivelNaranja ? 2 : 1;
    const coords = simplificar(p.slice(a, b), 8).map(([la, lo]) => [+la.toFixed(5), +lo.toFixed(5)]);
    out.push({ coords, km: lenM / 1000, dens: +dens.toFixed(3), lvl, ref: cadena.ref, name: cadena.name, ids: cadena.ids });
  }
  return out;
}

// Douglas-Peucker (tolerancia en metros)
export function simplificar(coords, tol) {
  if (coords.length < 3) return coords.slice();
  const lat0 = rad(coords[0][0]);
  const xy = coords.map((c) => [rad(c[1]) * R * Math.cos(lat0), rad(c[0]) * R]);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const pila = [[0, coords.length - 1]];
  while (pila.length) {
    const [s, e] = pila.pop();
    let max = 0, idx = -1;
    const [x1, y1] = xy[s], [x2, y2] = xy[e];
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
    for (let i = s + 1; i < e; i++) {
      // Si el inicio y el final coinciden (ruta circular) se mide la distancia al punto inicial.
      const d = L < 1e-6
        ? Math.hypot(xy[i][0] - x1, xy[i][1] - y1)
        : Math.abs(dy * xy[i][0] - dx * xy[i][1] + x2 * y1 - y2 * x1) / L;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) { keep[idx] = 1; pila.push([s, idx], [idx, e]); }
  }
  return coords.filter((_, i) => keep[i]);
}

export function centro(coords) {
  return coords[Math.floor(coords.length / 2)];
}

// Procesa la respuesta de Overpass y devuelve los tramos cuyo centro cae en la celda.
export function procesarOverpass(json, celda, cfg = CFG) {
  const ways = (json.elements || []).filter((e) => e.type === 'way' && e.geometry && e.nodes && e.geometry.length === e.nodes.length);
  const tramos = [];
  for (const c of encadenar(ways)) {
    for (const t of tramosDeCadena(c, cfg)) {
      const [la, lo] = centro(t.coords);
      if (la >= celda.s && la < celda.n && lo >= celda.w && lo < celda.e) {
        t.id = `${t.ids[0]}_${Math.round(la * 1e4)}_${Math.round(lo * 1e4)}`;
        tramos.push(t);
      }
    }
  }
  return tramos;
}

export function horasTramo(t, cfg = CFG) {
  return t.km / cfg.velNivel[t.lvl];
}

// ---------- Planificador ----------
// Estima el tiempo (h) y la distancia (km) de un enlace por carretera a partir de la distancia en línea recta.
export function enlace(a, b, factor = 1) {
  const d = dist(a, b) / 1000;
  const km = d * 1.3;
  const v = d > 20 ? 90 : d > 5 ? 70 : 50;
  return { h: (km / v) * factor, km };
}

function orient(t, rev) {
  const c = rev ? t.coords.slice().reverse() : t.coords;
  return { entrada: c[0], salida: c[c.length - 1] };
}

// Coste total estimado de un plan.
export function estimar(A, B, plan, factor = 1, cfg = CFG) {
  let h = 0, km = 0, prev = A;
  for (const p of plan) {
    const o = orient(p.t, p.rev);
    const e = enlace(prev, o.entrada, factor);
    h += e.h + horasTramo(p.t, cfg) * factor; km += e.km + p.t.km;
    prev = o.salida;
  }
  if (B) { const e = enlace(prev, B, factor); h += e.h; km += e.km; }
  return { h, km };
}

// Elige y ordena tramos de curvas entre A y B (o circular si B = A) sin pasar del límite.
// opts: { limiteH?, limiteKm?, maxTramos, rumbo?, aleatorio?, factor? }
export function planificar(A, B, candidatos, opts, cfg = CFG) {
  const factor = opts.factor || 1;
  const maxT = opts.maxTramos || 10;
  const rnd = opts.aleatorio || (() => 0.5);
  const usar = (v) => (opts.limiteKm ? v.km : v.h);
  const lim = opts.limiteKm || opts.limiteH;
  let cands = candidatos.filter((t) => {
    const m = centro(t.coords);
    if (opts.rumbo != null) {
      const dif = Math.abs(((rumbo(A, m) - opts.rumbo + 540) % 360) - 180);
      if (dif > 60) return false;
    }
    return usar(estimar(A, B, [{ t, rev: false }], factor, cfg)) <= lim;
  });
  const valor = (t) => t.km * cfg.pesoNivel[t.lvl] * (0.85 + 0.3 * rnd());
  const valores = new Map(cands.map((t) => [t.id, valor(t)]));
  const plan = [];
  const usados = new Set();
  let actual = usar(estimar(A, B, plan, factor, cfg));
  while (plan.length < maxT) {
    let mejor = null;
    for (const t of cands) {
      if (usados.has(t.id)) continue;
      for (let pos = 0; pos <= plan.length; pos++) {
        for (const rev of [false, true]) {
          const prueba = plan.slice(0, pos).concat([{ t, rev }], plan.slice(pos));
          const total = usar(estimar(A, B, prueba, factor, cfg));
          if (total > lim) continue;
          const delta = Math.max(total - actual, opts.limiteKm ? 2 : 0.05);
          const ratio = valores.get(t.id) / delta;
          if (!mejor || ratio > mejor.ratio) mejor = { ratio, prueba, total, id: t.id };
        }
      }
    }
    if (!mejor) break;
    plan.splice(0, plan.length, ...mejor.prueba);
    usados.add(mejor.id);
    actual = mejor.total;
  }
  return plan;
}

// Puntos de paso para el calculador de rutas: A, puntos a lo largo de cada tramo y B.
export function puntosDePaso(A, B, plan, max = 50) {
  const nT = plan.length;
  let sep = 3000;
  const construir = () => {
    const pts = [A];
    const marcas = []; // índice del primer y último punto de cada tramo
    for (const p of plan) {
      const c = p.rev ? p.t.coords.slice().reverse() : p.t.coords;
      const ini = pts.length;
      pts.push(c[0]);
      let acum = 0;
      for (let i = 1; i < c.length - 1; i++) {
        acum += dist(c[i - 1], c[i]);
        if (acum >= sep) { pts.push(c[i]); acum = 0; }
      }
      pts.push(c[c.length - 1]);
      marcas.push([ini, pts.length - 1]);
    }
    if (B) pts.push(B);
    return { pts, marcas };
  };
  let r = construir();
  while (r.pts.length > max && sep < 200000) { sep *= 1.5; r = construir(); }
  if (r.pts.length > max) throw new Error(`Demasiados tramos (${nT}) para una sola ruta.`);
  return r;
}

// Reparto de tiempos a partir de los tramos (legs) que devuelve el calculador.
export function reparto(legs, marcas, hayVuelta) {
  if (!marcas.length) {
    const t = legs.reduce((s, l) => s + l.duration, 0), d = legs.reduce((s, l) => s + l.distance, 0);
    return { ida: { s: t, m: d }, curvas: { s: 0, m: 0 }, vuelta: { s: 0, m: 0 } };
  }
  const ini = marcas[0][0];
  const fin = marcas[marcas.length - 1][1];
  const suma = (a, b) => legs.slice(a, b).reduce((acc, l) => ({ s: acc.s + l.duration, m: acc.m + l.distance }), { s: 0, m: 0 });
  return {
    ida: suma(0, ini),
    curvas: suma(ini, fin),
    vuelta: hayVuelta ? suma(fin, legs.length) : { s: 0, m: 0 },
  };
}

// ---------- Gasolineras ----------
// Posición (km desde el inicio) de cada gasolinera a menos de maxM metros de la ruta.
export function gasolinerasEnRuta(ruta, gasolineras, maxM = 800) {
  const acum = [0];
  for (let i = 1; i < ruta.length; i++) acum.push(acum[i - 1] + dist(ruta[i - 1], ruta[i]));
  const res = [];
  for (const g of gasolineras) {
    let best = Infinity, at = 0;
    for (let i = 0; i < ruta.length; i += 1) {
      const d = dist(ruta[i], g.p);
      if (d < best) { best = d; at = acum[i]; }
      if (d > 20000) i += 20; // salto rápido si estamos lejos
    }
    if (best <= maxM) res.push({ ...g, km: at / 1000 });
  }
  res.sort((a, b) => a.km - b.km);
  return { enRuta: res, totalKm: acum[acum.length - 1] / 1000, acum };
}

// Tramos de la ruta sin gasolinera a una distancia menor que la autonomía útil.
export function huecosSinGasolina(posiciones, totalKm, autonomia, reserva) {
  const util = autonomia - reserva;
  const puntos = [0, ...posiciones.map((g) => g.km), totalKm];
  const huecos = [];
  for (let i = 1; i < puntos.length; i++) {
    const d = puntos[i] - puntos[i - 1];
    if (d > util) huecos.push({ desde: puntos[i - 1], hasta: puntos[i], km: d });
  }
  return { util, huecos };
}

// ---------- GPX ----------
export function gpx(nombre, coords, puntos = []) {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const wpts = puntos.map((p) => `  <wpt lat="${p.p[0]}" lon="${p.p[1]}"><name>${esc(p.nombre)}</name></wpt>`).join('\n');
  const trk = coords.map((c) => `      <trkpt lat="${c[0].toFixed(6)}" lon="${c[1].toFixed(6)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Rutas de Curvas" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(nombre)}</name></metadata>
${wpts}
  <trk>
    <name>${esc(nombre)}</name>
    <trkseg>
${trk}
    </trkseg>
  </trk>
</gpx>
`;
}

// ---------- Google Maps ----------
// Divide los puntos clave en etapas de origen + 3 intermedios + destino.
export function etapasGoogle(puntos) {
  const fmt = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  const etapas = [];
  let i = 0;
  while (i < puntos.length - 1) {
    const fin = Math.min(i + 4, puntos.length - 1);
    const o = puntos[i], d = puntos[fin], wp = puntos.slice(i + 1, fin);
    let url = `https://www.google.com/maps/dir/?api=1&origin=${fmt(o)}&destination=${fmt(d)}&travelmode=driving`;
    if (wp.length) url += `&waypoints=${wp.map(fmt).join('%7C')}`;
    etapas.push(url);
    i = fin;
  }
  return etapas;
}
