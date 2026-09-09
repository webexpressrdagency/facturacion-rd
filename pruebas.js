'use strict';
/* Pruebas automáticas de la API. Uso:  node server.js   y en otra consola:  node pruebas.js */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
let cookie = '';
let ok = 0, fallos = 0;

async function req(metodo, ruta, body) {
  const res = await fetch(BASE + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function check(nombre, cond, extra = '') {
  if (cond) { ok++; console.log('  ✓', nombre); }
  else { fallos++; console.log('  ✗', nombre, extra); }
}

(async () => {
  console.log('\n== Autenticación ==');
  check('rechaza sin sesión', (await req('GET', '/api/empresa')).status === 401);
  check('rechaza contraseña mala', (await req('POST', '/api/auth/login', { usuario: 'admin', password: 'xx' })).status === 401);
  const login = await req('POST', '/api/auth/login', { usuario: 'admin', password: 'admin123' });
  check('login correcto', login.status === 200 && login.data.usuario === 'admin');
  check('sesión activa', (await req('GET', '/api/auth/me')).status === 200);

  console.log('\n== Configuración ==');
  const emp = await req('PUT', '/api/empresa', {
    nombre: 'Constructora Prueba SRL', rnc: '131234567', direccion: 'Av. Principal 10, Santo Domingo',
    telefono: '809-555-0000', email: 'info@prueba.do', moneda: 'DOP', simbolo: 'RD$', itbis_tasa: 18,
    condiciones: 'Pago a 30 días.', validez_presupuesto: 15,
  });
  check('guarda empresa', emp.data.nombre === 'Constructora Prueba SRL' && emp.data.itbis_tasa === 18);

  console.log('\n== Maestros ==');
  const cli = (await req('POST', '/api/contactos', { tipo: 'cliente', nombre: 'Cliente Uno SRL', rnc: '101000001', telefono: '809-111-1111' })).data;
  const prov = (await req('POST', '/api/contactos', { tipo: 'proveedor', nombre: 'Ferretería Nacional', rnc: '102000002' })).data;
  check('crea cliente', cli.id > 0);
  check('crea proveedor', prov.id > 0);
  check('rechaza contacto sin nombre', (await req('POST', '/api/contactos', { nombre: '' })).status === 400);
  const prod = (await req('POST', '/api/productos', { codigo: 'SV-01', nombre: 'Metro de pared', precio: 1500, costo: 900, itbis: 1 })).data;
  check('crea producto', prod.precio === 1500);
  check('filtra clientes', (await req('GET', '/api/contactos?tipo=cliente')).data.every((c) => c.tipo === 'cliente'));

  console.log('\n== Facturación e ITBIS ==');
  const f1 = (await req('POST', '/api/documentos', {
    tipo: 'factura', contacto_id: cli.id, fecha: '2026-09-01', ncf_tipo: 'B01', estado: 'emitida',
    items: [
      { descripcion: 'Metro de pared', cantidad: 10, precio: 1500, descuento: 0, itbis: 1 },
      { descripcion: 'Servicio exento', cantidad: 1, precio: 1000, descuento: 0, itbis: 0 },
    ],
  })).data;
  check('subtotal correcto', f1.subtotal === 16000, `= ${f1.subtotal}`);
  check('ITBIS solo sobre líneas gravadas (18% de 15000 = 2700)', f1.itbis === 2700, `= ${f1.itbis}`);
  check('total correcto', f1.total === 18700, `= ${f1.total}`);
  check('asigna NCF B01', /^B01\d{8}$/.test(f1.ncf), f1.ncf);
  check('numera la factura', /^FAC-\d{4}-\d{5}$/.test(f1.numero), f1.numero);
  check('vencimiento a 30 días', f1.vencimiento === '2026-10-01', f1.vencimiento);

  const f2 = (await req('POST', '/api/documentos', {
    tipo: 'factura', contacto_id: cli.id, ncf_tipo: 'B02', estado: 'emitida', descuento: 1000,
    items: [{ descripcion: 'Trabajo', cantidad: 1, precio: 10000, descuento: 10, itbis: 1 }],
  })).data;
  check('descuento de línea (10% de 10000)', f2.subtotal === 9000, `= ${f2.subtotal}`);
  check('ITBIS con descuento global (18% de 8000 = 1440)', f2.itbis === 1440, `= ${f2.itbis}`);
  check('total con descuento global', f2.total === 9440, `= ${f2.total}`);
  check('NCF distinto por serie', f2.ncf.startsWith('B02'), f2.ncf);
  check('NCF consecutivos únicos', f1.ncf !== f2.ncf);
  check('rechaza documento sin líneas', (await req('POST', '/api/documentos', { tipo: 'factura', contacto_id: cli.id, items: [] })).status === 400);

  console.log('\n== Cobros y recibos ==');
  const pago1 = (await req('POST', '/api/ingresos', { documento_id: f1.id, monto: 8700, metodo: 'Transferencia' })).data;
  check('emite recibo numerado', /^REC-\d{4}-\d{5}$/.test(pago1.recibo), pago1.recibo);
  let f1b = (await req('GET', '/api/documentos/' + f1.id)).data;
  check('balance tras pago parcial', f1b.balance === 10000, `= ${f1b.balance}`);
  check('estado pasa a parcial', f1b.estado === 'parcial', f1b.estado);
  check('rechaza pago mayor al balance', (await req('POST', '/api/ingresos', { documento_id: f1.id, monto: 99999 })).status === 400);
  await req('POST', '/api/ingresos', { documento_id: f1.id, monto: 10000, metodo: 'Efectivo' });
  f1b = (await req('GET', '/api/documentos/' + f1.id)).data;
  check('estado pasa a pagada', f1b.estado === 'pagada', f1b.estado);
  check('balance en cero', Math.abs(f1b.balance) < 0.01, `= ${f1b.balance}`);
  check('la factura no se puede borrar con pagos', (await req('DELETE', '/api/documentos/' + f1.id)).status === 400);

  console.log('\n== Presupuestos ==');
  const p1 = (await req('POST', '/api/documentos', {
    tipo: 'presupuesto', contacto_id: cli.id, estado: 'enviado',
    items: [{ descripcion: 'Remodelación', cantidad: 1, precio: 50000, descuento: 0, itbis: 1 }],
  })).data;
  check('numera el presupuesto', /^PRE-\d{4}-\d{5}$/.test(p1.numero), p1.numero);
  check('presupuesto sin NCF', !p1.ncf);
  const conv = (await req('POST', `/api/documentos/${p1.id}/facturar`, { ncf_tipo: 'B01' })).data;
  check('convierte presupuesto en factura', conv.tipo === 'factura' && conv.total === p1.total, `${conv.total} vs ${p1.total}`);
  check('la factura conserva las líneas', conv.items.length === p1.items.length);
  const p1b = (await req('GET', '/api/documentos/' + p1.id)).data;
  check('presupuesto queda facturado', p1b.estado === 'facturado', p1b.estado);

  console.log('\n== Gastos ==');
  const g1 = (await req('POST', '/api/gastos', {
    concepto: 'Compra de cemento', categoria: 'Materiales', contacto_id: prov.id,
    subtotal: 20000, itbis: 3600, fecha: '2026-09-02', ncf: 'B0100000123', deducible: 1,
  })).data;
  check('calcula total del gasto', g1.monto === 23600, `= ${g1.monto}`);
  await req('POST', '/api/gastos', { concepto: 'Combustible', categoria: 'Combustible', subtotal: 5000, itbis: 900, fecha: '2026-09-02' });
  check('lista gastos filtrados', (await req('GET', '/api/gastos?categoria=Materiales')).data.length === 1);

  console.log('\n== Reportes ==');
  const r = (await req('GET', '/api/reportes/resumen?desde=2026-01-01&hasta=2026-12-31')).data;
  const rd = r.porMoneda.DOP;
  check('suma ingresos en RD$', rd.ingresos === 18700, `= ${rd.ingresos}`);
  check('suma gastos en RD$', rd.gastos === 29500, `= ${rd.gastos}`);
  check('calcula utilidad en RD$', rd.balance === -10800, `= ${rd.balance}`);
  check('ITBIS de compras deducible', rd.itbisCompras === 4500, `= ${rd.itbisCompras}`);
  check('serie de 12 meses', rd.serie.length === 12);
  const cxc = (await req('GET', '/api/reportes/cuentas-por-cobrar')).data;
  check('cuentas por cobrar excluye pagadas', !cxc.some((x) => x.id === f1.id));
  const est = (await req('GET', '/api/reportes/estado?desde=2026-01-01&hasta=2026-12-31')).data;
  check('estado de resultados cuadra', est.bloques.every((b) => b.utilidad === r2(b.totalIngresos - b.totalGastos)));
  const itb = (await req('GET', '/api/reportes/itbis?desde=2026-01-01&hasta=2026-12-31')).data;
  check('reporte ITBIS por mes', Array.isArray(itb) && itb.length > 0);

  console.log('\n== Inventario ==');
  const art = (await req('POST', '/api/productos', {
    codigo: 'CEM-01', nombre: 'Funda de cemento', unidad: 'funda', precio: 480, costo: 380,
    itbis: 1, inventario: 1, existencia: 100, minimo: 20,
  })).data;
  check('crea artículo con existencia inicial', art.inventario === 1 && art.existencia === 100, `= ${art.existencia}`);
  const servicio = (await req('POST', '/api/productos', { nombre: 'Mano de obra', precio: 2000, inventario: 0 })).data;
  check('un servicio no lleva existencias', servicio.inventario === 0);

  const fInv = (await req('POST', '/api/documentos', {
    tipo: 'factura', contacto_id: cli.id, estado: 'emitida', ncf_tipo: 'B02',
    items: [
      { descripcion: 'Funda de cemento', producto_id: art.id, cantidad: 30, precio: 480, itbis: 1 },
      { descripcion: 'Mano de obra', producto_id: servicio.id, cantidad: 1, precio: 2000, itbis: 1 },
    ],
  })).data;
  let artB = (await req('GET', '/api/inventario')).data.filas.find((x) => x.id === art.id);
  check('facturar descuenta la existencia', artB.existencia === 70, `= ${artB.existencia}`);
  check('no avisa si hay existencia suficiente', (fInv.avisosStock || []).length === 0);

  await req('POST', '/api/documentos/' + fInv.id + '/estado', { estado: 'anulada' });
  artB = (await req('GET', '/api/inventario')).data.filas.find((x) => x.id === art.id);
  check('anular la factura devuelve la existencia', artB.existencia === 100, `= ${artB.existencia}`);

  const fFalta = (await req('POST', '/api/documentos', {
    tipo: 'factura', contacto_id: cli.id, estado: 'emitida',
    items: [{ descripcion: 'Funda de cemento', producto_id: art.id, cantidad: 150, precio: 480, itbis: 1 }],
  })).data;
  check('permite vender sin existencia pero avisa', fFalta.avisosStock.length === 1, JSON.stringify(fFalta.avisosStock));
  artB = (await req('GET', '/api/inventario')).data.filas.find((x) => x.id === art.id);
  check('la existencia queda en negativo', artB.existencia === -50, `= ${artB.existencia}`);

  await req('POST', '/api/inventario/movimiento', { producto_id: art.id, tipo: 'entrada', cantidad: 200, costo: 400, motivo: 'Compra' });
  artB = (await req('GET', '/api/inventario')).data.filas.find((x) => x.id === art.id);
  check('la entrada suma a la existencia', artB.existencia === 150, `= ${artB.existencia}`);
  check('la entrada actualiza el costo', artB.costo === 400, `= ${artB.costo}`);

  await req('POST', '/api/inventario/movimiento', { producto_id: art.id, tipo: 'ajuste', cantidad: 148, motivo: 'Conteo físico' });
  artB = (await req('GET', '/api/inventario')).data.filas.find((x) => x.id === art.id);
  check('el ajuste fija la existencia contada', artB.existencia === 148, `= ${artB.existencia}`);

  const kardex = (await req('GET', `/api/inventario/${art.id}/movimientos`)).data;
  check('el kardex registra cada movimiento', kardex.movimientos.length >= 5, `= ${kardex.movimientos.length}`);
  check('el kardex enlaza la factura', kardex.movimientos.some((m) => m.factura));
  check('rechaza movimientos sobre un servicio',
    (await req('POST', '/api/inventario/movimiento', { producto_id: servicio.id, tipo: 'entrada', cantidad: 5 })).status === 400);

  await req('PUT', '/api/productos/' + art.id, { ...artB, nombre: 'Funda de cemento', inventario: 1, minimo: 200, activo: 1, itbis: 1 });
  const resInv = (await req('GET', '/api/reportes/resumen')).data;
  check('el panel alerta de artículos bajo el mínimo', resInv.bajoMinimo.some((x) => x.id === art.id));
  check('el panel calcula el valor del inventario', resInv.porMoneda.DOP.inventarioValor > 0, `= ${resInv.porMoneda.DOP.inventarioValor}`);

  console.log('\n== PDF, enlace público y WhatsApp ==');
  const pdf = await req('GET', `/api/documentos/${f1.id}/pdf`);
  check('genera el PDF de la factura', typeof pdf.data === 'string' && pdf.data.startsWith('%PDF-'));
  const pdfRec = await req('GET', '/api/ingresos/1/pdf');
  check('genera el PDF del recibo', typeof pdfRec.data === 'string' && pdfRec.data.startsWith('%PDF-'));

  const comp = (await req('GET', `/api/documentos/${f1.id}/compartir`)).data;
  check('crea el enlace público', /\/p\/[0-9a-f]{32}$/.test(comp.enlace), comp.enlace);
  check('arma el mensaje de WhatsApp', comp.whatsapp.startsWith('https://wa.me/') && comp.whatsapp.includes('text='));
  check('normaliza el teléfono dominicano', comp.numero === '18091111111', comp.numero);

  const guardada = cookie; cookie = '';
  const publica = await req('GET', `/p/${comp.token}`);
  check('el enlace público abre sin sesión', publica.status === 200 && String(publica.data).includes(f1.numero));
  const pdfPublico = await req('GET', `/p/${comp.token}/pdf`);
  check('el PDF público descarga sin sesión', String(pdfPublico.data).startsWith('%PDF-'));
  check('un token inventado no abre nada', (await req('GET', '/p/0000000000000000')).status === 404);
  cookie = guardada;

  await req('DELETE', `/api/documentos/${f1.id}/compartir`);
  cookie = '';
  check('el enlace revocado deja de funcionar', (await req('GET', `/p/${comp.token}`)).status === 404);
  cookie = guardada;

  console.log('\n== Correo ==');
  const cor = (await req('PUT', '/api/correo', {
    activo: 1, servidor: '127.0.0.1', puerto: 2525, seguridad: 'starttls',
    usuario: 'pruebas@ejemplo.do', clave: 'secreta', remitente: 'pruebas@ejemplo.do', nombre_remitente: 'Pruebas',
  })).data;
  check('guarda la configuración de correo', cor.servidor === '127.0.0.1' && cor.tiene_clave === 1);
  check('nunca devuelve la contraseña', cor.clave === '');
  const cor2 = (await req('PUT', '/api/correo', { ...cor, clave: '' })).data;
  check('conserva la contraseña si se deja vacía', cor2.tiene_clave === 1);
  const sinDestino = await req('POST', `/api/documentos/${f2.id}/correo`, { para: '' });
  check('exige destinatario', sinDestino.status === 400 && /destinatario/i.test(sinDestino.data.error), JSON.stringify(sinDestino.data));

  console.log('\n== Multimoneda ==');
  const monedas = (await req('GET', '/api/monedas')).data;
  check('ofrece RD$ y US$', monedas.length === 2 && monedas.some((m) => m.codigo === 'USD'), JSON.stringify(monedas));

  const prodUsd = (await req('POST', '/api/productos', {
    nombre: 'Bomba importada', precio: 850, costo: 620, itbis: 1, moneda: 'USD', inventario: 1, existencia: 10, minimo: 2,
  })).data;
  check('un artículo puede tener precio en US$', prodUsd.moneda === 'USD', prodUsd.moneda);
  check('el artículo en RD$ conserva su moneda', (await req('GET', '/api/productos')).data.find((x) => x.id === prod.id).moneda === 'DOP');

  const fUsd = (await req('POST', '/api/documentos', {
    tipo: 'factura', contacto_id: cli.id, estado: 'emitida', moneda: 'USD', fecha: '2026-09-03',
    items: [{ descripcion: 'Bomba importada', producto_id: prodUsd.id, cantidad: 2, precio: 850, itbis: 1 }],
  })).data;
  check('emite factura en US$', fUsd.moneda === 'USD', fUsd.moneda);
  check('el ITBIS se calcula igual en US$ (18% de 1700 = 306)', fUsd.itbis === 306, `= ${fUsd.itbis}`);
  check('total en US$', fUsd.total === 2006, `= ${fUsd.total}`);

  const pagoMalo = await req('POST', '/api/ingresos', { documento_id: fUsd.id, monto: 100, moneda: 'DOP' });
  check('rechaza cobrar en otra moneda', pagoMalo.status === 400 && /misma moneda/i.test(pagoMalo.data.error), JSON.stringify(pagoMalo.data));

  const pagoUsd = (await req('POST', '/api/ingresos', { documento_id: fUsd.id, monto: 1000, metodo: 'Transferencia' })).data;
  check('el cobro toma la moneda de la factura', pagoUsd.moneda === 'USD', pagoUsd.moneda);
  const fUsdB = (await req('GET', '/api/documentos/' + fUsd.id)).data;
  check('el balance en US$ es correcto', fUsdB.balance === 1006, `= ${fUsdB.balance}`);

  const cambio = await req('PUT', '/api/documentos/' + fUsd.id, {
    tipo: 'factura', contacto_id: cli.id, estado: 'emitida', moneda: 'DOP',
    items: [{ descripcion: 'Bomba importada', cantidad: 2, precio: 850, itbis: 1 }],
  });
  check('no deja cambiar la moneda de una factura con cobros', cambio.status === 400 && /moneda/i.test(cambio.data.error), JSON.stringify(cambio.data));

  await req('POST', '/api/ingresos', { concepto: 'Consultoría al exterior', monto: 500, moneda: 'USD', categoria: 'Servicios' });
  await req('POST', '/api/gastos', { concepto: 'Licencia de software', categoria: 'Equipos', subtotal: 200, itbis: 36, moneda: 'USD', fecha: '2026-09-03' });

  const rm = (await req('GET', '/api/reportes/resumen?desde=2026-01-01&hasta=2026-12-31')).data;
  check('el panel separa las dos monedas', rm.monedas.includes('DOP') && rm.monedas.includes('USD'), JSON.stringify(rm.monedas));
  check('los totales en RD$ no incluyen lo de US$', rm.porMoneda.DOP.ingresos === 18700, `= ${rm.porMoneda.DOP.ingresos}`);
  check('los ingresos en US$ se suman aparte', rm.porMoneda.USD.ingresos === 1500, `= ${rm.porMoneda.USD.ingresos}`);
  check('los gastos en US$ se suman aparte', rm.porMoneda.USD.gastos === 236, `= ${rm.porMoneda.USD.gastos}`);
  check('el inventario se valora por moneda', rm.porMoneda.USD.inventarioValor === 4960, `= ${rm.porMoneda.USD.inventarioValor}`);

  const inv2 = (await req('GET', '/api/inventario')).data;
  check('el inventario reporta valor por moneda', inv2.valorPorMoneda.USD > 0 && inv2.valorPorMoneda.DOP !== undefined, JSON.stringify(inv2.valorPorMoneda));

  const est2 = (await req('GET', '/api/reportes/estado?desde=2026-01-01&hasta=2026-12-31')).data;
  check('el estado de resultados trae un bloque por moneda', est2.bloques.length === 2, `= ${est2.bloques.length}`);
  const itb2 = (await req('GET', '/api/reportes/itbis?desde=2026-01-01&hasta=2026-12-31')).data;
  check('el reporte de ITBIS distingue la moneda', itb2.some((x) => x.moneda === 'USD') && itb2.some((x) => x.moneda === 'DOP'));

  const pdfUsd = await req('GET', `/api/documentos/${fUsd.id}/pdf`);
  check('genera el PDF de la factura en US$', typeof pdfUsd.data === 'string' && pdfUsd.data.startsWith('%PDF-'));
  const compUsd = (await req('GET', `/api/documentos/${fUsd.id}/compartir`)).data;
  check('el mensaje de WhatsApp usa US$', decodeURIComponent(compUsd.whatsapp).includes('US$'), decodeURIComponent(compUsd.whatsapp).slice(0, 80));

  console.log('\n== Importación CSV ==');
  // Archivo "difícil" a propósito: separador de punto y coma, tildes en los
  // encabezados, alias distintos, una comilla suelta, un duplicado y una fila mala.
  const csvProv = [
    'Nombre;RNC / Cédula;Persona de contacto;Teléfono;Correo electrónico;Dirección',
    'Ferretería Nacional SRL;131-55555-1;Marcos Ureña;809-555-1010;ventas@ferrenacional.do;Av. 27 de Febrero 320',
    'Aceros del Cibao SA;131-66666-2;Yolanda Cruz;829-444-2020;compras@acerocibao.do;Santiago',
    ';131-77777-3;Sin nombre;809-000-0000;x@y.do;',
  ].join('\r\n');

  const previa = await req('POST', '/api/importar/proveedores', { texto: csvProv });
  check('la vista previa no guarda nada todavía', previa.status === 200 && previa.data.resumen.total === 3, JSON.stringify(previa.data.resumen));
  check('reconoce los encabezados con tildes y alias', previa.data.columnas.filter((c) => c.campo).length === 6);
  check('detecta el punto y coma como separador', previa.data.separador === ';', `= ${previa.data.separador}`);
  check('marca como error la fila sin nombre', previa.data.resumen.errores === 1 && previa.data.resumen.nuevos === 2);
  const antesProv = (await req('GET', '/api/contactos?tipo=proveedor')).data.length;

  const impProv = await req('POST', '/api/importar/proveedores', { texto: csvProv, confirmar: 1 });
  check('importa los proveedores válidos', impProv.data.creados === 2 && impProv.data.omitidos === 1, JSON.stringify(impProv.data));
  const provs = (await req('GET', '/api/contactos?tipo=proveedor')).data;
  check('los proveedores quedan guardados', provs.length === antesProv + 2);
  const ferre = provs.find((p) => p.nombre === 'Ferretería Nacional SRL');
  check('conserva tildes y datos de contacto', !!ferre && ferre.telefono === '809-555-1010' && ferre.rnc === '131-55555-1');

  const repetido = await req('POST', '/api/importar/proveedores', { texto: csvProv, confirmar: 1 });
  check('no duplica al volver a importar el mismo archivo', repetido.data.creados === 0 && repetido.data.omitidos === 3, JSON.stringify(repetido.data));

  const csvProv2 = 'nombre;rnc;telefono\nFerretería Nacional SRL;131-55555-1;809-555-2222';
  const actual = await req('POST', '/api/importar/proveedores', { texto: csvProv2, confirmar: 1, duplicados: 'actualizar' });
  check('puede actualizar los que ya existen', actual.data.actualizados === 1, JSON.stringify(actual.data));
  const ferre2 = (await req('GET', '/api/contactos?tipo=proveedor')).data.find((p) => p.rnc === '131-55555-1');
  check('el archivo parcial no borra los datos anteriores', ferre2.telefono === '809-555-2222' && ferre2.email === 'ventas@ferrenacional.do');

  const csvProd = [
    'codigo,articulo,precio de venta,costo,itbis,moneda,inventario,existencia,minimo',
    'PIN-01,Galón de pintura acrílica,"1,450.00","980.00",si,RD$,si,40,10',
    'TUB-34,Tubo PVC 3/4" x 20 pies,285.50,190,SI,pesos,sí,120,30',
    'IMP-02,Grifería importada,215.00,150.00,si,USD,si,18,5',
    'SRV-05,Dirección facultativa,"35,000.00",0,si,,no,,',
  ].join('\n');
  const impProd = await req('POST', '/api/importar/productos', { texto: csvProd, confirmar: 1 });
  check('importa el catálogo', impProd.data.creados === 4, JSON.stringify(impProd.data));
  const cat = (await req('GET', '/api/productos')).data;
  const pintura = cat.find((p) => p.codigo === 'PIN-01');
  const tubo = cat.find((p) => p.codigo === 'TUB-34');
  const griferia = cat.find((p) => p.codigo === 'IMP-02');
  const servicioImp = cat.find((p) => p.codigo === 'SRV-05');
  check('lee los miles escritos con coma', pintura && pintura.precio === 1450, `= ${pintura && pintura.precio}`);
  check('respeta las comillas dentro del texto', tubo && tubo.nombre === 'Tubo PVC 3/4" x 20 pies', tubo && tubo.nombre);
  check('reconoce la moneda escrita de varias formas', griferia.moneda === 'USD' && tubo.moneda === 'DOP' && pintura.moneda === 'DOP');
  check('el artículo sin inventario no lleva existencia', servicioImp.inventario === 0 && servicioImp.existencia === 0);
  check('carga la existencia inicial', pintura.existencia === 40 && griferia.existencia === 18);

  const plant = await req('GET', '/api/importar/proveedores/plantilla');
  check('ofrece una plantilla de ejemplo', typeof plant.data === 'string' && plant.data.includes('nombre'));
  check('rechaza un tipo de importación desconocido', (await req('POST', '/api/importar/facturas', { texto: 'a,b' })).status === 404);
  check('avisa si falta la columna del nombre', (await req('POST', '/api/importar/clientes', { texto: 'telefono\n809' })).status === 400);
  check('avisa si el archivo viene vacío', (await req('POST', '/api/importar/clientes', { texto: '' })).status === 400);

  console.log('\n== Exportación y seguridad ==');
  const csv = await req('GET', '/api/export/facturas');
  check('exporta CSV de facturas', typeof csv.data === 'string' && csv.data.includes('numero'));
  check('ruta inexistente devuelve 404', (await req('GET', '/api/nada')).status === 404);
  const cookieBuena = cookie; cookie = 'sid=falso';
  check('rechaza cookie inválida', (await req('GET', '/api/empresa')).status === 401);
  cookie = cookieBuena;
  check('logout cierra sesión', (await req('POST', '/api/auth/logout')).status === 200);

  console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${ok} pruebas correctas, ${fallos} fallidas\n`);
  process.exit(fallos ? 1 : 0);
})();
