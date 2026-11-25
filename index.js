require('dotenv').config();

const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const mqtt = require('mqtt');
// Добавляем библиотеку для работы с eWeLink
const ewelink = require('ewelink-api');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// --- Конфигурация MQTT (для локальных устройств) ---
const MQTT_HOST = '192.168.15.138';
const MQTT_TOPIC_SONOFF = 'sonoff4ch';
const MQTT_TOPIC_RGB = 'rgb_strip';
const MQTT_TOPIC_LOCK = 'smart_lock';

// --- Конфигурация eWeLink (для облачных устройств, таких как DW2-WIFI) ---
// Данные берутся из файла static.env или .env
const EWELINK_EMAIL = process.env.EWELINK_EMAIL || 'dreamteam.iot@mail.com';
const EWELINK_PASSWORD = process.env.EWELINK_PASSWORD || 'edtr61iot';
const EWELINK_REGION = process.env.EWELINK_REGION || 'eu';

// Создаем экземпляр подключения к eWeLink
const ewelinkConnection = new ewelink({
    email: EWELINK_EMAIL,
    password: EWELINK_PASSWORD,
    region: EWELINK_REGION,
});

// --- Express middleware ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Состояние системы ---
const systemState = {
    temperature: 24.5,
    motion: false,
    smoke: false,
    door: false, // Это состояние будет обновляться от датчика DW2-WIFI
    lock: false,
    battery: 85, // Заряд батареи датчика двери можно также обновлять из eWeLink
    lamp1: false,
    lamp2: false,
    fan: false,
    rgbPower: false,
    rgbColor: '#ff0000',
    haBridgeStatus: 'Ready',
    lastUpdate: Date.now(),
};

// --- MQTT соединение ---
const mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:1883`);

mqttClient.on('connect', () => {
    console.log('[MQTT] Подключено к брокеру по адресу', MQTT_HOST);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_SONOFF}/POWER1`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_SONOFF}/POWER2`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_SONOFF}/POWER3`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_RGB}/POWER`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_RGB}/RESULT`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_LOCK}/POWER`);
});

mqttClient.on('message', (topic, message) => {
    const msg = message.toString();
    console.log(`[MQTT] Получено: ${topic} -> ${msg}`);
    let changed = false;

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
    if (topic === `stat/${MQTT_TOPIC_RGB}/POWER`) {
        systemState.rgbPower = (msg === 'ON');
        changed = true;
    }
    if (topic === `stat/${MQTT_TOPIC_RGB}/RESULT` && msg.includes('Color')) {
        try {
            const data = JSON.parse(msg);
            if (data.Color) {
                systemState.rgbColor = '#' + data.Color;
                changed = true;
            }
        } catch(e) {}
    }
    if (topic === `stat/${MQTT_TOPIC_LOCK}/POWER`) {
        systemState.lock = (msg === 'ON');
        changed = true;
    }

    if (changed) broadcastState();
});

mqttClient.on('error', (err) => {
    console.error('[MQTT] Ошибка подключения:', err.message);
});

// --- Интеграция с eWeLink (WebSocket) ---
async function initEwelink() {
    try {
        console.log('[eWeLink] Вход в аккаунт...');
        await ewelinkConnection.login();
        console.log('[eWeLink] Успешный вход. Открытие WebSocket...');

        // Открываем WebSocket для получения событий в реальном времени
        await ewelinkConnection.openWebSocket(async (data) => {
            // data - это сообщение от eWeLink
            if (data && data.action === 'update' && data.params) {
                const params = data.params;
                let changed = false;

                // Проверяем, относится ли обновление к датчику двери.
                // Параметр может называться 'door', 'contact' или 'switch' в зависимости от модели.
                // Для DW2-WIFI обычно используется 'door' или 'contact'.
                if (params.door !== undefined) {
                    systemState.door = (params.door === 1 || params.door === 'on' || params.door === true);
                    changed = true;
                } else if (params.contact !== undefined) {
                    systemState.door = (params.contact === 1 || params.contact === 'on' || params.contact === true);
                    changed = true;
                } else if (params.switch !== undefined) {
                    // На случай, если датчик представляет себя как переключатель
                    systemState.door = (params.switch === 'on');
                    changed = true;
                }

                // Обновление заряда батареи (если eWeLink присылает эту информацию)
                if (params.battery !== undefined) {
                    systemState.battery = params.battery;
                    changed = true;
                }

                if (changed) {
                    console.log('[eWeLink] Обновление от датчика:', params);
                    broadcastState();
                }
            }
        });

        console.log('[eWeLink] WebSocket подключен. Ожидание событий...');
    } catch (error) {
        console.error('[eWeLink] Ошибка инициализации:', error.message);
        // Попытка переподключения через 30 секунд
        setTimeout(initEwelink, 30000);
    }
}

// --- Вспомогательные функции ---
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

// --- Управление MQTT (без изменений) ---
function handleChannelToggle(channelNumber, currentState) {
    const topic = `cmnd/${MQTT_TOPIC_SONOFF}/POWER${channelNumber}`;
    const payload = currentState ? 'OFF' : 'ON';
    console.log(`[MQTT] Отправка команды: ${topic} -> ${payload}`);
    mqttClient.publish(topic, payload);
}

// --- REST endpoints (без изменений) ---
app.get('/api/state', (req, res) => res.json(systemState));
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        clients: wss.clients.size,
        uptime: process.uptime(),
        mqtt: mqttClient.connected ? 'connected' : 'disconnected',
        ewelink: ewelinkConnection.isOpen ? 'connected' : 'disconnected',
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

// --- WebSocket сервер (без изменений в обработке команд) ---
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    console.log('[WS] клиент подключен');
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
                    const newState = systemState.rgbPower ? 'OFF' : 'ON';
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_RGB}/POWER`, newState);
                    break;
                }
                case 'SET_RGB_COLOR': {
                    if (!/^#[0-9a-fA-F]{6}$/.test(parsed.color || '')) {
                        return sendTo(ws, { type: 'ERROR', message: 'bad color' });
                    }
                    const hexColor = parsed.color.replace('#', '').toUpperCase();
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_RGB}/Color`, hexColor);
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_RGB}/POWER`, 'ON');
                    break;
                }
                case 'TOGGLE_LOCK': {
                    const lockState = systemState.lock ? 'OFF' : 'ON';
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_LOCK}/POWER`, lockState);
                    break;
                }
                case 'ALL_OFF': {
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_SONOFF}/POWER1`, 'OFF');
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_SONOFF}/POWER2`, 'OFF');
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_SONOFF}/POWER3`, 'OFF');
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_RGB}/POWER`, 'OFF');
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
                // Симуляция двери больше не нужна, если датчик реальный.
                // Но можно оставить для тестов.
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
            console.error('[WS] ошибка действия:', err);
            sendTo(ws, { type: 'ERROR', message: err.message });
        }
    });

    ws.on('close', () => console.log('[WS] клиент отключен'));
});

// --- Reaper для мертвых клиентов (без изменений) ---
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// --- Запуск сервера ---
server.listen(PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces();
    const lanIp = Object.values(nets)
        .flat()
        .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;

    console.log('==============================================');
    console.log(`[Server] IoT Dashboard (MQTT + eWeLink) запущен`);
    console.log(`[Server] Local:   http://localhost:${PORT}`);
    if (lanIp) console.log(`[Server] Network: http://${lanIp}:${PORT}`);
    console.log('==============================================');

    // Инициализация eWeLink после запуска сервера
    initEwelink();
});

// --- Корректное завершение ---
process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM, завершение работы...');
    server.close(() => process.exit(0));
});
