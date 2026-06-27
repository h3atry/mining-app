(async function boot() {
  const cacheBust = Date.now();
  let build = "dev";

  try {
    const res = await fetch(`version.json?_=${cacheBust}`, { cache: "no-store" });
    if (res.ok) {
      const meta = await res.json();
      build = String(meta.app || build);
      if (meta.min_app) {
        window.MINING_MIN_APP = String(meta.min_app);
      }
      if (meta.deploy_interval_seconds) {
        window.MINING_DEPLOY_SECONDS = meta.deploy_interval_seconds;
      }
      if (meta.integrity && typeof meta.integrity === "object") {
        window.MINING_INTEGRITY = meta.integrity;
      }
    }
  } catch {
    /* offline ou primeira carga */
  }

  function versionParts(value) {
    return String(value || "0").split(/[.\-+]/).map((p) => {
      const m = p.match(/(\d+)/);
      return m ? Number(m[1]) : 0;
    });
  }

  function versionBelow(left, right) {
    const a = versionParts(left);
    const b = versionParts(right);
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
      if ((a[i] || 0) < (b[i] || 0)) return true;
      if ((a[i] || 0) > (b[i] || 0)) return false;
    }
    return false;
  }

  const minApp = window.MINING_MIN_APP || "";
  const storedBuild = localStorage.getItem("mining_app_build") || "";
  if (minApp && storedBuild && versionBelow(storedBuild, minApp)) {
    localStorage.removeItem("mining_app_build");
  }

  const stored = localStorage.getItem("mining_app_build");
  const urlBuild = new URLSearchParams(location.search).get("b");
  const reloadKey = build && build !== "dev" ? `mining_reload_${build}` : "";

  if (
    build
    && build !== "dev"
    && stored
    && stored !== build
    && urlBuild !== build
    && reloadKey
    && !sessionStorage.getItem(reloadKey)
  ) {
    sessionStorage.setItem(reloadKey, "1");
    localStorage.setItem("mining_app_build", build);
    const url = new URL(location.href);
    url.searchParams.set("b", build);
    location.replace(url.toString());
    return;
  }

  if (build && build !== "dev") {
    localStorage.setItem("mining_app_build", build);
  }

  window.MINING_BUILD = build;

  function loadCss(href) {
    const base = href.split("?")[0];
    const versioned = `${base}?v=${encodeURIComponent(build)}`;
    const existing = document.querySelector(`link[data-mining="${base}"], link[href*="${base}"]`);
    if (existing) {
      if (!existing.href.includes(`v=${encodeURIComponent(build)}`)) {
        existing.href = versioned;
      }
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = versioned;
    link.dataset.mining = base;
    document.head.appendChild(link);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = `${src}?v=${encodeURIComponent(build)}`;
      el.dataset.mining = src;
      const integrity = window.MINING_INTEGRITY?.[src];
      if (integrity) {
        el.integrity = integrity;
        el.crossOrigin = "anonymous";
      }
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
      document.body.appendChild(el);
    });
  }

  loadCss("styles.css");
  await loadScript("config.js");
  await loadScript("biometric.js");
  await loadScript("auth.js");
  await loadScript("commands.js");
  await loadScript("app.js");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(build)}`).catch(() => {});
  }
})().catch((err) => {
  window.dismissBootSplash?.();
  console.error(err);
  const msg = document.createElement("p");
  msg.className = "meta";
  msg.style.cssText = "margin:24px;text-align:center;color:#ff5d5d";
  msg.textContent = "Falha ao carregar o painel. Feche e abra o atalho de novo.";
  document.body.appendChild(msg);
});
