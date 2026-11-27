import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import mqtt from 'mqtt';
import eWeLink from 'ewelink-api-next';
import { Gpio } from 'pigpio';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const EWELINK_APP_ID = process.env.EWELINK_APP_ID || 'Kh6th5xrkBgAgI5Jj17TBn9R3WjAE7CF';
const EWELINK_APP_SECRET = process.env.EWELINK_APP_SECRET || '7brXbp7Vi3AcxOIUQjB4gdITbinOjbId';
const EWELINK_REGION = process.env.EWELINK_REGION || 'eu';
const EWELINK_REDIRECT_URL = `http://localhost:${PORT}/oauth/callback`;

// --- Конфигурация GPIO ---
const PIN_MOTION = 17; 
const PIN_LIGHT = 27;  

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

// --- Инициализация GPIO (через pigpio) ---
function initGpio() {
    console.log('[GPIO] Инициализация датчиков через pigpio (alert-метод)...');

    try {
        // Настраиваем пин движения как вход с подтяжкой к земле
        const motionSensor = new Gpio(PIN_MOTION, {
            mode: Gpio.INPUT,
            pullUpDown: Gpio.PUD_DOWN
        });

        // Используем метод 'alert' вместо 'interrupt'
        motionSensor.on('alert', (level) => {
            systemState.motion = (level === 1);
            console.log(`[GPIO] Датчик движения: ${systemState.motion ? 'ДВИЖЕНИЕ' : 'ПОКОЙ'}`);
            broadcastState();
        });

        // Настраиваем пин света аналогичным образом
        const lightSensor = new Gpio(PIN_LIGHT, {
            mode: Gpio.INPUT,
            pullUpDown: Gpio.PUD_DOWN
        });

        lightSensor.on('alert', (level) => {
            systemState.light = (level === 1);
            console.log(`[GPIO] Датчик света: ${systemState.light ? 'СВЕТЛО' : 'ТЕМНО'}`);
            broadcastState();
        });

        console.log('[GPIO] Датчики успешно инициализированы (alert)!');
    } catch (err) {
        console.error('[GPIO] Критическая ошибка инициализации:', err.message);
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

// --- Авторизация eWeLink через OAuth 2.0 ---
async function generateLoginUrl() {
    try {
        console.log('\n=============================================================');
        console.log('⚠️ ТРЕБУЕТСЯ АВТОРИЗАЦИЯ eWeLink');
        console.log('Скопируйте и откройте эту ссылку в браузере на Raspberry Pi:');
        
        const loginUrl = await ewelinkClient.oauth.createLoginUrl({
            redirectUrl: EWELINK_REDIRECT_URL,
            grantType: 'authorization_code',
            state: 'iot-dashboard-auth'
        });
        
        console.log('\n' + loginUrl + '\n');
        console.log('После входа сервер автоматически получит токен.');
        console.log('=============================================================\n');
    } catch (error) {
        console.error('[eWeLink] Ошибка генерации ссылки:', error.message);
    }
}

app.get('/oauth/callback', async (req, res) => {
    const { code } = req.query;
    
    if (!code) {
        return res.status(400).send('Ошибка: код авторизации не получен.');
    }

    try {
        console.log('[eWeLink] Получен код авторизации! Обмен на токен...');
        
        const body = {
            clientId: EWELINK_APP_ID,
            clientSecret: EWELINK_APP_SECRET,
            grantType: 'authorization_code',
            code: code,
            redirectUrl: EWELINK_REDIRECT_URL
        };
        const bodyString = JSON.stringify(body);
        const sign = crypto
            .createHmac('sha256', EWELINK_APP_SECRET)
            .update(bodyString)
            .digest('base64');
        
        const response = await fetch('https://eu-apia.coolkit.cc/v2/user/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Sign ${sign}`
            },
            body: bodyString
        });

        const responseText = await response.text();
        let tokenData;
        try {
            tokenData = JSON.parse(responseText);
        } catch (e) {
            throw new Error(`Сервер eWeLink вернул не JSON: ${responseText.substring(0, 200)}...`);
        }

        if (tokenData.error !== 0) {
            throw new Error(`Ошибка API eWeLink: ${JSON.stringify(tokenData)}`);
        }
        
        console.log('[eWeLink] Успешный вход! Токен получен.');
        
        await connectEwelinkWebSocket(tokenData.data);

        res.send('<h1>Успешно!</h1><p>Авторизация eWeLink завершена. Можете закрыть эту вкладку и вернуться в дашборд.</p>');

    } catch (error) {
        console.error('[eWeLink] Ошибка при получении токена:', error.message);
        res.status(500).send('<h1>Ошибка авторизации</h1><p>Проверьте консоль сервера (терминал).</p>');
    }
});

async function connectEwelinkWebSocket(tokenData) {
    const wsClient = new eWeLink.Ws({
        appId: EWELINK_APP_ID,
        appSecret: EWELINK_APP_SECRET,
        region: EWELINK_REGION
    });

    const ws = await wsClient.Connect.create({
        appId: EWELINK_APP_ID,
        at: tokenData.at,
        region: EWELINK_REGION,
        userApiKey: tokenData.user?.apikey || tokenData.userApiKey || ''
    });

    console.log('[eWeLink] WebSocket подключен. Ожидание событий...');

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.action === 'update' && msg.params) {
            const params = msg.params;
            let changed = false;

            if (params.door !== undefined) { systemState.door = (params.door === 1 || params.door === 'on'); changed = true; }
            else if (params.contact !== undefined) { systemState.door = (params.contact === 1 || params.contact === 'on'); changed = true; }

            if (params.temperature !== undefined) { systemState.temperature = params.temperature; changed = true; }
            else if (params.currentTemperature !== undefined) { systemState.temperature = params.currentTemperature; changed = true; }

            if (params.battery !== undefined) { systemState.battery = params.battery; changed = true; }

            if (changed) {
                console.log('[eWeLink] Обновление:', params);
                broadcastState();
            }
        }
    });
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

app.get('/api/state', (req, res) => res.json(systemState));
app.get('/api/pi', (req, res) => {
    let tempC = null;
    try { tempC = (parseFloat(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000).toFixed(1); } catch { }
    res.json({ tempC, uptime: os.uptime(), memFree: os.freemem(), memTotal: os.totalmem() });
});

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

setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] IoT Dashboard запущен. Локально: http://localhost:${PORT}`);
    initGpio();
    generateLoginUrl(); 
});

// --- Очистка ---
function cleanupGpio() {
    try {
        const motionSensor = new Gpio(PIN_MOTION, { mode: Gpio.INPUT });
        const lightSensor = new Gpio(PIN_LIGHT, { mode: Gpio.INPUT });
        motionSensor.disableAlert();
        lightSensor.disableAlert();
        console.log('[GPIO] Пины освобождены.');
    } catch (e) {}
}

process.on('SIGTERM', () => { cleanupGpio(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { cleanupGpio(); process.exit(0); });
