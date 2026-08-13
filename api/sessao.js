// Só pra tela de login saber se já existe sessão e não pedir login de novo.
const { json, metodo } = require('./_lib/http');
const auth = require('./_lib/auth');

module.exports = (req, res) => {
  if (!metodo(req, res, ['GET'])) return;
  const u = auth.usuarioDe(req);
  json(res, 200, u ? { logado: true, nome: u.nome, papel: u.papel } : { logado: false });
};
