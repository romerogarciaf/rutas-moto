import * as C from './curvas.js?v=12';
import * as D from './datos.js?v=12';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLOR = { 1: '#f2c200', 2: '#f07c12', 3: '#d6312b' };
const NIVEL = { 1: 'Curvas', 2: 'Muchas curvas', 3: 'Muy revirado' };
const MADRID = { s: 39.75, n: 41.25, w: -4.75, e: -2.75 };

const S = {
  modo: 'tramos',
  salida: null,
  destino: null,
  elegidos: [],            // [{ t, rev }]
  resultado: null,
  tramos: new Map(),       // id -> tramo
  capas: new Map(),        // id -> polilínea
  celdas: new Set(),       // celdas ya cargadas
  fallidas: new Set(),
  cola: [],
  descargando: false,
  eligiendo: null,         // 'salida' | 'destino' mientras se toca el mapa
  semilla: 1,
  ultimoDiseno: null,
};

// ---------- Utilidades de formato ----------
function fmtH(seg) {
  const m = Math.round(seg / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
const fmtKm = (m) => `${Math.round(m / 1000)} km`;
function nombreTramo(t) {
  if (t.ref && t.name && t.name !== t.ref) return `${t.ref} · ${t.name}`;
  return t.ref || t.name || 'Carretera sin nombre';
}
function rng(semilla) {
  let a = semilla >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

let tEstado;
function estado(msg, { error = false, dura = 0 } = {}) {
  const el = $('#estado');
  clearTimeout(tEstado);
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.hidden = false;
  if (dura) tEstado = setTimeout(() => (el.hidden = true), dura);
}

// ---------- Mapa ----------
const mapa = L.map('mapa', { zoomControl: false, attributionControl: true }).setView([40.72, -3.85], 10);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  className: 'mapa-base',
}).addTo(mapa);
const lienzoTramos = L.canvas({ tolerance: 12 });
const capaHalo = L.layerGroup().addTo(mapa);
const capaTramos = L.layerGroup().addTo(mapa);
const capaZonas = L.layerGroup().addTo(mapa);
const capaSeleccion = L.layerGroup().addTo(mapa);
const capaRuta = L.layerGroup().addTo(mapa);
const capaGas = L.layerGroup().addTo(mapa);
const capaPines = L.layerGroup().addTo(mapa);
const capaEdicion = L.layerGroup().addTo(mapa);

function dibujarTramo(t) {
  if (S.capas.has(t.id)) return;
  // Halo ancho y translúcido debajo, línea fina encima: la curva queda resaltada sobre la carretera.
  L.polyline(t.coords, { renderer: lienzoTramos, color: COLOR[t.lvl], weight: 13, opacity: 0.28, lineCap: 'round', interactive: false }).addTo(capaHalo);
  const pl = L.polyline(t.coords, { renderer: lienzoTramos, color: COLOR[t.lvl], weight: 4.5, opacity: 1, lineCap: 'round' });
  pl.on('click', (e) => {
    L.DomEvent.stop(e);
    if (S.eligiendo) return fijarDesdeMapa(e.latlng);
    abrirTramo(t, e.latlng);
  });
  pl.addTo(capaTramos);
  S.capas.set(t.id, pl);
}
function anadirTramos(lista) {
  for (const t of lista) {
    // Evita duplicados entre celdas vecinas (mismo trozo de carretera)
    let dup = false;
    const m = C.centro(t.coords);
    for (const o of S.tramos.values()) {
      if (o.ids[0] === t.ids[0] && C.dist(C.centro(o.coords), m) < 1500) { dup = true; break; }
    }
    if (dup) continue;
    S.tramos.set(t.id, t);
    dibujarTramo(t);
  }
  programarZonas();
}

// ---------- Iconos de zonas de curvas (agrupados al alejar el mapa) ----------
const GLIFO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 20.5C6 16 12 16.5 12 12S18 8 18 3.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>';
let tZonas;
function programarZonas() { clearTimeout(tZonas); tZonas = setTimeout(pintarZonas, 250); }
function pintarZonas() {
  capaZonas.clearLayers();
  const z = mapa.getZoom();
  if (z >= 13) return;
  const b = mapa.getBounds();
  const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
  const celda = 64; // píxeles por grupo
  const grupos = new Map();
  for (const t of S.tramos.values()) {
    const c = C.centro(t.coords);
    if (c[0] < s || c[0] > n || c[1] < w || c[1] > e) continue;
    const p = mapa.latLngToContainerPoint(c);
    const k = `${Math.floor(p.x / celda)}:${Math.floor(p.y / celda)}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(t);
  }
  for (const lista of grupos.values()) {
    const lvl = Math.max(...lista.map((t) => t.lvl));
    const lat = lista.reduce((a, t) => a + C.centro(t.coords)[0], 0) / lista.length;
    const lon = lista.reduce((a, t) => a + C.centro(t.coords)[1], 0) / lista.length;
    const uno = lista.length === 1;
    const html = uno
      ? `<div class="zona n${lvl}">${GLIFO}</div>`
      : `<div class="zona grupo n${lvl}">${lista.length}</div>`;
    const tam = uno ? 30 : 36;
    const m = L.marker(uno ? C.centro(lista[0].coords) : [lat, lon], {
      icon: L.divIcon({ className: '', html, iconSize: [tam, tam], iconAnchor: [tam / 2, tam / 2] }),
      keyboard: false,
      title: uno ? nombreTramo(lista[0]) : `${lista.length} tramos de curvas`,
    });
    m.on('click', () => {
      if (S.eligiendo) return fijarDesdeMapa(m.getLatLng());
      if (uno) {
        const t = lista[0], c = C.centro(t.coords);
        mapa.setView(c, Math.max(z, 12));
        abrirTramo(t, c);
      } else {
        const pts = lista.flatMap((t) => [t.coords[0], t.coords[t.coords.length - 1]]);
        mapa.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 13 });
      }
    });
    m.addTo(capaZonas);
  }
}
mapa.on('zoomend moveend', programarZonas);

// ---------- Carga de curvas por celdas ----------
async function cargarGuardadas() {
  try {
    const claves = await D.idb.keys('celdas');
    const pref = D.prefijoCeldas();
    for (const k of claves) {
      if (!String(k).startsWith(pref)) { D.idb.del('celdas', k); continue; } // datos de otra sensibilidad
      const v = await D.idb.get('celdas', k);
      S.celdas.add(k);
      if (v) anadirTramos(v.tramos);
    }
  } catch { /* sin almacenamiento: se descargará al vuelo */ }
}

async function procesarCola() {
  if (S.descargando) return;
  S.descargando = true;
  while (S.cola.length) {
    const c = S.cola[0];
    if (!S.celdas.has(c.clave)) {
      estado(`Buscando curvas en esta zona… (quedan ${S.cola.length})`);
      try {
        const reg = await D.descargarCelda(c.i, c.j);
        S.celdas.add(c.clave);
        anadirTramos(reg.tramos);
      } catch (e) {
        S.fallidas.add(c.clave);
        estado(e.message, { error: true, dura: 6000 });
      }
    }
    S.cola.shift();
  }
  S.descargando = false;
  if (!$('#estado').classList.contains('error')) estado('');
}

function revisarVista() {
  if (mapa.getZoom() < 10) {
    const b = mapa.getBounds();
    const faltan = D.celdasDe({ s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() }).some((c) => !S.celdas.has(c.clave));
    if (faltan && !S.descargando) estado('Acerca el mapa para buscar curvas en esta zona.', { dura: 3000 });
    return;
  }
  const b = mapa.getBounds();
  const celdas = D.celdasDe({ s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() })
    .filter((c) => !S.celdas.has(c.clave) && !S.fallidas.has(c.clave) && !S.cola.some((q) => q.clave === c.clave));
  if (!celdas.length) return;
  S.cola.push(...celdas.slice(0, 12));
  procesarCola();
}
let tVista;
mapa.on('moveend', () => { clearTimeout(tVista); tVista = setTimeout(revisarVista, 600); });

// Asegura que hay datos de curvas para una zona amplia (diseño automático).
async function asegurarZona(bbox) {
  const celdas = D.celdasDe(bbox).filter((c) => !S.celdas.has(c.clave));
  if (celdas.length > 70) throw new Error('La zona es demasiado grande. Reduce el tiempo o la distancia.');
  let n = 0;
  for (const c of celdas) {
    n++;
    estado(`Descargando carreteras de la zona… ${n} de ${celdas.length}${celdas.length > 6 ? ' (solo la primera vez)' : ''}`);
    try {
      const reg = await D.descargarCelda(c.i, c.j);
      S.celdas.add(c.clave);
      anadirTramos(reg.tramos);
    } catch { S.fallidas.add(c.clave); }
  }
}
function tramosEn(bbox) {
  return [...S.tramos.values()].filter((t) => {
    const [la, lo] = C.centro(t.coords);
    return la >= bbox.s && la <= bbox.n && lo >= bbox.w && lo <= bbox.e;
  });
}
function caja(p, km) {
  const dLat = km / 111, dLon = km / (111 * Math.cos((p[0] * Math.PI) / 180));
  return { s: p[0] - dLat, n: p[0] + dLat, w: p[1] - dLon, e: p[1] + dLon };
}

// ---------- Popup de tramo ----------
function abrirTramo(t, latlng) {
  const yaEsta = S.modo === 'editar' ? -1 : S.elegidos.findIndex((x) => x.t.id === t.id);
  const min = Math.round(C.horasTramo(t) * 60);
  const html = `<div class="pop">
    <h4>${esc(nombreTramo(t))}</h4>
    <span class="nivel" style="background:${COLOR[t.lvl]}">${NIVEL[t.lvl]}</span>
    <div class="pdat"><span>${t.km.toFixed(1)} km</span><span>≈ ${min} min</span></div>
    <div class="botones">
      ${yaEsta >= 0
        ? `<button class="sec" data-acc="quitar">Quitar de la ruta</button>`
        : `<button class="pri" data-acc="anadir">Añadir a la ruta</button>
           <button class="sec" data-acc="contrario">Añadir en sentido contrario</button>`}
    </div></div>`;
  const pop = L.popup({ maxWidth: 280 }).setLatLng(latlng).setContent(html).openOn(mapa);
  const el = pop.getElement();
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const acc = b.dataset.acc;
    if (S.modo === 'editar' && S.edicion) {
      const els = S.edicion.elems;
      const pos = S.edicion.insertarEn ?? (els[els.length - 1].tipo === 'punto' ? els.length - 1 : els.length);
      const prevEl = els[pos - 1];
      const prev = prevEl ? (prevEl.tipo === 'punto' ? prevEl.p : orientado(prevEl).slice(-1)[0]) : null;
      let rev = prev ? C.dist(prev, t.coords[t.coords.length - 1]) < C.dist(prev, t.coords[0]) : false;
      if (acc === 'contrario') rev = !rev;
      mapa.closePopup();
      insertarEnEdicion({ tipo: 'tramo', t: compactarTramo(t), rev });
      return;
    }
    if (acc === 'quitar') S.elegidos.splice(yaEsta, 1);
    else {
      const rev = sentidoNatural(t);
      S.elegidos.push({ t, rev: acc === 'contrario' ? !rev : rev });
      if (S.modo !== 'tramos') cambiarModo('tramos');
    }
    mapa.closePopup();
    invalidarResultado();
    pintarSeleccion();
    pintarListaTramos();
  }));
}
// Entra por el extremo más cercano al punto donde termina lo ya elegido.
function sentidoNatural(t) {
  const ult = S.elegidos[S.elegidos.length - 1];
  let prev = S.salida?.p;
  if (ult) { const c = ult.rev ? ult.t.coords[0] : ult.t.coords[ult.t.coords.length - 1]; prev = c; }
  if (!prev) { const c = mapa.getCenter(); prev = [c.lat, c.lng]; }
  return C.dist(prev, t.coords[t.coords.length - 1]) < C.dist(prev, t.coords[0]);
}

function pintarSeleccion() {
  capaSeleccion.clearLayers();
  S.elegidos.forEach(({ t, rev }, i) => {
    L.polyline(t.coords, { color: '#1b1f22', weight: 11, opacity: 0.55, interactive: false }).addTo(capaSeleccion);
    L.polyline(t.coords, { color: COLOR[t.lvl], weight: 6, opacity: 1, interactive: false }).addTo(capaSeleccion);
    const ini = rev ? t.coords[t.coords.length - 1] : t.coords[0];
    L.marker(ini, { interactive: false, icon: L.divIcon({ className: '', html: `<div class="pin-mapa destino">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(capaSeleccion);
  });
}

function pintarListaTramos() {
  const ol = $('#lista-tramos');
  ol.innerHTML = S.elegidos.map(({ t }) =>
    `<li style="--nivel:${COLOR[t.lvl]}"><span class="nom">${esc(nombreTramo(t))}</span><span class="dat">${t.km.toFixed(1)} km · ${Math.round(C.horasTramo(t) * 60)} min</span></li>`).join('');
  $('#acciones-tramos').hidden = !S.elegidos.length;
}

// ---------- Puntos de salida y destino ----------
function pintarCamposPunto() {
  const casa = D.ajustes().casa;
  const etq = $('#fin-casa-nombre');
  if (etq) etq.textContent = casa ? `(${casa.etiqueta})` : '(aún sin indicar)';
  $$('.campo-punto').forEach((el) => {
    const tipo = el.dataset.punto;
    const v = S[tipo];
    el.innerHTML = `<span class="pin ${tipo}">${tipo === 'salida' ? 'A' : 'B'}</span>
      <span class="txt"><small>${tipo === 'salida' ? 'Salida' : 'Destino'}</small><b>${v ? esc(v.etiqueta) : 'Sin elegir'}</b></span>
      <span class="cambiar">${v ? 'Cambiar' : 'Elegir'}</span>`;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
  });
  capaPines.clearLayers();
  if (casa && S.modo === 'tramos' && finElegido() === 'casa') {
    L.marker(casa.p, { title: 'Casa', icon: L.divIcon({ className: '', html: '<div class="pin-mapa destino">⌂</div>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(capaPines);
  }
  for (const tipo of ['salida', 'destino']) {
    if (!S[tipo]) continue;
    if (tipo === 'destino' && S.modo === 'circular') continue;
    if (tipo === 'destino' && S.modo === 'tramos' && finElegido() !== 'destino') continue;
    L.marker(S[tipo].p, { icon: L.divIcon({ className: '', html: `<div class="pin-mapa ${tipo}">${tipo === 'salida' ? 'A' : 'B'}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(capaPines);
  }
}
function fijarPunto(tipo, p, etiqueta) {
  if (tipo === 'casa') {
    const a = D.ajustes(); a.casa = { p, etiqueta }; D.guardarAjustes(a);
    estado(`Casa guardada: ${etiqueta}.`, { dura: 5000 });
    pintarCamposPunto();
    return;
  }
  if (tipo === 'insertar' && S.edicion) { insertarEnEdicion({ tipo: 'punto', nombre: etiqueta, p }); return; }
  if (tipo === 'cambiar-el' && S.edicion) {
    S.edicion.elems[S.edicion.cambiarEn] = { tipo: 'punto', nombre: etiqueta, p };
    pintarEdicion(); return;
  }
  S[tipo] = { p, etiqueta };
  invalidarResultado();
  pintarCamposPunto();
}
let puntoEditando = 'salida';
document.addEventListener('click', (e) => {
  const el = e.target.closest('.campo-punto');
  if (!el) return;
  abrirBuscador(el.dataset.punto);
});
// modo: 'salida' | 'destino' | 'ir' (solo llevar el mapa a un lugar)
function abrirBuscador(modo) {
  puntoEditando = modo;
  $('#dlg-punto-titulo').textContent = { salida: 'Salida', destino: 'Destino', casa: 'Tu casa', insertar: 'Añadir parada', 'cambiar-el': 'Cambiar punto' }[modo] || 'Buscar lugar';
  $('#pt-ubicacion').hidden = modo === 'ir';
  $('#pt-mapa').hidden = modo === 'ir' || modo === 'casa';
  const casa = D.ajustes().casa;
  const conCasa = casa && ['salida', 'destino', 'insertar', 'cambiar-el'].includes(modo);
  $('#pt-casa').hidden = !conCasa;
  if (conCasa) $('#pt-casa').textContent = modo === 'salida' ? `Salir desde casa (${casa.etiqueta})` : `Mi casa (${casa.etiqueta})`;
  const hab = D.ajustes().habitual;
  $('#pt-habitual').hidden = !hab || modo === 'ir' || modo === 'casa' || modo === 'insertar';
  if (hab) $('#pt-habitual').textContent = `Usar mi salida habitual: ${hab.etiqueta}`;
  $('#pt-resultados').innerHTML = '';
  $('#pt-texto').value = '';
  $('#dlg-punto').showModal();
  setTimeout(() => $('#pt-texto').focus(), 50);
}
$('#btn-buscar').addEventListener('click', () => abrirBuscador('ir'));
$('#pt-casa').addEventListener('click', () => {
  const casa = D.ajustes().casa;
  $('#dlg-punto').close();
  if (!casa) return;
  fijarPunto(puntoEditando, casa.p, 'Casa');
  if (puntoEditando === 'salida' || puntoEditando === 'destino') mapa.setView(casa.p, Math.max(mapa.getZoom(), 11));
});
$('#pt-habitual').addEventListener('click', () => {
  const casa = D.ajustes().casa;
  const conCasa = casa && ['salida', 'destino', 'insertar', 'cambiar-el'].includes(modo);
  $('#pt-casa').hidden = !conCasa;
  if (conCasa) $('#pt-casa').textContent = modo === 'salida' ? `Salir desde casa (${casa.etiqueta})` : `Mi casa (${casa.etiqueta})`;
  const hab = D.ajustes().habitual;
  $('#dlg-punto').close();
  if (!hab) return;
  fijarPunto(puntoEditando, hab.p, hab.etiqueta);
  mapa.setView(hab.p, Math.max(mapa.getZoom(), 11));
});

// Marca del lugar buscado, con acciones rápidas.
const capaLugar = L.layerGroup().addTo(mapa);
function irALugar(p, etiqueta) {
  capaLugar.clearLayers();
  mapa.setView(p, 11);
  const m = L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="pin-mapa lugar"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(capaLugar);
  const html = `<div class="pop"><h4>${esc(etiqueta)}</h4>
    <p class="nota" style="margin:4px 0 10px">Buscando curvas alrededor…</p>
    <div class="botones">
      <button class="pri" data-acc="salida">Salir desde aquí</button>
      <button class="sec" data-acc="habitual">Guardar como salida habitual</button>
    </div></div>`;
  const pop = L.popup({ maxWidth: 280, offset: [0, -8] }).setLatLng(p).setContent(html).openOn(mapa);
  pop.getElement().querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.acc === 'salida') {
      fijarPunto('salida', p, etiqueta);
      capaLugar.clearLayers();
      mapa.closePopup();
      $('#panel').classList.remove('plegado');
    } else {
      const a = D.ajustes();
      a.habitual = { p, etiqueta };
      D.guardarAjustes(a);
      if (!S.salida) fijarPunto('salida', p, etiqueta);
      b.textContent = 'Guardada como habitual ✓';
      b.disabled = true;
    }
  }));
  return m;
}
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('campo-punto')) { e.preventDefault(); e.target.click(); }
});
$('#pt-ubicacion').addEventListener('click', () => {
  $('#dlg-punto').close();
  estado('Buscando tu ubicación…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const p = [pos.coords.latitude, pos.coords.longitude];
      fijarPunto(puntoEditando, p, puntoEditando === 'casa' ? 'Casa (ubicación guardada)' : 'Mi ubicación');
      mapa.setView(p, Math.max(mapa.getZoom(), 11));
      estado('');
    },
    () => estado('No se pudo obtener tu ubicación. Revisa el permiso de localización de Safari.', { error: true, dura: 6000 }),
    { enableHighAccuracy: true, timeout: 15000 },
  );
});
$('#pt-mapa').addEventListener('click', () => {
  $('#dlg-punto').close();
  S.eligiendo = puntoEditando;
  $('#panel').classList.add('plegado');
  estado(puntoEditando === 'insertar' ? 'Toca el mapa donde quieras la nueva parada.' : `Toca el mapa donde quieras la ${puntoEditando === 'salida' ? 'salida' : 'llegada'}.`);
});
function fijarDesdeMapa(ll) {
  const tipo = S.eligiendo;
  S.eligiendo = null;
  fijarPunto(tipo, [ll.lat, ll.lng], `Punto del mapa (${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)})`);
  $('#panel').classList.remove('plegado');
  estado('');
}
mapa.on('click', (e) => { if (S.eligiendo) fijarDesdeMapa(e.latlng); });
$('#pt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const txt = $('#pt-texto').value.trim();
  if (!txt) return;
  const ul = $('#pt-resultados');
  ul.innerHTML = '<li class="nota">Buscando…</li>';
  try {
    const c = mapa.getCenter();
    const res = await D.buscarLugar(txt, [c.lat, c.lng]);
    if (!res.length) { ul.innerHTML = '<li class="nota">No he encontrado ese lugar. Prueba con otro nombre.</li>'; return; }
    ul.innerHTML = res.map((r, i) => `<li><button data-i="${i}">${esc(r.etiqueta)}</button></li>`).join('');
    ul.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const r = res[+b.dataset.i];
      const etiqueta = r.etiqueta.split(',').slice(0, 2).join(',');
      $('#dlg-punto').close();
      if (puntoEditando === 'ir') { $('#panel').classList.add('plegado'); irALugar(r.p, etiqueta); return; }
      fijarPunto(puntoEditando, r.p, etiqueta);
      mapa.setView(r.p, Math.max(mapa.getZoom(), 11));
    }));
  } catch (err) { ul.innerHTML = `<li class="nota">${esc(err.message)}</li>`; }
});

// ---------- Modos ----------
function cambiarModo(modo) {
  S.modo = modo;
  $$('.pestanas button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.modo === modo)));
  $$('.modo').forEach((m) => (m.hidden = m.dataset.modo !== modo));
  capaSeleccion.eachLayer((l) => l.setStyle?.({ opacity: modo === 'tramos' ? 1 : 0 }));
  invalidarResultado();
  pintarCamposPunto();
  if (modo === 'tramos') pintarSeleccion(); else capaSeleccion.clearLayers();
  if (modo !== 'editar') { capaEdicion.clearLayers(); S.edicion = null; }
}
$$('.pestanas button').forEach((b) => b.addEventListener('click', () => cambiarModo(b.dataset.modo)));
// Panel: se pliega o despliega tocando la rayita o arrastrando la rayita o las pestañas.
(function arrastrePanel() {
  const panel = $('#panel');
  let ini = null, ignorarClic = false;
  const visiblePlegado = () => 78 + (parseFloat(getComputedStyle(panel).paddingBottom) || 0);
  const maxBajada = () => Math.max(0, panel.offsetHeight - visiblePlegado());
  const empezar = (e) => {
    ini = { y: e.clientY, base: panel.classList.contains('plegado') ? maxBajada() : 0, mov: false, id: e.pointerId, el: e.currentTarget };
  };
  const mover = (e) => {
    if (!ini || e.pointerId !== ini.id) return;
    const dy = e.clientY - ini.y;
    if (!ini.mov && Math.abs(dy) < 6) return;
    if (!ini.mov) { ini.mov = true; try { ini.el.setPointerCapture(ini.id); } catch {} panel.classList.add('arrastrando'); }
    const t = Math.min(maxBajada(), Math.max(0, ini.base + dy));
    panel.style.transform = `translateY(${t}px)`;
  };
  const soltar = (e) => {
    if (!ini || e.pointerId !== ini.id) return;
    if (ini.mov) {
      const dy = e.clientY - ini.y;
      const plegar = ini.base === 0 ? dy > 50 : dy > -50;
      panel.classList.remove('arrastrando');
      panel.style.transform = '';
      panel.classList.toggle('plegado', plegar);
      ignorarClic = true;
      setTimeout(() => (ignorarClic = false), 350);
    }
    ini = null;
  };
  for (const el of [$('#asa'), $('.pestanas')]) {
    el.addEventListener('pointerdown', empezar);
    el.addEventListener('pointermove', mover);
    el.addEventListener('pointerup', soltar);
    el.addEventListener('pointercancel', soltar);
    // Tras un arrastre no se cuenta el toque como clic en una pestaña
    el.addEventListener('click', (e) => { if (ignorarClic) { e.stopPropagation(); e.preventDefault(); } }, true);
  }
  $('#asa').addEventListener('click', () => { if (!ignorarClic) panel.classList.toggle('plegado'); });

  // Arrastrar hacia abajo desde cualquier parte del contenido, cuando ya está arriba del todo.
  const cuerpo = $('.panel-cuerpo');
  let t0 = null;
  cuerpo.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || panel.classList.contains('plegado')) { t0 = null; return; }
    t0 = { y: e.touches[0].clientY, arriba: cuerpo.scrollTop <= 0, mov: false };
  }, { passive: true });
  cuerpo.addEventListener('touchmove', (e) => {
    if (!t0 || !t0.arriba) return;
    const dy = e.touches[0].clientY - t0.y;
    if (!t0.mov && (dy < 8 || cuerpo.scrollTop > 0)) { if (dy < 0) t0 = null; return; }
    t0.mov = true;
    e.preventDefault();
    panel.classList.add('arrastrando');
    panel.style.transform = `translateY(${Math.min(maxBajada(), dy)}px)`;
  }, { passive: false });
  const finToque = (e) => {
    if (!t0) return;
    if (t0.mov) {
      const dy = (e.changedTouches[0]?.clientY ?? t0.y) - t0.y;
      panel.classList.remove('arrastrando');
      panel.style.transform = '';
      panel.classList.toggle('plegado', dy > 60);
    }
    t0 = null;
  };
  cuerpo.addEventListener('touchend', finToque);
  cuerpo.addEventListener('touchcancel', finToque);
  // Al tocar una pestaña con el panel plegado, se despliega.
  $('.pestanas').addEventListener('click', () => { if (!ignorarClic) panel.classList.remove('plegado'); });
})();
const finElegido = () => $('input[name="fin"]:checked').value;
$$('input[name="fin"]').forEach((r) => r.addEventListener('change', () => {
  $('.modo[data-modo="tramos"] .campo-punto[data-punto="destino"]').hidden = finElegido() !== 'destino';
  invalidarResultado();
  pintarCamposPunto();
}));
$('#btn-quitar').addEventListener('click', () => { S.elegidos.pop(); invalidarResultado(); pintarSeleccion(); pintarListaTramos(); });
$('#btn-vaciar').addEventListener('click', () => { S.elegidos = []; invalidarResultado(); pintarSeleccion(); pintarListaTramos(); });
$('#ab-criterio').addEventListener('change', (e) => {
  $('#ab-extra').hidden = e.target.value !== 'extra';
  $('#ab-total').hidden = e.target.value !== 'total';
});
$$('input[name="ci-tipo"]').forEach((r) => r.addEventListener('change', () => {
  const km = $('input[name="ci-tipo"]:checked').value === 'km';
  $('#ci-h').hidden = km; $('#ci-km').hidden = !km;
}));

function invalidarResultado() {
  S.resultado = null;
  capaRuta.clearLayers();
  capaGas.clearLayers();
  $('#resultado').hidden = true;
  $('#resultado').innerHTML = '';
}

async function ocupado(boton, fn) {
  const txt = boton.textContent;
  $$('.pri, .sec').forEach((b) => (b.disabled = true));
  boton.textContent = 'Calculando…';
  try { await fn(); }
  catch (e) { estado(e.message, { error: true, dura: 8000 }); }
  finally {
    boton.textContent = txt;
    $$('.pri, .sec').forEach((b) => (b.disabled = false));
    $('#btn-ab-otra').disabled = !(S.ultimoDiseno?.modo === 'ab');
    $('#btn-ci-otra').disabled = !(S.ultimoDiseno?.modo === 'circular');
  }
}
const peajes = () => $('#peajes').checked;

// Tramo a tramo
$('#btn-calcular-tramos').addEventListener('click', (e) => ocupado(e.currentTarget, async () => {
  if (!S.salida) throw new Error('Elige primero el punto de salida.');
  if (!S.elegidos.length) throw new Error('Añade al menos un tramo de curvas tocándolo en el mapa.');
  const fin = finElegido();
  if (fin === 'destino' && !S.destino) throw new Error('Elige el destino.');
  const A = S.salida.p;
  let B = fin === 'salida' ? A : fin === 'destino' ? S.destino.p : null;
  if (fin === 'casa') {
    const casa = D.ajustes().casa;
    if (!casa) {
      abrirBuscador('casa');
      throw new Error('Indica primero dónde está tu casa (búscala o usa tu ubicación) y vuelve a pulsar Calcular ruta.');
    }
    B = casa.p;
  }
  const plan = S.elegidos.slice();
  const { pts, marcas } = C.puntosDePaso(A, B, plan);
  estado('Calculando la ruta…');
  const r = await D.ruta(pts, { peajes: peajes() });
  estado('');
  mostrarResultado({ modo: 'tramos', A, B, circular: fin === 'salida', vueltaCasa: fin === 'casa', hayVuelta: !!B, plan, marcas, ...r, avisos: [] });
}));

// Diseño automático con recalibración contra el tiempo real que da el calculador.
async function disenar({ A, B, cands, limite, porKm, rumbo, semilla }) {
  const limVal = porKm ? limite : limite;
  const usar = (r) => (porKm ? r.distance / 1000 : r.duration / 3600);
  let factor = 1, mejor = null, excedido = null;
  for (let it = 0; it < 3; it++) {
    const plan = C.planificar(A, B, cands, {
      ...(porKm ? { limiteKm: limite } : { limiteH: limite }),
      maxTramos: 10, rumbo, aleatorio: rng(semilla), factor,
    });
    if (!plan.length) break;
    const { pts, marcas } = C.puntosDePaso(A, B, plan);
    estado(`Comprobando la ruta propuesta… (intento ${it + 1})`);
    const r = await D.ruta(pts, { peajes: peajes() });
    const real = usar(r);
    const est = C.estimar(A, B, plan, factor);
    const estVal = porKm ? est.km : est.h;
    const valor = plan.reduce((s, p) => s + p.t.km * C.CFG.pesoNivel[p.t.lvl], 0);
    const cand = { plan, marcas, r, real, valor };
    if (real <= limVal * 1.08) {
      if (!mejor || valor > mejor.valor) mejor = cand;
      if (real >= limVal * 0.8) break;
    } else if (!excedido || real < excedido.real) excedido = cand;
    factor = factor * (real / Math.max(estVal, 0.01));
  }
  return mejor || (excedido && { ...excedido, excede: true }) || null;
}

// De A a B
async function disenarAB() {
  if (!S.salida || !S.destino) throw new Error('Elige la salida y el destino.');
  const A = S.salida.p, B = S.destino.p;
  estado('Calculando la ruta rápida de referencia…');
  const rapida = await D.ruta([A, B], { peajes: peajes() });
  const hRapida = rapida.duration / 3600;
  const crit = $('#ab-criterio').value;
  let limite;
  if (crit === 'max') limite = hRapida * 2.5 + 0.5;
  else if (crit === 'extra') limite = hRapida * (1 + Math.max(5, +$('#ab-extra-v').value || 60) / 100);
  else limite = Math.max(0.5, +$('#ab-total-v').value || 3);
  if (limite < hRapida) throw new Error(`La ruta más rápida ya tarda ${fmtH(rapida.duration)}. Sube el tiempo total.`);
  const dKm = C.dist(A, B) / 1000;
  const margen = Math.min(60, Math.max(12, dKm * 0.3 + (limite - hRapida) * 25));
  const bbox = {
    s: Math.min(A[0], B[0]) - margen / 111, n: Math.max(A[0], B[0]) + margen / 111,
    w: Math.min(A[1], B[1]) - margen / 85, e: Math.max(A[1], B[1]) + margen / 85,
  };
  await asegurarZona(bbox);
  const d = await disenar({ A, B, cands: tramosEn(bbox), limite, porKm: false, semilla: S.semilla });
  S.ultimoDiseno = { modo: 'ab' };
  estado('');
  const avisos = [`Ruta rápida de referencia: ${fmtH(rapida.duration)} y ${fmtKm(rapida.distance)}. Límite usado: ${fmtH(limite * 3600)}.`];
  if (!d) {
    mostrarResultado({ modo: 'ab', A, B, hayVuelta: true, plan: [], marcas: [], ...rapida, avisos: ['No hay tramos de curvas que quepan en ese límite. Te muestro la ruta rápida.', ...avisos] });
    return;
  }
  if (d.excede) avisos.unshift(`No encontré una combinación dentro del límite: esta se pasa ${fmtH((d.real - limite) * 3600)}.`);
  mostrarResultado({ modo: 'ab', A, B, hayVuelta: true, plan: d.plan, marcas: d.marcas, ...d.r, avisos });
}
$('#btn-ab').addEventListener('click', (e) => { S.semilla = 1; ocupado(e.currentTarget, disenarAB); });
$('#btn-ab-otra').addEventListener('click', (e) => { S.semilla++; ocupado(e.currentTarget, disenarAB); });

// Circular
async function disenarCircular() {
  if (!S.salida) throw new Error('Elige el punto de salida.');
  const A = S.salida.p;
  const porKm = $('input[name="ci-tipo"]:checked').value === 'km';
  const limite = porKm ? Math.max(40, +$('#ci-km-v').value || 200) : Math.max(1, +$('#ci-h-v').value || 3);
  const radio = Math.min(85, Math.max(25, porKm ? limite / 2.4 : (limite * 80) / 2.4));
  const bbox = caja(A, radio);
  await asegurarZona(bbox);
  const rv = $('#ci-rumbo').value;
  const d = await disenar({ A, B: A, cands: tramosEn(bbox), limite, porKm, rumbo: rv === '' ? null : +rv, semilla: S.semilla });
  S.ultimoDiseno = { modo: 'circular' };
  estado('');
  if (!d) throw new Error('No encontré tramos de curvas que quepan en ese límite. Prueba con más tiempo u otra dirección.');
  const avisos = [];
  if (d.excede) avisos.push(`No encontré una combinación dentro del límite: esta se pasa ${porKm ? `${Math.round(d.real - limite)} km` : fmtH((d.real - limite) * 3600)}.`);
  mostrarResultado({ modo: 'circular', A, B: A, circular: true, hayVuelta: true, plan: d.plan, marcas: d.marcas, ...d.r, avisos });
}
$('#btn-ci').addEventListener('click', (e) => { S.semilla = 1; ocupado(e.currentTarget, disenarCircular); });
$('#btn-ci-otra').addEventListener('click', (e) => { S.semilla++; ocupado(e.currentTarget, disenarCircular); });

// ---------- Resultado ----------
function mostrarResultado(r) {
  S.resultado = r;
  capaRuta.clearLayers();
  capaGas.clearLayers();
  L.polyline(r.coords, { color: '#ffffff', weight: 8, opacity: 0.9, interactive: false }).addTo(capaRuta);
  L.polyline(r.coords, { color: '#1b4fa3', weight: 4.5, opacity: 1, interactive: false }).addTo(capaRuta);
  if (S.modo === 'tramos' && S.elegidos.length) pintarSeleccion(); else {
    capaSeleccion.clearLayers();
    r.plan.forEach(({ t }) => L.polyline(t.coords, { color: COLOR[t.lvl], weight: 7, opacity: 0.95, interactive: false }).addTo(capaSeleccion));
  }
  mapa.fitBounds(L.latLngBounds(r.coords), { paddingTopLeft: [20, 60], paddingBottomRight: [20, Math.round(window.innerHeight * 0.45)] });

  const rep = C.reparto(r.legs, r.marcas, r.hayVuelta);
  const kmCurvas = r.plan.reduce((s, p) => s + p.t.km, 0);
  const total = r.duration || 1;
  const pc = (x) => `${Math.max(0, (x / total) * 100).toFixed(1)}%`;
  const etiquetaVuelta = r.circular ? 'Vuelta a la salida' : r.vueltaCasa ? 'Vuelta a casa' : 'Hasta el destino';
  const minRevirados = Math.round(r.plan.reduce((s, p) => s + C.horasTramo(p.t), 0) * 60);
  const filas = [
    ['r-ida', 'Ida hasta las curvas', rep.ida],
    ['r-curvas', 'Zona de curvas', rep.curvas,
      r.plan.length ? `${r.plan.length} tramo${r.plan.length === 1 ? '' : 's'} revirado${r.plan.length === 1 ? '' : 's'}: ${Math.round(kmCurvas)} km, unos ${minRevirados} min. El resto son enlaces entre tramos.` : ''],
  ];
  if (r.hayVuelta) filas.push(['r-vuelta', etiquetaVuelta, rep.vuelta]);
  if (r.filas) {
    // Ruta por elementos: un renglón por cada enlace entre paradas y por cada tramo de curvas.
    filas.length = 0;
    r.filas.forEach((f) => filas.push([f.clase, esc(f.txt), { s: f.s, m: f.m }]));
  }
  const nombrePorDefecto = `Ruta ${new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}`;
  const el = $('#resultado');
  el.innerHTML = `
    <div class="totales">
      <div><b>${fmtKm(r.distance)}</b><small>Distancia</small></div>
      <div><b>${fmtH(r.duration)}</b><small>Tiempo estimado</small></div>
    </div>
    <div class="barra-reparto" aria-hidden="true">${filas.map(([c, , v]) => `<i class="${c}" style="width:${pc(v.s)}"></i>`).join('')}</div>
    <ul class="reparto">${filas.map(([c, txt, v, sub]) => `<li><i class="${c}"></i><span>${txt}</span><span class="num">${fmtH(v.s)} · ${fmtKm(v.m)}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</li>`).join('')}</ul>
    ${r.avisos.map((a) => `<div class="aviso info">${esc(a)}</div>`).join('')}
    ${r.fuente ? `<div class="aviso info">Ruta publicada en <a href="${esc(r.fuente.url)}" target="_blank" rel="noopener">${esc(r.fuente.nombre)}</a>.${r.nota ? ` ${esc(r.nota)}` : ''} Los puntos los ha localizado la app: revisa en el mapa que caen donde deben.</div>` : ''}
    <div id="gas" class="aviso info">Buscando gasolineras en la ruta…</div>
    <div id="radares-ruta" class="aviso info" hidden></div>
    <div class="acciones-resultado">
      <button class="pri" id="r-gpx">Exportar GPX</button>
      <button class="sec" id="r-google">Google Maps</button>
      <a class="sec ancho2" id="r-waze" href="https://waze.com/ul?ll=${r.A[0].toFixed(5)},${r.A[1].toFixed(5)}&navigate=yes" target="_blank" rel="noopener" style="display:grid;place-items:center;text-decoration:none">Waze: llévame a la salida</a>
    </div>
    <div id="r-etapas" class="etapas" hidden></div>
    <div class="guardar-fav">
      <input id="r-nombre" type="text" value="${esc(r.nombre || nombrePorDefecto)}" aria-label="Nombre de la ruta">
      <button class="sec" id="r-guardar">${r.favId ? 'Actualizar' : 'Guardar'}</button>
    </div>
    <button class="sec ancho" id="r-editar">Editar paradas y tramos</button>`;
  el.hidden = false;
  $('#r-gpx').addEventListener('click', exportarGPX);
  $('#r-google').addEventListener('click', mostrarEtapasGoogle);
  $('#r-guardar').addEventListener('click', guardarFavorita);
  $('#r-editar').addEventListener('click', () => empezarEdicion({ ...S.resultado, nombre: $('#r-nombre').value.trim() || S.resultado.nombre }));
  revisarRadares(r);
  $('.panel-cuerpo').scrollTo({ top: el.offsetTop - 10, behavior: 'smooth' });
  revisarGasolina(r);
}

async function revisarGasolina(r) {
  const aj = D.ajustes();
  const caja = r.coords.reduce((b, [la, lo]) => ({ s: Math.min(b.s, la), n: Math.max(b.n, la), w: Math.min(b.w, lo), e: Math.max(b.e, lo) }), { s: 90, n: -90, w: 180, e: -180 });
  const pad = 0.02;
  let gs;
  try { gs = await D.gasolineras({ s: caja.s - pad, n: caja.n + pad, w: caja.w - pad, e: caja.e + pad }); }
  catch { if (S.resultado === r) $('#gas').textContent = 'No se pudieron cargar las gasolineras ahora mismo.'; return; }
  if (S.resultado !== r) return;
  const muestra = C.remuestrear(r.coords, 150); // conserva la longitud real del recorrido
  const { enRuta, totalKm, acum } = C.gasolinerasEnRuta(muestra, gs, 800);
  const { util, huecos } = C.huecosSinGasolina(enRuta, totalKm, aj.autonomia, aj.reserva);
  const icono = '<svg viewBox="0 0 24 24"><path d="M5 21V4.5C5 3.7 5.7 3 6.5 3h7c.8 0 1.5.7 1.5 1.5V21M3.5 21h13M8 7h4M15 9l3 2v7a1.5 1.5 0 0 0 3 0V9l-3-3" fill="none" stroke="#1b1f22" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  for (const g of enRuta) {
    L.marker(g.p, { icon: L.divIcon({ className: '', html: `<div class="gas-mapa">${icono}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) })
      .bindPopup(`<div class="pop"><h4>${esc(g.nombre)}</h4><div class="pdat"><span>km ${Math.round(g.km)} de la ruta</span></div></div>`)
      .addTo(capaGas);
  }
  for (const h of huecos) {
    const tramo = muestra.filter((_, i) => acum[i] / 1000 >= h.desde && acum[i] / 1000 <= h.hasta);
    if (tramo.length > 1) L.polyline(tramo, { color: '#d6312b', weight: 9, opacity: 0.45, interactive: false, dashArray: '2 12' }).addTo(capaGas);
  }
  const el = $('#gas');
  if (!huecos.length) {
    el.className = 'aviso bien';
    el.textContent = `Gasolina: ${enRuta.length} gasolinera${enRuta.length === 1 ? '' : 's'} en la ruta. Ningún tramo supera ${util} km sin repostar.`;
  } else {
    el.className = 'aviso malo';
    el.innerHTML = `Ojo con la gasolina: ${huecos.map((h) => `del km ${Math.round(h.desde)} al ${Math.round(h.hasta)} no hay gasolineras (${Math.round(h.km)} km)`).join('; ')}. Tu autonomía útil es ${util} km. Reposta antes.`;
  }
}

function puntosClave(r) {
  if (r.via) return r.via;
  const pts = [r.A];
  for (const { t, rev } of r.plan) {
    const c = rev ? t.coords.slice().reverse() : t.coords;
    pts.push(c[0], C.centro(c), c[c.length - 1]);
  }
  if (r.B) pts.push(r.B);
  return pts;
}
function mostrarEtapasGoogle() {
  const r = S.resultado;
  const etapas = C.etapasGoogle(puntosClave(r));
  const el = $('#r-etapas');
  el.innerHTML = (etapas.length > 1 ? `<p class="nota">Google Maps solo admite unos pocos puntos por ruta, así que la he partido en ${etapas.length} etapas. Abre la siguiente al terminar cada una.</p>` : '')
    + etapas.map((u, i) => `<a class="sec" href="${u}" target="_blank" rel="noopener">${etapas.length > 1 ? `Etapa ${i + 1} de ${etapas.length}` : 'Abrir en Google Maps'}</a>`).join('')
    + '<p class="nota">Google Maps recalcula el camino entre puntos, así que puede variar algo. Para seguir el trazado exacto usa el GPX en Calimoto.</p>';
  el.hidden = false;
}
async function exportarGPX() {
  const r = S.resultado;
  const nombre = $('#r-nombre')?.value.trim() || 'Ruta de curvas';
  const coords = C.simplificar(r.coords, 3);
  const wpts = r.wpts ? r.wpts.slice() : [{ p: r.A, nombre: 'Salida' }];
  if (!r.wpts) r.plan.forEach(({ t, rev }, i) => wpts.push({ p: rev ? t.coords[t.coords.length - 1] : t.coords[0], nombre: `Tramo ${i + 1}: ${nombreTramo(t)}` }));
  if (!r.wpts && r.B && !r.circular) wpts.push({ p: r.B, nombre: 'Destino' });
  const texto = C.gpx(nombre, coords, wpts);
  const archivo = nombre.replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '_') || 'ruta';
  const file = new File([texto], `${archivo}.gpx`, { type: 'application/gpx+xml' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: nombre }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- Favoritas ----------
async function guardarFavorita() {
  const r = S.resultado;
  const nombre = $('#r-nombre').value.trim() || 'Ruta sin nombre';
  const fav = favDesde(r, nombre, r.favId);
  try {
    await D.idb.put('favoritas', fav);
    r.favId = fav.id; r.nombre = nombre;
    $('#r-guardar').textContent = 'Guardada ✓';
  } catch { estado('No se pudo guardar la ruta en este iPhone.', { error: true, dura: 5000 }); }
}
async function pintarFavoritas() {
  const ul = $('#lista-favoritas');
  let favs = [];
  try { favs = await D.idb.all('favoritas'); } catch {}
  const pre = (f) => (String(f.id).startsWith('pre-') ? 1 : 0); // las precargadas, siempre arriba
  favs.sort((a, b) => pre(b) - pre(a) || b.fecha.localeCompare(a.fecha));
  if (!favs.length) { ul.innerHTML = '<li class="vacio">Aún no has guardado ninguna ruta. Diseña una y pulsa Guardar.</li>'; return; }
  const detalle = (f) => {
    if (f.pendiente) return `${f.paradas.length} paradas · Toca Abrir para calcularla`;
    const extra = f.elems ? `${f.elems.length} paradas y tramos` : f.paradas ? `${f.paradas.length} paradas` : `${f.plan.length} tramos`;
    return `${fmtKm(f.distance)} · ${fmtH(f.duration)} · ${extra} · ${new Date(f.fecha).toLocaleDateString('es-ES')}`;
  };
  ul.innerHTML = favs.map((f) => `<li>
    <div><b>${esc(f.nombre)}</b><small>${detalle(f)}</small>${f.fuente ? `<small class="fuente">Ruta publicada en <a href="${esc(f.fuente.url)}" target="_blank" rel="noopener">${esc(f.fuente.nombre)}</a></small>` : ''}</div>
    <div class="botones"><button class="pri" data-abrir="${f.id}">Abrir</button>${f.pendiente ? '' : `<button class="sec" data-editar="${f.id}">Editar</button>`}<button class="sec" data-borrar="${f.id}" aria-label="Borrar ${esc(f.nombre)}">Borrar</button></div>
  </li>`).join('');
  ul.querySelectorAll('[data-abrir]').forEach((b) => b.addEventListener('click', () => {
    const f = favs.find((x) => String(x.id) === b.dataset.abrir);
    $('#dlg-favoritas').close();
    if (f.paradas || f.elems) { abrirRutaElementos(f); return; }
    S.salida = { p: f.A, etiqueta: 'Salida de la ruta guardada' };
    if (f.B && !f.circular) S.destino = { p: f.B, etiqueta: 'Destino de la ruta guardada' };
    S.elegidos = f.plan.map((x) => ({ t: x.t, rev: x.rev }));
    const fin = f.circular ? 'salida' : f.vueltaCasa ? 'casa' : f.B ? 'destino' : 'nada';
    $(`input[name="fin"][value="${fin}"]`).checked = true;
    $('.modo[data-modo="tramos"] .campo-punto[data-punto="destino"]').hidden = fin !== 'destino';
    cambiarModo('tramos');
    pintarListaTramos();
    mostrarResultado({ ...f, modo: 'tramos', favId: f.id, nombre: f.nombre, avisos: f.avisos || [] });
  }));
  ul.querySelectorAll('[data-editar]').forEach((b) => b.addEventListener('click', () => {
    const f = favs.find((x) => String(x.id) === b.dataset.editar);
    $('#dlg-favoritas').close();
    empezarEdicion({ ...f, favId: f.id });
  }));
  ul.querySelectorAll('[data-borrar]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.confirmar !== '1') { b.dataset.confirmar = '1'; b.textContent = '¿Seguro?'; return; }
    const f = favs.find((x) => String(x.id) === b.dataset.borrar);
    await D.idb.del('favoritas', f.id);
    pintarFavoritas();
  }));
}
$('#btn-favoritas').addEventListener('click', () => { pintarFavoritas(); $('#dlg-favoritas').showModal(); });

// ---------- Rutas por paradas (p. ej. importadas de Google Maps) ----------
const sinTilde = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
async function localizarParada(pa) {
  if (pa.p) return pa.p;
  if (pa.casa) {
    const casa = D.ajustes().casa;
    if (!casa) throw new Error('PEDIR_CASA');
    return casa.p;
  }
  const clave = sinTilde(pa.contiene || pa.nombre);
  for (const q of pa.buscar) {
    const res = await D.buscarLugar(q, [40.45, -3.95]);
    const ok = res.find((x) => sinTilde(x.etiqueta).includes(clave)) || null;
    if (ok) return ok.p;
  }
  for (const q of pa.buscar) {
    try {
      const res = await D.buscarNominatim(q);
      const ok = res.find((x) => sinTilde(x.etiqueta).includes(clave));
      if (ok) return ok.p;
    } catch {}
  }
  throw new Error(`No he encontrado "${pa.nombre}". Revisa el nombre de la parada.`);
}

// Punto de la ruta situado "metros" antes de llegar al índice idx (sin retroceder más allá de minIdx).
function puntoAntes(coords, idx, metros, minIdx) {
  let acum = 0;
  for (let i = idx; i > minIdx; i--) {
    acum += C.dist(coords[i - 1], coords[i]);
    if (acum >= metros) return coords[i - 1];
  }
  return coords[Math.max(minIdx, Math.floor((minIdx + idx) / 2))];
}

// ---------- Rutas como lista de elementos: paradas y tramos de curvas ----------
// Elemento: { tipo: 'punto', nombre, p?, buscar?, casa? } o { tipo: 'tramo', t, rev }
const compactarTramo = (t) => ({ id: t.id, coords: t.coords, km: t.km, lvl: t.lvl, dens: t.dens, ref: t.ref, name: t.name, ids: t.ids });
const nombreEl = (e) => (e.tipo === 'tramo' ? nombreTramo(e.t) : e.nombre);
const orientado = (e) => (e.rev ? e.t.coords.slice().reverse() : e.t.coords);

function elementosDeFav(f) {
  if (f.elems) return { elems: structuredClone(f.elems), sinEntrar: !!f.sinEntrar };
  if (f.paradas) return { elems: f.paradas.map((pa) => ({ tipo: 'punto', ...structuredClone(pa) })), sinEntrar: !!f.sinEntrar };
  const elems = [{ tipo: 'punto', nombre: 'Salida', p: f.A }];
  for (const x of f.plan || []) elems.push({ tipo: 'tramo', t: compactarTramo(x.t), rev: x.rev });
  if (f.B) elems.push({ tipo: 'punto', nombre: f.circular ? 'Vuelta a la salida' : f.vueltaCasa ? 'Casa' : 'Destino', p: f.B });
  return { elems, sinEntrar: false };
}

function puntosDeElementos(elems, sep) {
  const pts = [], meta = [], radios = [];
  for (const e of elems) {
    const ini = pts.length;
    // Las paradas por nombre (un pueblo, un embalse) pueden quedar lejos de la carretera: se amplía la búsqueda.
    if (e.tipo === 'punto') { pts.push(e.p); radios.push(-1); }
    else {
      const c = orientado(e);
      pts.push(c[0]);
      let acum = 0;
      for (let i = 1; i < c.length - 1; i++) { acum += C.dist(c[i - 1], c[i]); if (acum >= sep) { pts.push(c[i]); acum = 0; } }
      pts.push(c[c.length - 1]);
      while (radios.length < pts.length) radios.push(350);
    }
    meta.push({ ini, fin: pts.length - 1 });
  }
  return { pts, meta, radios };
}

async function calcularElementos(elems, { sinEntrar }) {
  if (elems.length < 2) throw new Error('La ruta necesita al menos una salida y otro punto o tramo.');
  estado('Localizando las paradas…');
  for (const e of elems) if (e.tipo === 'punto' && !e.p) e.p = await localizarParada(e);
  let sep = 3000, r0 = puntosDeElementos(elems, sep);
  while (r0.pts.length > 50 && sep < 200000) { sep *= 1.5; r0 = puntosDeElementos(elems, sep); }
  if (r0.pts.length > 50) throw new Error('La ruta tiene demasiadas paradas para calcularla de una vez (máximo unas 45).');
  const { meta, radios } = r0;
  const pts = r0.pts.slice();
  estado('Calculando el recorrido…');
  let r = await D.ruta(pts, { peajes: peajes(), radios });
  // Puertos, presas y miradores ("exacta") se recorren tal cual; los pueblos se rodean.
  const intermedios = elems.map((e, i) => (e.tipo === 'punto' && !e.exacta && i > 0 && i < elems.length - 1 ? i : -1)).filter((i) => i >= 0);
  if (sinEntrar && intermedios.length) {
    const wp = r.wayPoints && r.wayPoints.length === pts.length
      ? r.wayPoints
      : pts.map((p) => { let b = 0, d = Infinity; r.coords.forEach((c, i) => { const x = C.dist(c, p); if (x < d) { d = x; b = i; } }); return b; });
    for (const i of intermedios) {
      const k = meta[i].ini;
      const legM = r.legs[k - 1]?.distance || 3000;
      pts[k] = puntoAntes(r.coords, wp[k], Math.min(1500, legM * 0.4), wp[k - 1]);
    }
    estado('Ajustando para no entrar en los pueblos…');
    r = await D.ruta(pts, { peajes: peajes(), radios });
  }
  estado('');
  // Filas del desglose: enlace entre elementos y, dentro de cada tramo, la parte de curvas.
  const suma = (a, b) => r.legs.slice(a, b).reduce((acc, l) => ({ s: acc.s + l.duration, m: acc.m + l.distance }), { s: 0, m: 0 });
  const filas = [];
  for (let i = 1; i < elems.length; i++) {
    const enlace = suma(meta[i - 1].fin, meta[i].ini);
    if (enlace.m > 0 || elems[i].tipo === 'punto') filas.push({ clase: 'r-ida', txt: `${nombreEl(elems[i - 1])} → ${nombreEl(elems[i])}`, ...enlace });
    if (elems[i].tipo === 'tramo') filas.push({ clase: 'r-curvas', txt: `Curvas: ${nombreEl(elems[i])}`, ...suma(meta[i].ini, meta[i].fin) });
  }
  // Puntos clave para Google Maps y puntos con nombre para el GPX
  const via = [], wpts = [];
  elems.forEach((e, i) => {
    if (e.tipo === 'punto') {
      const q = pts[meta[i].ini];
      via.push(q);
      const ajustado = q !== e.p;
      wpts.push({ p: q, nombre: i === 0 ? `Salida: ${e.nombre}` : ajustado ? `Antes de ${e.nombre}` : e.nombre });
    } else {
      const c = orientado(e);
      via.push(c[0], C.centro(c), c[c.length - 1]);
      wpts.push({ p: c[0], nombre: `Tramo: ${nombreEl(e)}` });
    }
  });
  const ult = elems[elems.length - 1];
  return {
    ...r, via, wpts, filas, elems, sinEntrar,
    A: elems[0].p, B: ult.tipo === 'punto' ? ult.p : null,
    plan: elems.filter((e) => e.tipo === 'tramo').map((e) => ({ t: e.t, rev: e.rev })),
    marcas: [], hayVuelta: false, circular: false,
  };
}

const AVISO_SIN_ENTRAR = 'Las paradas intermedias se sustituyen por un punto unos 1,5 km antes de llegar, para no desviarte a su centro.';

async function abrirRutaElementos(f) {
  S.elegidos = []; pintarListaTramos();
  if (S.modo !== 'tramos') cambiarModo('tramos');
  if (f.pendiente || !f.coords) {
    try {
      const { elems, sinEntrar } = elementosDeFav(f);
      const r = await calcularElementos(elems, { sinEntrar });
      const guardar = favDesde({ ...r, fuente: f.fuente, nota: f.nota }, f.nombre, f.id);
      await D.idb.put('favoritas', guardar);
      f = guardar;
    } catch (e) {
      if (e.message === 'PEDIR_CASA') {
        estado('Esta ruta termina en "Casa". Busca tu casa o usa tu ubicación; luego vuelve a abrir la ruta.', { dura: 9000 });
        abrirBuscador('casa');
      } else estado(e.message, { error: true, dura: 8000 });
      return;
    }
  }
  S.salida = { p: f.A, etiqueta: f.elems?.[0]?.nombre || 'Salida' };
  pintarCamposPunto();
  const hayPueblos = (f.elems || []).some((e, i, a) => e.tipo === 'punto' && !e.exacta && i > 0 && i < a.length - 1);
  mostrarResultado({ ...f, modo: 'tramos', favId: f.id, nombre: f.nombre, avisos: f.sinEntrar && hayPueblos ? [AVISO_SIN_ENTRAR] : [] });
}

// Objeto de favorita a partir de un resultado.
function favDesde(r, nombre, id) {
  return {
    ...(r.fuente ? { fuente: r.fuente } : {}), ...(r.nota ? { nota: r.nota } : {}),
    id: id || Date.now(), nombre, fecha: new Date().toISOString(),
    modo: r.modo, A: r.A, B: r.B, circular: !!r.circular, vueltaCasa: !!r.vueltaCasa, hayVuelta: r.hayVuelta,
    plan: r.plan.map(({ t, rev }) => ({ t: compactarTramo(t), rev })),
    marcas: r.marcas, legs: r.legs, distance: r.distance, duration: r.duration,
    coords: C.simplificar(r.coords, 4), avisos: r.avisos || (r.sinEntrar ? [AVISO_SIN_ENTRAR] : []),
    ...(r.elems ? {
      elems: r.elems.map((e) => (e.tipo === 'tramo' ? { tipo: 'tramo', t: compactarTramo(e.t), rev: e.rev } : { tipo: 'punto', nombre: e.nombre, p: e.p, ...(e.exacta ? { exacta: true } : {}) })),
      sinEntrar: !!r.sinEntrar, filas: r.filas, via: r.via, wpts: r.wpts,
    } : {}),
  };
}

// ---------- Edición de rutas ----------
function empezarEdicion(r) {
  const base = r.elems ? { elems: structuredClone(r.elems), sinEntrar: !!r.sinEntrar } : elementosDeFav(r);
  S.edicion = { fuente: r.fuente, nota: r.nota, favId: r.favId || r.id || null, nombre: r.nombre || $('#r-nombre')?.value || 'Ruta', ...base, insertarEn: null };
  cambiarModo('editar');
  $('#ed-nombre').value = S.edicion.nombre;
  $('#ed-sin-entrar').checked = S.edicion.sinEntrar;
  $('#panel').classList.remove('plegado');
  pintarEdicion();
}

function pintarEdicion() {
  const ed = S.edicion;
  const ol = $('#lista-edicion');
  const n = ed.elems.length;
  const fila = (e, i) => {
    const primero = i === 0, ultimo = i === n - 1 && e.tipo === 'punto';
    const ico = e.tipo === 'tramo'
      ? `<span class="ico tramo" style="background:${COLOR[e.t.lvl]}">${i}</span>`
      : `<span class="ico ${primero ? 'salida' : ultimo ? 'llegada' : ''}">${primero ? 'A' : ultimo ? 'B' : i}</span>`;
    const sub = e.tipo === 'tramo' ? `Tramo de curvas · ${e.t.km.toFixed(1)} km` : primero ? 'Salida' : ultimo ? 'Llegada' : 'Parada';
    const mover = primero || ultimo ? '' : `
        <button data-arriba="${i}" aria-label="Subir" ${i <= 1 ? 'disabled' : ''}>↑</button>
        <button data-abajo="${i}" aria-label="Bajar" ${i >= n - 2 && ed.elems[n - 1].tipo === 'punto' ? 'disabled' : i >= n - 1 ? 'disabled' : ''}>↓</button>
        <button data-quitar="${i}" aria-label="Quitar">✕</button>`;
    const cambiar = (primero || ultimo) ? `<button class="cambiar-el" data-cambiar="${i}">Cambiar</button>` : '';
    return `<li><div class="el">${ico}<span class="txt"><b>${esc(nombreEl(e))}</b><small>${sub}</small></span><span class="acc">${mover}${cambiar}</span></div></li>`;
  };
  let html = '';
  ed.elems.forEach((e, i) => {
    html += fila(e, i);
    if (i < n - 1) html += `<li><button class="insertar" data-insertar="${i + 1}">+ Añadir parada aquí</button></li>`;
  });
  if (ed.elems[n - 1].tipo !== 'punto') html += `<li><button class="insertar" data-insertar="${n}">+ Añadir llegada</button></li>`;
  ol.innerHTML = html;
  ol.querySelectorAll('[data-quitar]').forEach((b) => b.addEventListener('click', () => { ed.elems.splice(+b.dataset.quitar, 1); pintarEdicion(); }));
  ol.querySelectorAll('[data-arriba]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.arriba; [ed.elems[i - 1], ed.elems[i]] = [ed.elems[i], ed.elems[i - 1]]; pintarEdicion(); }));
  ol.querySelectorAll('[data-abajo]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.abajo; [ed.elems[i + 1], ed.elems[i]] = [ed.elems[i], ed.elems[i + 1]]; pintarEdicion(); }));
  ol.querySelectorAll('[data-insertar]').forEach((b) => b.addEventListener('click', () => { ed.insertarEn = +b.dataset.insertar; abrirBuscador('insertar'); }));
  ol.querySelectorAll('[data-cambiar]').forEach((b) => b.addEventListener('click', () => { ed.cambiarEn = +b.dataset.cambiar; abrirBuscador('cambiar-el'); }));
  // Vista previa en el mapa
  capaEdicion.clearLayers();
  capaSeleccion.clearLayers();
  ed.elems.forEach((e, i) => {
    if (e.tipo === 'tramo') {
      L.polyline(e.t.coords, { color: '#1b1f22', weight: 11, opacity: 0.5, interactive: false }).addTo(capaEdicion);
      L.polyline(e.t.coords, { color: COLOR[e.t.lvl], weight: 6, interactive: false }).addTo(capaEdicion);
    } else if (e.p) {
      const clase = i === 0 ? 'salida' : i === n - 1 ? 'destino' : 'lugar';
      L.marker(e.p, { interactive: false, icon: L.divIcon({ className: '', html: `<div class="pin-mapa ${clase}">${i === 0 ? 'A' : i === n - 1 ? 'B' : i}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(capaEdicion);
    }
  });
}
function insertarEnEdicion(el) {
  const ed = S.edicion;
  let pos = ed.insertarEn;
  if (pos == null) pos = ed.elems[ed.elems.length - 1].tipo === 'punto' ? ed.elems.length - 1 : ed.elems.length;
  ed.elems.splice(pos, 0, el);
  ed.insertarEn = null;
  pintarEdicion();
}
$('#ed-cancelar').addEventListener('click', () => { S.edicion = null; capaEdicion.clearLayers(); cambiarModo('tramos'); });
$('#ed-sin-entrar').addEventListener('change', (e) => { if (S.edicion) S.edicion.sinEntrar = e.target.checked; });
$('#ed-guardar').addEventListener('click', (e) => ocupado(e.currentTarget, async () => {
  const ed = S.edicion;
  ed.nombre = $('#ed-nombre').value.trim() || ed.nombre;
  const r = await calcularElementos(ed.elems, { sinEntrar: ed.sinEntrar });
  const fav = favDesde({ ...r, fuente: ed.fuente, nota: ed.nota }, ed.nombre, ed.favId);
  await D.idb.put('favoritas', fav);
  S.edicion = null;
  capaEdicion.clearLayers();
  cambiarModo('tramos');
  S.salida = { p: fav.A, etiqueta: fav.elems[0].nombre };
  pintarCamposPunto();
  mostrarResultado({ ...fav, modo: 'tramos', favId: fav.id, nombre: fav.nombre });
  estado('Ruta recalculada y guardada.', { dura: 3000 });
}));

// Las rutas precargadas se añaden a favoritas la primera vez.
async function importarPrecargadas() {
  try {
    const r = await fetch('data/rutas-precargadas.json', { cache: 'no-store' });
    if (!r.ok) return;
    const lista = await r.json();
    let hechas = [];
    try { hechas = JSON.parse(localStorage.getItem('precargadas') || '[]'); } catch {}
    const ahora = Date.now();
    for (const [n, ruta] of lista.entries()) {
      if (hechas.includes(ruta.id)) continue;
      // Fechas escalonadas para que se listen en el mismo orden que el archivo.
      await D.idb.put('favoritas', { ...ruta, pendiente: true, plan: [], fecha: new Date(ahora - n * 1000).toISOString() });
      hechas.push(ruta.id);
    }
    try { localStorage.setItem('precargadas', JSON.stringify(hechas)); } catch {}
  } catch { /* sin conexión: se intentará en otro momento */ }
}

// ---------- Radares (inventario oficial de la DGT) ----------
const capaRadares = L.layerGroup().addTo(mapa);
const ICONO_RADAR = '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="13" height="10" rx="2" fill="none" stroke="#1b1f22" stroke-width="2.4"/><path d="M16 10.5l5-3v9l-5-3" fill="none" stroke="#1b1f22" stroke-width="2.4" stroke-linejoin="round"/></svg>';
async function cargarRadares() {
  try {
    const r = await fetch('data/radares.json', { cache: 'no-cache' });
    if (!r.ok) return;
    S.radares = await r.json();
    pintarRadares();
    if (S.resultado) revisarRadares(S.resultado);
  } catch { /* sin radares */ }
}
const fechaRadares = () => (S.radares?.publicado ? new Date(S.radares.publicado).toLocaleDateString('es-ES') : '');
function popupRadar(x) {
  const tipo = x.tipo === 'tramo' ? 'Radar de tramo (inicio)' : 'Radar fijo';
  return `<div class="pop"><h4>${tipo}</h4><div class="pdat"><span>${esc(x.carretera || '')}${x.pk !== '' ? ` · km ${String(x.pk).replace('.', ',')}` : ''}</span></div>
    <p class="nota" style="margin:0">${esc(x.provincia || '')} · Fuente: DGT, inventario publicado el ${fechaRadares()}.</p></div>`;
}
function pintarRadares() {
  capaRadares.clearLayers();
  if (!S.radares || mapa.getZoom() < 10) return;
  const b = mapa.getBounds();
  const s = b.getSouth() - 0.05, n = b.getNorth() + 0.05, w = b.getWest() - 0.05, e = b.getEast() + 0.05;
  for (const x of S.radares.radares) {
    if (x.p[0] < s || x.p[0] > n || x.p[1] < w || x.p[1] > e) continue;
    if (x.tipo === 'tramo' && x.fin) L.polyline([x.p, x.fin], { color: '#7a3db8', weight: 4, opacity: 0.7, dashArray: '6 8', interactive: false }).addTo(capaRadares);
    L.marker(x.p, { icon: L.divIcon({ className: '', html: `<div class="radar-mapa ${x.tipo}">${ICONO_RADAR}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] }), title: x.tipo === 'tramo' ? 'Radar de tramo' : 'Radar fijo' })
      .bindPopup(popupRadar(x)).addTo(capaRadares);
  }
}
mapa.on('moveend', pintarRadares);
function revisarRadares(r) {
  const el = $('#radares-ruta');
  if (!el || !S.radares || S.resultado !== r) return;
  const muestra = C.remuestrear(r.coords, 50);
  const caja = muestra.reduce((b, [la, lo]) => ({ s: Math.min(b.s, la), n: Math.max(b.n, la), w: Math.min(b.w, lo), e: Math.max(b.e, lo) }), { s: 90, n: -90, w: 180, e: -180 });
  const cands = S.radares.radares.filter((x) => x.p[0] > caja.s - 0.01 && x.p[0] < caja.n + 0.01 && x.p[1] > caja.w - 0.01 && x.p[1] < caja.e + 0.01)
    .map((x) => ({ ...x, nombre: x.carretera }));
  const { enRuta } = C.gasolinerasEnRuta(muestra, cands, 60);
  el.hidden = false;
  if (!enRuta.length) { el.className = 'aviso bien'; el.textContent = `Radares: ninguno de la DGT en la ruta (inventario del ${fechaRadares()}).`; return; }
  const tramos = enRuta.filter((x) => x.tipo === 'tramo').length;
  el.className = 'aviso info';
  el.innerHTML = `<b>${enRuta.length} radar${enRuta.length === 1 ? '' : 'es'} de la DGT en la ruta</b>${tramos ? ` (${tramos} de tramo)` : ''}: `
    + enRuta.map((x) => `km ${Math.round(x.km)} (${esc(x.carretera)}${x.tipo === 'tramo' ? ', tramo' : ''})`).join(', ')
    + `. <span class="nota">Inventario del ${fechaRadares()}. No incluye radares móviles ni de ayuntamientos.</span>`;
}

// ---------- Ajustes ----------
async function pintarDatos() {
  $('#aj-datos').textContent = `Guardadas ${S.celdas.size} zonas con ${S.tramos.size} tramos de curvas.`;
}
$('#btn-ajustes').addEventListener('click', () => {
  const a = D.ajustes();
  $('#aj-clave').value = a.clave;
  $('#aj-autonomia').value = a.autonomia;
  $('#aj-reserva').value = a.reserva;
  $('#aj-peajes').checked = a.peajes;
  $('#aj-perfil').value = a.perfil || 'normal';
  $('#aj-habitual').textContent = a.habitual
    ? `Tu salida habitual es ${a.habitual.etiqueta}. La app arranca allí y la pone como salida.`
    : 'Busca un lugar con la lupa y pulsa "Guardar como salida habitual" para que la app arranque allí.';
  $('#aj-quitar-habitual').hidden = !a.habitual;
  $('#aj-casa').textContent = a.casa ? `Casa: ${a.casa.etiqueta}` : 'Aún no has indicado dónde está tu casa.';
  pintarDatos();
  $('#dlg-ajustes').showModal();
});
$('#aj-guardar').addEventListener('click', () => {
  const a = {
    ...D.ajustes(),
    clave: $('#aj-clave').value.trim(),
    autonomia: Math.max(30, +$('#aj-autonomia').value || 200),
    reserva: Math.max(0, +$('#aj-reserva').value || 0),
    peajes: $('#aj-peajes').checked,
    perfil: $('#aj-perfil').value,
  };
  const cambiaPerfil = a.perfil !== (D.ajustes().perfil || 'normal');
  D.guardarAjustes(a);
  if (cambiaPerfil) {
    // Se vuelven a analizar las carreteras con la nueva sensibilidad.
    S.celdas.clear(); S.tramos.clear(); S.capas.clear(); S.fallidas.clear(); S.cola = [];
    capaTramos.clearLayers(); capaHalo.clearLayers(); capaZonas.clearLayers();
    cargarGuardadas().then(revisarVista);
  }
  $('#peajes').checked = a.peajes;
  $('#dlg-ajustes').close();
  estado('Ajustes guardados.', { dura: 2500 });
});
$('#aj-cambiar-casa').addEventListener('click', () => { $('#dlg-ajustes').close(); abrirBuscador('casa'); });
$('#aj-quitar-habitual').addEventListener('click', () => {
  const a = D.ajustes(); a.habitual = null; D.guardarAjustes(a);
  $('#aj-habitual').textContent = 'Has quitado la salida habitual.';
  $('#aj-quitar-habitual').hidden = true;
});
$('#aj-descargar').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  const celdas = D.celdasDe(MADRID).filter((c) => !S.celdas.has(c.clave));
  let n = 0, fallos = 0;
  for (const c of celdas) {
    n++;
    $('#aj-datos').textContent = `Descargando zona ${n} de ${celdas.length}… Puedes cerrar esta ventana, sigue en marcha.`;
    try { const reg = await D.descargarCelda(c.i, c.j); S.celdas.add(c.clave); anadirTramos(reg.tramos); }
    catch { fallos++; }
  }
  b.disabled = false;
  await pintarDatos();
  if (fallos) $('#aj-datos').textContent += ` ${fallos} zonas no se pudieron descargar; vuelve a pulsar para reintentarlas.`;
});
$('#aj-borrar').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  if (b.dataset.confirmar !== '1') { b.dataset.confirmar = '1'; b.textContent = 'Pulsa otra vez para borrar'; return; }
  b.dataset.confirmar = ''; b.textContent = 'Borrar datos guardados';
  await D.idb.clear('celdas');
  S.celdas.clear(); S.tramos.clear(); S.capas.clear(); S.fallidas.clear(); capaTramos.clearLayers(); capaHalo.clearLayers(); capaZonas.clearLayers();
  pintarDatos();
  revisarVista();
});

// ---------- Mi posición ----------
let vigilancia = null, marcaYo = null, siguiendo = false, bloqueo = null;
async function pedirPantallaEncendida() {
  try { bloqueo = await navigator.wakeLock?.request('screen'); } catch { bloqueo = null; }
}
document.addEventListener('visibilitychange', () => { if (siguiendo && document.visibilityState === 'visible') pedirPantallaEncendida(); });
$('#btn-posicion').addEventListener('click', () => {
  const b = $('#btn-posicion');
  if (vigilancia === null) {
    vigilancia = navigator.geolocation.watchPosition((pos) => {
      const p = [pos.coords.latitude, pos.coords.longitude];
      if (!marcaYo) {
        marcaYo = L.marker(p, { interactive: false, icon: L.divIcon({ className: '', html: '<div class="yo"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(mapa);
        mapa.setView(p, Math.max(mapa.getZoom(), 13));
      } else marcaYo.setLatLng(p);
      if (siguiendo) mapa.panTo(p);
    }, () => {
      estado('No se pudo obtener tu posición. Revisa el permiso de localización de Safari.', { error: true, dura: 6000 });
      navigator.geolocation.clearWatch(vigilancia); vigilancia = null; b.className = 'btn-posicion';
    }, { enableHighAccuracy: true, maximumAge: 3000 });
    b.className = 'btn-posicion activo';
  } else if (!siguiendo) {
    siguiendo = true; b.className = 'btn-posicion siguiendo';
    pedirPantallaEncendida();
    if (marcaYo) mapa.setView(marcaYo.getLatLng(), Math.max(mapa.getZoom(), 14));
    $('#panel').classList.add('plegado');
    estado('Siguiéndote. La pantalla se mantendrá encendida.', { dura: 3000 });
  } else {
    siguiendo = false; navigator.geolocation.clearWatch(vigilancia); vigilancia = null;
    marcaYo?.remove(); marcaYo = null; bloqueo?.release?.(); bloqueo = null;
    b.className = 'btn-posicion';
  }
});
mapa.on('dragstart', () => {
  if (siguiendo) { siguiendo = false; $('#btn-posicion').className = 'btn-posicion activo'; bloqueo?.release?.(); bloqueo = null; }
});

// ---------- Inicio ----------
(async function inicio() {
  const a = D.ajustes();
  $('#peajes').checked = a.peajes;
  if (a.habitual) { S.salida = { p: a.habitual.p, etiqueta: a.habitual.etiqueta }; mapa.setView(a.habitual.p, 11); }
  pintarCamposPunto();
  pintarListaTramos();
  await cargarGuardadas();
  importarPrecargadas();
  cargarRadares();
  revisarVista();
  if (!a.clave) estado('Para empezar, pega tu clave de OpenRouteService en Ajustes (rueda arriba a la derecha).', { dura: 9000 });
})();
