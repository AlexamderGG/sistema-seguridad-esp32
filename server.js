require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const APP_PIN = process.env.APP_PIN || '1234';
const ESP_API_KEY = process.env.ESP_API_KEY || 'clave_esp32_segura';

// Estado centralizado en memoria (se sincroniza con la memoria NVS del ESP32 Central)
let systemState = {
  zonas: {
    sala: true,     // Puerta principal (SW-420)
    cochera: true,  // Portón levadizo (SW-420 + LD2410C)
    patio: true     // Portón patio (SW-420 + LD2410C)
  },
  modoSilencio: false,
  duracionSirenaSeg: 15,
  sirenaActiva: false,
  comandoPendiente: null, // 'APAGAR_SIRENA' | 'TEST_SIRENA' | null
  configVersion: 1,       // Incrementa cuando la app cambia algo para que el ESP32 lo aplique
  ultimoLatidoEsp32: null,
  historial: []           // Últimas 30 alertas
};

// Tokens de Expo Go registrados (Set para evitar duplicados)
const expoPushTokens = new Set();

// Control de enfriamiento (cooldown) por zona para evitar spam de notificaciones
const ultimoEnvioPushPorZona = {
  sala: 0,
  cochera: 0,
  patio: 0
};
const COOLDOWN_PUSH_MS = 25000; // 25 segundos entre alertas push de la misma zona

// --- MIDDLEWARES DE SEGURIDAD ---
function verificarPinApp(req, res, next) {
  const pin = req.headers['x-pin'] || req.body?.pin;
  if (pin !== APP_PIN) {
    return res.status(401).json({ ok: false, error: 'PIN incorrecto' });
  }
  next();
}

function verificarEsp32(req, res, next) {
  const key = req.headers['x-esp-key'];
  if (key !== ESP_API_KEY) {
    return res.status(401).json({ ok: false, error: 'Clave de dispositivo inválida' });
  }
  next();
}

// --- FUNCIÓN DE ENVÍO DE NOTIFICACIONES PUSH A EXPO ---
async function enviarNotificacionExpo(titulo, cuerpo, datosExtra = {}) {
  if (expoPushTokens.size === 0) return;

  const mensajes = Array.from(expoPushTokens).map((token) => ({
    to: token,
    sound: 'default',
    priority: 'high',
    title: titulo,
    body: cuerpo,
    data: datosExtra
  }));

  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(mensajes)
    });
    const result = await response.json();
    console.log('Push enviado:', JSON.stringify(result));
  } catch (err) {
    console.error('Error enviando push a Expo:', err.message);
  }
}

// --- RUTAS PÚBLICAS / HEALTHCHECK ---
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'online', timestamp: new Date().toISOString() });
});

// --- RUTAS PARA LA APP MÓVIL (EXPO GO) ---
app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body;
  if (pin === APP_PIN) {
    return res.json({ ok: true, message: 'Acceso concedido' });
  }
  return res.status(401).json({ ok: false, error: 'PIN incorrecto' });
});

app.post('/api/push-token', verificarPinApp, (req, res) => {
  const { token } = req.body;
  if (token && token.startsWith('ExponentPushToken')) {
    expoPushTokens.add(token);
    console.log('Token Expo registrado:', token);
    return res.json({ ok: true, totalTokens: expoPushTokens.size });
  }
  return res.status(400).json({ ok: false, error: 'Token Expo inválido' });
});

app.get('/api/state', verificarPinApp, (req, res) => {
  const ahora = Date.now();
  const espOnline =
    systemState.ultimoLatidoEsp32 !== null &&
    ahora - systemState.ultimoLatidoEsp32 < 20000; // Online si reportó hace menos de 20s

  res.json({
    ok: true,
    espOnline,
    state: systemState
  });
});

app.post('/api/config', verificarPinApp, (req, res) => {
  const { zonas, modoSilencio, duracionSirenaSeg, comando } = req.body;

  if (zonas) {
    systemState.zonas = { ...systemState.zonas, ...zonas };
  }
  if (typeof modoSilencio === 'boolean') {
    systemState.modoSilencio = modoSilencio;
  }
  if (typeof duracionSirenaSeg === 'number' && duracionSirenaSeg >= 3 && duracionSirenaSeg <= 120) {
    systemState.duracionSirenaSeg = duracionSirenaSeg;
  }
  if (comando === 'APAGAR_SIRENA' || comando === 'TEST_SIRENA') {
    systemState.comandoPendiente = comando;
    if (comando === 'APAGAR_SIRENA') {
      systemState.sirenaActiva = false;
    }
  }

  systemState.configVersion += 1;
  res.json({ ok: true, state: systemState });
});

// --- RUTAS PARA EL ESP32 CENTRAL (MAESTRO) ---

// 1. Sincronización periódica (cada 3-5 segundos) y keep-alive
app.post('/api/esp32/sync', verificarEsp32, (req, res) => {
  const { sirenaActiva, zonasNvs, modoSilencioNvs, inicializando } = req.body;

  systemState.ultimoLatidoEsp32 = Date.now();

  // Si el ESP32 acaba de reiniciar tras un corte de luz, recupera su estado NVS
  if (inicializando && zonasNvs) {
    systemState.zonas = zonasNvs;
    if (typeof modoSilencioNvs === 'boolean') {
      systemState.modoSilencio = modoSilencioNvs;
    }
  }

  if (typeof sirenaActiva === 'boolean') {
    systemState.sirenaActiva = sirenaActiva;
  }

  // Enviamos al ESP32 la configuración actual y cualquier comando inmediato pendiente
  const respuesta = {
    ok: true,
    configVersion: systemState.configVersion,
    zonas: systemState.zonas,
    modoSilencio: systemState.modoSilencio,
    duracionSirenaSeg: systemState.duracionSirenaSeg,
    comando: systemState.comandoPendiente
  };

  // Limpiamos el comando de un solo uso tras entregarlo al ESP32
  systemState.comandoPendiente = null;

  res.json(respuesta);
});

// 2. Reporte inmediato de intrusión / detección desde cualquier nodo
app.post('/api/esp32/alert', verificarEsp32, async (req, res) => {
  const { zona, sensor, detalle, sirenaDisparada } = req.body;
  // zona: 'sala' | 'cochera' | 'patio'
  // sensor: 'vibracion' | 'radar'

  systemState.ultimoLatidoEsp32 = Date.now();
  if (typeof sirenaDisparada === 'boolean') {
    systemState.sirenaActiva = sirenaDisparada;
  }

  const nombresZona = {
    sala: 'Puerta Principal (Sala)',
    cochera: 'Cochera',
    patio: 'Patio'
  };

  const nombreLegible = nombresZona[zona] || zona;
  const descripcionSensor =
    sensor === 'radar' ? 'Presencia humana detectada' : 'Vibración / golpe detectado';

  const evento = {
    id: Date.now().toString(),
    zona,
    nombreZona: nombreLegible,
    sensor,
    detalle: detalle || descripcionSensor,
    sirenaDisparada: Boolean(sirenaDisparada),
    fechaHora: new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })
  };

  // Guardar en historial (máximo 30 registros recientes)
  systemState.historial.unshift(evento);
  if (systemState.historial.length > 30) {
    systemState.historial.pop();
  }

  // Verificar cooldown para enviar notificación push sin saturar el teléfono
  const ahora = Date.now();
  const ultimoEnvio = ultimoEnvioPushPorZona[zona] || 0;

  if (ahora - ultimoEnvio > COOLDOWN_PUSH_MS) {
    ultimoEnvioPushPorZona[zona] = ahora;
    const estadoSirenaTexto = sirenaDisparada ? '🔊 Sirena activada' : '🔕 Modo silencio';
    await enviarNotificacionExpo(
      `🚨 Alerta en ${nombreLegible}`,
      `${evento.detalle} • ${estadoSirenaTexto}`,
      evento
    );
  }

  res.json({ ok: true, eventoRegistrado: evento.id });
});

app.listen(PORT, () => {
  console.log(`Servidor de alarma ejecutándose en puerto ${PORT}`);
});