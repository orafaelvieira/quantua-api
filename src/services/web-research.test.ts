/** Parser dos pares-via-web (setor sem par B3). Só a lógica pura (sem rede). */
import { describe, it, expect } from "vitest";
import { parseWebParesJson } from "./web-research";

const POL = new Map<string, boolean>([
  ["Margem Bruta", true],
  ["Margem Líquida", true],
  ["Dívida Líquida/EBITDA", false],
  ["Prazo Médio Estoque", false],
]);

describe("parseWebParesJson", () => {
  it("extrai refs válidas de um bloco JSON (com texto ao redor)", () => {
    const txt = `Segue a referência:
\`\`\`json
[{"indicador":"Margem Bruta","valor":0.32},{"indicador":"Dívida Líquida/EBITDA","valor":2.1}]
\`\`\`
Fontes: ...`;
    const refs = parseWebParesJson(txt, POL);
    expect(refs.map((r) => r.indicador)).toEqual(["Margem Bruta", "Dívida Líquida/EBITDA"]);
    expect(refs[0].referencia).toBe(0.32);
    expect(refs[0].higherIsBetter).toBe(true);
    expect(refs[1].higherIsBetter).toBe(false);
    expect(refs[0].fonte).toContain("confiança baixa");
  });

  it("ignora indicadores desconhecidos, valores não-numéricos e absurdos", () => {
    const txt = `[
      {"indicador":"Indicador Inventado","valor":1},
      {"indicador":"Margem Líquida","valor":"n/d"},
      {"indicador":"Prazo Médio Estoque","valor":45},
      {"indicador":"Margem Bruta","valor":999999}
    ]`;
    const refs = parseWebParesJson(txt, POL);
    expect(refs.map((r) => r.indicador)).toEqual(["Prazo Médio Estoque"]);
    expect(refs[0].referencia).toBe(45);
  });

  it("deduplica indicador repetido (fica a 1ª ocorrência)", () => {
    const refs = parseWebParesJson(`[{"indicador":"Margem Bruta","valor":0.3},{"indicador":"Margem Bruta","valor":0.5}]`, POL);
    expect(refs).toHaveLength(1);
    expect(refs[0].referencia).toBe(0.3);
  });

  it("retorna vazio quando não há JSON ou é inválido", () => {
    expect(parseWebParesJson("sem json aqui", POL)).toEqual([]);
    expect(parseWebParesJson("[isto não é json]", POL)).toEqual([]);
  });
});
