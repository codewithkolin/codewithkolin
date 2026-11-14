#!/usr/bin/env node
// Rebuilds the profile from public data: assets/film.svg, assets/tickets/*.svg, README.md.
//   node build.mjs            live fetch; each source falls back to data/cache.json
//   node build.mjs --offline  cache only, for local preview
// The story (eras, beats, palettes) is curated in data/story.json. Everything else is fetched.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';

const here = (p) => new URL(p, import.meta.url);
const story = JSON.parse(await readFile(here('data/story.json'), 'utf8'));
const cache = JSON.parse(await readFile(here('data/cache.json'), 'utf8').catch(() => '{}'));
const offline = process.argv.includes('--offline');
const { person, eras, links, now: NOW } = story;

// ---------- text helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const unesc = (s) => String(s).replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[e]);
const https = (u) => (/^https:\/\/[^\s"'<>]+$/.test(u || '') ? u : null);
const host = (u) => new URL(u).host.replace(/^www\./, '');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const wrap = (s, n, max = 2) => {
  const out = [''];
  for (const w of String(s).split(/\s+/)) {
    const cur = out[out.length - 1];
    if (!cur) out[out.length - 1] = w;
    else if (cur.length + 1 + w.length <= n) out[out.length - 1] = `${cur} ${w}`;
    else out.push(w);
  }
  if (out.length > max) {
    out.length = max;
    out[max - 1] = out[max - 1].slice(0, n - 1).trimEnd() + '…';
  }
  return out.map((l) => clip(l, n));
};
const day = (d) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(d));
const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

// ---------- live data (every value is real or absent, never invented) ----------
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
async function text(url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': 'profile-film', ...headers }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
const json = async (url, headers) => JSON.parse(await text(url, headers));
const items = (xml, name) => xml.match(new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`, 'g')) || [];
const tag = (xml, name) => unesc(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() ?? '');
const byDate = (a, b) => new Date(b.date) - new Date(a.date);

const sources = {
  // Whatever is unhidden and live in the apps directory: the admin panel there decides.
  products: async () =>
    (await json('https://apps.codewithkolin.com/api/apps')).apps
      .filter((a) => a.status === 'live' && https(a.url))
      .map((a) => ({ title: a.title, url: a.url, line: a.oneLiner, tone: a.coverTone })),
  apps: async () =>
    (await json(`https://itunes.apple.com/lookup?id=${person.appStoreId}&entity=software,macSoftware&limit=50`)).results
      .filter((r) => r.wrapperType === 'software' && https(r.trackViewUrl))
      .map((r) => ({
        title: r.trackName,
        url: r.trackViewUrl.split('?')[0],
        line: r.description.split(/(?<=[.!?])\s/)[0],
        platform: r.kind === 'mac-software' ? 'Mac' : 'iPhone',
      })),
  repos: async () =>
    (await json(`https://api.github.com/users/${person.login}/repos?type=owner&sort=pushed&per_page=100`, token ? { authorization: `Bearer ${token}` } : {}))
      .filter((r) => !r.fork && !r.private && r.name !== person.login)
      .map((r) => ({ name: r.name, date: r.pushed_at }))
      .sort(byDate),
  // The same number a visitor sees above the contribution graph.
  contributions: async () => {
    const m = (await text(`https://github.com/users/${person.login}/contributions`)).match(/([\d,]+)\s+contributions?\s+in\s+the\s+last\s+year/);
    assert(m, 'contribution total not found');
    return Number(m[1].replace(/,/g, ''));
  },
  ledger: async () =>
    items(await text(`${person.home}/rss.xml`), 'item')
      .map((x) => ({ title: tag(x, 'title'), url: tag(x, 'link'), date: tag(x, 'pubDate') }))
      .filter((x) => x.title && https(x.url))
      .sort(byDate),
  videos: async () =>
    items(await text(`https://www.youtube.com/feeds/videos.xml?channel_id=${person.youtubeChannelId}`), 'entry')
      .map((x) => ({ title: tag(x, 'title'), url: `https://www.youtube.com/watch?v=${tag(x, 'yt:videoId')}`, date: tag(x, 'published') }))
      .filter((x) => x.title)
      .sort(byDate),
};

const data = {};
for (const [key, load] of Object.entries(sources)) {
  try {
    if (offline) throw new Error('offline');
    data[key] = await load();
  } catch (e) {
    data[key] = cache[key];
    console.warn(`${key}: kept last good value (${e.message})`);
  }
}

const seen = new Set();
const products = [...story.products, ...(data.products || [])].filter((p) => !seen.has(host(p.url)) && seen.add(host(p.url)));
const apps = data.apps || [];
const videos = (data.videos || []).slice(0, 2);
const lastShip = data.ledger?.[0]
  ? { title: data.ledger[0].title, note: day(data.ledger[0].date) }
  : data.repos?.[0]
    ? { title: data.repos[0].name, note: `pushed ${day(data.repos[0].date)}` }
    : null;

// ---------- the Film ----------
const W = 1200, H = 675, X0 = 72, X1 = 1128, LY = 600;
const FONT = {
  display: `'Iowan Old Style','Palatino Linotype',Palatino,Georgia,'Times New Roman',serif`,
  sans: `ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`,
  mono: `ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`,
  hand: `'Bradley Hand','Segoe Print','Chalkboard SE','Comic Sans MS',cursive`,
};
const OUT = 'cubic-bezier(.16,1,.3,1)';

function film() {
  const today = new Date();
  const yearNow = today.getUTCFullYear() + (today - Date.UTC(today.getUTCFullYear(), 0, 1)) / 31557600000;
  const xOf = (y) => X0 + ((y - 1992) / (yearNow - 1992)) * (X1 - X0);
  const beats = eras.flatMap((e) => e.beats);
  const INTRO = 0.6, BEAT = 1.3, TN = INTRO + beats.length * BEAT, T = TN + 2.4;
  const pal = Object.fromEntries(eras.map((e) => [e.material, e.palette]));

  // Every animated element shares one timeline of T seconds; keyframes are written in seconds.
  const css = [];
  const pct = (s) => `${((Math.min(Math.max(s, 0), T) / T) * 100).toFixed(2)}%`;
  let id = 0;
  const kf = (stops) => {
    const name = `k${id++}`;
    css.push(`@keyframes ${name}{${stops.map(([t, body, ease]) => `${pct(t)}{${body}${ease ? `;animation-timing-function:${ease}` : ''}}`).join('')}}.${name}{animation-name:${name}}`);
    return `a ${name}`;
  };
  const draw = (start, dur) => kf([[0, 'stroke-dashoffset:100'], [start, 'stroke-dashoffset:100', 'ease-out'], [start + dur, 'stroke-dashoffset:0']]);
  const full = `width="${W}" height="${H}"`;

  const decor = {
    film: (p, s) => `
      <rect ${full} fill="url(#vig)"/>
      <rect ${full} filter="url(#grain)" opacity=".55"/>
      ${[0, W - 52].map((x) => `<rect x="${x}" width="52" height="${H}" fill="#0b0705"/>${Array.from({ length: 12 }, (_, i) => `<rect x="${x + 15}" y="${14 + i * 56}" width="22" height="30" rx="5" fill="${p.bg2}"/>`).join('')}`).join('')}
      <rect x="873" width="1.5" height="${H}" fill="${p.ink}" opacity="0" style="animation:scratch .9s steps(4) 6 ${s}s both"/>
      <rect ${full} fill="${p.accent2}" opacity="0" style="animation:flick .21s steps(2) 26 ${s}s both"/>`,
    crt: (p, s, e) => `
      <rect ${full} fill="url(#scan)"/>
      <rect ${full} fill="url(#vig)"/>
      <rect y="-140" width="${W}" height="140" fill="url(#band)" style="animation:band ${(e - s).toFixed(2)}s linear 1 ${s}s both"/>
      <rect x="${X0}" y="448" width="15" height="26" fill="${p.accent}" style="animation:blink .5s steps(1) ${Math.ceil((e - s) / 0.5)} ${s}s both"/>`,
    blueprint: (p, s) => `
      <rect ${full} fill="url(#grid)"/>
      <path d="M24 60V24H60M${W - 60} 24H${W - 24}V60M24 ${H - 60}V${H - 24}H60M${W - 60} ${H - 24}H${W - 24}V${H - 60}" fill="none" stroke="${p.accent}" stroke-opacity=".6"/>
      <path d="M930 150v300M780 300h300M930 300m-120 0a120 120 0 1 0 240 0a120 120 0 1 0-240 0M930 300m-60 0a60 60 0 1 0 120 0a60 60 0 1 0-120 0M810 470h240M810 460v20M1050 460v20" fill="none" stroke="${p.accent}" stroke-width="1.6" pathLength="100" stroke-dasharray="100" class="${draw(s + 0.2, 1.6)}"/>
      <text class="fig" x="930" y="504" text-anchor="middle" fill="${p.muted}">FIG. 3 · ENGINEER</text>`,
    chalk: (p, s, e, era) => `
      <rect ${full} filter="url(#grain)" opacity=".28"/>
      <g filter="url(#rough)" stroke="${p.ink}" stroke-width="5" stroke-linecap="round" fill="none" opacity=".9">${Array.from({ length: 10 }, (_, i) => {
        const x = 790 + (i % 5) * 68, y = 190 + Math.floor(i / 5) * 104;
        return `<path d="M${x} ${y}v60M${x + 13} ${y + 2}v58M${x + 26} ${y - 1}v61M${x + 39} ${y + 1}v59M${x - 9} ${y + 50}L${x + 48} ${y + 8}" style="animation:pop .3s ease-out 1 ${(s + 0.3 + i * 0.3).toFixed(2)}s both"/>`;
      }).join('')}</g>
      ${era.aside ? `<text class="hand" x="${X1}" y="446" text-anchor="end" fill="${p.accent}" filter="url(#rough)">${esc(era.aside)}</text>` : ''}`,
    electric: (p, s) => `
      <rect ${full} fill="url(#eglow)"/>
      <g fill="none" stroke="url(#neon)" stroke-linecap="round" filter="url(#glow)">
        <path d="M700 520C820 300 980 420 1140 140" stroke-width="4" pathLength="100" stroke-dasharray="100" class="${draw(s + 0.1, 1.2)}"/>
        <path d="M740 560C900 420 1000 520 1150 300" stroke-width="2" pathLength="100" stroke-dasharray="100" class="${draw(s + 0.3, 1.2)}"/>
        <path d="M760 140C860 200 900 120 1120 90" stroke-width="2" pathLength="100" stroke-dasharray="100" class="${draw(s + 0.5, 1.2)}"/>
      </g>`,
  };

  let k = 0;
  const scenes = eras.map((e, ei) => {
    const p = e.palette, s = INTRO + k * BEAT, end = s + e.beats.length * BEAT;
    const noteX = e.material === 'crt' ? X0 + 28 : X0;
    const body = e.beats.map((b, bi) => {
      const a = s + bi * BEAT, z = a + BEAT;
      const cls = kf([[a, 'opacity:0;transform:translateY(34px)', OUT], [a + 0.34, 'opacity:1;transform:translateY(0)'], [z - 0.2, 'opacity:1;transform:translateY(0)', 'ease-in'], [z, 'opacity:0;transform:translateY(-26px)']]);
      return `<g class="${cls} beat"><text class="yr" x="${X0 - 6}" y="338" fill="${p.ink}"${e.material === 'crt' ? ' filter="url(#glow)"' : ''}>${b.year}</text><text class="ti" x="${X0}" y="424" fill="${p.ink}">${esc(b.title)}</text><text class="no" x="${noteX}" y="470" fill="${p.muted}">${esc(b.note)}</text></g>`;
    }).join('');
    k += e.beats.length;
    const cls = kf([[s - 0.25, 'opacity:0'], [s + 0.2, 'opacity:1'], [end + 0.3, 'opacity:1'], [end + 0.35, 'opacity:0']]);
    return `<g class="${cls} era m-${e.material}">
      <rect ${full} fill="${p.bg}"/>${decor[e.material](p, s, end, e)}
      <text class="kick" x="${X0}" y="70" fill="${p.muted}"><tspan fill="${p.accent}">${esc(e.label.toUpperCase())}</tspan><tspan dx="16">${esc(e.kicker.toUpperCase())}</tspan></text>
      <text class="kick" x="${X1}" y="70" text-anchor="end" fill="${p.muted}">REEL ${ei + 1} / ${eras.length}</text>
      ${body}
    </g>`;
  });

  // The resting frame. Its plain styles are the final picture, so reduced motion shows it at once.
  let n = 0;
  const rise = () => {
    const t = TN + 0.1 + n++ * 0.12;
    return kf([[0, 'opacity:0;transform:translateY(26px)'], [t, 'opacity:0;transform:translateY(26px)', OUT], [t + 0.8, 'opacity:1;transform:translateY(0)']]);
  };
  const [given, ...family] = person.name.split(' ');
  const stamp = `1992 → ${day(today).toUpperCase()}`;
  const brandW = person.brand.length * 12.6; // 17px mono with .14em tracking
  const blocks = [
    lastShip && { k: 'LAST SHIPPED', v: wrap(lastShip.title, 20), note: lastShip.note },
    data.contributions && { k: 'GITHUB', v: [data.contributions.toLocaleString('en-IN')], note: 'contributions in the last year' },
    { k: 'LIVE RIGHT NOW', v: [count(products.length, 'product')], note: apps.length ? `and ${count(apps.length, 'app')} on the App Store` : 'on the open web' },
  ].filter(Boolean);
  let y = 204;
  const column = blocks.map((b) => {
    const top = y, vEnd = top + 40 + (b.v.length - 1) * 38;
    y = vEnd + 28 + 44;
    return `<g class="${rise()}"><text class="bk" x="812" y="${top}" fill="${NOW.muted}">${b.k}</text>${b.v.map((l, i) => `<text class="bv" x="812" y="${top + 40 + i * 38}" fill="${NOW.ink}">${esc(l)}</text>`).join('')}<text class="bn" x="812" y="${vEnd + 28}" fill="${NOW.muted}">${esc(b.note)}</text></g>`;
  }).join('');
  const pos = wrap(person.positioning, 36, 2);
  n = 0;
  const nowFrame = `<g class="${kf([[0, 'opacity:0'], [TN - 0.2, 'opacity:0'], [TN + 0.25, 'opacity:1']])}">
      <rect ${full} fill="${NOW.bg}"/><rect ${full} fill="url(#nowglow)"/>
      <g class="${rise()}"><text class="kick" x="${X0}" y="70" fill="${NOW.ink}">${esc(person.brand.toUpperCase())}</text><rect x="${X0 + brandW + 14}" y="63" width="44" height="1.5" fill="${NOW.accent}"/><text class="kick" x="${X0 + brandW + 72}" y="70" fill="${NOW.muted}">${stamp}</text></g>
      <g class="${rise()}"><text class="name" x="${X0 - 8}" y="262" fill="${NOW.ink}">${esc(given)}</text></g>
      <g class="${rise()}"><text class="name" x="${X0 - 8}" y="408" fill="${NOW.ink}">${esc(family.join(' '))}</text></g>
      <g class="${rise()}">${pos.map((l, i) => `<text class="pos" x="${X0}" y="${474 + i * 38}" fill="${NOW.ink}" fill-opacity=".9">${esc(l)}</text>`).join('')}</g>
      <g class="${rise()}"><circle cx="818" cy="144" r="5" fill="${NOW.accent}"/><text class="kick" x="834" y="150" fill="${NOW.accent}">NOW SHOWING</text><rect x="812" y="168" width="${X1 - 812}" height="1" fill="#fff" fill-opacity=".14"/></g>
      ${column}
    </g>`;

  // The lifeline: a filled dot (1992) drawn out to an open ring (now), as in the site's monogram.
  const L = X1 - X0;
  const line = [[0, `stroke-dashoffset:${L}`]], head = [[0, `transform:translateX(${X0}px)`]];
  let px = X0;
  const go = (t, x) => {
    line.push([t, `stroke-dashoffset:${(L - (px - X0)).toFixed(1)}`, OUT], [t + 0.55, `stroke-dashoffset:${(L - (x - X0)).toFixed(1)}`]);
    head.push([t, `transform:translateX(${px.toFixed(1)}px)`, OUT], [t + 0.55, `transform:translateX(${x.toFixed(1)}px)`]);
    px = x;
  };
  beats.forEach((b, i) => xOf(b.year) !== px && go(INTRO + i * BEAT, xOf(b.year)));
  go(TN, X1);
  const here_ = kf([[0, 'opacity:0'], [TN + 0.5, 'opacity:0'], [TN + 1.1, 'opacity:1']]);
  const lifeline = `<g>
      <line x1="${X0}" y1="${LY}" x2="${X1}" y2="${LY}" stroke="#fff" stroke-opacity=".16" stroke-width="2"/>
      <line x1="${X0}" y1="${LY}" x2="${X1}" y2="${LY}" stroke="#fff" stroke-opacity=".9" stroke-width="2.5" stroke-dasharray="${L}" class="${kf(line)}"/>
      ${eras.map((e) => { const x = xOf(e.beats[0].year).toFixed(1); return `<line x1="${x}" y1="${LY - 5}" x2="${x}" y2="${LY + 5}" stroke="#fff" stroke-opacity=".5"/><text class="tick" x="${x}" y="${LY + 30}" text-anchor="${e.beats[0].year === 1992 ? 'start' : 'middle'}" fill="#fff" fill-opacity=".6">${e.beats[0].year}</text>`; }).join('')}
      <circle cx="${X0}" cy="${LY}" r="7" fill="#fff"/>
      <g class="${kf(head)}" style="transform:translateX(${X1}px)"><circle cy="${LY}" r="10" fill="none" stroke="#fff" stroke-opacity=".4"/><circle cy="${LY}" r="5" fill="#fff"/></g>
      <g class="${here_}"><circle cx="${X1}" cy="${LY}" r="10" fill="${NOW.bg}" stroke="${NOW.accent}" stroke-width="3"/><text class="tick" x="${X1 + 12}" y="${LY - 24}" text-anchor="end" fill="${NOW.accent}">YOU ARE HERE</text></g>
    </g>`;

  const label = `${person.name}. ${person.positioning} A title sequence from 1992 to today.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<defs>
  <clipPath id="screen"><rect ${full} rx="28"/></clipPath>
  <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  .9 0 0 0 -.3"/></filter>
  <filter id="rough"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="3"/></filter>
  <filter id="glow" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <radialGradient id="vig" cx=".5" cy=".5" r=".75"><stop offset=".55" stop-opacity="0"/><stop offset="1" stop-opacity=".62"/></radialGradient>
  <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1.6" opacity=".4"/></pattern>
  <linearGradient id="band" x2="0" y2="1"><stop stop-color="${pal.crt.accent}" stop-opacity="0"/><stop offset=".5" stop-color="${pal.crt.accent}" stop-opacity=".1"/><stop offset="1" stop-color="${pal.crt.accent}" stop-opacity="0"/></linearGradient>
  <pattern id="grid" width="150" height="150" patternUnits="userSpaceOnUse"><path d="M30 0V150M60 0V150M90 0V150M120 0V150M0 30H150M0 60H150M0 90H150M0 120H150" stroke="${pal.blueprint.accent}" stroke-opacity=".1"/><path d="M.5 0V150M0 .5H150" stroke="${pal.blueprint.accent}" stroke-opacity=".28"/></pattern>
  <linearGradient id="neon"><stop stop-color="${pal.electric.accent}"/><stop offset="1" stop-color="${pal.electric.accent2}"/></linearGradient>
  <radialGradient id="eglow" cx=".85" cy=".45" r=".7"><stop stop-color="${pal.electric.accent}" stop-opacity=".28"/><stop offset="1" stop-color="${pal.electric.bg}" stop-opacity="0"/></radialGradient>
  <radialGradient id="nowglow" cx=".9" cy="1.05" r=".95"><stop stop-color="${NOW.bg2}"/><stop offset="1" stop-color="${NOW.bg2}" stop-opacity="0"/></radialGradient>
</defs>
<style>
text{font-family:${FONT.sans}}
.a{animation-duration:${T.toFixed(2)}s;animation-timing-function:linear;animation-iteration-count:1;animation-fill-mode:both}
.era,.beat{opacity:0}
.kick{font:500 17px ${FONT.mono};letter-spacing:.14em}
.yr{font-size:230px;letter-spacing:-.03em}
.ti{font-size:54px}
.no{font-size:25px}
.fig{font:500 14px ${FONT.mono};letter-spacing:.14em}
.hand{font:400 30px ${FONT.hand}}
.m-film .yr,.m-film .ti,.m-film .no{font-family:${FONT.display}}
.m-film .yr,.m-film .ti{font-style:italic}
.m-crt .yr,.m-crt .ti,.m-crt .no{font-family:${FONT.mono}}
.m-crt .yr,.m-blueprint .yr{font-size:200px;letter-spacing:0}
.m-blueprint .yr{font-family:${FONT.mono};fill:none;stroke:${pal.blueprint.accent};stroke-width:2}
.m-blueprint .ti{font-weight:300;letter-spacing:.04em;font-size:48px}
.m-blueprint .no{font-family:${FONT.mono};font-size:21px;letter-spacing:.06em}
.m-chalk .yr,.m-chalk .ti,.m-chalk .no{font-family:${FONT.hand}}
.m-chalk .beat{filter:url(#rough)}
.m-chalk .ti{font-size:60px}
.m-chalk .no{font-size:32px}
.m-electric .yr{font-weight:800;fill:url(#neon);letter-spacing:-.05em}
.m-electric .ti{font-weight:600;font-size:50px}
.name{font:400 168px ${FONT.display};letter-spacing:-.035em}
.pos{font:400 30px ${FONT.display}}
.bk{font:500 14px ${FONT.mono};letter-spacing:.14em}
.bv{font:400 32px ${FONT.display}}
.bn{font:400 17px ${FONT.sans}}
.tick{font:500 13px ${FONT.mono};letter-spacing:.08em}
@keyframes flick{0%,100%{opacity:0}50%{opacity:.06}}
@keyframes scratch{0%,100%{opacity:0}30%{opacity:.35;transform:translateX(6px)}70%{opacity:.12;transform:translateX(-4px)}}
@keyframes band{to{transform:translateY(${H + 280}px)}}
@keyframes blink{0%{opacity:1}50%,100%{opacity:0}}
@keyframes pop{from{opacity:0}}
${css.join('\n')}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<g clip-path="url(#screen)">
  <rect ${full} fill="${NOW.bg}"/>
  ${scenes.join('\n  ')}
  ${nowFrame}
  ${lifeline}
</g>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="28" fill="none" stroke="#fff" stroke-opacity=".1"/>
</svg>
`;
}

// ---------- tickets: one per thing a visitor can open ----------
const TONE = { amber: '#f5b547', orange: '#ff8a4c', fuchsia: '#e879f9', violet: '#b9a8ff', cyan: '#35f0ff', green: '#3ee08f', blue: '#5cc8ff', rose: '#f4a7b9' };
function ticket({ kicker, title, line, foot, verb, tone }) {
  const c = TONE[tone] || TONE.violet, w = 600, h = 220, nx = 462, r = 18, n = 12, cx = (nx + w) / 2;
  const outline = `M${r} 0H${nx - n}A${n} ${n} 0 0 0 ${nx + n} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${nx + n}A${n} ${n} 0 0 0 ${nx - n} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ${w + 2} ${h + 2}" width="${w + 2}" height="${h + 2}" role="img" aria-label="${esc(title)}">
<style>.k{font:500 14px ${FONT.mono};letter-spacing:.14em}.t{font:400 40px ${FONT.display};letter-spacing:-.02em}.l{font:400 19px ${FONT.sans}}</style>
<path d="${outline}" fill="#100e1c" stroke="#fff" stroke-opacity=".16"/>
<path d="M${nx} ${n + 10}V${h - n - 10}" stroke="#fff" stroke-opacity=".24" stroke-width="2" stroke-dasharray="1 8" stroke-linecap="round"/>
<rect x="30" y="35" width="26" height="3" rx="1.5" fill="${c}"/>
<text class="k" x="66" y="42" fill="${c}">${esc(kicker.toUpperCase())}</text>
<text class="t" x="30" y="98" fill="#f6f4ff">${esc(clip(title, 20))}</text>
${wrap(line, 42).map((l, i) => `<text class="l" x="30" y="${134 + i * 26}" fill="#b6b2d2">${esc(l)}</text>`).join('')}
<text class="k" x="30" y="${h - 20}" fill="#85819f">${esc(foot.toUpperCase())}</text>
<circle cx="${cx}" cy="94" r="26" fill="none" stroke="${c}" stroke-width="2"/>
<path d="M${cx - 9} 103L${cx + 9} 85M${cx - 4} 85H${cx + 9}V98" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
<text class="k" x="${cx}" y="152" text-anchor="middle" fill="#b6b2d2">${esc(verb)}</text>
</svg>
`;
}

const tickets = [
  ...products.map((p) => ({ ...p, kicker: 'Now showing · Web', foot: host(p.url), verb: 'OPEN' })),
  ...apps.map((a) => ({ ...a, kicker: `App Store · ${a.platform}`, foot: 'apps.apple.com', verb: 'GET', tone: 'rose' })),
  ...videos.map((v) => ({ ...v, kicker: 'Latest video', line: day(v.date), foot: 'youtube.com', verb: 'WATCH', tone: 'orange' })),
].map((t) => ({ ...t, file: `assets/tickets/${slug(t.title)}.svg` }));

// ---------- README ----------
const facts = [lastShip && `last shipped ${lastShip.title}`, data.contributions && `${data.contributions.toLocaleString('en-IN')} contributions in the last year`].filter(Boolean);
const filmAlt = `${person.name}. ${person.positioning} ${count(products.length, 'product')} live${facts.length ? `, ${facts.join(', ')}` : ''}.`;
const readme = `<!-- Rebuilt every night by build.mjs. Edit data/story.json, not this file. -->
<a href="${person.home}"><img src="assets/film.svg" width="100%" alt="${esc(filmAlt)}"></a>

<p align="center">
${tickets.map((t) => `<a href="${esc(t.url)}"><img src="${t.file}" width="49%" alt="${esc(`${t.title}: ${t.line}`)}"></a>`).join('\n')}
</p>

<p align="center">${links.map(([l, u]) => `<a href="${u}">${l}</a>`).join(' · ')}</p>

<p align="center"><sub>Tonight's cut: ${[day(new Date()), ...facts].map(esc).join(' · ')}. Redrawn every night from live data by <a href="build.mjs">one script</a>.</sub></p>
`;

// ---------- write, then check what was written ----------
const out = { 'assets/film.svg': film(), 'README.md': readme, ...Object.fromEntries(tickets.map((t) => [t.file, ticket(t)])) };
assert.equal(esc(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
assert.deepEqual(wrap('one two three four', 8, 2), ['one two', 'three…']);
for (const [name, body] of Object.entries(out)) {
  assert(!/undefined|NaN|\[object/.test(body), `${name}: a value is missing`);
  if (name.endsWith('.svg')) assert.equal(body.match(/<g[\s>]/g)?.length ?? 0, body.match(/<\/g>/g)?.length ?? 0, `${name}: unbalanced groups`);
}
await rm(here('assets/tickets'), { recursive: true, force: true });
await mkdir(here('assets/tickets'), { recursive: true });
for (const [name, body] of Object.entries(out)) await writeFile(here(name), body);
await writeFile(here('data/cache.json'), JSON.stringify(data, null, 2) + '\n');
console.log(`built: film, ${tickets.length} tickets, README (${facts.join('; ') || 'no live facts'})`);
