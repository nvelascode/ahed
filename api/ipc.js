/* Ahed · IPC automático.
   Devuelve la serie mensual del IPC de Colombia (variación %, 2010 en adelante).
   Parte de /ipc.json (la base que siempre funciona) y, si el DANE ya publicó meses nuevos,
   los lee del anexo de Excel oficial y los agrega.

   Seguridad contra datos malos: un mes nuevo solo se acepta si la serie del Excel reproduce
   los últimos 12 meses que ya tenemos (con tolerancia de redondeo). Si el DANE cambia el
   formato del archivo y no se puede verificar, la función devuelve ipc.json tal cual y la app
   muestra su aviso de "IPC desactualizado".

   No usa dependencias: solo módulos que ya trae Node.
   Los datos son públicos, por eso no pide código de acceso. */
const zlib = require('zlib');

const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DANE = 'https://www.dane.gov.co/files/operaciones/IPC/';
const UA = 'Mozilla/5.0 (compatible; Ahed/1.0; +https://ahed.vercel.app)';

/* ---------- utilidades de fechas (mes = año*12 + mes0) ---------- */
const keyOf = n => { const y = Math.floor(n / 12), m = n % 12; return y + '-' + String(m + 1).padStart(2, '0'); };
const nOf = (y, m1) => y * 12 + (m1 - 1);
function bogotaNow() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  return { y: +p.slice(0, 4), m: +p.slice(5, 7), d: +p.slice(8, 10) };
}

/* ---------- serie plana ---------- */
function flatten(data) {
  const years = Object.keys(data).map(Number).sort((a, b) => a - b);
  const y0 = years[0], out = [];
  for (let y = y0; y <= years[years.length - 1]; y++) {
    const a = data[y] || data[String(y)];
    if (!Array.isArray(a)) throw new Error('serie con año faltante: ' + y);
    a.forEach(v => out.push(+v));
  }
  return { y0, vals: out };
}
function unflatten(y0, vals) {
  const data = {};
  vals.forEach((v, i) => {
    const y = y0 + Math.floor(i / 12);
    (data[y] = data[y] || []).push(Math.round(v * 100) / 100);
  });
  return data;
}

/* ---------- lector de ZIP / XLSX sin dependencias ---------- */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no es un zip');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < total; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip dañado');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (!/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name)) continue;
    const ds = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(ds, ds + csize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
  }
  return files;
}
const colNum = s => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };

/* Devuelve, por hoja, las celdas numéricas en orden: por columnas y por filas. */
function numericSequences(xlsxBuf) {
  const files = unzip(xlsxBuf);
  const seqs = [];
  Object.keys(files).filter(n => n.startsWith('xl/worksheets/')).forEach(name => {
    const xml = files[name].toString('utf8');
    const cols = new Map(), rows = new Map();
    const re = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1], inner = m[2];
      if (!inner) continue;
      const ref = /r="([A-Z]+)(\d+)"/.exec(attrs);
      if (!ref) continue;
      const t = /\bt="([^"]*)"/.exec(attrs);
      if (t && t[1] !== 'n') continue;                 // texto, fechas ISO, errores: no son números
      const v = /<v>([^<]*)<\/v>/.exec(inner);
      if (!v) continue;
      const x = parseFloat(v[1]);
      if (!isFinite(x)) continue;
      const c = colNum(ref[1]), r = +ref[2];
      if (!cols.has(c)) cols.set(c, []);
      if (!rows.has(r)) rows.set(r, []);
      cols.get(c).push([r, x]);
      rows.get(r).push([c, x]);
    }
    [cols, rows].forEach(g => g.forEach(list => {
      list.sort((a, b) => a[0] - b[0]);
      seqs.push(list.map(z => z[1]));
    }));
  });
  return seqs;
}

/* ---------- reconciliación contra el historial ---------- */
/* known: lista plana de variaciones mensuales (%). seq: números de una columna o fila.
   mode 'indice': seq son niveles del índice -> variación = ratio. mode 'variacion': seq ya son variaciones.
   Devuelve las variaciones de los meses nuevos (después del último mes conocido) o null. */
function extendFrom(seq, known, mode, scale) {
  let pct;
  if (mode === 'indice') {
    const v = seq.filter(x => x >= 10 && x <= 5000);
    if (v.length < 15) return null;
    pct = [];
    for (let i = 1; i < v.length; i++) pct.push((v[i] / v[i - 1] - 1) * 100);
  } else {
    pct = seq.map(x => x * scale);
    if (pct.length < 14 || pct.some(x => Math.abs(x) > 8)) return null;
  }
  const L = known.length - 1, K = 12, tol = mode === 'indice' ? 0.02 : 0.011;
  if (pct.length < K) return null;
  // el mes "L" del historial puede estar en cualquier posición j de la serie con al menos K meses detrás
  for (let j = pct.length - 2; j >= K - 1; j--) {
    let ok = true, moving = false;
    for (let k = 0; k < K; k++) {
      if (Math.abs(pct[j - k] - known[L - k]) > tol) { ok = false; break; }
      if (k && Math.abs(known[L - k] - known[L - k + 1]) > 0.01) moving = true;
    }
    if (ok && moving) {
      const nuevos = pct.slice(j + 1).map(x => Math.round(x * 100) / 100);
      if (nuevos.length && nuevos.length <= 6 && nuevos.every(x => Math.abs(x) <= 5)) return nuevos;
    }
  }
  return null;
}
function findNewMonths(xlsxBuf, known, mode) {
  const seqs = numericSequences(xlsxBuf);
  const scales = mode === 'indice' ? [1] : [1, 100];
  for (const s of seqs) for (const sc of scales) {
    const r = extendFrom(s, known, mode, sc);
    if (r) return r;
  }
  return null;
}

/* ---------- red ---------- */
async function getBuf(url, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 12000);
  try {
    const r = await fetch(url, { signal: c.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: '*/*' } });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    const ab = await r.arrayBuffer();
    if (ab.byteLength > 15e6) throw new Error('archivo demasiado grande');
    return Buffer.from(ab);
  } finally { clearTimeout(t); }
}
async function baseSeries(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const b = await getBuf(proto + '://' + host + '/ipc.json', 8000);
  const j = JSON.parse(b.toString('utf8'));
  const data = j && j.data ? j.data : j;
  const f = flatten(data);
  if (f.vals.length < 24 || f.vals.some(x => !isFinite(x) || Math.abs(x) > 5)) throw new Error('ipc.json no es válido');
  return f;
}

/* ---------- handler ---------- */
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido.' });

  let base;
  try { base = await baseSeries(req); }
  catch (e) { return res.status(502).json({ error: 'No pude leer ipc.json: ' + (e && e.message || 'error') }); }

  const lastN = nOf(base.y0, 1) + base.vals.length - 1;
  const now = bogotaNow();
  const newestN = nOf(now.y, now.m) - 1;                // el mes anterior es el más reciente que podría existir
  const tried = [];
  let nuevos = null, fuente = 'ipc.json';

  for (let n = newestN; n > lastN && !nuevos; n--) {      // del más reciente hacia atrás: el archivo trae toda la historia
    const y = Math.floor(n / 12), mm = n % 12;
    const tags = mm === 8 ? ['sep', 'sept'] : [MES[mm]];
    for (const tag of tags) {
      const folder = tag + y;
      for (const [file, mode] of [['anex-IPC-Indices-' + folder + '.xlsx', 'indice'], ['anex-IPC-Variacion-' + folder + '.xlsx', 'variacion']]) {
        if (nuevos) break;
        const url = DANE + folder + '/' + file;
        try {
          const buf = await getBuf(url, 14000);
          const r = findNewMonths(buf, base.vals, mode);
          tried.push({ url, ok: !!r, nota: r ? undefined : 'no se pudo verificar contra el historial' });
          if (r) { nuevos = r; fuente = 'DANE (' + file + ')'; }
        } catch (e) {
          tried.push({ url, ok: false, nota: e && e.status ? 'HTTP ' + e.status : (e && e.message) || 'error' });
        }
      }
    }
  }

  const vals = nuevos ? base.vals.concat(nuevos) : base.vals;
  const lastKey = keyOf(nOf(base.y0, 1) + vals.length - 1);
  return res.status(200).json({
    data: unflatten(base.y0, vals),
    ultimo: lastKey,
    nuevos: nuevos || [],
    fuente,
    consultado: new Date().toISOString(),
    intentos: tried.slice(0, 6)
  });
};

module.exports._test = { extendFrom, findNewMonths, numericSequences, unzip, flatten, unflatten, keyOf, nOf };
