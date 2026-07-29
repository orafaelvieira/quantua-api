import { describe, it, expect } from "vitest";
import { sugerirContaCanonica } from "./sugerir-conta-canonica";

/**
 * O de-para tem que ser ÚTIL sem ser adivinhão: acerta o que é óbvio para um
 * contador, admite que não sabe no resto (null) e nunca inventa conta fora da
 * lista do modelo.
 */

const CANONICAS = [
  "Custo Operacional",
  "Custos com Pessoas (MOD)",
  "Despesas com Pessoas",
  "Despesas com Aluguel, Condomínio e IPTU",
  "Despesas com Utilidades (Energia, Água, Telefonia)",
  "Despesas com Fretes e Logística",
  "Despesas Comerciais e Marketing",
  "Despesas com Serviços de Terceiros",
  "Despesas com Veículos e Frota",
  "Depreciação e Amortização",
];

describe("sugerirContaCanonica", () => {
  it("nome igual ao da canônica é certeza", () => {
    const s = sugerirContaCanonica("custo operacional", CANONICAS);
    expect(s?.conta).toBe("Custo Operacional");
    expect(s?.base).toBe("exata");
    expect(s?.confianca).toBe(1);
  });

  it("vocabulário contábil: folha, benefício, ocupação, utilidades", () => {
    expect(sugerirContaCanonica("Salários e encargos (Comercial)", CANONICAS)?.conta).toBe("Despesas com Pessoas");
    expect(sugerirContaCanonica("Vale transporte", CANONICAS)?.conta).toBe("Despesas com Pessoas");
    // A MESMA folha, do lado da produção, vai para o custo (MOD).
    expect(sugerirContaCanonica("Salários e encargos (Operações)", CANONICAS)?.conta).toBe("Custos com Pessoas (MOD)");
    expect(sugerirContaCanonica("Salários e encargos", CANONICAS, { grupo: "custo" })?.conta).toBe("Custos com Pessoas (MOD)");
    expect(sugerirContaCanonica("Salários e encargos", CANONICAS, { grupo: "despesa" })?.conta).toBe("Despesas com Pessoas");
    expect(sugerirContaCanonica("Aluguel do galpão", CANONICAS)?.conta).toBe("Despesas com Aluguel, Condomínio e IPTU");
    expect(sugerirContaCanonica("Energia elétrica", CANONICAS)?.conta).toBe("Despesas com Utilidades (Energia, Água, Telefonia)");
    expect(sugerirContaCanonica("Telefonia e internet", CANONICAS)?.conta).toBe("Despesas com Utilidades (Energia, Água, Telefonia)");
  });

  it("cobre os nomes que aparecem num plano de contas de verdade", () => {
    const casos: Array<[string, string]> = [
      ["Fretes sobre vendas", "Despesas com Fretes e Logística"],
      ["Publicidade e propaganda", "Despesas Comerciais e Marketing"],
      ["Honorários contábeis e jurídicos", "Despesas com Serviços de Terceiros"],
      ["Combustível da frota", "Despesas com Veículos e Frota"],
      ["Depreciação de máquinas", "Depreciação e Amortização"],
      ["Matéria-prima consumida", "Custo Operacional"],
    ];
    for (const [entrada, esperada] of casos) {
      expect(sugerirContaCanonica(entrada, CANONICAS)?.conta, entrada).toBe(esperada);
    }
  });

  it("devolve null quando não dá para saber — nunca chuta", () => {
    expect(sugerirContaCanonica("Conta 4.1.99", CANONICAS)).toBeNull();
    expect(sugerirContaCanonica("Zebra", CANONICAS)).toBeNull();
    expect(sugerirContaCanonica("", CANONICAS)).toBeNull();
  });

  it("só sugere conta que EXISTE no modelo da empresa", () => {
    // Modelo enxuto: não tem conta de pessoas — a regra de folha não se aplica.
    const enxuto = ["Custo Operacional", "Despesas Operacionais"];
    expect(sugerirContaCanonica("Salários e encargos", enxuto)).toBeNull();
    // E jamais devolve algo fora da lista.
    const s = sugerirContaCanonica("Energia elétrica", enxuto);
    expect(s === null || enxuto.includes(s.conta)).toBe(true);
  });

  it("é determinístico: mesma entrada, mesma saída", () => {
    const a = sugerirContaCanonica("Comissões sobre vendas", CANONICAS);
    const b = sugerirContaCanonica("Comissões sobre vendas", CANONICAS);
    expect(a).toEqual(b);
  });

  // Os casos que o usuário flagrou no modelo baixado (28/07/2026): contas do
  // catálogo padrão sem de-para ou com de-para ERRADO. Canônicas do DRE real.
  const DRE_REAL = [
    "Custo Operacional", "Custos com Pessoas (MOD)", "Despesas com Pessoas",
    "Despesas Gerais e Administrativas", "Despesas com Aluguel, Condomínio e IPTU",
    "Despesas com Energia, Água, Telefone e Internet", "Despesas com Sistemas e Softwares",
    "Despesas com Limpeza, Manutenção e Reparos", "Despesas com Viagens e Estadias",
    "Despesas com Veículos", "Despesas com Seguros", "Despesas com Fretes",
    "Despesas Taxas, Tributos e Contribuições", "Despesas com Terceiros",
    "Despesas com Vendas", "Despesas com Marketing", "Despesas com P&D",
    "Despesas Financeiras",
  ];

  it("'Despesas com cobrança' NUNCA cai em P&D pelo {despesas} — vai para Financeiras", () => {
    const s = sugerirContaCanonica("Despesas com cobrança", DRE_REAL);
    expect(s?.conta).not.toBe("Despesas com P&D");
    expect(s?.conta).toBe("Despesas Financeiras");
  });

  it("contas do Financeiro que ficavam sem de-para vão para Despesas Financeiras", () => {
    expect(sugerirContaCanonica("Tarifas bancárias", DRE_REAL)?.conta).toBe("Despesas Financeiras");
    expect(sugerirContaCanonica("Taxas de cartão e meios de pagamento", DRE_REAL)?.conta).toBe("Despesas Financeiras");
  });

  it("brindes, agência de conteúdo e medicina do trabalho ganham de-para", () => {
    expect(sugerirContaCanonica("Brindes e amostras", DRE_REAL)?.conta).toBe("Despesas com Marketing");
    expect(sugerirContaCanonica("Agência e produção de conteúdo", DRE_REAL)?.conta).toBe("Despesas com Marketing");
    expect(sugerirContaCanonica("Medicina e segurança do trabalho", DRE_REAL)?.conta).toBe("Despesas com Pessoas");
  });

  it("agregados genéricos dos modelos antigos resolvem por regra, não por IA", () => {
    expect(sugerirContaCanonica("Custos sobre a receita", DRE_REAL, { grupo: "custo" })?.conta).toBe("Custo Operacional");
    expect(sugerirContaCanonica("Despesas operacionais", DRE_REAL)?.conta).toBe("Despesas Gerais e Administrativas");
  });

  it("comissão sem canônica própria cai em Despesas com Vendas; veículos vence manutenção", () => {
    expect(sugerirContaCanonica("Comissões sobre vendas", DRE_REAL)?.conta).toBe("Despesas com Vendas");
    // "Veículos (combustível e manutenção)" é frota — a regra de manutenção não
    // pode atropelar (a ordem das regras decide).
    expect(sugerirContaCanonica("Veículos (combustível e manutenção)", DRE_REAL)?.conta).toBe("Despesas com Veículos");
  });

  it("ignora acento e caixa", () => {
    const a = sugerirContaCanonica("ENERGIA ELETRICA", CANONICAS);
    const b = sugerirContaCanonica("energia elétrica", CANONICAS);
    expect(a?.conta).toBe(b?.conta);
  });
});
