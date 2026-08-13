// POST /api/briefing — lê o documento do evento e devolve os campos da LP.
//
// O briefing do evento já existe: está no Outline, no PDF que o parceiro mandou,
// no print do card. Redigitar título, data e URL a partir dele é retrabalho — e
// é onde o padrão escapa (data em formato errado, slug com data, título sem o
// tema).
//
// O efeito colateral é o mais útil: o campo `faltando` diz o que o documento NÃO
// responde. Se o outline do evento estiver pela metade, isso aparece antes de a
// LP existir, em vez de aparecer na revisão.
//
// Mesmas decisões do api/seo.js: `fetch` puro (o hub não tem dependência) e
// structured output pra resposta vir validada em vez de parseada na unha.

const { corpo, json, metodo } = require('./_lib/http');
const auth = require('./_lib/auth');

const API = 'https://api.anthropic.com/v1/messages';
const MODELO = 'claude-opus-5';
const PRAZO = 60000;

// A função da Vercel aceita ~4.5MB de corpo, e base64 infla 33%. O teto aqui é
// do arquivo original, antes de virar base64.
const TETO_ARQUIVO = 3 * 1024 * 1024;

const IMAGENS = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
const TEXTOS = ['text/markdown', 'text/plain', 'text/csv', 'text/html', 'application/json'];

const SERIES = [
  { casa: /prolog\s*talks/i, prefixo: '/talks' },
  { casa: /prolog\s*day/i, prefixo: '/prolog-day' },
];

function prefixoDaSerie(evento) {
  const achou = SERIES.find((s) => s.casa.test(String(evento || '')));
  return achou ? achou.prefixo : '/evento';
}

function configurado() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const ESQUEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'titulo', 'evento', 'data', 'versaoLp', 'nota', 'slug', 'seoTitulo', 'seoDescricao', 'faltando'],
  properties: {
    id: {
      type: 'string',
      description:
        'Id da pasta da LP no padrão da casa: <parceiro-ou-tema>-<dd>-<mm>, minúsculo, sem acento, ' +
        'hífen entre palavras. Exemplo: paludo-25-08. Em branco se a data não estiver no documento.',
    },
    titulo: {
      type: 'string',
      description: 'Título interno do cartão, até 90 caracteres: o TEMA da live, como o time fala dele. Sem a data.',
    },
    evento: {
      type: 'string',
      description: 'Nome da série: "Prolog Talks", "Prolog Day" ou o que o documento disser. Em branco se não disser.',
    },
    data: {
      type: 'string',
      description: 'Data do evento em dd/mm/aaaa. Em branco se o documento não trouxer data.',
    },
    versaoLp: { type: 'string', description: 'Versão da LP. Use "v1.0" quando o documento não falar de versão.' },
    nota: {
      type: 'string',
      description:
        'Uma frase, até 240 caracteres, dizendo o que essa LP tem de específico: parceiro, convidado e ângulo do tema.',
    },
    slug: {
      type: 'string',
      description:
        'Slug do TEMA pra URL no site, sem a série e sem barra: 2 a 4 palavras, minúsculas, sem acento, ' +
        'hífen entre palavras. Sem data e sem nome de parceiro ou convidado. Exemplo: recapagem-de-carcaca',
    },
    seoTitulo: {
      type: 'string',
      description: 'Título da aba e do Google, até 100 caracteres, SEM o sufixo "· Prolog". Nomeia a série e o tema.',
    },
    seoDescricao: {
      type: 'string',
      description:
        'Meta description de 120 a 158 caracteres: diz que é live gratuita, a data e a hora, a dor concreta ' +
        'e o porte ou cargo do público.',
    },
    faltando: {
      type: 'array',
      items: { type: 'string' },
      description:
        'O que o documento NÃO respondeu e é necessário pra LP ficar de pé: data, horário, convidado e cargo, ' +
        'parceiro, tema fechado, agenda, link de inscrição. Uma frase curta por item. Lista vazia se não faltar nada.',
    },
  },
};

const SISTEMA = `Você extrai o briefing de uma landing page de evento da Prolog, um SaaS brasileiro de gestão de frotas (pneus, checklist eletrônico e manutenção). O público é gestor de frota com 30 placas ou mais: gerente, coordenador, diretor ou dono.

Regras da casa, todas obrigatórias:

1. SÓ o que está no documento. Não invente data, convidado, parceiro, número ou promessa. Campo sem resposta no documento volta em branco e o motivo entra em "faltando".
2. SLUG — do TEMA, nunca do parceiro nem da data. Parceiro muda e tema fica, e depois da live a mesma página vira a do replay: data no slug envelhece e quebra todo link já compartilhado.
3. TÍTULO DO CARTÃO é interno, pro time achar a LP na fila. Curto e concreto.
4. SEO é anúncio, não resumo: precisa dizer que é gratuita, quando é, a dor concreta, e nomear o porte (30+ placas) ou o cargo — isso autofiltra lead fraco antes do clique.
5. Português do Brasil. Nada de travessão (—) e nada de tom publicitário genérico ("imperdível", "não perca", "revolucionário").
6. "faltando" é o campo mais importante quando o documento está pela metade. Seja específico: "não diz o horário" é útil, "faltam informações" não é.`;

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

function comoSlug(s) {
  return limpar(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// O arquivo vira bloco de conteúdo do jeito que a API entende: PDF e imagem vão
// nativos (a API lê a página inteira, inclusive tabela e print), e o resto entra
// como texto.
function blocoDoArquivo(arquivo) {
  const tipo = String(arquivo.tipo || '').toLowerCase();
  const nome = String(arquivo.nome || 'arquivo');
  const base64 = String(arquivo.base64 || '');

  if (tipo === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
  }
  if (IMAGENS.includes(tipo)) {
    return { type: 'image', source: { type: 'base64', media_type: tipo === 'image/jpg' ? 'image/jpeg' : tipo, data: base64 } };
  }
  if (TEXTOS.includes(tipo) || /\.(md|markdown|txt|csv|json|html?)$/i.test(nome)) {
    const texto = Buffer.from(base64, 'base64').toString('utf8');
    if (!texto.trim()) throw Object.assign(new Error('o arquivo veio vazio'), { status: 422 });
    return { type: 'text', text: `Documento "${nome}":\n\n${texto.slice(0, 120000)}` };
  }

  throw Object.assign(
    new Error(`não sei ler "${nome}": mande PDF, imagem, Markdown ou texto (do Word, exporte em PDF)`),
    { status: 415 }
  );
}

module.exports = async (req, res) => {
  if (!metodo(req, res, ['POST'])) return;
  const usuario = auth.usuarioDe(req);
  if (!usuario) return json(res, 401, { erro: 'sessão expirada' });
  if (!auth.pode(usuario, 'criar')) return json(res, 403, { erro: 'só admin cria LP no hub' });
  if (!configurado()) return json(res, 503, { erro: 'ANTHROPIC_API_KEY não configurada no projeto' });

  const dados = corpo(req);
  const arquivo = dados.arquivo || {};
  if (!arquivo.base64) return json(res, 400, { erro: 'nenhum arquivo veio na requisição' });
  if (Buffer.byteLength(arquivo.base64, 'base64') > TETO_ARQUIVO) {
    return json(res, 413, { erro: 'arquivo acima de 3MB: exporte só as páginas do briefing' });
  }

  try {
    const bloco = blocoDoArquivo(arquivo);
    const resposta = await chamar({
      model: MODELO,
      // Folga proposital: no Opus 5 o thinking vem ligado por padrão e divide o
      // mesmo teto com a resposta. Apertado, o JSON sai cortado.
      max_tokens: 8000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA } },
      system: SISTEMA,
      messages: [
        {
          role: 'user',
          content: [
            bloco,
            {
              type: 'text',
              text:
                'Extraia o briefing da LP a partir do documento acima. ' +
                'Hoje é ' + new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) +
                ' — use isso só pra resolver ano de data escrita sem ano, nunca pra inventar data.',
            },
          ],
        },
      ],
    });

    const texto = (resposta.content || []).find((b) => b.type === 'text');
    if (!texto) {
      return json(res, 502, { erro: `a IA não devolveu texto (stop_reason: ${resposta.stop_reason || '?'})` });
    }

    let b;
    try {
      b = JSON.parse(texto.text);
    } catch {
      return json(res, 502, { erro: 'a IA devolveu algo que não é JSON' });
    }

    // Validação nossa depois da dela: o schema garante campo e tipo, não garante
    // formato de data, de id nem de slug.
    const evento = limpar(b.evento);
    const data = /^\d{2}\/\d{2}\/\d{4}$/.test(limpar(b.data)) ? limpar(b.data) : '';
    const slug = comoSlug(b.slug);
    const id = comoSlug(b.id).slice(0, 49);

    return json(res, 200, {
      campos: {
        id: /^[a-z0-9][a-z0-9-]{1,48}$/.test(id) ? id : '',
        titulo: limpar(b.titulo).slice(0, 90),
        evento: evento.slice(0, 50),
        data,
        versaoLp: limpar(b.versaoLp).slice(0, 24) || 'v1.0',
        nota: limpar(b.nota).slice(0, 240),
        urlFinal: slug ? `${prefixoDaSerie(evento)}/${slug}` : '',
        seoTitulo: limpar(b.seoTitulo).replace(/\s*·\s*Prolog\s*$/i, '').slice(0, 120),
        seoDescricao: limpar(b.seoDescricao).slice(0, 200),
      },
      // Data fora do padrão não some calada: o campo volta vazio e o motivo
      // aparece junto do resto do que falta.
      faltando: []
        .concat(Array.isArray(b.faltando) ? b.faltando.map(limpar).filter(Boolean) : [])
        .concat(!data && limpar(b.data) ? [`a data "${limpar(b.data)}" não está em dd/mm/aaaa`] : [])
        .slice(0, 8),
      modelo: resposta.model || MODELO,
    });
  } catch (err) {
    return json(res, err.status || 500, { erro: String(err.message || err) });
  }
};
