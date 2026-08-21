# DogMy → App Nativa de Android (sin computadora)

Esta guía usa **GitHub Actions** para que la compilación ocurra en la nube.
Tu teléfono solo sube archivos y descarga el resultado (el APK).

---

## FASE 1 — Preparar el repositorio

1. Abre github.com en tu navegador (o la app de GitHub) e inicia sesión con tu
   cuenta (la misma que usas para tu sitio `ship-it.github.io`).

2. Crea un **repositorio nuevo**:
   - Botón "+" → "New repository"
   - Nombre sugerido: `dogmy-native`
   - Marca "Private" si no quieres que se vea públicamente (recomendado, ya
     que va a contener tu configuración de Firebase)
   - Crea el repositorio (puedes dejarlo vacío, sin README)

3. Sube TODA esta carpeta que te preparé (`dogmy_native_setup`) al
   repositorio nuevo:
   - Entra al repositorio → botón "Add file" → "Upload files"
   - Arrastra o selecciona todos los archivos y carpetas que están en el zip
     que te mandé (incluye la carpeta `www/`, `.github/`, `capacitor.config.json`,
     `package.json`, `.gitignore`)
   - **Importante**: al subir por el navegador, GitHub a veces no deja
     arrastrar carpetas completas fácilmente desde el navegador de un
     teléfono. Si tienes problemas, usa la app oficial de GitHub, o dime y
     te preparo un archivo `.zip` con instrucciones para subirlo distinto.
   - Escribe un mensaje como "Primera subida" y confirma ("Commit changes")

4. Verifica que en el repositorio quedó esta estructura:
   ```
   dogmy-native/
   ├── www/
   │   ├── index.html
   │   ├── admin.html
   │   ├── script.js
   │   └── ... (el resto de tus archivos)
   ├── .github/
   │   └── workflows/
   │       └── build-android.yml
   ├── capacitor.config.json
   ├── package.json
   └── .gitignore
   ```

---

## FASE 2 — Compilar el APK en la nube

1. En tu repositorio, ve a la pestaña **"Actions"** (arriba, junto a "Code").

2. Deberías ver un flujo llamado **"Compilar APK de Android"**. Tócalo.

3. Del lado derecho, toca **"Run workflow"** → **"Run workflow"** (botón
   verde) para iniciarlo manualmente.

4. Espera entre 5 y 10 minutos. Puedes salir de la app y regresar después —
   se sigue ejecutando en los servidores de GitHub aunque cierres tu
   teléfono.

5. Cuando termine (ícono verde ✅), entra a esa ejecución y baja hasta
   **"Artifacts"**. Ahí vas a ver **"DogMy-apk-prueba"** — tócalo para
   descargar un `.zip` que contiene tu `app-debug.apk`.

6. Descomprime ese zip en tu teléfono (con cualquier app de archivos/zip que
   ya tengas, como "Files" o "ZArchiver"), y vas a tener el archivo
   `app-debug.apk`.

7. Toca el `.apk` para instalarlo. Android te va a pedir permiso para
   "instalar apps de fuentes desconocidas" — actívalo solo para el
   navegador o app de archivos que estés usando.

8. ¡Listo! Ya tienes DogMy instalado como app nativa de verdad (con su
   propio ícono, sin la barra de Chrome).

**En este punto todavía NO tienes GPS en segundo plano** — la app ya es
nativa, pero el código de rastreo sigue siendo el mismo `watchPosition` de
siempre. Ese es el trabajo de la Fase 3.

---

## FASE 3 — GPS real en segundo plano (siguiente paso)

Esta fase es la que de verdad resuelve el problema del GPS que se corta.
Aquí es donde:
- Conectamos el plugin `@capacitor-community/background-geolocation` (ya
  está en tu `package.json`, se instala solo)
- Modificamos partes de `script.js` para que, cuando la app corra dentro de
  Capacitor (no en un navegador normal), use el plugin nativo en vez de
  `navigator.geolocation`
- Agregamos los permisos de ubicación en segundo plano al `android/` (se
  configuran en un archivo llamado `AndroidManifest.xml` que se genera
  automáticamente al correr el flujo de la Fase 2)

**Vamos a hacer esto en nuestra siguiente conversación, después de que
confirmes que la Fase 1 y 2 te funcionaron** — así no mezclamos errores de
dos fases distintas al mismo tiempo. Cuando tengas tu primer APK instalado
y abriendo bien, regresa y seguimos con la Fase 3.

---

## Si algo falla

- **El flujo de Actions se pone en rojo ❌**: toca la ejecución fallida,
  abre el paso que falló (tiene una ✗) y cópiame el texto del error — con
  eso lo diagnostico.
- **No encuentras el botón "Run workflow"**: asegúrate de que el archivo
  `.github/workflows/build-android.yml` haya quedado exactamente en esa
  ruta (con el punto al inicio de `.github`).
- **El APK se instala pero la app se cierra sola**: mándame captura o video
  del error, igual que la última vez — así lo reviso.

---

## FASE FINAL — El GPS se apaga con la pantalla bloqueada después de un rato (Poco/Xiaomi y Honor)

Esto le pasa a casi cualquier app con GPS en segundo plano en estas dos marcas,
no es un error exclusivo de DogMy: MIUI (Poco) y Magic UI (Honor) tienen su
propio "administrador de batería" además del de Android normal, y con el
tiempo empiezan a matar apps que usan GPS en segundo plano — aunque el
permiso de ubicación esté bien concedido. Por eso funciona recién instalada
y deja de funcionar después de un par de usos.

El código ya le pide a Android la exención estándar de batería
automáticamente (verás un cartel del sistema la primera vez que un
paseador inicie un paseo — hay que tocar "Permitir" ahí). Pero además,
en cada teléfono hay que hacer esto UNA sola vez, a mano:

**En Poco (MIUI):**
1. Ajustes → Apps → Administrar apps → DogMy
2. Ahorro de batería → elegir **"Sin restricciones"**
3. Inicio automático → **activarlo**
4. En la app de "Seguridad" del teléfono → Batería → Ahorro de batería de apps →
   DogMy → **Sin restricciones**

**En Honor (Magic UI):**
1. Ajustes → Batería → Inicio de apps (o "Administración de inicio de apps")
2. Buscar DogMy → desactivar "Gestionar automáticamente" → activar manualmente
   las 3 opciones: Inicio automático, Inicio secundario, y Ejecutar en segundo plano

Sin este paso manual, ningún cambio de código lo soluciona del todo — es una
restricción que ponen esas marcas por fuera de Android, y solo el usuario del
teléfono la puede levantar desde los ajustes del sistema.
