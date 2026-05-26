/**
 * eval_rag.mjs — RAG Precision@K Evaluator for CodeFox
 *
 * Mirrors the exact flow in src/modules/ai/lib/rag.ts:
 *   generateEmbedding() → pineconeIndex.query() → retrieveContext()
 *
 * Usage:
 *   PINECONE_DB_API_KEY=xxx GOOGLE_GENERATIVE_AI_API_KEY=xxx \
 *     node eval_rag.mjs --queries test_queries.json --k 7 --output ./evaluation/results
 *
 * Options:
 *   --queries <file>    Path to test queries JSON file (default: test_queries.json)
 *   --k <number>        Top-K for retrieval (default: 7)
 *   --output <dir>      Output directory for results JSON (default: ./evaluation/results)
 *
 * test_queries.json format:
 * [
 *   {
 *     "query": "GitHub webhook ingestion handler",
 *     "repoId": "dravynx/CodeFox",
 *     "relevantFiles": [
 *       "src/app/api/webhooks/github/route.ts",
 *       "src/inngest/functions/review.ts"
 *     ]
 *   }
 * ]
 */

import { Pinecone } from "@pinecone-database/pinecone";
import { embed } from "ai";
import { google } from "@ai-sdk/google";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const PINECONE_INDEX = "codefox-vector-embedding";
const EMBEDDING_MODEL = "gemini-embedding-001"; // same as rag.ts
const DEFAULT_K = 7;                             // same as rag.ts default topK
const EMBEDDING_DELAY_MS = 12000;                // 5 RPM = 1 request per 12 seconds (rate limit)

// ─── PARSE ARGS ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const queriesFileIdx = args.indexOf("--queries");
const topKIdx = args.indexOf("--k");
const outputIdx = args.indexOf("--output");

const queriesFile = queriesFileIdx !== -1
  ? args[queriesFileIdx + 1]
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "test_queries.json");
const topK = topKIdx !== -1 ? parseInt(args[topKIdx + 1]) : DEFAULT_K;
const resultsDir = outputIdx !== -1 ? args[outputIdx + 1] : "./evaluation/results";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CLIENTS (mirrors src/lib/pinecone.ts + rag.ts) ──────────────────────────

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_DB_API_KEY });
const pineconeIndex = pinecone.Index(PINECONE_INDEX);

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Mirrors generateEmbedding() in rag.ts exactly.
 * Returns { embedding, apiTimingMs } where apiTimingMs excludes rate-limit sleep.
 */
async function generateEmbedding(text) {
  if (!text || typeof text !== "string" || text.trim().length === 0) 
    return { embedding: null, apiTimingMs: 0 };

  const sanitized = text.replace(/\s+/g, " ").trim().slice(0, 8000);

  await sleep(EMBEDDING_DELAY_MS); // Rate-limit wait (not counted in API latency)

  const apiStart = Date.now();
  const result = await embed({
    model: google.embedding("gemini-embedding-001"),
    value: sanitized,
  });
  const apiTimingMs = Date.now() - apiStart;

  return { embedding: result?.embedding ?? null, apiTimingMs };
}

/**
 * Mirrors retrieveContext() in rag.ts exactly.
 * Returns { files, timingMs } where timingMs is ONLY the Pinecone query time (excluding embedding sleep).
 * Includes retry logic with exponential backoff for transient Pinecone errors.
 */
async function retrieveFilePaths(query, repoId, k, maxRetries = 3, baseDelayMs = 1000) {
  const { embedding: queryEmbedding, apiTimingMs: embeddingTimingMs } = await generateEmbedding(query);
  if (!queryEmbedding) return { files: [], timingMs: 0, embeddingTimingMs: 0 };

  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const queryStart = Date.now();
      const response = await pineconeIndex.query({
        vector: queryEmbedding,
        filter: { repoId: { $eq: repoId } },
        topK: k,
        includeMetadata: true,
      });
      const queryTimingMs = Date.now() - queryStart;

      const files = (response.matches || [])
        .map((m) => m.metadata?.filePath)
        .filter(Boolean);

      return { files, timingMs: queryTimingMs, embeddingTimingMs };
    } catch (error) {
      lastError = error;
      const statusCode = error.status || error.code;
      const isRetryable = statusCode >= 500 || statusCode === 429; // 5xx or rate limit

      if (!isRetryable || attempt === maxRetries - 1) {
        throw error;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt); // exponential backoff
      console.warn(
        `  ⚠️  Query failed (${statusCode}). Retry ${attempt + 1}/${maxRetries - 1} in ${delayMs}ms...`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

// ─── METRICS ─────────────────────────────────────────────────────────────────

/**
 * Precision@K: fraction of retrieved files that are relevant.
 *   precision@k = |retrieved ∩ relevant| / k
 */
function precisionAtK(retrieved, relevant, k) {
  const topK = retrieved.slice(0, k);
  const hits = topK.filter((f) => relevant.includes(f)).length;
  return hits / k;
}

/**
 * Recall@K: fraction of relevant files that were retrieved.
 *   recall@k = |retrieved ∩ relevant| / |relevant|
 */
function recallAtK(retrieved, relevant, k) {
  if (relevant.length === 0) return 1;
  const topK = retrieved.slice(0, k);
  const hits = topK.filter((f) => relevant.includes(f)).length;
  return hits / relevant.length;
}

/**
 * Hit Rate@K: was at least one relevant file in top-K? (1 or 0)
 */
function hitRateAtK(retrieved, relevant, k) {
  const topK = retrieved.slice(0, k);
  return topK.some((f) => relevant.includes(f)) ? 1 : 0;
}

/**
 * Save results to a JSON file with timestamp and metadata.
 */
function saveResults(results, config) {
  const timestamp = new Date().toISOString();
  const filename = `rag_eval_${Date.now()}.json`;
  const filepath = path.join(resultsDir, filename);

  const output = {
    metadata: {
      timestamp,
      index: PINECONE_INDEX,
      topK: config.topK,
      queriesFile: config.queriesFile,
      totalQueries: config.totalQueries,
    },
    aggregate: config.aggregate,
    detailed: results,
    summary: {
      resumeLine:
        `...enabling a RAG-based retrieval system with top-${config.topK} similarity search, ` +
        `achieving ${(config.aggregate.precision * 100).toFixed(0)}% precision@${config.topK} and ` +
        `${(config.aggregate.hitRate * 100).toFixed(0)}% hit rate across ${config.totalQueries} test queries, ` +
        `with p95 retrieval latency of ${config.aggregate.p95QueryLatency}ms.`,
    },
  };

  // Create directory if it doesn't exist
  try {
    mkdirSync(path.dirname(filepath), { recursive: true });
  } catch (e) {
    // Directory may already exist, ignore
  }

  writeFileSync(filepath, JSON.stringify(output, null, 2));
  return filepath;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  let queries;
  try {
    queries = JSON.parse(readFileSync(queriesFile, "utf-8"));
  } catch (e) {
    console.error(`❌  Could not load queries file: ${queriesFile}`);
    console.error(`   ${e.message}`);
    process.exit(1);
  }

  console.log(`\n🔍 Evaluating RAG — index: "${PINECONE_INDEX}" | k=${topK} | queries: ${queries.length}\n`);
  console.log("─".repeat(80));

  const results = [];

  for (const q of queries) {
    const { files: retrieved, timingMs, embeddingTimingMs } = await retrieveFilePaths(q.query, q.repoId, topK);

    const p = precisionAtK(retrieved, q.relevantFiles, topK);
    const r = recallAtK(retrieved, q.relevantFiles, topK);
    const hit = hitRateAtK(retrieved, q.relevantFiles, topK);

    results.push({ 
      query: q.query, 
      precision: p, 
      recall: r, 
      hit, 
      latencyMs: timingMs,  // Pinecone query latency only
      embeddingLatencyMs: embeddingTimingMs,  // Embedding API latency
      retrieved, 
      relevant: q.relevantFiles 
    });

    console.log(`Query: "${q.query}"`);
    console.log(`  Precision@${topK}: ${(p * 100).toFixed(1)}%  |  Recall@${topK}: ${(r * 100).toFixed(1)}%  |  Hit: ${hit ? "✅" : "❌"}  |  Query: ${timingMs}ms, Embedding: ${embeddingTimingMs}ms`);
    console.log(`  Retrieved: ${retrieved.join(", ") || "(none)"}`);
    console.log(`  Expected:  ${q.relevantFiles.join(", ")}`);
    console.log();
  }

  // ─── AGGREGATE ───────────────────────────────────────────────────────────────

  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

  const avgPrecision = avg(results.map((r) => r.precision));
  const avgRecall = avg(results.map((r) => r.recall));
  const avgHitRate = avg(results.map((r) => r.hit));
  const avgQueryLatency = avg(results.map((r) => r.latencyMs));
  const avgEmbeddingLatency = avg(results.map((r) => r.embeddingLatencyMs));
  const p95QueryLatency = results.map((r) => r.latencyMs).sort((a, b) => a - b)[Math.floor(results.length * 0.95)] ?? avgQueryLatency;

  console.log("─".repeat(80));
  console.log("📊 AGGREGATE RESULTS");
  console.log("─".repeat(80));
  console.log(`  Mean Precision@${topK}      : ${(avgPrecision * 100).toFixed(1)}%`);
  console.log(`  Mean Recall@${topK}         : ${(avgRecall * 100).toFixed(1)}%`);
  console.log(`  Hit Rate@${topK}            : ${(avgHitRate * 100).toFixed(1)}%`);
  console.log(`  Avg Query Latency         : ${avgQueryLatency.toFixed(0)}ms`);
  console.log(`  p95 Query Latency         : ${p95QueryLatency}ms`);
  console.log(`  Avg Embedding Latency     : ${avgEmbeddingLatency.toFixed(0)}ms`);
  console.log();
  // ─── SAVE RESULTS ─────────────────────────────────────────────────────────

  const aggregateMetrics = {
    precision: avgPrecision,
    recall: avgRecall,
    hitRate: avgHitRate,
    avgQueryLatency,
    p95QueryLatency,
    avgEmbeddingLatency,
  };

  try {
    const filepath = saveResults(results, {
      topK,
      queriesFile,
      totalQueries: queries.length,
      aggregate: aggregateMetrics,
    });
    console.log(`💾 Results saved to: ${filepath}`);
    console.log();
  } catch (e) {
    console.warn(`⚠️  Failed to save results: ${e.message}`);
  }
  // ─── TIMING BREAKDOWN ────────────────────────────────────────────────────

  const totalRateLimitWait = EMBEDDING_DELAY_MS * queries.length;
  console.log("⏱️  TIMING BREAKDOWN");
  console.log("─".repeat(80));
  console.log(`  Total Queries              : ${queries.length}`);
  console.log(`  Avg Query Latency          : ${avgQueryLatency.toFixed(0)}ms (actual Pinecone API)`);
  console.log(`  Avg Embedding Latency      : ${avgEmbeddingLatency.toFixed(0)}ms (actual API call)`);
  console.log(`  Rate-Limit Wait/Query      : ${EMBEDDING_DELAY_MS}ms (not included in latency metrics)`);
  console.log(`  Total Rate-Limit Wait      : ${totalRateLimitWait}ms (${(totalRateLimitWait / 1000).toFixed(1)}s)`);
  console.log(`  Total Actual API Time      : ${(avgQueryLatency * queries.length).toFixed(0)}ms (queries + embeddings)`);
  console.log();
  // ─── RESUME BULLET NUMBERS ────────────────────────────────────────────────

  console.log("💼 RESUME-READY NUMBERS");
  console.log("─".repeat(80));
  console.log(
    `  "...enabling a RAG-based retrieval system with top-${topK} similarity search, ` +
    `achieving ${(avgPrecision * 100).toFixed(0)}% precision@${topK} and ` +
    `${(avgHitRate * 100).toFixed(0)}% hit rate across ${queries.length} test queries, ` +
    `with p95 retrieval latency of ${p95QueryLatency}ms."`
  );
  console.log();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
