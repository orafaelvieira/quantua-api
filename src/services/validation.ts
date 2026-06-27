import type { BPLineItem, DRELineItem } from "../types/financial";

export interface ValidationAlert {
  tipo: "erro" | "aviso" | "info";
  area: string;
  mensagem: string;
  detalhes?: string;
  confianca?: number; // 0-100, how confident we are in the extracted data
}

export interface ValidationResult {
  valido: boolean;
  alertas: ValidationAlert[];
  confiancaGeral: number; // 0-100, overall confidence score
  equacaoPatrimonial: boolean;
  composicaoAtivo: boolean;
  composicaoPassivo: boolean;
  /** false quando algum grupo do BP fecha no subtotal mas o detalhe está incompleto */
  detalheCompleto: boolean;
  /** grupos do BP com detalhe incompleto (subtotal ≠ soma das contas) */
  gruposIncompletos: string[];
  /** Reconciliação da DRE contra os subtotais DECLARADOS no documento.
   *  verificada=false → não havia declarados para conferir (não dá para afirmar integridade). */
  reconciliacaoDRE: { verificada: boolean; ok: boolean };
}

/**
 * Find a BP line item value by conta name for a given period.
 */
function bpVal(bp: BPLineItem[], conta: string, periodo: string): number {
  const item = bp.find(b => b.conta === conta);
  return item?.valores[periodo] ?? 0;
}

/**
 * Sum BP values by classificacao for a given period.
 */
function bpByClass(bp: BPLineItem[], classificacao: string, periodo: string): number {
  return bp
    .filter(b => b.classificacao === classificacao)
    .reduce((sum, b) => sum + (b.valores[periodo] ?? 0), 0);
}

/**
 * Find a DRE line item value by conta name for a given period.
 */
function dreVal(dre: DRELineItem[], conta: string, periodo: string): number {
  const item = dre.find(d => d.conta === conta);
  return item?.valores[periodo] ?? 0;
}

/**
 * Check if a value is approximately equal to another within a tolerance.
 * Uses relative tolerance for large numbers and absolute tolerance for small ones.
 */
function approxEqual(a: number, b: number, tolerancePct: number = 1): boolean {
  if (a === 0 && b === 0) return true;
  const maxVal = Math.max(Math.abs(a), Math.abs(b));
  if (maxVal < 1) return Math.abs(a - b) < 0.01; // absolute tolerance for tiny values
  return Math.abs(a - b) / maxVal * 100 <= tolerancePct;
}

/**
 * Format a number as Brazilian currency for display in alerts.
 */
function fmtBRL(val: number): string {
  return val.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * Validate structured financial data (BP and DRE) for consistency.
 * Checks accounting equations, signs, completeness, and cross-document consistency.
 */
export function validateFinancialData(
  bp: BPLineItem[],
  dre: DRELineItem[],
  periodos: string[],
  declarados?: Record<string, Record<string, number>>
): ValidationResult {
  const alertas: ValidationAlert[] = [];
  let equacaoPatrimonial = true;
  let composicaoAtivo = true;
  let composicaoPassivo = true;

  for (const periodo of periodos) {
    // ===== 1. Equação Patrimonial: Ativo Total = Passivo Total =====
    // In Brazilian accounting, Passivo Total includes PC + PNC + PL
    const ativoTotal = bpVal(bp, "Ativo Total", periodo);
    const passivoTotal = Math.abs(bpVal(bp, "Passivo Total", periodo));

    if (ativoTotal !== 0 && passivoTotal !== 0) {
      if (!approxEqual(ativoTotal, passivoTotal, 2)) {
        equacaoPatrimonial = false;
        alertas.push({
          tipo: "erro",
          area: "Equação Patrimonial",
          mensagem: `Ativo Total (${fmtBRL(ativoTotal)}) ≠ Passivo Total (${fmtBRL(passivoTotal)}) em ${periodo}`,
          detalhes: `Diferença: ${fmtBRL(Math.abs(ativoTotal - passivoTotal))} (${((Math.abs(ativoTotal - passivoTotal) / Math.max(ativoTotal, passivoTotal)) * 100).toFixed(2)}%)`,
        });
      }
    }

    // ===== 2. Composição do Ativo: AC + ANC = Ativo Total =====
    const ativoCirculante = bpVal(bp, "Ativo Circulante", periodo);
    const ativoNaoCirculante = bpVal(bp, "Ativo Não Circulante", periodo);

    if (ativoTotal !== 0 && (ativoCirculante !== 0 || ativoNaoCirculante !== 0)) {
      const somaAtivo = ativoCirculante + ativoNaoCirculante;
      if (!approxEqual(somaAtivo, ativoTotal, 2)) {
        composicaoAtivo = false;
        alertas.push({
          tipo: "aviso",
          area: "Composição do Ativo",
          mensagem: `AC (${fmtBRL(ativoCirculante)}) + ANC (${fmtBRL(ativoNaoCirculante)}) ≠ Ativo Total (${fmtBRL(ativoTotal)}) em ${periodo}`,
          detalhes: `Soma: ${fmtBRL(somaAtivo)}, diferença: ${fmtBRL(Math.abs(somaAtivo - ativoTotal))}`,
        });
      }
    }

    // ===== 3. Composição do Passivo: PC + PNC + PL = Passivo Total =====
    const passivoCirculante = Math.abs(bpVal(bp, "Passivo Circulante", periodo));
    const passivoNaoCirculante = Math.abs(bpVal(bp, "Passivo Não Circulante", periodo));
    const patrimonioLiquido = Math.abs(bpVal(bp, "Patrimônio Líquido", periodo));

    if (passivoTotal !== 0 && (passivoCirculante !== 0 || passivoNaoCirculante !== 0 || patrimonioLiquido !== 0)) {
      const somaPassivo = passivoCirculante + passivoNaoCirculante + patrimonioLiquido;
      if (!approxEqual(somaPassivo, passivoTotal, 2)) {
        composicaoPassivo = false;
        alertas.push({
          tipo: "aviso",
          area: "Composição do Passivo",
          mensagem: `PC (${fmtBRL(passivoCirculante)}) + PNC (${fmtBRL(passivoNaoCirculante)}) + PL (${fmtBRL(patrimonioLiquido)}) ≠ Passivo Total (${fmtBRL(passivoTotal)}) em ${periodo}`,
          detalhes: `Soma: ${fmtBRL(somaPassivo)}, diferença: ${fmtBRL(Math.abs(somaPassivo - passivoTotal))}`,
        });
      }
    }

    // ===== 4. DRE: Verificação de sinal =====
    // Receita Bruta deve ser positiva
    const recBruta = dreVal(dre, "Receita Bruta", periodo);
    if (recBruta < 0) {
      alertas.push({
        tipo: "aviso",
        area: "Sinais DRE",
        mensagem: `Receita Bruta é negativa (${fmtBRL(recBruta)}) em ${periodo} — pode indicar inversão de sinal`,
      });
    }

    // Deduções devem ser negativas ou zero
    const deducoes = dreVal(dre, "Deduções da Receita Bruta", periodo);
    if (deducoes > 0) {
      alertas.push({
        tipo: "aviso",
        area: "Sinais DRE",
        mensagem: `Deduções da Receita Bruta é positiva (${fmtBRL(deducoes)}) em ${periodo} — deveria ser negativa`,
      });
    }

    // Custos devem ser negativos ou zero
    const custoOp = dreVal(dre, "Custo Operacional", periodo);
    if (custoOp > 0) {
      alertas.push({
        tipo: "aviso",
        area: "Sinais DRE",
        mensagem: `Custo Operacional é positivo (${fmtBRL(custoOp)}) em ${periodo} — deveria ser negativo`,
      });
    }

    // ===== 5. DRE: Receita Líquida = Receita Bruta + Deduções + Impostos s/ Faturamento =====
    const impostosFat = dreVal(dre, "Impostos s/ Faturamento", periodo);
    const recLiquida = dreVal(dre, "Receita Líquida", periodo);
    if (recBruta !== 0 && (deducoes !== 0 || impostosFat !== 0) && recLiquida !== 0) {
      const expected = recBruta + deducoes + impostosFat;
      if (!approxEqual(recLiquida, expected, 2)) {
        alertas.push({
          tipo: "aviso",
          area: "DRE Consistência",
          mensagem: `Receita Líquida (${fmtBRL(recLiquida)}) ≠ Receita Bruta (${fmtBRL(recBruta)}) + Deduções (${fmtBRL(deducoes)}) + Impostos s/ Faturamento (${fmtBRL(impostosFat)}) em ${periodo}`,
          detalhes: `Esperado: ${fmtBRL(expected)}`,
        });
      }
    }

    // ===== 6. Lucro Bruto = Receita Líquida + Custo Operacional =====
    const lucroBruto = dreVal(dre, "Lucro Bruto", periodo);
    if (recLiquida !== 0 && custoOp !== 0 && lucroBruto !== 0) {
      const expected = recLiquida + custoOp;
      if (!approxEqual(lucroBruto, expected, 2)) {
        alertas.push({
          tipo: "aviso",
          area: "DRE Consistência",
          mensagem: `Lucro Bruto (${fmtBRL(lucroBruto)}) ≠ Receita Líquida + Custo Operacional em ${periodo}`,
          detalhes: `Esperado: ${fmtBRL(expected)}`,
        });
      }
    }
  }

  // ===== 7. Completeness checks =====
  const hasAtivoTotal = bp.some(b => b.conta === "Ativo Total" && Object.values(b.valores).some(v => v !== 0));
  const hasPassivoTotal = bp.some(b => b.conta === "Passivo Total" && Object.values(b.valores).some(v => v !== 0));
  const hasPC = bp.some(b => b.conta === "Passivo Circulante" && Object.values(b.valores).some(v => v !== 0));
  const hasPL = bp.some(b => b.conta === "Patrimônio Líquido" && Object.values(b.valores).some(v => v !== 0));
  const hasRecBruta = dre.some(d => d.conta === "Receita Bruta" && Object.values(d.valores).some(v => v !== 0));
  const hasLucroLiq = dre.some(d => d.conta === "Lucro Líquido" && Object.values(d.valores).some(v => v !== 0));

  if (!hasAtivoTotal) {
    alertas.push({ tipo: "aviso", area: "Completude BP", mensagem: "Ativo Total não encontrado ou zerado no BP" });
  }
  if (!hasPassivoTotal) {
    alertas.push({ tipo: "aviso", area: "Completude BP", mensagem: "Passivo Total não encontrado ou zerado no BP" });
  }
  if (!hasPC) {
    alertas.push({ tipo: "aviso", area: "Completude BP", mensagem: "Passivo Circulante não encontrado — indicadores de liquidez não serão calculados" });
  }
  if (!hasPL) {
    alertas.push({ tipo: "aviso", area: "Completude BP", mensagem: "Patrimônio Líquido não encontrado — indicadores de rentabilidade comprometidos" });
  }
  if (!hasRecBruta) {
    alertas.push({ tipo: "info", area: "Completude DRE", mensagem: "Receita Bruta não encontrada na DRE — margens não serão calculadas" });
  }
  if (!hasLucroLiq) {
    alertas.push({ tipo: "info", area: "Completude DRE", mensagem: "Lucro Líquido não encontrado na DRE — ROE/ROA dependem do BP" });
  }

  // ===== 7.5 Completude do DETALHE (subtotal vs soma das contas detalhadas) =====
  // INTEGRIDADE: um BP pode fechar Ativo=Passivo no subtotal e ter o detalhe
  // vazio. Isso quebra SILENCIOSAMENTE indicadores (liquidez seca, prazos médios,
  // dívida líquida, capital de terceiros, NCG) sem o analista perceber. Detectamos
  // e sinalizamos de forma destacada — o produto não pode gerar análise enganosa.
  const SUBTOTAIS_BP = new Set([
    "Ativo Total", "Ativo Circulante", "Ativo Não Circulante",
    "Passivo Total", "Passivo Circulante", "Passivo Não Circulante", "Patrimônio Líquido",
  ]);
  const gruposDetalhe: Array<{ grupo: string; detailClasses: string[] }> = [
    { grupo: "Ativo Circulante", detailClasses: ["AF", "AO"] },
    { grupo: "Ativo Não Circulante", detailClasses: ["ANC"] },
    { grupo: "Passivo Circulante", detailClasses: ["PO", "PF"] },
    { grupo: "Passivo Não Circulante", detailClasses: ["PNC"] },
    { grupo: "Patrimônio Líquido", detailClasses: ["PL"] },
  ];
  const gruposIncompletos: string[] = [];
  for (const { grupo, detailClasses } of gruposDetalhe) {
    let pior: { sub: number; det: number; per: string } | null = null;
    for (const periodo of periodos) {
      const sub = Math.abs(bpVal(bp, grupo, periodo));
      if (sub < 1000) continue;
      const det = bp
        .filter(b => detailClasses.includes(b.classificacao) && !SUBTOTAIS_BP.has(b.conta))
        .reduce((s, b) => s + Math.abs(b.valores[periodo] ?? 0), 0);
      if (det / sub < 0.97 && (!pior || (sub - det) > (pior.sub - pior.det))) {
        pior = { sub, det, per: periodo };
      }
    }
    if (pior) {
      gruposIncompletos.push(grupo);
      const cob = pior.det / pior.sub;
      alertas.push({
        tipo: cob < 0.05 ? "erro" : "aviso",
        area: "Completude do detalhe",
        mensagem: `${grupo}: subtotal ${fmtBRL(pior.sub)} mas as contas detalhadas somam apenas ${fmtBRL(pior.det)} (${(cob * 100).toFixed(0)}%) em ${pior.per}`,
        detalhes: `Faltam ${fmtBRL(pior.sub - pior.det)} em contas detalhadas. Indicadores que dependem delas (liquidez seca, prazos médios, dívida líquida, capital de terceiros, NCG) podem estar INCORRETOS. Use "Conciliar com IA" ou preencha no "Editar".`,
      });
    }
  }
  const detalheCompleto = gruposIncompletos.length === 0;

  // ===== 7.6 Granularidade: muito valor em "Outros" → indicadores menos precisos =====
  const baldesOutros: Array<{ outros: string; subtotal: string }> = [
    { outros: "Outros Ativos Circulantes", subtotal: "Ativo Circulante" },
    { outros: "Outros Passivos Circulantes", subtotal: "Passivo Circulante" },
  ];
  for (const { outros, subtotal } of baldesOutros) {
    for (const periodo of periodos) {
      const o = Math.abs(bpVal(bp, outros, periodo));
      const s = Math.abs(bpVal(bp, subtotal, periodo));
      if (s > 1000 && o / s > 0.2 && o > 1000) {
        alertas.push({
          tipo: "aviso",
          area: "Granularidade",
          mensagem: `${fmtBRL(o)} agregados em "${outros}" (${((o / s) * 100).toFixed(0)}% do ${subtotal}) em ${periodo}`,
          detalhes: `Classifique as contas originais (auditoria) para precisão dos indicadores que dependem do detalhe.`,
        });
        break;
      }
    }
  }

  // ===== 7.7 RECONCILIAÇÃO DA DRE (computado vs DECLARADO no documento) =====
  // INTEGRIDADE: a cascata da DRE sempre fecha consigo mesma (é recalculada), então
  // checagens internas NUNCA pegam dupla contagem nas ENTRADAS. A única prova real é
  // comparar os subtotais calculados com os valores que o próprio documento informa
  // (Receita Líquida, Lucro Bruto, Lucro Líquido). Se não baterem, a DRE NÃO é
  // confiável (dupla contagem, conta faltando, sinal). Sem declarados → não dá para
  // afirmar integridade (verificada=false → o banner mostra "não verificado", não verde).
  let reconVerificada = false;
  let reconOk = true;
  const CONTAS_RECON = ["Receita Líquida", "Lucro Bruto", "Lucro Líquido"];
  if (declarados) {
    for (const periodo of periodos) {
      const decl = declarados[periodo];
      if (!decl) continue;
      for (const conta of CONTAS_RECON) {
        const d = decl[conta];
        if (typeof d !== "number" || Math.abs(d) < 1) continue;
        const c = dreVal(dre, conta, periodo);
        if (Math.abs(c) < 1) continue;
        reconVerificada = true;
        // compara magnitudes (a dupla contagem é um erro de magnitude; sinal é checado à parte)
        if (!approxEqual(Math.abs(c), Math.abs(d), 2)) {
          reconOk = false;
          alertas.push({
            tipo: "erro",
            area: "Reconciliação DRE",
            mensagem: `${conta} calculado (${fmtBRL(c)}) ≠ declarado no documento (${fmtBRL(d)}) em ${periodo}`,
            detalhes: `Diferença de ${fmtBRL(Math.abs(Math.abs(c) - Math.abs(d)))}. A DRE não reconcilia com o resultado informado no documento — possível dupla contagem (subtotal somado com os filhos) ou conta faltando. Use "Conciliar com IA" para reconciliar.`,
          });
        }
      }
    }
  }
  const reconciliacaoDRE = { verificada: reconVerificada, ok: reconOk };

  // ===== 8. Calculate overall confidence score =====
  let confiancaGeral = 100;
  if (!detalheCompleto) confiancaGeral -= 15 + gruposIncompletos.length * 5;
  if (reconVerificada && !reconOk) confiancaGeral -= 30;

  // Deduct for missing critical items
  if (!hasAtivoTotal) confiancaGeral -= 15;
  if (!hasPassivoTotal) confiancaGeral -= 15;
  if (!hasPC) confiancaGeral -= 10;
  if (!hasPL) confiancaGeral -= 10;
  if (!hasRecBruta) confiancaGeral -= 10;
  if (!hasLucroLiq) confiancaGeral -= 5;

  // Deduct for equation failures
  if (!equacaoPatrimonial) confiancaGeral -= 20;
  if (!composicaoAtivo) confiancaGeral -= 5;
  if (!composicaoPassivo) confiancaGeral -= 5;

  // Deduct for sign warnings
  const signWarnings = alertas.filter(a => a.area === "Sinais DRE").length;
  confiancaGeral -= signWarnings * 3;

  // Deduct for DRE consistency issues
  const dreWarnings = alertas.filter(a => a.area === "DRE Consistência").length;
  confiancaGeral -= dreWarnings * 5;

  // Count how many BP lines have non-zero values (data density)
  const bpFilled = bp.filter(b => Object.values(b.valores).some(v => v !== 0)).length;
  const bpTotal = bp.length;
  const bpDensity = bpTotal > 0 ? bpFilled / bpTotal : 0;
  if (bpDensity < 0.2) confiancaGeral -= 10;

  confiancaGeral = Math.max(0, Math.min(100, confiancaGeral));

  return {
    valido: equacaoPatrimonial && alertas.filter(a => a.tipo === "erro").length === 0,
    alertas,
    confiancaGeral,
    equacaoPatrimonial,
    composicaoAtivo,
    composicaoPassivo,
    detalheCompleto,
    gruposIncompletos,
    reconciliacaoDRE,
  };
}

/**
 * Benford's Law analysis: check if the distribution of first digits
 * follows the expected logarithmic distribution. Anomalies may indicate
 * fabricated or erroneous data.
 */
export function benfordAnalysis(values: number[]): {
  passesTest: boolean;
  chiSquared: number;
  details: string;
} {
  // Benford's expected distribution for digits 1-9
  const expected = [0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046];
  const counts = new Array(9).fill(0);
  let total = 0;

  for (const v of values) {
    const abs = Math.abs(v);
    if (abs < 1) continue; // skip zero and very small values
    const firstDigit = parseInt(String(abs).replace(/[^1-9]/, "").charAt(0));
    if (firstDigit >= 1 && firstDigit <= 9) {
      counts[firstDigit - 1]++;
      total++;
    }
  }

  if (total < 50) {
    return { passesTest: true, chiSquared: 0, details: "Amostra insuficiente para Benford (<50 valores)" };
  }

  // Chi-squared test
  let chiSquared = 0;
  for (let i = 0; i < 9; i++) {
    const observed = counts[i] / total;
    const exp = expected[i];
    chiSquared += Math.pow(observed - exp, 2) / exp;
  }
  chiSquared *= total;

  // Critical value for chi-squared with 8 degrees of freedom at p=0.05 is 15.507
  const passesTest = chiSquared <= 15.507;

  return {
    passesTest,
    chiSquared: Math.round(chiSquared * 100) / 100,
    details: passesTest
      ? `Distribuição de Benford OK (χ²=${chiSquared.toFixed(2)}, p>0.05)`
      : `ALERTA: Distribuição de Benford anômala (χ²=${chiSquared.toFixed(2)}, p<0.05) — verificar dados`,
  };
}
