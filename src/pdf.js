'use strict';
/* Generador de PDF mínimo, sin dependencias externas.
   Suficiente para facturas, presupuestos y recibos: texto (Helvetica), rectángulos,
   líneas e imágenes JPEG/PNG del logo. Tamaño carta (612 x 792 puntos). */

const zlib = require('node:zlib');

const ANCHO = 612;
const ALTO = 792;

// Anchos de carácter de Helvetica (unidades /1000) para medir y recortar texto
const ANCHOS_HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const ANCHOS_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

function anchoChar(code, bold) {
  const t = bold ? ANCHOS_BOLD : ANCHOS_HELV;
  if (code >= 32 && code <= 126) return t[code - 32];
  return bold ? 556 : 500; // acentos y demás: aproximación razonable
}

function medir(texto, tam, bold) {
  let w = 0;
  for (const ch of String(texto)) w += anchoChar(ch.charCodeAt(0), bold);
  return (w * tam) / 1000;
}

function recortar(texto, tam, bold, maxAncho) {
  let t = String(texto);
  if (medir(t, tam, bold) <= maxAncho) return t;
  while (t.length > 1 && medir(t + '…', tam, bold) > maxAncho) t = t.slice(0, -1);
  return t + '…';
}

/** Divide un texto en líneas que caben en el ancho dado. */
function envolver(texto, tam, bold, maxAncho) {
  const palabras = String(texto).split(/\s+/).filter(Boolean);
  const lineas = [];
  let actual = '';
  for (const p of palabras) {
    const prueba = actual ? actual + ' ' + p : p;
    if (medir(prueba, tam, bold) <= maxAncho) actual = prueba;
    else { if (actual) lineas.push(actual); actual = recortar(p, tam, bold, maxAncho); }
  }
  if (actual) lineas.push(actual);
  return lineas.length ? lineas : [''];
}

/* --- codificación de texto a WinAnsi (Latin-1) para que salgan los acentos --- */
const ESPECIALES = { '€': 128, '‚': 130, 'ƒ': 131, '„': 132, '…': 133, '†': 134, '‡': 135, 'ˆ': 136, '‰': 137, 'Š': 138, '‹': 139, 'Œ': 140, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149, '–': 150, '—': 151, '™': 153, 'š': 154, '›': 155, 'œ': 156, 'Ÿ': 159 };
function aWinAnsi(texto) {
  const bytes = [];
  for (const ch of String(texto)) {
    const c = ch.codePointAt(0);
    if (c < 256) bytes.push(c);
    else if (ESPECIALES[ch] !== undefined) bytes.push(ESPECIALES[ch]);
    else bytes.push(63); // '?'
  }
  return Buffer.from(bytes);
}
function escaparPDF(buf) {
  const out = [];
  for (const b of buf) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  return Buffer.from(out);
}

/* ------------------------------------------------------------------ lienzo */
class Pagina {
  constructor() { this.ops = []; }
  color(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  rect(x, y, w, h, hex) {
    const [r, g, b] = this.color(hex);
    this.ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`, `${x} ${ALTO - y - h} ${w} ${h} re f`);
    return this;
  }
  linea(x1, y1, x2, y2, hex = '#cccccc', grosor = 0.7) {
    const [r, g, b] = this.color(hex);
    this.ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`, `${grosor} w`,
      `${x1} ${ALTO - y1} m ${x2} ${ALTO - y2} l S`);
    return this;
  }
  texto(t, x, y, o = {}) {
    const tam = o.tam || 10;
    const bold = !!o.bold;
    let s = String(t ?? '');
    if (o.max) s = recortar(s, tam, bold, o.max);
    let px = x;
    if (o.align === 'right') px = x - medir(s, tam, bold);
    else if (o.align === 'center') px = x - medir(s, tam, bold) / 2;
    const [r, g, b] = this.color(o.color || '#111111');
    const cuerpo = escaparPDF(aWinAnsi(s)).toString('latin1');
    this.ops.push('BT', `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`,
      `/${bold ? 'F2' : 'F1'} ${tam} Tf`, `1 0 0 1 ${px.toFixed(2)} ${(ALTO - y).toFixed(2)} Tm`,
      `(${cuerpo}) Tj`, 'ET');
    return this;
  }
  parrafo(t, x, y, maxAncho, o = {}) {
    const tam = o.tam || 10, alto = o.alto || tam * 1.35;
    const lineas = envolver(t, tam, !!o.bold, maxAncho).slice(0, o.maxLineas || 99);
    lineas.forEach((l, i) => this.texto(l, x, y + i * alto, o));
    return y + lineas.length * alto;
  }
  imagen(nombre, x, y, w, h) {
    this.ops.push('q', `${w} 0 0 ${h} ${x} ${ALTO - y - h} cm`, `/${nombre} Do`, 'Q');
    return this;
  }
  contenido() { return this.ops.join('\n'); }
}

/* ------------------------------------------------------------- documento */
function construirPDF(paginas, imagenes = []) {
  const objetos = [];
  const agregar = (buf) => { objetos.push(buf); return objetos.length; }; // devuelve nº de objeto

  const idFuente1 = agregar(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  const idFuente2 = agregar(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));

  const idsImg = [];
  for (const img of imagenes) {
    const cab = `<< /Type /XObject /Subtype /Image /Width ${img.ancho} /Height ${img.alto} ` +
      `/ColorSpace /${img.gris ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.datos.length} >>`;
    idsImg.push({ nombre: img.nombre, id: agregar(Buffer.concat([Buffer.from(cab + '\nstream\n', 'latin1'), img.datos, Buffer.from('\nendstream', 'latin1')])) });
  }

  const recursos = `<< /Font << /F1 ${idFuente1} 0 R /F2 ${idFuente2} 0 R >>` +
    (idsImg.length ? ` /XObject << ${idsImg.map((i) => `/${i.nombre} ${i.id} 0 R`).join(' ')} >>` : '') + ' >>';

  const idPaginas = objetos.length + paginas.length * 2 + 1; // reservamos hueco
  const idsPagina = [];
  for (const pag of paginas) {
    const flujo = zlib.deflateSync(Buffer.from(pag.contenido(), 'latin1'));
    const idFlujo = agregar(Buffer.concat([
      Buffer.from(`<< /Length ${flujo.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), flujo, Buffer.from('\nendstream', 'latin1'),
    ]));
    idsPagina.push(agregar(Buffer.from(
      `<< /Type /Page /Parent ${idPaginas} 0 R /MediaBox [0 0 ${ANCHO} ${ALTO}] /Resources ${recursos} /Contents ${idFlujo} 0 R >>`, 'latin1')));
  }
  const idArbol = agregar(Buffer.from(`<< /Type /Pages /Kids [${idsPagina.map((i) => `${i} 0 R`).join(' ')}] /Count ${idsPagina.length} >>`, 'latin1'));
  const idCatalogo = agregar(Buffer.from(`<< /Type /Catalog /Pages ${idArbol} 0 R >>`, 'latin1'));

  const partes = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let pos = partes[0].length;
  const offsets = [0];
  objetos.forEach((obj, i) => {
    offsets.push(pos);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), obj, Buffer.from('\nendobj\n', 'latin1')]);
    partes.push(b); pos += b.length;
  });
  let xref = `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objetos.length; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size ${objetos.length + 1} /Root ${idCatalogo} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  partes.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(partes);
}

/* --------------------------------------------------- logo (solo JPEG) ----- */
function leerJPEG(dataUrl) {
  try {
    const m = /^data:image\/(jpe?g);base64,(.+)$/i.exec(String(dataUrl).replace(/\s/g, ''));
    if (!m) return null;
    const datos = Buffer.from(m[2], 'base64');
    let i = 2;
    while (i < datos.length) {
      if (datos[i] !== 0xff) { i++; continue; }
      const marca = datos[i + 1];
      if (marca >= 0xc0 && marca <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marca)) {
        return { datos, alto: datos.readUInt16BE(i + 5), ancho: datos.readUInt16BE(i + 7), gris: datos[i + 9] === 1 };
      }
      i += 2 + datos.readUInt16BE(i + 2);
    }
  } catch { /* logo no compatible: se omite */ }
  return null;
}

module.exports = { Pagina, construirPDF, leerJPEG, medir, envolver, recortar, ANCHO, ALTO };
