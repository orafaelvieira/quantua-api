/** VALIDAÇÃO DE FÓRMULAS (3 pontas): INDICADOR da planilha × recálculo pelas contas
 *  cruas da própria planilha × base CVM (motor IBR). Foco: prazos, ciclo, Fleuriet
 *  (AO/PO), + BP/DRE linha a linha. 5 empresas, ANO 2024. */
import { join } from "node:path";
import * as XLSX from "xlsx";
import { parseCvmZip } from "../src/services/cvm-ingest";
import { indicadoresDaEmpresa } from "../src/services/cvm-metrics";

const ANO = 2024;
const EMPRESAS: Array<[string, RegExp]> = [
  ["ABEV3", /^AMBEV/i], ["PETR4", /PETROLEO BRASILEIRO/i], ["MGLU3", /^MAGAZINE LUIZA/i],
  ["TOTS3", /^TOTVS/i], ["VALE3", /^VALE S\.?A/i],
];

async function main(): Promise<void> {
  const wb = XLSX.read(join(__dirname, "../prisma/seed-data/base_bovespa.xlsx"), { type: "file" });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
  // papel|doc|conta → valor do ANO · e classes
  const val = new Map<string, number>();
  const classe = new Map<string, string>(); // conta BP → Class
  for (const r of rows) {
    const doc = String(r["Documento"] ?? "");
    const papel = String(r["Papel"] ?? "");
    const conta = String(r["Conta"] ?? "").trim();
    const v = r[String(ANO)];
    if (typeof v === "number" && Number.isFinite(v)) val.set(`${papel}|${doc}|${conta}`, v);
    if (doc === "BP") classe.set(conta, String(r["Class"] ?? "").trim());
  }
  const cvm = await parseCvmZip("C:/Users/Emerson/Documents/Automação_B3/itr_cvm/dfp_2024.zip");

  const g = (papel: string, doc: string, conta: string) => val.get(`${papel}|${doc}|${conta}`);
  for (const [papel, re] of EMPRESAS) {
    const emp = [...cvm.values()].find((e) => re.test(e.denom));
    const per = emp?.periodos["2024-12-31"];
    if (!emp || !per) { console.log(`\n${papel}: sem CVM 2024`); continue; }
    const visao = indicadoresDaEmpresa(emp, "2024-12-31").find((v) => v.visao === "ANO");
    const label = Object.keys(visao?.indicadores[0]?.valores ?? {})[0];
    const ind = (nome: string) => {
      const i = visao?.indicadores.find((x) => x.nome === nome);
      const v = i?.valores[label];
      return typeof v === "number" ? v : typeof v === "string" ? v : null;
    };

    // ── lado planilha: contas cruas 2024
    const rl = g(papel, "DRE", "Receita Líquida de Vendas e/ou Serviços") ?? 0;
    const custo = Math.abs(g(papel, "DRE", "Custo de Bens e/ou Serviços Vendidos") ?? 0);
    const cr = g(papel, "BP", "Contas a Receber") ?? 0;
    const est = g(papel, "BP", "Estoques") ?? 0;
    const forn = g(papel, "BP", "Fornecedores") ?? 0;
    // AO/PO EXATOS pela Class da planilha
    let ao = 0, po = 0;
    for (const [conta, cl] of classe) {
      const v = g(papel, "BP", conta);
      if (typeof v !== "number") continue;
      if (cl === "AO") ao += v;
      if (cl === "PO") po += Math.abs(v);
    }
    const ac = g(papel, "BP", "Ativo Circulante") ?? 0;
    const pc = Math.abs(g(papel, "BP", "Passivo Circulante") ?? 0);
    const iPlan = (c: string) => val.get(`${papel}|INDICADOR|${c}`);

    console.log(`\n════════ ${papel} · ${emp.denom} · ANO ${ANO} ════════`);
    console.log(`${"Indicador".padEnd(22)} ${"plan(INDICADOR)".padStart(16)} ${"recalc360".padStart(11)} ${"recalc365".padStart(11)} ${"CVM(motor,365)".padStart(15)}`);
    const linha = (nome: string, plan: number | undefined, r360: number, r365: number, cvmV: number | string | null) =>
      console.log(`${nome.padEnd(22)} ${String(plan?.toFixed(1) ?? "—").padStart(16)} ${r360.toFixed(1).padStart(11)} ${r365.toFixed(1).padStart(11)} ${String(typeof cvmV === "number" ? cvmV.toFixed(1) : cvmV ?? "—").padStart(15)}`);
    linha("PM Contas a Receber", iPlan("PM - CONTAS A RECEBER"), cr / rl * 360, cr / rl * 365, ind("Prazo Médio Contas a Receber"));
    linha("PM Estoques", iPlan("PM - ESTOQUES"), est / custo * 360, est / custo * 365, ind("Prazo Médio Estoque"));
    linha("PM Pagamento", iPlan("PM - PAGAMENTO"), forn / custo * 360, forn / custo * 365, ind("Prazo Médio Fornecedores"));
    linha("Ciclo Financeiro", iPlan("CICLO FINANCEIRO"), (cr / rl + est / custo - forn / custo) * 360, (cr / rl + est / custo - forn / custo) * 365, ind("Ciclo Financeiro"));
    console.log(`\n${"Fleuriet".padEnd(22)} ${"plan(INDICADOR)".padStart(16)} ${"recalc(Class)".padStart(13)} ${"CVM(motor)".padStart(15)}`);
    const l2 = (nome: string, plan: number | undefined, rec: number, cvmV: number | string | null) =>
      console.log(`${nome.padEnd(22)} ${String(plan !== undefined ? (plan / 1e3).toFixed(0) + "k" : "—").padStart(16)} ${(rec / 1e3).toFixed(0).padStart(12)}k ${String(typeof cvmV === "number" ? (cvmV / 1e6).toFixed(0) + "M" : cvmV ?? "—").padStart(15)}`);
    l2("NCG (AO−PO)", iPlan("NCG"), ao - po, ind("Necessidade de Capital de Giro (NCG)"));
    l2("CDG (=AC−PC p/ conferir)", iPlan("CDG"), ac - pc, ind("Capital de Giro (CDG)"));
    l2("Tesouraria (CDG−NCG)", iPlan("TESOURARIA"), (ac - pc) - (ao - po), ind("Saldo em Tesouraria (ST)"));
    console.log(`Fleuriet situação — CVM: ${ind("Situação de Liquidez (Fleuriet)")}`);

    // ── BP/DRE linha a linha (planilha em R$ mil? fator pelo Ativo Total)
    const atP = g(papel, "BP", "Ativo Total") ?? 0;
    const atC = per.bp["Ativo Total"] ?? 0;
    const fator = atP ? atC / atP : 0;
    console.log(`\nBP/DRE planilha × CVM (fator de unidade ${fator.toFixed(0)}× via Ativo Total):`);
    const cmp = (nomeP: string, docP: string, contaCvm: string, deDre = false) => {
      const vp = g(papel, docP, nomeP);
      const vc = deDre ? per.dreYtd[contaCvm] : per.bp[contaCvm];
      if (vp === undefined || vc === undefined) { console.log(`  ${nomeP.padEnd(44)} ${vp === undefined ? "sem plan" : "sem CVM"}`); return; }
      const dif = vp * fator !== 0 ? (vc - vp * fator) / Math.abs(vp * fator) : 0;
      console.log(`  ${(Math.abs(dif) <= 0.01 ? "✓ " : "✗ ") + nomeP.padEnd(44)} Δ ${(dif * 100).toFixed(1)}%`);
    };
    cmp("Ativo Circulante", "BP", "Ativo Circulante");
    cmp("Contas a Receber", "BP", "Contas a Receber - CP");
    cmp("Estoques", "BP", "Estoques - CP");
    cmp("Tributos a Recuperar", "BP", "Tributos a Recuperar - CP");
    cmp("Fornecedores", "BP", "Fornecedores - CP");
    cmp("Passivo Circulante", "BP", "Passivo Circulante");
    cmp("Passivo Não Circulante", "BP", "Passivo Não Circulante");
    cmp("Patrimônio Líquido", "BP", "Patrimônio Líquido");
    cmp("Caixa e Equivalentes de Caixa", "BP", "Caixa e Equivalentes de Caixa");
    cmp("Receita Líquida de Vendas e/ou Serviços", "DRE", "Receita Líquida", true);
    cmp("Custo de Bens e/ou Serviços Vendidos", "DRE", "Custo Operacional", true);
    cmp("Lucro/Prejuízo do Período", "DRE", "Lucro Líquido", true);
  }
}
void main();
