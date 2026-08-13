// Único endpoint público: a tela de login precisa saber com o que dá pra entrar.
const { json, metodo } = require('./_lib/http');
const auth = require('./_lib/auth');

module.exports = (req, res) => {
  if (!metodo(req, res, ['GET'])) return;
  json(res, 200, {
    google: auth.googleAtivo(),
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    dominio: auth.dominio(),
    codigos: Object.keys(auth.codigos()).length > 0,
  });
};
