import { describe, expect, it } from "vitest";
import { regimeEcfDoCnpjData, sugerirRegimeTributario } from "./regime-ecf";

const linha = (ano: number, forma: string) => ({ ano, cnpj_da_scp: null, forma_de_tributacao: forma, quantidade_de_escrituracoes: 1 });

describe("regimeEcfDoCnpjData", () => {
  it("pega o ano-calendário mais recente e mapeia Real/Presumido para o valor do select", () => {
    const d = { regime_tributario: [linha(2022, "LUCRO PRESUMIDO"), linha(2024, "LUCRO REAL"), linha(2023, "LUCRO REAL")] };
    expect(regimeEcfDoCnpjData(d)).toEqual({ ano: 2024, forma: "LUCRO REAL", sugerido: "Lucro Real" });
  });

  it("LUCRO ARBITRADO aparece na leitura mas NÃO vira sugestão (fora do select)", () => {
    const d = { regime_tributario: [linha(2023, "LUCRO ARBITRADO")] };
    expect(regimeEcfDoCnpjData(d)).toEqual({ ano: 2023, forma: "LUCRO ARBITRADO", sugerido: null });
  });

  it("normaliza forma para maiúsculas e ignora linhas sem ano ou sem forma", () => {
    const d = { regime_tributario: [linha(2021, "lucro presumido"), { ano: "x", forma_de_tributacao: "LUCRO REAL" }, { ano: 2024 }] };
    expect(regimeEcfDoCnpjData(d)).toEqual({ ano: 2021, forma: "LUCRO PRESUMIDO", sugerido: "Lucro Presumido" });
  });

  it("devolve null sem o campo (ReceitaWS), com array vazio ou com cnpjData nulo", () => {
    expect(regimeEcfDoCnpjData({ razao_social: "X" })).toBeNull();
    expect(regimeEcfDoCnpjData({ regime_tributario: [] })).toBeNull();
    expect(regimeEcfDoCnpjData(null)).toBeNull();
    expect(regimeEcfDoCnpjData(undefined)).toBeNull();
  });
});

describe("sugerirRegimeTributario", () => {
  it("flags atuais de MEI/Simples vencem a ECF (histórico)", () => {
    const base = { regime_tributario: [linha(2024, "LUCRO REAL")] };
    expect(sugerirRegimeTributario({ ...base, opcao_pelo_mei: true })).toEqual({ valor: "MEI", fonte: "Receita Federal (cadastro CNPJ)" });
    expect(sugerirRegimeTributario({ ...base, opcao_pelo_simples: true })).toEqual({ valor: "Simples Nacional", fonte: "Receita Federal (cadastro CNPJ)" });
  });

  it("sem flags, sugere pela ECF com o ano no carimbo da fonte", () => {
    const d = { opcao_pelo_simples: false, regime_tributario: [linha(2024, "LUCRO PRESUMIDO")] };
    expect(sugerirRegimeTributario(d)).toEqual({ valor: "Lucro Presumido", fonte: "Receita Federal/ECF, ano-calendário 2024" });
  });

  it("sem flags e sem ECF aproveitável, devolve null (nada é inventado)", () => {
    expect(sugerirRegimeTributario({ opcao_pelo_simples: false })).toBeNull();
    expect(sugerirRegimeTributario({ regime_tributario: [linha(2023, "LUCRO ARBITRADO")] })).toBeNull();
  });
});
