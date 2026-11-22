/* Browser half of the passkey flow, shared by every app that has one.
 *
 * COPY, NOT A PACKAGE - see shared/webauthn.js for why.
 *
 * WebAuthn speaks ArrayBuffers and the wire speaks base64url, so most of this
 * file is converting between the two in both directions. Getting one field
 * wrong produces a signature that fails verification with no clue which field
 * it was, which is why this lives in one place rather than in each page.
 */
(function (global) {
  'use strict';

  function b64urlToBuf(str) {
    var pad = str.length % 4 ? new Array(5 - (str.length % 4)).join('=') : '';
    var bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function bufToB64url(buf) {
    var bytes = new Uint8Array(buf), out = '';
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function supported() {
    return !!(global.PublicKeyCredential && navigator.credentials && navigator.credentials.get);
  }

  async function post(path, body) {
    var res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'That did not work.');
    return data;
  }

  /** Is a passkey registered for this hostname? */
  async function status(base) {
    try {
      var res = await fetch((base || '/api/auth/passkey') + '/status');
      return await res.json();
    } catch (e) { return { registered: false }; }
  }

  /** Sign in. Resolves on success; a cancelled prompt throws AbortLike. */
  async function signIn(base) {
    base = base || '/api/auth/passkey';
    var options = await post(base + '/login/options');
    options.challenge = b64urlToBuf(options.challenge);
    (options.allowCredentials || []).forEach(function (c) { c.id = b64urlToBuf(c.id); });
    var cred = await navigator.credentials.get({ publicKey: options });
    return post(base + '/login/verify', {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        authenticatorData: bufToB64url(cred.response.authenticatorData),
        signature: bufToB64url(cred.response.signature),
        userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : undefined,
      },
    });
  }

  /** Enrol this device. `proof` is whatever the server's canEnrol wants,
   *  normally { password: '...' }. */
  async function enrol(proof, base, label) {
    base = base || '/api/auth/passkey';
    var options = await post(base + '/register/options', proof || {});
    options.challenge = b64urlToBuf(options.challenge);
    options.user.id = b64urlToBuf(options.user.id);
    (options.excludeCredentials || []).forEach(function (c) { c.id = b64urlToBuf(c.id); });
    var cred = await navigator.credentials.create({ publicKey: options });
    return post(base + '/register/verify', {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      label: label || 'Face ID',
      response: {
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        attestationObject: bufToB64url(cred.response.attestationObject),
        transports: cred.response.getTransports ? cred.response.getTransports() : [],
      },
    });
  }

  /** A cancelled OS prompt is not an error worth shouting about. */
  function cancelled(err) {
    return !!err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
  }

  global.Passkey = {
    supported: supported, status: status, signIn: signIn, enrol: enrol,
    cancelled: cancelled, b64urlToBuf: b64urlToBuf, bufToB64url: bufToB64url,
  };
})(window);
