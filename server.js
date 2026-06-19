import express from "express";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const ENTITY = "mikusdevr";
const PROJECT = "privacy-filter-causal";

const GRAPHQL_QUERY = `query RunsStateDeltaQuery_DD_DQ_U_RSDQ($aggregationKeys: [String!], $configKeys: [String!], $currentRuns: [String!]!, $enableAggregations: Boolean = false, $enableArtifactCounts: Boolean = false, $enableBasic: Boolean = true, $enableConfig: Boolean = false, $enableHistoryKeyInfo: Boolean = false, $enableSampledHistory: Boolean = false, $enableSummary: Boolean = false, $enableSystemMetrics: Boolean = true, $enableTags: Boolean = true, $enableWandb: Boolean = false, $entityName: String!, $filters: JSONString!, $groupKeys: [String!]!, $groupLevel: Int!, $lastUpdated: DateTime!, $limit: Int!, $order: String!, $projectName: String!, $sampledHistorySpecs: [JSONString!]!, $summaryKeys: [String!], $wandbKeys: [String!]) {
  project(name: $projectName, entityName: $entityName) {
    id
    runs(
      first: $limit
      order: $order
      filters: $filters
      groupKeys: $groupKeys
      groupLevel: $groupLevel
    ) {
      totalCount
      delta(currentRuns: $currentRuns, lastUpdated: $lastUpdated) {
        index
        op
        run {
          id
          name
          projectId
          displayName
          updatedAt
          ...ArtifactCountsFragment @include(if: $enableArtifactCounts)
          ...RunStateBasicFragment @include(if: $enableBasic)
          aggregations(keys: $aggregationKeys) @include(if: $enableAggregations)
          config(keys: $configKeys) @include(if: $enableConfig)
          historyKeys(format: PLAINTEXT) @include(if: $enableHistoryKeyInfo)
          sampledHistory(specs: $sampledHistorySpecs, packVersion: 1) @include(if: $enableSampledHistory)
          summaryMetrics(keys: $summaryKeys) @include(if: $enableSummary)
          systemMetrics @include(if: $enableSystemMetrics)
          tags: tagColors @include(if: $enableTags) {
            id
            name
            colorIndex
            __typename
          }
          wandbConfig(keys: $wandbKeys) @include(if: $enableWandb)
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment ArtifactCountsFragment on Run {
  inputArtifacts { totalCount __typename }
  outputArtifacts { totalCount __typename }
  __typename
}
fragment RunStateBasicFragment on Run {
  ...RunWithoutRunInfoStateBasicFragment
  ...RunInfoFragment
  __typename
}
fragment RunWithoutRunInfoStateBasicFragment on Run {
  agent { id name __typename }
  commit computeSeconds createdAt defaultColorIndex displayName
  framework github group groupCounts heartbeatAt host jobType logLineCount
  notes projectId readOnly shouldStop state stopped
  sweep { id name displayName config __typename }
  user { id username photoUrl __typename }
  __typename
}
fragment RunInfoFragment on Run {
  runInfo { gpu gpuCount codePath codePathLocal __typename }
  __typename
}`;

const SPECS = [
  { key: "train/loss", label: "train_loss" },
  { key: "train/ppl", label: "train_ppl" },
  { key: "train/tok_per_sec", label: "train_tok_per_sec" },
  { key: "eval/loss", label: "eval_loss" },
  { key: "eval/ppl", label: "eval_ppl" },
];

const metricsCache = new Map(); // runName -> { data, time }
const METRICS_TTL = 30_000;

let runsCache = null;
let runsCacheTime = 0;
const RUNS_TTL = 60_000;

async function wandbPost(variables) {
  const res = await fetch("https://api.wandb.ai/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://wandb.ai",
      "x-origin": "https://wandb.ai",
    },
    body: JSON.stringify({
      operationName: "RunsStateDeltaQuery_DD_DQ_U_RSDQ",
      variables,
      query: GRAPHQL_QUERY,
    }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message || "GraphQL error");
  return json;
}

async function fetchRuns() {
  const now = Date.now();
  if (runsCache && now - runsCacheTime < RUNS_TTL) return runsCache;

  const json = await wandbPost({
    enableAggregations: false,
    enableBasic: true,
    enableConfig: false,
    enableSampledHistory: false,
    enableSummary: false,
    enableSystemMetrics: false,
    enableWandb: false,
    configKeys: [],
    entityName: ENTITY,
    filters: "{}",
    groupKeys: [],
    groupLevel: 0,
    limit: 30,
    order: "-updatedAt",
    projectName: PROJECT,
    sampledHistorySpecs: [],
    summaryKeys: [],
    currentRuns: [],
    lastUpdated: "1970-01-01T00:00:00.000Z",
  });

  const delta = json.data?.project?.runs?.delta ?? [];
  runsCache = delta
    .map((d) => ({
      name: d.run.name,
      displayName: d.run.displayName,
      state: d.run.state,
      updatedAt: d.run.updatedAt,
    }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  runsCacheTime = now;
  return runsCache;
}

async function fetchMetrics(runName) {
  const sampledHistorySpecs = SPECS.map((s) =>
    JSON.stringify({ keys: [s.key, "_step"], samples: 9007199254740991 }),
  );

  const json = await wandbPost({
    enableAggregations: false,
    enableBasic: true,
    enableConfig: true,
    enableSampledHistory: true,
    enableSummary: true,
    enableSystemMetrics: true,
    enableWandb: false,
    configKeys: [],
    entityName: ENTITY,
    filters: JSON.stringify({ name: runName }),
    groupKeys: [],
    groupLevel: 0,
    limit: 1,
    order: "-createdAt",
    panelType: "Run History Line Plot",
    projectName: PROJECT,
    sampledHistorySpecs,
    summaryKeys: [],
    currentRuns: [],
    lastUpdated: "1970-01-01T00:00:00.000Z",
  });

  const delta = json.data?.project?.runs?.delta ?? [];
  if (!delta.length)
    return { metrics: {}, runInfo: null, fetchedAt: Date.now() };

  const run = delta[0].run;
  const sampledHistory = run.sampledHistory ?? [];

  const metrics = {};
  for (let i = 0; i < SPECS.length; i++) {
    const { key, label } = SPECS[i];
    const rows = sampledHistory[i] ?? [];
    metrics[label] = rows
      .filter((r) => r[key] != null && r["_step"] != null)
      .map((r) => ({ step: r["_step"], value: r[key] }))
      .sort((a, b) => a.step - b.step);
  }

  const runInfo = {
    name: run.name,
    displayName: run.displayName,
    state: run.state,
    updatedAt: run.updatedAt,
    host: run.host,
    gpu: run.runInfo?.gpu,
    gpuCount: run.runInfo?.gpuCount,
  };

  return { metrics, runInfo, fetchedAt: Date.now() };
}

app.get("/api/runs", async (req, res) => {
  try {
    runsCache = null; // always fresh on explicit request
    const runs = await fetchRuns();
    res.json({ runs });
  } catch (e) {
    console.error("Runs fetch error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/metrics", async (req, res) => {
  let runName = req.query.run;

  if (!runName) {
    try {
      const runs = await fetchRuns();
      const alive = runs.find((r) => r.state === "running");
      runName = alive?.name ?? runs[0]?.name;
    } catch (e) {
      return res.status(500).json({ error: "Could not resolve run: " + e.message });
    }
  }

  if (!runName) return res.status(400).json({ error: "No runs found" });

  const now = Date.now();
  const cached = metricsCache.get(runName);
  if (cached && now - cached.time < METRICS_TTL) return res.json(cached.data);

  try {
    const data = await fetchMetrics(runName);
    metricsCache.set(runName, { data, time: now });
    res.json(data);
  } catch (e) {
    console.error("Fetch error:", e.message);
    if (cached) return res.json({ ...cached.data, stale: true });
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
