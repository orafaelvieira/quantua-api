import { describe, it, expect } from "vitest";
import { classificarDeParaOrcamento, opcoesDeParaOrcamento } from "./classificar-de-para-orcamento";

/**
 * Só o caminho DETERMINÍSTICO (comIa: false) — a passada de IA é best-effort e
 * não entra em teste de unidade (sem rede). O contrato aqui: linha de gasto
 * nunca aponta para canônica de receita, e o que a regra não resolve volta
 * como pendência, nunca chutado.
 */

const CANONICAS = [
  "Receita Bruta", "Deduções da Receita Bruta", "Receitas Financeiras",
  "Impostos s/ Faturamento",
  "Custo Operacional", "Custos com Pessoas (MOD)",
  "Despesas com Pessoas", "Despesas com Viagens e Estadias", "Despesas Financeiras",
];

describe("classificarDeParaOrcamento (determinístico)", () => {
  it("opções excluem TODA canônica de receita (inclusive Deduções)", () => {
    expect(opcoesDeParaOrcamento(CANONICAS)).toEqual([
      "Impostos s/ Faturamento",
      "Custo Operacional", "Custos com Pessoas (MOD)",
      "Despesas com Pessoas", "Despesas com Viagens e Estadias", "Despesas Financeiras",
    ]);
  });

  /** CASO REAL (30/07/2026 — plano MOVE FARMA): ICMS/PIS/COFINS têm regra, mas
   *  "ISQN s/serviços" (grafia corrente de ISSQN) ficava sem sugestão; "Variação
   *  Cambial Ativa" caía na IA e virou "Despesas com Pessoas"; "Rendimentos de
   *  Aplicação" ficava pendente. Regra determinística ANTES da IA. */
  it("tributos, cambial e rendimentos resolvem por regra (caso MOVE FARMA)", async () => {
    const r = await classificarDeParaOrcamento(
      [
        { id: "icms", nome: "ICMS", grupo: "despesa" },
        { id: "isqn", nome: "ISQN s/serviços", grupo: "despesa" },
        { id: "vca", nome: "Variação Cambial Ativa", grupo: "despesa" },
        { id: "rend", nome: "Rendimentos de Aplicação", grupo: "despesa" },
        { id: "ja", nome: "Juros Ativos", grupo: "despesa" },
      ],
      CANONICAS,
      { comIa: false },
    );
    const conta = (id: string) => r.classificadas.find((c) => c.id === id)?.conta;
    expect(conta("icms")).toBe("Impostos s/ Faturamento");
    expect(conta("isqn")).toBe("Impostos s/ Faturamento");
    expect(conta("vca")).toBe("Despesas Financeiras");
    expect(conta("rend")).toBe("Despesas Financeiras");
    expect(conta("ja")).toBe("Despesas Financeiras");
    expect(r.classificadas.every((c) => c.via === "regra")).toBe(true);
    expect(r.semSugestao).toEqual([]);
  });

  /** VOCABULÁRIO DO PLANO GERENCIAL (30/07/2026 — nomes REAIS do MOVE FARMA
   *  que ficavam "sem grupo"): a importação tem de resolver o grosso por
   *  REGRA, sem depender da IA. Canônicas do modelo padrão (DRE_TEMPLATE). */
  it("o plano gerencial típico resolve por regra (amostra MOVE FARMA)", async () => {
    const CANON = [
      "Receita Bruta", "Deduções da Receita Bruta", "Impostos s/ Faturamento",
      "Custo Operacional", "Custos com Pessoas (MOD)",
      "Despesas com Pessoas", "Despesas Gerais e Administrativas",
      "Despesas com Aluguel, Condomínio e IPTU", "Despesas com Energia, Água, Telefone e Internet",
      "Despesas com Sistemas e Softwares", "Despesas com Limpeza, Manutenção e Reparos",
      "Despesas com Viagens e Estadias", "Despesas com Veículos", "Despesas com Seguros",
      "Despesas com Fretes", "Despesas Taxas, Tributos e Contribuições", "Despesas com Terceiros",
      "Despesas com Vendas", "Despesas com Marketing", "Despesas com P&D",
      "Outras Receitas Operacionais", "Outras Despesas Operacionais",
      "Depreciação e Amortização", "Receitas Financeiras", "Despesas Financeiras",
      "Outras Receitas Não Operacionais", "Outras Despesas Não Operacionais", "IR e CSLL",
    ];
    const CASOS: Array<[string, "custo" | "despesa", string]> = [
      ["Horas extras", "despesa", "Despesas com Pessoas"],
      ["Gratificações", "despesa", "Despesas com Pessoas"],
      ["Adicional noturno", "despesa", "Despesas com Pessoas"],
      ["PPR - Participação nos Resultados", "despesa", "Despesas com Pessoas"],
      ["Alimentacao do Trabalhador", "despesa", "Despesas com Pessoas"],
      ["Assistência Médica e Social", "despesa", "Despesas com Pessoas"],
      ["Uniformes", "despesa", "Despesas com Pessoas"],
      ["Equipamentos e Protecao Individual", "despesa", "Despesas com Pessoas"],
      ["Exame Admissional/Demissional", "despesa", "Despesas com Pessoas"],
      ["Ajuda de Custo", "despesa", "Despesas com Pessoas"],
      ["Reembolso Despesas Funcionarios", "despesa", "Despesas com Pessoas"],
      ["Confraternizações", "despesa", "Despesas com Pessoas"],
      ["Despesas médicas", "despesa", "Despesas com Pessoas"],
      ["Serviço de comunicação", "despesa", "Despesas com Energia, Água, Telefone e Internet"],
      ["Serviços de Terceiros - Pessoa Jurídica", "despesa", "Despesas com Terceiros"],
      ["Segurança e Vigilância", "despesa", "Despesas com Terceiros"],
      ["Licenciamento/IPVA", "despesa", "Despesas com Veículos"],
      ["Despesas com Aeronave", "despesa", "Despesas com Veículos"],
      ["Despesas com Corretagem", "despesa", "Despesas com Vendas"],
      ["Condução", "despesa", "Despesas com Viagens e Estadias"],
      ["Correios e Malotes", "despesa", "Despesas Gerais e Administrativas"],
      ["Bens de pequeno valor", "despesa", "Despesas Gerais e Administrativas"],
      ["Assinaturas", "despesa", "Despesas Gerais e Administrativas"],
      ["Compra de Semente", "custo", "Custo Operacional"],
      ["(-) Devolução de Compras - Exportação", "custo", "Custo Operacional"],
      ["(-) Remessa/Retorno Armázem geral", "custo", "Custo Operacional"],
      ["ICMS sobre Compras", "custo", "Custo Operacional"],
      ["Ganho NDF - Contratos em aberto", "despesa", "Despesas Financeiras"],
      ["Perdas Commodities - Contratos realizados", "despesa", "Despesas Financeiras"],
      ["Descontos Obtidos", "despesa", "Despesas Financeiras"],
      ["Despesa com Perdão de Divida", "despesa", "Despesas Financeiras"],
      ["Provisão P/ IRPJ", "despesa", "IR e CSLL"],
      ["Provisão P/ Contribuição Social", "despesa", "IR e CSLL"],
      ["Multas e Juros s/ Tributos", "despesa", "Despesas Taxas, Tributos e Contribuições"],
      ["Alvará", "despesa", "Despesas Taxas, Tributos e Contribuições"],
      ["Taxas Diversas", "despesa", "Despesas Taxas, Tributos e Contribuições"],
      ["Despesas com Cartório", "despesa", "Despesas Taxas, Tributos e Contribuições"],
      ["Sindicato patronal/associação de classe", "despesa", "Despesas Taxas, Tributos e Contribuições"],
      ["Perdas com estoque", "despesa", "Outras Despesas Operacionais"],
      ["Doações", "despesa", "Outras Despesas Operacionais"],
    ];
    const r = await classificarDeParaOrcamento(
      CASOS.map(([nome, grupo], i) => ({ id: String(i), nome, grupo })),
      CANON,
      { comIa: false },
    );
    const erros: string[] = [];
    CASOS.forEach(([nome, , esperado], i) => {
      const hit = r.classificadas.find((c) => c.id === String(i));
      if (hit?.conta !== esperado) erros.push(`${nome}: esperava "${esperado}", veio "${hit?.conta ?? "(sem sugestão)"}"`);
    });
    expect(erros).toEqual([]);
    expect(r.classificadas.every((c) => c.via === "regra")).toBe(true);
  });

  it("'Custos sobre a receita' NUNCA cai em Receita Bruta — resolve em Custo Operacional", async () => {
    const r = await classificarDeParaOrcamento(
      [{ id: "a", nome: "Custos sobre a receita", grupo: "custo" }],
      CANONICAS,
      { comIa: false },
    );
    expect(r.classificadas.find((c) => c.id === "a")?.conta).toBe("Custo Operacional");
    expect(r.custo).toBeNull();
  });

  it("a regra resolve os óbvios sem gastar IA", async () => {
    const r = await classificarDeParaOrcamento(
      [
        { id: "v", nome: "Despesas com Viagens", grupo: "despesa" },
        { id: "t", nome: "Tarifas bancárias", grupo: "despesa" },
        { id: "z", nome: "Zebra", grupo: "despesa" },
      ],
      CANONICAS,
      { comIa: false },
    );
    expect(r.classificadas.find((c) => c.id === "v")?.conta).toBe("Despesas com Viagens e Estadias");
    expect(r.classificadas.find((c) => c.id === "t")?.conta).toBe("Despesas Financeiras");
    expect(r.classificadas.every((c) => c.via === "regra")).toBe(true);
    expect(r.semSugestao).toEqual(["Zebra"]);
  });
});
