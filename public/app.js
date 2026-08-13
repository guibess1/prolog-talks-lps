/* Utilitários compartilhados entre o hub e o visualizador. */
(function (raiz) {
  'use strict';

  var STATUS = {
    revisao:   { rotulo: 'aguardando revisão', chip: 'chip-warn',    fila: true },
    ajuste:    { rotulo: 'em ajuste',          chip: 'chip-mkt',     fila: true },
    aprovada:  { rotulo: 'aprovada',           chip: 'chip-ok',      fila: false },
    publicada: { rotulo: 'publicada',          chip: 'chip-brand',   fila: false },
    arquivada: { rotulo: 'arquivada',          chip: 'chip-neutral', fila: false }
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function iniciais(nome) {
    var p = String(nome || '?').trim().split(/\s+/);
    return ((p[0] || '')[0] + (p.length > 1 ? (p[p.length - 1] || '')[0] : '')).toUpperCase();
  }

  // "há 5 min" é mais útil que o timestamp cru numa fila de revisão: o que
  // importa é se o comentário é de agora ou de semana passada.
  function quando(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var seg = Math.floor((Date.now() - d.getTime()) / 1000);
    if (seg < 60) return 'agora';
    if (seg < 3600) return 'há ' + Math.floor(seg / 60) + ' min';
    if (seg < 86400) return 'há ' + Math.floor(seg / 3600) + 'h';
    if (seg < 604800) return 'há ' + Math.floor(seg / 86400) + 'd';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) +
      ', ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  var timerToast;
  function avisar(msg, tipo) {
    var t = document.querySelector('.toast');
    if (!t) return;
    t.textContent = msg;
    if (tipo) t.setAttribute('data-tipo', tipo); else t.removeAttribute('data-tipo');
    t.setAttribute('data-on', '');
    clearTimeout(timerToast);
    timerToast = setTimeout(function () { t.removeAttribute('data-on'); }, tipo === 'erro' ? 4200 : 2400);
  }

  function paraLogin() {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
  }

  // Todo fetch tem prazo: sem isso, uma requisição pendurada deixa a tela
  // girando pra sempre em vez de dizer que deu ruim.
  function api(rota, opcoes) {
    opcoes = opcoes || {};
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var estourou = false;
    var prazo = setTimeout(function () {
      estourou = true;
      if (ctrl) ctrl.abort();
    }, opcoes.timeout || 20000);

    return fetch('/api/' + rota, {
      method: opcoes.metodo || 'GET',
      headers: opcoes.corpo ? { 'Content-Type': 'application/json' } : undefined,
      body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      clearTimeout(prazo);
      if (r.status === 401) { paraLogin(); throw new Error('sessão expirada'); }
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.erro || ('erro ' + r.status));
        return d;
      });
    }, function (e) {
      clearTimeout(prazo);
      throw new Error(estourou ? 'o servidor demorou demais pra responder' : 'falha de rede: ' + e.message);
    });
  }

  function copiar(texto) {
    if (navigator.clipboard) {
      return navigator.clipboard.writeText(texto).then(
        function () { avisar('Link copiado: ' + texto); },
        function () { avisar(texto); }
      );
    }
    avisar(texto);
    return Promise.resolve();
  }

  raiz.Hub = {
    STATUS: STATUS,
    esc: esc,
    iniciais: iniciais,
    quando: quando,
    avisar: avisar,
    api: api,
    copiar: copiar,
    paraLogin: paraLogin
  };
})(window);
