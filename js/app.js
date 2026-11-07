import * as C from './curvas.js';
import * as D from './datos.js';

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
}).addTo(mapa);
const lienzoTramos = L.canvas({ tolerance: 12 });
const capaTramos = L.layerGroup().addTo(mapa);
const capaSeleccion = L.layerGroup().addTo(mapa);
const capaRuta = L.layerGroup().addTo(mapa);
const capaGas = L.layerGroup().addTo(mapa);
const capaPines = L.layerGroup().addTo(mapa);

function dibujarTramo(t) {
  if (S.capas.has(t.id)) return;
  const pl = L.polyline(t.coords, { renderer: lienzoTramos, color: COLOR[t.lvl], weight: 6, opacity: 0.9, lineCap: 'round' });
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
}

// ---------- Carga de curvas por celdas ----------
async function cargarGuardadas() {
  try {
    const claves = await D.idb.keys('celdas');
    const vals = await D.idb.all('celdas');
    claves.forEach((k) => S.celdas.add(k));
    for (const v of vals) anadirTramos(v.tramos);
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
  const yaEsta = S.elegidos.findIndex((x) => x.t.id === t.id);
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
  for (const tipo of ['salida', 'destino']) {
    if (!S[tipo]) continue;
    if (tipo === 'destino' && S.modo === 'circular') continue;
    if (tipo === 'destino' && S.modo === 'tramos' && finElegido() !== 'destino') continue;
    L.marker(S[tipo].p, { icon: L.divIcon({ className: '', html: `<div class="pin-mapa ${tipo}">${tipo === 'salida' ? 'A' : 'B'}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(capaPines);
  }
}
function fijarPunto(tipo, p, etiqueta) {
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
  $('#dlg-punto-titulo').textContent = modo === 'salida' ? 'Salida' : modo === 'destino' ? 'Destino' : 'Buscar lugar';
  $('#pt-ubicacion').hidden = modo === 'ir';
  $('#pt-mapa').hidden = modo === 'ir';
  const hab = D.ajustes().habitual;
  $('#pt-habitual').hidden = !hab || modo === 'ir';
  if (hab) $('#pt-habitual').textContent = `Usar mi salida habitual: ${hab.etiqueta}`;
  $('#pt-resultados').innerHTML = '';
  $('#pt-texto').value = '';
  $('#dlg-punto').showModal();
  setTimeout(() => $('#pt-texto').focus(), 50);
}
$('#btn-buscar').addEventListener('click', () => abrirBuscador('ir'));
$('#pt-habitual').addEventListener('click', () => {
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
      fijarPunto(puntoEditando, p, 'Mi ubicación');
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
  estado(`Toca el mapa donde quieras la ${puntoEditando === 'salida' ? 'salida' : 'llegada'}.`);
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
}
$$('.pestanas button').forEach((b) => b.addEventListener('click', () => cambiarModo(b.dataset.modo)));
$('#asa').addEventListener('click', () => $('#panel').classList.toggle('plegado'));
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
  const B = fin === 'salida' ? A : fin === 'destino' ? S.destino.p : null;
  const plan = S.elegidos.slice();
  const { pts, marcas } = C.puntosDePaso(A, B, plan);
  estado('Calculando la ruta…');
  const r = await D.ruta(pts, { peajes: peajes() });
  estado('');
  mostrarResultado({ modo: 'tramos', A, B, circular: fin === 'salida', hayVuelta: !!B, plan, marcas, ...r, avisos: [] });
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
  if (S.modo === 'tramos') pintarSeleccion(); else {
    capaSeleccion.clearLayers();
    r.plan.forEach(({ t }) => L.polyline(t.coords, { color: COLOR[t.lvl], weight: 7, opacity: 0.95, interactive: false }).addTo(capaSeleccion));
  }
  mapa.fitBounds(L.latLngBounds(r.coords), { paddingTopLeft: [20, 60], paddingBottomRight: [20, Math.round(window.innerHeight * 0.45)] });

  const rep = C.reparto(r.legs, r.marcas, r.hayVuelta);
  const kmCurvas = r.plan.reduce((s, p) => s + p.t.km, 0);
  const total = r.duration || 1;
  const pc = (x) => `${Math.max(0, (x / total) * 100).toFixed(1)}%`;
  const etiquetaVuelta = r.circular ? 'Vuelta a la salida' : 'Hasta el destino';
  const minRevirados = Math.round(r.plan.reduce((s, p) => s + C.horasTramo(p.t), 0) * 60);
  const filas = [
    ['r-ida', 'Ida hasta las curvas', rep.ida],
    ['r-curvas', 'Zona de curvas', rep.curvas,
      r.plan.length ? `${r.plan.length} tramo${r.plan.length === 1 ? '' : 's'} revirado${r.plan.length === 1 ? '' : 's'}: ${Math.round(kmCurvas)} km, unos ${minRevirados} min. El resto son enlaces entre tramos.` : ''],
  ];
  if (r.hayVuelta) filas.push(['r-vuelta', etiquetaVuelta, rep.vuelta]);
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
    <div id="gas" class="aviso info">Buscando gasolineras en la ruta…</div>
    <div class="acciones-resultado">
      <button class="pri" id="r-gpx">Exportar GPX</button>
      <button class="sec" id="r-google">Google Maps</button>
      <a class="sec ancho2" id="r-waze" href="https://waze.com/ul?ll=${r.A[0].toFixed(5)},${r.A[1].toFixed(5)}&navigate=yes" target="_blank" rel="noopener" style="display:grid;place-items:center;text-decoration:none">Waze: llévame a la salida</a>
    </div>
    <div id="r-etapas" class="etapas" hidden></div>
    <div class="guardar-fav">
      <input id="r-nombre" type="text" value="${esc(r.nombre || nombrePorDefecto)}" aria-label="Nombre de la ruta">
      <button class="sec" id="r-guardar">${r.favId ? 'Actualizar' : 'Guardar'}</button>
    </div>`;
  el.hidden = false;
  $('#r-gpx').addEventListener('click', exportarGPX);
  $('#r-google').addEventListener('click', mostrarEtapasGoogle);
  $('#r-guardar').addEventListener('click', guardarFavorita);
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
  const muestra = C.simplificar(r.coords, 15);
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
  const wpts = [{ p: r.A, nombre: 'Salida' }];
  r.plan.forEach(({ t, rev }, i) => wpts.push({ p: rev ? t.coords[t.coords.length - 1] : t.coords[0], nombre: `Tramo ${i + 1}: ${nombreTramo(t)}` }));
  if (r.B && !r.circular) wpts.push({ p: r.B, nombre: 'Destino' });
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
  const fav = {
    id: r.favId || Date.now(),
    nombre, fecha: new Date().toISOString(),
    modo: r.modo, A: r.A, B: r.B, circular: !!r.circular, hayVuelta: r.hayVuelta,
    plan: r.plan.map(({ t, rev }) => ({ t: { id: t.id, coords: t.coords, km: t.km, lvl: t.lvl, dens: t.dens, ref: t.ref, name: t.name, ids: t.ids }, rev })),
    marcas: r.marcas, legs: r.legs, distance: r.distance, duration: r.duration,
    coords: C.simplificar(r.coords, 4), avisos: r.avisos,
  };
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
  favs.sort((a, b) => b.fecha.localeCompare(a.fecha));
  if (!favs.length) { ul.innerHTML = '<li class="vacio">Aún no has guardado ninguna ruta. Diseña una y pulsa Guardar.</li>'; return; }
  ul.innerHTML = favs.map((f) => `<li>
    <div><b>${esc(f.nombre)}</b><small>${fmtKm(f.distance)} · ${fmtH(f.duration)} · ${f.plan.length} tramos · ${new Date(f.fecha).toLocaleDateString('es-ES')}</small></div>
    <div class="botones"><button class="pri" data-abrir="${f.id}">Abrir</button><button class="sec" data-borrar="${f.id}" aria-label="Borrar ${esc(f.nombre)}">Borrar</button></div>
  </li>`).join('');
  ul.querySelectorAll('[data-abrir]').forEach((b) => b.addEventListener('click', () => {
    const f = favs.find((x) => x.id === +b.dataset.abrir);
    $('#dlg-favoritas').close();
    S.salida = { p: f.A, etiqueta: 'Salida de la ruta guardada' };
    if (f.B && !f.circular) S.destino = { p: f.B, etiqueta: 'Destino de la ruta guardada' };
    S.elegidos = f.plan.map((x) => ({ t: x.t, rev: x.rev }));
    const fin = f.circular ? 'salida' : f.B ? 'destino' : 'nada';
    $(`input[name="fin"][value="${fin}"]`).checked = true;
    $('.modo[data-modo="tramos"] .campo-punto[data-punto="destino"]').hidden = fin !== 'destino';
    cambiarModo('tramos');
    pintarListaTramos();
    mostrarResultado({ ...f, modo: 'tramos', favId: f.id, nombre: f.nombre, avisos: f.avisos || [] });
  }));
  ul.querySelectorAll('[data-borrar]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.confirmar !== '1') { b.dataset.confirmar = '1'; b.textContent = '¿Seguro?'; return; }
    await D.idb.del('favoritas', +b.dataset.borrar);
    pintarFavoritas();
  }));
}
$('#btn-favoritas').addEventListener('click', () => { pintarFavoritas(); $('#dlg-favoritas').showModal(); });

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
  $('#aj-habitual').textContent = a.habitual
    ? `Tu salida habitual es ${a.habitual.etiqueta}. La app arranca allí y la pone como salida.`
    : 'Busca un lugar con la lupa y pulsa "Guardar como salida habitual" para que la app arranque allí.';
  $('#aj-quitar-habitual').hidden = !a.habitual;
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
  };
  D.guardarAjustes(a);
  $('#peajes').checked = a.peajes;
  $('#dlg-ajustes').close();
  estado('Ajustes guardados.', { dura: 2500 });
});
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
  S.celdas.clear(); S.tramos.clear(); S.capas.clear(); S.fallidas.clear(); capaTramos.clearLayers();
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
  revisarVista();
  if (!a.clave) estado('Para empezar, pega tu clave de OpenRouteService en Ajustes (rueda arriba a la derecha).', { dura: 9000 });
})();
