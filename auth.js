const SESSION_KEY = "mining_dk";
const SESSION_SALT_KEY = "mining_salt";
const SESSION_CMD_HMAC_KEY = "mining_cmd_hmac_key";
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
const DEFAULT_PIN_LEN = 6;
const BULLET = "\u2022";

let unlockKey = null;
let pinSubmitting = false;
let bioSubmitting = false;
let authConfig = null;
let pinLength = DEFAULT_PIN_LEN;

async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pinCells() {
  return [...document.querySelectorAll(".pin-cell")];
}

function getCellDigit(cell) {
  return (cell.dataset.digit || "").replace(/\D/g, "").slice(-1);
}

function setCellDigit(cell, digit) {
  const d = String(digit || "").replace(/\D/g, "").slice(-1);
  if (d) {
    cell.dataset.digit = d;
    cell.value = BULLET;
  } else {
    delete cell.dataset.digit;
    cell.value = "";
  }
}

function getPinValue() {
  return pinCells().map(getCellDigit).join("");
}

function clearPinInputs() {
  pinCells().forEach((cell) => setCellDigit(cell, ""));
  document.getElementById("pin-row")?.classList.remove("error");
}

function focusPinCell(index = 0) {
  const cells = pinCells();
  if (cells[index]) cells[index].focus();
}

function showLogin(message = "") {
  window.dismissBootSplash?.();
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("app-content").style.display = "none";
  document.getElementById("bio-section")?.classList.add("hidden");
  document.getElementById("pin-section")?.classList.remove("hidden");
  document.getElementById("login-error").textContent = message;
  clearPinInputs();
  focusPinCell(0);
}

function showBiometricLogin(message = "") {
  window.dismissBootSplash?.();
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("app-content").style.display = "none";
  document.getElementById("bio-section")?.classList.remove("hidden");
  document.getElementById("pin-section")?.classList.add("hidden");
  document.getElementById("login-error").textContent = message;
}

function hideLogin() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app-content").style.display = "block";
  window.dismissBootSplash?.();
}

window.dismissBootSplash = function dismissBootSplash() {
  const el = document.getElementById("boot-splash");
  if (!el || el.classList.contains("hidden")) return;
  el.classList.add("hidden");
  el.setAttribute("aria-busy", "false");
  setTimeout(() => el.remove(), 250);
};

function getLockout() {
  try {
    return JSON.parse(sessionStorage.getItem("mining_lock") || "null");
  } catch {
    return null;
  }
}

function setLockout(data) {
  if (data) sessionStorage.setItem("mining_lock", JSON.stringify(data));
  else sessionStorage.removeItem("mining_lock");
}

function checkLockout() {
  const lock = getLockout();
  if (!lock?.until) return null;
  const left = lock.until - Date.now();
  if (left > 0) return `Muitas tentativas. Aguarde ${Math.ceil(left / 1000)}s.`;
  setLockout(null);
  return null;
}

function recordFailedAttempt() {
  const lock = getLockout() || { count: 0, until: 0 };
  lock.count = (lock.count || 0) + 1;
  if (lock.count >= MAX_ATTEMPTS) {
    lock.until = Date.now() + LOCKOUT_MS;
    lock.count = 0;
  }
  setLockout(lock);
}

function resetAttempts() {
  setLockout(null);
}

async function loadAuthConfig() {
  if (authConfig) return authConfig;
  const r = await fetch("./auth.json", { cache: "no-store" });
  if (!r.ok) throw new Error("auth_missing");
  const data = await r.json();
  if (!data.hash || !data.salt) throw new Error("auth_invalid");
  authConfig = data;
  pinLength = data.pin_length || DEFAULT_PIN_LEN;
  return data;
}

async function deriveCommandHmacKeyRaw(pin) {
  const enc = new TextEncoder();
  const salt = enc.encode("mining-orchestrator-cmd-hmac-v1");
  const iterations = authConfig?.iterations || 100_000;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

function storeCommandHmacKey(rawBytes) {
  const b64 = btoa(String.fromCharCode(...rawBytes));
  sessionStorage.setItem(SESSION_CMD_HMAC_KEY, b64);
  window.miningCmdHmacKey = rawBytes;
}

function restoreCommandHmacKey() {
  const b64 = sessionStorage.getItem(SESSION_CMD_HMAC_KEY);
  if (!b64) {
    window.miningCmdHmacKey = null;
    return false;
  }
  window.miningCmdHmacKey = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return true;
}

async function deriveKey(pin, saltB64) {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const iterations = authConfig?.iterations || 100_000;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

async function exportKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

async function importKey(b64) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function applySession(sessionKeyB64, authSalt) {
  unlockKey = await importKey(sessionKeyB64);
  sessionStorage.setItem(SESSION_KEY, sessionKeyB64);
  sessionStorage.setItem(SESSION_SALT_KEY, authSalt);
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function verifyPinHash(pin, cfg) {
  const v = cfg.v || 2;
  if (v >= 3) {
    if (!cfg.pin_salt) return false;
    const enc = new TextEncoder();
    const pinSalt = Uint8Array.from(atob(cfg.pin_salt), (c) => c.charCodeAt(0));
    const iterations = cfg.iterations || 100_000;
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(pin),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: pinSalt, iterations, hash: "SHA-256" },
      keyMaterial,
      256,
    );
    const hex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return timingSafeEqualHex(hex, cfg.hash);
  }
  return timingSafeEqualHex(await sha256(pin), cfg.hash);
}

async function verifyAndUnlock(pin) {
  const cfg = await loadAuthConfig();
  if (!(await verifyPinHash(pin, cfg))) {
    recordFailedAttempt();
    return false;
  }
  unlockKey = await deriveKey(pin, cfg.salt);
  const exported = await exportKey(unlockKey);
  window.miningUnlockKey = unlockKey;
  storeCommandHmacKey(await deriveCommandHmacKeyRaw(pin));
  await applySession(exported, cfg.salt);
  resetAttempts();
  return true;
}

function clearSession() {
  unlockKey = null;
  window.miningUnlockKey = null;
  window.miningCmdHmacKey = null;
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_SALT_KEY);
  sessionStorage.removeItem(SESSION_CMD_HMAC_KEY);
  sessionStorage.removeItem("mining_remote_token_enc");
}

window.invalidateSession = function invalidateSession(message = "") {
  clearSession();
  if (hasBiometricEnrollment()) {
    showBiometricLogin(message);
  } else {
    showLogin(message);
  }
};

async function restoreSessionKey() {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (!saved) return false;
  try {
    const cfg = await loadAuthConfig();
    const storedSalt = sessionStorage.getItem(SESSION_SALT_KEY);
    if (storedSalt && storedSalt !== cfg.salt) {
      clearSession();
      clearBioStore();
      return false;
    }
    unlockKey = await importKey(saved);
    window.miningUnlockKey = unlockKey;
    restoreCommandHmacKey();
    return true;
  } catch {
    clearSession();
    return false;
  }
}

async function decryptPayload(enc) {
  if (!enc?.enc) return enc;
  if (!unlockKey) throw new Error("locked");
  const iv = Uint8Array.from(atob(enc.iv), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(enc.data), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, unlockKey, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

window.fetchMiningData = async function fetchMiningData() {
  const r = await fetch("./data/latest.json", { cache: "no-store" });
  if (!r.ok) throw new Error(`latest.json ${r.status}`);
  return decryptPayload(await r.json());
};

async function maybeOfferBiometricEnrollment() {
  if (!(await platformAuthenticatorAvailable()) || hasBiometricEnrollment()) return;
  try {
    const cfg = await loadAuthConfig();
    await enrollBiometric(cfg.salt);
    if (typeof getRemoteConfig === "function" && typeof publishWebAuthnRegistration === "function") {
      try {
        const remote = await getRemoteConfig();
        if (remote) await publishWebAuthnRegistration(remote);
      } catch (err) {
        console.warn("WebAuthn reg sync:", err);
      }
    }
  } catch (err) {
    console.warn("Face ID nao ativado:", err);
  }
}

async function enterApp() {
  hideLogin();
  if (typeof window.startMiningApp === "function") window.startMiningApp();
  await maybeOfferBiometricEnrollment();
}

async function submitBiometric() {
  if (bioSubmitting) return;
  bioSubmitting = true;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  try {
    const cfg = await loadAuthConfig();
    const unlocked = await unlockWithBiometric(cfg.salt);
    if (!unlocked?.verified) {
      errEl.textContent = "Face ID nao reconhecido. Use o PIN.";
      showLogin();
      return;
    }
    if (await restoreSessionKey()) {
      await enterApp();
      return;
    }
    showLogin("Digite o PIN para continuar.");
  } catch (err) {
    if (err.name === "NotAllowedError") {
      errEl.textContent = "Cancelado. Use o PIN abaixo.";
      showLogin();
      return;
    }
    console.error(err);
    errEl.textContent = "Face ID indisponivel. Use o PIN.";
    showLogin();
  } finally {
    bioSubmitting = false;
  }
}

function handlePinDigit(cell, index, cells, digit) {
  setCellDigit(cell, digit);
  document.getElementById("pin-row")?.classList.remove("error");
  document.getElementById("login-error").textContent = "";
  if (digit && index < cells.length - 1) cells[index + 1].focus();
  if (getPinValue().length === pinLength) submitPin();
}

async function submitPin() {
  if (pinSubmitting) return;
  const lockMsg = checkLockout();
  if (lockMsg) {
    document.getElementById("login-error").textContent = lockMsg;
    document.getElementById("pin-row")?.classList.add("error");
    return;
  }
  const pin = getPinValue();
  if (pin.length !== pinLength) return;

  pinSubmitting = true;
  pinCells().forEach((c) => { c.disabled = true; });
  try {
    if (!(await verifyAndUnlock(pin))) {
      clearSession();
      document.getElementById("pin-row")?.classList.add("error");
      document.getElementById("login-error").textContent = checkLockout() || "PIN incorreto.";
      clearPinInputs();
      focusPinCell(0);
      return;
    }
    await enterApp();
  } catch (err) {
    console.error(err);
    document.getElementById("login-error").textContent = "Falha ao verificar PIN.";
    clearPinInputs();
    focusPinCell(0);
  } finally {
    pinSubmitting = false;
    pinCells().forEach((c) => { c.disabled = false; });
  }
}

function setupPinInputs() {
  pinCells().forEach((cell, index) => {
    cell.replaceWith(cell.cloneNode(true));
  });
  pinCells().forEach((cell, index) => {
    const cells = pinCells();
    cell.addEventListener("keydown", (event) => {
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        handlePinDigit(cell, index, cells, event.key);
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        if (getCellDigit(cell)) setCellDigit(cell, "");
        else if (index > 0) {
          setCellDigit(cells[index - 1], "");
          cells[index - 1].focus();
        }
      }
    });
    cell.addEventListener("input", () => {
      const raw = cell.value.replace(/\D/g, "");
      if (!raw) { setCellDigit(cell, ""); return; }
      handlePinDigit(cell, index, cells, raw.slice(-1));
    });
    cell.addEventListener("paste", (event) => {
      event.preventDefault();
      const digits = (event.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, pinLength);
      digits.split("").forEach((d, i) => { if (cells[i]) setCellDigit(cells[i], d); });
      if (digits.length === pinLength) submitPin();
      else focusPinCell(digits.length);
    });
  });
}

async function initAuth() {
  setupPinInputs();
  document.getElementById("btn-biometric")?.addEventListener("click", submitBiometric);
  document.getElementById("btn-use-pin")?.addEventListener("click", () => showLogin());
  document.getElementById("btn-logout")?.addEventListener("click", () => {
    clearSession();
    if (hasBiometricEnrollment()) showBiometricLogin();
    else showLogin();
  });

  const lockMsg = checkLockout();
  if (lockMsg) {
    showLogin(lockMsg);
    return;
  }

  if (await restoreSessionKey()) {
    hideLogin();
    if (typeof window.startMiningApp === "function") window.startMiningApp();
    return;
  }

  if (hasBiometricEnrollment() && (await platformAuthenticatorAvailable())) {
    showBiometricLogin();
    return;
  }

  showLogin();
}

initAuth();
