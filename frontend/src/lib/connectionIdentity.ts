/**
 * 连接身份/徽章的纯函数层（从 App.vue 抽出，便于独立单测与复用）：
 * - identity 文案（username@host:port）
 * - 协议/认证徽章（对标 ADS 连接标识：tls_mode + auth_type + 端口推导）
 * - 服务器方言显示名（vendor 缺失时兜底）
 * - 工具栏连接色染色（light 下收口 5%，UI 扫描 P2-9）
 * 纯函数、无 Vue 依赖；结构异常一律安全降级（徽章只是装饰，绝不能弄挂工作台）。
 */

export interface ConnectionSummary {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  color?: string;
  readOnly?: boolean;
  baseDn?: string;
  external_config?: Record<string, unknown>;
}

export interface SchemaServerInfo {
  dialect?: string;
  vendorName?: string;
  productName?: string;
}

export function connectionIdentityText(connection: ConnectionSummary, connectionId: string): string {
  const host = connection.host || connection.name || connectionId;
  const identity = connection.username ? `${connection.username}@${host}` : host;
  const port = connection.port ? `:${connection.port}` : "";
  return `${identity}${port}`;
}

// 方言 → 显示名（vendor 缺失时兜底）。
export const DIALECT_LABELS: Record<string, string> = {
  ad: "Active Directory",
  openldap: "OpenLDAP",
  "389ds": "389 Directory Server",
  freeipa: "FreeIPA",
  rfc4511: "LDAPv3",
};

export function serverBadgeLabel(info: SchemaServerInfo | undefined | null): string {
  if (!info) return "";
  const label = info.vendorName || DIALECT_LABELS[info.dialect ?? ""] || "";
  return label.trim();
}

// 协议/认证徽章（对标 ADS 连接标识）：字段来自 manifest binding: config 的
// external_config.tls_mode（none/starttls/ldaps）与 auth_type（anonymous/
// unauthenticated/simple/kerberos/ntlm/ntlm_hash/digest_md5/external），
// 端口取连接摘要（636 视为 LDAPS）。字段与端口全缺时无从推导，不显示徽章。
const AUTH_BADGE_LABELS: Record<string, string> = {
  anonymous: "Anonymous",
  kerberos: "GSSAPI",
  ntlm: "NTLM",
  ntlm_hash: "NTLM",
  digest_md5: "DIGEST-MD5",
};

function normalizePort(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function protocolBadge(connection: ConnectionSummary): string {
  try {
    const external = connection.external_config;
    const config = external && typeof external === "object" ? (external as Record<string, unknown>) : undefined;
    const rawTlsMode = config?.tls_mode;
    const tlsMode = typeof rawTlsMode === "string" ? rawTlsMode.trim().toLowerCase() : "";
    const rawAuthType = config?.auth_type;
    const authType = typeof rawAuthType === "string" ? rawAuthType.trim().toLowerCase() : "";
    const port = normalizePort(connection.port);
    if (!tlsMode && !authType && port === undefined) return "";
    const segments: string[] = [];
    if (tlsMode === "ldaps" || port === 636) segments.push("LDAPS");
    else if (tlsMode === "starttls") segments.push("LDAP+TLS");
    else segments.push("LDAP");
    // 认证段：字段缺失省略；unauthenticated/external 等其余取值兜底 Simple。
    if (authType) segments.push(AUTH_BADGE_LABELS[authType] ?? "Simple");
    return segments.join(" · ");
  } catch {
    return "";
  }
}

export function colorWithAlpha(color: string, alpha: number): string {
  const match = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
  const hex = match[1].length === 3 ? [...match[1]].map((part) => `${part}${part}`).join("") : match[1];
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return `rgb(${red} ${green} ${blue} / ${alpha})`;
}

export interface ToolbarTintStyle extends Record<string, string> {
  backgroundColor: string;
  boxShadow: string;
}

export function toolbarTint(color: string | undefined, colorScheme: string): ToolbarTintStyle | undefined {
  if (!color) return undefined;
  // light 下染色收口到 5%（与 kafka 家族对齐，UI 扫描 P2-9：10% 淡紫易与状态色混淆）。
  const light = colorScheme === "light";
  return {
    backgroundColor: colorWithAlpha(color, light ? 0.05 : 0.1),
    boxShadow: `inset 0 1px 0 ${colorWithAlpha(color, light ? 0.12 : 0.18)}`,
  };
}
