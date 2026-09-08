# Sistema de Facturación y Recibos

Aplicación web para facturación, presupuestos, recibos y control de ingresos y gastos,
configurada para **República Dominicana**: pesos (RD$), **ITBIS 18 %** y **numeración NCF**
automática por serie (B01, B02, B14, B15).

Funciona en su propia computadora o en un servidor de la oficina. **No requiere instalar
ninguna librería**: usa solo Node.js y una base de datos SQLite integrada.

---

## 1. Instalación (una sola vez)

1. Instale **Node.js versión 22 LTS o superior** desde <https://nodejs.org> (botón "LTS").
2. Descomprima esta carpeta donde quiera guardarla, por ejemplo `Documentos\Facturacion`.

## 2. Arrancar el programa

**Windows:** doble clic en `iniciar.bat`
**Mac o Linux:** doble clic en `iniciar.command`, o desde la terminal:

```bash
cd carpeta-del-programa
npm start
```

Luego abra el navegador en <http://localhost:3000>

**Acceso inicial:** usuario `admin` · contraseña `admin123`
→ Cámbiela en *Configuración → Cambiar mi contraseña* la primera vez que entre.

Para detener el programa, cierre la ventana negra o pulse `Ctrl + C`.

---

## 3. Primeros pasos recomendados

1. **Configuración** → complete los datos de su empresa, RNC, dirección, teléfono y suba su **logo**
   (aparecerá en facturas y recibos).
2. **Configuración → Secuencias NCF** → registre los rangos autorizados por la DGII
   (tipo, desde, hasta). El sistema asigna el próximo número solo, al emitir cada factura,
   y le avisa cuando quedan menos de 10 comprobantes.
3. **Clientes** y **Proveedores** → registre los que ya tiene.
4. **Productos y servicios** → cargue su catálogo con precios; luego se insertan en las
   facturas con un clic y se llenan solos.
5. Emita su primera factura desde **Facturas → Nueva factura**.

---

## 4. Qué hace cada módulo

| Módulo | Para qué sirve |
|---|---|
| **Panel** | Ingresos, gastos, utilidad, por cobrar, ITBIS a pagar, gráficos de 12 meses, facturas pendientes y mejores clientes. |
| **Facturas** | Emisión con NCF, ITBIS por línea, descuentos por línea y globales, estados (borrador, emitida, parcial, pagada, anulada), impresión/PDF y cobro en un clic. |
| **Presupuestos** | Cotizaciones con validez configurable; se convierten en factura con un botón, conservando todas las líneas. |
| **Ingresos y recibos** | Todo cobro genera un **recibo numerado** (REC-año-00000) listo para imprimir. También registra ingresos que no vienen de una factura. |
| **Gastos** | Concepto, categoría, proveedor, NCF del proveedor, ITBIS deducible y método de pago. Botón para calcular el ITBIS automáticamente. |
| **Clientes / Proveedores** | Ficha con RNC/cédula, contacto e historial completo de documentos. |
| **Productos y servicios** | Catálogo con costo, precio, margen, ITBIS y control de inventario opcional por artículo. |
| **Inventario** | Existencias, mínimos, valor del inventario, entradas, salidas, ajustes por conteo y kardex por artículo. |
| **Reportes** | Estado de resultados por categoría, ITBIS por mes (referencia para el IT-1) y antigüedad de cuentas por cobrar. Todo imprimible. |
| **Configuración** | Empresa, logo, moneda, tasa de ITBIS, secuencias NCF, usuarios y exportación a CSV/Excel. |

---

## 5. Cómo se calcula el ITBIS

- El ITBIS se aplica **solo a las líneas marcadas como gravadas** (casilla ITBIS).
- Primero se aplica el descuento de cada línea, después el descuento global, y sobre esa
  base neta se calcula el impuesto. Ejemplo: 10 × RD$ 1,500 gravado + RD$ 1,000 exento
  → subtotal RD$ 16,000, ITBIS RD$ 2,700, total **RD$ 18,700**.
- La tasa se cambia en *Configuración* si algún día varía.

---

## 6. Inventario

Cada artículo decide si lleva existencias: en su ficha, *Control de inventario* → **Sí, descontar al facturar**.
Los servicios (mano de obra, supervisión) se dejan en **No**.

- Al **emitir** una factura se descuenta la existencia automáticamente.
- Si no alcanza, el sistema **avisa pero permite la venta** y la existencia queda en negativo,
  para que registre después la entrada. El aviso indica el artículo y cuánto faltó.
- Al **anular** o **eliminar** una factura, la mercancía vuelve al inventario. Al **editar** una
  factura se revierte lo anterior y se descuenta lo nuevo.
- **Entradas** (compras), **salidas** (merma, consumo) y **ajustes por conteo físico** se registran
  desde el módulo Inventario. Cada movimiento queda en el kardex del artículo con su motivo,
  la factura o el proveedor asociado y la existencia resultante.
- El panel muestra el valor del inventario y una lista de **artículos por reponer** (existencia ≤ mínimo).

## 7. Enviar facturas por correo y por WhatsApp

**Correo.** En *Configuración → Correo* indique su servidor. Con **Gmail o Google Workspace**:

1. Active la verificación en dos pasos en su cuenta de Google.
2. Genere una **contraseña de aplicación** en <https://myaccount.google.com/apppasswords>.
3. Servidor `smtp.gmail.com`, puerto `587`, seguridad STARTTLS, usuario su correo y como
   contraseña las 16 letras del paso anterior (no la de su cuenta).
4. Pulse **Enviar correo de prueba** para confirmar antes de usarlo con clientes.

El correo sale con el **PDF adjunto**, el mensaje según su plantilla ({cliente}, {numero}, {total},
{fecha}, {empresa}, {enlace}) y un botón para ver el documento en línea. Cada envío queda registrado,
incluidos los fallidos con el motivo.

**WhatsApp.** El botón 💬 abre WhatsApp con el mensaje y el enlace ya escritos, al teléfono del
cliente; usted solo pulsa enviar. Es gratis y no requiere trámites con Meta.

**Enlace público.** Tanto el correo como WhatsApp comparten un enlace del tipo
`https://sudominio.com/p/<código>` que muestra la factura y permite descargar el PDF **sin clave**.
Trátelo como un enlace privado: quien lo tenga puede ver ese documento. Puede **revocarlo** en
cualquier momento desde la ventana de Compartir. En *Configuración* indique la dirección pública
del sistema para que los enlaces salgan correctos en los correos.

## 8. Sus datos y las copias de seguridad

Toda la información vive en un solo archivo: **`datos/facturacion.db`**.

- **Respaldar:** detenga el programa y copie la carpeta `datos` completa a una USB o la nube.
- **Restaurar:** reemplace esa carpeta y vuelva a arrancar.
- También puede exportar a CSV (se abre en Excel) desde *Configuración → Copia de seguridad*
  o con el botón "Exportar CSV" de cada módulo.

---

## 9. Usarlo desde otras computadoras de la oficina

Por seguridad, el programa solo escucha en la computadora donde corre. Para que otros
equipos de la red local entren, arránquelo así:

```bash
HOST=0.0.0.0 PORT=3000 npm start      # Mac / Linux
set HOST=0.0.0.0 && npm start          # Windows
```

Los demás entran a `http://IP-DE-ESA-PC:3000`. Cree un usuario por persona en
*Configuración → Usuarios*. Si va a publicarlo en internet, póngalo detrás de un
proxy con HTTPS (nginx, Caddy) — las contraseñas viajarían sin cifrar de otro modo.

---

## 10. Publicarlo en un hosting con cPanel

El archivo `app.js` de la raíz es el punto de entrada para *Setup Node.js App* (Passenger).
El sistema detecta solo si está instalado en un subdirectorio (ej. `midominio.com/facturacion`),
así que no hay que tocar el código. Consulte el documento **Guía de instalación en hosting**
que acompaña a este sistema para el paso a paso completo.

Variables de entorno opcionales:

| Variable | Para qué |
|---|---|
| `PORT` | Puerto (en cPanel lo asigna Passenger automáticamente). |
| `HOST` | `0.0.0.0` para aceptar conexiones de la red local. |
| `BASE_PATH` | Subcarpeta, solo si la detección automática fallara (ej. `/facturacion`). |

## 11. Verificación

Incluye 76 pruebas automáticas del servidor (ITBIS, descuentos, NCF, balances, estados,
conversión de presupuestos, reportes, inventario, PDF, enlaces públicos, correo y seguridad).
Con el programa corriendo:

```bash
node pruebas.js
```

---

## 12. Nota fiscal

Los cálculos de ITBIS y el reporte mensual son una **ayuda de gestión**, no una declaración
oficial. Valide siempre las cifras con su contador antes de presentar el IT-1 o el 606/607
ante la DGII.
