require('dotenv').config();

const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const ewelink = require('ewelink-api');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// --- eWeLink config ---
const login  = process.env.EWELINK_EMAIL;
const pass   = process.env.EWELINK_PASSWORD;
const region = process.env.EWELINK_REGION || 'eu';

const switchId     = process.env.SWITCH_ID    || '10017b7136';
const rgbDeviceId  = process.env.RGB_DEVICE_ID|| '100123e422';
const lockDeviceId = process.env.LOCK_DEVICE_ID || 'YOUR_LOCK_DEVICE_ID';

// --- Express middleware ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- State ---
const systemState = {
    temperature: 24.5,
    motion: false,
    smoke: false,
    door: false,
    lock: false,
    battery: 85,
    lamp1: false,
    lamp2: false,
    fan: false,
    rgbPower: false,
    rgbColor: '#ff0000',
    haBridgeStatus: 'Ready',
    lastUpdate: Date.now(),
};

// --- Single shared eWeLink connection ---
let ewelinkConn = null;
async function getEWeLink() {
    if (!ewelinkConn) {
        ewelinkConn = new ewelink({ email: login, password: pass, region });
    }
    return ewelinkConn;
}

// --- Broadcast helper ---
function broadcastState() {
    systemState.lastUpdate = Date.now();
    const data = JSON.stringify({ type: 'STATE_UPDATE', payload: systemState });
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
    });
}

function sendTo(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// --- Channel toggle for the multi-channel relay ---
async function handleChannelToggle(channelNumber, currentState, stateKey) {
    try {
        const connection = await getEWeLink();
        const newState = currentState ? 'off' : 'on';
        const targetOutlet = channelNumber - 1;

        console.log(`[eWeLink] switch ${switchId} outlet ${targetOutlet} -> ${newState}`);
        await connection.setDevicePowerState(switchId, newState, { outlet: targetOutlet });

        systemState[stateKey] = !currentState;
        broadcastState();
    } catch (err) {
        console.error('[eWeLink] channel toggle failed:', err.message);
    }
}

// --- Periodic sync from eWeLink (physical switches, other apps) ---
async function syncFromEWelink() {
    try {
        const connection = await getEWeLink();
        const devices = await connection.getDevices();
        if (!Array.isArray(devices)) return;

        for (const d of devices) {
            if (d.deviceid === switchId && d.params && d.params.switches) {
                const sw = d.params.switches;
                // Channel 1 = fan, 2 = lamp1, 3 = lamp2
                if (sw[0] && 'switch' in sw[0]) systemState.fan   = sw[0].switch === 'on';
                if (sw[1] && 'switch' in sw[1]) systemState.lamp1 = sw[1].switch === 'on';
                if (sw[2] && 'switch' in sw[2]) systemState.lamp2 = sw[2].switch === 'on';
            }
            if (d.deviceid === rgbDeviceId && d.params && d.params.switch) {
                systemState.rgbPower = d.params.switch === 'on';
            }
        }
    } catch (err) {
        // Silent — don't spam logs if Pi loses internet
    }
}

// --- REST endpoints ---
app.get('/api/state', (req, res) => res.json(systemState));

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        clients: wss.clients.size,
        uptime: process.uptime(),
        ewelink: ewelinkConn ? 'ready' : 'not-initialised',
        lockConfigured: lockDeviceId !== 'YOUR_LOCK_DEVICE_ID',
    });
});

app.get('/api/pi', (req, res) => {
    let tempC = null;
    try {
        tempC = (parseFloat(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000).toFixed(1);
    } catch { /* not a Pi or no permission */ }

    res.json({
        hostname: os.hostname(),
        uptime: os.uptime(),
        load: os.loadavg(),
        memFree: os.freemem(),
        memTotal: os.totalmem(),
        tempC,
    });
});

// --- WebSocket ---
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    console.log('[WS] client connected');
    sendTo(ws, { type: 'STATE_UPDATE', payload: systemState });

    ws.on('message', async (raw) => {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return sendTo(ws, { type: 'ERROR', message: 'invalid JSON' });
        }

        try {
            switch (parsed.action) {
                case 'TOGGLE_LAMP_1':
                    await handleChannelToggle(2, systemState.lamp1, 'lamp1');
                    break;

                case 'TOGGLE_LAMP_2':
                    await handleChannelToggle(3, systemState.lamp2, 'lamp2');
                    break;

                case 'TOGGLE_FAN':
                    await handleChannelToggle(1, systemState.fan, 'fan');
                    break;

                case 'TOGGLE_RGB': {
                    const connection = await getEWeLink();
                    systemState.rgbPower = !systemState.rgbPower;
                    await connection.setDevicePowerState(
                        rgbDeviceId,
                        systemState.rgbPower ? 'on' : 'off'
                    );
                    broadcastState();
                    break;
                }

                case 'SET_RGB_COLOR': {
                    if (!/^#[0-9a-fA-F]{6}$/.test(parsed.color || '')) {
                        return sendTo(ws, { type: 'ERROR', message: 'bad color' });
                    }
                    systemState.rgbColor = parsed.color;
                    systemState.rgbPower = true;

                    const r = parseInt(parsed.color.slice(1, 3), 16);
                    const g = parseInt(parsed.color.slice(3, 5), 16);
                    const b = parseInt(parsed.color.slice(5, 7), 16);

                    const connection = await getEWeLink();
                    await connection.setDevicePowerState(rgbDeviceId, 'on', {
                        outlet: 1,
                        zyx_mode: 2,
                        zyx_data: [r, g, b].join(','),
                    });
                    broadcastState();
                    break;
                }

                case 'TOGGLE_LOCK': {
                    if (lockDeviceId === 'YOUR_LOCK_DEVICE_ID') {
                        return sendTo(ws, {
                            type: 'ERROR',
                            message: 'Lock device not configured. Set LOCK_DEVICE_ID in .env',
                        });
                    }
                    const connection = await getEWeLink();
                    systemState.lock = !systemState.lock;
                    const lockState = systemState.lock ? 'unlock' : 'lock';
                    try {
                        await connection.setDevicePowerState(lockDeviceId, lockState);
                    } catch (err) {
                        console.log('[eWeLink] lock API error (state still updated):', err.message);
                    }
                    broadcastState();
                    break;
                }

                case 'ALL_OFF': {
                    try {
                        const connection = await getEWeLink();
                        await connection.setDevicePowerState(switchId, 'off');
                        await connection.setDevicePowerState(rgbDeviceId, 'off');
                    } catch (err) {
                        console.error('[eWeLink] ALL_OFF error:', err.message);
                    }
                    systemState.lamp1 = false;
                    systemState.lamp2 = false;
                    systemState.fan = false;
                    systemState.rgbPower = false;
                    broadcastState();
                    break;
                }

                case 'TRIGGER_MOTION':
                    systemState.motion = true;
                    broadcastState();
                    setTimeout(() => { systemState.motion = false; broadcastState(); }, 4000);
                    break;

                case 'TRIGGER_SMOKE':
                    systemState.smoke = true;
                    broadcastState();
                    setTimeout(() => { systemState.smoke = false; broadcastState(); }, 5000);
                    break;

                case 'TRIGGER_DOOR':
                    systemState.door = !systemState.door;
                    broadcastState();
                    break;

                case 'PING':
                    sendTo(ws, { type: 'PONG', t: Date.now() });
                    break;

                default:
                    sendTo(ws, { type: 'ERROR', message: `unknown action: ${parsed.action}` });
            }
        } catch (err) {
            console.error('[WS] action error:', err);
            sendTo(ws, { type: 'ERROR', message: err.message });
        }
    });

    ws.on('close', () => console.log('[WS] client disconnected'));
});

// --- Dead-client reaper ---
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// --- Periodic eWeLink sync ---
setInterval(syncFromEWelink, 15000);

// --- Startup ---
server.listen(PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces();
    const lanIp = Object.values(nets)
        .flat()
        .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;

    console.log('==============================================');
    console.log(`[Server] IoT Dashboard running`);
    console.log(`[Server] Local:   http://localhost:${PORT}`);
    if (lanIp) console.log(`[Server] Network: http://${lanIp}:${PORT}`);
    console.log(`[Server] Lock configured: ${lockDeviceId !== 'YOUR_LOCK_DEVICE_ID'}`);
    console.log('==============================================');
});

// --- Graceful shutdown ---
process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM, closing...');
    server.close(() => process.exit(0));
});
