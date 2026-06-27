const cfg = window.MINING_CONFIG || { pollSeconds: 15, fastPollSeconds: 3 };
const GPU_DISPLAY_LIMIT = 12;
const MODE_PAGE_SIZE = 6;

let lastVersion = "";
let lastDataStamp = "";
let pollTimer = null;
let fastPollTimer = null;
let modeHistoryRows = [];
let modePage = 0;
let commandBusy = false;
let pendingVisual = null;
let mandatoryBlocked = false;

function parseVersion(value) {
  if (!value) return [0];
  return String(value)
    .split(/[.\-+]/)
    .map((part) => {
      const match = part.match(/(\d+)/);
      return match ? Number(match[1]) : 0;
    });
}

function versionLt(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return false;
}

function staleThresholdSeconds() {
  const sync = Number(cfg.syncSeconds) || 25;
  const dataPush = Number(cfg.dataPushSeconds) || sync;
  const poll = Number(cfg.pollSeconds) || 15;
  return dataPush + sync * 2 + poll * 2 + 30;
}

function miningModes(status) {
  const modes = ["ergo", "nicehash"];
  if (status?.modes_enabled?.clore) modes.push("clore");
  return modes;
}

function showMandatoryUpdate(minVersion, currentVersion) {
  mandatoryBlocked = true;
  const panel = document.getElementById("mandatory-update");
  const text = document.getElementById("mandatory-update-text");
  if (panel) panel.classList.remove("hidden");
  if (text) {
    text.textContent =
      `Versão ${currentVersion || "?"} — mínimo ${minVersion}. Toque para recarregar.`;
  }
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  } catch {
    return iso;
  }
}

function displayTime(row) {
  return row?.time_brt || row?.ts || "—";
}

function tempClass(v) {
  if (v == null) return "";
  if (v >= 72) return "hot";
  if (v >= 65) return "warn";
  return "ok";
}

function setCmdStatus(text, isError = false) {
  const el = document.getElementById("cmd-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("error", Boolean(isError));
}

function setProfitLine(elementId, lineInfo, fallback) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const text = lineInfo?.text || fallback || "—";
  const best = !!lineInfo?.best;
  el.textContent = best ? `${text}  ★` : text;
  el.classList.toggle("profit-best", best);
}

function updateStateIndicator(status) {
  const el = document.getElementById("state-indicator");
  if (!el) return;
  let visual = status.visual_state;
  if (!visual) {
    if (status.paused) visual = "paused";
    else if (status.mining) visual = "mining";
    else visual = "idle";
  }
  el.className = `state-indicator ${visual}`;
  document.body.dataset.visualState = visual;
  const app = document.getElementById("app-content");
  if (app) app.dataset.visualState = visual;
}

function setModeDisplay(display) {
  const modeEl = document.getElementById("mode");
  document.getElementById("mode-heading").textContent = display?.heading || "Estado";
  modeEl.textContent = display?.primary || "—";
  modeEl.className = "value mode";
  const color = display?.primary_color || "";
  if (color.includes("3ddc") || color.includes("34, 197")) {
    modeEl.classList.add("mode-mining");
  } else if (color.includes("eab") || color.includes("250, 204")) {
    modeEl.classList.add("mode-paused");
  } else {
    modeEl.classList.add("mode-idle");
  }
  document.getElementById("config-line").textContent = display?.config_line || "—";
  document.getElementById("reason").textContent = display?.detail_line || "—";
}

function drawBalanceChart(rows) {
  const canvas = document.getElementById("balance-chart");
  const meta = document.getElementById("balance-chart-meta");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const values = (rows || []).map((r) => Number(r.total_usd || 0));
  if (!values.length) {
    if (meta) meta.textContent = "sem dados";
    ctx.fillStyle = "#8b98a8";
    ctx.font = "12px sans-serif";
    ctx.fillText("Aguardando snapshots…", 10, h / 2);
    return;
  }
  if (meta) meta.textContent = `${values.length} leituras`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 0.0001);
  const points = values.map((v, i) => {
    const x = 8 + (i / Math.max(values.length - 1, 1)) * (w - 16);
    const y = h - 8 - ((v - min) / span) * (h - 16);
    return { x, y };
  });
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.lineTo(points[points.length - 1].x, h);
  ctx.lineTo(points[0].x, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(61, 220, 151, 0.22)");
  grad.addColorStop(1, "rgba(61, 220, 151, 0)");
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "#3ddc97";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
  ctx.fillStyle = "#8b98a8";
  ctx.font = "11px sans-serif";
  ctx.fillText(`$${max.toFixed(2)}`, 8, 14);
  ctx.fillText(`$${min.toFixed(2)}`, 8, h - 4);
}

function renderModeHistory() {
  const totalPages = Math.max(1, Math.ceil(modeHistoryRows.length / MODE_PAGE_SIZE));
  modePage = Math.min(Math.max(0, modePage), totalPages - 1);
  const start = modePage * MODE_PAGE_SIZE;
  const slice = modeHistoryRows.slice(start, start + MODE_PAGE_SIZE);
  document.getElementById("mode-history-meta").textContent =
    modeHistoryRows.length
      ? `pág. ${modePage + 1}/${totalPages}`
      : "sem registros";
  document.getElementById("mode-prev").disabled = modePage <= 0;
  document.getElementById("mode-next").disabled = modePage >= totalPages - 1;
  document.getElementById("mode-history").innerHTML = slice.length
    ? slice.map((row) => `
      <tr>
        <td>${esc(displayTime(row))}</td>
        <td>${esc(row.old_mode)}</td>
        <td>${esc(row.new_mode)}</td>
        <td>${esc(row.reason)}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4" class="muted-cell">Sem dados ainda</td></tr>`;
}

function dataAgeSeconds(iso) {
  if (!iso) return null;
  try {
    return (Date.now() - new Date(iso).getTime()) / 1000;
  } catch {
    return null;
  }
}

function resolveVisualState(status) {
  if (pendingVisual) return pendingVisual;
  if (status.visual_state) return status.visual_state;
  if (status.paused) return "paused";
  if (status.mining) return "mining";
  const modes = miningModes(status);
  if (modes.includes(String(status.mode || "").toLowerCase())) return "mining";
  return "idle";
}

function syncPendingVisual(status) {
  if (!pendingVisual) return;
  if (pendingVisual === "paused" && status.paused) pendingVisual = null;
  else if (pendingVisual === "mining" && !status.paused) {
    const modes = miningModes(status);
    const visual = status.visual_state
      || (status.mining || modes.includes(String(status.mode || "").toLowerCase())
        ? "mining"
        : "idle");
    if (visual === "mining") pendingVisual = null;
  }
}

function updateToggleButton(status) {
  syncPendingVisual(status);
  const visual = resolveVisualState(status);
  const showPause = visual === "mining";
  const toggleBtn = document.getElementById("toggle-btn");
  if (!toggleBtn) return;
  toggleBtn.textContent = showPause ? "Pausar" : "Retomar";
  toggleBtn.classList.toggle("btn-warn", showPause);
  toggleBtn.classList.toggle("btn-primary", !showPause);
  toggleBtn.disabled = commandBusy;
}

function render(data) {
  const status = data.status || {};
  const display = status.display || {};
  const gpu = status.gpu || {};
  const profit = status.profit_usd_day || {};
  const balances = status.balances || {};
  const history = data.history || {};

  setModeDisplay(display);
  updateStateIndicator(status);

  const game = status.game_detection || {};
  document.getElementById("game-status").textContent = game.detected
    ? "Jogo: sim ⚠"
    : "Jogo: não";

  updateToggleButton(status);

  if (balances) {
    document.getElementById("wallet-total").textContent =
      `$${Number(balances.total_usd || 0).toFixed(4)}`;
    document.getElementById("wallet-ergo").textContent =
      `Ergo: ${Number(balances.ergo_combined_erg || 0).toFixed(4)} ERG ($${Number(balances.ergo_combined_usd || 0).toFixed(2)})`;
    document.getElementById("wallet-nh").textContent =
      `NiceHash: ${Number(balances.nicehash_pool_btc || 0).toFixed(8)} BTC ($${Number(balances.nicehash_combined_usd || 0).toFixed(2)})`;
  }

  const tempGpu = gpu.temp_gpu;
  const tempEl = document.getElementById("temp-gpu");
  tempEl.textContent = tempGpu != null ? `${tempGpu}°C` : "—";
  tempEl.className = `value ${tempClass(tempGpu)}`;
  const memTemp = gpu.temp_memory;
  const vramSupported = Boolean(gpu.memory_temp_available);
  const memEl = document.getElementById("temp-memory");
  if (memEl) {
    if (vramSupported && memTemp != null) {
      memEl.hidden = false;
      memEl.textContent = `VRAM ${memTemp}°C`;
      memEl.className = `reason ${tempClass(memTemp)}`;
    } else {
      memEl.hidden = true;
      memEl.textContent = "";
    }
  }
  document.getElementById("power").textContent =
    gpu.power_w != null ? `${gpu.power_w} W` : "—";
  document.getElementById("util").textContent = `Uso ${gpu.util_gpu ?? "—"}%`;

  const lines = display.profit_lines || {};
  setProfitLine(
    "profit-ergo",
    lines.ergo,
    profit?.ergo != null ? `Ergo: $${profit.ergo.toFixed(2)}/dia` : null,
  );
  setProfitLine(
    "profit-nicehash",
    lines.nicehash,
    profit?.nicehash != null ? `NiceHash: $${profit.nicehash.toFixed(2)}/dia` : null,
  );
  const cloreEl = document.getElementById("profit-clore");
  const cloreEnabled = Boolean(status.modes_enabled?.clore);
  if (cloreEl) {
    if (cloreEnabled && (lines.clore || profit?.clore != null)) {
      cloreEl.classList.remove("hidden");
      setProfitLine(
        "profit-clore",
        lines.clore,
        profit?.clore != null ? `Clore: $${profit.clore.toFixed(2)}/dia` : null,
      );
    } else {
      cloreEl.classList.add("hidden");
      cloreEl.textContent = "";
    }
  }
  document.getElementById("profit-power").textContent = display.power_line || "";
  const srcEl = document.getElementById("profit-source");
  if (srcEl) {
    const src = display.profit_source || "";
    srcEl.textContent = src;
    srcEl.hidden = !src;
  }

  const stats = data.stats_24h || {};
  const uptimeEl = document.getElementById("stats-uptime");
  if (uptimeEl) {
    uptimeEl.textContent =
      stats.uptime_percent != null ? `${stats.uptime_percent}% uptime` : "—";
  }
  const mh = stats.avg_hashrate_mh;
  document.getElementById("stats-hashrate").textContent =
    mh != null ? `Hashrate médio: ${Number(mh).toFixed(1)} MH/s` : "Hashrate médio: —";
  const miningMin = stats.mining_minutes;
  document.getElementById("stats-mining").textContent =
    miningMin != null
      ? `Tempo minerando: ${Math.round(miningMin)} min (${stats.mining_hours ?? "—"} h)`
      : "Tempo minerando: —";
  const flips = stats.mode_changes;
  document.getElementById("stats-modes").textContent =
    flips != null ? `Trocas de modo: ${flips}` : "Trocas de modo: —";

  const gpuRows = (history.gpu || []).slice(-GPU_DISPLAY_LIMIT).reverse();
  const showVramCol = vramSupported && gpuRows.some((row) => row.temp_memory != null);
  document.querySelectorAll(".col-vram").forEach((el) => {
    el.hidden = !showVramCol;
  });
  document.getElementById("gpu-history-meta").textContent =
    gpuRows.length ? `últimas ${gpuRows.length} leituras` : "sem leituras";
  const colSpan = showVramCol ? 5 : 4;
  document.getElementById("gpu-history").innerHTML = gpuRows.length
    ? gpuRows.map((row) => `
      <tr>
        <td>${esc(displayTime(row))}</td>
        <td>${esc(row.temp_gpu ?? "—")}</td>
        ${showVramCol ? `<td class="col-vram">${esc(row.temp_memory ?? "—")}</td>` : ""}
        <td>${esc(row.power_w ?? "—")}</td>
        <td>${esc(row.mode)}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="${colSpan}" class="muted-cell">Sem dados ainda</td></tr>`;

  modeHistoryRows = history.modes || [];
  renderModeHistory();
  drawBalanceChart(history.balances || []);

  const ageS = dataAgeSeconds(data.gerado_em);
  const staleEl = document.getElementById("stale-note");
  const threshold = staleThresholdSeconds();
  const critical = threshold * 2;
  if (staleEl) {
    if (ageS != null && ageS > threshold) {
      staleEl.hidden = false;
      staleEl.classList.toggle("stale-critical", ageS > critical);
      const mins = Math.round(ageS / 60);
      if (ageS > critical) {
        staleEl.textContent =
          `Dados com ${mins} min — confira se o app está aberto no PC.`;
      } else {
        staleEl.textContent =
          `Sincronizando… última atualização há ${Math.round(ageS)}s (normal até ~${Math.round(threshold / 60)} min).`;
      }
    } else {
      staleEl.hidden = true;
      staleEl.classList.remove("stale-critical");
      staleEl.textContent = "";
    }
  }
  document.getElementById("page-updated").textContent =
    `Atualizado: ${fmtDate(data.gerado_em)}`;

  const badge = document.getElementById("update-badge");
  if (badge) badge.hidden = true;
}

async function loadAndRender() {
  try {
    const data = await window.fetchMiningData();
    render(data);
    return data;
  } catch (err) {
    if (err.code === "decrypt_failed" || err.message === "locked") {
      window.invalidateSession("Sessao invalida — digite o PIN.");
      return null;
    }
    setCmdStatus(`Erro: ${err.message}`, true);
    return null;
  }
}

async function showAppVersion() {
  try {
    const r = await fetch("./version.json", { cache: "no-store" });
    if (!r.ok) return;
    const v = await r.json();
    const el = document.getElementById("version-label");
    if (el) el.textContent = `v${v.app || "?"}`;
    const minApp = v.min_app || cfg.minAppVersion;
    const running = window.MINING_BUILD || v.app;
    if (minApp && versionLt(running, minApp)) {
      showMandatoryUpdate(minApp, running);
    }
    if (v.deploy_interval_seconds) cfg.deploySeconds = v.deploy_interval_seconds;
    if (v.sync_interval_seconds) cfg.syncSeconds = v.sync_interval_seconds;
    if (v.data_push_seconds) cfg.dataPushSeconds = v.data_push_seconds;
  } catch {
    /* ignore */
  }
}

async function checkVersion() {
  try {
    const r = await fetch("./version.json", { cache: "no-store" });
    if (!r.ok) return;
    const v = await r.json();
    const stamp = v.data_rev || v.data || "";
    const minApp = v.min_app || cfg.minAppVersion;
    const running = window.MINING_BUILD || v.app;
    if (minApp && versionLt(running, minApp)) {
      showMandatoryUpdate(minApp, running);
      return;
    }
    const badge = document.getElementById("update-badge");
    if (lastDataStamp && stamp && stamp !== lastDataStamp) {
      if (badge) badge.hidden = false;
      await loadAndRender();
    } else if (lastVersion && v.app && v.app !== lastVersion) {
      if (badge) badge.hidden = false;
    }
    lastDataStamp = stamp;
    lastVersion = v.app || lastVersion;
  } catch {
    /* ignore */
  }
}

function startFastPoll() {
  if (fastPollTimer) clearInterval(fastPollTimer);
  let ticks = 0;
  const maxTicks = 25;
  const ms = Math.max(2, (cfg.fastPollSeconds || 3) * 1000);
  fastPollTimer = setInterval(async () => {
    await checkVersion();
    await loadAndRender();
    ticks += 1;
    if (ticks >= maxTicks) {
      clearInterval(fastPollTimer);
      fastPollTimer = null;
    }
  }, ms);
}

async function runCommand(action, label) {
  if (mandatoryBlocked) {
    setCmdStatus("Atualize o painel antes de enviar comandos.", true);
    return;
  }
  if (commandBusy) {
    setCmdStatus("Aguarde o comando anterior…", true);
    return;
  }
  if (typeof window.sendRemoteCommand !== "function") {
    setCmdStatus("Controle remoto indisponivel.", true);
    return;
  }
  commandBusy = true;
  const toggleBtn = document.getElementById("toggle-btn");
  if (action === "toggle" && toggleBtn) {
    const willPause = toggleBtn.textContent.trim() === "Pausar";
    pendingVisual = willPause ? "paused" : "mining";
    updateStateIndicator({ visual_state: pendingVisual });
    toggleBtn.textContent = willPause ? "Retomar" : "Pausar";
    toggleBtn.classList.toggle("btn-warn", !willPause);
    toggleBtn.classList.toggle("btn-primary", willPause);
  }
  setCmdStatus(`Enviando: ${label}…`);
  try {
    await window.sendRemoteCommand(action);
    setCmdStatus(`${label} enviado — atualizando…`);
    startFastPoll();
    setTimeout(() => loadAndRender(), 1500);
  } catch (err) {
    setCmdStatus(err.message || "Falha ao enviar.", true);
  } finally {
    commandBusy = false;
  }
}

function wireRefreshButtons() {
  const refresh = async () => {
    const btn = document.getElementById("btn-refresh");
    const inline = document.getElementById("btn-refresh-inline");
    if (btn) btn.disabled = true;
    if (inline) inline.disabled = true;
    setCmdStatus("Atualizando…");
    try {
      await loadAndRender();
      setCmdStatus("Atualizado.");
      const badge = document.getElementById("update-badge");
      if (badge) badge.hidden = true;
    } catch {
      setCmdStatus("Falha ao atualizar.", true);
    } finally {
      if (btn) btn.disabled = false;
      if (inline) inline.disabled = false;
    }
  };
  document.getElementById("btn-refresh")?.addEventListener("click", refresh);
  document.getElementById("btn-refresh-inline")?.addEventListener("click", refresh);
}

function wireControls() {
  document.getElementById("toggle-btn")?.addEventListener("click", () => {
    runCommand("toggle", document.getElementById("toggle-btn")?.textContent || "Alternar");
  });
  document.getElementById("btn-auto")?.addEventListener("click", () => runCommand("auto", "Automático"));
  document.getElementById("btn-ergo")?.addEventListener("click", () => runCommand("manual:ergo", "Ergo"));
  document.getElementById("btn-nicehash")?.addEventListener("click", () => runCommand("manual:nicehash", "NiceHash"));
  document.getElementById("btn-restart")?.addEventListener("click", () => runCommand("restart", "Reiniciar"));
  document.getElementById("mode-prev")?.addEventListener("click", () => {
    modePage -= 1;
    renderModeHistory();
  });
  document.getElementById("mode-next")?.addEventListener("click", () => {
    modePage += 1;
    renderModeHistory();
  });
}

function wireMandatoryReload() {
  document.getElementById("btn-mandatory-reload")?.addEventListener("click", async () => {
    let build = window.MINING_BUILD || "";
    try {
      const r = await fetch("./version.json", { cache: "no-store" });
      if (r.ok) {
        const v = await r.json();
        build = v.app || build;
      }
    } catch {
      /* offline */
    }
    const url = new URL(location.href);
    url.searchParams.set("b", build || String(Date.now()));
    location.replace(url.toString());
  });
}

window.startMiningApp = function startMiningApp() {
  wireControls();
  wireRefreshButtons();
  wireMandatoryReload();
  showAppVersion();
  loadAndRender();
  if (pollTimer) clearInterval(pollTimer);
  const ms = Math.max(10, (cfg.pollSeconds || 15) * 1000);
  pollTimer = setInterval(async () => {
    await checkVersion();
    await loadAndRender();
  }, ms);
};