import { createServer } from "vite";

const vite = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});

try {
  const { seedDemoWorkspace } = await vite.ssrLoadModule("/src/server/seed.server.ts");
  const result = await seedDemoWorkspace();
  console.log(`Demo workspace ready (tenant ${result.tenantId}).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await vite.close();
}

process.exit(process.exitCode ?? 0);
