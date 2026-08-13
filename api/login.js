const { corpo, json, metodo } = require('./_lib/http');
const auth = require('./_lib/auth');

module.exports = async (req, res) => {
  if (!metodo(req, res, ['POST'])) return;
  if (!process.env.SESSION_SECRET) return json(res, 500, { erro: 'SESSION_SECRET não configurado' });

  const dados = corpo(req);

  // Caminho 1 — Google. É o oficial: a conta é a do Google Workspace da Prolog,
  // então entrar e sair do hub é entrar e sair do e-mail corporativo.
  if (dados.credential) {
    let perfil;
    try {
      perfil = await auth.verificarGoogle(dados.credential);
    } catch (e) {
      return json(res, 401, { erro: 'não deu pra validar sua conta Google', detalhe: String(e.message || e) });
    }
    const papel = auth.papelDe(perfil.email);
    if (!papel) {
      return json(res, 403, {
        erro: `essa conta não tem acesso. Entre com o e-mail @${auth.dominio()}.`,
      });
    }
    const u = auth.entrar(res, { email: perfil.email, nome: perfil.nome, papel, via: 'google' });
    return json(res, 200, { usuario: { email: u.email, nome: u.nome, papel: u.papel } });
  }

  // Caminho 2 — código de acesso. Ponte enquanto o Client ID do Google não sai;
  // some da tela assim que LPHUB_CODIGOS ficar vazio.
  if (dados.codigo) {
    const tabela = auth.codigos();
    const chave = Object.keys(tabela).find(
      (k) => k.trim().toUpperCase() === String(dados.codigo).trim().toUpperCase()
    );
    if (!chave) return json(res, 401, { erro: 'código inválido' });
    const p = tabela[chave];
    const u = auth.entrar(res, {
      email: p.email,
      nome: p.nome,
      papel: p.papel || 'revisor',
      via: 'codigo',
    });
    return json(res, 200, { usuario: { email: u.email, nome: u.nome, papel: u.papel } });
  }

  return json(res, 400, { erro: 'informe uma conta Google ou um código' });
};
