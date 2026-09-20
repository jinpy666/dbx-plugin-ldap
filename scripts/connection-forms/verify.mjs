// Standalone LDAP connection-form contract verifier.
//
// The monorepo version imports the DBX host's TypeScript condition evaluator.
// This copy intentionally keeps only the small, host-compatible evaluator and
// LDAP assertions needed by this repository, so clean clones do not need ../host
// or ../shared. Replace this file with the future public form-contract package
// when that package is available; keep the scenarios below as the LDAP
// regression contract.
//
// Usage: node scripts/connection-forms/verify.mjs [ldap]
// (the optional plugin argument is kept for monorepo-style invocations).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const plugin = process.argv[2];
assert(!plugin || plugin === "ldap", `this repository only verifies the ldap connection form, got ${JSON.stringify(plugin)}`);

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
const provider = manifest.contributions.find((item) => item.type === "connection-provider");
assert(provider, "LDAP manifest must define a connection provider");
const fields = provider.fields;
const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
const defaults = Object.fromEntries(fields.map((field) => [field.key, field.default]));
const locales = ["en", "zh-CN", "zh-TW", "es", "it", "ja", "pt-BR"];

assert.equal(new Set(fields.map((field) => field.key)).size, fields.length, "duplicate field keys");

function conditionMatches(condition, value) {
  if (!condition) return true;
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return false;
  return condition.one_of.includes(String(value));
}

function isVisible(field, values, seen = new Set([field.key])) {
  const condition = field.visible_when;
  if (!condition || !conditionMatches(condition, values[condition.field])) return !condition;
  const target = byKey[condition.field];
  if (!target || seen.has(target.key)) return true;
  seen.add(target.key);
  return isVisible(target, values, seen);
}

function isRequired(field, values) {
  return Boolean(field.required)
    || Boolean(field.required_when && conditionMatches(field.required_when, values[field.required_when.field]));
}

for (const [index, field] of fields.entries()) {
  for (const condition of [field.visible_when, field.required_when].filter(Boolean)) {
    const target = byKey[condition.field];
    assert(target, `${field.key}: unknown condition field ${condition.field}`);
    assert(fields.indexOf(target) < index, `${field.key}: condition target must precede dependent field`);
    const values = target.type === "boolean" ? ["true", "false"] : target.options?.map((option) => option.value);
    if (values) assert(condition.one_of.every((value) => values.includes(value)), `${field.key}: invalid condition value`);
  }
  if (field.type === "select" && field.default !== undefined) {
    assert(field.options.some((option) => option.value === field.default), `${field.key}: invalid default`);
  }
  for (const locale of locales) {
    const localized = manifest.localizations[locale]?.contributions?.[provider.id]?.fields?.[field.key]
      ?? (locale === "en" ? field : undefined);
    assert(localized?.label?.trim(), `${locale}/${field.key}: missing label`);
    for (const option of field.options ?? []) {
      const label = Array.isArray(localized.options)
        ? localized.options.find((item) => item.value === option.value)?.label
        : localized.options?.[option.value];
      assert(label?.trim(), `${locale}/${field.key}/${option.value}: missing option label`);
    }
  }
}

const options = (key) => byKey[key].options.map((option) => option.value);
let scenarios = 0;
function state(overrides) {
  scenarios++;
  const values = { ...defaults, ...overrides };
  const visible = new Set(fields.filter((field) => isVisible(field, values)).map((field) => field.key));
  const required = new Set(fields.filter((field) => visible.has(field.key) && isRequired(field, values)).map((field) => field.key));
  return {
    visible(key, expected) { assert.equal(visible.has(key), expected, `${key} visibility: ${JSON.stringify(overrides)}`); },
    required(key, expected) { assert.equal(required.has(key), expected, `${key} required: ${JSON.stringify(overrides)}`); },
  };
}

// -- TLS/encryption matrix: tls_verify, tls_server_name and the mTLS client
//    cert/key paths follow tls_mode, and the CA path only appears once
//    certificate verification is on. --------------------------------------
const tlsModes = options("tls_mode");
for (const tls_mode of tlsModes) {
  for (const tls_verify of [false, true]) {
    const current = state({ tls_mode, tls_verify });
    const tls = tls_mode !== "none";
    current.visible("tls_verify", tls);
    current.visible("tls_server_name", tls);
    current.visible("tls_client_cert_path", tls);
    current.visible("tls_client_key_path", tls);
    current.visible("tls_ca_path", tls && tls_verify);
    current.required("tls_verify", false);
    current.required("tls_ca_path", false);
    current.required("tls_client_cert_path", false);
    current.required("tls_client_key_path", false);
  }
}

// -- Authentication matrix ------------------------------------------------
const credAuths = ["ntlm", "ntlm_hash", "digest_md5"];
for (const auth_type of options("auth_type")) {
  if (auth_type === "kerberos") {
    // Kerberos: override fields plus per-credential-type inputs; the
    // credential type itself has no default, so also assert the "unset" state.
    const krbOverrides = [undefined, ...options("krb_credential_type")];
    for (const krb_credential_type of krbOverrides) {
      const current = state({ auth_type, krb_credential_type });
      current.visible("username", true);
      current.required("username", false);
      for (const key of ["krb_username", "krb_realm", "krb5_conf_path", "krb_kdc_host", "krb_kdc_port", "sasl_qop", "sasl_mutual_auth"]) {
        current.visible(key, true);
        current.required(key, false);
      }
      current.visible("krb_password", krb_credential_type === "password");
      current.required("krb_password", krb_credential_type === "password");
      current.visible("krb_keytab_path", krb_credential_type === "keytab");
      current.required("krb_keytab_path", krb_credential_type === "keytab");
      current.visible("krb_ccache_path", krb_credential_type === "ccache");
      current.required("krb_ccache_path", krb_credential_type === "ccache");
    }
    continue;
  }
  const current = state({ auth_type });
  const withPassword = ["simple", "ntlm", "digest_md5"].includes(auth_type);
  current.visible("bind_dn", ["simple", "unauthenticated"].includes(auth_type));
  current.required("bind_dn", auth_type === "unauthenticated");
  current.visible("username", ["simple", ...credAuths].includes(auth_type));
  current.required("username", credAuths.includes(auth_type));
  current.visible("domain", credAuths.includes(auth_type));
  current.visible("bind_password", withPassword);
  current.required("bind_password", withPassword);
  current.visible("ntlm_hash", auth_type === "ntlm_hash");
  current.required("ntlm_hash", auth_type === "ntlm_hash");
  current.visible("sasl_host", auth_type === "digest_md5");
}

// -- Anonymous stays minimal: no credential inputs at all. ----------------
const anonymous = state({ auth_type: "anonymous" });
for (const key of ["bind_dn", "username", "domain", "bind_password", "ntlm_hash"]) {
  anonymous.visible(key, false);
}

// -- Write-guard contract: blocked attributes ship password guards by
//    default and read_only stays a plain boolean switch. -------------------
assert.equal(byKey.blocked_attributes.type, "textarea");
assert(String(byKey.blocked_attributes.default).includes("userPassword"), "blocked_attributes must ship password guard defaults");
assert.equal(byKey.read_only.type, "boolean");

console.log(`PASS LDAP connection form: ${scenarios} combinations; field ordering and seven-language labels/options`);
