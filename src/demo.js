'use strict';
/* Datos de demostración. Solo se cargan cuando la variable DEMO vale 1 y la
   base está vacía: sirven para que la versión publicada en línea se vea con
   contenido. En una instalación real nunca se ejecuta. */

const { db, siguienteNumero, siguienteNCF } = require('./db');

function sembrar() {
  if (process.env.DEMO !== '1') return false;
  if (db.prepare('SELECT COUNT(*) c FROM documentos').get().c > 0) return false;

  const hoy = new Date();
  const dia = (resta) => new Date(hoy.getTime() - resta * 86400000).toISOString().slice(0, 10);
  const r2 = (n) => Math.round(n * 100) / 100;

  db.prepare(`UPDATE empresa SET nombre=?, rnc=?, direccion=?, telefono=?, email=?, web=?,
    condiciones=? WHERE id = 1`).run(
    'Constructora Demo SRL', '131-00000-1', 'Av. Winston Churchill 1099, Piantini, Santo Domingo',
    '809-555-0100', 'facturacion@constructorademo.do', 'www.constructorademo.do',
    'Pago a 30 días. Todo trabajo adicional será cotizado por separado. Gracias por su preferencia.');

  const cliente = db.prepare('INSERT INTO contactos (tipo,nombre,rnc,contacto,telefono,email,direccion) VALUES (?,?,?,?,?,?,?)');
  const clientes = [
    ['cliente', 'Inversiones del Este SRL', '101-00001-1', 'Ana Reyes', '809-222-3344', 'compras@investe.do', 'Calle Duarte 45, La Romana'],
    ['cliente', 'Residencial Los Almendros', '102-00002-2', 'Pedro Mateo', '829-410-7788', 'admin@losalmendros.do', 'Autopista Duarte km 12, Santiago'],
    ['cliente', 'Ferretería El Progreso', '103-00003-3', 'Luisa Gómez', '849-330-1122', 'compras@elprogreso.do', 'Av. Independencia 220, Santo Domingo'],
  ].map((c) => Number(cliente.run(...c).lastInsertRowid));
  const proveedores = [
    ['proveedor', 'Materiales del Caribe SRL', '104-00004-4', 'Julio Peña', '809-700-9090', 'ventas@matcaribe.do', 'Km 9 Aut. Duarte'],
    ['proveedor', 'Transporte Santo Domingo', '105-00005-5', 'Rosa Díaz', '809-600-4545', 'flota@transdo.do', 'Zona Industrial Herrera'],
  ].map((c) => Number(cliente.run(...c).lastInsertRowid));

  const prod = db.prepare(`INSERT INTO productos (codigo,nombre,descripcion,unidad,precio,costo,itbis,inventario,existencia,minimo)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const productos = [
    ['CEM-01', 'Funda de cemento gris 42.5 kg', 'Cemento portland tipo I', 'funda', 480, 380, 1, 1, 240, 60],
    ['VAR-12', 'Varilla 1/2" x 30 pies', 'Acero corrugado grado 60', 'unidad', 650, 520, 1, 1, 85, 40],
    ['BLK-06', 'Block de 6 pulgadas', 'Block hueco de concreto', 'unidad', 38, 27, 1, 1, 1800, 500],
    ['ARE-01', 'Metro de arena lavada', 'Arena de río lavada', 'm³', 1900, 1450, 1, 1, 18, 10],
    ['MO-01', 'Metro cuadrado de pared en block', 'Incluye mano de obra, mezcla y acabado', 'm²', 1500, 900, 1, 0, 0, 0],
    ['MO-02', 'Punto eléctrico instalado', 'Tubería, cableado y salida', 'punto', 1200, 700, 1, 0, 0, 0],
    ['SUP-01', 'Supervisión técnica de obra', 'Visita semanal e informe', 'mes', 18000, 0, 1, 0, 0, 0],
  ].map((p) => Number(prod.run(...p).lastInsertRowid));

  const mov = db.prepare(`INSERT INTO movimientos (producto_id,fecha,tipo,cantidad,costo,existencia,motivo,contacto_id)
    VALUES (?,?,?,?,?,?,?,?)`);
  [[0, 240, 380], [1, 85, 520], [2, 1800, 27], [3, 18, 1450]].forEach(([i, cant, costo]) => {
    mov.run(productos[i], dia(45), 'entrada', cant, costo, cant, 'Existencia inicial', proveedores[0]);
  });

  const insDoc = db.prepare(`INSERT INTO documentos (tipo,numero,ncf,ncf_tipo,contacto_id,cliente_nombre,cliente_rnc,fecha,
    vencimiento,estado,subtotal,descuento,itbis,total,notas,condiciones,stock_aplicado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insItem = db.prepare(`INSERT INTO documento_items (documento_id,producto_id,descripcion,cantidad,precio,descuento,itbis,importe,orden)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const e = db.prepare('SELECT * FROM empresa WHERE id = 1').get();

  function documento({ tipo, ncfTipo, cli, fecha, venc, estado, lineas, notas }) {
    let subtotal = 0, itbis = 0;
    const detalle = lineas.map(([pi, cantidad, desc = 0]) => {
      const p = db.prepare('SELECT * FROM productos WHERE id = ?').get(productos[pi]);
      const importe = r2(cantidad * p.precio * (1 - desc / 100));
      subtotal += importe;
      if (p.itbis) itbis += importe * (e.itbis_tasa / 100);
      return { p, cantidad, desc, importe };
    });
    subtotal = r2(subtotal); itbis = r2(itbis);
    const numero = siguienteNumero(tipo, tipo === 'factura' ? 'FAC' : 'PRE');
    let ncf = '';
    if (ncfTipo) { const s = siguienteNCF(ncfTipo); if (s && s.ncf) ncf = s.ncf; }
    const c = db.prepare('SELECT * FROM contactos WHERE id = ?').get(cli);
    const id = Number(insDoc.run(tipo, numero, ncf, ncfTipo || '', cli, c.nombre, c.rnc, fecha, venc, estado,
      subtotal, 0, itbis, r2(subtotal + itbis), notas || '', e.condiciones,
      tipo === 'factura' && !['borrador', 'anulada'].includes(estado) ? 1 : 0).lastInsertRowid);
    detalle.forEach((d, i) => insItem.run(id, d.p.id, d.p.nombre, d.cantidad, d.p.precio, d.desc, d.p.itbis, d.importe, i));
    // descuento de inventario
    if (tipo === 'factura' && !['borrador', 'anulada'].includes(estado)) {
      detalle.forEach((d) => {
        if (!d.p.inventario) return;
        const ex = r2(db.prepare('SELECT existencia FROM productos WHERE id = ?').get(d.p.id).existencia - d.cantidad);
        db.prepare('UPDATE productos SET existencia = ? WHERE id = ?').run(ex, d.p.id);
        mov.run(d.p.id, fecha, 'salida', d.cantidad, d.p.costo, ex, `Factura ${numero}`, cli);
      });
    }
    return { id, numero, total: r2(subtotal + itbis) };
  }

  const f1 = documento({ tipo: 'factura', ncfTipo: 'B01', cli: clientes[0], fecha: dia(38), venc: dia(8), estado: 'emitida',
    lineas: [[4, 85], [5, 40], [6, 1]], notas: 'Obra Torre Almendra, primera etapa.' });
  const f2 = documento({ tipo: 'factura', ncfTipo: 'B01', cli: clientes[1], fecha: dia(24), venc: dia(-6), estado: 'emitida',
    lineas: [[0, 120], [2, 900], [4, 40]] });
  const f3 = documento({ tipo: 'factura', ncfTipo: 'B02', cli: clientes[2], fecha: dia(12), venc: dia(18), estado: 'emitida',
    lineas: [[1, 30], [3, 6]] });
  const f4 = documento({ tipo: 'factura', ncfTipo: 'B01', cli: clientes[0], fecha: dia(5), venc: dia(25), estado: 'emitida',
    lineas: [[5, 25], [6, 1]] });
  documento({ tipo: 'presupuesto', cli: clientes[1], fecha: dia(6), venc: dia(-9), estado: 'enviado',
    lineas: [[4, 220], [5, 90], [6, 3]], notas: 'Segunda etapa: 12 apartamentos.' });
  documento({ tipo: 'presupuesto', cli: clientes[2], fecha: dia(2), venc: dia(-13), estado: 'borrador',
    lineas: [[0, 300], [2, 2500]] });

  const insIng = db.prepare(`INSERT INTO ingresos (recibo,fecha,concepto,categoria,contacto_id,documento_id,monto,metodo,referencia)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const cobro = (doc, cli, monto, fecha, metodo, ref) =>
    insIng.run(siguienteNumero('recibo', 'REC'), fecha, `Pago factura ${doc.numero}`, 'Ventas', cli, doc.id, r2(monto), metodo, ref || '');
  cobro(f1, clientes[0], f1.total, dia(30), 'Transferencia', 'BPD-778812');
  cobro(f2, clientes[1], f2.total * 0.4, dia(16), 'Cheque', 'CH-004512');
  cobro(f3, clientes[2], f3.total, dia(9), 'Efectivo');
  cobro(f4, clientes[0], f4.total * 0.5, dia(2), 'Transferencia', 'BPD-990341');
  insIng.run(siguienteNumero('recibo', 'REC'), dia(20), 'Alquiler de andamios a terceros', 'Alquileres', null, null, 42000, 'Transferencia', '');

  const insGas = db.prepare(`INSERT INTO gastos (fecha,concepto,categoria,contacto_id,subtotal,itbis,monto,metodo,ncf,deducible)
    VALUES (?,?,?,?,?,?,?,?,?,1)`);
  const gasto = (f, con, cat, prov, sub, ncf, met) =>
    insGas.run(f, con, cat, prov, sub, r2(sub * 0.18), r2(sub * 1.18), met, ncf);
  gasto(dia(40), 'Compra de cemento y block', 'Materiales', proveedores[0], 186000, 'B0100000451', 'Transferencia');
  gasto(dia(33), 'Flete de materiales a la obra', 'Transporte', proveedores[1], 34000, 'B0100000452', 'Cheque');
  gasto(dia(28), 'Nómina de albañilería quincena', 'Nómina', null, 240000, '', 'Transferencia');
  gasto(dia(21), 'Combustible de equipos', 'Combustible', null, 28500, 'B0200000110', 'Efectivo');
  gasto(dia(15), 'Alquiler de retroexcavadora', 'Equipos', proveedores[1], 62000, 'B0100000488', 'Transferencia');
  gasto(dia(10), 'Compra de varilla', 'Materiales', proveedores[0], 97000, 'B0100000501', 'Transferencia');
  gasto(dia(4), 'Seguro de responsabilidad civil', 'Seguros', null, 18500, '', 'Tarjeta');

  console.log('[demo] datos de demostración cargados');
  return true;
}

module.exports = { sembrar };
