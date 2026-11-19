# Janitza Monitor ⚡

A local dashboard for reading Janitza meters over Modbus TCP. The CSV inventory provides each meter's IP address, port, unit ID, model, and description; kWh and kW readings are polled directly from the meters.

## 🚀 Getting started

Run Node.js 18 or later on a computer that can reach the meters over the network:

```powershell
node server.js
```

Open `http://127.0.0.1:8080`, choose **Load inventory**, and select the Janitza CSV file. The service polls the meters every 10 seconds. The dashboard shows each meter's connection status and keeps its last successful reading if the meter stops responding.

Do not open `index.html` directly as a file. The local server serves the dashboard and the Modbus bridge. No npm packages are required. The service listens only on `127.0.0.1`, so run it on a computer with a network route to the meters' IP addresses.

## 🔌 Modbus readings

The service uses Modbus TCP and sends read-only requests (function code 03). For full endpoints, it reads the port and unit ID from the CSV. For the abbreviated UMG 604/605 format (`IP|5000`), it treats `5000` as the timeout in milliseconds and defaults to TCP port 502 and unit ID 1.

The service decodes big-endian float32 values: total active power at register 19026 (W) and total active energy at register 19060 (Wh), converting them to kW and kWh. These registers match Janitza's address lists for the UMG 604, UMG 96-PA, and UMG 96RM-E. If a firmware variant uses a different map, the meter will show a connection/read error.

The computer running `server.js` must be able to reach every meter IP and configured Modbus port. The browser cannot connect directly to the meters' TCP ports.

## 📊 Features

- Global KPIs and totals for the detected building groups.
- One card per meter, showing its status, IP, model, accumulated energy, and current power.
- Search, group filtering, and sorting by energy or power.
- Per-meter connection status and last successful reading time.
- Spanish, English, and German interface languages, saved in `localStorage`.
- Light and dark themes, saved in `localStorage`.
- Responsive layout for smaller screens.
