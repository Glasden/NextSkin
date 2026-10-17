// 角色名输入框的浏览器校验：注册页和角色管理共用。规则的说明看文案（auth.signUp.playerNameHint、user.players.nameHint）

export type PlayerNameRule = 'official' | 'cjk' | 'utf8' | 'custom'

// 用 type 而不是 interface：要直接当作文案的 ICU 参数传进去
export type PlayerNameRules = {
  rule: PlayerNameRule
  min: number
  max: number
}

// 浏览器先按角色名规则拦一道，提示看说明文字；自定义规则是管理员写的正则，只由服务端检查。
// pattern 按 v 标志解析，匹配整个值
const patterns: Record<PlayerNameRule, string | undefined> = {
  official: '[A-Za-z0-9_]+',
  cjk: '[A-Za-z0-9_§\\u4e00-\\u9fff]+',
  utf8: '\\S+',
  custom: undefined,
}

/** 传给 Input 的属性 */
export function playerNameInputProps({ rule, min, max }: PlayerNameRules) {
  return {
    autoComplete: 'off',
    autoCapitalize: 'none',
    spellCheck: false,
    required: true,
    minLength: min,
    maxLength: max,
    pattern: patterns[rule],
  } as const
}
