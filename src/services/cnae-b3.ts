/**
 * CNAE → SUBSETOR B3 — sugestão determinística de setor no CADASTRO (zero IA).
 *
 * O CNAE é um sinal FRACO (pode estar desatualizado ou registrado na matriz errada —
 * caso Move Farma: matriz "serviços de escritório", negócio real na filial). Por isso
 * a sugestão NUNCA confirma o setor sozinha: preenche o picker com selo "sugerido pelo
 * CNAE" e o classificador estatístico confere depois, com os números.
 *
 * Mapa por DIVISÃO (2 dígitos, CNAE 2.0) + exceções por CLASSE (4 dígitos) onde a
 * divisão é ambígua (ex.: 46 atacado é Consumo não Cíclico, mas 4644 medicamentos é
 * Saúde/Comércio e Distribuição). Códigos-alvo = taxonomia B3 do picker (Sector.code).
 */

// Exceções por CLASSE (4 primeiros dígitos) — avaliadas ANTES da divisão.
const POR_CLASSE: Record<string, string> = {
  "4644": "saude__comercio_e_distribuicao",              // atacado de medicamentos
  "4645": "saude__comercio_e_distribuicao",              // atacado méd-hospitalar
  "4771": "saude__comercio_e_distribuicao",              // farmácias
  "4711": "consumo_nao_ciclico__comercio_e_distribuicao", // hiper/supermercados
  "4712": "consumo_nao_ciclico__comercio_e_distribuicao", // minimercados
  "4661": "bens_industriais__comercio",                  // atacado de máquinas
  "4662": "bens_industriais__comercio",
  "4663": "bens_industriais__comercio",
  "7732": "bens_industriais__servicos",                  // aluguel de máquinas p/ construção
};

// Divisões CNAE 2.0 (01–99) → subsetor B3.
const POR_DIVISAO: Record<string, string> = {
  "01": "consumo_nao_ciclico__agropecuaria",
  "02": "materiais_basicos__madeira_e_papel",
  "03": "consumo_nao_ciclico__agropecuaria",
  "05": "materiais_basicos__mineracao",
  "06": "petroleo_gas_e_biocombustiveis__petroleo_gas_e_biocombustiveis",
  "07": "materiais_basicos__mineracao",
  "08": "materiais_basicos__mineracao",
  "09": "materiais_basicos__mineracao",
  "10": "consumo_nao_ciclico__alimentos_processados",
  "11": "consumo_nao_ciclico__bebidas",
  "12": "consumo_nao_ciclico__alimentos_processados",   // fumo (sem subsetor próprio no picker)
  "13": "consumo_ciclico__tecidos_vestuario_e_calcados",
  "14": "consumo_ciclico__tecidos_vestuario_e_calcados",
  "15": "consumo_ciclico__tecidos_vestuario_e_calcados",
  "16": "materiais_basicos__madeira_e_papel",
  "17": "materiais_basicos__madeira_e_papel",
  "18": "consumo_ciclico__diversos",                    // impressão/mídia gráfica
  "19": "petroleo_gas_e_biocombustiveis__petroleo_gas_e_biocombustiveis",
  "20": "materiais_basicos__quimicos",
  "21": "saude__medicamentos_e_outros_produtos",
  "22": "materiais_basicos__materiais_diversos",        // borracha e plástico
  "23": "bens_industriais__construcao_e_engenharia",    // cimento/vidro/produtos p/ construção
  "24": "materiais_basicos__siderurgia_e_metalurgia",
  "25": "materiais_basicos__siderurgia_e_metalurgia",
  "26": "tecnologia_da_informacao__computadores_e_equipamentos",
  "27": "bens_industriais__maquinas_e_equipamentos",
  "28": "bens_industriais__maquinas_e_equipamentos",
  "29": "bens_industriais__material_de_transporte",
  "30": "bens_industriais__material_de_transporte",
  "31": "consumo_ciclico__utilidades_domesticas",       // móveis
  "32": "consumo_ciclico__diversos",
  "33": "bens_industriais__servicos",                   // manutenção industrial
  "35": "utilidade_publica__energia_eletrica",
  "36": "utilidade_publica__agua_e_saneamento",
  "37": "utilidade_publica__agua_e_saneamento",
  "38": "utilidade_publica__agua_e_saneamento",
  "39": "utilidade_publica__agua_e_saneamento",
  "41": "consumo_ciclico__construcao_civil",            // incorporação/edifícios
  "42": "bens_industriais__construcao_e_engenharia",    // infraestrutura
  "43": "bens_industriais__construcao_e_engenharia",
  "45": "consumo_ciclico__automoveis_e_motocicletas",
  "46": "consumo_nao_ciclico__comercio_e_distribuicao", // atacado (exceções por classe acima)
  "47": "consumo_ciclico__comercio",                    // varejo (exceções por classe acima)
  "49": "bens_industriais__transporte",
  "50": "bens_industriais__transporte",
  "51": "bens_industriais__transporte",
  "52": "bens_industriais__transporte",                 // logística/armazenagem
  "53": "bens_industriais__transporte",
  "55": "consumo_ciclico__hoteis_e_restaurantes",
  "56": "consumo_ciclico__hoteis_e_restaurantes",
  "58": "consumo_ciclico__diversos",                    // edição/mídia
  "59": "consumo_ciclico__diversos",
  "60": "consumo_ciclico__diversos",
  "61": "comunicacoes__telecomunicacoes",
  "62": "tecnologia_da_informacao__programas_e_servicos",
  "63": "tecnologia_da_informacao__programas_e_servicos",
  "64": "financeiro__intermediarios_financeiros",
  "65": "financeiro__previdencia_e_seguros",
  "66": "financeiro__servicos_financeiros_diversos",
  "68": "financeiro__exploracao_de_imoveis",
  "69": "bens_industriais__servicos",                   // jurídico/contábil (B2B)
  "70": "bens_industriais__servicos",                   // consultoria de gestão
  "71": "bens_industriais__construcao_e_engenharia",    // engenharia consultiva
  "72": "tecnologia_da_informacao__programas_e_servicos", // P&D
  "73": "consumo_ciclico__diversos",                    // publicidade
  "74": "bens_industriais__servicos",
  "75": "saude__serv_med_hospit_analises_e_diagnosticos", // veterinária
  "77": "consumo_ciclico__diversos",                    // aluguel de veículos (exceção 7732)
  "78": "bens_industriais__servicos",                   // RH
  "79": "consumo_ciclico__viagens_e_lazer",
  "80": "bens_industriais__servicos",                   // vigilância
  "81": "bens_industriais__servicos",                   // serviços p/ edifícios
  "82": "bens_industriais__servicos",                   // apoio administrativo
  "84": "outros__outros",
  "85": "consumo_ciclico__diversos",                    // educação (padrão B3: Yduqs/Cogna)
  "86": "saude__serv_med_hospit_analises_e_diagnosticos",
  "87": "saude__serv_med_hospit_analises_e_diagnosticos",
  "88": "saude__serv_med_hospit_analises_e_diagnosticos",
  "90": "consumo_ciclico__viagens_e_lazer",
  "91": "consumo_ciclico__viagens_e_lazer",
  "92": "consumo_ciclico__viagens_e_lazer",
  "93": "consumo_ciclico__viagens_e_lazer",
  "94": "outros__outros",
  "95": "consumo_ciclico__diversos",
  "96": "consumo_ciclico__diversos",
  "97": "outros__outros",
  "99": "outros__outros",
};

/** Normaliza um código CNAE em dígitos ("4644-3/01", 4644301, "46.44-3-01" → "4644301"). */
export const cnaeDigitos = (c: unknown): string => String(c ?? "").replace(/\D/g, "");

/** Subsetor B3 sugerido para UM código CNAE (classe 4 dígitos > divisão 2 dígitos). */
export function setorPorCnae(codigo: unknown): string | null {
  const d = cnaeDigitos(codigo);
  if (d.length < 2) return null;
  return POR_CLASSE[d.slice(0, 4)] ?? POR_DIVISAO[d.slice(0, 2)] ?? null;
}

export interface SugestaoCnae {
  sectorCode: string;
  cnae: string;
  descricao: string | null;
  /** "principal" | "secundário" — de onde veio o CNAE. */
  origem: string;
}

/** Sugestões para a LISTA de CNAEs da empresa (principal primeiro; secundários viram
 *  alternativas; um sectorCode aparece uma única vez). */
export function sugerirSetores(
  cnaes: Array<{ codigo: unknown; descricao?: string | null; origem: string }>,
): SugestaoCnae[] {
  const out: SugestaoCnae[] = [];
  for (const c of cnaes) {
    const sectorCode = setorPorCnae(c.codigo);
    if (!sectorCode || out.some((o) => o.sectorCode === sectorCode)) continue;
    out.push({ sectorCode, cnae: cnaeDigitos(c.codigo), descricao: c.descricao ?? null, origem: c.origem });
  }
  return out;
}
