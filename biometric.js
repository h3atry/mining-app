const BIO_STORE_KEY = "mining_bio_v1";

function bioSupported() {
  return Boolean(window.isSecureContext && window.PublicKeyCredential);
}

async function platformAuthenticatorAvailable() {
  if (!bioSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function getRpId() {
  return location.hostname;
}

function bufferToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64ToBuffer(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

function b64UrlToBuffer(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  return b64ToBuffer(b64);
}

function loadBioStore() {
  try {
    return JSON.parse(localStorage.getItem(BIO_STORE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveBioStore(data) {
  localStorage.setItem(BIO_STORE_KEY, JSON.stringify(data));
}

function clearBioStore() {
  localStorage.removeItem(BIO_STORE_KEY);
}

async function enrollBiometric(authSalt) {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Mining Orchestrator", id: getRpId() },
      user: {
        id: userId,
        name: "mining",
        displayName: "Mining",
      },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
    },
  });
  if (!credential) throw new Error("no_credential");
  const pubKeyBytes = credential.response.getPublicKey?.();
  saveBioStore({
    credentialId: bufferToB64(credential.rawId),
    publicKey: pubKeyBytes ? bufferToB64(pubKeyBytes) : null,
    authSalt,
    createdAt: Date.now(),
  });
  return true;
}

async function fetchWebAuthnChallenge() {
  const r = await fetch("./version.json", { cache: "no-store" });
  if (!r.ok) throw new Error("version.json indisponivel");
  const v = await r.json();
  if (!v.webauthn_challenge) throw new Error("Challenge WebAuthn ausente — aguarde sync do PC.");
  return v.webauthn_challenge;
}

async function getRestartAssertion(challengeStr) {
  const store = loadBioStore();
  if (!store?.credentialId) {
    throw new Error("Cadastre Face ID / biometria antes de reiniciar.");
  }
  const challenge = b64UrlToBuffer(challengeStr);
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: getRpId(),
      allowCredentials: [
        { id: b64ToBuffer(store.credentialId), type: "public-key" },
      ],
      userVerification: "required",
      timeout: 60_000,
    },
  });
  if (!assertion) throw new Error("WebAuthn cancelado");
  return {
    challenge: challengeStr,
    credentialId: store.credentialId,
    authenticatorData: bufferToB64(assertion.response.authenticatorData),
    clientDataJSON: bufferToB64(assertion.response.clientDataJSON),
    signature: bufferToB64(assertion.response.signature),
  };
}

async function publishWebAuthnRegistration(remote) {
  const store = loadBioStore();
  if (!store?.credentialId || !store?.publicKey) return false;
  if (typeof encryptCommandPayload !== "function") return false;
  const payload = {
    credential_id: store.credentialId,
    public_key: store.publicKey,
    sign_count: 0,
    rp_id: getRpId(),
    ts: new Date().toISOString(),
  };
  const enc = await encryptCommandPayload(payload);
  const path = "data/webauthn_reg.enc";
  const url = `https://api.github.com/repos/${remote.repo}/contents/${path}?ref=${remote.branch}`;
  let sha = null;
  try {
    const meta = await fetch(url, {
      headers: {
        Authorization: `Bearer ${remote.gh_token}`,
        Accept: "application/vnd.github+json",
      },
      cache: "no-store",
    });
    if (meta.ok) {
      const data = await meta.json();
      sha = data.sha || null;
    }
  } catch {
    /* novo arquivo */
  }
  const body = {
    message: "webauthn-reg",
    content: btoa(unescape(encodeURIComponent(JSON.stringify(enc, null, 2)))),
    branch: remote.branch,
  };
  if (sha) body.sha = sha;
  const put = await fetch(`https://api.github.com/repos/${remote.repo}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${remote.gh_token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return put.ok;
}

async function unlockWithBiometric(authSalt) {
  const store = loadBioStore();
  if (!store?.credentialId) return null;
  if (authSalt && store.authSalt !== authSalt) {
    clearBioStore();
    return null;
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: getRpId(),
      allowCredentials: [
        { id: b64ToBuffer(store.credentialId), type: "public-key" },
      ],
      userVerification: "required",
      timeout: 60_000,
    },
  });
  if (!assertion) return null;
  return { verified: true };
}

function hasBiometricEnrollment() {
  const store = loadBioStore();
  return Boolean(store?.credentialId);
}
