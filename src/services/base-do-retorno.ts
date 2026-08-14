/**
 * BASE DOS RETORNOS — o denominador do ROE/ROA é grande o bastante para o número
 * significar performance?
 *
 * Caso real (IBR DUNAMYS, 14/08/2026): ROE 626,5% e ROA 523,8% saíram no
 * semáforo como "Rentabilidade · Positivo — melhor que praticamente todas as
 * empresas comparáveis". Não é performance: é aritmética de denominador quase
 * zero. O patrimônio era ~R$ 0,9 mi para R$ 9,0 mi de receita, porque a
 * distribuição aos sócios superou o lucro do ano — o retorno "excepcional" mede
 * o esvaziamento do patrimônio, não a eficiência da operação. E comparar isso
 * com pares da B3 (que têm patrimônio de verdade) não significa nada.
 *
 * Este serviço não julga a empresa: ele MEDE a base e devolve o alerta como
 * FATO para o prompt. A IA continua interpretando — mas sem poder chamar de
 * "melhor do setor" um número que nasce de um denominador minúsculo.
 */
import type { BPLineItem, DRELineItem } from "../types/financial";

export interface BaseDoRetorno {
  /** PL ÷ Receita Líquida — abaixo de ~15% o ROE deixa de ser comparável. */
  plSobreReceita: number | null;
  /** Ativo Total ÷ Receita Líquida — abaixo de ~25% o ROA idem. */
  ativoSobreReceita: number | null;
  roeInflado: boolean;
  roaInflado: boolean;
  /** PL negativo: ROE perde qualquer sentido econômico (sinal invertido). */
  plNegativo: boolean;
  /** Texto pronto para o prompt; vazio quando não há nada a alertar. */
  alerta: string;
}

const LIMITE_PL = 0.15;
const LIMITE_ATIVO = 0.25;

const valor = (linhas: Array<{ conta: string; valores: Record<string, number> }>, conta: string, p: string): number =>
  linhas.find((l) => l.conta === conta)?.valores?.[p] ?? 0;

const pct = (v: number): string => `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

export function avaliarBaseDoRetorno(
  bp: BPLineItem[],
  dre: DRELineItem[],
  periodo: string,
): BaseDoRetorno {
  const receita = valor(dre, "Receita Líquida", periodo);
  const plBruto = valor(bp, "Patrimônio Líquido", periodo);
  const ativo = Math.abs(valor(bp, "Ativo Total", periodo));
  const vazio: BaseDoRetorno = {
    plSobreReceita: null, ativoSobreReceita: null,
    roeInflado: false, roaInflado: false, plNegativo: false, alerta: "",
  };
  if (!Number.isFinite(receita) || Math.abs(receita) < 0.005) return vazio;

  // O BP pode gravar o PL com sinal invertido (convenção de alguns sistemas): o
  // que importa aqui é a MAGNITUDE — e o PL economicamente negativo é tratado
  // pelo próprio motor de indicadores, então aqui só se mede o tamanho.
  const pl = Math.abs(plBruto);
  const plSobreReceita = pl / Math.abs(receita);
  const ativoSobreReceita = ativo > 0 ? ativo / Math.abs(receita) : null;
  const roeInflado = plSobreReceita < LIMITE_PL;
  const roaInflado = ativoSobreReceita !== null && ativoSobreReceita < LIMITE_ATIVO;
  if (!roeInflado && !roaInflado) {
    return { plSobreReceita, ativoSobreReceita, roeInflado, roaInflado, plNegativo: plBruto < 0, alerta: "" };
  }

  const partes: string[] = [];
  if (roeInflado) {
    partes.push(
      `o patrimônio líquido equivale a apenas ${pct(plSobreReceita)} da receita do período — um ROE alto aqui mede o TAMANHO DO DENOMINADOR (patrimônio pequeno, tipicamente por distribuição de lucros ou operação com capital próprio mínimo), não eficiência superior`,
    );
  }
  if (roaInflado && ativoSobreReceita !== null) {
    partes.push(
      `o ativo total equivale a ${pct(ativoSobreReceita)} da receita — operação de baixo ativo, então o ROA não é comparável com empresas de capital intensivo`,
    );
  }

  return {
    plSobreReceita, ativoSobreReceita, roeInflado, roaInflado, plNegativo: plBruto < 0,
    alerta:
      `BASE DOS RETORNOS (medida pelo motor — use como FATO): ${partes.join("; ")}. ` +
      `REGRA: NÃO trate ROE/ROA assim como "melhor que os pares" nem como conquista operacional, e NÃO os classifique como positivos sem explicar a base. ` +
      `A leitura honesta é: "retorno altíssimo porque a operação usa pouquíssimo capital próprio — o percentual impressiona, mas o que sustenta o negócio é a geração de caixa, não o retorno contábil". ` +
      `Se a distribuição de lucros explicar o patrimônio reduzido, DIGA ISSO explicitamente.`,
  };
}
