// Agenda-widgets voor BuurtApps. Server-gerenderd, werkt in iframes met sandbox="" (geen JavaScript).
// Elke aanvraag filtert op de actuele tijd in Nederland: wat begonnen is, staat er niet meer in.
const http = require('http');

const PORT = process.env.PORT || 3000;
const ZONE = 'Europe/Amsterdam';
const CACHE_MS = 60 * 60 * 1000; // bron hooguit eens per uur ophalen
const UA = 'Mozilla/5.0 (compatible; BuurtApps agenda-widget; +https://zeistapp.nl)';

// Vaste maten, zodat de hoogte exact te berekenen is
const MAAT = { kop: 150, kaart: 100, kaartMarge: 8, maand: 34, maandEerste: 26, onder: 40, standaardHoogte: 2950 };

const MAAND_KORT = { jan: 1, feb: 2, mrt: 3, maa: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };
const MAAND_NL = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const DAG_NL = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];

const BRONNEN = {
  beauforthuis: {
    url: 'https://www.beauforthuis.nl/',
    parse: parseBeauforthuis,
    label: 'BEAUFORTHUIS &middot; AUSTERLITZ',
    kop: '&#127925; Concerten, theater &amp; meer',
    intro: 'De eerstvolgende concerten, voorstellingen, wandelingen en activiteiten in het Beauforthuis.',
    bronTekst: 'Programma en kaartverkoop via beauforthuis.nl'
  }
};

const cache = {}; // per bron: { events, opgehaald, fout, bezig }

// ---------- hulpfuncties ----------
function dec(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function tekst(s) { return dec(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function divKlasse(blok, klasse) {
  const m = blok.match(new RegExp('<div class="[^"]*\\b' + klasse + '\\b[^"]*">([\\s\\S]*?)</div>', 'i'));
  return m ? tekst(m[1]) : '';
}

function nuInNL() {
  const d = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach(p => { d[p.type] = p.value; });
  return { datum: d.year + '-' + d.month + '-' + d.day, tijd: d.hour + ':' + d.minute, jaar: Number(d.year), maand: Number(d.month), dag: Number(d.day) };
}

// Bron noemt geen jaar: ligt de datum meer dan 60 dagen terug, dan is het volgend jaar
function metJaar(dag, maand, nu) {
  let jaar = nu.jaar;
  const kandidaat = Date.UTC(jaar, maand - 1, dag);
  const vandaag = Date.UTC(nu.jaar, nu.maand - 1, nu.dag);
  if (kandidaat < vandaag - 60 * 86400000) jaar += 1;
  return jaar + '-' + String(maand).padStart(2, '0') + '-' + String(dag).padStart(2, '0');
}

// ---------- Beauforthuis ----------
function parseBeauforthuis(html) {
  const nu = nuInNL();
  const delen = html.split(/<div class="ecs-event\b/).slice(1);
  const uit = [];
  const gezien = new Set();
  for (const deel of delen) {
    const blok = deel.split(/<div class="ecs-event\b/)[0];
    const link = blok.match(/<div class="titel">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = link[1].split('?')[0].split('#')[0];
    if (gezien.has(url)) continue;
    const dag = Number(divKlasse(blok, 'day'));
    const maand = MAAND_KORT[divKlasse(blok, 'month').toLowerCase().slice(0, 3)];
    if (!dag || !maand) continue;
    const tijdRuw = divKlasse(blok, 'ecs_start_time');
    const tm = tijdRuw.match(/(\d{1,2}):(\d{2})/);
    const img = blok.match(/data-src="([^"]+wp-content\/uploads[^"]+)"/i) || blok.match(/<img[^>]+src="(https?:[^"]+wp-content\/uploads[^"]+)"/i);
    gezien.add(url);
    uit.push({
      url,
      titel: tekst(link[2]),
      ondertitel: divKlasse(blok, 'ondertitel') || divKlasse(blok, 'samenvatting'),
      datum: metJaar(dag, maand, nu),
      tijd: tm ? tm[1].padStart(2, '0') + ':' + tm[2] : null,
      afbeelding: img ? img[1] : null
    });
  }
  return uit;
}

// ---------- ophalen met cache ----------
async function haalOp(naam) {
  const bron = BRONNEN[naam];
  const c = cache[naam] || (cache[naam] = { events: [], opgehaald: 0, fout: null, bezig: null });
  if (Date.now() - c.opgehaald < CACHE_MS && c.events.length) return c;
  if (c.bezig) { await c.bezig; return c; }
  c.bezig = (async () => {
    try {
      const r = await fetch(bron.url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const events = bron.parse(await r.text());
      if (!events.length) throw new Error('0 evenementen gevonden');
      c.events = events; c.opgehaald = Date.now(); c.fout = null;
    } catch (e) {
      c.fout = e.message; // oude data blijft staan
      if (c.events.length) c.opgehaald = Date.now() - CACHE_MS + 5 * 60 * 1000; // over 5 min opnieuw proberen
      console.error('[' + naam + '] ophalen mislukt:', e.message);
    } finally { c.bezig = null; }
  })();
  await c.bezig;
  return c;
}

// ---------- pagina ----------
function pagina(naam, events, hoogte) {
  const bron = BRONNEN[naam];
  const nu = nuInNL();
  const komend = events
    .filter(e => e.datum > nu.datum || (e.datum === nu.datum && (e.tijd || '23:59') > nu.tijd))
    .sort((a, b) => a.datum.localeCompare(b.datum) || String(a.tijd).localeCompare(String(b.tijd)));

  // vul tot de hoogte vol is
  let ruimte = hoogte - MAAT.kop - MAAT.onder;
  let html = '', huidig = '', eerste = true, aantal = 0;
  for (const e of komend) {
    const sleutel = e.datum.slice(0, 7);
    const nieuweMaand = sleutel !== huidig;
    const nodig = MAAT.kaart + MAAT.kaartMarge + (nieuweMaand ? (eerste ? MAAT.maandEerste : MAAT.maand) : 0);
    if (nodig > ruimte) break;
    ruimte -= nodig;
    const d = new Date(e.datum + 'T12:00:00Z');
    if (nieuweMaand) {
      huidig = sleutel;
      html += '<div class="maand' + (eerste ? ' eerste' : '') + '">' + MAAND_NL[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + '</div>';
      eerste = false;
    }
    const wanneer = DAG_NL[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MAAND_NL[d.getUTCMonth()] + (e.tijd ? ' &middot; ' + e.tijd + ' uur' : '');
    html += '<div class="kaart">'
      + '<div class="foto">' + (e.afbeelding ? '<img src="' + esc(e.afbeelding) + '" alt="" loading="lazy">' : '') + '</div>'
      + '<div class="tekst">'
      + '<div class="titel">' + esc(e.titel) + '</div>'
      + (e.ondertitel ? '<div class="sub">' + esc(e.ondertitel) + '</div>' : '')
      + '<div class="datum">' + wanneer + '</div>'
      + '</div></div>';
    aantal++;
  }
  if (!aantal) html = '<div class="leeg">Er staan op dit moment geen activiteiten gepland.</div>';

  const bijgewerkt = nu.dag + ' ' + MAAND_NL[nu.maand - 1] + ' om ' + nu.tijd;
  return '<!doctype html><html lang="nl"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(tekst(bron.label)) + '</title>'
    + '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;800;900&display=swap" rel="stylesheet">'
    + '<style>'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'html,body{background:transparent;font-family:Nunito,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#2d2d2d;-webkit-text-size-adjust:100%}'
    + '.wrap{max-width:720px;margin:0 auto;height:' + hoogte + 'px;overflow:hidden}'
    + '.kop{height:' + (MAAT.kop - 14) + 'px;margin-bottom:14px;background:linear-gradient(135deg,#FFF6EC,#FFFFFF);border:1px solid #F1DDCC;border-radius:18px;padding:15px;box-shadow:0 7px 22px rgba(130,67,20,.08);overflow:hidden}'
    + '.label{font-size:11px;color:#e95b0c;font-weight:900;text-transform:uppercase;letter-spacing:.7px}'
    + '.h{font-size:21px;font-weight:900;line-height:1.2;margin-top:2px}'
    + '.intro{font-size:12.5px;color:#6b7280;line-height:1.45;margin-top:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}'
    + '.bij{margin-top:8px;font-size:10px;color:#9aa0a6}'
    + '.maand{height:' + MAAT.maand + 'px;padding-top:12px;font-size:12.5px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:#e95b0c;line-height:14px}'
    + '.maand.eerste{height:' + MAAT.maandEerste + 'px;padding-top:4px}'
    + '.maand::before{content:"";display:inline-block;width:4px;height:14px;background:#E95B0C;border-radius:2px;margin:0 8px -2px 2px}'
    + '.kaart{height:' + MAAT.kaart + 'px;margin-bottom:' + MAAT.kaartMarge + 'px;display:flex;gap:11px;align-items:center;background:#fff;border-radius:16px;border:1px solid #ECE6DF;box-shadow:0 4px 14px rgba(70,55,40,.07);padding:10px 12px;overflow:hidden}'
    + '.foto{flex:none;width:72px;height:72px;border-radius:12px;overflow:hidden;background:#F7F3F0;border:1px solid #E9DFD8}'
    + '.foto img{display:block;width:72px;height:72px;object-fit:cover}'
    + '.tekst{flex:1;min-width:0}'
    + '.titel{font-size:14.5px;font-weight:900;color:#303030;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}'
    + '.sub{font-size:11.5px;color:#8a6d59;margin-top:1px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.datum{font-size:12px;color:#6b7280;margin-top:3px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.leeg{text-align:center;padding:18px 14px;border-radius:14px;background:#FAF8F6;color:#6b7280;font-size:12px}'
    + '.bron{height:' + MAAT.onder + 'px;padding-top:12px;font-size:10.5px;color:#9aa0a6;text-align:center}'
    + '</style></head><body><div class="wrap">'
    + '<div class="kop"><div class="label">' + bron.label + '</div><div class="h">' + bron.kop + '</div>'
    + '<div class="intro">' + esc(bron.intro) + '</div><div class="bij">Bijgewerkt ' + bijgewerkt + '</div></div>'
    + html
    + '<div class="bron">' + esc(bron.bronTekst) + '</div>'
    + '</div></body></html>';
}

// ---------- server ----------
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const naam = u.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (naam === '' || naam === 'health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, bronnen: Object.keys(BRONNEN), cache: Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, { aantal: v.events.length, opgehaald: v.opgehaald ? new Date(v.opgehaald).toISOString() : null, fout: v.fout }])) }));
  }
  if (!BRONNEN[naam]) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Onbekende agenda'); }
  const h = Math.min(Math.max(Number(u.searchParams.get('h')) || MAAT.standaardHoogte, 400), 8000);
  const c = await haalOp(naam);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
  res.end(pagina(naam, c.events, h));
}).listen(PORT, () => console.log('Agenda-widgets op poort ' + PORT));

// Bij start alvast ophalen, daarna elk uur
for (const naam of Object.keys(BRONNEN)) { haalOp(naam); setInterval(() => haalOp(naam), CACHE_MS); }

module.exports = { parseBeauforthuis, pagina };
