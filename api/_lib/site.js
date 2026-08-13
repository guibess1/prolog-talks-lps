// Ponte entre o hub e o repositório do site comercial.
//
// Duas responsabilidades, separadas de propósito:
//
//   1. converter()  — LP de preview (HTML autocontido, feito pra colar em widget)
//                     em página .astro na estrutura de `site-comercial-prolog`
//   2. abrirPr()    — commitar essa página numa branch e abrir PR pra `dev`
//
// Nada aqui escreve em `main` nem faz deploy: o site publica sozinho quando o PR
// `dev → main` é mergeado, e quem aprova é o CTO. O botão do hub para no PR de
// propósito — é o único ponto do fluxo em que revisão humana ainda cabe.

const GH = 'https://api.github.com';

// Data URI acima disso vira arquivo em public/ em vez de ficar embutido.
// Abaixo (ícone SVG, gradiente) sai mais caro pedir um request do que embutir.
const TETO_EMBUTIDO = 4096;

const MIMES = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

function cfgGit() {
  return {
    token: process.env.GITHUB_TOKEN,
    repo: process.env.SITE_REPO || 'prologapp/site-comercial-prolog',
    base: process.env.SITE_BASE_BRANCH || 'dev',
  };
}

function gitConfigurado() {
  return Boolean(cfgGit().token);
}

/* ========================================================================== *
 *  1. LP de preview  →  página .astro
 * ========================================================================== */

// A LP tem sempre a mesma anatomia: <style> de preview, <style> com o CSS
// escopado em .pt-lp, <div class="pt-lp"> com o markup e um <script> final.
// Fatiar por marcador é mais previsível do que parsear: o que interessa é
// justamente o que está DENTRO desses limites.
function fatiar(html) {
  const iMarkup = html.indexOf('<div class="pt-lp">');
  if (iMarkup < 0) throw erro('a LP não tem o container .pt-lp — não é uma LP do padrão do hub', 422);

  const iBody = html.lastIndexOf('</body>');
  const fim = iBody > 0 ? iBody : html.length;
  const iScript = html.lastIndexOf('<script', fim);

  // Só entra o <style> que fala de .pt-lp. Isso descarta, sem lista de exceção,
  // o reset da moldura de preview e o bloco de @font-face em base64 — as fontes
  // no site vêm do Google Fonts carregado pelo BaseLayout.
  const estilos = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html)) && m.index < iMarkup) {
    if (m[1].includes('.pt-lp')) estilos.push(m[1].trim());
  }
  if (!estilos.length) throw erro('não achei o CSS escopado em .pt-lp na LP', 422);

  const markupBruto = html.slice(iMarkup, iScript > iMarkup ? iScript : fim);
  const script = iScript > iMarkup ? html.slice(iScript, html.indexOf('</script>', iScript) + 9) : '';

  return {
    // Reserva de SEO: se o hub não tiver título/descrição próprios, o fallback
    // sai da própria LP (o <title> e a subheadline do hero), nunca de texto
    // inventado. O <meta description> do preview NÃO serve — fala de preview.
    tituloDaLp: texto(/<title>([\s\S]*?)<\/title>/i.exec(html)),
    subhead: texto(/<p class="pt-subhead">([\s\S]*?)<\/p>/i.exec(html)),
    css: estilos.join('\n\n'),
    // Comentário de HTML na LP é recado interno ("TROCAR: foto da Kilsa"),
    // além do bloco de material rico que está comentado à espera de decisão.
    // Nada disso tem o que fazer numa página pública.
    markup: markupBruto.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trimEnd(),
    script: script.replace(/^<script\b[^>]*>/i, '<script is:inline>'),
  };
}

// Texto limpo de um trecho de HTML: sem tag, sem entidade, sem espaço duplo.
// Usado só pra SEO e para o nome de arquivo — nunca volta pro markup.
function texto(m) {
  if (!m) return '';
  return m[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&middot;/g, '·')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&(?:mdash|ndash);/g, '—')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Nome do arquivo a partir do contexto: a custom property do hero vira hero.jpg,
// e uma <img> vira o slug do próprio alt. O alt costuma vir DEPOIS do base64
// (`<img src="data:…" alt="Prolog talks">`), por isso olha os dois lados.
function apelido(antes, depois, n, ext) {
  if (/--hero-img/.test(antes)) return `hero.${ext}`;
  const alt = /alt="([^"]{2,60})"/.exec(antes) || /alt="([^"]{2,60})"/.exec(depois);
  if (alt) {
    const s = slug(alt[1]);
    if (s) return `${s}.${ext}`;
  }
  return `ativo-${n}.${ext}`;
}

// Tira as imagens grandes de dentro do CSS/markup e devolve como arquivo. A LP
// embute tudo em base64 porque nasceu pra colar num widget de Elementor, onde
// não havia onde hospedar. No repo do site há: `public/` resolve isso, o
// browser cacheia a imagem e o HTML volta a caber em poucos KB.
function extrairAtivos(texto, pasta, contador) {
  const ativos = [];
  const saida = texto.replace(
    /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/gi,
    (todo, mime, b64, pos) => {
      if (todo.length <= TETO_EMBUTIDO) return todo;
      const ext = MIMES[String(mime).toLowerCase()] || 'bin';
      const antes = texto.slice(Math.max(0, pos - 220), pos);
      const depois = texto.slice(pos + todo.length, pos + todo.length + 220);
      const nome = apelido(antes, depois, ++contador.n, ext);
      ativos.push({ caminho: `${pasta}/${nome}`, base64: b64 });
      return `/${pasta.replace(/^public\//, '')}/${nome}`;
    }
  );
  return { texto: saida, ativos };
}

// Convenção do site: o título da aba termina em " · Prolog" (buildTitle, em
// src/lib/seo.ts). O teto de 160 é o que o Google mostra de description.
const SUFIXO_TITULO = ' · Prolog';
const TETO_DESCRICAO = 160;

function seoDaLp(lp, fatias) {
  let titulo = String(lp.seoTitulo || fatias.tituloDaLp || lp.titulo || '').trim();
  if (!titulo) throw erro('sem título de SEO: preencha o campo antes de enviar pro site', 422);
  if (!titulo.endsWith(SUFIXO_TITULO)) titulo += SUFIXO_TITULO;

  let descricao = String(lp.seoDescricao || fatias.subhead || '').trim();
  if (!descricao) throw erro('sem descrição de SEO: preencha o campo antes de enviar pro site', 422);
  if (descricao.length > TETO_DESCRICAO) descricao = descricao.slice(0, TETO_DESCRICAO - 1).trimEnd() + '…';

  return { titulo, descricao };
}

// dd/mm/aaaa + hh:mm (horário de Brasília, UTC-3) → ISO com offset explícito.
// Sem offset o Google interpreta como UTC e a data do evento aparece errada.
function iso(dataBr, hora) {
  const p = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dataBr || '').trim());
  if (!p) return null;
  const h = /^(\d{1,2})[h:](\d{2})?$/.exec(String(hora || '19h').trim());
  const hh = h ? String(h[1]).padStart(2, '0') : '19';
  const mm = h && h[2] ? h[2] : '00';
  return `${p[3]}-${p[2]}-${p[1]}T${hh}:${mm}:00-03:00`;
}

// A LP já carrega o horário real do evento no bloco de "adicionar à agenda".
// Ler dali é melhor do que pedir a informação de novo: é o mesmo dado que o
// inscrito salva no calendário, então não tem como divergir.
function janelaDoIcs(script) {
  const p = (chave) => {
    const m = new RegExp(chave + `:\\s*'(\\d{8}T\\d{6}Z)'`).exec(script);
    if (!m) return null;
    const v = m[1];
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`;
  };
  const inicio = p('startUTC');
  const fim = p('endUTC');
  return inicio ? { inicio, fim } : null;
}

function eventoJsonLd(lp, seo, markup, script, canonical, ogAbsoluta) {
  const janela = janelaDoIcs(script);
  const inicio = (janela && janela.inicio) || iso(lp.data, lp.hora);
  if (!inicio) return null;

  const convidado = /<div class="pt-speaker-name">([^<]+)<\/div>/.exec(markup);
  const dados = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: seo.titulo.replace(SUFIXO_TITULO, ''),
    startDate: inicio,
    eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
    eventStatus: 'https://schema.org/EventScheduled',
    location: {
      '@type': 'VirtualLocation',
      url: canonical,
    },
    organizer: { '@type': 'Organization', name: 'Prolog', url: 'https://prologapp.com/' },
    isAccessibleForFree: true,
    inLanguage: 'pt-BR',
    url: canonical,
  };
  if (janela && janela.fim) dados.endDate = janela.fim;
  dados.description = seo.descricao;
  if (ogAbsoluta) dados.image = [ogAbsoluta];
  if (convidado) dados.performer = { '@type': 'Person', name: convidado[1].trim() };
  return dados;
}

// A LP nasce autocontida, pra rodar fora do site, e por isso linka o domínio por
// extenso (`href="https://prologapp.com"` no rodapé). Dentro do repo isso é
// violação: o `check:links` reprova link absoluto pro próprio domínio fora do
// <head> (regra `self-absolute`), e foi o que barrou a esteira na primeira
// tentativa de release. Canonical, og:image e JSON-LD seguem absolutos — eles
// estão no <head> e são isentos por posição.
//
// A barra final também importa: o site é `trailingSlash: 'always'` e existe regra
// `no-trailing-slash`. Só não acrescenta em link com âncora, query ou extensão de
// arquivo, que não são rota.
function relativizar(markup) {
  return markup.replace(
    /(\s(?:href|src)\s*=\s*")https?:\/\/(?:www\.)?prologapp\.com([^"]*)(")/gi,
    (todo, antes, caminho, depois) => {
      let p = caminho || '/';
      if (!p.startsWith('/')) p = '/' + p;
      const ultimo = p.split('/').pop();
      const eRota = !p.endsWith('/') && !p.includes('#') && !p.includes('?') && !ultimo.includes('.');
      return antes + (eRota ? p + '/' : p) + depois;
    }
  );
}

// A LP tem CTA laranja fixo no rodapé em mobile (z-index 999). O banner de cookie
// do site também é fixo embaixo, com z-index bem menor: na largura de celular a
// barra cobria justamente os botões de aceitar. Some quando o visitante aceita,
// mas é a primeira coisa que ele vê. Levanta o banner acima da barra.
//
// Rule aditiva de propósito: se as classes do banner mudarem, ela para de valer
// e ninguém quebra — o pior caso volta a ser o que já acontece hoje.
const CSS_CONVIVENCIA = `/* ===== Convivência com o chrome do site (adicionado pelo LP Hub) ===== */
@media (max-width: 720px) {
  .pt-lp ~ astro-island div.fixed.bottom-4,
  .pt-lp ~ div.fixed.bottom-4 {
    bottom: calc(72px + env(safe-area-inset-bottom));
  }
}`;

// `/talks/adesao-de-motoristas` → rota, arquivo da página e pasta dos ativos.
function caminhos(urlFinal) {
  if (!/^\/[a-z0-9-]+\/[a-z0-9-]+$/.test(String(urlFinal || ''))) {
    throw erro('a LP não tem URL final no padrão /serie/slug — preencha antes de publicar', 422);
  }
  const partes = urlFinal.slice(1).split('/');
  return {
    rota: `${urlFinal}/`,
    pagina: `src/pages/${partes.join('/')}.astro`,
    ativos: `public/${partes.join('/')}`,
    branch: `lp/${partes.join('-')}`,
  };
}

function converter(lp, html) {
  const c = caminhos(lp.urlFinal);
  const fatias = fatiar(html);
  const contador = { n: 0 };

  const css = extrairAtivos(fatias.css, c.ativos, contador);
  const markup = extrairAtivos(fatias.markup, c.ativos, contador);
  const ativos = css.ativos.concat(markup.ativos);

  // <script> dentro do markup (o embed do HubSpot) precisa de is:inline, senão
  // o Astro tenta empacotar e o form não sobe.
  const markupFinal = relativizar(
    markup.texto.replace(/<script(?![^>]*is:inline)([^>]*)>/gi, '<script is:inline$1>')
  );

  const seo = seoDaLp(lp, fatias);
  const { titulo, descricao } = seo;
  const canonical = `https://prologapp.com${c.rota}`;
  const hero = ativos.find((a) => /\/hero\./.test(a.caminho));
  const og = hero ? `/${hero.caminho.replace(/^public\//, '')}` : null;
  const jsonLd = eventoJsonLd(lp, seo, markupFinal, fatias.script, canonical, og ? `https://prologapp.com${og}` : null);

  const cabecalho = [
    '---',
    '/**',
    ` * ${c.rota} — landing page de inscrição do ${lp.evento} de ${lp.data}.`,
    ' *',
    ' * Página GERADA pelo LP Hub (botão "Enviar pro site" em',
    ` * prolog-talks-lps.vercel.app/ver/${lp.id}). A fonte é a LP aprovada no hub;`,
    ' * editar aqui na mão faz o próximo envio sobrescrever a mão.',
    ' *',
    ' * Autocontida: BaseLayout com `bare` (sem TopBar de aviso e sem FAB do',
    ' * WhatsApp — a LP tem CTA fixo próprio e formulário do HubSpot). O CSS vai em',
    ' * `is:inline` porque já nasce escopado em `.pt-lp` e não deve passar pelo',
    ' * scoping do Astro; o script também, pra não ser empacotado.',
    ' */',
    "import BaseLayout from '@/components/layout/BaseLayout.astro';",
    '',
    `const title = ${JSON.stringify(titulo)};`,
    `const description = ${JSON.stringify(descricao)};`,
    `const canonical = ${JSON.stringify(canonical)};`,
    og ? `const ogImage = ${JSON.stringify(og)};` : null,
    jsonLd ? `const jsonLd = ${JSON.stringify(jsonLd, null, 2)};` : null,
    '---',
    '',
    `<BaseLayout title={title} description={description} canonical={canonical}${og ? ' image={ogImage}' : ''}${jsonLd ? ' jsonLd={jsonLd}' : ''} bare>`,
    '  <style is:inline>',
    css.texto,
    '',
    CSS_CONVIVENCIA,
    '  </style>',
    '',
    markupFinal,
    '',
    fatias.script,
    '</BaseLayout>',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');

  return {
    caminhos: c,
    arquivos: [{ caminho: c.pagina, texto: cabecalho }].concat(ativos),
    // Só pra mostrar no hub antes de abrir o PR
    resumo: {
      pagina: c.pagina,
      rota: c.rota,
      ativos: ativos.map((a) => ({
        caminho: a.caminho,
        kb: Math.round((a.base64.length * 0.75) / 1024),
      })),
      kbPagina: Math.round(Buffer.byteLength(cabecalho, 'utf8') / 1024),
      temJsonLd: Boolean(jsonLd),
    },
  };
}

/* ========================================================================== *
 *  2. Branch + commit + PR
 * ========================================================================== */

function erro(msg, status) {
  return Object.assign(new Error(msg), { status: status || 500 });
}

async function gh(rota, opcoes) {
  const c = cfgGit();
  if (!c.token) throw erro('GITHUB_TOKEN não configurado no projeto', 503);
  const r = await fetch(`${GH}/repos/${c.repo}${rota}`, {
    method: (opcoes && opcoes.metodo) || 'GET',
    headers: {
      Authorization: `Bearer ${c.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'prolog-lp-hub',
      ...(opcoes && opcoes.corpo ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opcoes && opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
  });
  const texto = await r.text();
  let dados = {};
  try {
    dados = texto ? JSON.parse(texto) : {};
  } catch {
    dados = { raw: texto };
  }
  if (!r.ok) {
    const e = erro(
      `GitHub ${r.status} em ${rota}: ${dados.message || texto.slice(0, 200)}`,
      r.status === 404 || r.status === 401 || r.status === 403 ? 502 : 502
    );
    e.gh = { status: r.status, rota, dados };
    throw e;
  }
  return dados;
}

// Um commit só, com todos os arquivos: a API de conteúdo faria um commit por
// arquivo e sujaria o histórico do site com "adiciona hero.jpg" solto.
async function commitar({ branch, arquivos, mensagem, autor }) {
  const c = cfgGit();
  const baseRef = await gh(`/git/ref/heads/${encodeURIComponent(c.base)}`);
  const baseSha = baseRef.object.sha;

  let paiSha = baseSha;
  let branchNova = true;
  try {
    const ref = await gh(`/git/ref/heads/${encodeURIComponent(branch)}`);
    paiSha = ref.object.sha;
    branchNova = false;
  } catch (e) {
    if (!e.gh || e.gh.status !== 404) throw e;
    await gh('/git/refs', { metodo: 'POST', corpo: { ref: `refs/heads/${branch}`, sha: baseSha } });
  }

  const pai = await gh(`/git/commits/${paiSha}`);

  const tree = [];
  for (const a of arquivos) {
    const blob = await gh('/git/blobs', {
      metodo: 'POST',
      corpo: a.base64
        ? { content: a.base64, encoding: 'base64' }
        : { content: a.texto, encoding: 'utf-8' },
    });
    tree.push({ path: a.caminho, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const arvore = await gh('/git/trees', {
    metodo: 'POST',
    corpo: { base_tree: pai.tree.sha, tree },
  });

  // Nada mudou: não cria commit vazio nem PR novo.
  if (arvore.sha === pai.tree.sha) {
    return { branch, sha: paiSha, semMudanca: true, branchNova };
  }

  const commit = await gh('/git/commits', {
    metodo: 'POST',
    corpo: {
      message: mensagem,
      tree: arvore.sha,
      parents: [paiSha],
      ...(autor && autor.email ? { author: { name: autor.nome, email: autor.email } } : {}),
    },
  });

  await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, {
    metodo: 'PATCH',
    corpo: { sha: commit.sha, force: false },
  });

  return { branch, sha: commit.sha, semMudanca: false, branchNova };
}

async function abrirPr({ branch, titulo, corpo }) {
  const c = cfgGit();
  const dono = c.repo.split('/')[0];
  const abertos = await gh(
    `/pulls?state=open&base=${encodeURIComponent(c.base)}&head=${encodeURIComponent(dono + ':' + branch)}`
  );
  if (Array.isArray(abertos) && abertos.length) {
    return { numero: abertos[0].number, url: abertos[0].html_url, jaExistia: true };
  }
  const pr = await gh('/pulls', {
    metodo: 'POST',
    corpo: { title: titulo, head: branch, base: c.base, body: corpo, draft: false },
  });
  return { numero: pr.number, url: pr.html_url, jaExistia: false };
}

module.exports = {
  converter,
  caminhos,
  commitar,
  abrirPr,
  cfgGit,
  gitConfigurado,
  TETO_EMBUTIDO,
};
