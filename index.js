/**
 * Instagram Sorteo v8
 *
 * FIXES vs v7:
 * - scrollHeight crece dinámicamente → nunca termina por "fondo" solo
 * - Espera que el scrollHeight se estabilice antes de considerar terminado
 * - Pausa más larga entre scrolls para dar tiempo a Instagram a cargar
 * - Condición de fin: scrollHeight estable + sin nuevos comentarios por N rondas
 * - REGLA: un usuario = un voto. Duplicados ignorados.
 */

const { chromium } = require('playwright');
const fs = require('fs');

const CONFIG = {
  MAX_ITERATIONS: 1000,
  SCROLL_AMOUNT: 500,          // px por scroll
  SCROLL_PAUSE_MS: 1200,       // pausa entre scrolls
  CLICK_PAUSE_MS: 1500,        // pausa tras "Ver más"
  // Terminar cuando: N rondas seguidas sin nuevos usuarios Y scrollHeight estable
  STABLE_ROUNDS_TO_STOP: 25,
  YOUR_USERNAME: 'devhub.arg',
  COMMENTS_UL: 'ul._a9z6._a9za',
};

// ─── Intercepción de red ──────────────────────────────────────────────────────

function setupNetworkInterception(page, store) {
  page.on('response', async (response) => {
    const url = response.url();
    if (
      !(url.includes('/api/v1/media/') && url.includes('/comments')) &&
      !url.includes('graphql/query')
    ) return;

    let json = null;
    try { json = await response.json(); } catch (_) { return; }
    if (!json) return;

    let added = 0;

    if (Array.isArray(json.comments)) {
      for (const c of json.comments) {
        const u = c.user?.username || c.owner?.username;
        const t = c.text;
        if (u && t && u !== CONFIG.YOUR_USERNAME && !store.has(u)) {
          store.set(u, { username: u, comment: t });
          added++;
        }
      }
    }

    const edges =
      json.data?.media?.edge_media_to_parent_comment?.edges ||
      json.data?.shortcode_media?.edge_media_to_parent_comment?.edges;
    if (Array.isArray(edges)) {
      for (const e of edges) {
        const u = e?.node?.owner?.username;
        const t = e?.node?.text;
        if (u && t && u !== CONFIG.YOUR_USERNAME && !store.has(u)) {
          store.set(u, { username: u, comment: t });
          added++;
        }
      }
    }

    if (added > 0) {
      process.stdout.write(`  [red +${added} → total ${store.size}]\n`);
    }
  });
}

// ─── Scroll del UL de comentarios ────────────────────────────────────────────

async function scrollComments(page) {
  return await page.evaluate(({ selector, amount }) => {
    const ul = document.querySelector(selector);
    if (!ul) return { found: false, scrolled: 0, scrollTop: 0, scrollHeight: 0, clientHeight: 0 };

    const before = ul.scrollTop;
    ul.scrollTop += amount;
    const after = ul.scrollTop;

    return {
      found: true,
      scrolled: after - before,
      scrollTop: after,
      scrollHeight: ul.scrollHeight,
      clientHeight: ul.clientHeight,
      remaining: ul.scrollHeight - after - ul.clientHeight,
    };
  }, { selector: CONFIG.COMMENTS_UL, amount: CONFIG.SCROLL_AMOUNT });
}

// ─── Extracción DOM ───────────────────────────────────────────────────────────

async function extractDOM(page, store) {
  const found = await page.evaluate((myUser) => {
    const results = [];
    const selector = 'ul._a9z6._a9za li, article ul li';
    document.querySelectorAll(selector).forEach((li) => {
      try {
        let username = null;
        for (const a of li.querySelectorAll('a[href^="/"]')) {
          const href = a.getAttribute('href') || '';
          if (
            href.match(/^\/[a-zA-Z0-9._]+\/?$/) &&
            !href.startsWith('/p/') && !href.startsWith('/reel/') && !href.startsWith('/explore/')
          ) {
            const t = a.innerText?.trim();
            if (t && t.length > 0 && t.length < 40) { username = t; break; }
          }
        }
        if (!username || username === myUser) return;
        if (['Seguir','Follow','Me gusta','Like','Responder','Reply'].includes(username)) return;

        let comment = '';
        for (const s of li.querySelectorAll('span[dir="auto"]')) {
          const t = s.innerText?.trim();
          if (t) { comment = t; break; }
        }
        if (!comment) return;
        results.push({ username, comment });
      } catch (_) {}
    });
    return results;
  }, CONFIG.YOUR_USERNAME);

  let added = 0;
  for (const c of found) {
    if (!store.has(c.username)) { store.set(c.username, c); added++; }
  }
  return added;
}

// ─── Click "Ver más comentarios" ──────────────────────────────────────────────

async function clickLoadMore(page) {
  return await page.evaluate(() => {
    let n = 0;
    const triggers = ['más comentarios','more comments','ver más','view more','load more'];
    for (const el of document.querySelectorAll('button,[role="button"],a')) {
      const txt = (el.innerText || el.textContent || '').toLowerCase().trim();
      if (triggers.some(t => txt.includes(t))) {
        try { el.click(); n++; } catch (_) {}
      }
    }
    return n;
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: fs.existsSync('state.json') ? 'state.json' : undefined,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 1080 },
  });
  const page = await context.newPage();

  const store = new Map();
  setupNetworkInterception(page, store);

  console.log('Abriendo Instagram...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 0 });

  if (!fs.existsSync('state.json')) {
    console.log('\n[!] Iniciá sesión y presioná ENTER\n');
    await new Promise(r => process.stdin.once('data', r));
    await context.storageState({ path: 'state.json' });
    console.log('[✓] Sesión guardada.\n');
  }

  console.log('=========================================');
  console.log('1. NAVEGA AL POST DEL SORTEO');
  console.log('2. HACÉ CLICK EN EL ÍCONO DE COMENTARIOS');
  console.log('3. ESPERÁ que aparezcan comentarios');
  console.log('4. Presioná ENTER acá');
  console.log('=========================================\n');
  await new Promise(r => process.stdin.once('data', r));
  await page.waitForTimeout(2000);

  const ulFound = await page.evaluate((sel) => !!document.querySelector(sel), CONFIG.COMMENTS_UL);
  console.log(ulFound
    ? '[✓] UL de comentarios detectado. Iniciando scroll...\n'
    : '[!] UL no encontrado — asegurate de tener los comentarios abiertos.\n'
  );

  let stableRounds    = 0;
  let lastTotal       = 0;
  let lastScrollHeight = 0;

  for (let i = 0; i < CONFIG.MAX_ITERATIONS; i++) {
    const newDOM   = await extractDOM(page, store);
    const total    = store.size;
    const scrolled = await scrollComments(page);
    const clicked  = await clickLoadMore(page);

    // scrollHeight actual
    const sh = scrolled.scrollHeight || 0;
    const shGrew = sh > lastScrollHeight;
    lastScrollHeight = sh;

    console.log(
      `[${String(i+1).padStart(3)}] ` +
      `Únicos: ${String(total).padStart(5)} | ` +
      `+DOM: ${String(newDOM).padStart(3)} | ` +
      `scrollTop: ${String(Math.round(scrolled.scrollTop||0)).padStart(6)} | ` +
      `scrollH: ${String(sh).padStart(7)}` +
      (shGrew  ? ' ↑' : '  ') +
      (clicked ? ` | +más(${clicked})` : '')
    );

    // Estabilidad: sin nuevos usuarios Y scrollHeight dejó de crecer
    const isStable = (total === lastTotal) && !shGrew;
    if (isStable) stableRounds++;
    else stableRounds = 0;
    lastTotal = total;

    if (stableRounds >= CONFIG.STABLE_ROUNDS_TO_STOP) {
      console.log('\n[✓] scrollHeight estable y sin nuevos comentarios. Terminando.\n');
      break;
    }

    await page.waitForTimeout(clicked > 0 ? CONFIG.CLICK_PAUSE_MS : CONFIG.SCROLL_PAUSE_MS);
  }

  // ── Resultados ─────────────────────────────────────────────────────────────

  const uniqueUsers = Array.from(store.values());
  console.log(`Total participantes únicos: ${uniqueUsers.length}\n`);

  if (uniqueUsers.length === 0) {
    console.log('[✗] Sin comentarios. Abrí los comentarios del post antes de ENTER.\n');
    await browser.close();
    return;
  }

  fs.writeFileSync('comments_unique.json', JSON.stringify(uniqueUsers, null, 2));
  fs.writeFileSync('participants.json',    JSON.stringify(uniqueUsers.map(u => u.username), null, 2));

  const winner = uniqueUsers[Math.floor(Math.random() * uniqueUsers.length)];
  console.log('========== GANADOR ==========');
  console.log(`@${winner.username}`);
  console.log(`"${winner.comment}"`);
  console.log('=============================\n');
  fs.writeFileSync('winner.json', JSON.stringify(winner, null, 2));

  console.log('Archivos:');
  console.log('  participants.json  ← widget del video');
  console.log('  comments_unique.json');
  console.log('  winner.json\n');

  await browser.close();
}

main().catch(console.error);