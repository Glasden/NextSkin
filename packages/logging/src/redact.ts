/**
 * 把一行文字里机密形状的内容换成 `[redacted]`（ADR-0062）：`Authorization`、`Cookie` 头的值，JSON 里同名的字段，
 * `Bearer` 后面的值，JWT，URL 里的 `用户:密码@`，查询参数里 `token`、`code`、`secret` 一类的值，`password=`、`api_key:` 这类键值。
 * 用在写日志的一方管不住内容的地方：核心的原始输出（Next、第三方库打印的）、plugin host 的 stderr。
 * 只是兜底，认不出的照旧原样记下；不处理邮箱、IP 这些个人信息（诊断包另外处理）
 */
export function redactSecrets(text: string): string {
  return (
    text
      .replace(/\b((?:set-)?cookie|(?:proxy-)?authorization)(\s*:\s*)\S.*/giu, '$1$2[redacted]')
      .replace(JSON_SECRET, '$1"[redacted]"')
      .replace(/\b(bearer)\s+(?![/.])[\w.~+/=-]{16,}/giu, '$1 [redacted]')
      .replace(/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]+/gu, '[redacted]')
      // 密码里可能有 @：一直取到主机前面的最后一个 @
      .replace(/\b([a-z][\w+.-]*:\/\/)[^\s/@:]*:[^\s/]*@/giu, '$1[redacted]@')
      .replace(QUERY_SECRET, '$1[redacted]')
      .replace(KEY_VALUE_SECRET, '$1$2[redacted]')
  )
}

const JSON_SECRET =
  /("(?:(?:set-)?cookie|authorization|password|passwd|secret|client_secret|token|access_token|refresh_token|id_token|api_key|apikey)"\s*:\s*)"(?:[^"\\]|\\.)*"/giu

const QUERY_SECRET =
  /([?&](?:access_token|refresh_token|id_token|token|code|secret|client_secret|password|api_key|apikey|key|signature|sig)=)[^&\s#"']+/giu

// 只认不会出现在普通句子里的键名：code、key、token 这类在报错里常见（exit code=1），只在查询参数里认
const KEY_VALUE_SECRET =
  /\b(password|passwd|client_secret|access_token|refresh_token|id_token|api_key|apikey)(\s*[=:]\s*)(?!\[redacted\])[^\s&;,"']+/giu
