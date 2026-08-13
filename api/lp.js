// Escrita na LP — três métodos na mesma rota:
//
//   PATCH   muda status, URL, SEO e os campos do cartão (título, data, nota…)
//   POST    duplica uma LP existente
//   DELETE  remove a LP e os comentários dela
//
// Um arquivo só porque na Vercel a rota é o nome do arquivo: separar em
// `criar.js` e `excluir.js` daria três rotas pra falar da mesma entidade.

const { corpo, json, metodo } = require('./_lib/http');
const auth = require('./_lib/auth');
const estado = require('./_lib/estado');
const aviso = require('./_lib/aviso');

const STATUS = ['revisao', 'ajuste', 'aprovada', 'publicada', 'arquivada'];

// O id é o caminho público da LP (`/kilsa`) e a pasta do arquivo
// (`public/kilsa/index.html`). Por isso o formato é fechado, e o que já é rota
// do hub fica de fora: um id "ver" ou "api" viraria sombra de uma tela que
// existe.
const ID_OK = /^[a-z0-9][a-z0-9-]{1,48}$/;
const RESERVADOS = [
  'api', 'ver', 'login', 'index', 'index.html', 'app.js', 'ds.css', 'ancora.js',
  'favicon.svg', 'robots.txt', 'logo-white.svg', 'logo-lightmode.svg',
];

const CAMPOS = {
  titulo: { rotulo: 'título', teto: 90, exige: true },
  evento: { rotulo: 'evento', teto: 50, exige: true },
  data: { rotulo: 'data', teto: 10, exige: true },
  versaoLp: { rotulo: 'versão', teto: 24, exige: false },
  nota: { rotulo: 'nota', teto: 240, exige: false },
};

function erro(msg, status) {
  return Object.assign(new Error(msg), { status: status || 400 });
}

function limpo(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function parametro(req, chave) {
  try {
    return new URL(req.url, 'http://hub.local').searchParams.get(chave);
  } catch {
    return null;
  }
}

// Campos do cartão. Devolve só o que veio no corpo: o PATCH é parcial de
// propósito — se exigisse o objeto inteiro, um campo esquecido pelo formulário
// apagaria dado bom.
function camposDoCartao(d, exigirTodos) {
  const saida = {};
  for (const campo of Object.keys(CAMPOS)) {
    const regra = CAMPOS[campo];
    if (typeof d[campo] !== 'string') {
      if (exigirTodos && regra.exige) throw erro(`${regra.rotulo} é obrigatório`);
      continue;
    }
    const v = limpo(d[campo]);
    if (!v && regra.exige) throw erro(`${regra.rotulo} não pode ficar em branco`);
    if (v.length > regra.teto) throw erro(`${regra.rotulo}: máximo de ${regra.teto} caracteres`);
    if (campo === 'data' && !/^\d{2}\/\d{2}\/\d{4}$/.test(v)) throw erro('data no formato dd/mm/aaaa');
    saida[campo] = v;
  }
  return saida;
}

// Padrão da URL pública: /serie/slug, tudo minúsculo, sem acento e sem data.
function urlNoPadrao(bruto) {
  let u = limpo(bruto).toLowerCase();
  if (!u) return '';
  if (!u.startsWith('/')) u = '/' + u;
  if (!/^\/[a-z0-9-]+\/[a-z0-9-]+$/.test(u)) {
    throw erro('URL fora do padrão: use /serie/slug, só minúscula, número e hífen');
  }
  return u;
}

function seoDoCorpo(d) {
  const saida = {};
  if (typeof d.seoTitulo === 'string') {
    saida.seoTitulo = limpo(d.seoTitulo);
    if (saida.seoTitulo.length > 120) throw erro('título de SEO: máximo de 120 caracteres');
  }
  if (typeof d.seoDescricao === 'string') {
    saida.seoDescricao = limpo(d.seoDescricao);
    if (saida.seoDescricao.length > 200) throw erro('descrição de SEO: máximo de 200 caracteres');
  }
  return saida;
}

/* ========================================================================== *
 *  PATCH — status, URL, SEO e campos do cartão
 * ========================================================================== */

async function editar(req, res, usuario) {
  if (!auth.pode(usuario, 'status')) return json(res, 403, { erro: 'seu perfil é só de leitura' });

  const dados = corpo(req);
  const cartao = camposDoCartao(dados, false);
  const seo = seoDoCorpo(dados);
  const mudaUrl = typeof dados.urlFinal === 'string';
  const mudaStatus = STATUS.includes(dados.status);

  if (!mudaUrl && !mudaStatus && !Object.keys(seo).length && !Object.keys(cartao).length) {
    return json(res, 400, { erro: 'nada pra mudar nesta chamada' });
  }

  const urlFinal = mudaUrl ? urlNoPadrao(dados.urlFinal) : null;

  // Guardado fora do mutar pra saber, depois de gravar, se houve troca de
  // status de verdade — e só então avisar. Salvar a URL não é notícia.
  let mudanca = null;
  const lp = await estado.mutar((e) => {
    const alvo = e.lps.find((l) => l.id === dados.id);
    if (!alvo) throw erro('LP não encontrada', 404);
    if (urlFinal !== null) alvo.urlFinal = urlFinal;
    Object.assign(alvo, seo, cartao);
    if (!mudaStatus || alvo.status === dados.status) return alvo;
    alvo.historico = alvo.historico || [];
    const registro = {
      de: alvo.status,
      para: dados.status,
      por: usuario.nome,
      // O e-mail entra a partir de 11/08: o sino usa ele pra não notificar a
      // pessoa da própria ação. Registro antigo só tem nome, e o sino cai
      // na comparação por nome nesse caso.
      porEmail: usuario.email,
      em: new Date().toISOString(),
    };
    alvo.historico.push(registro);
    alvo.status = dados.status;
    mudanca = registro;
    return alvo;
  });

  // Mesma regra do comentário: best effort, depois de gravar. Webhook fora do
  // ar não pode fazer uma aprovação parecer que falhou.
  let entregue = null;
  if (mudanca) {
    entregue = await aviso
      .statusMudou(req, { lp, de: mudanca.de, para: mudanca.para, por: mudanca.por, em: mudanca.em })
      .catch((e) => ({ enviado: false, motivo: String(e.message || e) }));
  }

  return json(res, 200, { lp, aviso: entregue });
}

/* ========================================================================== *
 *  POST — duplicar
 * ========================================================================== */

// Duplicar copia o CARTÃO, não o arquivo: `public/<id>/index.html` entra num
// deploy e não dá pra criar em runtime. Até o arquivo próprio subir, a cópia
// aponta o preview pro HTML da origem (`htmlDe`) — o `api/dados` confere a cada
// carregamento se o arquivo próprio já existe e promove sozinho.
//
// Comentário não vem junto: eles são a discussão da OUTRA LP, e reabrir
// pendência resolvida numa página que ainda nem foi escrita é ruído.
async function duplicar(req, res, usuario) {
  if (!auth.pode(usuario, 'criar')) return json(res, 403, { erro: 'só admin cria LP no hub' });

  const dados = corpo(req);
  const novoId = limpo(dados.id).toLowerCase();
  if (!ID_OK.test(novoId)) {
    return json(res, 400, { erro: 'id inválido: 2 a 49 caracteres, só minúscula, número e hífen' });
  }
  if (RESERVADOS.includes(novoId)) {
    return json(res, 400, { erro: `"${novoId}" já é rota do hub: escolha outro id` });
  }

  const cartao = camposDoCartao(dados, true);
  // URL e SEO podem já vir preenchidos (do briefing lido por IA, ou digitados na
  // tela de duplicar). O que vem explícito ganha do "copiar SEO da origem".
  const urlFinal = typeof dados.urlFinal === 'string' ? urlNoPadrao(dados.urlFinal) : '';
  const seo = seoDoCorpo(dados);
  const agora = new Date().toISOString();

  const nova = await estado.mutar((e) => {
    const de = e.lps.find((l) => l.id === dados.de);
    if (!de) throw erro('LP de origem não encontrada', 404);
    if (e.lps.some((l) => l.id === novoId)) throw erro(`já existe uma LP com o id "${novoId}"`, 409);
    // Duas páginas não podem ocupar a mesma rota no site: a segunda
    // sobrescreveria o arquivo da primeira no PR.
    const dona = urlFinal && e.lps.find((l) => l.urlFinal === urlFinal);
    if (dona) throw erro(`a URL ${urlFinal} já é da LP "${dona.titulo}"`, 409);

    const copia = {
      id: novoId,
      titulo: cartao.titulo,
      evento: cartao.evento,
      data: cartao.data,
      versaoLp: cartao.versaoLp || '',
      nota: cartao.nota || '',
      status: 'revisao',
      // A URL da origem nunca é herdada — só vale a que vier preenchida agora.
      urlFinal: urlFinal,
      seoTitulo: seo.seoTitulo || (dados.copiarSeo ? de.seoTitulo || '' : ''),
      seoDescricao: seo.seoDescricao || (dados.copiarSeo ? de.seoDescricao || '' : ''),
      // Cópia de cópia continua apontando pro arquivo que existe de verdade.
      htmlDe: de.htmlDe || de.id,
      origem: de.id,
      criadoEm: agora,
      criadoPor: usuario.nome,
      historico: [
        {
          de: '',
          para: 'revisao',
          por: usuario.nome,
          porEmail: usuario.email,
          em: agora,
          motivo: 'duplicada de ' + de.titulo,
        },
      ],
      envios: [],
    };

    // Entra logo abaixo da origem: a lista é lida de cima pra baixo e as duas
    // versões da mesma coisa ficam lado a lado.
    e.lps.splice(e.lps.indexOf(de) + 1, 0, copia);
    return copia;
  });

  // Sem webhook aqui de propósito: duplicar é preparo, não é fato do fluxo de
  // revisão. O sino do hub mostra pelo histórico ("criou a LP"), que já basta.
  return json(res, 201, { lp: nova });
}

/* ========================================================================== *
 *  DELETE — excluir
 * ========================================================================== */

// Apaga o cartão e os comentários. O ARQUIVO em public/<id>/ continua no deploy
// — por isso uma cópia que dependa dele via `htmlDe` não quebra quando a origem
// sai do hub.
async function excluir(req, res, usuario) {
  if (!auth.pode(usuario, 'apagar')) return json(res, 403, { erro: 'só admin exclui LP do hub' });

  // Corpo em DELETE é aceito, mas nem todo runtime o entrega parseado. A query
  // é o plano B pra a exclusão não depender disso.
  const dados = corpo(req);
  const id = dados.id || parametro(req, 'id');
  const forcar = Boolean(dados.forcar) || parametro(req, 'forcar') === '1';

  const saida = await estado.mutar((e) => {
    const alvo = e.lps.find((l) => l.id === id);
    if (!alvo) throw erro('LP não encontrada', 404);
    // LP que já virou PR no repo do site tem rastro fora daqui: excluir apaga o
    // histórico de quem mandou e quando. Arquivar guarda isso.
    if ((alvo.envios || []).length && !forcar) {
      throw Object.assign(
        erro(`esta LP já foi enviada pro site (PR #${alvo.envios[alvo.envios.length - 1].pr}): arquive em vez de excluir`, 409),
        { precisaForcar: true }
      );
    }
    const comentarios = e.comentarios.filter((c) => c.lp === alvo.id).length;
    e.lps = e.lps.filter((l) => l.id !== alvo.id);
    e.comentarios = e.comentarios.filter((c) => c.lp !== alvo.id);
    return { id: alvo.id, titulo: alvo.titulo, comentarios };
  });

  return json(res, 200, saida);
}

/* ========================================================================== */

module.exports = async (req, res) => {
  if (!metodo(req, res, ['PATCH', 'POST', 'DELETE'])) return;
  const usuario = auth.usuarioDe(req);
  if (!usuario) return json(res, 401, { erro: 'sessão expirada' });
  if (!estado.configurado()) return json(res, 503, { erro: 'persistência não configurada' });

  try {
    if (req.method === 'POST') return await duplicar(req, res, usuario);
    if (req.method === 'DELETE') return await excluir(req, res, usuario);
    return await editar(req, res, usuario);
  } catch (err) {
    return json(res, err.status || 500, {
      erro: String(err.message || err),
      ...(err.precisaForcar ? { precisaForcar: true } : {}),
    });
  }
};
