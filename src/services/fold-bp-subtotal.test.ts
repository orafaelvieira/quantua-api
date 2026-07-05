import { vi, describe, it, expect } from "vitest";

// foldBP não chama a IA, mas o módulo instancia o client no load — mock do SDK e da env.
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn() } } }));
vi.mock("../config/env", () => ({ env: { anthropicApiKey: "test-key" } }));

import { foldBP } from "./ai-extraction";

const valorDe = (bp: any[], conta: string, p: string) => bp.find((l) => l.conta === conta)?.valores?.[p] ?? 0;

describe("foldBP — descarte de subtotal POR VALOR (caso Maniacs)", () => {
  it("descarta o pai quando os filhos capturados somam o valor dele (2021)", () => {
    const arvore = {
      "2021": {
        grupos: {
          "Passivo Não Circulante": [
            { nome: "OBRIGAÇÕES A LONGO PRAZO", valor: 2012221.4 }, // pai (soma dos 2 abaixo)
            { nome: "EMPRÉSTIMOS INSTITUIÇÕES FINANCEIRAS", valor: 1158515.97 },
            { nome: "OBRIGAÇÕES TRIBUTÁRIAS", valor: 853705.43 },
          ],
        },
      },
    } as any;
    const { bp } = foldBP(arvore, ["2021"]);
    // Subtotal do grupo NÃO duplica: PNC = 2.012.221,40 (não 4.024.442,80)
    const pnc = bp.find((l) => l.classificacao === "PNC" && l.nivel === 1);
    expect(pnc?.valores["2021"]).toBeCloseTo(2012221.4, 1);
    // Pai flat vira ESTRUTURAL (a árvore é reconstruída pela relação de valor e os
    // filhos são classificados — não órfãos, não duplicados)
    const pai = arvore["2021"].grupos["Passivo Não Circulante"][0];
    expect(pai.destino).toContain("estrutural");
    expect(pai.filhos?.length).toBe(2); // árvore reconstruída in-place (auditoria aninhada)
    // Filho tributário mapeado no destino certo (keyword + grupo LP)
    expect(valorDe(bp, "Obrigações Tributárias - LP", "2021")).toBeCloseTo(853705.43, 1);
    // Filho de empréstimos preservado no grupo (destino específico OU balde "Outros" —
    // o balde vira âmbar na auditoria e o analista classifica uma vez, alimentando o dicionário)
    const filhoEmprestimos =
      valorDe(bp, "Empréstimos e Financiamentos - LP", "2021") +
      valorDe(bp, "Outros Passivos não Circulantes", "2021");
    expect(filhoEmprestimos).toBeCloseTo(1158515.97, 1);
  });

  it("NÃO descarta quando não há filhos capturados (2020 — pai é o único portador)", () => {
    const arvore = {
      "2020": {
        grupos: {
          "Passivo Não Circulante": [
            { nome: "OBRIGAÇÕES A LONGO PRAZO", valor: 701005.6 },
            { nome: "OUTRAS OBRIGAÇÕES A LONGO PRAZO", valor: 1163843.0 },
          ],
        },
      },
    } as any;
    const { bp } = foldBP(arvore, ["2020"]);
    const pnc = bp.find((l) => l.classificacao === "PNC" && l.nivel === 1);
    // Nada some: os dois valores permanecem no grupo
    expect(pnc?.valores["2020"]).toBeCloseTo(701005.6 + 1163843.0, 1);
  });

  it("pareamento 1-para-1 só descarta com nomes contidos; valores iguais de contas distintas ficam", () => {
    const arvore = {
      "2021": {
        grupos: {
          "Passivo Não Circulante": [
            // duplicata pai/filho (nomes contidos) → descarta um
            { nome: "OUTRAS OBRIGAÇÕES A LONGO PRAZO", valor: 1157553.33 },
            { nome: "OUTRAS OBRIGAÇÕES", valor: 1157553.33 },
          ],
          "Ativo Circulante": [
            // mesmos valores, contas DISTINTAS → mantém as duas
            { nome: "Clientes", valor: 10000 },
            { nome: "Estoques", valor: 10000 },
          ],
        },
      },
    } as any;
    const { bp } = foldBP(arvore, ["2021"]);
    const pnc = bp.find((l) => l.classificacao === "PNC" && l.nivel === 1);
    expect(pnc?.valores["2021"]).toBeCloseTo(1157553.33, 1); // uma vez, não duas
    const ac = bp.find((l) => l.classificacao === "AC" && l.nivel === 1);
    expect(ac?.valores["2021"]).toBeCloseTo(20000, 1); // nada descartado
  });
});

describe("foldBP v2 — árvore completa (hierarquia real da Maniacs)", () => {
  it("2020 PC: classifica no nó mais alto que mapeia — composição EXATA, Outros = 0", () => {
    // Estrutura fiel do balanço 2020 (pais com subtotal declarado + filhos aninhados)
    const arvore = {
      "2020": {
        grupos: {
          "Passivo Circulante": [
            { nome: "INSTITUIÇÕES FINANCEIRAS", valor: 784747.13, filhos: [{ nome: "EMPRÉSTIMOS", valor: 784747.13 }] },
            { nome: "FORNECEDORES", valor: 3810318.43, filhos: [{ nome: "FORNECEDORES NACIONAIS", valor: 3810318.43 }] },
            { nome: "OBRIGAÇÕES TRIBUTÁRIAS", valor: 2143932.09, filhos: [
              { nome: "IMPOSTOS E CONTRIBUIÇÕES A RECOLHER", valor: 1234394.88 },
              { nome: "TRIBUTOS RETIDOS A RECOLHER", valor: 19124.08 },
              { nome: "PARCELAMENTO DE IMPOSTOS", valor: 890413.13 },
            ]},
            { nome: "OBRIGAÇÕES TRABALHISTAS E PRIVIDENCIÁRIAS", valor: 480539.43, filhos: [
              { nome: "OBRIGAÇÕES COM O PESSOAL", valor: 72390.40 },
              { nome: "OBRIGAÇÕES PREVIDENCIÁRIAS", valor: 344982.49 },
              { nome: "PROVISÕES", valor: 63166.54 },
            ]},
            { nome: "OUTRAS OBRIGAÇÕES", valor: 2348859.91, filhos: [{ nome: "ADIANTAMENTOS DE CLIENTES", valor: 2348859.91 }] },
          ],
        },
      },
    } as any;
    // Espelha a produção: o dicionário global tem "Adiantamentos de Clientes" (plural).
    const dict = [{ nomeOriginal: "Adiantamentos de Clientes", contaDestino: "Despesas Ant. / Adiantamentos - Passivo", grupoConta: "Passivo Circulante" }];
    const { bp, naoMapeados, alertasComposicao } = foldBP(arvore, ["2020"], dict);
    // Composição EXATA no nível semântico (o bug real: OT vinha 1.234.394,88)
    expect(valorDe(bp, "Obrigações Tributárias - CP", "2020")).toBeCloseTo(2143932.09, 1);
    expect(valorDe(bp, "Obrigações Trabalhistas - CP", "2020")).toBeCloseTo(480539.43, 1);
    expect(valorDe(bp, "Fornecedores - CP", "2020")).toBeCloseTo(3810318.43, 1);
    // NADA no balde e nada órfão
    expect(valorDe(bp, "Outros Passivos Circulantes", "2020")).toBeCloseTo(0, 1);
    expect(naoMapeados.filter((n) => n.periodo === "2020").length).toBe(0);
    // Total do grupo = declarado no documento
    const pc = bp.find((l) => l.classificacao === "PC" && l.nivel === 1);
    expect(pc?.valores["2020"]).toBeCloseTo(9568396.99, 1);
    // Documento internamente consistente → sem alertas de composição
    expect(alertasComposicao.length).toBe(0);
  });

  it("2020 PNC: pai estrutural desce para os filhos; tributos LP no destino certo", () => {
    const arvore = {
      "2020": {
        grupos: {
          "Passivo Não Circulante": [
            { nome: "OBRIGAÇÕES A LONGO PRAZO", valor: 701005.60, filhos: [
              { nome: "OBRIGAÇÕES TRIBUTÁRIAS", valor: 701005.60 },
            ]},
            { nome: "OUTRAS OBRIGAÇÕES A LONGO PRAZO", valor: 1163842.99, filhos: [
              { nome: "OUTRAS OBRIGAÇÕES", valor: 1163842.99 },
            ]},
          ],
        },
      },
    } as any;
    const { bp } = foldBP(arvore, ["2020"]);
    // O agrupador não mapeia (removido do dicionário) → estrutural → filho classifica
    expect(valorDe(bp, "Obrigações Tributárias - LP", "2020")).toBeCloseTo(701005.60, 1);
    const pnc = bp.find((l) => l.classificacao === "PNC" && l.nivel === 1);
    expect(pnc?.valores["2020"]).toBeCloseTo(1864848.59, 1);
  });

  it("folha ambígua herda contexto do pai (Provisões sob Obrigações Trabalhistas)", () => {
    const arvore = {
      "2021": {
        grupos: {
          "Passivo Circulante": [
            { nome: "OBRIGAÇÕES TRABALHISTAS E PREV XYZ ATÍPICO", valor: 100, filhos: [
              { nome: "PROVISÕES", valor: 100 },
            ]},
          ],
        },
      },
    } as any;
    const { bp } = foldBP(arvore, ["2021"]);
    // Pai atípico não mapeia → estrutural; "PROVISÕES" sozinho é ambíguo, mas com o
    // contexto "…TRABALHISTAS… PROVISÕES" o keyword resolve para Obrigações Trabalhistas - CP.
    expect(valorDe(bp, "Obrigações Trabalhistas - CP", "2021")).toBeCloseTo(100, 1);
  });

  it("prova de composição: filho faltando na captura → delta preservado em Outros + alerta", () => {
    const arvore = {
      "2021": {
        grupos: {
          "Passivo Não Circulante": [
            { nome: "AGRUPADOR QUALQUER XPTO", valor: 1000, filhos: [
              { nome: "SUBCONTA QUALQUER ZWK", valor: 600 }, // faltam 400 (não capturados)
            ]},
          ],
        },
      },
    } as any;
    const { bp, alertasComposicao } = foldBP(arvore, ["2021"]);
    const pnc = bp.find((l) => l.classificacao === "PNC" && l.nivel === 1);
    expect(pnc?.valores["2021"]).toBeCloseTo(1000, 1); // total do documento NUNCA se perde
    expect(alertasComposicao.length).toBe(1);
    expect(alertasComposicao[0].delta).toBeCloseTo(400, 1);
    expect(alertasComposicao[0].caminho).toContain("AGRUPADOR QUALQUER XPTO");
  });

  it("nó mapeado absorve a subárvore (filhos não duplicam) e audita a absorção", () => {
    const arvore = {
      "2021": {
        grupos: {
          "Passivo Circulante": [
            { nome: "OBRIGAÇÕES TRIBUTÁRIAS", valor: 500, filhos: [
              { nome: "ICMS A RECOLHER", valor: 300 },
              { nome: "PIS A RECOLHER", valor: 200 },
            ]},
          ],
        },
      },
    } as any;
    const { bp } = foldBP(arvore, ["2021"]);
    expect(valorDe(bp, "Obrigações Tributárias - CP", "2021")).toBeCloseTo(500, 1); // uma vez só
    const pc = bp.find((l) => l.classificacao === "PC" && l.nivel === 1);
    expect(pc?.valores["2021"]).toBeCloseTo(500, 1);
    const filhos = arvore["2021"].grupos["Passivo Circulante"][0].filhos;
    expect(filhos[0].destino).toContain("absorvido");
  });
});

describe("foldBP — captura FLAT do caso REAL de produção (pai+filhos no mesmo nível)", () => {
  it("2020 PC flat: reconstrói a árvore e o pai que mapeia ABSORVE os filhos (sem órfãos)", () => {
    // Exatamente o que a IA devolveu em produção: tudo no mesmo nível, sem `filhos`.
    const arvore = {
      "2020": {
        grupos: {
          "Passivo Circulante": [
            { nome: "OBRIGAÇÕES TRIBUTÁRIAS", valor: 2143932.09 },
            { nome: "IMPOSTOS E CONTRIBUIÇÕES A RECOLHER", valor: 1234394.88 },
            { nome: "TRIBUTOS RETIDOS A RECOLHER", valor: 19124.08 },
            { nome: "PARCELAMENTO DE IMPOSTOS", valor: 890413.13 },
            { nome: "OBRIGAÇÕES TRABALHISTAS E PRIVIDENCIÁRIAS", valor: 480539.43 },
            { nome: "OBRIGAÇÕES COM O PESSOAL", valor: 72390.40 },
            { nome: "OBRIGAÇÕES PREVIDENCIÁRIAS", valor: 344982.49 },
            { nome: "PROVISÕES", valor: 63166.54 },
            { nome: "FORNECEDORES", valor: 3810318.43 },
          ],
        },
      },
    } as any;
    const { bp, naoMapeados } = foldBP(arvore, ["2020"]);
    // Pais mapeiam e absorvem com o valor declarado — composição exata, zero órfãos
    expect(valorDe(bp, "Obrigações Tributárias - CP", "2020")).toBeCloseTo(2143932.09, 1);
    expect(valorDe(bp, "Obrigações Trabalhistas - CP", "2020")).toBeCloseTo(480539.43, 1);
    expect(valorDe(bp, "Fornecedores - CP", "2020")).toBeCloseTo(3810318.43, 1);
    expect(valorDe(bp, "Outros Passivos Circulantes", "2020")).toBeCloseTo(0, 1);
    expect(naoMapeados.length).toBe(0); // era o bug: 10 contas órfãs para classificar
    const pc = bp.find((l) => l.classificacao === "PC" && l.nivel === 1);
    expect(pc?.valores["2020"]).toBeCloseTo(2143932.09 + 480539.43 + 3810318.43, 1);
    // Árvore reconstruída in-place: filhos aninhados sob os pais (auditoria)
    const ot = arvore["2020"].grupos["Passivo Circulante"].find((i: any) => i.nome === "OBRIGAÇÕES TRIBUTÁRIAS");
    expect(ot.filhos?.length).toBe(3);
  });
});

describe("foldBP — contexto do pai não pode inflar o keyword-match (palavra duplicada)", () => {
  it("OUTRAS OBRIGAÇÕES sob OUTRAS OBRIGAÇÕES A LONGO PRAZO cai no balde, NUNCA em Trabalhistas", () => {
    const arvore = {
      "2020": {
        grupos: {
          "Passivo Não Circulante": [
            { nome: "OUTRAS OBRIGAÇÕES A LONGO PRAZO", valor: 1163842.99, filhos: [
              { nome: "OUTRAS OBRIGAÇÕES", valor: 1163842.99 },
            ]},
          ],
        },
      },
    } as any;
    // Dicionário real: pai mapeia para o balde (bucket + filhos → desce p/ o filho)
    const dict = [{ nomeOriginal: "Outras Obrigações a Longo Prazo", contaDestino: "Outros Passivos não Circulantes", grupoConta: "Passivo Não Circulante" }];
    const { bp } = foldBP(arvore, ["2020"], dict);
    // Bug real de produção: caía em Obrigações Trabalhistas - LP (score inflado por duplicata)
    expect(valorDe(bp, "Obrigações Trabalhistas - LP", "2020")).toBeCloseTo(0, 1);
    expect(valorDe(bp, "Outros Passivos não Circulantes", "2020")).toBeCloseTo(1163842.99, 1);
  });
});

describe("foldBP — pai com destino genérico ('Outros ...') desce para os filhos", () => {
  it("OUTROS CRÉDITOS: filho específico ganha a própria linha; resto segue no destino do pai; AC fecha", () => {
    const arvore = {
      "2022": {
        grupos: {
          "Ativo Circulante": [
            { nome: "OUTROS CRÉDITOS", valor: 1575947, filhos: [
              { nome: "ADIANTAMENTOS A TERCEIROS", valor: 618348 },
              { nome: "ADIANTAMENTOS A FUNCIONARIOS", valor: 15076 },
              { nome: "EMPRÉSTIMOS A FUNCIONÁRIOS", valor: 1500 },
              { nome: "EMPRÉSTIMOS A SÓCIOS", valor: 583774 },
              { nome: "TRIBUTOS A RECUPERAR", valor: 357249 },
            ]},
          ],
        },
      },
    } as any;
    // Dicionário: o PAI mapeia para linha genérica "Outros ..." (não é o balde do grupo) —
    // antes ABSORVIA tudo; agora desce para os filhos classificarem específico.
    const dict = [{ nomeOriginal: "Outros Créditos", contaDestino: "Outros Créditos a Receber - CP", grupoConta: "Ativo Circulante" }];
    const { bp, naoMapeados } = foldBP(arvore, ["2022"], dict);
    expect(valorDe(bp, "Tributos a Recuperar - CP", "2022")).toBeCloseTo(357249, 1); // linha própria
    expect(valorDe(bp, "Despesas Ant. / Adiantamentos - Ativo", "2022")).toBeCloseTo(618348, 1); // via alias
    // Filhos sem linha específica caem no destino do pai via contexto (nunca pior que a absorção)
    expect(valorDe(bp, "Outros Créditos a Receber - CP", "2022")).toBeCloseTo(15076 + 1500 + 583774, 1);
    const ac = bp.find((l) => l.classificacao === "AC" && l.nivel === 1);
    expect(ac?.valores["2022"]).toBeCloseTo(1575947, 1); // total do grupo fecha com o declarado
    expect(naoMapeados.length).toBe(0); // nada de âmbar: tudo resolvido determinístico
  });
});

describe("foldBP — níveis intermediários de profundidade arbitrária (caso Fibracabos Grau 4)", () => {
  // Soma das linhas de INPUT de um grupo (composição visível) — "nenhuma folha perdida"
  // significa: composição das contas detalhadas = subtotal do grupo.
  const somaInputs = (bp: any[], classifs: string[], p: string) =>
    bp.filter((l) => l.nivel === 2 && classifs.includes(l.classificacao)).reduce((s, l) => s + (l.valores?.[p] ?? 0), 0);

  it("Grau 4: EXIGÍVEL/CRÉDITOS viram estruturais, folhas classificadas nas contas do modelo, subtotais fecham", () => {
    const arvore = {
      "2023": {
        grupos: {
          "Ativo Circulante": [
            // Intermediário homogêneo: filhos no MESMO destino → absorção continua (regressão)
            { nome: "DISPONIBILIDADES", valor: 50000, filhos: [
              { nome: "CAIXA GERAL", valor: 10000 },
              { nome: "BANCOS CONTA CORRENTE", valor: 40000 },
            ]},
            // Intermediário AGREGADO: mapeia via alias p/ "Contas a Receber - CP", mas os
            // filhos são de naturezas distintas — antes ABSORVIA tudo numa linha só.
            { nome: "CRÉDITOS", valor: 450000, filhos: [
              { nome: "IMPOSTOS A RECUPERAR", valor: 100000 },
              { nome: "DUPLICATAS A RECEBER", valor: 300000 },
              { nome: "ADIANTAMENTOS A FORNECEDORES", valor: 50000 },
            ]},
          ],
          "Ativo Não Circulante": [
            { nome: "DIFERIDO", valor: 30000 }, // grupo irmão fora do padrão — nunca descartado
          ],
          "Passivo Circulante": [
            // Intermediário que EQUIVALE AO GRUPO (= total do PC). Entrada de dicionário
            // real que disparava o bug: destino = a linha de SUBTOTAL "Passivo Circulante"
            // → absorvia as folhas e a composição do PC ficava R$ 0.
            { nome: "EXIGÍVEL A CURTO PRAZO", valor: 500000, filhos: [
              { nome: "FORNECEDORES A PAGAR", valor: 200000 },
              { nome: "OBRIGAÇÕES FISCAIS", valor: 180000 },
              { nome: "OBRIGAÇÕES TRABALHISTAS", valor: 120000 },
            ]},
          ],
        },
      },
    } as any;
    const dict = [{ nomeOriginal: "Exigível a Curto Prazo", contaDestino: "Passivo Circulante", grupoConta: "Passivo Circulante" }];
    const { bp, naoMapeados, alertasComposicao } = foldBP(arvore, ["2023"], dict);

    // PC: folhas classificadas nas contas do modelo (era: tudo absorvido, composição 0)
    expect(valorDe(bp, "Fornecedores - CP", "2023")).toBeCloseTo(200000, 1);
    expect(valorDe(bp, "Obrigações Tributárias - CP", "2023")).toBeCloseTo(180000, 1);
    expect(valorDe(bp, "Obrigações Trabalhistas - CP", "2023")).toBeCloseTo(120000, 1);
    const pc = bp.find((l) => l.classificacao === "PC" && l.nivel === 1);
    expect(pc?.valores["2023"]).toBeCloseTo(500000, 1);
    // "verde só com prova": composição das contas detalhadas FECHA com o subtotal
    expect(somaInputs(bp, ["PO", "PF"], "2023")).toBeCloseTo(500000, 1);
    // intermediário marcado ESTRUTURAL (não-folha), com a trilha preservada p/ auditoria
    const exigivel = arvore["2023"].grupos["Passivo Circulante"][0];
    expect(exigivel.destino).toContain("estrutural");

    // AC: CRÉDITOS estrutural → cada folha na linha certa (era: tudo em Contas a Receber)
    expect(valorDe(bp, "Tributos a Recuperar - CP", "2023")).toBeCloseTo(100000, 1);
    expect(valorDe(bp, "Contas a Receber - CP", "2023")).toBeCloseTo(300000, 1);
    expect(valorDe(bp, "Despesas Ant. / Adiantamentos - Ativo", "2023")).toBeCloseTo(50000, 1);
    const creditos = arvore["2023"].grupos["Ativo Circulante"][1];
    expect(creditos.destino).toContain("estrutural");
    // DISPONIBILIDADES (filhos homogêneos) segue ABSORVENDO — comportamento preservado
    expect(valorDe(bp, "Caixa e Equivalentes de Caixa", "2023")).toBeCloseTo(50000, 1);
    const ac = bp.find((l) => l.classificacao === "AC" && l.nivel === 1);
    expect(ac?.valores["2023"]).toBeCloseTo(500000, 1);
    expect(somaInputs(bp, ["AC", "AF", "AO"], "2023")).toBeCloseTo(500000, 1);

    // DIFERIDO não é descartado (classificado em linha do modelo; ANC fecha)
    const anc = bp.find((l) => l.classificacao === "ANC" && l.nivel === 1);
    expect(anc?.valores["2023"]).toBeCloseTo(30000, 1);
    expect(somaInputs(bp, ["ANC"], "2023")).toBeCloseTo(30000, 1);

    // Documento internamente consistente → nenhum alerta; nada âmbar
    expect(alertasComposicao.length).toBe(0);
    expect(naoMapeados.length).toBe(0);
  });

  it("Grau 5-6: cadeia de intermediários vira estrutural nível a nível; absorção só no nó semântico", () => {
    const arvore = {
      "2024": {
        grupos: {
          "Ativo Circulante": [
            { nome: "REALIZÁVEL A CURTO PRAZO", valor: 1000, filhos: [           // nível 1 (= grupo)
              { nome: "CRÉDITOS", valor: 700, filhos: [                          // nível 2 (agregado)
                { nome: "CLIENTES", valor: 400, filhos: [                        // nível 3 (mapeia)
                  { nome: "DUPLICATAS A RECEBER", valor: 400 },                  // nível 4 (mesmo destino → absorvido)
                ]},
                { nome: "TRIBUTOS", valor: 300, filhos: [                        // nível 3 (mapeia)
                  { nome: "IMPOSTOS A RECUPERAR", valor: 300, filhos: [          // nível 4 (mesmo destino)
                    { nome: "ICMS A RECUPERAR", valor: 180 },                    // nível 5 (folha)
                    { nome: "PIS A RECUPERAR", valor: 120 },                     // nível 5 (folha)
                  ]},
                ]},
              ]},
              { nome: "DISPONIBILIDADES", valor: 300, filhos: [
                { nome: "CAIXA GERAL", valor: 100 },
                { nome: "BANCOS CONTA CORRENTE", valor: 200 },
              ]},
            ]},
          ],
        },
      },
    } as any;
    const { bp, naoMapeados, alertasComposicao } = foldBP(arvore, ["2024"]);

    // Folhas/subárvores classificadas no nó semântico certo — nenhuma folha perdida
    expect(valorDe(bp, "Contas a Receber - CP", "2024")).toBeCloseTo(400, 1);
    expect(valorDe(bp, "Tributos a Recuperar - CP", "2024")).toBeCloseTo(300, 1);
    expect(valorDe(bp, "Caixa e Equivalentes de Caixa", "2024")).toBeCloseTo(300, 1);
    const ac = bp.find((l) => l.classificacao === "AC" && l.nivel === 1);
    expect(ac?.valores["2024"]).toBeCloseTo(1000, 1); // subtotal fecha com o declarado
    expect(somaInputs(bp, ["AC", "AF", "AO"], "2024")).toBeCloseTo(1000, 1); // composição fecha

    // Intermediários marcados estruturais em CADA nível da cadeia
    const realizavel = arvore["2024"].grupos["Ativo Circulante"][0];
    expect(realizavel.destino).toContain("estrutural");
    expect(realizavel.filhos[0].destino).toContain("estrutural"); // CRÉDITOS
    // Absorção preservada no nó semântico (mesma linha do modelo): filhos auditáveis
    expect(realizavel.filhos[0].filhos[1].filhos[0].filhos[0].destino).toContain("absorvido"); // ICMS sob IMPOSTOS A RECUPERAR
    expect(alertasComposicao.length).toBe(0);
    expect(naoMapeados.length).toBe(0);
  });

  it("intermediário-grupo SEM filhos capturados: valor vai p/ o balde VISÍVEL + âmbar (nunca some da composição)", () => {
    const arvore = {
      "2023": {
        grupos: {
          "Passivo Circulante": [{ nome: "EXIGÍVEL A CURTO PRAZO", valor: 500 }], // folha única
        },
      },
    } as any;
    const dict = [{ nomeOriginal: "Exigível a Curto Prazo", contaDestino: "Passivo Circulante", grupoConta: "Passivo Circulante" }];
    const { bp, naoMapeados } = foldBP(arvore, ["2023"], dict);
    const pc = bp.find((l) => l.classificacao === "PC" && l.nivel === 1);
    expect(pc?.valores["2023"]).toBeCloseTo(500, 1); // total nunca se perde
    // Antes: valor caía em detalhe["Passivo Circulante"] (chave que nenhuma linha lê) →
    // composição R$ 0 invisível. Agora: balde do grupo + âmbar para o analista.
    expect(valorDe(bp, "Outros Passivos Circulantes", "2023")).toBeCloseTo(500, 1);
    expect(naoMapeados.map((n) => n.nome)).toContain("EXIGÍVEL A CURTO PRAZO");
  });
});

describe("foldDRE — blindagem contextual (posição no documento × dicionário)", () => {
  const RECEITA = { nome: "RECEITA OPERACIONAL BRUTA", valor: 1000 };
  const arvoreCom = (paiNome: string) => ({
    "2023": [
      RECEITA,
      { nome: paiNome, filhos: [{ nome: "Combustíveis e Lubrificantes", valor: -100 }] }, // pai-cabeçalho SEM valor
    ],
  }) as any;
  const entradaDespesa = { nomeOriginal: "Combustíveis e Lubrificantes", contaDestino: "Outras Despesas Operacionais", grupoConta: "Outras Despesas Operacionais", tipo: "DRE" };
  const entradaCusto = { nomeOriginal: "Combustíveis e Lubrificantes", contaDestino: "Custo Operacional", grupoConta: "Custo Operacional", tipo: "DRE" };
  const val = (dre: any[], c: string) => dre.find((l) => l.conta === c)?.valores["2023"] ?? 0;

  it("cadastrada como despesa mas debaixo de CUSTOS → posição manda (Custo Operacional) + âmbar p/ confirmar", async () => {
    const { foldDRE } = await import("./ai-extraction");
    const { dre, naoMapeados } = foldDRE(arvoreCom("CUSTOS DE PRODUÇÃO"), ["2023"], [entradaDespesa]);
    expect(val(dre, "Custo Operacional")).toBeCloseTo(-100, 1);
    expect(val(dre, "Outras Despesas Operacionais")).toBeCloseTo(0, 1);
    expect(val(dre, "Lucro Bruto")).toBeCloseTo(900, 1);
    expect(naoMapeados.map((n) => n.nome)).toContain("Combustíveis e Lubrificantes"); // âmbar
    expect(naoMapeados[0]?.destino).toBe("Custo Operacional");
  });

  it("com as DUAS entradas contextuais no dicionário → escolhe a do bloco certo, SEM âmbar", async () => {
    const { foldDRE } = await import("./ai-extraction");
    const custos = foldDRE(arvoreCom("CUSTOS DE PRODUÇÃO"), ["2023"], [entradaDespesa, entradaCusto]);
    expect(val(custos.dre, "Custo Operacional")).toBeCloseTo(-100, 1);
    expect(custos.naoMapeados.length).toBe(0);
    const despesas = foldDRE(arvoreCom("DESPESAS OPERACIONAIS COM VEÍCULOS"), ["2023"], [entradaDespesa, entradaCusto]);
    expect(val(despesas.dre, "Outras Despesas Operacionais")).toBeCloseTo(-100, 1);
    expect(val(despesas.dre, "Custo Operacional")).toBeCloseTo(0, 1);
    expect(despesas.naoMapeados.length).toBe(0);
  });

  it("REGRESSÃO: debaixo de bloco de despesas, a entrada de despesa aplica em silêncio (como antes)", async () => {
    const { foldDRE } = await import("./ai-extraction");
    const { dre, naoMapeados } = foldDRE(arvoreCom("DESPESAS OPERACIONAIS COM VEÍCULOS"), ["2023"], [entradaDespesa]);
    expect(val(dre, "Outras Despesas Operacionais")).toBeCloseTo(-100, 1);
    expect(naoMapeados.length).toBe(0);
  });

  it("REGRESSÃO: caminho neutro (não declara custo nem despesa) → dicionário aplica como antes", async () => {
    const { foldDRE } = await import("./ai-extraction");
    const { dre, naoMapeados } = foldDRE(arvoreCom("GASTOS GERAIS XPTO"), ["2023"], [entradaDespesa]);
    expect(val(dre, "Outras Despesas Operacionais")).toBeCloseTo(-100, 1);
    expect(naoMapeados.length).toBe(0);
  });
});

describe("DRE — bridge do modelo do banco (conta adicionada pelo usuário)", () => {
  it("'Despesas com Pessoas' entra no fold e na cascata do Lucro Líquido (bloco EBITDA)", async () => {
    const { foldDRE } = await import("./ai-extraction");
    const { buildDREModel } = await import("./model-version");
    const { DRE_TEMPLATE } = await import("./financial-templates");
    // Modelo do banco = template + "Despesas com Pessoas" inserida no bloco operacional
    const lines = DRE_TEMPLATE.map((t) => ({ conta: t.conta, subtotal: t.subtotal }));
    const idx = lines.findIndex((l) => l.conta === "Despesas Gerais e Administrativas");
    lines.splice(idx + 1, 0, { conta: "Despesas com Pessoas", subtotal: false });
    const model = buildDREModel(lines);
    expect(model.inputs.has("Despesas com Pessoas")).toBe(true);
    expect(model.extrasPorBloco["EBITDA"]).toContain("Despesas com Pessoas");

    const arvore = {
      "2023": [
        { nome: "RECEITA OPERACIONAL BRUTA", valor: 1000 },
        { nome: "FOLHA E ENCARGOS XPTO", valor: -200 }, // classificada p/ a conta nova via dicionário
      ],
    } as any;
    const dict = [{ nomeOriginal: "FOLHA E ENCARGOS XPTO", contaDestino: "Despesas com Pessoas", grupoConta: "Despesas com Pessoas" }];
    const { dre } = foldDRE(arvore, ["2023"], dict, model);
    const val = (c: string) => dre.find((l) => l.conta === c)?.valores["2023"] ?? 0;
    expect(val("Despesas com Pessoas")).toBeCloseTo(-200, 1); // linha existe e recebeu o valor
    expect(val("EBITDA")).toBeCloseTo(800, 1);                // entrou na cascata
    expect(val("Lucro Líquido")).toBeCloseTo(800, 1);         // fluiu até o LL
  });
});
