// POST /api/publicar — manda a LP aprovada pra estrutura do site comercial.
//
// O que ele faz, em uma frase: converte a LP em `src/pages/<serie>/<slug>.astro`,
// commita a página e as imagens numa branch e abre PR pra `dev` no repo
// `prologapp/site-comercial-prolog`.
//
// O que ele NÃO faz, de propósito: mergear, mexer em `main` ou fazer deploy. O
// fluxo do site é branch → PR pra dev → PR dev → main, e é no PR pra `main` que
// roda a esteira `validate` (lint, type-check, testes, build, links, smoke). O
// botão elimina o trabalho manual de portar a LP; o gate de release continua
// sendo a CI.
//
// `previa: true` devolve o arquivo que SERIA commitado, sem tocar no GitHub.

const { corpo, json, metodo } = require('./_lib/http');
const auth = require('./_lib/auth');
const estado = require('./_lib/estado');
const site = require('./_lib/site');
const { baixarLp, fonteDe } = require('./_lib/lp');

const PUBLICAVEIS = ['aprovada', 'publicada'];

function corpoDoPr(lp, resumo, usuario) {
  const ativos = resumo.ativos.length
    ? resumo.ativos.map((a) => `- \`${a.caminho}\` — ${a.kb} KB`).join('\n')
    : '- nenhum (a LP não tinha imagem embutida)';

  return `## O que é

Landing page de inscrição do **${lp.evento} de ${lp.data}** — ${lp.titulo}.

Rota nova: **\`${resumo.rota}\`** (padrão do [ADR-002](https://prologapp.com): \`/<série>/<slug-do-tema>\`, sem data no slug pra a mesma página virar a do replay).

## O que entra

- \`${resumo.pagina}\` — ${resumo.kbPagina} KB
${ativos}

## Como foi gerado

Página **gerada pelo LP Hub** (\`prolog-talks-lps.vercel.app/ver/${lp.id}\`), não escrita à mão. A LP foi aprovada lá com o formato mobile e os comentários resolvidos antes do envio.

A conversão faz quatro coisas:

1. Descarta a moldura de preview e o \`@font-face\` em base64 — Figtree e Prompt já vêm do \`BaseLayout\`
2. Tira as imagens embutidas em base64 e commita como arquivo em \`public/\`, então o HTML cai de ~260 KB pra ${resumo.kbPagina} KB e o browser passa a cachear a imagem
3. Envolve tudo em \`BaseLayout\` com \`bare\` (a LP tem CTA fixo e formulário próprios) — CSS e script em \`is:inline\`, porque o CSS já nasce escopado em \`.pt-lp\`
4. ${resumo.temJsonLd ? 'Monta o JSON-LD de `Event` com data, horário e convidada tirados da própria LP' : '⚠️ Não gerou JSON-LD de `Event` — data ou horário não deram pra ler da LP'}

## Conferir antes de mergear

> A esteira \`validate\` roda no PR \`dev → main\`, não neste. O que está abaixo é o que ela não vê.

- [ ] \`bun run build\` passa e a rota sai em \`dist${resumo.rota}\`
- [ ] Formulário do HubSpot monta e o envio cai no CRM (portal 44667852)
- [ ] Mobile 390: dobramento, CTA fixo e countdown
- [ ] Mobile: o banner de cookie não fica coberto pela barra de CTA (a página sobe o banner 72px; se o \`CookieConsent\` mudar de classe, a regra para de valer e vale rever)
- [ ] Sem \`noindex\` (o preview tem, a página real não pode ter)

> \`pages.json\` não foi tocado: ele é o tracker da migração das 138 páginas do WordPress, e esta página não vem do site antigo. O controle de LP de evento fica no LP Hub.

---

Enviado por **${usuario.nome}** pelo botão "Enviar pro site" do LP Hub.`;
}

module.exports = async (req, res) => {
  if (!metodo(req, res, ['POST'])) return;
  const usuario = auth.usuarioDe(req);
  if (!usuario) return json(res, 401, { erro: 'sessão expirada' });
  if (!auth.pode(usuario, 'publicar')) {
    return json(res, 403, { erro: 'só quem tem perfil de admin manda LP pro repo do site' });
  }

  const dados = corpo(req);
  const previa = Boolean(dados.previa);

  try {
    if (!previa && !site.gitConfigurado()) {
      return json(res, 503, {
        erro: 'GITHUB_TOKEN não configurado: sem ele o hub não consegue abrir PR no repo do site',
      });
    }
    // Checado ANTES de mexer no GitHub: sem persistência o registro do envio
    // falharia depois do PR já aberto, e o hub passaria a mentir sobre o que foi
    // enviado. Melhor recusar de saída.
    if (!previa && !estado.configurado()) {
      return json(res, 503, { erro: 'persistência não configurada: o envio não teria onde ser registrado' });
    }

    const e = await estado.ler();
    const lp = e.lps.find((l) => l.id === dados.id);
    if (!lp) return json(res, 404, { erro: 'LP não encontrada' });

    // Cópia sem arquivo próprio ainda mostra o HTML da origem. Gerar a página a
    // partir dele publicaria a copy do OUTRO evento numa rota nova — erro caro e
    // difícil de notar depois do merge. Não é forçável de propósito.
    const fonte = await fonteDe(req, lp);
    if (fonte !== lp.id) {
      return json(res, 409, {
        erro:
          `esta LP ainda é um espelho da "${fonte}": suba public/${lp.id}/index.html num deploy ` +
          'antes de mandar pro site, senão o PR sairia com a copy do outro evento',
      });
    }

    const abertos = e.comentarios.filter((c) => c.lp === lp.id && c.status !== 'resolvido').length;
    if (!previa) {
      // Duas travas, ambas puláveis com `forcar` — mas não por acidente. Mandar
      // pro repo uma LP com ajuste pendente é como aprovar sozinho o que o time
      // ainda está discutindo.
      if (!PUBLICAVEIS.includes(lp.status)) {
        return json(res, 409, {
          erro: `a LP está "${lp.status}": marque como aprovada antes de enviar pro site`,
          precisaForcar: true,
        });
      }
      if (abertos && !dados.forcar) {
        return json(res, 409, {
          erro: `tem ${abertos} ajuste${abertos > 1 ? 's' : ''} em aberto nesta LP`,
          precisaForcar: true,
        });
      }
    }

    const html = await baixarLp(req, lp.id);
    const convertido = site.converter(lp, html);

    if (previa) {
      return json(res, 200, {
        resumo: convertido.resumo,
        arquivo: convertido.arquivos[0].texto.slice(0, 20000),
        truncado: convertido.arquivos[0].texto.length > 20000,
        gitConfigurado: site.gitConfigurado(),
      });
    }

    const cfg = site.cfgGit();
    const commit = await site.commitar({
      branch: convertido.caminhos.branch,
      arquivos: convertido.arquivos,
      mensagem:
        `feat(talks): LP de inscrição em ${convertido.caminhos.rota}\n\n` +
        `${lp.evento} de ${lp.data} — ${lp.titulo}.\n` +
        `Página gerada pelo LP Hub a partir da LP aprovada (/ver/${lp.id}).`,
      autor: { nome: usuario.nome, email: usuario.email },
    });

    const pr = await site.abrirPr({
      branch: convertido.caminhos.branch,
      titulo: `feat(talks): LP de inscrição do ${lp.evento} de ${lp.data}`,
      corpo: corpoDoPr(lp, convertido.resumo, usuario),
    });

    const envio = {
      pr: pr.numero,
      url: pr.url,
      branch: convertido.caminhos.branch,
      base: cfg.base,
      sha: commit.sha,
      rota: convertido.caminhos.rota,
      semMudanca: commit.semMudanca,
      por: usuario.nome,
      em: new Date().toISOString(),
    };

    await estado.mutar((atual) => {
      const alvo = atual.lps.find((l) => l.id === lp.id);
      if (!alvo) return;
      alvo.envios = alvo.envios || [];
      alvo.envios.push(envio);
    });

    return json(res, 200, { envio, resumo: convertido.resumo, prNovo: !pr.jaExistia });
  } catch (err) {
    return json(res, err.status || 500, { erro: String(err.message || err) });
  }
};
