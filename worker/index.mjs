// Avisos de jornada de Anahy: Cloudflare Worker con cron cada minuto.
//
// Cada minuto mira la hora de Madrid y, si toca, manda un aviso push al movil de Gaby
// aunque la app este cerrada:
//   - de lunes a viernes entre las 9:00 y las 9:59, una vez al dia: si no se ha iniciado la
//     jornada (o quedo una de otro dia sin cerrar); nunca en un dia marcado como libre/fiesta
//   - a las 13:00, una vez al dia: si las horas de la mañana siguen abiertas (se le olvido cerrar)
//   - en la hora de cierre (22:00, sabados 23:00), una vez al dia: si sigue abierta
//   - y los avisos de prueba pedidos desde Ajustes de la app (documentos _prueba_* )
//
// Las suscripciones, las peticiones de prueba y las marcas de "ya avisado hoy" viven en
// la coleccion anahyPush de Firestore (la misma nube que usa la app), asi que el Worker
// no necesita almacenamiento propio.
//
// El envio sigue el estandar Web Push: carga cifrada con aes128gcm (RFC 8291) y peticion
// firmada con VAPID (RFC 8292), todo con WebCrypto, sin dependencias.

const PROJECT = 'anahy-tienda';
const API_KEY = 'AIzaSyB5F0oZlm1J1jFKZ4XjlcCy9gCSRcP7JEk'; // la misma config publica que index.html
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const SOLO_PARA = 'Gaby';
const SUBJECT = 'https://jerryfloresarce.github.io/anahy-app/';

// ---------- utilidades base64url / bytes ----------
const enc = new TextEncoder();
export function b64uToBytes(s) {
  const b64 = (s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
export function bytesToB64u(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

// ---------- cifrado del mensaje (RFC 8291, aes128gcm) ----------
export async function cifrarCarga(subscription, textoPlano) {
  const uaPublic = b64uToBytes(subscription.keys.p256dh); // 65 bytes
  const authSecret = b64uToBytes(subscription.keys.auth);  // 16 bytes
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const prk = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\0'), 12);

  const plano = concat(enc.encode(textoPlano), new Uint8Array([2])); // 0x02: ultimo registro
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plano));

  const rs = 4096;
  const cabecera = concat(salt, new Uint8Array([rs >>> 24, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]), new Uint8Array([asPublic.length]), asPublic);
  return concat(cabecera, cifrado);
}

// ---------- firma VAPID (RFC 8292) ----------
async function firmaVapid(endpoint, publicKeyB64u, privateKeyB64u) {
  const pub = b64uToBytes(publicKeyB64u); // 65 bytes: 0x04 | x | y
  const jwk = { kty: 'EC', crv: 'P-256', x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)), d: privateKeyB64u };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const firma = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + payload)));
  return `vapid t=${header}.${payload}.${bytesToB64u(firma)}, k=${publicKeyB64u}`;
}

// ---------- envio de un aviso ----------
export async function enviarPush(subscription, datos, env) {
  const cuerpo = await cifrarCarga(subscription, JSON.stringify(datos));
  const r = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '14400',
      'Urgency': 'high',
      'Authorization': await firmaVapid(subscription.endpoint, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY),
    },
    body: cuerpo,
  });
  return { ok: r.ok, status: r.status, texto: r.ok ? '' : (await r.text()).slice(0, 200) };
}

// ---------- Firestore (REST, mismas reglas abiertas que usa la app) ----------
async function getJSON(url) {
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url.split('?')[0]} -> HTTP ${r.status}`);
  return r.json();
}
const str = (doc, campo) => (doc && doc.fields && doc.fields[campo] && doc.fields[campo].stringValue) || '';
const borrar = id => fetch(`${BASE}/anahyPush/${id}?key=${API_KEY}`, { method: 'DELETE' });
function guardarMeta(meta) {
  const fields = {};
  for (const k of Object.keys(meta)) fields[k] = { stringValue: String(meta[k]) };
  return fetch(`${BASE}/anahyPush/_meta?key=${API_KEY}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
}
function ahoraEnMadrid() {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { hora: Number(p.hour) % 24, minuto: Number(p.minute), fecha: `${p.year}-${p.month}-${p.day}`, sabado: p.weekday === 'Sat', laborable: !['Sat', 'Sun'].includes(p.weekday) };
}
const fmt = iso => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

async function enviarATodos(subs, tipo, titulo, cuerpo, env, log) {
  let enviados = 0;
  for (const s of subs) {
    try {
      const r = await enviarPush(s.sub, { tipo, titulo, cuerpo, url: './?tab=jornada' }, env);
      if (r.ok) enviados++;
      else if (r.status === 404 || r.status === 410) { await borrar(s.id); log(`suscripción caducada borrada: ${s.id}`); }
      else log(`error enviando a ${s.id}: HTTP ${r.status} ${r.texto}`);
    } catch (e) { log(`error enviando a ${s.id}: ${e.message}`); }
  }
  log(`aviso '${tipo}' enviado a ${enviados} de ${subs.length} móvil(es)`);
  return enviados;
}

// ---------- la pasada de cada minuto ----------
export async function pasada(env, forzar = '', log = console.log) {
  const { hora, minuto, fecha, sabado, laborable } = ahoraEnMadrid();
  const cierre = sabado ? 23 : 22;

  const lista = await getJSON(`${BASE}/anahyPush?key=${API_KEY}&pageSize=200`);
  const docs = (lista && lista.documents) || [];
  const subs = [], pruebas = [];
  let meta = {};
  for (const d of docs) {
    const id = d.name.split('/').pop();
    if (id === '_meta') { meta = { iniciar: str(d, 'iniciar'), mediodia: str(d, 'mediodia'), finalizar: str(d, 'finalizar') }; continue; }
    if (id.startsWith('_prueba_')) { pruebas.push({ id, pushId: str(d, 'pushId') }); continue; }
    if (str(d, 'usuario') !== SOLO_PARA) continue;
    try { subs.push({ id, sub: JSON.parse(str(d, 'sub')) }); } catch (e) { /* suscripcion rota */ }
  }

  // 1) pruebas pedidas desde la app: solo al movil que las pidio
  for (const p of pruebas) {
    const destino = subs.filter(s => s.id === p.pushId);
    if (destino.length) await enviarATodos(destino, 'prueba', 'Anahy · Prueba', 'Los avisos de jornada funcionan en este móvil. 🎉', env, log);
    else log(`prueba pedida por un móvil sin suscripción válida: ${p.pushId}`);
    await borrar(p.id);
  }
  if (forzar === 'prueba') await enviarATodos(subs, 'prueba', 'Anahy · Prueba', 'Los avisos de jornada funcionan en este móvil. 🎉', env, log);

  // 2) avisos del dia, una sola vez cada uno
  const tocaIniciar = forzar === 'iniciar' || (!forzar && laborable && hora === 9 && meta.iniciar !== fecha);
  const tocaMediodia = forzar === 'mediodia' || (!forzar && hora === 13 && meta.mediodia !== fecha);
  const tocaFinalizar = forzar === 'finalizar' || (!forzar && hora === cierre && meta.finalizar !== fecha);
  if (!tocaIniciar && !tocaMediodia && !tocaFinalizar) {
    return `Madrid ${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')} · móviles ${subs.length} · pruebas ${pruebas.length} · nada más que avisar`;
  }
  const estado = JSON.parse((await getJSON(`${BASE}/anahy/estado?key=${API_KEY}`)).fields.json.stringValue);
  const tramos = (estado.jornada && estado.jornada.tramos) || [];
  const deHoy = tramos.filter(t => t.fecha === fecha);
  const abierto = tramos.find(t => !t.fin);
  const libre = ((estado.jornada && estado.jornada.libres) || {})[fecha]; // dia libre / fiesta marcado en la app

  if (tocaIniciar) {
    if (abierto && abierto.fecha !== fecha) await enviarATodos(subs, 'sincerrar', 'Anahy · Jornada sin cerrar', `La jornada del ${fmt(abierto.fecha)} se quedó sin cerrar. Ponle la hora de salida.`, env, log);
    else if (libre) log(`hoy es "${libre}": no se avisa de iniciar`);
    else if (!deHoy.length) await enviarATodos(subs, 'iniciar', 'Anahy · Buenos días', 'Recuerda darle a Iniciar jornada cuando empieces.', env, log);
    else log('a las 9 ya había jornada iniciada: no hace falta avisar');
    if (!forzar) { meta.iniciar = fecha; await guardarMeta(meta); }
  }
  if (tocaMediodia) {
    if (abierto && abierto.fecha === fecha) await enviarATodos(subs, 'mediodia', 'Anahy · Horas sin cerrar', 'Son las 13:00 y las horas de la mañana siguen abiertas. Dale a Finalizar jornada (y corrige la hora de salida si hace falta).', env, log);
    else log('a las 13:00 no había jornada abierta: no hace falta avisar');
    if (!forzar) { meta.mediodia = fecha; await guardarMeta(meta); }
  }
  if (tocaFinalizar) {
    if (abierto && abierto.fecha === fecha) await enviarATodos(subs, 'finalizar', 'Anahy · Hora de cerrar', 'Si has terminado, dale a Finalizar jornada.', env, log);
    else log('a la hora de cierre no había jornada abierta: no hace falta avisar');
    if (!forzar) { meta.finalizar = fecha; await guardarMeta(meta); }
  }
  return `Madrid ${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')} · avisos del día procesados`;
}

export default {
  // cron cada minuto (ver wrangler.jsonc)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pasada(env).then(r => console.log(r)).catch(e => console.error('pasada fallida:', e)));
  },
  // GET /  -> estado (para comprobar que esta vivo); nada mas se expone
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/') return new Response('No encontrado', { status: 404 });
    return new Response(JSON.stringify({ servicio: 'avisos de jornada de Anahy', madrid: ahoraEnMadrid(), vapidPublica: env.VAPID_PUBLIC_KEY ? 'configurada' : 'FALTA' }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  },
};
