/**
 * CICLO DE VIDA UNIFICADO dos produtos (decisão do usuário, 21/07/2026).
 *
 * Os 4 produtos (IBR, Valuation, Orçamento, Business Plan) respondem ao MESMO
 * ciclo comercial: Em produção → Concluído → Cancelado. O que a máquina está
 * fazendo num IBR (extraindo, aguardando revisão, gerando…) é OUTRA pergunta —
 * a ETAPA de processamento.
 *
 * Estratégia de migração ZERO-RETROCESSO: nada muda no banco. O ciclo é
 * DERIVADO do status atual por função pura — sem coluna nova, sem backfill,
 * sem dupla fonte de verdade. Guardas, filtros e telas existentes continuam
 * lendo `status` como sempre; as telas novas exibem `cicloVida` + `etapa`
 * computados nos payloads.
 */

export type CicloVida = "Em produção" | "Concluído" | "Cancelado";

/** IBR: status → ciclo comercial. Tudo que não é desfecho é produção. */
export function cicloVidaAnalysis(status: string): CicloVida {
  if (status === "Concluída") return "Concluído";
  if (status === "Cancelada") return "Cancelado";
  return "Em produção";
}

/**
 * IBR: a etapa de PROCESSAMENTO enquanto em produção (null nos desfechos —
 * concluído/cancelado não estão "fazendo" nada).
 */
export function etapaAnalysis(status: string): string | null {
  if (status === "Concluída" || status === "Cancelada") return null;
  return status; // Rascunho · Extraindo · Revisão necessária · Pronta para gerar · Gerando diagnóstico · Erro · Interrompida
}

/** Modelos (Valuation/Orçamento/BP): já são ciclo puro; "Rascunho" é legado. */
export function cicloVidaModel(status: string): CicloVida {
  if (status === "Concluído") return "Concluído";
  if (status === "Cancelado") return "Cancelado";
  return "Em produção"; // inclui o legado "Rascunho" (mesma regra do PUT /status)
}

/** Rótulo compacto p/ UI: ciclo e, quando houver, a etapa entre parênteses. */
export function rotuloCiclo(ciclo: CicloVida, etapa: string | null): string {
  return etapa ? `${ciclo} · ${etapa}` : ciclo;
}
