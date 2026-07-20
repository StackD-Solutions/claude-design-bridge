#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 StackD Solutions

import { performance } from "node:perf_hooks";

import {
  delegate,
  delegateBatch,
} from "../server/claude-delegate.mjs";
import {
  rawFileToBytes,
  resolveDesignLink,
} from "../server/design-bridge.mjs";
import { normalizeDesignPath } from "../server/design-validation.mjs";

const BATCH_SIZES = [1, 3, 12];
const REQUIRED_CONFIRMATION = "I_ACCEPT_BOUNDED_COST";
const DEFAULT_RUNS = 3;

const usage = () => {
  process.stdout.write(`Claude Design batch benchmark

Required:
  --url <https://claude.ai/design/p/...>
  --paths <JSON array of at least 12 project-relative paths>
  --confirm ${REQUIRED_CONFIRMATION}

Optional:
  --runs <odd integer, default ${DEFAULT_RUNS}>

The equivalent DESIGN_BRIDGE_BENCHMARK_URL, _PATHS, _CONFIRM, and _RUNS
environment variables are supported. Output never includes project IDs, paths, source,
credentials, or content hashes.
`);
};

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

const parseArguments = (values) => {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") {
      parsed.help = true;
      continue;
    }
    if (!["--url", "--paths", "--confirm", "--runs"].includes(value)) {
      return { error: `Unknown argument: ${value}` };
    }
    const next = values[index + 1];
    if (next === undefined) {
      return { error: `Missing value for ${value}` };
    }
    parsed[value.slice(2)] = next;
    index += 1;
  }
  return parsed;
};

const parsePaths = (value) => {
  let values;
  try {
    values = JSON.parse(value);
  } catch (error) {
    return { error: `--paths must be a JSON array: ${error.message}` };
  }
  if (!Array.isArray(values) || values.length < Math.max(...BATCH_SIZES)) {
    return { error: "--paths must contain at least 12 entries" };
  }
  const paths = values.map(normalizeDesignPath);
  if (paths.some((filePath) => !filePath)) {
    return { error: "Every benchmark path must be normalized and project-relative" };
  }
  if (new Set(paths).size !== paths.length) {
    return { error: "Benchmark paths must not contain duplicates" };
  }
  return { paths };
};

const parseRuns = (value) => {
  const runs = Number(value ?? DEFAULT_RUNS);
  return Number.isSafeInteger(runs) && runs >= 3 && runs <= 9 && runs % 2 === 1
    ? runs
    : null;
};

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

const normalizeRawResult = (raw, expectedPath) => {
  const decoded = rawFileToBytes(raw, expectedPath);
  if (!decoded.ok) {
    return decoded;
  }
  return {
    ok: true,
    data: {
      bytes: decoded.data.bytes.length,
      binary: decoded.data.binary,
      contentType: decoded.data.contentType,
      sha256: decoded.data.sha256,
    },
  };
};

const runSingles = async (projectId, paths) => {
  const metrics = paths.map(() => ({}));
  const startedAt = performance.now();
  const rawResults = await Promise.all(
    paths.map((filePath, index) =>
      delegate("get_file", { projectId, path: filePath }, { metrics: metrics[index] }),
    ),
  );
  const durationMs = performance.now() - startedAt;
  const results = [];
  for (let index = 0; index < rawResults.length; index += 1) {
    const rawResult = rawResults[index];
    if (!rawResult.ok) {
      return {
        ok: false,
        error: rawResult.error,
        durationMs,
        subprocesses: paths.length,
        peakStreamBytes: Math.max(0, ...metrics.map((value) => value.streamBytes ?? 0)),
      };
    }
    const normalized = normalizeRawResult(rawResult.data, paths[index]);
    if (!normalized.ok) {
      return {
        ok: false,
        error: normalized.error,
        durationMs,
        subprocesses: paths.length,
        peakStreamBytes: Math.max(0, ...metrics.map((value) => value.streamBytes ?? 0)),
      };
    }
    results.push(normalized.data);
  }
  return {
    ok: true,
    durationMs,
    subprocesses: paths.length,
    peakStreamBytes: Math.max(0, ...metrics.map((value) => value.streamBytes ?? 0)),
    results,
  };
};

const runBatch = async (projectId, paths) => {
  const metrics = {};
  const startedAt = performance.now();
  const rawResult = await delegateBatch(projectId, paths, { metrics });
  const durationMs = performance.now() - startedAt;
  if (!rawResult.ok) {
    return {
      ok: false,
      error: rawResult.error,
      durationMs,
      subprocesses: 1,
      peakStreamBytes: metrics.streamBytes ?? 0,
    };
  }
  const results = [];
  for (let index = 0; index < rawResult.data.results.length; index += 1) {
    const normalized = normalizeRawResult(rawResult.data.results[index], paths[index]);
    if (!normalized.ok) {
      return {
        ok: false,
        error: normalized.error,
        durationMs,
        subprocesses: 1,
        peakStreamBytes: metrics.streamBytes ?? 0,
      };
    }
    results.push(normalized.data);
  }
  return {
    ok: true,
    durationMs,
    subprocesses: 1,
    peakStreamBytes: metrics.streamBytes ?? 0,
    results,
  };
};

const hasParity = (single, batch) =>
  single.ok &&
  batch.ok &&
  single.results.length === batch.results.length &&
  single.results.every(
    (value, index) =>
      value.bytes === batch.results[index].bytes &&
      value.binary === batch.results[index].binary &&
      value.contentType === batch.results[index].contentType &&
      value.sha256 === batch.results[index].sha256,
  );

const runCancellationCheck = async (projectId, paths) => {
  const controller = new AbortController();
  const cancelAfterMs = 250;
  const startedAt = performance.now();
  const operation = delegateBatch(projectId, paths, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), cancelAfterMs);
  const result = await operation;
  clearTimeout(timer);
  const durationMs = performance.now() - startedAt;
  return {
    classification: result.ok ? "UNEXPECTED_SUCCESS" : result.error,
    promptTermination: !result.ok && result.error === "CANCELLED" && durationMs <= 5250,
    durationMs: Math.round(durationMs),
  };
};

const main = async () => {
  const args = parseArguments(process.argv.slice(2));
  if (args.error) {
    fail(args.error);
    return;
  }
  if (args.help) {
    usage();
    return;
  }

  const url = args.url ?? process.env.DESIGN_BRIDGE_BENCHMARK_URL;
  const pathValue = args.paths ?? process.env.DESIGN_BRIDGE_BENCHMARK_PATHS;
  const confirmation = args.confirm ?? process.env.DESIGN_BRIDGE_BENCHMARK_CONFIRM;
  const runs = parseRuns(args.runs ?? process.env.DESIGN_BRIDGE_BENCHMARK_RUNS);
  if (!url || !pathValue || confirmation !== REQUIRED_CONFIRMATION || runs === null) {
    usage();
    fail("Explicit URL, paths, confirmation, and an odd run count from 3 through 9 are required");
    return;
  }

  const link = resolveDesignLink(url);
  if (!link.ok) {
    fail(`URL validation failed: ${link.error}`);
    return;
  }
  const parsedPaths = parsePaths(pathValue);
  if (parsedPaths.error) {
    fail(parsedPaths.error);
    return;
  }

  const maxBudgetUsd = Number(process.env.DESIGN_BRIDGE_MAX_BUDGET_USD || 0.25);
  const plannedSubprocesses = runs * (16 + BATCH_SIZES.length) + 1;
  process.stderr.write(
    `Starting opt-in benchmark: ${runs} runs, at most ${plannedSubprocesses} subprocesses, configured ceiling $${maxBudgetUsd.toFixed(2)} per subprocess.\n`,
  );

  const observations = [];
  let allParity = true;
  let allOperationsSucceeded = true;
  for (const size of BATCH_SIZES) {
    const paths = parsedPaths.paths.slice(0, size);
    const sizeRuns = [];
    for (let run = 0; run < runs; run += 1) {
      const single = await runSingles(link.data.projectId, paths);
      const batch = await runBatch(link.data.projectId, paths);
      const parity = hasParity(single, batch);
      allParity = allParity && parity;
      allOperationsSucceeded = allOperationsSucceeded && single.ok && batch.ok;
      sizeRuns.push({ single, batch, parity });
    }
    const singleMedianMs = median(sizeRuns.map((value) => value.single.durationMs));
    const batchMedianMs = median(sizeRuns.map((value) => value.batch.durationMs));
    observations.push({
      files: size,
      runs,
      singleMedianMs: Math.round(singleMedianMs),
      batchMedianMs: Math.round(batchMedianMs),
      improvementPercent: Number(
        (((singleMedianMs - batchMedianMs) / singleMedianMs) * 100).toFixed(1),
      ),
      subprocesses: {
        single: size * runs,
        batch: runs,
      },
      peakStreamBytes: {
        single: Math.max(...sizeRuns.map((value) => value.single.peakStreamBytes)),
        batch: Math.max(...sizeRuns.map((value) => value.batch.peakStreamBytes)),
      },
      exactByteAndHashParity: sizeRuns.every((value) => value.parity),
      sampleKinds: {
        text:
          sizeRuns[0].single.results?.filter((value) => !value.binary).length ??
          0,
        binary:
          sizeRuns[0].single.results?.filter((value) => value.binary).length ??
          0,
      },
      classifications: sizeRuns.map((value) => ({
        single: value.single.ok ? "SUCCESS" : value.single.error,
        batch: value.batch.ok ? "SUCCESS" : value.batch.error,
      })),
    });
  }

  const cancellation = await runCancellationCheck(
    link.data.projectId,
    parsedPaths.paths.slice(0, Math.max(...BATCH_SIZES)),
  );
  const performanceGate = observations
    .filter((value) => value.files >= 3)
    .every((value) => value.improvementPercent >= 25);
  const fullSample = observations.find(
    (value) => value.files === Math.max(...BATCH_SIZES),
  );
  const sampleCoverage =
    fullSample?.sampleKinds.text > 0 && fullSample?.sampleKinds.binary > 0;
  const gatePassed =
    allOperationsSucceeded &&
    allParity &&
    sampleCoverage &&
    performanceGate &&
    cancellation.promptTermination;
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        configuredBudgetCeilingUsd: maxBudgetUsd,
        observations,
        cancellation,
        gate: {
          exactParity: allParity,
          includesTextAndBinary: sampleCoverage,
          atLeast25PercentFasterForThreeOrMore: performanceGate,
          samePerOperationBudgetCeiling: true,
          cancellationTerminatesPromptly: cancellation.promptTermination,
          passed: gatePassed,
        },
      },
      null,
      2,
    )}\n`,
  );
  if (!gatePassed) {
    process.exitCode = 2;
  }
};

await main();
