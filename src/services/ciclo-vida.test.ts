import { describe, it, expect } from "vitest";
import { cicloVidaAnalysis, etapaAnalysis, cicloVidaModel, rotuloCiclo } from "./ciclo-vida";

describe("ciclo de vida unificado (derivado — zero retrocesso)", () => {
  it("IBR: desfechos mapeiam para o ciclo comum (gênero normalizado)", () => {
    expect(cicloVidaAnalysis("Concluída")).toBe("Concluído");
    expect(cicloVidaAnalysis("Cancelada")).toBe("Cancelado");
  });

  it("IBR: TODA etapa de processamento é 'Em produção' — nenhuma cai fora", () => {
    for (const s of ["Rascunho", "Extraindo", "Revisão necessária", "Pronta para gerar", "Gerando diagnóstico", "Erro", "Interrompida"]) {
      expect(cicloVidaAnalysis(s)).toBe("Em produção");
      expect(etapaAnalysis(s)).toBe(s); // a etapa preserva o status granular
    }
  });

  it("IBR: desfecho não tem etapa (concluído não está 'fazendo' nada)", () => {
    expect(etapaAnalysis("Concluída")).toBeNull();
    expect(etapaAnalysis("Cancelada")).toBeNull();
  });

  it("modelos: ciclo direto; 'Rascunho' legado conta como Em produção (regra do PUT /status)", () => {
    expect(cicloVidaModel("Em produção")).toBe("Em produção");
    expect(cicloVidaModel("Concluído")).toBe("Concluído");
    expect(cicloVidaModel("Cancelado")).toBe("Cancelado");
    expect(cicloVidaModel("Rascunho")).toBe("Em produção");
  });

  it("rótulo compacto junta ciclo e etapa", () => {
    expect(rotuloCiclo("Em produção", "Extraindo")).toBe("Em produção · Extraindo");
    expect(rotuloCiclo("Concluído", null)).toBe("Concluído");
  });
});
