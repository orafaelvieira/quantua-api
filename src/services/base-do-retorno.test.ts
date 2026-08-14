import { describe, expect, it } from "vitest";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { avaliarBaseDoRetorno } from "./base-do-retorno";

const P = "31/12/2024";
const bpL = (conta: string, v: number, classificacao = "AT", nivel = 0): BPLineItem => ({
  classificacao, conta, nivel, editado: false, valores: { [P]: v },
});
const dreL = (conta: string, v: number): DRELineItem => ({ conta, subtotal: true, editado: false, valores: { [P]: v } });

describe("avaliarBaseDoRetorno — ROE/ROA só significam algo com denominador real", () => {
  it("caso DUNAMYS: PL de ~R$ 0,9 mi para receita de R$ 9,0 mi acende o alerta", () => {
    const r = avaliarBaseDoRetorno(
      [bpL("Ativo Total", 1_105_000), bpL("Patrimônio Líquido", 924_000, "PL", 1)],
      [dreL("Receita Líquida", 8_972_003)],
      P,
    );
    expect(r.roeInflado).toBe(true);
    expect(r.roaInflado).toBe(true);
    expect(r.alerta).toContain("10,3% da receita");
    // A regra que impede o "melhor que os pares" precisa viajar junto do número.
    expect(r.alerta).toMatch(/N[ÃA]O trate ROE\/ROA/i);
    expect(r.alerta).toMatch(/melhor que os pares/i);
  });

  it("empresa com patrimônio real não acende nada (o alerta é exceção, não regra)", () => {
    const r = avaliarBaseDoRetorno(
      [bpL("Ativo Total", 40_000_000), bpL("Patrimônio Líquido", 18_000_000, "PL", 1)],
      [dreL("Receita Líquida", 45_200_000)],
      P,
    );
    expect(r.roeInflado).toBe(false);
    expect(r.roaInflado).toBe(false);
    expect(r.alerta).toBe("");
  });

  it("serviço com ativo leve mas patrimônio saudável alerta SÓ o ROA", () => {
    const r = avaliarBaseDoRetorno(
      [bpL("Ativo Total", 1_500_000), bpL("Patrimônio Líquido", 1_400_000, "PL", 1)],
      [dreL("Receita Líquida", 8_000_000)],
      P,
    );
    expect(r.roeInflado).toBe(false); // PL = 17,5% da receita
    expect(r.roaInflado).toBe(true); // ativo = 18,8% da receita
    expect(r.alerta).toContain("baixo ativo");
    expect(r.alerta).not.toContain("patrimônio líquido equivale");
  });

  it("PL gravado com sinal invertido não vira falso alerta (mede magnitude)", () => {
    const r = avaliarBaseDoRetorno(
      [bpL("Ativo Total", 40_000_000), bpL("Patrimônio Líquido", -18_000_000, "PL", 1)],
      [dreL("Receita Líquida", 45_200_000)],
      P,
    );
    expect(r.roeInflado).toBe(false);
    expect(r.plNegativo).toBe(true); // registrado, para quem quiser usar
  });

  it("sem receita no período não há base para medir — devolve vazio", () => {
    const r = avaliarBaseDoRetorno([bpL("Ativo Total", 100)], [dreL("Receita Líquida", 0)], P);
    expect(r.alerta).toBe("");
    expect(r.plSobreReceita).toBeNull();
  });
});
