'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// En un servidor propio la base vive en ./datos; en un entorno sin disco
// permanente (Vercel y similares) se indica con la variable DB_PATH.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'datos', 'facturacion.db');
const DATA_DIR = path.dirname(DB_PATH);
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  console.error(`No se pudo crear la carpeta ${DATA_DIR}: ${err.message}`);
}

const db = new DatabaseSync(DB_PATH);
// WAL es más rápido, pero necesita memoria compartida y falla en carpetas de red,
// unidades montadas o sincronizadas (Dropbox, iCloud, un recurso compartido).
// Si no está disponible, se usa el registro clásico, que funciona en todas partes.
try {
  db.exec('PRAGMA journal_mode = WAL;');
} catch {
  try { db.exec('PRAGMA journal_mode = DELETE;'); } catch { /* se queda con el modo por defecto */ }
}
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS empresa (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nombre TEXT NOT NULL DEFAULT 'Mi Empresa SRL',
  rnc TEXT DEFAULT '',
  direccion TEXT DEFAULT '',
  telefono TEXT DEFAULT '',
  email TEXT DEFAULT '',
  web TEXT DEFAULT '',
  logo TEXT DEFAULT '',
  moneda TEXT NOT NULL DEFAULT 'DOP',
  simbolo TEXT NOT NULL DEFAULT 'RD$',
  itbis_tasa REAL NOT NULL DEFAULT 18,
  condiciones TEXT DEFAULT 'Pago a 30 días. Gracias por su preferencia.',
  validez_presupuesto INTEGER NOT NULL DEFAULT 15
);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'admin',
  activo INTEGER NOT NULL DEFAULT 1,
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS contactos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL DEFAULT 'cliente',        -- cliente | proveedor
  nombre TEXT NOT NULL,
  rnc TEXT DEFAULT '',
  contacto TEXT DEFAULT '',
  telefono TEXT DEFAULT '',
  email TEXT DEFAULT '',
  direccion TEXT DEFAULT '',
  notas TEXT DEFAULT '',
  activo INTEGER NOT NULL DEFAULT 1,
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT DEFAULT '',
  nombre TEXT NOT NULL,
  descripcion TEXT DEFAULT '',
  unidad TEXT DEFAULT 'ud',
  precio REAL NOT NULL DEFAULT 0,
  costo REAL NOT NULL DEFAULT 0,
  itbis INTEGER NOT NULL DEFAULT 1,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ncf_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,          -- B01, B02, B14, B15, B16...
  descripcion TEXT DEFAULT '',
  prefijo TEXT NOT NULL DEFAULT 'B01',
  desde INTEGER NOT NULL DEFAULT 1,
  hasta INTEGER NOT NULL DEFAULT 1000,
  actual INTEGER NOT NULL DEFAULT 0,
  vence TEXT DEFAULT '',
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS documentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,                  -- factura | presupuesto
  numero TEXT NOT NULL,
  ncf TEXT DEFAULT '',
  ncf_tipo TEXT DEFAULT '',
  contacto_id INTEGER REFERENCES contactos(id),
  cliente_nombre TEXT DEFAULT '',
  cliente_rnc TEXT DEFAULT '',
  fecha TEXT NOT NULL,
  vencimiento TEXT DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'emitida',  -- borrador|emitida|pagada|anulada / presupuesto: borrador|enviado|aprobado|rechazado|facturado
  subtotal REAL NOT NULL DEFAULT 0,
  descuento REAL NOT NULL DEFAULT 0,
  itbis REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  notas TEXT DEFAULT '',
  condiciones TEXT DEFAULT '',
  origen_id INTEGER,                    -- presupuesto convertido en factura
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS documento_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  producto_id INTEGER,
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL DEFAULT 1,
  precio REAL NOT NULL DEFAULT 0,
  descuento REAL NOT NULL DEFAULT 0,   -- porcentaje
  itbis INTEGER NOT NULL DEFAULT 1,
  importe REAL NOT NULL DEFAULT 0,
  orden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ingresos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recibo TEXT NOT NULL,
  fecha TEXT NOT NULL,
  concepto TEXT NOT NULL,
  categoria TEXT DEFAULT 'Ventas',
  contacto_id INTEGER REFERENCES contactos(id),
  documento_id INTEGER REFERENCES documentos(id) ON DELETE SET NULL,
  monto REAL NOT NULL DEFAULT 0,
  metodo TEXT DEFAULT 'Efectivo',
  referencia TEXT DEFAULT '',
  notas TEXT DEFAULT '',
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS gastos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  concepto TEXT NOT NULL,
  categoria TEXT DEFAULT 'General',
  contacto_id INTEGER REFERENCES contactos(id),
  subtotal REAL NOT NULL DEFAULT 0,
  itbis REAL NOT NULL DEFAULT 0,
  monto REAL NOT NULL DEFAULT 0,
  metodo TEXT DEFAULT 'Efectivo',
  ncf TEXT DEFAULT '',
  comprobante TEXT DEFAULT '',
  deducible INTEGER NOT NULL DEFAULT 1,
  notas TEXT DEFAULT '',
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS contadores (
  clave TEXT PRIMARY KEY,
  valor INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ajustes (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS movimientos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL,                 -- entrada | salida | ajuste
  cantidad REAL NOT NULL DEFAULT 0,   -- siempre positiva; el tipo indica el signo
  costo REAL NOT NULL DEFAULT 0,
  existencia REAL NOT NULL DEFAULT 0, -- existencia resultante
  motivo TEXT DEFAULT '',
  documento_id INTEGER REFERENCES documentos(id) ON DELETE SET NULL,
  contacto_id INTEGER REFERENCES contactos(id),
  notas TEXT DEFAULT '',
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS envios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  documento_id INTEGER REFERENCES documentos(id) ON DELETE CASCADE,
  ingreso_id INTEGER REFERENCES ingresos(id) ON DELETE CASCADE,
  canal TEXT NOT NULL,                -- correo | whatsapp
  destino TEXT DEFAULT '',
  asunto TEXT DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'enviado',
  detalle TEXT DEFAULT '',
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS correo (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  activo INTEGER NOT NULL DEFAULT 0,
  servidor TEXT DEFAULT 'smtp.gmail.com',
  puerto INTEGER NOT NULL DEFAULT 587,
  seguridad TEXT NOT NULL DEFAULT 'starttls',   -- starttls | ssl
  usuario TEXT DEFAULT '',
  clave TEXT DEFAULT '',
  remitente TEXT DEFAULT '',
  nombre_remitente TEXT DEFAULT '',
  copia TEXT DEFAULT '',
  asunto_factura TEXT DEFAULT 'Factura {numero} — {empresa}',
  mensaje_factura TEXT DEFAULT 'Estimado(a) {cliente}:\n\nAdjunto encontrará la factura {numero} por un monto de {total}.\n\nQuedamos a la orden.\n\n{empresa}'
);

CREATE INDEX IF NOT EXISTS ix_mov_producto ON movimientos(producto_id, fecha);

CREATE INDEX IF NOT EXISTS ix_doc_tipo_fecha ON documentos(tipo, fecha);
CREATE INDEX IF NOT EXISTS ix_ing_fecha ON ingresos(fecha);
CREATE INDEX IF NOT EXISTS ix_gas_fecha ON gastos(fecha);
`);

// ---- migraciones (añade columnas nuevas a bases de datos ya existentes) ----
function columnas(tabla) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
}
function agregarColumna(tabla, nombre, definicion) {
  if (!columnas(tabla).includes(nombre)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${nombre} ${definicion}`);
}
agregarColumna('productos', 'inventario', 'INTEGER NOT NULL DEFAULT 0');
agregarColumna('productos', 'existencia', 'REAL NOT NULL DEFAULT 0');
agregarColumna('productos', 'minimo', 'REAL NOT NULL DEFAULT 0');
agregarColumna('documentos', 'token', "TEXT DEFAULT ''");
agregarColumna('documentos', 'stock_aplicado', 'INTEGER NOT NULL DEFAULT 0');
agregarColumna('ingresos', 'token', "TEXT DEFAULT ''");
agregarColumna('empresa', 'url_publica', "TEXT DEFAULT ''");

// ---- semillas -------------------------------------------------------------
function hashPassword(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(pass, salt, 32).toString('hex');
  return `${salt}:${dk}`;
}
function verifyPassword(pass, stored) {
  try {
    const [salt, dk] = String(stored).split(':');
    const calc = crypto.scryptSync(pass, salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(dk, 'hex'));
  } catch { return false; }
}

if (!db.prepare('SELECT id FROM empresa WHERE id = 1').get()) {
  db.prepare('INSERT INTO empresa (id) VALUES (1)').run();
}
if (!db.prepare('SELECT id FROM correo WHERE id = 1').get()) {
  db.prepare('INSERT INTO correo (id) VALUES (1)').run();
}
if (!db.prepare('SELECT COUNT(*) c FROM usuarios').get().c) {
  db.prepare('INSERT INTO usuarios (usuario, nombre, hash, rol) VALUES (?,?,?,?)')
    .run('admin', 'Administrador', hashPassword('admin123'), 'admin');
}
if (!db.prepare('SELECT COUNT(*) c FROM ncf_series').get().c) {
  const ins = db.prepare('INSERT INTO ncf_series (tipo, descripcion, prefijo, desde, hasta, actual, activo) VALUES (?,?,?,?,?,?,?)');
  ins.run('B01', 'Crédito Fiscal', 'B01', 1, 500, 0, 1);
  ins.run('B02', 'Consumo', 'B02', 1, 500, 0, 1);
  ins.run('B14', 'Régimen Especial', 'B14', 1, 100, 0, 0);
  ins.run('B15', 'Gubernamental', 'B15', 1, 100, 0, 0);
}
for (const k of ['factura', 'presupuesto', 'recibo']) {
  db.prepare('INSERT OR IGNORE INTO contadores (clave, valor) VALUES (?, 0)').run(k);
}

// ---- utilidades -----------------------------------------------------------
function siguienteNumero(clave, prefijo) {
  const row = db.prepare('SELECT valor FROM contadores WHERE clave = ?').get(clave);
  const n = (row ? row.valor : 0) + 1;
  db.prepare('UPDATE contadores SET valor = ? WHERE clave = ?').run(n, clave);
  const anio = new Date().getFullYear();
  return `${prefijo}-${anio}-${String(n).padStart(5, '0')}`;
}

function siguienteNCF(tipo) {
  const s = db.prepare('SELECT * FROM ncf_series WHERE tipo = ? AND activo = 1').get(tipo);
  if (!s) return null;
  const prox = Math.max(s.actual + 1, s.desde);
  if (prox > s.hasta) return { error: `La secuencia NCF ${tipo} está agotada (${s.desde}-${s.hasta}). Configure un nuevo rango.` };
  db.prepare('UPDATE ncf_series SET actual = ? WHERE id = ?').run(prox, s.id);
  return { ncf: `${s.prefijo}${String(prox).padStart(8, '0')}`, disponibles: s.hasta - prox };
}

function nuevoToken() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = { db, hashPassword, verifyPassword, siguienteNumero, siguienteNCF, nuevoToken, DB_PATH, DATA_DIR };
