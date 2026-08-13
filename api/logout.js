const { json, metodo } = require('./_lib/http');
const auth = require('./_lib/auth');

module.exports = (req, res) => {
  if (!metodo(req, res, ['POST'])) return;
  auth.sair(res);
  json(res, 200, { ok: true });
};
