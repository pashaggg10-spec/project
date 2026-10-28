const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const ewelink = require('ewelink-api');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Ваши учетные данные eWeLink
const login = 'dreamteam.iot@mail.com';
const pass = 'edtr61iot';
const region = 'eu';

// Ваши реальные ID устройств
const switchId = '10017b7136'; // Многоканальное реле
const rgbDeviceId = '100123e422'; // RGB лента

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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

// Надежная функция управления каналами реле через явное задание state ('on'/'off')
async function handleChannelToggle(channel, currentState, stateKey) {
    try {
        const connection = new ewelink({ email: login, password: pass, region: region });
        const newState = currentState ? 'off' : 'on';
        
        console.log(`[eWeLink] Setting device ${switchId} channel ${channel} to ${newState}`);
        
        // Явно отправляем команду 'on' или 'off' на конкретный канал (outlet)
        await connection.setDevicePowerState(switchId, newState, { outlet: channel });

        systemState[stateKey] = !currentState;
        broadcastState();
    } catch (error) {
        console.error('[eWeLink Error] Failed to change state:', error);
    }
}

wss.on('connection', (ws) => {
    console.log('[Server] New display client connected');
    ws.send(JSON.stringify({ type: 'STATE_UPDATE', payload: systemState }));

    ws.on('message', async (message) => {
        try {
            const parsed = JSON.parse(message);
            console.log('[Server] Received command:', parsed);

            if (parsed.action === 'TOGGLE_LAMP_1') {
                await handleChannelToggle(2, systemState.lamp1, 'lamp1');
            } else if (parsed.action === 'TOGGLE_LAMP_2') {
                await handleChannelToggle(3, systemState.lamp2, 'lamp2');
            } else if (parsed.action === 'TOGGLE_FAN') {
                await handleChannelToggle(1, systemState.fan, 'fan');
            } else if (parsed.action === 'TOGGLE_RGB') {
                systemState.rgbPower = !systemState.rgbPower;
                const connection = new ewelink({ email: login, password: pass, region: region });
                const powerState = systemState.rgbPower ? 'on' : 'off';
                await connection.setDevicePowerState(rgbDeviceId, powerState);
                broadcastState();
            } else if (parsed.action === 'SET_RGB_COLOR') {
                systemState.rgbColor = parsed.color;
                systemState.rgbPower = true;
                
                const r = parseInt(parsed.color.slice(1, 3), 16);
                const g = parseInt(parsed.color.slice(3, 5), 16);
                const b = parseInt(parsed.color.slice(5, 7), 16);
                const colorStr = [r, g, b].join(',');

                const connection = new ewelink({ email: login, password: pass, region: region });
                await connection.setDevicePowerState(rgbDeviceId, 'on', { outlet: 1, zyx_mode: 2, zyx_data: colorStr });
                broadcastState();
            } else if (parsed.action === 'TRIGGER_MOTION') {
                systemState.motion = true;
                broadcastState();
                setTimeout(() => {
                    systemState.motion = false;
                    broadcastState();
                }, 4000);
            }
        } catch (e) {
            console.error('[Server] Error handling message:', e);
        }
    });
});

server.listen(PORT, () => {
    console.log(`[Server] IoT Dashboard running smoothly at http://localhost:${PORT}`);
});
