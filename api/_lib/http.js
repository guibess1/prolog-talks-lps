function corpo(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function json(res, status, dados) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(dados));
}

function metodo(req, res, permitidos) {
  if (permitidos.includes(req.method)) return true;
  res.setHeader('Allow', permitidos.join(', '));
  json(res, 405, { erro: 'método não permitido' });
  return false;
}

module.exports = { corpo, json, metodo };
