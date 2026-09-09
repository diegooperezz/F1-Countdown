# 🚦 Pulsador F1 — La Porra del Espacio

Un pulsador online para jugar entre amigos, cada uno desde su propio ordenador,
sin necesidad de crear ninguna cuenta. Cuenta atrás estilo semáforo de Fórmula 1
(las 5 luces se encienden una a una y se apagan en un instante **impredecible**);
el primero que pulse **ESPACIO** cuando se apaguen gana la ronda. Si pulsas antes
de tiempo, es **salida nula** y quedas descalificado de esa ronda. Hay marcador
acumulado (puntos y victorias) para varias rondas, como una porra.

No usa ninguna cuenta de Claude ni de ningún otro servicio: es una web normal
(Node.js + Socket.IO) que tienes que alojar tú, aunque sea 2 minutos, para que
tus amigos puedan entrar desde el móvil o el ordenador con un enlace.

## Cómo funciona el juego

1. Alguien entra a la web, pone su nombre y deja el código de sala vacío →
   se crea una sala nueva con un código de 4 letras.
2. Comparte el enlace (botón "Copiar enlace") o el código con el resto.
   Cada amigo entra desde su propio dispositivo con ese mismo código.
3. Cualquiera puede pulsar "Iniciar ronda". Se encienden las 5 luces rojas,
   una por una, y en un momento aleatorio se apagan todas a la vez: esa es la
   señal. El primero en pulsar ESPACIO después del apagón gana la ronda.
4. Al final de cada ronda se ve el podio, las salidas nulas y quién no ha
   llegado a tiempo, además del marcador general acumulado.

**Nota sobre la equidad:** cada jugador mide su tiempo de reacción desde el
instante en que SU pantalla recibe la señal de apagado. Con internet normal la
diferencia entre jugadores es de pocas décimas de milisegundo y no se nota,
pero si alguien tiene una conexión muy mala podría recibir la señal una pizca
más tarde. Es la misma limitación que tiene cualquier juego de reflejos online.

## Opción A · Jugar hoy mismo (rápido, gratis, sin registrarte)

Ideal si solo queréis usarlo un rato, por ejemplo esta noche.

Necesitas tener [Node.js](https://nodejs.org) instalado (versión 18 o
superior) en el ordenador que hará de "anfitrión" (el tuyo).

1. Descomprime este proyecto y abre una terminal dentro de la carpeta.
2. Instala las dependencias:
   ```
   npm install
   ```
3. Arranca el servidor:
   ```
   npm start
   ```
   Verás `Pulsador F1 escuchando en el puerto 3000`. Puedes abrir
   `http://localhost:3000` en tu propio navegador para probarlo.
4. Para que tus amigos puedan entrar desde fuera de tu casa, abre **otra**
   terminal (deja la del servidor abierta) y ejecuta:
   ```
   npx localtunnel --port 3000
   ```
   Te dará una URL pública tipo `https://algo-random.loca.lt`. Compártela con
   tus amigos. La primera vez que alguien la abra, localtunnel puede mostrar
   un aviso con un botón "Click to Continue": es normal, solo hay que pulsarlo.
5. Mientras jugáis, deja tu ordenador y las dos terminales abiertas (el
   servidor y el túnel). Al terminar, puedes cerrarlas con `Ctrl+C`.

## Opción B · Alojarlo gratis y para siempre (Render.com)

Ideal si vais a repetir la porra más veces y queréis un enlace fijo que no
dependa de que tengas tu ordenador encendido.

1. Crea una cuenta gratuita en [github.com](https://github.com) (si no
   tienes) y otra en [render.com](https://render.com) (puedes entrar
   directamente con tu cuenta de GitHub).
2. En GitHub, crea un repositorio nuevo (público o privado, da igual).
3. Dentro del repositorio, usa "Add file" → "Upload files" y arrastra **todo
   el contenido** de esta carpeta (server.js, package.json, la carpeta
   `public/` completa, etc. — no hace falta subir `node_modules` si lo
   tuvieras). Confirma los cambios ("Commit changes").
4. En Render, pulsa "New +" → "Web Service" y conecta ese repositorio.
5. Configura:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
6. Pulsa "Create Web Service" y espera 1-2 minutos. Render te dará una URL
   fija como `https://pulsador-f1.onrender.com`. Esa es la que compartes
   siempre con tus amigos.

**Detalle del plan gratuito de Render:** si nadie la usa durante 15 minutos,
la web "se duerme" y tarda unos 30-50 segundos en despertar la próxima vez
que alguien entra. Truco: abre tú el enlace un par de minutos antes de
empezar a jugar para que esté ya despierta cuando lleguen los demás.

## Estructura del proyecto

```
pulsador-f1/
├── package.json
├── server.js          servidor Node + Socket.IO (toda la lógica del juego)
└── public/
    ├── index.html      las 4 pantallas: entrar, sala de espera, carrera, resultados
    ├── style.css       estilo semáforo/carreras
    └── client.js       lógica de cliente: sockets, semáforo, teclado
```

## Personalizar

- **Velocidad del semáforo / rango del apagón aleatorio:** al principio de
  `server.js`, las constantes `LIGHT_INTERVAL_MS`, `GO_DELAY_MIN_MS` y
  `GO_DELAY_MAX_MS`.
- **Puntuación por ronda:** la constante `pointsTable` en `server.js`
  (por defecto 5-3-2-1 puntos para los 4 primeros).
- **Colores y estilo:** `public/style.css`.
