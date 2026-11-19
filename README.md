# Janitza Monitor

Dashboard para leer contadores Janitza por Modbus TCP. El CSV adjunto aporta inventario, IP, puerto, unidad, modelo y descripción; las lecturas de kWh/kW se consultan directamente en los medidores.

## Arranque

Ejecuta Node.js 18 o posterior en una máquina con acceso de red a los medidores:

```powershell
node server.js
```

Abre `http://127.0.0.1:8080`, selecciona **Cargar CSV** y carga el inventario Janitza. El proceso consulta los equipos cada 10 segundos. El dashboard muestra el estado individual y conserva la última lectura disponible cuando un equipo deja de responder.

No abras `index.html` directamente como archivo: el servidor local sirve la interfaz y el puente Modbus. No se necesita instalar paquetes npm. El servicio escucha solo en `127.0.0.1`; debe ejecutarse en un equipo que tenga ruta a las IPs de los medidores.

## Lecturas Modbus

El servicio usa Modbus TCP y realiza únicamente solicitudes de lectura (función 03). Para endpoints completos toma puerto y unit ID del CSV. En el formato abreviado de UMG 604/605 (`IP|5000`), interpreta `5000` como timeout en milisegundos y usa puerto TCP 502, unit ID 1. Decodifica valores float32 big-endian: potencia activa total en el registro 19026 (W) y energía activa total en 19060 (Wh), convertidos a kW y kWh. Los registros coinciden con las listas oficiales Janitza para UMG 604, UMG 96-PA y UMG 96RM-E. Si una variante de firmware usa un mapa diferente, su lectura se indicará como desconectada/error.

El host donde se ejecuta `server.js` debe poder alcanzar cada IP y el puerto Modbus configurado. El navegador no conecta directamente a los puertos TCP de los medidores.

## Funciones

- KPI globales y por grupo/edificio detectado desde el código de ubicación.
- Una tarjeta independiente por contador con su estado, IP, modelo, consumo acumulado y potencia actual.
- Búsqueda, filtro por grupo y orden por consumo o potencia.
- Estado de conexión por equipo y hora de última lectura.
- Interfaz en español, inglés o alemán, con idioma guardado en `localStorage`.
- Temas claro y oscuro con preferencia guardada en `localStorage`.
- Diseño adaptable para pantallas pequeñas.
