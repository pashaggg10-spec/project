const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const ewelink = require('ewelink-api');

// Инициализация приложения Express и сервера
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Данные для подключения к eWeLink (лучше вынести в .env, но оставляем для структуры)
const login = process.env.EWELINK_LOGIN || 'dreamteam.iot@mail.com';
const pass = process.env.EWELINK_PASS || 'edtr61iot';
const region = process.env.EWELINK_REGION || 'eu';

// Статические файлы интерфейса
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Расширенное состояние устройств и датчиков (включая RGB-ленту)
let systemState = {
    temperature: 24.5,
    motion: false,
    lamp1: false,
    lamp2: false,
    fan: false,
    rgbPower: false,
    rgbColor: "#ff0000",
    haBridgeStatus: "Ready"
};

function broadcastState() {
    const data = JSON.stringify({ type: 'STATE_UPDATE', payload: systemState });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

wss.on('connection', (ws) => {
    console.log('[Server] New display client connected');
    ws.send(JSON.stringify({ type: 'STATE_UPDATE', payload: systemState }));

    ws.on('message', async (message) => {
        try {
            const parsed = JSON.parse(message);
            console.log('[Server] Received command:', parsed);

            if (parsed.action === 'TOGGLE_LAMP_1') {
                systemState.lamp1 = !systemState.lamp1;
            } else if (parsed.action === 'TOGGLE_LAMP_2') {
                systemState.lamp2 = !systemState.lamp2;
            } else if (parsed.action === 'TOGGLE_FAN') {
                systemState.fan = !systemState.fan;
            } else if (parsed.action === 'TOGGLE_RGB') {
                systemState.rgbPower = !systemState.rgbPower;
                // Здесь можно добавить вызов ewelink API для физической ленты
            } else if (parsed.action === 'SET_RGB_COLOR') {
                systemState.rgbColor = parsed.color;
                systemState.rgbPower = true;
                
                // Пример отправки цвета в eWeLink (как в вашем старом коде)
                try {
                    const r = parseInt(parsed.color.slice(1, 3), 16);
                    const g = parseInt(parsed.color.slice(3, 5), 16);
                    const b = parseInt(parsed.color.slice(5, 7), 16);
                    const colorStr = [r, g, b].join(',');

                    const connection = new ewelink({ email: login, password: pass, region: region });
                    // Замените ID устройства на ваше реальное ID RGB контроллера из прошлого проекта
                    const rgbDeviceId = '100123e422'; 
                    await connection.setDevicePowerState(rgbDeviceId, 'on', { outlet: 1, zyx_mode: 2, zyx_data: colorStr });
                    console.log(`[eWeLink] RGB color updated to R:${r} G:${g} B:${b}`);
                } catch (apiErr) {
                    console.error('[eWeLink] Error setting color on device:', apiErr);
                }

            } else if (parsed.action === 'TRIGGER_MOTION') {
                systemState.motion = true;
                broadcastState();
                setTimeout(() => {
                    systemState.motion = false;
                    broadcastState();
                }, 4000);
                return;
            }

            broadcastState();
        } catch (e) {
            console.error('[Server] Error parsing message:', e);
        }
    });

    ws.on('close', () => {
        console.log('[Server] Display client disconnected');
    });
});

// REST API для Home Assistant
app.post('/api/ha-integration', (req, res) => {
    const { device, state } = req.body;
    console.log(`[HA Bridge] Received command from Home Assistant: Device -> ${device}, State -> ${state}`);
    res.json({ status: "success", message: "Command accepted by Pi 4 bridge" });
});

server.listen(PORT, () => {
    console.log(`[Server] IoT Dashboard running smoothly at http://localhost:${PORT}`);
});