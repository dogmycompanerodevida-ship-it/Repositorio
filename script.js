// ======================================
// DOGMY 8.3 - FOTOS EN NUBE + MULTIPLES PERROS + UI OPTIMIZADA + MAPA LEAFLET
// ======================================

import { db } from "./firebase-config.js";
import {
    ref, onValue, set, push, update, remove, get, query, orderByChild, equalTo
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-database.js";

// ---------- VARIABLES GLOBALES ----------
let uidActual = null;
let watchIdGPS = null;
let intervaloGPS = null;
let dbLocal = null;

// ---------- SEGURIDAD DE CONTRASEÑAS ----------
// Cada contraseña se guarda como hash SHA-256 + una "sal" (salt) unica por
// usuario, nunca en texto plano. El salt evita que dos usuarios con la
// misma contraseña tengan el mismo hash guardado.
function generarSalt() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hashContrasena(contrasena, salt) {
    const datos = new TextEncoder().encode(salt + ":" + contrasena);
    const hashBuffer = await crypto.subtle.digest("SHA-256", datos);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}
// Compara una contraseña ingresada contra lo guardado. Soporta cuentas
// viejas que aun tengan "contrasena" en texto plano (las va a "migrar"
// a hash automaticamente en el primer login exitoso, ver mas abajo).
async function verificarContrasena(userData, contrasenaIngresada) {
    if (userData.contrasenaHash && userData.salt) {
        const hash = await hashContrasena(contrasenaIngresada, userData.salt);
        return hash === userData.contrasenaHash;
    }
    // Cuenta vieja sin cifrar todavia
    return userData.contrasena === contrasenaIngresada;
}

// ---------- INDEXEDDB LOCAL ----------
function initLocalDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("DogMyLocalDB", 1);
        request.onupgradeneeded = function(e) {
            const db = e.target.result;
            if (!db.objectStoreNames.contains("fotos")) {
                db.createObjectStore("fotos", {keyPath: "id", autoIncrement: true});
            }
        };
        request.onsuccess = function(e) {
            dbLocal = e.target.result;
            resolve(dbLocal);
        };
        request.onerror = () => reject("Error abriendo IndexedDB");
    });
}
initLocalDB().catch(console.error);

function guardarFotoLocal(datos) {
    if (!dbLocal) return Promise.reject("DB no lista");
    return new Promise((resolve, reject) => {
        const tx = dbLocal.transaction(["fotos"], "readwrite");
        const store = tx.objectStore("fotos");
        const req = store.add(datos);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function obtenerFotosLocales() {
    if (!dbLocal) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
        const tx = dbLocal.transaction(["fotos"], "readonly");
        const store = tx.objectStore("fotos");
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result.reverse());
        req.onerror = () => reject(req.error);
    });
}

function eliminarTodasLasFotosLocales() {
    if (!dbLocal) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const tx = dbLocal.transaction(["fotos"], "readwrite");
        const store = tx.objectStore("fotos");
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// ---------- UTILIDADES ----------
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function formatDistancia(metros) {
    if (metros < 1000) return metros.toFixed(0) + " m";
    return (metros / 1000).toFixed(2) + " km";
}

// El GPS nativo guarda cada punto con push() (por HTTP directo), lo que
// hace que "ubicaciones" quede como un OBJETO con llaves generadas por
// Firebase, no como una lista simple. El GPS del navegador (respaldo web)
// puede guardarlo como lista simple. Esta funcion siempre entrega una
// lista ordenada por tiempo, sin importar cual de los dos formatos venga,
// para que el resto del codigo no tenga que preocuparse por eso.
function normalizarUbicaciones(ubicaciones) {
    if (!ubicaciones) return [];
    const puntos = Array.isArray(ubicaciones) ? ubicaciones.slice() : Object.values(ubicaciones);
    puntos.sort((a, b) => {
        const ta = a && a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b && b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return ta - tb;
    });
    return puntos.filter(u => u && typeof u.lat === "number" && typeof u.lon === "number");
}

// Calcula la distancia total sumando la distancia entre cada par de puntos
// consecutivos de la ruta. Se usa en vez de un campo "distancia" que se
// va acumulando en cada escritura, para que funcione igual sin importar
// si los puntos los guardo el GPS nativo (por HTTP directo) o el del
// navegador (por el SDK de Firebase) -- ambos guardan el mismo formato
// de puntos, asi que el calculo siempre da el mismo resultado real.
function calcularDistanciaRuta(ubicaciones) {
    const puntos = normalizarUbicaciones(ubicaciones);
    let total = 0;
    for (let i = 1; i < puntos.length; i++) {
        const a = puntos[i - 1], b = puntos[i];
        total += haversine(a.lat, a.lon, b.lat, b.lon);
    }
    return total;
}

// Dibuja una "captura" simple del recorrido (la forma de la ruta, con
// punto de inicio en azul y punto final en rojo) y la devuelve como
// imagen (base64) para guardarla junto con las estadisticas del paseo.
// No es un mapa real con calles -- es un dibujo del trazo -- para no
// depender de servicios externos ni de conexion al generarla.
function generarImagenRuta(ubicacionesRaw) {
    try {
        const puntos = normalizarUbicaciones(ubicacionesRaw).filter(p => p.lat != null && p.lon != null);
        if (puntos.length < 2) return null;
        const lats = puntos.map(p => p.lat);
        const lons = puntos.map(p => p.lon);
        let minLat = Math.min(...lats), maxLat = Math.max(...lats);
        let minLon = Math.min(...lons), maxLon = Math.max(...lons);
        if (maxLat - minLat < 0.00005) { maxLat += 0.00005; minLat -= 0.00005; }
        if (maxLon - minLon < 0.00005) { maxLon += 0.00005; minLon -= 0.00005; }
        const ancho = 400, alto = 300, margen = 30;
        const canvas = document.createElement("canvas");
        canvas.width = ancho; canvas.height = alto;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#eef6ef";
        ctx.fillRect(0, 0, ancho, alto);
        const escalarX = lon => margen + ((lon - minLon) / (maxLon - minLon)) * (ancho - margen * 2);
        const escalarY = lat => margen + (1 - (lat - minLat) / (maxLat - minLat)) * (alto - margen * 2);
        ctx.strokeStyle = "#2e7d32";
        ctx.lineWidth = 4;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();
        puntos.forEach((p, i) => {
            const x = escalarX(p.lon), y = escalarY(p.lat);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        const inicio = puntos[0], finP = puntos[puntos.length - 1];
        ctx.fillStyle = "#1565c0";
        ctx.beginPath();
        ctx.arc(escalarX(inicio.lon), escalarY(inicio.lat), 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#c62828";
        ctx.beginPath();
        ctx.arc(escalarX(finP.lon), escalarY(finP.lat), 7, 0, Math.PI * 2);
        ctx.fill();
        return canvas.toDataURL("image/jpeg", 0.6);
    } catch (e) {
        console.error("No se pudo generar la imagen de la ruta:", e);
        return null;
    }
}

function formatTiempo(segundosTotales) {
    const h = Math.floor(segundosTotales / 3600);
    const m = Math.floor((segundosTotales % 3600) / 60);
    const s = segundosTotales % 60;
    return h.toString().padStart(2,"0") + ":" + m.toString().padStart(2,"0") + ":" + s.toString().padStart(2,"0");
}

// Icono de bandera de un color dado, para marcar inicio (azul) y fin (rojo)
// de una ruta en el mapa. Se usa en los mapas de admin, cliente y paseador.
function crearIconoBandera(color) {
    const svg = `<svg width="26" height="32" viewBox="0 0 26 32" xmlns="http://www.w3.org/2000/svg">
        <line x1="3" y1="1" x2="3" y2="30" stroke="#333" stroke-width="2"/>
        <path d="M3 3 L23 8 L3 14 Z" fill="${color}" stroke="#222" stroke-width="1"/>
    </svg>`;
    return L.divIcon({ html: svg, className: '', iconSize: [26, 32], iconAnchor: [3, 30] });
}

// ---------- INICIALIZAR ADMIN ----------
async function inicializarAdmin() {
    const adminQuery = query(ref(db, "usuarios"), orderByChild("usuario"), equalTo("admin"));
    const snapshot = await get(adminQuery);
    if (!snapshot.exists()) {
        const salt = generarSalt();
        const contrasenaHash = await hashContrasena("1234", salt);
        const nuevoRef = push(ref(db, "usuarios"));
        await set(nuevoRef, {
            nombre: "Administrador",
            usuario: "admin",
            contrasenaHash, salt,
            tipo: "admin",
            telefono: "",
            activo: false,
            lat: null,
            lon: null,
            paseoActualId: null
        });
        console.log("Admin creado: usuario=admin / contrasena=1234");
    }
}

// ---------- LOGIN ----------
const btnIngresar = document.getElementById("btnIngresar");
if (btnIngresar) {
    inicializarAdmin();
    btnIngresar.addEventListener("click", async function () {
        const usuario = document.getElementById("usuario").value.trim();
        const contrasena = document.getElementById("contrasena").value.trim();
        if (!usuario || !contrasena) {
            alert("Ingrese usuario y contraseña.");
            return;
        }
        try {
            const userQuery = query(ref(db, "usuarios"), orderByChild("usuario"), equalTo(usuario));
            const snapshot = await get(userQuery);
            if (!snapshot.exists()) {
                alert("Usuario o contraseña incorrectos.");
                return;
            }
            const data = snapshot.val();
            const uid = Object.keys(data)[0];
            const userData = data[uid];
            const esValida = await verificarContrasena(userData, contrasena);
            if (!esValida) {
                alert("Usuario o contraseña incorrectos.");
                return;
            }
            // Migracion automatica: si la cuenta aun tenia contrasena en texto
            // plano, la cifra ahora que sabemos que el login fue correcto.
            if (!userData.contrasenaHash) {
                const salt = generarSalt();
                const contrasenaHash = await hashContrasena(contrasena, salt);
                await update(ref(db, "usuarios/" + uid), { contrasenaHash, salt, contrasena: null });
            }
            localStorage.setItem("dogmy_uid", uid);
            localStorage.setItem("dogmy_tipo", userData.tipo);
            localStorage.setItem("dogmy_usuario", userData.usuario);
            if (userData.tipo === "admin") window.location.href = "admin.html";
            else if (userData.tipo === "paseador") window.location.href = "paseador.html";
            else if (userData.tipo === "cliente") window.location.href = "cliente.html";
        } catch (error) {
            console.error("Error en login:", error);
            alert("Error de conexion. Verifica tu internet.");
        }
    });
}

// ---------- REGISTRO ----------
const guardarRegistro = document.getElementById("guardarRegistro");
if (guardarRegistro) {
    // Solo el admin puede registrar paseadores o clientes. Si alguien
    // abre esta pagina sin haber iniciado sesion como admin, se le
    // regresa al login -- antes cualquiera con el enlace podia crear
    // cuentas sin pasar por el panel.
    (async () => {
        const uidSesion = localStorage.getItem("dogmy_uid");
        if (!uidSesion) { window.location.href = "index.html"; return; }
        const snapSesion = await get(ref(db, "usuarios/" + uidSesion));
        const datosSesion = snapSesion.val();
        if (!datosSesion || datosSesion.tipo !== "admin") {
            alert("Solo el administrador puede registrar cuentas.");
            window.location.href = "index.html";
        }
    })();

    const params = new URLSearchParams(window.location.search);
    const tipo = params.get("tipo") || "cliente";
    const titulo = document.getElementById("tituloRegistro");
    const subtitulo = document.getElementById("subtituloRegistro");
    const seccionPaseador = document.getElementById("seccionPaseador");
    const seccionCliente = document.getElementById("seccionCliente");
    const btnVolverAdmin = document.getElementById("btnVolverAdmin");
    const selectPaseador = document.getElementById("paseadorAsignado");
    if (selectPaseador) {
        const paseadoresQuery = query(ref(db, "usuarios"), orderByChild("tipo"), equalTo("paseador"));
        onValue(paseadoresQuery, snapshot => {
            selectPaseador.innerHTML = '<option value="">Seleccione un paseador</option>';
            const data = snapshot.val() || {};
            Object.entries(data).forEach(([uid, p]) => {
                const opt = document.createElement("option");
                opt.value = uid;
                opt.textContent = p.nombre;
                selectPaseador.appendChild(opt);
            });
        });
    }
    if (tipo === "paseador") {
        if (titulo) titulo.textContent = "Registrar Paseador";
        if (subtitulo) subtitulo.textContent = "Nuevo paseador";
        if (seccionPaseador) seccionPaseador.style.display = "block";
        if (seccionCliente) seccionCliente.style.display = "none";
        if (btnVolverAdmin) btnVolverAdmin.style.display = "inline-block";
    } else {
        if (titulo) titulo.textContent = "Registrar Cliente + Perro";
        if (subtitulo) subtitulo.textContent = "Nuevo cliente y su mascota";
        if (seccionPaseador) seccionPaseador.style.display = "none";
        if (seccionCliente) seccionCliente.style.display = "block";
        if (btnVolverAdmin) btnVolverAdmin.style.display = "inline-block";
    }
    guardarRegistro.addEventListener("click", async function () {
        if (tipo === "paseador") {
            const nombre = document.getElementById("nombrePaseadorReg").value.trim();
            const telefono = document.getElementById("telefonoPaseador").value.trim();
            let usuario = document.getElementById("usuarioPaseador").value.trim();
            const contrasena = document.getElementById("contrasenaPaseador").value.trim();
            if (!nombre || !telefono || !usuario || !contrasena) {
                alert("Complete todos los datos del paseador.");
                return;
            }
            // Todo usuario debe empezar con "@" (ej: @Javi) -- si se
            // les olvida ponerlo, se agrega solo.
            if (!usuario.startsWith("@")) usuario = "@" + usuario;
            const existeQuery = query(ref(db, "usuarios"), orderByChild("usuario"), equalTo(usuario));
            const snapExiste = await get(existeQuery);
            if (snapExiste.exists()) {
                alert("El usuario ya existe. Elija otro.");
                return;
            }
            const nuevoRef = push(ref(db, "usuarios"));
            const saltP = generarSalt();
            const contrasenaHashP = await hashContrasena(contrasena, saltP);
            await set(nuevoRef, {
                nombre, usuario, contrasenaHash: contrasenaHashP, salt: saltP, tipo: "paseador", telefono,
                activo: false, lat: null, lon: null, paseoActualId: null
            });
            alert("Paseador registrado: " + usuario);
            window.location.href = "admin.html";
        } else {
            const nombre = document.getElementById("nombre").value.trim();
            const telefono = document.getElementById("telefono").value.trim();
            const direccion = document.getElementById("direccion").value.trim();
            let usuario = document.getElementById("nuevoUsuario").value.trim();
            const contrasena = document.getElementById("nuevaContrasena").value.trim();
            if (!nombre || !telefono || !direccion || !usuario || !contrasena) {
                alert("Complete todos los datos del cliente.");
                return;
            }
            if (!usuario.startsWith("@")) usuario = "@" + usuario;
            const existeQuery = query(ref(db, "usuarios"), orderByChild("usuario"), equalTo(usuario));
            const snapExiste = await get(existeQuery);
            if (snapExiste.exists()) {
                alert("El usuario ya existe. Elija otro.");
                return;
            }
            const dias = [];
            ["lunes","martes","miercoles","jueves","viernes","sabado","domingo"].forEach((d,i) => {
                if (document.getElementById(d).checked) dias.push(["Lunes","Martes","Miercoles","Jueves","Viernes","Sabado","Domingo"][i]);
            });
            const nombrePerro = document.getElementById("nombrePerro").value.trim();
            const raza = document.getElementById("raza").value.trim();
            const edad = document.getElementById("edad").value.trim();
            if (!nombrePerro || !raza || !edad) {
                alert("Complete los datos del perro (nombre, raza, edad).");
                return;
            }
            const clienteRef = push(ref(db, "usuarios"));
            const clienteUid = clienteRef.key;
            const saltC = generarSalt();
            const contrasenaHashC = await hashContrasena(contrasena, saltC);
            await set(clienteRef, {
                nombre, usuario, contrasenaHash: contrasenaHashC, salt: saltC, tipo: "cliente", telefono, direccion,
                activo: false, lat: null, lon: null, paseoActualId: null
            });
            const perroRef = push(ref(db, "perros"));
            await set(perroRef, {
                clienteId: clienteUid, clienteNombre: nombre,
                paseadorId: document.getElementById("paseadorAsignado").value || null,
                nombre: nombrePerro, raza, edad,
                color: document.getElementById("color").value.trim(),
                tamano: document.getElementById("tamano").value.trim(),
                dias, hora: document.getElementById("hora").value
            });
            alert("Cliente y perro registrados correctamente.");
            window.location.href = "lista_clientes.html";
        }
    });
}

// ======================================
// PANEL PASEADOR - MULTIPLES PERROS + EVENTOS + DISTANCIA + FOTOS LOCALES
// ======================================
const nombrePaseadorEl = document.getElementById("nombrePaseador");
if (nombrePaseadorEl) {
    const uid = localStorage.getItem("dogmy_uid");
    if (!uid) { window.location.href = "index.html"; }

    const estado = document.getElementById("estado");
    const cronometroBox = document.getElementById("cronometroBox");
    const cronometroDisplay = document.getElementById("cronometro");
    const listaPerrosPaseador = document.getElementById("listaPerrosPaseador");
    const btnFoto = document.getElementById("btnFoto");
    const eventosBox = document.getElementById("eventosBox");
    const distanciaBox = document.getElementById("distanciaBox");
    const btnFinalizar = document.getElementById("btnFinalizarPaseo");

    let intervaloCronometro = null;
    let wakeLock = null;
    let paseoEnCurso = false;
    let mapaPropio = null;
    let polylinePropio = null;
    let markerPropioActual = null;
    let markerInicioPropio = null;
    let dejarDeEscucharMapaPropio = null;

    function mostrarMapaPropio(paseoId) {
        const box = document.getElementById("mapaPropioBox");
        if (!box) return;
        box.style.display = "block";
        if (!mapaPropio) {
            mapaPropio = L.map("mapaPropioBox").setView([19.4326, -99.1332], 15);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap'
            }).addTo(mapaPropio);
            setTimeout(() => mapaPropio.invalidateSize(), 200);
        }
        if (dejarDeEscucharMapaPropio) dejarDeEscucharMapaPropio();
        dejarDeEscucharMapaPropio = onValue(ref(db, "paseos/" + paseoId), snap => {
            const paseo = snap.val();
            const ubs = normalizarUbicaciones(paseo ? paseo.ubicaciones : null);
            if (ubs.length === 0) return;

            if (!markerInicioPropio) {
                const inicioPunto = ubs[0];
                const iconoInicio = crearIconoBandera("#1565c0");
                markerInicioPropio = L.marker([inicioPunto.lat, inicioPunto.lon], { icon: iconoInicio })
                    .addTo(mapaPropio).bindPopup("🔵 Aquí iniciaste el paseo");
            }

            if (polylinePropio) mapaPropio.removeLayer(polylinePropio);
            const latlngs = ubs.map(u => [u.lat, u.lon]);
            polylinePropio = L.polyline(latlngs, { color: "red", weight: 4 }).addTo(mapaPropio);

            const last = ubs[ubs.length - 1];
            if (markerPropioActual) mapaPropio.removeLayer(markerPropioActual);
            const iconoPerro = L.divIcon({
                html: '<div class="marcador-perro-caminando">🐕</div>',
                className: '', iconSize: [40, 40], iconAnchor: [20, 20]
            });
            markerPropioActual = L.marker([last.lat, last.lon], { icon: iconoPerro }).addTo(mapaPropio);
            mapaPropio.setView([last.lat, last.lon]);

            const distanciaBoxTexto = document.querySelector("#distanciaBox p");
            if (distanciaBoxTexto) {
                distanciaBoxTexto.innerHTML = "📏 Distancia: <b>" + formatDistancia(calcularDistanciaRuta(ubs)) + "</b>";
            }
        });
    }

    function ocultarMapaPropio() {
        const box = document.getElementById("mapaPropioBox");
        if (box) box.style.display = "none";
        if (dejarDeEscucharMapaPropio) { dejarDeEscucharMapaPropio(); dejarDeEscucharMapaPropio = null; }
        polylinePropio = null;
        markerPropioActual = null;
        markerInicioPropio = null;
        mapaPropio = null;
        const box2 = document.getElementById("mapaPropioBox");
        if (box2) box2.innerHTML = "";
    }

    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                wakeLock = await navigator.wakeLock.request('screen');
                console.log('Wake Lock activo - pantalla no se apagara');
            }
        } catch (err) { console.log('Wake Lock no disponible:', err); }
    }
    function releaseWakeLock() {
        if (wakeLock) { wakeLock.release(); wakeLock = null; console.log('Wake Lock liberado'); }
    }
    window.addEventListener('beforeunload', (e) => {
        if (paseoEnCurso) { e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && paseoEnCurso && uid) {
            requestWakeLock();
            const snap = await get(ref(db, "usuarios/" + uid));
            const d = snap.val();
            if (d && d.activo && d.paseoActualId) {
                // iniciarGPSAutomatico ya detiene (y espera) cualquier
                // watcher anterior antes de crear uno nuevo -- no hace
                // falta (y es contraproducente) llamar detenerGPS() aparte
                // aqui, porque duplicaba la carrera que rompia el GPS.
                await iniciarGPSAutomatico(uid, d.paseoActualId);
                console.log("GPS reanudado tras volver a la app");
            }
        }
    });

    onValue(ref(db, "usuarios/" + uid), snapshot => {
        const data = snapshot.val();
        if (!data) return;
        nombrePaseadorEl.textContent = "Hola, " + data.nombre;

        const fotoPerfilEl = document.getElementById("fotoPerfilPaseador");
        if (fotoPerfilEl) {
            if (data.fotoPerfil) {
                fotoPerfilEl.src = data.fotoPerfil;
                fotoPerfilEl.style.display = "block";
            } else {
                fotoPerfilEl.style.display = "none";
            }
        }

        if (data.activo && data.paseoActualId) {
            estado.innerHTML = "🟡 Paseo en curso";
            estado.className = "en-curso";
            cronometroBox.style.display = "block";
            if (eventosBox) eventosBox.style.display = "grid";
            if (btnFoto) btnFoto.disabled = false;
            if (distanciaBox) distanciaBox.style.display = "block";
            if (btnFinalizar) btnFinalizar.style.display = "block";
            iniciarCronometroPaseo(data.paseoActualId);
            paseoEnCurso = true;
            requestWakeLock();
            iniciarGPSAutomatico(uid, data.paseoActualId);
            mostrarMapaPropio(data.paseoActualId);
        } else {
            paseoEnCurso = false;
            releaseWakeLock();
            estado.innerHTML = "🟢 Disponible";
            estado.className = "disponible";
            cronometroBox.style.display = "none";
            if (eventosBox) eventosBox.style.display = "none";
            if (btnFoto) btnFoto.disabled = true;
            if (distanciaBox) distanciaBox.style.display = "none";
            if (btnFinalizar) btnFinalizar.style.display = "none";
            detenerCronometro();
            detenerGPS();
            ocultarMapaPropio();
        }
        cargarPerrosAsignados(uid, data.paseoActualId, data.activo);
    });

    function iniciarCronometroPaseo(paseoId) {
        if (intervaloCronometro) clearInterval(intervaloCronometro);
        async function actualizar() {
            const snap = await get(ref(db, "paseos/" + paseoId + "/inicio"));
            const inicio = snap.val();
            if (!inicio) { cronometroDisplay.textContent = "00:00:00"; return; }
            const diff = Math.floor((new Date() - new Date(inicio)) / 1000);
            cronometroDisplay.textContent = formatTiempo(diff);
        }
        actualizar();
        intervaloCronometro = setInterval(actualizar, 1000);
    }

    function detenerCronometro() {
        if (intervaloCronometro) { clearInterval(intervaloCronometro); intervaloCronometro = null; }
        if (cronometroDisplay) cronometroDisplay.textContent = "00:00:00";
    }

    // GPS AUTOMATICO + DISTANCIA
    // Guarda una ubicacion nueva en Firebase (respaldo del navegador, solo
    // se usa si el puente nativo no esta disponible). Se agrega con push()
    // -- un solo punto nuevo -- en vez de leer y regrabar todo el arreglo,
    // para no pisar puntos que el GPS nativo pueda estar guardando al
    // mismo tiempo, y para que el formato sea igual en ambos caminos.
    async function guardarUbicacionGPS(paseadorId, paseoId, lat, lon) {
        await update(ref(db, "usuarios/" + paseadorId), { lat, lon });
        await push(ref(db, "paseos/" + paseoId + "/ubicaciones"), {
            lat, lon, timestamp: new Date().toISOString(), evento: null
        });
    }

    let watcherNativoId = null;

    async function iniciarGPSAutomatico(paseadorId, paseoId) {
        await detenerGPS();

        // Si la app corre como app nativa instalada (no como pagina web),
        // usamos el GPS nativo, que SI sigue funcionando con la pantalla
        // bloqueada o la app en segundo plano.
        if (window.DogMyNativo && window.DogMyNativo.disponible()) {
            try {
                // Primero nos aseguramos de que Android no vaya a matar el
                // GPS en segundo plano por ahorro de bateria (clave en
                // Poco/Xiaomi y Honor). Si ya estaba concedido, esto no
                // muestra ningun dialogo.
                await window.DogMyNativo.pedirExencionBateria();

                // El puente nativo ya guarda cada ubicacion directo en
                // Firebase por HTTP nativo (no por el WebView), asi que
                // aqui solo le pasamos los IDs necesarios. El callback es
                // opcional, solo por si la pantalla sigue visible.
                watcherNativoId = await window.DogMyNativo.iniciarGPS(paseadorId, paseoId, null);
                console.log("GPS nativo en segundo plano activado.");
                return;
            } catch (err) {
                console.error("No se pudo iniciar el GPS nativo, usando el del navegador:", err);
            }
        }

        // Respaldo: GPS normal del navegador (funciona en la PWA, pero se
        // pausa si se bloquea la pantalla o se minimiza la app).
        if (!navigator.geolocation) return;
        watchIdGPS = navigator.geolocation.watchPosition(
            async function (position) {
                await guardarUbicacionGPS(paseadorId, paseoId, position.coords.latitude, position.coords.longitude);
            },
            function (error) { console.log("GPS error:", error); },
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
        );
        intervaloGPS = setInterval(() => {
            navigator.geolocation.getCurrentPosition(
                async function (position) {
                    await update(ref(db, "usuarios/" + paseadorId), { lat: position.coords.latitude, lon: position.coords.longitude });
                },
                function() {},
                { enableHighAccuracy: true }
            );
        }, 10000);
    }

    async function detenerGPS() {
        releaseWakeLock();
        if (watcherNativoId && window.DogMyNativo) {
            const idAEliminar = watcherNativoId;
            watcherNativoId = null;
            try {
                // Esperamos a que Android confirme que ya quito el watcher
                // viejo antes de dejar que se pida uno nuevo. Sin este
                // "await", en MIUI (Poco) y Magic UI (Honor) el sistema
                // recibe "quita este" y "crea uno nuevo" casi al mismo
                // tiempo y descarta el servicio de GPS en segundo plano
                // -- por eso fallaba justo a partir del segundo paseo.
                await window.DogMyNativo.detenerGPS(idAEliminar);
            } catch (e) {
                console.error("Error deteniendo el GPS nativo:", e);
            }
        }
        if (watchIdGPS !== null) { navigator.geolocation.clearWatch(watchIdGPS); watchIdGPS = null; }
        if (intervaloGPS) { clearInterval(intervaloGPS); intervaloGPS = null; }
    }

    // Cargar perros asignados - DOS COLUMNAS + AGRUPADO POR CLIENTE
    function cargarPerrosAsignados(paseadorId, paseoActualId, activo) {
        const dispEl = document.getElementById("listaPerrosDisponibles");
        const paseoEl = document.getElementById("listaPerrosEnPaseo");
        if (!dispEl || !paseoEl) return;

        get(ref(db, "perros")).then(async snapshot => {
            const perros = snapshot.val() || {};
            const lista = Object.entries(perros);
            if (lista.length === 0) {
                dispEl.innerHTML = '<p style="font-size:13px;color:#666;text-align:center;">No hay perros registrados.</p>';
                paseoEl.innerHTML = '<p style="font-size:13px;color:#666;text-align:center;">Ninguno</p>';
                return;
            }

            // Perros de MI paseo actual (si tengo uno activo)
            let perrosEnPaseo = {};
            if (activo && paseoActualId) {
                const paseoSnap = await get(ref(db, "paseos/" + paseoActualId + "/perros"));
                perrosEnPaseo = paseoSnap.val() || {};
            }

            // Perros que YA andan de paseo con CUALQUIER otro paseador ahora mismo
            const paseosActivosSnap = await get(query(ref(db, "paseos"), orderByChild("estado"), equalTo("activo")));
            const paseosActivos = paseosActivosSnap.val() || {};
            const enPaseoConOtro = {}; // perroId -> nombre del paseador que lo trae
            Object.values(paseosActivos).forEach(p => {
                if (p.paseadorId !== paseadorId && p.perros) {
                    Object.keys(p.perros).forEach(pid => { enPaseoConOtro[pid] = p.paseadorNombre || "otro paseador"; });
                }
            });

            // Separar disponibles y en mi paseo
            const disponibles = [];
            const enPaseo = [];
            const conOtro = [];

            lista.forEach(([perroId, perro]) => {
                if (perrosEnPaseo[perroId]) {
                    enPaseo.push([perroId, perro]);
                } else if (enPaseoConOtro[perroId]) {
                    conOtro.push([perroId, perro, enPaseoConOtro[perroId]]);
                } else {
                    disponibles.push([perroId, perro]);
                }
            });

            // Renderizar disponibles - AGRUPADOS POR CLIENTE (perros de TODOS, no solo los mios)
            if (disponibles.length === 0 && conOtro.length === 0) {
                dispEl.innerHTML = '<p style="font-size:13px;color:#666;text-align:center;">No hay perros registrados.</p>';
            } else {
                dispEl.innerHTML = "";
                // Agrupar por cliente
                const porCliente = {};
                disponibles.forEach(([perroId, perro]) => {
                    const cid = perro.clienteId || perro.clienteNombre;
                    if (!porCliente[cid]) porCliente[cid] = { nombre: perro.clienteNombre, perros: [] };
                    porCliente[cid].perros.push([perroId, perro]);
                });

                Object.entries(porCliente).forEach(([cid, grupo]) => {
                    const grupoDiv = document.createElement("div");
                    grupoDiv.className = "grupo-cliente";
                    grupoDiv.innerHTML = `<div class="cliente-nombre">👤 ${grupo.nombre} (${grupo.perros.length} perro${grupo.perros.length > 1 ? 's' : ''})</div>`;

                    grupo.perros.forEach(([perroId, perro]) => {
                        const div = document.createElement("div");
                        div.className = "perro-compacto";
                        const btnText = activo ? "➕ Agregar al paseo" : "🐶 Iniciar Paseo";
                        const btnColor = activo ? "#ff9800" : "#2e7d32";
                        div.innerHTML = `
                            <p class="nombre">🐕 ${perro.nombre} <span style="font-weight:normal;color:#666;">(${perro.raza})</span></p>
                            <p class="dias">📅 ${perro.dias ? perro.dias.join(", ") : "Sin días"}</p>
                            <button onclick="togglePerroEnPaseo('${perroId}')" style="background:${btnColor};">${btnText}</button>
                        `;
                        grupoDiv.appendChild(div);
                    });
                    dispEl.appendChild(grupoDiv);
                });

                // Perros que ya andan de paseo con otro paseador: se muestran informativos, sin boton
                conOtro.forEach(([perroId, perro, nombreOtro]) => {
                    const div = document.createElement("div");
                    div.className = "perro-compacto";
                    div.style.opacity = "0.6";
                    div.style.borderColor = "#bbb";
                    div.innerHTML = `
                        <p class="nombre">🐕 ${perro.nombre} <span style="font-weight:normal;color:#666;">(${perro.raza})</span></p>
                        <p class="cliente">👤 ${perro.clienteNombre}</p>
                        <p style="font-size:12px;color:#888;">🚶 En paseo con ${nombreOtro}</p>
                    `;
                    dispEl.appendChild(div);
                });
            }

            // Renderizar en paseo (el mio)
            cronometrosPerros = {};
            if (enPaseo.length === 0) {
                paseoEl.innerHTML = '<p style="font-size:13px;color:#666;text-align:center;">Ninguno</p>';
            } else {
                paseoEl.innerHTML = "";
                enPaseo.forEach(([perroId, perro]) => {
                    const inicioPerro = (perrosEnPaseo[perroId] && perrosEnPaseo[perroId].inicio) || new Date().toISOString();
                    cronometrosPerros[perroId] = inicioPerro;
                    const div = document.createElement("div");
                    div.className = "perro-compacto";
                    div.style.borderColor = "#ff9800";
                    div.innerHTML = `
                        <p class="nombre">🐕 ${perro.nombre} <span style="font-weight:normal;color:#666;">(${perro.raza})</span></p>
                        <p class="cliente">👤 ${perro.clienteNombre}</p>
                        <p class="crono-perro" id="crono-${perroId}">⏱️ 00:00:00</p>
                        <button onclick="togglePerroEnPaseo('${perroId}')" style="background:#d32f2f;">✅ En paseo (quitar)</button>
                        <button onclick="tomarFotoPerro('${perroId}')" style="background:#9c27b0;">📷 Foto de este perro</button>
                    `;
                    paseoEl.appendChild(div);
                });
            }
            actualizarCronometrosPerros();
        });
    }

    // Cronometros individuales por perro (uno por cada perro "en paseo")
    let cronometrosPerros = {};
    function actualizarCronometrosPerros() {
        Object.entries(cronometrosPerros).forEach(([perroId, inicio]) => {
            const el = document.getElementById("crono-" + perroId);
            if (!el) return;
            const diff = Math.floor((new Date() - new Date(inicio)) / 1000);
            el.textContent = "⏱️ " + formatTiempo(diff >= 0 ? diff : 0);
        });
    }
    setInterval(actualizarCronometrosPerros, 1000);

    // Toggle perro en paseo
    window.togglePerroEnPaseo = async function(perroId) {
        const userSnap = await get(ref(db, "usuarios/" + uid));
        const data = userSnap.val();
        const perroSnap = await get(ref(db, "perros/" + perroId));
        const perro = perroSnap.val();
        if (!perro) return;

        if (!data.activo) {
            const paseoRef = push(ref(db, "paseos"));
            const paseoId = paseoRef.key;
            await set(paseoRef, {
                paseadorId: uid,
                paseadorNombre: data.nombre,
                perros: { [perroId]: { nombre: perro.nombre, clienteNombre: perro.clienteNombre, inicio: new Date().toISOString() } },
                inicio: new Date().toISOString(),
                fin: null,
                estado: "activo",
                ubicaciones: [],
                distancia: 0
            });
            await update(ref(db, "usuarios/" + uid), { activo: true, paseoActualId: paseoId, lat: null, lon: null });
            alert("Paseo iniciado con " + perro.nombre);
        } else {
            const paseoId = data.paseoActualId;
            if (!paseoId) { alert("Error: no se encontro paseo activo."); return; }
            const paseoSnap = await get(ref(db, "paseos/" + paseoId));
            const paseo = paseoSnap.val();
            if (!paseo) { alert("Error al cargar paseo."); return; }
            const perrosEnPaseo = paseo.perros || {};

            if (perrosEnPaseo[perroId]) {
                delete perrosEnPaseo[perroId];
                if (Object.keys(perrosEnPaseo).length === 0) {
                    await finalizarPaseo(paseoId, paseo);
                    await update(ref(db, "usuarios/" + uid), { activo: false, paseoActualId: null, lat: null, lon: null });
                    alert("Paseo finalizado. Todos los perros retirados.");
                } else {
                    await update(ref(db, "paseos/" + paseoId), { perros: perrosEnPaseo });
                    alert(perro.nombre + " retirado del paseo.");
                }
            } else {
                perrosEnPaseo[perroId] = { nombre: perro.nombre, clienteNombre: perro.clienteNombre, inicio: new Date().toISOString() };
                await update(ref(db, "paseos/" + paseoId), { perros: perrosEnPaseo });
                alert(perro.nombre + " agregado al paseo.");
            }
        }
    };

    window.finalizarPaseoCompleto = async function() {
        try {
            const snap = await get(ref(db, "usuarios/" + uid));
            const data = snap.val();
            if (!data || !data.activo || !data.paseoActualId) return;
            const paseoSnap = await get(ref(db, "paseos/" + data.paseoActualId));
            const paseo = paseoSnap.val();
            if (paseo) await finalizarPaseo(data.paseoActualId, paseo);
            await update(ref(db, "usuarios/" + uid), { activo: false, paseoActualId: null, lat: null, lon: null });
            alert("Paseo finalizado completamente.");
        } catch (err) {
            console.error("Error finalizando paseo:", err);
            alert("Hubo un error, pero se va a liberar tu estado de todos modos: " + err.message);
            try {
                await update(ref(db, "usuarios/" + uid), { activo: false, paseoActualId: null, lat: null, lon: null });
            } catch (e2) { console.error("Error liberando al paseador:", e2); }
        }
    };

    async function finalizarPaseo(paseoId, paseo) {
        const fin = new Date().toISOString();
        const inicio = paseo.inicio ? new Date(paseo.inicio) : new Date();
        let minutos = Math.floor((new Date(fin) - inicio) / 60000);
        if (!Number.isFinite(minutos) || minutos < 0) minutos = 0;
        const distancia = calcularDistanciaRuta(paseo.ubicaciones);
        const fechaKey = inicio.toISOString().split("T")[0];
        const imagenRuta = generarImagenRuta(paseo.ubicaciones);

        for (const perroId of Object.keys(paseo.perros || {})) {
            try {
                const statsRef = ref(db, "estadisticas/" + perroId);
                const statsSnap = await get(statsRef);
                const stats = statsSnap.val() || { totalPaseos: 0, totalMinutos: 0, totalMetros: 0, historial: {} };
                stats.totalPaseos = (stats.totalPaseos || 0) + 1;
                stats.totalMinutos = (stats.totalMinutos || 0) + minutos;
                stats.totalMetros = (stats.totalMetros || 0) + distancia;
                stats.ultimoPaseo = fin;
                stats.historial = stats.historial || {};
                stats.historial[fechaKey] = { minutos, metros: distancia, fecha: fin, paseoId, imagenRuta };
                await update(statsRef, stats);
            } catch (errEstadistica) {
                console.error("Error guardando estadisticas de " + perroId + ":", errEstadistica);
            }
        }
        await update(ref(db, "paseos/" + paseoId), { fin, estado: "completado", distancia });
    }

    // Eventos durante paseo
    window.marcarEvento = async function(tipo) {
        const snap = await get(ref(db, "usuarios/" + uid));
        const data = snap.val();
        if (!data || !data.activo || !data.paseoActualId) {
            alert("No hay paseo activo.");
            return;
        }
        navigator.geolocation.getCurrentPosition(async pos => {
            const paseoId = data.paseoActualId;
            await push(ref(db, "paseos/" + paseoId + "/ubicaciones"), {
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                timestamp: new Date().toISOString(),
                evento: tipo
            });
            const nombres = {agua:"💧 Agua", popo:"💩 Popo", comida:"🍖 Comida", olfateo:"👃 Olfateo"};
            alert("Evento guardado: " + (nombres[tipo] || tipo));
        }, () => alert("No se pudo obtener ubicacion para el evento."));
    };

    // Tomar foto de UN perro especifico (boton individual por perro).
    // Cada foto queda ligada a un solo perro y a un solo cliente, sin
    // ambiguedad de fotos grupales.
    // Foto de perfil (identificacion) del paseador -- visible para el
    // administrador y para los clientes, para que sepan quien trae a su perro.
    window.tomarFotoPerfil = function () {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.capture = "user"; // camara frontal, para la foto de rostro
        input.onchange = function (e) {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async function (event) {
                try {
                    await update(ref(db, "usuarios/" + uid), { fotoPerfil: event.target.result });
                    alert("✅ Foto de perfil actualizada.");
                } catch (err) {
                    console.error(err);
                    alert("Error guardando la foto: " + err.message);
                }
            };
            reader.readAsDataURL(file);
        };
        input.click();
    };

    window.tomarFotoPerro = function (perroId) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.capture = "environment";
        input.onchange = async function (e) {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async function (event) {
                try {
                    const userSnap = await get(ref(db, "usuarios/" + uid));
                    const userData = userSnap.val();
                    if (!userData || !userData.paseoActualId) {
                        alert("No hay paseo activo para asociar la foto.");
                        return;
                    }
                    const paseoId = userData.paseoActualId;
                    const perroSnap = await get(ref(db, "perros/" + perroId));
                    const perroData = perroSnap.val() || {};

                    const fotoRef = push(ref(db, "fotos"));
                    await set(fotoRef, {
                        imagen: event.target.result,
                        fecha: new Date().toISOString(),
                        paseadorId: uid,
                        paseadorNombre: userData.nombre || "",
                        paseoId: paseoId,
                        perros: { [perroId]: { nombre: perroData.nombre || "", clienteId: perroData.clienteId || null } }
                    });
                    alert("Foto de " + (perroData.nombre || "tu perro") + " sincronizada en la nube.");
                } catch(err) {
                    console.error(err);
                    alert("Error subiendo foto: " + err.message);
                }
            };
            reader.readAsDataURL(file);
        };
        input.click();
    };

    window.verHistorial = async function () {
        const fotosSnap = await get(ref(db, "fotos"));
        const fotos = fotosSnap.val() || {};
        const misFotos = Object.values(fotos).filter(f => f.paseadorId === uid);
        const videosSnap = await get(ref(db, "videos"));
        const videos = videosSnap.val() || {};
        const misVideos = Object.values(videos).filter(v => v.paseadorId === uid);
        alert("Tienes " + misFotos.length + " foto(s) y " + misVideos.length + " video(s) sincronizados en la nube.");
    };
}

// ======================================
// PANEL CLIENTE - MAPA LEAFLET + ESTADISTICAS
// ======================================
const nombreClienteEl = document.getElementById("nombreCliente");
if (nombreClienteEl) {
    const uid = localStorage.getItem("dogmy_uid");
    if (!uid) window.location.href = "index.html";

    onValue(ref(db, "usuarios/" + uid), snapshot => {
        const cliente = snapshot.val();
        if (!cliente) return;
        nombreClienteEl.textContent = "Hola, " + cliente.nombre;
        const misDatos = document.getElementById("misDatos");
        if (misDatos) {
            misDatos.innerHTML = `
                <p><b>Telefono:</b> ${cliente.telefono}</p>
                <p><b>Direccion:</b> ${cliente.direccion}</p>
                <p><b>Usuario:</b> ${cliente.usuario}</p>
            `;
        }
    });

    const misPerrosEl = document.getElementById("misPerros");
    const estadisticasEl = document.getElementById("estadisticasCliente");
    const mapaCliente = document.getElementById("mapaCliente");
    let mapaLeaflet = null;
    let polyline = null;
    let markers = [];

    if (misPerrosEl) {
        const perrosQuery = query(ref(db, "perros"), orderByChild("clienteId"), equalTo(uid));
        onValue(perrosQuery, async perrosSnap => {
            const perros = perrosSnap.val() || {};
            const lista = Object.entries(perros);
            if (lista.length === 0) {
                misPerrosEl.innerHTML = "<p>No tienes perros registrados.</p>";
                return;
            }
            misPerrosEl.innerHTML = "";
            if (estadisticasEl) estadisticasEl.innerHTML = "";
            for (const [perroId, p] of lista) {
                let paseadorNombre = "Sin asignar";
                let paseadorFotoHtml = "";
                if (p.paseadorId) {
                    const ps = await get(ref(db, "usuarios/" + p.paseadorId));
                    const pd = ps.val();
                    if (pd) {
                        paseadorNombre = pd.nombre;
                        if (pd.fotoPerfil) {
                            paseadorFotoHtml = `<img src="${pd.fotoPerfil}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-left:6px;border:2px solid #2e7d32;">`;
                        }
                    }
                }
                misPerrosEl.innerHTML += `
                <div class="perro-box">
                    <p><b>${p.nombre}</b> (${p.raza})</p>
                    <p>Edad: ${p.edad} anos | Tamano: ${p.tamano || "N/A"}</p>
                    <p>Dias: ${p.dias ? p.dias.join(", ") : "Sin dias"} | Hora: ${p.hora || "Sin hora"}</p>
                    <p>Paseador: ${paseadorNombre} ${paseadorFotoHtml}</p>
                </div>`;
                cargarEstadisticasPerro(perroId, p.nombre);
                escucharPaseoActivo(perroId, p.nombre);
            }
        });
    }

// Calcula el lunes de la semana a la que pertenece una fecha (YYYY-MM-DD),
// para poder agrupar el historial "por semana" sin depender de una
// libreria externa de fechas.
function obtenerLunesDeSemana(fechaStr) {
    const d = new Date(fechaStr + "T00:00:00");
    const dia = (d.getDay() + 6) % 7; // lunes = 0 ... domingo = 6
    d.setDate(d.getDate() - dia);
    return d.toISOString().split("T")[0];
}

async function cargarEstadisticasPerro(perroId, nombrePerro) {
    if (!estadisticasEl) return;
    const snap = await get(ref(db, "estadisticas/" + perroId));
    const stats = snap.val();
    if (!stats) {
        estadisticasEl.innerHTML += `<div class="info-box" style="margin-top:10px;"><p><b>📊 ${nombrePerro}:</b> Sin datos aun</p></div>`;
        return;
    }
    const km = (stats.totalMetros / 1000).toFixed(2);
    const horas = (stats.totalMinutos / 60).toFixed(1);
    let porDia = "";
    let porSemana = "";
    if (stats.historial) {
        const fechas = Object.keys(stats.historial).sort().reverse();

        // Por dia: los ultimos 5, cada uno con su miniatura del recorrido
        porDia = fechas.slice(0, 5).map(f => {
            const h = stats.historial[f];
            const miniatura = h.imagenRuta
                ? `<img src="${h.imagenRuta}" style="width:56px;height:42px;object-fit:cover;border-radius:6px;margin-right:8px;vertical-align:middle;border:1px solid #ccc;">`
                : "";
            return `<div style="display:flex;align-items:center;margin-bottom:6px;">${miniatura}<span style="font-size:12px;color:#666;">📅 ${f}: ${(h.metros/1000).toFixed(2)}km en ${h.minutos}min</span></div>`;
        }).join("");

        // Por semana: se suman los paseos que caen en la misma semana
        // (de lunes a domingo) y se muestran las ultimas 4 semanas.
        const semanas = {};
        fechas.forEach(f => {
            const h = stats.historial[f];
            const clave = obtenerLunesDeSemana(f);
            if (!semanas[clave]) semanas[clave] = { metros: 0, minutos: 0 };
            semanas[clave].metros += h.metros;
            semanas[clave].minutos += h.minutos;
        });
        porSemana = Object.keys(semanas).sort().reverse().slice(0, 4).map(clave => {
            const s = semanas[clave];
            return `<span style="font-size:12px;color:#666;">🗓️ Semana del ${clave}: ${(s.metros/1000).toFixed(2)}km en ${(s.minutos/60).toFixed(1)}h</span>`;
        }).join("<br>");
    }
    estadisticasEl.innerHTML += `
    <div class="info-box" style="margin-top:10px;">
        <p><b>📊 ${nombrePerro}</b></p>
        <p>🐾 Total paseos: ${stats.totalPaseos}</p>
        <p>📏 Distancia total: ${km} km</p>
        <p>⏱️ Tiempo total: ${horas} h</p>
        <p>📅 Ultimo paseo: ${stats.ultimoPaseo ? new Date(stats.ultimoPaseo).toLocaleDateString() : "N/A"}</p>
        <p style="margin-top:8px;font-size:13px;"><b>Por dia:</b></p>
        <div>${porDia}</div>
        <p style="margin-top:8px;font-size:13px;"><b>Por semana:</b></p>
        <div>${porSemana}</div>
    </div>`;
}

    function escucharPaseoActivo(perroId, perroNombre) {
        const estadoPaseo = document.getElementById("estadoPaseo");
        const infoUbicacion = document.getElementById("infoUbicacion");

        onValue(ref(db, "paseos"), snapshot => {
            const paseos = snapshot.val() || {};
            // Busca el paseo activo de ESTE perro, sin importar que paseador lo trae
            // (la asignacion ya no es fija a un solo paseador)
            const activo = Object.entries(paseos).find(([id, p]) =>
                p.estado === "activo" && p.perros && p.perros[perroId]
            );

            if (activo) {
                const [paseoId, p] = activo;
                estadoPaseo.className = "estado-paseo en-curso";
                estadoPaseo.innerHTML = `🟡 ${perroNombre} esta en paseo!`;
                const tiempo = p.inicio ? calcularTiempo(p.inicio) : "00:00:00";
                infoUbicacion.innerHTML = `Paseador: <b>${p.paseadorNombre}</b> | Tiempo: ${tiempo} | Distancia: ${formatDistancia(calcularDistanciaRuta(p.ubicaciones))}`;

                const defaultLat = 19.4326, defaultLon = -99.1332;
                const ubs = normalizarUbicaciones(p.ubicaciones);
                const last = ubs.length > 0 ? ubs[ubs.length - 1] : null;
                const centerLat = last ? last.lat : (p.lat || defaultLat);
                const centerLon = last ? last.lon : (p.lon || defaultLon);

                if (!mapaLeaflet && mapaCliente) {
                    mapaCliente.innerHTML = '<div id="leafletMap" style="width:100%;height:250px;border-radius:12px;"></div>';
                    mapaLeaflet = L.map("leafletMap").setView([centerLat, centerLon], 15);
                    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                        attribution: "&copy; OpenStreetMap"
                    }).addTo(mapaLeaflet);
                } else if (mapaLeaflet && last) {
                    mapaLeaflet.setView([last.lat, last.lon], 15);
                }

                if (mapaLeaflet && ubs.length > 0) {
                    if (polyline) mapaLeaflet.removeLayer(polyline);
                    markers.forEach(m => mapaLeaflet.removeLayer(m));
                    markers = [];

                    const latlngs = ubs.map(u => [u.lat, u.lon]);
                    polyline = L.polyline(latlngs, {color: "red", weight: 4}).addTo(mapaLeaflet);
                    mapaLeaflet.fitBounds(polyline.getBounds(), {padding: [20,20]});

                    // Marcador del punto de INICIO del paseo (fijo, no se mueve) -- bandera azul
                    const inicioPunto = ubs[0];
                    const iconoInicio = crearIconoBandera("#1565c0");
                    const mInicio = L.marker([inicioPunto.lat, inicioPunto.lon], {icon: iconoInicio}).addTo(mapaLeaflet);
                    mInicio.bindPopup("🔵 Aquí inició el paseo");
                    markers.push(mInicio);

                    const iconos = {agua:"💧", popo:"💩", comida:"🍖", olfateo:"👃"};
                    ubs.forEach(u => {
                        if (u.evento && iconos[u.evento]) {
                            const icon = L.divIcon({
                                html: `<div style="font-size:22px;background:rgba(255,255,255,0.8);border-radius:50%;padding:2px;">${iconos[u.evento]}</div>`,
                                className: '', iconSize: [30,30], iconAnchor: [15,15]
                            });
                            const m = L.marker([u.lat, u.lon], {icon}).addTo(mapaLeaflet);
                            m.bindPopup(iconos[u.evento]);
                            markers.push(m);
                        }
                    });

                    const anterior = ubs.length > 1 ? ubs[ubs.length - 2] : null;
                    const mirar = anterior && anterior.lon > last.lon ? -1 : 1;
                    const iconoPerro = L.divIcon({
                        html: `<div class="marcador-perro-caminando" style="--flip:${mirar};">🐕</div>`,
                        className: '', iconSize: [40,40], iconAnchor: [20,20]
                    });
                    const m = L.marker([last.lat, last.lon], {icon: iconoPerro}).addTo(mapaLeaflet);
                    m.bindPopup("🐕 Tu perro va caminando por aquí").openPopup();
                    markers.push(m);
                }
            } else {
                estadoPaseo.className = "estado-paseo disponible";
                estadoPaseo.innerHTML = "🟢 Tu perro esta en casa";
                if (mapaCliente) mapaCliente.innerHTML = '<p style="font-size:60px;">🏠</p><p>Tu perro esta seguro en casa</p>';
                infoUbicacion.innerHTML = "Esperando inicio de paseo...";
                if (mapaLeaflet) { mapaLeaflet.remove(); mapaLeaflet = null; }
                polyline = null; markers = [];
            }
        });
    }

    async function cargarFotosCliente() {
        const fotosEl = document.getElementById("fotosCliente");
        if (!fotosEl) return;

        const fotosSnap = await get(ref(db, "fotos"));
        const fotos = fotosSnap.val() || {};
        const misFotos = [];

        Object.entries(fotos).forEach(([id, f]) => {
            if (f.perros) {
                const esMio = Object.values(f.perros).some(p => p.clienteId === uid);
                if (esMio) misFotos.push(f);
            }
        });

        misFotos.sort((a,b) => new Date(b.fecha) - new Date(a.fecha));

        if (misFotos.length === 0) {
            fotosEl.innerHTML = '<p style="grid-column:1/-1;color:#666;text-align:center;">No hay fotos de paseos aún.</p>';
            return;
        }

        fotosEl.innerHTML = "";
        misFotos.slice(0, 6).forEach(f => {
            const div = document.createElement("div");
            div.style.cssText = "background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);";
            div.innerHTML = `
                <img src="${f.imagen}" style="width:100%;height:100px;object-fit:cover;">
                <p style="font-size:11px;padding:6px;margin:0;color:#666;text-align:center;">
                    🕒 ${new Date(f.fecha).toLocaleDateString()}
                </p>
            `;
            fotosEl.appendChild(div);
        });
    }

    cargarFotosCliente();
}

function calcularTiempo(horaInicio) {
    const diff = Math.floor((new Date() - new Date(horaInicio)) / 1000);
    return formatTiempo(diff);
}


// ======================================
// PANEL ADMIN - MAPA LEAFLET + ESTADISTICAS + GALERIA LOCAL
// ======================================
if (document.getElementById("totalPerros")) {
    const tipoSesion = localStorage.getItem("dogmy_tipo");
    if (tipoSesion !== "admin") window.location.href = "index.html";

    onValue(ref(db, "usuarios"), snapshot => {
        const usuarios = snapshot.val() || {};
        document.getElementById("totalPaseadores").textContent = Object.values(usuarios).filter(u => u.tipo === "paseador").length;
        document.getElementById("totalClientes").textContent = Object.values(usuarios).filter(u => u.tipo === "cliente").length;
        const activos = Object.values(usuarios).filter(u => u.tipo === "paseador" && u.activo);
        document.getElementById("paseosActivos").textContent = activos.length;
    });

    onValue(ref(db, "perros"), snapshot => {
        const perros = snapshot.val() || {};
        document.getElementById("totalPerros").textContent = Object.keys(perros).length;
    });

    let mapaAdmin = null;
    let adminPolylines = [];
    let adminMarkers = [];

    function initMapaAdmin() {
        const mapaBox = document.getElementById("mapaBox");
        if (!mapaBox) return;
        mapaBox.innerHTML = '<div id="adminLeafletMap" style="width:100%;height:300px;border-radius:12px;"></div>';
        mapaAdmin = L.map("adminLeafletMap").setView([19.4326, -99.1332], 12);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: "&copy; OpenStreetMap"
        }).addTo(mapaAdmin);
    }
    initMapaAdmin();

    function actualizarRastreo() {
        const lista = document.getElementById("listaPaseadoresActivos");
        onValue(ref(db, "paseos"), snapshot => {
            const paseos = snapshot.val() || {};
            const activos = Object.entries(paseos).filter(([id, p]) => p.estado === "activo");

            adminPolylines.forEach(l => { if(mapaAdmin) mapaAdmin.removeLayer(l); });
            adminMarkers.forEach(m => { if(mapaAdmin) mapaAdmin.removeLayer(m); });
            adminPolylines = [];
            adminMarkers = [];

            if (activos.length === 0) {
                if (lista) lista.innerHTML = '<p class="sin-paseos">Ningun paseo en curso</p>';
                return;
            }
            if (lista) lista.innerHTML = "";
            const bounds = [];
            const iconos = {agua:"💧", popo:"💩", comida:"🍖", olfateo:"👃"};

            activos.forEach(([paseoId, p]) => {
                const tiempo = p.inicio ? calcularTiempo(p.inicio) : "00:00:00";
                const nombresPerros = Object.values(p.perros || {}).map(x => x.nombre).join(", ");

                if (lista) {
                    lista.innerHTML += `
                    <div class="paseador-activo">
                        <p class="nombre">${p.paseadorNombre} - En paseo</p>
                        <p>Perros: <b>${nombresPerros}</b></p>
                        <p>Tiempo: <b>${tiempo}</b> | Distancia: ${formatDistancia(calcularDistanciaRuta(p.ubicaciones))}</p>
                        <p>${p.lat ? '📍 Lat: ' + p.lat.toFixed(5) + ', Lon: ' + p.lon.toFixed(5) : 'Esperando ubicacion...'}</p>
                    </div>`;
                }

                if (mapaAdmin && p.ubicaciones) {
                    const ubs = normalizarUbicaciones(p.ubicaciones);
                    if (ubs.length > 0) {
                        const latlngs = ubs.map(u => [u.lat, u.lon]);
                        const pl = L.polyline(latlngs, {color: "red", weight: 4}).addTo(mapaAdmin);
                        adminPolylines.push(pl);
                        bounds.push(...latlngs);

                        const last = ubs[ubs.length - 1];
                        const anteriorAdmin = ubs.length > 1 ? ubs[ubs.length - 2] : null;
                        const mirarAdmin = anteriorAdmin && anteriorAdmin.lon > last.lon ? -1 : 1;
                        const iconoPerroAdmin = L.divIcon({
                            html: `<div class="marcador-perro-caminando" style="--flip:${mirarAdmin};">🐕</div>`,
                            className: '', iconSize: [40,40], iconAnchor: [20,20]
                        });
                        const marker = L.marker([last.lat, last.lon], {icon: iconoPerroAdmin}).addTo(mapaAdmin);
                        marker.bindPopup(`<b>${p.paseadorNombre}</b><br>Perros: ${nombresPerros}<br>⏱️ ${tiempo}`);
                        adminMarkers.push(marker);

                        // Marcador del punto de INICIO del paseo (fijo, no se mueve) -- bandera azul
                        const inicioPunto = ubs[0];
                        const iconoInicioAdmin = crearIconoBandera("#1565c0");
                        const mInicioAdmin = L.marker([inicioPunto.lat, inicioPunto.lon], {icon: iconoInicioAdmin}).addTo(mapaAdmin);
                        mInicioAdmin.bindPopup(`🔵 Inicio del paseo de <b>${p.paseadorNombre}</b>`);
                        adminMarkers.push(mInicioAdmin);

                        ubs.forEach(u => {
                            if (u.evento && iconos[u.evento]) {
                                const icon = L.divIcon({
                                    html: `<div style="font-size:20px;background:rgba(255,255,255,0.8);border-radius:50%;padding:2px;">${iconos[u.evento]}</div>`,
                                    className: '', iconSize: [25,25], iconAnchor: [12,12]
                                });
                                const m = L.marker([u.lat, u.lon], {icon}).addTo(mapaAdmin);
                                adminMarkers.push(m);
                            }
                        });
                    }
                }
            });

            if (bounds.length > 0 && mapaAdmin) {
                mapaAdmin.fitBounds(bounds, {padding: [30,30]});
            }
        });
    }
    actualizarRastreo();

    // GALERIA EN LA NUBE
    const btnGaleria = document.getElementById("btnGaleria");
    if (btnGaleria) {
        btnGaleria.addEventListener("click", async function() {
            const galeriaBox = document.getElementById("galeriaBox");
            galeriaBox.style.display = galeriaBox.style.display === "none" ? "block" : "none";
            if (galeriaBox.style.display === "none") return;

            galeriaBox.innerHTML = "<p style='text-align:center;padding:20px;'>Cargando fotos...</p>";

            const fotosSnap = await get(ref(db, "fotos"));
            const fotos = fotosSnap.val() || {};
            const lista = Object.entries(fotos).sort((a,b) => new Date(b[1].fecha) - new Date(a[1].fecha));

            if (lista.length === 0) {
                galeriaBox.innerHTML = '<p style="text-align:center;padding:20px;">No hay fotos en la nube aún.</p>';
                return;
            }
            let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px;">';
            lista.forEach(([id, f]) => {
                const fecha = new Date(f.fecha).toLocaleString();
                const nombresPerros = f.perros ? Object.values(f.perros).map(p => p.nombre).join(", ") : "Sin perro";
                html += `
                    <div style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
                        <img src="${f.imagen}" style="width:100%;height:120px;object-fit:cover;">
                        <p style="font-size:11px;padding:8px;margin:0;color:#666;">
                            📷 ${f.paseadorNombre || 'Paseador'}<br>
                            🐶 ${nombresPerros}<br>
                            🕒 ${fecha}
                        </p>
                    </div>
                `;
            });
            html += '</div>';
            html += '<button onclick="limpiarGaleriaNube()" style="background:#d32f2f;margin-top:10px;">🗑️ Limpiar Galería de la Nube</button>';
            galeriaBox.innerHTML = html;
        });
    }

    window.limpiarGaleriaNube = async function() {
        if (!confirm("¿Eliminar TODAS las fotos de la nube? Esto las borrará de todos los dispositivos.")) return;
        await remove(ref(db, "fotos"));
        const galeriaBox = document.getElementById("galeriaBox");
        if (galeriaBox) galeriaBox.innerHTML = '<p style="text-align:center;padding:20px;">Galería vacía.</p>';
    };

    window.restablecerContrasena = function() {
        const usuario = prompt("Ingrese el usuario a restablecer:");
        if (!usuario) return;
        get(query(ref(db, "usuarios"), orderByChild("usuario"), equalTo(usuario))).then(async snapshot => {
            if (!snapshot.exists()) { alert("Usuario no encontrado."); return; }
            const data = snapshot.val();
            const uid = Object.keys(data)[0];
            const nuevaContrasena = prompt("Nueva contraseña para " + usuario + ":");
            if (!nuevaContrasena) return;
            const salt = generarSalt();
            const contrasenaHash = await hashContrasena(nuevaContrasena, salt);
            update(ref(db, "usuarios/" + uid), { contrasenaHash, salt, contrasena: null }).then(() => {
                alert("Contrasena actualizada correctamente.");
            });
        });
    };

    // Permite que el administrador que tiene la sesion abierta cambie su
    // propio correo (usado como usuario de acceso) y su contrasena, sin
    // necesidad de saber el usuario/contrasena actual de memoria.
    window.cambiarMisDatosAcceso = function() {
        const uidActual = localStorage.getItem("dogmy_uid");
        if (!uidActual) { alert("No se detecto sesion activa."); return; }
        const nuevoCorreo = prompt("Nuevo correo con el que quieres entrar:");
        if (!nuevoCorreo) return;
        if (!nuevoCorreo.includes("@") || !nuevoCorreo.includes(".")) {
            alert("Ingresa un correo valido (ej: nombre@correo.com).");
            return;
        }
        const nuevaContrasena = prompt("Nueva contraseña (minimo 4 caracteres):");
        if (!nuevaContrasena) return;
        if (nuevaContrasena.length < 4) {
            alert("La contraseña debe tener al menos 4 caracteres.");
            return;
        }
        get(query(ref(db, "usuarios"), orderByChild("usuario"), equalTo(nuevoCorreo))).then(async snapExiste => {
            if (snapExiste.exists() && Object.keys(snapExiste.val())[0] !== uidActual) {
                alert("Ese correo ya lo esta usando otra cuenta.");
                return;
            }
            const salt = generarSalt();
            const contrasenaHash = await hashContrasena(nuevaContrasena, salt);
            await update(ref(db, "usuarios/" + uidActual), { usuario: nuevoCorreo, contrasenaHash, salt, contrasena: null });
            localStorage.setItem("dogmy_usuario", nuevoCorreo);
            alert("Listo. Desde ahora entra con: " + nuevoCorreo);
        });
    };
}

// ======================================
// AGENDA
// ======================================
const listaAgenda = document.getElementById("listaAgenda");
if (listaAgenda) {
    const filtroPaseador = document.getElementById("filtroPaseador");
    const paseadoresQuery = query(ref(db, "usuarios"), orderByChild("tipo"), equalTo("paseador"));
    onValue(paseadoresQuery, snapshot => {
        if (!filtroPaseador) return;
        filtroPaseador.innerHTML = '<option value="">Todos los paseadores</option>';
        const data = snapshot.val() || {};
        Object.entries(data).forEach(([uid, p]) => {
            const opt = document.createElement("option");
            opt.value = uid;
            opt.textContent = p.nombre;
            filtroPaseador.appendChild(opt);
        });
    });
    function mostrarAgenda(filtroId) {
        onValue(ref(db, "perros"), snapshot => {
            const perros = snapshot.val() || {};
            const lista = Object.entries(perros);
            const filtrados = filtroId ? lista.filter(([id, p]) => p.paseadorId === filtroId) : lista;
            if (filtrados.length === 0) {
                listaAgenda.innerHTML = "<p>Sin paseos registrados.</p>";
                return;
            }
            listaAgenda.innerHTML = "";
            filtrados.forEach(async function ([perroId, perro]) {
                const diasTexto = perro.dias && perro.dias.length > 0 ? perro.dias.join(", ") : "Sin asignar";
                const horaTexto = perro.hora && perro.hora !== "" ? perro.hora : "Sin horario";
                let paseadorNombre = "Sin asignar";
                if (perro.paseadorId) {
                    const ps = await get(ref(db, "usuarios/" + perro.paseadorId));
                    const pd = ps.val();
                    if (pd) paseadorNombre = pd.nombre;
                }
                listaAgenda.innerHTML += `
                <div class="tarjeta" style="margin-bottom:15px;text-align:left;">
                    <h3>${perro.nombre}</h3>
                    <p><b>Cliente:</b> ${perro.clienteNombre}</p>
                    <p><b>Raza:</b> ${perro.raza}</p>
                    <p><b>Edad:</b> ${perro.edad} anos</p>
                    <p><b>Dias:</b> ${diasTexto}</p>
                    <p><b>Hora:</b> ${horaTexto}</p>
                    <p><b>Paseador:</b> ${paseadorNombre}</p>
                    <button onclick="editarPerro('${perroId}')" style="background:#ff9800;width:auto;padding:8px 14px;font-size:13px;margin-top:6px;margin-right:5px;">✏️ Editar</button>
                    <button onclick="eliminarPerro('${perroId}')" style="background:#d32f2f;width:auto;padding:8px 14px;font-size:13px;margin-top:6px;">🗑️ Dar de Baja</button>
                    <hr>
                </div>`;
            });
        });
    }
    mostrarAgenda(null);
    window.filtrarAgenda = function () { mostrarAgenda(filtroPaseador.value); };
}

// ======================================
// LISTA DE CLIENTES
// ======================================
const listaClientes = document.getElementById("listaClientes");
if (listaClientes) {
    const clientesQuery = query(ref(db, "usuarios"), orderByChild("tipo"), equalTo("cliente"));
    onValue(clientesQuery, snapshot => {
        const clientes = snapshot.val() || {};
        listaClientes.innerHTML = "";
        if (Object.keys(clientes).length === 0) {
            listaClientes.innerHTML = '<p>No hay clientes registrados.</p>';
            return;
        }
        Object.entries(clientes).forEach(([uid, cliente]) => {
            const perrosQuery = query(ref(db, "perros"), orderByChild("clienteId"), equalTo(uid));
            get(perrosQuery).then(perrosSnap => {
                const perros = perrosSnap.val() || {};
                const count = Object.keys(perros).length;
                const div = document.createElement("div");
                div.className = "tarjeta";
                div.style.cssText = "margin-bottom:15px;text-align:left;";
                div.innerHTML = `
                    <h3>${cliente.nombre}</h3>
                    <p>${cliente.telefono}</p>
                    <p>${cliente.direccion}</p>
                    <p>Usuario: ${cliente.usuario}</p>
                    <button onclick="verPerrosCliente('${uid}')" style="margin-top:8px;">Ver Perros (${count})</button>
                    <button onclick="editarCliente('${uid}')" style="background:#ff9800;">Editar</button>
                    <button onclick="eliminarCliente('${uid}')" style="background:#d32f2f;">Dar de baja</button>
                `;
                listaClientes.appendChild(div);
            });
        });
    });
}

// ======================================
// FUNCIONES DE CLIENTES
// ======================================
window.verPerrosCliente = function (clienteId) {
    const perrosQuery = query(ref(db, "perros"), orderByChild("clienteId"), equalTo(clienteId));
    get(perrosQuery).then(snapshot => {
        const perros = snapshot.val() || {};
        const lista = Object.values(perros);
        if (lista.length === 0) { alert("Este cliente no tiene perros registrados."); return; }
        let mensaje = "Perros registrados:\n\n";
        lista.forEach(p => {
            mensaje += "• " + p.nombre + " (" + p.raza + ", " + p.edad + " anos)\n";
            mensaje += "  Dias: " + (p.dias ? p.dias.join(", ") : "Ninguno") + " | Hora: " + (p.hora || "Sin hora") + "\n\n";
        });
        alert(mensaje);
    });
};

window.editarCliente = function (id) {
    get(ref(db, "usuarios/" + id)).then(snapshot => {
        const cliente = snapshot.val();
        if (!cliente) return;
        const nuevoNombre = prompt("Nuevo nombre:", cliente.nombre);
        if (nuevoNombre === null) return;
        const nuevoTelefono = prompt("Nuevo telefono:", cliente.telefono);
        const nuevaDireccion = prompt("Nueva direccion:", cliente.direccion);
        const updates = {};
        if (nuevoNombre) updates.nombre = nuevoNombre.trim();
        if (nuevoTelefono) updates.telefono = nuevoTelefono.trim();
        if (nuevaDireccion) updates.direccion = nuevaDireccion.trim();
        update(ref(db, "usuarios/" + id), updates).then(() => alert("Cliente actualizado."));
    });
};

window.eliminarCliente = function (id) {
    if (!confirm("Eliminar este cliente y todos sus perros?")) return;
    remove(ref(db, "usuarios/" + id)).then(() => {
        const perrosQuery = query(ref(db, "perros"), orderByChild("clienteId"), equalTo(id));
        get(perrosQuery).then(snap => {
            const perros = snap.val() || {};
            const updates = {};
            Object.keys(perros).forEach(key => updates[key] = null);
            update(ref(db, "perros"), updates).then(() => alert("Cliente y sus perros eliminados."));
        });
    });
};

// ======================================
// CERRAR SESION
// ======================================
window.cerrarSesion = function () {
    localStorage.removeItem("dogmy_uid");
    localStorage.removeItem("dogmy_tipo");
    localStorage.removeItem("dogmy_usuario");
    window.location.href = "index.html";
};


// ======================================
// ADMIN: LISTA DE PASEADORES + EDITAR + ELIMINAR + VER PERROS + FINALIZAR PASEOS
// ======================================
const listaPaseadoresEl = document.getElementById("listaPaseadores");
if (listaPaseadoresEl) {
    const paseadoresQuery = query(ref(db, "usuarios"), orderByChild("tipo"), equalTo("paseador"));
    onValue(paseadoresQuery, snapshot => {
        const paseadores = snapshot.val() || {};
        listaPaseadoresEl.innerHTML = "";
        if (Object.keys(paseadores).length === 0) {
            listaPaseadoresEl.innerHTML = '<p>No hay paseadores registrados.</p>';
            return;
        }
        Object.entries(paseadores).forEach(([uid, p]) => {
            const perrosQuery = query(ref(db, "perros"), orderByChild("paseadorId"), equalTo(uid));
            get(perrosQuery).then(perrosSnap => {
                const perros = perrosSnap.val() || {};
                const count = Object.keys(perros).length;
                const div = document.createElement("div");
                div.className = "paseador-card";
                const fotoHtml = p.fotoPerfil
                    ? `<img src="${p.fotoPerfil}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;float:left;margin-right:10px;border:2px solid #2e7d32;">`
                    : "";
                div.innerHTML = `
                    ${fotoHtml}
                    <h4>🚶 ${p.nombre}</h4>
                    <p>📱 Tel: ${p.telefono || "Sin teléfono"}</p>
                    <p>👤 Usuario: ${p.usuario}</p>
                    <p>🐶 Perros asignados: <b>${count}</b></p>
                    <p>Estado: ${p.activo ? '🟡 En paseo' : '🟢 Disponible'}</p>
                    <div style="clear:both;"></div>
                    <button onclick="verPerrosPaseador('${uid}')" class="btn-azul">🐶 Ver Perros (${count})</button>
                    <button onclick="editarPaseador('${uid}')" class="btn-naranja">✏️ Editar</button>
                    <button onclick="eliminarPaseador('${uid}')" class="btn-rojo">🗑️ Dar de Baja</button>
                    ${p.activo ? `<button onclick="finalizarPaseoDesdeAdmin('${uid}')" class="btn-morado">⏹ Finalizar Paseo</button>` : ''}
                `;
                listaPaseadoresEl.appendChild(div);
            });
        });
    });
}

window.verPerrosPaseador = function(paseadorId) {
    const perrosQuery = query(ref(db, "perros"), orderByChild("paseadorId"), equalTo(paseadorId));
    get(perrosQuery).then(snapshot => {
        const perros = snapshot.val() || {};
        const lista = Object.values(perros);
        if (lista.length === 0) { alert("Este paseador no tiene perros asignados."); return; }
        let mensaje = "Perros asignados:\n\n";
        lista.forEach(p => {
            mensaje += "• " + p.nombre + " (" + p.raza + ", " + p.edad + " años)\n";
            mensaje += "  Cliente: " + p.clienteNombre + "\n";
            mensaje += "  Días: " + (p.dias ? p.dias.join(", ") : "Ninguno") + " | Hora: " + (p.hora || "Sin hora") + "\n\n";
        });
        alert(mensaje);
    });
};

window.editarPaseador = function(id) {
    get(ref(db, "usuarios/" + id)).then(snapshot => {
        const paseador = snapshot.val();
        if (!paseador) return;
        const nuevoNombre = prompt("Nuevo nombre:", paseador.nombre);
        if (nuevoNombre === null) return;
        const nuevoTelefono = prompt("Nuevo teléfono:", paseador.telefono);
        const nuevoUsuario = prompt("Nuevo usuario:", paseador.usuario);
        const updates = {};
        if (nuevoNombre) updates.nombre = nuevoNombre.trim();
        if (nuevoTelefono !== null) updates.telefono = nuevoTelefono.trim();
        if (nuevoUsuario) {
            let usuarioLimpio = nuevoUsuario.trim();
            if (!usuarioLimpio.startsWith("@")) usuarioLimpio = "@" + usuarioLimpio;
            updates.usuario = usuarioLimpio;
        }
        update(ref(db, "usuarios/" + id), updates).then(() => alert("Paseador actualizado."));
    });
};

window.eliminarPaseador = function(id) {
    if (!confirm("¿Eliminar este paseador? Se desasignarán sus perros.")) return;
    const perrosQuery = query(ref(db, "perros"), orderByChild("paseadorId"), equalTo(id));
    get(perrosQuery).then(snap => {
        const perros = snap.val() || {};
        const updates = {};
        Object.keys(perros).forEach(key => { updates[key] = { paseadorId: null }; });
        update(ref(db, "perros"), updates).then(() => {
            remove(ref(db, "usuarios/" + id)).then(() => {
                alert("Paseador eliminado. Sus perros quedaron sin asignar.");
            });
        });
    });
};

window.finalizarPaseoDesdeAdmin = async function(paseadorId) {
    if (!confirm("¿Finalizar el paseo activo de este paseador?")) return;
    const snap = await get(ref(db, "usuarios/" + paseadorId));
    const data = snap.val();
    if (!data || !data.activo || !data.paseoActualId) {
        alert("Este paseador no tiene paseo activo.");
        return;
    }
    try {
        const paseoSnap = await get(ref(db, "paseos/" + data.paseoActualId));
        const paseo = paseoSnap.val();
        if (paseo) {
            const fin = new Date().toISOString();
            const inicio = paseo.inicio ? new Date(paseo.inicio) : new Date();
            let minutos = Math.floor((new Date(fin) - inicio) / 60000);
            if (!Number.isFinite(minutos) || minutos < 0) minutos = 0;
            const distancia = calcularDistanciaRuta(paseo.ubicaciones);
            const fechaKey = inicio.toISOString().split("T")[0];
            const imagenRuta = generarImagenRuta(paseo.ubicaciones);
            for (const perroId of Object.keys(paseo.perros || {})) {
                try {
                    const statsRef = ref(db, "estadisticas/" + perroId);
                    const statsSnap = await get(statsRef);
                    const stats = statsSnap.val() || { totalPaseos: 0, totalMinutos: 0, totalMetros: 0, historial: {} };
                    stats.totalPaseos = (stats.totalPaseos || 0) + 1;
                    stats.totalMinutos = (stats.totalMinutos || 0) + minutos;
                    stats.totalMetros = (stats.totalMetros || 0) + distancia;
                    stats.ultimoPaseo = fin;
                    stats.historial = stats.historial || {};
                    stats.historial[fechaKey] = { minutos, metros: distancia, fecha: fin, paseoId: data.paseoActualId, imagenRuta };
                    await update(statsRef, stats);
                } catch (errEstadistica) {
                    console.error("Error guardando estadisticas de " + perroId + ":", errEstadistica);
                }
            }
            await update(ref(db, "paseos/" + data.paseoActualId), { fin, estado: "completado", distancia });
        }
        await update(ref(db, "usuarios/" + paseadorId), { activo: false, paseoActualId: null, lat: null, lon: null });
        alert("Paseo finalizado correctamente desde administración.");
    } catch (err) {
        console.error("Error finalizando paseo:", err);
        alert("Hubo un error finalizando este paseo: " + err.message);
    }
};

window.finalizarTodosLosPaseos = async function() {
    const paseosSnap = await get(ref(db, "paseos"));
    const paseos = paseosSnap.val() || {};
    const activos = Object.entries(paseos).filter(([id, p]) => p.estado === "activo");
    if (activos.length === 0) { alert("No hay paseos activos."); return; }
    if (!confirm(`¿Finalizar TODOS los paseos activos? Hay ${activos.length} paseo(s).`)) return;

    let exitosos = 0;
    const errores = [];

    for (const [paseoId, paseo] of activos) {
        try {
            const fin = new Date().toISOString();
            const inicio = paseo.inicio ? new Date(paseo.inicio) : new Date();
            let minutos = Math.floor((new Date(fin) - inicio) / 60000);
            if (!Number.isFinite(minutos) || minutos < 0) minutos = 0;
            const distancia = calcularDistanciaRuta(paseo.ubicaciones);
            const fechaKey = inicio.toISOString().split("T")[0];
            const imagenRuta = generarImagenRuta(paseo.ubicaciones);

            for (const perroId of Object.keys(paseo.perros || {})) {
                try {
                    const statsRef = ref(db, "estadisticas/" + perroId);
                    const statsSnap = await get(statsRef);
                    const stats = statsSnap.val() || { totalPaseos: 0, totalMinutos: 0, totalMetros: 0, historial: {} };
                    stats.totalPaseos = (stats.totalPaseos || 0) + 1;
                    stats.totalMinutos = (stats.totalMinutos || 0) + minutos;
                    stats.totalMetros = (stats.totalMetros || 0) + distancia;
                    stats.ultimoPaseo = fin;
                    stats.historial = stats.historial || {};
                    stats.historial[fechaKey] = { minutos, metros: distancia, fecha: fin, paseoId, imagenRuta };
                    await update(statsRef, stats);
                } catch (errEstadistica) {
                    console.error("Error guardando estadisticas de " + perroId + ":", errEstadistica);
                }
            }

            await update(ref(db, "paseos/" + paseoId), { fin, estado: "completado", distancia });
            if (paseo.paseadorId) {
                await update(ref(db, "usuarios/" + paseo.paseadorId), { activo: false, paseoActualId: null, lat: null, lon: null });
            }
            exitosos++;
        } catch (errPaseo) {
            console.error("Error finalizando paseo " + paseoId + ":", errPaseo);
            errores.push(paseoId);
        }
    }

    if (errores.length === 0) {
        alert(`¡Listo! Se finalizaron ${exitosos} paseo(s).`);
    } else {
        alert(`Se finalizaron ${exitosos} de ${activos.length} paseo(s). ${errores.length} tuvieron un error (revisa la consola). Puedes intentar finalizarlos uno por uno.`);
    }
};

// ======================================
// AGENDA: EDITAR Y ELIMINAR PERROS
// ======================================
window.editarPerro = async function(perroId) {
    const snap = await get(ref(db, "perros/" + perroId));
    const perro = snap.val();
    if (!perro) { alert("Perro no encontrado."); return; }
    const nuevoNombre = prompt("Nombre del perro:", perro.nombre);
    if (nuevoNombre === null) return;
    const nuevaRaza = prompt("Raza:", perro.raza);
    const nuevaEdad = prompt("Edad (años):", perro.edad);
    const nuevoColor = prompt("Color:", perro.color || "");
    const nuevoTamano = prompt("Tamaño (Pequeño/Mediano/Grande):", perro.tamano || "");
    const updates = {};
    if (nuevoNombre) updates.nombre = nuevoNombre.trim();
    if (nuevaRaza) updates.raza = nuevaRaza.trim();
    if (nuevaEdad) updates.edad = nuevaEdad.trim();
    if (nuevoColor !== null) updates.color = nuevoColor.trim();
    if (nuevoTamano !== null) updates.tamano = nuevoTamano.trim();
    await update(ref(db, "perros/" + perroId), updates);
    alert("Perro actualizado correctamente.");
};

window.eliminarPerro = async function(perroId) {
    if (!confirm("¿Eliminar este perro permanentemente? También se borrarán sus estadísticas.")) return;
    await remove(ref(db, "perros/" + perroId));
    await remove(ref(db, "estadisticas/" + perroId));
    alert("Perro eliminado correctamente.");
};
