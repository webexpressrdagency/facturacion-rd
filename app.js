'use strict';
/* Punto de entrada para hostings con cPanel / Passenger y para `npm start`.
   En "Setup Node.js App" indique este archivo como "Application startup file". */
const servidor = require('./server.js');
servidor.arrancar();
