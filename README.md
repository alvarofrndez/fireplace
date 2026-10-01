# Fireplace — Ambient Fireplace

Chimenea virtual realista para dejar encendida de fondo durante horas: fuego simulado en tiempo
real con WebGL y sonido ambiente de leña generado al momento con Web Audio. Sin vídeos, sin
grabaciones y sin bucles: nunca se repite.

## Puesta en marcha

Requisitos: Node.js 20.9 o superior.

```bash
npm install
npm run dev
```

Abre la URL que muestra la consola (normalmente <http://localhost:3000>) y pulsa
**Enciende la chimenea**. Los navegadores no permiten reproducir sonido sin una interacción
previa: ese clic es el que arranca a la vez la animación y el audio.

Versión de producción:

```bash
npm run build
npm start
```

Otros scripts: `npm run lint` (ESLint) y `npm run typecheck` (TypeScript).

## Controles

Los controles aparecen al mover el ratón, tocar la pantalla o usar el teclado, y se desvanecen
tras unos segundos sin actividad (también el cursor).

| Acción                         | Botón | Teclado            |
| ------------------------------ | ----- | ------------------ |
| Reproducir / pausar            | ⏯     | `Espacio` o `K`    |
| Silenciar / activar sonido     | 🔈    | `M`                |
| Volumen                        | slider | `↑` / `↓`         |
| Pantalla completa              | ⛶     | `F` o doble clic   |
| Ocultar / mostrar controles    | 👁    | `H`                |

Con los controles ocultos solo aparece, al mover el ratón o tocar, un pequeño botón en la
esquina inferior derecha para recuperarlos.

Se guardan en `localStorage` el volumen, el silencio, la preferencia de pantalla completa (se
vuelve a aplicar al encender la chimenea) y si los controles están ocultos.

## Cómo funciona

**Fuego (WebGL, `src/lib/fire`)**

- *Simulación de fluidos en GPU* (`FluidFire.ts`, `shaders/sim.ts`): velocidad, presión,
  temperatura, combustible y humo. El combustible se libera a lo largo de los troncos, arde
  liberando calor, el aire caliente asciende por flotación y una fuerza de turbulencia hace
  que las lenguas oscilen, pulsen y se desprendan. El color sale de una aproximación de cuerpo
  negro (Wien) a partir de la temperatura.
- *Escena trazada por rayos* (`shaders/scene.ts`): hogar de ladrillo refractario con hollín,
  piedra de la embocadura, troncos con corteza y grietas de carbonización incandescentes y
  lecho de brasas. Como la cámara es fija, la geometría, los materiales y la transferencia de
  luz (con sombras suaves) se calculan una sola vez por resolución; en cada fotograma solo se
  combinan con la luz actual del fuego (12 sondas que integran la emisión de las llamas) y con
  las brasas animadas.
- *Chispas y pavesas* (`sparks.ts`), *bloom*, distorsión por calor, *tone mapping* fílmico,
  viñeta y grano (`shaders/post.ts`).
- Comportamiento del fuego (`dynamics.ts`): procesos aleatorios que hacen que cada zona de los
  troncos respire, se avive o se calme, además de corrientes de tiro y el pulso de las brasas.
  Los chasquidos fuertes del audio lanzan chispas y avivan las llamas cercanas.

**Sonido (Web Audio, `src/lib/audio`)**

- `synthesis.ts` sintetiza en memoria decenas de variaciones de crujidos, chasquidos, siseos de
  savia y leños que se asientan, además de ruidos de base y la respuesta de una sala.
- `FireSoundscape.ts` las programa con intervalos, intensidades, tonos y posiciones estéreo
  aleatorias (ráfagas de crujidos, oleadas de actividad), con un rumor de llama modulado sin
  cesar. No hay ningún bucle que se pueda notar.
- `FireAudioEngine.ts` gestiona el `AudioContext`, el compresor/limitador, el volumen, la pausa
  con fundido y la programación anticipada (que se amplía en pestañas en segundo plano).

**Interfaz (`src/components`, `src/hooks`)**: Next.js (App Router) + React + SCSS modules.

## Rendimiento y compatibilidad

- La animación se detiene cuando la pestaña no está visible (el sonido sigue) y se limita a
  unos 60 fps en pantallas de alta frecuencia.
- La resolución interna se ajusta al dispositivo y baja sola si no se mantiene la fluidez.
- La pantalla no se apaga mientras arde el fuego (Screen Wake Lock, requiere HTTPS o localhost).
- WebGL2 y WebGL1. En dispositivos sin texturas de coma flotante se usa un fuego procedural
  más sencillo; sin WebGL queda un resplandor animado y el sonido.
- Se adapta a cualquier proporción (16:9, 16:10, 4:3, ultrapanorámico y vertical).
- iPhone no permite pantalla completa en páginas web: el botón se oculta automáticamente.
