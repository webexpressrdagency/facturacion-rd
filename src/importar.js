'use strict';
/* Importación de listados en CSV (proveedores, clientes y catálogo).

   El archivo se analiza primero y se devuelve una vista previa: qué columna
   se reconoció, qué filas entrarían como nuevas, cuáles ya existen y cuáles
   traen errores. Solo cuando el usuario confirma se escribe en la base.

   Se aceptan los separadores habituales (coma, punto y coma, tabulador),
   comillas al estilo Excel, tildes en los encabezados y números escritos
   tanto "1,250.00" como "1.250,00". */

const { db, monedaValida } = require('./db');

/* ------------------------------------------------------------------ texto */

const sinAcentos = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
/** Convierte un encabezado en una clave comparable: "RNC / Cédula" -> "rnc cedula". */
const clave = (s) => sinAcentos(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Detecta el separador mirando la primera línea (fuera de comillas). */
function detectarSeparador(texto) {
  const linea = texto.split(/\r?\n/).find((l) => l.trim() !== '') || '';
  let comillas = false;
  const cuenta = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  for (const ch of linea) {
    if (ch === '"') comillas = !comillas;
    else if (!comillas && cuenta[ch] !== undefined) cuenta[ch]++;
  }
  let mejor = ',';
  for (const s of Object.keys(cuenta)) if (cuenta[s] > cuenta[mejor]) mejor = s;
  return cuenta[mejor] > 0 ? mejor : ',';
}

/** Lector de CSV: respeta comillas, comillas dobles escapadas y saltos de línea. */
function parsearCSV(texto, sep) {
  const filas = [];
  let fila = [], campo = '', comillas = false;
  const t = String(texto).replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (comillas) {
      if (ch !== '"') { campo += ch; continue; }
      if (t[i + 1] === '"') { campo += '"'; i++; continue; }         // comilla escapada
      const sig = t[i + 1];
      if (sig === undefined || sig === sep || sig === '\n' || sig === '\r') { comillas = false; continue; }
      campo += '"';   // comilla suelta en medio del texto: se conserva tal cual
      continue;
    }
    // Solo abre comillas al principio del campo: así 'Tubo 3/4" x 20 pies' se lee bien
    if (ch === '"' && campo === '') { comillas = true; continue; }
    if (ch === sep) { fila.push(campo); campo = ''; continue; }
    if (ch === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; continue; }
    if (ch === '\r') continue;
    campo += ch;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter((f) => f.some((v) => String(v).trim() !== ''));
}

/* ----------------------------------------------------------------- valores */

/** Número tolerante: "RD$ 1,250.00", "1.250,00" y "1250" dan lo mismo. */
function numero(v) {
  let s = String(v == null ? '' : v).replace(/[^0-9,.\-]/g, '').trim();
  if (!s) return 0;
  const coma = s.lastIndexOf(','), punto = s.lastIndexOf('.');
  if (coma > punto) s = s.replace(/\./g, '').replace(/,/g, '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

const SI = ['si', 'sí', 's', '1', 'x', 'true', 'verdadero', 'sim', 'yes'];
const NO = ['no', 'n', '0', 'false', 'falso'];
/** Sí/No tolerante. Si la celda viene vacía se usa el valor por omisión. */
function booleano(v, porOmision = 1) {
  const s = clave(v);
  if (!s) return porOmision;
  if (SI.includes(s)) return 1;
  if (NO.includes(s)) return 0;
  return porOmision;
}

/** Reconoce la moneda escrita de cualquier forma razonable. */
function monedaDe(v, porOmision) {
  const s = clave(v);
  if (!s) return porOmision;
  if (['usd', 'us', 'us dolar', 'dolar', 'dolares', 'dollar', 'usd dolar', 'u s a'].includes(s) || s.includes('dolar')) return 'USD';
  if (['dop', 'rd', 'rd peso', 'peso', 'pesos', 'peso dominicano'].includes(s) || s.includes('peso')) return 'DOP';
  return monedaValida(v) || porOmision;
}

const correoValido = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v).trim());

/* ---------------------------------------------------------------- esquemas */

const ESQUEMAS = {
  proveedores: {
    titulo: 'proveedores',
    tabla: 'contactos',
    tipo: 'proveedor',
    campos: {
      nombre: ['nombre', 'razon social', 'nombre comercial', 'empresa', 'proveedor', 'suplidor', 'nombre del proveedor'],
      rnc: ['rnc', 'cedula', 'rnc cedula', 'cedula rnc', 'identificacion', 'documento', 'id fiscal', 'nif'],
      contacto: ['contacto', 'persona', 'persona de contacto', 'encargado', 'representante', 'vendedor'],
      telefono: ['telefono', 'tel', 'telefonos', 'celular', 'movil', 'whatsapp', 'telefono 1'],
      email: ['email', 'correo', 'correo electronico', 'e mail', 'mail', 'correo 1'],
      direccion: ['direccion', 'domicilio', 'ubicacion', 'calle', 'ciudad direccion'],
      notas: ['notas', 'nota', 'observaciones', 'comentarios', 'observacion'],
    },
    requeridos: ['nombre'],
    ejemplo: ['Materiales del Caribe SRL', '104-00004-4', 'Julio Peña', '809-700-9090', 'ventas@matcaribe.do', 'Km 9 Aut. Duarte, Santo Domingo', 'Entrega en obra'],
  },
  clientes: {
    titulo: 'clientes',
    tabla: 'contactos',
    tipo: 'cliente',
    campos: null,   // se copian de proveedores más abajo
    requeridos: ['nombre'],
    ejemplo: ['Inversiones del Este SRL', '101-00001-1', 'Ana Reyes', '809-222-3344', 'compras@investe.do', 'Calle Duarte 45, La Romana', 'Pago a 30 días'],
  },
  productos: {
    titulo: 'artículos y servicios',
    tabla: 'productos',
    campos: {
      codigo: ['codigo', 'cod', 'sku', 'referencia', 'clave', 'item'],
      nombre: ['nombre', 'articulo', 'producto', 'descripcion corta', 'servicio', 'concepto'],
      descripcion: ['descripcion', 'detalle', 'descripcion larga', 'especificacion'],
      unidad: ['unidad', 'ud', 'medida', 'unidad de medida', 'um'],
      precio: ['precio', 'precio venta', 'precio de venta', 'pvp', 'valor', 'precio unitario'],
      costo: ['costo', 'costo unitario', 'precio compra', 'precio de compra'],
      itbis: ['itbis', 'impuesto', 'grava itbis', 'lleva itbis', 'itbis 18', 'iva'],
      moneda: ['moneda', 'divisa', 'currency'],
      inventario: ['inventario', 'lleva inventario', 'control de inventario', 'inventariable', 'stock'],
      existencia: ['existencia', 'stock', 'cantidad', 'existencia inicial', 'inventario inicial'],
      minimo: ['minimo', 'stock minimo', 'existencia minima', 'minimo de reposicion', 'punto de reorden'],
    },
    requeridos: ['nombre'],
    ejemplo: ['CEM-01', 'Funda de cemento gris 42.5 kg', 'Cemento portland tipo I', 'funda', '480.00', '380.00', 'si', 'DOP', 'si', '240', '60'],
  },
};
ESQUEMAS.clientes.campos = ESQUEMAS.proveedores.campos;

const tiposValidos = () => Object.keys(ESQUEMAS);

/** Encabezados sugeridos y una fila de ejemplo, para descargar como plantilla. */
function plantilla(tipo) {
  const e = ESQUEMAS[tipo];
  if (!e) return null;
  const cols = Object.keys(e.campos);
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return '\uFEFF' + [cols.map(esc).join(','), e.ejemplo.map(esc).join(',')].join('\r\n') + '\r\n';
}

/* ---------------------------------------------------------------- análisis */

/** Relaciona cada columna del archivo con un campo del sistema. */
function mapearColumnas(encabezado, campos) {
  const mapa = {};        // índice de columna -> campo
  const usados = new Set();
  encabezado.forEach((h, i) => {
    const k = clave(h);
    if (!k) return;
    for (const [campo, alias] of Object.entries(campos)) {
      if (usados.has(campo)) continue;
      if (alias.includes(k) || campo === k) { mapa[i] = campo; usados.add(campo); return; }
    }
  });
  return mapa;
}

/**
 * Analiza el CSV y devuelve la vista previa.
 * No escribe nada: solo dice qué pasaría.
 */
function analizar(tipo, texto, opciones = {}) {
  const esq = ESQUEMAS[tipo];
  if (!esq) return { error: 'Tipo de importación no válido' };
  if (!String(texto || '').trim()) return { error: 'El archivo está vacío' };

  const sep = detectarSeparador(texto);
  const filas = parsearCSV(texto, sep);
  if (filas.length < 2) return { error: 'El archivo debe tener una fila de encabezados y al menos un registro' };

  const encabezado = filas[0].map((h) => String(h).trim());
  const mapa = mapearColumnas(encabezado, esq.campos);
  const reconocidos = Object.values(mapa);
  const faltantes = esq.requeridos.filter((r) => !reconocidos.includes(r));
  if (faltantes.length) {
    return { error: `No se encontró la columna «${faltantes.join('», «')}». Revise la primera fila del archivo o descargue la plantilla.`,
      columnas: encabezado.map((h, i) => ({ titulo: h, campo: mapa[i] || null })) };
  }

  const monedaDefecto = monedaValida(opciones.moneda) || null;
  const existentes = cargarExistentes(tipo);
  const vistos = new Map();     // duplicados dentro del propio archivo
  const registros = [];

  for (let f = 1; f < filas.length; f++) {
    const cruda = filas[f];
    const datos = {};
    for (const [i, campo] of Object.entries(mapa)) datos[campo] = String(cruda[i] ?? '').trim();

    const r = { linea: f + 1, datos: {}, estado: 'nuevo', mensaje: '' };
    if (tipo === 'productos') prepararProducto(datos, r, monedaDefecto);
    else prepararContacto(datos, r, esq.tipo);

    if (r.estado !== 'error') {
      const llave = llaveDe(tipo, r.datos);
      if (vistos.has(llave)) { r.estado = 'error'; r.mensaje = `Repetido en el archivo (línea ${vistos.get(llave)})`; }
      else {
        vistos.set(llave, r.linea);
        const previo = existentes.get(llave);
        if (previo) { r.estado = 'duplicado'; r.id = previo.id; r.mensaje = `Ya existe: ${previo.nombre}`; }
      }
    }
    registros.push(r);
  }

  const resumen = {
    total: registros.length,
    nuevos: registros.filter((r) => r.estado === 'nuevo').length,
    duplicados: registros.filter((r) => r.estado === 'duplicado').length,
    errores: registros.filter((r) => r.estado === 'error').length,
  };
  return {
    tipo, titulo: esq.titulo, separador: sep === '\t' ? 'tabulador' : sep,
    columnas: encabezado.map((h, i) => ({ titulo: h, campo: mapa[i] || null })),
    ignoradas: encabezado.filter((h, i) => !mapa[i] && String(h).trim() !== ''),
    registros, resumen,
  };
}

/** Clave con la que se decide si un registro ya existe. */
function llaveDe(tipo, d) {
  if (tipo === 'productos') return d.codigo ? `c:${clave(d.codigo)}` : `n:${clave(d.nombre)}`;
  return d.rnc ? `r:${String(d.rnc).replace(/\D/g, '')}` : `n:${clave(d.nombre)}`;
}

function cargarExistentes(tipo) {
  const mapa = new Map();
  if (tipo === 'productos') {
    for (const p of db.prepare('SELECT id, codigo, nombre FROM productos').all()) {
      mapa.set(llaveDe('productos', p), p);
    }
    return mapa;
  }
  const t = ESQUEMAS[tipo].tipo;
  for (const c of db.prepare('SELECT id, nombre, rnc FROM contactos WHERE tipo = ?').all(t)) {
    mapa.set(llaveDe(tipo, c), c);
  }
  return mapa;
}

function prepararContacto(d, r, tipo) {
  const nombre = String(d.nombre || '').trim();
  if (!nombre) { r.estado = 'error'; r.mensaje = 'Falta el nombre'; return; }
  const email = String(d.email || '').trim();
  const avisos = [];
  if (email && !correoValido(email)) avisos.push('el correo no parece válido, se importa igual');
  r.datos = {
    tipo,
    nombre,
    rnc: String(d.rnc || '').trim(),
    contacto: String(d.contacto || '').trim(),
    telefono: String(d.telefono || '').trim(),
    email,
    direccion: String(d.direccion || '').trim(),
    notas: String(d.notas || '').trim(),
  };
  if (avisos.length) r.mensaje = avisos.join('; ');
}

function prepararProducto(d, r, monedaDefecto) {
  const nombre = String(d.nombre || '').trim();
  if (!nombre) { r.estado = 'error'; r.mensaje = 'Falta el nombre del artículo'; return; }
  const inventario = booleano(d.inventario, d.existencia !== undefined && String(d.existencia).trim() !== '' ? 1 : 0);
  const avisos = [];
  const precio = numero(d.precio);
  if (String(d.precio || '').trim() && precio === 0) avisos.push('el precio no se pudo leer, queda en 0');
  r.datos = {
    codigo: String(d.codigo || '').trim(),
    nombre,
    descripcion: String(d.descripcion || '').trim(),
    unidad: String(d.unidad || '').trim() || 'ud',
    precio,
    costo: numero(d.costo),
    itbis: booleano(d.itbis, 1),
    moneda: monedaDe(d.moneda, monedaDefecto || 'DOP'),
    inventario,
    existencia: inventario ? numero(d.existencia) : 0,
    minimo: inventario ? numero(d.minimo) : 0,
  };
  if (avisos.length) r.mensaje = avisos.join('; ');
}

module.exports = { analizar, plantilla, tiposValidos, ESQUEMAS, parsearCSV, numero, booleano, clave };
