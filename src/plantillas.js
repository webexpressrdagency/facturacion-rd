'use strict';
/* Plantillas de impresión en PDF: factura, presupuesto y recibo. */
const { Pagina, construirPDF, leerJPEG, medir, envolver } = require('./pdf');

const AZUL = '#1f5eff';
const OSC = '#12203f';
const GRIS = '#f2f5fa';
const SUAVE = '#6b7793';
const M = 46;                 // margen
const ANCHO_UTIL = 612 - M * 2;

const fmtFecha = (f) => (f ? String(f).split('-').reverse().join('/') : '—');

function dinero(e, v) {
  const n = Math.round((Number(v) || 0) * 100) / 100;
  return `${e.simbolo || 'RD$'} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cabecera(pag, e, titulo, derecha, imagenes) {
  let y = M;
  const logo = leerJPEG(e.logo);
  if (logo) {
    const h = Math.min(52, (logo.alto / logo.ancho) * 150);
    const w = (logo.ancho / logo.alto) * h;
    imagenes.push({ nombre: 'Logo', ...logo });
    pag.imagen('Logo', M, y, Math.min(w, 170), h);
    y += h + 8;
  }
  pag.texto(e.nombre, M, y + 10, { tam: 13, bold: true, color: OSC, max: 300 });
  y += 22;
  const datos = [
    e.rnc ? `RNC: ${e.rnc}` : '', e.direccion, e.telefono ? `Tel.: ${e.telefono}` : '', e.email, e.web,
  ].filter(Boolean);
  datos.forEach((d) => { pag.texto(d, M, y, { tam: 8.5, color: '#444a58', max: 300 }); y += 11; });

  // bloque derecho
  pag.texto(titulo, 612 - M, M + 14, { tam: 19, bold: true, color: AZUL, align: 'right' });
  let yd = M + 34;
  derecha.forEach(([et, val]) => {
    pag.texto(`${et} ${val}`, 612 - M, yd, { tam: 9, color: '#333', align: 'right' });
    yd += 13;
  });

  const yLinea = Math.max(y + 4, yd + 6);
  pag.linea(M, yLinea, 612 - M, yLinea, AZUL, 2);
  return yLinea + 16;
}

function bloques(pag, y, izq, der) {
  const w = (ANCHO_UTIL - 14) / 2;
  const filas = Math.max(izq.lineas.length, der.lineas.length);
  const alto = 22 + filas * 12 + 6;
  [[M, izq], [M + w + 14, der]].forEach(([x, b]) => {
    pag.rect(x, y, w, alto, GRIS);
    pag.texto(b.titulo.toUpperCase(), x + 9, y + 14, { tam: 7.5, bold: true, color: SUAVE });
    let yy = y + 28;
    b.lineas.forEach((l, i) => {
      pag.texto(l, x + 9, yy, { tam: i === 0 ? 9.5 : 8.8, bold: i === 0, color: '#222', max: w - 18 });
      yy += 12;
    });
  });
  return y + alto + 16;
}

function tablaItems(pag, y, e, items) {
  const cols = [M, M + 250, M + 322, M + 400, M + 432, 612 - M];
  pag.rect(M, y, ANCHO_UTIL, 18, OSC);
  const th = (t, x, align) => pag.texto(t, x, y + 12.5, { tam: 7.5, bold: true, color: '#ffffff', align });
  th('DESCRIPCIÓN', cols[0] + 8);
  th('CANT.', cols[2] - 8, 'right');
  th('PRECIO', cols[3] - 8, 'right');
  th('DESC.', cols[4] - 8, 'right');
  th('IMPORTE', cols[5] - 8, 'right');
  y += 18;

  for (const it of items) {
    const lineas = envolver(it.descripcion, 8.8, false, 286);
    const alto = Math.max(20, 8 + lineas.length * 11);
    lineas.forEach((l, i) => pag.texto(l, cols[0] + 8, y + 13 + i * 11, { tam: 8.8 }));
    pag.texto(String(it.cantidad), cols[2] - 8, y + 13, { tam: 8.8, align: 'right' });
    pag.texto(dinero(e, it.precio), cols[3] - 8, y + 13, { tam: 8.8, align: 'right' });
    pag.texto(it.descuento ? `${it.descuento}%` : '—', cols[4] - 8, y + 13, { tam: 8.8, align: 'right' });
    pag.texto(dinero(e, it.importe), cols[5] - 8, y + 13, { tam: 8.8, align: 'right' });
    y += alto;
    pag.linea(M, y, 612 - M, y, '#e2e7f0');
  }
  return y + 10;
}

function totales(pag, y, e, filas) {
  const x0 = 612 - M - 230;
  filas.forEach(([et, val, o = {}]) => {
    if (o.raya) { pag.linea(x0, y - 3, 612 - M, y - 3, OSC, 1.4); y += 4; }
    pag.texto(et, x0, y + 10, { tam: o.grande ? 11 : 9, bold: !!o.grande, color: o.color || '#222' });
    pag.texto(val, 612 - M, y + 10, { tam: o.grande ? 11 : 9, bold: !!o.grande, color: o.color || '#222', align: 'right' });
    y += o.grande ? 18 : 15;
  });
  return y;
}

function pie(pag, y, texto, firmas) {
  pag.linea(M, y, 612 - M, y, '#dddddd');
  y += 12;
  if (texto) y = pag.parrafo(texto, M, y, ANCHO_UTIL, { tam: 8, color: '#555', maxLineas: 4 }) + 6;
  y = Math.max(y, 700);
  const w = (ANCHO_UTIL - 60) / 2;
  firmas.forEach((f, i) => {
    const x = M + i * (w + 60);
    pag.linea(x, y, x + w, y, '#999999');
    pag.texto(f, x + w / 2, y + 12, { tam: 8, color: '#666', align: 'center', max: w });
  });
}

/* ------------------------------------------------------- factura / cotización */
function pdfDocumento(d, e) {
  const pag = new Pagina();
  const imagenes = [];
  const esFactura = d.tipo === 'factura';
  const derecha = [['No.', d.numero]];
  if (d.ncf) derecha.push(['NCF:', d.ncf]);
  derecha.push(['Fecha:', fmtFecha(d.fecha)]);
  derecha.push([esFactura ? 'Vence:' : 'Válido hasta:', fmtFecha(d.vencimiento)]);

  let y = cabecera(pag, e, esFactura ? 'FACTURA' : 'PRESUPUESTO', derecha, imagenes);

  const cli = d.cliente || {};
  const lineasCli = [cli.nombre || d.cliente_nombre || '—'];
  if (cli.rnc || d.cliente_rnc) lineasCli.push(`RNC/Cédula: ${cli.rnc || d.cliente_rnc}`);
  if (cli.direccion) lineasCli.push(cli.direccion);
  if (cli.telefono) lineasCli.push(`Tel.: ${cli.telefono}`);
  if (cli.email) lineasCli.push(cli.email);

  const lineasRes = [`Estado: ${d.estado}`, `Moneda: ${e.moneda}`];
  if (esFactura) { lineasRes.push(`Pagado: ${dinero(e, d.pagado)}`); lineasRes.push(`Balance: ${dinero(e, d.balance)}`); }

  y = bloques(pag, y, { titulo: 'Cliente', lineas: lineasCli }, { titulo: 'Resumen', lineas: lineasRes });
  y = tablaItems(pag, y, e, d.items);

  const filas = [['Subtotal', dinero(e, d.subtotal)]];
  if (d.descuento) filas.push(['Descuento', `- ${dinero(e, d.descuento)}`]);
  filas.push([`ITBIS (${e.itbis_tasa}%)`, dinero(e, d.itbis)]);
  filas.push(['TOTAL', dinero(e, d.total), { grande: true, raya: true }]);
  y = totales(pag, y, e, filas) + 10;

  if (d.notas) y = pag.parrafo(`Notas: ${d.notas}`, M, y, ANCHO_UTIL, { tam: 8.5, color: '#333', maxLineas: 4 }) + 8;

  pie(pag, Math.min(Math.max(y, 640), 690), d.condiciones || e.condiciones,
    ['Elaborado por', 'Recibido conforme']);
  return construirPDF([pag], imagenes);
}

/* ------------------------------------------------------------------ recibo */
function pdfRecibo(r, e) {
  const pag = new Pagina();
  const imagenes = [];
  const derecha = [['No.', r.recibo], ['Fecha:', fmtFecha(r.fecha)]];
  let y = cabecera(pag, e, 'RECIBO DE INGRESO', derecha, imagenes);

  pag.texto(dinero(e, r.monto), 612 - M, y - 2, { tam: 16, bold: true, color: OSC, align: 'right' });
  y += 14;

  const lineasCli = [r.cliente || '—'];
  if (r.cliente_rnc) lineasCli.push(`RNC/Cédula: ${r.cliente_rnc}`);
  if (r.cliente_direccion) lineasCli.push(r.cliente_direccion);

  const lineasPago = [`Método: ${r.metodo}`];
  if (r.referencia) lineasPago.push(`Referencia: ${r.referencia}`);
  if (r.factura) lineasPago.push(`Aplicado a factura: ${r.factura}`);
  lineasPago.push(`Categoría: ${r.categoria}`);

  y = bloques(pag, y, { titulo: 'Recibido de', lineas: lineasCli }, { titulo: 'Detalle del pago', lineas: lineasPago });

  pag.rect(M, y, ANCHO_UTIL, 18, OSC);
  pag.texto('CONCEPTO', M + 8, y + 12.5, { tam: 7.5, bold: true, color: '#ffffff' });
  pag.texto('MONTO', 612 - M - 8, y + 12.5, { tam: 7.5, bold: true, color: '#ffffff', align: 'right' });
  y += 18;
  const lineas = envolver(r.concepto, 9, false, 360);
  lineas.forEach((l, i) => pag.texto(l, M + 8, y + 14 + i * 11, { tam: 9 }));
  pag.texto(dinero(e, r.monto), 612 - M - 8, y + 14, { tam: 9, align: 'right' });
  y += Math.max(22, 10 + lineas.length * 11);
  pag.linea(M, y, 612 - M, y, '#e2e7f0');
  y += 12;

  y = totales(pag, y, e, [['TOTAL RECIBIDO', dinero(e, r.monto), { grande: true, raya: true }]]) + 10;
  if (r.notas) y = pag.parrafo(`Notas: ${r.notas}`, M, y, ANCHO_UTIL, { tam: 8.5, color: '#333', maxLineas: 3 }) + 8;

  pie(pag, Math.min(Math.max(y, 640), 690),
    'Este recibo confirma el pago descrito. Conserve este documento como comprobante.',
    [`Recibido por (${e.nombre})`, 'Entregado por']);
  return construirPDF([pag], imagenes);
}

module.exports = { pdfDocumento, pdfRecibo, dinero, fmtFecha, medir };
