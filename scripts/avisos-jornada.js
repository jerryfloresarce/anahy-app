// Envia los avisos de jornada (push) al movil de Gaby aunque la app este cerrada.
// Lo ejecuta GitHub Actions cada 10 minutos (ver .github/workflows/avisos-jornada.yml):
//  - entre las 9:00 y las 9:59 (hora de Madrid), una vez al dia: si no se ha iniciado la jornada
//  - en la hora de cierre (22:00, sabados 23:00), una vez al dia: si la jornada sigue abierta
//  - y cuando desde la app se pide un aviso de prueba (boton en Ajustes)
// Tambien se puede lanzar a mano desde la pestaña Actions de GitHub ("Run workflow").

const webpush = require('web-push');

// misma configuracion publica de Firebase que usa index.html
const PROJECT = 'anahy-tienda';
const API_KEY = 'AIzaSyB5F0oZlm1J1jFKZ4XjlcCy9gCSRcP7JEk';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const SOLO_PARA = 'Gaby'; // los avisos de jornada son solo para ella

const PUB = process.env.VAPID_PUBLIC_KEY;
const PRIV = process.env.VAPID_PRIVATE_KEY;
if (!PUB || !PRIV) {
  console.error('Faltan las claves: hay que guardar VAPID_PRIVATE_KEY como secreto del repositorio (Settings → Secrets and variables → Actions).');
  process.exit(1);
}
webpush.setVapidDetails('https://jerryfloresarce.github.io/anahy-app/', PUB, PRIV);

function ahoraEnMadrid() {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { hora: Number(p.hour) % 24, minuto: Number(p.minute), fecha: `${p.year}-${p.month}-${p.day}`, sabado: p.weekday === 'Sat' };
}
function fmt(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
async function getJSON(url) {
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url.split('?')[0]} -> HTTP ${r.status}`);
  return r.json();
}
const str = (doc, campo) => (doc && doc.fields && doc.fields[campo] && doc.fields[campo].stringValue) || '';
async function borrar(id) { await fetch(`${BASE}/anahyPush/${id}?key=${API_KEY}`, { method: 'DELETE' }); }
async function guardarMeta(meta) {
  const fields = {};
  for (const k of Object.keys(meta)) fields[k] = { stringValue: String(meta[k]) };
  await fetch(`${BASE}/anahyPush/_meta?key=${API_KEY}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
}

async function enviar(subs, tipo, titulo, cuerpo) {
  let enviados = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(s.sub, JSON.stringify({ tipo, titulo, cuerpo, url: './?tab=jornada' }), { TTL: 3600 });
      enviados++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        // el movil quito el permiso o reinstalo la app: se limpia la suscripcion
        await borrar(s.id);
        console.log('Suscripción caducada borrada:', s.id);
      } else {
        console.error('Error enviando a', s.id, e.statusCode || '', e.body || e.message);
      }
    }
  }
  console.log(`Aviso '${tipo}' enviado a ${enviados} de ${subs.length} móvil(es).`);
  return enviados;
}

async function main() {
  const { hora, minuto, fecha, sabado } = ahoraEnMadrid();
  const cierre = sabado ? 23 : 22;
  const forzar = (process.env.FORZAR || '').trim();
  console.log(`Madrid ${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')} del ${fmt(fecha)} · cierre a las ${cierre}:00`);

  // suscripciones (solo las de Gaby), peticiones de prueba y marcas de "ya avisado hoy"
  const lista = await getJSON(`${BASE}/anahyPush?key=${API_KEY}&pageSize=200`);
  const docs = (lista && lista.documents) || [];
  const subs = [], pruebas = [];
  let meta = {};
  for (const d of docs) {
    const id = d.name.split('/').pop();
    if (id === '_meta') { meta = { iniciar: str(d, 'iniciar'), finalizar: str(d, 'finalizar') }; continue; }
    if (id.startsWith('_prueba_')) { pruebas.push({ id, pushId: str(d, 'pushId'), usuario: str(d, 'usuario') }); continue; }
    if (str(d, 'usuario') !== SOLO_PARA) continue;
    try { subs.push({ id, sub: JSON.parse(str(d, 'sub')) }); } catch (e) { /* suscripcion rota: se ignora */ }
  }
  console.log(`Móviles de ${SOLO_PARA} con avisos: ${subs.length} · pruebas pendientes: ${pruebas.length}`);

  // 1) avisos de prueba pedidos desde la app: van solo al movil que lo pidio
  for (const p of pruebas) {
    const destino = subs.filter(s => s.id === p.pushId);
    if (destino.length) await enviar(destino, 'prueba', 'Anahy · Prueba', 'Los avisos de jornada funcionan en este móvil. 🎉');
    else console.log('Prueba pedida por un móvil sin suscripción válida:', p.pushId);
    await borrar(p.id);
  }
  if (forzar === 'prueba' && subs.length) await enviar(subs, 'prueba', 'Anahy · Prueba', 'Los avisos de jornada funcionan en este móvil. 🎉');

  // 2) avisos del dia, una sola vez cada uno aunque GitHub se retrase
  const estado = JSON.parse((await getJSON(`${BASE}/anahy/estado?key=${API_KEY}`)).fields.json.stringValue);
  const tramos = (estado.jornada && estado.jornada.tramos) || [];
  const deHoy = tramos.filter(t => t.fecha === fecha);
  const abierto = tramos.find(t => !t.fin);

  const tocaIniciar = forzar === 'iniciar' || (!forzar && hora === 9 && meta.iniciar !== fecha);
  const tocaFinalizar = forzar === 'finalizar' || (!forzar && hora === cierre && meta.finalizar !== fecha);

  if (tocaIniciar) {
    if (abierto && abierto.fecha !== fecha) {
      await enviar(subs, 'sincerrar', 'Anahy · Jornada sin cerrar', `La jornada del ${fmt(abierto.fecha)} se quedó sin cerrar. Ponle la hora de salida.`);
    } else if (!deHoy.length) {
      await enviar(subs, 'iniciar', 'Anahy · Buenos días', 'Recuerda darle a Iniciar jornada cuando empieces.');
    } else {
      console.log('A las 9 ya había jornada iniciada: no hace falta avisar.');
    }
    if (!forzar) { meta.iniciar = fecha; await guardarMeta(meta); }
  }
  if (tocaFinalizar) {
    if (abierto && abierto.fecha === fecha) {
      await enviar(subs, 'finalizar', 'Anahy · Hora de cerrar', 'Si has terminado, dale a Finalizar jornada.');
    } else {
      console.log('A la hora de cierre no había jornada abierta: no hace falta avisar.');
    }
    if (!forzar) { meta.finalizar = fecha; await guardarMeta(meta); }
  }
  if (!tocaIniciar && !tocaFinalizar && !pruebas.length && forzar !== 'prueba') console.log('Nada que avisar ahora.');
}

main().catch(e => { console.error(e); process.exit(1); });
