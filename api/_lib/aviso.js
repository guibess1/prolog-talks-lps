// Aviso de comentário novo fora do hub.
//
// O sino do hub só resolve quem já está com a página aberta. Pra saber de um
// pedido de ajuste sem ficar olhando o hub, o comentário vira mensagem no
// Discord, que é onde o time já acompanha o site e o creative tool.
//
// Regras que valem pra qualquer coisa aqui:
//  - best effort: webhook fora do ar NUNCA pode derrubar o comentário. Perder o
//    aviso é chato; perder o comentário que a Gabi acabou de escrever é grave
//  - com prazo curto: a função não fica pendurada esperando o Discord
//  - sem dependência: só fetch

const PRAZO = 4000;

function urlWebhook() {
  return process.env.DISCORD_WEBHOOK || '';
}

function configurado() {
  return Boolean(urlWebhook());
}

function base(req) {
  if (process.env.LPHUB_URL) return String(process.env.LPHUB_URL).replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

function cortar(txt, n) {
  const s = String(txt || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Embed em vez de texto solto: o Discord dá título clicável, e a barra colorida
// separa pedido de ajuste (laranja) de sugestão de texto (verde) na lista.
function corpoDoAviso({ comentario, lp, link }) {
  const temSugestao = Boolean(comentario.sugestao);
  const campos = [];

  if (comentario.trecho) {
    campos.push({
      name: 'No trecho',
      value: '> ' + cortar(comentario.trecho, 240),
    });
  }
  if (comentario.texto) {
    campos.push({ name: 'Comentário', value: cortar(comentario.texto, 900) });
  }
  if (temSugestao) {
    campos.push({ name: 'Texto sugerido', value: cortar(comentario.sugestao, 900) });
  }

  return {
    username: 'LP Hub · Prolog Talks',
    embeds: [
      {
        title: `${temSugestao ? 'Sugestão de texto' : 'Pedido de ajuste'} · ${cortar(lp.titulo, 80)}`,
        url: link,
        description: `${comentario.autor.nome} comentou na LP de ${lp.data}.`,
        color: temSugestao ? 0x008554 : 0xf55e00,
        fields: campos,
        footer: { text: 'Abrir o comentário no hub' },
        timestamp: comentario.criadoEm,
      },
    ],
  };
}

// Mudança de status é o evento que fecha o ciclo da revisão: "aprovada" é o sinal
// de que a LP pode ir pro site. Sem aviso, quem aprovou sabe e mais ninguém.
const ROTULOS = {
  revisao: 'volta pra revisão',
  ajuste: 'voltou pra ajuste',
  aprovada: 'APROVADA',
  publicada: 'publicada',
  arquivada: 'arquivada',
};
const CORES = {
  revisao: 0xf5bf0c,
  ajuste: 0xf55e00,
  aprovada: 0x008554,
  publicada: 0x043ad1,
  arquivada: 0x9ea1ab,
};

function corpoDoStatus({ lp, de, para, por, em, link }) {
  const campos = [{ name: 'De → para', value: `${de} → **${para}**` }];
  if (lp.urlFinal) campos.push({ name: 'URL no site', value: `prologapp.com${lp.urlFinal}` });

  return {
    username: 'LP Hub · Prolog Talks',
    embeds: [
      {
        title: `LP ${ROTULOS[para] || para} · ${cortar(lp.titulo, 80)}`,
        url: link,
        description:
          `${por} mudou o status da LP de ${lp.data}.` +
          (para === 'aprovada' ? ' Pronta pra ir pro repo do site.' : ''),
        color: CORES[para] || 0x043ad1,
        fields: campos,
        footer: { text: 'Abrir a LP no hub' },
        timestamp: em,
      },
    ],
  };
}

async function enviar(payload) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const prazo = setTimeout(() => ctrl && ctrl.abort(), PRAZO);
  try {
    const r = await fetch(urlWebhook(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined,
    });
    return { enviado: r.ok, motivo: r.ok ? null : `discord ${r.status}` };
  } catch (e) {
    return { enviado: false, motivo: String(e.message || e) };
  } finally {
    clearTimeout(prazo);
  }
}

async function statusMudou(req, { lp, de, para, por, em }) {
  if (!configurado()) return { enviado: false, motivo: 'DISCORD_WEBHOOK não configurado' };
  const link = `${base(req)}/ver/${encodeURIComponent(lp.id)}`;
  return enviar(corpoDoStatus({ lp, de, para, por, em, link }));
}

async function comentarioNovo(req, { comentario, lp }) {
  if (!configurado()) return { enviado: false, motivo: 'DISCORD_WEBHOOK não configurado' };
  const link = `${base(req)}/ver/${encodeURIComponent(lp.id)}?com=${encodeURIComponent(comentario.id)}`;
  return enviar(corpoDoAviso({ comentario, lp, link }));
}

module.exports = { comentarioNovo, statusMudou, configurado };
