// Persistência do hub.
//
// O projeto não tem banco: o token da Vercel que temos é de escopo de projeto,
// sem permissão pra criar Blob nem Edge Config. A saída foi usar uma variável de
// ambiente PLAIN do próprio projeto (LPHUB_STATE) como key-value, lida e escrita
// em runtime pela API da Vercel. Variável do tipo "plain" volta em texto puro na
// listagem; a "encrypted" não volta, por isso o tipo importa.
//
// Limite prático: 64KB no total de env vars do projeto. O podar() abaixo segura
// isso descartando comentário resolvido antigo. Se o hub crescer, migrar pra
// Vercel Blob (3 cliques no dashboard) e trocar só este arquivo.

const API = 'https://api.vercel.com';
const CHAVE = 'LPHUB_STATE';
const TETO = 48000; // caracteres do JSON antes de podar

function cfg() {
  return {
    token: process.env.KV_API_TOKEN,
    projeto: process.env.KV_PROJECT_ID,
    time: process.env.KV_TEAM_ID,
  };
}

function configurado() {
  const c = cfg();
  return Boolean(c.token && c.projeto);
}

function qs(time) {
  return time ? `?teamId=${encodeURIComponent(time)}` : '';
}

async function acharVar() {
  const c = cfg();
  const r = await fetch(`${API}/v9/projects/${c.projeto}/env${qs(c.time)}${c.time ? '&' : '?'}limit=100`, {
    headers: { Authorization: `Bearer ${c.token}` },
  });
  if (!r.ok) throw new Error(`env list ${r.status}`);
  const d = await r.json();
  return (d.envs || []).find((e) => e.key === CHAVE) || null;
}

function inicial() {
  return {
    versao: 1,
    lps: [
      {
        id: 'kilsa',
        titulo: 'Kilsa — Adesão de Motoristas',
        evento: 'Prolog Talks',
        data: '08/09/2026',
        versaoLp: 'v2.3',
        nota: 'Live adiada pra 08/09 e condução trocada: sai o Yan (TNS Summit), entra o Jonatan.',
        status: 'revisao',
        sync: '06/08, 21:27',
        urlFinal: '/talks/adesao-de-motoristas',
        // Vão pro <head> da página no site comercial quando a LP é enviada pro
        // repo. Em branco, o gerador cai no <title> e na subheadline da própria
        // LP — nunca inventa texto.
        seoTitulo: 'Prolog Talks · Adesão de motoristas aos procedimentos',
        seoDescricao:
          'Live gratuita em 08/09, 19h: como fazer o time de motoristas cumprir a rotina sem você ter que cobrar todo dia. Pra quem gerencia 30 placas ou mais.',
        historico: [],
        envios: [],
      },
      {
        id: 'kilsa-v1',
        titulo: 'Kilsa — versão anterior',
        evento: 'Prolog Talks',
        data: '18/08/2026',
        versaoLp: 'v1',
        nota: 'Mantida só para comparação lado a lado com a v2.1.',
        status: 'arquivada',
        sync: '05/08, 16:38',
        urlFinal: '',
        historico: [],
      },
      {
        id: 'rumo',
        titulo: 'Rumo Brasil — CIOT na carga fracionada',
        evento: 'Prolog Talks',
        data: '10/06/2026',
        versaoLp: 'final',
        nota: 'Já publicada no site. Serve de referência de formato.',
        status: 'publicada',
        sync: '01/06, 20:26',
        urlFinal: '/talks/ciot-carga-fracionada',
        historico: [],
      },
    ],
    comentarios: [],
  };
}

function normalizar(e) {
  const base = inicial();
  if (!e || typeof e !== 'object') return base;
  return {
    versao: e.versao || 1,
    lps: Array.isArray(e.lps) && e.lps.length ? e.lps : base.lps,
    comentarios: Array.isArray(e.comentarios) ? e.comentarios : [],
  };
}

// Descarta comentário resolvido mais antigo até o JSON caber no teto.
// Comentário aberto nunca é descartado: é justamente o que está pendente.
function podar(e) {
  let json = JSON.stringify(e);
  if (json.length <= TETO) return e;
  const resolvidos = e.comentarios
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.status === 'resolvido')
    .sort((a, b) => String(a.c.criadoEm).localeCompare(String(b.c.criadoEm)));
  for (const alvo of resolvidos) {
    e.comentarios = e.comentarios.filter((c) => c.id !== alvo.c.id);
    json = JSON.stringify(e);
    if (json.length <= TETO) break;
  }
  return e;
}

async function ler() {
  if (!configurado()) return inicial();
  const v = await acharVar();
  if (!v || v.type !== 'plain' || !v.value) return inicial();
  try {
    return normalizar(JSON.parse(v.value));
  } catch {
    return inicial();
  }
}

async function gravar(estado) {
  if (!configurado()) throw new Error('store não configurado');
  const c = cfg();
  const valor = JSON.stringify(podar(estado));
  const v = await acharVar();
  if (v) {
    const r = await fetch(`${API}/v9/projects/${c.projeto}/env/${v.id}${qs(c.time)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: valor, type: 'plain', target: ['production', 'preview', 'development'] }),
    });
    if (!r.ok) throw new Error(`env patch ${r.status} ${await r.text()}`);
    return;
  }
  const r = await fetch(`${API}/v10/projects/${c.projeto}/env${qs(c.time)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: CHAVE,
      value: valor,
      type: 'plain',
      target: ['production', 'preview', 'development'],
    }),
  });
  if (!r.ok) throw new Error(`env post ${r.status} ${await r.text()}`);
}

// Lê, aplica a mutação e grava. Sem transação de verdade: relê logo antes de
// escrever pra reduzir a janela de perda quando duas pessoas comentam junto.
async function mutar(fn) {
  const atual = await ler();
  const resultado = fn(atual);
  await gravar(atual);
  return resultado;
}

module.exports = { ler, gravar, mutar, configurado, inicial };
