'use strict';
/* Cliente SMTP mínimo, sin dependencias externas.
   Soporta SSL directo (puerto 465) y STARTTLS (puerto 587), AUTH LOGIN,
   y mensajes MIME con cuerpo en texto + HTML y un archivo adjunto. */

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const TIEMPO = 20000;

/**
 * Ejecuta una secuencia de comandos SMTP.
 * @param esperarSaludo  true si el servidor aún debe enviar su "220" de bienvenida.
 * Devuelve { registro, socket, upgrade?, restantes? }.
 */
function ejecutar(socket, pasos, esperarSaludo) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let idx = esperarSaludo ? -1 : -1;
    const registro = [];
    let listo = false;

    const cerrar = (err, val) => {
      if (listo) return;
      listo = true;
      clearTimeout(t);
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('end');
      if (err) reject(err); else resolve(val);
    };
    const t = setTimeout(() => cerrar(new Error('El servidor de correo no respondió a tiempo (20 s).')), TIEMPO);

    const avanzar = () => {
      idx += 1;
      if (idx >= pasos.length) return cerrar(null, { registro, socket });
      const paso = pasos[idx];
      if (paso.upgrade) return cerrar(null, { registro, socket, upgrade: true, restantes: pasos.slice(idx + 1) });
      const texto = typeof paso.enviar === 'function' ? paso.enviar() : paso.enviar;
      registro.push('> ' + (paso.secreto ? '***' : String(texto).slice(0, 160)));
      socket.write(texto + '\r\n');
    };

    socket.on('data', (d) => {
      buffer += d.toString('utf8');
      const lineas = buffer.split('\r\n').filter((l) => l !== '');
      const ultima = lineas[lineas.length - 1] || '';
      if (!/^\d{3}(\s|$)/.test(ultima)) return;      // respuesta multilínea incompleta
      const respuesta = buffer.trim();
      buffer = '';
      registro.push('< ' + respuesta.slice(0, 300));
      const codigo = parseInt(ultima.slice(0, 3), 10);
      const esperado = idx < 0 ? [220] : (pasos[idx].esperado || [250]);
      if (!esperado.includes(codigo)) {
        return cerrar(new Error(respuesta.split('\r\n').pop() || 'Error del servidor de correo'));
      }
      avanzar();
    });
    socket.on('error', (e) => cerrar(e));
    socket.on('end', () => cerrar(new Error('El servidor de correo cerró la conexión.')));

    if (!esperarSaludo) avanzar();
  });
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const cabecera = (t) => (/^[\x20-\x7E]*$/.test(String(t ?? '')) ? String(t ?? '') : `=?UTF-8?B?${b64(t)}?=`);
const direccion = (correo, nombre) => (nombre ? `${cabecera(nombre)} <${correo}>` : correo);
const base64Lineas = (buf) => buf.toString('base64').replace(/(.{76})/g, '$1\r\n');

function construirMensaje({ de, nombreDe, para, copia, asunto, texto, html, adjunto }) {
  const limite = 'lim_' + crypto.randomBytes(12).toString('hex');
  const limiteAlt = 'alt_' + crypto.randomBytes(12).toString('hex');
  const cab = [
    `From: ${direccion(de, nombreDe)}`,
    `To: ${para.join(', ')}`,
    ...(copia && copia.length ? [`Cc: ${copia.join(', ')}`] : []),
    `Subject: ${cabecera(asunto)}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${de.split('@')[1] || 'localhost'}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
  ];
  const alternativa = [
    `Content-Type: multipart/alternative; boundary="${limiteAlt}"`, '',
    `--${limiteAlt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '',
    base64Lineas(Buffer.from(texto || '', 'utf8')), '',
    `--${limiteAlt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '',
    base64Lineas(Buffer.from(html || '', 'utf8')), '',
    `--${limiteAlt}--`,
  ];
  if (!adjunto) return cab.concat(alternativa).join('\r\n');
  return cab.concat([
    `Content-Type: multipart/mixed; boundary="${limite}"`, '',
    `--${limite}`,
    ...alternativa, '',
    `--${limite}`,
    `Content-Type: ${adjunto.tipo || 'application/pdf'}; name="${adjunto.nombre}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${adjunto.nombre}"`, '',
    base64Lineas(adjunto.datos), '',
    `--${limite}--`, '',
  ]).join('\r\n');
}

const escaparPuntos = (m) => m.replace(/\r\n\./g, '\r\n..');

async function enviar(cfg, mensaje) {
  if (!cfg.servidor || !cfg.usuario || !cfg.remitente) {
    throw new Error('Faltan datos en la configuración de correo (servidor, usuario o remitente).');
  }
  if (!mensaje.para || !mensaje.para.length) throw new Error('Indique al menos un destinatario.');

  const puerto = Number(cfg.puerto) || 587;
  const host = String(cfg.servidor).trim();
  const ssl = cfg.seguridad === 'ssl' || puerto === 465;
  const dominio = cfg.remitente.split('@')[1] || 'localhost';
  const cuerpo = escaparPuntos(construirMensaje(mensaje));
  const destinatarios = [...mensaje.para, ...(mensaje.copia || [])];

  const socketInicial = await new Promise((resolve, reject) => {
    const s = ssl
      ? tls.connect({ host, port: puerto, servername: host }, () => resolve(s))
      : net.connect({ host, port: puerto }, () => resolve(s));
    s.setTimeout(TIEMPO);
    s.once('error', (e) => reject(new Error(`No se pudo conectar a ${host}:${puerto} — ${e.message}`)));
    s.once('timeout', () => { s.destroy(); reject(new Error(`No se pudo conectar a ${host}:${puerto} (tiempo agotado).`)); });
  });

  const autenticar = [
    { enviar: 'AUTH LOGIN', esperado: [334] },
    { enviar: b64(cfg.usuario), esperado: [334], secreto: true },
    { enviar: b64(cfg.clave), esperado: [235], secreto: true },
  ];
  const entregar = [
    { enviar: `MAIL FROM:<${cfg.remitente}>`, esperado: [250] },
    ...destinatarios.map((d) => ({ enviar: `RCPT TO:<${d}>`, esperado: [250, 251] })),
    { enviar: 'DATA', esperado: [354] },
    { enviar: cuerpo + '\r\n.', esperado: [250], secreto: true },
    { enviar: 'QUIT', esperado: [221] },
  ];
  const sesion = [{ enviar: `EHLO ${dominio}`, esperado: [250] }, ...autenticar, ...entregar];

  let resultado;
  if (ssl) {
    resultado = await ejecutar(socketInicial, sesion, true);
  } else {
    resultado = await ejecutar(socketInicial, [
      { enviar: `EHLO ${dominio}`, esperado: [250] },
      { enviar: 'STARTTLS', esperado: [220] },
      { upgrade: true },
    ], true);
    const seguro = tls.connect({ socket: resultado.socket, servername: host });
    await new Promise((ok, err) => {
      seguro.once('secureConnect', ok);
      seguro.once('error', (e) => err(new Error(`No se pudo cifrar la conexión (STARTTLS): ${e.message}`)));
    });
    // tras STARTTLS se repite el EHLO y ya no hay saludo inicial
    const r2 = await ejecutar(seguro, sesion, false);
    resultado = { registro: resultado.registro.concat(r2.registro), socket: seguro };
  }
  try { resultado.socket.end(); } catch { /* ya cerrado */ }
  return resultado.registro;
}

module.exports = { enviar, construirMensaje, cabecera };
