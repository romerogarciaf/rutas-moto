// Calibración: aplica el algoritmo de la app a zonas reales y guarda los resultados por perfil.
import fs from 'fs';
import { procesarOverpass, cfgPerfil, PERFILES } from '../js/curvas.js';

const ZONAS = {
  torrelaguna: { s: 40.66, n: 40.93, w: -3.72, e: -3.35 },
  cadalso: { s: 40.13, n: 40.38, w: -4.62, e: -4.33 },
  sanmartin: { s: 40.26, n: 40.62, w: -4.56, e: -4.22 },
};
const SIN_ASFALTAR = 'unpaved|gravel|fine_gravel|dirt|earth|ground|grass|sand|mud|compacted|pebblestone|rock|wood';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(q) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'User-Agent': 'rutas-moto-calibracion' } });
    if (r.ok) return r.json();
    console.log('Overpass', r.status, 'reintento'); await espera(15000);
  }
  throw new Error('Overpass no responde');
}

fs.mkdirSync('calibracion', { recursive: true });
for (const [nombre, z] of Object.entries(ZONAS)) {
  const b = `${z.s},${z.w},${z.n},${z.e}`;
  const vias = await overpass(`[out:json][timeout:120];
way["highway"~"^(primary|secondary|tertiary|unclassified|primary_link|secondary_link|tertiary_link|trunk|motorway)$"]["surface"!~"^(${SIN_ASFALTAR})$"]["tracktype"!~"."](${b});
out body geom qt;`);
  const lugares = await overpass(`[out:json];node["place"~"^(town|village)$"](${b});out;`);
  const res = { zona: nombre, bbox: z, carreteras: [], lugares: [], perfiles: {} };
  for (const e of vias.elements) if (e.geometry) res.carreteras.push({ hw: e.tags.highway, c: e.geometry.map((g) => [+g.lat.toFixed(5), +g.lon.toFixed(5)]) });
  for (const e of lugares.elements) res.lugares.push({ n: e.tags.name, p: [e.lat, e.lon], t: e.tags.place });
  for (const pf of Object.keys(PERFILES)) {
    const cfg = cfgPerfil(pf);
    const tipos = new Set(['primary', 'secondary', 'tertiary', 'primary_link', 'secondary_link', 'tertiary_link', ...(cfg.sinClasificar ? ['unclassified'] : [])]);
    const json = { elements: vias.elements.filter((e) => tipos.has(e.tags?.highway)) };
    const tramos = procesarOverpass(json, z, cfg);
    res.perfiles[pf] = tramos.map((t) => ({ ref: t.ref, name: t.name, km: +t.km.toFixed(1), dens: t.dens, lvl: t.lvl, c: t.coords }));
    const km = tramos.reduce((s, t) => s + t.km, 0);
    const porNivel = [1, 2, 3].map((l) => tramos.filter((t) => t.lvl === l).length);
    console.log(`${nombre} · ${pf}: ${tramos.length} tramos, ${km.toFixed(0)} km (amarillo ${porNivel[0]}, naranja ${porNivel[1]}, rojo ${porNivel[2]})`);
  }
  fs.writeFileSync(`calibracion/${nombre}.json`, JSON.stringify(res));
  await espera(5000);
}
