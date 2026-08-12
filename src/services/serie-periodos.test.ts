/**
 * O caso que o dono deu é o primeiro teste: "2022, 2025 e junho/2026" precisa
 * reprovar, e "2024, 2025, junho/2026" precisa PASSAR — porque balancete
 * mensal é acumulado no ano e junho cobre desde 1º de janeiro. Errar para o
 * lado severo (recusar série boa) é tão ruim quanto errar para o frouxo:
 * o analista perde histórico que ele TEM.
 */
import { describe, it, expect } from "vitest";
import { avaliarSerie, trechoContinuoMaisRecente, intervaloDaColuna, type ColunaSerie } from "./serie-periodos";

const anual = (ano: number): ColunaSerie => ({ periodo: `31/12/${ano}`, tipo: "exercicio", inicio: `01/01/${ano}`, fim: `31/12/${ano}` });
const ytd = (mes: number, ano: number): ColunaSerie => ({
  periodo: `${String(new Date(Date.UTC(ano, mes, 0)).getUTCDate()).padStart(2, "0")}/${String(mes).padStart(2, "0")}/${ano}`,
  tipo: "mes",
  inicio: `01/01/${ano}`,
  fim: `${String(new Date(Date.UTC(ano, mes, 0)).getUTCDate()).padStart(2, "0")}/${String(mes).padStart(2, "0")}/${ano}`,
});

describe("o caso do dono", () => {
  it("REPROVA 2022, 2025 e junho/2026 — dois anos de buraco", () => {
    const r = avaliarSerie([anual(2022), anual(2025), ytd(6, 2026)]);
    expect(r.ok).toBe(false);
    expect(r.lacunas).toHaveLength(1);
    expect(r.lacunas[0]!.rotulo).toBe("2023 a 2024");
    expect(r.motivos[0]).toContain("2023 a 2024");
  });

  it("APROVA 2024, 2025 e junho/2026 — o mês acumulado emenda no ano anterior", () => {
    const r = avaliarSerie([anual(2024), anual(2025), ytd(6, 2026)]);
    expect(r.ok).toBe(true);
    expect(r.ordenada).toEqual(["31/12/2024", "31/12/2025", "30/06/2026"]);
    expect(r.cobertura).toEqual({ de: "01/01/2024", ate: "30/06/2026" });
  });
});

describe("continuidade", () => {
  it("anos consecutivos passam", () => expect(avaliarSerie([anual(2023), anual(2024), anual(2025)]).ok).toBe(true));

  it("ano faltando no meio reprova e nomeia o ano", () => {
    const r = avaliarSerie([anual(2023), anual(2025)]);
    expect(r.ok).toBe(false);
    expect(r.lacunas[0]!.rotulo).toBe("2024");
  });

  it("meses acumulados ANINHADOS não abrem buraco (03 e 06 do mesmo ano)", () => {
    expect(avaliarSerie([ytd(3, 2026), ytd(6, 2026)]).ok).toBe(true);
  });

  it("ano inteiro pulado entre o último exercício e o mês reprova", () => {
    const r = avaliarSerie([anual(2024), ytd(6, 2026)]);
    expect(r.ok).toBe(false);
    expect(r.lacunas[0]!.rotulo).toBe("2025");
  });

  it("uma coluna só nunca tem buraco", () => expect(avaliarSerie([anual(2025)]).ok).toBe(true));
  it("nenhuma coluna não quebra a função", () => {
    const r = avaliarSerie([]);
    expect(r.ok).toBe(true);
    expect(r.cobertura).toBeNull();
  });

  it("ordem de entrada não importa", () => {
    expect(avaliarSerie([ytd(6, 2026), anual(2024), anual(2025)]).ok).toBe(true);
  });

  it("sobreposição de fontes (BP anual 2025 + balancete 12/2025) não é buraco", () => {
    const r = avaliarSerie([anual(2024), anual(2025), ytd(12, 2025)]);
    expect(r.ok).toBe(true);
  });

  it("balancete de MOVIMENTO (não acumulado) em meses seguidos passa", () => {
    const jan: ColunaSerie = { periodo: "31/01/2026", tipo: "mes", inicio: "01/01/2026", fim: "31/01/2026" };
    const fev: ColunaSerie = { periodo: "28/02/2026", tipo: "mes", inicio: "01/02/2026", fim: "28/02/2026" };
    expect(avaliarSerie([jan, fev]).ok).toBe(true);
  });

  it("mês pulado em série de movimento reprova com o nome do mês", () => {
    const jan: ColunaSerie = { periodo: "31/01/2026", tipo: "mes", inicio: "01/01/2026", fim: "31/01/2026" };
    const abr: ColunaSerie = { periodo: "30/04/2026", tipo: "mes", inicio: "01/04/2026", fim: "30/04/2026" };
    const r = avaliarSerie([jan, abr]);
    expect(r.ok).toBe(false);
    expect(r.lacunas[0]!.rotulo).toBe("fevereiro a março de 2026");
  });

  it("coluna sem intervalo declarado assume o ano cheio da data-chave", () => {
    const iv = intervaloDaColuna({ periodo: "31/12/2025", tipo: "exercicio" })!;
    expect(iv.inicio.toISOString().slice(0, 10)).toBe("2025-01-01");
  });

  it("período em formato desconhecido é ignorado em vez de derrubar a avaliação", () => {
    const r = avaliarSerie([{ periodo: "2025", tipo: "exercicio" }, anual(2026)]);
    expect(r.ok).toBe(true);
    expect(r.ordenada).toEqual(["31/12/2026"]);
  });
});

describe("trecho contínuo mais recente (o clique de resgate)", () => {
  it("descarta o que está antes do último buraco", () => {
    expect(trechoContinuoMaisRecente([anual(2022), anual(2025), ytd(6, 2026)])).toEqual(["31/12/2025", "30/06/2026"]);
  });

  it("série inteira quando já é contínua", () => {
    expect(trechoContinuoMaisRecente([anual(2024), anual(2025)])).toEqual(["31/12/2024", "31/12/2025"]);
  });
});
