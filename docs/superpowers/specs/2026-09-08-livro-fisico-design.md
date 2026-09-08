# Livro físico no Reader Server — especificação de desenho

Data: 2026-09-08. Estado: aprovado em conversa (seções 1–6), aguardando revisão do texto.

## 1. Objetivo

Eduardo lê os mesmos livros em papel e no digital (Kindle com KOReader, iPads com Readest, Xteink X3 com CrossPoint). Hoje o servidor (`readerserver.up.railway.app`) sincroniza a posição entre os aparelhos digitais. Este desenho acrescenta o **livro físico como mais um cliente**: pelo celular, ele fotografa a página ou digita onde parou, o servidor traduz isso para a posição interna do EPUB e grava na mesma tabela de progresso. Na sincronização seguinte, Kindle, Readest e X3 abrem no ponto certo. No sentido inverso, o painel estima em que página do papel está a leitura digital.

Precisão exigida: parágrafo certo, tolerando o vizinho de cima ou de baixo, inclusive quando o papel é uma tradução (português) e o EPUB está em inglês.

## 2. Decisões já tomadas

| Tema | Decisão |
|---|---|
| Idioma papel × EPUB | Varia por livro: alguns iguais, outros traduzidos. |
| Gesto de marcar | Foto da página **e** texto digitado (o ditado do teclado do celular cobre a voz). |
| Precisão | Parágrafo, ±1. |
| EPUB no servidor | Sim, enviado uma vez por livro, guardado no volume. |
| Sentido inverso | Sim, na primeira versão (página estimada no papel). |
| IA | API da Anthropic. **Chave única, informada numa tela de Configurações e guardada no banco**, não em variável de ambiente. Sem seleção de provedor. |
| Login | Toda a área do celular exige login com o usuário e a senha que os aparelhos já usam. A sincronização dos aparelhos não muda. |
| Design | Paleta preto/branco/azul, vermelho só para alerta, sem rolagem horizontal, botões grandes para o polegar (regra do Eduardo para todos os sistemas). |

## 3. Arquitetura

Tudo no mesmo serviço Hono/Bun já publicado na Railway. Nenhum serviço novo. Os aparelhos continuam usando `/users/auth`, `PUT /syncs/progress` e `GET /syncs/progress/:document` com os cabeçalhos `x-auth-user` / `x-auth-key`; essas rotas não são alteradas.

Unidades novas, cada uma com uma responsabilidade e testável sozinha:

| Unidade | Arquivo | O que faz | Depende de |
|---|---|---|---|
| Sessão | `src/papel/sessao.ts` | Cookie assinado, login/logout, middleware `exigeSessao`. | tabela `users`, `PASSWORD_SALT` |
| Indexador de EPUB | `src/papel/epub-index.ts` | Lê o EPUB (zip), espinha, sumário, parágrafos com XPath no formato do KOReader e deslocamento de caracteres. Calcula o hash parcial MD5 do KOReader. | `fflate`, `htmlparser2` |
| Casamento local | `src/papel/casamento.ts` | Similaridade por trigramas entre o trecho informado e os parágrafos de um capítulo. Sem rede. | índice |
| Casamento por IA | `src/papel/ia.ts` | Uma chamada à API da Anthropic: recebe foto ou trecho + parágrafos numerados do capítulo, devolve o parágrafo e a confiança. | `@anthropic-ai/sdk`, chave em `settings` |
| Estimativa de página | `src/papel/pagina.ts` | Interpola posição digital ↔ página física a partir das marcações. | índice, `paper_marks`, `books` |
| Gravação de progresso | `src/progresso.ts` | Função `gravarProgresso()` extraída do handler `PUT /syncs/progress`, usada pelos dois caminhos (aparelhos e papel). | tabela `progress` |
| Telas | `src/papel/telas.tsx` | JSX das páginas de `/papel`. | — |
| Rotas | `src/papel/rotas.ts` | Monta as rotas `/papel/*` sobre as unidades acima. | todas |
| Painel | `src/dashboard.tsx` (existente) | Passa a mostrar "Livro físico", a página estimada e o link para `/papel`. | `pagina.ts` |

Fluxo de uma marcação:

1. Celular abre `/papel` → login (uma vez a cada 30 dias) → lista de livros.
2. Escolhe o livro → tela "Marcar onde parei": capítulo (lista do sumário, pré-selecionado o capítulo da última posição conhecida), foto **ou** texto **ou** "início do capítulo", e o campo opcional "página do livro físico".
3. Servidor localiza: texto no mesmo idioma → casamento local; foto, ou texto que não casa localmente → IA. Devolve o parágrafo encontrado com o anterior e o seguinte.
4. Eduardo confirma ("É este", "O de cima", "O de baixo") ou tenta de novo.
5. Servidor grava `paper_marks` (histórico) e `progress` (o que os aparelhos leem), com `device = "Livro físico"`, `device_id = "papel"`, `timestamp = agora`.
6. Kindle/Readest aplicam pelo horário mais novo; X3 aplica pela porcentagem mais avançada (Smart sync).

## 4. Dados

### 4.1 Tabelas novas (SQLite, criadas com `CREATE TABLE IF NOT EXISTS` na inicialização, como as existentes)

```sql
CREATE TABLE IF NOT EXISTS books (
  document     TEXT PRIMARY KEY,   -- hash parcial MD5 do KOReader (o mesmo que os aparelhos usam)
  user_id      INTEGER NOT NULL,
  title        TEXT,
  authors      TEXT,
  epub_path    TEXT NOT NULL,      -- data/books/<document>.epub
  index_path   TEXT NOT NULL,      -- data/books/<document>.index.json
  total_chars  INTEGER NOT NULL,
  spine_count  INTEGER NOT NULL,
  paper_pages  INTEGER,            -- total de páginas do livro de papel (opcional)
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_marks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document     TEXT NOT NULL,
  user_id      INTEGER NOT NULL,
  paragraph    INTEGER NOT NULL,   -- índice do parágrafo no índice do livro
  xpath        TEXT NOT NULL,
  char_offset  INTEGER NOT NULL,
  percentage   REAL NOT NULL,
  paper_page   INTEGER,            -- página do papel informada (opcional)
  method       TEXT NOT NULL,      -- 'texto' | 'foto' | 'capitulo'
  matched_by   TEXT NOT NULL,      -- 'local' | 'ia' | 'manual'
  confidence   REAL,
  input_text   TEXT,               -- trecho digitado ou transcrito pela IA; a foto NÃO é guardada
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  user_id      INTEGER PRIMARY KEY,
  api_key_enc  TEXT,               -- chave da API cifrada (AES-GCM, chave derivada de PASSWORD_SALT)
  updated_at   INTEGER NOT NULL
);
```

A tabela `progress` não muda. A linha do livro físico usa o mesmo `document` dos aparelhos, por isso aparece uma única vez no painel.

### 4.2 Arquivos no volume

`data/books/<document>.epub` (o arquivo enviado) e `data/books/<document>.index.json` (índice). O volume tem 4,9 GB livres; cada livro ocupa alguns MB.

### 4.3 Índice do livro (`.index.json`)

```json
{
  "document": "a3151aa606c6367fd86a1443a4e701a7",
  "spineCount": 20,
  "totalChars": 181006,
  "chapters": [
    { "title": "III. The Time Traveller Returns", "spine": 5, "paragraph": 41 }
  ],
  "paragraphs": [
    { "spine": 8, "xpath": "/body/DocFragment[8]/body/div/p[4]", "text": "“Looking round…", "offset": 52010 }
  ]
}
```

- `paragraphs` está na ordem de leitura; o índice na lista é o identificador do parágrafo.
- `offset` é a soma dos caracteres de todos os parágrafos anteriores; `percentage = offset / totalChars`.
- `chapters` vem do `nav.xhtml` (EPUB 3) com `toc.ncx` como alternativa; cada entrada aponta para o primeiro parágrafo a partir da âncora (`href#id`). Entradas que não resolvem são descartadas. Se o sumário não existir, cada item da espinha vira um capítulo "Seção N".

### 4.4 Regras do XPath (formato do KOReader/crengine)

- Prefixo `/body/DocFragment[N]/body`, N = posição do item na espinha, a partir de 1. Livro com um único item na espinha: `/body/DocFragment/body` (sem índice), como o crengine escreve.
- Depois do prefixo, o caminho de elementos a partir do `<body>` do XHTML, nomes em minúsculas, índice posicional entre irmãos do **mesmo nome** e **sem `[1]`** (`div/p[4]`, não `div[1]/p[4]`). É o formato que o Kindle grava e que Readest e CrossPoint comprovadamente leem.
- Parágrafo = elemento de bloco (`p`, `h1`…`h6`, `li`, `blockquote`, `pre`, `dd`, `dt`, `td`, `th`, `figcaption`) sem outro bloco dentro e com texto não vazio após colapsar espaços. Um bloco que contém blocos é atravessado, não emitido. Texto de `head`, `script` e `style` é ignorado.
- Verificação feita em 08/09 com o EPUB real de "The Time Machine": o índice gera `/body/DocFragment[8]/body/div/p[4]` (igual ao que o Kindle gravou) e o deslocamento dá 28,7% onde o Kindle diz 29,55%.

## 5. Rotas

Todas em `/papel/*`, exceto o painel. Todas exigem sessão, exceto a página e o POST de login. HTML renderizado no servidor, sem JavaScript além de um arquivo em `/public/papel.js` (reduzir a foto e mostrar prévia), respeitando a CSP atual (`script-src 'self'`).

| Método e rota | Função |
|---|---|
| `GET /papel` | Sem sessão: formulário de login. Com sessão: lista de livros (os do `progress` mais os de `books`), com "Enviar EPUB" onde faltar. |
| `POST /papel/login` | Campos `usuario`, `senha`. Verifica como o `authMiddleware`: `md5(senha)` + salt → `Bun.password.verify`. Limite de 10 tentativas/min por IP (mesmo `rateLimiter`). Cria o cookie. |
| `POST /papel/sair` | Apaga o cookie. |
| `GET /papel/config` · `POST /papel/config` | Tela de Configurações: campo "Chave de API" (mostra só os 4 últimos caracteres quando já existe), botão "Testar chave" (uma chamada mínima) e "Remover". |
| `POST /papel/livros` | Upload do EPUB (multipart, até 30 MB). Calcula o hash parcial MD5; monta o índice; grava `books`. Ver regras de aceitação em 7.1. |
| `GET /papel/livros/:document` | Tela do livro: posição digital atual (aparelho, %, capítulo), página estimada no papel, campo "total de páginas do papel", histórico das últimas marcações, botão "Marcar onde parei". |
| `POST /papel/livros/:document/paginas` | Salva `paper_pages`. |
| `GET /papel/livros/:document/marcar` | Formulário: capítulo, foto (`accept="image/*" capture="environment"`), texto, "início do capítulo", página do papel. |
| `POST /papel/livros/:document/localizar` | Executa o casamento (seção 6) e mostra o resultado com vizinhos; guarda o rascunho na sessão da tela (campos ocultos), nada no banco. |
| `POST /papel/livros/:document/confirmar` | Recebe o parágrafo escolhido e a página do papel; grava `paper_marks` e `progress`; volta à tela do livro com "Gravado às HH:MM. A próxima sincronização dos leitores pega daqui." |
| `GET /` (painel, existente) | Sem credenciais, como hoje. Novidades: aparelho "Livro físico"; "no papel: ≈ pág. N" quando houver `paper_pages`; link "Marcar no papel"; rodapé "Guarda os EPUBs que você enviou pela área do celular; a foto da página não é guardada." |

## 6. Casamento (do trecho ao parágrafo)

### 6.1 Ordem de decisão

1. **"Início do capítulo"** → parágrafo inicial do capítulo. `matched_by = manual`.
2. **Texto digitado** → casamento local no capítulo escolhido. Se confiante, pronto (`local`). Se não, e houver chave de API, vai para a IA com o texto (`ia`). Sem chave: mostra os 3 melhores candidatos locais ou oferece "início do capítulo".
3. **Foto** → exige chave de API (a leitura da imagem é feita pela IA). Sem chave: aviso claro e as opções texto/início do capítulo.

### 6.2 Casamento local (`casamento.ts`)

- Normalização: minúsculas, sem acentos, sem pontuação, espaços colapsados.
- Trigramas de caracteres; similaridade de Dice entre o trecho e (a) o início de cada parágrafo, cortado em 1,5× o tamanho do trecho, e (b) o parágrafo inteiro; vale o maior.
- Confiante: melhor ≥ 0,60 **e** vantagem ≥ 0,10 sobre o segundo. Duvidoso: melhor entre 0,40 e 0,60, ou vantagem menor que 0,10 → devolve 3 candidatos. Abaixo de 0,40: não encontrado.
- Escopo: capítulo escolhido; se não encontrado, o livro inteiro (só para texto digitado).

### 6.3 Casamento por IA (`ia.ts`)

- SDK oficial `@anthropic-ai/sdk`, cliente criado com a chave lida de `settings` (decifrada) a cada chamada; sem chave, a unidade responde "sem chave" e nunca chama a rede.
- Modelo `claude-opus-5`; `client.messages.parse` com `output_config.format = zodOutputFormat(Esquema)` e `output_config.effort = "medium"`; `max_tokens: 2048`. Sem reserva de queda (fallback) para outro modelo: a tarefa não tem risco de recusa, e um `stop_reason = "refusal"` ou `parsed_output = null` é tratado como "a IA não conseguiu localizar", com os caminhos alternativos da seção 6.1.
- Entrada: bloco de imagem base64 (JPEG, reduzido no celular a no máximo 1600 px no lado maior, limite 5 MB) **ou** o trecho digitado; depois, o texto: "Parágrafos do capítulo, numerados" (número + texto de cada parágrafo, no idioma do EPUB) e a instrução: transcrever o trecho legível, identificar o parágrafo em que a **página fotografada começa** (para texto digitado: o parágrafo que contém o trecho), considerando que o papel pode ser tradução para o português.
- Saída (esquema Zod): `{ transcricao: string, paragrafo: number | null, confianca: number (0–1), candidatos: number[] }`.
- Convenção de posição na foto: o **primeiro parágrafo completo da página fotografada**. Os botões "O de cima/O de baixo" ajustam.
- Confiante: `confianca ≥ 0,7`. Abaixo disso a tela mostra `candidatos` (até 3). `paragrafo = null` → "não encontrei neste capítulo", com a sugestão de conferir o capítulo.
- Custo estimado por foto com um capítulo de 4 mil palavras: 2 a 4 centavos de dólar. Nada é guardado da imagem; `input_text` recebe a `transcricao`.

## 7. Regras e casos de borda

### 7.1 Aceitação do EPUB

- Calcula o hash parcial MD5 do arquivo enviado (mesmo algoritmo do KOReader: 1 KB lido em 0, 1 K, 4 K, 16 K, 64 K, 256 K, 1 M, 4 M, 16 M, 64 M, 256 M, 1 G).
- Se já existe `progress` com esse hash: aceita e associa (é a mesma cópia dos aparelhos).
- Se não existe `progress` com esse hash, mas existe `progress` com o mesmo título e autor (metadados) em outro hash: **recusa**, com a mensagem "Esta cópia não é a mesma que seus aparelhos usam (hash diferente). Envie o arquivo que está no Kindle/Readest." Motivo: gravar progresso nesse hash criaria um livro em dobro, o problema corrigido em 08/09.
- Se não existe nenhum `progress`: aceita com aviso "Nenhum aparelho sincronizou este arquivo ainda; use exatamente esta cópia neles."
- EPUB inválido (não é zip, sem OPF, sem espinha): recusa, nada gravado.
- Reenvio do mesmo hash: substitui o arquivo e reconstrói o índice.

### 7.2 Porcentagem e prioridade entre aparelhos

- A porcentagem gravada é por caracteres e difere 1 a 2 pontos da porcentagem por páginas dos leitores.
- KOReader e Readest aplicam a posição remota pelo **horário**; a marcação no papel tem `timestamp = agora`, então vence.
- CrossPoint (Smart sync) aplica pela **porcentagem mais avançada**. Uma marcação a menos de ~2% à frente da posição local do X3 pode ser ignorada e sobreposta por ele. Limitação registrada na tela do livro ("no X3, marque pelo menos algumas páginas à frente").

### 7.3 Outros

- Capítulo sem parágrafos (só imagem): a lista pula para o próximo capítulo com texto.
- Foto maior que 5 MB mesmo reduzida: recusa com aviso.
- IA sem chave, sem crédito, limite de uso ou fora do ar: mensagem específica por caso (`AuthenticationError`, `RateLimitError`, `APIError`) e os caminhos alternativos (texto local, início do capítulo).
- Sessão expirada no meio do fluxo: volta ao login e, depois, à tela do livro.

## 8. Estimativa da página no papel (`pagina.ts`)

- Só quando `paper_pages` está preenchido.
- Pontos de calibração `(char_offset, paper_page)`: âncoras `(0, 1)` e `(totalChars, paper_pages)` mais todas as marcações do livro com `paper_page` informado, ordenadas por `char_offset` (marcações incoerentes, página menor que a anterior com deslocamento maior, são ignoradas).
- Posição digital atual: o `progress.progress` (XPath) é procurado no índice; se não for encontrado (leitor gerou um caminho que o índice não tem), usa `progress.percentage × totalChars`.
- Página = interpolação linear entre os dois pontos vizinhos, arredondada. Mostrada como "≈ pág. N" no painel e na tela do livro.
- Erro esperado: ±3 páginas sem marcações; ±1 com duas ou três marcações no mesmo livro.

## 9. Sessão e segurança

- Cookie `papel_sessao`, valor `base64url(payload).assinatura`, payload `{u: userId, exp}`; assinatura HMAC-SHA256 com chave derivada de `PASSWORD_SALT` (SHA-256 de `PASSWORD_SALT + "papel"`), sem variável nova. Atributos: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/papel`, validade 30 dias.
- Chave de API cifrada no banco com AES-GCM (WebCrypto), chave derivada do mesmo salt; nunca aparece inteira na tela.
- Limite de tentativas no login (10/min por IP, `x-forwarded-for` como hoje).
- Upload: só `.epub`, até 30 MB; a foto só transita em memória.
- CSP mantida; o único script é `/public/papel.js` (mesma origem).
- Painel `/` continua sem dados de conta.

## 10. Telas (`telas.tsx`)

Estilo herdado do painel (tokens de cor já existentes, modo claro e escuro). Uma coluna, largura máxima 720 px, botões com altura mínima de 48 px, fontes do sistema.

1. **Login**: usuário, senha, "Entrar". Erro em vermelho.
2. **Livros**: cabeçalho "Marcar no papel", link "Configurações"; cartão por livro com título, autor, posição digital (aparelho + %), "≈ pág. N no papel" quando houver, e o botão "Marcar onde parei" (ou "Enviar EPUB" se o livro ainda não tem arquivo).
3. **Livro**: posição atual, capítulo, total de páginas do papel (campo + salvar), últimas 5 marcações (data, método, capítulo, página), botão grande "Marcar onde parei", reenvio do EPUB.
4. **Marcar**: seletor de capítulo; bloco "Foto" (botão da câmera, prévia reduzida); bloco "Ou texto" (área de texto com dica "as primeiras palavras do parágrafo"); "Ou só o início do capítulo"; campo "página do papel (opcional)"; botão "Localizar".
5. **Resultado**: capítulo, parágrafo anterior em cinza, parágrafo encontrado em destaque, parágrafo seguinte em cinza; botões "É este", "O de cima", "O de baixo", "Tentar de novo". Se duvidoso: os candidatos listados com "É este" em cada um. Aviso de custo/IA quando a IA foi usada.
6. **Configurações**: chave de API (mascarada), "Testar", "Salvar", "Remover"; texto curto explicando para que serve e que sem ela só o texto local funciona.

## 11. Testes (`bun test`, arquivos `src/**/*.test.ts`)

| Teste | O que prova |
|---|---|
| `epub-index.test.ts` | Com um EPUB sintético montado no teste (2 itens de espinha, sumário com âncoras, blocos aninhados): XPaths corretos, sem `[1]`, capítulos resolvidos, deslocamentos e total. Hash parcial MD5 igual ao calculado por referência em Python. Caso de espinha única (`/body/DocFragment/body`). Se `~/Documents/Reading/Time Machine - H.G Wells .epub` existir: hash `a3151aa6…`, existe `/body/DocFragment[8]/body/div/p[4]`, deslocamento entre 27% e 31%. |
| `casamento.test.ts` | Trecho exato, trecho com erros de OCR (troca de letras, hifenização), trecho de outro capítulo (não encontrado), empate (duvidoso), acentos e pontuação. |
| `ia.test.ts` | Cliente falso injetado: monta a entrada correta (imagem ou texto + parágrafos numerados), interpreta a saída, trata `paragrafo = null`, confiança baixa e erros de autenticação/limite sem derrubar a rota. Sem chave → nunca chama. |
| `pagina.test.ts` | Interpolação com só âncoras; com marcações; marcações incoerentes ignoradas; XPath ausente cai na porcentagem. |
| `sessao.test.ts` | Cookie válido, expirado, assinatura alterada, login errado, limite de tentativas. |
| `papel-rotas.test.ts` | `app.request` sem cookie → 302 para login em todas as rotas; fluxo completo login → enviar EPUB sintético → marcar por texto → confirmar → linha em `progress` com `device = "Livro físico"` e XPath esperado; recusa de EPUB com hash diferente do livro já sincronizado. |
| `progresso.test.ts` | `gravarProgresso()` produz a mesma linha que o `PUT /syncs/progress` produzia (regressão dos aparelhos). |

Critério de aceite manual (depois do deploy): marcar "The Time Machine" por texto no celular, abrir no Kindle e no X3 e cair no parágrafo (±1); marcar por foto de um livro traduzido e conferir o mesmo.

## 12. Dependências e deploy

- Novas dependências: `fflate` (zip), `htmlparser2` + `domhandler` + `domutils` (XHTML), `@anthropic-ai/sdk` + `zod` (IA com saída estruturada). Tudo empacotado por `bun build` como hoje; a imagem não muda de base.
- Nenhuma variável de ambiente nova. A chave de API vive no banco.
- Deploy: `railway up` da pasta `app`, como descrito no README. Migração de esquema automática na subida (`CREATE TABLE IF NOT EXISTS`).
- README: nova seção "Marcar no papel" com o passo a passo do celular e a regra de que o EPUB enviado tem de ser a mesma cópia dos aparelhos.

## 13. Fora do escopo desta versão

- Mais de um usuário (o servidor tem um usuário; a área do celular herda isso).
- Guardar fotos, OCR local (Tesseract), outros provedores de IA, escolha de modelo na tela.
- Editar ou apagar marcações antigas (só listagem).
- Página física exata sem calibração (o modelo é a interpolação da seção 8).
