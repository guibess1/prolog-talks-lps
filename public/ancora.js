/* Âncora de trecho dentro da LP.
 *
 * O comentário precisa voltar pro mesmo pedaço de texto depois de recarregar a
 * página, e a LP é HTML solto: não tem id em cada frase. A âncora é o próprio
 * texto selecionado mais qual ocorrência dele é na página, o que sobrevive a
 * mudança de layout e só quebra se a frase em si mudar — que é exatamente
 * quando o comentário deixou de fazer sentido mesmo.
 *
 * Comparação em texto normalizado (espaços colapsados) porque a seleção do
 * usuário e o texto do DOM quase nunca batem caractere a caractere.
 */
(function (raiz) {
  'use strict';

  function ehIgnorado(el) {
    if (!el) return true;
    var tag = el.tagName;
    return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE';
  }

  // Concatena os nós de texto visíveis e devolve, junto, o texto normalizado e o
  // mapa que leva cada posição do normalizado de volta ao índice original.
  function mapear(doc) {
    var caminhador = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        return ehIgnorado(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });

    var nos = [];
    var bruto = '';
    var n;
    while ((n = caminhador.nextNode())) {
      nos.push({ no: n, ini: bruto.length, fim: bruto.length + n.nodeValue.length });
      bruto += n.nodeValue;
    }

    var norm = '';
    var normParaBruto = [];
    var brutoParaNorm = new Array(bruto.length);
    var espacoPendente = false;
    for (var i = 0; i < bruto.length; i++) {
      var ch = bruto[i];
      if (/[\s ]/.test(ch)) {
        espacoPendente = norm.length > 0;
        brutoParaNorm[i] = norm.length;
        continue;
      }
      if (espacoPendente) { norm += ' '; normParaBruto.push(i); espacoPendente = false; }
      brutoParaNorm[i] = norm.length;
      norm += ch;
      normParaBruto.push(i);
    }

    return { nos: nos, bruto: bruto, norm: norm, normParaBruto: normParaBruto, brutoParaNorm: brutoParaNorm };
  }

  function normalizar(s) {
    return String(s || '').replace(/[\s ]+/g, ' ').trim();
  }

  // Índice global (no texto bruto) de um par nó/offset.
  function posDe(mapa, no, offset) {
    for (var i = 0; i < mapa.nos.length; i++) {
      if (mapa.nos[i].no === no) return mapa.nos[i].ini + offset;
    }
    return -1;
  }

  // Da seleção do usuário pra âncora persistível.
  function ancorarSelecao(doc, sel) {
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var trecho = normalizar(sel.toString());
    if (trecho.length < 2) return null;

    var mapa = mapear(doc);
    var r = sel.getRangeAt(0);
    var bruta = posDe(mapa, r.startContainer, r.startOffset);
    if (bruta < 0) {
      // Seleção começando num nó de elemento: aproxima pela primeira ocorrência.
      return { trecho: trecho, ocorrencia: 0 };
    }
    var alvoNorm = mapa.brutoParaNorm[bruta] != null ? mapa.brutoParaNorm[bruta] : 0;

    var ocorrencia = 0;
    var de = mapa.norm.indexOf(trecho);
    while (de !== -1 && de < alvoNorm - 2) {
      ocorrencia++;
      de = mapa.norm.indexOf(trecho, de + 1);
    }
    if (de === -1) ocorrencia = 0;
    return { trecho: trecho, ocorrencia: ocorrencia };
  }

  // Da âncora de volta pros índices brutos. null quando o texto sumiu da página.
  function localizar(mapa, trecho, ocorrencia) {
    var alvo = normalizar(trecho);
    if (!alvo) return null;
    var de = mapa.norm.indexOf(alvo);
    var n = 0;
    while (de !== -1 && n < (ocorrencia || 0)) {
      de = mapa.norm.indexOf(alvo, de + 1);
      n++;
    }
    if (de === -1) {
      // Caiu a ocorrência exata (a página mudou): aceita a primeira, é melhor
      // ancorar num lugar parecido do que perder o comentário de vista.
      de = mapa.norm.indexOf(alvo);
      if (de === -1) return null;
    }
    var ini = mapa.normParaBruto[de];
    var ultimo = mapa.normParaBruto[de + alvo.length - 1];
    if (ini == null || ultimo == null) return null;
    return { ini: ini, fim: ultimo + 1 };
  }

  // Embrulha o intervalo em <mark>. Um nó de texto por vez porque a seleção
  // costuma atravessar tags (<em>, <strong>) e surroundContents falharia.
  function marcar(doc, mapa, ini, fim, atributos) {
    var pedacos = [];
    mapa.nos.forEach(function (e) {
      if (e.fim <= ini || e.ini >= fim) return;
      pedacos.push({
        no: e.no,
        de: Math.max(0, ini - e.ini),
        ate: Math.min(e.no.nodeValue.length, fim - e.ini)
      });
    });

    var marcas = [];
    pedacos.forEach(function (p) {
      var no = p.no;
      if (p.ate < no.nodeValue.length) no.splitText(p.ate);
      var alvo = p.de > 0 ? no.splitText(p.de) : no;
      if (!alvo.nodeValue) return;
      var m = doc.createElement('mark');
      m.className = 'lphub-marca';
      Object.keys(atributos || {}).forEach(function (k) { m.setAttribute(k, atributos[k]); });
      alvo.parentNode.insertBefore(m, alvo);
      m.appendChild(alvo);
      marcas.push(m);
    });
    return marcas;
  }

  function limparMarcas(doc) {
    var marcas = Array.prototype.slice.call(doc.querySelectorAll('mark.lphub-marca'));
    marcas.forEach(function (m) {
      var pai = m.parentNode;
      while (m.firstChild) pai.insertBefore(m.firstChild, m);
      pai.removeChild(m);
      pai.normalize();
    });
  }

  raiz.Ancora = {
    mapear: mapear,
    normalizar: normalizar,
    ancorarSelecao: ancorarSelecao,
    localizar: localizar,
    marcar: marcar,
    limparMarcas: limparMarcas
  };
})(window);
