'use strict';

// Local read-only Modbus TCP bridge for the Janitza dashboard.
// Run this process on a machine that can reach the meters over the LAN.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const HOST = process.env.HOST || '127.0.0.1';
let PORT = Number(process.env.PORT || 8080);
const PORT_WAS_EXPLICIT = Boolean(process.env.PORT);
const POLL_MS = Math.max(3000, Number(process.env.POLL_MS || 10000));
const TIMEOUT_MS = Math.max(500, Number(process.env.MODBUS_TIMEOUT_MS || 1800));
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const ROOT = __dirname;
const INVENTORY_FILE = path.join(ROOT, 'inventory.csv');
const HISTORY_FILE = path.join(ROOT, 'history.json');
const HISTORY_DAYS = 30;

// Janitza publishes these common measured values as 32-bit IEEE floats:
// active power sum at 19026 (W), active energy sum at 19060 (Wh).
// References: official UMG 96-PA and UMG 96RM-E address lists.
const REGISTER_MAP = { power: 19026, energy: 19060 };
let meters = [];
let readings = new Map();
let pollRunning = false;
let transactionId = 1;
let lastPollAt = null;
let history = { version: 1, meters: {} };

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function inferBuilding(name) {
  const code = String(name || '').match(/(?:[A-Z]{1,4}\.){2,}[A-Z0-9]+(?:\.[A-Z0-9]+)*/i)?.[0];
  if (code) return code.split('.').slice(0, 5).join('.');
  return String(name || 'Unknown group').trim().split(/[\s_-]+/).slice(0, 2).join(' ') || 'Unknown group';
}

function loadLocalData() {
  try {
    if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (error) {
    console.warn(`Could not read ${path.basename(HISTORY_FILE)}: ${error.message}`);
    history = { version: 1, meters: {} };
  }
  try {
    if (fs.existsSync(INVENTORY_FILE)) {
      meters = parseCsv(fs.readFileSync(INVENTORY_FILE, 'utf8'));
      if (meters.length) console.log(`Loaded ${meters.length} meters from saved inventory.`);
    }
  } catch (error) {
    console.warn(`Could not read ${path.basename(INVENTORY_FILE)}: ${error.message}`);
  }
}

function updateHistory(meter, energyKwh, at = new Date()) {
  if (!Number.isFinite(energyKwh)) return;
  const record = history.meters[meter.name] ||= {
    name: meter.name, description: meter.description, model: meter.model,
    ip: meter.ip, building: meter.building, days: {}, lastEnergyKwh: null, lastAt: null,
  };
  record.description = meter.description;
  record.model = meter.model;
  record.ip = meter.ip;
  record.building = meter.building;
  const day = localDateKey(at);
  if (record.lastEnergyKwh == null) record.days[day] ??= 0;
  else {
    const delta = energyKwh - record.lastEnergyKwh;
    // A negative change indicates a meter reset or rollover; start a new baseline.
    if (delta >= 0) record.days[day] = (record.days[day] || 0) + delta;
    else record.days[day] ??= 0;
  }
  record.lastEnergyKwh = energyKwh;
  record.lastAt = at.toISOString();
  const cutoff = new Date(at);
  cutoff.setDate(cutoff.getDate() - (HISTORY_DAYS - 1));
  const firstDay = localDateKey(cutoff);
  for (const key of Object.keys(record.days)) if (key < firstDay) delete record.days[key];
}

async function saveHistory() {
  try { await fs.promises.writeFile(HISTORY_FILE, JSON.stringify(history), 'utf8'); }
  catch (error) { console.warn(`Could not save local history: ${error.message}`); }
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
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  const name = String(input.name || ip).trim();
  const model = String(input.model || 'Janitza').trim();
  return {
    name, description: String(input.description || name).trim(), model, ip,
    building: String(input.building || inferBuilding(name)).trim(),
    port: Math.min(65535, Math.max(1, Number.parseInt(input.port, 10) || 502)),
    unitId: Math.min(247, Math.max(0, Number.parseInt(input.unitId, 10) || 1)),
    timeoutMs: Math.min(15000, Math.max(500, Number.parseInt(input.timeoutMs, 10) || TIMEOUT_MS)),
  };
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

async function pollMeter(meter) {
  try {
    const [powerRegs, energyRegs] = await Promise.all([
      readHoldingRegisters(meter, REGISTER_MAP.power),
      readHoldingRegisters(meter, REGISTER_MAP.energy),
    ]);
    const energy = decodeFloat(energyRegs) / 1000;
    readings.set(meter.name, {
      power: decodeFloat(powerRegs) / 1000,
      energy,
      connected: true, error: '', updatedAt: new Date().toISOString(),
    });
    updateHistory(meter, energy);
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

function sendJson(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': 'http://127.0.0.1:8080' });
  res.end(JSON.stringify(data));
}

function serveFile(res, file) {
  fs.readFile(file, (error, body) => {
    if (error) return sendJson(res, 404, { error: 'Archivo no encontrado' });
    const ext = path.extname(file);
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
    return res.end();
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
      try { fs.writeFileSync(INVENTORY_FILE, body, 'utf8'); }
      catch (error) { return sendJson(res, 500, { error: `No se pudo guardar el inventario en la carpeta del dashboard: ${error.message}` }); }
      meters = parsed; readings = new Map(); lastPollAt = null;
      pollAll();
      return sendJson(res, 200, { count: meters.length, message: 'Inventario recibido; iniciando lectura Modbus TCP.' });
    });
    return;
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

loadLocalData();
server.listen(PORT, HOST, () => {
  console.log(`Janitza Monitor: http://${HOST}:${PORT}`);
  console.log(`Modbus polling interval: ${POLL_MS} ms; timeout: ${TIMEOUT_MS} ms`);
  if (meters.length) pollAll();
  if (process.env.OPEN_BROWSER === '1' && process.platform === 'win32') {
    const { spawn } = require('node:child_process');
    spawn('cmd.exe', ['/c', 'start', '', `http://${HOST}:${PORT}`], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  }
});
setInterval(pollAll, POLL_MS).unref();

