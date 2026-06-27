const REMOTE_TOKEN_KEY = "mining_remote_token_enc";

async function storeRemoteToken(token) {
  if (!window.miningUnlockKey) throw new Error("locked");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify({ token: token.trim() }));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, window.miningUnlockKey, pt);
  sessionStorage.setItem(
    REMOTE_TOKEN_KEY,
    JSON.stringify({
      v: 1,
      enc: true,
      iv: btoa(String.fromCharCode(...iv)),
      data: btoa(String.fromCharCode(...new Uint8Array(ct))),
    }),
  );
}

async function getStoredRemoteToken() {
  const raw = sessionStorage.getItem(REMOTE_TOKEN_KEY);
  if (!raw || typeof decryptPayload !== "function") return null;
  try {
    const pt = await decryptPayload(JSON.parse(raw));
    return pt?.token || null;
  } catch {
    sessionStorage.removeItem(REMOTE_TOKEN_KEY);
    return null;
  }
}

window.promptRemoteTokenSetup = async function promptRemoteTokenSetup() {
  const token = prompt(
    "Cole o MINING_CMD_TOKEN do PC.\nNo painel local (Wi-Fi), abra Config remoto após login.",
  );
  if (!token?.trim()) return false;
  await storeRemoteToken(token);
  return true;
};

async function signCommandPayload(payload) {
  const keyBytes = window.miningCmdHmacKey;
  if (!keyBytes) {
    throw new Error("Sessao sem chave de comando — digite o PIN novamente.");
  }
  const body = { ...payload };
  delete body.sig;
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical));
  const sig = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { ...payload, sig };
}

async function encryptCommandPayload(obj) {
  const signed = await signCommandPayload(obj);
  if (!window.miningUnlockKey) throw new Error("locked");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(signed));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, window.miningUnlockKey, pt);
  return {
    v: 1,
    enc: true,
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(ct))),
  };
}

async function fetchFileMeta(remote) {
  const url = `https://api.github.com/repos/${remote.repo}/contents/${remote.cmd_path}?ref=${remote.branch}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${remote.gh_token}`,
      Accept: "application/vnd.github+json",
    },
    cache: "no-store",
  });
  if (r.status === 404) return { sha: null };
  if (!r.ok) throw new Error(`github ${r.status}`);
  const data = await r.json();
  return { sha: data.sha || null };
}

async function getRemoteConfig() {
  const cfg = await loadAuthConfig();
  const remote = cfg.remote;
  if (!remote?.repo) return null;
  let token = await getStoredRemoteToken();
  if (!token && typeof window.promptRemoteTokenSetup === "function") {
    const ok = await window.promptRemoteTokenSetup();
    if (ok) token = await getStoredRemoteToken();
  }
  if (!token) return null;
  return {
    repo: remote.repo,
    branch: remote.branch,
    cmd_path: remote.cmd_path || "data/command.enc",
    gh_token: token,
  };
}

function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function putCommandOnce(remote, action, attempt = 0) {
  const maxAttempts = 6;
  const payload = {
    action,
    ts: new Date().toISOString(),
    id: crypto.randomUUID(),
  };
  if (action === "restart") {
    const challenge = await fetchWebAuthnChallenge();
    payload.webauthn = await getRestartAssertion(challenge);
  }
  const enc = await encryptCommandPayload(payload);
  const { sha } = await fetchFileMeta(remote);
  const body = {
    message: `cmd:${action}`,
    content: toBase64Utf8(JSON.stringify(enc, null, 2)),
    branch: remote.branch,
  };
  if (sha) body.sha = sha;

  const url = `https://api.github.com/repos/${remote.repo}/contents/${remote.cmd_path}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${remote.gh_token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if ((r.status === 409 || r.status === 422) && attempt + 1 < maxAttempts) {
    await sleep(350 * (attempt + 1));
    return putCommandOnce(remote, action, attempt + 1);
  }
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.message || `github ${r.status}`);
  }
  return true;
}

let _commandChain = Promise.resolve();

window.sendRemoteCommand = function sendRemoteCommand(action) {
  const task = _commandChain.then(async () => {
    const remote = await getRemoteConfig();
    if (!remote?.gh_token) {
      throw new Error("Controle remoto: configure MINING_CMD_TOKEN no celular (uma vez).");
    }
    return putCommandOnce(remote, action);
  });
  _commandChain = task.catch(() => {});
  return task;
};
