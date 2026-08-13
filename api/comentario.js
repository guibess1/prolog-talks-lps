const { corpo, json, metodo } = require('./_lib/http');
const auth = require('./_lib/auth');
const estado = require('./_lib/estado');
const aviso = require('./_lib/aviso');

const LIMITE_TEXTO = 1200;
const LIMITE_TRECHO = 400;

function id() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

module.exports = async (req, res) => {
  if (!metodo(req, res, ['POST', 'PATCH', 'DELETE'])) return;
  const usuario = auth.usuarioDe(req);
  if (!usuario) return json(res, 401, { erro: 'sessão expirada' });
  if (!estado.configurado()) return json(res, 503, { erro: 'persistência não configurada' });

  const dados = corpo(req);

  try {
    if (req.method === 'POST') {
      if (!auth.pode(usuario, 'comentar')) return json(res, 403, { erro: 'seu perfil é só de leitura' });
      const texto = String(dados.texto || '').trim();
      const sugestao = String(dados.sugestao || '').trim();
      // Sugestão de texto vale como comentário sozinha: o trecho novo já diz tudo.
      if (!texto && !sugestao) return json(res, 400, { erro: 'escreva o comentário ou sugira um texto' });
      if (texto.length > LIMITE_TEXTO) return json(res, 400, { erro: `máximo de ${LIMITE_TEXTO} caracteres` });
      if (sugestao.length > LIMITE_TEXTO) return json(res, 400, { erro: `sugestão passou de ${LIMITE_TEXTO} caracteres` });
      const trecho = String(dados.trecho || '').trim().slice(0, LIMITE_TRECHO);
      if (sugestao && !trecho) return json(res, 400, { erro: 'selecione na LP o trecho que a sugestão substitui' });

      let lpDoComentario = null;
      const novo = await estado.mutar((e) => {
        const lp = e.lps.find((l) => l.id === dados.lp);
        lpDoComentario = lp;
        if (!lp) throw Object.assign(new Error('LP não encontrada'), { status: 404 });
        const c = {
          id: id(),
          lp: lp.id,
          texto,
          // Âncora do trecho na LP: o texto selecionado mais qual ocorrência dele
          // é, pra reencontrar a posição mesmo quando a frase se repete na página.
          trecho: trecho || null,
          ocorrencia: trecho ? Math.max(0, parseInt(dados.ocorrencia, 10) || 0) : null,
          sugestao: sugestao || null,
          autor: { nome: usuario.nome, email: usuario.email },
          criadoEm: new Date().toISOString(),
          status: 'aberto',
        };
        e.comentarios.push(c);
        // Comentário novo em LP que estava só "em revisão" significa ajuste pedido.
        if (lp.status === 'revisao') {
          lp.status = 'ajuste';
          lp.historico = lp.historico || [];
          lp.historico.push({
            de: 'revisao',
            para: 'ajuste',
            por: usuario.nome,
            em: c.criadoEm,
            motivo: 'comentário aberto',
          });
        }
        return c;
      });

      // Depois de gravar, e sem deixar a resposta depender disso: se o Discord
      // estiver fora, o comentário já está salvo e o pior caso é ninguém ser
      // avisado. O contrário seria perder o comentário por causa do aviso.
      const entregue = await aviso
        .comentarioNovo(req, { comentario: novo, lp: lpDoComentario })
        .catch((e) => ({ enviado: false, motivo: String(e.message || e) }));

      return json(res, 201, { comentario: novo, aviso: entregue });
    }

    if (req.method === 'PATCH') {
      if (!auth.pode(usuario, 'resolver')) return json(res, 403, { erro: 'sem permissão' });
      const acao = dados.acao === 'reabrir' ? 'aberto' : 'resolvido';
      const alvo = await estado.mutar((e) => {
        const c = e.comentarios.find((x) => x.id === dados.id);
        if (!c) throw Object.assign(new Error('comentário não encontrado'), { status: 404 });
        c.status = acao;
        c.resolvidoPor = acao === 'resolvido' ? { nome: usuario.nome, email: usuario.email } : null;
        c.resolvidoEm = acao === 'resolvido' ? new Date().toISOString() : null;
        return c;
      });
      return json(res, 200, { comentario: alvo });
    }

    // DELETE — cada um apaga o próprio comentário; admin apaga qualquer um.
    // Ninguém apaga crítica alheia: pra isso existe o "resolver".
    const alvoId = dados.id || req.query.id;
    await estado.mutar((e) => {
      const c = e.comentarios.find((x) => x.id === alvoId);
      if (!c) throw Object.assign(new Error('comentário não encontrado'), { status: 404 });
      const dono = c.autor && c.autor.email === usuario.email;
      if (!dono && !auth.pode(usuario, 'apagar')) {
        throw Object.assign(new Error('você só apaga os seus comentários'), { status: 403 });
      }
      e.comentarios = e.comentarios.filter((x) => x.id !== alvoId);
    });
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, err.status || 500, { erro: String(err.message || err) });
  }
};
