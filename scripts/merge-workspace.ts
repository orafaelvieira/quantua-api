/**
 * merge-workspace.ts — junta um conjunto de usuários (fundadores/time) em um
 * único Workspace, para que passem a compartilhar empresas, IBRs, engagements,
 * etc. (visibilidade de firma). Complementa o escopo por `req.scopeUserIds`
 * adicionado em src/middleware/auth.ts.
 *
 * Uso:
 *   # dry-run (não grava nada, só mostra o que faria):
 *   DATABASE_URL="<prod>" npx tsx scripts/merge-workspace.ts "socio1@x.com,socio2@x.com"
 *
 *   # aplicar de fato:
 *   DATABASE_URL="<prod>" npx tsx scripts/merge-workspace.ts "socio1@x.com,socio2@x.com" --apply
 *
 * Opções:
 *   --apply                 grava as mudanças (sem isso, é dry-run)
 *   --name "Razão Social"   nome do workspace, se for preciso criar um novo
 *   --type empresa|consultoria   tipo do workspace novo (default: consultoria)
 *
 * Regra de escolha do workspace alvo:
 *   - Se algum dos usuários já tiver workspaceId, reutiliza o primeiro encontrado.
 *   - Caso contrário, cria um novo Workspace com --name / --type.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function parseFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const emailsArg = process.argv[2];
  if (!emailsArg || emailsArg.startsWith("--")) {
    console.error('Uso: tsx scripts/merge-workspace.ts "email1,email2,..." [--apply] [--name "Razão"] [--type consultoria]');
    process.exit(1);
  }
  const emails = emailsArg
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const wsName = parseFlag("--name") ?? "Workspace Quantua";
  const wsType = parseFlag("--type") ?? "consultoria";

  console.log(`\n[merge-workspace] modo: ${apply ? "APLICAR" : "DRY-RUN (nada será gravado)"}`);
  console.log(`[merge-workspace] e-mails alvo (${emails.length}):`, emails.join(", "));

  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, name: true, email: true, role: true, workspaceId: true },
  });

  const found = new Set(users.map((u) => u.email.toLowerCase()));
  const missing = emails.filter((e) => !found.has(e));
  if (missing.length) {
    console.warn(`[merge-workspace] AVISO: e-mails não encontrados (ignorados):`, missing.join(", "));
  }
  if (users.length < 2) {
    console.error(`[merge-workspace] ERRO: encontrei ${users.length} usuário(s). Preciso de pelo menos 2 para compartilhar.`);
    process.exit(1);
  }

  console.table(
    users.map((u) => ({ email: u.email, name: u.name, role: u.role ?? "(sem role)", workspaceId: u.workspaceId ?? "(nenhum)" })),
  );

  // Workspace alvo: reutiliza o primeiro existente entre os usuários, senão cria.
  const existingWsId = users.find((u) => u.workspaceId)?.workspaceId ?? null;
  const distinctWs = [...new Set(users.map((u) => u.workspaceId).filter(Boolean))];
  if (distinctWs.length > 1) {
    console.warn(`[merge-workspace] AVISO: usuários já estão em ${distinctWs.length} workspaces diferentes: ${distinctWs.join(", ")}. Todos serão movidos para um só.`);
  }

  let targetWorkspaceId = existingWsId;

  if (!apply) {
    if (targetWorkspaceId) {
      console.log(`\n[dry-run] reutilizaria workspace existente: ${targetWorkspaceId}`);
    } else {
      console.log(`\n[dry-run] criaria novo workspace { type: "${wsType}", razaoSocial: "${wsName}" }`);
    }
    const toMove = users.filter((u) => u.workspaceId !== targetWorkspaceId);
    console.log(`[dry-run] atualizaria workspaceId de ${toMove.length} usuário(s):`, toMove.map((u) => u.email).join(", ") || "(nenhum — já alinhados)");
    console.log(`\n[dry-run] OK. Rode novamente com --apply para gravar.`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (!targetWorkspaceId) {
      const ws = await tx.workspace.create({
        data: { type: wsType, razaoSocial: wsName },
        select: { id: true },
      });
      targetWorkspaceId = ws.id;
      console.log(`[apply] workspace criado: ${targetWorkspaceId}`);
    } else {
      console.log(`[apply] reutilizando workspace existente: ${targetWorkspaceId}`);
    }

    const res = await tx.user.updateMany({
      where: { id: { in: users.map((u) => u.id) } },
      data: { workspaceId: targetWorkspaceId },
    });
    console.log(`[apply] ${res.count} usuário(s) movidos para o workspace ${targetWorkspaceId}.`);
  });

  console.log(`\n[merge-workspace] concluído. Os usuários agora compartilham empresas e IBRs.`);
}

main()
  .catch((e) => {
    console.error("[merge-workspace] falhou:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
