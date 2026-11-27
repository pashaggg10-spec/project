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
import gpiox from '@iiot2k/gpiox';

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

// --- Конфигурация eWeLink (ПРАВИЛЬНЫЕ КЛЮЧИ С САЙТА) ---
const EWELINK_APP_ID = process.env.EWELINK_APP_ID || 'Kh6th5xrkBgAgI5Jj17TBn9R3WjAE7CF';
const EWELINK_APP_SECRET = process.env.EWELINK_APP_SECRET || '7brXbp7Vi3AcxOIUQjB4gdITbinOjbId';
const EWELINK_REGION = process.env.EWELINK_REGION || 'eu';

// URL для перенаправления после входа (должен быть прописан в настройках приложения на dev.ewelink.cc)
const EWELINK_REDIRECT_URL = `http://192.168.15.138:${PORT}/oauth/callback`;

// --- Конфигурация GPIO ---
const PIN_MOTION = 17; 
const PIN_LIGHT = 27;  
const GPIO_CHIP = 512; // Используем чип 512 (как на вашем скриншоте)

const ewelinkClient = new eWeLink.WebAPI({
    appId: EWELINK_APP_ID,
    appSecret: EWELINK_APP_SECRET,
    region: EWELINK_REGION,
    logObj: eWeLink.createLogger('eu')
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Состояние системы ---
const systemState = {
    temperature: 24.5,
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
    console.log('[GPIO] Инициализация датчиков...');
    const mode = gpiox.GPIO_MODE_INPUT_PULLDOWN;
    const edge = gpiox.GPIO_EDGE_BOTH;

    // Инициализация датчика движения (пин 17)
    if (!gpiox.init_gpio(PIN_MOTION, mode, GPIO_CHIP)) {
        console.error(`[GPIO] Ошибка инициализации пина ${PIN_MOTION}: ${gpiox.error_text()}`);
    } else {
        gpiox.watch_gpio(PIN_MOTION, mode, GPIO_CHIP, edge, (state) => {
            const isMotion = (state === 1);
            if (systemState.motion !== isMotion) {
                systemState.motion = isMotion;
                console.log(`[GPIO] Датчик движения: ${isMotion ? 'ДВИЖЕНИЕ' : 'ПОКОЙ'}`);
                broadcastState();
            }
        });
    }

    // Инициализация датчика света (пин 27)
    if (!gpiox.init_gpio(PIN_LIGHT, mode, GPIO_CHIP)) {
        console.error(`[GPIO] Ошибка инициализации пина ${PIN_LIGHT}: ${gpiox.error_text()}`);
    } else {
        gpiox.watch_gpio(PIN_LIGHT, mode, GPIO_CHIP, edge, (state) => {
            const isLight = (state === 1);
            if (systemState.light !== isLight) {
                systemState.light = isLight;
                console.log(`[GPIO] Датчик света: ${isLight ? 'СВЕТЛО' : 'ТЕМНО'}`);
                broadcastState();
            }
        });
    }
}

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

mqttClient.on('error', (err) => {
    console.error('[MQTT] Ошибка подключения:', err.message);
});

// --- Интеграция с eWeLink (Автоматический OAuth 2.0) ---
async function initEwelink() {
    try {
        console.log('[eWeLink] Генерация ссылки для входа...');
        const loginUrl = await ewelinkClient.oauth.createLoginUrl({
            redirectUrl: EWELINK_REDIRECT_URL,
            state: 'iot-dashboard-auth'
        });
        
        console.log('\n=============================================================');
        console.log('⚠️ ВНИМАНИЕ! ТРЕБУЕТСЯ АВТОРИЗАЦИЯ eWeLink');
        console.log('Откройте эту ссылку в браузере:');
        console.log('\n' + loginUrl + '\n');
        console.log('После входа сервер автоматически получит токен.');
        console.log('=============================================================\n');

    } catch (error) {
        console.error('[eWeLink] Ошибка генерации ссылки:', error.message);
    }
}

// Перехватываем редирект от eWeLink после успешного входа
app.get('/oauth/callback', async (req, res) => {
    const { code } = req.query;
    
    if (!code) {
        return res.send('Ошибка: код авторизации не получен.');
    }

    try {
        console.log('[eWeLink] Получен код авторизации! Обмен на токен...');
        const tokenResponse = await ewelinkClient.oauth.requestToken({
            code: code,
            redirectUrl: EWELINK_REDIRECT_URL
        });

        if (tokenResponse.error !== 0) {
            throw new Error(JSON.stringify(tokenResponse));
        }

        console.log('[eWeLink] Успешный вход! Настройка WebSocket...');
        
        const wsClient = new eWeLink.Ws({
            appId: EWELINK_APP_ID,
            appSecret: EWELINK_APP_SECRET,
            region: EWELINK_REGION
        });

        const ws = await wsClient.Connect.create({
            appId: wsClient.appId,
            at: wsClient.at,
            region: EWELINK_REGION,
            userApiKey: wsClient.userApiKey
        });

        console.log('[eWeLink] WebSocket подключен. Ожидание событий...');

        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.action === 'update' && msg.params) {
                const params = msg.params;
                let changed = false;

                if (params.door !== undefined) { systemState.door = (params.door === 1 || params.door === 'on'); changed = true; }
                else if (params.contact !== undefined) { systemState.door = (params.contact === 1 || params.contact === 'on'); changed = true; }
                else if (params.switch !== undefined) { systemState.door = (params.switch === 'on'); changed = true; }

                if (params.battery !== undefined) { systemState.battery = params.battery; changed = true; }

                if (changed) {
                    console.log('[eWeLink] Обновление от датчика:', params);
                    broadcastState();
                }
            }
        });

        res.send('<h1>Успешно!</h1><p>Авторизация eWeLink завершена. Можете закрыть эту вкладку и вернуться в дашборд.</p>');

    } catch (error) {
        console.error('[eWeLink] Ошибка при получении токена:', error.message);
        res.status(500).send('<h1>Ошибка авторизации</h1><p>Проверьте консоль сервера (терминал).</p>');
    }
});

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
    console.log(`[Server] IoT Dashboard (MQTT + eWeLink + GPIO) запущен`);
    console.log(`[Server] Local:   http://localhost:${PORT}`);
    if (lanIp) console.log(`[Server] Network: http://${lanIp}:${PORT}`);
    console.log('==============================================');

    initGpio();
    initEwelink();
});

// --- Очистка пинов при выключении ---
function cleanupGpio() {
    console.log('[Server] Очистка GPIO...');
    try {
        gpiox.deinit_gpio(PIN_MOTION);
        gpiox.deinit_gpio(PIN_LIGHT);
        console.log('[GPIO] Пины освобождены.');
    } catch (e) {}
}

process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM, завершение работы...');
    cleanupGpio();
    server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('[Server] SIGINT, завершение работы...');
    cleanupGpio();
    process.exit(0);
});
