'use strict';
/* Punto de entrada para Vercel (función sin servidor).
   Reutiliza el mismo servidor del programa: aquí no se escucha en un puerto,
   la plataforma entrega cada petición directamente al manejador. */
module.exports = require('../server.js');
