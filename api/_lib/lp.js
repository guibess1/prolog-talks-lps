// Leitura da LP publicada pelo próprio deploy.
//
// A LP é rota pública (sem login), então ler por HTTP em vez de pelo disco
// mantém as funções independentes de como a Vercel empacota `public/` — e
// garante que o que a IA lê e o que vai pro site é byte a byte o mesmo arquivo
// que foi aprovado no viewer.

function origem(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function baixarLp(req, id) {
  const url = `${origem(req)}/${encodeURIComponent(id)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'prolog-lp-hub' } });
  if (!r.ok) {
    throw Object.assign(new Error(`não consegui ler a LP em ${url} (${r.status})`), { status: 502 });
  }
  return r.text();
}

// A LP duplicada nasce sem arquivo próprio: `public/<id>/index.html` entra num
// deploy, e deploy não acontece em runtime. Até subir, o preview dela vem do
// HTML da origem (campo `htmlDe`).
//
// Um HEAD responde qual dos dois está no ar, então não existe passo manual de
// "avisar o hub que o arquivo chegou": no primeiro carregamento depois do
// deploy, a cópia passa a servir o próprio arquivo sozinha.
async function existeNoDeploy(req, id) {
  try {
    const r = await fetch(`${origem(req)}/${encodeURIComponent(id)}`, {
      method: 'HEAD',
      headers: { 'User-Agent': 'prolog-lp-hub' },
    });
    return r.ok;
  } catch {
    // Rede ruim não pode virar "o arquivo existe": na dúvida fica o espelho, que
    // no pior caso mostra a LP de origem em vez de um 404.
    return false;
  }
}

// Qual id serve o HTML desta LP. LP sem `htmlDe` (todas as originais) responde
// ela mesma sem custar request.
async function fonteDe(req, lp) {
  if (!lp) return '';
  if (!lp.htmlDe || lp.htmlDe === lp.id) return lp.id;
  return (await existeNoDeploy(req, lp.id)) ? lp.id : lp.htmlDe;
}

// Texto limpo de um trecho de HTML: sem tag, sem entidade, sem espaço duplo.
function texto(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&(?:mdash|ndash);/g, '—')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    // Trocar tag por espaço deixa " ." quando a frase termina dentro de um span.
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function um(html, re) {
  const m = re.exec(html);
  return m ? texto(m[1]) : '';
}

function todos(html, re, limite) {
  const saida = [];
  let m;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = g.exec(html)) && saida.length < (limite || 20)) {
    const t = texto(m[1]);
    if (t) saida.push(t);
  }
  return saida;
}

// Briefing de copy: o que a LP realmente diz, em ~2KB.
//
// Mandar o HTML inteiro pra IA seria caro e inútil — 250 dos 263KB são fonte e
// imagem em base64. O que importa pra escrever título, descrição e slug é a
// copy, e ela cabe aqui.
function copyDaLp(bruto) {
  // Comentário de HTML sai primeiro. A LP tem blocos comentados à espera de
  // decisão (o material rico, por exemplo) — sem isso a IA leria como copy no
  // ar coisa que não está no ar.
  const html = String(bruto).replace(/<!--[\s\S]*?-->/g, '');
  const hero = /<h1 class="pt-headline">([\s\S]*?)<\/h1>/.exec(html);
  const agenda = [];
  const reAgenda = /<div class="pt-agenda-text">\s*<h4>([\s\S]*?)<\/h4>\s*<p>([\s\S]*?)<\/p>/g;
  let a;
  while ((a = reAgenda.exec(html)) && agenda.length < 8) {
    agenda.push({ titulo: texto(a[1]), texto: texto(a[2]) });
  }

  return {
    tituloDaPagina: um(html, /<title>([\s\S]*?)<\/title>/i),
    edicao: um(html, /<span class="pt-edition">([\s\S]*?)<\/span>/),
    headline: hero ? texto(hero[1]) : '',
    subhead: um(html, /<p class="pt-subhead">([\s\S]*?)<\/p>/),
    quando: um(html, /<div class="pt-card-meta-mini">[\s\S]*?<span>([\s\S]*?)<\/span>/),
    convidada: {
      nome: um(html, /<div class="pt-speaker-name">([\s\S]*?)<\/div>/),
      cargo: um(html, /<div class="pt-speaker-role">([\s\S]*?)<\/div>/),
    },
    kicker: um(html, /<span class="pt-kicker">([\s\S]*?)<\/span>/),
    tituloDaSecao: um(html, /<h2 class="pt-section-title">([\s\S]*?)<\/h2>/),
    introDaSecao: um(html, /<p class="pt-section-intro">([\s\S]*?)<\/p>/),
    agenda,
    beneficios: todos(html, /<div class="pt-benefit-icon">[\s\S]*?<h4>([\s\S]*?)<\/h4>/, 6),
    publico: todos(html, /<li><svg[\s\S]*?<\/svg>([\s\S]*?)<\/li>/, 6),
    ctaFinal: um(html, /<div class="pt-cta-final pt-reveal">\s*<h2>([\s\S]*?)<\/h2>/),
  };
}

module.exports = { origem, baixarLp, copyDaLp, texto, existeNoDeploy, fonteDe };
