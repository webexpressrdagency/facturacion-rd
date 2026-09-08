# Sistema de Facturación y Recibos

Aplicación web de facturación, presupuestos, recibos, inventario y control de ingresos y
gastos, configurada para **República Dominicana**: pesos (RD$), **ITBIS 18 %** y
**numeración NCF** automática por serie (B01, B02, B14, B15).

**Sin dependencias externas.** Solo Node.js y su base de datos SQLite integrada: no hay
`npm install`, no hay paquetes que se rompan con el tiempo. Todo el sistema pesa unos 230 KB.

---

## Arrancarlo en su computadora

Requiere **Node.js 22 o superior** ([nodejs.org](https://nodejs.org), botón LTS).

```bash
npm start
```

Abra <http://localhost:3000> · usuario `admin` · contraseña `admin123`
(cámbiela en *Configuración → Cambiar mi contraseña* la primera vez).

En Windows puede hacer doble clic en `iniciar.bat`; en Mac o Linux, en `iniciar.command`.

## Pruebas

```bash
npm start           # en una consola
node pruebas.js     # en otra
```

76 pruebas automáticas: cálculo de ITBIS, descuentos, secuencias NCF, balances y estados de
factura, conversión de presupuestos, inventario, reportes, generación de PDF, enlaces
públicos, correo y control de sesión.

---

## Qué incluye

| Módulo | Para qué sirve |
|---|---|
| **Panel** | Ingresos, gastos, utilidad, por cobrar, ITBIS a pagar, gráficos de 12 meses y artículos por reponer. |
| **Facturas** | NCF automático, ITBIS por línea, descuentos, estados, PDF, cobro en un clic. |
| **Presupuestos** | Cotizaciones con validez configurable; se convierten en factura con un botón. |
| **Ingresos y recibos** | Cada cobro emite un recibo numerado listo para imprimir o enviar. |
| **Gastos** | Categorías, proveedor, NCF del proveedor e ITBIS deducible. |
| **Inventario** | Existencias, mínimos, kardex, descuento automático al facturar y devolución al anular. |
| **Clientes / Proveedores** | Ficha con RNC/cédula e historial completo. |
| **Productos y servicios** | Catálogo con costo, precio, margen e inventario opcional. |
| **Reportes** | Estado de resultados, ITBIS por mes (referencia para el IT-1) y antigüedad de cuentas por cobrar. |
| **Envíos** | Factura por correo con PDF adjunto (SMTP propio) y por WhatsApp mediante enlace. |
| **Configuración** | Empresa, logo, moneda, tasa de ITBIS, secuencias NCF, usuarios, correo y exportación a CSV. |

---

## Cómo está hecho

```
app.js            arranque (npm start y cPanel/Passenger)
api/index.js      arranque como función sin servidor (Vercel)
server.js         servidor HTTP, rutas estáticas y sesión
src/db.js         esquema SQLite, migraciones y numeración
src/api.js        toda la lógica de negocio y la API REST
src/pdf.js        generador de PDF propio (sin librerías)
src/plantillas.js diseño de facturas, presupuestos y recibos en PDF
src/correo.js     cliente SMTP propio (STARTTLS y SSL, con adjuntos)
src/demo.js       datos de demostración (solo si DEMO=1)
public/           interfaz web (un HTML, un CSS, un JS)
pruebas.js        76 pruebas automáticas
```

### Variables de entorno

| Variable | Para qué | Por defecto |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `HOST` | `0.0.0.0` para aceptar la red local | `127.0.0.1` |
| `DB_PATH` | Ruta del archivo de base de datos | `./datos/facturacion.db` |
| `BASE_PATH` | Subcarpeta, si la detección automática falla | vacío |
| `SESSION_SECRET` | Clave para firmar las sesiones | se genera y se guarda en la base |
| `DEMO` | `1` carga datos de demostración en una base vacía | apagado |

---

## Dónde alojarlo

### Servidor propio o hosting con cPanel — recomendado

Es donde debe vivir la instalación real: el archivo `datos/facturacion.db` queda en un disco
que no se borra. El paso a paso está en `LEEME.md` y en el manual ilustrado que acompaña al
proyecto. El archivo de arranque para *Setup Node.js App* es `app.js`.

### Vercel — solo para mostrar el sistema

El proyecto incluye `vercel.json` y `api/index.js` para poder publicar una **demostración**.
Tenga presente que Vercel no da disco permanente:

- La base de datos vive en `/tmp` y **se borra** cuando la función se reinicia.
- Cada instancia tiene su propia copia: lo que registre puede no verlo en la petición siguiente.
- Por eso `DEMO=1` recarga datos de ejemplo cada vez que la base amanece vacía.

Sirve para enseñar el sistema; **no para facturar de verdad**. Para producción en la nube con
datos que persistan haría falta un servicio con disco (Render con volumen, Fly.io, un VPS) o
cambiar SQLite por una base de datos gestionada.

> El `SESSION_SECRET` que aparece en `vercel.json` es público y sirve solo para la demostración.
> En cualquier instalación real defina el suyo como variable de entorno y no lo suba al repositorio.

---

## Nota fiscal

Los cálculos de ITBIS y el reporte mensual son una **ayuda de gestión**, no una declaración
oficial. Valide siempre las cifras con su contador antes de presentar el IT-1 o los formatos
606/607 ante la DGII.

## Licencia

MIT.
