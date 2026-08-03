# Relatório de Consumo de IA — Quantua

**Levantado em 03/08/2026** por varredura exaustiva dos dois repositórios (`quantua-api`, `quantua-app`), lendo o código, o `schema.prisma` inteiro (1.352 linhas, 47 models) e as telas. Nenhum número aqui é estimado por leitura de documentação: tudo está citado com arquivo e linha.

---

## 1. Sumário executivo

A plataforma tem **15 etapas** que consomem IA, concentradas em **4 pontos físicos** de chamada à API da Anthropic. **Nenhum cron consome IA** — os 6 jobs registrados em `src/jobs/index.ts` são todos determinísticos ou HTTP.

Dos 7 campos que o relatório precisa ter, o sistema hoje sustenta **três e meio**:

| Campo pedido | Situação hoje |
|---|---|
| Nome do produto | Implícito (dá para inferir pela etapa) — não é um campo |
| Data e hora da geração | Só via `audit_events.timestamp`, e em 6 das 15 etapas |
| Quem gerou | Em 6 das 15 etapas, e **nunca colado ao custo** |
| Tempo de geração | **Não existe.** Não há cronômetro em nenhum ponto do código |
| Modelo de IA | Medido em 12, **persistido em 2** |
| Quantidade de tokens | Medido em 12, **persistido em 2** |
| Custo total | Gravado em 13 — mas veja a ressalva da seção 4 |

**Uma única tela mostra custo de IA na plataforma inteira**: a caixa "Custo de IA deste IBR" no topo da aba Data room (`quantua-app/src/app/pages/analyses/AnalysisDetail.tsx:1403`), com três números — extração, análise e total. Não existe visão por empresa, por workspace, por usuário nem por período. Não existe exportação.

**Não existe tabela dedicada a eventos de IA.** Todo custo vive dentro de campos `Json` espalhados por quatro tabelas.

---

## 2. As 15 etapas que consomem IA

| # | Etapa | Produto | Modelo | Onde |
|---|---|---|---|---|
| 1 | Extração de demonstrações — nível 2 (híbrido) | IBR | Haiku 4.5 | `services/ai-extraction.ts:85` |
| 2 | Extração de demonstrações — nível 3 (visão) | IBR | Sonnet 4.6 | `services/ai-extraction.ts:85` |
| 3 | **OCR de fallback do parser** | IBR — leitura de documento | Haiku 4.5 | `services/parser.ts:483` |
| 4 | OCR de balancete escaneado (transcrição) | IBR — balancete mensal | Haiku 4.5 | `services/balancete-ocr.ts:197` |
| 5 | OCR de balancete — releitura dirigida | IBR — balancete mensal | Haiku 4.5 | `services/balancete-ocr.ts:336` |
| 6 | Sugestões de classificação (na extração) | IBR — dicionário | Haiku 4.5 | `services/classification-suggest.ts:165` |
| 7 | Sugestões de classificação (refold) | IBR — dicionário | Haiku 4.5 | `routes/analyses.ts:2498` |
| 8 | Pesquisa web sobre a empresa | IBR — Análise Estratégica | configurável | `services/web-research.ts:195` |
| 9 | Pares setoriais via web | IBR — Benchmark Setorial | configurável | `services/web-research.ts:151` |
| 10 | Resumo de materiais complementares | IBR — Data room | configurável | `services/material-context.ts:114` |
| 11 | **Geração da análise do IBR** | IBR | Opus 4.8 | `services/claude.ts:507` |
| 12 | **Reconciliação por IA** | IBR — auditoria | Sonnet 4.6 | `routes/analyses.ts:2874` |
| 13 | De-para automático do orçamento | Modelos Financeiros | Haiku 4.5 | `services/classificar-de-para-orcamento.ts:80` |
| 14 | De-para — "classificar automaticamente" | Modelos Financeiros | Haiku 4.5 | `routes/models.ts:3365` |
| 15 | Fórmula por IA na linha do modelo | Modelos / Business Plan | Sonnet 4.6 | `services/ai-extraction.ts:127` |

**Observação sobre Valuation:** o produto não tem chamada de IA própria. Ele consome o IBR vinculado, cujo custo já está contabilizado nas etapas 1–12.

---

## 3. Onde o custo está guardado hoje

Não há tabela de eventos. O custo mora em campos `Json`:

| Tabela · campo | O que guarda |
|---|---|
| `analyses.dados_estruturados.custoExtracao` | `{ usd, fonte, fecha, niveis[] }` — extração + OCR de balancete |
| `analyses.dados_estruturados.custoSugestoes` | **CustoIA completo** (modelo + tokens + usd) |
| `analyses.resultado.custoAnalise` | **CustoIA completo** da geração |
| `analyses.resultado.custoWebResearch` / `custoWebPares` / `custoMateriais` | só USD |
| `documents.dados_extraidos.custo` / `ocrCustoUsd` | só USD, mais páginas e suspeitas do OCR |
| `audit_events.after.custoUsd` / `custoIaUsd` | só USD, e só nas etapas que emitem trilha |

A única coluna SQL que menciona IA é `Workspace.aiAnalysisModel` (`schema.prisma:102`) — e é **configuração**, não consumo.

Consequência prática: **não há como responder hoje** "quanto a empresa X consumiu em julho" sem varrer JSON de todas as análises. E os campos são **sobrescritos** a cada `/process` — não existe histórico de reprocessamento.

---

## 4. A ressalva que o pedido exige: "custo garantido pela IA"

O pedido foi por custo **garantido pela IA**. Sendo preciso sobre o que temos:

- **Os tokens são garantidos.** Vêm do campo `usage` da resposta da própria API (`ai-extraction.ts:97`), não de contagem nossa.
- **O dólar NÃO é garantido pela API.** A Anthropic não devolve preço. O USD sai de uma tabela **hardcoded** no nosso código (`PRECO_USD`, `ai-extraction.ts:111`), com Haiku a $1/$5, Sonnet a $3/$15 e Opus a $5/$25 por milhão de tokens. Se a tabela ficar defasada, **todo custo histórico da plataforma fica errado em silêncio**, e não há como saber qual preço foi usado em cada evento.

**Correção proposta:** carimbar em cada evento o preço unitário aplicado. O número passa a ser auditável e recalculável, e uma mudança de preço não reescreve o passado.

---

## 5. Achados que impedem o relatório pedido

### 5.1 Duas etapas não registram absolutamente nada — BLOQUEANTE

**Etapa 3** (`parser.ts:483`, `ocrPDFWithClaude`) instancia um **cliente Anthropic próprio**, fora de toda a instrumentação, e devolve `Promise<string>`: o `usage` é descartado. É visão com PDF inteiro em base64 e `max_tokens: 8192`. Nenhum USD, nenhum token, nenhuma linha em lugar nenhum. Também está fora do `createWithRetry`, ou seja, **sem retry de 429/529**.

**Etapa 12** (`routes/analyses.ts:2874`, reconciliação por IA) é chamada de **visão com Sonnet** sobre todos os PDFs de demonstrações — a mais cara depois da geração — e não grava custo.

Ambas violam a regra da casa "toda etapa com IA grava custo".

### 5.2 Tokens de cache nunca são lidos — o custo pode estar errado hoje

Nenhum ponto lê `cache_creation_input_tokens` nem `cache_read_input_tokens`. Esses tokens têm preço **diferente** do token normal (escrita mais cara, leitura muito mais barata). Onde há cache de prompt, o USD calculado hoje não corresponde à fatura.

### 5.3 O `CustoIA` completo existe e é jogado fora

Em 10 das 15 etapas o objeto com modelo e tokens é construído e só o `.usd` é persistido — por exemplo `analyses.ts:1684`, que recebe `r.custo` inteiro e guarda apenas `r.custo.usd`. **O dado não precisa ser produzido, precisa parar de ser descartado.**

### 5.4 Tempo de geração não existe

Não há `Date.now()` em volta de nenhuma chamada. Para o histórico já rodado, **é irrecuperável** — não dá para inventar.

### 5.5 Autor nunca fica colado ao custo

Onde há trilha, ela é do evento de negócio, não do gasto. Pior: a trilha da extração só é criada quando o hash dos insumos muda — **reprocessar com os mesmos insumos gasta token e não deixa rastro de autor**.

### 5.6 Cache reaproveitado se mistura com gasto novo

No OCR de balancete, o custo original é re-somado ao reusar o cache (`analyses.ts:1864`) no **mesmo campo** do gasto novo (`analyses.ts:1877`). O histórico precisa mostrar o custo original, mas o relatório de gasto do mês não pode contá-lo duas vezes.

---

## 6. Modelo de dados proposto

Uma tabela nova, **aditiva e toda anulável** — o deploy roda `prisma db push`, então nada de renomear.

`AiUsageEvent`: uma linha por **chamada física**. Retentativa vira linha própria (mesmo `grupoId`, `sequencia+1`). Reaproveitamento de cache vira linha de **custo zero** com `usdOriginal` preenchido.

Campos essenciais:

- **De quem é o gasto**: `workspaceId`, `companyId`, `analysisId`, `modelId`, `documentId`, `userId` + `userName` (snapshot, como o `AuditEvent` já faz)
- **O que foi**: `produto`, `etapa` (slug fixo), `origem` (`process` / `generate` / `refold` / `reconcile-ai` / `models` / `auto`), `grupoId`, `sequencia`, `ehRetentativa`
- **Modelo**: `modelo` (id real usado) e `modeloSolicitado` (a chave pedida — pega divergência entre o que foi pedido e o que rodou)
- **Tokens medidos**: `inputTokens`, `outputTokens`, **`cacheCreationTokens`**, **`cacheReadTokens`**, `buscasWeb`
- **Custo**: `usd`, `precoInputUsd` e `precoOutputUsd` **carimbados no evento**, `usdOriginal` (cache), `brl` + `ptax` + `dataPtax`
- **Tempo**: `iniciadoEm`, `concluidoEm`, `duracaoMs`
- **Proveniência**: `fonte` = `medido` | `backfill` | `inferido`

O campo `fonte` é o que permite mostrar histórico sem mentir: dado recuperado de JSON antigo entra como `backfill`, e o relatório o marca visualmente diferente do `medido`.

---

## 7. Cortes do relatório

**Operacionais (o que um sócio usa toda semana)**
1. Por IBR: quanto custou, quebrado por etapa, com autor e data — e quanto custou **regerar**
2. Por empresa e por workspace, no período
3. Por modelo: quanto está indo para Opus vs Sonnet vs Haiku
4. Top 10 mais caros do mês, com link para o produto

**De gestão**
5. Custo médio de IA por IBR entregue (o "custo de matéria-prima" do produto)
6. Custo de retrabalho: quanto foi gasto em reprocessamento e regeração
7. Tendência mensal, com quebra por etapa
8. Economia do cache: quanto foi evitado por reaproveitamento

**De controle**
9. Eventos sem autor (disparo automático) vs com autor
10. Retentativas: quanto se gasta em 429/529
11. Divergência `modeloSolicitado` × `modelo` — pega configuração que não está valendo

---

## 8. Fases

**Fase 1 — parar de sangrar (maior valor, menor risco).**
Criar `AiUsageEvent` e um helper único `registrarUsoIA()`. Ligar os **4 pontos físicos** de chamada a ele. Como todos os 15 caminhos passam por 4 funções, isso cobre 15 etapas com pouca superfície. Fechar as duas etapas mudas (5.1) e passar a ler tokens de cache (5.2). Carimbar preço no evento (seção 4).

**Fase 2 — o relatório.**
Rota agregadora + tela com os cortes 1 a 4, exportação em Excel (regra da casa: todo output de dados tem botão de exportar).

**Fase 3 — histórico.**
Backfill do que dá para recuperar dos campos `Json`, marcado como `backfill`. Tempo de geração fica ausente e **é declarado ausente** — não se inventa.

**Fase 4 — gestão.**
Cortes 5 a 11, alerta de estouro de orçamento por workspace.

---

## 9. Ponto de atenção fora do escopo do relatório

Duas etapas (3 e 12) fazem chamada de **visão** cara sem passar por `createWithRetry`, ou seja, sem retry e sem rate limit. Além de não registrarem custo, elas são o ponto mais frágil do pipeline sob carga.
