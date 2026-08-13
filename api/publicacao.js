// GET /api/publicacao?id=<lp> — em que pé está o envio desta LP.
//
// O botão "Enviar e abrir PR" fazia sua parte e terminava numa caixa verde com
// três instruções manuais: mergear em dev, abrir o PR de release, marcar como
// publicada. Quem enviava ficava sem saber, a partir dali, o que já andou e o
// que falta — a resposta estava espalhada entre duas abas do GitHub e um teste
// na URL do site. Este endpoint junta as três fontes numa leitura só.
//
// Só leitura: não mergeia, não abre PR, não publica. O gate de release continua
// sendo a esteira `validate` no PR dev → main.
//
// As quatro etapas, na ordem em que acontecem:
//   1. gerada   página convertida e commitada na branch da LP
//   2. pr       PR da branch → dev, até ser mergeado
//   3. release  PR dev → main (onde roda a validate), até ser mergeado
//   4. ar       a URL pública responde 200
//
// Estados: feito · fazendo (é aqui que está agora) · espera · erro.

const { json, metodo } = require('./_lib/http');
const auth = require('./_lib/auth');
const estado = require('./_lib/estado');
const site = require('./_lib/site');

const SITE = process.env.SITE_URL || 'https://prologapp.com';

function parametro(req, chave) {
  try {
    return new URL(req.url, 'http://hub.local').searchParams.get(chave);
  } catch {
    return null;
  }
}

function etapa(chave, titulo, estadoEtapa, extra) {
  return Object.assign({ chave, titulo, estado: estadoEtapa }, extra || {});
}

module.exports = async (req, res) => {
  if (!metodo(req, res, ['GET'])) return;
  const usuario = auth.usuarioDe(req);
  if (!usuario) return json(res, 401, { erro: 'sessão expirada' });

  const id = parametro(req, 'id');
  if (!id) return json(res, 400, { erro: 'informe o id da LP' });

  let e;
  try {
    e = await estado.ler();
  } catch (err) {
    return json(res, 500, { erro: 'não deu pra ler os dados', detalhe: String(err.message || err) });
  }

  const lp = e.lps.find((l) => l.id === id);
  if (!lp) return json(res, 404, { erro: 'LP não encontrada' });

  const envios = lp.envios || [];
  const envio = envios[envios.length - 1];
  if (!envio) return json(res, 200, { semEnvio: true, lp: lp.id });

  const cfg = site.cfgGit();
  const rota = envio.rota || (lp.urlFinal ? lp.urlFinal + '/' : '');
  const url = rota ? SITE.replace(/\/$/, '') + rota : null;
  const caminhoPagina = lp.urlFinal ? `src/pages${lp.urlFinal}.astro` : null;

  if (!site.gitConfigurado()) {
    return json(res, 200, {
      lp: lp.id,
      envio,
      url,
      repo: cfg.repo,
      semGit: true,
      etapas: [etapa('gerada', 'Página gerada e commitada', 'feito')],
    });
  }

  // As três leituras não dependem uma da outra: em paralelo o painel abre em
  // ~1s em vez de somar três idas ao GitHub.
  const [pr, release, arResp] = await Promise.all([
    site.prPorNumero(envio.pr),
    site.prDeRelease(),
    url ? site.noAr(url) : Promise.resolve(null),
  ]);

  const emDev = pr && pr.estado === 'mergeado';
  // Sem PR de release aberto, o que diz se a página chegou na main é o arquivo
  // estar lá. Só perguntamos quando já passou pela dev: antes disso a resposta
  // seria sempre não.
  const emMain = !release && emDev && caminhoPagina ? await site.existeNaBranch(caminhoPagina, 'main') : false;
  const checks = release ? await site.checagens(release.sha) : null;
  const estaNoAr = Boolean(arResp && arResp.ok);

  const etapas = [];

  etapas.push(
    etapa('gerada', 'Página gerada e commitada', 'feito', {
      detalhe: envio.semMudanca
        ? `A branch ${envio.branch} já estava com esta versão da LP.`
        : `${caminhoPagina || 'src/pages/…'} na branch ${envio.branch}.`,
      quando: envio.em,
      por: envio.por,
    })
  );

  if (!pr) {
    etapas.push(
      etapa('pr', `PR #${envio.pr} → ${envio.base}`, 'erro', {
        detalhe: 'não deu pra ler o PR no GitHub agora. O link continua valendo.',
        link: envio.url,
      })
    );
  } else if (pr.estado === 'mergeado') {
    etapas.push(
      etapa('pr', `PR #${pr.numero} mergeado em ${pr.base}`, 'feito', {
        detalhe: 'A página já está na branch de desenvolvimento.',
        quando: pr.mergeadoEm,
        link: pr.url,
      })
    );
  } else if (pr.estado === 'fechado') {
    etapas.push(
      etapa('pr', `PR #${pr.numero} fechado sem merge`, 'erro', {
        detalhe: 'Alguém fechou o PR sem mergear. Reabra no GitHub ou envie a LP de novo.',
        link: pr.url,
      })
    );
  } else {
    etapas.push(
      etapa('pr', `PR #${pr.numero} aberto em ${pr.base}`, 'fazendo', {
        detalhe: 'Esperando revisão e merge.',
        acao: `Abrir o PR no GitHub e mergear em ${pr.base}`,
        link: pr.url,
      })
    );
  }

  if (!emDev) {
    etapas.push(
      etapa('release', `Release ${cfg.base} → main`, 'espera', {
        detalhe: `Só depois que o PR entrar em ${cfg.base}. É neste PR que roda a esteira validate.`,
      })
    );
  } else if (release) {
    const est = checks && checks.resumo;
    const validate = (checks && checks.itens.find((i) => /validate/i.test(i.nome))) || null;
    etapas.push(
      etapa('release', `Release ${cfg.base} → main · PR #${release.numero}`, est === 'falhou' ? 'erro' : 'fazendo', {
        detalhe:
          est === 'ok'
            ? 'Esteira verde. Pode mergear em main — o merge publica.'
            : est === 'rodando'
              ? 'Esteira rodando. Quando ficar verde, o merge em main publica.'
              : est === 'falhou'
                ? `Esteira vermelha${validate ? ' na validate' : ''}: o merge em main está bloqueado até corrigir.`
                : 'PR de release aberto. A esteira ainda não reportou.',
        acao: est === 'ok' ? 'Mergear o PR de release em main' : 'Acompanhar a esteira no PR de release',
        link: release.url,
        checks: checks ? checks.itens.slice(0, 8) : [],
      })
    );
  } else if (emMain) {
    etapas.push(
      etapa('release', `Release ${cfg.base} → main`, 'feito', {
        detalhe: 'A página já está na main.',
      })
    );
  } else {
    etapas.push(
      etapa('release', `Release ${cfg.base} → main`, 'fazendo', {
        detalhe: `A página está em ${cfg.base} e ainda não foi pra main. Abra o PR de release: é nele que roda a validate.`,
        acao: `Abrir o PR ${cfg.base} → main no GitHub`,
        link: `https://github.com/${cfg.repo}/compare/main...${cfg.base}?expand=1`,
      })
    );
  }

  etapas.push(
    etapa('ar', url ? `No ar em ${url.replace(/^https?:\/\//, '')}` : 'No ar', estaNoAr ? 'feito' : emMain ? 'fazendo' : 'espera', {
      detalhe: estaNoAr
        ? 'A página responde 200. Pode divulgar o link.'
        : emMain
          ? 'Merge em main feito, deploy ainda rodando. Costuma levar poucos minutos.'
          : arResp && arResp.status
            ? `A URL ainda responde ${arResp.status}. Só vai pro ar depois do merge em main.`
            : 'Ainda não publicada.',
      link: url,
    })
  );

  const atual = (etapas.find((x) => x.estado === 'erro') || etapas.find((x) => x.estado === 'fazendo') || etapas[etapas.length - 1]).chave;

  return json(res, 200, {
    lp: lp.id,
    envio,
    url,
    repo: cfg.repo,
    noAr: estaNoAr,
    atual,
    etapas,
    // Enquanto não está no ar, a tela repergunta sozinha. Depois, para.
    repetir: !estaNoAr,
  });
};
