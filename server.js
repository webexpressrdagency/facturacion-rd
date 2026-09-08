'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const [mayor, menor] = process.versions.node.split('.').map(Number);
if (mayor < 22 || (mayor === 22 && menor < 5)) {
  console.error(`\n  ⚠  Este programa necesita Node.js 22.5 o superior (usted tiene ${process.versions.node}).`);
  console.error('     Descárguelo gratis en https://nodejs.org (versión LTS) y vuelva a ejecutar.\n');
  process.exit(1);
}

const { despachar, leerSesion } = require('./src/api');
const { DB_PATH } = require('./src/db');

if (process.env.DEMO === '1') {
  try { require('./src/demo').sembrar(); } catch (err) { console.error('[demo]', err.message); }
}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
// Si la aplicación vive en un subdirectorio del dominio (ej. /facturacion)
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
const PUBLIC = path.join(__dirname, 'public');
const LIMITE = 12 * 1024 * 1024; // 12 MB (permite subir un logo)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

function leerCookie(req, nombre) {
  const c = req.headers.cookie || '';
  for (const parte of c.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nombre) return decodeURIComponent(v.join('='));
  }
  return '';
}

function cuerpo(req) {
  return new Promise((resolve, reject) => {
    let datos = '', size = 0;
    req.on('data', (ch) => {
      size += ch.length;
      if (size > LIMITE) { reject(new Error('Cuerpo demasiado grande')); req.destroy(); return; }
      datos += ch;
    });
    req.on('end', () => {
      if (!datos) return resolve({});
      try { resolve(JSON.parse(datos)); } catch { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function servirEstatico(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const archivo = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!archivo.startsWith(PUBLIC)) { res.writeHead(403).end('Prohibido'); return; }
  const enviarArchivo = (ruta, data) => res.writeHead(200, {
    'Content-Type': MIME[path.extname(ruta).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  }).end(data);

  fs.readFile(archivo, (err, data) => {
    if (!err) return enviarArchivo(archivo, data);
    // Instalado en un subdirectorio (cPanel): busca el archivo por su nombre
    const alterno = path.join(PUBLIC, path.basename(rel));
    fs.readFile(alterno, (e1, d1) => {
      if (!e1 && path.extname(alterno)) return enviarArchivo(alterno, d1);
      // SPA: cualquier ruta desconocida devuelve el index
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404).end('No encontrado'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(idx);
      });
    });
  });
}

async function manejar(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // En plataformas sin servidor (Vercel) la petición llega reescrita a una sola
  // función, así que la ruta original viaja en __ruta. En un servidor propio no
  // existe ese parámetro y se usa la ruta tal cual.
  let ruta = url.searchParams.get('__ruta') || url.pathname;
  url.searchParams.delete('__ruta');
  if (BASE_PATH && ruta.startsWith(BASE_PATH)) ruta = ruta.slice(BASE_PATH.length) || '/';
  // Si el hosting entrega la ruta completa (ej. /facturacion/api/...), la normalizamos
  const posApi = ruta.indexOf('/api/');
  if (posApi > 0) ruta = ruta.slice(posApi);

  if (!ruta.startsWith('/api/') && !ruta.startsWith('/p/')) return servirEstatico(res, ruta);

  // Detrás de un proxy o de cPanel con HTTPS, marcamos la cookie como segura
  const https = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const rutaCookie = BASE_PATH || '/';

  const enviar = (status, obj, cookie) => {
    const cabeceras = { 'Content-Type': 'application/json; charset=utf-8' };
    if (cookie !== undefined) {
      const seguro = https ? ' Secure;' : '';
      cabeceras['Set-Cookie'] = cookie
        ? `sid=${cookie}; HttpOnly;${seguro} Path=${rutaCookie}; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
        : `sid=; HttpOnly;${seguro} Path=${rutaCookie}; SameSite=Lax; Max-Age=0`;
    }
    res.writeHead(status, cabeceras).end(JSON.stringify(obj));
  };

  try {
    const r = despachar(req.method, ruta);
    if (!r) return enviar(404, { error: 'Ruta no encontrada' });

    const token = leerCookie(req, 'sid');
    const sesion = leerSesion(token);
    if (!r.publico && !sesion) return enviar(401, { error: 'Sesión expirada. Inicie sesión de nuevo.' });

    const query = Object.fromEntries(url.searchParams.entries());
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await cuerpo(req) : {};
    const origen = `${https ? 'https' : 'http'}://${req.headers.host || `localhost:${PORT}`}${BASE_PATH}`;
    const salida = (await r.handler({ params: r.params, query, body, sesion, token, origen, headers: req.headers })) || {};

    if (salida.raw !== undefined) {
      const datos = Buffer.isBuffer(salida.raw) ? salida.raw : Buffer.from(String(salida.raw), 'utf8');
      const cabeceras = {
        'Content-Type': salida.contentType || 'text/plain; charset=utf-8',
        'Content-Length': datos.length,
      };
      cabeceras['Content-Disposition'] = salida.inline
        ? (salida.filename ? `inline; filename="${salida.filename}"` : 'inline')
        : `attachment; filename="${salida.filename || 'export.txt'}"`;
      res.writeHead(salida.status || 200, cabeceras).end(datos);
      return;
    }
    return enviar(salida.status || 200, salida.body ?? { ok: true }, salida.cookie);
  } catch (err) {
    console.error('[error]', err);
    return enviar(500, { error: err.message || 'Error interno del servidor' });
  }
}

function arrancar() {
  const servidor = http.createServer(manejar);
  servidor.listen(PORT, HOST, () => {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │  Sistema de Facturación y Recibos            │');
    console.log('  └──────────────────────────────────────────────┘');
    console.log(`   Abra en el navegador:  http://localhost:${PORT}`);
    console.log(`   Usuario inicial: admin   Contraseña: admin123`);
    console.log(`   Base de datos: ${DB_PATH}`);
    console.log('   (Ctrl + C para detener)\n');
  });
  return servidor;
}

// Como servidor propio (npm start) arranca solo; como función en la nube,
// se exporta el manejador y quien lo aloja se encarga de escuchar.
if (require.main === module || process.env.ARRANCAR === '1') arrancar();

module.exports = manejar;
module.exports.manejar = manejar;
module.exports.arrancar = arrancar;
