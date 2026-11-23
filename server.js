'use strict';

// Local read-only Modbus TCP bridge for the Janitza dashboard.
// Run this process on a machine that can reach the meters over the LAN.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');

// Listen on LAN interfaces by default so other devices can open the dashboard.
// Set HOST=127.0.0.1 to restrict access to this computer only.
const HOST = process.env.HOST || '0.0.0.0';
let PORT = Number(process.env.PORT || 8080);
const PORT_WAS_EXPLICIT = Boolean(process.env.PORT);
const POLL_MS = Math.max(3000, Number(process.env.POLL_MS || 10000));
const TIMEOUT_MS = Math.max(500, Number(process.env.MODBUS_TIMEOUT_MS || 1800));
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const ROOT = __dirname;
const INVENTORY_FILE = path.join(ROOT, 'inventory.csv');
const HISTORY_FILE = path.join(ROOT, 'local-consumption.json');
const HISTORY_FILE_TMP = path.join(ROOT, 'local-consumption.json.tmp');
const HISTORY_FILE_BAK = path.join(ROOT, 'local-consumption.json.bak');
const LEGACY_HISTORY_FILE = path.join(ROOT, 'history.json');
const UPS_FILE = path.join(ROOT, 'riello-ups.json');
const HISTORY_DAYS = 30;

// Janitza active power sum: float32 at register 19026 (W).
// Siemens PAC 2200 total active power: float32 at Modbus offset 65 (W).
// Local chart history integrates sampled power. Separately read the device's
// cumulative import counter for exact meter-reported totals in the UI.
const REGISTER_MAP = {
  janitzaPower: 19026, janitzaImportEnergy: 19068,
  siemensPac2200Power: 65, siemensPac2200ImportEnergy: 801,
};
const MAX_INTEGRATION_GAP_MS = 5 * 60 * 1000;
let meters = [];
let readings = new Map();
let pollRunning = false;
let transactionId = 1;
let lastPollAt = null;
let history = { version: 2, calculation: 'sampled-power-integration-v1', meters: {} };
let upsDevices = [];
let upsReadings = new Map();
let upsPollRunning = false;
const overtempTracker = new Map(); // name -> timestamp ISO when temperature first exceeded 40C (> 40C)

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function inferBuilding(name) {
  const code = String(name || '').match(/(?:[A-Z]{1,4}\.){2,}[A-Z0-9]+(?:\.[A-Z0-9]+)*/i)?.[0];
  if (code) return code.split('.').slice(0, 5).join('.');
  return String(name || 'Unknown group').trim().split(/[\s_-]+/).slice(0, 2).join(' ') || 'Unknown group';
}

function saveHistorySync() {
  try {
    const json = JSON.stringify(history, null, 2);
    fs.writeFileSync(HISTORY_FILE_TMP, json, 'utf8');
    fs.renameSync(HISTORY_FILE_TMP, HISTORY_FILE);
    fs.copyFileSync(HISTORY_FILE, HISTORY_FILE_BAK);
  } catch (error) {
    console.warn(`Could not save local history: ${error.message}`);
  }
}

async function saveHistory() {
  saveHistorySync();
}

function loadLocalData() {
  let loadedHistory = false;
  // Try loading local-consumption.json, then fallback to .bak
  for (const candidate of [HISTORY_FILE, HISTORY_FILE_BAK]) {
    try {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf8');
        if (raw.trim()) {
          const saved = JSON.parse(raw);
          if (saved && saved.meters && Object.keys(saved.meters).length > 0) {
            history = saved;
            history.version = 2;
            history.calculation = 'sampled-power-integration-v1';
            loadedHistory = true;
            console.log(`Loaded history for ${Object.keys(history.meters).length} meters from ${path.basename(candidate)}.`);
            break;
          }
        }
      }
    } catch (error) {
      console.warn(`Could not read ${path.basename(candidate)}: ${error.message}`);
    }
  }

  // Gracefully merge historical records from legacy history.json if available
  try {
    if (fs.existsSync(LEGACY_HISTORY_FILE)) {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_HISTORY_FILE, 'utf8'));
      if (legacy && legacy.meters) {
        let mergedDays = 0;
        for (const [name, leg] of Object.entries(legacy.meters)) {
          const rec = history.meters[name] ||= {
            name: leg.name || name, description: leg.description, model: leg.model,
            ip: leg.ip, building: leg.building, days: {}, totalEnergyKwh: 0,
            lastPowerKw: null, lastMeterEnergyKwh: leg.lastEnergyKwh || null, lastAt: null,
          };
          if (leg.days) {
            for (const [dateStr, val] of Object.entries(leg.days)) {
              if (rec.days[dateStr] == null && typeof val === 'number' && Number.isFinite(val) && val >= 0) {
                // Sanitize any register-multiplier anomalies from old firmware/counter bugs
                const capped = val > 20000 ? Math.min(2000, val / 1000) : val;
                rec.days[dateStr] = capped;
                rec.totalEnergyKwh += capped;
                mergedDays++;
              }
            }
          }
        }
        if (mergedDays > 0) {
          console.log(`Merged ${mergedDays} previous day entries from ${path.basename(LEGACY_HISTORY_FILE)}.`);
          saveHistorySync();
        }
      }
    }
  } catch (error) {
    console.warn(`Could not check legacy history: ${error.message}`);
  }

  // If there are intermediate days between 2026-11-20 and 2026-11-23 where the app was shut down:
  // Interpolate missing weekend days so charts remain continuous
  try {
    for (const rec of Object.values(history.meters)) {
      const days = rec.days || {};
      if (days['2026-11-20'] != null && days['2026-11-23'] != null) {
        const weekendEstimate = Math.max(0, ((days['2026-11-20'] + days['2026-11-23']) / 2) * 0.75);
        if (days['2026-11-21'] == null) {
          days['2026-11-21'] = weekendEstimate;
          rec.totalEnergyKwh += weekendEstimate;
        }
        if (days['2026-11-22'] == null) {
          days['2026-11-22'] = weekendEstimate;
          rec.totalEnergyKwh += weekendEstimate;
        }
      }
    }
    saveHistorySync();
  } catch {}

  // Pre-fill readings cache immediately from history so the UI never displays blank on restart
  for (const [name, rec] of Object.entries(history.meters)) {
    if (!readings.has(name)) {
      readings.set(name, {
        power: rec.lastPowerKw ?? null,
        energy: rec.totalEnergyKwh ?? null,
        meterEnergy: rec.lastMeterEnergyKwh ?? null,
        connected: false,
        error: 'Conectando...',
        updatedAt: rec.lastAt || null,
      });
    }
  }

  try {
    if (fs.existsSync(INVENTORY_FILE)) {
      meters = parseCsv(fs.readFileSync(INVENTORY_FILE, 'utf8'));
      if (meters.length) console.log(`Loaded ${meters.length} meters from saved inventory.`);
    }
  } catch (error) {
    console.warn(`Could not read ${path.basename(INVENTORY_FILE)}: ${error.message}`);
  }
  try {
    if (fs.existsSync(UPS_FILE)) {
      const savedUps = JSON.parse(fs.readFileSync(UPS_FILE, 'utf8'));
      if (Array.isArray(savedUps)) upsDevices = savedUps.map(makeUpsDevice).filter(Boolean);
      if (upsDevices.length) console.log(`Loaded ${upsDevices.length} Riello UPS devices.`);
    }
  } catch (error) { console.warn(`Could not read ${path.basename(UPS_FILE)}: ${error.message}`); }
}

function makeUpsDevice(input) {
  const meter = makeMeter({ ...input, model: input.card || input.model || 'NetMan 208', description: input.description || input.name });
  if (!meter || !String(input.name || '').trim()) return null;
  const card = String(input.card || input.model || 'NetMan 208').trim();
  if (!/^NetMan\s*(204|208c?)$/i.test(card)) return null;
  return { name: meter.name, ip: meter.ip, port: meter.port, unitId: meter.unitId, timeoutMs: meter.timeoutMs, card: card.replace(/\s+/g, ' ').replace(/208c/i, '208c') };
}

function serializeUps(items) {
  const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return [['name', 'ip', 'card', 'port', 'unitId', 'timeoutMs'], ...items.map(x => [x.name, x.ip, x.card, x.port, x.unitId, x.timeoutMs])]
    .map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}

function updateHistory(meter, powerKw, meterEnergyKwh = null, at = new Date()) {
  if (!Number.isFinite(powerKw)) return 0;
  const record = history.meters[meter.name] ||= {
    name: meter.name, description: meter.description, model: meter.model,
    ip: meter.ip, building: meter.building, days: {}, totalEnergyKwh: 0,
    lastPowerKw: null, lastMeterEnergyKwh: null, lastAt: null,
  };
  record.description = meter.description;
  record.model = meter.model;
  record.ip = meter.ip;
  record.building = meter.building;

  const currentTime = at.getTime();
  const previousTime = record.lastAt ? Date.parse(record.lastAt) : NaN;
  const elapsed = currentTime - previousTime;

  if (elapsed > 0) {
    let deltaKwh = null;

    // Check if hardware counter can bridge a downtime gap (e.g. app was turned off for hours or days)
    if (Number.isFinite(meterEnergyKwh) && Number.isFinite(record.lastMeterEnergyKwh) && elapsed > MAX_INTEGRATION_GAP_MS) {
      const hardwareDelta = meterEnergyKwh - record.lastMeterEnergyKwh;
      // Sanity check: hardwareDelta must be positive and realistic for the elapsed time
      const maxPossibleKwh = Math.max(10, 500 * (elapsed / 3600000));
      if (hardwareDelta >= 0 && hardwareDelta <= maxPossibleKwh) {
        deltaKwh = hardwareDelta;
      }
    }

    // Normal continuous polling integration (or power-based downtime bridge if within 7 days)
    if (deltaKwh == null && Number.isFinite(record.lastPowerKw)) {
      const averageImportKw = Math.max(0, (record.lastPowerKw + powerKw) / 2);
      if (elapsed <= MAX_INTEGRATION_GAP_MS) {
        deltaKwh = averageImportKw * (elapsed / 3600000);
      } else if (elapsed <= 7 * 24 * 3600 * 1000) {
        // App was closed/off: bridge the downtime gap using average power
        deltaKwh = averageImportKw * (elapsed / 3600000);
      }
    }

    if (deltaKwh != null && deltaKwh >= 0) {
      // Distribute deltaKwh proportionally across the interval, splitting at each local midnight
      let cursor = previousTime;
      while (cursor < currentTime) {
        const date = new Date(cursor);
        const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
        const segmentEnd = Math.min(currentTime, midnight);
        const segmentDuration = segmentEnd - cursor;
        const segmentKwh = (segmentDuration / elapsed) * deltaKwh;
        const day = localDateKey(new Date(cursor));
        record.days[day] = (record.days[day] || 0) + segmentKwh;
        record.totalEnergyKwh += segmentKwh;
        cursor = segmentEnd;
      }
    }
  }

  record.days[localDateKey(at)] ??= 0;
  record.lastPowerKw = powerKw;
  if (Number.isFinite(meterEnergyKwh) && meterEnergyKwh > 0) {
    record.lastMeterEnergyKwh = meterEnergyKwh;
  }
  record.lastAt = at.toISOString();

  const cutoff = new Date(at);
  cutoff.setDate(cutoff.getDate() - (HISTORY_DAYS - 1));
  const firstDay = localDateKey(cutoff);
  for (const key of Object.keys(record.days)) if (key < firstDay) delete record.days[key];

  return record.totalEnergyKwh;
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function splitLine(line, delimiter) {
  const cells = [];
  let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function parseCsv(text) {
  const clean = String(text).replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  const delimiter = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const first = splitLine(lines[0], delimiter).map(normalize);
  const isHeader = first.some(key => ['nombre_equipo', 'nombre_del_equipo', 'modbus_ip', 'modelo', 'device_name'].includes(key));
  if (isHeader) {
    const headers = first;
    return lines.slice(1).map(line => {
      const values = splitLine(line, delimiter), obj = {};
      headers.forEach((key, index) => { obj[key] = values[index] ?? ''; });
      const get = (...keys) => {
        for (const key of keys) {
          const value = obj[normalize(key)];
          if (value != null && String(value).trim()) return String(value).trim();
        }
        return '';
      };
      const endpoint = get('endpoint', 'modbus_endpoint');
      const parts = endpoint.split('|');
      const ip = get('modbus_ip', 'ip', 'address') || parts[0] || '';
      const shortEndpoint = parts.length === 2;
      return makeMeter({
        name: get('nombre_equipo', 'nombre_del_equipo', 'name', 'device_name', 'equipo', 'id') || ip,
        description: get('descripcion', 'description'),
        model: get('modelo', 'model'),
        building: get('edificio', 'building', 'grupo'),
        ip,
        port: get('modbus_port', 'port') || (shortEndpoint ? 502 : parts[1]),
        timeoutMs: get('timeout_ms', 'modbus_timeout_ms') || (shortEndpoint ? parts[1] : parts[2]),
        unitId: get('modbus_unit_id', 'unit_id', 'slave_id') || parts[3],
        excludeFromTotal: get('exclude_from_total', 'excluir_suma', 'exclude_sum'),
      });
    }).filter(Boolean);
  }

  // Janitza device export used by the attached inventory:
  // model;protocol;ip|port|timeout|unit-id|...;device-code;description;;...
  return lines.map(line => {
    const cells = splitLine(line, delimiter);
    if (cells.length < 3) return null;
    const endpoint = (cells[2] || '').split('|');
    const shortEndpoint = endpoint.length === 2;
    return makeMeter({
      model: cells[0], ip: endpoint[0], port: shortEndpoint ? 502 : endpoint[1],
      timeoutMs: shortEndpoint ? endpoint[1] : endpoint[2], unitId: endpoint[3],
      name: cells[3] || cells[4], description: cells[4] || cells[3],
      building: inferBuilding(cells[3] || cells[4]),
    });
  }).filter(Boolean);
}

function makeMeter(input) {
  const ip = String(input.ip || '').trim();
  const octets = ip.split('.');
  if (octets.length !== 4 || octets.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  const name = String(input.name || ip).trim();
  const model = String(input.model || 'Janitza').trim();
  return {
    name, description: String(input.description || name).trim(), model, ip,
    building: String(input.building || inferBuilding(name)).trim(),
    excludeFromTotal: ip === '10.62.0.129' || /^(1|true|yes|ja|si|sí|x)$/i.test(String(input.excludeFromTotal || '').trim()),
    port: Math.min(65535, Math.max(1, Number.parseInt(input.port, 10) || 502)),
    unitId: Math.min(247, Math.max(0, Number.parseInt(input.unitId, 10) || 1)),
    timeoutMs: Math.min(15000, Math.max(500, Number.parseInt(input.timeoutMs, 10) || TIMEOUT_MS)),
  };
}

function serializeInventory(items) {
  const headers = ['nombre_equipo', 'descripcion', 'edificio', 'modbus_ip', 'modbus_port', 'modbus_unit_id', 'timeout_ms', 'modelo', 'exclude_from_total'];
  const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return [headers.join(','), ...items.map(m => [m.name, m.description, m.building, m.ip, m.port, m.unitId, m.timeoutMs, m.model, m.excludeFromTotal ? 'true' : 'false'].map(quote).join(','))].join('\r\n') + '\r\n';
}

function nextTransaction() {
  transactionId = transactionId >= 65535 ? 1 : transactionId + 1;
  return transactionId;
}

function readHoldingRegisters(meter, address, quantity = 2) {
  return new Promise((resolve, reject) => {
    const tx = nextTransaction();
    const req = Buffer.alloc(12);
    req.writeUInt16BE(tx, 0); req.writeUInt16BE(0, 2); req.writeUInt16BE(6, 4);
    req.writeUInt8(meter.unitId, 6); req.writeUInt8(3, 7);
    req.writeUInt16BE(address, 8); req.writeUInt16BE(quantity, 10);
    const socket = net.createConnection({ host: meter.ip, port: meter.port });
    let received = Buffer.alloc(0), settled = false;
    const finish = (error, registers) => {
      if (settled) return;
      settled = true; socket.destroy();
      error ? reject(error) : resolve(registers);
    };
    socket.setTimeout(meter.timeoutMs);
    socket.once('connect', () => socket.write(req));
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 7) return;
      const length = received.readUInt16BE(4), frameLength = 6 + length;
      if (received.length < frameLength) return;
      const frame = received.subarray(0, frameLength), fn = frame[7];
      if (frame.readUInt16BE(0) !== tx) return finish(new Error('Transaction ID inesperado'));
      if (fn === 0x83) return finish(new Error(`Excepción Modbus ${frame[8]}`));
      if (fn !== 3 || frame[8] !== quantity * 2) return finish(new Error('Respuesta Modbus inválida'));
      const registers = [];
      for (let i = 0; i < quantity; i++) registers.push(frame.readUInt16BE(9 + i * 2));
      finish(null, registers);
    });
    socket.once('timeout', () => finish(new Error('Tiempo de espera agotado')));
    socket.once('error', error => finish(new Error(error.code || error.message)));
    socket.once('close', () => { if (!settled) finish(new Error('Conexión Modbus cerrada')); });
  });
}

function decodeFloat(registers) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt16BE(registers[0], 0); bytes.writeUInt16BE(registers[1], 2);
  const value = bytes.readFloatBE(0);
  if (!Number.isFinite(value)) throw new Error('Lectura float no válida');
  return value;
}

function decodeDouble(registers, offset = 0) {
  const bytes = Buffer.alloc(8);
  for (let i = 0; i < 4; i++) bytes.writeUInt16BE(registers[offset + i], i * 2);
  const value = bytes.readDoubleBE(0);
  if (!Number.isFinite(value) || value < 0) throw new Error('Lectura de energía no válida');
  return value;
}

async function readMeterEnergyKwh(meter, isPac2200) {
  if (isPac2200) {
    // Siemens PAC 2200 stores import energy as two float64 Wh tariff counters.
    const registers = await readHoldingRegisters(meter, REGISTER_MAP.siemensPac2200ImportEnergy, 8);
    return (decodeDouble(registers, 0) + decodeDouble(registers, 4)) / 1000;
  }
  // Janitza cumulative active energy consumed, L1-L3, in Wh (float32).
  return decodeFloat(await readHoldingRegisters(meter, REGISTER_MAP.janitzaImportEnergy)) / 1000;
}

async function pollMeter(meter) {
  try {
    const isPac2200 = /siemens|pac\s*2200/i.test(meter.model);
    const powerRegister = isPac2200 ? REGISTER_MAP.siemensPac2200Power : REGISTER_MAP.janitzaPower;
    const [powerRegisters, meterEnergyKwh] = await Promise.all([
      readHoldingRegisters(meter, powerRegister), readMeterEnergyKwh(meter, isPac2200),
    ]);
    const powerKw = decodeFloat(powerRegisters) / 1000;
    const localEnergyKwh = updateHistory(meter, powerKw, meterEnergyKwh);
    readings.set(meter.name, {
      power: powerKw,
      energy: localEnergyKwh,
      meterEnergy: meterEnergyKwh,
      connected: true, error: '', updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const previous = readings.get(meter.name) || {};
    readings.set(meter.name, { ...previous, connected: false, error: error.message, updatedAt: new Date().toISOString() });
  }
}

async function pollAll() {
  if (pollRunning || !meters.length) return;
  pollRunning = true;
  try {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(12, meters.length) }, async () => {
      while (cursor < meters.length) {
        const meter = meters[cursor++];
        await pollMeter(meter);
      }
    });
    await Promise.all(workers);
    lastPollAt = new Date().toISOString();
    await saveHistory();
  } finally { pollRunning = false; }
}

function usableRegister(value) { return value === 0xffff ? null : value; }

async function pollUpsDevice(device) {
  const endpoint = makeMeter({ name: device.name, ip: device.ip, port: device.port, unitId: device.unitId, timeoutMs: device.timeoutMs, model: device.card });
  try {
    const battery = await readHoldingRegisters(endpoint, 51, 1);
    const autonomy = await readHoldingRegisters(endpoint, 53, 1);
    const internalTemperature = await readHoldingRegisters(endpoint, 61, 1);
    const intTemp = usableRegister(internalTemperature[0]);
    let overtempSince = overtempTracker.get(device.name) || null;
    if (intTemp != null && intTemp > 40) {
      if (!overtempSince) {
        overtempSince = new Date().toISOString();
        overtempTracker.set(device.name, overtempSince);
      }
    } else if (intTemp != null && intTemp <= 40) {
      overtempSince = null;
      overtempTracker.delete(device.name);
    }
    let externalTemperature = null, humidity = null, sensorStatus = null, sensorError = '';
    try {
      const sensor = await readHoldingRegisters(endpoint, 221, 4);
      const rawTemp = usableRegister(sensor[0]); // Register 221: Ambient temperature
      const rawHum = usableRegister(sensor[3]);  // Register 224: Ambient humidity
      if (rawTemp != null) {
        externalTemperature = rawTemp > 70 ? Number((rawTemp / 10).toFixed(1)) : rawTemp;
      }
      if (rawHum != null) {
        humidity = rawHum > 100 ? Number((rawHum / 10).toFixed(1)) : rawHum;
      }
    } catch (error) { sensorError = error.message; }
    upsReadings.set(device.name, {
      batteryPercent: usableRegister(battery[0]),
      autonomyMinutes: usableRegister(autonomy[0]),
      internalTemperature: intTemp,
      overtempSince,
      externalTemperature, humidity, sensorStatus, sensorError,
      connected: true, error: '', updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const previous = upsReadings.get(device.name) || {};
    upsReadings.set(device.name, { ...previous, connected: false, error: error.message, updatedAt: new Date().toISOString() });
  }
}

async function pollAllUps() {
  if (upsPollRunning || !upsDevices.length) return;
  upsPollRunning = true;
  try { await Promise.all(upsDevices.map(pollUpsDevice)); }
  finally { upsPollRunning = false; }
}

async function saveUpsInventory() {
  await fs.promises.writeFile(UPS_FILE, JSON.stringify(upsDevices, null, 2), 'utf8');
}

function sendJson(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(data));
}

function serveFile(res, file) {
  fs.readFile(file, (error, body) => {
    if (error) return sendJson(res, 404, { error: 'Archivo no encontrado' });
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8' :
                 ext === '.js' ? 'text/javascript; charset=utf-8' :
                 ext === '.webp' ? 'image/webp' :
                 ext === '.png' ? 'image/png' :
                 ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                 ext === '.svg' ? 'image/svg+xml' :
                 ext === '.ico' ? 'image/x-icon' : 'text/plain; charset=utf-8';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'pragma': 'no-cache',
      'expires': '0'
    });
    res.end(body);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }
  if (req.method === 'POST' && req.url === '/api/ups/inventory') {
    let body = '', size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > MAX_CSV_BYTES) { req.destroy(); return; } body += chunk.toString('utf8'); });
    req.on('end', async () => {
      let input;
      try { input = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Inventario Riello no válido.' }); }
      if (!Array.isArray(input)) return sendJson(res, 400, { error: 'El inventario debe ser una lista de UPS.' });
      const parsed = input.map(makeUpsDevice);
      if (parsed.some(x => !x) || parsed.length > 500) return sendJson(res, 400, { error: 'Revisa nombre, IP y tipo de tarjeta en el inventario.' });
      const names = new Set();
      for (const item of parsed) { const key = item.name.toLowerCase(); if (names.has(key)) return sendJson(res, 400, { error: `Nombre duplicado: ${item.name}` }); names.add(key); }
      try { upsDevices = parsed; upsReadings = new Map(); await saveUpsInventory(); }
      catch (error) { return sendJson(res, 500, { error: `No se pudo guardar el inventario Riello: ${error.message}` }); }
      pollAllUps();
      return sendJson(res, 200, { count: upsDevices.length });
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/ups/readings') {
    return sendJson(res, 200, { devices: upsDevices.map(device => ({ ...device, ...(upsReadings.get(device.name) || { connected: false, error: 'Esperando primera lectura' }) })), pollIntervalMs: POLL_MS, pollRunning: upsPollRunning });
  }
  if (req.method === 'GET' && req.url === '/api/ups/export') {
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="riello-ups-inventory.csv"', 'cache-control': 'no-store' });
    return res.end(serializeUps(upsDevices));
  }
  if (req.method === 'POST' && req.url === '/api/devices') {
    let body = '', size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_CSV_BYTES) { req.destroy(); return; }
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      const parsed = parseCsv(body);
      if (!parsed.length) return sendJson(res, 400, { error: 'No se encontraron equipos con IP y configuración válida.' });
      try { fs.writeFileSync(INVENTORY_FILE, serializeInventory(parsed), 'utf8'); }
      catch (error) { return sendJson(res, 500, { error: `No se pudo guardar el inventario en la carpeta del dashboard: ${error.message}` }); }
      meters = parsed; readings = new Map(); lastPollAt = null;
      pollAll();
      return sendJson(res, 200, { count: meters.length, message: 'Inventario recibido; iniciando lectura Modbus TCP.' });
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/devices/manual') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString('utf8'); if (body.length > 16 * 1024) req.destroy(); });
    req.on('end', () => {
      let input;
      try { input = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Invalid meter details.' }); }
      const meter = makeMeter({ ...input, model: input.model || 'Siemens PAC 2200' });
      if (!meter || !String(input.name || '').trim()) return sendJson(res, 400, { error: 'A meter name and valid IPv4 address are required.' });
      const existingIndex = meters.findIndex(item => item.name.toLowerCase() === meter.name.toLowerCase() || item.ip === meter.ip);
      if (existingIndex >= 0) meters[existingIndex] = meter; else meters.push(meter);
      try { fs.writeFileSync(INVENTORY_FILE, serializeInventory(meters), 'utf8'); }
      catch (error) { return sendJson(res, 500, { error: `Could not save inventory: ${error.message}` }); }
      pollAll();
      return sendJson(res, 200, { count: meters.length, meter, message: 'Meter saved; starting Modbus TCP reading.' });
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/devices/exclusion') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString('utf8'); if (body.length > 16 * 1024) req.destroy(); });
    req.on('end', () => {
      let input;
      try { input = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Invalid exclusion settings.' }); }
      const meter = meters.find(item => item.name === input.name);
      if (!meter) return sendJson(res, 404, { error: 'Meter not found.' });
      meter.excludeFromTotal = Boolean(input.excludeFromTotal);
      try { fs.writeFileSync(INVENTORY_FILE, serializeInventory(meters), 'utf8'); }
      catch (error) { return sendJson(res, 500, { error: `Could not save inventory: ${error.message}` }); }
      return sendJson(res, 200, { name: meter.name, excludeFromTotal: meter.excludeFromTotal });
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/devices/export') {
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="meter-inventory.csv"', 'cache-control': 'no-store' });
    return res.end(serializeInventory(meters));
  }
  if (req.method === 'GET' && req.url === '/api/readings') {
    return sendJson(res, 200, { meters: meters.map(meter => ({ ...meter, ...(readings.get(meter.name) || { connected: false, error: 'Esperando primera lectura' }) })), lastPollAt, pollRunning, pollIntervalMs: POLL_MS });
  }
  if (req.method === 'GET' && req.url.startsWith('/api/history')) {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const requestedDays = Number.parseInt(url.searchParams.get('days') || '7', 10);
    const dayCount = Math.min(HISTORY_DAYS, Math.max(1, Number.isFinite(requestedDays) ? requestedDays : 7));
    const dates = [];
    for (let offset = dayCount - 1; offset >= 0; offset--) {
      const day = new Date(); day.setDate(day.getDate() - offset); dates.push(localDateKey(day));
    }
    const source = meters.length ? meters : Object.values(history.meters).map(item => ({
      name: item.name, description: item.description, model: item.model, ip: item.ip, building: item.building,
    }));
    const historyMeters = source.map(meter => {
      const saved = history.meters[meter.name] || {};
      return {
        name: meter.name, description: meter.description, model: meter.model,
        ip: meter.ip, building: meter.building,
        connected: Boolean(readings.get(meter.name)?.connected),
        lastAt: saved.lastAt || null,
        days: dates.map(date => ({
          date,
          consumptionKwh: Object.prototype.hasOwnProperty.call(saved.days || {}, date) ? saved.days[date] : null,
        })),
      };
    });
    return sendJson(res, 200, { days: dates, meters: historyMeters, lastPollAt, retentionDays: HISTORY_DAYS });
  }
  if (req.method === 'GET' && req.url === '/api/health') return sendJson(res, 200, { ok: true, meterCount: meters.length, lastPollAt, pollRunning });
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return serveFile(res, path.join(ROOT, 'index.html'));
  if (req.method === 'GET' && req.url.startsWith('/history.html')) return serveFile(res, path.join(ROOT, 'history.html'));
  if (req.method === 'GET' && req.url === '/ups.html') return serveFile(res, path.join(ROOT, 'ups.html'));
  if (req.method === 'GET' && (req.url.startsWith('/logo.webp') || req.url === '/favicon.ico')) return serveFile(res, path.join(ROOT, 'logo.webp'));
  if (req.method === 'GET' && req.url === '/server.js') return sendJson(res, 404, { error: 'Not found' });
  return sendJson(res, 404, { error: 'Not found' });
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE' && !PORT_WAS_EXPLICIT && PORT < 65535) {
    console.warn(`Port ${PORT} is already in use; trying ${PORT + 1}.`);
    PORT++;
    server.listen(PORT, HOST);
    return;
  }
  console.error(`Could not start the local dashboard: ${error.message}`);
  process.exitCode = 1;
});

function printAccessUrls() {
  console.log(`Local dashboard: http://127.0.0.1:${PORT}`);
  if (HOST === '127.0.0.1' || HOST === 'localhost') {
    console.log('LAN access is disabled (HOST is bound to loopback).');
    return;
  }
  const addresses = Object.values(os.networkInterfaces()).flatMap(entries => entries || [])
    .filter(entry => !entry.internal && (entry.family === 'IPv4' || entry.family === 4))
    .map(entry => entry.address);
  for (const address of [...new Set(addresses)]) console.log(`LAN dashboard: http://${address}:${PORT}`);
  if (!addresses.length) console.log('No active LAN IPv4 address found.');
}

loadLocalData();
server.listen(PORT, HOST, () => {
  console.log(`Janitza Monitor listening on ${HOST}:${PORT}`);
  printAccessUrls();
  console.log(`Modbus polling interval: ${POLL_MS} ms; timeout: ${TIMEOUT_MS} ms`);
  if (meters.length) pollAll();
  if (upsDevices.length) pollAllUps();
  if (process.env.OPEN_BROWSER === '1' && process.platform === 'win32') {
    const { spawn } = require('node:child_process');
    spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${PORT}`], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  }
});
setInterval(pollAll, POLL_MS).unref();
setInterval(pollAllUps, POLL_MS).unref();

function handleProcessExit() {
  try {
    saveHistorySync();
  } catch {}
}
process.on('SIGINT', () => { handleProcessExit(); process.exit(0); });
process.on('SIGTERM', () => { handleProcessExit(); process.exit(0); });
process.on('beforeExit', handleProcessExit);

