// Sessão em cookie assinado (HMAC-SHA256). Sem banco de usuário: o papel sai da
// configuração em env var, então dar ou tirar acesso é editar uma variável.

const crypto = require('crypto');

const COOKIE = 'lphub';
const DIAS = 30;

function segredo() {
  return process.env.SESSION_SECRET || '';
}

function dominio() {
  return (process.env.LPHUB_DOMINIO || 'prologapp.com').toLowerCase();
}

// LPHUB_PAPEIS: {"email@prologapp.com":"admin"} — quem não estiver aqui e for do
// domínio entra como revisor.
function papeis() {
  try {
    const p = JSON.parse(process.env.LPHUB_PAPEIS || '{}');
    const saida = {};
    for (const k of Object.keys(p)) saida[k.toLowerCase()] = p[k];
    return saida;
  } catch {
    return {};
  }
}

// LPHUB_CODIGOS: {"CODIGO":{"nome":"...","email":"...","papel":"revisor"}}
// Ponte enquanto o Client ID do Google não existe. Some quando o Google entrar.
function codigos() {
  try {
    return JSON.parse(process.env.LPHUB_CODIGOS || '{}');
  } catch {
    return {};
  }
}

function papelDe(email) {
  const e = String(email || '').toLowerCase();
  const mapa = papeis();
  if (mapa[e]) return mapa[e];
  if (e.endsWith('@' + dominio())) return 'revisor';
  return null;
}

// "publicar" abre PR no repo do site comercial — sai do hub e entra em código de
// produção de outro time. Fica só no admin de propósito: revisor aprova a LP,
// admin manda pro repo. Quem mergeia continua sendo o CTO, no GitHub.
//
// "criar" (duplicar LP) também é só de admin, e pelo mesmo motivo do "apagar":
// qualquer e-mail do domínio vira revisor sozinho, então o que mexe na LISTA de
// LPs — e não no conteúdo da revisão — fica com quem toca o processo.
const PODERES = {
  admin: ['ver', 'comentar', 'resolver', 'apagar', 'status', 'publicar', 'criar'],
  revisor: ['ver', 'comentar', 'resolver', 'status'],
  leitor: ['ver'],
};

function pode(usuario, poder) {
  if (!usuario) return false;
  return (PODERES[usuario.papel] || []).includes(poder);
}

function assinar(dados) {
  const corpo = Buffer.from(JSON.stringify(dados)).toString('base64url');
  const mac = crypto.createHmac('sha256', segredo()).update(corpo).digest('base64url');
  return `${corpo}.${mac}`;
}

function abrir(token) {
  if (!token || !segredo()) return null;
  const [corpo, mac] = String(token).split('.');
  if (!corpo || !mac) return null;
  const esperado = crypto.createHmac('sha256', segredo()).update(corpo).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    if (!dados.exp || dados.exp < Date.now()) return null;
    return dados;
  } catch {
    return null;
  }
}

function lerCookies(req) {
  const bruto = req.headers.cookie || '';
  const saida = {};
  for (const parte of bruto.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    saida[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return saida;
}

// O papel vai assinado no cookie, que dura 30 dias. Se ele fosse a palavra final,
// promover ou rebaixar alguém só valeria depois que a pessoa deslogasse — foi o
// que aconteceu em 11/08, quando a Gabi virou admin e continuou vendo a tela de
// revisor. Aqui o papel é RE-RESOLVIDO da configuração a cada requisição: mudar a
// env passa a valer no próximo clique.
//
// Quando `papelDe` não sabe responder (login por código de acesso, com e-mail fora
// do domínio), o papel do cookie continua valendo — senão a ponte de acesso morria.
function usuarioDe(req) {
  const dados = abrir(lerCookies(req)[COOKIE]);
  if (!dados) return null;
  const atual = papelDe(dados.email);
  return atual ? { ...dados, papel: atual } : dados;
}

function entrar(res, { email, nome, papel, via }) {
  const dados = {
    email: String(email).toLowerCase(),
    nome: nome || email,
    papel,
    via,
    exp: Date.now() + DIAS * 24 * 60 * 60 * 1000,
  };
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(assinar(dados))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DIAS * 24 * 60 * 60}`
  );
  return dados;
}

function sair(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

// Valida o ID token do Google no servidor. Usa o endpoint tokeninfo pra não
// precisar de dependência de JWT: ele confere assinatura e expiração e devolve
// o payload já verificado.
async function verificarGoogle(credential) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID ausente');
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!r.ok) throw new Error('token inválido');
  const p = await r.json();
  if (p.aud !== clientId) throw new Error('aud divergente');
  if (p.iss !== 'accounts.google.com' && p.iss !== 'https://accounts.google.com') throw new Error('iss divergente');
  if (String(p.email_verified) !== 'true') throw new Error('e-mail não verificado');
  return { email: String(p.email).toLowerCase(), nome: p.name || p.email, hd: p.hd };
}

module.exports = {
  COOKIE,
  usuarioDe,
  entrar,
  sair,
  pode,
  papelDe,
  dominio,
  codigos,
  verificarGoogle,
  googleAtivo: () => Boolean(process.env.GOOGLE_CLIENT_ID),
};
