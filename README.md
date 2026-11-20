# Janitza Monitor ⚡

A local dashboard for reading Janitza meters over Modbus TCP. The CSV inventory provides each meter's IP address, port, unit ID, model, and description; kWh and kW readings are polled directly from the meters.

## 🚀 Getting started

On Windows, double-click `start-dashboard.bat`. It starts the local service and opens the dashboard in your browser. Or run Node.js 18 or later from this folder on a computer that can reach the meters over the network:

```powershell
node server.js
```

Open `http://127.0.0.1:8080`, choose **Load inventory**, and select the Janitza CSV file the first time. The service saves a local copy as `inventory.csv` and polls meters every 10 seconds. On later launches, the saved inventory is loaded automatically. The dashboard shows each meter's connection status and keeps its last successful reading if the meter stops responding.

Select any meter card on the main page to open its individual history chart. The chart shows daily energy consumption for the last 7, 14, or 30 days. History is calculated from changes in the cumulative energy register and stored in `history.json` beside the app. A new installation starts accumulating history after its first successful poll; it cannot recreate days from before the dashboard was running.

Do not open `index.html` directly as a file. The local server serves both pages and the Modbus bridge. No npm packages are required. The service listens only on `127.0.0.1`; if the default port is busy, it tries the next port and prints the address it chose. Run it on a computer with a network route to the meters' IP addresses.

## 🔌 Modbus readings

The service uses Modbus TCP and sends read-only requests (function code 03). For full endpoints, it reads the port and unit ID from the CSV. For the abbreviated UMG 604/605 format (`IP|5000`), it treats `5000` as the timeout in milliseconds and defaults to TCP port 502 and unit ID 1.

The service decodes big-endian float32 values: total active power at register 19026 (W) and total active energy at register 19060 (Wh), converting them to kW and kWh. These registers match Janitza's address lists for the UMG 604, UMG 96-PA, and UMG 96RM-E. If a firmware variant uses a different map, the meter will show a connection/read error.

The computer running `server.js` must be able to reach every meter IP and configured Modbus port. The browser cannot connect directly to the meters' TCP ports.

## 📁 Copying the dashboard

Copy the entire dashboard folder, including `server.js`, `index.html`, `history.html`, and `start-dashboard.bat`. Keep `inventory.csv` and `history.json` with the folder to preserve the imported meter list and chart history. They are created automatically after you load an inventory and collect readings. On the destination computer, install Node.js 18 or later, make sure it can reach the meter network, and run `start-dashboard.bat`. No absolute paths or npm packages are required.

## 📊 Features

- Global KPIs and totals for the detected building groups.
- One card per meter, showing its status, IP, model, accumulated energy, and current power.
- Search, group filtering, and sorting by energy or power.
- Per-meter connection status and last successful reading time.
- Spanish, English, and German interface languages, saved in `localStorage`.
- Light and dark themes, saved in `localStorage`.
- Responsive layout for smaller screens.
