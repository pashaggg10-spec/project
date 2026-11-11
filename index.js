require('dotenv').config();

const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const mqtt = require('mqtt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// --- MQTT config ---
const MQTT_HOST = '192.168.15.138'; // IP вашего Raspberry Pi
const MQTT_TOPIC_SONOFF = 'sonoff4ch'; // Топик вашего реле

// Топики для будущих устройств (пока не используются, но готовы)
const MQTT_TOPIC_RGB = 'rgb_strip'; 
const MQTT_TOPIC_LOCK = 'smart_lock';

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

// --- MQTT Connection ---
const mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:1883`);

mqttClient.on('connect', () => {
    console.log('[MQTT] Connected to broker at', MQTT_HOST);
    
    // Подписываемся на статусы реле (Sonoff 4CH)
    mqttClient.subscribe(`stat/${MQTT_TOPIC_SONOFF}/POWER1`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_SONOFF}/POWER2`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_SONOFF}/POWER3`);
    
    // Заготовки для будущих устройств (когда подключите их, они начнут слать сюда данные)
    mqttClient.subscribe(`stat/${MQTT_TOPIC_RGB}/POWER`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_RGB}/RESULT`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_LOCK}/POWER`);
});

mqttClient.on('message', (topic, message) => {
    const msg = message.toString();
    console.log(`[MQTT] Received: ${topic} -> ${msg}`);
    let changed = false;

    // Обработка Sonoff 4CH
    if (topic === `stat/${MQTT_TOPIC_SONOFF}/POWER1`) {
        systemState.fan = (msg === 'ON');
        changed = true;
    }
    if (topic === `stat/${MQTT_TOPIC_SONOFF}/POWER2`) {
        systemState.lamp1 = (msg === 'ON');
        changed = true;
    }
    if (topic === `stat/${MQTT_TOPIC_SONOFF}/POWER3`) {
        systemState.lamp2 = (msg === 'ON');
        changed = true;
    }

    // Обработка будущей RGB ленты (Tasmota шлет JSON в RESULT)
    if (topic === `stat/${MQTT_TOPIC_RGB}/POWER`) {
        systemState.rgbPower = (msg === 'ON');
        changed = true;
    }
    if (topic === `stat/${MQTT_TOPIC_RGB}/RESULT` && msg.includes('Color')) {
        try {
            const data = JSON.parse(msg);
            if (data.Color) {
                // Tasmota обычно возвращает цвет в формате "RRGGBB"
                systemState.rgbColor = '#' + data.Color;
                changed = true;
            }
        } catch(e) {}
    }

    // Обработка будущего замка
    if (topic === `stat/${MQTT_TOPIC_LOCK}/POWER`) {
        systemState.lock = (msg === 'ON'); // Предполагаем, что ON = Unlocked
        changed = true;
    }

    if (changed) broadcastState();
});

mqttClient.on('error', (err) => {
    console.error('[MQTT] Connection error:', err.message);
});

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

// --- Управление многоканальным реле через MQTT ---
function handleChannelToggle(channelNumber, currentState) {
    const topic = `cmnd/${MQTT_TOPIC_SONOFF}/POWER${channelNumber}`;
    const payload = currentState ? 'OFF' : 'ON';
    
    console.log(`[MQTT] Sending command: ${topic} -> ${payload}`);
    mqttClient.publish(topic, payload);
}

// --- REST endpoints ---
app.get('/api/state', (req, res) => res.json(systemState));

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        clients: wss.clients.size,
        uptime: process.uptime(),
        mqtt: mqttClient.connected ? 'connected' : 'disconnected',
    });
});

app.get('/api/pi', (req, res) => {
    let tempC = null;
    try {
        tempC = (parseFloat(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000).toFixed(1);
    } catch { }

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
                    handleChannelToggle(2, systemState.lamp1);
                    break;

                case 'TOGGLE_LAMP_2':
                    handleChannelToggle(3, systemState.lamp2);
                    break;

                case 'TOGGLE_FAN':
                    handleChannelToggle(1, systemState.fan);
                    break;

                case 'TOGGLE_RGB': {
                    // Заглушка для будущей RGB ленты на MQTT
                    const newState = systemState.rgbPower ? 'OFF' : 'ON';
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_RGB}/POWER`, newState);
                    break;
                }

                case 'SET_RGB_COLOR': {
                    // Заглушка для будущей RGB ленты
                    if (!/^#[0-9a-fA-F]{6}$/.test(parsed.color || '')) {
                        return sendTo(ws, { type: 'ERROR', message: 'bad color' });
                    }
                    // Tasmota ожидает цвет в HEX без решетки, например "FF0000"
                    const hexColor = parsed.color.replace('#', '').toUpperCase();
                    
                    // В Tasmota для RGB лент команда Color отправляется в топик cmnd/.../Color
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_RGB}/Color`, hexColor);
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_RGB}/POWER`, 'ON');
                    break;
                }

                case 'TOGGLE_LOCK': {
                    // Заглушка для будущего замка на MQTT
                    const lockState = systemState.lock ? 'OFF' : 'ON';
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_LOCK}/POWER`, lockState);
                    break;
                }

                case 'ALL_OFF': {
                    // Выключаем всё через MQTT
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_SONOFF}/POWER1`, 'OFF');
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_SONOFF}/POWER2`, 'OFF');
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_SONOFF}/POWER3`, 'OFF');
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_RGB}/POWER`, 'OFF');
                    
                    // Принудительно обновляем UI (на случай если устройства оффлайн)
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

// --- Startup ---
server.listen(PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces();
    const lanIp = Object.values(nets)
        .flat()
        .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;

    console.log('==============================================');
    console.log(`[Server] IoT Dashboard running (MQTT ONLY)`);
    console.log(`[Server] Local:   http://localhost:${PORT}`);
    if (lanIp) console.log(`[Server] Network: http://${lanIp}:${PORT}`);
    console.log('==============================================');
});

// --- Graceful shutdown ---
process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM, closing...');
    server.close(() => process.exit(0));
});
