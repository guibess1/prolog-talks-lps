const { json, metodo } = require('./_lib/http');
const auth = require('./_lib/auth');
const estado = require('./_lib/estado');
const site = require('./_lib/site');
const aviso = require('./_lib/aviso');
const { fonteDe } = require('./_lib/lp');
const seo = require('./seo');

const FILA = ['revisao', 'ajuste'];

module.exports = async (req, res) => {
  if (!metodo(req, res, ['GET'])) return;
  const usuario = auth.usuarioDe(req);
  if (!usuario) return json(res, 401, { erro: 'sessão expirada' });

  let e;
  try {
    e = await estado.ler();
  } catch (err) {
    return json(res, 500, { erro: 'não deu pra ler os dados', detalhe: String(err.message || err) });
  }

  const abertos = {};
  const totais = {};
  for (const c of e.comentarios) {
    totais[c.lp] = (totais[c.lp] || 0) + 1;
    if (c.status !== 'resolvido') abertos[c.lp] = (abertos[c.lp] || 0) + 1;
  }

  // Só LP duplicada custa um HEAD aqui, e só enquanto o arquivo próprio dela não
  // subiu num deploy. Na lista de hoje isso é zero request.
  const fontes = {};
  await Promise.all(
    e.lps
      .filter((lp) => lp.htmlDe && lp.htmlDe !== lp.id)
      .map(async (lp) => {
        fontes[lp.id] = await fonteDe(req, lp);
      })
  );

  json(res, 200, {
    usuario: { email: usuario.email, nome: usuario.nome, papel: usuario.papel },
    poderes: {
      comentar: auth.pode(usuario, 'comentar'),
      resolver: auth.pode(usuario, 'resolver'),
      apagar: auth.pode(usuario, 'apagar'),
      status: auth.pode(usuario, 'status'),
      publicar: auth.pode(usuario, 'publicar'),
      criar: auth.pode(usuario, 'criar'),
    },
    site: { repo: site.cfgGit().repo, base: site.cfgGit().base, configurado: site.gitConfigurado() },
    // O sino diz na cara se o aviso sai do hub ou não. Sem isso a pessoa acha
    // que está sendo notificada no Discord quando o webhook nem existe.
    avisoExterno: aviso.configurado(),
    ia: seo.configurado(),
    lps: e.lps.map((lp) => ({
      ...lp,
      // Qual id serve o HTML do preview. Igual ao próprio id, exceto na cópia
      // que ainda espera o deploy do arquivo dela.
      fonteHtml: fontes[lp.id] || lp.id,
      fila: FILA.includes(lp.status),
      comentariosAbertos: abertos[lp.id] || 0,
      comentariosTotal: totais[lp.id] || 0,
    })),
    comentarios: e.comentarios,
    persistencia: estado.configurado(),
  });
};
