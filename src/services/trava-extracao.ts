/**
 * TRAVA DE EXTRAÇÃO (11/08/2026).
 *
 * POR QUE EXISTE: `POST /analyses/:id/process` responde 202 e segue extraindo
 * em background. O único guarda era o 409 de "Concluída" — duplo clique, dois
 * analistas no mesmo IBR ou um retry do frontend disparavam DUAS extrações
 * completas em paralelo: download, cascata e chamadas de IA pagos duas vezes,
 * gravando um por cima do outro. E a API roda em instância ÚNICA (min=max=1),
 * onde o fold custa 20s+ de CPU — duplicar é derrubar a tela de todo mundo.
 *
 * COMO: marca "Extraindo" com um UPDATE condicional (atômico no banco). Quem
 * perde a corrida não altera nada e recebe 409. Trava em memória não serviria:
 * precisa sobreviver a reinício e valer para qualquer caminho de entrada.
 *
 * ESCAPE: trava sem escape é pior que corrida — se a instância morre no meio
 * (deploy, OOM), o IBR fica preso em "Extraindo" para sempre e não há botão
 * que resolva. Passados TRAVA_EXTRACAO_MIN sem NENHUMA escrita no registro
 * (`updatedAt`), a extração é considerada órfã e pode ser reassumida.
 */

/** Minutos sem escrita no registro após os quais uma extração presa em
 *  "Extraindo" é considerada órfã e pode ser reassumida. Folgado de propósito:
 *  IBR multi-ano com visão leva minutos, e cada etapa toca o registro. */
export const TRAVA_EXTRACAO_MIN = 20;

/** Status que NUNCA cedem a trava, mesmo velhos: são desfechos, não trabalho
 *  em curso. Reextrair um IBR concluído é violação de imutabilidade; cancelado
 *  é decisão do analista. */
export const STATUS_NAO_EXTRAIVEIS = ["Concluída", "Cancelada"] as const;

type UpdateManyPrisma = {
  analysis: {
    updateMany: (args: {
      where: Record<string, unknown>;
      data: { status: string };
    }) => Promise<{ count: number }>;
  };
};

/**
 * Tenta assumir a extração deste IBR. `true` = a trava é sua (status já está
 * "Extraindo" no banco); `false` = outro processo está extraindo agora, ou o
 * IBR está num status que não extrai.
 */
export async function tomarTravaExtracao(
  prisma: UpdateManyPrisma,
  analysisId: string,
  agora: Date = new Date(),
): Promise<boolean> {
  const limite = new Date(agora.getTime() - TRAVA_EXTRACAO_MIN * 60_000);
  const r = await prisma.analysis.updateMany({
    where: {
      id: analysisId,
      OR: [
        { status: { notIn: ["Extraindo", ...STATUS_NAO_EXTRAIVEIS] } },
        // órfã: presa em "Extraindo" e sem nenhum toque desde o limite
        { status: "Extraindo", updatedAt: { lt: limite } },
      ],
    },
    data: { status: "Extraindo" },
  });
  return r.count > 0;
}

/** Mensagem para o 409 — o analista precisa saber se é para esperar ou se o
 *  IBR simplesmente não extrai mais. */
export function motivoTravaNegada(status: string): string {
  if (status === "Extraindo") return "Este IBR já está extraindo agora — aguarde terminar (a tela atualiza sozinha).";
  if (status === "Concluída") return "IBR concluído é imutável — crie uma nova versão para reextrair.";
  if (status === "Cancelada") return "IBR cancelado não extrai. Reative-o antes.";
  return `IBR em "${status}" não pode reextrair agora.`;
}
