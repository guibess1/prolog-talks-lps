// POST /api/seo — sugere URL, título e descrição a partir da copy da própria LP.
//
// Os três campos que o envio pro site pede saem todos de texto que já existe na
// LP: headline, subheadline, agenda, público, convidada, data. Escrever isso à
// mão é retrabalho, e é onde o padrão escapa (slug com data, título sem o tema,
// descrição que não nomeia porte nem cargo).
//
// Duas decisões de implementação:
//
//  - `fetch` puro, sem SDK. O ADR-001 fixou zero dependências no hub, e Vercel e
//    GitHub já são chamados por REST aqui. Uma dependência só pra isso quebraria
//    a única regra de stack do projeto.
//  - a IA recebe a COPY, não o HTML. Dos 263KB da LP, ~250 são fonte e imagem em
//    base64: mandar tudo custaria caro e não diria nada que a copy não diga.

const { corpo, json, metodo } = require('./_lib/http');
const auth = require('./_lib/auth');
const estado = require('./_lib/estado');
const { baixarLp, copyDaLp, fonteDe } = require('./_lib/lp');

const API = 'https://api.anthropic.com/v1/messages';
const MODELO = 'claude-opus-5';
const PRAZO = 45000;

// Prefixo da série sai daqui, não do modelo: é regra nossa (ADR-002) e não tem
// por que ser adivinhada. O modelo escreve só o slug do tema.
const SERIES = [
  { casa: /prolog\s*talks/i, prefixo: '/talks' },
  { casa: /prolog\s*day/i, prefixo: '/prolog-day' },
];
const PREFIXO_PADRAO = '/evento';

function prefixoDaSerie(evento) {
  const achou = SERIES.find((s) => s.casa.test(String(evento || '')));
  return achou ? achou.prefixo : PREFIXO_PADRAO;
}

function configurado() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const ESQUEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'titulo', 'descricao', 'porque'],
  properties: {
    slug: {
      type: 'string',
      description:
        'Slug do TEMA, sem a série e sem barra: 2 a 4 palavras, minúsculas, sem acento, ' +
        'hífen entre palavras, teto de ~30 caracteres. Sem data e sem nome de convidado. ' +
        'Sem stopword (como, para, de) quando dá pra cortar. Exemplo: adesao-de-motoristas',
    },
    titulo: {
      type: 'string',
      description:
        'Título da aba e do Google, até 100 caracteres, SEM o sufixo "· Prolog" (entra sozinho depois). ' +
        'Começa com o nome da série e nomeia o tema. Exemplo: Prolog Talks · Adesão de motoristas aos procedimentos',
    },
    descricao: {
      type: 'string',
      description:
        'Meta description de 120 a 158 caracteres. Diz que é live gratuita, a data e a hora, ' +
        'a dor concreta e o porte ou cargo do público. Frase natural, não lista de palavra-chave.',
    },
    porque: {
      type: 'string',
      description: 'Uma frase curta explicando a escolha do slug e do ângulo da descrição.',
    },
  },
};

const SISTEMA = `Você escreve metadados de SEO para landing pages de evento da Prolog, um SaaS brasileiro de gestão de frotas (pneus, checklist eletrônico e manutenção).

Regras da casa, todas obrigatórias:

1. SLUG — padrão \`/<série>/<slug-do-tema>\`. O slug é do TEMA, nunca do parceiro nem da data: parceiro muda e tema fica, e depois da live a mesma página vira a do replay, então data no slug envelhece e quebra todo link já compartilhado.
2. TÍTULO — nomeia a série e o tema. Sem data. O sufixo "· Prolog" é acrescentado depois pelo gerador, então não escreva.
3. DESCRIÇÃO — é anúncio, não resumo. Precisa dizer que é gratuita, quando é, e a dor concreta. O público-alvo é gestor de frota com 30 placas ou mais (gerente, coordenador, diretor ou dono), e nomear esse porte ou cargo autofiltra lead fraco antes do clique.
4. Português do Brasil. Nada de travessão (—) nem de tom publicitário genérico ("imperdível", "não perca", "revolucionário").
5. Use SÓ o que está na copy da LP. Não invente número, promessa, nome de cliente ou benefício que não esteja lá.`;

function pedido(lp, copy, prefixo) {
  return `Escreva os metadados da LP abaixo.

Série: ${lp.evento} → o slug vai virar ${prefixo}/<slug>
Data do evento: ${lp.data}

Copy que está no ar nesta LP:
${JSON.stringify(copy, null, 2)}`;
}

async function chamar(payload) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const prazo = setTimeout(() => ctrl && ctrl.abort(), PRAZO);
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined,
    });
    const texto = await r.text();
    let dados = {};
    try {
      dados = texto ? JSON.parse(texto) : {};
    } catch {
      dados = {};
    }
    if (!r.ok) {
      const msg = (dados.error && dados.error.message) || texto.slice(0, 200);
      throw Object.assign(new Error(`Anthropic ${r.status}: ${msg}`), { status: 502 });
    }
    return dados;
  } finally {
    clearTimeout(prazo);
  }
}

function limpar(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function normalizarSlug(s) {
  return limpar(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = async (req, res) => {
  if (!metodo(req, res, ['POST'])) return;
  const usuario = auth.usuarioDe(req);
  if (!usuario) return json(res, 401, { erro: 'sessão expirada' });
  // Mesmo poder que já governa editar esses campos na mão: sugerir não pode ser
  // mais restrito do que digitar.
  if (!auth.pode(usuario, 'status')) return json(res, 403, { erro: 'seu perfil é só de leitura' });
  if (!configurado()) {
    return json(res, 503, { erro: 'ANTHROPIC_API_KEY não configurada no projeto' });
  }

  const dados = corpo(req);

  try {
    const e = await estado.ler();
    const lp = e.lps.find((l) => l.id === dados.id);
    if (!lp) return json(res, 404, { erro: 'LP não encontrada' });

    // Cópia sem arquivo próprio lê a copy da origem — é exatamente o que a
    // pessoa está vendo no viewer, então a sugestão bate com a tela.
    const copy = copyDaLp(await baixarLp(req, await fonteDe(req, lp)));
    if (!copy.headline && !copy.subhead) {
      return json(res, 422, { erro: 'não achei headline nem subheadline nesta LP: nada pra usar de base' });
    }

    const prefixo = prefixoDaSerie(lp.evento);
    const resposta = await chamar({
      model: MODELO,
      max_tokens: 4000,
      // Tarefa curta e escopada: effort baixo. Thinking segue ligado (padrão do
      // Opus 5) porque desligar tem efeito colateral pior que o ganho aqui.
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: ESQUEMA },
      },
      system: SISTEMA,
      messages: [{ role: 'user', content: pedido(lp, copy, prefixo) }],
    });

    const bloco = (resposta.content || []).find((b) => b.type === 'text');
    if (!bloco) {
      return json(res, 502, {
        erro: `a IA não devolveu texto (stop_reason: ${resposta.stop_reason || '?'})`,
      });
    }

    let sugestao;
    try {
      sugestao = JSON.parse(bloco.text);
    } catch {
      return json(res, 502, { erro: 'a IA devolveu algo que não é JSON' });
    }

    // Validação nossa, depois da dela. O schema garante os campos e os tipos;
    // não garante o padrão de slug nem os limites de tamanho (JSON Schema de
    // structured output ignora minLength/maxLength).
    const slug = normalizarSlug(sugestao.slug);
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return json(res, 502, { erro: `slug sugerido não serve: "${sugestao.slug}"` });
    }

    let titulo = limpar(sugestao.titulo).replace(/\s*·\s*Prolog\s*$/i, '');
    let descricao = limpar(sugestao.descricao);

    return json(res, 200, {
      sugestao: {
        urlFinal: `${prefixo}/${slug}`,
        seoTitulo: titulo,
        seoDescricao: descricao,
        porque: limpar(sugestao.porque),
      },
      // O hub mostra isso pra pessoa decidir, em vez de esconder que passou do
      // ponto: o Google corta a descrição em ~160.
      avisos: [
        titulo.length > 120 ? `título com ${titulo.length} caracteres (o campo aceita 120)` : null,
        descricao.length > 160 ? `descrição com ${descricao.length} caracteres (o Google corta em ~160)` : null,
        descricao.length < 100 ? `descrição com só ${descricao.length} caracteres: dá pra dizer mais` : null,
      ].filter(Boolean),
      modelo: resposta.model || MODELO,
      custo: resposta.usage || null,
    });
  } catch (err) {
    return json(res, err.status || 500, { erro: String(err.message || err) });
  }
};

module.exports.configurado = configurado;
