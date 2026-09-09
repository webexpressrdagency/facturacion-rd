'use strict';
/* =========================================================================
   Sistema de Facturación y Recibos — cliente
   ========================================================================= */

const S = { empresa: null, usuario: null, vista: 'panel', cache: {} };

/* ------------------------------------------------------------------ utils */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const hoy = () => new Date().toISOString().slice(0, 10);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n2 = (v) => (Math.round((Number(v) || 0) * 100) / 100);
const SIMBOLOS = { DOP: 'RD$', USD: 'US$' };
/* Cada importe se muestra con su propia moneda; si no se indica, con la
   predeterminada de la empresa. Nunca se convierte entre monedas. */
const simbolo = (mon) => SIMBOLOS[mon] || S.empresa?.simbolo || 'RD$';
const money = (v, mon) => `${simbolo(mon || S.empresa?.moneda)} ${n2(v).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Suma una lista agrupando por moneda y la devuelve ya formateada. */
function totalPorMoneda(filas, campo = 'monto') {
  const acc = {};
  for (const f of filas) acc[f.moneda || 'DOP'] = (acc[f.moneda || 'DOP'] || 0) + (Number(f[campo]) || 0);
  const partes = Object.entries(acc).filter(([, v]) => Math.abs(v) > 0.009)
    .map(([m, v]) => `<span class="nw">${money(v, m)}</span>`);
  return partes.length ? partes.join(' · ') : money(0);
}

/** Selector de moneda reutilizable. */
const selectorMoneda = (nombre, actual, extra = '') => `<select name="${nombre}" ${extra}>` +
  Object.entries(SIMBOLOS).map(([c, sim]) =>
    `<option value="${c}" ${(actual || S.empresa?.moneda) === c ? 'selected' : ''}>${sim} · ${c}</option>`).join('') +
  '</select>';
const fecha = (f) => (f ? f.split('-').reverse().join('/') : '—');
const mesNombre = (m) => {
  const [a, mm] = m.split('-');
  return ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'][Number(mm) - 1] + ' ' + a.slice(2);
};
const primerDiaAnio = () => `${new Date().getFullYear()}-01-01`;

function toast(msg, tipo = '') {
  const d = document.createElement('div');
  d.className = 'toast ' + tipo;
  d.textContent = msg;
  $('#aviso').appendChild(d);
  setTimeout(() => d.remove(), 4200);
}

/* Base de la aplicación: permite instalarla en un subdirectorio del hosting
   (ej. https://midominio.com/facturacion) sin tocar el código. */
const BASE = (() => {
  const s = document.currentScript || [...document.scripts].find((x) => /app\.js/.test(x.src));
  if (!s || !s.src) return '';
  return new URL(s.src, location.href).pathname.replace(/\/app\.js.*$/, '');
})();
const url = (r) => BASE + r;

// El logo se resuelve con la misma base, para que funcione también en subcarpetas
(() => {
  const img = document.getElementById('logoAcceso');
  if (!img) return;
  img.onload = () => { img.hidden = false; };
  img.onerror = () => { img.remove(); };
  img.src = url('/logo.png');
})();

async function api(ruta, opts = {}) {
  const res = await fetch(url(ruta), {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !ruta.includes('/auth/')) { mostrarLogin(); throw new Error('Sesión expirada'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || 'Error en la operación');
  return data;
}

/* ------------------------------------------------------------------ modal */
function modal({ titulo, cuerpo, ancho, botones = [], alAbrir }) {
  const dlg = $('#modal');
  $('#modalTitulo').textContent = titulo;
  $('#modalCuerpo').innerHTML = cuerpo;
  dlg.style.maxWidth = ancho || 'min(960px,95vw)';
  const pie = $('#modalPie');
  pie.innerHTML = '';
  botones.forEach((b) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = b.clase || '';
    el.textContent = b.texto;
    el.onclick = async () => {
      try { const r = await b.accion(dlg); if (r !== false) dlg.close(); }
      catch (e) { toast(e.message, 'error'); }
    };
    pie.appendChild(el);
  });
  $$('[data-cerrar]', dlg).forEach((b) => (b.onclick = () => dlg.close()));
  if (!dlg.open) dlg.showModal();   // permite reemplazar el contenido sin cerrar
  if (alAbrir) alAbrir(dlg);
  return dlg;
}
function cerrarModal() { $('#modal').close(); }

async function confirmar(texto) {
  return new Promise((resolve) => {
    modal({
      titulo: 'Confirmar', ancho: '440px', cuerpo: `<p style="margin:.2rem 0 .4rem">${esc(texto)}</p>`,
      botones: [
        { texto: 'Cancelar', accion: () => { resolve(false); } },
        { texto: 'Sí, continuar', clase: 'btn-primario', accion: () => { resolve(true); } },
      ],
    });
  });
}

function datosForm(ctx) {
  const o = {};
  $$('[name]', ctx).forEach((el) => {
    if (el.type === 'checkbox') o[el.name] = el.checked ? 1 : 0;
    else if (el.type === 'number') o[el.name] = el.value === '' ? 0 : Number(el.value);
    else o[el.name] = el.value;
  });
  return o;
}

/* ------------------------------------------------------------------ auth */
function mostrarLogin() {
  $('#login').style.display = 'grid';
  $('#app').classList.remove('activo');
}

$('#formLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const d = datosForm(e.target);
    S.usuario = await api('/api/auth/login', { method: 'POST', body: d });
    await iniciar();
  } catch (err) { toast(err.message, 'error'); }
});

$('#salir').onclick = async () => {
  await api('/api/auth/logout', { method: 'POST' });
  S.usuario = null;
  mostrarLogin();
};

/* ------------------------------------------------------------------ arranque */
async function iniciar() {
  $('#login').style.display = 'none';
  $('#app').classList.add('activo');
  S.empresa = await api('/api/empresa');
  pintarMarca();
  $('#usuarioLat').textContent = `${S.usuario.nombre || S.usuario.usuario} (${S.usuario.rol})`;
  irA(location.hash.replace('#', '') || 'panel');
}

function pintarMarca() {
  $('#nombreLat').textContent = S.empresa.nombre;
  const img = $('#logoLat');
  if (S.empresa.logo) { img.src = S.empresa.logo; img.hidden = false; } else img.hidden = true;
  document.title = `${S.empresa.nombre} — Facturación`;
}

function irA(vista) {
  S.vista = vista;
  location.hash = vista;
  $$('aside nav a').forEach((a) => a.classList.toggle('on', a.dataset.vista === vista));
  const fn = vistas[vista] || vistas.panel;
  $('#vista').innerHTML = '<div class="tarjeta">Cargando…</div>';
  Promise.resolve(fn()).then(fijarColumnaAcciones).catch((e) => {
    $('#vista').innerHTML = `<div class="tarjeta"><b>Error:</b> ${esc(e.message)}</div>`;
  });
}

/* La columna de botones se ancla a la derecha solo si la tabla no cabe;
   si cabe entera, se deja normal para no tapar ninguna columna. */
function fijarColumnaAcciones() {
  $$('.tabla-scroll.con-acciones').forEach((d) => {
    d.classList.toggle('fijar', d.scrollWidth > d.clientWidth + 2);
  });
}
window.addEventListener('resize', () => setTimeout(fijarColumnaAcciones, 200));
$$('aside nav a').forEach((a) => (a.onclick = () => irA(a.dataset.vista)));
window.addEventListener('hashchange', () => {
  const v = location.hash.replace('#', '');
  if (v && v !== S.vista) irA(v);
});

/* ------------------------------------------------------------------ gráficos (canvas puro) */
function medirAncho(canvas, minimo = 320) {
  const padre = canvas.parentElement;
  let w = 0;
  if (padre) {
    const cs = getComputedStyle(padre);
    w = padre.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
  }
  if (!w || w < minimo) w = Math.max(canvas.clientWidth || 0, minimo);
  return Math.floor(w);
}

function graficoBarras(canvas, datos, opciones = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = medirAncho(canvas), h = opciones.alto || 240;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const c = canvas.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, w, h);
  const padL = 62, padB = 26, padT = 14, padR = 8;
  const gw = w - padL - padR, gh = h - padB - padT;
  const series = opciones.series || [];
  const max = Math.max(1, ...datos.flatMap((d) => series.map((s) => Number(d[s.campo]) || 0)));
  const paso = Math.pow(10, Math.floor(Math.log10(max)));
  const tope = Math.ceil(max / paso) * paso || 1;
  c.font = '10px system-ui,sans-serif';
  for (let i = 0; i <= 4; i++) {
    const y = padT + gh - (gh * i) / 4;
    c.strokeStyle = '#eceff3'; c.beginPath(); c.moveTo(padL, y); c.lineTo(w - padR, y); c.stroke();
    c.fillStyle = '#5b6472'; c.textAlign = 'right';
    c.fillText(((tope * i) / 4).toLocaleString('es-DO', { maximumFractionDigits: 0 }), padL - 6, y + 3);
  }
  const anchoGrupo = gw / Math.max(datos.length, 1);
  const anchoBarra = Math.min(20, (anchoGrupo - 6) / Math.max(series.length, 1));
  datos.forEach((d, i) => {
    const x0 = padL + i * anchoGrupo + (anchoGrupo - anchoBarra * series.length) / 2;
    series.forEach((s, j) => {
      const v = Number(d[s.campo]) || 0;
      const alto = (v / tope) * gh;
      c.fillStyle = s.color;
      c.beginPath();
      const x = x0 + j * anchoBarra, y = padT + gh - alto;
      const r = Math.min(3, anchoBarra / 2, alto);
      c.moveTo(x, padT + gh); c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
      c.lineTo(x + anchoBarra - r - 1, y); c.quadraticCurveTo(x + anchoBarra - 1, y, x + anchoBarra - 1, y + r);
      c.lineTo(x + anchoBarra - 1, padT + gh); c.closePath(); c.fill();
    });
    const salto = anchoGrupo < 38 ? 2 : 1;   // evita etiquetas encimadas
    if (i % salto === 0 || i === datos.length - 1) {
      c.fillStyle = '#5b6472'; c.textAlign = 'center';
      c.fillText(opciones.etiqueta ? opciones.etiqueta(d) : d.mes, padL + i * anchoGrupo + anchoGrupo / 2, h - 8);
    }
  });
}

function graficoDona(canvas, datos, opciones = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = medirAncho(canvas, 260), h = opciones.alto || 210;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const c = canvas.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, w, h);
  const total = datos.reduce((a, d) => a + (Number(d.total) || 0), 0);
  const anchoLeyenda = Math.min(190, Math.max(110, w * 0.45));
  const zona = Math.max(90, Math.min(h, w - anchoLeyenda));
  const cx = zona / 2, cy = h / 2, R = Math.min(zona, h) / 2 - 12, r = R * 0.58;
  const xLey = zona + 10;
  const colores = ['#192d4b', '#62d02c', '#2f5f9e', '#a3d977', '#4a6a9c', '#c47d0b', '#d33b3b', '#8892a0'];
  if (!total) { c.fillStyle = '#5b6472'; c.textAlign = 'center'; c.font = '12px system-ui'; c.fillText('Sin datos en el período', w / 2, h / 2); return; }
  let ang = -Math.PI / 2;
  datos.forEach((d, i) => {
    const a = ((Number(d.total) || 0) / total) * Math.PI * 2;
    c.fillStyle = colores[i % colores.length];
    c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, R, ang, ang + a); c.closePath(); c.fill();
    ang += a;
  });
  c.globalCompositeOperation = 'destination-out';
  c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
  c.globalCompositeOperation = 'source-over';
  c.font = '10.5px system-ui,sans-serif'; c.textAlign = 'left';
  const visibles = datos.slice(0, Math.max(3, Math.floor((h - 16) / 17)));
  const alto = visibles.length * 17;
  visibles.forEach((d, i) => {
    const y = (h - alto) / 2 + 12 + i * 17;
    c.fillStyle = colores[i % colores.length];
    c.fillRect(xLey, y - 8, 9, 9);
    c.fillStyle = '#0d0f12';
    const pct = Math.round(((Number(d.total) || 0) / total) * 100);
    let txt = `${d.categoria || d.nombre || '—'} · ${pct}%`;
    const maxAncho = w - xLey - 16;
    while (txt.length > 4 && c.measureText(txt).width > maxAncho) txt = txt.slice(0, -2) + '…';
    c.fillText(txt, xLey + 14, y);
  });
}

let temporizadorResize;
window.addEventListener('resize', () => {
  if (S.vista !== 'panel') return;
  clearTimeout(temporizadorResize);
  temporizadorResize = setTimeout(() => irA('panel'), 350);
});

/* ------------------------------------------------------------------ tablas */
function tabla({ columnas, filas, vacio = 'No hay registros', acciones }) {
  if (!filas.length) return `<div class="vacio">${esc(vacio)}</div>`;
  const th = columnas.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.t)}</th>`).join('') + (acciones ? '<th></th>' : '');
  const tb = filas.map((f, i) => {
    const tds = columnas.map((c) => `<td class="${c.num ? 'num' : ''}">${c.v(f, i)}</td>`).join('');
    return `<tr>${tds}${acciones ? `<td class="num" style="white-space:nowrap">${acciones(f, i)}</td>` : ''}</tr>`;
  }).join('');
  // Las tablas de pocas columnas (resúmenes por moneda) no necesitan ancho
  // mínimo: así caben en las medias columnas del panel y de reportes.
  const n = columnas.length + (acciones ? 1 : 0);
  const compacta = n <= 3 ? ' compacta' : (n <= 5 ? ' media' : '');
  // Con muchas columnas se reserva ancho suficiente para que el texto no se
  // parta en varias líneas: la tarjeta se desplaza en horizontal si hace falta.
  const ancho = n >= 6 ? ` style="min-width:${Math.max(760, n * 96)}px"` : '';
  const clases = `tabla-scroll${compacta}${acciones ? ' con-acciones' : ''}`;
  return `<div class="${clases}"><table${ancho}><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
}

const chip = (estado) => `<span class="chip ${esc(estado)}">${esc(estado)}</span>`;

/* ======================================================================
   VISTAS
   ====================================================================== */
const vistas = {};

/* --------------------------------------------------------------- PANEL */
vistas.panel = async function () {
  const desde = S.cache.panelDesde || primerDiaAnio();
  const hasta = S.cache.panelHasta || hoy();
  const r = await api(`/api/reportes/resumen?desde=${desde}&hasta=${hasta}`);
  const cxc = await api('/api/reportes/cuentas-por-cobrar');

  // Un bloque por moneda: los importes nunca se mezclan ni se convierten
  const bloque = (m) => {
    const d = r.porMoneda[m];
    const conMovimiento = d.nIngresos || d.nGastos || d.nFacturas || d.nPorCobrar || d.inventarioArticulos;
    if (!conMovimiento && m !== S.empresa.moneda) return '';
    return `
    <div class="tarjeta" style="padding:.9rem 1rem 1.1rem">
      <h3 style="display:flex;align-items:center;gap:.5rem">
        <span class="chip pagada" style="font-size:.8rem">${esc(d.simbolo)}</span>
        <span style="color:var(--suave);font-weight:600;font-size:.9rem">${esc(m)}</span>
      </h3>
      <div class="rejilla kpis">
        <div class="kpi verde"><div class="etq">Ingresos</div><div class="val">${money(d.ingresos, m)}</div><div class="nota">${d.nIngresos} recibos</div></div>
        <div class="kpi rojo"><div class="etq">Gastos</div><div class="val">${money(d.gastos, m)}</div><div class="nota">${d.nGastos} registros</div></div>
        <div class="kpi ${d.balance >= 0 ? 'azul' : 'rojo'}"><div class="etq">Utilidad</div><div class="val">${money(d.balance, m)}</div><div class="nota">Ingresos − gastos</div></div>
        <div class="kpi ambar"><div class="etq">Por cobrar</div><div class="val">${money(d.porCobrar, m)}</div><div class="nota">${d.nPorCobrar} facturas · ${d.nVencidas} vencidas</div></div>
        <div class="kpi azul"><div class="etq">Facturado</div><div class="val">${money(d.facturado, m)}</div><div class="nota">${d.nFacturas} facturas</div></div>
        <div class="kpi"><div class="etq">ITBIS a pagar</div><div class="val">${money(d.itbisPagar, m)}</div><div class="nota">Ventas ${money(d.itbisVentas, m)} − compras ${money(d.itbisCompras, m)}</div></div>
        ${d.inventarioArticulos ? `<div class="kpi"><div class="etq">Inventario</div><div class="val">${money(d.inventarioValor, m)}</div><div class="nota">${d.inventarioArticulos} artículos</div></div>` : ''}
      </div>
      <div class="dos" style="margin-top:1rem">
        <div class="tarjeta" style="margin:0">
          <h3>Ingresos y gastos · últimos 12 meses</h3>
          <canvas id="gBarras_${m}"></canvas>
          <div style="font-size:.8rem;color:var(--suave);margin-top:.4rem">
            <span style="color:#0f9d58">■</span> Ingresos &nbsp; <span style="color:#d93b3b">■</span> Gastos &nbsp;·&nbsp; en ${esc(d.simbolo)}
          </div>
        </div>
        <div class="tarjeta" style="margin:0"><h3>Gastos por categoría</h3><canvas id="gDona_${m}"></canvas></div>
      </div>
    </div>`;
  };

  $('#vista').innerHTML = `
  <div class="encabezado">
    <div><h1>Panel de control</h1><div class="sub">Resumen del ${fecha(desde)} al ${fecha(hasta)} · cada moneda por separado, sin conversiones</div></div>
    <div class="filtros" style="margin:0">
      <div><label>Desde</label><input type="date" id="pDesde" value="${desde}"></div>
      <div><label>Hasta</label><input type="date" id="pHasta" value="${hasta}"></div>
      <button class="btn-primario" id="pAplicar">Aplicar</button>
    </div>
  </div>

  ${r.monedas.map(bloque).join('')}

  ${r.bajoMinimo.length ? `<div class="tarjeta" style="border-left:4px solid var(--ambar)">
    <h3>⚠️ Artículos por reponer</h3>
    ${tabla({
      columnas: [
        { t: 'Artículo', v: (p) => `<b>${esc(p.nombre)}</b>` },
        { t: 'Existencia', num: 1, v: (p) => `<b style="color:${p.existencia <= 0 ? 'var(--rojo)' : 'var(--ambar)'}">${n2(p.existencia)} ${esc(p.unidad)}</b>` },
        { t: 'Mínimo', num: 1, v: (p) => n2(p.minimo) },
        { t: 'Costo de reposición', num: 1, v: (p) => money(Math.max(p.minimo - p.existencia, 0) * p.costo, p.moneda) },
      ], filas: r.bajoMinimo.slice(0, 8),
      acciones: (p) => `<button class="btn-mini btn-primario" onclick="movimiento(${p.id},'entrada')">Registrar entrada</button>`,
    })}
  </div>` : ''}

  <div class="dos">
    <div class="tarjeta">
      <h3>Facturas pendientes de cobro</h3>
      ${tabla({
        columnas: [
          { t: 'Factura', v: (f) => `<a onclick="verDocumento(${f.id})" style="cursor:pointer">${esc(f.numero)}</a>` },
          { t: 'Cliente', v: (f) => esc(f.cliente || '—') },
          { t: 'Vence', v: (f) => `${fecha(f.vencimiento)} ${f.vencida ? '<span class="chip vencida">vencida</span>' : ''}` },
          { t: 'Balance', num: 1, v: (f) => money(f.balance, f.moneda) },
        ], filas: cxc.slice(0, 10), vacio: 'No hay facturas pendientes. 🎉',
      })}
    </div>
    <div class="tarjeta">
      <h3>Mejores clientes</h3>
      ${r.monedas.map((m) => {
        const top = r.porMoneda[m].topClientes;
        if (!top.length) return '';
        return `<h4 style="margin:.6rem 0 .3rem;color:var(--suave);font-size:.82rem">En ${esc(r.porMoneda[m].simbolo)}</h4>` +
          tabla({ columnas: [{ t: 'Cliente', v: (f) => esc(f.nombre) }, { t: 'Facturado', num: 1, v: (f) => money(f.total, m) }], filas: top });
      }).join('') || '<div class="vacio">Aún no hay facturación en el período</div>'}
    </div>
  </div>`;

  for (const m of r.monedas) {
    const d = r.porMoneda[m];
    const b = document.getElementById('gBarras_' + m);
    const o = document.getElementById('gDona_' + m);
    if (b) graficoBarras(b, d.serie, {
      series: [{ campo: 'ingresos', color: '#62d02c' }, { campo: 'gastos', color: '#d33b3b' }],
      etiqueta: (x) => mesNombre(x.mes), alto: 250,
    });
    if (o) graficoDona(o, d.gastosCat, { alto: 250 });
  }
  $('#pAplicar').onclick = () => {
    S.cache.panelDesde = $('#pDesde').value; S.cache.panelHasta = $('#pHasta').value; irA('panel');
  };
};

/* --------------------------------------------------------- DOCUMENTOS */
function vistaDocumentos(tipo) {
  return async function () {
    const esFactura = tipo === 'factura';
    const f = S.cache['f_' + tipo] || { q: '', estado: '', desde: '', hasta: '' };
    const qs = new URLSearchParams({ tipo, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) });
    const docs = await api('/api/documentos?' + qs);
    const total = docs.filter((d) => d.estado !== 'anulada').reduce((a, d) => a + d.total, 0);
    const balance = docs.reduce((a, d) => a + (['emitida', 'parcial'].includes(d.estado) ? d.balance : 0), 0);

    const estados = esFactura
      ? ['borrador', 'emitida', 'parcial', 'pagada', 'anulada']
      : ['borrador', 'enviado', 'aprobado', 'rechazado', 'facturado'];

    $('#vista').innerHTML = `
    <div class="encabezado">
      <div><h1>${esFactura ? 'Facturas' : 'Presupuestos'}</h1>
        <div class="sub">${docs.length} documentos · Total ${totalPorMoneda(docs.filter((d) => d.estado !== 'anulada'), 'total')}${esFactura ? ` · Por cobrar ${totalPorMoneda(docs.filter((d) => ['emitida', 'parcial'].includes(d.estado)), 'balance')}` : ''}</div></div>
      <div style="display:flex;gap:.5rem">
        <button id="btnExport">⬇ Exportar CSV</button>
        <button class="btn-primario" id="btnNuevo">+ ${esFactura ? 'Nueva factura' : 'Nuevo presupuesto'}</button>
      </div>
    </div>
    <div class="tarjeta">
      <div class="filtros">
        <div style="min-width:220px"><label>Buscar</label><input id="fq" value="${esc(f.q)}" placeholder="Número, NCF o cliente"></div>
        <div><label>Estado</label><select id="festado"><option value="">Todos</option>
          ${estados.map((e) => `<option ${f.estado === e ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
        <div><label>Desde</label><input type="date" id="fdesde" value="${f.desde}"></div>
        <div><label>Hasta</label><input type="date" id="fhasta" value="${f.hasta}"></div>
        <button class="btn-primario" id="fAplicar">Filtrar</button>
        <button id="fLimpiar">Limpiar</button>
      </div>
      ${tabla({
        columnas: [
          { t: 'Número', v: (d) => `<a onclick="verDocumento(${d.id})" style="cursor:pointer"><b>${esc(d.numero)}</b></a>` },
          ...(esFactura ? [{ t: 'NCF', v: (d) => esc(d.ncf || '—') }] : []),
          { t: 'Fecha', v: (d) => fecha(d.fecha) },
          { t: 'Cliente', v: (d) => esc(d.cliente || '—') },
          { t: esFactura ? 'Vence' : 'Válido hasta', v: (d) => fecha(d.vencimiento) },
          { t: 'Moneda', v: (d) => esc(simbolo(d.moneda)) },
          { t: 'Total', num: 1, v: (d) => `<b>${money(d.total, d.moneda)}</b>` },
          ...(esFactura ? [{ t: 'Balance', num: 1, v: (d) => (d.balance > 0.009 && d.estado !== 'anulada' ? `<span style="color:var(--rojo)">${money(d.balance, d.moneda)}</span>` : '—') }] : []),
          { t: 'Estado', v: (d) => chip(d.estado) },
        ],
        filas: docs,
        vacio: `No hay ${esFactura ? 'facturas' : 'presupuestos'} con esos filtros`,
        acciones: (d) => `
          <button class="btn-mini" title="Ver el documento" onclick="verDocumento(${d.id})">Ver</button>
          <button class="btn-mini" title="Editar" onclick="editarDocumento('${tipo}',${d.id})">✏️</button>
          <button class="btn-mini" title="Enviar por correo" onclick="enviarCorreo('documento',${d.id})">✉️</button>
          <button class="btn-mini" title="Enviar por WhatsApp" onclick="compartir('documento',${d.id})">💬</button>
          ${esFactura && ['emitida', 'parcial'].includes(d.estado) ? `<button class="btn-mini" onclick="cobrar(${d.id})">Cobrar</button>` : ''}
          ${!esFactura && d.estado !== 'facturado' ? `<button class="btn-mini" onclick="convertir(${d.id})">Facturar</button>` : ''}
          <button class="btn-mini btn-peligro" onclick="borrarDocumento(${d.id},'${tipo}')">✕</button>`,
      })}
    </div>`;

    $('#btnNuevo').onclick = () => editarDocumento(tipo, null);
    $('#btnExport').onclick = () => (location.href = url(`/api/export/${esFactura ? 'facturas' : 'presupuestos'}`));
    $('#fAplicar').onclick = () => {
      S.cache['f_' + tipo] = { q: $('#fq').value, estado: $('#festado').value, desde: $('#fdesde').value, hasta: $('#fhasta').value };
      irA(esFactura ? 'facturas' : 'presupuestos');
    };
    $('#fLimpiar').onclick = () => { S.cache['f_' + tipo] = null; irA(esFactura ? 'facturas' : 'presupuestos'); };
    $('#fq').onkeydown = (e) => { if (e.key === 'Enter') $('#fAplicar').click(); };
  };
}
vistas.facturas = vistaDocumentos('factura');
vistas.presupuestos = vistaDocumentos('presupuesto');

/* ---- editor de documentos ---- */
let EDITOR = { items: [], tipo: 'factura', id: null };

window.editarDocumento = async function (tipo, id) {
  const [clientes, productos, ncf] = await Promise.all([
    api('/api/contactos?tipo=cliente&activo=1'), api('/api/productos?activo=1'), api('/api/ncf'),
  ]);
  let doc = null;
  if (id) doc = await api('/api/documentos/' + id);
  EDITOR = {
    tipo, id, productos,
    moneda: doc?.moneda || S.empresa.moneda,
    bloqueada: !!(doc && doc.pagos && doc.pagos.length),   // con cobros ya no se puede cambiar
    items: doc ? doc.items.map((i) => ({ ...i })) : [{ descripcion: '', cantidad: 1, precio: 0, descuento: 0, itbis: 1 }],
  };
  const esFactura = tipo === 'factura';
  const series = ncf.filter((s) => s.activo);

  modal({
    titulo: (id ? 'Editar ' : 'Nueva ') + (esFactura ? 'factura' : 'presupuesto') + (doc ? ` ${doc.numero}` : ''),
    ancho: 'min(1020px,96vw)',
    cuerpo: `
      <div class="campos">
        <div style="grid-column:span 2"><label>Cliente</label>
          <select name="contacto_id" id="selCliente">
            <option value="">— Seleccione o escriba abajo —</option>
            ${clientes.map((c) => `<option value="${c.id}" ${doc && doc.contacto_id === c.id ? 'selected' : ''}>${esc(c.nombre)}${c.rnc ? ' · ' + esc(c.rnc) : ''}</option>`).join('')}
          </select></div>
        <div><label>O nombre del cliente ocasional</label><input name="cliente_nombre" value="${esc(doc?.contacto_id ? '' : doc?.cliente_nombre || '')}"></div>
        <div><label>RNC / Cédula</label><input name="cliente_rnc" value="${esc(doc?.contacto_id ? '' : doc?.cliente_rnc || '')}"></div>
        <div><label>Moneda</label>
          ${selectorMoneda('moneda', doc?.moneda, 'id="selMoneda"' + (doc && doc.pagos && doc.pagos.length ? ' disabled' : ''))}
          ${doc && doc.pagos && doc.pagos.length ? '<div style="font-size:.76rem;color:var(--suave);margin-top:.2rem">No se puede cambiar: ya tiene cobros.</div>' : ''}</div>
        <div><label>Fecha</label><input type="date" name="fecha" value="${doc?.fecha || hoy()}"></div>
        <div><label>${esFactura ? 'Vencimiento' : 'Válido hasta'}</label><input type="date" name="vencimiento" value="${doc?.vencimiento || ''}"></div>
        <div><label>Estado</label><select name="estado">
          ${(esFactura ? ['emitida', 'borrador', 'pagada', 'anulada'] : ['borrador', 'enviado', 'aprobado', 'rechazado'])
            .map((e) => `<option ${doc?.estado === e ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
        ${esFactura ? `<div><label>Tipo de comprobante (NCF)</label>
          <select name="ncf_tipo" ${doc?.ncf ? 'disabled' : ''}>
            <option value="">Sin NCF</option>
            ${series.map((s) => `<option value="${s.tipo}" ${doc?.ncf_tipo === s.tipo ? 'selected' : ''}>${s.tipo} · ${esc(s.descripcion)} (${s.disponibles} disp.)</option>`).join('')}
          </select>${doc?.ncf ? `<div style="font-size:.78rem;color:var(--suave);margin-top:.2rem">NCF asignado: <b>${esc(doc.ncf)}</b></div>` : ''}</div>` : ''}
      </div>

      <h3 style="margin-top:1.1rem">Detalle</h3>
      <div class="tabla-scroll"><table class="lineas"><thead><tr>
        <th style="width:30%">Descripción</th><th style="width:22%">Producto/servicio</th>
        <th class="num" style="width:9%">Cant.</th><th class="num" style="width:14%">Precio</th>
        <th class="num" style="width:9%">Desc.%</th><th style="width:7%">ITBIS</th>
        <th class="num" style="width:13%">Importe</th><th></th></tr></thead>
        <tbody id="lineas"></tbody></table></div>
      <button type="button" class="btn-mini" id="addLinea" style="margin-top:.5rem">+ Agregar línea</button>

      <div style="display:flex;gap:1.2rem;flex-wrap:wrap;margin-top:1rem">
        <div style="flex:1;min-width:250px">
          <label>Notas</label><textarea name="notas">${esc(doc?.notas || '')}</textarea>
          <label style="margin-top:.6rem">Condiciones</label>
          <textarea name="condiciones" style="min-height:56px">${esc(doc?.condiciones ?? S.empresa.condiciones)}</textarea>
        </div>
        <div class="totales">
          <div><span>Subtotal</span><b id="tSub">—</b></div>
          <div><span>Descuento global</span><input type="number" step="0.01" name="descuento" id="tDesc" value="${doc?.descuento || 0}" style="width:120px;text-align:right"></div>
          <div><span>ITBIS (${S.empresa.itbis_tasa}%)</span><b id="tItbis">—</b></div>
          <div class="grande"><span>TOTAL</span><b id="tTotal">—</b></div>
        </div>
      </div>`,
    botones: [
      { texto: 'Cancelar', accion: () => {} },
      { texto: 'Guardar', clase: 'btn-primario', accion: async (dlg) => { await guardarDocumento(dlg); } },
    ],
    alAbrir: (dlg) => {
      pintarLineas();
      $('#addLinea', dlg).onclick = () => { EDITOR.items.push({ descripcion: '', cantidad: 1, precio: 0, descuento: 0, itbis: 1 }); pintarLineas(); };
      $('#tDesc', dlg).oninput = recalcular;
      const selMon = $('#selMoneda', dlg);
      if (selMon) selMon.onchange = () => { EDITOR.moneda = selMon.value; pintarLineas(); };
      $('#selCliente', dlg).onchange = (e) => {
        if (e.target.value) { $('[name=cliente_nombre]', dlg).value = ''; $('[name=cliente_rnc]', dlg).value = ''; }
      };
    },
  });
};

function pintarLineas() {
  const tb = $('#lineas');
  const mismos = EDITOR.productos.filter((p) => (p.moneda || 'DOP') === EDITOR.moneda);
  const otros = EDITOR.productos.filter((p) => (p.moneda || 'DOP') !== EDITOR.moneda);
  const opcion = (p) => `<option value="${p.id}">${esc(p.nombre)}</option>`;
  const ops = `<optgroup label="En ${esc(simbolo(EDITOR.moneda))}">${mismos.map(opcion).join('')}</optgroup>` +
    (otros.length ? `<optgroup label="En otra moneda — revise el precio">${otros.map(opcion).join('')}</optgroup>` : '');
  tb.innerHTML = EDITOR.items.map((it, i) => `
    <tr>
      <td><input value="${esc(it.descripcion)}" data-i="${i}" data-c="descripcion"></td>
      <td><select data-i="${i}" data-c="producto_id"><option value="">—</option>${ops}</select></td>
      <td><input type="number" step="0.01" class="num" value="${it.cantidad}" data-i="${i}" data-c="cantidad" style="text-align:right"></td>
      <td><input type="number" step="0.01" class="num" value="${it.precio}" data-i="${i}" data-c="precio" style="text-align:right"></td>
      <td><input type="number" step="0.01" class="num" value="${it.descuento}" data-i="${i}" data-c="descuento" style="text-align:right"></td>
      <td style="text-align:center"><input type="checkbox" ${it.itbis ? 'checked' : ''} data-i="${i}" data-c="itbis" style="width:auto"></td>
      <td class="num" data-imp="${i}">—</td>
      <td><button type="button" class="btn-mini btn-peligro" data-del="${i}">✕</button></td>
    </tr>`).join('');
  EDITOR.items.forEach((it, i) => { if (it.producto_id) { const s = tb.querySelector(`select[data-i="${i}"]`); if (s) s.value = it.producto_id; } });
  $$('[data-c]', tb).forEach((el) => {
    el.oninput = el.onchange = () => {
      const i = Number(el.dataset.i), c = el.dataset.c;
      if (c === 'itbis') EDITOR.items[i].itbis = el.checked ? 1 : 0;
      else if (c === 'producto_id') {
        const p = EDITOR.productos.find((x) => x.id === Number(el.value));
        EDITOR.items[i].producto_id = el.value ? Number(el.value) : null;
        if (p) {
          EDITOR.items[i].descripcion = p.nombre + (p.descripcion ? ' — ' + p.descripcion : '');
          EDITOR.items[i].precio = p.precio; EDITOR.items[i].itbis = p.itbis;
          if ((p.moneda || 'DOP') !== EDITOR.moneda) {
            toast(`"${p.nombre}" tiene el precio en ${simbolo(p.moneda)} y el documento está en ${simbolo(EDITOR.moneda)}. Revise el precio.`, 'error');
          }
          pintarLineas(); return;
        }
      } else if (c === 'descripcion') EDITOR.items[i][c] = el.value;
      else EDITOR.items[i][c] = Number(el.value) || 0;
      recalcular();
    };
  });
  $$('[data-del]', tb).forEach((b) => (b.onclick = () => {
    EDITOR.items.splice(Number(b.dataset.del), 1);
    if (!EDITOR.items.length) EDITOR.items.push({ descripcion: '', cantidad: 1, precio: 0, descuento: 0, itbis: 1 });
    pintarLineas();
  }));
  recalcular();
}

function recalcular() {
  const tasa = Number(S.empresa.itbis_tasa) || 0;
  let sub = 0;
  EDITOR.items.forEach((it, i) => {
    const imp = n2((Number(it.cantidad) || 0) * (Number(it.precio) || 0) * (1 - (Number(it.descuento) || 0) / 100));
    it._imp = imp; sub += imp;
    const celda = $(`[data-imp="${i}"]`); if (celda) celda.textContent = money(imp, EDITOR.moneda);
  });
  sub = n2(sub);
  const dg = Math.min(Number($('#tDesc')?.value) || 0, sub);
  const factor = sub > 0 ? (sub - dg) / sub : 0;
  const itbis = n2(EDITOR.items.reduce((a, it) => a + (it.itbis ? it._imp * factor * (tasa / 100) : 0), 0));
  $('#tSub').textContent = money(sub, EDITOR.moneda);
  $('#tItbis').textContent = money(itbis, EDITOR.moneda);
  $('#tTotal').textContent = money(n2(sub - dg + itbis), EDITOR.moneda);
}

async function guardarDocumento(dlg) {
  const d = datosForm($('#modalCuerpo'));
  const body = {
    ...d, tipo: EDITOR.tipo, moneda: EDITOR.moneda,
    crear_cliente: !d.contacto_id && !!String(d.cliente_nombre || '').trim(),
    items: EDITOR.items.filter((i) => String(i.descripcion).trim()),
  };
  if (!body.items.length) throw new Error('Agregue al menos una línea con descripción');
  if (!body.contacto_id && !String(body.cliente_nombre || '').trim()) throw new Error('Indique el cliente');
  const res = EDITOR.id
    ? await api('/api/documentos/' + EDITOR.id, { method: 'PUT', body })
    : await api('/api/documentos', { method: 'POST', body });
  toast(`${EDITOR.tipo === 'factura' ? 'Factura' : 'Presupuesto'} ${res.numero} guardado`, 'ok');
  if (res.aviso) toast(res.aviso, 'error');
  (res.avisosStock || []).forEach((a) => toast('Inventario — ' + a, 'error'));
  void dlg;
  irA(EDITOR.tipo === 'factura' ? 'facturas' : 'presupuestos');
}

window.borrarDocumento = async function (id, tipo) {
  if (!(await confirmar('¿Eliminar este documento? Esta acción no se puede deshacer.'))) return;
  try { await api('/api/documentos/' + id, { method: 'DELETE' }); toast('Documento eliminado', 'ok'); irA(tipo === 'factura' ? 'facturas' : 'presupuestos'); }
  catch (e) { toast(e.message, 'error'); }
};

window.convertir = async function (id) {
  const ncf = await api('/api/ncf');
  const activas = ncf.filter((s) => s.activo);
  modal({
    titulo: 'Convertir presupuesto en factura', ancho: '460px',
    cuerpo: `<label>Tipo de comprobante (NCF)</label>
      <select name="ncf_tipo"><option value="">Sin NCF</option>
      ${activas.map((s) => `<option value="${s.tipo}">${s.tipo} · ${esc(s.descripcion)} (${s.disponibles} disp.)</option>`).join('')}</select>
      <p style="color:var(--suave);font-size:.83rem;margin-top:.7rem">Se creará una factura nueva con las mismas líneas y el presupuesto quedará marcado como <b>facturado</b>.</p>`,
    botones: [
      { texto: 'Cancelar', accion: () => {} },
      { texto: 'Crear factura', clase: 'btn-primario', accion: async () => {
        const d = datosForm($('#modalCuerpo'));
        const f = await api(`/api/documentos/${id}/facturar`, { method: 'POST', body: d });
        toast('Factura ' + f.numero + ' creada', 'ok');
        irA('facturas');
      } },
    ],
  });
};

window.verDocumento = async function (id) {
  const d = await api('/api/documentos/' + id);
  const esFactura = d.tipo === 'factura';
  modal({
    titulo: `${esFactura ? 'Factura' : 'Presupuesto'} ${d.numero}`, ancho: 'min(900px,96vw)',
    cuerpo: `
      <div class="campos" style="margin-bottom:.9rem">
        <div><label>Cliente</label><b>${esc(d.cliente?.nombre || d.cliente_nombre || '—')}</b></div>
        <div><label>RNC / Cédula</label>${esc(d.cliente?.rnc || d.cliente_rnc || '—')}</div>
        <div><label>Fecha</label>${fecha(d.fecha)}</div>
        <div><label>${esFactura ? 'Vencimiento' : 'Válido hasta'}</label>${fecha(d.vencimiento)}</div>
        ${esFactura ? `<div><label>NCF</label>${esc(d.ncf || '—')}</div>` : ''}
        <div><label>Estado</label>${chip(d.estado)}</div>
        <div><label>Moneda</label><b>${esc(simbolo(d.moneda))} · ${esc(d.moneda)}</b></div>
      </div>
      ${tabla({
        columnas: [
          { t: 'Descripción', v: (i) => esc(i.descripcion) },
          { t: 'Cant.', num: 1, v: (i) => i.cantidad },
          { t: 'Precio', num: 1, v: (i) => money(i.precio, d.moneda) },
          { t: 'Desc.', num: 1, v: (i) => (i.descuento ? i.descuento + '%' : '—') },
          { t: 'Importe', num: 1, v: (i) => money(i.importe, d.moneda) },
        ], filas: d.items,
      })}
      <div class="totales" style="margin-top:.6rem">
        <div><span>Subtotal</span><b>${money(d.subtotal, d.moneda)}</b></div>
        ${d.descuento ? `<div><span>Descuento</span><b>− ${money(d.descuento, d.moneda)}</b></div>` : ''}
        <div><span>ITBIS</span><b>${money(d.itbis, d.moneda)}</b></div>
        <div class="grande"><span>TOTAL</span><b>${money(d.total, d.moneda)}</b></div>
        ${esFactura ? `<div><span>Pagado</span><b style="color:var(--verde)">${money(d.pagado, d.moneda)}</b></div>
          <div><span>Balance</span><b style="color:${d.balance > 0.009 ? 'var(--rojo)' : 'var(--verde)'}">${money(d.balance, d.moneda)}</b></div>` : ''}
      </div>
      ${d.pagos?.length ? `<h3 style="margin-top:1rem">Pagos recibidos</h3>${tabla({
        columnas: [
          { t: 'Recibo', v: (p) => `<a onclick="imprimirRecibo(${p.id})" style="cursor:pointer">${esc(p.recibo)}</a>` },
          { t: 'Fecha', v: (p) => fecha(p.fecha) }, { t: 'Método', v: (p) => esc(p.metodo) },
          { t: 'Monto', num: 1, v: (p) => money(p.monto, d.moneda) },
        ], filas: d.pagos,
      })}` : ''}
      ${d.notas ? `<p style="margin-top:.9rem"><b>Notas:</b> ${esc(d.notas)}</p>` : ''}`,
    botones: [
      { texto: 'Cerrar', accion: () => {} },
      ...(esFactura && ['emitida', 'parcial'].includes(d.estado) ? [{ texto: '💵 Cobrar', accion: () => { cerrarModal(); cobrar(d.id); return false; } }] : []),
      { texto: '📎 PDF', accion: () => { window.open(url(`/api/documentos/${d.id}/pdf?ver=1`), '_blank'); return false; } },
      { texto: '💬 WhatsApp', accion: () => { cerrarModal(); compartir('documento', d.id); return false; } },
      { texto: '✉️ Enviar por correo', clase: 'btn-primario', accion: () => { cerrarModal(); enviarCorreo('documento', d.id); return false; } },
    ],
  });
};

/* ------------------------------------------------- envío por correo / WhatsApp */
window.enviarCorreo = async function (tipo, id) {
  const cfg = await api('/api/correo');
  if (!cfg.activo || !cfg.tiene_clave) {
    modal({
      titulo: 'Configure primero su correo', ancho: '520px',
      cuerpo: `<p>Para enviar documentos por correo hay que indicar los datos de su cuenta (servidor, usuario y contraseña).</p>
        <p style="color:var(--suave);font-size:.88rem">Con Gmail necesita una <b>contraseña de aplicación</b>, no la de su cuenta. En Configuración → Correo le explico cómo obtenerla.</p>`,
      botones: [{ texto: 'Ahora no', accion: () => {} },
        { texto: 'Ir a Configuración', clase: 'btn-primario', accion: () => { irA('config'); } }],
    });
    return;
  }
  const ruta = tipo === 'recibo' ? `/api/ingresos/${id}/compartir` : `/api/documentos/${id}/compartir`;
  const c = await api(ruta);
  modal({
    titulo: `Enviar ${c.titulo} por correo`, ancho: '640px',
    cuerpo: `<div class="campos">
      <div class="campo-ancho"><label>Para</label><input name="para" value="${esc(c.email)}" placeholder="cliente@correo.com">
        ${c.email ? '' : '<div style="font-size:.78rem;color:var(--ambar);margin-top:.2rem">Este cliente no tiene correo guardado en su ficha.</div>'}</div>
      <div class="campo-ancho"><label>Copia (opcional)</label><input name="copia" value="${esc(cfg.copia || '')}"></div>
      <div class="campo-ancho"><label>Asunto</label><input name="asunto" placeholder="Se usará la plantilla de Configuración"></div>
      <div class="campo-ancho"><label>Mensaje</label><textarea name="mensaje" style="min-height:110px" placeholder="Se usará la plantilla de Configuración"></textarea></div>
      <div class="campo-ancho" style="background:#f5f8ff;border:1px solid #d8e2fb;border-radius:8px;padding:.6rem .8rem;font-size:.85rem">
        Se adjunta el PDF y se incluye este enlace para verlo en línea:<br>
        <a href="${esc(c.enlace)}" target="_blank" style="word-break:break-all">${esc(c.enlace)}</a>
      </div>
    </div>`,
    botones: [
      { texto: 'Cancelar', accion: () => {} },
      { texto: 'Enviar', clase: 'btn-primario', accion: async (dlg) => {
        const b = datosForm($('#modalCuerpo'));
        const btn = $('#modalPie button.btn-primario');
        btn.disabled = true; btn.textContent = 'Enviando…';
        try {
          const r = await api(tipo === 'recibo' ? `/api/ingresos/${id}/correo` : `/api/documentos/${id}/correo`, { method: 'POST', body: b });
          toast('Enviado a ' + r.para.join(', '), 'ok');
        } finally { btn.disabled = false; btn.textContent = 'Enviar'; }
        void dlg;
      } },
    ],
  });
};

window.compartir = async function (tipo, id) {
  const ruta = tipo === 'recibo' ? `/api/ingresos/${id}/compartir` : `/api/documentos/${id}/compartir`;
  const c = await api(ruta);
  modal({
    titulo: `Compartir ${c.titulo}`, ancho: '620px',
    cuerpo: `<div class="campos">
      <div class="campo-ancho"><label>Enlace para el cliente (no necesita clave)</label>
        <input id="cEnlace" value="${esc(c.enlace)}" readonly onclick="this.select()"></div>
      <div><label>Teléfono del cliente</label><input id="cTel" value="${esc(c.telefono)}" placeholder="809-000-0000">
        ${c.telefono ? '' : '<div style="font-size:.78rem;color:var(--ambar);margin-top:.2rem">Sin teléfono en la ficha: escríbalo aquí.</div>'}</div>
      <div style="display:flex;align-items:flex-end"><button type="button" class="btn-primario" id="cWA" style="width:100%;justify-content:center">💬 Abrir WhatsApp</button></div>
      <div class="campo-ancho"><label>Mensaje que se enviará</label><textarea id="cMsg" style="min-height:95px">${esc(c.mensaje)}</textarea></div>
      <div class="campo-ancho" style="color:var(--suave);font-size:.83rem">
        Se abrirá WhatsApp con el mensaje listo; usted solo pulsa enviar. Cualquiera con el enlace puede ver el documento, así que compártalo solo con su cliente.
      </div>
    </div>`,
    botones: [
      { texto: 'Cerrar', accion: () => {} },
      { texto: 'Copiar enlace', accion: async () => {
        try { await navigator.clipboard.writeText(c.enlace); toast('Enlace copiado', 'ok'); }
        catch { $('#cEnlace').select(); toast('Pulse Ctrl+C para copiar', ''); }
        return false;
      } },
      ...(tipo === 'documento' ? [{ texto: 'Revocar enlace', clase: 'btn-peligro', accion: async () => {
        if (!(await confirmar('¿Revocar el enlace? Quien lo tenga dejará de ver el documento.'))) return false;
        await api(`/api/documentos/${id}/compartir`, { method: 'DELETE' });
        toast('Enlace revocado', 'ok');
      } }] : []),
    ],
    alAbrir: () => {
      $('#cWA').onclick = () => {
        const tel = $('#cTel').value.replace(/\D/g, '');
        let n = tel;
        if (n.length === 10 && /^(809|829|849)/.test(n)) n = '1' + n;
        const enlace = `https://wa.me/${n}?text=${encodeURIComponent($('#cMsg').value)}`;
        window.open(enlace, '_blank');
        api('/api/whatsapp', { method: 'POST', body: {
          [tipo === 'recibo' ? 'ingreso_id' : 'documento_id']: id, destino: $('#cTel').value, titulo: c.titulo } }).catch(() => {});
      };
    },
  });
};

/* --------------------------------------------------------- fin envíos */

window.cobrar = async function (id) {
  const d = await api('/api/documentos/' + id);
  modal({
    titulo: `Registrar cobro · ${d.numero}`, ancho: '520px',
    cuerpo: `
      <p style="margin:0 0 .8rem;color:var(--suave)">Balance pendiente:
        <b style="color:var(--rojo)">${money(d.balance, d.moneda)}</b>
        <span style="margin-left:.4rem">— el cobro se registra en ${esc(simbolo(d.moneda))} (${esc(d.moneda)}), la moneda de la factura</span></p>
      <div class="campos">
        <div><label>Fecha</label><input type="date" name="fecha" value="${hoy()}"></div>
        <div><label>Monto</label><input type="number" step="0.01" name="monto" value="${n2(d.balance)}"></div>
        <div><label>Método</label><select name="metodo">
          ${['Efectivo', 'Transferencia', 'Cheque', 'Tarjeta', 'Depósito', 'Otro'].map((m) => `<option>${m}</option>`).join('')}</select></div>
        <div><label>Referencia</label><input name="referencia" placeholder="No. de cheque / transferencia"></div>
        <div class="campo-ancho"><label>Notas</label><input name="notas"></div>
      </div>`,
    botones: [
      { texto: 'Cancelar', accion: () => {} },
      { texto: 'Registrar y emitir recibo', clase: 'btn-primario', accion: async () => {
        const b = datosForm($('#modalCuerpo'));
        const rec = await api('/api/ingresos', { method: 'POST', body: { ...b, documento_id: id, categoria: 'Ventas' } });
        toast('Recibo ' + rec.recibo + ' registrado', 'ok');
        setTimeout(() => imprimirRecibo(rec.id), 300);
        irA(S.vista);
      } },
    ],
  });
};

/* --------------------------------------------------------- INGRESOS */
vistas.recibos = async function () {
  const f = S.cache.f_ing || { q: '', desde: '', hasta: '' };
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v)));
  const rows = await api('/api/ingresos?' + qs);
  const total = rows.reduce((a, r) => a + r.monto, 0);

  $('#vista').innerHTML = `
    <div class="encabezado">
      <div><h1>Ingresos y recibos</h1><div class="sub">${rows.length} registros · Total ${totalPorMoneda(rows)}</div></div>
      <div style="display:flex;gap:.5rem">
        <button id="btnExport">⬇ Exportar CSV</button>
        <button class="btn-primario" id="btnNuevo">+ Registrar ingreso</button>
      </div>
    </div>
    <div class="tarjeta">
      <div class="filtros">
        <div style="min-width:220px"><label>Buscar</label><input id="fq" value="${esc(f.q)}" placeholder="Recibo, concepto o cliente"></div>
        <div><label>Desde</label><input type="date" id="fdesde" value="${f.desde}"></div>
        <div><label>Hasta</label><input type="date" id="fhasta" value="${f.hasta}"></div>
        <button class="btn-primario" id="fAplicar">Filtrar</button>
        <button id="fLimpiar">Limpiar</button>
      </div>
      ${tabla({
        columnas: [
          { t: 'Recibo', v: (r) => `<a onclick="imprimirRecibo(${r.id})" style="cursor:pointer"><b>${esc(r.recibo)}</b></a>` },
          { t: 'Fecha', v: (r) => fecha(r.fecha) },
          { t: 'Concepto', v: (r) => esc(r.concepto) },
          { t: 'Cliente', v: (r) => esc(r.cliente || '—') },
          { t: 'Factura', v: (r) => (r.factura ? esc(r.factura) : '—') },
          { t: 'Categoría', v: (r) => esc(r.categoria) },
          { t: 'Método', v: (r) => esc(r.metodo) },
          { t: 'Moneda', v: (r) => esc(simbolo(r.moneda)) },
          { t: 'Monto', num: 1, v: (r) => `<b style="color:var(--verde)">${money(r.monto, r.moneda)}</b>` },
        ],
        filas: rows, vacio: 'Aún no hay ingresos registrados',
        acciones: (r) => `<button class="btn-mini" title="Imprimir" onclick="imprimirRecibo(${r.id})">🖨</button>
          <button class="btn-mini" title="Enviar por correo" onclick="enviarCorreo('recibo',${r.id})">✉️</button>
          <button class="btn-mini" title="Enviar por WhatsApp" onclick="compartir('recibo',${r.id})">💬</button>
          <button class="btn-mini btn-peligro" onclick="borrarIngreso(${r.id})">✕</button>`,
      })}
    </div>`;

  $('#btnNuevo').onclick = nuevoIngreso;
  $('#btnExport').onclick = () => (location.href = url('/api/export/ingresos'));
  $('#fAplicar').onclick = () => { S.cache.f_ing = { q: $('#fq').value, desde: $('#fdesde').value, hasta: $('#fhasta').value }; irA('recibos'); };
  $('#fLimpiar').onclick = () => { S.cache.f_ing = null; irA('recibos'); };
};

async function nuevoIngreso() {
  const [clientes, facturas] = await Promise.all([
    api('/api/contactos?tipo=cliente&activo=1'),
    api('/api/documentos?tipo=factura&estado=emitida').then((a) => api('/api/documentos?tipo=factura&estado=parcial').then((b) => [...a, ...b])),
  ]);
  modal({
    titulo: 'Registrar ingreso', ancho: '620px',
    cuerpo: `
      <div class="campos">
        <div class="campo-ancho"><label>Aplicar a factura (opcional)</label>
          <select name="documento_id" id="selFac"><option value="">— Ingreso libre —</option>
          ${facturas.map((d) => `<option value="${d.id}" data-bal="${d.balance}" data-moneda="${esc(d.moneda)}">${esc(d.numero)} · ${esc(d.cliente || '')} · pendiente ${esc(simbolo(d.moneda))} ${n2(d.balance)}</option>`).join('')}</select></div>
        <div class="campo-ancho"><label>Concepto</label><input name="concepto" placeholder="Ej. Abono cliente / Alquiler"></div>
        <div><label>Fecha</label><input type="date" name="fecha" value="${hoy()}"></div>
        <div><label>Moneda</label>${selectorMoneda('moneda', null, 'id="iMoneda"')}
          <div id="iMonedaNota" style="font-size:.76rem;color:var(--suave);margin-top:.2rem"></div></div>
        <div><label>Monto</label><input type="number" step="0.01" name="monto" id="mMonto" value="0"></div>
        <div><label>Categoría</label><select name="categoria">
          ${['Ventas', 'Servicios', 'Alquileres', 'Intereses', 'Otros ingresos'].map((c) => `<option>${c}</option>`).join('')}</select></div>
        <div><label>Método</label><select name="metodo">
          ${['Efectivo', 'Transferencia', 'Cheque', 'Tarjeta', 'Depósito', 'Otro'].map((m) => `<option>${m}</option>`).join('')}</select></div>
        <div><label>Cliente</label><select name="contacto_id"><option value="">—</option>
          ${clientes.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}</select></div>
        <div><label>Referencia</label><input name="referencia"></div>
        <div class="campo-ancho"><label>Notas</label><input name="notas"></div>
      </div>`,
    botones: [
      { texto: 'Cancelar', accion: () => {} },
      { texto: 'Guardar y emitir recibo', clase: 'btn-primario', accion: async () => {
        const b = datosForm($('#modalCuerpo'));
        b.moneda = $('#iMoneda').value;          // el campo puede estar deshabilitado
        const rec = await api('/api/ingresos', { method: 'POST', body: b });
        toast('Recibo ' + rec.recibo + ' registrado', 'ok');
        setTimeout(() => imprimirRecibo(rec.id), 300);
        irA('recibos');
      } },
    ],
    alAbrir: () => {
      const sel = $('#selFac'), mon = $('#iMoneda'), nota = $('#iMonedaNota');
      sel.onchange = (e) => {
        const op = e.target.selectedOptions[0];
        if (op && op.dataset.bal) {
          $('#mMonto').value = n2(op.dataset.bal);
          mon.value = op.dataset.moneda; mon.disabled = true;
          nota.textContent = `Fijada por la factura (${simbolo(op.dataset.moneda)}).`;
        } else {
          mon.disabled = false; nota.textContent = '';
        }
      };
    },
  });
}

window.borrarIngreso = async function (id) {
  if (!(await confirmar('¿Eliminar este ingreso? El balance de la factura se recalculará.'))) return;
  await api('/api/ingresos/' + id, { method: 'DELETE' });
  toast('Ingreso eliminado', 'ok'); irA('recibos');
};

/* --------------------------------------------------------- GASTOS */
vistas.gastos = async function () {
  const f = S.cache.f_gas || { q: '', desde: '', hasta: '', categoria: '' };
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v)));
  const rows = await api('/api/gastos?' + qs);
  const total = rows.reduce((a, r) => a + r.monto, 0);
  const itbis = rows.reduce((a, r) => a + (r.deducible ? r.itbis : 0), 0);

  $('#vista').innerHTML = `
    <div class="encabezado">
      <div><h1>Control de gastos</h1><div class="sub">${rows.length} registros · Total ${totalPorMoneda(rows)} · ITBIS deducible ${totalPorMoneda(rows.filter((g) => g.deducible), 'itbis')}</div></div>
      <div style="display:flex;gap:.5rem">
        <button id="btnExport">⬇ Exportar CSV</button>
        <button class="btn-primario" id="btnNuevo">+ Registrar gasto</button>
      </div>
    </div>
    <div class="tarjeta">
      <div class="filtros">
        <div style="min-width:200px"><label>Buscar</label><input id="fq" value="${esc(f.q)}" placeholder="Concepto, NCF o proveedor"></div>
        <div><label>Categoría</label><input id="fcat" value="${esc(f.categoria)}" placeholder="Todas"></div>
        <div><label>Desde</label><input type="date" id="fdesde" value="${f.desde}"></div>
        <div><label>Hasta</label><input type="date" id="fhasta" value="${f.hasta}"></div>
        <button class="btn-primario" id="fAplicar">Filtrar</button>
        <button id="fLimpiar">Limpiar</button>
      </div>
      ${tabla({
        columnas: [
          { t: 'Fecha', v: (g) => fecha(g.fecha) },
          { t: 'Concepto', v: (g) => esc(g.concepto) },
          { t: 'Categoría', v: (g) => esc(g.categoria) },
          { t: 'Proveedor', v: (g) => esc(g.proveedor || '—') },
          { t: 'NCF', v: (g) => esc(g.ncf || '—') },
          { t: 'Moneda', v: (g) => esc(simbolo(g.moneda)) },
          { t: 'Subtotal', num: 1, v: (g) => money(g.subtotal, g.moneda) },
          { t: 'ITBIS', num: 1, v: (g) => money(g.itbis, g.moneda) },
          { t: 'Total', num: 1, v: (g) => `<b style="color:var(--rojo)">${money(g.monto, g.moneda)}</b>` },
        ],
        filas: rows, vacio: 'Aún no hay gastos registrados',
        acciones: (g) => `<button class="btn-mini" onclick="editarGasto(${g.id})">Editar</button>
          <button class="btn-mini btn-peligro" onclick="borrarGasto(${g.id})">✕</button>`,
      })}
    </div>`;

  $('#btnNuevo').onclick = () => editarGasto(null);
  $('#btnExport').onclick = () => (location.href = url('/api/export/gastos'));
  $('#fAplicar').onclick = () => {
    S.cache.f_gas = { q: $('#fq').value, categoria: $('#fcat').value, desde: $('#fdesde').value, hasta: $('#fhasta').value }; irA('gastos');
  };
  $('#fLimpiar').onclick = () => { S.cache.f_gas = null; irA('gastos'); };
};

window.editarGasto = async function (id) {
  const proveedores = await api('/api/contactos?tipo=proveedor&activo=1');
  let g = null;
  if (id) g = (await api('/api/gastos')).find((x) => x.id === id);
  const cats = ['General', 'Materiales', 'Mano de obra', 'Combustible', 'Transporte', 'Alquiler', 'Servicios públicos',
    'Nómina', 'Impuestos', 'Equipos', 'Mantenimiento', 'Publicidad', 'Honorarios', 'Seguros', 'Otros'];
  modal({
    titulo: id ? 'Editar gasto' : 'Registrar gasto', ancho: '660px',
    cuerpo: `
      <div class="campos">
        <div class="campo-ancho"><label>Concepto</label><input name="concepto" value="${esc(g?.concepto || '')}" placeholder="Ej. Compra de cemento"></div>
        <div><label>Fecha</label><input type="date" name="fecha" value="${g?.fecha || hoy()}"></div>
        <div><label>Categoría</label><select name="categoria">${cats.map((c) => `<option ${g?.categoria === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div><label>Proveedor</label><select name="contacto_id"><option value="">—</option>
          ${proveedores.map((p) => `<option value="${p.id}" ${g?.contacto_id === p.id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select></div>
        <div><label>Moneda</label>${selectorMoneda('moneda', g?.moneda)}</div>
        <div><label>Subtotal</label><input type="number" step="0.01" name="subtotal" id="gSub" value="${g?.subtotal || 0}"></div>
        <div><label>ITBIS</label><input type="number" step="0.01" name="itbis" id="gItbis" value="${g?.itbis || 0}">
          <button type="button" class="btn-mini" id="calcItbis" style="margin-top:.25rem">Calcular ${S.empresa.itbis_tasa}%</button></div>
        <div><label>Total</label><input type="number" step="0.01" name="monto" id="gTotal" value="${g?.monto || 0}"></div>
        <div><label>Método de pago</label><select name="metodo">
          ${['Efectivo', 'Transferencia', 'Cheque', 'Tarjeta', 'Crédito'].map((m) => `<option ${g?.metodo === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <div><label>NCF del proveedor</label><input name="ncf" value="${esc(g?.ncf || '')}"></div>
        <div><label>No. comprobante</label><input name="comprobante" value="${esc(g?.comprobante || '')}"></div>
        <div><label>ITBIS deducible</label><select name="deducible"><option value="1" ${g?.deducible !== 0 ? 'selected' : ''}>Sí</option><option value="0" ${g?.deducible === 0 ? 'selected' : ''}>No</option></select></div>
        <div class="campo-ancho"><label>Notas</label><input name="notas" value="${esc(g?.notas || '')}"></div>
      </div>`,
    botones: [
      { texto: 'Cancelar', accion: () => {} },
      { texto: 'Guardar', clase: 'btn-primario', accion: async () => {
        const b = datosForm($('#modalCuerpo'));
        b.deducible = Number(b.deducible);
        await api(id ? '/api/gastos/' + id : '/api/gastos', { method: id ? 'PUT' : 'POST', body: b });
        toast('Gasto guardado', 'ok'); irA('gastos');
      } },
    ],
    alAbrir: () => {
      const sync = () => { $('#gTotal').value = n2((Number($('#gSub').value) || 0) + (Number($('#gItbis').value) || 0)); };
      $('#gSub').oninput = sync; $('#gItbis').oninput = sync;
      $('#calcItbis').onclick = () => {
        $('#gItbis').value = n2((Number($('#gSub').value) || 0) * (Number(S.empresa.itbis_tasa) || 0) / 100); sync();
      };
    },
  });
};

window.borrarGasto = async function (id) {
  if (!(await confirmar('¿Eliminar este gasto?'))) return;
  await api('/api/gastos/' + id, { method: 'DELETE' });
  toast('Gasto eliminado', 'ok'); irA('gastos');
};

/* ================================================================
   IMPORTAR DESDE CSV
   Dos pasos: se elige el archivo, se muestra qué se va a importar y
   solo entonces se confirma. Nada se guarda hasta el último clic.
   ================================================================ */
const IMPORTABLES = {
  proveedores: { titulo: 'proveedores', columnas: 'nombre, rnc, contacto, telefono, email, direccion, notas' },
  clientes: { titulo: 'clientes', columnas: 'nombre, rnc, contacto, telefono, email, direccion, notas' },
  productos: { titulo: 'artículos y servicios', columnas: 'codigo, nombre, descripcion, unidad, precio, costo, itbis, moneda, inventario, existencia, minimo' },
};

/* Excel en Windows suele guardar en ANSI: si el texto llega con caracteres
   rotos se vuelve a leer como windows-1252 para no perder las tildes. */
async function leerArchivoTexto(archivo) {
  const buf = await archivo.arrayBuffer();
  let texto = new TextDecoder('utf-8').decode(buf);
  if (texto.includes('�')) {
    try { texto = new TextDecoder('windows-1252').decode(buf); } catch { /* se deja el original */ }
  }
  return texto;
}

async function abrirImportador(tipo, alTerminar) {
  const info = IMPORTABLES[tipo];
  let texto = '', nombreArchivo = '';

  const paso1 = () => modal({
    titulo: `Importar ${info.titulo} desde CSV`, ancho: '640px',
    cuerpo: `
      <div class="zona-soltar" id="impZona">
        <div class="icono">📄</div>
        <p class="titulo">Arrastre aquí su archivo CSV</p>
        <p class="ayuda">o <button type="button" class="btn-enlace" id="impElegir">búsquelo en su computadora</button></p>
        <input type="file" id="impArchivo" accept=".csv,.txt,text/csv" hidden>
      </div>
      <p class="pista">Sirve cualquier archivo exportado desde Excel, Google Sheets o su sistema anterior,
        separado por coma, punto y coma o tabulador. La primera fila debe traer los nombres de las columnas.</p>
      <div class="nota-import">
        <b>Columnas que se reconocen</b>
        <div class="cols">${esc(info.columnas)}</div>
        <div class="ayuda">Solo <b>nombre</b> es obligatorio${tipo === 'productos' ? ' (para los artículos)' : ''}.
          Las demás pueden faltar y las columnas que no se reconozcan se ignoran.</div>
      </div>
      ${tipo === 'productos' ? `<div class="campos" style="margin-top:.8rem">
        <div><label>Moneda si el archivo no la trae</label>${selectorMoneda('moneda', S.empresa?.moneda)}</div></div>` : ''}
      <p style="margin:.9rem 0 0"><a href="${url(`/api/importar/${tipo}/plantilla`)}" class="enlace-descarga">⬇ Descargar plantilla de ejemplo</a></p>`,
    botones: [{ texto: 'Cancelar', accion: () => {} }],
    alAbrir: () => {
      const zona = $('#impZona'), input = $('#impArchivo');
      const tomar = async (archivo) => {
        if (!archivo) return;
        nombreArchivo = archivo.name;
        try {
          texto = await leerArchivoTexto(archivo);
          await analizar();
        } catch (e) { toast(e.message, 'error'); }
      };
      $('#impElegir').onclick = () => input.click();
      zona.onclick = (ev) => { if (ev.target === zona || ev.target.closest('.icono,.titulo')) input.click(); };
      input.onchange = () => tomar(input.files[0]);
      ['dragenter', 'dragover'].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add('activa'); }));
      ['dragleave', 'drop'].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove('activa'); }));
      zona.addEventListener('drop', (e) => tomar(e.dataTransfer.files[0]));
    },
  });

  const analizar = async () => {
    const monedaSel = $('[name=moneda]')?.value;
    const r = await api(`/api/importar/${tipo}`, { method: 'POST', body: { texto, moneda: monedaSel } });
    paso2(r, monedaSel);
  };

  const paso2 = (r, monedaSel) => {
    const chipEstado = (e) => `<span class="chip ${e === 'nuevo' ? 'pagada' : e === 'duplicado' ? 'parcial' : 'vencida'}">${e}</span>`;
    const reconocidas = r.columnas.filter((c) => c.campo);
    const filas = r.registros.map((x) => ({
      linea: x.linea, estado: x.estado, mensaje: x.mensaje,
      nombre: x.datos?.nombre || '—',
      detalle: tipo === 'productos'
        ? [x.datos?.codigo, x.datos?.precio ? `${simbolo(x.datos.moneda)} ${n2(x.datos.precio).toLocaleString('es-DO', { minimumFractionDigits: 2 })}` : ''].filter(Boolean).join(' · ')
        : [x.datos?.rnc, x.datos?.telefono, x.datos?.email].filter(Boolean).join(' · '),
    }));
    const hayDuplicados = r.resumen.duplicados > 0;

    modal({
      titulo: `Vista previa · ${esc(nombreArchivo)}`, ancho: 'min(900px,95vw)',
      cuerpo: `
        <div class="resumen-import">
          <div class="dato ok"><b>${r.resumen.nuevos}</b><span>se agregarán</span></div>
          <div class="dato aviso"><b>${r.resumen.duplicados}</b><span>ya existen</span></div>
          <div class="dato mal"><b>${r.resumen.errores}</b><span>con problemas</span></div>
          <div class="dato"><b>${r.resumen.total}</b><span>filas leídas</span></div>
        </div>
        <p class="pista">Columnas reconocidas: ${reconocidas.map((c) => `<code>${esc(c.titulo)}</code> → ${esc(c.campo)}`).join(', ') || '—'}.
          ${r.ignoradas.length ? `Se ignoran: ${r.ignoradas.map((c) => `<code>${esc(c)}</code>`).join(', ')}.` : ''}</p>
        ${hayDuplicados ? `<div class="campos" style="margin:.2rem 0 .6rem">
          <div class="campo-ancho"><label>Registros que ya existen</label>
            <select name="duplicados">
              <option value="omitir">Omitirlos y dejar los datos actuales</option>
              <option value="actualizar">Actualizarlos con los datos del archivo</option>
            </select></div></div>` : ''}
        ${tabla({
          columnas: [
            { t: 'Línea', num: 1, v: (f) => f.linea },
            { t: 'Nombre', v: (f) => `<b>${esc(f.nombre)}</b>` },
            { t: 'Datos', v: (f) => esc(f.detalle || '—') },
            { t: 'Estado', v: (f) => chipEstado(f.estado) + (f.mensaje ? ` <span class="ayuda">${esc(f.mensaje)}</span>` : '') },
          ], filas, vacio: 'El archivo no trae registros',
        })}`,
      botones: [
        { texto: 'Elegir otro archivo', accion: () => { paso1(); return false; } },
        { texto: hayDuplicados ? 'Importar ahora' : `Importar ${r.resumen.nuevos} registros`, clase: 'btn-primario', accion: async () => {
          const dup = $('[name=duplicados]')?.value || 'omitir';
          const res = await api(`/api/importar/${tipo}`, { method: 'POST', body: { texto, moneda: monedaSel, confirmar: 1, duplicados: dup } });
          const partes = [];
          if (res.creados) partes.push(`${res.creados} agregados`);
          if (res.actualizados) partes.push(`${res.actualizados} actualizados`);
          if (res.omitidos) partes.push(`${res.omitidos} omitidos`);
          toast(partes.length ? partes.join(', ') : 'No había nada que importar', res.creados || res.actualizados ? 'ok' : '');
          if (alTerminar) alTerminar();
        } },
      ],
    });
  };

  paso1();
}

/* --------------------------------------------------------- CONTACTOS */
function vistaContactos(tipo) {
  return async function () {
    const rows = await api('/api/contactos?tipo=' + tipo);
    const esCliente = tipo === 'cliente';
    $('#vista').innerHTML = `
      <div class="encabezado">
        <div><h1>${esCliente ? 'Clientes' : 'Proveedores'}</h1><div class="sub">${rows.length} registrados</div></div>
        <div class="acciones-encabezado">
          <button id="btnImportar">⬆ Importar CSV</button>
          <button id="btnExport">⬇ Exportar CSV</button>
          <button class="btn-primario" id="btnNuevo">+ Nuevo ${esCliente ? 'cliente' : 'proveedor'}</button>
        </div>
      </div>
      <div class="tarjeta">${tabla({
        columnas: [
          { t: 'Nombre', v: (c) => `<b>${esc(c.nombre)}</b>${c.activo ? '' : ' <span class="chip borrador">inactivo</span>'}` },
          { t: 'RNC / Cédula', v: (c) => esc(c.rnc || '—') },
          { t: 'Contacto', v: (c) => esc(c.contacto || '—') },
          { t: 'Teléfono', v: (c) => esc(c.telefono || '—') },
          { t: 'Email', v: (c) => esc(c.email || '—') },
        ],
        filas: rows, vacio: 'Aún no hay registros',
        acciones: (c) => `${esCliente ? `<button class="btn-mini" onclick="verContacto(${c.id})">Historial</button>` : ''}
          <button class="btn-mini" onclick="editarContacto('${tipo}',${c.id})">Editar</button>
          <button class="btn-mini btn-peligro" onclick="borrarContacto(${c.id},'${tipo}')">✕</button>`,
      })}</div>`;
    const area = esCliente ? 'clientes' : 'proveedores';
    $('#btnNuevo').onclick = () => editarContacto(tipo, null);
    $('#btnExport').onclick = () => (location.href = url(`/api/export/${area}`));
    $('#btnImportar').onclick = () => abrirImportador(area, () => { cerrarModal(); irA(area); });
  };
}
vistas.clientes = vistaContactos('cliente');
vistas.proveedores = vistaContactos('proveedor');

window.editarContacto = async function (tipo, id) {
  let c = null;
  if (id) c = await api('/api/contactos/' + id);
  modal({
    titulo: (id ? 'Editar ' : 'Nuevo ') + (tipo === 'cliente' ? 'cliente' : 'proveedor'), ancho: '620px',
    cuerpo: `<div class="campos">
      <div class="campo-ancho"><label>Nombre o razón social *</label><input name="nombre" value="${esc(c?.nombre || '')}"></div>
      <div><label>RNC / Cédula</label><input name="rnc" value="${esc(c?.rnc || '')}"></div>
      <div><label>Persona de contacto</label><input name="contacto" value="${esc(c?.contacto || '')}"></div>
      <div><label>Teléfono</label><input name="telefono" value="${esc(c?.telefono || '')}"></div>
      <div><label>Email</label><input name="email" value="${esc(c?.email || '')}"></div>
      <div class="campo-ancho"><label>Dirección</label><input name="direccion" value="${esc(c?.direccion || '')}"></div>
      <div class="campo-ancho"><label>Notas</label><textarea name="notas">${esc(c?.notas || '')}</textarea></div>
      <div><label>Estado</label><select name="activo"><option value="1" ${c?.activo !== 0 ? 'selected' : ''}>Activo</option><option value="0" ${c?.activo === 0 ? 'selected' : ''}>Inactivo</option></select></div>
    </div>`,
    botones: [
      { texto: 'Cancelar', accion: () => {} },
      { texto: 'Guardar', clase: 'btn-primario', accion: async () => {
        const b = datosForm($('#modalCuerpo'));
        b.tipo = tipo; b.activo = Number(b.activo);
        await api(id ? '/api/contactos/' + id : '/api/contactos', { method: id ? 'PUT' : 'POST', body: b });
        toast('Guardado', 'ok'); irA(tipo === 'cliente' ? 'clientes' : 'proveedores');
      } },
    ],
  });
};

window.borrarContacto = async function (id, tipo) {
  if (!(await confirmar('¿Eliminar este registro? Si tiene documentos asociados, se marcará como inactivo.'))) return;
  const r = await api('/api/contactos/' + id, { method: 'DELETE' });
  toast(r.desactivado ? 'Tenía documentos: se marcó como inactivo' : 'Eliminado', 'ok');
  irA(tipo === 'cliente' ? 'clientes' : 'proveedores');
};

window.verContacto = async function (id) {
  const c = await api('/api/contactos/' + id);
  modal({
    titulo: c.nombre, ancho: '760px',
    cuerpo: `<div class="campos" style="margin-bottom:1rem">
        <div><label>RNC / Cédula</label>${esc(c.rnc || '—')}</div>
        <div><label>Teléfono</label>${esc(c.telefono || '—')}</div>
        <div><label>Email</label>${esc(c.email || '—')}</div>
        <div class="campo-ancho"><label>Dirección</label>${esc(c.direccion || '—')}</div>
      </div>
      <h3>Historial de documentos</h3>
      ${tabla({
        columnas: [
          { t: 'Tipo', v: (d) => esc(d.tipo) },
          { t: 'Número', v: (d) => `<a onclick="cerrarModalYVer(${d.id})" style="cursor:pointer">${esc(d.numero)}</a>` },
          { t: 'Fecha', v: (d) => fecha(d.fecha) },
          { t: 'Total', num: 1, v: (d) => money(d.total, d.moneda) },
          { t: 'Estado', v: (d) => chip(d.estado) },
        ], filas: c.documentos, vacio: 'Sin documentos',
      })}`,
    botones: [{ texto: 'Cerrar', accion: () => {} }],
  });
};
window.cerrarModalYVer = (id) => { cerrarModal(); setTimeout(() => verDocumento(id), 150); };

/* --------------------------------------------------------- PRODUCTOS */
vistas.productos = async function () {
  const rows = await api('/api/productos');
  $('#vista').innerHTML = `
    <div class="encabezado">
      <div><h1>Productos y servicios</h1><div class="sub">${rows.length} artículos en el catálogo</div></div>
      <div class="acciones-encabezado">
        <button id="btnImportar">⬆ Importar CSV</button>
        <button class="btn-primario" id="btnNuevo">+ Nuevo artículo</button>
      </div>
    </div>
    <div class="tarjeta">${tabla({
      columnas: [
        { t: 'Código', v: (p) => esc(p.codigo || '—') },
        { t: 'Nombre', v: (p) => `<b>${esc(p.nombre)}</b>${p.activo ? '' : ' <span class="chip borrador">inactivo</span>'}` },
        { t: 'Descripción', v: (p) => esc((p.descripcion || '').slice(0, 60)) },
        { t: 'Unidad', v: (p) => esc(p.unidad) },
        { t: 'Moneda', v: (p) => esc(simbolo(p.moneda)) },
        { t: 'Costo', num: 1, v: (p) => money(p.costo, p.moneda) },
        { t: 'Precio', num: 1, v: (p) => `<b>${money(p.precio, p.moneda)}</b>` },
        { t: 'Margen', num: 1, v: (p) => (p.costo > 0 ? Math.round(((p.precio - p.costo) / p.costo) * 100) + '%' : '—') },
        { t: 'ITBIS', v: (p) => (p.itbis ? 'Sí' : 'No') },
        { t: 'Existencia', num: 1, v: (p) => (p.inventario
          ? `<b style="color:${p.existencia <= 0 ? 'var(--rojo)' : p.existencia <= p.minimo ? 'var(--ambar)' : 'var(--verde)'}">${n2(p.existencia)}</b>`
          : '<span style="color:var(--suave)">—</span>') },
      ],
      filas: rows, vacio: 'El catálogo está vacío',
      acciones: (p) => `<button class="btn-mini" onclick="editarProducto(${p.id})">Editar</button>
        <button class="btn-mini btn-peligro" onclick="borrarProducto(${p.id})">✕</button>`,
    })}</div>`;
  $('#btnNuevo').onclick = () => editarProducto(null);
  $('#btnImportar').onclick = () => abrirImportador('productos', () => { cerrarModal(); irA('productos'); });
};

window.editarProducto = async function (id) {
  let p = null;
  if (id) p = (await api('/api/productos')).find((x) => x.id === id);
  modal({
    titulo: id ? 'Editar artículo' : 'Nuevo artículo', ancho: '620px',
    cuerpo: `<div class="campos">
      <div><label>Código</label><input name="codigo" value="${esc(p?.codigo || '')}"></div>
      <div style="grid-column:span 2"><label>Nombre *</label><input name="nombre" value="${esc(p?.nombre || '')}"></div>
      <div class="campo-ancho"><label>Descripción</label><textarea name="descripcion">${esc(p?.descripcion || '')}</textarea></div>
      <div><label>Moneda del precio</label>${selectorMoneda('moneda', p?.moneda)}</div>
      <div><label>Unidad</label><input name="unidad" value="${esc(p?.unidad || 'ud')}"></div>
      <div><label>Costo</label><input type="number" step="0.01" name="costo" value="${p?.costo || 0}"></div>
      <div><label>Precio de venta</label><input type="number" step="0.01" name="precio" value="${p?.precio || 0}"></div>
      <div><label>Aplica ITBIS</label><select name="itbis"><option value="1" ${p?.itbis !== 0 ? 'selected' : ''}>Sí</option><option value="0" ${p?.itbis === 0 ? 'selected' : ''}>No</option></select></div>
      <div><label>Estado</label><select name="activo"><option value="1" ${p?.activo !== 0 ? 'selected' : ''}>Activo</option><option value="0" ${p?.activo === 0 ? 'selected' : ''}>Inactivo</option></select></div>
      <div class="campo-ancho" style="border-top:1px solid var(--linea);padding-top:.7rem;margin-top:.2rem">
        <label>Control de inventario</label>
        <select name="inventario" id="pInv"><option value="0" ${p?.inventario ? '' : 'selected'}>No lleva existencias (servicio)</option>
          <option value="1" ${p?.inventario ? 'selected' : ''}>Sí, descontar al facturar</option></select>
      </div>
      <div id="pExDiv"><label>${p?.inventario ? 'Existencia actual' : 'Existencia inicial'}</label>
        <input type="number" step="0.01" name="existencia" value="${p?.existencia || 0}" ${p?.inventario ? 'disabled' : ''}>
        ${p?.inventario ? '<div style="font-size:.76rem;color:var(--suave);margin-top:.2rem">Se modifica desde Inventario</div>' : ''}</div>
      <div id="pMinDiv"><label>Existencia mínima (alerta)</label><input type="number" step="0.01" name="minimo" value="${p?.minimo || 0}"></div>
    </div>`,
    botones: [
      { texto: 'Cancelar', accion: () => {} },
      { texto: 'Guardar', clase: 'btn-primario', accion: async () => {
        const b = datosForm($('#modalCuerpo'));
        b.itbis = Number(b.itbis); b.activo = Number(b.activo); b.inventario = Number(b.inventario);
        await api(id ? '/api/productos/' + id : '/api/productos', { method: id ? 'PUT' : 'POST', body: b });
        toast('Artículo guardado', 'ok'); irA('productos');
      } },
    ],
    alAbrir: () => {
      const sync = () => {
        const on = $('#pInv').value === '1';
        $('#pExDiv').style.display = on ? '' : 'none';
        $('#pMinDiv').style.display = on ? '' : 'none';
      };
      $('#pInv').onchange = sync; sync();
    },
  });
};

window.borrarProducto = async function (id) {
  if (!(await confirmar('¿Eliminar este artículo del catálogo?'))) return;
  await api('/api/productos/' + id, { method: 'DELETE' });
  toast('Eliminado', 'ok'); irA('productos');
};

/* --------------------------------------------------------- INVENTARIO */
vistas.inventario = async function () {
  const f = S.cache.f_inv || { q: '', bajo: '' };
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v)));
  const inv = await api('/api/inventario?' + qs);

  $('#vista').innerHTML = `
    <div class="encabezado">
      <div><h1>Inventario</h1>
        <div class="sub">${inv.filas.length} artículos con control de existencias · Valor ${Object.entries(inv.valorPorMoneda || {}).map(([m, v]) => money(v, m)).join(' · ') || money(0)}${inv.bajos ? ` · <b style="color:var(--rojo)">${inv.bajos} bajo el mínimo</b>` : ''}</div></div>
      <div style="display:flex;gap:.5rem">
        <button id="btnEntrada" class="btn-primario">+ Entrada de mercancía</button>
        <button id="btnAjuste">Ajustar conteo</button>
      </div>
    </div>
    <div class="tarjeta">
      <div class="filtros">
        <div style="min-width:230px"><label>Buscar</label><input id="fq" value="${esc(f.q)}" placeholder="Nombre o código"></div>
        <div><label>Mostrar</label><select id="fbajo">
          <option value="">Todos</option><option value="1" ${f.bajo === '1' ? 'selected' : ''}>Solo bajo el mínimo</option></select></div>
        <button class="btn-primario" id="fAplicar">Filtrar</button>
        <button id="fLimpiar">Limpiar</button>
      </div>
      ${tabla({
        columnas: [
          { t: 'Código', v: (p) => esc(p.codigo || '—') },
          { t: 'Artículo', v: (p) => `<b>${esc(p.nombre)}</b>` },
          { t: 'Existencia', num: 1, v: (p) => {
            const c = p.existencia <= 0 ? 'var(--rojo)' : p.existencia <= p.minimo ? 'var(--ambar)' : 'var(--verde)';
            return `<b style="color:${c}">${n2(p.existencia)}</b> <span style="color:var(--suave)">${esc(p.unidad)}</span>`;
          } },
          { t: 'Mínimo', num: 1, v: (p) => n2(p.minimo) },
          { t: 'Costo', num: 1, v: (p) => money(p.costo, p.moneda) },
          { t: 'Valor', num: 1, v: (p) => money(p.valor, p.moneda) },
          { t: 'Precio venta', num: 1, v: (p) => money(p.precio, p.moneda) },
          { t: 'Estado', v: (p) => (p.existencia <= 0 ? '<span class="chip anulada">agotado</span>'
            : p.existencia <= p.minimo ? '<span class="chip parcial">reponer</span>' : '<span class="chip pagada">ok</span>') },
        ],
        filas: inv.filas,
        vacio: 'Ningún artículo lleva control de inventario todavía. Actívelo en la ficha del producto (Productos y servicios → Editar).',
        acciones: (p) => `<button class="btn-mini" onclick="verKardex(${p.id})">Movimientos</button>
          <button class="btn-mini" onclick="movimiento(${p.id})">Entrada/Salida</button>`,
      })}
    </div>`;

  $('#btnEntrada').onclick = () => movimiento(null, 'entrada');
  $('#btnAjuste').onclick = () => movimiento(null, 'ajuste');
  $('#fAplicar').onclick = () => { S.cache.f_inv = { q: $('#fq').value, bajo: $('#fbajo').value }; irA('inventario'); };
  $('#fLimpiar').onclick = () => { S.cache.f_inv = null; irA('inventario'); };
  $('#fq').onkeydown = (e) => { if (e.key === 'Enter') $('#fAplicar').click(); };
};

window.movimiento = async function (productoId, tipoInicial) {
  const [inv, proveedores] = await Promise.all([api('/api/inventario'), api('/api/contactos?tipo=proveedor&activo=1')]);
  if (!inv.filas.length) { toast('Primero active el inventario en algún producto', 'error'); return; }
  modal({
    titulo: 'Movimiento de inventario', ancho: '620px',
    cuerpo: `<div class="campos">
      <div class="campo-ancho"><label>Artículo</label><select name="producto_id" id="mProd">
        ${inv.filas.map((p) => `<option value="${p.id}" data-ex="${p.existencia}" data-costo="${p.costo}" ${p.id === productoId ? 'selected' : ''}>${esc(p.nombre)} · existencia ${n2(p.existencia)} ${esc(p.unidad)}</option>`).join('')}
      </select></div>
      <div><label>Tipo</label><select name="tipo" id="mTipo">
        <option value="entrada" ${tipoInicial === 'entrada' ? 'selected' : ''}>Entrada (compra, devolución)</option>
        <option value="salida" ${tipoInicial === 'salida' ? 'selected' : ''}>Salida (consumo, merma)</option>
        <option value="ajuste" ${tipoInicial === 'ajuste' ? 'selected' : ''}>Ajuste por conteo físico</option>
      </select></div>
      <div><label id="mLabelCant">Cantidad</label><input type="number" step="0.01" name="cantidad" id="mCant" value="1"></div>
      <div><label>Fecha</label><input type="date" name="fecha" value="${hoy()}"></div>
      <div><label>Costo unitario</label><input type="number" step="0.01" name="costo" id="mCosto" value="0"></div>
      <div><label>Proveedor</label><select name="contacto_id"><option value="">—</option>
        ${proveedores.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}</select></div>
      <div><label>Motivo</label><input name="motivo" placeholder="Compra, merma, conteo…"></div>
      <div class="campo-ancho"><label>Notas</label><input name="notas"></div>
      <div class="campo-ancho" id="mAviso" style="color:var(--suave);font-size:.85rem"></div>
    </div>`,
    botones: [
      { texto: 'Cancelar', accion: () => {} },
      { texto: 'Registrar', clase: 'btn-primario', accion: async () => {
        const b = datosForm($('#modalCuerpo'));
        const r = await api('/api/inventario/movimiento', { method: 'POST', body: b });
        toast(`Movimiento registrado. Existencia: ${n2(r.existencia)}`, r.aviso ? 'error' : 'ok');
        irA('inventario');
      } },
    ],
    alAbrir: () => {
      const refrescar = () => {
        const op = $('#mProd').selectedOptions[0];
        const ex = Number(op?.dataset.ex || 0);
        const tipo = $('#mTipo').value;
        $('#mLabelCant').textContent = tipo === 'ajuste' ? 'Existencia real contada' : 'Cantidad';
        if (tipo === 'ajuste') $('#mCant').value = n2(ex);
        $('#mCosto').value = n2(op?.dataset.costo || 0);
        $('#mAviso').textContent = `Existencia actual: ${n2(ex)}`;
      };
      $('#mProd').onchange = refrescar;
      $('#mTipo').onchange = refrescar;
      refrescar();
    },
  });
};

window.verKardex = async function (id) {
  const k = await api(`/api/inventario/${id}/movimientos`);
  modal({
    titulo: `Movimientos · ${k.producto.nombre}`, ancho: 'min(860px,96vw)',
    cuerpo: `<p style="margin:0 0 .8rem;color:var(--suave)">Existencia actual:
      <b style="color:var(--texto)">${n2(k.producto.existencia)} ${esc(k.producto.unidad)}</b> ·
      Mínimo ${n2(k.producto.minimo)} · Valor ${money(k.producto.existencia * k.producto.costo, k.producto.moneda)}</p>
      ${tabla({
        columnas: [
          { t: 'Fecha', v: (m) => fecha(m.fecha) },
          { t: 'Tipo', v: (m) => `<span class="chip ${m.tipo === 'entrada' ? 'pagada' : m.tipo === 'salida' ? 'anulada' : 'borrador'}">${esc(m.tipo)}</span>` },
          { t: 'Cantidad', num: 1, v: (m) => `${m.tipo === 'salida' ? '−' : m.tipo === 'entrada' ? '+' : ''}${n2(Math.abs(m.cantidad))}` },
          { t: 'Existencia', num: 1, v: (m) => `<b>${n2(m.existencia)}</b>` },
          { t: 'Motivo', v: (m) => esc(m.motivo || '—') },
          { t: 'Documento', v: (m) => (m.factura ? esc(m.factura) : '—') },
          { t: 'Contacto', v: (m) => esc(m.contacto || '—') },
        ], filas: k.movimientos, vacio: 'Sin movimientos registrados',
      })}`,
    botones: [
      { texto: 'Cerrar', accion: () => {} },
      { texto: 'Nuevo movimiento', clase: 'btn-primario', accion: () => { cerrarModal(); setTimeout(() => movimiento(id), 150); return false; } },
    ],
  });
};

/* --------------------------------------------------------- REPORTES */
vistas.reportes = async function () {
  const desde = S.cache.rDesde || primerDiaAnio(), hasta = S.cache.rHasta || hoy();
  const [estado, itbis, cxc] = await Promise.all([
    api(`/api/reportes/estado?desde=${desde}&hasta=${hasta}`),
    api(`/api/reportes/itbis?desde=${desde}&hasta=${hasta}`),
    api('/api/reportes/cuentas-por-cobrar'),
  ]);

  const bloqueEstado = (b) => `
    <div style="margin-bottom:1.2rem">
      <h4 style="margin:.2rem 0 .5rem;display:flex;align-items:center;gap:.4rem">
        <span class="chip pagada">${esc(b.simbolo)}</span>
        <span style="color:var(--suave);font-size:.85rem">${esc(b.moneda)}</span></h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.4rem">
        <div><h4 style="color:var(--verde);margin:.3rem 0">Ingresos</h4>
          ${tabla({ columnas: [{ t: 'Categoría', v: (x) => esc(x.categoria) }, { t: 'Monto', num: 1, v: (x) => money(x.total, b.moneda) }], filas: b.ingresos, vacio: 'Sin ingresos' })}
          <div class="totales" style="width:100%"><div class="grande"><span>Total</span><b style="color:var(--verde)">${money(b.totalIngresos, b.moneda)}</b></div></div></div>
        <div><h4 style="color:var(--rojo);margin:.3rem 0">Gastos</h4>
          ${tabla({ columnas: [{ t: 'Categoría', v: (x) => esc(x.categoria) }, { t: 'Monto', num: 1, v: (x) => money(x.total, b.moneda) }], filas: b.gastos, vacio: 'Sin gastos' })}
          <div class="totales" style="width:100%"><div class="grande"><span>Total</span><b style="color:var(--rojo)">${money(b.totalGastos, b.moneda)}</b></div></div></div>
      </div>
      <div class="totales" style="margin-top:.7rem"><div class="grande"><span>UTILIDAD EN ${esc(b.simbolo)}</span>
        <b style="color:${b.utilidad >= 0 ? 'var(--verde)' : 'var(--rojo)'}">${money(b.utilidad, b.moneda)}</b></div></div>
    </div>`;

  $('#vista').innerHTML = `
    <div class="encabezado">
      <div><h1>Reportes</h1><div class="sub">Período ${fecha(desde)} — ${fecha(hasta)} · cada moneda por separado</div></div>
      <div class="filtros" style="margin:0">
        <div><label>Desde</label><input type="date" id="rDesde" value="${desde}"></div>
        <div><label>Hasta</label><input type="date" id="rHasta" value="${hasta}"></div>
        <button class="btn-primario" id="rAplicar">Aplicar</button>
        <button id="rImprimir">🖨 Imprimir</button>
      </div>
    </div>

    <div class="dos">
      <div class="tarjeta">
        <h3>Estado de resultados</h3>
        ${estado.bloques.map(bloqueEstado).join('')}
      </div>

      <div class="tarjeta">
        <h3>ITBIS por mes</h3>
        ${tabla({
          columnas: [
            { t: 'Moneda', v: (m) => esc(m.simbolo) },
            { t: 'Mes', v: (m) => `<span class="nw">${mesNombre(m.mes)}</span>` },
            { t: 'ITBIS ventas', num: 1, v: (m) => money(m.itbisVentas, m.moneda) },
            { t: 'ITBIS compras', num: 1, v: (m) => money(m.itbisCompras, m.moneda) },
            { t: 'A pagar', num: 1, v: (m) => `<b>${money(m.aPagar, m.moneda)}</b>` },
          ], filas: itbis, vacio: 'Sin movimientos en el período',
        })}
        <p style="font-size:.78rem;color:var(--suave);margin-top:.6rem">Referencial para el formulario IT-1. Confirme siempre con su contador.</p>
      </div>
    </div>

    <div class="tarjeta">
      <h3>Cuentas por cobrar (antigüedad de saldos)</h3>
      ${tabla({
        columnas: [
          { t: 'Factura', v: (f) => `<a onclick="verDocumento(${f.id})" style="cursor:pointer">${esc(f.numero)}</a>` },
          { t: 'Cliente', v: (f) => esc(f.cliente || '—') },
          { t: 'Emitida', v: (f) => fecha(f.fecha) },
          { t: 'Vence', v: (f) => fecha(f.vencimiento) },
          { t: 'Días', num: 1, v: (f) => (f.vencida ? `<span style="color:var(--rojo)">${f.dias}</span>` : '—') },
          { t: 'Moneda', v: (f) => esc(simbolo(f.moneda)) },
          { t: 'Total', num: 1, v: (f) => money(f.total, f.moneda) },
          { t: 'Pagado', num: 1, v: (f) => money(f.pagado, f.moneda) },
          { t: 'Balance', num: 1, v: (f) => `<b style="color:var(--rojo)">${money(f.balance, f.moneda)}</b>` },
        ], filas: cxc, vacio: 'No hay facturas pendientes',
      })}
      <div class="totales" style="margin-top:.5rem"><div class="grande"><span>Total por cobrar</span>
        <b>${totalPorMoneda(cxc, 'balance')}</b></div></div>
    </div>`;

  $('#rAplicar').onclick = () => { S.cache.rDesde = $('#rDesde').value; S.cache.rHasta = $('#rHasta').value; irA('reportes'); };
  $('#rImprimir').onclick = () => {
    $('#impresion').innerHTML = `<div class="doc"><h2>${esc(S.empresa.nombre)} — Reportes</h2>
      <p>Período ${fecha(desde)} al ${fecha(hasta)}</p>${$('#vista').innerHTML.replace(/<button[\s\S]*?<\/button>/g, '')}</div>`;
    window.print();
  };
};

/* --------------------------------------------------------- CONFIGURACIÓN */
vistas.config = async function () {
  const [e, ncf, usuarios, cor, envios] = await Promise.all([
    api('/api/empresa'), api('/api/ncf'), api('/api/usuarios'), api('/api/correo'), api('/api/envios'),
  ]);
  $('#vista').innerHTML = `
    <div class="encabezado"><div><h1>Configuración</h1><div class="sub">Datos de la empresa, comprobantes fiscales y usuarios</div></div></div>

    <div class="tarjeta">
      <h3>Datos de la empresa</h3>
      <div class="campos" id="fEmpresa">
        <div style="grid-column:span 2"><label>Nombre / razón social</label><input name="nombre" value="${esc(e.nombre)}"></div>
        <div><label>RNC</label><input name="rnc" value="${esc(e.rnc)}"></div>
        <div><label>Teléfono</label><input name="telefono" value="${esc(e.telefono)}"></div>
        <div><label>Email</label><input name="email" value="${esc(e.email)}"></div>
        <div><label>Sitio web</label><input name="web" value="${esc(e.web)}"></div>
        <div class="campo-ancho"><label>Dirección</label><input name="direccion" value="${esc(e.direccion)}"></div>
        <div><label>Moneda predeterminada</label>${selectorMoneda('moneda', e.moneda)}
          <div style="font-size:.76rem;color:var(--suave);margin-top:.2rem">La que viene marcada al crear documentos. Puede cambiarla en cada factura.</div></div>
        <div><label>Símbolo</label><input name="simbolo" value="${esc(e.simbolo)}" readonly style="background:#f6f8fb"></div>
        <div><label>Tasa ITBIS (%)</label><input type="number" step="0.01" name="itbis_tasa" value="${e.itbis_tasa}"></div>
        <div><label>Validez presupuestos (días)</label><input type="number" name="validez_presupuesto" value="${e.validez_presupuesto}"></div>
        <div class="campo-ancho"><label>Condiciones por defecto</label><textarea name="condiciones">${esc(e.condiciones)}</textarea></div>
        <input type="hidden" name="logo" id="logoData" value="${esc(e.logo)}">
        <div class="campo-ancho"><label>Logo (PNG o JPG, se muestra en facturas y recibos)</label>
          <div style="display:flex;gap:.8rem;align-items:center">
            <input type="file" accept="image/*" id="logoFile" style="max-width:280px">
            <img id="logoPrev" src="${esc(e.logo)}" style="max-height:56px;${e.logo ? '' : 'display:none'}">
            ${e.logo ? '<button type="button" class="btn-mini btn-peligro" id="quitarLogo">Quitar logo</button>' : ''}
          </div></div>
      </div>
      <div style="margin-top:.9rem"><button class="btn-primario" id="guardarEmpresa">Guardar cambios</button></div>
    </div>

    <div class="tarjeta">
      <h3>Secuencias de comprobantes fiscales (NCF)</h3>
      <p style="color:var(--suave);font-size:.83rem;margin-top:-.2rem">Registre aquí los rangos autorizados por la DGII. El sistema asigna el próximo número automáticamente al emitir una factura.</p>
      ${tabla({
        columnas: [
          { t: 'Tipo', v: (s) => `<b>${esc(s.tipo)}</b>` },
          { t: 'Descripción', v: (s) => esc(s.descripcion) },
          { t: 'Prefijo', v: (s) => esc(s.prefijo) },
          { t: 'Desde', num: 1, v: (s) => s.desde },
          { t: 'Hasta', num: 1, v: (s) => s.hasta },
          { t: 'Último usado', num: 1, v: (s) => s.actual || '—' },
          { t: 'Disponibles', num: 1, v: (s) => `<b style="color:${s.disponibles < 20 ? 'var(--rojo)' : 'var(--verde)'}">${s.disponibles}</b>` },
          { t: 'Estado', v: (s) => (s.activo ? '<span class="chip pagada">activa</span>' : '<span class="chip borrador">inactiva</span>') },
        ], filas: ncf,
        acciones: (s) => `<button class="btn-mini" onclick="editarNCF(${s.id})">Editar</button>`,
      })}
    </div>

    <div class="tarjeta">
      <h3>Usuarios</h3>
      ${tabla({
        columnas: [
          { t: 'Usuario', v: (u) => `<b>${esc(u.usuario)}</b>` },
          { t: 'Nombre', v: (u) => esc(u.nombre || '—') },
          { t: 'Rol', v: (u) => esc(u.rol) },
          { t: 'Creado', v: (u) => esc((u.creado || '').slice(0, 10)) },
        ], filas: usuarios,
        acciones: (u) => (u.usuario === S.usuario.usuario ? '<span style="color:var(--suave);font-size:.8rem">sesión actual</span>'
          : `<button class="btn-mini btn-peligro" onclick="borrarUsuario(${u.id})">✕</button>`),
      })}
      <div style="margin-top:.8rem;display:flex;gap:.5rem">
        <button id="btnUsuario">+ Nuevo usuario</button>
        <button id="btnPass">Cambiar mi contraseña</button>
      </div>
    </div>

    <div class="tarjeta">
      <h3>Correo para enviar facturas</h3>
      <p style="color:var(--suave);font-size:.83rem;margin-top:-.2rem">
        Con <b>Gmail o Google Workspace</b> debe usar una <b>contraseña de aplicación</b>, no la de su cuenta:
        active la verificación en dos pasos en su cuenta de Google y luego genere la contraseña de aplicación
        en <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a>.
        Son 16 letras; péguelas abajo.
      </p>
      <div class="campos" id="fCorreo">
        <div><label>Activar envío por correo</label><select name="activo">
          <option value="1" ${cor.activo ? 'selected' : ''}>Sí</option><option value="0" ${cor.activo ? '' : 'selected'}>No</option></select></div>
        <div><label>Servidor SMTP</label><input name="servidor" value="${esc(cor.servidor)}" placeholder="smtp.gmail.com"></div>
        <div><label>Puerto</label><input type="number" name="puerto" value="${cor.puerto}"></div>
        <div><label>Seguridad</label><select name="seguridad">
          <option value="starttls" ${cor.seguridad === 'starttls' ? 'selected' : ''}>STARTTLS (587)</option>
          <option value="ssl" ${cor.seguridad === 'ssl' ? 'selected' : ''}>SSL directo (465)</option></select></div>
        <div><label>Usuario</label><input name="usuario" value="${esc(cor.usuario)}" placeholder="micorreo@gmail.com"></div>
        <div><label>Contraseña de aplicación</label><input type="password" name="clave" placeholder="${cor.tiene_clave ? '•••••••• (guardada)' : '16 letras de Google'}">
          ${cor.tiene_clave ? '<div style="font-size:.76rem;color:var(--verde);margin-top:.2rem">Ya hay una contraseña guardada. Déjelo vacío para conservarla.</div>' : ''}</div>
        <div><label>Correo remitente</label><input name="remitente" value="${esc(cor.remitente)}" placeholder="Igual al usuario"></div>
        <div><label>Nombre del remitente</label><input name="nombre_remitente" value="${esc(cor.nombre_remitente)}" placeholder="${esc(e.nombre)}"></div>
        <div><label>Copia oculta a (opcional)</label><input name="copia" value="${esc(cor.copia)}"></div>
        <div class="campo-ancho"><label>Asunto por defecto</label><input name="asunto_factura" value="${esc(cor.asunto_factura)}"></div>
        <div class="campo-ancho"><label>Mensaje por defecto</label>
          <textarea name="mensaje_factura" style="min-height:110px">${esc(String(cor.mensaje_factura).replace(/\\n/g, '\n'))}</textarea>
          <div style="font-size:.78rem;color:var(--suave);margin-top:.25rem">
            Puede usar: <code>{cliente}</code> <code>{numero}</code> <code>{total}</code> <code>{fecha}</code> <code>{empresa}</code> <code>{enlace}</code></div></div>
        <div class="campo-ancho"><label>Dirección pública del sistema (para los enlaces que ve el cliente)</label>
          <input name="url_publica" id="urlPublica" value="${esc(e.url_publica || '')}" placeholder="${esc(location.origin)}">
          <div style="font-size:.78rem;color:var(--suave);margin-top:.25rem">Déjelo vacío para usar la dirección desde la que entra usted.</div></div>
      </div>
      <div style="margin-top:.9rem;display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="btn-primario" id="guardarCorreo">Guardar configuración de correo</button>
        <button id="probarCorreo">Enviar correo de prueba</button>
      </div>
      ${envios.length ? `<h4 style="margin:1.2rem 0 .4rem">Últimos envíos</h4>${tabla({
        columnas: [
          { t: 'Fecha', v: (x) => esc((x.fecha || '').slice(0, 16)) },
          { t: 'Canal', v: (x) => esc(x.canal) },
          { t: 'Documento', v: (x) => esc(x.factura || x.recibo || '—') },
          { t: 'Destino', v: (x) => esc(x.destino || '—') },
          { t: 'Estado', v: (x) => (x.estado === 'error'
            ? `<span class="chip anulada" title="${esc(x.detalle)}">error</span>` : `<span class="chip pagada">${esc(x.estado)}</span>`) },
        ], filas: envios.slice(0, 12),
      })}` : ''}
    </div>

    <div class="tarjeta">
      <h3>Copia de seguridad</h3>
      <p style="color:var(--suave);font-size:.86rem">Toda la información se guarda en el archivo <code>datos/facturacion.db</code> dentro de la carpeta del programa. Para respaldar, cierre el servidor y copie la carpeta <b>datos</b> completa.</p>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        ${['facturas', 'presupuestos', 'ingresos', 'gastos', 'clientes', 'proveedores']
          .map((t) => `<a class="btn" href="${url('/api/export/' + t)}">⬇ ${t}.csv</a>`).join('')}
      </div>
    </div>`;

  $('#logoFile').onchange = (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    if (f.size > 900 * 1024) { toast('El logo debe pesar menos de 900 KB', 'error'); return; }
    const fr = new FileReader();
    fr.onload = () => { $('#logoData').value = fr.result; $('#logoPrev').src = fr.result; $('#logoPrev').style.display = ''; };
    fr.readAsDataURL(f);
  };
  if ($('#quitarLogo')) $('#quitarLogo').onclick = () => { $('#logoData').value = ''; $('#logoPrev').style.display = 'none'; };
  $('#guardarEmpresa').onclick = async () => {
    const b = datosForm($('#fEmpresa'));
    b.url_publica = $('#urlPublica') ? $('#urlPublica').value : (e.url_publica || '');
    S.empresa = await api('/api/empresa', { method: 'PUT', body: b });
    pintarMarca(); toast('Configuración guardada', 'ok');
  };
  $('#guardarCorreo').onclick = async () => {
    const b = datosForm($('#fCorreo'));
    b.activo = Number(b.activo);
    const urlPub = b.url_publica; delete b.url_publica;
    await api('/api/correo', { method: 'PUT', body: b });
    S.empresa = await api('/api/empresa', { method: 'PUT', body: { ...e, url_publica: urlPub } });
    toast('Configuración de correo guardada', 'ok');
    irA('config');
  };
  $('#probarCorreo').onclick = async () => {
    const btn = $('#probarCorreo');
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const r = await api('/api/correo/probar', { method: 'POST', body: {} });
      toast('Correo de prueba enviado a ' + r.destino + '. Revise su bandeja.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Enviar correo de prueba'; }
  };
  $('#btnUsuario').onclick = () => modal({
    titulo: 'Nuevo usuario', ancho: '480px',
    cuerpo: `<div class="campos">
      <div><label>Usuario *</label><input name="usuario"></div>
      <div><label>Nombre</label><input name="nombre"></div>
      <div><label>Contraseña *</label><input type="password" name="password"></div>
      <div><label>Rol</label><select name="rol"><option>operador</option><option>admin</option></select></div>
    </div>`,
    botones: [{ texto: 'Cancelar', accion: () => {} },
      { texto: 'Crear', clase: 'btn-primario', accion: async () => {
        await api('/api/usuarios', { method: 'POST', body: datosForm($('#modalCuerpo')) });
        toast('Usuario creado', 'ok'); irA('config');
      } }],
  });
  $('#btnPass').onclick = () => modal({
    titulo: 'Cambiar contraseña', ancho: '440px',
    cuerpo: `<div class="campos">
      <div class="campo-ancho"><label>Contraseña actual</label><input type="password" name="actual"></div>
      <div class="campo-ancho"><label>Nueva contraseña</label><input type="password" name="nueva"></div>
    </div>`,
    botones: [{ texto: 'Cancelar', accion: () => {} },
      { texto: 'Cambiar', clase: 'btn-primario', accion: async () => {
        await api('/api/auth/password', { method: 'POST', body: datosForm($('#modalCuerpo')) });
        toast('Contraseña actualizada', 'ok');
      } }],
  });
};

window.editarNCF = async function (id) {
  const s = (await api('/api/ncf')).find((x) => x.id === id);
  modal({
    titulo: 'Secuencia NCF ' + s.tipo, ancho: '560px',
    cuerpo: `<div class="campos">
      <div class="campo-ancho"><label>Descripción</label><input name="descripcion" value="${esc(s.descripcion)}"></div>
      <div><label>Prefijo</label><input name="prefijo" value="${esc(s.prefijo)}"></div>
      <div><label>Desde</label><input type="number" name="desde" value="${s.desde}"></div>
      <div><label>Hasta</label><input type="number" name="hasta" value="${s.hasta}"></div>
      <div><label>Último usado</label><input type="number" name="actual" value="${s.actual}"></div>
      <div><label>Vence</label><input type="date" name="vence" value="${esc(s.vence)}"></div>
      <div><label>Activa</label><select name="activo"><option value="1" ${s.activo ? 'selected' : ''}>Sí</option><option value="0" ${!s.activo ? 'selected' : ''}>No</option></select></div>
    </div>`,
    botones: [{ texto: 'Cancelar', accion: () => {} },
      { texto: 'Guardar', clase: 'btn-primario', accion: async () => {
        const b = datosForm($('#modalCuerpo'));
        b.activo = Number(b.activo);
        await api('/api/ncf/' + id, { method: 'PUT', body: b });
        toast('Secuencia actualizada', 'ok'); irA('config');
      } }],
  });
};

window.borrarUsuario = async function (id) {
  if (!(await confirmar('¿Eliminar este usuario?'))) return;
  await api('/api/usuarios/' + id, { method: 'DELETE' });
  toast('Usuario eliminado', 'ok'); irA('config');
};

/* --------------------------------------------------------- IMPRESIÓN */
function cabeceraDoc(titulo, derecha) {
  const e = S.empresa;
  return `<div class="cabecera">
    <div>${e.logo ? `<img src="${e.logo}" alt="">` : ''}
      <div style="font-size:15px;font-weight:700;margin-top:6px">${esc(e.nombre)}</div>
      ${e.rnc ? `<div>RNC: ${esc(e.rnc)}</div>` : ''}
      ${e.direccion ? `<div>${esc(e.direccion)}</div>` : ''}
      ${e.telefono ? `<div>Tel.: ${esc(e.telefono)}</div>` : ''}
      ${e.email ? `<div>${esc(e.email)}</div>` : ''}
      ${e.web ? `<div>${esc(e.web)}</div>` : ''}
    </div>
    <div class="titulo"><h2>${esc(titulo)}</h2>${derecha}</div>
  </div>`;
}

function imprimirDocumento(d) {
  const esFactura = d.tipo === 'factura';
  const e = S.empresa;
  $('#impresion').innerHTML = `<div class="doc">
    ${cabeceraDoc(esFactura ? 'FACTURA' : 'PRESUPUESTO', `
      <div style="margin-top:6px"><b>No.</b> ${esc(d.numero)}</div>
      ${d.ncf ? `<div><b>NCF:</b> ${esc(d.ncf)}</div>` : ''}
      <div><b>Fecha:</b> ${fecha(d.fecha)}</div>
      <div><b>${esFactura ? 'Vence' : 'Válido hasta'}:</b> ${fecha(d.vencimiento)}</div>`)}
    <div class="bloques">
      <div class="bloque"><b>Cliente</b>
        <div style="font-weight:600">${esc(d.cliente?.nombre || d.cliente_nombre || '—')}</div>
        ${(d.cliente?.rnc || d.cliente_rnc) ? `<div>RNC/Cédula: ${esc(d.cliente?.rnc || d.cliente_rnc)}</div>` : ''}
        ${d.cliente?.direccion ? `<div>${esc(d.cliente.direccion)}</div>` : ''}
        ${d.cliente?.telefono ? `<div>Tel.: ${esc(d.cliente.telefono)}</div>` : ''}
      </div>
      <div class="bloque"><b>Resumen</b>
        <div>Estado: ${esc(d.estado)}</div>
        <div>Moneda: ${esc(d.moneda)} (${esc(simbolo(d.moneda))})</div>
        ${esFactura ? `<div>Pagado: ${money(d.pagado, d.moneda)}</div><div><b>Balance: ${money(d.balance, d.moneda)}</b></div>` : ''}
      </div>
    </div>
    <table><thead><tr><th style="width:48%">Descripción</th><th style="text-align:right">Cant.</th>
      <th style="text-align:right">Precio</th><th style="text-align:right">Desc.</th><th style="text-align:right">Importe</th></tr></thead>
      <tbody>${d.items.map((i) => `<tr><td>${esc(i.descripcion)}</td>
        <td style="text-align:right">${i.cantidad}</td><td style="text-align:right">${money(i.precio, d.moneda)}</td>
        <td style="text-align:right">${i.descuento ? i.descuento + '%' : '—'}</td>
        <td style="text-align:right">${money(i.importe, d.moneda)}</td></tr>`).join('')}</tbody></table>
    <div style="display:flex;justify-content:flex-end">
      <table style="width:280px">
        <tr><td>Subtotal</td><td style="text-align:right">${money(d.subtotal, d.moneda)}</td></tr>
        ${d.descuento ? `<tr><td>Descuento</td><td style="text-align:right">− ${money(d.descuento, d.moneda)}</td></tr>` : ''}
        <tr><td>ITBIS (${e.itbis_tasa}%)</td><td style="text-align:right">${money(d.itbis, d.moneda)}</td></tr>
        <tr><td style="font-size:14px;font-weight:700;border-top:2px solid #12203f">TOTAL</td>
            <td style="text-align:right;font-size:14px;font-weight:700;border-top:2px solid #12203f">${money(d.total, d.moneda)}</td></tr>
      </table></div>
    ${d.notas ? `<div style="margin-top:10px"><b>Notas:</b> ${esc(d.notas)}</div>` : ''}
    <div class="pie-doc">${esc(d.condiciones || e.condiciones)}</div>
    <div class="sello"><div>Elaborado por</div><div>Recibido conforme</div></div>
  </div>`;
  window.print();
}

window.imprimirRecibo = async function (id) {
  const r = await api('/api/ingresos/' + id);
  const e = S.empresa;
  $('#impresion').innerHTML = `<div class="doc">
    ${cabeceraDoc('RECIBO DE INGRESO', `
      <div style="margin-top:6px"><b>No.</b> ${esc(r.recibo)}</div>
      <div><b>Fecha:</b> ${fecha(r.fecha)}</div>
      <div style="margin-top:8px;font-size:17px;font-weight:700">${money(r.monto, r.moneda)}</div>`)}
    <div class="bloques">
      <div class="bloque"><b>Recibido de</b>
        <div style="font-weight:600">${esc(r.cliente || '—')}</div>
        ${r.cliente_rnc ? `<div>RNC/Cédula: ${esc(r.cliente_rnc)}</div>` : ''}
        ${r.cliente_direccion ? `<div>${esc(r.cliente_direccion)}</div>` : ''}
      </div>
      <div class="bloque"><b>Detalle del pago</b>
        <div>Método: ${esc(r.metodo)}</div>
        ${r.referencia ? `<div>Referencia: ${esc(r.referencia)}</div>` : ''}
        ${r.factura ? `<div>Aplicado a factura: ${esc(r.factura)}</div>` : ''}
        <div>Categoría: ${esc(r.categoria)}</div>
        <div>Moneda: ${esc(r.moneda)} (${esc(simbolo(r.moneda))})</div>
      </div>
    </div>
    <table><thead><tr><th>Concepto</th><th style="text-align:right;width:150px">Monto</th></tr></thead>
      <tbody><tr><td>${esc(r.concepto)}</td><td style="text-align:right">${money(r.monto, r.moneda)}</td></tr></tbody></table>
    <div style="display:flex;justify-content:flex-end">
      <table style="width:280px"><tr>
        <td style="font-size:14px;font-weight:700;border-top:2px solid #12203f">TOTAL RECIBIDO</td>
        <td style="text-align:right;font-size:14px;font-weight:700;border-top:2px solid #12203f">${money(r.monto, r.moneda)}</td></tr></table></div>
    ${r.notas ? `<div style="margin-top:10px"><b>Notas:</b> ${esc(r.notas)}</div>` : ''}
    <div class="pie-doc">Este recibo confirma el pago descrito. Conserve este documento como comprobante.</div>
    <div class="sello"><div>Recibido por (${esc(e.nombre)})</div><div>Entregado por</div></div>
  </div>`;
  window.print();
};

/* ------------------------------------------------------------------ inicio */
(async () => {
  try { S.usuario = await api('/api/auth/me'); await iniciar(); }
  catch { mostrarLogin(); }
})();
