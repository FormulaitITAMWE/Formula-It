"use strict";

const DATA_SOURCE = new URL("./data/formulait.ttl", window.location.href).href;
const QUERY_FILES = {
  entries: "./queries/entries.rq",
  "entry-details": "./queries/entry-details.rq",
  attestations: "./queries/attestations.rq",
  "discontinuous-attestations": "./queries/discontinuous-attestations.rq",
  components: "./queries/components.rq",
  "missing-complit-links": "./queries/missing-complit-links.rq",
  frequencies: "./queries/frequencies.rq",
};
const MAX_DISPLAY_ROWS = 1000;
const engine = new Comunica.QueryEngine();

const querySelect = document.getElementById("query-select");
const queryEditor = document.getElementById("query-editor");
const runButton = document.getElementById("run-query");
const clearButton = document.getElementById("clear-query");
const downloadButton = document.getElementById("download-csv");
const statusElement = document.getElementById("status");
const summaryElement = document.getElementById("result-summary");
const table = document.getElementById("results-table");
const tableHead = table.querySelector("thead");
const tableBody = table.querySelector("tbody");
const rdfResults = document.getElementById("rdf-results");

let currentRows = [];
let currentColumns = [];
let queryTimer = null;
let queryStartTime = null;

console.log("Formula-it source:", DATA_SOURCE);

function setStatus(message, className = "") {
  statusElement.textContent = message;
  statusElement.className = className;
}

function waitForRepaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function startQueryTimer() {
  queryStartTime = performance.now();
  if (queryTimer !== null) clearInterval(queryTimer);
  queryTimer = setInterval(() => {
    const elapsed = ((performance.now() - queryStartTime) / 1000).toFixed(1);
    setStatus(`Query in corso: caricamento e analisi del dataset… ${elapsed} s`, "running");
  }, 500);
}

function stopQueryTimer() {
  if (queryTimer !== null) clearInterval(queryTimer);
  queryTimer = null;
}

function clearResults() {
  tableHead.innerHTML = "";
  tableBody.innerHTML = "";
  rdfResults.textContent = "";
  rdfResults.hidden = true;
  table.hidden = false;
  summaryElement.textContent = "";
  currentRows = [];
  currentColumns = [];
  downloadButton.disabled = true;
}

async function loadQuery(queryName) {
  const path = QUERY_FILES[queryName];
  if (!path) return;
  setStatus("Caricamento della query…", "running");
  try {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Impossibile caricare ${path}: HTTP ${response.status}`);
    queryEditor.value = await response.text();
    setStatus("Query caricata. Puoi modificarla prima dell’esecuzione.");
  } catch (error) {
    console.error(error);
    setStatus(error.message, "error");
  }
}

function detectQueryType(query) {
  const match = query.match(/\b(SELECT|ASK|CONSTRUCT|DESCRIBE)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function termToDisplay(term) {
  if (!term) return "";
  if (term.termType === "Literal") {
    let value = term.value;
    if (term.language) value += `@${term.language}`;
    else if (term.datatype?.value && term.datatype.value !== "http://www.w3.org/2001/XMLSchema#string") {
      value += `^^${term.datatype.value}`;
    }
    return value;
  }
  return term.value ?? String(term);
}

function extractSelectVariables(query) {
  const selectMatch = query.match(/\bSELECT\s+(?:DISTINCT\s+|REDUCED\s+)?([\s\S]*?)\bWHERE\b/i);
  if (!selectMatch) return [];
  const selectPart = selectMatch[1].trim();
  if (selectPart === "*") return [];
  return [...selectPart.matchAll(/\?([A-Za-z_][A-Za-z0-9_-]*)/g)].map((match) => match[1]);
}

function getBindingTerm(binding, variableName) {
  return binding.get(variableName) ?? binding.get(`?${variableName}`);
}

function bindingToObject(binding, variables) {
  const row = {};
  for (const variableName of variables) {
    row[variableName] = termToDisplay(getBindingTerm(binding, variableName));
  }
  return row;
}

function renderTable(rows, variables = []) {
  tableHead.innerHTML = "";
  tableBody.innerHTML = "";
  const columnSet = new Set(variables);
  for (const row of rows) {
    for (const column of Object.keys(row)) columnSet.add(column);
  }
  currentColumns = [...columnSet];
  if (currentColumns.length === 0) {
    summaryElement.textContent = "La query non ha restituito colonne.";
    return;
  }
  const headerRow = document.createElement("tr");
  for (const column of currentColumns) {
    const th = document.createElement("th");
    th.textContent = `?${column}`;
    headerRow.appendChild(th);
  }
  tableHead.appendChild(headerRow);
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const column of currentColumns) {
      const td = document.createElement("td");
      const value = row[column] ?? "";
      if (value.startsWith("http://") || value.startsWith("https://")) {
        const link = document.createElement("a");
        link.href = value;
        link.textContent = value;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        td.appendChild(link);
      } else {
        td.textContent = value;
      }
      tr.appendChild(td);
    }
    tableBody.appendChild(tr);
  }
  currentRows = rows;
  downloadButton.disabled = rows.length === 0;
}

async function runSelect(query) {
  const variables = extractSelectVariables(query);
  if (variables.length === 0) {
    throw new Error("Usa variabili SELECT esplicite, per esempio SELECT ?s ?p ?o. SELECT * non è ancora supportato.");
  }
  setStatus("Avvio del motore SPARQL e caricamento del Turtle…", "running");
  await waitForRepaint();
  const stream = await engine.queryBindings(query, { sources: [DATA_SOURCE] });
  const rows = [];
  let truncated = false;
  let receivedFirstBinding = false;
  setStatus("Dataset raggiunto. Analisi RDF in corso…", "running");
  await waitForRepaint();
  for await (const binding of stream) {
    if (!receivedFirstBinding) {
      receivedFirstBinding = true;
      setStatus("Primi risultati ricevuti. Costruzione della tabella…", "running");
      await waitForRepaint();
    }
    rows.push(bindingToObject(binding, variables));
    if (rows.length >= MAX_DISPLAY_ROWS) {
      truncated = true;
      if (typeof stream.destroy === "function") stream.destroy();
      break;
    }
  }
  renderTable(rows, variables);
  summaryElement.textContent = truncated
    ? `Mostrate le prime ${MAX_DISPLAY_ROWS} righe.`
    : `${rows.length} righe restituite.`;
}

async function runAsk(query) {
  setStatus("Esecuzione della query ASK…", "running");
  await waitForRepaint();
  const answer = await engine.queryBoolean(query, { sources: [DATA_SOURCE] });
  rdfResults.hidden = false;
  table.hidden = true;
  rdfResults.textContent = answer ? "true" : "false";
  summaryElement.textContent = "Risultato ASK.";
}

function termToRdfText(term) {
  if (!term) return "";
  if (term.termType === "NamedNode") return `<${term.value}>`;
  if (term.termType === "BlankNode") return `_:${term.value}`;
  if (term.termType === "Literal") {
    const escaped = term.value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
    if (term.language) return `"${escaped}"@${term.language}`;
    if (term.datatype?.value) return `"${escaped}"^^<${term.datatype.value}>`;
    return `"${escaped}"`;
  }
  return term.value ?? String(term);
}

function quadToText(quad) {
  const graphPart = quad.graph && quad.graph.termType !== "DefaultGraph"
    ? ` ${termToRdfText(quad.graph)}`
    : "";
  return `${termToRdfText(quad.subject)} ${termToRdfText(quad.predicate)} ${termToRdfText(quad.object)}${graphPart} .`;
}

async function runQuadQuery(query) {
  setStatus("Esecuzione della query RDF…", "running");
  await waitForRepaint();
  const stream = await engine.queryQuads(query, { sources: [DATA_SOURCE] });
  const lines = [];
  let truncated = false;
  for await (const quad of stream) {
    lines.push(quadToText(quad));
    if (lines.length >= MAX_DISPLAY_ROWS) {
      truncated = true;
      if (typeof stream.destroy === "function") stream.destroy();
      break;
    }
  }
  table.hidden = true;
  rdfResults.hidden = false;
  rdfResults.textContent = lines.join("\n");
  summaryElement.textContent = truncated
    ? `Mostrate le prime ${MAX_DISPLAY_ROWS} triple.`
    : `${lines.length} triple restituite.`;
}

async function executeQuery() {
  const query = queryEditor.value.trim();
  if (!query) {
    setStatus("Inserisci una query SPARQL.", "error");
    return;
  }
  const queryType = detectQueryType(query);
  if (!queryType) {
    setStatus("Tipo di query non riconosciuto. Usa SELECT, ASK, CONSTRUCT o DESCRIBE.", "error");
    return;
  }
  clearResults();
  runButton.disabled = true;
  querySelect.disabled = true;
  clearButton.disabled = true;
  const originalButtonText = runButton.textContent;
  runButton.textContent = "Query in corso…";
  startQueryTimer();
  await waitForRepaint();
  try {
    if (queryType === "SELECT") await runSelect(query);
    else if (queryType === "ASK") await runAsk(query);
    else await runQuadQuery(query);
    const elapsed = ((performance.now() - queryStartTime) / 1000).toFixed(2);
    setStatus(`Query completata in ${elapsed} secondi.`, "success");
  } catch (error) {
    console.error(error);
    setStatus(`Errore durante la query: ${error.message}`, "error");
  } finally {
    stopQueryTimer();
    runButton.disabled = false;
    querySelect.disabled = false;
    clearButton.disabled = false;
    runButton.textContent = originalButtonText;
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function downloadCsv() {
  if (!currentRows.length) return;
  const lines = [currentColumns.map(csvEscape).join(",")];
  for (const row of currentRows) {
    lines.push(currentColumns.map((column) => csvEscape(row[column])).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "formulait-query-results.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

querySelect.addEventListener("change", () => loadQuery(querySelect.value));
runButton.addEventListener("click", executeQuery);
clearButton.addEventListener("click", () => {
  querySelect.value = "";
  queryEditor.value = "";
  clearResults();
  setStatus("Editor pulito. Scrivi una nuova query SPARQL.");
});
downloadButton.addEventListener("click", downloadCsv);
querySelect.value = "entries";
loadQuery("entries");
