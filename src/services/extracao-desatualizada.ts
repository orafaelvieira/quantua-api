/**
 * EXTRAÇÃO DESATUALIZADA — a mesma medida usada pelo aviso da tela e pela TRAVA
 * da geração (regra do dono, 14/08/2026: "a extração precisa estar correta
 * antes de rodar o IBR").
 *
 * Duas réguas, conforme o caminho do IBR:
 * - BASE DO WORKSPACE: compara a MARCA dos insumos (hash de documentos +
 *   dicionário + modelos padrão). Mudou qualquer um → os números na tela são de
 *   antes.
 * - EXTRAÇÃO PRÓPRIA (caminho antigo): documento vigente que entrou DEPOIS da
 *   última extração. Documento herdado (fixação Processada) carrega a própria
 *   extração e não conta — senão toda v2 acendia o aviso à toa.
 *
 * Estava inline no GET /analyses/:id; virou serviço para que o aviso e a trava
 * não possam divergir (aviso na tela dizendo uma coisa e a geração aceitando
 * outra é pior do que não ter aviso).
 */
import { insumosDaBase, diferencasDaMarca } from "./base-contabil";

const MATERIAL_TIPO = "Material complementar";

export interface DocumentoParaMedida {
  id: string;
  nome: string;
  tipo: string;
  status: string;
  fixadoDeId: string | null;
  createdAt: Date;
}

export interface MedidaDesatualizacao {
  desatualizada: boolean;
  motivos: string[];
}

export async function medirExtracaoDesatualizada(
  analysis: { companyId: string; dadosEstruturados: unknown; documents: DocumentoParaMedida[] },
  scopeUserIds: string[],
): Promise<MedidaDesatualizacao> {
  const dados = analysis.dadosEstruturados as { extraidoEm?: string; marcaBase?: string } | null;
  const motivos: string[] = [];
  if (!dados) return { desatualizada: false, motivos };

  if (dados.marcaBase) {
    const poolIds = analysis.documents
      .filter((d) => d.fixadoDeId && d.tipo !== MATERIAL_TIPO && d.status !== "Substituído")
      .map((d) => d.fixadoDeId!);
    try {
      const agora = await insumosDaBase(analysis.companyId, scopeUserIds, poolIds);
      if (agora.marca !== dados.marcaBase) {
        const nomePorId: Record<string, string> = {};
        for (const d of agora.docs) nomePorId[d.id] = d.nome;
        for (const d of analysis.documents) if (d.fixadoDeId) nomePorId[d.fixadoDeId] ??= d.nome;
        motivos.push(...diferencasDaMarca(dados.marcaBase, agora.marca, nomePorId).slice(0, 6));
        return { desatualizada: true, motivos };
      }
    } catch {
      // Falha ao medir NÃO acende alarme falso nem barra a geração: um erro de
      // infra não pode impedir o analista de entregar.
    }
    return { desatualizada: false, motivos };
  }

  if (dados.extraidoEm) {
    const novos = analysis.documents.filter((d) =>
      d.tipo !== MATERIAL_TIPO && d.status !== "Substituído" &&
      !(d.status === "Processado" && d.fixadoDeId) &&
      d.createdAt > new Date(dados.extraidoEm!),
    );
    for (const d of novos.slice(0, 5)) {
      motivos.push(`"${d.nome}" entrou em ${d.createdAt.toLocaleString("pt-BR")}, depois da extração de ${new Date(dados.extraidoEm).toLocaleString("pt-BR")}`);
    }
    return { desatualizada: novos.length > 0, motivos };
  }

  return { desatualizada: false, motivos };
}
