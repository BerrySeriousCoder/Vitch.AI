import { createHash } from "crypto";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import type { EditBlueprint } from "@tempo/types";
import {
  evaluateReferenceBlueprint,
  type ReferenceBlueprintBenchmarkSpec,
} from "../apps/api/src/services/reference/reference-blueprint-benchmark.service.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function jsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function unwrapBlueprint(value: any): EditBlueprint {
  const blueprint = value?.editBlueprint || value?.data?.editBlueprint || value;
  if (!blueprint?.id || !Array.isArray(blueprint.segments)) {
    throw new Error("Candidate must be an EditBlueprint or a project JSON containing data.editBlueprint");
  }
  return blueprint as EditBlueprint;
}

async function main(): Promise<void> {
  const root = existsSync(path.resolve(process.cwd(), "benchmarks/reference-analysis"))
    ? process.cwd()
    : path.resolve(process.cwd(), "../..");
  const benchmarkDir = path.resolve(root, option("--benchmark") || "benchmarks/reference-analysis/mountain-grid-v1");
  const spec = await jsonFile<ReferenceBlueprintBenchmarkSpec>(path.join(benchmarkDir, "benchmark.json"));
  const candidatePath = path.resolve(root, option("--candidate") || path.join(benchmarkDir, "gold-blueprint.json"));
  const candidate = unwrapBlueprint(await jsonFile(candidatePath));
  const referenceBytes = await readFile(path.join(benchmarkDir, spec.reference.file));
  const hash = createHash("sha256").update(referenceBytes).digest("hex");
  if (hash !== spec.reference.sha256) {
    throw new Error(`Reference fixture hash mismatch: expected ${spec.reference.sha256}, received ${hash}`);
  }

  const report = evaluateReferenceBlueprint(candidate, spec);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const provider = report.candidate.provider || "unspecified";
    process.stdout.write(`\n${spec.name}\n`);
    process.stdout.write(`Candidate: ${report.candidate.blueprintId} (${provider})\n`);
    process.stdout.write(`Result: ${report.passed ? "PASS" : "FAIL"} · ${report.score}/100\n\n`);
    const rows = Object.entries(report.metrics).map(([metric, value]) =>
      `${metric.padEnd(26)} ${typeof value === "number" && !Number.isInteger(value) ? value.toFixed(4) : value}`
    );
    process.stdout.write(`${rows.join("\n")}\n`);
    if (report.issues.length) {
      process.stdout.write(`\nIssues (${report.issues.length})\n`);
      for (const issue of report.issues) process.stdout.write(`- [${issue.code}] ${issue.message}\n`);
    }
    process.stdout.write("\n");
  }
  if (!report.passed && !process.argv.includes("--allow-fail")) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
