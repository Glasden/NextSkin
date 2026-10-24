/**
 * 把一行文字里机密形状的内容换成 `[redacted]`（ADR-0062）：`Bearer`、`Basic` 后面的值，JWT，URL 里的 `用户:密码@`，
 * 查询参数里 `token`、`code`、`secret` 一类的值，`Authorization`、`Cookie` 头。
 * 用在写日志的一方管不住内容的地方：核心的原始输出（Next、第三方库打印的）、plugin host 的 stderr。
 * 只是兜底，认不出的照旧原样记下；不处理邮箱、IP 这些个人信息（诊断包另外处理）
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b((?:set-)?cookie:\s*).+/giu, '$1[redacted]')
    .replace(/\b(authorization:\s*)(?!(?:bearer|basic)\s)\S+/giu, '$1[redacted]')
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]+/giu, '$1 [redacted]')
    .replace(/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]+/gu, '[redacted]')
    .replace(/\b([a-z][\w+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/giu, '$1[redacted]@')
    .replace(QUERY_SECRET, '$1[redacted]')
}

const QUERY_SECRET =
  /([?&](?:access_token|refresh_token|id_token|token|code|secret|client_secret|password|api_key|apikey|key|signature|sig)=)[^&\s#"']+/giu
