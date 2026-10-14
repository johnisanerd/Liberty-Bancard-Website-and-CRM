import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, writeFile } from "fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createSfpPublishBuildIdentity } from "../shared/sfp-publish-build-identity";
import { writeCandidateIdentity, productionBuildRecipe } from "../scripts/fixtures/candidate-build-identity";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  // This is the build-only process; isolated auth/DB runtimes remain in test mode.
  process.env.NODE_ENV = "production";
  await rm("dist", { recursive: true, force: true });
  const publishIdentity = createSfpPublishBuildIdentity(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    randomUUID(),
  );
  const publishBuiltAt = new Date().toISOString();

  console.log("building client...");
  await viteBuild({ mode: "production" });

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
      // Compiled into the artifact, not minted at process start. All replicas
      // share it; a new Publish of the same SHA receives a different UUID.
      "process.env.SFP_PUBLISH_BUILD_ID": JSON.stringify(publishIdentity.buildId),
      "process.env.SFP_PUBLISH_ARTIFACT_SHA": JSON.stringify(publishIdentity.artifactSha),
      "process.env.SFP_PUBLISH_BUILT_AT": JSON.stringify(publishBuiltAt),
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
  await writeFile("dist/sfp-publish-build.json", JSON.stringify({ ...publishIdentity, builtAt: publishBuiltAt }) + "\n");
  await writeFile("dist/RELEASE_SHA", publishIdentity.artifactSha + "\n");
  await writeFile("dist/build-recipe.json", JSON.stringify(productionBuildRecipe()) + "\n");
  console.log("[SFP Publish Artifact]", JSON.stringify(publishIdentity));
  await writeCandidateIdentity();
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
