import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import mqtt from 'mqtt';
import eWeLink from 'ewelink-api-next';
import gpiox from '@iiot2k/gpiox';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === ИСПРАВЛЕНИЕ 1: Явно указываем файл static.env ===
dotenv.config({ path: path.resolve(__dirname, 'static.env') });

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// --- Конфигурация MQTT ---
const MQTT_HOST = '192.168.15.138';
const MQTT_TOPIC_SONOFF = 'sonoff4ch';
const MQTT_TOPIC_RGB = 'rgb_strip';
const MQTT_TOPIC_LOCK = 'smart_lock';

// --- Конфигурация eWeLink ---
const EWELINK_APP_ID = 'Kh6th5xrkBgAgI5Jj17TBn9R3WjAE7CF';
const EWELINK_APP_SECRET = '7brXbp7Vi3AcxOIUQjB4gdITbinOjbId';

// Теперь эти переменные точно загрузятся из static.env
const EWELINK_EMAIL = process.env.EWELINK_EMAIL;
const EWELINK_PASSWORD = process.env.EWELINK_PASSWORD;
const EWELINK_REGION = process.env.EWELINK_REGION || 'eu';
const EWELINK_AREA_CODE = process.env.EWELINK_AREA_CODE || '+372';

// Выводим для проверки, что данные загрузились
console.log('[ENV CHECK] Email:', EWELINK_EMAIL);
console.log('[ENV CHECK] AreaCode:', EWELINK_AREA_CODE);

// --- Конфигурация GPIO ---
const PIN_MOTION = 17; 
const PIN_LIGHT = 27;  
// На Pi 4 (64-bit) часто используется чип 512 или 4. 
// Если снова будет chip error, попробуйте поменять на 4 или 0.
const GPIO_CHIP = 512; 

const ewelinkClient = new eWeLink.WebAPI({
    appId: EWELINK_APP_ID,
    appSecret: EWELINK_APP_SECRET,
    region: EWELINK_REGION,
    logObj: eWeLink.createLogger(EWELINK_REGION)
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Состояние системы ---
const systemState = {
    temperature: '--', 
    motion: false,     
    light: false,      
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

// --- Инициализация GPIO ---
function initGpio() {
    console.log(`[GPIO] Инициализация на чипе ${GPIO_CHIP}...`);
    const mode = gpiox.GPIO_MODE_INPUT_PULLDOWN;
    const edge = gpiox.GPIO_EDGE_BOTH;

    if (!gpiox.init_gpio(PIN_MOTION, mode, GPIO_CHIP)) {
        console.error(`[GPIO] Ошибка инициализации пина ${PIN_MOTION}: ${gpiox.error_text()}`);
    } else {
        gpiox.watch_gpio(PIN_MOTION, mode, GPIO_CHIP, edge, (state) => {
            systemState.motion = (state === 1);
            console.log(`[GPIO] Движение: ${systemState.motion ? 'ЕСТЬ' : 'НЕТ'}`);
            broadcastState();
        });
    }

    if (!gpiox.init_gpio(PIN_LIGHT, mode, GPIO_CHIP)) {
        console.error(`[GPIO] Ошибка инициализации пина ${PIN_LIGHT}: ${gpiox.error_text()}`);
    } else {
        gpiox.watch_gpio(PIN_LIGHT, mode, GPIO_CHIP, edge, (state) => {
            systemState.light = (state === 1);
            console.log(`[GPIO] Свет: ${systemState.light ? 'СВЕТЛО' : 'ТЕМНО'}`);
            broadcastState();
        });
    }
}

// --- MQTT соединение ---
const mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:1883`);

mqttClient.on('connect', () => {
    console.log('[MQTT] Подключено к брокеру', MQTT_HOST);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_SONOFF}/POWER1`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_SONOFF}/POWER2`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_SONOFF}/POWER3`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_RGB}/POWER`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_RGB}/RESULT`);
    mqttClient.subscribe(`stat/${MQTT_TOPIC_LOCK}/POWER`);
});

mqttClient.on('message', (topic, message) => {
    const msg = message.toString();
    let changed = false;

    if (topic === `stat/${MQTT_TOPIC_SONOFF}/POWER1`) { systemState.fan = (msg === 'ON'); changed = true; }
    if (topic === `stat/${MQTT_TOPIC_SONOFF}/POWER2`) { systemState.lamp1 = (msg === 'ON'); changed = true; }
    if (topic === `stat/${MQTT_TOPIC_SONOFF}/POWER3`) { systemState.lamp2 = (msg === 'ON'); changed = true; }
    if (topic === `stat/${MQTT_TOPIC_RGB}/POWER`) { systemState.rgbPower = (msg === 'ON'); changed = true; }
    if (topic === `stat/${MQTT_TOPIC_LOCK}/POWER`) { systemState.lock = (msg === 'ON'); changed = true; }
    
    if (topic === `stat/${MQTT_TOPIC_RGB}/RESULT` && msg.includes('Color')) {
        try {
            const data = JSON.parse(msg);
            if (data.Color) { systemState.rgbColor = '#' + data.Color; changed = true; }
        } catch(e) {}
    }

    if (changed) broadcastState();
});

mqttClient.on('error', (err) => console.error('[MQTT] Ошибка:', err.message));

// --- Интеграция с eWeLink ---
async function initEwelink() {
    try {
        if (!EWELINK_EMAIL || !EWELINK_PASSWORD) {
            throw new Error('Email или пароль не загрузились из static.env!');
        }

        console.log('[eWeLink] Попытка входа по Email...');
        const loginResponse = await ewelinkClient.user.login({
            account: EWELINK_EMAIL,
            password: EWELINK_PASSWORD,
            areaCode: EWELINK_AREA_CODE
        });

        if (loginResponse.error !== 0) {
            throw new Error(`Ошибка входа: ${JSON.stringify(loginResponse)}`);
        }
        console.log('[eWeLink] Успешный вход. Пользователь:', loginResponse.data.user.email);

        const wsClient = new eWeLink.Ws({
            region: EWELINK_REGION
        });
        
        const ws = await wsClient.Connect.create({
            appId: EWELINK_APP_ID,
            at: loginResponse.data.at,
            region: EWELINK_REGION,
            userApiKey: loginResponse.data.userApiKey
        });

        console.log('[eWeLink] WebSocket подключен. Ожидание событий...');

        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.action === 'update' && msg.params) {
                const params = msg.params;
                let changed = false;

                if (params.door !== undefined) {
                    systemState.door = (params.door === 1 || params.door === 'on');
                    changed = true;
                } else if (params.contact !== undefined) {
                    systemState.door = (params.contact === 1 || params.contact === 'on');
                    changed = true;
                }

                if (params.temperature !== undefined) {
                    systemState.temperature = params.temperature;
                    changed = true;
                } else if (params.currentTemperature !== undefined) {
                    systemState.temperature = params.currentTemperature;
                    changed = true;
                }

                if (params.battery !== undefined) {
                    systemState.battery = params.battery;
                    changed = true;
                }

                if (changed) {
                    console.log('[eWeLink] Обновление:', params);
                    broadcastState();
                }
            }
        });

    } catch (error) {
        console.error('[eWeLink] Ошибка инициализации:', error.message);
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
    mqttClient.publish(topic, payload);
}

// --- REST endpoints ---
app.get('/api/state', (req, res) => res.json(systemState));
app.get('/api/pi', (req, res) => {
    let tempC = null;
    try { tempC = (parseFloat(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000).toFixed(1); } catch { }
    res.json({ tempC, uptime: os.uptime(), memFree: os.freemem(), memTotal: os.totalmem() });
});

// --- WebSocket сервер ---
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    sendTo(ws, { type: 'STATE_UPDATE', payload: systemState });

    ws.on('message', async (raw) => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return sendTo(ws, { type: 'ERROR', message: 'invalid JSON' }); }

        try {
            switch (parsed.action) {
                case 'TOGGLE_LAMP_1': handleChannelToggle(2, systemState.lamp1); break;
                case 'TOGGLE_LAMP_2': handleChannelToggle(3, systemState.lamp2); break;
                case 'TOGGLE_FAN': handleChannelToggle(1, systemState.fan); break;
                case 'TOGGLE_RGB': mqttClient.publish(`cmnd/${MQTT_TOPIC_RGB}/POWER`, systemState.rgbPower ? 'OFF' : 'ON'); break;
                case 'SET_RGB_COLOR': 
                    const hexColor = parsed.color.replace('#', '').toUpperCase();
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_RGB}/Color`, hexColor);
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_RGB}/POWER`, 'ON');
                    break;
                case 'TOGGLE_LOCK': mqttClient.publish(`cmnd/${MQTT_TOPIC_LOCK}/POWER`, systemState.lock ? 'OFF' : 'ON'); break;
                case 'ALL_OFF': 
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_SONOFF}/POWER1`, 'OFF');
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_SONOFF}/POWER2`, 'OFF');
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_SONOFF}/POWER3`, 'OFF');
                    mqttClient.publish(`cmnd/${MQTT_TOPIC_RGB}/POWER`, 'OFF');
                    systemState.lamp1 = systemState.lamp2 = systemState.fan = systemState.rgbPower = false;
                    broadcastState();
                    break;
                case 'TRIGGER_SMOKE': 
                    systemState.smoke = true;
                    broadcastState();
                    setTimeout(() => { systemState.smoke = false; broadcastState(); }, 5000);
                    break;
                case 'PING': sendTo(ws, { type: 'PONG', t: Date.now() }); break;
            }
        } catch (err) {
            sendTo(ws, { type: 'ERROR', message: err.message });
        }
    });
});

// --- Reaper ---
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// --- Запуск ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] IoT Dashboard запущен. Локально: http://localhost:${PORT}`);
    initGpio();
    initEwelink();
});

// --- Очистка ---
function cleanupGpio() {
    try {
        gpiox.deinit_gpio(PIN_MOTION);
        gpiox.deinit_gpio(PIN_LIGHT);
    } catch (e) {}
}

process.on('SIGTERM', () => { cleanupGpio(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { cleanupGpio(); process.exit(0); });
