# palavras-cli

Ferramenta de linha de comando para **encontrar palavras em português que contenham uma sequência de letras** — pensada para jogos tipo “prompt + substring” (por exemplo party games online em que tens de escrever uma palavra válida que inclua as letras mostradas no ecrã).

## Porque existe

O objetivo é responder rápido com **palavras jogáveis** (do dicionário), ordenadas por **uso real na língua** (corpus público), e opcionalmente **ler o texto no ecrã** quando jogas num browser sem quereres copiar manualmente a sequência.

Isto junta:

1. Um **dicionário grande em PT** (lista de palavras).
2. **Frequências derivadas de legendas** para priorizar o que soa “normal” em português falado.
3. Um modo **OCR + screenshot** no macOS para apontar uma zona do ecrã e obter sugestões automaticamente.

## Requisitos

- **Node.js** (recomendado: gerir dependências com **pnpm**, como no projeto).
- **Modo OCR (`--ocr`)**: macOS com permissão de **gravação de ecrã** para o terminal ou IDE onde corres o script; **Swift** disponível (`swift`) para os overlays/utilitários em `scripts/`.

## Instalação

```bash
pnpm install
```

## Como usar

### Linha de comandos (uma sequência)

```bash
pnpm start -- ABC
# ou
tsx index.ts ABC
```

Mostra candidatos do dicionário que contenham `ABC` (comparação em maiúsculas), com filtros descritos abaixo.

### Modo interativo

```bash
pnpm start
```

Escreve sequências até sair com `sair`, `q` ou `exit`.

### Modo OCR (captura + leitura no ecrã)

```bash
pnpm run start:ocr
# ou
tsx index.ts --ocr
```

1. **Captura periódica** da janela do sistema e OCR (`tesseract.js`, idiomas `por+eng`).
2. Extrai candidatos de **2 a 5 letras seguidas** do texto reconhecido e escolhe a sequência que permita a **palavra mais longa** no dicionário (empates pela frequência no corpus).
3. **Teclas** (com debounce para evitar repetição por auto-repeat):
   - **`s`** — força um ciclo já e guarda screenshot de debug na pasta `debug/ocr/` (recorte correto quando há região definida); tenta abrir no Preview.
   - **`r`** — abre overlay Swift para **desenhar ou ajustar a região** da captura na **tela principal**.
   - **`a`** — volta a OCR na **tela inteira**.
   - **`t`** *(macOS)* — envia **exatamente** o texto da linha **Melhor candidato** (`→ …`) como **digitação simulada** (sem clipboard nem Cmd+V): intervalos aleatórios, hesitações, por vezes **letra errada + backspace + certo**, por vezes **apaga um sufixo e redigita**, raramente **apaga tudo e recomeça**. Ajusta `OCR_TYPING_TYPO_*`, `OCR_TYPING_REDO_*`, `OCR_TYPING_RESTART_FROM_SCRATCH_CHANCE`, `OCR_KEYSTROKE_GAP_*`, etc. Exige **Acessibilidade** para o Terminal ou Cursor (além da gravação de ecrã).
   - **Ctrl+C** — termina.

**Região e Retina:** o overlay guarda coordenadas em **pontos** (como no macOS); o PNG da captura está em **pixels**. O código converte usando `screenWidth` / `screenHeight` exportados pelo overlay (e um helper Swift para entrada manual), para o recorte coincidir com a zona escolhida.

Se o overlay falhar, podes configurar a região **manualmente** no terminal (coordenadas na mesma convenção que o overlay).

## Fontes de dados

| Recurso | Origem | Cache local |
|--------|--------|-------------|
| Dicionário | [pythonprobr/palavras](https://github.com/pythonprobr/palavras) (`palavras.txt`) | `palavras-cache.txt` |
| Frequências PT | [FrequencyWords](https://github.com/hermitdave/FrequencyWords) — ficheiro `pt_full.txt` (legendas **OpenSubtitles**, compilado **2018**) | `freq-pt-opensubtitles-full.txt` |

Na **primeira execução** com rede disponível, os dois ficheiros são descarregados uma vez e ficam em cache na pasta do projeto.

### Como são ordenadas as sugestões

- **Melhor candidato** e lista seguinte: primeiro **comprimento** (palavra mais longa que **contém** a sequência como substring — máxima extensão no dicionário); em empate, maior **frequência no corpus**. Assim evitas ficar preso a palavras curtíssimas só porque são muito usadas nas legendas.

No OCR, o texto lido serve só como **“raiz” / sílabas pedidas**: não há análise morfológica; cruzamos essas letras com o dicionário inteiro.

- **Top pontuação**: ordenação por **pontos tipo Scrabble BR** (`LETTER_POINTS` no código), útil quando o jogo valoriza letras difíceis — independentemente da frequência na língua.

### Limitações do dicionário e filtros

- Controlas `-` e `'` em separado em `index.ts`: **`ALLOW_HYPHEN_IN_LEXEME`** (ex.: `beija-flores`) e **`ALLOW_APOSTROPHE_IN_LEXEME`** (ex.: `d'água`). Com **ambos** a `false`, só entram palavras **contínuas** (só letras Unicode). Com **ambos** a `true`, podes misturar os dois tipos de ligação na mesma entrada.
- **Comprimento máximo:** 64 caracteres por entrada (`MAX_WORD_LENGTH`).
- **Espaços** continuam sempre excluídos.

- O matching usa **maiúsculas** na substring; acentos são tratados onde faz sentido para cruzar com o corpus (normalização para lookup).

## Scripts Swift (`scripts/`)

| Ficheiro | Função |
|----------|--------|
| `ocr_region_overlay.swift` | Janela translúcida em ecrã inteiro para **definir retângulo** (arrastar, mover, cantos); Enter confirma, **F** tela inteira, Esc cancela. Saída JSON com `left`, `top`, `width`, `height`, `screenWidth`, `screenHeight`. |
| `main_screen_points.swift` | Imprime largura e altura em **pontos** da tela principal (para escalar região na entrada manual). |

Correr exemplos:

```bash
swift scripts/ocr_region_overlay.swift
swift scripts/main_screen_points.swift
```

## Dependências principais (Node)

- **`screenshot-desktop`** — captura de ecrã.
- **`pngjs`** — recorte PNG da região (coordenadas em pixels após conversão Retina).
- **`tesseract.js`** — OCR.

Tipagem para `pngjs`: ver `pngjs.d.ts`.

## Verificação de tipos

```bash
pnpm run build
# equivale a tsc --noEmit
```

## Ficheiros gerados / ignorar em cópias

Podes querer não versionar caches grandes ou screenshots locais:

- `palavras-cache.txt`
- `freq-pt-opensubtitles-full.txt`
- `debug/ocr/*.png`

(O projeto pode não incluir um `.gitignore`; ajusta conforme a tua preferência.)

## Tesseract (`*.traineddata`)

Se colocares `por.traineddata` / `eng.traineddata` (ou outros) na pasta do projeto, o comportamento depende da configuração do `tesseract.js` no ambiente; o worker é criado com `por+eng`. Para offline total, consulta a documentação do Tesseract.js sobre caminho dos dados treinados.

## Licença e ética de uso

Usa esta ferramenta de forma responsável nos jogos que jogares (respeita as regras e fair play da comunidade). Os dados de frequência reflectem **legendas**, não um “ranking oficial” académico — são úteis como proxy de **palavras comuns na língua coloquial**.

---

**Resumo:** `palavras-cli` existe para **ganhar tempo** a encontrar palavras válidas em PT com uma sequência obrigatória, priorizando **palavras mais longas no dicionário** e usando o corpus só para **desempatar**, com modo opcional **OCR no macOS** para ler o prompt diretamente do ecrã.
