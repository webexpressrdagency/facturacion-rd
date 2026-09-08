'use strict';
const crypto = require('node:crypto');
const { db, hashPassword, verifyPassword, siguienteNumero, siguienteNCF, nuevoToken } = require('./db');
const { pdfDocumento, pdfRecibo } = require('./plantillas');
const correo = require('./correo');

// ------------------------------------------------------------------ sesiones
/* La sesión viaja firmada dentro de la propia cookie (HMAC-SHA256). Así sigue
   siendo válida aunque el servidor se reinicie o haya varias instancias
   —como en un hosting sin disco permanente—, sin guardar nada en memoria. */
const DIA = 24 * 60 * 60 * 1000;
const VIGENCIA = 7 * DIA;
const revocadas = new Set();   // cierres de sesión de esta instancia

const SECRETO = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const fila = db.prepare("SELECT valor FROM ajustes WHERE clave = 'secreto'").get();
  if (fila && fila.valor) return fila.valor;
  const nuevo = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT OR REPLACE INTO ajustes (clave, valor) VALUES (?, ?)').run('secreto', nuevo);
  return nuevo;
})();

const b64url = (b) => Buffer.from(b).toString('base64url');
const firmar = (datos) => crypto.createHmac('sha256', SECRETO).update(datos).digest('base64url');

function crearSesion(u) {
  const cuerpo = b64url(JSON.stringify({
    id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, exp: Date.now() + VIGENCIA,
  }));
  return `${cuerpo}.${firmar(cuerpo)}`;
}

function leerSesion(token) {
  if (!token || revocadas.has(token)) return null;
  const i = String(token).lastIndexOf('.');
  if (i < 1) return null;
  const cuerpo = token.slice(0, i);
  const firma = token.slice(i + 1);
  const esperada = firmar(cuerpo);
  if (firma.length !== esperada.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) return null;
  try {
    const s = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    if (!s.exp || s.exp < Date.now()) return null;
    return s;
  } catch { return null; }
}

// ------------------------------------------------------------------ helpers
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const txt = (v) => (v === undefined || v === null ? '' : String(v));
const hoy = () => new Date().toISOString().slice(0, 10);

function empresa() { return db.prepare('SELECT * FROM empresa WHERE id = 1').get(); }

function calcularDocumento(items, descuentoGlobal, tasaItbis) {
  let subtotal = 0, itbis = 0;
  const detalle = items.map((it, i) => {
    const cantidad = num(it.cantidad);
    const precio = num(it.precio);
    const desc = num(it.descuento);
    const importe = r2(cantidad * precio * (1 - desc / 100));
    subtotal += importe;
    return { ...it, cantidad, precio, descuento: desc, importe, itbis: it.itbis ? 1 : 0, orden: i };
  });
  subtotal = r2(subtotal);
  const dg = Math.min(num(descuentoGlobal), subtotal);
  const factor = subtotal > 0 ? (subtotal - dg) / subtotal : 0;
  for (const it of detalle) if (it.itbis) itbis += it.importe * factor * (tasaItbis / 100);
  itbis = r2(itbis);
  const base = r2(subtotal - dg);
  return { detalle, subtotal, descuento: r2(dg), itbis, total: r2(base + itbis) };
}

function docCompleto(id) {
  const d = db.prepare('SELECT * FROM documentos WHERE id = ?').get(id);
  if (!d) return null;
  d.items = db.prepare('SELECT * FROM documento_items WHERE documento_id = ? ORDER BY orden, id').all(id);
  const p = db.prepare('SELECT COALESCE(SUM(monto),0) s FROM ingresos WHERE documento_id = ?').get(id);
  d.pagado = r2(p.s);
  d.balance = r2(d.total - d.pagado);
  d.pagos = db.prepare('SELECT * FROM ingresos WHERE documento_id = ? ORDER BY fecha, id').all(id);
  if (d.contacto_id) d.cliente = db.prepare('SELECT * FROM contactos WHERE id = ?').get(d.contacto_id) || null;
  return d;
}

function estadoAuto(id) {
  const d = db.prepare('SELECT tipo, total, estado FROM documentos WHERE id = ?').get(id);
  if (!d || d.tipo !== 'factura' || d.estado === 'anulada' || d.estado === 'borrador') return;
  const pagado = r2(db.prepare('SELECT COALESCE(SUM(monto),0) s FROM ingresos WHERE documento_id = ?').get(id).s);
  let estado = 'emitida';
  if (pagado >= d.total - 0.009 && d.total > 0) estado = 'pagada';
  else if (pagado > 0) estado = 'parcial';
  db.prepare('UPDATE documentos SET estado = ? WHERE id = ?').run(estado, id);
}

// ------------------------------------------------------- documentos y recibos
function reciboCompleto(id) {
  return db.prepare(`SELECT i.*, c.nombre cliente, c.rnc cliente_rnc, c.direccion cliente_direccion, c.email cliente_email,
    c.telefono cliente_telefono, d.numero factura, d.total factura_total
    FROM ingresos i LEFT JOIN contactos c ON c.id = i.contacto_id
    LEFT JOIN documentos d ON d.id = i.documento_id WHERE i.id = ?`).get(id);
}

function nombreArchivo(x) {
  return String(x || 'documento').replace(/[^A-Za-z0-9._-]/g, '_') + '.pdf';
}

/** Enlace público de un documento o recibo; lo crea si aún no existe. */
function asegurarToken(tabla, id) {
  const fila = db.prepare(`SELECT token FROM ${tabla} WHERE id = ?`).get(id);
  if (!fila) return null;
  if (fila.token) return fila.token;
  const t = nuevoToken();
  db.prepare(`UPDATE ${tabla} SET token = ? WHERE id = ?`).run(t, id);
  return t;
}

/** Teléfono a formato internacional para wa.me (por defecto República Dominicana). */
function telefonoWhatsApp(tel) {
  let n = String(tel || '').replace(/\D/g, '');
  if (!n) return '';
  if (n.length === 10 && /^(809|829|849)/.test(n)) n = '1' + n;      // RD sin código de país
  else if (n.length === 11 && n.startsWith('1')) { /* ya lo trae */ }
  else if (n.length === 7) return '';                                 // incompleto
  return n;
}

// ------------------------------------------------------------------ inventario
function registrarMovimiento({ producto_id, tipo, cantidad, costo, motivo, documento_id, contacto_id, fecha, notas }) {
  const p = db.prepare('SELECT * FROM productos WHERE id = ?').get(producto_id);
  if (!p || !p.inventario) return null;
  const cant = Math.abs(num(cantidad));
  if (!cant && tipo !== 'ajuste') return null;
  let existencia;
  if (tipo === 'entrada') existencia = r2(p.existencia + cant);
  else if (tipo === 'salida') existencia = r2(p.existencia - cant);
  else existencia = r2(num(cantidad));            // ajuste: cantidad = existencia final
  db.prepare('UPDATE productos SET existencia = ? WHERE id = ?').run(existencia, producto_id);
  db.prepare(`INSERT INTO movimientos (producto_id,fecha,tipo,cantidad,costo,existencia,motivo,documento_id,contacto_id,notas)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(producto_id, txt(fecha) || hoy(), tipo,
    tipo === 'ajuste' ? r2(existencia - p.existencia) : cant, num(costo) || p.costo, existencia,
    txt(motivo), documento_id || null, contacto_id || null, txt(notas));
  return existencia;
}

/** Devuelve al inventario lo que una factura había descontado. */
function revertirStock(documentoId) {
  const d = db.prepare('SELECT stock_aplicado, numero FROM documentos WHERE id = ?').get(documentoId);
  if (!d || !d.stock_aplicado) return;
  const items = db.prepare('SELECT * FROM documento_items WHERE documento_id = ?').all(documentoId);
  for (const it of items) {
    if (!it.producto_id) continue;
    registrarMovimiento({
      producto_id: it.producto_id, tipo: 'entrada', cantidad: it.cantidad,
      motivo: `Reverso factura ${d.numero}`, documento_id: documentoId,
    });
  }
  db.prepare('UPDATE documentos SET stock_aplicado = 0 WHERE id = ?').run(documentoId);
}

/** Descuenta del inventario las líneas de una factura. Devuelve avisos de faltantes. */
function aplicarStock(documentoId) {
  const d = db.prepare('SELECT tipo, estado, numero, contacto_id, fecha, stock_aplicado FROM documentos WHERE id = ?').get(documentoId);
  if (!d || d.tipo !== 'factura' || d.stock_aplicado) return [];
  if (['borrador', 'anulada'].includes(d.estado)) return [];
  const items = db.prepare('SELECT * FROM documento_items WHERE documento_id = ?').all(documentoId);
  const avisos = [];
  let aplicó = false;
  for (const it of items) {
    if (!it.producto_id) continue;
    const p = db.prepare('SELECT * FROM productos WHERE id = ?').get(it.producto_id);
    if (!p || !p.inventario) continue;
    if (p.existencia < it.cantidad) {
      avisos.push(`${p.nombre}: existencia ${r2(p.existencia)} ${p.unidad}, se facturaron ${it.cantidad}. Queda en ${r2(p.existencia - it.cantidad)}.`);
    }
    registrarMovimiento({
      producto_id: it.producto_id, tipo: 'salida', cantidad: it.cantidad, costo: p.costo,
      motivo: `Factura ${d.numero}`, documento_id: documentoId, contacto_id: d.contacto_id, fecha: d.fecha,
    });
    aplicó = true;
  }
  if (aplicó) db.prepare('UPDATE documentos SET stock_aplicado = 1 WHERE id = ?').run(documentoId);
  return avisos;
}

function bajoMinimo() {
  return db.prepare(`SELECT id, codigo, nombre, unidad, existencia, minimo, precio, costo FROM productos
    WHERE inventario = 1 AND activo = 1 AND existencia <= minimo ORDER BY (existencia - minimo), nombre`).all();
}

// ------------------------------------------------------------------ CRUD gen
function listaContactos(q) {
  let sql = 'SELECT * FROM contactos WHERE 1=1';
  const p = [];
  if (q.tipo) { sql += ' AND tipo = ?'; p.push(q.tipo); }
  if (q.q) { sql += ' AND (nombre LIKE ? OR rnc LIKE ? OR email LIKE ?)'; const t = `%${q.q}%`; p.push(t, t, t); }
  if (q.activo !== undefined && q.activo !== '') { sql += ' AND activo = ?'; p.push(Number(q.activo)); }
  sql += ' ORDER BY nombre';
  return db.prepare(sql).all(...p);
}

// ------------------------------------------------------------------ reportes
function rangoDefault(q) {
  const desde = q.desde || `${new Date().getFullYear()}-01-01`;
  const hasta = q.hasta || hoy();
  return { desde, hasta };
}

function resumen(q) {
  const { desde, hasta } = rangoDefault(q);
  const ing = db.prepare('SELECT COALESCE(SUM(monto),0) s, COUNT(*) c FROM ingresos WHERE fecha BETWEEN ? AND ?').get(desde, hasta);
  const gas = db.prepare('SELECT COALESCE(SUM(monto),0) s, COUNT(*) c FROM gastos WHERE fecha BETWEEN ? AND ?').get(desde, hasta);
  const fact = db.prepare(`SELECT COALESCE(SUM(total),0) s, COUNT(*) c FROM documentos
      WHERE tipo='factura' AND estado <> 'anulada' AND estado <> 'borrador' AND fecha BETWEEN ? AND ?`).get(desde, hasta);
  const porCobrar = db.prepare(`SELECT COALESCE(SUM(d.total - COALESCE((SELECT SUM(i.monto) FROM ingresos i WHERE i.documento_id = d.id),0)),0) s,
      COUNT(*) c FROM documentos d WHERE d.tipo='factura' AND d.estado IN ('emitida','parcial')`).get();
  const vencidas = db.prepare(`SELECT COUNT(*) c FROM documentos d WHERE d.tipo='factura' AND d.estado IN ('emitida','parcial')
      AND d.vencimiento <> '' AND d.vencimiento < ?`).get(hoy());
  const presup = db.prepare(`SELECT COALESCE(SUM(total),0) s, COUNT(*) c FROM documentos WHERE tipo='presupuesto' AND fecha BETWEEN ? AND ?`).get(desde, hasta);
  const presupAprob = db.prepare(`SELECT COUNT(*) c FROM documentos WHERE tipo='presupuesto' AND estado='aprobado'`).get();
  const itbisVentas = db.prepare(`SELECT COALESCE(SUM(itbis),0) s FROM documentos WHERE tipo='factura' AND estado NOT IN ('anulada','borrador') AND fecha BETWEEN ? AND ?`).get(desde, hasta);
  const itbisCompras = db.prepare(`SELECT COALESCE(SUM(itbis),0) s FROM gastos WHERE deducible=1 AND fecha BETWEEN ? AND ?`).get(desde, hasta);

  // series mensuales (12 meses hacia atrás desde 'hasta')
  const meses = [];
  const base = new Date(hasta + 'T00:00:00');
  for (let i = 11; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const serie = meses.map((m) => ({
    mes: m,
    ingresos: r2(db.prepare("SELECT COALESCE(SUM(monto),0) s FROM ingresos WHERE substr(fecha,1,7) = ?").get(m).s),
    gastos: r2(db.prepare("SELECT COALESCE(SUM(monto),0) s FROM gastos WHERE substr(fecha,1,7) = ?").get(m).s),
  }));

  const gastosCat = db.prepare(`SELECT categoria, COALESCE(SUM(monto),0) total FROM gastos
      WHERE fecha BETWEEN ? AND ? GROUP BY categoria ORDER BY total DESC LIMIT 10`).all(desde, hasta);
  const topClientes = db.prepare(`SELECT COALESCE(c.nombre, d.cliente_nombre, 'Sin cliente') nombre, COALESCE(SUM(d.total),0) total
      FROM documentos d LEFT JOIN contactos c ON c.id = d.contacto_id
      WHERE d.tipo='factura' AND d.estado NOT IN ('anulada','borrador') AND d.fecha BETWEEN ? AND ?
      GROUP BY nombre ORDER BY total DESC LIMIT 8`).all(desde, hasta);

  const inv = db.prepare(`SELECT COALESCE(SUM(existencia * costo),0) valor, COUNT(*) n FROM productos WHERE inventario = 1 AND activo = 1`).get();

  return {
    desde, hasta,
    inventarioValor: r2(inv.valor), inventarioArticulos: inv.n, bajoMinimo: bajoMinimo(),
    ingresos: r2(ing.s), nIngresos: ing.c,
    gastos: r2(gas.s), nGastos: gas.c,
    balance: r2(ing.s - gas.s),
    facturado: r2(fact.s), nFacturas: fact.c,
    porCobrar: r2(porCobrar.s), nPorCobrar: porCobrar.c, nVencidas: vencidas.c,
    presupuestado: r2(presup.s), nPresupuestos: presup.c, nAprobados: presupAprob.c,
    itbisVentas: r2(itbisVentas.s), itbisCompras: r2(itbisCompras.s), itbisPagar: r2(itbisVentas.s - itbisCompras.s),
    serie, gastosCat, topClientes,
  };
}

// ------------------------------------------------------------------ rutas
const rutas = [];
const on = (metodo, patron, handler, publico = false) => {
  const partes = patron.split('/').filter(Boolean);
  rutas.push({ metodo, partes, handler, publico });
};

function despachar(metodo, ruta, ctx) {
  const partes = ruta.split('/').filter(Boolean);
  for (const r of rutas) {
    if (r.metodo !== metodo || r.partes.length !== partes.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < partes.length; i++) {
      if (r.partes[i].startsWith(':')) params[r.partes[i].slice(1)] = decodeURIComponent(partes[i]);
      else if (r.partes[i] !== partes[i]) { ok = false; break; }
    }
    if (ok) return { ...r, params };
  }
  return null;
}

// ---- auth
on('POST', '/api/auth/login', (c) => {
  const { usuario, password } = c.body;
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1').get(txt(usuario).trim());
  if (!u || !verifyPassword(txt(password), u.hash)) return { status: 401, body: { error: 'Usuario o contraseña incorrectos' } };
  const token = crearSesion(u);
  return { status: 200, body: { usuario: u.usuario, nombre: u.nombre, rol: u.rol }, cookie: token };
}, true);

on('POST', '/api/auth/logout', (c) => { if (c.token) revocadas.add(c.token); return { status: 200, body: { ok: true }, cookie: '' }; }, true);
on('GET', '/api/auth/me', (c) => (c.sesion ? { body: c.sesion } : { status: 401, body: { error: 'No autenticado' } }), true);

on('POST', '/api/auth/password', (c) => {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(c.sesion.id);
  if (!verifyPassword(txt(c.body.actual), u.hash)) return { status: 400, body: { error: 'La contraseña actual no es correcta' } };
  if (txt(c.body.nueva).length < 6) return { status: 400, body: { error: 'La nueva contraseña debe tener al menos 6 caracteres' } };
  db.prepare('UPDATE usuarios SET hash = ? WHERE id = ?').run(hashPassword(txt(c.body.nueva)), u.id);
  return { body: { ok: true } };
});

on('GET', '/api/usuarios', () => ({ body: db.prepare('SELECT id, usuario, nombre, rol, activo, creado FROM usuarios ORDER BY usuario').all() }));
on('POST', '/api/usuarios', (c) => {
  const b = c.body;
  if (!txt(b.usuario).trim()) return { status: 400, body: { error: 'El usuario es obligatorio' } };
  if (txt(b.password).length < 6) return { status: 400, body: { error: 'La contraseña debe tener al menos 6 caracteres' } };
  if (db.prepare('SELECT id FROM usuarios WHERE usuario = ?').get(txt(b.usuario).trim())) return { status: 400, body: { error: 'Ese usuario ya existe' } };
  const info = db.prepare('INSERT INTO usuarios (usuario, nombre, hash, rol, activo) VALUES (?,?,?,?,1)')
    .run(txt(b.usuario).trim(), txt(b.nombre), hashPassword(txt(b.password)), txt(b.rol) || 'operador');
  return { body: { id: Number(info.lastInsertRowid) } };
});
on('DELETE', '/api/usuarios/:id', (c) => {
  if (Number(c.params.id) === c.sesion.id) return { status: 400, body: { error: 'No puede eliminar su propio usuario' } };
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(Number(c.params.id));
  return { body: { ok: true } };
});

// ---- empresa
on('GET', '/api/empresa', () => ({ body: empresa() }));
on('PUT', '/api/empresa', (c) => {
  const b = c.body, e = empresa();
  db.prepare(`UPDATE empresa SET nombre=?, rnc=?, direccion=?, telefono=?, email=?, web=?, logo=?, moneda=?, simbolo=?,
    itbis_tasa=?, condiciones=?, validez_presupuesto=?, url_publica=? WHERE id = 1`).run(
    txt(b.nombre) || e.nombre, txt(b.rnc), txt(b.direccion), txt(b.telefono), txt(b.email), txt(b.web),
    txt(b.logo), txt(b.moneda) || 'DOP', txt(b.simbolo) || 'RD$', num(b.itbis_tasa),
    txt(b.condiciones), Math.max(0, parseInt(b.validez_presupuesto, 10) || 15),
    txt(b.url_publica).replace(/\/+$/, ''));
  return { body: empresa() };
});

// ---- contactos
on('GET', '/api/contactos', (c) => ({ body: listaContactos(c.query) }));
on('GET', '/api/contactos/:id', (c) => {
  const x = db.prepare('SELECT * FROM contactos WHERE id = ?').get(Number(c.params.id));
  if (!x) return { status: 404, body: { error: 'No encontrado' } };
  x.documentos = db.prepare('SELECT id, tipo, numero, fecha, total, estado FROM documentos WHERE contacto_id = ? ORDER BY fecha DESC, id DESC LIMIT 50').all(x.id);
  return { body: x };
});
on('POST', '/api/contactos', (c) => {
  const b = c.body;
  if (!txt(b.nombre).trim()) return { status: 400, body: { error: 'El nombre es obligatorio' } };
  const info = db.prepare(`INSERT INTO contactos (tipo,nombre,rnc,contacto,telefono,email,direccion,notas,activo)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(txt(b.tipo) || 'cliente', txt(b.nombre).trim(), txt(b.rnc), txt(b.contacto),
    txt(b.telefono), txt(b.email), txt(b.direccion), txt(b.notas), b.activo === 0 ? 0 : 1);
  return { body: db.prepare('SELECT * FROM contactos WHERE id = ?').get(Number(info.lastInsertRowid)) };
});
on('PUT', '/api/contactos/:id', (c) => {
  const b = c.body, id = Number(c.params.id);
  if (!db.prepare('SELECT id FROM contactos WHERE id = ?').get(id)) return { status: 404, body: { error: 'No encontrado' } };
  db.prepare(`UPDATE contactos SET tipo=?, nombre=?, rnc=?, contacto=?, telefono=?, email=?, direccion=?, notas=?, activo=? WHERE id=?`)
    .run(txt(b.tipo) || 'cliente', txt(b.nombre).trim(), txt(b.rnc), txt(b.contacto), txt(b.telefono),
      txt(b.email), txt(b.direccion), txt(b.notas), b.activo === 0 ? 0 : 1, id);
  return { body: db.prepare('SELECT * FROM contactos WHERE id = ?').get(id) };
});
on('DELETE', '/api/contactos/:id', (c) => {
  const id = Number(c.params.id);
  const usos = db.prepare('SELECT COUNT(*) n FROM documentos WHERE contacto_id = ?').get(id).n
    + db.prepare('SELECT COUNT(*) n FROM gastos WHERE contacto_id = ?').get(id).n;
  if (usos) { db.prepare('UPDATE contactos SET activo = 0 WHERE id = ?').run(id); return { body: { ok: true, desactivado: true } }; }
  db.prepare('DELETE FROM contactos WHERE id = ?').run(id);
  return { body: { ok: true } };
});

// ---- productos
on('GET', '/api/productos', (c) => {
  let sql = 'SELECT * FROM productos WHERE 1=1'; const p = [];
  if (c.query.q) { sql += ' AND (nombre LIKE ? OR codigo LIKE ?)'; const t = `%${c.query.q}%`; p.push(t, t); }
  if (c.query.activo !== undefined && c.query.activo !== '') { sql += ' AND activo = ?'; p.push(Number(c.query.activo)); }
  return { body: db.prepare(sql + ' ORDER BY nombre').all(...p) };
});
on('POST', '/api/productos', (c) => {
  const b = c.body;
  if (!txt(b.nombre).trim()) return { status: 400, body: { error: 'El nombre es obligatorio' } };
  const info = db.prepare(`INSERT INTO productos (codigo,nombre,descripcion,unidad,precio,costo,itbis,activo,inventario,existencia,minimo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(txt(b.codigo), txt(b.nombre).trim(), txt(b.descripcion), txt(b.unidad) || 'ud',
    num(b.precio), num(b.costo), b.itbis === 0 ? 0 : 1, b.activo === 0 ? 0 : 1,
    b.inventario ? 1 : 0, 0, num(b.minimo));
  const id = Number(info.lastInsertRowid);
  if (b.inventario && num(b.existencia) !== 0) {
    registrarMovimiento({ producto_id: id, tipo: 'entrada', cantidad: num(b.existencia), costo: num(b.costo), motivo: 'Existencia inicial' });
  }
  return { body: db.prepare('SELECT * FROM productos WHERE id = ?').get(id) };
});
on('PUT', '/api/productos/:id', (c) => {
  const b = c.body, id = Number(c.params.id);
  const prev = db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
  if (!prev) return { status: 404, body: { error: 'Artículo no encontrado' } };
  db.prepare(`UPDATE productos SET codigo=?, nombre=?, descripcion=?, unidad=?, precio=?, costo=?, itbis=?, activo=?,
    inventario=?, minimo=? WHERE id=?`)
    .run(txt(b.codigo), txt(b.nombre).trim(), txt(b.descripcion), txt(b.unidad) || 'ud', num(b.precio), num(b.costo),
      b.itbis === 0 ? 0 : 1, b.activo === 0 ? 0 : 1, b.inventario ? 1 : 0, num(b.minimo), id);
  // Si acaba de activar el inventario, la existencia indicada entra como movimiento inicial
  if (b.inventario && !prev.inventario && num(b.existencia) !== 0) {
    registrarMovimiento({ producto_id: id, tipo: 'entrada', cantidad: num(b.existencia), costo: num(b.costo), motivo: 'Existencia inicial' });
  }
  return { body: db.prepare('SELECT * FROM productos WHERE id = ?').get(id) };
});

// ---- inventario
on('GET', '/api/inventario', (c) => {
  let sql = `SELECT id, codigo, nombre, unidad, existencia, minimo, costo, precio, activo,
    ROUND(existencia * costo, 2) valor FROM productos WHERE inventario = 1`;
  const p = [];
  if (c.query.q) { sql += ' AND (nombre LIKE ? OR codigo LIKE ?)'; const t = `%${c.query.q}%`; p.push(t, t); }
  if (c.query.bajo === '1') sql += ' AND existencia <= minimo';
  const filas = db.prepare(sql + ' ORDER BY nombre').all(...p);
  const valor = r2(filas.reduce((a, x) => a + x.valor, 0));
  return { body: { filas, valor, bajos: filas.filter((x) => x.existencia <= x.minimo).length } };
});

on('GET', '/api/inventario/:id/movimientos', (c) => {
  const id = Number(c.params.id);
  const producto = db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
  if (!producto) return { status: 404, body: { error: 'Artículo no encontrado' } };
  const movimientos = db.prepare(`SELECT m.*, d.numero factura, ct.nombre contacto FROM movimientos m
    LEFT JOIN documentos d ON d.id = m.documento_id LEFT JOIN contactos ct ON ct.id = m.contacto_id
    WHERE m.producto_id = ? ORDER BY m.id DESC LIMIT 200`).all(id);
  return { body: { producto, movimientos } };
});

on('POST', '/api/inventario/movimiento', (c) => {
  const b = c.body;
  const id = Number(b.producto_id);
  const p = db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
  if (!p) return { status: 400, body: { error: 'Seleccione un artículo' } };
  if (!p.inventario) return { status: 400, body: { error: `"${p.nombre}" no lleva control de inventario. Actívelo en su ficha.` } };
  const tipo = ['entrada', 'salida', 'ajuste'].includes(txt(b.tipo)) ? txt(b.tipo) : 'entrada';
  if (tipo !== 'ajuste' && num(b.cantidad) <= 0) return { status: 400, body: { error: 'La cantidad debe ser mayor que cero' } };
  const existencia = registrarMovimiento({
    producto_id: id, tipo, cantidad: num(b.cantidad), costo: num(b.costo) || p.costo,
    motivo: txt(b.motivo) || (tipo === 'entrada' ? 'Compra' : tipo === 'salida' ? 'Salida manual' : 'Ajuste de conteo'),
    contacto_id: b.contacto_id ? Number(b.contacto_id) : null, fecha: txt(b.fecha), notas: txt(b.notas),
  });
  if (num(b.costo) > 0 && tipo === 'entrada') db.prepare('UPDATE productos SET costo = ? WHERE id = ?').run(num(b.costo), id);
  return { body: { ok: true, existencia, aviso: existencia < 0 ? 'La existencia quedó en negativo.' : null } };
});
on('DELETE', '/api/productos/:id', (c) => {
  db.prepare('DELETE FROM productos WHERE id = ?').run(Number(c.params.id));
  return { body: { ok: true } };
});

// ---- NCF
on('GET', '/api/ncf', () => ({
  body: db.prepare('SELECT * FROM ncf_series ORDER BY tipo').all().map((s) => ({
    ...s, disponibles: Math.max(0, s.hasta - Math.max(s.actual, s.desde - 1)),
  })),
}));
on('PUT', '/api/ncf/:id', (c) => {
  const b = c.body, id = Number(c.params.id);
  db.prepare('UPDATE ncf_series SET descripcion=?, prefijo=?, desde=?, hasta=?, actual=?, vence=?, activo=? WHERE id=?')
    .run(txt(b.descripcion), txt(b.prefijo), parseInt(b.desde, 10) || 1, parseInt(b.hasta, 10) || 1,
      parseInt(b.actual, 10) || 0, txt(b.vence), b.activo ? 1 : 0, id);
  return { body: db.prepare('SELECT * FROM ncf_series WHERE id = ?').get(id) };
});

// ---- documentos (facturas y presupuestos)
on('GET', '/api/documentos', (c) => {
  const q = c.query;
  let sql = `SELECT d.*, COALESCE((SELECT SUM(i.monto) FROM ingresos i WHERE i.documento_id = d.id),0) pagado,
    COALESCE(c.nombre, d.cliente_nombre) cliente FROM documentos d LEFT JOIN contactos c ON c.id = d.contacto_id WHERE 1=1`;
  const p = [];
  if (q.tipo) { sql += ' AND d.tipo = ?'; p.push(q.tipo); }
  if (q.estado) { sql += ' AND d.estado = ?'; p.push(q.estado); }
  if (q.contacto_id) { sql += ' AND d.contacto_id = ?'; p.push(Number(q.contacto_id)); }
  if (q.desde) { sql += ' AND d.fecha >= ?'; p.push(q.desde); }
  if (q.hasta) { sql += ' AND d.fecha <= ?'; p.push(q.hasta); }
  if (q.q) { sql += ' AND (d.numero LIKE ? OR d.ncf LIKE ? OR COALESCE(c.nombre, d.cliente_nombre) LIKE ?)'; const t = `%${q.q}%`; p.push(t, t, t); }
  sql += ' ORDER BY d.fecha DESC, d.id DESC';
  const rows = db.prepare(sql).all(...p).map((d) => ({ ...d, balance: r2(d.total - d.pagado) }));
  return { body: rows };
});

on('GET', '/api/documentos/:id', (c) => {
  const d = docCompleto(Number(c.params.id));
  return d ? { body: d } : { status: 404, body: { error: 'Documento no encontrado' } };
});

function guardarDocumento(c, id) {
  const b = c.body;
  const e = empresa();
  const tipo = txt(b.tipo) === 'presupuesto' ? 'presupuesto' : 'factura';
  const items = Array.isArray(b.items) ? b.items.filter((i) => txt(i.descripcion).trim()) : [];
  if (!items.length) return { status: 400, body: { error: 'Agregue al menos una línea al documento' } };
  const calc = calcularDocumento(items, b.descuento, num(e.itbis_tasa));

  let contactoId = b.contacto_id ? Number(b.contacto_id) : null;
  let cliente = contactoId ? db.prepare('SELECT * FROM contactos WHERE id = ?').get(contactoId) : null;
  if (!cliente && txt(b.cliente_nombre).trim() && b.crear_cliente) {
    const info = db.prepare('INSERT INTO contactos (tipo,nombre,rnc) VALUES (?,?,?)')
      .run('cliente', txt(b.cliente_nombre).trim(), txt(b.cliente_rnc));
    contactoId = Number(info.lastInsertRowid);
    cliente = db.prepare('SELECT * FROM contactos WHERE id = ?').get(contactoId);
  }
  const nombreCli = cliente ? cliente.nombre : txt(b.cliente_nombre);
  const rncCli = cliente ? cliente.rnc : txt(b.cliente_rnc);

  const fecha = txt(b.fecha) || hoy();
  let venc = txt(b.vencimiento);
  if (!venc) {
    const d = new Date(fecha + 'T00:00:00');
    d.setDate(d.getDate() + (tipo === 'presupuesto' ? e.validez_presupuesto : 30));
    venc = d.toISOString().slice(0, 10);
  }
  const estado = txt(b.estado) || (tipo === 'factura' ? 'emitida' : 'borrador');

  let ncf = txt(b.ncf), ncfTipo = txt(b.ncf_tipo), avisoNCF = null;
  if (id) {
    const prev = db.prepare('SELECT ncf, ncf_tipo FROM documentos WHERE id = ?').get(id);
    if (prev && prev.ncf) { ncf = prev.ncf; ncfTipo = prev.ncf_tipo; }
  }
  if (tipo === 'factura' && !ncf && ncfTipo && estado !== 'borrador') {
    const res = siguienteNCF(ncfTipo);
    if (!res) return { status: 400, body: { error: `No hay una secuencia NCF activa para ${ncfTipo}` } };
    if (res.error) return { status: 400, body: { error: res.error } };
    ncf = res.ncf;
    if (res.disponibles <= 10) avisoNCF = `Quedan ${res.disponibles} comprobantes ${ncfTipo} disponibles.`;
  }

  if (!id) {
    const numero = txt(b.numero) || siguienteNumero(tipo, tipo === 'factura' ? 'FAC' : 'PRE');
    const info = db.prepare(`INSERT INTO documentos (tipo,numero,ncf,ncf_tipo,contacto_id,cliente_nombre,cliente_rnc,fecha,
      vencimiento,estado,subtotal,descuento,itbis,total,notas,condiciones,origen_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(tipo, numero, ncf, ncfTipo, contactoId, nombreCli, rncCli, fecha, venc, estado,
        calc.subtotal, calc.descuento, calc.itbis, calc.total, txt(b.notas), txt(b.condiciones) || e.condiciones,
        b.origen_id ? Number(b.origen_id) : null);
    id = Number(info.lastInsertRowid);
  } else {
    revertirStock(id);   // devolvemos al inventario lo anterior antes de reescribir las líneas
    db.prepare(`UPDATE documentos SET numero=?, ncf=?, ncf_tipo=?, contacto_id=?, cliente_nombre=?, cliente_rnc=?, fecha=?,
      vencimiento=?, estado=?, subtotal=?, descuento=?, itbis=?, total=?, notas=?, condiciones=? WHERE id=?`)
      .run(txt(b.numero), ncf, ncfTipo, contactoId, nombreCli, rncCli, fecha, venc, estado,
        calc.subtotal, calc.descuento, calc.itbis, calc.total, txt(b.notas), txt(b.condiciones), id);
    db.prepare('DELETE FROM documento_items WHERE documento_id = ?').run(id);
  }

  const ins = db.prepare(`INSERT INTO documento_items (documento_id,producto_id,descripcion,cantidad,precio,descuento,itbis,importe,orden)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const it of calc.detalle) {
    ins.run(id, it.producto_id ? Number(it.producto_id) : null, txt(it.descripcion), it.cantidad, it.precio,
      it.descuento, it.itbis, it.importe, it.orden);
  }
  estadoAuto(id);
  const avisosStock = aplicarStock(id);
  return { body: { ...docCompleto(id), aviso: avisoNCF, avisosStock } };
}

on('POST', '/api/documentos', (c) => guardarDocumento(c, null));
on('PUT', '/api/documentos/:id', (c) => {
  const id = Number(c.params.id);
  const d = db.prepare('SELECT estado FROM documentos WHERE id = ?').get(id);
  if (!d) return { status: 404, body: { error: 'Documento no encontrado' } };
  if (d.estado === 'anulada') return { status: 400, body: { error: 'No se puede modificar un documento anulado' } };
  return guardarDocumento(c, id);
});

on('POST', '/api/documentos/:id/estado', (c) => {
  const id = Number(c.params.id);
  const estado = txt(c.body.estado);
  const permitidos = ['borrador', 'emitida', 'parcial', 'pagada', 'anulada', 'enviado', 'aprobado', 'rechazado', 'facturado'];
  if (!permitidos.includes(estado)) return { status: 400, body: { error: 'Estado no válido' } };
  db.prepare('UPDATE documentos SET estado = ? WHERE id = ?').run(estado, id);
  let avisosStock = [];
  if (estado === 'anulada' || estado === 'borrador') revertirStock(id);
  else { estadoAuto(id); avisosStock = aplicarStock(id); }
  return { body: { ...docCompleto(id), avisosStock } };
});

on('POST', '/api/documentos/:id/facturar', (c) => {
  const p = docCompleto(Number(c.params.id));
  if (!p || p.tipo !== 'presupuesto') return { status: 400, body: { error: 'Solo se pueden convertir presupuestos' } };
  const body = {
    tipo: 'factura', contacto_id: p.contacto_id, cliente_nombre: p.cliente_nombre, cliente_rnc: p.cliente_rnc,
    fecha: hoy(), estado: 'emitida', descuento: p.descuento, notas: p.notas, condiciones: p.condiciones,
    ncf_tipo: txt(c.body.ncf_tipo), origen_id: p.id,
    items: p.items.map((i) => ({ producto_id: i.producto_id, descripcion: i.descripcion, cantidad: i.cantidad, precio: i.precio, descuento: i.descuento, itbis: i.itbis })),
  };
  const res = guardarDocumento({ body }, null);
  if (res.status && res.status >= 400) return res;
  db.prepare("UPDATE documentos SET estado = 'facturado' WHERE id = ?").run(p.id);
  return res;
});

on('DELETE', '/api/documentos/:id', (c) => {
  const id = Number(c.params.id);
  const d = db.prepare('SELECT estado FROM documentos WHERE id = ?').get(id);
  if (!d) return { status: 404, body: { error: 'No encontrado' } };
  const pagos = db.prepare('SELECT COUNT(*) n FROM ingresos WHERE documento_id = ?').get(id).n;
  if (pagos) return { status: 400, body: { error: 'El documento tiene pagos registrados. Anúlelo en lugar de eliminarlo.' } };
  revertirStock(id);
  db.prepare('DELETE FROM documentos WHERE id = ?').run(id);
  return { body: { ok: true } };
});

// ---- ingresos / recibos
on('GET', '/api/ingresos', (c) => {
  const q = c.query;
  let sql = `SELECT i.*, c.nombre cliente, d.numero factura FROM ingresos i
    LEFT JOIN contactos c ON c.id = i.contacto_id LEFT JOIN documentos d ON d.id = i.documento_id WHERE 1=1`;
  const p = [];
  if (q.desde) { sql += ' AND i.fecha >= ?'; p.push(q.desde); }
  if (q.hasta) { sql += ' AND i.fecha <= ?'; p.push(q.hasta); }
  if (q.categoria) { sql += ' AND i.categoria = ?'; p.push(q.categoria); }
  if (q.q) { sql += ' AND (i.concepto LIKE ? OR i.recibo LIKE ? OR c.nombre LIKE ?)'; const t = `%${q.q}%`; p.push(t, t, t); }
  return { body: db.prepare(sql + ' ORDER BY i.fecha DESC, i.id DESC').all(...p) };
});

on('GET', '/api/ingresos/:id', (c) => {
  const x = db.prepare(`SELECT i.*, c.nombre cliente, c.rnc cliente_rnc, c.direccion cliente_direccion, d.numero factura, d.total factura_total
    FROM ingresos i LEFT JOIN contactos c ON c.id = i.contacto_id LEFT JOIN documentos d ON d.id = i.documento_id WHERE i.id = ?`).get(Number(c.params.id));
  return x ? { body: x } : { status: 404, body: { error: 'Recibo no encontrado' } };
});

on('POST', '/api/ingresos', (c) => {
  const b = c.body;
  const monto = r2(b.monto);
  if (monto <= 0) return { status: 400, body: { error: 'El monto debe ser mayor que cero' } };
  let contactoId = b.contacto_id ? Number(b.contacto_id) : null;
  let docId = b.documento_id ? Number(b.documento_id) : null;
  let concepto = txt(b.concepto).trim();
  if (docId) {
    const d = docCompleto(docId);
    if (!d) return { status: 400, body: { error: 'La factura indicada no existe' } };
    if (d.estado === 'anulada') return { status: 400, body: { error: 'La factura está anulada' } };
    if (monto - d.balance > 0.009) return { status: 400, body: { error: `El pago excede el balance pendiente (${d.balance.toFixed(2)})` } };
    if (!contactoId) contactoId = d.contacto_id;
    if (!concepto) concepto = `Pago factura ${d.numero}`;
  }
  if (!concepto) return { status: 400, body: { error: 'Indique un concepto' } };
  const recibo = siguienteNumero('recibo', 'REC');
  const info = db.prepare(`INSERT INTO ingresos (recibo,fecha,concepto,categoria,contacto_id,documento_id,monto,metodo,referencia,notas)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(recibo, txt(b.fecha) || hoy(), concepto, txt(b.categoria) || 'Ventas',
    contactoId, docId, monto, txt(b.metodo) || 'Efectivo', txt(b.referencia), txt(b.notas));
  if (docId) estadoAuto(docId);
  return { body: db.prepare('SELECT * FROM ingresos WHERE id = ?').get(Number(info.lastInsertRowid)) };
});

on('PUT', '/api/ingresos/:id', (c) => {
  const b = c.body, id = Number(c.params.id);
  const prev = db.prepare('SELECT * FROM ingresos WHERE id = ?').get(id);
  if (!prev) return { status: 404, body: { error: 'No encontrado' } };
  db.prepare(`UPDATE ingresos SET fecha=?, concepto=?, categoria=?, contacto_id=?, monto=?, metodo=?, referencia=?, notas=? WHERE id=?`)
    .run(txt(b.fecha) || prev.fecha, txt(b.concepto) || prev.concepto, txt(b.categoria) || 'Ventas',
      b.contacto_id ? Number(b.contacto_id) : null, r2(b.monto), txt(b.metodo), txt(b.referencia), txt(b.notas), id);
  if (prev.documento_id) estadoAuto(prev.documento_id);
  return { body: db.prepare('SELECT * FROM ingresos WHERE id = ?').get(id) };
});

on('DELETE', '/api/ingresos/:id', (c) => {
  const id = Number(c.params.id);
  const prev = db.prepare('SELECT documento_id FROM ingresos WHERE id = ?').get(id);
  db.prepare('DELETE FROM ingresos WHERE id = ?').run(id);
  if (prev && prev.documento_id) estadoAuto(prev.documento_id);
  return { body: { ok: true } };
});

// ---- gastos
on('GET', '/api/gastos', (c) => {
  const q = c.query;
  let sql = 'SELECT g.*, c.nombre proveedor FROM gastos g LEFT JOIN contactos c ON c.id = g.contacto_id WHERE 1=1';
  const p = [];
  if (q.desde) { sql += ' AND g.fecha >= ?'; p.push(q.desde); }
  if (q.hasta) { sql += ' AND g.fecha <= ?'; p.push(q.hasta); }
  if (q.categoria) { sql += ' AND g.categoria = ?'; p.push(q.categoria); }
  if (q.q) { sql += ' AND (g.concepto LIKE ? OR g.ncf LIKE ? OR c.nombre LIKE ?)'; const t = `%${q.q}%`; p.push(t, t, t); }
  return { body: db.prepare(sql + ' ORDER BY g.fecha DESC, g.id DESC').all(...p) };
});

on('POST', '/api/gastos', (c) => {
  const b = c.body;
  if (!txt(b.concepto).trim()) return { status: 400, body: { error: 'Indique un concepto' } };
  const subtotal = r2(b.subtotal), itbis = r2(b.itbis);
  const total = b.monto !== undefined && num(b.monto) > 0 ? r2(b.monto) : r2(subtotal + itbis);
  const info = db.prepare(`INSERT INTO gastos (fecha,concepto,categoria,contacto_id,subtotal,itbis,monto,metodo,ncf,comprobante,deducible,notas)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(txt(b.fecha) || hoy(), txt(b.concepto).trim(), txt(b.categoria) || 'General',
    b.contacto_id ? Number(b.contacto_id) : null, subtotal, itbis, total, txt(b.metodo) || 'Efectivo',
    txt(b.ncf), txt(b.comprobante), b.deducible === 0 ? 0 : 1, txt(b.notas));
  return { body: db.prepare('SELECT * FROM gastos WHERE id = ?').get(Number(info.lastInsertRowid)) };
});

on('PUT', '/api/gastos/:id', (c) => {
  const b = c.body, id = Number(c.params.id);
  const subtotal = r2(b.subtotal), itbis = r2(b.itbis);
  const total = b.monto !== undefined && num(b.monto) > 0 ? r2(b.monto) : r2(subtotal + itbis);
  db.prepare(`UPDATE gastos SET fecha=?, concepto=?, categoria=?, contacto_id=?, subtotal=?, itbis=?, monto=?, metodo=?,
    ncf=?, comprobante=?, deducible=?, notas=? WHERE id=?`).run(txt(b.fecha), txt(b.concepto).trim(), txt(b.categoria) || 'General',
    b.contacto_id ? Number(b.contacto_id) : null, subtotal, itbis, total, txt(b.metodo), txt(b.ncf), txt(b.comprobante),
    b.deducible === 0 ? 0 : 1, txt(b.notas), id);
  return { body: db.prepare('SELECT * FROM gastos WHERE id = ?').get(id) };
});

on('DELETE', '/api/gastos/:id', (c) => {
  db.prepare('DELETE FROM gastos WHERE id = ?').run(Number(c.params.id));
  return { body: { ok: true } };
});

// ---- PDF
on('GET', '/api/documentos/:id/pdf', (c) => {
  const d = docCompleto(Number(c.params.id));
  if (!d) return { status: 404, body: { error: 'Documento no encontrado' } };
  return { raw: pdfDocumento(d, empresa()), contentType: 'application/pdf', filename: nombreArchivo(d.numero), inline: c.query.ver === '1' };
});

on('GET', '/api/ingresos/:id/pdf', (c) => {
  const r = reciboCompleto(Number(c.params.id));
  if (!r) return { status: 404, body: { error: 'Recibo no encontrado' } };
  return { raw: pdfRecibo(r, empresa()), contentType: 'application/pdf', filename: nombreArchivo(r.recibo), inline: c.query.ver === '1' };
});

// ---- enlaces públicos y WhatsApp
function datosCompartir(tipo, id, ctx) {
  const tabla = tipo === 'recibo' ? 'ingresos' : 'documentos';
  const token = asegurarToken(tabla, id);
  if (!token) return null;
  const e = empresa();
  const base = (e.url_publica || ctx.origen || '').replace(/\/+$/, '');
  const enlace = `${base}/p/${token}`;
  let titulo, total, tel, nombre, email;
  if (tipo === 'recibo') {
    const r = reciboCompleto(id);
    titulo = `Recibo ${r.recibo}`; total = r.monto; tel = r.cliente_telefono; nombre = r.cliente; email = r.cliente_email;
  } else {
    const d = docCompleto(id);
    titulo = `${d.tipo === 'factura' ? 'Factura' : 'Presupuesto'} ${d.numero}`;
    total = d.total; tel = d.cliente?.telefono; nombre = d.cliente?.nombre || d.cliente_nombre; email = d.cliente?.email;
  }
  const monto = `${e.simbolo} ${r2(total).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const etiqueta = titulo.replace(/^(\w+)/, (w) => w.toLowerCase());   // "factura FAC-2026-00007"
  const mensaje = `Hola${nombre ? ' ' + nombre : ''}, le comparto su ${etiqueta} por ${monto} de ${e.nombre}.\n\n${enlace}`;
  const numero = telefonoWhatsApp(tel);
  return {
    token, enlace, titulo, mensaje, email: email || '', telefono: tel || '', numero,
    whatsapp: numero ? `https://wa.me/${numero}?text=${encodeURIComponent(mensaje)}` : `https://wa.me/?text=${encodeURIComponent(mensaje)}`,
  };
}

on('GET', '/api/documentos/:id/compartir', (c) => {
  const r = datosCompartir('documento', Number(c.params.id), c);
  return r ? { body: r } : { status: 404, body: { error: 'Documento no encontrado' } };
});
on('GET', '/api/ingresos/:id/compartir', (c) => {
  const r = datosCompartir('recibo', Number(c.params.id), c);
  return r ? { body: r } : { status: 404, body: { error: 'Recibo no encontrado' } };
});
on('DELETE', '/api/documentos/:id/compartir', (c) => {
  db.prepare("UPDATE documentos SET token = '' WHERE id = ?").run(Number(c.params.id));
  return { body: { ok: true } };
});
on('POST', '/api/whatsapp', (c) => {
  db.prepare('INSERT INTO envios (documento_id, ingreso_id, canal, destino, asunto, estado) VALUES (?,?,?,?,?,?)')
    .run(c.body.documento_id ? Number(c.body.documento_id) : null, c.body.ingreso_id ? Number(c.body.ingreso_id) : null,
      'whatsapp', txt(c.body.destino), txt(c.body.titulo), 'abierto');
  return { body: { ok: true } };
});

// ---- páginas públicas (sin sesión)
function paginaPublica(token) {
  const e = empresa();
  const d = db.prepare('SELECT id FROM documentos WHERE token = ? AND token <> ?').get(token, '');
  if (d) return { tipo: 'documento', datos: docCompleto(d.id), e };
  const i = db.prepare('SELECT id FROM ingresos WHERE token = ? AND token <> ?').get(token, '');
  if (i) return { tipo: 'recibo', datos: reciboCompleto(i.id), e };
  return null;
}

on('GET', '/p/:token', (c) => {
  const p = paginaPublica(c.params.token);
  if (!p) return { status: 404, raw: paginaError(), contentType: 'text/html; charset=utf-8', inline: true };
  const base = (empresa().url_publica || c.origen || '').replace(/\/+$/, '');
  return { raw: paginaVista(p, c.params.token, base), contentType: 'text/html; charset=utf-8', inline: true };
}, true);

on('GET', '/p/:token/pdf', (c) => {
  const p = paginaPublica(c.params.token);
  if (!p) return { status: 404, body: { error: 'Enlace no válido' } };
  const pdf = p.tipo === 'recibo' ? pdfRecibo(p.datos, p.e) : pdfDocumento(p.datos, p.e);
  return { raw: pdf, contentType: 'application/pdf', filename: nombreArchivo(p.datos.numero || p.datos.recibo), inline: true };
}, true);

const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function paginaError() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Enlace no válido</title><style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f6fa;color:#1c2434;text-align:center}</style>
  </head><body><div><h1>Enlace no válido</h1><p>Este enlace no existe o fue revocado por quien lo emitió.</p></div></body></html>`;
}

function paginaVista(p, token, base) {
  const { e } = p;
  const dinero = (v) => `${e.simbolo} ${r2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fecha = (f) => (f ? String(f).split('-').reverse().join('/') : '—');
  const esRecibo = p.tipo === 'recibo';
  const d = p.datos;
  const titulo = esRecibo ? `Recibo ${d.recibo}` : `${d.tipo === 'factura' ? 'Factura' : 'Presupuesto'} ${d.numero}`;

  const filas = esRecibo
    ? `<tr><td>${escHtml(d.concepto)}</td><td class="num">${dinero(d.monto)}</td></tr>`
    : d.items.map((i) => `<tr><td>${escHtml(i.descripcion)}</td><td class="num">${i.cantidad}</td>
        <td class="num">${dinero(i.precio)}</td><td class="num">${dinero(i.importe)}</td></tr>`).join('');

  const totales = esRecibo
    ? `<div class="t grande"><span>TOTAL RECIBIDO</span><b>${dinero(d.monto)}</b></div>`
    : `<div class="t"><span>Subtotal</span><b>${dinero(d.subtotal)}</b></div>
       ${d.descuento ? `<div class="t"><span>Descuento</span><b>- ${dinero(d.descuento)}</b></div>` : ''}
       <div class="t"><span>ITBIS (${e.itbis_tasa}%)</span><b>${dinero(d.itbis)}</b></div>
       <div class="t grande"><span>TOTAL</span><b>${dinero(d.total)}</b></div>
       ${d.tipo === 'factura' ? `<div class="t"><span>Pagado</span><b>${dinero(d.pagado)}</b></div>
       <div class="t"><span>Balance</span><b style="color:${d.balance > 0.009 ? '#d93b3b' : '#0f9d58'}">${dinero(d.balance)}</b></div>` : ''}`;

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(titulo)} — ${escHtml(e.nombre)}</title>
<style>
:root{color-scheme:light}
body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;background:#eef1f7;color:#1c2434}
.hoja{max-width:780px;margin:24px auto;background:#fff;border-radius:12px;box-shadow:0 2px 20px rgba(20,30,60,.1);padding:28px}
.cab{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;border-bottom:3px solid #1f5eff;padding-bottom:14px;margin-bottom:18px}
.cab img{max-height:64px;max-width:190px;object-fit:contain}
.emp{font-size:17px;font-weight:700} .sm{font-size:13px;color:#4b5568}
.tit{text-align:right} .tit h1{margin:0;font-size:22px;color:#1f5eff;letter-spacing:.03em}
.cajas{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.caja{flex:1;min-width:220px;background:#f5f7fb;border-radius:8px;padding:12px 14px;font-size:13.5px}
.caja b.et{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:#6b7793;margin-bottom:4px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{background:#12203f;color:#fff;text-align:left;padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
td{padding:8px 10px;border-bottom:1px solid #e6ebf4}
.num{text-align:right;white-space:nowrap}
.tot{margin:14px 0 0 auto;max-width:300px}
.t{display:flex;justify-content:space-between;padding:4px 0}
.t.grande{border-top:2px solid #12203f;margin-top:6px;padding-top:8px;font-size:18px;font-weight:700}
.acciones{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
.btn{display:inline-block;padding:10px 18px;border-radius:8px;background:#1f5eff;color:#fff;text-decoration:none;font-weight:600}
.btn.sec{background:#fff;color:#1c2434;border:1px solid #d8dfec}
.pie{margin-top:22px;padding-top:12px;border-top:1px solid #e6ebf4;font-size:12.5px;color:#6b7793}
@media print{body{background:#fff}.hoja{box-shadow:none;margin:0;max-width:none}.acciones{display:none}}
</style></head><body>
<div class="hoja">
  <div class="cab">
    <div>${e.logo ? `<img src="${escHtml(e.logo)}" alt="">` : ''}
      <div class="emp">${escHtml(e.nombre)}</div>
      <div class="sm">${[e.rnc ? 'RNC: ' + e.rnc : '', e.direccion, e.telefono, e.email].filter(Boolean).map(escHtml).join('<br>')}</div>
    </div>
    <div class="tit"><h1>${esRecibo ? 'RECIBO' : (d.tipo === 'factura' ? 'FACTURA' : 'PRESUPUESTO')}</h1>
      <div class="sm"><b>No.</b> ${escHtml(esRecibo ? d.recibo : d.numero)}<br>
      ${!esRecibo && d.ncf ? `<b>NCF:</b> ${escHtml(d.ncf)}<br>` : ''}
      <b>Fecha:</b> ${fecha(d.fecha)}${!esRecibo ? `<br><b>${d.tipo === 'factura' ? 'Vence' : 'Válido hasta'}:</b> ${fecha(d.vencimiento)}` : ''}</div>
    </div>
  </div>
  <div class="cajas">
    <div class="caja"><b class="et">${esRecibo ? 'Recibido de' : 'Cliente'}</b>
      <b>${escHtml(esRecibo ? (d.cliente || '—') : (d.cliente?.nombre || d.cliente_nombre || '—'))}</b>
      ${(esRecibo ? d.cliente_rnc : (d.cliente?.rnc || d.cliente_rnc)) ? `<div class="sm">RNC/Cédula: ${escHtml(esRecibo ? d.cliente_rnc : (d.cliente?.rnc || d.cliente_rnc))}</div>` : ''}
    </div>
    <div class="caja"><b class="et">${esRecibo ? 'Detalle del pago' : 'Resumen'}</b>
      ${esRecibo ? `<div>Método: ${escHtml(d.metodo)}</div>${d.factura ? `<div>Factura: ${escHtml(d.factura)}</div>` : ''}`
      : `<div>Estado: ${escHtml(d.estado)}</div><div>Moneda: ${escHtml(e.moneda)}</div>`}
    </div>
  </div>
  <table>
    <thead><tr><th>${esRecibo ? 'Concepto' : 'Descripción'}</th>${esRecibo ? '' : '<th class="num">Cant.</th><th class="num">Precio</th>'}<th class="num">${esRecibo ? 'Monto' : 'Importe'}</th></tr></thead>
    <tbody>${filas}</tbody>
  </table>
  <div class="tot">${totales}</div>
  <div class="acciones">
    <a class="btn" href="${escHtml(base)}/p/${escHtml(token)}/pdf">Descargar PDF</a>
    <a class="btn sec" href="javascript:window.print()">Imprimir</a>
  </div>
  <div class="pie">${escHtml(esRecibo ? 'Este recibo confirma el pago descrito.' : (d.condiciones || e.condiciones || ''))}</div>
</div></body></html>`;
}

// ---- correo
function correoConfig() { return db.prepare('SELECT * FROM correo WHERE id = 1').get(); }

on('GET', '/api/correo', () => {
  const c = correoConfig();
  return { body: { ...c, clave: '', tiene_clave: c.clave ? 1 : 0 } };
});

on('PUT', '/api/correo', (c) => {
  const b = c.body, prev = correoConfig();
  db.prepare(`UPDATE correo SET activo=?, servidor=?, puerto=?, seguridad=?, usuario=?, clave=?, remitente=?,
    nombre_remitente=?, copia=?, asunto_factura=?, mensaje_factura=? WHERE id = 1`).run(
    b.activo ? 1 : 0, txt(b.servidor).trim(), parseInt(b.puerto, 10) || 587,
    txt(b.seguridad) === 'ssl' ? 'ssl' : 'starttls', txt(b.usuario).trim(),
    txt(b.clave) ? txt(b.clave) : prev.clave,     // si se deja vacío, se conserva la anterior
    txt(b.remitente).trim() || txt(b.usuario).trim(), txt(b.nombre_remitente), txt(b.copia),
    // las plantillas solo se tocan si vienen en la petición
    b.asunto_factura !== undefined ? txt(b.asunto_factura) : prev.asunto_factura,
    b.mensaje_factura !== undefined ? txt(b.mensaje_factura) : prev.mensaje_factura);
  const n = correoConfig();
  return { body: { ...n, clave: '', tiene_clave: n.clave ? 1 : 0 } };
});

function plantilla(texto, datos) {
  return String(texto || '').replace(/\{(\w+)\}/g, (_, k) => (datos[k] !== undefined ? String(datos[k]) : `{${k}}`));
}

function cuerpoHtml(e, titulo, mensaje, enlace) {
  const parrafos = String(mensaje).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<div style="font:15px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1c2434;max-width:620px">
    <div style="border-bottom:3px solid #1f5eff;padding-bottom:10px;margin-bottom:18px">
      ${e.logo ? `<img src="${escHtml(e.logo)}" alt="" style="max-height:52px">` : ''}
      <div style="font-size:17px;font-weight:700">${escHtml(e.nombre)}</div>
      ${e.rnc ? `<div style="font-size:13px;color:#6b7793">RNC: ${escHtml(e.rnc)}</div>` : ''}
    </div>
    <h2 style="font-size:17px;margin:0 0 12px;color:#12203f">${escHtml(titulo)}</h2>
    ${parrafos}
    ${enlace ? `<p style="margin:22px 0"><a href="${escHtml(enlace)}" style="background:#1f5eff;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Ver el documento en línea</a></p>` : ''}
    <div style="margin-top:22px;padding-top:12px;border-top:1px solid #e6ebf4;font-size:12.5px;color:#6b7793">
      ${[escHtml(e.nombre), escHtml(e.telefono), escHtml(e.email), escHtml(e.direccion)].filter(Boolean).join(' · ')}
    </div></div>`;
}

async function enviarCorreo(tipo, id, body, ctx) {
  const cfg = correoConfig();
  if (!cfg.activo) throw new Error('El envío por correo está desactivado. Actívelo en Configuración → Correo.');
  if (!cfg.clave) throw new Error('Falta la contraseña del correo. Complétela en Configuración → Correo.');
  const e = empresa();
  const comp = datosCompartir(tipo, id, ctx);
  if (!comp) throw new Error('Documento no encontrado');

  const esRecibo = tipo === 'recibo';
  const datos = esRecibo ? reciboCompleto(id) : docCompleto(id);
  const para = String(body.para || comp.email || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  if (!para.length) throw new Error('Indique el correo del destinatario.');

  const vars = {
    numero: esRecibo ? datos.recibo : datos.numero,
    cliente: (esRecibo ? datos.cliente : (datos.cliente?.nombre || datos.cliente_nombre)) || 'cliente',
    total: `${e.simbolo} ${r2(esRecibo ? datos.monto : datos.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
    empresa: e.nombre, fecha: datos.fecha, enlace: comp.enlace,
  };
  const asunto = txt(body.asunto) || plantilla(cfg.asunto_factura, vars);
  const mensaje = txt(body.mensaje) || plantilla(String(cfg.mensaje_factura).replace(/\\n/g, '\n'), vars);
  const copia = String(body.copia !== undefined ? body.copia : cfg.copia).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  const pdf = esRecibo ? pdfRecibo(datos, e) : pdfDocumento(datos, e);

  await correo.enviar(cfg, {
    de: cfg.remitente, nombreDe: cfg.nombre_remitente || e.nombre,
    para, copia, asunto, texto: mensaje + `\n\n${comp.enlace}`,
    html: cuerpoHtml(e, comp.titulo, mensaje, comp.enlace),
    adjunto: { nombre: nombreArchivo(vars.numero), datos: pdf, tipo: 'application/pdf' },
  });

  db.prepare('INSERT INTO envios (documento_id, ingreso_id, canal, destino, asunto, estado) VALUES (?,?,?,?,?,?)')
    .run(esRecibo ? null : id, esRecibo ? id : null, 'correo', para.join(', '), asunto, 'enviado');
  return { ok: true, para, asunto };
}

on('POST', '/api/documentos/:id/correo', async (c) => {
  try { return { body: await enviarCorreo('documento', Number(c.params.id), c.body, c) }; }
  catch (err) {
    db.prepare('INSERT INTO envios (documento_id, canal, destino, asunto, estado, detalle) VALUES (?,?,?,?,?,?)')
      .run(Number(c.params.id), 'correo', txt(c.body.para), txt(c.body.asunto), 'error', err.message);
    return { status: 400, body: { error: err.message } };
  }
});

on('POST', '/api/ingresos/:id/correo', async (c) => {
  try { return { body: await enviarCorreo('recibo', Number(c.params.id), c.body, c) }; }
  catch (err) { return { status: 400, body: { error: err.message } }; }
});

on('POST', '/api/correo/probar', async (c) => {
  const cfg = correoConfig();
  const e = empresa();
  const destino = txt(c.body.para) || cfg.remitente;
  if (!cfg.clave) return { status: 400, body: { error: 'Guarde primero la contraseña del correo.' } };
  try {
    await correo.enviar(cfg, {
      de: cfg.remitente, nombreDe: cfg.nombre_remitente || e.nombre, para: [destino],
      asunto: `Prueba de configuración — ${e.nombre}`,
      texto: 'Si recibió este mensaje, el envío de facturas por correo está funcionando correctamente.',
      html: cuerpoHtml(e, 'Prueba de configuración', 'Si recibió este mensaje, el envío de facturas por correo está funcionando correctamente.', ''),
    });
    return { body: { ok: true, destino } };
  } catch (err) { return { status: 400, body: { error: err.message } }; }
});

on('GET', '/api/envios', (c) => {
  const q = c.query;
  let sql = `SELECT e.*, d.numero factura, i.recibo FROM envios e
    LEFT JOIN documentos d ON d.id = e.documento_id LEFT JOIN ingresos i ON i.id = e.ingreso_id WHERE 1=1`;
  const p = [];
  if (q.documento_id) { sql += ' AND e.documento_id = ?'; p.push(Number(q.documento_id)); }
  return { body: db.prepare(sql + ' ORDER BY e.id DESC LIMIT 200').all(...p) };
});

// ---- reportes
on('GET', '/api/reportes/resumen', (c) => ({ body: resumen(c.query) }));

on('GET', '/api/reportes/cuentas-por-cobrar', () => {
  const rows = db.prepare(`SELECT d.id, d.numero, d.ncf, d.fecha, d.vencimiento, d.total,
    COALESCE((SELECT SUM(i.monto) FROM ingresos i WHERE i.documento_id = d.id),0) pagado,
    COALESCE(c.nombre, d.cliente_nombre) cliente FROM documentos d LEFT JOIN contactos c ON c.id = d.contacto_id
    WHERE d.tipo='factura' AND d.estado IN ('emitida','parcial') ORDER BY d.vencimiento`).all();
  const t = hoy();
  return { body: rows.map((r) => ({ ...r, balance: r2(r.total - r.pagado), vencida: r.vencimiento && r.vencimiento < t ? 1 : 0,
    dias: r.vencimiento ? Math.round((new Date(t) - new Date(r.vencimiento)) / 86400000) : 0 })) };
});

on('GET', '/api/reportes/itbis', (c) => {
  const { desde, hasta } = rangoDefault(c.query);
  const ventas = db.prepare(`SELECT substr(fecha,1,7) mes, COALESCE(SUM(subtotal - descuento),0) base, COALESCE(SUM(itbis),0) itbis
    FROM documentos WHERE tipo='factura' AND estado NOT IN ('anulada','borrador') AND fecha BETWEEN ? AND ?
    GROUP BY mes ORDER BY mes`).all(desde, hasta);
  const compras = db.prepare(`SELECT substr(fecha,1,7) mes, COALESCE(SUM(subtotal),0) base, COALESCE(SUM(itbis),0) itbis
    FROM gastos WHERE deducible=1 AND fecha BETWEEN ? AND ? GROUP BY mes ORDER BY mes`).all(desde, hasta);
  const meses = [...new Set([...ventas.map((v) => v.mes), ...compras.map((c2) => c2.mes)])].sort();
  return { body: meses.map((m) => {
    const v = ventas.find((x) => x.mes === m) || { base: 0, itbis: 0 };
    const co = compras.find((x) => x.mes === m) || { base: 0, itbis: 0 };
    return { mes: m, ventas: r2(v.base), itbisVentas: r2(v.itbis), compras: r2(co.base), itbisCompras: r2(co.itbis), aPagar: r2(v.itbis - co.itbis) };
  }) };
});

on('GET', '/api/reportes/estado', (c) => {
  const { desde, hasta } = rangoDefault(c.query);
  const ing = db.prepare('SELECT categoria, COALESCE(SUM(monto),0) total FROM ingresos WHERE fecha BETWEEN ? AND ? GROUP BY categoria ORDER BY total DESC').all(desde, hasta);
  const gas = db.prepare('SELECT categoria, COALESCE(SUM(monto),0) total FROM gastos WHERE fecha BETWEEN ? AND ? GROUP BY categoria ORDER BY total DESC').all(desde, hasta);
  const ti = r2(ing.reduce((a, x) => a + x.total, 0)), tg = r2(gas.reduce((a, x) => a + x.total, 0));
  return { body: { desde, hasta, ingresos: ing, gastos: gas, totalIngresos: ti, totalGastos: tg, utilidad: r2(ti - tg) } };
});

// exportación CSV
function csv(rows, cols) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}
on('GET', '/api/export/:tabla', (c) => {
  const t = c.params.tabla;
  const q = c.query;
  let rows = [], cols = [];
  if (t === 'facturas' || t === 'presupuestos') {
    rows = db.prepare(`SELECT d.numero, d.ncf, d.fecha, d.vencimiento, COALESCE(c.nombre,d.cliente_nombre) cliente,
      d.cliente_rnc, d.subtotal, d.descuento, d.itbis, d.total, d.estado FROM documentos d
      LEFT JOIN contactos c ON c.id=d.contacto_id WHERE d.tipo = ? ORDER BY d.fecha`).all(t === 'facturas' ? 'factura' : 'presupuesto');
    cols = ['numero', 'ncf', 'fecha', 'vencimiento', 'cliente', 'cliente_rnc', 'subtotal', 'descuento', 'itbis', 'total', 'estado'];
  } else if (t === 'ingresos') {
    rows = db.prepare(`SELECT i.recibo, i.fecha, i.concepto, i.categoria, c.nombre cliente, d.numero factura, i.monto, i.metodo, i.referencia
      FROM ingresos i LEFT JOIN contactos c ON c.id=i.contacto_id LEFT JOIN documentos d ON d.id=i.documento_id ORDER BY i.fecha`).all();
    cols = ['recibo', 'fecha', 'concepto', 'categoria', 'cliente', 'factura', 'monto', 'metodo', 'referencia'];
  } else if (t === 'gastos') {
    rows = db.prepare(`SELECT g.fecha, g.concepto, g.categoria, c.nombre proveedor, g.subtotal, g.itbis, g.monto, g.metodo, g.ncf, g.deducible
      FROM gastos g LEFT JOIN contactos c ON c.id=g.contacto_id ORDER BY g.fecha`).all();
    cols = ['fecha', 'concepto', 'categoria', 'proveedor', 'subtotal', 'itbis', 'monto', 'metodo', 'ncf', 'deducible'];
  } else if (t === 'clientes' || t === 'proveedores') {
    rows = db.prepare('SELECT nombre, rnc, contacto, telefono, email, direccion, activo FROM contactos WHERE tipo = ? ORDER BY nombre')
      .all(t === 'clientes' ? 'cliente' : 'proveedor');
    cols = ['nombre', 'rnc', 'contacto', 'telefono', 'email', 'direccion', 'activo'];
  } else return { status: 404, body: { error: 'Exportación no disponible' } };
  void q;
  return { status: 200, raw: '﻿' + csv(rows, cols), contentType: 'text/csv; charset=utf-8', filename: `${t}.csv` };
});

module.exports = { despachar, leerSesion };
