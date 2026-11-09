// Precalcula los tramos de curvas de Madrid y alrededores para los tres perfiles
// y los guarda en data/curvas/<versión>/<perfil>/<i>_<j>.json, que la app lee directamente.
import fs from 'fs';
import { procesarOverpass, cfgPerfil, PERFILES } from '../js/curvas.js';
import { VERSION, TAM_CELDA, consultaCelda, limites } from '../js/datos.js';

const ZONA = { s: 39.5, n: 41.5, w: -5.25, e: -2.5 }; // Madrid y provincias limítrofes cercanas
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `data/curvas/${VERSION}`;

async function consulta(q) {
  for (let n = 0; n < 4; n++) {
    for (const url of OVERPASS) {
      try {
        const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'User-Agent': 'rutas-moto/1.0 (precalculo mensual, uso personal)' }, signal: AbortSignal.timeout(180000) });
        if (r.ok) return await r.json();
        console.log(`  ${url} → ${r.status}`);
      } catch (e) { console.log(`  ${url} → ${e.message}`); }
      await espera(20000);
    }
  }
  return null;
}

const perfiles = Object.keys(PERFILES);
for (const pf of perfiles) fs.mkdirSync(`${base}/${pf}`, { recursive: true });
const celdas = [];
for (let i = Math.floor(ZONA.s / TAM_CELDA); i < Math.ceil(ZONA.n / TAM_CELDA); i++)
  for (let j = Math.floor(ZONA.w / TAM_CELDA); j < Math.ceil(ZONA.e / TAM_CELDA); j++) celdas.push([i, j]);

const forzar = process.env.FORZAR === '1';
let hechas = 0, fallos = 0;
for (const [i, j] of celdas) {
  const nombre = `${i}_${j}.json`;
  if (!forzar && perfiles.every((pf) => fs.existsSync(`${base}/${pf}/${nombre}`))) { hechas++; continue; }
  // Todos los perfiles usan los mismos tipos de carretera, así que basta una consulta por celda.
  const json = await consulta(consultaCelda(i, j, cfgPerfil('normal')));
  if (!json) { fallos++; console.log(`Celda ${nombre}: sin datos`); continue; }
  for (const pf of perfiles) {
    const tramos = procesarOverpass(json, limites(i, j), cfgPerfil(pf));
    fs.writeFileSync(`${base}/${pf}/${nombre}`, JSON.stringify({ tramos }));
  }
  hechas++;
  console.log(`Celda ${nombre} (${hechas}/${celdas.length}): ${(json.elements || []).length} vías`);
  await espera(4000);
}
fs.writeFileSync(`${base}/indice.json`, JSON.stringify({ version: VERSION, fecha: new Date().toISOString(), zona: ZONA, celdas: celdas.length, fallos }));
console.log(`Terminado: ${hechas} celdas, ${fallos} sin datos.`);
if (fallos > celdas.length / 2) process.exit(1);
