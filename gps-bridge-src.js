// Puente entre DogMy y el plugin nativo de GPS en segundo plano.
// Este archivo se compila (con esbuild) en un solo script normal que
// funciona con <script src="..."> comun y corriente, sin necesitar
// que el navegador entienda "import". Solo existe dentro de la app
// nativa (Capacitor) -- en la PWA de Netlify este archivo ni siquiera
// se carga, asi que script.js siempre revisa si "window.DogMyNativo"
// existe antes de usarlo.
//
// IMPORTANTE: las ubicaciones se guardan en Firebase usando CapacitorHttp
// (peticiones nativas de Android), NO usando el SDK de Firebase que corre
// dentro del WebView. Esto es a proposito: Android bloquea las peticiones
// de internet que salen del WebView despues de varios minutos con la
// pantalla apagada, aunque el servicio de GPS en si siga vivo. Usando
// CapacitorHttp nos saltamos ese bloqueo por completo.

import { Capacitor, registerPlugin, CapacitorHttp } from '@capacitor/core';

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');
const BatteryOptim = registerPlugin('BatteryOptim');

// Debe coincidir con databaseURL en firebase-config.js
const FIREBASE_URL = "https://dogmy-fd002-default-rtdb.firebaseio.com";

window.DogMyNativo = {
    disponible: function () {
        try {
            return Capacitor.isNativePlatform();
        } catch (e) {
            return false;
        }
    },

    // Le pide a Android que deje de aplicarle ahorro de bateria a DogMy.
    // Sin esto, MIUI (Poco) y Magic UI (Honor) terminan matando el GPS
    // en segundo plano despues de un rato, aunque el permiso de
    // ubicacion este bien concedido. Si el usuario ya lo habia
    // aceptado antes, no vuelve a mostrar el dialogo.
    pedirExencionBateria: async function () {
        try {
            const estado = await BatteryOptim.isIgnoringBatteryOptimizations();
            if (!estado.ignoring) {
                await BatteryOptim.requestIgnoreBatteryOptimizations();
            }
        } catch (e) {
            console.error("No se pudo pedir la excepcion de bateria:", e);
        }
    },

    iniciarGPS: async function (paseadorId, paseoId, onUbicacion) {
        const watcherId = await BackgroundGeolocation.addWatcher(
            {
                backgroundMessage: "DogMy sigue registrando tu paseo.",
                backgroundTitle: "🐕 Paseo en curso",
                requestPermissions: true,
                stale: false,
                distanceFilter: 10
            },
            async (location, error) => {
                if (error) {
                    console.error("Error de GPS nativo:", error);
                    return;
                }
                if (!location) return;
                const lat = location.latitude;
                const lon = location.longitude;

                try {
                    await CapacitorHttp.patch({
                        url: `${FIREBASE_URL}/usuarios/${paseadorId}.json`,
                        headers: { "Content-Type": "application/json" },
                        data: { lat, lon }
                    });
                    await CapacitorHttp.post({
                        url: `${FIREBASE_URL}/paseos/${paseoId}/ubicaciones.json`,
                        headers: { "Content-Type": "application/json" },
                        data: { lat, lon, timestamp: new Date().toISOString(), evento: null }
                    });
                } catch (errHttp) {
                    console.error("Error guardando GPS nativo via HTTP directo:", errHttp);
                }

                if (onUbicacion) {
                    try { onUbicacion(lat, lon); } catch (e) { /* pantalla no visible, ignorar */ }
                }
            }
        );
        return watcherId;
    },

    detenerGPS: async function (watcherId) {
        if (!watcherId) return;
        await BackgroundGeolocation.removeWatcher({ id: watcherId });
    }
};
