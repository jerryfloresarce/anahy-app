# Avisos de jornada (Cloudflare Worker)

Manda al móvil de Gaby, aunque la app esté cerrada, el aviso de iniciar la jornada
(9:00 si no la ha iniciado) y el de finalizarla (22:00, sábados 23:00, si sigue
abierta), y los avisos de prueba que se piden desde Ajustes de la app.

- `index.mjs`: el Worker entero (cron cada minuto, lectura de Firestore, cifrado
  Web Push y firma VAPID con WebCrypto, sin dependencias).
- `wrangler.jsonc`: el cron y la clave pública VAPID.

No necesita KV ni base de datos propia: las suscripciones de los móviles, las
peticiones de prueba y las marcas de "ya avisado hoy" viven en la colección
`anahyPush` de Firestore, la misma nube que usa la app.

## Desplegar (una vez, desde un ordenador con wrangler)

```bash
cd worker
npx wrangler deploy
npx wrangler secret put VAPID_PRIVATE_KEY   # pegar la clave privada cuando la pida
```

La clave privada es la misma que se usó para las suscripciones actuales; si se
cambiara, todos los móviles tendrían que volver a activar los avisos.

## Comprobar que está vivo

Abrir la URL del Worker (la que imprime `wrangler deploy`): responde un JSON con la
hora de Madrid y si la clave pública está configurada. Para probar el envío, en la
app: Ajustes → Avisos de jornada → "Enviar un aviso de prueba a este móvil".

## Cuotas del plan gratuito

Cron cada minuto = 1.440 ejecuciones al día, cada una con 2 o 3 peticiones a
Firestore y los envíos que toquen. Muy por debajo de las 100.000 peticiones
diarias del plan gratuito.
