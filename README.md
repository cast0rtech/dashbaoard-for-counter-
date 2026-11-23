# Janitza Monitor ⚡

The Riello UPS view is available at `http://127.0.0.1:8080/ups.html`. It lets you monitor Riello UPS devices with NetMan 204, 208, or 208c cards in real time over Modbus TCP (battery level, autonomy runtime, internal temperature, and environmental sensor readings), manage the device inventory, and import/export the list as CSV.

A local dashboard for reading Janitza meters over Modbus TCP. The CSV inventory provides each meter's IP address, port, unit ID, model, and description. Live active power (kW) is read from each meter; energy consumption is calculated and tracked locally by this dashboard.

## 🚀 Getting started

On Windows, double-click `start-dashboard.bat`. It starts the local service and opens the dashboard in your browser. Or run Node.js 18 or later from this folder on a computer that can reach the meters over the network:

```powershell
node server.js
```

Open `http://127.0.0.1:8080`, choose **Load inventory**, and select a meter inventory CSV. You can also add a Siemens PAC 2200 by entering its name and IP address. **Export CSV** downloads the current inventory in an Excel-compatible format; importing that CSV on another dashboard server restores the meter list and Modbus settings. The service saves a local copy as `inventory.csv` and polls meters every 10 seconds. On later launches, the saved inventory is loaded automatically. The dashboard shows each meter's connection status and keeps its last successful reading if the meter stops responding.

Select any meter card on the main page to open its individual history chart. The chart shows daily energy consumption for the last 7, 14, or 30 days. The dashboard integrates its locally sampled active-power readings over time and stores the resulting history and local energy total in `local-consumption.json`. It does not use the meter's stored cumulative kWh register for tracking. A new installation starts accumulating history after its first successful poll; it cannot recreate days from before the dashboard was running. Intervals longer than five minutes are skipped so downtime is not counted as consumption.

Do not open `index.html` directly as a file. The local server serves both pages and the Modbus bridge. No npm packages are required. By default, it listens on all network interfaces; if the default port is busy, it tries the next port and prints the addresses it chose. Run it on a computer with a network route to the meters' IP addresses.

## 🌐 Share on your local network

Start the dashboard with `start-dashboard.bat` and use the `LAN dashboard` URL printed in its console window on another computer, tablet, or phone connected to the same network. The computer running the dashboard must remain on and the console window must stay open. If Windows Firewall asks, allow Node.js on **Private networks** (or allow inbound TCP on the dashboard port shown in the console). Do not create a Public-network firewall rule. To use the dashboard only on the host computer, start it with `HOST=127.0.0.1` set in the environment. LAN users can access the dashboard and its inventory controls; the app does not require a login.

## 🔌 Modbus readings

The service uses Modbus TCP and sends read-only requests (function code 03). For full endpoints, it reads the port and unit ID from the CSV. For the abbreviated UMG 604/605 format (`IP|5000`), it treats `5000` as the timeout in milliseconds and defaults to TCP port 502 and unit ID 1.

For Janitza models, the service reads the big-endian float32 total active-power value at register 19026 (W). For Siemens SENTRON PAC 2200, it reads the total active-power float at Modbus offset 65 (W). Both are converted to kW. The dashboard also reads the cumulative import-energy counter for the exact meter-reported total. Janitza uses 19068 (float32 Wh); Siemens PAC 2200 reads its tariff 1 and 2 import counters at offsets 801 and 805 (float64 Wh). Those device totals are displayed separately. Daily chart history still integrates average power locally between consecutive samples and does not use these counters. The Janitza power register is listed for the UMG 604, UMG 96-PA, and UMG 96RM-E. The Siemens PAC 2200 register is from the Siemens equipment manual. If a firmware variant uses a different map, the meter will show a connection/read error.

The computer running `server.js` must be able to reach every meter IP and configured Modbus port. The browser cannot connect directly to the meters' TCP ports.

## 📁 Copying the dashboard

Copy the entire dashboard folder, including `server.js`, `index.html`, `history.html`, and `start-dashboard.bat`. Keep `inventory.csv` and `local-consumption.json` with the folder to preserve the imported meter list and locally tracked history. They are created automatically after you load an inventory and collect readings. On the destination computer, install Node.js 18 or later, make sure it can reach the meter network, and run `start-dashboard.bat`. No absolute paths or npm packages are required.

## 📊 Features

- Global KPIs and totals for the detected building groups.
- One card per meter, showing its status, IP, model, locally tracked energy, and current power.
- Search, group filtering, and sorting by energy or power.
- Per-meter connection status and last successful reading time.
- Spanish, English, and German interface languages, saved in `localStorage`.
- Manually add Siemens SENTRON PAC 2200 meters by name and IP address.
- Export and import the meter inventory as Excel-compatible CSV for server migration, including each meter’s `exclude_from_total` flag.
- Mark central meters on their cards to exclude them from sums. The reference meter at `10.62.0.129` remains visible and the dashboard compares its locally tracked consumption against the included meter sum.
- Light and dark themes, saved in `localStorage`.
- Responsive layout for smaller screens.
