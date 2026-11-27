import 'dotenv/config';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import mqtt from 'mqtt';
import eWeLink from 'ewelink-api-next';

// Получаем __dirname для ES-модулей
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// --- Конфигурация MQTT ---
const MQTT_HOST = '192.168.15.138';
const MQTT_TOPIC_SONOFF = 'sonoff4ch';
const MQTT_TOPIC_RGB = 'rgb_strip';
const MQTT_TOPIC_LOCK = 'smart_lock';

// --- Конфигурация eWeLink (НОВЫЕ КЛЮЧИ) ---
const EWELINK_APP_ID = process.env.EWELINK_APP_ID || 'ВАШ_APP_ID';
const EWELINK_APP_SECRET = process.env.EWELINK_APP_SECRET || 'ВАШ_APP_SECRET';
const EWELINK_REGION = process.env.EWELINK_REGION || 'eu';
const EWELINK_ACCOUNT = process.env.EWELINK_EMAIL; // Email от аккаунта eWeLink
const EWELINK_PASSWORD = process.env.EWELINK_PASSWORD; // Пароль от аккаунта eWeLink
const EWELINK_AREA_CODE = process.env.EWELINK_AREA_CODE || '+7'; // Ваш код страны

// Создаем экземпляр клиента eWeLink
const ewelinkClient = new eWeLink.WebAPI({
    appId: EWELINK_APP_ID,
    appSecret: EWELINK_APP_SECRET,
    region: EWELINK_REGION,
    logObj: eWeLink.createLogger('eu') // Логирование для отладки
});

// --- Express middleware ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Состояние системы ---
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

// --- Интеграция с eWeLink через WebSocket ---
async function initEwelink() {
    try {
        console.log('[eWeLink] Попытка входа в аккаунт...');
        // Авторизация с использованием email и пароля
        const loginResponse = await ewelinkClient.user.login({
            account: EWELINK_ACCOUNT,
            password: EWELINK_PASSWORD,
            areaCode: EWELINK_AREA_CODE
        });

        if (loginResponse.error !== 0) {
            throw new Error(`Ошибка входа: ${JSON.stringify(loginResponse)}`);
        }
        console.log('[eWeLink] Успешный вход. Пользователь:', loginResponse.data.user.email);

        // Создаем WebSocket-клиент для получения событий
        const wsClient = new eWeLink.Ws({
            appId: EWELINK_APP_ID,
            appSecret: EWELINK_APP_SECRET,
            region: EWELINK_REGION
        });

        // Подключаемся к WebSocket
        const ws = await wsClient.Connect.create({
            appId: wsClient.appId,
            at: wsClient.at,
            region: EWELINK_REGION,
            userApiKey: wsClient.userApiKey
        });

        console.log('[eWeLink] WebSocket подключен. Ожидание событий...');

        // Обработка входящих сообщений
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            // Ищем обновления, связанные с датчиками
            if (msg.action === 'update' && msg.params) {
                const params = msg.params;
                let changed = false;

                // Проверяем параметры, характерные для датчика двери (DW2-WIFI)
                if (params.door !== undefined) {
                    systemState.door = (params.door === 1 || params.door === 'on' || params.door === true);
                    changed = true;
                } else if (params.contact !== undefined) {
                    systemState.door = (params.contact === 1 || params.contact === 'on' || params.contact === true);
                    changed = true;
                } else if (params.switch !== undefined) {
                    systemState.door = (params.switch === 'on');
                    changed = true;
                }

                // Обновляем заряд батареи, если он пришел
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

    } catch (error) {
        console.error('[eWeLink] Ошибка инициализации:', error.message);
        // Повторная попытка через 30 секунд
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

function handleChannelToggle(channelNumber, currentState) {
    const topic = `cmnd/${MQTT_TOPIC_SONOFF}/POWER${channelNumber}`;
    const payload = currentState ? 'OFF' : 'ON';
    console.log(`[MQTT] Отправка команды: ${topic} -> ${payload}`);
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

// --- WebSocket сервер ---
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

// --- Reaper для мертвых клиентов ---
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
