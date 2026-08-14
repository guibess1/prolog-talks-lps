# LP Hub · Prolog Talks

Hub interno de revisão e aprovação das landing pages do Prolog Talks.
No ar em **[prolog-talks-lps.vercel.app](https://prolog-talks-lps.vercel.app)** (uso interno, não indexado).

A LP de um evento nasce como HTML autocontido — feita pra rodar fora do site, colada
num widget. O hub é o que existe entre "a LP ficou pronta" e "a página está no ar em
prologapp.com": quem revisa comenta em cima do preview em formato mobile, o comentário
fica registrado com nome e devolve a LP pra fila, e quando não sobra pendência a LP é
aprovada e convertida em página `.astro` num PR no repo do site.

## O fluxo

```
LP nova  →  fila de revisão  →  comentários  →  aprovada  →  PR no site  →  publicada
              (/ver/<id>)      (viram ajuste)              (dev → main)
```

1. **Fila** — cada cartão é uma LP. `revisão` e `ajuste` ficam na fila; `aprovada`,
   `publicada` e `arquivada` vão pra aba Concluídas.
2. **Revisar** (`/ver/<id>`) — a LP abre num iframe em 390px por padrão, que é onde caem
   9 de cada 10 leads. Selecionar um trecho e comentar ancora o comentário naquele texto;
   comentário aberto puxa a LP de volta pra fila sozinho.
3. **Aprovar** — privilégio de admin, e bloqueado enquanto houver ajuste em aberto.
4. **Enviar pro site** — converte a LP em `src/pages/<série>/<slug>.astro`, extrai as
   imagens em base64 pra arquivos em `public/`, monta o JSON-LD de `Event` e abre PR
   contra `dev` em `prologapp/site-comercial-prolog`. Não mergeia e não publica: o gate
   de release continua sendo a esteira `validate` no PR `dev → main`.

## Como uma LP nova entra

Pelo menu `⋯` do cartão → **Duplicar LP**. Isso copia o *cartão* (título, evento, data,
SEO), não o arquivo — `public/<id>/index.html` entra por deploy e não dá pra criar em
runtime. Até o arquivo próprio subir, a cópia serve o HTML da LP de origem (campo
`htmlDe`), com aviso na tela pra ninguém revisar a copy do evento errado:

```powershell
Copy-Item -Recurse "public/kilsa" "public/<novo-id>"
vercel --prod
```

O `api/dados` faz um HEAD em `/<id>` a cada carregamento das LPs que têm `htmlDe`: assim
que o arquivo próprio responde, a cópia se promove sozinha. Não existe passo manual de
"avisar o hub que o arquivo chegou".

## Stack

Zero dependência, de propósito — não existe `node_modules` aqui. Funções serverless em
Node 22 na Vercel, HTML/CSS/JS puro no front, e Vercel, GitHub e Anthropic chamados por
`fetch` direto.

```
api/            funções serverless
  dados.js        estado inteiro do hub numa chamada (a tela toda depende dela)
  lp.js           PATCH edita, POST duplica, DELETE exclui
  comentario.js   comentários e resolução
  publicar.js     converte a LP e abre o PR no repo do site
  briefing.js     lê o documento do evento (PDF/imagem/markdown) e preenche a LP
  seo.js          sugere URL, título e descrição a partir da copy da própria LP
  login.js        Google Sign-In ou código de acesso
  _lib/
    auth.js       sessão em cookie assinado (HMAC), papéis por env var
    estado.js     persistência (ver abaixo)
    site.js       conversão LP → .astro + commit/PR via API do GitHub
    lp.js         leitura da LP publicada e resolução de qual HTML serve cada cartão
    aviso.js      webhook de Discord (best effort)
public/           o hub em si + uma pasta por LP
  index.html      fila, cartões, menu de ações, duplicar/editar
  ver/            tela de revisão: iframe + âncoras de comentário + envio pro site
  <id>/index.html a LP daquele evento (HTML autocontido, ~260KB com fonte e imagem)
```

### Persistência

Não tem banco. O token da Vercel disponível é de escopo de projeto, sem permissão pra
criar Blob nem Edge Config, então o estado (LPs + comentários) mora numa env var `plain`
do próprio projeto — `LPHUB_STATE` — lida e escrita em runtime pela API da Vercel.
Limite prático de 64KB no total de env vars; `estado.js` poda comentário resolvido antigo
pra caber. Se crescer, migrar pra Vercel Blob mexe só nesse arquivo.

## Variáveis de ambiente

| Variável | Precisa? | Pra quê |
|---|---|---|
| `SESSION_SECRET` | sim | assina o cookie de sessão |
| `KV_API_TOKEN`, `KV_PROJECT_ID`, `KV_TEAM_ID` | sim | ler e gravar o `LPHUB_STATE` pela API da Vercel |
| `LPHUB_STATE` | criada sozinha | o estado do hub |
| `LPHUB_PAPEIS` | sim | `{"email@prologapp.com":"admin"}` — quem não estiver aqui e for do domínio entra como revisor |
| `LPHUB_DOMINIO` | não | domínio que entra como revisor (padrão `prologapp.com`) |
| `GOOGLE_CLIENT_ID` | não | login com Google; sem ele sobra o código de acesso |
| `LPHUB_CODIGOS` | não | `{"CODIGO":{"nome":...,"email":...,"papel":...}}` — ponte de acesso |
| `GITHUB_TOKEN` | pro envio | abrir PR no repo do site. PAT **clássico** com escopo `repo` — fine-grained apontado pra repo da org precisa de aprovação de owner. Vence 12/09/2026 |
| `SITE_REPO`, `SITE_BASE_BRANCH` | não | padrão `prologapp/site-comercial-prolog` e `dev` |
| `ANTHROPIC_API_KEY` | pra IA | ler briefing e sugerir SEO. Sem ela os dois botões aparecem desabilitados dizendo o que falta |
| `DISCORD_WEBHOOK`, `LPHUB_URL` | não | aviso de comentário e de mudança de status |

Nada disso vive no repo — tudo é env var do projeto na Vercel (`vercel env add`).

## Deploy

Push na `main` deploya em produção. O repo é `guibess1/prolog-talks-lps` e não o da
org: a `prologapp` não tem o app do Vercel instalado e só um owner pode instalar, então
o vínculo mora na conta pessoal até isso mudar. O remote `org`
(`prologapp/prolog-talks-lps`) segue existindo como cópia, sem gatilho de deploy.

```bash
git push          # main → produção
git push origin minha-branch   # branch → preview com URL própria
vercel --prod     # ainda funciona, pra subir sem passar por commit
```

## Papéis

| Papel | Pode |
|---|---|
| `admin` | tudo: aprovar pela fila, trocar o status à mão, duplicar, excluir, apagar comentário, abrir PR no site |
| `revisor` | ver, comentar, resolver, devolver pra fila, arquivar, editar dados do cartão |
| `leitor` | só ver |

Pro admin, o chip de status do cartão é um botão: abre os cinco estados e grava o
que for escolhido, sem passar pela tela de revisão. É a saída pra quando o hub e a
realidade divergem — a página foi pro ar por fora, ou uma LP precisa voltar pra
ajuste sem ninguém ter comentado. `aprovada` e `publicada` continuam travadas
enquanto houver ajuste em aberto, e trocar o status aqui não abre PR, não publica e
não tira nada do ar: mexe só no estado dentro do hub.

O papel é re-resolvido da env var a cada requisição, não do cookie: promover ou rebaixar
alguém passa a valer no clique seguinte, sem precisar deslogar.
